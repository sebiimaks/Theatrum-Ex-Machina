import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { isPrivateTouchIdCleanupFailure } from './private-touch-id';

const ENTRY_URL = 'theatrum://app/index.html';
const SUBMIT_CHANNEL = 'private-password-submit';
const CANCEL_CHANNEL = 'private-password-cancel';
const TOUCH_ID_AVAILABLE_CHANNEL = 'private-password-touch-id-available';
const TOUCH_ID_CHANNEL = 'private-password-touch-id';
let activeRequest: symbol | undefined;

export interface PrivatePasswordRequestOptions {
  contents: WebContents;
  isCurrent: () => boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  touchIdAvailable?: () => Promise<boolean>;
  onTouchId?: () => void;
}

function validPassword(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) { return false; }
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) { return false; }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) { return false; }
  }
  return Buffer.byteLength(value, 'utf8') <= 1024;
}

/**
 * One prompt, one accepted response. Register before the initial loadURL and
 * dispose synchronously when its owning window retires. No paths, results,
 * exceptions or Electron objects are returned to the renderer.
 */
export function registerPrivatePasswordRequest(options: PrivatePasswordRequestOptions): () => Promise<void> {
  if (activeRequest || !options || typeof options.isCurrent !== 'function' ||
      typeof options.onSubmit !== 'function' || typeof options.onCancel !== 'function') {
    throw new Error('Private password request unavailable');
  }
  const { contents, isCurrent, onSubmit, onCancel, touchIdAvailable, onTouchId } = options;
  let initialUrl: string;
  try {
    if (contents.isDestroyed() || !isCurrent()) { throw new Error(); }
    initialUrl = contents.getURL();
    if (initialUrl !== '' && initialUrl !== 'about:blank' && initialUrl !== ENTRY_URL) { throw new Error(); }
  } catch { throw new Error('Private password request unavailable'); }

  const token = Symbol();
  activeRequest = token;
  let disposed = false;
  let accepted = false;
  let invalidated = false;
  let awaitingInitialNavigation = initialUrl !== ENTRY_URL;
  let installedHandler = false;
  const installedTouchId: string[] = [];
  let touchIdQuery = false;
  let touchIdReady = false;
  let touchIdDrain: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let cleanupFailure: Error | undefined;

  const invalidate = (): void => { invalidated = true; };
  const navigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame === false) { return; }
    if (awaitingInitialNavigation && details.isMainFrame === true &&
        !details.isSameDocument && details.url === ENTRY_URL) {
      awaitingInitialNavigation = false;
      return;
    }
    invalidate();
  };

  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    try {
      if (disposed || accepted || invalidated || awaitingInitialNavigation || activeRequest !== token ||
          contents.isDestroyed() || !isCurrent() || event.sender !== contents) { return false; }
      const frame = event.senderFrame;
      return !!frame && frame === contents.mainFrame && !frame.isDestroyed() && !frame.detached &&
        frame.parent === null && frame.url === ENTRY_URL && contents.getURL() === ENTRY_URL;
    } catch { return false; }
  };

  const submit = (event: IpcMainInvokeEvent, ...args: unknown[]): boolean => {
    if (!trusted(event) || args.length !== 1 || !validPassword(args[0])) { return false; }
    accepted = true;
    // Mark the request consumed before calling main-owned code, including when
    // that callback disposes this binding or synchronously re-enters IPC.
    try { onSubmit(args[0]); return true; }
    catch { return false; }
  };

  const checkTouchId = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
    if (!trusted(event) || args.length !== 0 || touchIdQuery || !touchIdAvailable || !onTouchId) { return false; }
    touchIdQuery = true;
    try {
      const work = Promise.resolve().then(() => trusted(event) ? touchIdAvailable() : false).catch(error => {
        if (isPrivateTouchIdCleanupFailure(error)) { cleanupFailure = error; invalidate(); }
        throw error;
      });
      touchIdDrain = work.then(() => undefined, () => undefined);
      const available = await work;
      touchIdReady = trusted(event) && available === true;
      return touchIdReady;
    } catch {
      touchIdReady = false;
      if (cleanupFailure) { try { onCancel(); } catch { /* Disposal still reports quarantine. */ } }
      return false;
    }
    finally { touchIdQuery = false; }
  };
  const useTouchId = (event: IpcMainInvokeEvent, ...args: unknown[]): boolean => {
    if (!trusted(event) || args.length !== 0 || !touchIdReady || !onTouchId) { return false; }
    accepted = true;
    try { onTouchId(); return true; } catch { return false; }
  };

  const cancel = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (!trusted(event) || args.length !== 0) { return; }
    accepted = true;
    try { onCancel(); } catch { /* Never reflect callback diagnostics. */ }
  };

  const dispose = (): Promise<void> => {
    if (disposal) { return disposal; }
    disposed = true;
    contents.removeListener('did-start-navigation', navigate);
    contents.removeListener('destroyed', invalidate);
    contents.removeListener('render-process-gone', invalidate);
    ipcMain.removeListener(CANCEL_CHANNEL, cancel);
    if (activeRequest === token) {
      if (installedHandler) { ipcMain.removeHandler(SUBMIT_CHANNEL); }
      for (const channel of installedTouchId) { ipcMain.removeHandler(channel); }
      if (!touchIdDrain && !cleanupFailure) { activeRequest = undefined; }
    }
    disposal = (touchIdDrain ?? Promise.resolve()).then(() => {
      if (cleanupFailure) { throw cleanupFailure; }
      if (activeRequest === token) { activeRequest = undefined; }
    });
    return disposal;
  };

  try {
    // Electron rejects an existing invoke handler. Do not replace it or remove
    // it if registration fails; a different owner must retain its boundary.
    ipcMain.handle(SUBMIT_CHANNEL, submit);
    installedHandler = true;
    ipcMain.handle(TOUCH_ID_AVAILABLE_CHANNEL, checkTouchId); installedTouchId.push(TOUCH_ID_AVAILABLE_CHANNEL);
    ipcMain.handle(TOUCH_ID_CHANNEL, useTouchId); installedTouchId.push(TOUCH_ID_CHANNEL);
    ipcMain.on(CANCEL_CHANNEL, cancel);
    contents.on('did-start-navigation', navigate);
    contents.on('destroyed', invalidate);
    contents.on('render-process-gone', invalidate);
  } catch {
    dispose();
    throw new Error('Private password request unavailable');
  }
  return dispose;
}
