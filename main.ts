// Update the `demo` and `version` when building
import { GLOBALS } from './node/main-globals';

GLOBALS.macVersion = process.platform === 'darwin';

import * as path from 'path';

const fs = require('fs');
const electron = require('electron');
const { nativeTheme } = require('electron');
import { app, BrowserWindow, screen, dialog, systemPreferences, ipcMain } from 'electron';
const windowStateKeeper = require('electron-window-state');

// Methods
import { createTouchBar } from './node/main-touch-bar';
import { setUpIpcForServer } from './node/server';
import { setUpIpcMessages } from './node/main-ipc';
import { sendFinalObjectToAngular, setUpDirectoryWatchers, upgradeToVersion3, writeVhaFileToDisk, parseAdditionalExtensions } from './node/main-support';
import { readVhaFileWithBackup, recoverVhaFileFromBackup } from './node/vha-file-persistence';

// Interfaces
import { FinalObject } from './interfaces/final-object.interface';
import { SettingsObject } from './interfaces/settings-object.interface';
import { WizardOptions } from './interfaces/wizard-options.interface';
import {
  isThumbnailRegenerationActive,
  preventSleep,
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
} from './interfaces/catalogue-file';

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

const English = require('./i18n/en.json');
let systemMessages = English.SYSTEM; // Set English as default; update via `system-messages-updated`

let screenWidth;
let screenHeight;

let userWantedToOpen: string = null; // find a better pattern for handling this functionality
let rendererStartupComplete = false;

function requestCatalogueOpenFromSystem(filePath: string): void {
  if (!filePath) {
    return;
  }
  if (rendererStartupComplete && GLOBALS.angularApp) {
    GLOBALS.angularApp.sender.send('open-catalogue-from-system', filePath);
  } else {
    userWantedToOpen = filePath;
  }
}

function takeQueuedCataloguePath(): string | null {
  const queuedPath = userWantedToOpen;
  userWantedToOpen = null;
  return queuedPath;
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
const serve: boolean = args.some(val => val === '--serve');

GLOBALS.debug = args.some(val => val === '--debug');
if (GLOBALS.debug) {
  console.log('Debug mode enabled!');
}

// =================================================================================================

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// For windows -- when loading the app the first time
if (args[0]) {
  if (!serve) {
    userWantedToOpen = args[0]; // TODO -- clean up file-opening code to not use variable
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
      nodeIntegration: true,
      allowRunningInsecureContent: true,
      contextIsolation: false,
      webSecurity: false  // allow files from hard disk to show up
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
    const url = require('url').format({
      pathname: path.join(__dirname, 'dist/index.html'),
      protocol: 'file:',
      slashes: true
    });

    win.loadURL(url);
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
  app.on('ready', createWindow);

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
async function openThisDamnFile(pathToVhaFile: string): Promise<void> {

  if (isThumbnailRegenerationActive()) {
    await dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: 'Wait for the current folder thumbnail regeneration to finish before opening another catalogue.',
      message: 'Thumbnail regeneration is still in progress.',
      title: 'Catalogue Is Busy',
      type: 'warning',
    });
    return;
  }

  setThumbnailRegenerationBlocked(true);
  try {
    await openCatalogueFile(pathToVhaFile);
  } finally {
    setThumbnailRegenerationBlocked(false);
  }
}

async function openCatalogueFile(pathToVhaFile: string): Promise<void> {

  resetAllQueues();

  try {
    const readResult = await readVhaFileWithBackup(pathToVhaFile);
    let finalObject: FinalObject;

    if (readResult.source === 'primary') {
      finalObject = readResult.finalObject;
    } else if (readResult.source === 'unreadable') {
      const readError = readResult.primaryError ? readResult.primaryError.message : 'Unknown read error';
      await dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: `${readError}\n\nCheck that the drive is connected and that the catalogue can be read. No recovery was attempted and no files were changed.`,
        message: 'This catalogue could not be read.',
        title: 'Unable to Read Catalogue',
        type: 'error',
      });
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
      return;
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

    if (recoveryChoice.response !== 0) {
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
      return;
    }

    try {
      const recoveryResult = await recoverVhaFileFromBackup(pathToVhaFile);
      finalObject = recoveryResult.finalObject;

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
    } catch (error) {
      const recoveryError = error instanceof Error ? error.message : String(error);
      await dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: recoveryError,
        message: 'The catalogue backup could not be recovered. Neither file was changed.',
        title: 'Catalogue Recovery Failed',
        type: 'error',
      });
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
      return;
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
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
      return;
    }

    // set globals only after a catalogue has been parsed and validated successfully
    upgradeToVersion3(finalObject);
    const sanitizedScreenshotSettings = sanitizeScreenshotSettings(finalObject.screenshotSettings);
    const catalogueSettingsNormalized = sanitizedScreenshotSettings.n !== finalObject.screenshotSettings.n;
    finalObject.screenshotSettings = sanitizedScreenshotSettings;
    GLOBALS.currentlyOpenVhaFile = pathToVhaFile;
    GLOBALS.selectedOutputFolder = path.parse(pathToVhaFile).dir;
    GLOBALS.hubName = finalObject.hubName;
    GLOBALS.screenshotSettings = finalObject.screenshotSettings;
    GLOBALS.selectedSourceFolders = finalObject.inputDirs;

    try {
      const recovery = await recoverInterruptedPreviewTransactions(
        path.join(GLOBALS.selectedOutputFolder, 'vha-' + GLOBALS.hubName),
      );
      if (recovery.rolledBack > 0 || recovery.committedCleaned > 0) {
        console.warn('Recovered interrupted thumbnail transactions:', recovery);
      }
    } catch (error) {
      const recoveryError = error instanceof Error ? error.message : String(error);
      console.error('Unable to recover an interrupted thumbnail transaction:', error);
      await dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: recoveryError,
        message: 'Some interrupted thumbnail files could not be recovered automatically.',
        title: 'Thumbnail Recovery Warning',
        type: 'warning',
      });
    }

    app.addRecentDocument(pathToVhaFile);
    sendFinalObjectToAngular(finalObject, GLOBALS, catalogueSettingsNormalized);
    setUpDirectoryWatchers(finalObject.inputDirs, finalObject.images, false);
  } catch (error) {
    const unexpectedError = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: `${unexpectedError}\n\nNo catalogue files were changed.`,
      message: 'The catalogue could not be initialized safely.',
      title: 'Unable to Open Catalogue',
      type: 'error',
    });
    if (GLOBALS.angularApp) {
      GLOBALS.angularApp.sender.send('please-open-wizard', false, pathToVhaFile);
    }
  }
}

