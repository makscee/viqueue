import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

test('public-source metadata and canonical Apache-2.0 license are consistent', () => {
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.deepEqual(packageJson.repository, { type: 'git', url: 'git+https://github.com/makscee/viqueue.git' });
  assert.equal(packageJson.homepage, 'https://github.com/makscee/viqueue#readme');
  assert.deepEqual(packageJson.bugs, { url: 'https://github.com/makscee/viqueue/issues' });
  assert.equal('private' in packageJson, false);
  assert.deepEqual(packageJson.files, ['bin', 'src', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs', 'release-notes']);
  const license = readFileSync('LICENSE');
  assert.equal(createHash('sha256').update(license).digest('hex'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.match(readFileSync('README.md', 'utf8'), /licensed under the \[Apache License 2\.0\]/);
  assert.match(readFileSync('SECURITY.md', 'utf8'), /private vulnerability reporting/);
  assert.match(readFileSync('release-notes/v0.4.1.md', 'utf8'), /prerelease/i);
  assert.equal(readFileSync('.github/workflows/ci.yml', 'utf8').includes('publish'), false);
});

test('packed npm gateway bin is directly executable by Node', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'viq-pack-bin-'));
  const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { encoding: 'utf8' }));
  const archive = path.join(work, pack[0].filename);
  execFileSync('npm', ['install', '--ignore-scripts', '--prefix', work, archive], { stdio: 'pipe' });
  const launcher = path.join(work, 'node_modules', '.bin', 'viqueue-phone-gateway');
  assert.match(readFileSync(path.join(work, 'node_modules', 'viqueue', 'src', 'phone-gateway.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const result = spawnSync(launcher, [], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /import: not found|Syntax error/);
  assert.match(result.stderr, /node:internal|TypeError|ERR_INVALID_ARG_TYPE/);
  const help = spawnSync(launcher, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--upstream-address-policy=tailscale/);
  const tracer = path.join(work, 'node_modules', '.bin', 'viq-trace-tailscale-upstream');
  assert.match(readFileSync(tracer, 'utf8'), /^#!\/usr\/bin\/env node/);
});
