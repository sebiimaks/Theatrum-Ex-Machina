import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import { createPrivateHubMediaResponse, type PrivateHubMediaResponseOptions } from './private-hub-media-response.ts';
import { PRIVATE_HUB_MEDIA_CHUNK_BYTES, writePrivateHubMedia } from './private-hub-media.ts';
import { PrivateHubStore } from './private-hub-store.ts';
import { PRIVATE_HUB_RECORD_OVERHEAD_BYTES } from './private-hub-crypto.ts';

const mediaId = 'clip:synthetic-video';
const options: PrivateHubMediaResponseOptions = { isCurrent: () => true, contentType: 'video/mp4' };
const chunkBytes = PRIVATE_HUB_MEDIA_CHUNK_BYTES;

test('clip completion observers fire exactly once for every terminal response path', async t => {
  const { store } = await fixture(t);
  for (const action of ['consume', 'cancel', 'head', 'range', 'method', 'missing', 'abort', 'denied', 'lock']) {
    let completions = 0;
    const controller = new AbortController();
    if (action === 'abort') { controller.abort(); }
    const observed = { ...options, isCurrent: () => action !== 'denied', onComplete: () => { completions++; } };
    if (action === 'abort') {
      await assert.rejects(createPrivateHubMediaResponse(store, mediaId, request({ signal: controller.signal }), observed));
    } else {
      const response = await createPrivateHubMediaResponse(store, action === 'missing' ? 'missing' : mediaId,
        request({ method: action === 'head' ? 'HEAD' : action === 'method' ? 'POST' : 'GET',
          headers: action === 'range' ? { Range: 'bytes=99-' } : undefined }), observed);
      if (action === 'consume') { assert.equal(completions, 0); await response.text(); }
      else if (action === 'cancel') { assert.equal(completions, 0); await response.body!.cancel(); await response.body!.cancel(); }
      else if (action === 'lock') { assert.equal(completions, 0); await store.lock(); await assert.rejects(response.text()); }
    }
    assert.equal(completions, 1, action);
  }
});

test('throwing or rejecting clip completion observers cannot change delivery or produce unhandled errors', async t => {
  const { store } = await fixture(t);
  for (const onComplete of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    const response = await createPrivateHubMediaResponse(store, mediaId, request(), { ...options, onComplete });
    assert.equal(await response.text(), '0123456789');
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('clip completion callbacks cannot return HEAD metadata after synchronously locking', async t => {
  const { store } = await fixture(t);
  let completions = 0;
  const response = await createPrivateHubMediaResponse(store, mediaId, request({ method: 'HEAD' }), {
    ...options, onComplete: () => { completions++; void store.lock(); },
  });
  assert.equal(response.status, 404);
  assert.equal(completions, 1);
});

async function fixture(t: TestContext, bytes = Buffer.from('0123456789')): Promise<{ directory: string; store: PrivateHubStore }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-hub-media-response-test-'));
  const directory = path.join(root, 'vault');
  const store = await PrivateHubStore.create(directory, 'Synthetic response streaming test passphrase');
  t.after(async () => {
    await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  await writePrivateHubMedia(store, mediaId, source(bytes));
  return { directory, store };
}

async function* source(bytes: Buffer): AsyncGenerator<Uint8Array> {
  yield bytes;
}

function request(init: RequestInit = {}): Request {
  return new Request('theatrum://app/media/authorized-preview', init);
}

function assertPrivate(response: Response): void {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Pragma'), 'no-cache');
  assert.equal(response.headers.get('Expires'), '0');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  for (const name of ['ETag', 'Last-Modified', 'Content-Disposition', 'Access-Control-Allow-Origin']) {
    assert.equal(response.headers.has(name), false);
  }
}

function countChunkReads(t: TestContext, store: PrivateHubStore): () => number {
  let reads = 0;
  const originalRead = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', (id: string, maximum?: number) => {
    if (id.startsWith('media-chunk:')) {
      reads++;
    }
    return originalRead(id, maximum);
  });
  return () => reads;
}

test('GET returns private headers and decrypts no chunks until a consumer pulls', async t => {
  const bytes = randomBytes(chunkBytes + 23);
  const { store } = await fixture(t, bytes);
  const reads = countChunkReads(t, store);
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.equal(response.headers.has('Content-Range'), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads(), 0);
  const body = response.body!.getReader();
  const first = await body.read();
  assert.deepEqual(first.value, bytes.subarray(0, chunkBytes));
  assert.equal(reads(), 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reads(), 1, 'completed pulls do not prefetch the next encrypted chunk');
  assert.deepEqual((await body.read()).value, bytes.subarray(chunkBytes));
  assert.equal((await body.read()).done, true);
  assert.equal(reads(), 2);
});

test('single byte ranges handle exact, open, suffix, clamped and cross-chunk endpoints', async t => {
  const bytes = randomBytes(chunkBytes + 17);
  const { store } = await fixture(t, bytes);
  const cases: [string, number, number][] = [
    ['bytes=0-0', 0, 1], ['bytes=1-7', 1, 8], [`bytes=${chunkBytes}-`, chunkBytes, bytes.length],
    ['bytes=-4', bytes.length - 4, bytes.length], [`bytes=-${bytes.length + 20}`, 0, bytes.length],
    [`bytes=${chunkBytes - 2}-${chunkBytes + 3}`, chunkBytes - 2, chunkBytes + 4],
    [`bytes=${bytes.length - 1}-9007199254740991`, bytes.length - 1, bytes.length],
  ];
  for (const [range, start, end] of cases) {
    const response = await createPrivateHubMediaResponse(store, mediaId, request({ headers: { Range: range } }), options);
    assert.equal(response.status, 206, range);
    assertPrivate(response);
    assert.equal(response.headers.get('Content-Length'), String(end - start));
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end - 1}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end));
  }
});

