import * as assert from 'node:assert/strict';
import { chmodSync, constants, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface';
import type { FinalObject } from '../interfaces/final-object.interface';
import {
  convertCatalogueToPrivateHub,
  isPrivateHubConversionCleanupFailure,
  reviewCatalogueForPrivateConversion,
  verifyPrivateHubConversion,
} from './private-hub-conversion';
import type { PrivateHubConversionOptions } from './private-hub-conversion';
import { PrivateHubStore } from './private-hub-store';

const marker = 'SYNTHETIC-PRIVATE-REVIEW-CANARY';
const password = 'Synthetic review conversion password 2026!';
const hash = 'review-video';
const kinds = ['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const;

async function fixture(t: TestContext) {
  const temporary = path.join(__dirname, '..', 'tmp');
  await fs.mkdir(temporary, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporary, 'private-conversion-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const originalMedia = path.join(root, 'original-media-not-opened');
  await fs.mkdir(source);
  const cataloguePath = path.join(source, 'synthetic.scaena');
  const catalogue: FinalObject = {
    addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    inputDirs: { 0: { path: originalMedia, watch: false } },
    images: [{ ...NewImageElement(), hash, cleanName: marker, fileName: marker + '.mp4',
      notes: marker + ' notes', tags: [marker] }],
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 3 },
  };
  await fs.writeFile(cataloguePath, JSON.stringify(catalogue));
  const assets = path.join(source, 'vha-' + marker);
  const previews = {
    thumbnail: path.join(assets, 'thumbnails', hash + '.jpg'),
    filmstrip: path.join(assets, 'filmstrips', hash + '.jpg'),
    'clip-poster': path.join(assets, 'clips', hash + '.jpg'),
    clip: path.join(assets, 'clips', hash + '.mp4'),
  };
  let previewBytes = 0;
  for (const kind of kinds) {
    await fs.mkdir(path.dirname(previews[kind]), { recursive: true });
    const bytes = Buffer.from(marker + ':' + kind);
    await fs.writeFile(previews[kind], bytes); previewBytes += bytes.length;
  }
  const options: PrivateHubConversionOptions = { cataloguePath, destinationDirectory: path.join(root, 'private-copy'),
    password, assertSourceQuiescent: () => undefined };
  return { root, source, originalMedia, catalogue, cataloguePath, assets, previews, previewBytes, options };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Review = Awaited<ReturnType<typeof reviewCatalogueForPrivateConversion>>;

function request(f: Fixture) {
  return { cataloguePath: f.cataloguePath, assertSourceQuiescent: f.options.assertSourceQuiescent, signal: f.options.signal };
}

async function noDestination(options: PrivateHubConversionOptions): Promise<void> {
  await assert.rejects(fs.lstat(options.destinationDirectory), { code: 'ENOENT' });
}

async function fingerprint(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const stat = await fs.lstat(file);
      result[path.relative(directory, file)] = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (entry.isDirectory()) { await visit(file); }
      else { result[path.relative(directory, file)] += ':' + createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
    }
  }
  await visit(directory);
  return result;
}

test('review returns frozen counts only and inventories only referenced previews', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.assets, 'thumbnails', 'unreferenced.jpg'), marker + ' orphan');
  await fs.writeFile(f.cataloguePath + '.bak', marker + ' unrelated backup');
  const before = await fingerprint(f.source);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  assert.deepEqual(review, { videos: 1, availablePreviews: 4, previewBytes: f.previewBytes,
    missingPreviews: { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 } });
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.missingPreviews));
  assert.equal(Reflect.ownKeys(review).length, 4);
  assert.ok(!JSON.stringify(review).includes(marker) && !JSON.stringify(review).includes(f.root));
  assert.deepEqual(await fingerprint(f.source), before);
  await noDestination(f.options);
});

test('disabled clips are not counted as missing but existing optional clips remain in the copy inventory', async t => {
  const f = await fixture(t);
  f.catalogue.screenshotSettings.clipSnippets = 0;
  await fs.writeFile(f.cataloguePath, JSON.stringify(f.catalogue));
  const complete = await reviewCatalogueForPrivateConversion(request(f));
  assert.equal(complete.availablePreviews, 4);
  await fs.unlink(f.previews.clip); await fs.unlink(f.previews['clip-poster']);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  assert.equal(review.availablePreviews, 2);
  assert.equal(review.previewBytes, (await fs.stat(f.previews.thumbnail)).size + (await fs.stat(f.previews.filmstrip)).size);
  assert.deepEqual(review.missingPreviews, { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 });
});

