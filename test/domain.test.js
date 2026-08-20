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
  const ticket = await f.store.createTicket({ project: 'ABC', title: 'Trace claim fencing', body: 'details', actor: 'maks', assignee: { type: 'device', id: 'worker-a' } });
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
  const first = await store.createTicket({ project: 'ABC', title: ' first ', body: 'body', assigned_to: 'worker-a', actor: 'maks' });
  assert.equal(first.id, 'ABC-1');
  assert.equal(first.state, 'open');
  assert.equal(first.body, 'body');
  assert.equal(first.assigned_to, 'worker-a');
  await store.close();

  const reopened = new Store(file, { now: () => 1_700_000_001_000 });
  await reopened.init();
  const second = await reopened.createTicket({ project: 'ABC', title: 'second' });
  assert.equal(second.id, 'ABC-2');
  assert.equal((await reopened.getTicket('ABC-1')).title, 'first');
  assert.deepEqual((await reopened.listEvents({ ticket: 'ABC-1' })).events.map((event) => event.type), ['ticket_created', 'assigned']);
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
  assert.equal(await reopened.next({ project: 'ABC', device: 'worker-a' }), null);
  await reopened.verify(ticket.id, identity(claim));
  await reopened.close();
});

test('explicit release removes authority and makes open ticket ready', async () => {
  const { store, ticket } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const released = await store.release(ticket.id, identity(claim));
  assert.equal(released.claim, null);
  assert.equal((await store.next({ project: 'ABC', device: 'worker-a' })).id, ticket.id);
  await assert.rejects(store.verify(ticket.id, identity(claim)), (error) => error.code === 'stale_claim');
});

test('submit review, accept done, and reopen open are explicit state transitions', async () => {
  const { store, ticket } = await seeded();
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const reviewed = (await store.submit(ticket.id, { ...identity(claim), reviewer:{type:'actor',id:'maks'}, message: 'ready for review' })).ticket;
  assert.equal(reviewed.state, 'review');
  assert.equal(reviewed.claim, null);
  const done = await store.accept(ticket.id, { actor: 'maks', message: 'accepted' });
  assert.equal(done.state, 'done');
  const reopened = await store.reopen(ticket.id, { actor: 'maks', message: 'follow-up needed' });
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.claim, null);
});

test('coordinator assignment is launch authorization and atomic claimNext honors exact device', async () => {
  const { store, file } = await fixture(); await store.createProject('ABC');
  await store.createTicket({ project: 'ABC', title: 'Unassigned', actor: 'maks' });
  await store.createTicket({ project: 'ABC', title: 'Assigned', assignee: { type: 'device', id: 'worker-a' }, actor: 'maks' });
  assert.equal(await store.claimNext({ project: 'ABC', device: 'worker-b' }), null);
  const other = new Store(file); await other.init();
  const outcomes = await Promise.all([store.claimNext({ project: 'ABC', device: 'worker-a' }), other.claimNext({ project: 'ABC', device: 'worker-a' })]);
  assert.equal(outcomes.filter(Boolean).length, 1); assert.equal(outcomes.find(Boolean).ticket.id, 'ABC-2'); await other.close();
});

test('coordinator reassignment immediately changes worker eligibility without authority rows', async () => {
  const { store } = await fixture(); await store.createProject('ABC');
  await store.createTicket({ project: 'ABC', title: 'Launch', assignee: { type: 'device', id: 'worker-a' }, actor: 'maks' });
  await store.editTicket('ABC-1', { actor: 'maks', assignee: { type: 'device', id: 'worker-b' } });
  assert.equal(await store.claimNext({ project: 'ABC', device: 'worker-a' }), null);
  const claim = await store.claimNext({ project: 'ABC', device: 'worker-b' }); await store.release('ABC-1', identity(claim));
  assert.ok(await store.claimNext({ project: 'ABC', device: 'worker-b' }));
  assert.equal('execution_authority' in await store.getTicket('ABC-1'), false);
});

test('structured blockers prevent relaunch until a human resolves them', async () => {
  const { store } = await fixture(); await store.createProject('ABC');
  await store.createTicket({ project: 'ABC', title: 'Blocked', assignee: { type: 'device', id: 'worker-a' }, actor: 'maks' });
  const claim = await store.claimNext({ project: 'ABC', device: 'worker-a' });
  const blocked = await store.blockTicket('ABC-1', { ...identity(claim), reason: 'Need review' });
  assert.equal(blocked.ticket.unresolved_blockers, 1);
  await store.release('ABC-1', identity(claim));
  assert.equal(await store.claimNext({ project: 'ABC', device: 'worker-a' }), null);
  await store.resolveBlock('ABC-1', blocked.block.id, { actor: 'maks' });
  assert.ok(await store.claimNext({ project: 'ABC', device: 'worker-a' }));
});