test('malformed, multiple, overflow and unsatisfiable ranges return bounded private 416 responses', async t => {
  const { store } = await fixture(t);
  const reads = countChunkReads(t, store);
  const ranges = ['bytes=', 'bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=3-2', 'bytes=0-1,4-5', 'items=0-1',
    'bytes=1.5-2', 'bytes=+1-2', 'bytes=0-9007199254740992', 'bytes=' + '0'.repeat(80) + '-1'];
  for (const range of ranges) {
    const response = await createPrivateHubMediaResponse(store, mediaId, request({ headers: { Range: range } }), options);
    assert.equal(response.status, 416, range);
    assertPrivate(response);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal(await response.text(), '');
  }
  assert.equal(reads(), 0);
});

test('HEAD ignores Range, returns full headers, and never decrypts media chunks', async t => {
  const { store } = await fixture(t);
  const reads = countChunkReads(t, store);
  const response = await createPrivateHubMediaResponse(store, mediaId,
    request({ method: 'HEAD', headers: { Range: 'bytes=2-3' } }), { ...options, contentType: 'image/jpeg' });
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(response.headers.has('Content-Range'), false);
  assert.equal(response.body, null);
  assert.equal(await response.text(), '');
  assert.equal(reads(), 0);
});

test('empty GET has no chunk reads, any range is unsatisfiable, and If-Range receives the full entity', async t => {
  const { store } = await fixture(t, Buffer.alloc(0));
  const reads = countChunkReads(t, store);
  const empty = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('Content-Length'), '0');
  assert.equal(empty.body, null);
  const ranged = await createPrivateHubMediaResponse(store, mediaId, request({ headers: { Range: 'bytes=0-' } }), options);
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers.get('Content-Range'), 'bytes */0');
  assert.equal(reads(), 0);
  await writePrivateHubMedia(store, mediaId, source(Buffer.from('full entity')));
  const conditional = await createPrivateHubMediaResponse(store, mediaId,
    request({ headers: { Range: 'bytes=0-2', 'If-Range': 'unknown-validator' } }), options);
  assert.equal(conditional.status, 200);
  assert.equal(conditional.headers.has('Content-Range'), false);
  assert.equal(await conditional.text(), 'full entity');
});

test('unsupported methods and absent or failing authority never read private storage', async t => {
  const { store } = await fixture(t);
  let reads = 0;
  const originalRead = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', (id: string, maximum?: number) => {
    reads++;
    return originalRead(id, maximum);
  });
  const rejected = await createPrivateHubMediaResponse(store, mediaId, request({ method: 'POST' }), options);
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('Allow'), 'GET, HEAD');
  assertPrivate(rejected);
  for (const invalid of [
    { ...options, isCurrent: () => false },
    { ...options, isCurrent: () => { throw new Error('/private/secret/path'); } },
    { contentType: 'video/mp4' } as PrivateHubMediaResponseOptions,
    { ...options, contentType: 'text/html' } as unknown as PrivateHubMediaResponseOptions,
  ]) {
    const response = await createPrivateHubMediaResponse(store, mediaId, request(), invalid);
    assert.equal(response.status, 404);
    assertPrivate(response);
    assert.equal(await response.text(), '');
  }
  assert.equal(reads, 0);
});