test('review totals videos and missing previews by kind without revealing catalogue identities', async t => {
  const f = await fixture(t);
  f.catalogue.images.push({ ...NewImageElement(), hash: 'second-review-video', fileName: 'second.mp4', notes: marker });
  await fs.writeFile(f.cataloguePath, JSON.stringify(f.catalogue));
  const bytes = Buffer.from('Second synthetic thumbnail');
  await fs.writeFile(path.join(f.assets, 'thumbnails', 'second-review-video.jpg'), bytes);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  assert.deepEqual(review, { videos: 2, availablePreviews: 5, previewBytes: f.previewBytes + bytes.length,
    missingPreviews: { thumbnail: 0, filmstrip: 1, 'clip-poster': 1, clip: 1 } });
});

test('review reads only the catalogue payload, closes its descriptor, and never opens original media or preview payloads', async t => {
  const f = await fixture(t);
  const opened: string[] = [];
  const retained: Buffer[] = [];
  let closed = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    assert.equal(String(args[0]), f.cataloguePath);
    assert.equal(typeof args[1], 'number');
    assert.equal(Number(args[1]) & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), 0);
    opened.push(String(args[0]));
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof read>) => {
      const result = await read(...readArgs); retained.push(result.buffer as Buffer); return result;
    });
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); closed++; });
    return handle;
  });
  for (const method of ['readFile', 'writeFile', 'mkdir', 'rename', 'unlink', 'rm'] as const) {
    t.mock.method(fs, method, () => { throw new Error('Review attempted an unnecessary filesystem operation'); });
  }
  for (const method of ['lstat', 'stat', 'realpath', 'access', 'readdir'] as const) {
    const operation = fs[method];
    t.mock.method(fs, method, (...args: unknown[]) => {
      const candidate = String(args[0]);
      assert.ok(candidate !== f.originalMedia && !candidate.startsWith(f.originalMedia + path.sep),
        'Review must not inspect an original media location.');
      return Reflect.apply(operation, fs, args);
    });
  }
  try {
    const review = await reviewCatalogueForPrivateConversion(request(f));
    assert.equal(review.availablePreviews, 4);
    assert.ok(opened.length > 0 && closed === opened.length);
    assert.ok(retained.length > 0 && retained.every(bytes => bytes.every(byte => byte === 0)));
  } finally { t.mock.restoreAll(); }
  await assert.rejects(fs.lstat(f.originalMedia), { code: 'ENOENT' });
  await noDestination(f.options);
});

test('missing previews require both explicit consent and an issued review before creating a destination', async t => {
  const f = await fixture(t);
  await fs.unlink(f.previews.filmstrip);
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, allowMissingPreviews: true }));
  await noDestination(f.options);
  const unaccepted = await reviewCatalogueForPrivateConversion(request(f));
  assert.deepEqual(unaccepted.missingPreviews, { thumbnail: 0, filmstrip: 1, 'clip-poster': 0, clip: 0 });
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review: unaccepted }));
  await noDestination(f.options);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  const receipt = await convertCatalogueToPrivateHub({ ...f.options, review, allowMissingPreviews: true });
  assert.deepEqual(receipt.missingPreviews, [{ kind: 'filmstrip', hash }]);
  const store = await PrivateHubStore.open(f.options.destinationDirectory, password);
  try { assert.deepEqual(await verifyPrivateHubConversion(store), receipt); } finally { await store.lock(); }
});

test('complete conversion still supports an unreviewed default copy and reviewed conversion consumes its proof', async t => {
  const f = await fixture(t);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  const receipt = await convertCatalogueToPrivateHub({ ...f.options, review });
  assert.equal(receipt.previews.length, 4);
  const replay = { ...f.options, review, destinationDirectory: path.join(f.root, 'replay') };
  await assert.rejects(convertCatalogueToPrivateHub(replay)); await noDestination(replay);
  const unreviewed = { ...f.options, destinationDirectory: path.join(f.root, 'default-copy') };
  assert.equal((await convertCatalogueToPrivateHub(unreviewed)).previews.length, 4);
});

