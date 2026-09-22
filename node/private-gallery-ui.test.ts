import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const galleryRoot = path.resolve(__dirname, '../private-gallery');
const source = readFileSync(path.join(galleryRoot, 'gallery.js'), 'utf8');
const html = readFileSync(path.join(galleryRoot, 'index.html'), 'utf8');

// Execute the complete production script against a deliberately small DOM.
// Native Electron coverage separately checks layout, actual decoding and IPC.
class ElementStub {
  children: ElementStub[] = [];
  parent?: ElementStub;
  rooted = false;
  text = '';
  hidden = false;
  readOnly = false;
  disabled = false;
  checked = false;
  value = '';
  className = '';
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  captures = new Map<string, boolean[]>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  starts: string[] = [];
  pauses = 0;
  loads = 0;
  plays = 0;
  playResult: Promise<void> = Promise.resolve();
  onFocus = (_element: ElementStub) => undefined;
  constructor(readonly tagName = 'div') {}
  get isConnected(): boolean { return this.rooted || !!this.parent?.isConnected; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = String(value); }
  get src(): string { return this.attributes.get('src') ?? ''; }
  set src(value: string) { this.attributes.set('src', value); this.starts.push(value); }
  // Any accidental HTML rendering fails the suite instead of interpreting text.
  set innerHTML(_value: string) { throw new Error('User content must not be parsed as HTML'); }
  append(...elements: ElementStub[]): void {
    elements.forEach(element => { element.parent = this; this.children.push(element); });
  }
  replaceChildren(...elements: ElementStub[]): void {
    this.children.forEach(element => { element.parent = undefined; });
    this.children = [];
    this.text = '';
    this.append(...elements);
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, handler: (event: any) => void, capture = false): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
    this.captures.set(name, [...this.captures.get(name) ?? [], capture]);
  }
  fire(name: string, properties: Record<string, unknown> = {}): any {
    const event = { type: name, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...properties };
    if (!(name === 'click' && this.disabled)) {
      for (const handler of this.listeners.get(name) ?? []) { handler(event); }
    }
    return event;
  }
  closest(_selector: string): ElementStub | null {
    return ['input', 'textarea', 'select'].includes(this.tagName) || this.getAttribute('contenteditable') === 'true' ? this : null;
  }
  querySelector(selector: string): ElementStub | null {
    return this.children.find(child => child.tagName === selector) ?? null;
  }
  focus(): void { this.onFocus(this); }
  pause(): void { this.pauses++; }
  load(): void { this.loads++; }
  play(): Promise<void> { this.plays++; return this.playResult; }
}

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function item(index = 0, overrides: Record<string, unknown> = {}): any {
  return { id: `opaque-${index}`, title: `Private video ${index}`, duration: 85,
    width: 1920, height: 1080, rating: 4, favourite: false, tags: ['Nature'],
    thumbnailUrl: `theatrum://app/media/thumbnails/${index}.jpg`, ...overrides };
}

function ready(items: any[], total = items.length, offset = 0): any { return { status: 'ready', items, total, offset }; }
function detail(entry = item(), overrides: Record<string, unknown> = {}): any {
  return { status: 'ready', item: { ...entry, notes: 'Private notes',
    posterUrl: 'theatrum://app/media/clips/0.jpg', clipUrl: 'theatrum://app/media/clips/0.mp4',
    editable: true, regenerable: true, revision: 'a'.repeat(32), ...overrides } };
}

async function settle(): Promise<void> { for (let index = 0; index < 8; index++) { await Promise.resolve(); } }

function harness(options: {
  list?: (request: { query: string; offset: number }) => Promise<any>;
  detail?: (id: string) => Promise<any>;
  save?: (request: { id: string; revision: string; notes: string; tags: string[] }) => Promise<any>;
  regenerate?: (request: { id: string; revision: string }) => Promise<any>;
  cancelRegeneration?: () => void;
  protection?: () => Promise<any>;
  setProtection?: (request: { autoLockMinutes: number }) => Promise<any>;
  touchIdStatus?: () => Promise<any>;
  enableTouchId?: (request: { password: string }) => Promise<any>;
  disableTouchId?: () => Promise<any>;
  changePassword?: (request: { currentPassword: string; newPassword: string }) => Promise<any>;
  createUnprotectedCopy?: (request: { password: string; acknowledge: true }) => Promise<any>;
  cancelUnprotectedCopy?: () => void;
  copyAvailable?: boolean;
  credentialsAvailable?: boolean;
  lock?: () => void;
  observer?: boolean;
  available?: boolean;
} = {}) {
  const elements = new Map<string, ElementStub>();
  const created: ElementStub[] = [];
  const document = new ElementStub('document');
  const window = new ElementStub('window');
  let focused: ElementStub | undefined;
  Object.defineProperty(document, 'activeElement', { get: () => focused });
  const makeElement = (tag: string) => {
    const element = new ElementStub(tag);
    element.onFocus = value => { focused = value; };
    created.push(element);
    return element;
  };
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = makeElement(match[1]);
    element.rooted = true;
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(match[3], element);
  }
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const requests: { query: string; offset: number }[] = [];
  const selections: string[] = [];
  const saves: { id: string; revision: string; notes: string; tags: string[] }[] = [];
  const generations: { id: string; revision: string }[] = [];
  const protectionSaves: { autoLockMinutes: number }[] = [];
  const passwordChanges: { currentPassword: string; newPassword: string }[] = [];
  const unprotectedCopies: { password: string; acknowledge: true }[] = [];
  const touchIdEnrollments: { password: string }[] = [];
  let touchIdDisables = 0;
  let touchIdReads = 0;
  let copyCancellations = 0;
  let protectionReads = 0;
  let cancellations = 0;
  let lockCalls = 0;
  const observers: Observer[] = [];
  class Observer {
    targets = new Set<ElementStub>();
    constructor(readonly callback: (entries: any[]) => void) { observers.push(this); }
    observe(target: ElementStub): void { this.targets.add(target); }
    unobserve(target: ElementStub): void { this.targets.delete(target); }
    disconnect(): void { this.targets.clear(); }
    visible(): void { this.callback([...this.targets].map(target => ({ target, isIntersecting: true }))); }
  }
  const api = {
    list: async (request: { query: string; offset: number }) => {
      requests.push({ ...request });
      return options.list ? options.list(request) : ready([item()]);
    },
    detail: async (id: string) => {
      selections.push(id);
      return options.detail ? options.detail(id) : detail(item(Number(id.split('-')[1])));
    },
    save: async (request: { id: string; revision: string; notes: string; tags: string[] }) => {
      saves.push({ ...request, tags: [...request.tags] });
      return options.save ? options.save(request)
        : { status: 'saved', item: { ...detail(item(Number(request.id.split('-')[1]))).item,
          notes: request.notes, tags: request.tags, revision: 'b'.repeat(32) } };
    },
    regenerate: async (request: { id: string; revision: string }) => {
      generations.push({ ...request });
      return options.regenerate ? options.regenerate(request) : { status: 'generated', item: detail().item };
    },
    cancelRegeneration: () => { cancellations++; options.cancelRegeneration?.(); },
    protection: async () => {
      protectionReads++;
      return options.protection ? options.protection() : { status: 'ready', autoLockMinutes: 5 };
    },
    setProtection: async (request: { autoLockMinutes: number }) => {
      protectionSaves.push({ ...request });
      return options.setProtection ? options.setProtection(request) : { status: 'saved', autoLockMinutes: request.autoLockMinutes };
    },
    lock: () => { lockCalls++; options.lock?.(); },
  };
  runInNewContext(source, {
    document: Object.assign(document, {
      getElementById: (id: string) => { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); },
      createElement: makeElement,
    }),
    window, Element: ElementStub, URL,
    privateGallery: options.available === false ? undefined : api,
    privateCredentials: options.credentialsAvailable === false ? undefined : Object.freeze({
      touchIdStatus: () => { touchIdReads++; return options.touchIdStatus?.() ?? Promise.resolve({ outcome: 'unavailable' }); },
      enableTouchId: (request: { password: string }) => { touchIdEnrollments.push({ ...request });
        return options.enableTouchId?.(request) ?? Promise.resolve({ outcome: 'enabled' }); },
      disableTouchId: () => { touchIdDisables++; return options.disableTouchId?.() ?? Promise.resolve({ outcome: 'disabled' }); },
      changePassword: (request: { currentPassword: string; newPassword: string }) => {
        passwordChanges.push({ ...request });
        return options.changePassword ? options.changePassword(request) : Promise.resolve({ status: 'incorrect-password' });
      },
      createUnprotectedCopy: options.copyAvailable === false ? undefined : (request: { password: string; acknowledge: true }) => {
        unprotectedCopies.push({ ...request });
        return options.createUnprotectedCopy ? options.createUnprotectedCopy(request) : Promise.resolve({ status: 'incorrect-password' });
      },
      cancelUnprotectedCopy: options.copyAvailable === false ? undefined : () => {
        copyCancellations++;
        options.cancelUnprotectedCopy?.();
      },
    }),
    IntersectionObserver: options.observer ? Observer : undefined,
    setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  }, { filename: path.join(galleryRoot, 'gallery.js') });
  const byId = (id: string) => elements.get(id)!;
  return {
    byId, created, document, window, requests, selections, saves, generations, observers, protectionSaves, passwordChanges, unprotectedCopies,
    touchIdEnrollments, get touchIdDisables() { return touchIdDisables; }, get touchIdReads() { return touchIdReads; },
    get protectionReads() { return protectionReads; },
    get copyCancellations() { return copyCancellations; },
    get cancellations() { return cancellations; },
    get cards() { return byId('gallery-grid').children; },
    get images() { return created.filter(element => element.tagName === 'img'); },
    get activeImages() { return created.filter(element => element.tagName === 'img' && element.onload); },
    get focused() { return focused; }, get lockCalls() { return lockCalls; },
    get timers() { return timers.size; },
    async runTimer() {
      const next = timers.entries().next().value as [number, () => void] | undefined;
      assert.ok(next, 'Expected a scheduled timer');
      timers.delete(next[0]);
      next[1]();
      await settle();
    },
  };
}

test('private gallery caps visible image loading at three, leaving clip capacity, and retries finitely', async () => {
  const h = harness({ observer: true, list: async () => ready(Array.from({ length: 9 }, (_, index) => item(index))) });
  await settle();
  assert.equal(h.cards.length, 9);
  assert.equal(h.activeImages.length, 0);
  assert.match(h.cards[0].textContent, /Loading preview…/);
  assert.ok([...h.observers[0].targets].every(target => target.tagName === 'span' && !target.hidden));
  h.observers[0].visible();
  assert.equal(h.activeImages.length, 3);
  const failed = h.activeImages[0];
  failed.onerror!();
  assert.equal(h.activeImages.length, 3, 'Next queued preview uses the released slot');
  while (h.activeImages.length) { h.activeImages[0].onload!(); }
  await h.runTimer();
  failed.onerror!();
  await h.runTimer();
  failed.onerror!();
  assert.equal(failed.starts.length, 3);
  assert.equal(failed.src, '');
  assert.equal(failed.hidden, true);
  assert.match(failed.parent!.textContent, /Preview unavailable/);
  assert.equal(h.timers, 0);
  assert.equal(h.activeImages.length, 0);
});

test('changing pages removes decoded and loading preview sources and ignores their late events', async () => {
  const second = deferred();
  const h = harness({ list: async request => request.offset ? second.promise : ready([item(0), item(1)], 50) });
  await settle();
  const oldImages = h.activeImages.slice();
  oldImages[0].onload!();
  const lateLoad = oldImages[1].onload!;
  h.byId('next-page').fire('click');
  await settle();
  assert.equal(h.requests[1].offset, 48);
  assert.equal(h.cards.length, 0);
  assert.ok(oldImages.every(image => image.src === '' && image.hidden));
  lateLoad();
  assert.ok(oldImages.every(image => image.hidden));
  second.resolve(ready([item(48), item(49)], 50, 48));
  await settle();
  assert.equal(h.cards.length, 2);
  assert.equal(h.byId('next-page').disabled, true);
  assert.equal(h.byId('previous-page').disabled, false);
  assert.equal(h.byId('page-label').textContent, 'Page 2 of 2');
});

test('search bounds the query and stale catalogue replies never replace current results', async () => {
  const initial = deferred();
  const h = harness({ list: async request => request.query ? ready([item(2)]) : initial.promise });
  const search = h.byId('gallery-search');
  search.value = 'x'.repeat(240);
  search.fire('input');
  await h.runTimer();
  assert.equal(h.requests[1].query.length, 200);
  assert.equal(h.requests[1].offset, 0);
  assert.match(h.cards[0].textContent, /Private video 2/);
  initial.resolve(ready([item(0)]));
  await settle();
  assert.match(h.cards[0].textContent, /Private video 2/);
});

test('composition defers search and Escape does not intercept an input', async () => {
  const h = harness();
  await settle();
  h.cards[0].fire('click');
  await settle();
  const search = h.byId('gallery-search');
  search.fire('compositionstart');
  search.value = 'draft';
  search.fire('input');
  assert.equal(h.timers, 0);
  assert.equal(h.document.fire('keydown', { key: 'Escape', target: search }).defaultPrevented, false);
  assert.equal(h.byId('details-panel').hidden, false);
  search.fire('compositionend');
  await h.runTimer();
  assert.equal(h.requests[1].query, 'draft');
});

