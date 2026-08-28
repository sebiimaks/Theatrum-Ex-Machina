// Update the version when building
import { GLOBALS, type CatalogueAccessMode } from './node/main-globals';

GLOBALS.macVersion = process.platform === 'darwin';

import * as path from 'path';

const fs = require('fs');
const electron = require('electron');
const { nativeTheme } = require('electron');
import { app, BrowserWindow, screen, dialog, systemPreferences, ipcMain, protocol, clipboard } from 'electron';
const windowStateKeeper = require('electron-window-state');

// Methods
import { createTouchBar, updateTouchBarFromApp } from './node/main-touch-bar';
import { setUpIpcMessages } from './node/main-ipc';
import { insertTemporaryFields, sendFinalObjectToAngular, setUpDirectoryWatchers, upgradeToVersion3, writeVhaFileToDisk, parseAdditionalExtensions } from './node/main-support';
import {
  parseVhaJson,
  readVhaFileWithBackup,
  recoverVhaFileFromBackup,
  writeVhaJsonExclusively,
} from './node/vha-file-persistence';
import { CatalogueOpenQueue } from './node/catalogue-open-queue';
import { prepareAuthorizedCatalogueWrite } from './node/catalogue-write-authority';
import {
  buildCatalogueMediaLocationAuthority,
  catalogueMediaAuthorityHashes,
  catalogueMediaAuthorityLocationsForHash,
  reconcileCatalogueMediaLocationAuthority,
} from './node/catalogue-media-authority';
import { registerTheatrumProtocols } from './node/theatrum-protocol';
import { resolveTheatrumAssetDirectory } from './node/theatrum-protocol-paths';
import { THEATRUM_APP_HOST, THEATRUM_APP_PROTOCOL } from './interfaces/theatrum-protocol';

// Interfaces
import { FinalObject, type ImageLocation } from './interfaces/final-object.interface';
import { SettingsObject } from './interfaces/settings-object.interface';
import { WizardOptions } from './interfaces/wizard-options.interface';
import {
  closeAllWatchers,
  closeWatcher,
  isThumbnailRegenerationActive,
  resetAllQueues,
  setThumbnailRegenerationBlocked,
} from './node/main-extract-async';
import { sanitizeScreenshotSettings } from './node/thumbnail-count';
import { recoverInterruptedPreviewTransactions } from './node/thumbnail-transaction';
import {
  CATALOGUE_PICKER_EXTENSIONS,
  catalogueFileName,
  hasCatalogueOrAssetNameCollision,
  isCataloguePickerFilePath,
  isSafeCatalogueHubName,
} from './interfaces/catalogue-file';
import {
  normalizeAbsolutePath,
  requireAuthorizedSourceRoot,
  resolveAuthorizedSourceDirectory,
  resolveExistingMediaPath,
  resolveExistingSourceSubfolder,
  reviewPersistedSourceAccessRequests,
} from './node/local-operation-safety';
import {
  loadAuthorizedCataloguePaths,
  loadAuthorizedPlayerPaths,
  rememberCataloguePathAuthorization,
  rememberSourceAccessDecision,
  rememberSourceWatchDecision,
  sourceAccessDecision,
  sourceWatchDecision,
} from './node/path-authority-store';
import { configuredMediaFileExtensions } from './node/main-filenames';

// Variables
const pathToAppData = app.getPath('appData');
const pathToPortableApp = process.env.PORTABLE_EXECUTABLE_DIR;
const packagedSmokeTest = process.env.THEATRUM_PACKAGED_SMOKE_TEST === '1';
if (packagedSmokeTest) {
  if (!pathToPortableApp) {
    throw new Error('Packaged smoke testing requires an isolated PORTABLE_EXECUTABLE_DIR.');
  }
  const smokeUserDataPath = path.join(pathToPortableApp, 'user-data');
  fs.mkdirSync(smokeUserDataPath, { recursive: true });
  app.setPath('userData', smokeUserDataPath);
}
GLOBALS.settingsPath = pathToPortableApp ? pathToPortableApp : path.join(pathToAppData, 'theatrum-ex-machina');
loadAuthorizedCataloguePaths(GLOBALS.settingsPath).forEach((cataloguePath: string) => {
  try {
    const canonicalCataloguePath = fs.realpathSync.native(cataloguePath);
    const normalizedStoredPath = path.normalize(cataloguePath);
    const unchangedIdentity = process.platform === 'win32'
      ? canonicalCataloguePath.toLocaleLowerCase('en-US') === normalizedStoredPath.toLocaleLowerCase('en-US')
      : canonicalCataloguePath === normalizedStoredPath;
    if (
      unchangedIdentity
      && isCataloguePickerFilePath(canonicalCataloguePath)
      && fs.statSync(canonicalCataloguePath).isFile()
    ) {
      GLOBALS.authorizedCataloguePaths.add(canonicalCataloguePath);
    }
  } catch {
    // Missing or retargeted saved paths do not regain authority automatically.
  }
});

const English = require('./i18n/en.json');
let systemMessages = English.SYSTEM; // Set English as default; update via `system-messages-updated`

let screenWidth;
let screenHeight;

let rendererStartupComplete = false;
let rendererCanReceiveCatalogueOpenRequests = false;
let catalogueOpenOperationActive = false;
let activeCatalogueOpenGeneration: number | undefined;
const catalogueOpenQueue = new CatalogueOpenQueue();

type CatalogueOpenIntent = CatalogueAccessMode | 'duplicate-scaena';

interface CatalogueOpenResult {
  loadedFromBackup: boolean;
  opened: boolean;
  primaryError?: string;
}

interface DuplicateLegacyCatalogueResult {
  destinationPath: string;
  loadedFromBackup: boolean;
  primaryError?: string;
}

interface NewCatalogueCreation {
  assetDirectory: string;
  finalObject: FinalObject;
  outputDirectory: string;
  sourceCanonicalPath: string;
  sourceRoot: string;
}

interface SourceAccessAuthorization {
  changed: boolean;
  paths: Set<string>;
  realPaths: Map<string, string>;
}

class CatalogueOpenSupersededError extends Error {
  constructor() {
    super('The catalogue-open operation was superseded.');
    this.name = 'CatalogueOpenSupersededError';
  }
}

/**
 * Each catalogue transition receives a main-process-owned generation.  The
 * renderer can request an open, but it cannot replace an in-flight operation
 * or allow a delayed dialog result to commit after that operation is stale.
 */
function beginCatalogueOpenOperation(): number | undefined {
  if (
    catalogueOpenOperationActive
    || GLOBALS.catalogueTransitionActive
    || GLOBALS.cataloguePersistenceActive
  ) {
    return undefined;
  }
  catalogueOpenOperationActive = true;
  GLOBALS.catalogueTransitionActive = true;
  // Advancing this public main-owned epoch invalidates pending renderer-originated
  // work for the old catalogue before any target catalogue dialog or I/O begins.
  activeCatalogueOpenGeneration = ++GLOBALS.catalogueSessionGeneration;
  return activeCatalogueOpenGeneration;
}

function isCurrentCatalogueOpenOperation(generation: number): boolean {
  return catalogueOpenOperationActive
    && GLOBALS.catalogueTransitionActive
    && GLOBALS.catalogueSessionGeneration === generation
    && activeCatalogueOpenGeneration === generation;
}

function assertCurrentCatalogueOpenOperation(generation: number): void {
  if (!isCurrentCatalogueOpenOperation(generation)) {
    throw new CatalogueOpenSupersededError();
  }
}

function finishCatalogueOpenOperation(generation: number): void {
  if (!catalogueOpenOperationActive || activeCatalogueOpenGeneration !== generation) {
    return;
  }
  catalogueOpenOperationActive = false;
  GLOBALS.catalogueTransitionActive = false;
  activeCatalogueOpenGeneration = undefined;
  dispatchNextCatalogueOpenRequest();
}

function invalidateActiveCatalogueOpenOperation(): void {
  if (!catalogueOpenOperationActive && !GLOBALS.catalogueTransitionActive) {
    return;
  }
  GLOBALS.catalogueSessionGeneration++;
  catalogueOpenOperationActive = false;
  GLOBALS.catalogueTransitionActive = false;
  activeCatalogueOpenGeneration = undefined;
}

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

