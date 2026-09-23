import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { WebContents } from 'electron';
import type { PrivateConversionProgress, PrivateConversionState } from '../interfaces/private-conversion';
import type { registerPrivateConversionRequest } from './private-conversion-request';
import { privateConversionFailure } from './private-conversion-errors';

const ENTRY_URL = 'theatrum://app/index.html';
type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel: string, handler: Handler): void {
    if (handlers.has(channel)) { throw new Error('Existing private diagnostics'); }
    handlers.set(channel, handler);
  },
  removeHandler(channel: string): void { handlers.delete(channel); },
});
const brandedCleanupError = new Error('Synthetic cleanup failure');
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let register: typeof registerPrivateConversionRequest;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') { return { ipcMain }; }
    if (request === './private-hub-conversion') {
      return { isPrivateHubConversionCleanupFailure: (error: unknown) => error === brandedCleanupError };
    }
    return originalLoad.call(this, request, ...args);
  };
  register = require('./private-conversion-request').registerPrivateConversionRequest;
} finally { NodeModule._load = originalLoad; }

interface MockFrame { url: string; parent: MockFrame | null; detached: boolean; isDestroyed(): boolean; }
class Contents extends EventEmitter {
  destroyed = false;
  url = ENTRY_URL;
  mainFrame: MockFrame = { url: ENTRY_URL, parent: null, detached: false, isDestroyed: () => false };
  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return this.url; }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function review() {
  return { videos: 2, availablePreviews: 4, previewBytes: 1234,
    missingPreviews: { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 } };
}
function fixture(t: TestContext, initialUrl = ENTRY_URL, counts = review()) {
  const contents = new Contents(); contents.url = initialUrl; contents.mainFrame.url = initialUrl;
  let current = true; let guardThrows = false; let cancelled = 0; let completed = 0;
  const started: unknown[][] = [];
  let progress!: (value: PrivateConversionProgress) => void;
  const hooks = {
    start: async (_password: string, _allowMissing: boolean): Promise<'completed' | 'cancelled'> => 'completed',
    onCancel: (): void => { cancelled++; },
    onComplete: (): void => { completed++; },
  };
  const options = { contents: contents as unknown as WebContents,
    isCurrent: () => { if (guardThrows) { throw new Error('Private path'); } return current; }, review: counts,
    start: (password: string, allowMissing: boolean, onProgress: (value: PrivateConversionProgress) => void) => {
      started.push([password, allowMissing]); progress = onProgress; return hooks.start(password, allowMissing);
    }, onCancel: () => hooks.onCancel(), onComplete: () => hooks.onComplete() };
  const dispose = register(options);
  t.after(async () => { await dispose(); assert.equal(handlers.size, 0); assert.equal(ipcMain.listenerCount('private-conversion-cancel'), 0); });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const submit = handlers.get('private-conversion-submit')!;
  const state = handlers.get('private-conversion-state')!;
  return { contents, event, options, hooks, started, submit, state, dispose,
    progress: (value: unknown) => progress(value as PrivateConversionProgress),
    cancel: (...args: unknown[]) => ipcMain.emit('private-conversion-cancel', event, ...args),
    current: (value: boolean) => { current = value; }, guardThrows: (value: boolean) => { guardThrows = value; },
    cancelled: () => cancelled, completed: () => completed };
}

test('review state clones and freezes only count fields before handing them to the document', t => {
  const original = Object.assign(review(), { path: '/synthetic/private', password: 'secret' });
  Object.assign(original.missingPreviews, { hash: 'private-hash' });
  const f = fixture(t, ENTRY_URL, original);
  const state = f.state(f.event) as PrivateConversionState;
  assert.deepEqual(state, { phase: 'review', review: review(), completed: 0, total: 0 });
  assert.ok(Object.isFrozen(state)); assert.ok(Object.isFrozen(state.review)); assert.ok(Object.isFrozen(state.review.missingPreviews));
  assert.notEqual(state.review, original);
  original.videos = 100;
  original.missingPreviews.thumbnail = 8;
  assert.deepEqual(f.state(f.event), state);
  assert.doesNotMatch(JSON.stringify(state), /synthetic|secret|private-hash/);
});