test('private titles, tags and notes stay literal text and disclose preview truncation', async () => {
  const title = '<img src=x onerror=steal()> & video';
  const notes = '<script>steal()</script>\nSecond line';
  const entry = item(0, { title });
  const h = harness({ list: async () => ready([entry]), detail: async () => detail(entry, { notes, tags: ['<b>Tag</b>'], truncated: true }) });
  await settle();
  assert.ok(h.cards[0].textContent.includes(title));
  h.cards[0].fire('click');
  await settle();
  assert.equal(h.byId('details-title').textContent, title);
  assert.equal(h.byId('details-notes').value, notes);
  assert.equal(h.byId('details-tags').children[0].children[0].textContent, '<b>Tag</b>');
  assert.equal(h.byId('shortened-notice').hidden, false);
  assert.equal(h.cards[0].getAttribute('aria-pressed'), 'true');
  assert.equal(h.byId('preview-video').src, '', 'Selecting a card cannot start video decoding');
});

test('changing selection ignores stale detail replies and Escape restores card focus', async () => {
  const first = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)]),
    detail: async id => id === 'opaque-0' ? first.promise : detail(item(1)) });
  await settle();
  h.cards[0].fire('click');
  h.cards[1].fire('click');
  await settle();
  first.resolve(detail(item(0)));
  await settle();
  assert.equal(h.byId('details-title').textContent, 'Private video 1');
  assert.equal(h.cards[0].getAttribute('aria-pressed'), 'false');
  const event = h.document.fire('keydown', { key: 'Escape', target: h.cards[1] });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.focused, h.cards[1]);
});

test('explicit preview starts once and closing details retires pending play success', async () => {
  const h = harness();
  await settle();
  h.cards[0].fire('click');
  await settle();
  const video = h.byId('preview-video');
  const pending = deferred<void>();
  video.playResult = pending.promise;
  h.byId('play-preview').fire('click');
  h.byId('play-preview').fire('click');
  assert.equal(video.plays, 1);
  assert.equal(video.src, 'theatrum://app/media/clips/0.mp4');
  const loaded = video.onloadeddata!;
  h.byId('close-details').fire('click');
  assert.equal(video.src, '');
  assert.ok(video.pauses > 0);
  assert.ok(video.loads > 0);
  const pausedAtClose = video.pauses;
  loaded();
  pending.resolve();
  await settle();
  assert.equal(video.pauses, pausedAtClose + 1, 'A late play fulfillment is paused again after source removal');
  assert.equal(video.hidden, true);
  assert.equal(h.byId('details-panel').hidden, true);
});

test('a late play fulfillment cannot pause a newer explicitly playing selection', async () => {
  const h = harness({ list: async () => ready([item(0), item(1)]) });
  await settle();
  h.cards[0].fire('click');
  await settle();
  const video = h.byId('preview-video');
  const pending = deferred<void>();
  video.playResult = pending.promise;
  h.byId('play-preview').fire('click');
  h.cards[1].fire('click');
  await settle();
  video.playResult = Promise.resolve();
  h.byId('play-preview').fire('click');
  await settle();
  const pauses = video.pauses;
  pending.resolve();
  await settle();
  assert.equal(video.pauses, pauses);
  assert.equal(video.hidden, false);
  assert.equal(video.plays, 2);
});

test('preview failure releases its source and allows an explicit retry', async () => {
  const h = harness();
  await settle();
  h.cards[0].fire('click');
  await settle();
  const video = h.byId('preview-video');
  video.playResult = Promise.reject(new Error('decoder failed: sensitive internal file'));
  h.byId('play-preview').fire('click');
  await settle();
  assert.equal(video.src, '');
  assert.equal(h.byId('play-preview').disabled, false);
  assert.equal(h.byId('play-preview').hidden, false);
  assert.equal(h.byId('details-status').textContent, 'This preview is unavailable.');
});

test('media outside the private preview origin is never loaded', async () => {
  const h = harness({ list: async () => ready([item(0, { thumbnailUrl: 'https://example.test/secret.jpg' })]),
    detail: async () => detail(item(), { posterUrl: 'file:///secret.jpg', clipUrl: 'theatrum://other/media/clips/secret.mp4' }) });
  await settle();
  assert.equal(h.activeImages.length, 0);
  h.cards[0].fire('click');
  await settle();
  assert.equal(h.activeImages.length, 0);
  assert.equal(h.byId('play-preview').hidden, true);
  assert.equal(h.byId('preview-video').src, '');
});

test('lock clears text, selections and media before signalling main, including late callbacks', async () => {
  const h = harness({ lock: () => {
    assert.equal(h.cards.length, 0);
    assert.equal(h.byId('details-title').textContent, '');
    assert.equal(h.byId('details-tags').textContent, '');
    assert.equal(h.byId('details-notes').value, '');
    assert.equal(h.byId('gallery-search').value, '');
    assert.ok(h.images.every(image => image.src === ''));
    assert.equal(h.byId('preview-video').src, '');
  } });
  await settle();
  h.cards[0].fire('click');
  await settle();
  h.byId('play-preview').fire('click');
  await settle();
  const lateImage = h.activeImages[0].onload!;
  h.byId('gallery-search').value = 'private search';
  h.byId('gallery-search').fire('input');
  h.byId('lock-hub').fire('click');
  lateImage();
  assert.equal(h.lockCalls, 1);
  assert.equal(h.timers, 0);
  assert.equal(h.byId('lock-state').textContent, 'Locking…');
  assert.equal(h.byId('preview-video').hidden, true);
  assert.equal(h.activeImages.length, 0);
});

test('locking while a detail reply is pending prevents sensitive text from reappearing', async () => {
  const pending = deferred();
  const h = harness({ detail: async () => pending.promise });
  await settle();
  h.cards[0].fire('click');
  h.byId('lock-hub').fire('click');
  pending.resolve(detail());
  await settle();
  assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('details-title').textContent, '');
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.cards.length, 0);
});

test('busy replies have bounded retry then show a generic recoverable error', async () => {
  const h = harness({ list: async () => ({ status: 'busy' }) });
  await settle();
  await h.runTimer();
  await h.runTimer();
  assert.equal(h.requests.length, 3);
  assert.equal(h.timers, 0);
  assert.equal(h.byId('empty-title').textContent, 'Catalogue unavailable');
  assert.equal(h.byId('retry-gallery').hidden, false);
  h.byId('retry-gallery').fire('click');
  await settle();
  assert.equal(h.requests.length, 4);
});

test('unavailable bridge and clipboard, drag and context menu have no data-export fallback', async () => {
  const h = harness({ available: false });
  await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.byId('empty-title').textContent, 'Private hub unavailable');
  for (const name of ['copy', 'cut', 'paste', 'dragstart', 'drop', 'contextmenu']) {
    const event = h.document.fire(name);
    assert.equal(event.defaultPrevented, true, name);
    assert.equal(event.stopped, name !== 'copy' && name !== 'cut', name);
  }
});

async function selectFirst(h: ReturnType<typeof harness>): Promise<void> {
  await settle();
  h.cards[0].fire('click');
  await settle();
}

function draftNotes(h: ReturnType<typeof harness>, value = 'Changed private notes'): void {
  h.byId('details-notes').value = value;
  h.byId('details-notes').fire('input');
}

function draftTag(h: ReturnType<typeof harness>, value = 'New tag'): void {
  h.byId('tag-draft').value = value;
  h.byId('tag-draft').fire('input');
}

function renderedTags(h: ReturnType<typeof harness>): string[] {
  return h.byId('details-tags').children.map(chip => chip.children[0].textContent);
}

test('Save sends an explicit revision with literal notes and whole tags, then keeps selected media', async () => {
  const h = harness({ detail: async () => detail(item(), { tags: ['Legacy, with comma', 'Remove me'] }),
    save: async request => ({ status: 'saved', item: { ...detail().item, ...request,
      revision: 'b'.repeat(32), tags: ['Legacy, with comma', 'New > Tag', 'Another, whole tag'] } }) });
  await selectFirst(h);
  const video = h.byId('preview-video');
  h.byId('play-preview').fire('click');
  await settle();
  h.byId('details-tags').children[1].children[1].fire('click');
  draftNotes(h, '<script>literal notes</script>\nSecond line');
  draftTag(h, 'New > Tag');
  h.byId('add-tag').fire('click');
  draftTag(h, 'Another, whole tag');
  assert.equal(h.saves.length, 0, 'Typing, adding and removing tags must not persist implicitly');
  const paused = video.pauses;
  h.byId('save-details').fire('click');
  await settle();
  assert.deepEqual(h.saves, [{ id: 'opaque-0', revision: 'a'.repeat(32),
    notes: '<script>literal notes</script>\nSecond line', tags: ['Legacy, with comma', 'New > Tag', 'Another, whole tag'] }]);
  assert.equal(h.byId('details-notes').value, '<script>literal notes</script>\nSecond line');
  assert.deepEqual(renderedTags(h), ['Legacy, with comma', 'New > Tag', 'Another, whole tag']);
  assert.equal(h.byId('edit-status').textContent, 'Changes saved.');
  assert.equal(h.byId('save-details').disabled, true);
  assert.equal(h.byId('discard-details').disabled, true);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(video.pauses, paused);
  assert.equal(video.src, 'theatrum://app/media/clips/0.mp4');
  assert.equal(h.cards[0].getAttribute('aria-pressed'), 'true');
  draftNotes(h, 'A later edit');
  h.byId('save-details').fire('click');
  await settle();
  assert.equal(h.saves[1].revision, 'b'.repeat(32), 'The saved revision becomes the next save authority');
});

test('unsaved notes block selection, paging, search and close without discarding the draft', async () => {
  const h = harness({ list: async () => ready([item(0), item(1)], 50) });
  await selectFirst(h);
  draftNotes(h);
  h.cards[1].fire('click');
  h.byId('next-page').fire('click');
  const search = h.byId('gallery-search');
  search.value = 'a different query'; search.fire('input');
  h.byId('close-details').fire('click');
  h.document.fire('keydown', { key: 'Escape', target: h.cards[1] });
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.selections.length, 1);
  assert.equal(search.value, '');
  assert.equal(h.focused, h.byId('details-notes'));
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('details-notes').value, 'Changed private notes');
  assert.match(h.byId('edit-status').textContent, /Save or discard/);
  assert.equal(h.byId('lock-warning').hidden, false);
  assert.equal(h.byId('lock-hub').disabled, false);
});

test('a pending tag and edits made during search debounce also block navigation', async () => {
  const h = harness();
  await selectFirst(h);
  h.byId('gallery-search').value = 'new query';
  h.byId('gallery-search').fire('input');
  draftTag(h, 'Not yet added, one tag');
  await h.runTimer();
  assert.equal(h.requests.length, 1);
  assert.equal(h.byId('gallery-search').value, '');
  assert.equal(h.byId('tag-draft').value, 'Not yet added, one tag');
  assert.equal(h.focused, h.byId('tag-draft'));
  h.byId('close-details').fire('click');
  assert.equal(h.byId('details-panel').hidden, false);
});

for (const status of ['invalid', 'unavailable', 'busy', 'conflict']) {
  test(`a ${status} save keeps notes and tags available for recovery`, async () => {
    const h = harness({ save: async () => ({ status, error: '/private/secret-path' }) });
    await selectFirst(h);
    draftNotes(h);
    draftTag(h, '<literal>, one tag');
    h.byId('save-details').fire('click');
    await settle();
    assert.equal(h.byId('details-notes').value, 'Changed private notes');
    assert.deepEqual(renderedTags(h), ['Nature', '<literal>, one tag']);
    assert.equal(h.byId('discard-details').disabled, false);
    assert.equal(h.byId('save-details').disabled, status === 'conflict');
    assert.match(h.byId('edit-status').textContent, /edits are still here/);
    assert.doesNotMatch(h.byId('edit-status').textContent, /secret-path/);
    h.byId('close-details').fire('click');
    assert.equal(h.byId('details-panel').hidden, false);
  });
}

test('Discard fetches the latest encrypted metadata and its revision after a conflict', async () => {
  let latest = false;
  const h = harness({ detail: async () => detail(item(), latest
    ? { notes: 'Latest saved notes', tags: ['Latest tag'], revision: 'c'.repeat(32) } : {}),
  save: async () => ({ status: 'conflict' }) });
  await selectFirst(h);
  draftNotes(h);
  h.byId('save-details').fire('click');
  await settle();
  latest = true;
  h.byId('discard-details').fire('click');
  await settle();
  assert.equal(h.selections.length, 2);
  assert.equal(h.byId('details-notes').value, 'Latest saved notes');
  assert.deepEqual(renderedTags(h), ['Latest tag']);
  assert.equal(h.byId('save-details').disabled, true);
  assert.equal(h.byId('discard-details').disabled, true);
  draftNotes(h, 'Merged later');
  h.byId('save-details').fire('click');
  await settle();
  assert.equal(h.saves[1].revision, 'c'.repeat(32));
});

