import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { GLOBALS } from './main-globals';
import { NORMAL_CATALOGUE_STORAGE } from './catalogue-storage';
import { normalOperationScope } from './normal-operation-scope';
import { normalPreviewValidation } from './normal-preview-validation';
import { resolveCanonicalPreviewFile } from './normal-preview-validation-worker';
import type { PrivateHubSession } from './private-hub-session';
import { parseTheatrumMediaRequest } from './theatrum-protocol-paths';

let fetches = 0;
let fetchFile: (url: string, options: any) => Promise<Response> = async () => new Response('plain file');
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const mediaUrl = 'theatrum://app/media/thumbnails/known.jpg';
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let createHandler: typeof import('./theatrum-protocol').createTheatrumProtocolHandler;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') {
      return { protocol: {}, net: { fetch: async (url: string, options: any) => { fetches++; return fetchFile(url, options); } } };
    }
    return originalLoad.call(this, request, ...args);
  };
  createHandler = require('./theatrum-protocol').createTheatrumProtocolHandler;
} finally { NodeModule._load = originalLoad; }

async function fixture(t: TestContext): Promise<string> {
  const root = path.resolve(__dirname, '..', 'tmp');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'private-protocol-'));
  const previous = { ...GLOBALS };
  // Worker lifecycle is tested separately; these tests isolate stream ownership.
  t.mock.method(normalPreviewValidation, 'resolve', async (filePath: string, outputDirectory: string, assetDirectory: string) =>
    resolveCanonicalPreviewFile({ filePath, outputDirectory, assetDirectory }));
  fetches = 0;
  fetchFile = async () => new Response('plain file');
  t.after(async () => {
    normalOperationScope.resume(await normalOperationScope.seal());
    Object.assign(GLOBALS, previous); await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'vha-Synthetic', 'thumbnails'), { recursive: true });
  await fs.writeFile(path.join(directory, 'vha-Synthetic', 'thumbnails', 'known.jpg'), 'LEFTOVER_PLAINTEXT');
  Object.assign(GLOBALS, {
    catalogueStorage: NORMAL_CATALOGUE_STORAGE, catalogueSessionGeneration: 4, catalogueTransitionActive: false,
    hubName: 'Synthetic', selectedOutputFolder: directory, authorizedCatalogueImageHashes: new Set(['known']),
  });
  return directory;
}

test('private request parsing confines identity, type, extension and app origin', () => {
  assert.deepEqual(parseTheatrumMediaRequest('theatrum://app/media/clips/known.mp4?v=1'), { assetType: 'clips', hash: 'known', video: true });
  for (const value of [
    'https://app/media/clips/known.mp4', 'theatrum://other/media/clips/known.mp4',
    'theatrum://user@app/media/clips/known.mp4', 'theatrum://app/media/clips/a%2fb.mp4',
    'theatrum://app/media/thumbnails/known.mp4', 'theatrum://app/media/clips/known.txt',
    'theatrum://app/media/clips/%00.mp4', 'theatrum://app/media/clips/known.mp4/extra',
  ]) { assert.equal(parseTheatrumMediaRequest(value), undefined, value); }
});

test('ordinary persistent protocol refuses every private preview even while its hub is unlocked', async t => {
  const directory = await fixture(t);
  let called = 0;
  const session = {
    isCurrent: () => true,
    createPreviewResponse: async () => { called++; return new Response('decrypted private bytes'); },
  } as unknown as PrivateHubSession;
  GLOBALS.catalogueStorage = { kind: 'private', session, generation: 8, cataloguePath: directory };
  const handler = createHandler(directory);
  for (const suffix of ['thumbnails/known.jpg', 'filmstrips/known.jpg', 'clips/known.jpg', 'clips/known.mp4']) {
    const response = await handler(new Request('theatrum://app/media/' + suffix));
    assert.equal(response.status, 404);
    assert.equal((await response.text()).includes('private bytes'), false);
  }
  assert.equal(called, 0, 'private decryption is restricted to the isolated browser handler');
  assert.equal(fetches, 0, 'old plaintext previews are not a fallback');
});

