import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

async function fixture() {
  let now = 1_000;
  const db = path.join(await mkdtemp(path.join(tmpdir(), 'viq-lease-')), 'db.sqlite');
  const store = new Store(db, { now: () => now });
  await store.init();
  await store.bootstrapCoordinator({ id: 'human', name: 'Human' });
  await store.createActor({ id: 'agent', name: 'Agent', kind: 'agent' });
  const pairing = await store.createPairingCode('human', { intended_kind: 'worker', actor_id: 'agent', device_id: 'w', device_name: 'W' });
  const worker = await store.pairDevice({ code: pairing.code });
  await store.createProject('ABC');
  const ticket = await store.createTicket({ project: 'ABC', title: 'lease', assignment: 'Agent' });
  const session = await store.openWorkerSession('w');
  return { store, ticket, worker, session, setNow: (value) => { now = value; } };
}

const auth = (claim, capability) => ({
  claim_id: claim.ticket.claim.claim_id,
  generation: claim.ticket.claim.generation,
  claim_token: claim.claim_token,
  device: 'w',
  actor: 'agent',
  session_capability: capability
});

test('expired worker lease recovers atomically and stale generation cannot mutate', async () => {
  const f = await fixture();
  const first = await f.store.claimNext({ device: 'w', session_capability: f.session.session_capability, worker_lease: true });
  f.setNow(92_001);
  const nextSession = await f.store.openWorkerSession('w');
  const second = await f.store.claimNext({ device: 'w', session_capability: nextSession.session_capability, worker_lease: true });
  assert.equal(second.ticket.id, f.ticket.id);
  await assert.rejects(
    f.store.postEvent(f.ticket.id, { ...auth(first, f.session.session_capability), request_id: 'old', message: 'late' }),
    (error) => error.code === 'stale_claim'
  );
  assert.equal((await f.store.listEvents({ ticket: f.ticket.id })).events.some((event) => event.type === 'worker_lease_expired'), true);
  await f.store.close();
});

test('worker receipt retries progress and release without duplicate events', async () => {
  const f = await fixture();
  const claim = await f.store.claimNext({ device: 'w', session_capability: f.session.session_capability, worker_lease: true });
  const identity = auth(claim, f.session.session_capability);
  await f.store.postEvent(f.ticket.id, { ...identity, request_id: 'p1', message: 'one' });
  await f.store.postEvent(f.ticket.id, { ...identity, request_id: 'p1', message: 'one' });
  await f.store.release(f.ticket.id, { ...identity, request_id: 'r1', release_message: 'RELEASE: one' });
  await f.store.release(f.ticket.id, { ...identity, request_id: 'r1', release_message: 'RELEASE: one' });
  const events = (await f.store.listEvents({ ticket: f.ticket.id })).events;
  assert.equal(events.filter((event) => event.message === 'one').length, 1);
  assert.equal(events.filter((event) => event.type === 'released').length, 1);
  await f.store.close();
});

test('worker mutation receipts reject wrong generation, token, session, stale claim, and revoked-session replay', async () => {
  const f = await fixture();
  const claim = await f.store.claimNext({ device: 'w', session_capability: f.session.session_capability, worker_lease: true });
  const identity = auth(claim, f.session.session_capability);
  const original = await f.store.postEvent(f.ticket.id, { ...identity, request_id: 'fenced-receipt', message: 'once' });
  assert.deepEqual(await f.store.postEvent(f.ticket.id, { ...identity, request_id: 'fenced-receipt', message: 'once' }), original);

  const otherSession = await f.store.openWorkerSession('w');
  for (const replay of [
    { ...identity, generation: identity.generation + 1 },
    { ...identity, claim_token: 'invalid-token' },
    { ...identity, session_capability: otherSession.session_capability }
  ]) {
    await assert.rejects(
      f.store.postEvent(f.ticket.id, { ...replay, request_id: 'fenced-receipt', message: 'replay' }),
      (error) => error.code === 'stale_claim'
    );
  }

  await f.store.closeWorkerSession('w', f.session.session_capability);
  await assert.rejects(
    f.store.postEvent(f.ticket.id, { ...identity, request_id: 'fenced-receipt', message: 'revoked replay' }),
    (error) => error.code === 'stale_claim'
  );

  const replacement = await f.store.claimNext({ device: 'w', session_capability: otherSession.session_capability, worker_lease: true });
  await assert.rejects(
    f.store.postEvent(f.ticket.id, { ...auth(replacement, otherSession.session_capability), request_id: 'fenced-receipt', message: 'stale request id' }),
    (error) => error.code === 'stale_claim'
  );
  assert.equal((await f.store.listEvents({ ticket: f.ticket.id })).events.filter((event) => event.message === 'once').length, 1);
  await f.store.close();
});
