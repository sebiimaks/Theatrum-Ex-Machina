import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

import { NewImageElement } from '../interfaces/final-object.interface';
import type { ImageElement } from '../interfaces/final-object.interface';
import { createCatalogueMetadataExport } from '../interfaces/catalogue-metadata-transfer';
import { normalizeTagInputPreservingExisting, tagPathsEqual } from '../interfaces/tag-hierarchy';
import { RendererMutationLifetime } from '../src/app/common/renderer-mutation-lifetime';

const clipboard = { writeText: async (_text: string) => undefined };

// Execute each complete production component with Angular decorators and UI
// dependencies stubbed. The mutation lifetime, import plans and tag plans are real.
function componentClass(relativePath: string, name: string): any {
  const fileName = path.join(__dirname, '..', relativePath);
  const nativeRequire = createRequire(fileName);
  const componentExports: Record<string, unknown> = {};
  const decorator = () => () => undefined;
  class Emitter {
    values: unknown[] = [];
    emit(value?: unknown): void { this.values.push(value); }
  }
  const angular = {
    Component: decorator, HostListener: decorator, Input: decorator, Output: decorator,
    ViewChild: decorator, ViewChildren: decorator, EventEmitter: Emitter,
    effect: (callback: () => void) => callback(),
    input: (initial?: unknown) => () => initial,
    output: () => new Emitter(),
  };
  const compiled = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    compilerOptions: {
      experimentalDecorators: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  runInNewContext(compiled, {
    exports: componentExports,
    require: (request: string) => {
      if (request === '@angular/core') { return angular; }
      if (request.endsWith('/animations')) { return { modalAnimation: {} }; }
      return nativeRequire(request);
    },
    setTimeout,
    navigator: { clipboard },
    HTMLElement: class HTMLElement {},
  }, { filename: fileName });
  return componentExports[name];
}

const CatalogueEditor = componentClass(
  'src/app/components/catalogue-editor/catalogue-editor.component.ts', 'CatalogueEditorComponent',
);
const TagTray = componentClass('src/app/components/tag-tray/tag-tray.component.ts', 'TagTrayComponent');

function image(index = 0, overrides: Partial<ImageElement> = {}): ImageElement {
  return { ...NewImageElement(), index, hash: `video-${index}`, fileName: `video-${index}.mp4`,
    cleanName: `Video ${index}`, tags: ['Animals > Birds'], notes: 'Original notes', ...overrides };
}

function harness(images = [image()]) {
  const mutations = new RendererMutationLifetime();
  const confirmations: ((confirmed: boolean) => void)[] = [];
  const manualTags = {
    tagsList: ['Animals > Birds'], pipeToggleTrigger: false,
    normalizeTagInput: (draft: string) => normalizeTagInputPreservingExisting(draft, []),
    getTypeahead: () => '', removeAllTags: () => undefined,
    populateManualTagsService: () => undefined, rebuildFromImages: () => undefined,
    getTagDefinitions: () => [], hasTagDefinition: () => false,
    getTagColors: () => ({}), getTagColor: () => undefined,
    replaceTagColors: () => undefined, replaceTagDefinitions: () => undefined,
    removeTagDefinitions: () => undefined, removeTagDefinitionBranch: () => undefined,
    addTagDefinition: () => { throw new Error('Unexpected frozen tag definition'); },
  };
  let dirty = false;
  let tagMutations = 0;
  const imageService = {
    imageElements: images,
    get finalArrayNeedsSaving() { return dirty; },
    set finalArrayNeedsSaving(value: boolean) { dirty = value; if (value) { mutations.changed(); } },
    removeTagsFromAll: (tags: string[]) => {
      tagMutations++;
      images.forEach(entry => { entry.tags = entry.tags.filter(tag => !tags.some(value => tagPathsEqual(value, tag))); });
    },
    applyTagBranchRemovalPlan: () => { tagMutations++; },
    applyTagBranchMovePlan: (plan: { affectedEntryCount: number }) => {
      tagMutations++;
      return plan.affectedEntryCount;
    },
  };
  const modal = {
    dialog: { openDialogs: [] }, openSnackbar: () => undefined,
    openConfirmationDialog: () => ({
      subscribe: (callback: (confirmed: boolean) => void) => confirmations.push(callback),
    }),
  };
  const electron = {
    ipcRenderer: { invoke: async (..._args: unknown[]) => ({ status: 'cancelled' }) as any },
    copyText: () => undefined,
  };
  const editor = new CatalogueEditor(electron, imageService, manualTags, modal, mutations);
  editor.images = images;
  editor.currentVhaFile = '/synthetic/catalogue.scaena';
  editor.refreshFilteredEntries();
  const tray = new TagTray(manualTags, imageService, modal, { instant: (key: string) => key }, mutations);
  return { mutations, editor, tray, images, confirmations, electron,
    get tagMutations() { return tagMutations; } };
}

test('live editor flushes every row tag draft before freezing, including filtered-out rows', () => {
  const h = harness([image(), image(1)]);
  h.editor.updateTagDraft(h.images[0], 'Animals > Birds, Reviewed');
  h.editor.updateTagDraft(h.images[1], 'Animals > Frogs');
  h.editor.filteredEntries = [h.images[0]];
  const thaw = h.mutations.freeze();
  assert.deepEqual(Array.from(h.images[0].tags), ['Animals > Birds', 'Reviewed']);
  assert.deepEqual(Array.from(h.images[1].tags), ['Animals > Frogs']);
  assert.equal(h.mutations.accepting, false);
  assert.equal(h.mutations.revision, 2);
  thaw();
});

test('invalid row tag draft refuses handoff without dropping the draft', () => {
  const h = harness();
  h.editor.updateTagDraft(h.images[0], 'Animals >> Birds');
  assert.throws(() => h.mutations.freeze(), /Correct invalid tag paths/);
  assert.equal(h.mutations.accepting, true);
  assert.deepEqual(h.images[0].tags, ['Animals > Birds']);
  assert.equal(h.editor.tagDraftFor(h.images[0]), 'Animals >> Birds');
});

test('destroying an editor unregisters its pending invalid drafts', () => {
  const h = harness();
  h.editor.updateTagDraft(h.images[0], 'Animals >> Birds');
  h.editor.ngOnDestroy();
  h.tray.ngOnDestroy();
  const thaw = h.mutations.freeze();
  assert.equal(h.mutations.accepting, false);
  thaw();
});

test('paused live editor rejects document and draft mutations without changing its revision', () => {
  const h = harness();
  const before = JSON.stringify(h.images);
  const thaw = h.mutations.freeze();
  const revision = h.mutations.revision;
  h.editor.updateNotes(h.images[0], 'Unexpected');
  h.editor.updateStringField(h.images[0], 'cleanName', 'Unexpected');
  h.editor.updateStringField(h.images[0], 'fileName', 'unexpected.mp4');
  h.editor.updateNumberField(h.images[0], 'timesPlayed', 99);
  h.editor.updateStar(h.images[0], 5.5);
  h.editor.updateDefaultScreen(h.images[0], 1);
  h.editor.updateDateAdded(h.images[0], '2026-09-22T12:00');
  h.editor.updateYear(h.images[0], 2026);
  h.editor.updateTagDraft(h.images[0], 'Unexpected');
  h.editor.deleteEntry(h.images[0]);
  h.editor.restoreEntry(h.images[0]);
  assert.equal(h.editor.commitTags(h.images[0]), false);
  h.editor.requestSave();
  h.tray.createTagDefinition();
  assert.equal(JSON.stringify(h.images), before);
  assert.equal(h.mutations.revision, revision);
  assert.equal(h.editor.saveRequested.values.length, 0);
  thaw();
  h.editor.updateNotes(h.images[0], 'Resumed notes');
  assert.equal(h.images[0].notes, 'Resumed notes');
});

for (const timing of ['frozen', 'resumed', 'destroyed'] as const) {
  test(`batch overwrite confirmation cannot mutate a ${timing} editor`, () => {
    const h = harness();
    h.editor.batchOverwriteField = 'notes';
    h.editor.batchOverwriteDraft = 'Changed notes';
    h.editor.requestBatchOverwrite();
    assert.equal(h.confirmations.length, 1);
    const thaw = h.mutations.freeze();
    if (timing === 'resumed') { thaw(); }
    if (timing === 'destroyed') { h.editor.ngOnDestroy(); }
    h.confirmations[0](true);
    assert.equal(h.images[0].notes, 'Original notes');
    thaw();
  });
}

test('current batch overwrite confirmation still applies normally', () => {
  const h = harness();
  h.editor.batchOverwriteField = 'notes';
  h.editor.batchOverwriteDraft = 'Changed notes';
  h.editor.requestBatchOverwrite();
  h.confirmations[0](true);
  assert.equal(h.images[0].notes, 'Changed notes');
  assert.equal(h.mutations.revision, 1);
});

async function stageMetadataImport(h: ReturnType<typeof harness>): Promise<void> {
  const contents = JSON.stringify(createCatalogueMetadataExport([
    image(0, { notes: 'Imported notes' }),
  ]).document);
  h.electron.ipcRenderer.invoke = async () => ({ status: 'success', contents, fileName: 'metadata.json' });
  await h.editor.chooseMetadataImport();
  assert.equal(h.editor.metadataImportPlan.changedEntryCount, 1);
  h.editor.requestMetadataImport();
  assert.equal(h.confirmations.length, 1);
}

for (const resumed of [false, true]) {
  test(`metadata import confirmation cannot apply ${resumed ? 'after thaw' : 'while frozen'}`, async () => {
    const h = harness();
    await stageMetadataImport(h);
    const thaw = h.mutations.freeze();
    if (resumed) { thaw(); }
    h.confirmations[0](true);
    assert.equal(h.images[0].notes, 'Original notes');
    assert.equal(h.editor.metadataTransferBusy, false);
    assert.match(h.editor.metadataTransferStatus, /cancelled because the catalogue was paused/);
    thaw();
  });
}

test('current metadata confirmation imports normally', async () => {
  const h = harness();
  await stageMetadataImport(h);
  h.confirmations[0](true);
  assert.equal(h.images[0].notes, 'Imported notes');
});

test('late read-only metadata selection does not repopulate the editor after a pause', async () => {
  const h = harness();
  let complete: (value: unknown) => void;
  h.electron.ipcRenderer.invoke = () => new Promise(resolve => { complete = resolve; });
  const selecting = h.editor.chooseMetadataImport();
  const thaw = h.mutations.freeze();
  thaw();
  complete({ status: 'success', fileName: 'late.json', contents: '{}' });
  await selecting;
  assert.equal(h.editor.metadataImportFileName, '');
  assert.equal(h.editor.metadataTransferBusy, false);
});

for (const action of ['exact', 'branch', 'move'] as const) {
  for (const resumed of [false, true]) {
    test(`tag ${action} confirmation cannot apply ${resumed ? 'after thaw' : 'while frozen'}`, () => {
      const h = harness([image(), image(1), image(2)]);
      if (action === 'exact') { h.tray.confirmExactRemoval('Animals > Birds'); }
      if (action === 'branch') { h.tray.confirmBranchRemoval('Animals'); }
      if (action === 'move') { h.tray.confirmTagBranchMove('Animals', 'Nature'); }
      assert.equal(h.confirmations.length, 1);
      const thaw = h.mutations.freeze();
      if (resumed) { thaw(); }
      h.confirmations[0](true);
      assert.equal(h.tagMutations, 0);
      thaw();
    });
  }
}

test('tag confirmation from a destroyed tray cannot act on the still-open hub', () => {
  const h = harness([image(), image(1), image(2)]);
  h.tray.confirmExactRemoval('Animals > Birds');
  h.tray.ngOnDestroy();
  h.confirmations[0](true);
  assert.equal(h.tagMutations, 0);
});

test('current tag confirmation still removes tags', () => {
  const h = harness([image(), image(1), image(2)]);
  h.tray.confirmExactRemoval('Animals > Birds');
  h.confirmations[0](true);
  assert.equal(h.tagMutations, 1);
  assert.deepEqual(h.images[0].tags, []);
});

test('pause clears an in-progress tag drag instead of resuming an old drop', () => {
  const h = harness();
  h.tray.draggedTagPath = 'Animals';
  h.tray.pointerDragCandidatePath = 'Animals';
  h.tray.pointerDragActive = true;
  const thaw = h.mutations.freeze();
  assert.equal(h.tray.draggedTagPath, '');
  assert.equal(h.tray.pointerDragCandidatePath, '');
  assert.equal(h.tray.pointerDragActive, false);
  thaw();
});


test('a pending clipboard write delays handoff until the renderer result settles', async () => {
  const h = harness();
  let complete: () => void;
  clipboard.writeText = () => new Promise<void>(resolve => { complete = resolve; });
  const copying = h.editor.copyHash(h.images[0]);
  assert.equal(h.mutations.pendingCount, 1);
  assert.throws(() => h.mutations.freeze(), /requests are still completing/);
  complete();
  await copying;
  assert.equal(h.mutations.pendingCount, 0);
  assert.equal(h.editor.hashCopiedIndex, 0);
  const thaw = h.mutations.freeze();
  thaw();
  clipboard.writeText = async () => undefined;
});
