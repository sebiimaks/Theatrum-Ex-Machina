import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { isPrivateSourceAdditionReview, reviewPrivateSourceAddition,
  type PrivateSourceAdditionResult, type PrivateSourceAdditionReview } from './private-source-addition';

const nativeFs = require('node:fs');
function ready(result: PrivateSourceAdditionResult): PrivateSourceAdditionReview {
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') { throw new Error('Expected synthetic source review'); }
  return result.review;
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, 'private-addition-'));
  const selected = path.join(directory, 'selected');
  const offline = path.join(directory, 'offline');
  await fs.mkdir(selected);
  const catalogue = { inputDirs: { 0: { path: offline, watch: true } },
    images: [{ ...NewImageElement(), hash: 'synthetic', fileName: 'not-present.mp4', inputSource: 0 }],
  } as unknown as FinalObject;
  const controller = new AbortController();
  let current = true;
  const reviews: PrivateSourceAdditionReview[] = [];
  const review = async (value = catalogue, root = selected) => {
    const result = await reviewPrivateSourceAddition({ catalogue: value, newRoot: root,
      signal: controller.signal, isCurrent: () => current });
    if (result.status === 'ready') { reviews.push(result.review); }
    return result;
  };
  t.after(async () => {
    for (const value of reviews) { value.dispose(); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, selected, offline, catalogue, controller, review, setCurrent: (value: boolean) => { current = value; } };
}

test('review is branded, frozen and admits an empty selected directory without changing the catalogue', async t => {
  const f = await fixture(t);
  const before = JSON.stringify(f.catalogue);
  const review = ready(await f.review());
  assert.equal(isPrivateSourceAdditionReview(review), true);
  assert.equal(isPrivateSourceAdditionReview({ ...review }), false);
  assert.equal(isPrivateSourceAdditionReview(undefined), false);
  assert.equal(Object.isFrozen(review), true);
  assert.equal(review.newRoot, f.selected); assert.equal(review.sourceIndex, 1);
  assert.equal(review.isCurrent(), true); assert.equal(await review.validate(), true);
  assert.equal(review.matchesCatalogue(f.catalogue), true);
  assert.equal(JSON.stringify(f.catalogue), before);
});

test('review never probes saved roots, enumerates a folder, opens files or writes source data', async t => {
  const f = await fixture(t);
  const checked: string[] = [];
  const asyncStat = nativeFs.promises.lstat;
  const syncStat = nativeFs.lstatSync;
  t.mock.method(nativeFs.promises, 'lstat', (value: string, ...args: unknown[]) => { checked.push(value); return asyncStat(value, ...args); });
  t.mock.method(nativeFs, 'lstatSync', (value: string, ...args: unknown[]) => { checked.push(value); return syncStat(value, ...args); });
  for (const method of ['open', 'readFile', 'readdir', 'opendir', 'writeFile', 'mkdir', 'rename']) {
    t.mock.method(nativeFs.promises, method, () => { assert.fail('No source content operation'); });
  }
  const review = ready(await f.review());
  assert.equal(await review.validate(), true);
  assert.ok(checked.length > 0);
  assert.ok(checked.every(value => value === f.selected));
});

test('safe allocation reserves sparse configured keys and all legacy and location indices', async t => {
  const f = await fixture(t);
  f.catalogue.inputDirs[3] = { path: path.join(f.directory, 'other-offline'), watch: false };
  f.catalogue.images.push({ ...NewImageElement(), inputSource: 6, deleted: true });
  f.catalogue.images.push({ ...NewImageElement(), inputSource: 9, missing: true });
  f.catalogue.images.push({ ...NewImageElement(), inputSource: 12, cleanName: '*FOLDER*' });
  f.catalogue.images[0].locations = [{ inputSource: 17, fileName: 'orphan.mp4', partialPath: '/' }];
  assert.equal(ready(await f.review()).sourceIndex, 18);
  f.catalogue.images[0].inputSource = 23;
  assert.equal(ready(await f.review()).sourceIndex, 24, 'legacy mirror still reserves its index');
});

test('empty catalogue starts at index zero', async t => {
  const f = await fixture(t);
  assert.equal(ready(await f.review({ ...f.catalogue, inputDirs: {}, images: [] })).sourceIndex, 0);
});

test('legacy saved path spellings and numeric-string source indices remain compatible', async t => {
  const f = await fixture(t);
  f.catalogue.inputDirs[0].path += '/nested/..';
  Object.assign(f.catalogue.images[0], { inputSource: '0' });
  const review = ready(await f.review());
  assert.equal(review.sourceIndex, 1);
  assert.equal(review.matchesCatalogue(f.catalogue), true);
});

test('unrelated notes, source preferences, row reorder and lower indices do not conflict', async t => {
  const f = await fixture(t);
  f.catalogue.inputDirs[3] = { path: path.join(f.directory, 'another'), watch: true };
  const review = ready(await f.review());
  const newer = structuredClone(f.catalogue);
  newer.images[0].notes = 'A later note'; newer.inputDirs[0].watch = false;
  Object.assign(newer.inputDirs[0], { futureSource: 'retained' });
  newer.images.push({ ...NewImageElement(), inputSource: 2 });
  newer.images.reverse();
  assert.equal(review.matchesCatalogue(newer), true);
});

for (const change of ['path', 'configured-index', 'legacy-index', 'location-index', 'overlap', 'duplicate']) {
  test('changed ' + change + ' conflicts with the captured catalogue allocation', async t => {
    const f = await fixture(t);
    const review = ready(await f.review());
    const newer = structuredClone(f.catalogue);
    switch (change) {
      case 'path': newer.inputDirs[0].path += '-moved'; break;
      case 'configured-index': newer.inputDirs[7] = { path: path.join(f.directory, 'new-offline'), watch: false }; break;
      case 'legacy-index': newer.images[0].inputSource = 1; break;
      case 'location-index': newer.images[0].locations = [{ inputSource: 1, fileName: 'video', partialPath: '/' }]; break;
      case 'overlap': newer.inputDirs[0].path = path.join(f.selected, 'nested'); break;
      case 'duplicate': newer.inputDirs[0].path = f.selected; break;
    }
    assert.equal(review.matchesCatalogue(newer), false);
  });
}

test('duplicates and nested or parent roots fail lexically before source probes', async t => {
  const f = await fixture(t);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Rejected roots must not be probed'); });
  assert.deepEqual(await f.review(f.catalogue, f.offline), { status: 'duplicate' });
  for (const root of [f.directory, path.join(f.offline, 'nested')]) {
    assert.deepEqual(await f.review(f.catalogue, root), { status: 'invalid' });
  }
  f.catalogue.inputDirs[0].path += '/';
  assert.deepEqual(await f.review(f.catalogue, f.offline), { status: 'duplicate' });
});

test('case and Unicode-equivalent roots overlap conservatively on case-insensitive platforms', {
  skip: process.platform !== 'darwin' && process.platform !== 'win32',
}, async t => {
  const f = await fixture(t);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Case-equivalent roots must not be probed'); });
  assert.deepEqual(await f.review(f.catalogue, f.offline.toUpperCase()), { status: 'duplicate' });
  assert.deepEqual(await f.review(f.catalogue, path.join(f.offline.toUpperCase(), 'child')), { status: 'invalid' });
  f.catalogue.inputDirs[0].path = path.join(f.directory, 'e\u0301');
  assert.deepEqual(await f.review(f.catalogue, path.join(f.directory, '\u00e9')), { status: 'duplicate' });
});

test('malformed native paths and configured source keys fail before probes', async t => {
  const f = await fixture(t);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Malformed selection must not be probed'); });
  for (const root of ['', '/', 'relative', f.selected + '/', f.selected + '/../selected', f.selected + '\0secret', '/' + 'x'.repeat(32_768)]) {
    assert.deepEqual(await f.review(f.catalogue, root), { status: 'invalid' });
  }
  for (const key of ['-1', '01', '1.5', String(Number.MAX_SAFE_INTEGER + 1), '__proto__']) {
    const catalogue = structuredClone(f.catalogue);
    Object.defineProperty(catalogue.inputDirs, key, { value: { path: f.offline, watch: false }, enumerable: true });
    assert.deepEqual(await f.review(catalogue), { status: 'invalid' });
  }
  for (const root of ['', '/', 'relative', f.offline + '\0secret']) {
    const catalogue = structuredClone(f.catalogue); catalogue.inputDirs[0].path = root;
    assert.deepEqual(await f.review(catalogue), { status: 'invalid' });
  }
});

test('malformed source references are rejected even when deleted or hidden', async t => {
  const f = await fixture(t);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Malformed reference must not be probed'); });
  for (const index of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, null, undefined, 'bad']) {
    const catalogue = structuredClone(f.catalogue);
    Object.assign(catalogue.images[0], { inputSource: index, deleted: true });
    assert.deepEqual(await f.review(catalogue), { status: 'invalid' });
  }
  for (const locations of [[], [null], [{ inputSource: -1 }], [{ inputSource: '1' }]]) {
    const catalogue = structuredClone(f.catalogue);
    Object.assign(catalogue.images[0], { locations, missing: true });
    assert.deepEqual(await f.review(catalogue), { status: 'invalid' });
  }
});

