import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

import type { FinalObject } from '../interfaces/final-object.interface';
import {
  hasCatalogueOrAssetNameCollision,
  isSafeCatalogueHubName,
} from '../interfaces/catalogue-file';
import { catalogueMediaAuthorityHashes } from './catalogue-media-authority';
import { prepareAuthorizedCatalogueWrite } from './catalogue-write-authority';
import { sanitizeScreenshotSettings } from './thumbnail-count';

const repositoryRoot = path.join(__dirname, '..');
const fixtureRoot = path.join(repositoryRoot, 'creation-test-fixtures');
const oldSource = path.join(fixtureRoot, 'old-source');
const newSource = path.join(fixtureRoot, 'new-source');
const outputDirectory = path.join(fixtureRoot, 'output');
const oldCataloguePath = path.join(outputDirectory, 'Old Catalogue.scaena');

// Execute the production listener without importing main.ts, whose top-level
// Electron startup would create a window and read the user's app settings.
const mainSource = readFileSync(path.join(repositoryRoot, 'main.ts'), 'utf8');
const mainSyntax = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);
const registration = mainSyntax.statements.find((statement) => {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return false;
  }
  const call = statement.expression;
  return ts.isIdentifier(call.expression)
    && call.expression.text === 'trustedIpcOn'
    && ts.isStringLiteral(call.arguments[0])
    && call.arguments[0].text === 'start-the-import';
});
assert.ok(registration, 'The production catalogue-creation listener must exist.');
const listenerSource = ts.transpileModule(registration.getText(mainSyntax), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function currentDocument(): FinalObject {
  return {
    addTags: ['unsaved-tag'],
    hubName: 'Untrusted Renderer Name',
    images: [],
    inputDirs: { 0: { path: oldSource, watch: true } },
    numOfFolders: 1,
    removeTags: [],
    screenshotSettings: {
      clipHeight: 144,
      clipSnippetLength: 1,
      clipSnippets: 0,
      fixed: true,
      height: 288,
      n: 10,
    },
    version: 3,
  };
}

function createHarness(options: {
  accessMode?: 'read-only' | 'read-write';
  rejectMedia?: boolean;
} = {}) {
  const selectedSourceFolders = { 0: { path: oldSource, watch: false } };
  const oldMediaAuthority = new Set(['old-video\0' + '0\0\0old.mp4']);
  const oldImageHashes = new Set(['old-video']);
  const globals = {
    authorizedCatalogueImageHashes: oldImageHashes,
    authorizedCatalogueMediaLocations: oldMediaAuthority,
    catalogueAccessMode: options.accessMode || 'read-write',
    cataloguePersistenceActive: false,
    catalogueSessionGeneration: 4,
    catalogueTransitionActive: false,
    currentlyOpenVhaFile: oldCataloguePath,
    hubName: 'Old Catalogue',
    pendingInputDirectorySelections: new Set([newSource]),
    pendingOutputDirectorySelections: new Set([outputDirectory]),
    selectedOutputFolder: outputDirectory,
    selectedSourceFolders,
    vhaFileVersion: 3,
  };
  const wizard = {
    clipHeight: 144,
    clipSnippetLength: 1,
    clipSnippets: 0,
    extractClips: false,
    futureHubName: 'New Catalogue',
    isFixedNumberOfScreenshots: true,
    screenshotSizeForImport: 288,
    selectedOutputFolder: outputDirectory,
    selectedSourceFolder: { 0: { path: newSource, watch: false } },
    ssConstant: 10,
    ssVariable: 1,
  };
  const writes: {
    document: FinalObject;
    destination: string;
    complete: (error?: Error) => void;
  }[] = [];
  const creations: { generation: number; creation: { finalObject: FinalObject } }[] = [];
  const folders: string[] = [];
  const messages: unknown[][] = [];
  const dialogs: unknown[] = [];
  const finished: number[] = [];
  let activeGeneration: number | undefined;
  let reconcileCalls = 0;
  let listener: (event: unknown, wizard: unknown, document?: FinalObject | null) => void;
  const isCurrent = (generation: number): boolean => globals.catalogueTransitionActive
    && generation === activeGeneration
    && generation === globals.catalogueSessionGeneration;

  runInNewContext(listenerSource, {
    Error,
    GLOBALS: globals,
    Set,
    assertCurrentCatalogueOpenOperation: (generation: number): void => {
      assert.ok(isCurrent(generation), 'The creation must belong to the active transition.');
    },
    beginCatalogueOpenOperation: (): number => {
      globals.catalogueTransitionActive = true;
      activeGeneration = ++globals.catalogueSessionGeneration;
      return activeGeneration;
    },
    catalogueMediaAuthorityHashes,
    catalogueOpenOperationActive: false,
    console: { log: () => undefined, warn: () => undefined },
    dialog: {
      showMessageBox: (_window: unknown, details: unknown): Promise<unknown> => {
        dialogs.push(details);
        return Promise.resolve({ response: 0 });
      },
    },
    finishCatalogueOpenOperation: (generation: number): void => {
      finished.push(generation);
      if (activeGeneration === generation) {
        globals.catalogueTransitionActive = false;
        activeGeneration = undefined;
      }
    },
    fs: {
      mkdirSync: (directory: string): void => { folders.push(directory); },
      readdirSync: (): string[] => [],
      realpathSync: { native: (directory: string): string => directory },
    },
    hasCatalogueOrAssetNameCollision,
    isCurrentCatalogueOpenOperation: isCurrent,
    isSafeCatalogueHubName,
    isThumbnailRegenerationActive: (): boolean => false,
    path,
    prepareAuthorizedCatalogueWrite,
    reconcileRendererCatalogueMediaAuthority: (): Set<string> => {
      if (options.rejectMedia) {
        throw new Error('The snapshot contains unauthorized media.');
      }
      return new Set();
    },
    reconcileSourceFoldersBeforeCatalogueSwitch: (sources: typeof selectedSourceFolders): void => {
      reconcileCalls += 1;
      globals.selectedSourceFolders = sources;
    },
    removeEmptyCatalogueAssetFolders: (): void => undefined,
    requirePendingDirectorySelection: (directory: string, selected: Set<string>): string => {
      assert.ok(selected.has(directory), 'Only native-selected directories may be used.');
      return directory;
    },
    sanitizeScreenshotSettings,
    systemMessages: {},
    trustedIpcOn: (_channel: string, callback: typeof listener): void => { listener = callback; },
    win: {},
    writeVhaFileAndStartExtraction: (
      generation: number,
      creation: { finalObject: FinalObject },
    ): void => { creations.push({ generation, creation }); },
    writeVhaFileToDisk: (
      document: FinalObject,
      destination: string,
      complete: (error?: Error) => void,
    ): void => { writes.push({ document, destination, complete }); },
  });

  return {
    assertOriginalSession(): void {
      assert.equal(globals.currentlyOpenVhaFile, oldCataloguePath);
      assert.equal(globals.hubName, 'Old Catalogue');
      assert.equal(globals.selectedSourceFolders, selectedSourceFolders);
      assert.equal(globals.selectedOutputFolder, outputDirectory);
      assert.equal(globals.authorizedCatalogueMediaLocations, oldMediaAuthority);
      assert.equal(globals.authorizedCatalogueImageHashes, oldImageHashes);
      assert.deepEqual([...globals.pendingInputDirectorySelections], [newSource]);
      assert.deepEqual([...globals.pendingOutputDirectorySelections], [outputDirectory]);
      assert.equal(reconcileCalls, 0);
    },
    creations,
    dialogs,
    finished,
    folders,
    globals,
    messages,
    start(document: FinalObject | null = currentDocument()): void {
      listener({ sender: { send: (...args: unknown[]): void => { messages.push(args); } } }, wizard, document);
    },
    writes,
  };
}

test('creation waits for the old catalogue save and validates with the old main-owned sources', () => {
  const harness = createHarness();
  harness.start();

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].destination, oldCataloguePath);
  assert.equal(harness.writes[0].document.hubName, 'Old Catalogue');
  assert.deepEqual(harness.writes[0].document.inputDirs, { 0: { path: oldSource, watch: false } });
  assert.deepEqual(harness.writes[0].document.addTags, ['unsaved-tag']);
  assert.equal(harness.folders.length, 0);
  assert.equal(harness.creations.length, 0);
  harness.assertOriginalSession();

  harness.writes[0].complete();

  assert.equal(harness.creations.length, 1);
  assert.equal(harness.folders.length, 4);
  assert.equal(harness.creations[0].creation.finalObject.hubName, 'New Catalogue');
  assert.equal(harness.creations[0].creation.finalObject.inputDirs[0].path, newSource);
});

