import { app, dialog, shell, BrowserWindow, nativeImage } from 'electron';

import * as path from 'path';
const fs = require('fs');
const spawn = require('child_process').spawn;

import { GLOBALS } from './main-globals';
import { ImageElement, FinalObject } from '../interfaces/final-object.interface';
import { SettingsObject } from '../interfaces/settings-object.interface';
import {
  CATALOGUE_METADATA_MAX_BYTES,
  serializeCatalogueMetadataExport,
} from '../interfaces/catalogue-metadata-transfer';
import { projectFinalObjectForVha2Export } from '../interfaces/vha2-compatibility';
import { createDotPlsFile, writeVhaFileToDisk } from './main-support';
import {
  beginPreviewCleanupBarrier,
  finishPreviewCleanupBarrier,
  replaceThumbnailWithNewImage,
} from './main-extract';
import type { PreviewCleanupBarrier } from './main-extract';
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
  buildTimestampPlayerArguments,
  isAllowedExternalUrl,
  normalizeAbsolutePath,
  ProcessLaunch,
  requireAuthorizedSourceRoot,
  requireConfiguredSourceRoot,
  resolveExistingMediaPath,
  resolveExistingSourceSubfolder,
  resolveNewMediaPath,
} from './local-operation-safety';
import {
  configuredMediaFileExtensions,
  isDefaultOpenMediaExtension,
} from './main-filenames';
import { createTheatrumMediaUrl } from '../interfaces/theatrum-protocol';
import {
  resolveCanonicalTheatrumMediaWriteTarget,
  resolveTheatrumAssetDirectory,
  resolveTheatrumMediaFile,
} from './theatrum-protocol-paths';
import {
  normalizeIgnoredSubdirectories,
  normalizeSourceFolderRelativePath,
} from '../interfaces/source-folder-path';
import {
  rememberPlayerPathAuthorization,
  rememberSourceAccessDecision,
  rememberSourceWatchDecision,
  sourceWatchDecision,
} from './path-authority-store';
import { prepareAuthorizedCatalogueWrite } from './catalogue-write-authority';
import {
  catalogueMediaAuthorityHashes,
  catalogueMediaAuthorityLocationsForHash,
  removeCatalogueMediaAuthorityForSource,
  removeCatalogueMediaAuthorityForSourceScopes,
  removeCatalogueMediaLocationAuthority,
  reconcileCatalogueMediaLocationAuthority,
  renameCatalogueMediaLocationAuthority,
  requireCatalogueMediaLocationAuthority,
  retainCatalogueMediaHashAuthority,
} from './catalogue-media-authority';

let activeCustomThumbnailReplacements = 0;
let thumbnailCleanupInProgress = false;

function pathForNativeDialog(value: string): string {
  return Array.from(value, (character: string): string => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)
      ? '�'
      : character;
  }).join('');
}

/**
 * Set up the listeners
 * @param ipc
 * @param win
 * @param pathToAppData
 * @param systemMessages
 */
