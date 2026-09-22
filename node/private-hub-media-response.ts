import { openPrivateHubMedia, type PrivateHubMediaReader } from './private-hub-media';
import type { PrivateHubStore } from './private-hub-store';

export interface PrivateHubMediaResponseOptions {
  /** Main-process catalogue/session authority; never derive this from a URL. */
  isCurrent: () => boolean;
  contentType: 'video/mp4' | 'image/jpeg';
  /** Main-process resource accounting only; never grants access. Called once after ownership ends. */
  onComplete?: () => void;
}

interface ByteRange {
  start: number;
  endExclusive: number;
}

class UnavailablePrivateMediaError extends Error {
  constructor() {
    super('Private media is unavailable.');
    this.name = 'UnavailablePrivateMediaError';
  }
}

function abortError(): DOMException {
  // Abort reasons and underlying filesystem messages can contain private paths.
  return new DOMException('Private media request aborted.', 'AbortError');
}

function assertCurrent(store: PrivateHubStore, request: Request, options: PrivateHubMediaResponseOptions): void {
  if (request.signal.aborted) {
    throw abortError();
  }
  let current = false;
  try {
    current = !store.locked && typeof options?.isCurrent === 'function' && options.isCurrent() === true;
  } catch {
    // A failed authority predicate never authorizes or exposes its exception.
  }
  // The main-owned predicate can itself revoke authority synchronously. Recheck
  // both signals after invoking it, including before returning HEAD metadata.
  if (request.signal.aborted) {
    throw abortError();
  }
  if (!current || store.locked) {
    throw new UnavailablePrivateMediaError();
  }
}

function privateHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
}

function emptyResponse(status: number, additions: Record<string, string> = {}): Response {
  const headers = privateHeaders();
  headers.set('Content-Length', '0');
  for (const [name, value] of Object.entries(additions)) {
    headers.set(name, value);
  }
  return new Response(null, { status, headers });
}

/**
 * Deliberately supports one range only. Unknown units, malformed/multiple
 * ranges, excessive header lengths, and unsatisfiable ranges receive 416;
 * none are expanded into allocations or multiple concurrent decryptions.
 */
function parseRange(value: string, byteLength: number): ByteRange | undefined {
  if (value.length > 64) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || byteLength === 0) {
    return undefined;
  }
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return undefined;
    }
    return { start: Math.max(0, byteLength - suffix), endExclusive: byteLength };
  }
  const start = Number(match[1]);
  const inclusiveEnd = match[2] ? Number(match[2]) : byteLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(inclusiveEnd)
    || start < 0 || start >= byteLength || inclusiveEnd < start) {
    return undefined;
  }
  // Clamp before adding one so even a valid MAX_SAFE_INTEGER endpoint is safe.
  return { start, endExclusive: Math.min(inclusiveEnd, byteLength - 1) + 1 };
}

function awaitPrivateReader(
  store: PrivateHubStore,
  request: Request,
  options: PrivateHubMediaResponseOptions,
  opening: Promise<PrivateHubMediaReader>,
): Promise<PrivateHubMediaReader> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      request.signal.removeEventListener('abort', onAbort);
      store.lockSignal.removeEventListener('abort', onLock);
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortError());
    };
    const onLock = (): void => {
      cleanup();
      reject(new UnavailablePrivateMediaError());
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    store.lockSignal.addEventListener('abort', onLock, { once: true });
    try {
      assertCurrent(store, request, options);
    } catch (error) {
      cleanup();
      reject(error);
    }
    opening.then(reader => {
      cleanup();
      try {
        assertCurrent(store, request, options);
        resolve(reader);
      } catch (error) {
        reject(error);
      }
    }, () => {
      cleanup();
      reject(new UnavailablePrivateMediaError());
    });
  });
}

/**
 * Main-process response adapter only. This does not register a route, validate
 * a renderer URL, grant filesystem authority, or choose a store. The caller
 * must first authorize the requested media and supply its current-session guard.
 */
