import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const privateOrigins = ['cc-worker.twin-pogona.ts.net'];
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

function shippedFiles(entry) {
  if (!statSync(entry).isDirectory()) return [entry];
  return readdirSync(entry, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? shippedFiles(path.join(entry, item.name))
    : [path.join(entry, item.name)]);
}

test('shipped runtime and current documentation contain no known private deployment origin', () => {
  const files = ['package.json', ...packageJson.files.flatMap(entry => shippedFiles(entry))];
  for (const file of files) {
    const contents = readFileSync(file, 'utf8');
    for (const origin of privateOrigins) assert.equal(contents.includes(origin), false, `${file} contains ${origin}`);
  }
});

test('Tailscale tracer requires an explicit valid HTTPS origin', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, ['bin/viq-trace-tailscale-upstream.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, VIQ_TAILSCALE_UPSTREAM_ORIGIN: '', ...env },
    timeout: 5000
  });

  const absent = run([]);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /--origin|VIQ_TAILSCALE_UPSTREAM_ORIGIN/);
  assert.match(absent.stderr, /Usage:/);

  const invalid = run(['--origin=http://example.test']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /HTTPS origin/);
});