test('one accepted Unicode password selects and completes without normalization', async t => {
  const f = fixture(t); const work = deferred<'completed'>(); f.hooks.start = () => work.promise;
  const password = '  secret 🦉 e\u0301\t';
  const pending = f.submit(f.event, password, false, true);
  assert.equal((f.state(f.event) as PrivateConversionState).phase, 'selecting');
  await Promise.resolve();
  assert.deepEqual(f.started, [[password, false]]);
  assert.equal(await f.submit(f.event, 'again', false, true), false);
  f.progress({ stage: 'copying', completed: 2, total: 4, path: 'secret' });
  assert.deepEqual(f.state(f.event), { phase: 'copying', review: review(), completed: 2, total: 4 });
  work.resolve('completed');
  assert.equal(await pending, true); assert.equal(f.completed(), 1);
  assert.equal(f.state(f.event), undefined); f.cancel(); assert.equal(f.cancelled(), 0);
});

test('explicit original-copy acknowledgement and missing-preview consent are required', async t => {
  const counts = review(); counts.missingPreviews.thumbnail = 1;
  const f = fixture(t, ENTRY_URL, counts);
  for (const args of [['pw', false, true], ['pw', true, false], ['pw', true, 'true'], ['pw', true], ['pw', 1, true]]) {
    assert.equal(await f.submit(f.event, ...args), false);
  }
  assert.deepEqual(f.started, []);
  assert.equal(await f.submit(f.event, 'pw', true, true), true);
  assert.deepEqual(f.started, [['pw', true]]);
});

test('malformed passwords and extra arguments do not consume submission', async t => {
  const f = fixture(t);
  for (const password of [null, undefined, 7, {}, new String('pw'), '', '\ud800', '\udc00', 'x\ud800x',
    'x'.repeat(1025), 'é'.repeat(513), '😀'.repeat(257)]) {
    assert.equal(await f.submit(f.event, password, false, true), false);
  }
  assert.equal(await f.submit(f.event, 'pw', false, true, 'extra'), false);
  assert.equal(await f.submit(f.event), false);
  assert.deepEqual(f.started, []);
  assert.equal(await f.submit(f.event, '😀'.repeat(256), false, true), true);
  assert.equal(Buffer.byteLength(f.started[0][0] as string), 1024);
});

test('whitespace is an unchanged valid password', async t => {
  const f = fixture(t); assert.equal(await f.submit(f.event, ' \t\n', false, true), true);
  assert.deepEqual(f.started, [[' \t\n', false]]);
});

test('state and cancellation reject extra arguments', t => {
  const f = fixture(t);
  assert.equal(f.state(f.event, 'extra'), undefined);
  f.cancel('extra'); assert.equal(f.cancelled(), 0);
  f.cancel(); f.cancel(); assert.equal(f.cancelled(), 1);
  assert.equal(f.state(f.event), undefined);
});

test('cancellation before the queued start prevents work from beginning', async t => {
  const f = fixture(t); const pending = f.submit(f.event, 'pw', false, true); f.cancel();
  assert.equal(await pending, false); assert.deepEqual(f.started, []); assert.equal(f.cancelled(), 1);
});

test('cancellation during work suppresses completion and drains before admitting another form', async t => {
  const f = fixture(t); const work = deferred<'completed'>(); f.hooks.start = () => work.promise;
  const pending = f.submit(f.event, 'pw', false, true); await Promise.resolve();
  f.cancel(); assert.equal(f.cancelled(), 1);
  let drained = false; const disposal = f.dispose().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  assert.throws(() => register(f.options), /unavailable/);
  f.progress({ stage: 'complete', completed: 4, total: 4 });
  assert.equal(f.state(f.event), undefined);
  work.resolve('completed'); assert.equal(await pending, false); await disposal;
  assert.equal(f.completed(), 0);
  const next = register(f.options); await next();
});

