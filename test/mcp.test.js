import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/server.js';

class McpClient {
  constructor(server, takeoverToken = 'secret') {
    this.child = spawn(process.execPath, ['src/mcp-server.js'], {
      env: { ...process.env, VIQ_SERVER: server, VIQ_TAKEOVER_TOKEN: takeoverToken },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      this.child.once('exit', (code) => reject(new Error(`MCP exited ${code}: ${this.stderr}`)));
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return result;
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'viqueue-test', version: '1' }
    });
    this.notify('notifications/initialized');
    return response;
  }

  call(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() { this.child.kill(); }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-mcp-'));
  const app = await createApp({ storage: path.join(dir, 'data.json'), takeoverToken: 'secret' });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const client = new McpClient(`http://127.0.0.1:${app.address().port}`);
  return { app, client };
}

const structured = (response) => response.result.structuredContent;

test('real MCP stdio exchange initializes and discovers stable tool schemas', async (t) => {
  const { app, client } = await fixture();
  t.after(() => { client.close(); app.close(); });
  const initialized = await client.initialize();
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(initialized.result.serverInfo, { name: 'viqueue', version: '0.1.0' });

  const listed = await client.request('tools/list');
  assert.deepEqual(listed.result.tools.map(({ name }) => name), [
    'project_create', 'ticket_create', 'ticket_get', 'ticket_next', 'ticket_claim',
    'claim_renew', 'ticket_takeover', 'ticket_submit'
  ]);
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('MCP calls the actual HTTP application and maps stable domain errors', async (t) => {
  const { app, client } = await fixture();
  t.after(() => { client.close(); app.close(); });
  await client.initialize();

  assert.equal(structured(await client.call('project_create', { key: 'ABC' })).project.key, 'ABC');
  assert.equal(structured(await client.call('ticket_create', { project: 'ABC', title: 'MCP tracer' })).ticket.id, 'ABC-1');
  assert.equal(structured(await client.call('ticket_next', { actor: 'worker-a' })).ticket.id, 'ABC-1');
  const claim = structured(await client.call('ticket_claim', { id: 'ABC-1', actor: 'worker-a', ttl_ms: 1000 }));
  assert.equal(claim.ticket.claim.generation, 1);

  const fenced = await client.call('claim_renew', {
    id: 'ABC-1', actor: 'worker-b', claim_token: claim.claim_token, generation: 1, ttl_ms: 1000
  });
  assert.equal(fenced.result.isError, true);
  assert.deepEqual(fenced.result.structuredContent, {
    error: { code: 'stale_claim', message: 'claim token or generation is no longer current', http_status: 409 }
  });
});

test('MCP rejects invalid tool arguments without reaching domain behavior', async (t) => {
  const { app, client } = await fixture();
  t.after(() => { client.close(); app.close(); });
  await client.initialize();
  const response = await client.call('ticket_claim', { id: 'ABC-1', actor: 'a', ttl_ms: 'wrong' });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, 'invalid_arguments');
});
