#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, chown, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';

const work = await mkdtemp(path.join(tmpdir(), 'viq-coordinator-worker-'));
const install = await mkdtemp('/var/tmp/viq-worker-browser-');
const release = process.env.VIQ_WORKER_RELEASE ? path.resolve(process.env.VIQ_WORKER_RELEASE) : path.join(install, 'current');
const helper = path.join(install, 'real-worker-helper.mjs');
const stateHome = path.join(install, 'state');
if (!process.env.VIQ_WORKER_RELEASE) {
  await mkdir(path.join(release, 'extensions'), { recursive: true });
  await cp('extensions/viq-worker', path.join(release, 'extensions/viq-worker'), { recursive: true });
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await writeFile(path.join(release, 'package.json'), `${JSON.stringify({ name: pkg.name, pi: pkg.pi })}\n`);
}
await cp('test/fixtures/real-worker-helper.mjs', helper);
await mkdir(stateHome, { mode: 0o700 });
async function giveToWorker(target) { const entries = await import('node:fs/promises').then((fs) => fs.readdir(target, { withFileTypes: true })); await chown(target, 994, 986); await chmod(target, entries.some((e) => e.isDirectory()) ? 0o755 : 0o700); for (const entry of entries) if (entry.isDirectory()) await giveToWorker(path.join(target, entry.name)); }
await giveToWorker(install); await chmod(stateHome, 0o700);
const storage = path.join(work, 'viqueue.sqlite');
let store = new Store(storage); await store.init();
const bootstrap = await store.bootstrapCoordinator({ id: 'bootstrap', name: 'Bootstrap' });
const browserCode = await store.createPairingCode('bootstrap', { intended_kind: 'coordinator' });
await store.close();
const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js', `--port=${port}`, `--storage=${storage}`], { stdio: 'ignore' });
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 20)); }
let worker;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleMessages = []; page.on('console', (message) => consoleMessages.push(message.text()));
  await page.goto(base);
  await page.getByLabel('One-time code').fill(browserCode.code); await page.getByLabel('Device ID').fill('browser-coordinator'); await page.getByLabel('Device name').fill('Browser Coordinator'); await page.getByRole('button', { name: 'Pair device' }).click();
  await page.getByText('0 tickets shown').waitFor(); await page.getByLabel('Your name').selectOption('browser-coordinator');
  await page.getByRole('button', { name: 'Pairing and roles' }).click();
  const pairing = page.locator('.pairing-code-form'); await pairing.getByLabel('Device kind').selectOption('worker'); await pairing.getByRole('button', { name: 'Issue code' }).click();
  const workerCode = await pairing.locator('.one-time-code').textContent(); assert.ok(workerCode);
  worker = spawn('runuser', ['-u', 'viq-worker', '--', process.execPath, helper, release], { env: { ...process.env, VIQ_URL: base, XDG_STATE_HOME: stateHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: worker.stdout }); const queue = []; const waiters = []; lines.on('line', (line) => { const waiter = waiters.shift(); if (waiter) waiter(line); else queue.push(line); });
  const nextLine = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve));
  worker.stdin.write(`${workerCode}\n`); assert.equal(await nextLine(), 'PAIRED');
  await pairing.getByRole('button', { name: 'Clear code' }).click();
  assert.equal(await page.evaluate((code) => document.body.innerText.includes(code) || location.href.includes(code), workerCode), false);
  const role = page.locator('.role-create-form'); await role.getByLabel('Role ID').fill('reviewer'); await role.getByLabel('Role name').fill('Reviewer'); await role.getByRole('button', { name: 'Create role' }).click();
  await page.getByText('Role created').waitFor();
  const membership = page.locator('.role-membership-form'); await membership.getByLabel('Paired device').selectOption('browser-coordinator'); await membership.getByLabel('Role').selectOption('reviewer'); await membership.getByRole('button', { name: 'Grant role' }).click();
  await page.getByText('Role granted').waitFor();
  await page.locator('.role-membership-form').getByLabel('Paired device').selectOption('real-worker'); await page.locator('.role-membership-form').getByLabel('Role').selectOption('reviewer'); await page.locator('.role-membership-form').getByRole('button', { name: 'Grant role' }).click();
  await page.getByText('Role granted').waitFor(); await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Create project' }).click(); await page.getByLabel('Project key').fill('DOG'); await page.locator('#modal-content').getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: 'Create ticket' }).click(); await page.locator('#modal-content select[name="project"]').selectOption('DOG'); await page.getByLabel('Ticket title').fill('Real lifecycle'); await page.locator('#modal-content').getByRole('button', { name: 'Create ticket' }).click();
  await page.locator('.ticket-card[data-id="DOG-1"] .ticket-open').click(); await page.getByRole('button', { name: 'Edit ticket' }).click(); await page.locator('.edit-ticket-form select[name="assignee"]').selectOption('role:reviewer'); await page.locator('.edit-ticket-form').getByRole('button', { name: 'Save ticket' }).click();
  worker.stdin.write('start\n'); assert.equal(await nextLine(), 'CLAIMED'); assert.equal(await nextLine(), 'BLOCKED');
  await page.getByRole('button', { name: 'Refresh' }).click(); await page.locator('.question-card').getByText('May I continue?').click(); await page.getByLabel('Your answer (Markdown)').fill('Continue.'); await page.getByRole('button', { name: 'Send answer' }).click();
  await page.locator('.ticket-card[data-id="DOG-1"] .ticket-open').click(); await page.getByRole('button', { name: 'Resolve block: Needs coordinator resolution' }).click();
  worker.stdin.write('resume\n'); assert.equal(await nextLine(), 'SUBMITTED');
  await page.getByRole('button', { name: 'Refresh' }).click(); await page.locator('.question-card').getByText('Review requested').click(); await page.getByRole('button', { name: 'Accept work' }).click(); await page.getByText('Work accepted').waitFor();
  await page.locator('[data-tab="done"]').evaluate((element) => element.click()); await page.locator('[data-column="done"] .ticket-card[data-id="DOG-1"]').waitFor();
  await page.getByRole('button', { name: 'Pairing and roles' }).click(); await page.locator('.role-membership-form').getByLabel('Paired device').selectOption('real-worker'); await page.locator('.role-membership-form').getByLabel('Role').selectOption('reviewer'); await page.locator('.role-membership-form').getByRole('button', { name: 'Revoke role' }).click(); await page.getByText('Role revoked').waitFor();
  assert.equal(consoleMessages.some((message) => message.includes(workerCode) || message.includes(browserCode.code) || message.includes(bootstrap.credential)), false);
  assert.equal(await page.evaluate(() => { const secret = localStorage.getItem('viq.deviceCredential'); return Boolean(secret) && !document.body.innerText.includes(secret) && !location.href.includes(secret); }), true);
  console.log('COORDINATOR_WORKER_BROWSER_E2E_OK');
} finally { await browser.close(); worker?.kill(); server.kill(); await rm(work, { recursive: true, force: true }); await rm(install, { recursive: true, force: true }); }
