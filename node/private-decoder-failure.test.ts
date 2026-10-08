import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { NewImageElement, type FinalObject, type ScreenshotSettings } from '../interfaces/final-object.interface';
import { getMediaToolPath } from './media-tool-paths';
import { setPrivateCustomThumbnail } from './private-custom-thumbnail';
import { readPrivateHubCatalogue, readPrivateHubPreview, writePrivateHubCatalogue } from './private-hub-catalogue';
import { generatePrivateHubPreviews } from './private-hub-preview-generation';
import { readPrivatePreviewSet } from './private-hub-preview-set';
import { PrivateHubStore } from './private-hub-store';
import { capturePrivatePreviewSource } from './private-preview-source';
import { validatePrivateJpeg } from './private-preview-plan';
import { readPrivateThumbnailOverride } from './private-thumbnail-override';

const cwd = path.resolve(__dirname, '..');
const password = 'Synthetic native decoder failure passphrase';
const canary = 'PRIVATE_NATIVE_DECODER_FAILURE';
const settings: ScreenshotSettings = { height: 144, clipHeight: 144, fixed: true, n: 3, clipSnippets: 2, clipSnippetLength: 1 };
const generationError = { name: 'Error', message: 'Private preview generation could not be completed.' };
const thumbnailError = { name: 'Error', message: 'The private thumbnail could not be updated.' };
const nativeOptions = { skip: process.platform === 'win32', timeout: 30_000 };

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(accept => { resolve = accept; }), resolve: () => resolve() };
}
async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native test checkpoint timed out.')), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
function png(): Buffer {
  const chunk = (type: string, bytes: Buffer): Buffer => {
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length); result.write(type, 4, 4, 'ascii'); bytes.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 128, 128]))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(t: TestContext) {
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    assert.ok(fs.realpathSync(getMediaToolPath(tool)).startsWith(fs.realpathSync(cwd) + path.sep), 'Use workspace media tools only.');
  }
  const root = await fs.promises.mkdtemp(path.join(cwd, 'tmp/private-decoder-failure-'));
  const videoPath = path.join(root, `${canary}.mp4`);
  const imagePath = path.join(root, `${canary}.png`);
  const jpegPath = path.join(root, `${canary}.jpg`);
  const directory = path.join(root, 'hub');
  const video = childProcess.spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', videoPath],
  { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(video.status, 0, video.stderr.toString());
  const jpeg = childProcess.spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=teal:size=256x144', '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
  { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(jpeg.status, 0, jpeg.stderr.toString());
  await fs.promises.writeFile(imagePath, png()); await fs.promises.writeFile(jpegPath, jpeg.stdout);
  const originals = await Promise.all([videoPath, imagePath, jpegPath].map(file => fs.promises.readFile(file)));
  const store = await PrivateHubStore.create(directory, password);
  const capture = (file: string) => capturePrivatePreviewSource({ hash: 'video-1', root, partialPath: '', fileName: path.basename(file),
    inputSource: 0, isCurrent: location => location.root === root && location.fileName === path.basename(file) });
  const source = await capture(videoPath); const image = await capture(imagePath); const still = await capture(jpegPath);
  t.after(async () => {
    await Promise.all([source.close(), image.close(), still.close()]); await store.lock();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const catalogue: FinalObject = {
    addTags: [], removeTags: [], hubName: canary, images: [{ ...NewImageElement(), hash: source.hash,
      fileName: path.basename(videoPath), notes: canary, tags: ['Retained tag'], timesPlayed: 3, lastPlayed: 123456, screens: 3 }],
    inputDirs: { 0: { path: root, watch: false } }, numOfFolders: 1, screenshotSettings: settings, version: 3,
  };
  await writePrivateHubCatalogue(store, catalogue);
  const originalSet = await generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true });
  const originalOverride = await setPrivateCustomThumbnail(store, still, 144, { isCurrent: () => true });
  const previews = await Promise.all((['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const)
    .map(kind => readPrivateHubPreview(store, kind, source.hash)));
  const sealed = await Promise.all((await fs.promises.readdir(directory)).filter(name => name.endsWith('.sealed') || name.endsWith('.sealed.bak'))
    .map(async name => ({ name, bytes: await fs.promises.readFile(path.join(directory, name)) })));
  const assertRetained = async (reader = store): Promise<void> => {
    for (const record of sealed) { assert.deepEqual(await fs.promises.readFile(path.join(directory, record.name)), record.bytes); }
    assert.deepEqual(await readPrivateHubCatalogue(reader), catalogue);
    assert.deepEqual(await readPrivatePreviewSet(reader, source.hash), originalSet);
    assert.deepEqual(await readPrivateThumbnailOverride(reader, source.hash), originalOverride);
    for (const [index, kind] of (['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const).entries()) {
      const bytes = await readPrivateHubPreview(reader, kind, source.hash);
      try { assert.deepEqual(bytes, previews[index]); } finally { bytes.fill(0); }
    }
  };
  const assertOriginals = async (): Promise<void> => {
    for (const [index, file] of [videoPath, imagePath, jpegPath].entries()) {
      assert.deepEqual(await fs.promises.readFile(file), originals[index]);
    }
    assert.deepEqual((await fs.promises.readdir(root)).sort(), [path.basename(jpegPath), path.basename(videoPath), path.basename(imagePath), 'hub'].sort());
    for (const name of await fs.promises.readdir(directory)) {
      const bytes = await fs.promises.readFile(path.join(directory, name));
      assert.equal(bytes.includes(canary), false, 'The failed operation must not expose source names or catalogue notes.');
    }
  };
  t.after(() => { for (const bytes of [...originals, ...previews]) { bytes.fill(0); } });
  return { root, source, image, still, store, directory, videoPath, imagePath, jpegPath, catalogue, originalSet,
    originalOverride, assertRetained, assertOriginals };
}

/** Only children returned by this test's real spawn are signalled. Suspending
 * immediately keeps even tiny fixtures active until the explicit failure. */
function interruptNativeChild(t: TestContext, sourcePaths: readonly string[], select: (tool: string, args: readonly string[]) => boolean) {
  const spawn = childProcess.spawn;
  const open = fs.promises.open;
  const selected = deferred(); const nested = deferred(); const written = deferred();
  const handles: FileHandle[] = []; const writes: Buffer[] = [];
  const children: { child: childProcess.ChildProcess; closed: boolean; closure: Promise<void>; fd?: number }[] = [];
  let target: typeof children[number] | undefined;
  let nestedTarget: typeof children[number] | undefined;
  const suspend = (entry: typeof children[number], executable: string): void => {
    assert.ok(Number.isInteger(entry.child.pid) && entry.child.pid! > 1 && entry.child.pid !== process.pid);
    assert.equal(entry.child.spawnfile, executable);
    assert.equal(entry.child.kill('SIGSTOP'), true);
  };
  const opened = t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    if (sourcePaths.includes(String(args[0]))) { handles.push(handle); }
    return handle;
  });
  const spawned = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const tool = String(args[0]); const arguments_ = args[1] as string[];
    assert.ok(tool === getMediaToolPath('ffmpeg') || tool === getMediaToolPath('ffprobe'));
    assert.equal(JSON.stringify(arguments_).includes(canary), false);
    const child = spawn(...args);
    const closed = deferred();
    const entry = { child, closed: false, closure: closed.promise,
      fd: (args[2] as childProcess.SpawnOptions).stdio?.[3] as number | undefined };
    children.push(entry);
    child.once('close', () => { entry.closed = true; closed.resolve(); });
    // Install observation before returning to the production runner; no input,
    // output, encoder implementation, or production lifecycle is replaced.
    if (!target && select(tool, arguments_)) {
      target = entry;
      suspend(entry, tool);
      if (child.stdin) {
        const input = child.stdin; const write = input.write.bind(input);
        t.mock.method(input, 'write', (bytes: Buffer, callback: (error?: Error | null) => void) => {
          writes.push(bytes); written.resolve(); return write(bytes, callback);
        });
      }
      selected.resolve();
    } else if (target && !nestedTarget && typeof entry.fd === 'number') {
      // The nested producer must also remain alive. Killing its assembler
      // must cancel and reap this suspended child through production cleanup.
      nestedTarget = entry; suspend(entry, tool); nested.resolve();
    }
    return child;
  });
  const dispose = async (): Promise<void> => {
    for (const entry of children) {
      if (!entry.closed && entry.child.exitCode === null && entry.child.signalCode === null) { entry.child.kill('SIGKILL'); }
    }
    await within(Promise.all(children.map(entry => entry.closure)));
    spawned.mock.restore(); opened.mock.restore();
  };
  t.after(dispose);
  return {
    children, handles, writes, ready: () => within(selected.promise), nested: () => within(nested.promise), inputWritten: () => within(written.promise),
    kill: () => { assert.ok(target && !target.closed); assert.equal(target.child.kill('SIGKILL'), true); },
    assertDrained: () => {
      assert.ok(target?.closed, 'The selected native child must close before operation rejection.');
      assert.equal(target.child.signalCode, 'SIGKILL');
      if (nestedTarget) {
        assert.ok(['SIGTERM', 'SIGKILL'].includes(nestedTarget.child.signalCode!), 'Cancellation must terminate and reap the suspended nested producer.');
      }
      assert.ok(children.every(entry => entry.closed), 'Every nested child must close before admission reopens.');
      assert.ok(handles.length > 0); assert.ok(handles.every(handle => handle.fd === -1), 'Every source lease must close.');
      for (const entry of children) {
        if (typeof entry.fd === 'number') { assert.throws(() => fs.fstatSync(entry.fd!), { code: 'EBADF' }); }
      }
      for (const bytes of writes) { assert.ok(bytes.every(byte => byte === 0), 'Runner-owned stdin copies must be wiped.'); }
    },
    dispose,
  };
}

for (const stage of ['probe', 'thumbnail', 'filmstrip', 'clip remux'] as const) {
  test(`real ${stage} termination drains all native children and preserves the previous encrypted hub`, nativeOptions, async t => {
    const f = await fixture(t);
    const interrupted = interruptNativeChild(t, [f.videoPath], (tool, args) => {
      if (stage === 'probe') { return tool === getMediaToolPath('ffprobe'); }
      if (tool !== getMediaToolPath('ffmpeg')) { return false; }
      if (stage === 'thumbnail') { return args.includes('fd:'); }
      if (stage === 'filmstrip') { return args.some(argument => argument.includes('tile=')); }
      return args.includes('-movflags');
    });
    let settled = false;
    const pending = generatePrivateHubPreviews(f.store, f.source, settings, { isCurrent: () => true });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, generationError);
    try {
      await interrupted.ready();
      if (stage === 'filmstrip' || stage === 'clip remux') { await interrupted.nested(); }
      assert.equal(settled, false);
      await assert.rejects(generatePrivateHubPreviews(f.store, f.source, settings, { isCurrent: () => true }), generationError);
      interrupted.kill(); await rejected; interrupted.assertDrained();
      await interrupted.dispose(); await f.assertRetained(); await f.assertOriginals();
      await f.store.lock();
      const reopened = await PrivateHubStore.open(f.directory, password);
      try {
        await f.assertRetained(reopened);
        const retry = await generatePrivateHubPreviews(reopened, f.source, settings, { isCurrent: () => true });
        assert.notEqual(retry.generation, f.originalSet.generation);
        assert.deepEqual(await readPrivatePreviewSet(reopened, f.source.hash), retry);
        assert.deepEqual(await readPrivateHubCatalogue(reopened), f.catalogue);
        const thumbnail = await readPrivateHubPreview(reopened, 'thumbnail', f.source.hash);
        try { validatePrivateJpeg(thumbnail, 256, 144); } finally { thumbnail.fill(0); }
      } finally { await reopened.lock(); }
      await f.assertOriginals();
    } finally { await interrupted.dispose(); await pending.catch(() => undefined); }
  });
}

