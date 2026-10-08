import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { PrivateHubStore } from './private-hub-store';
import { PrivateHubSession } from './private-hub-session';
import { capturePrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, type PrivatePreviewSource } from './private-preview-source';
import { privateVideoRevision } from './private-hub-metadata';
import { createPrivateThumbnailOverride, privateThumbnailOverrideMemberId, publishPrivateThumbnailOverride } from './private-thumbnail-override';
import * as thumbnail from './private-custom-thumbnail';
import { streamPrivateMediaProcess, isPrivateMediaProcessCleanupFailure } from './private-media-process';
import { privateProbeCommand } from './private-preview-plan';

const password = 'Synthetic custom thumbnail session password';
const marker = 'PRIVATE_CUSTOM_SESSION';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.resolve(__dirname, '../tmp/private-custom-session-'));
  const file = path.join(root, 'selected.jpg'); await fs.writeFile(file, 'Synthetic selected still image');
  const directory = path.join(root, 'hub');
  const catalogue: FinalObject = { addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: [{ ...NewImageElement(), hash: 'video', cleanName: 'User title', fileName: 'offline.mp4', partialPath: '/',
      notes: marker, tags: ['Keep tag'], stars: 4.5, lastPlayed: 1234, timesPlayed: 2, dateAdded: 5000, playlist: 42,
      defaultScreen: 1, missing: true, duration: 10, width: 320, height: 180, screens: 3,
      locations: [{ inputSource: 0, partialPath: '/', fileName: 'offline.mp4', missing: true }, { inputSource: 0, partialPath: '/', fileName: 'alias.mp4', missing: true }] }],
    inputDirs: { 0: { path: path.join(root, 'disconnected-originals'), watch: true } },
    screenshotSettings: { height: 144, clipHeight: 144, fixed: true, n: 3, clipSnippets: 0, clipSnippetLength: 1 } };
  Object.assign(catalogue.images[0], { futureField: 'retained' });
  const raw = Buffer.from('\uFEFF' + JSON.stringify(catalogue, null, 3) + '\n');
  const initial = await PrivateHubStore.create(directory, password);
  await initial.writeRecord('catalogue', raw);
  await initial.writeNewRecord('preview:thumbnail:video', Buffer.from('original-thumbnail'));
  await initial.writeNewRecord('session:activation', Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: initial.hubId })));
  await initial.lock();
  let store!: PrivateHubStore;
  const open = PrivateHubStore.open.bind(PrivateHubStore);
  t.mock.method(PrivateHubStore, 'open', async (target: string, secret: string) => { store = await open(target, secret); return store; });
  const session = new PrivateHubSession(); const { generation } = await session.unlock(directory, password);
  const controller = new AbortController();
  const capture = () => capturePrivatePreviewSource({ hash: 'video', root, partialPath: '/', fileName: 'selected.jpg', inputSource: 0,
    signal: controller.signal, isCurrent: () => session.isCurrent(generation) && !controller.signal.aborted });
  const source = await capture();
  const update = { index: 0, revision: privateVideoRevision((await session.readCatalogue(generation)).images[0]) };
  let quarantine = false;
  let decoderQuarantine = false;
  t.after(async () => {
    if (quarantine) { await assert.rejects(source.close(), isPrivatePreviewSourceCleanupFailure); await assert.rejects(session.close(), isPrivatePreviewSourceCleanupFailure); }
    else { await source.close(); if (decoderQuarantine) { await assert.rejects(session.close(), isPrivateMediaProcessCleanupFailure); } else { await session.close(); } }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, file, directory, catalogue, raw, store, session, generation, controller, capture, source, update,
    expectQuarantine: () => { quarantine = true; }, expectDecoderQuarantine: () => { decoderQuarantine = true; } };
}
function producer(t: TestContext, before?: (source: PrivatePreviewSource) => Promise<void>) {
  return t.mock.method(thumbnail, 'setPrivateCustomThumbnail', async (store: PrivateHubStore, source: PrivatePreviewSource, height: number,
    options: { signal?: AbortSignal; isCurrent: () => boolean }) => {
    await before?.(source);
    assert.equal(options.isCurrent(), true);
    const override = createPrivateThumbnailOverride(source.hash, 'legacy', height);
    await store.writeNewRecord(privateThumbnailOverrideMemberId(override), Buffer.from('custom-thumbnail'));
    await publishPrivateThumbnailOverride(store, override, options.isCurrent);
    return override;
  });
}
test('offline originals and aliases allow custom thumbnail while exact catalogue bytes remain unchanged', async t => {
  const f = await fixture(t); producer(t);
  assert.deepEqual(await f.session.setCustomThumbnail(f.generation, f.source, f.update, { isCurrent: () => true }), { status: 'updated' });
  assert.deepEqual(await f.store.readRecord('catalogue'), f.raw);
  assert.equal(f.source.signal.aborted, true);
  const response = await f.session.createPreviewResponse(f.generation, 'thumbnail', 'video', new Request('theatrum://app/media'));
  assert.equal(await response.text(), 'custom-thumbnail');
  await f.session.lock(); const reopened = await f.session.unlock(f.directory, password);
  assert.deepEqual(reopened.catalogue.images[0].tags, ['Keep tag']);
  assert.equal(await (await f.session.createPreviewResponse(reopened.generation, 'thumbnail', 'video', new Request('theatrum://app/media'))).text(), 'custom-thumbnail');
});
for (const changed of ['revision', 'deleted', 'duplicate', 'folder'] as const) {
  test(`${changed} target refuses custom thumbnail before decoder`, async t => {
    const f = await fixture(t); const mock = producer(t);
    const catalogue = structuredClone(f.catalogue);
    if (changed === 'revision') { catalogue.images[0].notes = 'New notes'; }
    if (changed === 'deleted') { catalogue.images[0].deleted = true; }
    if (changed === 'duplicate') { catalogue.images.push({ ...catalogue.images[0] }); }
    if (changed === 'folder') { catalogue.images[0].cleanName = '*FOLDER*'; }
    // Preserve the allowlist for deleted/folder rows to exercise the fresh-row validation.
    await f.store.writeRecord('catalogue', Buffer.from(JSON.stringify(catalogue)));
    if (changed !== 'revision') { f.update.revision = privateVideoRevision((await f.session.readCatalogue(f.generation)).images[0]); }
    assert.deepEqual(await f.session.setCustomThumbnail(f.generation, f.source, f.update, { isCurrent: () => true }),
      { status: changed === 'revision' ? 'conflict' : 'invalid' });
    assert.equal(mock.mock.callCount(), 0); assert.equal(f.source.signal.aborted, true);
  });
}
test('invalid requests and forged capabilities never invoke authority or consume a valid source', async t => {
  const f = await fixture(t); const authority = () => { assert.fail('Malformed request cannot invoke authority'); };
  assert.deepEqual(await f.session.setCustomThumbnail(f.generation, f.source, { index: -1, revision: '' }, { isCurrent: authority }), { status: 'invalid' });
  await assert.rejects(f.session.setCustomThumbnail(f.generation, { ...f.source } as PrivatePreviewSource, f.update, { isCurrent: authority }));
  assert.equal(f.source.isCurrent(), true);
});
test('writer reservation precedes reentrant authority; busy requests keep caller ownership', async t => {
  const f = await fixture(t); const entered = deferred(); const release = deferred(); t.after(release.resolve);
  producer(t, async () => { entered.resolve(); await release.promise; });
  let attempted = false; let blockedWrites: Promise<void>[] = [];
  const changing = f.session.setCustomThumbnail(f.generation, f.source, f.update, { isCurrent: () => {
    if (!attempted) {
      attempted = true;
      blockedWrites = [assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue)),
        assert.rejects(f.session.changePassword(f.generation, { currentPassword: password, newPassword: password + ' changed' }, () => true)),
        assert.rejects(f.session.updateProtection(f.generation, { autoLockMinutes: 15 }, () => true)),
        assert.rejects(f.session.createUnprotectedCopy(f.generation, { password, acknowledge: true }, () => true,
          { signal: new AbortController().signal, chooseDestination: async () => { assert.fail('Busy export cannot open picker'); } }))];
    }
    return true;
  } });
  const second = await f.capture(); t.after(() => second.close());
  assert.deepEqual(await f.session.setCustomThumbnail(f.generation, second, f.update, { isCurrent: () => true }), { status: 'busy' });
  assert.equal(second.isCurrent(), true); await entered.promise; await Promise.all(blockedWrites);
  release.resolve(); assert.equal((await changing).status, 'updated'); assert.equal(attempted, true);
});
test('request snapshot survives caller mutation after admission', async t => {
  const f = await fixture(t); producer(t);
  const changing = f.session.setCustomThumbnail(f.generation, f.source, f.update, { isCurrent: () => true });
  f.update.index = 999; f.update.revision = '0'.repeat(64);
  assert.equal((await changing).status, 'updated');
});
for (const action of ['cancel', 'lock'] as const) {
  test(`${action} drains producer before releasing admission and preserves the catalogue`, async t => {
    const f = await fixture(t); const entered = deferred(); const release = deferred(); t.after(release.resolve);
    producer(t, async () => { entered.resolve(); await release.promise; });
    const rejected = assert.rejects(f.session.setCustomThumbnail(f.generation, f.source, f.update,
      { signal: f.controller.signal, isCurrent: () => true }));
    await entered.promise;
    let locked = false; let locking: Promise<void> | undefined;
    if (action === 'cancel') { f.controller.abort(); await assert.rejects(f.session.writeCatalogue(f.generation, f.catalogue)); }
    else { locking = f.session.lock().then(() => { locked = true; }); await Promise.resolve(); assert.equal(locked, false); }
    release.resolve(); await rejected; await locking;
    if (action === 'lock') { assert.equal((await f.session.unlock(f.directory, password)).catalogue.images[0].notes, marker); }
    else { assert.deepEqual(await f.store.readRecord('catalogue'), f.raw); }
  });
}
test('selected file descriptor cleanup failure quarantines the session with its trusted classification', async t => {
  const f = await fixture(t); const closeHandles: (() => Promise<void>)[] = [];
  const nativeFs: typeof fs = require('node:fs/promises'); const open = nativeFs.open.bind(nativeFs);
  const mocked = t.mock.method(nativeFs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === f.file) { closeHandles.push(handle.close.bind(handle)); t.mock.method(handle, 'close', async () => { throw new Error(marker); }); }
    return handle;
  });
  t.mock.method(thumbnail, 'setPrivateCustomThumbnail', async (_store: PrivateHubStore, source: PrivatePreviewSource) => {
    const lease = await source.open(); await lease.close(); throw new Error('Unreachable');
  });
  f.expectQuarantine();
  await assert.rejects(f.session.setCustomThumbnail(f.generation, f.source, f.update, { isCurrent: () => true }), isPrivatePreviewSourceCleanupFailure);
  assert.equal(f.session.status.state, 'locked'); mocked.mock.restore();
  for (const close of closeHandles) { await close(); }
});
test('decoder cleanup failure retains its brand when final source close also throws an ordinary error', async t => {
  const f = await fixture(t);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: null, kill: () => true });
  const spawn = t.mock.method(childProcess, 'spawn', () => child as unknown as childProcess.ChildProcess);
  let cleanupFailure!: Error;
  try {
    const runner = streamPrivateMediaProcess({ ...privateProbeCommand(), sourceFd: 41, timeoutMs: 1,
      signal: new AbortController().signal, isCurrent: () => true });
    await assert.rejects(runner.next(), error => {
      assert.equal(isPrivateMediaProcessCleanupFailure(error), true); cleanupFailure = error as Error; return true;
    });
  } finally { child.emit('close', 1, 'SIGKILL'); spawn.mock.restore(); }
  t.mock.method(thumbnail, 'setPrivateCustomThumbnail', async () => { throw cleanupFailure; });
  const close = t.mock.method(Object.getPrototypeOf(f.source), 'close', async () => { throw new Error(marker); });
  f.expectDecoderQuarantine();
  try {
    await assert.rejects(f.session.setCustomThumbnail(f.generation, f.source, f.update, { isCurrent: () => true }), error => error === cleanupFailure);
    assert.equal(f.session.status.state, 'locked');
  } finally { close.mock.restore(); }
});
