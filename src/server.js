import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, DomainError } from './store.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/ui-core.js': ['ui-core.js', 'text/javascript; charset=utf-8'] };
const send = (response, status, body) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(body === undefined ? '' : `${JSON.stringify(body)}\n`); };
async function json(request) { let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw new DomainError(413, 'body_too_large', 'request body exceeds 1MB'); } try { return raw ? JSON.parse(raw) : {}; } catch { throw new DomainError(400, 'invalid_json', 'request body must be valid JSON'); } }
const bearer = (request) => { const value = request.headers.authorization; return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : null; };
const requireKind = (device, kind) => { if (device.kind !== kind) throw new DomainError(403, `${kind}_required`, `${kind} device is required`); };
const requireAdmin = (device) => { if (!device.admin) throw new DomainError(403, 'admin_required', 'active admin actor is required'); };
const sessionCapability = (request, body) => { if (body && ('session_id' in body || 'session_capability' in body)) throw new DomainError(400, 'client_session_authority_forbidden', 'session authority must use the confidential capability header'); const value = request.headers['x-viq-session-capability']; if (typeof value !== 'string') throw new DomainError(401, 'session_unauthorized', 'a live server-issued session capability is required'); return value; };
const claimIdentity = (request, body, device) => ({ ...body, actor: device.actor_id, device: device.id, session_capability: sessionCapability(request, body) });
const sessionClaim = (request, body, device) => ({ device: device.id, session_capability: sessionCapability(request, body) });
const boundPairingRequest = (body) => {
  if (!body || typeof body.actor_id !== 'string' || !body.actor_id.trim() || !['coordinator', 'worker'].includes(body.intended_kind) || typeof body.device_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(body.device_id) || typeof body.device_name !== 'string' || !body.device_name.trim() || body.device_name.length > 200) throw new DomainError(400, 'invalid_pairing_request', 'actor_id, intended_kind, device_id, and device_name are required');
  return body;
};

