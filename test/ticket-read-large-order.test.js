import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const oversizedOrder = 1_787_391_622_098_000_005n;

test('paired worker reads next and project tickets with a board order above Number.MAX_SAFE_INTEGER', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-ticket-read-live-shape-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file);
  await store.init();
  await store.bootstrapCoordinator({ id: 'fixture-admin', name: 'Fixture Admin' });
  const pairing = await store.createPairingCode('fixture-admin', { intended_kind: 'worker' });
  const { credential } = await store.pairDevice({ code: pairing.code, id: 'tower-worker', name: 'Tower Worker' });
  await store.createProject('FIX');
  await store.createTicket({ project: 'FIX', title: 'Oversized order ticket', assignment: 'Agent' });
  await store.close();

  const db = new DatabaseSync(file);
  db.prepare('UPDATE tickets SET board_order=? WHERE id=?').run(oversizedOrder, 'FIX-1');
  assert.equal(db.prepare('SELECT CAST(board_order AS TEXT) value FROM tickets WHERE id=?').get('FIX-1').value, oversizedOrder.toString());
  db.close();

  const app = await createApp({ storage: file });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const get = (route) => fetch(`http://127.0.0.1:${app.address().port}${route}`, {
    headers: { authorization: `Bearer ${credential}` },
  });

  const [next, list] = await Promise.all([
    get('/v1/tickets/next?project=FIX'),
    get('/v1/projects/FIX/tickets'),
  ]);
  assert.deepEqual([next.status, list.status], [200, 200]);
  assert.equal((await next.json()).ticket.id, 'FIX-1');
  assert.deepEqual((await list.json()).tickets.map((ticket) => ticket.id), ['FIX-1']);
});
