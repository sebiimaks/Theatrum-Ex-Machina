import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PrivateHubSession, PrivateHubPreviewResponseOptions } from './private-hub-session';
import type { PrivateHubPreviewKind } from './private-hub-catalogue';
import { createPrivateBrowserProtocolHandler, createPrivateUnlockProtocolHandler, isPrivateBrowserRequestAllowed,
  isPrivateUnlockRequestAllowed, PRIVATE_BROWSER_ENTRY_URL } from './private-browser-protocol';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: value => resolve(value) };
}

async function fixture(t: TestContext): Promise<{ root: string; app: string }> {
  const temporary = path.resolve(__dirname, '..', 'tmp');
  await fs.promises.mkdir(temporary, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(temporary, 'private-browser-protocol-'));
  const app = path.join(root, 'app');
  await fs.promises.mkdir(path.join(app, 'assets', 'i18n'), { recursive: true });
  await fs.promises.writeFile(path.join(app, 'index.html'), '<html>packaged private shell</html>');
  await fs.promises.writeFile(path.join(app, 'main.ABC123.js'), 'window.privateShell = true;');
  await fs.promises.writeFile(path.join(app, 'styles.css'), 'body { color: teal; }');
  await fs.promises.writeFile(path.join(app, 'assets', 'i18n', 'en.json'), '{"hello":"Hello"}');
  await fs.promises.writeFile(path.join(app, 'assets', 'icon.svg'), '<svg></svg>');
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return { root, app };
}

function hubStub(override: Partial<PrivateHubSession> = {}): PrivateHubSession {
  return { isCurrent: generation => generation === 7, createPreviewResponse: async () => new Response('encrypted preview'), ...override } as PrivateHubSession;
}

function request(suffix = '/index.html', init: RequestInit = {}): Request {
  return new Request('theatrum://app' + suffix, init);
}

function assertPrivate(response: Response): void {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  const csp = response.headers.get('Content-Security-Policy')!;
  for (const directive of ["default-src 'none'", "base-uri 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "media-src 'self'", "font-src 'self' data:", "connect-src 'self'",
    "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    assert.ok(csp.split('; ').includes(directive), directive);
  }
  assert.equal(response.headers.has('Access-Control-Allow-Origin'), false);
}

test('credential prompt routes expose only its three static assets with no hub or media authority', async t => {
  const { app } = await fixture(t);
  await fs.promises.writeFile(path.join(app, 'unlock.js'), 'window.synthetic = true;');
  await fs.promises.writeFile(path.join(app, 'unlock.css'), 'body { color: teal; }');
  let current = true;
  const handler = createPrivateUnlockProtocolHandler({ appDirectory: app, isCurrent: () => current });
  for (const route of ['/index.html', '/unlock.js', '/unlock.css']) {
    assert.equal(isPrivateUnlockRequestAllowed('theatrum://app' + route, 'GET'), true);
    const response = await handler(request(route));
    assert.equal(response.status, 200); assertPrivate(response);
  }
  for (const route of ['/main.ABC123.js', '/assets/i18n/en.json', '/media/thumbnails/video.jpg', '/media/clips/video.mp4']) {
    assert.equal(isPrivateUnlockRequestAllowed('theatrum://app' + route, 'GET'), false);
    assert.equal((await handler(request(route))).status, 404);
  }
  current = false;
  assert.equal((await handler(request('/index.html'))).status, 404);
  assert.equal(isPrivateUnlockRequestAllowed(PRIVATE_BROWSER_ENTRY_URL, 'POST'), false);
});

test('request allowlist accepts only own-origin distribution files and exact preview identities', () => {
  assert.equal(PRIVATE_BROWSER_ENTRY_URL, 'theatrum://app/index.html');
  for (const route of ['/index.html', '/main.ABC123.js', '/styles.css?v=2.0.0', '/assets/i18n/en.json', '/assets/icons/search.svg',
    '/assets/font.woff2', '/assets/picture.PNG', '/media/thumbnails/hash_1.jpg?v=abc-123', '/media/filmstrips/hash.jpg',
    '/media/clips/hash.jpg', '/media/clips/hash.mp4']) {
    for (const method of ['GET', 'HEAD']) { assert.equal(isPrivateBrowserRequestAllowed('theatrum://app' + route, method), true, route); }
  }
  for (const url of ['https://app/index.html', 'file:///index.html', 'theatrum://elsewhere/index.html', 'theatrum://app:80/index.html',
    'theatrum://user@app/index.html', 'theatrum://app.evil/index.html', 'THEATRUM://app/index.html',
    'theatrum://app//index.html', 'theatrum://app/assets/../main.js', 'theatrum://app/assets/%2e%2e/main.js',
    'theatrum://app/%2findex.html', 'theatrum://app/assets\\index.html', 'theatrum://app/index.html#fragment',
    'theatrum://app/', 'theatrum://app/other.html', 'theatrum://app/assets/index.html', 'theatrum://app/main.js.map',
    'theatrum://app/.secret.json', 'theatrum://app/media/thumbnails/hash.mp4', 'theatrum://app/media/clips/hash.jpeg',
    'theatrum://app/media/clips/hash.mp4/extra', 'theatrum://app/media/clips/hi%2Fthere.mp4',
    'theatrum://app/index.html?', 'theatrum://app/index.html?v=', 'theatrum://app/index.html?other=1',
    'theatrum://app/index.html?v=1&v=2', 'theatrum://app/index.html?v=%00', 'theatrum://app/index.html?v=%zz',
    'theatrum://app/index.html?v=' + 'x'.repeat(257), 'theatrum://app/' + 'a'.repeat(4096) + '.js']) {
    assert.equal(isPrivateBrowserRequestAllowed(url, 'GET'), false, url);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'get']) { assert.equal(isPrivateBrowserRequestAllowed(PRIVATE_BROWSER_ENTRY_URL, method), false); }
});

