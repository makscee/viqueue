import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

test('public-source metadata and canonical Apache-2.0 license are consistent', () => {
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.deepEqual(packageJson.repository, { type: 'git', url: 'git+https://github.com/makscee/viqueue.git' });
  assert.equal(packageJson.homepage, 'https://github.com/makscee/viqueue#readme');
  assert.deepEqual(packageJson.bugs, { url: 'https://github.com/makscee/viqueue/issues' });
  assert.equal('private' in packageJson, false);
  assert.deepEqual(packageJson.files, ['bin', 'src', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs', 'release-notes', 'extensions']);
  const license = readFileSync('LICENSE');
  assert.equal(createHash('sha256').update(license).digest('hex'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.match(readFileSync('README.md', 'utf8'), /licensed under the \[Apache License 2\.0\]/);
  assert.match(readFileSync('SECURITY.md', 'utf8'), /private vulnerability reporting/);
  assert.match(readFileSync('release-notes/v0.4.1.md', 'utf8'), /prerelease/i);
  assert.equal(readFileSync('.github/workflows/ci.yml', 'utf8').includes('publish'), false);
});

test('packed npm surface includes the signed phone gateway and its operator CLIs', () => {
  const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--dry-run'], { encoding: 'utf8' }))[0];
  const names = new Set(pack.files.map((file) => file.path));
  for (const name of ['src/phone-auth-store.js', 'src/phone-gateway.js', 'web/phone-bootstrap.js', 'web/phone-index.html', 'bin/viq-phone-auth.js', 'bin/viq-trace-tailscale-upstream.js']) assert.equal(names.has(name), true, name);
  assert.equal(packageJson.bin['viq-phone-auth'], 'bin/viq-phone-auth.js');
  assert.equal(packageJson.bin['viqueue-phone-gateway'], 'src/phone-gateway.js');
});
