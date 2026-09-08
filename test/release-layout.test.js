import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyBuiltReleaseOutputs, releaseNameFor } from '../scripts/release-layout.js';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

test('release name is derived from package metadata', () => {
  assert.equal(releaseNameFor({ version: '9.8.7' }), 'viqueue-v9.8.7-rc');
  assert.equal(releaseNameFor(packageJson), 'viqueue-v0.5.3-rc');
});

test('release staging copies every built bin and src output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'viq-release-layout-'));
  try {
    const dist = path.join(root, 'dist');
    const stage = path.join(root, 'stage');
    await mkdir(path.join(dist, 'bin', 'nested'), { recursive: true });
    await mkdir(path.join(dist, 'src', 'nested'), { recursive: true });
    await mkdir(stage);
    await writeFile(path.join(dist, 'bin', 'command.js'), 'command');
    await writeFile(path.join(dist, 'bin', 'nested', 'helper.js'), 'bin helper');
    await writeFile(path.join(dist, 'src', 'server.js'), 'server');
    await writeFile(path.join(dist, 'src', 'nested', 'helper.js'), 'src helper');
    await writeFile(path.join(dist, 'package.json'), '{"version":"test"}\n');

    await copyBuiltReleaseOutputs(dist, stage);

    assert.equal(await readFile(path.join(stage, 'bin', 'command.js'), 'utf8'), 'command');
    assert.equal(await readFile(path.join(stage, 'bin', 'nested', 'helper.js'), 'utf8'), 'bin helper');
    assert.equal(await readFile(path.join(stage, 'src', 'server.js'), 'utf8'), 'server');
    assert.equal(await readFile(path.join(stage, 'src', 'nested', 'helper.js'), 'utf8'), 'src helper');
    assert.equal(await readFile(path.join(stage, 'package.json'), 'utf8'), '{"version":"test"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
