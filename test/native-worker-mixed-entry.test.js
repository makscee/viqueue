import assert from 'node:assert/strict';
import test from 'node:test';
import viqWorker from '../extensions/viq-worker/index.ts';
import { controller } from '../extensions/viq-worker/controller.mjs';
import { isolatedViqConfig } from './helpers/isolated-viq-config.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('command take, poll, and once fence subsequent typed claims in the same native session', async t => {
  await isolatedViqConfig(t, 'viq-mixed-entry-');
  t.after(async () => {
    await controller.runtime?.shutdown();
    controller.runtime = null; controller.adapter = null; controller.persistent = false;
  });
  for (const command of ['take ABC-1', 'poll', 'once']) {
    Object.assign(controller, { epoch: 0, adapter: null, persistent: false, pendingStart: false, pendingTicket: null, pendingCredentialFile: null, rotating: false, runtime: null });
    const claims = [], messages = [];
    function instance(id) {
      const entries = [], handlers = new Map(), commands = new Map(), tools = new Map();
      const ctx = { ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => entries, getSessionId: () => id } };
      const pi = { on: (name, fn) => handlers.set(name, fn), registerCommand: (name, value) => commands.set(name, value), registerTool: value => tools.set(value.name, value), appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }), setSessionName() {}, sendUserMessage: value => messages.push(value) };
      viqWorker(pi);
      return { ctx, entries, handlers, commands, tools };
    }
    let active = instance(`initial-${command}`);
    const runtime = controller.runtime;
    runtime.setCredential('fixture-worker-credential-12345678901234567890'); runtime.credentialFile = null;
    runtime.fetch = async (url, options) => {
      const route = new URL(url).pathname;
      if (route.endsWith('/devices/me')) return Response.json({ device: { id: 'fixture', kind: 'worker' }, actor: { id: 'fixture' } });
      if (route === '/v1/sessions') return Response.json({ session_id: 'fixture-session', session_capability: 'fixture-capability' });
      if (route.endsWith('/claim') || route.endsWith('/claim-next')) {
        const id = route.endsWith('/claim-next') ? 'ABC-1' : route.split('/')[3];
        claims.push(id);
        return Response.json({ ticket: { id, title: 'Fixture', claim: { claim_id: 'fixture-claim', generation: 1 } }, claim_token: 'fixture-fence' });
      }
      if (route === '/v1/events') return Response.json({ events: [] });
      return Response.json({});
    };
    await active.handlers.get('session_start')({}, active.ctx);
    const first = active;
    await first.commands.get('viq').handler(command, { ...first.ctx, newSession: async options => {
      await first.handlers.get('session_shutdown')({}, first.ctx);
      active = instance(`replacement-${command}`);
      await active.handlers.get('session_start')({}, active.ctx);
      await options.withSession({ newSession: async () => ({ cancelled: true }) });
      return { cancelled: false };
    } });
    for (let i = 0; i < 8 && !messages.length; i++) await flush();
    assert.equal(messages.length, 1, `${command} delivers one canonical ticket`);
    await active.tools.get('viq_complete').execute('complete', { outcome: 'Fixture completed' }, undefined, undefined, active.ctx);
    await assert.rejects(active.tools.get('viq_take').execute('second', { ticket_id: 'ABC-2' }, undefined, undefined, active.ctx), /viq_episode_reuse_forbidden/, command);
    await active.commands.get('viq').handler('take ABC-2', { ...active.ctx, newSession: async () => ({ cancelled: true }) });
    await assert.rejects(active.tools.get('viq_take').execute('after-cancel', { ticket_id: 'ABC-2' }, undefined, undefined, active.ctx), /viq_episode_reuse_forbidden/, command);
    await assert.rejects(active.commands.get('viq').handler('once', active.ctx), /viq_episode_reuse_forbidden/, command);
    assert.deepEqual(claims, ['ABC-1']);
    await runtime.shutdown();
  }
});
