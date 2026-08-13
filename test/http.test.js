import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/server.js';

async function appFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-http-'));
  let now = 1_700_000_000_000;
  const app = await createApp({ storage: path.join(dir, 'data.json'), takeoverToken: 'secret', now: () => now });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { app, base, advance: (ms) => { now += ms; } };
}

async function request(base, method, route, body, headers = {}) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('HTTP JSON API runs the claim-expiry-takeover-fencing contract', async (t) => {
  const { app, base, advance } = await appFixture();
  t.after(() => app.close());

  assert.equal((await request(base, 'POST', '/v1/projects', { key: 'ABC' })).status, 201);
  const created = await request(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'HTTP tracer' });
  assert.equal(created.body.ticket.id, 'ABC-1');
  assert.equal((await request(base, 'GET', '/v1/tickets/next?actor=worker-a')).body.ticket.id, 'ABC-1');

  const old = await request(base, 'POST', '/v1/tickets/ABC-1/claim', { actor: 'worker-a', ttl_ms: 100 });
  assert.equal(old.status, 200);
  assert.equal((await request(base, 'GET', '/v1/tickets/next?actor=worker-b')).status, 204);
  const renewed = await request(base, 'POST', '/v1/tickets/ABC-1/renew', {
    actor: 'worker-a', claim_token: old.body.claim_token, generation: 1, ttl_ms: 200
  });
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.ticket.claim.generation, 1);

  advance(201);
  assert.equal((await request(base, 'GET', '/v1/tickets/next?actor=worker-b')).status, 204);
  assert.equal((await request(base, 'GET', '/v1/tickets/ABC-1')).body.ticket.state, 'stale');

  assert.deepEqual(await request(base, 'POST', '/v1/tickets/ABC-1/takeover', { actor: 'worker-b', ttl_ms: 1000 }), {
    status: 403, body: { error: { code: 'takeover_forbidden', message: 'valid takeover authorization is required' } }
  });
  const takeover = await request(base, 'POST', '/v1/tickets/ABC-1/takeover',
    { actor: 'worker-b', ttl_ms: 1000 }, { authorization: 'Bearer secret' });
  assert.equal(takeover.body.ticket.claim.generation, 2);

  const fenced = await request(base, 'PATCH', '/v1/tickets/ABC-1', {
    actor: 'worker-a', claim_token: old.body.claim_token, generation: 1,
    status: 'submitted', evidence: 'old result'
  });
  assert.equal(fenced.status, 409);
  assert.equal(fenced.body.error.code, 'stale_claim');

  const submitted = await request(base, 'PATCH', '/v1/tickets/ABC-1', {
    actor: 'worker-b', claim_token: takeover.body.claim_token, generation: 2,
    status: 'submitted', evidence: { test: 'green' }
  });
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.body.ticket.evidence, { test: 'green' });
});

test('HTTP errors are stable JSON and malformed JSON is rejected', async (t) => {
  const { app, base } = await appFixture();
  t.after(() => app.close());
  const missing = await request(base, 'GET', '/v1/tickets/NOPE-1');
  assert.deepEqual(missing, { status: 404, body: { error: { code: 'ticket_not_found', message: 'ticket NOPE-1 not found' } } });
  const response = await fetch(`${base}/v1/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_json');
});
