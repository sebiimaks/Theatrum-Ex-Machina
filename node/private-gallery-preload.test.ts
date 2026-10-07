import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PRIVATE_GALLERY_CHANNELS as channels } from '../interfaces/private-gallery';

const source = readFileSync(path.resolve(__dirname, '../private-gallery-preload.cjs'), 'utf8');
const item = () => ({ id: 'a'.repeat(32), title: 'Private video', duration: 12, width: 1920, height: 1080,
  rating: 4, favourite: false, tags: ['Birds'], thumbnailUrl: 'theatrum://app/media/thumbnails/hash-1.jpg',
  notes: 'Private notes', clipUrl: 'theatrum://app/media/clips/hash-1.mp4',
  posterUrl: 'theatrum://app/media/clips/hash-1.jpg', filmstripUrl: 'theatrum://app/media/filmstrips/hash-1.jpg',
  truncated: false, editable: true, regenerable: true, refreshable: true, playable: true, revision: 'b'.repeat(32) });
const page = () => ({ status: 'ready', total: 1, offset: 0, items: [item()] });
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function fixture(...results: unknown[]) {
  const result = results.length ? results[0] : page();
  const exposed: Record<string, any> = {};
  const invoked: unknown[][] = [];
  const sent: unknown[][] = [];
  const imported: string[] = [];
  let native = async (): Promise<unknown> => { if (result instanceof Error) { throw result; } return result; };
  runInNewContext(source, { require: (name: string) => {
    imported.push(name); assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { exposed[key] = value; } },
      ipcRenderer: { invoke: (...args: unknown[]) => { invoked.push(plain(args)); return native(); },
        send: (...args: unknown[]) => { sent.push(args); } } };
  } });
  return { bridge: exposed.privateGallery, credentials: exposed.privateCredentials, exposed, invoked, sent, imported,
    native: (next: typeof native) => { native = next; } };
}

test('sandbox preload keeps twenty-four gallery methods and exposes six separate frozen credential methods', () => {
  const f = fixture();
  assert.deepEqual(f.imported, ['electron']);
  assert.deepEqual(Object.keys(f.exposed), ['privateGallery', 'privateCredentials']);
  assert.deepEqual(Object.keys(f.credentials).sort(), ['cancelUnprotectedCopy', 'changePassword', 'createUnprotectedCopy', 'disableTouchId', 'enableTouchId', 'touchIdStatus']);
  assert.equal(Object.isFrozen(f.credentials), true);
  assert.deepEqual(Object.keys(f.bridge).sort(), ['ackOriginalPlayback', 'addSource', 'cancelImport', 'cancelRegeneration', 'cancelSourceConnection', 'checkSource', 'connectSource', 'detail', 'disconnectSource', 'importProgress', 'importVideo', 'list', 'lock', 'playOriginal', 'protection', 'refreshVideo', 'regenerate', 'relocateSource', 'resetPlaybackHistory', 'save', 'scanSource', 'setProtection', 'sources', 'stopOriginal']);
  assert.equal(Object.isFrozen(f.bridge), true);
  for (const key of ['ipc', 'on', 'send', 'invoke', 'files', 'clipboard', 'unlock', 'password', 'process']) {
    assert.equal(f.bridge[key], undefined);
  }
});

test('list sends only validated query/offset and strips unknown native fields and private detail text', async () => {
  const result = { ...page(), source: '/private/source', sender: { event: 'native' } };
  Object.assign(result.items[0], { fileName: 'secret.mp4', locations: ['/secret'] });
  const f = fixture(result);
  const value = await f.bridge.list({ query: 'Birds', offset: 0 });
  assert.deepEqual(plain(f.invoked), [[channels.list, { query: 'Birds', offset: 0 }]]);
  assert.equal(value.status, 'ready');
  assert.doesNotMatch(JSON.stringify(value), /secret|source|sender|locations|notes|posterUrl|clipUrl|filmstripUrl/);
  assert.equal(value.items[0].title, 'Private video');
});

test('detail copies the bounded display-only schema through its dedicated channel', async () => {
  const f = fixture({ status: 'ready', item: { ...item(), sourcePath: '/private/path', key: 'never' } });
  const value = await f.bridge.detail('a'.repeat(32));
  assert.deepEqual(f.invoked, [[channels.detail, 'a'.repeat(32)]]);
  assert.deepEqual(plain(value), { status: 'ready', item: item() });
});

test('fixed media URLs accept an optional exact opaque refresh token in every response mode', async () => {
  const version = '?v=' + '0123456789abcdef'.repeat(2);
  const versioned = item();
  versioned.thumbnailUrl += version;
  versioned.posterUrl += version;
  versioned.clipUrl += version;
  versioned.filmstripUrl += version;
  const listing = fixture({ ...page(), items: [versioned] });
  assert.equal((await listing.bridge.list({ query: '', offset: 0 })).items[0].thumbnailUrl, versioned.thumbnailUrl);
  for (const [mode, status] of [['detail', 'ready'], ['save', 'saved'], ['regenerate', 'generated'], ['refreshVideo', 'refreshed']]) {
    const f = fixture({ status, item: versioned });
    const request = mode === 'detail' ? versioned.id : ['regenerate', 'refreshVideo'].includes(mode)
      ? { id: versioned.id, revision: versioned.revision }
      : { id: versioned.id, revision: versioned.revision, notes: '', tags: [] };
    assert.deepEqual(plain(await f.bridge[mode](request)), { status, item: versioned });
  }
});

test('refresh URLs reject extra queries, encoding, fragments, malformed tokens and trailing characters', async () => {
  const token = 'a'.repeat(32);
  const suffixes = ['?', '?v=', '?v=' + 'a'.repeat(31), '?v=' + 'a'.repeat(33), '?v=' + 'a'.repeat(4096),
    '?v=' + 'A'.repeat(32), '?v=' + 'g'.repeat(32), '?V=' + token, '?source=' + token,
    '?v=' + token + '&v=' + token, '?v=' + token + '&source=private', '?source=private&v=' + token,
    '?v=' + token + '?v=' + token, '?%76=' + token, '?v=%61' + 'a'.repeat(31), '%3Fv=' + token,
    '?v=' + token + '#fragment', '#v=' + token, '?v=' + token + '/', '?v=' + token + '\0',
    '?v=' + token + '\n', '?v=' + token + '\r\n', '?v=' + token + '\u2028', '\n'];
  for (const key of ['thumbnailUrl', 'posterUrl', 'clipUrl', 'filmstripUrl'] as const) {
    for (const suffix of suffixes) {
      const malformed = { ...item(), [key]: item()[key] + suffix };
      const f = fixture({ status: 'ready', item: malformed });
      assert.deepEqual(plain(await f.bridge.detail(malformed.id)), { status: 'unavailable' }, key + JSON.stringify(suffix));
      if (key === 'thumbnailUrl') {
        const listing = fixture({ ...page(), items: [malformed] });
        assert.deepEqual(plain(await listing.bridge.list({ query: '', offset: 0 })), { status: 'unavailable' });
      }
    }
  }
});

test('invalid renderer arguments do not reach native IPC', async () => {
  const f = fixture();
  for (const args of [[], [null], [7], [{}], [{ query: '', offset: 1 }], [{ query: '', offset: -48 }],
    [{ query: '', offset: Infinity }], [{ query: 'x'.repeat(201), offset: 0 }], [{ query: '', offset: 0, source: '/secret' }],
    [{ query: '', offset: 0 }, 'extra']]) {
    assert.deepEqual(plain(await f.bridge.list(...args)), { status: 'unavailable' });
  }
  for (const args of [[], [null], [{}], ['../private'], ['g'.repeat(32)], ['a'.repeat(33)], ['a'.repeat(32), 'extra']]) {
    assert.deepEqual(plain(await f.bridge.detail(...args)), { status: 'unavailable' });
  }
  f.bridge.lock('extra');
  assert.deepEqual(f.invoked, []); assert.deepEqual(f.sent, []);
});

test('a renderer getter failure becomes a generic status without invoking native code', async () => {
  const f = fixture();
  assert.deepEqual(plain(await f.bridge.list({ offset: 0, get query() { throw new Error('secret'); } })), { status: 'unavailable' });
  assert.deepEqual(f.invoked, []);
});

test('native exceptions and malformed results expose no native error or event details', async () => {
  for (const result of [null, undefined, true, 'private', new Error('/secret/key'), { status: 'unavailable', error: 'private' },
    { status: 'busy', sender: { path: 'private' } }, { status: 'ready', total: -1, offset: 0, items: [] },
    { ...page(), items: Array(49).fill(item()) }, { ...page(), offset: 1 }, { ...page(), total: 100_001 }]) {
    const f = fixture(result);
    const response = plain(await f.bridge.list({ query: '', offset: 0 }));
    assert.deepEqual(response, { status: (result as any)?.status === 'busy' ? 'busy' : 'unavailable' });
  }
});

test('malformed metadata and external preview URLs are never returned to the page', async () => {
  for (const patch of [
    { id: '/private' }, { title: 'x'.repeat(2049) }, { tags: ['x'.repeat(513)] }, { tags: Array(129).fill('tag') },
    { duration: Infinity }, { width: -1 }, { rating: 6 }, { favourite: 'true' },
    { thumbnailUrl: 'file:///private.jpg' }, { thumbnailUrl: 'https://app/media/thumbnails/hash.jpg' },
    { thumbnailUrl: 'theatrum://app/media/thumbnails/hash.jpg?source=private' },
  ]) {
    const f = fixture({ ...page(), items: [{ ...item(), ...patch }] });
    assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'unavailable' });
  }
  for (const patch of [{ notes: 'x'.repeat(65_537) }, { truncated: 'true' }, { clipUrl: 'https://private/video.mp4' },
    { posterUrl: 'theatrum://app/media/clips/../private.jpg' }, { editable: 'true' }, { revision: 'bad' },
    { filmstripUrl: undefined }, { filmstripUrl: 'file:///private/strip.jpg' },
    { filmstripUrl: 'https://app/media/filmstrips/hash-1.jpg' }, { filmstripUrl: 'theatrum://other/media/filmstrips/hash-1.jpg' },
    { filmstripUrl: 'theatrum://app/media/clips/hash-1.jpg' }, { filmstripUrl: 'theatrum://app/media/filmstrips/hash-1.mp4' },
    { filmstripUrl: 'theatrum://app/media/filmstrips/../private.jpg' }]) {
    const f = fixture({ status: 'ready', item: { ...item(), ...patch } });
    assert.deepEqual(plain(await f.bridge.detail('a'.repeat(32))), { status: 'unavailable' });
  }
});

