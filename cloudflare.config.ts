import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "tradingview-scanner-mcp",
    entrypoint,
    compatibilityDate: "2026-10-25",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: true,
    observability: { enabled: true, traces: { enabled: true } },
  },
});
