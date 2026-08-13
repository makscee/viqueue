#!/usr/bin/env node
const argv = process.argv.slice(2); let server = process.env.VIQ_SERVER ?? 'http://127.0.0.1:7373'; let jsonOutput = false;
for (let i = 0; i < argv.length;) { if (argv[i] === '--json') { jsonOutput = true; argv.splice(i, 1); } else if (argv[i] === '--server') { server = argv[i + 1]; argv.splice(i, 2); } else i += 1; }
const usage = (message = 'invalid command') => { throw Object.assign(new Error(message), { usage: true, code: 'usage_error' }); };
const option = (name, { required = false } = {}) => { const i = argv.indexOf(name); const value = i >= 0 ? argv[i + 1] : undefined; if (required && !value) usage(`${name} is required`); return value; };
const credentials = () => ({ claim_id: option('--claim-id', { required: true }), actor: option('--actor', { required: true }), claim_token: option('--claim-token', { required: true }), generation: Number(option('--generation', { required: true })) });
async function command() {
  const [noun, verb, ...p] = argv; let method = 'GET'; let route; let body; const headers = {};
  if (noun === 'project' && verb === 'create' && p[0]) { method = 'POST'; route = '/v1/projects'; body = { key: p[0] }; }
  else if (noun === 'project' && verb === 'list') route = '/v1/projects';
  else if (noun === 'ticket' && verb === 'create' && p[0] && p[1]) { method = 'POST'; route = '/v1/tickets'; body = { project: p[0], title: p[1], body: option('--body') ?? '', assigned_to: option('--assigned-to') }; }
  else if (noun === 'ticket' && verb === 'list' && p[0]) route = `/v1/projects/${encodeURIComponent(p[0])}/tickets`;
  else if (noun === 'ticket' && verb === 'show' && p[0]) route = `/v1/tickets/${encodeURIComponent(p[0])}`;
  else if (noun === 'ticket' && verb === 'next') route = `/v1/tickets/next${option('--project') ? `?project=${encodeURIComponent(option('--project'))}` : ''}`;
  else if (noun === 'ticket' && verb === 'edit' && p[0]) { method = 'PATCH'; route = `/v1/tickets/${encodeURIComponent(p[0])}`; body = { actor: option('--actor'), ...(option('--title') !== undefined ? { title: option('--title') } : {}), ...(option('--body') !== undefined ? { body: option('--body') } : {}), ...(option('--assigned-to') !== undefined ? { assigned_to: option('--assigned-to') || null } : {}) }; }
  else if (noun === 'ticket' && ['claim','verify','release','submit'].includes(verb) && p[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(p[0])}/${verb}`; body = verb === 'claim' ? { actor: option('--actor', { required: true }) } : { ...credentials(), ...(verb === 'submit' && option('--message') ? { message: option('--message') } : {}) }; }
  else if (noun === 'ticket' && ['takeover','accept','reopen'].includes(verb) && p[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(p[0])}/${verb}`; body = { actor: option('--actor', { required: true }), ...(option('--message') ? { message: option('--message') } : {}) }; headers.authorization = `Bearer ${option('--auth', { required: true })}`; }
  else if (noun === 'event' && verb === 'post' && p[0]) { method = 'POST'; route = `/v1/tickets/${encodeURIComponent(p[0])}/events`; body = { ...credentials(), message: option('--message', { required: true }) }; }
  else if (noun === 'event' && verb === 'list') { const q = new URLSearchParams(); if (option('--project')) q.set('project', option('--project')); if (option('--ticket')) q.set('ticket', option('--ticket')); if (option('--after')) q.set('after', option('--after')); route = `/v1/events?${q}`; }
  else usage();
  const response = await fetch(`${server}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); const payload = text ? JSON.parse(text) : { ticket: null };
  if (!response.ok) throw Object.assign(new Error(payload.error?.message ?? 'request failed'), { payload, status: response.status });
  return payload;
}
try { const result = await command(); process.stdout.write(jsonOutput ? `${JSON.stringify(result)}\n` : `${JSON.stringify(result, null, 2)}\n`); }
catch (error) { const payload = error.payload ?? { error: { code: error.code ?? 'client_error', message: error.message } }; process.stderr.write(jsonOutput ? `${JSON.stringify(payload)}\n` : `${payload.error.code}: ${payload.error.message}\n`); process.exitCode = error.usage ? 2 : error.status === 409 ? 3 : error.status === 404 ? 4 : error.status ? 5 : 6; }