test('only one request is outstanding and lock discards a late display response permanently', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const first = f.bridge.list({ query: '', offset: 0 });
  assert.deepEqual(plain(await f.bridge.detail('a'.repeat(32))), { status: 'busy' });
  f.bridge.lock(); f.bridge.lock();
  assert.deepEqual(f.sent, [[channels.lock]]);
  resolve(page());
  assert.deepEqual(plain(await first), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'unavailable' });
  assert.equal(f.invoked.length, 1);
});

test('native request failure releases admission so the user can retry', async () => {
  const f = fixture(new Error('private'));
  assert.equal((await f.bridge.list({ query: '', offset: 0 })).status, 'unavailable');
  f.native(async () => page());
  assert.equal((await f.bridge.list({ query: '', offset: 0 })).status, 'ready');
});

test('save sends a copied notes/tags request and returns only whitelisted detail metadata', async () => {
  const f = fixture({ status: 'saved', item: { ...item(), fileName: '/secret/video', key: 'never' } });
  const request = { id: item().id, revision: item().revision, notes: '<b>literal</b>', tags: ['Legacy, literal'] };
  const value = await f.bridge.save(request);
  assert.deepEqual(plain(value), { status: 'saved', item: item() });
  assert.deepEqual(plain(f.invoked), [[channels.save, request]]);
  request.tags.push('Later mutation');
  assert.deepEqual(plain(f.invoked[0][1]), { ...request, tags: ['Legacy, literal'] });
});

test('invalid metadata edits never reach native IPC', async () => {
  const f = fixture();
  const request = { id: item().id, revision: item().revision, notes: '', tags: [] };
  for (const args of [[], [null], [{}], [request, 'extra'], [{ ...request, source: '/secret' }],
    [{ ...request, id: 'bad' }], [{ ...request, revision: 'c'.repeat(64) }], [{ ...request, notes: 'n'.repeat(65_537) }],
    [{ ...request, notes: null }], [{ ...request, tags: Array(129).fill('tag') }], [{ ...request, tags: ['t'.repeat(513)] }],
    [{ ...request, tags: [undefined] }], [{ ...request, get notes() { throw new Error('/secret'); } }]]) {
    assert.deepEqual(plain(await f.bridge.save(...args)), { status: 'unavailable' });
  }
  assert.equal(f.invoked.length, 0);
});

test('save statuses expose no errors and malformed saved details are rejected', async () => {
  for (const status of ['conflict', 'invalid', 'busy', 'unavailable']) {
    const f = fixture({ status, error: '/private', sender: 'native' });
    assert.deepEqual(plain(await f.bridge.save({ id: item().id, revision: item().revision, notes: '', tags: [] })), { status });
  }
  for (const result of [{ status: 'ready', item: item() }, { status: 'saved', item: { ...item(), revision: 'invalid' } },
    { status: 'saved', item: { ...item(), notes: 'x'.repeat(65_537) } }, new Error('/secret')]) {
    const f = fixture(result);
    assert.deepEqual(plain(await f.bridge.save({ id: item().id, revision: item().revision, notes: '', tags: [] })), { status: 'unavailable' });
  }
});

test('locking during save permanently suppresses its result and further reads or writes', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const request = { id: item().id, revision: item().revision, notes: 'Draft', tags: [] };
  const saving = f.bridge.save(request);
  assert.deepEqual(plain(await f.bridge.save(request)), { status: 'busy' });
  assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'busy' });
  f.bridge.lock();
  resolve({ status: 'saved', item: item() });
  assert.deepEqual(plain(await saving), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.save(request)), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.detail(item().id)), { status: 'unavailable' });
  assert.equal(f.invoked.length, 1);
});

test('regeneration exposes only issued selection/revision and sanitized result metadata', async () => {
  const f = fixture({ status: 'generated', item: { ...item(), path: '/secret', command: 'private' } });
  const request = { id: item().id, revision: item().revision };
  assert.deepEqual(plain(await f.bridge.regenerate(request)), { status: 'generated', item: item() });
  assert.deepEqual(plain(f.invoked), [[channels.regenerate, request]]);
  for (const status of ['cancelled', 'conflict', 'wrong-folder', 'source-unavailable', 'busy', 'unavailable']) {
    f.native(async () => ({ status, path: '/secret' }));
    assert.deepEqual(plain(await f.bridge.regenerate(request)), { status });
  }
});

test('invalid regeneration payloads never choose a channel, source path or native operation', async () => {
  const f = fixture();
  for (const args of [[], [null], [{}], [{ id: item().id, revision: item().revision, path: '/secret' }],
    [{ id: item().id, revision: 'bad' }], [{ id: item().id, revision: item().revision }, 'extra'],
    [{ revision: item().revision, get id() { throw new Error('/secret'); } }]]) {
    assert.deepEqual(plain(await f.bridge.regenerate(...args)), { status: 'unavailable' });
  }
  f.bridge.cancelRegeneration(); assert.equal(f.invoked.length, 0); assert.equal(f.sent.length, 0);
});

test('cancel bypasses busy admission only for the current regeneration and never releases its pending hold', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const listing = f.bridge.list({ query: '', offset: 0 });
  f.bridge.cancelRegeneration(); assert.equal(f.sent.length, 0);
  resolve(page()); await listing;
  const work = f.bridge.regenerate({ id: item().id, revision: item().revision });
  f.bridge.cancelRegeneration('extra'); assert.equal(f.sent.length, 0);
  f.bridge.cancelRegeneration(); f.bridge.cancelRegeneration();
  assert.deepEqual(f.sent, [[channels.cancelRegeneration]]);
  assert.deepEqual(plain(await f.bridge.detail(item().id)), { status: 'busy' });
  resolve({ status: 'cancelled' }); assert.deepEqual(plain(await work), { status: 'cancelled' });
  f.bridge.cancelRegeneration(); assert.equal(f.sent.length, 1);
});

test('locking suppresses regeneration completion and malformed success cannot leak native metadata', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const work = f.bridge.regenerate({ id: item().id, revision: item().revision });
  f.bridge.lock(); f.bridge.cancelRegeneration();
  resolve({ status: 'generated', item: item() });
  assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]);
  const malformed = fixture({ status: 'generated', item: { ...item(), regenerable: 'true' } });
  assert.deepEqual(plain(await malformed.bridge.regenerate({ id: item().id, revision: item().revision })), { status: 'unavailable' });
});

test('protection methods use dedicated bounded channels and strip native-only fields', async () => {
  const f = fixture({ status: 'ready', autoLockMinutes: 5, path: '/secret', password: 'secret' });
  assert.deepEqual(plain(await f.bridge.protection()), { status: 'ready', autoLockMinutes: 5, recordPlaybackHistory: false });
  assert.deepEqual(f.invoked, [[channels.protection]]);
  for (const minutes of [0, 1, 5, 15, 30]) {
    f.native(async () => ({ status: 'saved', autoLockMinutes: minutes, path: '/secret' }));
    assert.deepEqual(plain(await f.bridge.setProtection({ autoLockMinutes: minutes })), { status: 'saved', autoLockMinutes: minutes, recordPlaybackHistory: false });
    assert.deepEqual(plain(f.invoked.at(-1)), [channels.setProtection, { autoLockMinutes: minutes }]);
  }
});

test('protection rejects invalid arguments, getters and malformed native settings', async () => {
  const f = fixture();
  const accessor = { get autoLockMinutes() { throw new Error('must not read accessor'); } };
  for (const value of [undefined, null, [], {}, { autoLockMinutes: '5' }, { autoLockMinutes: -1 },
    { autoLockMinutes: 2 }, { autoLockMinutes: Infinity }, { autoLockMinutes: 5, path: '/secret' }, accessor]) {
    assert.deepEqual(plain(await f.bridge.setProtection(value)), { status: 'unavailable' });
  }
  assert.deepEqual(plain(await f.bridge.protection('extra')), { status: 'unavailable' });
  assert.deepEqual(f.invoked, []);
  for (const value of [{ status: 'ready', autoLockMinutes: 2 }, { status: 'saved', autoLockMinutes: 5 },
    { status: 'ready', autoLockMinutes: '5' }, null]) {
    f.native(async () => value);
    assert.deepEqual(plain(await f.bridge.protection()), { status: 'unavailable' });
  }
});

test('pending protection work shares admission and cannot complete after lock', async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const writing = f.bridge.setProtection({ autoLockMinutes: 1 });
  assert.deepEqual(plain(await f.bridge.protection()), { status: 'busy' });
  assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'busy' });
  f.bridge.cancelRegeneration();
  assert.equal(f.sent.length, 0);
  f.bridge.lock();
  resolve({ status: 'saved', autoLockMinutes: 1 });
  assert.deepEqual(plain(await writing), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.protection()), { status: 'unavailable' });
});

const passwordChange = () => ({ currentPassword: 'Current synthetic password', newPassword: 'Replacement synthetic password' });

test('credential bridge sends only an exact copied request on its fixed channel and strips native secrets', async () => {
  const f = fixture({ status: 'incorrect-password', currentPassword: 'do not echo', path: '/secret' });
  const request = passwordChange();
  assert.deepEqual(plain(await f.credentials.changePassword(request)), { status: 'incorrect-password' });
  assert.deepEqual(f.invoked, [[channels.changePassword, passwordChange()]]);
  assert.deepEqual(request, passwordChange(), 'The caller retains its own object; only bridge copies are cleared');
  for (const newPassword of ['é'.repeat(512), '🦉'.repeat(256), ' leading and trailing ', 'n'.repeat(1024)]) {
    assert.deepEqual(plain(await f.credentials.changePassword({ ...request, newPassword })), { status: 'incorrect-password' });
    assert.equal((f.invoked.at(-1)![1] as any).newPassword, newPassword);
  }
});

test('credential bridge never invokes getters or forwards malformed and oversized password arguments', async () => {
  const f = fixture(); let reads = 0;
  const accessor = { get currentPassword() { reads++; throw new Error('private'); }, newPassword: 'valid' };
  const hidden = Object.defineProperty(passwordChange(), 'hidden', { value: 'private' });
  for (const args of [[], [null], [[]], [{}], [passwordChange(), 'extra'], [accessor], [hidden],
    [{ ...passwordChange(), [Symbol('extra')]: 'private' }], [Object.create(passwordChange())],
    [{ ...passwordChange(), channel: 'native' }], [{ ...passwordChange(), currentPassword: '' }],
    [{ ...passwordChange(), currentPassword: 'x'.repeat(1025) }], [{ ...passwordChange(), newPassword: 'é'.repeat(513) }],
    [{ ...passwordChange(), newPassword: '🦉'.repeat(257) }], [{ ...passwordChange(), newPassword: '\ud800' }],
    [{ ...passwordChange(), newPassword: '\udc00' }], [{ currentPassword: 'same', newPassword: 'same' }],
    [new Proxy({}, { ownKeys() { throw new Error('private'); } })]]) {
    assert.deepEqual(plain(await f.credentials.changePassword(...args)), { status: 'invalid' });
  }
  assert.equal(reads, 0); assert.deepEqual(f.invoked, []);
});

