import '@angular/compiler';
import { Injector, runInInjectionContext } from '@angular/core';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NewImageElement } from '../interfaces/final-object.interface';
import { RendererMutationLifetime } from '../src/app/common/renderer-mutation-lifetime';
import type { RendererMutationToken } from '../src/app/common/renderer-mutation-lifetime';
import { SavedNormalDocumentCoordinator } from '../src/app/common/saved-normal-document-coordinator';
import { AutoTagsSaveService } from '../src/app/components/tags-auto/tags-save.service';
import { ManualTagsService } from '../src/app/components/tags-manual/manual-tags.service';
import { MetaComponent } from '../src/app/components/meta/meta.component';
import { ClipComponent } from '../src/app/components/views/clip/clip.component';
import { ImageElementService } from '../src/app/services/image-element.service';
import { RendererMutationService } from '../src/app/services/renderer-mutation.service';

test('only callbacks from the current uninterrupted editing lifetime retain authority', () => {
  const lifetime = new RendererMutationLifetime();
  const before = lifetime.capture();
  assert.equal(lifetime.isCurrent(before), true);
  assert.equal(lifetime.isCurrent({} as RendererMutationToken), false);
  assert.equal(lifetime.isCurrent(new RendererMutationLifetime().capture()), false);
  const release = lifetime.freeze();
  assert.equal(lifetime.accepting, false);
  assert.equal(lifetime.capture(), undefined);
  assert.equal(lifetime.isCurrent(before), false);
  assert.throws(() => lifetime.assertAccepting(), /paused/);
  release();
  assert.equal(lifetime.accepting, true);
  assert.equal(lifetime.isCurrent(before), false);
  assert.equal(lifetime.isCurrent(lifetime.capture()), true);
});

test('drafts commit synchronously before sealing and contribute to the saved revision', () => {
  const lifetime = new RendererMutationLifetime();
  let text = 'unfinished';
  lifetime.registerDraftFlusher(() => {
    lifetime.assertAccepting();
    assert.equal(lifetime.capture(), undefined);
    assert.throws(() => lifetime.holdPending(), /paused/);
    text = 'committed';
    lifetime.changed();
  });
  const release = lifetime.freeze();
  assert.equal(text, 'committed');
  assert.equal(lifetime.revision, 1);
  assert.equal(lifetime.accepting, false);
  release();
});

test('pending native work refuses freeze without retiring its renderer callback', () => {
  const lifetime = new RendererMutationLifetime();
  const callback = lifetime.capture();
  const finishFirst = lifetime.holdPending();
  const finishSecond = lifetime.holdPending();
  let drafts = 0;
  lifetime.registerDraftFlusher(() => { drafts++; });
  assert.equal(lifetime.pendingCount, 2);
  assert.throws(() => lifetime.freeze(), /still completing/);
  assert.equal(drafts, 0);
  assert.equal(lifetime.isCurrent(callback), true);
  finishFirst();
  finishFirst();
  assert.equal(lifetime.pendingCount, 1);
  assert.throws(() => lifetime.freeze(), /still completing/);
  assert.equal(lifetime.isCurrent(callback), true);
  lifetime.changed(); // The durable response applies before its hold is released.
  finishSecond();
  assert.equal(lifetime.pendingCount, 0);
  lifetime.freeze()();
  assert.equal(drafts, 1);
  assert.equal(lifetime.revision, 1);
  assert.equal(lifetime.isCurrent(callback), false);
});

test('failed draft flush keeps partial committed edits and permanently retires old callbacks', () => {
  const lifetime = new RendererMutationLifetime();
  const callback = lifetime.capture();
  lifetime.registerDraftFlusher(() => { lifetime.changed(); });
  const removeFailure = lifetime.registerDraftFlusher(() => { throw new Error('Unfinished composition'); });
  assert.throws(() => lifetime.freeze(), /Unfinished composition/);
  assert.equal(lifetime.accepting, true);
  assert.equal(lifetime.revision, 1);
  assert.equal(lifetime.isCurrent(callback), false);
  removeFailure();
  lifetime.freeze()();
  assert.equal(lifetime.revision, 2);
});

