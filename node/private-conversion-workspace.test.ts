import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import type { PrivateConversionPromptOptions, PrivateHubBrowserOptions } from './private-hub-browser';
import type { PrivateHubOpenBrowser, PrivateHubPreparedOpen } from './private-hub-open';
import type { PrivateHubWorkspace } from './private-hub-workspace';
import type * as ConversionWorkspace from './private-conversion-workspace';
import { isPrivateHubConversionCleanupFailure, readPrivateHubConversionReceipt } from './private-hub-conversion';
import { readPrivateHubCatalogue } from './private-hub-catalogue';
import { PrivateHubStore } from './private-hub-store';

const app = Object.assign(new EventEmitter(), { isReady: () => true, quit: () => undefined });
const powerMonitor = new EventEmitter();
const safelyDisposed = new WeakSet<Error>();
let promptAdapter: (options: PrivateConversionPromptOptions) => Promise<PrivateHubPreparedOpen | undefined>;
let galleryAdapter: (options: PrivateHubBrowserOptions) => Promise<PrivateHubOpenBrowser>;
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let createPrivateConversionWorkspace: typeof ConversionWorkspace.createPrivateConversionWorkspace;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') { return { app, powerMonitor }; }
    if (request === './private-hub-browser') {
      return {
        PrivateHubBrowser: {
          requestConversion: (options: PrivateConversionPromptOptions) => promptAdapter(options),
          create: (options: PrivateHubBrowserOptions) => galleryAdapter(options),
          requestPassword: () => { throw new Error('Conversion must not open another password prompt.'); },
        },
        isPrivateBrowserDisposedFailure: (error: unknown) => error instanceof Error && safelyDisposed.has(error),
      };
    }
    return originalLoad.call(this, request, ...args);
  };
  createPrivateConversionWorkspace = require('./private-conversion-workspace').createPrivateConversionWorkspace;
} finally { NodeModule._load = originalLoad; }

const marker = 'CONVERSION-WORKSPACE-SYNTHETIC-PRIVATE-NOTE';
const password = 'Conversion workspace synthetic passphrase 2026!';
const hash = 'workspace-video-1';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: value => resolve(value) };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The conversion workspace did not reach its expected stage.');
}

