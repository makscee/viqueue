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
const DELEGATED_AUDIT = { actor_id: 'artem', device_id: 'artems-macbook-pro', upstream_actor: 'maks', attribution: 'gateway-delegated via shared admin credential' };
const MAX_NOTE = 8000;
const writes = [['POST', '/v1/tickets', { project: 'VC', title: 'x' }], ['PATCH', '/v1/tickets/VC-1', { title: 'x' }], ['POST', '/v1/tickets/VC-1/notes', { message: 'x' }], ['POST', '/v1/tickets/VC-1/state', { state: 'Done' }]];
// The whole detail, never a projection of it: a leaked extra key must fail the comparison.
const writtenAudit = (operation, extra = {}) => ({ operation, ...DELEGATED_AUDIT, ...extra });
const stateAudit = (extra) => ({ actor_id: 'artem', upstream_actor: 'maks', ...extra });
const metadataOfBytes = (total, { cyrillic = false } = {}) => {
  const room = total - Buffer.byteLength(JSON.stringify({ note: '' })); const wide = cyrillic ? Math.floor(room / 2) : 0;
  return { note: 'я'.repeat(wide) + 'x'.repeat(room - wide * 2) };
};
// Every reason the trail may name, and whether the device was established when the refusal happened.
const DENIAL_DEVICE = { credential_malformed: null, body_unparsable: null, schema_refused: null, identity_unresolved: null, identity_lookup_failed: null, identity_mismatch: null, rate_limited: null, object_absent: 'artems-macbook-pro', object_outside_project: 'artems-macbook-pro', object_lookup_failed: 'artems-macbook-pro' };

const seedTickets = () => new Map([
  ...Array.from({ length: 5 }, (_, i) => [`VC-${i + 1}`, { id: `VC-${i + 1}`, project: 'VC', title: `Ticket ${i + 1}`, description: '', assignment: 'Human', state: 'Open' }]),
  ['VIQ-1', { id: 'VIQ-1', project: 'VIQ', title: 'Foreign', description: '', assignment: 'Human', state: 'Open' }],
  ['LIVE1', { id: 'LIVE1', project: 'LIVE', title: 'Foreign', description: '', assignment: 'Human', state: 'Open' }],
  ['PRIVATEA1', { id: 'PRIVATEA1', project: 'PRIVATEA', title: 'Foreign', description: '', assignment: 'Human', state: 'Open' }],
  ['VCX-1', { id: 'VCX-1', project: 'VCX', title: 'Lookalike project', description: '', assignment: 'Human', state: 'Open' }],
  ['VC-99', { id: 'VC-99', project: 'OTHER', title: 'Lookalike id', description: '', assignment: 'Human', state: 'Open' }],
  ['VC-201', { id: 'VC-201', project: 'vc', title: 'Lowercase project', description: '', assignment: 'Human', state: 'Open' }],
  ['VC-202', { id: 'VC-202', project: 'Vc', title: 'Mixed-case project', description: '', assignment: 'Human', state: 'Open' }]
]);
// The frozen identity, and one variant per field. Each variant differs in exactly that field, so
// removing any single check upstream reddens exactly its own case and nothing else.
const FROZEN_IDENTITY = { device: { id: 'artems-macbook-pro', kind: 'coordinator', status: 'active', admin: false }, actor: { id: 'artem', active: true, admin: false } };
const bearerFieldVariants = [
  ['actor.id', 'actor', 'id', 'other'], ['actor.active', 'actor', 'active', false], ['actor.admin', 'actor', 'admin', true],
  ['device.id', 'device', 'id', 'other-device'], ['device.kind', 'device', 'kind', 'worker'],
  ['device.status', 'device', 'status', 'revoked'], ['device.admin', 'device', 'admin', true]
].map(([field, group, key, value]) => ({ field, token: `off_${group}_${key}_token`, identity: { ...FROZEN_IDENTITY, [group]: { ...FROZEN_IDENTITY[group], [key]: value } } }));
const bearerIdentities = new Map([['core_artem_token', FROZEN_IDENTITY], ...bearerFieldVariants.map(({ token, identity }) => [token, identity])]);