test('asynchronous drafts cannot accidentally produce a saved snapshot', () => {
  const lifetime = new RendererMutationLifetime();
  lifetime.registerDraftFlusher(async () => undefined);
  assert.throws(() => lifetime.freeze(), /synchronously/);
  assert.equal(lifetime.accepting, true);
});

test('reentrant freeze, new editor registration and pending work are denied while flushing', () => {
  const lifetime = new RendererMutationLifetime();
  lifetime.registerDraftFlusher(() => {
    assert.throws(() => lifetime.freeze(), /already paused/);
    assert.throws(() => lifetime.registerDraftFlusher(() => undefined), /paused/);
    assert.throws(() => lifetime.holdPending(), /paused/);
  });
  const release = lifetime.freeze();
  assert.throws(() => lifetime.freeze(), /already paused/);
  assert.throws(() => lifetime.holdPending(), /paused/);
  assert.throws(() => lifetime.registerDraftFlusher(() => undefined), /paused/);
  release();
});

test('unregistered editors are not flushed and duplicate registrations have separate lifetimes', () => {
  const lifetime = new RendererMutationLifetime();
  let flushes = 0;
  const flush = () => { flushes++; };
  const removeFirst = lifetime.registerDraftFlusher(flush);
  lifetime.registerDraftFlusher(flush);
  removeFirst();
  removeFirst();
  lifetime.freeze()();
  assert.equal(flushes, 1);
});

test('an old idempotent release cannot thaw a later pause', () => {
  const lifetime = new RendererMutationLifetime();
  const firstRelease = lifetime.freeze();
  firstRelease();
  const secondRelease = lifetime.freeze();
  firstRelease();
  assert.equal(lifetime.accepting, false);
  secondRelease();
  assert.equal(lifetime.accepting, true);
});

test('quarantine permanently closes admission even when a saved release arrives later', () => {
  const lifetime = new RendererMutationLifetime();
  const token = lifetime.capture();
  const release = lifetime.freeze();
  lifetime.quarantine();
  release();
  assert.equal(lifetime.accepting, false);
  assert.equal(lifetime.capture(), undefined);
  assert.equal(lifetime.isCurrent(token), false);
  assert.throws(() => lifetime.freeze(), /already paused/);
  assert.throws(() => lifetime.holdPending(), /paused/);
  lifetime.changed();
  assert.equal(lifetime.revision, 1);
});

test('quarantine during draft flushing cannot be rolled back by freeze failure', () => {
  const lifetime = new RendererMutationLifetime();
  let nextFlushed = false;
  lifetime.registerDraftFlusher(() => { lifetime.quarantine(); });
  lifetime.registerDraftFlusher(() => { nextFlushed = true; });
  assert.throws(() => lifetime.freeze(), /paused/);
  assert.equal(nextFlushed, false);
  assert.equal(lifetime.accepting, false);
});

test('every dirty assignment advances revision, including edits while already dirty', () => {
  const lifetime = new RendererMutationService();
  const images = new ImageElementService(lifetime);
  const autoTags = new AutoTagsSaveService(lifetime);
  images.finalArrayNeedsSaving = true;
  images.finalArrayNeedsSaving = true;
  autoTags.needToSaveTags = true;
  autoTags.needToSaveTags = true;
  assert.equal(lifetime.revision, 4);
  images.finalArrayNeedsSaving = false;
  autoTags.markSaved();
  assert.equal(lifetime.revision, 4);
  assert.equal(images.finalArrayNeedsSaving, false);
  assert.equal(autoTags.needToSave(), false);
});

