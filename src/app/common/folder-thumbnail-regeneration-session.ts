import type {
  FolderThumbnailRegenerationProgress,
} from '../../../interfaces/thumbnail-regeneration';

export interface FolderThumbnailRegenerationStatus {
  readonly cancelling?: boolean;
  readonly completedJobs: number;
  readonly relativePath?: string;
  readonly sourceIndex: number;
  readonly totalJobs: number;
}

export interface FolderThumbnailRegenerationBeginInput {
  readonly hubFile: string;
  readonly relativePath: string;
  readonly skippedVideos: number;
  readonly sourceFolderPath: string;
  readonly sourceIndex: number;
  readonly totalJobs: number;
  readonly videoCountsByHash: ReadonlyMap<string, number>;
}

export interface FolderThumbnailRegenerationProgressInput {
  readonly currentHubFile: string;
  readonly currentSourceFolderPath?: string;
  readonly progress: Pick<
    FolderThumbnailRegenerationProgress,
    'completed' | 'fileHash' | 'screenshotCount' | 'success' | 'total'
  >;
  readonly requestId: number;
  readonly sourceIndex: number;
}

export interface FolderThumbnailRegenerationTerminalInput {
  readonly currentHubFile: string;
  readonly currentSourceFolderPath?: string;
  readonly requestId: number;
  readonly sourceIndex: number;
}

export interface FolderThumbnailRegenerationStart {
  readonly requestId: number;
  readonly status: FolderThumbnailRegenerationStatus;
}

export type FolderThumbnailRegenerationProgressDecision =
  | { readonly accepted: false }
  | {
    readonly accepted: true;
    readonly status: FolderThumbnailRegenerationStatus;
    readonly successfulUpdate?: {
      readonly fileHash: string;
      readonly screenshotCount: number;
    };
  };

export interface FolderThumbnailRegenerationCancellationDecision {
  readonly changed: boolean;
  readonly status: FolderThumbnailRegenerationStatus | null;
}

export type FolderThumbnailRegenerationCompletionOutcome =
  | 'cancelled'
  | 'complete'
  | 'partial';

export type FolderThumbnailRegenerationCompletionDecision =
  | { readonly accepted: false }
  | {
    readonly accepted: true;
    readonly failedVideos: number;
    readonly outcome: FolderThumbnailRegenerationCompletionOutcome;
    readonly skippedVideos: number;
    readonly succeededVideos: number;
    readonly updatedHashes: ReadonlySet<string>;
  };

export interface FolderThumbnailRegenerationSnapshot {
  readonly failedVideos: number;
  readonly hubFile: string;
  readonly processedHashes: ReadonlySet<string>;
  readonly relativePath: string;
  readonly requestId: number;
  readonly skippedVideos: number;
  readonly sourceFolderPath: string;
  readonly sourceIndex: number;
  readonly status: FolderThumbnailRegenerationStatus;
  readonly succeededVideos: number;
  readonly updatedHashes: ReadonlySet<string>;
  readonly videoCountsByHash: ReadonlyMap<string, number>;
}

interface FolderThumbnailRegenerationState {
  failedVideos: number;
  hubFile: string;
  processedHashes: Set<string>;
  relativePath: string;
  requestId: number;
  skippedVideos: number;
  sourceFolderPath: string;
  sourceIndex: number;
  status: FolderThumbnailRegenerationStatus;
  succeededVideos: number;
  updatedHashes: Set<string>;
  videoCountsByHash: Map<string, number>;
}

/**
 * Owns renderer-side bookkeeping for one folder preview-regeneration batch.
 * Electron transport, catalogue mutation, timers, and presentation remain in
 * HomeComponent; this class only accepts correlated state transitions.
 */
export class FolderThumbnailRegenerationSession {

  private nextRequestId = 1;
  private state: FolderThumbnailRegenerationState | null = null;

  get active(): boolean {
    return this.state !== null;
  }

  get snapshot(): FolderThumbnailRegenerationSnapshot | null {
    if (!this.state) {
      return null;
    }
    return {
      failedVideos: this.state.failedVideos,
      hubFile: this.state.hubFile,
      processedHashes: new Set(this.state.processedHashes),
      relativePath: this.state.relativePath,
      requestId: this.state.requestId,
      skippedVideos: this.state.skippedVideos,
      sourceFolderPath: this.state.sourceFolderPath,
      sourceIndex: this.state.sourceIndex,
      status: { ...this.state.status },
      succeededVideos: this.state.succeededVideos,
      updatedHashes: new Set(this.state.updatedHashes),
      videoCountsByHash: new Map(this.state.videoCountsByHash),
    };
  }

