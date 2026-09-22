import { PRIVATE_HUB_MAX_IMAGE_BYTES, readPrivateHubPreview } from './private-hub-catalogue';
import type { PrivateHubStore } from './private-hub-store';

export type PrivateHubImageKind = 'thumbnail' | 'filmstrip' | 'clip-poster';

export interface PrivateHubImageResponseOptions {
  /** Main-process catalogue/session authority; never derive this from a URL. */
  isCurrent: () => boolean;
  /** Main-process resource accounting only; never grants access. Called once after ownership ends. */
  onComplete?: () => void;
}

interface ByteRange {
  start: number;
  endExclusive: number;
}

class UnavailablePrivateImageError extends Error {
  constructor() {
    super('Private image is unavailable.');
    this.name = 'UnavailablePrivateImageError';
  }
}

function abortError(): DOMException {
  // Request reasons and filesystem errors can contain private source paths.
  return new DOMException('Private image request aborted.', 'AbortError');
}

function assertCurrent(store: PrivateHubStore, request: Request, options: PrivateHubImageResponseOptions): void {
  if (request.signal.aborted) { throw abortError(); }
  let current = false;
  try {
    current = !store.locked && typeof options?.isCurrent === 'function' && options.isCurrent() === true;
  } catch {
    // A failing authority predicate never authorizes or exposes its exception.
  }
  if (request.signal.aborted) { throw abortError(); }
  if (!current || store.locked) { throw new UnavailablePrivateImageError(); }
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
  for (const [name, value] of Object.entries(additions)) { headers.set(name, value); }
  return new Response(null, { status, headers });
}

function parseRange(value: string, byteLength: number): ByteRange | undefined {
  if (value.length > 64) { return undefined; }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || byteLength === 0) { return undefined; }
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { start: Math.max(0, byteLength - suffix), endExclusive: byteLength } : undefined;
  }
  const start = Number(match[1]);
  const inclusiveEnd = match[2] ? Number(match[2]) : byteLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(inclusiveEnd)
    || start < 0 || start >= byteLength || inclusiveEnd < start) {
    return undefined;
  }
  return { start, endExclusive: Math.min(inclusiveEnd, byteLength - 1) + 1 };
}

/**
 * Main-process adapter for authenticated, bounded JPEG preview records. The
 * caller must authorize the requested preview and supply its current-session
 * guard. This helper does not register routes or grant filesystem authority.
 *
 * An image is authenticated in full before its length is exposed, including for
 * HEAD and range requests. Its owned plaintext is retained only until the body
 * is pulled, cancelled, aborted, or locked; it is never eagerly enqueued.
 */
export async function createPrivateHubImageResponse(
  store: PrivateHubStore,
  kind: PrivateHubImageKind,
  hash: string,
  request: Request,
  options: PrivateHubImageResponseOptions,
): Promise<Response> {
  let completed = false;
  const complete = (): void => {
    if (completed) { return; }
    completed = true;
    try { void Promise.resolve(options.onComplete?.()).catch(() => undefined); } catch { /* observer only */ }
  };
  if (request.signal.aborted) { complete(); throw abortError(); }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    complete();
    return emptyResponse(405, { 'Allow': 'GET, HEAD' });
  }
  let owned: Buffer | undefined;
  let delivery: Buffer | undefined;
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let rejectOpening: ((error: Error) => void) | undefined;
  const cleanup = (): void => {
    request.signal.removeEventListener('abort', onAbort);
    store.lockSignal.removeEventListener('abort', onLock);
  };
  const stop = (error?: Error): void => {
    if (stopped) { return; }
    stopped = true;
    owned?.fill(0);
    owned = undefined;
    delivery?.fill(0);
    delivery = undefined;
    cleanup();
    complete();
    if (error) {
      rejectOpening?.(error);
      controller?.error(error);
    }
    rejectOpening = undefined;
  };
  const onAbort = (): void => { stop(abortError()); };
  const onLock = (): void => { stop(new UnavailablePrivateImageError()); };
  request.signal.addEventListener('abort', onAbort, { once: true });
  store.lockSignal.addEventListener('abort', onLock, { once: true });
  try {
    assertCurrent(store, request, options);
    if (kind !== 'thumbnail' && kind !== 'filmstrip' && kind !== 'clip-poster') {
      throw new UnavailablePrivateImageError();
    }
    // Resolve with no plaintext value: listeners keep ownership throughout the
    // asynchronous handoff, and an abandoned storage result is erased on arrival.
    await new Promise<void>((resolve, reject) => {
      rejectOpening = reject;
      readPrivateHubPreview(store, kind, hash, PRIVATE_HUB_MAX_IMAGE_BYTES).then(bytes => {
        if (stopped) { bytes.fill(0); return; }
        owned = bytes;
        try {
          assertCurrent(store, request, options);
          rejectOpening = undefined;
          resolve();
        } catch (error) {
          stop(error as Error);
        }
      }, () => { stop(new UnavailablePrivateImageError()); });
    });
    assertCurrent(store, request, options);
    if (stopped || !owned) { throw new UnavailablePrivateImageError(); }

    const byteLength = owned.length;
    const headers = privateHeaders();
    headers.set('Content-Type', 'image/jpeg');
    headers.set('Accept-Ranges', 'bytes');
    let range: ByteRange = { start: 0, endExclusive: byteLength };
    let status = 200;
    // Range applies only to GET. No validators are issued, so If-Range receives
    // the full representation rather than accepting an unknown validator.
    const requestedRange = request.method === 'GET' && !request.headers.has('If-Range')
      ? request.headers.get('Range') : null;
    if (requestedRange !== null) {
      const parsed = parseRange(requestedRange, byteLength);
      if (!parsed) {
        stop();
        assertCurrent(store, request, options);
        return emptyResponse(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${byteLength}` });
      }
      range = parsed;
      status = 206;
      headers.set('Content-Range', `bytes ${range.start}-${range.endExclusive - 1}/${byteLength}`);
    }
    headers.set('Content-Length', String(range.endExclusive - range.start));
    if (request.method === 'HEAD' || byteLength === 0) {
      stop();
      assertCurrent(store, request, options);
      return new Response(null, { status, headers });
    }

    const stream = new ReadableStream<Uint8Array>({
      start: target => { controller = target; },
      pull: target => {
        if (stopped) { return; }
        try {
          assertCurrent(store, request, options);
          if (!owned) { throw new UnavailablePrivateImageError(); }
          // Copy only the requested range, then erase the authenticated record.
          // The response consumer owns this copy after enqueue; subsequent lock
          // cannot revoke bytes that have already crossed that boundary.
          delivery = Buffer.from(owned.subarray(range.start, range.endExclusive));
          owned.fill(0);
          owned = undefined;
          assertCurrent(store, request, options);
          if (stopped || !delivery) { throw new UnavailablePrivateImageError(); }
          target.enqueue(delivery);
          delivery = undefined;
          stop();
          target.close();
        } catch {
          stop(request.signal.aborted ? abortError() : new UnavailablePrivateImageError());
        }
      },
      cancel: () => { stop(); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status, headers });
  } catch {
    stop();
    if (request.signal.aborted) { throw abortError(); }
    return emptyResponse(404);
  }
}
