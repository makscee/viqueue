#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, chown, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';

const tmpRoot = process.env.TMPDIR;
const workerTmpRoot = process.env.VIQ_WORKER_TMPDIR;
if (!tmpRoot || !workerTmpRoot || !path.isAbsolute(tmpRoot) || !path.isAbsolute(workerTmpRoot)) throw new Error('explicit absolute TMPDIR and VIQ_WORKER_TMPDIR are required');
const workerUser = process.env.VIQ_WORKER_USER ?? 'viq-worker';
const workerUid = Number(execFileSync('id', ['-u', workerUser], { encoding: 'utf8' }).trim());
const workerGid = Number(execFileSync('id', ['-g', workerUser], { encoding: 'utf8' }).trim());
const work = await mkdtemp(path.join(tmpRoot, 'viq-coordinator-worker-'));
const install = await mkdtemp(path.join(workerTmpRoot, 'viq-worker-browser-'));
const release = process.env.VIQ_WORKER_RELEASE ? path.resolve(process.env.VIQ_WORKER_RELEASE) : path.join(install, 'current');
const helper = path.join(install, 'real-worker-helper.mjs');
const discoveryHelper = path.join(install, 'pi-worker-discovery.mjs');
const stateHome = path.join(install, 'state');
const jobsRoot = path.join(install, 'jobs');
const workspace = path.join(jobsRoot, 'browser-proof');
const piAgentDir = path.join(install, 'pi-agent');
if (!process.env.VIQ_WORKER_RELEASE) {
  await mkdir(path.join(release, 'extensions'), { recursive: true });
  await cp('extensions/viq-worker', path.join(release, 'extensions/viq-worker'), { recursive: true });
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  await writeFile(path.join(release, 'package.json'), `${JSON.stringify({ name: pkg.name, pi: pkg.pi })}\n`);
}
await cp('test/fixtures/real-worker-helper.mjs', helper);
await cp('test/fixtures/pi-worker-discovery.mjs', discoveryHelper);
await mkdir(stateHome, { mode: 0o700 });
await mkdir(workspace, { recursive: true, mode: 0o700 });
await mkdir(piAgentDir, { mode: 0o700 });
async function giveToWorker(target) { const fs = await import('node:fs/promises'); const entries = await fs.readdir(target, { withFileTypes: true }); await chown(target, workerUid, workerGid); await chmod(target, 0o755); for (const entry of entries) { const child = path.join(target, entry.name); if (entry.isDirectory()) await giveToWorker(child); else { await chown(child, workerUid, workerGid); await chmod(child, 0o600); } } }
await giveToWorker(install); await chmod(stateHome, 0o700); await chmod(workspace, 0o700); await chmod(piAgentDir, 0o700);
const storage = path.join(work, 'viqueue.sqlite');
let store = new Store(storage); await store.init();
const bootstrap = await store.bootstrapCoordinator({ id: 'bootstrap', name: 'Bootstrap' });
const browserCode = await store.createPairingCode('bootstrap', { actor_id: 'bootstrap', intended_kind: 'coordinator', device_id: 'browser-coordinator', device_name: 'Browser Coordinator' });
const workerCode = (await store.createPairingCode('bootstrap', { intended_kind: 'worker', device_id: 'real-worker', device_name: 'Real Worker' })).code;
await store.createProject('DOG'); await store.close();
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
  await page.getByLabel('One-time code').fill(browserCode.code); await page.getByRole('button', { name: 'Pair browser' }).click();
  await page.locator('#app-shell').waitFor({ state: 'visible' }); assert.equal(await page.locator('#actor-select').inputValue(), 'bootstrap');
  assert.ok(workerCode);
  const workerEnv = { ...process.env, VIQ_URL: base, XDG_CONFIG_HOME: stateHome, PI_CODING_AGENT_DIR: piAgentDir, VIQ_WORKER_ROOT: jobsRoot, VIQ_WORKER_UID: String(workerUid), VIQ_WORKER_GID: String(workerGid) };
  const workerCommand = (script) => workerUid === process.getuid() ? [process.execPath, [script, release]] : ['runuser', ['-u', workerUser, '--', process.execPath, script, release]];
  if (process.env.VIQ_PI_WORKER_PROOF === '1') {
    const [discoveryCommand, discoveryArgs] = workerCommand(discoveryHelper);
    const discovery = spawn(discoveryCommand, discoveryArgs, { cwd: workspace, env: workerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let discoveryOut = ''; let discoveryErr = '';
    discovery.stdout.on('data', (chunk) => { discoveryOut += String(chunk); });
    discovery.stderr.on('data', (chunk) => { if (discoveryErr.length < 4096) discoveryErr += String(chunk); });
    const discoveryStatus = await Promise.race([new Promise((resolve) => discovery.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Pi discovery timeout')), 15000))]);
    assert.equal(discoveryStatus, 0, discoveryErr || 'Pi discovery failed');
    assert.match(discoveryOut, /PI_WORKER_COMMAND_DISCOVERED/);
  }
  const [workerExecutable, workerArgs] = workerCommand(helper);
  worker = spawn(workerExecutable, workerArgs, { cwd: workspace, env: workerEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let workerError = ''; worker.stderr.on('data', (chunk) => { if (workerError.length < 4096) workerError += String(chunk); });
  const lines = createInterface({ input: worker.stdout }); const queue = []; const waiters = []; lines.on('line', (line) => { const waiter = waiters.shift(); if (waiter) waiter(line); else queue.push(line); });
  const nextLine = () => queue.length ? Promise.resolve(queue.shift()) : Promise.race([new Promise((resolve) => waiters.push(resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error(`worker response timeout: ${workerError.slice(-2000)}`)), 15000))]);
  worker.stdin.write(`${workerCode}\n`); assert.equal(await nextLine(), 'PAIRED_AND_DENIED');
  await page.getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await page.evaluate((code) => document.body.innerText.includes(code) || location.href.includes(code), workerCode), false);
  await page.getByRole('button', { name: '+ Ticket', exact: true }).click(); await page.locator('#modal-content select[name="project"]').selectOption('DOG'); await page.getByLabel('Ticket title').fill('Real lifecycle'); await page.getByLabel('Assignment').selectOption('worker:real-worker'); await page.locator('#modal-content').getByRole('button', { name: 'Create ticket' }).click();
  await page.getByRole('button', { name: '+ Ticket', exact: true }).click(); await page.locator('#modal-content select[name="project"]').selectOption('DOG'); await page.getByLabel('Ticket title').fill('Must remain unassigned'); await page.locator('#modal-content').getByRole('button', { name: 'Create ticket' }).click();
  worker.stdin.write('start\n'); assert.equal(await nextLine(), 'CLAIMED'); assert.equal(await nextLine(), 'BLOCKED'); await page.getByRole('button', { name: 'Refresh' }).click();
  const activityQuestion = page.locator('[data-surface="Activity"] .question-card').filter({ hasText: 'May I continue?' }); await activityQuestion.waitFor(); assert.match(await activityQuestion.locator('small').textContent(), /Non-blocking/); await page.locator('.ticket-card[data-id="DOG-1"] .ticket-open').click(); const popupQuestion = page.locator('.ticket-open-questions .question-card').filter({ hasText: 'May I continue?' }); await popupQuestion.getByLabel(/Answer/).fill('Continue.'); await popupQuestion.getByRole('button', { name: 'Send answer' }).click(); await page.getByText('Answer sent').waitFor(); assert.equal(await page.locator('[data-surface="Activity"] .question-card').filter({ hasText: 'May I continue?' }).count(), 0); await page.getByRole('button', { name: 'Close' }).click();
  await page.locator('.ticket-card[data-id="DOG-1"] .ticket-open').click(); await page.getByRole('button', { name: 'Resolve block: Needs coordinator resolution' }).click(); await page.locator('#modal').getByRole('button', { name: 'Close' }).click();
  worker.stdin.write('resume\n'); assert.equal(await nextLine(), 'SUBMITTED'); await page.getByRole('button', { name: 'Refresh' }).click();
  const approval = page.locator('[data-surface="Activity"] .question-card').filter({ hasText: 'Approve submitted work?' }); await approval.waitFor(); assert.match(await approval.locator('small').textContent(), /Approval/); await approval.getByRole('button', { name: 'Accept work', exact: true }).click(); await page.getByText('Work accepted').waitFor();
  await page.locator('[data-tab="done"]').evaluate((element) => element.click()); await page.locator('[data-column="done"] .ticket-card[data-id="DOG-1"]').waitFor();
  store = new Store(storage); await store.init(); const unassigned = await store.getTicket('DOG-2'); await store.close(); assert.equal(unassigned.assignment, 'Unassigned'); assert.equal(unassigned.claim, null);
  assert.deepEqual(page.viewportSize(), { width: 1280, height: 900 }); assert.equal(await page.locator('.surface').count(), 5); await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#state-tabs [data-tab="Activity"]').click(); assert.equal(await page.locator('.surface:visible').count(), 1); assert.equal(await page.locator('[data-surface="Activity"]:visible').count(), 1); assert.equal(await page.locator('#state-tabs button').count(), 5); await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(consoleMessages.some((message) => message.includes(workerCode) || message.includes(browserCode.code) || message.includes(bootstrap.credential)), false);
  assert.equal(await page.evaluate(() => { const secret = localStorage.getItem('viq.deviceCredential'); return Boolean(secret) && !document.body.innerText.includes(secret) && !location.href.includes(secret); }), true);
  console.log('COORDINATOR_WORKER_BROWSER_E2E_OK');
} finally { await browser.close(); worker?.kill(); server.kill(); await rm(work, { recursive: true, force: true }); await rm(install, { recursive: true, force: true }); }