test('a failed old-catalogue save preserves the session and creates no new files or folders', () => {
  const harness = createHarness();
  harness.start();
  harness.writes[0].complete(new Error('Disk full'));

  harness.assertOriginalSession();
  assert.equal(harness.folders.length, 0);
  assert.equal(harness.creations.length, 0);
  assert.equal(harness.globals.catalogueTransitionActive, false);
  assert.equal(harness.finished.length, 1);
  assert.equal(harness.dialogs.length, 1);
  assert.deepEqual(harness.messages, [['current-vha-file-save-failed', 'Disk full']]);
});

test('a snapshot cannot replace the old source with the newly selected import folder', () => {
  const harness = createHarness();
  const document = currentDocument();
  document.inputDirs[0].path = newSource;
  harness.start(document);

  harness.assertOriginalSession();
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.folders.length, 0);
  assert.equal(harness.creations.length, 0);
  assert.equal(harness.globals.catalogueTransitionActive, false);
  assert.equal(harness.messages[0][0], 'current-vha-file-save-failed');
});

test('media-authority validation fails before either catalogue is written', () => {
  const harness = createHarness({ rejectMedia: true });
  harness.start();

  harness.assertOriginalSession();
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.folders.length, 0);
  assert.equal(harness.creations.length, 0);
  assert.equal(harness.globals.catalogueTransitionActive, false);
  assert.deepEqual(harness.messages, [
    ['current-vha-file-save-failed', 'The snapshot contains unauthorized media.'],
  ]);
});

