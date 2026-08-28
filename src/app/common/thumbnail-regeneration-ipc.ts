import type { ImageElement } from '../../../interfaces/final-object.interface';
import type {
  FolderThumbnailRegenerationProgress,
  FolderThumbnailRegenerationResult,
  ThumbnailCoreStatus,
} from '../../../interfaces/thumbnail-regeneration';

export type ThumbnailRegenerationIpcDisposer = () => void;

export interface IndividualThumbnailRegenerationStatus {
  readonly catalogueSessionGeneration: number;
  readonly cancelling: boolean;
  readonly fileHash: string;
  readonly fileName: string;
  readonly hubFile: string;
}

export type IndividualThumbnailRegenerationTerminalDisposition =
  | 'accept'
  | 'ignore'
  | 'stale-session';

export function classifyIndividualThumbnailRegenerationTerminal(
  status: IndividualThumbnailRegenerationStatus | null,
  fileHash: string,
  currentHubFile: string,
  currentCatalogueSessionGeneration: number,
): IndividualThumbnailRegenerationTerminalDisposition {
  if (!status || status.fileHash !== fileHash) {
    return 'ignore';
  }
  if (
    status.hubFile !== currentHubFile
    || status.catalogueSessionGeneration !== currentCatalogueSessionGeneration
  ) {
    return 'stale-session';
  }
  return 'accept';
}

export interface FolderThumbnailRegenerationCommand {
  readonly cataloguePath: string;
  readonly eligibleVideos: readonly ImageElement[];
  readonly relativePath: string;
  readonly requestId: number;
  readonly sourceIndex: number;
}

export interface ThumbnailRegenerationIpcHooks {
  folderCompleted(
    requestId: number,
    sourceIndex: number,
    result: FolderThumbnailRegenerationResult,
  ): void;
  folderFailed(requestId: number, sourceIndex: number): void;
  folderProgress(
    requestId: number,
    sourceIndex: number,
    progress: FolderThumbnailRegenerationProgress,
  ): void;
  folderProgressRejected(requestId: number, sourceIndex: number): void;
  individualAssetsReplaced(): void;
  individualCompleted(fileHash: string, screenshotCount: number): void;
  individualFailed(
    fileHash: string,
    reason?: string,
    coreStatus?: ThumbnailCoreStatus,
  ): void;
}

export interface ThumbnailRegenerationIpcTransport {
  cancelFolder(): void;
  cancelIndividual(): void;
  onFolderCompleted(
    listener: (
      requestId: number,
      sourceIndex: number,
      result?: FolderThumbnailRegenerationResult,
    ) => void,
  ): ThumbnailRegenerationIpcDisposer;
  onFolderFailed(
    listener: ThumbnailRegenerationIpcHooks['folderFailed'],
  ): ThumbnailRegenerationIpcDisposer;
  onFolderProgress(
    listener: (
      requestId: number,
      sourceIndex: number,
      progress?: FolderThumbnailRegenerationProgress,
    ) => void,
  ): ThumbnailRegenerationIpcDisposer;
  onIndividualAssetsReplaced(
    listener: ThumbnailRegenerationIpcHooks['individualAssetsReplaced'],
  ): ThumbnailRegenerationIpcDisposer;
  onIndividualCompleted(
    listener: (fileHash: string, screenshotCount?: number) => void,
  ): ThumbnailRegenerationIpcDisposer;
  onIndividualFailed(
    listener: ThumbnailRegenerationIpcHooks['individualFailed'],
  ): ThumbnailRegenerationIpcDisposer;
  regenerateFolder(command: FolderThumbnailRegenerationCommand): void;
  regenerateIndividual(item: ImageElement): void;
}

/**
 * Owns thumbnail-regeneration listener lifetimes and semantic commands without
 * depending on Angular or Electron. UI and catalogue effects are supplied by
 * HomeComponent through typed hooks.
 */
export class ThumbnailRegenerationIpcCoordinator {

  private connectionGeneration = 0;
  private disposers: ThumbnailRegenerationIpcDisposer[] = [];
  private hooks: ThumbnailRegenerationIpcHooks | undefined;

  constructor(private readonly transport: ThumbnailRegenerationIpcTransport) {}

  connect(hooks: ThumbnailRegenerationIpcHooks): void {
    const priorCleanupError = this.clearConnection();
    if (priorCleanupError !== undefined) {
      throw priorCleanupError;
    }
    this.hooks = hooks;
    const connectionGeneration = this.connectionGeneration;
    const dispatch = (
      callback: (activeHooks: ThumbnailRegenerationIpcHooks) => void,
    ): void => {
      if (
        connectionGeneration === this.connectionGeneration
        && this.hooks === hooks
      ) {
        callback(hooks);
      }
    };

    try {
      this.disposers.push(this.transport.onIndividualAssetsReplaced(() => {
        dispatch(activeHooks => activeHooks.individualAssetsReplaced());
      }));
      this.disposers.push(this.transport.onIndividualCompleted((fileHash, screenshotCount) => {
        dispatch((activeHooks) => {
          if (screenshotCount === undefined) {
            activeHooks.individualFailed(fileHash);
          } else {
            activeHooks.individualCompleted(fileHash, screenshotCount);
          }
        });
      }));
      this.disposers.push(this.transport.onIndividualFailed((fileHash, reason, coreStatus) => {
        dispatch(activeHooks => activeHooks.individualFailed(fileHash, reason, coreStatus));
      }));
      this.disposers.push(this.transport.onFolderProgress((requestId, sourceIndex, progress) => {
        dispatch((activeHooks) => {
          if (progress) {
            activeHooks.folderProgress(requestId, sourceIndex, progress);
          } else {
            activeHooks.folderProgressRejected(requestId, sourceIndex);
          }
        });
      }));
      this.disposers.push(this.transport.onFolderCompleted((requestId, sourceIndex, result) => {
        dispatch((activeHooks) => {
          if (result) {
            activeHooks.folderCompleted(requestId, sourceIndex, result);
          } else {
            activeHooks.folderFailed(requestId, sourceIndex);
          }
        });
      }));
      this.disposers.push(this.transport.onFolderFailed((requestId, sourceIndex) => {
        dispatch(activeHooks => activeHooks.folderFailed(requestId, sourceIndex));
      }));
    } catch (error) {
      this.clearConnection();
      throw error;
    }
  }

  disconnect(): void {
    const cleanupError = this.clearConnection();
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }

  cancelFolder(): void {
    this.transport.cancelFolder();
  }

  cancelIndividual(): void {
    this.transport.cancelIndividual();
  }

  regenerateFolder(command: FolderThumbnailRegenerationCommand): void {
    this.transport.regenerateFolder(command);
  }

  regenerateIndividual(item: ImageElement): void {
    this.transport.regenerateIndividual(item);
  }

  private clearConnection(): unknown {
    this.connectionGeneration += 1;
    this.hooks = undefined;
    const disposers = this.disposers;
    this.disposers = [];
    let firstError: unknown;
    disposers.forEach((dispose: ThumbnailRegenerationIpcDisposer) => {
      try {
        dispose();
      } catch (error) {
        firstError ??= error;
      }
    });
    return firstError;
  }
}
