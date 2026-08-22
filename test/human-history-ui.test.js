import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { applyTicketFilters, createModalController, reconcileProjectSelection, selectProject, renderMarkdown } from '../web/ui-core.js';

test('Markdown rendering preserves useful formatting and escapes executable HTML', () => {
  const html = renderMarkdown('# Update\n\n**done** [safe](https://example.com) <img src=x onerror=alert(1)> [bad](javascript:alert(1))');
  assert.match(html, /<h1>Update<\/h1>/);
  assert.match(html, /<strong>done<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /<img|href="javascript:/i);
  assert.match(html, /&lt;img/);
});

test('reusable modal closes only from backdrop or Escape and restores trigger focus', () => {
  const listeners = new Map();
  const dialog = {
    open: false,
    addEventListener: (type, listener) => listeners.set(type, listener),
    showModal() { this.open = true; },
    close() { this.open = false; listeners.get('close')?.(); }
  };
  let triggerFocused = 0; let inputFocused = 0;
  const modal = createModalController(dialog);
  modal.open({ trigger: { focus: () => { triggerFocused += 1; } }, initialFocus: { focus: () => { inputFocused += 1; } } });
  assert.equal(dialog.open, true);
  assert.equal(inputFocused, 1);
  listeners.get('click')({ target: {}, currentTarget: dialog });
  assert.equal(dialog.open, true);
  listeners.get('click')({ target: dialog, currentTarget: dialog });
  assert.equal(dialog.open, false);
  assert.equal(triggerFocused, 1);
  modal.open({ trigger: { focus: () => { triggerFocused += 1; } }, initialFocus: { focus: () => { inputFocused += 1; } } });
  let prevented = false;
  listeners.get('keydown')({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, false);
  assert.equal(triggerFocused, 2);
});

test('project chips toggle independently with left click', () => {
  const projects = ['LIFE', 'VIQ', 'WORK'];
  let selected = new Set(projects);
  selected = selectProject(projects, selected, 'VIQ');
  assert.deepEqual([...selected], ['LIFE', 'WORK']);
  selected = selectProject(projects, selected, 'VIQ');
  assert.deepEqual([...selected], ['LIFE', 'WORK', 'VIQ']);
});

test('semantic All projects includes projects discovered by refresh', () => {
  assert.deepEqual([...reconcileProjectSelection(['LIFE', 'VIQ'], ['LIFE', 'NEW', 'VIQ'], new Set(['LIFE', 'VIQ']))], ['LIFE', 'NEW', 'VIQ']);
  assert.deepEqual([...reconcileProjectSelection(['LIFE', 'VIQ'], ['LIFE', 'NEW', 'VIQ'], new Set(['VIQ']))], ['VIQ']);
});

test('project and Human/Agent filters compose with OR within assignment choices', () => {
  const tickets = [
    { id: 'LIFE-1', project: 'LIFE', assignment: 'Human' },
    { id: 'VIQ-1', project: 'VIQ', assignment: 'Agent' },
    { id: 'VIQ-2', project: 'VIQ', assignment: 'Human' }
  ];
  assert.deepEqual(applyTicketFilters(tickets, new Set(['VIQ']), new Set(['Human','Agent'])).map((ticket) => ticket.id), ['VIQ-1','VIQ-2']);
  assert.deepEqual(applyTicketFilters(tickets, new Set(['VIQ']), new Set(['Human'])).map((ticket) => ticket.id), ['VIQ-2']);
});

test('filter chips expose accessible selected state and empty reset', async () => {
  const [html, app] = await Promise.all([readFile('web/index.html', 'utf8'), readFile('web/app.js', 'utf8')]);
  for (const id of ['project-chips', 'role-chips', 'reset-filters']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /aria-pressed/); assert.doesNotMatch(app, /contextmenu/); assert.match(`${html}${app}`, /No tickets match/);
});

test.skip('VIQ-13+ excluded: full history/archive/admin ticket mutation surface', { skip: 'VIQ-12 replacement coverage is browser-pairing E2E for board filters, movement, activity, and modal accessibility' }, async () => {
  const app = await readFile('web/app.js', 'utf8');
  for (const term of ['Edit ticket', 'Ticket title', 'Project', 'Assignee', 'State', 'Add progress', 'Archive', 'Restore', 'Delete ticket', 'Confirm delete']) assert.match(app, new RegExp(term));
  assert.match(app, /\/state/);
  assert.match(app, /\/notes/);
  assert.match(app, /include_archived=true/);
  assert.match(app, /event\.actor/);
  assert.match(app, /event\.created_at/);
  assert.match(app, /question_event_id/);
});

test('browser acceptance keeps full desktop coverage and a representative non-duplicative 390px smoke', async () => {
  const browser = await readFile('test/human-history-browser-e2e.js', 'utf8');
  const mobile = browser.slice(browser.indexOf('const mobile ='));
  assert.match(mobile, /width:\s*390/);
  assert.match(mobile, /mobile\.goto\(base\)/);
  assert.match(mobile, /documentElement\.scrollWidth\s*<=\s*document\.documentElement\.clientWidth/);
  for (const interaction of ["name: 'LIFE'", "name: 'Maks'", "name: 'Edit ticket'", "name: 'Add progress'", "selectOption('review')", "name: 'Archive'", "name: 'Restore'", "name: 'Delete ticket'", "getByLabel('Confirm delete').check"])
    assert.ok(mobile.includes(interaction), `missing mobile interaction: ${interaction}`);
});

test.skip('VIQ-14 excluded: nested question/approval modal flows', { skip: 'VIQ-12 modal focus restoration is covered behaviorally in browser-pairing E2E' }, async () => {
  const app = await readFile('web/app.js', 'utf8');
  assert.match(app, /modalStack/);
  assert.match(app, /restoreModal/);
  assert.match(app, /\.dismiss\(\)/);
});

test.skip('VIQ-13+ excluded: Admin/project/question full modal surface', { skip: 'VIQ-12 ticket create/summary modal focus is covered behaviorally in browser-pairing E2E' }, async () => {
  const [html, app] = await Promise.all([readFile('web/index.html', 'utf8'), readFile('web/app.js', 'utf8')]);
  assert.equal((html.match(/<dialog\b/g) || []).length, 1);
  for (const id of ['open-project-create', 'open-ticket-create', 'modal']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /createModalController/);
  assert.match(app, /openAnswer/);
  assert.match(app, /question-card[\s\S]*addEventListener\(['"]click/);
  assert.match(app, /ticket-question[\s\S]*addEventListener\(['"]click/);
});
