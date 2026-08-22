import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const lib = join(root, 'scripts/viq15-cutover/transaction-lib.sh');
const restore = join(root, 'scripts/viq15-cutover/sqlite-family-restore.sh');
const applyScript = join(root, 'scripts/viq15-cutover/apply.sh');
const rollbackScript = join(root, 'scripts/viq15-cutover/rollback.sh');
const tmpRoot = tmpdir();

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

const expectedSchema = 'd56e8da3e4ee72a2fa438156a1b967ba3cdf60ff13c6d0ee2f7d8048ce6ed1ae';
const casSchema = `
CREATE TABLE actor_roles (
          actor_id TEXT NOT NULL REFERENCES actors(id),role_id TEXT NOT NULL REFERENCES roles(id),PRIMARY KEY(actor_id,role_id)
        ) STRICT;
CREATE TABLE actors (
          id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('human','agent')),machine TEXT,
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
        ) STRICT;
CREATE TABLE claims (
        claim_id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),actor TEXT NOT NULL,generation INTEGER NOT NULL,
        token_hash BLOB NOT NULL,claimed_at INTEGER NOT NULL,released_at INTEGER,UNIQUE(ticket_id,generation)
      ) STRICT;
CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT REFERENCES tickets(id),project TEXT REFERENCES projects(key),
        type TEXT NOT NULL,actor TEXT,message TEXT,created_at INTEGER NOT NULL
      , metadata TEXT) STRICT;
CREATE TABLE execution_authorities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT NOT NULL REFERENCES tickets(id),generation INTEGER NOT NULL,
          assignee_type TEXT NOT NULL CHECK(assignee_type IN ('actor','role')),assignee_id TEXT NOT NULL,
          granted_by TEXT NOT NULL REFERENCES actors(id),granted_at INTEGER NOT NULL,consumed_at INTEGER,revoked_at INTEGER,
          UNIQUE(ticket_id,generation)
        ) STRICT;
CREATE TABLE projects (key TEXT PRIMARY KEY,next_number INTEGER NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE questions (
          id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),asked_by TEXT NOT NULL REFERENCES actors(id),
          target_type TEXT NOT NULL CHECK(target_type IN ('actor','role')),target_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('text','approval')),text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','answered')),
          answer TEXT,answered_by TEXT REFERENCES actors(id),created_at INTEGER NOT NULL,answered_at INTEGER
        , question_event_id INTEGER) STRICT;
CREATE TABLE roles (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE TABLE ticket_blocks (
          id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),created_by TEXT NOT NULL REFERENCES actors(id),
          reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','resolved')),created_at INTEGER NOT NULL,
          resolved_by TEXT REFERENCES actors(id),resolved_at INTEGER
        ) STRICT;
CREATE TABLE tickets (
        id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(key),number INTEGER NOT NULL,title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('open','review','done')),assigned_to TEXT,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL, assignee_type TEXT, assignee_id TEXT, archived_at INTEGER, deleted_at INTEGER,UNIQUE(project,number)
      ) STRICT;
`;

function schemaAndCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const counts = Object.fromEntries(schema.map(({ name }) => [name, Number(db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n)]));
  db.close();
  return { schema, counts };
}

async function makeCasDb(prefix = 'viq15-cas-') {
  const fixture = await mkdtemp(join(tmpRoot, prefix));
  const file = join(fixture, 'source.sqlite');
  const db = new DatabaseSync(file);
  db.exec(casSchema);
  const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.equal(createHash('sha256').update(JSON.stringify(schema)).digest('hex'), expectedSchema);
  db.prepare("INSERT INTO projects(key,next_number,created_at) VALUES('LIVE',41,1)").run();
  db.prepare("INSERT INTO roles(id,name,created_at) VALUES('unrelated-role','Unrelated',1)").run();
  const actor = db.prepare("INSERT INTO actors(id,name,kind,created_at,updated_at) VALUES(?,?,'agent',1,1)");
  const role = db.prepare("INSERT INTO actor_roles(actor_id,role_id) VALUES(?,'unrelated-role')");
  for (let i = 0; i < 6; i++) { actor.run(`actor-${i}`, `Actor ${i}`); role.run(`actor-${i}`); }
  const ticket = db.prepare("INSERT INTO tickets(id,project,number,title,state,created_at,updated_at) VALUES(?,'LIVE',?,'unrelated','open',1,1)");
  for (let i = 1; i <= 40; i++) ticket.run(`LIVE-${i}`, i);
  const event = db.prepare("INSERT INTO events(type,created_at) VALUES('unrelated',1)");
  for (let i = 0; i < 219; i++) event.run();
  db.close();
  return { fixture, file };
}

