import { claimWithSession } from './helpers/worker-session.js';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { activityFact, applyActivityFilters, applyTicketFilters } from '../web/ui-core.js';

async function fixture() {
  let now = 1000; const dir = await mkdtemp(path.join(tmpdir(), 'viq12-')); const store = new Store(path.join(dir, 'data.sqlite'), { now: () => now });
  await store.init(); await store.createActor({ id: 'human', name: 'Human', kind: 'human' }); const coordinator = await store.bootstrapCoordinator({ id: 'human', name: 'Human' });
  await store.createProject('VIQ'); await store.createProject('OPS');
  return { store, coordinator, advance: () => { now += 1; } };
}

test('VIQ-12 global order is updated-first and filters reveal an OR subsequence', async () => {
  const { store, advance } = await fixture();
  await store.createTicket({ project: 'VIQ', title: 'first', assignment: 'Human' }); advance();
  await store.createTicket({ project: 'OPS', title: 'second', assignment: 'Agent' }); advance();
  await store.createTicket({ project: 'VIQ', title: 'third', assignment: 'Human' });
  assert.deepEqual((await store.listBoardTickets()).map(({ id }) => id), ['VIQ-2', 'OPS-1', 'VIQ-1']);
  assert.deepEqual(applyTicketFilters(await store.listBoardTickets(), new Set(['VIQ','OPS']), new Set(['Human'])).map(({ id }) => id), ['VIQ-2', 'VIQ-1']);
  advance(); await store.editTicket('VIQ-1', { actor: 'human', title: 'updated first' });
  assert.deepEqual((await store.listBoardTickets()).map(({ id }) => id), ['VIQ-1', 'VIQ-2', 'OPS-1']); await store.close();
});

test('VIQ-12 persists Human movement and manual reorder in every lane', async () => {
  const { store } = await fixture(); for (const title of ['one','two','three']) await store.createTicket({ project: 'VIQ', title, assignment: 'Human' });
  await store.moveHumanTicket('VIQ-1', { state: 'Working', index: 0, visible_ids: [], actor: 'human' });
  await store.moveHumanTicket('VIQ-2', { state: 'Working', index: 0, visible_ids: ['VIQ-1'], actor: 'human' });
  assert.deepEqual((await store.listBoardTickets()).filter(({ state }) => state === 'Working').map(({ id }) => id), ['VIQ-2','VIQ-1']);
  await store.moveHumanTicket('VIQ-1', { state: 'Working', index: 0, visible_ids: ['VIQ-2'], actor: 'human' });
  assert.deepEqual((await store.listBoardTickets()).filter(({ state }) => state === 'Working').map(({ id }) => id), ['VIQ-1','VIQ-2']);
  for (const lane of ['Waiting','Done','Open']) assert.equal((await store.moveHumanTicket('VIQ-1', { state: lane, index: 0, visible_ids: [], actor: 'human' })).state, lane);
  await assert.rejects(store.moveHumanTicket('VIQ-3', { state: 'Open', index: -1, visible_ids: [], actor: 'human' }), (error) => error.code === 'invalid_position');
  const agent = await store.createTicket({ project: 'OPS', title: 'agent', assignment: 'Agent' });
  await assert.rejects(store.moveHumanTicket(agent.id, { state: 'Done', index: 0, visible_ids: [], actor: 'human' }), (error) => error.code === 'human_assignment_required'); await store.close();
});

test('VIQ-12 filtered reorder changes the visible subsequence and preserves hidden relative order', async () => {
  const { store } = await fixture();
  await store.createTicket({ project: 'VIQ', title: 'visible low', assignment: 'Human' }); await store.createTicket({ project: 'OPS', title: 'hidden low', assignment: 'Agent' });
  await store.createTicket({ project: 'VIQ', title: 'visible high', assignment: 'Human' }); await store.createTicket({ project: 'OPS', title: 'hidden high', assignment: 'Agent' });
  assert.deepEqual((await store.listBoardTickets()).map(({ id }) => id), ['OPS-2','VIQ-2','OPS-1','VIQ-1']);
  await store.moveHumanTicket('VIQ-1', { state: 'Open', index: 0, visible_ids: ['VIQ-2'], actor: 'human' });
  assert.deepEqual((await store.listBoardTickets()).map(({ id }) => id), ['OPS-2','VIQ-1','OPS-1','VIQ-2']); await store.close();
});

