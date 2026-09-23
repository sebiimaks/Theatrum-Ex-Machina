/* Isolated launcher for exact packaged modules; never included in shipping files. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, nativeImage, protocol, session } = require('electron');
const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const fixture = process.argv.find(value => value.startsWith('--private-package-fixture='))?.slice('--private-package-fixture='.length);
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.dirname(fixture) === path.join(repository, 'tmp') && fs.realpathSync(fixture) === fixture);
const resources = path.join(fixture, 'Private package fixture.app', 'Contents', 'Resources');
const archive = path.join(resources, 'payload.asar');
assert.equal(app.isPackaged, true); assert.equal(process.resourcesPath, resources);
for (const [key, name] of [['appData', 'app-data'], ['userData', 'user-data'], ['sessionData', 'session-data'],
  ['temp', 'temporary'], ['crashDumps', 'crash-dumps'], ['logs', 'logs'], ['downloads', 'downloads']]) {
  const directory = path.join(fixture, 'profile', name); fs.mkdirSync(directory, { recursive: true }); app.setPath(key, directory);
}
app.on('window-all-closed', () => undefined);
let recentWrites = 0;
app.addRecentDocument = () => { recentWrites++; };
app.clearRecentDocuments = () => { throw new Error('Unexpected OS history mutation.'); };
app.requestSingleInstanceLock = () => { throw new Error('Unexpected singleton registration.'); };
protocol.registerSchemesAsPrivileged([{ scheme: 'theatrum', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
// All production imports resolve inside the exact ASAR, not repository TS or JS.
const production = file => require(path.join(archive, file));
const { getPrivateHelperPath } = production('node/private-helper-paths.js');
const { getPrivateUiPath } = production('node/private-ui-paths.js');
const { createPrivateTouchIdProvider } = production('node/private-touch-id.js');
const { PrivateHubStore } = production('node/private-hub-store.js');
const { PrivateHubSession } = production('node/private-hub-session.js');
const { PrivateHubBrowser } = production('node/private-hub-browser.js');
const { createPrivateUnlockProtocolHandler, createPrivateConversionProtocolHandler, createPrivateBrowserProtocolHandler } = production('node/private-browser-protocol.js');
const { writePrivateHubCatalogue, writePrivateHubPreview } = production('node/private-hub-catalogue.js');
const { NewImageElement } = production('interfaces/final-object.interface.js');
let configuration;
let stage = 'configuration';
let defaultRequests = 0;
let ordinaryMenu;
let hub;
const waiting = new Map();
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
  const line = [...(error?.stack ?? '').matchAll(/private-package-native\.cjs:(\d+):/g)][0]?.[1];
  try { await send({ type: 'failure', stage, line: line ? Number(line) : undefined }); } catch { /* Parent may have stopped. */ }
  app.exit(1);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = (window, code) => window.webContents.executeJavaScript(code, true);
