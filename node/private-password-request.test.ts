import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { WebContents } from 'electron';
import { createPrivateTouchIdCleanupFailure, isPrivateTouchIdCleanupFailure } from './private-touch-id';

const ENTRY_URL = 'theatrum://app/index.html';
type Handler = (event: any, ...args: unknown[]) => boolean | Promise<boolean>;
const handlers = new Map<string, Handler>();
const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel: string, handler: Handler): void {
    if (handlers.has(channel)) { throw new Error('existing handler diagnostics'); }
    handlers.set(channel, handler);
  },
  removeHandler(channel: string): void { handlers.delete(channel); },
});
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let register: typeof import('./private-password-request').registerPrivatePasswordRequest;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') { return { ipcMain }; }
    return originalLoad.call(this, request, ...args);
  };
  register = require('./private-password-request').registerPrivatePasswordRequest;
} finally { NodeModule._load = originalLoad; }

class Contents extends EventEmitter {
  destroyed = false;
  url = ENTRY_URL;
  mainFrame = { url: ENTRY_URL, parent: null, detached: false, isDestroyed: () => false };
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
}

function fixture(t: TestContext, url = ENTRY_URL) {
  const contents = new Contents();
  contents.url = url;
  contents.mainFrame.url = url;
  const submitted: string[] = [];
  let cancelled = 0;
  let current = true;
  let guardThrows = false;
  const callbackHooks = {
    onSubmit: (password: string): void => { submitted.push(password); },
    onCancel: (): void => { cancelled++; },
  };
  const options = {
    contents: contents as unknown as WebContents,
    isCurrent: () => { if (guardThrows) { throw new Error('private path secret'); } return current; },
    onSubmit: (password: string): void => { callbackHooks.onSubmit(password); },
    onCancel: (): void => { callbackHooks.onCancel(); },
  };
  const dispose = register(options);
  t.after(() => { dispose(); assert.equal(handlers.size, 0); assert.equal(ipcMain.listenerCount('private-password-cancel'), 0); });
  const submit = handlers.get('private-password-submit')!;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return {
    contents, options, submitted, dispose, event, submit, callbackHooks,
    stale: () => { current = false; },
    throwGuard: (value: boolean) => { guardThrows = value; },
    cancelled: () => cancelled,
    cancel: (...args: unknown[]) => ipcMain.emit('private-password-cancel', event, ...args),
  };
}

test('accepts exactly one unchanged Unicode password from its owning main frame', t => {
  const f = fixture(t);
  const password = '  secret 🦉 e\u0301\t';
  assert.equal(f.submit(f.event, password), true);
  assert.deepEqual(f.submitted, [password]);
  assert.equal(f.submit(f.event, 'second'), false);
  f.cancel();
  assert.equal(f.cancelled(), 0);
});

test('cancellation consumes the prompt and rejects later password submissions', t => {
  const f = fixture(t);
  f.cancel(); f.cancel();
  assert.equal(f.cancelled(), 1);
  assert.equal(f.submit(f.event, 'secret'), false);
  assert.deepEqual(f.submitted, []);
});

test('rejects cross-window, subframe, detached, replaced and missing sender frames', t => {
  const f = fixture(t);
  const other = new Contents();
  const frame = f.contents.mainFrame;
  for (const event of [
    { sender: other, senderFrame: frame },
    { sender: f.contents, senderFrame: other.mainFrame },
    { sender: f.contents, senderFrame: null },
    { sender: f.contents },
    null,
  ]) {
    assert.equal(f.submit(event, 'secret'), false);
    ipcMain.emit('private-password-cancel', event);
  }
  frame.detached = true;
  assert.equal(f.submit(f.event, 'secret'), false);
  frame.detached = false;
  frame.parent = other.mainFrame as any;
  assert.equal(f.submit(f.event, 'secret'), false);
  frame.parent = null;
  frame.isDestroyed = () => true;
  assert.equal(f.submit(f.event, 'secret'), false);
  frame.isDestroyed = () => false;
  f.contents.mainFrame = other.mainFrame;
  assert.equal(f.submit(f.event, 'secret'), false);
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
});