async function fixture({ requestTimeoutMs } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viq-vc-writes-'));
  const tickets = seedTickets(); const upstreamRequests = []; const notes = [];
  let mutationHits = 0, ticketReads = 0, nextNumber = 6, noteCursor = 0, failNext = null, lookupFailure = null, identityFailure = null;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    upstreamRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body: rawBody });
    if (req.method !== 'GET') mutationHits++; else if (req.url.startsWith('/v1/tickets/')) ticketReads++;
    res.setHeader('content-type', 'application/json');
    const forced = failNext; if (forced !== null && req.method !== 'GET') { failNext = null; res.statusCode = forced; return res.end(JSON.stringify({ error: { code: 'upstream_refused' } })); }
    let parsed = {}; try { parsed = rawBody ? JSON.parse(rawBody) : {}; } catch { parsed = {}; }
    const idOf = (value) => decodeURIComponent(value);
    let match;
    if (req.url === '/v1/devices/me' && req.headers.authorization !== 'Bearer test_upstream_admin_credential') {
      if (identityFailure === 'status503') { res.statusCode = 503; return res.end(JSON.stringify({ error: { code: 'unavailable' } })); }
      if (identityFailure === 'status401' || identityFailure === 'status403') { res.statusCode = identityFailure === 'status401' ? 401 : 403; return res.end(JSON.stringify({ error: { code: 'device_unauthorized' } })); }
      if (identityFailure === 'badjson') return res.end('{ this is not json');
      if (identityFailure === 'transport') return req.socket.destroy();
      if (identityFailure === 'hang') return;
      const identity = bearerIdentities.get(req.headers.authorization?.slice(7));
      if (!identity) { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: 'device_unauthorized' } })); }
      return res.end(JSON.stringify(identity));
    }
    if (req.method === 'GET' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)$/))) {
      if (lookupFailure === 'status503') { res.statusCode = 503; return res.end(JSON.stringify({ error: { code: 'unavailable' } })); }
      if (lookupFailure === 'badjson') return res.end('{ this is not json');
      if (lookupFailure === 'transport') return req.socket.destroy();
      if (lookupFailure === 'hang') return;
      const ticket = tickets.get(idOf(match[1]));
      if (!ticket) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'ticket_not_found' } })); }
      return res.end(JSON.stringify({ ticket }));
    }
    if (req.method === 'POST' && req.url === '/v1/tickets') {
      const id = `VC-${nextNumber++}`; const ticket = { id, project: parsed.project, title: String(parsed.title).trim(), description: String(parsed.description ?? '').trim(), assignment: parsed.assignment ?? 'Unassigned', state: 'Open' };
      tickets.set(id, ticket); res.statusCode = 201; return res.end(JSON.stringify({ ticket }));
    }
    if (req.method === 'PATCH' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)$/))) {
      const ticket = tickets.get(idOf(match[1]));
      if (!ticket) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 'ticket_not_found' } })); }
      for (const field of ['title', 'description']) if (field in parsed) ticket[field] = String(parsed[field]).trim();
      if ('assignment' in parsed) ticket.assignment = parsed.assignment;
      return res.end(JSON.stringify({ ticket }));
    }
    if (req.method === 'POST' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)\/notes$/))) {
      const cursor = ++noteCursor; const event = { cursor, type: 'progress', text: String(parsed.message).trim(), metadata: parsed.metadata ?? null };
      notes.push({ ticket: idOf(match[1]), event }); res.statusCode = 201; return res.end(JSON.stringify({ event, cursor }));
    }
    if (req.method === 'POST' && (match = req.url.match(/^\/v1\/tickets\/([^/?]+)\/state$/))) {
      const ticket = tickets.get(idOf(match[1])); if (ticket) ticket.state = parsed.state;
      return res.end(JSON.stringify({ ticket: ticket ?? { id: idOf(match[1]), project: 'VC', state: parsed.state } }));
    }
    return res.end(JSON.stringify({ ok: true }));
  });
  await listen(upstream); const origin = 'https://phone.test';
  const gateway = await createPhoneGateway({ authDb: path.join(dir, 'auth.sqlite'), origin, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamAuthorization: 'test_upstream_admin_credential', testMode: true, ...(requestTimeoutMs === undefined ? {} : { testHooks: { requestTimeoutMs } }) });
  await listen(gateway); const base = `http://127.0.0.1:${gateway.address().port}`;
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
    return () => fetch(`${base}${target}`, { method, headers: { 'content-type': 'application/json', 'x-viq-device': identity.device, 'x-viq-challenge': challenge.id, 'x-viq-signature': b64url(signature), authorization: 'Bearer caller-must-not-pass', cookie: 'caller=must-not-pass' }, body: body.length ? body : undefined });
  };
  const signed = (identity, method, target, value) => prepare(identity, method, target, value)();
  // Bearer delegation: no signed x-viq-* headers, the device credential itself is the claim.
  const bearer = (method, target, value, authorization) => fetch(`${base}${target}`, { method, headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: value === undefined ? undefined : JSON.stringify(value) });
  const bearerAs = (token, method, target, value) => bearer(method, target, value, `Bearer ${token}`);
  const bearerRaw = (token, method, target, rawBody) => fetch(`${base}${target}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: rawBody });
  return {
    dir, upstream, gateway, base, pair, prepare, signed, bearer, bearerAs, bearerRaw, upstreamRequests, notes, tickets,
    lastDenial() { return this.auditOf('vc_delegation_denied')[0]; },
    exact: () => pair({ actorId: 'artem', actorName: 'Artem', deviceId: 'artems-macbook-pro' }),
    failNextMutation(status) { failNext = status; },
    failLookup(mode) { lookupFailure = mode; },
    failIdentity(mode) { identityFailure = mode; },
    auditOf(action) { return gateway.authStore.status().audit.filter((row) => row.action === action); },
    get mutationHits() { return mutationHits; },
    get ticketReads() { return ticketReads; },
    get upstreamHits() { return upstreamRequests.length; }
  };
}
const cleanup = async (f) => { await close(f.gateway); await close(f.upstream); await rm(f.dir, { recursive: true, force: true }); };

// Every write route the broker must keep refusing, minus the four it delegates.
const forbiddenWrites = [
  ['POST', '/v1/projects', { key: 'NO' }], ['POST', '/v1/tickets/VC-1/delete', { confirmed: true }], ['POST', '/v1/tickets/VC-1/events', { message: 'x' }],
  ['POST', '/v1/tickets/VC-1/board-position', { board_state: 'Open' }], ['POST', '/v1/tickets/VC-1/human-questions', { question: 'x' }],
  ['POST', '/v1/tickets/VC-1/questions/q/answer', { answer: 'x' }], ['POST', '/v1/tickets/VC-1/accept', {}], ['POST', '/v1/tickets/VC-1/reopen', {}],
  ['POST', '/v1/tickets/VC-1/blocks', { reason: 'x' }], ['POST', '/v1/tickets/VC-1/blocks/b/resolve', {}], ['POST', '/v1/devices/d/revoke', {}],
  ['POST', '/v1/machines/d/revoke', {}], ['POST', '/v1/machines/pairing-codes', {}], ['POST', '/v1/pairing-codes', {}], ['POST', '/v1/actors/a/roles', { role: 'x' }]
];
// Path segments that cannot be a ticket id. None of them may become an upstream lookup.
const malformedIds = ['VC%2D1', 'VC%201', 'A'.repeat(65), '-VC-1', '.VC-1', '_VC-1', 'VC-1;x', 'VC-1~x', 'VC-1(x)'];

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

  const noted = await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'Preflight green, PR open.', metadata: { pr: '#46' } });
  assert.equal(noted.status, 201); const notedBody = await noted.json();
  assert.ok(notedBody.event.text.includes('Preflight green, PR open.'), notedBody.event.text);
  assert.ok(notedBody.event.text.includes(ATTRIBUTION), `note text must carry ${ATTRIBUTION}, got ${notedBody.event.text}`);
  assert.deepEqual(notedBody.event.metadata, { pr: '#46' });
  assert.equal(f.notes.at(-1).event.text, notedBody.event.text);

  // The spec body is not annotated: attribution belongs in comments and in the audit, not in the ticket text.
  for (const request of f.upstreamRequests.filter(({ method, url }) => method !== 'GET' && !url.endsWith('/notes'))) {
    const sent = JSON.parse(request.body); for (const field of ['title', 'description']) if (field in sent) assert.ok(!String(sent[field]).includes('via gateway'), `${field} must not be annotated`);
  }
  // The browser's own Authorization is never authority upstream.
  for (const request of f.upstreamRequests) { assert.equal(request.authorization, 'Bearer test_upstream_admin_credential', request.url); assert.equal(request.cookie, undefined); }
});

test('the attribution prefix is the first line and the note text below it is untouched', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (const message of ['Preflight green.', 'Строка один.\nСтрока два.\n\nХвост.', 'хвостовые пробелы срезает апстрим   ']) {
    const response = await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message });
    assert.equal(response.status, 201, message);
    const sent = JSON.parse(f.upstreamRequests.at(-1).body);
    // The broker's contract is what it sends: prefix, newline, then the author's text byte for byte.
    assert.equal(sent.message, `${ATTRIBUTION}\n${message}`, 'prefix must be the whole first line, then the original text unchanged');
    // What is stored is the upstream's business: #appendManualEvent runs cleanOptional, which trims (store.js:12).
    assert.equal((await response.json()).event.text, sent.message.trim());
  }
});

test('a note of 8000 characters passes and 8001 is refused before any upstream read', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (const filler of ['x', 'я']) {
    assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: filler.repeat(MAX_NOTE) })).status, 201, `${filler} x${MAX_NOTE}`);
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: filler.repeat(MAX_NOTE + 1) })).status, 403, `${filler} x${MAX_NOTE + 1}`);
    assert.equal(f.upstreamHits, before, 'an over-long note must not reach upstream at all');
  }
});

test('a VC ticket created through the broker is immediately editable, commentable and movable', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  const created = await f.signed(artem, 'POST', '/v1/tickets', { project: 'VC', title: 'Sixth' });
  assert.equal(created.status, 201); const id = (await created.json()).ticket.id; assert.equal(id, 'VC-6');
  assert.equal((await f.signed(artem, 'PATCH', `/v1/tickets/${id}`, { description: 'Spec' })).status, 200);
  assert.equal((await f.signed(artem, 'POST', `/v1/tickets/${id}/notes`, { message: 'Started.' })).status, 201);
  assert.equal((await f.signed(artem, 'POST', `/v1/tickets/${id}/state`, { state: 'Working' })).status, 200, 'the object boundary is the project, not a literal id list');
});

test('state moves any VC ticket and refuses foreign, unknown and malformed ones', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (let n = 1; n <= 5; n++) for (const state of ['Open', 'Working', 'Waiting', 'Done']) assert.equal((await f.signed(artem, 'POST', `/v1/tickets/VC-${n}/state`, { state })).status, 200, `VC-${n} ${state}`);
  assert.equal(f.mutationHits, 20);
  const audit = f.auditOf('vc_state_changed'); assert.equal(audit.length, 20); // newest first
  assert.deepEqual(JSON.parse(audit[0].detail), { actor_id: 'artem', ticket_id: 'VC-5', state: 'Done', upstream_actor: 'maks', attribution: 'gateway-delegated via shared admin credential' });
  for (const id of ['VIQ-1', 'LIVE1', 'PRIVATEA1', 'VCX-1', 'VC-99', 'VC-404']) {
    const before = f.mutationHits;
    assert.equal((await f.signed(artem, 'POST', `/v1/tickets/${id}/state`, { state: 'Done' })).status, 403, id);
    assert.equal(f.mutationHits, before, id);
  }
  for (const id of malformedIds) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, 'POST', `/v1/tickets/${id}/state`, { state: 'Done' })).status, 403, id);
    assert.equal(f.upstreamHits, before, `${id} must not become an upstream lookup`);
  }
});

test('delegated writes refuse a malformed ticket id without any upstream read', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (const id of malformedIds) for (const [method, target, value] of [['PATCH', `/v1/tickets/${id}`, { title: 'x' }], ['POST', `/v1/tickets/${id}/notes`, { message: 'x' }]]) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, method, target, value)).status, 403, `${method} ${target}`);
    assert.equal(f.upstreamHits, before, `${method} ${target} must not become an upstream lookup`);
  }
});

test('delegated VC writes are audited under operation, and only after upstream accepts', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets', { project: 'VC', title: 'Audited' })).status, 201);
  assert.equal((await f.signed(artem, 'PATCH', '/v1/tickets/VC-2', { title: 'Audited edit' })).status, 200);
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-2/notes', { message: 'Audited note' })).status, 201);
  const audit = f.auditOf('vc_ticket_written'); assert.equal(audit.length, 3);
  for (const row of audit) { assert.equal(row.device_id, 'artems-macbook-pro'); assert.equal('action' in JSON.parse(row.detail), false, 'the key is operation, not action'); }
  // Newest first. The signed path carries no auth_mode, and create has no ticket id before the upstream answer.
  // Compared whole: nothing the spec does not name may ride along in a delegation trail.
  assert.deepEqual(audit.map((row) => JSON.parse(row.detail)), [writtenAudit('note', { ticket_id: 'VC-2' }), writtenAudit('edit', { ticket_id: 'VC-2' }), writtenAudit('create')]);
  f.failNextMutation(500);
  assert.notEqual((await f.signed(artem, 'POST', '/v1/tickets/VC-2/notes', { message: 'Refused upstream' })).status, 201);
  assert.equal(f.auditOf('vc_ticket_written').length, 3);
});

test('delegated VC writes fail closed on the object boundary, consulting upstream exactly once', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (const id of ['VIQ-1', 'LIVE1', 'PRIVATEA1', 'VCX-1', 'VC-99', 'VC-404']) {
    for (const [method, target, value] of [['PATCH', `/v1/tickets/${id}`, { title: 'no' }], ['POST', `/v1/tickets/${id}/notes`, { message: 'no' }]]) {
      const mutations = f.mutationHits, reads = f.ticketReads;
      assert.equal((await f.signed(artem, method, target, value)).status, 403, `${method} ${target}`);
      assert.equal(f.mutationHits, mutations, `${method} ${target} reached upstream`);
      assert.equal(f.ticketReads, reads + 1, `${method} ${target} must decide on exactly one upstream lookup`);
    }
  }
  for (const value of [{ project: 'VIQ', title: 'no' }, { project: 'OTHER', title: 'no' }, { project: 'vc', title: 'no' }, { title: 'no project' }, { project: null, title: 'no' }]) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, 'POST', '/v1/tickets', value)).status, 403, JSON.stringify(value));
    assert.equal(f.upstreamHits, before, JSON.stringify(value));
  }
});

test('delegated VC writes fail closed on request schema before any upstream request at all', async (t) => {
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
    ['PATCH', '/v1/tickets/VC-1?x=1', { title: 'x' }], ['POST', '/v1/tickets?x=1', { project: 'VC', title: 'x' }], ['POST', '/v1/tickets/VC-1/notes?x=1', { message: 'x' }],
    ['POST', '/v1/tickets/VC-1/state', { state: 'Review' }], ['POST', '/v1/tickets/VC-1/state', { state: 'Done', extra: true }], ['POST', '/v1/tickets/VC-1/state', {}]
  ];
  for (const [method, target, value] of denied) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, method, target, value)).status, 403, `${method} ${target} ${JSON.stringify(value)}`);
    assert.equal(f.upstreamHits, before, `${method} ${target} ${JSON.stringify(value)} went upstream on a body the broker had already refused`);
  }
});

test('delegated VC writes fail closed for an unpaired or revoked browser', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  // Unpaired browser: no device proof at all.
  for (const [method, target, value] of writes) {
    const before = f.upstreamHits;
    const response = await fetch(`${f.base}${target}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 403, `anonymous ${method} ${target}`); assert.equal(f.upstreamHits, before);
  }
  // Revoked between signing and sending: the proof is valid, the device is not.
  const revoked = f.exact(); const send = f.prepare(revoked, 'POST', '/v1/tickets/VC-1/notes', { message: 'x' });
  f.gateway.authStore.revoke(revoked.device); const before = f.upstreamHits;
  assert.equal((await send()).status, 403); assert.equal(f.upstreamHits, before);
});

