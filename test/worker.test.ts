import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import worker from '../src/index.js';
import { createServer } from '../src/tools.js';
const url = 'http://localhost/mcp';
async function rejected(request: Request, status: number, code: string, env = {}) {
  const response = await worker.fetch(request, env);
  assert.equal(response.status, status);
  const body = await response.json() as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, code);
  assert.ok(body.error.requestId);
}

test('health is public liveness even when MCP requires a key', async () => {
  const response = await worker.fetch(new Request('http://localhost/health'), { MCP_API_KEY: 'secret' });
  assert.equal(response.status, 200);
});

test('configured key rejects missing and incorrect bearer credentials', async () => {
  await rejected(new Request(url, { method: 'POST' }), 401, 'AUTH_REQUIRED', { MCP_API_KEY: 'secret' });
  await rejected(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } }), 401, 'AUTH_REQUIRED', { MCP_API_KEY: 'secret' });
});

test('cross-origin and mismatched host requests are rejected', async () => {
  await rejected(new Request(url, { method: 'POST', headers: { Origin: 'https://evil.example' } }), 403, 'INVALID_ORIGIN');
  await rejected(new Request(url, { method: 'POST', headers: { Host: 'evil.example' } }), 403, 'INVALID_HOST');
});

test('unknown routes and unsupported methods reject without upstream access', async () => {
  await rejected(new Request('http://localhost/unknown'), 404, 'NOT_FOUND');
  await rejected(new Request(url, { method: 'PUT' }), 405, 'METHOD_NOT_ALLOWED');
});

test('actual body bytes are capped even without a content-length header', async () => {
  await rejected(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(65537) }), 413, 'BODY_TOO_LARGE');
});

test('multibyte bodies are measured in bytes rather than characters', async () => {
  await rejected(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '股'.repeat(22000) }), 413, 'BODY_TOO_LARGE');
});

test('correct bearer key reaches request body validation', async () => {
  await rejected(new Request(url, { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: 'x'.repeat(65537) }), 413, 'BODY_TOO_LARGE', { MCP_API_KEY: 'secret' });
});

test('custom domains require explicit host configuration', async () => {
  await rejected(new Request('https://custom.example/health'), 403, 'INVALID_HOST');
  const response = await worker.fetch(new Request('https://custom.example/health'), { MCP_ALLOWED_HOSTS: 'custom.example' });
  assert.equal(response.status, 200);
});

test('default ports on host authority are normalized for health and custom domains', async () => {
  const resHttpsPort = await worker.fetch(new Request('https://custom.example:443/health', {
    headers: { Host: 'custom.example:443' },
  }), { MCP_ALLOWED_HOSTS: 'custom.example' });
  assert.equal(resHttpsPort.status, 200);

  const resConfiguredWithPort = await worker.fetch(new Request('https://custom.example/health', {
    headers: { Host: 'custom.example' },
  }), { MCP_ALLOWED_HOSTS: 'custom.example:443' });
  assert.equal(resConfiguredWithPort.status, 200);

  const resHttpPort = await worker.fetch(new Request('http://localhost:80/health', {
    headers: { Host: 'localhost:80' },
  }));
  assert.equal(resHttpPort.status, 200);
});

test('MCP tool schema validation error returns structured error envelope', async () => {
  const server = createServer();
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(s), client.connect(c)]);
  const res = await client.callTool({ name: 'scan_stocks', arguments: { limit: 0 } });
  assert.equal(res.isError, true);
  const body = res.structuredContent as { error: { code: string; message: string; requestId: string } };
  assert.equal(body.error.code, 'INVALID_ARGUMENTS');
  assert.ok(typeof body.error.message === 'string');
  assert.ok(body.error.requestId);
});
