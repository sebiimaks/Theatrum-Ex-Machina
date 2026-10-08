/* Native-only synthetic fixture. The parent harness controls all paths and IPC. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, Menu, powerMonitor, protocol, session } = require('electron');
const { createHash, randomBytes } = require('node:crypto');
const { deflateSync } = require('node:zlib');

const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const fixture = argument('--private-browser-fixture');
const phase = argument('--private-browser-phase');
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.isAbsolute(fixture) && path.dirname(fixture) === path.join(repository, 'tmp'));
assert.ok(fs.realpathSync(fixture) === fixture && ['initial', 'restart'].includes(phase));
const profile = path.join(fixture, 'profile');
// Synchronous and before app readiness: no fixture Chromium profile, logs,
// downloads, crash reports, or temporary files may use the user's app data.
for (const [key, folder] of [
  ['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data'],
  ['temp', 'temporary'], ['crashDumps', 'crash-dumps'], ['logs', 'logs'], ['downloads', 'downloads'],
]) {
  const target = path.join(profile, folder);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(key, target);
}
app.on('window-all-closed', () => undefined);
protocol.registerSchemesAsPrivileged([{ scheme: 'theatrum', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);

require('ts-node').register({ project: path.join(repository, 'tsconfig.persistence-tests.json'),
  transpileOnly: true, preferTsExts: true, compilerOptions: { module: 'commonjs', target: 'es2022' } });
const { PRIVATE_HUB_HEADER_FILE, PrivateHubStore } = require('./private-hub-store.ts');
const { changePrivateHubPassword, unlockPrivateHub, validatePrivateHubHeader } = require('./private-hub-crypto.ts');
const { PrivateHubSession } = require('./private-hub-session.ts');
const { PrivateHubBrowser } = require('./private-hub-browser.ts');
const { PrivateSourcePlayback } = require('./private-source-playback.ts');
const { createPrivateHubWorkspace, PrivateHubWorkspace } = require('./private-hub-workspace.ts');
const { PrivateHubOpenCoordinator } = require('./private-hub-open.ts');
const { writePrivateHubCatalogue, writePrivateHubPreview, readPrivateHubPreview } = require('./private-hub-catalogue.ts');
const { readPrivatePreviewSet } = require('./private-hub-preview-set.ts');
const { validatePrivateJpeg } = require('./private-preview-plan.ts');
const { performance } = require('node:perf_hooks');
const { NewImageElement } = require('../interfaces/final-object.interface.ts');
const { getMediaToolPath } = require('./media-tool-paths.ts');

let stage = 'configuration';
function setStage(name) {
  stage = name;
  if (process.connected) { process.send({ type: 'progress', stage: name }); }
}
let capsule;
let hub;
let workspace;
let configuration;
let seededFilmstripPattern;
let ordinaryMenu;
let privateMenuObservations = 0;
let restoredMenuObservations = 0;
const messages = new Map();
process.on('message', message => {
  if (message?.type === 'configuration') {
    configuration = message;
    messages.get('configuration')?.(message);
  } else if (message?.type === 'continue') { messages.get(message.stage)?.(); }
});
const configured = () => configuration ? Promise.resolve(configuration)
  : new Promise(resolve => messages.set('configuration', resolve));
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function checkpoint(name, checks, previewPatterns) {
  const continued = new Promise(resolve => messages.set(name, resolve));
  await send({ type: 'checkpoint', stage: name, checks, previewPatterns });
  await continued;
  messages.delete(name);
}
function currentWindow() {
  const windows = BrowserWindow.getAllWindows();
  assert.equal(windows.length, 1);
  return windows[0];
}
const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);

function installOrdinaryMenu() {
  ordinaryMenu = Menu.buildFromTemplate([
    { label: 'Synthetic ordinary application', submenu: [{ label: 'Ordinary action', click: () => undefined }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ]);
  Menu.setApplicationMenu(ordinaryMenu);
  assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
}
function assertPrivateMenu() {
  const active = Menu.getApplicationMenu();
  assert.ok(active && active !== ordinaryMenu, 'A private window must replace the ordinary application menu.');
  const walk = menu => menu.items.flatMap(item => [item, ...(item.submenu ? walk(item.submenu) : [])]);
  const items = walk(active);
  assert.deepEqual(active.items.map(item => item.label), ['Theatrum Ex Machina', 'Edit']);
  assert.deepEqual(items.filter(item => item.role).map(item => item.role).sort(), ['hide', 'quit']);
  assert.deepEqual(items.filter(item => item.id).map(item => item.id).sort(),
    ['private-native-close', 'private-native-paste', 'private-native-select-all']);
  assert.equal(active.getMenuItemById('private-native-paste').label, 'Paste password');
  assert.equal(active.getMenuItemById('private-native-select-all').label, 'Select all');
  assert.ok(['Cancel unlock', 'Lock hub'].includes(active.getMenuItemById('private-native-close').label));
  assert.ok(items.every(item => item.label !== 'Ordinary action'));
  privateMenuObservations++;
  return active;
}
function assertRestoredMenu() {
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(Menu.getApplicationMenu(), ordinaryMenu, 'Only clean private teardown may restore the exact ordinary Menu instance.');
  restoredMenuObservations++;
}
async function clipboardBackstop(window, field, value, reveal = false) {
  window.show(); window.focus(); await delay(100);
  assertPrivateMenu();
  await evaluate(window, `(() => {
    if (!window.__nativeClipboardProbe) {
      const state = window.__nativeClipboardProbe = { events: [], keys: 0 };
      // This fixture-only bubbling backstop always blocks clipboard export,
      // even if the production capture listener is missing or regresses.
      for (const type of ['copy', 'cut']) document.addEventListener(type, event => {
        state.events.push({ type, preventedBeforeBackstop: event.defaultPrevented });
        event.preventDefault();
      });
      document.addEventListener('keydown', event => {
        const key = event.key.toLowerCase();
        if (((event.metaKey || event.ctrlKey) && ['c', 'x', 'insert'].includes(key))
          || (event.shiftKey && key === 'delete')) state.keys++;
      });
    }
    const input = document.getElementById(${JSON.stringify(field)});
    input.value = ${JSON.stringify(value)};
    ${reveal ? "if (input.type === 'password') document.getElementById('show-password').click();" : ''}
    input.focus(); input.setSelectionRange(0, input.value.length);
    window.__nativeClipboardProbe.events = []; window.__nativeClipboardProbe.keys = 0;
  })()`);
  // No clipboard contents are read, written, or supplied by this fixture.
  // Electron dispatches real edit commands; the backstop makes both fail safe.
  window.webContents.copy();
  await waitForRenderer(window, "window.__nativeClipboardProbe.events.some(event => event.type === 'copy')");
  await evaluate(window, `document.getElementById(${JSON.stringify(field)}).select(); true`);
  window.webContents.cut();
  await waitForRenderer(window, "window.__nativeClipboardProbe.events.some(event => event.type === 'cut')");
  const commands = await evaluate(window, `({ events: window.__nativeClipboardProbe.events,
    unchanged: document.getElementById(${JSON.stringify(field)}).value === ${JSON.stringify(value)} })`);
  assert.deepEqual(commands.events, [{ type: 'copy', preventedBeforeBackstop: true }, { type: 'cut', preventedBeforeBackstop: true }]);
  assert.equal(commands.unchanged, true);
  const native = [];
  const observe = (event, input) => {
    if (input.type === 'keyDown') native.push({ prevented: event.defaultPrevented === true });
  };
  window.webContents.on('before-input-event', observe);
  try {
    const modifier = process.platform === 'darwin' ? 'meta' : 'control';
    for (const [keyCode, modifiers] of [['C', [modifier]], ['X', [modifier]], ['Insert', ['control']], ['Delete', ['shift']]]) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
    for (let index = 0; index < 100 && native.length < 4; index++) await delay(10);
    assert.equal(native.length, 4);
    assert.ok(native.every(event => event.prevented), 'Clipboard export shortcuts must be denied before reaching the DOM.');
    const keys = await evaluate(window, `({ keys: window.__nativeClipboardProbe.keys,
      unchanged: document.getElementById(${JSON.stringify(field)}).value === ${JSON.stringify(value)} })`);
    assert.deepEqual(keys, { keys: 0, unchanged: true });
  } finally { window.webContents.removeListener('before-input-event', observe); }
  return { copyPreventedInCapture: true, cutPreventedInCapture: true, cutKeptDraft: true,
    nativeExportShortcutsDenied: true, userClipboardUntouched: true };
}
async function syntheticPaste(window, field, expectedPrevented) {
  const result = await evaluate(window, `(() => {
    const input = document.getElementById(${JSON.stringify(field)}); input.focus();
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    input.dispatchEvent(event); return event.defaultPrevented;
  })()`);
  assert.equal(result, expectedPrevented);
}
async function waitForRenderer(window, expression, attempts = 500) {
  for (let index = 0; index < attempts; index++) {
    if (await evaluate(window, expression)) { return; }
    await delay(10);
  }
  throw new Error('Synthetic gallery state did not become ready.');
}

async function enterVideoFullscreen(window, name) {
  setStage('gallery-fullscreen-' + name);
  window.show(); window.focus();
  await delay(100);
  let entered = false;
  let nativeEntered = window.isFullScreen();
  const nativeListener = () => { nativeEntered = true; };
  window.once('enter-full-screen', nativeListener);
  const listener = () => { entered = true; };
  window.webContents.once('enter-html-full-screen', listener);
  try {
    const result = await evaluate(window, `(async () => {
      const video = document.getElementById('preview-video'); video.pause();
      try { await video.requestFullscreen(); return { entered: document.fullscreenElement === video }; }
      catch (error) { return { entered: false, error: error.name }; }
    })()`);
    assert.deepEqual(result, { entered: true });
    await waitForRenderer(window, `(() => { const video = document.getElementById('preview-video');
      const box = video.getBoundingClientRect();
      return document.fullscreenElement === video && box.left === 0 && box.top === 0
        && box.width >= innerWidth - 1 && box.height >= innerHeight - 1; })()`);
    assert.equal(entered, true);
    for (let index = 0; !nativeEntered && index < 500; index++) { await delay(10); }
    assert.equal(nativeEntered, true); assert.equal(window.isFullScreen(), true);
    window.focus(); await delay(100);
  } finally { window.webContents.removeListener('enter-html-full-screen', listener); window.removeListener('enter-full-screen', nativeListener); }
}
async function leaveVideoFullscreen(window, trigger) {
  let nativeExited = false;
  const listener = () => { nativeExited = true; };
  window.once('leave-full-screen', listener);
  try {
    await trigger();
    await waitForRenderer(window, "!document.fullscreenElement");
    for (let index = 0; !nativeExited && index < 500; index++) { await delay(10); }
    assert.equal(nativeExited, true); assert.equal(window.isFullScreen(), false);
  } finally { window.removeListener('leave-full-screen', listener); }
}
async function escapeVideoFullscreen(window) {
  setStage('gallery-fullscreen-escape');
  await leaveVideoFullscreen(window, async () => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  });
  assert.equal(await evaluate(window, "!document.getElementById('details-panel').hidden && document.getElementById('preview-video').hasAttribute('src')"), true);
}

async function passwordPrompt(password) {
  const controller = new AbortController();
  let failure;
  const prompting = PrivateHubBrowser.requestPassword({ signal: controller.signal, isCurrent: () => true, visible: false });
  void prompting.catch(error => { failure = error; });
  let window;
  for (let index = 0; index < 300; index++) {
    if (failure) { throw failure; }
    window = BrowserWindow.getAllWindows()[0];
    if (window && !window.isDestroyed()) {
      try {
        if (await evaluate(window, "document.readyState === 'complete' && !!window.privateUnlock && !!document.getElementById('password')")) { break; }
      } catch { /* The initial document may still be loading. */ }
    }
    window = undefined;
    await delay(10);
  }
  assert.ok(window, 'Credential window did not become ready.');
  assertPrivateMenu();
  const isolated = window.webContents.session;
  assert.equal(isolated.isPersistent(), false);
  assert.equal(isolated.storagePath, null);
  assert.notEqual(isolated, session.defaultSession);
  const surface = await evaluate(window, `({
    methods: Object.keys(window.privateUnlock).sort(), ordinary: typeof window.theatrum,
    node: typeof window.require, process: typeof window.process,
    masked: document.getElementById('password').type === 'password',
    overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
  })`);
  assert.deepEqual(surface, { methods: ['cancel', 'submit', 'touchIdAvailable', 'useTouchId'], ordinary: 'undefined', node: 'undefined', process: 'undefined', masked: true, overflow: false });
  // Retained review image contains only an empty synthetic credential form.
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(repository, 'tmp', 'private-unlock-review.png'), screenshot.toPNG());
  setStage('password-clipboard');
  const clipboard = await clipboardBackstop(window, 'password', password, true);
  await syntheticPaste(window, 'password', false);
  await evaluate(window, "document.getElementById('show-password').click(); true");
  await syntheticPaste(window, 'password', false);
  await syntheticPaste(window, 'cancel', true);
  await evaluate(window, `(() => {
    const input = document.getElementById('password'); input.value = ${JSON.stringify(password)};
    document.getElementById('show-password').click();
    const revealed = input.type === 'text' && document.getElementById('show-password').getAttribute('aria-pressed') === 'true';
    document.getElementById('show-password').click();
    if (!revealed || input.type !== 'password') throw new Error('Synthetic visibility check failed.');
  })()`);
  setStage('password-entry');
  await checkpoint('password-entry', { surface, clipboard, credentialPasteAllowed: true, nonCredentialPasteDenied: true,
    restrictedApplicationMenu: true, persistent: false, cacheBytes: await isolated.getCacheSize() });
  setStage('password-submit');
  // Destroying the prompt can retire executeJavaScript's context before its
  // response arrives. The credential promise is the authoritative outcome.
  void evaluate(window, "document.getElementById('unlock-form').requestSubmit(); true").catch(() => undefined);
  assert.equal(await prompting, password);
  assert.equal(window.isDestroyed(), true);
  assert.equal(await isolated.getCacheSize(), 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assertRestoredMenu();
  await checkpoint('password-submitted', { destroyed: true, originalMenuRestored: true, cacheBytes: 0 });

  setStage('password-cancel-opening');
  const cancelling = PrivateHubBrowser.requestPassword({ signal: controller.signal, isCurrent: () => true, visible: false,
    touchIdAvailable: async () => true });
  void cancelling.catch(error => { failure = error; });
  let reopened;
  for (let index = 0; index < 300; index++) {
    if (failure) { throw failure; }
    reopened = BrowserWindow.getAllWindows()[0];
    if (reopened && !reopened.isDestroyed()) {
      try { if (await evaluate(reopened, "document.readyState === 'complete' && !!window.privateUnlock")) { break; } } catch { /* Wait for the document. */ }
    }
    reopened = undefined; await delay(10);
  }
  assert.ok(reopened);
  assertPrivateMenu();
  assert.notEqual(reopened.webContents.session, isolated);
  assert.equal(await evaluate(reopened, "document.getElementById('password').value"), '');
  setStage('touch-id-unlock-layout');
  await waitForRenderer(reopened, "!document.getElementById('use-touch-id').hidden && !document.getElementById('use-touch-id').disabled");
  reopened.show(); reopened.focus(); await delay(100);
  const touchIdLayout = await evaluate(reopened, `(() => {
    const button = document.getElementById('use-touch-id').getBoundingClientRect();
    const unlock = document.getElementById('unlock').getBoundingClientRect();
    return { overflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
      actionsVisible: button.top >= 0 && unlock.bottom <= innerHeight };
  })()`);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-touch-id-unlock-review.png'), (await reopened.webContents.capturePage()).toPNG());
  assert.equal(touchIdLayout.overflow, false);
  assert.equal(touchIdLayout.actionsVisible, true);
  setStage('password-cancel');
  void evaluate(reopened, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true").catch(() => undefined);
  assert.equal(await cancelling, undefined);
  assert.equal(reopened.isDestroyed(), true);
  assertRestoredMenu();
  await checkpoint('password-cancelled', { destroyed: true, freshPartition: true, originalMenuRestored: true, syntheticTouchIdChoiceAvailable: true, touchIdUnlockFits: true });
}

async function completeWorkspacePrompt(opening, password) {
  let outcome;
  void opening.then(value => { outcome = value; });
  let prompt;
  for (let index = 0; index < 300; index++) {
    assert.equal(outcome, undefined, 'Opening ended before credential entry.');
    prompt = BrowserWindow.getAllWindows()[0];
    if (prompt && !prompt.isDestroyed()) {
      try { if (await evaluate(prompt, "document.readyState === 'complete' && !!window.privateUnlock")) { break; } } catch { /* Initial navigation. */ }
    }
    prompt = undefined; await delay(10);
  }
  assert.ok(prompt);
  assertPrivateMenu();
  void evaluate(prompt, `document.getElementById('password').value = ${JSON.stringify(password)};
    document.getElementById('unlock-form').requestSubmit(); true`).catch(() => undefined);
  return opening;
}

async function sourceFoldersAcceptance(window, directory, sourceRoot) {
  setStage('gallery-source-folders');
  const fingerprint = folder => Object.fromEntries(fs.readdirSync(folder).sort().map(name => {
    const filename = path.join(folder, name);
    const stat = fs.lstatSync(filename, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return [name, [stat.ino.toString(), stat.size.toString(), stat.mtimeNs.toString(),
      createHash('sha256').update(fs.readFileSync(filename)).digest('hex')]];
  }));
  const catalogueBefore = fingerprint(directory);
  const sourceBefore = fingerprint(sourceRoot);
  const nativePicker = dialog.showOpenDialog;
  let pickerMode = 'cancel';
  let releasePicker;
  let selections = 0;
  dialog.showOpenDialog = async (owner, selection) => {
    assert.equal(owner, window); assert.equal(selection.defaultPath, sourceRoot);
    assert.deepEqual(selection.properties, ['openDirectory', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(selection.securityScopedBookmarks, false);
    selections++;
    if (pickerMode === 'hold') { return new Promise(resolve => { releasePicker = resolve; }); }
    return { canceled: pickerMode === 'cancel', filePaths: pickerMode === 'cancel' ? [] : [sourceRoot] };
  };
  const connect = "document.querySelector('#source-folders-list [data-action=connect-source]')";
  const disconnect = "document.querySelector('#source-folders-list [data-action=disconnect-source]')";
  const waitReady = action => waitForRenderer(window, `${action} && !${action}.disabled`);
  const sourceState = async connected => {
    const response = await evaluate(window, 'window.privateGallery.sources()');
    assert.equal(response.status, 'ready');
    assert.equal(response.items.length, 1);
    assert.match(response.items[0].id, /^[a-f0-9]{32}$/);
    assert.deepEqual(Object.keys(response.items[0]).sort(), ['connected', 'id', 'title', 'videoCount']);
    assert.deepEqual({ ...response.items[0], id: undefined },
      { id: undefined, title: 'Source folder 1', videoCount: 50, connected });
    return response.items[0];
  };
  try {
    await evaluate(window, "document.getElementById('source-folders-toggle').click(); true");
    await waitReady(connect);
    await sourceState(false);
    assert.equal(await evaluate(window, "document.querySelectorAll('#source-folders-list .source-folder-row').length"), 1);
    assert.equal(selections, 0, 'Listing sources must not invoke the folder picker.');
    setStage('gallery-source-folders-cancel');
    await evaluate(window, `${connect}.click(); true`);
    await waitReady(connect);
    assert.equal(selections, 1);
    await sourceState(false);

    setStage('gallery-source-folders-late-picker');
    pickerMode = 'hold';
    await evaluate(window, `${connect}.click(); true`);
    for (let index = 0; index < 500 && !releasePicker; index++) { await delay(10); }
    assert.equal(typeof releasePicker, 'function');
    await waitForRenderer(window, "!document.getElementById('cancel-source-connection').hidden && !document.getElementById('cancel-source-connection').disabled");
    assert.equal(await evaluate(window, "document.getElementById('lock-hub').disabled"), false);
    await evaluate(window, "document.getElementById('cancel-source-connection').click(); true");
    // The OS dialog cannot be interrupted. Return a successful selection after
    // cancellation and verify that it cannot create a reusable source grant.
    await delay(25);
    releasePicker({ canceled: false, filePaths: [sourceRoot] });
    releasePicker = undefined;
    await waitReady(connect);
    await sourceState(false);

    setStage('gallery-source-folders-connect');
    pickerMode = 'grant';
    await evaluate(window, `${connect}.click(); true`);
    await waitReady(disconnect);
    await sourceState(true);
    await evaluate(window, `${disconnect}.click(); true`);
    await waitReady(connect);
    await sourceState(false);
    await evaluate(window, `${connect}.click(); true`);
    await waitReady(disconnect);
    await sourceState(true);

    setStage('gallery-source-folders-reconnect');
    const movedRoot = sourceRoot + '-temporarily-disconnected';
    const replacementRoot = sourceRoot + '-replacement-fixture';
    fs.renameSync(sourceRoot, movedRoot);
    fs.mkdirSync(sourceRoot);
    try {
      await evaluate(window, "document.getElementById('refresh-source-folders').click(); true");
      await waitReady(connect);
      await sourceState(false);
    } finally {
      // Preserve both disposable fixture directories; no real source tree is
      // removed. The original path is restored before explicit reconnection.
      fs.renameSync(sourceRoot, replacementRoot);
      fs.renameSync(movedRoot, sourceRoot);
    }
    const selectionsBeforeReconnect = selections;
    await evaluate(window, `${connect}.click(); true`);
    await waitReady(disconnect);
    await sourceState(true);
    assert.equal(selections, selectionsBeforeReconnect + 1, 'A replaced source requires another native selection.');
    assert.deepEqual(fingerprint(directory), catalogueBefore, 'Source connection controls must not rewrite encrypted catalogue records.');
    assert.deepEqual(fingerprint(sourceRoot), sourceBefore, 'Source connection controls must not change original files.');

    setStage('gallery-source-folders-small-window');
    const originalSize = window.getSize();
    window.show(); window.setSize(600, 400);
    await delay(100);
    const layout = await evaluate(window, `(() => {
      const panel = document.getElementById('source-folders-panel'); const rect = panel.getBoundingClientRect();
      const close = document.getElementById('close-source-folders').getBoundingClientRect();
      const row = panel.querySelector('.source-folder-row').getBoundingClientRect();
      const action = panel.querySelector('.source-folder-row button').getBoundingClientRect();
      const viewport = { left: rect.left + panel.clientLeft, top: rect.top + panel.clientTop,
        right: rect.left + panel.clientLeft + panel.clientWidth, bottom: rect.top + panel.clientTop + panel.clientHeight };
      const inside = value => value.width > 0 && value.height > 0 && value.left >= viewport.left
        && value.top >= viewport.top && value.right <= viewport.right && value.bottom <= viewport.bottom;
      return { visible: !panel.hidden, left: rect.left, right: rect.right, bottom: rect.bottom,
        width: innerWidth, height: innerHeight, closeTop: close.top, closeBottom: close.bottom,
        firstRowVisible: inside(row), firstActionVisible: inside(action),
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    fs.writeFileSync(path.join(repository, 'tmp', 'private-add-source-stage', 'source-layout.json'), JSON.stringify(layout));
    fs.writeFileSync(path.join(repository, 'tmp', 'private-add-source-stage', 'source-layout.png'), (await window.webContents.capturePage()).toPNG());
    assert.ok(layout.visible && layout.left >= 0 && layout.right <= layout.width
      && layout.bottom <= layout.height && layout.closeTop >= 0 && layout.closeBottom <= layout.height && !layout.overflow);
    assert.ok(layout.firstRowVisible && layout.firstActionVisible, 'The first source and its connection action must be visible without scrolling.');
    const refreshReachable = await evaluate(window, `(() => {
      const panel = document.getElementById('source-folders-panel');
      const refresh = document.getElementById('refresh-source-folders');
      refresh.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = panel.getBoundingClientRect(); const button = refresh.getBoundingClientRect();
      const reachable = !refresh.disabled && button.width > 0 && button.height > 0
        && button.left >= rect.left + panel.clientLeft && button.right <= rect.left + panel.clientLeft + panel.clientWidth
        && button.top >= rect.top + panel.clientTop && button.bottom <= rect.top + panel.clientTop + panel.clientHeight;
      panel.scrollTop = 0;
      return reachable;
    })()`);
    assert.equal(refreshReachable, true, 'The source refresh action must be reachable in the compact panel.');
    await evaluate(window, `${disconnect}.click(); true`);
    await waitReady(connect);
    pickerMode = 'hold';
    await evaluate(window, `${connect}.click(); true`);
    for (let index = 0; index < 500 && !releasePicker; index++) { await delay(10); }
    assert.equal(typeof releasePicker, 'function');
    const cancelReachable = await evaluate(window, `(() => {
      const panel = document.getElementById('source-folders-panel');
      const cancel = document.getElementById('cancel-source-connection');
      cancel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = panel.getBoundingClientRect(); const button = cancel.getBoundingClientRect();
      return !cancel.hidden && !cancel.disabled && button.width > 0 && button.height > 0
        && button.left >= rect.left + panel.clientLeft && button.right <= rect.left + panel.clientLeft + panel.clientWidth
        && button.top >= rect.top + panel.clientTop && button.bottom <= rect.top + panel.clientTop + panel.clientHeight;
    })()`);
    assert.equal(cancelReachable, true, 'Cancel connection must be reachable while a compact-window picker is pending.');
    await evaluate(window, "document.getElementById('cancel-source-connection').click(); true");
    releasePicker({ canceled: true, filePaths: [] });
    releasePicker = undefined;
    await waitReady(connect);
    pickerMode = 'grant';
    await evaluate(window, `${connect}.click(); true`);
    await waitReady(disconnect);
    await sourceState(true);
    await evaluate(window, "document.getElementById('source-folders-panel').scrollTop = 0; true");
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(repository, 'tmp', 'private-source-folders-small-review.png'), screenshot.toPNG());
    window.setSize(...originalSize);
    await evaluate(window, "document.getElementById('close-source-folders').click(); true");
    assert.equal(await evaluate(window, "document.getElementById('source-folders-panel').hidden"), true);
    return { sourceFoldersConnected: true, sourceFoldersDisconnected: true, sourceFoldersCancellationDiscardedLatePicker: true,
      sourceFoldersIdentityReplacementRevoked: true, sourceFoldersExplicitReconnect: true, sourceFoldersNoCatalogueWrite: true,
      sourceFoldersNoSourceWrite: true, sourceFoldersMinimumWindowFits: true,
      sourceFoldersFirstActionVisible: true, sourceFoldersRefreshReachable: true, sourceFoldersCancelReachable: true };
  } finally {
    releasePicker?.({ canceled: true, filePaths: [] });
    dialog.showOpenDialog = nativePicker;
  }
}

async function sourceRelocationAcceptance(window, directory, sourceRoot) {
  setStage('gallery-source-relocation');
  const newRoot = path.join(fixture, 'relocated-source');
  const emptyRoot = path.join(fixture, 'empty-relocation-source');
  fs.mkdirSync(newRoot); fs.mkdirSync(emptyRoot);
  for (const name of fs.readdirSync(sourceRoot)) { fs.copyFileSync(path.join(sourceRoot, name), path.join(newRoot, name)); }
  const nativePicker = dialog.showOpenDialog;
  const nativeConfirm = dialog.showMessageBox;
  let selected = emptyRoot;
  let confirmed = false;
  let confirmations = 0;
  let currentRoot = sourceRoot;
  const encryptedFingerprint = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
  const before = encryptedFingerprint();
  dialog.showOpenDialog = async (owner, selection) => {
    assert.equal(owner, window); assert.equal(selection.defaultPath, currentRoot);
    assert.deepEqual(selection.properties, ['openDirectory', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(selection.securityScopedBookmarks, false);
    return { canceled: false, filePaths: [selected] };
  };
  dialog.showMessageBox = async (owner, options) => {
    assert.equal(owner, window);
    assert.ok(JSON.stringify(options).includes(newRoot), 'Only the native confirmation identifies the new location.');
    assert.ok(JSON.stringify(options).includes('50'));
    confirmations++;
    const save = options.buttons.findIndex(label => label === 'Save location');
    assert.ok(save >= 0);
    return { response: confirmed ? save : options.cancelId, checkboxChecked: false };
  };
  const action = "document.querySelector('#source-folders-list [data-action=relocate-source]')";
  const ready = () => waitForRenderer(window, `${action} && !${action}.disabled && !document.getElementById('refresh-source-folders').disabled`);
  try {
    await evaluate(window, "document.getElementById('source-folders-toggle').click(); true");
    await ready();
    const beforeId = (await evaluate(window, 'window.privateGallery.sources()')).items[0].id;
    await evaluate(window, `${action}.click(); true`);
    await ready();
    assert.equal(confirmations, 0, 'Missing files must not reach location confirmation.');
    assert.deepEqual(encryptedFingerprint(), before);
    selected = newRoot;
    await evaluate(window, `${action}.click(); true`);
    await ready();
    assert.equal(confirmations, 1);
    assert.deepEqual(encryptedFingerprint(), before, 'Cancelled confirmation must not alter the catalogue.');
    confirmed = true;
    await evaluate(window, `${action}.click(); true`);
    await ready();
    assert.equal(confirmations, 2);
    const sources = await evaluate(window, 'window.privateGallery.sources()');
    assert.equal(sources.status, 'ready');
    assert.equal(sources.items[0].connected, false, 'Saved relocation requires a fresh session connection.');
    assert.notEqual(sources.items[0].id, beforeId, 'Relocation retires the old source identity.');
    assert.notDeepEqual(encryptedFingerprint(), before);
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(newRoot)})`), false);
    assert.deepEqual(fs.readdirSync(newRoot).sort(), fs.readdirSync(sourceRoot).sort());
    for (const name of fs.readdirSync(sourceRoot)) {
      assert.ok(fs.readFileSync(path.join(sourceRoot, name)).equals(fs.readFileSync(path.join(newRoot, name))));
    }
    // Connect explicitly, then let the existing generation test prove that the
    // saved new root and its grant are used without another native selection.
    currentRoot = newRoot;
    await evaluate(window, "document.querySelector('#source-folders-list [data-action=connect-source]').click(); true");
    await waitForRenderer(window, "document.querySelector('#source-folders-list [data-action=disconnect-source]') && !document.getElementById('refresh-source-folders').disabled");
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].connected, true);
    await evaluate(window, "document.getElementById('close-source-folders').click(); true");
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('details-panel').hidden && !document.getElementById('regenerate-previews').disabled");
    return { sourceRelocationMissingFilesRefused: true, sourceRelocationConfirmationCancelled: true,
      sourceRelocationSaved: true, sourceRelocationRetiredIds: true, sourceRelocationPathsMainOnly: true,
      sourceRelocationOriginalsUnchanged: true };
  } finally { dialog.showOpenDialog = nativePicker; dialog.showMessageBox = nativeConfirm; }
}

async function originalPlaybackAcceptance(window, directory) {
  setStage('gallery-original-playback');
  const sourceRoot = path.join(fixture, 'relocated-source');
  const fingerprint = root => Object.fromEntries(fs.readdirSync(root).sort().map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
  const sourceBefore = fingerprint(sourceRoot);
  let playback;
  const createResponse = PrivateSourcePlayback.prototype.createResponse;
  PrivateSourcePlayback.prototype.createResponse = function(request) {
    playback = this;
    return createResponse.call(this, request);
  };
  const catalogueBefore = fingerprint(directory);
  const savedNotes = await evaluate(window, "document.getElementById('details-notes').value");
  const nativePicker = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => { throw new Error('Existing source grant must be reused by original playback.'); };
  const start = async () => {
    await evaluate(window, "document.getElementById('play-original').click(); true");
    await waitForRenderer(window, "document.getElementById('preview-video').videoWidth === 32 && document.getElementById('preview-video').currentTime > 0 && document.getElementById('preview-video').currentSrc.includes('/original/')").catch(async error => {
      const state = await evaluate(window, `(() => { const v = document.getElementById('preview-video'); return {
        width: v.videoWidth, time: v.currentTime, error: v.error?.code, ready: v.readyState, network: v.networkState,
        paused: v.paused, startHidden: document.getElementById('play-original').hidden,
        startDisabled: document.getElementById('play-original').disabled, status: document.getElementById('playback-status').textContent }; })()`);
      fs.writeFileSync(path.join(fixture, 'original-diagnostics.json'), JSON.stringify(state)); throw error;
    });
    const url = await evaluate(window, "document.getElementById('preview-video').currentSrc");
    assert.match(url, /^theatrum:\/\/app\/original\/[a-f0-9]{64}$/);
    await evaluate(window, "document.getElementById('preview-video').pause(); true");
    // The optional history acknowledgement briefly serializes catalogue work.
    // Wait until navigation is available before testing Close/selection.
    await waitForRenderer(window, "!document.getElementById('gallery-search').disabled");
    return url;
  };
  const denied = async url => {
    // The gallery CSP deliberately denies JavaScript fetch. Inspect the same
    // captured manager in main without weakening that renderer restriction.
    await delay(20);
    assert.ok(playback);
    assert.equal((await playback.createResponse(new Request(url))).status, 404);
  };
  try {
    // Playback never saves unsaved metadata or updates played counters.
    await evaluate(window, `(() => { const notes = document.getElementById('details-notes');
      notes.value += ' unsaved playback draft'; notes.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const url = await start();
    setStage('gallery-original-range');
    assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), savedNotes + ' unsaved playback draft');
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(sourceRoot)})`), false);
    const response = await playback.createResponse(new Request(url, { headers: { Range: 'bytes=0-15' } }));
    const requested = { status: response.status, range: response.headers.get('Content-Range'),
      cache: response.headers.get('Cache-Control'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
    fs.writeFileSync(path.join(fixture, 'original-range.json'), JSON.stringify(requested));
    assert.equal(requested.status, 206); assert.match(requested.range, /^bytes 0-15\/\d+$/);
    assert.equal(requested.cache, 'private, no-store, max-age=0');
    assert.deepEqual(requested.bytes, [...fs.readFileSync(path.join(sourceRoot, 'synthetic-0.mp4')).subarray(0, 16)]);
    setStage('gallery-original-seek');
    await evaluate(window, "document.getElementById('preview-video').currentTime = 2; true");
    await waitForRenderer(window, "!document.getElementById('preview-video').seeking && document.getElementById('preview-video').currentTime >= 1.9");
    await enterVideoFullscreen(window, 'original');
    await escapeVideoFullscreen(window);
    setStage('gallery-original-compact');
    const originalSize = window.getSize(); window.setSize(600, 400); window.show();
    await delay(150);
    assert.equal(await evaluate(window, `(() => { const button = document.getElementById('stop-video'); button.scrollIntoView({ block: 'center' });
      const box = button.getBoundingClientRect(); return !button.disabled && !button.hidden && box.left >= 0 && box.right <= innerWidth
      && box.top >= 0 && box.bottom <= innerHeight && [box.top + 4, (box.top + box.bottom) / 2, box.bottom - 4]
        .every(y => button.contains(document.elementFromPoint((box.left + box.right) / 2, y))); })()`), true);
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(path.join(repository, 'tmp', 'private-original-playback-small-review.png'), screenshot.toPNG());
    window.setSize(...originalSize);
    await enterVideoFullscreen(window, 'stop');
    setStage('gallery-original-stop');
    await leaveVideoFullscreen(window, () => evaluate(window, "document.getElementById('stop-video').click(); true"));
    await denied(url);
    assert.equal(await evaluate(window, "document.getElementById('preview-video').hasAttribute('src')"), false);
    await evaluate(window, `(() => { const notes = document.getElementById('details-notes'); notes.value = ${JSON.stringify(savedNotes)};
      notes.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    setStage('gallery-original-close');
    const closingUrl = await start();
    await evaluate(window, "document.getElementById('close-details').click(); true");
    await denied(closingUrl);
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-original').hidden && !document.getElementById('play-original').disabled");
    setStage('gallery-original-selection');
    const selectionUrl = await start();
    await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
    await denied(selectionUrl);
    await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = 'coastal';
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-original').hidden && !document.getElementById('play-original').disabled");
    assert.deepEqual(fingerprint(sourceRoot), sourceBefore);
    assert.deepEqual(fingerprint(directory), catalogueBefore);
    return { originalVideoDecoded: true, originalVideoSeeked: true, originalStopRetired: true,
      originalSelectionRetired: true, originalCloseRetired: true, originalGrantReused: true, originalDraftPreserved: true,
      originalRangeVerified: true, originalMinimumWindowFits: true, originalFilesUnchanged: true, originalNoCatalogueWrite: true };
  } catch (error) {
    fs.writeFileSync(path.join(fixture, 'original-failure.json'), JSON.stringify({ stage, message: error?.message, stack: error?.stack }));
    throw error;
  } finally { dialog.showOpenDialog = nativePicker; PrivateSourcePlayback.prototype.createResponse = createResponse; }
}

async function manualImportAcceptance(window) {
  setStage('gallery-manual-import');
  const root = path.join(fixture, 'relocated-source');
  const original = fs.readdirSync(root).find(name => name.endsWith('.mp4'));
  const selected = path.join(root, 'Synthetic imported video.mp4');
  fs.copyFileSync(path.join(root, original), selected);
  const originalBytes = fs.readFileSync(selected);
  const nativePicker = dialog.showOpenDialog;
  let cancel = true;
  let picks = 0;
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, window); assert.equal(options.defaultPath, root);
    assert.equal(options.title, 'Add videos to private hub');
    assert.deepEqual(options.properties, ['openFile', 'multiSelections', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false);
    picks++;
    return cancel ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [selected] };
  };
  const action = "document.querySelector('#source-folders-list [data-action=import-video]')";
  const ready = () => waitForRenderer(window, `${action} && !${action}.disabled && !document.getElementById('refresh-source-folders').disabled`, 3000);
  try {
    await evaluate(window, "document.getElementById('source-folders-toggle').click(); true"); await ready();
    const oldSize = window.getSize(); window.setSize(600, 400); window.show(); await delay(100);
    const fit = await evaluate(window, `(() => { const b = ${action}; b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect(); const panel = document.getElementById('source-folders-panel'); const p = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.left >= p.left + panel.clientLeft && r.right <= p.left + panel.clientLeft + panel.clientWidth
        && r.top >= p.top + panel.clientTop && r.bottom <= p.top + panel.clientTop + panel.clientHeight
        && (hit === b || b.contains(hit)); })()`);
    assert.equal(fit, true);
    fs.writeFileSync(path.join(repository, 'tmp', 'private-import-stage', 'compact-import.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(...oldSize);
    const oldSource = (await evaluate(window, 'window.privateGallery.sources()')).items[0];
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(picks, 1);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].videoCount, 50);
    cancel = false;
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(picks, 2);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].videoCount, 51);
    assert.deepEqual(await evaluate(window, `window.privateGallery.importVideo(${JSON.stringify(oldSource.id)})`), { status: 'unavailable' });
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(picks, 3);
    assert.equal(await evaluate(window, "document.getElementById('source-folders-status').textContent"), 'Import complete. 0 added, 1 already in the catalogue, 0 failed, 0 not processed. Original videos are unchanged.');
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].videoCount, 51);
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(root)})`), false);
    await evaluate(window, "document.getElementById('close-source-folders').click(); true");
    await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = 'Synthetic imported video';
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic imported video'");
    await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "document.getElementById('details-title').textContent === 'Synthetic imported video'");
    await evaluate(window, "document.getElementById('play-preview').click(); true");
    await waitForRenderer(window, "document.getElementById('preview-video').videoWidth === 256 && document.getElementById('preview-video').currentTime > 0");
    assert.ok(fs.readFileSync(selected).equals(originalBytes));
    // Restore the previous synthetic selection for the fullscreen/lock checks.
    await evaluate(window, "document.getElementById('stop-video').click(); document.getElementById('close-details').click(); true");
    await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = 'coastal';
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic coastal clip'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
    return { importPickerCancelled: true, importAdded: true, importDuplicateRefused: true, importEncryptedPreviewDecoded: true,
      importOriginalUnchanged: true, importPathsMainOnly: true, importCompactControlsFit: true };
  } finally { dialog.showOpenDialog = nativePicker; originalBytes.fill(0); }
}

async function sourceAdditionAcceptance(window) {
  setStage('gallery-source-addition');
  const root = path.join(fixture, 'added-source');
  fs.mkdirSync(root);
  const name = 'Synthetic new folder video.mp4';
  const selected = path.join(root, name);
  fs.copyFileSync(path.join(fixture, 'relocated-source', 'Synthetic imported video.mp4'), selected);
  const originalBytes = fs.readFileSync(selected);
  const nativePicker = dialog.showOpenDialog;
  let mode = 'cancel'; let grants = 0; let additions = 0;
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, window); assert.equal(options.securityScopedBookmarks, false);
    assert.ok(options.properties.includes('dontAddToRecent'));
    if (options.title === 'Add source folder') {
      additions++;
      assert.deepEqual(options.properties, ['openDirectory', 'noResolveAliases', 'dontAddToRecent']);
      assert.equal(options.defaultPath, undefined);
      return mode === 'cancel' ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [mode === 'duplicate' ? path.join(fixture, 'relocated-source') : root] };
    }
    if (options.title === 'Allow source folder access') {
      grants++; assert.equal(options.defaultPath, root);
      return { canceled: false, filePaths: [root] };
    }
    assert.equal(options.title, 'Add videos to private hub'); assert.equal(options.defaultPath, root);
    return { canceled: false, filePaths: [selected] };
  };
  const ready = () => waitForRenderer(window, "!document.getElementById('add-source-folder').disabled && !document.getElementById('refresh-source-folders').disabled", 3000);
  const click = () => evaluate(window, "document.getElementById('add-source-folder').click(); true");
  try {
    await evaluate(window, "document.getElementById('source-folders-toggle').click(); true"); await ready();
    const old = (await evaluate(window, 'window.privateGallery.sources()')).items;
    assert.equal(old.length, 1); assert.equal(old[0].videoCount, 51);
    const size = window.getSize(); window.setSize(600, 400); window.show(); await delay(100);
    const fits = await evaluate(window, `(() => {
      const panel = document.getElementById('source-folders-panel'); const b = document.getElementById('add-source-folder');
      b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); const p = panel.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !b.disabled && r.width > 0 && r.left >= p.left + panel.clientLeft && r.right <= p.left + panel.clientLeft + panel.clientWidth
        && r.top >= p.top + panel.clientTop && r.bottom <= p.top + panel.clientTop + panel.clientHeight && (hit === b || b.contains(hit));
    })()`);
    assert.equal(fits, true);
    fs.writeFileSync(path.join(repository, 'tmp', 'private-add-source-stage', 'compact-source-addition.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(...size);
    await click(); await ready();
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items.length, 1);
    mode = 'duplicate'; await click(); await ready();
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items.length, 1);
    mode = 'new'; await click(); await ready();
    let sources = (await evaluate(window, 'window.privateGallery.sources()')).items;
    assert.equal(additions, 3); assert.equal(grants, 0);
    assert.equal(sources.length, 2); assert.equal(sources[1].videoCount, 0); assert.equal(sources[1].connected, false);
    assert.equal(sources[0].connected, true, 'Unrelated existing grants stay connected.');
    assert.notEqual(sources[0].id, old[0].id);
    assert.deepEqual(await evaluate(window, `window.privateGallery.connectSource(${JSON.stringify(old[0].id)})`), { status: 'unavailable' });
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(root)})`), false);
    const sourceRow = "document.querySelectorAll('#source-folders-list .source-folder-row')[1]";
    await evaluate(window, `${sourceRow}.querySelector('[data-action=import-video]').click(); true`); await ready();
    assert.equal(grants, 1, 'Importing from an added folder requires explicit session access.');
    sources = (await evaluate(window, 'window.privateGallery.sources()')).items;
    assert.equal(sources[1].videoCount, 1); assert.equal(sources[1].connected, true);
    assert.ok(fs.readFileSync(selected).equals(originalBytes));
    await evaluate(window, "document.getElementById('close-source-folders').click(); true");
    await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = 'Synthetic new folder video';
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic new folder video'");
    await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256");
    await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = 'coastal';
      input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic coastal clip'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
    return { sourceAdditionCancelled: true, sourceAdditionDuplicateRefused: true, sourceAdditionSavedDisconnected: true,
      sourceAdditionNoScan: true, sourceAdditionGrantRequired: true, sourceAdditionImportedVideo: true, sourceAdditionCompactFits: true };
  } finally { dialog.showOpenDialog = nativePicker; originalBytes.fill(0); }
}

async function batchImportAcceptance(window) {
  setStage('gallery-batch-import');
  const root = path.join(fixture, 'added-source');
  const existing = path.join(root, 'Synthetic new folder video.mp4');
  const first = path.join(root, 'Synthetic batch first.mp4');
  const second = path.join(root, 'Synthetic batch second.mp4');
  const corrupt = path.join(root, 'Synthetic invalid batch.mp4');
  const retained = path.join(root, 'Synthetic batch retained.mp4');
  const cancelled = path.join(root, 'Synthetic batch cancelled.mp4');
  const unstarted = path.join(root, 'Synthetic batch unstarted.mp4');
  for (const file of [first, second, retained, cancelled, unstarted]) { fs.copyFileSync(existing, file); }
  fs.writeFileSync(corrupt, 'This is a synthetic non-video fixture, not media bytes.');
  const fingerprint = folder => Object.fromEntries(fs.readdirSync(folder).sort().map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest('hex')]));
  const before = fingerprint(root);
  const nativePicker = dialog.showOpenDialog;
  const originalImport = PrivateHubSession.prototype.importVideo;
  let selected = [existing, corrupt, first, second];
  let calls = 0;
  let holdAt = 2;
  let release;
  let blocked;
  const barrier = () => {
    blocked = new Promise(resolve => { release = resolve; });
  };
  barrier();
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, window); assert.equal(options.defaultPath, root);
    assert.equal(options.title, 'Add videos to private hub');
    assert.deepEqual(options.properties, ['openFile', 'multiSelections', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false);
    return { canceled: false, filePaths: [...selected] };
  };
  // Test-only admission barrier: keep real encryption/decoders/session writes,
  // while making progress and between-file cancellation deterministic.
  PrivateHubSession.prototype.importVideo = async function (...args) {
    calls++;
    if (calls === holdAt) {
      const signal = args[3].signal;
      const cancelled = () => release();
      signal.addEventListener('abort', cancelled, { once: true });
      try { await blocked; } finally { signal.removeEventListener('abort', cancelled); }
    }
    return originalImport.apply(this, args);
  };
  const action = "document.querySelectorAll('#source-folders-list .source-folder-row')[1]?.querySelector('[data-action=import-video]')";
  const ready = () => waitForRenderer(window, `${action} && !${action}.disabled && !document.getElementById('refresh-source-folders').disabled`, 5000);
  const progress = () => evaluate(window, 'window.privateGallery.importProgress()');
  const waitForAdmission = async () => {
    for (let index = 0; index < 500 && calls < holdAt; index++) { await delay(10); }
    assert.equal(calls, holdAt);
  };
  try {
    setStage('gallery-batch-open');
    await evaluate(window, "document.getElementById('source-folders-toggle').click(); true"); await ready();
    assert.deepEqual(await progress(), { status: 'idle' });
    const size = window.getSize(); window.setSize(600, 400); window.show(); await delay(120);
    setStage('gallery-batch-progress');
    await evaluate(window, `${action}.click(); true`);
    await waitForRenderer(window, "window.privateGallery.importProgress().then(p => p.status === 'running' && p.processed === 2)", 5000);
    assert.deepEqual(await progress(), { status: 'running', total: 4, processed: 2, imported: 0, duplicates: 1, failed: 1 });
    await waitForAdmission();
    await waitForRenderer(window, "document.getElementById('source-folders-status').textContent.includes('2 of 4 processed')");
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(root)})`), false);
    setStage('gallery-batch-compact');
    const cancelFits = await evaluate(window, `(() => {
      const button = document.getElementById('cancel-video-import');
      const panel = document.getElementById('source-folders-panel'); const p = panel.getBoundingClientRect(); const r = button.getBoundingClientRect();
      const status = document.getElementById('source-folders-status').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !button.disabled && !button.hidden && r.width > 0 && r.left >= p.left + panel.clientLeft
        && r.right <= p.left + panel.clientLeft + panel.clientWidth && r.top >= p.top + panel.clientTop
        && r.bottom <= p.top + panel.clientTop + panel.clientHeight && (hit === button || button.contains(hit))
        && status.width > 0 && status.left >= p.left + panel.clientLeft && status.right <= p.left + panel.clientLeft + panel.clientWidth
        && status.top >= p.top + panel.clientTop && status.bottom <= p.top + panel.clientTop + panel.clientHeight;
    })()`);
    assert.equal(cancelFits, true, 'Progress and Cancel must be visible automatically after starting a compact-window import.');
    await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await delay(120);
    fs.mkdirSync(path.join(repository, 'tmp', 'private-batch-import-stage'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'tmp', 'private-batch-import-stage', 'compact-batch-progress.png'),
      (await window.webContents.capturePage()).toPNG());
    window.setSize(...size);
    release(); await ready();
    assert.equal(calls, 3);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[1].videoCount, 3);
    assert.deepEqual(await progress(), { status: 'idle' });
    const completed = await evaluate(window, "document.getElementById('source-folders-status').textContent");
    assert.match(completed, /2 added/); assert.match(completed, /1 already/); assert.match(completed, /1 failed/);
    assert.match(completed, /0 not processed/);
    setStage('gallery-batch-cancel');
    selected = [retained, cancelled, unstarted]; calls = 0; holdAt = 2; barrier();
    await evaluate(window, `${action}.click(); true`);
    await waitForRenderer(window, "window.privateGallery.importProgress().then(p => p.status === 'running' && p.processed === 1)", 5000);
    assert.deepEqual(await progress(), { status: 'running', total: 3, processed: 1, imported: 1, duplicates: 0, failed: 0 });
    await waitForAdmission();
    await evaluate(window, "document.getElementById('cancel-video-import').click(); true"); await ready();
    assert.equal(calls, 2, 'No later candidate may be admitted after cancellation.');
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[1].videoCount, 4);
    assert.deepEqual(await progress(), { status: 'idle' });
    const stopped = await evaluate(window, "document.getElementById('source-folders-status').textContent");
    assert.match(stopped, /cancelled/i); assert.match(stopped, /1 added/); assert.match(stopped, /2 not processed/);
    assert.deepEqual(fingerprint(root), before);
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(root)})`), false);
    await evaluate(window, "document.getElementById('close-source-folders').click(); true");
    const search = async text => {
      await evaluate(window, `(() => { const input = document.getElementById('gallery-search'); input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    await search('Synthetic batch');
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 3");
    await waitForRenderer(window, "[...document.querySelectorAll('#gallery-grid .video-card img')].every(i => i.naturalWidth === 256)");
    assert.deepEqual((await evaluate(window, "[...document.querySelectorAll('#gallery-grid .video-title')].map(n => n.textContent)")).sort(),
      ['Synthetic batch first', 'Synthetic batch retained', 'Synthetic batch second']);
    await search('coastal');
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic coastal clip'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
    return { batchMixedResultsCounted: true, batchProgressBounded: true, batchCancellationRetainedCompleted: true,
      batchCancellationStoppedLaterFiles: true, batchEncryptedThumbnailsDecoded: true, batchOriginalsUnchanged: true,
      batchPathsMainOnly: true, batchCompactProgressFits: true };
  } finally { release(); dialog.showOpenDialog = nativePicker; PrivateHubSession.prototype.importVideo = originalImport; }
}

