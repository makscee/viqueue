import assert from 'node:assert/strict';
import { closeSync, linkSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { runLocalCoordinatorRecovery } from '../src/local-coordinator-recovery.js';

const command = new URL('../bin/viq-recover-coordinator.js', import.meta.url);

async function populatedFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'viq-recover-'));
  const db = path.join(dir, 'db.sqlite');
  const store = new Store(db);
  await store.init();
  const coordinator = await store.bootstrapCoordinator({ id: 'operator', name: 'Operator' });
  const workerCode = await store.createPairingCode(coordinator.device.id, {
    intended_kind: 'worker', actor_id: 'operator', device_id: 'operator-worker', device_name: 'Operator Worker'
  });
  const worker = await store.pairDevice({ code: workerCode.code });
  await store.revokeDevice(coordinator.device.id, coordinator.device.id);
  await store.close();
  return { dir, db, worker };
}

function invoke(fixture, extra = [], output = path.join(fixture.dir, 'pairing-code')) {
  const fd = openSync(output, 'wx', 0o600);
  try {
    const result = spawnSync(process.execPath, [command.pathname,
      '--storage', fixture.db,
      '--actor-id', 'operator',
      '--device-id', 'replacement-coordinator',
      '--device-name', 'Replacement Coordinator',
      '--ack-backend-stopped-and-backup-ready',
      '--out-fd', '3',
      ...extra
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] });
    return { ...result, output, secret: readFileSync(output, 'utf8') };
  } finally { closeSync(fd); }
}

function commandArgs(fixture, overrides = {}) {
  return ['--storage', fixture.db, '--actor-id', overrides.actor ?? 'operator', '--device-id', 'replacement-coordinator', '--device-name', 'Replacement Coordinator', ...(overrides.ack === false ? [] : ['--ack-backend-stopped-and-backup-ready']), '--out-fd', String(overrides.fd ?? 3), ...(overrides.extra ?? [])];
}

function recoveryRows(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const result = { codes: Number(db.prepare("SELECT count(*) n FROM pairing_codes WHERE used_at IS NULL").get().n), audits: Number(db.prepare("SELECT count(*) n FROM events WHERE type='local_coordinator_recovery_code_created'").get().n) };
  db.close(); return result;
}

test('local recovery emits only a standard one-use coordinator pairing code to fd3', async () => {
  const fixture = await populatedFixture();
  const result = invoke(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.secret.length, 13); // 12 base64url chars plus newline
  assert.doesNotMatch(result.stderr, new RegExp(result.secret.trim()));

  const db = new DatabaseSync(fixture.db, { readOnly: true });
  const rows = db.prepare('SELECT intended_kind,used_at,actor_id,device_id,device_name FROM pairing_codes WHERE used_at IS NULL').all();
  const audits = db.prepare("SELECT actor,metadata FROM events WHERE type='local_coordinator_recovery_code_created'").all();
  db.close();
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ intended_kind: 'coordinator', used_at: null, actor_id: 'operator', device_id: 'replacement-coordinator', device_name: 'Replacement Coordinator' }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'operator');
  assert.equal(audits[0].metadata.includes(result.secret.trim()), false);

  const store = new Store(fixture.db);
  await store.init();
  const paired = await store.pairDevice({ code: result.secret.trim() });
  assert.equal(paired.device.kind, 'coordinator');
  assert.equal(paired.device.actor_id, 'operator');
  await assert.rejects(store.pairDevice({ code: result.secret.trim() }), /invalid or already used/);
  await store.close();
});

