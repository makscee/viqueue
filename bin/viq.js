#!/usr/bin/env node
import { HttpApplicationClient } from '../src/http-client.js';

const argv = process.argv.slice(2), noun = argv[0], verb = argv[1];
const usage = (message = 'invalid command') => { throw Object.assign(new Error(message), { usage: true, code: 'usage_error' }); };
const option = (name, { required = false } = {}) => {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) usage(`${name} may be supplied only once`);
  const value = indexes.length ? argv[indexes[0] + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) usage(`${name} is required`);
  return value?.startsWith('--') ? undefined : value;
};
const options = (name) => argv.flatMap((value, index) => value === name && argv[index + 1] && !argv[index + 1].startsWith('--') ? [argv[index + 1]] : []);
const positionals = argv.slice(2).filter((value, index, values) => !value.startsWith('--') && (index === 0 || !values[index - 1].startsWith('--')));
const flag = (name) => argv.includes(name);
const requiredProject = () => {
  const indexes = argv.flatMap((value, index) => value === '--project' ? [index] : []);
  if (indexes.length !== 1) usage('exactly one --project KEY is required');
  const raw = argv[indexes[0] + 1];
  if (typeof raw !== 'string' || raw.startsWith('--')) usage('exactly one --project KEY is required');
  const project = raw.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(project)) usage('--project must be a valid project key');
  return project;
};
const requireSessionCapability = () => {
  if (argv.includes('--session-id') || argv.includes('--session-capability')) usage('session authority is never accepted in argv; use a server-issued VIQ_SESSION_CAPABILITY in the environment');
  if (!process.env.VIQ_SESSION_CAPABILITY) usage('VIQ_SESSION_CAPABILITY is required');
};
const credentials = () => {
  requireSessionCapability();
  const generation = Number(option('--generation', { required: true }));
  if (!Number.isSafeInteger(generation) || generation < 1) usage('--generation must be a positive integer');
  return { claim_id: option('--claim-id', { required: true }), claim_token: option('--claim-token', { required: true }), generation };
};
const requestId = ({ required = false } = {}) => {
  const value = option('--request-id', { required });
  return value ? { request_id: value } : {};
};
const target = (prefix) => {
  const device = option(`--${prefix}`), role = option(`--${prefix}-role`);
  if (Boolean(device) === Boolean(role)) usage(`exactly one --${prefix} or --${prefix}-role is required`);
  return { type: role ? 'role' : 'device', id: role ?? device };
};

