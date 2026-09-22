import { performance } from 'node:perf_hooks';
import { isPrivateHubAutoLockMinutes, PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES,
  type PrivateHubAutoLockMinutes } from '../interfaces/private-hub-protection';

export interface PrivateHubIdleLockOptions {
  readonly minutes?: PrivateHubAutoLockMinutes;
  readonly isCurrent: () => boolean;
  /** Synchronous main-owned revocation. This controller never renews its lifetime. */
  readonly onLock: () => void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly clear?: (handle: unknown) => void;
}

interface ScheduledLock {
  ready: boolean;
  handle?: unknown;
}

/** Main-owned inactivity deadline; renderer IPC is never evidence of activity. */
export class PrivateHubIdleLock {
  readonly #isCurrent: () => boolean;
  readonly #onLock: () => void;
  readonly #now: () => number;
  readonly #schedule: NonNullable<PrivateHubIdleLockOptions['schedule']>;
  readonly #clear: NonNullable<PrivateHubIdleLockOptions['clear']>;
  #minutes: PrivateHubAutoLockMinutes = PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES;
  #lastActivity = 0;
  #observed: number | undefined;
  #timer: ScheduledLock | undefined;
  #active = true;
  #notified = false;
  #checking = false;
  #managingTimer = false;

  constructor(options: PrivateHubIdleLockOptions) {
    if (!options || typeof options.isCurrent !== 'function' || typeof options.onLock !== 'function') {
      throw new Error('Private hub automatic lock is unavailable.');
    }
    this.#isCurrent = options.isCurrent;
    this.#onLock = options.onLock;
    this.#now = options.now ?? (() => performance.now());
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#clear = options.clear ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const minutes = options.minutes === undefined ? PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES : options.minutes;
    if (!isPrivateHubAutoLockMinutes(minutes) || typeof this.#now !== 'function'
      || typeof this.#schedule !== 'function' || typeof this.#clear !== 'function') {
      this.retire(true);
      return;
    }
    this.#minutes = minutes;
    const now = this.observe();
    if (now === undefined) { return; }
    this.#lastActivity = now;
    this.reschedule(now);
  }

  /** Expiration is checked before activity can move the deadline. */
  activity(): boolean {
    const now = this.observeBeforeDeadline();
    if (now === undefined) { return false; }
    this.#lastActivity = now;
    return this.reschedule(now);
  }

  /** Gate main-owned operations without extending inactivity. */
  check(): boolean { return this.observeBeforeDeadline() !== undefined; }

  /** Preserve elapsed inactivity and reject attempts to change an expired policy. */
  setMinutes(minutes: PrivateHubAutoLockMinutes): boolean {
    const now = this.observeBeforeDeadline();
    if (now === undefined) { return false; }
    if (!isPrivateHubAutoLockMinutes(minutes)) { this.retire(true); return false; }
    this.#minutes = minutes;
    if (this.expired(now)) { this.retire(true); return false; }
    return this.reschedule(now);
  }

  dispose(): void { this.retire(false); }

  private expired(now: number): boolean {
    return this.#minutes !== 0 && now - this.#lastActivity >= this.#minutes * 60_000;
  }

  private observeBeforeDeadline(): number | undefined {
    const now = this.observe();
    if (now === undefined) { return; }
    if (this.expired(now)) { this.retire(true); return; }
    return now;
  }

  private observe(): number | undefined {
    if (!this.#active) { return; }
    if (this.#checking || this.#managingTimer) { this.retire(true); return; }
    this.#checking = true;
    try {
      const before = this.#isCurrent();
      if (before !== true) { this.retire(before !== false); return; }
      if (!this.#active) { return; }
      const now = this.#now();
      if (typeof now !== 'number' || !Number.isFinite(now) || now < 0
        || (this.#observed !== undefined && now < this.#observed)) { this.retire(true); return; }
      const after = this.#isCurrent();
      if (after !== true) { this.retire(after !== false); return; }
      if (!this.#active) { return; }
      this.#observed = now;
      return now;
    } catch { this.retire(true); return; }
    finally { this.#checking = false; }
  }

  private clearTimer(): boolean {
    const timer = this.#timer;
    this.#timer = undefined;
    if (!timer?.ready) { return true; }
    try { this.#clear(timer.handle); return true; }
    catch { return false; }
  }

  private retire(lock: boolean): void {
    this.#active = false;
    if (!this.clearTimer()) { lock = true; }
    if (!lock || this.#notified) { return; }
    this.#notified = true;
    try { this.#onLock(); }
    catch { /* Local authority remains permanently retired even if its observer fails. */ }
  }

  private reschedule(now: number): boolean {
    if (!this.#active) { return false; }
    if (this.#managingTimer) { this.retire(true); return false; }
    this.#managingTimer = true;
    try {
      if (!this.clearTimer()) { this.retire(true); return false; }
      if (!this.#active) { return false; }
      if (this.#minutes === 0) { return true; }
      const delay = this.#minutes * 60_000 - (now - this.#lastActivity);
      if (!Number.isFinite(delay) || delay <= 0) { this.retire(true); return false; }
      const timer: ScheduledLock = { ready: false };
      this.#timer = timer;
      let handle: unknown;
      try {
        handle = this.#schedule(() => {
          if (this.#timer !== timer || !this.#active) { return; }
          if (!timer.ready || this.#managingTimer) { this.retire(true); return; }
          this.#timer = undefined;
          const current = this.observeBeforeDeadline();
          if (current !== undefined) { this.reschedule(current); }
        }, delay);
      } catch { this.retire(true); return false; }
      if (handle === undefined || handle === null) { this.retire(true); return false; }
      timer.handle = handle;
      timer.ready = true;
      if (!this.#active || this.#timer !== timer) {
        // A synchronous/reentrant adapter may have retired us before returning
        // its handle. Its eventual callback is stale; still clear the timer.
        try { this.#clear(handle); }
        catch { this.retire(true); }
        return false;
      }
      return true;
    } finally { this.#managingTimer = false; }
  }
}
