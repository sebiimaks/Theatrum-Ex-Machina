/**
 * The renderer's intentionally small Electron surface.  Keeping the channel
 * lists here lets both the preload boundary and Angular agree on the contract
 * without exposing Electron itself to page code.
 */
export const RENDERER_TO_MAIN_CHANNELS = [
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
] as const;

export const RENDERER_TO_MAIN_INVOKE_CHANNELS = [
  'export-catalogue-metadata',
  'export-vha2-catalogue',
  'import-catalogue-metadata',
  'update-source-folder-ignored-subdirectories',
] as const;

export const MAIN_TO_RENDERER_CHANNELS = [
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
] as const;

export type RendererToMainChannel = typeof RENDERER_TO_MAIN_CHANNELS[number];
export type RendererToMainInvokeChannel = typeof RENDERER_TO_MAIN_INVOKE_CHANNELS[number];
export type MainToRendererChannel = typeof MAIN_TO_RENDERER_CHANNELS[number];

export type RendererEventListener = (...args: any[]) => void;

export interface TheatrumIpcBridge {
  send(channel: RendererToMainChannel, ...args: unknown[]): void;
  invoke(channel: RendererToMainInvokeChannel, ...args: unknown[]): Promise<unknown>;
  on(channel: MainToRendererChannel, listener: RendererEventListener): () => void;
}

export interface TheatrumElectronBridge {
  clipboard: {
    writeText(text: string): void;
  };
  files: {
    getPathForFile(file: File): string;
  };
  ipc: TheatrumIpcBridge;
  isElectron: true;
  platform: string;
  webFrame: {
    clearCache(): void;
    setZoomFactor(factor: number): void;
  };
}
