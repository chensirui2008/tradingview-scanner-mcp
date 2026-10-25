import assert from 'node:assert/strict';
import test from 'node:test';
import { scanStocks, getStockSnapshots } from '../src/scanner.js';

// Scoped mocks exercise the real wrapper-built payload and our transport, not smoke.
async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, expected);
    return true;
  };
}

test('unknown requested fields fail locally without network', async () => {
  await withFetch(async () => { throw new Error('network must not be called'); }, async () => {
    await assert.rejects(() => scanStocks({ fields: ['__unknown_field__'] }), code('UNKNOWN_FIELD'));
  });
});

test('numeric and mixed membership arrays reject locally instead of becoming ranges', async () => {
  let requests = 0;
  await withFetch(async () => {
    requests += 1;
    throw new Error('invalid membership must not reach network');
  }, async () => {
    for (const operator of ['in', 'not_in'] as const) {
      for (const value of [[1, 1000], ['NASDAQ', 1]]) {
        await assert.rejects(() => scanStocks({ filters: [{ field: 'exchange', operator, value }] }), code('INVALID_INPUT'));
      }
    }
  });
  assert.equal(requests, 0);
});

test('string membership lists retain set semantics in upstream payloads', async () => {
  for (const operator of ['in', 'not_in'] as const) {
    await withFetch(async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { filter: Array<{ left: string; operation: string; right: unknown }> };
      assert.ok(payload.filter.some((item) => item.left === 'exchange'
        && item.operation === (operator === 'in' ? 'in_range' : 'not_in_range')
        && JSON.stringify(item.right) === '["NYSE"]'));
      return Response.json({ totalCount: 0, data: [] });
    }, async () => {
      await scanStocks({ filters: [{ field: 'exchange', operator, value: ['NYSE'] }], limit: 1 });
    });
  }
});

test('upstream HTTP failures retain a stable error code', async () => {
  await withFetch(async () => new Response('rate limited', { status: 429 }), async () => {
    await assert.rejects(() => scanStocks({ limit: 1 }), code('UPSTREAM_HTTP_ERROR'));
  });
});

test('upstream redirects use Workers-compatible manual mode and never follow', async () => {
  await withFetch(async (_url, init) => {
    assert.equal(init?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/scan' } });
  }, async () => {
    await assert.rejects(() => scanStocks({ limit: 1 }), (error: unknown) => {
      code('UPSTREAM_HTTP_ERROR')(error);
      assert.equal((error as Error & { status?: number }).status, 302);
      return true;
    });
  });
});

test('upstream network failures retain a stable error code', async () => {
  await withFetch(async () => { throw new TypeError('network unreachable'); }, async () => {
    await assert.rejects(() => scanStocks({ limit: 1 }), code('UPSTREAM_NETWORK_ERROR'));
  });
});

test('malformed upstream JSON and row structure fail explicitly', async () => {
  for (const body of ['not JSON', JSON.stringify({ totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: 'invalid' }] })]) {
    await withFetch(async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }), async () => {
      await assert.rejects(() => scanStocks({ limit: 1 }), code('UPSTREAM_INVALID_RESPONSE'));
    });
  }
});

test('snapshots preserve null and report absent symbols explicitly', async () => {
  await withFetch(async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as { columns: string[]; symbols?: { tickers?: string[] } };
    assert.ok(payload.columns.includes('close'));
    return Response.json({ totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: payload.columns.map((field) => field === 'close' ? null : field === 'name' ? 'AAPL' : null) }] });
  }, async () => {
    const result = await getStockSnapshots({ symbols: ['NASDAQ:AAPL', 'NASDAQ:ZZZZZZ_NONEXISTENT'], fields: ['name', 'close'] });
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0]?.close, null);
    assert.deepEqual(result.meta.missingSymbols, ['NASDAQ:ZZZZZZ_NONEXISTENT']);
  });
});

test('caller filters cannot replace the stock universe and explicit sort overrides preset', async () => {
  await withFetch(async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as {
      filter: Array<{ left: string; operation: string; right: unknown }>;
      sort: { sortBy: string; sortOrder: string };
    };
    assert.ok(payload.filter.some((item) => item.left === 'type' && item.operation === 'equal' && item.right === 'stock'));
    assert.ok(payload.filter.some((item) => item.left === 'subtype' && item.operation === 'in_range' && JSON.stringify(item.right) === '["common","dr"]'));
    assert.ok(payload.filter.some((item) => item.left === 'exchange' && item.operation === 'in_range' && JSON.stringify(item.right) === '["NASDAQ"]'));
    assert.ok(payload.filter.some((item) => item.left === 'type' && item.operation === 'equal' && item.right === 'fund'));
    assert.ok(payload.filter.some((item) => item.left === 'change' && item.operation === 'greater' && item.right === 0));
    assert.ok(payload.filter.some((item) => item.left === 'close' && item.operation === 'greater' && item.right === 10));
    assert.deepEqual(payload.sort, { sortBy: 'close', sortOrder: 'asc' });
    return Response.json({ totalCount: 0, data: [] });
  }, async () => {
    const result = await scanStocks({
      preset: 'gainers', exchanges: ['NASDAQ'],
      filters: [{ field: 'type', operator: 'eq', value: 'fund' }, { field: 'close', operator: 'gt', value: 10 }],
      sort: { field: 'close', direction: 'asc' }, limit: 1,
    });
    assert.deepEqual(result.data, []);
  });
});
