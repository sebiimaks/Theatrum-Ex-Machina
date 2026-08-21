import { app, dialog, shell, BrowserWindow, nativeImage } from 'electron';

import * as path from 'path';
const fs = require('fs');
const trash = require('trash');
const spawn = require('child_process').spawn;

import { GLOBALS } from './main-globals';
import { ImageElement, FinalObject, InputSources } from '../interfaces/final-object.interface';
import { SettingsObject } from '../interfaces/settings-object.interface';
import {
  CATALOGUE_METADATA_MAX_BYTES,
  serializeCatalogueMetadataExport,
} from '../interfaces/catalogue-metadata-transfer';
import { projectFinalObjectForVha2Export } from '../interfaces/vha2-compatibility';
import { createDotPlsFile, writeVhaFileToDisk } from './main-support';
import { replaceThumbnailWithNewImage } from './main-extract';
import {
  closeWatcher,
  cancelFolderThumbnailRegeneration,
  cancelThumbnailRegeneration,
  startWatcher,
  extractAnyMissingThumbs,
  isFolderThumbnailRegenerationActive,
  isThumbnailRegenerationActive,
  regenerateFolderThumbnails,
  regenerateThumbnails,
  rescanSourceFolderScope,
  removeThumbnailsNotInHub,
  ThumbnailRegenerationError,
  updateSourceFolderIgnoredSubdirectories,
} from './main-extract-async';
import { writeJsonAtomically, writeVhaJsonAtomically } from './vha-file-persistence';
import {
  buildPlayerLaunch,
  isAllowedExternalUrl,
  normalizeAbsolutePath,
  ProcessLaunch,
  requireConfiguredSourceRoot,
  resolveExistingMediaPath,
  resolveExistingSourceSubfolder,
  resolveNewMediaPath,
} from './local-operation-safety';
import {
  normalizeIgnoredSubdirectories,
  normalizeSourceFolderRelativePath,
} from '../interfaces/source-folder-path';

let activeCustomThumbnailReplacements = 0;

/**
 * Set up the listeners
 * @param ipc
 * @param win
 * @param pathToAppData
 * @param systemMessages
 */
