import * as assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  openPrivateHubMedia,
  PRIVATE_HUB_MEDIA_CHUNK_BYTES,
  PRIVATE_HUB_MEDIA_MAX_BYTES,
  PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES,
  readPrivateHubMediaManifest,
  readPrivateHubMediaRange,
  writePrivateHubMedia,
} from './private-hub-media.ts';
import { PrivateHubStore } from './private-hub-store.ts';
import { PRIVATE_HUB_LOCK_FILE } from './private-hub-lock.ts';

const password = 'Synthetic media streaming test passphrase';
const mediaId = 'clip:' + 'a'.repeat(200);
const chunkBytes = PRIVATE_HUB_MEDIA_CHUNK_BYTES;

async function fixture(t: TestContext): Promise<{ root: string; directory: string; store: PrivateHubStore }> {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..'), '.private-hub-media-test-'));
  const directory = path.join(root, 'vault');
  const store = await PrivateHubStore.create(directory, password);
  t.after(async () => {
    await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, directory, store };
}

async function* bytesSource(bytes: Uint8Array, pieceBytes = bytes.byteLength || 1): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += pieceBytes) {
    yield bytes.subarray(offset, Math.min(offset + pieceBytes, bytes.byteLength));
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const pieces: Uint8Array[] = [];
  for await (const piece of source) {
    assert.ok(piece.byteLength <= chunkBytes);
    pieces.push(piece);
  }
  return Buffer.concat(pieces);
}

function manifestId(id = mediaId): string {
  return 'media-manifest:' + createHash('sha256')
    .update('theatrum-private-hub-media-id-v1\0').update(id).digest('hex');
}

async function fingerprint(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const name of (await fs.promises.readdir(directory)).sort()) {
    result.set(name, createHash('sha256').update(await fs.promises.readFile(path.join(directory, name))).digest('hex'));
  }
  return result;
}

test('streams random media with bounded records and authenticates ranges across chunk boundaries', async t => {
  const { directory, store } = await fixture(t);
  const bytes = randomBytes(chunkBytes * 3 + 79);
  const originalWrite = store.writeNewRecord.bind(store);
  const lengths: number[] = [];
  t.mock.method(store, 'writeNewRecord', async (id: string, plaintext: Buffer) => {
    lengths.push(plaintext.length);
    assert.ok(id.length <= 256);
    return originalWrite(id, plaintext);
  });
  const originalRead = store.readRecord.bind(store);
  const caps: number[] = [];
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    assert.ok(maximum !== undefined);
    caps.push(maximum);
    return originalRead(id, maximum);
  });
  const manifest = await writePrivateHubMedia(store, mediaId, bytesSource(bytes, chunkBytes * 2 + 11));
  assert.equal(manifest.byteLength, bytes.length);
  assert.equal(manifest.chunkCount, 4);
  assert.deepEqual(lengths, [chunkBytes, chunkBytes, chunkBytes, 79]);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId)), bytes);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId, chunkBytes - 17, chunkBytes * 2 + 33)),
    bytes.subarray(chunkBytes - 17, chunkBytes * 2 + 33));
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId, bytes.length - 1, bytes.length)), bytes.subarray(-1));
  assert.ok(caps.every(cap => cap <= chunkBytes));
  assert.ok(caps.includes(PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES));
  assert.ok((await fs.promises.readdir(directory)).every(name => name === 'private-hub.json' || name === PRIVATE_HUB_LOCK_FILE || /^[0-9a-f]{64}\.sealed$/.test(name)));
  await store.lock();
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    assert.deepEqual(await collect(readPrivateHubMediaRange(reopened, mediaId, 11, chunkBytes + 4)), bytes.subarray(11, chunkBytes + 4));
  } finally {
    await reopened.lock();
  }
});

test('replacement publishes a fresh generation while pinned readers retain consistent bytes and size', async t => {
  const { store } = await fixture(t);
  const first = randomBytes(chunkBytes + 27);
  const second = randomBytes(61);
  const oldManifest = await writePrivateHubMedia(store, mediaId, bytesSource(first, 7331));
  const oldReader = await openPrivateHubMedia(store, mediaId);
  const oldStream = oldReader.readRange();
  const oldFirst = await oldStream.next();
  assert.equal(oldFirst.done, false);
  const nextManifest = await writePrivateHubMedia(store, mediaId, bytesSource(second));
  assert.notEqual(nextManifest.generation, oldManifest.generation);
  assert.equal(oldReader.byteLength, first.length);
  const oldRest = await collect(oldStream);
  assert.deepEqual(Buffer.concat([oldFirst.value as Buffer, oldRest]), first);
  assert.deepEqual(await collect(oldReader.readRange()), first);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId)), second);
});