async function sourceScanAcceptance(window, directory) {
  setStage('gallery-source-scan');
  const root = path.join(fixture, 'relocated-source');
  const seed = path.join(root, 'Synthetic imported video.mp4');
  const nested = path.join(root, 'Nested');
  const ignored = path.join(root, 'Ignored');
  const previews = path.join(root, 'vha-synthetic-previews');
  const outside = path.join(fixture, 'scan-outside');
  for (const folder of [nested, ignored, previews, outside]) { fs.mkdirSync(folder); }
  fs.copyFileSync(seed, path.join(root, 'Synthetic scanned root.mp4'));
  fs.copyFileSync(seed, path.join(nested, 'Synthetic scanned nested.MP4'));
  fs.copyFileSync(seed, path.join(ignored, 'Ignored video.mp4'));
  fs.copyFileSync(seed, path.join(previews, 'Generated video.mp4'));
  fs.copyFileSync(seed, path.join(outside, 'Linked video.mp4'));
  fs.symlinkSync(path.join(outside, 'Linked video.mp4'), path.join(root, 'Linked file.mp4'));
  fs.symlinkSync(outside, path.join(root, 'Linked folder'));
  fs.writeFileSync(path.join(root, 'Not a video.txt'), 'Synthetic non-video');
  const fingerprint = folder => Object.fromEntries(fs.readdirSync(folder).sort().map(name => {
    const file = path.join(folder, name); const stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory()
      ? fingerprint(file) : createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
  const originals = fingerprint(root); const encrypted = fingerprint(directory);
  const oldPicker = dialog.showOpenDialog; const oldConfirmation = dialog.showMessageBox;
  let mode = 'decline'; let confirmations = 0; let release = () => {};
  dialog.showOpenDialog = async () => { throw new Error('Discovery must reuse the existing root grant without a file picker.'); };
  dialog.showMessageBox = async (owner, options) => {
    assert.equal(owner, window); assert.equal(options.title, 'Import discovered videos?');
    assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 1);
    assert.equal(options.buttons.length, 2); assert.match(options.message, /2/);
    assert.equal(JSON.stringify(options).includes(root), false);
    confirmations++;
    if (mode === 'hold') { return new Promise(resolve => { release = () => resolve({ response: 0 }); }); }
    return { response: mode === 'decline' ? 1 : 0 };
  };
  const action = "document.querySelector('#source-folders-list [data-action=scan-source]')";
  const ready = () => waitForRenderer(window, `${action} && !${action}.disabled && !document.getElementById('refresh-source-folders').disabled`, 5000);
  try {
    await evaluate(window, "document.getElementById('source-folders-toggle').click(); true"); await ready();
    const size = window.getSize(); window.setSize(600, 400); window.show(); await delay(120);
    await evaluate(window, `${action}.scrollIntoView({ block: 'center' }); true`);
    await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(120);
    assert.equal(await evaluate(window, `(() => { const b = ${action}; const panel = document.getElementById('source-folders-panel');
      const p = panel.getBoundingClientRect(); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.left >= p.left + panel.clientLeft && r.right <= p.left + panel.clientLeft + panel.clientWidth
        && r.top >= p.top + panel.clientTop && r.bottom <= p.top + panel.clientTop + panel.clientHeight && (hit === b || b.contains(hit)); })()`), true);
    fs.mkdirSync(path.join(repository, 'tmp', 'private-scan-stage'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'tmp', 'private-scan-stage', 'compact-source-scan.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(...size);
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(confirmations, 1); assert.deepEqual(fingerprint(directory), encrypted);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].videoCount, 51);
    setStage('gallery-source-scan-cancel'); mode = 'hold';
    await evaluate(window, `${action}.click(); true`);
    for (let index = 0; index < 500 && confirmations < 2; index++) { await delay(10); }
    assert.equal(confirmations, 2);
    await evaluate(window, "document.getElementById('cancel-video-import').click(); true");
    release(); await ready();
    assert.deepEqual(fingerprint(directory), encrypted);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].videoCount, 51);
    setStage('gallery-source-scan-import'); mode = 'accept';
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(confirmations, 3);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].videoCount, 53);
    const complete = await evaluate(window, "document.getElementById('source-folders-status').textContent");
    assert.match(complete, /2 added/); assert.match(complete, /0 failed/);
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(confirmations, 3, 'A scan with no new candidates must not ask to import.');
    assert.equal(await evaluate(window, "document.getElementById('source-folders-status').textContent.includes('No new videos')"), true);
    assert.deepEqual(fingerprint(root), originals);
    assert.equal(await evaluate(window, `document.body.textContent.includes(${JSON.stringify(root)})`), false);
    await evaluate(window, "document.getElementById('close-source-folders').click(); true");
    const search = async value => evaluate(window, `(() => { const input = document.getElementById('gallery-search');
      input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await search('Synthetic scanned');
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 2");
    await waitForRenderer(window, "[...document.querySelectorAll('#gallery-grid .video-card img')].every(i => i.naturalWidth === 256)");
    assert.deepEqual((await evaluate(window, "[...document.querySelectorAll('#gallery-grid .video-title')].map(n => n.textContent)")).sort(),
      ['Synthetic scanned nested', 'Synthetic scanned root']);
    await search('coastal');
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic coastal clip'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
    return { sourceScanDeclinedNoWrite: true, sourceScanLateConfirmationCancelled: true, sourceScanNestedImported: true,
      sourceScanExcludedLinksIgnoredPreviews: true, sourceScanExistingSkipped: true, sourceScanNoNewHandled: true,
      sourceScanPreviewsDecoded: true, sourceScanOriginalsUnchanged: true, sourceScanPathsMainOnly: true, sourceScanCompactFits: true };
  } finally { release(); dialog.showOpenDialog = oldPicker; dialog.showMessageBox = oldConfirmation; }
}

async function collectionSortingAcceptance(window, directory, marker) {
  const fingerprint = root => Object.fromEntries(fs.readdirSync(root).sort().map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]));
  const catalogueBefore = fingerprint(directory);
  const sourceBefore = fingerprint(path.join(fixture, 'synthetic-source'));
  const titles = "[...document.querySelectorAll('#gallery-grid .video-title')].map(n => n.textContent)";
  const ready = expected => waitForRenderer(window, `document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'
    && JSON.stringify(${titles}) === ${JSON.stringify(JSON.stringify(expected))}`);
  const archive = index => 'Synthetic archive ' + String(index).padStart(2, '0');
  const coastal = 'Synthetic coastal clip';
  const select = (id, value) => evaluate(window, `(() => { const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const search = value => evaluate(window, `(() => { const el = document.getElementById('gallery-search');
    el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  setStage('gallery-library-collections');
  await select('gallery-collection', 'favourites'); await ready([coastal, archive(49)]);
  assert.equal(await evaluate(window, "document.getElementById('result-summary').textContent"), '2 videos');
  await search('archive'); await ready([archive(49)]);
  await search('no-matching-synthetic-title'); await ready([]);
  assert.equal(await evaluate(window, "document.body.textContent.includes('No matching videos')"), true);
  await search(''); await ready([coastal, archive(49)]);
  await select('gallery-collection', 'recent'); await ready([archive(1), archive(49), coastal]);
  assert.equal(await evaluate(window, "document.getElementById('gallery-sort').value"), 'last-played');
  assert.equal(await evaluate(window, "document.getElementById('gallery-sort-direction').dataset.direction"), 'desc');
  await evaluate(window, "document.getElementById('gallery-sort-direction').click(); true");
  await ready([coastal, archive(1), archive(49)]);
  setStage('gallery-library-sorting');
  await select('gallery-collection', 'all');
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  await select('gallery-sort', 'name');
  await ready(Array.from({ length: 48 }, (_, index) => archive(index + 1)));
  await evaluate(window, "document.getElementById('next-page').click(); true");
  await ready([archive(49), coastal]);
  await select('gallery-sort', 'date-added');
  await ready(Array.from({ length: 48 }, (_, index) => archive(49 - index)));
  assert.equal(await evaluate(window, "document.getElementById('previous-page').disabled"), true);
  await evaluate(window, "document.getElementById('gallery-sort-direction').click(); true");
  await ready([coastal, ...Array.from({ length: 47 }, (_, index) => archive(index + 1))]);
  await select('gallery-sort', 'catalogue');
  await ready([coastal, ...Array.from({ length: 47 }, (_, index) => archive(index + 1))]);
  setStage('gallery-library-draft');
  await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(marker)}`);
  const draft = marker + ' unsaved library test';
  await evaluate(window, `(() => { const el = document.getElementById('details-notes'); el.value = ${JSON.stringify(draft)};
    el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await evaluate(window, "document.getElementById('gallery-collection').disabled"), true);
  await select('gallery-collection', 'favourites'); await select('gallery-sort', 'name');
  await evaluate(window, "document.getElementById('gallery-sort-direction').dispatchEvent(new Event('click')); true");
  assert.deepEqual(await evaluate(window, `({ collection: document.getElementById('gallery-collection').value,
    sort: document.getElementById('gallery-sort').value, direction: document.getElementById('gallery-sort-direction').dataset.direction,
    draft: document.getElementById('details-notes').value })`), { collection: 'all', sort: 'catalogue', direction: 'asc', draft });
  await evaluate(window, "document.getElementById('discard-details').click(); true");
  await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(marker)} && document.getElementById('save-details').disabled`);
  await evaluate(window, "document.getElementById('close-details').click(); true");
  setStage('gallery-library-compact');
  const size = window.getSize(); window.setSize(600, 400); window.show(); await delay(120);
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(120);
  assert.equal(await evaluate(window, `(() => {
    const ids = ['gallery-search', 'gallery-collection', 'gallery-sort', 'gallery-sort-direction', 'lock-hub'];
    const viewport = document.querySelector('.gallery-content').getBoundingClientRect();
    const grid = document.getElementById('gallery-grid').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && ids.every(id => {
      const el = document.getElementById(id); const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
        && (hit === el || el.contains(hit));
    }) && Math.min(viewport.bottom, innerHeight) - Math.max(grid.top, viewport.top) >= 120;
  })()`), true, 'Library controls and gallery must remain reachable in the minimum window.');
  fs.mkdirSync(path.join(repository, 'tmp', 'private-library-stage'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'tmp', 'private-library-stage', 'compact-library.png'),
    (await window.webContents.capturePage()).toPNG());
  window.setSize(...size); await delay(120);
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(120);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-library-stage', 'library.png'),
    (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(fingerprint(directory), catalogueBefore);
  assert.deepEqual(fingerprint(path.join(fixture, 'synthetic-source')), sourceBefore);
  return { libraryNoWrites: true, libraryFavouritesFiltered: true, libraryRecentPlayedOnly: true, librarySearchIntersection: true,
    libraryEmptyState: true, librarySortDirections: true, libraryStablePagination: true,
    libraryDraftGuard: true, libraryControlsCompact: true };
}

async function ratingEditingAcceptance(window) {
  const setRating = value => evaluate(window, `(() => { const el = document.getElementById('details-rating-input');
    el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const setSelect = (id, value) => evaluate(window, `(() => { const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const chooseArchive = async () => {
    await evaluate(window, "[...document.querySelectorAll('#gallery-grid .video-card')].find(card => card.querySelector('.video-title').textContent === 'Synthetic archive 01').click(); true");
    await waitForRenderer(window, "document.getElementById('details-title').textContent === 'Synthetic archive 01' && !document.getElementById('details-rating-input').disabled");
  };
  const saved = () => waitForRenderer(window, "document.getElementById('edit-status').textContent === 'Changes saved.' && document.getElementById('save-details').disabled && document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'");
  const source = path.join(fixture, 'synthetic-source');
  const before = fs.readdirSync(source).sort().map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')]);
  setStage('gallery-rating-draft');
  await chooseArchive();
  assert.equal(await evaluate(window, "document.getElementById('details-rating-input').value"), '0');
  await setRating(5);
  assert.equal(await evaluate(window, "document.getElementById('save-details').disabled"), false);
  await evaluate(window, "document.getElementById('close-details').click(); true");
  assert.equal(await evaluate(window, "document.getElementById('details-panel').hidden"), false);
  await setSelect('gallery-collection', 'favourites');
  assert.equal(await evaluate(window, "document.getElementById('gallery-collection').value"), 'all');
  assert.equal(await evaluate(window, "document.getElementById('details-rating-input').value"), '5');
  await evaluate(window, "document.getElementById('discard-details').click(); true");
  await waitForRenderer(window, "document.getElementById('details-rating-input').value === '0' && document.getElementById('save-details').disabled");
  setStage('gallery-rating-save');
  await setRating(5); await evaluate(window, "document.getElementById('save-details').click(); true"); await saved();
  assert.equal(await evaluate(window, "document.getElementById('details-rating').textContent.includes('Favourite')"), true);
  await setSelect('gallery-collection', 'favourites');
  await waitForRenderer(window, "document.getElementById('result-summary').textContent === '3 videos' && document.querySelectorAll('#gallery-grid .video-card').length === 3");
  await chooseArchive(); await setRating(3);
  // A shorter window must still expose rating and save controls by ordinary
  // scrolling inside Details, without changing privacy controls or hiding Save.
  setStage('gallery-rating-compact');
  const size = window.getSize(); window.setSize(600, 400); window.show(); await delay(120);
  await evaluate(window, "document.getElementById('details-rating-input').scrollIntoView({ block: 'center' }); true");
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(120);
  assert.equal(await evaluate(window, `['details-rating-input', 'save-details', 'discard-details', 'lock-hub'].every(id => {
    const el = document.getElementById(id); const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !el.disabled && r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && (hit === el || el.contains(hit));
  })`), true);
  fs.mkdirSync(path.join(repository, 'tmp', 'private-rating-stage'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'tmp', 'private-rating-stage', 'compact-rating.png'), (await window.webContents.capturePage()).toPNG());
  window.setSize(...size); await delay(120);
  await evaluate(window, "document.getElementById('save-details').click(); true"); await saved();
  assert.equal(await evaluate(window, "document.getElementById('result-summary').textContent"), '2 videos');
  assert.deepEqual(await evaluate(window, "[...document.querySelectorAll('#gallery-grid .video-title')].map(el => el.textContent)"),
    ['Synthetic coastal clip', 'Synthetic archive 49']);
  assert.equal(await evaluate(window, "document.getElementById('details-title').textContent"), 'Synthetic archive 01');
  assert.equal(await evaluate(window, "document.getElementById('details-rating-input').value"), '3');
  setStage('gallery-rating-order');
  await setSelect('gallery-collection', 'all');
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  await setSelect('gallery-sort', 'rating');
  await waitForRenderer(window, `document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false' &&
    JSON.stringify([...document.querySelectorAll('#gallery-grid .video-title')].slice(0, 3).map(el => el.textContent)) === JSON.stringify(['Synthetic coastal clip', 'Synthetic archive 49', 'Synthetic archive 01'])`);
  await chooseArchive();
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(120);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-rating-stage', 'rating.png'), (await window.webContents.capturePage()).toPNG());
  await evaluate(window, "document.getElementById('close-details').click(); true");
  await setSelect('gallery-sort', 'catalogue');
  await waitForRenderer(window, "document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#gallery-grid .video-card').length === 48 && document.querySelectorAll('#gallery-grid .video-title')[1].textContent === 'Synthetic archive 01'");
  assert.deepEqual(fs.readdirSync(source).sort().map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')]), before);
  return { ratingDraftGuard: true, ratingDiscardRestored: true, ratingFavouriteAdded: true, ratingFavouriteRemoved: true,
    ratingDetailsRetained: true, ratingOrderRefreshed: true, ratingOriginalsUnchanged: true, ratingCompactFits: true };
}


async function playbackHistoryAcceptance(window, directory, marker) {
  setStage('gallery-playback-history');
  const source = path.join(fixture, 'relocated-source', 'Synthetic imported video.mp4');
  const originalHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const fingerprint = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
  const oldRecord = PrivateHubSession.prototype.recordVideoPlayback;
  const observations = [];
  PrivateHubSession.prototype.recordVideoPlayback = async function(...args) {
    const result = await oldRecord.apply(this, args);
    observations.push(result.status === 'recorded' ? { status: result.status, count: result.image.timesPlayed,
      time: result.image.lastPlayed, notes: result.image.notes } : { status: result.status });
    return result;
  };
  const waitObservation = async count => {
    for (let attempt = 0; attempt < 500 && observations.length < count; attempt++) { await delay(10); }
    assert.equal(observations.length, count, 'One history transaction per playback.');
    await waitForRenderer(window, "!document.getElementById('gallery-search').disabled");
  };
  const search = async value => evaluate(window, `(() => { const input = document.getElementById('gallery-search');
    input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const openProtection = async () => {
    await evaluate(window, "document.getElementById('protection-button').click(); true");
    await waitForRenderer(window, "!document.getElementById('record-playback-history').disabled");
  };
  const setHistory = async value => {
    await openProtection();
    await evaluate(window, `(() => { const input = document.getElementById('record-playback-history'); input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('save-protection').click(); })()`);
    await waitForRenderer(window, "document.getElementById('protection-status').textContent === 'Protection settings saved.'");
    await evaluate(window, "document.getElementById('close-protection').click(); true");
  };
  const start = async () => {
    await waitForRenderer(window, "!document.getElementById('play-original').disabled && !document.getElementById('play-original').hidden");
    await evaluate(window, "document.getElementById('play-original').click(); true");
    await waitForRenderer(window, "document.getElementById('preview-video').currentSrc.includes('/original/') && document.getElementById('preview-video').currentTime > 0");
    await evaluate(window, "document.getElementById('preview-video').pause(); true");
  };
  const stop = async () => {
    await evaluate(window, "document.getElementById('stop-video').click(); true");
    await waitForRenderer(window, "!document.getElementById('preview-video').hasAttribute('src') && !document.getElementById('play-original').disabled && document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'");
  };
  try {
    await search('Synthetic imported video');
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic imported video'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "document.getElementById('details-title').textContent === 'Synthetic imported video'");
    await openProtection();
    assert.equal(await evaluate(window, "document.getElementById('record-playback-history').value"), 'off');
    const size = window.getSize(); window.setSize(600, 400); window.show();
    await delay(100);
    await evaluate(window, "document.getElementById('record-playback-history').scrollIntoView({block: 'center'}); true");
    await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const fits = await evaluate(window, `(() => { const el = document.getElementById('record-playback-history'); const r = el.getBoundingClientRect();
      const p = document.getElementById('protection-panel').getBoundingClientRect();
      return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom
        && r.bottom <= innerHeight && el.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)); })()`);
    assert.equal(fits, true);
    fs.writeFileSync(path.join(repository, 'tmp/private-history-stage/compact-history.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(...size);
    await evaluate(window, "document.getElementById('close-protection').click(); true");
    setStage('history-default-off');
    const beforeOff = fingerprint();
    await start(); await waitObservation(1); await stop();
    assert.deepEqual(observations[0], { status: 'disabled' });
    assert.deepEqual(fingerprint(), beforeOff, 'Default-off playback writes no catalogue/history records.');
    setStage('history-enable');
    await setHistory('on');
    const draft = marker + ' — playback draft';
    await evaluate(window, `(() => { const notes = document.getElementById('details-notes'); notes.value = ${JSON.stringify(draft)};
      notes.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    setStage('history-first-play');
    await start(); await waitObservation(2);
    assert.equal(observations[1].status, 'recorded'); assert.equal(observations[1].count, 1);
    assert.equal(observations[1].notes, undefined, 'History preserves absent notes instead of saving an unsaved draft.');
    assert.equal(await evaluate(window, 'document.getElementById("details-notes").value'), draft);
    setStage('history-replay');
    assert.deepEqual(await evaluate(window, "window.privateGallery.ackOriginalPlayback(document.getElementById('preview-video').currentSrc)"), { status: 'ignored' });
    await evaluate(window, "(() => { const v = document.getElementById('preview-video'); v.currentTime = 0.1; return v.play(); })()");
    await delay(100);
    await evaluate(window, "document.getElementById('preview-video').pause(); true");
    assert.equal(observations.length, 2, 'Pause/resume and seeking reuse the consumed playback acknowledgement.');
    setStage('history-draft-save');
    await stop();
    await waitForRenderer(window, "!document.getElementById('save-details').disabled");
    await evaluate(window, "document.getElementById('save-details').click(); true");
    await waitForRenderer(window, "document.getElementById('edit-status').textContent === 'Changes saved.' && document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'");
    setStage('history-second-play');
    await start(); await waitObservation(3); await stop();
    assert.equal(observations[2].status, 'recorded'); assert.equal(observations[2].count, 2);
    assert.equal(observations[2].notes, draft);
    assert.ok(observations[2].time >= observations[1].time);
    await evaluate(window, `(() => { const input = document.getElementById('gallery-collection'); input.value = 'recent';
      input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic imported video' && document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
    setStage('history-preview');
    const beforePreview = fingerprint();
    await evaluate(window, "document.getElementById('play-preview').click(); true");
    await waitForRenderer(window, "document.getElementById('preview-video').currentTime > 0");
    await stop(); assert.equal(observations.length, 3); assert.deepEqual(fingerprint(), beforePreview);
    setStage('history-disable');
    await setHistory('off');
    const afterOff = fingerprint();
    await start(); await waitObservation(4); await stop();
    assert.deepEqual(observations[3], { status: 'disabled' }); assert.deepEqual(fingerprint(), afterOff);
    assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), originalHash);
    await evaluate(window, `(() => { const input = document.getElementById('gallery-collection'); input.value = 'all';
      input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await waitForRenderer(window, "document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'");
    await search('coastal');
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic coastal clip'");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
    return { historyDefaultOffNoWrite: true, historyEnabledRecorded: true, historyRepeatedEventsOnce: true,
      historyNewPlaybackCounted: true, historyDraftPreservedAndSaved: true, historyRecentRefreshed: true,
      historyPreviewNoWrite: true, historyDisabledNoWrite: true, historyOriginalUnchanged: true, historyCompactFits: true };
  } catch (error) {
    // Synthetic fixture diagnostics stay in the workspace, outside scan targets.
    fs.writeFileSync(path.join(repository, 'tmp/private-history-stage/history-failure.txt'), String(error?.stack || error));
    throw error;
  } finally { PrivateHubSession.prototype.recordVideoPlayback = oldRecord; }
}

async function playbackResetAcceptance(directory, password) {
  setStage('playback-reset-opening');
  const beforeStore = await PrivateHubStore.open(directory, password);
  let expected;
  try {
    const bytes = await beforeStore.readRecord('catalogue');
    try { expected = JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
  } finally { await beforeStore.lock(); }
  assert.equal(expected.images[50].timesPlayed, 2);
  assert.ok(expected.images[50].lastPlayed > 0, 'Previously recorded history survived reopening.');
  const fingerprint = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
  const source = path.join(fixture, 'relocated-source', 'Synthetic imported video.mp4');
  const sourceDigest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const oldReset = PrivateHubSession.prototype.resetPlaybackHistory;
  const oldWrite = PrivateHubStore.prototype.writeRecord;
  const oldDialog = dialog.showMessageBox;
  const results = []; const writes = []; const confirmations = [];
  let answer = 1; let hold = false; let release;
  PrivateHubSession.prototype.resetPlaybackHistory = async function(...args) {
    try { const result = await oldReset.apply(this, args); results.push(result); return result; }
    catch (error) { results.push({ status: 'unavailable' }); throw error; }
  };
  PrivateHubStore.prototype.writeRecord = async function(id, bytes, ...args) {
    if (id === 'catalogue') { writes.push(JSON.parse(Buffer.from(bytes).toString('utf8'))); }
    return oldWrite.call(this, id, bytes, ...args);
  };
  dialog.showMessageBox = async (owner, options) => {
    assert.equal(owner, currentWindow());
    assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 1);
    assert.equal(options.buttons[1], 'Cancel'); assert.equal(options.noLink, true);
    const text = [options.title, options.message, options.detail].join('\n');
    assert.match(text, /Last played|Times played/);
    assert.ok(!text.includes(directory) && !text.includes(source));
    assert.match(text, /backup/i);
    confirmations.push(text);
    if (hold) { await new Promise(resolve => { release = resolve; }); }
    return { response: answer, checkboxChecked: false };
  };
  let window;
  const open = async () => {
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'opened');
    window = currentWindow();
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  };
  const protection = async () => {
    await evaluate(window, "document.getElementById('protection-button').click(); true");
    await waitForRenderer(window, "!document.getElementById('reset-last-played').disabled");
    assert.equal(await evaluate(window, "document.getElementById('record-playback-history').value"), 'off');
  };
  const reset = async metric => {
    const count = results.length + 1;
    await evaluate(window, `document.getElementById(${JSON.stringify(metric === 'lastPlayed' ? 'reset-last-played' : 'reset-times-played')}).click(); true`);
    for (let attempt = 0; attempt < 500 && results.length < count; attempt++) { await delay(10); }
    assert.equal(results.length, count);
    await waitForRenderer(window, "!document.getElementById('reset-last-played').disabled && document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false'");
    return results.at(-1);
  };
  const clearExpected = metric => {
    let count = 0;
    for (const image of expected.images) {
      if (Object.hasOwn(image, metric) && image[metric] !== 0) { image[metric] = 0; count++; }
    }
    return count;
  };
  try {
    await open(); await protection();
    setStage('playback-reset-cancel');
    const beforeCancel = fingerprint();
    assert.deepEqual(await reset('lastPlayed'), { status: 'cancelled' });
    assert.equal(confirmations.length, 1); assert.equal(writes.length, 0);
    assert.deepEqual(fingerprint(), beforeCancel);
    setStage('playback-reset-times');
    answer = 0;
    const expectedTimesCount = clearExpected('timesPlayed');
    assert.deepEqual(await reset('timesPlayed'), { status: 'reset', count: expectedTimesCount });
    assert.equal(writes.length, 1); assert.deepEqual(writes[0], expected);
    assert.equal(await evaluate(window, "document.getElementById('record-playback-history').value"), 'off');
    const afterTimes = fingerprint();
    assert.deepEqual(await reset('timesPlayed'), { status: 'unchanged' });
    assert.equal(confirmations.length, 2); assert.equal(writes.length, 1); assert.deepEqual(fingerprint(), afterTimes);
    setStage('playback-reset-lock-pending');
    hold = true;
    await evaluate(window, "document.getElementById('reset-last-played').click(); true");
    for (let attempt = 0; attempt < 500 && !release; attempt++) { await delay(10); }
    assert.equal(typeof release, 'function');
    const settled = workspace.settled;
    let finished = false; void settled.then(() => { finished = true; });
    void evaluate(window, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
    await delay(30);
    assert.equal(finished, false, 'Lock must drain the outstanding native confirmation.');
    release(); await settled;
    assert.equal(window.isDestroyed(), true); assert.equal(writes.length, 1);
    assert.deepEqual(fingerprint(), afterTimes, 'A late confirmation cannot reset history after locking.');
    assertRestoredMenu();
    hold = false; release = undefined;
    setStage('playback-reset-last');
    await open();
    await evaluate(window, `(() => { const el = document.getElementById('gallery-collection'); el.value = 'recent';
      el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await waitForRenderer(window, "document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#gallery-grid .video-card').length > 0");
    const oldPage = await evaluate(window, "window.privateGallery.list({query:'',offset:0,collection:'recent'})");
    assert.equal(oldPage.status, 'ready'); assert.ok(oldPage.items.length > 0);
    await protection();
    window.setSize(600, 400); window.show(); await delay(100);
    let compact = true;
    for (const id of ['reset-last-played', 'reset-times-played']) {
      await evaluate(window, `document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center'}); true`);
      await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      compact &&= await evaluate(window, `(() => { const el = document.getElementById(${JSON.stringify(id)}); const r = el.getBoundingClientRect();
        const p = document.getElementById('protection-panel').getBoundingClientRect();
        return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom
          && r.bottom <= innerHeight && el.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)); })()`);
    }
    assert.equal(compact, true);
    fs.writeFileSync(path.join(repository, 'tmp/private-history-reset-stage/compact-reset.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1200, 800);
    const expectedLastCount = clearExpected('lastPlayed');
    assert.deepEqual(await reset('lastPlayed'), { status: 'reset', count: expectedLastCount });
    assert.equal(writes.length, 2); assert.deepEqual(writes[1], expected);
    assert.equal(await evaluate(window, "document.getElementById('gallery-collection').value"), 'recent');
    assert.equal(await evaluate(window, "document.querySelectorAll('#gallery-grid .video-card').length"), 0);
    assert.deepEqual(await evaluate(window, `window.privateGallery.detail(${JSON.stringify(oldPage.items[0].id)})`), { status: 'unavailable' });
    const afterLast = fingerprint();
    assert.deepEqual(await reset('lastPlayed'), { status: 'unchanged' });
    assert.equal(writes.length, 2); assert.equal(confirmations.length, 4); assert.deepEqual(fingerprint(), afterLast);
    assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceDigest);
    await workspace.cancel(); assertRestoredMenu();
    const store = await PrivateHubStore.open(directory, password);
    try {
      const bytes = await store.readRecord('catalogue');
      try { assert.deepEqual(JSON.parse(bytes.toString('utf8')), expected); } finally { bytes.fill(0); }
    } finally { await store.lock(); }
    await checkpoint('playback-history-reset', { resetCancelledNoWrite: true, resetTimesIndependent: true,
      resetLastIndependent: true, resetNoOpNoWrite: true, resetRecordingUnchanged: true,
      resetRecentRefreshed: true, resetRetiredIds: true, resetLockDrained: true, resetLateConfirmationRefused: true,
      resetOtherMetadataPreserved: true, resetOriginalUnchanged: true, resetCompactFits: true, resetReopened: true });
  } catch (error) {
    fs.writeFileSync(path.join(repository, 'tmp/private-history-reset-stage/native-failure.txt'), String(error?.stack || error));
    throw error;
  } finally {
    release?.(); dialog.showMessageBox = oldDialog;
    PrivateHubSession.prototype.resetPlaybackHistory = oldReset;
    PrivateHubStore.prototype.writeRecord = oldWrite;
  }
}

async function workspaceOpening(directory, password, newPassword, marker) {
  workspace = createPrivateHubWorkspace({ appDirectory: path.join(repository, 'private-gallery'), promptVisible: false });
  const lifetime = new AbortController();
  const options = { directory, signal: lifetime.signal, isAuthorized: () => true };
  setStage('workspace-opening');
  assert.equal(await completeWorkspacePrompt(workspace.open(options), password), 'opened');
  assert.deepEqual(workspace.status, { state: 'open', cleanupFailed: false });
  const window = currentWindow();
  assertPrivateMenu();
  assert.equal(window.isVisible(), true);
  // Keep a deliberately hidden test renderer active, as the real gallery is
  // visible during playback. Do not change production browser preferences.
  window.webContents.setBackgroundThrottling(false);
  window.hide();
  const isolated = window.webContents.session;
  const surface = await evaluate(window, `({
    methods: Object.keys(window.privateGallery).sort(), credentials: Object.keys(window.privateCredentials).sort(), ordinary: typeof window.theatrum,
    unlock: typeof window.privateUnlock, node: typeof window.require, process: typeof window.process,
  })`);
  assert.deepEqual(surface, { methods: ['ackOriginalPlayback', 'addSource', 'cancelImport', 'cancelRegeneration', 'cancelSourceConnection', 'checkSource', 'connectSource', 'detail', 'disconnectSource', 'importProgress', 'importVideo', 'list', 'lock',
    'playOriginal', 'protection', 'refreshVideo', 'regenerate', 'relocateSource', 'resetPlaybackHistory', 'save', 'scanSource', 'setCustomThumbnail', 'setProtection', 'sources', 'stopOriginal'],
    credentials: ['cancelUnprotectedCopy', 'changePassword', 'createUnprotectedCopy', 'disableTouchId', 'enableTouchId', 'resumePasswordChange', 'touchIdStatus'], ordinary: 'undefined', unlock: 'undefined', node: 'undefined', process: 'undefined' });
  setStage('gallery-list');
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  const collectionChecks = await collectionSortingAcceptance(window, directory, marker);
  const ratingChecks = await ratingEditingAcceptance(window);
  setStage('gallery-protection');
  await evaluate(window, "document.getElementById('protection-button').click(); true");
  await waitForRenderer(window, "document.getElementById('auto-lock-minutes').value === '5' && !document.getElementById('auto-lock-minutes').disabled");
  await evaluate(window, `(() => {
    const select = document.getElementById('auto-lock-minutes'); select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('save-protection').click();
  })()`);
  await waitForRenderer(window, "document.getElementById('protection-status').textContent === 'Protection settings saved.'");
  window.show();
  await delay(100);
  const protectionScreenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(repository, 'tmp', 'private-protection-review.png'), protectionScreenshot.toPNG());
  setStage('protection-small-window');
  const originalSize = window.getSize();
  window.setSize(600, 400);
  // A hidden macOS window may suspend animation frames during a resize even
  // with background throttling disabled. Inspect a briefly visible layout.
  await delay(100);
  const layout = await evaluate(window, `(() => {
    const panel = document.getElementById('protection-panel'); const rect = panel.getBoundingClientRect();
    return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
      scrollable: getComputedStyle(panel).overflowY === 'auto' };
  })()`);
  assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.bottom <= layout.height && layout.scrollable);
  const compactProtection = await window.webContents.capturePage();
  fs.writeFileSync(path.join(repository, 'tmp', 'private-protection-small-review.png'), compactProtection.toPNG());
  window.setSize(...originalSize);
  setStage('gallery-protection');
  await evaluate(window, "document.getElementById('close-protection').click(); true");
  assert.equal(await evaluate(window, "document.getElementById('previous-page').disabled"), true);
  assert.equal(await evaluate(window, "document.getElementById('next-page').disabled"), false);
  setStage('gallery-page');
  await evaluate(window, "document.getElementById('next-page').click(); true");
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 2");
  assert.equal(await evaluate(window, "document.getElementById('next-page').disabled"), true);
  assert.equal(await evaluate(window, "document.getElementById('previous-page').disabled"), false);
  setStage('gallery-search');
  await evaluate(window, `(() => {
    const input = document.getElementById('gallery-search'); input.value = 'coastal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1 && document.querySelector('.video-title').textContent === 'Synthetic coastal clip'");
  await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 32 && !document.querySelector('#gallery-grid .video-card img').hidden");
  const clipResponses = [];
  const filmstripResponses = [];
  isolated.webRequest.onCompleted({ urls: ['theatrum://app/media/clips/native-video.mp4*', 'theatrum://app/media/filmstrips/*'] }, details => {
    const responses = details.url.includes('/filmstrips/') ? filmstripResponses : clipResponses;
    if (responses.length < 8) { responses.push({ status: details.statusCode, type: details.resourceType }); }
  });
  setStage('gallery-details');
  await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(marker)}`);
  assert.equal(await evaluate(window, "document.getElementById('details-title').textContent"), 'Synthetic coastal clip');
  assert.equal(await evaluate(window, "document.querySelector('#gallery-grid .video-card').getAttribute('aria-pressed')"), 'true');
  setStage('gallery-filmstrip');
  assert.deepEqual(await evaluate(window, `({ hidden: document.getElementById('filmstrip-panel').hidden,
    source: document.getElementById('detail-filmstrip').hasAttribute('src'),
    expanded: document.getElementById('toggle-filmstrip').getAttribute('aria-expanded') })`),
  { hidden: true, source: false, expanded: 'false' });
  assert.equal(filmstripResponses.length, 0, 'Selecting a video must not request its filmstrip.');
  await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
  await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 96 && !document.getElementById('detail-filmstrip').hidden");
  const originalFilmstripUrl = await evaluate(window, "document.getElementById('detail-filmstrip').currentSrc");
  assert.match(originalFilmstripUrl, /^theatrum:\/\/app\/media\/filmstrips\/native-video\.jpg\?v=[a-f0-9]{32}$/);
  assert.ok(filmstripResponses.some(response => response.status === 200 && response.type === 'image'));
  assert.equal(await evaluate(window, "document.getElementById('toggle-filmstrip').getAttribute('aria-expanded')"), 'true');
  assert.equal(await evaluate(window, "document.getElementById('preview-video').hasAttribute('src')"), false);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-filmstrip-review.png'), (await window.webContents.capturePage()).toPNG());
  setStage('gallery-filmstrip-shell');
  assert.equal(await evaluate(window, `(() => {
    const header = document.querySelector('.hub-header').getBoundingClientRect();
    const button = document.getElementById('lock-hub'); const box = button.getBoundingClientRect();
    return header.top >= 0 && header.bottom <= innerHeight && box.top >= 0 && box.bottom <= innerHeight
      && button.contains(document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2));
  })()`), true, 'Opening a filmstrip must keep the hub header and Lock hub control reachable.');
  await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
  window.setSize(600, 400);
  await delay(100);
  await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
  await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 96 && !document.getElementById('detail-filmstrip').hidden");
  const filmstripLayout = await evaluate(window, `(() => {
    const viewport = document.getElementById('filmstrip-viewport'); const rect = viewport.getBoundingClientRect();
    const scroll = document.getElementById('details-scroll').getBoundingClientRect();
    const heading = document.querySelector('.details-heading-row').getBoundingClientRect();
    const footer = document.getElementById('edit-footer'); const footerRect = footer.getBoundingClientRect();
    const header = document.querySelector('.hub-header').getBoundingClientRect();
    const usable = id => {
      const button = document.getElementById(id); const box = button.getBoundingClientRect();
      const x = (box.left + box.right) / 2; const y = (box.top + box.bottom) / 2;
      return box.top >= 0 && box.bottom <= innerHeight && button.contains(document.elementFromPoint(x, y));
    };
    return { left: rect.left, right: rect.right, width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      visibleHeight: Math.min(rect.bottom, scroll.bottom, footer.hidden ? innerHeight : footerRect.top, innerHeight)
        - Math.max(rect.top, scroll.top, heading.bottom, 0),
      closeReachable: usable('close-details'), toggleReachable: usable('toggle-filmstrip'),
      cleanFooterHidden: footer.hidden && document.getElementById('save-details').disabled,
      headerVisible: header.top >= 0 && header.bottom <= innerHeight,
      lockReachable: usable('lock-hub'), protectionReachable: usable('protection-button'),
      scrolls: viewport.scrollWidth > viewport.clientWidth, overflow: getComputedStyle(viewport).overflowX };
  })()`);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-filmstrip-small-review.png'), (await window.webContents.capturePage()).toPNG());
  // This fixture-only diagnostic contains bounded layout geometry and booleans,
  // never catalogue text, media paths, keys, or renderer resource URLs.
  fs.writeFileSync(path.join(repository, 'tmp', 'private-filmstrip-layout-review.json'), JSON.stringify(filmstripLayout));
  setStage('gallery-filmstrip-geometry');
  assert.ok(filmstripLayout.left >= 0 && filmstripLayout.right <= filmstripLayout.width
    && filmstripLayout.documentWidth <= filmstripLayout.width && filmstripLayout.scrolls && filmstripLayout.overflow === 'auto');
  setStage('gallery-filmstrip-visibility');
  assert.ok(filmstripLayout.visibleHeight >= 48, 'The compact filmstrip must remain visible between the sticky header and footer.');
  setStage('gallery-filmstrip-controls');
  assert.ok(filmstripLayout.closeReachable && filmstripLayout.toggleReachable && filmstripLayout.cleanFooterHidden,
    'The compact filmstrip controls must remain reachable.');
  setStage('gallery-filmstrip-compact-shell');
  assert.ok(filmstripLayout.headerVisible && filmstripLayout.lockReachable && filmstripLayout.protectionReachable,
    'Opening a compact filmstrip must keep hub protection controls reachable.');
  setStage('gallery-filmstrip-draft-controls');
  assert.equal(await evaluate(window, `(() => {
    const notes = document.getElementById('details-notes'); notes.value += ' unsaved filmstrip draft';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.getElementById('save-details'); const box = button.getBoundingClientRect();
    return !document.getElementById('edit-footer').hidden && !button.disabled
      && box.top >= 0 && box.bottom <= innerHeight
      && button.contains(document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2));
  })()`), true, 'Draft edits must restore reachable save controls while the compact filmstrip is open.');
  await evaluate(window, `(() => {
    const notes = document.getElementById('details-notes'); notes.value = ${JSON.stringify(marker)};
    notes.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.equal(await evaluate(window, "document.getElementById('save-details').disabled && document.getElementById('edit-footer').hidden"), true);
  window.setSize(...originalSize);
  await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
  assert.deepEqual(await evaluate(window, `({ hidden: document.getElementById('filmstrip-panel').hidden,
    source: document.getElementById('detail-filmstrip').hasAttribute('src'),
    expanded: document.getElementById('toggle-filmstrip').getAttribute('aria-expanded') })`),
  { hidden: true, source: false, expanded: 'false' });
  setStage('gallery-filmstrip-selection');
  await evaluate(window, `(() => {
    const input = document.getElementById('gallery-search'); input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  await evaluate(window, "document.querySelectorAll('#gallery-grid .video-card')[0].click(); true");
  await waitForRenderer(window, "document.getElementById('details-title').textContent === 'Synthetic coastal clip'");
  // Change selection in the same turn as requesting an image. A late decode
  // or retry from the previous video must never repaint the new selection.
  await evaluate(window, `document.getElementById('toggle-filmstrip').click();
    document.querySelectorAll('#gallery-grid .video-card')[1].click(); true`);
  await waitForRenderer(window, "document.getElementById('details-title').textContent === 'Synthetic archive 01'");
  await evaluate(window, "document.getElementById('detail-filmstrip').dispatchEvent(new Event('load')); true");
  assert.deepEqual(await evaluate(window, `({ hidden: document.getElementById('filmstrip-panel').hidden,
    source: document.getElementById('detail-filmstrip').hasAttribute('src') })`), { hidden: true, source: false });
  await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
  await waitForRenderer(window, "document.getElementById('filmstrip-status').textContent === 'Filmstrip unavailable. Hide it and try again.'");
  assert.equal(await evaluate(window, "document.getElementById('detail-filmstrip').hidden"), true);
  await evaluate(window, `(() => {
    const input = document.getElementById('gallery-search'); input.value = 'coastal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
  await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(marker)}`);
  setStage('gallery-clipboard');
  const clipboard = await clipboardBackstop(window, 'details-notes', marker);
  await syntheticPaste(window, 'details-notes', true);
  setStage('gallery-preview');
  await evaluate(window, "document.getElementById('play-preview').click(); true");
  try {
    await waitForRenderer(window, "document.getElementById('preview-video').videoWidth === 32 && document.getElementById('preview-video').currentTime > 0");
  } catch (error) {
    const diagnostic = await evaluate(window, `(() => {
      const video = document.getElementById('preview-video');
      return { width: video.videoWidth, time: video.currentTime, error: video.error?.code,
        ready: video.readyState, network: video.networkState, paused: video.paused,
        hidden: video.hidden, sourceAssigned: !!video.src, codec: video.canPlayType('video/mp4; codecs="avc1.42E01E"') };
    })()`);
    fs.writeFileSync(path.join(fixture, 'preview-diagnostics.json'), JSON.stringify({ ...diagnostic, clipResponses }));
    throw error;
  }
  const originalClipUrl = await evaluate(window, "document.getElementById('preview-video').currentSrc");
  assert.match(originalClipUrl, /^theatrum:\/\/app\/media\/clips\/native-video\.mp4\?v=[a-f0-9]{32}$/);
  setStage('gallery-edit');
  const editedNote = marker + ' — saved in the private hub';
  const editedTag = 'Private > ' + marker;
  await evaluate(window, `(() => {
    const notes = document.getElementById('details-notes'); notes.value = ${JSON.stringify(editedNote)};
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('toggle-filmstrip').click();
    document.getElementById('toggle-filmstrip').click();
    const tag = document.getElementById('tag-draft'); tag.value = ${JSON.stringify('Private>' + marker)};
    tag.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('add-tag').click();
    document.getElementById('save-details').click();
  })()`);
  await waitForRenderer(window, `document.getElementById('save-details').disabled &&
    document.getElementById('edit-status').textContent === 'Changes saved.' &&
    document.getElementById('details-tags').textContent.includes(${JSON.stringify(editedTag)})`);
  assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), editedNote);
  assert.equal(await evaluate(window, `document.getElementById('preview-video').currentSrc`), originalClipUrl);
  // A dirty close is refused until explicit discard, then reloads persisted data.
  await evaluate(window, `(() => {
    const notes = document.getElementById('details-notes'); notes.value = ${JSON.stringify(marker + ' unsaved')};
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('close-details').click();
  })()`);
  assert.equal(await evaluate(window, "document.getElementById('details-panel').hidden"), false);
  await evaluate(window, "document.getElementById('discard-details').click(); true");
  await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(editedNote)} &&
    document.getElementById('save-details').disabled`);
  await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 32 && !document.querySelector('#gallery-grid .video-card img').hidden");
  setStage('gallery-regeneration');
  const sourceRoot = path.join(fixture, 'synthetic-source');
  const sourceFile = path.join(sourceRoot, 'synthetic-0.mp4');
  const sourceDigest = createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
  const nativePicker = dialog.showOpenDialog;
  let selections = 0;
  let sourceFolderChecks;
  // Automate only the native selection result for this synthetic fixture. The
  // real folder-grant controller, descriptor capture and encoders still run.
  dialog.showOpenDialog = async (owner, selection) => {
    assert.equal(owner, window); assert.equal(selection.defaultPath, sourceRoot);
    assert.deepEqual(selection.properties, ['openDirectory', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(selection.securityScopedBookmarks, false);
    selections++;
    return { canceled: selections === 1, filePaths: selections === 1 ? [] : [sourceRoot] };
  };
  try {
    setStage('gallery-source-cancel');
    await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
    await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 96 && !document.getElementById('detail-filmstrip').hidden");
    assert.equal(await evaluate(window, `document.getElementById('regenerate-previews').click();
      !document.getElementById('detail-filmstrip').hasAttribute('src') && document.getElementById('filmstrip-panel').hidden`), true);
    await waitForRenderer(window, "document.getElementById('generation-status').textContent === 'Regeneration stopped. Previews refreshed.'");
    assert.equal(selections, 1);
    sourceFolderChecks = { ...await sourceFoldersAcceptance(window, directory, sourceRoot),
      ...await sourceRelocationAcceptance(window, directory, sourceRoot) };
    setStage('gallery-source-generate');
    await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
    await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 96 && !document.getElementById('detail-filmstrip').hidden");
    assert.equal(await evaluate(window, `document.getElementById('regenerate-previews').click();
      !document.getElementById('detail-filmstrip').hasAttribute('src') && document.getElementById('filmstrip-panel').hidden`), true);
    await waitForRenderer(window, "!document.getElementById('regenerate-previews').disabled");
    assert.equal(selections, 1, 'Regeneration must reuse the source panel grant without another picker.');
    const generationStatus = await evaluate(window, "document.getElementById('generation-status').textContent");
    if (generationStatus.includes('unavailable')) { setStage('gallery-source-unavailable'); }
    else if (generationStatus.includes('could not')) { setStage('gallery-generation-failed'); }
    assert.equal(generationStatus, 'Previews regenerated.');
  } finally { dialog.showOpenDialog = nativePicker; }
  setStage('gallery-source-unchanged');
  assert.equal(createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'), sourceDigest);
  setStage('gallery-generated-thumbnail');
  await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256 && !document.querySelector('#gallery-grid .video-card img').hidden");
  setStage('gallery-generated-poster');
  await waitForRenderer(window, "document.getElementById('detail-poster').naturalWidth === 256 && !document.getElementById('detail-poster').hidden").catch(async error => {
    const state = await evaluate(window, "({width: document.getElementById('detail-poster').naturalWidth, hidden: document.getElementById('detail-poster').hidden})");
    if (state.width === 32) { setStage('gallery-stale-poster'); }
    else if (state.width === 256 && state.hidden) { setStage('gallery-hidden-poster'); }
    else if (state.width === 0) { setStage('gallery-empty-poster'); }
    throw error;
  });
  setStage('gallery-no-autoplay');
  assert.equal(await evaluate(window, "document.getElementById('preview-video').hasAttribute('src')"), false);
  assert.equal(await evaluate(window, "document.getElementById('detail-filmstrip').hasAttribute('src')"), false);
  setStage('gallery-generated-filmstrip');
  await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
  await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 768 && document.getElementById('detail-filmstrip').naturalHeight === 144 && !document.getElementById('detail-filmstrip').hidden");
  const regeneratedFilmstripUrl = await evaluate(window, "document.getElementById('detail-filmstrip').currentSrc");
  assert.notEqual(regeneratedFilmstripUrl, originalFilmstripUrl, 'Regeneration must retire the previous filmstrip URL.');
  assert.match(regeneratedFilmstripUrl, /^theatrum:\/\/app\/media\/filmstrips\/native-video\.jpg\?v=[a-f0-9]{32}$/);
  const originalChecks = await originalPlaybackAcceptance(window, directory);
  const importChecks = await manualImportAcceptance(window);
  const sourceAdditionChecks = await sourceAdditionAcceptance(window);
  const batchImportChecks = await batchImportAcceptance(window);
  const sourceScanChecks = await sourceScanAcceptance(window, directory);
  const historyChecks = await playbackHistoryAcceptance(window, directory, marker);
  // Leave a non-default collection/order active before locking. Reopening must
  // start with the default view, without storing private browse preferences.
  await evaluate(window, `(() => { const el = document.getElementById('gallery-collection'); el.value = 'recent';
    el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitForRenderer(window, "document.getElementById('gallery-grid').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#gallery-grid .video-card').length === 1");
  await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(window, "!document.getElementById('play-preview').disabled");
  setStage('gallery-generated-playback');
  await evaluate(window, "document.getElementById('play-preview').click(); true");
  await waitForRenderer(window, "document.getElementById('preview-video').videoWidth === 256 && document.getElementById('preview-video').currentTime > 0").catch(async error => {
    const state = await evaluate(window, "({width: document.getElementById('preview-video').videoWidth, paused: document.getElementById('preview-video').paused, error: document.getElementById('preview-video').error?.code || 0})");
    if (state.width === 32) { setStage('gallery-stale-video'); }
    else if (state.width === 256 && state.paused) { setStage('gallery-paused-video'); }
    else if (state.error) { setStage('gallery-video-decode-error'); }
    throw error;
  });
  await enterVideoFullscreen(window, 'preview');
  await escapeVideoFullscreen(window);
  // Review artifact contains generated synthetic catalogue/preview data only.
  setStage('gallery-review-capture');
  const galleryScreenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(repository, 'tmp', 'private-gallery-review.png'), galleryScreenshot.toPNG());
  assert.equal(await isolated.getCacheSize(), 0);
  await checkpoint('workspace-opened', { opened: true, surface, clipboard, metadataPasteDenied: true, restrictedApplicationMenu: true, pageSize: 48, pagination: true,
    search: true, notes: true, encryptedImageDecoded: true, encryptedClipPlayed: true,
    encryptedMetadataSaved: true, tagNormalized: true, dirtyCloseGuard: true, discardReloaded: true,
    ...sourceFolderChecks, ...originalChecks, ...importChecks, ...sourceAdditionChecks, ...batchImportChecks, ...collectionChecks, ...ratingChecks, ...sourceScanChecks, ...historyChecks, sourceFolderGrantReusedByRegeneration: true,
    sourcePickerCancelledThenGranted: true, encryptedPreviewsRegenerated: true, refreshedPreviewWidth: 256,
    sourceUnchanged: true, noRegenerationAutoplay: true, encryptedProtectionSaved: true,
    filmstripOnlyOnRequest: true, encryptedFilmstripDecoded: true, filmstripMinimumWindowFits: true,
    filmstripCloseClearedSource: true, filmstripSelectionRetired: true, missingFilmstripHandled: true,
    filmstripDraftPreserved: true, filmstripRegenerationRetired: true, regeneratedFilmstripWidth: 768,
    protectionMinimumWindowFits: true, originalFullscreen: true, previewFullscreen: true, fullscreenEscapePreservedDetails: true, fullscreenStopExited: true, cacheBytes: 0 }, [seededFilmstripPattern]);
  setStage('gallery-original-lock');
  let lockPlayback;
  const originalResponse = PrivateSourcePlayback.prototype.createResponse;
  PrivateSourcePlayback.prototype.createResponse = function(request) { lockPlayback = this; return originalResponse.call(this, request); };
  let lockingUrl;
  try {
    await evaluate(window, "document.getElementById('stop-video').click(); document.getElementById('play-original').click(); true");
    await waitForRenderer(window, "document.getElementById('preview-video').currentSrc.includes('/original/') && document.getElementById('preview-video').currentTime > 0");
    lockingUrl = await evaluate(window, "document.getElementById('preview-video').pause(); document.getElementById('preview-video').currentSrc");
    assert.ok(lockPlayback);
  } finally { PrivateSourcePlayback.prototype.createResponse = originalResponse; }
  await enterVideoFullscreen(window, 'lock');
  setStage('gallery-lock');
  const settled = workspace.settled;
  void evaluate(window, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
  await settled;
  assert.equal((await lockPlayback.createResponse(new Request(lockingUrl))).status, 404);
  assert.equal(window.isDestroyed(), true);
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assert.equal(await isolated.getCacheSize(), 0);
  assert.deepEqual(await isolated.cookies.get({}), []);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assertRestoredMenu();
  setStage('gallery-reopen');
  assert.equal(await completeWorkspacePrompt(workspace.open(options), password), 'opened');
  const reopened = currentWindow();
  assertPrivateMenu();
  reopened.hide();
  assert.notEqual(reopened.webContents.session, isolated);
  await waitForRenderer(reopened, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  assert.deepEqual(await evaluate(reopened, `({ collection: document.getElementById('gallery-collection').value,
    sort: document.getElementById('gallery-sort').value, direction: document.getElementById('gallery-sort-direction').dataset.direction,
    query: document.getElementById('gallery-search').value })`), { collection: 'all', sort: 'catalogue', direction: 'asc', query: '' });
  assert.equal(await evaluate(reopened, "window.privateGallery.list({query:'Synthetic archive 01',offset:0}).then(page => page.items.length === 1 && page.items[0].rating === 3 && !page.items[0].favourite)"), true);
  const reopenedSources = await evaluate(reopened, 'window.privateGallery.sources()');
  assert.equal(reopenedSources.status, 'ready');
  assert.equal(reopenedSources.items.length, 2);
  assert.ok(reopenedSources.items.every(item => !item.connected), 'All source connections must expire when the private browser locks.');
  await evaluate(reopened, `(() => {
    const search = document.getElementById('gallery-search'); search.value = ${JSON.stringify(editedTag)};
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(reopened, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
  await evaluate(reopened, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(reopened, `document.getElementById('details-notes').value === ${JSON.stringify(editedNote)}`);
  assert.equal(await evaluate(reopened, `document.getElementById('details-tags').textContent.includes(${JSON.stringify(editedTag)})`), true);
  await waitForRenderer(reopened, "document.getElementById('detail-poster').naturalWidth === 256");
  assert.deepEqual(await evaluate(reopened, `({ hidden: document.getElementById('filmstrip-panel').hidden,
    source: document.getElementById('detail-filmstrip').hasAttribute('src') })`), { hidden: true, source: false });
  lifetime.abort();
  assert.equal(reopened.isDestroyed(), true);
  await workspace.settled;
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assertRestoredMenu();
  // Use real native input and production timers, with a fixture-only monotonic
  // clock offset to reach deadlines without a one-minute automation sleep.
  setStage('gallery-automatic-lock');
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  const realNow = performance.now.bind(performance);
  let clockOffset = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => realNow() + clockOffset });
  try {
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'opened');
    const automatic = currentWindow();
    assertPrivateMenu();
    await waitForRenderer(automatic, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
    assert.deepEqual(await evaluate(automatic, 'window.privateGallery.protection()'), { status: 'ready', autoLockMinutes: 1, recordPlaybackHistory: false });
    clockOffset += 45_000;
    let nativeInputs = 0;
    automatic.webContents.on('before-input-event', () => { nativeInputs++; });
    automatic.show(); automatic.focus();
    await delay(100);
    automatic.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
    automatic.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
    for (let retry = 0; retry < 100 && nativeInputs < 2; retry++) { await delay(10); }
    assert.equal(nativeInputs, 2);
    automatic.hide();
    clockOffset += 40_000;
    assert.deepEqual(await evaluate(automatic, 'window.privateGallery.protection()'), { status: 'ready', autoLockMinutes: 1, recordPlaybackHistory: false });
    await evaluate(automatic, `(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true;
    })()`);
    clockOffset += 21_000;
    const automaticallyClosed = workspace.settled;
    void evaluate(automatic, 'window.privateGallery.protection()').catch(() => undefined);
    await automaticallyClosed;
    assert.equal(automatic.isDestroyed(), true);
    assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
    assertRestoredMenu();
  } finally {
    if (clockDescriptor) { Object.defineProperty(performance, 'now', clockDescriptor); }
    else { delete performance.now; }
  }
  setStage('workspace-wrong-password');
  assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password + ' incorrect'), 'unavailable');
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assertRestoredMenu();
  const reopenedStore = await PrivateHubStore.open(directory, password);
  const previewPatterns = [];
  let expectedCopyCatalogue;
  try {
    expectedCopyCatalogue = await reopenedStore.readRecord('catalogue');
    const set = await readPrivatePreviewSet(reopenedStore, 'native-video');
    assert.equal(set.width, 256); assert.equal(set.height, 144); assert.equal(set.screenCount, 3); assert.equal(set.clip, true);
    for (const kind of ['thumbnail', 'filmstrip', 'clip-poster', 'clip']) {
      const bytes = await readPrivateHubPreview(reopenedStore, kind, 'native-video', 1024 * 1024);
      try {
        if (kind !== 'clip') { validatePrivateJpeg(bytes, kind === 'filmstrip' ? 768 : 256, 144); }
        assert.equal(bytes.includes(Buffer.from(marker)), false, 'Source metadata is stripped from generated previews.');
        previewPatterns.push(bytes.toString('base64'));
      } finally { bytes.fill(0); }
    }
  } finally { await reopenedStore.lock(); }
  setStage('gallery-password-change');
  assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'opened');
  const credentials = currentWindow();
  assertPrivateMenu();
  credentials.show(); credentials.focus();
  await delay(100);
  await waitForRenderer(credentials, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  await evaluate(credentials, "document.getElementById('protection-button').click(); true");
  await waitForRenderer(credentials, "document.getElementById('auto-lock-minutes').value === '1' && !document.getElementById('auto-lock-minutes').disabled");
  await evaluate(credentials, `(() => {
    document.getElementById('change-password-toggle').click();
    document.getElementById('change-password-form').scrollIntoView({ block: 'end' }); return true;
  })()`);
  await syntheticPaste(credentials, 'current-password', false);
  await syntheticPaste(credentials, 'new-password', false);
  await syntheticPaste(credentials, 'confirm-password', false);
  await delay(100);
  const passwordScreenshot = await credentials.webContents.capturePage();
  fs.writeFileSync(path.join(repository, 'tmp', 'private-password-change-review.png'), passwordScreenshot.toPNG());
  const fillPasswordForm = async (old, next, confirmation) => evaluate(credentials, `(() => {
    for (const [id, value] of ${JSON.stringify([['current-password', old], ['new-password', next], ['confirm-password', confirmation]])}) {
      const field = document.getElementById(id); field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.getElementById('change-password-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return ['current-password', 'new-password', 'confirm-password'].every(id => document.getElementById(id).value === '');
  })()`);
  assert.equal(await fillPasswordForm(password, newPassword, newPassword + ' mismatch'), true);
  await waitForRenderer(credentials, "document.getElementById('password-status').textContent.includes('do not match')");
  assert.equal(await fillPasswordForm(password + ' incorrect', newPassword, newPassword), true);
  await waitForRenderer(credentials, "document.getElementById('password-status').textContent.includes('current password is incorrect')");
  assert.equal(credentials.isDestroyed(), false);
  const credentialSession = credentials.webContents.session;
  const credentialClosed = workspace.settled;
  assert.equal(await fillPasswordForm(password, newPassword, newPassword), true);
  await credentialClosed;
  assert.equal(credentials.isDestroyed(), true);
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assert.equal(await credentialSession.getCacheSize(), 0);
  assertRestoredMenu();
  setStage('password-change-reopen');
  assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'unavailable');
  assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), newPassword), 'opened');
  const afterChange = currentWindow();
  assertPrivateMenu();
  assert.notEqual(afterChange.webContents.session, credentialSession);
  await waitForRenderer(afterChange, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  setStage('gallery-unprotected-copy');
  afterChange.show(); afterChange.focus(); await delay(100);
  await evaluate(afterChange, "document.getElementById('protection-button').click(); true");
  await waitForRenderer(afterChange, "document.getElementById('auto-lock-minutes').value === '1' && !document.getElementById('auto-lock-minutes').disabled");
  await evaluate(afterChange, "document.getElementById('unprotected-copy-toggle').click(); document.getElementById('unprotected-copy-form').scrollIntoView({ block: 'end' }); true");
  await syntheticPaste(afterChange, 'unprotected-copy-password', false);
  await delay(100);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-unprotected-copy-review.png'), (await afterChange.webContents.capturePage()).toPNG());
  afterChange.setSize(600, 400); await delay(150);
  await evaluate(afterChange, "document.getElementById('unprotected-copy-submit').scrollIntoView({ block: 'end' }); true");
  const smallCopyLayout = await evaluate(afterChange, `(() => {
    const panel = document.getElementById('protection-panel').getBoundingClientRect();
    const button = document.getElementById('unprotected-copy-submit').getBoundingClientRect();
    return { panelFits: panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
      buttonFits: button.left >= panel.left && button.right <= panel.right && button.top >= panel.top && button.bottom <= panel.bottom };
  })()`);
  assert.deepEqual(smallCopyLayout, { panelFits: true, buttonFits: true });
  // Allow the visible compositor to paint the scroll before capturing its pixels.
  await delay(150);
  fs.writeFileSync(path.join(repository, 'tmp', 'private-unprotected-copy-small-review.png'), (await afterChange.webContents.capturePage()).toPNG());
  afterChange.setSize(1200, 800); await delay(150);
  const copyDestination = path.join(fixture, 'unprotected-copy');
  const originalSaveDialog = dialog.showSaveDialog;
  let savePickers = 0; let cancelCopyPicker = true;
  const sourceFingerprint = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
  const sourceBeforeCopy = sourceFingerprint();
  const fillCopyForm = async secret => evaluate(afterChange, `(() => {
    const password = document.getElementById('unprotected-copy-password');
    password.value = ${JSON.stringify(secret)}; password.dispatchEvent(new Event('input', { bubbles: true }));
    const acknowledge = document.getElementById('unprotected-copy-acknowledge');
    acknowledge.checked = true; acknowledge.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('unprotected-copy-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return password.value === '' && acknowledge.checked === false;
  })()`);
  dialog.showSaveDialog = async (owner, selection) => {
    assert.equal(owner, afterChange); assert.equal(selection.title, 'Create unprotected copy');
    assert.deepEqual(selection.properties, ['createDirectory', 'dontAddToRecent']);
    assert.equal(selection.securityScopedBookmarks, false); savePickers++;
    return { canceled: cancelCopyPicker, filePath: cancelCopyPicker ? undefined : copyDestination };
  };
  try {
    assert.equal(await fillCopyForm(newPassword + ' wrong'), true);
    await waitForRenderer(afterChange, "document.getElementById('unprotected-copy-status').textContent.includes('password is incorrect')");
    assert.equal(savePickers, 0);
    assert.equal(await fillCopyForm(newPassword), true);
    await waitForRenderer(afterChange, "document.getElementById('unprotected-copy-status').textContent.includes('cancelled')");
    assert.equal(savePickers, 1); assert.equal(fs.existsSync(copyDestination), false);
    cancelCopyPicker = false;
    assert.equal(await fillCopyForm(newPassword), true);
    await waitForRenderer(afterChange, "document.getElementById('unprotected-copy-status').textContent.includes('copy created')");
    assert.equal(savePickers, 2); assert.equal(afterChange.isDestroyed(), false);
    assert.deepEqual(sourceFingerprint(), sourceBeforeCopy);
    const copiedCatalogue = fs.readFileSync(path.join(copyDestination, marker + '.scaena'));
    try { assert.deepEqual(copiedCatalogue, expectedCopyCatalogue); }
    finally { copiedCatalogue.fill(0); expectedCopyCatalogue.fill(0); }
    const mediaRoot = path.join(copyDestination, 'vha-' + marker);
    assert.equal(fs.readdirSync(path.join(mediaRoot, 'thumbnails')).length, 57);
    for (const [index, [folder, extension]] of [['thumbnails', '.jpg'], ['filmstrips', '.jpg'], ['clips', '.jpg'], ['clips', '.mp4']].entries()) {
      const copiedPreview = fs.readFileSync(path.join(mediaRoot, folder, 'native-video' + extension));
      try { assert.equal(copiedPreview.toString('base64'), previewPatterns[index]); }
      finally { copiedPreview.fill(0); }
    }
    await checkpoint('unprotected-copy-created', { passwordBeforePicker: true, cancelledPickerNoOutput: true,
      copyCredentialsCleared: true, catalogueByteIdentical: true, generatedPreviewsIdentical: true,
      encryptedSourceUnchanged: true, sourceRemainsUnlocked: true, restrictedMenuRetained: assertPrivateMenu() !== ordinaryMenu,
      intentionalPlaintextDestination: 'excluded from private profile scan' }, previewPatterns);
  } finally { dialog.showSaveDialog = originalSaveDialog; expectedCopyCatalogue?.fill(0); }
  await workspace.cancel();
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assertRestoredMenu();
  await playbackResetAcceptance(directory, newPassword);
  setStage('gallery-system-lock');
  assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), newPassword), 'opened');
  const systemLocked = currentWindow();
  assertPrivateMenu();
  const systemSettled = workspace.settled;
  powerMonitor.emit('lock-screen');
  assert.equal(systemLocked.isDestroyed(), true);
  await systemSettled;
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assertRestoredMenu();
  await checkpoint('workspace-closed', { uiLock: true, synchronousRevocation: true, drained: true,
    freshGalleryPartition: true, fullscreenLockDrained: true, originalLockRetired: true, sourceConnectionsClearedOnLock: true, libraryViewClearedOnLock: true, ratingSavedReopened: true, savedMetadataReopened: true, generatedSetReopened: true,
    generatedMediaMarkersStripped: true, nativeInputRenewsDeadline: true, syntheticDomDoesNotRenew: true,
    automaticLockDrained: true, deadlineClock: 'advanced in main test',
    passwordChangeFormCleared: true, passwordMismatchRejected: true, incorrectCurrentRetryable: true,
    passwordChangeLocked: true, oldPasswordRejected: true, newPasswordReopened: true,
    systemLockDrained: true, originalMenuRestored: true, privateMenuObservations, restoredMenuObservations,
    credentialPasteAllowed: true, wrongPassword: 'unavailable', retryAvailable: true }, previewPatterns);
}

async function passwordRecoveryAcceptance(sourceDirectory, currentPassword, interruptedPassword) {
  setStage('password-recovery-fixture');
  const directory = path.join(fixture, 'password-recovery-hub');
  assert.equal(path.dirname(sourceDirectory), fixture);
  assert.equal(fs.realpathSync(sourceDirectory), sourceDirectory);
  const fingerprint = folder => Object.fromEntries(fs.readdirSync(folder).sort().map(name => {
    const file = path.join(folder, name); const stats = fs.lstatSync(file);
    assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1);
    return [name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
  const sourceBefore = fingerprint(sourceDirectory);
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of Object.keys(sourceBefore)) {
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(directory, name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(directory, name), 0o600);
  }
  const headerPath = path.join(directory, PRIVATE_HUB_HEADER_FILE);
  const pendingName = PRIVATE_HUB_HEADER_FILE + '.' + randomBytes(24).toString('hex') + '.pending';
  const stagedPath = path.join(directory, pendingName);
  const header = validatePrivateHubHeader(JSON.parse(fs.readFileSync(headerPath, 'utf8')));
  const key = await unlockPrivateHub(header, currentPassword);
  let stagedBytes;
  try {
    stagedBytes = Buffer.from(JSON.stringify(await changePrivateHubPassword(header, key, interruptedPassword)), 'utf8');
    fs.writeFileSync(stagedPath, stagedBytes, { flag: 'wx', mode: 0o600 });
  } finally { key.fill(0); stagedBytes?.fill(0); }
  const before = fingerprint(directory);
  const stagedIdentity = fs.lstatSync(stagedPath);
  const savedConfirmation = dialog.showMessageBox;
  let confirmations = 0;
  let accept = false;
  let window;
  workspace = createPrivateHubWorkspace({ appDirectory: path.join(repository, 'private-gallery'), promptVisible: false });
  dialog.showMessageBox = async (owner, options) => {
    assert.equal(owner, window);
    assert.equal(options.title, 'Finish interrupted password change?');
    assert.equal(options.message, 'Finish interrupted password change?');
    assert.deepEqual(options.buttons, ['Finish password change', 'Cancel']);
    assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 1); assert.equal(options.noLink, true);
    const text = JSON.stringify(options);
    for (const secret of [currentPassword, interruptedPassword, sourceDirectory, directory, pendingName]) {
      assert.equal(text.includes(secret), false, 'The confirmation must not disclose credentials or storage paths.');
    }
    confirmations++;
    return { response: accept ? 0 : 1, checkboxChecked: false };
  };
  try {
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), currentPassword), 'opened');
    window = currentWindow(); window.show(); window.focus(); await delay(100);
    assertPrivateMenu();
    const isolated = window.webContents.session;
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
    await evaluate(window, "document.getElementById('protection-button').click(); true");
    await waitForRenderer(window, "!document.getElementById('auto-lock-minutes').disabled");
    await evaluate(window, "document.getElementById('change-password-toggle').click(); true");
    window.setSize(600, 400); await delay(100);
    await evaluate(window, "document.getElementById('resume-password-submit').scrollIntoView({ block: 'end' }); true");
    assert.equal(await evaluate(window, `(() => {
      const panel = document.getElementById('protection-panel').getBoundingClientRect();
      const button = document.getElementById('resume-password-submit').getBoundingClientRect();
      return panel.left >= 0 && panel.top >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight
        && button.left >= panel.left && button.right <= panel.right
        && button.top >= panel.top && button.bottom <= panel.bottom && !document.getElementById('resume-password-submit').disabled;
    })()`), true);
    const submit = async (old, next) => evaluate(window, `(() => {
      for (const [id, value] of ${JSON.stringify([['current-password', old], ['new-password', next], ['confirm-password', next]])}) {
        const input = document.getElementById(id); input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('resume-password-submit').click();
      return ['current-password', 'new-password', 'confirm-password'].every(id => document.getElementById(id).value === '');
    })()`);
    setStage('password-recovery-wrong-password');
    assert.equal(await submit(currentPassword, interruptedPassword + ' incorrect'), true);
    await waitForRenderer(window, "document.getElementById('password-status').textContent.includes('interrupted change is incorrect')");
    assert.equal(confirmations, 0); assert.deepEqual(fingerprint(directory), before);
    setStage('password-recovery-cancel');
    assert.equal(await submit(currentPassword, interruptedPassword), true);
    await waitForRenderer(window, "document.getElementById('password-status').textContent.includes('left unfinished')");
    assert.equal(confirmations, 1); assert.deepEqual(fingerprint(directory), before);
    assert.equal(window.isDestroyed(), false); assertPrivateMenu();
    setStage('password-recovery-confirm');
    accept = true;
    const settled = workspace.settled;
    assert.equal(await submit(currentPassword, interruptedPassword), true);
    await settled;
    assert.equal(confirmations, 2); assert.equal(window.isDestroyed(), true);
    assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
    assert.equal(await isolated.getCacheSize(), 0); assertRestoredMenu();
    const after = fingerprint(directory);
    const expected = { ...before, [PRIVATE_HUB_HEADER_FILE]: before[pendingName] }; delete expected[pendingName];
    assert.deepEqual(after, expected, 'Only the authenticated pending envelope replaces the header; all encrypted records remain byte-identical.');
    assert.equal(fs.lstatSync(headerPath).ino, stagedIdentity.ino);
    assert.equal(fs.lstatSync(headerPath).dev, stagedIdentity.dev);
    assert.equal(fs.existsSync(headerPath + '.bak'), false);
    assert.deepEqual(fingerprint(sourceDirectory), sourceBefore, 'The original synthetic hub must remain unchanged.');
    setStage('password-recovery-reopen');
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), currentPassword), 'unavailable');
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), interruptedPassword), 'opened');
    window = currentWindow(); assertPrivateMenu(); assert.notEqual(window.webContents.session, isolated);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
    assert.equal(await window.webContents.session.getCacheSize(), 0);
    assert.deepEqual(fingerprint(directory), after);
    await workspace.cancel(); assertRestoredMenu();
    await checkpoint('password-change-resumed', { passwordRecoveryCredentialsCleared: true,
      passwordRecoveryWrongPasswordNoConfirmation: true, passwordRecoveryCancelUnchanged: true,
      passwordRecoveryDefaultCancel: true, passwordRecoveryCompactFits: true, passwordRecoveryLocked: true,
      passwordRecoveryAdoptedStagingInode: true, passwordRecoveryRecordsUnchanged: true,
      passwordRecoverySourceUnchanged: true, passwordRecoveryOldPasswordRejected: true,
      passwordRecoveryNewPasswordReopened: true, passwordRecoveryFreshPartition: true, passwordRecoveryCacheEmpty: true });
  } finally { dialog.showMessageBox = savedConfirmation; await workspace.cancel(); }
}

// This provider is fixture-only memory. It never loads the native addon, uses a
// real Keychain, prompts for biometrics or claims to verify OS authentication.
async function syntheticTouchIdControls(directory, password) {
  setStage('touch-id-synthetic-opening');
  const entries = new Map();
  let enrollments = 0;
  let unlocks = 0;
  let returnedSecret;
  let enrolledInput;
  const touchId = {
    availability: async () => 'available',
    has: async identity => entries.has(identity),
    enroll: async (identity, secret, signal) => {
      assert.equal(signal.aborted, false);
      assert.ok(Buffer.isBuffer(secret) && secret.length === 64);
      assert.equal(entries.has(identity), false);
      enrolledInput = secret;
      entries.set(identity, Buffer.from(secret)); enrollments++;
      return 'enrolled';
    },
    unlock: async (identity, signal) => {
      assert.equal(signal.aborted, false);
      // The real coordinator must destroy/drain the credential window first.
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
      const stored = entries.get(identity);
      returnedSecret = stored && Buffer.from(stored); unlocks++;
      return returnedSecret;
    },
    remove: async (identity, signal) => {
      assert.equal(signal.aborted, false);
      entries.get(identity)?.fill(0); entries.delete(identity); return true;
    },
  };
  workspace = new PrivateHubWorkspace(new PrivateHubOpenCoordinator({
    createSession: () => new PrivateHubSession({ touchId }),
    touchIdAvailable: (selectedDirectory, lifetime) => PrivateHubStore.touchIdAvailable(selectedDirectory, touchId, lifetime.signal),
    requestPassword: lifetime => PrivateHubBrowser.requestPassword({ ...lifetime, visible: false }),
    createBrowser: ({ hub: ownedHub, generation, signal, isCurrent }) => PrivateHubBrowser.create({
      hub: ownedHub, generation, signal, isAuthorized: isCurrent, appDirectory: path.join(repository, 'private-gallery'),
    }),
  }));
  const options = { directory, isAuthorized: () => true };
  try {
    assert.equal(await completeWorkspacePrompt(workspace.open(options), password), 'opened');
    let window = currentWindow(); window.show(); window.focus(); await delay(100);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
    await evaluate(window, "document.getElementById('protection-button').click(); true");
    await waitForRenderer(window, "!document.getElementById('touch-id-toggle').hidden && !document.getElementById('touch-id-toggle').disabled");
    assert.equal(entries.size, 0);
    await evaluate(window, "document.getElementById('touch-id-toggle').click(); document.getElementById('touch-id-form').scrollIntoView({ block: 'end' }); true");
    await syntheticPaste(window, 'touch-id-password', false);
    await delay(100);
    fs.writeFileSync(path.join(repository, 'tmp', 'private-touch-id-protection-review.png'), (await window.webContents.capturePage()).toPNG());
    const size = window.getSize(); window.setSize(600, 400); await delay(100);
    await evaluate(window, "document.getElementById('touch-id-submit').scrollIntoView({ block: 'end' }); true");
    const compact = await evaluate(window, `(() => {
      const panel = document.getElementById('protection-panel').getBoundingClientRect();
      const submit = document.getElementById('touch-id-submit').getBoundingClientRect();
      return { fits: panel.left >= 0 && panel.right <= innerWidth && panel.bottom <= innerHeight,
        reachable: submit.top >= panel.top && submit.bottom <= panel.bottom };
    })()`);
    assert.deepEqual(compact, { fits: true, reachable: true });
    fs.writeFileSync(path.join(repository, 'tmp', 'private-touch-id-protection-small-review.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(...size); await delay(100);
    const enroll = async secret => evaluate(window, `(() => {
      const password = document.getElementById('touch-id-password'); password.value = ${JSON.stringify(secret)};
      password.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('touch-id-form').requestSubmit(); return password.value === '';
    })()`);
    setStage('touch-id-synthetic-enrollment');
    assert.equal(await enroll(password + ' incorrect'), true);
    await waitForRenderer(window, "document.getElementById('touch-id-status').textContent.includes('password is incorrect')");
    assert.equal(enrollments, 0); assert.equal(entries.size, 0);
    assert.equal(await enroll(password), true);
    await waitForRenderer(window, "document.getElementById('touch-id-summary').textContent.includes('is on') && !document.getElementById('touch-id-disable').disabled");
    assert.equal(enrollments, 1); assert.equal(entries.size, 1);
    assert.ok(enrolledInput.every(byte => byte === 0));
    assert.equal(await evaluate(window, "document.getElementById('touch-id-form').hidden && document.getElementById('touch-id-password').value === ''"), true);
    await evaluate(window, "document.getElementById('touch-id-disable').click(); true");
    await waitForRenderer(window, "document.getElementById('touch-id-summary').textContent.includes('is off') && !document.getElementById('touch-id-toggle').disabled");
    assert.equal(entries.size, 0);
    await evaluate(window, "document.getElementById('touch-id-toggle').click(); true");
    assert.equal(await enroll(password), true);
    await waitForRenderer(window, "document.getElementById('touch-id-summary').textContent.includes('is on') && !document.getElementById('touch-id-disable').disabled");
    const closed = workspace.settled;
    void evaluate(window, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
    await closed; assertRestoredMenu();

    setStage('touch-id-synthetic-unlock');
    const opening = workspace.open(options);
    let prompt;
    for (let index = 0; index < 300; index++) {
      prompt = BrowserWindow.getAllWindows()[0];
      if (prompt && !prompt.isDestroyed()) {
        try { if (await evaluate(prompt, "document.readyState === 'complete' && !!window.privateUnlock && !document.getElementById('use-touch-id').hidden")) { break; } }
        catch { /* Initial navigation. */ }
      }
      prompt = undefined; await delay(10);
    }
    assert.ok(prompt); assertPrivateMenu();
    assert.equal(await evaluate(prompt, "!document.getElementById('password').disabled && !document.getElementById('unlock').disabled"), true);
    void evaluate(prompt, "document.getElementById('use-touch-id').click(); true").catch(() => undefined);
    assert.equal(await opening, 'opened');
    assert.equal(prompt.isDestroyed(), true); assert.equal(unlocks, 1);
    assert.ok(returnedSecret.every(byte => byte === 0));
    window = currentWindow(); window.show(); window.focus(); await delay(100);
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
    await evaluate(window, "document.getElementById('protection-button').click(); true");
    await waitForRenderer(window, "!document.getElementById('touch-id-disable').hidden && !document.getElementById('touch-id-disable').disabled");
    await evaluate(window, "document.getElementById('touch-id-disable').click(); true");
    await waitForRenderer(window, "document.getElementById('touch-id-summary').textContent.includes('is off') && !document.getElementById('touch-id-toggle').disabled");
    assert.equal(entries.size, 0);
    await workspace.cancel(); assertRestoredMenu();
    await checkpoint('touch-id-synthetic', { touchIdControlsSyntheticProvider: true, wrongPasswordBeforeEnrollment: true,
      credentialCleared: true, enrollmentDisableAndReenable: true, passwordFallbackVisible: true,
      promptDrainedBeforeUnlock: true, reopenedCatalogue: true, temporarySecretsWiped: true,
      compactEnrollmentFits: true, credentialPasteAllowed: true, originalMenuRestored: true });
  } finally {
    await workspace.cancel();
    for (const value of entries.values()) { value.fill(0); }
    entries.clear();
  }
}

async function sourceCheckAcceptance(password, marker) {
  setStage('source-check-setup');
  const directory = path.join(fixture, 'source-check-hub');
  const source = path.join(fixture, 'source-check-originals');
  const outside = path.join(fixture, 'source-check-outside.mp4');
  fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'nested')); fs.mkdirSync(path.join(source, 'Ignored'));
  fs.writeFileSync(path.join(source, 'same.mp4'), '0123456789');
  fs.writeFileSync(path.join(source, 'different.mp4'), 'different');
  fs.writeFileSync(path.join(source, 'unknown.mp4'), '0123456789');
  fs.writeFileSync(path.join(source, 'nested', 'match.mp4'), '0123456789');
  fs.writeFileSync(path.join(source, 'Ignored', 'skip.mp4'), '0123456789');
  fs.writeFileSync(outside, 'Outside synthetic source');
  fs.symlinkSync(outside, path.join(source, 'linked.mp4'));
  fs.mkdirSync(path.join(source, 'directory.mp4'));
  const entries = [['same.mp4', '/', 10], ['different.mp4', '/', 10], ['missing.mp4', '/', 10],
    ['unknown.mp4', '/', 0], ['linked.mp4', '/', 10], ['skip.mp4', '/Ignored', 10],
    ['match.mp4', '/nested', 10], ['directory.mp4', '/', 10]];
  const catalogue = { addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: entries.map(([fileName, partialPath, fileSize], index) => ({ ...NewImageElement(),
      hash: 'source-check-' + index, fileName, partialPath, fileSize, inputSource: 0,
      cleanName: 'Synthetic checked file ' + index, notes: marker, screens: 3, width: 256, height: 144 })),
    inputDirs: { 0: { path: source, watch: false, ignoredSubdirectories: ['Ignored'] } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 } };
  catalogue.images[0].locations = [
    { inputSource: 0, fileName: 'same.mp4', partialPath: '/' },
    { inputSource: 0, fileName: 'match.mp4', partialPath: '/nested' },
  ];
  // Reuse an encrypted synthetic preview solely for fixture setup. The check
  // itself may not open original media or create any catalogue/preview record.
  const reference = await PrivateHubStore.open(path.join(fixture, 'private-hub'), password);
  let thumbnail;
  try { thumbnail = await readPrivateHubPreview(reference, 'thumbnail', 'native-video'); }
  finally { await reference.lock(); }
  const store = await PrivateHubStore.create(directory, password);
  try {
    await writePrivateHubCatalogue(store, catalogue);
    for (const image of catalogue.images) { await writePrivateHubPreview(store, 'thumbnail', image.hash, thumbnail); }
    const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
    try { await store.writeNewRecord('session:activation', activation); } finally { activation.fill(0); }
  } finally { thumbnail.fill(0); await store.lock(); }
  const fingerprint = folder => Object.fromEntries(fs.readdirSync(folder).sort().map(name => {
    const file = path.join(folder, name); const stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory()
      ? fingerprint(file) : createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
  const originals = fingerprint(source); const encrypted = fingerprint(directory);
  const expected = { status: 'checked', total: 9, sameSize: 3, differentSize: 1, missing: 1, unverified: 3, ignored: 1 };
  const oldPicker = dialog.showOpenDialog;
  const oldStat = fs.promises.lstat;
  let mode = 'cancel'; let selections = 0; let releasePicker;
  let holdMetadata = false; let releaseMetadata;
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, currentWindow()); assert.equal(options.defaultPath, source);
    assert.ok(options.properties.includes('dontAddToRecent')); selections++;
    if (mode === 'hold') { await new Promise(resolve => { releasePicker = resolve; }); }
    return { canceled: mode === 'cancel', filePaths: mode === 'cancel' ? [] : [source] };
  };
  fs.promises.lstat = async function(target, ...args) {
    if (holdMetadata && String(target) === path.join(source, 'same.mp4')) {
      holdMetadata = false; await new Promise(resolve => { releaseMetadata = resolve; });
    }
    return oldStat.call(this, target, ...args);
  };
  const checker = require('./private-source-check.ts');
  const oldCheck = checker.checkPrivateSource;
  const reports = [];
  checker.checkPrivateSource = async options => {
    const result = await oldCheck(options); reports.push(result); return result;
  };
  let window;
  const action = "document.querySelector('#source-folders-list [data-action=check-source]')";
  const ready = () => waitForRenderer(window, `${action} && !${action}.disabled && !document.getElementById('refresh-source-folders').disabled`);
  const open = async () => {
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'opened');
    window = currentWindow();
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 8");
  };
  try {
    await open();
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, "!document.getElementById('details-notes').readOnly");
    const draft = marker + ' unsaved source check';
    await evaluate(window, `(() => { const el = document.getElementById('details-notes'); el.value = ${JSON.stringify(draft)};
      el.dispatchEvent(new Event('input', {bubbles:true})); document.getElementById('source-folders-toggle').click(); })()`);
    await ready();
    setStage('source-check-cancel-picker');
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(selections, 1); assert.equal(reports.length, 0);
    assert.match(await evaluate(window, "document.getElementById('source-folders-status').textContent"), /cancel/i);
    assert.deepEqual(fingerprint(directory), encrypted);
    setStage('source-check-counts');
    mode = 'grant';
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(reports.length, 1);
    const displayed = await evaluate(window, "document.getElementById('source-folders-status').textContent");
    for (const value of ['9 saved file locations', 'Same recorded size: 3', 'Different size: 1', 'Missing: 1', 'Not verified: 3', 'Ignored: 1', 'does not prove']) { assert.ok(displayed.includes(value), value); }
    const { revision, ...report } = reports[0]; assert.deepEqual(report, expected);
    assert.equal(typeof revision, 'string');
    assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), draft);
    assert.equal(await evaluate(window, "document.getElementById('save-details').disabled"), false);
    const sources = await evaluate(window, 'window.privateGallery.sources()');
    assert.equal(sources.items[0].connected, true);
    assert.deepEqual(await evaluate(window, `window.privateGallery.checkSource(${JSON.stringify(sources.items[0].id)})`), expected);
    assert.equal(selections, 2, 'A connected root is reused without another picker.');
    window.setSize(600, 400); window.show(); await delay(100);
    await evaluate(window, `${action}.scrollIntoView({block:'center'}); true`);
    await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate(window, `(() => { const el = ${action}; const r = el.getBoundingClientRect();
      const p = document.getElementById('source-folders-panel').getBoundingClientRect();
      return r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom
        && el.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)); })()`), true);
    fs.writeFileSync(path.join(repository, 'tmp/private-source-check-stage/compact-check.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate(window, "document.getElementById('source-folders-status').scrollIntoView({block:'end'}); true");
    await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    fs.writeFileSync(path.join(repository, 'tmp/private-source-check-stage/compact-report.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1200, 800);
    setStage('source-check-cancel-metadata');
    holdMetadata = true;
    await evaluate(window, `${action}.click(); true`);
    for (let attempt = 0; attempt < 500 && !releaseMetadata; attempt++) { await delay(10); }
    assert.equal(typeof releaseMetadata, 'function');
    await evaluate(window, "document.getElementById('cancel-source-connection').click(); true");
    assert.equal(await evaluate(window, "document.getElementById('refresh-source-folders').disabled"), true);
    releaseMetadata(); releaseMetadata = undefined; await ready();
    assert.match(await evaluate(window, "document.getElementById('source-folders-status').textContent"), /cancel/i);
    assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), draft);
    setStage('source-check-disconnected');
    const moved = path.join(fixture, 'source-check-disconnected');
    fs.renameSync(source, moved);
    try {
      assert.deepEqual(await evaluate(window, `window.privateGallery.checkSource(${JSON.stringify(sources.items[0].id)})`), { status: 'source-unavailable' });
    } finally { fs.renameSync(moved, source); }
    await evaluate(window, `${action}.click(); true`); await ready();
    assert.equal(selections, 4, 'A replaced or disconnected root requires a fresh selection.');
    setStage('source-check-lock-picker');
    await evaluate(window, "document.querySelector('#source-folders-list [data-action=disconnect-source]').click(); true"); await ready();
    mode = 'hold'; await evaluate(window, `${action}.click(); true`);
    for (let attempt = 0; attempt < 500 && !releasePicker; attempt++) { await delay(10); }
    assert.equal(typeof releasePicker, 'function');
    const settled = workspace.settled; let finished = false; void settled.then(() => { finished = true; });
    void evaluate(window, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
    await delay(30); assert.equal(finished, false);
    releasePicker(); releasePicker = undefined; await settled;
    assert.equal(window.isDestroyed(), true); assertRestoredMenu();
    assert.deepEqual(fingerprint(directory), encrypted); assert.deepEqual(fingerprint(source), originals);
    setStage('source-check-reopen');
    await open();
    const reopened = await evaluate(window, 'window.privateGallery.sources()');
    assert.equal(reopened.items[0].connected, false);
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
    await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(marker)}`);
    await workspace.cancel(); assertRestoredMenu();
    await checkpoint('source-files-checked', { sourceCheckCounts: true, sourceCheckPathsMainOnly: true,
      sourceCheckGrantReused: true, sourceCheckPickerCancellation: true, sourceCheckMetadataCancellation: true,
      sourceCheckDisconnectedRefused: true, sourceCheckReconnect: true, sourceCheckDraftPreserved: true,
      sourceCheckNoCatalogueWrite: true, sourceCheckOriginalUnchanged: true, sourceCheckCompactFits: true,
      sourceCheckLockDrainedPicker: true, sourceCheckLateGrantRefused: true, sourceCheckSessionOnly: true });
  } catch (error) {
    fs.writeFileSync(path.join(repository, 'tmp/private-source-check-stage/native-failure.txt'), String(error?.stack || error));
    throw error;
  } finally {
    releaseMetadata?.(); releasePicker?.(); dialog.showOpenDialog = oldPicker;
    fs.promises.lstat = oldStat; checker.checkPrivateSource = oldCheck;
  }
}

async function videoRefreshAcceptance(password, marker) {
  setStage('video-refresh-setup');
  const directory = path.join(fixture, 'refresh-hub');
  const sourceRoot = path.join(fixture, 'refresh-originals');
  fs.mkdirSync(sourceRoot);
  const file = path.join(sourceRoot, 'refresh.mp4');
  fs.copyFileSync(path.join(fixture, 'synthetic-source', 'synthetic-0.mp4'), file);
  const originalDigest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const original = { ...NewImageElement(), hash: 'before-refresh', cleanName: 'Synthetic refresh video',
    fileName: 'refresh.mp4', partialPath: '/', inputSource: 0, fileSize: 1, duration: 1200,
    width: 1920, height: 1080, fps: 30, screens: 20, defaultScreen: 19,
    notes: marker, tags: ['Keep this tag'], stars: 5.5, timesPlayed: 7, lastPlayed: 1700000000000,
    dateAdded: 1600000000000, year: '2020', playlist: 123, extraSynthetic: { retained: marker } };
  const alias = { ...original, hash: 'refresh-alias', cleanName: 'Synthetic alternate locations',
    locations: [{ inputSource: 0, partialPath: '/', fileName: 'refresh.mp4' },
      { inputSource: 0, partialPath: '/', fileName: 'other.mp4' }] };
  const catalogue = { addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: [original, alias], inputDirs: { 0: { path: sourceRoot, watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
    extraSynthetic: { retained: marker } };
  const reference = await PrivateHubStore.open(path.join(fixture, 'private-hub'), password);
  let thumbnail;
  try { thumbnail = await readPrivateHubPreview(reference, 'thumbnail', 'native-video'); }
  finally { await reference.lock(); }
  const store = await PrivateHubStore.create(directory, password);
  try {
    const bytes = Buffer.from(JSON.stringify(catalogue));
    try { await store.writeRecord('catalogue', bytes); } finally { bytes.fill(0); }
    for (const image of catalogue.images) { await writePrivateHubPreview(store, 'thumbnail', image.hash, thumbnail); }
    const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
    try { await store.writeNewRecord('session:activation', activation); } finally { activation.fill(0); }
  } finally { thumbnail.fill(0); await store.lock(); }
  const encryptedFingerprint = () => Object.fromEntries(fs.readdirSync(directory).sort().map(name =>
    [name, createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
  const before = encryptedFingerprint();
  const oldPicker = dialog.showOpenDialog;
  const oldRefresh = PrivateHubSession.prototype.refreshVideo;
  let pickerCancelled = true; let picks = 0; let holdAfterPublication = false; let releasePublication;
  const results = [];
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, currentWindow()); assert.equal(options.defaultPath, sourceRoot);
    assert.ok(options.properties.includes('dontAddToRecent')); picks++;
    return { canceled: pickerCancelled, filePaths: pickerCancelled ? [] : [sourceRoot] };
  };
  PrivateHubSession.prototype.refreshVideo = async function(...args) {
    const result = await oldRefresh.apply(this, args); results.push(result);
    if (holdAfterPublication && result.status === 'refreshed') {
      holdAfterPublication = false; await new Promise(resolve => { releasePublication = resolve; });
    }
    return result;
  };
  let window;
  const ready = () => waitForRenderer(window, "!document.getElementById('refresh-video').disabled && document.getElementById('cancel-regeneration').hidden");
  const open = async () => {
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'opened');
    window = currentWindow();
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 2");
  };
  const select = async title => {
    await evaluate(window, `Array.from(document.querySelectorAll('#gallery-grid .video-card')).find(el => el.textContent.includes(${JSON.stringify(title)})).click(); true`);
    await waitForRenderer(window, `document.getElementById('details-title').textContent === ${JSON.stringify(title)} && !document.getElementById('details-notes').readOnly`);
  };
  try {
    await open(); await select(alias.cleanName);
    assert.equal(await evaluate(window, "document.getElementById('refresh-video').disabled"), true);
    await select(original.cleanName); await ready();
    setStage('video-refresh-draft');
    await evaluate(window, `(() => { const el=document.getElementById('details-notes'); el.value=${JSON.stringify(marker + ' unsaved refresh')}; el.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('refresh-video').click(); })()`);
    assert.equal(results.length, 0); assert.equal(picks, 0);
    assert.equal(await evaluate(window, 'document.getElementById("details-notes").value'), marker + ' unsaved refresh');
    await evaluate(window, "document.getElementById('discard-details').click(); true"); await ready();
    setStage('video-refresh-cancel-picker');
    await evaluate(window, "document.getElementById('refresh-video').click(); true"); await ready();
    assert.equal(picks, 1); assert.equal(results.length, 0); assert.deepEqual(encryptedFingerprint(), before);
    pickerCancelled = false;
    setStage('video-refresh-publish');
    await evaluate(window, "document.getElementById('refresh-video').click(); true"); await ready();
    assert.equal(await evaluate(window, "document.getElementById('generation-status').textContent"), 'Video refreshed.');
    assert.equal(results.length, 1); assert.equal(results[0].status, 'refreshed');
    const saved = results[0].image;
    assert.notEqual(saved.hash, original.hash); assert.match(saved.hash, /^[a-f0-9]{32}$/);
    assert.equal(saved.duration, 4); assert.equal(saved.width, 32); assert.equal(saved.height, 18);
    assert.equal(saved.fps, 10); assert.equal(saved.screens, 3); assert.equal(saved.fileSize, fs.statSync(file).size);
    assert.equal(saved.defaultScreen, undefined);
    const changed = new Set(['hash','fileSize','birthtime','mtime','duration','width','height','fps','bitrate','screens','defaultScreen']);
    for (const [key, value] of Object.entries(original)) { if (!changed.has(key)) { assert.deepEqual(saved[key], value, key); } }
    assert.equal(await evaluate(window, 'document.getElementById("details-notes").value'), marker);
    assert.ok((await evaluate(window, 'document.getElementById("details-facts").textContent')).includes('32'));
    await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
    await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 768 && !document.getElementById('detail-filmstrip').hidden");
    await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256");
    const firstStrip = await evaluate(window, 'document.getElementById("detail-filmstrip").currentSrc');
    assert.ok(firstStrip.includes(saved.hash));
    window.setSize(600,400); window.show(); await delay(100);
    await evaluate(window, "document.getElementById('refresh-video').scrollIntoView({block:'center'}); true");
    await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate(window, `(() => { const el=document.getElementById('refresh-video'); const r=el.getBoundingClientRect();
      return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && el.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)); })()`), true);
    fs.writeFileSync(path.join(repository,'tmp/private-refresh-stage/compact-refresh.png'),(await window.webContents.capturePage()).toPNG());
    window.setSize(1200,800);
    setStage('video-refresh-cancel-published');
    holdAfterPublication = true;
    await evaluate(window, "document.getElementById('refresh-video').click(); true");
    for (let attempt=0; attempt<1000 && !releasePublication; attempt++) { await delay(10); }
    assert.equal(typeof releasePublication,'function');
    await evaluate(window, "document.getElementById('cancel-regeneration').click(); true");
    assert.equal(await evaluate(window, "document.getElementById('refresh-video').disabled"),true);
    releasePublication(); releasePublication=undefined; await ready();
    assert.equal(results.length,2); assert.equal(results[1].status,'refreshed');
    assert.notEqual(results[1].image.hash,saved.hash); assert.equal(picks,2,'The connected source grant is reused.');
    await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
    await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 768 && !document.getElementById('detail-filmstrip').hidden");
    assert.ok((await evaluate(window, 'document.getElementById("detail-filmstrip").currentSrc')).includes(results[1].image.hash));
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),originalDigest);
    await workspace.cancel(); assertRestoredMenu();
    const stored = await PrivateHubStore.open(directory,password);
    try {
      const bytes=await stored.readRecord('catalogue');
      try {
        const actual=JSON.parse(bytes.toString('utf8'));
        assert.deepEqual(actual.images[0],results[1].image); assert.deepEqual(actual.images[1],alias);
        assert.deepEqual(actual.extraSynthetic,catalogue.extraSynthetic);
        const set=await readPrivatePreviewSet(stored,actual.images[0].hash); assert.equal(set.screenCount,3);
      } finally { bytes.fill(0); }
    } finally { await stored.lock(); }
    setStage('video-refresh-reopen');
    await open(); await select(original.cleanName); await ready();
    assert.equal(await evaluate(window, 'document.getElementById("details-notes").value'),marker);
    await evaluate(window,"document.getElementById('toggle-filmstrip').click(); true");
    await waitForRenderer(window,"document.getElementById('detail-filmstrip').naturalWidth === 768 && !document.getElementById('detail-filmstrip').hidden");
    assert.ok((await evaluate(window, 'document.getElementById("detail-filmstrip").currentSrc')).includes(results[1].image.hash));
    await workspace.cancel(); assertRestoredMenu();
    await checkpoint('video-refreshed',{refreshPickerCancelled:true,refreshDraftGuard:true,refreshAliasedRefused:true,
      refreshMetadataSaved:true,refreshGeometrySaved:true,refreshPreviewsDecoded:true,refreshUserMetadataPreserved:true,
      refreshOriginalUnchanged:true,refreshGrantReused:true,refreshCancelAfterPublication:true,refreshCompactFits:true,refreshReopened:true});
  } catch(error) {
    fs.writeFileSync(path.join(repository,'tmp/private-refresh-stage/native-failure.txt'),String(error?.stack || error)); throw error;
  } finally { releasePublication?.(); dialog.showOpenDialog=oldPicker; PrivateHubSession.prototype.refreshVideo=oldRefresh; }
}

async function customThumbnailAcceptance(password, marker) {
  setStage('custom-thumbnail-setup');
  const directory = path.join(fixture, 'custom-thumbnail-hub');
  const sourceRoot = path.join(fixture, 'custom-thumbnail-originals');
  const reviewRoot = path.join(repository, 'tmp/private-png-thumbnail-stage');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(reviewRoot, { recursive: true });
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const fingerprint = folder => Object.fromEntries(fs.readdirSync(folder).sort().map(name =>
    [name, digest(fs.readFileSync(path.join(folder, name)))]));
  // The fixtures are created locally: a metadata-bearing JPEG and an RGBA PNG.
  // PNG construction avoids depending on an encoder that the app does not need.
  const pngChunk = (type, body) => {
    const typeBytes = Buffer.from(type, 'ascii');
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([typeBytes, body])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    }
    const header = Buffer.alloc(8); header.writeUInt32BE(body.length); typeBytes.copy(header, 4);
    const footer = Buffer.alloc(4); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const images = ['jpg', 'png'].map((extension, index) => {
    const file = path.join(sourceRoot, 'chosen-' + index + '.' + extension);
    if (extension === 'jpg') {
      const encoded = spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=gold:size=64x36', '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { cwd: repository, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(encoded.status, 0); validatePrivateJpeg(encoded.stdout, 64, 36);
      const comment = Buffer.from(marker); const header = Buffer.alloc(4);
      header.writeUInt16BE(0xfffe, 0); header.writeUInt16BE(comment.length + 2, 2);
      const jpeg = Buffer.concat([encoded.stdout.subarray(0, 2), header, comment, encoded.stdout.subarray(2)]);
      try { fs.writeFileSync(file, jpeg); } finally { jpeg.fill(0); comment.fill(0); encoded.stdout.fill(0); }
    } else {
      const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(36, 4);
      header[8] = 8; header[9] = 6; // RGBA, 8-bit samples, non-interlaced.
      const pixels = Buffer.alloc((64 * 4 + 1) * 36);
      for (let y = 0; y < 36; y++) {
        for (let x = 0; x < 64; x++) {
          const position = y * (64 * 4 + 1) + 1 + x * 4;
          pixels[position] = 128; pixels[position + 2] = 128;
          pixels[position + 3] = x < 16 ? 0 : x < 24 ? 128 : 255;
        }
      }
      const metadata = Buffer.from('Description\0' + marker);
      const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', header), pngChunk('tEXt', metadata), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
      try { fs.writeFileSync(file, png); } finally { png.fill(0); pixels.fill(0); metadata.fill(0); }
    }
    return file;
  });
  const originals = fingerprint(sourceRoot);
  const original = { ...NewImageElement(), hash: 'custom-thumbnail-video', cleanName: 'Synthetic custom thumbnail video',
    fileName: 'unavailable.mp4', partialPath: '/', inputSource: 0, fileSize: 123, screens: 3, duration: 42,
    width: 1920, height: 1080, notes: marker, tags: ['Retained tag'], stars: 4.5, timesPlayed: 7,
    lastPlayed: 1700000000000, extraSynthetic: { retained: marker } };
  const catalogue = { addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
    images: [original], inputDirs: { 0: { path: path.join(fixture, 'missing-custom-thumbnail-video-source'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 3 },
    extraSynthetic: { retained: marker } };
  const catalogueBytes = Buffer.from(JSON.stringify(catalogue));
  const reference = await PrivateHubStore.open(path.join(fixture, 'private-hub'), password);
  const previews = new Map();
  try {
    for (const kind of ['thumbnail', 'filmstrip', 'clip-poster', 'clip']) {
      previews.set(kind, await readPrivateHubPreview(reference, kind, 'native-video'));
    }
  } finally { await reference.lock(); }
  const store = await PrivateHubStore.create(directory, password);
  try {
    await store.writeRecord('catalogue', catalogueBytes);
    for (const [kind, bytes] of previews) { await writePrivateHubPreview(store, kind, original.hash, bytes); }
    const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
    try { await store.writeNewRecord('session:activation', activation); } finally { activation.fill(0); }
  } finally { await store.lock(); }
  const before = fingerprint(directory);
  const oldPicker = dialog.showOpenDialog;
  const oldSetThumbnail = PrivateHubSession.prototype.setCustomThumbnail;
  let mode = 'cancel'; let selected = images[0]; let picks = 0; let imports = 0; let releasePicker;
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, currentWindow());
    assert.deepEqual(options.properties, ['openFile', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false);
    assert.deepEqual(options.filters.flatMap(filter => filter.extensions).sort(), ['jpeg', 'jpg', 'png']);
    picks++;
    if (mode === 'hold') { await new Promise(resolve => { releasePicker = resolve; }); }
    return { canceled: mode === 'cancel', filePaths: mode === 'cancel' ? [] : [selected] };
  };
  PrivateHubSession.prototype.setCustomThumbnail = async function(...args) {
    const result = await oldSetThumbnail.apply(this, args); imports++; return result;
  };
  let window; const previewPatterns = [];
  const ready = () => waitForRenderer(window, "!document.getElementById('choose-thumbnail').disabled && document.getElementById('cancel-regeneration').hidden");
  const open = async () => {
    assert.equal(await completeWorkspacePrompt(workspace.open({ directory, isAuthorized: () => true }), password), 'opened');
    window = currentWindow();
    await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
    await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true"); await ready();
    await waitForRenderer(window, "document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256 && document.getElementById('detail-poster').naturalWidth === 256");
  };
  const displayedColour = (horizontalFraction = 0.5) => evaluate(window, `(() => { const image=document.querySelector('#gallery-grid .video-card img');
    const canvas=document.createElement('canvas'); canvas.width=1; canvas.height=1; const context=canvas.getContext('2d');
    context.drawImage(image,Math.floor(image.naturalWidth*${horizontalFraction}),Math.floor(image.naturalHeight/2),1,1,0,0,1,1);
    return Array.from(context.getImageData(0,0,1,1).data); })()`);
  const purpleDisplayed = async () => {
    const pixel = await displayedColour(); assert.ok(pixel[0] > 100 && pixel[1] < 30 && pixel[2] > 100);
    const transparent = await displayedColour(8 / 64);
    assert.ok(transparent.slice(0, 3).every(channel => channel < 12) && transparent[3] === 255,
      'Transparent PNG pixels must be flattened onto black, without exposing hidden RGB.');
    const translucent = await displayedColour(20 / 64);
    assert.ok(translucent[0] > 52 && translucent[0] < 76 && translucent[1] < 12
      && translucent[2] > 52 && translucent[2] < 76 && translucent[3] === 255,
    'Partially transparent PNG pixels must be composited over black.');
  };
  const inspect = async (copy = false) => {
    const stored = await PrivateHubStore.open(directory, password);
    try {
      const currentCatalogue = await stored.readRecord('catalogue');
      try { assert.deepEqual(currentCatalogue, catalogueBytes, 'Choosing a thumbnail must preserve the exact raw catalogue.'); }
      finally { currentCatalogue.fill(0); }
      for (const [kind, expected] of previews) {
        const bytes = await readPrivateHubPreview(stored, kind, original.hash);
        try {
          if (kind === 'thumbnail') {
            validatePrivateJpeg(bytes, 256, 144); assert.notDeepEqual(bytes, expected);
            assert.equal(bytes.includes(Buffer.from(marker)), false, 'Custom image metadata must be stripped.');
            previewPatterns.push(bytes.toString('base64'));
          } else { assert.deepEqual(bytes, expected, 'Choosing a thumbnail must preserve other preview bytes.'); }
        } finally { bytes.fill(0); }
      }
      if (copy) {
        const destination = path.join(fixture, 'custom-thumbnail-plaintext-copy');
        const { exportPrivateHubToPlaintext } = require('./private-hub-plaintext-export.ts');
        const exported = await exportPrivateHubToPlaintext(stored, { destinationDirectory: destination, assertSourceQuiescent: () => {} });
        assert.equal(exported.previewCount, 4);
        const copiedCatalogue = fs.readFileSync(path.join(destination, marker + '.scaena'));
        try { assert.deepEqual(copiedCatalogue, catalogueBytes); } finally { copiedCatalogue.fill(0); }
        const copied = fs.readFileSync(path.join(destination, 'vha-' + marker, 'thumbnails', original.hash + '.jpg'));
        try { assert.equal(copied.toString('base64'), previewPatterns.at(-1)); } finally { copied.fill(0); }
        fs.writeFileSync(path.join(fixture, 'custom-thumbnail-expected.json'), JSON.stringify({
          catalogue: digest(catalogueBytes), thumbnail: digest(Buffer.from(previewPatterns.at(-1), 'base64')),
          filmstrip: digest(previews.get('filmstrip')), poster: digest(previews.get('clip-poster')), clip: digest(previews.get('clip')),
        }));
      }
    } finally { await stored.lock(); }
  };
  try {
    await open();
    const sources = await evaluate(window, 'window.privateGallery.sources()');
    assert.equal(sources.items[0].connected, false);
    await evaluate(window, "document.getElementById('toggle-filmstrip').click(); true");
    await waitForRenderer(window, "document.getElementById('detail-filmstrip').naturalWidth === 768 && !document.getElementById('detail-filmstrip').hidden");
    const oldMedia = await evaluate(window, `({ thumbnail: document.querySelector('#gallery-grid .video-card img').currentSrc,
      filmstrip: document.getElementById('detail-filmstrip').currentSrc, poster: document.getElementById('detail-poster').currentSrc })`);
    setStage('custom-thumbnail-picker-cancel');
    await evaluate(window, "document.getElementById('choose-thumbnail').click(); true"); await ready();
    assert.equal(picks, 1); assert.equal(imports, 0); assert.deepEqual(fingerprint(directory), before);
    const draft = marker + ' unsaved custom thumbnail';
    await evaluate(window, `(() => { const el=document.getElementById('details-notes'); el.value=${JSON.stringify(draft)};
      el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    setStage('custom-thumbnail-jpeg'); mode = 'choose';
    await evaluate(window, "document.getElementById('choose-thumbnail').click(); true"); await ready();
    assert.equal(await evaluate(window, "document.getElementById('generation-status').textContent"), 'Thumbnail updated.');
    assert.equal(imports, 1);
    await waitForRenderer(window, `document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256 && document.querySelector('#gallery-grid .video-card img').currentSrc !== ${JSON.stringify(oldMedia.thumbnail)}`);
    const goldPixel = await displayedColour(); assert.ok(goldPixel[0]>220 && goldPixel[1]>150 && goldPixel[2]<30);
    assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), draft);
    assert.equal(await evaluate(window, "document.getElementById('save-details').disabled"), false);
    assert.deepEqual(await evaluate(window, `({ filmstrip: document.getElementById('detail-filmstrip').currentSrc,
      poster: document.getElementById('detail-poster').currentSrc })`), { filmstrip: oldMedia.filmstrip, poster: oldMedia.poster });
    const rendererText = await evaluate(window, "document.body.textContent");
    assert.ok(!rendererText.includes(sourceRoot) && !rendererText.includes(images[0]));
    window.setSize(600, 400); window.show(); await delay(100);
    await evaluate(window, "document.getElementById('choose-thumbnail').scrollIntoView({block:'center'}); true");
    await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    assert.equal(await evaluate(window, `(() => { const el=document.getElementById('choose-thumbnail'); const r=el.getBoundingClientRect();
      return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && el.contains(document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)); })()`), true);
    fs.writeFileSync(path.join(reviewRoot, 'compact-custom-thumbnail.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1200, 800);
    await workspace.cancel(); assertRestoredMenu(); await inspect();
    setStage('custom-thumbnail-png'); await open();
    assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), marker);
    const firstUrl = await evaluate(window, "document.querySelector('#gallery-grid .video-card img').currentSrc");
    selected = images[1];
    await evaluate(window, "document.getElementById('choose-thumbnail').click(); true"); await ready();
    assert.equal(await evaluate(window, "document.getElementById('generation-status').textContent"), 'Thumbnail updated.');
    assert.equal(imports, 2);
    await waitForRenderer(window, `document.querySelector('#gallery-grid .video-card img')?.naturalWidth === 256 && document.querySelector('#gallery-grid .video-card img').currentSrc !== ${JSON.stringify(firstUrl)}`);
    await purpleDisplayed();
    const afterReplacement = fingerprint(directory);
    setStage('custom-thumbnail-lock-picker'); mode = 'hold';
    await evaluate(window, "document.getElementById('choose-thumbnail').click(); true");
    for (let attempt = 0; attempt < 500 && !releasePicker; attempt++) { await delay(10); }
    assert.equal(typeof releasePicker, 'function');
    const settled = workspace.settled; let finished = false; void settled.then(() => { finished = true; });
    void evaluate(window, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
    await delay(30); assert.equal(finished, false);
    releasePicker(); releasePicker = undefined; await settled;
    assert.equal(window.isDestroyed(), true); assertRestoredMenu();
    assert.equal(picks, 4); assert.equal(imports, 2);
    assert.deepEqual(fingerprint(directory), afterReplacement); assert.deepEqual(fingerprint(sourceRoot), originals);
    await inspect(true); assert.notEqual(previewPatterns[0], previewPatterns[1]);
    setStage('custom-thumbnail-reopen'); await open(); await purpleDisplayed();
    assert.equal(await evaluate(window, "document.getElementById('details-notes').value"), marker);
    assert.equal((await evaluate(window, 'window.privateGallery.sources()')).items[0].connected, false);
    await workspace.cancel(); assertRestoredMenu();
    await checkpoint('custom-thumbnail-saved', { thumbnailPickerCancelledNoWrite: true, thumbnailJpegDecoded: true,
      thumbnailReplacementDecoded: true, thumbnailPngDecoded: true, thumbnailPngTransparencyFlattened: true, thumbnailDraftPreserved: true, thumbnailMetadataStripped: true,
      thumbnailOtherPreviewsPreserved: true, thumbnailCatalogueByteIdentical: true, thumbnailOriginalsUnchanged: true,
      thumbnailPathsMainOnly: true, thumbnailNoSourceConnection: true, thumbnailCompactFits: true,
      thumbnailLockDrainedPicker: true, thumbnailLateChoiceRefused: true, thumbnailReopened: true,
      thumbnailPlaintextCopyCurrent: true }, previewPatterns);
  } catch (error) {
    fs.writeFileSync(path.join(reviewRoot, 'native-failure.txt'), String(error?.stack || error)); throw error;
  } finally {
    releasePicker?.(); dialog.showOpenDialog = oldPicker; PrivateHubSession.prototype.setCustomThumbnail = oldSetThumbnail;
    catalogueBytes.fill(0); for (const bytes of previews.values()) { bytes.fill(0); }
  }
}

async function makeHub(password, marker) {
  const directory = path.join(fixture, 'private-hub');
  if (phase === 'initial') {
    const store = await PrivateHubStore.create(directory, password);
    try {
      const catalogue = {
        addTags: [], removeTags: [], hubName: marker, version: 3, numOfFolders: 1,
        images: Array.from({ length: 50 }, (_, index) => ({ ...NewImageElement(),
          hash: index === 0 ? 'native-video' : 'native-video-' + index,
          fileName: 'synthetic-' + index + '.mp4', screens: 3, duration: 4, width: 32, height: 18,
          cleanName: index === 0 ? 'Synthetic coastal clip' : 'Synthetic archive ' + String(index).padStart(2, '0'),
          tags: index === 0 ? ['Coastal', 'Sample'] : ['Archive'], notes: index === 0 ? marker : '',
          stars: index === 0 || index === 49 ? 5.5 : 0.5, dateAdded: 1_700_000_000_000 + index * 1000,
          lastPlayed: index === 0 ? 1000 : index === 1 || index === 49 ? 3000 : 0,
        })),
        inputDirs: { 0: { path: path.join(fixture, 'synthetic-source'), watch: false, ignoredSubdirectories: ['Ignored'] } },
        screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 1, fixed: true, height: 144, n: 3 },
      };
      await writePrivateHubCatalogue(store, catalogue);
      const encoded = spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=teal:size=32x18', '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { cwd: repository, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(encoded.status, 0);
      assert.equal(encoded.stdout.readUInt16BE(0), 0xffd8);
      // A valid JPEG comment is visible only after decryption. A profile scan
      // detects an accidental disk image cache as well as text storage leaks.
      const comment = Buffer.from(marker);
      const header = Buffer.alloc(4);
      header.writeUInt16BE(0xfffe, 0);
      header.writeUInt16BE(comment.length + 2, 2);
      const jpeg = Buffer.concat([encoded.stdout.subarray(0, 2), header, comment, encoded.stdout.subarray(2)]);
      for (const image of catalogue.images) { await writePrivateHubPreview(store, 'thumbnail', image.hash, jpeg); }
      await writePrivateHubPreview(store, 'clip-poster', 'native-video', jpeg);
      const encodedStrip = spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=teal:size=96x18', '-vf', 'drawbox=x=32:y=0:w=32:h=18:color=coral:t=fill,drawbox=x=64:y=0:w=32:h=18:color=gold:t=fill',
        '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { cwd: repository, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(encodedStrip.status, 0);
      validatePrivateJpeg(encodedStrip.stdout, 96, 18);
      // The parent also scans for the original encoded image without its
      // canary comment, so stripping metadata cannot hide a cached copy.
      seededFilmstripPattern = encodedStrip.stdout.toString('base64');
      const strip = Buffer.concat([encodedStrip.stdout.subarray(0, 2), header, comment, encodedStrip.stdout.subarray(2)]);
      try { await writePrivateHubPreview(store, 'filmstrip', 'native-video', strip); }
      finally { strip.fill(0); encodedStrip.stdout.fill(0); }
      jpeg.fill(0); comment.fill(0); encoded.stdout.fill(0);
      const clip = spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
        '-i', 'color=c=teal:size=32x18:rate=10:duration=4', '-an', '-threads', '1', '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p', '-movflags', 'empty_moov+frag_keyframe', '-f', 'mp4', 'pipe:1'],
      { cwd: repository, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(clip.status, 0);
      // An ignored MP4 box makes an accidental plaintext video cache detectable
      // without putting any catalogue content in the encoder command line.
      const clipMarker = Buffer.from(marker);
      const clipBox = Buffer.alloc(8);
      clipBox.writeUInt32BE(8 + clipMarker.length, 0); clipBox.write('free', 4, 'ascii');
      const mp4 = Buffer.concat([clip.stdout, clipBox, clipMarker]);
      await writePrivateHubPreview(store, 'clip', 'native-video', mp4);
      fs.mkdirSync(path.join(fixture, 'synthetic-source'));
      for (const image of catalogue.images) {
        image.fileSize = mp4.length;
        fs.writeFileSync(path.join(fixture, 'synthetic-source', image.fileName), mp4);
      }
      await writePrivateHubCatalogue(store, catalogue);
      mp4.fill(0); clipMarker.fill(0); clip.stdout.fill(0);
      const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
      await store.writeNewRecord('session:activation', activation);
      activation.fill(0);
    } finally { await store.lock(); }
  }
  hub = new PrivateHubSession();
  return { directory, ...(await hub.unlock(directory, password)) };
}

async function create(generation) {
  capsule = await PrivateHubBrowser.create({ hub, generation, appDirectory: path.join(fixture, 'app') });
  assertPrivateMenu();
  const window = currentWindow();
  assert.equal(window.isVisible(), false);
  assert.equal(window.webContents.getURL(), 'theatrum://app/index.html');
  assert.equal(await evaluate(window, 'globalThis.fixtureReady === true'), true);
  const isolated = window.webContents.session;
  assert.notEqual(isolated, session.defaultSession);
  assert.equal(isolated.isPersistent(), false);
  assert.equal(isolated.storagePath, null);
  return { window, isolated };
}

async function assertFresh(window, isolated, marker) {
  const result = await evaluate(window, `(async () => {
    const marker = ${JSON.stringify(marker)};
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    const cachesPresent = typeof caches !== 'undefined' ? await caches.keys() : [];
    return { local: localStorage.getItem(marker) === null, session: sessionStorage.getItem(marker) === null,
      indexed: databases.every(item => item.name !== marker), cache: !cachesPresent.includes(marker),
      cookie: !document.cookie.includes(marker) };
  })()`);
  assert.ok(Object.values(result).every(Boolean));
  assert.ok((await isolated.cookies.get({})).every(cookie => !cookie.value.includes(marker)));
  assert.equal(await isolated.getCacheSize(), 0);
  return result;
}

async function run() {
  const { marker, password, newPassword, ports } = await configured();
  assert.match(marker, /^NATIVE_PRIVATE_CANARY_[a-f0-9]{48}$/);
  assert.equal(typeof password, 'string');
  assert.ok(Number.isInteger(ports.http) && Number.isInteger(ports.udp));
  await app.whenReady();
  installOrdinaryMenu();
  let defaultRequests = 0;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('theatrum:')) { defaultRequests++; }
    callback({ cancel: true });
  });
  if (phase === 'initial') { setStage('password-load'); await passwordPrompt(password); }
  setStage('encrypted-fixture');
  const opened = await makeHub(phase === 'restart' ? newPassword : password, marker);
  setStage('capsule-load');
  let { window, isolated } = await create(opened.generation);
  const fresh = await assertFresh(window, isolated, marker);
  if (phase === 'restart') {
    setStage('restart-check');
    assert.equal(opened.catalogue.images[0].notes, marker + ' — saved in the private hub');
    assert.deepEqual(opened.catalogue.images[0].tags, ['Coastal', 'Sample', 'Private > ' + marker]);
    assert.equal(opened.catalogue.images[1].notes, '');
    assert.equal(opened.catalogue.images[1].stars, 3.5);
    assert.equal(opened.catalogue.images[0].stars, 5.5);
    assert.equal(opened.catalogue.images[49].stars, 5.5);
    assert.equal(opened.catalogue.images.length, 57);
    assert.deepEqual(opened.catalogue.inputDirs[1], { path: path.join(fixture, 'added-source'), watch: false });
    assert.equal(opened.catalogue.images[51].inputSource, 1);
    assert.equal(opened.catalogue.images[51].cleanName, 'Synthetic new folder video');
    assert.equal(opened.catalogue.images[50].cleanName, 'Synthetic imported video');
    assert.equal(opened.catalogue.images[50].fps, 10);
    assert.equal(opened.catalogue.images[50].timesPlayed, 0);
    assert.equal(opened.catalogue.images[50].lastPlayed, 0);
    assert.ok(opened.catalogue.images.every(image => !image.timesPlayed && !image.lastPlayed));
    assert.equal(opened.catalogue.images[50].notes, marker + ' — playback draft');
    assert.deepEqual(opened.catalogue.images.slice(52, 55).map(image => [image.cleanName, image.inputSource]),
      [['Synthetic batch first', 1], ['Synthetic batch second', 1], ['Synthetic batch retained', 1]]);
    assert.deepEqual(opened.catalogue.images.slice(55).map(image => image.cleanName).sort(), ['Synthetic scanned nested', 'Synthetic scanned root']);
    assert.ok(opened.catalogue.images.slice(55).every(image => image.inputSource === 0));
    for (const image of opened.catalogue.images.slice(52)) {
      const response = await hub.createPreviewResponse(opened.generation, 'thumbnail', image.hash,
        new Request('theatrum://app/media/thumbnails/' + image.hash + '.jpg'));
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      try { validatePrivateJpeg(bytes, 256, 144); } finally { bytes.fill(0); }
    }
    const imported = await hub.createPreviewResponse(opened.generation, 'thumbnail', opened.catalogue.images[50].hash,
      new Request('theatrum://app/media/thumbnails/' + opened.catalogue.images[50].hash + '.jpg'));
    assert.equal(imported.status, 200);
    const importedBytes = Buffer.from(await imported.arrayBuffer());
    try { validatePrivateJpeg(importedBytes, 256, 144); } finally { importedBytes.fill(0); }
    assert.equal(opened.catalogue.inputDirs[0].path, path.join(fixture, 'relocated-source'));
    assert.deepEqual(await hub.readProtection(opened.generation), { autoLockMinutes: 1, recordPlaybackHistory: false });
    const generated = await hub.createPreviewResponse(opened.generation, 'filmstrip', 'native-video',
      new Request('theatrum://app/media/filmstrips/native-video.jpg'));
    const filmstrip = Buffer.from(await generated.arrayBuffer());
    try { validatePrivateJpeg(filmstrip, 768, 144); } finally { filmstrip.fill(0); }
    assert.equal(defaultRequests, 0);
    const refreshedStore = await PrivateHubStore.open(path.join(fixture, 'refresh-hub'), newPassword);
    try {
      const catalogueBytes = await refreshedStore.readRecord('catalogue');
      try {
        const refreshed = JSON.parse(catalogueBytes.toString('utf8')).images[0];
        assert.notEqual(refreshed.hash, 'before-refresh');
        assert.equal(refreshed.duration, 4); assert.equal(refreshed.screens, 3);
        assert.equal(refreshed.width, 32); assert.equal(refreshed.height, 18);
        assert.equal(refreshed.notes, marker); assert.equal(refreshed.timesPlayed, 7);
        const strip = await readPrivateHubPreview(refreshedStore, 'filmstrip', refreshed.hash);
        try { validatePrivateJpeg(strip, 768, 144); } finally { strip.fill(0); }
      } finally { catalogueBytes.fill(0); }
    } finally { await refreshedStore.lock(); }
    const customStore = await PrivateHubStore.open(path.join(fixture, 'custom-thumbnail-hub'), newPassword);
    try {
      const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'custom-thumbnail-expected.json'), 'utf8'));
      const currentCatalogue = await customStore.readRecord('catalogue');
      try { assert.equal(createHash('sha256').update(currentCatalogue).digest('hex'), expected.catalogue); }
      finally { currentCatalogue.fill(0); }
      for (const [kind, name] of [['thumbnail', 'thumbnail'], ['filmstrip', 'filmstrip'], ['clip-poster', 'poster'], ['clip', 'clip']]) {
        const bytes = await readPrivateHubPreview(customStore, kind, 'custom-thumbnail-video');
        try {
          assert.equal(createHash('sha256').update(bytes).digest('hex'), expected[name]);
          if (kind === 'thumbnail') { validatePrivateJpeg(bytes, 256, 144); assert.equal(bytes.includes(Buffer.from(marker)), false); }
        } finally { bytes.fill(0); }
      }
    } finally { await customStore.lock(); }
    await checkpoint('restarted', { fresh, persistent: isolated.isPersistent(), cacheBytes: await isolated.getCacheSize(),
      savedMetadataPersisted: true, generatedSetPersisted: true, protectionPersisted: true, changedPasswordPersisted: true,
      customThumbnailPersisted: true, videoRefreshPersisted: true, unrelatedMetadataPreserved: true, playbackHistoryResetPersisted: true, playbackHistoryDisabledPersisted: true, ratingPersisted: true, sourceScanImportsPersisted: true, sourceRelocationPersisted: true, importedVideoPersisted: true, addedSourcePersisted: true, batchImportsPersisted: true, cancelledBatchKnownCompletionPersisted: true, defaultRequests });
    await capsule.close();
    await hub.close();
    assert.equal(capsule.status.cleanupFailed, false);
    assertRestoredMenu();
    await send({ type: 'complete' });
    app.quit();
    return;
  }

  setStage('preview-decode');
  const preview = await evaluate(window, `(async () => {
    const image = new Image(); image.src = 'theatrum://app/media/thumbnails/native-video.jpg';
    document.body.append(image); await image.decode();
    const response = await fetch(image.src); const bytes = new Uint8Array(await response.arrayBuffer());
    return { width: image.naturalWidth, height: image.naturalHeight,
      comment: new TextDecoder().decode(bytes).includes(${JSON.stringify(marker)}),
      noStore: response.headers.get('cache-control').includes('no-store') };
  })()`);
  assert.deepEqual(preview, { width: 32, height: 18, comment: true, noStore: true });
  setStage('private-storage');
  const storage = await evaluate(window, `(async () => {
    const marker = ${JSON.stringify(marker)};
    localStorage.setItem(marker, marker); sessionStorage.setItem(marker, marker);
    const result = { local: localStorage.getItem(marker) === marker, session: sessionStorage.getItem(marker) === marker };
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(marker, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('synthetic');
        request.onerror = () => reject(new Error('blocked'));
        request.onsuccess = () => {
          const database = request.result, transaction = database.transaction('synthetic', 'readwrite');
          transaction.objectStore('synthetic').put(marker, 'value');
          transaction.oncomplete = () => { database.close(); resolve(); };
          transaction.onerror = () => { database.close(); reject(new Error('blocked')); };
        };
      }); result.indexed = 'stored';
    } catch { result.indexed = 'blocked'; }
    try { const cache = await caches.open(marker); await cache.put('theatrum://app/cache-probe', new Response(marker)); result.cache = 'stored'; }
    catch { result.cache = 'blocked'; }
    try { document.cookie = 'native_private=' + marker + '; Secure; SameSite=Strict'; result.cookie = document.cookie.includes(marker) ? 'stored' : 'blocked'; }
    catch { result.cookie = 'blocked'; }
    window.onbeforeunload = () => 'Synthetic unload blocker';
    return result;
  })()`);
  assert.equal(storage.local, true);
  assert.equal(storage.session, true);
  try {
    await isolated.cookies.set({ url: 'theatrum://app/', name: 'native_main_cookie', value: marker, secure: true, sameSite: 'strict' });
    storage.mainCookie = (await isolated.cookies.get({})).some(cookie => cookie.value === marker) ? 'stored' : 'blocked';
  } catch { storage.mainCookie = 'blocked'; }
  isolated.flushStorageData();

  setStage('renderer-boundaries');
  let downloads = 0;
  let uncancelledDownloads = 0;
  isolated.on('will-download', event => { downloads++; if (!event.defaultPrevented) { uncancelledDownloads++; } });
  const gates = await evaluate(window, `(async () => {
    const http = 'http://127.0.0.1:${ports.http}/probe', websocket = 'ws://127.0.0.1:${ports.http}/probe';
    const timeout = (promise, milliseconds = 1000) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(false), milliseconds))]);
    const failedFetch = async url => { try { await fetch(url); return false; } catch { return true; } };
    const result = { http: await timeout(failedFetch(http)), file: await timeout(failedFetch(${JSON.stringify('file://' + path.join(fixture, 'app', 'probe.txt'))})) };
    result.websocket = await timeout(new Promise(resolve => { try {
      const socket = new WebSocket(websocket); socket.onopen = () => { socket.close(); resolve(false); }; socket.onerror = () => resolve(true);
    } catch { resolve(true); } }));
    result.popup = window.open(http) === null;
    const blockedWorker = async shared => {
      let worker;
      try {
        worker = shared ? new SharedWorker('theatrum://app/worker.js') : new Worker('theatrum://app/worker.js');
        return await timeout(new Promise(resolve => {
          worker.onerror = event => { event.preventDefault(); resolve(true); };
          (shared ? worker.port : worker).onmessage = () => resolve(false);
          if (shared) { worker.port.start(); }
        }));
      } catch { return true; }
      finally { if (worker) { if (shared) { worker.port.close(); } else { worker.terminate(); } } }
    };
    result.worker = await blockedWorker(false); result.sharedWorker = await blockedWorker(true);
    result.serviceWorker = await timeout((async () => {
      try { await navigator.serviceWorker.register('theatrum://app/worker.js'); return false; } catch { return true; }
    })());
    const link = document.createElement('a'); link.href = 'theatrum://app/app.js'; link.download = 'synthetic-download.js'; document.body.append(link); link.click(); link.remove();
    const frame = document.createElement('iframe'); frame.src = http; document.body.append(frame);
    result.rtcAvailable = typeof RTCPeerConnection === 'function';
    if (result.rtcAvailable) {
      let connection;
      try {
        connection = new RTCPeerConnection({ iceServers: [
          { urls: 'stun:127.0.0.1:${ports.udp}' },
          { urls: ['turn:127.0.0.1:${ports.udp}?transport=udp', 'turn:127.0.0.1:${ports.http}?transport=tcp'], username: 'synthetic', credential: 'synthetic' },
        ] });
        connection.createDataChannel('synthetic'); await connection.setLocalDescription(await connection.createOffer());
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch { /* An unavailable transport is an acceptable deny result. */ }
      finally { connection?.close(); }
    }
    frame.remove(); return result;
  })()`);
  assert.ok(['http', 'file', 'websocket', 'popup', 'worker', 'sharedWorker', 'serviceWorker'].every(key => gates[key] === true));
  await delay(150);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.equal(uncancelledDownloads, 0);
  assert.deepEqual(fs.readdirSync(path.join(profile, 'downloads')), []);
  assert.equal(await isolated.getCacheSize(), 0);
  assert.equal(defaultRequests, 0);
  await checkpoint('unlocked', { preview, storage, gates, downloads, persistent: isolated.isPersistent(), cacheBytes: await isolated.getCacheSize(), defaultRequests });

  setStage('lock-cleanup');
  const originalSession = isolated;
  const restrictedDuringCleanup = assertPrivateMenu();
  let releaseCleanup;
  let enteredCleanup;
  let releaseWrite;
  let enteredWrite;
  const cleanupHeld = new Promise(resolve => { releaseCleanup = resolve; });
  const cleanupStarted = new Promise(resolve => { enteredCleanup = resolve; });
  const writeHeld = new Promise(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise(resolve => { enteredWrite = resolve; });
  const originals = new Map();
  const cleanupFinished = [];
  for (const name of ['closeAllConnections', 'clearData', 'clearCache', 'clearCodeCaches', 'clearAuthCache', 'clearHostResolverCache']) {
    const original = isolated[name];
    originals.set(name, original);
    let finished;
    cleanupFinished.push(new Promise(resolve => { finished = resolve; }));
    isolated[name] = async (...args) => {
      try {
        if (name === 'clearData') { enteredCleanup(); await cleanupHeld; }
        return await original.apply(isolated, args);
      } finally { finished(); }
    };
  }
  const writeRecord = PrivateHubStore.prototype.writeRecord;
  PrivateHubStore.prototype.writeRecord = async function (...args) {
    if (this.directory === opened.directory && args[0] === 'catalogue') {
      enteredWrite(); await writeHeld;
    }
    return writeRecord.apply(this, args);
  };
  let capsuleClosed = false;
  void capsule.closed.then(() => { capsuleClosed = true; });
  try {
    // Hold a real session-queued write before the underlying store call. An
    // external lock must drain this work even though the browser no longer sees
    // its generation as current when its own revoke listener runs.
    const writing = assert.rejects(hub.writeCatalogue(opened.generation, opened.catalogue));
    await writeStarted;
    const locking = hub.lock();
    assert.equal(window.isDestroyed(), true, 'Lock must destroy the renderer synchronously, despite beforeunload.');
    assert.equal(hub.isCurrent(opened.generation), false);
    await cleanupStarted;
    assert.equal(Menu.getApplicationMenu(), restrictedDuringCleanup, 'The menu must stay restricted while native cleanup is pending.');
    releaseCleanup();
    await Promise.all(cleanupFinished);
    // All six actual native cleanups have completed. Let their promise handoffs
    // settle before checking that the separately held storage drain still owns
    // the private menu and browser completion barrier.
    await delay(10);
    assert.equal(capsuleClosed, false, 'Private browser completion must await an external session lock drain.');
    assert.equal(Menu.getApplicationMenu(), restrictedDuringCleanup, 'The ordinary menu must not return while the externally locked session still drains.');
    releaseWrite();
    await Promise.all([writing, locking, capsule.closed]);
  } finally {
    releaseCleanup(); releaseWrite();
    PrivateHubStore.prototype.writeRecord = writeRecord;
    for (const [name, original] of originals) { isolated[name] = original; }
  }
  assert.equal(capsule.status.cleanupFailed, false);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(await originalSession.getCacheSize(), 0);
  assert.deepEqual(await originalSession.cookies.get({}), []);
  assertRestoredMenu();
  await checkpoint('locked', { destroyed: true, locked: true, originalMenuRestored: true, menuHeldUntilCleanup: true, externalStorageDrainHeldMenu: true, cleanupFailed: capsule.status.cleanupFailed, cacheBytes: await originalSession.getCacheSize() });

  setStage('same-process-reopen');
  const reopened = await hub.unlock(opened.directory, password);
  ({ window, isolated } = await create(reopened.generation));
  assert.notEqual(isolated, originalSession);
  const reopenedFresh = await assertFresh(window, isolated, marker);
  await checkpoint('reopened', { fresh: reopenedFresh, newPartition: true, persistent: isolated.isPersistent(), cacheBytes: await isolated.getCacheSize() });
  await capsule.close();
  await hub.close();
  assert.equal(capsule.status.cleanupFailed, false);
  assertRestoredMenu();
  await workspaceOpening(opened.directory, password, newPassword, marker);
  await passwordRecoveryAcceptance(opened.directory, newPassword, password);
  await sourceCheckAcceptance(newPassword, marker);
  await videoRefreshAcceptance(newPassword, marker);
  await customThumbnailAcceptance(newPassword, marker);
  await syntheticTouchIdControls(opened.directory, newPassword);
  await send({ type: 'complete' });
  app.quit();
}

void run().catch(async error => {
  // Workspace-owned synthetic fixture diagnostics never cross the parent IPC.
  try { fs.writeFileSync(path.join(fixture, 'failure.json'), JSON.stringify({ stage, message: error?.message, stack: error?.stack })); } catch { /* Preserve the original failure. */ }
  try { await send({ type: 'failed', stage }); } catch { /* Parent also detects incomplete exit. */ }
  try { await capsule?.close(); } catch { /* Keep failure generic. */ }
  try { await hub?.close(); } catch { /* Parent owns the fixture after process exit. */ }
  try { await workspace?.cancel(); } catch { /* Keep failure generic. */ }
  app.exit(1);
});
