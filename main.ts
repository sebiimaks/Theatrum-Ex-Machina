// Update the `demo` and `version` when building
import { GLOBALS } from './node/main-globals';

GLOBALS.macVersion = process.platform === 'darwin';

import * as path from 'path';

const fs = require('fs');
const electron = require('electron');
const { nativeTheme } = require('electron');
import { app, protocol, BrowserWindow, screen, dialog, systemPreferences, ipcMain } from 'electron';
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

// Variables
const pathToAppData = app.getPath('appData');
const pathToPortableApp = process.env.PORTABLE_EXECUTABLE_DIR;
GLOBALS.settingsPath = pathToPortableApp ? pathToPortableApp : path.join(pathToAppData, 'video-hub-app-2');

const English = require('./i18n/en.json');
let systemMessages = English.SYSTEM; // Set English as default; update via `system-messages-updated`

let screenWidth;
let screenHeight;

// TODO: CLEAN UP
let macFirstRun = true; // detect if it's the 1st time Mac is opening the file or something like that
let userWantedToOpen: string = null; // find a better pattern for handling this functionality

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

const gotTheLock = app.requestSingleInstanceLock(); // Open file on windows from file double click

if (!gotTheLock) {
  app.quit();
} else {

  app.on('second-instance', (event, argv: string[], workingDirectory: string) => {

    // dialog.showMessageBox(win, {
    //   message: 'second-instance: \n' + argv[0] + ' \n' + argv[1],
    //   buttons: ['OK']
    // });

    if (argv.length > 1) {
      openThisDamnFile(argv[argv.length - 1]);
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
    icon: path.join(__dirname, 'src/assets/icons/png/64x64.png'),
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
      if (filePath) {
        if (!macFirstRun) {
          openThisDamnFile(filePath);
        }
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


  // TODO: `registerFileProtocol` may be deprecated:
  // https://www.electronjs.org/blog/electron-33-0#behavior-changed-custom-protocol-url-handling-on-windows

  app.whenReady().then(() => {
    protocol.registerFileProtocol('file', (request, callback) => {
      const pathname = request.url.replace('file:///', '');
      callback(pathname);
    });
  });

} catch {
  // Ignore file protocol registration errors and continue starting the app.
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
 * Load the .vha2 file and send it to app.
 * Invalid catalogues are handled here so a failed JSON parse cannot crash Electron.
 * @param pathToVhaFile full path to the .vha2 file
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

  macFirstRun = false;     // TODO - figure out how to open file when double click first time on Mac

  if (userWantedToOpen) {                                          // TODO - clean up messy override
    pathToVhaFile = userWantedToOpen;
    userWantedToOpen = undefined;
  }

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
        message: 'This Video Hub catalogue could not be read.',
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
      message: 'This Video Hub catalogue is incomplete or invalid.',
      noLink: true,
      title: 'Recover Video Hub Catalogue',
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
        message: 'The Video Hub catalogue was recovered successfully.',
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
        message: 'This Video Hub catalogue and its backup could not be opened.',
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
    setUpDirectoryWatchers(finalObject.inputDirs, finalObject.images);
  } catch (error) {
    const unexpectedError = error instanceof Error ? error.message : String(error);
    await dialog.showMessageBox(win, {
      buttons: ['OK'],
      detail: `${unexpectedError}\n\nNo catalogue files were changed.`,
      message: 'The Video Hub catalogue could not be initialized safely.',
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
    if (err) {
      win.setBounds({ x: 0, y: 0, width: screenWidth, height: screenHeight });
      event.sender.send('set-language-based-off-system-locale', locale);
      event.sender.send('please-open-wizard', true); // firstRun = true!
    } else {

      try {
        const previouslySavedSettings: SettingsObject = JSON.parse(data);
        if (previouslySavedSettings.appState.addtionalExtensions) {
          GLOBALS.additionalExtensions = parseAdditionalExtensions(previouslySavedSettings.appState.addtionalExtensions);
        }
        event.sender.send('settings-returning', previouslySavedSettings, locale);

      } catch (err) {
        event.sender.send('please-open-wizard', false);
      }
    }
  });
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

  if (fs.existsSync(path.join(outDir, hubName + '.vha2'))) { // make sure no hub name under the same name exists
    event.sender.send('show-msg-dialog', systemMessages.error, systemMessages.hubAlreadyExists, systemMessages.pleaseChangeName);
    event.sender.send('please-fix-hub-name');
  } else {

    if (!fs.existsSync(path.join(outDir, 'vha-' + hubName))) { // create the folder `vha-hubName` inside the output directory
      console.log('vha-hubName folder did not exist, creating');
      fs.mkdirSync(path.join(outDir, 'vha-' + hubName));
      fs.mkdirSync(path.join(outDir, 'vha-' + hubName + '/filmstrips'));
      fs.mkdirSync(path.join(outDir, 'vha-' + hubName + '/thumbnails'));
      fs.mkdirSync(path.join(outDir, 'vha-' + hubName + '/clips'));
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

  const pathToTheFile = path.join(GLOBALS.selectedOutputFolder, GLOBALS.hubName + '.vha2');

  writeVhaFileToDisk(finalObject, pathToTheFile, (error: Error) => {

    if (error) {
      dialog.showMessageBox(win, {
        buttons: ['OK'],
        detail: error.message,
        message: 'The new Video Hub catalogue could not be saved.',
        title: 'Catalogue Save Failed',
        type: 'error',
      });
      return;
    }

    GLOBALS.currentlyOpenVhaFile = pathToTheFile;

    sendFinalObjectToAngular(finalObject, GLOBALS);

    setUpDirectoryWatchers(finalObject.inputDirs, []);
  });
}

/**
 * Summon system modal to choose a catalogue JSON file
 * open via `openThisDamnFile` method
 */
ipcMain.on('system-open-file-through-modal', (event, somethingElse) => {  // TODO -- check -- do I need to save vha to disk?
  dialog.showOpenDialog(win, {
    title: systemMessages.selectPreviousHub,
    filters: [{
      name: 'Video Hub catalogue files', // TODO -- i18n FIX ME
      extensions: ['vha2', 'json']
    }],
    properties: ['openFile']
  }).then(result => {
    const chosenFile: string = result.filePaths[0];

    if (chosenFile) {
      openThisDamnFile(chosenFile);
    }
  }).catch(err => {});
});

/**
 * Open .vha2 file (from given path)
 * save current VHA file to disk, if provided
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
      console.log('.vha2 file saved before opening another');
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
 * Opens vha file while the app is running. Only works for mac OS.
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
