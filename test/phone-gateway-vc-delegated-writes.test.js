import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPhoneGateway } from '../src/phone-gateway.js';
import { b64url, pairRecord, proofRecord } from '../src/phone-auth-store.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const sha = (value) => createHash('sha256').update(value).digest();
// Truth the board must show: the shared admin credential writes, this browser asked for it.
const ATTRIBUTION = '[via gateway: artem@artems-macbook-pro]';
const DELEGATED_AUDIT = { actor_id: 'artem', upstream_actor: 'maks', attribution: 'gateway-delegated via shared admin credential' };

const seedTickets = () => new Map([
  ...Array.from({ length: 5 }, (_, i) => [`VC-${i + 1}`, { id: `VC-${i + 1}`, project: 'VC', title: `Ticket ${i + 1}`, description: '', assignment: 'Human', state: 'Open' }]),
  ['VIQ-1', { id: 'VIQ-1', project: 'VIQ', title: 'Foreign', description: '', assignment: 'Human', state: 'Open' }],
  ['LIVE1', { id: 'LIVE1', project: 'LIVE', title: 'Foreign', description: '', assignment: 'Human', state: 'Open' }],
  ['PRIVATEA1', { id: 'PRIVATEA1', project: 'PRIVATEA', title: 'Foreign', description: '', assignment: 'Human', state: 'Open' }],
  ['VCX-1', { id: 'VCX-1', project: 'VCX', title: 'Lookalike project', description: '', assignment: 'Human', state: 'Open' }],
  ['VC-99', { id: 'VC-99', project: 'OTHER', title: 'Lookalike id', description: '', assignment: 'Human', state: 'Open' }]
]);

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viq-vc-writes-'));
  const tickets = seedTickets(); const upstreamRequests = []; const notes = [];
  let mutationHits = 0, nextNumber = 6, noteCursor = 0, failNext = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    upstreamRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body: rawBody });
    if (req.method !== 'GET') mutationHits++;
    res.setHeader('content-type', 'application/json');
    const forced = failNext; if (forced !== null && req.method !== 'GET') { failNext = null; res.statusCode = forced; return res.end(JSON.stringify({ error: { code: 'upstream_refused' } })); }
    let parsed = {}; try { parsed = rawBody ? JSON.parse(rawBody) : {}; } catch { parsed = {}; }
    const idOf = (value) => decodeURIComponent(value);
    let match;
    if (req.method === 'GET' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)$/))) {
      const ticket = tickets.get(idOf(match[1]));
      if (!ticket) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'ticket_not_found' } })); }
      return res.end(JSON.stringify({ ticket }));
    }
    if (req.method === 'POST' && req.url === '/v1/tickets') {
      const id = `VC-${nextNumber++}`; const ticket = { id, project: parsed.project, title: parsed.title, description: parsed.description ?? '', assignment: parsed.assignment ?? 'Unassigned', state: 'Open' };
      tickets.set(id, ticket); res.statusCode = 201; return res.end(JSON.stringify({ ticket }));
    }
    if (req.method === 'PATCH' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)$/))) {
      const ticket = tickets.get(idOf(match[1]));
      if (!ticket) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'ticket_not_found' } })); }
      for (const field of ['title', 'description', 'assignment']) if (field in parsed) ticket[field] = parsed[field];
      return res.end(JSON.stringify({ ticket }));
    }
    if (req.method === 'POST' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)\/notes$/))) {
      const cursor = ++noteCursor; const event = { cursor, type: 'progress', text: parsed.message, metadata: parsed.metadata ?? null };
      notes.push({ ticket: idOf(match[1]), event }); res.statusCode = 201; return res.end(JSON.stringify({ event, cursor }));
    }
    if (req.method === 'POST' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)\/state$/))) {
      const ticket = tickets.get(idOf(match[1])); if (ticket) ticket.state = parsed.state;
      return res.end(JSON.stringify({ ticket: ticket ?? { id: idOf(match[1]), project: 'VC', state: parsed.state } }));
    }
    return res.end(JSON.stringify({ ok: true }));
  });
  await listen(upstream); const origin = 'https://phone.test';
  const gateway = await createPhoneGateway({ authDb: path.join(dir, 'auth.sqlite'), origin, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamAuthorization: 'test_upstream_admin_credential', testMode: true });
  await listen(gateway);
  const pair = ({ actorId, actorName, admin = false, kind = 'coordinator', actorActive = true, deviceId }) => {
    const device = deviceId ?? `device_${crypto.randomUUID().replaceAll('-', '')}`;
    const intent = gateway.authStore.createPair({ deviceId: device, actorId, actorName, admin, kind, actorActive, label: `${actorName} browser` });
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); const jwk = publicKey.export({ format: 'jwk' });
    const verifier = sha(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'), Buffer.from(intent.code.split('.')[1])]));
    const proof = createHmac('sha256', verifier).update(pairRecord(origin, intent.intentId, jwk.x, jwk.y)).digest();
    gateway.authStore.consumePair({ intent_id: intent.intentId, public_key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, proof: b64url(proof) });
    return { device, privateKey };
  };
  // Signing and sending are separate so a device can be revoked between the two.
  const prepare = (identity, method, target, value) => {
    const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
    const challenge = gateway.authStore.challenge({ device_id: identity.device, method, target, body_hash: b64url(sha(body)) });
    const record = proofRecord(origin, challenge.id, Buffer.from(challenge.nonce, 'base64url'), identity.device, challenge.epoch, method, target, sha(body));
    const signature = sign(null, record, { key: identity.privateKey, dsaEncoding: 'ieee-p1363' });
    return () => fetch(`http://127.0.0.1:${gateway.address().port}${target}`, { method, headers: { 'content-type': 'application/json', 'x-viq-device': identity.device, 'x-viq-challenge': challenge.id, 'x-viq-signature': b64url(signature), authorization: 'Bearer caller-must-not-pass', cookie: 'caller=must-not-pass' }, body: body.length ? body : undefined });
  };
  const signed = (identity, method, target, value) => prepare(identity, method, target, value)();
  return {
    dir, upstream, gateway, base: `http://127.0.0.1:${gateway.address().port}`, pair, prepare, signed, upstreamRequests, notes, tickets,
    exact: () => pair({ actorId: 'artem', actorName: 'Artem', deviceId: 'artems-macbook-pro' }),
    failNextMutation(status) { failNext = status; },
    auditOf(action) { return gateway.authStore.status().audit.filter((row) => row.action === action); },
    get mutationHits() { return mutationHits; }
  };
}
const cleanup = async (f) => { await close(f.gateway); await close(f.upstream); await rm(f.dir, { recursive: true, force: true }); };

