import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const payload = [
  'bin', 'src', 'web', 'docs', 'release-notes', 'extensions',
  'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'
];

async function packagedRelease(work, name, releaseId) {
  const bundle = path.join(work, name);
  await mkdir(bundle);
  for (const entry of payload) await cp(path.resolve(entry), path.join(bundle, entry), { recursive: true });
  await cp(path.resolve('scripts/install-local.sh'), path.join(bundle, 'install-local.sh'));
  await cp(path.resolve('scripts/rollback-local.sh'), path.join(bundle, 'rollback-local.sh'));
  await writeFile(path.join(bundle, 'SOURCE_COMMIT'), `${releaseId}\n`);
  return bundle;
}

function run(script, cwd, prefix) {
  return spawnSync('bash', [path.join(cwd, script)], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: path.dirname(prefix), VIQ_PREFIX: prefix }
  });
}

async function assertMissing(target) {
  await assert.rejects(lstat(target), error => error.code === 'ENOENT');
}

async function assertPointer(pointer, target) {
  assert.equal((await lstat(pointer)).isSymbolicLink(), true);
  assert.equal(await realpath(pointer), await realpath(target));
}

test('packaged local scripts atomically rotate release pointers across install and rollback', async t => {
  const work = await mkdtemp(path.join(tmpdir(), 'viq-local-pointer-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const prefix = path.join(work, 'prefix');
  const releaseAId = 'a'.repeat(40);
  const releaseBId = 'b'.repeat(40);
  const bundleA = await packagedRelease(work, 'bundle-a', releaseAId);
  const bundleB = await packagedRelease(work, 'bundle-b', releaseBId);
  const root = path.join(prefix, 'lib', 'viqueue');
  const releaseA = path.join(root, 'releases', releaseAId);
  const releaseB = path.join(root, 'releases', releaseBId);

  for (const bundle of [bundleA, bundleB]) {
    const result = run('install-local.sh', bundle, prefix);
    assert.equal(result.status, 0, result.stderr);
  }
  await assertPointer(path.join(root, 'current'), releaseB);
  await assertPointer(path.join(root, 'previous'), releaseA);
  await assertMissing(path.join(root, 'current.tmp'));
  await assertMissing(path.join(root, 'previous.tmp'));

  const rollback = run('rollback-local.sh', bundleB, prefix);
  assert.equal(rollback.status, 0, rollback.stderr);
  await assertPointer(path.join(root, 'current'), releaseA);
  await assertPointer(path.join(root, 'previous'), releaseB);
  await assertMissing(path.join(root, 'current.tmp'));
  await assertMissing(path.join(root, 'previous.tmp'));
});