test('credential responses allow only bounded statuses and release failed admission for retry', async () => {
  for (const status of ['changed', 'incorrect-password', 'invalid', 'busy', 'unavailable']) {
    const f = fixture({ status, password: 'private', event: 'native' });
    assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status });
  }
  for (const result of [null, undefined, [], true, 'changed', new Error('/secret'), { status: 'saved' },
    { status: 'ready', password: 'private' }, { get status() { throw new Error('private'); } }]) {
    const f = fixture(result);
    assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'unavailable' });
    f.native(async () => ({ status: 'incorrect-password' }));
    assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'incorrect-password' });
  }
});

test('credential work shares all gallery admission gates and Lock suppresses late change success', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const changing = f.credentials.changePassword(passwordChange());
  assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'busy' });
  for (const [method, args] of [
    ['list', [{ query: '', offset: 0 }]], ['detail', [item().id]],
    ['save', [{ id: item().id, revision: item().revision, notes: '', tags: [] }]],
    ['regenerate', [{ id: item().id, revision: item().revision }]], ['refreshVideo', [{ id: item().id, revision: item().revision }]], ['protection', []],
    ['setProtection', [{ autoLockMinutes: 1 }]],
  ] as const) {
    assert.deepEqual(plain(await f.bridge[method](...args)), { status: 'busy' });
  }
  f.bridge.cancelRegeneration(); assert.deepEqual(f.sent, []);
  f.bridge.lock(); finish({ status: 'changed' });
  assert.deepEqual(plain(await changing), { status: 'unavailable' });
  assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]); assert.equal(f.invoked.length, 1);
});

test('pending gallery requests prevent credential IPC and incorrect passwords permit retries', async () => {
  for (const [method, args] of [['list', [{ query: '', offset: 0 }]], ['protection', []],
    ['regenerate', [{ id: item().id, revision: item().revision }]], ['refreshVideo', [{ id: item().id, revision: item().revision }]]] as const) {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.native(() => new Promise(resolve => { finish = resolve; }));
    const work = f.bridge[method](...args);
    assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'busy' });
    assert.equal(f.invoked.length, 1); finish({ status: 'unavailable' }); await work;
    f.native(async () => ({ status: 'incorrect-password' }));
    assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'incorrect-password' });
    assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'incorrect-password' });
  }
});

test('successful credential changes retire both preload surfaces even if the page remains alive', async () => {
  const f = fixture({ status: 'changed' });
  assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'changed' });
  assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'unavailable' });
  f.bridge.lock(); f.bridge.cancelRegeneration();
  assert.deepEqual(f.sent, []); assert.equal(f.invoked.length, 1);
});


const plaintextCopy = () => ({ password: 'Synthetic source password', acknowledge: true });

test('copy preload exposes only its fixed credential channel and bounded statuses', async () => {
  const f = fixture();
  for (const status of ['copied', 'incorrect-password', 'cancelled', 'failed', 'invalid', 'busy', 'unavailable']) {
    f.native(async () => ({ status, password: 'never echo', path: '/private/destination' }));
    const caller = plaintextCopy();
    assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(caller)), { status });
    assert.deepEqual(f.invoked.at(-1), [channels.createUnprotectedCopy, caller]);
    assert.deepEqual(caller, plaintextCopy());
  }
  f.native(async () => page());
  assert.equal((await f.bridge.list({ query: '', offset: 0 })).status, 'ready');
});

test('copy credentials require exact data properties, affirmative acknowledgement and bounded valid UTF-8', async () => {
  const f = fixture(); let reads = 0;
  const accessor = { get password() { reads++; throw new Error('private'); }, acknowledge: true };
  const hidden = Object.defineProperty(plaintextCopy(), 'hidden', { value: 'private' });
  for (const args of [[], [null], [[]], [{}], [plaintextCopy(), 'extra'], [accessor], [hidden],
    [{ ...plaintextCopy(), [Symbol('extra')]: 'private' }], [Object.create(plaintextCopy())],
    [{ ...plaintextCopy(), destination: '/secret' }], [{ password: '', acknowledge: true }],
    [{ password: 'é'.repeat(513), acknowledge: true }], [{ password: '\ud800', acknowledge: true }],
    [{ password: 'valid', acknowledge: false }], [{ password: 'valid', acknowledge: 'true' }],
    [new Proxy({}, { ownKeys() { throw new Error('private'); } })]]) {
    assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(...args)), { status: 'invalid' });
  }
  assert.equal(reads, 0); assert.deepEqual(f.invoked, []);
  f.native(async () => ({ status: 'incorrect-password' }));
  for (const password of ['é'.repeat(512), '🦉'.repeat(256), ' exact spacing ', 'x'.repeat(1024)]) {
    assert.deepEqual(plain(await f.credentials.createUnprotectedCopy({ password, acknowledge: true })), { status: 'incorrect-password' });
    assert.equal((f.invoked.at(-1)![1] as any).password, password);
  }
});

test('copy malformed responses and native exceptions reveal no diagnostics and allow retry', async () => {
  for (const result of [null, undefined, [], true, 'copied', new Error('/secret'), { status: 'changed' },
    { status: 'ready', password: 'private' }, { get status() { throw new Error('private'); } }]) {
    const f = fixture(result);
    assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(plaintextCopy())), { status: 'unavailable' });
    f.native(async () => ({ status: 'copied' }));
    assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(plaintextCopy())), { status: 'copied' });
  }
});

test('copy preload shares admission, sends cancel once only for its own operation, and keeps Lock available', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  f.credentials.cancelUnprotectedCopy();
  const copying = f.credentials.createUnprotectedCopy(plaintextCopy());
  assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(plaintextCopy())), { status: 'busy' });
  assert.deepEqual(plain(await f.credentials.changePassword(passwordChange())), { status: 'busy' });
  for (const [method, args] of [
    ['list', [{ query: '', offset: 0 }]], ['detail', [item().id]],
    ['save', [{ id: item().id, revision: item().revision, notes: '', tags: [] }]],
    ['regenerate', [{ id: item().id, revision: item().revision }]], ['refreshVideo', [{ id: item().id, revision: item().revision }]], ['protection', []],
    ['setProtection', [{ autoLockMinutes: 1 }]],
  ] as const) {
    assert.deepEqual(plain(await f.bridge[method](...args)), { status: 'busy' });
  }
  f.bridge.cancelRegeneration(); f.credentials.cancelUnprotectedCopy('extra'); assert.deepEqual(f.sent, []);
  f.credentials.cancelUnprotectedCopy(); f.credentials.cancelUnprotectedCopy();
  assert.deepEqual(f.sent, [[channels.cancelUnprotectedCopy]]);
  assert.deepEqual(plain(await f.bridge.protection()), { status: 'busy' });
  f.bridge.lock(); f.credentials.cancelUnprotectedCopy(); finish({ status: 'copied' });
  assert.deepEqual(plain(await copying), { status: 'unavailable' });
  assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(plaintextCopy())), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.cancelUnprotectedCopy], [channels.lock]]);
});

test('copy cancellation is ignored during other operations and resets for a later copy', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const changing = f.credentials.changePassword(passwordChange());
  f.credentials.cancelUnprotectedCopy();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(plain(await f.credentials.createUnprotectedCopy(plaintextCopy())), { status: 'busy' });
  finish({ status: 'incorrect-password' }); await changing;
  for (let attempt = 0; attempt < 2; attempt++) {
    const copying = f.credentials.createUnprotectedCopy(plaintextCopy());
    f.credentials.cancelUnprotectedCopy(); finish({ status: 'cancelled' });
    assert.deepEqual(plain(await copying), { status: 'cancelled' });
    f.credentials.cancelUnprotectedCopy();
  }
  assert.deepEqual(f.sent, [[channels.cancelUnprotectedCopy], [channels.cancelUnprotectedCopy]]);
});


test('Touch ID status and disable carry no arguments and expose only fixed outcomes', async () => {
  for (const state of ['enabled', 'disabled']) {
    const f = fixture({ outcome: 'available', state, key: '/private', provider: 'secret' });
    assert.deepEqual(plain(await f.credentials.touchIdStatus()), { outcome: 'available', state });
    assert.deepEqual(f.invoked, [['private-credentials-touch-id-status']]);
  }
  const f = fixture({ outcome: 'disabled', key: '/private' });
  assert.deepEqual(plain(await f.credentials.disableTouchId()), { outcome: 'disabled' });
  assert.deepEqual(f.invoked, [['private-credentials-touch-id-disable']]);
  for (const method of ['touchIdStatus', 'disableTouchId']) {
    const invalid = fixture();
    assert.deepEqual(plain(await invalid.credentials[method]('extra')), { outcome: 'unavailable' });
    assert.deepEqual(invalid.invoked, []);
  }
});

test('Touch ID enrollment sends a copied exact password and sanitizes outcomes', async () => {
  for (const outcome of ['enabled', 'incorrect-password', 'cancelled', 'unavailable']) {
    const f = fixture({ outcome, key: '/private', error: 'secret' });
    const request = { password: '  Synthetic 🐦 password  ' };
    assert.deepEqual(plain(await f.credentials.enableTouchId(request)), { outcome });
    assert.deepEqual(f.invoked, [['private-credentials-touch-id-enable', request]]);
    assert.equal(request.password, '  Synthetic 🐦 password  ', 'Caller-owned input is not mutated');
  }
});

test('Touch ID enrollment rejects malformed credentials and accessors without reading them', async () => {
  let reads = 0;
  const f = fixture();
  for (const args of [[], [null], [7], [{}], [{ password: '' }], [{ password: '\ud800' }],
    [{ password: 'é'.repeat(513) }], [{ password: 'synthetic', source: '/private' }],
    [{ get password() { reads++; return 'synthetic'; } }], [{ password: 'synthetic', [Symbol()]: true }],
    [{ password: 'synthetic' }, 'extra']]) {
    assert.deepEqual(plain(await f.credentials.enableTouchId(...args)), { outcome: 'unavailable' });
  }
  assert.equal(reads, 0); assert.deepEqual(f.invoked, []);
});