  get status(): FolderThumbnailRegenerationStatus | null {
    return this.state?.status || null;
  }

  begin(input: FolderThumbnailRegenerationBeginInput): FolderThumbnailRegenerationStart | undefined {
    if (this.state) {
      return undefined;
    }

    const requestId = this.nextRequestId++;
    const status: FolderThumbnailRegenerationStatus = Object.freeze({
      completedJobs: 0,
      relativePath: input.relativePath,
      sourceIndex: input.sourceIndex,
      totalJobs: input.totalJobs,
    });
    this.state = {
      failedVideos: 0,
      hubFile: input.hubFile,
      processedHashes: new Set<string>(),
      relativePath: input.relativePath,
      requestId,
      skippedVideos: input.skippedVideos,
      sourceFolderPath: input.sourceFolderPath,
      sourceIndex: input.sourceIndex,
      status,
      succeededVideos: 0,
      updatedHashes: new Set<string>(),
      videoCountsByHash: new Map(input.videoCountsByHash),
    };
    return { requestId, status };
  }

  acceptProgress(
    input: FolderThumbnailRegenerationProgressInput,
  ): FolderThumbnailRegenerationProgressDecision {
    const state = this.getMatchingState(input);
    if (
      !state
      || !state.videoCountsByHash.has(input.progress.fileHash)
      || state.processedHashes.has(input.progress.fileHash)
    ) {
      return { accepted: false };
    }

    state.processedHashes.add(input.progress.fileHash);
    const matchingVideos = state.videoCountsByHash.get(input.progress.fileHash) || 0;
    const validSuccess = input.progress.success
      && Number.isInteger(input.progress.screenshotCount)
      && (input.progress.screenshotCount || 0) > 0;
    let successfulUpdate: {
      readonly fileHash: string;
      readonly screenshotCount: number;
    } | undefined;

    if (validSuccess) {
      state.succeededVideos += matchingVideos;
      state.updatedHashes.add(input.progress.fileHash);
      successfulUpdate = {
        fileHash: input.progress.fileHash,
        screenshotCount: input.progress.screenshotCount as number,
      };
    } else {
      state.failedVideos += matchingVideos;
    }

    const completed = Number.isFinite(input.progress.completed)
      ? Math.floor(input.progress.completed)
      : 0;
    const boundedCompleted = Math.min(Math.max(completed, 0), state.status.totalJobs);
    state.status = Object.freeze({
      cancelling: state.status.cancelling,
      completedJobs: Math.max(state.status.completedJobs, boundedCompleted),
      relativePath: state.relativePath,
      sourceIndex: state.sourceIndex,
      totalJobs: state.status.totalJobs,
    });

    return {
      accepted: true,
      status: state.status,
      successfulUpdate,
    };
  }

  markCancelling(): FolderThumbnailRegenerationCancellationDecision {
    if (!this.state) {
      return { changed: false, status: null };
    }
    if (this.state.status.cancelling) {
      return { changed: false, status: this.state.status };
    }
    this.state.status = Object.freeze({
      ...this.state.status,
      cancelling: true,
    });
    return { changed: true, status: this.state.status };
  }

  complete(
    input: FolderThumbnailRegenerationTerminalInput & { readonly cancelled: boolean },
  ): FolderThumbnailRegenerationCompletionDecision {
    const state = this.getMatchingState(input);
    if (!state) {
      return { accepted: false };
    }

    const outcome: FolderThumbnailRegenerationCompletionOutcome = input.cancelled
      ? 'cancelled'
      : state.failedVideos > 0 || state.skippedVideos > 0
        ? 'partial'
        : 'complete';
    const completion: FolderThumbnailRegenerationCompletionDecision = {
      accepted: true,
      failedVideos: state.failedVideos,
      outcome,
      skippedVideos: state.skippedVideos,
      succeededVideos: state.succeededVideos,
      updatedHashes: new Set(state.updatedHashes),
    };
    this.clear();
    return completion;
  }

  fail(input: FolderThumbnailRegenerationTerminalInput): boolean {
    if (!this.getMatchingState(input)) {
      return false;
    }
    this.clear();
    return true;
  }

  clear(): void {
    this.state = null;
  }

  private getMatchingState(
    input: FolderThumbnailRegenerationTerminalInput,
  ): FolderThumbnailRegenerationState | null {
    const state = this.state;
    if (
      !state
      || state.requestId !== input.requestId
      || state.sourceIndex !== input.sourceIndex
    ) {
      return null;
    }
    if (
      state.hubFile !== input.currentHubFile
      || state.sourceFolderPath !== input.currentSourceFolderPath
    ) {
      this.clear();
      return null;
    }
    return state;
  }
}
