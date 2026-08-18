#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const evidence = process.env.VIQ_EVIDENCE_DIR || 'evidence/human-history/browser';
await mkdir(`${evidence}/screenshots`, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), 'viq-history-browser-'));
const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js', `--port=${port}`, `--storage=${work}/data.sqlite`, '--operator-token=e2e-only']);
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 20)); }
const api = async (method, route, body, auth = false) => { const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer e2e-only' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = response.status === 204 ? null : await response.json(); assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(result)}`); return result; };
const identity = (claim) => ({ claim_id: claim.ticket.claim.claim_id, claim_token: claim.claim_token, generation: claim.ticket.claim.generation, actor: claim.ticket.claim.actor });
const log = []; const note = (message) => { log.push(message); console.log(message); };
for (const actor of [{ id: 'worker', name: 'Worker', kind: 'agent' }, { id: 'maks', name: 'Maks', kind: 'human' }, { id: 'eva', name: 'Eva', kind: 'human' }]) await api('POST', '/v1/actors', actor, true);
for (const project of ['VIQ', 'LIFE', 'WORK']) await api('POST', '/v1/projects', { key: project });
await api('POST', '/v1/tickets', { project: 'VIQ', title: 'Modal history', body: '# Context\n\nSafe **Markdown** <img src=x onerror=alert(1)>', assignee: { type: 'actor', id: 'worker' } });
await api('POST', '/v1/tickets', { project: 'VIQ', title: 'Unassigned queue item' });
await api('POST', '/v1/tickets', { project: 'LIFE', title: 'Maks life item', assignee: { type: 'actor', id: 'maks' } });
await api('POST', '/v1/tickets', { project: 'WORK', title: 'Eva work item', assignee: { type: 'actor', id: 'eva' } });
const claim = await api('POST', '/v1/tickets/VIQ-1/claim', { actor: 'worker' });
for (const text of ['**Inbox** question?', 'Question from **ticket**?']) await api('POST', '/v1/tickets/VIQ-1/questions', { ...identity(claim), text, target_type: 'actor', target_id: 'maks' });

const browser = await chromium.launch({ headless: true }); const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) problems.push(`${message.type()}: ${message.text()}`); }); page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.goto(base); await page.getByText('4 tickets shown').waitFor();
  const projectTrigger = page.getByRole('button', { name: 'Create project' }); await projectTrigger.click();
  assert.equal(await page.locator('dialog[open]').count(), 1); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'key');
  await page.getByLabel('Project key').click(); assert.equal(await page.locator('#modal').isVisible(), true);
  await page.locator('#modal').click({ position: { x: 2, y: 2 } }); await page.locator('#modal').waitFor({ state: 'hidden' }); assert.equal(await projectTrigger.evaluate((element) => document.activeElement === element), true);
  const ticketTrigger = page.getByRole('button', { name: 'Create ticket' }); await ticketTrigger.click(); assert.equal(await page.getByLabel('Ticket title').evaluate((element) => document.activeElement === element), false);
  await page.keyboard.press('Escape'); await page.locator('#modal').waitFor({ state: 'hidden' }); assert.equal(await ticketTrigger.evaluate((element) => document.activeElement === element), true);
  note('PASS VIQ-3 one centered modal handles project/ticket forms, inside/backdrop, Escape, initial and restored focus');

  await page.getByLabel('Your name').selectOption('maks'); await page.locator('.question-card').nth(1).waitFor();
  const inboxQuestion = page.locator('.question-card').filter({ hasText: 'Inbox question?' }); await inboxQuestion.click();
  assert.equal(await page.getByLabel('Your answer (Markdown)').evaluate((element) => document.activeElement === element), true);
  await page.getByLabel('Your answer (Markdown)').fill('Inbox **answer**.'); await page.getByRole('button', { name: 'Send answer' }).click(); await page.getByText('Answer sent').waitFor();
  await page.locator('.ticket-card[data-id="VIQ-1"]').click(); await page.locator('#modal[open]').waitFor(); await page.locator('#modal-title').getByText('Modal history', { exact: true }).waitFor();
  assert.equal(await page.locator('#modal-content img').count(), 0); assert.equal(await page.locator('#modal-content strong').filter({ hasText: 'Markdown' }).count(), 1);
  const ticketQuestion = page.locator('.ticket-question').filter({ hasText: 'Question from ticket?' }); await ticketQuestion.click();
  await page.getByLabel('Your answer (Markdown)').fill('Ticket **answer**.'); await page.getByRole('button', { name: 'Send answer' }).click(); await page.getByText('Answer sent').waitFor();
  assert.equal((await api('GET', '/v1/tickets/VIQ-1/questions')).questions.every((question) => question.status === 'answered'), true);
  await page.screenshot({ path: `${evidence}/screenshots/viq3-modal-question-markdown.png`, fullPage: true });
  note('PASS VIQ-3 questions open from inbox and ticket, accept Markdown, and render without executable HTML');

  const ids = () => page.locator('.ticket-card').evaluateAll((cards) => cards.map((card) => card.dataset.id).sort());
  await page.getByRole('button', { name: 'VIQ', exact: true }).click(); assert.deepEqual(await ids(), ['VIQ-1', 'VIQ-2']);
  await page.getByRole('button', { name: 'VIQ', exact: true }).click(); assert.deepEqual(await ids(), ['LIFE-1', 'VIQ-1', 'VIQ-2', 'WORK-1']);
  const contextWasSuppressed = await page.getByRole('button', { name: 'VIQ', exact: true }).evaluate((element) => !element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.equal(contextWasSuppressed, true); assert.deepEqual(await ids(), ['LIFE-1', 'WORK-1']);
  await page.getByRole('button', { name: 'VIQ', exact: true }).click(); await page.getByRole('button', { name: 'Unassigned', exact: true }).click(); assert.deepEqual(await ids(), ['VIQ-2']);
  await page.getByRole('button', { name: 'Maks', exact: true }).click(); await page.getByRole('button', { name: 'Unassigned', exact: true }).click(); await page.getByText('No tickets match these filters').waitFor();
  await page.getByRole('button', { name: 'Show All' }).click(); assert.deepEqual(await ids(), ['LIFE-1', 'VIQ-1', 'VIQ-2', 'WORK-1']);
  await page.screenshot({ path: `${evidence}/screenshots/viq4-project-assignee-filters.png`, fullPage: true });
  note('PASS VIQ-4 All/exclusive/toggle/right-exclude project gestures compose with assignee filters and empty reset');
  assert.deepEqual(problems, []); note('VIQ3_BROWSER_OK'); note('VIQ4_BROWSER_OK');
} finally { await browser.close(); server.kill(); await writeFile(`${evidence}/browser.log`, `${log.join('\n')}\n${problems.join('\n')}\n`); }