test('native picker cancellation retires once without completing', async t => {
  const f = fixture(t); f.hooks.start = async () => 'cancelled';
  assert.equal(await f.submit(f.event, 'pw', false, true), false);
  assert.equal(f.cancelled(), 1); assert.equal(f.completed(), 0);
});

test('ordinary conversion failure displays only failed state and never permits retry or late progress', async t => {
  const f = fixture(t); f.hooks.start = async () => { throw new Error('Secret password /private/path'); };
  assert.equal(await f.submit(f.event, 'pw', false, true), false);
  assert.deepEqual(f.state(f.event), { phase: 'failed', review: review(), completed: 0, total: 0, failure: 'conversion-failed' });
  f.progress({ stage: 'copying', completed: 1, total: 4 });
  assert.equal((f.state(f.event) as PrivateConversionState).phase, 'failed');
  assert.equal(await f.submit(f.event, 'again', false, true), false);
  assert.equal(f.started.length, 1); f.cancel(); assert.equal(f.cancelled(), 1);
});

test('failed state contains a safe category and last progress without native diagnostics', async t => {
  const f = fixture(t); const work = deferred<'completed'>(); f.hooks.start = () => work.promise;
  const pending = f.submit(f.event, 'SECRET PASSWORD', false, true); await Promise.resolve();
  f.progress({ stage: 'copying', completed: 2, total: 4 });
  work.reject(Object.assign(new Error('SECRET PASSWORD /PRIVATE/PATH'), { code: 'ENOSPC', path: '/PRIVATE/PATH' }));
  assert.equal(await pending, false);
  assert.deepEqual(f.state(f.event), { phase: 'failed', review: review(), completed: 2, total: 4, failure: 'storage-full' });
  assert.doesNotMatch(JSON.stringify(f.state(f.event)), /SECRET|PRIVATE/);
});

test('destination rejection publishes only its main-owned identity category', async t => {
  const f = fixture(t); f.hooks.start = async () => { throw privateConversionFailure('destination-unavailable'); };
  assert.equal(await f.submit(f.event, 'pw', false, true), false);
  assert.equal((f.state(f.event) as PrivateConversionState).failure, 'destination-unavailable');
});

test('synchronous start exceptions also leave only a failed form', async t => {
  const f = fixture(t); f.hooks.start = () => { throw new Error('Private diagnostic'); };
  assert.equal(await f.submit(f.event, 'pw', false, true), false);
  assert.equal((f.state(f.event) as PrivateConversionState).phase, 'failed');
});

test('invalid progress is ignored and cannot leak extra fields', async t => {
  const f = fixture(t); const work = deferred<'completed'>(); f.hooks.start = () => work.promise;
  const pending = f.submit(f.event, 'pw', false, true); await Promise.resolve();
  for (const progress of [null, {}, { stage: 'secret', completed: 0, total: 1 }, { stage: 'copying', completed: -1, total: 4 },
    { stage: 'copying', completed: 5, total: 4 }, { stage: 'copying', completed: 0.5, total: 4 },
    { stage: 'copying', completed: 0, total: Infinity }, { stage: 'copying', completed: 0, total: Number.MAX_SAFE_INTEGER + 1 }]) {
    f.progress(progress); assert.equal((f.state(f.event) as PrivateConversionState).phase, 'selecting');
  }
  f.progress({ stage: 'verifying', completed: 0, total: 1, secret: 'private' });
  assert.deepEqual(f.state(f.event), { phase: 'verifying', review: review(), completed: 0, total: 1 });
  work.resolve('completed'); await pending;
});

