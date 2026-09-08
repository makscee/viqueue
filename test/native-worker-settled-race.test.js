import assert from 'node:assert/strict';
import { cp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadCredential, saveCredential } from '../extensions/viq-worker/credential-store.mjs';
import { isolatedViqConfig } from './helpers/isolated-viq-config.js';

const credential = 'fixture-only-worker-credential-a-000000000000';
const replacementCredential = 'fixture-only-worker-credential-b-000000000000';
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

async function freshExtension(root, label) {
  const moduleRoot = path.join(root, label);
  await cp(new URL('../extensions/viq-worker/', import.meta.url), moduleRoot, { recursive: true });
  const indexUrl = pathToFileURL(path.join(moduleRoot, 'index.ts')).href;
  const controllerUrl = pathToFileURL(path.join(moduleRoot, 'controller.mjs')).href;
  const [{ default: viqWorker }, { controller }] = await Promise.all([import(indexUrl), import(controllerUrl)]);
  return { viqWorker, controller };
}

function fixtureFetch(ticketRead) {
  const calls = [];
  let sessionSerial = 0, claimSerial = 0, heldHeartbeat = null;
  const implementation = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'http://fixture.invalid', 'fixtures must never forward to a real endpoint');
    const method = init.method ?? 'GET', route = url.pathname;
    const authorization = new Headers(init.headers).get('authorization');
    if (route === '/v1/devices/pair') assert.equal(authorization, null);
    else assert.ok([`Bearer ${credential}`, `Bearer ${replacementCredential}`].includes(authorization), 'fixture request must use a fixture-only credential');
    const body = init.body === undefined ? null : JSON.parse(init.body);
    calls.push({ method, route, body, authorization });
    if (method === 'GET' && route === '/v1/devices/me') return Response.json({ device: { id: 'fixture-worker', kind: 'worker' }, actor: { id: 'fixture-agent' } });
    if (method === 'POST' && route === '/v1/devices/pair') return Response.json({ credential: replacementCredential, device: { id: 'fixture-worker-b', kind: 'worker' } });
    if (method === 'POST' && route === '/v1/sessions') return Response.json({ session_id: `fixture-session-${++sessionSerial}`, session_capability: `fixture-capability-${sessionSerial}` });
    if (method === 'POST' && route === '/v1/sessions/close') return Response.json({});
    if (method === 'POST' && (route === '/v1/tickets/claim-next' || route === '/v1/tickets/ABC-1/claim')) {
      const serial = ++claimSerial, id = route.endsWith('/claim-next') && serial > 1 ? 'ABC-2' : 'ABC-1';
      return Response.json({ ticket: { id, title: `Fixture ${id}`, claim: { claim_id: `fixture-claim-${serial}`, generation: serial } }, claim_token: `fixture-claim-token-${serial}` });
    }
    if (method === 'GET' && route === '/v1/events') return Response.json({ events: [] });
    if (method === 'GET' && route === '/v1/tickets/ABC-1') return ticketRead.promise;
    if (method === 'POST' && route === '/v1/workers/heartbeat') {
      if (heldHeartbeat) { const held = heldHeartbeat; heldHeartbeat = null; held.started = true; return held.promise; }
      return Response.json({});
    }
    if (method === 'POST' && /^\/v1\/tickets\/ABC-[12]\/(?:block|release|complete|questions|submit)$/.test(route)) return Response.json({});
    throw new Error(`unexpected fixture request ${method} ${route}`);
  };
  return { calls, implementation, holdNextHeartbeat() { heldHeartbeat = deferred(); return heldHeartbeat; } };
}

function createInstance(viqWorker, id, notifications, messages) {
  const entries = [], handlers = new Map(), commands = new Map(), tools = new Map();
  const ctx = {
    ui: {
      notify(message, level) { notifications.push({ message, level, id }); },
      setStatus() {}
    },
    sessionManager: { getEntries: () => entries, getSessionId: () => id }
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) { tools.set(tool.name, tool); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    setSessionName() {},
    sendUserMessage(message) { messages.push(message); }
  };
  viqWorker(pi);
  return { commands, ctx, handlers, tools };
}

async function startedPersistent(module, fetchImpl, notifications, messages, onRotate = async () => ({ cancelled: false }), credentialFile = null) {
  const { viqWorker, controller } = module;
  let active = createInstance(viqWorker, 'initial', notifications, messages);
  await active.handlers.get('session_start')({}, active.ctx);
  const runtime = controller.runtime;
  runtime.setCredential(credential);
  runtime.credentialFile = credentialFile;
  runtime.fetch = fetchImpl;
  await active.commands.get('viq').handler('poll', {
    ...active.ctx,
    newSession: async options => {
      await active.handlers.get('session_shutdown')({}, active.ctx);
      active = createInstance(viqWorker, 'ticket-episode', notifications, messages);
      await active.handlers.get('session_start')({}, active.ctx);
      await options.withSession({ newSession: onRotate });
      return { cancelled: false };
    }
  });
  await eventually(() => runtime.status().ticket === 'ABC-1', 'persistent fixture did not claim ABC-1');
  return { get active() { return active; }, set active(value) { active = value; }, controller, runtime };
}

