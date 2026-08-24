import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

test('POST /v1/tickets creates a Human ticket with a persisted large board order', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-ticket-create-live-shape-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file, { now: () => 1_700_000_000_000 });
  await store.init();
  const { credential } = await store.bootstrapCoordinator({ id: 'fixture-admin', name: 'Fixture Admin' });
  await store.createProject('FIX');
  await store.createTicket({ project: 'FIX', title: 'Existing ticket' });
  await store.close();

  const db = new DatabaseSync(file);
  db.prepare('UPDATE tickets SET board_order=? WHERE id=?').run(1_700_000_000_000_000_001n, 'FIX-1');
  db.close();

  const app = await createApp({ storage: file });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.address().port}/v1/tickets`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'FIX', title: 'Normal Human ticket', assignment: 'Human' }),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.ticket.id, 'FIX-2');
  assert.equal(body.ticket.assignment, 'Human');
  assert.equal(typeof body.ticket.board_order, 'number');
  assert.ok(Number.isFinite(body.ticket.board_order));
});
