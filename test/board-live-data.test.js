import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

test('GET /v1/board reads populated v11 board orders larger than a safe integer', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-board-live-shape-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file, { now: () => 1_700_000_000_000 });
  await store.init();
  const { credential } = await store.bootstrapCoordinator({ id: 'fixture-admin', name: 'Fixture Admin' });
  await store.createProject('FIX');
  await store.createTicket({ project: 'FIX', title: 'Sanitized large-order fixture' });
  await store.createTicket({ project: 'FIX', title: 'Sanitized safe-order fixture' });
  await store.close();

  const db = new DatabaseSync(file);
  db.prepare('UPDATE tickets SET board_order=? WHERE id=?').run(1_700_000_000_000_000_001n, 'FIX-1');
  db.prepare('UPDATE tickets SET board_order=? WHERE id=?').run(42, 'FIX-2');
  db.close();

  const app = await createApp({ storage: file });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const endpoint = `http://127.0.0.1:${app.address().port}/v1/board`;
  assert.equal((await fetch(endpoint)).status, 401);

  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${credential}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.tickets.map((ticket) => ticket.id), ['FIX-1', 'FIX-2']);
  assert.deepEqual(body.tickets.map((ticket) => typeof ticket.board_order), ['number', 'number']);
  assert.ok(body.tickets.every((ticket) => Number.isFinite(ticket.board_order)));
});