test('central video mutations are refused before any data changes while frozen', () => {
  const lifetime = new RendererMutationService();
  const images = new ImageElementService(lifetime);
  const image = NewImageElement();
  image.fileName = 'original.mp4';
  image.tags = ['Animals/Birds'];
  image.playlist = 123;
  image.stars = 2.5;
  image.timesPlayed = 4;
  images.imageElements = [image];
  const initial = JSON.stringify(images.imageElements);
  const release = lifetime.freeze();
  const edits = [
    () => images.HandleEmission({ index: 0, stars: 3.5 }),
    () => images.replaceFileNameInFinalArray('changed.mp4', 'original.mp4', 0),
    () => images.updateNumberOfTimesPlayed(0),
    () => images.resetTimesPlayed(),
    () => images.removeTagFromAll('Animals/Birds'),
    () => images.removeTagsFromAll(['Animals/Birds']),
    () => images.applyTagBranchRemovalPlan({ entries: [] } as any),
    () => images.applyTagBranchMovePlan({ entries: [] } as any),
    () => images.applyVideoTagBranchRemovalPlan(0, { removedTags: ['Animals/Birds'] } as any),
    () => images.toggleHeart(0),
    () => images.updatePlaylist(0),
    () => images.emptyPlaylist(),
  ];
  for (const edit of edits) {
    assert.throws(edit, /paused/);
    assert.equal(JSON.stringify(images.imageElements), initial);
    assert.equal(lifetime.revision, 0);
  }
  release();
  images.HandleEmission({ index: 0, stars: 3.5 });
  assert.equal(image.stars, 3.5);
  assert.equal(lifetime.revision, 1);
});

test('automatic tag edits and restore advance revision; save acknowledgement only clears dirtiness', () => {
  const lifetime = new RendererMutationService();
  const tags = new AutoTagsSaveService(lifetime);
  const source = ['Birds'];
  tags.restoreSavedTags(source, []);
  source.push('Not loaded');
  assert.deepEqual(tags.getAddTags(), ['Birds']);
  assert.equal(lifetime.revision, 1);
  assert.equal(tags.needToSave(), false);
  tags.addRemoveTag('Birds');
  tags.addAddTag('Trees');
  assert.equal(lifetime.revision, 3);
  assert.deepEqual(tags.getAddTags(), ['Trees']);
  assert.deepEqual(tags.getRemoveTags(), ['Birds']);
  const release = lifetime.freeze();
  assert.throws(() => tags.addAddTag('Frogs'), /paused/);
  assert.throws(() => tags.addRemoveTag('Trees'), /paused/);
  assert.throws(() => tags.restoreSavedTags([], []), /paused/);
  assert.equal(lifetime.revision, 3);
  tags.markSaved();
  assert.equal(tags.needToSave(), false);
  assert.deepEqual(tags.getAddTags(), ['Trees']);
  assert.equal(lifetime.revision, 3);
  release();
});

test('an unexpected direct dirty write during pause cannot be marked saved by the old snapshot', () => {
  const lifetime = new RendererMutationService();
  const images = new ImageElementService(lifetime);
  images.finalArrayNeedsSaving = true;
  const coordinator = new SavedNormalDocumentCoordinator({
    freeze: () => lifetime.freeze(),
    sessionIdentity: () => 'same catalogue',
    revisionIdentity: () => lifetime.revision,
    snapshot: () => null,
    markSaved: () => { images.finalArrayNeedsSaving = false; },
  }, { sendSnapshot: () => undefined });
  const id = randomUUID();
  assert.equal(coordinator.prepare(id), true);
  const snapshotRevision = lifetime.revision;
  images.finalArrayNeedsSaving = true;
  assert.equal(lifetime.revision, snapshotRevision + 1);
  assert.equal(coordinator.release(id, { saved: true }), true);
  assert.equal(images.finalArrayNeedsSaving, true);
  assert.equal(lifetime.accepting, true);
});

test('manual tag mutation entry points refuse writes while frozen without disrupting display reads', () => {
  const lifetime = new RendererMutationService();
  const tags = new ManualTagsService(lifetime);
  tags.loadTagDefinitions(['Animals > Birds']);
  tags.loadTagColors({ 'Animals > Birds': '#123456' });
  tags.addTag('Animals > Birds');
  const revision = lifetime.revision;
  const snapshot = () => JSON.stringify({
    definitions: tags.getTagDefinitions(),
    colors: tags.getTagColors(),
    frequencies: [...tags.tagsFrequencyMap],
  });
  const before = snapshot();
  const release = lifetime.freeze();
  const edits = [
    () => tags.addTag('New tag'),
    () => tags.removeTag('Animals > Birds'),
    () => tags.removeTagGlobally('Animals > Birds'),
    () => tags.removeAllTags(),
    () => tags.loadTagDefinitions([]),
    () => tags.addTagDefinition('New definition'),
    () => tags.removeTagDefinitions(['Animals > Birds']),
    () => tags.removeTagDefinitionBranch('Animals'),
    () => tags.replaceTagDefinitions([]),
    () => tags.populateManualTagsService([]),
    () => tags.rebuildFromImages([]),
    () => tags.setTagColor('Animals > Birds', '#654321'),
    () => tags.loadTagColors({}),
    () => tags.replaceTagColors({}),
  ];
  for (const edit of edits) {
    assert.throws(edit, /paused/);
    assert.equal(snapshot(), before);
    assert.equal(lifetime.revision, revision);
  }
  assert.equal(tags.getTypeahead('Bird'), 'Animals > Birds');
  assert.equal(tags.getTagColor('Animals > Birds'), '#123456');
  assert.equal(tags.hasTagDefinition('Animals > Birds'), true);
  release();
  tags.addTagDefinition('Trees');
  assert.equal(tags.hasTagDefinition('Trees'), true);
  assert.ok(lifetime.revision > revision);
});

