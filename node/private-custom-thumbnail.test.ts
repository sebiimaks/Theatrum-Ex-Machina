import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';
import { PrivateHubStore } from './private-hub-store';
import { readPrivateHubPreview, writePrivateHubPreview } from './private-hub-catalogue';
import { capturePrivatePreviewSource } from './private-preview-source';
import { getMediaToolPath } from './media-tool-paths';
import { privateThumbnailInputCodec, stripPrivateThumbnailMetadata, setPrivateCustomThumbnail } from './private-custom-thumbnail';
import { readPrivateThumbnailOverride, privateThumbnailOverrideRecordId } from './private-thumbnail-override';
import { validatePrivateJpeg } from './private-preview-plan';
import { generatePrivateHubPreviews } from './private-hub-preview-generation';
import * as mediaProcess from './private-media-process';

const cwd = path.resolve(__dirname, '..');
const marker = 'PRIVATE_CUSTOM_THUMBNAIL_METADATA';
function jpegHeader(width: number, height: number): Buffer {
  const bytes = Buffer.from('ffd8ffc00011080000000003012200021101031101ffda000c03010002110311003f00', 'hex');
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes;
}
async function fixture(t: TestContext, png?: Buffer) {
  const root = await fs.mkdtemp(path.join(cwd, 'tmp/private-custom-thumbnail-'));
  const result = childProcess.spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=teal:size=256x144', '-frames:v', '1', '-threads', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
  { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  const metadata = Buffer.from(marker); const app = Buffer.alloc(metadata.length + 4);
  app.writeUInt16BE(0xffe1, 0); app.writeUInt16BE(metadata.length + 2, 2); metadata.copy(app, 4);
  const input = png ? Buffer.from(png) : Buffer.concat([result.stdout.subarray(0, 2), app, result.stdout.subarray(2)]);
  const file = path.join(root, marker + (png ? '.png' : '.jpg')); await fs.writeFile(file, input);
  const store = await PrivateHubStore.create(path.join(root, 'hub'), 'Synthetic custom thumbnail password');
  const controller = new AbortController();
  const source = await capturePrivatePreviewSource({ hash: 'video', root, partialPath: '', fileName: path.basename(file),
    inputSource: 0, signal: controller.signal, isCurrent: () => true });
  t.after(async () => { await source.close(); await store.lock(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, source, controller, file, input, output: result.stdout };
}
test('JPEG header accepts bounded baseline/progressive inputs before any decoder', () => {
  const bytes = jpegHeader(4000, 8000);
  assert.equal(privateThumbnailInputCodec(bytes, bytes.length), 'mjpeg');
  bytes[3] = 0xc2;
  assert.equal(privateThumbnailInputCodec(bytes, bytes.length), 'mjpeg');
});
for (const [width, height] of [[16385, 1], [1, 16385], [8000, 4001], [0, 100]]) {
  test(`JPEG geometry ${width}x${height} is rejected before decode`, () => {
    const bytes = jpegHeader(width, height); assert.throws(() => privateThumbnailInputCodec(bytes, bytes.length));
  });
}
test('malformed PNG, forged signatures, truncated header and oversized input/header are refused', () => {
  for (const bytes of [Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100000000000000000000000', 'hex'),
    Buffer.alloc(100), jpegHeader(10, 10).subarray(0, 15), Buffer.alloc(256 * 1024 + 1)]) {
    assert.throws(() => privateThumbnailInputCodec(bytes, bytes.length));
  }
  const jpeg = jpegHeader(10, 10);
  assert.throws(() => privateThumbnailInputCodec(jpeg, 32 * 1024 * 1024 + 1));
});
test('conflicting and unsupported frame headers are rejected before the first scan', () => {
  const small = jpegHeader(10, 10); const large = jpegHeader(16385, 100);
  const duplicate = Buffer.concat([small.subarray(0, 21), large.subarray(2)]);
  assert.throws(() => privateThumbnailInputCodec(duplicate, duplicate.length));
  const unsupported = Buffer.from(small); unsupported[3] = 0xc3;
  assert.throws(() => privateThumbnailInputCodec(unsupported, unsupported.length));
});
test('native FD-only JPEG import strips metadata and preserves all other encrypted previews', async t => {
  const f = await fixture(t);
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster', 'clip'] as const) {
    await writePrivateHubPreview(f.store, kind, 'video', Buffer.from('old-' + kind));
  }
  const spawn = childProcess.spawn; let decoders = 0;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    decoders++;
    assert.equal(JSON.stringify(args[1]).includes(marker), false);
    assert.equal(JSON.stringify(args[1]).includes(f.file), false);
    return spawn(...args);
  });
  const output = await setPrivateCustomThumbnail(f.store, f.source, 144, { isCurrent: () => true });
  assert.equal(decoders, 1); assert.equal(output.baseGeneration, 'legacy');
  const bytes = await readPrivateHubPreview(f.store, 'thumbnail', 'video');
  validatePrivateJpeg(bytes, 256, 144); assert.equal(bytes.includes(marker), false);
  assert.deepEqual(stripPrivateThumbnailMetadata(bytes, 256, 144), bytes);
  for (const kind of ['filmstrip', 'clip-poster', 'clip'] as const) {
    assert.equal((await readPrivateHubPreview(f.store, kind, 'video')).toString(), 'old-' + kind);
  }
  assert.deepEqual(await fs.readFile(f.file), f.input);
  assert.deepEqual((await fs.readdir(f.root)).sort(), [marker + '.jpg', 'hub']);
  for (const name of await fs.readdir(f.store.directory)) {
    assert.equal((await fs.readFile(path.join(f.store.directory, name))).includes(marker), false);
  }
});
test('metadata stripper refuses later metadata scans and trailing payloads', async t => {
  const f = await fixture(t);
  const clean = stripPrivateThumbnailMetadata(f.input, 256, 144);
  assert.equal(clean.includes(marker), false);
  assert.throws(() => stripPrivateThumbnailMetadata(Buffer.concat([clean, Buffer.from('tail')]), 256, 144));
  const injected = Buffer.concat([clean.subarray(0, -2), Buffer.from('fffe00046f6b', 'hex'), clean.subarray(-2)]);
  assert.throws(() => stripPrivateThumbnailMetadata(injected, 256, 144));
});
test('cancellation exactly when yielded pixels arrive wipes transferred plaintext and leaves old preview', async t => {
  const f = await fixture(t); await writePrivateHubPreview(f.store, 'thumbnail', 'video', Buffer.from('old'));
  const delivered = Buffer.from(f.output); let drained = false;
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', () => ({
    async next() { f.controller.abort(); return { done: false as const, value: delivered }; },
    async return() { drained = true; return { done: true as const, value: undefined }; },
    [Symbol.asyncIterator]() { return this; },
  }));
  await assert.rejects(setPrivateCustomThumbnail(f.store, f.source, 144, { signal: f.controller.signal, isCurrent: () => true }));
  assert.equal(drained, true); assert.ok(delivered.every(byte => byte === 0));
  assert.equal(await readPrivateThumbnailOverride(f.store, 'video'), undefined);
  assert.equal((await readPrivateHubPreview(f.store, 'thumbnail', 'video')).toString(), 'old');
});
test('global admission prevents a video generator overlapping a custom decoder and releases after drainage', async t => {
  const f = await fixture(t); let entered!: () => void; let release!: () => void;
  const entering = new Promise<void>(yes => { entered = yes; }); const gate = new Promise<void>(yes => { release = yes; });
  t.after(release);
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', () => (async function* () { entered(); await gate; yield Buffer.from(f.output); })());
  const changing = setPrivateCustomThumbnail(f.store, f.source, 144, { isCurrent: () => true });
  await entering;
  await assert.rejects(generatePrivateHubPreviews(f.store, f.source,
    { height: 144, clipHeight: 144, fixed: true, n: 3, clipSnippets: 0, clipSnippetLength: 1 }, { isCurrent: () => true }));
  release(); await changing;
  await setPrivateCustomThumbnail(f.store, f.source, 144, { isCurrent: () => true });
});
test('revocation before encrypted envelope publication retains the previous thumbnail', async t => {
  const f = await fixture(t); await writePrivateHubPreview(f.store, 'thumbnail', 'video', Buffer.from('old'));
  const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, guard?: () => boolean) => {
    if (id === privateThumbnailOverrideRecordId('video')) { f.controller.abort(); }
    return write(id, bytes, guard);
  });
  await assert.rejects(setPrivateCustomThumbnail(f.store, f.source, 144, { signal: f.controller.signal, isCurrent: () => true }));
  assert.equal(await readPrivateThumbnailOverride(f.store, 'video'), undefined);
  assert.equal((await readPrivateHubPreview(f.store, 'thumbnail', 'video')).toString(), 'old');
});
test('revocation after publication never claims rollback or success', async t => {
  const f = await fixture(t); const write = f.store.writeRecord.bind(f.store);
  t.mock.method(f.store, 'writeRecord', async (id: string, bytes: Buffer, guard?: () => boolean) => {
    await write(id, bytes, guard);
    if (id === privateThumbnailOverrideRecordId('video')) { f.controller.abort(); }
  });
  await assert.rejects(setPrivateCustomThumbnail(f.store, f.source, 144, { signal: f.controller.signal, isCurrent: () => true }));
  assert.ok(await readPrivateThumbnailOverride(f.store, 'video'));
  validatePrivateJpeg(await readPrivateHubPreview(f.store, 'thumbnail', 'video'), 256, 144);
});

