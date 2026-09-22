import { createHash, randomBytes } from 'node:crypto';

import type { PrivateHubStore } from './private-hub-store';

export const PRIVATE_HUB_MEDIA_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_HUB_MEDIA_MAX_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES = 512;
const MAX_PENDING_WRITES = 8;
const FORMAT = 'theatrum-private-hub-media';

export interface PrivateHubMediaManifest {
  readonly format: typeof FORMAT;
  readonly version: 1;
  readonly generation: string;
  readonly chunkBytes: typeof PRIVATE_HUB_MEDIA_CHUNK_BYTES;
  readonly byteLength: number;
  readonly chunkCount: number;
}

export interface PrivateHubMediaReader {
  readonly byteLength: number;
  /** Byte offsets are start-inclusive/end-exclusive. Empty ranges are valid. */
  readRange(start?: number, endExclusive?: number): AsyncIterableIterator<Buffer>;
}

interface WriteQueue {
  tail: Promise<void>;
  pending: number;
}

const writeQueues = new WeakMap<PrivateHubStore, WriteQueue>();

function assertUnlocked(store: PrivateHubStore): void {
  if (store.locked) {
    throw new Error('The private hub is locked.');
  }
}

function namespace(mediaId: string): string {
  if (typeof mediaId !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(mediaId)) {
    throw new Error('Invalid private hub media identity.');
  }
  // The fixed-length namespace supports long catalogue hashes without exceeding
  // record-ID limits. The store separately HMACs every on-disk filename.
  return createHash('sha256').update('theatrum-private-hub-media-id-v1\0').update(mediaId).digest('hex');
}

function manifestRecordId(mediaNamespace: string): string {
  return 'media-manifest:' + mediaNamespace;
}

/** Main-only manifest identity for authenticated presence and backup checks. */
export function privateHubMediaManifestRecordId(mediaId: string): string {
  return manifestRecordId(namespace(mediaId));
}

function chunkRecordId(mediaNamespace: string, generation: string, index: number): string {
  return `media-chunk:${mediaNamespace}:${generation}:${index}`;
}

function validateManifest(value: unknown): PrivateHubMediaManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid private hub media manifest.');
  }
  const candidate = value as Record<string, unknown>;
  const fields = ['format', 'version', 'generation', 'chunkBytes', 'byteLength', 'chunkCount'];
  if (Object.keys(candidate).length !== fields.length || fields.some(field => !Object.hasOwn(candidate, field))
    || candidate.format !== FORMAT || candidate.version !== 1
    || typeof candidate.generation !== 'string' || !/^[0-9a-f]{48}$/.test(candidate.generation)
    || candidate.chunkBytes !== PRIVATE_HUB_MEDIA_CHUNK_BYTES
    || typeof candidate.byteLength !== 'number' || !Number.isSafeInteger(candidate.byteLength)
    || candidate.byteLength < 0 || candidate.byteLength > PRIVATE_HUB_MEDIA_MAX_BYTES
    || typeof candidate.chunkCount !== 'number' || !Number.isSafeInteger(candidate.chunkCount)
    || candidate.chunkCount !== Math.ceil(candidate.byteLength / PRIVATE_HUB_MEDIA_CHUNK_BYTES)) {
    throw new Error('Invalid private hub media manifest.');
  }
  return Object.freeze({
    format: FORMAT,
    version: 1,
    generation: candidate.generation,
    chunkBytes: PRIVATE_HUB_MEDIA_CHUNK_BYTES,
    byteLength: candidate.byteLength,
    chunkCount: candidate.chunkCount,
  });
}

async function readManifest(store: PrivateHubStore, mediaNamespace: string): Promise<PrivateHubMediaManifest> {
  assertUnlocked(store);
  const bytes = await store.readRecord(manifestRecordId(mediaNamespace), PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES);
  try {
    assertUnlocked(store);
    if (bytes.length > PRIVATE_HUB_MEDIA_MAX_MANIFEST_BYTES) {
      throw new Error('The private hub media manifest exceeds its size limit.');
    }
    return validateManifest(JSON.parse(bytes.toString('utf8')));
  } finally {
    bytes.fill(0);
  }
}

function enqueueWrite<T>(store: PrivateHubStore, operation: () => Promise<T>): Promise<T> {
  assertUnlocked(store);
  let queue = writeQueues.get(store);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    writeQueues.set(store, queue);
  }
  if (queue.pending >= MAX_PENDING_WRITES) {
    throw new Error('The private hub media write queue is full.');
  }
  queue.pending++;
  const activeQueue = queue;
  const next = activeQueue.tail.then(async () => {
    try {
      assertUnlocked(store);
      return await operation();
    } finally {
      activeQueue.pending--;
    }
  });
  // Retain neither results nor producer plaintext in the settled queue tail.
  activeQueue.tail = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Consume a bounded producer one piece at a time. Sources may yield arbitrary
 * Uint8Array sizes; the helper owns at most one 1 MiB assembly buffer plus the
 * bounded buffers used by one encrypted record write/read-back at a time.
 *
 * Each write has a fresh immutable generation. Only the final authenticated
 * manifest publication makes it visible. Failure before publication retains the
 * previous manifest and may leave encrypted, unreferenced chunks. A filesystem
 * error after publication can leave the complete new generation despite a
 * rejected write acknowledgement. Garbage collection is deferred
 * so an already-open reader can finish its pinned generation safely.
 */
