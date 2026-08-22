import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

const cli = path.resolve('bin/viq.js');

async function database() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq11-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file); await store.init();
  await store.createActor({ id: 'coord', name: 'Coordinator', kind: 'human' });
  const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  return { dir, file, store, coordinator };
}

test('VIQ-11 store capture uses immutable one-project identity and canonical defaults', async () => {
  const { store } = await database();
  assert.deepEqual(await store.createProject('viq'), { key: 'VIQ', next_number: 1, created_at: (await store.listProjects())[0].created_at });
  const ticket = await store.createTicket({ project: 'VIQ', title: ' Capture ', description: 'details' });
  assert.deepEqual({ id: ticket.id, project: ticket.project, title: ticket.title, description: ticket.description, assignment: ticket.assignment, state: ticket.state }, { id: 'VIQ-1', project: 'VIQ', title: 'Capture', description: 'details', assignment: 'Unassigned', state: 'Open' });
  assert.equal('projects' in ticket, false); assert.equal('assignee' in ticket, false);
  await assert.rejects(store.createTicket({ project: 'VIQ', projects: ['VIQ'], title: 'bad' }), (e) => e.code === 'invalid_ticket_fields');
  await assert.rejects(store.editTicket(ticket.id, { actor: 'coord', project: 'OTHER' }), (e) => e.code === 'immutable_project');
  for (const assignment of ['Human', 'Agent']) assert.equal((await store.createTicket({ project: 'VIQ', title: assignment, assignment })).assignment, assignment);
  for (const assignment of ['', 'human', 'Device']) await assert.rejects(store.createTicket({ project: 'VIQ', title: 'bad', assignment }), (e) => e.code === 'invalid_assignment');
  await store.close();
});

test('VIQ-11 project counter is atomic across connections and never reuses allocation', async () => {
  const { file, store } = await database(); await store.createProject('VIQ');
  const other = new Store(file); await other.init();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : other).createTicket({ project: 'VIQ', title: `T${i}` })));
  assert.deepEqual(results.map((ticket) => ticket.id).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))), Array.from({ length: 20 }, (_, i) => `VIQ-${i + 1}`));
  const db = new DatabaseSync(file); db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DELETE FROM events WHERE ticket_id='VIQ-20'; DELETE FROM ticket_projects WHERE ticket_id='VIQ-20'; DELETE FROM tickets WHERE id='VIQ-20'; COMMIT"); db.close();
  assert.equal((await store.createTicket({ project: 'VIQ', title: 'after gap' })).id, 'VIQ-21');
  await other.close(); await store.close();
});

test('VIQ-11 migration snapshot restores complete pre-migration identity and counters', async () => {
  const { file, store } = await database(); await store.createProject('VIQ'); await store.createTicket({ project: 'VIQ', title: 'before' }); await store.close();
  const legacy = new DatabaseSync(file); legacy.exec('PRAGMA user_version=10'); legacy.close();
  const migrated = new Store(file); await migrated.init(); assert.equal((await migrated.createTicket({ project: 'VIQ', title: 'after' })).id, 'VIQ-2'); await migrated.close();
  const rollback = await Store.rollbackV11(file); assert.match(rollback.preserved, /post-viq11/);
  const restored = new DatabaseSync(file, { readOnly: true }); assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 10); assert.deepEqual(restored.prepare('SELECT id FROM tickets ORDER BY id').all().map((row) => row.id), ['VIQ-1']); assert.equal(restored.prepare("SELECT next_number FROM projects WHERE key='VIQ'").get().next_number, 2); restored.close();
});

