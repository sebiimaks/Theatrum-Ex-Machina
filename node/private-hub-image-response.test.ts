import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import { PRIVATE_HUB_MAX_IMAGE_BYTES, writePrivateHubPreview } from './private-hub-catalogue.ts';
import {
  createPrivateHubImageResponse, type PrivateHubImageKind, type PrivateHubImageResponseOptions,
} from './private-hub-image-response.ts';
import { PrivateHubStore } from './private-hub-store.ts';

const hash = 'synthetic-image';
const options: PrivateHubImageResponseOptions = { isCurrent: () => true };

test('image completion observers fire once for every terminal path after owned plaintext is wiped', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  for (const action of ['consume', 'cancel', 'head', 'range', 'method', 'missing', 'abort', 'denied', 'lock']) {
    let completions = 0;
    let wipedAtCompletion = true;
    const controller = new AbortController();
    if (action === 'abort') { controller.abort(); }
    const observed = { isCurrent: () => action !== 'denied', onComplete: () => {
      completions++;
      wipedAtCompletion &&= tracked.buffers.every(bytes => bytes.every(byte => byte === 0));
    } };
    if (action === 'abort') {
      await assert.rejects(createPrivateHubImageResponse(store, 'thumbnail', hash, request({ signal: controller.signal }), observed));
    } else {
      const response = await createPrivateHubImageResponse(store, 'thumbnail', action === 'missing' ? 'missing' : hash,
        request({ method: action === 'head' ? 'HEAD' : action === 'method' ? 'POST' : 'GET',
          headers: action === 'range' ? { Range: 'bytes=99-' } : undefined }), observed);
      if (action === 'consume') { assert.equal(completions, 0); await response.text(); }
      else if (action === 'cancel') { assert.equal(completions, 0); await response.body!.cancel(); await response.body!.cancel(); }
      else if (action === 'lock') { assert.equal(completions, 0); await store.lock(); await assert.rejects(response.text()); }
    }
    assert.equal(completions, 1, action);
    assert.equal(wipedAtCompletion, true, action);
  }
});

test('throwing or rejecting image completion observers cannot change delivery or produce unhandled errors', async t => {
  const { store } = await fixture(t);
  for (const onComplete of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), { ...options, onComplete });
    assert.equal(await response.text(), '0123456789');
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('image completion callbacks cannot return HEAD metadata after synchronously locking', async t => {
  const { store } = await fixture(t);
  let completions = 0;
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ method: 'HEAD' }), {
    ...options, onComplete: () => { completions++; void store.lock(); },
  });
  assert.equal(response.status, 404);
  assert.equal(completions, 1);
});

async function fixture(t: TestContext, bytes = Buffer.from('0123456789')): Promise<{ directory: string; store: PrivateHubStore }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-hub-image-response-test-'));
  const directory = path.join(root, 'vault');
  const store = await PrivateHubStore.create(directory, 'Synthetic private image response test passphrase');
  t.after(async () => {
    await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  await writePrivateHubPreview(store, 'thumbnail', hash, bytes);
  return { directory, store };
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

function trackPlaintext(t: TestContext, store: PrivateHubStore): { buffers: Buffer[]; limits: number[] } {
  const tracked = { buffers: [] as Buffer[], limits: [] as number[] };
  const originalRead = store.readRecord.bind(store);
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    tracked.limits.push(maximum);
    const bytes = await originalRead(id, maximum);
    tracked.buffers.push(bytes);
    return bytes;
  });
  return tracked;
}

function heldRead(t: TestContext, store: PrivateHubStore): {
  entered: Promise<void>; release: () => void; plaintext: () => Buffer | undefined;
} {
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  let release: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let enter: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    enter();
    await hold;
    return owned;
  });
  return { entered, release, plaintext: () => owned };
}

test('GET authenticates bounded JPEG bytes and transfers only a consumer-owned copy on pull', async t => {
  const bytes = randomBytes(97);
  const { store } = await fixture(t, bytes);
  const tracked = trackPlaintext(t, store);
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.equal(response.headers.has('Content-Range'), false);
  assert.deepEqual(tracked.limits, [1024, PRIVATE_HUB_MAX_IMAGE_BYTES], 'manifest and image reads each retain their own size bound');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(tracked.buffers[0], bytes, 'a response without a consumer has not enqueued or transferred bytes');
  const body = response.body!.getReader();
  const first = await body.read();
  assert.deepEqual(first.value, bytes);
  assert.notEqual(first.value, tracked.buffers[0]);
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
  assert.equal((await body.read()).done, true);
  await store.lock();
  assert.deepEqual(first.value, bytes, 'already delivered bytes belong to the consumer and cannot be revoked');
});