// Every write route the broker must keep refusing, minus the three this change delegates.
const forbiddenWrites = [
  ['POST', '/v1/projects', { key: 'NO' }], ['POST', '/v1/tickets/VC-1/delete', { confirmed: true }], ['POST', '/v1/tickets/VC-1/events', { message: 'x' }],
  ['POST', '/v1/tickets/VC-1/board-position', { board_state: 'Open' }], ['POST', '/v1/tickets/VC-1/human-questions', { question: 'x' }],
  ['POST', '/v1/tickets/VC-1/questions/q/answer', { answer: 'x' }], ['POST', '/v1/tickets/VC-1/accept', {}], ['POST', '/v1/tickets/VC-1/reopen', {}],
  ['POST', '/v1/tickets/VC-1/blocks', { reason: 'x' }], ['POST', '/v1/tickets/VC-1/blocks/b/resolve', {}], ['POST', '/v1/devices/d/revoke', {}],
  ['POST', '/v1/machines/d/revoke', {}], ['POST', '/v1/machines/pairing-codes', {}], ['POST', '/v1/pairing-codes', {}], ['POST', '/v1/actors/a/roles', { role: 'x' }]
];

test('frozen Artem browser creates, edits and comments VC tickets through the broker', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();

  const created = await f.signed(artem, 'POST', '/v1/tickets', { project: 'VC', title: 'Delegated write spec' });
  assert.equal(created.status, 201); const createdBody = await created.json();
  assert.equal(createdBody.ticket.project, 'VC'); assert.equal(createdBody.ticket.title, 'Delegated write spec');

  const createdFull = await f.signed(artem, 'POST', '/v1/tickets', { project: 'VC', title: 'With body', description: 'Spec text', assignment: 'Human' });
  assert.equal(createdFull.status, 201); assert.equal((await createdFull.json()).ticket.description, 'Spec text');

  for (const change of [{ title: 'Renamed' }, { description: 'Spec in the ticket body' }, { assignment: 'Agent' }, { title: 'All three', description: 'Together', assignment: 'Human' }]) {
    const response = await f.signed(artem, 'PATCH', '/v1/tickets/VC-1', change);
    assert.equal(response.status, 200, JSON.stringify(change));
    const { ticket } = await response.json(); for (const [field, value] of Object.entries(change)) assert.equal(ticket[field], value, field);
  }

  const noted = await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'Preflight green, PR open.' });
  assert.equal(noted.status, 201); const notedBody = await noted.json();
  assert.ok(notedBody.event.text.includes('Preflight green, PR open.'), notedBody.event.text);
  assert.ok(notedBody.event.text.includes(ATTRIBUTION), `note text must carry ${ATTRIBUTION}, got ${notedBody.event.text}`);
  assert.equal(f.notes.at(-1).event.text, notedBody.event.text);

  // The spec body is not annotated: attribution belongs in comments and in the audit, not in the ticket text.
  for (const request of f.upstreamRequests.filter(({ method, url }) => method !== 'GET' && !url.endsWith('/notes'))) {
    const sent = JSON.parse(request.body); for (const field of ['title', 'description']) if (field in sent) assert.ok(!String(sent[field]).includes('via gateway'), `${field} must not be annotated`);
  }
  // The browser's own Authorization is never authority upstream.
  for (const request of f.upstreamRequests) { assert.equal(request.authorization, 'Bearer test_upstream_admin_credential', request.url); assert.equal(request.cookie, undefined); }
});