let method = 'GET', route, body, unauthenticated = false;
if (noun === 'operator') {
  try {
    const { runOperatorCommand } = await import('../src/operator-cli.js');
    const result = await runOperatorCommand(argv.slice(1), process.env.VIQ_OPERATOR_SOCKET ? { socketPath: process.env.VIQ_OPERATOR_SOCKET } : {});
    process.stdout.write(`${JSON.stringify(result)}\n`); process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code ?? 'operator_error', message: error.message } }));
    process.exit(error.code === 'operator_usage' ? 2 : 1);
  }
}
if (noun === 'device' && verb === 'me') route = '/v1/devices/me';
else if (noun === 'device' && verb === 'list') route = '/v1/devices';
else if (noun === 'device' && verb === 'pair' && positionals[0]) { method = 'POST'; route = '/v1/devices/pair'; body = { code: positionals[0] }; unauthenticated = true; }
else if (noun === 'device' && verb === 'pair-code') { method = 'POST'; route = '/v1/pairing-codes'; body = { intended_kind: option('--kind', { required: true }), actor_id: option('--actor', { required: true }), device_id: option('--id', { required: true }), device_name: option('--name', { required: true }), ...(option('--ttl-ms') ? { ttl_ms: Number(option('--ttl-ms')) } : {}) }; }
else if (noun === 'device' && verb === 'revoke' && positionals[0]) { method = 'POST'; route = `/v1/devices/${encodeURIComponent(positionals[0])}/revoke`; body = {}; }
else if (noun === 'session' && verb === 'open') { if (argv.includes('--session-id') || argv.includes('--session-capability')) usage('session authority is never accepted in argv'); method = 'POST'; route = '/v1/sessions'; body = {}; }
else if (noun === 'session' && verb === 'close') { requireSessionCapability(); method = 'POST'; route = '/v1/sessions/close'; body = {}; }
else if (noun === 'role' && verb === 'create' && positionals[0]) { method = 'POST'; route = '/v1/roles'; body = { id: positionals[0], name: option('--name', { required: true }) }; }
else if (noun === 'role' && verb === 'list') route = '/v1/roles';
else if (noun === 'role' && ['grant', 'revoke'].includes(verb) && positionals[0] && positionals[1]) { method = verb === 'revoke' ? 'DELETE' : 'PUT'; route = `/v1/devices/${encodeURIComponent(positionals[0])}/roles/${encodeURIComponent(positionals[1])}`; body = {}; }
else if (noun === 'project' && verb === 'create' && positionals[0]) { method = 'POST'; route = '/v1/projects'; body = { key: positionals[0] }; }
else if (noun === 'project' && verb === 'list') route = '/v1/projects';
else if (noun === 'ticket' && verb === 'create' && positionals[0] && positionals[1]) { method = 'POST'; route = '/v1/tickets'; body = { project: positionals[0], title: positionals[1], description: option('--description') ?? '', assignment: option('--assignment') ?? 'Unassigned' }; }
else if (noun === 'ticket' && verb === 'list' && positionals[0]) route = `/v1/projects/${encodeURIComponent(positionals[0])}/tickets`;
else if (noun === 'ticket' && verb === 'show' && positionals[0]) route = `/v1/tickets/${encodeURIComponent(positionals[0])}`;
else if (noun === 'ticket' && verb === 'next') { const query = new URLSearchParams(); if (option('--project')) query.set('project', option('--project')); route = `/v1/tickets/next?${query}`; }
else if (noun === 'ticket' && verb === 'claim-next') { method = 'POST'; route = '/v1/tickets/claim-next'; requireSessionCapability(); body = { project: requiredProject() }; }
else if (noun === 'ticket' && verb === 'edit' && positionals[0]) { method = 'PATCH'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}`; body = { ...(option('--title') !== undefined ? { title: option('--title') } : {}), ...(option('--description') !== undefined ? { description: option('--description') } : {}), ...(option('--assignment') !== undefined ? { assignment: option('--assignment') } : {}) }; }
else if (noun === 'ticket' && ['claim', 'verify', 'release', 'submit'].includes(verb) && positionals[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/${verb}`; body = verb === 'claim' ? (requireSessionCapability(), {}) : { ...credentials(), ...requestId(), ...(verb === 'submit' ? { reviewer: target('reviewer'), ...(option('--message') ? { message: option('--message') } : {}) } : {}) }; }
else if (noun === 'ticket' && verb === 'progress' && positionals[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/events`; body = { ...credentials(), ...requestId(), message: option('--message', { required: true }) }; }
else if (noun === 'ticket' && verb === 'complete' && positionals[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/complete`; body = { ...credentials(), ...requestId({ required: true }), outcome: option('--outcome', { required: true }), evidence_references: options('--evidence') }; }
else if (noun === 'ticket' && verb === 'accept' && positionals[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/accept`; body = { message: option('--message') }; }
else if (noun === 'question' && verb === 'list' && positionals[0]) { const query = new URLSearchParams(); if (option('--status')) query.set('status', option('--status')); route = `/v1/tickets/${encodeURIComponent(positionals[0])}/questions?${query}`; }
else if (noun === 'question' && verb === 'ask' && positionals[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/questions`; body = { ...credentials(), ...requestId(), text: option('--text', { required: true }), blocking: flag('--blocking') }; }
else if (noun === 'question' && verb === 'answer' && positionals[0] && positionals[1]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/questions/${encodeURIComponent(positionals[1])}/answer`; body = { answer: option('--answer', { required: true }), ...requestId() }; }
else usage();

try {
  const client = new HttpApplicationClient({ server: option('--server') ?? process.env.VIQ_URL, deviceToken: unauthenticated ? null : (option('--device-token') ?? process.env.VIQ_DEVICE_TOKEN), sessionCapability: unauthenticated ? null : process.env.VIQ_SESSION_CAPABILITY });
  const result = await client.request(method, route, body);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'client_error', message: error.message } }));
  process.exit(error.usage ? 2 : 1);
}
