/* Native menu acceptance of untouched packaged main.js; never shipped. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, webContents } = require('electron');
const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const fixture = process.argv.find(value => value.startsWith('--private-package-fixture='))?.slice('--private-package-fixture='.length);
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.dirname(fixture) === path.join(repository, 'tmp') && fs.realpathSync(fixture) === fixture);
const resources = path.join(fixture, 'Private package fixture.app', 'Contents', 'Resources');
const archive = path.join(resources, 'payload.asar');
assert.equal(app.isPackaged, true);
assert.equal(process.resourcesPath, resources);
for (const [key, name] of [['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data'],
  ['temp', 'temporary'], ['crashDumps', 'crash-dumps'], ['logs', 'logs'], ['downloads', 'downloads']]) {
  const directory = path.join(fixture, 'profile', name);
  fs.mkdirSync(directory, { recursive: true }); app.setPath(key, directory);
}
const settingsDirectory = path.join(fixture, 'profile', 'settings');
fs.mkdirSync(settingsDirectory, { recursive: true });
process.env.PORTABLE_EXECUTABLE_DIR = settingsDirectory;
delete process.env.THEATRUM_PACKAGED_SMOKE_TEST;
const normalDirectory = path.join(fixture, 'ordinary-hub');
const sourceDirectory = path.join(fixture, 'ordinary-source');
const cataloguePath = path.join(normalDirectory, 'Synthetic.scaena');
const conversionParent = path.join(normalDirectory, 'selected-folder');
const previousPrivateDirectory = path.join(conversionParent, 'Private hub');
const encryptedDirectory = path.join(conversionParent, 'Private hub 2');
const preservedContents = 'Synthetic existing folder contents';
const originalNotes = 'Synthetic ordinary notes';
const touchCatalogueMetadata = process.env.THEATRUM_PRIVATE_PICKER_TOUCH_CTIME === '1';
assert.ok(process.env.THEATRUM_PRIVATE_PICKER_TOUCH_CTIME === undefined || touchCatalogueMetadata);
let pickerDiagnostic;
function recordPickerDiagnostic(value) {
  pickerDiagnostic = value;
  fs.writeFileSync(path.join(repository, 'tmp', 'private-picker-delay-diagnostic.json'), JSON.stringify(value) + '\n');
  process.stdout.write(JSON.stringify(value) + '\n');
}
let configuration;
let normalWindow;
let ordinaryMenu;
let heldSourcePicker;
let stage = 'configuration';
let allowFinalQuit = false;
let resolveFinalQuit;
const finalQuit = new Promise(resolve => { resolveFinalQuit = resolve; });
const waiting = new Map();
const recentDocuments = [];
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
process.on('message', message => {
  if (message?.type === 'configuration') { configuration = message; waiting.get('configuration')?.(); }
  else if (message?.type === 'continue') { waiting.get(message.stage)?.(); }
});
function setStage(value) { stage = value; if (process.connected) { process.send({ type: 'progress', stage }); } }
async function checkpoint(name, checks) {
  const continuation = new Promise(resolve => waiting.set(name, resolve));
  await send({ type: 'checkpoint', stage: name, checks }); await continuation; waiting.delete(name);
}
async function fail(error) {
  // Assertion messages can contain private values. Return only a fixture line.
  const line = [...(error?.stack ?? '').matchAll(/private-package-host-native\.cjs:(\d+):/g)][0]?.[1];
  try { await send({ type: 'failure', stage, line: line ? Number(line) : undefined }); } catch { /* Parent already stopped. */ }
  app.exit(1);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
