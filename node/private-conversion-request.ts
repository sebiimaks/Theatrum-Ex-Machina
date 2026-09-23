import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';

import type { PrivateConversionProgress, PrivateConversionReview, PrivateConversionState } from '../interfaces/private-conversion';
import { isPrivateHubConversionCleanupFailure } from './private-hub-conversion';
import { privateConversionFailureCode } from './private-conversion-errors';

const ENTRY_URL = 'theatrum://app/index.html';
const STATE_CHANNEL = 'private-conversion-state';
const SUBMIT_CHANNEL = 'private-conversion-submit';
const CANCEL_CHANNEL = 'private-conversion-cancel';
let activeRequest: symbol | undefined;

export interface PrivateConversionRequestOptions {
  contents: WebContents;
  isCurrent: () => boolean;
  review: PrivateConversionReview;
  start: (password: string, allowMissingPreviews: boolean,
    onProgress: (progress: PrivateConversionProgress) => void) => Promise<'completed' | 'cancelled'>;
  onCancel: () => void;
  onComplete: () => void;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneReview(value: PrivateConversionReview): PrivateConversionReview {
  if (!value || !count(value.videos) || !count(value.availablePreviews) || !count(value.previewBytes) ||
      !value.missingPreviews || !count(value.missingPreviews.thumbnail) || !count(value.missingPreviews.filmstrip) ||
      !count(value.missingPreviews['clip-poster']) || !count(value.missingPreviews.clip)) { throw new Error(); }
  return Object.freeze({ videos: value.videos, availablePreviews: value.availablePreviews, previewBytes: value.previewBytes,
    missingPreviews: Object.freeze({ thumbnail: value.missingPreviews.thumbnail, filmstrip: value.missingPreviews.filmstrip,
      'clip-poster': value.missingPreviews['clip-poster'], clip: value.missingPreviews.clip }) });
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

/** Main-only conversion ownership. Registration must precede the initial loadURL. */
export function registerPrivateConversionRequest(options: PrivateConversionRequestOptions): () => Promise<void> {
  if (activeRequest || !options || typeof options.isCurrent !== 'function' || typeof options.start !== 'function' ||
      typeof options.onCancel !== 'function' || typeof options.onComplete !== 'function') {
    throw new Error('Private conversion request unavailable');
  }
  const { contents, isCurrent, start, onCancel, onComplete } = options;
  let initialUrl: string;
  let review: PrivateConversionReview;
  let trustedFrame: WebFrameMain | undefined;
  try {
    if (contents.isDestroyed() || !isCurrent()) { throw new Error(); }
    initialUrl = contents.getURL();
    if (initialUrl !== '' && initialUrl !== 'about:blank' && initialUrl !== ENTRY_URL) { throw new Error(); }
    review = cloneReview(options.review);
    if (initialUrl === ENTRY_URL) { trustedFrame = contents.mainFrame; }
  } catch { throw new Error('Private conversion request unavailable'); }

  const token = Symbol();
  activeRequest = token;
  let disposed = false;
  let submitted = false;
  let acceptingProgress = false;
  let stopped = false;
  let callbackRunning = false;
  let invalidated = false;
  let awaitingInitialNavigation = initialUrl !== ENTRY_URL;
  let state: PrivateConversionState = Object.freeze({ phase: 'review', review, completed: 0, total: 0 });
  let workDrain: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let cleanupFailure: Error | undefined;
  const installed: string[] = [];

  const invalidate = (): void => { invalidated = true; };
  const navigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame === false) { return; }
    if (awaitingInitialNavigation && details.isMainFrame === true && !details.isSameDocument && details.url === ENTRY_URL) {
      awaitingInitialNavigation = false;
      return;
    }
    invalidate();
  };
  const live = (): boolean => {
    try {
      return !disposed && !stopped && !invalidated && !awaitingInitialNavigation && activeRequest === token &&
        !contents.isDestroyed() && isCurrent() && contents.getURL() === ENTRY_URL &&
        (!trustedFrame || trustedFrame === contents.mainFrame);
    } catch { return false; }
  };
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    try {
      if (!live() || event.sender !== contents) { return false; }
      const frame = event.senderFrame;
      if (!frame || frame !== contents.mainFrame || frame.isDestroyed() || frame.detached || frame.parent !== null || frame.url !== ENTRY_URL) {
        return false;
      }
      // Bind the first loaded frame once; replacing it with another same-URL
      // frame never grants a second document this request's authority.
      trustedFrame ??= frame;
      return trustedFrame === frame;
    } catch { return false; }
  };
  const retire = (): void => {
    if (stopped) { return; }
    stopped = true;
    callbackRunning = true;
    try { onCancel(); } catch { cleanupFailure ??= new Error('Private conversion cleanup could not be confirmed'); }
    finally { callbackRunning = false; }
  };
  const getState = (event: IpcMainInvokeEvent, ...args: unknown[]): PrivateConversionState | undefined =>
    trusted(event) && args.length === 0 ? state : undefined;
  const progress = (value: PrivateConversionProgress): void => {
    if (!live() || !acceptingProgress) { return; }
    try {
      if (!value || !['scanning', 'copying', 'verifying', 'complete'].includes(value.stage) ||
          !count(value.completed) || !count(value.total) || value.completed > value.total) { return; }
      state = Object.freeze({ phase: value.stage, review, completed: value.completed, total: value.total });
    } catch { /* Malformed progress never exposes callback diagnostics. */ }
  };
  const submit = async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<boolean> => {
    if (!trusted(event) || submitted || args.length !== 3 || !validPassword(args[0]) ||
        typeof args[1] !== 'boolean' || args[2] !== true ||
        (Object.values(review.missingPreviews).some(value => value > 0) && args[1] !== true)) { return false; }
    submitted = true;
    acceptingProgress = true;
    state = Object.freeze({ phase: 'selecting', review, completed: 0, total: 0 });
    let password = args[0]; const allowMissing = args[1];
    args[0] = undefined;
    // Install a drain before calling main-owned code, which can retire this
    // window synchronously. Disposal must await the work even after cancellation.
    const work = Promise.resolve().then(() => {
      try { return live() ? start(password, allowMissing, progress) : 'cancelled' as const; }
      finally { password = ''; }
    });
    workDrain = work.then(() => undefined, error => {
      if (isPrivateHubConversionCleanupFailure(error)) { cleanupFailure = error; }
    });
    try {
      const result = await work;
      if (!live()) { return false; }
      if (result === 'cancelled') { retire(); return false; }
      if (result !== 'completed') { throw new Error(); }
      state = Object.freeze({ phase: 'complete', review, completed: state.total, total: state.total });
      stopped = true;
      callbackRunning = true;
      try { onComplete(); return true; }
      catch { cleanupFailure ??= new Error('Private conversion cleanup could not be confirmed'); return false; }
      finally { callbackRunning = false; }
    } catch (error) {
      if (isPrivateHubConversionCleanupFailure(error)) { cleanupFailure = error; invalidate(); retire(); }
      else if (live()) {
        state = Object.freeze({ phase: 'failed', review, completed: state.completed, total: state.total,
          failure: privateConversionFailureCode(error) });
      }
      return false;
    } finally { acceptingProgress = false; }
  };
  const cancel = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (!trusted(event) || args.length !== 0) { return; }
    retire();
  };
  const dispose = (): Promise<void> => {
    if (disposal) { return disposal; }
    disposed = true;
    contents.removeListener('did-start-navigation', navigate);
    contents.removeListener('destroyed', invalidate);
    contents.removeListener('render-process-gone', invalidate);
    ipcMain.removeListener(CANCEL_CHANNEL, cancel);
    if (activeRequest === token) {
      for (const channel of installed) { ipcMain.removeHandler(channel); }
      if (!workDrain && !cleanupFailure && !callbackRunning) { activeRequest = undefined; }
    }
    disposal = (workDrain ?? Promise.resolve()).then(() => {
      if (cleanupFailure) { throw cleanupFailure; }
      if (activeRequest === token) { activeRequest = undefined; }
    });
    return disposal;
  };
  try {
    ipcMain.handle(STATE_CHANNEL, getState); installed.push(STATE_CHANNEL);
    ipcMain.handle(SUBMIT_CHANNEL, submit); installed.push(SUBMIT_CHANNEL);
    ipcMain.on(CANCEL_CHANNEL, cancel);
    contents.on('did-start-navigation', navigate);
    contents.on('destroyed', invalidate);
    contents.on('render-process-gone', invalidate);
  } catch {
    void dispose();
    throw new Error('Private conversion request unavailable');
  }
  return dispose;
}
