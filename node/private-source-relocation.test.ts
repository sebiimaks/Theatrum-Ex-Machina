import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { isPrivateSourceRelocationReview, reviewPrivateSourceRelocation,
  type PrivateSourceRelocationResult, type PrivateSourceRelocationReview } from './private-source-relocation';

const nativeFs = require('node:fs');
function ready(result: PrivateSourceRelocationResult): PrivateSourceRelocationReview {
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') { throw new Error('Expected synthetic review'); }
  return result.review;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
async function fixture(t: TestContext, count = 2) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'private-relocation-'));
  const oldRoot = path.join(directory, 'disconnected');
  const newRoot = path.join(directory, 'new');
  await fs.mkdir(newRoot);
  await fs.mkdir(path.join(newRoot, 'nested'));
  const catalogue = {
    inputDirs: { 0: { path: oldRoot, watch: true, unknown: 'preserved' } },
    images: Array.from({ length: count }, (_, index) => ({ ...NewImageElement(), hash: 'synthetic_' + index,
      fileName: 'video-' + index + '.mp4', partialPath: index === 0 ? '/' : '/nested', inputSource: 0,
      fileSize: 5, cleanName: 'Synthetic ' + index, notes: 'unchanged notes', tags: ['tag'] })),
  } as unknown as FinalObject;
  for (const image of catalogue.images) {
    await fs.writeFile(path.join(newRoot, image.partialPath.replace(/^\/+/, ''), image.fileName), 'media');
  }
  const signal = new AbortController();
  let current = true;
  const reviews: PrivateSourceRelocationReview[] = [];
  const review = async (value = catalogue, chosen = newRoot, index = 0) => {
    const result = await reviewPrivateSourceRelocation({ catalogue: value, sourceIndex: index, newRoot: chosen,
      signal: signal.signal, isCurrent: () => current });
    if (result.status === 'ready') { reviews.push(result.review); }
    return result;
  };
  t.after(async () => {
    for (const value of reviews) { value.dispose(); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, oldRoot, newRoot, catalogue, signal, review, setCurrent: (value: boolean) => { current = value; },
    file: (index: number) => path.join(newRoot, catalogue.images[index].partialPath.replace(/^\/+/, ''), catalogue.images[index].fileName) };
}

test('metadata review is branded and frozen, with only bounded main-owned details', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  assert.equal(review.sourceIndex, 0); assert.equal(review.newRoot, f.newRoot); assert.equal(review.videoCount, 2);
  assert.equal(isPrivateSourceRelocationReview(review), true);
  assert.equal(isPrivateSourceRelocationReview({ ...review }), false);
  assert.equal(isPrivateSourceRelocationReview(undefined), false);
  assert.equal(Object.isFrozen(review), true);
  assert.equal(review.isCurrent(), true); assert.equal(await review.validate(), true);
  assert.equal(review.matchesCatalogue(f.catalogue), true);
  assert.equal(JSON.stringify(review).includes('video-'), false);
});

test('review never opens media, writes files, or probes the disconnected original root', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.catalogue);
  const stat = nativeFs.promises.lstat;
  const rootStat = nativeFs.lstatSync;
  const paths: string[] = [];
  t.mock.method(nativeFs.promises, 'lstat', (value: string, ...args: unknown[]) => {
    paths.push(value); return stat(value, ...args);
  });
  t.mock.method(nativeFs, 'lstatSync', (value: string, ...args: unknown[]) => {
    paths.push(value); return rootStat(value, ...args);
  });
  for (const method of ['open', 'readFile', 'writeFile', 'mkdir', 'rename']) {
    t.mock.method(nativeFs.promises, method, () => { assert.fail('Review must be metadata only'); });
  }
  const review = ready(await f.review());
  assert.equal(await review.validate(), true);
  assert.equal(JSON.stringify(f.catalogue), before);
  assert.ok(paths.length > 0);
  assert.ok(paths.every(value => value === f.newRoot || value.startsWith(f.newRoot + path.sep)));
});

test('a missing referenced file fails instead of changing any catalogue field', async t => {
  const f = await fixture(t);
  await fs.unlink(f.file(1));
  const before = JSON.stringify(f.catalogue);
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
  assert.equal(JSON.stringify(f.catalogue), before);
});

