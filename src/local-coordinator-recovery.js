import { fstatSync, fsyncSync, ftruncateSync, writeSync } from 'node:fs';
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
  verifyRecoveryOutput(options.outFd); // Every output/argument failure precedes Store.init or a transaction.
  const store = new Store(options.storage);
  await store.init();
  try {
    return await store.recoverCoordinatorPairingCode(options, (code) => deliverToFd(options.outFd, code));
  } finally { await store.close(); }
}
