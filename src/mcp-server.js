#!/usr/bin/env node
import readline from 'node:readline';
import { HttpApplicationClient } from './http-client.js';

const string = (description, pattern) => ({ type: 'string', description, ...(pattern ? { pattern } : {}) });
const integer = (description) => ({ type: 'integer', minimum: 1, maximum: 86_400_000, description });
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const credentialProperties = {
  id: string('Ticket ID', '^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$'),
  actor: string('Current claim owner'), claim_token: string('Opaque claim credential'),
  generation: { type: 'integer', minimum: 1, description: 'Current fencing generation' }
};

const outputSchema = { type: 'object', additionalProperties: true };

export const tools = [
  { name: 'project_create', description: 'Create a ticket project.', inputSchema: object({ key: string('Project key', '^[A-Za-z][A-Za-z0-9]{1,9}$') }, ['key']) },
  { name: 'ticket_create', description: 'Create a ready ticket.', inputSchema: object({ project: string('Project key'), title: string('Ticket title') }, ['project', 'title']) },
  { name: 'ticket_get', description: 'Get a ticket and refresh visible claim staleness.', inputSchema: object({ id: credentialProperties.id }, ['id']) },
  { name: 'ticket_next', description: 'Get the next ready ticket without claiming it.', inputSchema: object({ actor: string('Requesting actor') }, ['actor']) },
  { name: 'ticket_claim', description: 'Explicitly claim a ready ticket.', inputSchema: object({ id: credentialProperties.id, actor: credentialProperties.actor, ttl_ms: integer('Claim lifetime in milliseconds') }, ['id', 'actor', 'ttl_ms']) },
  { name: 'claim_renew', description: 'Renew a current unexpired claim without changing its generation.', inputSchema: object({ ...credentialProperties, ttl_ms: integer('New lifetime from renewal time in milliseconds') }, ['id', 'actor', 'claim_token', 'generation', 'ttl_ms']) },
  { name: 'ticket_takeover', description: 'Explicitly take over a stale claim; server-side authorization is required.', inputSchema: object({ id: credentialProperties.id, actor: credentialProperties.actor, ttl_ms: integer('Claim lifetime in milliseconds') }, ['id', 'actor', 'ttl_ms']) },
  { name: 'ticket_submit', description: 'Submit a ticket using the current fenced claim and attach text or JSON evidence.', inputSchema: object({ ...credentialProperties, evidence: { description: 'Text or JSON evidence', anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }] } }, ['id', 'actor', 'claim_token', 'generation', 'evidence']) }
].map((tool) => ({ ...tool, outputSchema }));

const byName = new Map(tools.map((tool) => [tool.name, tool]));

function invalid(schema, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  if (schema.required.some((key) => !(key in value))) return true;
  if (Object.keys(value).some((key) => !(key in schema.properties))) return true;
  return Object.entries(value).some(([key, item]) => {
    const rule = schema.properties[key];
    if (rule.type === 'string') return typeof item !== 'string' || !item || (rule.pattern && !new RegExp(rule.pattern).test(item));
    if (rule.type === 'integer') return !Number.isInteger(item) || item < (rule.minimum ?? -Infinity) || item > (rule.maximum ?? Infinity);
    if (rule.anyOf) return !rule.anyOf.some(({ type }) => type === 'string' ? typeof item === 'string' : type === 'object' ? item && typeof item === 'object' && !Array.isArray(item) : type === 'array' ? Array.isArray(item) : false);
    return false;
  });
}

function route(name, args) {
  const id = encodeURIComponent(args.id ?? '');
  switch (name) {
    case 'project_create': return ['POST', '/v1/projects', args];
    case 'ticket_create': return ['POST', '/v1/tickets', args];
    case 'ticket_get': return ['GET', `/v1/tickets/${id}`];
    case 'ticket_next': return ['GET', `/v1/tickets/next?actor=${encodeURIComponent(args.actor)}`];
    case 'ticket_claim': return ['POST', `/v1/tickets/${id}/claim`, { actor: args.actor, ttl_ms: args.ttl_ms }];
    case 'claim_renew': return ['POST', `/v1/tickets/${id}/renew`, args];
    case 'ticket_takeover': return ['POST', `/v1/tickets/${id}/takeover`, { actor: args.actor, ttl_ms: args.ttl_ms }, { takeover: true }];
    case 'ticket_submit': return ['PATCH', `/v1/tickets/${id}`, { ...args, status: 'submitted' }];
  }
}

const textResult = (structuredContent, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, ...(isError ? { isError: true } : {})
});

export function createMcpHandler({ client = new HttpApplicationClient({ server: process.env.VIQ_SERVER, takeoverToken: process.env.VIQ_TAKEOVER_TOKEN }) } = {}) {
  return async (message) => {
    if (message.jsonrpc !== '2.0' || !('id' in message)) return null;
    const response = { jsonrpc: '2.0', id: message.id };
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion = requested === '2025-06-18' ? requested : '2025-06-18';
      return { ...response, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'viqueue', version: '0.1.0' } } };
    }
    if (message.method === 'ping') return { ...response, result: {} };
    if (message.method === 'tools/list') return { ...response, result: { tools } };
    if (message.method === 'tools/call') {
      const tool = byName.get(message.params?.name);
      if (!tool) return { ...response, error: { code: -32602, message: 'Unknown tool' } };
      const args = message.params?.arguments ?? {};
      if (invalid(tool.inputSchema, args)) {
        return { ...response, result: textResult({ error: { code: 'invalid_arguments', message: `arguments do not match ${tool.name} schema`, http_status: null } }, true) };
      }
      try {
        const [method, path, body, options] = route(tool.name, args);
        return { ...response, result: textResult(await client.request(method, path, body, options)) };
      } catch (error) {
        return { ...response, result: textResult({ error: { code: error.code, message: error.message, http_status: error.http_status } }, true) };
      }
    }
    return { ...response, error: { code: -32601, message: 'Method not found' } };
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const handler = createMcpHandler();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let response;
    try { response = await handler(JSON.parse(line)); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