test('a VC ticket created through the broker is immediately editable and commentable', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  const created = await f.signed(artem, 'POST', '/v1/tickets', { project: 'VC', title: 'Sixth' });
  assert.equal(created.status, 201); const id = (await created.json()).ticket.id; assert.equal(id, 'VC-6');
  assert.equal((await f.signed(artem, 'PATCH', `/v1/tickets/${id}`, { description: 'Spec' })).status, 200);
  assert.equal((await f.signed(artem, 'POST', `/v1/tickets/${id}/notes`, { message: 'Started.' })).status, 201);
  // State stays frozen on VC-1..VC-5 by the spec; the widened boundary applies to writes only.
  const before = f.mutationHits;
  assert.equal((await f.signed(artem, 'POST', `/v1/tickets/${id}/state`, { state: 'Working' })).status, 403);
  assert.equal(f.mutationHits, before);
});

test('existing frozen VC state transitions keep working unchanged', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (let n = 1; n <= 5; n++) for (const state of ['Open', 'Working', 'Waiting', 'Done']) assert.equal((await f.signed(artem, 'POST', `/v1/tickets/VC-${n}/state`, { state })).status, 200, `VC-${n} ${state}`);
  assert.equal(f.mutationHits, 20);
  const audit = f.auditOf('vc_state_changed'); assert.equal(audit.length, 20); // newest first
  assert.deepEqual(JSON.parse(audit[0].detail), { actor_id: 'artem', ticket_id: 'VC-5', state: 'Done', upstream_actor: 'maks', attribution: 'gateway-delegated via shared admin credential' });
});

