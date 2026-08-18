import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createModalController, renderMarkdown } from '../web/ui-core.js';

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

test('ticket, question, project, and ticket-create flows share one modal shell', async () => {
  const [html, app] = await Promise.all([readFile('web/index.html', 'utf8'), readFile('web/app.js', 'utf8')]);
  assert.equal((html.match(/<dialog\b/g) || []).length, 1);
  for (const id of ['open-project-create', 'open-ticket-create', 'modal']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /createModalController/);
  assert.match(app, /openAnswer/);
  assert.match(app, /question-card[\s\S]*addEventListener\(['"]click/);
  assert.match(app, /ticket-question[\s\S]*addEventListener\(['"]click/);
});
