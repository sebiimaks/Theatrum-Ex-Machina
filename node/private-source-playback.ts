import { randomBytes } from 'node:crypto';
import {
  isPrivatePreviewSource, isPrivatePreviewSourceCleanupFailure,
  type PrivatePreviewSource, type PrivatePreviewSourceLease,
} from './private-preview-source';

export type PrivateSourcePlaybackContentType = 'video/mp4' | 'video/webm' | 'video/ogg' | 'video/quicktime';
const PREFIX = 'theatrum://app/original/';
const CHUNK_BYTES = 256 * 1024;
const CLEANUP_TIMEOUT_MS = 5_000;
const CONTENT_TYPES = new Set<PrivateSourcePlaybackContentType>(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);

export function isPrivateSourcePlaybackUrl(url: string): boolean {
  return typeof url === 'string' && /^theatrum:\/\/app\/original\/[a-f0-9]{64}$/.test(url);
}
export function privateSourcePlaybackType(fileName: string): PrivateSourcePlaybackContentType | undefined {
  if (typeof fileName !== 'string' || fileName.length > 4_096 || /[/\\\0]/.test(fileName)) { return; }
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1].toLowerCase();
  if (extension === 'mp4' || extension === 'm4v') { return 'video/mp4'; }
  if (extension === 'mov') { return 'video/quicktime'; }
  if (extension === 'webm') { return 'video/webm'; }
  if (extension === 'ogv' || extension === 'ogg') { return 'video/ogg'; }
}
interface Options { signal: AbortSignal; isCurrent: () => boolean; onFailure: () => void }
interface Operation { stop: () => Promise<void>; done: Promise<void> }
interface Playback {
  source: PrivatePreviewSource;
  url: string;
  type: PrivateSourcePlaybackContentType;
  controller: AbortController;
  operations: Set<Operation>;
  sourceAborted: () => void;
  retired: boolean;
  closing?: Promise<void>;
}
function unavailable(): Error { return new Error('Private video is unavailable.'); }
function headers(): Headers {
  return new Headers({ 'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' });
}
function empty(status: number, additions: Record<string, string> = {}): Response {
  const result = headers();
  result.set('Content-Length', '0');
  for (const [name, value] of Object.entries(additions)) { result.set(name, value); }
  return new Response(null, { status, headers: result });
}
function range(value: string, size: number): { start: number; end: number } | undefined {
  if (value.length > 64 || size === 0) { return; }
  const parts = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!parts || (!parts[1] && !parts[2])) { return; }
  if (!parts[1]) {
    const suffix = Number(parts[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) { return; }
    return { start: Math.max(0, size - suffix), end: size };
  }
  const start = Number(parts[1]);
  const end = parts[2] ? Number(parts[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) { return; }
  return { start, end: Math.min(end, size - 1) + 1 };
}

/** One explicit original-video capability per private browser. No source paths enter its URLs or responses. */
export class PrivateSourcePlayback {
  readonly #options: Options;
  readonly #entries = new Set<Playback>();
  #active: Playback | undefined;
  #epoch = 0;
  #disposed = false;
  #failed = false;
  #checking = false;

  constructor(options: Options) {
    if (!(options?.signal instanceof AbortSignal) || typeof options.isCurrent !== 'function'
      || typeof options.onFailure !== 'function') { throw unavailable(); }
    this.#options = options;
    options.signal.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal.aborted) { this.#disposed = true; }
  }
  private readonly onAbort = (): void => { void this.dispose().catch(() => undefined); };
  private fail(): void {
    if (this.#failed) { return; }
    this.#failed = true;
    this.#active = undefined;
    this.#epoch++;
    for (const entry of this.#entries) { void this.retire(entry).catch(() => undefined); }
    try { this.#options.onFailure(); } catch { /* Cleanup remains permanently unproven. */ }
  }
  private current(): boolean {
    if (this.#disposed || this.#failed || this.#options.signal.aborted || this.#checking) { return false; }
    this.#checking = true;
    try { return this.#options.isCurrent() === true && !this.#disposed && !this.#failed && !this.#options.signal.aborted; }
    catch { return false; }
    finally { this.#checking = false; }
  }
  private entryCurrent(entry: Playback): boolean {
    try {
      return !entry.retired && this.#active === entry && this.current() && entry.source.isCurrent()
        && !entry.retired && this.#active === entry && this.current();
    } catch { return false; }
  }
  private boundedCleanup(work: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(); reject(unavailable()); }, CLEANUP_TIMEOUT_MS);
      work.then(() => {
        clearTimeout(timer);
        if (this.#failed) { reject(unavailable()); } else { resolve(); }
      }, () => { clearTimeout(timer); this.fail(); reject(unavailable()); });
    });
  }
  private retire(entry: Playback): Promise<void> {
    if (entry.closing) { return entry.closing; }
    // Publish the drain before aborting, because source/stream callbacks may reenter.
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    entry.closing = this.boundedCleanup(completion);
    void entry.closing.catch(() => undefined);
    entry.retired = true;
    if (this.#active === entry) { this.#active = undefined; }
    entry.source.signal.removeEventListener('abort', entry.sourceAborted);
    entry.controller.abort(unavailable());
    const drains = [...entry.operations].map(operation => operation.stop());
    try { drains.push(entry.source.close()); } catch { drains.push(Promise.reject(unavailable())); }
    void Promise.allSettled(drains).then(results => {
      this.#entries.delete(entry);
      if (results.some(result => result.status === 'rejected')) { reject(unavailable()); }
      else { resolve(); }
    });
    return entry.closing;
  }

  /** Ownership transfers on invocation, including unsuccessful starts. */
  async start(source: PrivatePreviewSource, type: PrivateSourcePlaybackContentType): Promise<string> {
    if (!isPrivatePreviewSource(source)) { throw unavailable(); }
    const epoch = ++this.#epoch;
    this.#active = undefined;
    const previous = [...this.#entries].map(entry => this.retire(entry));
    const entry: Playback = { source, type, url: PREFIX + randomBytes(32).toString('hex'), controller: new AbortController(),
      operations: new Set(), retired: false, sourceAborted: () => { void this.retire(entry).catch(() => undefined); } };
    this.#entries.add(entry);
    source.signal.addEventListener('abort', entry.sourceAborted, { once: true });
    try {
      await Promise.all(previous);
      if (epoch !== this.#epoch || !this.current() || !CONTENT_TYPES.has(type) || !source.isCurrent()
        || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0 || entry.retired) { throw unavailable(); }
      this.#active = entry;
      if (!this.entryCurrent(entry)) { throw unavailable(); }
      return entry.url;
    } catch {
      await this.retire(entry);
      throw unavailable();
    }
  }

  /** Revoke tokens and delivery synchronously; resolve only after descriptors and reads drain. */
  stop(): Promise<void> {
    this.#epoch++;
    this.#active = undefined;
    const drains = [...this.#entries].map(entry => this.retire(entry));
    return Promise.all(drains).then(() => { if (this.#failed) { throw unavailable(); } });
  }
  dispose(): Promise<void> {
    this.#disposed = true;
    this.#options.signal.removeEventListener('abort', this.onAbort);
    return this.stop();
  }

  async createResponse(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') { return empty(405, { Allow: 'GET, HEAD' }); }
    const entry = this.#active;
    if (!entry || request.signal.aborted || !isPrivateSourcePlaybackUrl(request.url) || request.url !== entry.url) { return empty(404); }
    if (!this.entryCurrent(entry)) { void this.retire(entry).catch(() => undefined); return empty(404); }
    const size = entry.source.byteLength;
    let selected = { start: 0, end: size };
    let status = 200;
    const requested = request.method === 'GET' && !request.headers.has('If-Range') ? request.headers.get('Range') : null;
    if (requested !== null) {
      const parsed = range(requested, size);
      if (!parsed) {
        return this.entryCurrent(entry) && !request.signal.aborted
          ? empty(416, { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` }) : empty(404);
      }
      selected = parsed; status = 206;
    }
    const resultHeaders = headers();
    resultHeaders.set('Content-Type', entry.type);
    resultHeaders.set('Accept-Ranges', 'bytes');
    resultHeaders.set('Content-Length', String(selected.end - selected.start));
    if (status === 206) { resultHeaders.set('Content-Range', `bytes ${selected.start}-${selected.end - 1}/${size}`); }
    if (request.method === 'HEAD' || size === 0) {
      return this.entryCurrent(entry) && !request.signal.aborted ? new Response(null, { status, headers: resultHeaders }) : empty(404);
    }
    if (entry.operations.size >= 2) { return empty(503); }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void done.catch(() => undefined);
    let stopped = false;
    let opening: Promise<PrivatePreviewSourceLease> | undefined;
    let lease: PrivatePreviewSourceLease | undefined;
    let owned: Buffer | undefined;
    let target: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closing: Promise<void> | undefined;
    const finish = (error?: Error): Promise<void> => {
      if (closing) { return done; }
      stopped = true;
      owned?.fill(0); owned = undefined;
      request.signal.removeEventListener('abort', aborted);
      entry.controller.signal.removeEventListener('abort', aborted);
      if (error) { try { target?.error(error); } catch { /* Already cancelled by Chromium. */ } }
      closing = Promise.resolve().then(async () => {
        try { await opening; }
        catch (failure) { if (isPrivatePreviewSourceCleanupFailure(failure)) { throw unavailable(); } }
        await lease?.close();
      }).then(() => { entry.operations.delete(operation); resolve(); }, () => {
        entry.operations.delete(operation); reject(unavailable()); this.fail();
      });
      return done;
    };
    const aborted = (): void => { void finish(unavailable()).catch(() => undefined); };
    const operation: Operation = { stop: () => finish(unavailable()), done };
    const authorized = (): boolean => !stopped && !request.signal.aborted && !entry.controller.signal.aborted && this.entryCurrent(entry);
    entry.operations.add(operation);
    request.signal.addEventListener('abort', aborted, { once: true });
    entry.controller.signal.addEventListener('abort', aborted, { once: true });
    try {
      if (!authorized()) { throw unavailable(); }
      opening = entry.source.open().then(value => { lease = value; return value; });
      await opening;
      if (!authorized()) { throw unavailable(); }
      let position = selected.start;
      const stream = new ReadableStream<Uint8Array>({
        start: controller => { target = controller; },
        pull: async controller => {
          try {
            if (!authorized()) { throw unavailable(); }
            owned = await lease!.read(position, Math.min(CHUNK_BYTES, selected.end - position));
            if (!authorized()) { throw unavailable(); }
            position += owned.length;
            controller.enqueue(owned); owned = undefined;
            if (position === selected.end) { controller.close(); void finish().catch(() => undefined); }
          } catch {
            owned?.fill(0); owned = undefined;
            void finish(unavailable()).catch(() => undefined);
          }
        },
        cancel: () => finish(),
      }, { highWaterMark: 0 });
      if (!authorized()) { void stream.cancel().catch(() => undefined); throw unavailable(); }
      return new Response(stream, { status, headers: resultHeaders });
    } catch {
      await finish();
      return empty(404);
    }
  }
}
