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
const replies = {
  '/v1/projects': { projects: [{ key: 'VC' }] },
  '/v1/board': { tickets: Array.from({ length: 5 }, (_, i) => ({ id: `VC-${i + 1}`, project: 'VC', title: `Ticket ${i + 1}`, description: '', assignment: 'Human', state: 'Open', open_questions: 0 })) },
  '/v1/events?after=0': { events: [] }, '/v1/questions': { questions: [] },
  '/v1/tickets/VC-1': { ticket: { id: 'VC-1', project: 'VC', title: 'Ticket 1', description: '', assignment: 'Human', state: 'Open' } },
  '/v1/tickets/VC-1/questions': { questions: [] }, '/v1/tickets/VC-1/blocks': { blocks: [] },
  '/v1/tickets/VC-1/history?limit=25': { events: [{ cursor: 1, type: 'ticket_created', created_at: 1, actor: 'admin' }], has_more: false }
};

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viq-read-broker-')); let mutationHits = 0; const hits = [], upstreamRequests = []; let projectOverride = null, ticketIdOverride = null, lookupFails = false;
  const bearerIdentities = new Map([
    ['core_artem_token', { device: { id: 'artems-macbook-pro', kind: 'coordinator', status: 'active', admin: false }, actor: { id: 'artem', active: true, admin: false } }],
    ['wrong_actor_token', { device: { id: 'artems-macbook-pro', kind: 'coordinator', status: 'active', admin: false }, actor: { id: 'other', active: true, admin: false } }],
    ['wrong_device_token', { device: { id: 'other-device', kind: 'coordinator', status: 'active', admin: false }, actor: { id: 'artem', active: true, admin: false } }],
    ['wrong_kind_token', { device: { id: 'artems-macbook-pro', kind: 'worker', status: 'active', admin: false }, actor: { id: 'artem', active: true, admin: false } }],
    ['inactive_device_token', { device: { id: 'artems-macbook-pro', kind: 'coordinator', status: 'revoked', admin: false }, actor: { id: 'artem', active: true, admin: false } }],
    ['inactive_actor_token', { device: { id: 'artems-macbook-pro', kind: 'coordinator', status: 'active', admin: false }, actor: { id: 'artem', active: false, admin: false } }],
    ['admin_token_value', { device: { id: 'artems-macbook-pro', kind: 'coordinator', status: 'active', admin: true }, actor: { id: 'artem', active: true, admin: true } }]
  ]);
  const upstream = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const requestBody = Buffer.concat(chunks).toString(); hits.push(req.url); upstreamRequests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, body: requestBody }); if (req.method !== 'GET') mutationHits++; res.setHeader('content-type', 'application/json'); if (req.url === '/v1/devices/me' && req.headers.authorization !== 'Bearer test_upstream_admin_credential') { const identity = bearerIdentities.get(req.headers.authorization?.slice(7)); if (!identity) { res.statusCode = 401; return res.end(JSON.stringify({ error: { code: 'device_unauthorized' } })); } return res.end(JSON.stringify(identity)); } const ticketMatch = req.url.match(/^\/v1\/tickets\/(VC-[1-5])$/); if (ticketMatch && lookupFails) { res.statusCode = 503; return res.end(JSON.stringify({ error: { code: 'unavailable' } })); } const value = ticketMatch ? { ticket: { id: ticketIdOverride ?? ticketMatch[1], project: projectOverride ?? 'VC', state: 'Open' } } : req.method === 'POST' && req.url.endsWith('/state') ? { ticket: { id: req.url.split('/')[3], project: 'VC', state: JSON.parse(requestBody).state } } : req.url === '/v1/devices/me' ? { actor: { id: 'upstream-admin', admin: true } } : (replies[req.url] ?? { ok: true }); res.end(JSON.stringify(value)); });
  await listen(upstream); const origin = 'https://phone.test';
  const gateway = await createPhoneGateway({ authDb: path.join(dir, 'auth.sqlite'), origin, upstream: `http://127.0.0.1:${upstream.address().port}`, upstreamAuthorization: 'test_upstream_admin_credential', testMode: true }); await listen(gateway);
  const pair = ({ actorId, actorName, admin, kind = 'coordinator', actorActive = true, deviceId }) => {
    const device = deviceId ?? `device_${crypto.randomUUID().replaceAll('-', '')}`; const intent = gateway.authStore.createPair({ deviceId: device, actorId, actorName, admin, kind, actorActive, label: `${actorName} browser` });
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); const jwk = publicKey.export({ format: 'jwk' });
    const verifier = sha(Buffer.concat([Buffer.from('viq-phone-pair-verifier-v1\0'), Buffer.from(intent.code.split('.')[1])]));
    const proof = createHmac('sha256', verifier).update(pairRecord(origin, intent.intentId, jwk.x, jwk.y)).digest();
    const paired = gateway.authStore.consumePair({ intent_id: intent.intentId, public_key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, proof: b64url(proof) });
    return { device, privateKey, privateJwk: privateKey.export({ format: 'jwk' }), epoch: paired.epoch };
  };
  const signed = async (identity, method, target, value) => { const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)); const challenge = gateway.authStore.challenge({ device_id: identity.device, method, target, body_hash: b64url(sha(body)) }); const record = proofRecord(origin, challenge.id, Buffer.from(challenge.nonce, 'base64url'), identity.device, challenge.epoch, method, target, sha(body)); const signature = sign(null, record, { key: identity.privateKey, dsaEncoding: 'ieee-p1363' }); return fetch(`http://127.0.0.1:${gateway.address().port}${target}`, { method, headers: { 'content-type': 'application/json', 'x-viq-device': identity.device, 'x-viq-challenge': challenge.id, 'x-viq-signature': b64url(signature), authorization: 'Bearer caller-must-not-pass', cookie: 'caller=must-not-pass' }, body: body.length ? body : undefined }); };
  const bearer = (token, target = '/v1/tickets/VC-1/state', value = { state: 'Done' }, authorization = token === undefined ? undefined : `Bearer ${token}`) => fetch(`http://127.0.0.1:${gateway.address().port}${target}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: JSON.stringify(value) });
  return { dir, upstream, gateway, base: `http://127.0.0.1:${gateway.address().port}`, pair, signed, bearer, hits, upstreamRequests, setProject(value) { projectOverride = value; }, setTicketId(value) { ticketIdOverride = value; }, failLookup(value) { lookupFails = value; }, get mutationHits() { return mutationHits; } };
}
async function cleanup(f) { await close(f.gateway); await close(f.upstream); await rm(f.dir, { recursive: true, force: true }); }

