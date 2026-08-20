#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED = Object.freeze({
  claims: [
    { claim_id: '8cd6809e-031a-4a22-81eb-6aedee635755', ticket_id: 'VIQ-15', actor: 'tower-pi', generation: 1, ticket_state: 'open', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { claim_id: 'dd73e877-3e93-4fa3-9965-e5680fe3e6c7', ticket_id: 'VIQ-13', actor: 'tower-pi', generation: 1, ticket_state: 'open', assignee_type: 'actor', assignee_id: 'tower-pi' }
  ],
  questions: [
    { id: 'q_9euMacGH6DMO', ticket_id: 'VIQ-7', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'approval', status: 'open', ticket_state: 'review', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_B7XmcV2uTkiL', ticket_id: 'VIQ-4', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'approval', status: 'open', ticket_state: 'review', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_D5UqQ97yPkIJ', ticket_id: 'VIQ-2', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'text', status: 'open', ticket_state: 'done', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_D8p6Q4SysglS', ticket_id: 'VIQ-1', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'text', status: 'open', ticket_state: 'open', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_Ft-khfUJ8FG_', ticket_id: 'VIQ-3', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'approval', status: 'open', ticket_state: 'review', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_HoKblqSQeomB', ticket_id: 'VIQ-5', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'approval', status: 'open', ticket_state: 'review', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_J75fQCqmgfJt', ticket_id: 'VIQ-6', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'approval', status: 'open', ticket_state: 'review', assignee_type: 'actor', assignee_id: 'tower-pi' },
    { id: 'q_UogU_5WKPQcP', ticket_id: 'VIQ-1', asked_by: 'tower-pi', target_type: 'actor', target_id: 'maks', kind: 'text', status: 'open', ticket_state: 'open', assignee_type: 'actor', assignee_id: 'tower-pi' }
  ],
  actors: [
    { id: 'maks', kind: 'human', active: 1 },
    { id: 'tower-pi', kind: 'agent', active: 1 }
  ]
});

