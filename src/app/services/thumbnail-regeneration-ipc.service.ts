import { Injectable, OnDestroy } from '@angular/core';

import type { ImageElement } from '../../../interfaces/final-object.interface';
import {
  isFolderThumbnailRegenerationProgress,
  isFolderThumbnailRegenerationResult,
  isSafeThumbnailHash,
  isThumbnailCoreStatus,
  isThumbnailRegenerationCorrelation,
} from '../../../interfaces/thumbnail-regeneration';
import {
  ThumbnailRegenerationIpcCoordinator,
} from '../common/thumbnail-regeneration-ipc';
import type {
  FolderThumbnailRegenerationCommand,
  ThumbnailRegenerationIpcHooks,
} from '../common/thumbnail-regeneration-ipc';
import { ElectronService } from '../providers/electron.service';

/** Angular/Electron adapter for individual and folder preview regeneration. */
@Injectable({ providedIn: 'root' })
export class ThumbnailRegenerationIpcService implements OnDestroy {

  private readonly coordinator: ThumbnailRegenerationIpcCoordinator;

  constructor(private readonly electronService: ElectronService) {
    this.coordinator = new ThumbnailRegenerationIpcCoordinator({
      cancelFolder: (): void => {
        this.electronService.ipcRenderer.send('cancel-folder-thumbnail-regeneration');
      },
      cancelIndividual: (): void => {
        this.electronService.ipcRenderer.send('cancel-thumbnail-regeneration');
      },
      onFolderCompleted: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'folder-thumbnail-regeneration-complete',
          (
            _event,
            requestId: unknown,
            sourceIndex: unknown,
            result: unknown,
          ) => {
            if (!isThumbnailRegenerationCorrelation(requestId, sourceIndex)) {
              return;
            }
            listener(
              requestId as number,
              sourceIndex as number,
              isFolderThumbnailRegenerationResult(result) ? result : undefined,
            );
          },
        )
      ),
      onFolderFailed: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'folder-thumbnail-regeneration-failed',
          (_event, requestId: unknown, sourceIndex: unknown) => {
            if (isThumbnailRegenerationCorrelation(requestId, sourceIndex)) {
              listener(requestId as number, sourceIndex as number);
            }
          },
        )
      ),
      onFolderProgress: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'folder-thumbnail-regeneration-progress',
          (
            _event,
            requestId: unknown,
            sourceIndex: unknown,
            progress: unknown,
          ) => {
            if (!isThumbnailRegenerationCorrelation(requestId, sourceIndex)) {
              return;
            }
            listener(
              requestId as number,
              sourceIndex as number,
              isFolderThumbnailRegenerationProgress(progress) ? progress : undefined,
            );
          },
        )
      ),
      onIndividualAssetsReplaced: (listener): (() => void) => (
        this.electronService.ipcRenderer.on('thumbnail-replaced', () => listener())
      ),
      onIndividualCompleted: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'thumbnail-regeneration-complete',
          (_event, fileHash: unknown, screenshotCount: unknown) => {
            if (!isSafeThumbnailHash(fileHash)) {
              return;
            }
            const validScreenshotCount = Number.isSafeInteger(screenshotCount)
              && (screenshotCount as number) > 0
              ? screenshotCount as number
              : undefined;
            listener(fileHash, validScreenshotCount);
          },
        )
      ),
      onIndividualFailed: (listener): (() => void) => (
        this.electronService.ipcRenderer.on(
          'thumbnail-regeneration-failed',
          (
            _event,
            fileHash: unknown,
            reason?: unknown,
            coreStatus?: unknown,
          ) => {
            if (!isSafeThumbnailHash(fileHash)) {
              return;
            }
            listener(
              fileHash,
              typeof reason === 'string' && reason.length <= 4096 ? reason : undefined,
              isThumbnailCoreStatus(coreStatus) ? coreStatus : undefined,
            );
          },
        )
      ),
      regenerateFolder: (command: FolderThumbnailRegenerationCommand): void => {
        this.electronService.ipcRenderer.send(
          'regenerate-folder-thumbnails',
          command.requestId,
          command.sourceIndex,
          command.relativePath,
          command.cataloguePath,
          command.eligibleVideos,
        );
      },
      regenerateIndividual: (item: ImageElement): void => {
        this.electronService.ipcRenderer.send('regenerate-thumbnails', item);
      },
    });
  }

  connect(hooks: ThumbnailRegenerationIpcHooks): void {
    this.coordinator.connect(hooks);
  }

  disconnect(): void {
    try {
      this.coordinator.disconnect();
    } catch (error) {
      console.error('Unable to remove a thumbnail-regeneration listener cleanly:', error);
    }
  }

  ngOnDestroy(): void {
    this.disconnect();
  }

  cancelFolder(): void {
    this.coordinator.cancelFolder();
  }

  cancelIndividual(): void {
    this.coordinator.cancelIndividual();
  }

  regenerateFolder(command: FolderThumbnailRegenerationCommand): void {
    this.coordinator.regenerateFolder(command);
  }

  regenerateIndividual(item: ImageElement): void {
    this.coordinator.regenerateIndividual(item);
  }
}
