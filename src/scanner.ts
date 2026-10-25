import { z } from 'zod';
import {
  FieldCondition,
  FilterOperator,
  StockField,
  StockScreener,
  type BaseField,
  type QueryPayload,
} from 'tradingview-screener';

const SCANNER_URL = 'https://scanner.tradingview.com/america/scan';
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX'] as const;
const DEFAULT_FIELDS = [
  'name', 'description', 'close', 'change', 'volume',
  'relative_volume_10d_calc', 'market_cap_basic', 'exchange', 'update_mode',
];
const WARNING = 'Unofficial public TradingView Scanner data may be delayed, incomplete, or unavailable. '
  + 'Data freshness is unknown; fetchedAt is the retrieval time, not a quote timestamp. '
  + 'US listings include foreign issuers and depositary receipts; screens are not trade approvals.';

// Keep raw TradingView identifiers, not the wrapper's TypeScript constant names.
const FIELD_MAP = new Map<string, BaseField>();
for (const field of Object.values(StockField)) {
  if (!FIELD_MAP.has(field.fieldName)) FIELD_MAP.set(field.fieldName, field);
}
const FIELD_CATALOGUE = Array.from(FIELD_MAP.values(), (field) => ({
  field: field.fieldName,
  label: field.label,
  format: field.format,
  interval: field.supportsInterval,
  historical: field.supportsHistory,
})).sort((a, b) => a.field < b.field ? -1 : a.field > b.field ? 1 : 0);

export class ScannerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'ScannerError';
  }
}

const rawFieldSchema = z.string().min(1).max(200)
  .describe('Raw TradingView field ID from search_fields, e.g. close or RSI. Unknown IDs are rejected.');
const fieldsSchema = z.array(rawFieldSchema).min(1).max(40)
  .refine((fields) => new Set(fields).size === fields.length, 'Fields must be unique.');
const scalarSchema = z.union([z.string().max(256), z.number().finite(), z.boolean()]);
const listValueSchema = z.array(z.union([z.string().max(256), z.number().finite()])).min(1).max(100);
const filterSchema = z.object({
  field: rawFieldSchema,
  operator: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in'])
    .describe('in/not_in are string-set membership only; between is an inclusive numeric range.'),
  value: z.union([scalarSchema, listValueSchema])
    .describe('Scalar for comparisons; exactly two ascending numbers for between; nonempty string array for in/not_in. Numeric-set membership is not supported.'),
}).strict().superRefine((filter, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message });
  switch (filter.operator) {
    case 'eq':
    case 'ne':
      if (Array.isArray(filter.value)) issue('Equality requires a scalar value.');
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof filter.value !== 'number') issue('Numeric comparison requires a finite number.');
      break;
    case 'between':
      if (!Array.isArray(filter.value) || filter.value.length !== 2
        || typeof filter.value[0] !== 'number' || typeof filter.value[1] !== 'number'
        || filter.value[0] > filter.value[1]) {
        issue('Between requires two finite numbers in ascending order.');
      }
      break;
    case 'in':
    case 'not_in':
      if (!Array.isArray(filter.value) || !filter.value.every((value) => typeof value === 'string')) {
        issue('Membership requires a nonempty list of strings. Use between for a numeric range; numeric-set membership is not supported.');
      }
      break;
  }
});
const sortSchema = z.object({
  field: rawFieldSchema,
  direction: z.enum(['asc', 'desc']),
}).strict();
const presetNameSchema = z.enum(['gainers', 'losers', 'most_active', 'unusual_volume']);
const symbolSchema = z.string().regex(/^(NASDAQ|NYSE|AMEX):[A-Z0-9][A-Z0-9._/\-]{0,31}$/,
  'Use an uppercase exchange-qualified symbol, e.g. NASDAQ:AAPL or NYSE:BRK.B.');