test('all request methods reject cross-window, subframe, missing, detached and replaced frames', async t => {
  const f = fixture(t); const other = new Contents();
  for (const event of [null, {}, { sender: other, senderFrame: f.contents.mainFrame },
    { sender: f.contents, senderFrame: other.mainFrame }, { sender: f.contents, senderFrame: null }]) {
    assert.equal(f.state(event), undefined); assert.equal(await f.submit(event, 'pw', false, true), false);
    ipcMain.emit('private-conversion-cancel', event);
  }
  const frame = f.contents.mainFrame;
  frame.detached = true; assert.equal(f.state(f.event), undefined); frame.detached = false;
  frame.parent = other.mainFrame; assert.equal(f.state(f.event), undefined); frame.parent = null;
  frame.isDestroyed = () => true; assert.equal(f.state(f.event), undefined); frame.isDestroyed = () => false;
  f.contents.mainFrame = other.mainFrame;
  assert.equal(f.state({ sender: f.contents, senderFrame: other.mainFrame }), undefined);
  assert.equal(await f.submit({ sender: f.contents, senderFrame: other.mainFrame }, 'pw', false, true), false);
  assert.equal(f.cancelled(), 0); assert.deepEqual(f.started, []);
});

test('document and frame URLs must match the exact isolated entry', async t => {
  const f = fixture(t);
  for (const url of ['https://app/index.html', ENTRY_URL + '#x', ENTRY_URL + '?v=1', 'theatrum://app:443/index.html',
    'theatrum://app.evil/index.html', 'theatrum://app/other.html', 'about:blank']) {
    f.contents.url = url; assert.equal(f.state(f.event), undefined);
    f.contents.url = ENTRY_URL; f.contents.mainFrame.url = url;
    assert.equal(await f.submit(f.event, 'pw', false, true), false); f.cancel();
    f.contents.mainFrame.url = ENTRY_URL;
  }
  assert.equal(f.cancelled(), 0); assert.deepEqual(f.started, []);
});

for (const initialUrl of ['', 'about:blank']) {
  test(`only the initial exact navigation from ${initialUrl || 'empty'} becomes trusted`, async t => {
    const f = fixture(t, initialUrl); assert.equal(f.state(f.event), undefined);
    f.contents.emit('did-start-navigation', { url: ENTRY_URL, isMainFrame: true, isSameDocument: false });
    f.contents.url = ENTRY_URL; f.contents.mainFrame.url = ENTRY_URL;
    assert.equal((f.state(f.event) as PrivateConversionState).phase, 'review');
    f.contents.emit('did-start-navigation', { url: 'about:blank', isMainFrame: false, isSameDocument: false });
    assert.equal(await f.submit(f.event, 'pw', false, true), true);
  });
}

for (const event of ['destroyed', 'render-process-gone', 'reload', 'same-document', 'wrong-navigation']) {
  test(`${event} permanently revokes the form`, async t => {
    const f = fixture(t, event === 'wrong-navigation' ? '' : ENTRY_URL);
    if (event === 'destroyed' || event === 'render-process-gone') { f.contents.emit(event); }
    else { f.contents.emit('did-start-navigation', { url: event === 'wrong-navigation' ? 'https://invalid.example/' : ENTRY_URL,
      isMainFrame: true, isSameDocument: event === 'same-document' }); }
    f.contents.url = ENTRY_URL; f.contents.mainFrame.url = ENTRY_URL;
    assert.equal(f.state(f.event), undefined); assert.equal(await f.submit(f.event, 'pw', false, true), false);
    f.cancel(); assert.equal(f.cancelled(), 0);
  });
}

test('destroyed contents, stale lifecycle and throwing guards never invoke main work', async t => {
  const f = fixture(t); f.contents.destroyed = true;
  assert.equal(f.state(f.event), undefined); f.contents.destroyed = false; f.current(false);
  assert.equal(await f.submit(f.event, 'pw', false, true), false);
  f.current(true); f.guardThrows(true); assert.equal(f.state(f.event), undefined); f.cancel();
  assert.deepEqual(f.started, []); assert.equal(f.cancelled(), 0);
});