// =================================================================================================
// Listeners for events from Angular
// -------------------------------------------------------------------------------------------------

setUpIpcMessages(ipcMain, win, pathToAppData, systemMessages);

setUpIpcForServer(ipcMain);

/**
 * Once Angular loads it sends over the `ready` status
 * Load up the settings.json and send settings over to Angular
 */
ipcMain.on('just-started', (event) => {
  GLOBALS.angularApp = event;
  GLOBALS.winRef = win;

  if (GLOBALS.macVersion) {
    tellElectronDarkModeChange(systemPreferences.getEffectiveAppearance());
  }

  // Reference: https://github.com/electron/electron/blob/master/docs/api/locales.md
  const locale: string = app.getLocale();

  fs.readFile(path.join(GLOBALS.settingsPath, 'settings.json'), (err, data) => {
    const requestedCataloguePath = takeQueuedCataloguePath();
    if (err) {
      win.setBounds({ x: 0, y: 0, width: screenWidth, height: screenHeight });
      event.sender.send('set-language-based-off-system-locale', locale);
      if (requestedCataloguePath) {
        void openThisDamnFile(requestedCataloguePath);
      } else {
        event.sender.send('please-open-wizard', true); // firstRun = true!
      }
    } else {

      try {
        const previouslySavedSettings: SettingsObject = JSON.parse(data);
        if (previouslySavedSettings.appState.addtionalExtensions) {
          GLOBALS.additionalExtensions = parseAdditionalExtensions(previouslySavedSettings.appState.addtionalExtensions);
        }
        event.sender.send(
          'settings-returning',
          previouslySavedSettings,
          locale,
          requestedCataloguePath,
        );

      } catch (err) {
        if (requestedCataloguePath) {
          void openThisDamnFile(requestedCataloguePath);
        } else {
          event.sender.send('please-open-wizard', false);
        }
      }
    }
  });
});

ipcMain.on('renderer-startup-complete', () => {
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
  const queuedCataloguePath = takeQueuedCataloguePath();
  if (queuedCataloguePath && GLOBALS.angularApp) {
    GLOBALS.angularApp.sender.send('open-catalogue-from-system', queuedCataloguePath);
  }
});

/**
 * Start extracting the screenshots into a chosen output folder from a chosen input folder
 */
