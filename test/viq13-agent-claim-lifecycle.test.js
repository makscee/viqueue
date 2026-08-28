import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { ViqWorkerRuntime } from '../extensions/viq-worker/worker-runtime.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq13-')); const file = path.join(dir, 'data.sqlite');
  const store = new Store(file); await store.init();
  const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  await store.createActor({ id: 'agent-a', name: 'Agent A', kind: 'agent' });
  await store.createActor({ id: 'agent-b', name: 'Agent B', kind: 'agent' });
  const pair = async (actor, id, name) => store.pairDevice({ ...(await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: actor, device_id: id, device_name: name })), id, name });
  const a = await pair('agent-a', 'machine-a', 'Tower A'); const b = await pair('agent-b', 'machine-b', 'Tower B');
  await store.createProject('AAA'); await store.createProject('ZZZ');
  return { store, file, coordinator, a, b };
}
const authority = (claim, session_capability) => ({ claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, device: claim.ticket.claim.device_id, generation: claim.ticket.claim.generation, claim_token: claim.claim_token, session_capability });

test('VIQ-13 Store claims fail closed without pre-existing session authority and do not mutate tickets', async () => {
  const { store, file, a, b } = await fixture();
  const ticket = await store.createTicket({ project: 'AAA', title: 'session required', assignment: 'Agent' });
  const session = await store.openWorkerSession(a.device.id);
  const revoked = await store.openWorkerSession(a.device.id);
  const wrongMachine = await store.openWorkerSession(b.device.id);
  await store.closeWorkerSession(a.device.id, revoked.session_capability);
  const snapshot = async () => {
    const db = new DatabaseSync(file, { readOnly: true });
    const counts = {
      claims: db.prepare('SELECT COUNT(*) count FROM claims').get().count,
      events: db.prepare('SELECT COUNT(*) count FROM events').get().count,
      sessions: db.prepare('SELECT COUNT(*) count FROM worker_sessions').get().count
    };
    db.close();
    return { ticket: await store.getTicket(ticket.id), counts };
  };
  const before = await snapshot();
  for (const attempt of [
    () => store.claim(ticket.id, { device: a.device.id }),
    () => store.claimNext({ device: a.device.id }),
    () => store.claim(ticket.id, { actor: a.device.id }),
    () => store.claimNext({ actor: a.device.id, session_capability: 'ps_chosen.not-server-issued' }),
    () => store.claim(ticket.id, { device: a.device.id, session_capability: wrongMachine.session_capability }),
    () => store.claimNext({ device: a.device.id, session_capability: revoked.session_capability })
  ]) {
    await assert.rejects(attempt(), (error) => error.code === 'session_unauthorized');
    assert.deepEqual(await snapshot(), before);
  }
  const claim = await store.claim(ticket.id, { device: a.device.id, session_capability: session.session_capability });
  assert.equal(claim.ticket.state, 'Working');
  assert.equal(claim.ticket.claim.session_id, session.session_id);
  assert.equal('session_capability' in claim, false);
  assert.deepEqual((await snapshot()).counts, { claims: 1, events: before.counts.events + 1, sessions: before.counts.sessions });
  await store.close();
});

test('VIQ-13 atomically claims authoritative first eligible Agent Open ticket and records machine/session provenance', async () => {
  const { store, a } = await fixture();
  await store.createTicket({ project: 'AAA', title: 'older agent', assignment: 'Agent' });
  await store.createTicket({ project: 'AAA', title: 'skip human', assignment: 'Human' });
  await store.createTicket({ project: 'ZZZ', title: 'first eligible globally', assignment: 'Agent' });
  await store.createTicket({ project: 'ZZZ', title: 'skip unassigned' });
  const before = await store.listBoardTickets();
  const sessionA = await store.openWorkerSession(a.device.id);
  const claim = await store.claimNext({ device: a.device.id, session_capability: sessionA.session_capability });
  assert.equal(claim.ticket.id, 'ZZZ-1');
  assert.equal(claim.ticket.state, 'Working'); assert.equal(claim.ticket.assignment, 'Agent');
  assert.deepEqual({ device_id: claim.ticket.claim.device_id, machine: claim.ticket.claim.machine, session_id: claim.ticket.claim.session_id }, { device_id: 'machine-a', machine: 'Tower A', session_id: sessionA.session_id });
  for (const id of ['AAA-2', 'ZZZ-2']) assert.deepEqual(await store.getTicket(id), before.find((ticket) => ticket.id === id));
  await store.close();
});