test('a failed Discard reload keeps the draft instead of replacing it with stale initial metadata', async () => {
  let fail = false;
  const h = harness({ detail: async () => fail ? { status: 'unavailable' } : detail() });
  await selectFirst(h);
  draftNotes(h);
  draftTag(h, 'Pending draft tag');
  fail = true;
  h.byId('discard-details').fire('click');
  await settle();
  assert.equal(h.byId('details-notes').value, 'Changed private notes');
  assert.equal(h.byId('tag-draft').value, 'Pending draft tag');
  assert.equal(h.byId('discard-details').disabled, false);
  assert.match(h.byId('edit-status').textContent, /Your edits are still here/);
});

test('pending saves freeze editing and navigation while retaining an immediate Lock action', async () => {
  const pending = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)], 50), save: async () => pending.promise });
  await selectFirst(h);
  draftNotes(h);
  h.byId('save-details').fire('click');
  h.byId('save-details').fire('click');
  h.byId('discard-details').fire('click');
  h.cards[1].fire('click');
  h.byId('next-page').fire('click');
  h.byId('close-details').fire('click');
  await settle();
  assert.equal(h.saves.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.selections.length, 1);
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('tag-draft').disabled, true);
  assert.equal(h.byId('details-tags').children[0].children[1].disabled, true);
  assert.equal(h.byId('discard-details').disabled, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.match(h.byId('lock-warning').textContent, /save already in progress may finish/);
  pending.resolve({ status: 'busy' });
  await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
});

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} clears drafts and rejects a late save result`, async () => {
    const pending = deferred();
    const h = harness({ save: async () => pending.promise, lock: () => {
      assert.equal(h.byId('details-notes').value, '');
      assert.equal(h.byId('tag-draft').value, '');
      assert.equal(h.byId('details-tags').children.length, 0);
      assert.equal(h.cards.length, 0);
    } });
    await selectFirst(h);
    draftNotes(h);
    draftTag(h);
    h.byId('save-details').fire('click');
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
    else { h.window.fire('pagehide'); }
    pending.resolve({ status: 'saved', item: detail(item(), { notes: 'Never redraw this', tags: ['Secret'] }).item });
    await settle();
    assert.equal(h.byId('details-notes').value, '');
    assert.equal(h.byId('tag-draft').value, '');
    assert.equal(h.byId('details-tags').children.length, 0);
    assert.equal(h.byId('edit-status').textContent, '');
    assert.equal(h.byId('details-panel').hidden, true);
    assert.equal(h.cards.length, 0);
    assert.equal(h.requests.length, 1, 'Stale save replies cannot refresh catalogue data after lock');
  });
}

test('notes and new tag bounds are enforced before sending saves', async () => {
  const h = harness();
  await selectFirst(h);
  draftNotes(h, 'N'.repeat(65537));
  h.byId('save-details').fire('click');
  assert.equal(h.saves.length, 0);
  assert.match(h.byId('edit-status').textContent, /65,536/);
  draftNotes(h, 'Within the limit');
  draftTag(h, 'T'.repeat(513));
  h.byId('add-tag').fire('click');
  h.byId('save-details').fire('click');
  assert.equal(h.saves.length, 0);
  assert.equal(h.byId('tag-draft').value.length, 513);
  draftTag(h, 'T'.repeat(512));
  h.byId('save-details').fire('click');
  await settle();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].tags[1].length, 512);
});

test('a full tag set keeps all existing tags and rejects another pending tag', async () => {
  const tags = Array.from({ length: 128 }, (_, index) => `Tag ${index}`);
  const h = harness({ detail: async () => detail(item(), { tags }) });
  await selectFirst(h);
  draftTag(h, 'One too many');
  assert.equal(h.byId('add-tag').disabled, true);
  h.byId('save-details').fire('click');
  assert.equal(h.saves.length, 0);
  assert.deepEqual(renderedTags(h), tags);
  assert.equal(h.byId('tag-draft').value, 'One too many');
});

test('read-only or oversized note/tag projections cannot be saved', async () => {
  for (const patch of [{ editable: false }, { revision: 'invalid' }, { notes: 'N'.repeat(65537) },
    { tags: Array(129).fill('Tag') }, { tags: ['T'.repeat(513)] }]) {
    const h = harness({ detail: async () => detail(item(), patch) });
    await selectFirst(h);
    assert.equal(h.byId('details-notes').readOnly, true);
    assert.equal(h.byId('save-details').hidden, true);
    assert.equal(h.byId('tag-entry').hidden, true);
    draftNotes(h, 'Do not persist');
    h.byId('save-details').fire('click');
    assert.equal(h.saves.length, 0);
    assert.match(h.byId('edit-status').textContent, /read-only/);
  }
});

test('title-only truncation does not disable otherwise editable notes and tags', async () => {
  const h = harness({ detail: async () => detail(item(), { title: 'T'.repeat(2048), truncated: true, editable: true }) });
  await selectFirst(h);
  assert.equal(h.byId('shortened-notice').hidden, false);
  assert.equal(h.byId('details-notes').readOnly, false);
  draftNotes(h);
  h.byId('save-details').fire('click');
  await settle();
  assert.equal(h.saves.length, 1);
});

test('IME composition blocks Save and Add until the complete tag text is committed', async () => {
  const h = harness();
  await selectFirst(h);
  const input = h.byId('tag-draft');
  input.fire('compositionstart');
  draftTag(h, 'Draft, one tag');
  input.fire('keydown', { key: 'Enter', isComposing: true });
  h.byId('save-details').fire('click');
  h.byId('add-tag').fire('click');
  assert.equal(h.saves.length, 0);
  assert.deepEqual(renderedTags(h), ['Nature']);
  assert.equal(h.byId('save-details').disabled, true);
  assert.equal(h.byId('add-tag').disabled, true);
  input.fire('compositionend');
  input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(renderedTags(h), ['Nature', 'Draft, one tag']);
  h.byId('save-details').fire('click');
  await settle();
  assert.equal(h.saves.length, 1);
});

test('saving tags refreshes active search results without closing the saved video detail', async () => {
  let saved = false;
  const h = harness({ list: async request => ready(saved && request.query ? [] : [item()]),
    save: async request => {
      saved = true;
      return { status: 'saved', item: { ...detail().item, notes: request.notes, tags: request.tags, revision: 'b'.repeat(32) } };
    } });
  await settle();
  h.byId('gallery-search').value = 'Nature'; h.byId('gallery-search').fire('input');
  await h.runTimer();
  h.cards[0].fire('click'); await settle();
  h.byId('details-tags').children[0].children[1].fire('click');
  h.byId('save-details').fire('click');
  await settle();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].query, 'Nature');
  assert.equal(h.cards.length, 0);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('details-title').textContent, 'Private video 0');
  assert.equal(h.byId('save-details').disabled, true);
  assert.equal(h.byId('empty-title').textContent, 'No matching videos');
});

test('regeneration sends only selection authority and refreshes retired media without autoplay', async () => {
  const pending = deferred();
  const h = harness({ regenerate: async () => {
    assert.equal(h.byId('detail-poster').src, '', 'The old decoded image must retire before the asynchronous operation');
    assert.equal(h.byId('detail-poster').onload, null);
    assert.equal(h.byId('detail-poster').hidden, true);
    return pending.promise;
  } });
  await selectFirst(h);
  const oldThumbnail = h.images.find(image => image.src.includes('/thumbnails/'))!;
  oldThumbnail.onload!();
  const poster = h.byId('detail-poster');
  poster.onload!();
  h.byId('play-preview').fire('click'); await settle();
  const video = h.byId('preview-video');
  h.byId('regenerate-previews').fire('click');
  assert.deepEqual(h.generations, [{ id: 'opaque-0', revision: 'a'.repeat(32) }]);
  assert.equal(video.src, '');
  assert.equal(video.hidden, true);
  assert.equal(poster.src, '');
  assert.equal(poster.hidden, true);
  assert.equal(h.byId('play-preview').disabled, true);
  pending.resolve({ status: 'generated', item: detail(item(), { revision: 'b'.repeat(32) }).item });
  await settle();
  assert.equal(oldThumbnail.src, '');
  assert.equal(oldThumbnail.isConnected, false);
  assert.ok(h.activeImages.some(image => image !== oldThumbnail && image.src === 'theatrum://app/media/thumbnails/0.jpg'));
  assert.equal(poster.starts.length, 2, 'The same no-store poster URL is requested again');
  assert.equal(video.src, '', 'A generated clip never starts until another explicit Play action');
  assert.equal(video.plays, 1);
  assert.equal(h.byId('generation-status').textContent, 'Previews regenerated.');
  assert.equal(h.byId('regenerate-previews').disabled, false);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('details-notes').value, 'Private notes');
});

test('a retired poster cannot finish during regeneration and recoverable failure reloads its original route', async () => {
  const pending = deferred();
  const h = harness({ regenerate: async () => pending.promise });
  await selectFirst(h);
  const poster = h.byId('detail-poster');
  const staleLoaded = poster.onload!;
  const staleError = poster.onerror!;
  h.byId('regenerate-previews').fire('click');
  assert.equal(poster.src, '');
  staleLoaded(); staleError();
  assert.equal(poster.hidden, true);
  assert.equal(poster.src, '');
  assert.equal(h.byId('detail-placeholder').hidden, false);
  assert.equal(h.timers, 0);
  pending.resolve({ status: 'source-unavailable' });
  await settle();
  assert.equal(poster.starts.length, 2);
  assert.equal(poster.src, 'theatrum://app/media/clips/0.jpg');
  assert.equal(poster.hidden, true);
  poster.onload!();
  assert.equal(poster.hidden, false);
  assert.equal(h.byId('detail-placeholder').hidden, true);
  assert.equal(h.byId('preview-video').src, '');
});

test('native-picker cancellation followed by regeneration retires the same poster before each IPC request', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({ regenerate: async () => {
    assert.equal(h.byId('detail-poster').src, '');
    assert.equal(h.byId('detail-poster').hidden, true);
    return ++calls === 1 ? first.promise : second.promise;
  } });
  await selectFirst(h);
  const poster = h.byId('detail-poster');
  poster.onload!();
  h.byId('regenerate-previews').fire('click');
  first.resolve({ status: 'cancelled' }); await settle();
  assert.equal(poster.starts.length, 2);
  poster.onload!();
  assert.equal(poster.hidden, false);
  h.byId('regenerate-previews').fire('click');
  assert.equal(poster.src, '');
  second.resolve({ status: 'generated', item: detail(item(), { revision: 'c'.repeat(32) }).item });
  await settle();
  assert.equal(poster.starts.length, 3);
  poster.onload!();
  assert.equal(poster.hidden, false);
  assert.equal(h.byId('generation-status').textContent, 'Previews regenerated.');
});

test('notes, pending tags and IME prevent regeneration from dropping an unsaved draft', async () => {
  for (const kind of ['notes', 'tag', 'composition']) {
    const h = harness();
    await selectFirst(h);
    if (kind === 'notes') { draftNotes(h); }
    if (kind === 'tag') { draftTag(h, 'Pending tag'); }
    if (kind === 'composition') { h.byId('details-notes').fire('compositionstart'); }
    h.byId('regenerate-previews').fire('click');
    await settle();
    assert.equal(h.generations.length, 0, kind);
    assert.equal(h.byId('details-panel').hidden, false);
    if (kind === 'notes') { assert.equal(h.byId('details-notes').value, 'Changed private notes'); }
    if (kind === 'tag') { assert.equal(h.byId('tag-draft').value, 'Pending tag'); }
    if (kind !== 'composition') { assert.match(h.byId('generation-status').textContent, /Save or discard/); }
  }
});

test('regeneration freezes notes, tags, navigation and duplicate starts while Lock and Cancel stay available', async () => {
  const pending = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)], 50), regenerate: async () => pending.promise });
  await selectFirst(h);
  h.byId('regenerate-previews').fire('click');
  h.byId('regenerate-previews').fire('click');
  h.cards[1].fire('click');
  h.byId('next-page').fire('click');
  h.byId('gallery-search').value = 'Another search'; h.byId('gallery-search').fire('input');
  h.byId('close-details').fire('click');
  h.byId('save-details').fire('click');
  h.byId('play-preview').fire('click');
  assert.equal(h.generations.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.selections.length, 1);
  assert.equal(h.saves.length, 0);
  assert.equal(h.byId('gallery-search').value, '');
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('tag-draft').disabled, true);
  assert.equal(h.byId('details-tags').children[0].children[1].disabled, true);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('cancel-regeneration').hidden, false);
  assert.equal(h.byId('cancel-regeneration').disabled, false);
  assert.equal(h.byId('lock-hub').disabled, false);
  pending.resolve({ status: 'unavailable' }); await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
});

test('Cancel waits for drainage, then reloads metadata and previews even if publication may have occurred', async () => {
  const pending = deferred();
  let latest = false;
  const h = harness({ regenerate: async () => pending.promise,
    detail: async () => detail(item(), latest ? { revision: 'c'.repeat(32), notes: 'Latest stored notes' } : {}) });
  await selectFirst(h);
  const oldThumbnail = h.images.find(image => image.src.includes('/thumbnails/'))!;
  h.byId('regenerate-previews').fire('click');
  h.byId('cancel-regeneration').fire('click');
  h.byId('cancel-regeneration').fire('click');
  h.byId('close-details').fire('click');
  assert.equal(h.cancellations, 1);
  assert.equal(h.byId('cancel-regeneration').disabled, true);
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.selections.length, 1, 'No refresh starts until the outstanding operation finishes');
  latest = true;
  pending.resolve({ status: 'cancelled' }); await settle();
  assert.equal(h.selections.length, 2);
  assert.equal(h.byId('details-notes').value, 'Latest stored notes');
  assert.equal(h.byId('generation-status').textContent, 'Regeneration stopped. Previews refreshed.');
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('cancel-regeneration').hidden, true);
  assert.equal(oldThumbnail.src, '');
  assert.equal(h.byId('preview-video').src, '');
});

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} clears a running regeneration and ignores late success`, async () => {
    const pending = deferred();
    const h = harness({ regenerate: async () => pending.promise, lock: () => {
      assert.equal(h.cards.length, 0);
      assert.equal(h.byId('details-notes').value, '');
      assert.equal(h.byId('generation-status').textContent, '');
      assert.equal(h.byId('preview-video').src, '');
    } });
    await selectFirst(h);
    h.byId('regenerate-previews').fire('click');
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
    else { h.window.fire('pagehide'); }
    pending.resolve({ status: 'generated', item: detail(item(), { notes: 'Never redraw private notes' }).item });
    await settle();
    assert.equal(h.byId('details-notes').value, '');
    assert.equal(h.byId('generation-status').textContent, '');
    assert.equal(h.byId('details-panel').hidden, true);
    assert.equal(h.byId('cancel-regeneration').hidden, true);
    assert.equal(h.cards.length, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.activeImages.length, 0);
  });
}

