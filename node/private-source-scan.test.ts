import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject } from '../interfaces/final-object.interface';
import { reviewPrivateSourceScan, isPrivateSourceScanReview, isPrivateSourceScanCleanupFailure, type PrivateSourceScanOptions } from './private-source-scan';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp'); await fs.promises.mkdir(temporary, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(temporary, 'private-scan-'));
  const source = path.join(root, 'source'); await fs.promises.mkdir(source);
  const controller = new AbortController(); let allowed = true;
  const catalogue = { images: [], inputDirs: { 0: { path: source, watch: false } } } as unknown as FinalObject;
  const options: PrivateSourceScanOptions = { catalogue, sourceIndex: 0, signal: controller.signal, isCurrent: () => allowed };
  t.after(async () => { controller.abort(); await fs.promises.rm(root, { recursive: true, force: true }); });
  const file = async (relative: string, data = 'SYNTHETIC VIDEO') => {
    const target = path.join(source, relative); await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data); return target;
  };
  const scan = () => reviewPrivateSourceScan(options);
  const ready = async () => {
    const result = await scan(); assert.equal(result.status, 'ready');
    if (result.status !== 'ready') { throw new Error('Expected scan review'); }
    t.after(() => result.review.dispose()); return result.review;
  };
  return { root, source, controller, catalogue, options, file, scan, ready, revoke: () => { allowed = false; } };
}

test('discovers nested built-in media metadata only and preserves originals, catalogue and watch setting', async t => {
  const f = await fixture(t);
  const first = await f.file('Video.MP4'); const second = await f.file('nested/deeper/movie.mkv');
  await f.file('nested/readme.txt'); await f.file('nested/script.exe'); await f.file('empty.mp4', '');
  const before = JSON.stringify(f.catalogue);
  const reading = t.mock.method(fs.promises, 'readFile', async () => { assert.fail('Discovery cannot read media bytes'); });
  const review = await f.ready();
  assert.deepEqual(review.files, [first, second].sort()); assert.equal(review.more, false);
  assert.equal(Object.isFrozen(review), true); assert.equal(Object.isFrozen(review.files), true);
  assert.equal(review.isCurrent(), true); assert.equal(review.fileCurrent(first), true);
  assert.equal(reading.mock.callCount(), 0); assert.equal(JSON.stringify(f.catalogue), before);
  assert.equal(isPrivateSourceScanReview(review), true); assert.equal(isPrivateSourceScanReview({ ...review }), false);
  assert.equal(review.fileCurrent(path.join(f.root, 'outside.mp4')), false);
  review.dispose(); assert.equal(review.isCurrent(), false); assert.equal(review.fileCurrent(first), false); assert.deepEqual(review.files, []);
});

test('empty scan is ready and native ignored/vha directories and symbolic links are not traversed', async t => {
  const f = await fixture(t);
  f.catalogue.inputDirs[0].ignoredSubdirectories = ['Ignored'];
  await f.file('Ignored/nested/private.mp4'); await f.file('vha-previews/private.mp4');
  const outside = path.join(f.root, 'outside'); await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, 'outside.mp4'), 'PRIVATE OUTSIDE');
  await fs.promises.symlink(outside, path.join(f.source, 'linked-directory'));
  await fs.promises.symlink(path.join(outside, 'outside.mp4'), path.join(f.source, 'linked.mp4'));
  const opened: string[] = [];
  const open = fs.promises.opendir.bind(fs.promises);
  t.mock.method(fs.promises, 'opendir', async (target: fs.PathLike, options?: fs.OpenDirOptions) => {
    opened.push(String(target)); return open(target, options);
  });
  const review = await f.ready(); assert.deepEqual(review.files, []); assert.equal(review.more, false);
  assert.deepEqual(opened, [f.source]);
});

test('skips known catalogue locations across roots and case spellings, but permits tombstoned paths', async t => {
  const f = await fixture(t);
  await f.file('known.mp4'); const deleted = await f.file('deleted.mp4'); const alternate = await f.file('sub/alternate.mp4');
  f.catalogue.inputDirs[1] = { path: path.join(f.source, 'sub'), watch: false };
  f.catalogue.images = [
    { ...NewImageElement(), hash: 'known', fileName: process.platform === 'linux' ? 'known.mp4' : 'KNOWN.MP4' },
    { ...NewImageElement(), hash: 'alternate', fileName: 'alternate.mp4', inputSource: 1 },
    { ...NewImageElement(), hash: 'deleted', fileName: 'deleted.mp4', deleted: true },
  ];
  const review = await f.ready(); assert.deepEqual(review.files, [deleted]); assert.equal(review.fileCurrent(alternate), false);
});