function extractShellFunction(source, name, nextName) {
  const start = source.indexOf(`${name}(){`);
  const next = source.indexOf(nextName, start);
  const end = source.lastIndexOf('\n}', next);
  assert.ok(start >= 0 && next > start && end > start, `${name} function must remain extractable`);
  return source.slice(start, end + 2);
}

function runApplyCas(source, file) {
  const fn = extractShellFunction(source, 'check_db_cas', 'seal_generic_sqlite');
  return run('bash', ['-c', `EXPECTED_SCHEMA=$1\n${fn}\ncheck_db_cas "$2"`, 'bash', expectedSchema, file]);
}

function runRollbackCas(source, file) {
  const fn = extractShellFunction(source, 'check_old_db', 'CAPTURED_ROUTE');
  return run('bash', ['-c', `OLD_DB=$1\nEXPECTED_SCHEMA=$2\n${fn}\ncheck_old_db`, 'bash', file, expectedSchema]);
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

test('legitimate unrelated live ticket/event/role counts pass apply and rollback global CAS', async () => {
  const [applySource, rollbackSource] = await Promise.all([readFile(applyScript, 'utf8'), readFile(rollbackScript, 'utf8')]);
  const { file } = await makeCasDb();
  const { counts } = schemaAndCounts(file);
  assert.equal(counts.actor_roles, 6);
  assert.equal(counts.events, 219);
  assert.equal(counts.tickets, 40);
  assert.doesNotMatch(applySource, /actor_roles:8|events:172|tickets:25/);
  assert.doesNotMatch(rollbackSource, /actor_roles:8|events:172|tickets:25/);
  for (const result of [runApplyCas(applySource, file), runRollbackCas(rollbackSource, file)]) {
    assert.equal(result.status, 0, result.stderr);
  }
});

test('global CAS still rejects integrity and exact schema drift', async () => {
  const [applySource, rollbackSource] = await Promise.all([readFile(applyScript, 'utf8'), readFile(rollbackScript, 'utf8')]);
  const schemaDrift = await makeCasDb('viq15-schema-drift-');
  const schemaDb = new DatabaseSync(schemaDrift.file);
  schemaDb.exec('ALTER TABLE tickets ADD COLUMN unexpected TEXT');
  schemaDb.close();

  const integrityDrift = await makeCasDb('viq15-integrity-drift-');
  const integrityDb = new DatabaseSync(integrityDrift.file);
  integrityDb.exec('PRAGMA writable_schema=ON');
  integrityDb.prepare("UPDATE sqlite_schema SET rootpage=999999 WHERE name='tickets'").run();
  integrityDb.close();

  for (const source of [applySource, rollbackSource]) {
    const check = source === applySource ? runApplyCas : runRollbackCas;
    assert.notEqual(check(source, schemaDrift.file).status, 0, 'schema drift must fail');
    assert.notEqual(check(source, integrityDrift.file).status, 0, 'integrity drift must fail');
  }
});

test('SQLite-consistent backup retains enforced source/backup schema and count equality', async () => {
  const source = await readFile(applyScript, 'utf8');
  const fn = extractShellFunction(source, 'seal_generic_sqlite', 'rollback_on_error');
  assert.match(fn, /expected=inspect\(source\),db=new DatabaseSync\(source,\{readOnly:true\}\);await backup\(db,dest\);db\.close\(\);chmodSync\(dest,0o600\);if\(inspect\(dest\)!==expected\)process\.exit\(1\)/);
  const { fixture, file } = await makeCasDb('viq15-backup-equality-');
  const backup = join(fixture, 'backup.sqlite');
  const result = run('bash', ['-c', `${fn}\nseal_generic_sqlite "$1" "$2"`, 'bash', file, backup]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(schemaAndCounts(backup), schemaAndCounts(file));
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
});

test('rollback authenticates backup and helper bytes in a deterministic complete manifest before its first mutation', { skip: process.platform === 'darwin' ? 'requires Linux GNU coreutils used by cutover scripts' : false }, async () => {
  const source = await readFile(rollbackScript, 'utf8');
  const verify = source.indexOf('sha256sum --check --strict --quiet rollback-manifest.sha256');
  const firstMutation = source.indexOf('systemctl stop viqueue-phone-gateway.service');
  assert.ok(verify > 0 && firstMutation > verify);

  const fixture = await mkdtemp(join(tmpRoot, 'viq15-manifest-'));
  const files = ['rollback.sh', 'transaction-lib.sh', 'sqlite-family-restore.sh', 'viqueue.service.before', 'tailscale-serve.before.json'];
  for (const file of files) await writeFile(join(fixture, file), `${file}\n`);
  await makeDb(join(fixture, 'precutover.sqlite'), 'sealed-row');
  const members = [...files, 'precutover.sqlite'];
  const seal = run('bash', ['-c', 'source "$1"; shift; viq15_manifest_seal "$1" "${@:2}"', 'bash', lib, fixture, ...members]);
  assert.equal(seal.status, 0, seal.stderr);
  const manifest = await readFile(join(fixture, 'rollback-manifest.sha256'), 'utf8');
  assert.deepEqual(manifest.trim().split('\n').map((line) => line.split(/  /)[1]), [...members].sort());
  const verifyOk = () => run('bash', ['-c', 'source "$1"; viq15_manifest_verify "$2"', 'bash', lib, fixture]);
  assert.equal(verifyOk().status, 0);

  const tamperDb = run(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]); db.prepare('UPDATE proof SET value=?').run('valid-row-tamper'); db.close();
  `, join(fixture, 'precutover.sqlite')]);
  assert.equal(tamperDb.status, 0, tamperDb.stderr);
  assert.notEqual(verifyOk().status, 0, 'valid SQLite row tamper must fail authentication');

  for (const file of ['rollback.sh', 'sqlite-family-restore.sh', 'viqueue.service.before', 'tailscale-serve.before.json']) {
    await makeDb(join(fixture, 'precutover.sqlite'), 'sealed-row').catch(() => {});
    const reseal = run('bash', ['-c', 'source "$1"; shift; viq15_manifest_seal "$1" "${@:2}"', 'bash', lib, fixture, ...members]);
    assert.equal(reseal.status, 0, reseal.stderr);
    await writeFile(join(fixture, file), `tampered-${file}\n`);
    assert.notEqual(verifyOk().status, 0, `${file} tamper must fail authentication`);
    await writeFile(join(fixture, file), `${file}\n`);
  }
});

test('systemd unit install is same-directory fsynced atomic replacement', { skip: process.platform === 'darwin' ? 'systemd and GNU atomic-install tooling are unavailable on macOS' : false }, async () => {
  const fixture = await mkdtemp(join(tmpRoot, 'viq15-unit-'));
  const source = join(fixture, 'captured.service');
  const targetDirectory = join(fixture, 'systemd');
  const target = join(targetDirectory, 'viqueue.service');
  await mkdir(targetDirectory);
  await writeFile(source, '[Service]\nExecStart=/sealed\n');
  await writeFile(target, 'old\n');
  const result = run('bash', ['-c', 'source "$1"; viq15_atomic_install_file "$2" "$3" 0644', 'bash', lib, source, target]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(target, 'utf8'), '[Service]\nExecStart=/sealed\n');
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test('deadline is sealed as canonical absolute UTC and timer readback is calendar-persistent', { skip: process.platform === 'darwin' ? 'requires GNU date and systemd calendar semantics' : false }, async () => {
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
