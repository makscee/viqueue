import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

async function legacyFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-release-legacy-project-'));
  const file = path.join(dir, 'viqueue.sqlite');
  const store = new Store(file); await store.init();
  await store.createProject('VV'); await store.createProject('VIQ');
  await store.createRole({ id: 'reviewers', name: 'Reviewers' });
  await store.createActor({ id: 'reviewer', name: 'Reviewer', kind: 'human', role_id: 'reviewers' });
  await store.createTicket({ project: 'VV', title: 'preserved title', description: 'preserved body' });
  await store.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE tickets SET assignee_type='role',assignee_id='reviewers',deleted_at=updated_at WHERE id='VV-1'").run();
  db.prepare("INSERT INTO ticket_projects(ticket_id,project_key) VALUES('VV-1','VIQ')").run();
  db.exec('ALTER TABLE tickets DROP COLUMN assignment; PRAGMA user_version=10');
  db.close();
  return { dir, file };
}

function logicalState(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => name);
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all().map((row) => ({ ...row })),
      rows: Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((row) => ({ ...row }))]))
    };
  } finally { db.close(); }
}

async function assertFailsWithoutMutation(file, mutate, code = 'unsafe_project_migration') {
  const db = new DatabaseSync(file); mutate(db); db.close();
  const before = logicalState(file), bytes = await readFile(file);
  const store = new Store(file);
  await assert.rejects(store.init(), (error) => error.code === code);
  await store.close();
  assert.deepEqual(logicalState(file), before);
  assert.deepEqual(await readFile(file), bytes);
}

test('release legacy multi-project row migrates to its authoritative canonical project without identity or content loss', async () => {
  const { file } = await legacyFixture();
  const before = logicalState(file);
  const beforeTicket = before.rows.tickets.find(({ id }) => id === 'VV-1');
  const beforeEvents = before.rows.events.filter(({ ticket_id }) => ticket_id === 'VV-1');

  let store = new Store(file); await store.init();
  let migratedDb = new DatabaseSync(file, { readOnly: true });
  const migrated = migratedDb.prepare("SELECT id,project,title,body,assignment,deleted_at FROM tickets WHERE id='VV-1'").get(); migratedDb.close();
  assert.deepEqual({ ...migrated, deleted_at: migrated.deleted_at !== null },
    { id: 'VV-1', project: 'VV', title: beforeTicket.title, body: beforeTicket.body, assignment: 'Human', deleted_at: true });
  assert.equal((await store.createTicket({ project: 'VV', title: 'monotonic successor' })).id, 'VV-2');
  await store.close();

  let db = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(db.prepare("SELECT project_key FROM ticket_projects WHERE ticket_id='VV-1' ORDER BY project_key").all().map(({ project_key }) => project_key), ['VV']);
  assert.deepEqual(db.prepare("SELECT * FROM events WHERE ticket_id='VV-1' ORDER BY id").all().map((row) => ({ ...row })), beforeEvents);
  const preservedTicketColumns = Object.keys(beforeTicket).map((column) => `"${column}"`).join(',');
  assert.deepEqual({ ...db.prepare(`SELECT ${preservedTicketColumns} FROM tickets WHERE id='VV-1'`).get() }, beforeTicket);
  assert.equal(db.prepare("SELECT next_number FROM projects WHERE key='VV'").get().next_number, 3);
  db.close();

  store = new Store(file); await store.init(); await store.close();
  db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM ticket_projects WHERE ticket_id='VV-1'").get().n, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0); db.close();
});

test('release legacy project inference rejects conflicting, malformed, missing and ambiguous provenance atomically', async (t) => {
  const cases = [
    ['conflicting event project', (db) => { db.exec('DROP TRIGGER events_immutable_update'); db.prepare("UPDATE events SET project='VIQ' WHERE ticket_id='VV-1'").run(); }],
    ['multiple event project candidates', (db) => db.prepare("INSERT INTO events(ticket_id,project,type,created_at) VALUES('VV-1','VIQ','legacy-conflict',2)").run()],
    ['missing canonical membership', (db) => db.prepare("DELETE FROM ticket_projects WHERE ticket_id='VV-1' AND project_key='VV'").run()],
    ['missing canonical project', (db) => { db.exec('PRAGMA foreign_keys=OFF'); db.prepare("DELETE FROM projects WHERE key='VV'").run(); }],
    ['malformed canonical identity', (db) => { db.exec('PRAGMA foreign_keys=OFF; DROP TRIGGER deleted_tickets_immutable'); db.prepare("UPDATE tickets SET id='VV-malformed' WHERE id='VV-1'").run(); }, 'unsafe_project_migration'],
    ['conflicting canonical tuple', (db) => { db.exec('DROP TRIGGER deleted_tickets_immutable'); db.prepare("UPDATE tickets SET number=2 WHERE id='VV-1'").run(); }, 'unsafe_ticket_identity_migration']
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async () => {
    const { file } = await legacyFixture();
    await assertFailsWithoutMutation(file, mutate, code);
  });
});