test('Touch ID rejects errors, unexpected outcome objects and states without exposing their contents', async () => {
  for (const result of [null, undefined, [], true, 'enabled', new Error('/private'), { outcome: 'available', state: '/private' },
    { outcome: 'enabled', state: 'enabled' }, { outcome: 'disabled' }, { outcome: 'cancelled' },
    { outcome: 'incorrect-password' }, { outcome: 'available', state: 'enabled' }]) {
    for (const method of ['touchIdStatus', 'enableTouchId', 'disableTouchId']) {
      const f = fixture(result);
      const value = plain(await f.credentials[method](...(method === 'enableTouchId' ? [{ password: 'synthetic' }] : [])));
      assert.doesNotMatch(JSON.stringify(value), /private|secret|key|provider|error/);
      if (method === 'touchIdStatus') {
        assert.deepEqual(value, (result as any)?.outcome === 'available' && (result as any)?.state === 'enabled'
          ? { outcome: 'available', state: 'enabled' } : { outcome: 'unavailable' });
      }
    }
  }
});

test('Touch ID shares gallery admission and lock suppresses late enrollment results', async () => {
  for (const method of ['touchIdStatus', 'enableTouchId', 'disableTouchId']) {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.native(() => new Promise(resolve => { finish = resolve; }));
    const operation = f.credentials[method](...(method === 'enableTouchId' ? [{ password: 'synthetic' }] : []));
    assert.deepEqual(plain(await f.bridge.protection()), { status: 'busy' });
    assert.deepEqual(plain(await f.credentials.enableTouchId({ password: 'other' })), { outcome: 'unavailable' });
    assert.deepEqual(plain(await f.credentials.disableTouchId()), { outcome: 'unavailable' });
    f.bridge.lock();
    finish({ outcome: method === 'touchIdStatus' ? 'available' : method === 'enableTouchId' ? 'enabled' : 'disabled', state: 'enabled' });
    assert.deepEqual(plain(await operation), { outcome: 'unavailable' });
    assert.deepEqual(plain(await f.credentials.touchIdStatus()), { outcome: 'unavailable' });
    assert.equal(f.invoked.length, 1);
  }
});


test('Touch ID status snapshots only validated native outcome and state primitives', async () => {
  let outcomeReads = 0; let stateReads = 0;
  const f = fixture({ get outcome() { return ++outcomeReads === 1 ? 'available' : '/private'; },
    get state() { return ++stateReads === 1 ? 'enabled' : '/private'; } });
  assert.deepEqual(plain(await f.credentials.touchIdStatus()), { outcome: 'available', state: 'enabled' });
  assert.equal(outcomeReads, 1); assert.equal(stateReads, 1);
});


const sourceFolder = () => ({ id: 'c'.repeat(32), title: 'Source folder 1', videoCount: 20, connected: false });

test('source methods send exact bounded requests and strip paths, native indices and unknown reply fields', async () => {
  const folder = sourceFolder();
  const f = fixture({ status: 'ready', items: [{ ...folder, root: '/private/path', index: 3, identity: 'secret' }], path: '/secret' });
  assert.deepEqual(plain(await f.bridge.sources()), { status: 'ready', items: [folder] });
  assert.deepEqual(f.invoked, [[channels.sources]]);
  f.native(async () => ({ status: 'connected', item: { ...folder, connected: true, path: '/secret' } }));
  assert.deepEqual(plain(await f.bridge.connectSource(folder.id)), { status: 'connected', item: { ...folder, connected: true } });
  f.native(async () => ({ status: 'disconnected', item: { ...folder, path: '/secret' } }));
  assert.deepEqual(plain(await f.bridge.disconnectSource(folder.id)), { status: 'disconnected', item: folder });
  assert.deepEqual(f.invoked.slice(1), [[channels.connectSource, folder.id], [channels.disconnectSource, folder.id]]);
});

test('source preload rejects forged request shapes and malformed or excessive reply projections', async () => {
  const f = fixture();
  for (const method of ['connectSource', 'disconnectSource', 'relocateSource', 'importVideo', 'scanSource']) {
    for (const args of [[], ['/private/path'], [{ id: 'c'.repeat(32) }], ['c'.repeat(32), 'extra']]) {
      assert.deepEqual(plain(await f.bridge[method](...args)), { status: 'unavailable' });
    }
  }
  assert.deepEqual(plain(await f.bridge.sources(undefined)), { status: 'unavailable' });
  assert.equal(f.invoked.length, 0);
  for (const items of [
    [sourceFolder(), sourceFolder()], Array.from({ length: 257 }, sourceFolder),
    [{ ...sourceFolder(), title: '/secret/source' }], [{ ...sourceFolder(), title: 'Source folder 257' }], [{ ...sourceFolder(), title: 'Source folder 1\n' }],
    [{ ...sourceFolder(), videoCount: 100_001 }], [{ ...sourceFolder(), videoCount: 1.5 }],
    [{ ...sourceFolder(), connected: 'yes' }], [{ ...sourceFolder(), id: 'native-index' }],
  ]) {
    f.native(async () => ({ status: 'ready', items }));
    assert.deepEqual(plain(await f.bridge.sources()), { status: 'unavailable' });
  }
  f.native(async () => ({ status: 'connected', item: sourceFolder() }));
  assert.deepEqual(plain(await f.bridge.connectSource(sourceFolder().id)), { status: 'unavailable' });
  f.native(async () => ({ status: 'disconnected', item: { ...sourceFolder(), connected: true } }));
  assert.deepEqual(plain(await f.bridge.disconnectSource(sourceFolder().id)), { status: 'unavailable' });
});

test('source cancellation is one-way, coalesced and gated while shared requests are pending', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.connectSource(sourceFolder().id);
  assert.deepEqual(plain(await f.bridge.sources()), { status: 'busy' });
  assert.deepEqual(plain(await f.bridge.protection()), { status: 'busy' });
  assert.deepEqual(plain(await f.credentials.changePassword({ currentPassword: 'current', newPassword: 'replacement' })), { status: 'busy' });
  f.bridge.cancelSourceConnection('extra');
  f.bridge.cancelRegeneration();
  assert.equal(f.sent.length, 0);
  f.bridge.cancelSourceConnection(); f.bridge.cancelSourceConnection();
  assert.deepEqual(f.sent, [[channels.cancelSourceConnection]]);
  finish({ status: 'cancelled', path: '/secret' });
  assert.deepEqual(plain(await work), { status: 'cancelled' });
  f.bridge.cancelSourceConnection();
  assert.equal(f.sent.length, 1);
  assert.equal(f.invoked.length, 1);
});

test('source lock discards late connection response and prevents further requests and cancellation', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.connectSource(sourceFolder().id);
  f.bridge.lock();
  finish({ status: 'connected', item: { ...sourceFolder(), connected: true } });
  assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.sources()), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.disconnectSource(sourceFolder().id)), { status: 'unavailable' });
  f.bridge.cancelSourceConnection();
  assert.deepEqual(f.sent, [[channels.lock]]);
  assert.equal(f.invoked.length, 1);
});

test('relocation exposes only an allowlisted status and one opaque source ID', async () => {
  for (const status of ['relocated', 'cancelled', 'conflict', 'invalid', 'source-unavailable', 'busy', 'unavailable']) {
    const f = fixture({ status, root: '/secret', digest: 'secret', review: { path: '/secret' } });
    assert.deepEqual(plain(await f.bridge.relocateSource(sourceFolder().id)), { status });
    assert.deepEqual(f.invoked, [[channels.relocateSource, sourceFolder().id]]);
  }
  for (const result of [null, undefined, true, [], '/secret', { status: 'ready', path: '/secret' }, new Error('/secret')]) {
    const f = fixture(result);
    assert.deepEqual(plain(await f.bridge.relocateSource(sourceFolder().id)), { status: 'unavailable' });
  }
});

test('relocation shares the pending gate and source cancellation without exposing a late result after lock', async () => {
  for (const locking of [false, true]) {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.native(() => new Promise(resolve => { finish = resolve; }));
    const work = f.bridge.relocateSource(sourceFolder().id);
    for (const operation of [() => f.bridge.sources(), () => f.bridge.connectSource(sourceFolder().id),
      () => f.bridge.relocateSource(sourceFolder().id), () => f.bridge.list({ query: '', offset: 0 })]) {
      assert.deepEqual(plain(await operation()), { status: 'busy' });
    }
    f.bridge.cancelSourceConnection('extra'); f.bridge.cancelRegeneration();
    assert.equal(f.sent.length, 0);
    f.bridge.cancelSourceConnection(); f.bridge.cancelSourceConnection();
    assert.deepEqual(f.sent, [[channels.cancelSourceConnection]]);
    if (locking) { f.bridge.lock(); }
    finish({ status: 'relocated', root: '/secret' });
    assert.deepEqual(plain(await work), { status: locking ? 'unavailable' : 'relocated' });
    f.bridge.cancelSourceConnection();
    assert.equal(f.sent.length, locking ? 2 : 1);
  }
});


test('original playback uses its narrow request and strips all fields except the opaque URL', async () => {
  const url = 'theatrum://app/original/' + '0123456789abcdef'.repeat(4);
  const f = fixture({ status: 'ready', url, path: '/private/source', fd: 12 });
  const request = { id: 'a'.repeat(32), revision: 'b'.repeat(32) };
  assert.deepEqual(plain(await f.bridge.playOriginal(request)), { status: 'ready', url });
  assert.deepEqual(f.invoked, [[channels.playOriginal, request]]);
  f.bridge.stopOriginal(); assert.deepEqual(f.sent, [[channels.stopOriginal]]);
});

test('original playback accepts only the exact capability origin, path and 64 lowercase hex token', async () => {
  const valid = 'theatrum://app/original/' + 'a'.repeat(64);
  const urls = ['', 'file:///private/source.mp4', 'https://example.com/video', valid + '\n', valid + '\0',
    valid + '?v=1', valid + '#fragment', valid + '/', valid.slice(0, -1), valid + 'a',
    valid.replace('app', 'other'), valid.replace('app/', 'app:80/'), valid.replace('app/', 'user@app/'),
    valid.replace('/original/', '/originals/'), valid.replace('/original/', '/%6friginal/'),
    valid.replace('a'.repeat(64), 'A'.repeat(64)), valid.replace('a'.repeat(64), 'g'.repeat(64))];
  for (const url of urls) {
    const f = fixture({ status: 'ready', url });
    assert.deepEqual(plain(await f.bridge.playOriginal({ id: 'a'.repeat(32), revision: 'b'.repeat(32) })),
      { status: 'unavailable' }, JSON.stringify(url));
  }
});