class Gallery implements PrivateHubOpenBrowser {
  readonly finished = deferred();
  readonly closed = this.finished.promise;
  state: 'open' | 'closed' = 'open';
  shows = 0;
  get status(): PrivateHubOpenBrowser['status'] { return { state: this.state, cleanupFailed: false }; }
  show(): void { this.shows++; }
  close(): Promise<void> { this.state = 'closed'; this.finished.resolve(); return this.closed; }
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) { await visit(file); }
      else {
        const stats = await fs.stat(file);
        result[path.relative(directory, file)] = `${stats.ino}:${stats.mtimeMs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
      }
    }
  };
  await visit(directory);
  return result;
}

async function assertEncrypted(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.name.includes(marker));
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await assertEncrypted(file); }
    else { assert.ok(!(await fs.readFile(file)).includes(Buffer.from(marker)), 'The destination must not contain the plaintext marker.'); }
  }
}

async function fixture(t: TestContext) {
  const temporary = path.join(__dirname, '..', 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-conversion-workspace-'));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  const cataloguePath = path.join(source, 'example.scaena');
  const assets = path.join(source, 'vha-Synthetic');
  await fs.mkdir(path.join(assets, 'thumbnails'), { recursive: true });
  await fs.mkdir(path.join(assets, 'filmstrips'), { recursive: true });
  const catalogue: FinalObject = {
    addTags: [], hubName: 'Synthetic',
    images: [{ ...NewImageElement(), hash, fileName: 'synthetic.mp4', notes: marker, tags: ['fixture'], timesPlayed: 3 }],
    inputDirs: { 0: { path: path.join(source, 'originals'), watch: false } },
    numOfFolders: 1, removeTags: [], version: 3,
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 5 },
  };
  await fs.writeFile(cataloguePath, JSON.stringify(catalogue));
  await fs.writeFile(cataloguePath + '.bak', JSON.stringify(catalogue));
  await fs.writeFile(path.join(assets, 'thumbnails', hash + '.jpg'), marker + ' thumbnail');
  await fs.writeFile(path.join(assets, 'filmstrips', hash + '.jpg'), marker + ' filmstrip');
  const destination = path.join(root, 'private-copy');
  const transition = new AbortController();
  const gallery = new Gallery();
  const events: string[] = [];
  const reviews: PrivateConversionPromptOptions['review'][] = [];
  const progress: Parameters<Parameters<PrivateConversionPromptOptions['start']>[2]>[0][] = [];
  const failures: unknown[] = [];
  const disposals: (() => void)[] = [];
  let formDisposed = false;
  let galleryCatalogue: FinalObject | undefined;
  let galleryCalls = 0;
  let promptCalls = 0;
  let authority = true;
  let allowMissing = false;
  let choose: () => Promise<string | undefined> = async () => destination;
  let afterCopy: (prepared: PrivateHubPreparedOpen | undefined) => Promise<void> = async () => undefined;
  let onProgress: (value: (typeof progress)[number]) => void = () => undefined;
  promptAdapter = async options => {
    promptCalls++;
    formDisposed = false;
    events.push('reviewed');
    reviews.push(options.review);
    assert.equal(options.lifecycle, 'external');
    assert.equal(options.visible, false);
    try {
      const prepared = await options.start(password, allowMissing, value => {
        progress.push(value);
        onProgress(value);
      }, async () => { events.push('picker'); return choose(); });
      events.push(prepared ? 'copied' : 'picker-cancelled');
      await afterCopy(prepared);
      return prepared;
    } catch (error) {
      failures.push(error);
      if (isPrivateHubConversionCleanupFailure(error)) { throw error; }
      const safe = new Error('Synthetic conversion form was disposed after a safe refusal.');
      safelyDisposed.add(safe);
      throw safe;
    } finally {
      options.onRetire();
      formDisposed = true;
      events.push('form-disposed');
    }
  };
  galleryAdapter = async options => {
    galleryCalls++;
    assert.equal(formDisposed, true, 'Activation cannot precede confirmed creation form disposal.');
    assert.equal(options.hub.isCurrent(options.generation), true);
    assert.equal(options.isAuthorized!(), true);
    galleryCatalogue = await options.hub.readCatalogue(options.generation);
    events.push('gallery-created');
    return gallery;
  };
  const workspace = createPrivateConversionWorkspace({
    appDirectory: path.join(__dirname, '..', 'private-gallery'), lifecycle: 'external', promptVisible: false,
  });
  t.after(async () => {
    transition.abort();
    for (const dispose of disposals) { dispose(); }
    await workspace.cancel();
    await fs.rm(root, { recursive: true, force: true });
    assert.equal(app.listenerCount('before-quit'), 0);
    assert.equal(powerMonitor.listenerCount('suspend'), 0);
  });
  return {
    root, source, cataloguePath, assets, destination, catalogue, transition, gallery, workspace,
    events, reviews, progress, failures, disposals,
    open: () => workspace.open({ directory: cataloguePath, signal: transition.signal, isAuthorized: () => authority }),
    galleryCalls: () => galleryCalls, promptCalls: () => promptCalls, galleryCatalogue: () => galleryCatalogue,
    setAuthority: (value: boolean) => { authority = value; },
    setMissingConsent: (value: boolean) => { allowMissing = value; },
    setPicker: (value: typeof choose) => { choose = value; },
    setAfterCopy: (value: typeof afterCopy) => { afterCopy = value; },
    setProgress: (value: typeof onProgress) => { onProgress = value; },
  };
}

test('real review and encrypted conversion drain the form before verified activation and gallery access', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.source);
  const formDrain = deferred();
  f.disposals.push(() => formDrain.resolve());
  f.setAfterCopy(async prepared => { assert.equal(prepared?.directory, f.destination); await formDrain.promise; });
  const opening = f.open();
  await until(() => f.events.includes('copied'));
  assert.equal(f.galleryCalls(), 0);
  assert.equal(f.gallery.shows, 0);
  assert.equal(f.workspace.status.state, 'opening');
  const beforeActivation = await PrivateHubStore.open(f.destination, password);
  try {
    assert.equal((await readPrivateHubConversionReceipt(beforeActivation)).state, 'complete');
    await assert.rejects(beforeActivation.readRecord('session:activation', 512), { code: 'ENOENT' });
  } finally { await beforeActivation.lock(); }
  formDrain.resolve();
  assert.equal(await opening, 'opened');
  assert.deepEqual(f.events, ['reviewed', 'picker', 'copied', 'form-disposed', 'gallery-created']);
  assert.equal(f.gallery.shows, 1);
  assert.deepEqual(f.galleryCatalogue(), f.catalogue);
  assert.deepEqual(await fingerprint(f.source), before);
  assert.deepEqual(f.reviews[0].missingPreviews, { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 });
  assert.equal(f.reviews[0].videos, 1);
  assert.equal(f.reviews[0].availablePreviews, 2);
  assert.ok(Object.isFrozen(f.reviews[0]));
  assert.ok(!JSON.stringify(f.progress).includes(marker));
  assert.ok(f.progress.some(value => value.stage === 'complete'));
  await f.workspace.cancel();
  const activated = await PrivateHubStore.open(f.destination, password);
  try {
    const markerBytes = await activated.readRecord('session:activation', 512);
    try {
      assert.deepEqual(JSON.parse(markerBytes.toString('utf8')), {
        format: 'theatrum-private-hub-activation', version: 1, hubId: activated.hubId,
      });
    } finally { markerBytes.fill(0); }
    assert.deepEqual(await readPrivateHubCatalogue(activated), f.catalogue);
  } finally { await activated.lock(); }
  await assertEncrypted(f.destination);
});

test('missing previews refuse without consent and a newly reviewed attempt records explicit acceptance', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.assets, 'filmstrips', hash + '.jpg'));
  const before = await fingerprint(f.source);
  assert.equal(await f.open(), 'unavailable');
  assert.equal(f.galleryCalls(), 0);
  assert.equal(f.reviews[0].missingPreviews.filmstrip, 1);
  assert.equal(f.workspace.status.cleanupFailed, false);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  f.setMissingConsent(true);
  assert.equal(await f.open(), 'opened');
  assert.notEqual(f.reviews[0], f.reviews[1]);
  assert.equal(f.galleryCalls(), 1);
  await f.workspace.cancel();
  const store = await PrivateHubStore.open(f.destination, password);
  try {
    assert.deepEqual((await readPrivateHubConversionReceipt(store)).missingPreviews, [{ kind: 'filmstrip', hash }]);
  } finally { await store.lock(); }
  assert.deepEqual(await fingerprint(f.source), before);
});

test('native destination cancellation creates no output and resumes only after form disposal', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.source);
  f.setPicker(async () => undefined);
  assert.equal(await f.open(), 'cancelled');
  assert.deepEqual(f.events, ['reviewed', 'picker', 'picker-cancelled', 'form-disposed']);
  assert.equal(f.galleryCalls(), 0);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  assert.deepEqual(await fingerprint(f.source), before);
});

test('cancellation holds a pending native picker and never converts its late destination', async t => {
  const f = await fixture(t);
  const picker = deferred<string | undefined>();
  f.disposals.push(() => picker.resolve(undefined));
  f.setPicker(() => picker.promise);
  const opening = f.open();
  await until(() => f.events.includes('picker'));
  const settled = f.workspace.settled;
  let finished = false;
  void settled.then(() => { finished = true; });
  f.transition.abort();
  assert.equal(f.workspace.status.state, 'closing');
  assert.equal(await f.open(), 'busy');
  assert.equal(finished, false);
  picker.resolve(f.destination);
  assert.equal(await opening, 'cancelled');
  await settled;
  assert.equal(finished, true);
  assert.equal(f.galleryCalls(), 0);
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('cancellation during real conversion waits for storage drainage before releasing ordinary authority', async t => {
  const f = await fixture(t);
  const before = await fingerprint(f.source);
  const drain = deferred();
  f.disposals.push(() => drain.resolve());
  let draining = false;
  let hold = true;
  const lock = PrivateHubStore.prototype.lock;
  t.mock.method(PrivateHubStore.prototype, 'lock', function(this: PrivateHubStore): Promise<void> {
    const work = lock.call(this);
    if (!hold) { return work; }
    draining = true;
    return work.then(() => drain.promise);
  });
  f.setProgress(value => { if (value.stage === 'copying') { f.transition.abort(); } });
  const opening = f.open();
  await until(() => draining);
  let finished = false;
  const settled = f.workspace.settled;
  void settled.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(f.workspace.status.state, 'closing');
  assert.equal(await f.open(), 'busy');
  assert.equal(f.galleryCalls(), 0);
  hold = false;
  drain.resolve();
  assert.equal(await opening, 'cancelled');
  await settled;
  assert.equal(finished, true);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  assert.deepEqual(await fingerprint(f.source), before);
  const store = await PrivateHubStore.open(f.destination, password);
  try { await assert.rejects(readPrivateHubConversionReceipt(store), /does not exist/); }
  finally { await store.lock(); }
  await assertEncrypted(f.destination);
});

test('a source changed after review is refused before destination creation or gallery activation', async t => {
  const f = await fixture(t);
  f.setPicker(async () => {
    await fs.appendFile(f.cataloguePath, '\n');
    return f.destination;
  });
  assert.equal(await f.open(), 'unavailable');
  assert.equal(f.galleryCalls(), 0);
  assert.equal(f.failures.length, 1);
  assert.match(String(f.failures[0]), /changed after review/);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('an invalid ordinary catalogue refuses safely before any conversion form or destination picker', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.cataloguePath, 'invalid synthetic catalogue');
  assert.equal(await f.open(), 'unavailable');
  assert.equal(f.promptCalls(), 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.galleryCalls(), 0);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('lost normal authority while choosing a destination cannot publish an encrypted copy', async t => {
  const f = await fixture(t);
  f.setPicker(async () => { f.setAuthority(false); return f.destination; });
  assert.equal(await f.open(), 'cancelled');
  assert.equal(f.galleryCalls(), 0);
  assert.deepEqual(f.workspace.status, { state: 'idle', cleanupFailed: false });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

// Last: real branded source-descriptor uncertainty intentionally poisons all
// coordinator admission in this process, with no production reset mechanism.
test('review descriptor cleanup uncertainty quarantines the workspace before any form can open', async t => {
  const f = await fixture(t);
  const open = fs.open;
  let injected = false;
  t.mock.method(fs, 'open', async (file: Parameters<typeof fs.open>[0], ...args: Parameters<typeof fs.open> extends [unknown, ...infer Rest] ? Rest : never) => {
    const handle = await open(file, ...args);
    if (!injected && file === f.cataloguePath) {
      injected = true;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error('Synthetic unconfirmed source descriptor close.'); };
    }
    return handle;
  });
  assert.equal(await f.open(), 'unavailable');
  assert.equal(injected, true);
  assert.equal(f.promptCalls(), 0);
  assert.equal(f.galleryCalls(), 0);
  assert.deepEqual(f.workspace.status, { state: 'failed', cleanupFailed: true });
  await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
  const other: PrivateHubWorkspace = createPrivateConversionWorkspace({
    appDirectory: path.join(__dirname, '..', 'private-gallery'), lifecycle: 'external',
  });
  assert.equal(await other.open({ directory: f.cataloguePath, isAuthorized: () => true, signal: new AbortController().signal }), 'busy');
  await other.cancel();
});
