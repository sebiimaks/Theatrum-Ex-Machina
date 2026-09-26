import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { GLOBALS } from './main-globals';
import { normalPreviewValidation } from './normal-preview-validation';
import { normalOperationScope } from './normal-operation-scope';
import { resolveCanonicalPreviewFile } from './normal-preview-validation-worker';

type Handler = (request: Request) => Promise<Response>;
interface FetchOptions {
  bypassCustomProtocolHandlers: boolean;
  headers: Headers;
  method: string;
}
let handler: Handler;
let fetches: { url: string; options: FetchOptions }[] = [];
let fetchFile: (url: string, options: FetchOptions) => Promise<Response>;
const mediaUrl = 'theatrum://app/media/thumbnails/known.jpg';
const NodeModule = require('node:module');
const originalLoad = NodeModule._load;
let register: typeof import('./theatrum-protocol').registerTheatrumProtocols;
try {
  NodeModule._load = function(request: string, ...args: unknown[]) {
    if (request === 'electron') {
      return {
        protocol: { handle: (scheme: string, callback: Handler) => {
          assert.equal(scheme, 'theatrum'); handler = callback;
        } },
        net: { fetch: async (url: string, options: FetchOptions) => {
          fetches.push({ url, options }); return fetchFile(url, options);
        } },
      };
    }
    return originalLoad.call(this, request, ...args);
  };
  register = require('./theatrum-protocol').registerTheatrumProtocols;
} finally { NodeModule._load = originalLoad; }

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(t: TestContext, development = false) {
  const root = path.resolve(__dirname, '..', 'tmp');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'normal-protocol-'));
  const assetDirectory = path.join(directory, 'vha-Synthetic');
  const filePath = path.join(assetDirectory, 'thumbnails', 'known.jpg');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'synthetic preview');
  const previous = { ...GLOBALS };
  Object.assign(GLOBALS, {
    hubName: 'Synthetic', selectedOutputFolder: directory, authorizedCatalogueImageHashes: new Set(['known']),
  });
  // Worker lifecycle is covered separately; exercise the registered protocol's
  // authorization boundary using the same canonical validation implementation.
  const validation = t.mock.method(normalPreviewValidation, 'resolve', async (
    candidate: string, output: string, assets: string,
  ) => resolveCanonicalPreviewFile({ filePath: candidate, outputDirectory: output, assetDirectory: assets }));
  fetches = [];
  fetchFile = async () => new Response('plain file');
  register(path.join(directory, 'dist'), development);
  t.after(async () => {
    normalOperationScope.resume(await normalOperationScope.seal());
    Object.assign(GLOBALS, previous);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, assetDirectory, filePath, validation };
}

test('authorized GET and HEAD requests fetch the canonical file and preserve request headers', async t => {
  const { filePath, validation } = fixture(t);
  const canonicalFile = fs.realpathSync.native(filePath);
  const link = path.join(path.dirname(filePath), 'linked.jpg');
  fs.symlinkSync(filePath, link);
  GLOBALS.authorizedCatalogueImageHashes.add('linked');
  for (const method of ['GET', 'HEAD']) {
    const request = new Request('theatrum://app/media/thumbnails/linked.jpg', {
      method, headers: { range: 'bytes=2-4' },
    });
    const response = await handler(request);
    assert.equal(response.status, 200);
    await response.text();
    const fetched = fetches.at(-1);
    assert.equal(fetched.url, pathToFileURL(canonicalFile).toString());
    assert.equal(fetched.options.method, method);
    assert.equal(fetched.options.headers.get('range'), 'bytes=2-4');
    assert.equal(fetched.options.bypassCustomProtocolHandlers, true);
    const call = validation.mock.calls.at(-1);
    assert.equal((call.arguments[3] as AbortSignal).aborted, false);
  }
  assert.equal(fetches.length, 2);
});

test('non-read methods are rejected before validation or fetching', async t => {
  const { validation } = fixture(t);
  for (const url of [mediaUrl, 'theatrum://app/index.html']) {
    assert.equal((await handler(new Request(url, { method: 'POST' }))).status, 405);
  }
  assert.equal(validation.mock.callCount(), 0);
  assert.equal(fetches.length, 0);
});