test('static resources have explicit MIME types, no-store policy, and strict private-window CSP', async t => {
  const { app } = await fixture(t);
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: app, isCurrent: () => true });
  for (const [route, type, value] of [['/index.html', 'text/html; charset=utf-8', '<html>packaged private shell</html>'],
    ['/main.ABC123.js', 'application/javascript; charset=utf-8', 'window.privateShell = true;'],
    ['/assets/i18n/en.json?v=1', 'application/json; charset=utf-8', '{"hello":"Hello"}'],
    ['/assets/icon.svg', 'image/svg+xml', '<svg></svg>']]) {
    const response = await handler(request(route));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), type);
    assert.equal(response.headers.get('Content-Length'), String(Buffer.byteLength(value)));
    assertPrivate(response);
    assert.equal(await response.text(), value);
  }
});

test('static HEAD authenticates file identity and size without reading its body', async t => {
  const { app } = await fixture(t);
  const open = fs.promises.open.bind(fs.promises);
  let bodyReads = 0;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', (...readArgs: Parameters<typeof handle.read>) => { bodyReads++; return read(...readArgs); });
    return handle;
  });
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: app, isCurrent: () => true });
  const response = await handler(request('/index.html', { method: 'HEAD' }));
  assert.equal(response.status, 200);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('Content-Length'), '35');
  assert.equal(bodyReads, 0);
  assertPrivate(response);
});

test('nonfiles, oversized files, symlinks, hard links and symlinked app roots are refused', async t => {
  const { root, app } = await fixture(t);
  const outside = path.join(root, 'outside.js');
  await fs.promises.writeFile(outside, 'OUTSIDE-SENSITIVE-CANARY');
  await fs.promises.symlink(outside, path.join(app, 'alias.js'));
  await fs.promises.symlink(root, path.join(app, 'escape'));
  await fs.promises.link(outside, path.join(app, 'hardlink.js'));
  await fs.promises.mkdir(path.join(app, 'directory.js'));
  const large = await fs.promises.open(path.join(app, 'large.js'), 'w');
  await large.truncate(8 * 1024 * 1024 + 1);
  await large.close();
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: app, isCurrent: () => true });
  for (const route of ['/alias.js', '/escape/outside.js', '/hardlink.js', '/directory.js', '/large.js', '/missing.js']) {
    const response = await handler(request(route));
    assert.equal(response.status, 404, route);
    assert.equal(await response.text(), '');
    assertPrivate(response);
  }
  const linkedRoot = path.join(root, 'linked-app');
  await fs.promises.symlink(app, linkedRoot);
  const linked = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: linkedRoot, isCurrent: () => true });
  assert.equal((await linked(request())).status, 404);
});

test('replacing the captured application directory invalidates later static reads', async t => {
  const { root, app } = await fixture(t);
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: app, isCurrent: () => true });
  await fs.promises.rename(app, path.join(root, 'old-app'));
  await fs.promises.mkdir(app);
  await fs.promises.writeFile(path.join(app, 'index.html'), 'REPLACEMENT-CANARY');
  assert.equal((await handler(request())).status, 404);
});

test('static read admission is capped at four and recovers after requests finish', async t => {
  const { app } = await fixture(t);
  const gate = deferred();
  const entered = deferred();
  const lstat = fs.promises.lstat.bind(fs.promises);
  let admitted = 0;
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof fs.promises.lstat>) => {
    if (args[0] === app && admitted < 4) {
      admitted++;
      if (admitted === 4) { entered.resolve(); }
      await gate.promise;
    }
    return lstat(...args);
  });
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: app, isCurrent: () => true });
  const pending = Array.from({ length: 4 }, () => handler(request()));
  await entered.promise;
  const overflow = await handler(request());
  assert.equal(overflow.status, 503);
  assertPrivate(overflow);
  assert.equal(admitted, 4);
  gate.resolve();
  for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); await response.text(); }
  assert.equal((await handler(request())).status, 200);
});

