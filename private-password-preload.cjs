'use strict';

// This sandbox preload is deliberately standalone: no ordinary application
// bridge, local modules, paths, IPC subscriptions or Electron event objects.
const { contextBridge, ipcRenderer } = require('electron');

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

let consumed = false;
contextBridge.exposeInMainWorld('privateUnlock', Object.freeze({
  touchIdAvailable: async (...args) => {
    if (consumed || args.length !== 0) { return false; }
    try { return await ipcRenderer.invoke('private-password-touch-id-available') === true && !consumed; }
    catch { return false; }
  },
  useTouchId: async (...args) => {
    if (consumed || args.length !== 0) { return false; }
    consumed = true;
    try { return await ipcRenderer.invoke('private-password-touch-id') === true; }
    catch { return false; }
  },
  submit: async (...args) => {
    if (consumed || args.length !== 1 || !validPassword(args[0])) { return false; }
    consumed = true;
    try { return await ipcRenderer.invoke('private-password-submit', args[0]) === true; }
    catch { return false; }
  },
  cancel: (...args) => {
    if (consumed || args.length !== 0) { return; }
    consumed = true;
    try { ipcRenderer.send('private-password-cancel'); } catch { /* The prompt may already be gone. */ }
  },
}));
