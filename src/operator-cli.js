import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { HttpApplicationClient } from './http-client.js';

const fail = (message, code = 'operator_usage') => { throw Object.assign(new Error(message), { code }); };
const option = (args, name, { required = false } = {}) => { const indexes = args.flatMap((v, i) => v === name ? [i] : []); if (indexes.length > 1) fail(`${name} may be supplied only once`); const value = indexes.length ? args[indexes[0] + 1] : undefined; if (indexes.length && (!value || value.startsWith('--'))) fail(`${name} requires a value`); if (required && !value) fail(`${name} is required`); return value; };
const onlyOptions = (args, allowed) => { for (let i = 0; i < args.length; i += 2) { if (!allowed.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid operator command options'); } };

export function readOperatorCredential(file, { uid = process.geteuid?.() } = {}) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== uid || (before.mode & 0o077) !== 0 || before.size < 20 || before.size > 512) fail('operator credential file has unsafe ownership, mode, type, link count, or size', 'operator_credential_unsafe');
    const value = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('operator credential file changed while reading', 'operator_credential_unsafe');
    const credential = value.endsWith('\n') ? value.slice(0, -1) : value;
    if (!credential || /[\0\r\n\s]/.test(credential)) fail('operator credential file is malformed', 'operator_credential_unsafe');
    return credential;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function writePrivate(file, content) {
  let fd;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_CLOEXEC, 0o600);
    fchmodSync(fd, 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; try { unlinkSync(file); } catch {} }
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export const writePrivateJson = (file, value) => writePrivate(file, `${JSON.stringify(value)}\n`);
function reservePrivateJson(file) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_CLOEXEC, 0o600);
  let done = false;
  return {
    commit(value) { if (done) fail('operator output is already closed'); try { fchmodSync(fd, 0o600); writeSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); done = true; closeSync(fd); } catch (error) { try { closeSync(fd); } catch {} try { unlinkSync(file); } catch {} done = true; throw error; } },
    abort() { if (done) return; try { closeSync(fd); } finally { try { unlinkSync(file); } catch {} done = true; } }
  };
}
export const writePrivateCredential = (file, value) => {
  if (typeof value !== 'string' || !value || /[\0\r\n\s]/.test(value)) fail('operator credential is malformed', 'operator_credential_unsafe');
  writePrivate(file, `${value}\n`);
};

export async function runOperatorCommand(args, { Client = HttpApplicationClient } = {}) {
  if (args[0] !== 'pairing' || args[1] !== 'create') fail('usage: viq operator pairing create --kind browser --name NAME --output FILE');
  const rest = args.slice(2); onlyOptions(rest, ['--kind', '--name', '--output', '--credential-file', '--server', '--ttl-ms']);
  const kind = option(rest, '--kind', { required: true });
  if (kind !== 'browser') fail('--kind must be browser (Worker handoffs use device pair-code)');
  const name = option(rest, '--name', { required: true }).trim();
  if (!name || name.length > 200) fail('--name must contain 1-200 characters');
  const output = path.resolve(option(rest, '--output', { required: true }));
  const credentialFile = path.resolve(option(rest, '--credential-file') ?? '/etc/viqueue-alpha/operator.credential');
  const server = option(rest, '--server') ?? 'http://127.0.0.1:17373';
  let parsed; try { parsed = new URL(server); } catch { fail('--server must be a loopback HTTP URL'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) fail('--server must be a loopback HTTP origin');
  const ttlRaw = option(rest, '--ttl-ms'); const ttl = ttlRaw === undefined ? 900000 : Number(ttlRaw);
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 900000) fail('--ttl-ms must be 1000-900000');
  const client = new Client({ server, deviceToken: readOperatorCredential(credentialFile) });
  const reserved = reservePrivateJson(output);
  try {
    const me = await client.request('GET', '/v1/devices/me');
    if (me?.device?.kind !== 'coordinator' || !me?.actor?.admin || typeof me.actor.id !== 'string') fail('operator credential is not an active coordinator admin', 'operator_unauthorized');
    const id = `browser-${randomBytes(12).toString('hex')}`;
    const issued = await client.request('POST', '/v1/pairing-codes', { intended_kind: 'coordinator', actor_id: me.actor.id, device_id: id, device_name: name, ttl_ms: ttl });
    if (issued.intended_kind !== 'coordinator' || issued.actor_id !== me.actor.id || issued.device_id !== id || issued.device_name !== name || typeof issued.code !== 'string' || !Number.isSafeInteger(issued.expires_at)) fail('server returned an inconsistent pairing handoff', 'operator_invalid_response');
    reserved.commit({ code: issued.code, expires_at: issued.expires_at });
    return { output, expires_at: issued.expires_at };
  } catch (error) { reserved.abort(); throw error; }
}
