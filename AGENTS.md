# Repository Guidelines

## Project Overview

`tradingview_scanner_mcp` is a stateless Model Context Protocol (MCP) server running on Cloudflare Workers (`workerd`). It exposes four specialized screening and snapshot tools over HTTP (`/mcp`), querying TradingView's official Americas stock scanner backend (`https://scanner.tradingview.com/america/scan`).

The server enables LLM agents to perform high-performance, real-time US equity market scans (NASDAQ, NYSE, AMEX), execute preset screens (gainers, losers, most active, unusual volume), search through 3,500+ TradingView data fields, and retrieve multi-ticker price snapshots without maintaining state or running heavyweight browser automation.

---

## Architecture & Data Flow

The project follows a layered, stateless architecture that bridges the Model Context Protocol to TradingView's upstream scanner endpoints through a security-hardened Cloudflare Worker.

```
Client (MCP or HTTP)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│ src/index.ts (Worker Entrypoint & Security Perimeter)       │
│  - Host & Origin validation (DNS rebinding / CSRF guard)    │
│  - Timing-safe SHA-256 Bearer Token check (MCP_API_KEY)     │
│  - Inbound streaming byte cap (MAX_BODY_BYTES = 64 KiB)     │
│  - Route multiplexing (/health vs /mcp)                     │
│  - Per-request createMcpHandler adapter                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ src/tools.ts (MCP Server & Tool Definitions)                │
│  - McpServer lifecycle & annotations (readOnly, idempotent) │
│  - Unified execute() wrapper with UUID requestId generation │
│  - Dual payload formatting: text JSON + structuredContent   │
│  - Standardized error capture & envelope mapping            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ src/scanner.ts (Scanner Domain & Upstream Client)           │
│  - Field catalogue mapping (3,521 TradingView stock fields)  │
│  - Zod schemas with strict validation & semantic guards     │
│  - WorkerStockScreener: payload builder (bypasses axios)    │
│  - Upstream fetch() with redirect: 'manual' & 10s timeout   │
│  - Upstream response validation (2 MiB limit) & row mapping │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
                 TradingView America Scanner
         https://scanner.tradingview.com/america/scan
```

### Key Modules & Responsibilities
- **`src/index.ts`**: Worker edge entrypoint. Enforces DNS rebinding/Origin checks, constant-time API key verification, request body streaming limits, liveness routing, and delegates to `@cloudflare/agents/mcp/server`.
- **`src/tools.ts`**: MCP protocol server definition. Registers the 4 tools (`search_fields`, `list_scan_presets`, `scan_stocks`, `get_stock_snapshots`), defines Zod input schemas, decorates tool metadata, attaches request UUIDs, and builds dual text/structured payloads.
- **`src/scanner.ts`**: Domain logic and upstream HTTP client. Subclasses `tradingview-screener`'s `StockScreener` (`WorkerStockScreener`) to serialize query ASTs without using its default Node/axios transport. Dispatches raw worker `fetch()` calls with strict headers, manual redirect protection, and maps matrix rows into structured JSON.

---

## Key Directories

```
.
├── src/            # Core TypeScript source (Worker entrypoint, MCP tools, scanner client)
├── test/           # Deterministic offline unit and integration tests (node:test)
├── scripts/        # End-to-end smoke tests and operational utilities
└── .dev.vars       # Local secrets and environment configuration (git-ignored)
```

- **`src/`**: All production runtime logic running inside Cloudflare Workers (`workerd`).
- **`test/`**: Offline, fast test suite verifying Zod schemas, upstream query compilation, error mapping, and Worker security headers using mocked globals.
- **`scripts/`**: Automation scripts, including `smoke.ts` for verifying live deployed workers or local dev instances with an actual MCP client.

---

## Development Commands

All primary workflows are managed via standard `npm` scripts:

```bash
# Start local development server with Vite & Cloudflare workerd (127.0.0.1:8787)
npm run dev

# Run TypeScript typecheck without emitting files
npm run typecheck

# Build Cloudflare Worker bundle (runs typecheck first)
npm run build

# Run deterministic offline unit and integration test suite
npm test

# Run live end-to-end smoke test against local dev server
npm run smoke

# Run live smoke test against a deployed worker or custom URL
MCP_URL="https://tradingview-scanner-mcp.<account>.workers.dev/mcp" MCP_API_KEY="<secret>" npm run smoke

# Deploy to Cloudflare Workers (runs typecheck first)
npm run deploy
```

---

## Code Conventions & Common Patterns

### 1. Cloudflare `workerd` Fetch Redirects
- **Critical Runtime Constraint**: Cloudflare's `workerd` runtime throws a `TypeError: use 'follow' or 'manual'` if `redirect: 'error'` is used in `fetch()`, even though TypeScript's standard `RequestInit` typings allow it.
- **Rule**: Fixed-origin API calls that must reject redirects MUST explicitly pass `redirect: 'manual'` and treat any `3xx` response status as an error:
  ```typescript
  const response = await fetch(SCANNER_ENDPOINT, {
    method: "POST",
    headers,
    body,
    signal: controller.signal,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new ScannerError("UPSTREAM_REDIRECT", "Unexpected redirect from upstream scanner");
  }
  ```

### 2. Upstream Library Decoupling (`tradingview-screener`)
- The external npm package `tradingview-screener` relies on Node-specific `axios` for network calls, which fails in edge runtimes.
- **Pattern**: Subclass `StockScreener` into `WorkerStockScreener` to use its query builder methods (`.filter()`, `.sort()`, `.setRange()`), call `.payload(fields)` to extract the query payload, and execute the HTTP request via Web standard `fetch()`.