test('requires exact frame and document URL without query, hash, port or lookalike host', t => {
  const f = fixture(t);
  for (const url of ['https://app/index.html', 'theatrum://app:443/index.html',
    ENTRY_URL + '?v=1', ENTRY_URL + '#', 'theatrum://app/other.html',
    'theatrum://app.evil/index.html', 'about:blank', 'file:///index.html']) {
    f.contents.mainFrame.url = url;
    assert.equal(f.submit(f.event, 'secret'), false);
    f.contents.mainFrame.url = ENTRY_URL;
    f.contents.url = url;
    assert.equal(f.submit(f.event, 'secret'), false);
    f.cancel();
    f.contents.url = ENTRY_URL;
  }
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
  assert.equal(f.submit(f.event, 'secret'), true);
});

test('rejects malformed payloads, extra arguments and invalid Unicode without consuming a valid prompt', t => {
  const f = fixture(t);
  for (const args of [[], [null], [undefined], [7], [{}], [{ password: 'secret' }],
    [new String('secret')], [''], ['\ud800'], ['\udc00'], ['x\ud800x'],
    ['x'.repeat(1025)], ['é'.repeat(513)], ['😀'.repeat(257)], ['secret', 'extra']]) {
    assert.equal(f.submit(f.event, ...args), false);
  }
  f.cancel('extra');
  assert.equal(f.cancelled(), 0);
  assert.equal(f.submit(f.event, '😀'.repeat(256)), true);
  assert.equal(Buffer.byteLength(f.submitted[0], 'utf8'), 1024);
});

test('an all-whitespace password is not normalized or rejected', t => {
  const f = fixture(t);
  assert.equal(f.submit(f.event, ' \t\n'), true);
  assert.deepEqual(f.submitted, [' \t\n']);
});

test('rejects stale lifecycle and destroyed contents before callbacks', t => {
  const f = fixture(t);
  f.contents.destroyed = true;
  assert.equal(f.submit(f.event, 'secret'), false);
  f.cancel();
  f.contents.destroyed = false;
  f.stale();
  assert.equal(f.submit(f.event, 'secret'), false);
  f.cancel();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
});

test('accepts only the initial navigation and invalidates reload or return navigation', t => {
  const f = fixture(t, '');
  assert.equal(f.submit(f.event, 'secret'), false);
  f.contents.emit('did-start-navigation', { url: ENTRY_URL, isMainFrame: true, isSameDocument: false });
  f.contents.url = ENTRY_URL;
  f.contents.mainFrame.url = ENTRY_URL;
  // A subframe does not get authority and cannot retire the main prompt.
  f.contents.emit('did-start-navigation', { url: 'about:blank', isMainFrame: false, isSameDocument: false });
  f.contents.emit('did-start-navigation', { url: ENTRY_URL, isMainFrame: true, isSameDocument: false });
  assert.equal(f.submit(f.event, 'secret'), false);
  f.cancel();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
});

test('first exact navigation from about:blank can submit', t => {
  const f = fixture(t, 'about:blank');
  f.contents.emit('did-start-navigation', { url: ENTRY_URL, isMainFrame: true, isSameDocument: false });
  f.contents.url = ENTRY_URL; f.contents.mainFrame.url = ENTRY_URL;
  assert.equal(f.submit(f.event, 'secret'), true);
});

for (const eventName of ['destroyed', 'render-process-gone'] as const) {
  test(`${eventName} permanently revokes the request even if native getters still look live`, t => {
    const f = fixture(t);
    f.contents.emit(eventName);
    assert.equal(f.submit(f.event, 'secret'), false);
    f.cancel();
    assert.deepEqual(f.submitted, []);
    assert.equal(f.cancelled(), 0);
  });
}

