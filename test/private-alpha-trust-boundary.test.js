import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
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
  const [adr, security, server, mcp, app] = await Promise.all([
    readFile('docs/adr-0012-pairing-poc.md', 'utf8'),
    readFile('SECURITY.md', 'utf8'),
    readFile('src/server.js', 'utf8'),
    readFile('src/mcp-server.js', 'utf8'),
    readFile('web/app.js', 'utf8')
  ]);
  assert.match(adr, /Status: accepted for private PoC/);
  for (const boundary of [/one-time device pairing/i, /fixed `coordinator` or `worker`/i, /Roles grant no API permissions/i, /Every claim ingress uses the same predicate/i, /No generic IAM graph/i]) assert.match(adr, boundary);
  assert.match(security, /Pairing PoC boundary/);
  assert.match(server, /authenticateDevice\(bearer\(request\)\)/);
  assert.match(server, /requireKind\(device, 'coordinator'\)/);
  assert.doesNotMatch(mcp, /claim_token|ticket_claim|claim_verify|claim_release/);
  await assert.rejects(access('src/phone-gateway.js'));
  await assert.rejects(access('src/phone-auth-store.js'));
  assert.match(app, /localStorage\.getItem\('viq\.deviceCredential'/);
});

test('agent progress fails closed without the complete current claim identity', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-trust-'));
  const store = new Store(path.join(dir, 'data.sqlite'));
  await store.init();
  await store.createProject('ABC');
  await store.createActor({ id: 'worker', name: 'Worker', kind: 'agent' });
  await store.createActor({ id: 'coord', name: 'Coordinator', kind: 'human' });
  await store.bootstrapCoordinator({ id: 'coord', name: 'Coordinator' });
  const pairing = await store.createPairingCode('coord', { intended_kind: 'worker' });
  await store.pairDevice({ code: pairing.code, id: 'worker', name: 'Worker' });
  const ticket = await store.createTicket({ project: 'ABC', title: 'Claim boundary', actor: 'coord', assignee: { type: 'device', id: 'worker' } });
  const claim = await store.claim(ticket.id, { actor: 'worker' });
  await assert.rejects(store.postEvent(ticket.id, { actor: 'worker', message: 'unfenced' }), (error) => error.code === 'stale_claim');
  await assert.rejects(store.postEvent(ticket.id, { ...claimIdentity(claim), claim_token: 'wrong', message: 'wrong token' }), (error) => error.code === 'stale_claim');
  assert.equal((await store.postEvent(ticket.id, { ...claimIdentity(claim), message: 'authorized' })).event.actor, 'worker');
  await store.close();
});