test('VIQ-13 concurrent stores cannot share or bypass the highest eligible ticket', async () => {
  const { store, file, a, b } = await fixture();
  await store.createTicket({ project: 'AAA', title: 'lower', assignment: 'Agent' });
  await store.createTicket({ project: 'ZZZ', title: 'highest', assignment: 'Agent' });
  const other = new Store(file); await other.init();
  const sessionA = await store.openWorkerSession(a.device.id); const sessionB = await other.openWorkerSession(b.device.id);
  const results = await Promise.all([store.claimNext({ device: a.device.id, session_capability: sessionA.session_capability }), other.claimNext({ device: b.device.id, session_capability: sessionB.session_capability })]);
  assert.deepEqual(new Set(results.map((result) => result.ticket.id)), new Set(['ZZZ-1', 'AAA-1']));
  assert.equal(new Set(results.map((result) => result.ticket.claim.claim_id)).size, 2);
  await other.close(); await store.close();
});

test('VIQ-13 exact-session release reopens; stale and non-owning sessions cannot cross the fence', async () => {
  const { store, a, b } = await fixture(); const ticket = await store.createTicket({ project: 'AAA', title: 'fenced', assignment: 'Agent' });
  const sessionA = await store.openWorkerSession(a.device.id); const otherA = await store.openWorkerSession(a.device.id); const sessionB = await store.openWorkerSession(b.device.id);
  const first = await store.claimNext({ device: a.device.id, session_capability: sessionA.session_capability }); const firstAuth = authority(first, sessionA.session_capability);
  for (const mutation of [() => store.postEvent(ticket.id, { ...firstAuth, session_capability: otherA.session_capability, message: 'no' }), () => store.release(ticket.id, { ...firstAuth, device: b.device.id, session_capability: sessionB.session_capability })]) await assert.rejects(mutation(), (error) => error.code === 'stale_claim');
  await store.closeWorkerSession(a.device.id, sessionA.session_capability);
  await assert.rejects(store.postEvent(ticket.id, { ...firstAuth, message: 'revoked' }), (error) => error.code === 'stale_claim');
  assert.equal((await store.getTicket(ticket.id)).state, 'Working');
  const replacement = await store.openWorkerSession(a.device.id); const replacementAuth = { ...firstAuth, session_capability: replacement.session_capability };
  await assert.rejects(store.release(ticket.id, replacementAuth), (error) => error.code === 'stale_claim');
  await store.close();
});

