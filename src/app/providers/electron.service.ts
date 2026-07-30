import { Injectable } from '@angular/core';

// If you import a module but never use any of the imported values other than as TypeScript types,
// the resulting javascript file will look as if you never imported the module at all.
import type { ipcRenderer, webFrame, webUtils } from 'electron';
import type * as childProcess from 'child_process';

@Injectable()
export class ElectronService {

  ipcRenderer: typeof ipcRenderer;
  childProcess: typeof childProcess;
  webFrame: typeof webFrame;
  webUtils: typeof webUtils;

  constructor() {
    // Conditional imports
    if (this.isElectron()) {
      this.ipcRenderer = window.require('electron').ipcRenderer;
      this.webFrame = window.require('electron').webFrame;
      this.webUtils = window.require('electron').webUtils;
      this.childProcess = window.require('child_process');
    }
  }

  getPathForFile(file: File): string {
    return this.webUtils.getPathForFile(file);
  }

  isElectron = () => {
    return !!(window && window.process && window.process.type);
  }

}