async function observeUnhandled(run) {
  const reasons = [];
  const listener = reason => reasons.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await run();
    await flush();
    await flush();
  } finally {
    process.off('unhandledRejection', listener);
  }
  return reasons;
}

/*
Ranked, falsifiable hypotheses for the native Pi 0.83 / viqueue 0.5.2 failure:
1. settled() dereferences mutable current after its awaited GET while a terminal path clears current.
2. A retired observation can consume replacement claim/session state and emit a stale heartbeat or rotation decision.
3. A retired GET rejection escapes the void agent_settled hook; active-episode failures still need visible reporting.
The cases below hold the ticket GET deterministically at that exact await boundary.
*/
test('agent_settled retires resolved observations across real terminal hooks without stale rotation', async t => {
  const root = await isolatedViqConfig(t, 'viq-settled-race-');
  for (const boundary of ['block-shutdown', 'release', 'complete', 'shutdown']) {
    await t.test(boundary, async () => {
      const module = await freshExtension(root, `resolved-${boundary}`);
      const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
      let rotations = 0;
      const lane = await startedPersistent(module, fixture.implementation, notifications, messages, async () => { rotations++; return { cancelled: false }; });
      const unhandled = await observeUnhandled(async () => {
        lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
        await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1'), 'settled GET did not start');
        if (boundary === 'block-shutdown') {
          const result = await lane.active.tools.get('viq_block').execute('block', { message: 'Fixture blocker' });
          assert.equal(result.terminate, true);
          await lane.active.handlers.get('session_shutdown')({}, lane.active.ctx);
        } else if (boundary === 'release') {
          await lane.active.tools.get('viq_release').execute('release', { message: 'Fixture release' });
        } else if (boundary === 'complete') {
          await lane.active.tools.get('viq_complete').execute('complete', { outcome: 'Fixture complete' });
        } else {
          await lane.active.handlers.get('session_shutdown')({}, lane.active.ctx);
        }
        ticketRead.resolve(Response.json({ ticket: { id: 'ABC-1', claim: { claim_id: 'fixture-claim-1', generation: 1 } } }));
      });
      assert.deepEqual(unhandled, [], 'retired resolved observation must not reject the native event hook');
      assert.equal(rotations, 0, 'the pre-terminal observation must not rotate a later lifecycle state');
      assert.equal(lane.runtime.status().ticket, null);
      if (boundary === 'block-shutdown') {
        assert.equal(fixture.calls.filter(call => call.route === '/v1/tickets/ABC-1/block').length, 1, 'block must succeed before shutdown cleanup');
        assert.equal(fixture.calls.filter(call => call.route === '/v1/tickets/ABC-1/release').length, 1, 'shutdown must release after the recorded block');
      } else if (boundary === 'complete') {
        assert.equal(fixture.calls.filter(call => call.route === '/v1/tickets/ABC-1/complete').length, 1);
      } else {
        assert.equal(fixture.calls.filter(call => call.route === '/v1/tickets/ABC-1/release').length, 1);
      }
      lane.controller.persistent = false;
      await lane.runtime.shutdown();
    });
  }
});

test('a fresh post-terminal settled event still performs the intended native session rotation', async t => {
  const root = await isolatedViqConfig(t, 'viq-settled-fresh-');
  const module = await freshExtension(root, 'fresh-rotation');
  const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
  let rotations = 0, lane;
  const rotate = async options => {
    rotations++;
    await lane.active.handlers.get('session_shutdown')({}, lane.active.ctx);
    lane.active = createInstance(module.viqWorker, 'replacement', notifications, messages);
    await lane.active.handlers.get('session_start')({}, lane.active.ctx);
    await options.withSession({ newSession: async () => ({ cancelled: false }) });
    return { cancelled: false };
  };
  lane = await startedPersistent(module, fixture.implementation, notifications, messages, rotate);
  lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
  await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1'), 'settled GET did not start');
  await lane.active.tools.get('viq_complete').execute('complete', { outcome: 'Fixture complete' });
  ticketRead.resolve(Response.json({ ticket: { id: 'ABC-1', claim: { claim_id: 'fixture-claim-1', generation: 1 } } }));
  await flush();
  await flush();
  assert.equal(rotations, 0, 'retired observation must not rotate');
  lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
  await eventually(() => rotations === 1 && lane.runtime.status().ticket === 'ABC-2', 'fresh settled event did not rotate and claim in a replacement session');
  assert.equal(messages.length, 2);
  lane.controller.persistent = false;
  await lane.runtime.release('test cleanup');
});

