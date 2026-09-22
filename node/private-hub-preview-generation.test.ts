import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { test, type TestContext } from 'node:test';
import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import { getMediaToolPath } from './media-tool-paths';
import { PrivateHubStore } from './private-hub-store';
import { readPrivateHubPreview, writePrivateHubPreview } from './private-hub-catalogue';
import { generatePrivateHubPreviews } from './private-hub-preview-generation';
import { capturePrivatePreviewSource, type PrivatePreviewSource } from './private-preview-source';
import { createPrivatePreviewSet, privatePreviewSetRecordId, publishPrivatePreviewSet, readPrivatePreviewSet } from './private-hub-preview-set';
import { validatePrivateJpeg } from './private-preview-plan';
import * as mediaProcess from './private-media-process';

const cwd = path.resolve(__dirname, '..');
const canary = 'PRIVATE-GENERATION-CANARY';
const settings: ScreenshotSettings = { height: 144, clipHeight: 144, fixed: true, n: 3, clipSnippets: 2, clipSnippetLength: 1 };

async function fixture(t: TestContext): Promise<{
  root: string; directory: string; sourcePath: string; store: PrivateHubStore; source: PrivatePreviewSource;
}> {
  await fs.promises.mkdir(path.join(cwd, 'tmp'), { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(cwd, 'tmp/private-generation-'));
  const directory = path.join(root, 'hub');
  const sourcePath = path.join(root, canary + '.mp4');
  const result = childProcess.spawnSync(getMediaToolPath('ffmpeg'), ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000',
    '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata', 'title=' + canary, sourcePath],
  { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  const store = await PrivateHubStore.create(directory, 'Synthetic pipeline passphrase');
  const source = await capturePrivatePreviewSource({ hash: 'video-1', root, partialPath: '', fileName: path.basename(sourcePath),
    inputSource: 0, isCurrent: location => location.hash === 'video-1' && location.root === root && location.fileName === path.basename(sourcePath) });
  t.after(async () => { await source.close(); await store.lock(); await fs.promises.rm(root, { recursive: true, force: true }); });
  return { root, directory, sourcePath, store, source };
}

test('native generation publishes verified encrypted images and clips without source paths or plaintext preview files', async t => {
  const { root, directory, sourcePath, store, source } = await fixture(t);
  const originalSpawn = childProcess.spawn;
  let decoderCount = 0;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
    const options = args[2] as childProcess.SpawnOptions;
    const arguments_ = args[1] as string[];
    decoderCount++;
    assert.ok(!arguments_.some(argument => argument.includes(canary) || argument.includes(sourcePath)));
    assert.ok(!String(options.cwd).startsWith(root));
    assert.equal(options.env?.FFREPORT, undefined);
    assert.equal(options.shell, false);
    return originalSpawn(...args);
  });
  const set = await generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true });
  assert.deepEqual(await readPrivatePreviewSet(store, source.hash), set);
  assert.equal(set.clip, true);
  assert.equal(set.screenCount, 3);
  assert.ok(decoderCount >= 9);
  for (const kind of ['thumbnail', 'filmstrip', 'clip-poster'] as const) {
    const bytes = await readPrivateHubPreview(store, kind, source.hash);
    validatePrivateJpeg(bytes, kind === 'filmstrip' ? 768 : 256, 144);
    assert.equal(bytes.includes(canary), false);
    bytes.fill(0);
  }
  const clip = await readPrivateHubPreview(store, 'clip', source.hash);
  assert.equal(clip.subarray(4, 8).toString(), 'ftyp');
  assert.equal(clip.includes(canary), false);
  const probe = childProcess.spawnSync(getMediaToolPath('ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type,width,height',
    '-of', 'json', '-i', 'pipe:0'], { cwd, input: clip, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(probe.status, 0);
  assert.deepEqual(JSON.parse(probe.stdout.toString()).streams.map((stream: { codec_type: string }) => stream.codec_type), ['video', 'audio']);
  clip.fill(0);
  assert.deepEqual((await fs.promises.readdir(root)).sort(), [canary + '.mp4', 'hub']);
  for (const name of await fs.promises.readdir(directory)) {
    assert.ok(name === 'private-hub.json' || name === '.private-hub.lock' || /^[a-f0-9]{64}\.sealed(?:\.bak)?$/.test(name), name);
    const bytes = await fs.promises.readFile(path.join(directory, name));
    assert.equal(bytes.includes(canary), false);
    assert.equal(bytes.includes('JFIF'), false);
    assert.equal(bytes.includes('ftyp'), false);
  }
  // Disabling clips must suppress the old encrypted clip and poster together.
  const withoutClips = await generatePrivateHubPreviews(store, source, { ...settings, clipSnippets: 0 }, { isCurrent: () => true });
  assert.equal(withoutClips.clip, false);
  await assert.rejects(readPrivateHubPreview(store, 'clip', source.hash));
  await assert.rejects(readPrivateHubPreview(store, 'clip-poster', source.hash));
});