function pngChunk(type: string, bytes = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(type, 4, 4, 'ascii'); bytes.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result;
}
function pngImage(colour: number, depth: number, pixels: Buffer, extra: Buffer[] = [], interlace = 0): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = depth; ihdr[9] = colour; ihdr[12] = interlace;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), ...extra,
    pngChunk('IDAT', deflateSync(Buffer.concat([Buffer.from([0]), pixels]))),
    pngChunk('zTXt', Buffer.from(marker)), pngChunk('IEND')]);
}
function centerPixel(jpeg: Buffer): number[] {
  const decoded = childProcess.spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', 'pipe:0', '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
  { cwd, input: jpeg, timeout: 30_000, maxBuffer: 256 * 144 * 3 + 1024 });
  assert.equal(decoded.status, 0); assert.equal(decoded.stdout.length, 256 * 144 * 3);
  return [...decoded.stdout.subarray((72 * 256 + 128) * 3, (72 * 256 + 128) * 3 + 3)];
}
const pngSamples = [
  { label: 'opaque RGB', colour: 2, depth: 8, pixels: [255, 0, 0], expected: [255, 0, 0] },
  { label: 'transparent RGBA hidden red', colour: 6, depth: 8, pixels: [255, 0, 0, 0], expected: [0, 0, 0] },
  { label: 'half-transparent RGBA', colour: 6, depth: 8, pixels: [255, 0, 0, 128], expected: [128, 0, 0] },
  { label: 'sixteen-bit RGBA', colour: 6, depth: 16, pixels: [255, 255, 0, 0, 0, 0, 128, 128], expected: [128, 0, 0] },
  { label: 'grayscale alpha', colour: 4, depth: 8, pixels: [255, 128], expected: [128, 128, 128] },
  { label: 'palette transparency', colour: 3, depth: 1, pixels: [0], expected: [0, 0, 0],
    extra: [pngChunk('PLTE', Buffer.from([255, 0, 0])), pngChunk('tRNS', Buffer.from([0]))] },
  { label: 'one-bit grayscale white transparency', colour: 0, depth: 1, pixels: [128], expected: [0, 0, 0],
    extra: [pngChunk('tRNS', Buffer.from([0, 1]))] },
  { label: 'one-bit grayscale opaque white', colour: 0, depth: 1, pixels: [128], expected: [255, 255, 255],
    extra: [pngChunk('tRNS', Buffer.from([0, 0]))] },
  { label: 'two-bit grayscale white transparency', colour: 0, depth: 2, pixels: [192], expected: [0, 0, 0],
    extra: [pngChunk('tRNS', Buffer.from([0, 3]))] },
  { label: 'four-bit grayscale white transparency', colour: 0, depth: 4, pixels: [240], expected: [0, 0, 0],
    extra: [pngChunk('tRNS', Buffer.from([0, 15]))] },
  { label: 'interlaced RGBA', colour: 6, depth: 8, pixels: [0, 255, 0, 255], expected: [0, 255, 0], interlace: 1 },
];
for (const sample of pngSamples) {
  test(`native PNG import handles ${sample.label} with metadata-free encrypted JPEG output`, async t => {
    const input = pngImage(sample.colour, sample.depth, Buffer.from(sample.pixels), sample.extra, sample.interlace);
    const f = await fixture(t, input);
    assert.equal(privateThumbnailInputCodec(input, input.length), 'png');
    await writePrivateHubPreview(f.store, 'filmstrip', 'video', Buffer.from('retained filmstrip'));
    const spawn = childProcess.spawn; let decoders = 0;
    const spy = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      decoders++; assert.ok((args[1] as string[]).includes('pipe:0'));
      assert.ok(!(args[1] as string[]).includes('fd:'));
      assert.equal(JSON.stringify(args).includes(f.file), false); return spawn(...args);
    });
    await setPrivateCustomThumbnail(f.store, f.source, 144, { isCurrent: () => true });
    spy.mock.restore(); assert.equal(decoders, 1);
    const jpeg = await readPrivateHubPreview(f.store, 'thumbnail', 'video');
    validatePrivateJpeg(jpeg, 256, 144); assert.equal(jpeg.includes(marker), false);
    assert.deepEqual(stripPrivateThumbnailMetadata(jpeg, 256, 144), jpeg);
    const pixel = centerPixel(jpeg);
    assert.ok(pixel.every((value, index) => Math.abs(value - sample.expected[index]) <= 6), `${sample.label}: ${pixel}`);
    assert.deepEqual(await fs.readFile(f.file), input);
    assert.equal((await readPrivateHubPreview(f.store, 'filmstrip', 'video')).toString(), 'retained filmstrip');
    assert.deepEqual((await fs.readdir(f.root)).sort(), [marker + '.png', 'hub']);
    jpeg.fill(0);
  });
}
test('PNG larger than one capability read is sanitized before native decode', async t => {
  const bytes = pngImage(2, 8, Buffer.from([255, 0, 0]), [pngChunk('tEXt', Buffer.alloc(300_000, 65))]);
  const f = await fixture(t, bytes);
  await setPrivateCustomThumbnail(f.store, f.source, 144, { isCurrent: () => true });
  assert.deepEqual(centerPixel(await readPrivateHubPreview(f.store, 'thumbnail', 'video')), [254, 0, 0]);
  assert.deepEqual(await fs.readFile(f.file), bytes);
});
test('malformed PNG chunks are refused before spawning any decoder or replacing the thumbnail', async t => {
  const png = pngImage(2, 8, Buffer.from([255, 0, 0])); png[png.length - 1] ^= 1;
  const f = await fixture(t, png);
  await writePrivateHubPreview(f.store, 'thumbnail', 'video', Buffer.from('old'));
  const spawn = t.mock.method(childProcess, 'spawn', () => { assert.fail('Decoder must not receive malformed PNG'); });
  await assert.rejects(setPrivateCustomThumbnail(f.store, f.source, 144, { isCurrent: () => true }));
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(await readPrivateThumbnailOverride(f.store, 'video'), undefined);
  assert.equal((await readPrivateHubPreview(f.store, 'thumbnail', 'video')).toString(), 'old');
});

