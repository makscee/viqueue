import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { ViqWorkerRuntime } from '../extensions/viq-worker/worker-runtime.mjs';

const session = (name) => `pi-session-${name}-00000001`;
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
const authority = (claim, session_id) => ({ claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, device: claim.ticket.claim.device_id, generation: claim.ticket.claim.generation, claim_token: claim.claim_token, session_id });

test('VIQ-13 atomically claims authoritative first eligible Agent Open ticket and records machine/session provenance', async () => {
  const { store, a } = await fixture();
  await store.createTicket({ project: 'AAA', title: 'older agent', assignment: 'Agent' });
  await store.createTicket({ project: 'AAA', title: 'skip human', assignment: 'Human' });
  await store.createTicket({ project: 'ZZZ', title: 'first eligible globally', assignment: 'Agent' });
  await store.createTicket({ project: 'ZZZ', title: 'skip unassigned' });
  const before = await store.listBoardTickets();
  const claim = await store.claimNext({ device: a.device.id, session_id: session('a') });
  assert.equal(claim.ticket.id, 'ZZZ-1');
  assert.equal(claim.ticket.state, 'Working'); assert.equal(claim.ticket.assignment, 'Agent');
  assert.deepEqual({ device_id: claim.ticket.claim.device_id, machine: claim.ticket.claim.machine, session_id: claim.ticket.claim.session_id }, { device_id: 'machine-a', machine: 'Tower A', session_id: session('a') });
  for (const id of ['AAA-2', 'ZZZ-2']) assert.deepEqual(await store.getTicket(id), before.find((ticket) => ticket.id === id));
  await store.close();
});

test('VIQ-13 concurrent stores cannot share or bypass the highest eligible ticket', async () => {
  const { store, file, a, b } = await fixture();
  await store.createTicket({ project: 'AAA', title: 'lower', assignment: 'Agent' });
  await store.createTicket({ project: 'ZZZ', title: 'highest', assignment: 'Agent' });
  const other = new Store(file); await other.init();
  const results = await Promise.all([store.claimNext({ device: a.device.id, session_id: session('a') }), other.claimNext({ device: b.device.id, session_id: session('b') })]);
  assert.deepEqual(new Set(results.map((result) => result.ticket.id)), new Set(['ZZZ-1', 'AAA-1']));
  assert.equal(new Set(results.map((result) => result.ticket.claim.claim_id)).size, 2);
  await other.close(); await store.close();
});

test('VIQ-13 exact-session release reopens; stale and non-owning sessions cannot cross the fence', async () => {
  const { store, a, b } = await fixture(); const ticket = await store.createTicket({ project: 'AAA', title: 'fenced', assignment: 'Agent' });
  const first = await store.claimNext({ device: a.device.id, session_id: session('a') }); const firstAuth = authority(first, session('a'));
  for (const mutation of [() => store.postEvent(ticket.id, { ...firstAuth, session_id: session('wrong'), message: 'no' }), () => store.release(ticket.id, { ...firstAuth, device: b.device.id })]) await assert.rejects(mutation(), (error) => error.code === 'stale_claim');
  assert.equal((await store.release(ticket.id, firstAuth)).state, 'Open');
  const second = await store.claimNext({ device: b.device.id, session_id: session('b') });
  await assert.rejects(store.postEvent(ticket.id, { ...firstAuth, message: 'stale' }), (error) => error.code === 'stale_claim');
  assert.equal(second.ticket.claim.session_id, session('b')); await store.close();
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
