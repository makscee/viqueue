import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const exec = promisify(execFile), cli = path.resolve('bin/viq.js');
const auth = (credential, session) => ({ authorization: `Bearer ${credential}`, 'x-viq-session-capability': session, 'content-type': 'application/json' });
const run = async (args, env = {}) => exec(process.execPath, [cli, ...args], { cwd: path.resolve('.'), env: { ...process.env, VIQ_DEVICE_TOKEN: '', VIQ_SESSION_CAPABILITY: '', ...env } });

async function fixture(t) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'viq-cli-adoption-')), 'db.sqlite');
  const store = new Store(file); await store.init();
  const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  await store.createActor({ id: 'agent', name: 'Agent', kind: 'agent' });
  const pairing = await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'agent', device_id: 'worker', device_name: 'Worker' });
  await store.createProject('ABC'); await store.createTicket({ project: 'ABC', title: 'CLI slice', assignment: 'Agent' });
  await store.close();
  const app = await createApp({ storage: file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.address().port}`, coordinator: coordinator.credential, code: pairing.code };
}

const fenceArgs = (claim) => ['--claim-id', claim.ticket.claim.claim_id, '--claim-token', claim.claim_token, '--generation', String(claim.ticket.claim.generation)];

test('CLI maps unauthenticated pairing, session, progress, questions, and completion without argv session authority', async (t) => {
  const f = await fixture(t);
  const pairedRun = await run(['device', 'pair', f.code, '--server', f.base], { VIQ_DEVICE_TOKEN: 'must-not-be-needed' });
  const paired = JSON.parse(pairedRun.stdout); assert.equal(paired.device.id, 'worker'); assert.equal(typeof paired.credential, 'string'); assert.equal(pairedRun.stderr, '');
  await assert.rejects(run(['device', 'pair', f.code, '--server', f.base]), (error) => { assert.equal(error.stdout, ''); assert.doesNotMatch(error.stderr, new RegExp(paired.credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); return true; });

  const opened = JSON.parse((await run(['session', 'open', '--server', f.base, '--device-token', paired.credential])).stdout);
  assert.equal(typeof opened.session_capability, 'string');
  const closed = JSON.parse((await run(['session', 'close', '--server', f.base, '--device-token', paired.credential], { VIQ_SESSION_CAPABILITY: opened.session_capability })).stdout);
  assert.equal(closed.revoked, true);
  await assert.rejects(run(['session', 'close', '--session-capability', opened.session_capability, '--server', f.base, '--device-token', paired.credential]), /session authority is never accepted in argv/);

  const session = JSON.parse((await run(['session', 'open', '--server', f.base, '--device-token', paired.credential])).stdout);
  const env = { VIQ_SESSION_CAPABILITY: session.session_capability };
  const claim = JSON.parse((await run(['ticket', 'claim', 'ABC-1', '--server', f.base, '--device-token', paired.credential], env)).stdout);
  const fence = fenceArgs(claim);
  const progress = JSON.parse((await run(['ticket', 'progress', 'ABC-1', ...fence, '--request-id', 'progress-1', '--message', 'implementation underway', '--server', f.base, '--device-token', paired.credential], env)).stdout);
  assert.equal(progress.event.message, 'implementation underway');
  const asked = JSON.parse((await run(['question', 'ask', 'ABC-1', ...fence, '--request-id', 'question-1', '--text', 'Any constraints?', '--server', f.base, '--device-token', paired.credential], env)).stdout);
  assert.equal(asked.question.text, 'Any constraints?'); assert.equal(asked.question.blocking, false);
  const listed = JSON.parse((await run(['question', 'list', 'ABC-1', '--status', 'open', '--server', f.base, '--device-token', paired.credential])).stdout);
  assert.deepEqual(listed.questions.map((question) => question.id), [asked.question.id]);
  const completed = JSON.parse((await run(['ticket', 'complete', 'ABC-1', ...fence, '--request-id', 'complete-1', '--outcome', 'Implemented and tested.', '--evidence', 'urn:test:focused', '--evidence', 'opaque-build-42', '--server', f.base, '--device-token', paired.credential], env)).stdout);
  assert.equal(completed.ticket.state, 'Done'); assert.equal(completed.ticket.claim, null);
  assert.deepEqual(completed.completion.metadata.evidence_references, ['urn:test:focused', 'opaque-build-42']);
});

test('CLI blocking question releases claim, coordinator answer retries, and a fresh session reclaims', async (t) => {
  const f = await fixture(t);
  const paired = JSON.parse((await run(['device', 'pair', f.code, '--server', f.base])).stdout);
  const firstSession = JSON.parse((await run(['session', 'open', '--server', f.base, '--device-token', paired.credential])).stdout);
  const firstEnv = { VIQ_SESSION_CAPABILITY: firstSession.session_capability };
  const firstClaim = JSON.parse((await run(['ticket', 'claim', 'ABC-1', '--server', f.base, '--device-token', paired.credential], firstEnv)).stdout);
  const asked = JSON.parse((await run(['question', 'ask', 'ABC-1', ...fenceArgs(firstClaim), '--request-id', 'blocking-question-1', '--text', 'Which boundary applies?', '--blocking', '--server', f.base, '--device-token', paired.credential], firstEnv)).stdout);
  assert.equal(asked.question.blocking, true); assert.equal(asked.ticket.state, 'Waiting'); assert.equal(asked.ticket.claim, null);

  const answerArgs = ['question', 'answer', 'ABC-1', asked.question.id, '--answer', 'Use the accepted product boundary.', '--request-id', 'answer-1', '--server', f.base, '--device-token', f.coordinator];
  const answered = JSON.parse((await run(answerArgs)).stdout);
  const retried = JSON.parse((await run(answerArgs)).stdout);
  assert.deepEqual(retried, answered); assert.equal(answered.question.answer, 'Use the accepted product boundary.'); assert.equal(answered.ticket.state, 'Open');
  await assert.rejects(run(['question', 'answer', 'ABC-1', asked.question.id, '--server', f.base, '--device-token', f.coordinator]), /--answer is required/);

  const closed = JSON.parse((await run(['session', 'close', '--server', f.base, '--device-token', paired.credential], firstEnv)).stdout);
  assert.equal(closed.revoked, true);
  const freshSession = JSON.parse((await run(['session', 'open', '--server', f.base, '--device-token', paired.credential])).stdout);
  assert.notEqual(freshSession.session_id, firstSession.session_id);
  const freshEnv = { VIQ_SESSION_CAPABILITY: freshSession.session_capability };
  const reclaimed = JSON.parse((await run(['ticket', 'claim', 'ABC-1', '--server', f.base, '--device-token', paired.credential], freshEnv)).stdout);
  assert.equal(reclaimed.ticket.state, 'Working'); assert.equal(reclaimed.ticket.claim.generation, firstClaim.ticket.claim.generation + 1);
  const completed = JSON.parse((await run(['ticket', 'complete', 'ABC-1', ...fenceArgs(reclaimed), '--request-id', 'completion-after-answer-1', '--outcome', 'Answered, reclaimed, and completed.', '--server', f.base, '--device-token', paired.credential], freshEnv)).stdout);
  assert.equal(completed.ticket.state, 'Done'); assert.equal(completed.ticket.claim, null);
});

test('Store.init migrates pre-completion receipts and completion remains retryable', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'viq-receipt-migration-')), 'db.sqlite');
  let store = new Store(file); await store.init(); await store.close();
  const legacy = new DatabaseSync(file);
  legacy.exec('ALTER TABLE worker_mutation_receipts DROP COLUMN session_id; ALTER TABLE worker_mutation_receipts DROP COLUMN claim_token_hash; ALTER TABLE worker_mutation_receipts DROP COLUMN request_hash;');
  legacy.close();

  store = new Store(file); await store.init();
  const migrated = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(migrated.prepare('PRAGMA table_info(worker_mutation_receipts)').all().slice(-3).map((column) => column.name), ['session_id', 'claim_token_hash', 'request_hash']);
  migrated.close();
  await store.createActor({ id: 'agent', name: 'Agent', kind: 'agent' });
  await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  const pairing = await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'agent', device_id: 'worker', device_name: 'Worker' });
  await store.pairDevice({ code: pairing.code }); await store.createProject('ABC');
  const ticket = await store.createTicket({ project: 'ABC', title: 'Migrated completion', assignment: 'Agent' });
  const session = await store.openWorkerSession('worker');
  const claim = await store.claim(ticket.id, { device: 'worker', session_capability: session.session_capability });
  const input = { claim_id: claim.ticket.claim.claim_id, claim_token: claim.claim_token, generation: claim.ticket.claim.generation, device: 'worker', actor: 'agent', session_capability: session.session_capability, request_id: 'migrated-complete-1', outcome: 'Done.', evidence_references: [] };
  const first = await store.complete(ticket.id, input);
  assert.equal(first.ticket.state, 'Done'); assert.deepEqual(await store.complete(ticket.id, input), first);
  await store.close();
});

test('worker completion is atomic, exact-retry deterministic, fenced, and provenance preserving', async (t) => {
  const f = await fixture(t);
  const paired = await fetch(`${f.base}/v1/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: f.code }) }).then((response) => response.json());
  const session = await fetch(`${f.base}/v1/sessions`, { method: 'POST', headers: { authorization: `Bearer ${paired.credential}`, 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json());
  const claim = await fetch(`${f.base}/v1/tickets/ABC-1/claim`, { method: 'POST', headers: auth(paired.credential, session.session_capability), body: '{}' }).then((response) => response.json());
  const body = { claim_id: claim.ticket.claim.claim_id, claim_token: claim.claim_token, generation: claim.ticket.claim.generation, request_id: 'complete-http-1', outcome: 'Finished cleanly.', evidence_references: ['arbitrary-reference'] };
  const complete = () => fetch(`${f.base}/v1/tickets/ABC-1/complete`, { method: 'POST', headers: auth(paired.credential, session.session_capability), body: JSON.stringify(body) });
  const firstResponse = await complete(); assert.equal(firstResponse.status, 200); const first = await firstResponse.json();
  const retryResponse = await complete(); assert.equal(retryResponse.status, 200); assert.deepEqual(await retryResponse.json(), first);
  const before = await f.app.viqStore.listEvents({ ticket: 'ABC-1' });
  const altered = await fetch(`${f.base}/v1/tickets/ABC-1/complete`, { method: 'POST', headers: auth(paired.credential, session.session_capability), body: JSON.stringify({ ...body, outcome: 'Altered retry.' }) });
  assert.equal(altered.status, 409); assert.equal((await altered.json()).error.code, 'stale_claim');
  for (const change of [{ claim_id: 'wrong-claim' }, { generation: body.generation + 1 }, { claim_token: 'wrong-token' }]) {
    const staleFence = await fetch(`${f.base}/v1/tickets/ABC-1/complete`, { method: 'POST', headers: auth(paired.credential, session.session_capability), body: JSON.stringify({ ...body, ...change }) });
    assert.equal(staleFence.status, 409); assert.equal((await staleFence.json()).error.code, 'stale_claim');
  }
  const otherSession = await fetch(`${f.base}/v1/sessions`, { method: 'POST', headers: { authorization: `Bearer ${paired.credential}`, 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json());
  const staleSession = await fetch(`${f.base}/v1/tickets/ABC-1/complete`, { method: 'POST', headers: auth(paired.credential, otherSession.session_capability), body: JSON.stringify(body) });
  assert.equal(staleSession.status, 409); assert.equal((await staleSession.json()).error.code, 'stale_claim');
  const staleRequest = await fetch(`${f.base}/v1/tickets/ABC-1/complete`, { method: 'POST', headers: auth(paired.credential, session.session_capability), body: JSON.stringify({ ...body, request_id: 'complete-http-2' }) });
  assert.equal(staleRequest.status, 409); assert.equal((await staleRequest.json()).error.code, 'stale_claim');
  const after = await f.app.viqStore.listEvents({ ticket: 'ABC-1' }); assert.deepEqual(after, before);
  const events = after.events.filter((event) => event.type === 'completed'); assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'agent'); assert.equal(events[0].device_id, 'worker'); assert.equal(events[0].machine, 'Worker');
  assert.equal(events[0].metadata.session_id, session.session_id); assert.equal(events[0].metadata.claim_id, claim.ticket.claim.claim_id);
  assert.equal(first.ticket.state, 'Done'); assert.equal(first.ticket.claim, null);
});