test('the signed browser is refused when a single field differs from the frozen identity', async (t) => {
  const variants = [
    ['actor_id', { actorId: 'other', deviceId: 'artems-macbook-pro' }],
    ['device id', { actorId: 'artem', deviceId: 'another-macbook-pro' }],
    ['kind', { actorId: 'artem', deviceId: 'artems-macbook-pro', kind: 'worker' }],
    ['actor_active', { actorId: 'artem', deviceId: 'artems-macbook-pro', actorActive: false }]
  ];
  for (const [field, overrides] of variants) {
    const f = await fixture(); t.after(() => cleanup(f));
    const identity = f.pair({ actorName: 'Artem', ...overrides });
    for (const [method, target, value] of writes) {
      const before = f.upstreamHits;
      assert.equal((await f.signed(identity, method, target, value)).status, 403, `${field} ${method} ${target}`);
      assert.equal(f.upstreamHits, before, `${field} ${method} ${target}`);
    }
  }
});

test('every other write route stays blocked before upstream for the frozen Artem browser', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  for (const [method, target, value] of forbiddenWrites) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, method, target, value)).status, 403, `${method} ${target}`);
    assert.equal(f.upstreamHits, before, `${method} ${target} reached upstream`);
  }
  assert.equal(f.upstreamHits, 0);
});