test('option mutation cannot redirect callbacks or replace the captured lifetime guard', async t => {
  const f = fixture(t);
  f.options.isCurrent = () => false; f.options.start = async () => assert.fail('Replaced start');
  f.options.onComplete = () => assert.fail('Replaced completion'); f.options.onCancel = () => assert.fail('Replaced cancellation');
  assert.equal(await f.submit(f.event, 'pw', false, true), true); assert.equal(f.completed(), 1);
});

test('retirement from start is reentrant and disposal still waits for work', async t => {
  const f = fixture(t); const work = deferred<'completed'>(); let disposal!: Promise<void>;
  f.hooks.start = () => { disposal = f.dispose(); return work.promise; };
  const pending = f.submit(f.event, 'pw', false, true); await Promise.resolve();
  assert.ok(disposal); assert.throws(() => register(f.options), /unavailable/);
  work.resolve('completed'); assert.equal(await pending, false); await disposal;
  assert.equal(f.completed(), 0);
});

test('completion can synchronously dispose without waiting on its own callback', async t => {
  const f = fixture(t); let disposal!: Promise<void>;
  f.hooks.onComplete = () => { disposal = f.dispose(); };
  assert.equal(await f.submit(f.event, 'pw', false, true), true); await disposal;
  assert.equal(handlers.size, 0);
});

test('disposal removes handlers, revokes captured callbacks and is idempotent', async t => {
  const f = fixture(t); const cancel = ipcMain.listeners('private-conversion-cancel')[0];
  const disposal = f.dispose(); assert.equal(f.dispose(), disposal); await disposal;
  assert.equal(await f.submit(f.event, 'pw', false, true), false); assert.equal(f.state(f.event), undefined);
  cancel(f.event); assert.equal(f.cancelled(), 0);
  for (const name of ['did-start-navigation', 'destroyed', 'render-process-gone']) { assert.equal(f.contents.listenerCount(name), 0); }
  const next = register(f.options); await f.dispose(); assert.equal(handlers.size, 2); await next();
});

test('foreign handlers and concurrent registrations retain their ownership', async t => {
  const f = fixture(t); assert.throws(() => register(f.options), /unavailable/);
  assert.equal(handlers.get('private-conversion-submit'), f.submit); await f.dispose();
  for (const channel of ['private-conversion-state', 'private-conversion-submit']) {
    const foreign = () => 'private'; handlers.set(channel, foreign);
    assert.throws(() => register(f.options), /unavailable/);
    assert.equal(handlers.get(channel), foreign); assert.equal(handlers.size, 1);
    handlers.delete(channel);
    assert.equal(ipcMain.listenerCount('private-conversion-cancel'), 0);
  }
});

test('registration refuses invalid callbacks, counts, initial URL and destroyed or stale contents', () => {
  const contents = new Contents();
  const options = { contents: contents as unknown as WebContents, isCurrent: () => true, review: review(),
    start: async (): Promise<'completed'> => 'completed', onCancel: () => undefined, onComplete: () => undefined };
  for (const value of [null, {}, { ...options, start: null }, { ...options, onCancel: null }, { ...options, onComplete: null },
    { ...options, isCurrent: () => false }, { ...options, review: null },
    { ...options, review: { ...review(), videos: -1 } }, { ...options, review: { ...review(), previewBytes: Infinity } },
    { ...options, review: { ...review(), availablePreviews: 0.5 } },
    { ...options, review: { ...review(), missingPreviews: { ...review().missingPreviews, clip: '1' } } }]) {
    assert.throws(() => register(value as Parameters<typeof register>[0]), /^Error: Private conversion request unavailable$/);
  }
  contents.url = 'https://invalid.example/'; assert.throws(() => register(options), /unavailable/);
  contents.url = ENTRY_URL; contents.destroyed = true; assert.throws(() => register(options), /unavailable/);
  assert.equal(handlers.size, 0);
});

