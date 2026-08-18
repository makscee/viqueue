import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/server.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-http-'));
  const app = await createApp({ storage: path.join(dir, 'data.sqlite'), operatorToken: 'secret' });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.address().port}` };
}

async function request(base, method, route, body, auth = false) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer secret' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const identity = (claim) => ({ claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, generation: claim.ticket.claim.generation, claim_token: claim.claim_token });

test('HTTP exposes the complete canonical lifecycle and event polling', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  assert.equal((await request(base, 'POST', '/v1/projects', { key: 'ABC' })).status, 201);
  for (const [id,kind] of [['worker-a','agent'],['maks','human']]) assert.equal((await request(base,'POST','/v1/actors',{id,name:id,kind},true)).status,201);
  const created = await request(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'HTTP tracer', body: 'details' });
  assert.equal(created.body.ticket.state, 'open');
  assert.equal((await request(base, 'GET', '/v1/tickets/next?project=ABC')).body.ticket.id, 'ABC-1');
  const claim = await request(base, 'POST', '/v1/tickets/ABC-1/claim', { actor: 'worker-a' });
  assert.equal(claim.status, 200);
  const credentials = identity(claim.body);
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/verify', credentials)).status, 200);
  const progress = await request(base, 'POST', '/v1/tickets/ABC-1/events', { ...credentials, message: 'working' });
  assert.equal(progress.body.event.type, 'progress');
  const events = await request(base, 'GET', `/v1/events?project=ABC&after=${progress.body.cursor - 1}`);
  assert.deepEqual(events.body.events.map((event) => event.message), ['working']);
  const submitted = await request(base, 'POST', '/v1/tickets/ABC-1/submit', { ...credentials, reviewer:{type:'actor',id:'maks'}, message: 'done' });
  assert.equal(submitted.body.ticket.state, 'review');
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/accept', { actor: 'maks' })).body.ticket.state, 'done');
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/reopen', { actor: 'maks' }, true)).body.ticket.state, 'open');
});

test('HTTP release and authorized takeover preserve fencing', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  await request(base, 'POST', '/v1/projects', { key: 'ABC' });
  for (const id of ['a','b']) await request(base,'POST','/v1/actors',{id,name:id,kind:'agent'},true);
  await request(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'claim' });
  const old = await request(base, 'POST', '/v1/tickets/ABC-1/claim', { actor: 'a' });
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/takeover', { actor: 'b' })).status, 403);
  const current = await request(base, 'POST', '/v1/tickets/ABC-1/takeover', { actor: 'b' }, true);
  assert.equal(current.body.ticket.claim.generation, 2);
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/release', identity(old.body))).body.error.code, 'stale_claim');
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/release', identity(current.body))).body.ticket.claim, null);
});

test('HTTP exposes human ticket history edits, state, archive, restore, notes, and confirmed delete', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  for (const key of ['ABC', 'XYZ']) await request(base, 'POST', '/v1/projects', { key });
  for (const [id, kind] of [['maks', 'human'], ['worker', 'agent']]) await request(base, 'POST', '/v1/actors', { id, name: id, kind }, true);
  await request(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'History', assignee: { type: 'actor', id: 'worker' } });
  const edited = await request(base, 'PATCH', '/v1/tickets/ABC-1', { project: 'XYZ', title: 'Edited', body: '**body**', assignee: null, actor: 'maks' });
  assert.equal(edited.body.ticket.project, 'XYZ');
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/state', { state: 'done', actor: 'maks' })).body.ticket.state, 'done');
  assert.equal((await request(base, 'POST', '/v1/tickets/ABC-1/notes', { message: 'Human note', actor: 'maks' })).body.event.actor, 'maks');
  await request(base, 'POST', '/v1/tickets/ABC-1/archive', { actor: 'maks' });
  assert.equal((await request(base, 'GET', '/v1/projects/XYZ/tickets?include_archived=true')).body.tickets.length, 1);
  await request(base, 'POST', '/v1/tickets/ABC-1/restore', { actor: 'maks' });
  for (const confirmed of [undefined, false, null, 0, 1, 'true', [], {}]) {
    const rejected = await request(base, 'POST', '/v1/tickets/ABC-1/delete', { actor: 'maks', ...(confirmed === undefined ? {} : { confirmed }) });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, 'delete_confirmation_required');
    assert.equal((await request(base, 'GET', '/v1/tickets/ABC-1')).body.ticket.deleted_at, null);
  }
  assert.ok((await request(base, 'POST', '/v1/tickets/ABC-1/delete', { actor: 'maks', confirmed: true })).body.ticket.deleted_at);
});

test('HTTP ticket edits fail closed without an active actor and persist canonical provenance', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  await request(base, 'POST', '/v1/projects', { key: 'ABC' });
  await request(base, 'POST', '/v1/actors', { id: 'maks', name: 'Maks', kind: 'human' }, true);
  await request(base, 'POST', '/v1/actors', { id: 'inactive', name: 'Inactive', kind: 'human' }, true);
  await request(base, 'POST', '/v1/actors/inactive/deactivate', {}, true);
  await request(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'Original' });
  for (const [body, code] of [[{ title: 'Missing' }, 'actor_not_found'], [{ title: 'Unknown', actor: 'unknown' }, 'actor_not_found'], [{ title: 'Inactive', actor: 'inactive' }, 'actor_inactive']]) {
    const rejected = await request(base, 'PATCH', '/v1/tickets/ABC-1', body);
    assert.equal(rejected.body.error.code, code);
  }
  assert.equal((await request(base, 'GET', '/v1/tickets/ABC-1')).body.ticket.title, 'Original');
  assert.equal((await request(base, 'PATCH', '/v1/tickets/ABC-1', { title: 'Edited', actor: 'Maks' })).status, 200);
  const events = (await request(base, 'GET', '/v1/events?ticket=ABC-1')).body.events;
  assert.equal(events.find((event) => event.type === 'ticket_edited').actor, 'maks');
});

test('HTTP edits minimal ticket fields and rejects malformed JSON', async (t) => {
  const { app, base } = await fixture(); t.after(() => app.close());
  await request(base, 'POST', '/v1/projects', { key: 'ABC' });
  await request(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'old' });
  await request(base,'POST','/v1/actors',{id:'eva',name:'Eva',kind:'human'},true);
  const edited = await request(base, 'PATCH', '/v1/tickets/ABC-1', { title: 'new', body: 'body', assigned_to: 'eva', actor: 'eva' });
  assert.equal(edited.body.ticket.assigned_to, 'eva');
  const malformed = await fetch(`${base}/v1/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'invalid_json');
});