test('the frozen Artem Bearer delegates all four VC writes without a browser', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const created = await f.bearerAs('core_artem_token', 'POST', '/v1/tickets', { project: 'VC', title: 'From the CLI' });
  assert.equal(created.status, 201); assert.equal((await created.json()).ticket.id, 'VC-6');
  assert.equal((await f.bearerAs('core_artem_token', 'PATCH', '/v1/tickets/VC-6', { description: 'Spec' })).status, 200);
  const noted = await f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-6/notes', { message: 'Started from the CLI.' });
  assert.equal(noted.status, 201);
  assert.equal(JSON.parse(f.upstreamRequests.at(-1).body).message, `${ATTRIBUTION}\nStarted from the CLI.`);
  assert.equal((await f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-6/state', { state: 'Working' })).status, 200, 'a ticket the CLI just created is movable by the same credential');
  assert.equal((await f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-1/state', { state: 'Done' })).status, 200);
  // The caller's own credential proves identity upstream and never writes.
  assert.ok(f.upstreamRequests.filter(({ authorization }) => authorization === 'Bearer core_artem_token').every(({ method, url }) => method === 'GET' && url === '/v1/devices/me'));
  for (const request of f.upstreamRequests.filter(({ method }) => method !== 'GET')) assert.equal(request.authorization, 'Bearer test_upstream_admin_credential');
  const written = f.auditOf('vc_ticket_written'); assert.equal(written.length, 3);
  const bearer = { auth_mode: 'bearer-delegation' };
  assert.deepEqual(written.map((row) => JSON.parse(row.detail)), [ // newest first
    { ...bearer, ...writtenAudit('note', { ticket_id: 'VC-6' }) }, { ...bearer, ...writtenAudit('edit', { ticket_id: 'VC-6' }) }, { ...bearer, ...writtenAudit('create') }
  ]);
  for (const row of written) assert.equal(row.device_id, 'artems-macbook-pro');
  const moved = f.auditOf('vc_state_changed'); assert.equal(moved.length, 2);
  assert.deepEqual(moved.map((row) => JSON.parse(row.detail)), [ // newest first
    { ...bearer, ...stateAudit({ device_id: 'artems-macbook-pro', ticket_id: 'VC-1', state: 'Done' }) },
    { ...bearer, ...stateAudit({ device_id: 'artems-macbook-pro', ticket_id: 'VC-6', state: 'Working' }) }
  ]);
  assert.equal(f.auditOf('vc_delegation_denied').length, 0, 'a write that succeeded is not a denial');
});

test('Bearer delegation is refused when a single identity field differs from the frozen one', async (t) => {
  // A fixture per credential: identity failures spend the anonymous-probe bucket, and this test
  // is about the 403 each field earns, not about the cap that arrives after ten of them.
  for (const { field, token } of [...bearerFieldVariants, { field: 'unknown credential', token: 'invalid_token_value' }]) {
    const f = await fixture(); t.after(() => cleanup(f));
    for (const [method, target, value] of writes) {
      const before = f.mutationHits;
      assert.equal((await f.bearerAs(token, method, target, value)).status, 403, `${field} ${method} ${target}`);
      assert.equal(f.mutationHits, before, `${field} ${method} ${target}`);
    }
  }
  const f = await fixture(); t.after(() => cleanup(f));
  for (const [method, target, value] of writes) {
    for (const authorization of [undefined, 'Basic nope', 'Bearer', `Bearer ${'x'.repeat(513)}`]) {
      const before = f.mutationHits;
      assert.equal((await f.bearer(method, target, value, authorization)).status, 403, `${authorization} ${method} ${target}`);
      assert.equal(f.mutationHits, before);
    }
  }
});

test('Bearer delegated writes fail closed on body and object before any upstream request', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const badBodies = [
    ['POST', '/v1/tickets', { project: 'VIQ', title: 'x' }], ['POST', '/v1/tickets', { project: 'VC', title: 'x', assignee: 'a' }], ['POST', '/v1/tickets', {}],
    ['PATCH', '/v1/tickets/VC-1', {}], ['PATCH', '/v1/tickets/VC-1', { project: 'VC' }],
    ['POST', '/v1/tickets/VC-1/notes', {}], ['POST', '/v1/tickets/VC-1/notes', { message: '' }], ['POST', '/v1/tickets/VC-1/notes', { message: 'x'.repeat(MAX_NOTE + 1) }]
  ];
  for (const [method, target, value] of badBodies) {
    const before = f.upstreamHits;
    assert.equal((await f.bearerAs('core_artem_token', method, target, value)).status, 403, `${method} ${target} ${JSON.stringify(value).slice(0, 60)}`);
    // Not even /v1/devices/me: forwarding the caller's token on a body we already refused makes the broker a credential oracle.
    assert.equal(f.upstreamHits, before, `${method} ${target} went upstream on a body the broker had already refused`);
  }
  for (const id of ['VIQ-1', 'VC-99', 'VC-404', ...malformedIds]) for (const [method, target, value] of [['PATCH', `/v1/tickets/${id}`, { title: 'x' }], ['POST', `/v1/tickets/${id}/notes`, { message: 'x' }]]) {
    const before = f.mutationHits;
    assert.equal((await f.bearerAs('core_artem_token', method, target, value)).status, 403, `${method} ${target}`);
    assert.equal(f.mutationHits, before, `${method} ${target}`);
  }
});

test('the project boundary is compared letter for letter', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  // Upstream project keys match ^[A-Za-z][A-Za-z0-9]{1,9}$, so `vc` and `Vc` are different projects, not VC.
  for (const id of ['VC-201', 'VC-202']) {
    for (const [method, target, value] of [['PATCH', `/v1/tickets/${id}`, { title: 'no' }], ['POST', `/v1/tickets/${id}/notes`, { message: 'no' }], ['POST', `/v1/tickets/${id}/state`, { state: 'Done' }]]) {
      const signedBefore = f.mutationHits;
      assert.equal((await f.signed(artem, method, target, value)).status, 403, `signed ${method} ${target}`);
      assert.equal(f.mutationHits, signedBefore, `signed ${method} ${target}`);
      const bearerBefore = f.mutationHits;
      assert.equal((await f.bearerAs('core_artem_token', method, target, value)).status, 403, `bearer ${method} ${target}`);
      assert.equal(f.mutationHits, bearerBefore, `bearer ${method} ${target}`);
    }
  }
  for (const project of ['vc', 'Vc', 'VC ', ' VC']) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, 'POST', '/v1/tickets', { project, title: 'no' })).status, 403, `create in ${JSON.stringify(project)}`);
    assert.equal(f.upstreamHits, before, `create in ${JSON.stringify(project)}`);
  }
});

