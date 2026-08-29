import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

async function fixture() {
  let tick = 1_700_000_000_000;
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-exact-repair-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file, { now: () => ++tick });
  await store.init(); await store.createProject('REP');
  const admin = await store.bootstrapCoordinator({ id: 'admin', name: 'Admin' });
  await store.createActor({ id: 'artem', name: 'Artem', kind: 'agent' }, 'admin');
  const issue = (options = {}) => store.createPairingCode('admin', { actor_id: 'artem', intended_kind: 'worker', device_id: 'artems-macbook-pro', device_name: "Artem's MacBook Pro", ttl_ms: 900000, ...options });
  return { dir, file, store, admin, issue, close: async () => { await store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('store exact bound re-pair rotates credential and strips device authority atomically', async () => {
  const f = await fixture();
  try {
    const original = await f.store.pairDevice({ code: (await f.issue()).code });
    await assert.rejects(f.store.pairDevice({ code: (await f.issue()).code }), (error) => error.code === 'device_exists');
    const role = await f.store.createRole({ id: 'operator', name: 'Operator' });
    await f.store.grantDeviceRole(original.device.id, role.id, 'admin');
    const session = await f.store.openWorkerSession(original.device.id);
    await f.store.revokeDevice(original.device.id, 'admin');

    for (const options of [
      { actor_id: undefined },
      { actor_id: 'admin' },
      { intended_kind: 'coordinator' },
      { device_name: 'Substituted name' }
    ]) {
      const issued = await f.issue(options);
      await assert.rejects(f.store.pairDevice({ code: issued.code }), (error) => error.code === 'pairing_device_mismatch');
      await assert.rejects(f.store.pairDevice({ code: issued.code }), (error) => error.code === 'pairing_device_mismatch');
      assert.equal((await f.store.getDevice(original.device.id)).status, 'revoked');
    }

    const before = await f.store.getDevice(original.device.id);
    const replacementCode = await f.issue();
    const replacement = await f.store.pairDevice({ code: replacementCode.code });
    assert.equal(replacement.device.id, original.device.id);
    assert.equal(replacement.device.status, 'active');
    assert.equal(replacement.device.revoked_at, null);
    assert.ok(replacement.device.created_at > before.created_at);
    await assert.rejects(f.store.authenticateDevice(original.credential), (error) => error.code === 'device_unauthorized');
    assert.equal((await f.store.authenticateDevice(replacement.credential)).id, original.device.id);
    await assert.rejects(f.store.claimNext({ project: 'REP', device: original.device.id, session_capability: session.session_capability }), (error) => error.code === 'session_unauthorized');
    assert.deepEqual((await f.store.listDeviceRoles(original.device.id)).roles, []);
    await assert.rejects(f.store.pairDevice({ code: replacementCode.code }), (error) => error.code === 'pairing_code_used_or_invalid');
  } finally { await f.close(); }
});

test('HTTP revoke then exact bound re-pair denies old credential and accepts replacement', async (t) => {
  const f = await fixture();
  const original = await f.store.pairDevice({ code: (await f.issue()).code });
  await f.store.close();
  const app = await createApp({ storage: f.file });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => app.close(resolve)); await rm(f.dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (token, route, body) => { const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await call(f.admin.credential, `/v1/devices/${original.device.id}/revoke`)).status, 200);
  const issued = await call(f.admin.credential, '/v1/pairing-codes', { actor_id: 'artem', intended_kind: 'worker', device_id: original.device.id, device_name: original.device.name, ttl_ms: 900000 });
  assert.equal(issued.status, 201);
  const paired = await call(null, '/v1/devices/pair', { code: issued.body.code });
  assert.equal(paired.status, 201);
  assert.equal((await fetch(base + '/v1/devices/me', { headers: { authorization: `Bearer ${original.credential}` } })).status, 401);
  assert.equal((await fetch(base + '/v1/devices/me', { headers: { authorization: `Bearer ${paired.body.credential}` } })).status, 200);
  assert.equal((await call(null, '/v1/devices/pair', { code: issued.body.code })).status, 409);
});
