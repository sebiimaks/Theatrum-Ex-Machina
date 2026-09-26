import { AsyncLocalStorage } from 'node:async_hooks';

/** Main-only evidence that one sealed normal-operation epoch has fully settled. */
export interface NormalOperationDrain { readonly drained: true; }

export interface NormalOperationContext {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
}

export class NormalOperationUnavailableError extends Error {
  constructor() { super('The normal catalogue operation is no longer available.'); }
}

interface Lease { epoch: AbortController; active: boolean; }

/**
 * Tracks complete normal operations, including native dialog and callback work.
 * Callers must return their entire operation. A fire-and-forget child is not
 * drainable; its inherited context nevertheless loses authority on completion.
 * Never await seal() from within a tracked operation: it would await itself.
 */
export class NormalOperationScope {
  #epoch = new AbortController();
  #accepting = true;
  #leases = new AsyncLocalStorage<Lease>();
  #pending = new Set<Promise<void>>();
  #draining?: Promise<NormalOperationDrain>;
  #proofs = new WeakMap<object, AbortController>();

  get accepting(): boolean { return this.#accepting; }
  get inOperation(): boolean { return this.#leases.getStore()?.active === true; }
  get pendingCount(): number { return this.#pending.size; }

  isCurrent(): boolean {
    const lease = this.#leases.getStore();
    return this.#accepting && !this.#epoch.signal.aborted
      && (!lease || (lease.active && lease.epoch === this.#epoch));
  }

  assertCurrent(): void {
    if (!this.isCurrent()) { throw new NormalOperationUnavailableError(); }
  }

  run<T>(operation: (context: NormalOperationContext) => T | PromiseLike<T>): Promise<T> {
    if (!this.isCurrent()) { return Promise.reject(new NormalOperationUnavailableError()); }
    const lease: Lease = { epoch: this.#epoch, active: true };
    const current = (): boolean => this.#accepting && lease.active
      && lease.epoch === this.#epoch && !lease.epoch.signal.aborted;
    const context: NormalOperationContext = Object.freeze({
      signal: lease.epoch.signal,
      isCurrent: current,
      assertCurrent: (): void => { if (!current()) { throw new NormalOperationUnavailableError(); } },
    });
    let settled!: () => void;
    const reservation = new Promise<void>(resolve => { settled = resolve; });
    this.#pending.add(reservation);
    let result: T | PromiseLike<T>;
    try { result = this.#leases.run(lease, () => operation(context)); }
    catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).finally(() => {
      lease.active = false;
      this.#pending.delete(reservation);
      settled();
    });
  }

  seal(): Promise<NormalOperationDrain> {
    if (this.#draining) { return this.#draining; }
    this.#accepting = false;
    const epoch = this.#epoch;
    this.#draining = Promise.all(Array.from(this.#pending)).then(() => {
      const proof: NormalOperationDrain = Object.freeze({ drained: true });
      this.#proofs.set(proof, epoch);
      return proof;
    });
    // Admission closes before abort listeners run, including reentrant callers.
    epoch.abort();
    return this.#draining;
  }

  assertDrained(proof: NormalOperationDrain): void {
    if (!proof || this.#accepting || this.#pending.size !== 0
      || this.#proofs.get(proof) !== this.#epoch || !this.#epoch.signal.aborted) {
      throw new NormalOperationUnavailableError();
    }
  }

  resume(proof: NormalOperationDrain): void {
    this.assertDrained(proof);
    this.#proofs.delete(proof);
    this.#epoch = new AbortController();
    this.#draining = undefined;
    this.#accepting = true;
  }
}

export const normalOperationScope = new NormalOperationScope();
