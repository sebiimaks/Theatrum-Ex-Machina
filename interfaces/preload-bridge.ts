import {
  MAIN_TO_RENDERER_CHANNELS,
  RENDERER_TO_MAIN_CHANNELS,
  RENDERER_TO_MAIN_INVOKE_CHANNELS,
  type MainToRendererChannel,
  type RendererEventListener,
  type RendererToMainChannel,
  type RendererToMainInvokeChannel,
  type TheatrumElectronBridge,
} from './electron-bridge';

export interface PreloadBridgeDependencies {
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: (...args: any[]) => void): void;
    removeListener(channel: string, listener: (...args: any[]) => void): void;
    send(channel: string, ...args: unknown[]): void;
  };
  platform: string;
  webFrame: {
    clearCache(): void;
    setZoomFactor(factor: number): void;
  };
  webUtils: {
    getPathForFile(file: File): string;
  };
}

const sendChannels = new Set<string>(RENDERER_TO_MAIN_CHANNELS);
const invokeChannels = new Set<string>(RENDERER_TO_MAIN_INVOKE_CHANNELS);
const eventChannels = new Set<string>(MAIN_TO_RENDERER_CHANNELS);

function rejectUnknownChannel(channel: string): never {
  throw new Error(`Blocked renderer IPC channel: ${channel}`);
}

/** Create the deliberately small API exposed across Electron's context bridge. */
export function createTheatrumBridge(
  dependencies: PreloadBridgeDependencies,
): TheatrumElectronBridge {
  return {
    clipboard: {
      writeText(text: string): void {
        if (typeof text !== 'string' || text.length > 1024 * 1024) {
          throw new Error('Clipboard text must be a string shorter than 1 MB.');
        }
        dependencies.ipcRenderer.send('write-clipboard-text', text);
      },
    },
    files: {
      getPathForFile(file: File): string {
        const filePath = dependencies.webUtils.getPathForFile(file);
        if (filePath) {
          dependencies.ipcRenderer.send('register-user-file-path', filePath);
        }
        return filePath;
      },
    },
    ipc: {
      send(channel: RendererToMainChannel, ...args: unknown[]): void {
        if (!sendChannels.has(channel)) {
          rejectUnknownChannel(channel);
        }
        dependencies.ipcRenderer.send(channel, ...args);
      },
      invoke(channel: RendererToMainInvokeChannel, ...args: unknown[]): Promise<unknown> {
        if (!invokeChannels.has(channel)) {
          return Promise.reject(rejectUnknownChannel(channel));
        }
        return dependencies.ipcRenderer.invoke(channel, ...args);
      },
      on(channel: MainToRendererChannel, listener: RendererEventListener): () => void {
        if (!eventChannels.has(channel)) {
          rejectUnknownChannel(channel);
        }
        if (typeof listener !== 'function') {
          throw new Error('Renderer IPC listener must be a function.');
        }
        const wrappedListener = (_event: unknown, ...args: unknown[]): void => {
          listener(...args);
        };
        dependencies.ipcRenderer.on(channel, wrappedListener);
        return () => dependencies.ipcRenderer.removeListener(channel, wrappedListener);
      },
    },
    isElectron: true,
    platform: dependencies.platform,
    webFrame: {
      clearCache(): void {
        dependencies.webFrame.clearCache();
      },
      setZoomFactor(factor: number): void {
        if (!Number.isFinite(factor) || factor < 0.5 || factor > 3) {
          throw new Error('Zoom factor must be between 0.5 and 3.');
        }
        dependencies.webFrame.setZoomFactor(factor);
      },
    },
  };
}