export function setUpIpcMessages(ipc, win, pathToAppData, systemMessages) {

  const readOnlyMutationChannels = new Set([
    'add-missing-thumbnails',
    'clean-old-thumbnails',
    'configure-source-folder',
    'delete-video-file',
    'reconnect-this-folder',
    'regenerate-folder-thumbnails',
    'regenerate-thumbnails',
    'replace-thumbnail',
    'rescan-source-folder-scope',
    'save-current-vha-file',
    'start-watching-folder',
    'stop-watching-folder',
    'try-to-rename-this-file',
    'update-source-folder-ignored-subdirectories',
  ]);

  const rejectReadOnlyMutation = (event: any, channel: string): boolean => {
    if (GLOBALS.catalogueAccessMode !== 'read-only' || !readOnlyMutationChannels.has(channel)) {
      return false;
    }
    console.warn('Ignored catalogue mutation during a read-only session:', channel);
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send('catalogue-read-only-write-blocked', channel);
    }
    return true;
  };

  const activeWindow = (): any => {
    const currentWindow = GLOBALS.winRef;
    if (currentWindow && !currentWindow.isDestroyed()) {
      return currentWindow;
    }
    return BrowserWindow.getFocusedWindow() || undefined;
  };

  const showOpenDialog = (options: any): Promise<any> => {
    const owner = activeWindow();
    return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
  };

  const showSaveDialog = (options: any): Promise<any> => {
    const owner = activeWindow();
    return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options);
  };

  const configuredSourcePaths = (): string[] => Object.values(GLOBALS.selectedSourceFolders || {})
    .map((source: any) => source && source.path)
    .filter((sourcePath: unknown): sourcePath is string => typeof sourcePath === 'string');

  const trustedIpcOn = (channel: string, listener: (event: any, ...args: any[]) => void): void => {
    ipc.on(channel, (event, ...args): void => {
      const trustedWindow = GLOBALS.winRef;
      const trustedWebContents = trustedWindow && !trustedWindow.isDestroyed()
        ? trustedWindow.webContents
        : null;
      if (!trustedWebContents || event.sender.id !== trustedWebContents.id) {
        console.warn('Ignored IPC message from an untrusted renderer:', channel);
        return;
      }
      if (rejectReadOnlyMutation(event, channel)) {
        return;
      }
      listener(event, ...args);
    });
  };

  const trustedIpcHandle = (
    channel: string,
    listener: (event: any, ...args: any[]) => unknown | Promise<unknown>,
  ): void => {
    ipc.handle(channel, (event, ...args): unknown | Promise<unknown> => {
      const trustedWindow = GLOBALS.winRef;
      const trustedWebContents = trustedWindow && !trustedWindow.isDestroyed()
        ? trustedWindow.webContents
        : null;
      if (!trustedWebContents || event.sender.id !== trustedWebContents.id) {
        console.warn('Ignored IPC request from an untrusted renderer:', channel);
        throw new Error('The request did not come from the active application window.');
      }

      if (rejectReadOnlyMutation(event, channel)) {
        return {
          error: 'This legacy catalogue is open read-only.',
          status: 'read-only',
        };
      }

      return listener(event, ...args);
    });
  };

  const metadataDialogDefaultPath = (suffix = ''): string => {
    const currentCatalogue = typeof GLOBALS.currentlyOpenVhaFile === 'string'
      ? GLOBALS.currentlyOpenVhaFile
      : '';
    if (!currentCatalogue) {
      return path.join(app.getPath('documents'), `catalogue${suffix}`);
    }

    const parsedCatalogue = path.parse(currentCatalogue);
    return path.join(parsedCatalogue.dir, `${parsedCatalogue.name}${suffix}`);
  };

  const setMacDockIconTheme = (theme: unknown): void => {
    if (process.platform !== 'darwin' || !app.dock) {
      return;
    }
    if (theme !== 'light' && theme !== 'dark') {
      console.warn('Ignored invalid app icon theme.');
      return;
    }

    const iconFileName = `favicon-${theme}.png`;
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'assets', iconFileName)
      : path.join(__dirname, '../src/assets', iconFileName);
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      console.warn('Unable to load app icon theme:', iconPath);
      return;
    }
    app.dock.setIcon(icon);
  };

  const launchDetachedProcess = (launch: ProcessLaunch, event): void => {
    try {
      const child = spawn(launch.command, launch.args, {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (error: Error) => {
        console.error('Unable to launch external video player:', error);
        event.sender.send('file-not-found');
      });
      child.unref();
    } catch (error) {
      console.error('Unable to launch external video player:', error);
      event.sender.send('file-not-found');
    }
  };

  /**
   * Un-Maximize the window
   */
  trustedIpcOn('un-maximize-window', (event) => {
    if (BrowserWindow.getFocusedWindow()) {
      BrowserWindow.getFocusedWindow().unmaximize();
    }
  });

  /**
   * Minimize the window
   */
  trustedIpcOn('minimize-window', (event) => {
    if (BrowserWindow.getFocusedWindow()) {
      BrowserWindow.getFocusedWindow().minimize();
    }
  });

  /**
   * Keep the running macOS Dock icon consistent with the app's configured theme.
   */
  trustedIpcOn('set-app-icon-theme', (event, theme: unknown): void => {
    setMacDockIconTheme(theme);
  });

  /**
   * Open the explorer to the relevant file
   */
  trustedIpcOn('open-in-explorer', (event, fullPath: string) => {
    try {
      shell.showItemInFolder(normalizeAbsolutePath(fullPath, 'File'));
    } catch (error) {
      console.warn('Ignored invalid file path:', error);
    }
  });

  /**
   * Open a URL in system's default browser
   */
  trustedIpcOn('please-open-url', (event, urlToOpen: string): void => {
    if (!isAllowedExternalUrl(urlToOpen)) {
      console.warn('Ignored unsafe external URL.');
      return;
    }
    shell.openExternal(urlToOpen, { activate: true }).catch((error: Error) => {
      console.error('Unable to open external URL:', error);
    });
  });

  /**
   * Maximize the window
   */
  trustedIpcOn('maximize-window', (event) => {
    if (BrowserWindow.getFocusedWindow()) {
      BrowserWindow.getFocusedWindow().maximize();
    }
  });

  /**
   * Open a particular video file clicked inside Angular
   */
  trustedIpcOn('open-media-file', (event, fullFilePath) => {
    let normalizedMediaPath: string;
    try {
      normalizedMediaPath = normalizeAbsolutePath(fullFilePath, 'Media file');
    } catch {
      event.sender.send('file-not-found');
      return;
    }

    fs.access(normalizedMediaPath, fs.constants.F_OK, (err: any) => {
      if (!err) {
        shell.openPath(normalizedMediaPath).then((errorMessage: string) => {
          if (errorMessage) {
            console.error(errorMessage);
            event.sender.send('file-not-found');
          }
        });
      } else {
        event.sender.send('file-not-found');
      }
    });
  });

  /**
   * Open a particular video file clicked inside Angular at particular timestamp
   */
  trustedIpcOn('open-media-file-at-timestamp', (event, executablePath, fullFilePath: string, args: string) => {
    let launch: ProcessLaunch;
    let normalizedMediaPath: string;
    try {
      normalizedMediaPath = normalizeAbsolutePath(fullFilePath, 'Media file');
      launch = buildPlayerLaunch(executablePath, normalizedMediaPath, args);
    } catch (error) {
      console.warn('Ignored invalid custom-player request:', error);
      event.sender.send('file-not-found');
      return;
    }

    fs.access(normalizedMediaPath, fs.constants.F_OK, (err: any) => {
      if (!err) {
        launchDetachedProcess(launch, event);
      } else {
        event.sender.send('file-not-found');
      }
    });
  });

  /**
   * Handle dragging a file out of VHA into a video editor (e.g. Vegas or Premiere)
   * if `imgPath` points to a file that does not exist, replace with default image
   */
  trustedIpcOn('drag-video-out-of-electron', (event, filePath, imgPath): void => {
    fs.access(imgPath, fs.constants.F_OK, (err: any) => {
      if (!err) {
        event.sender.startDrag({
          file: filePath,
          icon: imgPath,
        });
      } else {
        const tempIcon: string = app.isPackaged
          ? path.join(process.resourcesPath, 'assets', 'logo.png')
          : path.join(__dirname, '../src/assets/logo.png');
        event.sender.startDrag({
          file: filePath,
          icon: tempIcon,
        });
      }
    });
  });

  /**
   * Select default video player
   */
  trustedIpcOn('select-default-video-player', (event) => {
    console.log('asking for default video player');
    showOpenDialog({
      title: systemMessages.selectDefaultPlayer, // TODO: check if errors out now that this is in `main-ipc.ts`
      filters: [
        {
          name: 'Executable', // TODO: i18n fixme
          extensions: ['exe', 'app']
        }, {
          name: 'All files', // TODO: i18n fixme
          extensions: ['*']
        }
      ],
      properties: ['openFile']
    }).then(result => {
      const executablePath: string = result.filePaths[0];
      if (executablePath) {
        event.sender.send('preferred-video-player-returning', executablePath);
      }
    }).catch(err => {});
  });

  /**
   * Create and play the playlist
   * 1. filter out *FOLDER*
   * 2. save .pls file
   * 3. ask OS to open the .pls file
   */
  trustedIpcOn('please-create-playlist', (event, playlist: ImageElement[], sourceFolderMap: InputSources, execPath: string) => {

    const cleanPlaylist: ImageElement[] = playlist.filter((element: ImageElement) => {
      return element.cleanName !== '*FOLDER*';
    });

    const savePath: string = path.join(GLOBALS.settingsPath, 'temp.pls');

    if (cleanPlaylist.length) {
      createDotPlsFile(savePath, cleanPlaylist, sourceFolderMap, () => {

        if (execPath) { // if `preferredVideoPlayer` is sent
          try {
            launchDetachedProcess(buildPlayerLaunch(execPath, savePath, ''), event);
          } catch (error) {
            console.warn('Ignored invalid custom-player request:', error);
            event.sender.send('file-not-found');
          }
        } else {
          shell.openPath(savePath);
        }
      });
    }
  });

  /**
   * Delete file from computer (send to recycling bin / trash) or dangerously delete (bypass trash)
   */
  trustedIpcOn('delete-video-file', (event, basePath: string, item: ImageElement, dangerousDelete: boolean): void => {
    let fileToDelete: string;
    try {
      const configuredBasePath = requireConfiguredSourceRoot(basePath, configuredSourcePaths());
      fileToDelete = resolveExistingMediaPath(configuredBasePath, item.partialPath, item.fileName);
    } catch (error) {
      console.warn('Ignored unsafe delete path:', error);
      return;
    }

    if (dangerousDelete === true) {

      fs.unlink(fileToDelete, (err) => {
        if (err) {
          console.log('ERROR:', fileToDelete + ' was NOT deleted');
        } else {
          notifyFileDeleted(event, fileToDelete, item);
        }
      });

    } else {

      (async () => {
        try {
          await trash(fileToDelete);
          notifyFileDeleted(event, fileToDelete, item);
        } catch (error) {
          console.error('Unable to move file to trash:', error);
        }
      })();

    }
  });

  /**
   * Helper function for `delete-video-file`
   * @param event
   * @param fileToDelete
   * @param item
   */
  function notifyFileDeleted(event, fileToDelete, item) {
    fs.access(fileToDelete, fs.constants.F_OK, (err: any) => {
      if (err) {
        console.log('FILE DELETED SUCCESS !!!');
        event.sender.send('file-deleted', item);
      }
    });
  }

  /**
   * Method to replace thumbnail of a particular item
   */
  trustedIpcOn('replace-thumbnail', (event, pathToIncomingJpg: string, item: ImageElement) => {
    if (isThumbnailRegenerationActive()) {
      return;
    }
    const fileToReplace: string = path.join(
        GLOBALS.selectedOutputFolder,
        'vha-' + GLOBALS.hubName,
        'thumbnails',
        item.hash + '.jpg'
      );

    const height: number = GLOBALS.screenshotSettings.height;
    activeCustomThumbnailReplacements++;

    replaceThumbnailWithNewImage(fileToReplace, pathToIncomingJpg, height, (imagePath: string) => {
      const decodedImage = nativeImage.createFromPath(imagePath);
      if (decodedImage.isEmpty()) {
        throw new Error('Electron could not decode the dropped PNG.');
      }
      return decodedImage.toJPEG(100);
    })
      .then(success => {
        if (success) {
          event.sender.send('custom-thumbnail-replaced', item.hash);
        }
      })
      .catch((error) => {
        console.error('Unable to replace custom thumbnail:', error);
      })
      .finally(() => {
        activeCustomThumbnailReplacements = Math.max(0, activeCustomThumbnailReplacements - 1);
      });

  });

  /**
   * Summon system modal to choose INPUT directory
   * where all the videos are located
   */
  trustedIpcOn('choose-input', (event) => {
    showOpenDialog({
      properties: ['openDirectory']
    }).then(result => {
      const inputDirPath: string = result.filePaths[0];
      if (inputDirPath) {
        event.sender.send('input-folder-chosen', inputDirPath);
      }
    }).catch(err => {});
  });

  /**
   * Summon system modal to choose NEW input directory for a now-disconnected folder
   * where all the videos are located
   */
  trustedIpcOn('reconnect-this-folder', (event, inputSource: number) => {
    showOpenDialog({
      properties: ['openDirectory']
    }).then(result => {
      const inputDirPath: string = result.filePaths[0];
      if (inputDirPath) {
        event.sender.send('old-folder-reconnected', inputSource, inputDirPath);
      }
    }).catch(err => {});
  });

  /**
   * Stop watching a particular folder
   */
  trustedIpcOn('stop-watching-folder', (event, watchedFolderIndex: number) => {
    console.log('stop watching:', watchedFolderIndex);
    closeWatcher(watchedFolderIndex);
  });

  /**
   * Stop watching a particular folder
   */
  trustedIpcOn('start-watching-folder', (
    event,
    watchedFolderIndex: string | number,
    path2: string,
    persistent: boolean,
    generateAutomaticPreviews: unknown = true,
  ) => {
    // Object keys arrive as strings, but they still must identify the exact
    // configured root. A watch toggle must never be able to remap a source.
    try {
      const sourceIndex = typeof watchedFolderIndex === 'number'
        ? watchedFolderIndex
        : /^(0|[1-9][0-9]*)$/.test(watchedFolderIndex)
          ? Number(watchedFolderIndex)
          : Number.NaN;
      if (
        !Number.isSafeInteger(sourceIndex)
        || sourceIndex < 0
        || typeof persistent !== 'boolean'
        || typeof generateAutomaticPreviews !== 'boolean'
      ) {
        throw new Error('The source folder watch request is invalid.');
      }
      const sourceFolder = GLOBALS.selectedSourceFolders[sourceIndex];
      if (!sourceFolder) {
        throw new Error('The source folder is not configured for this catalogue.');
      }
      const configuredRoot = requireConfiguredSourceRoot(path2, [sourceFolder.path]);
      resolveExistingSourceSubfolder(configuredRoot, '');
      console.log('start watching:', sourceIndex, configuredRoot, persistent);
      startWatcher(sourceIndex, configuredRoot, persistent, generateAutomaticPreviews);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      event.sender.send('folder-scan-failed', Number(watchedFolderIndex), message, '');
    }
  });

  /**
   * Register a newly selected source root in the main process, then optionally
   * scan it. Validation happens before GLOBALS changes so invalid or missing
   * paths cannot replace an existing catalogue source.
   */
  trustedIpcOn(
    'configure-source-folder',
    (
      event,
      sourceIndex: number,
      absoluteRoot: unknown,
      scanImmediately: unknown,
      generateAutomaticPreviews: unknown = true,
    ): void => {
      let normalizedRoot: string;
      try {
        if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
          throw new Error('The source folder index is invalid.');
        }
        if (typeof scanImmediately !== 'boolean') {
          throw new Error('The source folder scan setting is invalid.');
        }
        if (typeof generateAutomaticPreviews !== 'boolean') {
          throw new Error('The folder-add preview generation setting is invalid.');
        }

        normalizedRoot = normalizeAbsolutePath(absoluteRoot, 'Source folder');
        resolveExistingSourceSubfolder(normalizedRoot, '');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        event.sender.send('folder-scan-failed', sourceIndex, message, '');
        return;
      }

      closeWatcher(sourceIndex);
      const previousSourceFolder = GLOBALS.selectedSourceFolders[sourceIndex];
      const ignoredSubdirectories = normalizeIgnoredSubdirectories(
        previousSourceFolder?.ignoredSubdirectories,
      );
      GLOBALS.selectedSourceFolders[sourceIndex] = {
        ...(ignoredSubdirectories.length > 0 ? { ignoredSubdirectories } : {}),
        path: normalizedRoot,
        watch: false,
      };
      event.sender.send('directory-now-connected', sourceIndex, normalizedRoot);

      if (scanImmediately) {
        try {
          rescanSourceFolderScope(sourceIndex, '', generateAutomaticPreviews);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          event.sender.send('folder-scan-failed', sourceIndex, message, '');
        }
      }
    },
  );

  /** Recursively rescan one validated root-relative source subtree. */
  trustedIpcOn(
    'rescan-source-folder-scope',
    (
      event,
      sourceIndex: number,
      relativePath: unknown,
      generateAutomaticPreviews: unknown = true,
    ): void => {
      let reportedScope = '';
      try {
        if (typeof relativePath !== 'string') {
          throw new Error('The source subfolder scope is invalid.');
        }
        if (typeof generateAutomaticPreviews !== 'boolean') {
          throw new Error('The folder preview generation setting is invalid.');
        }
        reportedScope = normalizeSourceFolderRelativePath(relativePath);
        rescanSourceFolderScope(
          sourceIndex,
          relativePath,
          generateAutomaticPreviews,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Another scan is already running for this source folder.') {
          event.sender.send('folder-scan-request-rejected', sourceIndex, message);
        } else {
          event.sender.send('folder-scan-failed', sourceIndex, message, reportedScope);
        }
      }
    },
  );

  /** Persist one source's ignored subtree list and restart/rescan it safely. */
  trustedIpcHandle(
    'update-source-folder-ignored-subdirectories',
    (
      _event,
      sourceIndex: number,
      ignoredSubdirectories: unknown,
      postChangeCatalogue: ImageElement[],
    ) => {
      return updateSourceFolderIgnoredSubdirectories(
        sourceIndex,
        ignoredSubdirectories,
        postChangeCatalogue,
      );
    },
  );

  /**
   * extract any missing thumbnails
   */
  trustedIpcOn('add-missing-thumbnails', (event, finalArray: ImageElement[], extractClips: boolean) => {
    if (isFolderThumbnailRegenerationActive()) {
      return;
    }
    extractAnyMissingThumbs(finalArray);
  });

  /**
   * Remove and recreate the generated preview assets for one video.
   */
  trustedIpcOn('regenerate-thumbnails', (event, item: ImageElement) => {
    if (isFolderThumbnailRegenerationActive() || activeCustomThumbnailReplacements > 0) {
      event.sender.send(
        'thumbnail-regeneration-failed',
        item && item.hash,
        'Wait for the current thumbnail operation to finish.',
      );
      return;
    }
    regenerateThumbnails(item)
      .then((screenshotCount: number) => {
        event.sender.send('thumbnail-replaced');
        event.sender.send('thumbnail-regeneration-complete', item.hash, screenshotCount);
      })
      .catch((error: Error) => {
        console.error('Unable to regenerate thumbnails:', error);
        const coreStatus = error instanceof ThumbnailRegenerationError
          ? error.coreStatus
          : undefined;
        event.sender.send('thumbnail-regeneration-failed', item.hash, error.message, coreStatus);
      });
  });

  /**
   * Recreate generated previews for all eligible videos in one source folder.
   * The extraction module owns sequencing, cancellation, and the global batch
   * lock; this IPC layer only relays progress to the requesting renderer.
   */
  trustedIpcOn(
    'regenerate-folder-thumbnails',
    (
      event,
      requestId: number,
      sourceIndex: number,
      relativePath: string,
      cataloguePath: string,
      items: ImageElement[],
    ) => {
      const sender = event.sender;
      let ownerActive = true;
      const send = (channel: string, ...args: any[]): void => {
        if (ownerActive && !sender.isDestroyed()) {
          sender.send(channel, ...args);
        }
      };

      if (
        !Number.isSafeInteger(requestId)
        || !Number.isInteger(sourceIndex)
        || typeof relativePath !== 'string'
        || typeof cataloguePath !== 'string'
        || !Array.isArray(items)
      ) {
        send('folder-thumbnail-regeneration-failed', requestId, sourceIndex);
        return;
      }
      if (activeCustomThumbnailReplacements > 0) {
        send('folder-thumbnail-regeneration-failed', requestId, sourceIndex);
        return;
      }

      const ownerUnavailable = (): void => {
        if (!ownerActive) {
          return;
        }
        ownerActive = false;
        cancelFolderThumbnailRegeneration();
      };
      const navigationStarted = (
        _navigationEvent,
        _navigationUrl: string,
        _isInPlace: boolean,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) {
          ownerUnavailable();
        }
      };
      const cleanUpOwnerListeners = (): void => {
        sender.removeListener('destroyed', ownerUnavailable);
        sender.removeListener('render-process-gone', ownerUnavailable);
        sender.removeListener('did-start-navigation', navigationStarted);
      };
      sender.once('destroyed', ownerUnavailable);
      sender.once('render-process-gone', ownerUnavailable);
      sender.on('did-start-navigation', navigationStarted);

      regenerateFolderThumbnails(
        sourceIndex,
        relativePath,
        items,
        cataloguePath,
        progress => send('folder-thumbnail-regeneration-progress', requestId, sourceIndex, progress),
        () => ownerActive && !sender.isDestroyed(),
      )
        .then((result) => {
          cleanUpOwnerListeners();
          send('folder-thumbnail-regeneration-complete', requestId, sourceIndex, result);
        })
        .catch((error: Error) => {
          cleanUpOwnerListeners();
          console.error('Unable to regenerate folder thumbnails:', error);
          send('folder-thumbnail-regeneration-failed', requestId, sourceIndex);
        });
    },
  );

  trustedIpcOn('cancel-folder-thumbnail-regeneration', () => {
    cancelFolderThumbnailRegeneration();
  });

  trustedIpcOn('cancel-thumbnail-regeneration', () => {
    cancelThumbnailRegeneration();
  });

  /**
   * Remove any thumbnails for files no longer present in the hub
   */
  trustedIpcOn('clean-old-thumbnails', (event, finalArray: ImageElement[]) => {
    if (isFolderThumbnailRegenerationActive()) {
      return;
    }
    // !!! WARNING
    const screenshotOutputFolder: string = path.join(GLOBALS.selectedOutputFolder, 'vha-' + GLOBALS.hubName);
    // !! ^^^^^^^^^^^^^^^^^^^^^^ - make sure this points to the folder with screenshots only!

    const allHashes: Map<string, 1> = new Map();

    finalArray
      .filter((element: ImageElement) => { return !element.deleted; })
      .forEach((element: ImageElement) => {
        allHashes.set(element.hash, 1);
      });
    removeThumbnailsNotInHub(allHashes, screenshotOutputFolder); // WARNING !!! this function will delete stuff
  });

  /**
   * Save the currently open VHA file without closing the app.
   */
  trustedIpcOn('save-current-vha-file', (event, finalObjectToSave: FinalObject) => {
    if (finalObjectToSave !== null) {
      writeVhaFileToDisk(finalObjectToSave, GLOBALS.currentlyOpenVhaFile, (err) => {
        if (err) {
          event.sender.send('current-vha-file-save-failed', err.message || err.toString());
        } else {
          event.sender.send('current-vha-file-saved');
        }
      });
    } else {
      event.sender.send('current-vha-file-saved');
    }
  });

  /**
   * Export a validated, human-readable metadata document through a native Save dialog.
   * The renderer supplies data, never a destination path; all writing remains in the
   * trusted main process and uses the existing atomic JSON writer.
   */
  trustedIpcHandle('export-catalogue-metadata', async (event, document: unknown): Promise<unknown> => {
    try {
      const json = serializeCatalogueMetadataExport(document);
      if (Buffer.byteLength(json, 'utf8') > CATALOGUE_METADATA_MAX_BYTES) {
        return {
          error: 'The metadata export would be larger than 50 MB. Reduce large notes or export a smaller catalogue.',
          status: 'error',
        };
      }
      const result = await showSaveDialog({
        defaultPath: metadataDialogDefaultPath('.metadata.json'),
        filters: [{ name: 'Theatrum Ex Machina metadata', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        title: 'Export Catalogue Metadata',
      });

      if (result.canceled || !result.filePath) {
        return { status: 'cancelled' };
      }

      const destination = path.extname(result.filePath).toLowerCase() === '.json'
        ? result.filePath
        : `${result.filePath}.json`;
      await writeJsonAtomically(destination, json);

      return {
        fileName: path.basename(destination),
        status: 'success',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The metadata file could not be exported.';
      console.error('Unable to export catalogue metadata:', error);
      return { error: message, status: 'error' };
    }
  });

  /**
   * Export an upstream-compatible version-3 .vha2 copy without changing the
   * current catalogue path, access mode, or dirty state.
   */
  trustedIpcHandle('export-vha2-catalogue', async (_event, finalObject: FinalObject): Promise<unknown> => {
    try {
      if (GLOBALS.catalogueAccessMode !== 'read-write') {
        return {
          error: 'A read-only legacy catalogue cannot be exported as another legacy copy.',
          status: 'read-only',
        };
      }

      const currentCatalogue = GLOBALS.currentlyOpenVhaFile;
      if (path.extname(currentCatalogue).toLowerCase() !== '.scaena') {
        return {
          error: 'Only an open .scaena catalogue can be exported as a .vha2 copy.',
          status: 'error',
        };
      }

      const compatibleCatalogue = projectFinalObjectForVha2Export(finalObject);
      const parsedCurrent = path.parse(currentCatalogue);
      const result = await showSaveDialog({
        defaultPath: path.join(parsedCurrent.dir, `${parsedCurrent.name}.vha2`),
        filters: [{ name: 'Video Hub App catalogue', extensions: ['vha2'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        title: 'Export Video Hub App Catalogue',
      });

      if (result.canceled || !result.filePath) {
        return { status: 'cancelled' };
      }

      const destination = path.extname(result.filePath).toLowerCase() === '.vha2'
        ? result.filePath
        : `${result.filePath}.vha2`;
      await writeVhaJsonAtomically(destination, JSON.stringify(compatibleCatalogue));

      return {
        fileName: path.basename(destination),
        status: 'exported',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The .vha2 catalogue could not be exported.';
      console.error('Unable to export a Video Hub App catalogue:', error);
      return { error: message, status: 'error' };
    }
  });

  /**
   * Read only a user-selected JSON file, enforce a conservative size limit, and
   * return its text for category-aware validation in the Catalogue Editor.
   */
  trustedIpcHandle('import-catalogue-metadata', async (): Promise<unknown> => {
    try {
      const result = await showOpenDialog({
        defaultPath: path.dirname(metadataDialogDefaultPath()),
        filters: [{ name: 'Theatrum Ex Machina metadata', extensions: ['json'] }],
        properties: ['openFile'],
        title: 'Import Catalogue Metadata',
      });

      if (result.canceled || !result.filePaths[0]) {
        return { status: 'cancelled' };
      }

      const sourcePath = result.filePaths[0];
      if (path.extname(sourcePath).toLowerCase() !== '.json') {
        return { error: 'Choose a JSON metadata file.', status: 'error' };
      }

      const stats = await fs.promises.stat(sourcePath);
      if (!stats.isFile()) {
        return { error: 'The selected metadata path is not a file.', status: 'error' };
      }
      if (stats.size > CATALOGUE_METADATA_MAX_BYTES) {
        return { error: 'The selected metadata file is larger than 50 MB.', status: 'error' };
      }

      const contents = await fs.promises.readFile(sourcePath, 'utf8');
      JSON.parse(contents.replace(/^\uFEFF/, ''));

      return {
        contents,
        fileName: path.basename(sourcePath),
        status: 'success',
      };
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'The selected metadata file is not valid JSON.'
        : error instanceof Error
          ? error.message
          : 'The metadata file could not be imported.';
      console.error('Unable to read catalogue metadata:', error);
      return { error: message, status: 'error' };
    }
  });

  /**
   * Summon system modal to choose OUTPUT directory
   * where the final catalogue file, asset folder, and all screenshots will be saved
   */
  trustedIpcOn('choose-output', (event) => {
    showOpenDialog({
      properties: ['openDirectory']
    }).then(result => {
      const outputDirPath: string = result.filePaths[0];
      if (outputDirPath) {
        event.sender.send('output-folder-chosen', outputDirPath);
      }
    }).catch(err => {});
  });

  /**
   * Try to rename the particular file
   */
  trustedIpcOn('try-to-rename-this-file', (event, sourceFolder: string, relPath: string, file: string, renameTo: string, index: number): void => {
    console.log('renaming file:');

    let original: string;
    let newName: string;
    try {
      const configuredBasePath = requireConfiguredSourceRoot(sourceFolder, configuredSourcePaths());
      original = resolveExistingMediaPath(configuredBasePath, relPath, file);
      newName = resolveNewMediaPath(configuredBasePath, relPath, renameTo);
    } catch (error) {
      console.warn('Ignored unsafe rename path:', error);
      event.sender.send('rename-file-response', index, false, renameTo, file, 'RIGHTCLICK.errorSomeError');
      return;
    }

    console.log(original);
    console.log(newName);

    let success = true;
    let errMsg: string;

    // check if already exists first
    if (fs.existsSync(newName)) {
      console.log('some file already EXISTS WITH THAT NAME !!!');
      success = false;
      errMsg = 'RIGHTCLICK.errorFileNameExists';
    } else {
      try {
        fs.renameSync(original, newName);
      } catch (err) {
        success = false;
        console.log(err);
        if (err.code === 'ENOENT') {
          // const pathObj = path.parse(err.path);
          // console.log(pathObj);
          errMsg = 'RIGHTCLICK.errorFileNotFound';
        } else {
          errMsg = 'RIGHTCLICK.errorSomeError';
        }
      }
    }

    event.sender.send('rename-file-response', index, success, renameTo, file, errMsg);
  });

  /**
   * Close the window / quit / exit the app
   */
  trustedIpcOn('close-window', (event, settingsToSave: SettingsObject, finalObjectToSave: FinalObject) => {
    const reportCloseFailure = (error: unknown, message: string) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      event.sender.send('close-window-save-failed', errorMessage);
      const ownerWindow = activeWindow();
      const dialogOptions = {
        buttons: ['OK'],
        detail: errorMessage,
        message,
        title: 'Unable to Close Safely',
        type: 'error' as const,
      };
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        dialog.showMessageBox(ownerWindow, dialogOptions);
      } else {
        dialog.showMessageBox(dialogOptions);
      }
    };

    const closeWindow = () => {
      try {
        const windowToClose = activeWindow();
        GLOBALS.readyToQuit = true;
        if (windowToClose && !windowToClose.isDestroyed()) {
          windowToClose.close();
        }
      } catch {
        // The window may already be closed while the app is quitting.
      }
    };

    const reportCatalogueCloseFailure = (error: unknown): void => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      event.sender.send('close-window-save-failed', errorMessage);
      const ownerWindow = activeWindow();
      const dialogOptions = {
        buttons: ['Keep Working', 'Quit Without Saving Catalogue Changes'],
        cancelId: 0,
        defaultId: 0,
        detail: `${errorMessage}\n\nThe catalogue file has not been changed. You can keep working and correct the problem, or quit without saving the current catalogue changes.`,
        message: 'The current catalogue could not be saved.',
        noLink: true,
        title: 'Unable to Close Safely',
        type: 'error' as const,
      };
      const response = ownerWindow && !ownerWindow.isDestroyed()
        ? dialog.showMessageBox(ownerWindow, dialogOptions)
        : dialog.showMessageBox(dialogOptions);
      response.then((result) => {
        if (result.response === 1) {
          closeWindow();
        }
      }).catch((dialogError) => {
        console.error('Unable to show the catalogue save failure dialog:', dialogError);
      });
    };

    const saveAndClose = (): void => {
      let json: string;
      try {
        // convert shortcuts map to object
        settingsToSave.shortcuts = <any>Object.fromEntries(settingsToSave.shortcuts);
        json = JSON.stringify(settingsToSave);
        fs.mkdirSync(GLOBALS.settingsPath, { recursive: true });
      } catch (error) {
        reportCloseFailure(error, 'The application settings could not be prepared for saving. The app will remain open.');
        return;
      }

      writeJsonAtomically(path.join(GLOBALS.settingsPath, 'settings.json'), json).then(() => {
        if (finalObjectToSave === null || GLOBALS.catalogueAccessMode === 'read-only') {
          closeWindow();
          return;
        }

        writeVhaFileToDisk(finalObjectToSave, GLOBALS.currentlyOpenVhaFile, (error: Error) => {
          if (error) {
            reportCatalogueCloseFailure(error);
            return;
          }
          closeWindow();
        });
      }).catch((error: Error) => {
        reportCloseFailure(error, 'The application settings could not be saved. The app will remain open.');
      });
    };

    if (activeCustomThumbnailReplacements > 0) {
      reportCloseFailure(
        new Error('A custom thumbnail replacement is still in progress.'),
        'Wait for the current thumbnail replacement to finish before closing the application.',
      );
      return;
    }

    if (!isThumbnailRegenerationActive()) {
      saveAndClose();
      return;
    }

    const ownerWindow = activeWindow();
    const dialogOptions = {
      buttons: ['Keep Working', 'Cancel Generation and Quit'],
      cancelId: 0,
      defaultId: 0,
      detail: 'Completed thumbnail changes will be kept. Unfinished thumbnail generation will be cancelled safely.',
      message: 'Thumbnail generation is still in progress.',
      noLink: true,
      title: 'Cancel Thumbnail Generation?',
      type: 'warning' as const,
    };
    const closeChoice = ownerWindow && !ownerWindow.isDestroyed()
      ? dialog.showMessageBox(ownerWindow, dialogOptions)
      : dialog.showMessageBox(dialogOptions);

    void closeChoice.then((result) => {
      if (result.response !== 1) {
        if (!event.sender.isDestroyed()) {
          event.sender.send('close-window-cancelled');
        }
        return;
      }

      cancelThumbnailRegeneration();
      saveAndClose();
    }).catch((error: Error) => {
      reportCloseFailure(error, 'The thumbnail operation could not be cancelled. The app will remain open.');
    });
  });

}