test('all locations of a video must match, including secondary source references', async t => {
  const f = await fixture(t, 1);
  f.catalogue.images[0].inputSource = 1;
  f.catalogue.inputDirs[1] = { path: path.join(f.directory, 'unrelated'), watch: false };
  f.catalogue.images[0].locations = [
    { inputSource: 1, partialPath: '/', fileName: 'elsewhere.mp4' },
    { inputSource: 0, partialPath: '/', fileName: 'video-0.mp4' },
    { inputSource: 0, partialPath: '/nested', fileName: 'also.mp4' },
  ];
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
  await fs.writeFile(path.join(f.newRoot, 'nested/also.mp4'), 'media');
  assert.equal(ready(await f.review()).videoCount, 1);
});

test('deleted entries and folder placeholders do not require source media', async t => {
  const f = await fixture(t);
  f.catalogue.images.push({ ...NewImageElement(), deleted: true, inputSource: 0, fileName: 'not-present' });
  f.catalogue.images.push({ ...NewImageElement(), cleanName: '*FOLDER*', inputSource: 0, fileName: 'folder' });
  assert.equal(ready(await f.review()).videoCount, 2);
});

test('saved missing flags remain untouched and do not skip verification', async t => {
  const f = await fixture(t);
  f.catalogue.images[0].missing = true;
  const review = ready(await f.review());
  assert.equal(f.catalogue.images[0].missing, true);
  assert.equal(review.matchesCatalogue(f.catalogue), true);
  await fs.unlink(f.file(0));
  assert.equal(await review.validate(), false);
});

test('notes, tags and unrelated source options do not conflict with reviewed source locations', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  const updated = clone(f.catalogue);
  updated.images[0].notes = 'a concurrent note'; updated.images[0].tags = ['another'];
  updated.images[0].stars = 5.5; updated.inputDirs[0].watch = false;
  updated.inputDirs[0].ignoredSubdirectories = ['unused'];
  assert.equal(review.matchesCatalogue(updated), true);
});

for (const change of ['source-path', 'filename', 'partial-path', 'hash', 'filesize', 'source-index', 'deleted', 'add-location', 'add-video', 'reorder']) {
  test('a changed ' + change + ' invalidates catalogue comparison without stale writes', async t => {
    const f = await fixture(t);
    const review = ready(await f.review());
    const updated = clone(f.catalogue);
    switch (change) {
      case 'source-path': updated.inputDirs[0].path += '-moved'; break;
      case 'filename': updated.images[0].fileName = 'changed.mp4'; break;
      case 'partial-path': updated.images[0].partialPath = '/changed'; break;
      case 'hash': updated.images[0].hash = 'different'; break;
      case 'filesize': updated.images[0].fileSize++; break;
      case 'source-index': updated.images[0].inputSource = 1; break;
      case 'deleted': updated.images[0].deleted = true; break;
      case 'add-location': updated.images[0].locations = [{ inputSource: 0, partialPath: '/', fileName: 'added.mp4' }]; break;
      case 'add-video': updated.images.push({ ...updated.images[0] }); break;
      case 'reorder': updated.images.reverse(); break;
    }
    assert.equal(review.matchesCatalogue(updated), false);
  });
}

test('new or changed sources cannot create an overlap after review', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  for (const root of [f.newRoot, path.dirname(f.newRoot), path.join(f.newRoot, 'nested')]) {
    const updated = clone(f.catalogue);
    updated.inputDirs[1] = { path: root, watch: false };
    assert.equal(review.matchesCatalogue(updated), false);
  }
});

test('empty sources, unsafe sizes and invalid paths fail before probing selected media', async t => {
  const f = await fixture(t);
  const stat = t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Malformed metadata must not be probed'); });
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, undefined]) {
    const value = clone(f.catalogue); value.images[0].fileSize = size as number;
    assert.deepEqual(await f.review(value), { status: 'invalid' });
  }
  for (const field of ['fileName', 'partialPath'] as const) {
    for (const value of ['../outside', 'bad\0name']) {
      const catalogue = clone(f.catalogue); catalogue.images[0][field] = value;
      assert.deepEqual(await f.review(catalogue), { status: 'invalid' });
    }
  }
  assert.deepEqual(await f.review({ ...f.catalogue, images: [] }), { status: 'invalid' });
  assert.equal(stat.mock.callCount(), 0);
});

