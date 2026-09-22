import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { getMediaToolPath } from './media-tool-paths';

export interface PrivateMediaProcessOptions {
  tool: 'ffmpeg' | 'ffprobe';
  /** Fixed main-process plans only. Never pass renderer arguments through here. */
  args: readonly string[];
  /** Caller-owned, already-authorized open source file; inherited by the child as FD 3. */
  sourceFd?: number;
  /** Producer-owned bytes. The producer must erase its own plaintext on cancellation. */
  input?: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
  isCurrent: () => boolean;
  maximumBytes: number;
  timeoutMs: number;
}

export const PRIVATE_MEDIA_PROCESS_CHUNK_BYTES = 64 * 1024;
const MAX_INPUT_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const KILL_GRACE_MS = 250;
const REAP_LIMIT_MS = 1_000;
const cleanupFailures = new WeakSet<object>();

function unavailable(): Error { return new Error('Private media generation failed.'); }

/** Main-only proof that child closure was not established; never trust error text. */
export function isPrivateMediaProcessCleanupFailure(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && cleanupFailures.has(error);
}

function cleanupFailure(): Error {
  const error = unavailable();
  cleanupFailures.add(error);
  return error;
}

const flagOptions = new Set(['-nostdin', '-hide_banner', '-an', '-sn', '-dn']);
const values: Record<string, (value: string) => boolean> = {
  '-loglevel': value => value === 'error', '-v': value => value === 'error',
  '-threads': value => value === '1', '-filter_threads': value => value === '1', '-filter_complex_threads': value => value === '1',
  '-max_alloc': value => value === '268435456',
  '-protocol_whitelist': value => value === 'fd,pipe', '-fd': value => value === '3',
  '-ss': value => /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 1_000_000_000,
  '-t': value => /^\d+(?:\.\d+)?$/.test(value) && Number(value) > 0 && Number(value) <= 86_400,
  '-map': value => ['0:V:0', '0:v:0', '0:a:0', '0:a:0?', '0:v', '0:a?'].includes(value),
  '-map_metadata': value => value === '-1', '-map_metadata:s': value => value === '-1', '-map_chapters': value => value === '-1',
  '-metadata': value => value === 'encoder=', '-metadata:s:v': value => ['encoder=', 'rotate=0'].includes(value),
  '-fflags': value => value === '+bitexact', '-flags:v': value => value === '+bitexact',
  '-c:v': value => ['mjpeg', 'libx264', 'copy'].includes(value), '-c:a': value => ['aac', 'copy'].includes(value),
  '-c': value => value === 'copy', '-preset': value => value === 'veryfast',
  '-q:v': value => /^(?:[2-9]|[12]\d|3[01])$/.test(value),
  '-crf': value => /^\d{1,2}$/.test(value) && Number(value) <= 51,
  '-pix_fmt': value => ['yuv420p', 'yuvj420p'].includes(value),
  '-b:a': value => value === '96k', '-ac': value => value === '2', '-ar': value => value === '48000',
  '-frames:v': value => value === '1', '-framerate': value => value === '1',
  '-bf': value => value === '0', '-g': value => value === '30', '-r': value => value === '30',
  '-output_ts_offset': value => /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= 86_400,
  '-avoid_negative_ts': value => ['make_zero', 'disabled'].includes(value), '-muxdelay': value => value === '0', '-muxpreload': value => value === '0',
  '-mpegts_copyts': value => value === '1', '-bsf:a': value => value === 'aac_adtstoasc',
  '-mpegts_flags': value => value === '+resend_headers+initial_discontinuity', '-write_tmcd': value => value === '0',
  '-f': value => ['image2pipe', 'mpegts', 'mp4'].includes(value),
  '-movflags': value => ['+frag_keyframe+empty_moov+default_base_moof', '+frag_keyframe+empty_moov+default_base_moof+disable_chpl'].includes(value),
  '-of': value => value === 'json',
  '-show_entries': value => ['format=duration:stream=codec_type,width,height,duration',
    'format=duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic'].includes(value),
  // These four filters do not open files. Disallow filter graphs, movie/subtitle
  // sources, scripts, quotes, escapes and arbitrary filter names entirely.
  '-vf': value => value.split(',').every(filter => /^(?:scale|pad|setsar|tile)=[a-zA-Z0-9_:.=()+*/ -]+$/.test(filter)),
};