export const scanSchema = z.object({
  fields: fieldsSchema.optional(),
  filters: z.array(filterSchema).max(20).default([])
    .describe('All filters are combined with AND, including preset and stock-universe filters.'),
  sort: sortSchema.optional().describe('Overrides the preset sort when supplied.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(10_000).default(0),
  preset: presetNameSchema.optional(),
  exchanges: z.array(z.enum(EXCHANGES)).min(1).max(3)
    .refine((values) => new Set(values).size === values.length, 'Exchanges must be unique.')
    .default([...EXCHANGES]),
}).strict();

export const snapshotSchema = z.object({
  symbols: z.array(symbolSchema).min(1).max(50)
    .refine((symbols) => new Set(symbols).size === symbols.length, 'Symbols must be unique.'),
  fields: fieldsSchema.optional(),
}).strict();

export const fieldSearchSchema = z.object({
  query: z.string().max(100).optional()
    .describe('Case-insensitive substring of a raw field ID or its library label. Empty returns the catalogue.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict();

type FilterInput = z.infer<typeof filterSchema>;
type SortInput = z.infer<typeof sortSchema>;
type Exchange = typeof EXCHANGES[number];
type PresetName = z.infer<typeof presetNameSchema>;
type Preset = { name: PresetName; description: string; filters: FilterInput[]; sort: SortInput };

const PRESETS: readonly Preset[] = [
  {
    name: 'gainers',
    description: 'Positive daily percentage change, sorted by change descending. No liquidity or catalyst approval.',
    filters: [{ field: 'change', operator: 'gt', value: 0 }],
    sort: { field: 'change', direction: 'desc' },
  },
  {
    name: 'losers',
    description: 'Negative daily percentage change, sorted by change ascending. No liquidity or catalyst approval.',
    filters: [{ field: 'change', operator: 'lt', value: 0 }],
    sort: { field: 'change', direction: 'asc' },
  },
  {
    name: 'most_active',
    description: 'Positive share volume, sorted by share volume descending, not dollar volume.',
    filters: [{ field: 'volume', operator: 'gt', value: 0 }],
    sort: { field: 'volume', direction: 'desc' },
  },
  {
    name: 'unusual_volume',
    description: 'TradingView relative_volume_10d_calc at least 2, sorted descending. This is not an intraday confirmation.',
    filters: [{ field: 'relative_volume_10d_calc', operator: 'gte', value: 2 }],
    sort: { field: 'relative_volume_10d_calc', direction: 'desc' },
  },
];

function parseInput<T extends z.ZodType>(schema: T, input: z.input<T>): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ScannerError('INVALID_INPUT', result.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
  }
  return result.data;
}

function getField(name: string): BaseField {
  const field = FIELD_MAP.get(name);
  if (!field) throw new ScannerError('UNKNOWN_FIELD', `Unknown stock field '${name}'. Use search_fields for supported raw IDs.`);
  return field;
}

// TradingView uses in_range for string-set membership and numeric ranges.
// Numeric-set membership is rejected: a numeric array would silently mean a
// range. The wrapper's isin()/notIn() emit in/not_in, so use explicit conditions.
const FILTER_OPERATIONS = {
  eq: FilterOperator.EQUAL,
  ne: FilterOperator.NOT_EQUAL,
  gt: FilterOperator.GREATER,
  gte: FilterOperator.GREATER_OR_EQUAL,
  lt: FilterOperator.LESS,
  lte: FilterOperator.LESS_OR_EQUAL,
  between: FilterOperator.IN_RANGE,
  in: FilterOperator.IN_RANGE,
  not_in: FilterOperator.NOT_IN_RANGE,
};

function condition(input: FilterInput): FieldCondition {
  return new FieldCondition(getField(input.field), FILTER_OPERATIONS[input.operator], input.value);
}

// The package has a global axios transport and no per-instance adapter hook.
// Reuse its actual query builder and fields without mutating shared axios state;
// execute the built payload through a bounded, request-local Workers fetch.
class WorkerStockScreener extends StockScreener {
  forSymbols(symbols: string[]): this {
    this.symbols = { tickers: symbols, query: { types: [] } };
    return this;
  }

  payload(fields: string[]): QueryPayload {
    this.select(...fields.map(getField));
    return this.buildPayload(fields);
  }
}

function universeFilters(exchanges: readonly Exchange[]): FilterInput[] {
  return [
    { field: 'type', operator: 'eq', value: 'stock' },
    { field: 'subtype', operator: 'in', value: ['common', 'dr'] },
    { field: 'exchange', operator: 'in', value: [...exchanges] },
  ];
}

function universe(exchanges: readonly Exchange[]) {
  return {
    description: 'US-listed common stocks and depositary receipts only; not restricted to US-domiciled issuers.',
    exchanges: [...exchanges],
    securityTypes: ['stock'],
    subtypes: ['common', 'dr'],
  };
}

function baseMeta() {
  return {
    source: 'tradingview-scanner' as const,
    market: 'america' as const,
    fetchedAt: new Date().toISOString(),
    dataFreshness: 'unknown' as const,
    warning: WARNING,
  };
}

function pagination(totalCount: number, offset: number, limit: number, returnedCount: number) {
  const hasMore = returnedCount > 0 && offset + returnedCount < totalCount;
  return {
    totalCount, offset, limit, returnedCount, hasMore,
    nextOffset: hasMore ? offset + returnedCount : null,
  };
}

const upstreamResponseSchema = z.object({
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  data: z.array(z.object({
    s: symbolSchema,
    d: z.array(z.unknown()).max(40),
  })).max(100),
});
type RawResult = z.infer<typeof upstreamResponseSchema>;

function validateResponse(value: unknown, payload: QueryPayload): RawResult {
  const parsed = upstreamResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView returned an invalid scanner response.');
  }
  const result = parsed.data;
  if (result.data.length > payload.range[1] - payload.range[0] || result.totalCount < result.data.length) {
    throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView returned inconsistent scanner counts.');
  }
  const seen = new Set<string>();
  const requestedSymbols = new Set(payload.symbols.tickers ?? []);
  for (const row of result.data) {
    if (row.d.length !== payload.columns.length || seen.has(row.s)
      || (requestedSymbols.size > 0 && !requestedSymbols.has(row.s))) {
      throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView returned inconsistent scanner rows.');
    }
    seen.add(row.s);
  }
  return result;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView scanner response exceeded the size limit.');
  }
  if (!response.body) throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView returned an empty response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView scanner response exceeded the size limit.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(chunks.join(''));
  } catch {
    throw new ScannerError('UPSTREAM_INVALID_RESPONSE', 'TradingView returned malformed JSON.');
  }
}

