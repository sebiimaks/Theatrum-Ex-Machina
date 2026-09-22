'use strict';

// Standalone sandbox bridge: no general IPC, paths, keys, file or clipboard API.
const { contextBridge, ipcRenderer } = require('electron');
const unavailable = () => ({ status: 'unavailable' });
let locked = false;
let pending;
let cancellationSent = false;
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const string = (value, limit) => typeof value === 'string' && value.length <= limit;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const autoLockMinutes = value => [0, 1, 5, 15, 30].includes(value);
// Keep the standalone sandbox validator aligned with the shared UTF-8 contract.
const password = value => {
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
};
function passwordChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('currentPassword') || !keys.includes('newPassword')) { return; }
  const current = Object.getOwnPropertyDescriptor(value, 'currentPassword');
  const next = Object.getOwnPropertyDescriptor(value, 'newPassword');
  if (!current || !next || !Object.hasOwn(current, 'value') || !Object.hasOwn(next, 'value')
    || !password(current.value) || !password(next.value) || current.value === next.value) { return; }
  return { currentPassword: current.value, newPassword: next.value };
}
function unprotectedCopyRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('password') || !keys.includes('acknowledge')) { return; }
  const credential = Object.getOwnPropertyDescriptor(value, 'password');
  const acknowledge = Object.getOwnPropertyDescriptor(value, 'acknowledge');
  if (!credential || !acknowledge || !Object.hasOwn(credential, 'value') || !Object.hasOwn(acknowledge, 'value')
    || !password(credential.value) || acknowledge.value !== true) { return; }
  return { password: credential.value, acknowledge: true };
}
function touchIdRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'password') { return; }
  const credential = Object.getOwnPropertyDescriptor(value, 'password');
  if (!credential || !Object.hasOwn(credential, 'value') || !password(credential.value)) { return; }
  return { password: credential.value };
}
function clearUnprotectedCopy(value) { if (value) { value.password = ''; } }
function clearPasswordChange(value) {
  if (value) { value.currentPassword = ''; value.newPassword = ''; }
}
const url = (value, kind, extension) => typeof value === 'string'
  && new RegExp('^theatrum://app/media/' + kind + '/[a-zA-Z0-9_-]{1,200}\\.' + extension
    + '(?:\\?v=[a-f0-9]{32})?$').exec(value)?.[0] === value;

