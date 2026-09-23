import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPrivateHubPassword } from '../interfaces/private-hub-credentials';
import { PrivateHubLease, isPrivateHubLeaseCleanupFailure } from './private-hub-lock';
import { createPrivateTouchIdCleanupFailure, isPrivateTouchIdCleanupFailure, type PrivateTouchIdProvider } from './private-touch-id';

import {
  changePrivateHubPassword,
  createPrivateHub,
  createPrivateHubTouchIdSecret,
  decryptPrivateHubRecord,
  encryptPrivateHubRecord,
  PRIVATE_HUB_MAX_HEADER_BYTES,
  PRIVATE_HUB_MAX_SEALED_RECORD_BYTES,
  PRIVATE_HUB_RECORD_OVERHEAD_BYTES,
  privateHubTouchIdIdentity,
  unlockPrivateHub,
  unlockPrivateHubWithTouchId,
  validatePrivateHubHeader,
} from './private-hub-crypto';

export const PRIVATE_HUB_HEADER_FILE = 'private-hub.json';

// A process may own only one session for a directory, including while locking.
// A separate filesystem lease arbitrates other cooperating local processes.
const activeDirectories = new Set<string>();
const quarantinedDirectories = new Map<string, Error>();
const CLEANUP_TIMEOUT_MS = 5000;
const cleanupFailures = new WeakSet<object>();

function cleanupFailure(): Error {
  const error = new Error('Private hub storage cleanup could not be confirmed.');
  cleanupFailures.add(error);
  return error;
}

/** Main must not restore normal admission or reuse a store after this failure. */
export function isPrivateHubStoreCleanupFailure(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && cleanupFailures.has(error);
}

interface Snapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface Candidate {
  bytes: Buffer;
  snapshot: Snapshot;
  pending?: { filePath: string; snapshot: Snapshot };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameFile(left: Snapshot, right: Snapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: Snapshot, right: Snapshot): boolean {
  return sameFile(left, right) && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function directorySnapshot(directory: string): Promise<fs.Stats> {
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || await fs.promises.realpath(directory) !== directory) {
    throw new Error('Private hub directories must be canonical directories without symbolic links.');
  }
  return stats;
}

async function fileSnapshot(filePath: string): Promise<fs.Stats | undefined> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error('Private hub files must be regular files without symbolic or hard links.');
    }
    return stats;
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Main-process storage foundation. Record IDs never become path segments, and
 * only authenticated ciphertext is written to record, backup, or staging files.
 *
 * This does not migrate existing hubs, provide streaming clip playback, or
 * defend against another process replacing directory ancestors between system
 * calls. A native advisory lock arbitrates cooperating local processes; full
 * directory-relative media operations are a separate milestone.
 */
export class PrivateHubStore {
  readonly directory: string;
  readonly hubId: string;
  #key: Buffer;
  #root: Snapshot;
  #header: Snapshot | undefined;
  #locked = false;
  #queue: Promise<unknown> = Promise.resolve();
  #lockCompletion: Promise<void> | undefined;
  #queuedOperations = 0;
  #queuedWriteBytes = 0;
  #changingPassword = false;
  #touchIdDrain: Promise<void> | undefined;
  #touchIdCleanupFailed = false;
  #cleanupFailure: Error | undefined;
  #lease: PrivateHubLease | undefined;
  readonly #lockController = new AbortController();

  private constructor(directory: string, root: Snapshot, hubId: string, key: Buffer) {
    this.directory = directory;
    this.hubId = hubId;
    this.#root = root;
    this.#key = key;
  }

