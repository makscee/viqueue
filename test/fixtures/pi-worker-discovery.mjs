import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const release = path.resolve(process.argv[2] ?? '');
assert.equal(process.getuid?.(), Number(process.env.VIQ_WORKER_UID));
assert.equal(process.getgid?.(), Number(process.env.VIQ_WORKER_GID));
const child = spawn('pi', ['--mode', 'rpc', '--no-session', '--no-tools', '--extension', path.join(release, 'extensions/viq-worker/index.ts')], {
  cwd: process.cwd(),
  env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const decoder = new StringDecoder('utf8');
let buffered = '';
const response = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('rpc timeout')), 10000);
  child.stdout.on('data', (chunk) => {
    buffered += decoder.write(chunk);
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/, ''); buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === 'response' && event.id === 'commands') { clearTimeout(timer); resolve(event); }
    }
  });
});
try {
  child.stdin.write(`${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n`);
  const event = await response;
  assert.equal(event.success, true);
  assert.ok(event.data.commands.some((command) => command.name === 'viq-worker' && command.source === 'extension'));
  process.stdout.write('PI_WORKER_COMMAND_DISCOVERED\n');
} catch {
  process.stderr.write('PI_WORKER_DISCOVERY_FAIL\n');
  process.exitCode = 1;
} finally {
  child.stdin.end();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timer = setTimeout(() => child.kill('SIGTERM'), 2000);
  await exited;
  clearTimeout(timer);
}
