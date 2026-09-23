/* Native private-copy acceptance with synthetic, Workspace-only state. */
'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, dialog, Menu, protocol, session } = require('electron');
const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const fixture = process.argv.find(value => value.startsWith('--private-conversion-fixture='))?.slice('--private-conversion-fixture='.length);
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.dirname(fixture) === path.join(repository, 'tmp') && fs.realpathSync(fixture) === fixture);
for (const [key, name] of [['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data'],
  ['temp', 'temporary'], ['crashDumps', 'crash-dumps'], ['logs', 'logs'], ['downloads', 'downloads']]) {
  const target = path.join(fixture, 'profile', name);
  fs.mkdirSync(target, { recursive: true }); app.setPath(key, target);
}
app.on('window-all-closed', () => undefined);
// Record attempted history writes without forwarding any state into macOS.
let recentWrites = 0;
app.addRecentDocument = () => { recentWrites++; };
app.clearRecentDocuments = () => { throw new Error('Unexpected OS history mutation.'); };
protocol.registerSchemesAsPrivileged([{ scheme: 'theatrum', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
require('ts-node').register({ project: path.join(repository, 'tsconfig.persistence-tests.json'),
  transpileOnly: true, preferTsExts: true, compilerOptions: { module: 'commonjs', target: 'es2022' } });
const { NewImageElement } = require('../interfaces/final-object.interface.ts');
const { createPrivateConversionWorkspace } = require('./private-conversion-workspace.ts');
const { PrivateHubStore } = require('./private-hub-store.ts');
const { readPrivateHubCatalogue } = require('./private-hub-catalogue.ts');
const { verifyPrivateHubConversion } = require('./private-hub-conversion.ts');
const { getMediaToolPath } = require('./media-tool-paths.ts');
const source = path.join(fixture, 'ordinary-hub');
const cataloguePath = path.join(source, 'Synthetic.scaena');
const destinationParent = path.join(fixture, 'selected-folder');
const previousPrivateDirectory = path.join(destinationParent, 'Private hub');
const destination = path.join(destinationParent, 'Private hub 2');
const preservedContents = 'Synthetic existing folder contents';
let configuration;
let stage = 'configuration';
let defaultRequests = 0;
let pickerCalls = 0;
let pickerCancelled = true;
let ordinaryMenu;
let workspace;
let sourceFingerprint;
const waiting = new Map();
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
process.on('message', message => {
  if (message?.type === 'configuration') { configuration = message; waiting.get('configuration')?.(); }
  else if (message?.type === 'continue') { waiting.get(message.stage)?.(); }
});
async function fail(error) {
  const locations = [...(error?.stack ?? '').matchAll(/private-conversion-native\.cjs:(\d+):/g)];
  const line = locations.at(-1)?.[1];
  try { await send({ type: 'failure', stage, line: line ? Number(line) : undefined }); } catch { /* Parent may have stopped. */ }
  app.exit(1);
}
function setStage(value) { stage = value; if (process.connected) { process.send({ type: 'progress', stage }); } }
async function checkpoint(name, checks) {
  const continued = new Promise(resolve => waiting.set(name, resolve));
  await send({ type: 'checkpoint', stage: name, checks });
  await continued; waiting.delete(name);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
async function until(predicate) {
  for (let index = 0; index < 1000; index++) { if (await predicate()) { return; } await delay(10); }
  assert.fail('Native conversion did not reach its required state.');
}
async function waitDom(window, code) {
  await until(async () => { try { return await evaluate(window, code); } catch { return false; } });
}
async function findWindow(surface) {
  let found;
  await until(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) { continue; }
      try { if (await evaluate(window, `!!globalThis.${surface}`)) { found = window; return true; } }
      catch { /* The isolated document is still loading. */ }
    }
    return false;
  });
  return found;
}
async function click(window, selector) {
  await evaluate(window, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); element.click(); return true; })()`);
}
async function type(window, selector, value) {
  await evaluate(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.scrollIntoView({ block: 'center' }); input.focus(); input.select(); })()`);
  // Native insertion exercises the real sandbox form without using clipboard.
  await window.webContents.insertText(value);
  await waitDom(window, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
}
async function passwords(window) {
  window.show(); window.focus();
  await waitDom(window, 'document.hasFocus() && !document.hidden');
  await type(window, '#password', configuration.password);
  await type(window, '#confirm-password', configuration.password);
}
function fingerprint(directory) {
  const result = {};
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) { visit(file); }
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        result[path.relative(directory, file)] = `${stat.ino}:${stat.mtimeMs}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
      }
    }
  };
  visit(directory);
  return result;
}
function assertSourceUnchanged() {
  assert.deepEqual(fingerprint(source), sourceFingerprint);
  assert.deepEqual(fs.readdirSync(previousPrivateDirectory), ['keep.txt']);
  assert.equal(fs.readFileSync(path.join(previousPrivateDirectory, 'keep.txt'), 'utf8'), preservedContents);
  assert.equal(fs.readFileSync(path.join(destinationParent, 'keep.txt'), 'utf8'), preservedContents);
}
function makeCatalogue() {
  fs.mkdirSync(source);
  fs.mkdirSync(previousPrivateDirectory, { recursive: true });
  fs.writeFileSync(path.join(previousPrivateDirectory, 'keep.txt'), preservedContents);
  fs.writeFileSync(path.join(destinationParent, 'keep.txt'), preservedContents);
  const catalogue = { addTags: [], removeTags: [], hubName: 'Synthetic', version: 3, numOfFolders: 1,
    inputDirs: { 0: { path: path.join(fixture, 'unopened-originals'), watch: false } },
    screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 3 },
    images: [{ ...NewImageElement(), hash: 'synthetic-video', fileName: 'synthetic.mp4', cleanName: 'Synthetic private video',
      duration: 6, screens: 3, width: 64, height: 36, notes: configuration.marker, tags: ['Synthetic tag'] }],
  };
  fs.writeFileSync(cataloguePath, JSON.stringify(catalogue));
  fs.writeFileSync(cataloguePath + '.bak', JSON.stringify(catalogue));
  const ffmpeg = fs.realpathSync(getMediaToolPath('ffmpeg'));
  assert.ok(ffmpeg.startsWith('/Users/sm/Workspace/'));
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=teal:size=64x36',
    '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
  { cwd: repository, timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(encoded.status, 0);
  const thumbnails = path.join(source, 'vha-Synthetic', 'thumbnails');
  fs.mkdirSync(thumbnails, { recursive: true });
  const comment = Buffer.from(configuration.marker);
  const header = Buffer.alloc(4); header.writeUInt16BE(0xfffe, 0); header.writeUInt16BE(comment.length + 2, 2);
  const image = Buffer.concat([encoded.stdout.subarray(0, 2), header, comment, encoded.stdout.subarray(2)]);
  try { fs.writeFileSync(path.join(thumbnails, 'synthetic-video.jpg'), image); }
  finally { image.fill(0); comment.fill(0); encoded.stdout.fill(0); }
  // Missing filmstrip is deliberate: the real review and consent path must run.
  sourceFingerprint = fingerprint(source);
}
function isolation(window, surface) {
  const isolated = window.webContents.session;
  assert.notEqual(isolated, session.defaultSession);
  assert.equal(isolated.isPersistent(), false);
  assert.equal(isolated.storagePath, null);
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
  return evaluate(window, `({ ordinary: typeof globalThis.theatrum, node: typeof require, process: typeof process,
    bridge: typeof globalThis.${surface} })`).then(result => {
    assert.deepEqual(result, { ordinary: 'undefined', node: 'undefined', process: 'undefined', bridge: 'object' });
    return isolated;
  });
}
async function start() {
  const transition = new AbortController();
  workspace = createPrivateConversionWorkspace({ appDirectory: path.join(repository, 'private-gallery'), lifecycle: 'external' });
  const opening = workspace.open({ directory: cataloguePath, isAuthorized: () => !transition.signal.aborted, signal: transition.signal });
  const form = await findWindow('privateConversion');
  await waitDom(form, "!document.getElementById('review').hidden && !document.getElementById('credentials').disabled");
  form.show(); form.focus();
  await waitDom(form, 'document.hasFocus() && !document.hidden');
  return { opening, form, transition };
}
async function run() {
  if (!configuration) { await new Promise(resolve => waiting.set('configuration', resolve)); }
  assert.ok(typeof configuration.marker === 'string' && typeof configuration.password === 'string');
  setStage('fixtures');
  makeCatalogue();
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => { defaultRequests++; callback({ cancel: true }); });
  ordinaryMenu = Menu.buildFromTemplate([{ label: 'Synthetic ordinary app', submenu: [{ label: 'Ordinary action', click: () => undefined }] }]);
  Menu.setApplicationMenu(ordinaryMenu);
  dialog.showOpenDialog = async (owner, options) => {
    assert.ok(owner && !owner.isDestroyed());
    assert.equal(await evaluate(owner, 'typeof globalThis.privateConversion'), 'object');
    assert.equal(options.title, 'Create private copy');
    assert.equal(options.buttonLabel, 'Create private copy here');
    assert.deepEqual(options.properties, ['openDirectory', 'createDirectory', 'dontAddToRecent']);
    assert.equal(options.securityScopedBookmarks, false);
    assert.equal(fs.realpathSync(destinationParent), destinationParent);
    pickerCalls++;
    return pickerCancelled ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [destinationParent] };
  };

  setStage('conversion-review');
  const first = await start();
  const firstSession = await isolation(first.form, 'privateConversion');
  assert.equal(await evaluate(first.form, 'typeof globalThis.privateGallery'), 'undefined');
  assert.deepEqual(await evaluate(first.form, 'Object.keys(globalThis.privateConversion).sort()'), ['cancel', 'getState', 'submit']);
  const state = await evaluate(first.form, 'globalThis.privateConversion.getState()');
  assert.deepEqual(Object.keys(state).sort(), ['completed', 'phase', 'review', 'total']);
  assert.equal(state.phase, 'review');
  assert.equal(state.review.videos, 1);
  assert.equal(state.review.availablePreviews, 1);
  assert.deepEqual(state.review.missingPreviews, { thumbnail: 0, filmstrip: 1, 'clip-poster': 0, clip: 0 });
  assert.ok(!JSON.stringify(state).includes(configuration.marker));
  assert.ok(!JSON.stringify(state).includes(configuration.password));
  assert.ok(!JSON.stringify(state).includes(fixture));
  assert.equal(await evaluate(first.form, "document.getElementById('password').value === '' && document.getElementById('confirm-password').value === ''"), true);
  assert.equal(await evaluate(first.form, "!document.getElementById('missing-review').hidden && !document.getElementById('missing-consent').hidden"), true);
  first.form.setContentSize(720, 920);
  await evaluate(first.form, 'window.scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(repository, 'tmp', 'private-conversion-review.png'), (await first.form.webContents.capturePage()).toPNG());
  first.form.setContentSize(440, 640);
  await evaluate(first.form, 'window.scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate(first.form, 'document.documentElement.scrollWidth <= innerWidth'), true);
  for (const selector of ['#password', '#confirm-password', '#allow-missing', '#acknowledge-originals', '#cancel', '#create-copy']) {
    assert.equal(await evaluate(first.form, `(() => { const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight; })()`), true);
  }
  await evaluate(first.form, 'window.scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(repository, 'tmp', 'private-conversion-small-review.png'), (await first.form.webContents.capturePage()).toPNG());
  assert.equal(await firstSession.getCacheSize(), 0);
  await checkpoint('conversion-review', { isolated: true, ordinaryBridgeAbsent: true, countOnlyReview: true,
    missingPreviewVisible: true, credentialsEmpty: true, compactControlsReachable: true, cacheBytes: 0, defaultRequests, recentWrites });

  setStage('picker-cancelled');
  first.form.setContentSize(720, 920);
  await passwords(first.form);
  await click(first.form, '#create-copy');
  await waitDom(first.form, "document.getElementById('conversion-status').textContent.includes('originals remain unencrypted')");
  assert.equal(pickerCalls, 0);
  await click(first.form, '#acknowledge-originals');
  await passwords(first.form);
  await click(first.form, '#create-copy');
  await waitDom(first.form, "document.getElementById('conversion-status').textContent.includes('missing previews')");
  assert.equal(pickerCalls, 0);
  await click(first.form, '#allow-missing');
  await passwords(first.form);
  void click(first.form, '#create-copy').catch(() => undefined);
  assert.equal(await first.opening, 'cancelled');
  await workspace.settled;
  assert.equal(first.form.isDestroyed(), true);
  assert.equal(pickerCalls, 1);
  assert.equal(fs.existsSync(destination), false);
  assertSourceUnchanged();
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
  assert.equal(await firstSession.getCacheSize(), 0);
  await checkpoint('picker-cancelled', { originalConsentRequired: true, missingConsentRequired: true, pickerCancelled: true,
    formDestroyed: true, noOutput: true, sourceUnchanged: true, menuRestored: true, cacheBytes: 0, defaultRequests, recentWrites });

  setStage('conversion-open');
  pickerCancelled = false;
  const second = await start();
  const secondSession = await isolation(second.form, 'privateConversion');
  assert.notEqual(secondSession, firstSession);
  await click(second.form, '#acknowledge-originals');
  await click(second.form, '#allow-missing');
  await passwords(second.form);
  void click(second.form, '#create-copy').catch(() => undefined);
  assert.equal(await second.opening, 'opened');
  assert.equal(second.form.isDestroyed(), true);
  assert.equal(pickerCalls, 2);
  const gallery = await findWindow('privateGallery');
  const gallerySession = await isolation(gallery, 'privateGallery');
  assert.notEqual(gallerySession, secondSession);
  await waitDom(gallery, "document.querySelectorAll('#gallery-grid .video-card').length === 1");
  await waitDom(gallery, "[...document.querySelectorAll('#gallery-grid .video-card img')].some(image => image.complete && image.naturalWidth === 64)");
  await click(gallery, '#gallery-grid .video-card');
  await waitDom(gallery, `document.getElementById('details-notes').value === ${JSON.stringify(configuration.marker)}`);
  assertSourceUnchanged();
  assert.equal(await secondSession.getCacheSize(), 0);
  assert.equal(await gallerySession.getCacheSize(), 0);
  await checkpoint('conversion-open', { freshFormPartition: true, formDestroyed: true, galleryIsolated: true, imageDecoded: true,
    notesPreserved: true, sourceUnchanged: true, existingFolderPreserved: true, newChildCreated: true,
    cacheBytes: 0, defaultRequests, recentWrites });

  setStage('conversion-closed');
  const closed = workspace.settled;
  void click(gallery, '#lock-hub').catch(() => undefined);
  await closed;
  assert.equal(gallery.isDestroyed(), true);
  assert.deepEqual(workspace.status, { state: 'idle', cleanupFailed: false });
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
  assert.equal(await gallerySession.getCacheSize(), 0);
  const store = await PrivateHubStore.open(destination, configuration.password);
  try {
    const receipt = await verifyPrivateHubConversion(store);
    assert.equal(receipt.state, 'complete');
    assert.equal(receipt.previews.length, 1);
    assert.deepEqual(receipt.missingPreviews, [{ kind: 'filmstrip', hash: 'synthetic-video' }]);
    assert.equal((await readPrivateHubCatalogue(store)).images[0].notes, configuration.marker);
    const activation = await store.readRecord('session:activation', 512);
    try {
      assert.deepEqual(JSON.parse(activation.toString('utf8')), { format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId });
    } finally { activation.fill(0); }
  } finally { await store.lock(); }
  assertSourceUnchanged();
  await checkpoint('conversion-closed', { galleryDestroyed: true, receiptVerified: true, missingStatePreserved: true,
    activationVerified: true, notesPreserved: true, sourceUnchanged: true, menuRestored: true,
    cacheBytes: 0, defaultRequests, recentWrites });
}
void run().then(async () => { await send({ type: 'complete' }); app.exit(0); }).catch(fail);