test('interrupted ingest leaves the previous manifest and encrypted orphan chunks without plaintext files', async t => {
  const { directory, store } = await fixture(t);
  const old = Buffer.from('original successful preview');
  const marker = 'PRIVATE-CLIP-CANARY-do-not-expose';
  const piece = Buffer.alloc(chunkBytes, marker);
  await writePrivateHubMedia(store, mediaId, bytesSource(old));
  const before = await readPrivateHubMediaManifest(store, mediaId);
  async function* failingSource(): AsyncGenerator<Uint8Array> {
    yield piece;
    throw new Error('Synthetic producer failure');
  }
  await assert.rejects(writePrivateHubMedia(store, mediaId, failingSource()), /Synthetic producer failure/);
  assert.deepEqual(await readPrivateHubMediaManifest(store, mediaId), before);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId)), old);
  assert.equal((await fs.promises.readdir(directory)).filter(name => name.endsWith('.sealed')).length, 3);
  for (const name of await fs.promises.readdir(directory)) {
    assert.equal((await fs.promises.readFile(path.join(directory, name))).includes(marker), false);
  }
  assert.equal(piece.includes(marker), true, 'caller-owned producer bytes are not wiped');
});

test('an interrupted manifest replacement retains the complete previous generation', async t => {
  const { store } = await fixture(t);
  const before = randomBytes(37);
  await writePrivateHubMedia(store, mediaId, bytesSource(before));
  const originalWrite = store.writeRecord.bind(store);
  const writeMock = t.mock.method(store, 'writeRecord', async (id: string, bytes: Buffer) => {
    if (id === manifestId()) {
      throw new Error('Synthetic failure before manifest publication');
    }
    return originalWrite(id, bytes);
  });
  await assert.rejects(writePrivateHubMedia(store, mediaId, bytesSource(randomBytes(chunkBytes + 1))), /before manifest publication/);
  writeMock.mock.restore();
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId)), before);
});

test('range reads do not touch distant chunks but corruption is never returned as plaintext', async t => {
  const { directory, store } = await fixture(t);
  const bytes = randomBytes(chunkBytes * 3 + 5);
  const files: string[] = [];
  const originalWrite = store.writeNewRecord.bind(store);
  t.mock.method(store, 'writeNewRecord', async (id: string, plaintext: Buffer) => {
    const before = await fingerprint(directory);
    await originalWrite(id, plaintext);
    const added = [...(await fingerprint(directory)).keys()].filter(name => !before.has(name));
    assert.equal(added.length, 1);
    files.push(path.join(directory, added[0]));
  });
  await writePrivateHubMedia(store, mediaId, bytesSource(bytes));
  const damaged = await fs.promises.readFile(files[2]);
  damaged[damaged.length - 1] ^= 1;
  await fs.promises.writeFile(files[2], damaged);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId, 0, 71)), bytes.subarray(0, 71));
  const range = readPrivateHubMediaRange(store, mediaId, chunkBytes * 2, chunkBytes * 2 + 1);
  await assert.rejects(range.next());
  assert.equal((await range.next()).done, true);
});

test('swapping encrypted chunks across positions or media objects fails authentication', async t => {
  const { directory, store } = await fixture(t);
  const files: string[] = [];
  const originalWrite = store.writeNewRecord.bind(store);
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    const before = await fingerprint(directory);
    await originalWrite(id, bytes);
    const added = [...(await fingerprint(directory)).keys()].filter(name => !before.has(name));
    files.push(path.join(directory, added[0]));
  });
  await writePrivateHubMedia(store, mediaId, bytesSource(randomBytes(chunkBytes * 2)));
  await writePrivateHubMedia(store, 'other-clip', bytesSource(randomBytes(chunkBytes)));
  const original = await fs.promises.readFile(files[0]);
  await fs.promises.writeFile(files[0], await fs.promises.readFile(files[1]));
  await assert.rejects(collect(readPrivateHubMediaRange(store, mediaId, 0, 1)));
  await fs.promises.writeFile(files[0], original);
  await fs.promises.writeFile(files[0], await fs.promises.readFile(files[2]));
  await assert.rejects(collect(readPrivateHubMediaRange(store, mediaId, 0, 1)));
});