const mutations = [
  ['POST', '/v1/projects', { key: 'NO' }], ['POST', '/v1/tickets', {}], ['PATCH', '/v1/tickets/VC-1', {}], ['POST', '/v1/tickets/VC-1/delete', {}], ['POST', '/v1/tickets/VC-1/notes', {}], ['POST', '/v1/tickets/VC-1/events', {}], ['POST', '/v1/tickets/VC-1/state', {}], ['POST', '/v1/tickets/VC-1/board-position', {}], ['POST', '/v1/tickets/VC-1/human-questions', {}], ['POST', '/v1/tickets/VC-1/questions/q/answer', {}], ['POST', '/v1/tickets/VC-1/accept', {}], ['POST', '/v1/tickets/VC-1/blocks/b/resolve', {}], ['POST', '/v1/devices/d/revoke', {}], ['POST', '/v1/machines/d/revoke', {}], ['POST', '/v1/machines/pairing-codes', {}], ['POST', '/v1/pairing-codes', {}], ['POST', '/v1/actors/a/roles', {}]
];

test('public gateway brokers a truthful read-only coordinator capability', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const reader = f.pair({ actorId: 'artem', actorName: 'Artem', admin: false });
  const me = await (await f.signed(reader, 'GET', '/v1/devices/me')).json(); assert.equal(me.actor.id, 'artem'); assert.equal(me.actor.admin, false); assert.equal(me.device.admin, false); assert.equal(f.hits.includes('/v1/devices/me'), false);
  for (const route of ['/v1/projects', '/v1/board', '/v1/tickets/VC-1', '/v1/tickets/VC-1/history?limit=25']) assert.equal((await f.signed(reader, 'GET', route)).status, 200, route);
  const before = f.hits.length; for (const [method, route, body] of mutations) assert.equal((await f.signed(reader, method, route, body)).status, 403, `${method} ${route}`); assert.equal(f.hits.length, before); assert.equal(f.mutationHits, 0);
});

