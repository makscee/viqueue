#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

async function port() {
  const probe = net.createServer(); await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const value = probe.address().port; await new Promise((resolve) => probe.close(resolve)); return value;
}
const work = await mkdtemp(path.join(tmpdir(), 'viq-browser-'));
const listen = await port(); const base = `http://127.0.0.1:${listen}`;
const server = spawn(process.execPath, ['dist/src/server.js', `--port=${listen}`, `--storage=${work}/data.json`, '--takeover-token=secret']);
const cli = (...args) => spawnSync(process.execPath, ['dist/bin/viq.js', '--server', base, '--json', ...args], { encoding: 'utf8' });
const api = async (method, route, body, headers = {}) => {
  const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
};
for (let tries = 0; tries < 100; tries += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 20)); }

const evidenceDir = process.env.VIQ_EVIDENCE_DIR ?? 'evidence'; await mkdir(`${evidenceDir}/screenshots`, { recursive: true });
const browser = await chromium.launch({ headless: true });
const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
const log = []; const note = (value) => { log.push(value); console.log(value); };
const longTitle = 'Investigate an unusually long external-agent handoff title that must wrap without escaping its ticket card boundary';
const longActor = 'worker-with-a-very-long-local-identifier-0123456789';

try {
  await desktop.route('**/v1/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 150)); await route.continue();
    } else await route.continue();
  });
  const loading = desktop.goto(base); await desktop.getByText('Loading board…').waitFor(); await loading;
  await desktop.getByText('Create a project to begin').waitFor();
  assert.equal(await desktop.locator('[data-state="ready"] .empty').textContent(), 'No tickets');
  note('browser rendered deterministic loading and empty-project states');
  await desktop.unroute('**/v1/projects');
  await desktop.route('**/v1/projects', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"fixture unavailable"}}' }), { times: 1 });
  await desktop.getByRole('button', { name: 'Refresh board' }).click();
  await desktop.getByRole('status').getByText('fixture unavailable').waitFor();
  assert.equal(await desktop.getByRole('status').evaluate((element) => element.classList.contains('error')), true);
  note('browser rendered an accessible deterministic refresh error');
  await desktop.getByLabel('New project').fill('ABC'); await desktop.getByRole('button', { name: 'Create', exact: true }).first().click();
  await desktop.getByText('ABC refreshed').waitFor();
  await desktop.getByLabel(/New ticket in/).fill(longTitle); await desktop.locator('#ticket-form').getByRole('button', { name: 'Create' }).click();
  for (const title of ['Claimed integration check', 'Stale uncertain handoff', 'Submitted evidence review', 'Additional ready item']) {
    await api('POST', '/v1/tickets', { project: 'ABC', title });
  }
  const claimed = JSON.parse(cli('ticket', 'claim', 'ABC-2', '--actor', longActor, '--ttl-ms', '60000').stdout);
  const staleOwner = JSON.parse(cli('ticket', 'claim', 'ABC-3', '--actor', 'worker-stale-owner-with-long-id', '--ttl-ms', '800').stdout);
  const submittedOwner = JSON.parse(cli('ticket', 'claim', 'ABC-4', '--actor', 'worker-submitter', '--ttl-ms', '60000').stdout);
  const evidence = { summary: 'first line\nsecond line with a long structured value that must remain readable', checks: ['unit', 'browser', 'fencing'], nested: { result: 'green' } };
  assert.equal(cli('ticket', 'submit', 'ABC-4', '--actor', 'worker-submitter', '--claim-token', submittedOwner.claim_token, '--generation', '1', '--evidence', JSON.stringify(evidence)).status, 0);
  await desktop.waitForTimeout(850); await desktop.getByRole('button', { name: 'Refresh board' }).click();
  await desktop.locator('[data-state="stale"]').getByText('ABC-3').waitFor();
  await desktop.screenshot({ path: `${evidenceDir}/screenshots/board-desktop-populated.png`, fullPage: true });
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  note('desktop populated all states with long title, actor, and structured evidence fixtures');

  await mobile.goto(base); await mobile.getByRole('tab', { name: /Ready 2/ }).waitFor();
  assert.equal(await mobile.getByRole('tab', { name: /Stale 1/ }).getAttribute('aria-selected'), 'false');
  assert.equal(await mobile.locator('.column:visible').getAttribute('data-state'), 'ready');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.screenshot({ path: `${evidenceDir}/screenshots/board-mobile-initial.png`, fullPage: true });
  note('mobile initial state exposed all state tabs and stale count without horizontal swiping');

  const readyTab = mobile.getByRole('tab', { name: /Ready 2/ }); await readyTab.focus(); await readyTab.press('ArrowRight');
  assert.equal(await mobile.getByRole('tab', { name: /Claimed 1/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await mobile.getByRole('tab', { name: /Claimed 1/ }).evaluate((element) => getComputedStyle(element).outlineStyle), 'solid');
  await mobile.getByRole('tab', { name: /Stale 1/ }).click();
  assert.equal(await mobile.locator('.column:visible').getAttribute('data-state'), 'stale');
  await mobile.getByRole('button', { name: /Open ABC-3/ }).click();
  await mobile.getByRole('button', { name: 'Take over stale claim' }).waitFor();
  await mobile.screenshot({ path: `${evidenceDir}/screenshots/board-mobile-stale-action.png`, fullPage: true });
  note('keyboard and touch state navigation exposed stale card and explicit takeover action');

  await mobile.getByRole('button', { name: 'Take over stale claim' }).click();
  await mobile.getByLabel('New owner').fill('worker-b'); await mobile.getByLabel('Claim lifetime').fill('60000'); await mobile.getByLabel('Local takeover token').fill('secret');
  const takeoverResponse = mobile.waitForResponse((response) => response.url().endsWith('/takeover') && response.request().method() === 'POST');
  await mobile.getByRole('button', { name: 'Confirm takeover' }).click(); const takeover = await (await takeoverResponse).json();
  assert.equal(takeover.ticket.claim.generation, 2);
  const fenced = cli('ticket', 'submit', 'ABC-3', '--actor', 'worker-stale-owner-with-long-id', '--claim-token', staleOwner.claim_token, '--generation', '1', '--evidence', 'old');
  assert.equal(fenced.status, 3); assert.equal(JSON.parse(fenced.stderr).error.code, 'stale_claim');
  note('confirmed authorized takeover reached generation 2 and old owner remained fenced');

  await mobile.getByLabel(/New ticket in/).fill('editing text must survive polling');
  const external = await api('POST', '/v1/tickets', { project: 'ABC', title: 'Created externally while browser waits' });
  await mobile.waitForTimeout(5_300);
  assert.equal(await mobile.getByLabel(/New ticket in/).inputValue(), 'editing text must survive polling');
  assert.equal(await mobile.getByRole('tab', { name: /Ready 2/ }).textContent(), 'Ready 2');
  await mobile.getByLabel(/New ticket in/).blur(); await mobile.waitForTimeout(5_300);
  await mobile.getByRole('tab', { name: /Ready 3/ }).waitFor(); assert.equal(external.ticket.id, 'ABC-6');
  note('bounded polling deferred during form input, preserved focus content, then reflected external state');

  await mobile.getByRole('tab', { name: /Submitted 1/ }).click(); await mobile.getByRole('button', { name: /Open ABC-4/ }).click();
  await mobile.getByText(/second line with a long structured value/).waitFor();
  assert.equal(await mobile.locator('.evidence').evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await mobile.screenshot({ path: `${evidenceDir}/screenshots/board-mobile-submitted-detail.png`, fullPage: true });
  note('mobile submitted detail rendered multiline structured evidence without layout escape');
  note('BROWSER_E2E_OK');
  void claimed;
} finally {
  await browser.close(); server.kill(); await writeFile(`${evidenceDir}/browser-e2e-output.txt`, `${log.join('\n')}\n`);
}
