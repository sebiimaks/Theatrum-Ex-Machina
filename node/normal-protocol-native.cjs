/* Native-only synthetic fixture. The parent harness owns all paths and IPC. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, net, protocol, session } = require('electron');

const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const fixture = process.argv.find(value => value.startsWith('--normal-protocol-fixture='))?.split('=').slice(1).join('=');
assert.ok(repository.startsWith('/Users/sm/Workspace/'));
assert.ok(fixture && path.isAbsolute(fixture) && path.dirname(fixture) === path.join(repository, 'tmp'));
assert.equal(fs.realpathSync(fixture), fixture);
const profile = path.join(fixture, 'profile');
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
const { createTheatrumProtocolHandler } = require('./theatrum-protocol.ts');
const { GLOBALS } = require('./main-globals.ts');
const { normalOperationScope: scope } = require('./normal-operation-scope.ts');
const { getMediaToolPath } = require('./media-tool-paths.ts');
const appDirectory = path.join(fixture, 'app');
const output = path.join(fixture, 'hub');
const assets = path.join(output, 'vha-Synthetic');
const jpegPath = path.join(assets, 'thumbnails', 'native.jpg');
const clipPath = path.join(assets, 'clips', 'native.mp4');
const largePath = path.join(assets, 'clips', 'large.mp4');
const jpegUrl = 'theatrum://app/media/thumbnails/native.jpg';
const clipUrl = 'theatrum://app/media/clips/native.mp4';
const largeUrl = 'theatrum://app/media/clips/large.mp4';
let stage = 'fixtures';
let window;
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const checkpoint = checks => send({ type: 'checkpoint', stage, checks });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function eventually(predicate) {
  for (let index = 0; index < 500; index++) {
    if (predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('A native fixture boundary did not settle.');
}
const evaluate = code => window.webContents.executeJavaScript(code, true);
const request = (url, options) => new Request(url, options);
const bytes = async response => Buffer.from(await response.arrayBuffer());

async function run() {
  for (const directory of [appDirectory, path.dirname(jpegPath), path.dirname(clipPath)]) { fs.mkdirSync(directory, { recursive: true }); }
  fs.writeFileSync(path.join(appDirectory, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Ordinary protocol fixture</title><script src="app.js" defer></script><main>Synthetic fixture</main>');
  fs.writeFileSync(path.join(appDirectory, 'app.js'), 'globalThis.fixtureReady = true;');
  const ffmpeg = fs.realpathSync(getMediaToolPath('ffmpeg'));
  assert.ok(ffmpeg.startsWith('/Users/sm/Workspace/'));
  for (const args of [
    ['-f', 'lavfi', '-i', 'color=c=teal:size=64x36', '-frames:v', '1', '-threads', '1', jpegPath],
    ['-f', 'lavfi', '-i', 'color=c=teal:size=64x36:rate=25', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', clipPath],
  ]) {
    const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args],
      { cwd: repository, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(encoded.status, 0, 'Synthetic media encoding failed.');
  }
  fs.closeSync(fs.openSync(largePath, 'wx'));
  fs.truncateSync(largePath, 64 * 1024 * 1024);
  const jpeg = fs.readFileSync(jpegPath);
  const clip = fs.readFileSync(clipPath);
  GLOBALS.selectedOutputFolder = output;
  GLOBALS.hubName = 'Synthetic';
  GLOBALS.authorizedCatalogueImageHashes = new Set(['native', 'large']);
  const handle = createTheatrumProtocolHandler(appDirectory);
  await app.whenReady();
  protocol.handle('theatrum', handle);

  stage = 'native-responses';
  const baseline = await net.fetch(pathToFileURL(jpegPath).toString());
  const nativeHeaders = Object.fromEntries(baseline.headers.entries());
  assert.deepEqual(await bytes(baseline), jpeg);
  const image = await handle(request(jpegUrl));
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /^image\/jpeg/);
  assert.deepEqual(Object.fromEntries(image.headers.entries()), nativeHeaders);
  assert.deepEqual(await bytes(image), jpeg);
  const head = await handle(request(jpegUrl, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.deepEqual(Object.fromEntries(head.headers.entries()), nativeHeaders);
  assert.equal((await bytes(head)).length, 0);
  const baselineRange = await net.fetch(pathToFileURL(clipPath).toString(), { headers: new Headers({ Range: 'bytes=0-63' }) });
  const nativeRange = { status: baselineRange.status, headers: Object.fromEntries(baselineRange.headers.entries()), bytes: await bytes(baselineRange) };
  const range = await handle(request(clipUrl, { headers: { Range: 'bytes=0-63' } }));
  assert.equal(range.status, nativeRange.status);
  assert.deepEqual(Object.fromEntries(range.headers.entries()), nativeRange.headers);
  assert.deepEqual(await bytes(range), nativeRange.bytes);
  assert.deepEqual(nativeRange.bytes, clip.subarray(0, 64));
  const baselineSuffix = await net.fetch(pathToFileURL(clipPath).toString(), { headers: new Headers({ Range: 'bytes=-32' }) });
  const nativeSuffix = { status: baselineSuffix.status, headers: Object.fromEntries(baselineSuffix.headers.entries()), bytes: await bytes(baselineSuffix) };
  const suffix = await handle(request(clipUrl, { headers: { Range: 'bytes=-32' } }));
  assert.equal(suffix.status, nativeSuffix.status);
  assert.deepEqual(Object.fromEntries(suffix.headers.entries()), nativeSuffix.headers);
  assert.deepEqual(await bytes(suffix), nativeSuffix.bytes);
  assert.deepEqual(nativeSuffix.bytes, clip.subarray(-32));
  assert.equal((await handle(request(jpegUrl, { method: 'POST' }))).status, 405);
  await eventually(() => scope.pendingCount === 0);
  await checkpoint({ get: true, head: true, nativeHeadersPreserved: true, rangeRequestStatus: nativeRange.status,
    rangeRequestBytes: nativeRange.bytes.length, suffixRequestStatus: nativeSuffix.status, exactBytes: true, pending: 0 });

  stage = 'renderer-media';
  window = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
  } });
  assert.equal(window.webContents.session, session.defaultSession);
  await window.loadURL('theatrum://app/index.html');
  assert.equal(await evaluate('globalThis.fixtureReady'), true);
  const rendered = await evaluate(`(async () => {
    const fetched = await (await fetch(${JSON.stringify(jpegUrl)} + '?native-get')).arrayBuffer();
    const head = await (await fetch(${JSON.stringify(jpegUrl)} + '?native-head', { method: 'HEAD' })).arrayBuffer();
    const range = await (await fetch(${JSON.stringify(clipUrl)} + '?native-range', { headers: { Range: 'bytes=0-63' } })).arrayBuffer();
    if (fetched.byteLength !== ${jpeg.length} || head.byteLength !== 0
      || Array.from(new Uint8Array(range)).join(',') !== ${JSON.stringify(Array.from(clip.subarray(0, 64)).join(','))}) {
      throw new Error('Native renderer response bytes changed.');
    }
    const image = new Image(); image.src = ${JSON.stringify(jpegUrl)};
    await image.decode();
    const video = document.createElement('video'); video.muted = true; video.src = ${JSON.stringify(clipUrl)};
    document.body.append(video);
    await Promise.race([new Promise((resolve, reject) => {
      video.addEventListener('timeupdate', () => { if (video.currentTime > 0) resolve(); });
      video.addEventListener('error', () => reject(new Error('Synthetic video failed.')));
      video.play().catch(reject);
    }), new Promise((_, reject) => setTimeout(() => reject(new Error('Synthetic playback timed out.')), 8000))]);
    const result = { image: [image.naturalWidth, image.naturalHeight], video: [video.videoWidth, video.videoHeight],
      played: video.currentTime > 0, getBytes: fetched.byteLength, headBytes: head.byteLength, rangeBytes: range.byteLength };
    video.pause(); video.removeAttribute('src'); video.load(); video.remove();
    return result;
  })()`);
  assert.deepEqual(rendered, { image: [64, 36], video: [64, 36], played: true, getBytes: jpeg.length, headBytes: 0, rangeBytes: 64 });
  await eventually(() => scope.pendingCount === 0);
  await checkpoint(rendered);

  stage = 'unread-drain';
  const unread = await handle(request(largeUrl));
  assert.equal(unread.status, 200);
  assert.equal(scope.pendingCount, 1);
  const unreadDrain = scope.seal();
  assert.equal(scope.accepting, false);
  await assert.rejects(unread.arrayBuffer());
  let proof = await unreadDrain;
  scope.assertDrained(proof);
  assert.equal(scope.pendingCount, 0);
  assert.equal((await handle(request(jpegUrl))).status, 404);
  assert.equal(await (await handle(request('theatrum://app/app.js'))).text(), 'globalThis.fixtureReady = true;');
  scope.resume(proof);
  await checkpoint({ unreadRejected: true, drained: true, mediaDenied: true, staticAvailable: true });

  stage = 'active-read-drain';
  const active = await handle(request(largeUrl));
  const reader = active.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value.byteLength > 0);
  const lateRead = reader.read();
  const readDrain = scope.seal();
  await assert.rejects(lateRead);
  proof = await readDrain;
  scope.assertDrained(proof);
  reader.releaseLock();
  assert.equal(scope.pendingCount, 0);
  scope.resume(proof);
  await checkpoint({ readBytes: first.value.byteLength, lateReadRejected: true, drained: true });

  stage = 'late-fetch-drain';
  // Delay delivery of real native headers to the production handler. This
  // deterministic scheduling gate substitutes no response, stream, or bytes.
  const nativeFetch = net.fetch;
  const headersReady = deferred();
  const releaseHeaders = deferred();
  net.fetch = async (...args) => {
    const response = await nativeFetch.apply(net, args);
    headersReady.resolve();
    await releaseHeaders.promise;
    return response;
  };
  try {
    const pending = handle(request(largeUrl));
    await headersReady.promise;
    let drained = false;
    const fetchDrain = scope.seal().then(value => { drained = true; return value; });
    await Promise.resolve();
    assert.equal(drained, false);
    assert.equal(scope.pendingCount, 1);
    releaseHeaders.resolve();
    assert.equal((await pending).status, 404);
    proof = await fetchDrain;
    scope.assertDrained(proof);
    assert.equal(scope.pendingCount, 0);
    scope.resume(proof);
  } finally { releaseHeaders.resolve(); net.fetch = nativeFetch; }
  await checkpoint({ realNativeFetch: true, lateHeadersDenied: true, waitedForFetch: true, drained: true });

  stage = 'renderer-drain';
  await evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(largeUrl)} + '?renderer-drain');
    if (response.status !== 200) throw new Error('Synthetic stream denied.');
    globalThis.nativeReader = response.body.getReader();
    const first = await globalThis.nativeReader.read();
    if (first.done || !first.value.byteLength) throw new Error('Synthetic stream empty.');
  })()`);
  assert.ok(scope.pendingCount > 0, 'Native protocol must still own the paused renderer stream.');
  proof = await scope.seal();
  scope.assertDrained(proof);
  const rejected = await evaluate(`(async () => {
    try { for (;;) { const value = await globalThis.nativeReader.read(); if (value.done) return false; } }
    catch { return true; }
    finally { globalThis.nativeReader.releaseLock(); delete globalThis.nativeReader; }
  })()`);
  assert.equal(rejected, true);
  assert.equal(await evaluate(`(async () => (await fetch(${JSON.stringify(jpegUrl)} + '?sealed')).status)()`), 404);
  assert.equal(await evaluate("(async () => (await fetch('theatrum://app/app.js?sealed')).text())()"), 'globalThis.fixtureReady = true;');
  assert.equal(scope.pendingCount, 0);
  scope.resume(proof);
  await checkpoint({ rendererStreamRejected: true, drained: true, mediaDenied: true, staticAvailable: true });

  stage = 'fresh-reopen';
  const fresh = await handle(request(jpegUrl));
  assert.deepEqual(await bytes(fresh), jpeg);
  const freshSize = await evaluate(`(async () => (await (await fetch(${JSON.stringify(jpegUrl)} + '?reopened')).arrayBuffer()).byteLength)()`);
  assert.equal(freshSize, jpeg.length);
  await eventually(() => scope.pendingCount === 0);
  await checkpoint({ exactBytes: true, rendererBytes: freshSize, freshEpoch: true, pending: 0 });
  window.destroy();
  window = undefined;
  protocol.unhandle('theatrum');
  await send({ type: 'complete' });
  app.quit();
}

void run().catch(async error => {
  // Retain only a synthetic assertion stage and stack inside this disposable
  // fixture. Native diagnostics and application/user data are not included.
  fs.writeFileSync(path.join(fixture, 'failure.txt'), stage + '\n' + String(error?.stack || error));
  try { await send({ type: 'failed', stage }); } catch { /* Parent also detects incomplete exit. */ }
  if (window && !window.isDestroyed()) { window.destroy(); }
  app.exit(1);
});
