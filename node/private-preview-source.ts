import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeImageLocationPartialPath } from '../interfaces/media-locations';

export interface PrivatePreviewSourceLocation {
  readonly hash: string;
  readonly root: string;
  readonly partialPath: string;
  readonly fileName: string;
  readonly inputSource: number;
}

export interface PrivatePreviewSourceOptions extends PrivatePreviewSourceLocation {
  /** Trusted main-process check of this exact catalogue location and its source grant. */
  readonly isCurrent: (location: Readonly<PrivatePreviewSourceLocation>) => boolean;
  readonly signal?: AbortSignal;
}

export interface PrivatePreviewSourceLease {
  /** Independently opened, caller-borrowed descriptor. Close only through this lease. */
  readonly fd: number;
  close(): Promise<void>;
}

export interface PrivatePreviewSource {
  readonly hash: string;
  readonly signal: AbortSignal;
  /** Revalidates authority and identity synchronously, including before publication. */
  isCurrent(): boolean;
  open(): Promise<PrivatePreviewSourceLease>;
  close(): Promise<void>;
}

interface OwnedLease {
  handle: FileHandle;
  closing?: Promise<void>;
}

const capturedSources = new WeakSet<object>();
const sourceLocations = new WeakMap<object, Readonly<PrivatePreviewSourceLocation>>();
const cleanupFailures = new WeakSet<object>();

/** Main-only signal that returning to normal mode would leave cleanup unproven. */
export function isPrivatePreviewSourceCleanupFailure(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && cleanupFailures.has(error);
}

/** Reject structural lookalikes before a generator accepts an inherited FD. */
export function isPrivatePreviewSource(value: unknown): value is PrivatePreviewSource {
  return typeof value === 'object' && value !== null && capturedSources.has(value);
}

/** Main-only comparison; the capability never exposes its source path. */
export function privatePreviewSourceMatchesLocation(source: PrivatePreviewSource, location: Readonly<PrivatePreviewSourceLocation>): boolean {
  if (!isPrivatePreviewSource(source)) { return false; }
  const bound = sourceLocations.get(source);
  try {
    return !!bound && !!location && bound.hash === location.hash && bound.inputSource === location.inputSource
      && bound.fileName === location.fileName && typeof location.root === 'string' && path.isAbsolute(location.root)
      && bound.root === path.resolve(location.root)
      && normalizeImageLocationPartialPath(bound.partialPath) === normalizeImageLocationPartialPath(location.partialPath);
  } catch { return false; }
}

function unavailable(): Error { return new Error('Private preview source is unavailable.'); }

