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
  truncated: false, editable: true, regenerable: true, revision: 'b'.repeat(32) });
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

test('sandbox preload keeps eight gallery methods and exposes six separate frozen credential methods', () => {
  const f = fixture();
  assert.deepEqual(f.imported, ['electron']);
  assert.deepEqual(Object.keys(f.exposed), ['privateGallery', 'privateCredentials']);
  assert.deepEqual(Object.keys(f.credentials).sort(), ['cancelUnprotectedCopy', 'changePassword', 'createUnprotectedCopy', 'disableTouchId', 'enableTouchId', 'touchIdStatus']);
  assert.equal(Object.isFrozen(f.credentials), true);
  assert.deepEqual(Object.keys(f.bridge).sort(), ['cancelRegeneration', 'detail', 'list', 'lock', 'protection', 'regenerate', 'save', 'setProtection']);
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
  for (const [mode, status] of [['detail', 'ready'], ['save', 'saved'], ['regenerate', 'generated']]) {
    const f = fixture({ status, item: versioned });
    const request = mode === 'detail' ? versioned.id : mode === 'regenerate'
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
  assert.deepEqual(plain(await f.bridge.protection()), { status: 'ready', autoLockMinutes: 5 });
  assert.deepEqual(f.invoked, [[channels.protection]]);
  for (const minutes of [0, 1, 5, 15, 30]) {
    f.native(async () => ({ status: 'saved', autoLockMinutes: minutes, path: '/secret' }));
    assert.deepEqual(plain(await f.bridge.setProtection({ autoLockMinutes: minutes })), { status: 'saved', autoLockMinutes: minutes });
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
    ['regenerate', [{ id: item().id, revision: item().revision }]], ['protection', []],
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
    ['regenerate', [{ id: item().id, revision: item().revision }]]] as const) {
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
    ['regenerate', [{ id: item().id, revision: item().revision }]], ['protection', []],
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