const canonical = (value) => JSON.stringify(value);
function assertExact(label, actual, expected) {
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label}_drift`);
}
function openDatabase(file, readOnly) {
  const absolute = path.resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Error('unsafe_database_path');
  return new DatabaseSync(absolute, { readOnly });
}
function integrity(db) {
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('database_integrity_failed');
}
function snapshot(db) {
  integrity(db);
  const claims = db.prepare(`SELECT c.claim_id,c.ticket_id,c.actor,c.generation,t.state ticket_state,t.assignee_type,t.assignee_id
    FROM claims c JOIN tickets t ON t.id=c.ticket_id WHERE c.released_at IS NULL ORDER BY c.claim_id`).all();
  const questions = db.prepare(`SELECT q.id,q.ticket_id,q.asked_by,q.target_type,q.target_id,q.kind,q.status,t.state ticket_state,t.assignee_type,t.assignee_id
    FROM questions q JOIN tickets t ON t.id=q.ticket_id WHERE q.status='open' ORDER BY q.id`).all();
  const actors = db.prepare("SELECT id,kind,active FROM actors WHERE id IN ('maks','tower-pi') ORDER BY id").all();
  return { claims, questions, actors };
}
function assertPreflight(value) {
  assertExact('active_claims', value.claims, EXPECTED.claims);
  assertExact('open_questions', value.questions, EXPECTED.questions);
  assertExact('actors', value.actors, EXPECTED.actors);
}
export function inspectDatabase(file) {
  const db = openDatabase(file, true);
  try {
    const value = snapshot(db);
    assertPreflight(value);
    return {
      status: 'exact_preflight_pass',
      active_claims: value.claims.map(({ claim_id, ticket_id, actor }) => ({ claim_id, ticket_id, actor, disposition: 'release_in_sealed_candidate_copy_then_reclaim_as_paired_tower-pi' })),
      open_questions: value.questions.map(({ id, ticket_id, target_id }) => ({ id, ticket_id, target_id, disposition: 'resume_with_specifically_paired_coordinator_maks' })),
      required_pairings: [{ id: 'tower-pi', kind: 'worker' }, { id: 'maks', kind: 'coordinator' }]
    };
  } finally { db.close(); }
}
export function applyReconciliation(file, now = Date.now()) {
  const absolute = path.resolve(file);
  if (absolute === '/var/lib/viqueue/viqueue.sqlite') throw new Error('authoritative_live_database_forbidden');
  if (process.env.VIQ15_RECONCILE_CONFIRM !== 'SEALED-CANDIDATE-COPY') throw new Error('explicit_confirmation_required');
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid_reconciliation_time');
  const db = openDatabase(absolute, false);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      assertPreflight(snapshot(db));
      for (const item of EXPECTED.claims) {
        const changed = db.prepare('UPDATE claims SET released_at=? WHERE claim_id=? AND ticket_id=? AND actor=? AND released_at IS NULL').run(now, item.claim_id, item.ticket_id, item.actor);
        if (changed.changes !== 1) throw new Error('claim_release_race');
        db.prepare('UPDATE tickets SET updated_at=? WHERE id=?').run(now, item.ticket_id);
        db.prepare("INSERT INTO events(ticket_id,project,type,actor,message,created_at,metadata) SELECT id,project,'claim_reconciled',NULL,NULL,?,? FROM tickets WHERE id=?")
          .run(now, JSON.stringify({ claim_id: item.claim_id, reason: 'viq15_auth_cutover' }), item.ticket_id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const result = readbackWithDatabase(db, { requirePairings: false });
    return { ...result, status: 'exact_reconciliation_applied', pairings_pending: true };
  } finally { db.close(); }
}
function readbackWithDatabase(db, { requirePairings }) {
  integrity(db);
  const active = db.prepare('SELECT claim_id FROM claims WHERE released_at IS NULL ORDER BY claim_id').all();
  assertExact('post_active_claims', active, []);
  const released = db.prepare(`SELECT claim_id,ticket_id,actor FROM claims WHERE claim_id IN (?,?) AND released_at IS NOT NULL ORDER BY claim_id`).all(...EXPECTED.claims.map((x) => x.claim_id));
  assertExact('released_claims', released, EXPECTED.claims.map(({ claim_id, ticket_id, actor }) => ({ claim_id, ticket_id, actor })));
  const value = snapshot(db);
  assertExact('post_open_questions', value.questions, EXPECTED.questions);
  assertExact('post_actors', value.actors, EXPECTED.actors);
  const required_pairings = [{ id: 'tower-pi', kind: 'worker' }, { id: 'maks', kind: 'coordinator' }];
  if (requirePairings) {
    const devices = db.prepare("SELECT id,kind,status FROM devices WHERE id IN ('maks','tower-pi') ORDER BY id").all();
    assertExact('paired_actors', devices, [{ id: 'maks', kind: 'coordinator', status: 'active' }, { id: 'tower-pi', kind: 'worker', status: 'active' }]);
  }
  return { status: requirePairings ? 'exact_postcutover_readback_pass' : 'exact_reconciliation_readback_pass', active_claims: 0, released_claims: released.map((x) => x.claim_id), open_questions: value.questions.map((x) => x.id), required_pairings };
}
export function readbackDatabase(file) {
  const db = openDatabase(file, true);
  try { return readbackWithDatabase(db, { requirePairings: true }); } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2);
  if (!['inspect', 'apply', 'readback'].includes(mode) || !file) throw new Error('usage: viq15-reconcile.js inspect|apply|readback DATABASE');
  const result = mode === 'inspect' ? inspectDatabase(file) : mode === 'apply' ? applyReconciliation(file, Number(process.env.VIQ15_RECONCILE_NOW_MS ?? Date.now())) : readbackDatabase(file);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
