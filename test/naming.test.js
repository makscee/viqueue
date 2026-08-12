import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('canonical project name is lowercase everywhere in repository content', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const forbidden = ['Vi', 'Queue'].join('');
  const matches = files.filter((file) => readFileSync(file).includes(forbidden));
  assert.deepEqual(matches, [], `incorrect capitalized project name in: ${matches.join(', ')}`);
});
