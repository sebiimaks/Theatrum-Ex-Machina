export interface SourceScanOperationGuard {
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
  readonly operationTimeoutMs?: number;
  /** Own the actual native promise, even if the caller cancels or times out. */
  readonly trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
}

interface PendingOperation {
  started: boolean;
  settled: boolean;
  guard: SourceScanOperationGuard;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

function cancelled(): Error {
  const error = new Error('The source scan was cancelled or its authorization changed.');
  error.name = 'AbortError';
  return error;
}

/**
 * Bound native operations across scans, including cancelled scans whose OS IO
 * cannot be interrupted. A timed-out active operation retains its admission
 * slot until the actual filesystem promise settles; retries cannot multiply it.
 */
export class SourceScanIoGate {
  private readonly pending: PendingOperation[] = [];
  private active = 0;

  constructor(private readonly concurrency = 4, private readonly maxPending = 64) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1
      || !Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new Error('The source filesystem admission limits are invalid.');
    }
  }

  get state(): { active: number; pending: number } {
    return { active: this.active, pending: this.pending.length };
  }

  run<T>(guard: SourceScanOperationGuard, operation: () => Promise<T>): Promise<T> {
    if (guard.signal?.aborted || !guard.isCurrent()) {
      return Promise.reject(cancelled());
    }
    const timeoutMs = guard.operationTimeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('The source filesystem timeout is invalid.'));
    }
    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new Error('The source filesystem is still busy with earlier requests.'));
    }
    return new Promise<T>((resolve, reject) => {
      const task: PendingOperation = {
        started: false, settled: false, guard, operation,
        resolve: value => resolve(value as T), reject,
      };
      task.timeout = setTimeout(() => this.fail(task, new Error('The source filesystem operation timed out.')), timeoutMs);
      task.onAbort = () => this.fail(task, cancelled());
      guard.signal?.addEventListener('abort', task.onAbort, { once: true });
      this.pending.push(task);
      if (guard.signal?.aborted) {
        this.fail(task, cancelled());
      }
      this.drain();
    });
  }

  private clean(task: PendingOperation): void {
    clearTimeout(task.timeout);
    if (task.onAbort) {
      task.guard.signal?.removeEventListener('abort', task.onAbort);
    }
  }

  private fail(task: PendingOperation, error: Error): void {
    if (task.settled) {
      return;
    }
    task.settled = true;
    this.clean(task);
    if (!task.started) {
      const index = this.pending.indexOf(task);
      if (index !== -1) {
        this.pending.splice(index, 1);
      }
    }
    task.reject(error);
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task || task.settled) {
        continue;
      }
      if (task.guard.signal?.aborted || !task.guard.isCurrent()) {
        this.fail(task, cancelled());
        continue;
      }
      task.started = true;
      this.active++;
      void Promise.resolve().then(() => {
        if (!task.settled) {
          if (task.guard.signal?.aborted || !task.guard.isCurrent()) {
            throw cancelled();
          }
          // Capture native lifetime before invocation. Cancellation settles the
          // public wait, but never releases a private-transition drain early.
          const native = Promise.resolve().then(() => {
            if (task.guard.signal?.aborted || !task.guard.isCurrent()) {
              throw cancelled();
            }
            return task.operation();
          });
          return task.guard.trackOperation ? task.guard.trackOperation(native) : native;
        }
        return undefined;
      }).then(value => {
        if (task.settled) {
          return;
        }
        if (task.guard.signal?.aborted || !task.guard.isCurrent()) {
          this.fail(task, cancelled());
          return;
        }
        task.settled = true;
        this.clean(task);
        task.resolve(value);
      }, error => this.fail(task, error instanceof Error ? error : new Error(String(error))))
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}

// Shared by directory discovery, path validation and scan metadata checks.
export const sourceScanIo = new SourceScanIoGate();