async function execute(payload: QueryPayload) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(SCANNER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://www.tradingview.com',
        Referer: 'https://www.tradingview.com/',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ScannerError('UPSTREAM_HTTP_ERROR', `TradingView Scanner returned HTTP ${response.status}.`, response.status);
    }
    const raw = validateResponse(await readBoundedJson(response), payload);
    const data = raw.data.map<{ symbol: string } & Record<string, unknown>>((item) => ({
      symbol: item.s,
      ...Object.fromEntries(payload.columns.map((field, index) => [field, item.d[index]])),
    }));
    return { data, totalCount: raw.totalCount };
  } catch (error) {
    if (timedOut) throw new ScannerError('UPSTREAM_TIMEOUT', 'TradingView Scanner request timed out.');
    if (error instanceof ScannerError) throw error;
    throw new ScannerError('UPSTREAM_NETWORK_ERROR', 'Could not reach TradingView Scanner.');
  } finally {
    clearTimeout(timer);
  }
}

export async function scanStocks(input: z.input<typeof scanSchema>) {
  const parsed = parseInput(scanSchema, input);
  const fields = parsed.fields ?? [...DEFAULT_FIELDS];
  const preset = PRESETS.find((item) => item.name === parsed.preset);
  const sort = parsed.sort ?? preset?.sort ?? { field: 'market_cap_basic', direction: 'desc' as const };
  const appliedFilters = [...universeFilters(parsed.exchanges), ...(preset?.filters ?? []), ...parsed.filters];
  const screener = new WorkerStockScreener();
  for (const filter of appliedFilters) screener.where(condition(filter));
  screener.sortBy(getField(sort.field), sort.direction === 'asc')
    .setRange(parsed.offset, parsed.offset + parsed.limit);
  const result = await execute(screener.payload(fields));
  return {
    data: result.data,
    meta: {
      ...baseMeta(),
      ...pagination(result.totalCount, parsed.offset, parsed.limit, result.data.length),
      fields, universe: universe(parsed.exchanges), appliedFilters, sort,
      preset: parsed.preset ?? null,
    },
  };
}

export async function getStockSnapshots(input: z.input<typeof snapshotSchema>) {
  const parsed = parseInput(snapshotSchema, input);
  const fields = parsed.fields ?? [...DEFAULT_FIELDS];
  const screener = new WorkerStockScreener().forSymbols(parsed.symbols)
    .setRange(0, parsed.symbols.length);
  const appliedFilters = universeFilters(EXCHANGES);
  for (const filter of appliedFilters) screener.where(condition(filter));
  const result = await execute(screener.payload(fields));
  const bySymbol = new Map(result.data.map((row) => [row.symbol, row]));
  // Explicitly retain request ordering; the upstream may sort results differently.
  const data = parsed.symbols.flatMap((symbol) => {
    const row = bySymbol.get(symbol);
    return row ? [row] : [];
  });
  return {
    data,
    meta: {
      ...baseMeta(), totalCount: result.totalCount, returnedCount: data.length,
      fields, universe: universe(EXCHANGES), appliedFilters,
      requestedSymbols: parsed.symbols,
      missingSymbols: parsed.symbols.filter((symbol) => !bySymbol.has(symbol)),
    },
  };
}

export function searchFields(input: z.input<typeof fieldSearchSchema>) {
  const parsed = parseInput(fieldSearchSchema, input);
  const query = parsed.query?.trim().toLowerCase() ?? '';
  const matches = query ? FIELD_CATALOGUE.filter((field) =>
    field.field.toLowerCase().includes(query) || field.label.toLowerCase().includes(query)) : FIELD_CATALOGUE;
  const data = matches.slice(parsed.offset, parsed.offset + parsed.limit);
  return {
    data,
    meta: {
      ...baseMeta(),
      ...pagination(matches.length, parsed.offset, parsed.limit, data.length),
      library: 'tradingview-screener@2.3.1', query,
      catalogueNote: 'Library metadata, not a guarantee of current upstream availability. Unknown raw field IDs are rejected locally.',
    },
  };
}

export function listScanPresets() {
  return {
    data: PRESETS.map((preset) => ({
      ...preset,
      filters: preset.filters.map((filter) => ({ ...filter })),
      sort: { ...preset.sort },
    })),
    meta: {
      ...baseMeta(), universe: universe(EXCHANGES),
      combination: 'Preset, universe, and caller filters are ANDed. Caller sort overrides preset sort.',
    },
  };
}
