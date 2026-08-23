import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq16-machines-'));
  const storage = path.join(dir, 'data.sqlite');
  const store = new Store(storage); await store.init();
  const coordinator = await store.bootstrapCoordinator({ id: 'owner', name: 'Owner machine' }); await store.close();
  const app = await createApp({ storage }); await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, route, body, credential = coordinator.credential) => { const response = await fetch(`${base}${route}`, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { response, body: await response.json() }; };
  return { base, call, coordinator };
}

test('Machines is the only routine provenance administration surface', async (t) => {
  const { base } = await fixture(t); const html = await (await fetch(base)).text(); const js = await (await fetch(`${base}/app.js`)).text();
  assert.match(html, />Machines</); assert.match(js, /openMachines/); assert.match(js, /Human.*Agent/s);
  assert.doesNotMatch(`${html}\n${js}`, />Admin<|\+ Project|Create actor|Create assignment role|role-membership|actor-create|machine filter/i);
  assert.doesNotMatch(js, /\/v1\/(actors|roles)/); assert.match(js, /\/v1\/machines/);
});

test('Machines lists active server-derived provenance, pairs once, and revokes authentication', async (t) => {
  const { call } = await fixture(t);
  const issued = await call('POST', '/v1/machines/pairing-codes', { role: 'Agent', name: 'Disposable runner' }); assert.equal(issued.response.status, 201); assert.equal(issued.body.role, 'Agent');
  const paired = await call('POST', '/v1/devices/pair', { code: issued.body.code }, null); assert.equal(paired.response.status, 201); assert.equal(paired.body.device.name, 'Disposable runner');
  const machines = await call('GET', '/v1/machines'); const item = machines.body.machines.find(({ id }) => id === issued.body.id); assert.deepEqual(item, { id: issued.body.id, name: 'Disposable runner', role: 'Agent' });
  assert.equal((await call('POST', '/v1/machines/pairing-codes', { role: 'Machine', name: 'Spoof' })).response.status, 400);
  assert.equal((await call('POST', `/v1/machines/${encodeURIComponent(item.id)}/revoke`, {})).response.status, 200);
  assert.equal((await call('GET', '/v1/devices/me', undefined, paired.body.credential)).response.status, 401);
  assert.equal((await call('GET', '/v1/machines')).body.machines.some(({ id }) => id === item.id), false);
});

test('legacy actor role and membership product routes are absent', async (t) => {
  const { call } = await fixture(t);
  for (const [method, route] of [['GET','/v1/actors'],['POST','/v1/actors'],['GET','/v1/roles'],['POST','/v1/roles'],['PUT','/v1/devices/owner/roles/example'],['DELETE','/v1/devices/owner/roles/example']]) assert.equal((await call(method, route, method === 'GET' ? undefined : {})).response.status, 404, `${method} ${route}`);
});