test('recovery rejects actor, bootstrap, acknowledgement, TTL, and unknown argument errors without recovery mutation', async () => {
  for (const actorCase of ['missing', 'agent', 'inactive', 'non-admin']) {
    const f = await populatedFixture();
    const store = new Store(f.db); await store.init();
    if (actorCase !== 'missing') await store.createActor({ id: actorCase, name: actorCase, kind: actorCase === 'agent' ? 'agent' : 'human', active: actorCase !== 'inactive', admin: false });
    await store.close();
    const out = path.join(f.dir, `out-${actorCase}`), fd = openSync(out, 'wx', 0o600);
    const r = spawnSync(process.execPath, [command.pathname, ...commandArgs(f, { actor: actorCase })], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }); closeSync(fd);
    assert.notEqual(r.status, 0); assert.equal(readFileSync(out, 'utf8'), ''); assert.deepEqual(recoveryRows(f.db), { codes: 0, audits: 0 });
  }
  const emptyDir = await mkdtemp(path.join(tmpdir(), 'viq-recover-empty-')), empty = { dir: emptyDir, db: path.join(emptyDir, 'db.sqlite') };
  for (const args of [commandArgs(empty), commandArgs(empty, { ack: false }), commandArgs(empty, { extra: ['--ttl-ms', '1000'] }), commandArgs(empty, { extra: ['--surprise', 'x'] })]) {
    const out = path.join(emptyDir, `out-${Math.random()}`), fd = openSync(out, 'wx', 0o600);
    const r = spawnSync(process.execPath, [command.pathname, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }); closeSync(fd);
    assert.notEqual(r.status, 0); assert.equal(readFileSync(out, 'utf8'), '');
  }
});

test('recovery storage preflight is read-only and rejects typo, unsafe, empty, non-SQLite, and non-Viq targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'viq-recover-storage-'));
  const cases = [];
  const missing = path.join(root, 'typo.sqlite'); cases.push({ name: 'missing', db: missing, before: null });
  const empty = path.join(root, 'empty.sqlite'); await writeFile(empty, Buffer.alloc(0)); cases.push({ name: 'empty', db: empty, before: await readFile(empty) });
  const bootstrap = path.join(root, 'bootstrap.sqlite'); { const store = new Store(bootstrap); await store.init(); await store.close(); } cases.push({ name: 'empty-bootstrap', db: bootstrap, before: await readFile(bootstrap) });
  const text = path.join(root, 'text.sqlite'); await writeFile(text, 'not sqlite'); cases.push({ name: 'non-sqlite', db: text, before: await readFile(text) });
  const wrong = path.join(root, 'wrong.sqlite'); { const db = new DatabaseSync(wrong); db.exec('CREATE TABLE unrelated(id TEXT PRIMARY KEY) STRICT'); db.close(); } cases.push({ name: 'wrong-schema', db: wrong, before: await readFile(wrong) });
  const directory = path.join(root, 'directory'); await mkdir(directory); cases.push({ name: 'directory', db: directory, before: null });
  const valid = await populatedFixture(), link = path.join(root, 'linked.sqlite'); await symlink(valid.db, link); cases.push({ name: 'symlink', db: link, before: null, target: valid.db, targetBefore: await readFile(valid.db) });
  for (const item of cases) {
    const out = path.join(root, `out-${item.name}`), fd = openSync(out, 'wx', 0o600), fixture = { db: item.db };
    const result = spawnSync(process.execPath, [command.pathname, ...commandArgs(fixture)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }); closeSync(fd);
    assert.notEqual(result.status, 0, item.name); assert.equal(readFileSync(out, 'utf8'), '', item.name);
    if (item.name === 'missing') await assert.rejects(lstat(item.db));
    if (item.before) assert.deepEqual(await readFile(item.db), item.before, item.name);
    if (item.target) assert.deepEqual(await readFile(item.target), item.targetBefore, item.name);
    for (const suffix of ['-wal', '-shm']) await assert.rejects(lstat(`${item.db}${suffix}`), `${item.name}${suffix}`);
  }
});

