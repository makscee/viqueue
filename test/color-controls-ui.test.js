import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rgb = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16));
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (first, second) => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
};
const declaration = (css, selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([^}]*)\\}`))?.[1] ?? '';
const property = (block, name) => block.match(new RegExp(`(?:^|;)${name}:([^;}]*)`))?.[1]?.trim();
const token = (css, name) => property(declaration(css, ':root'), name);

test('ticket card action is neutral so identity and metadata render with AA text contrast', async () => {
  const css = await readFile('web/app.css', 'utf8');
  const action = declaration(css, '.ticket-open');
  assert.equal(property(action, 'background'), 'transparent');
  assert.equal(property(action, 'color'), 'var(--ink)');
  assert.ok(contrast(token(css, '--muted'), token(css, '--panel')) >= 4.5, 'ticket metadata must meet WCAG AA on the card surface');
});

test('meaningful control boundaries and links pass contrast or use a distinct filled state', async () => {
  const css = await readFile('web/app.css', 'utf8');
  assert.ok(contrast(token(css, '--control-edge'), token(css, '--panel')) >= 3, 'input boundary must reach 3:1');
  assert.ok(contrast(token(css, '--edge'), token(css, '--lane')) >= 3, 'surface boundary must reach 3:1');
  assert.ok(contrast(token(css, '--link'), token(css, '--panel')) >= 4.5, 'link text must reach AA');
  const selected = declaration(css, '.filter-chip[aria-pressed=true]');
  assert.equal(property(selected, 'background'), 'var(--accent)');
  assert.equal(property(selected, 'color'), 'var(--accent-ink)');
  assert.match(css, /\.filter-chip\[aria-pressed=true\] \.selection-mark\{display:inline/);
});

test('Human and Agent pairing choices are compact semantic segmented controls', async () => {
  const [css, app] = await Promise.all([readFile('web/app.css', 'utf8'), readFile('web/app.js', 'utf8')]);
  assert.match(app, /class="role-selector"/);
  assert.match(app, /class="role-choice"/);
  assert.match(app, /class="role-choice-label"><span class="role-choice-check" aria-hidden="true">✓<\/span>Human/);
  assert.match(app, /class="role-choice-label"><span class="role-choice-check" aria-hidden="true">✓<\/span>Agent/);
  assert.match(css, /input\[type=radio\],input\[type=checkbox\]\{[^}]*min-height:0/);
  assert.match(css, /\.role-choice input:checked\+\.role-choice-label\{/);
  assert.match(css, /\.role-choice input:checked\+\.role-choice-label \.role-choice-check\{display:inline/);
});

test('focus, invalid, disabled, and hover states remain visually explicit', async () => {
  const css = await readFile('web/app.css', 'utf8');
  assert.match(css, /:user-invalid/);
  assert.match(css, /button:disabled\{[^}]*opacity:[.]55/);
  assert.match(css, /\.filter-chip:hover:not\(\[aria-pressed=true\]\)/);
  assert.match(css, /\.role-choice:hover/);
});
