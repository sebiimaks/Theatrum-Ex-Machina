import type { RendererMutationLifetime } from './renderer-mutation-lifetime';

/** Keeps native results intact while the ordinary editor is paused. */
export class RendererIpcLifetime {
  private readonly deferred: (() => void)[] = [];

  constructor(
    private readonly mutations: RendererMutationLifetime,
    private readonly afterCurrentTask: (callback: () => void) => void = callback => { setTimeout(callback, 0); },
  ) {}

  invoke<T>(request: () => Promise<T>): Promise<T> {
    let release: () => void;
    try {
      release = this.mutations.holdPending();
      return Promise.resolve(request()).finally(() => {
        // The returned promise's .then/await consumers still have to apply the
        // durable result. Do not release in finally's earlier microtask.
        this.afterCurrentTask(release);
      });
    } catch (error) {
      release?.();
      return Promise.reject(error);
    }
  }

  deliver(callback: () => void): void {
    if (!this.mutations.accepting) {
      // A late normal response must neither mutate the frozen snapshot nor be
      // discarded. Prevent that snapshot from clearing the dirty revision.
      this.mutations.changed();
      this.deferred.push(callback);
      return;
    }
    callback();
  }

  drain(): void {
    this.mutations.assertAccepting();
    while (this.deferred.length) {
      // Never repeat a partly-applied callback after a failure.
      const callback = this.deferred.shift()!;
      try { callback(); } catch (error) {
        this.mutations.quarantine();
        throw error;
      }
    }
  }
}
