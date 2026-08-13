import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store, DomainError } from '../src/store.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-domain-'));
  let now = 1_700_000_000_000;
  const file = path.join(dir, 'viqueue.sqlite');
  const store = new Store(file, { now: () => now });
  await store.init();
  return { store, file, advance: (ms) => { now += ms; } };
}

async function seeded() {
  const f = await fixture();
  await f.store.createProject('ABC');
  const ticket = await f.store.createTicket({ project: 'ABC', title: 'Trace claim fencing', body: 'details', assigned_to: 'eva' });
  return { ...f, ticket };
}

const identity = (claim) => ({
  claim_id: claim.ticket.claim.claim_id,
  actor: claim.ticket.claim.actor,
  generation: claim.ticket.claim.generation,
  claim_token: claim.claim_token
});

test('SQLite ticket fields, numbering, and event history survive store restart', async () => {
  const { store, file } = await fixture();
  assert.deepEqual(await store.createProject('abc'), { key: 'ABC', next_number: 1, created_at: 1_700_000_000_000 });
  const first = await store.createTicket({ project: 'ABC', title: ' first ', body: 'body', assigned_to: 'maks' });
  assert.equal(first.id, 'ABC-1');
  assert.equal(first.state, 'open');
  assert.equal(first.body, 'body');
  assert.equal(first.assigned_to, 'maks');
  await store.close();

  const reopened = new Store(file, { now: () => 1_700_000_001_000 });
  await reopened.init();
  const second = await reopened.createTicket({ project: 'ABC', title: 'second' });
  assert.equal(second.id, 'ABC-2');
  assert.equal((await reopened.getTicket('ABC-1')).title, 'first');
  assert.deepEqual((await reopened.listEvents({ ticket: 'ABC-1' })).events.map((event) => event.type), ['ticket_created']);
  await reopened.close();
});

test('durable claim survives arbitrary elapsed time and restart without liveness inference', async () => {
  const { store, file, ticket, advance } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  assert.equal(claim.ticket.state, 'open');
  assert.equal(claim.ticket.claim.generation, 1);
  assert.equal(typeof claim.ticket.claim.claim_id, 'string');
  assert.equal('token_hash' in claim.ticket.claim, false);
  advance(10 * 365 * 24 * 60 * 60 * 1000);
  await store.close();
  const reopened = new Store(file, { now: () => 2_100_000_000_000 });
  await reopened.init();
  assert.equal((await reopened.getTicket(ticket.id)).claim.claim_id, claim.ticket.claim.claim_id);
  assert.equal(await reopened.next({ project: 'ABC' }), null);
  await reopened.verify(ticket.id, identity(claim));
  await reopened.close();
});

test('explicit release removes authority and makes open ticket ready', async () => {
  const { store, ticket } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const released = await store.release(ticket.id, identity(claim));
  assert.equal(released.claim, null);
  assert.equal((await store.next({ project: 'ABC' })).id, ticket.id);
  await assert.rejects(store.verify(ticket.id, identity(claim)), (error) => error.code === 'stale_claim');
});

test('submit review, accept done, and reopen open are explicit state transitions', async () => {
  const { store, ticket } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const reviewed = await store.submit(ticket.id, { ...identity(claim), message: 'ready for review' });
  assert.equal(reviewed.state, 'review');
  assert.equal(reviewed.claim, null);
  const done = await store.accept(ticket.id, { actor: 'maks', message: 'accepted' });
  assert.equal(done.state, 'done');
  const reopened = await store.reopen(ticket.id, { actor: 'maks', message: 'follow-up needed' });
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.claim, null);
});

test('competing claims are atomic across independent SQLite connections', async () => {
  const { store, file, ticket } = await seeded();
  const other = new Store(file);
  await other.init();
  const outcomes = await Promise.allSettled([
    store.claim(ticket.id, { actor: 'worker-a' }),
    other.claim(ticket.id, { actor: 'worker-b' })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'ticket_unavailable');
  await other.close();
});

test('explicit takeover increments generation and old owner is fenced', async () => {
  const { store, ticket } = await seeded();
  const old = await store.claim(ticket.id, { actor: 'worker-a' });
  const current = await store.takeover(ticket.id, { actor: 'worker-b' });
  assert.equal(current.ticket.claim.generation, 2);
  assert.notEqual(current.ticket.claim.claim_id, old.ticket.claim.claim_id);
  await assert.rejects(store.postEvent(ticket.id, { ...identity(old), message: 'late progress' }),
    (error) => error instanceof DomainError && error.status === 409 && error.code === 'stale_claim');
  assert.equal((await store.verify(ticket.id, identity(current))).claim.claim_id, current.ticket.claim.claim_id);
});

test('event cursor is global monotonic and polling after cursor filters project or ticket', async () => {
  const { store, ticket } = await seeded();
  const initial = await store.listEvents({ project: 'ABC' });
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const progress = await store.postEvent(ticket.id, { ...identity(claim), message: 'tests are green' });
  await store.createProject('XYZ');
  await store.createTicket({ project: 'XYZ', title: 'other' });
  assert.ok(progress.cursor > initial.cursor);
  const after = await store.listEvents({ project: 'ABC', after: initial.cursor });
  assert.deepEqual(after.events.map((event) => event.type), ['claimed', 'progress']);
  assert.equal(after.events[1].message, 'tests are green');
  assert.equal(after.cursor, progress.cursor);
  const ticketEvents = await store.listEvents({ ticket: ticket.id, after: progress.cursor });
  assert.deepEqual(ticketEvents.events, []);
  assert.ok(ticketEvents.cursor >= progress.cursor);
});

test('ticket edit and assignment retain the minimal canonical fields and record events', async () => {
  const { store, ticket } = await seeded();
  const edited = await store.editTicket(ticket.id, { title: 'Updated', body: 'new body', assigned_to: null, actor: 'maks' });
  assert.equal(edited.title, 'Updated');
  assert.equal(edited.body, 'new body');
  assert.equal(edited.assigned_to, null);
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.map((event) => event.type), ['ticket_created', 'ticket_edited', 'assigned']);
});