test('media routes use only the captured private session and do not prefetch or wrap preview streams', async t => {
  const { app } = await fixture(t);
  const kinds: PrivateHubPreviewKind[] = [];
  let pulls = 0;
  let active = true;
  let guard: () => boolean;
  const hub = hubStub({ createPreviewResponse: async (generation: number, kind: PrivateHubPreviewKind, hash: string, _request: Request, options: PrivateHubPreviewResponseOptions) => {
    assert.equal(generation, 7); assert.equal(hash, 'known'); kinds.push(kind); guard = options.isAuthorized!;
    return new Response(new ReadableStream<Uint8Array>({ pull: controller => {
      assert.equal(guard(), true); pulls++; controller.enqueue(Buffer.from('private')); controller.close();
    } }, { highWaterMark: 0 }), { status: 206, headers: { 'Content-Type': kind === 'clip' ? 'video/mp4' : 'image/jpeg', 'Content-Range': 'bytes 0-6/7' } });
  } });
  const handler = createPrivateBrowserProtocolHandler({ hub, generation: 7, appDirectory: app, isCurrent: () => active });
  for (const route of ['/media/thumbnails/known.jpg', '/media/filmstrips/known.jpg', '/media/clips/known.jpg', '/media/clips/known.mp4']) {
    const before = pulls;
    const response = await handler(request(route));
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 0-6/7'); assertPrivate(response);
    assert.equal(pulls, before, 'response security headers must not cause stream prefetch');
    assert.equal(await response.text(), 'private');
  }
  assert.deepEqual(kinds, ['thumbnail', 'filmstrip', 'clip-poster', 'clip']);
  active = false;
  assert.equal(guard!(), false);
});

test('locked or failed private media never falls back to files under the app directory or network fetch', async t => {
  const { app } = await fixture(t);
  await fs.promises.mkdir(path.join(app, 'media', 'thumbnails'), { recursive: true });
  await fs.promises.writeFile(path.join(app, 'media', 'thumbnails', 'known.jpg'), 'LEFTOVER-PLAINTEXT');
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('network fallback attempted'); });
  let unlocked = false;
  let calls = 0;
  const hub = hubStub({ isCurrent: () => unlocked, createPreviewResponse: async () => { calls++; throw new Error('/private/secret/path'); } });
  const handler = createPrivateBrowserProtocolHandler({ hub, generation: 7, appDirectory: app, isCurrent: () => true });
  assert.equal((await handler(request('/media/thumbnails/known.jpg'))).status, 404);
  assert.equal(calls, 0);
  unlocked = true;
  const failed = await handler(request('/media/thumbnails/known.jpg'));
  assert.equal(failed.status, 404); assert.equal(await failed.text(), ''); assertPrivate(failed);
  assert.equal(calls, 1); assert.equal(fetches, 0);
});

test('revocation while awaiting a media response cancels its unread body before handoff', async t => {
  const { app } = await fixture(t);
  const ready = deferred();
  const result = deferred<Response>();
  let active = true;
  let cancelled = 0;
  const hub = hubStub({ createPreviewResponse: async () => { ready.resolve(); return result.promise; } });
  const handler = createPrivateBrowserProtocolHandler({ hub, generation: 7, appDirectory: app, isCurrent: () => active });
  const pending = handler(request('/media/clips/known.mp4'));
  await ready.promise;
  active = false;
  result.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled++; } }, { highWaterMark: 0 })));
  const response = await pending;
  assert.equal(response.status, 404); assert.equal(await response.text(), ''); assert.equal(cancelled, 1);
});

test('static handoff rechecks authority after file close, including HEAD', async t => {
  const { app } = await fixture(t);
  const open = fs.promises.open.bind(fs.promises);
  let active = true;
  t.mock.method(fs.promises, 'open', async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); active = false; });
    return handle;
  });
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub(), generation: 7, appDirectory: app, isCurrent: () => active });
  for (const method of ['GET', 'HEAD']) {
    active = true;
    const response = await handler(request('/index.html', { method }));
    assert.equal(response.status, 404); assert.equal(await response.text(), '');
  }
});

test('capsule callback revocation, request aborts and unsupported methods fail closed with secure headers', async t => {
  const { app } = await fixture(t);
  let unlocked = true;
  const handler = createPrivateBrowserProtocolHandler({ hub: hubStub({ isCurrent: () => unlocked }), generation: 7, appDirectory: app,
    isCurrent: () => { unlocked = false; return true; } });
  assert.equal((await handler(request())).status, 404);
  const controller = new AbortController(); controller.abort('/secret/reason');
  const aborted = await handler(request('/index.html', { signal: controller.signal }));
  assert.equal(aborted.status, 404); assertPrivate(aborted);
  const unsupported = await handler(request('/index.html', { method: 'POST' }));
  assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.get('Allow'), 'GET, HEAD'); assertPrivate(unsupported);
});