test('original playback validates own data properties without reading getters or allowing extra fields', async () => {
  let reads = 0;
  const request = { id: 'a'.repeat(32), revision: 'b'.repeat(32) };
  const f = fixture();
  const invalid = [null, [], {}, { ...request, path: '/private/source' }, { ...request, [Symbol('secret')]: true },
    { ...request, id: 'g'.repeat(32) }, { ...request, revision: 'a'.repeat(33) },
    { id: request.id, get revision() { reads++; return request.revision; } }];
  for (const value of invalid) { assert.deepEqual(plain(await f.bridge.playOriginal(value)), { status: 'unavailable' }); }
  assert.deepEqual(plain(await f.bridge.playOriginal(request, 'extra')), { status: 'unavailable' });
  f.bridge.stopOriginal('extra');
  assert.equal(reads, 0); assert.deepEqual(f.invoked, []); assert.deepEqual(f.sent, []);
});

test('stop remains available during pending original start and discards a late ready response', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.playOriginal({ id: 'a'.repeat(32), revision: 'b'.repeat(32) });
  assert.deepEqual(plain(await f.bridge.sources()), { status: 'busy' });
  f.bridge.stopOriginal(); assert.deepEqual(f.sent, [[channels.stopOriginal]]);
  finish({ status: 'ready', url: 'theatrum://app/original/' + 'a'.repeat(64) });
  assert.deepEqual(plain(await work), { status: 'cancelled' });
});

test('lock discards a pending original start and suppresses all later stop requests', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.playOriginal({ id: 'a'.repeat(32), revision: 'b'.repeat(32) });
  f.bridge.lock(); f.bridge.stopOriginal();
  finish({ status: 'ready', url: 'theatrum://app/original/' + 'a'.repeat(64) });
  assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]);
});

test('original playback failure responses are a fixed path-free whitelist', async () => {
  for (const status of ['cancelled', 'conflict', 'source-unavailable', 'wrong-folder', 'unsupported', 'busy', 'unavailable']) {
    const f = fixture({ status, path: '/private/source', error: 'private detail' });
    assert.deepEqual(plain(await f.bridge.playOriginal({ id: 'a'.repeat(32), revision: 'b'.repeat(32) })), { status });
  }
  const f = fixture({ status: 'granted', path: '/private/source' });
  assert.deepEqual(plain(await f.bridge.playOriginal({ id: 'a'.repeat(32), revision: 'b'.repeat(32) })), { status: 'unavailable' });
});


test('import sends one exact opaque source ID and returns only fixed preselection statuses', async () => {
  for (const status of ['cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'source-unavailable', 'wrong-folder', 'busy', 'unavailable']) {
    const f = fixture({ status, path: '/PRIVATE-IMPORT', item: { fileName: 'PRIVATE-IMPORT' }, error: 'PRIVATE-IMPORT' });
    assert.deepEqual(plain(await f.bridge.importVideo(sourceFolder().id)), { status });
    assert.deepEqual(f.invoked, [[channels.importVideo, sourceFolder().id]]);
  }
  const f = fixture();
  for (const args of [[], [null], [{}], [['c'.repeat(32)]], ['c'.repeat(31)], ['C'.repeat(32)], ['c'.repeat(32) + '\n'],
    ['c'.repeat(32) + '\0'], [sourceFolder().id, 'extra'], [{ id: sourceFolder().id, path: '/PRIVATE-IMPORT' }]]) {
    assert.deepEqual(plain(await f.bridge.importVideo(...args)), { status: 'unavailable' });
  }
  assert.deepEqual(f.invoked, []);
});

test('malformed import responses and exceptions cannot expose native contents', async () => {
  for (const response of [null, undefined, [], Object.assign([], { status: 'imported' }), '/PRIVATE-IMPORT',
    { status: '__proto__' }, { status: 'constructor' }, { status: { toString: () => '/PRIVATE-IMPORT' } },
    new Error('/PRIVATE-IMPORT'), { status: 'ready', path: '/PRIVATE-IMPORT' }]) {
    const f = fixture(response);
    assert.deepEqual(plain(await f.bridge.importVideo(sourceFolder().id)), { status: 'unavailable' });
  }
  let reads = 0;
  const f = fixture({ get status() { return ++reads === 1 ? 'cancelled' : '/PRIVATE-IMPORT'; } });
  assert.deepEqual(plain(await f.bridge.importVideo(sourceFolder().id)), { status: 'cancelled' });
  assert.equal(reads, 1);
});

test('import cancellation is one-shot, does not release admission and cannot cancel unrelated work', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  f.bridge.cancelImport(); assert.deepEqual(f.sent, []);
  const listing = f.bridge.sources(); f.bridge.cancelImport(); assert.deepEqual(f.sent, []);
  finish({ status: 'ready', items: [] }); await listing;
  const work = f.bridge.importVideo(sourceFolder().id);
  f.bridge.cancelImport('extra'); f.bridge.cancelSourceConnection(); f.bridge.cancelRegeneration();
  assert.deepEqual(f.sent, []);
  f.bridge.cancelImport(); f.bridge.cancelImport();
  assert.deepEqual(f.sent, [[channels.cancelImport]]);
  for (const operation of [() => f.bridge.importVideo(sourceFolder().id), () => f.bridge.sources(),
    () => f.bridge.detail(item().id), () => f.bridge.list({ query: '', offset: 0 }),
    () => f.credentials.changePassword({ currentPassword: 'current', newPassword: 'replacement' })]) {
    assert.deepEqual(plain(await operation()), { status: 'busy' });
  }
  finish(importResult());
  assert.deepEqual(plain(await work), importResult(), 'Cancellation does not hide a completed catalogue publication');
  f.bridge.cancelImport(); assert.equal(f.sent.length, 1);
  f.native(async () => ({ status: 'ready', items: [] }));
  assert.equal((await f.bridge.sources()).status, 'ready');
});

test('lock permanently suppresses an admitted import and prevents late import cancellation', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.importVideo(sourceFolder().id);
  f.bridge.lock(); f.bridge.cancelImport();
  finish({ status: 'imported', path: '/PRIVATE-IMPORT' });
  assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.importVideo(sourceFolder().id)), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.sources()), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]); assert.equal(f.invoked.length, 1);
});


test('add source takes no renderer arguments and returns only a fixed status', async () => {
  for (const status of ['added', 'cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'source-unavailable', 'busy', 'unavailable']) {
    const f = fixture({ status, path: '/PRIVATE-SOURCE', source: { name: 'PRIVATE-SOURCE' }, error: 'PRIVATE-SOURCE' });
    assert.deepEqual(plain(await f.bridge.addSource()), { status });
    assert.deepEqual(f.invoked, [[channels.addSource]]);
  }
  const f = fixture();
  for (const args of [[undefined], [null], [{}], [sourceFolder().id], ['/PRIVATE-SOURCE'], [1, 2]]) {
    assert.deepEqual(plain(await f.bridge.addSource(...args)), { status: 'unavailable' });
  }
  assert.deepEqual(f.invoked, []);
});

test('malformed add-source responses and native errors expose no private contents', async () => {
  for (const response of [null, undefined, [], Object.assign([], { status: 'added' }), '/PRIVATE-SOURCE',
    { status: '__proto__' }, { status: 'constructor' }, { status: { toString: () => '/PRIVATE-SOURCE' } },
    new Error('/PRIVATE-SOURCE'), { status: 'ready', path: '/PRIVATE-SOURCE' }, { get status() { throw new Error('/PRIVATE-SOURCE'); } }]) {
    const f = fixture(response);
    assert.deepEqual(plain(await f.bridge.addSource()), { status: 'unavailable' });
  }
  let reads = 0;
  const f = fixture({ get status() { return ++reads === 1 ? 'added' : '/PRIVATE-SOURCE'; } });
  assert.deepEqual(plain(await f.bridge.addSource()), { status: 'added' });
  assert.equal(reads, 1);
});

test('source-add cancellation is one-shot and retains admission through committed saves', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  f.bridge.cancelSourceConnection(); assert.deepEqual(f.sent, []);
  const work = f.bridge.addSource();
  f.bridge.cancelSourceConnection('extra'); f.bridge.cancelImport(); f.bridge.cancelRegeneration();
  assert.deepEqual(f.sent, []);
  f.bridge.cancelSourceConnection(); f.bridge.cancelSourceConnection();
  assert.deepEqual(f.sent, [[channels.cancelSourceConnection]]);
  for (const operation of [() => f.bridge.addSource(), () => f.bridge.sources(), () => f.bridge.importVideo(sourceFolder().id),
    () => f.bridge.detail(item().id), () => f.bridge.list({ query: '', offset: 0 }),
    () => f.credentials.changePassword({ currentPassword: 'current', newPassword: 'replacement' })]) {
    assert.deepEqual(plain(await operation()), { status: 'busy' });
  }
  finish({ status: 'added' });
  assert.deepEqual(plain(await work), { status: 'added' });
  f.bridge.cancelSourceConnection(); assert.equal(f.sent.length, 1);
  f.native(async () => ({ status: 'ready', items: [] }));
  assert.equal((await f.bridge.sources()).status, 'ready');
});

test('lock suppresses pending source-add responses and all later source actions', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.addSource(); f.bridge.lock(); f.bridge.cancelSourceConnection();
  finish({ status: 'added', path: '/PRIVATE-SOURCE' });
  assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.addSource()), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]); assert.equal(f.invoked.length, 1);
});


function importResult(overrides: Record<string, unknown> = {}): any {
  return { status: 'finished', outcome: 'completed', total: 1, processed: 1, imported: 1, duplicates: 0, failed: 0, ...overrides };
}

test('batch import copies only validated counters and outcomes, stripping filenames and native errors', async () => {
  for (const outcome of ['completed', 'cancelled', 'stopped']) {
    const result = importResult({ outcome, total: 4, processed: outcome === 'completed' ? 4 : 3,
      imported: 1, duplicates: 1, failed: outcome === 'completed' ? 2 : 1 });
    const f = fixture({ ...result, paths: ['/PRIVATE-BATCH'], error: '/PRIVATE-BATCH', items: [{ title: '/PRIVATE-BATCH' }] });
    assert.deepEqual(plain(await f.bridge.importVideo(sourceFolder().id)), result);
  }
  const empty = importResult({ outcome: 'cancelled', total: 100, processed: 0, imported: 0 });
  assert.deepEqual(plain(await fixture(empty).bridge.importVideo(sourceFolder().id)), empty);
});

test('batch import and progress reject inconsistent, unbounded and malformed counters', async () => {
  const malformed = [
    ...['total', 'processed', 'imported', 'duplicates', 'failed'].flatMap(key =>
      [undefined, null, -1, 101, 0.5, '1', NaN, Infinity, {}, Number.MAX_SAFE_INTEGER + 1].map(value => ({ [key]: value }))),
    { total: 0, processed: 0, imported: 0 }, { total: 1, processed: 2, imported: 2 },
    { processed: 1, imported: 0 }, { processed: 1, imported: 1, duplicates: 1 },
  ];
  for (const change of malformed) {
    for (const mode of ['importVideo', 'scanSource', 'importProgress']) {
      const f = fixture(importResult({ status: mode === 'importProgress' ? 'running' : 'finished', ...change }));
      assert.deepEqual(plain(await f.bridge[mode](...(mode !== 'importProgress' ? [sourceFolder().id] : []))), { status: 'unavailable' });
    }
  }
  for (const change of [{ outcome: 'PRIVATE-BATCH' }, { outcome: undefined }, { total: 2 }, { status: 'imported' }]) {
    assert.deepEqual(plain(await fixture(importResult(change)).bridge.importVideo(sourceFolder().id)), { status: 'unavailable' });
  }
});

