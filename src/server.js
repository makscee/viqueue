import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, DomainError } from './store.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/ui-core.js': ['ui-core.js', 'text/javascript; charset=utf-8'] };
const send = (response, status, body) => { response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(body === undefined ? '' : `${JSON.stringify(body)}\n`); };
async function json(request) { let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw new DomainError(413, 'body_too_large', 'request body exceeds 1MB'); } try { return raw ? JSON.parse(raw) : {}; } catch { throw new DomainError(400, 'invalid_json', 'request body must be valid JSON'); } }
const authorize = (request, token) => { if (!token || request.headers.authorization !== `Bearer ${token}`) throw new DomainError(403, 'operator_forbidden', 'valid local operator authorization is required'); };

export async function createApp({ storage, operatorToken, now } = {}) {
  const store = new Store(storage ?? './viqueue.sqlite', { now }); await store.init(); const localToken = operatorToken;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'); let match;
      if (request.method === 'GET' && assets[url.pathname]) { const [file, contentType] = assets[url.pathname]; response.statusCode = 200; response.setHeader('content-type', contentType); response.setHeader('cache-control', 'no-store'); response.end(await readFile(path.join(webRoot, file))); return; }
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/v1/actors') return send(response, 200, { actors: await store.listActors({ active: url.searchParams.has('active') ? url.searchParams.get('active') !== 'false' : undefined }) });
      if (request.method === 'POST' && url.pathname === '/v1/actors') { authorize(request, localToken); return send(response, 201, { actor: await store.createActor(await json(request)) }); }
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)$/)) && request.method === 'GET') return send(response, 200, { actor: await store.getActor(decodeURIComponent(match[1])) });
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)$/)) && request.method === 'PATCH') { authorize(request, localToken); return send(response, 200, { actor: await store.updateActor(decodeURIComponent(match[1]), await json(request)) }); }
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)\/deactivate$/)) && request.method === 'POST') { authorize(request, localToken); return send(response, 200, { actor: await store.deactivateActor(decodeURIComponent(match[1])) }); }
      if (request.method === 'GET' && url.pathname === '/v1/roles') return send(response, 200, { roles: await store.listRoles() });
      if (request.method === 'POST' && url.pathname === '/v1/roles') { authorize(request, localToken); return send(response, 201, { role: await store.createRole(await json(request)) }); }
      if ((match = url.pathname.match(/^\/v1\/roles\/([^/]+)\/actors$/)) && request.method === 'GET') return send(response, 200, await store.listRoleActors(decodeURIComponent(match[1])));
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)\/roles$/)) && request.method === 'GET') return send(response, 200, await store.listActorRoles(decodeURIComponent(match[1])));
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)\/roles\/([^/]+)$/)) && request.method === 'PUT') { authorize(request, localToken); return send(response, 200, { membership: await store.grantRole(decodeURIComponent(match[1]), decodeURIComponent(match[2])) }); }
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)\/roles\/([^/]+)$/)) && request.method === 'DELETE') { authorize(request, localToken); return send(response, 200, { membership: await store.revokeRole(decodeURIComponent(match[1]), decodeURIComponent(match[2])) }); }
      if ((match = url.pathname.match(/^\/v1\/actors\/([^/]+)\/inbox$/)) && request.method === 'GET') return send(response, 200, await store.actorInbox(decodeURIComponent(match[1]), { after: Number(url.searchParams.get('after') ?? 0) }));
      if (request.method === 'GET' && url.pathname === '/v1/projects') return send(response, 200, { projects: await store.listProjects() });
      if (request.method === 'POST' && url.pathname === '/v1/projects') return send(response, 201, { project: await store.createProject((await json(request)).key) });
      if (request.method === 'POST' && url.pathname === '/v1/tickets') return send(response, 201, { ticket: await store.createTicket(await json(request)) });
      if (request.method === 'POST' && url.pathname === '/v1/tickets/claim-next') { const claim = await store.claimNext(await json(request)); return send(response, claim ? 200 : 204, claim ?? undefined); }
      if (request.method === 'GET' && url.pathname === '/v1/tickets/next') { const ticket = await store.next({ project: url.searchParams.get('project'), actor: url.searchParams.get('actor') }); return send(response, ticket ? 200 : 204, ticket ? { ticket } : undefined); }
      if (request.method === 'GET' && url.pathname === '/v1/events') return send(response, 200, await store.listEvents({ project: url.searchParams.get('project'), ticket: url.searchParams.get('ticket'), after: Number(url.searchParams.get('after') ?? 0) }));
      if ((match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/tickets$/)) && request.method === 'GET') return send(response, 200, { tickets: await store.listTickets(decodeURIComponent(match[1]), { assigneeType: url.searchParams.get('assignee_type') ?? undefined, assigneeId: url.searchParams.get('assignee_id') ?? undefined, includeArchived: url.searchParams.get('include_archived') === 'true' }) });
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)$/)) && request.method === 'GET') return send(response, 200, { ticket: await store.getTicket(decodeURIComponent(match[1])) });
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)$/)) && request.method === 'PATCH') return send(response, 200, { ticket: await store.editTicket(decodeURIComponent(match[1]), await json(request)) });
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/state$/)) && request.method === 'POST') return send(response, 200, { ticket: await store.setTicketState(decodeURIComponent(match[1]), await json(request)) });
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/notes$/)) && request.method === 'POST') return send(response, 201, await store.appendTicketEvent(decodeURIComponent(match[1]), await json(request)));
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/(archive|restore|delete)$/)) && request.method === 'POST') { const body = await json(request); const id = decodeURIComponent(match[1]); const ticket = match[2] === 'archive' ? await store.archiveTicket(id, body) : match[2] === 'restore' ? await store.restoreTicket(id, body) : await store.deleteTicket(id, body); return send(response, 200, { ticket }); }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/questions$/)) && request.method === 'GET') return send(response, 200, await store.listQuestions(decodeURIComponent(match[1]), { status: url.searchParams.get('status') ?? undefined }));
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/human-questions$/)) && request.method === 'POST') return send(response, 201, await store.askHumanQuestion(decodeURIComponent(match[1]), await json(request)));
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/questions$/)) && request.method === 'POST') return send(response, 201, await store.askQuestion(decodeURIComponent(match[1]), await json(request)));
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/questions\/([^/]+)\/answer$/)) && request.method === 'POST') return send(response, 200, await store.answerQuestion(decodeURIComponent(match[1]), decodeURIComponent(match[2]), await json(request)));
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/(claim|verify|release|takeover|events|submit|accept|reopen)$/)) && request.method === 'POST') {
        const id = decodeURIComponent(match[1]); const action = match[2]; const body = await json(request);
        if (['takeover', 'reopen'].includes(action)) authorize(request, localToken);
        if (action === 'claim') return send(response, 200, await store.claim(id, body));
        if (action === 'verify') return send(response, 200, { ticket: await store.verify(id, body) });
        if (action === 'release') return send(response, 200, { ticket: await store.release(id, body) });
        if (action === 'takeover') return send(response, 200, await store.takeover(id, body));
        if (action === 'events') return send(response, 201, await store.postEvent(id, body));
        if (action === 'submit') return send(response, 200, await store.submit(id, body));
        if (action === 'accept') return send(response, 200, { ticket: await store.accept(id, body) });
        if (action === 'reopen') return send(response, 200, { ticket: await store.reopen(id, body) });
      }
      throw new DomainError(404, 'route_not_found', 'route not found');
    } catch (error) { if (error instanceof DomainError) return send(response, error.status, { error: { code: error.code, message: error.message } }); console.error(error); return send(response, 500, { error: { code: 'internal_error', message: 'internal server error' } }); }
  });
  server.on('close', () => { store.close().catch(() => {}); }); return server;
}
export async function runServer({ storage, host = '127.0.0.1', port = 7373, operatorToken } = {}) { const server = await createApp({ storage, operatorToken }); server.listen(port, host, () => process.stdout.write(`${JSON.stringify({ event: 'listening', url: `http://${host}:${port}`, storage })}\n`)); return server; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const options = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key.replaceAll('-', '_'), rest.join('=')]; })); await runServer({ storage: options.storage ?? process.env.VIQ_STORAGE ?? './viqueue.sqlite', host: options.host ?? process.env.VIQ_HOST ?? '127.0.0.1', port: Number(options.port ?? process.env.VIQ_PORT ?? 7373), operatorToken: options.operator_token ?? process.env.VIQ_OPERATOR_TOKEN }); }