export async function createApp({ storage, now } = {}) {
  const store = new Store(storage ?? './viqueue.sqlite', { now }); await store.init();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'); let match;
      if (request.method === 'GET' && assets[url.pathname]) { const [file, contentType] = assets[url.pathname]; response.statusCode = 200; response.setHeader('content-type', contentType); response.setHeader('cache-control', 'no-store'); response.end(await readFile(path.join(webRoot, file))); return; }
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
      if (request.method === 'POST' && url.pathname === '/v1/devices/pair') return send(response, 201, await store.pairDevice(await json(request)));

      const device = await store.authenticateDevice(bearer(request));
      if (request.method === 'GET' && url.pathname === '/v1/devices/me') return send(response, 200, { device: await store.getDevice(device.id), actor: await store.getActor(device.actor_id) });
      if (request.method === 'POST' && url.pathname === '/v1/sessions') { requireKind(device, 'worker'); return send(response, 201, await store.openWorkerSession(device.id)); }
      if (request.method === 'POST' && url.pathname === '/v1/sessions/close') { requireKind(device, 'worker'); const body = await json(request); return send(response, 200, await store.closeWorkerSession(device.id, sessionCapability(request, body))); }
      if (request.method === 'GET' && url.pathname === '/v1/devices') { requireAdmin(device); return send(response, 200, { devices: await store.listDevices() }); }
      if (request.method === 'GET' && url.pathname === '/v1/actors') { requireAdmin(device); return send(response, 200, { actors: await store.listActors() }); }
      if (request.method === 'POST' && url.pathname === '/v1/actors') { requireAdmin(device); return send(response, 201, { actor: await store.createActor(await json(request), device.id) }); }
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)$/)) && request.method === 'PATCH') { requireAdmin(device); return send(response, 200, { actor: await store.updateActor(decodeURIComponent(match[1]), await json(request), device.id) }); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)$/)) && request.method === 'PATCH') { requireAdmin(device); return send(response, 200, { device: await store.updateDevice(decodeURIComponent(match[1]), await json(request), device.id) }); }
      if (request.method === 'POST' && url.pathname === '/v1/pairing-codes') { requireAdmin(device); return send(response, 201, await store.createPairingCode(device.id, boundPairingRequest(await json(request)))); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 200, { device: await store.revokeDevice(decodeURIComponent(match[1]), device.id) }); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/roles$/)) && request.method === 'GET') { const id = decodeURIComponent(match[1]); if (device.kind !== 'coordinator' && device.id !== id) throw new DomainError(403, 'device_forbidden', 'worker may read only its own roles'); return send(response, 200, await store.listDeviceRoles(id)); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/roles\/([^/]+)$/)) && request.method === 'PUT') { requireAdmin(device); return send(response, 200, { membership: await store.grantDeviceRole(decodeURIComponent(match[1]), decodeURIComponent(match[2]), device.id) }); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/roles\/([^/]+)$/)) && request.method === 'DELETE') { requireAdmin(device); return send(response, 200, { membership: await store.revokeDeviceRole(decodeURIComponent(match[1]), decodeURIComponent(match[2]), device.id) }); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/claims$/)) && request.method === 'GET') { const id = decodeURIComponent(match[1]); if (!device.admin && device.id !== id && device.actor_id !== id) throw new DomainError(403, 'device_forbidden', 'worker may read only its actor claims'); return send(response, 200, { tickets: await store.activeClaimsForDevice(id) }); }
      if ((match = url.pathname.match(/^\/v1\/devices\/([^/]+)\/inbox$/)) && request.method === 'GET') { const id = decodeURIComponent(match[1]); if (!device.admin && device.id !== id && device.actor_id !== id) throw new DomainError(403, 'device_forbidden', 'worker may read only its actor inbox'); return send(response, 200, await store.actorInbox(id, { after: Number(url.searchParams.get('after') ?? 0) })); }

      if (request.method === 'GET' && url.pathname === '/v1/roles') return send(response, 200, { roles: await store.listRoles() });
      if (request.method === 'POST' && url.pathname === '/v1/roles') { requireAdmin(device); return send(response, 201, { role: await store.createRole({ ...(await json(request)), actor: device.id }) }); }
      if ((match = url.pathname.match(/^\/v1\/roles\/([^/]+)$/)) && request.method === 'DELETE') { requireAdmin(device); return send(response, 200, { role: await store.deleteRole(decodeURIComponent(match[1]), device.id) }); }
      if ((match = url.pathname.match(/^\/v1\/roles\/([^/]+)\/devices$/)) && request.method === 'GET') { requireAdmin(device); const roleId = decodeURIComponent(match[1]); const devices = await store.listDevices(); const members = []; for (const item of devices) if ((await store.listDeviceRoles(item.id)).roles.some((role) => role.id === roleId)) members.push(item); return send(response, 200, { role: roleId, devices: members }); }

      if (request.method === 'GET' && url.pathname === '/v1/projects') return send(response, 200, { projects: await store.listProjects() });
      if (request.method === 'GET' && url.pathname === '/v1/board') { requireAdmin(device); return send(response, 200, { tickets: await store.listBoardTickets() }); }
      if (request.method === 'POST' && url.pathname === '/v1/projects') { requireAdmin(device); return send(response, 201, { project: await store.createProject((await json(request)).key) }); }
      if (request.method === 'POST' && url.pathname === '/v1/tickets') { requireAdmin(device); return send(response, 201, { ticket: await store.createTicket({ ...(await json(request)), actor: device.id }) }); }
      if (request.method === 'POST' && url.pathname === '/v1/tickets/claim-next') { requireKind(device, 'worker'); const body = await json(request); const claim = await store.claimNext(sessionClaim(request, body, device)); return send(response, claim ? 200 : 204, claim ?? undefined); }
      if (request.method === 'GET' && url.pathname === '/v1/tickets/next') { requireKind(device, 'worker'); const ticket = await store.next({ device: device.id }); return send(response, ticket ? 200 : 204, ticket ? { ticket } : undefined); }
      if (request.method === 'GET' && url.pathname === '/v1/events') { if (device.kind === 'worker') { const ticketId = url.searchParams.get('ticket'); if (!ticketId || !(await store.canDeviceReadTicket(device.id, ticketId))) throw new DomainError(403, 'ticket_forbidden', 'worker may read events only for assigned tickets'); } return send(response, 200, await store.listEvents({ project: url.searchParams.get('project'), ticket: url.searchParams.get('ticket'), after: Number(url.searchParams.get('after') ?? 0) })); }
      if ((match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/tickets$/)) && request.method === 'GET') { if (url.searchParams.has('assignee_type') || url.searchParams.has('assignee_id')) throw new DomainError(400, 'invalid_ticket_filter', 'role or device assignment filters are not supported'); const options = { includeArchived: url.searchParams.get('include_archived') === 'true' }; const project = decodeURIComponent(match[1]); return send(response, 200, { tickets: device.kind === 'coordinator' ? await store.listTickets(project, options) : await store.listTicketsForDevice(project, device.id, options) }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)$/)) && request.method === 'GET') { const id = decodeURIComponent(match[1]); if (!(await store.canDeviceReadTicket(device.id, id))) throw new DomainError(403, 'ticket_forbidden', 'worker may read only assigned tickets'); return send(response, 200, { ticket: await store.getTicket(id) }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)$/)) && request.method === 'PATCH') { requireAdmin(device); return send(response, 200, { ticket: await store.editTicket(decodeURIComponent(match[1]), { ...(await json(request)), actor: device.id }) }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/state$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 200, { ticket: await store.setTicketState(decodeURIComponent(match[1]), { ...(await json(request)), actor: device.id }) }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/board-position$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 200, { ticket: await store.moveHumanTicket(decodeURIComponent(match[1]), { ...(await json(request)), actor: device.id }) }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/notes$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 201, await store.appendTicketEvent(decodeURIComponent(match[1]), { ...(await json(request)), actor: device.id })); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/(archive|restore|delete)$/)) && request.method === 'POST') { requireAdmin(device); const body = { ...(await json(request)), actor: device.id }; const id = decodeURIComponent(match[1]); const ticket = match[2] === 'archive' ? await store.archiveTicket(id, body) : match[2] === 'restore' ? await store.restoreTicket(id, body) : await store.deleteTicket(id, body); return send(response, 200, { ticket }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/blocks$/)) && request.method === 'GET') { const id = decodeURIComponent(match[1]); if (!(await store.canDeviceReadTicket(device.id, id))) throw new DomainError(403, 'ticket_forbidden', 'worker may read only assigned tickets'); return send(response, 200, await store.listBlocks(id, { status: url.searchParams.get('status') ?? undefined })); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/blocks\/([^/]+)\/resolve$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 200, await store.resolveBlock(decodeURIComponent(match[1]), decodeURIComponent(match[2]), { actor: device.id })); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/questions$/)) && request.method === 'GET') { const id = decodeURIComponent(match[1]); if (!(await store.canDeviceReadTicket(device.id, id))) throw new DomainError(403, 'ticket_forbidden', 'worker may read only assigned tickets'); return send(response, 200, await store.listQuestions(id, { status: url.searchParams.get('status') ?? undefined })); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/human-questions$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 201, await store.askHumanQuestion(decodeURIComponent(match[1]), { ...(await json(request)), actor: device.id })); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/questions$/)) && request.method === 'POST') { requireKind(device, 'worker'); return send(response, 201, await store.askQuestion(decodeURIComponent(match[1]), claimIdentity(request, await json(request), device))); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/questions\/([^/]+)\/answer$/)) && request.method === 'POST') { requireAdmin(device); return send(response, 200, await store.answerQuestion(decodeURIComponent(match[1]), decodeURIComponent(match[2]), { ...(await json(request)), actor: device.id })); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/(claim|verify|release|events|block|submit|accept|reopen)$/)) && request.method === 'POST') {
        const id = decodeURIComponent(match[1]); const action = match[2]; const body = await json(request);
        if (action === 'claim') { requireKind(device, 'worker'); return send(response, 200, await store.claim(id, sessionClaim(request, body, device))); }
        if (action === 'verify') { requireKind(device, 'worker'); return send(response, 200, { ticket: await store.verify(id, claimIdentity(request, body, device)) }); }
        if (action === 'release') { requireKind(device, 'worker'); return send(response, 200, { ticket: await store.release(id, claimIdentity(request, body, device)) }); }
        if (action === 'events') { requireKind(device, 'worker'); return send(response, 201, await store.postEvent(id, claimIdentity(request, body, device))); }
        if (action === 'block') { requireKind(device, 'worker'); return send(response, 201, await store.blockTicket(id, claimIdentity(request, body, device))); }
        if (action === 'submit') { requireKind(device, 'worker'); return send(response, 200, await store.submit(id, claimIdentity(request, body, device))); }
        requireAdmin(device);
        if (action === 'accept') return send(response, 200, { ticket: await store.accept(id, { actor: device.id, message: body.message }) });
        if (action === 'reopen') return send(response, 200, { ticket: await store.reopen(id, { actor: device.id, message: body.message }) });
      }
      throw new DomainError(404, 'route_not_found', 'route not found');
    } catch (error) { if (error instanceof DomainError) return send(response, error.status, { error: { code: error.code, message: error.message } }); console.error(error); return send(response, 500, { error: { code: 'internal_error', message: 'internal server error' } }); }
  });
  server.on('close', () => { store.close().catch(() => {}); }); return server;
}
export async function runServer({ storage, host = '127.0.0.1', port = 7373 } = {}) { const server = await createApp({ storage }); server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ event: 'listening', url: `http://${host}:${port}`, storage })}\n`)); return server; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const options = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key.replaceAll('-', '_'), rest.join('=')]; })); await runServer({ storage: options.storage ?? process.env.VIQ_STORAGE ?? './viqueue.sqlite', host: options.host ?? process.env.VIQ_HOST ?? '127.0.0.1', port: Number(options.port ?? process.env.VIQ_PORT ?? 7373) }); }
