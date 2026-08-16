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