test('manual tag persistence notifications and revision tracking both survive repeated edits', () => {
  const lifetime = new RendererMutationService();
  const tags = new ManualTagsService(lifetime);
  let definitionsChanged = 0;
  let colorsChanged = 0;
  tags.tagDefinitionsPersistenceChangedSubject.subscribe(() => definitionsChanged++);
  tags.tagColorPersistenceChangedSubject.subscribe(() => colorsChanged++);
  tags.addTagDefinition('Animals');
  tags.addTagDefinition('Plants');
  tags.setTagColor('Animals', '#123456');
  tags.setTagColor('Animals', '#654321');
  assert.equal(definitionsChanged, 2);
  assert.equal(colorsChanged, 2);
  assert.equal(lifetime.revision, 4);
});

function metaHarness() {
  const mutations = new RendererMutationService();
  const images = new ImageElementService(mutations);
  const manualTags = new ManualTagsService(mutations);
  const sends: unknown[][] = [];
  const video = NewImageElement();
  video.fileName = 'original.mp4';
  video.cleanName = 'original';
  video.notes = 'Existing notes';
  video.tags = ['Birds'];
  images.imageElements = [video];
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new MetaComponent(
    { detectChanges: () => undefined } as any,
    { ipcRenderer: { send: (...args: unknown[]) => sends.push(args) } } as any,
    { getFileNameExtension: () => 'mp4' } as any,
    images,
    manualTags,
    mutations,
  ));
  component.video = video;
  return { mutations, images, manualTags, video, component, sends };
}

test('Video Inspector notes and setters cannot mutate the saved model while paused', () => {
  const h = metaHarness();
  h.component.renamingWIP = 'new title';
  const before = JSON.stringify(h.video);
  const release = h.mutations.freeze();
  h.component.saveVideoNotes('Late notes');
  h.component.addThisTag('Trees');
  h.component.removeThisTag('Birds');
  h.component.removeDisplayedTag('Birds');
  h.component.setStarRating(4.5);
  h.component.setHeart();
  h.component.setYear(2026);
  h.component.validateYear({ target: { valueAsNumber: 2026 } });
  h.component.autoFillYear();
  h.component.tryRenamingFile();
  assert.equal(JSON.stringify(h.video), before);
  assert.equal(h.mutations.revision, 0);
  assert.deepEqual(h.sends, []);
  release();
  h.component.saveVideoNotes('Saved after resume');
  h.component.saveVideoNotes('A further change while already dirty');
  assert.equal(h.video.notes, 'A further change while already dirty');
  assert.equal(h.mutations.revision, 2);
  h.component.ngOnDestroy();
  h.component.saveVideoNotes('Destroyed editor callback');
  assert.equal(h.video.notes, 'A further change while already dirty');
});

test('Video Inspector delayed focus cannot regain authority after freeze and resume', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = metaHarness();
  let selected = 0;
  Object.defineProperty(h.component, 'yearInput', {
    value: () => ({ nativeElement: { select: () => selected++ } }),
  });
  h.component.autoFillYear();
  assert.equal(h.video.year, 2000);
  h.mutations.freeze()();
  t.mock.timers.tick(1);
  assert.equal(selected, 0);
  h.component.yearHack = undefined;
  h.component.autoFillYear();
  t.mock.timers.tick(1);
  assert.equal(selected, 1);
  h.component.yearHack = undefined;
  h.component.autoFillYear();
  h.component.ngOnDestroy();
  t.mock.timers.tick(1);
  assert.equal(selected, 1);
});