async function authorizePersistedSourceAccess(
  finalObject: FinalObject,
  cataloguePath: string,
  operationGeneration: number,
): Promise<SourceAccessAuthorization> {
  assertCurrentCatalogueOpenOperation(operationGeneration);
  const catalogueAuthorityPath = fs.realpathSync.native(cataloguePath);
  const review = reviewPersistedSourceAccessRequests(finalObject.inputDirs);
  const unknownPaths: string[] = [];
  const reviewedRealPaths = new Map<string, string>();
  const authorizedPaths = new Set<string>();
  const authorizedRealPaths = new Map<string, string>();

  review.requestedPaths.forEach((sourcePath: string) => {
    assertCurrentCatalogueOpenOperation(operationGeneration);
    let canonicalSourcePath: string;
    try {
      resolveAuthorizedSourceDirectory(sourcePath);
      canonicalSourcePath = fs.realpathSync.native(sourcePath);
      reviewedRealPaths.set(sourcePath, canonicalSourcePath);
    } catch {
      // Disconnected and unsafe roots remain visible but receive no capability.
      return;
    }

    const decision = sourceAccessDecision(
      GLOBALS.settingsPath,
      catalogueAuthorityPath,
      canonicalSourcePath,
    );
    if (decision === true) {
      authorizedPaths.add(sourcePath);
      authorizedRealPaths.set(sourcePath, canonicalSourcePath);
    } else if (decision === undefined) {
      unknownPaths.push(sourcePath);
    }
  });

  if (unknownPaths.length === 0) {
    return {
      changed: review.changed,
      paths: authorizedPaths,
      realPaths: authorizedRealPaths,
    };
  }

  const watchCount = review.watchSourceKeys.filter((sourceKey: number) => {
    const sourcePath = finalObject.inputDirs[sourceKey]?.path;
    return typeof sourcePath === 'string' && unknownPaths.includes(path.normalize(sourcePath));
  }).length;
  const batchSize = 10;
  const batchCount = Math.ceil(unknownPaths.length / batchSize);
  for (let start = 0; start < unknownPaths.length; start += batchSize) {
    assertCurrentCatalogueOpenOperation(operationGeneration);
    const batch = unknownPaths.slice(start, start + batchSize);
    const batchNumber = Math.floor(start / batchSize) + 1;
    const choice = await dialog.showMessageBox(win, {
      buttons: ['Allow These Folders', 'Open Without These Folders'],
      cancelId: 1,
      defaultId: 1,
      detail: [
        `Folder group ${batchNumber} of ${batchCount}:`,
        '',
        ...batch.map(pathForNativeDialog),
        '',
        watchCount > 0
          ? `${watchCount} requested source folder(s) also request continuous automatic watching.`
          : 'No source folder requests continuous automatic watching.',
        '',
        'Folder access permits media playback, scanning, and user-requested file operations. Only allow it if you trust the catalogue and recognize every folder listed above.',
      ].join('\n'),
      message: 'Allow this catalogue to access these media folders?',
      noLink: true,
      title: 'Allow Catalogue Folder Access?',
      type: 'warning',
    });
    assertCurrentCatalogueOpenOperation(operationGeneration);
    const allow = choice.response === 0;
    // An affirmative choice grants only the paths displayed in this dialog.
    // A denial can safely cover all remaining paths because it confers no capability.
    const pathsToRecord = allow ? batch : unknownPaths.slice(start);
    pathsToRecord.forEach((sourcePath: string) => {
      assertCurrentCatalogueOpenOperation(operationGeneration);
      const reviewedRealPath = reviewedRealPaths.get(sourcePath);
      let canonicalSourcePath: string;
      try {
        resolveAuthorizedSourceDirectory(sourcePath);
        canonicalSourcePath = fs.realpathSync.native(sourcePath);
      } catch {
        return;
      }
      const sameIdentity = process.platform === 'win32'
        ? canonicalSourcePath.toLocaleLowerCase('en-US') === reviewedRealPath?.toLocaleLowerCase('en-US')
        : canonicalSourcePath === reviewedRealPath;
      if (!sameIdentity) {
        console.warn('Source-folder identity changed while access confirmation was open.');
        return;
      }
      rememberSourceAccessDecision(
        GLOBALS.settingsPath,
        catalogueAuthorityPath,
        canonicalSourcePath,
        allow,
      );
      if (allow) {
        authorizedPaths.add(sourcePath);
        authorizedRealPaths.set(sourcePath, canonicalSourcePath);
      }
    });
    if (!allow) {
      break;
    }
  }
  assertCurrentCatalogueOpenOperation(operationGeneration);
  return {
    changed: review.changed,
    paths: authorizedPaths,
    realPaths: authorizedRealPaths,
  };
}

async function authorizePersistedSourceWatches(
  finalObject: FinalObject,
  cataloguePath: string,
  sourceAccess: SourceAccessAuthorization,
  operationGeneration: number,
): Promise<Set<string>> {
  assertCurrentCatalogueOpenOperation(operationGeneration);
  const catalogueAuthorityPath = fs.realpathSync.native(cataloguePath);
  const authorizedWatchPaths = new Set<string>();
  const unknownWatchPaths: string[] = [];

  Object.values(finalObject.inputDirs).forEach(source => {
    assertCurrentCatalogueOpenOperation(operationGeneration);
    if (source?.watch !== true) {
      return;
    }
    let sourcePath: string;
    try {
      sourcePath = normalizeAbsolutePath(source.path, 'Source folder');
    } catch {
      return;
    }
    const canonicalSourcePath = sourceAccess.realPaths.get(sourcePath);
    if (!canonicalSourcePath || !sourceAccess.paths.has(sourcePath)) {
      return;
    }
    const decision = sourceWatchDecision(
      GLOBALS.settingsPath,
      catalogueAuthorityPath,
      canonicalSourcePath,
    );
    if (decision === true) {
      authorizedWatchPaths.add(sourcePath);
    } else if (decision === undefined) {
      unknownWatchPaths.push(sourcePath);
    }
  });

  if (unknownWatchPaths.length === 0) {
    return authorizedWatchPaths;
  }
  const batchSize = 10;
  const batchCount = Math.ceil(unknownWatchPaths.length / batchSize);
  for (let start = 0; start < unknownWatchPaths.length; start += batchSize) {
    assertCurrentCatalogueOpenOperation(operationGeneration);
    const batch = unknownWatchPaths.slice(start, start + batchSize);
    const batchNumber = Math.floor(start / batchSize) + 1;
    const choice = await dialog.showMessageBox(win, {
      buttons: ['Allow Watching These Folders', 'Open Without Watching'],
      cancelId: 1,
      defaultId: 1,
      detail: [
        `Folder group ${batchNumber} of ${batchCount}:`,
        '',
        ...batch.map(pathForNativeDialog),
        '',
        'Automatic watching continuously scans every folder listed above and its subfolders for changes. Only allow this if you recognize every folder in this group and want background monitoring.',
      ].join('\n'),
      message: 'Allow automatic watching for these folders?',
      noLink: true,
      title: 'Allow Automatic Folder Watching?',
      type: 'warning',
    });
    assertCurrentCatalogueOpenOperation(operationGeneration);
    const allow = choice.response === 0;
    const pathsToRecord = allow ? batch : unknownWatchPaths.slice(start);
    pathsToRecord.forEach((sourcePath: string) => {
      assertCurrentCatalogueOpenOperation(operationGeneration);
      const expectedRealPath = sourceAccess.realPaths.get(sourcePath);
      if (!expectedRealPath) {
        return;
      }
      let currentRealPath: string;
      try {
        resolveAuthorizedSourceDirectory(sourcePath);
        currentRealPath = fs.realpathSync.native(sourcePath);
      } catch {
        return;
      }
      const sameIdentity = process.platform === 'win32'
        ? currentRealPath.toLocaleLowerCase('en-US') === expectedRealPath.toLocaleLowerCase('en-US')
        : currentRealPath === expectedRealPath;
      if (!sameIdentity) {
        return;
      }
      rememberSourceWatchDecision(
        GLOBALS.settingsPath,
        catalogueAuthorityPath,
        currentRealPath,
        allow,
      );
      if (allow) {
        authorizedWatchPaths.add(sourcePath);
      }
    });
    if (!allow) {
      break;
    }
  }
  assertCurrentCatalogueOpenOperation(operationGeneration);
  return authorizedWatchPaths;
}

