import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { test } from 'node:test';

import {
  calculateFullViewLayout,
  getVirtualScrollBufferAmount,
} from '../src/app/common/virtual-scroll-layout';

test('buffers variable-height full view without changing fixed-row views', () => {
  assert.equal(getVirtualScrollBufferAmount('showFullView'), 5);
  assert.equal(getVirtualScrollBufferAmount('showDetails'), 0);
  assert.equal(getVirtualScrollBufferAmount('showDetails2'), 0);
  assert.equal(getVirtualScrollBufferAmount('showThumbnails'), 0);
});

test('full view produces stable row offsets for mixed screenshot counts', () => {
  const layout = calculateFullViewLayout(800, 100, 10);

  assert.deepEqual(layout.rowOffsets, [0, 4, 8]);
  assert.ok(layout.computedWidth > 700 && layout.computedWidth < 800);
});

test('full view advances rows even when only one screenshot fits', () => {
  const layout = calculateFullViewLayout(100, 100, 3);

  assert.deepEqual(layout.rowOffsets, [0, 1, 2]);
});

test('full view rejects transient invalid geometry instead of emitting NaN dimensions', () => {
  assert.deepEqual(calculateFullViewLayout(undefined as any, 100, 10), {
    computedWidth: 0,
    rowOffsets: [],
  });
  assert.deepEqual(calculateFullViewLayout(800, 0, 10), {
    computedWidth: 0,
    rowOffsets: [],
  });
});

test('virtual-scroller content contains no decorative spacer masquerading as an item', () => {
  const template = readFileSync(
    join(__dirname, '../src/app/components/home.component.html'),
    'utf8',
  );

  assert.equal(template.includes('bottom-of-scroller-spacer'), false);
});

test('recycled detail rows do not steal focus through their tag input', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/tags-manual/add-tag.component.ts'),
    'utf8',
  );

  assert.equal(component.includes('nativeElement.focus()'), false);
});

test('the Details tray forwards thumbnail right-clicks to the context menu', () => {
  const template = readFileSync(
    join(__dirname, '../src/app/components/home.component.html'),
    'utf8',
  );
  const detailsTrayStart = template.indexOf("@if (settingsButtons['showDetailsTray'].toggled)");

  assert.notEqual(detailsTrayStart, -1);
  assert.match(
    template.slice(detailsTrayStart),
    /<app-thumbnail\s+[\s\S]*?\(rightClick\)="rightMouseClicked\(\$event\.mouseEvent, \$event\.item\)"/,
  );
});

test('synthetic folder rows carry playback sort metadata and a distinct identity', () => {
  const pipe = readFileSync(
    join(__dirname, '../src/app/pipes/folder-view.pipe.ts'),
    'utf8',
  );

  assert.match(
    pipe,
    /lastPlayed\s*=\s*Math\.max\(lastPlayed, Number\(element\.lastPlayed\) \|\| 0\)/,
  );
  assert.match(
    pipe,
    /timesPlayed\s*=\s*Math\.max\(timesPlayed, Number\(element\.timesPlayed\) \|\| 0\)/,
  );
  assert.match(pipe, /folderWithStuff\.lastPlayed\s*=\s*folderProperties\.lastPlayed/);
  assert.match(pipe, /folderWithStuff\.timesPlayed\s*=\s*folderProperties\.timesPlayed/);
  assert.match(pipe, /const uuid = `folder:\$\{files\[0\]\.uuid\}`/);
});

test('the app does not override Electron built-in file protocol handling', () => {
  const mainProcess = readFileSync(join(__dirname, '../main.ts'), 'utf8');

  assert.equal(mainProcess.includes("registerFileProtocol('file'"), false);
});

test('gallery width changes settle before virtual-scroll geometry is refreshed', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const afterViewInit = component.slice(
    component.indexOf('ngAfterViewInit()'),
    component.indexOf('ngOnDestroy(): void'),
  );
  const onDestroy = component.slice(
    component.indexOf('ngOnDestroy(): void'),
    component.indexOf('/**\n   * Tell Electron to drag'),
  );

  assert.match(afterViewInit, /new ResizeObserver/);
  assert.match(afterViewInit, /Math\.abs\(width - this\.observedGalleryWidth\) < 0\.5/);
  assert.match(
    afterViewInit,
    /this\.observedGalleryWidth = width;\s*this\.scheduleGalleryLayoutRefresh\(GALLERY_RESIZE_SETTLE_MS\)/,
  );
  assert.match(onDestroy, /this\.galleryResizeObserver\?\.disconnect\(\)/);
  assert.match(onDestroy, /clearTimeout\(this\.galleryLayoutRefreshTimeout\)/);
  assert.match(onDestroy, /cancelAnimationFrame\(this\.galleryLayoutRefreshFrame\)/);
});

test('restored compact layout renders before measurement and stabilizes after catalogue load', () => {
  const component = readFileSync(
    join(__dirname, '../src/app/components/home.component.ts'),
    'utf8',
  );
  const restoreStart = component.indexOf('restoreSettingsFromBefore(settingsObject: SettingsObject)');
  const restoreEnd = component.indexOf('/**\n   * Restore the language', restoreStart);
  const restore = component.slice(restoreStart, restoreEnd);
  const finalObjectStart = component.indexOf("ipcRenderer.on('final-object-returning'");
  const finalObjectEnd = component.indexOf('// If no previously saved settings exist', finalObjectStart);
  const finalObject = component.slice(finalObjectStart, finalObjectEnd);

  const firstRender = restore.indexOf('this.cd.detectChanges();');
  const firstMeasure = restore.indexOf('this.computeTextBufferAmount();');
  assert.ok(firstRender >= 0 && firstRender < firstMeasure);
  assert.match(
    restore,
    /showTagTray'\]\.toggled = true;[^}]*this\.cd\.detectChanges\(\);[^}]*this\.scheduleGalleryLayoutRefresh\(GALLERY_LAYOUT_TRANSITION_MS\)/s,
  );
  assert.match(
    finalObject,
    /this\.cd\.detectChanges\(\);\s*this\.scheduleGalleryLayoutRefresh\(GALLERY_LAYOUT_TRANSITION_MS\);\s*this\.markRendererStartupComplete\(\)/,
  );
});
