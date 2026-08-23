import { claimWithSession, claimNextWithSession } from './helpers/worker-session.js';
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
  for (const id of ['worker-a','worker-b','maks']) await store.createActor({id,name:id,kind:id==='maks'?'human':'agent'});
  const coordinator = await store.bootstrapCoordinator({ id: 'maks', name: 'maks' });
  for (const id of ['worker-a','worker-b']) { const pairing = await store.createPairingCode('maks', { intended_kind: 'worker' }); await store.pairDevice({ code: pairing.code, id, name: id }); }
  return { store, file, coordinator, advance: (ms) => { now += ms; } };
}

async function seeded() {
  const f = await fixture();
  await f.store.createProject('ABC');
  const ticket = await f.store.createTicket({ project: 'ABC', title: 'Trace claim fencing', description: 'details', actor: 'maks', assignment:'Agent' });
  return { ...f, ticket };
}

const identity = (claim) => ({
  claim_id: claim.ticket.claim.claim_id,
  actor: claim.ticket.claim.actor,
  generation: claim.ticket.claim.generation,
  claim_token: claim.claim_token,
  device: claim.ticket.claim.device_id,
  session_capability: claim.session_capability
});

test('SQLite ticket fields, numbering, and event history survive store restart', async () => {
  const { store, file } = await fixture();
  assert.deepEqual(await store.createProject('abc'), { key: 'ABC', next_number: 1, created_at: 1_700_000_000_000 });
  const first = await store.createTicket({ project: 'ABC', title: ' first ', description: 'body', assignment:'Agent', actor: 'maks' });
  assert.equal(first.id, 'ABC-1');
  assert.equal(first.state, 'Open');
  assert.equal(first.description, 'body');
  assert.equal(first.assignment, 'Agent');
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
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  assert.equal(claim.ticket.state, 'Working');
  assert.equal(claim.ticket.claim.generation, 1);
  assert.equal(typeof claim.ticket.claim.claim_id, 'string');
  assert.equal('token_hash' in claim.ticket.claim, false);
  advance(10 * 365 * 24 * 60 * 60 * 1000);
  await store.close();
  const reopened = new Store(file, { now: () => 2_100_000_000_000 });
  await reopened.init();
  assert.equal((await reopened.getTicket(ticket.id)).claim.claim_id, claim.ticket.claim.claim_id);
  assert.equal(await reopened.next({ project: 'ABC', device: 'worker-a' }), null);
  await reopened.verify(ticket.id, identity(claim));
  await reopened.close();
});

test('explicit release removes authority and makes open ticket ready', async () => {
  const { store, ticket } = await seeded();
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  const released = await store.release(ticket.id, identity(claim));
  assert.equal(released.claim, null);
  assert.equal((await store.next({ project: 'ABC', device: 'worker-a' })).id, ticket.id);
  await assert.rejects(store.verify(ticket.id, identity(claim)), (error) => error.code === 'stale_claim');
});

test('submit review, accept done, and reopen open are explicit state transitions', async () => {
  const { store, ticket } = await seeded();
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  const reviewed = (await store.submit(ticket.id, { ...identity(claim), reviewer:{type:'actor',id:'maks'}, message: 'ready for review' })).ticket;
  assert.equal(reviewed.state, 'Waiting');
  assert.equal(reviewed.claim, null);
  const done = await store.accept(ticket.id, { actor: 'maks', message: 'accepted' });
  assert.equal(done.state, 'Done');
  const reopened = await store.reopen(ticket.id, { actor: 'maks', message: 'follow-up needed' });
  assert.equal(reopened.state, 'Open');
  assert.equal(reopened.claim, null);
});

test('Agent assignment is launch authorization and atomic claimNext skips Unassigned work', async () => {
  const { store, file } = await fixture(); await store.createProject('ABC');
  await store.createTicket({ project: 'ABC', title: 'Unassigned', actor: 'maks' });
  await store.createTicket({ project: 'ABC', title: 'Assigned', assignment: 'Agent', actor: 'maks' });
  assert.equal((await claimNextWithSession(store, { project: 'ABC', device: 'worker-b' })).ticket.id, 'ABC-2');
  await store.createTicket({ project: 'ABC', title: 'Concurrent', assignment: 'Agent', actor: 'maks' });
  const other = new Store(file); await other.init();
  const outcomes = await Promise.all([claimNextWithSession(store, { project: 'ABC', device: 'worker-a' }), claimNextWithSession(other, { project: 'ABC', device: 'worker-a' })]);
  assert.equal(outcomes.filter(Boolean).length, 1); assert.equal(outcomes.find(Boolean).ticket.id, 'ABC-3'); await other.close();
});

test('assignment category changes eligibility without exposing identity authority', async () => {
  const { store } = await fixture(); await store.createProject('ABC');
  await store.createTicket({ project: 'ABC', title: 'Launch', actor: 'maks' });
  assert.equal(await claimNextWithSession(store, { project: 'ABC', device: 'worker-a' }), null);
  await store.editTicket('ABC-1', { actor: 'maks', assignment: 'Agent' });
  const claim = await claimNextWithSession(store, { project: 'ABC', device: 'worker-b' });
  assert.equal(claim.ticket.assignment, 'Agent');
  assert.equal('execution_authority' in await store.getTicket('ABC-1'), false);
});