function reconcileSourceFoldersBeforeCatalogueSwitch(nextSources: FinalObject['inputDirs']): void {
  const retainedPaths = new Set<string>();
  Object.values(nextSources || {}).forEach(source => {
    try {
      retainedPaths.add(normalizeAbsolutePath(source?.path, 'Source folder'));
    } catch {
      // The write-authority projection validates usable source entries.
    }
  });

  Object.entries(GLOBALS.selectedSourceFolders || {}).forEach(([sourceKey, source]) => {
    const sourceIndex = /^(0|[1-9][0-9]*)$/.test(sourceKey) ? Number(sourceKey) : Number.NaN;
    let currentPath: string | undefined;
    let nextPath: string | undefined;
    try {
      currentPath = normalizeAbsolutePath(source?.path, 'Source folder');
    } catch {
      // Invalid legacy state is still safe to stop and discard.
    }
    try {
      nextPath = normalizeAbsolutePath(nextSources?.[sourceKey]?.path, 'Source folder');
    } catch {
      // A missing source at this key means its old watcher must stop.
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
}

function resolveCurrentCatalogueMediaLocation(location: ImageLocation): string {
  const allowedExtensions = new Set(
    configuredMediaFileExtensions(GLOBALS.additionalExtensions),
  );
  const logicalExtension = path.extname(location.fileName).slice(1).toLocaleLowerCase('en-US');
  if (!logicalExtension || !allowedExtensions.has(logicalExtension)) {
    throw new Error('The catalogue entry is not a configured media type.');
  }
  const source = GLOBALS.selectedSourceFolders[location.inputSource];
  if (!source?.path) {
    throw new Error('The catalogue source folder is unavailable.');
  }
  const authorizedRoot = requireAuthorizedSourceRoot(
    source.path,
    Array.from(GLOBALS.authorizedSourceFolderPaths),
    GLOBALS.authorizedSourceFolderRealPaths,
  );
  const lexicalPath = resolveExistingMediaPath(
    authorizedRoot,
    location.partialPath,
    location.fileName,
  );
  const canonicalPath = fs.realpathSync.native(lexicalPath);
  const canonicalExtension = path.extname(canonicalPath).slice(1).toLocaleLowerCase('en-US');
  if (
    !fs.statSync(canonicalPath).isFile()
    || canonicalExtension !== logicalExtension
    || !allowedExtensions.has(canonicalExtension)
  ) {
    throw new Error('The catalogue media link resolves to a different file type.');
  }
  return canonicalPath;
}

function reconcileRendererCatalogueMediaAuthority(
  images: FinalObject['images'],
): Set<string> {
  return reconcileCatalogueMediaLocationAuthority(
    images,
    GLOBALS.authorizedCatalogueImageHashes,
    GLOBALS.authorizedCatalogueMediaLocations,
    (hash: string, incomingLocation: ImageLocation): boolean => {
      let incomingPath: string;
      try {
        incomingPath = resolveCurrentCatalogueMediaLocation(incomingLocation);
      } catch {
        return false;
      }
      return catalogueMediaAuthorityLocationsForHash(
        GLOBALS.authorizedCatalogueMediaLocations,
        hash,
      ).some((authorizedLocation: ImageLocation): boolean => {
        try {
          const authorizedPath = resolveCurrentCatalogueMediaLocation(authorizedLocation);
          return process.platform === 'win32'
            ? authorizedPath.toLocaleLowerCase('en-US') === incomingPath.toLocaleLowerCase('en-US')
            : authorizedPath === incomingPath;
        } catch {
          return false;
        }
      });
    },
  );
}

function isCatalogueOpenIntent(value: unknown): value is CatalogueOpenIntent {
  return value === 'read-only' || value === 'read-write' || value === 'duplicate-scaena';
}

function isLegacyCataloguePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.vha2';
}

function nextDuplicateCataloguePath(sourcePath: string, attempt: number): string {
  const parsed = path.parse(sourcePath);
  const suffix = attempt === 0 ? '' : attempt === 1 ? ' copy' : ` copy ${attempt}`;
  return path.join(parsed.dir, `${parsed.name}${suffix}.scaena`);
}

function prepareLegacyCatalogueDuplicate(finalObject: FinalObject): string {
  // Validate both the persistent representation and the renderer's temporary
  // field preparation before publishing a new path. This keeps malformed
  // legacy data from leaving behind a copy that can never initialize.
  const duplicateObject = JSON.parse(JSON.stringify(finalObject)) as FinalObject;
  upgradeToVersion3(duplicateObject);
  duplicateObject.screenshotSettings = sanitizeScreenshotSettings(duplicateObject.screenshotSettings);
  const duplicateJson = JSON.stringify(duplicateObject);
  const validatedDuplicate = parseVhaJson(duplicateJson);
  const initializationProbe = JSON.parse(JSON.stringify(validatedDuplicate)) as FinalObject;
  insertTemporaryFields(initializationProbe.images);
  return duplicateJson;
}

async function duplicateLegacyCatalogue(sourcePath: string): Promise<DuplicateLegacyCatalogueResult> {
  const readResult = await readVhaFileWithBackup(sourcePath);
  if (!readResult.finalObject) {
    const primaryError = readResult.primaryError?.message || 'The catalogue could not be read.';
    const backupError = readResult.backupError?.message || 'No valid backup was found.';
    throw new Error(`${primaryError}\n${backupError}`);
  }

  const duplicateJson = prepareLegacyCatalogueDuplicate(readResult.finalObject);

  for (let attempt = 0; attempt < 10_000; attempt++) {
    const destination = nextDuplicateCataloguePath(sourcePath, attempt);
    try {
      await writeVhaJsonExclusively(destination, duplicateJson);
      return {
        destinationPath: destination,
        loadedFromBackup: readResult.source === 'backup',
        primaryError: readResult.primaryError?.message,
      };
    } catch (error) {
      const fileError = error as NodeJS.ErrnoException;
      if (fileError.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  throw new Error('A unique .scaena copy name could not be created beside the legacy catalogue.');
}

function dispatchNextCatalogueOpenRequest(): void {
  if (
    !rendererCanReceiveCatalogueOpenRequests
    || catalogueOpenOperationActive
    || GLOBALS.cataloguePersistenceActive
    || GLOBALS.readyToQuit
    || !GLOBALS.angularApp
  ) {
    return;
  }
  const sender = GLOBALS.angularApp.sender;
  if (!sender || sender.isDestroyed()) {
    return;
  }
  const queuedPath = catalogueOpenQueue.next();
  if (queuedPath) {
    sender.send('open-catalogue-from-system', queuedPath);
  }
}

GLOBALS.requestCatalogueOpenDispatch = dispatchNextCatalogueOpenRequest;

function requestCatalogueOpenFromSystem(filePath: string): void {
  if (!filePath) {
    return;
  }
  try {
    catalogueOpenQueue.enqueue(rememberCataloguePath(filePath, 'Catalogue file'));
  } catch (error) {
    console.warn('Ignored unsupported catalogue open request:', error);
    return;
  }
  dispatchNextCatalogueOpenRequest();
}

function catalogueOpenFailureSuffix(
  publishedDuplicatePath?: string,
  recoveredCatalogue = false,
): string {
  if (publishedDuplicatePath) {
    return `A .scaena copy was created and remains at:\n${publishedDuplicatePath}\n\nThe original .vha2 catalogue and its backup were not changed.`;
  }
  if (recoveredCatalogue) {
    return 'The catalogue backup was restored successfully, but the recovered catalogue could not be initialized.';
  }
  return 'No catalogue files were changed.';
}

function notifyCatalogueLoadedFromBackup(payload: {
  openedPath: string;
  primaryError?: string;
  readOnly: boolean;
  sourcePath: string;
}): void {
  const sender = GLOBALS.angularApp && GLOBALS.angularApp.sender;
  if (sender && !sender.isDestroyed()) {
    sender.send('catalogue-loaded-from-backup', payload);
  }
}

function removeEmptyCatalogueAssetFolders(hubAssetsDirectory: string): void {
  for (const childDirectory of ['filmstrips', 'thumbnails', 'clips']) {
    try {
      fs.rmdirSync(path.join(hubAssetsDirectory, childDirectory));
    } catch {
      // Preserve non-empty or externally altered directories.
    }
  }
  try {
    fs.rmdirSync(hubAssetsDirectory);
  } catch {
    // Preserve non-empty or externally altered directories.
  }
}

electron.Menu.setApplicationMenu(null);

// =================================================================================================

let win;
let myWindow = null;
const args = process.argv.slice(1);
const serve: boolean = !app.isPackaged && args.some(val => val === '--serve');

// This must be registered before Electron is ready. The handler itself is
// registered later, once the app can serve its packaged renderer bundle.
protocol.registerSchemesAsPrivileged([{
  scheme: THEATRUM_APP_PROTOCOL,
  privileges: {
    secure: true,
    standard: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

GLOBALS.debug = args.some(val => val === '--debug');
if (GLOBALS.debug) {
  console.log('Debug mode enabled!');
}

// =================================================================================================

// For windows -- when loading the app the first time
if (args[0]) {
  if (!serve) {
    requestCatalogueOpenFromSystem(args[0]);
  }
}

const gotTheLock = packagedSmokeTest || app.requestSingleInstanceLock(); // Open file on windows from file double click

if (!gotTheLock) {
  app.quit();
} else {

  app.on('second-instance', (event, argv: string[], workingDirectory: string) => {

    // dialog.showMessageBox(win, {
    //   message: 'second-instance: \n' + argv[0] + ' \n' + argv[1],
    //   buttons: ['OK']
    // });

    if (argv.length > 1) {
      requestCatalogueOpenFromSystem(argv[argv.length - 1]);
    }

    // Someone tried to run a second instance, we should focus our window.
    if (myWindow) {
      if (myWindow.isMinimized()) {
        myWindow.restore();
      }
      myWindow.focus();
    }
  });
}

function isAllowedRendererUrl(rawUrl: string): boolean {
  try {
    const parsedUrl = new URL(rawUrl);
    if (serve) {
      return parsedUrl.protocol === 'http:'
        && parsedUrl.hostname === 'localhost'
        && parsedUrl.port === '4200';
    }
    return parsedUrl.protocol === `${THEATRUM_APP_PROTOCOL}:`
      && parsedUrl.host === THEATRUM_APP_HOST;
  } catch {
    return false;
  }
}

function isTrustedRenderer(event: {
  sender?: Electron.WebContents;
  senderFrame?: Electron.WebFrameMain;
}): boolean {
  return Boolean(
    win
    && !win.isDestroyed()
    && event.sender
    && event.sender.id === win.webContents.id
    && isAllowedRendererUrl(event.sender.getURL())
    && event.senderFrame
    && event.senderFrame === event.sender.mainFrame
    && isAllowedRendererUrl(event.senderFrame.url),
  );
}

function trustedIpcOn(channel: string, listener: (event: Electron.IpcMainEvent, ...args: any[]) => void): void {
  ipcMain.on(channel, (event, ...args: any[]): void => {
    if (!isTrustedRenderer(event)) {
      console.warn('Ignored IPC message from an untrusted renderer:', channel);
      return;
    }
    listener(event, ...args);
  });
}

/**
 * A native directory choice is a short-lived main-process capability. Renderer
 * strings cannot register a new source or output location on their own.
 */
function requirePendingDirectorySelection(
  value: unknown,
  selections: Set<string>,
  label: string,
): string {
  const normalizedDirectory = normalizeAbsolutePath(value, label);
  if (!selections.has(normalizedDirectory)) {
    throw new Error(`${label} must be selected through the native folder picker.`);
  }
  resolveExistingSourceSubfolder(normalizedDirectory, '');
  return normalizedDirectory;
}

/** Record a native/OS-selected catalogue path before it is sent to the renderer. */
function rememberCataloguePath(value: unknown, label: string): string {
  const selectedCataloguePath = normalizeAbsolutePath(value, label);
  if (!isCataloguePickerFilePath(selectedCataloguePath)) {
    throw new Error('The selected file is not a supported catalogue.');
  }
  const cataloguePath = fs.realpathSync.native(selectedCataloguePath);
  if (!isCataloguePickerFilePath(cataloguePath) || !fs.statSync(cataloguePath).isFile()) {
    throw new Error('The selected catalogue is not a file.');
  }
  GLOBALS.authorizedCataloguePaths.add(cataloguePath);
  rememberCataloguePathAuthorization(GLOBALS.settingsPath, cataloguePath);
  return cataloguePath;
}

/** A renderer can open only catalogues selected by the OS, user, or saved app state. */
function requireAuthorizedCataloguePath(value: unknown): string {
  const requestedCataloguePath = normalizeAbsolutePath(value, 'Catalogue file');
  const cataloguePath = fs.realpathSync.native(requestedCataloguePath);
  if (!GLOBALS.authorizedCataloguePaths.has(cataloguePath)) {
    throw new Error('The catalogue must be selected through the system file picker.');
  }
  if (!isCataloguePickerFilePath(cataloguePath) || !fs.statSync(cataloguePath).isFile()) {
    throw new Error('The selected catalogue is unavailable or unsupported.');
  }
  return cataloguePath;
}

/**
 * A path obtained by Electron's webUtils from a real browser File may be used
 * once by the drag/drop workflows. It is intentionally not exposed as a
 * general renderer IPC channel.
 */
function rememberUserSelectedFilePath(value: unknown): void {
  try {
    const selectedPath = normalizeAbsolutePath(value, 'Selected file');
    if (!fs.statSync(selectedPath).isFile()) {
      throw new Error('The selected path is not a file.');
    }
    if (isCataloguePickerFilePath(selectedPath)) {
      rememberCataloguePath(selectedPath, 'Selected catalogue file');
    }
    GLOBALS.pendingUserFileSelections.add(selectedPath);
    while (GLOBALS.pendingUserFileSelections.size > 64) {
      const oldestPath = GLOBALS.pendingUserFileSelections.values().next().value;
      if (!oldestPath) {
        break;
      }
      GLOBALS.pendingUserFileSelections.delete(oldestPath);
    }
  } catch (error) {
    console.warn('Ignored invalid user-selected file path:', error);
  }
}

function createWindow() {
  const desktopSize = screen.getPrimaryDisplay().workAreaSize;

  screenWidth = desktopSize.width;
  screenHeight = desktopSize.height;
  const mainWindowState = windowStateKeeper({
    defaultWidth: 850,
    defaultHeight: 850
  });

  if (GLOBALS.macVersion) {
    electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'quit' },
          { role: 'hide' },
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'selectAll' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' }
        ]
      },
      {
        label: "View",
        submenu: [
          { role: "togglefullscreen" },
        ]
      },
      {
        label: "Window",
        role: 'windowMenu',
      },
    ]));
  }

  // Create the browser window.
  win = new BrowserWindow({
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      navigateOnDragDrop: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    center: true,
    minWidth: 420,
    minHeight: 250,
    show: !packagedSmokeTest,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'assets', 'logo.png')
      : path.join(__dirname, 'src/assets/icons/png/64x64.png'),
    frame: false  // removes the frame from the window completely
  });
  mainWindowState.manage(win);

  myWindow = win;

  // Renderer pages are never allowed to navigate the privileged application
  // window elsewhere, create popups, attach webviews, or request OS access.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault();
      console.warn('Blocked navigation outside the application renderer:', url);
    }
  });
  win.webContents.on('will-frame-navigate', (event, url) => {
    if (!isAllowedRendererUrl(url)) {
      event.preventDefault();
      console.warn('Blocked frame navigation outside the application renderer:', url);
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  if (packagedSmokeTest) {
    win.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
      console.error('THEATRUM_SMOKE_RENDERER_CONSOLE', { level, lineNumber, message, sourceId });
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('THEATRUM_SMOKE_LOAD_FAILURE', { errorCode, errorDescription, validatedURL });
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error('THEATRUM_SMOKE_RENDERER_GONE', details);
    });
  }

  // Open the DevTools.
  if (serve) {
    require('electron-reload')(__dirname, {
      electron: require(`${__dirname}/node_modules/electron`)
    });
    win.loadURL('http://localhost:4200');
    setTimeout(() => {
      win.webContents.openDevTools();
    }, 1000);
  } else {
    win.loadURL(`${THEATRUM_APP_PROTOCOL}://${THEATRUM_APP_HOST}/index.html`);
  }

  if (GLOBALS.macVersion) {
    const touchBar = createTouchBar();
    if (touchBar) {
      win.setTouchBar(touchBar);
    }
  }

  // Watch for computer powerMonitor
  // https://electronjs.org/docs/api/power-monitor
  electron.powerMonitor.on('shutdown', () => {
    getAngularToShutDown();
  });

  win.on('close', (event) => {
    if (!GLOBALS.readyToQuit) {
      event.preventDefault();
      getAngularToShutDown();
    }
  });

  // Emitted when the window is closed.
  win.on('closed', () => {
    rendererCanReceiveCatalogueOpenRequests = false;
    invalidateActiveCatalogueOpenOperation();
    catalogueOpenQueue.requeueInFlight();
    // Dereference the window object, usually you would store window
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
  });

  // Does not seem to be needed to remove all the Mac taskbar menu items
  // win.setMenu(null);
}

