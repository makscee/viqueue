#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const work = await mkdtemp(path.join(tmpdir(), 'viq-history-browser-'));
const evidence = process.env.VIQ_EVIDENCE_DIR || path.join(work, 'evidence');
await mkdir(`${evidence}/screenshots`, { recursive: true });
const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['src/server.js', `--port=${port}`, `--storage=${work}/data.sqlite`, '--operator-token=e2e-only']);
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 20)); }
const api = async (method, route, body, auth = false) => { const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer e2e-only' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = response.status === 204 ? null : await response.json(); assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(result)}`); return result; };
const identity = (claim) => ({ claim_id: claim.ticket.claim.claim_id, claim_token: claim.claim_token, generation: claim.ticket.claim.generation, actor: claim.ticket.claim.actor, device: claim.ticket.claim.device_id, session_capability: claim.session_capability });
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
  await api('POST', '/v1/projects', { key: 'NEW' }); await page.getByRole('button', { name: 'Refresh' }).click(); await page.getByText('4 tickets shown').waitFor();
  assert.equal(await page.getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed'), 'true'); assert.equal(await page.getByRole('button', { name: 'NEW', exact: true }).getAttribute('aria-pressed'), 'true');

  await page.getByRole('button', { name: 'Create ticket' }).click(); await page.locator('#modal-content select[name="project"]').selectOption('LIFE'); await page.getByLabel('Ticket title').fill('Disposable history'); await page.getByLabel('Context (Markdown)').fill('# Durable story\n\nInitial **body**.'); await page.locator('#modal-content').getByRole('button', { name: 'Create ticket' }).click(); await page.getByText('5 tickets shown').waitFor();
  const createdEvent = (await api('GET', '/v1/events?ticket=LIFE-2')).events.find((event) => event.type === 'ticket_created'); assert.equal(createdEvent.actor, 'maks');
  await page.locator('.ticket-card[data-id="LIFE-2"] .ticket-open').click(); const editTrigger = page.getByRole('button', { name: 'Edit ticket' }); await editTrigger.click(); await page.keyboard.press('Escape'); await page.locator('#modal-title').getByText('Disposable history', { exact: true }).waitFor(); assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Edit ticket'); await page.getByRole('button', { name: 'Edit ticket' }).click();
  await page.getByLabel('Ticket title').fill('Edited durable history'); await page.getByLabel('Description (Markdown)').fill('Edited **safe** body.'); await page.locator('#modal-content select[name="project"]').selectOption('WORK'); await page.locator('#modal-content select[name="assignee"]').selectOption('actor:worker'); await page.locator('#modal-content select[name="state"]').selectOption('review'); await page.getByRole('button', { name: 'Save ticket' }).click(); await page.getByText('Ticket updated').waitFor();
  let disposable = (await api('GET', '/v1/tickets/LIFE-2')).ticket; assert.equal(disposable.project, 'WORK'); assert.equal(disposable.state, 'review'); assert.deepEqual(disposable.assignee, { type: 'actor', id: 'worker' }); assert.equal(disposable.claim, null);
  const editHistory = (await api('GET', '/v1/events?ticket=LIFE-2')).events.filter((event) => ['ticket_edited', 'ticket_moved', 'assigned'].includes(event.type)); assert.deepEqual(editHistory.map((event) => event.actor), ['maks', 'maks', 'maks']);
  await page.locator('.ticket-card[data-id="LIFE-2"] .card-state').selectOption('done'); await page.getByText('State changed to done').waitFor();
  await page.locator('.ticket-card[data-id="LIFE-2"] .ticket-open').click(); await page.locator('#modal-content .detail-actions').getByLabel('State').selectOption('open'); await page.getByText('State changed to open').waitFor();
  await page.locator('.ticket-card[data-id="LIFE-2"] .ticket-open').click(); await page.getByRole('button', { name: 'Add progress' }).click(); await page.getByLabel('Progress (Markdown)').fill('Human **progress** entry.'); await page.getByRole('button', { name: 'Add progress' }).click(); await page.getByText('Progress added').waitFor();
  await page.locator('.ticket-card[data-id="LIFE-2"] .ticket-open').click(); await page.getByRole('button', { name: 'Ask question' }).click(); await page.getByLabel('Question (Markdown)').fill('Eva, is **history** clear?'); await page.locator('#modal-content select[name="target"]').selectOption('actor:eva'); await page.getByRole('button', { name: 'Ask question' }).click(); await page.getByText('Question asked').waitFor();
  await page.getByLabel('Your name').selectOption('eva'); const humanQuestion = page.locator('.question-card').filter({ hasText: 'is history clear?' }); await humanQuestion.click(); await page.getByLabel('Your answer (Markdown)').fill('Yes, **clear** and chronological.'); await page.getByRole('button', { name: 'Send answer' }).click(); await page.getByText('Answer sent').waitFor();
  const lifeEvents = (await api('GET', '/v1/events?ticket=LIFE-2')).events; const askedEvent = lifeEvents.find((event) => event.type === 'question_asked');
  await page.locator('.ticket-card[data-id="LIFE-2"] .ticket-open').click(); const linkedAnswer = page.locator('.event-question_answered[data-question-event]'); await linkedAnswer.waitFor(); const timeline = page.locator('.event-timeline'); assert.ok(await timeline.locator('.event').count() >= 8); assert.equal(await timeline.locator('.event-head time').count(), await timeline.locator('.event').count()); assert.equal(await linkedAnswer.getAttribute('data-question-event'), String(askedEvent.cursor)); assert.equal(await linkedAnswer.locator('strong').filter({ hasText: 'clear' }).count(), 1); assert.match(await timeline.innerText(), /Ticket edited[\s\S]*Updated ticket title or description\.[\s\S]*Project changed[\s\S]*Moved from LIFE to WORK\.[\s\S]*Assignment changed[\s\S]*Assigned to actor worker\.[\s\S]*State changed[\s\S]*Moved from review to done\.[\s\S]*State changed[\s\S]*Moved from done to open\./); assert.match(await timeline.innerText(), /Eva.*Question answered|Question answered.*Eva/s); assert.equal(await page.locator('#modal-content img').count(), 0);
  await page.screenshot({ path: `${evidence}/screenshots/viq5-editable-event-history.png`, fullPage: true });
  await page.getByRole('button', { name: 'Archive', exact: true }).click(); await page.getByText('Ticket archived').waitFor(); const archivedCard = page.locator('.column[data-column="archived"] .ticket-card[data-id="LIFE-2"]'); await archivedCard.waitFor(); await archivedCard.locator('.ticket-open').click(); assert.match(await page.locator('.event-archived').innerText(), /Archived[\s\S]*Archived ticket\./); await page.screenshot({ path: `${evidence}/screenshots/viq5-archived-reversible.png`, fullPage: true }); await page.locator('#modal-content .detail-actions').getByRole('button', { name: 'Restore' }).click(); await page.getByText('Ticket restored').waitFor();
  await page.locator('.column[data-column="waiting"] .ticket-card[data-id="LIFE-2"] .ticket-open').click(); assert.match(await page.locator('.event-restored').innerText(), /Restored[\s\S]*Restored ticket from archive\./); await page.getByRole('button', { name: 'Delete ticket' }).click(); await page.getByLabel('Confirm delete').check(); await page.getByRole('button', { name: 'Confirm delete' }).click(); await page.getByText('Ticket deleted').waitFor(); assert.equal(await page.locator('.ticket-card[data-id="LIFE-2"]').count(), 0); disposable = (await api('GET', '/v1/tickets/LIFE-2')).ticket; assert.ok(disposable.deleted_at); assert.ok((await api('GET', '/v1/events?ticket=LIFE-2')).events.length >= 10);
  note('PASS VIQ-5 human created, edited/moved/assigned without claim, changed state from board/details, progressed, questioned/answered, archived/restored, and explicitly deleted a disposable ticket with attributed timeline retained');

  await api('POST', '/v1/tickets', { project: 'LIFE', title: 'Mobile disposable history', body: 'Initial **mobile** context.', assignee: { type: 'actor', id: 'maks' }, actor: 'maks' });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  mobile.on('console', (message) => { if (['error', 'warning'].includes(message.type())) problems.push(`mobile ${message.type()}: ${message.text()}`); }); mobile.on('pageerror', (error) => problems.push(`mobile pageerror: ${error.message}`));
  const mobileFits = async () => assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  const mobileIds = () => mobile.locator('.ticket-card').evaluateAll((cards) => cards.map((card) => card.dataset.id).sort());
  await mobile.goto(base); await mobile.getByText('5 tickets shown').waitFor(); await mobile.getByLabel('Your name').selectOption('maks'); await mobileFits();
  await mobile.getByRole('button', { name: 'LIFE', exact: true }).click(); assert.deepEqual(await mobileIds(), ['LIFE-1', 'LIFE-3']);
  await mobile.getByRole('button', { name: 'Maks', exact: true }).click(); assert.deepEqual(await mobileIds(), ['LIFE-1', 'LIFE-3']);
  assert.equal(await mobile.getByRole('button', { name: 'LIFE', exact: true }).getAttribute('aria-pressed'), 'true'); assert.equal(await mobile.getByRole('button', { name: 'Maks', exact: true }).getAttribute('aria-pressed'), 'true');
  await mobile.locator('.ticket-card[data-id="LIFE-3"] .ticket-open').click(); await mobile.getByRole('button', { name: 'Edit ticket' }).click();
  await mobile.getByLabel('Ticket title').fill('Mobile edited history'); await mobile.getByLabel('Description (Markdown)').fill('Edited **on 390px**.'); await mobile.getByRole('button', { name: 'Save ticket' }).click(); await mobile.getByText('Ticket updated').waitFor();
  let mobileTicket = (await api('GET', '/v1/tickets/LIFE-3')).ticket; assert.equal(mobileTicket.title, 'Mobile edited history'); assert.equal(mobileTicket.body, 'Edited **on 390px**.');
  await mobile.locator('.ticket-card[data-id="LIFE-3"] .ticket-open').click(); await mobile.getByRole('button', { name: 'Add progress' }).click(); await mobile.getByLabel('Progress (Markdown)').fill('Mobile human **progress**.'); await mobile.getByRole('button', { name: 'Add progress' }).click(); await mobile.getByText('Progress added').waitFor();
  assert.equal((await api('GET', '/v1/events?ticket=LIFE-3')).events.at(-1).message, 'Mobile human **progress**.');
  await mobile.locator('.ticket-card[data-id="LIFE-3"] .card-state').selectOption('review'); await mobile.getByText('State changed to review').waitFor(); await mobile.getByRole('tab', { name: /Review/ }).click(); assert.equal(await mobile.locator('.column:not([hidden])').count(), 1);
  await mobile.locator('.ticket-card[data-id="LIFE-3"] .ticket-open').click(); await mobile.getByRole('button', { name: 'Archive', exact: true }).click(); await mobile.getByText('Ticket archived').waitFor(); await mobile.getByRole('tab', { name: /Archived/ }).click();
  await mobile.locator('.ticket-card[data-id="LIFE-3"]').getByRole('button', { name: 'Restore' }).click(); await mobile.getByText('Ticket restored').waitFor(); await mobile.getByRole('tab', { name: /Review/ }).click();
  await mobile.locator('.ticket-card[data-id="LIFE-3"] .ticket-open').click(); await mobile.getByRole('button', { name: 'Delete ticket' }).click();
  assert.equal(await mobile.getByLabel('Confirm delete').isChecked(), false); await mobile.getByRole('button', { name: 'Confirm delete' }).click(); await mobile.waitForTimeout(50); assert.equal((await api('GET', '/v1/tickets/LIFE-3')).ticket.deleted_at, null);
  await mobile.getByLabel('Confirm delete').check(); await mobile.getByRole('button', { name: 'Confirm delete' }).click(); await mobile.getByText('Ticket deleted').waitFor(); mobileTicket = (await api('GET', '/v1/tickets/LIFE-3')).ticket; assert.ok(mobileTicket.deleted_at);
  await mobileFits(); await mobile.screenshot({ path: `${evidence}/screenshots/viq8-mobile-390-history.png`, fullPage: true }); await mobile.close();
  note('PASS VIQ-8 independent 390px flow composes project/assignee chips and performs attributed edit, progress, state, archive/restore, and checked delete without overflow; desktop coverage remains intact');
  assert.deepEqual(problems, []); note('VIQ3_BROWSER_OK'); note('VIQ4_BROWSER_OK'); note('VIQ5_BROWSER_OK'); note('VIQ7_BROWSER_OK'); note('VIQ8_BROWSER_OK');
} finally { await browser.close(); server.kill(); await writeFile(`${evidence}/browser.log`, `${[...log, ...problems].join('\n')}\n`); if (!process.env.VIQ_EVIDENCE_DIR) await rm(work, { recursive: true, force: true }); }