test('bearer mode is entered only when no signed header is present at all', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  // A partial set of signed headers is a broken signed request, never an invitation to trust the Bearer.
  const partials = [
    { 'x-viq-device': 'artems-macbook-pro' }, { 'x-viq-challenge': 'challenge_value_0001' }, { 'x-viq-signature': 'x'.repeat(86) },
    { 'x-viq-challenge': 'challenge_value_0001', 'x-viq-signature': 'x'.repeat(86) },
    { 'x-viq-device': 'artems-macbook-pro', 'x-viq-signature': 'x'.repeat(86) },
    { 'x-viq-device': 'artems-macbook-pro', 'x-viq-challenge': 'challenge_value_0001' }
  ];
  for (const headers of partials) for (const [method, target, value] of writes) {
    const before = f.upstreamHits;
    const response = await fetch(`${f.base}${target}`, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer core_artem_token', ...headers }, body: JSON.stringify(value) });
    assert.equal(response.status, 403, `${Object.keys(headers)} ${method} ${target}`);
    assert.equal(f.upstreamHits, before, `${Object.keys(headers)} ${method} ${target}`);
  }
});

test('every declared body boundary refuses its far side before any upstream request', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  const accepted = [
    ['title at the cap', 'POST', '/v1/tickets', { project: 'VC', title: 'x'.repeat(200) }, 201],
    ['description at the cap', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', description: 'x'.repeat(20000) }, 201],
    ['no description', 'POST', '/v1/tickets', { project: 'VC', title: 'ok' }, 201],
    ['assignment Unassigned', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', assignment: 'Unassigned' }, 201],
    ['assignment Human', 'PATCH', '/v1/tickets/VC-1', { assignment: 'Human' }, 200],
    ['assignment Agent', 'PATCH', '/v1/tickets/VC-1', { assignment: 'Agent' }, 200],
    ['edit title at the cap', 'PATCH', '/v1/tickets/VC-1', { title: 'x'.repeat(200) }, 200],
    ['edit description at the cap', 'PATCH', '/v1/tickets/VC-1', { description: 'x'.repeat(20000) }, 200],
    ['metadata object', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: { pr: '#46' } }, 201],
    ['metadata null', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: null }, 201],
    ['metadata at the cap', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: metadataOfBytes(2048) }, 201]
  ];
  for (const [label, method, target, value, status] of accepted) assert.equal((await f.signed(artem, method, target, value)).status, status, label);
  const refused = [
    ['title past the cap', 'POST', '/v1/tickets', { project: 'VC', title: 'x'.repeat(201) }],
    ['description past the cap', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', description: 'x'.repeat(20001) }],
    ['description not text', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', description: 42 }],
    ['description null', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', description: null }],
    ['assignment unknown', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', assignment: 'Blocked' }],
    ['assignment wrong case', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', assignment: 'agent' }],
    ['assignment not text', 'POST', '/v1/tickets', { project: 'VC', title: 'ok', assignment: 42 }],
    ['title not text', 'POST', '/v1/tickets', { project: 'VC', title: 42 }],
    ['edit title past the cap', 'PATCH', '/v1/tickets/VC-1', { title: 'x'.repeat(201) }],
    ['edit description past the cap', 'PATCH', '/v1/tickets/VC-1', { description: 'x'.repeat(20001) }],
    ['edit description not text', 'PATCH', '/v1/tickets/VC-1', { description: 42 }],
    ['edit assignment unknown', 'PATCH', '/v1/tickets/VC-1', { assignment: 'Blocked' }],
    ['metadata array', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: [] }],
    ['metadata text', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: 'x' }],
    ['metadata number', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: 42 }],
    ['metadata past the cap', 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: metadataOfBytes(2049) }]
  ];
  for (const [label, method, target, value] of refused) {
    const before = f.upstreamHits;
    assert.equal((await f.signed(artem, method, target, value)).status, 403, label);
    assert.equal(f.upstreamHits, before, `${label} went upstream`);
  }
});

