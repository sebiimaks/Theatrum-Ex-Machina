import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  capturePrivatePreviewSource, isPrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, privatePreviewSourceMatchesLocation,
  type PrivatePreviewSource, type PrivatePreviewSourceLocation, type PrivatePreviewSourceOptions,
} from './private-preview-source.ts';

const genericError = { message: 'Private preview source is unavailable.' };

async function fixture(t: TestContext) {
  const temporary = path.resolve(__dirname, '../tmp');
  await fs.promises.mkdir(temporary, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(temporary, 'private-preview-source-test-'));
  const root = path.join(directory, 'source');
  const folder = path.join(root, 'nested');
  const file = path.join(folder, 'private-title.mp4');
  await fs.promises.mkdir(folder, { recursive: true });
  await fs.promises.writeFile(file, 'SYNTHETIC-PRIVATE-MEDIA');
  const sources: PrivatePreviewSource[] = [];
  t.after(async () => {
    await Promise.allSettled(sources.map(source => source.close()));
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  const options: PrivatePreviewSourceOptions = {
    hash: 'catalogue-hash', root, partialPath: '/nested', fileName: 'private-title.mp4', inputSource: 2, isCurrent: () => true,
  };
  const capture = async (overrides: Partial<PrivatePreviewSourceOptions> = {}) => {
    const source = await capturePrivatePreviewSource({ ...options, ...overrides });
    sources.push(source);
    return source;
  };
  return { directory, root, folder, file, options, capture };
}

test('binds frozen exact catalogue location and exposes a branded path-free capability', async t => {
  const f = await fixture(t);
  const locations: Readonly<PrivatePreviewSourceLocation>[] = [];
  const source = await f.capture({ isCurrent: location => { locations.push(location); return true; } });
  assert.equal(source.hash, 'catalogue-hash');
  assert.equal(isPrivatePreviewSource(source), true);
  assert.equal(isPrivatePreviewSource({ hash: source.hash, open: source.open }), false);
  assert.equal(isPrivatePreviewSource(null), false);
  assert.equal(Object.isFrozen(source), true);
  assert.ok(locations.length > 1);
  assert.ok(locations.every(location => location === locations[0] && Object.isFrozen(location)));
  assert.deepEqual(locations[0], { hash: f.options.hash, root: f.root, partialPath: '/nested', fileName: 'private-title.mp4', inputSource: 2 });
  assert.equal(JSON.stringify(source).includes(f.root), false);
  assert.equal(source.isCurrent(), true);
});

test('main-only matching requires the complete immutable binding and rejects lookalikes', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  assert.equal(privatePreviewSourceMatchesLocation(source, f.options), true);
  assert.equal(privatePreviewSourceMatchesLocation(source, { ...f.options, partialPath: 'nested' }), true);
  for (const overrides of [
    { hash: 'another-hash' }, { root: f.folder }, { inputSource: 1 }, { partialPath: '/elsewhere' },
    { fileName: 'another-title.mp4' }, { root: 'relative' }, { partialPath: '../nested' },
  ]) { assert.equal(privatePreviewSourceMatchesLocation(source, { ...f.options, ...overrides }), false); }
  const imitation = { hash: source.hash, signal: source.signal, isCurrent: () => true, open: source.open, close: source.close };
  assert.equal(privatePreviewSourceMatchesLocation(imitation, f.options), false);
  assert.equal(privatePreviewSourceMatchesLocation(source, undefined), false);
  // Closing changes authority but never rebinds the original location.
  await source.close();
  assert.equal(privatePreviewSourceMatchesLocation(source, f.options), true);
  assert.equal(source.isCurrent(), false);
});

test('opens independent seek offsets, bounds leases at two, and returns slots after close', async t => {
  const { capture } = await fixture(t);
  const source = await capture();
  const first = await source.open();
  const second = await source.open();
  const a = Buffer.alloc(3);
  const b = Buffer.alloc(3);
  fs.readSync(first.fd, a, 0, 3, null);
  fs.readSync(second.fd, b, 0, 3, null);
  assert.equal(a.toString(), 'SYN');
  assert.deepEqual(a, b);
  await assert.rejects(source.open(), genericError);
  assert.equal(source.isCurrent(), true);
  await first.close();
  await first.close();
  const third = await source.open();
  fs.readSync(third.fd, a, 0, 3, null);
  assert.equal(a.toString(), 'SYN');
  await Promise.all([second.close(), third.close()]);
});

test('close synchronously revokes authority, aborts children, and drains owned descriptors', async t => {
  const { capture } = await fixture(t);
  const source = await capture();
  const leases = await Promise.all([source.open(), source.open()]);
  let aborted = false;
  source.signal.addEventListener('abort', () => { aborted = true; });
  const closing = source.close();
  assert.equal(aborted, true);
  assert.equal(source.isCurrent(), false);
  await closing;
  for (const lease of leases) { assert.throws(() => fs.fstatSync(lease.fd), { code: 'EBADF' }); }
  await source.close();
  await assert.rejects(source.open(), genericError);
});

test('external abort revokes synchronously and never forwards a path-containing reason', async t => {
  const { capture, file } = await fixture(t);
  const controller = new AbortController();
  const source = await capture({ signal: controller.signal });
  const lease = await source.open();
  controller.abort(new Error(file));
  assert.equal(source.signal.aborted, true);
  assert.equal(source.signal.reason.message, genericError.message);
  await source.close();
  assert.throws(() => fs.fstatSync(lease.fd), { code: 'EBADF' });
});

test('denied, thrown, missing, asynchronous, and already aborted predicates never grant access', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.capture({ isCurrent: () => false }), genericError);
  await assert.rejects(f.capture({ isCurrent: () => { throw new Error(f.file); } }), genericError);
  await assert.rejects(f.capture({ isCurrent: undefined }), genericError);
  await assert.rejects(f.capture({ isCurrent: (async () => true) as unknown as PrivatePreviewSourceOptions['isCurrent'] }), genericError);
  await assert.rejects(f.capture({ signal: controller.signal }), genericError);
  await assert.rejects(f.capture({ fileName: 'missing-private-title.mp4' }), genericError);
});

