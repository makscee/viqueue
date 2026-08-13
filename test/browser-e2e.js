#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const freePort = async () => {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return value;
};
const work = await mkdtemp(path.join(tmpdir(), 'viq-human-browser-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const evidence = process.env.VIQ_EVIDENCE_DIR || 'evidence/ui-audit-2026-08-14';
await mkdir(`${evidence}/screenshots`, { recursive: true });
const server = spawn(process.execPath, ['dist/src/server.js', `--port=${port}`, `--storage=${work}/data.sqlite`, '--operator-token=test-operator-only']);
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const api = async (method, route, body, authorized = false) => {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer test-operator-only' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
};
const log = [];
const note = (message) => { log.push(message); console.log(message); };
const claimIdentity = (result, actor) => ({ claim_id: result.ticket.claim.claim_id, claim_token: result.claim_token, generation: result.ticket.claim.generation, actor });

const actors = [
  ['worker', 'Worker agent', 'agent', 'tower-pi'],
  ['maks', 'Maks', 'human', null],
  ['eva', 'Eva', 'human', null],
  ['review-bot', 'Review bot', 'agent', 'mac-pi']
];
for (const [id, name, kind, machine] of actors) await api('POST', '/v1/actors', { id, name, kind, machine }, true);
for (const [id, name] of [['owners', 'Owners'], ['reviewers', 'Reviewers'], ['workers', 'Workers'], ['observers', 'Observers']]) await api('POST', '/v1/roles', { id, name }, true);
await api('PUT', '/v1/actors/maks/roles/reviewers', {}, true);
await api('PUT', '/v1/actors/worker/roles/workers', {}, true);
for (const key of ['LIFE', 'WORK', 'VIQ']) await api('POST', '/v1/projects', { key });
await api('POST', '/v1/tickets', { project: 'LIFE', title: 'Plan weekend', body: 'Choose a simple plan for Saturday.', assignee: { type: 'actor', id: 'maks' } });
await api('POST', '/v1/tickets', { project: 'WORK', title: 'Published release notes', body: 'Release notes were published.', assignee: { type: 'actor', id: 'worker' } });
await api('POST', '/v1/tickets', { project: 'VIQ', title: 'Repair human queue', body: 'Make the shared queue clear for Maks.', assignee: { type: 'actor', id: 'worker' } });
await api('POST', '/v1/tickets', { project: 'VIQ', title: 'Review queue wording', body: 'Approve the wording shown to people.', assignee: { type: 'actor', id: 'worker' } });
const doneClaim = await api('POST', '/v1/tickets/WORK-1/claim', { actor: 'worker' });
await api('POST', '/v1/tickets/WORK-1/events', { ...claimIdentity(doneClaim, 'worker'), message: 'Release notes checked and ready.' });
await api('POST', '/v1/tickets/WORK-1/submit', { ...claimIdentity(doneClaim, 'worker'), reviewer: { type: 'actor', id: 'maks' } });
await api('POST', '/v1/tickets/WORK-1/accept', { actor: 'maks', message: 'Published.' });
const workingClaim = await api('POST', '/v1/tickets/VIQ-1/claim', { actor: 'worker' });
await api('POST', '/v1/tickets/VIQ-1/events', { ...claimIdentity(workingClaim, 'worker'), message: 'Mapped the confusing fields.' });
for (const text of ['Which wording feels clearest?', 'Should answered questions stay visible?']) {
  await api('POST', '/v1/tickets/VIQ-1/questions', { ...claimIdentity(workingClaim, 'worker'), kind: 'text', text, target_type: 'actor', target_id: 'maks' });
}
await api('POST', '/v1/tickets/VIQ-1/events', { ...claimIdentity(workingClaim, 'worker'), message: 'Worker continued after asking both questions.' });
const reviewClaim = await api('POST', '/v1/tickets/VIQ-2/claim', { actor: 'worker' });
await api('POST', '/v1/tickets/VIQ-2/events', { ...claimIdentity(reviewClaim, 'worker'), message: 'Wording is ready for human review.' });
await api('POST', '/v1/tickets/VIQ-2/submit', { ...claimIdentity(reviewClaim, 'worker'), reviewer: { type: 'actor', id: 'maks' }, message: 'Please review the human wording.' });

const browser = await chromium.launch({ headless: true });
const consoleProblems = [];
const watchConsole = (page, label) => {
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) consoleProblems.push(`${label} console ${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => consoleProblems.push(`${label} pageerror: ${error.message}`));
};
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  watchConsole(desktop, 'desktop');
  await desktop.goto(base);
  await desktop.getByRole('heading', { name: 'All tickets' }).waitFor();
  assert.deepEqual(await desktop.locator('.ticket-card').evaluateAll((cards) => cards.map((card) => card.dataset.id).sort()), ['LIFE-1', 'VIQ-1', 'VIQ-2', 'WORK-1']);
  assert.match(await desktop.locator('#inbox-list').innerText(), /choose your name/i);
  note('PASS root is an understandable all-project overview with four tickets');

  await desktop.getByLabel('Your name').selectOption('maks');
  await desktop.locator('.question-card').nth(2).waitFor();
  assert.equal(await desktop.locator('.question-card').count(), 3);
  assert.match(await desktop.locator('#inbox-panel').innerText(), /3 questions? need your answer/i);
  await desktop.reload();
  await desktop.locator('.question-card').nth(2).waitFor();
  assert.equal(await desktop.getByLabel('Your name').inputValue(), 'maks');
  assert.equal(await desktop.locator('.question-card').count(), 3);
  note('PASS Maks identity is remembered and his question inbox is immediately obvious');

  const textQuestion = desktop.locator('.question-card').filter({ hasText: 'Which wording feels clearest?' });
  await textQuestion.getByLabel('Your answer').fill('Use plain language.');
  await textQuestion.getByRole('button', { name: 'Send answer' }).click();
  await desktop.getByText('Answer sent').waitFor();
  assert.equal(await desktop.locator('.question-card').count(), 2);
  note('PASS Maks answers a text question inline without claim credentials');

  const approval = desktop.locator('.question-card').filter({ hasText: 'Review queue wording' });
  await approval.getByLabel('Note (optional)').fill('Explain the empty state first.');
  await approval.getByRole('button', { name: 'Request changes' }).click();
  await desktop.getByText('Changes requested').waitFor();
  assert.equal((await api('GET', '/v1/tickets/VIQ-2')).ticket.state, 'open');
  const secondReviewClaim = await api('POST', '/v1/tickets/VIQ-2/claim', { actor: 'worker' });
  await api('POST', '/v1/tickets/VIQ-2/submit', { ...claimIdentity(secondReviewClaim, 'worker'), reviewer: { type: 'actor', id: 'maks' } });
  await Promise.all([
    desktop.waitForResponse((response) => response.url().includes('/v1/projects') && response.ok()),
    desktop.getByRole('button', { name: 'Refresh' }).click()
  ]);
  await desktop.locator('.question-card').waitFor();
  const secondApproval = desktop.locator('.question-card').filter({ hasText: 'Review queue wording' });
  await secondApproval.getByRole('button', { name: 'Accept work' }).click();
  await desktop.getByText('Work accepted').waitFor();
  assert.equal((await api('GET', '/v1/tickets/VIQ-2')).ticket.state, 'done');
  note('PASS Maks can request changes and accept an approval inline');

  await desktop.locator('.ticket-card[data-id="VIQ-1"]').click();
  await desktop.locator('#detail').waitFor({ state: 'visible' });
  await desktop.locator('#detail-title').getByText('Repair human queue', { exact: true }).waitFor();
  const detailText = await desktop.locator('#detail').innerText();
  for (const expected of ['Repair human queue', 'Make the shared queue clear for Maks.', 'Worker agent', 'Working', 'Worker continued after asking both questions.', 'Which wording feels clearest?', 'Should answered questions stay visible?']) assert.match(detailText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const forbidden of ['Claim ID', 'Claim token', 'Generation', 'operator token', 'actor:maks', 'target_type']) assert.doesNotMatch(detailText, new RegExp(forbidden, 'i'));
  assert.equal(await desktop.locator('#detail .ticket-question').count(), 2);
  assert.match(detailText, /worker continues while questions wait/i);
  await desktop.screenshot({ path: `${evidence}/screenshots/maks-ticket-detail-desktop.png`, fullPage: true });
  await desktop.getByRole('button', { name: 'Close ticket' }).click();
  await desktop.screenshot({ path: `${evidence}/screenshots/maks-all-tickets-desktop.png`, fullPage: true });
  note('PASS human detail is meaningful, shows accumulating questions, and hides agent internals');

  await desktop.getByLabel('Project view').selectOption('VIQ');
  await desktop.locator('.ticket-card').nth(1).waitFor();
  assert.deepEqual(await desktop.locator('.ticket-card').evaluateAll((cards) => cards.map((card) => card.dataset.id).sort()), ['VIQ-1', 'VIQ-2']);
  await desktop.getByLabel('Project view').selectOption('');
  await desktop.locator('.ticket-card').nth(3).waitFor();
  assert.equal(await desktop.locator('.ticket-card').count(), 4);
  note('PASS project browsing returns cleanly to All projects');

  await desktop.locator('.create').evaluate((details) => { details.open = true; });
  await desktop.getByLabel('Ticket title').fill('Needs a project');
  await desktop.getByRole('button', { name: 'Create ticket' }).click();
  await desktop.getByText('Something went wrong: Choose a project before creating a ticket').waitFor();
  await desktop.getByRole('button', { name: 'Refresh', exact: true }).click();
  await desktop.getByText('4 tickets shown').waitFor();
  note('PASS validation errors are understandable and refresh recovers without console errors');

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watchConsole(mobile, 'mobile');
  await mobile.goto(base);
  await mobile.getByLabel('Your name').selectOption('maks');
  await mobile.locator('.question-card').waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.getByRole('tab', { name: /Working/ }).click();
  assert.equal(await mobile.locator('.column:not([hidden])').count(), 1);
  await mobile.screenshot({ path: `${evidence}/screenshots/maks-working-mobile-390.png`, fullPage: true });
  await mobile.locator('.ticket-card[data-id="VIQ-1"]').click();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.screenshot({ path: `${evidence}/screenshots/maks-ticket-detail-mobile-390.png`, fullPage: true });
  note('PASS desktop and 390px mobile have sensible navigation and no horizontal overflow');

  await mobile.getByRole('button', { name: 'Close ticket' }).click();
  const remaining = mobile.locator('.question-card').filter({ hasText: 'Should answered questions stay visible?' });
  await remaining.getByLabel('Your answer').fill('Yes, keep the history understandable.');
  await remaining.getByRole('button', { name: 'Send answer' }).click();
  await mobile.getByText(/nothing needs your answer/i).waitFor();
  await mobile.screenshot({ path: `${evidence}/screenshots/maks-empty-inbox-mobile-390.png`, fullPage: true });
  note('PASS explanatory empty inbox appears after the final answer');

  assert.deepEqual(consoleProblems, []);
  note('PASS no browser console errors or warnings during significant interactions');
  note('BROWSER_E2E_OK');
} finally {
  await browser.close();
  server.kill();
  await writeFile(`${evidence}/browser-e2e-output.txt`, `${log.join('\n')}\n${consoleProblems.join('\n')}\n`);
}