test('VIQ-12 reorder preserves claimed and all other unaffected relative positions', async () => {
  const { store } = await fixture(); await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' });
  const code = await store.createPairingCode('human', { actor_id: 'worker', intended_kind: 'worker', device_id: 'worker-device', device_name: 'Worker device' });
  const worker = await store.pairDevice({ code: code.code, id: 'worker-device', name: 'Worker device' });
  await store.createTicket({ project: 'VIQ', title: 'human low', assignment: 'Human' }); const claimed = await store.createTicket({ project: 'OPS', title: 'claimed middle', assignment: 'Agent' });
  await claimWithSession(store, claimed.id, { device: worker.device.id }); await store.createTicket({ project: 'VIQ', title: 'human high', assignment: 'Human' }); await store.createTicket({ project: 'OPS', title: 'unclaimed high', assignment: 'Agent' });
  const before = (await store.listBoardTickets()).map(({ id }) => id); assert.deepEqual(before, ['OPS-2','VIQ-2','OPS-1','VIQ-1']);
  await store.moveHumanTicket('VIQ-1', { state: 'Open', index: 0, visible_ids: ['VIQ-2'], actor: 'human' });
  const after = (await store.listBoardTickets()).map(({ id }) => id); assert.deepEqual(after, ['OPS-2','VIQ-1','OPS-1','VIQ-2']); assert.equal((await store.getTicket(claimed.id)).state, 'Working'); await store.close();
});

test('VIQ-12 Working reorder uses effective lane membership when a claimed Agent ticket is visible', async () => {
  const { store } = await fixture(); await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' });
  const code = await store.createPairingCode('human', { actor_id: 'worker', intended_kind: 'worker', device_id: 'worker-device', device_name: 'Worker device' });
  const worker = await store.pairDevice({ code: code.code, id: 'worker-device', name: 'Worker device' });
  const humanLow = await store.createTicket({ project: 'VIQ', title: 'human low', assignment: 'Human' });
  const claimed = await store.createTicket({ project: 'OPS', title: 'claimed Agent', assignment: 'Agent' });
  const claim = await claimWithSession(store, claimed.id, { device: worker.device.id });
  const humanHigh = await store.createTicket({ project: 'VIQ', title: 'human high', assignment: 'Human' });

  await store.moveHumanTicket(humanLow.id, { state: 'Working', index: 1, visible_ids: [claimed.id], actor: 'human' });
  assert.deepEqual((await store.listBoardTickets()).filter(({ state }) => state === 'Working').map(({ id }) => id), [claimed.id, humanLow.id]);
  const beforeReorder = (await store.listBoardTickets()).map(({ id }) => id);
  await store.moveHumanTicket(humanLow.id, { state: 'Working', index: 0, visible_ids: [claimed.id], actor: 'human' });
  const afterReorder = (await store.listBoardTickets()).map(({ id }) => id);
  assert.deepEqual(afterReorder.filter((id) => id !== humanLow.id), beforeReorder.filter((id) => id !== humanLow.id));
  assert.deepEqual(afterReorder.filter((id) => [humanLow.id, claimed.id].includes(id)), [humanLow.id, claimed.id]);
  assert.equal((await store.getTicket(claimed.id)).claim.claim_id, claim.ticket.claim.claim_id);
  const beforeRejectedMove = [...afterReorder];
  await assert.rejects(store.moveHumanTicket(claimed.id, { state: 'Working', index: 0, visible_ids: [humanLow.id], actor: 'human' }), (error) => error.code === 'human_assignment_required');
  assert.deepEqual((await store.listBoardTickets()).map(({ id }) => id), beforeRejectedMove);
  assert.equal((await store.getTicket(humanHigh.id)).state, 'Open'); await store.close();
});

test('VIQ-12 Activity obeys both scopes and projects only minimal facts', () => {
  const tickets = [{ id: 'VIQ-1', project: 'VIQ', assignment: 'Human' }, { id: 'OPS-1', project: 'OPS', assignment: 'Agent' }, { id: 'VIQ-2', project: 'VIQ', assignment: 'Agent' }];
  const events = [{ cursor: 10, ticket_id: null, project: null, type: 'device_paired', actor: 'admin', message: 'secret prose' }, { cursor: 11, ticket_id: 'VIQ-1', project: 'VIQ', type: 'progress', actor: 'human', message: 'arbitrary human prose' }, { cursor: 12, ticket_id: 'OPS-1', project: 'OPS', type: 'claimed', actor: 'agent' }, { cursor: 13, ticket_id: 'VIQ-2', project: 'VIQ', type: 'ticket_created', actor: null }];
  const projects = new Set(['VIQ']); const roles = new Set(['Human']); const visible = applyTicketFilters(tickets, projects, roles);
  const filtered = applyActivityFilters(events, visible, projects, roles, ['VIQ','OPS']);
  assert.deepEqual(filtered.map((event) => event.cursor), [10, 11]);
  assert.deepEqual(filtered.map((event) => event.type), ['device_paired', 'progress']);
  assert.deepEqual(activityFact(events[1]), { heading: 'VIQ-1 · progress', detail: 'Actor: human' }); assert.equal(JSON.stringify(activityFact(events[1])).includes('arbitrary human prose'), false);
  assert.equal(applyActivityFilters(events, tickets, new Set(['VIQ','OPS']), new Set(), ['VIQ','OPS']).length, 4);
});
