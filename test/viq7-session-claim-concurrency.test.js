import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

async function fixture() {
  let now = 1_000;
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'viq7-session-claims-')), 'db.sqlite');
  const store = new Store(file, { now: () => now });
  await store.init();
  await store.bootstrapCoordinator({ id: 'human', name: 'Human' });
  await store.createActor({ id: 'agent', name: 'Agent', kind: 'agent' });
  const pairing = await store.createPairingCode('human', { intended_kind: 'worker', actor_id: 'agent', device_id: 'worker', device_name: 'Worker' });
  await store.pairDevice({ code: pairing.code });
  await store.createProject('ABC');
  const tickets = [];
  for (const title of ['One', 'Two', 'Three']) tickets.push(await store.createTicket({ project: 'ABC', title, assignment: 'Agent' }));
  return { store, tickets, setNow: (value) => { now = value; } };
}

const authority = (claim, capability) => ({
  claim_id: claim.ticket.claim.claim_id,
  generation: claim.ticket.claim.generation,
  claim_token: claim.claim_token,
  actor: 'agent',
  device: 'worker',
  session_capability: capability
});

test('VIQ-7 store permits one active claim per session on one device and fences cross-session mutation', async () => {
  const f = await fixture();
  const firstSession = await f.store.openWorkerSession('worker');
  const secondSession = await f.store.openWorkerSession('worker');
  const first = await f.store.claim(f.tickets[0].id, { device: 'worker', session_capability: firstSession.session_capability });
  const second = await f.store.claim(f.tickets[1].id, { device: 'worker', session_capability: secondSession.session_capability });

  assert.notEqual(first.ticket.claim.session_id, second.ticket.claim.session_id);
  const thirdSession = await f.store.openWorkerSession('worker');
  await assert.rejects(
    f.store.claim(first.ticket.id, { device: 'worker', session_capability: thirdSession.session_capability }),
    (error) => error.code === 'ticket_ineligible'
  );
  await assert.rejects(
    f.store.claim(f.tickets[2].id, { device: 'worker', session_capability: firstSession.session_capability }),
    (error) => error.code === 'session_already_claimed'
  );
  await assert.rejects(
    f.store.postEvent(first.ticket.id, { ...authority(first, secondSession.session_capability), message: 'cross-session write' }),
    (error) => error.code === 'stale_claim'
  );
  assert.equal((await f.store.getTicket(first.ticket.id)).claim.claim_id, first.ticket.claim.claim_id);
  assert.equal((await f.store.getTicket(second.ticket.id)).claim.claim_id, second.ticket.claim.claim_id);

  await f.store.closeWorkerSession('worker', firstSession.session_capability);
  assert.equal((await f.store.getTicket(first.ticket.id)).claim, null, 'closing a session releases its non-leased claim');
  assert.equal((await f.store.getTicket(second.ticket.id)).claim.claim_id, second.ticket.claim.claim_id, 'another session on the device remains independently claimed');
  await f.store.release(second.ticket.id, authority(second, secondSession.session_capability));
  assert.equal((await f.store.getTicket(second.ticket.id)).claim, null);
  await f.store.close();
});

test('VIQ-7 store heartbeat and expiry are independent and revoked capabilities cannot mutate', async () => {
  const f = await fixture();
  const firstSession = await f.store.openWorkerSession('worker');
  const secondSession = await f.store.openWorkerSession('worker');
  const first = await f.store.claimNext({ device: 'worker', session_capability: firstSession.session_capability, worker_lease: true });
  const second = await f.store.claimNext({ device: 'worker', session_capability: secondSession.session_capability, worker_lease: true });

  f.setNow(2_000);
  const heartbeat = await f.store.heartbeatWorker('worker', {
    mode: 'working', ticket_id: second.ticket.id, ...authority(second, secondSession.session_capability)
  });
  assert.equal(heartbeat.lease_expires_at, 92_000);
  f.setNow(91_001);
  const recoverySession = await f.store.openWorkerSession('worker');
  const recovered = await f.store.claimNext({ device: 'worker', session_capability: recoverySession.session_capability, worker_lease: true });
  assert.equal(recovered.ticket.id, first.ticket.id);
  assert.notEqual(recovered.ticket.claim.claim_id, first.ticket.claim.claim_id);
  await assert.rejects(
    f.store.postEvent(first.ticket.id, { ...authority(first, firstSession.session_capability), message: 'expired write' }),
    (error) => error.code === 'stale_claim'
  );
  assert.equal((await f.store.getTicket(second.ticket.id)).claim.claim_id, second.ticket.claim.claim_id);

  await f.store.closeWorkerSession('worker', secondSession.session_capability);
  await assert.rejects(
    f.store.postEvent(second.ticket.id, { ...authority(second, secondSession.session_capability), message: 'revoked write' }),
    (error) => error.code === 'stale_claim'
  );
  assert.equal((await f.store.getTicket(second.ticket.id)).claim, null, 'closing a session releases its leased claim');
  assert.equal((await f.store.getTicket(first.ticket.id)).claim.claim_id, recovered.ticket.claim.claim_id, 'closing one session does not release a different session claim');
  await f.store.close();
});