test('source, row, location and safe-integer limits are checked before probing', async t => {
  const f = await fixture(t);
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Oversized catalogue must not be probed'); });
  const many = structuredClone(f.catalogue);
  for (let index = 1; index < 256; index++) { many.inputDirs[index] = { path: path.join(f.directory, 'source-' + index), watch: false }; }
  assert.deepEqual(await f.review(many), { status: 'limit' });
  const rows = structuredClone(f.catalogue); rows.images.length = 100_001;
  assert.deepEqual(await f.review(rows), { status: 'limit' });
  const locations = structuredClone(f.catalogue); locations.images[0].locations = new Array(100_001);
  assert.deepEqual(await f.review(locations), { status: 'limit' });
  const exhausted = structuredClone(f.catalogue); exhausted.images[0].inputSource = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await f.review(exhausted), { status: 'limit' });
});

test('255 existing sources can add one final source', async t => {
  const f = await fixture(t);
  for (let index = 1; index < 255; index++) { f.catalogue.inputDirs[index] = { path: path.join(f.directory, 'source-' + index), watch: false }; }
  assert.equal(ready(await f.review()).sourceIndex, 255);
});

test('missing roots, regular files, root symlinks and symlink ancestors are unavailable', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.review(f.catalogue, path.join(f.directory, 'missing')), { status: 'source-unavailable' });
  const file = path.join(f.directory, 'file'); await fs.writeFile(file, 'synthetic');
  assert.deepEqual(await f.review(f.catalogue, file), { status: 'source-unavailable' });
  const link = path.join(f.directory, 'link'); await fs.symlink(f.selected, link);
  assert.deepEqual(await f.review(f.catalogue, link), { status: 'source-unavailable' });
  const parent = path.join(f.directory, 'parent-link'); await fs.symlink(f.directory, parent);
  assert.deepEqual(await f.review(f.catalogue, path.join(parent, 'selected')), { status: 'source-unavailable' });
});

