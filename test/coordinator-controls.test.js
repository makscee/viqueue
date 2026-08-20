import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

test('bounded coordinator controls remain coordinator-only at the API boundary', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-coordinator-controls-')); const db = path.join(dir, 'db.sqlite');
  let store = new Store(db); await store.init(); const coordinator = await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' }); const code = await store.createPairingCode('coord', { intended_kind: 'worker' }); const worker = await store.pairDevice({ code: code.code, id: 'worker', name: 'Worker' }); await store.close();
  const app = await createApp({ storage: db }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (credential, method, route, body = {}) => fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const [method, route, body] of [
    ['POST', '/v1/pairing-codes', { intended_kind: 'worker' }], ['POST', '/v1/roles', { id: 'flat', name: 'Flat' }],
    ['PUT', '/v1/devices/worker/roles/flat', {}], ['DELETE', '/v1/devices/worker/roles/flat', {}],
    ['POST', '/v1/tickets/NO-1/questions/q_missing/answer', { answer: 'no' }], ['POST', '/v1/tickets/NO-1/blocks/b_missing/resolve', {}]
  ]) { const response = await call(worker.credential, method, route, body); assert.equal(response.status, 403, `${method} ${route}`); assert.match((await response.json()).error.code, /coordinator_required|admin_required/); }
  assert.equal((await call(coordinator.credential, 'POST', '/v1/pairing-codes', { intended_kind: 'worker' })).status, 201);
});

test('browser exposes only the named pairing, flat-role, membership, answer, and block controls', async () => {
  const [html, app] = await Promise.all([readFile(new URL('../web/index.html', import.meta.url), 'utf8'), readFile(new URL('../web/app.js', import.meta.url), 'utf8')]);
  assert.match(html, />Admin</); assert.match(app, /intended_kind/); assert.match(app, /role-create-form/); assert.match(app, /role-membership-form/); assert.ok(app.includes('questions/${question.id}/answer')); assert.ok(app.includes('blocks/${encodeURIComponent(block.id)}/resolve'));
  assert.doesNotMatch(`${html}\n${app}`, /OAuth|SSO|permission bundle|role hierarchy|authority graph/i);
});
