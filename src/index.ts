import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./tools";

export interface WorkerEnv { MCP_API_KEY?: string; MCP_ALLOWED_HOSTS?: string }
export const MAX_BODY_BYTES = 64 * 1024;

function failure(status: number, code: string, message: string, headers?: HeadersInit) {
  return Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  const encoder = new TextEncoder();
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match?.[1] ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return timingSafeEqual(new Uint8Array(provided), new Uint8Array(expected)) && match !== null;
}

async function boundedRequest(request: Request): Promise<Request | Response> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return failure(413, "BODY_TOO_LARGE", "Request body exceeds 64 KiB");
      }
      chunks.push(value);
    }
  } catch {
    return failure(400, "INVALID_BODY", "Request body could not be read");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request, { body });
}
function normalizeHost(host: string, protocol: string): string {
  const trimmed = host.trim().toLowerCase();
  if (protocol === "https:" && trimmed.endsWith(":443")) return trimmed.slice(0, -4);
  if (protocol === "http:" && trimmed.endsWith(":80")) return trimmed.slice(0, -3);
  return trimmed;
}

export async function handleRequest(request: Request, env: WorkerEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const normalizedUrlHost = normalizeHost(url.host, url.protocol);
  if (host !== null && normalizeHost(host, url.protocol) !== normalizedUrlHost) return failure(403, "INVALID_HOST", "Host must match the endpoint");
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return failure(403, "INVALID_ORIGIN", "Browser Origin must match the endpoint");
  const configuredHosts = (env.MCP_ALLOWED_HOSTS ?? "").split(",").map(value => normalizeHost(value, url.protocol)).filter(Boolean);
  const trustedHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || /^tradingview-scanner-mcp\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)
    || configuredHosts.includes(normalizedUrlHost);
  if (!trustedHost) return failure(403, "INVALID_HOST", "Endpoint hostname is not allowed");
  if (url.pathname === "/health") {
    if (request.method !== "GET") return failure(405, "METHOD_NOT_ALLOWED", "Use GET for health", { Allow: "GET" });
    return Response.json({ status: "ok", service: "tradingview-scanner-mcp" }, { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname !== "/mcp") return failure(404, "NOT_FOUND", "Endpoint not found");
  if (!["POST", "GET", "DELETE", "OPTIONS"].includes(request.method)) return failure(405, "METHOD_NOT_ALLOWED", "Unsupported MCP method", { Allow: "POST, GET, DELETE, OPTIONS" });
  if (env.MCP_API_KEY && !await authorized(request, env.MCP_API_KEY)) return failure(401, "AUTH_REQUIRED", "A valid bearer API key is required", { "WWW-Authenticate": "Bearer realm=\"tradingview-scanner-mcp\"" });
  const bounded = await boundedRequest(request);
  if (bounded instanceof Response) return bounded;
  const handler = createMcpHandler(() => createServer(), {
    route: "/mcp", legacy: "stateless", responseMode: "auto", maxRequestBodySize: MAX_BODY_BYTES,
    allowedHostnames: [url.hostname], allowedOriginHostnames: [url.hostname], corsOptions: false,
  });
  try {
    return await handler.fetch(bounded);
  } catch {
    return failure(500, "INTERNAL_ERROR", "The MCP request could not be completed");
  }
}

export default { fetch: handleRequest };