### 3. Timing-Safe Authentication
- Authentication uses a constant-time comparison on SHA-256 hashes to prevent timing attacks while accepting variable-length input:
  ```typescript
  import { timingSafeEqual } from "node:crypto";

  const expectedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedKey));
  const providedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(providedKey));

  if (!timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))) {
    return new Response("Unauthorized", { status: 401 });
  }
  ```

### 4. Dual-Format MCP Responses & Unified Error Handling
- Every tool returns a consistent envelope containing both raw text JSON and `structuredContent`:
  ```typescript
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
  ```
- Tool execution is wrapped in `execute(operation)`:
  - Generates a UUID `requestId` via `crypto.randomUUID()`.
  - Stamps metadata (`source: 'tradingview-scanner'`, `market: 'america'`, `fetchedAt`, `requestId`).
  - Standardizes errors into structured objects with `isError: true` and machine-readable error codes:
    - `INVALID_ARGUMENTS`: Zod schema validation errors.
    - `UPSTREAM_REDIRECT`: Security violation (unexpected 3xx).
    - `UPSTREAM_TIMEOUT`: Exceeded 10-second upstream abort window.
    - `UPSTREAM_HTTP_ERROR`: Upstream non-2xx status code.
    - `UPSTREAM_SCHEMA_ERROR`: Malformed upstream JSON structure.
    - `RESPONSE_TOO_LARGE`: Payload exceeds 2 MiB ceiling.

### 5. Input Validation Boundaries
- All user inputs are strictly guarded by Zod schemas in `src/scanner.ts`:
  - `limit`: Integer clamped to `1..100` (default `20`).
  - `offset`: Integer clamped to `0..10000` (default `0`).
  - `fields`: Max 40 fields, validated against known catalogue fields or uppercase fallback.
  - `filters`: Max 20 filters per request.
  - `tickers`: Max 50 symbols, strictly formatted as `EXCHANGE:TICKER` (e.g. `NASDAQ:AAPL`).

---

## Important Files

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry point, HTTP routing, security checks (Host, Origin, API Key), body stream limiter. |
| `src/tools.ts` | MCP server instantiation, tool declarations, parameter schemas, response/error formatting. |
| `src/scanner.ts` | TradingView client logic, field definitions, query builder, validation, upstream fetch. |
| `cloudflare.config.ts` | Cloudflare Worker configuration (`compatibilityDate: 2026-10-25`, `nodejs_compat`). |
| `vite.config.ts` | Vite build and dev server configuration utilizing `@cloudflare/vite-plugin`. |
| `tsconfig.json` | Strict TypeScript configuration targeting `ES2022` / `ESNext` for Bundler module resolution. |
| `test/scanner.test.ts` | Schema tests: Zod bounds, field searching, pagination logic. |
| `test/scanner-upstream.test.ts` | Integration tests: payload compilation, filter operators, mock upstream network error handling. |
| `test/worker.test.ts` | Worker pipeline tests: health checks, authentication, DNS rebinding guards, body size caps. |
| `scripts/smoke.ts` | End-to-end integration test exercising all MCP tools against live servers via `@modelcontextprotocol/client`. |
| `.dev.vars.example` | Template for local environment secrets (`MCP_API_KEY`, `MCP_ALLOWED_HOSTS`). |

---

## Runtime & Tooling Preferences

- **Package Manager**: **`npm`** (uses `package-lock.json`). Always use `npm` / `npm ci`.
- **Node.js Requirement**: `>=22.23.0` (aligned with pinned CLI and native `node:test`, modern `crypto.subtle`, ES module support).
- **Runtime Environment**:
  - Execution targets Cloudflare Workers via **`workerd`**.
  - Modern Cloudflare CLI: Uses **`cf`** (`cf dev`, `cf build`, `cf deploy`) and `@cloudflare/vite-plugin`, **not** legacy `wrangler`.
- **Compatibility Flags**:
  - `compatibilityDate: "2026-10-25"`
  - `compatibilityFlags: ["nodejs_compat"]` (enables `node:crypto` polyfill for `timingSafeEqual`).
- **No Durable State**:
  - The server is strictly stateless (`legacy: "stateless"` in `createMcpHandler`). No D1, KV, R2, or Durable Objects are used.

---

## Testing & QA

### Test Runner & Strategy
- **Framework**: Node.js native test runner (`node:test`) executed via `tsx --test test/*.test.ts`.
- **Assertions**: `node:assert/strict`.
- **Determinism**: Unit and integration tests in `test/` are 100% offline and do not access the external network.

### Mocking Conventions
- Upstream HTTP mocking in tests uses a scoped `withFetch` pattern that temporarily intercepts `globalThis.fetch`:
  ```typescript
  async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  }
  ```
- **Poisoned Mocks**: For client-side validation checks, mock `fetch` throws `new Error('network must not be called')` to ensure no network calls are dispatched on invalid input.
- **Worker Direct Testing**: `test/worker.test.ts` invokes `worker.fetch(request, env)` directly in memory without binding network ports.

### Verification Checklist Before Submitting Changes
1. **Type Check**: `npm run typecheck` passes with zero errors.
2. **Offline Tests**: `npm test` passes all unit, integration, and security test suites.
3. **Smoke Tests**: When modifying network payloads or tool schemas, run `npm run dev` in one terminal and `npm run smoke` in another to verify end-to-end MCP protocol conformance.
