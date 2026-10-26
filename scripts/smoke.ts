import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8787/mcp');
const apiKey = process.env.MCP_API_KEY;
const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
const expectedTools = ['get_stock_snapshots', 'list_scan_presets', 'scan_stocks', 'search_fields'];

async function connect() {
  const client = new Client({ name: 'tradingview-scanner-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
  const payload = object(result.structuredContent);
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.deepEqual(JSON.parse(text.text), payload);
  return payload;
}

function metadata(payload: Record<string, unknown>) {
  const meta = object(payload.meta);
  assert.equal(meta.source, 'tradingview-scanner');
  assert.equal(meta.market, 'america');
  assert.equal(meta.dataFreshness, 'unknown');
  assert.ok(typeof meta.warning === 'string' && meta.warning.length > 0);
  assert.ok(typeof meta.fetchedAt === 'string' && Number.isFinite(Date.parse(meta.fetchedAt)));
  return meta;
}

const client = await connect();
try {
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), expectedTools);
  for (const tool of listing.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  const fields = await call(client, 'search_fields', { query: 'close', limit: 5 });
  assert.ok(Array.isArray(fields.data) && fields.data.length > 0);
  const presets = await call(client, 'list_scan_presets', {});
  assert.ok(Array.isArray(presets.data) && presets.data.length === 4);
  const scan = await call(client, 'scan_stocks', {
    fields: ['name', 'close', 'volume', 'exchange', 'type', 'subtype', 'update_mode'],
    exchanges: ['NASDAQ'],
    filters: [{ field: 'close', operator: 'gt', value: 1 }],
    sort: { field: 'volume', direction: 'desc' }, limit: 5, offset: 0,
  });
  const meta = metadata(scan);
  assert.equal(meta.offset, 0);
  assert.equal(meta.limit, 5);
  assert.ok(Array.isArray(scan.data) && scan.data.length > 0 && scan.data.length <= 5);
  let previous = Infinity;
  for (const value of scan.data) {
    const row = object(value);
    assert.equal(row.exchange, 'NASDAQ');
    assert.ok(row.type === 'stock' || row.type === 'dr');
    if (row.type === 'dr') {
      assert.equal(row.subtype, '');
    } else {
      assert.notEqual(row.subtype, 'preferred');
    }
    assert.ok(typeof row.close === 'number' && row.close > 1);
    assert.ok(typeof row.volume === 'number' && row.volume <= previous);
    previous = row.volume;
  }
  const presetCases = [
    { name: 'gainers', field: 'change', direction: 'desc', accepts: (value: number) => value > 0 },
    { name: 'losers', field: 'change', direction: 'asc', accepts: (value: number) => value < 0 },
    { name: 'most_active', field: 'volume', direction: 'desc', accepts: (value: number) => value > 0 },
    { name: 'unusual_volume', field: 'relative_volume_10d_calc', direction: 'desc', accepts: (value: number) => value >= 2 },
  ];
  for (const preset of presetCases) {
    const result = await call(client, 'scan_stocks', {
      preset: preset.name, fields: [preset.field, 'exchange', 'type', 'subtype', 'update_mode'],
      limit: 2, offset: 1,
    });
    const page = metadata(result);
    assert.equal(page.offset, 1);
    assert.equal(page.limit, 2);
    assert.ok(Array.isArray(result.data) && result.data.length <= 2);
    // An empty page is valid outside active trading; every returned row must still
    // satisfy the preset, stock universe and ordering without assuming live quotes.
    let prior = preset.direction === 'asc' ? -Infinity : Infinity;
    for (const value of result.data) {
      const row = object(value);
      assert.ok(['NASDAQ', 'NYSE', 'AMEX'].includes(String(row.exchange)));
      assert.ok(row.type === 'stock' || row.type === 'dr');
      if (row.type === 'dr') {
        assert.equal(row.subtype, '');
      } else {
        assert.notEqual(row.subtype, 'preferred');
      }
      const metric = row[preset.field];
      assert.ok(typeof metric === 'number' && preset.accepts(metric), preset.name);
      assert.ok(preset.direction === 'asc' ? metric >= prior : metric <= prior, `${preset.name} ordering`);
      prior = metric;
    }
    assert.equal(page.returnedCount, result.data.length);
    assert.ok(typeof page.totalCount === 'number' && page.totalCount >= result.data.length);
    assert.equal(page.hasMore, result.data.length > 0 && 1 + result.data.length < page.totalCount);
    assert.equal(page.nextOffset, page.hasMore ? 1 + result.data.length : null);
  }
  const snapshots = await call(client, 'get_stock_snapshots', {
    symbols: ['NASDAQ:AAPL', 'NYSE:BABA', 'NASDAQ:ZZZZZZ_NONEXISTENT'], fields: ['name', 'close', 'update_mode'],
  });
  const snapshotMeta = metadata(snapshots);
  assert.ok(Array.isArray(snapshots.data));
  assert.ok(snapshots.data.some((row) => object(row).symbol === 'NASDAQ:AAPL'));
  assert.ok(snapshots.data.some((row) => object(row).symbol === 'NYSE:BABA'));
  assert.ok(Array.isArray(snapshotMeta.missingSymbols) && snapshotMeta.missingSymbols.includes('NASDAQ:ZZZZZZ_NONEXISTENT'));
  const invalid = await client.callTool({ name: 'scan_stocks', arguments: { fields: ['__not_a_real_field__'] } });
  assert.equal(invalid.isError, true);
  const error = object(object(invalid.structuredContent).error);
  assert.ok(typeof error.code === 'string' && typeof error.message === 'string' && typeof error.requestId === 'string');
  const schemaInvalid = await client.callTool({ name: 'scan_stocks', arguments: { limit: 0 } });
  assert.equal(schemaInvalid.isError, true);
  const schemaError = object(object(schemaInvalid.structuredContent).error);
  assert.equal(schemaError.code, 'INVALID_ARGUMENTS');
  assert.ok(typeof schemaError.message === 'string' && typeof schemaError.requestId === 'string');
  await call(client, 'search_fields', { query: 'volume', limit: 1 });
  // A fresh handshake must work without carrying a server-side session forward.
  const second = await connect();
  try {
    await call(second, 'list_scan_presets', {});
  } finally {
    await second.close();
  }
  console.log(JSON.stringify({ ok: true, endpoint: endpoint.href, tools: expectedTools, scanned: scan.data.length, presets: presetCases.map((preset) => preset.name), presetOffset: 1, missingSymbols: snapshotMeta.missingSymbols }, null, 2));
} finally {
  await client.close();
}