test('an upstream that cannot answer is reported as 502, not as a refused authorization', async (t) => {
  for (const mode of ['status503', 'badjson', 'transport']) {
    const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
    f.failLookup(mode);
    for (const [method, target, value] of [['PATCH', '/v1/tickets/VC-1', { title: 'x' }], ['POST', '/v1/tickets/VC-1/notes', { message: 'x' }], ['POST', '/v1/tickets/VC-1/state', { state: 'Done' }]]) {
      const before = f.mutationHits;
      const response = await f.signed(artem, method, target, value);
      assert.equal(response.status, 502, `${mode} ${method} ${target}`);
      assert.equal((await response.json()).error.code, 'upstream_unavailable', `${mode} ${method} ${target}`);
      assert.equal(f.mutationHits, before, `${mode} ${method} ${target}`);
    }
    assert.equal((await f.bearerAs('core_artem_token', 'PATCH', '/v1/tickets/VC-1', { title: 'x' })).status, 502, `${mode} bearer`);
  }
});

test('an upstream lookup that never answers is 502 once the request times out', async (t) => {
  const f = await fixture({ requestTimeoutMs: 200 }); t.after(() => cleanup(f)); const artem = f.exact();
  f.failLookup('hang');
  const response = await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'x' });
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'upstream_unavailable');
  assert.equal(f.mutationHits, 0);
});

