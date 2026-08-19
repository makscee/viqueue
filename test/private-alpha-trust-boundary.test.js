import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Store } from '../src/store.js';

const claimIdentity = (claim) => ({
  claim_id: claim.ticket.claim.claim_id,
  actor: claim.ticket.claim.actor,
  generation: claim.ticket.claim.generation,
  claim_token: claim.claim_token
});

test('accepted private-alpha trust boundary is explicit and mapped to enforced implementation seams', async () => {
  const [adr, security, server, gateway, authStore, app] = await Promise.all([
    readFile('docs/adr-0011-private-alpha-trust-boundaries.md', 'utf8'),
    readFile('SECURITY.md', 'utf8'),
    readFile('src/server.js', 'utf8'),
    readFile('src/phone-gateway.js', 'utf8'),
    readFile('src/phone-auth-store.js', 'utf8'),
    readFile('web/app.js', 'utf8')
  ]);
  assert.match(adr, /Status: accepted for private alpha/);
  for (const boundary of [/active paired browser devices[\s\S]*access boundary/i, /actor selector[\s\S]*workflow identity/i, /core listener defaults to loopback/i, /Agent mutations are authorized by the current claim/i, /no IAM layer/i]) assert.match(adr, boundary);
  assert.match(security, /accepted private-alpha boundaries, not IAM/);
  assert.match(server, /host = '127\.0\.0\.1'/);
  assert.match(gateway, /s\.listen\(port,'127\.0\.0\.1'/);
  assert.match(authStore, /DROP INDEX IF EXISTS one_active_device/);
  assert.match(app, /localStorage\.setItem\('viq\.actor'/);
});

test('agent progress fails closed without the complete current claim identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-trust-'));
  const store = new Store(path.join(dir, 'data.sqlite'));
  await store.init();
  await store.createProject('ABC');
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' });
  const ticket = await store.createTicket({ project: 'ABC', title: 'Claim boundary' });
  const claim = await store.claim(ticket.id, { actor: 'worker' });
  await assert.rejects(store.postEvent(ticket.id, { actor: 'worker', message: 'unfenced' }), (error) => error.code === 'stale_claim');
  await assert.rejects(store.postEvent(ticket.id, { ...claimIdentity(claim), claim_token: 'wrong', message: 'wrong token' }), (error) => error.code === 'stale_claim');
  assert.equal((await store.postEvent(ticket.id, { ...claimIdentity(claim), message: 'authorized' })).event.actor, 'worker');
  await store.close();
});
