import type { FinalObject } from '../../../interfaces/final-object.interface';
import type { CatalogueAccessMode } from '../../../interfaces/catalogue-session';
import { isLegacyCatalogueFilePath } from '../../../interfaces/catalogue-file';

export type { CatalogueAccessMode } from '../../../interfaces/catalogue-session';
export type CatalogueOpenIntent = CatalogueAccessMode | 'duplicate-scaena';
export type LegacyCatalogueOpenChoice = Exclude<CatalogueOpenIntent, 'read-write'>;

export interface CatalogueOpenRequest {
  acknowledgeExternalRequest: boolean;
  fullPath: string;
}

export interface CatalogueOpenCoordinatorHooks {
  canBeginOpen(): boolean;
  chooseLegacyCatalogueOpen(fullPath: string): Promise<LegacyCatalogueOpenChoice | undefined>;
  getCurrentCatalogueForSave(): FinalObject | null;
  legacyOpenCancelled?(fullPath: string): void;
}

export interface CatalogueOpenCoordinatorTransport {
  acknowledgeExternalRequest(): void;
  loadCatalogue(
    fullPath: string,
    currentCatalogue: FinalObject | null,
    intent: CatalogueOpenIntent,
  ): void;
  markRendererStartupComplete(): void;
}

export interface CatalogueOpenScheduler {
  cancel(handle: unknown): void;
  schedule(task: () => void): unknown;
}

const defaultScheduler: CatalogueOpenScheduler = {
  cancel: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (task: () => void): ReturnType<typeof setTimeout> => setTimeout(task, 0),
};

/**
 * Serializes catalogue-open requests without depending on Angular or Electron.
 * UI decisions and privileged operations are supplied through narrow ports so
 * this state machine can be exercised independently of HomeComponent.
 */
export class CatalogueOpenCoordinator {

  private backupNoticeOpen = false;
  private hooks: CatalogueOpenCoordinatorHooks | undefined;
  private legacyDecisionRequest: CatalogueOpenRequest | null = null;
  private openInFlight = false;
  private pendingRequests: CatalogueOpenRequest[] = [];
  private queueDrainHandle: unknown;
  private rendererStartupComplete = false;
  private sessionGeneration = 0;

  constructor(
    private readonly transport: CatalogueOpenCoordinatorTransport,
    private readonly scheduler: CatalogueOpenScheduler = defaultScheduler,
  ) {}

  connect(hooks: CatalogueOpenCoordinatorHooks): void {
    this.disconnect();
    this.hooks = hooks;
  }

  disconnect(): void {
    this.sessionGeneration += 1;
    if (this.queueDrainHandle !== undefined) {
      this.scheduler.cancel(this.queueDrainHandle);
    }
    const requestsRequiringAcknowledgement = [
      this.legacyDecisionRequest,
      ...this.pendingRequests,
    ].filter((request): request is CatalogueOpenRequest => request !== null);
    this.backupNoticeOpen = false;
    this.hooks = undefined;
    this.legacyDecisionRequest = null;
    this.openInFlight = false;
    this.pendingRequests = [];
    this.queueDrainHandle = undefined;
    this.rendererStartupComplete = false;
    requestsRequiringAcknowledgement.forEach((request: CatalogueOpenRequest) => {
      this.acknowledgeExternalOpen(request);
    });
  }

  requestOpen(fullPath: string, acknowledgeExternalRequest = false): void {
    const request: CatalogueOpenRequest = {
      acknowledgeExternalRequest,
      fullPath,
    };
    const hooks = this.requireHooks();

    if (!hooks.canBeginOpen()) {
      this.acknowledgeExternalOpen(request);
      return;
    }

    if (this.isBusy()) {
      this.pendingRequests.push(request);
      return;
    }

    if (!isLegacyCatalogueFilePath(request.fullPath)) {
      this.openInFlight = true;
      this.dispatchOpen(request.fullPath, 'read-write');
      this.acknowledgeExternalOpen(request);
      return;
    }

    this.beginLegacyDecision(request);
  }

  finishOpen(): void {
    this.openInFlight = false;
    this.schedulePendingOpen();
  }

  markRendererStartupComplete(): void {
    if (this.rendererStartupComplete) {
      return;
    }
    this.rendererStartupComplete = true;
    this.transport.markRendererStartupComplete();
  }

  setBackupNoticeOpen(open: boolean): void {
    this.backupNoticeOpen = open;
    if (!open) {
      this.schedulePendingOpen();
    }
  }

  private acknowledgeExternalOpen(request: CatalogueOpenRequest): void {
    if (request.acknowledgeExternalRequest) {
      request.acknowledgeExternalRequest = false;
      this.transport.acknowledgeExternalRequest();
    }
  }

  private beginLegacyDecision(request: CatalogueOpenRequest): void {
    const hooks = this.requireHooks();
    const decisionGeneration = this.sessionGeneration;
    this.legacyDecisionRequest = request;
    // Startup is ready once the first decision is visible. This avoids leaving
    // Finder/second-instance requests stranded if the user cancels it.
    this.markRendererStartupComplete();

    void hooks.chooseLegacyCatalogueOpen(request.fullPath)
      .then((choice: LegacyCatalogueOpenChoice | undefined) => {
        if (decisionGeneration !== this.sessionGeneration || !this.hooks) {
          return;
        }
        this.legacyDecisionRequest = null;
        if (choice) {
          this.openInFlight = true;
          this.dispatchOpen(request.fullPath, choice);
        } else {
          this.hooks.legacyOpenCancelled?.(request.fullPath);
        }
        this.acknowledgeExternalOpen(request);
        if (!choice) {
          this.schedulePendingOpen();
        }
      })
      .catch(() => {
        if (decisionGeneration !== this.sessionGeneration || !this.hooks) {
          return;
        }
        this.legacyDecisionRequest = null;
        this.acknowledgeExternalOpen(request);
        this.schedulePendingOpen();
      });
  }

  private dispatchOpen(fullPath: string, intent: CatalogueOpenIntent): void {
    this.transport.loadCatalogue(
      fullPath,
      this.requireHooks().getCurrentCatalogueForSave(),
      intent,
    );
  }

  private isBusy(): boolean {
    return (
      this.openInFlight
      || this.queueDrainHandle !== undefined
      || this.legacyDecisionRequest !== null
      || this.backupNoticeOpen
    );
  }

  private requireHooks(): CatalogueOpenCoordinatorHooks {
    if (!this.hooks) {
      throw new Error('CatalogueOpenCoordinator must be connected before use.');
    }
    return this.hooks;
  }

  private schedulePendingOpen(): void {
    if (this.isBusy() || this.pendingRequests.length === 0) {
      return;
    }

    const drainGeneration = this.sessionGeneration;
    this.queueDrainHandle = this.scheduler.schedule(() => {
      this.queueDrainHandle = undefined;
      if (
        drainGeneration !== this.sessionGeneration
        || !this.hooks
        || this.openInFlight
        || this.legacyDecisionRequest !== null
        || this.backupNoticeOpen
      ) {
        return;
      }
      const nextRequest = this.pendingRequests.shift();
      if (nextRequest) {
        this.requestOpen(
          nextRequest.fullPath,
          nextRequest.acknowledgeExternalRequest,
        );
      }
    });
  }
}