test('locked, stale, unknown and corrupt private requests never fall back to leftover plaintext files', async t => {
  const directory = await fixture(t);
  let live = false;
  let called = 0;
  const session = {
    isCurrent: () => live,
    createPreviewResponse: async () => { called++; throw new Error('/private/path secret failure'); },
  } as unknown as PrivateHubSession;
  GLOBALS.catalogueStorage = { kind: 'private', session, generation: 1, cataloguePath: directory };
  const handler = createHandler(directory);
  const request = new Request('theatrum://app/media/thumbnails/known.jpg');
  assert.equal((await handler(request)).status, 404);
  assert.equal(called, 0);
  live = true;
  const corrupt = await handler(request);
  assert.equal(corrupt.status, 404);
  assert.equal(corrupt.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal((await corrupt.text()).includes('secret'), false);
  for (const suffix of ['unknown.jpg', 'known.mp4', 'known.jpg/extra']) {
    assert.equal((await handler(new Request('theatrum://app/media/thumbnails/' + suffix))).status, 404);
  }
  assert.equal(called, 0);
  assert.equal(fetches, 0);
  for (const binding of [
    undefined, { kind: 'private' }, { kind: 'unknown' },
    { kind: 'private', session: { isCurrent: () => { throw new Error('Sensitive failure'); } } },
  ]) {
    GLOBALS.catalogueStorage = binding as typeof GLOBALS.catalogueStorage;
    const unavailable = await handler(request);
    assert.equal(unavailable.status, 404);
    assert.equal((await unavailable.text()).includes('Sensitive'), false);
  }
  assert.equal(fetches, 0);
});

test('normal preview fetch and application assets remain available', async t => {
  const directory = await fixture(t);
  const handler = createHandler(directory);
  assert.equal(await (await handler(new Request('theatrum://app/media/thumbnails/known.jpg'))).text(), 'plain file');
  GLOBALS.catalogueTransitionActive = true;
  assert.equal(await (await handler(new Request('theatrum://app/media/thumbnails/known.jpg'))).text(), 'plain file',
    'the still-active normal hub remains visible while another hub is being reviewed');
  assert.equal(await (await handler(new Request('theatrum://app/index.html'))).text(), 'plain file');
  assert.equal(fetches, 3);
});

test('sealing blocks normal media admission while static application files remain available', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  normalOperationScope.assertDrained(await normalOperationScope.seal());
  assert.equal((await handler(new Request(mediaUrl))).status, 404);
  assert.equal(fetches, 0);
  assert.equal(await (await handler(new Request('theatrum://app/index.html'))).text(), 'plain file');
  assert.equal(fetches, 1);
});

test('canonical lookup is retained through revocation and cannot launch a late native fetch', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const filePath = path.join(directory, 'vha-Synthetic', 'thumbnails', 'known.jpg');
  const entered = deferred(); const lookup = deferred<string>();
  t.mock.method(normalPreviewValidation, 'resolve', () => { entered.resolve(); return lookup.promise; });
  const response = handler(new Request(mediaUrl)); await entered.promise;
  const draining = normalOperationScope.seal(); let drained = false;
  void draining.then(() => { drained = true; });
  await turn(); assert.equal(drained, false); assert.equal(fetches, 0);
  lookup.resolve(filePath);
  assert.equal((await response).status, 404); await draining;
  assert.equal(fetches, 0);
});

for (const drift of ['session', 'hash authorization'] as const) {
  test(`worker result cannot authorize media after ${drift} changes`, async t => {
    const directory = await fixture(t); const handler = createHandler(directory);
    const entered = deferred(); const lookup = deferred<string>();
    t.mock.method(normalPreviewValidation, 'resolve', () => { entered.resolve(); return lookup.promise; });
    const response = handler(new Request(mediaUrl)); await entered.promise;
    if (drift === 'session') { GLOBALS.catalogueSessionGeneration++; }
    else { GLOBALS.authorizedCatalogueImageHashes.delete('known'); }
    lookup.resolve(path.join(directory, 'vha-Synthetic', 'thumbnails', 'known.jpg'));
    assert.equal((await response).status, 404); assert.equal(fetches, 0);
  });
}

test('failed worker validation returns a generic response without a native fetch', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  t.mock.method(normalPreviewValidation, 'resolve', async () => undefined);
  const response = await handler(new Request(mediaUrl));
  assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found.');
  await turn(); assert.equal(normalOperationScope.pendingCount, 0); assert.equal(fetches, 0);
});

