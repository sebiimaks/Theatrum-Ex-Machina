import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { capturePrivatePreviewSource, type PrivatePreviewSource } from './private-preview-source.ts';
import { PrivateSourcePlayback, isPrivateSourcePlaybackUrl, privateSourcePlaybackType } from './private-source-playback.ts';

const generic = { message: 'Private video is unavailable.' };
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function fixture(t: TestContext, bytes = Buffer.from('SYNTHETIC-ORIGINAL-VIDEO-0123456789')) {
  const parent = path.resolve(__dirname, '../tmp');
  await fs.promises.mkdir(parent, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(parent, 'private-source-playback-test-'));
  const file = path.join(directory, 'sensitive-original.mp4');
  await fs.promises.writeFile(file, bytes);
  const controller = new AbortController();
  const state = { allowed: true, failures: 0 };
  const player = new PrivateSourcePlayback({ signal: controller.signal, isCurrent: () => state.allowed,
    onFailure: () => { state.failures++; } });
  const capture = (): Promise<PrivatePreviewSource> => capturePrivatePreviewSource({ hash: 'private-hash', root: directory,
    partialPath: '', fileName: 'sensitive-original.mp4', inputSource: 0,
    signal: controller.signal, isCurrent: () => state.allowed });
  t.after(async () => { await player.dispose().catch(() => undefined); await fs.promises.rm(directory, { recursive: true, force: true }); });
  return { directory, file, bytes, controller, state, player, capture };
}
function assertHeaders(response: Response): void {
  assert.match(response.headers.get('cache-control')!, /no-store/);
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('expires'), '0');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('last-modified'), null);
  assert.equal(response.headers.get('content-disposition'), null);
}

test('accepts only exact opaque URLs and a bounded known original container extension', () => {
  const valid = 'theatrum://app/original/' + 'a'.repeat(64);
  assert.equal(isPrivateSourcePlaybackUrl(valid), true);
  for (const url of [valid + '?v=1', valid + '.mp4', valid + '#x', valid.toUpperCase(), valid.replace('app/', 'other/'), valid.slice(0, -1)]) {
    assert.equal(isPrivateSourcePlaybackUrl(url), false);
  }
  for (const name of ['video.mp4', 'movie.M4V']) { assert.equal(privateSourcePlaybackType(name), 'video/mp4'); }
  assert.equal(privateSourcePlaybackType('video.MOV'), 'video/quicktime');
  assert.equal(privateSourcePlaybackType('video.webm'), 'video/webm');
  for (const name of ['v.ogg', 'v.ogv']) { assert.equal(privateSourcePlaybackType(name), 'video/ogg'); }
  for (const name of ['movie.mkv', 'movie.avi', 'movie.mp4/other', '/movie.mp4', '../movie.mp4', 'v\0.mp4', 'x'.repeat(4_096) + '.mp4']) {
    assert.equal(privateSourcePlaybackType(name), undefined);
  }
});

test('full requests stream original bytes with generic private headers and stop retires the URL', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const url = await f.player.start(source, 'video/mp4');
  assert.equal(isPrivateSourcePlaybackUrl(url), true);
  assert.equal(url.includes('sensitive'), false);
  const response = await f.player.createResponse(new Request(url));
  assert.equal(response.status, 200);
  assertHeaders(response);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), String(f.bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  await f.player.stop();
  assert.equal(source.signal.aborted, true);
  assert.equal((await f.player.createResponse(new Request(url))).status, 404);
  assert.equal(f.state.failures, 0);
});

test('supports fixed, suffix, open-ended, clamped and If-Range requests; HEAD returns full length', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/quicktime');
  for (const [header, start, end] of [['bytes=2-7', 2, 8], ['bytes=-4', f.bytes.length - 4, f.bytes.length],
    ['bytes=3-', 3, f.bytes.length], ['bytes=3-999999999', 3, f.bytes.length], ['bytes=-999', 0, f.bytes.length]] as const) {
    const response = await f.player.createResponse(new Request(url, { headers: { Range: header } }));
    assert.equal(response.status, 206); assertHeaders(response);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end - 1}/${f.bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(start, end));
    await tick();
  }
  const complete = await f.player.createResponse(new Request(url, { headers: { Range: 'bytes=2-3', 'If-Range': 'not-issued' } }));
  assert.equal(complete.status, 200);
  assert.deepEqual(Buffer.from(await complete.arrayBuffer()), f.bytes);
  const head = await f.player.createResponse(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=2-3' } }));
  assert.equal(head.status, 200); assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal(head.headers.get('content-type'), 'video/quicktime');
});