test('competing claims are atomic across independent SQLite connections', async () => {
  const { store, file, ticket } = await seeded();
  const other = new Store(file);
  await other.init();
  const outcomes = await Promise.allSettled([
    store.claim(ticket.id, { device: 'worker-a' }),
    other.claim(ticket.id, { device: 'worker-a' })
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

test('human edits every ticket field while assignment remains distinct from the active claim', async () => {
  const { store, ticket } = await seeded();
  await store.createProject('XYZ');
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const edited = await store.editTicket(ticket.id, { title: 'Moved', body: '**new** body', project: 'XYZ', assignee: { type: 'actor', id: 'worker-b' }, actor: 'maks' });
  assert.equal(edited.id, ticket.id);
  assert.equal(edited.project, 'XYZ');
  assert.equal(edited.title, 'Moved');
  assert.equal(edited.body, '**new** body');
  assert.deepEqual(edited.assignee, { type: 'device', id: 'worker-b' });
  assert.equal(edited.claim.claim_id, claim.ticket.claim.claim_id);
  assert.equal(edited.claim.actor, 'worker-a');
  const events = (await store.listEvents({ ticket: ticket.id })).events.slice(2);
  assert.deepEqual(events.map((event) => event.type), ['claimed', 'ticket_edited', 'ticket_moved', 'assigned']);
  assert.ok(events.filter((event) => event.type !== 'claimed').every((event) => event.actor === 'maks'));
});

test('human direct state changes fence claims and progress stays in the ticket event chronology', async () => {
  const { store, ticket, advance } = await seeded();
  await store.claim(ticket.id, { actor: 'worker-a' });
  const review = await store.setTicketState(ticket.id, { state: 'review', actor: 'maks' });
  assert.equal(review.state, 'review'); assert.equal(review.claim, null);
  advance(1000);
  const progress = await store.appendTicketEvent(ticket.id, { actor: 'maks', message: 'Human **progress** note.' });
  assert.equal(progress.event.type, 'progress'); assert.equal(progress.event.actor, 'maks');
  await store.setTicketState(ticket.id, { state: 'done', actor: 'maks' });
  await store.setTicketState(ticket.id, { state: 'open', actor: 'maks' });
  const events = (await store.listEvents({ ticket: ticket.id })).events.filter((event) => ['state_changed', 'progress'].includes(event.type));
  assert.deepEqual(events.map((event) => event.type), ['state_changed', 'progress', 'state_changed', 'state_changed']);
  assert.ok(events.every((event) => event.actor === 'maks' && event.created_at && event.message));
});

test('direct state override resolves a pending approval instead of leaving a stale inbox question', async () => {
  const { store, ticket } = await seeded(); const claim = await store.claim(ticket.id, { actor: 'worker-a' }); const submitted = await store.submit(ticket.id, { ...identity(claim), reviewer: { type: 'actor', id: 'maks' } });
  await store.setTicketState(ticket.id, { state: 'open', actor: 'maks' });
  const question = (await store.listQuestions(ticket.id)).questions.find((item) => item.id === submitted.question.id);
  assert.equal(question.status, 'answered'); assert.equal(JSON.parse(question.answer).decision, 'request_changes');
  const answer = (await store.listEvents({ ticket: ticket.id })).events.find((event) => event.type === 'question_answered'); assert.equal(answer.metadata.question_event_id, question.question_event_id);
});

test('archive is reversible while confirmed delete tombstones without erasing history', async () => {
  const { store, ticket } = await seeded(); const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const archived = await store.archiveTicket(ticket.id, { actor: 'maks' }); assert.ok(archived.archived_at); assert.equal(archived.claim, null); await assert.rejects(store.verify(ticket.id, identity(claim)), (error) => error.code === 'stale_claim');
  assert.deepEqual(await store.listTickets('ABC'), []); assert.equal(await store.next({ project: 'ABC', device: 'worker-a' }), null); await assert.rejects(store.claim(ticket.id, { actor: 'worker-a' }), (error) => error.code === 'ticket_ineligible');
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
  const claim = await store.claim(ticket.id, { actor: 'worker-a' });
  const asked = await store.askQuestion(ticket.id, { ...identity(claim), text: 'Still active?', target_type: 'actor', target_id: 'maks' });
  await store.archiveTicket(ticket.id, { actor: 'maks' });
  assert.deepEqual((await store.actorInbox('maks')).questions, []);
  for (const operation of [
    () => store.editTicket(ticket.id, { actor: 'maks', title: 'archived edit' }),
    () => store.setTicketState(ticket.id, { actor: 'maks', state: 'done' }),
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
  await store.init(); await store.createProject('ABC'); await store.createActor({ id: 'maks', name: 'Maks', kind: 'human' });
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
    () => store.setTicketState(ticket.id, { actor: 'maks', state: 'done' }),
    () => store.appendTicketEvent(ticket.id, { actor: 'maks', message: 'zombie' }),
    () => store.askHumanQuestion(ticket.id, { actor: 'maks', text: 'zombie?', target_type: 'actor', target_id: 'worker-a' }),
    () => store.accept(ticket.id, { actor: 'maks' }),
    () => store.reopen(ticket.id, { actor: 'maks' })
  ]) await assert.rejects(operation(), (error) => error.code === 'ticket_deleted');
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.map((event) => event.type), ['ticket_created', 'assigned', 'deleted']);
});

test('ticket edit and assignment retain the minimal canonical fields and record events', async () => {
  const { store, ticket } = await seeded();
  const edited = await store.editTicket(ticket.id, { title: 'Updated', body: 'new body', assigned_to: null, actor: 'maks' });
  assert.equal(edited.title, 'Updated');
  assert.equal(edited.body, 'new body');
  assert.equal(edited.assigned_to, null);
  assert.deepEqual((await store.listEvents({ ticket: ticket.id })).events.map((event) => event.type), ['ticket_created', 'assigned', 'ticket_edited', 'assigned']);
});