async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) { if (await predicate()) { return; } await delay(10); }
  assert.fail('Packaged fixture did not reach the required state.');
}
async function waitDom(window, code) {
  await until(async () => { try { return await evaluate(window, code); } catch { return false; } });
}
async function privateWindow(surface) {
  let found;
  await until(async () => {
    for (const window of BrowserWindow.getAllWindows()) {
      try { if (!window.isDestroyed() && await evaluate(window, `typeof globalThis.${surface} === 'object'`)) { found = window; return true; } }
      catch { /* Initial navigation may still be pending. */ }
    }
    return false;
  });
  return found;
}
async function isolated(window, surface) {
  const partition = window.webContents.session;
  assert.notEqual(partition, session.defaultSession); assert.equal(partition.isPersistent(), false); assert.equal(partition.storagePath, null);
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true);
  assert.deepEqual(await evaluate(window, `({ bridge: typeof globalThis.${surface}, ordinary: typeof globalThis.theatrum, node: typeof require, process: typeof process })`),
    { bridge: 'object', ordinary: 'undefined', node: 'undefined', process: 'undefined' });
  const expectedPreload = {
    privateUnlock: 'private-password-preload.cjs', privateConversion: 'private-conversion-preload.cjs', privateGallery: 'private-gallery-preload.cjs',
  }[surface];
  // Electron omits the preload option from getLastWebPreferences(). Verify the
  // production resolver and physical file; the narrow bridge above proves load.
  const preload = getPrivateUiPath(expectedPreload);
  assert.equal(preload, path.join(archive + '.unpacked', expectedPreload));
  const stat = fs.lstatSync(preload);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(fs.realpathSync.native(preload), preload);
  return partition;
}
async function seed() {
  const directory = path.join(fixture, 'encrypted-hub');
  const store = await PrivateHubStore.create(directory, configuration.password);
  try {
    await writePrivateHubCatalogue(store, { version: 3, hubName: 'Synthetic packaged hub', addTags: [], removeTags: [], numOfFolders: 1,
      inputDirs: { 0: { path: path.join(fixture, 'synthetic-source'), watch: false } },
      screenshotSettings: { clipHeight: 144, clipSnippetLength: 1, clipSnippets: 0, fixed: true, height: 144, n: 1 },
      images: [{ ...NewImageElement(), hash: 'packaged-video', fileName: 'synthetic.mp4', cleanName: 'Synthetic private video',
        duration: 6, screens: 1, width: 64, height: 36, notes: configuration.marker, tags: ['Synthetic tag'] }] });
    const pixels = Buffer.alloc(64 * 36 * 4, 96);
    const encoded = nativeImage.createFromBitmap(pixels, { width: 64, height: 36 }).toJPEG(80);
    pixels.fill(0); assert.equal(encoded.readUInt16BE(0), 0xffd8);
    const comment = Buffer.from(configuration.marker);
    const header = Buffer.alloc(4); header.writeUInt16BE(0xfffe, 0); header.writeUInt16BE(comment.length + 2, 2);
    const image = Buffer.concat([encoded.subarray(0, 2), header, comment, encoded.subarray(2)]);
    try { await writePrivateHubPreview(store, 'thumbnail', 'packaged-video', image); }
    finally { image.fill(0); comment.fill(0); encoded.fill(0); }
    // Pre-existing synthetic hub, not a claim to exercise conversion activation.
    const activation = Buffer.from(JSON.stringify({ format: 'theatrum-private-hub-activation', version: 1, hubId: store.hubId }));
    try { await store.writeNewRecord('session:activation', activation); } finally { activation.fill(0); }
  } finally { await store.lock(); }
  return directory;
}
async function probeStatics(directory, generation) {
  const cases = [
    [createPrivateUnlockProtocolHandler({ appDirectory: path.join(archive, 'private-unlock'), isCurrent: () => true }), ['index.html', 'unlock.js', 'unlock.css']],
    [createPrivateConversionProtocolHandler({ appDirectory: path.join(archive, 'private-conversion'), isCurrent: () => true }), ['index.html', 'conversion.js', 'conversion.css']],
    [createPrivateBrowserProtocolHandler({ appDirectory: directory, hub, generation, isCurrent: () => true }), ['index.html', 'gallery.js', 'gallery.css']],
  ];
  for (const [handler, assets] of cases) {
    for (const file of assets) {
      const response = await handler(new Request('theatrum://app/' + file));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
      const bytes = Buffer.from(await response.arrayBuffer());
      try { assert.ok(bytes.length > 0); } finally { bytes.fill(0); }
      const head = await handler(new Request('theatrum://app/' + file, { method: 'HEAD' }));
      assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    assert.equal((await handler(new Request('theatrum://app/../package.json'))).status, 404);
    assert.equal((await handler(new Request('https://example.invalid/index.html'))).status, 404);
  }
}
async function credentialWindows() {
  const controller = new AbortController();
  const opening = PrivateHubBrowser.requestPassword({ signal: controller.signal, isCurrent: () => !controller.signal.aborted, visible: false,
    lifecycle: 'external' });
  opening.catch(() => undefined);
  const prompt = await privateWindow('privateUnlock');
  const firstSession = await isolated(prompt, 'privateUnlock');
  await waitDom(prompt, '!!document.getElementById("password")');
  // Cancellation destroys the renderer before executeJavaScript can reply.
  // The host promise below is the authoritative completion signal.
  void evaluate(prompt, 'globalThis.privateUnlock.cancel()').catch(() => undefined);
  assert.equal(await opening, undefined); assert.equal(prompt.isDestroyed(), true);
  assert.equal(await firstSession.getCacheSize(), 0); assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
  const conversionController = new AbortController();
  const converting = PrivateHubBrowser.requestConversion({ signal: conversionController.signal, isCurrent: () => !conversionController.signal.aborted,
    visible: false, lifecycle: 'external', review: { videos: 1, availablePreviews: 1, previewBytes: 100,
      missingPreviews: { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 } },
    onRetire: () => conversionController.abort(), start: async () => { assert.fail('Cancellation must not convert.'); } });
  converting.catch(() => undefined);
  const form = await privateWindow('privateConversion');
  const secondSession = await isolated(form, 'privateConversion'); assert.notEqual(secondSession, firstSession);
  await waitDom(form, '!document.getElementById("review").hidden');
  void evaluate(form, 'globalThis.privateConversion.cancel()').catch(() => undefined);
  assert.equal(await converting, undefined); assert.equal(form.isDestroyed(), true);
  assert.equal(await secondSession.getCacheSize(), 0); assert.equal(Menu.getApplicationMenu(), ordinaryMenu);
}
async function run() {
  if (!configuration) { await new Promise(resolve => waiting.set('configuration', resolve)); }
  assert.ok(typeof configuration.marker === 'string' && typeof configuration.password === 'string');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => { defaultRequests++; callback({ cancel: true }); });
  ordinaryMenu = Menu.buildFromTemplate([{ label: 'Synthetic ordinary app', submenu: [{ label: 'Ordinary action', click: () => undefined }] }]);
  Menu.setApplicationMenu(ordinaryMenu);
  setStage('packaged-material');
  assert.equal(getPrivateHelperPath('private-hub-lock'), path.join(resources, 'privacy-tools', 'private-hub-lock'));
  assert.equal(getPrivateHelperPath('private-touch-id.node'), path.join(resources, 'privacy-tools', 'private-touch-id.node'));
  const binding = require(getPrivateHelperPath('private-touch-id.node'));
  for (const key of ['begin', 'cancel', 'finishEnrollment']) { assert.equal(typeof binding[key], 'function'); }
  // Availability only: no Keychain lookup/enrollment/deletion and no biometric prompt.
  assert.ok(['available', 'unavailable'].includes(await createPrivateTouchIdProvider().availability()));
  const directory = await seed();
  hub = new PrivateHubSession();
  const opened = await hub.unlock(directory, configuration.password);
  assert.equal(opened.catalogue.images[0].notes, configuration.marker);
  await checkpoint('packaged-material', { packagedRuntime: true, compiledModules: true, fixedHelperPaths: true, nativeAddonLoaded: true, nativeLeaseUsed: true });
  setStage('static-protocols');
  const galleryDirectory = path.join(archive, 'private-gallery');
  await probeStatics(galleryDirectory, opened.generation);
  await checkpoint('static-protocols', { unlockAssets: true, conversionAssets: true, galleryAssets: true, noStore: true, routesRestricted: true });
  setStage('credential-windows');
  await credentialWindows();
  await checkpoint('credential-windows', { unlockLoaded: true, conversionLoaded: true, isolated: true, cancelDrained: true, menuRestored: true });
  setStage('private-gallery');
  const capsule = await PrivateHubBrowser.create({ hub, generation: opened.generation, appDirectory: galleryDirectory });
  const gallery = await privateWindow('privateGallery');
  const partition = await isolated(gallery, 'privateGallery');
  await waitDom(gallery, 'document.querySelector("#gallery-grid .video-card img")?.naturalWidth === 64');
  await evaluate(gallery, 'document.querySelector("#gallery-grid .video-card").click()');
  await waitDom(gallery, `document.getElementById('details-notes')?.value === ${JSON.stringify(configuration.marker)}`);
  assert.equal(await partition.getCacheSize(), 0);
  await checkpoint('private-gallery', { galleryLoaded: true, previewDecoded: true, metadataVisible: true, isolated: true, noDiskCache: true });
  setStage('private-closed');
  await capsule.close(); await hub.close();
  assert.equal(gallery.isDestroyed(), true); assert.equal(hub.status.state, 'idle');
  assert.equal(Menu.getApplicationMenu(), ordinaryMenu); assert.equal(defaultRequests, 0); assert.equal(recentWrites, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  await checkpoint('private-closed', { galleryDestroyed: true, storeLocked: true, menuRestored: true, noDefaultRequests: true, noRecentWrites: true });
  await send({ type: 'complete' }); app.exit(0);
}
void run().catch(fail);
