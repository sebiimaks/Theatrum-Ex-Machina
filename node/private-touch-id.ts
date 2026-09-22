import { join } from 'node:path';
import type * as Electron from 'electron';

export interface PrivateTouchIdProvider {
  availability(): Promise<'available' | 'unavailable'>;
  has(identity: string): Promise<boolean>;
  /** Input remains caller-owned; this provider wipes its own copy. */
  enroll(identity: string, secret: Buffer, signal: AbortSignal): Promise<'enrolled' | 'cancelled' | 'unavailable'>;
  /** The caller owns, and must wipe, a successfully returned secret. */
  unlock(identity: string, signal: AbortSignal): Promise<Buffer | undefined>;
  /** True also means an already absent entry was positively confirmed absent. */
  remove(identity: string, signal: AbortSignal): Promise<boolean>;
}

type NativeOperation = 'availability' | 'has' | 'enroll' | 'unlock' | 'remove';
type NativeStatus = 'available' | 'unavailable' | 'present' | 'absent' | 'enrolled' | 'cancelled'
  | 'secret' | 'removed' | 'missing' | 'error' | 'cleanup-failed';
export interface PrivateTouchIdNativeResult {
  readonly status: NativeStatus;
  readonly secret?: Buffer;
}
export interface PrivateTouchIdNativeBinding {
  begin(operation: NativeOperation, identity: string, secret?: Buffer): {
    readonly operation: number;
    readonly result: Promise<PrivateTouchIdNativeResult>;
  };
  cancel(operation: number): void;
  /** Enrollment is provisional until this acknowledgment; rejecting rolls back only its own item. */
  finishEnrollment(operation: number, accept: boolean): Promise<PrivateTouchIdNativeResult>;
}
export interface PrivateTouchIdProviderOptions {
  readonly platform?: NodeJS.Platform;
  readonly loadNative?: () => PrivateTouchIdNativeBinding | undefined;
  readonly timeoutMs?: number;
}

const cleanupFailures = new WeakSet<object>();
export function createPrivateTouchIdCleanupFailure(): Error {
  const error = new Error('Touch ID cleanup could not be confirmed.');
  cleanupFailures.add(error);
  return error;
}
export function isPrivateTouchIdCleanupFailure(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && cleanupFailures.has(error);
}
function unavailable(): Error { return new Error('Touch ID is unavailable.'); }
function defaultLoader(): PrivateTouchIdNativeBinding | undefined {
  // This module is main-owned. No renderer or ordinary Node process loads the
  // addon, and neither paths nor native method names come from an IPC payload.
  if (!process.versions.electron || process.type !== 'browser') { return undefined; }
  const { app } = require('electron') as typeof Electron;
  const root = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'build');
  return require(join(root, 'privacy-tools', 'private-touch-id.node')) as PrivateTouchIdNativeBinding;
}
function identityValid(identity: unknown): identity is string {
  return typeof identity === 'string' && /^[0-9a-f]{64}$/.test(identity);
}
function signalValid(signal: unknown): signal is AbortSignal { return signal instanceof AbortSignal; }
function wipe(result: unknown): void {
  if (result && typeof result === 'object' && Buffer.isBuffer((result as PrivateTouchIdNativeResult).secret)) {
    (result as PrivateTouchIdNativeResult).secret!.fill(0);
  }
}

