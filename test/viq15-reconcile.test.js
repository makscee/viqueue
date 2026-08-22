import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EXPECTED, applyReconciliation, inspectDatabase, readbackDatabase } from '../scripts/viq15-reconcile.js';

function fixture(dir) {
  const file = path.join(dir, 'sealed-copy.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE actors(id TEXT PRIMARY KEY,name TEXT,kind TEXT,machine TEXT,active INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT,kind TEXT,token_hash BLOB,status TEXT,created_at INTEGER,revoked_at INTEGER);
    CREATE TABLE tickets(id TEXT PRIMARY KEY,project TEXT,number INTEGER,title TEXT,body TEXT,state TEXT,assigned_to TEXT,created_at INTEGER,updated_at INTEGER,assignee_type TEXT,assignee_id TEXT,archived_at INTEGER,deleted_at INTEGER);
    CREATE TABLE claims(claim_id TEXT PRIMARY KEY,ticket_id TEXT,actor TEXT,generation INTEGER,token_hash BLOB,claimed_at INTEGER,released_at INTEGER);
    CREATE TABLE questions(id TEXT PRIMARY KEY,ticket_id TEXT,asked_by TEXT,target_type TEXT,target_id TEXT,kind TEXT,text TEXT,status TEXT,answer TEXT,answered_by TEXT,created_at INTEGER,answered_at INTEGER,question_event_id INTEGER);
    CREATE TABLE events(id INTEGER PRIMARY KEY,ticket_id TEXT,project TEXT,type TEXT NOT NULL,actor TEXT,message TEXT,created_at INTEGER NOT NULL,metadata TEXT);
  `);
  const actor = db.prepare('INSERT INTO actors(id,name,kind,machine,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for (const item of EXPECTED.actors) actor.run(item.id, item.id, item.kind, null, item.active, 1, 1);
  const ticketRows = new Map([...EXPECTED.claims, ...EXPECTED.questions].map((x) => [x.ticket_id, x]));
  const ticket = db.prepare('INSERT INTO tickets(id,project,number,title,body,state,assigned_to,created_at,updated_at,assignee_type,assignee_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  let number = 1;
  for (const item of ticketRows.values()) ticket.run(item.ticket_id, 'VIQ', number++, 'redacted fixture', '', item.ticket_state, item.assigned_to, 1, 1, item.assignee_type, item.assignee_id);
  const claim = db.prepare('INSERT INTO claims(claim_id,ticket_id,actor,generation,token_hash,claimed_at,released_at) VALUES(?,?,?,?,?,?,NULL)');
  for (const item of EXPECTED.claims) claim.run(item.claim_id, item.ticket_id, item.actor, item.generation, Buffer.from('not-a-secret'), item.claimed_at);
  const question = db.prepare("INSERT INTO questions(id,ticket_id,asked_by,target_type,target_id,kind,text,status,created_at) VALUES(?,?,?,?,?,?,?,'open',?)");
  for (const item of EXPECTED.questions) question.run(item.id, item.ticket_id, item.asked_by, item.target_type, item.target_id, item.kind, 'redacted fixture', 1);
  db.close();
  return file;
}

function inTemp(fn) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'viq15-reconcile-')));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('exact preflight classifies two claims and eight questions without row content', () => inTemp((dir) => {
  const result = inspectDatabase(fixture(dir));
  assert.equal(result.status, 'exact_preflight_pass');
  assert.equal(result.active_claims.length, 2);
  assert.equal(result.open_questions.length, 8);
  assert.deepEqual(result.required_pairings, [{ id: 'tower-pi', kind: 'worker' }, { id: 'maks', kind: 'coordinator' }]);
  assert.equal(JSON.stringify(result).includes('redacted fixture'), false);
}));

test('reconciliation inspect fails closed on exact active-claim identity drift', () => inTemp((dir) => {
  const file = fixture(dir);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE claims SET actor=? WHERE claim_id=?').run('unexpected-worker', EXPECTED.claims[0].claim_id);
  db.close();
  assert.throws(() => inspectDatabase(file), /active_claims_drift/);
}));

test('reconciliation inspect fails closed on exact open-question drift', () => inTemp((dir) => {
  const file = fixture(dir);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE questions SET status=? WHERE id=?').run('answered', EXPECTED.questions[0].id);
  db.close();
  assert.throws(() => inspectDatabase(file), /open_questions_drift/);
}));

test('reconciliation inspect fails closed on exact assignment drift for claim and question tickets', () => inTemp((dir) => {
  for (const item of [EXPECTED.claims[0], EXPECTED.questions[0]]) {
    const file = fixture(dir);
    const db = new DatabaseSync(file);
    db.prepare('UPDATE tickets SET assigned_to=? WHERE id=?').run('drifted-legacy-assignment', item.ticket_id);
    db.close();
    assert.throws(() => inspectDatabase(file), item.claim_id ? /active_claims_drift/ : /open_questions_drift/);
    rmSync(file);
  }
}));

test('reconciliation inspect fails closed on exact claim timestamp drift before apply', () => inTemp((dir) => {
  const file = fixture(dir);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE claims SET claimed_at=claimed_at+1 WHERE claim_id=?').run(EXPECTED.claims[0].claim_id);
  db.close();
  assert.throws(() => inspectDatabase(file), /active_claims_drift/);
  const before = process.env.VIQ15_RECONCILE_CONFIRM;
  process.env.VIQ15_RECONCILE_CONFIRM = 'SEALED-CANDIDATE-COPY';
  try { assert.throws(() => applyReconciliation(file, 2), /active_claims_drift/); }
  finally { if (before === undefined) delete process.env.VIQ15_RECONCILE_CONFIRM; else process.env.VIQ15_RECONCILE_CONFIRM = before; }
}));

test('apply refuses the authoritative live database path before opening it', () => {
  const before = process.env.VIQ15_RECONCILE_CONFIRM;
  process.env.VIQ15_RECONCILE_CONFIRM = 'SEALED-CANDIDATE-COPY';
  try { assert.throws(() => applyReconciliation('/var/lib/viqueue/viqueue.sqlite', 2), /authoritative_live_database_forbidden/); }
  finally { if (before === undefined) delete process.env.VIQ15_RECONCILE_CONFIRM; else process.env.VIQ15_RECONCILE_CONFIRM = before; }
});

test('one-shot reconciliation releases only exact claims and preserves resumable questions', () => inTemp((dir) => {
  const file = fixture(dir);
  const before = process.env.VIQ15_RECONCILE_CONFIRM;
  process.env.VIQ15_RECONCILE_CONFIRM = 'SEALED-CANDIDATE-COPY';
  try {
    const applied = applyReconciliation(file, 123456789);
    assert.equal(applied.status, 'exact_reconciliation_applied');
    assert.equal(applied.pairings_pending, true);
    assert.equal(applied.active_claims, 0);
    assert.equal(applied.released_claims.length, 2);
    assert.equal(applied.open_questions.length, 8);
    assert.throws(() => readbackDatabase(file), /paired_actors_drift/);
    assert.throws(() => applyReconciliation(file, 123456790), /active_claims_drift/);
    const db = new DatabaseSync(file);
    const insert = db.prepare("INSERT INTO devices(id,name,kind,token_hash,status,created_at) VALUES(?,?,?,?, 'active', ?)");
    insert.run('maks', 'Maks', 'coordinator', Buffer.from('hash'), 2);
    insert.run('tower-pi', 'Tower Pi', 'worker', Buffer.from('hash'), 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='claim_reconciled'").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM questions WHERE status='open'").get().n, 8);
    db.prepare('UPDATE claims SET claimed_at=claimed_at+1 WHERE claim_id=?').run(EXPECTED.claims[0].claim_id);
    db.close();
    assert.throws(() => readbackDatabase(file), /released_claims_drift/);
    const repairClaim = new DatabaseSync(file);
    repairClaim.prepare('UPDATE claims SET claimed_at=? WHERE claim_id=?').run(EXPECTED.claims[0].claimed_at, EXPECTED.claims[0].claim_id);
    repairClaim.prepare('UPDATE tickets SET assigned_to=? WHERE id=?').run('drifted-legacy-assignment', EXPECTED.claims[0].ticket_id);
    repairClaim.close();
    assert.throws(() => readbackDatabase(file), /released_claims_drift/);
    const repairAssignment = new DatabaseSync(file);
    repairAssignment.prepare('UPDATE tickets SET assigned_to=NULL WHERE id=?').run(EXPECTED.claims[0].ticket_id);
    repairAssignment.close();
    const post = readbackDatabase(file);
    assert.equal(post.status, 'exact_postcutover_readback_pass');
    assert.equal(post.active_claims, 0);
  } finally { if (before === undefined) delete process.env.VIQ15_RECONCILE_CONFIRM; else process.env.VIQ15_RECONCILE_CONFIRM = before; }
}));