  /** Create a new directory only; an existing directory is never adopted. */
  static async create(directoryPath: string, password: string): Promise<PrivateHubStore> {
    const directory = path.resolve(directoryPath);
    await directorySnapshot(path.dirname(directory));
    const { header, key } = await createPrivateHub(password);
    let store: PrivateHubStore | undefined;
    try {
      await fs.promises.mkdir(directory, { mode: 0o700 });
      const root = await directorySnapshot(directory);
      PrivateHubStore.reserve(directory);
      store = new PrivateHubStore(directory, root, header.hubId, key);
      store.attachLease(await PrivateHubLease.acquire(directory));
      // Startup owns file handles too. A lease-loss lock must drain them before
      // releasing either the OS lease or this process's directory reservation.
      await store.enqueue(async () => {
        const bytes = Buffer.from(JSON.stringify(header), 'utf8');
        if (bytes.length > PRIVATE_HUB_MAX_HEADER_BYTES) {
          throw new Error('The private hub header exceeds its size limit.');
        }
        await store.commitFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), bytes, undefined);
        const published = await store.readFile(
          path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES,
        );
        if (!published.bytes.equals(bytes)) {
          throw new Error('The newly created private hub header changed before verification.');
        }
        store.#header = published.snapshot;
      });
      store.assertUnlocked();
      return store;
    } catch (error) {
      key.fill(0);
      store?.retainCleanupFailure(error);
      await store?.lock();
      // An interrupted creation can leave an incomplete encrypted directory.
      // Never recursively delete it or adopt it on a subsequent create attempt.
      throw error;
    }
  }

  /** Password failures never repair data; authenticated interrupted publication can be completed. */
  static async open(directoryPath: string, password: string): Promise<PrivateHubStore> {
    const directory = path.resolve(directoryPath);
    const root = await directorySnapshot(directory);
    PrivateHubStore.reserve(directory);
    const store = new PrivateHubStore(directory, root, '', Buffer.alloc(0));
    let key: Buffer | undefined;
    try {
      store.#lease = await PrivateHubLease.acquire(directory);
      const candidate = await store.readFile(
        path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES, true,
      );
      const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
      key = await unlockPrivateHub(header, password);
      await store.completePublication(path.join(directory, PRIVATE_HUB_HEADER_FILE), candidate);
      const current = await store.readFile(
        path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES,
      );
      if (!unchanged(candidate.snapshot, current.snapshot) || !candidate.bytes.equals(current.bytes)) {
        throw new Error('The private hub header changed during unlock.');
      }
      const opened = new PrivateHubStore(directory, root, header.hubId, key);
      opened.#header = current.snapshot;
      opened.attachLease(store.#lease);
      return opened;
    } catch (error) {
      key?.fill(0);
      store.retainCleanupFailure(error);
      await store.lock();
      throw error;
    }
  }

  /** Probe one selected hub without reading a secret or repairing interrupted publication. */
  static async touchIdAvailable(directoryPath: string, provider: PrivateTouchIdProvider, signal: AbortSignal): Promise<boolean> {
    if (!(signal instanceof AbortSignal) || signal.aborted) { return false; }
    const directory = path.resolve(directoryPath);
    const root = await directorySnapshot(directory);
    if (signal.aborted) { return false; }
    PrivateHubStore.reserve(directory);
    const store = new PrivateHubStore(directory, root, '', Buffer.alloc(0));
    try {
      store.#lease = await PrivateHubLease.acquire(directory);
      if (signal.aborted) { return false; }
      const candidate = await store.readFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
      if (signal.aborted) { return false; }
      const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
      if (await provider.availability() !== 'available' || signal.aborted) { return false; }
      const enabled = await provider.has(privateHubTouchIdIdentity(header));
      if (signal.aborted) { return false; }
      const current = await store.readFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
      return !signal.aborted && enabled && unchanged(candidate.snapshot, current.snapshot) && candidate.bytes.equals(current.bytes);
    } catch (error) {
      store.retainCleanupFailure(error);
      if (isPrivateHubStoreCleanupFailure(error)) { throw error; }
      if (isPrivateTouchIdCleanupFailure(error)) { throw error; }
      return false;
    } finally { await store.lock(); }
  }

  /** Keychain retrieval is only an alternate key source; all storage authentication stays mandatory. */
  static async openWithTouchId(directoryPath: string, provider: PrivateTouchIdProvider, signal: AbortSignal): Promise<PrivateHubStore> {
    if (!(signal instanceof AbortSignal) || signal.aborted) { throw new Error('Private hub Touch ID unavailable.'); }
    const directory = path.resolve(directoryPath);
    const root = await directorySnapshot(directory);
    if (signal.aborted) { throw new Error('Private hub Touch ID unavailable.'); }
    PrivateHubStore.reserve(directory);
    const store = new PrivateHubStore(directory, root, '', Buffer.alloc(0));
    let key: Buffer | undefined;
    let secret: Buffer | undefined;
    let nativeSignal: AbortSignal | undefined;
    const wipe = (): void => { key?.fill(0); secret?.fill(0); };
    try {
      store.#lease = await PrivateHubLease.acquire(directory);
      const current = (): boolean => !signal.aborted && !store.#lease?.lostSignal.aborted;
      store.assertWriteCurrent(current);
      const candidate = await store.readFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES, true);
      store.assertWriteCurrent(current);
      const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
      nativeSignal = AbortSignal.any([signal, store.#lease.lostSignal]);
      nativeSignal.addEventListener('abort', wipe, { once: true });
      if (await provider.availability() !== 'available') { throw new Error(); }
      store.assertWriteCurrent(current);
      secret = await provider.unlock(privateHubTouchIdIdentity(header), nativeSignal);
      store.assertWriteCurrent(current);
      key = unlockPrivateHubWithTouchId(header, secret!);
      secret.fill(0);
      secret = undefined;
      await store.completePublication(path.join(directory, PRIVATE_HUB_HEADER_FILE), candidate);
      store.assertWriteCurrent(current);
      const published = await store.readFile(path.join(directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
      store.assertWriteCurrent(current);
      if (!unchanged(candidate.snapshot, published.snapshot) || !candidate.bytes.equals(published.bytes)) { throw new Error(); }
      const opened = new PrivateHubStore(directory, root, header.hubId, key);
      opened.#header = published.snapshot;
      opened.attachLease(store.#lease);
      opened.assertWriteCurrent(current);
      return opened;
    } catch (error) {
      key?.fill(0);
      store.retainCleanupFailure(error);
      try { await store.lock(); }
      catch (cleanupError) {
        if (isPrivateHubStoreCleanupFailure(cleanupError)) { throw cleanupError; }
        throw createPrivateTouchIdCleanupFailure();
      }
      if (isPrivateTouchIdCleanupFailure(error)) { throw error; }
      throw new Error('Private hub Touch ID unavailable.');
    } finally {
      secret?.fill(0);
      nativeSignal?.removeEventListener('abort', wipe);
    }
  }

  private static reserve(directory: string): void {
    const failure = quarantinedDirectories.get(directory);
    if (failure) { throw failure; }
    if (activeDirectories.has(directory)) {
      throw new Error('This private hub already has an open session in this process.');
    }
    activeDirectories.add(directory);
  }

  private retainCleanupFailure(error: unknown): void {
    if (!isPrivateHubStoreCleanupFailure(error) && !isPrivateHubLeaseCleanupFailure(error)) { return; }
    this.#cleanupFailure ??= quarantinedDirectories.get(this.directory)
      ?? (isPrivateHubStoreCleanupFailure(error) ? error : cleanupFailure());
    quarantinedDirectories.set(this.directory, this.#cleanupFailure);
    // Invalidate immediately; awaiting this from an admitted operation would
    // deadlock its own queue. lock() retains and reports the failure to owners.
    void this.lock().catch(() => undefined);
  }

  private async confirmCleanup(work: () => Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(work), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(cleanupFailure()), CLEANUP_TIMEOUT_MS);
      })]);
    } catch {
      this.retainCleanupFailure(cleanupFailure());
      throw this.#cleanupFailure;
    } finally { if (timer) { clearTimeout(timer); } }
  }

  private attachLease(lease: PrivateHubLease): void {
    this.#lease = lease;
    lease.lostSignal.addEventListener('abort', () => { void this.lock(); }, { once: true });
    if (lease.lostSignal.aborted) {
      void this.lock();
      throw new Error('The private hub storage lock was lost during startup.');
    }
  }

  /** Fires synchronously when locking, including unexpected lock-helper failure. */
  get lockSignal(): AbortSignal {
    return this.#lockController.signal;
  }

  get locked(): boolean {
    return this.#locked;
  }

  /**
   * Invalidate synchronously, then wait for already-submitted filesystem calls
   * to settle. No new decryptions or writes are admitted. Only the owned key is
   * wiped; this cannot erase caller-owned plaintext or promise OS memory wiping.
   */
  lock(): Promise<void> {
    if (!this.#lockCompletion) {
      this.#locked = true;
      this.#key.fill(0);
      this.#lockCompletion = Promise.all([this.#queue.catch(() => undefined), this.#touchIdDrain]).then(async () => {
        // Release the OS lock only after already-submitted IO settles.
        // Its persistent inode is never removed, including after replacement.
        // The lease owns bounded graceful shutdown, helper exit and descriptor
        // close phases. Do not race its graceful-kill boundary with our shorter
        // individual-handle deadline.
        try { await this.#lease?.release(); }
        catch {
          this.retainCleanupFailure(cleanupFailure());
          throw this.#cleanupFailure;
        }
        // Even a late successful close cannot prove that an earlier timeout
        // was safe. Retain this process reservation until application restart.
        if (this.#cleanupFailure) { throw this.#cleanupFailure; }
        activeDirectories.delete(this.directory);
        if (this.#touchIdCleanupFailed) { throw createPrivateTouchIdCleanupFailure(); }
      });
      void this.#lockCompletion.catch(() => undefined);
      this.#lockController.abort();
    }
    return this.#lockCompletion;
  }

  readRecord(recordId: string, maximumPlaintextBytes?: number): Promise<Buffer> {
    return this.readPlaintext(recordId, false, maximumPlaintextBytes);
  }

  /** A failed primary read never silently substitutes an older backup. */
  readBackupRecord(recordId: string, maximumPlaintextBytes?: number): Promise<Buffer> {
    return this.readPlaintext(recordId, true, maximumPlaintextBytes);
  }

  writeRecord(recordId: string, plaintext: Buffer, isCurrent?: () => boolean): Promise<void> {
    return this.writePlaintext(recordId, plaintext, false, isCurrent);
  }

  /** Create-only records support immutable media generations without replacing anything. */
  writeNewRecord(recordId: string, plaintext: Buffer): Promise<void> {
    return this.writePlaintext(recordId, plaintext, true);
  }

  private async writePlaintext(recordId: string, plaintext: Buffer, createOnly: boolean, isCurrent?: () => boolean): Promise<void> {
    this.assertWriteCurrent(isCurrent);
    const filePath = this.recordPath(recordId);
    // Encrypt synchronously before queueing; caller-owned plaintext is neither
    // retained by queued jobs nor written to any intermediate file.
    if (!Buffer.isBuffer(plaintext)
      || plaintext.length + PRIVATE_HUB_RECORD_OVERHEAD_BYTES + this.#queuedWriteBytes > PRIVATE_HUB_MAX_SEALED_RECORD_BYTES) {
      throw new Error('The private hub pending-write byte limit was exceeded.');
    }
    const sealed = encryptPrivateHubRecord(this.#key, this.hubId, recordId, plaintext);
    this.#queuedWriteBytes += sealed.length;
    try {
      await this.enqueue(async () => {
        this.assertWriteCurrent(isCurrent);
        const primary = await this.readOptionalRecord(filePath, recordId);
        const backupPath = filePath + '.bak';
        const backup = await this.readOptionalRecord(backupPath, recordId);
        if (createOnly && (primary || backup)) {
          throw new Error('The private hub record already exists.');
        }
        if (primary) {
          await this.commitFile(backupPath, primary.bytes, backup?.snapshot, isCurrent);
        } else if (backup) {
          throw new Error('The primary record is missing; explicitly recover its authenticated backup first.');
        }
        await this.commitFile(filePath, sealed, primary?.snapshot, isCurrent);
      });
    } finally {
      this.#queuedWriteBytes -= sealed.length;
    }
  }

  /** Read-only reauthentication against the exact header and key currently owned. */
  async verifyPassword(password: string, isCurrent: () => boolean): Promise<boolean> {
    if (!isPrivateHubPassword(password) || typeof isCurrent !== 'function' || this.#changingPassword) {
      throw new Error('Private hub authentication unavailable.');
    }
    let revoked = false;
    const current = (): boolean => {
      if (revoked || this.#locked) { return false; }
      try { revoked = isCurrent() !== true; } catch { revoked = true; }
      return !revoked && !this.#locked;
    };
    this.#changingPassword = true;
    let authenticatedKey: Buffer | undefined;
    try {
      this.assertWriteCurrent(current);
      const outcome = await this.enqueue(async (): Promise<boolean> => {
        this.assertWriteCurrent(current);
        await this.assertRoot();
        this.assertWriteCurrent(current);
        const candidate = await this.readFile(path.join(this.directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
        this.assertWriteCurrent(current);
        const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
        if (header.hubId !== this.hubId) { throw new Error(); }
        let authenticated = false;
        try { authenticatedKey = await unlockPrivateHub(header, password); authenticated = true; }
        catch { /* Only a stable, current header may report an incorrect password below. */ }
        finally { password = ''; }
        this.assertWriteCurrent(current);
        if (authenticated) {
          const matches = authenticatedKey.length === this.#key.length && timingSafeEqual(authenticatedKey, this.#key);
          authenticatedKey.fill(0);
          authenticatedKey = undefined;
          if (!matches) { throw new Error(); }
        }
        await this.assertRoot();
        this.assertWriteCurrent(current);
        return authenticated;
      });
      this.assertWriteCurrent(current);
      return outcome;
    } catch {
      if (this.#cleanupFailure) { throw this.#cleanupFailure; }
      throw new Error('Private hub authentication unavailable.');
    }
    finally { authenticatedKey?.fill(0); password = ''; this.#changingPassword = false; }
  }

  /** Report local credential availability without prompting or returning a key. */
  async touchIdStatus(provider: PrivateTouchIdProvider, signal: AbortSignal): Promise<'enabled' | 'disabled' | 'unavailable'> {
    if (!(signal instanceof AbortSignal) || signal.aborted || this.#changingPassword) { return 'unavailable'; }
    try {
      return await this.enqueue(async () => {
        this.assertWriteCurrent(() => !signal.aborted);
        const candidate = await this.readFile(path.join(this.directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
        this.assertWriteCurrent(() => !signal.aborted);
        const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
        if (header.hubId !== this.hubId || await provider.availability() !== 'available') { return 'unavailable'; }
        this.assertWriteCurrent(() => !signal.aborted);
        const enabled = await provider.has(privateHubTouchIdIdentity(header));
        await this.assertRoot();
        this.assertWriteCurrent(() => !signal.aborted);
        return enabled ? 'enabled' : 'disabled';
      });
    } catch (error) {
      if (this.#cleanupFailure) { throw this.#cleanupFailure; }
      if (isPrivateTouchIdCleanupFailure(error)) { throw error; }
      return 'unavailable';
    }
  }

  /** Require the current password before adding a device-local alternate unlock. */
  async enableTouchId(
    password: string, provider: PrivateTouchIdProvider, isCurrent: () => boolean, signal: AbortSignal,
  ): Promise<'enabled' | 'incorrect-password' | 'cancelled' | 'unavailable'> {
    if (!isPrivateHubPassword(password) || typeof isCurrent !== 'function' || !(signal instanceof AbortSignal) || this.#changingPassword) {
      throw new Error('Private hub Touch ID unavailable.');
    }
    const controller = new AbortController();
    const nativeSignal = AbortSignal.any([signal, this.lockSignal, controller.signal]);
    let revoked = false;
    const current = (): boolean => {
      if (revoked || nativeSignal.aborted || this.#locked) { return false; }
      try { revoked = isCurrent() !== true; } catch { revoked = true; }
      if (revoked) { controller.abort(); }
      return !revoked && !nativeSignal.aborted && !this.#locked;
    };
    this.#changingPassword = true;
    let key: Buffer | undefined;
    let secret: Buffer | undefined;
    let enrolledIdentity: string | undefined;
    let finishDrain!: () => void;
    const drain = new Promise<void>(resolve => { finishDrain = resolve; });
    this.#touchIdDrain = drain;
    const wipe = (): void => { key?.fill(0); secret?.fill(0); password = ''; };
    nativeSignal.addEventListener('abort', wipe, { once: true });
    try {
      this.assertWriteCurrent(current);
      const result = await this.enqueue(async (): Promise<'enabled' | 'incorrect-password' | 'cancelled' | 'unavailable'> => {
        this.assertWriteCurrent(current);
        const candidate = await this.readFile(path.join(this.directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
        this.assertWriteCurrent(current);
        const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
        if (header.hubId !== this.hubId) { throw new Error(); }
        try { key = await unlockPrivateHub(header, password); }
        catch {
          await this.assertRoot();
          this.assertWriteCurrent(current);
          return 'incorrect-password';
        } finally { password = ''; }
        this.assertWriteCurrent(current);
        if (key.length !== this.#key.length || !timingSafeEqual(key, this.#key)) { throw new Error(); }
        secret = createPrivateHubTouchIdSecret(header, key);
        key.fill(0);
        key = undefined;
        const identity = privateHubTouchIdIdentity(header);
        if (await provider.availability() !== 'available') { return 'unavailable'; }
        this.assertWriteCurrent(current);
        await this.assertRoot();
        this.assertWriteCurrent(current);
        const outcome = await provider.enroll(identity, secret, nativeSignal);
        if (outcome === 'enrolled') { enrolledIdentity = identity; }
        this.assertWriteCurrent(current);
        await this.assertRoot();
        this.assertWriteCurrent(current);
        if (outcome === 'enrolled') { return 'enabled'; }
        return outcome === 'cancelled' ? 'cancelled' : 'unavailable';
      });
      this.assertWriteCurrent(current);
      enrolledIdentity = undefined;
      return result;
    } catch (error) {
      if (enrolledIdentity) {
        try {
          if (!await provider.remove(enrolledIdentity, new AbortController().signal)) { throw new Error(); }
        } catch {
          this.#touchIdCleanupFailed = true;
          void this.lock();
          throw createPrivateTouchIdCleanupFailure();
        }
      }
      if (isPrivateTouchIdCleanupFailure(error)) {
        this.#touchIdCleanupFailed = true;
        void this.lock();
        throw error;
      }
      if (this.#cleanupFailure) { throw this.#cleanupFailure; }
      throw new Error('Private hub Touch ID unavailable.');
    } finally {
      wipe();
      controller.abort();
      nativeSignal.removeEventListener('abort', wipe);
      this.#changingPassword = false;
      finishDrain();
      if (this.#touchIdDrain === drain) { this.#touchIdDrain = undefined; }
    }
  }

  /** Delete only this hub's local credential; never changes encrypted records. */
  async disableTouchId(
    provider: PrivateTouchIdProvider, isCurrent: () => boolean, signal: AbortSignal,
  ): Promise<'disabled' | 'unavailable'> {
    if (typeof isCurrent !== 'function' || !(signal instanceof AbortSignal) || this.#changingPassword) {
      throw new Error('Private hub Touch ID unavailable.');
    }
    const controller = new AbortController();
    const nativeSignal = AbortSignal.any([signal, this.lockSignal, controller.signal]);
    let revoked = false;
    const current = (): boolean => {
      if (revoked || nativeSignal.aborted || this.#locked) { return false; }
      try { revoked = isCurrent() !== true; } catch { revoked = true; }
      if (revoked) { controller.abort(); }
      return !revoked && !nativeSignal.aborted && !this.#locked;
    };
    this.#changingPassword = true;
    try {
      this.assertWriteCurrent(current);
      const result = await this.enqueue(async () => {
        this.assertWriteCurrent(current);
        const candidate = await this.readFile(path.join(this.directory, PRIVATE_HUB_HEADER_FILE), PRIVATE_HUB_MAX_HEADER_BYTES);
        this.assertWriteCurrent(current);
        const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
        if (header.hubId !== this.hubId) { throw new Error(); }
        const removed = await provider.remove(privateHubTouchIdIdentity(header), nativeSignal);
        this.assertWriteCurrent(current);
        await this.assertRoot();
        this.assertWriteCurrent(current);
        return removed ? 'disabled' as const : 'unavailable' as const;
      });
      this.assertWriteCurrent(current);
      return result;
    } catch (error) {
      if (this.#cleanupFailure) { throw this.#cleanupFailure; }
      if (isPrivateTouchIdCleanupFailure(error)) {
        this.#touchIdCleanupFailed = true;
        void this.lock();
        throw error;
      }
      throw new Error('Private hub Touch ID unavailable.');
    } finally { controller.abort(); this.#changingPassword = false; }
  }

  /**
   * Authenticate the current password and replace only the wrapped-key header.
   * Never retain an old-password backup. A failure after publication starts is
   * ambiguous to the caller: lock and reopen instead of reporting late success.
   */
  async changePassword(currentPassword: string, newPassword: string, isCurrent: () => boolean, touchId?: PrivateTouchIdProvider): Promise<'changed' | 'incorrect-password'> {
    if (!isPrivateHubPassword(currentPassword) || !isPrivateHubPassword(newPassword) || typeof isCurrent !== 'function'
      || this.#changingPassword) {
      throw new Error('Private hub password change unavailable.');
    }
    let revoked = false;
    const current = (): boolean => {
      if (revoked || this.#locked) { return false; }
      try { revoked = isCurrent() !== true; } catch { revoked = true; }
      return !revoked && !this.#locked;
    };
    this.#changingPassword = true;
    let publicationStarted = false;
    let authenticatedKey: Buffer | undefined;
    try {
      this.assertWriteCurrent(current);
      const outcome = await this.enqueue(async (): Promise<'changed' | 'incorrect-password'> => {
        this.assertWriteCurrent(current);
        // Unknown old headers could still unlock the unchanged data key. Do
        // not report a successful change while retaining such credential copies.
        await this.assertRoot();
        this.assertWriteCurrent(current);
        const entries = await fs.promises.opendir(this.directory);
        try {
          let entry: fs.Dirent | null;
          while ((entry = await entries.read()) !== null) {
            this.assertWriteCurrent(current);
            if (entry.name.startsWith(PRIVATE_HUB_HEADER_FILE + '.')
              && (entry.name.endsWith('.pending') || entry.name === PRIVATE_HUB_HEADER_FILE + '.bak')) { throw new Error(); }
          }
        } finally { await this.confirmCleanup(() => entries.close()); }
        const headerPath = path.join(this.directory, PRIVATE_HUB_HEADER_FILE);
        const candidate = await this.readFile(headerPath, PRIVATE_HUB_MAX_HEADER_BYTES);
        this.assertWriteCurrent(current);
        const header = validatePrivateHubHeader(JSON.parse(candidate.bytes.toString('utf8')));
        if (header.hubId !== this.hubId) { throw new Error(); }
        try {
          authenticatedKey = await unlockPrivateHub(header, currentPassword);
        } catch {
          // A revoked request must not return even a credential result. Also
          // recheck the saved header so replacement is not mistaken for a typo.
          this.assertWriteCurrent(current);
          await this.assertRoot();
          this.assertWriteCurrent(current);
          return 'incorrect-password';
        } finally {
          currentPassword = '';
        }
        this.assertWriteCurrent(current);
        if (authenticatedKey.length !== this.#key.length || !timingSafeEqual(authenticatedKey, this.#key)) { throw new Error(); }
        authenticatedKey.fill(0);
        authenticatedKey = undefined;
        const replacement = await changePrivateHubPassword(header, this.#key, newPassword);
        newPassword = '';
        this.assertWriteCurrent(current);
        if (touchId) {
          const identity = privateHubTouchIdIdentity(header);
          const enrolled = await touchId.has(identity);
          this.assertWriteCurrent(current);
          if (enrolled && !await touchId.remove(identity, this.lockSignal)) { throw new Error(); }
          this.assertWriteCurrent(current);
          await this.assertRoot();
          this.assertWriteCurrent(current);
        }
        const bytes = Buffer.from(JSON.stringify(replacement), 'utf8');
        if (bytes.length > PRIVATE_HUB_MAX_HEADER_BYTES) { throw new Error(); }
        publicationStarted = true;
        await this.commitFile(headerPath, bytes, candidate.snapshot, current, true);
        this.assertWriteCurrent(current);
        const published = await this.readFile(headerPath, PRIVATE_HUB_MAX_HEADER_BYTES);
        this.assertWriteCurrent(current);
        if (!published.bytes.equals(bytes)) { throw new Error(); }
        return 'changed';
      });
      this.assertWriteCurrent(current);
      return outcome;
    } catch (error) {
      if (isPrivateTouchIdCleanupFailure(error)) { this.#touchIdCleanupFailed = true; }
      if (publicationStarted || this.#touchIdCleanupFailed) { void this.lock(); }
      if (this.#cleanupFailure) { throw this.#cleanupFailure; }
      if (isPrivateTouchIdCleanupFailure(error)) { throw error; }
      throw new Error('Private hub password change unavailable.');
    } finally {
      authenticatedKey?.fill(0);
      currentPassword = '';
      newPassword = '';
      this.#changingPassword = false;
    }
  }

  /** Explicitly restore an authenticated backup; the backup itself is retained. */
  async recoverRecord(recordId: string): Promise<void> {
    const filePath = this.recordPath(recordId);
    return this.enqueue(async () => {
      const backup = await this.readOptionalRecord(filePath + '.bak', recordId);
      if (!backup) {
        throw new Error('No authenticated private hub backup is available.');
      }
      const current = await fileSnapshot(filePath);
      await this.commitFile(filePath, backup.bytes, current);
    });
  }

  private assertUnlocked(): void {
    if (this.#cleanupFailure) { throw this.#cleanupFailure; }
    if (this.#locked) {
      throw new Error('The private hub is locked.');
    }
  }

  /** A main-owned synchronous guard is rechecked immediately before filesystem publication. */
  private assertWriteCurrent(isCurrent?: () => boolean): void {
    this.assertUnlocked();
    let current = true;
    try { if (isCurrent !== undefined) { current = isCurrent() === true; } }
    catch { current = false; }
    this.assertUnlocked();
    if (!current) { throw new Error('The private hub write is no longer authorized.'); }
  }

  private async assertDirectory(): Promise<void> {
    this.assertUnlocked();
    if (!sameFile(await directorySnapshot(this.directory), this.#root)) {
      throw new Error('The private hub directory was replaced.');
    }
    await this.#lease?.assertOwned();
    this.assertUnlocked();
  }

  private async assertRoot(): Promise<void> {
    await this.assertDirectory();
    if (this.#header) {
      const header = await fileSnapshot(path.join(this.directory, PRIVATE_HUB_HEADER_FILE));
      if (!header || !unchanged(header, this.#header)) {
        throw new Error('The private hub header changed; close and reopen the hub.');
      }
    }
    this.assertUnlocked();
  }

  private recordPath(recordId: string): string {
    this.assertUnlocked();
    if (typeof recordId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(recordId)
      || /[/\\]/.test(recordId) || recordId === '.' || recordId === '..') {
      throw new Error('Invalid private hub record identifier.');
    }
    const opaqueName = createHmac('sha256', this.#key)
      .update('theatrum-private-hub-record-name-v1\0').update(recordId).digest('hex');
    return path.join(this.directory, opaqueName + '.sealed');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertUnlocked();
    if (this.#queuedOperations >= 32) {
      throw new Error('The private hub operation queue is full.');
    }
    this.#queuedOperations++;
    const next = this.#queue.catch(() => undefined).then(async () => {
      try {
        this.assertUnlocked();
        return await operation();
      } finally {
        this.#queuedOperations--;
      }
    });
    // The queue tail must never retain the plaintext result of a completed read.
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readPlaintext(recordId: string, backup: boolean, maximumPlaintextBytes?: number): Promise<Buffer> {
    const maximum = maximumPlaintextBytes === undefined ? PRIVATE_HUB_MAX_SEALED_RECORD_BYTES
      : maximumPlaintextBytes + PRIVATE_HUB_RECORD_OVERHEAD_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < PRIVATE_HUB_RECORD_OVERHEAD_BYTES
      || maximum > PRIVATE_HUB_MAX_SEALED_RECORD_BYTES) {
      throw new Error('Invalid private hub record read limit.');
    }
    const filePath = this.recordPath(recordId) + (backup ? '.bak' : '');
    let plaintext: Buffer | undefined;
    try {
      plaintext = await this.enqueue(async () => {
        const candidate = await this.readFile(filePath, maximum, true);
        this.assertUnlocked();
        const decrypted = decryptPrivateHubRecord(this.#key, this.hubId, recordId, candidate.bytes);
        try {
          await this.completePublication(filePath, candidate);
          this.assertUnlocked();
          return decrypted;
        } catch (error) {
          decrypted.fill(0);
          throw error;
        }
      });
      // Promise adoption adds microtask boundaries after decryption; a lock at
      // those boundaries must discard and wipe this still-owned plaintext.
      this.assertUnlocked();
      return plaintext;
    } catch (error) {
      plaintext?.fill(0);
      throw error;
    }
  }

  private async readOptionalRecord(filePath: string, recordId: string): Promise<Candidate | undefined> {
    let candidate: Candidate;
    try {
      candidate = await this.readFile(filePath, PRIVATE_HUB_MAX_SEALED_RECORD_BYTES, true);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    this.assertUnlocked();
    const plaintext = decryptPrivateHubRecord(this.#key, this.hubId, recordId, candidate.bytes);
    plaintext.fill(0);
    await this.completePublication(filePath, candidate);
    return candidate;
  }

  private async publicationSnapshot(filePath: string): Promise<{ snapshot: fs.Stats; pending?: Candidate['pending'] } | undefined> {
    let snapshot: fs.Stats;
    try {
      snapshot = await fs.promises.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    if (!snapshot.isFile() || snapshot.isSymbolicLink() || ![1, 2].includes(snapshot.nlink)) {
      throw new Error('Private hub files must be regular files without symbolic or unrecognized hard links.');
    }
    if (snapshot.nlink === 1) {
      return { snapshot };
    }
    const prefix = path.basename(filePath) + '.';
    let pending: Candidate['pending'];
    // Stream a potentially large hub namespace instead of allocating all names.
    const entries = await fs.promises.opendir(this.directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = await entries.read()) !== null) {
        this.assertUnlocked();
        if (!entry.name.startsWith(prefix) || !/^[0-9a-f]{48}\.pending$/.test(entry.name.slice(prefix.length))) {
          continue;
        }
        const candidatePath = path.join(this.directory, entry.name);
        const candidate = await fs.promises.lstat(candidatePath);
        if (sameFile(candidate, snapshot)) {
          if (pending || !candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 2) {
            throw new Error('The private hub publication has unrecognized hard links.');
          }
          pending = { filePath: candidatePath, snapshot: candidate };
        }
      }
    } finally { await this.confirmCleanup(() => entries.close()); }
    if (!pending) {
      throw new Error('Private hub files must be regular files without unrecognized hard links.');
    }
    return { snapshot, pending };
  }

  /** Called only after header/password or record AEAD authentication succeeds. */
  private async completePublication(filePath: string, candidate: Candidate): Promise<void> {
    if (!candidate.pending) {
      return;
    }
    await this.assertRoot();
    const current = await this.publicationSnapshot(filePath);
    const alias = await fs.promises.lstat(candidate.pending.filePath);
    if (!current?.pending || current.pending.filePath !== candidate.pending.filePath
      || !unchanged(current.snapshot, candidate.snapshot) || !unchanged(alias, candidate.pending.snapshot)) {
      throw new Error('The interrupted private hub publication changed before recovery.');
    }
    this.assertUnlocked();
    await fs.promises.unlink(candidate.pending.filePath);
    await this.assertRoot();
    const recovered = await fileSnapshot(filePath);
    if (!recovered || !sameFile(recovered, candidate.snapshot) || recovered.size !== candidate.snapshot.size
      || recovered.mtimeMs !== candidate.snapshot.mtimeMs) {
      throw new Error('The private hub publication changed during recovery.');
    }
    candidate.snapshot = recovered;
    candidate.pending = undefined;
    await this.syncDirectory();
  }

  private async readFile(filePath: string, maximum: number, allowPublication = false): Promise<Candidate> {
    await this.assertRoot();
    const publication = allowPublication ? await this.publicationSnapshot(filePath) : undefined;
    const before = allowPublication ? publication?.snapshot : await fileSnapshot(filePath);
    if (!before) {
      throw Object.assign(new Error('The private hub file does not exist.'), { code: 'ENOENT' });
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const handle = await fs.promises.open(filePath, flags);
    let bytes: Buffer | undefined;
    try {
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== (publication?.pending ? 2 : 1) || !unchanged(before, opened)
          || opened.size > maximum || !Number.isSafeInteger(opened.size) || opened.size < 0) {
          throw new Error('The private hub file changed or exceeds its size limit.');
        }
        // One extra byte detects growth without allowing an unbounded readFile allocation.
        bytes = Buffer.alloc(opened.size + 1);
        let total = 0;
        while (total < bytes.length) {
          this.assertUnlocked();
          const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
          if (bytesRead === 0) {
            break;
          }
          total += bytesRead;
        }
        const after = await handle.stat();
        const currentPublication = allowPublication ? await this.publicationSnapshot(filePath) : undefined;
        const current = allowPublication ? currentPublication?.snapshot : await fileSnapshot(filePath);
        await this.assertRoot();
        if (currentPublication?.pending?.filePath !== publication?.pending?.filePath || total !== opened.size || !unchanged(opened, after) || !current || !unchanged(opened, current)) {
          throw new Error('The private hub file changed while it was being read.');
        }
        return { bytes: bytes.subarray(0, total), snapshot: current, pending: currentPublication?.pending };
      } finally { await this.confirmCleanup(() => handle.close()); }
    } catch (error) {
      bytes?.fill(0);
      throw error;
    }
  }

  private async syncDirectory(): Promise<void> {
    if (process.platform !== 'win32') {
      const handle = await fs.promises.open(this.directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (!sameFile(await handle.stat(), this.#root)) {
          throw new Error('The private hub directory was replaced.');
        }
        await handle.sync();
      } finally {
        await this.confirmCleanup(() => handle.close());
      }
    }
  }

  private async commitFile(target: string, bytes: Buffer, expected: Snapshot | undefined, isCurrent?: () => boolean, replacingHeader = false): Promise<void> {
    this.assertWriteCurrent(isCurrent);
    if (replacingHeader && (target !== path.join(this.directory, PRIVATE_HUB_HEADER_FILE)
      || !expected || !this.#header || !unchanged(expected, this.#header))) { throw new Error(); }
    await this.assertRoot();
    const temporary = path.join(this.directory, path.basename(target) + '.' + randomBytes(24).toString('hex') + '.pending');
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    let ownedTemporary: Snapshot | undefined;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= this.confirmCleanup(() => handle.close());
    try {
      ownedTemporary = await handle.stat();
      await handle.writeFile(bytes);
      await handle.sync();
      if (replacingHeader) {
        const written = await handle.stat();
        if (!sameFile(written, ownedTemporary) || !written.isFile() || written.nlink !== 1 || written.size !== bytes.length) { throw new Error(); }
        ownedTemporary = written;
      }
      await close();
      await this.assertRoot();
      const current = await fileSnapshot(target);
      if (expected ? !current || !unchanged(expected, current) : current !== undefined) {
        throw new Error('The private hub file changed before replacement.');
      }
      this.assertWriteCurrent(isCurrent);
      if (expected) {
        await fs.promises.rename(temporary, target);
      } else {
        // Exclusive publication preserves an unexpected destination; never fall
        // back to a truncating copy if the filesystem cannot create this link.
        // If interrupted before unlink, a later authenticated read may remove
        // exactly this target-bound alias; all unknown links fail closed.
        await fs.promises.link(temporary, target);
        await fs.promises.unlink(temporary);
      }
      if (replacingHeader) {
        // The old header snapshot remains authoritative until the rename has
        // completed. Adopt only our own staged inode under the original lease.
        await this.assertDirectory();
        const published = await fileSnapshot(target);
        if (!published || !sameFile(published, ownedTemporary) || published.size !== ownedTemporary.size
          || published.mtimeMs !== ownedTemporary.mtimeMs) { throw new Error(); }
        this.#header = published;
      }
      await this.assertRoot();
      await this.syncDirectory();
      this.assertWriteCurrent(isCurrent);
    } finally {
      // Do not retry uncertain closure or remove its still-owned staging file.
      // A close failure takes precedence over an ordinary write/stat failure.
      await close();
      // Clean up only our own staging inode under the original directory.
      try {
        const root = await directorySnapshot(this.directory);
        const remaining = await fs.promises.lstat(temporary);
        if (ownedTemporary && sameFile(root, this.#root) && sameFile(remaining, ownedTemporary)) {
          await fs.promises.unlink(temporary);
        }
      } catch {
        // A failed/locked operation may leave encrypted staging data. It is
        // safer to retain it than follow a changed directory during cleanup.
      }
    }
  }
}