test('retired settled rejection is contained while an active rejection remains visible', async t => {
  const root = await isolatedViqConfig(t, 'viq-settled-reject-');
  for (const retired of [true, false]) {
    await t.test(retired ? 'retired request' : 'active request', async () => {
      const module = await freshExtension(root, retired ? 'rejected-retired' : 'rejected-active');
      const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
      let rotations = 0;
      const lane = await startedPersistent(module, fixture.implementation, notifications, messages, async () => { rotations++; return { cancelled: false }; });
      const unhandled = await observeUnhandled(async () => {
        lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
        await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1'), 'settled GET did not start');
        if (retired) await lane.active.tools.get('viq_release').execute('release', { message: 'Fixture release' });
        ticketRead.reject(new Error('fixture deferred failure'));
      });
      assert.deepEqual(unhandled, []);
      assert.equal(rotations, 0);
      if (retired) {
        assert.equal(notifications.filter(item => item.level === 'error').length, 0, 'retired transport result has no active episode to alarm');
      } else {
        assert.equal(lane.runtime.status().ticket, 'ABC-1');
        assert.equal(notifications.filter(item => item.level === 'error').length, 1, 'active transport failure must remain visible');
        assert.match(notifications.find(item => item.level === 'error').message, /could not reach/i);
        await lane.runtime.release('test cleanup');
      }
      lane.controller.persistent = false;
      await lane.runtime.shutdown();
    });
  }
});

test('retired settled observation cannot heartbeat a replacement claim or decide for its session', async t => {
  const root = await isolatedViqConfig(t, 'viq-settled-replacement-');
  const module = await freshExtension(root, 'replacement-claim');
  const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
  let rotations = 0;
  const lane = await startedPersistent(module, fixture.implementation, notifications, messages, async () => { rotations++; return { cancelled: false }; });
  lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
  await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1'), 'settled GET did not start');
  await lane.active.tools.get('viq_release').execute('release', { message: 'Replace session' });
  await lane.active.handlers.get('session_shutdown')({}, lane.active.ctx);
  lane.active = createInstance(module.viqWorker, 'replacement-native-session', notifications, messages);
  await lane.active.handlers.get('session_start')({}, lane.active.ctx);
  await lane.runtime.start({ ticket: 'ABC-1', deliver: false });
  const replacement = lane.runtime.current;
  const heartbeatsBefore = fixture.calls.filter(call => call.route === '/v1/workers/heartbeat' && call.body?.claim_id === replacement.claim_id).length;
  ticketRead.resolve(Response.json({ ticket: { id: 'ABC-1', claim: { claim_id: replacement.claim_id, generation: replacement.generation } } }));
  await flush();
  await flush();
  const heartbeatsAfter = fixture.calls.filter(call => call.route === '/v1/workers/heartbeat' && call.body?.claim_id === replacement.claim_id).length;
  assert.equal(heartbeatsAfter, heartbeatsBefore, 'old observation must not heartbeat the replacement claim');
  assert.equal(rotations, 0);
  assert.equal(lane.runtime.current, replacement);
  lane.controller.persistent = false;
  await lane.runtime.release('test cleanup');
});

async function pairAndStartReplacement(lane, module, notifications, messages, replacementFile) {
  lane.runtime.credentialFile = replacementFile;
  await lane.active.commands.get('viq').handler('pair fixture-pairing-code', lane.active.ctx);
  assert.equal(lane.runtime.credential, replacementCredential);
  assert.equal(loadCredential(replacementFile), replacementCredential);
  await lane.active.handlers.get('session_shutdown')({}, lane.active.ctx);
  lane.active = createInstance(module.viqWorker, 'replacement-credential-session', notifications, messages);
  await lane.active.handlers.get('session_start')({}, lane.active.ctx);
  await lane.active.tools.get('viq_take').execute('replacement-take', { ticket_id: 'ABC-1', credential_file: replacementFile }, undefined, undefined, lane.active.ctx);
  assert.equal(lane.runtime.status().ticket, 'ABC-1');
  return lane.runtime.current;
}

const revokedResponse = () => Response.json({ error: { code: 'device_revoked' } }, { status: 401 });