for (const status of ['busy', 'source-unavailable', 'wrong-folder', 'unavailable']) {
  test(`${status} regeneration reports a generic recoverable status without source diagnostics`, async () => {
    const h = harness({ regenerate: async () => ({ status, sourcePath: '/secret/original.mp4', error: 'Private decoder stderr' }) });
    await selectFirst(h);
    h.byId('regenerate-previews').fire('click'); await settle();
    assert.equal(h.byId('regenerate-previews').disabled, false);
    assert.equal(h.byId('details-notes').readOnly, false);
    assert.equal(h.byId('details-notes').value, 'Private notes');
    assert.equal(h.byId('cancel-regeneration').hidden, true);
    assert.ok(h.byId('generation-status').textContent.length > 0);
    assert.doesNotMatch(h.byId('generation-status').textContent, /secret|original\.mp4|stderr/);
  });
}

test('a regeneration conflict exposes reload even when the video metadata is read-only', async () => {
  let latest = false;
  const h = harness({ regenerate: async () => ({ status: 'conflict' }),
    detail: async () => detail(item(), { editable: false, revision: (latest ? 'b' : 'a').repeat(32) }) });
  await selectFirst(h);
  h.byId('regenerate-previews').fire('click'); await settle();
  assert.equal(h.byId('regenerate-previews').disabled, true);
  assert.equal(h.byId('retry-details').hidden, false);
  assert.equal(h.byId('retry-details').textContent, 'Reload details');
  latest = true;
  h.byId('retry-details').fire('click'); await settle();
  assert.equal(h.byId('retry-details').hidden, true);
  assert.equal(h.byId('regenerate-previews').disabled, false);
  assert.equal(h.byId('details-notes').readOnly, true);
  h.byId('regenerate-previews').fire('click'); await settle();
  assert.equal(h.generations[1].revision, 'b'.repeat(32));
});

test('main marks ambiguous or unsupported source selections non-regenerable', async () => {
  const h = harness({ detail: async () => detail(item(), { regenerable: false }) });
  await selectFirst(h);
  assert.equal(h.byId('regenerate-previews').disabled, true);
  h.byId('regenerate-previews').fire('click');
  assert.equal(h.generations.length, 0);
  assert.equal(h.byId('details-notes').readOnly, false, 'Source eligibility does not disable notes editing');
});

test('lock during cancellation refresh still suppresses late detail and media updates', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({ regenerate: async () => ({ status: 'cancelled' }),
    detail: async () => ++calls === 1 ? detail() : pending.promise });
  await selectFirst(h);
  h.byId('regenerate-previews').fire('click'); await settle();
  assert.equal(h.selections.length, 2);
  assert.equal(h.byId('details-notes').readOnly, true);
  h.byId('lock-hub').fire('click');
  pending.resolve(detail(item(), { notes: 'Never display stale completion' })); await settle();
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.byId('generation-status').textContent, '');
  assert.equal(h.requests.length, 1);
  assert.equal(h.activeImages.length, 0);
});

test('Protection reads only on opening and shows no default until the encrypted setting loads', async () => {
  const pending = deferred();
  const h = harness({ protection: async () => pending.promise });
  await settle();
  assert.equal(h.protectionReads, 0);
  assert.equal(h.byId('protection-panel').hidden, true);
  h.byId('protection-button').fire('click');
  assert.equal(h.protectionReads, 1);
  assert.equal(h.byId('protection-panel').hidden, false);
  assert.equal(h.byId('protection-button').getAttribute('aria-expanded'), 'true');
  assert.equal(h.byId('auto-lock-minutes').value, '');
  assert.equal(h.byId('auto-lock-minutes').disabled, true);
  assert.equal(h.byId('save-protection').disabled, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  pending.resolve({ status: 'ready', autoLockMinutes: 5 }); await settle();
  assert.equal(h.byId('auto-lock-minutes').value, '5');
  assert.equal(h.byId('auto-lock-minutes').disabled, false);
  assert.equal(h.byId('save-protection').disabled, true);
  assert.equal(h.focused, h.byId('auto-lock-minutes'));
  assert.equal(h.timers, 0, 'There is no renderer activity heartbeat');
  assert.match(html, /inactivity in this private window, including while a preview is playing or previews are regenerating/);
  assert.match(html, /Locking clears unsaved edits/);
});

test('every allowed protection duration, including Off, saves only on an explicit action', async () => {
  for (const minutes of [0, 1, 5, 15, 30]) {
    const h = harness({ protection: async () => ({ status: 'ready', autoLockMinutes: minutes === 5 ? 1 : 5 }) });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    h.byId('auto-lock-minutes').value = String(minutes); h.byId('auto-lock-minutes').fire('change');
    assert.equal(h.protectionSaves.length, 0);
    assert.equal(h.byId('save-protection').disabled, false);
    h.byId('save-protection').fire('click'); await settle();
    assert.deepEqual(h.protectionSaves, [{ autoLockMinutes: minutes }]);
    assert.equal(h.byId('auto-lock-minutes').value, String(minutes));
    assert.equal(h.byId('save-protection').disabled, true);
    assert.equal(h.byId('protection-status').textContent, 'Protection setting saved.');
  }
});

test('failed or malformed protection reads keep the selector blank and offer retry without guessing', async () => {
  for (const response of [{ status: 'busy' }, { status: 'unavailable' }, { status: 'ready', autoLockMinutes: 7 },
    { status: 'ready', autoLockMinutes: '5' }, { status: 'ready', autoLockMinutes: null }, new Error('/private/setting')]) {
    let retry = false;
    const h = harness({ protection: async () => {
      if (retry) { return { status: 'ready', autoLockMinutes: 0 }; }
      if (response instanceof Error) { throw response; }
      return response;
    } });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    assert.equal(h.byId('auto-lock-minutes').value, '');
    assert.equal(h.byId('auto-lock-minutes').disabled, true);
    assert.equal(h.byId('save-protection').disabled, true);
    assert.equal(h.byId('retry-protection').hidden, false);
    assert.doesNotMatch(h.byId('protection-status').textContent, /private\/setting/);
    retry = true; h.byId('retry-protection').fire('click'); await settle();
    assert.equal(h.protectionReads, 2);
    assert.equal(h.byId('auto-lock-minutes').value, '0');
    assert.equal(h.byId('auto-lock-minutes').disabled, false);
    assert.equal(h.byId('retry-protection').hidden, true);
  }
});

test('failed protection saves retain the selection and reject mismatched native confirmations', async () => {
  for (const response of [{ status: 'busy' }, { status: 'unavailable' }, { status: 'saved', autoLockMinutes: 5 },
    { status: 'saved', autoLockMinutes: '15' }, new Error('/private/protection')]) {
    let retry = false;
    const h = harness({ setProtection: async request => {
      if (retry) { return { status: 'saved', autoLockMinutes: request.autoLockMinutes }; }
      if (response instanceof Error) { throw response; }
      return response;
    } });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
    h.byId('save-protection').fire('click'); await settle();
    assert.equal(h.byId('auto-lock-minutes').value, '15');
    assert.equal(h.byId('save-protection').disabled, false);
    assert.match(h.byId('protection-status').textContent, /Your selection is still here/);
    assert.doesNotMatch(h.byId('protection-status').textContent, /private\/protection/);
    retry = true; h.byId('save-protection').fire('click'); await settle();
    assert.equal(h.protectionSaves.length, 2);
    assert.equal(h.byId('save-protection').disabled, true);
  }
});

test('invalid protection choices cannot send a request or treat an empty selection as Off', async () => {
  const h = harness();
  await settle(); h.byId('protection-button').fire('click'); await settle();
  for (const value of ['', '05', '-1', '60', '1.0', 'Infinity', '<script>private()</script>']) {
    h.byId('auto-lock-minutes').value = value; h.byId('auto-lock-minutes').fire('change');
    assert.equal(h.byId('save-protection').disabled, true);
    h.byId('save-protection').fire('click');
  }
  assert.equal(h.protectionSaves.length, 0);
});

test('protection reads and saves preserve video drafts while blocking competing actions and navigation', async () => {
  const reading = deferred(); const writing = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)], 50), protection: async () => reading.promise,
    setProtection: async () => writing.promise });
  await selectFirst(h); draftNotes(h, 'Unsaved private notes'); draftTag(h, 'Pending private tag');
  h.byId('protection-button').fire('click');
  const assertFrozen = () => {
    h.byId('save-details').fire('click'); h.byId('discard-details').fire('click');
    h.byId('regenerate-previews').fire('click'); h.cards[1].fire('click');
    h.byId('next-page').fire('click'); h.byId('close-details').fire('click');
    h.byId('close-protection').fire('click');
    assert.equal(h.saves.length, 0); assert.equal(h.generations.length, 0);
    assert.equal(h.selections.length, 1); assert.equal(h.requests.length, 1);
    assert.equal(h.byId('details-notes').readOnly, true);
    assert.equal(h.byId('details-notes').value, 'Unsaved private notes');
    assert.equal(h.byId('tag-draft').value, 'Pending private tag');
    assert.equal(h.byId('details-panel').hidden, false);
    assert.equal(h.byId('protection-panel').hidden, false);
    assert.equal(h.byId('lock-hub').disabled, false);
  };
  assertFrozen();
  reading.resolve({ status: 'ready', autoLockMinutes: 5 }); await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
  h.byId('auto-lock-minutes').value = '30'; h.byId('auto-lock-minutes').fire('change');
  h.byId('save-protection').fire('click'); h.byId('save-protection').fire('click');
  assert.equal(h.protectionSaves.length, 1); assertFrozen();
  writing.resolve({ status: 'saved', autoLockMinutes: 30 }); await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('details-notes').value, 'Unsaved private notes');
  assert.equal(h.byId('tag-draft').value, 'Pending private tag');
});

test('video saves, discard reloads, regeneration and IME block protection requests', async () => {
  for (const operation of ['save', 'discard', 'regenerate', 'composition']) {
    const pending = deferred(); let discard = false;
    const h = harness({ save: async () => pending.promise, regenerate: async () => pending.promise,
      detail: async () => discard ? pending.promise : detail() });
    await selectFirst(h);
    h.byId('protection-button').fire('click'); await settle();
    h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
    if (operation === 'save') { draftNotes(h); h.byId('save-details').fire('click'); }
    if (operation === 'discard') { draftNotes(h); discard = true; h.byId('discard-details').fire('click'); }
    if (operation === 'regenerate') { h.byId('regenerate-previews').fire('click'); }
    if (operation === 'composition') { h.byId('details-notes').fire('compositionstart'); }
    assert.equal(h.byId('protection-button').disabled, true, operation);
    assert.equal(h.byId('save-protection').disabled, true, operation);
    h.byId('save-protection').fire('click'); h.byId('retry-protection').fire('click');
    assert.equal(h.protectionReads, 1); assert.equal(h.protectionSaves.length, 0);
    pending.resolve({ status: 'unavailable' });
    if (operation === 'composition') { h.byId('details-notes').fire('compositionend'); }
    await settle();
    assert.equal(h.byId('save-protection').disabled, false);
    assert.equal(h.byId('auto-lock-minutes').value, '15');
  }
});