function cleanupFailure(): Error {
  const error = unavailable();
  cleanupFailures.add(error);
  return error;
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && sameIdentity(left, right)
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function bindLocation(options: PrivatePreviewSourceOptions): Readonly<PrivatePreviewSourceLocation> {
  if (!options || typeof options.hash !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(options.hash)
    || typeof options.root !== 'string' || options.root.length > 32_768 || !path.isAbsolute(options.root) || options.root.includes('\0')
    || typeof options.partialPath !== 'string' || options.partialPath.length > 16_384 || /[\\\0]/.test(options.partialPath)
    || options.partialPath.split('/').some(segment => segment === '..')
    || typeof options.fileName !== 'string' || options.fileName.length === 0 || options.fileName.length > 4_096
    || /[/\\\0]/.test(options.fileName) || options.fileName === '.' || options.fileName === '..'
    || !Number.isSafeInteger(options.inputSource) || options.inputSource < 0 || typeof options.isCurrent !== 'function'
    || (options.signal !== undefined && (typeof options.signal.addEventListener !== 'function' || typeof options.signal.aborted !== 'boolean'))
    || !fs.constants.O_NOFOLLOW) { throw unavailable(); }
  return Object.freeze({ hash: options.hash, root: path.resolve(options.root), partialPath: options.partialPath,
    fileName: options.fileName, inputSource: options.inputSource });
}

/**
 * Main-process source capability; a hash alone never grants access. The caller
 * must supply an exact-location/session/source-grant predicate. No source path
 * is returned to a child process or included in an error. This does not sandbox
 * decoders or hide an original file from the operating system.
 */
export async function capturePrivatePreviewSource(options: PrivatePreviewSourceOptions): Promise<PrivatePreviewSource> {
  let source: CapturedSource;
  try { source = new CapturedSource(options); }
  catch { throw unavailable(); }
  // Opening once verifies the initial path snapshot against a no-follow FD.
  try {
    const lease = await source.open();
    await lease.close();
    if (!source.isCurrent()) { throw unavailable(); }
    capturedSources.add(source);
    return Object.freeze(source);
  } catch (error) {
    try { await source.close(); }
    catch { throw cleanupFailure(); }
    throw isPrivatePreviewSourceCleanupFailure(error) ? error : unavailable();
  }
}

class CapturedSource implements PrivatePreviewSource {
  readonly #location: Readonly<PrivatePreviewSourceLocation>;
  readonly #predicate: PrivatePreviewSourceOptions['isCurrent'];
  readonly #externalSignal: AbortSignal | undefined;
  readonly #controller = new AbortController();
  readonly #filePath: string;
  readonly #root: fs.BigIntStats;
  readonly #file: fs.BigIntStats;
  readonly #leases = new Set<OwnedLease>();
  readonly #pending = new Set<Promise<OwnedLease>>();
  #slots = 0;
  #revoked = false;
  #checking = false;
  #cleanupFailed = false;

  constructor(options: PrivatePreviewSourceOptions) {
    this.#location = bindLocation(options);
    this.#predicate = options.isCurrent;
    this.#externalSignal = options.signal;
    if (!this.authorized()) { throw unavailable(); }
    // Historical catalogue paths start with '/'; they are always root-relative.
    this.#filePath = path.resolve(this.#location.root, this.#location.partialPath.replace(/^\/+/, ''), this.#location.fileName);
    const relative = path.relative(this.#location.root, this.#filePath);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { throw unavailable(); }
    this.#root = fs.lstatSync(this.#location.root, { bigint: true });
    this.#file = fs.lstatSync(this.#filePath, { bigint: true });
    if (!this.#root.isDirectory() || this.#root.isSymbolicLink() || !this.#file.isFile() || this.#file.isSymbolicLink()
      || this.#file.size < 0n || fs.realpathSync.native(this.#location.root) !== this.#location.root
      || fs.realpathSync.native(this.#filePath) !== this.#filePath) { throw unavailable(); }
    this.#externalSignal?.addEventListener('abort', this.onAbort, { once: true });
    if (!this.isCurrent()) { throw unavailable(); }
    sourceLocations.set(this, this.#location);
  }

  get hash(): string { return this.#location.hash; }
  get signal(): AbortSignal { return this.#controller.signal; }

  private authorized(): boolean {
    if (this.#revoked || this.#externalSignal?.aborted || this.#checking) { return false; }
    this.#checking = true;
    try { return this.#predicate(this.#location) === true && !this.#revoked && !this.#externalSignal?.aborted; }
    catch { return false; }
    finally { this.#checking = false; }
  }

  isCurrent(): boolean {
    try {
      if (!this.authorized()) { throw unavailable(); }
      const root = fs.lstatSync(this.#location.root, { bigint: true });
      const file = fs.lstatSync(this.#filePath, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || !sameIdentity(this.#root, root) || !sameFile(this.#file, file)
        || fs.realpathSync.native(this.#location.root) !== this.#location.root
        || fs.realpathSync.native(this.#filePath) !== this.#filePath || !this.authorized()) { throw unavailable(); }
      return true;
    } catch {
      this.revoke();
      return false;
    }
  }

  private readonly onAbort = (): void => { this.revoke(); };

  private revoke(): void {
    if (this.#revoked) { return; }
    this.#revoked = true;
    this.#externalSignal?.removeEventListener('abort', this.onAbort);
    // Children observe cancellation before parent-owned descriptors are closed.
    this.#controller.abort(unavailable());
    for (const lease of this.#leases) { void this.closeLease(lease).catch(() => undefined); }
  }

  open(): Promise<PrivatePreviewSourceLease> {
    if (!this.isCurrent() || this.#slots >= 2) { return Promise.reject(unavailable()); }
    this.#slots++;
    const opening = this.openLease();
    this.#pending.add(opening);
    return opening.finally(() => { this.#pending.delete(opening); }).then(lease => {
      if (!this.isCurrent()) { throw unavailable(); }
      return Object.freeze({ fd: lease.handle.fd, close: () => this.closeLease(lease) });
    });
  }

  private async openLease(): Promise<OwnedLease> {
    let handle: FileHandle | undefined;
    try {
      // A path replaced with a FIFO must not leave an uncancellable blocking
      // open in the worker pool. Regular files retain their normal semantics.
      handle = await fs.promises.open(this.#filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!this.isCurrent()) { throw unavailable(); }
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(this.#file, opened) || !this.isCurrent()) { throw unavailable(); }
      const lease: OwnedLease = { handle };
      this.#leases.add(lease);
      return lease;
    } catch {
      this.revoke();
      try { await handle?.close(); }
      catch {
        // No lease reached the set, so retain failure separately for close().
        this.#cleanupFailed = true;
      }
      this.#slots--;
      throw this.#cleanupFailed ? cleanupFailure() : unavailable();
    }
  }

  private closeLease(lease: OwnedLease): Promise<void> {
    if (!lease.closing) {
      lease.closing = Promise.resolve().then(() => lease.handle.close()).then(() => {
        this.#leases.delete(lease);
        this.#slots--;
      }, () => { this.#cleanupFailed = true; this.revoke(); throw cleanupFailure(); });
    }
    return lease.closing;
  }

  async close(): Promise<void> {
    this.revoke();
    await Promise.allSettled([...this.#pending]);
    const results = await Promise.allSettled([...this.#leases].map(lease => this.closeLease(lease)));
    if (this.#cleanupFailed || results.some(result => result.status === 'rejected')) { throw cleanupFailure(); }
  }
}
