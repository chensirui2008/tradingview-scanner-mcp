import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ScannerError, fieldSearchSchema, scanSchema, snapshotSchema, searchFields, scanStocks, getStockSnapshots, listScanPresets } from "./scanner";

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

async function execute(operation: () => unknown | Promise<unknown>) {
  const requestId = crypto.randomUUID();
  try {
    const value = await operation();
    const result = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { data: value };
    const meta = typeof result.meta === "object" && result.meta !== null && !Array.isArray(result.meta) ? result.meta as Record<string, unknown> : {};
    const output = { ...result, meta: { ...meta, requestId } };
    return { resultType: "complete" as const, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    const output = { error: { code: error instanceof ScannerError ? error.code : "INTERNAL_ERROR", message: error instanceof ScannerError ? error.message : "The scanner request could not be completed", requestId } };
    return { resultType: "complete" as const, isError: true, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
  }
}

export function createServer() {
  const server = new McpServer({ name: "tradingview-scanner-mcp", version: "1.0.0" });
  server.registerTool("search_fields", {
    description: "Search the community wrapper's raw TradingView field catalogue. Use returned field IDs in scans; catalogue presence does not guarantee upstream availability.",
    inputSchema: fieldSearchSchema, annotations,
  }, input => execute(() => searchFields(input)));
  server.registerTool("scan_stocks", {
    description: "Screen common stocks and depositary receipts listed on NASDAQ, NYSE or AMEX using the public US TradingView Scanner. Filters are ANDed. Data may be delayed; fetchedAt is retrieval time, not quote time. Not a trading approval.",
    inputSchema: scanSchema, annotations,
  }, input => execute(() => scanStocks(input)));
  server.registerTool("get_stock_snapshots", {
    description: "Fetch public TradingView Scanner fields for exchange-qualified US stock symbols. Missing symbols are reported explicitly. Data freshness is unknown and may be delayed.",
    inputSchema: snapshotSchema, annotations,
  }, input => execute(() => getStockSnapshots(input)));
  server.registerTool("list_scan_presets", {
    description: "List deterministic screening preset definitions, filters and ordering. Presets are discovery aids, not recommendations or trading approvals.",
    inputSchema: z.object({}), annotations,
  }, () => execute(() => listScanPresets()));
  return server;
}
