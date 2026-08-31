import { claimNextWithSession } from './helpers/worker-session.js';
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
const identity = (claim) => ({ claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, generation: claim.ticket.claim.generation, claim_token: claim.claim_token, device: claim.ticket.claim.device_id, session_capability: claim.session_capability });

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

test('one-project tickets reject legacy memberships and preserve claim authority across paired devices', async () => {
  const f = await fixture(); for (const key of ['ONE','TWO']) await f.store.createProject(key);
  await assert.rejects(f.store.createTicket({ projects: ['ONE','TWO'], project: 'ONE', title: 'legacy' }), (e) => e.code === 'invalid_ticket_fields');
  const ticket = await f.store.createTicket({ project: 'ONE', title: 'agent work', assignment: 'Agent', actor: 'mair' });
  assert.deepEqual((await f.store.listTickets('ONE')).map((t) => t.id), [ticket.id]); assert.deepEqual(await f.store.listTickets('TWO'), []);
  const claim = await claimNextWithSession(f.store, { project: 'ONE', device: 'worker-one' });
  await assert.rejects(f.store.verify(ticket.id, { ...identity(claim), device: 'worker-two' }), (error) => error.code === 'stale_claim');
  await assert.rejects(f.store.postEvent(ticket.id, { ...identity(claim), device: 'worker-two', message: 'continued' }), (error) => error.code === 'stale_claim');
  await f.store.close();
});

test('unscoped claimNext crosses projects for generic Agent work and exact creation is retired', async () => {
  const f = await fixture(); for (const key of ['ONE','TWO']) await f.store.createProject(key);
  await assert.rejects(f.store.createTicket({ project: 'ONE', title: 'exact', assignment: 'Agent', worker_actor_id: 'other', actor: 'mair' }), (error) => error.code === 'invalid_ticket_fields');
  const generic = await f.store.createTicket({ project: 'TWO', title: 'generic cross-project work', assignment: 'Agent', actor: 'mair' });
  const claim = await claimNextWithSession(f.store, { device: 'worker-one' });
  assert.equal(claim.ticket.id, generic.id); assert.equal(claim.ticket.project, 'TWO');
  await f.store.close();
});

test('claimNext honors an explicit project while unscoped next keeps authoritative global order', async () => {
  const f = await fixture(); for (const key of ['ONE','TWO']) await f.store.createProject(key);
  const ticket = await f.store.createTicket({ project: 'ONE', title: 'canonical membership', assignment: 'Agent', actor: 'mair' });
  assert.equal((await f.store.next({ project: 'TWO', device: 'worker-one' })).id, ticket.id);
  assert.equal(await claimNextWithSession(f.store, { project: 'TWO', device: 'worker-one' }), null);
  assert.equal((await claimNextWithSession(f.store, { project: 'ONE', device: 'worker-one' })).ticket.id, ticket.id);
  await f.store.close();
});

test.skip('VIQ-13+ excluded: legacy compact Admin/archive/question popup contract', { skip: 'VIQ-12 four-lane filters and modal behavior have current unit and browser E2E coverage' }, async () => {
  assert.deepEqual(boardColumns.map((column) => column[1]), ['To do','Working','Review','Done']);
  assert.equal(boardProjection({ state: 'open', claim: null }), 'todo'); assert.equal(boardProjection({ state: 'open', claim: {} }), 'working');
  const ticket = { id: 'ONE-1', project: 'ONE', projects: ['ONE','TWO'], assignee: null };
  assert.equal(applyTicketFilters([ticket], new Set(['TWO']), new Set()).length, 1);
  assert.equal(dedupeTickets([ticket, ticket]).length, 1); assert.deepEqual([...selectProject(['ONE','TWO'], new Set(['ONE']), 'TWO')].sort(), ['ONE','TWO']);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const id of ['open-questions','open-archive','open-device-management']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /data-tab="archived"|data-tab="waiting"|data-tab="ready"/);
});
