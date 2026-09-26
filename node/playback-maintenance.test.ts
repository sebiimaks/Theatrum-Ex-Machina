import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

import type { ImageElement } from '../interfaces/final-object.interface';
import { AllSupportedBottomTrayViews, AllSupportedViews } from '../interfaces/shared-interfaces';
import { FilterKeyNames } from '../src/app/common/filters';
import { RendererMutationLifetime } from '../src/app/common/renderer-mutation-lifetime';
import { filterRecentlyPlayed } from '../src/app/common/workbench-navigation';

const repositoryRoot = join(__dirname, '..');

// Execute the real methods without bootstrapping Angular, Electron or user data.
function methodPrototype(file: string, className: string, names: string[], globals = {}) {
  const source = readFileSync(join(repositoryRoot, file), 'utf8');
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = syntax.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === className
  ));
  assert.ok(declaration, `${className} must exist`);
  const methods = names.map((name) => {
    const method = declaration.members.find((member): member is ts.MethodDeclaration => (
      ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name
    ));
    assert.ok(method, `${className}.${name} must exist`);
    return method.getText(syntax);
  });
  const script = ts.transpileModule(`class Harness { ${methods.join('\n')} }\nHarness.prototype;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(script, globals);
}

const servicePrototype = methodPrototype('src/app/services/image-element.service.ts', 'ImageElementService', [
  'resetLastPlayed', 'resetTimesPlayed',
]);
const homePrototype = methodPrototype('src/app/components/home.component.ts', 'HomeComponent', [
  'resetLastPlayed', 'toggleButton', 'handleCatalogueEntriesChanged',
], { AllSupportedBottomTrayViews, AllSupportedViews, FilterKeyNames });
const settingsPrototype = methodPrototype('src/app/components/settings/settings.component.ts', 'SettingsComponent', [
  'settingActionLabel',
]);

function video(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    fileName: 'synthetic-video.mp4', cleanName: 'Synthetic video', hash: 'synthetic-hash',
    lastPlayed: 1_700_000_000_000, timesPlayed: 8, tags: ['Nature'], notes: 'Keep this note',
    dateAdded: 1_600_000_000_000, stars: 4.5, playlist: 1_690_000_000_000, ...overrides,
  } as ImageElement;
}

function service(images = [video()], mutations = new RendererMutationLifetime()) {
  return Object.assign(Object.create(servicePrototype), {
    mutations,
    imageElements: images,
    finalArrayNeedsSaving: false,
  });
}

function renderer(options: { readOnly?: boolean; saving?: boolean; regenerating?: boolean; paused?: boolean } = {}) {
  const messages: string[] = [];
  let readOnlyBlocks = 0;
  const mutations = new RendererMutationLifetime();
  if (options.paused) { mutations.freeze(); }
  const instance = Object.assign(Object.create(homePrototype), {
    mutations,
    catalogueReadOnly: options.readOnly === true,
    catalogueEditorSaving: options.saving === true,
    blockActionDuringFolderThumbnailRegeneration: () => options.regenerating === true,
    showReadOnlyActionBlocked: () => { readOnlyBlocks++; },
    imageElementService: service([video()], mutations),
    playbackRevision: 4,
    showRecentlyPlayedOnly: true,
    sortType: 'lastPlayedDesc',
    modalService: { openSnackbar: (message: string) => messages.push(message) },
    translate: { instant: (key: string) => key },
    electronService: { ipcRenderer: { send: () => undefined } },
    reconcileVideoSelection: () => undefined,
    setUpTimesPlayedFilterValues: () => undefined,
    setUpYearFilterValues: () => undefined,
    deletePipeTrigger: false,
  });
  return { instance, messages, readOnlyBlocks: () => readOnlyBlocks };
}

test('Last Played reset clears all current-hub dates and preserves play counts and other metadata', () => {
  const images = [video(), video({ lastPlayed: 0 }), video({ missing: true }), video({ deleted: true })];
  const before = structuredClone(images);
  const otherHub = [video({ hash: 'another-hub', lastPlayed: 1_800_000_000_000 })];
  const otherHubBefore = structuredClone(otherHub);
  const current = service(images);

  assert.equal(current.resetLastPlayed(), true);
  assert.deepEqual(current.imageElements, before.map((item) => ({ ...item, lastPlayed: 0 })));
  assert.notEqual(current.imageElements, images, 'Replace the array to invalidate gallery sorting and filter caches');
  assert.equal(current.finalArrayNeedsSaving, true);
  assert.deepEqual(otherHub, otherHubBefore);
  assert.deepEqual(filterRecentlyPlayed(current.imageElements, true), []);
});

test('an already reset or empty hub stays clean and keeps its array reference', () => {
  for (const images of [[], [video({ lastPlayed: 0 })]]) {
    const current = service(images);
    assert.equal(current.resetLastPlayed(), false);
    assert.equal(current.imageElements, images);
    assert.equal(current.finalArrayNeedsSaving, false);
    current.finalArrayNeedsSaving = true;
    assert.equal(current.resetLastPlayed(), false);
    assert.equal(current.finalArrayNeedsSaving, true, 'Preserve previously unsaved changes');
  }
});

test('Times Played reset continues to preserve Last Played and recent history', () => {
  const current = service();
  const before = structuredClone(current.imageElements);
  current.resetTimesPlayed();
  assert.deepEqual(current.imageElements, before.map((item: ImageElement) => ({ ...item, timesPlayed: 0 })));
  assert.equal(filterRecentlyPlayed(current.imageElements, true).length, 1);
});

test('the maintenance action dispatches the reset and immediately refreshes playback-based views', () => {
  const { instance, messages } = renderer();
  instance.toggleButton('resetLastPlayed');
  assert.equal(instance.imageElementService.imageElements[0].lastPlayed, 0);
  assert.equal(instance.playbackRevision, 5);
  assert.equal(instance.showRecentlyPlayedOnly, true, 'Keep the selected collection while it becomes empty');
  assert.equal(instance.sortType, 'lastPlayedDesc', 'Keep the selected sort order');
  assert.deepEqual(messages, ['SETTINGS.lastPlayedReset']);
  assert.equal(settingsPrototype.settingActionLabel('resetLastPlayed'), 'WORKBENCH.reset');
  instance.toggleButton('resetLastPlayed');
  assert.equal(instance.playbackRevision, 5, 'A no-op reset does not invalidate playback caches again');
});

test('read-only, busy and paused catalogue actions cannot change Last Played or report a successful reset', () => {
  for (const options of [{ readOnly: true }, { saving: true }, { regenerating: true }, { paused: true }]) {
    const { instance, messages, readOnlyBlocks } = renderer(options);
    const before = structuredClone(instance.imageElementService.imageElements);
    instance.toggleButton('resetLastPlayed');
    assert.deepEqual(instance.imageElementService.imageElements, before);
    assert.equal(instance.imageElementService.finalArrayNeedsSaving, false);
    assert.equal(instance.playbackRevision, 4);
    assert.deepEqual(messages, []);
    assert.equal(readOnlyBlocks(), 'readOnly' in options ? 1 : 0);
  }
});

test('Last Played reset resumes normally after a private-workspace handoff is released', () => {
  const { instance, messages } = renderer();
  const thaw = instance.mutations.freeze();
  instance.toggleButton('resetLastPlayed');
  assert.notEqual(instance.imageElementService.imageElements[0].lastPlayed, 0);
  assert.equal(instance.playbackRevision, 4);
  assert.deepEqual(messages, []);

  thaw();
  instance.toggleButton('resetLastPlayed');
  assert.equal(instance.imageElementService.imageElements[0].lastPlayed, 0);
  assert.equal(instance.playbackRevision, 5);
  assert.equal(instance.imageElementService.finalArrayNeedsSaving, true);
});

test('catalogue editor changes invalidate recent playback views and respect read-only mode', () => {
  const writable = renderer().instance;
  writable.handleCatalogueEntriesChanged();
  assert.equal(writable.playbackRevision, 5);
  assert.equal(writable.catalogueEditorSaveStatus, 'Unsaved Changes');

  const readOnly = renderer({ readOnly: true }).instance;
  readOnly.handleCatalogueEntriesChanged();
  assert.equal(readOnly.playbackRevision, 4);
});