test('all image kinds use their own authenticated record identity', async t => {
  const { store } = await fixture(t);
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster'] as const) {
    const text = `synthetic-${kind}`;
    await writePrivateHubPreview(store, kind, hash, Buffer.from(text));
    const response = await createPrivateHubImageResponse(store, kind, hash, request(), options);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), text);
  }
});

test('single ranges return exact, open, suffix and clamped bytes while erasing full-record staging', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const ranges: [string, number, number][] = [
    ['bytes=0-0', 0, 1], ['bytes=2-6', 2, 7], ['bytes=7-', 7, 10], ['bytes=-2', 8, 10],
    ['bytes=-50', 0, 10], ['bytes=8-9007199254740991', 8, 10],
  ];
  for (const [range, start, end] of ranges) {
    const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ headers: { Range: range } }), options);
    assert.equal(response.status, 206);
    assertPrivate(response);
    assert.equal(response.headers.get('Content-Length'), String(end - start));
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end - 1}/10`);
    assert.equal(await response.text(), '0123456789'.slice(start, end));
    assert.ok(tracked.buffers.at(-1).every(byte => byte === 0));
  }
});

test('malformed, multiple, overflowing and unsatisfiable ranges return private 416 and erase staging', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const ranges = ['bytes=', 'bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=2-1', 'bytes=0-1,3-4', 'items=0-1',
    'bytes=1.1-2', 'bytes=+1-2', 'bytes=0-9007199254740992', 'bytes=' + '0'.repeat(80) + '-1'];
  for (const range of ranges) {
    const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ headers: { Range: range } }), options);
    assert.equal(response.status, 416, range);
    assertPrivate(response);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal(await response.text(), '');
    assert.ok(tracked.buffers.at(-1).every(byte => byte === 0));
  }
});

test('HEAD authenticates the image, ignores Range, and wipes bytes before returning headers', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash,
    request({ method: 'HEAD', headers: { Range: 'bytes=1-2' } }), options);
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(response.headers.has('Content-Range'), false);
  assert.equal(response.body, null);
  assert.equal(tracked.buffers.length, 1);
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
});

test('empty records have no body and unknown If-Range validators receive the full representation', async t => {
  const { store } = await fixture(t, Buffer.alloc(0));
  const empty = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('Content-Length'), '0');
  assert.equal(empty.body, null);
  const ranged = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ headers: { Range: 'bytes=0-' } }), options);
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers.get('Content-Range'), 'bytes */0');
  await writePrivateHubPreview(store, 'thumbnail', hash, Buffer.from('full entity'));
  const conditional = await createPrivateHubImageResponse(store, 'thumbnail', hash,
    request({ headers: { Range: 'bytes=0-2', 'If-Range': 'unknown-validator' } }), options);
  assert.equal(conditional.status, 200);
  assert.equal(await conditional.text(), 'full entity');
});

test('unsupported methods, invalid kinds and absent or failed authority never read storage', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const method = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ method: 'POST' }), options);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('Allow'), 'GET, HEAD');
  assertPrivate(method);
  for (const invalid of [
    { isCurrent: () => false }, { isCurrent: () => { throw new Error('/private/secret/path'); } },
    {} as PrivateHubImageResponseOptions,
  ]) {
    const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), invalid);
    assert.equal(response.status, 404);
    assertPrivate(response);
    assert.equal(await response.text(), '');
  }
  const invalidKind = await createPrivateHubImageResponse(store, 'clip' as PrivateHubImageKind, hash, request(), options);
  assert.equal(invalidKind.status, 404);
  assert.equal(tracked.limits.length, 0);
});

test('missing, invalid and corrupt records return indistinguishable empty errors, including HEAD', async t => {
  const { directory, store } = await fixture(t);
  for (const invalidHash of ['missing', '../sensitive/source/path', '']) {
    const response = await createPrivateHubImageResponse(store, 'thumbnail', invalidHash, request(), options);
    assert.equal(response.status, 404);
    assertPrivate(response);
    assert.equal(await response.text(), '');
  }
  for (const name of await fs.promises.readdir(directory)) {
    if (name.endsWith('.sealed')) {
      const file = path.join(directory, name);
      const ciphertext = await fs.promises.readFile(file);
      ciphertext[ciphertext.length - 1] ^= 1;
      await fs.promises.writeFile(file, ciphertext);
    }
  }
  for (const method of ['GET', 'HEAD']) {
    const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ method }), options);
    assert.equal(response.status, 404);
    assertPrivate(response);
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal(response.body, null);
  }
});

test('oversized records cannot bypass the image read limit', async t => {
  const { store } = await fixture(t);
  await store.writeRecord(`preview:thumbnail:${hash}`, Buffer.alloc(PRIVATE_HUB_MAX_IMAGE_BYTES + 1));
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
});

test('a response pins authenticated bytes if its underlying image is replaced before consumption', async t => {
  const { store } = await fixture(t);
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  await writePrivateHubPreview(store, 'thumbnail', hash, Buffer.from('replacement'));
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(await response.text(), '0123456789');
});

test('locking an unconsumed response erases staging and errors the body before any delivery', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  await store.lock();
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
  await assert.rejects(response.arrayBuffer(), { name: 'UnavailablePrivateImageError', message: 'Private image is unavailable.' });
  const locked = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  assert.equal(locked.status, 404);
});

test('consumer cancellation erases unconsumed staging without locking the hub', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  await response.body!.cancel('/sensitive/client/reason');
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
  assert.equal(store.locked, false);
});

test('client abort is sanitized before opening and while an unconsumed response is idle', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  const before = new AbortController();
  before.abort('/sensitive/source/path');
  await assert.rejects(createPrivateHubImageResponse(store, 'thumbnail', hash, request({ signal: before.signal }), options),
    { name: 'AbortError', message: 'Private image request aborted.' });
  assert.equal(tracked.limits.length, 0);
  const controller = new AbortController();
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request({ signal: controller.signal }), options);
  controller.abort('/sensitive/source/path');
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
  await assert.rejects(response.arrayBuffer(), { name: 'AbortError', message: 'Private image request aborted.' });
});

test('abort during pending storage rejects promptly and wipes its abandoned result when it arrives', async t => {
  const { store } = await fixture(t);
  const held = heldRead(t, store);
  const controller = new AbortController();
  const opening = createPrivateHubImageResponse(store, 'thumbnail', hash, request({ signal: controller.signal }), options);
  await held.entered;
  controller.abort('/sensitive/source/path');
  await assert.rejects(opening, { name: 'AbortError', message: 'Private image request aborted.' });
  held.release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(held.plaintext()?.every(byte => byte === 0));
});

test('lock during pending storage returns promptly and wipes the late plaintext result', async t => {
  const { store } = await fixture(t);
  const held = heldRead(t, store);
  const opening = createPrivateHubImageResponse(store, 'thumbnail', hash, request(), options);
  await held.entered;
  await store.lock();
  const response = await opening;
  assert.equal(response.status, 404);
  held.release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(held.plaintext()?.every(byte => byte === 0));
});

test('authority revoked during storage or before body consumption never receives plaintext', async t => {
  const { store } = await fixture(t);
  let current = true;
  const held = heldRead(t, store);
  const opening = createPrivateHubImageResponse(store, 'thumbnail', hash, request(), { isCurrent: () => current });
  await held.entered;
  current = false;
  held.release();
  assert.equal((await opening).status, 404);
  assert.ok(held.plaintext()?.every(byte => byte === 0));
  t.mock.restoreAll();
  current = true;
  const tracked = trackPlaintext(t, store);
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), { isCurrent: () => current });
  current = false;
  await assert.rejects(response.arrayBuffer(), /Private image is unavailable/);
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
});

test('lock at the asynchronous image handoff wipes staged bytes before returning a response', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  let checks = 0;
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), {
    isCurrent: () => {
      if (++checks === 2) { queueMicrotask(() => { void store.lock(); }); }
      return true;
    },
  });
  assert.equal(response.status, 404);
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
});

test('revoking authority after the delivery copy is staged wipes both copies without enqueueing', async t => {
  const { store } = await fixture(t);
  const tracked = trackPlaintext(t, store);
  let delivery: Buffer | undefined;
  const originalFrom = Buffer.from;
  t.mock.method(Buffer, 'from', (...args: unknown[]): Buffer => {
    const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
    if (Buffer.isBuffer(args[0]) && args[0].equals(Buffer.of(48, 49, 50, 51, 52, 53, 54, 55, 56, 57))) {
      delivery = result;
    }
    return result;
  });
  const response = await createPrivateHubImageResponse(store, 'thumbnail', hash, request(), { isCurrent: () => !delivery });
  await assert.rejects(response.arrayBuffer(), /Private image is unavailable/);
  assert.ok(delivery?.every(byte => byte === 0));
  assert.ok(tracked.buffers[0].every(byte => byte === 0));
});
