#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
}
const work = await mkdtemp(path.join(tmpdir(), 'viq-browser-'));
const listen = await port();
const base = `http://127.0.0.1:${listen}`;
const server = spawn(process.execPath, ['dist/src/server.js', `--port=${listen}`, `--storage=${work}/data.json`, '--takeover-token=secret']);
const cli = (...args) => spawnSync(process.execPath, ['dist/bin/viq.js', '--server', base, '--json', ...args], { encoding: 'utf8' });
for (let tries = 0; tries < 100; tries += 1) {
  try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 20));
}

await mkdir('evidence/screenshots', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const log = [];
const note = (value) => { log.push(value); console.log(value); };

try {
  await page.goto(base);
  await page.getByLabel('New project').fill('ABC');
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();
  await page.getByText('ABC refreshed').waitFor();
  await page.getByLabel(/New ticket in/).fill('Browser parity tracer');
  await page.locator('#ticket-form').getByRole('button', { name: 'Create' }).click();
  await page.getByText('ABC-1').waitFor();
  note('browser created project ABC and ticket ABC-1');

  const claimRun = cli('ticket', 'claim', 'ABC-1', '--actor', 'worker-a', '--ttl-ms', '800');
  assert.equal(claimRun.status, 0, claimRun.stderr); const old = JSON.parse(claimRun.stdout);
  await page.getByRole('button', { name: 'Refresh board' }).click();
  const claimed = page.locator('[data-state="claimed"]');
  await claimed.getByText('ABC-1').waitFor();
  assert.equal(await page.locator('[data-state="ready"] .card').count(), 0);
  note('board reflected claimed owner worker-a in claimed column; ready column empty');

  await page.waitForTimeout(850); await page.getByRole('button', { name: 'Refresh board' }).click();
  const stale = page.locator('[data-state="stale"]'); await stale.getByText('ABC-1').waitFor();
  assert.equal(await page.locator('[data-state="ready"] .card').count(), 0);
  await stale.getByText('Unavailable — explicit takeover only').waitFor();
  note('board reflected stale/uncertain and did not show ticket as ready');

  await page.screenshot({ path: 'evidence/screenshots/board-desktop-stale.png', fullPage: true });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobile.goto(base); await mobile.getByText('ABC-1').waitFor();
  await mobile.screenshot({ path: 'evidence/screenshots/board-mobile-stale.png', fullPage: true });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.close(); note('captured desktop and 390px mobile stale-board screenshots without page overflow');

  await stale.getByRole('button', { name: /Open ABC-1/ }).click();
  await page.getByRole('button', { name: 'Take over stale claim' }).click();
  await page.getByLabel('New owner').fill('worker-b');
  await page.getByLabel('Claim lifetime').fill('60000');
  await page.getByLabel('Local takeover token').fill('secret');
  const takeoverResponse = page.waitForResponse((response) => response.url().endsWith('/takeover') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm takeover' }).click();
  const takeover = await (await takeoverResponse).json();
  await claimed.getByText('Generation 2').waitFor();
  note('explicit confirmed takeover moved ticket to worker-b generation 2');

  const fenced = cli('ticket', 'submit', 'ABC-1', '--actor', 'worker-a', '--claim-token', old.claim_token,
    '--generation', '1', '--evidence', 'old');
  assert.equal(fenced.status, 3); assert.equal(JSON.parse(fenced.stderr).error.code, 'stale_claim');
  note('old owner mutation fenced with stale_claim and exit 3');

  const submitted = cli('ticket', 'submit', 'ABC-1', '--actor', 'worker-b', '--claim-token', takeover.claim_token,
    '--generation', String(takeover.ticket.claim.generation), '--evidence', '{"browser":"green"}');
  assert.equal(submitted.status, 0, submitted.stderr);
  await page.getByRole('button', { name: 'Refresh board' }).click();
  const submittedColumn = page.locator('[data-state="submitted"]'); await submittedColumn.getByText('ABC-1').waitFor();
  await submittedColumn.getByRole('button', { name: /Open ABC-1/ }).click();
  await page.getByText(/"browser": "green"/).waitFor();
  await page.getByLabel('Close ticket detail').click();
  await page.screenshot({ path: 'evidence/screenshots/board-desktop-submitted.png', fullPage: true });
  note('current owner submitted JSON evidence and board reflected submitted');
  note('BROWSER_E2E_OK');
} finally {
  await browser.close(); server.kill();
  await writeFile('evidence/browser-e2e-output.txt', `${log.join('\n')}\n`);
}
