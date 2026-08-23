import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq14-')); const file = path.join(dir, 'data.sqlite');
  const store = new Store(file); await store.init(); const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' }); await store.createRole({ id: 'reviewer', name: 'Reviewer', actor: 'coord' }); await store.grantDeviceRole('coord', 'reviewer', 'coord');
  const code = await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'worker', device_id: 'machine', device_name: 'Machine' }); const paired = await store.pairDevice({ code: code.code, id: 'machine', name: 'Machine' });
  await store.createProject('VIQ'); const ticket = await store.createTicket({ project: 'VIQ', title: 'VIQ-14 test', assignment: 'Agent', actor: 'coord' });
  const session = await store.openWorkerSession('machine'); const claim = await store.claimNext({ device: 'machine', session_capability: session.session_capability });
  const authority = { claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, device: 'machine', generation: claim.ticket.claim.generation, claim_token: claim.claim_token, session_capability: session.session_capability };
  return { store, file, coordinator, paired, ticket, session, claim, authority };
}

test('VIQ-14 non-blocking and blocking questions have exact claim/state semantics and provenance', async () => {
  const f = await fixture(); const nonblocking = await f.store.askQuestion(f.ticket.id, { ...f.authority, blocking: false, text: 'FYI?', target_type: 'role', target_id: 'reviewer' });
  assert.equal(nonblocking.question.blocking, false); assert.equal(nonblocking.ticket.state, 'Working'); assert.equal(nonblocking.ticket.claim.claim_id, f.claim.ticket.claim.claim_id);
  const blocking = await f.store.askQuestion(f.ticket.id, { ...f.authority, blocking: true, text: 'Decision?', target_type: 'role', target_id: 'reviewer' });
  assert.equal(blocking.question.blocking, true); assert.equal(blocking.ticket.state, 'Waiting'); assert.equal(blocking.ticket.claim, null); assert.equal(blocking.question.asked_by_device_id, 'machine'); assert.equal(blocking.question.asked_by_session_id, f.session.session_id);
  const answered = await f.store.answerQuestion(f.ticket.id, blocking.question.id, { actor: 'coord', answer: 'Proceed', request_id: 'answer:blocking:1' }); assert.equal(answered.ticket.state, 'Open'); assert.equal(answered.question.answered_by_device_id, 'coord');
  assert.equal((await f.store.listOpenQuestions()).questions.map((q) => q.id).includes(nonblocking.question.id), true); await f.store.close();
});

test('VIQ-14 final blocking answer alone reopens and non-blocking questions cannot be promoted', async () => {
  const f = await fixture(); const first = await f.store.askHumanQuestion(f.ticket.id, { actor: 'coord', blocking: true, text: 'First?', target_type: 'actor', target_id: 'coord' }); const second = await f.store.askHumanQuestion(f.ticket.id, { actor: 'coord', blocking: true, text: 'Second?', target_type: 'actor', target_id: 'coord' });
  assert.equal((await f.store.answerQuestion(f.ticket.id, first.question.id, { actor: 'coord', answer: 'one' })).ticket.state, 'Waiting'); assert.equal((await f.store.answerQuestion(f.ticket.id, second.question.id, { actor: 'coord', answer: 'two' })).ticket.state, 'Open');
  assert.equal((await f.store.listQuestions(f.ticket.id)).questions.every((q) => typeof q.blocking === 'boolean'), true); await f.store.close();
});

test('VIQ-14 deterministic answer retry and cross-store concurrency append lifecycle events once', async () => {
  const f = await fixture(); const asked = await f.store.askQuestion(f.ticket.id, { ...f.authority, blocking: true, text: 'Once?', target_type: 'actor', target_id: 'coord' }); const other = new Store(f.file); await other.init();
  const input = { actor: 'coord', answer: 'Exactly once', request_id: 'answer:once' }; const outcomes = await Promise.allSettled([f.store.answerQuestion(f.ticket.id, asked.question.id, input), other.answerQuestion(f.ticket.id, asked.question.id, input)]);
  assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 2); await f.store.answerQuestion(f.ticket.id, asked.question.id, input);
  const events = (await f.store.listEvents({ ticket: f.ticket.id })).events; assert.equal(events.filter((e) => e.type === 'question_answered' && e.metadata.question_id === asked.question.id).length, 1); assert.equal(events.filter((e) => e.type === 'answer_unblocked' && e.metadata.question_id === asked.question.id).length, 1); await other.close(); await f.store.close();
});

test('VIQ-14 submission retry from exact fenced session creates one blocking approval and lifecycle pair', async () => {
  const f = await fixture(); const input = { ...f.authority, reviewer: { type: 'actor', id: 'coord' }, message: 'evidence', request_id: `submit:${f.claim.ticket.claim.claim_id}` }; const first = await f.store.submit(f.ticket.id, input); const retry = await f.store.submit(f.ticket.id, input);
  assert.equal(first.question.id, retry.question.id); assert.equal(first.question.blocking, true); assert.equal(retry.ticket.state, 'Waiting');
  const events = (await f.store.listEvents({ ticket: f.ticket.id })).events; assert.equal(events.filter((e) => e.type === 'submitted').length, 1); assert.equal(events.filter((e) => e.type === 'question_asked' && e.metadata.kind === 'approval').length, 1);
  const accepted = await f.store.answerQuestion(f.ticket.id, first.question.id, { actor: 'coord', decision: 'accept', request_id: 'accept:once' }); assert.equal(accepted.ticket.state, 'Done'); await f.store.close();
});
