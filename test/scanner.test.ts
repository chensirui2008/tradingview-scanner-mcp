import assert from 'node:assert/strict';
import test from 'node:test';
import { scanSchema, snapshotSchema, fieldSearchSchema, scanStocks, getStockSnapshots, searchFields } from '../src/scanner.js';

test('scan bounds reject oversized and unsupported requests', () => {
  assert.ok(scanSchema.safeParse({ limit: 1, offset: 0 }).success);
  assert.ok(scanSchema.safeParse({ limit: 100, offset: 10000 }).success);
  for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 10001 }, { exchanges: ['OTC'] }, { preset: 'buy_now' }, { fields: Array(41).fill('close') }, { filters: Array(21).fill({ field: 'close', operator: 'gt', value: 1 }) }]) {
    assert.equal(scanSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test('snapshot only accepts bounded exchange-qualified US listing symbols', () => {
  assert.ok(snapshotSchema.safeParse({ symbols: ['NASDAQ:AAPL', 'NYSE:IBM', 'AMEX:SPY'] }).success);
  for (const symbols of [[], ['AAPL'], ['LSE:VOD'], Array(51).fill('NASDAQ:AAPL')]) {
    assert.equal(snapshotSchema.safeParse({ symbols }).success, false, JSON.stringify(symbols));
  }
});

test('catalog search validates bounds and paginates without network', async () => {
  for (const input of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 10001 }, { query: 'x'.repeat(101) }]) {
    assert.equal(fieldSearchSchema.safeParse(input).success, false);
  }
  const first = await searchFields({ limit: 2, offset: 0 });
  const next = await searchFields({ limit: 2, offset: 2 });
  const combined = await searchFields({ limit: 4, offset: 0 });
  assert.deepEqual([...first.data, ...next.data], combined.data);
  assert.equal(first.meta.source, 'tradingview-scanner');
  assert.equal(first.meta.dataFreshness, 'unknown');
  const empty = await searchFields({ query: '__nonexistent_field_8cbe35__' });
  assert.deepEqual(empty.data, []);
});

test('invalid inputs fail before reaching the upstream service', async () => {
  await assert.rejects(async () => scanStocks({ limit: 0 }));
  await assert.rejects(async () => getStockSnapshots({ symbols: ['OTC:FAKE'] }));
});