for (const ending of ['lock', 'pagehide']) {
  for (const operation of ['read', 'save']) {
    test(`${ending} clears protection state before dispatch and ignores a late ${operation} response`, async () => {
      const pending = deferred();
      const h = harness({ protection: async () => operation === 'read' ? pending.promise : { status: 'ready', autoLockMinutes: 5 },
        setProtection: async () => pending.promise,
        lock: () => {
          assert.equal(h.byId('protection-panel').hidden, true);
          assert.equal(h.byId('auto-lock-minutes').value, '');
          assert.equal(h.byId('protection-status').textContent, '');
        } });
      await settle(); h.byId('protection-button').fire('click'); await settle();
      if (operation === 'save') {
        h.byId('auto-lock-minutes').value = '1'; h.byId('auto-lock-minutes').fire('change');
        h.byId('save-protection').fire('click');
      }
      if (ending === 'lock') { h.byId('lock-hub').fire('click'); } else { h.window.fire('pagehide'); }
      pending.resolve({ status: operation === 'read' ? 'ready' : 'saved', autoLockMinutes: 1 }); await settle();
      assert.equal(h.byId('protection-panel').hidden, true);
      assert.equal(h.byId('auto-lock-minutes').value, '');
      assert.equal(h.byId('auto-lock-minutes').disabled, true);
      assert.equal(h.byId('protection-status').textContent, '');
      assert.equal(h.byId('protection-button').disabled, true);
      assert.equal(h.byId('save-protection').disabled, true);
      assert.equal(h.byId('protection-button').getAttribute('aria-expanded'), 'false');
      assert.equal(h.cards.length, 0);
    });
  }
}

test('Escape respects the native selector and closes only Protection without dropping video drafts', async () => {
  const h = harness(); await selectFirst(h); draftNotes(h);
  h.byId('protection-button').fire('click'); await settle();
  assert.equal(h.document.fire('keydown', { key: 'Escape', target: h.byId('auto-lock-minutes') }).defaultPrevented, false);
  assert.equal(h.byId('protection-panel').hidden, false);
  assert.equal(h.document.fire('keydown', { key: 'Escape', target: h.byId('close-protection') }).defaultPrevented, true);
  assert.equal(h.byId('protection-panel').hidden, true);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('details-notes').value, 'Changed private notes');
  assert.equal(h.focused, h.byId('protection-button'));
  h.byId('protection-button').fire('click'); await settle();
  assert.equal(h.protectionReads, 2, 'Reopening reads the actual saved value again');
});


const passwordFieldIds = ['current-password', 'new-password', 'confirm-password'];

async function openPasswordForm(h: ReturnType<typeof harness>): Promise<void> {
  await settle();
  h.byId('protection-button').fire('click');
  await settle();
  h.byId('change-password-toggle').fire('click');
  assert.equal(h.byId('change-password-form').hidden, false);
}

function fillPasswords(h: ReturnType<typeof harness>, current = 'current passphrase', next = 'new passphrase', confirmation = next): void {
  for (const [index, value] of [current, next, confirmation].entries()) {
    const input = h.byId(passwordFieldIds[index]);
    input.value = value;
    input.fire('input');
  }
}

function assertPasswordsCleared(h: ReturnType<typeof harness>): void {
  for (const id of passwordFieldIds) { assert.equal(h.byId(id).value, '', id); }
}

test('password changes are expandable, masked, labelled and never enable spelling or autocomplete', async () => {
  const h = harness();
  await settle();
  assert.equal(h.byId('change-password-form').hidden, true);
  assert.equal(h.passwordChanges.length, 0);
  await openPasswordForm(h);
  assert.equal(h.byId('change-password-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(h.focused, h.byId('current-password'));
  for (const id of passwordFieldIds) {
    const markup = html.match(new RegExp(`<input[^>]+id="${id}"[^>]*>`))![0];
    assert.match(markup, /type="password"/);
    assert.match(markup, /autocomplete="off"/);
    assert.match(markup, /autocorrect="off"/);
    assert.match(markup, /spellcheck="false"/);
    assert.match(html, new RegExp(`<label for="${id}">`));
    assert.doesNotMatch(markup, /(?:title|value)=/);
  }
  assert.match(html, /Old copies still accept the password they were saved with/);
  assert.equal(h.byId('change-password-submit').textContent, 'Change password and lock');
});

test('password submission clears inputs and stops playback before invoking the dedicated bridge', async () => {
  const pending = deferred();
  const h = harness({ changePassword: request => {
    assertPasswordsCleared(h);
    assert.equal(h.byId('preview-video').src, '');
    assert.equal(h.byId('preview-video').hidden, true);
    assert.equal(request.currentPassword, '  current password  ');
    assert.equal(request.newPassword, '  new password  ');
    return pending.promise;
  } });
  await selectFirst(h);
  h.byId('play-preview').fire('click'); await settle();
  await openPasswordForm(h);
  fillPasswords(h, '  current password  ', '  new password  ');
  h.byId('change-password-form').fire('submit');
  assertPasswordsCleared(h);
  assert.deepEqual(h.passwordChanges, [{ currentPassword: '  current password  ', newPassword: '  new password  ' }]);
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.equal(h.byId('change-password-submit').disabled, true);
  assert.equal(h.byId('play-preview').disabled, true);
  assert.equal(h.byId('details-notes').value, 'Private notes');
  pending.resolve({ status: 'incorrect-password' }); await settle();
  assert.equal(h.byId('change-password-submit').disabled, false);
  assert.equal(h.byId('preview-video').src, '', 'A failed password change must not restart preview playback');
  assert.equal(h.byId('play-preview').hidden, false, 'The user can explicitly restart the preview after a failed change');
});

test('password validation enforces exact UTF-8 bounds, complete characters, confirmation and a changed value', async () => {
  const cases: [string, string, string, RegExp][] = [
    ['', 'next', 'next', /Enter current password/],
    ['current', '', '', /Enter new password/],
    ['current', 'next', '', /Enter password confirmation/],
    ['current', 'next', 'different', /do not match/],
    ['same', 'same', 'same', /different from/],
    ['c'.repeat(1025), 'next', 'next', /too long/],
    ['current', '😀'.repeat(257), '😀'.repeat(257), /too long/],
    ['current', 'next', 'é'.repeat(513), /too long/],
    ['\ud800', 'next', 'next', /incomplete character/],
    ['current', '\udfff', '\udfff', /incomplete character/],
    ['current', 'next', 'next\ud800', /incomplete character/],
  ];
  for (const [current, next, confirmation, expected] of cases) {
    const h = harness(); await openPasswordForm(h);
    fillPasswords(h, current, next, confirmation);
    assert.equal(h.byId('change-password-form').fire('submit').defaultPrevented, true);
    assertPasswordsCleared(h);
    assert.equal(h.passwordChanges.length, 0);
    assert.match(h.byId('password-status').textContent, expected);
  }
  for (const [current, next] of [[' ', '  '], ['c'.repeat(1024), '😀'.repeat(256)], ['é'.repeat(512), 'n']]) {
    const h = harness(); await openPasswordForm(h); fillPasswords(h, current, next);
    h.byId('change-password-form').fire('submit'); await settle();
    assert.deepEqual(h.passwordChanges, [{ currentPassword: current, newPassword: next }]);
    assertPasswordsCleared(h);
  }
});

test('wrong current passwords are retryable without retaining or echoing any password', async () => {
  const h = harness({ changePassword: async () => ({ status: 'incorrect-password', error: 'PRIVATE-CURRENT-PASSWORD' }) });
  await openPasswordForm(h);
  fillPasswords(h, 'PRIVATE-CURRENT-PASSWORD', 'PRIVATE-NEW-PASSWORD');
  h.byId('change-password-form').fire('submit'); await settle();
  assertPasswordsCleared(h);
  assert.match(h.byId('password-status').textContent, /current password is incorrect/);
  assert.equal(h.focused, h.byId('current-password'));
  assert.equal(h.byId('change-password-submit').disabled, false);
  for (const element of h.created) {
    assert.doesNotMatch(element.textContent, /PRIVATE-(CURRENT|NEW)-PASSWORD/);
    for (const value of element.attributes.values()) { assert.doesNotMatch(value, /PRIVATE-(CURRENT|NEW)-PASSWORD/); }
  }
  fillPasswords(h, 'retry current', 'retry new');
  h.byId('change-password-form').fire('submit'); await settle();
  assert.equal(h.passwordChanges.length, 2);
  assertPasswordsCleared(h);
});

test('password changes preserve and block on unsaved notes, pending tags and tag removals', async () => {
  for (const kind of ['notes', 'tag', 'removed-tag']) {
    const h = harness(); await selectFirst(h); await openPasswordForm(h);
    if (kind === 'notes') { draftNotes(h, 'Preserved private draft'); }
    if (kind === 'tag') { draftTag(h, 'Preserved pending tag'); }
    if (kind === 'removed-tag') { h.byId('details-tags').children[0].children[1].fire('click'); }
    const notes = h.byId('details-notes').value;
    const tag = h.byId('tag-draft').value;
    const tags = renderedTags(h);
    assert.equal(h.byId('change-password-submit').disabled, true);
    h.byId('change-password-form').fire('submit');
    assert.equal(h.passwordChanges.length, 0);
    assert.match(h.byId('password-status').textContent, /Save or discard/);
    assert.equal(h.byId('details-notes').value, notes);
    assert.equal(h.byId('tag-draft').value, tag);
    assert.deepEqual(renderedTags(h), tags);
  }
});

test('password changes wait for saves, reloads, regeneration, protection saves, gallery and detail requests', async () => {
  for (const operation of ['save', 'discard', 'regenerate', 'protection', 'list', 'detail']) {
    const pending = deferred(); let blockedDetail = false; let blockedList = false;
    const h = harness({ save: async () => pending.promise, regenerate: async () => pending.promise,
      setProtection: async () => pending.promise,
      list: async () => blockedList ? pending.promise : ready([item(0), item(1)], 50),
      detail: async () => blockedDetail ? pending.promise : detail() });
    await selectFirst(h); await openPasswordForm(h);
    if (operation === 'save') { draftNotes(h); h.byId('save-details').fire('click'); }
    if (operation === 'discard') { draftNotes(h); blockedDetail = true; h.byId('discard-details').fire('click'); }
    if (operation === 'regenerate') { h.byId('regenerate-previews').fire('click'); }
    if (operation === 'protection') {
      h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
      h.byId('save-protection').fire('click');
    }
    if (operation === 'list') { blockedList = true; h.byId('next-page').fire('click'); }
    if (operation === 'detail') { blockedDetail = true; h.cards[1].fire('click'); }
    assert.equal(h.byId('change-password-submit').disabled, true, operation);
    h.byId('change-password-form').fire('submit');
    assert.equal(h.passwordChanges.length, 0, operation);
    assert.equal(h.byId('lock-hub').disabled, false, operation);
    pending.resolve({ status: 'unavailable' }); await settle();
  }
});

test('password requests share the pending gate while Lock and concealment stay available', async () => {
  const pending = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)], 50), changePassword: async () => pending.promise });
  await selectFirst(h); await openPasswordForm(h); fillPasswords(h);
  h.byId('change-password-form').fire('submit');
  h.byId('change-password-form').fire('submit');
  h.byId('save-details').fire('click'); h.byId('discard-details').fire('click');
  h.byId('regenerate-previews').fire('click'); h.byId('play-preview').fire('click');
  h.byId('save-protection').fire('click'); h.byId('retry-protection').fire('click');
  h.byId('next-page').fire('click'); h.cards[1].fire('click');
  assert.equal(h.passwordChanges.length, 1);
  assert.equal(h.protectionReads, 1);
  assert.equal(h.protectionSaves.length, 0);
  assert.equal(h.saves.length, 0);
  assert.equal(h.generations.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.selections.length, 1);
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('tag-draft').disabled, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.equal(h.byId('close-protection').disabled, false);
  pending.resolve({ status: 'busy' }); await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('change-password-submit').disabled, false);
});

for (const ending of ['collapse', 'close', 'blur', 'hidden', 'lock', 'pagehide']) {
  test(`${ending} synchronously clears password inputs without discarding video drafts unless locking`, async () => {
    const h = harness(); await selectFirst(h); await openPasswordForm(h); fillPasswords(h);
    // A direct draft value simulates text committed just before the lifecycle event.
    h.byId('details-notes').value = 'Keep this draft';
    if (ending === 'collapse') { h.byId('change-password-toggle').fire('click'); }
    if (ending === 'close') { h.byId('close-protection').fire('click'); }
    if (ending === 'blur') { h.window.fire('blur'); }
    if (ending === 'hidden') { h.document.hidden = true; h.document.fire('visibilitychange'); }
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
    if (ending === 'pagehide') { h.window.fire('pagehide'); }
    assertPasswordsCleared(h);
    assert.equal(h.byId('details-notes').value, ['lock', 'pagehide'].includes(ending) ? '' : 'Keep this draft');
  });
}

for (const ending of ['collapse', 'close', 'lock', 'pagehide']) {
  test(`${ending} ignores late password failure and cannot restore fields or reopen Protection`, async () => {
    const pending = deferred(); const h = harness({ changePassword: async () => pending.promise });
    await openPasswordForm(h); fillPasswords(h); h.byId('change-password-form').fire('submit');
    if (ending === 'collapse') { h.byId('change-password-toggle').fire('click'); }
    if (ending === 'close') { h.byId('close-protection').fire('click'); }
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
    if (ending === 'pagehide') { h.window.fire('pagehide'); }
    pending.resolve({ status: 'incorrect-password' }); await settle();
    assertPasswordsCleared(h);
    assert.equal(h.byId('change-password-form').hidden, true);
    assert.equal(h.byId('password-status').textContent, '');
    if (ending !== 'collapse') { assert.equal(h.byId('protection-panel').hidden, true); }
    assert.equal(h.byId('change-password-toggle').getAttribute('aria-expanded'), 'false');
  });
}

