import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq14-')); const file = path.join(dir, 'data.sqlite');
  const store = new Store(file); await store.init(); const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' }); await store.createRole({ id: 'reviewer', name: 'Reviewer', actor: 'coord' }); await store.grantDeviceRole('coord', 'reviewer', 'coord');
  const code = await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'worker', device_id: 'machine', device_name: 'Machine' }); const paired = await store.pairDevice({ code: code.code, id: 'machine', name: 'Machine' });
  const otherCode = await store.createPairingCode('coord', { intended_kind: 'worker', actor_id: 'worker', device_id: 'other-machine', device_name: 'Other Machine' }); const otherPaired = await store.pairDevice({ code: otherCode.code, id: 'other-machine', name: 'Other Machine' });
  await store.createProject('VIQ'); const ticket = await store.createTicket({ project: 'VIQ', title: 'VIQ-14 test', assignment: 'Agent', actor: 'coord' });
  const session = await store.openWorkerSession('machine'); const claim = await store.claimNext({ device: 'machine', session_capability: session.session_capability });
  const authority = { claim_id: claim.ticket.claim.claim_id, actor: claim.ticket.claim.actor, device: 'machine', generation: claim.ticket.claim.generation, claim_token: claim.claim_token, session_capability: session.session_capability };
  return { store, file, coordinator, paired, otherPaired, ticket, session, claim, authority };
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

test('VIQ-14 Store submission fingerprint rejects every altered fence without mutation and preserves provenance', async () => {
  const f = await fixture();
  const otherSession = await f.store.openWorkerSession('other-machine');
  const sameDeviceOtherSession = await f.store.openWorkerSession('machine');
  const input = { ...f.authority, reviewer: { type: 'actor', id: 'coord' }, message: 'evidence', request_id: `submit:${f.claim.ticket.claim.claim_id}` };
  const first = await f.store.submit(f.ticket.id, input); const retry = await f.store.submit(f.ticket.id, input);
  assert.equal(first.question.id, retry.question.id); assert.equal(first.question.blocking, true); assert.equal(retry.ticket.state, 'Waiting');
  const snapshot = async () => JSON.stringify({ ticket: await f.store.getTicket(f.ticket.id), questions: await f.store.listQuestions(f.ticket.id), events: await f.store.listEvents({ ticket: f.ticket.id }) });
  const before = await snapshot();
  const altered = [
    { claim_token: `${input.claim_token}x` },
    { claim_id: `${input.claim_id}-wrong` },
    { generation: input.generation + 1 },
    { device: 'other-machine', session_capability: otherSession.session_capability },
    { session_capability: sameDeviceOtherSession.session_capability }
  ];
  for (const change of altered) {
    await assert.rejects(f.store.submit(f.ticket.id, { ...input, ...change }), (error) => error.code === 'stale_claim');
    assert.equal(await snapshot(), before);
  }
  const events = (await f.store.listEvents({ ticket: f.ticket.id })).events;
  const submitted = events.find((event) => event.type === 'submitted');
  assert.deepEqual({ actor: submitted.actor, device_id: submitted.device_id, role: submitted.metadata.actor_role, session_id: submitted.metadata.session_id }, { actor: 'worker', device_id: 'machine', role: null, session_id: f.session.session_id });
  assert.equal(events.filter((e) => e.type === 'submitted').length, 1); assert.equal(events.filter((e) => e.type === 'question_asked' && e.metadata.kind === 'approval').length, 1);
  assert.doesNotMatch(JSON.stringify({ first, retry, events, questions: await f.store.listQuestions(f.ticket.id) }), /claim_token_hash|submission_authority|fingerprint|[a-f0-9]{64}/i);
  const accepted = await f.store.answerQuestion(f.ticket.id, first.question.id, { actor: 'coord', decision: 'accept', request_id: 'accept:once' }); assert.equal(accepted.ticket.state, 'Done'); await f.store.close();
});

test('VIQ-14 real HTTP submission retry is exactly-once and altered authority fails closed without private output', async (t) => {
  const f = await fixture(); const sameDeviceOtherSession = await f.store.openWorkerSession('machine'); const otherSession = await f.store.openWorkerSession('other-machine'); await f.store.close();
  const app = await createApp({ storage: f.file }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (credential, capability, method, route, body) => { const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...(capability ? { 'x-viq-session-capability': capability } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const body = { claim_id: f.authority.claim_id, generation: f.authority.generation, claim_token: f.authority.claim_token, reviewer: { type: 'actor', id: 'coord' }, request_id: `http:${f.authority.claim_id}` };
  const first = await call(f.paired.credential, f.session.session_capability, 'POST', `/v1/tickets/${f.ticket.id}/submit`, body);
  const retry = await call(f.paired.credential, f.session.session_capability, 'POST', `/v1/tickets/${f.ticket.id}/submit`, body);
  assert.equal(first.status, 200); assert.equal(retry.status, 200); assert.equal(retry.body.question.id, first.body.question.id);
  const activity = async () => call(f.coordinator.credential, null, 'GET', `/v1/events?ticket=${f.ticket.id}`);
  const questions = async () => call(f.coordinator.credential, null, 'GET', `/v1/tickets/${f.ticket.id}/questions`);
  const before = JSON.stringify({ activity: await activity(), questions: await questions() });
  const attempts = [
    [f.paired.credential, f.session.session_capability, { claim_token: `${body.claim_token}x` }],
    [f.paired.credential, f.session.session_capability, { claim_id: `${body.claim_id}-wrong` }],
    [f.paired.credential, f.session.session_capability, { generation: body.generation + 1 }],
    [f.otherPaired.credential, otherSession.session_capability, {}],
    [f.paired.credential, sameDeviceOtherSession.session_capability, {}]
  ];
  for (const [credential, capability, change] of attempts) {
    const failed = await call(credential, capability, 'POST', `/v1/tickets/${f.ticket.id}/submit`, { ...body, ...change });
    assert.equal(failed.status, 409); assert.equal(failed.body.error.code, 'stale_claim'); assert.equal(JSON.stringify({ activity: await activity(), questions: await questions() }), before);
  }
  const output = JSON.stringify({ first, retry, activity: await activity(), questions: await questions(), ticket: await call(f.coordinator.credential, null, 'GET', `/v1/tickets/${f.ticket.id}`) });
  assert.doesNotMatch(output, /claim_token_hash|submission_authority|fingerprint|[a-f0-9]{64}/i);
});