test('authority revocation is permanent even if the predicate later returns true', async t => {
  const { capture } = await fixture(t);
  let allowed = true;
  const source = await capture({ isCurrent: () => allowed });
  const lease = await source.open();
  allowed = false;
  assert.equal(source.isCurrent(), false);
  assert.equal(source.signal.aborted, true);
  allowed = true;
  assert.equal(source.isCurrent(), false);
  await source.close();
  assert.throws(() => fs.fstatSync(lease.fd), { code: 'EBADF' });
});

test('reentrant close from the trusted predicate cannot restore authority', async t => {
  const { capture } = await fixture(t);
  let revoke = false;
  const source: PrivatePreviewSource = await capture({ isCurrent: () => {
    if (revoke) { void source?.close(); }
    return true;
  } });
  revoke = true;
  assert.equal(source.isCurrent(), false);
  assert.equal(source.signal.aborted, true);
});

test('rejects traversal and malformed bindings without exposing their values', async t => {
  const { capture } = await fixture(t);
  for (const overrides of [
    { partialPath: '../nested' }, { partialPath: '/nested/../nested' }, { partialPath: 'nested\\..' },
    { fileName: '../private-title.mp4' }, { fileName: '.' }, { fileName: 'private\0.mp4' },
    { root: 'relative/root' }, { hash: '../wrong' }, { inputSource: -1 }, { inputSource: 1.5 },
  ]) { await assert.rejects(capture(overrides), genericError); }
});

test('rejects source, ancestor, and root symlinks even when they stay inside the grant', async t => {
  const f = await fixture(t);
  await fs.promises.symlink(f.file, path.join(f.folder, 'linked.mp4'));
  await assert.rejects(f.capture({ fileName: 'linked.mp4' }), genericError);
  await fs.promises.symlink(f.folder, path.join(f.root, 'linked-folder'));
  await assert.rejects(f.capture({ partialPath: '/linked-folder' }), genericError);
  await fs.promises.symlink(f.root, path.join(f.directory, 'linked-root'));
  await assert.rejects(f.capture({ root: path.join(f.directory, 'linked-root') }), genericError);
});

