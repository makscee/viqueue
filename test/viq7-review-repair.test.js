import { claimWithSession } from './helpers/worker-session.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store } from '../src/store.js';

async function fixture({ now } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq7-repair-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file, now ? { now } : undefined);
  await store.init();
  await store.createProject('ABC');
  await store.createActor({ id: 'maks', name: 'Maks', kind: 'human' });
  await store.createActor({ id: 'eva', name: 'Eva', kind: 'human' });
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' });
  await store.bootstrapCoordinator({ id: 'maks', name: 'Maks' });
  const pairing = await store.createPairingCode('maks', { intended_kind: 'worker' });
  await store.pairDevice({ code: pairing.code, id: 'worker', name: 'Worker' });
  return { store, file };
}

const identity = (claim) => ({ claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, generation: claim.ticket.claim.generation, claim_token: claim.claim_token, device: claim.ticket.claim.device_id, session_capability: claim.session_capability });

test('direct history edit is human-only while agent progress remains claim-authorized', async () => {
  const { store } = await fixture();
  const ticket = await store.createTicket({ project: 'ABC', title: 'Authority', actor: 'maks', assignment:'Agent' });
  const claim = await claimWithSession(store, ticket.id, { actor: 'worker' });
  await assert.rejects(store.editTicket(ticket.id, { actor: 'worker', title: 'Machine edit' }), (error) => error.code === 'coordinator_required');
  const progress = await store.postEvent(ticket.id, { ...identity(claim), message: 'Claim-authorized progress' });
  assert.equal(progress.event.actor, 'worker');
  assert.equal((await store.getTicket(ticket.id)).title, 'Authority');
  const direct = await store.createTicket({ project: 'ABC', title: 'Direct lifecycle', actor: 'maks' }); await store.setTicketState(direct.id, { actor: 'maks', state: 'Done' });
  await assert.rejects(store.reopen(direct.id, { actor: 'worker' }), (error) => error.code === 'human_required');
});

test('human ticket creator is validated and persisted on ticket_created', async () => {
  const { store, file } = await fixture();
  const ticket = await store.createTicket({ project: 'ABC', title: 'Created by human', actor: 'Maks' });
  await store.close();
  const reopened = new Store(file); await reopened.init();
  const created = (await reopened.listEvents({ ticket: ticket.id })).events.find((event) => event.type === 'ticket_created');
  assert.equal(created.actor, 'maks');
  await reopened.close();
});

test('archived ticket is immutable and absent from inbox until explicit restore', async () => {
  const { store } = await fixture();
  const ticket = await store.createTicket({ project: 'ABC', title: 'Archive', actor: 'maks' });
  const question = (await store.askHumanQuestion(ticket.id, { actor: 'maks', text: 'Pending?', target_type: 'actor', target_id: 'eva' })).question;
  await store.archiveTicket(ticket.id, { actor: 'maks' });
  assert.deepEqual((await store.actorInbox('eva')).questions, []);
  const mutations = [
    () => store.editTicket(ticket.id, { actor: 'maks', title: 'No' }),
    () => store.setTicketState(ticket.id, { actor: 'maks', state: 'Done' }),
    () => store.appendTicketEvent(ticket.id, { actor: 'maks', message: 'No' }),
    () => store.askHumanQuestion(ticket.id, { actor: 'maks', text: 'No?', target_type: 'actor', target_id: 'eva' }),
    () => store.answerQuestion(ticket.id, question.id, { actor: 'eva', answer: 'No' }),
    () => claimWithSession(store, ticket.id, { actor: 'worker' }),
    () => store.deleteTicket(ticket.id, { actor: 'maks', confirmed: true })
  ];
  for (const mutation of mutations) await assert.rejects(mutation(), (error) => ['ticket_archived', 'ticket_ineligible'].includes(error.code));
  await store.restoreTicket(ticket.id, { actor: 'maks' });
  assert.deepEqual((await store.actorInbox('eva')).questions.map((item) => item.id), [question.id]);
  await store.editTicket(ticket.id, { actor: 'maks', title: 'Restored edit' });
  assert.equal((await store.getTicket(ticket.id)).title, 'Restored edit');
});

test('archive and delete timestamps use NULL semantics when clock is zero', async () => {
  const { store } = await fixture({ now: () => 0 });
  const ticket = await store.createTicket({ project: 'ABC', title: 'Zero clock', actor: 'maks' });
  assert.equal((await store.archiveTicket(ticket.id, { actor: 'maks' })).archived_at, 0);
  await store.archiveTicket(ticket.id, { actor: 'maks' });
  await assert.rejects(store.editTicket(ticket.id, { actor: 'maks', title: 'No' }), (error) => error.code === 'ticket_archived');
  assert.equal((await store.restoreTicket(ticket.id, { actor: 'maks' })).archived_at, null);
  assert.equal((await store.deleteTicket(ticket.id, { actor: 'maks', confirmed: true })).deleted_at, 0);
  await assert.rejects(store.deleteTicket(ticket.id, { actor: 'maks', confirmed: true }), (error) => error.code === 'ticket_not_found');
  await assert.rejects(store.editTicket(ticket.id, { actor: 'maks', title: 'No' }), (error) => error.code === 'ticket_deleted');
  await assert.rejects(store.listEvents({ ticket: ticket.id }), (error) => error.code === 'ticket_not_found');
  const types = (await store.auditDeletedTicket(ticket.id)).events.map((event) => event.type);
  assert.equal(types.filter((type) => type === 'archived').length, 1);
  assert.equal(types.filter((type) => type === 'deleted').length, 1);
});