test('malformed, oversized, and inconsistent manifests fail before any media chunk read', async t => {
  const { store } = await fixture(t);
  const good = await writePrivateHubMedia(store, mediaId, bytesSource(Buffer.from('preview')));
  const originalRead = store.readRecord.bind(store);
  let chunkReads = 0;
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    if (id.startsWith('media-chunk:')) {
      chunkReads++;
    }
    return originalRead(id, maximum);
  });
  const malformed: unknown[] = [
    null, [], {}, { ...good, extra: true }, { ...good, version: 2 }, { ...good, generation: '../outside' },
    { ...good, chunkBytes: 0 }, { ...good, byteLength: -1 }, { ...good, byteLength: 1.1 },
    { ...good, byteLength: PRIVATE_HUB_MEDIA_MAX_BYTES + 1 }, { ...good, byteLength: Number.MAX_SAFE_INTEGER },
    { ...good, chunkCount: 0 }, { ...good, chunkCount: 1.1 }, { ...good, byteLength: 0, chunkCount: 1 },
  ];
  for (const candidate of malformed) {
    await store.writeRecord(manifestId(), Buffer.from(JSON.stringify(candidate)));
    await assert.rejects(openPrivateHubMedia(store, mediaId), /Invalid private hub media manifest/);
  }
  await store.writeRecord(manifestId(), Buffer.alloc(PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES + 1, ' '));
  await assert.rejects(openPrivateHubMedia(store, mediaId), /size limit/);
  assert.equal(chunkReads, 0);
});

test('authenticated short or oversized chunks are refused rather than silently truncating a range', async t => {
  const { store } = await fixture(t);
  const ids: string[] = [];
  const originalWrite = store.writeNewRecord.bind(store);
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    ids.push(id);
    return originalWrite(id, bytes);
  });
  await writePrivateHubMedia(store, mediaId, bytesSource(randomBytes(chunkBytes + 7)));
  await store.writeRecord(ids[1], randomBytes(6));
  await assert.rejects(collect(readPrivateHubMediaRange(store, mediaId, chunkBytes, chunkBytes + 1)), /length/);
  await store.writeRecord(ids[1], randomBytes(8));
  await assert.rejects(collect(readPrivateHubMediaRange(store, mediaId, chunkBytes, chunkBytes + 1)), /size limit/);
});

test('empty media and end-exclusive range boundaries have explicit consistent semantics', async t => {
  const { store } = await fixture(t);
  const empty = await writePrivateHubMedia(store, mediaId, bytesSource(Buffer.alloc(0)));
  assert.equal(empty.byteLength, 0);
  assert.equal(empty.chunkCount, 0);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId)), Buffer.alloc(0));
  await assert.rejects(collect(readPrivateHubMediaRange(store, mediaId, 0, 1)), /byte range/);
  const bytes = Buffer.from('0123456789');
  await writePrivateHubMedia(store, mediaId, bytesSource(bytes, 1));
  const reader = await openPrivateHubMedia(store, mediaId);
  assert.deepEqual(await collect(reader.readRange(2, 2)), Buffer.alloc(0));
  assert.deepEqual(await collect(reader.readRange(10, 10)), Buffer.alloc(0));
  assert.deepEqual(await collect(reader.readRange(2, 4)), Buffer.from('23'));
  for (const [start, end] of [[-1, 1], [0, 11], [4, 3], [0.5, 2], [0, NaN], [Infinity, Infinity], [11, 11]]) {
    await assert.rejects(collect(reader.readRange(start, end)), /byte range/);
  }
});

test('locking between range chunks stops future plaintext while caller-owned returned bytes remain intact', async t => {
  const { store } = await fixture(t);
  const bytes = randomBytes(chunkBytes + 1);
  await writePrivateHubMedia(store, mediaId, bytesSource(bytes));
  const reader = await openPrivateHubMedia(store, mediaId);
  const range = reader.readRange();
  const first = await range.next();
  assert.equal(first.done, false);
  await store.lock();
  await assert.rejects(range.next(), /locked/);
  await assert.rejects(collect(reader.readRange()), /locked/);
  assert.deepEqual(first.value, bytes.subarray(0, chunkBytes));
});

test('locking at a pending chunk-read boundary wipes plaintext before it can be yielded', async t => {
  const { store } = await fixture(t);
  await writePrivateHubMedia(store, mediaId, bytesSource(randomBytes(51)));
  const reader = await openPrivateHubMedia(store, mediaId);
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    void store.lock();
    return owned;
  });
  await assert.rejects(reader.readRange().next(), /locked/);
  assert.ok(owned);
  assert.ok(owned.every(byte => byte === 0));
});

