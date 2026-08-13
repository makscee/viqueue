#!/usr/bin/env node
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['dist/src/mcp-server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
let buffer = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const action = process.argv[2];
await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

let name;
let args;
if (action === 'create') [name, args] = ['project_create', { key: 'ABC' }];
else if (action === 'ticket-create') [name, args] = ['ticket_create', { project: 'ABC', title: 'phase one parity tracer' }];
else if (action === 'get') [name, args] = ['ticket_get', { id: 'ABC-1' }];
else if (action === 'renew') [name, args] = ['claim_renew', { id: 'ABC-1', actor: process.argv[3], claim_token: process.argv[4], generation: Number(process.argv[5]), ttl_ms: Number(process.argv[6]) }];
else if (action === 'takeover') [name, args] = ['ticket_takeover', { id: 'ABC-1', actor: process.argv[3], ttl_ms: Number(process.argv[4]) }];
else if (action === 'submit') [name, args] = ['ticket_submit', { id: 'ABC-1', actor: process.argv[3], claim_token: process.argv[4], generation: Number(process.argv[5]), evidence: JSON.parse(process.argv[6]) }];
else throw new Error(`unknown action ${action}`);

const response = await request('tools/call', { name, arguments: args });
process.stdout.write(`${JSON.stringify(response.result)}\n`);
child.kill();
process.exit(response.result.isError ? 3 : 0);