test('a real boundary is still 403, not 502', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  // Project not VC, id mismatch is impossible to fake here, ticket absent upstream — each is a decision, not an outage.
  for (const [label, target] of [['foreign project', '/v1/tickets/VIQ-1'], ['case-different project', '/v1/tickets/VC-201'], ['absent upstream', '/v1/tickets/VC-404']]) {
    const response = await f.signed(artem, 'PATCH', target, { title: 'x' });
    assert.equal(response.status, 403, label);
    assert.equal((await response.json()).error.code, 'authorization_failed', label);
  }
});

test('a refused Bearer delegation leaves a trail that tells the classes apart', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const attempts = [
    ['schema', () => f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-1/notes', {})],
    ['identity', () => f.bearerAs('off_device_admin_token', 'POST', '/v1/tickets/VC-1/notes', { message: 'x' })],
    ['object', () => f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VIQ-1/notes', { message: 'x' })],
    ['unknown credential', () => f.bearerAs('invalid_token_value', 'POST', '/v1/tickets/VC-1/notes', { message: 'x' })]
  ];
  for (const [, attempt] of attempts) await attempt();
  f.failLookup('status503');
  await f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-1/notes', { message: 'x' });
  f.failLookup(null);
  const denied = f.auditOf('vc_delegation_denied');
  assert.equal(denied.length, 5, 'every refused bearer attempt leaves one row');
  for (const row of denied) {
    const detail = JSON.parse(row.detail);
    assert.equal(detail.auth_mode, 'bearer-delegation');
    assert.equal(detail.method, 'POST'); assert.match(detail.target, /^\/v1\/tickets\/[^/]+\/notes$/);
    assert.equal(typeof detail.reason, 'string'); assert.ok(detail.reason.length > 0);
  }
  // Newest first: outage, unknown credential, object, identity, schema — five classes, five distinct words from the agreed dictionary.
  const reasons = denied.map((row) => JSON.parse(row.detail).reason);
  assert.equal(new Set(reasons).size, 5, 'a trail that cannot tell an outage from a probe is not a trail');
  for (const reason of reasons) assert.ok(reason in DENIAL_DEVICE, `${reason} is not a word the trail is allowed to use`);
  assert.equal(JSON.parse(denied.at(-1).detail).target, '/v1/tickets/VC-1/notes');
  assert.equal(denied.at(-1).device_id, null, 'a body refused before the identity lookup has no device to name');
});

test('the signed path keeps its existing trail and grows no denial rows', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', {})).status, 403);
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VIQ-1/notes', { message: 'x' })).status, 403);
  assert.equal(f.auditOf('vc_delegation_denied').length, 0, 'store.authorize already records the signed attempt');
  assert.ok(f.auditOf('authorized').length >= 2);
});

test('an identity lookup that cannot answer is 502, and one that refuses is 403', async (t) => {
  for (const mode of ['status503', 'badjson', 'transport']) {
    const f = await fixture(); t.after(() => cleanup(f)); f.failIdentity(mode);
    for (const [method, target, value] of writes) {
      const before = f.mutationHits;
      const response = await f.bearerAs('core_artem_token', method, target, value);
      assert.equal(response.status, 502, `${mode} ${method} ${target}`);
      assert.equal((await response.json()).error.code, 'upstream_unavailable', `${mode} ${method} ${target}`);
      assert.equal(f.mutationHits, before);
    }
  }
  // An answer outside 5xx is the credential's owner refusing it, not an outage.
  for (const mode of ['status401', 'status403']) {
    const f = await fixture(); t.after(() => cleanup(f)); f.failIdentity(mode);
    const response = await f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-1/notes', { message: 'x' });
    assert.equal(response.status, 403, mode);
    assert.equal((await response.json()).error.code, 'authorization_failed', mode);
  }
});