function isolatedRegister(): typeof register {
  const modulePath = require.resolve('./private-conversion-request');
  const cached = require.cache[modulePath];
  try {
    delete require.cache[modulePath];
    NodeModule._load = function(request: string, ...args: unknown[]) {
      if (request === 'electron') { return { ipcMain }; }
      if (request === './private-hub-conversion') {
        return { isPrivateHubConversionCleanupFailure: (error: unknown) => error === brandedCleanupError };
      }
      return originalLoad.call(this, request, ...args);
    };
    return require('./private-conversion-request').registerPrivateConversionRequest;
  } finally { require.cache[modulePath] = cached; NodeModule._load = originalLoad; }
}

for (const callback of ['onCancel', 'onComplete'] as const) {
  test(`${callback} failure after reentrant disposal remains quarantined without exposing callback diagnostics`, async () => {
    const isolated = isolatedRegister(); const contents = new Contents(); let disposal!: Promise<void>;
    const options = { contents: contents as unknown as WebContents, isCurrent: () => true, review: review(),
      start: async (): Promise<'completed'> => 'completed', onCancel: () => undefined, onComplete: () => undefined };
    options[callback] = () => { disposal = dispose(); throw new Error('Secret callback /private/path'); };
    const dispose = isolated(options); const event = { sender: contents, senderFrame: contents.mainFrame };
    if (callback === 'onCancel') { ipcMain.emit('private-conversion-cancel', event); }
    else { assert.equal(await handlers.get('private-conversion-submit')!(event, 'pw', false, true), false); }
    assert.equal(dispose(), disposal);
    await assert.rejects(disposal, /^Error: Private conversion cleanup could not be confirmed$/);
    assert.equal(handlers.size, 0); assert.throws(() => isolated(options), /unavailable/);
  });
}

test('cleanup uncertainty during active work retires the form and rejects disposal', async () => {
  const isolated = isolatedRegister(); const contents = new Contents(); let cancelled = 0;
  const options = { contents: contents as unknown as WebContents, isCurrent: () => true, review: review(),
    start: async (): Promise<'completed'> => { throw brandedCleanupError; },
    onCancel: () => { cancelled++; }, onComplete: () => assert.fail('Unconfirmed work cannot complete') };
  const dispose = isolated(options); const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(await handlers.get('private-conversion-submit')!(event, 'pw', false, true), false);
  assert.equal(cancelled, 1); assert.equal(handlers.get('private-conversion-state')!(event), undefined);
  await assert.rejects(dispose(), error => error === brandedCleanupError);
  assert.throws(() => isolated(options), /unavailable/);
});

test('cleanup uncertainty after cancellation permanently rejects disposal and retains global admission', async () => {
  // Keep last: production admission intentionally has no reset after uncertain cleanup.
  const contents = new Contents(); const work = deferred<'completed'>(); let cancelled = 0;
  const options = { contents: contents as unknown as WebContents, isCurrent: () => true, review: review(),
    start: () => work.promise, onCancel: () => { cancelled++; }, onComplete: () => assert.fail('Late completion') };
  const dispose = register(options); const event = { sender: contents, senderFrame: contents.mainFrame };
  const pending = handlers.get('private-conversion-submit')!(event, 'pw', false, true);
  await Promise.resolve(); ipcMain.emit('private-conversion-cancel', event);
  const disposal = dispose(); work.reject(brandedCleanupError);
  assert.equal(await pending, false); assert.equal(cancelled, 1);
  await assert.rejects(disposal, error => error === brandedCleanupError);
  assert.equal(dispose(), disposal); await assert.rejects(dispose(), error => error === brandedCleanupError);
  assert.equal(handlers.size, 0); assert.throws(() => register(options), /unavailable/);
});