function validate(options: PrivateMediaProcessOptions): void {
  if (!['ffmpeg', 'ffprobe'].includes(options.tool) || !Array.isArray(options.args) || options.args.length > 128
    || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1 || options.maximumBytes > MAX_OUTPUT_BYTES
    || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 3_600_000
    || !options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.isCurrent !== 'function'
    || (options.sourceFd === undefined) === (options.input === undefined)
    || (options.sourceFd !== undefined && (!Number.isSafeInteger(options.sourceFd) || options.sourceFd < 3))
    || (options.input !== undefined && typeof options.input[Symbol.asyncIterator] !== 'function')) {
    throw unavailable();
  }
  let inputs = 0;
  let outputs = 0;
  let descriptors = 0;
  let whitelist = false;
  for (let index = 0; index < options.args.length; index++) {
    const argument = options.args[index];
    if (typeof argument !== 'string' || argument.length > 1_024 || argument.includes('\0')) { throw unavailable(); }
    if (argument === 'pipe:1') {
      if (options.tool !== 'ffmpeg' || index !== options.args.length - 1) { throw unavailable(); }
      outputs++;
      continue;
    }
    if (argument === '-i') {
      if (!whitelist || ++inputs !== 1 || options.args[++index] !== (options.sourceFd === undefined ? 'pipe:0' : 'fd:')) {
        throw unavailable();
      }
      continue;
    }
    if (flagOptions.has(argument)) { continue; }
    const value = options.args[++index];
    if (typeof value !== 'string' || value.length > 1_024 || !Object.hasOwn(values, argument) || !values[argument](value)) {
      throw unavailable();
    }
    if (argument === '-fd') { if (inputs > 0 || ++descriptors !== 1) { throw unavailable(); } }
    if (argument === '-protocol_whitelist') { whitelist = true; }
  }
  if (inputs !== 1 || outputs !== (options.tool === 'ffmpeg' ? 1 : 0)
    || descriptors !== (options.sourceFd === undefined ? 0 : 1)) { throw unavailable(); }
}

/**
 * Lazy, main-process-only decoder runner. Successful iteration ends only after
 * stdout has drained and the child has closed with exit code zero. Chunks yielded
 * before that point are provisional: callers must not publish their encrypted
 * manifest until iteration completes successfully. Yielded buffers belong to
 * the consumer; the runner erases only bytes it still owns.
 */
export function streamPrivateMediaProcess(options: PrivateMediaProcessOptions): AsyncIterableIterator<Buffer> {
  return new PrivateMediaProcess({ ...options, args: Array.isArray(options.args) ? [...options.args] : options.args });
}

class PrivateMediaProcess implements AsyncIterableIterator<Buffer> {
  readonly #options: PrivateMediaProcessOptions;
  #child: childProcess.ChildProcess | undefined;
  #stdout: Readable | undefined;
  #stdin: Writable | undefined;
  #producer: AsyncIterator<Uint8Array> | undefined;
  #started = false;
  #closed = false;
  #outputEnded = false;
  #inputComplete: boolean;
  #done = false;
  #returned = false;
  #failure: Error | undefined;
  #cleanupFailure: Error | undefined;
  #nextPending = false;
  #total = 0;
  #owned: Buffer | undefined;
  readonly #writes = new Set<Buffer>();
  #wake: (() => void) | undefined;
  readonly #interrupts = new Set<() => void>();
  #closeWake: () => void;
  readonly #closing: Promise<void>;
  #termination: Promise<void> | undefined;
  #timeout: NodeJS.Timeout | undefined;
  #poll: NodeJS.Timeout | undefined;
  #forceKill: NodeJS.Timeout | undefined;
  #deadline: number | undefined;

