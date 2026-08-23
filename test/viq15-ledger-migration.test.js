import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/store.js';

test('existing event ledgers gain best-effort provenance snapshots and immutable triggers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq15-ledger-upgrade-')); const file = path.join(dir, 'data.sqlite');
  const store = new Store(file); await store.init();
  const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Original machine' });
  await store.createRole({ id: 'original-role', name: 'Original role', actor: 'coord' });
  await store.grantDeviceRole('coord', 'original-role', 'coord');
  await store.createProject('ABC'); await store.createTicket({ project: 'ABC', title: 'Existing row', actor: 'coord' });
  await store.close();

  const legacy = new DatabaseSync(file);
  legacy.exec('DROP TRIGGER events_immutable_update; DROP TRIGGER events_immutable_delete; ALTER TABLE events DROP COLUMN actor_role; ALTER TABLE events DROP COLUMN machine_name;');
  assert.equal(legacy.prepare("SELECT COUNT(*) n FROM pragma_table_info('events') WHERE name IN ('actor_role','machine_name')").get().n, 0);
  legacy.close();

  const upgraded = new Store(file); await upgraded.init(); await upgraded.close();
  const db = new DatabaseSync(file);
  const snapshot = db.prepare("SELECT actor_role,machine_name FROM events WHERE ticket_id='ABC-1' AND type='ticket_created'").get();
  assert.equal(snapshot.actor_role, 'original-role'); assert.equal(snapshot.machine_name, 'Original machine');
  assert.throws(() => db.prepare("UPDATE events SET message='tamper' WHERE ticket_id='ABC-1'").run(), /events are immutable/);
  assert.throws(() => db.prepare("DELETE FROM events WHERE ticket_id='ABC-1'").run(), /events are immutable/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE ticket_id='ABC-1' AND type='ticket_created'").get().n, 1);
  db.close();
});
