import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const signatures = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['aws_access_key', /AKIA[0-9A-Z]{16}/g],
  ['github_token', /(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})/g],
  ['openai_key', /sk-[A-Za-z0-9]{20,}/g],
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['google_api_key', /AIza[0-9A-Za-z_-]{35}/g]
];
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const findings = [];
for (const file of files) {
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const [kind, pattern] of signatures) if (pattern.test(text)) findings.push({ scope: 'tree', file, kind });
}
const history = execFileSync('git', ['log', '-p', '--all', '--no-ext-diff'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
for (const [kind, pattern] of signatures) if (pattern.test(history)) findings.push({ scope: 'history', kind });
if (findings.length) {
  for (const finding of findings) console.error(`potential ${finding.kind} in ${finding.scope}${finding.file ? ` file ${finding.file}` : ''}`);
  process.exit(1);
}
console.log(`secret scan passed: ${files.length} tracked/untracked proposed source files and unchanged git patch history; 0 high-confidence matches`);
console.log('targeted credential/artifact review is a separate evidence check');
