/* Native menu acceptance of untouched packaged main.js; never shipped. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, dialog, Menu, nativeImage, session } = require('electron');
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
async function run() {
  if (!configuration) { await new Promise(resolve => waiting.set('configuration', resolve)); }
  assert.ok(typeof configuration.marker === 'string' && typeof configuration.password === 'string');
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
void run().catch(fail);
