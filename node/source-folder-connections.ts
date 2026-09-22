export interface SourceConnectionSource {
  index: number;
  path: string;
}

export interface SourceConnectionSession {
  generation: number;
  cataloguePath: string;
  sources: readonly SourceConnectionSource[];
}

export interface SourceFolderConnectionDependencies {
  captureSession(): SourceConnectionSession | undefined;
  isCurrent(session: SourceConnectionSession, source: SourceConnectionSource): boolean;
  probe(source: SourceConnectionSource): Promise<string | undefined>;
  authorize(
    session: SourceConnectionSession,
    source: SourceConnectionSource,
    canonicalPath: string,
  ): Promise<boolean>;
  connectionChanged(
    session: SourceConnectionSession,
    source: SourceConnectionSource,
    connected: boolean,
    canonicalPath?: string,
  ): void;
  reportError(error: unknown): void;
}

interface ObservedConnection {
  connected: boolean;
  canonicalPath?: string;
}

function sameCanonicalPath(left: string | undefined, right: string | undefined): boolean {
  return process.platform === 'win32'
    ? left?.toLocaleLowerCase('en-US') === right?.toLocaleLowerCase('en-US')
    : left === right;
}

/**
 * Detect source availability without granting filesystem authority itself.
 * The owner supplies the main-process permission review and schedules checks.
 */
export class SourceFolderConnections {
  private epoch = 0;
  private running: Promise<void> | undefined;
  private sessionKey: string | undefined;
  private readonly observed = new Map<string, ObservedConnection>();

  constructor(private readonly dependencies: SourceFolderConnectionDependencies) {}

  refresh(): Promise<void> {
    if (this.running) {
      return this.running;
    }

    const epoch = this.epoch;
    const run = this.checkSources(epoch)
      .catch((error: unknown) => this.dependencies.reportError(error))
      .finally(() => {
        if (this.running === run) {
          this.running = undefined;
        }
      });
    this.running = run;
    return run;
  }

  /** Invalidate pending work, including a permission dialog still awaiting input. */
  reset(): void {
    this.epoch++;
    this.sessionKey = undefined;
    this.observed.clear();
  }

  private async checkSources(epoch: number): Promise<void> {
    const captured = this.dependencies.captureSession();
    if (!captured) {
      this.sessionKey = undefined;
      this.observed.clear();
      return;
    }
    const session: SourceConnectionSession = {
      ...captured,
      sources: captured.sources.map(source => ({ ...source })),
    };
    const sessionKey = JSON.stringify([session.generation, session.cataloguePath]);
    if (sessionKey !== this.sessionKey) {
      this.sessionKey = sessionKey;
      this.observed.clear();
    }
    const sourceKeys = new Set(session.sources.map(source => this.sourceKey(source)));
    this.observed.forEach((_connection, key) => {
      if (!sourceKeys.has(key)) {
        this.observed.delete(key);
      }
    });

    // Serial reviews prevent several native permission dialogs from stacking.
    for (const source of session.sources) {
      if (!this.isCurrent(epoch, session, source)) {
        continue;
      }
      try {
        const canonicalPath = await this.dependencies.probe(source);
        if (!this.isCurrent(epoch, session, source)) {
          continue;
        }
        if (!canonicalPath) {
          this.publish(epoch, session, source, false);
          continue;
        }

        const previous = this.observed.get(this.sourceKey(source));
        if (previous?.connected && sameCanonicalPath(previous.canonicalPath, canonicalPath)) {
          continue;
        }
        if (previous?.connected) {
          this.publish(epoch, session, source, false);
        }
        if (!this.isCurrent(epoch, session, source)) {
          continue;
        }

        const allowed = await this.dependencies.authorize(session, source, canonicalPath);
        if (!this.isCurrent(epoch, session, source)) {
          continue;
        }
        if (!allowed) {
          this.publish(epoch, session, source, false);
          continue;
        }

        // A removable volume or symlink may change while a dialog is open.
        const confirmedPath = await this.dependencies.probe(source);
        if (!this.isCurrent(epoch, session, source)) {
          continue;
        }
        if (!confirmedPath || !sameCanonicalPath(canonicalPath, confirmedPath)) {
          this.publish(epoch, session, source, false);
          continue;
        }
        this.publish(epoch, session, source, true, confirmedPath);
      } catch (error) {
        if (this.isCurrent(epoch, session, source)) {
          this.publish(epoch, session, source, false);
          this.dependencies.reportError(error);
        }
      }
    }
  }

  private sourceKey(source: SourceConnectionSource): string {
    return JSON.stringify([source.index, source.path]);
  }

  private isCurrent(
    epoch: number,
    session: SourceConnectionSession,
    source: SourceConnectionSource,
  ): boolean {
    return this.epoch === epoch && this.dependencies.isCurrent(session, source);
  }

  private publish(
    epoch: number,
    session: SourceConnectionSession,
    source: SourceConnectionSource,
    connected: boolean,
    canonicalPath?: string,
  ): void {
    if (!this.isCurrent(epoch, session, source)) {
      return;
    }
    const key = this.sourceKey(source);
    const previous = this.observed.get(key);
    if (
      previous?.connected === connected
      && sameCanonicalPath(previous.canonicalPath, canonicalPath)
    ) {
      return;
    }
    this.observed.set(key, { connected, canonicalPath });
    this.dependencies.connectionChanged(session, source, connected, canonicalPath);
  }
}