ipcMain.on('start-the-import', (event, wizard: WizardOptions) => {

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

  preventSleep();

  const hubName = wizard.futureHubName;
  const outDir: string = wizard.selectedOutputFolder;
  const hubAssetsDirectory = path.join(outDir, 'vha-' + hubName);
  const hubNameAlreadyExists = hasCatalogueOrAssetNameCollision(
    hubName,
    fs.readdirSync(outDir),
  );

  if (hubNameAlreadyExists) {
    event.sender.send('show-msg-dialog', systemMessages.error, systemMessages.hubAlreadyExists, systemMessages.pleaseChangeName);
    event.sender.send('please-fix-hub-name');
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
      return;
    }

    GLOBALS.hubName = hubName;
    GLOBALS.selectedOutputFolder = outDir;
    GLOBALS.selectedSourceFolders = wizard.selectedSourceFolder;
    GLOBALS.screenshotSettings = sanitizeScreenshotSettings({
      clipHeight: wizard.clipHeight,
      clipSnippetLength: wizard.clipSnippetLength,
      clipSnippets: wizard.extractClips ? wizard.clipSnippets : 0,
      fixed: wizard.isFixedNumberOfScreenshots,
      height: wizard.screenshotSizeForImport,
      n: wizard.isFixedNumberOfScreenshots ? wizard.ssConstant : wizard.ssVariable,
    });

    writeVhaFileAndStartExtraction();
  }

});

/**
 * Creates a FinalObject with known data (no ImageElement[])
 * Writes to disk, sends to Angular, starts watching directories
 */
function writeVhaFileAndStartExtraction(): void {

  const finalObject: FinalObject = {
    addTags: [],
    hubName: GLOBALS.hubName,
    images: [],
    inputDirs: GLOBALS.selectedSourceFolders,
    numOfFolders: 0,
    removeTags: [],
    screenshotSettings: GLOBALS.screenshotSettings,
    version: GLOBALS.vhaFileVersion,
  };

  const pathToTheFile = path.join(
    GLOBALS.selectedOutputFolder,
    catalogueFileName(GLOBALS.hubName),
  );

  writeVhaFileToDisk(finalObject, pathToTheFile, (error: Error) => {

    if (error) {
      removeEmptyCatalogueAssetFolders(
        path.join(GLOBALS.selectedOutputFolder, 'vha-' + GLOBALS.hubName),
      );
      dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: error.message,
        message: 'The new catalogue could not be saved.',
        title: 'Catalogue Save Failed',
        type: 'error',
      });
      return;
    }

    GLOBALS.currentlyOpenVhaFile = pathToTheFile;

    sendFinalObjectToAngular(finalObject, GLOBALS);

    setUpDirectoryWatchers(finalObject.inputDirs, [], true);
  });
}

/**
 * Summon system modal to choose a catalogue JSON file
 * open via `openThisDamnFile` method
 */
ipcMain.on('system-open-file-through-modal', (event, somethingElse) => {  // TODO -- check -- do I need to save vha to disk?
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
      openThisDamnFile(chosenFile);
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
ipcMain.on('load-this-vha-file', (event, pathToVhaFile: string, finalObjectToSave: FinalObject) => {

  if (isThumbnailRegenerationActive()) {
    void openThisDamnFile(pathToVhaFile);
    return;
  }

  if (finalObjectToSave !== null) {

    writeVhaFileToDisk(finalObjectToSave, GLOBALS.currentlyOpenVhaFile, (error: Error) => {
      if (error) {
        dialog.showMessageBox(win, {
          buttons: ['OK'],
          detail: error.message,
          message: 'The current catalogue could not be saved, so the other hub was not opened.',
          title: 'Catalogue Save Failed',
          type: 'error',
        });
        event.sender.send('current-vha-file-save-failed', error.message);
        return;
      }
      console.log('Catalogue saved before opening another');
      openThisDamnFile(pathToVhaFile);
    });

  } else {
    openThisDamnFile(pathToVhaFile);
  }
});

// =================================================================================================

/**
 * Interrupt current import process
 */
ipcMain.on('cancel-current-import', (event): void => {
  GLOBALS.winRef.setProgressBar(-1);
  resetAllQueues();
});

/**
 * Update additonal extensions from settings
 */
ipcMain.on('update-additional-extensions', (event, newAdditionalExtensions: string): void => {
  GLOBALS.additionalExtensions = parseAdditionalExtensions(newAdditionalExtensions);
});

/**
 * Update system messaging based on new language
 */
ipcMain.on('system-messages-updated', (event, newSystemMessages): void => {
  systemMessages = newSystemMessages;               // TODO -- make sure it works with `main-ipc.ts`
});

/**
 * Opens a catalogue file while the app is running. Only works for macOS.
 */
ipcMain.on('open-file', (event, pathToVhaFile) => {
  event.preventDefault();
  openThisDamnFile(pathToVhaFile);
});

/**
 * Clears recent document history from the jump list
 */
ipcMain.on('clear-recent-documents', (event): void => {
  app.clearRecentDocuments();
});
