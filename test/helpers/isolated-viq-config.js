import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const keys = ['XDG_CONFIG_HOME', 'VIQ_CREDENTIAL_FILE', 'VIQ_DEVICE_TOKEN', 'VIQ_URL'];

export async function isolatedViqConfig(t, prefix = 'viq-test-config-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    XDG_CONFIG_HOME: root,
    VIQ_CREDENTIAL_FILE: path.join(root, 'missing-credential.json'),
    VIQ_DEVICE_TOKEN: '',
    VIQ_URL: 'http://fixture.invalid'
  });
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
