import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_SOURCE_GRANTS = 256;
const MAX_PATH_LENGTH = 32_768;

export interface PrivateSourceAccessOptions {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  /** Native picker owned by the private window; never a renderer-supplied path. */
  readonly chooseDirectory: (root: string) => Promise<string | undefined>;
}
export type PrivateSourceAccessResult = { status: 'granted'; isCurrent: () => boolean }
  | { status: 'cancelled' | 'busy' | 'wrong-folder' | 'source-unavailable' | 'unavailable' };
interface Grant {
  readonly root: string;
  readonly dev: bigint;
  readonly ino: bigint;
  revoked: boolean;
}

function rootPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH
    || value.includes('\0') || !path.isAbsolute(value)) { return; }
  const root = path.resolve(value);
  return root !== path.parse(root).root ? root : undefined;
}

/**
 * Main-only folder grants, retained solely for one private browser lifetime.
 * A catalogue path is a request, never permission. Before its first native
 * selection this class performs no filesystem probe on that requested path.
 */
export class PrivateSourceAccess {
  readonly #signal: AbortSignal;
  readonly #isCurrent: () => boolean;
  readonly #chooseDirectory: PrivateSourceAccessOptions['chooseDirectory'];
  readonly #grants = new Map<string, Grant>();
  #disposed = false;
  #checkingOwner = false;
  #pending: Promise<void> | undefined;

  constructor(options: PrivateSourceAccessOptions) {
    if (!(options?.signal instanceof AbortSignal) || typeof options.isCurrent !== 'function'
      || typeof options.chooseDirectory !== 'function') { throw new Error('Private source access is unavailable.'); }
    this.#signal = options.signal;
    this.#isCurrent = options.isCurrent;
    this.#chooseDirectory = options.chooseDirectory;
    this.#signal.addEventListener('abort', this.#onAbort, { once: true });
    if (this.#signal.aborted) { this.revoke(); }
  }

  readonly #onAbort = (): void => { this.revoke(); };

  private revoke(): void {
    if (this.#disposed) { return; }
    this.#disposed = true;
    this.#signal.removeEventListener('abort', this.#onAbort);
    for (const grant of this.#grants.values()) { grant.revoked = true; }
    this.#grants.clear();
  }

  private ownerCurrent(): boolean {
    if (this.#disposed || this.#signal.aborted || this.#checkingOwner) { return false; }
    this.#checkingOwner = true;
    let current = false;
    try { current = this.#isCurrent() === true && !this.#disposed && !this.#signal.aborted; }
    catch { /* Never expose native/private diagnostics. */ }
    finally { this.#checkingOwner = false; }
    if (!current) { this.revoke(); }
    return current;
  }

  private identity(root: string): Pick<Grant, 'dev' | 'ino'> | undefined {
    try {
      const stat = fs.lstatSync(root, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) { return; }
      return { dev: stat.dev, ino: stat.ino };
    } catch { return; }
  }

  private grantCurrent(grant: Grant): boolean {
    if (grant.revoked || this.#grants.get(grant.root) !== grant) { return false; }
    const identity = this.identity(grant.root);
    if (!identity || identity.dev !== grant.dev || identity.ino !== grant.ino) {
      grant.revoked = true;
      this.#grants.delete(grant.root);
      return false;
    }
    return !grant.revoked && this.#grants.get(grant.root) === grant;
  }

  authorize(root: string, signal: AbortSignal, isCurrent: () => boolean): Promise<PrivateSourceAccessResult> {
    const requested = rootPath(root);
    let operationRevoked = false;
    let checkingOperation = false;
    const current = (): boolean => {
      if (operationRevoked || checkingOperation) { return false; }
      checkingOperation = true;
      let allowed = false;
      try {
        allowed = this.ownerCurrent() && signal instanceof AbortSignal && !signal.aborted
          && typeof isCurrent === 'function' && isCurrent() === true
          && this.ownerCurrent() && !signal.aborted;
      } catch { /* A failed authority predicate never authorizes. */ }
      finally { checkingOperation = false; }
      if (!allowed) { operationRevoked = true; }
      return allowed;
    };
    const granted = (grant: Grant): PrivateSourceAccessResult => ({ status: 'granted',
      // Operation cancellation leaves a still-valid folder cached for a future
      // explicit action, but this operation's authority never comes back.
      isCurrent: () => current() && this.grantCurrent(grant) && current(),
    });
    if (!requested || !current()) { return Promise.resolve({ status: 'unavailable' }); }
    if (this.#pending) { return Promise.resolve({ status: 'busy' }); }
    const cached = this.#grants.get(requested);
    if (cached) {
      const valid = this.grantCurrent(cached);
      if (!current()) { return Promise.resolve({ status: 'unavailable' }); }
      return Promise.resolve().then(() => current()
        ? valid ? granted(cached) : { status: 'source-unavailable' } as const
        : { status: 'unavailable' } as const);
    }
    if (this.#grants.size >= MAX_SOURCE_GRANTS) { return Promise.resolve({ status: 'busy' }); }
    // Register pending work before invoking the native adapter. Disposing even
    // from inside that adapter must wait for its uninterruptible dialog result.
    const work = Promise.resolve().then(async (): Promise<PrivateSourceAccessResult> => {
      if (!current()) { return { status: 'unavailable' }; }
      let selected: string | undefined;
      try { selected = await this.#chooseDirectory(requested); }
      catch { return { status: 'unavailable' }; }
      if (!current()) { return { status: 'unavailable' }; }
      if (selected === undefined) { return { status: 'cancelled' }; }
      if (rootPath(selected) !== requested) { return { status: 'wrong-folder' }; }
      const identity = this.identity(requested);
      if (!current()) { return { status: 'unavailable' }; }
      if (!identity) { return { status: 'source-unavailable' }; }
      const grant: Grant = { root: requested, ...identity, revoked: false };
      this.#grants.set(requested, grant);
      return granted(grant);
    });
    const completed = work.then(result => {
      try { return current() ? result : { status: 'unavailable' } as const; }
      finally { if (this.#pending === pending) { this.#pending = undefined; } }
    }, () => {
      if (this.#pending === pending) { this.#pending = undefined; }
      return { status: 'unavailable' } as const;
    });
    const pending = completed.then(() => undefined, () => undefined);
    this.#pending = pending;
    return completed;
  }

  /** Revoke synchronously, then drain any native dialog before normal mode resumes. */
  dispose(): Promise<void> {
    this.revoke();
    return this.#pending ?? Promise.resolve();
  }
}