test('review source policy remains bound while its own catalogue appends and metadata edits are allowed', async t => {
  const f = await fixture(t); await f.file('one.mp4');
  const review = await f.ready();
  f.catalogue.images.push({ ...NewImageElement(), hash: 'new-import', fileName: 'one.mp4' });
  assert.equal(review.matchesCatalogue(f.catalogue), true);
  f.catalogue.images[0].notes = 'Saved metadata'; assert.equal(review.matchesCatalogue(f.catalogue), true);
  const original = f.catalogue.inputDirs[0].path;
  f.catalogue.inputDirs[0].path = path.join(f.root, 'other'); assert.equal(review.matchesCatalogue(f.catalogue), false);
  f.catalogue.inputDirs[0].path = original; assert.equal(review.matchesCatalogue(f.catalogue), true);
  f.catalogue.inputDirs[0].ignoredSubdirectories = ['sub']; assert.equal(review.matchesCatalogue(f.catalogue), false);
});

for (const changed of ['file', 'ancestor', 'root'] as const) {
  test(`${changed} replacement revokes captured file identity permanently`, async t => {
    const f = await fixture(t); const file = await f.file('sub/movie.mp4'); const review = await f.ready();
    const target = changed === 'file' ? file : changed === 'ancestor' ? path.dirname(file) : f.source;
    await fs.promises.rename(target, target + '-old');
    if (changed === 'file') { await fs.promises.writeFile(file, 'REPLACED FILE'); }
    else { await fs.promises.mkdir(target); }
    assert.equal(review.fileCurrent(file), false); assert.equal(review.isCurrent(), false);
  });
}

test('same-inode media edits invalidate the reviewed metadata snapshot', async t => {
  const f = await fixture(t); const file = await f.file('movie.mp4'); const review = await f.ready();
  await fs.promises.appendFile(file, 'CHANGED'); assert.equal(review.fileCurrent(file), false);
});

test('grant loss and pre-cancellation do not enumerate any directory', async t => {
  const f = await fixture(t); f.revoke();
  const open = t.mock.method(fs.promises, 'opendir', async () => { assert.fail('No directory access without grant'); });
  assert.deepEqual(await f.scan(), { status: 'cancelled' }); assert.equal(open.mock.callCount(), 0);
  f.controller.abort(); assert.deepEqual(await f.scan(), { status: 'cancelled' });
});

for (const phase of ['open', 'read'] as const) {
  for (const revoke of ['cancel', 'grant'] as const) {
    test(`late directory ${phase} after ${revoke} is drained and cannot return a review`, async t => {
      const f = await fixture(t); await f.file('movie.mp4');
      const entered = deferred(); const release = deferred(); t.after(() => release.resolve());
      const open = fs.promises.opendir.bind(fs.promises); let closes = 0;
      t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
        const directory = await open(...args);
        const close = directory.close.bind(directory);
        t.mock.method(directory, 'close', async () => { closes++; await close(); });
        if (phase === 'open') { entered.resolve(); await release.promise; }
        else {
          const read = directory.read.bind(directory);
          t.mock.method(directory, 'read', async () => { entered.resolve(); await release.promise; return read(); });
        }
        return directory;
      });
      const scanning = f.scan(); await entered.promise;
      if (revoke === 'cancel') { f.controller.abort(); } else { f.revoke(); }
      let settled = false; void scanning.then(() => { settled = true; });
      await Promise.resolve(); assert.equal(settled, false);
      release.resolve(); assert.deepEqual(await scanning, { status: 'cancelled' }); assert.equal(closes, 1);
    });
  }
}

test('candidate101 yields only100 sorted reviewed files and a more flag', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 101; index++) { await f.file(`movie-${index}.mp4`); }
  const review = await f.ready(); assert.equal(review.files.length, 100); assert.equal(review.more, true);
  assert.deepEqual(review.files, [...review.files].sort()); assert.equal(new Set(review.files).size, 100);
});

test('scan counts unsupported entries toward its10000 entry bound and closes the iterator', async t => {
  const f = await fixture(t); const open = fs.promises.opendir.bind(fs.promises); let closes = 0;
  t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
    const directory = await open(...args); const close = directory.close.bind(directory); let index = 0;
    t.mock.method(directory, 'read', async () => ({ name: `skip-${index++}.txt`, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false }));
    t.mock.method(directory, 'close', async () => { closes++; await close(); }); return directory;
  });
  assert.deepEqual(await f.scan(), { status: 'limit' }); assert.equal(closes, 1);
});

test('directory1001 and depth33 stop without authorizing partial imports', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 1000; index++) { await fs.promises.mkdir(path.join(f.source, `dir-${index}`)); }
  assert.deepEqual(await f.scan(), { status: 'limit' });
  await fs.promises.rm(f.source, { recursive: true }); await fs.promises.mkdir(f.source);
  await fs.promises.mkdir(path.join(f.source, ...Array.from({ length: 33 }, () => 'nested')), { recursive: true });
  assert.deepEqual(await f.scan(), { status: 'limit' });
});