test('locking during ingest stops pulling the producer and never publishes its partial generation', async t => {
  const { directory, store } = await fixture(t);
  const before = Buffer.from('previous complete clip');
  await writePrivateHubMedia(store, mediaId, bytesSource(before));
  let pulls = 0;
  let closed = false;
  async function* source(): AsyncGenerator<Uint8Array> {
    try {
      pulls++;
      yield randomBytes(chunkBytes);
      pulls++;
      yield randomBytes(chunkBytes);
    } finally {
      closed = true;
    }
  }
  const originalWrite = store.writeNewRecord.bind(store);
  t.mock.method(store, 'writeNewRecord', async (id: string, bytes: Buffer) => {
    await originalWrite(id, bytes);
    void store.lock();
  });
  await assert.rejects(writePrivateHubMedia(store, mediaId, source()), /locked/);
  await store.lock();
  assert.equal(pulls, 1);
  assert.equal(closed, true);
  const reopened = await PrivateHubStore.open(directory, password);
  try {
    assert.deepEqual(await collect(readPrivateHubMediaRange(reopened, mediaId)), before);
  } finally {
    await reopened.lock();
  }
});

test('concurrent ingests are serialized without interleaving generations or advancing queued producers', async t => {
  const { store } = await fixture(t);
  let release: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let secondPulled = false;
  async function* firstSource(): AsyncGenerator<Uint8Array> {
    entered();
    await hold;
    yield Buffer.from('first');
  }
  async function* secondSource(): AsyncGenerator<Uint8Array> {
    secondPulled = true;
    yield Buffer.from('second');
  }
  const first = writePrivateHubMedia(store, mediaId, firstSource());
  await started;
  const second = writePrivateHubMedia(store, mediaId, secondSource());
  await Promise.resolve();
  assert.equal(secondPulled, false);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.notEqual(one.generation, two.generation);
  assert.deepEqual(await collect(readPrivateHubMediaRange(store, mediaId)), Buffer.from('second'));
});

test('invalid identities and non-byte producer values are refused without publishing a manifest', async t => {
  const { store } = await fixture(t);
  for (const id of ['', '../outside', 'bad/id', 'bad\\id', '\0', 'a'.repeat(257)]) {
    await assert.rejects(writePrivateHubMedia(store, id, bytesSource(Buffer.from('test'))), /identity/);
    await assert.rejects(openPrivateHubMedia(store, id), /identity/);
  }
  async function* source(): AsyncGenerator<Uint8Array> {
    yield 'not bytes' as unknown as Uint8Array;
  }
  await assert.rejects(writePrivateHubMedia(store, mediaId, source()), /byte arrays/);
  await assert.rejects(openPrivateHubMedia(store, mediaId), { code: 'ENOENT' });
});


test('lock cancels a stalled producer promptly and synchronously wipes the partial assembly', async t => {
  const { store } = await fixture(t);
  let owned: Buffer | undefined;
  const originalAlloc = Buffer.alloc;
  t.mock.method(Buffer, 'alloc', (size: number, fill?: string | Uint8Array | number, encoding?: BufferEncoding) => {
    const allocated = originalAlloc(size, fill, encoding);
    if (size === chunkBytes) {
      owned = allocated;
    }
    return allocated;
  });
  let pulled = 0;
  let cleanupRequested = false;
  let stalled: () => void;
  const waiting = new Promise<void>(resolve => { stalled = resolve; });
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]: () => source,
    next: () => {
      pulled++;
      if (pulled === 1) {
        return Promise.resolve({ done: false, value: Buffer.from('partial plaintext') });
      }
      stalled();
      return new Promise(() => undefined);
    },
    return: () => {
      cleanupRequested = true;
      return new Promise(() => undefined);
    },
  };
  const write = writePrivateHubMedia(store, mediaId, source);
  const rejected = assert.rejects(write, /locked/);
  await waiting;
  assert.ok(owned?.includes('partial plaintext'));
  const locking = store.lock();
  assert.ok(owned?.every(byte => byte === 0), 'assembly is wiped in the synchronous abort callback');
  await rejected;
  await locking;
  assert.equal(cleanupRequested, true);
  assert.equal(pulled, 2);
});

test('lock at the read-result promise boundary prevents iterator transfer and wipes bytes', async t => {
  const { store } = await fixture(t);
  await writePrivateHubMedia(store, mediaId, bytesSource(randomBytes(37)));
  const reader = await openPrivateHubMedia(store, mediaId);
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  t.mock.method(store, 'readRecord', (id: string, maximum?: number) => originalRead(id, maximum).then(bytes => {
    owned = bytes;
    queueMicrotask(() => { void store.lock(); });
    return bytes;
  }));
  await assert.rejects(reader.readRange().next(), /locked/);
  assert.ok(owned?.every(byte => byte === 0));
});