test('VIQ-13 HTTP rejects chosen IDs, cross-session, cross-machine, and revoked capabilities', async (t) => {
  const { store, file, a, b } = await fixture(); await store.createTicket({ project: 'AAA', title: 'exploit target', assignment: 'Agent' }); await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close()); const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (credential, route, body = {}, capability) => { const response = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...(capability ? { 'x-viq-session-capability': capability } : {}) }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await call(a.credential, '/v1/tickets/claim-next', { session_id: 'pi-session-victim-00000001' })).body.error.code, 'client_session_authority_forbidden');
  const sa = (await call(a.credential, '/v1/sessions')).body, otherA = (await call(a.credential, '/v1/sessions')).body, sb = (await call(b.credential, '/v1/sessions')).body;
  const db = new DatabaseSync(file, { readOnly: true }); const stored = db.prepare('SELECT * FROM worker_sessions WHERE id=?').get(sa.session_id); db.close(); assert.equal('session_capability' in stored, false); assert.equal(Buffer.from(stored.capability_hash).length, 32); assert.equal(stored.device_id, 'machine-a');
  const claim = (await call(a.credential, '/v1/tickets/claim-next', {}, sa.session_capability)).body; const auth = { claim_id: claim.ticket.claim.claim_id, claim_token: claim.claim_token, generation: claim.ticket.claim.generation };
  assert.equal((await call(a.credential, `/v1/tickets/${claim.ticket.id}/release`, auth, otherA.session_capability)).body.error.code, 'stale_claim');
  assert.equal((await call(b.credential, `/v1/tickets/${claim.ticket.id}/release`, auth, sb.session_capability)).body.error.code, 'stale_claim');
  await call(a.credential, '/v1/sessions/close', {}, sa.session_capability);
  assert.equal((await call(a.credential, `/v1/tickets/${claim.ticket.id}/release`, auth, sa.session_capability)).body.error.code, 'stale_claim');
});

test('VIQ-13 shutdown atomically records RELEASE and releases once, while failure retains the fenced claim', async (t) => {
  const { store, file, a } = await fixture(); const ticket = await store.createTicket({ project: 'AAA', title: 'shutdown release', assignment: 'Agent' }); await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const runtime = new ViqWorkerRuntime({ baseUrl, credential: a.credential, pollMs: 100000, deliver: async () => {}, syncVault: async () => ({ commit: 'a'.repeat(40) }) });
  await runtime.start({ project: 'AAA' });
  await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  const db = new DatabaseSync(file, { readOnly: true });
  const claim = db.prepare('SELECT released_at FROM claims WHERE ticket_id=?').get(ticket.id);
  const events = db.prepare('SELECT type,message FROM events WHERE ticket_id=? ORDER BY id').all(ticket.id); db.close();
  assert.ok(claim.released_at); assert.equal((await (await fetch(`${baseUrl}/v1/tickets/${ticket.id}`, { headers: { authorization: `Bearer ${a.credential}` } })).json()).ticket.state, 'Open');
  assert.deepEqual(events.filter((event) => event.type === 'progress' && event.message === 'RELEASE: Pi session shutdown').length, 1);
  assert.equal(events.filter((event) => event.type === 'released').length, 1);

  const failed = await fixture(); const failedTicket = await failed.store.createTicket({ project: 'AAA', title: 'failed shutdown', assignment: 'Agent' }); const failedSession = await failed.store.openWorkerSession(failed.a.device.id); const failedClaim = await failed.store.claimNext({ device: failed.a.device.id, session_capability: failedSession.session_capability }); const failedAuth = authority(failedClaim, failedSession.session_capability);
  const fault = new DatabaseSync(failed.file); fault.exec("CREATE TRIGGER fail_release_after_progress BEFORE UPDATE OF released_at ON claims WHEN NEW.released_at IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events WHERE ticket_id=NEW.ticket_id AND type='progress' AND message='RELEASE: Pi session shutdown') THEN RAISE(ABORT,'release progress missing') END; SELECT RAISE(ABORT,'synthetic release fault'); END"); fault.close();
  const snapshot = () => { const db = new DatabaseSync(failed.file, { readOnly: true }); const value = { claim: db.prepare('SELECT released_at FROM claims WHERE claim_id=?').get(failedAuth.claim_id), ticket: db.prepare('SELECT updated_at FROM tickets WHERE id=?').get(failedTicket.id), events: db.prepare('SELECT type,message FROM events WHERE ticket_id=? ORDER BY id').all(failedTicket.id) }; db.close(); return value; };
  const before = snapshot(); await assert.rejects(failed.store.release(failedTicket.id, { ...failedAuth, release_message: 'RELEASE: Pi session shutdown', release_metadata: { worker: 'pi-native', lane_state: 'releasing' } }), /synthetic release fault/); assert.deepEqual(snapshot(), before); await failed.store.verify(failedTicket.id, failedAuth); assert.equal((await failed.store.getTicket(failedTicket.id)).state, 'Working'); await failed.store.close();
});

