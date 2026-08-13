import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/server.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-board-http-'));
  let now = 1_700_000_000_000;
  const app = await createApp({ storage: path.join(dir, 'data.json'), takeoverToken: 'secret', now: () => now });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return { app, base: `http://127.0.0.1:${app.address().port}`, advance: (ms) => { now += ms; } };
}

async function json(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('project discovery and project ticket listing are truthful projections', async (t) => {
  const { app, base, advance } = await fixture();
  t.after(() => app.close());
  await json(base, 'POST', '/v1/projects', { key: 'XYZ' });
  await json(base, 'POST', '/v1/projects', { key: 'ABC' });
  await json(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'ready item' });
  await json(base, 'POST', '/v1/tickets', { project: 'ABC', title: 'stale item' });
  await json(base, 'POST', '/v1/tickets', { project: 'XYZ', title: 'other project' });
  await json(base, 'POST', '/v1/tickets/ABC-2/claim', { actor: 'worker-a', ttl_ms: 100 });
  advance(101);

  assert.deepEqual(await json(base, 'GET', '/v1/projects'), {
    status: 200, body: { projects: [{ key: 'ABC', next_number: 3 }, { key: 'XYZ', next_number: 2 }] }
  });
  const listing = await json(base, 'GET', '/v1/projects/ABC/tickets');
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.tickets.map(({ id, state }) => ({ id, state })), [
    { id: 'ABC-1', state: 'ready' }, { id: 'ABC-2', state: 'stale' }
  ]);
  assert.equal(listing.body.tickets[1].claim.actor, 'worker-a');
  assert.equal('token' in listing.body.tickets[1].claim, false);
});

test('board assets are served by the same server with usable semantics', async (t) => {
  const { app, base } = await fixture();
  t.after(() => app.close());
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<h1>viqueue<\/h1>/);
  assert.match(html, /<main/);
  assert.match(html, /aria-live=/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /Take over stale claim/);
  assert.doesNotMatch(html, /onclick=/);

  const css = await fetch(`${base}/app.css`);
  assert.equal(css.status, 200);
  const styles = await css.text();
  assert.match(styles, /@media.*max-width/s);
  assert.match(styles, /\.state-tabs/);
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
});