test('exact Artem browser receives only the frozen VC state transition capability', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const artem = f.pair({ actorId: 'artem', actorName: 'Artem', admin: false, deviceId: 'artems-macbook-pro' });
  for (let n = 1; n <= 5; n++) for (const state of ['Open', 'Working', 'Waiting', 'Done']) { const response = await f.signed(artem, 'POST', `/v1/tickets/VC-${n}/state`, { state }); assert.equal(response.status, 200, `VC-${n} ${state}`); }
  assert.equal(f.mutationHits, 20); for (const request of f.upstreamRequests.filter(({ method }) => method === 'POST')) { assert.equal(request.authorization, 'Bearer test_upstream_admin_credential'); assert.equal(request.cookie, undefined); assert.deepEqual(JSON.parse(request.body), { state: JSON.parse(request.body).state }); }
  const audit = f.gateway.authStore.status().audit.filter(({ action }) => action === 'vc_state_changed'); assert.ok(audit.length > 0); assert.deepEqual(JSON.parse(audit[0].detail), { actor_id: 'artem', ticket_id: 'VC-5', state: 'Done', upstream_actor: 'maks', attribution: 'gateway-delegated via shared admin credential' });
});

test('exact core Artem Bearer delegates only the frozen VC state mutation', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  for (let n = 1; n <= 5; n++) for (const state of ['Open', 'Working', 'Waiting', 'Done']) assert.equal((await f.bearer('core_artem_token', `/v1/tickets/VC-${n}/state`, { state })).status, 200, `VC-${n} ${state}`);
  assert.equal(f.mutationHits, 20);
  const bearerRequests = f.upstreamRequests.filter(({ authorization }) => authorization === 'Bearer core_artem_token');
  assert.equal(bearerRequests.length, 20); assert.ok(bearerRequests.every(({ method, url }) => method === 'GET' && url === '/v1/devices/me'));
  const audit = f.gateway.authStore.status().audit.filter(({ action }) => action === 'vc_state_changed');
  assert.deepEqual(JSON.parse(audit[0].detail), { auth_mode: 'bearer-delegation', actor_id: 'artem', device_id: 'artems-macbook-pro', ticket_id: 'VC-5', state: 'Done', upstream_actor: 'maks' });
});

test('Bearer VC delegation fails closed before admin mutation for every denied class', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f));
  const denied = [
    () => f.bearer(undefined), () => f.bearer('x', undefined, undefined, 'Basic nope'), () => f.bearer('invalid_token_value'),
    ...['wrong_actor_token', 'wrong_device_token', 'wrong_kind_token', 'inactive_device_token', 'inactive_actor_token', 'admin_token_value'].map((token) => () => f.bearer(token)),
    () => f.bearer('core_artem_token', '/v1/tickets/VC-1/state?x=1'), () => f.bearer('core_artem_token', '/v1/tickets/VC-6/state'),
    () => f.bearer('core_artem_token', '/v1/tickets/VC-1/state', { state: 'Done', extra: true }), () => f.bearer('core_artem_token', '/v1/tickets/VC-1/state', {}), () => f.bearer('core_artem_token', '/v1/tickets/VC-1/state', { state: 'Review' })
  ];
  for (const attempt of denied) { const before = f.mutationHits; assert.notEqual((await attempt()).status, 200); assert.equal(f.mutationHits, before); }
  f.setProject('OTHER'); let before = f.mutationHits; assert.equal((await f.bearer('core_artem_token')).status, 403); assert.equal(f.mutationHits, before);
  f.setProject(null); f.setTicketId('VC-2'); before = f.mutationHits; assert.equal((await f.bearer('core_artem_token')).status, 403); assert.equal(f.mutationHits, before);
  f.setTicketId(null); f.failLookup(true); before = f.mutationHits; assert.equal((await f.bearer('core_artem_token')).status, 403); assert.equal(f.mutationHits, before);
  assert.ok(f.upstreamRequests.filter(({ authorization }) => authorization === 'Bearer core_artem_token').every(({ url }) => url === '/v1/devices/me'));
});

