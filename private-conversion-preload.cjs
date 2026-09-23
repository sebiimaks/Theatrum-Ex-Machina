'use strict';

// Standalone sandbox bridge. This document has no ordinary application bridge,
// filesystem methods, IPC subscriptions, or Electron event objects.
const { contextBridge, ipcRenderer } = require('electron');
const failures = ['destination-unavailable', 'destination-exists', 'permission-denied', 'storage-full',
  'files-unavailable', 'source-inspection-failed', 'source-changed', 'storage-initialization-failed',
  'catalogue-encryption-failed', 'preview-copy-failed', 'verification-failed', 'receipt-failed', 'conversion-failed'];

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function state(value) {
  try {
    if (!value || !['review', 'selecting', 'scanning', 'copying', 'verifying', 'complete', 'failed'].includes(value.phase) ||
        !count(value.completed) || !count(value.total) || value.completed > value.total) { return undefined; }
    if (value.failure !== undefined && (value.phase !== 'failed' || !failures.includes(value.failure))) { return undefined; }
    const review = value.review;
    if (!review || !count(review.videos) || !count(review.availablePreviews) || !count(review.previewBytes) ||
        !review.missingPreviews || !count(review.missingPreviews.thumbnail) || !count(review.missingPreviews.filmstrip) ||
        !count(review.missingPreviews['clip-poster']) || !count(review.missingPreviews.clip)) { return undefined; }
    return Object.freeze({ phase: value.phase, completed: value.completed, total: value.total,
      ...(value.phase === 'failed' && value.failure !== undefined ? { failure: value.failure } : {}),
      review: Object.freeze({ videos: review.videos, availablePreviews: review.availablePreviews, previewBytes: review.previewBytes,
        missingPreviews: Object.freeze({ thumbnail: review.missingPreviews.thumbnail, filmstrip: review.missingPreviews.filmstrip,
          'clip-poster': review.missingPreviews['clip-poster'], clip: review.missingPreviews.clip }) }) });
  } catch { return undefined; }
}
function validPassword(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) { return false; }
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) { return false; }
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) { return false; }
    else { bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3; }
    if (bytes > 1024) { return false; }
  }
  return true;
}

let submitted = false;
let cancelled = false;
let finished = false;
contextBridge.exposeInMainWorld('privateConversion', Object.freeze({
  getState: async (...args) => {
    if (cancelled || args.length !== 0) { return undefined; }
    try {
      const result = state(await ipcRenderer.invoke('private-conversion-state'));
      return cancelled ? undefined : result;
    } catch { return undefined; }
  },
  submit: async (...args) => {
    if (submitted || cancelled || args.length !== 3 || !validPassword(args[0]) ||
        typeof args[1] !== 'boolean' || args[2] !== true) { return false; }
    submitted = true;
    try {
      const submission = ipcRenderer.invoke('private-conversion-submit', args[0], args[1], true);
      args[0] = undefined;
      const success = await submission === true && !cancelled;
      finished = success;
      return success;
    } catch { return false; }
    finally { args[0] = undefined; }
  },
  cancel: (...args) => {
    if (cancelled || finished || args.length !== 0) { return; }
    cancelled = true;
    try { ipcRenderer.send('private-conversion-cancel'); } catch { /* The window may already be gone. */ }
  },
}));