test('progress has a zero-argument channel and copies only fixed status or bounded counters', async () => {
  const running = { status: 'running', total: 100, processed: 3, imported: 1, duplicates: 1, failed: 1 };
  for (const result of [running, { status: 'idle' }, { status: 'unavailable' }]) {
    const f = fixture({ ...result, path: '/PRIVATE-BATCH', error: '/PRIVATE-BATCH' });
    assert.deepEqual(plain(await f.bridge.importProgress()), result);
    assert.deepEqual(f.invoked, [[channels.importProgress]]);
  }
  for (const result of [null, [], Object.assign([], running), { status: 'busy' }, importResult(),
    { status: 'running' }, { status: 'toString' }, new Error('/PRIVATE-BATCH')]) {
    assert.deepEqual(plain(await fixture(result).bridge.importProgress()), { status: 'unavailable' });
  }
  const f = fixture(running);
  for (const args of [[null], [sourceFolder().id], [{}], [undefined]]) {
    assert.deepEqual(plain(await f.bridge.importProgress(...args)), { status: 'unavailable' });
  }
  assert.deepEqual(f.invoked, []);
});

test('progress alone bypasses import admission while cancellation and other actions remain gated', async () => {
  const f = fixture(); let finish!: (value: unknown) => void; let progressFinish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const work = f.bridge.importVideo(sourceFolder().id);
  f.native(() => new Promise(resolve => { progressFinish = resolve; }));
  const progress = f.bridge.importProgress();
  assert.deepEqual(plain(await f.bridge.importProgress()), { status: 'unavailable' }, 'Only one progress request is admitted at a time');
  assert.deepEqual(plain(await f.bridge.sources()), { status: 'busy' });
  f.bridge.cancelImport(); f.bridge.cancelImport();
  assert.deepEqual(f.sent, [[channels.cancelImport]]);
  progressFinish({ status: 'running', total: 2, processed: 1, imported: 1, duplicates: 0, failed: 0 });
  assert.equal((await progress).status, 'running');
  assert.deepEqual(plain(await f.bridge.importVideo(sourceFolder().id)), { status: 'busy' });
  finish(importResult()); assert.deepEqual(plain(await work), importResult());
  assert.deepEqual(f.invoked, [[channels.importVideo, sourceFolder().id], [channels.importProgress]]);
});

test('progress does not bypass unrelated operations, including credential admission', async () => {
  for (const mode of ['list', 'addSource', 'password', 'touchId']) {
    const f = fixture(); let finish!: (value: unknown) => void;
    f.native(() => new Promise(resolve => { finish = resolve; }));
    const work = mode === 'list' ? f.bridge.list({ query: '', offset: 0 }) : mode === 'addSource' ? f.bridge.addSource()
      : mode === 'password' ? f.credentials.changePassword({ currentPassword: 'current', newPassword: 'new' }) : f.credentials.touchIdStatus();
    assert.deepEqual(plain(await f.bridge.importProgress()), { status: 'unavailable' });
    assert.equal(f.invoked.length, 1); finish({ status: 'unavailable' }); await work;
  }
});

test('locking, completing or replacing an import suppresses outstanding progress responses', async () => {
  for (const action of ['lock', 'complete', 'replace']) {
    const f = fixture(); let finish!: (value: unknown) => void; let progressFinish!: (value: unknown) => void;
    f.native(() => new Promise(resolve => { finish = resolve; }));
    const work = f.bridge.importVideo(sourceFolder().id);
    f.native(() => new Promise(resolve => { progressFinish = resolve; }));
    const progress = f.bridge.importProgress();
    if (action === 'lock') { f.bridge.lock(); }
    finish(importResult()); await work;
    let replacement: Promise<unknown> | undefined;
    if (action === 'replace') {
      f.native(() => new Promise(resolve => { finish = resolve; }));
      replacement = f.bridge.importVideo(sourceFolder().id);
    }
    progressFinish({ status: 'running', total: 1, processed: 1, imported: 1, duplicates: 0, failed: 0 });
    assert.deepEqual(plain(await progress), { status: 'unavailable' });
    if (replacement) { finish(importResult()); await replacement; }
    if (action === 'lock') { assert.deepEqual(plain(await f.bridge.importProgress()), { status: 'unavailable' }); }
  }
});


test('list copies optional bounded collection/sort/direction fields and accepts legacy requests', async () => {
  for (const collection of ['all', 'favourites', 'recent']) {
    for (const sort of ['catalogue', 'name', 'date-added', 'last-played', 'rating', 'duration', 'file-size']) {
      for (const direction of ['asc', 'desc']) {
        const request = { query: 'Birds', offset: 48, collection, sort, direction };
        const f = fixture(); await f.bridge.list(request);
        assert.deepEqual(f.invoked, [[channels.list, request]]);
      }
    }
  }
  for (const extra of [{}, { collection: 'recent' }, { sort: 'name' }, { direction: 'desc' }]) {
    const f = fixture(); const request = { query: '', offset: 0, ...extra };
    await f.bridge.list(request); assert.deepEqual(f.invoked, [[channels.list, request]]);
  }
});

test('list rejects unknown, inherited, accessor and symbolic query fields without executing accessors', async () => {
  let reads = 0;
  const requests = [
    { query: '', offset: 0, collection: 'recently-played' }, { query: '', offset: 0, sort: 'path' },
    { query: '', offset: 0, direction: 'DESC' }, { query: '', offset: 0, [Symbol('secret')]: 'secret' },
    Object.create({ query: '', offset: 0 }),
    ...['collection', 'sort', 'direction'].flatMap(key => [undefined, null, [], {}, 1, ''].map(value => ({ query: '', offset: 0, [key]: value }))),
    ...['query', 'offset', 'collection', 'sort', 'direction'].map(key => Object.defineProperty({ query: '', offset: 0 }, key,
      { get: () => { reads++; throw new Error('PRIVATE-QUERY'); }, enumerable: true })),
    Object.defineProperty({ query: '', offset: 0 }, 'source', { value: '/PRIVATE-QUERY', enumerable: false }),
  ];
  for (const request of requests) {
    const f = fixture(); assert.deepEqual(plain(await f.bridge.list(request)), { status: 'unavailable' });
    assert.deepEqual(f.invoked, []);
  }
  assert.equal(reads, 0);
});


test('save accepts explicit integer ratings and omits untouched legacy rating data', async () => {
  const request = { id: item().id, revision: item().revision, notes: 'Notes', tags: ['Tag'] };
  for (const rating of [undefined, 0, 1, 2, 3, 4, 5]) {
    const edit = { ...request, ...(rating === undefined ? {} : { rating }) };
    const f = fixture({ status: 'saved', item: item() }); await f.bridge.save(edit);
    assert.deepEqual(f.invoked, [[channels.save, edit]]);
    assert.equal(Object.hasOwn((f.invoked[0][1] as any), 'rating'), rating !== undefined);
  }
});

test('save rejects malformed rating values, symbolic/accessor/nonenumerable fields without evaluating them', async () => {
  const base = { id: item().id, revision: item().revision, notes: '', tags: ['Tag'] };
  let reads = 0;
  const malformed = [
    ...[undefined, null, '5', -1, 6, 0.5, NaN, Infinity, {}, []].map(rating => ({ ...base, rating })),
    { ...base, favourite: true }, { ...base, [Symbol('rating')]: 5 }, Object.create(base),
    ...['id', 'revision', 'notes', 'tags', 'rating'].flatMap(key => [
      Object.defineProperty({ ...base }, key, { get: () => { reads++; return 'PRIVATE'; }, enumerable: true }),
      Object.defineProperty({ ...base }, key, { value: key === 'rating' ? 5 : (base as any)[key], enumerable: false }),
    ]),
  ];
  for (const edit of malformed) {
    const f = fixture(); assert.deepEqual(plain(await f.bridge.save(edit)), { status: 'unavailable' });
    assert.deepEqual(f.invoked, []);
  }
  assert.equal(reads, 0);
});

test('rating saves reject sparse, accessor, symbolic and extra tag properties before native IPC', async () => {
  let reads = 0;
  const getter = Object.defineProperty(['Tag'], '0', { get: () => { reads++; return 'PRIVATE'; }, enumerable: true });
  const hidden = Object.defineProperty(['Tag'], '0', { value: 'Tag', enumerable: false });
  const arrays = [Array(1), getter, hidden, Object.assign(['Tag'], { extra: '/PRIVATE' }),
    Object.assign(['Tag'], { [Symbol('secret')]: '/PRIVATE' })];
  for (const tags of arrays) {
    const f = fixture();
    assert.deepEqual(plain(await f.bridge.save({ id: item().id, revision: item().revision, notes: '', tags, rating: 5 })), { status: 'unavailable' });
    assert.deepEqual(f.invoked, []);
  }
  assert.equal(reads, 0);
});