test('password IME completion is not interpreted as submission and delayed background input is erased', async () => {
  const h = harness(); await openPasswordForm(h); fillPasswords(h);
  const input = h.byId('confirm-password');
  input.fire('compositionstart');
  assert.equal(h.byId('change-password-submit').disabled, true);
  assert.equal(input.fire('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, true);
  h.byId('change-password-form').fire('submit');
  assert.equal(h.passwordChanges.length, 0);
  assert.equal(input.value, 'new passphrase', 'An IME commit must not erase composing text');
  input.fire('compositionend');
  assert.equal(h.byId('change-password-submit').disabled, false);
  h.window.fire('blur');
  input.value = 'late composition secret'; input.fire('input');
  assertPasswordsCleared(h);
  h.window.fire('focus'); fillPasswords(h);
  h.byId('change-password-form').fire('submit'); await settle();
  assert.equal(h.passwordChanges.length, 1);
});

test('successful password acknowledgement clears the gallery without needing a renderer lock request', async () => {
  const h = harness({ changePassword: async () => ({ status: 'changed' }) });
  await selectFirst(h); await openPasswordForm(h); fillPasswords(h);
  h.byId('change-password-form').fire('submit'); await settle();
  assertPasswordsCleared(h);
  assert.equal(h.cards.length, 0);
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.byId('protection-panel').hidden, true);
  assert.equal(h.byId('password-status').textContent, '');
  assert.equal(h.lockCalls, 0, 'Main is responsible for committing and locking independently of response delivery');
  assert.equal(h.byId('lock-hub').disabled, true);
});

test('missing credential API and unknown or throwing responses never echo diagnostics', async () => {
  const absent = harness({ credentialsAvailable: false });
  await settle(); absent.byId('protection-button').fire('click'); await settle();
  assert.equal(absent.byId('change-password-toggle').disabled, true);
  for (const response of [{ status: 'invalid' }, { status: 'busy' }, { status: 'unavailable', error: '/secret/key-file' },
    { status: 'unknown', currentPassword: 'PRIVATE-PASSWORD' }, new Error('/secret/key-file')]) {
    const h = harness({ changePassword: async () => { if (response instanceof Error) { throw response; } return response; } });
    await openPasswordForm(h); fillPasswords(h); h.byId('change-password-form').fire('submit'); await settle();
    assertPasswordsCleared(h);
    assert.ok(h.byId('password-status').textContent.length > 0);
    assert.doesNotMatch(h.byId('password-status').textContent, /secret|key-file|PRIVATE-PASSWORD/);
  }
});


test('unsaved auto-lock choices must be saved or restored before changing the password', async () => {
  const h = harness(); await openPasswordForm(h);
  h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
  assert.equal(h.byId('change-password-submit').disabled, true);
  h.byId('change-password-form').fire('submit');
  assert.equal(h.passwordChanges.length, 0);
  assert.match(h.byId('password-status').textContent, /Save your auto-lock setting/);
  h.byId('save-protection').fire('click'); await settle();
  assert.equal(h.byId('change-password-submit').disabled, false);
  fillPasswords(h); h.byId('change-password-form').fire('submit'); await settle();
  assert.equal(h.passwordChanges.length, 1);
});

test('an outstanding password request remains gated after concealment until it finishes', async () => {
  const pending = deferred(); const h = harness({ changePassword: async () => pending.promise });
  await openPasswordForm(h); fillPasswords(h); h.byId('change-password-form').fire('submit');
  h.byId('close-protection').fire('click');
  assert.equal(h.byId('protection-panel').hidden, true);
  assert.equal(h.focused, h.byId('lock-hub'));
  assert.equal(h.byId('protection-button').disabled, true);
  h.byId('protection-button').fire('click');
  h.byId('change-password-form').fire('submit');
  assert.equal(h.passwordChanges.length, 1);
  pending.resolve({ status: 'incorrect-password' }); await settle();
  assert.equal(h.byId('protection-button').disabled, false);
  h.byId('protection-button').fire('click'); await settle();
  h.byId('change-password-toggle').fire('click');
  assert.equal(h.byId('password-status').textContent, '');
  assertPasswordsCleared(h);
});


async function openCopyForm(h: ReturnType<typeof harness>): Promise<void> {
  await settle(); h.byId('protection-button').fire('click'); await settle();
  h.byId('unprotected-copy-toggle').fire('click');
  assert.equal(h.byId('unprotected-copy-form').hidden, false);
}

function fillCopy(h: ReturnType<typeof harness>, password = 'current copy passphrase', acknowledge = true): void {
  h.byId('unprotected-copy-password').value = password;
  h.byId('unprotected-copy-password').fire('input');
  h.byId('unprotected-copy-acknowledge').checked = acknowledge;
  h.byId('unprotected-copy-acknowledge').fire('change');
}

function assertCopyCleared(h: ReturnType<typeof harness>): void {
  assert.equal(h.byId('unprotected-copy-password').value, '');
  assert.equal(h.byId('unprotected-copy-acknowledge').checked, false);
}

test('unprotected copy requires a masked password and a separate acknowledgement with explicit retained-file warnings', async () => {
  const h = harness(); await openCopyForm(h);
  const markup = html.match(/<input[^>]+id="unprotected-copy-password"[^>]*>/)![0];
  assert.match(markup, /type="password"/);
  assert.match(markup, /autocomplete="off"/);
  assert.match(markup, /autocorrect="off"/);
  assert.match(markup, /spellcheck="false"/);
  assert.doesNotMatch(markup, /(?:title|value)=/);
  assert.match(html, /<label for="unprotected-copy-password">Current password/);
  assert.match(html, /catalogue, notes, tags and previews/);
  assert.match(html, /encrypted hub and original videos are kept/);
  assert.match(html, /interrupted copy can leave unencrypted files/);
  assert.match(html, /Manual or automatic locking can interrupt copying/);
  assert.equal(h.byId('unprotected-copy-submit').disabled, true);
  fillCopy(h, 'private password', false);
  h.byId('unprotected-copy-form').fire('submit');
  assertCopyCleared(h);
  assert.equal(h.unprotectedCopies.length, 0);
  assert.match(h.byId('unprotected-copy-status').textContent, /Acknowledge/);
  assert.equal(h.byId('unprotected-copy-submit').disabled, true);
});

test('copy submission clears credentials before IPC and stops preview playback without locking on success', async () => {
  const pending = deferred();
  const h = harness({ createUnprotectedCopy: request => {
    assertCopyCleared(h);
    assertPasswordsCleared(h);
    assert.equal(h.byId('preview-video').src, '');
    assert.equal(h.byId('preview-video').hidden, true);
    assert.equal(request.password, '  exact copy password  ');
    assert.equal(request.acknowledge, true);
    return pending.promise;
  } });
  await selectFirst(h); h.byId('play-preview').fire('click'); await settle();
  await openCopyForm(h); fillCopy(h, '  exact copy password  ');
  h.byId('unprotected-copy-form').fire('submit');
  assert.deepEqual(h.unprotectedCopies, [{ password: '  exact copy password  ', acknowledge: true }]);
  assert.equal(h.byId('unprotected-copy-form').getAttribute('aria-busy'), 'true');
  assert.equal(h.byId('cancel-unprotected-copy').hidden, false);
  assert.equal(h.byId('cancel-unprotected-copy').disabled, false);
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.equal(h.focused, h.byId('cancel-unprotected-copy'));
  pending.resolve({ status: 'copied', destination: '/private/do-not-display', count: 777 }); await settle();
  assertCopyCleared(h);
  assert.equal(h.lockCalls, 0);
  assert.equal(h.cards.length, 1);
  assert.equal(h.byId('details-notes').value, 'Private notes');
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('unprotected-copy-form').getAttribute('aria-busy'), 'false');
  assert.equal(h.byId('cancel-unprotected-copy').hidden, true);
  assert.match(h.byId('unprotected-copy-status').textContent, /Unprotected copy created/);
  assert.match(h.byId('unprotected-copy-status').textContent, /encrypted hub and original videos were kept/);
  assert.doesNotMatch(h.byId('unprotected-copy-status').textContent, /private|777|do-not-display/);
  assert.equal(h.byId('preview-video').src, '');
  assert.equal(h.byId('play-preview').hidden, false);
  assert.equal(h.byId('play-preview').disabled, false);
  assert.equal(h.byId('lock-hub').disabled, false);
});

test('copy password validation preserves exact UTF-8 text and rejects empty, oversized or incomplete characters', async () => {
  for (const [password, expected] of [['', /Enter current password/], ['x'.repeat(1025), /too long/],
    ['😀'.repeat(257), /too long/], ['\ud800', /incomplete character/], ['abc\udfff', /incomplete character/]] as const) {
    const h = harness(); await openCopyForm(h); fillCopy(h, password);
    h.byId('unprotected-copy-form').fire('submit');
    assertCopyCleared(h);
    assert.equal(h.unprotectedCopies.length, 0);
    assert.match(h.byId('unprotected-copy-status').textContent, expected);
  }
  for (const password of [' ', 'é'.repeat(512), '😀'.repeat(256), 'x'.repeat(1024)]) {
    const h = harness(); await openCopyForm(h); fillCopy(h, password);
    h.byId('unprotected-copy-form').fire('submit'); await settle();
    assert.deepEqual(h.unprotectedCopies, [{ password, acknowledge: true }]);
    assertCopyCleared(h);
  }
});

test('switching credential sections conceals and clears the previous password or acknowledgement', async () => {
  const h = harness(); await openPasswordForm(h); fillPasswords(h);
  h.byId('unprotected-copy-toggle').fire('click');
  assertPasswordsCleared(h);
  assert.equal(h.byId('change-password-form').hidden, true);
  assert.equal(h.byId('change-password-toggle').getAttribute('aria-expanded'), 'false');
  fillCopy(h);
  h.byId('change-password-toggle').fire('click');
  assertCopyCleared(h);
  assert.equal(h.byId('unprotected-copy-form').hidden, true);
  assert.equal(h.byId('unprotected-copy-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(h.byId('change-password-form').hidden, false);
});

test('copy preserves and rejects unsaved notes, tag drafts, removed tags and unsaved auto-lock choices', async () => {
  for (const kind of ['notes', 'tag', 'removed-tag', 'protection']) {
    const h = harness(); await selectFirst(h); await openCopyForm(h);
    if (kind === 'notes') { draftNotes(h, 'Private preserved draft'); }
    if (kind === 'tag') { draftTag(h, 'Preserved pending tag'); }
    if (kind === 'removed-tag') { h.byId('details-tags').children[0].children[1].fire('click'); }
    if (kind === 'protection') { h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change'); }
    const notes = h.byId('details-notes').value;
    const tag = h.byId('tag-draft').value;
    const tags = renderedTags(h);
    h.byId('unprotected-copy-form').fire('submit');
    assert.equal(h.unprotectedCopies.length, 0);
    assert.equal(h.byId('unprotected-copy-submit').disabled, true);
    assert.match(h.byId('unprotected-copy-status').textContent, /Save/);
    assert.equal(h.byId('details-notes').value, notes);
    assert.equal(h.byId('tag-draft').value, tag);
    assert.deepEqual(renderedTags(h), tags);
    if (kind === 'protection') { assert.equal(h.byId('auto-lock-minutes').value, '15'); }
  }
});

test('copy cannot overlap saves, reloads, generation, protection saves, gallery requests or detail requests', async () => {
  for (const operation of ['save', 'discard', 'regenerate', 'protection', 'list', 'detail', 'composition']) {
    const pending = deferred(); let blockedDetail = false; let blockedList = false;
    const h = harness({ save: async () => pending.promise, regenerate: async () => pending.promise,
      setProtection: async () => pending.promise,
      list: async () => blockedList ? pending.promise : ready([item(0), item(1)], 50),
      detail: async () => blockedDetail ? pending.promise : detail() });
    await selectFirst(h); await openCopyForm(h);
    if (operation === 'save') { draftNotes(h); h.byId('save-details').fire('click'); }
    if (operation === 'discard') { draftNotes(h); blockedDetail = true; h.byId('discard-details').fire('click'); }
    if (operation === 'regenerate') { h.byId('regenerate-previews').fire('click'); }
    if (operation === 'protection') { h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change'); h.byId('save-protection').fire('click'); }
    if (operation === 'list') { blockedList = true; h.byId('next-page').fire('click'); }
    if (operation === 'detail') { blockedDetail = true; h.cards[1].fire('click'); }
    if (operation === 'composition') { h.byId('details-notes').fire('compositionstart'); }
    assert.equal(h.byId('unprotected-copy-submit').disabled, true, operation);
    h.byId('unprotected-copy-form').fire('submit');
    assert.equal(h.unprotectedCopies.length, 0, operation);
    assert.equal(h.byId('lock-hub').disabled, false, operation);
    pending.resolve({ status: 'unavailable' }); await settle();
  }
});

test('pending copy freezes editing and competing actions while its panel, Cancel and Lock remain available', async () => {
  const pending = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)], 50), createUnprotectedCopy: async () => pending.promise });
  await selectFirst(h); await openCopyForm(h); fillCopy(h);
  h.byId('unprotected-copy-form').fire('submit');
  h.byId('unprotected-copy-form').fire('submit');
  h.byId('change-password-toggle').fire('click'); h.byId('change-password-form').fire('submit');
  h.byId('save-details').fire('click'); h.byId('discard-details').fire('click');
  h.byId('regenerate-previews').fire('click'); h.byId('play-preview').fire('click');
  h.byId('save-protection').fire('click'); h.byId('retry-protection').fire('click');
  h.byId('next-page').fire('click'); h.cards[1].fire('click');
  h.byId('close-protection').fire('click'); h.byId('unprotected-copy-toggle').fire('click');
  h.document.fire('keydown', { key: 'Escape', target: h.byId('cancel-unprotected-copy') });
  assert.equal(h.unprotectedCopies.length, 1);
  assert.equal(h.passwordChanges.length, 0);
  assert.equal(h.protectionReads, 1);
  assert.equal(h.protectionSaves.length, 0);
  assert.equal(h.saves.length, 0);
  assert.equal(h.generations.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.selections.length, 1);
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('tag-draft').disabled, true);
  assert.equal(h.byId('protection-panel').hidden, false);
  assert.equal(h.byId('unprotected-copy-form').hidden, false);
  assert.equal(h.byId('cancel-unprotected-copy').disabled, false);
  assert.equal(h.byId('lock-hub').disabled, false);
  pending.resolve({ status: 'cancelled' }); await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('close-protection').disabled, false);
});