test('VIQ-11 retry preserves the first snapshot and rollback restores exact pre-migration identity', async () => {
  const { file, store } = await database();
  await store.createProject('VIQ'); await store.createActor({ id: 'agent-a', name: 'Agent A', kind: 'agent' });
  const ticket = await store.createTicket({ project: 'VIQ', title: 'legacy agent', assignment: 'Agent' }); await store.close();
  const legacy = new DatabaseSync(file);
  legacy.prepare("UPDATE tickets SET assigned_to='agent-a',assignee_type='actor',assignee_id='agent-a' WHERE id=?").run(ticket.id);
  legacy.prepare("INSERT INTO questions(id,ticket_id,asked_by,target_type,target_id,kind,text,status,created_at,question_event_id) VALUES('q-original',?,'coord','actor','coord','text','identity?','open',123,NULL)").run(ticket.id);
  legacy.exec(`ALTER TABLE tickets DROP COLUMN assignment; ALTER TABLE questions DROP COLUMN question_event_id; PRAGMA user_version=10;
    CREATE TRIGGER fail_viq11_finish BEFORE UPDATE ON projects BEGIN SELECT RAISE(FAIL,'injected VIQ-11 finish failure'); END`);
  const capture = (db) => {
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
    return { userVersion: db.prepare('PRAGMA user_version').get().user_version, objects, tables };
  };
  const original = capture(legacy); legacy.close();

  const first = new Store(file); await assert.rejects(first.init(), /injected VIQ-11 finish failure/); await first.close();
  let intermediate = new DatabaseSync(file); assert.ok(intermediate.prepare("SELECT 1 FROM pragma_table_info('questions') WHERE name='question_event_id'").get()); intermediate.exec('DROP TRIGGER fail_viq11_finish'); intermediate.close();
  const snapshot = `${file}.pre-viq11.sqlite`, firstSnapshotBytes = await readFile(snapshot);

  const retried = new Store(file); await retried.init(); assert.equal((await retried.getTicket(ticket.id)).assignment, 'Agent'); await retried.close();
  assert.deepEqual(await readFile(snapshot), firstSnapshotBytes, 'retry must not replace the first pre-VIQ-11 snapshot');
  await Store.rollbackV11(file);
  const restored = new DatabaseSync(file, { readOnly: true }); assert.deepEqual(capture(restored), original); restored.close();
});

test('VIQ-11 migration refuses stale or corrupted snapshot families instead of overwriting them', async () => {
  const { file, store } = await database(); await store.close();
  const legacy = new DatabaseSync(file); legacy.exec('PRAGMA user_version=10'); legacy.close();
  const snapshot = `${file}.pre-viq11.sqlite`, manifest = `${snapshot}.manifest.json`;
  await writeFile(snapshot, 'unrelated');
  const incomplete = new Store(file); await assert.rejects(incomplete.init(), (error) => error.code === 'invalid_migration_snapshot'); await incomplete.close();
  await writeFile(manifest, JSON.stringify({ format: 1, migration: 'VIQ-11', source: file, sha256: '0'.repeat(64) }));
  const corrupt = new Store(file); await assert.rejects(corrupt.init(), (error) => error.code === 'invalid_migration_snapshot'); await corrupt.close();
  assert.equal((await readFile(snapshot, 'utf8')), 'unrelated');
});

test('VIQ-11 migration fails closed on conflicting membership and leaves source unchanged', async () => {
  const { file, store } = await database(); await store.createProject('VIQ'); await store.createProject('OPS'); await store.createTicket({ project: 'VIQ', title: 'truth' }); await store.close();
  const db = new DatabaseSync(file); db.exec('PRAGMA user_version=10'); db.prepare('INSERT INTO ticket_projects(ticket_id,project_key) VALUES(?,?)').run('VIQ-1', 'OPS'); const before = JSON.stringify(db.prepare('SELECT * FROM ticket_projects ORDER BY project_key').all()); db.close();
  const reopened = new Store(file); await assert.rejects(reopened.init(), (e) => e.code === 'unsafe_project_migration');
  const check = new DatabaseSync(file); assert.equal(JSON.stringify(check.prepare('SELECT * FROM ticket_projects ORDER BY project_key').all()), before); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 10); check.close();
});

test('VIQ-11 real CLI creates project and ticket then reads it back', async (t) => {
  const { file, store, coordinator } = await database(); await store.close();
  const probe = net.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const app = spawn(process.execPath, ['src/server.js', `--port=${port}`, `--storage=${file}`]); t.after(() => app.kill()); const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 10)); }
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--server', url, '--device-token', coordinator.credential], { encoding: 'utf8' });
  assert.equal(run('project', 'create', 'VIQ').status, 0);
  const created = run('ticket', 'create', 'VIQ', 'CLI tracer', '--description', 'read me', '--assignment', 'Agent'); assert.equal(created.status, 0, created.stderr);
  const shown = run('ticket', 'show', 'VIQ-1'); assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).ticket, JSON.parse(created.stdout).ticket);
  assert.deepEqual({ project: JSON.parse(shown.stdout).ticket.project, state: JSON.parse(shown.stdout).ticket.state, assignment: JSON.parse(shown.stdout).ticket.assignment }, { project: 'VIQ', state: 'Open', assignment: 'Agent' });
});
