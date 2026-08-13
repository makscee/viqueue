import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

test('public-source metadata and canonical Apache-2.0 license are consistent', () => {
  assert.equal(packageJson.license, 'Apache-2.0');
  assert.equal('private' in packageJson, false);
  assert.deepEqual(packageJson.files, ['bin', 'src', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs']);
  const license = readFileSync('LICENSE', 'utf8');
  assert.match(license, /^                                 Apache License\n                           Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(license, /APPENDIX: How to apply the Apache License to your work\./);
  assert.match(readFileSync('README.md', 'utf8'), /licensed under the \[Apache License 2\.0\]/);
});
