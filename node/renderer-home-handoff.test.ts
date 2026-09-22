import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { NewImageElement } from '../interfaces/final-object.interface';
import type { FinalObject, ImageElement } from '../interfaces/final-object.interface';
import { SAVED_NORMAL_DOCUMENT_CHANNELS as channels } from '../interfaces/saved-normal-document';
import { RendererMutationLifetime } from '../src/app/common/renderer-mutation-lifetime';
import { FolderThumbnailRegenerationSession } from '../src/app/common/folder-thumbnail-regeneration-session';

const requestId = 'fb7f683a-e03c-4e49-9ea4-e3e84cbf3f0d';
const otherId = '8fe8b68d-7bf4-42cc-a1cb-d3f0b620c9fa';
const compiledModules = new Map<string, string>();

class FakeDocument {
  body = { inert: false };
  querySelectorAll(): unknown[] { return []; }
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  blurCommit = (): void => undefined;
  focused = 0;
  activeElement = {
    isConnected: true,
    blur: () => { this.blurCommit(); },
    focus: () => { this.focused++; },
  };
  addEventListener(name: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(name)) { this.listeners.set(name, new Set()); }
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.get(name)?.delete(listener);
  }
  emit(name: string): { prevented: boolean; stopped: boolean } {
    const result = { prevented: false, stopped: false };
    const event = {
      preventDefault: () => { result.prevented = true; },
      stopImmediatePropagation: () => { result.stopped = true; },
    };
    this.listeners.get(name)?.forEach(listener => listener(event));
    return result;
  }
}

