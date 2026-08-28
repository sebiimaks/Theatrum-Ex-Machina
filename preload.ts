import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';

// Sandboxed preloads cannot load arbitrary local modules. Keep this bridge
// self-contained so Electron can run it with sandbox: true, while exposing
// only the audited renderer contract below.
const sendChannels = new Set<string>([
  'add-missing-thumbnails',
  'app-to-touchBar',
  'cancel-current-import',
  'cancel-folder-thumbnail-regeneration',
  'cancel-thumbnail-regeneration',
  'catalogue-open-request-consumed',
  'choose-input',
  'choose-output',
  'clean-old-thumbnails',
  'clear-recent-documents',
  'close-window',
  'configure-source-folder',
  'delete-video-file',
  'drag-video-out-of-electron',
  'just-started',
  'load-this-vha-file',
  'maximize-window',
  'minimize-window',
  'open-in-explorer',
  'open-media-file',
  'open-media-file-at-timestamp',
  'please-create-playlist',
  'please-open-url',
  'reconnect-this-folder',
  'regenerate-folder-thumbnails',
  'regenerate-thumbnails',
  'renderer-startup-complete',
  'replace-thumbnail',
  'rescan-source-folder-scope',
  'save-current-vha-file',
  'select-default-video-player',
  'set-app-icon-theme',
  'start-the-import',
  'start-watching-folder',
  'stop-watching-folder',
  'system-messages-updated',
  'system-open-file-through-modal',
  'try-to-rename-this-file',
  'un-maximize-window',
  'update-additional-extensions',
  'write-clipboard-text',
]);

const invokeChannels = new Set<string>([
  'export-catalogue-metadata',
  'export-vha2-catalogue',
  'import-catalogue-metadata',
  'update-source-folder-ignored-subdirectories',
]);

const eventChannels = new Set<string>([
  'all-files-found-in-dir',
  'catalogue-loaded-from-backup',
  'catalogue-open-request-finished',
  'catalogue-read-only-write-blocked',
  'close-window-cancelled',
  'close-window-save-failed',
  'current-vha-file-save-failed',
  'current-vha-file-saved',
  'custom-thumbnail-replaced',
  'directory-now-connected',
  'file-deleted',
  'file-not-found',
  'final-object-returning',
  'folder-scan-failed',
  'folder-scan-request-rejected',
  'folder-thumbnail-regeneration-complete',
  'folder-thumbnail-regeneration-failed',
  'folder-thumbnail-regeneration-progress',
  'folder-watch-error',
  'import-progress-update',
  'input-folder-chosen',
  'known-source-location-found',
  'legacy-catalogue-duplicated',
  'new-video-meta',
  'number-of-screenshots-deleted',
  'old-folder-reconnected',
  'open-catalogue-from-system',
  'os-dark-mode-change',
  'output-folder-chosen',
  'please-fix-hub-name',
  'please-open-wizard',
  'please-shut-down-ASAP',
  'preferred-video-player-returning',
  'rename-file-response',
  'set-language-based-off-system-locale',
  'settings-returning',
  'show-msg-dialog',
  'single-file-deleted',
  'source-folder-directories-updated',
  'started-watching-this-dir',
  'thumbnail-regeneration-complete',
  'thumbnail-regeneration-failed',
  'thumbnail-replaced',
  'touchBar-to-app',
]);

function rejectUnknownChannel(channel: string): never {
  throw new Error(`Blocked renderer IPC channel: ${channel}`);
}

contextBridge.exposeInMainWorld('theatrum', {
  clipboard: {
    writeText(text: string): void {
      if (typeof text !== 'string' || text.length > 1024 * 1024) {
        throw new Error('Clipboard text must be a string shorter than 1 MB.');
      }
      ipcRenderer.send('write-clipboard-text', text);
    },
  },
  files: {
    getPathForFile(file: File): string {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        ipcRenderer.send('register-user-file-path', filePath);
      }
      return filePath;
    },
  },
  ipc: {
    send(channel: string, ...args: unknown[]): void {
      if (!sendChannels.has(channel)) {
        rejectUnknownChannel(channel);
      }
      ipcRenderer.send(channel, ...args);
    },
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (!invokeChannels.has(channel)) {
        rejectUnknownChannel(channel);
      }
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel: string, listener: (...args: unknown[]) => void): () => void {
      if (!eventChannels.has(channel)) {
        rejectUnknownChannel(channel);
      }
      if (typeof listener !== 'function') {
        throw new Error('Renderer IPC listener must be a function.');
      }
      const wrappedListener = (_event: unknown, ...args: unknown[]): void => listener(...args);
      ipcRenderer.on(channel, wrappedListener);
      return () => ipcRenderer.removeListener(channel, wrappedListener);
    },
  },
  isElectron: true,
  platform: process.platform,
  webFrame: {
    clearCache(): void {
      webFrame.clearCache();
    },
    setZoomFactor(factor: number): void {
      if (!Number.isFinite(factor) || factor < 0.5 || factor > 3) {
        throw new Error('Zoom factor must be between 0.5 and 3.');
      }
      webFrame.setZoomFactor(factor);
    },
  },
});