test('scan uses one exact opaque source identity and copies only fixed statuses or validated batch counts', async () => {
  const statuses = ['nothing-new', 'scan-limit', 'cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'source-unavailable', 'wrong-folder', 'busy', 'unavailable'];
  for (const result of [...statuses.map(status => ({ status })), importResult(), importResult({ outcome: 'stopped', total: 2 })]) {
    const f = fixture({ ...result, path: '/PRIVATE-SCAN', names: ['PRIVATE-SCAN'], entries: [{ path: '/PRIVATE-SCAN' }] });
    assert.deepEqual(plain(await f.bridge.scanSource(sourceFolder().id)), result);
    assert.deepEqual(f.invoked, [[channels.scanSource, sourceFolder().id]]);
  }
  const f = fixture();
  for (const args of [[], [null], [{}], [['c'.repeat(32)]], ['c'.repeat(32) + '\n'], [sourceFolder().id, {}],
    [{ id: sourceFolder().id, root: '/PRIVATE-SCAN' }]]) {
    assert.deepEqual(plain(await f.bridge.scanSource(...args)), { status: 'unavailable' });
  }
  assert.deepEqual(f.invoked, []);
  for (const value of [undefined, null, [], Object.assign([], { status: 'nothing-new' }), { status: 'ready', paths: ['/PRIVATE-SCAN'] },
    { status: 'finished', outcome: 'completed', total: 3 }, new Error('/PRIVATE-SCAN')]) {
    assert.deepEqual(plain(await fixture(value).bridge.scanSource(sourceFolder().id)), { status: 'unavailable' });
  }
});

test('scan holds ordinary admission while progress and one-shot cancellation remain available', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const scan = f.bridge.scanSource(sourceFolder().id);
  f.native(async () => ({ status: 'idle', root: '/PRIVATE-SCAN' }));
  assert.deepEqual(plain(await f.bridge.importProgress()), { status: 'idle' });
  f.native(async () => ({ status: 'running', total: 2, processed: 1, imported: 1, duplicates: 0, failed: 0 }));
  assert.equal((await f.bridge.importProgress()).status, 'running');
  for (const operation of [() => f.bridge.scanSource(sourceFolder().id), () => f.bridge.importVideo(sourceFolder().id),
    () => f.bridge.sources(), () => f.bridge.addSource(), () => f.bridge.list({ query: '', offset: 0 })]) {
    assert.deepEqual(plain(await operation()), { status: 'busy' });
  }
  f.bridge.cancelSourceConnection(); f.bridge.cancelRegeneration(); f.bridge.cancelImport('extra'); assert.deepEqual(f.sent, []);
  f.bridge.cancelImport(); f.bridge.cancelImport(); assert.deepEqual(f.sent, [[channels.cancelImport]]);
  finish(importResult({ outcome: 'cancelled', total: 2 }));
  assert.deepEqual(plain(await scan), importResult({ outcome: 'cancelled', total: 2 }));
  f.bridge.cancelImport(); assert.equal(f.sent.length, 1);
});

test('scan completion, replacement and lock suppress late progress and stale native responses', async () => {
  for (const action of ['finish', 'replace', 'lock']) {
    const f = fixture(); let finish!: (value: unknown) => void; let progressFinish!: (value: unknown) => void;
    f.native(() => new Promise(resolve => { finish = resolve; }));
    const scan = f.bridge.scanSource(sourceFolder().id);
    f.native(() => new Promise(resolve => { progressFinish = resolve; })); const progress = f.bridge.importProgress();
    if (action === 'lock') f.bridge.lock();
    finish(importResult()); const result = await scan;
    assert.deepEqual(plain(result), action === 'lock' ? { status: 'unavailable' } : importResult());
    let later: Promise<unknown> | undefined;
    if (action === 'replace') {
      f.native(() => new Promise(resolve => { finish = resolve; })); later = f.bridge.scanSource(sourceFolder().id);
    }
    progressFinish({ status: 'running', total: 1, processed: 1, imported: 1, duplicates: 0, failed: 0 });
    assert.deepEqual(plain(await progress), { status: 'unavailable' });
    if (later) { finish({ status: 'nothing-new' }); await later; }
    if (action === 'lock') {
      assert.deepEqual(plain(await f.bridge.scanSource(sourceFolder().id)), { status: 'unavailable' });
      assert.deepEqual(plain(await f.bridge.importProgress()), { status: 'unavailable' });
    }
  }
});

test('playback acknowledgement accepts only one exact opaque original URL and strips every native detail', async () => {
  const url = 'theatrum://app/original/' + 'a'.repeat(64);
  for (const status of ['recorded', 'disabled', 'ignored', 'conflict', 'invalid', 'busy', 'unavailable']) {
    const f = fixture({ status, path: '/PRIVATE', lastPlayed: 123, timesPlayed: 2 });
    assert.deepEqual(plain(await f.bridge.ackOriginalPlayback(url)), { status });
    assert.deepEqual(f.invoked, [[channels.ackOriginalPlayback, url]]);
  }
  for (const value of [null, undefined, { status: 'ready' }, { status: '__proto__' }, new Error('PRIVATE')]) {
    const f = fixture(value);
    assert.deepEqual(plain(await f.bridge.ackOriginalPlayback(url)), { status: 'unavailable' });
  }
});

test('malformed playback acknowledgements never cross IPC', async () => {
  const f = fixture({ status: 'recorded' }); const prefix = 'theatrum://app/original/';
  const token = 'a'.repeat(64);
  for (const value of [undefined, null, 1, {}, [prefix + token], { url: prefix + token }, 'file:///PRIVATE',
    prefix + 'a'.repeat(63), prefix + 'a'.repeat(65), prefix + 'A'.repeat(64), prefix + token + '\n',
    prefix + token + '?x=1', prefix + token + '#1', 'https://app/original/' + token,
    'theatrum://user@app/original/' + token, 'theatrum://app/media/clips/0.mp4']) {
    assert.deepEqual(plain(await f.bridge.ackOriginalPlayback(value)), { status: 'unavailable' });
  }
  assert.deepEqual(plain(await f.bridge.ackOriginalPlayback()), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.ackOriginalPlayback(prefix + token, 'extra')), { status: 'unavailable' });
  assert.deepEqual(f.invoked, []);
});

test('pending playback acknowledgement serializes requests while Stop remains immediate and preserves admitted reply', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(); f.native(() => new Promise(yes => { resolve = yes; }));
  const work = f.bridge.ackOriginalPlayback('theatrum://app/original/' + 'a'.repeat(64));
  assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'busy' });
  assert.deepEqual(plain(await f.bridge.ackOriginalPlayback('theatrum://app/original/' + 'b'.repeat(64))), { status: 'busy' });
  f.bridge.stopOriginal(); assert.deepEqual(f.sent, [[channels.stopOriginal]]);
  resolve({ status: 'recorded' }); assert.deepEqual(plain(await work), { status: 'recorded' });
  f.native(async () => page()); assert.equal((await f.bridge.list({ query: '', offset: 0 })).status, 'ready');
});

test('lock retires acknowledgement responses and prevents subsequent acknowledgement IPC', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(); f.native(() => new Promise(yes => { resolve = yes; }));
  const url = 'theatrum://app/original/' + 'a'.repeat(64);
  const work = f.bridge.ackOriginalPlayback(url); f.bridge.lock();
  resolve({ status: 'recorded' }); assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.ackOriginalPlayback(url)), { status: 'unavailable' });
  assert.equal(f.invoked.length, 1);
});

test('protection bridge sends explicit history booleans and preserves an omitted legacy input', async () => {
  for (const history of [false, true]) {
    const f = fixture({ status: 'saved', autoLockMinutes: 5, recordPlaybackHistory: history, source: 'PRIVATE' });
    const request = { recordPlaybackHistory: history, autoLockMinutes: 5 };
    assert.deepEqual(plain(await f.bridge.setProtection(request)), { status: 'saved', autoLockMinutes: 5, recordPlaybackHistory: history });
    assert.deepEqual(f.invoked, [[channels.setProtection, { autoLockMinutes: 5, recordPlaybackHistory: history }]]);
  }
  const legacy = fixture({ status: 'saved', autoLockMinutes: 15, recordPlaybackHistory: true });
  assert.deepEqual(plain(await legacy.bridge.setProtection({ autoLockMinutes: 15 })), { status: 'saved', autoLockMinutes: 15, recordPlaybackHistory: true });
  assert.deepEqual(legacy.invoked, [[channels.setProtection, { autoLockMinutes: 15 }]]);
});

test('protection history rejects malformed values, getters, hidden fields and symbols before IPC', async () => {
  const f = fixture();
  const hidden = Object.defineProperty({ autoLockMinutes: 5 }, 'recordPlaybackHistory', { value: true });
  const hiddenLock = Object.defineProperty({ recordPlaybackHistory: true }, 'autoLockMinutes', { value: 5 });
  const getter = { autoLockMinutes: 5, get recordPlaybackHistory() { throw new Error('Must not read'); } };
  for (const value of [null, 0, 1, 'true', [], {}]) {
    assert.deepEqual(plain(await f.bridge.setProtection({ autoLockMinutes: 5, recordPlaybackHistory: value })), { status: 'unavailable' });
  }
  for (const value of [hidden, hiddenLock, getter, { autoLockMinutes: 5, recordPlaybackHistory: true, [Symbol('x')]: 1 },
    Object.defineProperty({ autoLockMinutes: 5 }, 'secret', { value: 'PRIVATE' })]) {
    assert.deepEqual(plain(await f.bridge.setProtection(value)), { status: 'unavailable' });
  }
  assert.deepEqual(f.invoked, []);
});

test('protection history response rejects malformed booleans while old snapshots normalize to Off', async () => {
  for (const status of ['ready', 'saved']) {
    for (const value of [null, 1, 'false', {}, []]) {
      const f = fixture({ status, autoLockMinutes: 5, recordPlaybackHistory: value });
      const result = status === 'ready' ? await f.bridge.protection() : await f.bridge.setProtection({ autoLockMinutes: 5, recordPlaybackHistory: false });
      assert.deepEqual(plain(result), { status: 'unavailable' });
    }
    const f = fixture({ status, autoLockMinutes: 5 });
    const result = status === 'ready' ? await f.bridge.protection() : await f.bridge.setProtection({ autoLockMinutes: 5 });
    assert.deepEqual(plain(result), { status, autoLockMinutes: 5, recordPlaybackHistory: false });
  }
});

test('history reset bridge sends only the selected metric and strips native response fields', async () => {
  for (const metric of ['lastPlayed', 'timesPlayed']) {
    const f = fixture({ status: 'reset', count: 100_000, metric, path: '/PRIVATE', rows: ['SECRET'] });
    assert.deepEqual(plain(await f.bridge.resetPlaybackHistory(metric)), { status: 'reset', count: 100_000 });
    assert.deepEqual(f.invoked, [[channels.resetPlaybackHistory, metric]]);
  }
  for (const status of ['unchanged', 'cancelled', 'busy', 'invalid', 'unavailable']) {
    const f = fixture({ status, count: 5, path: '/PRIVATE', rows: ['SECRET'] });
    assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('lastPlayed')), { status });
  }
});

test('history reset accepts exact metric strings only without coercing objects or invoking getters', async () => {
  const f = fixture();
  let accessed = 0;
  const hostile = { toString() { accessed++; return 'lastPlayed'; }, get metric() { accessed++; return 'lastPlayed'; } };
  for (const metric of [undefined, null, 1, true, '', 'lastPlayed\n', 'lastplayed', 'timesPlayed ', 'both',
    ['lastPlayed'], { metric: 'lastPlayed' }, hostile, Symbol('lastPlayed')]) {
    assert.deepEqual(plain(await f.bridge.resetPlaybackHistory(metric)), { status: 'unavailable' });
  }
  assert.deepEqual(plain(await f.bridge.resetPlaybackHistory()), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('lastPlayed', 'timesPlayed')), { status: 'unavailable' });
  assert.equal(accessed, 0); assert.deepEqual(f.invoked, []);
});