async function until(predicate) {
  for (let attempt = 0; attempt < 2000; attempt++) { if (await predicate()) { return; } await delay(10); }
  assert.fail('Packaged host did not reach the required state.');
}
async function waitDom(window, code) {
  await until(async () => { try { return await evaluate(window, code); } catch { return false; } });
}
async function type(window, selector, value) {
  await evaluate(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await window.webContents.insertText(value);
  await waitDom(window, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
}
async function privateWindow(surface) {
  let found;
  await until(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window === normalWindow || window.isDestroyed()) { continue; }
      try { if (await evaluate(window, `typeof globalThis.${surface} === 'object'`)) { found = window; return true; } }
      catch { /* Initial navigation is still pending. */ }
    }
    return false;
  });
  return found;
}
async function focus(window) {
  window.show(); window.focus();
  await waitDom(window, 'document.hasFocus() && !document.hidden');
}
async function isolated(window, surface) {
  const partition = window.webContents.session;
  assert.notEqual(partition, session.defaultSession);
  assert.equal(partition.isPersistent(), false);
  assert.equal(partition.storagePath, null);
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.deepEqual(await evaluate(window, `({ bridge: typeof globalThis.${surface}, ordinary: typeof globalThis.theatrum, node: typeof require, process: typeof process })`),
    { bridge: 'object', ordinary: 'undefined', node: 'undefined', process: 'undefined' });
  return partition;
}
async function nativeEntry(id) {
  await until(() => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled === true);
  const menu = Menu.getApplicationMenu();
  assert.equal(menu, ordinaryMenu);
  const item = menu.getMenuItemById(id);
  assert.equal(typeof item.click, 'function');
  // Invoke the native MenuItem callback, never a private host test export or IPC.
  item.click(item, normalWindow, {});
}
function fingerprint(directory) {
  const result = {};
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(current, entry.name);
      // The chosen destination has its own checks and encrypted-storage scan.
      if (file === conversionParent) { continue; }
      if (entry.isDirectory()) { visit(file); }
      else { assert.ok(entry.isFile()); result[path.relative(directory, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
    }
  };
  visit(directory); return result;
}
function assertDestinationPreserved() {
  assert.deepEqual(fs.readdirSync(previousPrivateDirectory), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(previousPrivateDirectory, 'keep.txt'), 'utf8'), preservedContents);
  assert.equal(fs.readFileSync(path.join(conversionParent, 'keep.txt'), 'utf8'), preservedContents);
  assert.equal(fs.realpathSync(encryptedDirectory), encryptedDirectory);
}
// Only the fixture's ordinary path can be recorded. Do not write macOS history
// or Chromium's system-level singleton socket from this isolated acceptance run.
app.addRecentDocument = file => { assert.equal(file, cataloguePath); recentDocuments.push(file); };
app.clearRecentDocuments = () => { throw new Error('Unexpected OS history mutation.'); };
app.requestSingleInstanceLock = () => true;
app.releaseSingleInstanceLock = () => undefined;
app.on('will-quit', event => {
  event.preventDefault();
  if (allowFinalQuit) { resolveFinalQuit(); }
  else { void fail(new Error('Unexpected host quit.')); }
});
dialog.showOpenDialog = async (owner, options) => {
  if (options.title === 'Open private hub') {
    assert.equal(owner, normalWindow);
    assert.ok(options.properties.includes('dontAddToRecent'));
    assert.equal(fs.realpathSync(encryptedDirectory), encryptedDirectory);
    return { canceled: false, filePaths: [encryptedDirectory] };
  }
  if (configuration?.crashMode && options.title === 'Allow source folder access') {
    assert.ok(heldSourcePicker && !heldSourcePicker.entered);
    assert.equal(owner, heldSourcePicker.owner);
    assert.equal(options.defaultPath, sourceDirectory);
    assert.deepEqual(options.properties, ['openDirectory', 'noResolveAliases', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false);
    heldSourcePicker.entered = true;
    return heldSourcePicker.result;
  }
  assert.ok(owner && owner !== normalWindow && !owner.isDestroyed());
  assert.equal(await evaluate(owner, 'typeof globalThis.privateConversion'), 'object');
  assert.equal(options.title, 'Create private copy');
  assert.equal(options.buttonLabel, 'Create private copy here');
  assert.deepEqual(options.properties, ['openDirectory', 'createDirectory', 'dontAddToRecent']);
  assert.equal(options.securityScopedBookmarks, false);
  assert.equal(fs.existsSync(encryptedDirectory), false);
  // Opt-in diagnostic models time spent in a native picker without changing
  // source metadata deliberately. It reads only this fixture's synthetic file.
  const pickerDelay = Number(process.env.THEATRUM_PRIVATE_PICKER_DELAY_MS || '0');
  assert.ok(Number.isSafeInteger(pickerDelay) && pickerDelay >= 0 && pickerDelay <= 30_000);
  if (pickerDelay > 0 || touchCatalogueMetadata) {
    setStage('host-picker-delay');
    const before = fs.lstatSync(cataloguePath);
    const beforeDigest = createHash('sha256').update(fs.readFileSync(cataloguePath)).digest('hex');
    if (pickerDelay > 0) { await delay(pickerDelay); }
    // Reapply the same permission bits to model an OS metadata-only update.
    // Bytes, path, identity and permissions remain unchanged in this fixture.
    if (touchCatalogueMetadata) { fs.chmodSync(cataloguePath, before.mode & 0o777); }
    const after = fs.lstatSync(cataloguePath);
    const afterDigest = createHash('sha256').update(fs.readFileSync(cataloguePath)).digest('hex');
    const diagnostic = {
      ctimeChanged: before.ctimeMs !== after.ctimeMs,
      mtimeChanged: before.mtimeMs !== after.mtimeMs,
      identityChanged: before.dev !== after.dev || before.ino !== after.ino,
      contentEqual: beforeDigest === afterDigest,
    };
    // The parent intentionally discards arbitrary child stdout. Retain only
    // synthetic booleans in the workspace, outside the catalogue being checked.
    recordPickerDiagnostic(diagnostic);
    if (touchCatalogueMetadata) { assert.deepEqual(diagnostic, { ctimeChanged: true, mtimeChanged: false, identityChanged: false, contentEqual: true }); }
    setStage('host-picker-delayed');
  }
  // Model the native New Folder action in the catalogue parent after review.
  // Selecting this existing folder must preserve its contents and choose a child.
  assert.equal(fs.existsSync(conversionParent), false);
  fs.mkdirSync(previousPrivateDirectory, { recursive: true });
  fs.writeFileSync(path.join(previousPrivateDirectory, 'keep.txt'), preservedContents);
  fs.writeFileSync(path.join(conversionParent, 'keep.txt'), preservedContents);
  // Exercise the native filesystem's canonical spelling, not the JavaScript
  // realpath fallback that can preserve input case on a case-insensitive Mac.
  // Case-sensitive volumes use the physical spelling and retain all other checks.
  const caseVariant = path.join(normalDirectory, 'Selected-Folder');
  let selectedParent = conversionParent;
  let variantStats;
  try { variantStats = fs.lstatSync(caseVariant); }
  catch (error) { if (error.code !== 'ENOENT') { throw error; } }
  if (variantStats) {
    const parentStats = fs.lstatSync(conversionParent);
    assert.equal(variantStats.isDirectory(), true);
    assert.equal(variantStats.isSymbolicLink(), false);
    assert.equal(variantStats.dev, parentStats.dev);
    assert.equal(variantStats.ino, parentStats.ino);
    assert.notEqual(caseVariant, conversionParent);
    assert.equal(fs.realpathSync.native(caseVariant), conversionParent);
    selectedParent = caseVariant;
  }
  assert.equal(fs.realpathSync.native(selectedParent), conversionParent);
  return { canceled: false, filePaths: [selectedParent] };
};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  assert.equal(options.title, 'Allow Catalogue Folder Access?');
  assert.ok(options.detail.includes(sourceDirectory));
  return { response: 0, checkboxChecked: false };
};
// Prepare only public, synthetic ordinary media before the untouched host starts.
// The conversion action itself must create and activate the encrypted destination.
const { NewImageElement } = require(path.join(archive, 'interfaces/final-object.interface.js'));
fs.mkdirSync(normalDirectory); fs.mkdirSync(sourceDirectory);
const catalogue = { addTags: [], removeTags: [], hubName: 'Synthetic', version: 3, numOfFolders: 1,
  inputDirs: { 0: { path: sourceDirectory, watch: false } },
  screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 1 },
  images: [{ ...NewImageElement(), hash: 'normal-video', fileName: 'synthetic.mp4', cleanName: 'Synthetic normal video',
    duration: 6, screens: 1, width: 64, height: 36, notes: originalNotes, tags: ['Synthetic tag'] }] };
