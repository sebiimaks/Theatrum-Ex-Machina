import '@angular/compiler';
import { computed, Injector, runInInjectionContext } from '@angular/core';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { ImageElement } from '../interfaces/final-object.interface';
import { FilePathService } from '../src/app/components/views/file-path.service';
import { ThumbnailComponent } from '../src/app/components/views/thumbnail/thumbnail.component';
import { ClipComponent } from '../src/app/components/views/clip/clip.component';
import { RendererMutationService } from '../src/app/services/renderer-mutation.service';

function withNativePreviews(run: (paths: FilePathService) => void): void {
  const previousBridge = Object.getOwnPropertyDescriptor(globalThis, 'theatrum');
  Object.defineProperty(globalThis, 'theatrum', {
    configurable: true,
    value: { isElectron: true },
  });
  try {
    run(new FilePathService(undefined));
  } finally {
    if (previousBridge) {
      Object.defineProperty(globalThis, 'theatrum', previousBridge);
    } else {
      Reflect.deleteProperty(globalThis, 'theatrum');
    }
  }
}

function video(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    hash: 'new-video',
    uuid: 'stable-entry-id',
    screens: 5,
    defaultScreen: 2,
    selected: true,
    ...overrides,
  } as ImageElement;
}

test('completed extraction retries thumbnail and filmstrip URLs on the same selected card', () => {
  withNativePreviews((paths) => {
    const card = runInInjectionContext(Injector.create({ providers: [] }), () => (
      new ThumbnailComponent(paths, undefined)
    ));
    const item = video();
    card.video = item;
    card.ngOnInit();
    const earlyThumbnail = card.firstFilePath();
    const earlyFilmstrip = card.fullFilePath();

    // These initial requests can fail before extraction has published files.
    // Completion must assign new URLs, while keeping the card and entry alive.
    paths.refreshGeneratedPreviews();
    assert.notEqual(card.firstFilePath(), earlyThumbnail);
    assert.notEqual(card.fullFilePath(), earlyFilmstrip);
    assert.equal(new URL(card.firstFilePath()).pathname, new URL(earlyThumbnail).pathname);
    assert.equal(new URL(card.fullFilePath()).pathname, new URL(earlyFilmstrip).pathname);
    assert.equal(card.folderThumbPaths()[0], card.firstFilePath());
    assert.equal(card.video, item);
    assert.equal(item.uuid, 'stable-entry-id');
    assert.equal(item.selected, true);
    assert.equal(card.hover, true);
    assert.equal(card.percentOffset, 40);
    assert.equal(card.defaultScreenOffset({ ...item, defaultScreen: 0 }), 0);

    const firstCompletedUrl = card.firstFilePath();
    paths.refreshGeneratedPreviews();
    assert.notEqual(card.firstFilePath(), firstCompletedUrl);
  });
});

test('folder thumbnails and clip previews retry every visible child after extraction', () => {
  withNativePreviews((paths) => {
    const injector = Injector.create({ providers: [] });
    const thumbnail = runInInjectionContext(injector, () => new ThumbnailComponent(paths, undefined));
    const clip = runInInjectionContext(injector, () => new ClipComponent(
      undefined, paths, undefined, undefined, new RendererMutationService(),
    ));
    const folder = video({ hash: 'first:second:third:fourth:fifth' });
    thumbnail.video = folder;
    clip.video = folder;
    const before = [
      ...thumbnail.folderThumbPaths(),
      ...clip.folderThumbPaths(),
      ...clip.folderPosterPaths(),
    ];
    assert.equal(before.length, 12);

    paths.refreshGeneratedPreviews();
    const after = [
      ...thumbnail.folderThumbPaths(),
      ...clip.folderThumbPaths(),
      ...clip.folderPosterPaths(),
    ];
    after.forEach((url, index) => {
      assert.notEqual(url, before[index]);
      assert.equal(new URL(url).pathname, new URL(before[index]).pathname);
    });
  });
});

test('clip video and poster recover without resetting hover or autoplay state', () => {
  withNativePreviews((paths) => {
    const clip = runInInjectionContext(Injector.create({ providers: [] }), () => (
      new ClipComponent(undefined, paths, undefined, undefined, new RendererMutationService())
    ));
    clip.video = video();
    clip.ngOnInit();
    clip.hover = true;
    const earlyVideo = clip.pathToVideo();
    const earlyPoster = clip.poster();

    paths.refreshGeneratedPreviews();
    assert.notEqual(clip.pathToVideo(), earlyVideo);
    assert.notEqual(clip.poster(), earlyPoster);
    assert.equal(clip.noError, true);
    assert.equal(clip.hover, true);
    assert.equal(clip.appInFocus, true);
  });
});

test('local preview URLs react to completion while retaining escaped paths and cover versions', () => {
  const paths = new FilePathService(undefined);
  const url = computed(() => paths.createFilePath('/catalogues', 'A (B)', 'thumbnails', 'hash', false, 'cover-v2'));
  const before = url();
  paths.refreshGeneratedPreviews();
  assert.notEqual(url(), before);
  assert.equal(new URL(url()).pathname, new URL(before).pathname);
  assert.match(new URL(url()).searchParams.get('v'), /^cover-v2:import-/);
});
