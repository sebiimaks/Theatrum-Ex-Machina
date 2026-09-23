/* Actual main-process host acceptance with synthetic, Workspace-only state. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Module } = require('node:module');
const ts = require('typescript');
const { app, BrowserWindow, dialog, ipcMain, Menu, session } = require('electron');
const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const fixture = argument('--private-host-fixture');
const assets = argument('--private-host-assets');
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.dirname(fixture) === path.join(repository, 'tmp') && fs.realpathSync(fixture) === fixture);
assert.equal(assets, path.join(repository, 'tmp', 'private-transition-angular'));
assert.equal(fs.realpathSync(assets), assets);
for (const [key, folder] of [['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data'],
  ['temp', 'temporary'], ['crashDumps', 'crash-dumps'], ['logs', 'logs'], ['downloads', 'downloads']]) {
  const target = path.join(fixture, 'profile', folder);
  fs.mkdirSync(target, { recursive: true }); app.setPath(key, target);
}
const settingsDirectory = path.join(fixture, 'profile', 'settings');
fs.mkdirSync(settingsDirectory);
process.env.PORTABLE_EXECUTABLE_DIR = settingsDirectory;
delete process.env.THEATRUM_PACKAGED_SMOKE_TEST;
process.argv = [process.execPath];
require('ts-node').register({ project: path.join(repository, 'tsconfig.persistence-tests.json'),
  transpileOnly: true, preferTsExts: true, compilerOptions: { module: 'commonjs', target: 'es2022' } });
const { GLOBALS } = require('./main-globals.ts');
const { NewImageElement } = require('../interfaces/final-object.interface.ts');
const { normalOperationScope: operations } = require('./normal-operation-scope.ts');
const { PrivateHubStore } = require('./private-hub-store.ts');
const { readPrivateHubCatalogue, writePrivateHubCatalogue, writePrivateHubPreview } = require('./private-hub-catalogue.ts');
const { verifyPrivateHubConversion } = require('./private-hub-conversion.ts');
const { getMediaToolPath } = require('./media-tool-paths.ts');
const { hasSourceWatcher, beginNormalMediaDrain } = require('./main-extract-async.ts');
const { compilePrivateHost } = require('./private-host-instrumentation.cjs');
const NOTES = '.catalogue-row .notes-field textarea';
const TAGS = '.catalogue-row .catalogue-tag-input input[placeholder="Separate tags with commas"]';
const NORMAL_NOTES = 'Synthetic normal notes saved before private opening';
const NORMAL_TAG = 'Synthetic > Pending draft';
let stage = 'configuration';
let configuration;
let normalWindow;
let host;
let loadedMain;
let ordinaryMenu;
let expectedFinalQuit = false;
let finalQuitReached;
const finalQuit = new Promise(resolve => { finalQuitReached = resolve; });
const waiting = new Map();
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
async function fail(error) {
  // Exception messages may contain assertion values. Report only this harness's
  // outermost line number, never messages, paths or complete stacks.
  const locations = [...(error?.stack ?? '').matchAll(/private-host-native\.cjs:(\d+):/g)];
  const line = locations.at(-1)?.[1];
  try { await send({ type: 'failure', stage, line: line ? Number(line) : undefined }); } catch { /* Parent may have stopped. */ }
  app.exit(1);
}
process.on('message', message => {
  if (message?.type === 'configuration') { configuration = message; waiting.get('configuration')?.(); }
  else if (message?.type === 'continue') { waiting.get(message.stage)?.(); }
});
function setStage(value) { stage = value; if (process.connected) { process.send({ type: 'progress', stage }); } }
async function checkpoint(name, checks) {
  const continuation = new Promise(resolve => waiting.set(name, resolve));
  await send({ type: 'checkpoint', stage: name, checks }); await continuation; waiting.delete(name);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
async function until(predicate) {
  for (let index = 0; index < 500; index++) { if (await predicate()) { return; } await delay(10); }
  assert.fail('Native acceptance did not reach the required state.');
}
const dom = code => evaluate(normalWindow, code);
async function waitDom(code, window = normalWindow) {
  await until(async () => { try { return await evaluate(window, code); } catch { return false; } });
}
async function type(selector, value, window = normalWindow) {
  await evaluate(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await window.webContents.insertText(value);
  await waitDom(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`, window);
}
function privateWindows() { return BrowserWindow.getAllWindows().filter(window => window !== normalWindow && !window.isDestroyed()); }
async function privateWindow(surface) {
  let found;
  await until(async () => {
    for (const window of privateWindows()) {
      try { if (await evaluate(window, `!!globalThis.${surface}`)) { found = window; return true; } }
      catch { /* Initial document navigation. */ }
    }
    return false;
  });
  return found;
}
const normalDirectory = path.join(fixture, 'ordinary-hub');
const sourceDirectory = path.join(fixture, 'ordinary-source');
const cataloguePath = path.join(normalDirectory, 'Synthetic.scaena');
const secondCataloguePath = path.join(normalDirectory, 'Second.scaena');
const encryptedDirectory = path.join(fixture, 'encrypted-hub');
const conversionParent = path.join(normalDirectory, 'selected-folder');
const previousPrivateDirectory = path.join(conversionParent, 'Private hub');
const convertedDirectory = path.join(conversionParent, 'Private hub 2');
const cancelledConversionParent = path.join(fixture, 'cancelled-selected-folder');
const preservedContents = 'Synthetic existing folder contents';
let selectedPrivateDirectory = encryptedDirectory;
let holdConversionPicker = true;
let heldConversionPicker;
let conversionPickerCalls = 0;
const readNormal = (file = cataloguePath) => JSON.parse(fs.readFileSync(file, 'utf8'));
const recentDocuments = [];
const nativeChoices = [];
let heldChoice;
let allowCloseChoice = false;
// These two APIs write OS-owned recent-file history outside the disposable
// profile. Record requests without forwarding them to the operating system.
app.addRecentDocument = file => {
  assert.ok(file === cataloguePath || file === secondCataloguePath);
  recentDocuments.push(file);
};
app.clearRecentDocuments = () => { throw new Error('Unexpected OS history mutation.'); };
// Chromium's macOS singleton socket uses OS temporary storage even when its
// profile is redirected. OS instance arbitration is outside this fixture.
app.requestSingleInstanceLock = () => true;
app.releaseSingleInstanceLock = () => undefined;
app.on('will-quit', event => {
  event.preventDefault();
  if (expectedFinalQuit) { finalQuitReached(); }
  else { void fail(new Error('Unexpected host quit.')); }
});

// The ordinary fixture must exist synchronously before main.ts registers its
// ready handler. Private fixtures can be created after receiving configuration.
function makeOrdinaryFixtures() {
  fs.mkdirSync(sourceDirectory); fs.mkdirSync(normalDirectory);
  fs.mkdirSync(cancelledConversionParent);
  const catalogue = { addTags: [], removeTags: [], hubName: 'Synthetic', version: 3, numOfFolders: 1,
    inputDirs: { 0: { path: sourceDirectory, watch: true } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
    images: [{ ...NewImageElement(), hash: 'normal-video', fileName: 'synthetic.mp4', cleanName: 'Synthetic normal video',
      duration: 2, screens: 3, width: 64, height: 36, notes: 'Original normal notes', tags: ['Original'] }],
  };
  fs.writeFileSync(cataloguePath, JSON.stringify(catalogue));
  fs.writeFileSync(secondCataloguePath, JSON.stringify({ ...catalogue, hubName: 'Second' }));
  const ffmpeg = fs.realpathSync(getMediaToolPath('ffmpeg'));
  assert.ok(ffmpeg.startsWith('/Users/sm/Workspace/'));
  const encode = args => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:size=64x36:rate=2', ...args],
      { cwd: repository, timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 0); return result.stdout;
  };
  const image = encode(['-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
  const clip = encode(['-t', '2', '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  fs.writeFileSync(path.join(sourceDirectory, 'synthetic.mp4'), clip); clip.fill(0);
  for (const hub of ['Synthetic', 'Second']) {
    const thumbnails = path.join(normalDirectory, 'vha-' + hub, 'thumbnails');
    fs.mkdirSync(thumbnails, { recursive: true }); fs.writeFileSync(path.join(thumbnails, 'normal-video.jpg'), image);
  }
  return { catalogue, image };
}
const ordinary = makeOrdinaryFixtures();

dialog.showOpenDialog = async (owner, options) => {
  if (options.title === 'Open private hub') {
    assert.equal(owner, host.window);
    assert.ok(options.properties.includes('dontAddToRecent'));
    return { canceled: false, filePaths: [selectedPrivateDirectory] };
  }
  assert.ok(owner && owner !== normalWindow && !owner.isDestroyed());
  assert.equal(await evaluate(owner, 'typeof globalThis.privateConversion'), 'object');
  assert.equal(options.title, 'Create private copy');
  assert.equal(options.buttonLabel, 'Create private copy here');
  assert.deepEqual(options.properties, ['openDirectory', 'createDirectory', 'dontAddToRecent']);
  assert.equal(options.securityScopedBookmarks, false);
  conversionPickerCalls++;
  if (holdConversionPicker) {
    assert.equal(heldConversionPicker, undefined);
    return new Promise(resolve => { heldConversionPicker = () => {
      heldConversionPicker = undefined;
      resolve({ canceled: false, filePaths: [cancelledConversionParent] });
    }; });
  }
  // Reproduce creating a sibling folder in the native picker after source review.
  assert.equal(fs.existsSync(conversionParent), false);
  fs.mkdirSync(previousPrivateDirectory, { recursive: true });
  fs.writeFileSync(path.join(previousPrivateDirectory, 'keep.txt'), preservedContents);
  fs.writeFileSync(path.join(conversionParent, 'keep.txt'), preservedContents);
  return { canceled: false, filePaths: [conversionParent] };
};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (options.title === 'Allow Catalogue Folder Access?' || options.title === 'Allow Automatic Folder Watching?') {
    // Consent is supplied only for this fixture's canonical source folder.
    assert.ok(options.detail.includes(sourceDirectory));
    nativeChoices.push(options.title); return { response: 0, checkboxChecked: false };
  }
  assert.equal(options.title, 'Unable to Close Safely');
  assert.equal(allowCloseChoice, true);
  assert.equal(heldChoice, undefined);
  const kind = options.buttons[0] === 'Keep Working' ? 'catalogue' : 'settings';
  nativeChoices.push(kind);
  return new Promise(resolve => { heldChoice = { kind, resolve: () => { heldChoice = undefined; resolve({ response: 0, checkboxChecked: false }); } }; });
};

const preload = path.join(fixture, 'preload.cjs');
fs.writeFileSync(preload, ts.transpileModule(fs.readFileSync(path.join(repository, 'preload.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText);
// Compile main in memory with the test-only gate and asset path substitutions.
// Production source, build outputs and normal/private bridges are untouched.
const filename = path.join(repository, 'main.ts');
loadedMain = new Module(filename, module);
loadedMain.filename = filename;
loadedMain.paths = Module._nodeModulePaths(repository);
loadedMain._compile(compilePrivateHost({ repository, assets, preload }), filename);
host = loadedMain.exports.__privateHostAcceptance;
assert.ok(host);
host.requestCatalogueOpenFromSystem(cataloguePath);

async function makePrivateFixture() {
  const store = await PrivateHubStore.create(encryptedDirectory, configuration.privatePassword);
  try {
    await writePrivateHubCatalogue(store, { ...ordinary.catalogue, hubName: configuration.privateCanary,
      images: [{ ...ordinary.catalogue.images[0], hash: 'private-video', cleanName: 'Synthetic private video', notes: configuration.privateCanary }] });
    const comment = Buffer.from(configuration.privateCanary);
    const header = Buffer.alloc(4); header.writeUInt16BE(0xfffe, 0); header.writeUInt16BE(comment.length + 2, 2);
    const image = Buffer.concat([ordinary.image.subarray(0, 2), header, comment, ordinary.image.subarray(2)]);
    try {
      await writePrivateHubPreview(store, 'thumbnail', 'private-video', image);
      await writePrivateHubPreview(store, 'clip-poster', 'private-video', image);
    } finally { image.fill(0); comment.fill(0); }
    // This pre-existing fixture tests ordinary unlock separately. The converted
    // fixture below must acquire its receipt and activation through the host.
    const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
    try { await store.writeNewRecord('session:activation', activation); } finally { activation.fill(0); }
  } finally { ordinary.image.fill(0); await store.lock(); }
}
async function assertRestored(file = cataloguePath) {
  await host.workspace.settled;
  await until(() => !host.workspace.isActive && operations.accepting && !GLOBALS.catalogueTransitionActive && !GLOBALS.cataloguePersistenceActive);
  await waitDom('document.body.inert === false');
  assert.equal(host.window, normalWindow); assert.equal(normalWindow.isVisible(), true);
  assert.equal(privateWindows().length, 0); assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
  assert.equal(GLOBALS.currentlyOpenVhaFile, file);
}
async function editor() {
  if (!await dom(`!!document.querySelector(${JSON.stringify(NOTES)})`)) {
    await dom("document.querySelector('.workbench-navigation-tools').open = true; [...document.querySelectorAll('.workbench-navigation-tools button')].find(button => button.textContent.trim() === 'Catalogue editor').click(); true");
    await waitDom(`!!document.querySelector(${JSON.stringify(NOTES)})`);
  }
}
async function startUnlock() {
  const opening = host.openPrivateHubFromNative();
  const prompt = await privateWindow('privateUnlock');
  await waitDom("!!document.getElementById('password') && !document.getElementById('unlock').disabled", prompt);
  return { opening, prompt };
}
function fingerprint(directory) {
  const result = {};
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(current, entry.name);
      // The separately verified destination is not part of the ordinary hub.
      if (file === conversionParent) { continue; }
      if (entry.isDirectory()) { visit(file); }
      else if (entry.isFile()) {
        result[path.relative(directory, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
    }
  };
  visit(directory);
  return result;
}
function assertDestinationPreserved() {
  assert.deepEqual(fs.readdirSync(previousPrivateDirectory), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(previousPrivateDirectory, 'keep.txt'), 'utf8'), preservedContents);
  assert.equal(fs.readFileSync(path.join(conversionParent, 'keep.txt'), 'utf8'), preservedContents);
  assert.equal(fs.realpathSync(convertedDirectory), convertedDirectory);
}
async function startConversion() {
  const opening = host.createPrivateCopyFromNative();
  const form = await privateWindow('privateConversion');
  await waitDom("!document.getElementById('review').hidden && !document.getElementById('credentials').disabled", form);
  form.show(); form.focus();
  await waitDom('document.hasFocus() && !document.hidden', form);
  return { opening, form };
}
async function submitConversion(form) {
  await evaluate(form, "document.getElementById('acknowledge-originals').click(); document.getElementById('allow-missing').click(); true");
  await type('#password', configuration.conversionPassword, form);
  await type('#confirm-password', configuration.conversionPassword, form);
  void evaluate(form, "document.getElementById('conversion-form').requestSubmit(); true").catch(() => undefined);
}
async function conversionFlow() {
  setStage('host-conversion-review');
  const first = await startConversion();
  assert.equal(readNormal().images[0].notes, NORMAL_NOTES);
  assert.deepEqual(readNormal().images[0].tags, [NORMAL_TAG]);
  assert.equal(operations.accepting, false);
  assert.equal(normalWindow.isVisible(), false);
  assert.equal(hasSourceWatcher(0), false);
  await waitDom('document.body.inert === true');
  const sourceBefore = fingerprint(sourceDirectory);
  const savedBefore = fingerprint(normalDirectory);
  const formSession = first.form.webContents.session;
  assert.notEqual(formSession, session.defaultSession);
  assert.equal(formSession.isPersistent(), false);
  assert.deepEqual(await evaluate(first.form, '({ordinary: typeof globalThis.theatrum, node: typeof require})'),
    { ordinary: 'undefined', node: 'undefined' });
  const review = await evaluate(first.form, 'globalThis.privateConversion.getState()');
  assert.deepEqual(Object.keys(review).sort(), ['completed', 'phase', 'review', 'total']);
  assert.equal(review.phase, 'review');
  assert.deepEqual(review.review, { videos: 1, availablePreviews: 1,
    previewBytes: fs.statSync(path.join(normalDirectory, 'vha-Synthetic', 'thumbnails', 'normal-video.jpg')).size,
    missingPreviews: { thumbnail: 0, filmstrip: 1, 'clip-poster': 0, clip: 0 } });
  assert.ok(!JSON.stringify(review).includes(fixture) && !JSON.stringify(review).includes(NORMAL_NOTES));
  assert.equal(await host.createPrivateCopyFromNative(), 'unavailable');
  assert.equal(await host.openPrivateHubFromNative(), 'unavailable');
  assert.equal(privateWindows().length, 1);
  assert.equal(await formSession.getCacheSize(), 0);
  await checkpoint('host-conversion-review', { draftsSaved: true, normalPaused: true, normalHidden: true, watcherStopped: true,
    countOnlyReview: true, privateIsolated: true, concurrentEntryDenied: true, privateCacheBytes: 0 });

  setStage('host-conversion-cancelled');
  await submitConversion(first.form);
  await until(() => heldConversionPicker !== undefined);
  let openingSettled = false;
  void first.opening.then(() => { openingSettled = true; });
  void evaluate(first.form, "document.getElementById('cancel').click(); true").catch(() => undefined);
  await until(() => first.form.isDestroyed());
  assert.equal(openingSettled, false);
  assert.equal(host.workspace.isActive, true);
  assert.equal(operations.accepting, false);
  assert.equal(normalWindow.isVisible(), false);
  assert.equal(hasSourceWatcher(0), false);
  await waitDom('document.body.inert === true');
  assert.equal(await host.createPrivateCopyFromNative(), 'unavailable');
  assert.equal(await host.openPrivateHubFromNative(), 'unavailable');
  heldConversionPicker();
  assert.equal(await first.opening, 'cancelled');
  await assertRestored();
  await until(() => hasSourceWatcher(0));
  assert.equal(conversionPickerCalls, 1);
  assert.equal(fs.existsSync(convertedDirectory), false);
  assert.deepEqual(fs.readdirSync(cancelledConversionParent), []);
  assert.deepEqual(fingerprint(sourceDirectory), sourceBefore);
  assert.deepEqual(fingerprint(normalDirectory), savedBefore);
  await checkpoint('host-conversion-cancelled', { latePickerDrained: true, noOutput: true, formDestroyed: true, sourceUnchanged: true,
    normalRestored: true, watcherResumed: true });

  setStage('host-conversion-private');
  holdConversionPicker = false;
  const next = await startConversion();
  const secondSession = next.form.webContents.session;
  assert.notEqual(secondSession, formSession);
  const conversionSource = fingerprint(normalDirectory);
  await submitConversion(next.form);
  assert.equal(await next.opening, 'opened');
  assert.equal(conversionPickerCalls, 2);
  assert.equal(next.form.isDestroyed(), true);
  const gallery = await privateWindow('privateGallery');
  const gallerySession = gallery.webContents.session;
  assert.notEqual(gallerySession, secondSession);
  assert.notEqual(gallerySession, session.defaultSession);
  assert.equal(gallerySession.isPersistent(), false);
  await waitDom("document.querySelectorAll('#gallery-grid .video-card').length === 1", gallery);
  await waitDom("[...document.querySelectorAll('#gallery-grid img')].some(image => image.complete && image.naturalWidth === 64)", gallery);
  await evaluate(gallery, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitDom(`document.getElementById('details-notes').value === ${JSON.stringify(NORMAL_NOTES)}`, gallery);
  await waitDom(`document.getElementById('details-tags').textContent.includes(${JSON.stringify(NORMAL_TAG)})`, gallery);
  assert.equal(operations.accepting, false);
  assert.equal(hasSourceWatcher(0), false);
  assert.equal(normalWindow.isVisible(), false);
  assert.deepEqual(fingerprint(normalDirectory), conversionSource);
  assert.deepEqual(fingerprint(sourceDirectory), sourceBefore);
  assertDestinationPreserved();
  assert.equal(await gallerySession.getCacheSize(), 0);
  await checkpoint('host-conversion-private', { draftsCopied: true, previewDecoded: true, normalPaused: true, watcherStopped: true,
    formDestroyed: true, galleryIsolated: true, sourceUnchanged: true, existingFolderPreserved: true,
    sourceParentChangeAccepted: true, newChildCreated: true, privateCacheBytes: 0 });

  setStage('host-conversion-restored');
  void evaluate(gallery, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
  await assertRestored();
  await until(() => hasSourceWatcher(0));
  const converted = await PrivateHubStore.open(convertedDirectory, configuration.conversionPassword);
  try {
    const receipt = await verifyPrivateHubConversion(converted);
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.previews.length, 1);
    assert.deepEqual(receipt.missingPreviews, [{ kind: 'filmstrip', hash: 'normal-video' }]);
    const catalogue = await readPrivateHubCatalogue(converted);
    assert.equal(catalogue.images[0].notes, NORMAL_NOTES);
    assert.deepEqual(catalogue.images[0].tags, [NORMAL_TAG]);
    const activation = await converted.readRecord('session:activation', 512);
    try { assert.deepEqual(JSON.parse(activation.toString('utf8')),
      { format: 'theatrum-private-hub-activation', version: 1, hubId: converted.hubId }); }
    finally { activation.fill(0); }
  } finally { await converted.lock(); }
  assert.deepEqual(fingerprint(normalDirectory), conversionSource);
  assert.deepEqual(fingerprint(sourceDirectory), sourceBefore);
  await checkpoint('host-conversion-restored', { receiptVerified: true, activationVerified: true, missingStatePreserved: true,
    sourceUnchanged: true, normalRestored: true, watcherResumed: true });

  setStage('host-conversion-reopened');
  selectedPrivateDirectory = convertedDirectory;
  const reopening = await startUnlock();
  reopening.prompt.show(); reopening.prompt.focus();
  await type('#password', configuration.conversionPassword, reopening.prompt);
  void evaluate(reopening.prompt, "document.getElementById('unlock-form').requestSubmit(); true").catch(() => undefined);
  assert.equal(await reopening.opening, 'opened');
  const reopened = await privateWindow('privateGallery');
  reopened.show(); reopened.focus();
  await waitDom("document.querySelectorAll('#gallery-grid .video-card').length === 1", reopened);
  await evaluate(reopened, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitDom(`document.getElementById('details-notes').value === ${JSON.stringify(NORMAL_NOTES)}`, reopened);
  await type('#details-notes', configuration.privateCanary, reopened);
  await evaluate(reopened, "document.getElementById('save-details').click(); true");
  await waitDom("document.getElementById('edit-status').textContent === 'Changes saved.'", reopened);
  void evaluate(reopened, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
  await assertRestored();
  await until(() => hasSourceWatcher(0));
  const edited = await PrivateHubStore.open(convertedDirectory, configuration.conversionPassword);
  try { assert.equal((await readPrivateHubCatalogue(edited)).images[0].notes, configuration.privateCanary); }
  finally { await edited.lock(); }
  assert.equal(readNormal().images[0].notes, NORMAL_NOTES);
  assert.deepEqual(readNormal().images[0].tags, [NORMAL_TAG]);
  assertDestinationPreserved();
  assert.deepEqual(fingerprint(normalDirectory), conversionSource);
  assert.deepEqual(fingerprint(sourceDirectory), sourceBefore);
  assert.deepEqual(recentDocuments, [cataloguePath]);
  selectedPrivateDirectory = encryptedDirectory;
  await checkpoint('host-conversion-reopened', { passwordReopened: true, privateEditPersisted: true, ordinaryUnchanged: true,
    normalRestored: true, historyUnchanged: true });
}
async function run() {
  if (!configuration) { await new Promise(resolve => waiting.set('configuration', resolve)); }
  assert.ok(typeof configuration.privateCanary === 'string' && typeof configuration.privatePassword === 'string'
    && typeof configuration.conversionPassword === 'string');
  setStage('host-starting');
  await makePrivateFixture();
  await app.whenReady();
  await until(() => host.ready && host.window && GLOBALS.currentlyOpenVhaFile === cataloguePath && !GLOBALS.catalogueTransitionActive);
  normalWindow = host.window;
  normalWindow.setSize(1280, 850);
  // Test-window scheduling only; production window preferences are unchanged.
  normalWindow.webContents.setBackgroundThrottling(false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  ordinaryMenu = Menu.getApplicationMenu();
  await until(() => hasSourceWatcher(0));
  assert.equal(GLOBALS.settingsPath, settingsDirectory);
  assert.ok(nativeChoices.includes('Allow Catalogue Folder Access?'));
  assert.ok(nativeChoices.includes('Allow Automatic Folder Watching?'));
  assert.deepEqual(recentDocuments, [cataloguePath]);
  await editor(); await type(NOTES, NORMAL_NOTES); await type(TAGS, NORMAL_TAG);
  await checkpoint('host-started', { hostLoaded: true, angularLoaded: true });
  await conversionFlow();

  setStage('host-private');
  const first = await startUnlock();
  assert.equal(hasSourceWatcher(0), false);
  assert.equal(operations.accepting, false); assert.equal(normalWindow.isVisible(), false);
  assert.equal(readNormal().images[0].notes, NORMAL_NOTES);
  assert.deepEqual(readNormal().images[0].tags, [NORMAL_TAG]);
  await waitDom('document.body.inert === true');
  first.prompt.show(); first.prompt.focus();
  await type('#password', configuration.privatePassword, first.prompt);
  void evaluate(first.prompt, "document.getElementById('unlock-form').requestSubmit(); true").catch(() => undefined);
  assert.equal(await first.opening, 'opened');
  const gallery = await privateWindow('privateGallery');
  await waitDom("document.querySelectorAll('#gallery-grid .video-card').length === 1", gallery);
  assert.notEqual(gallery.webContents.session, normalWindow.webContents.session);
  assert.equal(gallery.webContents.session.isPersistent(), false);
  assert.deepEqual(await evaluate(gallery, '({ordinary: typeof globalThis.theatrum, node: typeof require})'), { ordinary: 'undefined', node: 'undefined' });
  gallery.show(); gallery.focus();
  await until(() => BrowserWindow.getFocusedWindow() === gallery);
  const deniedIpc = new Promise(resolve => ipcMain.once('minimize-window', event => {
    assert.equal(event.sender, normalWindow.webContents); resolve();
  }));
  await dom("globalThis.theatrum.ipc.send('minimize-window'); true");
  await deniedIpc;
  assert.equal(gallery.isMinimized(), false);
  // A new real source video must not restart the stopped ordinary watcher.
  fs.copyFileSync(path.join(sourceDirectory, 'synthetic.mp4'), path.join(sourceDirectory, 'added-while-private.mp4'));
  await host.sources.refresh();
  assert.equal(hasSourceWatcher(0), false);
  assert.equal(await gallery.webContents.session.getCacheSize(), 0);
  await checkpoint('host-private', { normalPaused: true, normalHidden: true, privateIsolated: true, watcherStopped: true, ipcDenied: true, privateCacheBytes: 0 });

  setStage('host-restored');
  void evaluate(gallery, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
  await assertRestored();
  await until(() => hasSourceWatcher(0));
  await editor();
  await waitDom("document.querySelector('.catalogue-editor')?.textContent.includes('added-while-private') || document.body.textContent.includes('added-while-private')");
  assert.equal(gallery.isDestroyed(), true);
  await checkpoint('host-restored', { normalResumed: true, normalVisible: true, privateWindowDestroyed: true, watcherResumed: true, addedVideoDiscovered: true });

  setStage('host-save-cancelled');
  await type(NOTES, 'Synthetic unsaved normal close draft');
  allowCloseChoice = true;
  const directoryMode = fs.statSync(normalDirectory).mode & 0o777;
  fs.chmodSync(normalDirectory, 0o500);
  try {
    normalWindow.close();
    await until(() => heldChoice?.kind === 'catalogue');
    assert.equal(GLOBALS.readyToQuit, false);
    assert.equal(readNormal().images[0].notes, NORMAL_NOTES);
    heldChoice.resolve();
    await until(() => !GLOBALS.cataloguePersistenceActive);
    assert.equal(await dom(`document.querySelector(${JSON.stringify(NOTES)}).value`), 'Synthetic unsaved normal close draft');
  } finally { fs.chmodSync(normalDirectory, directoryMode); }
  await checkpoint('host-save-cancelled', { keepWorking: true, draftPreserved: true, normalRestored: true });

  setStage('host-quit-cancelled');
  const quitting = await startUnlock();
  host.requestCatalogueOpenFromSystem(secondCataloguePath);
  assert.equal(GLOBALS.authorizedCataloguePaths.has(secondCataloguePath), false);
  const settingsMode = fs.statSync(settingsDirectory).mode & 0o777;
  fs.chmodSync(settingsDirectory, 0o500);
  try {
    normalWindow.close();
    assert.equal(await quitting.opening, 'cancelled');
    await until(() => heldChoice?.kind === 'settings');
    assert.equal(host.workspace.status.quitRequested, true);
    assert.equal(GLOBALS.currentlyOpenVhaFile, cataloguePath);
    assert.equal(GLOBALS.authorizedCataloguePaths.has(secondCataloguePath), false);
    assert.equal(privateWindows().length, 0);
  } finally { fs.chmodSync(settingsDirectory, settingsMode); }
  heldChoice.resolve();
  await until(() => !host.workspace.status.quitRequested && GLOBALS.currentlyOpenVhaFile === secondCataloguePath && !GLOBALS.catalogueTransitionActive);
  await assertRestored(secondCataloguePath);
  await until(() => hasSourceWatcher(0));
  assert.deepEqual(recentDocuments, [cataloguePath, secondCataloguePath]);
  await checkpoint('host-quit-cancelled', { quitCancelled: true, normalRestored: true, catalogueOpenDeferred: true });

  setStage('host-reopened');
  const again = await startUnlock();
  void evaluate(again.prompt, "document.getElementById('cancel').click(); true").catch(() => undefined);
  assert.equal(await again.opening, 'cancelled'); await assertRestored(secondCataloguePath);
  await until(() => hasSourceWatcher(0));
  await editor(); await type(NOTES, 'Synthetic final saved host draft');
  await dom('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(repository, 'tmp', 'private-host-restored-review.png'), (await normalWindow.webContents.capturePage()).toPNG());
  await checkpoint('host-reopened', { reopened: true, normalRestored: true });
  setStage('host-closed');
  expectedFinalQuit = true; normalWindow.close();
  await finalQuit;
  assert.equal(normalWindow.isDestroyed(), true);
  assert.equal(GLOBALS.readyToQuit, true);
  assert.equal(readNormal(secondCataloguePath).images.find(image => image.fileName === 'synthetic.mp4')?.notes, 'Synthetic final saved host draft');
  const settings = JSON.parse(fs.readFileSync(path.join(settingsDirectory, 'settings.json'), 'utf8'));
  assert.equal(settings.appState.currentVhaFile, secondCataloguePath);
  await beginNormalMediaDrain();
  await checkpoint('host-closed', { windowClosed: true, catalogueSaved: true, settingsSaved: true });
}
void run().then(async () => { await send({ type: 'complete' }); app.exit(0); }).catch(fail);
