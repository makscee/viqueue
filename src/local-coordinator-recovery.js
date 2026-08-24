import { closeSync, constants, cpSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';

export const RECOVERY_ACK = '--ack-backend-stopped-and-backup-ready';

export function parseRecoveryArgs(argv) {
  const values = new Map();
  const allowed = new Set(['--storage', '--actor-id', '--device-id', '--device-name', '--out-fd']);
  let acknowledged = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === RECOVERY_ACK) {
      if (acknowledged) throw new Error('duplicate_acknowledgement');
      acknowledged = true;
      continue;
    }
    if (!allowed.has(key) || values.has(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('invalid_arguments');
    values.set(key, argv[++i]);
  }
  if (!acknowledged) throw new Error('acknowledgement_required');
  for (const key of allowed) if (!values.get(key)) throw new Error('invalid_arguments');
  if (!/^[0-9]+$/.test(values.get('--out-fd'))) throw new Error('invalid_output_fd');
  const outFd = Number(values.get('--out-fd'));
  if (!Number.isSafeInteger(outFd) || outFd <= 2) throw new Error('invalid_output_fd');
  return { storage: values.get('--storage'), actor_id: values.get('--actor-id'), device_id: values.get('--device-id'), device_name: values.get('--device-name'), outFd };
}

export function verifyRecoveryOutput(fd) {
  let info;
  try { info = fstatSync(fd); } catch { throw new Error('invalid_output_fd'); }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size !== 0) throw new Error('unsafe_output_fd');
}

export function verifyRecoveryStorage(file) {
  let pathInfo, fd;
  try {
    pathInfo = lstatSync(file);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.uid !== process.getuid() || pathInfo.nlink !== 1 || pathInfo.size < 100) throw new Error('unsafe_recovery_storage');
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd), header = Buffer.alloc(16);
    if (opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino || readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(Buffer.from('SQLite format 3\0'))) throw new Error('unsafe_recovery_storage');
  } catch { throw new Error('unsafe_recovery_storage'); }
  finally { if (fd !== undefined) closeSync(fd); }
  let db, validationDir;
  try {
    validationDir = mkdtempSync(path.join(tmpdir(), 'viq-recovery-preflight-'));
    const copy = path.join(validationDir, 'database.sqlite');
    cpSync(file, copy);
    for (const suffix of ['-wal', '-shm']) {
      try { const sidecar = lstatSync(`${file}${suffix}`); if (!sidecar.isFile() || sidecar.isSymbolicLink()) throw new Error('unsafe_recovery_storage'); cpSync(`${file}${suffix}`, `${copy}${suffix}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    db = new DatabaseSync(copy, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    const required = ['actors', 'devices', 'events', 'pairing_codes', 'projects', 'tickets'];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
    if (required.some((name) => !tables.has(name)) || !db.prepare('SELECT 1 FROM devices LIMIT 1').get()) throw new Error('invalid_recovery_storage');
  } catch { throw new Error('invalid_recovery_storage'); }
  finally { db?.close(); if (validationDir) rmSync(validationDir, { recursive: true, force: true }); }
}

function deliverToFd(fd, code) {
  const material = Buffer.from(`${code}\n`, 'utf8');
  let offset = 0;
  try {
    while (offset < material.length) offset += writeSync(fd, material, offset, material.length - offset, offset);
    fsyncSync(fd);
  } catch (error) {
    try { ftruncateSync(fd, 0); fsyncSync(fd); } catch {}
    throw new Error('secret_delivery_failed', { cause: error });
  } finally { material.fill(0); }
  return () => { ftruncateSync(fd, 0); fsyncSync(fd); };
}

export async function runLocalCoordinatorRecovery(argv) {
  const options = parseRecoveryArgs(argv);
  verifyRecoveryOutput(options.outFd);
  verifyRecoveryStorage(options.storage); // Read-only, must-exist preflight precedes writable Store construction.
  const store = new Store(options.storage);
  await store.init();
  try {
    return await store.recoverCoordinatorPairingCode(options, (code) => deliverToFd(options.outFd, code));
  } finally { await store.close(); }
}
