import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const previous = '1398284ed89a6cf9395f129483f709e63c009286';
const candidate = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const run = (file, args, root) => spawnSync('bash', [file, ...args], { cwd: process.cwd(), env: { ...process.env, VIQ_WORKER_ROOT: root }, encoding: 'utf8' });

test('worker install atomically switches an immutable exact release and rolls back to 1398284e', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'viq-worker-install-')); const root = path.join(work, 'root'); const old = path.join(root, 'releases', previous); await mkdir(old, { recursive: true }); await writeFile(path.join(old, 'SOURCE_COMMIT'), `${previous}\n`); await chmod(old, 0o555); await import('node:fs/promises').then((fs) => fs.symlink(old, path.join(root, 'current')));
  const packageRoot = path.join(work, `viq-worker-${candidate}`); await mkdir(path.join(packageRoot, 'extensions', 'viq-worker'), { recursive: true });
  await writeFile(path.join(packageRoot, 'SOURCE_COMMIT'), `${candidate}\n`); await writeFile(path.join(packageRoot, 'SOURCE_TREE'), `${'b'.repeat(40)}\n`); await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ pi: { extensions: ['./extensions/viq-worker/index.ts'] } }));
  for (const file of ['index.ts', 'worker-runtime.mjs', 'credential-store.mjs']) await writeFile(path.join(packageRoot, 'extensions', 'viq-worker', file), 'export {};\n');
  const archive = path.join(work, 'worker.tar.gz'); const tar = spawnSync('tar', ['-czf', archive, '-C', work, path.basename(packageRoot)], { encoding: 'utf8' }); assert.equal(tar.status, 0, tar.stderr);
  const install = run('scripts/install-viq-worker.sh', [archive, candidate, previous], root); assert.equal(install.status, 0, install.stderr); assert.equal(await readlink(path.join(root, 'current')), path.join(root, 'releases', candidate)); assert.equal((await stat(path.join(root, 'releases', candidate))).mode & 0o222, 0); assert.equal((await readFile(path.join(root, 'PREVIOUS_COMMIT'), 'utf8')).trim(), previous);
  const rollback = run('scripts/rollback-viq-worker.sh', [candidate, previous], root); assert.equal(rollback.status, 0, rollback.stderr); assert.equal(await readlink(path.join(root, 'current')), old);
  const stale = run('scripts/install-viq-worker.sh', [archive, candidate, '1111111111111111111111111111111111111111'], root); assert.notEqual(stale.status, 0); assert.equal(await readlink(path.join(root, 'current')), old);
});