test('wrong initial navigation revokes rather than re-authorizing a return to the entry', t => {
  const f = fixture(t, '');
  f.contents.emit('did-start-navigation', { url: 'https://invalid.example/', isMainFrame: true, isSameDocument: false });
  f.contents.emit('did-start-navigation', { url: ENTRY_URL, isMainFrame: true, isSameDocument: false });
  f.contents.url = ENTRY_URL; f.contents.mainFrame.url = ENTRY_URL;
  assert.equal(f.submit(f.event, 'secret'), false);
});

test('same-document navigation permanently revokes a loaded prompt', t => {
  const f = fixture(t);
  f.contents.emit('did-start-navigation', { url: ENTRY_URL + '#change', isMainFrame: true, isSameDocument: true });
  assert.equal(f.submit(f.event, 'secret'), false);
  f.cancel();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
});

test('guards cannot leak exceptions or password diagnostics to renderer', t => {
  const f = fixture(t);
  f.throwGuard(true);
  assert.equal(f.submit(f.event, 'secret'), false);
  assert.doesNotThrow(() => f.cancel());
  f.throwGuard(false);
  f.callbackHooks.onSubmit = () => { throw new Error('password secret'); };
  assert.equal(f.submit(f.event, 'secret'), false);
  assert.equal(f.submit(f.event, 'secret'), false);
});

test('callbacks cannot re-enter and consume another response', t => {
  const f = fixture(t);
  f.callbackHooks.onSubmit = () => {
    assert.equal(f.submit(f.event, 'second'), false);
    f.cancel();
  };
  assert.equal(f.submit(f.event, 'secret'), true);
  assert.equal(f.cancelled(), 0);
});

test('mutating options after registration cannot redirect callbacks or replace lifecycle authority', t => {
  const f = fixture(t);
  f.options.contents = new Contents() as unknown as WebContents;
  f.options.isCurrent = () => false;
  f.options.onSubmit = () => { assert.fail('replaced callback'); };
  f.options.onCancel = () => { assert.fail('replaced cancellation callback'); };
  assert.equal(f.submit(f.event, 'original'), true);
  assert.deepEqual(f.submitted, ['original']);
});

test('replacing the options guard cannot revive stale lifecycle authority', t => {
  const f = fixture(t);
  f.stale();
  f.options.isCurrent = () => true;
  assert.equal(f.submit(f.event, 'secret'), false);
  f.cancel();
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
});

test('replacing the options cancellation callback cannot redirect an accepted cancellation', t => {
  const f = fixture(t);
  let redirected = false;
  f.options.onCancel = () => { redirected = true; };
  f.cancel();
  assert.equal(f.cancelled(), 1);
  assert.equal(redirected, false);
});

test('disposal revokes captured handlers and removes only the active binding', t => {
  const f = fixture(t);
  const cancel = ipcMain.listeners('private-password-cancel')[0];
  f.dispose(); f.dispose();
  assert.equal(f.submit(f.event, 'secret'), false);
  cancel(f.event);
  assert.deepEqual(f.submitted, []);
  assert.equal(f.cancelled(), 0);
  assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  assert.equal(f.contents.listenerCount('destroyed'), 0);
  assert.equal(f.contents.listenerCount('render-process-gone'), 0);
  const next = register(f.options);
  try {
    f.dispose();
    assert.equal(handlers.get('private-password-submit')!(f.event, 'next'), true);
  } finally { next(); }
});

test('a concurrent registration cannot replace the existing request', t => {
  const f = fixture(t);
  assert.throws(() => register(f.options), /^Error: Private password request unavailable$/);
  assert.equal(handlers.get('private-password-submit'), f.submit);
  assert.equal(ipcMain.listenerCount('private-password-cancel'), 1);
  assert.equal(f.submit(f.event, 'secret'), true);
});

test('a foreign invoke handler is not removed when registration fails', () => {
  const foreign = (): boolean => false;
  handlers.set('private-password-submit', foreign);
  const contents = new Contents();
  const options = { contents: contents as unknown as WebContents, isCurrent: () => true,
    onSubmit: () => undefined, onCancel: () => undefined };
  try {
    assert.throws(() => register(options), /^Error: Private password request unavailable$/);
    assert.equal(handlers.get('private-password-submit'), foreign);
    assert.equal(ipcMain.listenerCount('private-password-cancel'), 0);
  } finally { handlers.delete('private-password-submit'); }
  const dispose = register(options);
  dispose();
});