test('same-root, overlapping-root and malformed native selections are rejected without filesystem access', async t => {
  const f = await fixture(t);
  const stat = t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Rejected selection must not be probed'); });
  for (const root of ['', '/', 'relative', f.newRoot + '\0secret', '/' + 'x'.repeat(32_768),
    f.oldRoot, f.oldRoot + '/', f.directory, path.join(f.oldRoot, 'nested')]) {
    assert.deepEqual(await f.review(f.catalogue, root), { status: 'invalid' });
  }
  assert.deepEqual(await f.review(f.catalogue, f.newRoot, -1), { status: 'invalid' });
  assert.deepEqual(await f.review(f.catalogue, f.newRoot, 1), { status: 'invalid' });
  assert.equal(stat.mock.callCount(), 0);
});

test('oversized source tables and catalogue rows are bounded before filesystem probing', async t => {
  const f = await fixture(t);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Oversized catalogue must not be probed'); });
  const large = clone(f.catalogue); large.images.length = 100_001;
  assert.deepEqual(await f.review(large), { status: 'invalid' });
  const many = clone(f.catalogue);
  for (let index = 1; index <= 256; index++) { many.inputDirs[index] = { path: path.join(f.directory, 'source-' + index), watch: false }; }
  assert.deepEqual(await f.review(many), { status: 'invalid' });
});

test('size mismatch and non-regular source entries are unavailable with generic errors', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file(0), 'different-size');
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
  await fs.unlink(f.file(0)); await fs.mkdir(f.file(0));
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
  t.mock.method(nativeFs.promises, 'lstat', () => { throw new Error(f.newRoot + '/private-error'); });
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
});

test('a source file symlink is rejected even when its target has the expected size', async t => {
  const f = await fixture(t);
  await fs.unlink(f.file(0)); await fs.symlink(f.file(1), f.file(0));
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
});

test('a symlink in an intermediate media directory is rejected', async t => {
  const f = await fixture(t);
  const moved = path.join(f.directory, 'moved-nested');
  await fs.rename(path.join(f.newRoot, 'nested'), moved);
  await fs.symlink(moved, path.join(f.newRoot, 'nested'));
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
});

test('root symlinks and symlink ancestors are rejected', async t => {
  const f = await fixture(t);
  const link = path.join(f.directory, 'linked-root');
  await fs.symlink(f.newRoot, link);
  assert.deepEqual(await f.review(f.catalogue, link), { status: 'source-unavailable' });
  const parent = path.join(f.directory, 'linked-parent');
  await fs.symlink(f.directory, parent);
  assert.deepEqual(await f.review(f.catalogue, path.join(parent, 'new')), { status: 'source-unavailable' });
});

test('root replacement permanently revokes review even if its original inode returns', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  const original = path.join(f.directory, 'original');
  await fs.rename(f.newRoot, original); await fs.mkdir(f.newRoot);
  assert.equal(review.isCurrent(), false);
  await fs.rmdir(f.newRoot); await fs.rename(original, f.newRoot);
  assert.equal(review.isCurrent(), false); assert.equal(await review.validate(), false);
  assert.equal(review.newRoot, '');
});

test('file replacement and same-size writes invalidate the final review', async t => {
  for (const replace of [false, true]) {
    const f = await fixture(t);
    const review = ready(await f.review());
    if (replace) { await fs.rename(f.file(0), f.file(0) + '.original'); }
    await fs.writeFile(f.file(0), 'other');
    assert.equal(await review.validate(), false);
    assert.equal(review.isCurrent(), false);
  }
});

test('final validation detects a newly inserted directory symlink', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  const moved = path.join(f.directory, 'nested-moved');
  await fs.rename(path.join(f.newRoot, 'nested'), moved);
  await fs.symlink(moved, path.join(f.newRoot, 'nested'));
  assert.equal(await review.validate(), false);
});

test('abort before review and during asynchronous metadata checks cannot create authority', async t => {
  const f = await fixture(t);
  f.signal.abort();
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Aborted operation must not be probed'); });
  assert.deepEqual(await f.review(), { status: 'cancelled' });
  t.mock.restoreAll();
  const next = await fixture(t);
  const stat = nativeFs.promises.lstat;
  t.mock.method(nativeFs.promises, 'lstat', async (value: string, ...args: unknown[]) => {
    const result = await stat(value, ...args); next.signal.abort(); return result;
  });
  assert.deepEqual(await next.review(), { status: 'cancelled' });
});

