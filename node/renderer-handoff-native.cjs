/* Native-only synthetic editor. All paths/profile/media are owned by the parent. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { app, BrowserWindow, ipcMain, net, protocol, session } = require('electron');

const repository = fs.realpathSync(path.resolve(__dirname, '..'));
const fixture = process.argv.find(value => value.startsWith('--renderer-handoff-fixture='))?.split('=').slice(1).join('=');
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
protocol.registerSchemesAsPrivileged([{ scheme: 'handoff-fixture', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);

const appDirectory = path.join(fixture, 'app');
let stage = 'fixtures';
let window;
let normalAccepting = true;
let pendingInvoke;
let invokeStarted = false;
let nativeDeliveries = 0;
const snapshots = new Map();
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const checkpoint = checks => send({ type: 'checkpoint', stage, checks });
const evaluate = code => window.webContents.executeJavaScript(code, true);
async function eventually(predicate) {
  for (let index = 0; index < 500; index++) {
    if (await predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('A native renderer handoff boundary did not settle.');
}
const state = () => evaluate('fixture.state()');
const message = value => window.webContents.send('synthetic-handoff-message', value);
async function request() {
  const id = randomUUID();
  normalAccepting = false;
  message({ type: 'request', id });
  await eventually(() => snapshots.has(id));
  return { id, response: snapshots.get(id) };
}
async function release(id, saved) {
  normalAccepting = true;
  message({ type: 'release', id, result: { saved } });
  await eventually(async () => (await state()).lastRelease === id);
}
async function typeInto(id, text) {
  await evaluate(`(() => { const element = document.getElementById(${JSON.stringify(id)}); element.focus(); element.select(); })()`);
  await window.webContents.insertText(text);
}

function productionBundle() {
  const names = [
    'interfaces/saved-normal-document',
    'src/app/common/renderer-mutation-lifetime',
    'src/app/common/renderer-interaction-freeze',
    'src/app/common/renderer-ipc-lifetime',
    'src/app/common/saved-normal-document-coordinator',
  ];
  const modules = names.map(name => {
    const source = fs.readFileSync(path.join(repository, name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText;
    return JSON.stringify(name) + ': function(require, exports) {\n' + compiled + '\n}';
  });
  return `(function() {
    const modules = { ${modules.join(',\n')} };
    const cache = {};
    function load(name) {
      if (cache[name]) return cache[name];
      if (!modules[name]) throw new Error('Unknown synthetic dependency');
      const exports = cache[name] = {};
      const require = target => {
        const parts = name.split('/'); parts.pop();
        for (const part of target.split('/')) {
          if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);
        }
        return load(parts.join('/'));
      };
      modules[name](require, exports); return exports;
    }
    globalThis.production = {
      ...load('src/app/common/renderer-mutation-lifetime'),
      ...load('src/app/common/renderer-interaction-freeze'),
      ...load('src/app/common/renderer-ipc-lifetime'),
      ...load('src/app/common/saved-normal-document-coordinator'),
    };
  })();`;
}

function rendererFixture() {
  // This adapter is intentionally small and synthetic. Home's complete adapter
  // and the Angular document stores have separate runtime integration tests.
  const { RendererMutationLifetime, RendererInteractionFreeze, RendererIpcLifetime, SavedNormalDocumentCoordinator } = production;
  const notes = document.querySelector('#notes');
  const tags = document.querySelector('#tags');
  const overlay = document.querySelector('#overlay-notes');
  const video = document.querySelector('video');
  const model = { version: 3, images: [{ notes: '', tags: [], fileName: 'original.mp4' }] };
  let dirty = false;
  let tagDraft = '';
  let overlayEdits = 0;
  let markedSaved = 0;
  let lastRelease = '';
  let eventsReceived = 0;
  let invokeComplete = false;
  let playEvents = 0;
  document.addEventListener('play', () => { playEvents++; }, true);
  const mutations = new RendererMutationLifetime();
  const interaction = new RendererInteractionFreeze(document);
  const ipc = new RendererIpcLifetime(mutations);
  notes.addEventListener('input', () => {
    mutations.assertAccepting(); model.images[0].notes = notes.value; mutations.changed(); dirty = true;
  });
  tags.addEventListener('input', () => { mutations.assertAccepting(); tagDraft = tags.value; });
  overlay.addEventListener('input', () => { mutations.assertAccepting(); overlayEdits++; });
  mutations.registerDraftFlusher(() => {
    if (tagDraft.includes('>>')) throw new Error('Synthetic invalid tag path');
    const next = tagDraft.split(',').map(value => value.trim()).filter(Boolean);
    if (next.join('\0') !== model.images[0].tags.join('\0')) {
      model.images[0].tags = next; mutations.changed(); dirty = true;
    }
  });
  const coordinator = new SavedNormalDocumentCoordinator({
    sessionIdentity: () => 1,
    revisionIdentity: () => mutations.revision,
    freeze: () => {
      const restoreInteraction = interaction.freeze();
      let resume;
      try { resume = mutations.freeze(); }
      catch (error) { restoreInteraction(); throw error; }
      return () => {
        resume();
        try { ipc.drain(); restoreInteraction(); }
        catch (error) { mutations.quarantine(); throw error; }
      };
    },
    snapshot: () => model,
    markSaved: () => { markedSaved++; dirty = false; },
  }, { sendSnapshot: (id, response) => handoffTest.snapshot(id, response) });
  handoffTest.onMessage(value => {
    if (value.type === 'request') { coordinator.prepare(value.id); }
    else if (value.type === 'release') { coordinator.release(value.id, value.result); lastRelease = value.id; }
    else if (value.type === 'rename') {
      eventsReceived++;
      ipc.deliver(() => {
        mutations.assertAccepting(); model.images[0].fileName = value.fileName;
        mutations.changed(); dirty = true; handoffTest.delivered();
      });
    } else if (value.type === 'failed-result') {
      eventsReceived++;
      ipc.deliver(() => { throw new Error('Synthetic deferred restoration failure'); });
    }
  });
  globalThis.fixture = {
    state: () => ({
      notes: model.images[0].notes, tags: model.images[0].tags, fileName: model.images[0].fileName,
      dirty, revision: mutations.revision, accepting: mutations.accepting, frozen: coordinator.frozen,
      inert: document.body.inert, active: document.activeElement.id, overlayEdits, markedSaved,
      lastRelease, eventsReceived, invokeComplete, pending: mutations.pendingCount,
      paused: video.paused, autoplay: video.autoplay, playEvents,
    }),
    composition: active => notes.dispatchEvent(new CompositionEvent(active ? 'compositionstart' : 'compositionend', { bubbles: true, data: 'synthetic' })),
    probeBlocked: () => {
      const input = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'blocked', inputType: 'insertText' });
      const keyboard = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'x' });
      overlay.dispatchEvent(input); overlay.dispatchEvent(keyboard);
      return { beforeinput: input.defaultPrevented, keyboard: keyboard.defaultPrevented };
    },
    startNative: () => {
      invokeComplete = false;
      return ipc.invoke(() => handoffTest.invoke()).then(value => {
        mutations.assertAccepting(); model.images[0].fileName = value;
        mutations.changed(); dirty = true; invokeComplete = true;
      });
    },
  };
}

async function run() {
  fs.mkdirSync(appDirectory, { recursive: true });
  const clip = path.join(appDirectory, 'clip.mp4');
  const ffmpeg = fs.realpathSync(path.join(repository, 'build', 'media-tools', 'ffmpeg'));
  assert.ok(ffmpeg.startsWith('/Users/sm/Workspace/'));
  const encoded = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=teal:size=64x36:rate=25', '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-threads', '1', '-movflags', '+faststart', clip],
  { cwd: repository, timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(encoded.status, 0, 'Synthetic media encoding failed.');
  const preload = path.join(appDirectory, 'preload.cjs');
  fs.writeFileSync(preload, `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('handoffTest', {
      onMessage: callback => ipcRenderer.on('synthetic-handoff-message', (_event, value) => callback(value)),
      snapshot: (id, value) => ipcRenderer.send('synthetic-handoff-snapshot', id, value),
      invoke: () => ipcRenderer.invoke('synthetic-handoff-invoke'),
      delivered: () => ipcRenderer.send('synthetic-handoff-delivered'),
    });`);
  fs.writeFileSync(path.join(appDirectory, 'index.html'), `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; media-src 'self'; style-src 'unsafe-inline'">
    <title>Synthetic renderer handoff</title><script src="runtime.js" defer></script>
    <main><label>Notes <textarea id="notes"></textarea></label><label>Tags <input id="tags"></label>
      <video autoplay muted loop src="clip.mp4"></video></main>
    <div class="cdk-overlay-container"><label>Overlay <input id="overlay-notes"></label></div>`);
  fs.writeFileSync(path.join(appDirectory, 'runtime.js'), productionBundle() + '\n(' + rendererFixture.toString() + ')();');
  ipcMain.on('synthetic-handoff-snapshot', (event, id, response) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(event.senderFrame, window.webContents.mainFrame);
    assert.match(id, /^[a-f0-9-]{36}$/);
    assert.equal(snapshots.has(id), false, 'A request must have only one snapshot response.');
    snapshots.set(id, response);
  });
  ipcMain.on('synthetic-handoff-delivered', event => {
    assert.equal(event.senderFrame, window.webContents.mainFrame);
    assert.equal(normalAccepting, true, 'Deferred renderer mutation ran before main reopened.');
    nativeDeliveries++;
  });
  ipcMain.handle('synthetic-handoff-invoke', event => {
    assert.equal(event.senderFrame, window.webContents.mainFrame);
    assert.equal(normalAccepting, true);
    invokeStarted = true;
    return new Promise(resolve => { pendingInvoke = resolve; });
  });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  protocol.handle('handoff-fixture', request => {
    const url = new URL(request.url);
    const name = url.pathname.slice(1);
    if (url.host !== 'app' || !['index.html', 'runtime.js', 'clip.mp4'].includes(name)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(path.join(appDirectory, name)).toString());
  });
  window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
    preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
  } });
  await window.loadURL('handoff-fixture://app/index.html');
  await eventually(() => evaluate('Boolean(globalThis.fixture)'));

  stage = 'editor-drafts';
  await typeInto('notes', 'Native notes before save');
  await typeInto('tags', 'Animals > Birds, Reviewed');
  assert.equal((await state()).notes, 'Native notes before save');
  await evaluate(`(async () => { const video = document.querySelector('video'); await video.play(); })()`);
  await eventually(() => evaluate("document.querySelector('video').currentTime > 0"));
  const first = await request();
  assert.equal(first.response.status, 'snapshot');
  assert.equal(first.response.document.images[0].notes, 'Native notes before save');
  assert.deepEqual(first.response.document.images[0].tags, ['Animals > Birds', 'Reviewed']);
  assert.equal((await state()).accepting, false);
  await checkpoint({ nativeTextInsertion: true, notesCaptured: true, tagDraftCommitted: true, frozen: true });

  stage = 'frozen-input-media';
  const frozen = await state();
  assert.equal(frozen.inert, true); assert.equal(frozen.paused, true); assert.equal(frozen.autoplay, false);
  assert.deepEqual(await evaluate('fixture.probeBlocked()'), { beforeinput: true, keyboard: true });
  await evaluate("document.querySelector('#overlay-notes').focus()");
  assert.notEqual((await state()).active, 'overlay-notes');
  await window.webContents.insertText('must not edit overlay');
  assert.equal((await state()).overlayEdits, 0);
  await evaluate("document.querySelector('video').play().catch(() => undefined)");
  await eventually(async () => (await state()).paused);
  const playback = await state();
  assert.ok(playback.playEvents > frozen.playEvents, 'A real native play event must have reached the freeze guard.');
  await release(first.id, true);
  const restored = await state();
  assert.equal(restored.accepting, true); assert.equal(restored.inert, false);
  assert.equal(restored.autoplay, true); assert.equal(restored.active, 'tags');
  assert.equal(restored.markedSaved, 1); assert.equal(restored.dirty, false);
  await checkpoint({ bodyAndOutsideOverlayInert: true, beforeinputBlocked: true, keyboardBlocked: true,
    mediaPaused: true, autoplaySuppressed: true, latePlaybackStopped: true, focusRestored: true });

  stage = 'deferred-native-result';
  const second = await request();
  message({ type: 'rename', fileName: 'deferred-renamed.mp4' });
  await eventually(async () => (await state()).eventsReceived === 1);
  assert.equal((await state()).fileName, 'original.mp4');
  const wrong = randomUUID(); message({ type: 'release', id: wrong, result: { saved: true } });
  await eventually(async () => (await state()).lastRelease === wrong);
  assert.equal((await state()).accepting, false);
  assert.equal(nativeDeliveries, 0);
  await release(second.id, true);
  await eventually(() => nativeDeliveries === 1);
  const deferredState = await state();
  assert.equal(deferredState.fileName, 'deferred-renamed.mp4');
  assert.equal(deferredState.dirty, true); assert.equal(deferredState.markedSaved, 1);
  await checkpoint({ actualNativeIpc: true, resultHeldUntilExactRelease: true, lateResultRemainsDirty: true, deliveredAfterMainResumed: true });

  stage = 'composition-draft-refusal';
  await evaluate('fixture.composition(true)');
  const composing = await request();
  assert.equal(composing.response.status, 'cancelled');
  assert.equal((await state()).inert, false); assert.equal((await state()).accepting, true);
  await evaluate('fixture.composition(false)');
  await release(composing.id, false);
  await typeInto('tags', 'Animals >> Invalid');
  const invalid = await request();
  assert.equal(invalid.response.status, 'cancelled');
  assert.equal((await state()).inert, false); assert.equal((await state()).accepting, true);
  assert.equal(await evaluate("document.querySelector('#tags').value"), 'Animals >> Invalid');
  await release(invalid.id, false);
  await typeInto('tags', 'Animals > Birds, Reviewed');
  await checkpoint({ compositionEventRefused: true, invalidDraftRetained: true, partialFreezeRolledBack: true });

  stage = 'pending-native-request';
  await evaluate('void fixture.startNative(); true');
  await eventually(() => invokeStarted);
  assert.equal((await state()).pending, 1);
  const pending = await request();
  assert.equal(pending.response.status, 'cancelled');
  assert.equal((await state()).inert, false);
  pendingInvoke('native-invoke-renamed.mp4');
  await eventually(async () => (await state()).invokeComplete && (await state()).pending === 0);
  assert.equal((await state()).fileName, 'native-invoke-renamed.mp4');
  await release(pending.id, false);
  const afterPending = await request();
  assert.equal(afterPending.response.document.images[0].fileName, 'native-invoke-renamed.mp4');
  await release(afterPending.id, true);
  assert.equal((await state()).dirty, false);
  await checkpoint({ pendingInvokeRefusesFreeze: true, durableResultPreserved: true, nextSnapshotIncludesResult: true });

  stage = 'repeat-failure-quarantine';
  const final = await request();
  message({ type: 'failed-result' });
  await eventually(async () => (await state()).eventsReceived === 2);
  await release(final.id, true);
  const failed = await state();
  assert.equal(failed.accepting, false); assert.equal(failed.frozen, true); assert.equal(failed.inert, true);
  const ignoredId = randomUUID(); message({ type: 'request', id: ignoredId });
  await evaluate('new Promise(resolve => setTimeout(resolve, 30))');
  assert.equal(snapshots.has(ignoredId), false);
  await window.webContents.insertText('blocked after failure');
  assert.equal((await state()).notes, 'Native notes before save');
  await checkpoint({ multipleCycles: true, failedDrainQuarantined: true, editingStillInert: true, laterRequestRefused: true });
  window.destroy(); window = undefined;
  protocol.unhandle('handoff-fixture');
  await send({ type: 'complete' });
  app.quit();
}

void run().catch(async error => {
  fs.writeFileSync(path.join(fixture, 'failure.txt'), stage + '\n' + String(error?.stack || error));
  try { await send({ type: 'failed', stage }); } catch { /* Parent also detects incomplete exit. */ }
  if (window && !window.isDestroyed()) { window.destroy(); }
  app.exit(1);
});
