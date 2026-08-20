import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store, DomainError } from '../src/store.js';
import { applyTicketFilters, boardColumns, boardProjection, dedupeTickets, selectProject } from '../web/ui-core.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-v2-')); const store = new Store(path.join(dir, 'db.sqlite')); await store.init();
  const admin = await store.bootstrapCoordinator({ id: 'mair', name: 'Mair' });
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' }, 'mair');
  await store.createActor({ id: 'other', name: 'Other', kind: 'agent' }, 'mair');
  const pair = async (id, actor = 'worker', kind = 'worker') => { const issued = await store.createPairingCode('mair', { actor_id: actor, intended_kind: kind, ttl_ms: 1000 }); return store.pairDevice({ code: issued.code, id, name: id }); };
  const one = await pair('worker-one'); const two = await pair('worker-two'); const other = await pair('other-one', 'other');
  return { store, admin, one, two, other, pair };
}
const identity = (claim) => ({ claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, generation: claim.ticket.claim.generation, claim_token: claim.claim_token });

test('actor-bound pairing, admin capability, role lifecycle, shared identity and immediate revocation', async () => {
  const f = await fixture();
  assert.equal((await f.store.getDevice('worker-one')).actor_id, 'worker');
  assert.equal((await f.store.getDevice('worker-two')).actor_id, 'worker');
  await assert.rejects(f.store.createActor({ id: 'nope', name: 'Nope' }, 'worker-one'), (e) => e instanceof DomainError && e.status === 403);
  await f.store.createRole({ id: 'builder', name: 'Builder', actor: 'mair' });
  await f.store.updateActor('worker', { role_id: 'builder', admin: false }, 'mair');
  await assert.rejects(f.store.deleteRole('builder', 'mair'), (e) => e.code === 'role_in_use' && /actor/.test(e.message));
  await f.store.updateActor('worker', { role_id: null }, 'mair'); await f.store.deleteRole('builder', 'mair');
  await f.store.revokeDevice('worker-one', 'mair');
  await assert.rejects(f.store.authenticateDevice(f.one.credential), (e) => e.code === 'device_revoked');
  assert.equal((await f.store.authenticateDevice(f.two.credential)).actor_id, 'worker');
  await f.store.close();
});

test('multi-project relation lists once per project and free-pool claims prefer explicit assignment', async () => {
  const f = await fixture(); for (const key of ['ONE','TWO']) await f.store.createProject(key);
  const assigned = await f.store.createTicket({ projects: ['ONE','TWO','ONE'], project: 'ONE', title: 'assigned', assignee: { type: 'actor', id: 'worker' }, actor: 'mair' });
  const free = await f.store.createTicket({ projects: ['ONE'], title: 'free', actor: 'mair' });
  await f.store.createTicket({ projects: ['ONE'], title: 'other', assignee: { type: 'actor', id: 'other' }, actor: 'mair' });
  assert.deepEqual(assigned.projects, ['ONE','TWO']);
  assert.deepEqual((await f.store.listTickets('TWO')).map((t) => t.id), [assigned.id]);
  await f.store.editTicket(assigned.id, { actor: 'mair', projects: ['TWO'], project: 'TWO' });
  assert.equal((await f.store.listTickets('ONE')).some((t) => t.id === assigned.id), false);
  await f.store.editTicket(assigned.id, { actor: 'mair', projects: ['ONE','TWO'], project: 'ONE' });
  const first = await f.store.claimNext({ device: 'worker-one' }); assert.equal(first.ticket.id, assigned.id);
  await f.store.release(assigned.id, { ...identity(first), device: 'worker-two' });
  await f.store.editTicket(assigned.id, { actor: 'mair', assignee: { type: 'actor', id: 'other' } });
  const second = await f.store.claimNext({ device: 'worker-one' }); assert.equal(second.ticket.id, free.id);
  await assert.rejects(f.store.claim(assigned.id, { device: 'worker-one' }), (e) => e.code === 'ticket_ineligible');
  const continued = await f.store.verify(free.id, { ...identity(second), device: 'worker-two' }); assert.equal(continued.claim.actor, 'worker');
  await f.store.postEvent(free.id, { ...identity(second), device: 'worker-two', message: 'continued' });
  const events = (await f.store.listEvents({ ticket: free.id })).events; const progress = events.find((e) => e.message === 'continued'); assert.deepEqual([progress.actor, progress.device_id], ['worker','worker-two']);
  await f.store.close();
});

test('compact board contract is four columns, OR project filters, deduplicated tickets and popup surfaces', async () => {
  assert.deepEqual(boardColumns.map((column) => column[1]), ['To do','Working','Review','Done']);
  assert.equal(boardProjection({ state: 'open', claim: null }), 'todo'); assert.equal(boardProjection({ state: 'open', claim: {} }), 'working');
  const ticket = { id: 'ONE-1', project: 'ONE', projects: ['ONE','TWO'], assignee: null };
  assert.equal(applyTicketFilters([ticket], new Set(['TWO']), new Set()).length, 1);
  assert.equal(dedupeTickets([ticket, ticket]).length, 1); assert.deepEqual([...selectProject(['ONE','TWO'], new Set(['ONE']), 'TWO')].sort(), ['ONE','TWO']);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const id of ['open-questions','open-archive','open-device-management']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /data-tab="archived"|data-tab="waiting"|data-tab="ready"/);
});
