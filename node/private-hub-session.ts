import type { FinalObject } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { readPrivateHubCatalogue, PRIVATE_HUB_MAX_IMAGE_BYTES, type PrivateHubPreviewKind } from './private-hub-catalogue';
import { resolvePrivatePreviewId } from './private-hub-preview-set';
import { verifyPrivateHubConversion } from './private-hub-conversion';
import { createPrivateHubImageResponse } from './private-hub-image-response';
import { createPrivateHubMediaResponse } from './private-hub-media-response';
import { PRIVATE_HUB_MEDIA_CHUNK_BYTES } from './private-hub-media';
import { generatePrivateHubPreviews, isPrivatePreviewGenerationCleanupFailure } from './private-hub-preview-generation';
import type { PrivatePreviewSet } from './private-hub-preview-set';
import { isPrivatePreviewSource, privatePreviewSourceMatchesLocation, type PrivatePreviewSource } from './private-preview-source';
import { PrivateHubStore } from './private-hub-store';
import { CATALOGUE_FILE_MAX_BYTES, parseVhaJson } from './vha-file-persistence';
import { applyPrivateVideoMetadata, privateVideoRevision, snapshotPrivateVideoMetadataUpdate,
  type PrivateVideoMetadataUpdate, type PrivateVideoMetadataResult } from './private-hub-metadata';
import { snapshotPrivateHubProtection, type PrivateHubProtection } from '../interfaces/private-hub-protection';
import { readPrivateHubProtection, writePrivateHubProtection } from './private-hub-protection';
import { snapshotPrivateHubPasswordChange, snapshotPrivateHubPlaintextCopyRequest, snapshotPrivateHubTouchIdEnable } from '../interfaces/private-hub-credentials';

import { exportPrivateHubToPlaintext, isPrivateHubPlaintextExportCleanupFailure } from './private-hub-plaintext-export';

import { isPrivateTouchIdCleanupFailure, type PrivateTouchIdProvider } from './private-touch-id';

const ACTIVATION_RECORD = 'session:activation';
const MAX_PENDING_OPERATIONS = 16;
const MAX_OUTSTANDING_RESPONSES = 16;
const MAX_RESERVED_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_CATALOGUE_HASHES = 100_000;
const HASH_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/;

export type PrivateHubSessionState = 'idle' | 'locked' | 'unlocking' | 'unlocked';
export type PrivateHubLockReason = 'explicit' | 'closed' | 'shutdown' | 'storage-error' | 'storage-lock-lost' | 'unlock-failed';
export interface PrivateHubSessionStatus {
  state: PrivateHubSessionState;
  generation: number;
}
export interface PrivateHubSessionOptions {
  /** Main-owned native provider. Never supplied by a renderer. */
  touchId?: PrivateTouchIdProvider;
  /** Revoke main/renderer authority synchronously. Keys are already wiped when this runs. */
  onLock?: (reason: PrivateHubLockReason, revokedGeneration: number) => void;
}
export interface PrivateHubPreviewResponseOptions {
  /** Additional main-owned catalogue authority, rechecked throughout streaming. */
  isAuthorized?: () => boolean;
}
export interface PrivateHubSessionPreviewGenerationOptions {
  /** Main-owned cancellation, never a source path or an arbitrary encoder plan. */
  signal?: AbortSignal;
}

function unavailable(): Error { return new Error('The private hub session is unavailable.'); }

function catalogueHashes(catalogue: FinalObject): Set<string> {
  const hashes = new Set<string>();
  for (const image of catalogue.images) {
    if (image.deleted === true || image.cleanName === '*FOLDER*') { continue; }
    if (typeof image.hash !== 'string' || !HASH_PATTERN.test(image.hash)) { throw unavailable(); }
    hashes.add(image.hash);
    if (hashes.size > MAX_CATALOGUE_HASHES) { throw unavailable(); }
  }
  return hashes;
}

function validateActivation(bytes: Buffer, hubId: string): void {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw unavailable(); }
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).sort().join(',') !== 'format,hubId,version'
    || marker.format !== 'theatrum-private-hub-activation' || marker.version !== 1 || marker.hubId !== hubId) {
    throw unavailable();
  }
}

/**
 * Main-process authority only: no raw store/key accessor and no plaintext fallback.
 * A locked session retains its private identity until an explicit, drained close().
 */