test('rejects malformed, oversized, multipart and unsatisfiable ranges before opening a descriptor', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  let opens = 0;
  t.mock.method(fs.promises, 'open', async () => { opens++; throw new Error(f.file); });
  for (const value of ['bytes=', 'bytes=-0', 'bytes=2-1', 'bytes=999-', 'bytes=0-1,3-4', 'bits=0-1', 'bytes=0-9007199254740992', 'bytes=' + '0'.repeat(65)]) {
    const response = await f.player.createResponse(new Request(url, { headers: { Range: value } }));
    assert.equal(response.status, 416); assertHeaders(response);
    assert.equal(response.headers.get('content-range'), `bytes */${f.bytes.length}`);
    assert.equal(response.body, null);
  }
  assert.equal(opens, 0);
});

test('empty originals and HEAD avoid descriptor opens and preserve secure headers', async t => {
  const f = await fixture(t, Buffer.alloc(0));
  const url = await f.player.start(await f.capture(), 'video/webm');
  t.mock.method(fs.promises, 'open', async () => { throw new Error('Unexpected open'); });
  const response = await f.player.createResponse(new Request(url));
  assert.equal(response.status, 200); assert.equal(response.body, null); assertHeaders(response);
  assert.equal((await f.player.createResponse(new Request(url, { headers: { Range: 'bytes=0-' } }))).status, 416);
});

test('never admits guessed, previous, foreign-manager or unsupported-method URLs', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const foreign = await other.player.start(await other.capture(), 'video/mp4');
  for (const target of [foreign, url + '?v=1', 'theatrum://app/original/' + '0'.repeat(64)]) {
    assert.equal((await f.player.createResponse(new Request(target))).status, 404);
  }
  const unsupported = await f.player.createResponse(new Request(url, { method: 'POST' }));
  assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.get('allow'), 'GET, HEAD'); assertHeaders(unsupported);
  const next = await f.player.start(await f.capture(), 'video/mp4');
  assert.notEqual(next, url);
  assert.equal((await f.player.createResponse(new Request(url))).status, 404);
  const current = await f.player.createResponse(new Request(next));
  assert.equal(current.status, 200); await current.body!.cancel();
});

test('at most two responses open descriptors; cancelling returns capacity without revoking the token', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const first = await f.player.createResponse(new Request(url));
  const second = await f.player.createResponse(new Request(url));
  assert.equal((await f.player.createResponse(new Request(url))).status, 503);
  await first.body!.cancel();
  const third = await f.player.createResponse(new Request(url));
  assert.equal(third.status, 200);
  await Promise.all([second.body!.cancel(), third.body!.cancel()]);
  assert.equal(f.state.failures, 0);
});

test('streaming is demand-driven, chunks are bounded, and stop errors idle readers', async t => {
  const bytes = Buffer.alloc(700_000, 49);
  const f = await fixture(t, bytes);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const original = fs.promises.open.bind(fs.promises);
  let readCalls = 0;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await original(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      readCalls++; assert.ok(length <= 256 * 1024); return read(buffer, offset, length, position);
    });
    return handle;
  });
  const response = await f.player.createResponse(new Request(url));
  await tick(); assert.equal(readCalls, 0);
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.equal(first.value!.byteLength, 256 * 1024);
  await tick(); assert.equal(readCalls, 1);
  await f.player.stop();
  await assert.rejects(reader.read(), generic);
  assert.equal(readCalls, 1);
});

test('request abort closes its descriptor, while lock revokes all streams and future starts', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const controller = new AbortController();
  const response = await f.player.createResponse(new Request(url, { signal: controller.signal }));
  controller.abort(new Error(f.file));
  await assert.rejects(response.arrayBuffer(), generic);
  await tick();
  const next = await f.player.createResponse(new Request(url));
  f.controller.abort();
  await assert.rejects(next.arrayBuffer(), generic);
  await f.player.dispose();
  assert.equal((await f.player.createResponse(new Request(url))).status, 404);
  const another = await fixture(t);
  const source = await another.capture();
  await assert.rejects(f.player.start(source, 'video/mp4'), generic);
  assert.equal(source.signal.aborted, true);
});

test('source replacement revokes active streaming before delivery and does not silently rebind', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const url = await f.player.start(source, 'video/mp4');
  const response = await f.player.createResponse(new Request(url));
  await fs.promises.rename(f.file, f.file + '-old');
  await fs.promises.writeFile(f.file, f.bytes);
  await assert.rejects(response.arrayBuffer(), generic);
  assert.equal(source.signal.aborted, true);
  assert.equal((await f.player.createResponse(new Request(url))).status, 404);
});

test('stop waits for pending descriptor opens and cannot publish their late response', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const original = fs.promises.open.bind(fs.promises);
  let resume!: () => void;
  let descriptor = -1;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await original(...args); descriptor = handle.fd;
    await new Promise<void>(resolve => { resume = resolve; });
    return handle;
  });
  const response = f.player.createResponse(new Request(url));
  while (!resume) { await tick(); }
  let drained = false;
  const stopping = f.player.stop().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  resume();
  await stopping;
  assert.equal((await response).status, 404);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
});

