#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';

const work = await mkdtemp(path.join(tmpdir(), 'viq-browser-pairing-'));
const storage = path.join(work, 'viqueue.sqlite');
let store = new Store(storage, { now: () => 1 });
await store.init();
const bootstrap = await store.bootstrapCoordinator({ id: 'bootstrap', name: 'Bootstrap' });
const expired = await store.createPairingCode('bootstrap', { intended_kind: 'coordinator', ttl_ms: 1000 });
await store.close();
store = new Store(storage); await store.init();
const firstCode = await store.createPairingCode('bootstrap', { actor_id: 'bootstrap', intended_kind: 'coordinator', device_id: 'browser-one', device_name: 'Browser One' });
const secondCode = await store.createPairingCode('bootstrap', { actor_id: 'bootstrap', intended_kind: 'coordinator', device_id: 'browser-two', device_name: 'Browser Two' });
await store.createProject('DOG'); await store.createProject('CAT'); await store.close();
const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js', `--port=${port}`, `--storage=${storage}`], { stdio: 'ignore' });
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 20)); }
const api = async (method, route, body) => { const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${bootstrap.credential}` }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = await response.json(); assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(result)}`); return result; };
const browser = await chromium.launch({ headless: true });
const evidence = process.env.VIQ_EVIDENCE_DIR ? path.resolve(process.env.VIQ_EVIDENCE_DIR) : await mkdtemp(path.join(tmpdir(), 'viq12-browser-evidence-')); await mkdir(evidence, { recursive: true });
const consoleErrors = [], pageErrors = []; const scenarios = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base);
  await page.getByRole('heading', { name: 'Pair this browser' }).waitFor();
  assert.equal(await page.locator('#app-shell').isHidden(), true);
  assert.equal(await page.locator('#pairing-form [name="kind"]').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'code');

  const pair = async (code, id, name) => { await page.getByLabel('One-time code').fill(code); await page.getByLabel('Device ID').fill(id); await page.getByLabel('Device name').fill(name); await page.getByRole('button', { name: 'Pair device' }).click(); };
  await pair('wrong-code', 'wrong-browser', 'Wrong Browser');
  await page.getByText(/invalid or already used/i).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('viq.deviceCredential')), null);
  await pair(expired.code, 'expired-browser', 'Expired Browser');
  await page.getByText(/expired/i).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('viq.deviceCredential')), null);

  await pair(firstCode.code, 'browser-one', 'Browser One');
  await page.locator('#app-shell').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'DOG', exact: true }).waitFor();
  assert.equal(await page.locator('#status').textContent(), '0 tickets shown');
  assert.equal(await page.locator('#pairing').isHidden(), true);
  assert.equal(await page.getByRole('button', { name: 'Disconnect this device' }).isVisible(), true);
  assert.equal(await page.evaluate(() => { const secret = localStorage.getItem('viq.deviceCredential'); return Boolean(secret) && !document.body.innerText.includes(secret) && !location.href.includes(secret); }), true);
  assert.equal(page.url(), `${base}/`);
  assert.equal(await page.locator('#actor-select').inputValue(), 'bootstrap');
  await page.getByRole('button', { name: '+ Ticket', exact: true }).click();
  await page.locator('#modal-content select[name="project"]').selectOption('DOG');
  await page.getByLabel('Ticket title').fill('Browser-paired coordinator ticket');
  await page.locator('#modal-content select[name="assignment"]').selectOption('Human');
  await page.locator('#modal-content').getByRole('button', { name: 'Create ticket' }).click();
  await page.getByText('1 tickets shown').waitFor();
  await api('POST', '/v1/tickets', { project: 'DOG', title: 'Stress title that wraps without truncation — extraordinarily long coordinator-owned human movement verification at desktop and narrow phone widths', description: 'stress', assignment: 'Human' });
  await api('POST', '/v1/tickets', { project: 'DOG', title: 'Agent factual provenance fixture', assignment: 'Agent' });
  await api('POST', '/v1/tickets', { project: 'CAT', title: 'Other project agent fixture', assignment: 'Agent' });
  await page.getByRole('button', { name: 'Refresh' }).click(); await page.getByText('4 tickets shown').waitFor();

  const order = async () => page.locator('[data-surface="Open"] .ticket-card').evaluateAll((cards) => cards.map((card) => card.dataset.id));
  await page.locator('.ticket-card[data-id="DOG-2"]').focus(); await page.keyboard.press('Alt+ArrowDown'); await page.getByText(/DOG-2 moved to Open, position 4 of 4/).waitFor();
  assert.deepEqual(await order(), ['CAT-1','DOG-3','DOG-1','DOG-2']); assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), 'DOG-2'); scenarios.keyboardReorder = true;
  const beforeCancel = await order(); await page.locator('.ticket-card[data-id="DOG-1"]').focus(); await page.locator('.ticket-card[data-id="DOG-1"]').dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) }); await page.keyboard.press('Escape');
  await page.getByText(/Move cancelled.*DOG-1 remains in Open/).waitFor(); assert.deepEqual(await order(), beforeCancel); assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), 'DOG-1'); scenarios.cancellation = true;
  await page.locator('.ticket-card[data-id="DOG-1"]').dragTo(page.locator('[data-surface="Waiting"] .card-stack')); await page.getByText(/DOG-1 moved to Waiting, position 1 of 1/).waitFor();
  assert.equal(await page.locator('[data-surface="Waiting"] .ticket-card[data-id="DOG-1"]').count(), 1); assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), 'DOG-1'); scenarios.dragMovement = true;

  await page.getByRole('button', { name: 'CAT', exact: true }).click(); await page.getByRole('button', { name: 'Human', exact: true }).click();
  const activityHeadings = await page.locator('.activity-list li strong').allTextContents();
  assert.equal(activityHeadings.some((heading) => heading === 'System · device paired'), true);
  assert.equal(activityHeadings.some((heading) => heading.startsWith('DOG-')), true);
  assert.equal(activityHeadings.every((heading) => heading.startsWith('DOG-') || heading.startsWith('System ·')), true);
  assert.equal(await page.locator('.activity-list').innerText().then((text) => text.includes('arbitrary') || text.includes('Stress title')), false); scenarios.activityBothFilters = true;
  await page.getByRole('button', { name: 'CAT', exact: true }).click(); await page.getByRole('button', { name: 'Human', exact: true }).click();
  await page.screenshot({ path: path.join(evidence, 'desktop-1280x900.png') });

  await page.getByRole('button', { name: 'Disconnect this device' }).click();
  await page.getByText('This browser is disconnected. The server-side device was not revoked.').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('viq.deviceCredential')), null);
  assert.equal((await api('GET', '/v1/devices')).devices.find((device) => device.id === 'browser-one').status, 'active');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await pair(secondCode.code, 'browser-two', 'Browser Two');
  await page.getByText('4 tickets shown').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: path.join(evidence, 'phone-390x844.png') });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.equal(await page.getByRole('tab').count(), 5); await page.screenshot({ path: path.join(evidence, 'phone-320x800.png') });
  await page.getByRole('tab', { name: /Open/ }).click();
  await page.locator('.ticket-card[data-id="DOG-2"]').click();
  await page.locator('#modal[open]').waitFor(); assert.equal(await page.locator('#modal[open]').count(), 1);
  await page.keyboard.press('Escape'); await page.locator('#modal').waitFor({ state: 'hidden' }); assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), 'DOG-2'); scenarios.modalFocusRestored = true;
  await api('POST', '/v1/devices/browser-two/revoke', {});
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('This device pairing is no longer valid. Pair this browser again.').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('viq.deviceCredential')), null);
  assert.equal(await page.getByRole('heading', { name: 'Pair this browser' }).isVisible(), true);
  scenarios.pairingAndRevocation = true; scenarios.noHorizontalOverflow = true; scenarios.liveRegionAnnouncements = true;
  await writeFile(path.join(evidence, 'browser-status.json'), `${JSON.stringify({ passed: Object.values(scenarios).every(Boolean), scenarios, viewports: [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 800 }], consoleErrors, pageErrors }, null, 2)}\n`);
  assert.deepEqual(consoleErrors, []); assert.deepEqual(pageErrors, []);
  console.log(`BROWSER_PAIRING_E2E_OK evidence=${evidence}`);
} finally { await browser.close(); server.kill(); await rm(work, { recursive: true, force: true }); }