test('an identity lookup that never answers is 502 once the request times out', async (t) => {
  const f = await fixture({ requestTimeoutMs: 200 }); t.after(() => cleanup(f)); f.failIdentity('hang');
  const response = await f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-1/notes', { message: 'x' });
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'upstream_unavailable');
  assert.equal(f.mutationHits, 0);
});

test('every refusal class names itself in the trail with the agreed word', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const target = '/v1/tickets/VC-1/notes', note = { message: 'x' };
  const classes = [
    ['credential_malformed', () => f.bearer('POST', target, note, 'Basic nope')],
    ['body_unparsable', () => f.bearerRaw('core_artem_token', 'POST', target, '{ not json')],
    ['schema_refused', () => f.bearerAs('core_artem_token', 'POST', target, {})],
    ['identity_unresolved', () => f.bearerAs('unknown_credential_token', 'POST', target, note)],
    ['identity_lookup_failed', () => { f.failIdentity('status503'); return f.bearerAs('core_artem_token', 'POST', target, note).finally(() => f.failIdentity(null)); }],
    ['identity_mismatch', () => f.bearerAs('off_device_admin_token', 'POST', target, note)],
    ['object_absent', () => f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VC-404/notes', note)],
    ['object_outside_project', () => f.bearerAs('core_artem_token', 'POST', '/v1/tickets/VIQ-1/notes', note)],
    ['object_lookup_failed', () => { f.failLookup('status503'); return f.bearerAs('core_artem_token', 'POST', target, note).finally(() => f.failLookup(null)); }]
  ];
  for (const [reason, attempt] of classes) {
    const before = f.auditOf('vc_delegation_denied').length;
    await attempt();
    const row = f.lastDenial();
    assert.equal(f.auditOf('vc_delegation_denied').length, before + 1, `${reason} left no row`);
    const detail = JSON.parse(row.detail);
    assert.deepEqual(detail, { auth_mode: 'bearer-delegation', method: 'POST', target: detail.target, reason }, reason);
    // A device is named only once the identity lookup has actually established it.
    assert.equal(row.device_id, DENIAL_DEVICE[reason], `${reason} device`);
  }
});

test('the note ceiling counts characters while the metadata ceiling counts bytes', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.exact();
  const wide = 'я'.repeat(MAX_NOTE);
  assert.equal(Buffer.byteLength(wide), MAX_NOTE * 2, 'the fixture must actually be testing a two-byte alphabet');
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: wide })).status, 201, '8000 characters pass however many bytes they weigh');
  const overByChars = f.upstreamHits;
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'я'.repeat(MAX_NOTE + 1) })).status, 403);
  assert.equal(f.upstreamHits, overByChars);
  const atCap = metadataOfBytes(2048, { cyrillic: true });
  assert.equal(Buffer.byteLength(JSON.stringify(atCap)), 2048, 'the fixture must build to an exact byte length');
  assert.ok(JSON.stringify(atCap).length < 2048, 'and that byte length must differ from its character length');
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: atCap })).status, 201);
  const overByBytes = f.upstreamHits;
  assert.equal((await f.signed(artem, 'POST', '/v1/tickets/VC-1/notes', { message: 'ok', metadata: metadataOfBytes(2049, { cyrillic: true }) })).status, 403, 'a metadata under the character cap but over the byte cap is refused');
  assert.equal(f.upstreamHits, overByBytes);
});

test('anonymous Bearer probing is capped, and the cap is spent only by identity failures', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const probe = (token, target = '/v1/tickets/VC-1/notes', value = { message: 'x' }) => f.bearerAs(token, 'POST', target, value);
  // Neither a legitimate write, nor a body refused before the lookup, nor a ticket outside VC asks the identity question.
  for (let n = 0; n < 3; n++) assert.equal((await probe('core_artem_token')).status, 201);
  for (let n = 0; n < 5; n++) assert.equal((await probe('core_artem_token', '/v1/tickets/VC-1/notes', {})).status, 403);
  for (let n = 0; n < 2; n++) assert.equal((await probe('core_artem_token', '/v1/tickets/VIQ-1/notes')).status, 403);
  for (let n = 1; n <= 10; n++) {
    const before = f.upstreamHits;
    assert.equal((await probe('unknown_credential_token')).status, 403, `probe ${n}`);
    assert.ok(f.upstreamHits > before, `probe ${n} must still have reached upstream`);
  }
  const spent = f.upstreamHits;
  const capped = await probe('unknown_credential_token');
  assert.equal(capped.status, 429, 'the eleventh identity failure in a minute is refused');
  assert.equal(f.upstreamHits, spent, 'a capped probe must not ask upstream: the point is to stop being an oracle');
  const row = f.lastDenial();
  assert.deepEqual(JSON.parse(row.detail), { auth_mode: 'bearer-delegation', method: 'POST', target: '/v1/tickets/VC-1/notes', reason: 'rate_limited' });
  assert.equal(row.device_id, null);
  // One row per bucket per window. A flood is one fact repeated, and a row for each copy of it would
  // push the real refusals out of the fifty the audit view shows (phone-auth-store.js:34).
  const rows = f.auditOf('vc_delegation_denied').length;
  for (let n = 12; n <= 31; n++) {
    assert.equal((await probe('unknown_credential_token')).status, 429, `capped probe ${n}`);
    assert.equal(f.upstreamHits, spent, `capped probe ${n} must not ask upstream`);
  }
  assert.equal(f.auditOf('vc_delegation_denied').length, rows, 'twenty more capped probes in the same window add no rows');
});
