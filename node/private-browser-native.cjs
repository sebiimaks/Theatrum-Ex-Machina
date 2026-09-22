/* Native-only synthetic fixture. The parent harness controls all paths and IPC. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, Menu, powerMonitor, protocol, session } = require('electron');
const { createHash } = require('node:crypto');

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
const { PrivateHubStore } = require('./private-hub-store.ts');
const { PrivateHubSession } = require('./private-hub-session.ts');
const { PrivateHubBrowser } = require('./private-hub-browser.ts');
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
async function waitForRenderer(window, expression) {
  for (let index = 0; index < 500; index++) {
    if (await evaluate(window, expression)) { return; }
    await delay(10);
  }
  throw new Error('Synthetic gallery state did not become ready.');
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
  assert.deepEqual(surface, { methods: ['cancelRegeneration', 'detail', 'list', 'lock', 'protection', 'regenerate', 'save', 'setProtection'],
    credentials: ['cancelUnprotectedCopy', 'changePassword', 'createUnprotectedCopy', 'disableTouchId', 'enableTouchId', 'touchIdStatus'], ordinary: 'undefined', unlock: 'undefined', node: 'undefined', process: 'undefined' });
  setStage('gallery-list');
  await waitForRenderer(window, "document.querySelectorAll('#gallery-grid .video-card').length === 48");
  setStage('gallery-protection');
  await evaluate(window, "document.getElementById('protection-button').click(); true");
  await waitForRenderer(window, "document.getElementById('auto-lock-minutes').value === '5' && !document.getElementById('auto-lock-minutes').disabled");
  await evaluate(window, `(() => {
    const select = document.getElementById('auto-lock-minutes'); select.value = '1';
    select.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('save-protection').click();
  })()`);
  await waitForRenderer(window, "document.getElementById('protection-status').textContent === 'Protection setting saved.'");
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
  setStage('gallery-details');
  await evaluate(window, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(window, `document.getElementById('details-notes').value === ${JSON.stringify(marker)}`);
  assert.equal(await evaluate(window, "document.getElementById('details-title').textContent"), 'Synthetic coastal clip');
  assert.equal(await evaluate(window, "document.querySelector('#gallery-grid .video-card').getAttribute('aria-pressed')"), 'true');
  setStage('gallery-clipboard');
  const clipboard = await clipboardBackstop(window, 'details-notes', marker);
  await syntheticPaste(window, 'details-notes', true);
  setStage('gallery-preview');
  const clipResponses = [];
  isolated.webRequest.onCompleted({ urls: ['theatrum://app/media/clips/native-video.mp4*'] }, details => {
    if (clipResponses.length < 8) { clipResponses.push({ status: details.statusCode, type: details.resourceType }); }
  });
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
    await evaluate(window, "document.getElementById('regenerate-previews').click(); true");
    await waitForRenderer(window, "document.getElementById('generation-status').textContent === 'Regeneration stopped. Previews refreshed.'");
    assert.equal(selections, 1);
    setStage('gallery-source-generate');
    await evaluate(window, "document.getElementById('regenerate-previews').click(); true");
    await waitForRenderer(window, "!document.getElementById('regenerate-previews').disabled");
    assert.equal(selections, 2);
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
  setStage('gallery-generated-playback');
  await evaluate(window, "document.getElementById('play-preview').click(); true");
  await waitForRenderer(window, "document.getElementById('preview-video').videoWidth === 256 && document.getElementById('preview-video').currentTime > 0").catch(async error => {
    const state = await evaluate(window, "({width: document.getElementById('preview-video').videoWidth, paused: document.getElementById('preview-video').paused, error: document.getElementById('preview-video').error?.code || 0})");
    if (state.width === 32) { setStage('gallery-stale-video'); }
    else if (state.width === 256 && state.paused) { setStage('gallery-paused-video'); }
    else if (state.error) { setStage('gallery-video-decode-error'); }
    throw error;
  });
  // Review artifact contains generated synthetic catalogue/preview data only.
  setStage('gallery-review-capture');
  const galleryScreenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(repository, 'tmp', 'private-gallery-review.png'), galleryScreenshot.toPNG());
  assert.equal(await isolated.getCacheSize(), 0);
  await checkpoint('workspace-opened', { opened: true, surface, clipboard, metadataPasteDenied: true, restrictedApplicationMenu: true, pageSize: 48, pagination: true,
    search: true, notes: true, encryptedImageDecoded: true, encryptedClipPlayed: true,
    encryptedMetadataSaved: true, tagNormalized: true, dirtyCloseGuard: true, discardReloaded: true,
    sourcePickerCancelledThenGranted: true, encryptedPreviewsRegenerated: true, refreshedPreviewWidth: 256,
    sourceUnchanged: true, noRegenerationAutoplay: true, encryptedProtectionSaved: true,
    protectionMinimumWindowFits: true, cacheBytes: 0 });
  setStage('gallery-lock');
  const settled = workspace.settled;
  void evaluate(window, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
  await settled;
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
  await evaluate(reopened, `(() => {
    const search = document.getElementById('gallery-search'); search.value = ${JSON.stringify(editedTag)};
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(reopened, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
  await evaluate(reopened, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitForRenderer(reopened, `document.getElementById('details-notes').value === ${JSON.stringify(editedNote)}`);
  assert.equal(await evaluate(reopened, `document.getElementById('details-tags').textContent.includes(${JSON.stringify(editedTag)})`), true);
  await waitForRenderer(reopened, "document.getElementById('detail-poster').naturalWidth === 256");
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
    assert.deepEqual(await evaluate(automatic, 'window.privateGallery.protection()'), { status: 'ready', autoLockMinutes: 1 });
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
    assert.deepEqual(await evaluate(automatic, 'window.privateGallery.protection()'), { status: 'ready', autoLockMinutes: 1 });
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
    assert.equal(fs.readdirSync(path.join(mediaRoot, 'thumbnails')).length, 50);
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
    freshGalleryPartition: true, savedMetadataReopened: true, generatedSetReopened: true,
    generatedMediaMarkersStripped: true, nativeInputRenewsDeadline: true, syntheticDomDoesNotRenew: true,
    automaticLockDrained: true, deadlineClock: 'advanced in main test',
    passwordChangeFormCleared: true, passwordMismatchRejected: true, incorrectCurrentRetryable: true,
    passwordChangeLocked: true, oldPasswordRejected: true, newPasswordReopened: true,
    systemLockDrained: true, originalMenuRestored: true, privateMenuObservations, restoredMenuObservations,
    credentialPasteAllowed: true, wrongPassword: 'unavailable', retryAvailable: true }, previewPatterns);
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
        })),
        inputDirs: { 0: { path: path.join(fixture, 'synthetic-source'), watch: false } },
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
      fs.writeFileSync(path.join(fixture, 'synthetic-source', 'synthetic-0.mp4'), mp4);
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
    assert.equal(opened.catalogue.inputDirs[0].path, path.join(fixture, 'synthetic-source'));
    assert.deepEqual(await hub.readProtection(opened.generation), { autoLockMinutes: 1 });
    const generated = await hub.createPreviewResponse(opened.generation, 'filmstrip', 'native-video',
      new Request('theatrum://app/media/filmstrips/native-video.jpg'));
    const filmstrip = Buffer.from(await generated.arrayBuffer());
    try { validatePrivateJpeg(filmstrip, 768, 144); } finally { filmstrip.fill(0); }
    assert.equal(defaultRequests, 0);
    await checkpoint('restarted', { fresh, persistent: isolated.isPersistent(), cacheBytes: await isolated.getCacheSize(),
      savedMetadataPersisted: true, generatedSetPersisted: true, protectionPersisted: true, changedPasswordPersisted: true,
      unrelatedMetadataPreserved: true, defaultRequests });
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
  await syntheticTouchIdControls(opened.directory, newPassword);
  await send({ type: 'complete' });
  app.quit();
}

void run().catch(async () => {
  try { await send({ type: 'failed', stage }); } catch { /* Parent also detects incomplete exit. */ }
  try { await capsule?.close(); } catch { /* Keep failure generic. */ }
  try { await hub?.close(); } catch { /* Parent owns the fixture after process exit. */ }
  try { await workspace?.cancel(); } catch { /* Keep failure generic. */ }
  app.exit(1);
});