test('static app files remain independent of media validation and catalogue authorization', async t => {
  const { directory, validation } = fixture(t, true);
  GLOBALS.authorizedCatalogueImageHashes.clear(); GLOBALS.selectedOutputFolder = ''; GLOBALS.hubName = '';
  for (const suffix of ['', 'index.html', 'assets/logo.png']) {
    const response = await handler(new Request('theatrum://app/' + suffix, {
      headers: { origin: 'http://localhost:4200' },
    }));
    assert.equal(await response.text(), 'plain file');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(fetches.at(-1).url, pathToFileURL(path.join(directory, 'dist', suffix || 'index.html')).toString());
  }
  assert.equal(validation.mock.callCount(), 0);
});

test('malformed, unknown, foreign-origin and path-escaping media URLs cannot reach validation', async t => {
  const { validation } = fixture(t);
  for (const url of [
    'theatrum://app/media/thumbnails/unknown.jpg',
    'theatrum://app/media/thumbnails/known.mp4',
    'theatrum://app/media/other/known.jpg',
    'theatrum://app/media/thumbnails/%ZZ.jpg',
    'theatrum://app/media/thumbnails/%2e%2e%2fknown.jpg',
    'theatrum://app/media/thumbnails/known.jpg/extra',
    'theatrum://other/media/thumbnails/known.jpg',
    'https://app/media/thumbnails/known.jpg',
    'theatrum://app/%2e%2e%2foutside.txt',
  ]) {
    const response = await handler(new Request(url));
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), 'Not found.');
  }
  assert.equal(validation.mock.callCount(), 0);
  assert.equal(fetches.length, 0);
});

test('escaping symlinks, directories and missing previews fail closed before fetching', async t => {
  const { directory, filePath } = fixture(t);
  fs.unlinkSync(filePath);
  assert.equal((await handler(new Request(mediaUrl))).status, 404);
  fs.mkdirSync(filePath);
  assert.equal((await handler(new Request(mediaUrl))).status, 404);
  fs.rmdirSync(filePath);
  const outside = path.join(directory, 'outside.jpg');
  fs.writeFileSync(outside, 'not an authorized preview');
  fs.symlinkSync(outside, filePath);
  const response = await handler(new Request(mediaUrl));
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found.');
  assert.equal(fetches.length, 0);
});

for (const drift of ['hub name', 'output directory', 'hash set', 'hash membership'] as const) {
  test(`a pending canonical result cannot authorize media after ${drift} changes`, async t => {
    const { directory, filePath } = fixture(t);
    const entered = deferred(); const lookup = deferred<string>();
    t.mock.method(normalPreviewValidation, 'resolve', () => { entered.resolve(); return lookup.promise; });
    const response = handler(new Request(mediaUrl)); await entered.promise;
    if (drift === 'hub name') { GLOBALS.hubName = 'Other'; }
    if (drift === 'output directory') { GLOBALS.selectedOutputFolder = path.join(directory, 'other'); }
    if (drift === 'hash set') { GLOBALS.authorizedCatalogueImageHashes = new Set(['known']); }
    if (drift === 'hash membership') { GLOBALS.authorizedCatalogueImageHashes.delete('known'); }
    lookup.resolve(filePath);
    assert.equal((await response).status, 404);
    assert.equal(fetches.length, 0);
  });
}

test('a request aborted during canonical lookup cannot launch a late fetch', async t => {
  const { filePath } = fixture(t);
  const entered = deferred(); const lookup = deferred<string>(); const controller = new AbortController();
  let lookupSignal: AbortSignal;
  t.mock.method(normalPreviewValidation, 'resolve', (_file, _output, _assets, signal) => {
    lookupSignal = signal; entered.resolve(); return lookup.promise;
  });
  const request = new Request(mediaUrl, { signal: controller.signal });
  const response = handler(request); await entered.promise;
  assert.equal(lookupSignal.aborted, false);
  controller.abort();
  assert.equal(lookupSignal.aborted, true);
  lookup.resolve(filePath);
  assert.equal((await response).status, 404);
  assert.equal(fetches.length, 0);
});

test('range response status, headers and bytes remain intact with narrowly scoped development CORS', async t => {
  fixture(t, true);
  fetchFile = async () => new Response('cde', {
    status: 206, headers: { 'content-range': 'bytes 2-4/10', 'content-type': 'video/mp4' },
  });
  for (const origin of ['http://localhost:4200', 'https://untrusted.invalid']) {
    const response = await handler(new Request(mediaUrl, { headers: { origin, range: 'bytes=2-4' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('access-control-allow-origin'), origin === 'http://localhost:4200' ? origin : null);
    assert.equal(await response.text(), 'cde');
  }
});