test('recovery accepts only a pre-opened empty owner 0600 single-link regular fd above stderr', async () => {
  const cases = [];
  for (const fd of [0, 1, 2]) cases.push({ name: `stdio-${fd}`, fd });
  const f = await populatedFixture();
  for (const c of cases) {
    const r = spawnSync(process.execPath, [command.pathname, ...commandArgs(f, { fd: c.fd })], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, c.name);
  }
  const pipe = spawnSync(process.execPath, [command.pathname, ...commandArgs(f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  assert.notEqual(pipe.status, 0);
  const dir = path.join(f.dir, 'directory'); await mkdir(dir); const dirFd = openSync(dir, 'r');
  let r = spawnSync(process.execPath, [command.pathname, ...commandArgs(f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', dirFd] }); closeSync(dirFd); assert.notEqual(r.status, 0);
  const unsafe = [
    ['mode', 0o644, ''],
    ['nonempty', 0o600, 'x'],
    ['links', 0o600, '']
  ];
  for (const [name, mode, content] of unsafe) {
    const file = path.join(f.dir, `unsafe-${name}`); writeFileSync(file, content, { mode }); if (name === 'links') linkSync(file, `${file}-link`);
    const fd = openSync(file, 'r+'); r = spawnSync(process.execPath, [command.pathname, ...commandArgs(f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }); closeSync(fd); assert.notEqual(r.status, 0, name);
  }
  if (process.getuid() === 0) {
    const file = path.join(f.dir, 'wrong-owner'); writeFileSync(file, '', { mode: 0o600 }); await chown(file, 65534, 65534); const fd = openSync(file, 'r+');
    r = spawnSync(process.execPath, [command.pathname, ...commandArgs(f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd] }); closeSync(fd); assert.notEqual(r.status, 0);
  }
  r = spawnSync(process.execPath, [command.pathname, ...commandArgs(f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'ignore'] }); assert.notEqual(r.status, 0);
  assert.deepEqual(recoveryRows(f.db), { codes: 0, audits: 0 });
});

test('transaction, delivery, fsync-equivalent, and commit failures roll back and sanitize delivered material', async () => {
  for (const phase of ['write', 'fsync', 'commit']) {
    const f = await populatedFixture(), store = new Store(f.db); await store.init(); let material = '';
    await assert.rejects(store.recoverCoordinatorPairingCode({ actor_id: 'operator', device_id: `replacement-${phase}`, device_name: 'Replacement' }, async (code) => {
      if (phase === 'write') throw new Error('injected_write_failure');
      material = code;
      if (phase === 'fsync') { material = ''; throw new Error('injected_fsync_failure'); }
      return async () => { material = ''; };
    }, { beforeCommit: phase === 'commit' ? async () => { throw new Error('injected_commit_failure'); } : null }));
    assert.equal(material, ''); assert.deepEqual(recoveryRows(f.db), { codes: 0, audits: 0 }); await store.close();
  }
});

test('recovery codes expire, concurrent invocations are unique, and device kind cannot be substituted', async () => {
  const f = await populatedFixture();
  const launch = (i) => new Promise((resolve, reject) => {
    const output = path.join(f.dir, `concurrent-${i}`), fd = openSync(output, 'wx', 0o600);
    const child = spawn(process.execPath, [command.pathname, ...commandArgs(f, { extra: [] }).map((arg, index, all) => all[index - 1] === '--device-id' ? `replacement-${i}` : all[index - 1] === '--device-name' ? `Replacement ${i}` : arg)], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', reject); child.on('close', (status) => { closeSync(fd); status === 0 ? resolve(readFileSync(output, 'utf8').trim()) : reject(new Error(stderr)); });
  });
  const codes = await Promise.all([launch(0), launch(1)]);
  assert.equal(new Set(codes).size, 2);
  const store = new Store(f.db); await store.init();
  await assert.rejects(store.pairDevice({ code: codes[0], id: 'substitute', name: 'Worker' }), (error) => error.code === 'pairing_device_mismatch');
  const db = new DatabaseSync(f.db); db.prepare('UPDATE pairing_codes SET expires_at=0 WHERE code_hash=(SELECT code_hash FROM pairing_codes WHERE device_id=?)').run('replacement-0'); db.close();
  await assert.rejects(store.pairDevice({ code: codes[0] }), (error) => error.code === 'pairing_code_expired');
  const paired = await store.pairDevice({ code: codes[1] }); assert.equal(paired.device.kind, 'coordinator');
  await assert.rejects(store.pairDevice({ code: codes[1] }), (error) => error.code === 'pairing_code_used_or_invalid');
  await store.close();
});

test('static recovery surface adds no HTTP route, bearer return, role selector, or secret argv/env seam', async () => {
  const source = await readFile(new URL('../src/local-coordinator-recovery.js', import.meta.url), 'utf8');
  const store = await readFile(new URL('../src/store.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Bearer|credential|process\.env|--role|ttl-ms|process\.stdout|response/i);
  assert.doesNotMatch(server, /recover-coordinator|coordinator-recovery|local_coordinator_recovery/);
  assert.match(store, /intended_kind: 'coordinator'/);
});
