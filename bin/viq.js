#!/usr/bin/env node

const argv = process.argv.slice(2);
let server = process.env.VIQ_SERVER ?? 'http://127.0.0.1:7373';
let jsonOutput = false;
for (let index = 0; index < argv.length;) {
  if (argv[index] === '--json') { jsonOutput = true; argv.splice(index, 1); continue; }
  if (argv[index] === '--server') { server = argv[index + 1]; argv.splice(index, 2); continue; }
  index += 1;
}

function usage(message = 'invalid command') {
  throw Object.assign(new Error(message), { usage: true, code: 'usage_error' });
}

function parseEvidence(value) {
  if (value === undefined) usage('evidence is required');
  try { return JSON.parse(value); } catch { return value; }
}

function option(name, { required = false } = {}) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (required && !value) usage(`${name} is required`);
  return value;
}

async function command() {
  const [noun, verb, ...positionals] = argv;
  let method = 'GET';
  let route;
  let body;
  const headers = {};

  if (noun === 'project' && verb === 'create' && positionals[0]) {
    method = 'POST'; route = '/v1/projects'; body = { key: positionals[0] };
  } else if (noun === 'ticket' && verb === 'create' && positionals[0] && positionals[1]) {
    method = 'POST'; route = '/v1/tickets'; body = { project: positionals[0], title: positionals[1] };
  } else if (noun === 'ticket' && verb === 'next') {
    route = `/v1/tickets/next?actor=${encodeURIComponent(option('--actor', { required: true }))}`;
  } else if (noun === 'ticket' && verb === 'show' && positionals[0]) {
    route = `/v1/tickets/${encodeURIComponent(positionals[0])}`;
  } else if (noun === 'ticket' && verb === 'claim' && positionals[0]) {
    method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/claim`;
    body = { actor: option('--actor', { required: true }), ttl_ms: Number(option('--ttl-ms', { required: true })) };
  } else if (noun === 'ticket' && verb === 'renew' && positionals[0]) {
    method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/renew`;
    body = {
      actor: option('--actor', { required: true }), claim_token: option('--claim-token', { required: true }),
      generation: Number(option('--generation', { required: true })), ttl_ms: Number(option('--ttl-ms', { required: true }))
    };
  } else if (noun === 'ticket' && verb === 'takeover' && positionals[0]) {
    method = 'POST'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}/takeover`;
    body = { actor: option('--actor', { required: true }), ttl_ms: Number(option('--ttl-ms', { required: true })) };
    headers.authorization = `Bearer ${option('--auth', { required: true })}`;
  } else if (noun === 'ticket' && verb === 'submit' && positionals[0]) {
    method = 'PATCH'; route = `/v1/tickets/${encodeURIComponent(positionals[0])}`;
    body = {
      actor: option('--actor', { required: true }), claim_token: option('--claim-token', { required: true }),
      generation: Number(option('--generation', { required: true })), status: 'submitted',
      evidence: parseEvidence(option('--evidence', { required: true }))
    };
  } else usage();

  const response = await fetch(`${server}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : { ticket: null };
  if (!response.ok) {
    const error = Object.assign(new Error(payload.error?.message ?? 'request failed'), { payload, status: response.status });
    throw error;
  }
  return payload;
}

try {
  const result = await command();
  process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const payload = error.payload ?? { error: { code: error.code ?? 'client_error', message: error.message } };
  process.stderr.write(jsonOutput ? `${JSON.stringify(payload)}\n` : `${payload.error.code}: ${payload.error.message}\n`);
  process.exitCode = error.usage ? 2 : error.status === 409 ? 3 : error.status === 404 ? 4 : error.status ? 5 : 6;
}
