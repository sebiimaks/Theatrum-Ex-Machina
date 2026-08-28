import { Injectable } from '@angular/core';

import type {
  MainToRendererChannel,
  RendererToMainChannel,
  RendererToMainInvokeChannel,
  TheatrumElectronBridge,
} from '../../../interfaces/electron-bridge';

interface LegacyIpcRendererFacade {
  invoke(channel: string, ...args: any[]): Promise<any>;
  on(channel: string, listener: (...args: any[]) => void): () => void;
  send(channel: string, ...args: any[]): void;
}

interface LegacyWebFrameFacade {
  clearCache(): Promise<void>;
  setZoomFactor(factor: number): void;
}

function unavailableElectronApi(): never {
  throw new Error('The Electron desktop API is unavailable in this window.');
}

/**
 * Compatibility facade for the Angular app. It deliberately preserves the
 * existing renderer call shape while routing every operation through the
 * narrow context-isolated preload bridge.
 */
@Injectable()
export class ElectronService {

  private readonly bridge: TheatrumElectronBridge | undefined;

  ipcRenderer: LegacyIpcRendererFacade;
  webFrame: LegacyWebFrameFacade;

  constructor() {
    this.bridge = (globalThis as typeof globalThis & {
      theatrum?: TheatrumElectronBridge;
    }).theatrum;

    this.ipcRenderer = {
      invoke: (channel: string, ...args: any[]): Promise<any> => {
        if (!this.bridge) {
          return Promise.reject(new Error('The Electron desktop API is unavailable in this window.'));
        }
        return this.bridge.ipc.invoke(channel as RendererToMainInvokeChannel, ...args);
      },
      on: (channel: string, listener: (...args: any[]) => void): (() => void) => {
        if (!this.bridge) {
          return () => undefined;
        }
        // Existing Angular listeners expect Electron's event parameter first.
        // Preload intentionally removes that privileged event object, so retain
        // the positional contract with an undefined placeholder.
        return this.bridge.ipc.on(channel as MainToRendererChannel, (...args: any[]) => {
          listener(undefined, ...args);
        });
      },
      send: (channel: string, ...args: any[]): void => {
        if (!this.bridge) {
          unavailableElectronApi();
        }
        this.bridge.ipc.send(channel as RendererToMainChannel, ...args);
      },
    };

    this.webFrame = {
      clearCache: (): Promise<void> => {
        this.bridge?.webFrame.clearCache();
        return Promise.resolve();
      },
      setZoomFactor: (factor: number): void => {
        if (!this.bridge) {
          return;
        }
        this.bridge.webFrame.setZoomFactor(factor);
      },
    };
  }

  get platform(): string {
    return this.bridge?.platform || '';
  }

  copyText(text: string): void {
    if (!this.bridge) {
      unavailableElectronApi();
    }
    this.bridge.clipboard.writeText(text);
  }

  getPathForFile(file: File): string {
    if (!this.bridge) {
      unavailableElectronApi();
    }
    return this.bridge.files.getPathForFile(file);
  }

  isElectron = (): boolean => this.bridge?.isElectron === true;
}