try {

  // OPEN FILE ON MAC FROM FILE DOUBLE CLICK
  // THIS RUNS (ONLY) on MAC !!!
  app.on('will-finish-launching', () => {
    app.on('open-file', (event, filePath: string) => {
      event.preventDefault();
      if (filePath) {
        requestCatalogueOpenFromSystem(filePath);
      }
    });
  });

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.on('ready', () => {
    registerTheatrumProtocols(path.join(__dirname, 'dist'), serve);
    createWindow();
  });

  // Quit when all windows are closed.
  app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    // if (process.platform !== 'darwin') {
    app.quit();
    // }
  });

  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
      createWindow();
    }
  });

} catch {
  // Ignore startup registration errors and continue starting the app.
}

if (GLOBALS.macVersion) {
  systemPreferences.subscribeNotification(
    'AppleInterfaceThemeChangedNotification',
    function theThemeHasChanged () {
      if (nativeTheme.shouldUseDarkColors) {
        tellElectronDarkModeChange('dark');
      } else {
        tellElectronDarkModeChange('light');
      }
    }
  );
}

/**
 * Notify front-end about OS change in Dark Mode setting
 * @param mode
 */
function tellElectronDarkModeChange(mode: string) {
  GLOBALS.angularApp.sender.send('os-dark-mode-change', mode);
}

// =================================================================================================
// Open a vha file method
// -------------------------------------------------------------------------------------------------

/**
 * Get angular to shut down immediately - saving settings and hub if needed.
 */
function getAngularToShutDown(): void {
  GLOBALS.angularApp.sender.send('please-shut-down-ASAP');
}

