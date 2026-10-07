'use strict';

// Standalone sandbox bridge: no general IPC, paths, keys, file or clipboard API.
const { contextBridge, ipcRenderer } = require('electron');
const unavailable = () => ({ status: 'unavailable' });
let locked = false;
let pending;
let cancellationSent = false;
let originalEpoch = 0;
let invocationEpoch = 0;
let importProgressPending = false;
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.exec(value)?.[0] === value;
const string = (value, limit) => typeof value === 'string' && value.length <= limit;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const autoLockMinutes = value => [0, 1, 5, 15, 30].includes(value);
const originalUrl = value => typeof value === 'string'
  && /^theatrum:\/\/app\/original\/[a-f0-9]{64}$/.exec(value)?.[0] === value;
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
      || !url(value.filmstripUrl, 'filmstrips', 'jpg')
      || typeof value.truncated !== 'boolean' || typeof value.editable !== 'boolean' || typeof value.regenerable !== 'boolean'
      || typeof value.refreshable !== 'boolean' || typeof value.playable !== 'boolean'
      || !validId(value.revision)) { return; }
    Object.assign(result, { notes: value.notes, clipUrl: value.clipUrl, posterUrl: value.posterUrl, filmstripUrl: value.filmstripUrl, truncated: value.truncated,
      editable: value.editable, regenerable: value.regenerable, refreshable: value.refreshable, playable: value.playable, revision: value.revision });
  }
  return result;
}
function sourceItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)
    || typeof value.title !== 'string' || /^Source folder (?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-6])$/.exec(value.title)?.[0] !== value.title
    || !Number.isSafeInteger(value.videoCount) || value.videoCount < 0 || value.videoCount > 100_000
    || typeof value.connected !== 'boolean') { return; }
  return { id: value.id, title: value.title, videoCount: value.videoCount, connected: value.connected };
}
function importCounts(value) {
  const { total, processed, imported, duplicates, failed } = value;
  if (![total, processed, imported, duplicates, failed].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 100)
    || total < 1 || processed !== imported + duplicates + failed || processed > total) { return; }
  return { total, processed, imported, duplicates, failed };
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
  if (mode === 'checkSource') {
    if (Array.isArray(value)) { return unavailable(); }
    const status = Object.getOwnPropertyDescriptor(value, 'status');
    if (!status || !Object.hasOwn(status, 'value') || !status.enumerable) { return unavailable(); }
    if (['cancelled', 'conflict', 'invalid', 'limit', 'wrong-folder', 'source-unavailable', 'busy', 'unavailable'].includes(status.value)) {
      return { status: status.value };
    }
    if (status.value !== 'checked') { return unavailable(); }
    const counts = {};
    for (const key of ['total', 'sameSize', 'differentSize', 'missing', 'unverified', 'ignored']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
        || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 10_000) { return unavailable(); }
      counts[key] = descriptor.value;
    }
    return counts.sameSize + counts.differentSize + counts.missing + counts.unverified + counts.ignored === counts.total
      ? { status: 'checked', ...counts } : unavailable();
  }
  if (mode === 'addSource') {
    const status = value.status;
    return !Array.isArray(value) && ['added', 'cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'source-unavailable', 'busy', 'unavailable'].includes(status)
      ? { status } : unavailable();
  }
  if (mode === 'resetPlaybackHistory') {
    if (Array.isArray(value)) { return unavailable(); }
    if (['unchanged', 'cancelled', 'busy', 'invalid', 'unavailable'].includes(value.status)) { return { status: value.status }; }
    return value.status === 'reset' && Number.isSafeInteger(value.count) && value.count >= 1 && value.count <= 100_000
      ? { status: 'reset', count: value.count } : unavailable();
  }
  if (mode === 'importVideo' || mode === 'scanSource' || mode === 'importProgress') {
    if (Array.isArray(value)) { return unavailable(); }
    const status = value.status;
    if (mode === 'importProgress' && ['idle', 'unavailable'].includes(status)) { return { status }; }
    if (['importVideo', 'scanSource'].includes(mode) && ['cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'nothing-new', 'scan-limit', 'source-unavailable', 'wrong-folder', 'busy', 'unavailable'].includes(status)) { return { status }; }
    const counts = importCounts(value);
    if (!counts) { return unavailable(); }
    if (mode === 'importProgress') { return status === 'running' ? { status, ...counts } : unavailable(); }
    const outcome = value.outcome;
    return status === 'finished' && ['completed', 'cancelled', 'stopped'].includes(outcome)
      && (outcome !== 'completed' || counts.processed === counts.total) ? { status, outcome, ...counts } : unavailable();
  }
  if (value.status === 'busy') { return { status: 'busy' }; }
  if (mode === 'playOriginal') {
    if (['cancelled', 'conflict', 'source-unavailable', 'wrong-folder', 'unsupported'].includes(value.status)) { return { status: value.status }; }
    return value.status === 'ready' && typeof value.url === 'string'
      && /^theatrum:\/\/app\/original\/[a-f0-9]{64}$/.exec(value.url)?.[0] === value.url
      ? { status: 'ready', url: value.url } : unavailable();
  }
  if (mode === 'relocateSource') {
    return ['relocated', 'cancelled', 'conflict', 'invalid', 'source-unavailable'].includes(value.status)
      ? { status: value.status } : unavailable();
  }
  if (mode === 'sources') {
    if (value.status !== 'ready' || !Array.isArray(value.items) || value.items.length > 256) { return unavailable(); }
    const items = value.items.map(sourceItem);
    return items.every(Boolean) && new Set(items.map(item => item.id)).size === items.length
      ? { status: 'ready', items } : unavailable();
  }
  if (mode === 'connectSource' || mode === 'disconnectSource') {
    const failures = mode === 'connectSource' ? ['cancelled', 'conflict', 'wrong-folder', 'source-unavailable'] : ['conflict'];
    if (failures.includes(value.status)) { return { status: value.status }; }
    const status = mode === 'connectSource' ? 'connected' : 'disconnected';
    const item = value.status === status ? sourceItem(value.item) : undefined;
    return item && item.connected === (mode === 'connectSource') ? { status, item } : unavailable();
  }
  if (mode === 'protection' || mode === 'setProtection') {
    const status = mode === 'protection' ? 'ready' : 'saved';
    return value.status === status && autoLockMinutes(value.autoLockMinutes)
      && (value.recordPlaybackHistory === undefined || typeof value.recordPlaybackHistory === 'boolean')
      ? { status, autoLockMinutes: value.autoLockMinutes, recordPlaybackHistory: value.recordPlaybackHistory === true } : unavailable();
  }
  if (mode === 'ackOriginalPlayback') {
    return ['recorded', 'disabled', 'ignored', 'conflict', 'invalid'].includes(value.status)
      ? { status: value.status } : unavailable();
  }
  if (mode === 'regenerate' || mode === 'refreshVideo') {
    if (['cancelled', 'conflict', 'source-unavailable', 'wrong-folder'].includes(value.status)
      || (mode === 'refreshVideo' && value.status === 'invalid')) { return { status: value.status }; }
    const status = mode === 'refreshVideo' ? 'refreshed' : 'generated';
    const generated = value.status === status ? item(value.item, true) : undefined;
    return generated ? { status, item: generated } : unavailable();
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
  invocationEpoch++;
  const playbackEpoch = originalEpoch;
  cancellationSent = false;
  try {
    // Electron copies invoke arguments synchronously. Release our owned password
    // references while the main process performs the slower credential work.
    const work = ipcRenderer.invoke(channel, ...(['protection', 'sources', 'addSource'].includes(mode) ? [] : [argument]));
    if (mode === 'changePassword') { clearPasswordChange(argument); argument = undefined; }
    if (mode === 'createUnprotectedCopy') { clearUnprotectedCopy(argument); argument = undefined; }
    const value = await work;
    if (locked) { return unavailable(); }
    if (mode === 'playOriginal' && playbackEpoch !== originalEpoch) { return { status: 'cancelled' }; }
    const result = response(value, mode);
    if (mode === 'changePassword' && result.status === 'changed') { locked = true; }
    return result;
  } catch { return unavailable(); }
  finally {
    if (mode === 'changePassword') { clearPasswordChange(argument); }
    if (mode === 'createUnprotectedCopy') { clearUnprotectedCopy(argument); }
    pending = undefined;
    invocationEpoch++;
  }
}
async function invokeTouchId(channel, mode, argument) {
  const unavailable = () => ({ outcome: 'unavailable' });
  if (locked || pending) { return unavailable(); }
  pending = mode;
  invocationEpoch++;
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
  sources: async (...args) => args.length === 0
    ? invoke('private-gallery-sources', undefined, 'sources') : unavailable(),
  addSource: async (...args) => args.length === 0
    ? invoke('private-gallery-add-source', undefined, 'addSource') : unavailable(),
  connectSource: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-connect-source', args[0], 'connectSource') : unavailable(),
  disconnectSource: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-disconnect-source', args[0], 'disconnectSource') : unavailable(),
  relocateSource: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-relocate-source', args[0], 'relocateSource') : unavailable(),
  importProgress: async (...args) => {
    if (args.length !== 0 || locked || importProgressPending || (pending && !['importVideo', 'scanSource'].includes(pending))) { return unavailable(); }
    const epoch = invocationEpoch;
    importProgressPending = true;
    try {
      const value = await ipcRenderer.invoke('private-gallery-import-progress');
      return !locked && epoch === invocationEpoch ? response(value, 'importProgress') : unavailable();
    } catch { return unavailable(); }
    finally { importProgressPending = false; }
  },
  checkSource: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-check-source', args[0], 'checkSource') : unavailable(),
  scanSource: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-scan-source', args[0], 'scanSource') : unavailable(),
  importVideo: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-import-video', args[0], 'importVideo') : unavailable(),
  cancelImport: (...args) => {
    if (locked || !['importVideo', 'scanSource'].includes(pending) || cancellationSent || args.length !== 0) { return; }
    cancellationSent = true;
    try { ipcRenderer.send('private-gallery-cancel-import'); } catch { /* Ownership may already have ended. */ }
  },
  cancelSourceConnection: (...args) => {
    if (locked || !['connectSource', 'relocateSource', 'addSource', 'checkSource'].includes(pending) || cancellationSent || args.length !== 0) { return; }
    cancellationSent = true;
    try { ipcRenderer.send('private-gallery-cancel-source-connection'); } catch { /* Ownership may already have ended. */ }
  },
  protection: async (...args) => args.length === 0
    ? invoke('private-gallery-protection', undefined, 'protection') : unavailable(),
  setProtection: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
        || Reflect.ownKeys(value).some(key => !['autoLockMinutes', 'recordPlaybackHistory'].includes(key))) { return unavailable(); }
      const property = Object.getOwnPropertyDescriptor(value, 'autoLockMinutes');
      const history = Object.getOwnPropertyDescriptor(value, 'recordPlaybackHistory');
      if (!property || !property.enumerable || !Object.hasOwn(property, 'value') || !autoLockMinutes(property.value)
        || (history && (!history.enumerable || !Object.hasOwn(history, 'value') || typeof history.value !== 'boolean'))) { return unavailable(); }
      return await invoke('private-gallery-set-protection', { autoLockMinutes: property.value,
        ...(history ? { recordPlaybackHistory: history.value } : {}) }, 'setProtection');
    } catch { return unavailable(); }
  },
  list: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) { return unavailable(); }
      const keys = Reflect.ownKeys(value);
      if (!keys.includes('query') || !keys.includes('offset')
        || keys.some(key => !['query', 'offset', 'collection', 'sort', 'direction'].includes(key))) { return unavailable(); }
      const request = {};
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property || !Object.hasOwn(property, 'value')) { return unavailable(); }
        request[key] = property.value;
      }
      if (!string(request.query, 200) || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 100_000
        || request.offset % 48 !== 0 || (Object.hasOwn(request, 'collection') && !['all', 'favourites', 'recent'].includes(request.collection))
        || (Object.hasOwn(request, 'sort') && !['catalogue', 'name', 'date-added', 'last-played', 'rating', 'duration', 'file-size'].includes(request.sort))
        || (Object.hasOwn(request, 'direction') && !['asc', 'desc'].includes(request.direction))) { return unavailable(); }
      return await invoke('private-gallery-list', request, 'list');
    } catch { return unavailable(); }
  },
  detail: async (...args) => args.length === 1 && validId(args[0])
    ? invoke('private-gallery-detail', args[0], 'detail') : unavailable(),
  save: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) { return unavailable(); }
      const keys = Reflect.ownKeys(value);
      if (!['id', 'notes', 'revision', 'tags'].every(key => keys.includes(key))
        || keys.some(key => !['id', 'notes', 'revision', 'tags', 'rating'].includes(key))) { return unavailable(); }
      const request = {};
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) { return unavailable(); }
        request[key] = property.value;
      }
      if (!validId(request.id) || !validId(request.revision) || !string(request.notes, 65_536)
        || (Object.hasOwn(request, 'rating') && (!Number.isInteger(request.rating) || request.rating < 0 || request.rating > 5))
        || !Array.isArray(request.tags)) { return unavailable(); }
      const length = Object.getOwnPropertyDescriptor(request.tags, 'length')?.value;
      if (!Number.isInteger(length) || length < 0 || length > 128 || Reflect.ownKeys(request.tags).length !== length + 1) { return unavailable(); }
      const tags = [];
      for (let index = 0; index < length; index++) {
        const property = Object.getOwnPropertyDescriptor(request.tags, String(index));
        if (!property?.enumerable || !Object.hasOwn(property, 'value') || !string(property.value, 512)) { return unavailable(); }
        tags.push(property.value);
      }
      request.tags = tags;
      return await invoke('private-gallery-save', request, 'save');
    } catch { return unavailable(); }
  },
  playOriginal: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) { return unavailable(); }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 2 || !keys.includes('id') || !keys.includes('revision')) { return unavailable(); }
      const id = Object.getOwnPropertyDescriptor(value, 'id');
      const revision = Object.getOwnPropertyDescriptor(value, 'revision');
      if (!id || !revision || !Object.hasOwn(id, 'value') || !Object.hasOwn(revision, 'value')
        || !validId(id.value) || !validId(revision.value)) { return unavailable(); }
      return await invoke('private-gallery-play-original', { id: id.value, revision: revision.value }, 'playOriginal');
    } catch { return unavailable(); }
  },
  stopOriginal: (...args) => {
    if (locked || args.length !== 0) { return; }
    originalEpoch++;
    try { ipcRenderer.send('private-gallery-stop-original'); } catch { /* The owner may already be gone. */ }
  },
  ackOriginalPlayback: async (...args) => args.length === 1 && originalUrl(args[0])
    ? invoke('private-gallery-ack-original-playback', args[0], 'ackOriginalPlayback') : unavailable(),
  resetPlaybackHistory: async (...args) => args.length === 1 && ['lastPlayed', 'timesPlayed'].includes(args[0])
    ? invoke('private-gallery-reset-playback-history', args[0], 'resetPlaybackHistory') : unavailable(),
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
  refreshVideo: async (...args) => {
    try {
      const value = args[0];
      if (args.length !== 1 || !value || typeof value !== 'object' || Array.isArray(value)) { return unavailable(); }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 2 || !keys.includes('id') || !keys.includes('revision')) { return unavailable(); }
      const id = Object.getOwnPropertyDescriptor(value, 'id');
      const revision = Object.getOwnPropertyDescriptor(value, 'revision');
      if (!id?.enumerable || !revision?.enumerable || !Object.hasOwn(id, 'value') || !Object.hasOwn(revision, 'value')
        || !validId(id.value) || !validId(revision.value)) { return unavailable(); }
      return await invoke('private-gallery-refresh-video', { id: id.value, revision: revision.value }, 'refreshVideo');
    } catch { return unavailable(); }
  },
  cancelRegeneration: (...args) => {
    if (locked || !['regenerate', 'refreshVideo'].includes(pending) || cancellationSent || args.length !== 0) { return; }
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