test('delegated VC writes are audited locally, and only after upstream accepts', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets', { project: 'VC', title: 'Audited' })).status, 201);
  assert.equal((await f.signed(artem, 'PATCH', '/v1/tickets/VC-2', { title: 'Audited edit' })).status, 200);
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-2/notes', { message: 'Audited note' })).status, 201);
  const audit = f.auditOf('vc_ticket_written'); assert.equal(audit.length, 3);
  for (const row of audit) { assert.equal(row.device_id, 'artems-macbook-pro'); const detail = JSON.parse(row.detail); for (const [key, value] of Object.entries(DELEGATED_AUDIT)) assert.equal(detail[key], value, key); }
  for (const row of audit.slice(0, 2)) assert.equal(JSON.parse(row.detail).ticket_id, 'VC-2'); // newest first: note, then edit
  f.failNextMutation(500);
  assert.notEqual((await f.signed(artem, 'POST', '/v1/tickets/VC-2/notes', { message: 'Refused upstream' })).status, 201);
  assert.equal(f.auditOf('vc_ticket_written').length, 3);
});

test('delegated VC writes fail closed on the object boundary before any upstream mutation', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  const outsideVc = ['VIQ-1', 'LIVE1', 'PRIVATEA1', 'VCX-1', 'VC-99', 'VC-404'];
  for (const id of outsideVc) {
    for (const attempt of [['PATCH', `/v1/tickets/${id}`, { title: 'no' }], ['POST', `/v1/tickets/${id}/notes`, { message: 'no' }]]) {
      const before = f.mutationHits;
      assert.equal((await f.signed(artem, attempt[0], attempt[1], attempt[2])).status, 403, `${attempt[0]} ${attempt[1]}`);
      assert.equal(f.mutationHits, before, `${attempt[0]} ${attempt[1]} reached upstream`);
    }
  }
  for (const value of [{ project: 'VIQ', title: 'no' }, { project: 'OTHER', title: 'no' }, { project: 'vc', title: 'no' }, { title: 'no project' }, { project: null, title: 'no' }]) {
    const before = f.mutationHits;
    assert.equal((await f.signed(artem, 'POST', '/v1/tickets', value)).status, 403, JSON.stringify(value));
    assert.equal(f.mutationHits, before, JSON.stringify(value));
  }
});

test('delegated VC writes fail closed on request schema before any upstream mutation', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  const denied = [
    ['POST', '/v1/tickets', { project: 'VC', title: 'x', assignee: 'artem' }], ['POST', '/v1/tickets', { project: 'VC', title: 'x', worker_actor_id: 'w' }],
    ['POST', '/v1/tickets', { project: 'VC', title: 'x', body: 'legacy' }], ['POST', '/v1/tickets', { project: 'VC', title: 'x', state: 'Done' }],
    ['POST', '/v1/tickets', { project: 'VC' }], ['POST', '/v1/tickets', {}], ['POST', '/v1/tickets', null],
    ['PATCH', '/v1/tickets/VC-1', { project: 'VIQ' }], ['PATCH', '/v1/tickets/VC-1', { title: 'x', project: 'VC' }],
    ['PATCH', '/v1/tickets/VC-1', { assignee: 'artem' }], ['PATCH', '/v1/tickets/VC-1', { body: 'legacy' }],
    ['PATCH', '/v1/tickets/VC-1', { title: 'x', state: 'Done' }], ['PATCH', '/v1/tickets/VC-1', {}], ['PATCH', '/v1/tickets/VC-1', null],
    ['POST', '/v1/tickets/VC-1/notes', {}], ['POST', '/v1/tickets/VC-1/notes', { message: '' }], ['POST', '/v1/tickets/VC-1/notes', { message: '   ' }],
    ['POST', '/v1/tickets/VC-1/notes', { message: 42 }], ['POST', '/v1/tickets/VC-1/notes', { message: 'x', actor: 'artem' }], ['POST', '/v1/tickets/VC-1/notes', null],
    ['PATCH', '/v1/tickets/VC-1?x=1', { title: 'x' }], ['POST', '/v1/tickets?x=1', { project: 'VC', title: 'x' }], ['POST', '/v1/tickets/VC-1/notes?x=1', { message: 'x' }]
  ];
  for (const [method, target, value] of denied) {
    const before = f.mutationHits;
    assert.equal((await f.signed(artem, method, target, value)).status, 403, `${method} ${target} ${JSON.stringify(value)}`);
    assert.equal(f.mutationHits, before, `${method} ${target} reached upstream`);
  }
  const oversize = f.mutationHits;
  const long = await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'x'.repeat(65536) });
  assert.ok(long.status !== 200 && long.status !== 201, `oversize note must be refused, got ${long.status}`);
  assert.equal(f.mutationHits, oversize, 'oversize note reached upstream');
});

