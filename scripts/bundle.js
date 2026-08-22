import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('release');
const releaseName = `viqueue-v${JSON.parse(await readFile('package.json', 'utf8')).version}-rc`;
const stage = path.join(root, releaseName);
const archive = path.join(root, `${releaseName}.tar.gz`);
await rm(root, { recursive: true, force: true });
await mkdir(path.join(stage, 'bin'), { recursive: true });
await mkdir(path.join(stage, 'src'), { recursive: true });
await mkdir(path.join(stage, 'web'), { recursive: true });
await mkdir(path.join(stage, 'docs'), { recursive: true });
await mkdir(path.join(stage, 'extensions'), { recursive: true });
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
if (status.status !== 0) throw new Error(status.stderr || 'cannot inspect source tree');
if (status.stdout.trim()) throw new Error('refusing to bundle a dirty source tree');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' });
if (revision.status !== 0 || tree.status !== 0 || !/^[0-9a-f]{40}\n?$/.test(revision.stdout) || !/^[0-9a-f]{40}\n?$/.test(tree.stdout)) throw new Error(revision.stderr || tree.stderr || 'cannot determine source identity');
await writeFile(path.join(stage, 'SOURCE_COMMIT'), `${revision.stdout.trim()}\n`);
await writeFile(path.join(stage, 'SOURCE_TREE'), `${tree.stdout.trim()}\n`);
for (const file of ['bin/viq.js', 'bin/viq-bootstrap.js', 'bin/viq-import.js', 'src/server.js', 'src/store.js', 'src/http-client.js', 'src/mcp-server.js', 'package.json']) {
  await cp(path.join('dist', file), path.join(stage, file));
}
await cp('dist/web', path.join(stage, 'web'), { recursive: true });
await cp('dist/extensions', path.join(stage, 'extensions'), { recursive: true });
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
  await cp(file, path.join(stage, file));
}
await cp('docs', path.join(stage, 'docs'), { recursive: true });
await cp('release-notes', path.join(stage, 'release-notes'), { recursive: true });
await cp('scripts/install-local.sh', path.join(stage, 'install-local.sh'));
await cp('scripts/uninstall-local.sh', path.join(stage, 'uninstall-local.sh'));
await cp('scripts/rollback-local.sh', path.join(stage, 'rollback-local.sh'));
await cp('scripts/sqlite-backup.js', path.join(stage, 'sqlite-backup.js'));
await chmod(path.join(stage, 'install-local.sh'), 0o755);
await chmod(path.join(stage, 'uninstall-local.sh'), 0o755);
await chmod(path.join(stage, 'rollback-local.sh'), 0o755);
await chmod(path.join(stage, 'sqlite-backup.js'), 0o755);
const result = spawnSync('tar', [
  '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
  '-czf', archive, '-C', root, releaseName
], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
console.log(`built ${archive}`);
console.log(`sha256 ${digest}`);