test('cancelling a PNG pipe wipes sanitized input and provisional output before returning', async t => {
  const f = await fixture(t, pngImage(6, 8, Buffer.from([255, 0, 0, 128])));
  await writePrivateHubPreview(f.store, 'thumbnail', 'video', Buffer.from('old'));
  let capturedInput: Buffer | undefined;
  const delivered = Buffer.from(f.output);
  let drained = false;
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', (options: mediaProcess.PrivateMediaProcessOptions) => {
    assert.equal(options.sourceFd, undefined);
    assert.ok(options.input);
    const input = options.input[Symbol.asyncIterator]();
    return {
      async next() {
        const part = await input.next();
        assert.equal(part.done, false);
        capturedInput = part.value as Buffer;
        assert.equal(capturedInput.includes(marker), false);
        f.controller.abort();
        return { done: false as const, value: delivered };
      },
      async return() { await input.return?.(); drained = true; return { done: true as const, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
  });
  await assert.rejects(setPrivateCustomThumbnail(f.store, f.source, 144, { signal: f.controller.signal, isCurrent: () => true }));
  assert.equal(drained, true);
  assert.ok(capturedInput && capturedInput.every(byte => byte === 0));
  assert.ok(delivered.every(byte => byte === 0));
  assert.equal(await readPrivateThumbnailOverride(f.store, 'video'), undefined);
  assert.equal((await readPrivateHubPreview(f.store, 'thumbnail', 'video')).toString(), 'old');
});