/**
 * Load a catalogue file and send it to the app.
 * Invalid catalogues are handled here so a failed JSON parse cannot crash Electron.
 * @param pathToVhaFile full path to the catalogue file
 */
async function openThisDamnFile(
  pathToVhaFile: string,
  intent: unknown,
  operationGeneration: number,
): Promise<void> {
  assertCurrentCatalogueOpenOperation(operationGeneration);
  let publishedDuplicatePath: string | undefined;

  if (isThumbnailRegenerationActive()) {
    await dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: 'Wait for the current folder thumbnail regeneration to finish before opening another catalogue.',
      message: 'Thumbnail regeneration is still in progress.',
      title: 'Catalogue Is Busy',
      type: 'warning',
    });
    assertCurrentCatalogueOpenOperation(operationGeneration);
    if (GLOBALS.angularApp) {
      GLOBALS.angularApp.sender.send('catalogue-open-request-finished');
    }
    return;
  }

  setThumbnailRegenerationBlocked(true);
  try {
    assertCurrentCatalogueOpenOperation(operationGeneration);
    pathToVhaFile = requireAuthorizedCataloguePath(pathToVhaFile);
    if (!isCatalogueOpenIntent(intent)) {
      throw new Error('The catalogue open mode is invalid.');
    }
    const legacyCatalogue = isLegacyCataloguePath(pathToVhaFile);
    if (legacyCatalogue && intent === 'read-write') {
      throw new Error('A legacy .vha2 catalogue must be opened read-only or duplicated as a .scaena catalogue.');
    }
    if (!legacyCatalogue && intent === 'duplicate-scaena') {
      throw new Error('Only a legacy .vha2 catalogue can be duplicated during opening.');
    }
    if (!legacyCatalogue && intent === 'read-only') {
      throw new Error('Read-only opening is reserved for legacy .vha2 catalogues.');
    }

    if (intent === 'duplicate-scaena') {
      const duplicateResult = await duplicateLegacyCatalogue(pathToVhaFile);
      assertCurrentCatalogueOpenOperation(operationGeneration);
      publishedDuplicatePath = duplicateResult.destinationPath;
      rememberCataloguePath(duplicateResult.destinationPath, 'Duplicated catalogue file');
      const openResult = await openCatalogueFile(
        duplicateResult.destinationPath,
        'read-write',
        operationGeneration,
        duplicateResult.destinationPath,
      );
      assertCurrentCatalogueOpenOperation(operationGeneration);
      if (openResult.opened) {
        GLOBALS.angularApp.sender.send(
          'legacy-catalogue-duplicated',
          path.basename(duplicateResult.destinationPath),
        );
        if (duplicateResult.loadedFromBackup) {
          notifyCatalogueLoadedFromBackup({
            openedPath: duplicateResult.destinationPath,
            primaryError: duplicateResult.primaryError,
            readOnly: false,
            sourcePath: pathToVhaFile,
          });
        }
      }
      return;
    }

    const openResult = await openCatalogueFile(pathToVhaFile, intent, operationGeneration);
    assertCurrentCatalogueOpenOperation(operationGeneration);
    if (openResult.opened && openResult.loadedFromBackup) {
      notifyCatalogueLoadedFromBackup({
        openedPath: pathToVhaFile,
        primaryError: openResult.primaryError,
        readOnly: intent === 'read-only',
        sourcePath: pathToVhaFile,
      });
    }
  } catch (error) {
    if (error instanceof CatalogueOpenSupersededError) {
      console.warn('Ignored a stale catalogue-open completion.');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: `${message}\n\n${catalogueOpenFailureSuffix(publishedDuplicatePath)}`,
      message: 'The catalogue could not be opened safely.',
      title: 'Unable to Open Catalogue',
      type: 'error',
    });
    assertCurrentCatalogueOpenOperation(operationGeneration);
    if (GLOBALS.angularApp) {
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
    }
  } finally {
    if (isCurrentCatalogueOpenOperation(operationGeneration)) {
      setThumbnailRegenerationBlocked(false);
    }
  }
}