/** Device-local Keychain access; never calls a command-line tool or logs native errors. */
export function createPrivateTouchIdProvider(options: PrivateTouchIdProviderOptions = {}): PrivateTouchIdProvider {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) { throw unavailable(); }
  let native: PrivateTouchIdNativeBinding | undefined;
  let loaded = false;
  let busy = false;
  let poisoned = false;
  const poison = (): Error => { poisoned = true; return createPrivateTouchIdCleanupFailure(); };
  const load = (): PrivateTouchIdNativeBinding | undefined => {
    if (platform !== 'darwin') { return undefined; }
    if (!loaded) {
      loaded = true;
      try {
        const value = (options.loadNative ?? defaultLoader)();
        if (value && typeof value.begin === 'function' && typeof value.cancel === 'function'
          && typeof value.finishEnrollment === 'function') { native = value; }
      } catch { /* Missing or un-loadable signed support offers password unlock. */ }
    }
    return native;
  };
  async function run(kind: NativeOperation, identity: string, signal?: AbortSignal, secret?: Buffer): Promise<PrivateTouchIdNativeResult> {
    if (poisoned) { throw createPrivateTouchIdCleanupFailure(); }
    if (busy) { throw unavailable(); }
    busy = true;
    let owned: Buffer | undefined;
    let result: PrivateTouchIdNativeResult | undefined;
    let operation: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = signal?.aborted ?? false;
    let cancellationFailed = false;
    let safeNativeFailure = false;
    let binding: PrivateTouchIdNativeBinding | undefined;
    const cancel = (): void => {
      cancelled = true;
      if (binding && operation !== undefined) {
        try { binding.cancel(operation); } catch { cancellationFailed = true; poisoned = true; }
      }
    };
    try {
      if (cancelled) { return { status: 'cancelled' }; }
      binding = load();
      if (!binding) { return { status: 'unavailable' }; }
      owned = secret && Buffer.from(secret);
      signal?.addEventListener('abort', cancel, { once: true });
      // Starting native work copies the bounded buffer synchronously. Keep the
      // reservation until native cancellation/rollback has actually completed.
      const request = binding.begin(kind, identity, owned);
      if (!request || !Number.isSafeInteger(request.operation) || request.operation < 1
        || !(request.result instanceof Promise)) { throw poison(); }
      operation = request.operation;
      owned?.fill(0);
      if (signal?.aborted) { cancel(); }
      timer = setTimeout(cancel, timeoutMs);
      result = await request.result;
      if (!result || typeof result !== 'object' || !['available', 'unavailable', 'present', 'absent', 'enrolled',
        'cancelled', 'secret', 'removed', 'missing', 'error', 'cleanup-failed'].includes(result.status)) { throw poison(); }
      if (result.status === 'cleanup-failed' || cancellationFailed) { throw poison(); }
      if (kind === 'enroll' && result.status === 'enrolled') {
        wipe(result);
        // This synchronous call is the enrollment commit point. An abort after
        // its acceptance belongs to the caller's subsequent lifecycle cleanup.
        result = await binding.finishEnrollment(operation, !cancelled && !signal?.aborted);
        if (!result || !['enrolled', 'cancelled', 'cleanup-failed'].includes(result.status)) { throw poison(); }
        if (result.status === 'cleanup-failed' || cancellationFailed) { throw poison(); }
        return { status: result.status };
      }
      if (result.status === 'error') { safeNativeFailure = true; throw unavailable(); }
      if (result.status === 'enrolled') { throw poison(); }
      if (cancelled && result.status !== 'removed' && result.status !== 'absent') { return { status: 'cancelled' }; }
      if (result.status === 'secret') {
        if (kind !== 'unlock' || !Buffer.isBuffer(result.secret) || result.secret.length !== 64) { throw poison(); }
        return { status: 'secret', secret: Buffer.from(result.secret) };
      }
      if (result.secret !== undefined) { throw poison(); }
      return { status: result.status };
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'PRIVATE_TOUCH_ID_CLEANUP_FAILED') { throw poison(); }
      if (isPrivateTouchIdCleanupFailure(error) || cancellationFailed || poisoned) { throw poison(); }
      // A native throw/rejection during a mutating operation cannot establish
      // whether a Keychain write/delete was rolled back.
      if (!safeNativeFailure && (kind === 'enroll' || kind === 'remove') && operation !== undefined) { throw poison(); }
      throw unavailable();
    } finally {
      if (timer) { clearTimeout(timer); }
      signal?.removeEventListener('abort', cancel);
      owned?.fill(0);
      wipe(result);
      busy = false;
    }
  }
  const assertIdentity = (identity: string): void => { if (!identityValid(identity)) { throw unavailable(); } };
  const assertSignal = (signal: AbortSignal): void => { if (!signalValid(signal)) { throw unavailable(); } };
  return Object.freeze({
    async availability() {
      const result = await run('availability', '');
      if (result.status === 'available') { return 'available'; }
      if (['unavailable', 'cancelled'].includes(result.status)) { return 'unavailable'; }
      throw poison();
    },
    async has(identity: string) {
      assertIdentity(identity);
      const result = await run('has', identity);
      if (result.status === 'present') { return true; }
      if (['absent', 'unavailable', 'cancelled'].includes(result.status)) { return false; }
      throw poison();
    },
    async enroll(identity: string, secret: Buffer, signal: AbortSignal) {
      assertIdentity(identity); assertSignal(signal);
      if (!Buffer.isBuffer(secret) || secret.length !== 64) { throw unavailable(); }
      const result = await run('enroll', identity, signal, secret);
      if (result.status === 'enrolled' || result.status === 'cancelled' || result.status === 'unavailable') { return result.status; }
      throw poison();
    },
    async unlock(identity: string, signal: AbortSignal) {
      assertIdentity(identity); assertSignal(signal);
      const result = await run('unlock', identity, signal);
      if (result.status === 'secret') { return result.secret!; }
      if (['missing', 'unavailable', 'cancelled'].includes(result.status)) { return undefined; }
      wipe(result); throw poison();
    },
    async remove(identity: string, signal: AbortSignal) {
      assertIdentity(identity); assertSignal(signal);
      const result = await run('remove', identity, signal);
      if (result.status === 'removed' || result.status === 'absent') { return true; }
      if (['unavailable', 'cancelled'].includes(result.status)) { return false; }
      throw poison();
    },
  });
}