fs.writeFileSync(cataloguePath, JSON.stringify(catalogue));
const thumbnails = path.join(normalDirectory, 'vha-Synthetic', 'thumbnails');
fs.mkdirSync(thumbnails, { recursive: true });
const pixels = Buffer.alloc(64 * 36 * 4, 96);
const image = nativeImage.createFromBitmap(pixels, { width: 64, height: 36 }).toJPEG(80);
pixels.fill(0);
fs.writeFileSync(path.join(thumbnails, 'normal-video.jpg'), image); image.fill(0);
// This is the normal OS/file-association startup path. No readiness gate,
// production source, window preference or module export is instrumented.
process.argv = [process.execPath, cataloguePath];
require(path.join(archive, 'main.js'));
// Read-only observation of the real host's ordinary admission boundary. Never
// replace production exports, create a second workspace, or expose private state.
const { normalOperationScope } = require(path.join(archive, 'node', 'normal-operation-scope.js'));
const { GLOBALS } = require(path.join(archive, 'node', 'main-globals.js'));

async function restored() {
  await until(() => BrowserWindow.getAllWindows().length === 1 && normalWindow.isVisible()
    && Menu.getApplicationMenu() === ordinaryMenu);
  await waitDom(normalWindow, 'document.body.inert === false');
  assert.equal(normalWindow.isDestroyed(), false);
  assert.equal(JSON.parse(fs.readFileSync(cataloguePath, 'utf8')).images[0].notes, originalNotes);
}
async function openGallery() {
  const gallery = await privateWindow('privateGallery');
  const partition = await isolated(gallery, 'privateGallery');
  await focus(gallery);
  await waitDom(gallery, 'document.querySelectorAll("#gallery-grid .video-card").length === 1');
  await waitDom(gallery, 'document.querySelector("#gallery-grid .video-card img")?.naturalWidth === 64');
  await evaluate(gallery, 'document.querySelector("#gallery-grid .video-card").click(); true');
  return { gallery, partition };
}
function ordinaryPaused() {
  assert.equal(normalWindow.isDestroyed(), false);
  assert.equal(normalWindow.isVisible(), false);
  assert.equal(normalOperationScope.accepting, false);
  assert.equal(GLOBALS.catalogueTransitionActive, true);
  const menu = Menu.getApplicationMenu();
  assert.notEqual(menu, ordinaryMenu);
  assert.ok(menu.getMenuItemById('private-native-close'));
  assert.equal(menu.getMenuItemById('private-hub-open'), null);
}
// Unowned main-process fetches are refused even in a live private session.
// This supplements lifecycle checks; it is not proof of retiring owned requests.
async function unownedProbeDenied(partition, url) {
  let denied = false;
  try {
    const response = await partition.fetch(url);
    denied = !response.ok;
    await response.body?.cancel();
  } catch { denied = true; }
  assert.equal(denied, true);
}
async function readableMediaUrl(window) {
  const url = await evaluate(window, 'document.querySelector("#gallery-grid .video-card img").src');
  assert.ok(typeof url === 'string' && url.startsWith('theatrum://'));
  // A main-process session.fetch has no owning webContentsId and is denied even
  // while the hub is open. The gallery's CSP also prohibits renderer fetch.
  // Positively decode an Image through the real allowed image route instead;
  // a fresh cache key prevents reuse of the already decoded gallery element.
  const probeUrl = new URL(url);
  probeUrl.search = '?v=native-termination-probe';
  assert.equal(await evaluate(window, `(async () => {
    const image = new Image();
    try {
      image.src = ${JSON.stringify(probeUrl.href)};
      await image.decode();
      return image.naturalWidth === 64 && image.naturalHeight === 36;
    } finally { image.removeAttribute('src'); }
  })()`), true);
  await unownedProbeDenied(window.webContents.session, url);
  return url;
}
function fixtureCrashDirectoryEmpty() {
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) { visit(path.join(directory, entry.name)); }
      else { assert.fail('Renderer termination produced a persistent crash artifact.'); }
    }
  };
  visit(path.join(fixture, 'profile', 'crash-dumps'));
}
async function killPrivateRenderer(window, channel) {
  ordinaryPaused();
  await waitDom(normalWindow, 'document.body.inert === true');
  const contents = window.webContents;
  const pid = contents.getOSProcessId();
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.notEqual(pid, process.pid);
  assert.notEqual(pid, normalWindow.webContents.getOSProcessId());
  for (const other of webContents.getAllWebContents()) {
    if (other !== contents && !other.isDestroyed()) { assert.notEqual(pid, other.getOSProcessId()); }
  }
  assert.equal(ipcMain.listenerCount(channel), 1);
  let observed = 0;
  const gone = new Promise((resolve, reject) => {
    // Installed after production listeners. These assertions run within the
    // same event emission, before promise continuations or cleanup drainage.
    contents.once('render-process-gone', (_event, details) => {
      try {
        observed++;
        assert.equal(details.reason, 'killed');
        assert.equal(ipcMain.listenerCount(channel), 0);
        ordinaryPaused();
        resolve();
      } catch (error) { reject(error); }
    });
  });
  process.kill(pid, 'SIGKILL');
  await gone;
  assert.equal(observed, 1);
  await until(() => window.isDestroyed());
}
async function reopenWithPassword(previousPartitions, password = configuration.password) {
  const prefix = stage;
  setStage(prefix + '-native-open');
  await nativeEntry('private-hub-open');
  setStage(prefix + '-password-window');
  const prompt = await privateWindow('privateUnlock');
  const promptPartition = await isolated(prompt, 'privateUnlock');
  for (const partition of previousPartitions) { assert.notEqual(promptPartition, partition); }
  previousPartitions.push(promptPartition);
  await focus(prompt);
  await waitDom(prompt, '!document.getElementById("unlock").disabled');
  assert.equal(await evaluate(prompt, 'document.getElementById("password").value'), '');
  setStage(prefix + '-password-submit');
  await type(prompt, '#password', password);
  void evaluate(prompt, 'document.getElementById("unlock-form").requestSubmit(); true').catch(() => undefined);
  setStage(prefix + '-gallery-open');
  const opened = await openGallery();
  assert.equal(prompt.isDestroyed(), true);
  for (const partition of previousPartitions) { assert.notEqual(opened.partition, partition); }
  previousPartitions.push(opened.partition);
  setStage(prefix + '-saved-notes');
  await waitDom(opened.gallery, `document.getElementById('details-notes').value === ${JSON.stringify(configuration.marker)}`);
  return opened;
}
async function runPasswordRecovery(previousPartitions) {
  setStage('host-recovery-fixture');
  // Seed only this locked synthetic hub with the exact authenticated envelope a
  // password change leaves before publication. Exercise the real packaged UI,
  // IPC, store and native confirmation without altering production functions.
  const { PRIVATE_HUB_HEADER_FILE } = require(path.join(archive, 'node', 'private-hub-store.js'));
  const { validatePrivateHubHeader, unlockPrivateHub, changePrivateHubPassword } =
    require(path.join(archive, 'node', 'private-hub-crypto.js'));
  const headerPath = path.join(encryptedDirectory, PRIVATE_HUB_HEADER_FILE);
  const pendingName = PRIVATE_HUB_HEADER_FILE + '.' + randomBytes(24).toString('hex') + '.pending';
  const pendingPath = path.join(encryptedDirectory, pendingName);
  const header = validatePrivateHubHeader(JSON.parse(fs.readFileSync(headerPath, 'utf8')));
  const key = await unlockPrivateHub(header, configuration.password);
  let pendingBytes;
  try {
    pendingBytes = Buffer.from(JSON.stringify(await changePrivateHubPassword(header, key, configuration.newPassword)), 'utf8');
    fs.writeFileSync(pendingPath, pendingBytes, { flag: 'wx', mode: 0o600 });
  } finally { key.fill(0); pendingBytes?.fill(0); }
  const before = fingerprint(encryptedDirectory);
  const pendingIdentity = fs.lstatSync(pendingPath);
  const savedConfirmation = dialog.showMessageBox;
  let confirmations = 0;
  let accept = false;
  let recovering;
  dialog.showMessageBox = async (owner, options) => {
    assert.equal(owner, recovering.gallery);
    assert.equal(options.title, 'Finish interrupted password change?');
    assert.equal(options.message, 'Finish interrupted password change?');
    assert.deepEqual(options.buttons, ['Finish password change', 'Cancel']);
    assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 1); assert.equal(options.noLink, true);
    const text = JSON.stringify(options);
    for (const secret of [configuration.password, configuration.newPassword, configuration.marker, encryptedDirectory, pendingName]) {
      assert.equal(text.includes(secret), false, 'Native confirmation disclosed private information.');
    }
    ordinaryPaused();
    confirmations++;
    return { response: accept ? 0 : 1, checkboxChecked: false };
  };
  try {
    setStage('host-recovery-open');
    recovering = await reopenWithPassword(previousPartitions);
    const ordinaryBeforeRecovery = fingerprint(normalDirectory);
    ordinaryPaused();
    await evaluate(recovering.gallery, 'document.getElementById("protection-button").click(); true');
    await waitDom(recovering.gallery, '!document.getElementById("auto-lock-minutes").disabled');
    await evaluate(recovering.gallery, 'document.getElementById("change-password-toggle").click(); true');
    const submit = (currentPassword, newPassword) => evaluate(recovering.gallery, `(() => {
      for (const [id, value] of ${JSON.stringify([['current-password', currentPassword], ['new-password', newPassword], ['confirm-password', newPassword]])}) {
        const input = document.getElementById(id); input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.getElementById('resume-password-submit').click();
      return ['current-password', 'new-password', 'confirm-password'].every(id => document.getElementById(id).value === '');
    })()`);
    setStage('host-recovery-wrong-credentials');
    for (const [currentPassword, newPassword] of [
      [configuration.password + ' incorrect', configuration.newPassword],
      [configuration.password, configuration.newPassword + ' incorrect'],
    ]) {
      assert.equal(await submit(currentPassword, newPassword), true);
      await waitDom(recovering.gallery, `document.getElementById('password-status').textContent.includes('interrupted change is incorrect')
        && !document.getElementById('resume-password-submit').disabled`);
      assert.equal(confirmations, 0);
      assert.deepEqual(fingerprint(encryptedDirectory), before);
      ordinaryPaused();
    }
    setStage('host-recovery-cancel');
    assert.equal(await submit(configuration.password, configuration.newPassword), true);
    await waitDom(recovering.gallery, `document.getElementById('password-status').textContent.includes('left unfinished')
      && !document.getElementById('resume-password-submit').disabled`);
    assert.equal(confirmations, 1);
    assert.deepEqual(fingerprint(encryptedDirectory), before);
    assert.deepEqual(fingerprint(normalDirectory), ordinaryBeforeRecovery);
    ordinaryPaused();
    await waitDom(normalWindow, 'document.body.inert === true');
    await checkpoint('host-recovery-reviewed', { credentialsCleared: true, wrongCredentialsBeforeConfirmation: true,
      nativeConfirmationDefaultCancel: true, cancelledRecoveryUnchanged: true, ordinaryPaused: true, ordinaryUnchanged: true });

    setStage('host-recovery-confirm');
    accept = true;
    assert.equal(await submit(configuration.password, configuration.newPassword), true);
    await restored();
    assert.equal(confirmations, 2);
    assert.equal(recovering.gallery.isDestroyed(), true);
    assert.equal(await recovering.partition.getCacheSize(), 0);
    assert.deepEqual(fingerprint(normalDirectory), ordinaryBeforeRecovery);
    const after = fingerprint(encryptedDirectory);
    const expected = { ...before, [PRIVATE_HUB_HEADER_FILE]: before[pendingName] }; delete expected[pendingName];
    assert.deepEqual(after, expected, 'Only the credential envelope may change.');
    const publishedIdentity = fs.lstatSync(headerPath);
    assert.equal(publishedIdentity.dev, pendingIdentity.dev);
    assert.equal(publishedIdentity.ino, pendingIdentity.ino);
    assert.equal(fs.existsSync(headerPath + '.bak'), false);
    setStage('host-recovery-old-password');
    await nativeEntry('private-hub-open');
    const oldPrompt = await privateWindow('privateUnlock');
    const oldPartition = await isolated(oldPrompt, 'privateUnlock');
    for (const partition of previousPartitions) { assert.notEqual(oldPartition, partition); }
    previousPartitions.push(oldPartition);
    await focus(oldPrompt);
    await waitDom(oldPrompt, '!document.getElementById("unlock").disabled');
    ordinaryPaused();
    await type(oldPrompt, '#password', configuration.password);
    void evaluate(oldPrompt, 'document.getElementById("unlock-form").requestSubmit(); true').catch(() => undefined);
    await restored();
    assert.equal(oldPrompt.isDestroyed(), true);
    assert.deepEqual(fingerprint(encryptedDirectory), after);
    setStage('host-recovery-new-password');
    const reopened = await reopenWithPassword(previousPartitions, configuration.newPassword);
    ordinaryPaused();
    const ordinaryAfterReopen = fingerprint(normalDirectory);
    assert.deepEqual(fingerprint(encryptedDirectory), after);
    assert.equal(await reopened.partition.getCacheSize(), 0);
    await checkpoint('host-recovery-reopened', { confirmedRecoveryLocked: true, ordinaryRestoredAfterRecovery: true,
      stagedEnvelopeAdopted: true, encryptedRecordsUnchanged: true, oldPasswordRejected: true,
      newPasswordReopened: true, savedNotesPreserved: true, previewDecoded: true, freshPrivateSessions: true,
      ordinaryPaused: true, noDiskCache: true });
    setStage('host-recovery-lock');
    void evaluate(reopened.gallery, 'document.getElementById("lock-hub").click(); true').catch(() => undefined);
    await restored();
    assert.equal(reopened.gallery.isDestroyed(), true);
    await closeHost(ordinaryAfterReopen);
  } finally { dialog.showMessageBox = savedConfirmation; }
}
async function closeHost(ordinarySnapshot) {
  assert.deepEqual(fingerprint(normalDirectory), ordinarySnapshot);
  assert.deepEqual(recentDocuments, [cataloguePath]);
  assertDestinationPreserved();
  allowFinalQuit = true;
  normalWindow.close();
  await finalQuit;
  assert.equal(normalWindow.isDestroyed(), true);
  const settings = JSON.parse(fs.readFileSync(path.join(settingsDirectory, 'settings.json'), 'utf8'));
  assert.equal(settings.appState.currentVhaFile, cataloguePath);
  await checkpoint('host-closed', { privateDestroyed: true, ordinaryRestored: true, ordinaryClosed: true,
    settingsSaved: true, noPrivateRecentWrites: true });
  await send({ type: 'complete' }); app.exit(0);
}
async function runRendererTermination(firstPartition) {
  const partitions = [firstPartition];
  const encryptedBefore = fingerprint(encryptedDirectory);
  setStage('crash-password');
  await nativeEntry('private-hub-open');
  const prompt = await privateWindow('privateUnlock');
  const promptPartition = await isolated(prompt, 'privateUnlock');
  partitions.push(promptPartition);
  await focus(prompt);
  await waitDom(prompt, '!document.getElementById("unlock").disabled');
  await type(prompt, '#password', configuration.password + ' unsent');
  await killPrivateRenderer(prompt, 'private-password-cancel');
  await restored();
  await unownedProbeDenied(promptPartition, 'theatrum://app/index.html');
  assert.equal(await promptPartition.getCacheSize(), 0);
  assert.deepEqual(fingerprint(encryptedDirectory), encryptedBefore);
  fixtureCrashDirectoryEmpty();
  await checkpoint('crash-password-retired', { rendererKilled: true, unsentPasswordDiscarded: true,
    controlListenerRemovedSynchronously: true, ordinaryStayedPaused: true, privateDestroyed: true, ordinaryRestored: true,
    unownedProbeDenied: true, noDiskCache: true, fixtureCrashDirectoryEmpty: true });

  setStage('crash-gallery');
  const draft = await reopenWithPassword(partitions);
  setStage('crash-gallery-preview-control');
  const draftUrl = await readableMediaUrl(draft.gallery);
  const draftText = configuration.marker + ' unsaved draft';
  setStage('crash-gallery-draft');
  await type(draft.gallery, '#details-notes', draftText);
  await waitDom(draft.gallery, '!document.getElementById("save-details").disabled');
  const beforeDraftDeath = fingerprint(encryptedDirectory);
  setStage('crash-gallery-termination');
  await killPrivateRenderer(draft.gallery, 'private-gallery-lock');
  setStage('crash-gallery-restoration');
  await restored();
  setStage('crash-gallery-retired-session');
  await unownedProbeDenied(draft.partition, draftUrl);
  assert.equal(await draft.partition.getCacheSize(), 0);
  assert.deepEqual(fingerprint(encryptedDirectory), beforeDraftDeath);
  await checkpoint('crash-gallery-retired', { rendererKilled: true, unsavedNotesPresent: true,
    encryptedPreviewDecoded: true, controlListenerRemovedSynchronously: true, ordinaryStayedPaused: true,
    privateDestroyed: true, ordinaryRestored: true, unownedProbeDenied: true, noDiskCache: true, encryptedFilesUnchanged: true });

  setStage('crash-picker');
  const picking = await reopenWithPassword(partitions);
  setStage('crash-picker-preview-control');
  const pickerUrl = await readableMediaUrl(picking.gallery);
  let releasePicker;
  let lateSelectionReads = 0;
  heldSourcePicker = { owner: picking.gallery, entered: false,
    result: new Promise(resolve => { releasePicker = resolve; }) };
  setStage('crash-picker-source-list');
  await evaluate(picking.gallery, 'document.getElementById("source-folders-toggle").click(); true');
  await waitDom(picking.gallery, 'document.querySelector("[data-action=connect-source]")?.disabled === false');
  void evaluate(picking.gallery, 'document.querySelector("[data-action=connect-source]").click(); true').catch(() => undefined);
  await until(() => heldSourcePicker.entered);
  const beforePickerDeath = fingerprint(encryptedDirectory);
  setStage('crash-picker-termination');
  await killPrivateRenderer(picking.gallery, 'private-gallery-lock');
  setStage('crash-picker-retired-session');
  await unownedProbeDenied(picking.partition, pickerUrl);
  // The checkpoint round trip also leaves time for cleanup to attempt an
  // incorrect early ordinary restoration while the native choice is pending.
  ordinaryPaused();
  await waitDom(normalWindow, 'document.body.inert === true');
  assert.deepEqual(fingerprint(encryptedDirectory), beforePickerDeath);
  await checkpoint('crash-picker-held', { rendererKilled: true, controlListenerRemovedSynchronously: true,
    privateDestroyed: true, ordinaryPaused: true, menuRestricted: true, pickerPending: true,
    unownedProbeDenied: true, encryptedFilesUnchanged: true });
  ordinaryPaused();
  setStage('crash-picker-late-selection');
  releasePicker({ canceled: false, get filePaths() { lateSelectionReads++; return [sourceDirectory]; } });
  await restored();
  assert.equal(lateSelectionReads, 0);
  heldSourcePicker = undefined;
  assert.deepEqual(fingerprint(encryptedDirectory), beforePickerDeath);
  assert.equal(await picking.partition.getCacheSize(), 0);
  await checkpoint('crash-picker-drained', { lateSelectionRejected: true, ordinaryRestored: true,
    menuRestored: true, encryptedFilesUnchanged: true, noDiskCache: true });

  setStage('crash-reopening');
  const recovered = await reopenWithPassword(partitions);
  setStage('crash-reopening-saved-state');
  assert.equal(await evaluate(recovered.gallery, `document.getElementById('details-notes').value === ${JSON.stringify(draftText)}`), false);
  assert.equal(await evaluate(recovered.gallery, `(async () => {
    const sources = await globalThis.privateGallery.sources();
    return sources.status === 'ready' && sources.items.length === 1 && sources.items.every(source => source.connected === false);
  })()`), true);
  // The URL identifies a preview, not a bearer capability: the same URL can
  // legitimately work in the freshly authenticated hub. Retired partitions
  // must still reject unowned probes after a new owner unlocks that same hub.
  // Direct request retirement is covered separately by protocol/browser unit tests.
  await unownedProbeDenied(draft.partition, draftUrl);
  await unownedProbeDenied(picking.partition, pickerUrl);
  assert.equal(await recovered.partition.getCacheSize(), 0);
  fixtureCrashDirectoryEmpty();
  await checkpoint('crash-reopened', { nativePasswordUnlock: true, savedNotesPreserved: true, draftDiscarded: true,
    encryptedPreviewDecoded: true, freshSessions: true, noSourceGrant: true, unownedProbesDeniedAfterReopen: true,
    noDiskCache: true, fixtureCrashDirectoryEmpty: true });
  const ordinarySnapshot = fingerprint(normalDirectory);
  setStage('crash-reopening-lock');
  void evaluate(recovered.gallery, 'document.getElementById("lock-hub").click(); true').catch(() => undefined);
  await restored();
  assert.equal(recovered.gallery.isDestroyed(), true);
  await closeHost(ordinarySnapshot);
}
async function run() {
  if (!configuration) { await new Promise(resolve => waiting.set('configuration', resolve)); }
  assert.ok(typeof configuration.marker === 'string' && typeof configuration.password === 'string'
    && typeof configuration.newPassword === 'string');
  setStage('host-starting');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }));
  await until(() => {
    normalWindow = BrowserWindow.getAllWindows().find(window => !window.isDestroyed());
    return !!normalWindow;
  });
  normalWindow.setSize(1280, 850);
  await waitDom(normalWindow, 'typeof globalThis.theatrum === "object" && document.querySelector(".workbench-catalogue strong")?.textContent === "Synthetic" && document.querySelector("app-thumbnail img.full-filmstrip")?.naturalWidth === 64');
  ordinaryMenu = Menu.getApplicationMenu();
  assert.ok(ordinaryMenu.getMenuItemById('private-hub-open'));
  assert.ok(ordinaryMenu.getMenuItemById('private-hub-create'));
  assert.deepEqual(recentDocuments, [cataloguePath]);
  await checkpoint('host-started', { packagedMain: true, ordinaryUiLoaded: true, nativeMenuRegistered: true, syntheticCatalogueLoaded: true });

  setStage('host-creating');
  await nativeEntry('private-hub-create');
  const form = await privateWindow('privateConversion');
  await isolated(form, 'privateConversion');
  await focus(form);
  await waitDom(form, '!document.getElementById("review").hidden && !document.getElementById("credentials").disabled');
  // The host has saved and frozen ordinary drafts before showing this form.
  // Snapshot before conversion or private editing can affect any stored file.
  const ordinaryBeforeConversion = fingerprint(normalDirectory);
  const review = await evaluate(form, 'globalThis.privateConversion.getState()');
  assert.equal(review.review.videos, 1);
  assert.equal(review.review.availablePreviews, 1);
  await evaluate(form, 'document.getElementById("acknowledge-originals").click(); true');
  if (Object.values(review.review.missingPreviews).some(count => count > 0)) {
    await evaluate(form, 'document.getElementById("allow-missing").click(); true');
  }
  await type(form, '#password', configuration.password);
  await type(form, '#confirm-password', configuration.password);
  void evaluate(form, 'document.getElementById("conversion-form").requestSubmit(); true').catch(() => undefined);
  if (touchCatalogueMetadata) {
    await until(async () => {
      if (form.isDestroyed()) { recordPickerDiagnostic({ ...pickerDiagnostic, sourceChangedFailure: false }); return true; }
      const state = await evaluate(form, 'globalThis.privateConversion.getState()');
      if (state?.phase === 'failed') {
        recordPickerDiagnostic({ ...pickerDiagnostic, sourceChangedFailure: state.failure === 'source-changed' });
        setStage('host-metadata-only-refused');
        assert.fail('Metadata-only source change prevented conversion.');
      }
      return false;
    });
  }
  const first = await openGallery();
  assert.equal(form.isDestroyed(), true);
  await waitDom(first.gallery, `document.getElementById('details-notes').value === ${JSON.stringify(originalNotes)}`);
  await type(first.gallery, '#details-notes', configuration.marker);
  await evaluate(first.gallery, 'document.getElementById("save-details").click(); true');
  await waitDom(first.gallery, 'document.getElementById("edit-status").textContent === "Changes saved."');
  assert.equal(normalWindow.isVisible(), false);
  await waitDom(normalWindow, 'document.body.inert === true');
  assert.equal(await first.partition.getCacheSize(), 0);
  assert.deepEqual(fingerprint(normalDirectory), ordinaryBeforeConversion);
  assertDestinationPreserved();
  await checkpoint('host-created', { nativeConversion: true, previewDecoded: true, notesSaved: true,
    ordinaryPaused: true, privateIsolated: true, noDiskCache: true, existingFolderPreserved: true,
    sourceParentChangeAccepted: true, newChildCreated: true });

  setStage('host-restoring');
  void evaluate(first.gallery, 'document.getElementById("lock-hub").click(); true').catch(() => undefined);
  await restored();
  assert.equal(first.gallery.isDestroyed(), true);
  assert.equal(await first.partition.getCacheSize(), 0);
  assert.deepEqual(fingerprint(normalDirectory), ordinaryBeforeConversion);
  await checkpoint('host-restored', { privateDestroyed: true, ordinaryRestored: true, menuRestored: true, ordinaryUnchanged: true });
  if (configuration.crashMode === true) { await runRendererTermination(first.partition); return; }

  setStage('host-reopening');
  await nativeEntry('private-hub-open');
  const prompt = await privateWindow('privateUnlock');
  await isolated(prompt, 'privateUnlock');
  await focus(prompt);
  await waitDom(prompt, '!document.getElementById("unlock").disabled');
  // Each native entry saves ordinary drafts before pausing them. The second
  // save legitimately rotates the first saved catalogue into its .bak file.
  // Prove that exact rotation, then hold every file fixed during private use.
  const ordinaryBeforeReopen = fingerprint(normalDirectory);
  assert.deepEqual(ordinaryBeforeReopen, {
    ...ordinaryBeforeConversion, 'Synthetic.scaena.bak': ordinaryBeforeConversion['Synthetic.scaena'],
  });
  await type(prompt, '#password', configuration.password);
  void evaluate(prompt, 'document.getElementById("unlock-form").requestSubmit(); true').catch(() => undefined);
  const reopened = await openGallery();
  assert.equal(prompt.isDestroyed(), true);
  assert.notEqual(reopened.partition, first.partition);
  await waitDom(reopened.gallery, `document.getElementById('details-notes').value === ${JSON.stringify(configuration.marker)}`);
  assert.equal(await reopened.partition.getCacheSize(), 0);
  assert.deepEqual(fingerprint(normalDirectory), ordinaryBeforeReopen);
  await checkpoint('host-reopened', { nativePasswordUnlock: true, notesPersisted: true, previewDecoded: true,
    privateIsolated: true, noDiskCache: true });

  setStage('host-closing');
  void evaluate(reopened.gallery, 'document.getElementById("lock-hub").click(); true').catch(() => undefined);
  await restored();
  assert.equal(reopened.gallery.isDestroyed(), true);
  assert.deepEqual(fingerprint(normalDirectory), ordinaryBeforeReopen);
  await runPasswordRecovery([first.partition, reopened.partition]);
}
void run().catch(fail);