async function openCatalogueFile(
  pathToVhaFile: string,
  accessMode: CatalogueAccessMode,
  operationGeneration: number,
  publishedDuplicatePath?: string,
): Promise<CatalogueOpenResult> {
  assertCurrentCatalogueOpenOperation(operationGeneration);
  let loadedFromBackup = false;
  let primaryError: string | undefined;
  let recoveredCatalogue = false;

  try {
    const readResult = await readVhaFileWithBackup(pathToVhaFile);
    assertCurrentCatalogueOpenOperation(operationGeneration);
    let finalObject: FinalObject;

    if (readResult.source === 'primary') {
      finalObject = readResult.finalObject;
    } else if (readResult.source === 'unreadable') {
      const readError = readResult.primaryError ? readResult.primaryError.message : 'Unknown read error';
      await dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: `${readError}\n\nCheck that the drive is connected and that the catalogue can be read. No recovery was attempted.\n\n${catalogueOpenFailureSuffix(publishedDuplicatePath)}`,
        message: 'This catalogue could not be read.',
        title: 'Unable to Read Catalogue',
        type: 'error',
      });
      assertCurrentCatalogueOpenOperation(operationGeneration);
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
      return { loadedFromBackup: false, opened: false, primaryError: readError };
    } else if (readResult.source === 'backup' && accessMode === 'read-only') {
      // A read-only session may use a valid backup in memory, but must never
      // replace, preserve, or otherwise modify either legacy source file.
      finalObject = readResult.finalObject;
      loadedFromBackup = true;
      primaryError = readResult.primaryError?.message;
    } else if (readResult.source === 'backup') {
      const recoveryChoice = await dialog.showMessageBox(win, {
      buttons: ['Recover Backup', 'Cancel'],
      cancelId: 1,
      defaultId: 0,
      detail: 'A valid backup is available. It may not contain the most recent changes. Any recoverable damaged contents will be preserved before recovery.',
      message: 'This catalogue is incomplete or invalid.',
      noLink: true,
      title: 'Recover Catalogue',
      type: 'warning',
    });
      assertCurrentCatalogueOpenOperation(operationGeneration);

      if (recoveryChoice.response !== 0) {
        GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
        return {
          loadedFromBackup: true,
          opened: false,
          primaryError: readResult.primaryError?.message,
        };
      }

      try {
        assertCurrentCatalogueOpenOperation(operationGeneration);
        const recoveryResult = await recoverVhaFileFromBackup(pathToVhaFile);
        assertCurrentCatalogueOpenOperation(operationGeneration);
        finalObject = recoveryResult.finalObject;
        loadedFromBackup = true;
        primaryError = readResult.primaryError?.message;
        recoveredCatalogue = true;

        const preservationDetail = recoveryResult.corruptPath
          ? 'The damaged catalogue was preserved at:\n' + recoveryResult.corruptPath
          : 'The backup was restored. The damaged catalogue was empty or missing, so no additional copy was created.';
        await dialog.showMessageBox(win, {
          buttons: ['OK'],
          detail: preservationDetail,
          message: 'The catalogue was recovered successfully.',
          title: 'Catalogue Recovered',
          type: 'info',
        });
        assertCurrentCatalogueOpenOperation(operationGeneration);
      } catch (error) {
        if (error instanceof CatalogueOpenSupersededError) {
          throw error;
        }
        const recoveryError = error instanceof Error ? error.message : String(error);
        await dialog.showMessageBox(win, {
          buttons: ['OK'],
          detail: recoveryError,
          message: 'The catalogue backup could not be recovered. Neither file was changed.',
          title: 'Catalogue Recovery Failed',
          type: 'error',
        });
        assertCurrentCatalogueOpenOperation(operationGeneration);
        GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
        return {
          loadedFromBackup: true,
          opened: false,
          primaryError: readResult.primaryError?.message,
        };
      }
    } else {
      const primaryError = readResult.primaryError ? readResult.primaryError.message : 'Unknown error';
      const backupError = readResult.backupError ? readResult.backupError.message : 'No valid backup was found';
      await dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: `Catalogue: ${primaryError}\nBackup: ${backupError}\n\nNo files were changed.`,
        message: 'This catalogue and its backup could not be opened.',
        title: 'Unable to Open Catalogue',
        type: 'error',
      });
      assertCurrentCatalogueOpenOperation(operationGeneration);
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
      return { loadedFromBackup: false, opened: false, primaryError };
    }

    assertCurrentCatalogueOpenOperation(operationGeneration);
    // Keep the current catalogue's source capabilities in place while the
    // prospective catalogue is being reviewed.  The new grants are staged
    // locally and are not published until this transition is ready to commit.
    upgradeToVersion3(finalObject);
    const sanitizedScreenshotSettings = sanitizeScreenshotSettings(finalObject.screenshotSettings);
    let catalogueSettingsNormalized = sanitizedScreenshotSettings.n !== finalObject.screenshotSettings.n;
    finalObject.screenshotSettings = sanitizedScreenshotSettings;
    // Keep the current catalogue fully usable while the prospective source
    // folders are being reviewed. Its watchers and queues are stopped only at
    // the atomic hand-off immediately before the new authority is published.
    const sourceAccess = await authorizePersistedSourceAccess(
      finalObject,
      pathToVhaFile,
      operationGeneration,
    );
    assertCurrentCatalogueOpenOperation(operationGeneration);
    catalogueSettingsNormalized = sourceAccess.changed || catalogueSettingsNormalized;
    let sourceWatchPaths = new Set<string>();
    if (accessMode === 'read-write') {
      sourceWatchPaths = await authorizePersistedSourceWatches(
        finalObject,
        pathToVhaFile,
        sourceAccess,
        operationGeneration,
      );
      assertCurrentCatalogueOpenOperation(operationGeneration);
    }

    // Recovery can mutate generated assets, so complete it using local target
    // values before committing any new catalogue state to GLOBALS.
    if (accessMode === 'read-write') {
      try {
        assertCurrentCatalogueOpenOperation(operationGeneration);
        const targetOutputFolder = path.parse(pathToVhaFile).dir;
        const assetDirectory = resolveTheatrumAssetDirectory(
          targetOutputFolder,
          finalObject.hubName,
        );
        if (!assetDirectory) {
          throw new Error('The catalogue preview asset directory is invalid.');
        }
        const recovery = await recoverInterruptedPreviewTransactions(
          targetOutputFolder,
          assetDirectory,
        );
        assertCurrentCatalogueOpenOperation(operationGeneration);
        if (recovery.rolledBack > 0 || recovery.committedCleaned > 0) {
          console.warn('Recovered interrupted thumbnail transactions:', recovery);
        }
      } catch (error) {
        if (error instanceof CatalogueOpenSupersededError) {
          throw error;
        }
        const recoveryError = error instanceof Error ? error.message : String(error);
        console.error('Unable to recover an interrupted thumbnail transaction:', error);
        await dialog.showMessageBox(win, {
          buttons: ['OK'],
          detail: recoveryError,
          message: 'Some interrupted thumbnail files could not be recovered automatically.',
          title: 'Thumbnail Recovery Warning',
          type: 'warning',
        });
        assertCurrentCatalogueOpenOperation(operationGeneration);
      }
    }

    // Set globals only after a catalogue has been parsed, reviewed, and all
    // asynchronous recovery work has completed for this same generation.
    assertCurrentCatalogueOpenOperation(operationGeneration);
    closeAllWatchers();
    resetAllQueues();
    GLOBALS.catalogueAccessMode = accessMode;
    GLOBALS.currentlyOpenVhaFile = pathToVhaFile;
    GLOBALS.authorizedCataloguePaths.add(pathToVhaFile);
    GLOBALS.selectedOutputFolder = path.parse(pathToVhaFile).dir;
    GLOBALS.hubName = finalObject.hubName;
    GLOBALS.screenshotSettings = finalObject.screenshotSettings;
    GLOBALS.selectedSourceFolders = finalObject.inputDirs;
    GLOBALS.authorizedSourceFolderPaths.clear();
    sourceAccess.paths.forEach((sourcePath: string) => {
      GLOBALS.authorizedSourceFolderPaths.add(sourcePath);
    });
    GLOBALS.authorizedSourceFolderRealPaths.clear();
    sourceAccess.realPaths.forEach((realPath: string, sourcePath: string) => {
      GLOBALS.authorizedSourceFolderRealPaths.set(sourcePath, realPath);
    });
    GLOBALS.authorizedSourceWatchPaths.clear();
    sourceWatchPaths.forEach((sourcePath: string) => {
      GLOBALS.authorizedSourceWatchPaths.add(sourcePath);
    });
    GLOBALS.authorizedCatalogueMediaLocations = buildCatalogueMediaLocationAuthority(
      finalObject.images,
    );
    GLOBALS.authorizedCatalogueImageHashes = catalogueMediaAuthorityHashes(
      GLOBALS.authorizedCatalogueMediaLocations,
    );

    app.addRecentDocument(pathToVhaFile);
    const suppressedWatchSourceKeys = Object.keys(finalObject.inputDirs)
      .map(Number)
      .filter((sourceKey: number): boolean => {
        const source = finalObject.inputDirs[sourceKey];
        if (!source?.watch) {
          return false;
        }
        try {
          const normalizedSourcePath = normalizeAbsolutePath(source.path, 'Source folder');
          return !GLOBALS.authorizedSourceFolderPaths.has(normalizedSourcePath)
            || !GLOBALS.authorizedSourceWatchPaths.has(normalizedSourcePath);
        } catch {
          return true;
        }
      });
    suppressedWatchSourceKeys.forEach((sourceKey: number) => {
      finalObject.inputDirs[sourceKey].watch = false;
    });
    try {
      sendFinalObjectToAngular(finalObject, GLOBALS, catalogueSettingsNormalized);
    } finally {
      // Denying a session capability must not silently rewrite the persisted
      // catalogue preference. The renderer sees the effective off state while
      // the main-owned catalogue model retains the user's saved choice.
      suppressedWatchSourceKeys.forEach((sourceKey: number) => {
        finalObject.inputDirs[sourceKey].watch = true;
      });
    }
    assertCurrentCatalogueOpenOperation(operationGeneration);
    setUpDirectoryWatchers(
      finalObject.inputDirs,
      finalObject.images,
      false,
      accessMode === 'read-write',
    );
    return { loadedFromBackup, opened: true, primaryError };
  } catch (error) {
    if (error instanceof CatalogueOpenSupersededError) {
      console.warn('Discarded stale catalogue initialization work.');
      return { loadedFromBackup, opened: false, primaryError };
    }
    const unexpectedError = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: `${unexpectedError}\n\n${catalogueOpenFailureSuffix(publishedDuplicatePath, recoveredCatalogue)}`,
      message: 'The catalogue could not be initialized safely.',
      title: 'Unable to Open Catalogue',
      type: 'error',
    });
    assertCurrentCatalogueOpenOperation(operationGeneration);
    if (GLOBALS.angularApp) {
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
    }
    return { loadedFromBackup, opened: false, primaryError };
  }
}

// =================================================================================================
// Listeners for events from Angular
// -------------------------------------------------------------------------------------------------

setUpIpcMessages(ipcMain, win, pathToAppData, systemMessages, isTrustedRenderer);

trustedIpcOn('register-user-file-path', (_event, filePath: unknown): void => {
  rememberUserSelectedFilePath(filePath);
});

trustedIpcOn('app-to-touchBar', (_event, changesFromApp: unknown): void => {
  updateTouchBarFromApp(changesFromApp);
});


/**
 * Once Angular loads it sends over the `ready` status
 * Load up the settings.json and send settings over to Angular
 */
trustedIpcOn('just-started', (event) => {
  GLOBALS.angularApp = event;
  GLOBALS.winRef = win;

  if (GLOBALS.macVersion) {
    tellElectronDarkModeChange(systemPreferences.getEffectiveAppearance());
  }

  // Reference: https://github.com/electron/electron/blob/master/docs/api/locales.md
  const locale: string = app.getLocale();

  fs.readFile(path.join(GLOBALS.settingsPath, 'settings.json'), (err, data) => {
    if (err) {
      win.setBounds({ x: 0, y: 0, width: screenWidth, height: screenHeight });
      event.sender.send('set-language-based-off-system-locale', locale);
      if (catalogueOpenQueue.waitingCount === 0) {
        event.sender.send('please-open-wizard', true); // firstRun = true!
      }
    } else {

      try {
        const previouslySavedSettings: SettingsObject = JSON.parse(data);
        const savedCurrentCatalogue = previouslySavedSettings.appState?.currentVhaFile;
        if (savedCurrentCatalogue) {
          try {
            previouslySavedSettings.appState.currentVhaFile = requireAuthorizedCataloguePath(
              savedCurrentCatalogue,
            );
          } catch {
            previouslySavedSettings.appState.currentVhaFile = '';
          }
        }
        previouslySavedSettings.vhaFileHistory = Array.isArray(previouslySavedSettings.vhaFileHistory)
          ? previouslySavedSettings.vhaFileHistory.filter((historyItem: any): boolean => {
            try {
              historyItem.vhaFilePath = requireAuthorizedCataloguePath(historyItem.vhaFilePath);
              return true;
            } catch {
              return false;
            }
          })
          : [];
        if (previouslySavedSettings.appState.addtionalExtensions) {
          GLOBALS.additionalExtensions = parseAdditionalExtensions(previouslySavedSettings.appState.addtionalExtensions);
        }
        try {
          const savedPlayer = previouslySavedSettings.appState.preferredVideoPlayer
            ? normalizeAbsolutePath(previouslySavedSettings.appState.preferredVideoPlayer, 'Video player')
            : '';
          const canonicalSavedPlayer = savedPlayer ? fs.realpathSync.native(savedPlayer) : '';
          GLOBALS.preferredVideoPlayer = canonicalSavedPlayer
            && loadAuthorizedPlayerPaths(GLOBALS.settingsPath).includes(canonicalSavedPlayer)
            ? canonicalSavedPlayer
            : '';
          // Free-form player arguments can activate player-specific script or
          // output features. They remain disabled until a main-owned consent
          // workflow is available.
          GLOBALS.preferredVideoPlayerArguments = '';
          previouslySavedSettings.appState.preferredVideoPlayer = GLOBALS.preferredVideoPlayer;
          previouslySavedSettings.appState.videoPlayerArgs = '';
        } catch {
          // A stale settings entry must never grant the renderer authority to
          // choose an executable. The user can select a replacement natively.
          GLOBALS.preferredVideoPlayer = '';
          GLOBALS.preferredVideoPlayerArguments = '';
          previouslySavedSettings.appState.preferredVideoPlayer = '';
          previouslySavedSettings.appState.videoPlayerArgs = '';
        }
        event.sender.send(
          'settings-returning',
          previouslySavedSettings,
          locale,
          null,
        );

      } catch (err) {
        event.sender.send('set-language-based-off-system-locale', locale);
        if (catalogueOpenQueue.waitingCount === 0) {
          event.sender.send('please-open-wizard', false);
        }
      }
    }
    // `just-started` is emitted only after the renderer has installed its IPC
    // listeners. Dispatch directly here even when settings are absent or
    // corrupt; waiting for settings-driven startup completion would deadlock.
    rendererCanReceiveCatalogueOpenRequests = true;
    dispatchNextCatalogueOpenRequest();
  });
});