test('VIQ-13 shutdown failure rejects once with blocked status and a safe error', async (t) => {
  const { store, file, a } = await fixture(); await store.createTicket({ project: 'AAA', title: 'failed runtime shutdown', assignment: 'Agent' }); await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close()); const baseUrl = `http://127.0.0.1:${app.address().port}`; let releaseCalls = 0;
  const runtime = new ViqWorkerRuntime({ baseUrl, credential: a.credential, pollMs: 100000, deliver: async () => {}, syncVault: async () => ({ commit: 'c'.repeat(40) }), fetchImpl: async (url, init) => { if (String(url).endsWith('/release')) { releaseCalls++; return new Response(JSON.stringify({ error: { code: 'synthetic_release_failure' } }), { status: 503, headers: { 'content-type': 'application/json' } }); } return fetch(url, init); } });
  await runtime.start({ project: 'AAA' }); const first = runtime.shutdown(), duplicate = runtime.shutdown(); assert.equal(first, duplicate); await assert.rejects(first, /synthetic_release_failure/); assert.equal(releaseCalls, 1); assert.deepEqual({ mode: runtime.status().mode, last_error: runtime.status().last_error }, { mode: 'blocked', last_error: 'synthetic_release_failure' });
});

test('VIQ-13 idle shutdown can restart, claim, and release exactly once on its next shutdown', async (t) => {
  const { store, file, a } = await fixture(); await store.close(); const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close()); const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const runtime = new ViqWorkerRuntime({ baseUrl, credential: a.credential, pollMs: 100000, deliver: async () => {}, syncVault: async () => ({ commit: 'd'.repeat(40) }) }); await runtime.start({ project: 'AAA' }); await Promise.all([runtime.shutdown(), runtime.shutdown()]); assert.equal(runtime.status().mode, 'stopped');
  const writer = new Store(file); await writer.init(); const ticket = await writer.createTicket({ project: 'AAA', title: 'second lifecycle', assignment: 'Agent' }); await writer.close(); await runtime.start({ project: 'AAA' }); assert.equal(runtime.status().ticket, ticket.id); await Promise.all([runtime.shutdown(), runtime.shutdown()]);
  const db = new DatabaseSync(file, { readOnly: true }); const events = db.prepare('SELECT type,message FROM events WHERE ticket_id=?').all(ticket.id); const claim = db.prepare('SELECT released_at FROM claims WHERE ticket_id=?').get(ticket.id); db.close(); assert.ok(claim.released_at); assert.equal(events.filter((event) => event.message === 'RELEASE: Pi session shutdown').length, 1); assert.equal(events.filter((event) => event.type === 'released').length, 1);
});

test('VIQ-13 real HTTP worker poll is global and its exact runtime session can release', async (t) => {
  const { store, file, a } = await fixture(); await store.createTicket({ project: 'AAA', title: 'global lower', assignment: 'Agent' }); await store.createTicket({ project: 'ZZZ', title: 'global first', assignment: 'Agent' }); await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const prompts = []; const runtime = new ViqWorkerRuntime({ baseUrl: `http://127.0.0.1:${app.address().port}`, credential: a.credential, pollMs: 100000, deliver: async (prompt) => prompts.push(prompt), syncVault: async () => ({ commit: 'a'.repeat(40) }) });
  const status = await runtime.start({ project: 'AAA' }); assert.equal(status.ticket, 'ZZZ-1'); assert.match(prompts[0], /ZZZ-1/);
  await runtime.release('return to global queue');
  const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/tickets/ZZZ-1`, { headers: { authorization: `Bearer ${a.credential}` } });
  assert.equal((await response.json()).ticket.state, 'Open');
});