for (const format of ['PNG', 'JPEG'] as const) {
  test(`real ${format} custom-thumbnail decoder termination retains the previous override and permits retry`, nativeOptions, async t => {
    const f = await fixture(t);
    const source = format === 'PNG' ? f.image : f.still;
    const interrupted = interruptNativeChild(t, [format === 'PNG' ? f.imagePath : f.jpegPath], tool => tool === getMediaToolPath('ffmpeg'));
    let settled = false;
    const pending = setPrivateCustomThumbnail(f.store, source, 144, { isCurrent: () => true });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(pending, thumbnailError);
    try {
      await interrupted.ready();
      if (format === 'PNG') { await interrupted.inputWritten(); assert.ok(interrupted.writes.length > 0); }
      assert.equal(settled, false);
      await assert.rejects(setPrivateCustomThumbnail(f.store, source, 144, { isCurrent: () => true }), thumbnailError);
      interrupted.kill(); await rejected; interrupted.assertDrained();
      await interrupted.dispose(); await f.assertRetained(); await f.assertOriginals();
      await f.store.lock();
      const reopened = await PrivateHubStore.open(f.directory, password);
      try {
        await f.assertRetained(reopened);
        const replacement = await setPrivateCustomThumbnail(reopened, source, 144, { isCurrent: () => true });
        assert.notEqual(replacement.generation, f.originalOverride.generation);
        assert.deepEqual(await readPrivateThumbnailOverride(reopened, source.hash), replacement);
        assert.deepEqual(await readPrivatePreviewSet(reopened, source.hash), f.originalSet);
        assert.deepEqual(await readPrivateHubCatalogue(reopened), f.catalogue);
        const thumbnail = await readPrivateHubPreview(reopened, 'thumbnail', source.hash);
        try { validatePrivateJpeg(thumbnail, 256, 144); } finally { thumbnail.fill(0); }
      } finally { await reopened.lock(); }
      await f.assertOriginals();
    } finally { await interrupted.dispose(); await pending.catch(() => undefined); }
  });
}