test('late native fetch headers are refused and native cancellation is awaited before the drain', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const entered = deferred(); const nativeResponse = deferred<Response>(); const cancelEntered = deferred(); const cleanup = deferred();
  let nativeSignal!: AbortSignal;
  fetchFile = async (_url, options) => { nativeSignal = options.signal; entered.resolve(); return nativeResponse.promise; };
  const response = handler(new Request(mediaUrl)); await entered.promise;
  const draining = normalOperationScope.seal(); let drained = false;
  void draining.then(() => { drained = true; });
  assert.equal(nativeSignal.aborted, true);
  await turn(); assert.equal(drained, false);
  nativeResponse.resolve(new Response(new ReadableStream({ cancel() { cancelEntered.resolve(); return cleanup.promise; } }, { highWaterMark: 0 })));
  await cancelEntered.promise; await turn(); assert.equal(drained, false);
  cleanup.resolve(); const unavailable = await response;
  assert.equal(unavailable.status, 404); assert.equal(await unavailable.text(), 'Not found.');
  await draining;
});

test('ordinary range responses preserve headers and stream data without wrapper prefetch', async t => {
  const directory = await fixture(t); const handler = createHandler(directory, true);
  let reads = 0; let signal!: AbortSignal;
  fetchFile = async (_url, options) => {
    signal = options.signal;
    assert.equal(options.headers.get('range'), 'bytes=2-4');
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new TextEncoder().encode('cde')); controller.close(); },
    }, { highWaterMark: 0 }), { status: 206, headers: { 'content-range': 'bytes 2-4/5', 'content-type': 'video/mp4' } });
  };
  const response = await handler(new Request(mediaUrl, { headers: { range: 'bytes=2-4', origin: 'http://localhost:4200' } }));
  assert.equal(reads, 0); assert.equal(normalOperationScope.pendingCount, 1);
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-4/5');
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  assert.equal(await response.text(), 'cde'); await turn();
  assert.equal(reads, 1); assert.equal(signal.aborted, false); assert.equal(normalOperationScope.pendingCount, 0);
});

test('unread response bodies are cancelled and keep the drain pending until cancellation settles', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const cancelled = deferred(); const cleanup = deferred(); let reads = 0; let signal!: AbortSignal;
  fetchFile = async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream<Uint8Array>({
      pull() { reads++; },
      cancel() { cancelled.resolve(); return cleanup.promise; },
    }, { highWaterMark: 0 }));
  };
  const response = await handler(new Request(mediaUrl));
  const draining = normalOperationScope.seal(); let drained = false;
  void draining.then(() => { drained = true; });
  await cancelled.promise;
  assert.equal(signal.aborted, true); assert.equal(reads, 0);
  await assert.rejects(response.text(), /media request was cancelled/);
  await turn(); assert.equal(drained, false);
  cleanup.resolve(); await draining;
});

test('a chunk resolving after revocation cannot reach the requesting renderer', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const reading = deferred(); const cleanup = deferred(); let source!: ReadableStreamDefaultController<Uint8Array>;
  fetchFile = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
    pull() { reading.resolve(); },
    cancel() { return cleanup.promise; },
  }, { highWaterMark: 0 }));
  const response = await handler(new Request(mediaUrl)); const reader = response.body!.getReader();
  const read = reader.read(); const rejected = assert.rejects(read, /media request was cancelled/);
  await reading.promise;
  source.enqueue(new TextEncoder().encode('LATE_SYNTHETIC_MEDIA'));
  const draining = normalOperationScope.seal();
  await rejected;
  cleanup.resolve(); await draining;
});

test('renderer cancellation aborts its native fetch and drains the body without sealing other operations', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const requestController = new AbortController(); const cleanup = deferred(); const cancelled = deferred();
  let nativeSignal!: AbortSignal;
  fetchFile = async (_url, options) => {
    nativeSignal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled.resolve(); return cleanup.promise; } }, { highWaterMark: 0 }));
  };
  const response = await handler(new Request(mediaUrl, { signal: requestController.signal }));
  requestController.abort(); await cancelled.promise;
  await assert.rejects(response.text(), /media request was cancelled/);
  assert.equal(nativeSignal.aborted, true); assert.equal(normalOperationScope.accepting, true);
  assert.equal(normalOperationScope.pendingCount, 1);
  cleanup.resolve(); await turn(); assert.equal(normalOperationScope.pendingCount, 0);
});