test('structured blockers prevent relaunch until a human resolves them', async () => {
  const { store } = await fixture(); await store.createProject('ABC');
  await store.createTicket({ project: 'ABC', title: 'Blocked', assignment:'Agent', actor: 'maks' });
  const claim = await claimNextWithSession(store, { project: 'ABC', device: 'worker-a' });
  const blocked = await store.blockTicket('ABC-1', { ...identity(claim), reason: 'Need review' });
  assert.equal(blocked.ticket.unresolved_blockers, 1);
  await store.release('ABC-1', identity(claim));
  assert.equal(await claimNextWithSession(store, { project: 'ABC', device: 'worker-a' }), null);
  await store.resolveBlock('ABC-1', blocked.block.id, { actor: 'maks' });
  assert.ok(await claimNextWithSession(store, { project: 'ABC', device: 'worker-a' }));
});

test('competing claims are atomic across independent SQLite connections', async () => {
  const { store, file, ticket } = await seeded();
  const other = new Store(file);
  await other.init();
  const outcomes = await Promise.allSettled([
    claimWithSession(store, ticket.id, { device: 'worker-a' }),
    claimWithSession(other, ticket.id, { device: 'worker-a' })
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, 'ticket_ineligible');
  await other.close();
});

test('takeover surface is absent; only explicit release permits another claim', async () => {
  const { store } = await seeded();
  assert.equal(store.takeover, undefined);
});

test('event cursor is global monotonic and polling after cursor filters project or ticket', async () => {
  const { store, ticket } = await seeded();
  const initial = await store.listEvents({ project: 'ABC' });
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
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

test('human edits mutable ticket fields while project identity and active claim remain stable', async () => {
  const { store, ticket } = await seeded();
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  const edited = await store.editTicket(ticket.id, { title: 'Updated', description: '**new** body', assignment: 'Human', actor: 'maks' });
  assert.equal(edited.id, ticket.id); assert.equal(edited.project, 'ABC');
  assert.equal(edited.title, 'Updated'); assert.equal(edited.description, '**new** body'); assert.equal(edited.assignment, 'Human');
  assert.equal(edited.claim.claim_id, claim.ticket.claim.claim_id); assert.equal(edited.claim.actor, 'worker-a');
  await assert.rejects(store.editTicket(ticket.id, { project: 'XYZ', actor: 'maks' }), (error) => error.code === 'immutable_project');
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.map((event) => event.type), ['ticket_created', 'claimed', 'ticket_edited']);
});

test('human direct state changes fence claims and progress stays in the ticket event chronology', async () => {
  const { store, ticket, advance } = await seeded();
  await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  const review = await store.setTicketState(ticket.id, { state: 'Waiting', actor: 'maks' });
  assert.equal(review.state, 'Waiting'); assert.equal(review.claim, null);
  advance(1000);
  const progress = await store.appendTicketEvent(ticket.id, { actor: 'maks', message: 'Human **progress** note.' });
  assert.equal(progress.event.type, 'progress'); assert.equal(progress.event.actor, 'maks');
  await store.setTicketState(ticket.id, { state: 'Done', actor: 'maks' });
  await store.setTicketState(ticket.id, { state: 'Open', actor: 'maks' });
  const events = (await store.listEvents({ ticket: ticket.id })).events.filter((event) => ['state_changed', 'progress'].includes(event.type));
  assert.deepEqual(events.map((event) => event.type), ['state_changed', 'progress', 'state_changed', 'state_changed']);
  assert.ok(events.every((event) => event.actor === 'maks' && event.created_at && event.message));
});

test('direct state override resolves a pending approval instead of leaving a stale inbox question', async () => {
  const { store, ticket } = await seeded(); const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' }); const submitted = await store.submit(ticket.id, { ...identity(claim), reviewer: { type: 'actor', id: 'maks' } });
  await store.setTicketState(ticket.id, { state: 'Open', actor: 'maks' });
  const question = (await store.listQuestions(ticket.id)).questions.find((item) => item.id === submitted.question.id);
  assert.equal(question.status, 'answered'); assert.equal(JSON.parse(question.answer).decision, 'request_changes');
  const answer = (await store.listEvents({ ticket: ticket.id })).events.find((event) => event.type === 'question_answered'); assert.equal(answer.metadata.question_event_id, question.question_event_id);
});

test('archive is reversible while confirmed delete tombstones without erasing history', async () => {
  const { store, ticket } = await seeded(); const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  const archived = await store.archiveTicket(ticket.id, { actor: 'maks' }); assert.ok(archived.archived_at); assert.equal(archived.claim, null); await assert.rejects(store.verify(ticket.id, identity(claim)), (error) => error.code === 'stale_claim');
  assert.deepEqual(await store.listTickets('ABC'), []); assert.equal(await store.next({ project: 'ABC', device: 'worker-a' }), null); await assert.rejects(claimWithSession(store, ticket.id, { actor: 'worker-a' }), (error) => error.code === 'ticket_ineligible');
  assert.deepEqual((await store.listTickets('ABC', { includeArchived: true })).map((item) => item.id), [ticket.id]);
  const restored = await store.restoreTicket(ticket.id, { actor: 'maks' }); assert.equal(restored.archived_at, null);
  for (const confirmed of [undefined, false, null, 0, 1, 'true', [], {}]) {
    await assert.rejects(store.deleteTicket(ticket.id, { actor: 'maks', ...(confirmed === undefined ? {} : { confirmed }) }), (error) => error.code === 'delete_confirmation_required');
    assert.equal((await store.getTicket(ticket.id)).deleted_at, null);
  }
  const deleted = await store.deleteTicket(ticket.id, { actor: 'maks', confirmed: true }); assert.ok(deleted.deleted_at);
  assert.deepEqual(await store.listTickets('ABC', { includeArchived: true }), []);
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.slice(-3).map((event) => event.type), ['archived', 'restored', 'deleted']);
});

test('archived tickets are immutable and leave inboxes until restored', async () => {
  const { store, ticket } = await seeded();
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker-a' });
  const asked = await store.askQuestion(ticket.id, { ...identity(claim), text: 'Still active?', target_type: 'actor', target_id: 'maks' });
  await store.archiveTicket(ticket.id, { actor: 'maks' });
  assert.deepEqual((await store.actorInbox('maks')).questions, []);
  for (const operation of [
    () => store.editTicket(ticket.id, { actor: 'maks', title: 'archived edit' }),
    () => store.setTicketState(ticket.id, { actor: 'maks', state: 'Done' }),
    () => store.appendTicketEvent(ticket.id, { actor: 'maks', message: 'archived progress' }),
    () => store.askHumanQuestion(ticket.id, { actor: 'maks', text: 'archived?', target_type: 'actor', target_id: 'worker-a' }),
    () => store.answerQuestion(ticket.id, asked.question.id, { actor: 'maks', answer: 'not yet' }),
    () => store.deleteTicket(ticket.id, { actor: 'maks', confirmed: true })
  ]) await assert.rejects(operation(), (error) => error.code === 'ticket_archived');
  await store.restoreTicket(ticket.id, { actor: 'maks' });
  assert.deepEqual((await store.actorInbox('maks')).questions.map((question) => question.id), [asked.question.id]);
  await store.answerQuestion(ticket.id, asked.question.id, { actor: 'maks', answer: 'restored' });
});

test('archive and delete checks remain correct when the clock returns zero', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-zero-time-'));
  const store = new Store(path.join(dir, 'data.sqlite'), { now: () => 0 });
  await store.init(); await store.createProject('ABC'); await store.bootstrapCoordinator({ id: 'maks', name: 'Maks' });
  const archivedTicket = await store.createTicket({ project: 'ABC', title: 'Archived at epoch' });
  const archived = await store.archiveTicket(archivedTicket.id, { actor: 'maks' });
  assert.equal(archived.archived_at, 0);
  assert.deepEqual(await store.listTickets('ABC'), []);
  await assert.rejects(store.editTicket(archived.id, { actor: 'maks', title: 'epoch zombie' }), (error) => error.code === 'ticket_archived');
  assert.equal((await store.restoreTicket(archived.id, { actor: 'maks' })).archived_at, null);
  const deleted = await store.deleteTicket(archived.id, { actor: 'maks', confirmed: true });
  assert.equal(deleted.deleted_at, 0);
  assert.deepEqual(await store.listTickets('ABC', { includeArchived: true }), []);
  await assert.rejects(store.editTicket(deleted.id, { actor: 'maks', title: 'epoch tombstone' }), (error) => error.code === 'ticket_deleted');
  await store.close();
});