trustedIpcOn('catalogue-open-request-consumed', (event) => {
  const trustedSender = GLOBALS.angularApp && GLOBALS.angularApp.sender;
  if (!trustedSender || event.sender.id !== trustedSender.id) {
    console.warn('Ignored catalogue-open acknowledgement from an untrusted renderer.');
    return;
  }
  catalogueOpenQueue.acknowledge();
  dispatchNextCatalogueOpenRequest();
});

trustedIpcOn('renderer-startup-complete', () => {
  if (rendererStartupComplete) {
    return;
  }
  rendererStartupComplete = true;
  if (packagedSmokeTest) {
    console.log('THEATRUM_PACKAGED_SMOKE_READY');
    GLOBALS.readyToQuit = true;
    setImmediate(() => app.quit());
    return;
  }
  rendererCanReceiveCatalogueOpenRequests = true;
  dispatchNextCatalogueOpenRequest();
});

/**
 * Start extracting the screenshots into a chosen output folder from a chosen input folder
 */
trustedIpcOn('start-the-import', (event, wizard: WizardOptions) => {

  if (
    catalogueOpenOperationActive
    || GLOBALS.catalogueTransitionActive
    || GLOBALS.cataloguePersistenceActive
  ) {
    console.warn('Ignored new catalogue request while another catalogue transition is active.');
    return;
  }

  if (isThumbnailRegenerationActive()) {
    dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: 'Wait for the current folder thumbnail regeneration to finish before creating another catalogue.',
      message: 'Thumbnail regeneration is still in progress.',
      title: 'Catalogue Is Busy',
      type: 'warning',
    });
    return;
  }

  const operationGeneration = beginCatalogueOpenOperation();
  if (operationGeneration === undefined) {
    return;
  }

  let hubName: string;
  let outDir: string;
  let sourceRoot: string;
  try {
    if (!wizard || !isSafeCatalogueHubName(wizard.futureHubName)) {
      throw new Error('The catalogue name is invalid. Choose a name without folder separators.');
    }
    hubName = wizard.futureHubName;
    outDir = requirePendingDirectorySelection(
      wizard.selectedOutputFolder,
      GLOBALS.pendingOutputDirectorySelections,
      'Output folder',
    );
    sourceRoot = requirePendingDirectorySelection(
      wizard.selectedSourceFolder?.[0]?.path,
      GLOBALS.pendingInputDirectorySelections,
      'Source folder',
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail,
      message: 'The new catalogue locations need to be chosen again.',
      title: 'Catalogue Creation Failed',
      type: 'warning',
    });
    finishCatalogueOpenOperation(operationGeneration);
    return;
  }

  const hubAssetsDirectory = path.join(outDir, 'vha-' + hubName);
  let hubNameAlreadyExists: boolean;
  try {
    hubNameAlreadyExists = hasCatalogueOrAssetNameCollision(
      hubName,
      fs.readdirSync(outDir),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail,
      message: 'The selected output folder could not be checked.',
      title: 'Catalogue Creation Failed',
      type: 'error',
    });
    finishCatalogueOpenOperation(operationGeneration);
    return;
  }

  if (hubNameAlreadyExists) {
    event.sender.send('show-msg-dialog', systemMessages.error, systemMessages.hubAlreadyExists, systemMessages.pleaseChangeName);
    event.sender.send('please-fix-hub-name');
    finishCatalogueOpenOperation(operationGeneration);
  } else {

    try {
      console.log('Catalogue asset folder did not exist, creating');
      fs.mkdirSync(hubAssetsDirectory);
      fs.mkdirSync(path.join(hubAssetsDirectory, 'filmstrips'));
      fs.mkdirSync(path.join(hubAssetsDirectory, 'thumbnails'));
      fs.mkdirSync(path.join(hubAssetsDirectory, 'clips'));
    } catch (error) {
      removeEmptyCatalogueAssetFolders(hubAssetsDirectory);
      const directoryError = error instanceof Error ? error.message : String(error);
      void dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: directoryError,
        message: 'The catalogue asset folders could not be created.',
        title: 'Catalogue Creation Failed',
        type: 'error',
      });
      finishCatalogueOpenOperation(operationGeneration);
      return;
    }

    let sourceCanonicalPath: string;
    try {
      sourceCanonicalPath = fs.realpathSync.native(sourceRoot);
    } catch (error) {
      removeEmptyCatalogueAssetFolders(hubAssetsDirectory);
      const sourceError = error instanceof Error ? error.message : String(error);
      void dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: sourceError,
        message: 'The selected source folder is no longer available.',
        title: 'Catalogue Creation Failed',
        type: 'error',
      });
      finishCatalogueOpenOperation(operationGeneration);
      return;
    }

    const finalObject: FinalObject = {
      addTags: [],
      hubName,
      images: [],
      inputDirs: { 0: { path: sourceRoot, watch: false } },
      numOfFolders: 0,
      removeTags: [],
      screenshotSettings: sanitizeScreenshotSettings({
        clipHeight: wizard.clipHeight,
        clipSnippetLength: wizard.clipSnippetLength,
        clipSnippets: wizard.extractClips ? wizard.clipSnippets : 0,
        fixed: wizard.isFixedNumberOfScreenshots,
        height: wizard.screenshotSizeForImport,
        n: wizard.isFixedNumberOfScreenshots ? wizard.ssConstant : wizard.ssVariable,
      }),
      version: GLOBALS.vhaFileVersion,
    };

    writeVhaFileAndStartExtraction(operationGeneration, {
      assetDirectory: hubAssetsDirectory,
      finalObject,
      outputDirectory: outDir,
      sourceCanonicalPath,
      sourceRoot,
    });
  }

});

/**
 * Creates a FinalObject with known data (no ImageElement[])
 * Writes to disk, sends to Angular, starts watching directories
 */
function writeVhaFileAndStartExtraction(
  operationGeneration: number,
  creation: NewCatalogueCreation,
): void {
  assertCurrentCatalogueOpenOperation(operationGeneration);
  const { finalObject } = creation;
  const pathToTheFile = path.join(
    creation.outputDirectory,
    catalogueFileName(finalObject.hubName),
  );

  writeVhaFileToDisk(finalObject, pathToTheFile, (error: Error) => {
    if (!isCurrentCatalogueOpenOperation(operationGeneration)) {
      return;
    }

    if (error) {
      removeEmptyCatalogueAssetFolders(creation.assetDirectory);
      dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: error.message,
        message: 'The new catalogue could not be saved.',
        title: 'Catalogue Save Failed',
        type: 'error',
      });
      finishCatalogueOpenOperation(operationGeneration);
      return;
    }

    try {
      assertCurrentCatalogueOpenOperation(operationGeneration);
      rememberCataloguePath(pathToTheFile, 'New catalogue file');
      rememberSourceAccessDecision(
        GLOBALS.settingsPath,
        fs.realpathSync.native(pathToTheFile),
        creation.sourceCanonicalPath,
        true,
      );
      assertCurrentCatalogueOpenOperation(operationGeneration);

      // The prospective catalogue remains local until its first durable write
      // and capability records succeed. Only then stop the old session and
      // publish the complete new authority snapshot in one synchronous hand-off.
      closeAllWatchers();
      resetAllQueues();
      GLOBALS.pendingInputDirectorySelections.delete(creation.sourceRoot);
      GLOBALS.pendingOutputDirectorySelections.delete(creation.outputDirectory);
      GLOBALS.currentlyOpenVhaFile = pathToTheFile;
      GLOBALS.hubName = finalObject.hubName;
      GLOBALS.selectedOutputFolder = creation.outputDirectory;
      GLOBALS.selectedSourceFolders = finalObject.inputDirs;
      GLOBALS.screenshotSettings = finalObject.screenshotSettings;
      GLOBALS.authorizedCatalogueImageHashes = new Set();
      GLOBALS.authorizedCatalogueMediaLocations = new Set();
      GLOBALS.authorizedSourceFolderPaths = new Set([creation.sourceRoot]);
      GLOBALS.authorizedSourceFolderRealPaths = new Map([
        [creation.sourceRoot, creation.sourceCanonicalPath],
      ]);
      GLOBALS.authorizedSourceWatchPaths = new Set();
      GLOBALS.catalogueAccessMode = 'read-write';

      sendFinalObjectToAngular(finalObject, GLOBALS);
      assertCurrentCatalogueOpenOperation(operationGeneration);
      setUpDirectoryWatchers(finalObject.inputDirs, [], true);
    } catch (creationError) {
      const detail = creationError instanceof Error ? creationError.message : String(creationError);
      void dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail,
        message: 'The new catalogue was created, but could not be initialized safely.',
        title: 'Catalogue Initialization Failed',
        type: 'error',
      });
    } finally {
      finishCatalogueOpenOperation(operationGeneration);
    }
  });
}