test('forged and cloned review objects are rejected before output even when their counts are correct', async t => {
  const f = await fixture(t);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  for (const invalid of [{ ...review }, JSON.parse(JSON.stringify(review)),
    Object.freeze({ ...review, missingPreviews: Object.freeze({ ...review.missingPreviews }) })]) {
    await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review: invalid as Review, allowMissingPreviews: true }));
    await noDestination(f.options);
  }
});

test('a review cannot authorize a different catalogue or quiescence callback', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  const crossSource = { ...other.options, assertSourceQuiescent: f.options.assertSourceQuiescent, review };
  await assert.rejects(convertCatalogueToPrivateHub(crossSource)); await noDestination(crossSource);
  const another = await reviewCatalogueForPrivateConversion(request(f));
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review: another, assertSourceQuiescent: () => undefined }));
  await noDestination(f.options);
});

test('review is bound to the exact cancellation lifetime, including whether a signal was supplied', async t => {
  const f = await fixture(t);
  const first = new AbortController();
  const second = new AbortController();
  for (const [reviewSignal, conversionSignal] of [[first.signal, second.signal], [first.signal, undefined], [undefined, first.signal]]) {
    const review = await reviewCatalogueForPrivateConversion({ ...request(f), signal: reviewSignal });
    await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review, signal: conversionSignal }));
    await noDestination(f.options);
  }
});

const mutations: [string, (f: Fixture) => Promise<void>][] = [
  ['catalogue bytes change', async f => { await fs.appendFile(f.cataloguePath, '\n'); }],
  ['preview bytes change', async f => { await fs.appendFile(f.previews.thumbnail, ' changed'); }],
  ['a preview disappears', async f => { await fs.unlink(f.previews.filmstrip); }],
  ['a missing preview appears', async f => { await fs.writeFile(f.previews.filmstrip, 'new filmstrip'); }],
  ['a preview inode is replaced with identical bytes', async f => {
    const bytes = await fs.readFile(f.previews.thumbnail);
    const replacement = path.join(f.root, 'replacement.jpg');
    await fs.writeFile(replacement, bytes); await fs.rename(replacement, f.previews.thumbnail);
  }],
  ['the preview directory identity changes', async f => {
    const directory = path.dirname(f.previews.filmstrip);
    await fs.rename(directory, path.join(f.root, 'original-filmstrip-directory'));
    await fs.mkdir(directory);
  }],
];

for (const entry of ['sibling folder', '.DS_Store']) {
  test('an unrelated source-parent ' + entry + ' does not invalidate review or conversion', async t => {
    const f = await fixture(t);
    const review = await reviewCatalogueForPrivateConversion(request(f));
    const sibling = path.join(f.source, entry);
    if (entry === 'sibling folder') { await fs.mkdir(sibling); }
    else { await fs.writeFile(sibling, 'synthetic Finder metadata'); }
    const receipt = await convertCatalogueToPrivateHub({ ...f.options, review, onProgress: event => {
      // The source parent's identity also remains valid after inventory scanning.
      if (event.stage === 'scanning') { writeFileSync(path.join(f.source, 'unrelated-save-dialog-entry'), 'unrelated'); }
    } });
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.previews.length, kinds.length);
    const store = await PrivateHubStore.open(f.options.destinationDirectory, password);
    try { assert.deepEqual(await verifyPrivateHubConversion(store), receipt); }
    finally { await store.lock(); }
  });
}

function catalogueMetadataChange(file: string) {
  const before = statSync(file);
  chmodSync(file, before.mode & 0o777);
  return { before, after: statSync(file) };
}

function assertOnlyChangeTimeChanged(change: ReturnType<typeof catalogueMetadataChange>): void {
  assert.notEqual(change.after.ctimeMs, change.before.ctimeMs, 'The fixture must actually change ctime.');
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'mode', 'nlink'] as const) {
    assert.equal(change.after[field], change.before[field], `The fixture must preserve ${field}.`);
  }
}