export async function createPrivateHubMediaResponse(
  store: PrivateHubStore,
  mediaId: string,
  request: Request,
  options: PrivateHubMediaResponseOptions,
): Promise<Response> {
  let completed = false;
  const complete = (): void => {
    if (completed) { return; }
    completed = true;
    try { void Promise.resolve(options.onComplete?.()).catch(() => undefined); } catch { /* observer only */ }
  };
  const completeMetadata = (response: Response): Response => {
    complete();
    try { assertCurrent(store, request, options); return response; }
    catch {
      if (request.signal.aborted) { throw abortError(); }
      return emptyResponse(404);
    }
  };
  if (request.signal.aborted) {
    complete();
    throw abortError();
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    complete();
    return emptyResponse(405, { 'Allow': 'GET, HEAD' });
  }
  let reader: PrivateHubMediaReader;
  try {
    assertCurrent(store, request, options);
    if (options.contentType !== 'video/mp4' && options.contentType !== 'image/jpeg') {
      throw new UnavailablePrivateMediaError();
    }
    reader = await awaitPrivateReader(store, request, options, openPrivateHubMedia(store, mediaId));
    assertCurrent(store, request, options);
  } catch {
    complete();
    if (request.signal.aborted) {
      throw abortError();
    }
    return emptyResponse(404);
  }

  const headers = privateHeaders();
  headers.set('Content-Type', options.contentType);
  headers.set('Accept-Ranges', 'bytes');
  let range: ByteRange = { start: 0, endExclusive: reader.byteLength };
  let status = 200;
  // HTTP Range applies to GET. HEAD returns the full representation's headers.
  // No ETag/Last-Modified validators are exposed, so If-Range receives a full
  // representation rather than interpreting a validator we did not issue.
  const requestedRange = request.method === 'GET' && !request.headers.has('If-Range')
    ? request.headers.get('Range') : null;
  if (requestedRange !== null) {
    const parsed = parseRange(requestedRange, reader.byteLength);
    if (!parsed) {
      return completeMetadata(emptyResponse(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${reader.byteLength}` }));
    }
    range = parsed;
    status = 206;
    headers.set('Content-Range', `bytes ${range.start}-${range.endExclusive - 1}/${reader.byteLength}`);
  }
  const length = range.endExclusive - range.start;
  headers.set('Content-Length', String(length));
  if (request.method === 'HEAD' || length === 0) {
    return completeMetadata(new Response(null, { status, headers }));
  }

  const chunks = reader.readRange(range.start, range.endExclusive);
  let stopped = false;
  let owned: Buffer | undefined;
  let remaining = length;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = (): void => {
    request.signal.removeEventListener('abort', onAbort);
    store.lockSignal.removeEventListener('abort', onLock);
  };
  const stop = (error?: Error): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    owned?.fill(0);
    owned = undefined;
    cleanup();
    // Return closes admission immediately; an already-submitted filesystem read
    // may still settle, and its still-owned bytes are discarded by the iterator.
    void chunks.return?.().catch(() => undefined);
    complete();
    if (error) {
      controller.error(error);
    }
  };
  const onAbort = (): void => { stop(abortError()); };
  const onLock = (): void => { stop(new UnavailablePrivateMediaError()); };
  const stream = new ReadableStream<Uint8Array>({
    start: target => {
      controller = target;
      request.signal.addEventListener('abort', onAbort, { once: true });
      store.lockSignal.addEventListener('abort', onLock, { once: true });
      try {
        assertCurrent(store, request, options);
      } catch (error) {
        stop(error as Error);
      }
    },
    pull: async target => {
      if (stopped) {
        return;
      }
      try {
        assertCurrent(store, request, options);
        const next = await chunks.next();
        if (!next.done) {
          owned = next.value;
        }
        assertCurrent(store, request, options);
        if (stopped) {
          owned?.fill(0);
          owned = undefined;
          return;
        }
        if (next.done || !owned || owned.length === 0 || owned.length > remaining) {
          throw new UnavailablePrivateMediaError();
        }
        remaining -= owned.length;
        assertCurrent(store, request, options);
        // Ownership passes to the stream consumer here. Already-delivered bytes
        // cannot be revoked by locking; nothing is retained for prefetch.
        target.enqueue(owned);
        owned = undefined;
        if (remaining === 0) {
          stop();
          target.close();
        }
      } catch {
        owned?.fill(0);
        owned = undefined;
        // Authentication/filesystem failures terminate the body; never replace
        // missing bytes with plaintext, an older generation, or an error payload.
        stop(request.signal.aborted ? abortError() : new UnavailablePrivateMediaError());
      }
    },
    cancel: () => { stop(); },
  }, { highWaterMark: 0 });
  return new Response(stream, { status, headers });
}