test('source replacement during final encrypted staging leaves the previous active manifest intact', async t => {
  const { store, source, sourcePath, directory } = await fixture(t);
  const original = createPrivatePreviewSet(source.hash, 256, 144, 3, false);
  await publishPrivatePreviewSet(store, original, () => true);
  const [manifestFile] = (await fs.promises.readdir(directory)).filter(name => name.endsWith('.sealed'));
  const open = fs.promises.open.bind(fs.promises);
  let replaced = false;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    const name = path.basename(String(args[0]));
    if (name.startsWith(manifestFile + '.') && /^[a-f0-9]{48}\.pending$/.test(name.slice(manifestFile.length + 1))) {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, 'writeFile', async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        const result = await write(...writeArgs);
        await fs.promises.rename(sourcePath, sourcePath + '.old');
        await fs.promises.copyFile(sourcePath + '.old', sourcePath);
        replaced = true;
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(generatePrivateHubPreviews(store, source, { ...settings, clipSnippets: 0 }, { isCurrent: () => true }));
  assert.equal(replaced, true);
  assert.equal(source.signal.aborted, true);
  assert.deepEqual(await readPrivatePreviewSet(store, source.hash), original);
});

test('late remux failure cannot publish a partial replacement over converted previews', async t => {
  const { store, source } = await fixture(t);
  await writePrivateHubPreview(store, 'thumbnail', source.hash, Buffer.from('previous-thumbnail'));
  const run = mediaProcess.streamPrivateMediaProcess;
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', (options: mediaProcess.PrivateMediaProcessOptions) => {
    const stream = run(options);
    if (!options.args.includes('-movflags')) { return stream; }
    return (async function* (): AsyncGenerator<Buffer> {
      yield* stream;
      throw new Error(canary + ' encoder failure after output');
    })();
  });
  await assert.rejects(generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true }), error => !String(error).includes(canary));
  assert.equal(await readPrivatePreviewSet(store, source.hash), undefined);
  assert.equal((await readPrivateHubPreview(store, 'thumbnail', source.hash)).toString(), 'previous-thumbnail');
});

test('cancellation drains a blocked producer before releasing global generation admission', async t => {
  const { store, source } = await fixture(t);
  const abort = new AbortController();
  let begin: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  let closed = false;
  const run = mediaProcess.streamPrivateMediaProcess;
  t.mock.method(mediaProcess, 'streamPrivateMediaProcess', (options: mediaProcess.PrivateMediaProcessOptions) => {
    if (options.tool !== 'ffprobe') { return run(options); }
    // Model a producer cancelled before it can produce its first byte.
    // eslint-disable-next-line require-yield
    return (async function* (): AsyncGenerator<Buffer> {
      begin();
      try {
        await new Promise<void>(resolve => {
          if (options.signal.aborted) { resolve(); } else { options.signal.addEventListener('abort', () => resolve(), { once: true }); }
        });
        throw new Error('cancelled');
      } finally { await new Promise(resolve => setTimeout(resolve, 10)); closed = true; }
    })();
  });
  const pending = generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true, signal: abort.signal });
  const rejected = assert.rejects(pending);
  await started;
  await assert.rejects(generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true }));
  abort.abort();
  await rejected;
  assert.equal(closed, true);
  assert.equal(await readPrivatePreviewSet(store, source.hash), undefined);
  t.mock.restoreAll();
  await generatePrivateHubPreviews(store, source, { ...settings, clipSnippets: 0 }, { isCurrent: () => true });
});

test('store locking during image verification prevents publication and clears owned readback bytes', async t => {
  const { store, source, directory } = await fixture(t);
  const read = store.readRecord.bind(store);
  let observed: Buffer | undefined;
  t.mock.method(store, 'readRecord', async (id: string, limit?: number) => {
    const bytes = await read(id, limit);
    if (id.startsWith('preview-set-member:')) { observed = bytes; void store.lock(); }
    return bytes;
  });
  await assert.rejects(generatePrivateHubPreviews(store, source, settings, { isCurrent: () => true }));
  assert.ok(observed);
  assert.ok(observed.every(value => value === 0));
  await store.lock();
  const reopened = await PrivateHubStore.open(directory, 'Synthetic pipeline passphrase');
  try { await assert.rejects(reopened.readRecord(privatePreviewSetRecordId(source.hash)), { code: 'ENOENT' }); }
  finally { await reopened.lock(); }
});

test('revocation during successful cleanup reports uncertain completion rather than stale success', async t => {
  const { store, source } = await fixture(t);
  let authorized = true;
  const abort = AbortController.prototype.abort;
  t.mock.method(AbortController.prototype, 'abort', function(this: AbortController, reason?: unknown): void {
    abort.call(this, reason);
    authorized = false;
  });
  await assert.rejects(generatePrivateHubPreviews(store, source, { ...settings, clipSnippets: 0 }, { isCurrent: () => authorized }));
  assert.ok(await readPrivatePreviewSet(store, source.hash), 'the final filesystem publication already committed');
});