test('pinned response headers and body remain coherent when media is replaced before delivery', async t => {
  const bytes = randomBytes(chunkBytes + 17);
  const { store } = await fixture(t, bytes);
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  await writePrivateHubMedia(store, mediaId, source(Buffer.from('new shorter generation')));
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('authority is checked after opening and before each pull without falling back to another session', async t => {
  const { store } = await fixture(t, randomBytes(chunkBytes + 11));
  let current = true;
  const guarded = { ...options, isCurrent: () => current };
  const originalRead = store.readRecord.bind(store);
  const mock = t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    const bytes = await originalRead(id, maximum);
    current = false;
    return bytes;
  });
  const unavailable = await createPrivateHubMediaResponse(store, mediaId, request(), guarded);
  assert.equal(unavailable.status, 404);
  mock.mock.restore();
  current = true;
  const reads = countChunkReads(t, store);
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), guarded);
  const body = response.body!.getReader();
  assert.equal((await body.read()).done, false);
  assert.equal(reads(), 1);
  current = false;
  await assert.rejects(body.read(), /Private media is unavailable/);
  assert.equal(reads(), 1);
});

test('locking after a response or between pulls errors its body immediately without future reads', async t => {
  const bytes = randomBytes(chunkBytes + 11);
  const { store } = await fixture(t, bytes);
  const reads = countChunkReads(t, store);
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  const body = response.body!.getReader();
  const first = await body.read();
  await store.lock();
  await assert.rejects(body.read(), /Private media is unavailable/);
  assert.equal(reads(), 1);
  assert.deepEqual(first.value, bytes.subarray(0, chunkBytes), 'already delivered caller-owned bytes are not revoked');
  const unavailable = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  assert.equal(unavailable.status, 404);
});

test('client abort is generic before response creation and promptly errors an idle response', async t => {
  const { store } = await fixture(t);
  const before = new AbortController();
  before.abort('/sensitive/source/path');
  await assert.rejects(createPrivateHubMediaResponse(store, mediaId, request({ signal: before.signal }), options),
    { name: 'AbortError', message: 'Private media request aborted.' });
  const controller = new AbortController();
  const reads = countChunkReads(t, store);
  const response = await createPrivateHubMediaResponse(store, mediaId, request({ signal: controller.signal }), options);
  controller.abort('/sensitive/source/path');
  await assert.rejects(response.arrayBuffer(), { name: 'AbortError', message: 'Private media request aborted.' });
  assert.equal(reads(), 0);
  assert.equal(store.locked, false, 'aborting a single request does not lock the hub');
});

test('a pending read is cancelled on client abort and its unreturned plaintext is wiped', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  const response = await createPrivateHubMediaResponse(store, mediaId, request({ signal: controller.signal }), options);
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  let release: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    entered();
    await hold;
    return owned;
  });
  const reading = response.body!.getReader().read();
  await waiting;
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(owned?.every(byte => byte === 0));
});

test('revoking authority during an awaited chunk read wipes its unreturned result', async t => {
  const { store } = await fixture(t);
  let current = true;
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), { ...options, isCurrent: () => current });
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    current = false;
    return owned;
  });
  await assert.rejects(response.arrayBuffer(), /Private media is unavailable/);
  assert.ok(owned?.every(byte => byte === 0));
});

test('consumer cancellation stops the stream and wipes any pending plaintext', async t => {
  const { store } = await fixture(t);
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  let release: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    entered();
    await hold;
    return owned;
  });
  const body = response.body!.getReader();
  const reading = body.read();
  await waiting;
  await body.cancel();
  assert.equal((await reading).done, true);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(owned?.every(byte => byte === 0));
});

test('corrupt chunk authentication errors the stream without exposing filesystem diagnostics', async t => {
  const { directory, store } = await fixture(t, randomBytes(chunkBytes + 17));
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  const body = response.body!.getReader();
  assert.equal((await body.read()).done, false);
  const originalRead = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    if (id.startsWith('media-chunk:') && id.endsWith(':1')) {
      // Locate the bounded final record by sealed length and corrupt its tag.
      for (const name of await fs.promises.readdir(directory)) {
        if (name.endsWith('.sealed')) {
          const file = path.join(directory, name);
          const bytes = await fs.promises.readFile(file);
          if (bytes.length === 17 + PRIVATE_HUB_RECORD_OVERHEAD_BYTES) {
            bytes[bytes.length - 1] ^= 1;
            await fs.promises.writeFile(file, bytes);
          }
        }
      }
    }
    return originalRead(id, maximum);
  });
  await assert.rejects(body.read(), { name: 'UnavailablePrivateMediaError', message: 'Private media is unavailable.' });
});