function clipHarness(play: () => Promise<void> = () => Promise.resolve()) {
  const mutations = new RendererMutationService();
  const component = runInInjectionContext(Injector.create({ providers: [] }), () => new ClipComponent(
    undefined, undefined, undefined, undefined, mutations,
  ));
  let plays = 0;
  let loads = 0;
  let pauses = 0;
  const preview = {
    isConnected: true,
    muted: true,
    play: () => { plays++; return play(); },
    load: () => { loads++; },
    pause: () => { pauses++; },
  };
  const event = { currentTarget: preview, target: preview } as unknown as Event;
  return { component, mutations, preview, event, plays: () => plays, loads: () => loads, pauses: () => pauses };
}

test('clip autoplay keeps one timer per element and ordinary preview playback still works', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = clipHarness();
  h.component.startAutoplayPreview(h.event);
  h.component.startAutoplayPreview(h.event);
  t.mock.timers.tick(500);
  assert.equal(h.plays(), 1);
  h.component.playPreview(h.event);
  assert.equal(h.plays(), 2);
});

test('scheduled clip autoplay cannot cross a pause or component destruction', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = clipHarness();
  h.component.startAutoplayPreview(h.event);
  const release = h.mutations.freeze();
  h.component.startAutoplayPreview(h.event);
  h.component.playPreview(h.event);
  assert.equal(h.plays(), 0);
  release();
  t.mock.timers.tick(500);
  assert.equal(h.plays(), 0);
  h.component.startAutoplayPreview(h.event);
  t.mock.timers.tick(500);
  assert.equal(h.plays(), 1);
  h.component.startAutoplayPreview(h.event);
  h.component.ngOnDestroy();
  t.mock.timers.tick(500);
  h.component.playPreview(h.event);
  assert.equal(h.plays(), 1);
});

test('detached clip elements cannot start or reload previews', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = clipHarness();
  h.component.startAutoplayPreview(h.event);
  h.preview.isConnected = false;
  t.mock.timers.tick(500);
  h.component.playPreview(h.event);
  h.component.startAutoplayPreview(h.event);
  h.component.stopPreview(h.event);
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(h.plays(), 0);
  assert.equal(h.loads(), 0);
  assert.equal(h.pauses(), 1);
});

test('failed clip playback retries only within the same live editing epoch', async () => {
  const normal = clipHarness(() => Promise.reject(new Error('Preview not ready')));
  normal.component.playPreview(normal.event);
  await Promise.resolve();
  assert.equal(normal.loads(), 1);

  for (const state of ['paused', 'resumed', 'destroyed', 'detached'] as const) {
    let reject: (reason: Error) => void;
    const h = clipHarness(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    h.component.playPreview(h.event);
    if (state === 'paused') { h.mutations.freeze(); }
    if (state === 'resumed') { h.mutations.freeze()(); }
    if (state === 'destroyed') { h.component.ngOnDestroy(); }
    if (state === 'detached') { h.preview.isConnected = false; }
    reject(new Error('Late preview failure'));
    await Promise.resolve();
    assert.equal(h.loads(), 0, state);
  }
});

test('a play promise resolving after pause is stopped rather than resuming old media', async () => {
  let resolve: () => void;
  const h = clipHarness(() => new Promise<void>((done) => { resolve = done; }));
  h.component.playPreview(h.event);
  h.mutations.freeze()();
  resolve();
  await Promise.resolve();
  assert.equal(h.pauses(), 1);
});

test('stopping or unmuting clips while paused cannot reload or enable sound', () => {
  const h = clipHarness();
  Object.defineProperty(h.component, 'defaultThumbnailMode', { value: () => true });
  Object.defineProperty(h.component, 'returnToFirstScreenshot', { value: () => true });
  h.component.stopPreview(h.event);
  assert.equal(h.loads(), 1);
  const release = h.mutations.freeze();
  h.component.stopPreview(h.event);
  h.component.unmutePreview(h.event);
  assert.equal(h.loads(), 1);
  assert.equal(h.pauses(), 1);
  assert.equal(h.preview.muted, true);
  release();
  h.component.unmutePreview(h.event);
  assert.equal(h.preview.muted, false);
});
