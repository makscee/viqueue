import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-coordinator-board-read-'));
  const file = path.join(dir, 'data.sqlite');
  const store = new Store(file);
  await store.init();
  const admin = await store.bootstrapCoordinator({ id: 'admin', name: 'Admin' });
  await store.createActor({ id: 'reader', name: 'Board reader', kind: 'human', admin: false }, 'admin');
  await store.createActor({ id: 'inactive', name: 'Inactive reader', kind: 'human', admin: false }, 'admin');
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' }, 'admin');
  const pair = async (actor_id, intended_kind, device_id) => {
    const issued = await store.createPairingCode('admin', { actor_id, intended_kind, device_id, device_name: device_id });
    return store.pairDevice({ code: issued.code });
  };
  const reader = await pair('reader', 'coordinator', 'reader-browser');
  const inactive = await pair('inactive', 'coordinator', 'inactive-browser');
  await store.deactivateActor('inactive');
  const worker = await pair('worker', 'worker', 'worker-device');
  const revoked = await pair('reader', 'coordinator', 'revoked-browser');
  await store.revokeDevice('revoked-browser', 'admin');
  await store.createProject('VC');
  await store.createTicket({ project: 'VC', title: 'Visible ticket', actor: 'admin' });
  await store.close();
  const app = await createApp({ storage: file });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (token, method, route, body) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  };
  return { app, base, request, tokens: { admin: admin.credential, reader: reader.credential, inactive: inactive.credential, worker: worker.credential, revoked: revoked.credential } };
}

test('active non-admin coordinator completes the production board read journey', async (t) => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const route of ['/v1/devices/me', '/v1/projects', '/v1/board', '/v1/events?after=0', '/v1/questions', '/v1/projects/VC/tickets', '/v1/tickets/VC-1', '/v1/tickets/VC-1/questions', '/v1/tickets/VC-1/blocks', '/v1/tickets/VC-1/history?limit=25']) {
    const result = await f.request(f.tokens.reader, 'GET', route);
    assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.body)}`);
  }
  assert.deepEqual((await f.request(f.tokens.reader, 'GET', '/v1/board')).body.tickets.map(({ id }) => id), ['VC-1']);
});

test('board reads fail closed for anonymous, worker, inactive actor, and revoked device', async (t) => {
  const f = await fixture(); t.after(() => f.app.close());
  for (const [name, token] of [['anonymous', null], ['worker', f.tokens.worker], ['inactive', f.tokens.inactive], ['revoked', f.tokens.revoked]]) {
    const result = await f.request(token, 'GET', '/v1/board');
    assert.notEqual(result.status, 200, name);
  }
});

test('non-admin coordinator cannot perform admin-only mutations', async (t) => {
  const f = await fixture(); t.after(() => f.app.close());
  const operations = [
    ['POST', '/v1/pairing-codes', { actor_id: 'worker', intended_kind: 'worker', device_id: 'new-worker', device_name: 'New worker' }],
    ['POST', '/v1/machines/pairing-codes', { role: 'Agent', name: 'New worker' }],
    ['POST', '/v1/devices/worker-device/revoke', {}],
    ['POST', '/v1/machines/worker-device/revoke', {}],
    ['POST', '/v1/projects', { key: 'NO' }],
    ['POST', '/v1/tickets', { project: 'VC', title: 'No' }],
    ['POST', '/v1/tickets/VC-1/state', { state: 'Done' }],
    ['POST', '/v1/tickets/VC-1/board-position', { state: 'Open', index: 0, visible_ids: [] }],
    ['POST', '/v1/tickets/VC-1/blocks/missing/resolve', {}],
    ['POST', '/v1/tickets/VC-1/human-questions', { text: 'No' }],
    ['POST', '/v1/tickets/VC-1/questions/missing/answer', { answer: 'No' }],
    ['POST', '/v1/tickets/VC-1/accept', {}],
    ['POST', '/v1/tickets/VC-1/reopen', {}]
  ];
  for (const [method, route, body] of operations) {
    const result = await f.request(f.tokens.reader, method, route, body);
    assert.equal(result.status, 403, `${method} ${route}: ${JSON.stringify(result.body)}`);
  }
});

test('production browser UI presents the non-admin coordinator read-only board journey', async (t) => {
  const { chromium } = await import('playwright');
  const f = await fixture(); t.after(() => f.app.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript((credential) => localStorage.setItem('viq.deviceCredential', credential), f.tokens.reader);
  await page.goto(f.base);
  await page.getByText('1 tickets shown. This paired coordinator can read the board; administrative operations remain restricted.').waitFor();
  await page.getByText('VC-1', { exact: true }).waitFor();
  assert.equal(await page.locator('#pairing').isHidden(), true);
  for (const id of ['#open-machines', '#open-project-create', '#open-ticket-create']) assert.equal(await page.locator(id).isHidden(), true, id);
  await page.getByText('VC-1', { exact: true }).click();
  await page.getByText('Complete history').waitFor();
  for (const selector of ['.detail-edit-form', '.manual-event-composer', '.resolve-block', '.danger-zone', '.inline-answer']) assert.equal(await page.locator(selector).count(), 0, selector);
  const app = await readFile('web/app.js', 'utf8');
  assert.doesNotMatch(app, /board requires an admin actor/i);
});