function item(value, details) {
  if (!value || typeof value !== 'object' || !validId(value.id) || !string(value.title, 2048)
    || ![value.duration, value.width, value.height, value.rating].every(number) || value.rating > 5
    || typeof value.favourite !== 'boolean' || !Array.isArray(value.tags) || value.tags.length > 128
    || !value.tags.every(tag => string(tag, 512)) || !url(value.thumbnailUrl, 'thumbnails', 'jpg')) { return; }
  const result = { id: value.id, title: value.title, duration: value.duration, width: value.width, height: value.height,
    rating: value.rating, favourite: value.favourite, tags: value.tags.slice(), thumbnailUrl: value.thumbnailUrl };
  if (details) {
    if (!string(value.notes, 65_536) || !url(value.clipUrl, 'clips', 'mp4') || !url(value.posterUrl, 'clips', 'jpg')
      || typeof value.truncated !== 'boolean' || typeof value.editable !== 'boolean' || typeof value.regenerable !== 'boolean'
      || !validId(value.revision)) { return; }
    Object.assign(result, { notes: value.notes, clipUrl: value.clipUrl, posterUrl: value.posterUrl, truncated: value.truncated,
      editable: value.editable, regenerable: value.regenerable, revision: value.revision });
  }
  return result;
}
function response(value, mode) {
  if (!value || typeof value !== 'object') { return unavailable(); }
  if (mode === 'changePassword') {
    return ['changed', 'incorrect-password', 'invalid', 'busy', 'unavailable'].includes(value.status)
      ? { status: value.status } : unavailable();
  }
  if (mode === 'createUnprotectedCopy') {
    return ['copied', 'incorrect-password', 'cancelled', 'failed', 'invalid', 'busy', 'unavailable'].includes(value.status)
      ? { status: value.status } : unavailable();
  }
  if (value.status === 'busy') { return { status: 'busy' }; }
  if (mode === 'protection' || mode === 'setProtection') {
    const status = mode === 'protection' ? 'ready' : 'saved';
    return value.status === status && autoLockMinutes(value.autoLockMinutes)
      ? { status, autoLockMinutes: value.autoLockMinutes } : unavailable();
  }
  if (mode === 'regenerate') {
    if (['cancelled', 'conflict', 'source-unavailable', 'wrong-folder'].includes(value.status)) { return { status: value.status }; }
    const generated = value.status === 'generated' ? item(value.item, true) : undefined;
    return generated ? { status: 'generated', item: generated } : unavailable();
  }
  if (mode === 'save') {
    if (value.status === 'conflict' || value.status === 'invalid') { return { status: value.status }; }
    const saved = value.status === 'saved' ? item(value.item, true) : undefined;
    return saved ? { status: 'saved', item: saved } : unavailable();
  }
  if (value.status !== 'ready') { return unavailable(); }
  if (mode === 'detail') {
    const selected = item(value.item, true);
    return selected ? { status: 'ready', item: selected } : unavailable();
  }
  if (!Number.isSafeInteger(value.total) || value.total < 0 || value.total > 100_000
    || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100_000 || value.offset % 48 !== 0
    || !Array.isArray(value.items) || value.items.length > 48) { return unavailable(); }
  const items = value.items.map(row => item(row, false));
  return items.every(Boolean) ? { status: 'ready', total: value.total, offset: value.offset, items } : unavailable();
}
async function invoke(channel, argument, mode) {
  if (locked) { return unavailable(); }
  if (pending) { return { status: 'busy' }; }
  pending = mode;
  cancellationSent = false;
  try {
    // Electron copies invoke arguments synchronously. Release our owned password
    // references while the main process performs the slower credential work.
    const work = ipcRenderer.invoke(channel, ...(mode === 'protection' ? [] : [argument]));
    if (mode === 'changePassword') { clearPasswordChange(argument); argument = undefined; }
    if (mode === 'createUnprotectedCopy') { clearUnprotectedCopy(argument); argument = undefined; }
    const value = await work;
    if (locked) { return unavailable(); }
    const result = response(value, mode);
    if (mode === 'changePassword' && result.status === 'changed') { locked = true; }
    return result;
  } catch { return unavailable(); }
  finally {
    if (mode === 'changePassword') { clearPasswordChange(argument); }
    if (mode === 'createUnprotectedCopy') { clearUnprotectedCopy(argument); }
    pending = undefined;
  }
}
async function invokeTouchId(channel, mode, argument) {
  const unavailable = () => ({ outcome: 'unavailable' });
  if (locked || pending) { return unavailable(); }
  pending = mode;
  try {
    const work = ipcRenderer.invoke(channel, ...(argument ? [argument] : []));
    clearUnprotectedCopy(argument);
    argument = undefined;
    const value = await work;
    if (locked || !value || typeof value !== 'object') { return unavailable(); }
    const outcome = value.outcome;
    if (mode === 'touchIdStatus') {
      const state = value.state;
      return outcome === 'available' && ['enabled', 'disabled'].includes(state)
        ? { outcome: 'available', state } : unavailable();
    }
    const outcomes = mode === 'enableTouchId' ? ['enabled', 'incorrect-password', 'cancelled', 'unavailable']
      : ['disabled', 'unavailable'];
    return outcomes.includes(outcome) ? { outcome } : unavailable();
  } catch { return unavailable(); }
  finally { clearUnprotectedCopy(argument); pending = undefined; }
}
contextBridge.exposeInMainWorld('privateGallery', Object.freeze({
  protection: async (...args) => args.length === 0
    ? invoke('private-gallery-protection', undefined, 'protection') : unavailable(),
  setProtection: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).join(',') !== 'autoLockMinutes' || Object.getOwnPropertySymbols(value).length) { return unavailable(); }
      const property = Object.getOwnPropertyDescriptor(value, 'autoLockMinutes');
      if (!property || !Object.hasOwn(property, 'value') || !autoLockMinutes(property.value)) { return unavailable(); }
      return await invoke('private-gallery-set-protection', { autoLockMinutes: property.value }, 'setProtection');
    } catch { return unavailable(); }
  },
  list: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'offset,query' || !string(value.query, 200)
        || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > 100_000 || value.offset % 48 !== 0) {
        return unavailable();
      }
      return await invoke('private-gallery-list', { query: value.query, offset: value.offset }, 'list');
    } catch { return unavailable(); }
  },
  detail: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-detail', args[0], 'detail') : unavailable(),
  save: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'id,notes,revision,tags'
        || !validId(value.id) || !validId(value.revision) || !string(value.notes, 65_536)
        || !Array.isArray(value.tags) || value.tags.length > 128 || !value.tags.every(tag => string(tag, 512))) {
        return unavailable();
      }
      return await invoke('private-gallery-save', { id: value.id, revision: value.revision,
        notes: value.notes, tags: value.tags.slice() }, 'save');
    } catch { return unavailable(); }
  },
  regenerate: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'id,revision' || !validId(value.id) || !validId(value.revision)) {
        return unavailable();
      }
      return await invoke('private-gallery-regenerate', { id: value.id, revision: value.revision }, 'regenerate');
    } catch { return unavailable(); }
  },
  cancelRegeneration: (...args) => {
    if (locked || pending !== 'regenerate' || cancellationSent || args.length !== 0) { return; }
    cancellationSent = true;
    try { ipcRenderer.send('private-gallery-cancel-regeneration'); } catch { /* Ownership may already have ended. */ }
  },
  lock: (...args) => {
    if (locked || args.length !== 0) { return; }
    locked = true;
    try { ipcRenderer.send('private-gallery-lock'); } catch { /* The owner may already be gone. */ }
  },
}));

