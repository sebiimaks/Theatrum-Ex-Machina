import { app, dialog, shell, BrowserWindow } from 'electron';

import * as path from 'path';
const fs = require('fs');
const trash = require('trash');
const spawn = require('child_process').spawn;

import { GLOBALS } from './main-globals';
import { ImageElement, FinalObject, InputSources } from '../interfaces/final-object.interface';
import { SettingsObject } from '../interfaces/settings-object.interface';
import { createDotPlsFile, writeVhaFileToDisk } from './main-support';
import { replaceThumbnailWithNewImage } from './main-extract';
import {
  closeWatcher,
  startWatcher,
  extractAnyMissingThumbs,
  regenerateThumbnails,
  removeThumbnailsNotInHub,
} from './main-extract-async';
import { writeJsonAtomically } from './vha-file-persistence';
import {
  buildPlayerLaunch,
  isAllowedExternalUrl,
  normalizeAbsolutePath,
  ProcessLaunch,
  requireConfiguredSourceRoot,
  resolveExistingMediaPath,
  resolveNewMediaPath,
} from './local-operation-safety';

/**
 * Set up the listeners
 * @param ipc
 * @param win
 * @param pathToAppData
 * @param systemMessages
 */
export function setUpIpcMessages(ipc, win, pathToAppData, systemMessages) {

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
      listener(event, ...args);
    });
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
        const tempIcon: string = app.isPackaged ? './resources/assets/logo.png' : './src/assets/logo.png';
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
    const fileToReplace: string = path.join(
        GLOBALS.selectedOutputFolder,
        'vha-' + GLOBALS.hubName,
        'thumbnails',
        item.hash + '.jpg'
      );

    const height: number = GLOBALS.screenshotSettings.height;

    replaceThumbnailWithNewImage(fileToReplace, pathToIncomingJpg, height)
      .then(success => {
        if (success) {
          event.sender.send('thumbnail-replaced');
        }
      })
      .catch((err) => {});

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
  trustedIpcOn('start-watching-folder', (event, watchedFolderIndex: string, path2: string, persistent: boolean) => {
    // annoyingly it's not a number :     ^^^^^^^^^^^^^^^^^^ -- because object keys are strings :(
    console.log('start watching:', watchedFolderIndex, path2, persistent);
    startWatcher(parseInt(watchedFolderIndex, 10), path2, persistent);
  });

  /**
   * extract any missing thumbnails
   */
  trustedIpcOn('add-missing-thumbnails', (event, finalArray: ImageElement[], extractClips: boolean) => {
    extractAnyMissingThumbs(finalArray);
  });

  /**
   * Remove and recreate the generated preview assets for one video.
   */
  trustedIpcOn('regenerate-thumbnails', (event, item: ImageElement) => {
    regenerateThumbnails(item)
      .then((screenshotCount: number) => {
        event.sender.send('thumbnail-replaced');
        event.sender.send('thumbnail-regeneration-complete', item.hash, screenshotCount);
      })
      .catch((error: Error) => {
        console.error('Unable to regenerate thumbnails:', error);
        event.sender.send('thumbnail-regeneration-failed');
      });
  });

  /**
   * Remove any thumbnails for files no longer present in the hub
   */
  trustedIpcOn('clean-old-thumbnails', (event, finalArray: ImageElement[]) => {
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
   * Summon system modal to choose OUTPUT directory
   * where the final .vha2 file, vha-folder, and all screenshots will be saved
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
      if (finalObjectToSave === null) {
        closeWindow();
        return;
      }

      writeVhaFileToDisk(finalObjectToSave, GLOBALS.currentlyOpenVhaFile, (error: Error) => {
        if (error) {
          reportCloseFailure(error, 'The current catalogue could not be saved. The app will remain open to protect your changes.');
          return;
        }
        closeWindow();
      });
    }).catch((error: Error) => {
      reportCloseFailure(error, 'The application settings could not be saved. The app will remain open.');
    });
  });

}