test('delegated VC writes fail closed for every identity but the frozen Artem browser', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const attempts = [['POST', '/v1/tickets', { project: 'VC', title: 'x' }], ['PATCH', '/v1/tickets/VC-1', { title: 'x' }], ['POST', '/v1/tickets/VC-1/notes', { message: 'x' }]];
  const others = [
    f.pair({ actorId: 'other', actorName: 'Other' }),
    f.pair({ actorId: 'artem', actorName: 'Artem' }),
    f.pair({ actorId: 'artem', actorName: 'Artem', kind: 'worker' }),
    f.pair({ actorId: 'artem', actorName: 'Artem', actorActive: false })
  ];
  for (const identity of others) for (const [method, target, value] of attempts) {
    const before = f.mutationHits;
    assert.equal((await f.signed(identity, method, target, value)).status, 403, `${method} ${target}`);
    assert.equal(f.mutationHits, before, `${method} ${target}`);
  }
  // Unpaired browser: no device proof at all.
  for (const [method, target, value] of attempts) {
    const before = f.mutationHits;
    const response = await fetch(`${f.base}${target}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer caller-must-not-pass' }, body: JSON.stringify(value) });
    assert.equal(response.status, 403, `anonymous ${method} ${target}`); assert.equal(f.mutationHits, before);
  }
  // Revoked between signing and sending: the proof is valid, the device is not.
  const revoked = f.exact(); const send = f.prepare(revoked, 'POST', '/v1/tickets/VC-1/notes', { message: 'x' });
  f.gateway.authStore.revoke(revoked.device); const before = f.mutationHits;
  assert.equal((await send()).status, 403); assert.equal(f.mutationHits, before);
});

test('the exact device id with a worker kind or an inactive actor is still refused', async (t) => {
  for (const overrides of [{ kind: 'worker' }, { actorActive: false }]) {
    const f = await fixture(); t.after(() => cleanup(f));
    const identity = f.pair({ actorId: 'artem', actorName: 'Artem', deviceId: 'artems-macbook-pro', ...overrides });
    for (const [method, target, value] of [['POST', '/v1/tickets', { project: 'VC', title: 'x' }], ['PATCH', '/v1/tickets/VC-1', { title: 'x' }], ['POST', '/v1/tickets/VC-1/notes', { message: 'x' }]]) {
      const before = f.mutationHits;
      assert.equal((await f.signed(identity, method, target, value)).status, 403, `${JSON.stringify(overrides)} ${method} ${target}`);
      assert.equal(f.mutationHits, before);
    }
  }
});

test('every other write route stays blocked before upstream for the frozen Artem browser', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (const [method, target, value] of forbiddenWrites) {
    const before = f.mutationHits;
    assert.equal((await f.signed(artem, method, target, value)).status, 403, `${method} ${target}`);
    assert.equal(f.mutationHits, before, `${method} ${target} reached upstream`);
  }
  assert.equal(f.mutationHits, 0);
});
