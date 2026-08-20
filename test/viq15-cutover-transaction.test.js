import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const lib = join(root, 'scripts/viq15-cutover/transaction-lib.sh');
const restore = join(root, 'scripts/viq15-cutover/sqlite-family-restore.sh');
const applyScript = join(root, 'scripts/viq15-cutover/apply.sh');
const tmpRoot = process.env.TMPDIR;
if (!tmpRoot) throw new Error('TMPDIR is required for isolated cutover fixtures');

function run(command, args = [], options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options });
}

async function makeDb(file, value = 'sealed') {
  const result = run(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('CREATE TABLE proof(value TEXT NOT NULL)');
    db.prepare('INSERT INTO proof VALUES (?)').run(process.argv[2]);
    db.close();
  `, file, value]);
  assert.equal(result.status, 0, result.stderr);
}

function dbValue(file) {
  const result = run(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    process.stdout.write(db.prepare('SELECT value FROM proof').get().value);
    db.close();
  `, file]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('shared exclusion rejects apply contention and queued rollback acquires after release', async () => {
  const fixture = await mkdtemp(join(tmpRoot, 'viq15-lock-'));
  const lock = join(fixture, 'transaction.lock');
  const env = { ...process.env, VIQ15_LOCK_PATH: lock };
  const holder = spawn('bash', ['-c', `source "$1"; viq15_lock exclusive 9; echo HELD; read -r _`, 'bash', lib], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const holderExit = once(holder, 'exit');
  const holderLines = createInterface({ input: holder.stdout });
  assert.deepEqual(await once(holderLines, 'line'), ['HELD']);

  const contender = run('bash', ['-c', `source "$1"; viq15_lock exclusive 9`, 'bash', lib], { env });
  assert.equal(contender.status, 75);
  assert.match(contender.stderr, /transaction lock held/);

  const waiter = spawn('bash', ['-c', `source "$1"; echo QUEUED; viq15_lock wait 8; echo ACQUIRED`, 'bash', lib], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const waiterExit = once(waiter, 'exit');
  const waiterLines = createInterface({ input: waiter.stdout });
  assert.deepEqual(await once(waiterLines, 'line'), ['QUEUED']);
  const acquired = once(waiterLines, 'line');
  holder.stdin.end('\n');
  assert.deepEqual(await holderExit, [0, null]);
  assert.deepEqual(await acquired, ['ACQUIRED']);
  assert.deepEqual(await waiterExit, [0, null]);
});

test('automatic rollback lock wait cannot be killed by systemd start timeout', async () => {
  const source = await readFile(applyScript, 'utf8');
  assert.match(source, /Type=oneshot\n(?:#[^\n]*\n)*TimeoutStartSec=infinity\nExecStart=.*rollback\.sh automatic-timeout/);
});

test('deadline is sealed as canonical absolute UTC and timer readback is calendar-persistent', async () => {
  const fixture = await mkdtemp(join(tmpRoot, 'viq15-deadline-'));
  const timer = join(fixture, 'rollback.timer');
  const env = { ...process.env, VIQ15_NOW_UTC: '2026-08-20 12:34:56 UTC' };
  const create = run('bash', ['-c', `source "$1"; d=$(viq15_deadline_create "$2"); viq15_timer_write "$3" "$d"; viq15_timer_verify "$3" "$d"; printf '%s' "$d"`, 'bash', lib, fixture, timer], { env });
  assert.equal(create.status, 0, create.stderr);
  assert.equal(create.stdout, '2026-08-20 12:54:56 UTC');
  assert.equal(await readFile(join(fixture, 'rollback-deadline.utc'), 'utf8'), '2026-08-20 12:54:56 UTC\n');
  assert.match(await readFile(timer, 'utf8'), /OnCalendar=2026-08-20 12:54:56 UTC\nPersistent=true\n/);

  await writeFile(timer, (await readFile(timer, 'utf8')).replace('Persistent=true', 'Persistent=false'));
  const rejected = run('bash', ['-c', `source "$1"; viq15_timer_verify "$2" '2026-08-20 12:54:56 UTC'`, 'bash', lib, timer]);
  assert.notEqual(rejected.status, 0);
});

test('corrupt SQLite family restore retries after every rename boundary', async (t) => {
  for (const boundary of ['preserve-main', 'preserve-wal', 'preserve-shm', 'install-main']) {
    await t.test(boundary, async () => {
      const fixture = await mkdtemp(join(tmpRoot, `viq15-restore-${boundary}-`));
      const sealed = join(fixture, 'sealed.sqlite');
      const target = join(fixture, 'live.sqlite');
      await makeDb(sealed);
      await writeFile(target, 'corrupt-main-bytes');
      await writeFile(`${target}-wal`, 'unexpected-wal-bytes');
      await writeFile(`${target}-shm`, 'unexpected-shm-bytes');
      await chmod(target, 0o600);

      const crashed = run(restore, [sealed, target, 'unexpected'], {
        env: { ...process.env, VIQ15_CRASH_AFTER: boundary },
      });
      assert.equal(crashed.status, 99, crashed.stderr);
      const retry = run(restore, [sealed, target, 'unexpected']);
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(dbValue(target), 'sealed');
      assert.equal(await readFile(`${target}.unexpected`, 'utf8'), 'corrupt-main-bytes');
      assert.equal(await readFile(`${target}-wal.unexpected`, 'utf8'), 'unexpected-wal-bytes');
      assert.equal(await readFile(`${target}-shm.unexpected`, 'utf8'), 'unexpected-shm-bytes');

      const repeated = run(restore, [sealed, target, 'unexpected']);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.equal(dbValue(target), 'sealed');
    });
  }
});
