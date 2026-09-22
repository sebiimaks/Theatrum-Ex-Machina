import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PRIVATE_HUB_LOCK_FILE = '.private-hub.lock';
const HELPER = path.resolve(__dirname, '..', 'build', 'privacy-tools', 'private-hub-lock');
const HANDSHAKE_TIMEOUT_MS = 5_000;

export class PrivateHubLeaseError extends Error {
  readonly code = 'PRIVATE_HUB_LEASE_EXISTS';

  constructor() {
    super('This private hub already has an open storage session in another process.');
    this.name = 'PrivateHubLeaseError';
  }
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function canonicalDirectory(directory: string): Promise<fs.Stats> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.promises.realpath(directory) !== directory) {
    throw new Error('Private hub leases require a canonical directory without symbolic links.');
  }
  return stat;
}

/**
 * Local-filesystem advisory lock on an open-file description shared by parent
 * and native helper. The parent opens with O_NOFOLLOW; the helper validates the
 * inherited descriptor against its directory-relative path and acquires flock.
 * Helper death invalidates the session but the parent retains the OS lock until
 * queued IO drains. Parent death closes its descriptor and the helper's stdin;
 * EOF closes the final reference. There is no stale PID/timeout reclamation.
 * The empty lock inode is persistent and NEVER unlinked. This arbitrates
 * cooperating processes, not hostile same-user processes or network storage.
 */
export class PrivateHubLease {
  readonly #directory: string;
  readonly #root: fs.Stats;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #handle: fs.promises.FileHandle;
  readonly #closed: Promise<void>;
  #owned: { dev: number; ino: number } | undefined;
  #lost = false;
  readonly #lossController = new AbortController();
  #releaseCompletion: Promise<void> | undefined;

  private constructor(directory: string, root: fs.Stats, child: ChildProcessWithoutNullStreams, handle: fs.promises.FileHandle) {
    this.#directory = directory;
    this.#root = root;
    this.#child = child;
    this.#handle = handle;
    this.#closed = new Promise(resolve => {
      child.once('close', () => {
        this.lose();
        resolve();
      });
    });
    child.once('exit', () => { this.lose(); });
    child.once('error', () => { this.lose(); });
    child.stdin.on('error', () => { this.lose(); });
  }

  static async acquire(directory: string): Promise<PrivateHubLease> {
    if (!['darwin', 'linux'].includes(process.platform)) {
      throw new Error('Private hub storage currently requires macOS or Linux advisory locks.');
    }
    const root = await canonicalDirectory(directory);
    const handle = await fs.promises.open(path.join(directory, PRIVATE_HUB_LOCK_FILE),
      fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
    let child: ChildProcessWithoutNullStreams;
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.nlink !== 1 || file.size !== 0 || (file.mode & 0o077) !== 0
        || (process.geteuid && file.uid !== process.geteuid())
        || !sameFile(await canonicalDirectory(directory), root)) {
        throw new Error('Private hub storage locks require a private, empty regular file in the original directory.');
      }
      // FD 3 is a duplicate of this same open-file description. Keep the parent
      // FileHandle alive until release; helper death must not unlock pending IO.
      child = spawn(HELPER, [directory, String(root.dev), String(root.ino)], {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'pipe', handle.fd],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      await handle.close();
      throw error;
    }
    const lease = new PrivateHubLease(directory, root, child, handle);
    try {
      const owned = await new Promise<{ dev: number; ino: number }>((resolve, reject) => {
        let output = '';
        let settled = false;
        const timer = setTimeout(() => finish(new Error('Private hub lock helper startup timed out.')), HANDSHAKE_TIMEOUT_MS);
        const finish = (error?: Error, value?: { dev: number; ino: number }) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (error) {
            reject(error);
          } else if (value) {
            resolve(value);
          }
        };
        child.once('error', () => finish(new Error('Private hub lock helper is unavailable. Build the privacy tools first.')));
        child.once('close', () => finish(new Error('Private hub lock helper exited before acquiring the lock.')));
        child.stderr.on('data', () => {
          // Never propagate arbitrary helper output into logs or UI.
          if (!settled) {
            finish(new Error('Private hub lock helper reported an unexpected error.'));
          }
          lease.lose();
          child.kill('SIGKILL');
        });
        child.stdout.on('data', (bytes: Buffer) => {
          if (settled) {
            lease.lose();
            child.kill('SIGKILL');
            return;
          }
          output += bytes.toString('ascii');
          if (output.length > 128) {
            finish(new Error('Invalid private hub lock helper response.'));
            return;
          }
          if (!output.includes('\n')) {
            return;
          }
          if (output === 'UNSUPPORTED_FS\n') {
            finish(new Error('Private hubs currently require a supported local filesystem; network volumes are not supported.'));
            return;
          }
          if (output === 'BUSY\n') {
            finish(new PrivateHubLeaseError());
            return;
          }
          const match = /^READY ([0-9]+) ([0-9]+)\n$/.exec(output);
          const dev = match ? Number(match[1]) : NaN;
          const ino = match ? Number(match[2]) : NaN;
          if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) {
            finish(new Error('Private hub lock helper could not acquire a valid storage lock.'));
          } else {
            finish(undefined, { dev, ino });
          }
        });
      });
      lease.#owned = owned;
      await lease.assertOwned();
      return lease;
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  async assertOwned(): Promise<void> {
    this.assertLive();
    const root = await canonicalDirectory(this.#directory);
    if (!sameFile(root, this.#root)) {
      throw new Error('The private hub directory was replaced.');
    }
    const file = await fs.promises.lstat(path.join(this.#directory, PRIVATE_HUB_LOCK_FILE));
    const held = await this.#handle.stat();
    if (!sameFile(file, held) || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size !== 0
      || !this.#owned || file.dev !== this.#owned.dev || file.ino !== this.#owned.ino
      || (file.mode & 0o077) !== 0) {
      throw new Error('The private hub storage lock was replaced or changed.');
    }
    this.assertLive();
  }

  get lostSignal(): AbortSignal {
    return this.#lossController.signal;
  }

  private lose(): void {
    this.#lost = true;
    this.#lossController.abort();
  }

  private assertLive(): void {
    if (this.#lost || this.#releaseCompletion || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      throw new Error('The private hub storage lock was lost; close and reopen the hub.');
    }
  }

  /** Called after queued IO drains. Concurrent releases share one completion. */
  release(): Promise<void> {
    if (!this.#releaseCompletion) {
      this.#releaseCompletion = (async () => {
        const timer = setTimeout(() => this.#child.kill('SIGKILL'), HANDSHAKE_TIMEOUT_MS);
        try {
          try {
            this.#child.stdin.end();
          } catch {
            this.#child.kill('SIGKILL');
          }
          await this.#closed;
        } finally {
          clearTimeout(timer);
          // Never use LOCK_UN: the two duplicated descriptors share one flock.
          // This final parent close follows the owning store's queue drain.
          await this.#handle.close();
          this.lose();
        }
      })();
    }
    return this.#releaseCompletion;
  }
}