test('catalogue row/location limits and invalid source policy reject before filesystem enumeration', async t => {
  const f = await fixture(t);
  const open = t.mock.method(fs.promises, 'opendir', async () => { assert.fail('No enumeration for invalid catalogue'); });
  f.catalogue.images = Array(100001).fill(NewImageElement()); assert.deepEqual(await f.scan(), { status: 'limit' });
  f.catalogue.images = [{ ...NewImageElement(), locations: Array(100001).fill({ inputSource: 0, fileName: 'a.mp4', partialPath: '/' }) }];
  assert.deepEqual(await f.scan(), { status: 'limit' });
  f.catalogue.images = []; f.catalogue.inputDirs[0].ignoredSubdirectories = ['../escape'];
  assert.deepEqual(await f.scan(), { status: 'invalid' }); assert.equal(open.mock.callCount(), 0);
});

for (const phase of ['open', 'read', 'close'] as const) {
  test(`directory ${phase} failure is generic and cleanup failure is separately branded`, async t => {
    const f = await fixture(t); await f.file('movie.mp4');
    const open = fs.promises.opendir.bind(fs.promises);
    t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
      if (phase === 'open') { throw new Error(f.source); }
      const directory = await open(...args);
      if (phase === 'read') { t.mock.method(directory, 'read', async () => { throw new Error(f.source); }); }
      if (phase === 'close') {
        const close = directory.close.bind(directory);
        t.mock.method(directory, 'close', async () => { await close(); throw new Error(f.source); });
      }
      return directory;
    });
    if (phase === 'close') {
      await assert.rejects(f.scan(), error => isPrivateSourceScanCleanupFailure(error) && !String(error).includes(f.source));
    } else { assert.deepEqual(await f.scan(), { status: 'source-unavailable' }); }
  });
}

test('directory cleanup deadline is branded and never returns a ready review', async t => {
  const f = await fixture(t); await f.file('movie.mp4');
  const closing = deferred(); let actualClose!: () => Promise<void>;
  const open = fs.promises.opendir.bind(fs.promises);
  t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
    const directory = await open(...args); actualClose = directory.close.bind(directory);
    t.mock.method(directory, 'close', () => { closing.resolve(); return new Promise<void>(() => undefined); }); return directory;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scan = f.scan(); const failed = assert.rejects(scan, isPrivateSourceScanCleanupFailure);
  await closing.promise; t.mock.timers.tick(5000); await failed;
  await actualClose();
});

test('a root changed to a symlink during native directory opening is closed before any entry is consumed', async t => {
  const f = await fixture(t); await f.file('movie.mp4');
  const outside = path.join(f.root, 'outside'); await fs.promises.mkdir(outside);
  const open = fs.promises.opendir.bind(fs.promises); let closes = 0;
  t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
    const directory = await open(...args); const close = directory.close.bind(directory);
    await fs.promises.rename(f.source, f.source + '-old'); await fs.promises.symlink(outside, f.source);
    t.mock.method(directory, 'read', async () => { assert.fail('A changed directory cannot expose entries'); });
    t.mock.method(directory, 'close', async () => { closes++; await close(); }); return directory;
  });
  assert.deepEqual(await f.scan(), { status: 'source-unavailable' }); assert.equal(closes, 1);
});

test('a nested directory replaced while a read is pending cannot contribute a late candidate', async t => {
  const f = await fixture(t); await f.file('sub/movie.mp4');
  const open = fs.promises.opendir.bind(fs.promises); let closes = 0;
  t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
    const directory = await open(...args); const close = directory.close.bind(directory);
    if (String(args[0]) === path.join(f.source, 'sub')) {
      const read = directory.read.bind(directory);
      t.mock.method(directory, 'read', async () => {
        const entry = await read();
        await fs.promises.rename(path.join(f.source, 'sub'), path.join(f.source, 'sub-old'));
        await fs.promises.mkdir(path.join(f.source, 'sub'));
        return entry;
      });
    }
    t.mock.method(directory, 'close', async () => { closes++; await close(); }); return directory;
  });
  assert.deepEqual(await f.scan(), { status: 'source-unavailable' }); assert.equal(closes, 2);
});

test('directory close failure remains a quarantine signal after cancellation', async t => {
  const f = await fixture(t); await f.file('movie.mp4');
  const open = fs.promises.opendir.bind(fs.promises);
  t.mock.method(fs.promises, 'opendir', async (...args: Parameters<typeof fs.promises.opendir>) => {
    const directory = await open(...args); const close = directory.close.bind(directory);
    t.mock.method(directory, 'close', async () => {
      f.controller.abort(); await close(); throw new Error('Synthetic cleanup failure');
    });
    return directory;
  });
  await assert.rejects(f.scan(), isPrivateSourceScanCleanupFailure);
});