export async function writePrivateHubMedia(
  store: PrivateHubStore,
  mediaId: string,
  source: AsyncIterable<Uint8Array>,
): Promise<PrivateHubMediaManifest> {
  const mediaNamespace = namespace(mediaId);
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new Error('Private hub media requires an asynchronous byte source.');
  }
  return enqueueWrite(store, async () => {
    const generation = randomBytes(24).toString('hex');
    const assembly = Buffer.alloc(PRIVATE_HUB_MEDIA_CHUNK_BYTES);
    let assembledBytes = 0;
    let byteLength = 0;
    let chunkCount = 0;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let sourceDone = false;
    const wipeAssembly = (): void => { assembly.fill(0); };
    store.lockSignal.addEventListener('abort', wipeAssembly, { once: true });
    const publishChunk = async (): Promise<void> => {
      assertUnlocked(store);
      const id = chunkRecordId(mediaNamespace, generation, chunkCount);
      const plaintext = assembly.subarray(0, assembledBytes);
      await store.writeNewRecord(id, plaintext);
      assertUnlocked(store);
      const verified = await store.readRecord(id, assembledBytes);
      try {
        assertUnlocked(store);
        if (verified.length !== assembledBytes || !verified.equals(plaintext)) {
          throw new Error('Private hub media chunk verification failed.');
        }
      } finally {
        verified.fill(0);
      }
      assembly.fill(0);
      assembledBytes = 0;
      chunkCount++;
    };
    try {
      assertUnlocked(store);
      iterator = source[Symbol.asyncIterator]();
      while (true) {
        assertUnlocked(store);
        const next = await waitWhileUnlocked(store, Promise.resolve(iterator.next()));
        assertUnlocked(store);
        if (next.done) {
          sourceDone = true;
          break;
        }
        const piece = next.value;
        if (!(piece instanceof Uint8Array)) {
          throw new Error('Private hub media sources must yield byte arrays.');
        }
        if (piece.byteLength > PRIVATE_HUB_MEDIA_MAX_BYTES - byteLength) {
          throw new Error('The private hub media exceeds its size limit.');
        }
        byteLength += piece.byteLength;
        let offset = 0;
        while (offset < piece.byteLength) {
          assertUnlocked(store);
          const copied = Math.min(assembly.length - assembledBytes, piece.byteLength - offset);
          assembly.set(piece.subarray(offset, offset + copied), assembledBytes);
          assembledBytes += copied;
          offset += copied;
          if (assembledBytes === assembly.length) {
            await publishChunk();
            assertUnlocked(store);
          }
        }
        // Do not pull another producer piece after locking between writes.
        assertUnlocked(store);
      }
      assertUnlocked(store);
      if (assembledBytes > 0) {
        await publishChunk();
      }
      assertUnlocked(store);
      const manifest = validateManifest({
        format: FORMAT,
        version: 1,
        generation,
        chunkBytes: PRIVATE_HUB_MEDIA_CHUNK_BYTES,
        byteLength,
        chunkCount,
      });
      const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      try {
        await store.writeRecord(manifestRecordId(mediaNamespace), bytes);
        assertUnlocked(store);
        return manifest;
      } finally {
        bytes.fill(0);
      }
    } finally {
      store.lockSignal.removeEventListener('abort', wipeAssembly);
      assembly.fill(0);
      if (!sourceDone && iterator?.return) {
        // A stalled producer must not keep a locked write alive. Request cleanup
        // without waiting indefinitely; producers own their yielded buffers and
        // should also use store.lockSignal to cancel their underlying work.
        try {
          void Promise.resolve(iterator.return()).catch(() => undefined);
        } catch {
          // Preserve the ingest error if producer cleanup itself throws.
        }
      }
    }
  });
}

export async function readPrivateHubMediaManifest(
  store: PrivateHubStore,
  mediaId: string,
): Promise<PrivateHubMediaManifest> {
  const manifest = await readManifest(store, namespace(mediaId));
  assertUnlocked(store);
  return manifest;
}