test('HEAD responses have no retained body and preserve the native file headers', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  fetchFile = async (_url, options) => {
    assert.equal(options.method, 'HEAD');
    return new Response(null, { headers: { 'content-length': '17', 'content-type': 'image/jpeg' } });
  };
  const response = await handler(new Request(mediaUrl, { method: 'HEAD' }));
  assert.equal(response.status, 200); assert.equal(response.body, null);
  assert.equal(response.headers.get('content-length'), '17');
  await turn(); assert.equal(normalOperationScope.pendingCount, 0);
});

test('consumer body cancellation releases only that response after native cancellation settles', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const cleanup = deferred(); let cancellationReason: unknown = 'not cancelled';
  fetchFile = async () => new Response(new ReadableStream({
    cancel(reason) { cancellationReason = reason; return cleanup.promise; },
  }, { highWaterMark: 0 }));
  const response = await handler(new Request(mediaUrl));
  const cancelled = response.body!.cancel('RENDERER_SUPPLIED_REASON');
  try {
    await turn(); assert.equal(cancellationReason, undefined);
    assert.equal(normalOperationScope.pendingCount, 1); assert.equal(normalOperationScope.accepting, true);
  } finally { cleanup.resolve(); }
  await cancelled; await turn();
  assert.equal(normalOperationScope.pendingCount, 0);
});

test('native fetch failures return a generic response and release their operation', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  fetchFile = async () => { throw new Error('SYNTHETIC_SOURCE_PATH secret'); };
  const response = await handler(new Request(mediaUrl));
  assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found.');
  await turn(); assert.equal(normalOperationScope.pendingCount, 0);
});

test('unconsumed media responses have bounded admission and are all retired by sealing', async t => {
  const directory = await fixture(t); const handler = createHandler(directory); let cancelled = 0;
  fetchFile = async () => new Response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }));
  const responses = await Promise.all(Array.from({ length: 520 }, () => handler(new Request(mediaUrl))));
  assert.equal(responses.filter(response => response.status === 200).length, 512);
  assert.equal(responses.filter(response => response.status === 404).length, 8);
  assert.equal(fetches, 512);
  await normalOperationScope.seal();
  assert.equal(cancelled, 512); assert.equal(normalOperationScope.pendingCount, 0);
});

test('reentrant native cancellation cannot replace the outstanding body cleanup promise', async t => {
  const directory = await fixture(t); const handler = createHandler(directory);
  const requestController = new AbortController(); const cleanup = deferred(); const entered = deferred(); let cancellations = 0;
  fetchFile = async (_url, options) => {
    options.signal.addEventListener('abort', () => requestController.abort(), { once: true });
    return new Response(new ReadableStream({
      cancel() { cancellations++; entered.resolve(); return cleanup.promise; },
    }, { highWaterMark: 0 }));
  };
  const response = await handler(new Request(mediaUrl, { signal: requestController.signal }));
  const cancelled = response.body!.cancel();
  await entered.promise;
  let settled = false; void cancelled.then(() => { settled = true; });
  try {
    await turn(); assert.equal(settled, false); assert.equal(normalOperationScope.pendingCount, 1);
    assert.equal(cancellations, 1);
  } finally { cleanup.resolve(); }
  await cancelled; await turn(); assert.equal(normalOperationScope.pendingCount, 0);
});

test('native cancellation rejection settles JavaScript work without exposing its path-bearing error', async t => {
  const directory = await fixture(t); const handler = createHandler(directory); let nativeSignal!: AbortSignal;
  fetchFile = async (_url, options) => {
    nativeSignal = options.signal;
    return new Response(new ReadableStream({
      cancel() { return Promise.reject(new Error('SYNTHETIC_SOURCE_PATH cancellation failed')); },
    }, { highWaterMark: 0 }));
  };
  const response = await handler(new Request(mediaUrl));
  const draining = normalOperationScope.seal();
  await assert.rejects(response.text(), error => error instanceof Error
    && error.message === 'The media request was cancelled.');
  normalOperationScope.assertDrained(await draining);
  assert.equal(nativeSignal.aborted, true); assert.equal(normalOperationScope.pendingCount, 0);
  // This evidence covers settled JS promises, not a successful native close.
});