  constructor(options: PrivateMediaProcessOptions) {
    this.#options = options;
    this.#inputComplete = options.input === undefined;
    this.#closing = new Promise(resolve => { this.#closeWake = resolve; });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> { return this; }

  next(): Promise<IteratorResult<Buffer>> {
    if (this.#cleanupFailure) { return Promise.reject(this.#cleanupFailure); }
    if (this.#nextPending) { return Promise.reject(unavailable()); }
    if (this.#done || this.#returned) { return Promise.resolve({ done: true, value: undefined }); }
    this.#nextPending = true;
    const reading = this.readNext().catch(async () => {
      this.fail();
      await this.reap();
      if (this.#returned) { return { done: true as const, value: undefined }; }
      throw unavailable();
    });
    return reading.then(result => {
      if (this.#returned) {
        this.#owned?.fill(0);
        this.#owned = undefined;
        return this.reap().then(() => ({ done: true as const, value: undefined }));
      }
      try {
        this.assertCurrent();
        if (result.done) {
          this.#done = true;
          this.#nextPending = false;
          return { done: true as const, value: undefined };
        }
        const bytes = this.#owned;
        if (!bytes) { throw unavailable(); }
        this.#owned = undefined;
        this.#nextPending = false;
        return { done: false as const, value: bytes };
      } catch {
        this.fail();
        return this.reap().then(() => { this.#nextPending = false; throw unavailable(); });
      }
    }, error => { throw isPrivateMediaProcessCleanupFailure(error) ? error : unavailable(); })
      .finally(() => { this.#nextPending = false; });
  }

  async return(): Promise<IteratorResult<Buffer>> {
    if (this.#cleanupFailure) { throw this.#cleanupFailure; }
    if (!this.#done) {
      this.#returned = true;
      this.fail();
      await this.reap();
    }
    return { done: true, value: undefined };
  }

  async throw(): Promise<IteratorResult<Buffer>> {
    await this.return();
    throw unavailable();
  }

  private assertCurrent(): void {
    let current = false;
    try { current = !this.#failure && !this.#options.signal.aborted && this.#options.isCurrent() === true; }
    catch { /* Never expose callback exceptions or their source paths. */ }
    if (!current || this.#failure || this.#options.signal.aborted
      || (this.#deadline !== undefined && Date.now() >= this.#deadline)) { throw unavailable(); }
  }

  private readonly onAbort = (): void => { this.fail(); };

  private start(): void {
    if (this.#started) { return; }
    this.#started = true;
    validate(this.#options);
    this.assertCurrent();
    this.#deadline = Date.now() + this.#options.timeoutMs;
    const executable = getMediaToolPath(this.#options.tool);
    this.#child = childProcess.spawn(executable, [...this.#options.args], {
      cwd: path.dirname(executable),
      shell: false,
      detached: false,
      windowsHide: true,
      // An allowlist prevents FFREPORT, dynamic-loader injection, proxy/config
      // variables and inherited source directories from reaching the decoder.
      env: { LANG: 'C', LC_ALL: 'C', AV_LOG_FORCE_NOCOLOR: '1' },
      stdio: [this.#options.input ? 'pipe' : 'ignore', 'pipe', 'ignore', this.#options.sourceFd ?? 'ignore'],
    });
    const child = this.#child;
    child.on('error', () => { this.fail(); });
    child.once('close', (code, signal) => {
      this.#closed = true;
      clearTimeout(this.#forceKill);
      this.#closeWake();
      if (code !== 0 || signal !== null || !this.#inputComplete) { this.fail(); }
      this.wake();
    });
    this.#stdout = child.stdout ?? undefined;
    this.#stdin = child.stdin ?? undefined;
    if (!this.#stdout || (this.#options.input && !this.#stdin)) { throw unavailable(); }
    this.#stdout.on('error', () => { this.fail(); });
    this.#stdout.on('readable', () => { this.wake(); });
    this.#stdout.once('end', () => { this.#outputEnded = true; this.wake(); });
    this.#stdin?.on('error', () => { this.fail(); });
    this.#options.signal.addEventListener('abort', this.onAbort, { once: true });
    this.#timeout = setTimeout(() => { this.fail(); }, this.#options.timeoutMs);
    this.#poll = setInterval(() => {
      try { this.assertCurrent(); } catch { this.fail(); }
    }, 25);
    this.assertCurrent();
    if (this.#options.input) {
      this.#producer = this.#options.input[Symbol.asyncIterator]();
      void this.pumpInput().catch(() => { this.fail(); });
    }
  }

  private async readNext(): Promise<IteratorResult<never>> {
    this.start();
    while (true) {
      if (this.#returned) { return { done: true, value: undefined }; }
      this.assertCurrent();
      const available = this.#stdout!.readableLength;
      if (available > 0) {
        const bytes: unknown = this.#stdout!.read(Math.min(available, PRIVATE_MEDIA_PROCESS_CHUNK_BYTES));
        if (!Buffer.isBuffer(bytes)) { throw unavailable(); }
        this.#owned = bytes;
        this.#total += bytes.length;
        if (bytes.length > PRIVATE_MEDIA_PROCESS_CHUNK_BYTES || this.#total > this.#options.maximumBytes) { throw unavailable(); }
        this.assertCurrent();
        return { done: false, value: undefined as never };
      }
      // Trigger EOF/readable processing even when read() has no bytes yet.
      this.#stdout!.read(0);
      if (this.#outputEnded && this.#closed) {
        if (this.#total === 0) { throw unavailable(); }
        this.cleanup();
        return { done: true, value: undefined };
      }
      await new Promise<void>(resolve => { this.#wake = resolve; });
    }
  }

  private wake(): void { const wake = this.#wake; this.#wake = undefined; wake?.(); }

  private async interrupted<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const interrupt = (): void => { reject(unavailable()); };
      this.#interrupts.add(interrupt);
      operation.then(value => {
        this.#interrupts.delete(interrupt);
        resolve(value);
      }, () => {
        this.#interrupts.delete(interrupt);
        reject(unavailable());
      });
      if (this.#failure) { this.#interrupts.delete(interrupt); interrupt(); }
    });
  }

  private async pumpInput(): Promise<void> {
    while (true) {
      this.assertCurrent();
      const next = await this.interrupted(Promise.resolve(this.#producer!.next()));
      this.assertCurrent();
      if (next.done) {
        this.#inputComplete = true;
        this.#stdin!.end();
        return;
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0 || next.value.byteLength > MAX_INPUT_CHUNK_BYTES) { throw unavailable(); }
      for (let offset = 0; offset < next.value.byteLength; offset += PRIVATE_MEDIA_PROCESS_CHUNK_BYTES) {
        this.assertCurrent();
        const bytes = Buffer.from(next.value.subarray(offset, offset + PRIVATE_MEDIA_PROCESS_CHUNK_BYTES));
        this.#writes.add(bytes);
        try {
          await this.interrupted(new Promise<void>((resolve, reject) => {
            this.#stdin!.write(bytes, error => { if (error) { reject(unavailable()); } else { resolve(); } });
          }));
        } finally { bytes.fill(0); this.#writes.delete(bytes); }
      }
    }
  }

  private cleanup(): void {
    clearTimeout(this.#timeout);
    clearInterval(this.#poll);
    this.#options.signal?.removeEventListener?.('abort', this.onAbort);
  }

  private fail(): void {
    if (this.#failure || this.#done) { return; }
    this.#failure = unavailable();
    this.cleanup();
    this.#owned?.fill(0);
    this.#owned = undefined;
    for (const bytes of this.#writes) { bytes.fill(0); }
    for (const interrupt of this.#interrupts) { interrupt(); }
    this.#interrupts.clear();
    this.wake();
    try { void Promise.resolve(this.#producer?.return?.()).catch(() => undefined); }
    catch { /* A faulty producer cannot keep the decoder alive. */ }
    // Drain and erase the bounded readable queue before destroying its pipe.
    if (this.#stdout) {
      while (this.#stdout.readableLength > 0) {
        const bytes: unknown = this.#stdout.read(Math.min(this.#stdout.readableLength, PRIVATE_MEDIA_PROCESS_CHUNK_BYTES));
        if (!Buffer.isBuffer(bytes)) { break; }
        bytes.fill(0);
      }
      this.#stdout.destroy();
    }
    this.#stdin?.destroy();
    if (this.#child && !this.#closed) {
      try { this.#child.kill('SIGTERM'); } catch { /* Escalation still follows. */ }
      this.#forceKill = setTimeout(() => {
        if (!this.#closed) { try { this.#child!.kill('SIGKILL'); } catch { /* Reap remains bounded. */ } }
      }, KILL_GRACE_MS);
    }
  }

  private reap(): Promise<void> {
    if (this.#cleanupFailure) { return Promise.reject(this.#cleanupFailure); }
    if (!this.#child || this.#closed) { return Promise.resolve(); }
    if (!this.#termination) {
      this.#termination = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!this.#closed) { try { this.#child!.kill('SIGKILL'); } catch { /* No detached retry process. */ } }
          if (this.#closed) { resolve(); return; }
          // A sent signal, exit event, or elapsed timeout cannot prove that the
          // decoder released its inherited source descriptor. Keep this failure
          // sticky even if a late close arrives after the caller quarantines.
          this.#cleanupFailure = cleanupFailure();
          reject(this.#cleanupFailure);
        }, REAP_LIMIT_MS);
        void this.#closing.then(() => { clearTimeout(timer); resolve(); });
      });
    }
    return this.#termination;
  }
}