test('retired settled 401 cannot invalidate a replacement credential selected through the extension', async t => {
  const root = await realpath(await isolatedViqConfig(t, 'viq-settled-retired-401-'));
  const initialFile = path.join(root, 'lane-a.json'), replacementFile = path.join(root, 'lane-b.json');
  saveCredential(credential, initialFile);
  const module = await freshExtension(root, 'retired-401-replacement');
  const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
  const lane = await startedPersistent(module, fixture.implementation, notifications, messages, undefined, initialFile);

  lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
  await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1' && call.authorization === `Bearer ${credential}`), 'settled GET under credential A did not start');
  await lane.active.tools.get('viq_release').execute('release', { message: 'Replace fixture credential' });
  const replacement = await pairAndStartReplacement(lane, module, notifications, messages, replacementFile);
  const replacementClaimToken = replacement.claim_token;

  ticketRead.resolve(revokedResponse());
  await flush();
  await flush();
  assert.equal(lane.runtime.current, replacement, 'retired GET must preserve the replacement claim identity');
  assert.equal(lane.runtime.current.claim_token, replacementClaimToken, 'retired GET must preserve the replacement claim token');
  assert.equal(lane.runtime.credential, replacementCredential, 'retired GET must preserve the replacement in-memory credential');
  assert.equal(loadCredential(replacementFile), replacementCredential, 'retired GET must preserve the replacement credential file');
  assert.equal(notifications.filter(item => item.level === 'error').length, 0, 'retired 401 has no active episode to alarm');

  lane.controller.persistent = false;
  await lane.runtime.release('test cleanup');
});

test('active settled 401 invalidates its exact credential file and remains visible', async t => {
  const root = await realpath(await isolatedViqConfig(t, 'viq-settled-active-401-'));
  const activeFile = path.join(root, 'active-lane.json');
  saveCredential(credential, activeFile);
  const module = await freshExtension(root, 'active-401');
  const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
  const lane = await startedPersistent(module, fixture.implementation, notifications, messages, undefined, activeFile);

  lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
  await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1'), 'active settled GET did not start');
  ticketRead.resolve(revokedResponse());
  await eventually(() => lane.runtime.credential === null && notifications.some(item => item.level === 'error'), 'active credential revocation was not invalidated and surfaced');
  assert.equal(lane.runtime.status().ticket, 'ABC-1', 'credential invalidation must not conceal the active claim');
  assert.throws(() => loadCredential(activeFile), /ENOENT/, 'active 401 must remove the exact credential file');
  assert.match(notifications.find(item => item.level === 'error').message, /device_revoked/, 'active 401 must remain visible');

  lane.runtime.setCredential(credential);
  lane.controller.persistent = false;
  await lane.runtime.release('test cleanup');
});

test('retired settlement heartbeat 401 cannot invalidate a replacement credential', async t => {
  const root = await realpath(await isolatedViqConfig(t, 'viq-settled-heartbeat-401-'));
  const initialFile = path.join(root, 'lane-a.json'), replacementFile = path.join(root, 'lane-b.json');
  saveCredential(credential, initialFile);
  const module = await freshExtension(root, 'retired-heartbeat-401');
  const ticketRead = deferred(), fixture = fixtureFetch(ticketRead), notifications = [], messages = [];
  const lane = await startedPersistent(module, fixture.implementation, notifications, messages, undefined, initialFile);

  lane.active.handlers.get('agent_settled')({}, lane.active.ctx);
  await eventually(() => fixture.calls.some(call => call.method === 'GET' && call.route === '/v1/tickets/ABC-1'), 'settled GET did not start');
  const heartbeatRead = fixture.holdNextHeartbeat();
  ticketRead.resolve(Response.json({ ticket: { id: 'ABC-1', claim: { claim_id: 'fixture-claim-1', generation: 1 } } }));
  await eventually(() => heartbeatRead.started, 'settlement-triggered heartbeat did not start');
  await lane.active.tools.get('viq_release').execute('release', { message: 'Replace fixture credential during heartbeat' });
  const replacement = await pairAndStartReplacement(lane, module, notifications, messages, replacementFile);
  const replacementClaimToken = replacement.claim_token;

  heartbeatRead.resolve(revokedResponse());
  await flush();
  await flush();
  assert.equal(lane.runtime.current, replacement, 'retired heartbeat must preserve the replacement claim identity');
  assert.equal(lane.runtime.current.claim_token, replacementClaimToken, 'retired heartbeat must preserve the replacement claim token');
  assert.equal(lane.runtime.credential, replacementCredential, 'retired heartbeat must preserve the replacement in-memory credential');
  assert.equal(loadCredential(replacementFile), replacementCredential, 'retired heartbeat must preserve the replacement credential file');
  assert.equal(notifications.filter(item => item.level === 'error').length, 0, 'retired heartbeat 401 has no active episode to alarm');

  lane.controller.persistent = false;
  await lane.runtime.release('test cleanup');
});