test('a superseded save callback cannot start creation or replace catalogue authority', () => {
  const harness = createHarness();
  harness.start();
  harness.globals.catalogueSessionGeneration += 1;
  harness.writes[0].complete();

  harness.assertOriginalSession();
  assert.equal(harness.creations.length, 0);
  assert.equal(harness.folders.length, 0);
  assert.equal(harness.finished.length, 0);
});

test('clean and read-only catalogues create without writing the previous catalogue', () => {
  for (const accessMode of ['read-only', 'read-write'] as const) {
    const harness = createHarness({ accessMode });
    harness.start(accessMode === 'read-only' ? currentDocument() : null);

    harness.assertOriginalSession();
    assert.equal(harness.writes.length, 0);
    assert.equal(harness.creations.length, 1);
    assert.equal(harness.folders.length, 4);
  }
});

function rendererCreationHarness(blocked = false) {
  const homeSource = readFileSync(path.join(repositoryRoot, 'src/app/components/home.component.ts'), 'utf8');
  const homeSyntax = ts.createSourceFile('home.component.ts', homeSource, ts.ScriptTarget.Latest, true);
  const homeClass = homeSyntax.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === 'HomeComponent'
  ));
  const importFresh = homeClass?.members.find((member): member is ts.MethodDeclaration => (
    ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'importFresh'
  ));
  assert.ok(importFresh, 'The renderer catalogue-creation method must exist.');
  const methodSource = ts.transpileModule(
    `class RendererCreation { ${importFresh.getText(homeSyntax)} }
RendererCreation.prototype.importFresh;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const method: (this: unknown) => void = runInNewContext(methodSource);
  const document = currentDocument();
  const originalSources = document.inputDirs;
  const originalOutput = path.join(fixtureRoot, 'old-output');
  const sent: unknown[][] = [];
  let snapshotRequests = 0;
  let resets = 0;
  const renderer = {
    appState: { selectedOutputFolder: originalOutput },
    blockActionDuringFolderThumbnailRegeneration: (): boolean => blocked,
    electronService: {
      ipcRenderer: {
        send: (...args: unknown[]): void => { sent.push(args); },
      },
    },
    getFinalObjectForSaving: (): FinalObject => {
      snapshotRequests++;
      assert.equal(renderer.sourceFolderService.selectedSourceFolder, originalSources);
      assert.equal(renderer.appState.selectedOutputFolder, originalOutput);
      return document;
    },
    sourceFolderService: {
      resetTransientState: (): void => { resets++; },
      selectedSourceFolder: originalSources,
    },
    wizard: {
      selectedOutputFolder: outputDirectory,
      selectedSourceFolder: { 0: { path: newSource, watch: false } },
    },
  };
  return {
    assertOriginalState(): void {
      assert.equal(renderer.sourceFolderService.selectedSourceFolder, originalSources);
      assert.equal(renderer.appState.selectedOutputFolder, originalOutput);
      assert.equal(resets, 0);
    },
    document,
    invoke(): void { method.call(renderer); },
    renderer,
    sent,
    snapshotRequests: (): number => snapshotRequests,
  };
}

test('the renderer sends its dirty document while retaining the current source and output state', () => {
  const harness = rendererCreationHarness();
  harness.invoke();

  assert.equal(harness.snapshotRequests(), 1);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0][0], 'start-the-import');
  assert.equal(harness.sent[0][1], harness.renderer.wizard);
  assert.equal(harness.sent[0][2], harness.document);
  harness.assertOriginalState();
});

test('blocked thumbnail regeneration prevents renderer creation and snapshot collection', () => {
  const harness = rendererCreationHarness(true);
  harness.invoke();

  assert.equal(harness.snapshotRequests(), 0);
  assert.equal(harness.sent.length, 0);
  harness.assertOriginalState();
});