function rewriteCataloguePreservingModificationTime(file: string) {
  const before = statSync(file);
  const original = readFileSync(file);
  const changed = Buffer.from(original.toString('utf8').replace(' notes', ' motes'));
  assert.notDeepEqual(changed, original);
  assert.equal(changed.length, original.length);
  writeFileSync(file, changed);
  utimesSync(file, before.atimeMs / 1000, before.mtimeMs / 1000);
  return { before, after: statSync(file) };
}

test('catalogue metadata-only ctime changes after review preserve the exact reviewed bytes', async t => {
  const f = await fixture(t);
  const originalDigest = createHash('sha256').update(await fs.readFile(f.cataloguePath)).digest('hex');
  const review = await reviewCatalogueForPrivateConversion(request(f));
  assertOnlyChangeTimeChanged(catalogueMetadataChange(f.cataloguePath));
  const receipt = await convertCatalogueToPrivateHub({ ...f.options, review });
  assert.equal(receipt.catalogueSha256, originalDigest);
  assert.equal(receipt.previews.length, kinds.length);
  const store = await PrivateHubStore.open(f.options.destinationDirectory, password);
  try { assert.deepEqual(await verifyPrivateHubConversion(store), receipt); }
  finally { await store.lock(); }
});

for (const completed of [0, 1]) {
  test(`catalogue metadata-only ctime changes after encrypted catalogue write at preview ${completed} remain valid`, async t => {
    const f = await fixture(t);
    const originalDigest = createHash('sha256').update(await fs.readFile(f.cataloguePath)).digest('hex');
    const review = await reviewCatalogueForPrivateConversion(request(f));
    let change: ReturnType<typeof catalogueMetadataChange> | undefined;
    const receipt = await convertCatalogueToPrivateHub({ ...f.options, review, onProgress: event => {
      if (event.stage === 'copying' && event.completed === completed) { change = catalogueMetadataChange(f.cataloguePath); }
    } });
    assert.ok(change, 'The fixture must change metadata during copying.');
    assertOnlyChangeTimeChanged(change);
    assert.equal(receipt.catalogueSha256, originalDigest);
    assert.equal(receipt.previews.length, kinds.length);
    const store = await PrivateHubStore.open(f.options.destinationDirectory, password);
    try { assert.deepEqual(await verifyPrivateHubConversion(store), receipt); }
    finally { await store.lock(); }
  });
}

for (const timing of ['after review', 'during copying'] as const) {
  test(`same-size catalogue content change with restored mtime ${timing} is rejected`, async t => {
    const f = await fixture(t);
    // Use an exactly representable timestamp so restoring mtime cannot hide the
    // intended digest check behind a timestamp-rounding failure.
    await fs.utimes(f.cataloguePath, 1_700_000_000, 1_700_000_000);
    const review = await reviewCatalogueForPrivateConversion(request(f));
    let change: ReturnType<typeof catalogueMetadataChange> | undefined;
    if (timing === 'after review') { change = rewriteCataloguePreservingModificationTime(f.cataloguePath); }
    await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review, onProgress: event => {
      if (timing === 'during copying' && event.stage === 'copying' && event.completed === 1) {
        change = rewriteCataloguePreservingModificationTime(f.cataloguePath);
      }
    } }));
    assert.ok(change, 'The fixture must actually alter catalogue contents.');
    assertOnlyChangeTimeChanged(change);
    if (timing === 'after review') { await noDestination(f.options); }
    else {
      const store = await PrivateHubStore.open(f.options.destinationDirectory, password);
      try { await assert.rejects(verifyPrivateHubConversion(store)); }
      finally { await store.lock(); }
    }
  });
}