test('abort while opening the manifest rejects promptly without waiting for pending storage', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  const originalRead = store.readRecord.bind(store);
  let release: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let owned: Buffer | undefined;
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    entered();
    await hold;
    return owned;
  });
  const opening = createPrivateHubMediaResponse(store, mediaId, request({ signal: controller.signal }), options);
  await waiting;
  controller.abort();
  await assert.rejects(opening, { name: 'AbortError', message: 'Private media request aborted.' });
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(owned?.every(byte => byte === 0));
});

test('abort after range-result creation wipes adapter staging before any stream delivery', async t => {
  const bytes = randomBytes(37);
  const { store } = await fixture(t, bytes);
  const controller = new AbortController();
  const response = await createPrivateHubMediaResponse(store, mediaId, request({ signal: controller.signal }), options);
  const originalFrom = Buffer.from;
  let staging: Buffer | undefined;
  t.mock.method(Buffer, 'from', (...args: unknown[]): Buffer => {
    const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
    if (Buffer.isBuffer(args[0]) && args[0].equals(bytes)) {
      staging = result;
      queueMicrotask(() => { controller.abort(); });
    }
    return result;
  });
  await assert.rejects(response.body!.getReader().read(), { name: 'AbortError' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(staging);
  assert.ok(staging.every(byte => byte === 0));
});

test('first-chunk corruption rejects the first body pull without returning any plaintext', async t => {
  const bytes = randomBytes(37);
  const { directory, store } = await fixture(t, bytes);
  const response = await createPrivateHubMediaResponse(store, mediaId, request(), options);
  let damaged = false;
  for (const name of await fs.promises.readdir(directory)) {
    if (name.endsWith('.sealed')) {
      const file = path.join(directory, name);
      const ciphertext = await fs.promises.readFile(file);
      if (ciphertext.length === bytes.length + PRIVATE_HUB_RECORD_OVERHEAD_BYTES) {
        ciphertext[ciphertext.length - 1] ^= 1;
        await fs.promises.writeFile(file, ciphertext);
        damaged = true;
      }
    }
  }
  assert.equal(damaged, true);
  await assert.rejects(response.body!.getReader().read(),
    { name: 'UnavailablePrivateMediaError', message: 'Private media is unavailable.' });
});

test('an authority predicate that aborts admission cannot start private storage reads', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  let reads = 0;
  const originalRead = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', (id: string, maximum?: number) => {
    reads++;
    return originalRead(id, maximum);
  });
  await assert.rejects(createPrivateHubMediaResponse(store, mediaId, request({ signal: controller.signal }), {
    ...options,
    isCurrent: () => {
      controller.abort('/sensitive/authority/reason');
      return true;
    },
  }), { name: 'AbortError', message: 'Private media request aborted.' });
  assert.equal(reads, 0);
});

test('an authority predicate that locks after reader creation cannot expose HEAD metadata', async t => {
  const { store } = await fixture(t);
  let checks = 0;
  const response = await createPrivateHubMediaResponse(store, mediaId, request({ method: 'HEAD' }), {
    ...options,
    isCurrent: () => {
      // Revoke in the final guard after the authenticated reader handoff.
      if (++checks === 4) { void store.lock(); }
      return true;
    },
  });
  assert.equal(checks, 4);
  assert.equal(store.locked, true);
  assert.equal(response.status, 404);
  assertPrivate(response);
  assert.equal(response.headers.get('Content-Length'), '0');
  assert.equal(response.headers.has('Content-Type'), false);
  assert.equal(response.body, null);
});

test('an authority predicate that aborts after reader creation cannot return HEAD metadata', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  let checks = 0;
  await assert.rejects(createPrivateHubMediaResponse(store, mediaId,
    request({ method: 'HEAD', signal: controller.signal }), {
      ...options,
      isCurrent: () => {
        if (++checks === 4) { controller.abort('/sensitive/authority/reason'); }
        return true;
      },
    }), { name: 'AbortError', message: 'Private media request aborted.' });
  assert.equal(checks, 4);
});