test('range iterators reject overlapping pulls and cancellation wipes a pending result', async t => {
  const { store } = await fixture(t);
  await writePrivateHubMedia(store, mediaId, bytesSource(randomBytes(37)));
  const reader = await openPrivateHubMedia(store, mediaId);
  const originalRead = store.readRecord.bind(store);
  let owned: Buffer | undefined;
  let release: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(store, 'readRecord', async (id: string, maximum?: number) => {
    owned = await originalRead(id, maximum);
    entered();
    await held;
    return owned;
  });
  const range = reader.readRange();
  const first = range.next();
  await waiting;
  await assert.rejects(range.next(), /already pending/);
  await range.return?.();
  release();
  assert.equal((await first).done, true);
  assert.ok(owned?.every(byte => byte === 0));
});

test('media byte-limit rejection occurs before retaining or writing an oversized source piece', async t => {
  const { directory, store } = await fixture(t);
  const before = await fingerprint(directory);
  // An adversarial array reports a huge byte length without allocating a 1 GiB
  // fixture; the size check must precede copying or chunk publication.
  const piece = new Uint8Array(1);
  Object.defineProperty(piece, 'byteLength', { value: PRIVATE_HUB_MEDIA_MAX_BYTES + 1 });
  async function* source(): AsyncGenerator<Uint8Array> { yield piece; }
  await assert.rejects(writePrivateHubMedia(store, mediaId, source()), /size limit/);
  assert.deepEqual(await fingerprint(directory), before);
});

test('media writes bound their pending queue without advancing rejected or locked producers', async t => {
  const { store } = await fixture(t);
  let entered: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let cleanupRequested = 0;
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]: () => source,
    next: () => {
      entered();
      return new Promise(() => undefined);
    },
    return: () => {
      cleanupRequested++;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const first = assert.rejects(writePrivateHubMedia(store, mediaId, source), /locked/);
  await waiting;
  let unexpectedPulls = 0;
  async function* otherSource(): AsyncGenerator<Uint8Array> {
    unexpectedPulls++;
    yield Buffer.from('unused');
  }
  const accepted = Array.from({ length: 7 }, () => assert.rejects(writePrivateHubMedia(store, mediaId, otherSource()), /locked/));
  await assert.rejects(writePrivateHubMedia(store, mediaId, otherSource()), /queue is full/);
  await store.lock();
  await Promise.all([first, ...accepted]);
  assert.equal(unexpectedPulls, 0);
  assert.equal(cleanupRequested, 1);
});

test('the convenience iterator rechecks locking after adopting an inner range result', async t => {
  const { store } = await fixture(t);
  const bytes = randomBytes(37);
  await writePrivateHubMedia(store, mediaId, bytesSource(bytes));
  const originalFrom = Buffer.from;
  let output: Buffer | undefined;
  t.mock.method(Buffer, 'from', (...args: unknown[]): Buffer => {
    const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
    if (Buffer.isBuffer(args[0]) && args[0].equals(bytes)) {
      output = result;
      queueMicrotask(() => { void store.lock(); });
    }
    return result;
  });
  await assert.rejects(readPrivateHubMediaRange(store, mediaId).next(), /locked/);
  assert.ok(output);
  assert.ok(output.every(byte => byte === 0));
});

test('a corrupted manifest never falls back to a valid older generation', async t => {
  const { directory, store } = await fixture(t);
  await writePrivateHubMedia(store, mediaId, bytesSource(Buffer.from('first generation')));
  const before = await fingerprint(directory);
  await writePrivateHubMedia(store, mediaId, bytesSource(Buffer.from('second generation')));
  const after = await fingerprint(directory);
  const changed = [...after.keys()].filter(name => before.has(name) && after.get(name) !== before.get(name));
  assert.equal(changed.length, 1);
  const primary = path.join(directory, changed[0]);
  const damaged = await fs.promises.readFile(primary);
  damaged[damaged.length - 1] ^= 1;
  await fs.promises.writeFile(primary, damaged);
  const corruptState = await fingerprint(directory);
  await assert.rejects(openPrivateHubMedia(store, mediaId));
  await assert.rejects(collect(readPrivateHubMediaRange(store, mediaId)));
  assert.deepEqual(await fingerprint(directory), corruptState);
});
