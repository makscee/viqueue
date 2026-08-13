import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store, DomainError } from '../src/store.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-domain-'));
  let now = 1_700_000_000_000;
  const file = path.join(dir, 'viqueue.json');
  const store = new Store(file, { now: () => now });
  await store.init();
  return { store, file, advance: (ms) => { now += ms; } };
}

async function seeded() {
  const f = await fixture();
  await f.store.createProject('ABC');
  const ticket = await f.store.createTicket({ project: 'ABC', title: 'Trace claim fencing' });
  return { ...f, ticket };
}

test('project ticket numbering starts at one and survives reopening durable storage', async () => {
  const { store, file } = await fixture();
  assert.deepEqual(await store.createProject('abc'), { key: 'ABC', next_number: 1 });
  const first = await store.createTicket({ project: 'ABC', title: 'first' });
  assert.equal(first.id, 'ABC-1');

  const reopened = new Store(file);
  await reopened.init();
  const second = await reopened.createTicket({ project: 'ABC', title: 'second' });
  assert.equal(second.id, 'ABC-2');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tickets['ABC-2'].title, 'second');
});

test('claim is pull-based and removes ticket from availability', async () => {
  const { store, ticket } = await seeded();
  assert.equal((await store.next('worker-a')).id, ticket.id);
  const claim = await store.claim(ticket.id, { actor: 'worker-a', ttl_ms: 1_000 });
  assert.equal(claim.ticket.state, 'claimed');
  assert.equal(claim.ticket.claim.generation, 1);
  assert.equal('token' in claim.ticket.claim, false);
  assert.equal(typeof claim.claim_token, 'string');
  assert.equal(await store.next('worker-b'), null);
});

test('current owner can renew without changing fencing generation', async () => {
  const { store, ticket, advance } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a', ttl_ms: 100 });
  advance(50);
  const renewed = await store.renew(ticket.id, {
    actor: 'worker-a', claim_token: claim.claim_token, generation: 1, ttl_ms: 200
  });
  assert.equal(renewed.ticket.claim.generation, 1);
  assert.equal(renewed.ticket.claim.expires_at, 1_700_000_000_250);
  assert.equal(renewed.claim_token, claim.claim_token);
});

test('renew fences stale credentials and cannot revive an expired claim', async () => {
  const { store, ticket, advance } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a', ttl_ms: 100 });
  await assert.rejects(store.renew(ticket.id, {
    actor: 'worker-b', claim_token: claim.claim_token, generation: 1, ttl_ms: 100
  }), (error) => error.code === 'stale_claim' && error.status === 409);
  advance(101);
  await assert.rejects(store.renew(ticket.id, {
    actor: 'worker-a', claim_token: claim.claim_token, generation: 1, ttl_ms: 100
  }), (error) => error.code === 'claim_expired' && error.status === 409);
  assert.equal((await store.getTicket(ticket.id)).state, 'stale');
});

test('expired claim becomes stale and stays unavailable', async () => {
  const { store, ticket, advance } = await seeded();
  await store.claim(ticket.id, { actor: 'worker-a', ttl_ms: 100 });
  advance(101);
  assert.equal(await store.next('worker-b'), null);
  const stale = await store.getTicket(ticket.id);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.claim.generation, 1);
});

test('explicit authorized takeover increments generation and fences old owner', async () => {
  const { store, ticket, advance } = await seeded();
  const old = await store.claim(ticket.id, { actor: 'worker-a', ttl_ms: 100 });
  advance(101);
  await store.getTicket(ticket.id);
  const current = await store.takeover(ticket.id, { actor: 'worker-b', ttl_ms: 1_000 });
  assert.equal(current.ticket.claim.generation, 2);

  await assert.rejects(
    store.update(ticket.id, {
      actor: 'worker-a', claim_token: old.claim_token, generation: 1, status: 'submitted'
    }),
    (error) => error instanceof DomainError && error.status === 409 && error.code === 'stale_claim'
  );
});

test('current owner can submit textual or JSON evidence', async () => {
  const { store, ticket } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-b', ttl_ms: 1_000 });
  const submitted = await store.update(ticket.id, {
    actor: 'worker-b', claim_token: claim.claim_token, generation: 1,
    status: 'submitted', evidence: { summary: 'tests pass', count: 7 }
  });
  assert.equal(submitted.state, 'submitted');
  assert.deepEqual(submitted.evidence, { summary: 'tests pass', count: 7 });
});

test('competing claims are serialized and exactly one wins', async () => {
  const { store, ticket } = await seeded();
  const outcomes = await Promise.allSettled([
    store.claim(ticket.id, { actor: 'worker-a', ttl_ms: 1_000 }),
    store.claim(ticket.id, { actor: 'worker-b', ttl_ms: 1_000 })
  ]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
  const loser = outcomes.find((x) => x.status === 'rejected').reason;
  assert.equal(loser.code, 'ticket_unavailable');
  assert.equal(loser.status, 409);
});
