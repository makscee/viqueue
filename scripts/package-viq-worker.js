import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const output = path.resolve(process.argv[2] ?? 'release');
const git = (...args) => { const result = spawnSync('git', args, { encoding: args[0] === 'show' ? null : 'utf8' }); if (result.status !== 0) throw new Error(String(result.stderr || `git ${args.join(' ')} failed`)); return result.stdout; };
const commit = String(git('rev-parse', 'HEAD')).trim();
const tree = String(git('rev-parse', 'HEAD^{tree}')).trim();
if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) throw new Error('invalid source identity');
if (String(git('status', '--porcelain', '--untracked-files=normal')).trim()) throw new Error('refusing to package a dirty source tree');
const work = await mkdtemp(path.join(tmpdir(), 'viq-worker-package-'));
const name = `viq-worker-${commit}`;
const stage = path.join(work, name);
try {
  await mkdir(path.join(stage, 'extensions', 'viq-worker'), { recursive: true });
  for (const file of ['package.json', 'extensions/viq-worker/index.ts', 'extensions/viq-worker/worker-runtime.mjs', 'extensions/viq-worker/credential-store.mjs', 'extensions/viq-worker/command.mjs']) {
    await writeFile(path.join(stage, file), git('show', `HEAD:${file}`));
  }
  await writeFile(path.join(stage, 'SOURCE_COMMIT'), `${commit}\n`);
  await writeFile(path.join(stage, 'SOURCE_TREE'), `${tree}\n`);
  await mkdir(output, { recursive: true });
  const archive = path.join(output, `${name}.tar.gz`);
  const tar = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', work, name], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(tar.stderr || 'tar failed');
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  process.stdout.write(`${JSON.stringify({ archive, sha256: digest, commit, tree })}\n`);
} finally { await rm(work, { recursive: true, force: true }); }
