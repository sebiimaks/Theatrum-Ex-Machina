/* Actual Angular/private-window acceptance with synthetic, Workspace-only state. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } = require('electron');
const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const fixture = argument('--private-application-fixture');
const assets = argument('--private-application-assets');
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.dirname(fixture) === path.join(repository, 'tmp') && fs.realpathSync(fixture) === fixture);
assert.equal(assets, path.join(repository, 'tmp', 'private-transition-angular'));
assert.equal(fs.realpathSync(assets), assets);
for (const [key, folder] of [['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data'],
  ['temp', 'temporary'], ['crashDumps', 'crash-dumps'], ['logs', 'logs'], ['downloads', 'downloads']]) {
  const target = path.join(fixture, 'profile', folder);
  fs.mkdirSync(target, { recursive: true }); app.setPath(key, target);
}
app.on('window-all-closed', () => undefined);
protocol.registerSchemesAsPrivileged([{ scheme: 'theatrum', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
require('ts-node').register({ project: path.join(repository, 'tsconfig.persistence-tests.json'),
  transpileOnly: true, preferTsExts: true, compilerOptions: { module: 'commonjs', target: 'es2022' } });
const { GLOBALS } = require('./main-globals.ts');
const { NewImageElement } = require('../interfaces/final-object.interface.ts');
const { NORMAL_CATALOGUE_STORAGE, writeCatalogueStorage } = require('./catalogue-storage.ts');
const { buildCatalogueMediaLocationAuthority } = require('./catalogue-media-authority.ts');
const { createTheatrumProtocolHandler } = require('./theatrum-protocol.ts');
const { normalOperationScope: operations } = require('./normal-operation-scope.ts');
const { NormalApplicationPause } = require('./normal-application-pause.ts');
const { createPrivateApplicationWorkspace } = require('./private-application-workspace.ts');
const { PrivateHubStore } = require('./private-hub-store.ts');
const { writePrivateHubCatalogue, writePrivateHubPreview } = require('./private-hub-catalogue.ts');
const { getMediaToolPath } = require('./media-tool-paths.ts');
const { SAVED_NORMAL_DOCUMENT_CHANNELS } = require('../interfaces/saved-normal-document.ts');
const NORMAL_URL = 'theatrum://app/index.html#/';
const NOTES = '.catalogue-row .notes-field textarea';
const TAGS = '.catalogue-row .catalogue-tag-input input[placeholder="Separate tags with commas"]';
const NORMAL_NOTES = 'Synthetic normal notes saved before private opening';
const NORMAL_TAG = 'Synthetic > Pending draft';
let stage = 'configuration';
let configuration;
let normalWindow;
let normalDocumentUrl;
let workspace;
let normal;
let normalProtocol;
let ordinaryMenu;
let ready = false;
let pauseCount = 0;
let resumeCount = 0;
let sourcePaused = false;
let snapshotCount = 0;
let quitRetries = 0;
let quitIntercept;
let finalQuit = false;
const waiting = new Map();
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
async function fail(error) {
  // Exception messages may contain assertion values. Report only this harness's
  // outermost line number, never messages, paths or complete stacks.
  const locations = [...(error?.stack ?? '').matchAll(/private-application-native\.cjs:(\d+):/g)];
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
const cataloguePath = path.join(normalDirectory, 'Synthetic.scaena');
const encryptedDirectory = path.join(fixture, 'encrypted-hub');
const readNormal = () => JSON.parse(fs.readFileSync(cataloguePath, 'utf8'));
async function makeCatalogues() {
  const source = path.join(fixture, 'ordinary-source');
  fs.mkdirSync(source); fs.mkdirSync(normalDirectory);
  const catalogue = { addTags: [], removeTags: [], hubName: 'Synthetic', version: 3, numOfFolders: 1,
    inputDirs: { 0: { path: source, watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
    images: [{ ...NewImageElement(), hash: 'normal-video', fileName: 'synthetic.mp4', cleanName: 'Synthetic normal video',
      duration: 6, screens: 3, width: 64, height: 36, notes: 'Original normal notes', tags: ['Original'] }],
  };
  await writeCatalogueStorage({ kind: 'normal', filePath: cataloguePath }, catalogue);
  Object.assign(GLOBALS, { catalogueStorage: NORMAL_CATALOGUE_STORAGE, catalogueAccessMode: 'read-write',
    currentlyOpenVhaFile: cataloguePath, catalogueSessionGeneration: 1, catalogueTransitionActive: false,
    selectedOutputFolder: normalDirectory, selectedSourceFolders: structuredClone(catalogue.inputDirs),
    hubName: catalogue.hubName, screenshotSettings: structuredClone(catalogue.screenshotSettings),
    authorizedCataloguePaths: new Set([cataloguePath]), authorizedCatalogueImageHashes: new Set(['normal-video']),
    authorizedCatalogueMediaLocations: buildCatalogueMediaLocationAuthority(catalogue.images),
    authorizedSourceFolderPaths: new Set([source]), authorizedSourceFolderRealPaths: new Map([[source, source]]),
    authorizedSourceWatchPaths: new Set(),
  });
  const ffmpeg = fs.realpathSync(getMediaToolPath('ffmpeg'));
  assert.ok(ffmpeg.startsWith('/Users/sm/Workspace/'));
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:size=64x36',
    '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
  { cwd: repository, timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(encoded.status, 0);
  const thumbnails = path.join(normalDirectory, 'vha-Synthetic', 'thumbnails');
  fs.mkdirSync(thumbnails, { recursive: true }); fs.writeFileSync(path.join(thumbnails, 'normal-video.jpg'), encoded.stdout);
  const store = await PrivateHubStore.create(encryptedDirectory, configuration.privatePassword);
  try {
    const secret = { ...catalogue, hubName: configuration.privateCanary,
      images: [{ ...catalogue.images[0], hash: 'private-video', cleanName: 'Synthetic private video', notes: configuration.privateCanary }] };
    await writePrivateHubCatalogue(store, secret);
    const comment = Buffer.from(configuration.privateCanary);
    const header = Buffer.alloc(4); header.writeUInt16BE(0xfffe, 0); header.writeUInt16BE(comment.length + 2, 2);
    const image = Buffer.concat([encoded.stdout.subarray(0, 2), header, comment, encoded.stdout.subarray(2)]);
    try {
      await writePrivateHubPreview(store, 'thumbnail', 'private-video', image);
      await writePrivateHubPreview(store, 'clip-poster', 'private-video', image);
    } finally { image.fill(0); comment.fill(0); }
    // This synthetic hub is created directly for lifecycle acceptance. Copy
    // conversion/receipt acceptance is deliberately a separate workflow.
    const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
    try { await store.writeNewRecord('session:activation', activation); } finally { activation.fill(0); }
  } finally { encoded.stdout.fill(0); await store.lock(); }
  return catalogue;
}
async function assertRestored() {
  await workspace.settled;
  await until(() => !workspace.isActive);
  await waitDom('document.body.inert === false');
  assert.equal(normalWindow.isVisible(), true);
  assert.equal(normal.status.state, 'normal'); assert.equal(operations.accepting, true);
  assert.equal(sourcePaused, false); assert.equal(privateWindows().length, 0);
  assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
}
async function startUnlock() {
  const opening = workspace.open();
  const prompt = await privateWindow('privateUnlock');
  await waitDom("!!document.getElementById('password') && !document.getElementById('unlock').disabled", prompt);
  return { opening, prompt };
}
async function submitPassword(prompt) {
  // Native input events exercise the production password form. No clipboard.
  prompt.show(); prompt.focus();
  await type('#password', configuration.privatePassword, prompt);
  void evaluate(prompt, "document.getElementById('unlock-form').requestSubmit(); true").catch(() => undefined);
}
async function run() {
  if (!configuration) { await new Promise(resolve => waiting.set('configuration', resolve)); }
  assert.ok(typeof configuration.privateCanary === 'string' && typeof configuration.privatePassword === 'string');
  setStage('fixtures');
  const catalogue = await makeCatalogues();
  const preload = path.join(fixture, 'preload.cjs');
  fs.writeFileSync(preload, ts.transpileModule(fs.readFileSync(path.join(repository, 'preload.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText);
  await app.whenReady();
  normalProtocol = createTheatrumProtocolHandler(assets);
  session.defaultSession.protocol.handle('theatrum', normalProtocol);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  ordinaryMenu = Menu.buildFromTemplate([{ label: 'Synthetic ordinary app', submenu: [{ label: 'Ordinary action', click: () => undefined }] }]);
  Menu.setApplicationMenu(ordinaryMenu);
  ipcMain.on('just-started', async event => {
    try {
      assert.equal(event.sender, normalWindow.webContents);
      await waitDom("!!document.querySelector('app-sort-order')");
      event.sender.send('set-language-based-off-system-locale', 'en');
      event.sender.send('final-object-returning', catalogue, cataloguePath, normalDirectory, false, 'read-write');
    } catch (error) { await fail(error); }
  });
  ipcMain.on('renderer-startup-complete', event => { assert.equal(event.sender, normalWindow.webContents); ready = true; });
  ipcMain.on(SAVED_NORMAL_DOCUMENT_CHANNELS.snapshot, event => { assert.equal(event.sender, normalWindow.webContents); snapshotCount++; });
  normalWindow = new BrowserWindow({ width: 1280, height: 850, show: true, webPreferences: {
    preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } });
  normalWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  normalWindow.webContents.on('will-navigate', event => event.preventDefault());
  normalWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  setStage('angular-startup');
  await normalWindow.loadURL(NORMAL_URL);
  await until(() => ready);
  await waitDom("document.querySelector('.workbench-catalogue')?.textContent.includes('Synthetic')");
  // Angular canonicalizes its empty hash route after the initial navigation.
  normalDocumentUrl = normalWindow.webContents.getURL();
  const documentUrl = new URL(normalDocumentUrl);
  assert.equal(documentUrl.protocol, 'theatrum:');
  assert.equal(documentUrl.host, 'app');
  assert.ok(documentUrl.pathname === '/' || documentUrl.pathname === '/index.html');
  normal = new NormalApplicationPause({ operations, canPause: () => ready && !GLOBALS.catalogueTransitionActive,
    onPause: () => { pauseCount++; GLOBALS.catalogueTransitionActive = true; },
    pauseSources: async () => { sourcePaused = true; }, drainMedia: async () => undefined,
    resumeSources: () => { sourcePaused = false; }, resumeMedia: () => undefined,
    onResume: () => { resumeCount++; GLOBALS.catalogueTransitionActive = false; },
  });
  workspace = createPrivateApplicationWorkspace({ appDirectory: path.join(repository, 'private-gallery'), normal, operations,
    state: GLOBALS, getNormalWindow: () => normalWindow, canStart: () => ready,
    isAllowedRendererUrl: url => url === normalDocumentUrl,
    afterResume: () => normalWindow.webContents.send('normal-workspace-resumed'),
  });
  dialog.showOpenDialog = async (owner, options) => {
    assert.equal(owner, normalWindow); assert.equal(options.title, 'Open private hub');
    return { canceled: false, filePaths: [encryptedDirectory] };
  };
  setStage('normal-editor');
  await dom("document.querySelector('.workbench-navigation-tools').open = true; [...document.querySelectorAll('.workbench-navigation-tools button')].find(button => button.textContent.trim() === 'Catalogue editor').click(); true");
  await waitDom(`!!document.querySelector(${JSON.stringify(NOTES)})`);
  await type(NOTES, NORMAL_NOTES); await type(TAGS, NORMAL_TAG);
  assert.equal(readNormal().images[0].notes, 'Original normal notes');
  await checkpoint('normal-editor', { angularLoaded: true, draftPreserved: true });

  setStage('open-with-pending-operation');
  assert.equal(app.isReady(), true);
  assert.equal(operations.inOperation, false);
  assert.equal(operations.isCurrent(), true);
  assert.equal(normalWindow.webContents.getURL(), normalDocumentUrl);
  assert.equal(normalWindow.webContents.mainFrame.url, normalDocumentUrl);
  assert.equal(normalWindow.webContents.mainFrame.parent, null);
  assert.equal(normalWindow.webContents.mainFrame.detached, false);
  assert.equal(GLOBALS.catalogueTransitionActive, false);
  let releaseOperation;
  const pending = operations.run(async context => {
    await new Promise(resolve => { releaseOperation = resolve; });
    assert.equal(context.isCurrent(), false);
  });
  const opening = workspace.open();
  void opening.then(outcome => { if (outcome !== 'opened') { setStage('opening-' + outcome); } });
  await until(() => normal.status.state === 'pausing');
  assert.equal(snapshotCount, 0); assert.equal(privateWindows().length, 0);
  releaseOperation(); await pending;
  setStage('waiting-for-unlock');
  const prompt = await privateWindow('privateUnlock');
  setStage('checking-frozen-document');
  await waitDom('document.body.inert === true');
  assert.equal(readNormal().images[0].notes, NORMAL_NOTES);
  assert.deepEqual(readNormal().images[0].tags, [NORMAL_TAG]);
  assert.equal(normalWindow.isVisible(), false); assert.equal(sourcePaused, true);
  assert.equal(Menu.getApplicationMenu() === ordinaryMenu, false);
  const priorNotes = await dom(`document.querySelector(${JSON.stringify(NOTES)}).value`);
  assert.equal(await dom(`!document.querySelector(${JSON.stringify(NOTES)}).dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'late', inputType: 'insertText' }))`), true);
  assert.equal(await dom(`document.querySelector(${JSON.stringify(NOTES)}).value`), priorNotes);
  assert.equal((await normalProtocol(new Request('theatrum://app/media/thumbnails/normal-video.jpg'))).status, 404);
  setStage('private-password');
  await submitPassword(prompt);
  assert.equal(await opening, 'opened'); assert.equal(prompt.isDestroyed(), true);
  const gallery = await privateWindow('privateGallery');
  await waitDom("document.querySelectorAll('#gallery-grid .video-card').length === 1", gallery);
  await evaluate(gallery, "document.querySelector('#gallery-grid .video-card').click(); true");
  await waitDom(`document.getElementById('details-notes').value === ${JSON.stringify(configuration.privateCanary)}`, gallery);
  assert.notEqual(gallery.webContents.session, normalWindow.webContents.session);
  assert.equal(gallery.webContents.session.isPersistent(), false);
  assert.deepEqual(await evaluate(gallery, '({ordinary: typeof globalThis.theatrum, node: typeof require})'), { ordinary: 'undefined', node: 'undefined' });
  assert.equal(await dom(`document.documentElement.textContent.includes(${JSON.stringify(configuration.privateCanary)})`), false);
  await type('#details-notes', configuration.privateCanary + ' edited', gallery);
  await evaluate(gallery, "document.getElementById('save-details').click(); true");
  await waitDom("document.getElementById('edit-status').textContent === 'Changes saved.'", gallery);
  const privateSession = gallery.webContents.session;
  assert.equal(await privateSession.getCacheSize(), 0);
  await checkpoint('private-open', { normalPaused: true, normalHidden: true, sourcesPaused: true,
    frozenSnapshotSaved: true, notesSaved: true, tagDraftSaved: true, staleInputBlocked: true,
    mediaDenied: true, privateIsolated: true, privateNotesEdited: true, privateCacheBytes: 0 });

  setStage('lock-restored');
  const closing = workspace.settled;
  void evaluate(gallery, "document.getElementById('lock-hub').click(); true").catch(() => undefined);
  await closing; await assertRestored(); assert.equal(gallery.isDestroyed(), true);
  assert.equal(await privateSession.getCacheSize(), 0);
  assert.equal((await normalProtocol(new Request('theatrum://app/media/thumbnails/normal-video.jpg', { method: 'HEAD' }))).status, 200);
  await type(NOTES, 'Synthetic edits after return');
  fs.writeFileSync(path.join(repository, 'tmp', 'private-application-restored-review.png'), (await normalWindow.webContents.capturePage()).toPNG());
  await checkpoint('lock-restored', { normalVisible: true, normalResumed: true, menuRestored: true,
    privateWindowDestroyed: true, restoredDraftEditable: true, privateCacheBytes: 0 });

  setStage('cancelled-unlock');
  const cancelled = await startUnlock();
  void evaluate(cancelled.prompt, "document.getElementById('cancel').click(); true").catch(() => undefined);
  assert.equal(await cancelled.opening, 'cancelled'); await assertRestored();
  assert.equal(readNormal().images[0].notes, 'Synthetic edits after return');
  await checkpoint('cancelled-unlock', { cancelled: true, normalRestored: true, draftSaved: true, menuRestored: true });

  setStage('composition-refused');
  await type(NOTES, 'Synthetic unfinished composition');
  await dom(`document.querySelector(${JSON.stringify(NOTES)}).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); true`);
  assert.equal(await workspace.open(), 'unavailable'); await assertRestored();
  assert.equal(readNormal().images[0].notes, 'Synthetic edits after return');
  assert.equal(await dom(`document.querySelector(${JSON.stringify(NOTES)}).value`), 'Synthetic unfinished composition');
  await dom(`document.querySelector(${JSON.stringify(NOTES)}).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); true`);
  await checkpoint('composition-refused', { compositionRefused: true, draftPreserved: true, normalRestored: true });

  setStage('save-refused');
  await type(TAGS, 'Invalid >> hierarchy');
  assert.equal(await workspace.open(), 'unavailable'); await assertRestored();
  assert.equal(readNormal().images[0].notes, 'Synthetic edits after return');
  assert.equal(await dom(`document.querySelector(${JSON.stringify(TAGS)}).value`), 'Invalid >> hierarchy');
  await type(TAGS, NORMAL_TAG);
  await type(NOTES, 'Synthetic corrected draft');
  await checkpoint('save-refused', { draftRefused: true, draftPreserved: true, mutationAfterRefusal: true, normalRestored: true });

  setStage('write-refused');
  // Make only the owned synthetic catalogue directory unwritable. Exercise
  // the real atomic writer, then restore permissions even if an assertion fails.
  const writableMode = fs.statSync(normalDirectory).mode & 0o777;
  fs.chmodSync(normalDirectory, 0o500);
  try {
    assert.equal(await workspace.open(), 'unavailable'); await assertRestored();
    assert.equal(readNormal().images[0].notes, 'Synthetic edits after return');
    assert.equal(await dom(`document.querySelector(${JSON.stringify(NOTES)}).value`), 'Synthetic corrected draft');
  } finally { fs.chmodSync(normalDirectory, writableMode); }
  await checkpoint('write-refused', { saveRefused: true, draftPreserved: true, normalRestored: true });

  setStage('quit-restored');
  const quitting = await startUnlock();
  quitIntercept = event => { if (!finalQuit) { event.preventDefault(); quitRetries++; } };
  app.on('before-quit', quitIntercept);
  const quit = workspace.requestQuit();
  assert.equal(await quitting.opening, 'cancelled'); await quit; await assertRestored();
  assert.equal(quitRetries, 1); assert.equal(workspace.status.quitRequested, true);
  assert.equal(workspace.acknowledgeQuitCancelled(), true);
  assert.equal(workspace.status.quitRequested, false);
  assert.equal(readNormal().images[0].notes, 'Synthetic corrected draft');
  const again = await startUnlock();
  void evaluate(again.prompt, "document.getElementById('cancel').click(); true").catch(() => undefined);
  assert.equal(await again.opening, 'cancelled'); await assertRestored();
  await checkpoint('quit-restored', { quitRestored: true, normalRestored: true, menuRestored: true, pauseCount, resumeCount });
  assert.equal(pauseCount, resumeCount);
}
void run().then(async () => {
  await send({ type: 'complete' }); finalQuit = true;
  if (quitIntercept) { app.removeListener('before-quit', quitIntercept); }
  normalWindow?.destroy(); app.exit(0);
}).catch(fail);