test('a stopped pending read wipes its bytes and completes before descriptor cleanup', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const original = fs.promises.open.bind(fs.promises);
  let resume!: () => void;
  let owned: Buffer | undefined;
  let closed = false;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await original(...args); const read = handle.read.bind(handle); const close = handle.close.bind(handle);
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      owned = buffer; const result = await read(buffer, offset, length, position);
      await new Promise<void>(resolve => { resume = resolve; }); return result;
    });
    t.mock.method(handle, 'close', async () => { closed = true; await close(); });
    return handle;
  });
  const response = await f.player.createResponse(new Request(url));
  const rejected = assert.rejects(response.arrayBuffer(), generic);
  while (!resume) { await tick(); }
  const stopping = f.player.stop();
  await tick(); assert.equal(closed, false);
  resume(); await stopping; await rejected;
  assert.equal(closed, true); assert.ok(owned!.every(byte => byte === 0));
});

test('newer start wins when an older start is awaiting previous playback cleanup', async t => {
  const f = await fixture(t);
  const first = await f.capture();
  const second = await f.capture();
  const third = await f.capture();
  await f.player.start(first, 'video/mp4');
  const old = f.player.start(second, 'video/mp4');
  const rejected = assert.rejects(old, generic);
  const current = await f.player.start(third, 'video/webm');
  await rejected;
  assert.equal(first.signal.aborted, true); assert.equal(second.signal.aborted, true);
  assert.equal(third.signal.aborted, false);
  const response = await f.player.createResponse(new Request(current));
  assert.equal(response.headers.get('content-type'), 'video/webm'); await response.body!.cancel();
});

test('stop invalidates an in-flight start and invalid container types still consume source ownership', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const starting = f.player.start(source, 'video/mp4');
  const rejected = assert.rejects(starting, generic);
  await f.player.stop(); await rejected;
  assert.equal(source.signal.aborted, true);
  const invalid = await f.capture();
  await assert.rejects(f.player.start(invalid, 'text/html' as 'video/mp4'), generic);
  assert.equal(invalid.signal.aborted, true);
});

test('descriptor close failure latches quarantine even after external cleanup succeeds', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const original = fs.promises.open.bind(fs.promises);
  let close: (() => Promise<void>) | undefined;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await original(...args); close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { throw new Error(f.file); }); return handle;
  });
  await f.player.createResponse(new Request(url));
  try {
    await assert.rejects(f.player.stop(), generic);
    assert.equal(f.state.failures, 1);
    await close!(); close = undefined;
    await assert.rejects(f.player.stop(), generic);
    await assert.rejects(f.player.dispose(), generic);
    assert.equal(f.state.failures, 1);
  } finally { await close?.(); }
});

test('five-second unproven cleanup timeout is terminal even after the outstanding read drains', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  const original = fs.promises.open.bind(fs.promises);
  let resume!: () => void;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await original(...args); const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      await new Promise<void>(resolve => { resume = resolve; }); return result;
    }); return handle;
  });
  const response = await f.player.createResponse(new Request(url));
  const rejected = assert.rejects(response.arrayBuffer(), generic);
  while (!resume) { await tick(); }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopping = f.player.stop();
  const timedOut = assert.rejects(stopping, generic);
  t.mock.timers.tick(5_000);
  await timedOut; await rejected;
  assert.equal(f.state.failures, 1);
  resume(); await tick(); await tick();
  await assert.rejects(f.player.stop(), generic);
  assert.equal(f.state.failures, 1);
});

test('an impostor source cannot execute methods or replace the live capability', async t => {
  const f = await fixture(t);
  const url = await f.player.start(await f.capture(), 'video/mp4');
  let called = false;
  await assert.rejects(f.player.start({ close: async () => { called = true; } } as PrivatePreviewSource, 'video/mp4'), generic);
  assert.equal(called, false);
  assert.equal((await f.player.createResponse(new Request(url, { method: 'HEAD' }))).status, 200);
});

test('owner revocation denies metadata, retires the source and cannot be undone by restoring the predicate', async t => {
  const f = await fixture(t);
  const source = await f.capture();
  const url = await f.player.start(source, 'video/mp4');
  f.state.allowed = false;
  const response = await f.player.createResponse(new Request(url, { method: 'HEAD' }));
  assert.equal(response.status, 404); assert.equal(response.headers.get('content-type'), null);
  assert.equal(response.headers.get('content-length'), '0'); assertHeaders(response);
  assert.equal(source.signal.aborted, true);
  f.state.allowed = true;
  assert.equal((await f.player.createResponse(new Request(url))).status, 404);
});
