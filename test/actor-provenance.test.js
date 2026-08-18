import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store } from '../src/store.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-provenance-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file);
  await store.init();
  await store.createProject('ABC');
  await store.createProject('XYZ');
  await store.createActor({ id: 'maks', name: 'Maks', kind: 'human' });
  await store.createActor({ id: 'inactive', name: 'Inactive', kind: 'human' });
  await store.deactivateActor('inactive');
  const ticket = await store.createTicket({ project: 'ABC', title: 'Original' });
  return { store, file, ticket };
}

const editEvents = async (store, ticketId) => (await store.listEvents({ ticket: ticketId })).events.filter((event) => ['ticket_edited', 'ticket_moved', 'assigned'].includes(event.type));

test('ticket edit fails closed when actor is missing', async () => {
  const { store, ticket } = await fixture();
  await assert.rejects(store.editTicket(ticket.id, { title: 'Missing author' }), (error) => error.code === 'actor_not_found');
  assert.equal((await store.getTicket(ticket.id)).title, 'Original');
  assert.deepEqual(await editEvents(store, ticket.id), []);
});

test('ticket edit rejects an unknown actor', async () => {
  const { store, ticket } = await fixture();
  await assert.rejects(store.editTicket(ticket.id, { title: 'Unknown author', actor: 'invented-name' }), (error) => error.code === 'actor_not_found');
  assert.equal((await store.getTicket(ticket.id)).title, 'Original');
});

test('ticket edit rejects an inactive actor', async () => {
  const { store, ticket } = await fixture();
  await assert.rejects(store.editTicket(ticket.id, { title: 'Inactive author', actor: 'inactive' }), (error) => error.code === 'actor_inactive');
  assert.equal((await store.getTicket(ticket.id)).title, 'Original');
});

test('valid human edit records the validated canonical actor', async () => {
  const { store, ticket } = await fixture();
  await store.editTicket(ticket.id, { title: 'Human edit', actor: 'Maks' });
  const events = await editEvents(store, ticket.id);
  assert.deepEqual(events.map((event) => [event.type, event.actor]), [['ticket_edited', 'maks']]);
});

test('project move and persisted history retain the validated actor', async () => {
  const { store, file, ticket } = await fixture();
  await store.editTicket(ticket.id, { project: 'XYZ', actor: 'MAKS' });
  assert.equal((await store.getTicket(ticket.id)).project, 'XYZ');
  await store.close();
  const reopened = new Store(file); await reopened.init();
  const events = await editEvents(reopened, ticket.id);
  assert.deepEqual(events.map((event) => [event.type, event.actor]), [['ticket_moved', 'maks']]);
  await reopened.close();
});