test('review yields between bounded chunks and honours cancellation during that yield', async t => {
  const f = await fixture(t, 65);
  const stat = nativeFs.promises.lstat;
  let fileChecks = 0;
  t.mock.method(nativeFs.promises, 'lstat', async (value: string, ...args: unknown[]) => {
    const result = await stat(value, ...args);
    if (value.endsWith('.mp4') && ++fileChecks === 32) { setImmediate(() => f.signal.abort()); }
    return result;
  });
  assert.deepEqual(await f.review(), { status: 'cancelled' });
  assert.equal(fileChecks, 32);
});

test('lifetime revocation and explicit disposal clear captured paths and cannot revive', async t => {
  for (const mode of ['owner', 'abort', 'dispose']) {
    const f = await fixture(t);
    const review = ready(await f.review());
    if (mode === 'owner') { f.setCurrent(false); }
    if (mode === 'abort') { f.signal.abort(); }
    if (mode === 'dispose') { review.dispose(); }
    assert.equal(review.isCurrent(), false); f.setCurrent(true);
    assert.equal(review.isCurrent(), false); assert.equal(review.matchesCatalogue(f.catalogue), false);
    assert.equal(await review.validate(), false); assert.equal(review.newRoot, '');
  }
});

test('competing validation is rejected and cancellation during final validation drains safely', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  const stat = nativeFs.promises.lstat;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(nativeFs.promises, 'lstat', async (value: string, ...args: unknown[]) => {
    await held; return stat(value, ...args);
  });
  const pending = review.validate();
  assert.equal(await review.validate(), false);
  f.signal.abort(); release();
  assert.equal(await pending, false); assert.equal(review.isCurrent(), false);
});


test('catalogue snapshot yields before source probes and stops when cancelled', async t => {
  const f = await fixture(t, 65);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Cancelled catalogue review must not probe sources'); });
  setImmediate(() => f.signal.abort());
  assert.deepEqual(await f.review(), { status: 'cancelled' });
});

test('location arrays and file-name lengths are bounded before source probes', async t => {
  const f = await fixture(t, 1);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Oversized reference must not be probed'); });
  const many = clone(f.catalogue);
  many.images[0].locations = new Array(100_001);
  assert.deepEqual(await f.review(many), { status: 'invalid' });
  const longName = clone(f.catalogue); longName.images[0].fileName = 'x'.repeat(4_097);
  assert.deepEqual(await f.review(longName), { status: 'invalid' });
});


test('capture rejects an intermediate link before probing a file through it', async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.newRoot, 'nested'), f.oldRoot);
  await fs.symlink(f.oldRoot, path.join(f.newRoot, 'nested'));
  const probed: string[] = [];
  const stat = nativeFs.promises.lstat;
  t.mock.method(nativeFs.promises, 'lstat', (value: string, ...args: unknown[]) => {
    probed.push(value); return stat(value, ...args);
  });
  assert.deepEqual(await f.review(), { status: 'source-unavailable' });
  assert.ok(probed.includes(path.join(f.newRoot, 'nested')));
  assert.equal(probed.includes(f.file(1)), false, 'No leaf metadata probe may follow the rejected intermediate link');
});

test('validation rejects an intermediate link before probing its target file', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  await fs.rename(path.join(f.newRoot, 'nested'), f.oldRoot);
  await fs.symlink(f.oldRoot, path.join(f.newRoot, 'nested'));
  const probed: string[] = [];
  const stat = nativeFs.promises.lstat;
  t.mock.method(nativeFs.promises, 'lstat', (value: string, ...args: unknown[]) => {
    probed.push(value); return stat(value, ...args);
  });
  assert.equal(await review.validate(), false);
  assert.ok(probed.includes(path.join(f.newRoot, 'nested')));
  assert.equal(probed.includes(f.file(1)), false, 'Final validation must not probe through the rejected intermediate link');
});

test('deep relative-directory checks yield and stop before further metadata probes on cancellation', async t => {
  const f = await fixture(t, 1);
  const folders = Array.from({ length: 65 }, (_, index) => 'd' + index);
  const nested = path.join(f.newRoot, ...folders);
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'video-0.mp4'), 'media');
  f.catalogue.images[0].partialPath = '/' + folders.join('/');
  const stat = nativeFs.promises.lstat;
  let directoryChecks = 0;
  t.mock.method(nativeFs.promises, 'lstat', async (value: string, ...args: unknown[]) => {
    const result = await stat(value, ...args);
    if (value.startsWith(f.newRoot + path.sep) && ++directoryChecks === 32) { setImmediate(() => f.signal.abort()); }
    return result;
  });
  assert.deepEqual(await f.review(), { status: 'cancelled' });
  assert.equal(directoryChecks, 32);
});
