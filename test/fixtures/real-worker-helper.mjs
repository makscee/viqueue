import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.getuid?.(), Number(process.env.VIQ_WORKER_UID), 'worker rehearsal must run as the real viq-worker uid');
assert.equal(process.getgid?.(), Number(process.env.VIQ_WORKER_GID), 'worker rehearsal must run as the real viq-worker gid');
const release = process.argv[2];
const manifest = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(path.join(release, 'package.json'), 'utf8')));
assert.deepEqual(manifest.pi.extensions, ['./extensions/viq-worker/index.ts']);
const { ViqWorkerRuntime } = await import(pathToFileURL(path.join(release, 'extensions/viq-worker/worker-runtime.mjs')));
const { saveCredential, defaultCredentialPath } = await import(pathToFileURL(path.join(release, 'extensions/viq-worker/credential-store.mjs')));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const code = (await iterator.next()).value;
let credential;
let prompt = '';
const runtime = new ViqWorkerRuntime({ baseUrl: process.env.VIQ_URL, pollMs: 60000, deliver: async (value) => { prompt = value; } });
const paired = await runtime.pair({ code, id: 'real-worker', name: 'Real Worker' });
credential = paired.credential;
saveCredential(credential);
assert.equal((await stat(defaultCredentialPath())).mode & 0o777, 0o600);
for (const [method, route, body] of [
  ['POST', '/v1/pairing-codes', { intended_kind: 'worker' }],
  ['POST', '/v1/roles', { id: 'denied', name: 'Denied' }],
  ['PUT', '/v1/devices/real-worker/roles/denied', {}],
  ['DELETE', '/v1/devices/real-worker/roles/denied', {}],
  ['POST', '/v1/tickets/NO-1/questions/q_missing/answer', { answer: 'no' }],
  ['POST', '/v1/tickets/NO-1/blocks/b_missing/resolve', {}],
]) {
  const response = await fetch(`${process.env.VIQ_URL}${route}`, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 403, `${method} ${route}`);
  assert.match((await response.json()).error.code, /coordinator_required/);
}
process.stdout.write('PAIRED_AND_DENIED\n');
assert.equal((await iterator.next()).value, 'start');
await runtime.start({ project: 'DOG' });
assert.ok(prompt.includes('DOG-1'));
assert.ok(!prompt.includes(credential));
assert.ok(!prompt.includes('claim_token'));
process.stdout.write('CLAIMED\n');
await runtime.progress('real worker progress');
await runtime.question('May I continue?');
await runtime.block('Needs coordinator resolution');
process.stdout.write('BLOCKED\n');
assert.equal((await iterator.next()).value, 'resume');
runtime.resume();
await runtime.submit('real worker lifecycle complete');
process.stdout.write('SUBMITTED\n');
await runtime.shutdown();
