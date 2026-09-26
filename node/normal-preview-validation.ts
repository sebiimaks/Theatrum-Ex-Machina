import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { NormalOperationScope, normalOperationScope, type NormalOperationContext } from './normal-operation-scope';
import type { PreviewValidationInput } from './normal-preview-validation-worker';

type ValidationWorker = Pick<Worker, 'postMessage' | 'on' | 'terminate'>;
type WorkerFactory = () => ValidationWorker;
interface Lookup {
  id: number;
  input?: PreviewValidationInput;
  context: NormalOperationContext;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (value: string | undefined) => void;
  cancelled: boolean;
  settled: boolean;
}
interface WorkerState {
  worker: ValidationWorker;
  abort: () => void;
  active?: Lookup;
  stopping?: 'idle' | 'failure' | 'revoked';
  idle?: NodeJS.Timeout;
}

const MAX_LOOKUPS = 512;

/**
 * One lazy worker keeps preview validation out of filesystem scans' shared worker pool.
 * It performs synchronous filesystem calls only on its own thread. Both lookups and
 * the worker's complete lifetime (including idle time) belong to the normal epoch.
 */
export class NormalPreviewValidation {
  #worker?: WorkerState;
  #queue: Lookup[] = [];
  #pending = 0;
  #nextId = 0;

  constructor(
    private readonly scope: NormalOperationScope = normalOperationScope,
    private readonly workerFactory: WorkerFactory = () => new Worker(
      path.join(__dirname, 'normal-preview-validation-worker.js'), { execArgv: [] },
    ),
    private readonly idleTimeoutMs = 1000,
  ) {}

  resolve(filePath: string, outputDirectory: string, assetDirectory: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.#pending >= MAX_LOOKUPS || signal?.aborted || !this.scope.isCurrent()
      || (this.#worker?.stopping && this.#worker.stopping !== 'idle')) {
      return Promise.resolve(undefined);
    }
    this.#pending++;
    return this.scope.run(context => new Promise<string | undefined>(resolve => {
      const lookup: Lookup = {
        id: ++this.#nextId, input: { filePath, outputDirectory, assetDirectory }, context, signal,
        resolve, cancelled: false, settled: false, abort: () => {
          lookup.cancelled = true;
          lookup.input = undefined;
          // A running syscall cannot be cancelled early. Its lease lasts until
          // the reply or actual worker exit; queued work has not touched disk.
          if (this.#worker?.active !== lookup) {
            this.#queue = this.#queue.filter(item => item !== lookup);
            this.#settle(lookup);
          }
        },
      };
      signal?.addEventListener('abort', lookup.abort, { once: true });
      this.#queue.push(lookup);
      this.#pump();
    })).catch(() => undefined).finally(() => { this.#pending--; });
  }

  #settle(lookup: Lookup, value?: string): void {
    if (lookup.settled) { return; }
    lookup.settled = true;
    lookup.input = undefined;
    lookup.signal?.removeEventListener('abort', lookup.abort);
    lookup.resolve(!lookup.cancelled && lookup.context.isCurrent() && !lookup.signal?.aborted ? value : undefined);
  }

  #failQueue(): void {
    const queue = this.#queue;
    this.#queue = [];
    for (const lookup of queue) { this.#settle(lookup); }
  }

  #stop(state: WorkerState, reason: WorkerState['stopping']): void {
    if (this.#worker !== state) { return; }
    if (state.idle) { clearTimeout(state.idle); state.idle = undefined; }
    if (reason !== 'idle') { this.#failQueue(); }
    if (state.stopping) {
      if (reason !== 'idle') { state.stopping = reason; }
      return;
    }
    state.stopping = reason;
    // An error or terminate() result is not drain evidence. Only 'exit' ends
    // this worker's lease, even if native filesystem work delays termination.
    try { void state.worker.terminate().catch(() => undefined); } catch { /* Still await exit. */ }
  }

  #start(): void {
    void this.scope.run(context => new Promise<void>(finish => {
      let worker: ValidationWorker;
      try { worker = this.workerFactory(); }
      catch { this.#failQueue(); finish(); return; }
      const state: WorkerState = { worker, abort: () => this.#stop(state, 'revoked') };
      this.#worker = state;
      context.signal.addEventListener('abort', state.abort, { once: true });
      worker.on('message', (message: unknown) => {
        const active = state.active;
        if (this.#worker !== state || state.stopping) { return; }
        const reply = message as { id?: unknown; path?: unknown };
        if (!active || !reply || reply.id !== active.id || !(reply.path === null || (typeof reply.path === 'string'
          && reply.path.length <= 32768 && !reply.path.includes('\0') && path.isAbsolute(reply.path)))) {
          this.#stop(state, 'failure'); return;
        }
        state.active = undefined;
        this.#settle(active, typeof reply.path === 'string' ? reply.path : undefined);
        this.#pump();
      });
      worker.on('error', () => this.#stop(state, 'failure'));
      worker.on('exit', () => {
        context.signal.removeEventListener('abort', state.abort);
        if (state.idle) { clearTimeout(state.idle); }
        if (state.active) { this.#settle(state.active); state.active = undefined; }
        if (!state.stopping) { this.#failQueue(); }
        if (this.#worker === state) { this.#worker = undefined; }
        finish();
        // Requests arriving during idle termination wait until the old worker
        // has actually exited. A revoked epoch cannot start another worker.
        this.#pump();
      });
      if (!context.isCurrent()) { this.#stop(state, 'revoked'); }
      else { this.#pump(); }
    })).catch(() => { this.#failQueue(); });
  }

  #pump(): void {
    if (!this.scope.isCurrent()) { this.#failQueue(); return; }
    const state = this.#worker;
    if (!state) { if (this.#queue.length) { this.#start(); } return; }
    if (state.stopping || state.active) { return; }
    if (state.idle) { clearTimeout(state.idle); state.idle = undefined; }
    const lookup = this.#queue.shift();
    if (!lookup) {
      state.idle = setTimeout(() => this.#stop(state, 'idle'), this.idleTimeoutMs);
      state.idle.unref();
      return;
    }
    if (!lookup.input || !lookup.context.isCurrent() || lookup.signal?.aborted) {
      this.#settle(lookup); this.#pump(); return;
    }
    state.active = lookup;
    try { state.worker.postMessage({ id: lookup.id, ...lookup.input }); }
    catch { this.#stop(state, 'failure'); }
    finally { lookup.input = undefined; }
  }
}

export const normalPreviewValidation = new NormalPreviewValidation();