test('deleted tombstones reject subsequent human mutations', async () => {
  const { store, ticket } = await seeded(); await store.deleteTicket(ticket.id, { actor: 'maks', confirmed: true });
  for (const operation of [
    () => store.editTicket(ticket.id, { actor: 'maks', title: 'zombie' }),
    () => store.setTicketState(ticket.id, { actor: 'maks', state: 'Done' }),
    () => store.appendTicketEvent(ticket.id, { actor: 'maks', message: 'zombie' }),
    () => store.askHumanQuestion(ticket.id, { actor: 'maks', text: 'zombie?', target_type: 'actor', target_id: 'worker-a' }),
    () => store.accept(ticket.id, { actor: 'maks' }),
    () => store.reopen(ticket.id, { actor: 'maks' })
  ]) await assert.rejects(operation(), (error) => error.code === 'ticket_deleted');
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.map((event) => event.type), ['ticket_created', 'deleted']);
});

test('ticket edit and assignment retain the minimal canonical fields and record events', async () => {
  const { store, ticket } = await seeded();
  const edited = await store.editTicket(ticket.id, { title: 'Updated', description: 'new body', assignment: 'Unassigned', actor: 'maks' });
  assert.equal(edited.title, 'Updated');
  assert.equal(edited.description, 'new body');
  assert.equal(edited.assignment, 'Unassigned');
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.map((event) => event.type), ['ticket_created', 'ticket_edited']);
});
