import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, DomainError } from './store.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

const send = (response, status, body) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(body === undefined ? '' : `${JSON.stringify(body)}\n`);
};

async function json(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new DomainError(413, 'body_too_large', 'request body exceeds 1MB');
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw new DomainError(400, 'invalid_json', 'request body must be valid JSON'); }
}

export async function createApp({ storage, takeoverToken, now } = {}) {
  const store = new Store(storage ?? './viqueue.json', { now });
  await store.init();
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let match;
      if (request.method === 'GET' && assets[url.pathname]) {
        const [file, contentType] = assets[url.pathname];
        response.statusCode = 200; response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'no-store'); response.end(await readFile(path.join(webRoot, file))); return;
      }
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { ok: true });
      if (request.method === 'GET' && url.pathname === '/v1/projects') {
        return send(response, 200, { projects: await store.listProjects() });
      }
      if (request.method === 'POST' && url.pathname === '/v1/projects') {
        return send(response, 201, { project: await store.createProject((await json(request)).key) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/tickets') {
        return send(response, 201, { ticket: await store.createTicket(await json(request)) });
      }
      if ((match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/tickets$/)) && request.method === 'GET') {
        return send(response, 200, { tickets: await store.listTickets(decodeURIComponent(match[1])) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/tickets/next') {
        const ticket = await store.next(url.searchParams.get('actor'));
        return send(response, ticket ? 200 : 204, ticket ? { ticket } : undefined);
      }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)$/)) && request.method === 'GET') {
        return send(response, 200, { ticket: await store.getTicket(decodeURIComponent(match[1])) });
      }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/claim$/)) && request.method === 'POST') {
        return send(response, 200, await store.claim(decodeURIComponent(match[1]), await json(request)));
      }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/renew$/)) && request.method === 'POST') {
        return send(response, 200, await store.renew(decodeURIComponent(match[1]), await json(request)));
      }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)\/takeover$/)) && request.method === 'POST') {
        if (!takeoverToken || request.headers.authorization !== `Bearer ${takeoverToken}`) {
          throw new DomainError(403, 'takeover_forbidden', 'valid takeover authorization is required');
        }
        return send(response, 200, await store.takeover(decodeURIComponent(match[1]), await json(request)));
      }
      if ((match = url.pathname.match(/^\/v1\/tickets\/([^/]+)$/)) && request.method === 'PATCH') {
        return send(response, 200, { ticket: await store.update(decodeURIComponent(match[1]), await json(request)) });
      }
      throw new DomainError(404, 'route_not_found', 'route not found');
    } catch (error) {
      if (error instanceof DomainError) return send(response, error.status, { error: { code: error.code, message: error.message } });
      console.error(error);
      return send(response, 500, { error: { code: 'internal_error', message: 'internal server error' } });
    }
  });
}

export async function runServer({ storage, host = '127.0.0.1', port = 7373, takeoverToken } = {}) {
  const server = await createApp({ storage, takeoverToken });
  server.listen(port, host, () => {
    process.stdout.write(`${JSON.stringify({ event: 'listening', url: `http://${host}:${port}`, storage })}\n`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key.replaceAll('-', '_'), rest.join('=')];
  }));
  await runServer({
    storage: options.storage ?? process.env.VIQ_STORAGE ?? './viqueue.json',
    host: options.host ?? process.env.VIQ_HOST ?? '127.0.0.1',
    port: Number(options.port ?? process.env.VIQ_PORT ?? 7373),
    takeoverToken: options.takeover_token ?? process.env.VIQ_TAKEOVER_TOKEN
  });
}