test('history reset bridge rejects malformed counts and statuses', async () => {
  for (const count of [undefined, null, 0, -1, 1.5, 100_001, NaN, Infinity, '1', {}, []]) {
    const f = fixture({ status: 'reset', count });
    assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('timesPlayed')), { status: 'unavailable' });
  }
  for (const result of [null, undefined, [], 'reset', { status: '__proto__' }, { status: 'saved', count: 1 },
    Object.assign([], { status: 'reset', count: 1 })]) {
    const f = fixture(result);
    assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('lastPlayed')), { status: 'unavailable' });
  }
});

test('history reset serializes other bridge calls and Lock rejects a late reset result', async () => {
  let resolve!: (value: unknown) => void;
  const f = fixture(); f.native(() => new Promise(yes => { resolve = yes; }));
  const work = f.bridge.resetPlaybackHistory('lastPlayed');
  assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('timesPlayed')), { status: 'busy' });
  assert.deepEqual(plain(await f.bridge.list({ query: '', offset: 0 })), { status: 'busy' });
  assert.deepEqual(plain(await f.bridge.setProtection({ autoLockMinutes: 5, recordPlaybackHistory: true })), { status: 'busy' });
  f.bridge.lock(); assert.deepEqual(f.sent, [[channels.lock]]);
  resolve({ status: 'reset', count: 1 }); assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('lastPlayed')), { status: 'unavailable' });
  assert.equal(f.invoked.length, 1);
});

test('history reset IPC rejection releases the pending gate without native error text', async () => {
  const f = fixture(new Error('/PRIVATE/reset'));
  assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('timesPlayed')), { status: 'unavailable' });
  f.native(async () => ({ status: 'unchanged' }));
  assert.deepEqual(plain(await f.bridge.resetPlaybackHistory('timesPlayed')), { status: 'unchanged' });
});


const sourceCheckResult = (changes: Record<string, unknown> = {}) => ({ status: 'checked', total: 15,
  sameSize: 1, differentSize: 2, missing: 3, unverified: 4, ignored: 5, ...changes });

test('source check accepts one exact opaque ID and projects only validated location counts', async () => {
  const result = sourceCheckResult();
  const f = fixture({ ...result, path: '/PRIVATE-CHECK', filenames: ['PRIVATE-CHECK.mp4'], revision: 'PRIVATE-CHECK' });
  assert.deepEqual(plain(await f.bridge.checkSource(sourceFolder().id)), result);
  assert.deepEqual(f.invoked, [[channels.checkSource, sourceFolder().id]]);
  const empty = sourceCheckResult({ total: 0, sameSize: 0, differentSize: 0, missing: 0, unverified: 0, ignored: 0 });
  assert.deepEqual(plain(await fixture(empty).bridge.checkSource(sourceFolder().id)), empty);
  const limit = sourceCheckResult({ total: 10_000, sameSize: 10_000, differentSize: 0, missing: 0, unverified: 0, ignored: 0 });
  assert.deepEqual(plain(await fixture(limit).bridge.checkSource(sourceFolder().id)), limit);
  const invalid = fixture();
  for (const args of [[], [undefined], [null], [{}], [['c'.repeat(32)]], ['c'.repeat(32) + '\n'], ['C'.repeat(32)],
    ['c'.repeat(31)], ['c'.repeat(33)], [sourceFolder().id, undefined], [{ id: sourceFolder().id, path: '/PRIVATE-CHECK' }]]) {
    assert.deepEqual(plain(await invalid.bridge.checkSource(...args)), { status: 'unavailable' });
  }
  assert.deepEqual(invalid.invoked, []);
});

test('source check projects status-only failures and rejects malformed counts and getter properties', async () => {
  for (const status of ['cancelled', 'conflict', 'invalid', 'limit', 'wrong-folder', 'source-unavailable', 'busy', 'unavailable']) {
    const f = fixture({ ...sourceCheckResult(), status, path: '/PRIVATE-CHECK' });
    assert.deepEqual(plain(await f.bridge.checkSource(sourceFolder().id)), { status });
  }
  const malformed: unknown[] = [null, undefined, 'PRIVATE-CHECK', [], new Error('/PRIVATE-CHECK'),
    Object.assign([], sourceCheckResult()), sourceCheckResult({ total: 14 }), sourceCheckResult({ status: 'success' }),
    Object.create(sourceCheckResult()), Object.defineProperty(sourceCheckResult(), 'sameSize', { get() { throw new Error('/PRIVATE-CHECK'); } }),
    Object.defineProperty(sourceCheckResult(), 'status', { get() { throw new Error('/PRIVATE-CHECK'); } }),
    Object.defineProperty(sourceCheckResult(), 'sameSize', { value: 1, enumerable: false })];
  for (const key of ['total', 'sameSize', 'differentSize', 'missing', 'unverified', 'ignored']) {
    for (const value of [undefined, '1', -1, 0.5, Infinity, NaN, 10_001]) { malformed.push(sourceCheckResult({ [key]: value })); }
  }
  for (const value of malformed) {
    assert.deepEqual(plain(await fixture(value).bridge.checkSource(sourceFolder().id)), { status: 'unavailable' });
  }
});

test('source check serializes operations and sends source cancellation only once while active', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  f.bridge.cancelSourceConnection(); assert.deepEqual(f.sent, []);
  const pending = f.bridge.checkSource(sourceFolder().id);
  f.bridge.cancelSourceConnection('extra'); f.bridge.cancelImport(); f.bridge.cancelRegeneration(); assert.deepEqual(f.sent, []);
  for (const invoke of [() => f.bridge.checkSource(sourceFolder().id), () => f.bridge.sources(), () => f.bridge.addSource(),
    () => f.bridge.list({ query: '', offset: 0 }), () => f.bridge.scanSource(sourceFolder().id)]) {
    assert.deepEqual(plain(await invoke()), { status: 'busy' });
  }
  f.bridge.cancelSourceConnection(); f.bridge.cancelSourceConnection();
  assert.deepEqual(f.sent, [[channels.cancelSourceConnection]]);
  finish({ status: 'cancelled' }); assert.deepEqual(plain(await pending), { status: 'cancelled' });
  f.bridge.cancelSourceConnection(); assert.equal(f.sent.length, 1);
  f.native(async () => sourceCheckResult());
  assert.deepEqual(plain(await f.bridge.checkSource(sourceFolder().id)), sourceCheckResult());
});

test('locking suppresses late source check results and prevents subsequent source calls', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.native(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.bridge.checkSource(sourceFolder().id); f.bridge.lock(); f.bridge.cancelSourceConnection();
  finish(sourceCheckResult()); assert.deepEqual(plain(await pending), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.checkSource(sourceFolder().id)), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]);
  assert.equal(f.invoked.length, 1);
});


test('video refresh projects only the updated detail and bounded status vocabulary', async () => {
  const request = { id: item().id, revision: item().revision };
  const f = fixture({ status: 'refreshed', item: { ...item(), width: 640, height: 360, sourcePath: '/secret/video' }, nativeError: 'secret' });
  assert.deepEqual(plain(await f.bridge.refreshVideo(request)), { status: 'refreshed', item: { ...item(), width: 640, height: 360 } });
  assert.deepEqual(plain(f.invoked), [[channels.refreshVideo, request]]);
  for (const status of ['cancelled', 'conflict', 'invalid', 'source-unavailable', 'wrong-folder', 'busy', 'unavailable']) {
    f.native(async () => ({ status, nativeError: '/secret/video' }));
    assert.deepEqual(plain(await f.bridge.refreshVideo(request)), { status });
  }
  for (const status of ['generated', 'ready', 'saved', 'unknown']) {
    f.native(async () => ({ status, item: item() }));
    assert.deepEqual(plain(await f.bridge.refreshVideo(request)), { status: 'unavailable' });
  }
});

test('video refresh requires an exact own data id/revision pair without invoking getters', async () => {
  const request = { id: item().id, revision: item().revision };
  const f = fixture();
  let getters = 0;
  for (const args of [[], [null], [{}], [request, 'extra'], [{ ...request, path: '/secret' }],
    [{ ...request, id: 'bad' }], [{ ...request, revision: 'bad' }],
    [{ ...request, [Symbol('path')]: '/secret' }], [Object.create(request)],
    [Object.defineProperty({ revision: request.revision }, 'id', { value: request.id })],
    [{ revision: request.revision, get id() { getters++; return request.id; } }]]) {
    assert.deepEqual(plain(await f.bridge.refreshVideo(...args)), { status: 'unavailable' });
  }
  assert.equal(getters, 0); assert.equal(f.invoked.length, 0);
});

test('video refresh shares cancellation drainage and cannot overlap regeneration or other requests', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const request = { id: item().id, revision: item().revision };
  const work = f.bridge.refreshVideo(request);
  f.bridge.cancelRegeneration('extra'); assert.equal(f.sent.length, 0);
  f.bridge.cancelRegeneration(); f.bridge.cancelRegeneration();
  assert.deepEqual(f.sent, [[channels.cancelRegeneration]]);
  for (const next of [f.bridge.regenerate(request), f.bridge.refreshVideo(request), f.bridge.detail(request.id)]) {
    assert.deepEqual(plain(await next), { status: 'busy' });
  }
  resolve({ status: 'cancelled' }); assert.deepEqual(plain(await work), { status: 'cancelled' });
  f.bridge.cancelRegeneration(); assert.equal(f.sent.length, 1);
});

test('lock permanently suppresses video refresh completion and its cancellation channel', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.native(() => new Promise(yes => { resolve = yes; }));
  const request = { id: item().id, revision: item().revision };
  const work = f.bridge.refreshVideo(request);
  f.bridge.lock(); f.bridge.cancelRegeneration();
  resolve({ status: 'refreshed', item: item() });
  assert.deepEqual(plain(await work), { status: 'unavailable' });
  assert.deepEqual(plain(await f.bridge.refreshVideo(request)), { status: 'unavailable' });
  assert.deepEqual(f.sent, [[channels.lock]]); assert.equal(f.invoked.length, 1);
});

test('refreshable is an explicit boolean in every detailed response projection', async () => {
  for (const refreshable of [undefined, null, 0, 1, 'true', {}, []]) {
    for (const [mode, status] of [['detail', 'ready'], ['save', 'saved'], ['regenerate', 'generated'], ['refreshVideo', 'refreshed']]) {
      const value = { ...item(), refreshable };
      const f = fixture({ status, item: value });
      const request = mode === 'detail' ? value.id : mode === 'save'
        ? { id: value.id, revision: value.revision, notes: '', tags: [] } : { id: value.id, revision: value.revision };
      assert.deepEqual(plain(await f.bridge[mode](request)), { status: 'unavailable' });
    }
  }
});