export class PrivateHubSession {
  readonly #options: PrivateHubSessionOptions;
  #state: PrivateHubSessionState = 'idle';
  #generation = 0;
  #store: PrivateHubStore | undefined;
  #hashes = new Set<string>();
  #opening: Promise<void> | undefined;
  #unlockController: AbortController | undefined;
  #draining: Promise<void> | undefined;
  #revocationCompletion: {
    promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void;
  } | undefined;
  #queue: Promise<void> = Promise.resolve();
  #pendingOperations = 0;
  #pendingWriteBytes = 0;
  readonly #pendingWrites = new Set<Buffer>();
  #reservedResponseBytes = 0;
  readonly #responseReservations = new Set<() => void>();
  #previewJob: Promise<void> | undefined;
  #previewController: AbortController | undefined;
  #previewCleanupFailure: Error | undefined;
  #protectionSaving = false;
  #passwordChanging = false;
  #touchIdController: AbortController | undefined;
  #touchIdCleanupFailure: Error | undefined;
  #plaintextCopying = false;
  #plaintextCopyController: AbortController | undefined;
  #plaintextCopyCleanupFailure: Error | undefined;

  constructor(options: PrivateHubSessionOptions = {}) { this.#options = { ...options }; }

  get status(): PrivateHubSessionStatus { return { state: this.#state, generation: this.#generation }; }

  isCurrent(generation: number): boolean {
    return Number.isSafeInteger(generation) && generation === this.#generation
      && this.#state === 'unlocked' && !!this.#store && !this.#store.locked;
  }

  /** Main-only lifecycle signal. Lock and lost storage ownership revoke it synchronously. */
  revocationSignal(generation: number): AbortSignal {
    return this.assertCurrent(generation).lockSignal;
  }

  /**
   * Main-only completion captured while this generation is current. Resolves only
   * after its first revocation has drained storage and session work; cleanup
   * failures reject it. Capturing this promise does not initiate locking.
   */
  revocationDrained(generation: number): Promise<void> {
    this.assertCurrent(generation);
    if (!this.#revocationCompletion) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // A main-process owner may not attach its cleanup wait until synchronous
      // revocation runs. Keep a late observer safe without changing its result.
      void promise.catch(() => undefined);
      this.#revocationCompletion = { promise, resolve, reject };
    }
    return this.#revocationCompletion.promise;
  }

  unlock(directory: string, password: string): Promise<{ generation: number; catalogue: FinalObject }> {
    return this.beginUnlock(directory, password, false);
  }

  unlockWithTouchId(directory: string): Promise<{ generation: number; catalogue: FinalObject }> {
    if (!this.#options.touchId) { return Promise.reject(unavailable()); }
    return this.beginUnlock(directory, '', true);
  }

  private beginUnlock(directory: string, password: string, touchId: boolean): Promise<{ generation: number; catalogue: FinalObject }> {
    if (this.#touchIdCleanupFailure || this.#plaintextCopyCleanupFailure || this.#previewCleanupFailure || this.#opening || this.#draining || this.#state === 'unlocked' || this.#state === 'unlocking') {
      return Promise.reject(unavailable());
    }
    this.#state = 'unlocking';
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#unlockController = controller;
    // The coordinator never retains the password in a field, queue, status, or callback.
    const opened = this.open(directory, password, generation, touchId, controller.signal);
    password = '';
    const opening = opened.then(() => undefined, () => undefined);
    this.#opening = opening;
    void opening.then(() => {
      if (this.#opening === opening) { this.#opening = undefined; }
      if (this.#unlockController === controller) { this.#unlockController = undefined; }
    });
    let cancel: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(unavailable());
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    return Promise.race([opened, cancelled]).finally(() => controller.signal.removeEventListener('abort', cancel)).then(catalogue => {
      this.assertCurrent(generation);
      return { generation, catalogue };
    });
  }

  private async open(directory: string, password: string, generation: number, touchId: boolean, signal: AbortSignal): Promise<FinalObject> {
    let store: PrivateHubStore | undefined;
    try {
      const pending = touchId ? PrivateHubStore.openWithTouchId(directory, this.#options.touchId!, signal)
        : PrivateHubStore.open(directory, password);
      password = '';
      store = await pending;
      this.assertOpening(generation, store);
      this.#store = store;
      const owned = store;
      store.lockSignal.addEventListener('abort', () => {
        if (this.#store === owned) { void this.lock('storage-lock-lost').catch(() => undefined); }
      }, { once: true });
      await this.ensureActivated(store, generation);
      this.assertOpening(generation, store);
      const catalogue = await readPrivateHubCatalogue(store);
      this.assertOpening(generation, store);
      this.#hashes = catalogueHashes(catalogue);
      this.#state = 'unlocked';
      return catalogue;
    } catch (error) {
      if (isPrivateTouchIdCleanupFailure(error)) { this.#touchIdCleanupFailure = error; }
      if (this.#generation === generation) { void this.lock('unlock-failed').catch(() => undefined); }
      // Also dispose a late successful open which was never adopted by this session.
      try { await store?.lock(); } catch { /* preserve a generic unlock failure */ }
      throw unavailable();
    } finally { password = ''; }
  }

  private assertOpening(generation: number, store: PrivateHubStore): void {
    if (this.#generation !== generation || this.#state !== 'unlocking' || store.locked) { throw unavailable(); }
  }

  private async ensureActivated(store: PrivateHubStore, generation: number): Promise<void> {
    let bytes: Buffer;
    try { bytes = await store.readRecord(ACTIVATION_RECORD, 512); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      this.assertOpening(generation, store);
      await verifyPrivateHubConversion(store);
      this.assertOpening(generation, store);
      const marker = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
      try { await store.writeNewRecord(ACTIVATION_RECORD, marker); }
      finally { marker.fill(0); }
      this.assertOpening(generation, store);
      bytes = await store.readRecord(ACTIVATION_RECORD, 512);
    }
    try { this.assertOpening(generation, store); validateActivation(bytes, store.hubId); }
    finally { bytes.fill(0); }
  }

  /** Invalidation, queued-buffer wiping, key wiping, and the revoke hook happen before the first await. */
  lock(reason: PrivateHubLockReason = 'explicit'): Promise<void> {
    // Detach before any abort callback can reenter lock. Nested lock calls must
    // never settle this generation from their smaller, already-revoked scope.
    const completion = this.#revocationCompletion;
    this.#revocationCompletion = undefined;
    const notify = this.#state === 'unlocked' || this.#state === 'unlocking';
    const revokedGeneration = this.#generation++;
    if (this.#state !== 'idle') { this.#state = 'locked'; }
    const store = this.#store;
    this.#store = undefined;
    this.#hashes.clear();
    this.#previewController?.abort();
    this.#plaintextCopyController?.abort();
    this.#touchIdController?.abort();
    for (const bytes of this.#pendingWrites) { bytes.fill(0); }
    let storeDrained: Promise<void> | undefined;
    try { storeDrained = store?.lock(); }
    catch (error) { storeDrained = Promise.reject(error); }
    // Store locking first synchronously wipes helper-owned image/chunk buffers.
    for (const release of this.#responseReservations) { release(); }
    this.#unlockController?.abort();
    const draining = Promise.allSettled([this.#draining, this.#opening, this.#queue, this.#previewJob, storeDrained]).then(results => {
      if (this.#touchIdCleanupFailure) { throw this.#touchIdCleanupFailure; }
      if (this.#plaintextCopyCleanupFailure) { throw this.#plaintextCopyCleanupFailure; }
      if (this.#previewCleanupFailure) { throw this.#previewCleanupFailure; }
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') { throw failed.reason; }
    });
    this.#draining = draining;
    const cleanup = (): void => { if (this.#draining === draining) { this.#draining = undefined; } };
    void draining.then(cleanup, cleanup);
    if (completion) { void draining.then(completion.resolve, completion.reject); }
    if (notify) {
      try {
        // A rejected async observer or thrown UI cleanup must never bypass key wiping.
        const result = this.#options.onLock?.(reason, revokedGeneration);
        void Promise.resolve(result).catch(() => undefined);
      } catch { /* notification only; authority is already revoked */ }
    }
    return draining;
  }

  /** Deliberate switch away from private storage. Never infer this transition from an error. */
  async close(): Promise<void> {
    const draining = this.lock('closed');
    const generation = this.#generation;
    await draining;
    if (this.#generation !== generation) { throw unavailable(); }
    this.#state = 'idle';
  }

  private assertCurrent(generation: number): PrivateHubStore {
    if (!this.isCurrent(generation)) { throw unavailable(); }
    return this.#store!;
  }

  private enqueue<T>(generation: number, operation: (store: PrivateHubStore) => Promise<T>, discard?: (result: T) => void): Promise<T> {
    this.assertCurrent(generation);
    if (this.#pendingOperations >= MAX_PENDING_OPERATIONS) { throw unavailable(); }
    this.#pendingOperations++;
    const next = this.#queue.then(async () => {
      const result = await operation(this.assertCurrent(generation));
      try { this.assertCurrent(generation); return result; }
      catch (error) { discard?.(result); throw error; }
    }).finally(() => { this.#pendingOperations--; });
    // Do not retain a catalogue or response in the queue tail.
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async readCatalogue(generation: number): Promise<FinalObject> {
    try {
      const catalogue = await this.enqueue(generation, async store => {
        try { return await readPrivateHubCatalogue(store); }
        catch {
          if (this.isCurrent(generation)) { void this.lock('storage-error').catch(() => undefined); }
          throw unavailable();
        }
      });
      this.assertCurrent(generation);
      return catalogue;
    }
    catch { throw unavailable(); }
  }

  async readProtection(generation: number): Promise<PrivateHubProtection> {
    try {
      const settings = await this.enqueue(generation, async store => {
        try { return await readPrivateHubProtection(store); }
        catch {
          if (this.isCurrent(generation)) { void this.lock('storage-error').catch(() => undefined); }
          throw unavailable();
        }
      });
      this.assertCurrent(generation);
      return settings;
    } catch { throw unavailable(); }
  }

  async updateProtection(generation: number, value: PrivateHubProtection, isCurrent: () => boolean): Promise<PrivateHubProtection> {
    let admitted = false;
    let revoked = false;
    const current = (): boolean => {
      if (revoked) { return false; }
      try {
        if (!this.isCurrent(generation) || typeof isCurrent !== 'function' || isCurrent() !== true || !this.isCurrent(generation)) {
          revoked = true;
        }
      } catch { revoked = true; }
      return !revoked;
    };
    try {
      const snapshot = snapshotPrivateHubProtection(value);
      if (!snapshot || !current() || this.#previewJob || this.#protectionSaving || this.#passwordChanging || this.#plaintextCopying) { throw unavailable(); }
      this.#protectionSaving = true;
      admitted = true;
      const result = await this.enqueue(generation, async store => {
        if (!current()) { throw unavailable(); }
        try { return await writePrivateHubProtection(store, snapshot, current); }
        catch {
          if (current()) { void this.lock('storage-error').catch(() => undefined); }
          throw unavailable();
        }
      });
      if (!current()) { throw unavailable(); }
      return result;
    } catch { throw unavailable(); }
    finally { if (admitted) { this.#protectionSaving = false; } }
  }

  /** Reauthenticate and replace only the key envelope. The owning browser locks after success. */
  async changePassword(generation: number, value: unknown, isCurrent: () => boolean): Promise<'changed' | 'incorrect-password'> {
    let admitted = false;
    let revoked = false;
    const credentials: Buffer[] = [];
    const current = (): boolean => {
      if (revoked) { return false; }
      try {
        if (!this.isCurrent(generation) || typeof isCurrent !== 'function' || isCurrent() !== true || !this.isCurrent(generation)) {
          revoked = true;
        }
      } catch { revoked = true; }
      return !revoked;
    };
    try {
      const snapshot = snapshotPrivateHubPasswordChange(value);
      value = undefined;
      if (!snapshot) { throw unavailable(); }
      try {
        if (!current() || this.#plaintextCopying || this.#passwordChanging || this.#protectionSaving || this.#previewJob || this.#pendingWrites.size) {
          throw unavailable();
        }
        this.#passwordChanging = true;
        admitted = true;
        for (const password of [snapshot.currentPassword, snapshot.newPassword]) {
          const bytes = Buffer.from(password, 'utf8');
          credentials.push(bytes);
          this.#pendingWrites.add(bytes);
          this.#pendingWriteBytes += bytes.length;
        }
      } finally { snapshot.currentPassword = ''; snapshot.newPassword = ''; }
      const result = await this.enqueue(generation, async store => {
        if (!current()) { throw unavailable(); }
        try {
          const changing = store.changePassword(credentials[0].toString('utf8'), credentials[1].toString('utf8'), current, this.#options.touchId);
          for (const bytes of credentials) { bytes.fill(0); }
          return await changing;
        } catch (error) {
          if (isPrivateTouchIdCleanupFailure(error)) { this.#touchIdCleanupFailure = error; }
          if (current()) { void this.lock('storage-error').catch(() => undefined); }
          throw unavailable();
        }
      });
      if (!current()) { throw unavailable(); }
      return result;
    } catch { throw unavailable(); }
    finally {
      value = undefined;
      for (const bytes of credentials) {
        bytes.fill(0);
        if (this.#pendingWrites.delete(bytes)) { this.#pendingWriteBytes -= bytes.length; }
      }
      if (admitted) { this.#passwordChanging = false; }
    }
  }

  async touchIdStatus(generation: number, signal: AbortSignal): Promise<'enabled' | 'disabled' | 'unavailable'> {
    const provider = this.#options.touchId;
    if (!provider || !(signal instanceof AbortSignal) || signal.aborted) { return 'unavailable'; }
    try {
      const state = await this.enqueue(generation, store => store.touchIdStatus(provider, signal));
      return signal.aborted ? 'unavailable' : state;
    } catch (error) {
      if (isPrivateTouchIdCleanupFailure(error)) {
        this.#touchIdCleanupFailure = error;
        void this.lock('storage-error').catch(() => undefined);
        throw error;
      }
      return 'unavailable';
    }
  }

  enableTouchId(generation: number, value: unknown, isCurrent: () => boolean, signal: AbortSignal): Promise<'enabled' | 'incorrect-password' | 'cancelled' | 'unavailable'> {
    return this.changeTouchId(generation, value, isCurrent, signal, true) as Promise<'enabled' | 'incorrect-password' | 'cancelled' | 'unavailable'>;
  }

  disableTouchId(generation: number, isCurrent: () => boolean, signal: AbortSignal): Promise<'disabled' | 'unavailable'> {
    return this.changeTouchId(generation, undefined, isCurrent, signal, false) as Promise<'disabled' | 'unavailable'>;
  }

  private async changeTouchId(
    generation: number, value: unknown, isCurrent: () => boolean, signal: AbortSignal, enable: boolean,
  ): Promise<'enabled' | 'disabled' | 'incorrect-password' | 'cancelled' | 'unavailable'> {
    const provider = this.#options.touchId;
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    let admitted = false;
    let revoked = false;
    let credential: Buffer | undefined;
    const current = (): boolean => {
      if (revoked) { return false; }
      try {
        if (controller.signal.aborted || !this.isCurrent(generation) || isCurrent() !== true
          || !this.isCurrent(generation) || controller.signal.aborted) { revoked = true; }
      } catch { revoked = true; }
      return !revoked;
    };
    try {
      const snapshot = enable ? snapshotPrivateHubTouchIdEnable(value) : undefined;
      value = undefined;
      try {
        if (!provider || !(signal instanceof AbortSignal) || (enable && !snapshot)) { throw unavailable(); }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); }
        if (!current() || this.#plaintextCopying || this.#passwordChanging || this.#protectionSaving
          || this.#previewJob || this.#pendingWrites.size) { throw unavailable(); }
        this.#passwordChanging = true;
        this.#touchIdController = controller;
        admitted = true;
        if (snapshot) {
          credential = Buffer.from(snapshot.password, 'utf8');
          this.#pendingWrites.add(credential);
          this.#pendingWriteBytes += credential.length;
        }
      } finally { if (snapshot) { snapshot.password = ''; } }
      const result = await this.enqueue(generation, async store => {
        if (!current()) { throw unavailable(); }
        try {
          const work = enable
            ? store.enableTouchId(credential!.toString('utf8'), provider, current, controller.signal)
            : store.disableTouchId(provider, current, controller.signal);
          credential?.fill(0);
          return await work;
        } catch (error) {
          if (isPrivateTouchIdCleanupFailure(error)) {
            this.#touchIdCleanupFailure = error;
            void this.lock('storage-error').catch(() => undefined);
            throw error;
          }
          throw unavailable();
        }
      });
      if (!current()) { throw unavailable(); }
      return result;
    } finally {
      value = undefined;
      credential?.fill(0);
      if (credential && this.#pendingWrites.delete(credential)) { this.#pendingWriteBytes -= credential.length; }
      signal?.removeEventListener('abort', abort);
      if (admitted) {
        this.#passwordChanging = false;
        if (this.#touchIdController === controller) { this.#touchIdController = undefined; }
      }
    }
  }

  /** Deliberate plaintext export. Authentication finishes before the native destination picker. */
  async createUnprotectedCopy(
    generation: number, value: unknown, isCurrent: () => boolean,
    options: { chooseDestination: () => Promise<string | undefined>; signal: AbortSignal },
  ): Promise<'copied' | 'incorrect-password' | 'cancelled' | 'failed'> {
    let admitted = false;
    let revoked = false;
    let credential: Buffer | undefined;
    const controller = new AbortController();
    const signal = options?.signal;
    const chooseDestination = options?.chooseDestination;
    const abort = (): void => { controller.abort(); };
    const current = (): boolean => {
      if (revoked) { return false; }
      try {
        if (controller.signal.aborted || !this.isCurrent(generation) || typeof isCurrent !== 'function'
          || isCurrent() !== true || !this.isCurrent(generation) || controller.signal.aborted) { revoked = true; }
      } catch { revoked = true; }
      return !revoked;
    };
    const check = (): void => { if (!current()) { throw unavailable(); } };
    try {
      const snapshot = snapshotPrivateHubPlaintextCopyRequest(value);
      value = undefined;
      if (!snapshot) { throw unavailable(); }
      try {
        if (!(signal instanceof AbortSignal) || typeof chooseDestination !== 'function') { throw unavailable(); }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); }
        if (!current() || this.#plaintextCopying || this.#passwordChanging || this.#protectionSaving
          || this.#previewJob || this.#pendingWrites.size) { throw unavailable(); }
        this.#plaintextCopying = true;
        this.#plaintextCopyController = controller;
        admitted = true;
        credential = Buffer.from(snapshot.password, 'utf8');
        this.#pendingWrites.add(credential);
        this.#pendingWriteBytes += credential.length;
      } finally { snapshot.password = ''; }
      const result = await this.enqueue(generation, async store => {
        check();
        let authenticated: boolean;
        try {
          const verifying = store.verifyPassword(credential.toString('utf8'), current);
          credential.fill(0);
          authenticated = await verifying;
        } catch {
          if (current()) { void this.lock('storage-error').catch(() => undefined); }
          throw unavailable();
        }
        check();
        if (!authenticated) { return 'incorrect-password' as const; }
        const destinationDirectory = await chooseDestination();
        check();
        if (destinationDirectory === undefined) { return 'cancelled' as const; }
        if (typeof destinationDirectory !== 'string') { return 'failed' as const; }
        await exportPrivateHubToPlaintext(store, {
          destinationDirectory, signal: controller.signal,
          assertSourceQuiescent: () => { check(); if (!this.#plaintextCopying) { throw unavailable(); } },
        });
        check();
        return 'copied' as const;
      });
      check();
      return result;
    } catch (error) {
      if (isPrivateHubPlaintextExportCleanupFailure(error)) {
        this.#plaintextCopyCleanupFailure = error;
        void this.lock('storage-error').catch(() => undefined);
        throw error;
      }
      if (!admitted || !this.isCurrent(generation)) { throw unavailable(); }
      if (controller.signal.aborted) { return 'cancelled'; }
      check();
      return 'failed';
    } finally {
      value = undefined;
      if (signal instanceof AbortSignal) { signal.removeEventListener('abort', abort); }
      credential?.fill(0);
      if (credential && this.#pendingWrites.delete(credential)) { this.#pendingWriteBytes -= credential.length; }
      if (admitted) {
        this.#plaintextCopying = false;
        if (this.#plaintextCopyController === controller) { this.#plaintextCopyController = undefined; }
      }
    }
  }

  async writeCatalogue(generation: number, catalogue: FinalObject): Promise<void> {
    let bytes: Buffer | undefined;
    let admitted = false;
    try {
      this.assertCurrent(generation);
      // Freeze persisted source authority/settings for the duration of an
      // admitted generation. Reads and preview responses remain available.
      if (this.#previewJob || this.#passwordChanging || this.#plaintextCopying) { throw unavailable(); }
      const json = JSON.stringify(catalogue);
      if (typeof json !== 'string' || Buffer.byteLength(json) + this.#pendingWriteBytes > CATALOGUE_FILE_MAX_BYTES) { throw unavailable(); }
      const hashes = catalogueHashes(parseVhaJson(json));
      bytes = Buffer.from(json);
      this.#pendingWriteBytes += bytes.length;
      this.#pendingWrites.add(bytes);
      admitted = true;
      const snapshot = bytes;
      await this.enqueue(generation, async store => {
        try {
          const writing = store.writeRecord('catalogue', snapshot);
          snapshot.fill(0);
          await writing;
          this.assertCurrent(generation);
          this.#hashes = hashes;
        } catch {
          if (this.isCurrent(generation)) { void this.lock('storage-error').catch(() => undefined); }
          throw unavailable();
        }
      });
      this.assertCurrent(generation);
    } catch { throw unavailable(); }
    finally {
      bytes?.fill(0);
      if (bytes && admitted) { this.#pendingWriteBytes -= bytes.length; this.#pendingWrites.delete(bytes); }
    }
  }

  /** One guarded read/compare/write transaction; no whole-catalogue data crosses private IPC. */
  async updateVideoMetadata(
    generation: number, value: PrivateVideoMetadataUpdate, isCurrent: () => boolean,
  ): Promise<PrivateVideoMetadataResult> {
    let requestBytes: Buffer | undefined;
    let outputBytes: Buffer | undefined;
    let revoked = false;
    const current = (): boolean => {
      if (revoked) { return false; }
      try {
        if (!this.isCurrent(generation) || typeof isCurrent !== 'function' || isCurrent() !== true || !this.isCurrent(generation)) {
          revoked = true;
        }
      } catch { revoked = true; }
      return !revoked;
    };
    const check = (): void => { if (!current()) { throw unavailable(); } };
    const storageFailure = (): never => {
      if (current()) { void this.lock('storage-error').catch(() => undefined); }
      throw unavailable();
    };
    const retain = (bytes: Buffer): void => {
      this.#pendingWrites.add(bytes);
      this.#pendingWriteBytes += bytes.length;
    };
    try {
      check();
      const snapshot = snapshotPrivateVideoMetadataUpdate(value);
      check();
      if (!snapshot) { return { status: 'invalid' }; }
      if (this.#previewJob || this.#passwordChanging || this.#plaintextCopying || this.#pendingOperations >= MAX_PENDING_OPERATIONS) { return { status: 'busy' }; }
      requestBytes = Buffer.from(JSON.stringify(snapshot));
      if (requestBytes.length + this.#pendingWriteBytes > CATALOGUE_FILE_MAX_BYTES) { return { status: 'busy' }; }
      retain(requestBytes);
      const queued = requestBytes;
      const result = await this.enqueue(generation, async store => {
        check();
        let raw: Buffer | undefined;
        let catalogue: FinalObject;
        try {
          try { raw = await store.readRecord('catalogue', CATALOGUE_FILE_MAX_BYTES); }
          catch { return storageFailure(); }
          check();
          try {
            // Validation may normalize source exclusions. Apply the edit to the
            // original JSON object so unrelated and unknown values stay intact.
            parseVhaJson(raw);
            catalogue = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) as FinalObject;
          } catch { return storageFailure(); }
        } finally { raw?.fill(0); }
        check();
        const update = JSON.parse(queued.toString('utf8')) as PrivateVideoMetadataUpdate;
        queued.fill(0);
        const image = catalogue.images[update.index];
        if (!image || privateVideoRevision(image) !== update.revision) { return { status: 'conflict' } as const; }
        const edited = applyPrivateVideoMetadata(image, update);
        if (!edited) { return { status: 'invalid' } as const; }
        catalogue.images[update.index] = edited;
        const json = JSON.stringify(catalogue);
        if (Buffer.byteLength(json) > CATALOGUE_FILE_MAX_BYTES) { return { status: 'invalid' } as const; }
        if (Buffer.byteLength(json) + this.#pendingWriteBytes > CATALOGUE_FILE_MAX_BYTES) { return { status: 'busy' } as const; }
        outputBytes = Buffer.from(json);
        retain(outputBytes);
        check();
        try {
          const writing = store.writeRecord('catalogue', outputBytes, current);
          outputBytes.fill(0);
          await writing;
        } catch { return storageFailure(); }
        check();
        return { status: 'saved', image: edited } as const;
      });
      check();
      return result;
    } catch { throw unavailable(); }
    finally {
      for (const bytes of [requestBytes, outputBytes]) {
        if (!bytes) { continue; }
        bytes.fill(0);
        if (this.#pendingWrites.delete(bytes)) { this.#pendingWriteBytes -= bytes.length; }
      }
    }
  }

  /**
   * Main-only regeneration of an existing authenticated catalogue location.
   * Settings and strip count come from storage, never the request. One job per
   * session runs outside the catalogue queue; the backend also bounds jobs
   * globally. Accepted work consumes/closes the source capability when drained.
   * Changes to strip geometry await catalogue/preview transaction support.
   */
  generatePreviews(
    generation: number, source: PrivatePreviewSource, options: PrivateHubSessionPreviewGenerationOptions = {},
  ): Promise<PrivatePreviewSet> {
    let externalSignal: AbortSignal | undefined;
    try {
      this.assertCurrent(generation);
      externalSignal = options.signal;
      if (externalSignal !== undefined && !(externalSignal instanceof AbortSignal)) { throw unavailable(); }
      if (this.#previewJob || this.#protectionSaving || this.#passwordChanging || this.#plaintextCopying || this.#pendingWrites.size > 0 || !isPrivatePreviewSource(source)
        || !this.#hashes.has(source.hash) || !source.isCurrent() || externalSignal?.aborted) { throw unavailable(); }
      this.assertCurrent(generation);
      if (this.#previewJob || this.#protectionSaving || this.#passwordChanging || this.#plaintextCopying || this.#pendingWrites.size > 0) { throw unavailable(); }
    } catch { return Promise.reject(unavailable()); }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    this.#previewController = controller;
    externalSignal?.addEventListener('abort', abort, { once: true });
    const isCurrent = (): boolean => this.isCurrent(generation) && !controller.signal.aborted;
    const work = (async (): Promise<PrivatePreviewSet> => {
      try {
        const catalogue = await this.readCatalogue(generation);
        if (!isCurrent()) { throw unavailable(); }
        const matches = catalogue.images.filter(image => image.hash === source.hash
          && image.deleted !== true && image.cleanName !== '*FOLDER*');
        if (matches.length !== 1) { throw unavailable(); }
        const image = matches[0];
        const locationOwned = getImageLocations(image).some(location => {
          const root = catalogue.inputDirs[location.inputSource]?.path;
          return typeof root === 'string' && privatePreviewSourceMatchesLocation(source, { ...location, root, hash: image.hash });
        });
        if (!locationOwned || !isCurrent()) { throw unavailable(); }
        const result = await generatePrivateHubPreviews(this.assertCurrent(generation), source, catalogue.screenshotSettings,
          { signal: controller.signal, isCurrent, expectedScreenCount: image.screens });
        if (!isCurrent()) { throw unavailable(); }
        return result;
      } catch (error) { throw isPrivatePreviewGenerationCleanupFailure(error) ? error : unavailable(); }
      finally {
        controller.abort();
        externalSignal?.removeEventListener('abort', abort);
        await source.close();
      }
    })().catch(error => {
      if (isPrivatePreviewGenerationCleanupFailure(error)) {
        // An inherited descriptor may still be held by a decoder. Revoke keys
        // immediately and retain the failure even after the job promise settles.
        this.#previewCleanupFailure = error;
        void this.lock('storage-error').catch(() => undefined);
        throw error;
      }
      throw unavailable();
    });
    const drained = work.then(() => undefined, error => {
      if (isPrivatePreviewGenerationCleanupFailure(error)) { throw error; }
    });
    this.#previewJob = drained;
    const cleanup = (): void => {
      if (this.#previewJob === drained) { this.#previewJob = undefined; }
      if (this.#previewController === controller) { this.#previewController = undefined; }
    };
    void drained.then(cleanup, cleanup);
    return work.then(result => {
      this.assertCurrent(generation);
      if (externalSignal?.aborted) { throw unavailable(); }
      return result;
    }, error => { throw isPrivatePreviewGenerationCleanupFailure(error) ? error : unavailable(); });
  }

  async createPreviewResponse(
    generation: number, kind: PrivateHubPreviewKind, hash: string, request: Request,
    options: PrivateHubPreviewResponseOptions = {},
  ): Promise<Response> {
    let release: (() => void) | undefined;
    const isAuthorized = options.isAuthorized;
    const isCurrent = (): boolean => {
      try {
        return this.isCurrent(generation) && this.#hashes.has(hash)
          && (isAuthorized === undefined || isAuthorized() === true)
          && this.isCurrent(generation) && this.#hashes.has(hash);
      } catch { return false; }
    };
    try {
      this.assertCurrent(generation);
      if (kind !== 'thumbnail' && kind !== 'filmstrip' && kind !== 'clip-poster' && kind !== 'clip') { throw unavailable(); }
      release = this.reserveResponse(kind === 'clip' ? PRIVATE_HUB_MEDIA_CHUNK_BYTES : PRIVATE_HUB_MAX_IMAGE_BYTES);
      const onComplete = release;
      const response = await this.enqueue(generation, async store => {
        if (typeof hash !== 'string' || !HASH_PATTERN.test(hash) || !isCurrent()) { throw unavailable(); }
        if (kind === 'clip') {
          const mediaId = await resolvePrivatePreviewId(store, hash, kind);
          if (!isCurrent()) { throw unavailable(); }
          return createPrivateHubMediaResponse(store, mediaId, request, { isCurrent, contentType: 'video/mp4', onComplete });
        }
        return createPrivateHubImageResponse(store, kind, hash, request, { isCurrent, onComplete });
      }, response => { void response.body?.cancel().catch(() => undefined); });
      if (!isCurrent()) {
        void response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      if (!response.body) { release(); }
      return response;
    } catch { release?.(); throw unavailable(); }
  }

  private reserveResponse(bytes: number): () => void {
    if (this.#responseReservations.size >= MAX_OUTSTANDING_RESPONSES
      || this.#reservedResponseBytes + bytes > MAX_RESERVED_RESPONSE_BYTES) { throw unavailable(); }
    const release = (): void => {
      if (this.#responseReservations.delete(release)) { this.#reservedResponseBytes -= bytes; }
    };
    this.#responseReservations.add(release);
    this.#reservedResponseBytes += bytes;
    return release;
  }
}
