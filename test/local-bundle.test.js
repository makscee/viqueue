import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function port() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise((resolve) => server.close(resolve)); return value;
}

test('local release bundle installs, runs all surfaces, preserves data, and uninstalls', async (t) => {
  execFileSync('npm', ['run', 'bundle'], { stdio: 'pipe' });
  const bundleFiles = execFileSync('tar', ['-tzf', 'release/viqueue-local-rc.tar.gz'], { encoding: 'utf8' }).trim().split('\n');
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/adr-0006-apache-public-source-preparation.md']) {
    assert.ok(bundleFiles.includes(`viqueue-local-rc/${file}`), `${file} missing from bundle`);
  }
  assert.equal(bundleFiles.includes('viqueue-local-rc/NOTICE'), false);
  const work = await mkdtemp(path.join(tmpdir(), 'viq-bundle-'));
  const extracted = path.join(work, 'extracted'); const prefix = path.join(work, 'prefix');
  execFileSync('mkdir', ['-p', extracted]);
  execFileSync('tar', ['-xzf', 'release/viqueue-local-rc.tar.gz', '-C', extracted]);
  const bundle = path.join(extracted, 'viqueue-local-rc');
  execFileSync('bash', [path.join(bundle, 'install-local.sh')], { cwd: bundle, env: { ...process.env, VIQ_PREFIX: prefix } });

  const listen = await port(); const storage = path.join(work, 'data', 'viqueue.json');
  const server = spawn(path.join(prefix, 'bin', 'viqueue-server'), [`--port=${listen}`, `--storage=${storage}`, '--takeover-token=secret']);
  t.after(() => server.kill()); const base = `http://127.0.0.1:${listen}`;
  for (let tries = 0; tries < 100; tries += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal((await fetch(base)).status, 200);
  assert.match(await readFile(path.join(prefix, 'lib', 'viqueue', 'LICENSE'), 'utf8'), /Apache License\n                           Version 2\.0/);
  assert.equal(JSON.parse(await readFile(path.join(prefix, 'lib', 'viqueue', 'package.json'), 'utf8')).license, 'Apache-2.0');

  const viq = (...args) => spawnSync(path.join(prefix, 'bin', 'viq'), ['--server', base, '--json', ...args], { encoding: 'utf8' });
  assert.equal(viq('project', 'create', 'ABC').status, 0);
  assert.equal(JSON.parse(viq('ticket', 'create', 'ABC', 'installed tracer').stdout).ticket.id, 'ABC-1');
  assert.equal(JSON.parse(await readFile(storage, 'utf8')).tickets['ABC-1'].title, 'installed tracer');

  const mcp = spawnSync(path.join(prefix, 'bin', 'viqueue-mcp'), [], {
    encoding: 'utf8', env: { ...process.env, VIQ_SERVER: base },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bundle-test', version: '1' } } })}\n`
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).result.serverInfo.name, 'viqueue');

  server.kill();
  execFileSync('bash', [path.join(bundle, 'uninstall-local.sh')], { env: { ...process.env, VIQ_PREFIX: prefix } });
  assert.equal(spawnSync(path.join(prefix, 'bin', 'viq')).error?.code, 'ENOENT');
  assert.equal(JSON.parse(await readFile(storage, 'utf8')).tickets['ABC-1'].id, 'ABC-1');
});