test('rejects directories as source media', async t => {
  const { capture, folder } = await fixture(t);
  await fs.promises.mkdir(path.join(folder, 'directory.mp4'));
  await assert.rejects(capture({ fileName: 'directory.mp4' }), genericError);
});

test('same-path file replacement revokes an already opened source', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const lease = await source.open();
  await fs.promises.rename(f.file, f.file + '.old');
  await fs.promises.copyFile(f.file + '.old', f.file);
  assert.equal(source.isCurrent(), false);
  await source.close();
  assert.throws(() => fs.fstatSync(lease.fd), { code: 'EBADF' });
});

test('same-size in-place changes fail even when the original mtime is restored', async t => {
  const f = await fixture(t);
  const original = await fs.promises.stat(f.file);
  const source = await f.capture();
  const handle = await fs.promises.open(f.file, 'r+');
  await handle.write(Buffer.from('CHANGED'), 0, 7, 0);
  await handle.close();
  await fs.promises.utimes(f.file, original.atime, original.mtime);
  assert.equal(source.isCurrent(), false);
  assert.equal(source.signal.aborted, true);
});

test('same canonical root path with a new directory inode fails closed', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  await fs.promises.rename(f.root, f.root + '-old');
  await fs.promises.mkdir(f.folder, { recursive: true });
  await fs.promises.copyFile(path.join(f.root + '-old', 'nested', 'private-title.mp4'), f.file);
  assert.equal(source.isCurrent(), false);
});

test('two pending opens consume both admissions and abort closes their late file descriptors', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const source = await f.capture({ signal: controller.signal });
  const originalOpen = fs.promises.open.bind(fs.promises);
  const waiting: (() => void)[] = [];
  const descriptors: number[] = [];
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    descriptors.push(handle.fd);
    await new Promise<void>(resolve => { waiting.push(resolve); });
    return handle;
  });
  const first = source.open();
  const second = source.open();
  const results = Promise.allSettled([first, second]);
  await assert.rejects(source.open(), genericError);
  while (waiting.length !== 2) { await new Promise(resolve => setImmediate(resolve)); }
  controller.abort();
  const closing = source.close();
  for (const resume of waiting) { resume(); }
  assert.ok((await results).every(result => result.status === 'rejected'));
  await closing;
  for (const fd of descriptors) { assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' }); }
});

test('a different file opened between path validation and fstat cannot be admitted', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const otherFile = path.join(f.directory, 'unrelated.mp4');
  await fs.promises.writeFile(otherFile, 'UNRELATED-PRIVATE-MEDIA');
  const originalOpen = fs.promises.open.bind(fs.promises);
  let fd = -1;
  t.mock.method(fs.promises, 'open', async () => {
    const handle = await originalOpen(otherFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    fd = handle.fd;
    return handle;
  });
  await assert.rejects(source.open(), genericError);
  assert.equal(source.signal.aborted, true);
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

test('a source replaced with a FIFO cannot leave a blocking open during cancellation', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const originalOpen = fs.promises.open.bind(fs.promises);
  let flags = 0;
  let descriptor = -1;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    flags = Number(args[1]);
    await fs.promises.rename(f.file, f.file + '.original');
    execFileSync('mkfifo', [f.file], { cwd: path.resolve(__dirname, '..') });
    // Avoid hanging the regression itself if nonblocking protection is removed.
    if (!(flags & fs.constants.O_NONBLOCK)) { throw new Error('Missing nonblocking protection.'); }
    const handle = await originalOpen(...args);
    descriptor = handle.fd;
    return handle;
  });
  await assert.rejects(source.open(), genericError);
  assert.ok(flags & fs.constants.O_NONBLOCK);
  assert.ok(flags & fs.constants.O_NOFOLLOW);
  assert.equal(source.signal.aborted, true);
  await source.close();
  assert.ok(descriptor >= 0);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
});