function readGenerationRange(
  store: PrivateHubStore,
  mediaNamespace: string,
  manifest: PrivateHubMediaManifest,
  start = 0,
  endExclusive = manifest.byteLength,
): AsyncIterableIterator<Buffer> {
  let index = Math.floor(start / manifest.chunkBytes);
  let closed = false;
  let pending = false;
  const last = Math.floor((endExclusive - 1) / manifest.chunkBytes);
  const iterator: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]: () => iterator,
    next: (): Promise<IteratorResult<Buffer>> => {
      if (pending) {
        return Promise.reject(new Error('A private hub media range read is already pending.'));
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined });
      }
      try {
        assertUnlocked(store);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endExclusive)
          || start < 0 || endExclusive < start || endExclusive > manifest.byteLength) {
          throw new Error('Invalid private hub media byte range.');
        }
        if (start === endExclusive || index > last) {
          closed = true;
          return Promise.resolve({ done: true, value: undefined });
        }
      } catch (error) {
        closed = true;
        return Promise.reject(error);
      }
      pending = true;
      const currentIndex = index++;
      const expectedLength = Math.min(manifest.chunkBytes, manifest.byteLength - currentIndex * manifest.chunkBytes);
      return store.readRecord(chunkRecordId(mediaNamespace, manifest.generation, currentIndex), expectedLength)
        .then(plaintext => {
          let output: Buffer | undefined;
          try {
            assertUnlocked(store);
            if (closed) {
              return { done: true, value: undefined } as IteratorResult<Buffer>;
            }
            if (plaintext.length !== expectedLength) {
              throw new Error('Private hub media chunk length does not match its manifest.');
            }
            const chunkStart = currentIndex * manifest.chunkBytes;
            const localStart = Math.max(start - chunkStart, 0);
            const localEnd = Math.min(endExclusive - chunkStart, plaintext.length);
            output = Buffer.from(plaintext.subarray(localStart, localEnd));
            assertUnlocked(store);
            // Returning this plain result fulfills next() in this same promise
            // job: no async-generator yield/adoption boundary follows the final
            // lock check. The caller now owns the returned copy.
            return { done: false, value: output } as IteratorResult<Buffer>;
          } catch (error) {
            closed = true;
            output?.fill(0);
            throw error;
          } finally {
            pending = false;
            plaintext.fill(0);
          }
        }, error => {
          pending = false;
          closed = true;
          throw error;
        });
    },
    return: (): Promise<IteratorResult<Buffer>> => {
      closed = true;
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return iterator;
}

/** Pin an authenticated generation before preparing response size/range headers. */
export async function openPrivateHubMedia(store: PrivateHubStore, mediaId: string): Promise<PrivateHubMediaReader> {
  const mediaNamespace = namespace(mediaId);
  const manifest = await readManifest(store, mediaNamespace);
  assertUnlocked(store);
  return Object.freeze({
    byteLength: manifest.byteLength,
    readRange: (start?: number, endExclusive?: number) => readGenerationRange(store, mediaNamespace, manifest, start, endExclusive),
  });
}

/** Authenticate touched chunks in full before returning their requested slices. */
export function readPrivateHubMediaRange(
  store: PrivateHubStore,
  mediaId: string,
  start?: number,
  endExclusive?: number,
): AsyncIterableIterator<Buffer> {
  let reader: Promise<PrivateHubMediaReader> | undefined;
  let range: AsyncIterableIterator<Buffer> | undefined;
  let closed = false;
  let pending = false;
  const iterator: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]: () => iterator,
    next: (): Promise<IteratorResult<Buffer>> => {
      if (pending) {
        return Promise.reject(new Error('A private hub media range read is already pending.'));
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined });
      }
      pending = true;
      reader ??= openPrivateHubMedia(store, mediaId);
      return reader.then(opened => {
        assertUnlocked(store);
        range ??= opened.readRange(start, endExclusive);
        if (closed) {
          return { done: true, value: undefined } as IteratorResult<Buffer>;
        }
        return range.next();
      }).then(result => {
        pending = false;
        try {
          assertUnlocked(store);
          if (closed) {
            if (!result.done) {
              result.value.fill(0);
            }
            return { done: true, value: undefined } as IteratorResult<Buffer>;
          }
          closed = !!result.done;
          return result;
        } catch (error) {
          closed = true;
          if (!result.done) {
            result.value.fill(0);
          }
          throw error;
        }
      }, error => {
        pending = false;
        closed = true;
        throw error;
      });
    },
    return: (): Promise<IteratorResult<Buffer>> => {
      closed = true;
      void range?.return?.();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return iterator;
}

function waitWhileUnlocked<T>(store: PrivateHubStore, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onLock = (): void => {
      store.lockSignal.removeEventListener('abort', onLock);
      reject(new Error('The private hub is locked.'));
    };
    store.lockSignal.addEventListener('abort', onLock, { once: true });
    if (store.locked) {
      onLock();
    }
    promise.then(value => {
      store.lockSignal.removeEventListener('abort', onLock);
      if (store.locked) {
        onLock();
      } else {
        resolve(value);
      }
    }, error => {
      store.lockSignal.removeEventListener('abort', onLock);
      reject(error);
    });
  });
}