for (const failure of ['cancellation', 'descriptor-close uncertainty'] as const) {
  test(`catalogue reread after metadata drift preserves ${failure} and erases buffers`, async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    const options = { ...f.options, signal: controller.signal };
    const review = await reviewCatalogueForPrivateConversion({ ...request(f), signal: controller.signal });
    const retained: Buffer[] = [];
    let change: ReturnType<typeof catalogueMetadataChange> | undefined;
    let reread = 0;
    let closed = 0;
    const open = fs.open;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (String(args[0]) !== f.cataloguePath || !change) { return handle; }
      reread++;
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        retained.push(result.buffer as Buffer);
        if (failure === 'cancellation') { controller.abort(); }
        return result;
      });
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => {
        await close(); closed++;
        if (failure === 'descriptor-close uncertainty') { throw new Error(marker + ' reread close failed'); }
      });
      return handle;
    });
    await assert.rejects(convertCatalogueToPrivateHub({ ...options, review, onProgress: event => {
      if (event.stage === 'copying' && event.completed === 1) { change = catalogueMetadataChange(f.cataloguePath); }
    } }), error => {
      if (failure === 'cancellation') { assert.equal(error, controller.signal.reason); }
      else { assert.ok(isPrivateHubConversionCleanupFailure(error)); assert.equal(error.message.includes(marker), false); }
      return true;
    });
    assert.ok(change);
    assertOnlyChangeTimeChanged(change);
    assert.equal(reread, 1);
    assert.equal(closed, 1);
    assert.ok(retained.length > 0 && retained.every(bytes => bytes.every(byte => byte === 0)));
  });
}

test('review is stale when only the source-parent identity changes', async t => {
  const f = await fixture(t);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
    const stats = await lstat(...args);
    // Model directory replacement while retaining identical child snapshots.
    if (args[0] === f.source) { return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino: Number(stats.ino) + 1 }); }
    return stats;
  });
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review }), /source changed after review/);
  await noDestination(f.options);
});

for (const [name, mutate] of mutations) {
  test('review is stale when ' + name, async t => {
    const f = await fixture(t);
    if (name === 'a missing preview appears' || name === 'the preview directory identity changes') { await fs.unlink(f.previews.filmstrip); }
    const review = await reviewCatalogueForPrivateConversion(request(f));
    await mutate(f);
    await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review, allowMissingPreviews: true }));
    await noDestination(f.options);
  });
}

test('a failed conversion attempt consumes the review even after the inventory becomes valid again', async t => {
  const f = await fixture(t);
  const review = await reviewCatalogueForPrivateConversion(request(f));
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review, assertSourceQuiescent: () => undefined }));
  await noDestination(f.options);
  await assert.rejects(convertCatalogueToPrivateHub({ ...f.options, review }));
  await noDestination(f.options);
});

test('pre-cancelled review and asynchronous quiescence are rejected without opening a source descriptor', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  t.mock.method(fs, 'open', () => { throw new Error('Cancelled review must not open a source'); });
  await assert.rejects(reviewCatalogueForPrivateConversion({ ...request(f), signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(reviewCatalogueForPrivateConversion({ ...request(f), assertSourceQuiescent: async () => undefined }), /synchronous/);
  t.mock.restoreAll(); await noDestination(f.options);
});

test('cancellation during catalogue reading wipes the read buffer and closes the source descriptor', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const retained: Buffer[] = [];
  let closed = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof read>) => {
      const result = await read(...readArgs); retained.push(result.buffer as Buffer); controller.abort(); return result;
    });
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); closed++; });
    return handle;
  });
  await assert.rejects(reviewCatalogueForPrivateConversion({ ...request(f), signal: controller.signal }), { name: 'AbortError' });
  assert.equal(closed, 1);
  assert.ok(retained.length > 0 && retained.every(bytes => bytes.every(byte => byte === 0)));
  await noDestination(f.options);
});

test('revoked source quiescence cannot issue a review after reading catalogue metadata', async t => {
  const f = await fixture(t);
  let quiescent = true;
  let closed = 0;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (...readArgs: Parameters<typeof read>) => {
      const result = await read(...readArgs); quiescent = false; return result;
    });
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); closed++; });
    return handle;
  });
  await assert.rejects(reviewCatalogueForPrivateConversion({ ...request(f), assertSourceQuiescent: () => {
    if (!quiescent) { throw new Error('Synthetic source writer resumed'); }
  } }), /writer resumed/);
  assert.equal(closed, 1); await noDestination(f.options);
});

test('review close uncertainty is branded without exposing source details or issuing a usable proof', async t => {
  const f = await fixture(t);
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); throw new Error(marker + ' source close failed'); });
    return handle;
  });
  await assert.rejects(reviewCatalogueForPrivateConversion(request(f)), error => {
    assert.ok(isPrivateHubConversionCleanupFailure(error));
    assert.equal(error.message.includes(marker), false); return true;
  });
  await noDestination(f.options);
});