export function setUpIpcMessages(
  ipc,
  win,
  pathToAppData,
  systemMessages,
  isTrustedRenderer?: (event: any) => boolean,
) {

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
    .filter((sourcePath: unknown): sourcePath is string => {
      if (typeof sourcePath !== 'string') {
        return false;
      }
      try {
        requireAuthorizedSourceRoot(
          sourcePath,
          Array.from(GLOBALS.authorizedSourceFolderPaths),
          GLOBALS.authorizedSourceFolderRealPaths,
        );
        return true;
      } catch {
        return false;
      }
    });

  const beginCatalogueMaintenance = (): boolean => {
    if (GLOBALS.catalogueTransitionActive || GLOBALS.cataloguePersistenceActive) {
      return false;
    }
    GLOBALS.cataloguePersistenceActive = true;
    return true;
  };

  const releaseCataloguePersistence = (): void => {
    GLOBALS.cataloguePersistenceActive = false;
    setImmediate(() => {
      if (!GLOBALS.cataloguePersistenceActive) {
        GLOBALS.requestCatalogueOpenDispatch?.();
      }
    });
  };

  const finishCatalogueMaintenance = releaseCataloguePersistence;

  interface CatalogueSessionSnapshot {
    cataloguePath: string;
    generation: number;
    mediaAuthority: Set<string>;
  }

  const captureCatalogueSession = (): CatalogueSessionSnapshot => {
    if (GLOBALS.catalogueTransitionActive || !GLOBALS.currentlyOpenVhaFile) {
      throw new Error('A catalogue transition is currently active.');
    }
    return {
      cataloguePath: fs.realpathSync.native(GLOBALS.currentlyOpenVhaFile),
      generation: GLOBALS.catalogueSessionGeneration,
      mediaAuthority: GLOBALS.authorizedCatalogueMediaLocations,
    };
  };

  const catalogueSessionIsCurrent = (snapshot: CatalogueSessionSnapshot): boolean => {
    if (
      GLOBALS.catalogueTransitionActive
      || GLOBALS.catalogueSessionGeneration !== snapshot.generation
      || GLOBALS.authorizedCatalogueMediaLocations !== snapshot.mediaAuthority
      || !GLOBALS.currentlyOpenVhaFile
    ) {
      return false;
    }
    try {
      const currentPath = fs.realpathSync.native(GLOBALS.currentlyOpenVhaFile);
      return process.platform === 'win32'
        ? currentPath.toLocaleLowerCase('en-US') === snapshot.cataloguePath.toLocaleLowerCase('en-US')
        : currentPath === snapshot.cataloguePath;
    } catch {
      return false;
    }
  };

  const configuredMediaExtensions = (): Set<string> => new Set(
    configuredMediaFileExtensions(GLOBALS.additionalExtensions),
  );

  const requireConfiguredMediaFileName = (fileName: string): void => {
    const extension = path.extname(fileName).slice(1).toLocaleLowerCase('en-US');
    if (!extension || !configuredMediaExtensions().has(extension)) {
      throw new Error('The catalogue entry is not a configured media type.');
    }
  };

  const resolveCatalogueMediaLocation = (
    location: { fileName: string; inputSource: number; partialPath: string },
  ): string => {
    requireConfiguredMediaFileName(location.fileName);
    const sourceFolder = GLOBALS.selectedSourceFolders[location.inputSource];
    if (!sourceFolder || typeof sourceFolder.path !== 'string') {
      throw new Error('The catalogue source folder is unavailable.');
    }
    const authorizedRoot = requireAuthorizedSourceRoot(
      sourceFolder.path,
      configuredSourcePaths(),
      GLOBALS.authorizedSourceFolderRealPaths,
    );
    const lexicalPath = resolveExistingMediaPath(
      authorizedRoot,
      location.partialPath,
      location.fileName,
    );
    const fullPath = fs.realpathSync.native(lexicalPath);
    if (!fs.statSync(fullPath).isFile()) {
      throw new Error('The catalogue media path is not a file.');
    }
    requireConfiguredMediaFileName(path.basename(fullPath));
    if (
      path.extname(fullPath).toLocaleLowerCase('en-US')
      !== path.extname(location.fileName).toLocaleLowerCase('en-US')
    ) {
      throw new Error('The catalogue media link resolves to a different file type.');
    }
    return fullPath;
  };

  const resolveAuthorizedCatalogueMediaItem = (
    item: unknown,
  ): { fullPath: string; hash: string; item: ImageElement } => {
    if (GLOBALS.catalogueTransitionActive) {
      throw new Error('The active catalogue is changing.');
    }
    const authorized = requireCatalogueMediaLocationAuthority(
      GLOBALS.authorizedCatalogueMediaLocations,
      item,
    );
    const fullPath = resolveCatalogueMediaLocation(authorized.location);
    return {
      fullPath,
      hash: authorized.hash,
      item: item as ImageElement,
    };
  };

  const rendererWriteMediaAuthority = (images: readonly ImageElement[]): Set<string> => (
    reconcileCatalogueMediaLocationAuthority(
      images,
      GLOBALS.authorizedCatalogueImageHashes,
      GLOBALS.authorizedCatalogueMediaLocations,
      (hash, location): boolean => {
        let incomingPath: string;
        try {
          incomingPath = resolveCatalogueMediaLocation(location);
        } catch {
          return false;
        }
        return catalogueMediaAuthorityLocationsForHash(
          GLOBALS.authorizedCatalogueMediaLocations,
          hash,
        ).some((authorizedLocation): boolean => {
          try {
            const authorizedPath = resolveCatalogueMediaLocation(authorizedLocation);
            return process.platform === 'win32'
              ? authorizedPath.toLocaleLowerCase('en-US') === incomingPath.toLocaleLowerCase('en-US')
              : authorizedPath === incomingPath;
          } catch {
            return false;
          }
        });
      },
    )
  );

  interface AuthorizedCatalogueCommit {
    finalObject: FinalObject;
    imageHashes: Set<string>;
    mediaAuthority: Set<string>;
  }

  const prepareRendererCatalogueCommit = (value: unknown): AuthorizedCatalogueCommit => {
    const finalObject = prepareAuthorizedCatalogueWrite(
      value,
      GLOBALS.selectedSourceFolders,
      GLOBALS.hubName,
    );
    const mediaAuthority = rendererWriteMediaAuthority(finalObject.images);
    const imageHashes = new Set<string>();
    mediaAuthority.forEach((key: string) => {
      const separatorIndex = key.indexOf('\0');
      if (separatorIndex > 0) {
        imageHashes.add(key.slice(0, separatorIndex));
      }
    });
    return { finalObject, imageHashes, mediaAuthority };
  };

  const preserveTrustedScannerAdditions = (
    baselineAuthority: ReadonlySet<string>,
    commit: AuthorizedCatalogueCommit,
  ): void => {
    GLOBALS.authorizedCatalogueMediaLocations.forEach((key: string) => {
      if (baselineAuthority.has(key)) {
        return;
      }
      const fields = key.split('\0');
      const sourceIndex = fields.length === 4 ? Number(fields[1]) : Number.NaN;
      if (!Number.isSafeInteger(sourceIndex) || !commit.finalObject.inputDirs[sourceIndex]) {
        return;
      }
      commit.mediaAuthority.add(key);
      commit.imageHashes.add(fields[0]);
    });
  };

  const reconcileSelectedSourceFolders = (nextSources: FinalObject['inputDirs']): void => {
    const currentSources = GLOBALS.selectedSourceFolders || {};
    const retainedPaths = new Set<string>();
    Object.values(nextSources || {}).forEach((source: any) => {
      try {
        retainedPaths.add(normalizeAbsolutePath(source?.path, 'Source folder'));
      } catch {
        // The validated catalogue-write projection should already have removed
        // malformed paths. Treat any remaining invalid entry as unretained.
      }
    });

    Object.entries(currentSources).forEach(([sourceKey, source]: [string, any]) => {
      const sourceIndex = /^(0|[1-9][0-9]*)$/.test(sourceKey) ? Number(sourceKey) : Number.NaN;
      let currentPath: string | undefined;
      let nextPath: string | undefined;
      try {
        currentPath = normalizeAbsolutePath(source?.path, 'Source folder');
      } catch {
        // Invalid legacy state is still safe to stop and discard.
      }
      try {
        nextPath = normalizeAbsolutePath((nextSources as any)?.[sourceKey]?.path, 'Source folder');
      } catch {
        // A missing or invalid source at the same key means the old watcher ends.
      }
      if (Number.isSafeInteger(sourceIndex) && currentPath !== nextPath) {
        closeWatcher(sourceIndex);
      }
      if (currentPath && !retainedPaths.has(currentPath)) {
        GLOBALS.authorizedSourceFolderPaths.delete(currentPath);
        GLOBALS.authorizedSourceFolderRealPaths.delete(currentPath);
        GLOBALS.authorizedSourceWatchPaths.delete(currentPath);
      }
    });

    GLOBALS.selectedSourceFolders = nextSources;
  };

  const rememberNativeDirectorySelection = (
    value: unknown,
    selections: Set<string>,
    label: string,
  ): string => {
    const normalizedDirectory = normalizeAbsolutePath(value, label);
    resolveExistingSourceSubfolder(normalizedDirectory, '');
    const canonicalDirectory = fs.realpathSync.native(normalizedDirectory);
    selections.add(canonicalDirectory);
    if (selections === GLOBALS.pendingInputDirectorySelections) {
      GLOBALS.authorizedSourceFolderPaths.add(canonicalDirectory);
      GLOBALS.authorizedSourceFolderRealPaths.set(canonicalDirectory, canonicalDirectory);
      if (GLOBALS.currentlyOpenVhaFile) {
        rememberSourceAccessDecision(
          GLOBALS.settingsPath,
          fs.realpathSync.native(GLOBALS.currentlyOpenVhaFile),
          canonicalDirectory,
          true,
        );
      }
    }
    return canonicalDirectory;
  };

  const requireNativeDirectorySelection = (
    value: unknown,
    selections: Set<string>,
    label: string,
  ): string => {
    const normalizedDirectory = normalizeAbsolutePath(value, label);
    if (!selections.has(normalizedDirectory)) {
      throw new Error(`${label} must be chosen through the native folder picker.`);
    }
    resolveExistingSourceSubfolder(normalizedDirectory, '');
    selections.delete(normalizedDirectory);
    return normalizedDirectory;
  };

  const authorizePersistentSourceWatch = async (
    sourcePath: string,
    sourceIndex: number,
  ): Promise<boolean> => {
    const session = captureCatalogueSession();
    const authorizedSourcePath = requireAuthorizedSourceRoot(
      sourcePath,
      configuredSourcePaths(),
      GLOBALS.authorizedSourceFolderRealPaths,
    );
    const canonicalSourcePath = GLOBALS.authorizedSourceFolderRealPaths.get(authorizedSourcePath);
    const configuredSource = GLOBALS.selectedSourceFolders[sourceIndex];
    if (
      !canonicalSourcePath
      || !configuredSource
      || normalizeAbsolutePath(configuredSource.path, 'Source folder') !== authorizedSourcePath
    ) {
      return false;
    }
    const catalogueAuthorityPath = session.cataloguePath;
    if (sourceWatchDecision(
      GLOBALS.settingsPath,
      catalogueAuthorityPath,
      canonicalSourcePath,
    ) === true) {
      GLOBALS.authorizedSourceWatchPaths.add(authorizedSourcePath);
      return true;
    }

    const owner = activeWindow();
    const options = {
      buttons: ['Allow Automatic Watching', 'Cancel'],
      cancelId: 1,
      defaultId: 1,
      detail: `${pathForNativeDialog(authorizedSourcePath)}\n\nAutomatic watching continuously scans this folder and its subfolders for changes.`,
      message: 'Allow automatic folder watching?',
      noLink: true,
      title: 'Allow Automatic Folder Watching?',
      type: 'warning' as const,
    };
    const choice = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    if (GLOBALS.cataloguePersistenceActive || !catalogueSessionIsCurrent(session)) {
      return false;
    }
    const currentSource = GLOBALS.selectedSourceFolders[sourceIndex];
    if (
      currentSource !== configuredSource
      || normalizeAbsolutePath(currentSource.path, 'Source folder') !== authorizedSourcePath
    ) {
      return false;
    }
    requireAuthorizedSourceRoot(
      authorizedSourcePath,
      configuredSourcePaths(),
      GLOBALS.authorizedSourceFolderRealPaths,
    );
    const allow = choice.response === 0;
    rememberSourceWatchDecision(
      GLOBALS.settingsPath,
      catalogueAuthorityPath,
      canonicalSourcePath,
      allow,
    );
    if (allow) {
      GLOBALS.authorizedSourceWatchPaths.add(authorizedSourcePath);
    } else {
      GLOBALS.authorizedSourceWatchPaths.delete(authorizedSourcePath);
    }
    return allow;
  };

  const eventIsTrusted = (event: any): boolean => {
    if (isTrustedRenderer) {
      return isTrustedRenderer(event);
    }
    const trustedWindow = GLOBALS.winRef;
    const trustedWebContents = trustedWindow && !trustedWindow.isDestroyed()
      ? trustedWindow.webContents
      : null;
    return Boolean(trustedWebContents && event.sender.id === trustedWebContents.id);
  };

  const trustedIpcOn = (channel: string, listener: (event: any, ...args: any[]) => void): void => {
    ipc.on(channel, (event, ...args): void => {
      if (!eventIsTrusted(event)) {
        console.warn('Ignored IPC message from an untrusted renderer:', channel);
        return;
      }
      if (rejectReadOnlyMutation(event, channel)) {
        return;
      }
      if (
        GLOBALS.cataloguePersistenceActive
        && (readOnlyMutationChannels.has(channel) || channel === 'close-window')
      ) {
        console.warn('Ignored catalogue mutation while persistence is active:', channel);
        if (channel === 'save-current-vha-file' && !event.sender.isDestroyed()) {
          event.sender.send('current-vha-file-save-failed', 'Another catalogue save is already in progress.');
        } else if (channel === 'close-window' && !event.sender.isDestroyed()) {
          event.sender.send('close-window-save-failed', 'Another catalogue save is already in progress.');
        }
        return;
      }
      if (GLOBALS.catalogueTransitionActive && readOnlyMutationChannels.has(channel)) {
        console.warn('Ignored catalogue mutation while a transition is active:', channel);
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
      if (!eventIsTrusted(event)) {
        console.warn('Ignored IPC request from an untrusted renderer:', channel);
        throw new Error('The request did not come from the active application window.');
      }

      if (rejectReadOnlyMutation(event, channel)) {
        return {
          error: 'This legacy catalogue is open read-only.',
          status: 'read-only',
        };
      }

      if (GLOBALS.cataloguePersistenceActive && readOnlyMutationChannels.has(channel)) {
        return {
          error: 'Another catalogue save is already in progress.',
          status: 'busy',
        };
      }
      if (GLOBALS.catalogueTransitionActive && readOnlyMutationChannels.has(channel)) {
        return {
          error: 'A catalogue transition is currently active.',
          status: 'busy',
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
  trustedIpcOn('open-in-explorer', (event, item: unknown) => {
    try {
      shell.showItemInFolder(resolveAuthorizedCatalogueMediaItem(item).fullPath);
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
  trustedIpcOn('open-media-file', (event, item: unknown) => {
    let normalizedMediaPath: string;
    try {
      normalizedMediaPath = resolveAuthorizedCatalogueMediaItem(item).fullPath;
      if (!isDefaultOpenMediaExtension(path.extname(normalizedMediaPath))) {
        if (!GLOBALS.preferredVideoPlayer) {
          throw new Error('A custom media type requires a user-selected video player.');
        }
        launchDetachedProcess(
          buildPlayerLaunch(GLOBALS.preferredVideoPlayer, normalizedMediaPath, ''),
          event,
        );
        return;
      }
    } catch {
      event.sender.send('file-not-found');
      return;
    }

    shell.openPath(normalizedMediaPath).then((errorMessage: string) => {
      if (errorMessage) {
        console.error(errorMessage);
        event.sender.send('file-not-found');
      }
    });
  });

  /**
   * Open a particular video file clicked inside Angular at particular timestamp
   */
  trustedIpcOn('open-media-file-at-timestamp', (event, item: unknown, timeSeconds: unknown) => {
    let launch: ProcessLaunch;
    let normalizedMediaPath: string;
    try {
      if (!GLOBALS.preferredVideoPlayer) {
        throw new Error('No preferred video player has been selected.');
      }
      normalizedMediaPath = resolveAuthorizedCatalogueMediaItem(item).fullPath;
      const timestampArguments = buildTimestampPlayerArguments(
        GLOBALS.preferredVideoPlayer,
        timeSeconds,
      );
      const playerArguments = [timestampArguments, GLOBALS.preferredVideoPlayerArguments]
        .filter((value: string) => Boolean(value))
        .join(' ');
      launch = buildPlayerLaunch(GLOBALS.preferredVideoPlayer, normalizedMediaPath, playerArguments);
    } catch (error) {
      console.warn('Ignored invalid custom-player request:', error);
      event.sender.send('file-not-found');
      return;
    }

    launchDetachedProcess(launch, event);
  });

  /**
   * Handle dragging a file out of VHA into a video editor (e.g. Vegas or Premiere)
   * if `imgPath` points to a file that does not exist, replace with default image
   */
  trustedIpcOn('drag-video-out-of-electron', (event, item: unknown): void => {
    try {
      const authorizedMediaPath = resolveAuthorizedCatalogueMediaItem(item).fullPath;
      const dragIcon: string = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'logo.png')
        : path.join(__dirname, '../src/assets/logo.png');
      event.sender.startDrag({
        file: authorizedMediaPath,
        icon: dragIcon,
      });
    } catch (error) {
      console.warn('Ignored unsafe file-drag request:', error);
    }
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
      if (!executablePath) {
        return;
      }
      try {
        const normalizedPlayer = normalizeAbsolutePath(executablePath, 'Video player');
        const canonicalPlayer = fs.realpathSync.native(normalizedPlayer);
        const playerStats = fs.statSync(canonicalPlayer);
        if (!playerStats.isFile() && !(process.platform === 'darwin' && canonicalPlayer.toLowerCase().endsWith('.app'))) {
          throw new Error('The selected video player is not an executable file or application bundle.');
        }
        GLOBALS.preferredVideoPlayer = canonicalPlayer;
        rememberPlayerPathAuthorization(GLOBALS.settingsPath, canonicalPlayer);
        if (!event.sender.isDestroyed()) {
          event.sender.send('preferred-video-player-returning', canonicalPlayer);
        }
      } catch (error) {
        console.warn('Ignored invalid video player selection:', error);
      }
    }).catch(err => {});
  });

  /**
   * Create and play the playlist
   * 1. filter out *FOLDER*
   * 2. save .pls file
   * 3. ask OS to open the .pls file
   */
  trustedIpcOn('please-create-playlist', (event, playlist: unknown) => {
    let playlistSession: CatalogueSessionSnapshot;
    try {
      playlistSession = captureCatalogueSession();
    } catch (error) {
      console.warn('Ignored playlist request outside an active catalogue session:', error);
      return;
    }
    const mediaAuthority = GLOBALS.authorizedCatalogueMediaLocations;
    const cataloguePath = GLOBALS.currentlyOpenVhaFile;
    const maximumPlaylistEntries = mediaAuthority.size;
    const playlistKeys = new Set<string>();
    type ResolvedPlaylistItem = { cleanName: string; fullPath: string; key: string };
    const cleanPlaylist: ResolvedPlaylistItem[] = Array.isArray(playlist)
      && playlist.length <= maximumPlaylistEntries
      ? playlist.reduce((validEntries: ResolvedPlaylistItem[], candidate: unknown) => {
        const element = candidate as Partial<ImageElement>;
        if (
          !element
          || element.cleanName === '*FOLDER*'
          || typeof element.cleanName !== 'string'
          || element.cleanName.length > 4096
        ) {
          return validEntries;
        }
        try {
          const authorized = resolveAuthorizedCatalogueMediaItem(element);
          const key = process.platform === 'win32'
            ? authorized.fullPath.toLocaleLowerCase('en-US')
            : authorized.fullPath;
          if (playlistKeys.has(key)) {
            return validEntries;
          }
          playlistKeys.add(key);
          validEntries.push({
            cleanName: element.cleanName.replace(/[\r\n]+/g, ' '),
            fullPath: authorized.fullPath,
            key,
          });
        } catch {
          // A stale or renderer-forged playlist item never reaches disk.
        }
        return validEntries;
      }, [])
      : [];

    if (cleanPlaylist.length) {
      fs.promises.mkdtemp(path.join(GLOBALS.settingsPath, 'playlist-')).then((temporaryDirectory: string) => {
        const savePath = path.join(temporaryDirectory, 'playlist.pls');
        const removeTemporaryPlaylist = (): void => {
          fs.promises.unlink(savePath)
            .catch(() => undefined)
            .finally(() => fs.promises.rmdir(temporaryDirectory).catch(() => undefined));
        };
        createDotPlsFile(savePath, cleanPlaylist, (writeError?: Error) => {
          if (writeError) {
            console.error('Unable to create playlist:', writeError);
            removeTemporaryPlaylist();
            if (!event.sender.isDestroyed()) {
              event.sender.send('file-not-found');
            }
            return;
          }
          if (
            !catalogueSessionIsCurrent(playlistSession)
            || event.sender.isDestroyed()
            || GLOBALS.catalogueTransitionActive
            || GLOBALS.authorizedCatalogueMediaLocations !== mediaAuthority
            || GLOBALS.currentlyOpenVhaFile !== cataloguePath
          ) {
            removeTemporaryPlaylist();
            return;
          }

          const cleanupTimer = setTimeout(() => {
            removeTemporaryPlaylist();
          }, 60_000);
          cleanupTimer.unref();

          if (GLOBALS.preferredVideoPlayer) {
            try {
              launchDetachedProcess(buildPlayerLaunch(GLOBALS.preferredVideoPlayer, savePath, ''), event);
            } catch (error) {
              console.warn('Ignored invalid custom-player request:', error);
              if (!event.sender.isDestroyed()) {
                event.sender.send('file-not-found');
              }
            }
          } else {
            shell.openPath(savePath);
          }
        });
      }).catch((error: Error) => {
        console.error('Unable to create a private temporary playlist:', error);
        if (!event.sender.isDestroyed()) {
          event.sender.send('file-not-found');
        }
      });
    }
  });

  /**
   * Delete file from computer (send to recycling bin / trash) or dangerously delete (bypass trash)
   */
  trustedIpcOn('delete-video-file', async (
    event,
    item: unknown,
    dangerousDelete: boolean,
  ): Promise<void> => {
    let fileToDelete: string;
    let reviewedRealPath: string;
    const mediaAuthority = GLOBALS.authorizedCatalogueMediaLocations;
    const cataloguePath = GLOBALS.currentlyOpenVhaFile;
    try {
      if (typeof dangerousDelete !== 'boolean') {
        throw new Error('The delete mode is invalid.');
      }
      const authorized = resolveAuthorizedCatalogueMediaItem(item);
      fileToDelete = authorized.fullPath;
      reviewedRealPath = authorized.fullPath;
    } catch (error) {
      console.warn('Ignored unsafe delete path:', error);
      return;
    }

    if (!beginCatalogueMaintenance()) {
      return;
    }

    try {
      const owner = activeWindow();
      const permanent = dangerousDelete === true;
      const options = {
        buttons: [permanent ? 'Delete Permanently' : 'Move to Trash', 'Cancel'],
        cancelId: 1,
        defaultId: 1,
        detail: `${pathForNativeDialog(fileToDelete)}\n\n${permanent
          ? 'This cannot be undone.'
          : 'The file can normally be recovered from the system Trash.'}`,
        message: permanent ? 'Permanently delete this media file?' : 'Move this media file to Trash?',
        noLink: true,
        title: permanent ? 'Delete Media Permanently?' : 'Move Media to Trash?',
        type: 'warning' as const,
      };
      const choice = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (choice.response !== 0) {
        return;
      }

      if (
        GLOBALS.authorizedCatalogueMediaLocations !== mediaAuthority
        || GLOBALS.currentlyOpenVhaFile !== cataloguePath
      ) {
        throw new Error('The active catalogue changed while confirmation was open.');
      }
      const authorized = resolveAuthorizedCatalogueMediaItem(item);
      fileToDelete = authorized.fullPath;
      const currentRealPath = authorized.fullPath;
      const sameIdentity = process.platform === 'win32'
        ? currentRealPath.toLocaleLowerCase('en-US') === reviewedRealPath.toLocaleLowerCase('en-US')
        : currentRealPath === reviewedRealPath;
      if (!sameIdentity) {
        throw new Error('The media file changed while confirmation was open.');
      }
      if (permanent) {
        await fs.promises.unlink(fileToDelete);
      } else {
        await shell.trashItem(fileToDelete);
      }
      removeCatalogueMediaLocationAuthority(
        GLOBALS.authorizedCatalogueMediaLocations,
        item,
      );
      if (!event.sender.isDestroyed()) {
        event.sender.send('file-deleted', item);
      }
    } catch (error) {
      console.warn('Unable to complete the confirmed media deletion:', error);
    } finally {
      finishCatalogueMaintenance();
    }
  });

  /**
   * Method to replace thumbnail of a particular item
   */
  trustedIpcOn('replace-thumbnail', (event, pathToIncomingJpg: string, item: ImageElement) => {
    if (isThumbnailRegenerationActive()) {
      return;
    }
    let hash = '';
    let replacementSession: CatalogueSessionSnapshot;
    try {
      replacementSession = captureCatalogueSession();
      hash = requireCatalogueMediaLocationAuthority(
        GLOBALS.authorizedCatalogueMediaLocations,
        item,
      ).hash;
    } catch (error) {
      console.warn('Ignored an unauthorized thumbnail replacement:', error);
      return;
    }
    const assetDirectory = resolveTheatrumAssetDirectory(
      GLOBALS.selectedOutputFolder,
      GLOBALS.hubName,
    );
    const lexicalFileToReplace = assetDirectory
      && GLOBALS.authorizedCatalogueImageHashes.has(hash)
      && hash
      ? resolveTheatrumMediaFile(
        createTheatrumMediaUrl('thumbnails', hash, false),
        assetDirectory,
      )
      : undefined;
    const fileToReplace = lexicalFileToReplace && assetDirectory
      ? resolveCanonicalTheatrumMediaWriteTarget(
        lexicalFileToReplace,
        GLOBALS.selectedOutputFolder,
        assetDirectory,
      )
      : undefined;

    let incomingImagePath: string;
    try {
      if (!fileToReplace) {
        throw new Error('The thumbnail destination is invalid.');
      }
      incomingImagePath = normalizeAbsolutePath(pathToIncomingJpg, 'Replacement image');
      const extension = path.extname(incomingImagePath).toLowerCase();
      if (
        !GLOBALS.pendingUserFileSelections.has(incomingImagePath)
        || !['.jpg', '.jpeg', '.png'].includes(extension)
        || !fs.statSync(incomingImagePath).isFile()
      ) {
        throw new Error('The replacement image must be an existing JPEG or PNG file.');
      }
      GLOBALS.pendingUserFileSelections.delete(incomingImagePath);
    } catch (error) {
      console.warn('Ignored unsafe custom-thumbnail replacement:', error);
      return;
    }

    const height: number = GLOBALS.screenshotSettings.height;
    const replacementOutputDirectory = GLOBALS.selectedOutputFolder;
    const replacementHubName = GLOBALS.hubName;
    const replacementStillOwned = (): boolean => {
      try {
        requireCatalogueMediaLocationAuthority(
          GLOBALS.authorizedCatalogueMediaLocations,
          item,
        );
        return catalogueSessionIsCurrent(replacementSession)
          && GLOBALS.selectedOutputFolder === replacementOutputDirectory
          && GLOBALS.hubName === replacementHubName
          && GLOBALS.authorizedCatalogueImageHashes.has(hash);
      } catch {
        return false;
      }
    };
    if (!beginCatalogueMaintenance()) {
      return;
    }
    activeCustomThumbnailReplacements++;

    replaceThumbnailWithNewImage(fileToReplace, incomingImagePath, height, (imagePath: string) => {
      const decodedImage = nativeImage.createFromPath(imagePath);
      if (decodedImage.isEmpty()) {
        throw new Error('Electron could not decode the dropped PNG.');
      }
      return decodedImage.toJPEG(100);
    }, replacementStillOwned)
      .then(success => {
        if (success && replacementStillOwned()) {
          event.sender.send('custom-thumbnail-replaced', item.hash);
        }
      })
      .catch((error) => {
        console.error('Unable to replace custom thumbnail:', error);
      })
      .finally(() => {
        activeCustomThumbnailReplacements = Math.max(0, activeCustomThumbnailReplacements - 1);
        finishCatalogueMaintenance();
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
        const selectedDirectory = rememberNativeDirectorySelection(
          inputDirPath,
          GLOBALS.pendingInputDirectorySelections,
          'Source folder',
        );
        // The wizard deliberately defaults output to the newly chosen source.
        // Record that same native selection for both roles without allowing an
        // arbitrary renderer string to become an output destination.
        GLOBALS.pendingOutputDirectorySelections.add(selectedDirectory);
        event.sender.send('input-folder-chosen', selectedDirectory);
      }
    }).catch(error => {
      console.warn('Unable to choose a source folder:', error);
    });
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
        const selectedDirectory = rememberNativeDirectorySelection(
          inputDirPath,
          GLOBALS.pendingInputDirectorySelections,
          'Source folder',
        );
        event.sender.send('old-folder-reconnected', inputSource, selectedDirectory);
      }
    }).catch(error => {
      console.warn('Unable to choose a replacement source folder:', error);
    });
  });

  /**
   * Stop watching a particular folder
   */
  trustedIpcOn('stop-watching-folder', (event, watchedFolderIndex: number) => {
    if (!Number.isSafeInteger(watchedFolderIndex) || watchedFolderIndex < 0) {
      return;
    }
    const sourceFolder = GLOBALS.selectedSourceFolders[watchedFolderIndex];
    if (!sourceFolder) {
      return;
    }
    console.log('stop watching:', watchedFolderIndex);
    closeWatcher(watchedFolderIndex);
    GLOBALS.selectedSourceFolders[watchedFolderIndex] = {
      ...sourceFolder,
      watch: false,
    };
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
      requireAuthorizedSourceRoot(
        configuredRoot,
        configuredSourcePaths(),
        GLOBALS.authorizedSourceFolderRealPaths,
      );
      resolveExistingSourceSubfolder(configuredRoot, '');
      const startAuthorizedWatcher = (): void => {
        console.log('start watching:', sourceIndex, configuredRoot, persistent);
        startWatcher(sourceIndex, configuredRoot, persistent, generateAutomaticPreviews);
      };
      if (!persistent) {
        startAuthorizedWatcher();
        return;
      }
      const watchSession = captureCatalogueSession();
      void authorizePersistentSourceWatch(configuredRoot, sourceIndex)
        .then((allowed: boolean) => {
          if (
            allowed
            && !GLOBALS.cataloguePersistenceActive
            && catalogueSessionIsCurrent(watchSession)
            && GLOBALS.selectedSourceFolders[sourceIndex] === sourceFolder
            && GLOBALS.selectedSourceFolders[sourceIndex]?.path === configuredRoot
          ) {
            startAuthorizedWatcher();
          } else if (!event.sender.isDestroyed()) {
            event.sender.send(
              'folder-scan-failed',
              sourceIndex,
              'Automatic folder watching was not authorized.',
              '',
            );
          }
        })
        .catch((error: Error) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('folder-scan-failed', sourceIndex, error.message, '');
          }
        });
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

        normalizedRoot = requireNativeDirectorySelection(
          absoluteRoot,
          GLOBALS.pendingInputDirectorySelections,
          'Source folder',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        event.sender.send('folder-scan-failed', sourceIndex, message, '');
        return;
      }

      closeWatcher(sourceIndex);
      removeCatalogueMediaAuthorityForSource(
        GLOBALS.authorizedCatalogueMediaLocations,
        sourceIndex,
      );
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
        const sourceFolder = GLOBALS.selectedSourceFolders[sourceIndex];
        if (!sourceFolder) {
          throw new Error('The source folder is not configured for this catalogue.');
        }
        requireAuthorizedSourceRoot(
          sourceFolder.path,
          configuredSourcePaths(),
          GLOBALS.authorizedSourceFolderRealPaths,
        );
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
      const sourceFolder = GLOBALS.selectedSourceFolders[sourceIndex];
      if (!sourceFolder) {
        throw new Error('The source folder is not configured for this catalogue.');
      }
      requireAuthorizedSourceRoot(
        sourceFolder.path,
        configuredSourcePaths(),
        GLOBALS.authorizedSourceFolderRealPaths,
      );
      const authorizedHashes = GLOBALS.authorizedCatalogueImageHashes;
      const mediaAuthority = GLOBALS.authorizedCatalogueMediaLocations;
      const maximumEntries = authorizedHashes.size + 10_000;
      if (!Array.isArray(postChangeCatalogue) || postChangeCatalogue.length > maximumEntries) {
        throw new Error('The updated catalogue is too large.');
      }
      let requestedMediaLocationCount = 0;
      const cacheCatalogue = postChangeCatalogue.filter((element: ImageElement): boolean => {
        if (!element || element.deleted === true || element.cleanName === '*FOLDER*') {
          return false;
        }
        requestedMediaLocationCount += Array.isArray(element.locations)
          ? element.locations.length
          : 1;
        if (requestedMediaLocationCount > mediaAuthority.size + 10_000) {
          throw new Error('The updated catalogue contains too many media locations.');
        }
        return true;
      });
      const validatedPayloadAuthority = rendererWriteMediaAuthority(cacheCatalogue);
      const result = updateSourceFolderIgnoredSubdirectories(
        sourceIndex,
        ignoredSubdirectories,
        cacheCatalogue,
      );
      const nextMediaAuthority = new Set(mediaAuthority);
      validatedPayloadAuthority.forEach((key: string) => nextMediaAuthority.add(key));
      removeCatalogueMediaAuthorityForSourceScopes(
        nextMediaAuthority,
        sourceIndex,
        result.ignoredSubdirectories,
      );
      GLOBALS.authorizedCatalogueMediaLocations = nextMediaAuthority;
      GLOBALS.authorizedCatalogueImageHashes = catalogueMediaAuthorityHashes(nextMediaAuthority);
      return result;
    },
  );

  /**
   * extract any missing thumbnails
   */
  trustedIpcOn('add-missing-thumbnails', (event, finalArray: ImageElement[], extractClips: boolean) => {
    if (isFolderThumbnailRegenerationActive()) {
      return;
    }
    const maximumEntries = GLOBALS.authorizedCatalogueImageHashes.size + 10_000;
    if (!Array.isArray(finalArray) || finalArray.length > maximumEntries) {
      console.warn('Ignored an oversized missing-thumbnail request.');
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
        || items.length > GLOBALS.authorizedCatalogueImageHashes.size + 10_000
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
  trustedIpcOn('clean-old-thumbnails', async (event, finalArray: ImageElement[]): Promise<void> => {
    if (
      thumbnailCleanupInProgress
      || isThumbnailRegenerationActive()
      || activeCustomThumbnailReplacements > 0
    ) {
      return;
    }

    let cleanupBarrier: PreviewCleanupBarrier | undefined;
    let cleanupSession: CatalogueSessionSnapshot;
    try {
      cleanupSession = captureCatalogueSession();
    } catch (error) {
      console.warn('Unable to begin generated-preview cleanup:', error);
      return;
    }
    if (!beginCatalogueMaintenance()) {
      return;
    }
    thumbnailCleanupInProgress = true;
    try {
      if (!Array.isArray(finalArray)) {
        throw new Error('The current catalogue entries are invalid.');
      }

      const authorizedHashes = GLOBALS.authorizedCatalogueImageHashes;
      const mediaAuthority = GLOBALS.authorizedCatalogueMediaLocations;
      const baselineMediaAuthority = new Set(mediaAuthority);
      if (finalArray.length > authorizedHashes.size + 10_000) {
        throw new Error('The current catalogue contains too many entries for preview cleanup.');
      }
      const outputDirectory = GLOBALS.selectedOutputFolder;
      const hubName = GLOBALS.hubName;
      const survivingHashes = new Set<string>();
      for (const element of finalArray) {
        if (
          !element
          || element.deleted === true
          || element.cleanName === '*FOLDER*'
        ) {
          continue;
        }
        const hash = typeof element.hash === 'string' ? element.hash : '';
        if (
          !/^[a-zA-Z0-9_-]{1,200}$/.test(hash)
          || !authorizedHashes.has(hash)
        ) {
          throw new Error('The requested catalogue entries are not authorized for preview cleanup.');
        }
        survivingHashes.add(hash);
      }

      const omittedHashes = Array.from(authorizedHashes).filter(
        (hash: string) => !survivingHashes.has(hash),
      );
      const owner = activeWindow();
      const options = {
        buttons: ['Remove Generated Previews', 'Cancel'],
        cancelId: 1,
        defaultId: 1,
        detail: omittedHashes.length > 0
          ? [
            `Generated previews for ${omittedHashes.length} removed catalogue ${omittedHashes.length === 1 ? 'entry' : 'entries'} will be deleted.`,
            'The source videos and the catalogue file will not be changed.',
          ].join('\n')
          : [
            'Generated preview folders will be checked for stale files that are no longer referenced by this catalogue.',
            'The source videos and the catalogue file will not be changed.',
          ].join('\n'),
        message: 'Clean generated previews?',
        noLink: true,
        title: 'Clean Generated Previews?',
        type: 'warning' as const,
      };
      const choice = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (choice.response !== 0) {
        return;
      }

      // A window switch while the native confirmation was open gives the new
      // catalogue no authority to reuse this request's hashes or asset path.
      if (
        GLOBALS.authorizedCatalogueImageHashes !== authorizedHashes
        || GLOBALS.authorizedCatalogueMediaLocations !== mediaAuthority
        || GLOBALS.selectedOutputFolder !== outputDirectory
        || GLOBALS.hubName !== hubName
        || isThumbnailRegenerationActive()
        || activeCustomThumbnailReplacements > 0
      ) {
        return;
      }

      const assetDirectory = resolveTheatrumAssetDirectory(outputDirectory, hubName);
      if (!assetDirectory) {
        throw new Error('The catalogue preview asset directory is invalid.');
      }
      const preserveTrustedAdditions = (): void => {
        mediaAuthority.forEach((key: string) => {
          if (baselineMediaAuthority.has(key)) {
            return;
          }
          const separatorIndex = key.indexOf('\0');
          if (separatorIndex > 0) {
            survivingHashes.add(key.slice(0, separatorIndex));
          }
        });
      };
      const cleanupStillOwned = (): boolean => (
        GLOBALS.cataloguePersistenceActive
        && catalogueSessionIsCurrent(cleanupSession)
        && GLOBALS.authorizedCatalogueImageHashes === authorizedHashes
        && GLOBALS.authorizedCatalogueMediaLocations === mediaAuthority
        && GLOBALS.selectedOutputFolder === outputDirectory
        && GLOBALS.hubName === hubName
        && !isThumbnailRegenerationActive()
        && activeCustomThumbnailReplacements === 0
        && !event.sender.isDestroyed()
      );
      const hashIsStillStale = (hash: string): boolean => {
        preserveTrustedAdditions();
        return !survivingHashes.has(hash);
      };
      preserveTrustedAdditions();
      cleanupBarrier = beginPreviewCleanupBarrier(omittedHashes.filter(hashIsStillStale));
      const cleanupScheduled = await removeThumbnailsNotInHub(
        new Map(Array.from(survivingHashes, hash => [hash, 1] as [string, 1])),
        outputDirectory,
        assetDirectory,
        cleanupStillOwned,
        hashIsStillStale,
      );
      if (
        cleanupScheduled
        && cleanupStillOwned()
      ) {
        preserveTrustedAdditions();
        GLOBALS.authorizedCatalogueImageHashes = survivingHashes;
        retainCatalogueMediaHashAuthority(
          GLOBALS.authorizedCatalogueMediaLocations,
          survivingHashes,
        );
      }
    } catch (error) {
      console.warn('Unable to clean generated previews:', error);
    } finally {
      if (cleanupBarrier) {
        finishPreviewCleanupBarrier(cleanupBarrier);
      }
      thumbnailCleanupInProgress = false;
      finishCatalogueMaintenance();
    }
  });

  /**
   * Save the currently open VHA file without closing the app.
   */
  trustedIpcOn('save-current-vha-file', (event, finalObjectToSave: FinalObject) => {
    if (finalObjectToSave === null) {
      try {
        captureCatalogueSession();
      } catch (error) {
        event.sender.send(
          'current-vha-file-save-failed',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      event.sender.send('current-vha-file-saved');
      return;
    }
    if (isThumbnailRegenerationActive()) {
      event.sender.send(
        'current-vha-file-save-failed',
        'Wait for thumbnail regeneration to finish before saving the catalogue.',
      );
      return;
    }

    let session: CatalogueSessionSnapshot;
    let commit: AuthorizedCatalogueCommit;
    let baselineAuthority: Set<string>;
    try {
      session = captureCatalogueSession();
      GLOBALS.cataloguePersistenceActive = true;
      baselineAuthority = new Set(GLOBALS.authorizedCatalogueMediaLocations);
      commit = prepareRendererCatalogueCommit(finalObjectToSave);
    } catch (error) {
      releaseCataloguePersistence();
      event.sender.send(
        'current-vha-file-save-failed',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    writeVhaFileToDisk(commit.finalObject, session.cataloguePath, (err) => {
      if (err) {
        releaseCataloguePersistence();
        event.sender.send('current-vha-file-save-failed', err.message || err.toString());
        return;
      }
      if (!catalogueSessionIsCurrent(session)) {
        releaseCataloguePersistence();
        event.sender.send('current-vha-file-save-failed', 'The active catalogue changed while it was being saved.');
        return;
      }
      preserveTrustedScannerAdditions(baselineAuthority, commit);
      reconcileSelectedSourceFolders(commit.finalObject.inputDirs);
      GLOBALS.authorizedCatalogueImageHashes = commit.imageHashes;
      GLOBALS.authorizedCatalogueMediaLocations = commit.mediaAuthority;
      releaseCataloguePersistence();
      event.sender.send('current-vha-file-saved');
    });
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
        const selectedDirectory = rememberNativeDirectorySelection(
          outputDirPath,
          GLOBALS.pendingOutputDirectorySelections,
          'Output folder',
        );
        event.sender.send('output-folder-chosen', selectedDirectory);
      }
    }).catch(error => {
      console.warn('Unable to choose an output folder:', error);
    });
  });

  /**
   * Try to rename the particular file
   */
  trustedIpcOn('try-to-rename-this-file', async (
    event,
    item: unknown,
    renameTo: unknown,
    index: unknown,
  ): Promise<void> => {
    console.log('renaming file:');

    let original: string;
    let newName: string;
    let reviewedRealPath: string;
    const mediaAuthority = GLOBALS.authorizedCatalogueMediaLocations;
    const cataloguePath = GLOBALS.currentlyOpenVhaFile;
    const candidate = item as Partial<ImageElement>;
    const originalFile = typeof candidate?.fileName === 'string' ? candidate.fileName : '';
    try {
      if (!Number.isSafeInteger(index) || typeof renameTo !== 'string') {
        throw new Error('The rename request is invalid.');
      }
      const authorized = resolveAuthorizedCatalogueMediaItem(item);
      const sourceFolder = GLOBALS.selectedSourceFolders[authorized.item.inputSource];
      const configuredBasePath = requireAuthorizedSourceRoot(
        sourceFolder?.path,
        configuredSourcePaths(),
        GLOBALS.authorizedSourceFolderRealPaths,
      );
      original = authorized.fullPath;
      newName = resolveNewMediaPath(
        configuredBasePath,
        authorized.item.partialPath,
        renameTo,
      );
      requireConfiguredMediaFileName(renameTo);
      if (path.extname(renameTo).toLocaleLowerCase('en-US') !== path.extname(originalFile).toLocaleLowerCase('en-US')) {
        throw new Error('Renaming cannot change the media file type.');
      }
      reviewedRealPath = authorized.fullPath;
    } catch (error) {
      console.warn('Ignored unsafe rename path:', error);
      event.sender.send('rename-file-response', index, false, renameTo, originalFile, 'RIGHTCLICK.errorSomeError');
      return;
    }

    console.log(original);
    console.log(newName);

    if (!beginCatalogueMaintenance()) {
      event.sender.send('rename-file-response', index, false, renameTo, originalFile, 'RIGHTCLICK.errorSomeError');
      return;
    }

    try {
      const owner = activeWindow();
      const options = {
        buttons: ['Rename', 'Cancel'],
        cancelId: 1,
        defaultId: 1,
        detail: [
          `From: ${pathForNativeDialog(original)}`,
          `To: ${pathForNativeDialog(newName)}`,
        ].join('\n'),
        message: 'Rename this media file?',
        noLink: true,
        title: 'Rename Media File?',
        type: 'warning' as const,
      };
      const choice = owner
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      if (choice.response !== 0) {
        event.sender.send('rename-file-response', index, false, renameTo, originalFile, '');
        return;
      }

      if (
        GLOBALS.authorizedCatalogueMediaLocations !== mediaAuthority
        || GLOBALS.currentlyOpenVhaFile !== cataloguePath
      ) {
        throw new Error('The active catalogue changed while confirmation was open.');
      }
      const authorized = resolveAuthorizedCatalogueMediaItem(item);
      const sourceFolder = GLOBALS.selectedSourceFolders[authorized.item.inputSource];
      const configuredBasePath = requireAuthorizedSourceRoot(
        sourceFolder?.path,
        configuredSourcePaths(),
        GLOBALS.authorizedSourceFolderRealPaths,
      );
      original = authorized.fullPath;
      newName = resolveNewMediaPath(
        configuredBasePath,
        authorized.item.partialPath,
        renameTo,
      );
      const currentRealPath = authorized.fullPath;
      const sameIdentity = process.platform === 'win32'
        ? currentRealPath.toLocaleLowerCase('en-US') === reviewedRealPath.toLocaleLowerCase('en-US')
        : currentRealPath === reviewedRealPath;
      if (!sameIdentity) {
        throw new Error('The media file changed while confirmation was open.');
      }
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
          renameCatalogueMediaLocationAuthority(
            GLOBALS.authorizedCatalogueMediaLocations,
            item,
            renameTo,
          );
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

      event.sender.send('rename-file-response', index, success, renameTo, originalFile, errMsg);
    } catch (error) {
      console.warn('Cancelled rename after the media path changed:', error);
      event.sender.send('rename-file-response', index, false, renameTo, originalFile, 'RIGHTCLICK.errorSomeError');
    } finally {
      finishCatalogueMaintenance();
    }
  });

  /**
   * Close the window / quit / exit the app
   */
  trustedIpcOn('close-window', (event, settingsToSave: SettingsObject, finalObjectToSave: FinalObject) => {
    let closeSession: CatalogueSessionSnapshot;
    let closeBaselineAuthority: Set<string>;
    try {
      closeSession = captureCatalogueSession();
      GLOBALS.cataloguePersistenceActive = true;
      closeBaselineAuthority = new Set(GLOBALS.authorizedCatalogueMediaLocations);
    } catch (error) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(
          'close-window-save-failed',
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    const reportCloseFailure = (error: unknown, message: string) => {
      releaseCataloguePersistence();
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
        GLOBALS.readyToQuit = true;
        releaseCataloguePersistence();
        const windowToClose = activeWindow();
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
        } else {
          releaseCataloguePersistence();
        }
      }).catch((dialogError) => {
        releaseCataloguePersistence();
        console.error('Unable to show the catalogue save failure dialog:', dialogError);
      });
    };

    const saveAndClose = (): void => {
      let json: string;
      let authorizedCommit: AuthorizedCatalogueCommit | null = null;
      try {
        if (!catalogueSessionIsCurrent(closeSession)) {
          throw new Error('The active catalogue changed before it could be saved.');
        }
        if (!settingsToSave || typeof settingsToSave !== 'object' || !settingsToSave.appState) {
          throw new Error('The application settings are invalid.');
        }
        if (settingsToSave.appState.preferredVideoPlayer === '') {
          // Removing a privileged executable preference is safe to accept from
          // the renderer; adding or replacing one still requires the native picker.
          GLOBALS.preferredVideoPlayer = '';
          GLOBALS.preferredVideoPlayerArguments = '';
        }
        // The executable is selected only by the native picker and retained in
        // the main process. Do not let a renderer-provided settings payload
        // replace that authority while the app is closing.
        settingsToSave.appState.preferredVideoPlayer = GLOBALS.preferredVideoPlayer;
        settingsToSave.appState.videoPlayerArgs = GLOBALS.preferredVideoPlayerArguments;
        settingsToSave.appState.currentVhaFile = closeSession.cataloguePath;
        settingsToSave.vhaFileHistory = Array.isArray(settingsToSave.vhaFileHistory)
          ? settingsToSave.vhaFileHistory.filter((historyItem: any): boolean => {
            try {
              const cataloguePath = normalizeAbsolutePath(
                historyItem?.vhaFilePath,
                'Recent catalogue file',
              );
              return GLOBALS.authorizedCataloguePaths.has(cataloguePath);
            } catch {
              return false;
            }
          })
          : [];
        if (finalObjectToSave !== null && GLOBALS.catalogueAccessMode !== 'read-only') {
          authorizedCommit = prepareRendererCatalogueCommit(finalObjectToSave);
        }
        // convert shortcuts map to object
        settingsToSave.shortcuts = <any>Object.fromEntries(settingsToSave.shortcuts);
        json = JSON.stringify(settingsToSave);
        fs.mkdirSync(GLOBALS.settingsPath, { recursive: true });
      } catch (error) {
        reportCloseFailure(error, 'The application settings could not be prepared for saving. The app will remain open.');
        return;
      }

      writeJsonAtomically(path.join(GLOBALS.settingsPath, 'settings.json'), json).then(() => {
        if (!catalogueSessionIsCurrent(closeSession)) {
          reportCloseFailure(
            new Error('The active catalogue changed while settings were being saved.'),
            'The app will remain open because the active catalogue changed during saving.',
          );
          return;
        }
        if (finalObjectToSave === null || GLOBALS.catalogueAccessMode === 'read-only') {
          closeWindow();
          return;
        }

        writeVhaFileToDisk(authorizedCommit.finalObject, closeSession.cataloguePath, (error: Error) => {
          if (error) {
            reportCatalogueCloseFailure(error);
            return;
          }
          if (!catalogueSessionIsCurrent(closeSession)) {
            reportCloseFailure(
              new Error('The active catalogue changed while it was being saved.'),
              'The app will remain open because the active catalogue changed during saving.',
            );
            return;
          }
          preserveTrustedScannerAdditions(closeBaselineAuthority, authorizedCommit);
          reconcileSelectedSourceFolders(authorizedCommit.finalObject.inputDirs);
          GLOBALS.authorizedCatalogueImageHashes = authorizedCommit.imageHashes;
          GLOBALS.authorizedCatalogueMediaLocations = authorizedCommit.mediaAuthority;
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
        releaseCataloguePersistence();
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