contextBridge.exposeInMainWorld('privateCredentials', Object.freeze({
  touchIdStatus: async (...args) => args.length === 0
    ? invokeTouchId('private-credentials-touch-id-status', 'touchIdStatus') : { outcome: 'unavailable' },
  enableTouchId: async (...args) => {
    let request;
    try {
      if (locked) { return { outcome: 'unavailable' }; }
      request = args.length === 1 ? touchIdRequest(args[0]) : undefined;
      args.fill(undefined);
      if (!request) { return { outcome: 'unavailable' }; }
      return await invokeTouchId('private-credentials-touch-id-enable', 'enableTouchId', request);
    } catch { return { outcome: 'unavailable' }; }
    finally { args.fill(undefined); clearUnprotectedCopy(request); }
  },
  disableTouchId: async (...args) => args.length === 0
    ? invokeTouchId('private-credentials-touch-id-disable', 'disableTouchId') : { outcome: 'unavailable' },
  createUnprotectedCopy: async (...args) => {
    let request;
    try {
      if (locked) { return unavailable(); }
      request = args.length === 1 ? unprotectedCopyRequest(args[0]) : undefined;
      args.fill(undefined);
      if (!request) { return { status: 'invalid' }; }
      return await invoke('private-credentials-create-unprotected-copy', request, 'createUnprotectedCopy');
    } catch { return { status: 'invalid' }; }
    finally { args.fill(undefined); clearUnprotectedCopy(request); }
  },
  cancelUnprotectedCopy: (...args) => {
    if (locked || pending !== 'createUnprotectedCopy' || cancellationSent || args.length !== 0) { return; }
    cancellationSent = true;
    try { ipcRenderer.send('private-credentials-cancel-unprotected-copy'); } catch { /* Ownership may already have ended. */ }
  },
  changePassword: async (...args) => {
    let request;
    try {
      if (locked) { return unavailable(); }
      request = args.length === 1 ? passwordChange(args[0]) : undefined;
      args.fill(undefined);
      if (!request) { return { status: 'invalid' }; }
      return await invoke('private-credentials-change-password', request, 'changePassword');
    } catch { return { status: 'invalid' }; }
    finally { args.fill(undefined); clearPasswordChange(request); }
  },
}));