test('root replacement permanently revokes review even after its old identity is restored', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  const moved = f.selected + '-old'; await fs.rename(f.selected, moved); await fs.mkdir(f.selected);
  assert.equal(review.isCurrent(), false);
  await fs.rmdir(f.selected); await fs.rename(moved, f.selected);
  assert.equal(review.isCurrent(), false); assert.equal(await review.validate(), false); assert.equal(review.newRoot, '');
});

test('new child files do not invalidate directory identity or cause enumeration', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  await fs.writeFile(path.join(f.selected, 'new-video.mp4'), 'synthetic');
  assert.equal(review.isCurrent(), true); assert.equal(await review.validate(), true);
});

test('abort before or during capture and owner revocation cannot create or revive authority', async t => {
  const f = await fixture(t); f.controller.abort();
  assert.deepEqual(await f.review(), { status: 'cancelled' });
  const next = await fixture(t);
  const stat = nativeFs.promises.lstat;
  t.mock.method(nativeFs.promises, 'lstat', async (value: string, ...args: unknown[]) => {
    const result = await stat(value, ...args); next.controller.abort(); return result;
  });
  assert.deepEqual(await next.review(), { status: 'cancelled' });
  t.mock.restoreAll();
  const owner = await fixture(t); const review = ready(await owner.review());
  owner.setCurrent(false); assert.equal(review.isCurrent(), false); owner.setCurrent(true);
  assert.equal(review.isCurrent(), false); assert.equal(review.matchesCatalogue(owner.catalogue), false);
});

test('review yields while reading large catalogues and honors cancellation before filesystem access', async t => {
  const f = await fixture(t);
  f.catalogue.images = Array.from({ length: 65 }, () => ({ ...NewImageElement(), inputSource: 0 }));
  t.mock.method(nativeFs.promises, 'lstat', () => { assert.fail('Cancelled review must not probe'); });
  setImmediate(() => f.controller.abort());
  assert.deepEqual(await f.review(), { status: 'cancelled' });
});

test('explicit disposal and concurrent final validation revoke safely', async t => {
  const f = await fixture(t);
  const review = ready(await f.review());
  const stat = nativeFs.promises.lstat;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(nativeFs.promises, 'lstat', async (value: string, ...args: unknown[]) => { await held; return stat(value, ...args); });
  const validating = review.validate();
  assert.equal(await review.validate(), false);
  review.dispose(); release();
  assert.equal(await validating, false); assert.equal(review.isCurrent(), false); assert.equal(review.newRoot, '');
});