test('revocation during the final asynchronous descriptor handoff rejects and closes it', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const source = await f.capture({ signal: controller.signal });
  const originalOpen = fs.promises.open.bind(fs.promises);
  let fd = -1;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    fd = handle.fd;
    const originalStat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async (...statArgs: Parameters<typeof handle.stat>) => {
      const result = await originalStat(...statArgs);
      queueMicrotask(() => { queueMicrotask(() => controller.abort()); });
      return result;
    });
    return handle;
  });
  await assert.rejects(source.open(), genericError);
  await source.close();
  assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
});

function isCleanupFailure(error: unknown): boolean {
  assert.ok(isPrivatePreviewSourceCleanupFailure(error));
  assert.equal(error.message, genericError.message);
  assert.deepEqual(Object.keys(error), []);
  return true;
}

test('a failed initial verification lease close returns a main-only branded cleanup failure', async t => {
  const f = await fixture(t);
  const originalOpen = fs.promises.open.bind(fs.promises);
  let close: (() => Promise<void>) | undefined;
  let closeCalls = 0;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { closeCalls++; throw new Error(f.file); });
    return handle;
  });
  try {
    await assert.rejects(f.capture(), isCleanupFailure);
    assert.equal(closeCalls, 1);
    assert.equal(isPrivatePreviewSourceCleanupFailure(new Error(genericError.message)), false);
    assert.equal(isPrivatePreviewSourceCleanupFailure({ message: genericError.message }), false);
    assert.equal(isPrivatePreviewSourceCleanupFailure(undefined), false);
  } finally { await close?.(); }
});

test('capture preserves cleanup failure when an unretained initial descriptor cannot close', async t => {
  const f = await fixture(t);
  const originalOpen = fs.promises.open.bind(fs.promises);
  let close: (() => Promise<void>) | undefined;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    close = handle.close.bind(handle);
    t.mock.method(handle, 'stat', async () => { throw new Error(f.file); });
    t.mock.method(handle, 'close', () => { throw new Error(f.file); });
    return handle;
  });
  try { await assert.rejects(f.capture(), isCleanupFailure); }
  finally { await close?.(); }
});

test('unretained descriptor cleanup failure remains terminal after the failed open has drained', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const originalOpen = fs.promises.open.bind(fs.promises);
  let close: (() => Promise<void>) | undefined;
  let descriptor = -1;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    descriptor = handle.fd;
    close = handle.close.bind(handle);
    t.mock.method(handle, 'stat', async () => { throw new Error(f.file); });
    t.mock.method(handle, 'close', async () => { throw new Error(f.file); });
    return handle;
  });
  try {
    await assert.rejects(source.open(), isCleanupFailure);
    assert.equal(source.isCurrent(), false);
    assert.equal(source.signal.aborted, true);
    assert.ok(fs.fstatSync(descriptor).isFile());
    await assert.rejects(source.close(), isCleanupFailure);
    await close(); close = undefined;
    // Even external cleanup cannot retroactively make the capability prove it.
    await assert.rejects(source.close(), isCleanupFailure);
  } finally { await close?.(); }
});

test('ordinary capture or open failure with confirmed cleanup is not branded', async t => {
  const f = await fixture(t);
  const originalOpen = fs.promises.open.bind(fs.promises);
  const descriptors: number[] = [];
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await originalOpen(...args);
    descriptors.push(handle.fd);
    t.mock.method(handle, 'stat', async () => { throw new Error(f.file); });
    return handle;
  });
  await assert.rejects(f.capture(), (error: Error) => {
    assert.equal(error.message, genericError.message);
    assert.equal(isPrivatePreviewSourceCleanupFailure(error), false);
    return true;
  });
  assert.equal(descriptors.length, 1);
  assert.throws(() => fs.fstatSync(descriptors[0]), { code: 'EBADF' });
});
