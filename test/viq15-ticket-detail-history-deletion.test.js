import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq15-detail-')), file = path.join(dir, 'data.sqlite');
  const store = new Store(file); await store.init();
  const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  await store.createProject('ABC');
  const pairing = await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'worker', device_id: 'worker-box', device_name: 'Named worker' }).catch(async () => {
    await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' });
    return store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'worker', device_id: 'worker-box', device_name: 'Named worker' });
  });
  const worker = await store.pairDevice({ code: pairing.code }); await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return { app, file, base: `http://127.0.0.1:${app.address().port}`, coordinator: coordinator.credential, worker: worker.credential };
}
async function call(f, token, method, route, body, capability) {
  const response = await fetch(`${f.base}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(capability ? { 'x-viq-session-capability': capability } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('VIQ-15 immutable detail, shared factual-event provenance, stable history, and permanent deletion', async (t) => {
  const f = await fixture(); t.after(() => f.app.close());
  await call(f, f.coordinator, 'POST', '/v1/tickets', { project: 'ABC', title: 'Original', description: 'Body', assignment: 'Agent' });
  const immutable = await call(f, f.coordinator, 'PATCH', '/v1/tickets/ABC-1', { project: 'OTHER', state: 'Done' });
  assert.equal(immutable.status, 400); assert.equal(immutable.body.error.code, 'immutable_project');
  const edited = await call(f, f.coordinator, 'PATCH', '/v1/tickets/ABC-1', { title: 'Edited', description: 'New body', assignment: 'Agent' });
  assert.deepEqual([edited.body.ticket.id, edited.body.ticket.project, edited.body.ticket.state], ['ABC-1', 'ABC', 'Open']);
  const human = await call(f, f.coordinator, 'POST', '/v1/tickets/ABC-1/notes', { message: 'human fact', actor_role: 'spoof', machine: 'spoof' });
  assert.equal(human.body.event.actor, 'coord'); assert.equal(human.body.event.machine, 'Coordinator'); assert.equal(human.body.event.actor_role, null);
  const stableHuman = (await call(f, f.coordinator, 'GET', '/v1/tickets/ABC-1/history?limit=100')).body.events.find((event) => event.cursor === human.body.event.cursor);
  assert.equal(stableHuman.machine, 'Coordinator'); assert.equal(stableHuman.actor_role, null);
  const session = await call(f, f.worker, 'POST', '/v1/sessions', {});
  const claimed = await call(f, f.worker, 'POST', '/v1/tickets/ABC-1/claim', {}, session.body.session_capability);
  const fence = { claim_id: claimed.body.ticket.claim.claim_id, generation: claimed.body.ticket.claim.generation, claim_token: claimed.body.claim_token };
  const agent = await call(f, f.worker, 'POST', '/v1/tickets/ABC-1/events', { ...fence, message: 'agent fact', actor_role: 'spoof', machine: 'spoof' }, session.body.session_capability);
  assert.equal(agent.body.event.actor, 'worker'); assert.equal(agent.body.event.machine, 'Named worker'); assert.notEqual(agent.body.event.actor_role, 'spoof');
  const stale = await call(f, f.worker, 'POST', '/v1/tickets/ABC-1/events', { ...fence, generation: fence.generation + 1, message: 'bad' }, session.body.session_capability);
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale_claim');
  const asked = await call(f, f.worker, 'POST', '/v1/tickets/ABC-1/questions', { ...fence, text: 'Durable question?', target_type: 'actor', target_id: 'coord' }, session.body.session_capability);
  await call(f, f.coordinator, 'POST', `/v1/tickets/ABC-1/questions/${asked.body.question.id}/answer`, { answer: 'Durable answer' });
  await call(f, f.worker, 'POST', '/v1/tickets/ABC-1/submit', { ...fence, reviewer: { type: 'actor', id: 'coord' }, message: 'Durable submission' }, session.body.session_capability);
  for (let index = 0; index < 30; index++) await call(f, f.coordinator, 'POST', '/v1/tickets/ABC-1/notes', { message: `fact ${index}` });
  const newest = await call(f, f.coordinator, 'GET', '/v1/tickets/ABC-1/history?limit=10');
  const older = await call(f, f.coordinator, 'GET', `/v1/tickets/ABC-1/history?limit=100&before=${newest.body.next_before}`);
  const cursors = [...older.body.events, ...newest.body.events].map((event) => event.cursor);
  assert.deepEqual(cursors, [...new Set(cursors)].sort((a, b) => a - b));
  const beforeDelete = await call(f, f.coordinator, 'GET', '/v1/events?after=0');
  const ticketCursors = beforeDelete.body.events.filter((event) => event.ticket_id === 'ABC-1').map((event) => event.cursor);
  assert.ok(ticketCursors.length > 0);
  assert.equal((await call(f, f.coordinator, 'POST', '/v1/tickets/ABC-1/delete', { confirmed: false })).status, 409);
  assert.equal((await call(f, f.worker, 'POST', '/v1/tickets/ABC-1/delete', { confirmed: true })).status, 403);
  const removed = await call(f, f.coordinator, 'POST', '/v1/tickets/ABC-1/delete', { confirmed: true }); assert.equal(removed.status, 200);
  for (const route of ['/v1/tickets/ABC-1', '/v1/tickets/ABC-1/history', '/v1/events?ticket=ABC-1']) assert.equal((await call(f, f.coordinator, 'GET', route)).status, 404);
  assert.equal((await call(f, f.coordinator, 'PATCH', '/v1/tickets/ABC-1', { title: 'Zombie' })).body.error.code, 'ticket_deleted');
  const next = await call(f, f.coordinator, 'POST', '/v1/tickets', { project: 'ABC', title: 'Next', assignment: 'Human' }); assert.equal(next.body.ticket.id, 'ABC-2');
  const unrelated = await call(f, f.coordinator, 'POST', '/v1/tickets/ABC-2/notes', { message: 'unrelated survives' });
  await call(f, f.coordinator, 'POST', '/v1/roles', { id: 'global-after', name: 'Global after' });
  for (const route of ['/v1/events?after=0', '/v1/events?project=ABC&after=0', ...ticketCursors.map((cursor) => `/v1/events?after=${cursor}`)]) {
    const projection = await call(f, f.coordinator, 'GET', route); assert.equal(projection.status, 200);
    assert.equal(projection.body.events.some((event) => event.ticket_id === 'ABC-1'), false, route);
    assert.deepEqual(projection.body.events.map((event) => event.cursor), projection.body.events.map((event) => event.cursor).toSorted((a, b) => a - b));
  }
  const afterDelete = await call(f, f.coordinator, 'GET', '/v1/events?after=0');
  assert.ok(afterDelete.body.events.some((event) => event.cursor === unrelated.body.event.cursor));
  assert.ok(afterDelete.body.events.some((event) => event.ticket_id === null && event.type === 'device_bootstrapped'));
  await new Promise((resolve) => f.app.close(resolve));
  const db = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ticket_tombstones WHERE ticket_id=?').get('ABC-1').n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE ticket_id=? AND type='deleted'").get('ABC-1').n, 1);
  for (const type of ['ticket_created', 'progress', 'question_asked', 'question_answered', 'submitted', 'deleted']) assert.ok(db.prepare('SELECT COUNT(*) n FROM events WHERE ticket_id=? AND type=?').get('ABC-1', type).n > 0, type);
  const eventCount = db.prepare('SELECT COUNT(*) n FROM events WHERE ticket_id=?').get('ABC-1').n; db.close();
  const mutable = new DatabaseSync(f.file);
  assert.throws(() => mutable.prepare("UPDATE events SET message='tampered' WHERE ticket_id='ABC-1'").run(), /events are immutable/);
  assert.throws(() => mutable.prepare("DELETE FROM events WHERE ticket_id='ABC-1'").run(), /events are immutable/);
  assert.equal(mutable.prepare('SELECT COUNT(*) n FROM events WHERE ticket_id=?').get('ABC-1').n, eventCount);
  assert.equal(mutable.prepare('SELECT next_number FROM projects WHERE key=?').get('ABC').next_number, 3); mutable.close();
});
