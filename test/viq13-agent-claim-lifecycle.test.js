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

test('VIQ-13 real HTTP worker poll is global and its exact runtime session can release', async (t) => {
  const { store, file, a } = await fixture(); await store.createTicket({ project: 'AAA', title: 'global lower', assignment: 'Agent' }); await store.createTicket({ project: 'ZZZ', title: 'global first', assignment: 'Agent' }); await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const prompts = []; const runtime = new ViqWorkerRuntime({ baseUrl: `http://127.0.0.1:${app.address().port}`, credential: a.credential, pollMs: 100000, deliver: async (prompt) => prompts.push(prompt), syncVault: async () => ({ commit: 'a'.repeat(40) }) });
  const status = await runtime.start({ project: 'AAA' }); assert.equal(status.ticket, 'ZZZ-1'); assert.match(prompts[0], /ZZZ-1/);
  await runtime.release('return to global queue');
  const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/tickets/ZZZ-1`, { headers: { authorization: `Bearer ${a.credential}` } });
  assert.equal((await response.json()).ticket.state, 'Open');
});