function loadClass(relativePath: string, name: string, globals: Record<string, unknown> = {}): any {
  const fileName = path.join(__dirname, '..', relativePath);
  const nativeRequire = createRequire(fileName);
  const exports: Record<string, unknown> = {};
  const decorator = () => () => undefined;
  const angular = {
    Component: decorator, Injectable: decorator, HostListener: decorator,
    Input: decorator, Output: decorator, ViewChild: decorator, ViewChildren: decorator,
    input: (value?: unknown) => () => value, viewChild: () => () => undefined,
    EventEmitter: class { emit(): void {} },
  };
  let compiled = compiledModules.get(fileName);
  if (!compiled) {
    compiled = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      compilerOptions: {
        experimentalDecorators: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    compiledModules.set(fileName, compiled);
  }
  runInNewContext(compiled, {
    exports, setTimeout, clearTimeout, HTMLElement: class {}, ...globals,
    require: (request: string) => {
      if (request === '@angular/core') { return angular; }
      // Execute the real persistence projection and pause/IPC/DOM coordinators.
      // Unused Home dependencies stay inert so no application startup runs here.
      if (request.includes('/interfaces/') || request.includes('/common/renderer-')
        || request.endsWith('/common/saved-normal-document-coordinator')
        || request.endsWith('/common/catalogue-session-document')
        || request.endsWith('/catalogue-editor.logic') || request === 'rxjs' || request === 'path') {
        return nativeRequire(request);
      }
      return {};
    },
  }, { filename: fileName });
  return exports[name];
}

function harness(options: { readOnly?: boolean; noHub?: boolean } = {}) {
  const document = new FakeDocument();
  const mutations = new RendererMutationLifetime();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const sent: unknown[][] = [];
  let invokeNative: (...args: unknown[]) => Promise<unknown> = async () => ({ applied: true });
  const bridge = {
    isElectron: true, platform: 'darwin',
    ipc: {
      on: (channel: string, callback: (...args: unknown[]) => void) => {
        if (!listeners.has(channel)) { listeners.set(channel, new Set()); }
        listeners.get(channel)!.add(callback);
        return () => listeners.get(channel)?.delete(callback);
      },
      send: (...args: unknown[]) => { sent.push(structuredClone(args)); },
      invoke: (...args: unknown[]) => invokeNative(...args),
    },
  };
  const emit = (channel: string, ...args: unknown[]): void => {
    listeners.get(channel)?.forEach(listener => listener(...args));
  };
  const Electron = loadClass('src/app/providers/electron.service.ts', 'ElectronService', { theatrum: bridge });
  const ImageService = loadClass('src/app/services/image-element.service.ts', 'ImageElementService');
  const AutoTags = loadClass('src/app/components/tags-auto/tags-save.service.ts', 'AutoTagsSaveService');
  const ManualTags = loadClass('src/app/components/tags-manual/manual-tags.service.ts', 'ManualTagsService');
  const DocumentService = loadClass('src/app/services/catalogue-session-document.service.ts', 'CatalogueSessionDocumentService');
  const SourceFolders = loadClass('src/app/components/statistics/source-folder.service.ts', 'SourceFolderService');
  const Home = loadClass('src/app/components/home.component.ts', 'HomeComponent', { document });
  const Editor = loadClass('src/app/components/catalogue-editor/catalogue-editor.component.ts', 'CatalogueEditorComponent');
  const electron = new Electron(mutations);
  const images = new ImageService(mutations);
  const autoTags = new AutoTags(mutations);
  const manualTags = new ManualTags(mutations);
  const first: ImageElement = {
    ...NewImageElement(), index: 0, hash: 'first-video', cleanName: 'First video',
    fileName: 'first.mp4', inputSource: 0, notes: 'Original notes', tags: ['Animals > Birds'],
    locations: [{ inputSource: 0, fileName: 'first.mp4', partialPath: '' }],
  };
  images.imageElements = [first];
  manualTags.replaceTagDefinitions(['Animals', 'Animals > Birds'], false);
  manualTags.replaceTagColors({ Animals: '#abcdef' }, false);
  autoTags.restoreSavedTags(['automatic-added'], ['automatic-removed']);
  images.finalArrayNeedsSaving = false;
  const sourceFolders = new SourceFolders();
  sourceFolders.selectedSourceFolder = { 0: { path: '/synthetic/media', watch: false } };
  const projection = new DocumentService(autoTags, images, manualTags, sourceFolders);
  let dialogsClosed = 0;
  let failClose = false;
  const modal = { dialog: {
    openDialogs: [],
    closeAll: () => { dialogsClosed++; if (failClose) { throw new Error('Synthetic close failure'); } },
  } };
  const home = Object.create(Home.prototype);
  Object.assign(home, {
    mutations, imageElementService: images, autoTagsSaveService: autoTags, manualTagsService: manualTags,
    sourceFolderService: sourceFolders, catalogueSessionDocument: projection, electronService: electron,
    catalogueSessionGeneration: 1, catalogueAccessMode: options.readOnly ? 'read-only' : 'read-write',
    appState: { currentVhaFile: options.noHub ? '' : '/synthetic/catalogue.scaena', hubName: 'Test catalogue', numOfFolders: 1 },
    currentScreenshotSettings: { fixed: true, n: 3, height: 288, clipHeight: 144, clipSnippets: 0, clipSnippetLength: 1 },
    modalService: modal, cd: { detectChanges: () => undefined }, zone: { run: (callback: () => void) => callback() },
    savedDocumentListeners: [], newVideoImportTimeout: null, newVideoImportCounter: 7,
    folderThumbnailRegenerationSession: new FolderThumbnailRegenerationSession(),
    individualThumbnailRegenerationStatus: null, thumbnailRegenerationTimer: null,
  });
  home.connectSavedNormalDocument();
  const editor = new Editor(electron, images, manualTags, modal, mutations);
  editor.images = images.imageElements;
  editor.currentVhaFile = home.appState.currentVhaFile;
  const request = (id = requestId): void => emit(channels.request, id);
  const release = (saved: boolean, id = requestId): void => emit(channels.release, id, { saved });
  const snapshot = (): FinalObject | null => {
    const message = sent.find(message => message[0] === channels.snapshot);
    assert.ok(message);
    const response = message[2] as { status: string; document: FinalObject | null };
    assert.equal(response.status, 'snapshot');
    return response.document;
  };
  return { home, editor, electron, mutations, document, images, first, autoTags, manualTags, sent,
    sourceFolders, emit, request, release, snapshot,
    dialogsClosed: () => dialogsClosed, failClose: () => { failClose = true; },
    nativeInvoke: (invoke: typeof invokeNative) => { invokeNative = invoke; } };
}

test('Home sends a full clean writable snapshot through real ElectronService and document projection', () => {
  const h = harness();
  assert.equal(h.home.getFinalObjectForSaving(), null, 'ordinary clean save remains a no-op');
  h.request();
  const snapshot = h.snapshot()!;
  assert.equal(snapshot.hubName, 'Test catalogue');
  assert.equal(snapshot.images[0].notes, 'Original notes');
  assert.deepEqual(snapshot.images[0].locations, h.first.locations);
  assert.deepEqual(snapshot.tagDefinitions, ['Animals', 'Animals > Birds']);
  assert.deepEqual(snapshot.tagColors, { Animals: '#abcdef' });
  assert.deepEqual(snapshot.addTags, ['automatic-added']);
  assert.deepEqual(snapshot.removeTags, ['automatic-removed']);
  assert.deepEqual(snapshot.inputDirs, h.sourceFolders.selectedSourceFolder);
  assert.deepEqual(snapshot.screenshotSettings, h.home.currentScreenshotSettings);
  assert.equal(h.mutations.accepting, false);
  assert.equal(h.document.body.inert, true);
  assert.equal(h.home.newVideoImportCounter, 0);
  assert.equal(h.dialogsClosed(), 0, 'dialog close callbacks must wait for main handback');
  h.release(true);
  assert.equal(h.dialogsClosed(), 1);
  assert.equal(h.document.body.inert, false);
});

for (const mode of ['read-only', 'no-hub']) {
  test(`Home ${mode} snapshot contains no document`, () => {
    const h = harness({ readOnly: mode === 'read-only', noHub: mode === 'no-hub' });
    h.request();
    assert.equal(h.snapshot(), null);
    h.release(true);
  });
}

test('Home flushes a blur-committed note and live editor tag draft into the same frozen snapshot', () => {
  const h = harness();
  h.editor.updateTagDraft(h.first, 'Animals > Birds, Reviewed');
  h.document.blurCommit = () => h.editor.updateNotes(h.first, 'Last typed note');
  h.request();
  const snapshot = h.snapshot()!;
  assert.equal(snapshot.images[0].notes, 'Last typed note');
  assert.deepEqual(snapshot.images[0].tags, ['Animals > Birds', 'Reviewed']);
  h.editor.updateNotes(h.first, 'Blocked note');
  assert.equal(h.first.notes, 'Last typed note');
  assert.deepEqual(h.document.emit('beforeinput'), { prevented: true, stopped: true });
  h.release(true);
  assert.equal(h.images.finalArrayNeedsSaving, false);
  assert.equal(h.autoTags.needToSave(), false);
});

test('wrong, duplicated and malformed release messages cannot thaw a saved Home document', () => {
  const h = harness();
  h.request();
  h.release(true, otherId);
  h.emit(channels.release, requestId, { saved: 'yes' });
  assert.equal(h.mutations.accepting, false);
  assert.equal(h.document.body.inert, true);
  h.release(true);
  assert.equal(h.mutations.accepting, true);
  assert.equal(h.document.body.inert, false);
  h.release(true);
  assert.equal(h.dialogsClosed(), 1);
});

for (const refusal of ['composition', 'pending-native', 'invalid-draft', 'ordinary-save', 'ordinary-close']) {
  test(`Home refuses ${refusal} without leaving a partial DOM or mutation freeze`, () => {
    const h = harness();
    const pendingRelease = refusal === 'pending-native' ? h.mutations.holdPending() : () => undefined;
    if (refusal === 'composition') { h.document.emit('compositionstart'); }
    if (refusal === 'invalid-draft') { h.editor.updateTagDraft(h.first, 'Animals >> Birds'); }
    if (refusal === 'ordinary-save') { h.home.catalogueEditorSaving = true; }
    if (refusal === 'ordinary-close') { h.home.isClosing = true; }
    h.request();
    assert.deepEqual(h.sent[0], [channels.snapshot, requestId, { status: 'cancelled' }]);
    assert.equal(h.document.body.inert, false);
    assert.equal(h.mutations.accepting, true);
    assert.equal(h.home.savedNormalDocument.frozen, true, 'nonce still requires main release');
    assert.equal(h.first.notes, 'Original notes');
    pendingRelease();
    h.document.emit('compositionend');
    h.release(false);
    assert.equal(h.home.savedNormalDocument.frozen, false);
  });
}

for (const drift of ['revision', 'session']) {
  test(`Home does not clear dirty state when its ${drift} changes after snapshot`, () => {
    const h = harness();
    h.editor.updateNotes(h.first, 'Unsaved note');
    h.autoTags.addAddTag('new automatic tag');
    h.request();
    if (drift === 'revision') { h.mutations.changed(); }
    else { h.home.catalogueSessionGeneration++; }
    h.release(true);
    assert.equal(h.images.finalArrayNeedsSaving, true);
    assert.equal(h.autoTags.needToSave(), true);
  });
}

test('deferred native result is retained and applied only after exact handback', () => {
  const h = harness();
  h.editor.updateNotes(h.first, 'Unsaved note');
  h.electron.ipcRenderer.on('filename-changed', (_event: unknown, nextName: string) => {
    h.images.replaceFileNameInFinalArray(nextName, 'first.mp4', 0);
  });
  h.request();
  h.emit('filename-changed', 'renamed.mp4');
  assert.equal(h.first.fileName, 'first.mp4');
  assert.equal(h.snapshot()!.images[0].fileName, 'first.mp4');
  h.release(true, otherId);
  assert.equal(h.first.fileName, 'first.mp4');
  h.release(true);
  assert.equal(h.first.fileName, 'renamed.mp4');
  assert.equal(h.images.finalArrayNeedsSaving, true, 'late durable result cannot be marked saved by older snapshot');
});

test('pending native invoke preserves its renderer update and refuses a competing handoff', async () => {
  const h = harness();
  let resolveNative: (value: unknown) => void;
  h.nativeInvoke(() => new Promise(resolve => { resolveNative = resolve; }));
  const native = h.electron.ipcRenderer.invoke('synthetic-durable-rename').then(() => {
    h.images.replaceFileNameInFinalArray('native-renamed.mp4', 'first.mp4', 0);
  });
  h.request();
  assert.deepEqual(h.sent[0], [channels.snapshot, requestId, { status: 'cancelled' }]);
  resolveNative({ applied: true });
  await native;
  assert.equal(h.first.fileName, 'native-renamed.mp4');
  assert.equal(h.images.finalArrayNeedsSaving, true);
  h.release(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  h.request(otherId);
  assert.equal((h.sent.at(-1)![2] as { status: string }).status, 'snapshot');
  h.release(true, otherId);
});

test('Home keeps editing quarantined when deferred result restoration fails', () => {
  const h = harness();
  h.electron.ipcRenderer.on('synthetic-bad-result', () => { throw new Error('Synthetic result failure'); });
  h.request();
  h.emit('synthetic-bad-result');
  h.release(true);
  assert.equal(h.mutations.accepting, false);
  assert.equal(h.document.body.inert, true);
  assert.equal(h.home.savedNormalDocument.frozen, true);
  h.release(false);
  assert.equal(h.mutations.accepting, false);
});

test('Home keeps the UI inert when closing old dialogs fails on handback', () => {
  const h = harness();
  h.request();
  h.failClose();
  h.release(true);
  assert.equal(h.mutations.accepting, false);
  assert.equal(h.document.body.inert, true);
});

test('a failed native save restores Home with its image and automatic-tag edits still dirty', () => {
  const h = harness();
  h.editor.updateNotes(h.first, 'Keep this unsaved note');
  h.autoTags.addAddTag('Keep this automatic tag');
  h.request();
  h.release(false);
  assert.equal(h.document.body.inert, false);
  assert.equal(h.mutations.accepting, true);
  assert.equal(h.images.finalArrayNeedsSaving, true);
  assert.equal(h.autoTags.needToSave(), true);
  assert.equal(h.first.notes, 'Keep this unsaved note');
});

test('snapshot projection failure retains the actual Home freeze until main releases its nonce', () => {
  const h = harness();
  h.home.catalogueSessionDocument.buildDocument = () => { throw new Error('Synthetic snapshot failure'); };
  h.request();
  assert.deepEqual(h.sent[0], [channels.snapshot, requestId, { status: 'cancelled' }]);
  assert.equal(h.document.body.inert, true);
  assert.equal(h.mutations.accepting, false);
  h.release(false, otherId);
  assert.equal(h.mutations.accepting, false);
  h.release(false);
  assert.equal(h.document.body.inert, false);
  assert.equal(h.mutations.accepting, true);
});

test('ordinary workspace handback clears drained progress while retaining catalogue edits and discovered folders', () => {
  const h = harness();
  h.editor.updateNotes(h.first, 'Keep this note after private use');
  h.autoTags.addAddTag('Uncommitted automatic tag');
  h.sourceFolders.sourceFolderConnected = { 0: true };
  h.sourceFolders.selectedSourceFolder[0].watch = true;
  h.sourceFolders.replaceDiscoveredDirectoriesInScope(0, '', ['Birds', 'Birds/Empty', 'Other']);
  const directoryRevision = h.sourceFolders.getDiscoveredDirectoryRevision();
  h.sourceFolders.currentlyScanning.set(0, true);
  h.sourceFolders.setActiveScanScope(0, 'Birds');
  const sources = h.sourceFolders.selectedSourceFolder;
  const connected = h.sourceFolders.sourceFolderConnected;
  Object.assign(h.home, {
    importStage: 'extracting', progressString: '4 of 10', extractionPercent: 0.4,
    timeExtractionStarted: 100, timeExtractionRemaining: 200, allFinishedScanning: false,
    individualThumbnailRegenerationStatus: { totalJobs: 2 },
    thumbnailRegenerationStartedAt: 100, thumbnailRegenerationElapsedSeconds: 20,
  });
  h.home.folderThumbnailRegenerationSession.begin({
    hubFile: h.home.appState.currentVhaFile, sourceIndex: 0, relativePath: 'Birds',
    sourceFolderPath: '/synthetic/media', totalJobs: 1, skippedVideos: 0,
    videoCountsByHash: new Map([['first-video', 1]]),
  });

  h.request();
  h.emit('normal-workspace-resumed');
  assert.equal(h.home.importStage, 'extracting', 'even progress-only events wait for handback');
  assert.equal(h.sourceFolders.currentlyScanning.get(0), true);
  h.release(false, otherId);
  assert.equal(h.home.thumbnailRegenerationActive, true);
  h.release(false);

  assert.equal(h.home.importStage, 'done');
  assert.equal(h.home.progressString, '');
  assert.equal(h.home.extractionPercent, 1);
  assert.equal(h.home.timeExtractionStarted, undefined);
  assert.equal(h.home.timeExtractionRemaining, undefined);
  assert.equal(h.home.allFinishedScanning, true);
  assert.equal(h.sourceFolders.currentlyScanning.size, 0);
  assert.equal(h.sourceFolders.getActiveScanScope(0), undefined);
  assert.equal(h.home.thumbnailRegenerationActive, false);
  assert.equal(h.home.thumbnailRegenerationStartedAt, 0);
  assert.equal(h.home.thumbnailRegenerationElapsedSeconds, 0);
  assert.equal(h.sourceFolders.selectedSourceFolder, sources);
  assert.equal(sources[0].watch, true);
  assert.equal(h.sourceFolders.sourceFolderConnected, connected);
  assert.deepEqual(Array.from(h.sourceFolders.getDiscoveredDirectories(0)), ['Birds', 'Birds/Empty', 'Other']);
  assert.equal(h.sourceFolders.getDiscoveredDirectoryRevision(), directoryRevision);
  assert.equal(h.images.imageElements[0], h.first);
  assert.equal(h.first.notes, 'Keep this note after private use');
  assert.equal(h.images.finalArrayNeedsSaving, true);
  assert.equal(h.autoTags.needToSave(), true);
  assert.equal(h.document.body.inert, false);
});
