import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { PrivateHubOpenCoordinator, type PrivateHubOpenSession, type PrivateHubOpenBrowser } from './private-hub-open';
import type { PrivateHubLifecycle } from './private-hub-browser';

const app = Object.assign(new EventEmitter(), { isReady: () => true, quits: 0, quit() { this.quits++; } });
const powerMonitor = new EventEmitter();
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let PrivateHubWorkspace: typeof import('./private-hub-workspace').PrivateHubWorkspace;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') { return { app, powerMonitor }; }
    return originalLoad.call(this, request, ...args);
  };
  PrivateHubWorkspace = require('./private-hub-workspace').PrivateHubWorkspace;
} finally { NodeModule._load = originalLoad; }

function deferred<T = void>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve: (value: T) => resolve(value) };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) { return; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Workspace stage did not complete.');
}

function fixture(t: TestContext, lifecycle: PrivateHubLifecycle = 'standalone') {
  app.quits = 0;
  const unlock = deferred<{ generation: number }>();
  const storageDrain = deferred();
  const signal = new AbortController();
  const transition = new AbortController();
  const closed = deferred();
  let unlocking = false;
  let locked = false;
  let browserCreated = false;
  let browserClosed = false;
  const hub: PrivateHubOpenSession = {
    unlock: () => { unlocking = true; return unlock.promise; },
    isCurrent: generation => generation === 1 && !locked,
    revocationSignal: () => signal.signal,
    lock: () => { locked = true; signal.abort(); return storageDrain.promise; },
    close: () => storageDrain.promise,
  };
  const browser: PrivateHubOpenBrowser = {
    get status(): PrivateHubOpenBrowser['status'] { return { state: browserClosed ? 'closed' : 'open', cleanupFailed: false }; },
    closed: closed.promise,
    close: () => { browserClosed = true; closed.resolve(); return closed.promise; },
    show: () => undefined,
  };
  const coordinator = new PrivateHubOpenCoordinator({
    createSession: () => hub, requestPassword: async () => 'synthetic password',
    createBrowser: async () => { browserCreated = true; return browser; },
  });
  const workspace = new PrivateHubWorkspace(coordinator, { lifecycle });
  const open = () => workspace.open({ directory: '/Users/sm/Workspace/synthetic-private-hub', isAuthorized: () => true, signal: transition.signal });
  t.after(async () => {
    const cancelled = workspace.cancel(); unlock.resolve({ generation: 1 }); storageDrain.resolve();
    await cancelled;
    assert.equal(powerMonitor.listenerCount('suspend'), 0);
    assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
    assert.equal(powerMonitor.listenerCount('shutdown'), 0);
    assert.equal(app.listenerCount('before-quit'), 0);
  });
  return { workspace, coordinator, open, unlock, storageDrain, browser, transition,
    unlocking: () => unlocking, locked: () => locked, browserCreated: () => browserCreated, browserClosed: () => browserClosed };
}

for (const event of ['suspend', 'lock-screen', 'shutdown']) {
  test(event + ' during password derivation revokes and drains before any private window is created', async t => {
    const f = fixture(t); const opening = f.open();
    await until(f.unlocking);
    powerMonitor.emit(event);
    assert.equal(f.locked(), true);
    assert.equal(f.workspace.status.state, 'closing');
    f.unlock.resolve({ generation: 1 });
    f.storageDrain.resolve();
    assert.equal(await opening, 'cancelled');
    assert.equal(f.browserCreated(), false);
    assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  });
}

test('quit stays intercepted during unlock and storage drain, including repeated requests', async t => {
  const f = fixture(t); const opening = f.open();
  await until(f.unlocking);
  let prevented = 0;
  const event = { preventDefault: () => { prevented++; } };
  app.emit('before-quit', event); app.emit('before-quit', event);
  assert.equal(prevented, 2); assert.equal(app.quits, 0); assert.equal(f.locked(), true);
  f.unlock.resolve({ generation: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.quits, 0); assert.equal(app.listenerCount('before-quit'), 1);
  f.storageDrain.resolve(); await opening;
  await until(() => app.quits === 1);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(await f.open(), 'unavailable');
});

test('natural browser close retains system observers until the complete session drain finishes', async t => {
  const f = fixture(t); const opening = f.open();
  await until(f.unlocking); f.unlock.resolve({ generation: 1 });
  assert.equal(await opening, 'opened');
  await f.browser.close();
  assert.equal(f.workspace.status.state, 'closing');
  assert.equal(app.listenerCount('before-quit'), 1);
  f.storageDrain.resolve(); await f.coordinator.settled;
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('second open cannot replace the observed transition or its pending lifetime', async t => {
  const f = fixture(t); const opening = f.open();
  assert.equal(await f.open(), 'busy');
  assert.equal(app.listenerCount('before-quit'), 1);
  const cancelled = f.workspace.cancel();
  f.unlock.resolve({ generation: 1 }); f.storageDrain.resolve();
  await cancelled; assert.equal(await opening, 'cancelled');
});

test('external lifecycle owner retains the sole quit decision through delayed unlock and storage cleanup', async t => {
  const f = fixture(t, 'external');
  const opening = f.open();
  const settled = f.workspace.settled;
  assert.equal(settled, f.coordinator.settled);
  let complete = false;
  void settled.then(() => { complete = true; });
  await until(f.unlocking);
  for (const event of ['suspend', 'lock-screen', 'shutdown']) {
    assert.equal(powerMonitor.listenerCount(event), 0);
  }
  assert.equal(app.listenerCount('before-quit'), 0);
  f.transition.abort();
  assert.equal(f.locked(), true);
  assert.equal(f.workspace.status.state, 'closing');
  f.unlock.resolve({ generation: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, false);
  assert.equal(app.quits, 0);
  f.storageDrain.resolve();
  assert.equal(await opening, 'cancelled');
  await settled;
  assert.equal(complete, true);
  assert.equal(app.quits, 0);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
});

test('external lifecycle mode cannot open without an abort lifetime', async t => {
  const f = fixture(t, 'external');
  assert.equal(await f.workspace.open({
    directory: '/Users/sm/Workspace/synthetic-private-hub', isAuthorized: () => true,
  }), 'unavailable');
  assert.equal(f.unlocking(), false);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
});

test('lifecycle ownership is captured before mutable caller options can change', async t => {
  const f = fixture(t);
  const options: { lifecycle: PrivateHubLifecycle } = { lifecycle: 'external' };
  const workspace = new PrivateHubWorkspace(f.coordinator, options);
  options.lifecycle = 'standalone';
  const opening = workspace.open({
    directory: '/Users/sm/Workspace/synthetic-private-hub', isAuthorized: () => true, signal: f.transition.signal,
  });
  await until(f.unlocking);
  assert.equal(app.listenerCount('before-quit'), 0);
  assert.equal(powerMonitor.listenerCount('lock-screen'), 0);
  f.transition.abort();
  f.unlock.resolve({ generation: 1 }); f.storageDrain.resolve();
  assert.equal(await opening, 'cancelled');
  await workspace.settled;
  assert.equal(app.quits, 0);
});