test('Cancel copy is one-shot and waits for drainage without claiming already copied files were removed', async () => {
  const pending = deferred(); const h = harness({ createUnprotectedCopy: async () => pending.promise });
  await openCopyForm(h); fillCopy(h); h.byId('unprotected-copy-form').fire('submit');
  h.byId('cancel-unprotected-copy').fire('click'); h.byId('cancel-unprotected-copy').fire('click');
  assert.equal(h.copyCancellations, 1);
  assert.equal(h.byId('cancel-unprotected-copy').disabled, true);
  assert.equal(h.byId('unprotected-copy-toggle').disabled, true);
  assert.equal(h.byId('unprotected-copy-form').getAttribute('aria-busy'), 'true');
  assert.match(h.byId('unprotected-copy-status').textContent, /Stopping the copy/);
  assert.match(h.byId('unprotected-copy-status').textContent, /already copied remain unencrypted/);
  pending.resolve({ status: 'cancelled' }); await settle();
  assert.match(h.byId('unprotected-copy-status').textContent, /Copy cancelled/);
  assert.match(h.byId('unprotected-copy-status').textContent, /already copied remain unencrypted/);
  assert.equal(h.byId('unprotected-copy-form').getAttribute('aria-busy'), 'false');
  assert.equal(h.byId('cancel-unprotected-copy').hidden, true);
  assert.equal(h.lockCalls, 0);
  assertCopyCleared(h);
});

test('a copy completed before cancellation acknowledgement reports the actual success', async () => {
  const pending = deferred(); const h = harness({ createUnprotectedCopy: async () => pending.promise });
  await openCopyForm(h); fillCopy(h); h.byId('unprotected-copy-form').fire('submit');
  h.byId('cancel-unprotected-copy').fire('click');
  pending.resolve({ status: 'copied' }); await settle();
  assert.match(h.byId('unprotected-copy-status').textContent, /Unprotected copy created/);
  assert.doesNotMatch(h.byId('unprotected-copy-status').textContent, /cancelled|erased|deleted/);
});

