import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('bin/viq.js');

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-cli-'));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const app = spawn(process.execPath, ['src/server.js', `--port=${port}`, `--storage=${path.join(dir, 'data.json')}`, '--takeover-token=secret']);
  const url = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 100; tries += 1) {
    try { if ((await fetch(`${url}/health`)).ok) return { app, url }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  app.kill();
  throw new Error('server did not start');
}

function run(url, ...args) {
  return spawnSync(process.execPath, [cli, '--server', url, '--json', ...args], { encoding: 'utf8' });
}

test('built CLI emits one stable JSON document and useful exit codes', async (t) => {
  const { app, url } = await fixture();
  t.after(() => app.kill());

  const project = run(url, 'project', 'create', 'ABC');
  assert.equal(project.status, 0, project.stderr);
  assert.deepEqual(JSON.parse(project.stdout), { project: { key: 'ABC', next_number: 1 } });

  const ticket = run(url, 'ticket', 'create', 'ABC', 'CLI tracer');
  assert.equal(ticket.status, 0, ticket.stderr);
  assert.equal(JSON.parse(ticket.stdout).ticket.id, 'ABC-1');

  const claimed = run(url, 'ticket', 'claim', 'ABC-1', '--actor', 'worker-a', '--ttl-ms', '1000');
  assert.equal(claimed.status, 0, claimed.stderr);
  const claim = JSON.parse(claimed.stdout);
  const renewed = run(url, 'ticket', 'renew', 'ABC-1', '--actor', 'worker-a', '--claim-token', claim.claim_token,
    '--generation', '1', '--ttl-ms', '2000');
  assert.equal(renewed.status, 0, renewed.stderr);
  assert.equal(JSON.parse(renewed.stdout).ticket.claim.generation, 1);

  const missing = run(url, 'ticket', 'show', 'NOPE-1');
  assert.equal(missing.status, 4);
  assert.equal(missing.stdout, '');
  assert.equal(JSON.parse(missing.stderr).error.code, 'ticket_not_found');

  const usage = run(url, 'unknown');
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stderr).error.code, 'usage_error');
});