test('VC state capability fails closed for identity, object, schema, and project mismatch', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const exact = f.pair({ actorId: 'artem', actorName: 'Artem', admin: false, deviceId: 'artems-macbook-pro' });
  const identities = [f.pair({ actorId: 'other', actorName: 'Other', admin: false }), f.pair({ actorId: 'artem', actorName: 'Artem', admin: false }), f.pair({ actorId: 'artem', actorName: 'Artem', admin: false, kind: 'worker' }), f.pair({ actorId: 'artem', actorName: 'Artem', admin: false, actorActive: false })];
  for (const identity of identities) assert.equal((await f.signed(identity, 'POST', '/v1/tickets/VC-1/state', { state: 'Done' })).status, 403);
  const badTargets = ['/v1/tickets/VC-6/state', '/v1/tickets/VV-1/state', '/v1/tickets/VIQ-1/state', '/v1/tickets/LIVE1/state', '/v1/tickets/PRIVATEA1/state', '/v1/tickets/VC%2D1/state', '/v1/tickets/VC-1%2Fnotes/state', '/v1/tickets/VC-01/state', '/v1/tickets/VC-1/state?next=x'];
  for (const target of badTargets) assert.notEqual((await f.signed(exact, 'POST', target, { state: 'Done' })).status, 200, target);
  for (const value of [{ state: 'Review' }, { state: 'Done', actor: 'artem' }, {}, null, 'Done']) assert.equal((await f.signed(exact, 'POST', '/v1/tickets/VC-1/state', value)).status, 403);
  const before = f.mutationHits; f.setProject('OTHER'); assert.equal((await f.signed(exact, 'POST', '/v1/tickets/VC-1/state', { state: 'Done' })).status, 403); assert.equal(f.mutationHits, before);
});

test('admin path remains proxied while worker, inactive actor, revoked device, anonymous and invalid proof remain denied', async (t) => {
  const f = await fixture(); t.after(() => cleanup(f)); const admin = f.pair({ actorId: 'admin', actorName: 'Admin', admin: true }); assert.equal((await f.signed(admin, 'POST', '/v1/projects', { key: 'OK' })).status, 200); assert.equal(f.mutationHits, 1);
  for (const identity of [f.pair({ actorId: 'worker', actorName: 'Worker', admin: false, kind: 'worker' }), f.pair({ actorId: 'inactive', actorName: 'Inactive', admin: false, actorActive: false })]) assert.equal((await f.signed(identity, 'GET', '/v1/board')).status, 403);
  const revoked = f.pair({ actorId: 'revoked', actorName: 'Revoked', admin: false }); f.gateway.authStore.revoke(revoked.device); await assert.rejects(() => f.signed(revoked, 'GET', '/v1/board')); assert.equal((await fetch(`${f.base}/v1/board`)).status, 403);
  const reader = f.pair({ actorId: 'reader', actorName: 'Reader', admin: false }); const response = await fetch(`${f.base}/v1/board`, { headers: { 'x-viq-device': reader.device, 'x-viq-challenge': 'invalid_invalid_0000', 'x-viq-signature': 'x'.repeat(86) } }); assert.equal(response.status, 403);
});

test('phone browser renders exact VC state controls without generic administration', async (t) => {
  const { chromium } = await import('playwright'); const f = await fixture(); t.after(() => cleanup(f)); const reader = f.pair({ actorId: 'artem', actorName: 'Artem', admin: false, deviceId: 'artems-macbook-pro' });
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('**/v1/**', async (route) => { const request = route.request(), url = new URL(request.url()), data = request.postData(); const response = await f.signed(reader, request.method(), url.pathname + url.search, data === null ? undefined : JSON.parse(data)); await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }); });
  await page.goto(f.base); await page.evaluate(async () => { globalThis.__viqPhoneAuthorized = true; document.querySelector('#phone-auth').hidden = true; document.querySelector('#phone-app').hidden = false; await import('/app.js'); });
  await page.waitForTimeout(1000); assert.equal(await page.locator('#status').textContent(), '5 tickets shown. State controls are limited to VC-1 through VC-5.'); for (let i = 1; i <= 5; i++) await page.getByText(`VC-${i}`, { exact: true }).waitFor(); assert.equal(await page.locator('.vc-state-control').count(), 5); await page.locator('.vc-state-control').first().selectOption('Done'); await page.getByText('VC-1 moved to Done.').waitFor(); for (const id of ['#open-machines', '#open-project-create', '#open-ticket-create']) assert.equal(await page.locator(id).isHidden(), true); await page.getByText('VC-1', { exact: true }).click(); await page.getByText('Complete history').waitFor(); for (const selector of ['.detail-edit-form', '.manual-event-composer', '.resolve-block', '.danger-zone', '.inline-answer']) assert.equal(await page.locator(selector).count(), 0); assert.equal(f.mutationHits, 1);
});