for (const ending of ['collapse', 'close', 'blur', 'hidden', 'lock', 'pagehide']) {
  test(`${ending} clears the copy password and acknowledgement while preserving unrelated drafts unless locked`, async () => {
    const h = harness(); await selectFirst(h); await openCopyForm(h); fillCopy(h);
    h.byId('details-notes').value = 'Keep private draft';
    if (ending === 'collapse') { h.byId('unprotected-copy-toggle').fire('click'); }
    if (ending === 'close') { h.byId('close-protection').fire('click'); }
    if (ending === 'blur') { h.window.fire('blur'); }
    if (ending === 'hidden') { h.document.hidden = true; h.document.fire('visibilitychange'); }
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
    if (ending === 'pagehide') { h.window.fire('pagehide'); }
    assertCopyCleared(h);
    assert.equal(h.byId('details-notes').value, ['lock', 'pagehide'].includes(ending) ? '' : 'Keep private draft');
  });
}

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} during copy clears all state and ignores late completion without refreshing the gallery`, async () => {
    const pending = deferred(); const h = harness({ createUnprotectedCopy: async () => pending.promise });
    await selectFirst(h); await openCopyForm(h); fillCopy(h); h.byId('unprotected-copy-form').fire('submit');
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); } else { h.window.fire('pagehide'); }
    pending.resolve({ status: 'copied' }); await settle();
    assertCopyCleared(h);
    assert.equal(h.byId('unprotected-copy-form').hidden, true);
    assert.equal(h.byId('unprotected-copy-status').textContent, '');
    assert.equal(h.byId('cancel-unprotected-copy').hidden, true);
    assert.equal(h.byId('protection-panel').hidden, true);
    assert.equal(h.cards.length, 0);
    assert.equal(h.requests.length, 1);
  });
}

test('copy IME composition cannot submit early and background input cannot restore cleared credentials', async () => {
  const h = harness(); await openCopyForm(h); fillCopy(h);
  const input = h.byId('unprotected-copy-password');
  input.fire('compositionstart');
  assert.equal(h.byId('unprotected-copy-submit').disabled, true);
  assert.equal(input.fire('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, true);
  h.byId('unprotected-copy-form').fire('submit');
  assert.equal(h.unprotectedCopies.length, 0);
  assert.equal(input.value, 'current copy passphrase');
  input.fire('compositionend');
  h.window.fire('blur');
  input.value = 'late private input'; input.fire('input');
  h.byId('unprotected-copy-acknowledge').checked = true; h.byId('unprotected-copy-acknowledge').fire('change');
  assertCopyCleared(h);
  h.window.fire('focus'); fillCopy(h); h.byId('unprotected-copy-form').fire('submit'); await settle();
  assert.equal(h.unprotectedCopies.length, 1);
});

test('a native destination picker blur clears fields without cancelling the pending copy', async () => {
  const pending = deferred(); const h = harness({ createUnprotectedCopy: async () => pending.promise });
  await openCopyForm(h); fillCopy(h); h.byId('unprotected-copy-form').fire('submit');
  h.window.fire('blur'); assertCopyCleared(h);
  assert.equal(h.copyCancellations, 0);
  assert.equal(h.byId('cancel-unprotected-copy').hidden, false);
  assert.match(h.byId('unprotected-copy-status').textContent, /Preparing the unprotected copy/);
  h.window.fire('focus'); pending.resolve({ status: 'copied' }); await settle();
  assert.match(h.byId('unprotected-copy-status').textContent, /Unprotected copy created/);
});

test('copy failures and unknown responses are generic, require fresh acknowledgement and retain any partial files', async () => {
  for (const response of [{ status: 'incorrect-password' }, { status: 'failed' }, { status: 'invalid' }, { status: 'busy' },
    { status: 'unavailable', destination: '/PRIVATE-COPY-PATH' }, { status: 'unknown', password: 'PRIVATE-COPY-SECRET' },
    new Error('/PRIVATE-COPY-PATH')]) {
    const h = harness({ createUnprotectedCopy: async () => { if (response instanceof Error) { throw response; } return response; } });
    await openCopyForm(h); fillCopy(h, 'PRIVATE-COPY-SECRET'); h.byId('unprotected-copy-form').fire('submit'); await settle();
    assertCopyCleared(h);
    assert.equal(h.byId('unprotected-copy-submit').disabled, true);
    assert.ok(h.byId('unprotected-copy-status').textContent.length > 0);
    if (!(response instanceof Error) && response.status === 'failed') {
      assert.match(h.byId('unprotected-copy-status').textContent, /already copied remain unencrypted/);
    }
    for (const element of h.created) {
      assert.doesNotMatch(element.textContent, /PRIVATE-COPY/);
      for (const value of element.attributes.values()) { assert.doesNotMatch(value, /PRIVATE-COPY/); }
    }
    fillCopy(h, 'retry password'); h.byId('unprotected-copy-form').fire('submit'); await settle();
    assert.equal(h.unprotectedCopies.length, 2);
  }
});

test('missing copy bridge and cancellation errors fail safely while preserving the independent Lock action', async () => {
  const absent = harness({ copyAvailable: false });
  await settle(); absent.byId('protection-button').fire('click'); await settle();
  assert.equal(absent.byId('unprotected-copy-toggle').disabled, true);
  assert.equal(absent.byId('change-password-toggle').disabled, false);
  const pending = deferred(); const h = harness({ createUnprotectedCopy: async () => pending.promise,
    cancelUnprotectedCopy: () => { throw new Error('/PRIVATE-COPY-PATH'); } });
  await openCopyForm(h); fillCopy(h); h.byId('unprotected-copy-form').fire('submit');
  h.byId('cancel-unprotected-copy').fire('click');
  assert.match(h.byId('unprotected-copy-status').textContent, /Cancellation could not be requested/);
  assert.doesNotMatch(h.byId('unprotected-copy-status').textContent, /PRIVATE-COPY/);
  assert.equal(h.byId('lock-hub').disabled, false);
  h.byId('lock-hub').fire('click');
  assert.equal(h.lockCalls, 1);
  pending.resolve({ status: 'cancelled' }); await settle();
  assert.equal(h.byId('unprotected-copy-status').textContent, '');
});


const exportEvents = ['copy', 'cut', 'dragstart', 'drop', 'contextmenu'];
const clipboardTrap = { getData() { throw new Error('Application code must not read clipboard data'); },
  setData() { throw new Error('Application code must not write clipboard data'); } };

test('gallery export restrictions capture metadata and credential events without changing their values', async () => {
  const h = harness(); await selectFirst(h); await openPasswordForm(h);
  fillPasswords(h, 'Synthetic current', 'Synthetic next');
  for (const name of exportEvents) {
    assert.deepEqual(h.document.captures.get(name), [true]);
    for (const id of [...passwordFieldIds, 'details-notes', 'details-title', 'detail-poster', 'gallery-grid']) {
      const target = h.byId(id);
      const before = target.value;
      const event = h.document.fire(name, { target, clipboardData: clipboardTrap, dataTransfer: clipboardTrap });
      assert.equal(event.defaultPrevented, true, name + '/' + id);
      assert.equal(event.stopped, name !== 'copy' && name !== 'cut', name + '/' + id);
      assert.equal(target.value, before, 'Copy/cut cannot erase the draft');
    }
  }
  assert.equal(h.saves.length, 0); assert.equal(h.passwordChanges.length, 0);
  assert.match(html, /Copying and dragging are disabled\. You can paste into password fields\./);
});

test('gallery permits native paste only into each active exact credential control without reading the clipboard', async () => {
  const h = harness(); await openPasswordForm(h);
  assert.deepEqual(h.document.captures.get('paste'), [true]);
  for (const id of passwordFieldIds) {
    const input = h.byId(id); input.focus();
    const event = h.document.fire('paste', { target: input, clipboardData: clipboardTrap });
    assert.equal(event.defaultPrevented, false, id); assert.equal(event.stopped, false, id);
    // Simulate the browser's default insertion only after the policy admits it.
    input.value = '  Synthetic 🐦 password  '; input.fire('input');
    assert.equal(input.value, '  Synthetic 🐦 password  ');
  }
  h.byId('unprotected-copy-toggle').fire('click');
  const copyInput = h.byId('unprotected-copy-password'); copyInput.focus();
  assert.equal(h.document.fire('paste', { target: copyInput, clipboardData: clipboardTrap }).defaultPrevented, false);
  copyInput.value = '  Synthetic copy  '; copyInput.fire('input');
  assert.equal(copyInput.value, '  Synthetic copy  ');
  assert.equal(h.passwordChanges.length, 0); assert.equal(h.unprotectedCopies.length, 0);
});

test('gallery rejects paste into notes, tags, search, page text and unidentified password inputs', async () => {
  const h = harness(); await selectFirst(h); await openPasswordForm(h);
  for (const id of ['details-notes', 'tag-draft', 'gallery-search', 'details-title', 'unprotected-copy-acknowledge']) {
    const target = h.byId(id); target.focus();
    const before = target.value;
    const event = h.document.fire('paste', { target, clipboardData: clipboardTrap });
    assert.equal(event.defaultPrevented, true, id); assert.equal(event.stopped, true, id);
    assert.equal(target.value, before);
  }
  const lookalike = new ElementStub('input'); lookalike.setAttribute('type', 'password');
  assert.equal(h.document.fire('paste', { target: lookalike, clipboardData: clipboardTrap }).defaultPrevented, true);
});

test('gallery rejects credential paste into disabled, readonly, hidden, unfocused or inactive controls', async () => {
  const variants = ['disabled', 'readonly', 'hidden', 'unfocused', 'form-hidden', 'panel-hidden', 'blur', 'document-hidden', 'lock', 'pagehide'];
  for (const copy of [false, true]) {
    for (const variant of variants) {
      const h = harness(); await (copy ? openCopyForm(h) : openPasswordForm(h));
      const input = h.byId(copy ? 'unprotected-copy-password' : 'current-password'); input.focus();
      if (variant === 'disabled') input.disabled = true;
      if (variant === 'readonly') input.readOnly = true;
      if (variant === 'hidden') input.hidden = true;
      if (variant === 'unfocused') h.byId('lock-hub').focus();
      if (variant === 'form-hidden') h.byId(copy ? 'unprotected-copy-form' : 'change-password-form').hidden = true;
      if (variant === 'panel-hidden') h.byId('protection-panel').hidden = true;
      if (variant === 'blur') h.window.fire('blur');
      if (variant === 'document-hidden') h.document.hidden = true;
      if (variant === 'lock') h.byId('lock-hub').fire('click');
      if (variant === 'pagehide') h.window.fire('pagehide');
      const event = h.document.fire('paste', { target: input, clipboardData: clipboardTrap });
      assert.equal(event.defaultPrevented, true, variant + '/' + copy); assert.equal(event.stopped, true);
    }
  }
});

test('gallery prevents paste while credential work is pending even if a control is made editable again', async () => {
  for (const copy of [false, true]) {
    const pending = deferred();
    const h = harness({ changePassword: () => pending.promise, createUnprotectedCopy: () => pending.promise });
    await (copy ? openCopyForm(h) : openPasswordForm(h));
    if (copy) fillCopy(h); else fillPasswords(h);
    h.byId(copy ? 'unprotected-copy-form' : 'change-password-form').fire('submit');
    const input = h.byId(copy ? 'unprotected-copy-password' : 'current-password');
    input.disabled = false; input.focus();
    assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true);
    pending.resolve({ status: 'incorrect-password' }); await settle();
    input.focus();
    assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, false);
  }
});

test('gallery clipboard policy does not intercept normal typing, input selection or composition', async () => {
  const h = harness(); await openPasswordForm(h);
  const input = h.byId('current-password'); input.focus();
  for (const key of ['a', 'ArrowLeft', 'Backspace']) {
    assert.equal(h.document.fire('keydown', { target: input, key, metaKey: key === 'a' }).defaultPrevented, false);
  }
  input.fire('compositionstart'); input.value = '組み立て'; input.fire('input');
  assert.equal(input.value, '組み立て');
  input.fire('compositionend');
  assert.equal(input.value, '組み立て');
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, false);
  h.window.fire('blur'); assert.equal(input.value, ''); h.window.fire('focus'); input.focus();
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, false);
});


async function openTouchId(h: ReturnType<typeof harness>): Promise<void> {
  await settle(); h.byId('protection-button').fire('click'); await settle();
  h.byId('touch-id-toggle').fire('click');
}

test('Touch ID protection reports device-local enabled, disabled and unavailable states honestly', async () => {
  for (const state of ['enabled', 'disabled', 'unknown']) {
    const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state, key: '/private' }) });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    assert.equal(h.touchIdReads, 1);
    assert.equal(h.byId('touch-id-toggle').hidden, state !== 'disabled');
    assert.equal(h.byId('touch-id-disable').hidden, state === 'disabled');
    assert.match(h.byId('touch-id-summary').textContent, state === 'unknown' ? /unavailable in this build or on this Mac/ : /on this Mac/);
    assert.doesNotMatch(h.byId('touch-id-summary').textContent, /private/);
    assert.equal(h.touchIdEnrollments.length, 0); assert.equal(h.touchIdDisables, 0);
  }
  assert.match(html, /Keep your hub password/); assert.match(html, /enrolled fingerprints change/);
});

test('Touch ID status failure leaves auto-lock and password controls available', async () => {
  const h = harness({ touchIdStatus: async () => { throw new Error('/private/key'); } });
  await settle(); h.byId('protection-button').fire('click'); await settle();
  assert.match(h.byId('touch-id-summary').textContent, /Use your hub password/);
  assert.equal(h.byId('auto-lock-minutes').disabled, false);
  assert.equal(h.byId('change-password-toggle').disabled, false);
});

test('Touch ID enrollment preserves exact Unicode, clears before dispatch and updates only on success', async () => {
  const pending = deferred();
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }),
    enableTouchId: request => { assert.equal(h.byId('touch-id-password').value, '');
      assert.equal(request.password, '  Synthetic 🐦 password  '); return pending.promise; } });
  await openTouchId(h);
  assert.equal(h.byId('touch-id-toggle').textContent, 'Cancel setup');
  h.byId('touch-id-password').value = '  Synthetic 🐦 password  ';
  h.byId('touch-id-form').fire('submit'); h.byId('touch-id-form').fire('submit');
  assert.equal(h.touchIdEnrollments.length, 1);
  assert.equal(h.byId('touch-id-submit').disabled, true);
  assert.equal(h.byId('gallery-search').disabled, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.match(h.byId('touch-id-summary').textContent, /is off/);
  pending.resolve({ outcome: 'enabled' }); await settle();
  assert.equal(h.byId('touch-id-form').hidden, true);
  assert.equal(h.byId('touch-id-disable').hidden, false);
  assert.match(h.byId('touch-id-summary').textContent, /is on/);
  assert.match(h.byId('touch-id-status').textContent, /password still works/);
});

test('Touch ID disable remains pending until completion and requires no password payload', async () => {
  const pending = deferred();
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'enabled' }), disableTouchId: () => pending.promise });
  await settle(); h.byId('protection-button').fire('click'); await settle();
  h.byId('touch-id-disable').fire('click'); h.byId('touch-id-disable').fire('click');
  assert.equal(h.touchIdDisables, 1); assert.match(h.byId('touch-id-summary').textContent, /is on/);
  pending.resolve({ outcome: 'disabled' }); await settle();
  assert.match(h.byId('touch-id-summary').textContent, /is off/);
  assert.equal(h.byId('touch-id-toggle').hidden, false);
});

test('invalid Touch ID enrollment credentials cannot reach the main process', async () => {
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }) });
  await openTouchId(h);
  for (const value of ['', '\ud800', 'é'.repeat(513)]) {
    h.byId('touch-id-password').value = value; h.byId('touch-id-form').fire('submit'); await settle();
    assert.equal(h.byId('touch-id-password').value, '');
    assert.equal(h.touchIdEnrollments.length, 0);
  }
});

test('Touch ID enrollment failure never reveals native errors and permits credential retry when appropriate', async () => {
  for (const outcome of ['incorrect-password', 'cancelled', 'unavailable', 'unknown']) {
    const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }),
      enableTouchId: async () => ({ outcome, key: '/private', error: 'secret' }) });
    await openTouchId(h); h.byId('touch-id-password').value = 'synthetic'; h.byId('touch-id-form').fire('submit'); await settle();
    assert.equal(h.byId('touch-id-password').value, '');
    assert.doesNotMatch(h.byId('touch-id-status').textContent, /private|secret/);
    assert.equal(h.byId('touch-id-form').hidden, !['incorrect-password', 'cancelled'].includes(outcome));
    assert.equal(h.byId('touch-id-disable').hidden, ['incorrect-password', 'cancelled'].includes(outcome));
  }
});

test('Touch ID changes preserve and respect unsaved video and protection edits', async () => {
  for (const dirtyKind of ['video', 'auto-lock']) {
    for (const state of ['enabled', 'disabled']) {
      const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state }) });
      await selectFirst(h); await openTouchId(h);
      if (dirtyKind === 'video') draftNotes(h, 'Unsaved synthetic note');
      else { h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change'); }
      h.byId('touch-id-password').value = 'synthetic'; h.byId('touch-id-form').fire('submit');
      h.byId('touch-id-disable').fire('click');
      assert.equal(h.touchIdEnrollments.length, 0); assert.equal(h.touchIdDisables, 0);
      assert.equal(h.byId('touch-id-password').value, '');
      if (dirtyKind === 'video') assert.equal(h.byId('details-notes').value, 'Unsaved synthetic note');
      else assert.equal(h.byId('auto-lock-minutes').value, '15');
    }
  }
});

test('Touch ID credential drafts clear on concealment, backgrounding and hub retirement', async () => {
  for (const ending of ['toggle', 'close', 'password', 'copy', 'blur', 'hidden', 'lock', 'pagehide']) {
    const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }) });
    await openTouchId(h); h.byId('touch-id-password').value = 'synthetic';
    if (ending === 'toggle') h.byId('touch-id-toggle').fire('click');
    if (ending === 'close') h.byId('close-protection').fire('click');
    if (ending === 'password') h.byId('change-password-toggle').fire('click');
    if (ending === 'copy') h.byId('unprotected-copy-toggle').fire('click');
    if (ending === 'blur' || ending === 'pagehide') h.window.fire(ending);
    if (ending === 'hidden') { h.document.hidden = true; h.document.fire('visibilitychange'); }
    if (ending === 'lock') h.byId('lock-hub').fire('click');
    assert.equal(h.byId('touch-id-password').value, '', ending);
  }
});

test('locking or retiring during Touch ID work ignores late status and success replies', async () => {
  for (const operation of ['status', 'enable', 'disable']) {
    for (const ending of ['lock', 'pagehide']) {
      const pending = deferred();
      const h = harness({ touchIdStatus: async () => operation === 'status' ? pending.promise
        : { outcome: 'available', state: operation === 'disable' ? 'enabled' : 'disabled' },
      enableTouchId: () => pending.promise, disableTouchId: () => pending.promise });
      await openTouchId(h);
      if (operation === 'enable') { h.byId('touch-id-password').value = 'synthetic'; h.byId('touch-id-form').fire('submit'); }
      if (operation === 'disable') h.byId('touch-id-disable').fire('click');
      if (ending === 'lock') h.byId('lock-hub').fire('click'); else h.window.fire('pagehide');
      pending.resolve({ outcome: operation === 'status' ? 'available' : operation === 'enable' ? 'enabled' : 'disabled', state: 'enabled' });
      await settle();
      assert.equal(h.byId('touch-id-summary').textContent, '');
      assert.equal(h.byId('touch-id-status').textContent, '');
      assert.equal(h.byId('protection-panel').hidden, true);
    }
  }
});

test('Touch ID password paste admits only the exact visible, focused and idle credential input', async () => {
  const pending = deferred();
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }), enableTouchId: () => pending.promise });
  await openTouchId(h);
  const input = h.byId('touch-id-password'); input.focus();
  assert.equal(h.document.fire('paste', { target: input, clipboardData: clipboardTrap }).defaultPrevented, false);
  h.window.fire('blur'); assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true);
  h.window.fire('focus'); input.focus(); input.value = 'synthetic'; h.byId('touch-id-form').fire('submit');
  input.disabled = false;
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true);
  pending.resolve({ outcome: 'enabled' }); await settle();
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true);
});

test('Touch ID password IME blocks early submission and background injection', async () => {
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }) });
  await openTouchId(h);
  const input = h.byId('touch-id-password'); input.fire('compositionstart'); input.value = '組み立て';
  assert.equal(input.fire('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, true);
  h.byId('touch-id-form').fire('submit'); assert.equal(h.touchIdEnrollments.length, 0);
  input.fire('compositionend');
  h.window.fire('blur'); input.value = 'injected'; input.fire('input');
  assert.equal(input.value, ''); assert.equal(h.touchIdEnrollments.length, 0);
});


test('disabling Touch ID clears drafts in other credential sections before dispatch', async () => {
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'enabled' }),
    disableTouchId: async () => { assert.equal(h.byId('current-password').value, '');
      assert.equal(h.byId('new-password').value, ''); assert.equal(h.byId('confirm-password').value, '');
      assert.equal(h.byId('change-password-form').hidden, true); return { outcome: 'disabled' }; } });
  await settle(); h.byId('protection-button').fire('click'); await settle();
  h.byId('change-password-toggle').fire('click');
  for (const id of ['current-password', 'new-password', 'confirm-password']) h.byId(id).value = 'synthetic';
  h.byId('touch-id-disable').fire('click'); await settle();
  assert.equal(h.touchIdDisables, 1);
});


test('unavailable Touch ID can remove a previously stored key without claiming it is already off', async () => {
  for (const outcome of ['disabled', 'unavailable']) {
    const h = harness({ touchIdStatus: async () => ({ outcome: 'unavailable' }), disableTouchId: async () => ({ outcome }) });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    assert.equal(h.byId('touch-id-disable').hidden, false);
    assert.equal(h.byId('touch-id-disable').disabled, false);
    assert.equal(h.byId('touch-id-disable').textContent, 'Remove stored Touch ID key');
    assert.match(h.byId('touch-id-summary').textContent, /If you enabled it before/);
    assert.doesNotMatch(h.byId('touch-id-summary').textContent, /is off/);
    h.byId('touch-id-disable').fire('click'); await settle();
    assert.equal(h.touchIdDisables, 1);
    if (outcome === 'disabled') assert.match(h.byId('touch-id-summary').textContent, /is off/);
    else { assert.match(h.byId('touch-id-status').textContent, /may still be present/);
      assert.doesNotMatch(h.byId('touch-id-summary').textContent, /is off/); }
  }
});
