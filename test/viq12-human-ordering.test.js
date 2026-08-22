import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { applyTicketFilters } from '../web/ui-core.js';

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
  const filtered = applyTicketFilters(await store.listBoardTickets(), new Set(['VIQ','OPS']), new Set(['Human']));
  assert.deepEqual(filtered.map(({ id }) => id), ['VIQ-2', 'VIQ-1']);
  advance(); await store.editTicket('VIQ-1', { actor: 'human', title: 'updated first' });
  assert.deepEqual((await store.listBoardTickets()).map(({ id }) => id), ['VIQ-1', 'VIQ-2', 'OPS-1']);
  await store.close();
});

test('VIQ-12 persists Human movement and manual reorder in every lane', async () => {
  const { store } = await fixture();
  for (const title of ['one','two','three']) await store.createTicket({ project: 'VIQ', title, assignment: 'Human' });
  await store.moveHumanTicket('VIQ-1', { state: 'Working', index: 0, actor: 'human' });
  await store.moveHumanTicket('VIQ-2', { state: 'Working', index: 0, actor: 'human' });
  assert.deepEqual((await store.listBoardTickets()).filter(({ state }) => state === 'Working').map(({ id }) => id), ['VIQ-2','VIQ-1']);
  await store.moveHumanTicket('VIQ-1', { state: 'Working', index: 0, actor: 'human' });
  assert.deepEqual((await store.listBoardTickets()).filter(({ state }) => state === 'Working').map(({ id }) => id), ['VIQ-1','VIQ-2']);
  for (const lane of ['Waiting','Done','Open']) assert.equal((await store.moveHumanTicket('VIQ-1', { state: lane, index: 0, actor: 'human' })).state, lane);
  await assert.rejects(store.moveHumanTicket('VIQ-3', { state: 'Open', index: -1, actor: 'human' }), (error) => error.code === 'invalid_position');
  const agent = await store.createTicket({ project: 'OPS', title: 'agent', assignment: 'Agent' });
  await assert.rejects(store.moveHumanTicket(agent.id, { state: 'Done', index: 0, actor: 'human' }), (error) => error.code === 'human_assignment_required');
  await store.close();
});