test('registration refuses invalid callbacks, destroyed windows, stale lifecycle and unexpected initial URLs', () => {
  const contents = new Contents();
  const options = { contents: contents as unknown as WebContents, isCurrent: () => true,
    onSubmit: () => undefined, onCancel: () => undefined };
  for (const value of [null, {}, { ...options, onSubmit: null }, { ...options, onCancel: null },
    { ...options, isCurrent: null }, { ...options, isCurrent: () => false }]) {
    assert.throws(() => register(value as any), /^Error: Private password request unavailable$/);
  }
  contents.destroyed = true;
  assert.throws(() => register(options), /^Error: Private password request unavailable$/);
  contents.destroyed = false;
  contents.url = 'https://invalid.example/';
  assert.throws(() => register(options), /^Error: Private password request unavailable$/);
  assert.equal(handlers.size, 0);
});


test('Touch ID choice is main-enabled, exact-frame bound, and consumes the password prompt', async t => {
  const base = fixture(t); await base.dispose();
  let selected = 0; let checks = 0;
  const dispose = register({ ...base.options, touchIdAvailable: async () => { checks++; return true; }, onTouchId: () => { selected++; } });
  try {
    const probe = handlers.get('private-password-touch-id-available')!;
    const select = handlers.get('private-password-touch-id')!;
    assert.equal(select(base.event), false);
    assert.equal(await probe({ ...base.event, senderFrame: { ...base.contents.mainFrame } }), false);
    assert.equal(checks, 0);
    assert.equal(await probe(base.event, 'extra'), false);
    assert.equal(await probe(base.event), true);
    assert.equal(select(base.event), true);
    assert.equal(selected, 1);
    assert.equal(select(base.event), false);
    assert.equal(handlers.get('private-password-submit')!(base.event, 'secret'), false);
  } finally { await dispose(); }
});

test('disposal waits for the availability query and discards its late response', async t => {
  const base = fixture(t); await base.dispose();
  let resolve!: (value: boolean) => void;
  const query = new Promise<boolean>(yes => { resolve = yes; });
  const dispose = register({ ...base.options, touchIdAvailable: () => query, onTouchId: () => assert.fail('late choice') });
  const probe = handlers.get('private-password-touch-id-available')!(base.event);
  await Promise.resolve();
  let drained = false; const cleanup = dispose().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.throws(() => register(base.options), /unavailable/);
  resolve(true); assert.equal(await probe, false); await cleanup;
});

test('failed or absent Touch ID availability leaves password submission usable', async t => {
  const base = fixture(t); await base.dispose();
  const dispose = register({ ...base.options, touchIdAvailable: async () => { throw new Error('native diagnostics'); }, onTouchId: () => assert.fail() });
  try {
    assert.equal(await handlers.get('private-password-touch-id-available')!(base.event), false);
    assert.equal(handlers.get('private-password-touch-id')!(base.event), false);
    assert.equal(handlers.get('private-password-submit')!(base.event, 'password fallback'), true);
    assert.deepEqual(base.submitted, ['password fallback']);
  } finally { await dispose(); }
});


test('a poisoned availability query makes prompt disposal reject and preserves quarantine', async () => {
  const contents = new Contents(); let cancelled = 0;
  const options = { contents: contents as unknown as WebContents, isCurrent: () => true,
    onSubmit: () => assert.fail(), onCancel: () => { cancelled++; }, onTouchId: () => assert.fail(),
    touchIdAvailable: async () => { throw createPrivateTouchIdCleanupFailure(); } };
  const dispose = register(options);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(await handlers.get('private-password-touch-id-available')!(event), false);
  assert.equal(cancelled, 1);
  await assert.rejects(dispose(), isPrivateTouchIdCleanupFailure);
  assert.equal(handlers.size, 0);
  assert.throws(() => register(options), /unavailable/);
});
