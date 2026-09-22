import { Injectable } from '@angular/core';
import { RendererMutationService } from '../services/renderer-mutation.service';
import { RendererIpcLifetime } from '../common/renderer-ipc-lifetime';
import { SAVED_NORMAL_DOCUMENT_CHANNELS } from '../../../interfaces/saved-normal-document';

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
  private readonly lifetime: RendererIpcLifetime;

  ipcRenderer: LegacyIpcRendererFacade;
  webFrame: LegacyWebFrameFacade;

  constructor(private readonly mutations: RendererMutationService) {
    this.lifetime = new RendererIpcLifetime(mutations);
    this.bridge = (globalThis as typeof globalThis & {
      theatrum?: TheatrumElectronBridge;
    }).theatrum;

    this.ipcRenderer = {
      invoke: (channel: string, ...args: any[]): Promise<any> => {
        if (!this.bridge) {
          return Promise.reject(new Error('The Electron desktop API is unavailable in this window.'));
        }
        return this.lifetime.invoke(() => this.bridge!.ipc.invoke(channel as RendererToMainInvokeChannel, ...args));
      },
      on: (channel: string, listener: (...args: any[]) => void): (() => void) => {
        if (!this.bridge) {
          return () => undefined;
        }
        // Existing Angular listeners expect Electron's event parameter first.
        // Preload intentionally removes that privileged event object, so retain
        // the positional contract with an undefined placeholder.
        let subscribed = true;
        const remove = this.bridge.ipc.on(channel as MainToRendererChannel, (...args: any[]) => {
          const deliver = (): void => { if (subscribed) { listener(undefined, ...args); } };
          if (channel === SAVED_NORMAL_DOCUMENT_CHANNELS.request || channel === SAVED_NORMAL_DOCUMENT_CHANNELS.release) {
            deliver();
          } else { this.lifetime.deliver(deliver); }
        });
        return () => { subscribed = false; remove(); };
      },
      send: (channel: string, ...args: any[]): void => {
        if (channel !== SAVED_NORMAL_DOCUMENT_CHANNELS.snapshot) { this.mutations.assertAccepting(); }
        if (!this.bridge) {
          unavailableElectronApi();
        }
        this.bridge.ipc.send(channel as RendererToMainChannel, ...args);
      },
    };

    this.webFrame = {
      clearCache: (): Promise<void> => {
        this.mutations.assertAccepting();
        this.bridge?.webFrame.clearCache();
        return Promise.resolve();
      },
      setZoomFactor: (factor: number): void => {
        this.mutations.assertAccepting();
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
    this.mutations.assertAccepting();
    if (!this.bridge) {
      unavailableElectronApi();
    }
    this.bridge.clipboard.writeText(text);
  }

  getPathForFile(file: File): string {
    this.mutations.assertAccepting();
    if (!this.bridge) {
      unavailableElectronApi();
    }
    return this.bridge.files.getPathForFile(file);
  }

  isElectron = (): boolean => this.bridge?.isElectron === true;

  drainDeferredEvents(): void { this.lifetime.drain(); }
}