/**
 * Summon system modal to choose a catalogue JSON file
 * open via `openThisDamnFile` method
 */
trustedIpcOn('system-open-file-through-modal', (event, somethingElse) => {  // TODO -- check -- do I need to save vha to disk?
  dialog.showOpenDialog(win, {
    title: systemMessages.selectPreviousHub,
    ...(GLOBALS.macVersion ? {} : {
      filters: [{
        name: 'Theatrum Ex Machina catalogue files', // TODO -- i18n FIX ME
        extensions: [...CATALOGUE_PICKER_EXTENSIONS]
      }],
    }),
    properties: ['openFile']
  }).then(result => {
    const chosenFile: string = result.filePaths[0];

    if (chosenFile && isCataloguePickerFilePath(chosenFile)) {
      try {
        const authorizedPath = rememberCataloguePath(chosenFile, 'Catalogue file');
        event.sender.send('open-catalogue-from-system', authorizedPath);
      } catch (error) {
        console.warn('Unable to authorize the selected catalogue:', error);
      }
    } else if (chosenFile) {
      void dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: 'Choose a .scaena, .vha2, or .json catalogue file.',
        message: 'The selected file is not a supported catalogue.',
        title: 'Unsupported Catalogue File',
        type: 'warning',
      });
    }
  }).catch(err => {});
});

/**
 * Open a catalogue file from the given path.
 * Save the current catalogue to disk first, if provided.
 */
trustedIpcOn('load-this-vha-file', (
  event,
  pathToVhaFile: string,
  finalObjectToSave: FinalObject,
  intent: unknown = 'read-write',
) => {
  // The renderer already queues normal requests, but it is not an authority
  // boundary. Do not let a compromised or stale renderer start a second
  // catalogue transition while the first is awaiting a dialog or disk I/O.
  if (
    catalogueOpenOperationActive
    || GLOBALS.catalogueTransitionActive
    || GLOBALS.cataloguePersistenceActive
  ) {
    console.warn('Ignored concurrent renderer catalogue-open request.');
    if (!event.sender.isDestroyed()) {
      event.sender.send('catalogue-open-request-finished');
    }
    return;
  }
  try {
    pathToVhaFile = requireAuthorizedCataloguePath(pathToVhaFile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail,
      message: 'This catalogue was not selected through a trusted app workflow.',
      title: 'Catalogue Open Blocked',
      type: 'warning',
    });
    if (GLOBALS.currentlyOpenVhaFile) {
      event.sender.send('catalogue-open-request-finished');
    } else {
      event.sender.send('please-open-wizard', false, pathToVhaFile);
    }
    return;
  }
  const operationGeneration = beginCatalogueOpenOperation();
  if (operationGeneration === undefined) {
    return;
  }
  const openRequestedCatalogue = (): void => {
    void openThisDamnFile(pathToVhaFile, intent, operationGeneration).finally(() => {
      finishCatalogueOpenOperation(operationGeneration);
    });
  };

  if (isThumbnailRegenerationActive()) {
    openRequestedCatalogue();
    return;
  }

  if (finalObjectToSave !== null && GLOBALS.catalogueAccessMode === 'read-write') {
    let authorizedFinalObject: FinalObject;
    let nextMediaAuthority: Set<string>;
    let nextImageHashes: Set<string>;
    try {
      authorizedFinalObject = prepareAuthorizedCatalogueWrite(
        finalObjectToSave,
        GLOBALS.selectedSourceFolders,
        GLOBALS.hubName,
      );
      nextMediaAuthority = reconcileRendererCatalogueMediaAuthority(
        authorizedFinalObject.images,
      );
      nextImageHashes = new Set<string>();
      nextMediaAuthority.forEach((key: string) => {
        const separatorIndex = key.indexOf('\0');
        if (separatorIndex > 0) {
          nextImageHashes.add(key.slice(0, separatorIndex));
        }
      });
    } catch (error) {
      const catalogueError = error instanceof Error ? error : new Error(String(error));
      void dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: catalogueError.message,
        message: 'The current catalogue could not be validated, so the other hub was not opened.',
        title: 'Catalogue Save Failed',
        type: 'error',
      });
      event.sender.send('current-vha-file-save-failed', catalogueError.message);
      finishCatalogueOpenOperation(operationGeneration);
      return;
    }

    writeVhaFileToDisk(authorizedFinalObject, GLOBALS.currentlyOpenVhaFile, (error: Error) => {
      if (!isCurrentCatalogueOpenOperation(operationGeneration)) {
        return;
      }
      if (error) {
        dialog.showMessageBox(win, {
          buttons: ['OK'],
          detail: error.message,
          message: 'The current catalogue could not be saved, so the other hub was not opened.',
          title: 'Catalogue Save Failed',
          type: 'error',
        });
        event.sender.send('current-vha-file-save-failed', error.message);
        finishCatalogueOpenOperation(operationGeneration);
        return;
      }
      assertCurrentCatalogueOpenOperation(operationGeneration);
      reconcileSourceFoldersBeforeCatalogueSwitch(authorizedFinalObject.inputDirs);
      GLOBALS.authorizedCatalogueImageHashes = nextImageHashes;
      GLOBALS.authorizedCatalogueMediaLocations = nextMediaAuthority;
      console.log('Catalogue saved before opening another');
      openRequestedCatalogue();
    });

  } else {
    openRequestedCatalogue();
  }
});

// =================================================================================================

/**
 * Interrupt current import process
 */
trustedIpcOn('cancel-current-import', (event): void => {
  GLOBALS.winRef.setProgressBar(-1);
  resetAllQueues();
});

/**
 * Update additonal extensions from settings
 */
trustedIpcOn('update-additional-extensions', (event, newAdditionalExtensions: string): void => {
  if (typeof newAdditionalExtensions !== 'string' || newAdditionalExtensions.length > 4096) {
    console.warn('Ignored invalid additional media extensions.');
    return;
  }
  GLOBALS.additionalExtensions = parseAdditionalExtensions(newAdditionalExtensions)
    .filter((extension: string) => /^[a-zA-Z0-9]{1,16}$/.test(extension));
});

/**
 * Update system messaging based on new language
 */
trustedIpcOn('system-messages-updated', (event, newSystemMessages): void => {
  try {
    const serializedMessages = JSON.stringify(newSystemMessages);
    if (
      !newSystemMessages
      || typeof newSystemMessages !== 'object'
      || Array.isArray(newSystemMessages)
      || serializedMessages.length > 128 * 1024
    ) {
      throw new Error('The localized system messages are invalid.');
    }
    systemMessages = JSON.parse(serializedMessages);
  } catch (error) {
    console.warn('Ignored invalid localized system messages:', error);
  }
});

/**
 * Opens a catalogue file while the app is running. Only works for macOS.
 */
trustedIpcOn('open-file', (event, pathToVhaFile) => {
  event.preventDefault();
  requestCatalogueOpenFromSystem(pathToVhaFile);
});

/**
 * Clears recent document history from the jump list
 */
trustedIpcOn('clear-recent-documents', (event): void => {
  app.clearRecentDocuments();
});

/** Clipboard access is mediated here because sandboxed preloads do not expose it directly. */
trustedIpcOn('write-clipboard-text', (_event, text: unknown): void => {
  if (typeof text !== 'string' || text.length > 1024 * 1024) {
    console.warn('Ignored invalid clipboard text.');
    return;
  }
  clipboard.writeText(text);
});
