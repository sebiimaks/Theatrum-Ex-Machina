import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import type { PrivateGalleryEdit, PrivateGalleryQuery } from '../interfaces/private-gallery';

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
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 300;
  scrollWidth = 1200;
  value = '';
  className = '';
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  captures = new Map<string, boolean[]>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onloadeddata: (() => void) | null = null;
  onended: (() => void) | null = null;
  onplaying: ((event: { isTrusted: boolean }) => void) | null = null;
  loop = false;
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
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): ElementStub[] {
    const action = /^\[data-action="([^"]+)"\]$/.exec(selector)?.[1];
    return this.children.flatMap(child => [...((action ? child.getAttribute('data-action') === action : child.tagName === selector)
      ? [child] : []), ...child.querySelectorAll(selector)]);
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
    filmstripUrl: 'theatrum://app/media/filmstrips/0.jpg',
    editable: true, regenerable: true, refreshable: true, thumbnailEditable: true, playable: true, revision: 'a'.repeat(32), ...overrides } };
}

function sourceFolder(index = 1, overrides: Record<string, unknown> = {}): any {
  return { id: index.toString(16).padStart(32, '0'), title: `Source folder ${index}`, videoCount: 3, connected: false, ...overrides };
}

async function settle(): Promise<void> { for (let index = 0; index < 8; index++) { await Promise.resolve(); } }

function harness(options: {
  list?: (request: PrivateGalleryQuery) => Promise<any>;
  detail?: (id: string) => Promise<any>;
  save?: (request: PrivateGalleryEdit) => Promise<any>;
  refreshVideo?: (request: { id: string; revision: string }) => Promise<any>;
  refreshAvailable?: boolean;
  setCustomThumbnail?: (request: { id: string; revision: string }) => Promise<any>;
  thumbnailAvailable?: boolean;
  regenerate?: (request: { id: string; revision: string }) => Promise<any>;
  cancelRegeneration?: () => void;
  playOriginal?: (request: { id: string; revision: string }) => Promise<any>;
  stopOriginal?: () => void;
  ackOriginalPlayback?: (url: string) => Promise<any>;
  historyAvailable?: boolean;
  resetPlaybackHistory?: (metric: string) => Promise<any>;
  historyResetAvailable?: boolean;
  exitFullscreen?: () => Promise<void>;
  originalAvailable?: boolean;
  sources?: () => Promise<any>;
  addSource?: () => Promise<any>;
  addSourceAvailable?: boolean;
  connectSource?: (id: string) => Promise<any>;
  disconnectSource?: (id: string) => Promise<any>;
  relocateSource?: (id: string) => Promise<any>;
  relocationAvailable?: boolean;
  checkSource?: (id: string) => Promise<any>;
  checkAvailable?: boolean;
  scanSource?: (id: string) => Promise<any>;
  scanAvailable?: boolean;
  importVideo?: (id: string) => Promise<any>;
  importProgress?: () => Promise<any>;
  cancelImport?: () => void;
  importAvailable?: boolean;
  cancelSourceConnection?: () => void;
  sourcesAvailable?: boolean;
  protection?: () => Promise<any>;
  setProtection?: (request: { autoLockMinutes: number; recordPlaybackHistory: boolean }) => Promise<any>;
  touchIdStatus?: () => Promise<any>;
  enableTouchId?: (request: { password: string }) => Promise<any>;
  disableTouchId?: () => Promise<any>;
  changePassword?: (request: { currentPassword: string; newPassword: string }) => Promise<any>;
  resumePasswordChange?: (request: { currentPassword: string; newPassword: string }) => Promise<any>;
  resumeAvailable?: boolean;
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
  let fullscreenExits = 0;
  const document = Object.assign(new ElementStub('document'), {
    fullscreenElement: null as ElementStub | null,
    exitFullscreen: () => { fullscreenExits++; return options.exitFullscreen?.() ?? Promise.resolve(); },
  });
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
  const requests: PrivateGalleryQuery[] = [];
  const selections: string[] = [];
  const saves: PrivateGalleryEdit[] = [];
  const refreshes: { id: string; revision: string }[] = [];
  const thumbnailChanges: { id: string; revision: string }[] = [];
  const generations: { id: string; revision: string }[] = [];
  const protectionSaves: { autoLockMinutes: number; recordPlaybackHistory: boolean }[] = [];
  const passwordChanges: { currentPassword: string; newPassword: string }[] = [];
  const passwordResumptions: { currentPassword: string; newPassword: string }[] = [];
  const unprotectedCopies: { password: string; acknowledge: true }[] = [];
  const touchIdEnrollments: { password: string }[] = [];
  let touchIdDisables = 0;
  let touchIdReads = 0;
  let copyCancellations = 0;
  let protectionReads = 0;
  let sourceReads = 0;
  let sourceCancellations = 0;
  let sourceAdditions = 0;
  let sourceConnected = false;
  const sourceConnections: string[] = [];
  const sourceDisconnections: string[] = [];
  const sourceRelocations: string[] = [];
  const videoImports: string[] = [];
  const sourceChecks: string[] = [];
  const sourceScans: string[] = [];
  let importCancellations = 0;
  let importProgressReads = 0;
  let cancellations = 0;
  let originalStops = 0;
  const playbackAcknowledgements: string[] = [];
  const playbackResets: string[] = [];
  const originalPlays: { id: string; revision: string }[] = [];
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
    list: async (request: PrivateGalleryQuery) => {
      requests.push({ ...request });
      return options.list ? options.list(request) : ready([item()]);
    },
    detail: async (id: string) => {
      selections.push(id);
      return options.detail ? options.detail(id) : detail(item(Number(id.split('-')[1])));
    },
    save: async (request: PrivateGalleryEdit) => {
      saves.push({ ...request, tags: [...request.tags] });
      return options.save ? options.save(request)
        : { status: 'saved', item: { ...detail(item(Number(request.id.split('-')[1]))).item,
          notes: request.notes, tags: request.tags, revision: 'b'.repeat(32),
          ...(Object.hasOwn(request, 'rating') ? { rating: request.rating, favourite: request.rating === 5 } : {}) } };
    },
    refreshVideo: options.refreshAvailable === false ? undefined : async (request: { id: string; revision: string }) => {
      refreshes.push({ ...request });
      return options.refreshVideo ? options.refreshVideo(request) : { status: 'refreshed', item: detail().item };
    },
    setCustomThumbnail: options.thumbnailAvailable === false ? undefined : async (request: { id: string; revision: string }) => {
      thumbnailChanges.push({ ...request });
      return options.setCustomThumbnail ? options.setCustomThumbnail(request) : { status: 'updated', item: detail().item };
    },
    regenerate: async (request: { id: string; revision: string }) => {
      generations.push({ ...request });
      return options.regenerate ? options.regenerate(request) : { status: 'generated', item: detail().item };
    },
    cancelRegeneration: () => { cancellations++; options.cancelRegeneration?.(); },
    playOriginal: options.originalAvailable === false ? undefined : async (request: { id: string; revision: string }) => {
      originalPlays.push({ ...request });
      return options.playOriginal ? options.playOriginal(request) : { status: 'ready', url: 'theatrum://app/original/' + 'b'.repeat(64) };
    },
    ackOriginalPlayback: options.historyAvailable === false ? undefined : async (url: string) => {
      playbackAcknowledgements.push(url);
      return options.ackOriginalPlayback ? options.ackOriginalPlayback(url) : { status: 'disabled' };
    },
    resetPlaybackHistory: options.historyResetAvailable === false ? undefined : async (metric: string) => {
      playbackResets.push(metric);
      return options.resetPlaybackHistory ? options.resetPlaybackHistory(metric) : { status: 'reset', count: 1 };
    },
    stopOriginal: options.originalAvailable === false ? undefined : () => { originalStops++; options.stopOriginal?.(); },
    sources: options.sourcesAvailable === false ? undefined : async () => {
      sourceReads++;
      return options.sources ? options.sources() : { status: 'ready', items: [sourceFolder(1, { connected: sourceConnected })] };
    },
    addSource: options.addSourceAvailable === false ? undefined : async () => {
      sourceAdditions++; return options.addSource ? options.addSource() : { status: 'added' };
    },
    connectSource: options.sourcesAvailable === false ? undefined : async (id: string) => {
      sourceConnections.push(id);
      if (options.connectSource) { return options.connectSource(id); }
      sourceConnected = true;
      return { status: 'connected', item: sourceFolder(1, { connected: true }) };
    },
    disconnectSource: options.sourcesAvailable === false ? undefined : async (id: string) => {
      sourceDisconnections.push(id);
      if (options.disconnectSource) { return options.disconnectSource(id); }
      sourceConnected = false;
      return { status: 'disconnected', item: sourceFolder() };
    },
    relocateSource: options.relocationAvailable === false ? undefined : async (id: string) => {
      sourceRelocations.push(id);
      if (options.relocateSource) { return options.relocateSource(id); }
      sourceConnected = false;
      return { status: 'relocated' };
    },
    checkSource: options.checkAvailable === false ? undefined : async (id: string) => {
      sourceChecks.push(id); return options.checkSource ? options.checkSource(id) : sourceCheckResult();
    },
    scanSource: options.scanAvailable === false ? undefined : async (id: string) => {
      sourceScans.push(id); return options.scanSource ? options.scanSource(id) : { status: 'nothing-new' };
    },
    importVideo: options.importAvailable === false ? undefined : async (id: string) => {
      videoImports.push(id);
      return options.importVideo ? options.importVideo(id) : batchResult();
    },
    importProgress: options.importAvailable === false ? undefined : async () => {
      importProgressReads++; return options.importProgress ? options.importProgress() : { status: 'idle' };
    },
    cancelImport: options.importAvailable === false ? undefined : () => { importCancellations++; options.cancelImport?.(); },
    cancelSourceConnection: options.sourcesAvailable === false ? undefined : () => { sourceCancellations++; options.cancelSourceConnection?.(); },
    protection: async () => {
      protectionReads++;
      return options.protection ? options.protection() : { status: 'ready', autoLockMinutes: 5, recordPlaybackHistory: false };
    },
    setProtection: async (request: { autoLockMinutes: number; recordPlaybackHistory: boolean }) => {
      protectionSaves.push({ ...request });
      return options.setProtection ? options.setProtection(request) : { status: 'saved', autoLockMinutes: request.autoLockMinutes, recordPlaybackHistory: request.recordPlaybackHistory };
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
      resumePasswordChange: options.resumeAvailable === false ? undefined : (request: { currentPassword: string; newPassword: string }) => {
        passwordResumptions.push({ ...request });
        return options.resumePasswordChange?.(request) ?? Promise.resolve({ status: 'cancelled' });
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
    byId, created, document, window, requests, selections, saves, generations, refreshes, thumbnailChanges, observers, protectionSaves, passwordChanges, passwordResumptions, unprotectedCopies,
    touchIdEnrollments, get touchIdDisables() { return touchIdDisables; }, get touchIdReads() { return touchIdReads; },
    get protectionReads() { return protectionReads; },
    sourceConnections, sourceDisconnections, sourceRelocations, videoImports, sourceChecks, sourceScans,
    get importCancellations() { return importCancellations; },
    get importProgressReads() { return importProgressReads; },
    get sourceReads() { return sourceReads; },
    get sourceAdditions() { return sourceAdditions; },
    get sourceCancellations() { return sourceCancellations; },
    get copyCancellations() { return copyCancellations; },
    get cancellations() { return cancellations; },
    originalPlays, playbackAcknowledgements, playbackResets, get originalStops() { return originalStops; },
    get cards() { return byId('gallery-grid').children; },
    get images() { return created.filter(element => element.tagName === 'img'); },
    get activeImages() { return created.filter(element => element.tagName === 'img' && element.onload); },
    get focused() { return focused; }, get lockCalls() { return lockCalls; },
    get fullscreenExits() { return fullscreenExits; },
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

test('filmstrips load only when requested and share the bounded image queue with thumbnails and posters', async () => {
  const h = harness({ list: async () => ready(Array.from({ length: 6 }, (_, index) => item(index))) });
  await selectFirst(h);
  const strip = h.byId('detail-filmstrip');
  assert.equal(strip.src, '');
  assert.equal(h.byId('filmstrip-panel').hidden, true);
  assert.equal(h.activeImages.length, 3);
  h.byId('toggle-filmstrip').fire('click');
  assert.equal(strip.src, '', 'An explicit request still waits for image admission');
  assert.equal(h.byId('toggle-filmstrip').getAttribute('aria-expanded'), 'true');
  assert.equal(h.byId('filmstrip-panel').getAttribute('aria-busy'), 'true');
  while (!strip.onload) {
    assert.ok(h.activeImages.length > 0 && h.activeImages.length <= 3);
    h.activeImages[0].onload!();
  }
  assert.equal(strip.src, 'theatrum://app/media/filmstrips/0.jpg');
  assert.ok(h.activeImages.length <= 3);
  strip.onload();
  assert.equal(strip.hidden, false);
  assert.equal(h.byId('filmstrip-viewport').hidden, false);
  assert.equal(h.byId('filmstrip-panel').getAttribute('aria-busy'), 'false');
  assert.equal(h.byId('filmstrip-previous').disabled, true);
  assert.equal(h.byId('filmstrip-next').disabled, false);
  h.byId('filmstrip-next').fire('click');
  assert.ok(h.byId('filmstrip-viewport').scrollLeft > 0);
  assert.equal(h.byId('filmstrip-previous').disabled, false);
  h.byId('filmstrip-viewport').scrollLeft = 900;
  h.byId('filmstrip-viewport').fire('scroll');
  assert.equal(h.byId('filmstrip-next').disabled, true);
  assert.equal(h.byId('preview-video').plays, 0);
});

test('hiding a loading or retrying filmstrip cancels its work and old callbacks cannot repaint a reopened strip', async () => {
  for (const retrying of [false, true]) {
    const h = harness(); await selectFirst(h);
    h.byId('toggle-filmstrip').fire('click');
    const strip = h.byId('detail-filmstrip');
    const lateLoad = strip.onload!;
    const lateError = strip.onerror!;
    if (retrying) { lateError(); assert.equal(h.timers, 1); }
    h.byId('toggle-filmstrip').fire('click');
    assert.equal(h.timers, 0);
    assert.equal(strip.src, '');
    assert.equal(strip.onload, null);
    assert.equal(strip.onerror, null);
    assert.equal(strip.hidden, true);
    assert.equal(h.byId('filmstrip-panel').hidden, true);
    assert.equal(h.byId('toggle-filmstrip').getAttribute('aria-expanded'), 'false');
    h.byId('toggle-filmstrip').fire('click');
    const freshLoad = strip.onload!;
    lateLoad(); lateError();
    assert.equal(strip.hidden, true, 'A retired load cannot reveal a newly requested strip');
    assert.equal(strip.onload, freshLoad, 'Old handlers cannot retire a replacement request');
    assert.equal(h.timers, 0);
    freshLoad();
    assert.equal(strip.hidden, false);
    assert.equal(strip.starts.length, 2);
  }
});

test('filmstrip decode failures retry finitely with a generic message and support an explicit retry', async () => {
  const h = harness(); await selectFirst(h);
  h.byId('toggle-filmstrip').fire('click');
  const strip = h.byId('detail-filmstrip');
  for (let attempt = 0; attempt < 3; attempt++) {
    strip.onerror!();
    if (attempt < 2) { await h.runTimer(); }
  }
  assert.equal(strip.starts.length, 3);
  assert.equal(strip.src, '');
  assert.equal(strip.hidden, true);
  assert.equal(h.timers, 0);
  assert.equal(h.byId('filmstrip-panel').getAttribute('aria-busy'), 'false');
  assert.equal(h.byId('filmstrip-status').textContent, 'Filmstrip unavailable. Hide it and try again.');
  h.byId('toggle-filmstrip').fire('click');
  h.byId('toggle-filmstrip').fire('click');
  strip.onload!();
  assert.equal(strip.hidden, false);
  assert.equal(h.byId('filmstrip-status').hidden, true);
  assert.equal(strip.starts.length, 4);
});

test('changing selection retires filmstrip work and does not load the new strip until requested', async () => {
  const h = harness({ list: async () => ready([item(0), item(1)]), detail: async id => {
    const index = Number(id.split('-')[1]);
    return detail(item(index), { filmstripUrl: `theatrum://app/media/filmstrips/${index}.jpg` });
  } });
  await selectFirst(h);
  while (h.activeImages.length) { h.activeImages[0].onload!(); }
  h.byId('toggle-filmstrip').fire('click');
  const strip = h.byId('detail-filmstrip');
  const staleLoad = strip.onload!;
  h.cards[1].fire('click'); await settle();
  assert.equal(strip.src, '');
  assert.equal(h.byId('filmstrip-panel').hidden, true);
  staleLoad();
  assert.equal(strip.hidden, true);
  h.byId('toggle-filmstrip').fire('click');
  assert.equal(strip.src, 'theatrum://app/media/filmstrips/1.jpg');
  strip.onload!();
  assert.equal(strip.hidden, false);
  assert.equal(h.byId('details-title').textContent, 'Private video 1');
});

test('filmstrip viewing preserves note and tag drafts, and opening Protection retires its pending load', async () => {
  const pending = deferred();
  const h = harness({ protection: async () => pending.promise });
  await selectFirst(h); draftNotes(h); draftTag(h, 'Pending private tag');
  h.byId('toggle-filmstrip').fire('click');
  const strip = h.byId('detail-filmstrip');
  strip.onload!();
  h.byId('toggle-filmstrip').fire('click');
  h.byId('toggle-filmstrip').fire('click');
  const staleLoad = strip.onload!;
  h.byId('protection-button').fire('click');
  assert.equal(strip.src, '');
  assert.equal(h.byId('filmstrip-panel').hidden, true);
  assert.equal(h.byId('toggle-filmstrip').disabled, true);
  staleLoad();
  assert.equal(strip.hidden, true);
  pending.resolve({ status: 'ready', autoLockMinutes: 5 }); await settle();
  assert.equal(h.byId('details-notes').value, 'Changed private notes');
  assert.equal(h.byId('tag-draft').value, 'Pending private tag');
  assert.equal(h.saves.length, 0);
  assert.equal(h.byId('toggle-filmstrip').disabled, false);
  assert.equal(strip.src, '', 'Finishing a protection request does not silently reopen previews');
});

test('filmstrip viewing makes room when clean but restores Save and Discard for drafts, saves and conflicts', async () => {
  for (const kind of ['notes', 'pending-tag', 'removed-tag']) {
    const pending = deferred();
    const h = harness({ save: async () => pending.promise });
    await selectFirst(h);
    assert.equal(h.byId('edit-footer').hidden, false);
    h.byId('toggle-filmstrip').fire('click');
    h.byId('detail-filmstrip').onload!();
    assert.equal(h.byId('edit-footer').hidden, true, 'Clean filmstrip viewing leaves space for the preview frames');
    if (kind === 'notes') { draftNotes(h); }
    if (kind === 'pending-tag') { draftTag(h, 'Unsaved tag'); }
    if (kind === 'removed-tag') { h.byId('details-tags').children[0].children[1].fire('click'); }
    assert.equal(h.byId('edit-footer').hidden, false, kind);
    assert.equal(h.byId('save-details').disabled, false, kind);
    assert.equal(h.byId('discard-details').disabled, false, kind);
    assert.equal(h.byId('filmstrip-panel').hidden, false, 'Typing does not discard the filmstrip or its draft');
    if (kind === 'notes') {
      h.byId('save-details').fire('click');
      assert.equal(h.byId('edit-footer').hidden, false, 'Save progress remains visible');
      pending.resolve({ status: 'conflict' }); await settle();
      draftNotes(h, 'Private notes');
      assert.equal(h.byId('edit-footer').hidden, false, 'A conflict remains actionable even after the draft text matches the old value');
      assert.equal(h.byId('discard-details').disabled, false);
      assert.equal(h.byId('save-details').disabled, true);
    }
  }
});

test('closing details, locking and retiring the page clear decoded filmstrips before any lock dispatch', async () => {
  for (const ending of ['close', 'lock', 'pagehide']) {
    const h = harness({ lock: () => {
      assert.equal(h.byId('detail-filmstrip').src, '');
      assert.equal(h.byId('filmstrip-panel').hidden, true);
    } });
    await selectFirst(h); h.byId('toggle-filmstrip').fire('click');
    const strip = h.byId('detail-filmstrip');
    strip.onload!();
    h.byId('filmstrip-viewport').scrollLeft = 400;
    if (ending === 'pagehide') { h.window.fire('pagehide'); }
    else { h.byId(ending === 'lock' ? 'lock-hub' : 'close-details').fire('click'); }
    assert.equal(strip.src, '', ending);
    assert.equal(strip.hidden, true, ending);
    assert.equal(h.byId('filmstrip-panel').hidden, true, ending);
    assert.equal(h.byId('filmstrip-viewport').scrollLeft, 0, ending);
    assert.equal(h.byId('filmstrip-status').textContent, '', ending);
  }
});

test('filmstrips reject external, unrelated and malformed media routes before requesting an image', async () => {
  for (const filmstripUrl of ['https://example.test/private.jpg', 'file:///private.jpg',
    'theatrum://app/media/thumbnails/0.jpg', 'theatrum://app/media/filmstrips/0.mp4',
    'theatrum://app/media/filmstrips/0.jpg?source=/private',
    'theatrum://app/media/filmstrips/0.jpg\n']) {
    const h = harness({ detail: async () => detail(item(), { filmstripUrl }) });
    await selectFirst(h);
    assert.equal(h.byId('toggle-filmstrip').disabled, true, filmstripUrl);
    h.byId('toggle-filmstrip').fire('click');
    assert.equal(h.byId('detail-filmstrip').starts.length, 0);
    assert.equal(h.byId('filmstrip-panel').hidden, true);
  }
});

test('credential changes retire a reopened filmstrip before dispatch and cannot restore it after failure', async () => {
  for (const operation of ['password', 'copy', 'touch-id-enable', 'touch-id-disable']) {
    const pending = deferred();
    const dispatched = () => {
      assert.equal(h.byId('detail-filmstrip').src, '', operation);
      assert.equal(h.byId('detail-filmstrip').hidden, true, operation);
      assert.equal(h.byId('filmstrip-panel').hidden, true, operation);
      return pending.promise;
    };
    const h = harness({ changePassword: dispatched, createUnprotectedCopy: dispatched,
      enableTouchId: dispatched, disableTouchId: dispatched,
      touchIdStatus: async () => ({ outcome: 'available', state: operation === 'touch-id-disable' ? 'enabled' : 'disabled' }) });
    await selectFirst(h);
    if (operation === 'password') { await openPasswordForm(h); fillPasswords(h); }
    if (operation === 'copy') { await openCopyForm(h); fillCopy(h); }
    if (operation === 'touch-id-enable') { await openTouchId(h); h.byId('touch-id-password').value = 'Synthetic password'; }
    if (operation === 'touch-id-disable') { h.byId('protection-button').fire('click'); await settle(); }
    h.byId('toggle-filmstrip').fire('click');
    const strip = h.byId('detail-filmstrip');
    const staleLoad = strip.onload!;
    if (operation === 'password') { h.byId('change-password-form').fire('submit'); }
    if (operation === 'copy') { h.byId('unprotected-copy-form').fire('submit'); }
    if (operation === 'touch-id-enable') { h.byId('touch-id-form').fire('submit'); }
    if (operation === 'touch-id-disable') { h.byId('touch-id-disable').fire('click'); }
    assert.equal(h.passwordChanges.length + h.unprotectedCopies.length + h.touchIdEnrollments.length + h.touchIdDisables, 1, operation);
    assert.equal(h.byId('toggle-filmstrip').disabled, true, operation);
    staleLoad();
    assert.equal(strip.hidden, true, operation);
    pending.resolve({ status: 'incorrect-password', outcome: 'unavailable' }); await settle();
    assert.equal(strip.src, '', operation);
    assert.equal(h.byId('filmstrip-panel').hidden, true, operation);
    assert.equal(h.byId('toggle-filmstrip').disabled, false, operation);
  }
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
      return { status: 'saved', item: { ...detail().item, notes: request.notes, tags: request.tags, revision: 'b'.repeat(32),
          ...(Object.hasOwn(request, 'rating') ? { rating: request.rating, favourite: request.rating === 5 } : {}) } };
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
    assert.equal(h.byId('detail-filmstrip').src, '', 'Regeneration retires the old filmstrip before the asynchronous operation');
    assert.equal(h.byId('detail-filmstrip').hidden, true);
    return pending.promise;
  } });
  await selectFirst(h);
  const oldThumbnail = h.images.find(image => image.src.includes('/thumbnails/'))!;
  oldThumbnail.onload!();
  const poster = h.byId('detail-poster');
  poster.onload!();
  h.byId('toggle-filmstrip').fire('click');
  const strip = h.byId('detail-filmstrip');
  const staleStripLoad = strip.onload!;
  h.byId('play-preview').fire('click'); await settle();
  const video = h.byId('preview-video');
  h.byId('regenerate-previews').fire('click');
  assert.deepEqual(h.generations, [{ id: 'opaque-0', revision: 'a'.repeat(32) }]);
  assert.equal(video.src, '');
  assert.equal(video.hidden, true);
  assert.equal(poster.src, '');
  assert.equal(poster.hidden, true);
  assert.equal(h.byId('play-preview').disabled, true);
  const freshStripUrl = `theatrum://app/media/filmstrips/0.jpg?v=${'b'.repeat(32)}`;
  pending.resolve({ status: 'generated', item: detail(item(), { revision: 'b'.repeat(32), filmstripUrl: freshStripUrl }).item });
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
  assert.equal(strip.src, '', 'Regeneration does not automatically reload a filmstrip');
  h.byId('toggle-filmstrip').fire('click');
  assert.equal(strip.src, freshStripUrl);
  const freshStripLoad = strip.onload!;
  staleStripLoad();
  assert.equal(strip.hidden, true);
  assert.equal(strip.onload, freshStripLoad);
  freshStripLoad();
  assert.equal(strip.hidden, false);
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
  assert.match(html, /inactivity in this private window, including during video playback or preview regeneration/);
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
    assert.deepEqual(h.protectionSaves, [{ autoLockMinutes: minutes, recordPlaybackHistory: false }]);
    assert.equal(h.byId('auto-lock-minutes').value, String(minutes));
    assert.equal(h.byId('save-protection').disabled, true);
    assert.equal(h.byId('protection-status').textContent, 'Protection settings saved.');
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
      if (retry) { return { status: 'saved', autoLockMinutes: request.autoLockMinutes, recordPlaybackHistory: request.recordPlaybackHistory }; }
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
  assert.match(h.byId('password-status').textContent, /Save your protection settings/);
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


test('source folders open on demand, retain drafts and expose only bounded generic labels', async () => {
  const h = harness({ sources: async () => ({ status: 'ready', items: [sourceFolder(1, {
    path: '/private/source/secret', notes: 'Should never render', filename: 'private-video.mp4',
  })] }) });
  await selectFirst(h);
  const notes = h.byId('details-notes');
  const tag = h.byId('tag-draft');
  notes.value = 'Unsaved notes'; notes.fire('input');
  tag.value = 'Unsaved tag'; tag.fire('input');
  assert.equal(h.sourceReads, 0);
  h.byId('source-folders-toggle').fire('click');
  await settle();
  assert.equal(h.byId('source-folders-panel').hidden, false);
  const row = h.byId('source-folders-list').children[0];
  assert.match(row.textContent, /Source folder 1.*3 videos.*Not connected.*Connect/);
  assert.equal(row.querySelector('button')!.getAttribute('aria-label'), 'Connect Source folder 1');
  assert.doesNotMatch(row.textContent, /secret|private-video|Should never render|00000000000000000000000000000001/);
  assert.equal(row.getAttribute('data-source-id'), null);
  h.byId('refresh-source-folders').fire('click');
  await settle();
  assert.equal(h.sourceReads, 2);
  assert.equal(notes.value, 'Unsaved notes');
  assert.equal(tag.value, 'Unsaved tag');
  assert.equal(h.byId('save-details').disabled, false);
  h.byId('close-source-folders').fire('click');
  assert.equal(h.byId('source-folders-list').children.length, 0);
  assert.equal(h.byId('source-folders-status').textContent, '');
  assert.equal(h.byId('source-folders-panel').hidden, true);
  h.byId('source-folders-toggle').fire('click');
  await settle();
  assert.equal(h.sourceReads, 3, 'Reopening never reuses source grants cached in the view');
  assert.equal(notes.value, 'Unsaved notes');
});

test('source connect and disconnect stop previews, preserve drafts and refresh shared grant rows', async () => {
  let connected = false;
  const h = harness({
    sources: async () => ({ status: 'ready', items: [sourceFolder(1, { connected }), sourceFolder(2, { connected })] }),
    connectSource: async () => { connected = true; return { status: 'connected', item: sourceFolder(1, { connected }) }; },
    disconnectSource: async () => { connected = false; return { status: 'disconnected', item: sourceFolder(1, { connected }) }; },
  });
  await selectFirst(h);
  h.byId('source-folders-toggle').fire('click'); await settle();
  h.byId('details-notes').value = 'Keep notes'; h.byId('details-notes').fire('input');
  h.byId('play-preview').fire('click'); await settle();
  assert.notEqual(h.byId('preview-video').src, '');
  h.byId('source-folders-list').children[0].querySelector('button')!.fire('click');
  assert.equal(h.byId('preview-video').src, '');
  assert.equal(h.byId('save-details').disabled, true);
  await settle();
  assert.deepEqual(h.sourceConnections, [sourceFolder().id]);
  assert.equal(h.sourceReads, 2);
  assert.ok(h.byId('source-folders-list').children.every(row => /Connected for this session/.test(row.textContent)));
  assert.match(h.byId('source-folders-status').textContent, /connected until this hub locks/);
  assert.equal(h.byId('details-notes').value, 'Keep notes');
  assert.equal(h.byId('save-details').disabled, false);
  h.byId('source-folders-list').children[0].querySelector('button')!.fire('click');
  await settle();
  assert.deepEqual(h.sourceDisconnections, [sourceFolder().id]);
  assert.equal(h.sourceReads, 3);
  assert.ok(h.byId('source-folders-list').children.every(row => /Not connected/.test(row.textContent)));
  assert.equal(h.byId('source-folders-status').textContent, 'Source folder disconnected.');
});

test('pending source connection serializes competing UI actions, allows cancellation and retains drafts', async () => {
  const pending = deferred();
  const h = harness({ connectSource: () => pending.promise, list: async () => ready([item(), item(1)], 70) });
  await selectFirst(h);
  h.byId('source-folders-toggle').fire('click'); await settle();
  h.byId('details-notes').value = 'Draft'; h.byId('details-notes').fire('input');
  h.byId('source-folders-list').children[0].querySelector('button')!.fire('click');
  for (const id of ['source-folders-toggle', 'refresh-source-folders', 'close-source-folders', 'protection-button',
    'save-details', 'discard-details', 'regenerate-previews', 'play-preview', 'toggle-filmstrip', 'next-page', 'gallery-search']) {
    assert.equal(h.byId(id).disabled, true, `${id} must wait for the source picker`);
  }
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  h.cards[1].fire('click');
  h.byId('close-details').fire('click');
  h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('source-folders-panel').hidden, false);
  assert.equal(h.selections.length, 1);
  assert.equal(h.byId('cancel-source-connection').hidden, false);
  h.byId('cancel-source-connection').fire('click');
  h.byId('cancel-source-connection').fire('click');
  assert.equal(h.sourceCancellations, 1);
  assert.equal(h.byId('cancel-source-connection').disabled, true);
  pending.resolve({ status: 'cancelled' }); await settle();
  assert.match(h.byId('source-folders-status').textContent, /Connection cancelled/);
  assert.equal(h.byId('close-source-folders').disabled, false);
  assert.equal(h.byId('source-folders-list').children[0].querySelector('button')!.disabled, false);
  assert.equal(h.byId('details-notes').value, 'Draft');
  assert.equal(h.byId('save-details').disabled, false);
});

test('source errors are generic, wrong folders remain retryable and ambiguous grants require refresh', async () => {
  for (const status of ['wrong-folder', 'source-unavailable', 'conflict', 'busy', 'unavailable']) {
    const h = harness({ connectSource: async () => ({ status, path: '/private/secret', message: 'Sensitive error' }) });
    await settle();
    h.byId('source-folders-toggle').fire('click'); await settle();
    h.byId('source-folders-list').children[0].querySelector('button')!.fire('click'); await settle();
    assert.doesNotMatch(h.byId('source-folders-status').textContent, /secret|Sensitive error/);
    assert.notEqual(h.byId('source-folders-status').textContent, '');
    assert.equal(h.byId('source-folders-list').children.length, ['wrong-folder', 'source-unavailable'].includes(status) ? 1 : 0);
    assert.equal(h.byId('refresh-source-folders').disabled, false);
    h.byId('refresh-source-folders').fire('click'); await settle();
    assert.equal(h.byId('source-folders-list').children.length, 1);
  }
});

test('source listing rejects malformed, duplicate and oversized records without rendering contents', async () => {
  for (const items of [
    [sourceFolder(1, { title: '/private/secret' })], [sourceFolder(1, { id: 'path/to/file' })],
    [sourceFolder(1, { videoCount: -1 })], [sourceFolder(1, { connected: 'yes' })], new Array(1),
    [sourceFolder(), sourceFolder()], Array.from({ length: 257 }, () => sourceFolder()),
  ]) {
    const h = harness({ sources: async () => ({ status: 'ready', items }) });
    await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
    assert.equal(h.byId('source-folders-list').children.length, 0);
    assert.match(h.byId('source-folders-status').textContent, /could not be checked/);
    assert.doesNotMatch(h.byId('source-folders-status').textContent, /secret/);
  }
  const h = harness({ sourcesAvailable: false });
  await settle();
  assert.equal(h.byId('source-folders-toggle').disabled, true);
});

test('locking or hiding during source requests clears rows, drafts and rejects late responses', async () => {
  for (const operation of ['list', 'connect', 'disconnect']) {
    const pending = deferred();
    const h = harness({
      sources: operation === 'list' ? () => pending.promise : async () => ({ status: 'ready', items: [sourceFolder(1, { connected: operation === 'disconnect' })] }),
      connectSource: () => pending.promise, disconnectSource: () => pending.promise,
    });
    await selectFirst(h);
    h.byId('details-notes').value = 'Draft'; h.byId('details-notes').fire('input');
    h.byId('source-folders-toggle').fire('click'); await settle();
    if (operation !== 'list') { h.byId('source-folders-list').children[0].querySelector('button')!.fire('click'); }
    if (operation === 'disconnect') { h.window.fire('pagehide'); }
    else { h.byId('lock-hub').fire('click'); }
    assert.equal(h.byId('source-folders-panel').hidden, true);
    assert.equal(h.byId('source-folders-list').children.length, 0);
    assert.equal(h.byId('source-folders-status').textContent, '');
    assert.equal(h.byId('details-notes').value, '');
    assert.equal(h.byId('cancel-source-connection').hidden, true);
    pending.resolve(operation === 'list' ? { status: 'ready', items: [sourceFolder()] }
      : { status: operation === 'connect' ? 'connected' : 'disconnected', item: sourceFolder(1, { connected: operation === 'connect' }) });
    await settle();
    assert.equal(h.byId('source-folders-list').children.length, 0);
    assert.equal(h.byId('source-folders-status').textContent, '');
    assert.equal(h.byId('source-folders-toggle').disabled, true);
  }
});


test('locking while connected source rows refresh cannot repopulate the retired panel', async () => {
  const refresh = deferred();
  let calls = 0;
  const h = harness({ sources: () => ++calls === 1
    ? Promise.resolve({ status: 'ready', items: [sourceFolder()] }) : refresh.promise });
  await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
  h.byId('source-folders-list').children[0].querySelector('button')!.fire('click'); await settle();
  assert.equal(h.sourceReads, 2);
  assert.equal(h.byId('close-source-folders').disabled, true);
  h.byId('lock-hub').fire('click');
  refresh.resolve({ status: 'ready', items: [sourceFolder(1, { connected: true })] }); await settle();
  assert.equal(h.byId('source-folders-panel').hidden, true);
  assert.equal(h.byId('source-folders-list').children.length, 0);
  assert.equal(h.byId('source-folders-status').textContent, '');
});

test('source bridge failures remain generic and successful changes with failed refresh do not retain stale rows', async () => {
  let calls = 0;
  const h = harness({ sources: async () => {
    if (++calls === 1) { return { status: 'ready', items: [sourceFolder()] }; }
    throw new Error('/private/source/secret');
  } });
  await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
  h.byId('source-folders-list').children[0].querySelector('button')!.fire('click'); await settle();
  assert.equal(h.byId('source-folders-list').children.length, 0);
  assert.match(h.byId('source-folders-status').textContent, /Source folder connected.*Choose Refresh/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /secret/);
  assert.equal(h.focused, h.byId('refresh-source-folders'));
  h.byId('refresh-source-folders').fire('click'); await settle();
  assert.match(h.byId('source-folders-status').textContent, /could not be checked/);
});


function relocationButton(h: ReturnType<typeof harness>): ElementStub {
  return h.byId('source-folders-list').children[0].querySelector('[data-action="relocate-source"]')!;
}

test('source relocation exposes a named keyboard action without putting source identities in the DOM', async () => {
  const h = harness();
  await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
  const button = relocationButton(h);
  assert.equal(button.tagName, 'button');
  assert.equal(button.textContent, 'Change location…');
  assert.equal(button.getAttribute('aria-label'), 'Change location of Source folder 1');
  assert.equal(button.getAttribute('data-action'), 'relocate-source');
  assert.equal(button.disabled, false);
  assert.ok(h.created.every(element => [...element.attributes.values()].every(value => !value.includes(sourceFolder().id))));
  const unavailable = harness({ relocationAvailable: false });
  await settle(); unavailable.byId('source-folders-toggle').fire('click'); await settle();
  assert.equal(relocationButton(unavailable).disabled, true);
  assert.equal(unavailable.byId('source-folders-list').children[0].querySelector('button')!.disabled, false);
});

test('source relocation requires saving or discarding notes, pending tags and removed tags', async () => {
  for (const kind of ['notes', 'pending-tag', 'removed-tag']) {
    const h = harness(); await selectFirst(h);
    if (kind === 'notes') { draftNotes(h, 'Preserved private draft'); }
    if (kind === 'pending-tag') { draftTag(h, 'Pending private tag'); }
    if (kind === 'removed-tag') { h.byId('details-tags').children[0].querySelector('button')!.fire('click'); }
    const notes = h.byId('details-notes').value;
    const tag = h.byId('tag-draft').value;
    const tags = h.byId('details-tags').textContent;
    h.byId('source-folders-toggle').fire('click'); await settle();
    relocationButton(h).fire('click'); await settle();
    assert.equal(h.sourceRelocations.length, 0);
    assert.match(h.byId('source-folders-status').textContent, /Save or discard your video notes, tags and rating/);
    assert.equal(h.byId('details-notes').value, notes);
    assert.equal(h.byId('tag-draft').value, tag);
    assert.equal(h.byId('details-tags').textContent, tags);
    assert.equal(h.byId('save-details').disabled, false);
    assert.equal(h.requests.length, 1, 'A refused relocation does not refresh away the draft');
  }
});

test('source relocation serializes operations, stops previews and supports one cancellation request', async () => {
  const pending = deferred();
  const h = harness({ relocateSource: () => pending.promise, list: async () => ready([item(), item(1)], 70) });
  await selectFirst(h);
  h.byId('play-preview').fire('click'); await settle();
  assert.notEqual(h.byId('preview-video').src, '');
  h.byId('source-folders-toggle').fire('click'); await settle();
  relocationButton(h).fire('click');
  assert.equal(h.byId('preview-video').src, '');
  assert.deepEqual(h.sourceRelocations, [sourceFolder().id]);
  assert.match(h.byId('source-folders-status').textContent, /folder will be checked before you confirm its saved location/);
  for (const id of ['source-folders-toggle', 'refresh-source-folders', 'close-source-folders', 'protection-button',
    'save-details', 'discard-details', 'regenerate-previews', 'play-preview', 'toggle-filmstrip', 'next-page', 'gallery-search']) {
    assert.equal(h.byId(id).disabled, true, `${id} must wait for source relocation`);
  }
  assert.ok(h.byId('source-folders-list').children[0].querySelectorAll('button').every(button => button.disabled));
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  h.cards[1].fire('click'); h.byId('close-details').fire('click');
  h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.byId('source-folders-panel').hidden, false);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.selections.length, 1);
  assert.equal(h.byId('cancel-source-connection').hidden, false);
  assert.equal(h.byId('cancel-source-connection').textContent, 'Cancel change');
  h.byId('cancel-source-connection').fire('click'); h.byId('cancel-source-connection').fire('click');
  assert.equal(h.sourceCancellations, 1);
  assert.equal(h.byId('cancel-source-connection').disabled, true);
  assert.match(h.byId('source-folders-status').textContent, /save already in progress may finish/);
  pending.resolve({ status: 'cancelled' }); await settle(); await settle();
  assert.equal(h.byId('cancel-source-connection').hidden, true);
  assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('close-source-folders').disabled, false);
  assert.equal(h.requests.length, 2, 'Cancellation refreshes after a potentially admitted save');
  assert.equal(h.sourceReads, 2);
  assert.match(h.byId('source-folders-status').textContent, /Location change cancelled/);
});

test('saved relocation refreshes catalogue and source identities without auto-connecting or reusing old selections', async () => {
  let relocated = false;
  const replacedId = 'e'.repeat(32);
  const h = harness({
    sources: async () => ({ status: 'ready', items: [sourceFolder(1, { id: relocated ? replacedId : sourceFolder().id, connected: !relocated })] }),
    relocateSource: async () => { relocated = true; return { status: 'relocated', path: '/private/secret' }; },
    list: async request => ready([item(relocated ? 1 : 0)], 70, request.offset),
  });
  await selectFirst(h);
  h.byId('source-folders-toggle').fire('click'); await settle();
  relocationButton(h).fire('click'); await settle(); await settle();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1], h.requests[0]);
  assert.equal(h.selections.length, 1, 'Retired selection IDs are not requested again');
  assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.cards.length, 1);
  assert.match(h.cards[0].textContent, /Private video 1/);
  assert.equal(h.cards[0].getAttribute('aria-pressed'), 'false');
  assert.equal(h.sourceConnections.length, 0);
  const row = h.byId('source-folders-list').children[0];
  assert.match(row.textContent, /Not connected/);
  assert.equal(h.focused, row.querySelector('button'));
  assert.equal(h.byId('source-folders-status').textContent, 'Source location saved. Connect the folder to regenerate previews.');
  row.querySelector('button')!.fire('click'); await settle();
  assert.deepEqual(h.sourceConnections, [replacedId]);
});

test('relocation retains a search and current page while loading replacement catalogue identities', async () => {
  const h = harness({ list: async request => ready([item(request.offset)], 70, request.offset) });
  await settle();
  const search = h.byId('gallery-search');
  search.value = 'Nature'; search.fire('input'); await h.runTimer();
  h.byId('next-page').fire('click'); await settle();
  h.byId('source-folders-toggle').fire('click'); await settle();
  relocationButton(h).fire('click'); await settle(); await settle();
  assert.deepEqual(h.requests.at(-1), { query: 'Nature', offset: 48, collection: 'all', sort: 'catalogue', direction: 'asc' });
  assert.equal(search.value, 'Nature');
  assert.equal(h.byId('page-label').textContent, 'Page 2 of 2');
});

for (const status of ['invalid', 'source-unavailable', 'conflict', 'busy', 'unavailable', '__proto__', 'constructor']) {
  test(`${status} source relocation uses fixed messages and refreshes authoritative state`, async () => {
    const h = harness({ relocateSource: async () => ({ status, path: '/private/secret', message: 'Sensitive error' }) });
    await selectFirst(h); h.byId('source-folders-toggle').fire('click'); await settle();
    relocationButton(h).fire('click'); await settle(); await settle();
    const message = h.byId('source-folders-status').textContent;
    assert.notEqual(message, '');
    assert.doesNotMatch(message, /secret|Sensitive error|function|object Object/);
    if (status === 'invalid') { assert.match(message, /separate folder.*neither contains nor sits inside.*recorded file sizes/); }
    if (status === 'source-unavailable') { assert.match(message, /every video.*same names, subfolders and sizes.*access is allowed/); }
    assert.equal(h.requests.length, 2);
    assert.equal(h.sourceReads, 2);
    assert.equal(h.byId('details-panel').hidden, true);
    assert.equal(relocationButton(h).disabled, false);
  });
}

test('relocation refresh failures do not retain stale rows, details or sensitive bridge errors', async () => {
  let reads = 0;
  const h = harness({ sources: async () => {
    if (++reads === 1) { return { status: 'ready', items: [sourceFolder()] }; }
    throw new Error('/private/secret');
  }, relocateSource: async () => { throw new Error('/private/secret'); } });
  await selectFirst(h); h.byId('source-folders-toggle').fire('click'); await settle();
  relocationButton(h).fire('click'); await settle(); await settle();
  assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('source-folders-list').children.length, 0);
  assert.match(h.byId('source-folders-status').textContent, /Choose Refresh/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /secret/);
  assert.equal(h.focused, h.byId('refresh-source-folders'));
});

test('lock and pagehide retire relocation and refresh callbacks without restoring catalogue or sources', async () => {
  for (const stage of ['picker', 'catalogue', 'sources']) {
    for (const ending of ['lock', 'pagehide']) {
      const pending = deferred();
      let lists = 0; let reads = 0;
      const h = harness({
        relocateSource: async () => stage === 'picker' ? pending.promise : { status: 'relocated' },
        list: async () => ++lists > 1 && stage === 'catalogue' ? pending.promise : ready([item()]),
        sources: async () => ++reads > 1 && stage === 'sources' ? pending.promise : { status: 'ready', items: [sourceFolder()] },
      });
      await selectFirst(h); h.byId('source-folders-toggle').fire('click'); await settle();
      relocationButton(h).fire('click'); await settle(); await settle();
      if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
      else { h.window.fire('pagehide'); }
      pending.resolve(stage === 'picker' ? { status: 'relocated' } : stage === 'catalogue' ? ready([item(1)])
        : { status: 'ready', items: [sourceFolder(2)] });
      await settle(); await settle();
      assert.equal(h.byId('details-panel').hidden, true);
      assert.equal(h.byId('source-folders-panel').hidden, true);
      assert.equal(h.byId('source-folders-list').children.length, 0);
      assert.equal(h.byId('source-folders-status').textContent, '');
      assert.equal(h.byId('cancel-source-connection').hidden, true);
      assert.equal(h.cards.length, 0);
    }
  }
});


test('original playback starts only explicitly, preserves drafts and stops without saving metadata', async () => {
  const pending = deferred();
  const h = harness({ playOriginal: async () => pending.promise }); await selectFirst(h);
  assert.equal(h.originalPlays.length, 0);
  assert.equal(h.byId('play-original').hidden, false);
  h.byId('details-notes').value = 'Keep my unsaved notes'; h.byId('details-notes').fire('input');
  h.byId('tag-draft').value = 'Tag draft'; h.byId('tag-draft').fire('input');
  h.byId('play-original').fire('click'); h.byId('play-original').fire('click');
  assert.deepEqual(h.originalPlays, [{ id: 'opaque-0', revision: 'a'.repeat(32) }]);
  assert.equal(h.byId('preview-video').src, '');
  assert.equal(h.byId('stop-video').hidden, false);
  assert.equal(h.byId('stop-video').textContent, 'Cancel');
  assert.equal(h.byId('details-notes').readOnly, true);
  pending.resolve({ status: 'ready', url: 'theatrum://app/original/' + 'b'.repeat(64) }); await settle();
  const video = h.byId('preview-video');
  assert.equal(video.src, 'theatrum://app/original/' + 'b'.repeat(64));
  assert.equal(video.hidden, false);
  assert.equal(video.plays, 1);
  assert.equal(h.byId('stop-video').textContent, 'Stop video');
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('play-preview').hidden, true);
  assert.equal(h.byId('play-original').hidden, true);
  h.byId('stop-video').fire('click');
  assert.equal(h.originalStops, 1);
  assert.equal(video.src, ''); assert.equal(video.hidden, true);
  assert.equal(h.byId('play-original').hidden, false);
  assert.equal(h.byId('play-preview').hidden, false);
  assert.equal(h.byId('details-notes').value, 'Keep my unsaved notes');
  assert.equal(h.byId('tag-draft').value, 'Tag draft');
  assert.equal(h.saves.length, 0);
  assert.equal(h.focused, h.byId('play-original'));
});

test('original playback availability is independent of preview regeneration and requires complete bridge and revision', async () => {
  for (const entry of [
    { overrides: { regenerable: false }, available: true, visible: true },
    { overrides: { playable: false }, available: true, visible: false },
    { overrides: { playable: 'yes' }, available: true, visible: false },
    { overrides: { revision: 'bad' }, available: true, visible: false },
    { overrides: {}, available: false, visible: false },
  ]) {
    const h = harness({ originalAvailable: entry.available, detail: async () => detail(item(), entry.overrides) }); await selectFirst(h);
    assert.equal(h.byId('play-original').hidden, !entry.visible);
    assert.equal(h.byId('play-preview').hidden, false);
  }
});

test('pending original picker excludes competing operations and cancellation waits for its response', async () => {
  const pending = deferred();
  const h = harness({ playOriginal: async () => pending.promise, list: async () => ready([item(0), item(1)], 80) });
  await selectFirst(h);
  h.byId('play-original').fire('click');
  for (const id of ['source-folders-toggle', 'protection-button', 'save-details', 'discard-details', 'regenerate-previews',
    'play-preview', 'toggle-filmstrip', 'next-page', 'gallery-search']) { assert.equal(h.byId(id).disabled, true, id); }
  assert.equal(h.byId('lock-hub').disabled, false);
  h.cards[1].fire('click'); h.byId('close-details').fire('click');
  assert.equal(h.selections.length, 1); assert.equal(h.byId('details-panel').hidden, false);
  h.byId('stop-video').fire('click'); h.byId('stop-video').fire('click');
  assert.equal(h.originalStops, 1);
  assert.equal(h.byId('stop-video').disabled, true);
  h.byId('play-original').fire('click');
  assert.equal(h.originalPlays.length, 1);
  pending.resolve({ status: 'ready', url: 'theatrum://app/original/' + 'b'.repeat(64) }); await settle();
  assert.equal(h.byId('preview-video').src, '');
  assert.equal(h.byId('preview-video').plays, 0);
  assert.equal(h.byId('playback-status').textContent, 'Opening video cancelled.');
  assert.equal(h.byId('play-original').disabled, false);
  assert.equal(h.byId('source-folders-toggle').disabled, false);
});

for (const status of ['cancelled', 'conflict', 'source-unavailable', 'wrong-folder', 'unsupported', 'busy', 'unavailable', '__proto__', 'constructor']) {
  test(`original ${status} failures use fixed messages and preserve drafts`, async () => {
    const h = harness({ playOriginal: async () => ({ status, message: '/private/sensitive.mov', url: 'file:///private/sensitive.mov' }) });
    await selectFirst(h);
    h.byId('details-notes').value = 'Draft'; h.byId('details-notes').fire('input');
    h.byId('play-original').fire('click'); await settle();
    assert.equal(h.byId('preview-video').src, '');
    assert.equal(h.byId('preview-video').plays, 0);
    assert.equal(h.originalStops, 1);
    assert.equal(h.byId('play-original').disabled, false);
    assert.equal(h.byId('details-notes').value, 'Draft');
    assert.doesNotMatch(h.byId('playback-status').textContent, /sensitive|file:|function|object Object/);
    assert.ok(h.byId('playback-status').textContent.length > 15);
    assert.equal(h.saves.length, 0);
  });
}

test('original URLs require exactly a same-origin opaque 64-hex capability', async () => {
  for (const url of ['file:///private/video.mp4', 'https://example.test/private.mp4', 'theatrum://app/media/clips/0.mp4',
    'theatrum://app/original/' + 'b'.repeat(63), 'theatrum://app/original/' + 'b'.repeat(65),
    'theatrum://app/original/' + 'B'.repeat(64), 'theatrum://app/original/' + 'b'.repeat(64) + '?path=private',
    'theatrum://app/original/' + 'b'.repeat(64) + '#private', 'theatrum://app/original/' + 'b'.repeat(64) + '\n',
    'theatrum://user@app/original/' + 'b'.repeat(64), undefined, 12]) {
    const h = harness({ playOriginal: async () => ({ status: 'ready', url }) }); await selectFirst(h);
    h.byId('play-original').fire('click'); await settle();
    assert.equal(h.byId('preview-video').src, '', String(url));
    assert.equal(h.byId('preview-video').plays, 0);
    assert.equal(h.originalStops, 1);
  }
});

test('playback media errors and rejected decoder promises revoke original access with fixed text', async () => {
  for (const rejection of [false, true]) {
    const h = harness(); await selectFirst(h);
    const video = h.byId('preview-video');
    if (rejection) { video.playResult = Promise.reject(new Error('/private/decoder.log')); }
    h.byId('play-original').fire('click'); await settle();
    if (!rejection) { video.onerror!(); }
    assert.equal(video.src, ''); assert.equal(video.hidden, true);
    assert.equal(h.originalStops, 1);
    assert.match(h.byId('playback-status').textContent, /format or codec may be unsupported/);
    assert.doesNotMatch(h.byId('playback-status').textContent, /decoder.log/);
    assert.equal(h.byId('play-original').disabled, false);
  }
});

test('natural original playback completion retires capability unless the user enabled looping', async () => {
  const h = harness(); await selectFirst(h);
  h.byId('play-original').fire('click'); await settle();
  const video = h.byId('preview-video'); const ended = video.onended!;
  video.loop = true; ended(); assert.equal(h.originalStops, 0);
  video.loop = false; ended(); assert.equal(h.originalStops, 1);
  assert.equal(video.src, ''); assert.equal(video.onended, null);
});

test('late original media events and play promises cannot stop newer playback', async () => {
  const h = harness(); await selectFirst(h);
  const video = h.byId('preview-video'); const pending = deferred<void>();
  video.playResult = pending.promise;
  h.byId('play-original').fire('click'); await settle();
  const oldError = video.onerror!; const oldLoaded = video.onloadeddata!; const oldEnded = video.onended!;
  h.byId('stop-video').fire('click');
  video.playResult = Promise.resolve();
  h.byId('play-original').fire('click'); await settle();
  const pauses = video.pauses; const stops = h.originalStops;
  oldError(); oldLoaded(); oldEnded(); pending.resolve(); await settle();
  assert.equal(h.originalStops, stops); assert.equal(video.pauses, pauses);
  assert.equal(video.hidden, false); assert.equal(video.plays, 2);
});

for (const action of ['close', 'selection', 'lock', 'pagehide', 'protection', 'sources', 'regeneration']) {
  test(`${action} retires original playback before proceeding`, async () => {
    const h = harness({ list: async () => ready([item(0), item(1)]) }); await selectFirst(h);
    h.byId('play-original').fire('click'); await settle();
    const video = h.byId('preview-video'); const lateError = video.onerror!;
    if (action === 'close') { h.byId('close-details').fire('click'); }
    if (action === 'selection') { h.cards[1].fire('click'); }
    if (action === 'lock') { h.byId('lock-hub').fire('click'); }
    if (action === 'pagehide') { h.window.fire('pagehide'); }
    if (action === 'protection') { h.byId('protection-button').fire('click'); }
    if (action === 'sources') { h.byId('source-folders-toggle').fire('click'); }
    if (action === 'regeneration') { h.byId('regenerate-previews').fire('click'); }
    await settle();
    assert.equal(h.originalStops, 1); assert.equal(video.src, ''); assert.equal(video.hidden, true);
    lateError(); assert.equal(h.originalStops, 1);
  });
}

test('lock and pagehide retire pending original replies without reintroducing capability or private messages', async () => {
  for (const action of ['lock', 'pagehide']) {
    const pending = deferred(); const h = harness({ playOriginal: async () => pending.promise }); await selectFirst(h);
    h.byId('play-original').fire('click');
    if (action === 'lock') { h.byId('lock-hub').fire('click'); } else { h.window.fire('pagehide'); }
    assert.equal(h.originalStops, 1);
    pending.resolve({ status: 'ready', url: 'theatrum://app/original/' + 'b'.repeat(64) }); await settle();
    assert.equal(h.originalStops, 1); assert.equal(h.byId('preview-video').src, '');
    assert.equal(h.byId('preview-video').plays, 0); assert.equal(h.byId('playback-status').textContent, '');
  }
});

test('original player retains local-only media controls and exposes actions outside video controls', () => {
  assert.match(html, /<video[^>]*preload="none"[^>]*controlslist="nodownload noremoteplayback"[^>]*disablepictureinpicture disableremoteplayback/);
  assert.match(html, /<\/video>\s*<\/div>\s*<div class="playback-actions"/);
  assert.doesNotMatch(source, /requestPictureInPicture|window\.open|shell\.open|dispatchEvent|setInterval/);
});


test('saving or discarding drafts clears active original playback before the catalogue request', async () => {
  for (const action of ['save', 'discard']) {
    const h = harness(); await selectFirst(h);
    h.byId('play-original').fire('click'); await settle();
    h.byId('details-notes').value = 'Edited note'; h.byId('details-notes').fire('input');
    h.byId(action === 'save' ? 'save-details' : 'discard-details').fire('click');
    assert.equal(h.byId('preview-video').src, '');
    assert.equal(h.originalStops, 1);
    await settle();
    assert.equal(h.byId('play-original').hidden, false);
    assert.equal(h.byId('stop-video').hidden, true);
    assert.equal(h.byId('playback-status').textContent, '');
    assert.equal(h.saves.length, action === 'save' ? 1 : 0);
    assert.equal(h.byId('details-notes').value, action === 'save' ? 'Edited note' : 'Private notes');
  }
});


test('Escape in fullscreen leaves Details and original playback intact for the browser exit', async () => {
  const h = harness(); await selectFirst(h);
  h.byId('play-original').fire('click'); await settle();
  const video = h.byId('preview-video'); const original = video.src;
  h.document.fullscreenElement = video;
  const event = h.document.fire('keydown', { key: 'Escape', target: video });
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(video.src, original); assert.equal(video.hidden, false);
  assert.equal(h.originalStops, 0); assert.equal(h.fullscreenExits, 0);
  h.document.fullscreenElement = null;
  assert.equal(h.document.fire('keydown', { key: 'Escape', target: video }).defaultPrevented, true);
  assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.originalStops, 1);
});

for (const mode of ['preview', 'original']) {
  for (const action of ['stop', 'selection', 'lock', 'pagehide']) {
    test(`${action} exits fullscreen ${mode} without waiting to clear media or revoke access`, async () => {
      const pendingExit = deferred<void>();
      const h = harness({ list: async () => ready([item(0), item(1)]), exitFullscreen: () => pendingExit.promise });
      await selectFirst(h);
      h.byId(mode === 'original' ? 'play-original' : 'play-preview').fire('click'); await settle();
      const video = h.byId('preview-video');
      h.document.fullscreenElement = video;
      if (action === 'stop') { h.byId('stop-video').fire('click'); }
      if (action === 'selection') { h.cards[1].fire('click'); }
      if (action === 'lock') { h.byId('lock-hub').fire('click'); }
      if (action === 'pagehide') { h.window.fire('pagehide'); }
      assert.equal(h.fullscreenExits, 1); assert.equal(video.src, ''); assert.equal(video.hidden, true);
      assert.equal(h.originalStops, mode === 'original' ? 1 : 0);
      assert.equal(h.lockCalls, action === 'lock' ? 1 : 0);
      pendingExit.resolve(); await settle();
      assert.equal(video.src, ''); assert.equal(h.originalStops, mode === 'original' ? 1 : 0);
    });
  }
}

for (const failure of ['throw', 'rejection']) {
  test(`fullscreen exit ${failure} cannot prevent media revocation and locking`, async () => {
    const h = harness({ exitFullscreen: () => {
      if (failure === 'throw') { throw new Error('Window closed'); }
      return Promise.reject(new Error('Fullscreen transition rejected'));
    } });
    await selectFirst(h); h.byId('play-original').fire('click'); await settle();
    h.document.fullscreenElement = h.byId('preview-video');
    h.byId('lock-hub').fire('click');
    assert.equal(h.fullscreenExits, 1); assert.equal(h.lockCalls, 1); assert.equal(h.originalStops, 1);
    assert.equal(h.byId('preview-video').src, ''); assert.equal(h.byId('preview-video').hidden, true);
    await settle();
    assert.equal(h.byId('details-title').textContent, '');
  });
}

test('ordinary playback cleanup never exits an unrelated fullscreen element', async () => {
  const h = harness(); await selectFirst(h);
  h.byId('play-original').fire('click'); await settle();
  h.document.fullscreenElement = h.byId('details-panel');
  h.byId('stop-video').fire('click');
  assert.equal(h.fullscreenExits, 0); assert.equal(h.originalStops, 1);
});


function importButton(h: ReturnType<typeof harness>): ElementStub {
  return h.byId('source-folders-list').children[0].querySelector('[data-action="import-video"]')!;
}

async function openSources(h: ReturnType<typeof harness>): Promise<void> {
  await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
}

test('Add videos is a named source action with no path or opaque source identity in its DOM', async () => {
  const h = harness(); await openSources(h);
  const button = importButton(h);
  assert.equal(button.tagName, 'button'); assert.equal(button.textContent, 'Add videos…');
  assert.equal(button.getAttribute('aria-label'), 'Add videos from Source folder 1');
  assert.equal(button.disabled, false);
  assert.ok(h.created.every(element => [...element.attributes.values()].every(value => !value.includes(sourceFolder().id))));
  const unavailable = harness({ importAvailable: false }); await openSources(unavailable);
  assert.equal(importButton(unavailable).disabled, true);
  assert.equal(relocationButton(unavailable).disabled, false);
  assert.equal(unavailable.byId('source-folders-list').children[0].querySelector('button')!.disabled, false);
});

test('video import is disabled for drafts and guards direct invocation without losing edits', async () => {
  for (const kind of ['notes', 'pending-tag', 'removed-tag', 'composition']) {
    const h = harness(); await selectFirst(h); await openSources(h);
    if (kind === 'notes') { draftNotes(h, 'PRIVATE-DRAFT'); }
    if (kind === 'pending-tag') { draftTag(h, 'PRIVATE-TAG'); }
    if (kind === 'removed-tag') { h.byId('details-tags').children[0].querySelector('button')!.fire('click'); }
    if (kind === 'composition') { h.byId('details-notes').fire('compositionstart'); }
    const notes = h.byId('details-notes').value; const tag = h.byId('tag-draft').value;
    assert.equal(importButton(h).disabled, true);
    importButton(h).disabled = false; importButton(h).fire('click'); await settle();
    assert.deepEqual(h.videoImports, []);
    assert.match(h.byId('source-folders-status').textContent, /Save or discard your video notes, tags and rating/);
    assert.equal(h.byId('details-notes').value, notes); assert.equal(h.byId('tag-draft').value, tag);
    assert.equal(h.requests.length, 1); assert.equal(h.sourceReads, 1);
  }
});

test('video import stops original playback, serializes controls and keeps cancellation independent from source changes', async () => {
  const pending = deferred();
  const h = harness({ importVideo: () => pending.promise, list: async () => ready([item(), item(1)], 70) });
  await selectFirst(h); await openSources(h);
  h.byId('play-original').fire('click'); await settle();
  assert.match(h.byId('preview-video').src, /original/);
  const stops = h.originalStops;
  importButton(h).fire('click');
  assert.equal(h.originalStops, stops + 1); assert.equal(h.byId('preview-video').src, '');
  assert.deepEqual(h.videoImports, [sourceFolder().id]);
  assert.match(h.byId('source-folders-status').textContent, /encrypted before it is added/);
  for (const id of ['source-folders-toggle', 'refresh-source-folders', 'close-source-folders', 'protection-button',
    'save-details', 'discard-details', 'regenerate-previews', 'play-preview', 'play-original', 'toggle-filmstrip', 'next-page', 'gallery-search']) {
    assert.equal(h.byId(id).disabled, true, id);
  }
  assert.ok(h.byId('source-folders-list').children[0].querySelectorAll('button').every(button => button.disabled));
  assert.equal(h.byId('details-notes').readOnly, true); assert.equal(h.byId('lock-hub').disabled, false);
  h.cards[1].fire('click'); h.byId('close-details').fire('click'); h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.selections.length, 1); assert.equal(h.byId('source-folders-panel').hidden, false);
  assert.equal(h.byId('cancel-source-connection').hidden, true); assert.equal(h.byId('cancel-video-import').hidden, false);
  h.byId('cancel-source-connection').fire('click'); assert.equal(h.sourceCancellations, 0);
  h.byId('cancel-video-import').fire('click'); h.byId('cancel-video-import').fire('click');
  assert.equal(h.importCancellations, 1); assert.equal(h.byId('cancel-video-import').disabled, true);
  assert.match(h.byId('source-folders-status').textContent, /already being saved may finish/);
  pending.resolve({ status: 'cancelled' }); await settle(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2);
  assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.byId('cancel-video-import').hidden, true);
  assert.equal(importButton(h).disabled, false); assert.equal(h.focused, importButton(h));
  assert.match(h.byId('source-folders-status').textContent, /Import cancelled.*already being saved may finish/);
});

test('a committed import wins a cancellation race and refreshes catalogue and source identities', async () => {
  let imported = false; const pending = deferred(); const newSourceId = 'e'.repeat(32);
  const h = harness({ importVideo: async () => { await pending.promise; imported = true; return batchResult(); },
    sources: async () => ({ status: 'ready', items: [sourceFolder(1, { id: imported ? newSourceId : sourceFolder().id, videoCount: imported ? 4 : 3 })] }),
    list: async request => ready(imported ? [item(1), item(2)] : [item()], 70, request.offset) });
  await selectFirst(h); await openSources(h);
  const oldButton = importButton(h); oldButton.fire('click'); h.byId('cancel-video-import').fire('click');
  pending.resolve({}); await settle(); await settle();
  assert.equal(h.requests.length, 2); assert.deepEqual(h.requests[1], h.requests[0]);
  assert.equal(h.cards.length, 2); assert.equal(h.selections.length, 1); assert.equal(h.byId('details-notes').value, '');
  assert.match(h.byId('source-folders-list').textContent, /4 videos/);
  assert.match(h.byId('source-folders-status').textContent, /Import complete. 1 added/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /cancelled|rollback/);
  oldButton.disabled = false; oldButton.fire('click'); assert.equal(h.videoImports.length, 1, 'Retired source closures cannot submit');
  importButton(h).fire('click'); await settle(); await settle();
  assert.deepEqual(h.videoImports, [sourceFolder().id, newSourceId]);
});

for (const status of ['cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'source-unavailable', 'wrong-folder', 'busy', 'unavailable', '__proto__', 'constructor']) {
  test(`${status} video import refreshes authoritative state and shows only fixed messages`, async () => {
    const h = harness({ importVideo: async () => ({ status, path: '/PRIVATE-IMPORT', message: 'PRIVATE-IMPORT' }) });
    await selectFirst(h); await openSources(h); importButton(h).fire('click'); await settle(); await settle();
    assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2); assert.equal(h.byId('details-panel').hidden, true);
    assert.notEqual(h.byId('source-folders-status').textContent, '');
    assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-IMPORT|function|object Object/);
    assert.equal(importButton(h).disabled, false);
    if (status === 'wrong-folder') {
      assert.match(h.byId('source-folders-status').textContent, /not the saved source folder.*select the saved folder when prompted/);
    }
  });
}

test('import and refresh exceptions leave no stale details or source rows', async () => {
  let reads = 0;
  const h = harness({ importVideo: async () => { throw new Error('/PRIVATE-IMPORT'); }, sources: async () => {
    if (++reads === 1) return { status: 'ready', items: [sourceFolder()] };
    throw new Error('/PRIVATE-IMPORT');
  } });
  await selectFirst(h); await openSources(h); importButton(h).fire('click'); await settle(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2); assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('source-folders-list').children.length, 0);
  assert.match(h.byId('source-folders-status').textContent, /could not be added.*Choose Refresh/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-IMPORT/);
  assert.equal(h.focused, h.byId('refresh-source-folders'));
});

test('lock and pagehide suppress import and refresh completions at every async boundary', async () => {
  for (const stage of ['import', 'catalogue', 'sources']) {
    for (const ending of ['lock', 'pagehide']) {
      const pending = deferred(); let lists = 0; let reads = 0;
      const h = harness({ importVideo: async () => stage === 'import' ? pending.promise : batchResult(),
        list: async () => ++lists > 1 && stage === 'catalogue' ? pending.promise : ready([item()]),
        sources: async () => ++reads > 1 && stage === 'sources' ? pending.promise : { status: 'ready', items: [sourceFolder()] } });
      await selectFirst(h); await openSources(h); importButton(h).fire('click'); await settle(); await settle();
      if (ending === 'lock') h.byId('lock-hub').fire('click'); else h.window.fire('pagehide');
      pending.resolve(stage === 'import' ? { status: 'imported' } : stage === 'catalogue' ? ready([item(1)]) : { status: 'ready', items: [sourceFolder(2)] });
      await settle(); await settle();
      assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.byId('source-folders-panel').hidden, true);
      assert.equal(h.byId('source-folders-list').children.length, 0); assert.equal(h.byId('source-folders-status').textContent, '');
      assert.equal(h.byId('cancel-video-import').hidden, true); assert.equal(h.cards.length, 0);
      h.byId('cancel-video-import').fire('click'); assert.equal(h.importCancellations, 0);
    }
  }
});

test('malformed source IDs cannot create import actions', async () => {
  for (const patch of [{ id: sourceFolder().id + '\n' }, { id: '/PRIVATE-IMPORT' }, { title: 'Source folder 1\n' }, { videoCount: 100_001 }]) {
    const h = harness({ sources: async () => ({ status: 'ready', items: [sourceFolder(1, patch)] }) }); await openSources(h);
    assert.equal(h.byId('source-folders-list').children.length, 0); assert.deepEqual(h.videoImports, []);
  }
});


test('import cancellation errors remain generic and never block locking', async () => {
  const pending = deferred();
  const h = harness({ importVideo: () => pending.promise, cancelImport: () => { throw new Error('/PRIVATE-IMPORT'); } });
  await openSources(h); importButton(h).fire('click'); h.byId('cancel-video-import').fire('click');
  assert.match(h.byId('source-folders-status').textContent, /could not be cancelled.*lock the hub/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-IMPORT/);
  assert.equal(h.byId('lock-hub').disabled, false);
  h.byId('lock-hub').fire('click'); pending.resolve({ status: 'cancelled' }); await settle();
  assert.equal(h.lockCalls, 1); assert.equal(h.requests.length, 1);
  assert.equal(h.byId('source-folders-status').textContent, '');
});

test('import preserves search and pagination while retiring the old selection', async () => {
  const h = harness({ list: async request => ready([item(request.offset)], 70, request.offset) });
  await settle(); const search = h.byId('gallery-search');
  search.value = 'Nature'; search.fire('input'); await h.runTimer();
  h.byId('next-page').fire('click'); await settle(); await openSources(h);
  importButton(h).fire('click'); await settle(); await settle();
  assert.deepEqual(h.requests.at(-1), { query: 'Nature', offset: 48, collection: 'all', sort: 'catalogue', direction: 'asc' });
  assert.equal(search.value, 'Nature'); assert.equal(h.byId('page-label').textContent, 'Page 2 of 2');
});


test('Add folder can start from an empty valid source list but not a failed, unavailable or full list', async () => {
  for (const count of [0, 1, 255, 256]) {
    const h = harness({ sources: async () => ({ status: 'ready', items: Array.from({ length: count }, (_, i) => sourceFolder(i + 1)) }) });
    await openSources(h);
    assert.equal(h.byId('add-source-folder').disabled, count === 256);
    h.byId('add-source-folder').disabled = false; h.byId('add-source-folder').fire('click'); await settle(); await settle();
    assert.equal(h.sourceAdditions, count === 256 ? 0 : 1);
    assert.equal(h.sourceConnections.length, 0); assert.equal(h.videoImports.length, 0);
  }
  for (const result of [{ status: 'unavailable' }, { status: 'busy' }, { status: 'ready', items: [sourceFolder(257)] }]) {
    const h = harness({ sources: async () => result }); await openSources(h);
    assert.equal(h.byId('add-source-folder').disabled, true);
    h.byId('add-source-folder').disabled = false; h.byId('add-source-folder').fire('click'); await settle();
    assert.equal(h.sourceAdditions, 0);
  }
  const h = harness({ addSourceAvailable: false }); await openSources(h);
  assert.equal(h.byId('add-source-folder').disabled, true);
  assert.equal(importButton(h).disabled, false);
});

test('source-add guards notes, tags and composition drafts without erasing edits', async () => {
  for (const kind of ['notes', 'pending-tag', 'removed-tag', 'composition']) {
    const h = harness(); await selectFirst(h); await openSources(h);
    if (kind === 'notes') { draftNotes(h, 'PRIVATE-DRAFT'); }
    if (kind === 'pending-tag') { draftTag(h, 'PRIVATE-TAG'); }
    if (kind === 'removed-tag') { h.byId('details-tags').children[0].querySelector('button')!.fire('click'); }
    if (kind === 'composition') { h.byId('details-notes').fire('compositionstart'); }
    const notes = h.byId('details-notes').value; const tag = h.byId('tag-draft').value;
    assert.equal(h.byId('add-source-folder').disabled, true);
    h.byId('add-source-folder').disabled = false; h.byId('add-source-folder').fire('click'); await settle();
    assert.equal(h.sourceAdditions, 0);
    assert.match(h.byId('source-folders-status').textContent, /Save or discard your video notes, tags and rating/);
    assert.equal(h.byId('details-notes').value, notes); assert.equal(h.byId('tag-draft').value, tag);
    assert.equal(h.requests.length, 1); assert.equal(h.sourceReads, 1);
  }
});

test('adding a source stops playback and serializes controls while preserving one-shot cancellation', async () => {
  const pending = deferred();
  const h = harness({ addSource: () => pending.promise, list: async () => ready([item(), item(1)], 70) });
  await selectFirst(h); await openSources(h); h.byId('play-original').fire('click'); await settle();
  const stops = h.originalStops;
  h.byId('add-source-folder').fire('click');
  assert.equal(h.originalStops, stops + 1); assert.equal(h.byId('preview-video').src, '');
  assert.equal(h.sourceAdditions, 1);
  assert.match(h.byId('source-folders-status').textContent, /No videos will be added automatically.*original files remain unchanged/);
  for (const id of ['add-source-folder', 'source-folders-toggle', 'refresh-source-folders', 'close-source-folders', 'protection-button',
    'save-details', 'discard-details', 'regenerate-previews', 'play-preview', 'play-original', 'next-page', 'gallery-search']) {
    assert.equal(h.byId(id).disabled, true, id);
  }
  assert.ok(h.byId('source-folders-list').children[0].querySelectorAll('button').every(button => button.disabled));
  assert.equal(h.byId('details-notes').readOnly, true); assert.equal(h.byId('lock-hub').disabled, false);
  h.cards[1].fire('click'); h.byId('close-details').fire('click'); h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.selections.length, 1); assert.equal(h.byId('source-folders-panel').hidden, false);
  assert.equal(h.byId('cancel-source-connection').hidden, false); assert.equal(h.byId('cancel-video-import').hidden, true);
  assert.equal(h.byId('cancel-source-connection').textContent, 'Cancel adding folder');
  h.byId('cancel-video-import').fire('click'); assert.equal(h.importCancellations, 0);
  h.byId('cancel-source-connection').fire('click'); h.byId('cancel-source-connection').fire('click');
  assert.equal(h.sourceCancellations, 1);
  assert.match(h.byId('source-folders-status').textContent, /save already in progress may finish/);
  pending.resolve({ status: 'cancelled' }); await settle(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2);
  assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.byId('cancel-source-connection').hidden, true);
  assert.equal(h.byId('add-source-folder').disabled, false); assert.equal(h.focused, h.byId('add-source-folder'));
});

test('a committed source addition wins cancellation and refreshes disconnected zero-video rows without granting access', async () => {
  let added = false; const pending = deferred();
  const h = harness({ addSource: async () => { await pending.promise; added = true; return { status: 'added' }; },
    sources: async () => ({ status: 'ready', items: added ? [sourceFolder(), sourceFolder(2, { videoCount: 0 })] : [sourceFolder()] }) });
  await selectFirst(h); await openSources(h);
  h.byId('add-source-folder').fire('click'); h.byId('cancel-source-connection').fire('click');
  pending.resolve(undefined); await settle(); await settle();
  assert.equal(h.byId('source-folders-list').children.length, 2);
  const row = h.byId('source-folders-list').children[1];
  assert.match(row.textContent, /0 videos.*Not connected/);
  assert.match(h.byId('source-folders-status').textContent, /saved and not connected.*Original files are unchanged/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /cancelled/);
  assert.equal(h.sourceConnections.length, 0); assert.equal(h.videoImports.length, 0);
  assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2);
  row.querySelector('[data-action="connect-source"]')!.fire('click'); await settle();
  assert.deepEqual(h.sourceConnections, [sourceFolder(2).id]);
});

for (const status of ['cancelled', 'conflict', 'invalid', 'duplicate', 'limit', 'source-unavailable', 'busy', 'unavailable', '__proto__', 'constructor']) {
  test(`${status} source addition refreshes authoritative state with a fixed generic message`, async () => {
    const h = harness({ addSource: async () => ({ status, path: '/PRIVATE-SOURCE', message: 'PRIVATE-SOURCE' }) });
    await selectFirst(h); await openSources(h); h.byId('add-source-folder').fire('click'); await settle(); await settle();
    assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2); assert.equal(h.byId('details-panel').hidden, true);
    assert.notEqual(h.byId('source-folders-status').textContent, '');
    assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-SOURCE|function|object Object/);
    assert.equal(h.byId('add-source-folder').disabled, false);
  });
}

test('source-add refresh exceptions clear stale rows and require a successful refresh before another add', async () => {
  let reads = 0;
  const h = harness({ addSource: async () => { throw new Error('/PRIVATE-SOURCE'); }, sources: async () => {
    if (++reads === 2) { throw new Error('/PRIVATE-SOURCE'); }
    return { status: 'ready', items: [] };
  } });
  await selectFirst(h); await openSources(h); h.byId('add-source-folder').fire('click'); await settle(); await settle();
  assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2); assert.equal(h.byId('details-panel').hidden, true);
  assert.equal(h.byId('source-folders-list').children.length, 0); assert.equal(h.byId('add-source-folder').disabled, true);
  assert.match(h.byId('source-folders-status').textContent, /could not be added.*Choose Refresh/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-SOURCE/);
  assert.equal(h.focused, h.byId('refresh-source-folders'));
  h.byId('refresh-source-folders').fire('click'); await settle();
  assert.equal(h.byId('add-source-folder').disabled, false);
});

test('lock and pagehide retire source-add picker and refresh callbacks without restoring sensitive state', async () => {
  for (const stage of ['picker', 'catalogue', 'sources']) {
    for (const action of ['lock', 'pagehide']) {
      const pending = deferred(); let reads = 0; let lists = 0;
      const h = harness({ addSource: async () => stage === 'picker' ? pending.promise : { status: 'added' },
        list: async () => ++lists > 1 && stage === 'catalogue' ? pending.promise : ready([item()]),
        sources: async () => ++reads > 1 && stage === 'sources' ? pending.promise : { status: 'ready', items: [sourceFolder()] } });
      await selectFirst(h); await openSources(h); h.byId('add-source-folder').fire('click'); await settle(); await settle();
      if (action === 'lock') { h.byId('lock-hub').fire('click'); } else { h.window.fire('pagehide'); }
      pending.resolve(stage === 'picker' ? { status: 'added' } : stage === 'catalogue' ? ready([item(1)]) : { status: 'ready', items: [sourceFolder(2)] });
      await settle(); await settle();
      assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.byId('source-folders-panel').hidden, true);
      assert.equal(h.byId('source-folders-list').children.length, 0); assert.equal(h.byId('source-folders-status').textContent, '');
      assert.equal(h.byId('cancel-source-connection').hidden, true); assert.equal(h.byId('add-source-folder').disabled, true);
      assert.equal(h.cards.length, 0);
    }
  }
});

test('source-add cancellation exceptions remain generic and locking still clears the pending action', async () => {
  const pending = deferred();
  const h = harness({ addSource: () => pending.promise, cancelSourceConnection: () => { throw new Error('/PRIVATE-SOURCE'); } });
  await openSources(h); h.byId('add-source-folder').fire('click'); h.byId('cancel-source-connection').fire('click');
  assert.match(h.byId('source-folders-status').textContent, /could not be cancelled.*lock the hub/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-SOURCE/);
  h.byId('lock-hub').fire('click'); pending.resolve({ status: 'added' }); await settle();
  assert.equal(h.byId('source-folders-status').textContent, '');
});


function batchResult(overrides: Record<string, unknown> = {}): any {
  return { status: 'finished', outcome: 'completed', total: 1, processed: 1, imported: 1, duplicates: 0, failed: 0, ...overrides };
}

test('batch import help describes bounded manual selection from one source folder', () => {
  assert.match(html, /Add up to 100 videos from one folder with encrypted previews/);
});

test('batch summaries distinguish saved, duplicate, failed and unprocessed videos', async () => {
  for (const outcome of ['completed', 'cancelled', 'stopped']) {
    const h = harness({ importVideo: async () => batchResult({ outcome, total: outcome === 'completed' ? 6 : 8,
      processed: 6, imported: 3, duplicates: 2, failed: 1, path: '/PRIVATE-BATCH', message: '/PRIVATE-BATCH' }) });
    await openSources(h); importButton(h).fire('click'); await settle(); await settle();
    const status = h.byId('source-folders-status').textContent;
    assert.match(status, /3 added, 2 already in the catalogue, 1 failed/);
    assert.match(status, outcome === 'completed' ? /0 not processed/ : /2 not processed/);
    assert.match(status, outcome === 'completed' ? /Import complete.*Original videos are unchanged/ : /Saved videos remain.*already being saved may finish.*Review the catalogue/);
    assert.doesNotMatch(status, /PRIVATE-BATCH/);
    assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2); assert.equal(h.timers, 0);
  }
});

test('invalid batch counts never render misleading completion or native fields', async () => {
  for (const changes of [{ total: 2 }, { processed: 0 }, { failed: 1 }, { imported: -1 }, { total: 101 },
    { processed: 0.5 }, { outcome: 'PRIVATE-BATCH' }, { total: '<PRIVATE-BATCH>' }]) {
    const h = harness({ importVideo: async () => batchResult(changes) });
    await openSources(h); importButton(h).fire('click'); await settle(); await settle();
    assert.match(h.byId('source-folders-status').textContent, /could not be added.*Review the current catalogue/);
    assert.doesNotMatch(h.byId('source-folders-status').textContent, /Import complete|PRIVATE-BATCH/);
    assert.equal(h.timers, 0);
  }
});

test('numeric progress polls serially during import and stops before catalogue refresh', async () => {
  const pending = deferred(); const progress = deferred(); const listing = deferred(); let calls = 0;
  const h = harness({ importVideo: () => pending.promise, importProgress: () => progress.promise,
    list: async () => ++calls === 1 ? ready([item()]) : listing.promise });
  await openSources(h); importButton(h).fire('click');
  assert.match(h.byId('source-folders-status').textContent, /Choose up to 100 videos/);
  assert.equal(h.timers, 1); await h.runTimer(); assert.equal(h.importProgressReads, 1); assert.equal(h.timers, 0);
  progress.resolve({ status: 'running', total: 5, processed: 3, imported: 1, duplicates: 1, failed: 1, path: '/PRIVATE-BATCH' }); await settle();
  assert.equal(h.timers, 1);
  assert.match(h.byId('source-folders-status').textContent, /3 of 5 processed.*1 added, 1 already in the catalogue, 1 failed/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-BATCH/);
  pending.resolve(batchResult()); await settle();
  assert.equal(h.timers, 0, 'Polling ends before refresh is released');
  listing.resolve(ready([item()])); await settle(); await settle();
  assert.match(h.byId('source-folders-status').textContent, /Import complete/);
});

test('idle, malformed and failed progress leave the fixed status intact and can retry', async () => {
  for (const response of [{ status: 'idle' }, { status: 'running', total: 2 },
    { status: 'running', total: 101, processed: 1, imported: 1, duplicates: 0, failed: 0 },
    { status: 'running', total: 2, processed: 1, imported: 1, duplicates: 1, failed: 0 }, new Error('/PRIVATE-BATCH')]) {
    const pending = deferred();
    const h = harness({ importVideo: () => pending.promise, importProgress: async () => {
      if (response instanceof Error) throw response; return response;
    } });
    await openSources(h); importButton(h).fire('click'); const before = h.byId('source-folders-status').textContent;
    await h.runTimer(); assert.equal(h.byId('source-folders-status').textContent, before); assert.equal(h.timers, 1);
    pending.resolve(batchResult()); await settle(); await settle(); assert.equal(h.timers, 0);
  }
});

test('cancellation, lock and pagehide stop polling and discard already requested late progress', async () => {
  for (const action of ['cancel', 'lock', 'pagehide']) {
    for (const inFlight of [false, true]) {
      const pending = deferred(); const progress = deferred();
      const h = harness({ importVideo: () => pending.promise, importProgress: () => progress.promise });
      await openSources(h); importButton(h).fire('click');
      if (inFlight) await h.runTimer();
      if (action === 'cancel') h.byId('cancel-video-import').fire('click');
      if (action === 'lock') h.byId('lock-hub').fire('click');
      if (action === 'pagehide') h.window.fire('pagehide');
      const before = h.byId('source-folders-status').textContent;
      assert.equal(h.timers, 0);
      progress.resolve({ status: 'running', total: 10, processed: 9, imported: 9, duplicates: 0, failed: 0 }); await settle();
      assert.equal(h.byId('source-folders-status').textContent, before); assert.equal(h.timers, 0);
      pending.resolve(batchResult({ outcome: 'cancelled', total: 2 })); await settle(); await settle();
      assert.equal(h.timers, 0);
      if (action === 'cancel') assert.match(h.byId('source-folders-status').textContent, /1 added.*1 not processed.*Saved videos remain/);
      else assert.equal(h.byId('source-folders-status').textContent, '');
    }
  }
});

test('old progress cannot repaint a completed import or its replacement operation', async () => {
  for (const replacement of [false, true]) {
    const pending = deferred(); const progress = deferred(); const later = deferred(); let imports = 0;
    const h = harness({ importVideo: () => ++imports === 1 ? pending.promise : later.promise, importProgress: () => progress.promise });
    await openSources(h); importButton(h).fire('click'); await h.runTimer();
    pending.resolve(batchResult()); await settle(); await settle();
    if (replacement) importButton(h).fire('click');
    const before = h.byId('source-folders-status').textContent;
    progress.resolve({ status: 'running', total: 100, processed: 99, imported: 99, duplicates: 0, failed: 0 }); await settle();
    assert.equal(h.byId('source-folders-status').textContent, before);
    assert.equal(h.timers, replacement ? 1 : 0);
    if (replacement) { later.resolve(batchResult()); await settle(); await settle(); }
    assert.equal(h.timers, 0);
  }
});


function selectCollection(h: ReturnType<typeof harness>, value: string): void {
  h.byId('gallery-collection').value = value; h.byId('gallery-collection').fire('change');
}
function selectSort(h: ReturnType<typeof harness>, value: string): void {
  h.byId('gallery-sort').value = value; h.byId('gallery-sort').fire('change');
}

test('collection and sort controls have explicit labels and start in catalogue order without persistent storage', async () => {
  const h = harness(); await settle();
  assert.match(html, /for="gallery-collection">Collection/); assert.match(html, /for="gallery-sort">Sort by/);
  assert.equal(h.byId('gallery-collection').value, 'all'); assert.equal(h.byId('gallery-sort').value, 'catalogue');
  assert.equal(h.byId('gallery-sort-direction').getAttribute('data-direction'), 'asc');
  assert.match(h.byId('gallery-sort-direction').getAttribute('aria-label')!, /Sort ascending; activate for descending/);
  assert.deepEqual(h.requests[0], { query: '', offset: 0, collection: 'all', sort: 'catalogue', direction: 'asc' });
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test('Recent chooses descending last played while other collections preserve chosen order', async () => {
  const h = harness(); await settle();
  selectCollection(h, 'recent'); await settle();
  assert.deepEqual(h.requests.at(-1), { query: '', offset: 0, collection: 'recent', sort: 'last-played', direction: 'desc' });
  assert.equal(h.byId('gallery-sort').value, 'last-played'); assert.equal(h.byId('gallery-sort-direction').getAttribute('data-direction'), 'desc');
  assert.match(h.byId('gallery-sort-direction').getAttribute('aria-label')!, /Sort descending; activate for ascending/);
  selectCollection(h, 'favourites'); await settle();
  assert.equal(h.requests.at(-1)!.collection, 'favourites'); assert.equal(h.requests.at(-1)!.sort, 'last-played');
  selectSort(h, 'name'); await settle(); h.byId('gallery-sort-direction').fire('click'); await settle();
  selectCollection(h, 'all'); await settle();
  assert.deepEqual(h.requests.at(-1), { query: '', offset: 0, collection: 'all', sort: 'name', direction: 'desc' });
});

test('sort choices set sensible directions and direction button reverses each order', async () => {
  const h = harness(); await settle();
  for (const sort of ['catalogue', 'name', 'date-added', 'last-played', 'rating', 'duration', 'file-size']) {
    selectSort(h, sort); await settle();
    const direction = ['catalogue', 'name'].includes(sort) ? 'asc' : 'desc';
    assert.equal(h.requests.at(-1)!.sort, sort); assert.equal(h.requests.at(-1)!.direction, direction);
    h.byId('gallery-sort-direction').fire('click'); await settle();
    assert.equal(h.requests.at(-1)!.direction, direction === 'asc' ? 'desc' : 'asc');
  }
});

test('browse changes preserve pending search text in a single new request and reset paging', async () => {
  for (const kind of ['collection', 'sort', 'direction']) {
    const h = harness({ list: async request => ready([item()], 100, request.offset) }); await settle();
    h.byId('next-page').fire('click'); await settle(); assert.equal(h.requests.at(-1)!.offset, 48);
    h.byId('gallery-search').value = 'Nature'; h.byId('gallery-search').fire('input'); assert.equal(h.timers, 1);
    if (kind === 'collection') selectCollection(h, 'favourites');
    if (kind === 'sort') selectSort(h, 'rating');
    if (kind === 'direction') h.byId('gallery-sort-direction').fire('click');
    await settle(); assert.equal(h.timers, 0); assert.equal(h.requests.length, 3);
    assert.equal(h.requests.at(-1)!.query, 'Nature'); assert.equal(h.requests.at(-1)!.offset, 0);
    assert.equal(h.byId('gallery-search').value, 'Nature');
    h.byId('next-page').fire('click'); await settle();
    const previous = h.requests.at(-2)!; assert.deepEqual(h.requests.at(-1), { ...previous, offset: 48 });
    h.byId('gallery-search').value = 'Bird'; h.byId('gallery-search').fire('input'); await h.runTimer();
    assert.deepEqual(h.requests.at(-1), { ...previous, query: 'Bird', offset: 0 });
  }
});

test('browse replacement retires old page replies, image callbacks and delayed retries', async () => {
  const stale = deferred(); let calls = 0;
  const h = harness({ list: async request => ++calls === 2 ? stale.promise : ready([item(calls)], 100, request.offset) });
  await settle(); const oldImage = h.activeImages[0]; const callback = oldImage.onload!;
  selectSort(h, 'name'); await settle();
  selectCollection(h, 'favourites'); await settle();
  stale.resolve(ready([item(99)], 100)); await settle(); callback();
  assert.equal(h.cards.length, 1); assert.match(h.cards[0].textContent, /Private video 3/);
  assert.equal(oldImage.src, ''); assert.equal(h.requests.at(-1)!.collection, 'favourites');
  const retry = harness({ list: async request => request.sort === 'name' ? { status: 'busy' } : ready([item()]) });
  await settle(); selectSort(retry, 'name'); await settle(); assert.equal(retry.timers, 1);
  selectSort(retry, 'duration'); await settle(); assert.equal(retry.timers, 0);
  assert.equal(retry.requests.length, 3); assert.equal(retry.requests.at(-1)!.sort, 'duration');
});

test('busy retries and manual retries retain the selected collection, sort and direction', async () => {
  const h = harness({ list: async request => request.collection === 'recent' ? { status: 'busy' } : ready([item()]) });
  await settle(); selectCollection(h, 'recent'); await settle(); await h.runTimer(); await h.runTimer();
  const request = { query: '', offset: 0, collection: 'recent', sort: 'last-played', direction: 'desc' };
  assert.deepEqual(h.requests.slice(1), [request, request, request]);
  h.byId('retry-gallery').fire('click'); await settle(); assert.deepEqual(h.requests.at(-1), request);
});

test('empty collections describe favourites and saved playback history with a direction to enable encrypted playback tracking', async () => {
  const h = harness({ list: async () => ready([]) }); await settle();
  selectCollection(h, 'favourites'); await settle();
  assert.equal(h.byId('empty-title').textContent, 'No favourites yet');
  assert.match(h.byId('empty-message').textContent, /marked as favourites.*All videos/);
  selectCollection(h, 'recent'); await settle();
  assert.equal(h.byId('empty-title').textContent, 'No recently played videos');
  assert.match(h.byId('empty-message').textContent, /saved catalogue history.*Turn on Record playback history in Protection/);
  h.byId('gallery-search').value = 'None'; h.byId('gallery-search').fire('input'); await h.runTimer();
  assert.equal(h.byId('empty-title').textContent, 'No matching videos');
  assert.match(h.byId('empty-message').textContent, /another collection/);
});

test('browse changes stop originals, previews and filmstrips before showing replacement rows', async () => {
  for (const media of ['original', 'preview', 'filmstrip']) {
    const h = harness(); await selectFirst(h);
    if (media === 'original') h.byId('play-original').fire('click');
    if (media === 'preview') h.byId('play-preview').fire('click');
    if (media === 'filmstrip') h.byId('toggle-filmstrip').fire('click');
    await settle(); selectSort(h, 'name'); await settle();
    assert.equal(h.byId('preview-video').src, ''); assert.equal(h.byId('detail-filmstrip').src, '');
    assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.byId('filmstrip-panel').hidden, true);
    if (media === 'original') assert.equal(h.originalStops, 1);
  }
});

test('unsaved notes, tags, composition and protection settings disable browse and guard forced changes', async () => {
  for (const draft of ['notes', 'tag', 'remove-tag', 'editor-composition', 'search-composition', 'protection']) {
    const h = harness(); await selectFirst(h);
    if (draft === 'notes') draftNotes(h, 'PRIVATE-NOTES');
    if (draft === 'tag') draftTag(h, 'PRIVATE-TAG');
    if (draft === 'remove-tag') h.byId('details-tags').children[0].querySelector('button')!.fire('click');
    if (draft === 'editor-composition') h.byId('details-notes').fire('compositionstart');
    if (draft === 'search-composition') h.byId('gallery-search').fire('compositionstart');
    if (draft === 'protection') {
      h.byId('protection-button').fire('click'); await settle();
      h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
    }
    const notes = h.byId('details-notes').value; const tag = h.byId('tag-draft').value;
    for (const id of ['gallery-collection', 'gallery-sort', 'gallery-sort-direction']) assert.equal(h.byId(id).disabled, true, draft + id);
    h.byId('gallery-collection').value = 'recent'; h.byId('gallery-sort').value = 'duration';
    h.byId('gallery-collection').fire('change');
    assert.equal(h.byId('gallery-collection').value, 'all'); assert.equal(h.byId('gallery-sort').value, 'catalogue');
    h.byId('gallery-sort-direction').disabled = false; h.byId('gallery-sort-direction').fire('click');
    assert.equal(h.byId('gallery-sort-direction').getAttribute('data-direction'), 'asc'); assert.equal(h.requests.length, 1);
    assert.equal(h.byId('details-notes').value, notes); assert.equal(h.byId('tag-draft').value, tag);
    if (draft === 'protection') assert.match(h.byId('protection-status').textContent, /Save your protection settings/);
  }
});

test('browse remains gated throughout imports, source changes and protection operations', async () => {
  for (const operation of ['import', 'add-source', 'connect', 'protection', 'save', 'regenerate']) {
    const pending = deferred(); const h = harness({ importVideo: () => pending.promise, addSource: () => pending.promise,
      connectSource: () => pending.promise, setProtection: () => pending.promise, save: () => pending.promise, regenerate: () => pending.promise });
    await selectFirst(h);
    if (['import', 'add-source', 'connect'].includes(operation)) {
      await openSources(h);
      if (operation === 'import') importButton(h).fire('click');
      if (operation === 'add-source') h.byId('add-source-folder').fire('click');
      if (operation === 'connect') h.byId('source-folders-list').children[0].querySelector('button')!.fire('click');
    }
    if (operation === 'protection') {
      h.byId('protection-button').fire('click'); await settle(); h.byId('auto-lock-minutes').value = '15';
      h.byId('auto-lock-minutes').fire('change'); h.byId('save-protection').fire('click');
    }
    if (operation === 'save') { draftNotes(h); h.byId('save-details').fire('click'); }
    if (operation === 'regenerate') h.byId('regenerate-previews').fire('click');
    for (const id of ['gallery-collection', 'gallery-sort', 'gallery-sort-direction']) assert.equal(h.byId(id).disabled, true, operation + id);
    selectCollection(h, 'recent'); selectSort(h, 'name');
    h.byId('gallery-sort-direction').disabled = false; h.byId('gallery-sort-direction').fire('click');
    assert.equal(h.byId('gallery-collection').value, 'all'); assert.equal(h.byId('gallery-sort').value, 'catalogue');
    assert.equal(h.requests.length, 1);
    h.byId('lock-hub').fire('click'); pending.resolve({ status: 'unavailable' }); await settle();
  }
});

test('metadata refresh preserves current collection and order', async () => {
  const h = harness(); await settle(); selectCollection(h, 'favourites'); await settle(); selectSort(h, 'rating'); await settle();
  await selectFirst(h); draftNotes(h, 'Updated notes'); h.byId('save-details').fire('click'); await settle(); await settle();
  assert.deepEqual(h.requests.at(-1), { query: '', offset: 0, collection: 'favourites', sort: 'rating', direction: 'desc' });
});

test('invalid select values restore current controls without sending a request', async () => {
  const h = harness(); await settle();
  selectCollection(h, '/PRIVATE-PATH'); selectSort(h, '__proto__');
  assert.equal(h.requests.length, 1); assert.equal(h.byId('gallery-collection').value, 'all');
  assert.equal(h.byId('gallery-sort').value, 'catalogue');
});

test('locking and pagehide reset collection/order and suppress delayed list replies', async () => {
  for (const action of ['lock', 'pagehide']) {
    const pending = deferred();
    const h = harness({ list: async request => request.collection === 'recent' ? pending.promise : ready([item()]) });
    await settle(); selectCollection(h, 'recent');
    if (action === 'lock') h.byId('lock-hub').fire('click'); else h.window.fire('pagehide');
    assert.equal(h.byId('gallery-collection').value, 'all'); assert.equal(h.byId('gallery-sort').value, 'catalogue');
    assert.equal(h.byId('gallery-sort-direction').getAttribute('data-direction'), 'asc');
    for (const id of ['gallery-collection', 'gallery-sort', 'gallery-sort-direction']) assert.equal(h.byId(id).disabled, true);
    pending.resolve(ready([item(99)])); await settle();
    assert.equal(h.cards.length, 0); assert.equal(h.byId('result-summary').textContent, '');
  }
});


function chooseRating(h: ReturnType<typeof harness>, value: string): void {
  h.byId('details-rating-input').value = value; h.byId('details-rating-input').fire('change');
}

test('rating editor labels five stars as Favourite and saves only an explicit rating choice', async () => {
  const h = harness(); await selectFirst(h);
  assert.match(html, /for="details-rating-input">Rating/); assert.match(html, /5 stars · Favourite/);
  assert.match(html, /Five-star videos appear in Favourites/);
  assert.equal(h.byId('details-rating-input').value, '4'); assert.equal(h.byId('details-rating-editor').hidden, false);
  assert.equal(h.byId('save-details').disabled, true);
  chooseRating(h, '5');
  assert.equal(h.byId('save-details').disabled, false); assert.equal(h.byId('discard-details').disabled, false);
  assert.deepEqual(h.saves, [], 'Rating never autosaves');
  h.byId('save-details').fire('click'); await settle(); await settle();
  assert.equal(h.saves[0].rating, 5); assert.equal(h.byId('details-rating-input').value, '5');
  assert.match(h.byId('details-rating').textContent, /Saved: 5 \/ 5 · Favourite/);
  assert.equal(h.byId('save-details').disabled, true);
  draftNotes(h, 'Only notes'); h.byId('save-details').fire('click'); await settle();
  assert.equal(Object.hasOwn(h.saves[1], 'rating'), false, 'Saved intent is cleared before later text-only edits');
});

test('untouched legacy ratings are omitted while an explicit choice can normalize a projected value', async () => {
  for (const [rating, favourite, choice] of [[1.75, false, ''], [5, false, ''], [5, true, '5'], [0, false, '0']] as const) {
    const h = harness({ detail: async () => detail(item(0, { rating, favourite })) }); await selectFirst(h);
    assert.equal(h.byId('details-rating-input').value, choice);
    if (!choice) assert.equal(h.byId('details-rating-existing').hidden, false);
    draftNotes(h, 'Leave legacy stars unchanged'); h.byId('save-details').fire('click'); await settle();
    assert.equal(Object.hasOwn(h.saves[0], 'rating'), false);
  }
  const h = harness({ detail: async () => detail(item(0, { rating: 5, favourite: false })) }); await selectFirst(h);
  chooseRating(h, '5'); h.byId('save-details').fire('click'); await settle();
  assert.equal(h.saves[0].rating, 5); assert.match(h.byId('details-rating').textContent, /Favourite/);
});

test('explicit rating choices including Unrated and choosing the original value remain deliberate save intent', async () => {
  for (const rating of ['0', '1', '2', '3', '4', '5']) {
    const h = harness(); await selectFirst(h); chooseRating(h, '5'); chooseRating(h, rating);
    assert.equal(h.byId('save-details').disabled, false);
    h.byId('save-details').fire('click'); await settle();
    assert.equal(h.saves[0].rating, Number(rating));
  }
});

test('rating-only drafts guard navigation, sorting, source changes and preview regeneration', async () => {
  const h = harness({ list: async request => ready([item(), item(1)], 100, request.offset) }); await selectFirst(h);
  chooseRating(h, '5');
  h.cards[1].fire('click'); h.byId('close-details').fire('click'); h.byId('next-page').fire('click');
  selectCollection(h, 'recent'); selectSort(h, 'rating'); h.byId('regenerate-previews').fire('click');
  assert.equal(h.selections.length, 1); assert.equal(h.requests.length, 1); assert.equal(h.generations.length, 0);
  assert.equal(h.byId('details-rating-input').value, '5'); assert.equal(h.byId('details-panel').hidden, false);
  await openSources(h); importButton(h).disabled = false; importButton(h).fire('click');
  h.byId('add-source-folder').disabled = false; h.byId('add-source-folder').fire('click'); await settle();
  assert.equal(h.videoImports.length, 0); assert.equal(h.sourceAdditions, 0);
  assert.match(h.byId('source-folders-status').textContent, /notes, tags and rating/);
});

test('discard restores the saved rating and clears rating intent before later text edits', async () => {
  const h = harness(); await selectFirst(h); chooseRating(h, '5');
  h.byId('discard-details').fire('click'); await settle(); await settle();
  assert.equal(h.byId('details-rating-input').value, '4'); assert.equal(h.byId('save-details').disabled, true);
  draftNotes(h, 'Notes after discard'); h.byId('save-details').fire('click'); await settle();
  assert.equal(Object.hasOwn(h.saves[0], 'rating'), false);
});

test('rating conflict and failed reload retain the draft until authoritative details are applied', async () => {
  let reload = 0;
  const h = harness({ save: async () => ({ status: 'conflict' }), detail: async () => ++reload === 2
    ? { status: 'unavailable' } : detail(item(0, { rating: reload > 2 ? 2 : 4 })) });
  await selectFirst(h); chooseRating(h, '5'); h.byId('save-details').fire('click'); await settle();
  assert.equal(h.byId('details-rating-input').value, '5'); assert.equal(h.byId('save-details').disabled, true);
  h.byId('discard-details').fire('click'); await settle();
  assert.equal(h.byId('details-rating-input').value, '5'); assert.match(h.byId('edit-status').textContent, /edits are still here/);
  h.byId('discard-details').fire('click'); await settle(); await settle();
  assert.equal(h.byId('details-rating-input').value, '2'); assert.equal(h.byId('save-details').disabled, true);
});

test('rating changes are blocked during composition, unsaved protection settings and admitted operations', async () => {
  for (const operation of ['composition', 'protection-draft', 'save', 'discard', 'regenerate', 'import', 'source', 'protection-save']) {
    const pending = deferred(); let reading = false;
    const h = harness({ save: () => pending.promise, detail: async () => reading ? pending.promise : detail(),
      regenerate: () => pending.promise, importVideo: () => pending.promise, connectSource: () => pending.promise,
      setProtection: () => pending.promise }); await selectFirst(h);
    if (operation === 'composition') h.byId('details-notes').fire('compositionstart');
    if (operation === 'save') { draftNotes(h); h.byId('save-details').fire('click'); }
    if (operation === 'discard') { draftNotes(h); reading = true; h.byId('discard-details').fire('click'); }
    if (operation === 'regenerate') h.byId('regenerate-previews').fire('click');
    if (operation === 'import' || operation === 'source') {
      await openSources(h);
      if (operation === 'import') importButton(h).fire('click');
      else h.byId('source-folders-list').children[0].querySelector('button')!.fire('click');
    }
    if (operation.startsWith('protection')) {
      h.byId('protection-button').fire('click'); await settle(); h.byId('auto-lock-minutes').value = '15';
      h.byId('auto-lock-minutes').fire('change');
      if (operation === 'protection-save') h.byId('save-protection').fire('click');
    }
    assert.equal(h.byId('details-rating-input').disabled, true, operation);
    chooseRating(h, '5'); assert.equal(h.byId('details-rating-input').value, '4', operation);
    if (operation === 'protection-draft') assert.equal(h.byId('auto-lock-minutes').value, '15');
    h.byId('lock-hub').fire('click'); pending.resolve({ status: 'unavailable' }); await settle();
    assert.equal(h.byId('details-rating-input').value, '');
  }
});

test('rating draft is immutable during a pending save and lock/pagehide discard late replies', async () => {
  for (const ending of ['save', 'lock', 'pagehide']) {
    const pending = deferred(); const h = harness({ save: () => pending.promise }); await selectFirst(h);
    chooseRating(h, '5'); h.byId('save-details').fire('click'); chooseRating(h, '2');
    assert.equal(h.saves[0].rating, 5); assert.equal(h.byId('details-rating-input').value, '5');
    if (ending === 'lock') h.byId('lock-hub').fire('click');
    if (ending === 'pagehide') h.window.fire('pagehide');
    pending.resolve({ status: 'saved', item: detail(item(0, { rating: 5, favourite: true })).item }); await settle(); await settle();
    assert.equal(h.byId('details-rating-input').value, ending === 'save' ? '5' : '');
    assert.equal(h.byId('details-rating-input').disabled, ending !== 'save');
    if (ending !== 'save') { assert.equal(h.byId('details-rating').textContent, ''); assert.equal(h.cards.length, 0); }
  }
});

test('saved rating refreshes Favourites and rating order without closing saved details', async () => {
  let current = 5;
  const h = harness({ detail: async () => detail(item(0, { rating: current, favourite: current === 5 })),
    list: async request => ready(request.collection === 'favourites' && current !== 5 ? [] : [item(0, { rating: current, favourite: current === 5 })]),
    save: async request => { current = request.rating!; return { status: 'saved', item: detail(item(0, { rating: current, favourite: current === 5 })).item }; } });
  await settle(); selectCollection(h, 'favourites'); await settle(); selectSort(h, 'rating'); await settle(); await selectFirst(h);
  chooseRating(h, '3'); h.byId('save-details').fire('click'); await settle(); await settle();
  assert.equal(h.cards.length, 0); assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('details-rating-input').value, '3'); assert.doesNotMatch(h.byId('details-rating').textContent, /Favourite/);
  assert.deepEqual(h.requests.at(-1), { query: '', offset: 0, collection: 'favourites', sort: 'rating', direction: 'desc' });
});

test('read-only and invalid rating inputs never add an edit intent', async () => {
  for (const invalid of ['', '6', '-1', '2.5', '05', '5\n', 'PRIVATE-RATING']) {
    const h = harness(); await selectFirst(h); chooseRating(h, invalid);
    assert.equal(h.byId('details-rating-input').value, '4'); assert.equal(h.byId('save-details').disabled, true);
    draftNotes(h, 'Only notes'); h.byId('save-details').fire('click'); await settle();
    assert.equal(Object.hasOwn(h.saves[0], 'rating'), false);
  }
  const h = harness({ detail: async () => detail(item(), { editable: false }) }); await selectFirst(h);
  assert.equal(h.byId('details-rating-editor').hidden, true); assert.equal(h.byId('details-rating-input').disabled, true);
  chooseRating(h, '5'); assert.equal(h.byId('details-rating-input').value, '4'); assert.equal(h.saves.length, 0);
});


function scanButton(h: ReturnType<typeof harness>): ElementStub {
  return h.byId('source-folders-list').children[0].querySelector('[data-action="scan-source"]')!;
}

test('Find new videos is an explicit path-free source action and opening the panel never scans', async () => {
  const h = harness(); await openSources(h);
  assert.equal(scanButton(h).textContent, 'Find new videos…');
  assert.equal(scanButton(h).getAttribute('aria-label'), 'Find new videos in Source folder 1');
  assert.equal(scanButton(h).getAttribute('aria-describedby'), 'source-scan-help');
  assert.match(html, /Find new videos skips links and ignored folders. Review up to 100 new videos before importing/);
  assert.match(html, /Saves a location without adding videos/);
  assert.deepEqual(h.sourceScans, []); assert.deepEqual(h.videoImports, []);
  assert.ok(h.created.every(element => [...element.attributes.values()].every(value => !value.includes(sourceFolder().id))));
  const unavailable = harness({ scanAvailable: false }); await openSources(unavailable);
  assert.equal(scanButton(unavailable).disabled, true); assert.equal(importButton(unavailable).disabled, false);
});

test('reviewed discovery uses the shared cancellable import workflow and keeps existing Add videos separate', async () => {
  const scan = deferred(); const h = harness({ scanSource: () => scan.promise,
    importProgress: async () => ({ status: 'running', total: 3, processed: 1, imported: 1, duplicates: 0, failed: 0 }) });
  await selectFirst(h); await openSources(h); h.byId('play-original').fire('click'); await settle();
  scanButton(h).fire('click');
  assert.deepEqual(h.sourceScans, [sourceFolder().id]); assert.deepEqual(h.videoImports, []);
  assert.match(h.byId('source-folders-status').textContent, /Finding new videos.*Review the import before it begins/);
  assert.equal(h.originalStops, 1); assert.equal(h.byId('preview-video').src, '');
  assert.equal(h.byId('cancel-video-import').hidden, false); assert.equal(h.focused, h.byId('cancel-video-import'));
  assert.match(h.byId('cancel-video-import').getAttribute('aria-label')!, /finding or importing/);
  assert.equal(h.byId('cancel-source-connection').hidden, true);
  assert.ok(h.byId('source-folders-list').children[0].querySelectorAll('button').every(button => button.disabled));
  assert.equal(h.byId('gallery-collection').disabled, true); assert.equal(h.byId('details-rating-input').disabled, true);
  await h.runTimer(); assert.match(h.byId('source-folders-status').textContent, /1 of 3 processed/);
  h.byId('cancel-source-connection').fire('click'); assert.equal(h.sourceCancellations, 0);
  h.byId('cancel-video-import').fire('click'); h.byId('cancel-video-import').fire('click');
  assert.equal(h.importCancellations, 1); assert.equal(h.timers, 0);
  assert.match(h.byId('source-folders-status').textContent, /Stopping the scan or import.*confirmation.*already being saved may finish/);
  scan.resolve(batchResult({ outcome: 'cancelled', total: 3 })); await settle(); await settle();
  assert.match(h.byId('source-folders-status').textContent, /1 added.*2 not processed/);
  assert.equal(h.byId('cancel-video-import').hidden, true); assert.equal(h.focused, scanButton(h));
  assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2);
  importButton(h).fire('click'); await settle(); await settle();
  assert.equal(h.videoImports.length, 1); assert.equal(h.sourceScans.length, 1);
});

test('scan status messages strip native diagnostics, distinguish empty and safety limits and refresh authoritative state', async () => {
  for (const status of ['nothing-new', 'scan-limit', 'cancelled', 'conflict', 'invalid', 'source-unavailable', 'wrong-folder', 'busy', 'unavailable', '__proto__']) {
    const h = harness({ scanSource: async () => ({ status, paths: ['/PRIVATE-SCAN'], message: 'PRIVATE-SCAN' }) });
    await selectFirst(h); await openSources(h); scanButton(h).fire('click'); await settle(); await settle();
    const message = h.byId('source-folders-status').textContent;
    assert.doesNotMatch(message, /PRIVATE-SCAN|object Object|function/);
    assert.equal(h.requests.length, 2); assert.equal(h.sourceReads, 2); assert.equal(h.timers, 0);
    assert.equal(scanButton(h).disabled, false); assert.equal(h.byId('details-panel').hidden, true);
    if (status === 'nothing-new') assert.equal(message, 'No new videos found.');
    if (status === 'scan-limit') assert.match(message, /safety limit.*Add videos… to select files/);
    if (status === 'wrong-folder') assert.match(message, /Find new videos again.*saved folder/);
  }
});

test('scan refreshes opaque source IDs after completion and ignores retired row closures', async () => {
  let scanned = false; const replacement = 'e'.repeat(32);
  const h = harness({ scanSource: async () => { scanned = true; return batchResult(); }, sources: async () => ({ status: 'ready',
    items: [sourceFolder(1, { id: scanned ? replacement : sourceFolder().id })] }) });
  await openSources(h); const original = scanButton(h); original.fire('click'); await settle(); await settle();
  original.disabled = false; original.fire('click'); assert.equal(h.sourceScans.length, 1);
  scanButton(h).fire('click'); await settle(); await settle();
  assert.deepEqual(h.sourceScans, [sourceFolder().id, replacement]);
});

test('notes, tags, ratings and composition drafts prevent scanning without erasing edits', async () => {
  for (const draft of ['notes', 'tags', 'rating', 'composition']) {
    const h = harness(); await selectFirst(h); await openSources(h);
    if (draft === 'notes') draftNotes(h, 'PRIVATE-DRAFT');
    if (draft === 'tags') draftTag(h, 'PRIVATE-TAG');
    if (draft === 'rating') chooseRating(h, '5');
    if (draft === 'composition') h.byId('details-notes').fire('compositionstart');
    const notes = h.byId('details-notes').value; const tags = h.byId('tag-draft').value; const rating = h.byId('details-rating-input').value;
    assert.equal(scanButton(h).disabled, true); scanButton(h).disabled = false; scanButton(h).fire('click'); await settle();
    assert.deepEqual(h.sourceScans, []); assert.equal(h.requests.length, 1);
    assert.equal(h.byId('details-notes').value, notes); assert.equal(h.byId('tag-draft').value, tags); assert.equal(h.byId('details-rating-input').value, rating);
    assert.match(h.byId('source-folders-status').textContent, /Save or discard.*notes, tags and rating/);
  }
});

test('scan and progress cannot repaint after lock, pagehide or a cancelled scan replaced by Add videos', async () => {
  for (const action of ['lock', 'pagehide', 'replace']) {
    const pending = deferred(); const progress = deferred(); const replacement = deferred();
    const h = harness({ scanSource: () => pending.promise, importProgress: () => progress.promise, importVideo: () => replacement.promise });
    await openSources(h); scanButton(h).fire('click'); await h.runTimer();
    if (action === 'lock') h.byId('lock-hub').fire('click');
    if (action === 'pagehide') h.window.fire('pagehide');
    if (action === 'replace') h.byId('cancel-video-import').fire('click');
    pending.resolve({ status: 'cancelled' }); await settle(); await settle();
    if (action === 'replace') importButton(h).fire('click');
    const before = h.byId('source-folders-status').textContent;
    progress.resolve({ status: 'running', total: 100, processed: 99, imported: 99, duplicates: 0, failed: 0 }); await settle();
    assert.equal(h.byId('source-folders-status').textContent, before);
    if (action === 'replace') { replacement.resolve(batchResult()); await settle(); await settle(); }
    else { assert.equal(h.byId('source-folders-list').children.length, 0); assert.equal(h.requests.length, 1); }
    assert.equal(h.timers, 0);
  }
});

test('scan rejection and cancellation exceptions stay generic and leave Lock available', async () => {
  const rejected = harness({ scanSource: async () => { throw new Error('/PRIVATE-SCAN'); } });
  await openSources(rejected); scanButton(rejected).fire('click'); await settle(); await settle();
  assert.doesNotMatch(rejected.byId('source-folders-status').textContent, /PRIVATE-SCAN/); assert.equal(rejected.timers, 0);
  const pending = deferred(); const h = harness({ scanSource: () => pending.promise, cancelImport: () => { throw new Error('/PRIVATE-SCAN'); } });
  await openSources(h); scanButton(h).fire('click'); h.byId('cancel-video-import').fire('click');
  assert.match(h.byId('source-folders-status').textContent, /scan or import could not be cancelled.*lock the hub/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-SCAN/);
  assert.equal(h.byId('lock-hub').disabled, false); h.byId('lock-hub').fire('click');
  pending.resolve(batchResult()); await settle(); assert.equal(h.timers, 0);
});

test('playback history protection stays unknown until read and saves explicit On and Off choices', async () => {
  const pending = deferred();
  const h = harness({ protection: async () => pending.promise }); await settle();
  h.byId('protection-button').fire('click');
  const choice = h.byId('record-playback-history');
  assert.equal(choice.value, ''); assert.equal(choice.disabled, true);
  pending.resolve({ status: 'ready', autoLockMinutes: 5, recordPlaybackHistory: false }); await settle();
  assert.equal(choice.value, 'off'); assert.equal(choice.disabled, false);
  choice.value = 'on'; choice.fire('change');
  assert.equal(h.protectionSaves.length, 0);
  h.byId('save-protection').fire('click'); await settle();
  assert.deepEqual(h.protectionSaves, [{ autoLockMinutes: 5, recordPlaybackHistory: true }]);
  assert.equal(h.byId('save-protection').disabled, true);
  choice.value = 'off'; choice.fire('change'); h.byId('save-protection').fire('click'); await settle();
  assert.deepEqual(h.protectionSaves.at(-1), { autoLockMinutes: 5, recordPlaybackHistory: false });
  assert.match(html, /Turning this off keeps existing history/);
  assert.match(html, /Previews do not count/);
});

test('saving auto-lock retains the enabled history setting', async () => {
  const h = harness({ protection: async () => ({ status: 'ready', autoLockMinutes: 5, recordPlaybackHistory: true }) });
  await settle(); h.byId('protection-button').fire('click'); await settle();
  assert.equal(h.byId('record-playback-history').value, 'on');
  h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
  h.byId('save-protection').fire('click'); await settle();
  assert.deepEqual(h.protectionSaves, [{ autoLockMinutes: 15, recordPlaybackHistory: true }]);
});

test('malformed history protection reads and save confirmations never guess or erase the choice', async () => {
  for (const value of [null, 'true', 1, {}, []]) {
    const h = harness({ protection: async () => ({ status: 'ready', autoLockMinutes: 5, recordPlaybackHistory: value }) });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    assert.equal(h.byId('record-playback-history').value, '');
    assert.equal(h.byId('record-playback-history').disabled, true);
    assert.equal(h.byId('save-protection').disabled, true);
  }
  for (const value of [undefined, false, 'true']) {
    const h = harness({ setProtection: async () => ({ status: 'saved', autoLockMinutes: 5, recordPlaybackHistory: value }) });
    await settle(); h.byId('protection-button').fire('click'); await settle();
    h.byId('record-playback-history').value = 'on'; h.byId('record-playback-history').fire('change');
    h.byId('save-protection').fire('click'); await settle();
    assert.equal(h.byId('record-playback-history').value, 'on');
    assert.equal(h.byId('save-protection').disabled, false);
    assert.match(h.byId('protection-status').textContent, /could not be saved/);
  }
});

test('unsaved history choice guards browsing and credential actions like auto-lock', async () => {
  const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }) });
  await selectFirst(h); h.byId('protection-button').fire('click'); await settle();
  h.byId('record-playback-history').value = 'on'; h.byId('record-playback-history').fire('change');
  for (const id of ['gallery-collection', 'gallery-sort', 'gallery-sort-direction', 'details-rating-input']) {
    assert.equal(h.byId(id).disabled, true, id);
  }
  h.byId('change-password-toggle').fire('click');
  assert.match(h.byId('password-status').textContent, /protection settings/);
  h.byId('unprotected-copy-toggle').fire('click');
  assert.match(h.byId('unprotected-copy-status').textContent, /protection settings/);
  h.byId('touch-id-toggle').fire('click');
  assert.equal(h.byId('touch-id-form').hidden, true);
  assert.equal(h.touchIdEnrollments.length, 0);
  h.byId('record-playback-history').value = 'off'; h.byId('record-playback-history').fire('change');
  assert.equal(h.byId('gallery-sort').disabled, false);
});

test('invalid history choices cannot dispatch protection saves', async () => {
  const h = harness(); await settle(); h.byId('protection-button').fire('click'); await settle();
  for (const value of ['', 'true', 'false', '0', 'ON', 'constructor']) {
    h.byId('record-playback-history').value = value; h.byId('record-playback-history').fire('change');
    assert.equal(h.byId('save-protection').disabled, true);
    h.byId('save-protection').fire('click');
  }
  assert.equal(h.protectionSaves.length, 0);
});

test('only the first trusted original playing event acknowledges history, including pause, seek and loops', async () => {
  const h = harness(); await selectFirst(h);
  h.byId('play-original').fire('click'); await settle();
  const video = h.byId('preview-video');
  assert.equal(h.playbackAcknowledgements.length, 0, 'Resolving play() is not a history event');
  video.onloadeddata!(); assert.equal(h.playbackAcknowledgements.length, 0);
  video.onplaying!({ isTrusted: false }); assert.equal(h.playbackAcknowledgements.length, 0);
  video.onplaying!({ isTrusted: true }); await settle();
  assert.deepEqual(h.playbackAcknowledgements, ['theatrum://app/original/' + 'b'.repeat(64)]);
  video.pause(); await video.play(); video.onplaying!({ isTrusted: true });
  video.fire('seeking'); video.fire('seeked'); video.onplaying!({ isTrusted: true });
  video.loop = true; video.onended!(); video.onplaying!({ isTrusted: true }); await settle();
  assert.equal(h.playbackAcknowledgements.length, 1);
  assert.equal(h.originalStops, 0);
  assert.equal(h.requests.length, 1);
});

test('previews, failed originals and absent history bridge do not acknowledge playback', async () => {
  const preview = harness(); await selectFirst(preview);
  preview.byId('play-preview').fire('click'); await settle();
  assert.equal(preview.byId('preview-video').onplaying, null);
  assert.equal(preview.playbackAcknowledgements.length, 0);
  for (const promiseRejects of [false, true]) {
    const h = harness(); await selectFirst(h); const video = h.byId('preview-video');
    if (promiseRejects) video.playResult = Promise.reject(new Error('PRIVATE'));
    h.byId('play-original').fire('click'); await settle();
    if (!promiseRejects) video.onerror!();
    assert.equal(h.playbackAcknowledgements.length, 0);
    assert.equal(video.onplaying, null);
  }
  const absent = harness({ historyAvailable: false }); await selectFirst(absent);
  absent.byId('play-original').fire('click'); await settle(); absent.byId('preview-video').onplaying!({ isTrusted: true });
  assert.equal(absent.playbackAcknowledgements.length, 0);
  assert.equal(absent.byId('preview-video').hidden, false);
});

test('old playing callbacks cannot acknowledge a retired or replaced original', async () => {
  const h = harness(); await selectFirst(h);
  h.byId('play-original').fire('click'); await settle();
  const video = h.byId('preview-video'); const old = video.onplaying!;
  h.byId('stop-video').fire('click'); assert.equal(video.onplaying, null);
  old({ isTrusted: true }); assert.equal(h.playbackAcknowledgements.length, 0);
  h.byId('play-original').fire('click'); await settle();
  old({ isTrusted: true }); assert.equal(h.playbackAcknowledgements.length, 0);
  video.onplaying!({ isTrusted: true }); await settle(); assert.equal(h.playbackAcknowledgements.length, 1);
});

test('history acknowledgement preserves every draft and excludes competing operations while Stop remains available', async () => {
  const pending = deferred();
  const h = harness({ ackOriginalPlayback: async () => pending.promise }); await selectFirst(h);
  draftNotes(h, 'Unsaved note'); draftTag(h, 'Pending tag'); chooseRating(h, '5');
  h.byId('play-original').fire('click'); await settle();
  h.byId('preview-video').onplaying!({ isTrusted: true });
  for (const id of ['save-details', 'discard-details', 'protection-button', 'source-folders-toggle', 'gallery-sort', 'gallery-search']) {
    assert.equal(h.byId(id).disabled, true, id);
  }
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('stop-video').disabled, false); assert.equal(h.byId('lock-hub').disabled, false);
  pending.resolve({ status: 'recorded' }); await settle();
  assert.equal(h.byId('details-notes').value, 'Unsaved note');
  assert.equal(h.byId('tag-draft').value, 'Pending tag');
  assert.equal(h.byId('details-rating-input').value, '5');
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.saves.length, 0); assert.equal(h.requests.length, 1);
  assert.equal(h.originalStops, 0);
});

for (const ending of ['stop', 'end']) {
  for (const settleBeforeStop of [false, true]) {
    test(`recorded history refreshes after ${ending}, preserving selection and drafts with ${settleBeforeStop ? 'early' : 'late'} completion`, async () => {
      const pending = deferred();
      const h = harness({ ackOriginalPlayback: async () => pending.promise,
        list: async () => ready([item(1), item(0)]) });
      await selectFirst(h);
      const selected = h.selections[0];
      draftNotes(h, 'Still editing'); draftTag(h, 'Pending'); chooseRating(h, '3');
      h.byId('play-original').fire('click'); await settle();
      const video = h.byId('preview-video'); video.onplaying!({ isTrusted: true });
      if (settleBeforeStop) { pending.resolve({ status: 'recorded' }); await settle(); }
      assert.equal(h.requests.length, 1);
      if (ending === 'stop') h.byId('stop-video').fire('click'); else video.onended!();
      assert.equal(h.originalStops, 1); assert.equal(video.src, '');
      if (!settleBeforeStop) {
        assert.equal(h.byId('save-details').disabled, true);
        h.byId('play-original').fire('click'); assert.equal(h.originalPlays.length, 1);
        pending.resolve({ status: 'recorded' }); await settle();
      }
      await settle(); assert.equal(h.requests.length, 2);
      assert.equal(h.byId('details-panel').hidden, false);
      assert.equal(h.byId('details-notes').value, 'Still editing');
      assert.equal(h.byId('tag-draft').value, 'Pending');
      assert.equal(h.byId('details-rating-input').value, '3');
      assert.equal(h.cards.filter(card => card.getAttribute('aria-pressed') === 'true').length, 1);
      h.byId('save-details').fire('click'); await settle();
      assert.equal(h.saves[0].id, selected); assert.equal(h.saves[0].revision, 'a'.repeat(32));
      assert.equal(h.saves[0].notes, 'Still editing'); assert.equal(h.saves[0].rating, 3);
      assert.deepEqual(h.saves[0].tags, ['Nature', 'Pending']);
    });
  }
}

for (const status of ['disabled', 'ignored', 'conflict', 'invalid', 'busy', 'unavailable', '__proto__']) {
  test(`history ${status} response uses fixed text and never replaces drafts or stops playback`, async () => {
    const h = harness({ ackOriginalPlayback: async () => ({ status, message: 'PRIVATE-PATH' }) });
    await selectFirst(h); draftNotes(h, 'Keep this note');
    h.byId('play-original').fire('click'); await settle(); h.byId('preview-video').onplaying!({ isTrusted: true }); await settle();
    assert.equal(h.byId('details-notes').value, 'Keep this note'); assert.equal(h.originalStops, 0);
    assert.doesNotMatch(h.byId('playback-status').textContent, /PRIVATE-PATH/);
    if (!['disabled', 'ignored'].includes(status)) assert.match(h.byId('playback-status').textContent, /history could not be saved/);
    h.byId('stop-video').fire('click'); await settle(); assert.equal(h.requests.length, 1);
  });
}

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} clears history setting, pending acknowledgement and rejects late successful refresh`, async () => {
    const pending = deferred();
    const h = harness({ ackOriginalPlayback: async () => pending.promise }); await selectFirst(h);
    h.byId('protection-button').fire('click'); await settle(); h.byId('close-protection').fire('click');
    draftNotes(h, 'Private draft'); h.byId('play-original').fire('click'); await settle();
    const video = h.byId('preview-video'); const playing = video.onplaying!; playing({ isTrusted: true });
    if (ending === 'lock') h.byId('lock-hub').fire('click'); else h.window.fire('pagehide');
    pending.resolve({ status: 'recorded' }); await settle(); playing({ isTrusted: true });
    assert.equal(h.playbackAcknowledgements.length, 1);
    assert.equal(h.byId('record-playback-history').value, '');
    assert.equal(h.byId('details-notes').value, ''); assert.equal(h.cards.length, 0);
    assert.equal(h.requests.length, 1); assert.equal(video.onplaying, null);
  });
}

test('a history failure remains visible when the original play promise resolves afterward', async () => {
  const playResult = deferred<void>();
  const h = harness({ ackOriginalPlayback: async () => ({ status: 'unavailable' }) }); await selectFirst(h);
  const video = h.byId('preview-video'); video.playResult = playResult.promise;
  h.byId('play-original').fire('click'); await settle();
  video.onplaying!({ isTrusted: true }); await settle();
  assert.match(h.byId('playback-status').textContent, /history could not be saved/);
  playResult.resolve(); await settle(); video.onloadeddata!();
  assert.match(h.byId('playback-status').textContent, /history could not be saved/);
  assert.equal(h.originalStops, 0);
});

test('history maintenance controls await loaded protection, explain scope and keep recording unchanged', async () => {
  const loading = deferred();
  const h = harness({ protection: async () => loading.promise }); await settle();
  for (const id of ['reset-last-played', 'reset-times-played']) { assert.equal(h.byId(id).disabled, true); }
  h.byId('protection-button').fire('click');
  for (const id of ['reset-last-played', 'reset-times-played']) { assert.equal(h.byId(id).disabled, true); }
  loading.resolve({ status: 'ready', autoLockMinutes: 5, recordPlaybackHistory: false }); await settle();
  for (const id of ['reset-last-played', 'reset-times-played']) { assert.equal(h.byId(id).disabled, false); }
  assert.match(html, /Reset one metric across this hub’s current catalogue/);
  assert.match(html, /Encrypted recovery backups and separate copies may retain earlier playback history/);
  assert.match(html, /id="playback-reset-status" role="status" aria-live="polite"/);
  assert.equal(h.byId('record-playback-history').value, 'off'); assert.equal(h.protectionSaves.length, 0);
  const unavailable = harness({ historyResetAvailable: false }); await settle();
  unavailable.byId('protection-button').fire('click'); await settle();
  assert.equal(unavailable.byId('reset-last-played').disabled, true);
  assert.equal(unavailable.byId('reset-times-played').disabled, true);
});

for (const [id, metric, label] of [['reset-last-played', 'lastPlayed', 'Last played'], ['reset-times-played', 'timesPlayed', 'Times played']]) {
  test(`${label} reset sends only its metric, clears retired selection and refreshes the existing catalogue view`, async () => {
    let reset = false;
    const h = harness({ protection: async () => ({ status: 'ready', autoLockMinutes: 15, recordPlaybackHistory: true }),
      list: async request => ready([item(reset ? 1 : 0)], 1, request.offset),
      resetPlaybackHistory: async () => { reset = true; return { status: 'reset', count: 2 }; } });
    await selectFirst(h);
    h.byId('gallery-sort').value = 'last-played'; h.byId('gallery-sort').fire('change'); await settle();
    h.cards[0].fire('click'); await settle();
    h.byId('gallery-search').value = 'Nature'; h.byId('gallery-search').fire('input');
    h.byId('protection-button').fire('click'); await settle();
    h.byId(id).fire('click'); await settle();
    assert.deepEqual(h.playbackResets, [metric]);
    assert.deepEqual(h.requests.at(-1), { query: 'Nature', offset: 0, collection: 'all', sort: 'last-played', direction: 'desc' });
    assert.equal(h.byId('gallery-search').value, 'Nature');
    assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.byId('details-notes').value, '');
    assert.ok(h.cards.every(card => card.getAttribute('aria-pressed') === 'false'));
    assert.equal(h.byId('protection-panel').hidden, false);
    assert.equal(h.byId('record-playback-history').value, 'on');
    assert.equal(h.byId('auto-lock-minutes').value, '15'); assert.equal(h.protectionSaves.length, 0);
    assert.equal(h.byId('playback-reset-status').textContent, `${label} reset for 2 catalogue entries. Playback recording is unchanged.`);
    h.byId('save-details').fire('click'); assert.equal(h.saves.length, 0, 'Old issued editor IDs cannot be saved');
    h.cards[0].fire('click'); await settle(); assert.equal(h.selections.at(-1), 'opaque-1');
  });
}

test('Last played reset empties Recently played while keeping collection, sorting and Protection visible', async () => {
  let reset = false;
  const h = harness({ list: async request => ready(reset && request.collection === 'recent' ? [] : [item()],
    reset && request.collection === 'recent' ? 0 : 1, request.offset),
  resetPlaybackHistory: async () => { reset = true; return { status: 'reset', count: 1 }; } });
  await settle(); h.byId('gallery-collection').value = 'recent'; h.byId('gallery-collection').fire('change'); await settle();
  h.byId('protection-button').fire('click'); await settle(); h.byId('reset-last-played').fire('click'); await settle();
  assert.equal(h.cards.length, 0); assert.equal(h.byId('empty-title').textContent, 'No recently played videos');
  assert.equal(h.byId('gallery-collection').value, 'recent'); assert.equal(h.byId('gallery-sort').value, 'last-played');
  assert.equal(h.byId('protection-panel').hidden, false);
  assert.match(h.byId('playback-reset-status').textContent, /reset for 1 catalogue entry/);
});

for (const status of ['cancelled', 'unchanged', 'busy', 'invalid', 'unavailable', '__proto__']) {
  test(`history reset ${status} clears retired IDs and refreshes without rendering arbitrary native fields`, async () => {
    const h = harness({ resetPlaybackHistory: async () => ({ status, message: '/PRIVATE/reset', count: 17 }) });
    await selectFirst(h); h.byId('protection-button').fire('click'); await settle();
    const requests = h.requests.length;
    h.byId('reset-times-played').fire('click'); await settle();
    assert.equal(h.requests.length, requests + 1); assert.equal(h.byId('details-panel').hidden, true);
    assert.equal(h.byId('protection-panel').hidden, false); assert.equal(h.protectionSaves.length, 0);
    assert.equal(h.byId('reset-last-played').disabled, false);
    const text = h.byId('playback-reset-status').textContent;
    assert.doesNotMatch(text, /PRIVATE|17/);
    if (status === 'cancelled') assert.equal(text, 'Reset cancelled. Playback history is unchanged.');
    else if (status === 'unchanged') assert.match(text, /No Times played values needed resetting/);
    else if (status === 'busy') assert.match(text, /hub is busy/);
    else assert.match(text, /reset could not be confirmed/);
  });
}

test('a rejected or malformed reset reply refreshes safely without claiming success', async () => {
  for (const response of [new Error('/PRIVATE/reset'), { status: 'reset', count: 0 }, { status: 'reset', count: 100_001 },
    { status: 'reset', count: '1' }, { status: 'reset', count: 0.5 }]) {
    const h = harness({ resetPlaybackHistory: async () => { if (response instanceof Error) throw response; return response; } });
    await selectFirst(h); h.byId('protection-button').fire('click'); await settle();
    h.byId('reset-last-played').fire('click'); await settle();
    assert.match(h.byId('playback-reset-status').textContent, /reset could not be confirmed/);
    assert.doesNotMatch(h.byId('playback-reset-status').textContent, /PRIVATE/);
    assert.equal(h.byId('details-panel').hidden, true); assert.equal(h.requests.length, 2);
  }
});

test('reset review serializes catalogue and protection operations while Lock remains immediately available', async () => {
  const pending = deferred();
  const h = harness({ resetPlaybackHistory: async () => pending.promise }); await selectFirst(h);
  h.byId('play-original').fire('click'); await settle();
  h.byId('protection-button').fire('click'); await settle();
  assert.equal(h.originalStops, 1); assert.equal(h.byId('preview-video').src, '');
  h.byId('reset-last-played').fire('click');
  assert.equal(h.byId('playback-reset-section').getAttribute('aria-busy'), 'true');
  assert.match(h.byId('playback-reset-status').textContent, /confirmation window/);
  for (const id of ['reset-last-played', 'reset-times-played', 'save-protection', 'close-protection', 'protection-button',
    'source-folders-toggle', 'gallery-search', 'gallery-sort', 'change-password-toggle', 'unprotected-copy-toggle']) {
    assert.equal(h.byId(id).disabled, true, id); h.byId(id).fire('click');
  }
  assert.equal(h.byId('details-notes').readOnly, true); assert.equal(h.byId('lock-hub').disabled, false);
  assert.deepEqual(h.playbackResets, ['lastPlayed']); assert.equal(h.requests.length, 1);
  pending.resolve({ status: 'cancelled' }); await settle();
  assert.equal(h.byId('playback-reset-section').getAttribute('aria-busy'), 'false');
  assert.equal(h.byId('reset-times-played').disabled, false);
});

for (const draft of ['notes', 'tags', 'rating']) {
  test(`${draft} drafts block resets and retain the selected video and text`, async () => {
    const h = harness(); await selectFirst(h);
    if (draft === 'notes') draftNotes(h, 'Unsaved notes');
    else if (draft === 'tags') draftTag(h, 'Unsaved tag');
    else chooseRating(h, '5');
    h.byId('protection-button').fire('click'); await settle();
    h.byId('reset-last-played').fire('click'); await settle();
    assert.equal(h.playbackResets.length, 0); assert.equal(h.requests.length, 1);
    assert.equal(h.byId('details-panel').hidden, false);
    assert.match(h.byId('playback-reset-status').textContent, /Save or discard your video notes, tags and rating/);
    if (draft === 'notes') assert.equal(h.byId('details-notes').value, 'Unsaved notes');
    if (draft === 'tags') assert.equal(h.byId('tag-draft').value, 'Unsaved tag');
    if (draft === 'rating') assert.equal(h.byId('details-rating-input').value, '5');
  });
}

test('unsaved protection choices, text composition and credential drafts block reset admission', async () => {
  for (const control of ['auto-lock-minutes', 'record-playback-history']) {
    const h = harness(); await selectFirst(h); h.byId('protection-button').fire('click'); await settle();
    h.byId(control).value = control === 'auto-lock-minutes' ? '15' : 'on'; h.byId(control).fire('change');
    h.byId('reset-times-played').fire('click');
    assert.equal(h.playbackResets.length, 0); assert.match(h.byId('playback-reset-status').textContent, /Save your protection settings/);
  }
  for (const input of ['details-notes', 'tag-draft', 'gallery-search']) {
    const h = harness(); await selectFirst(h); h.byId('protection-button').fire('click'); await settle();
    h.byId(input).fire('compositionstart'); h.byId('reset-last-played').fire('click');
    assert.equal(h.playbackResets.length, 0);
  }
  for (const form of ['password', 'copy', 'touch-id']) {
    const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }) });
    if (form === 'password') { await openPasswordForm(h); h.byId('current-password').value = 'Secret'; h.byId('current-password').fire('input'); }
    else if (form === 'copy') { await openCopyForm(h); h.byId('unprotected-copy-acknowledge').checked = true; h.byId('unprotected-copy-acknowledge').fire('change'); }
    else { await openTouchId(h); h.byId('touch-id-password').value = 'Secret'; h.byId('touch-id-password').fire('input'); }
    h.byId('reset-times-played').fire('click');
    assert.equal(h.playbackResets.length, 0); assert.match(h.byId('playback-reset-status').textContent, /Finish or close/);
    assert.equal(h.passwordChanges.length, 0); assert.equal(h.unprotectedCopies.length, 0); assert.equal(h.touchIdEnrollments.length, 0);
  }
});

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} erases pending reset feedback and rejects a late result without reloading`, async () => {
    const pending = deferred();
    const h = harness({ resetPlaybackHistory: async () => pending.promise }); await selectFirst(h);
    h.byId('protection-button').fire('click'); await settle(); h.byId('reset-last-played').fire('click');
    if (ending === 'lock') h.byId('lock-hub').fire('click'); else h.window.fire('pagehide');
    pending.resolve({ status: 'reset', count: 3 }); await settle();
    assert.equal(h.byId('playback-reset-status').textContent, '');
    assert.equal(h.byId('playback-reset-section').getAttribute('aria-busy'), 'false');
    assert.equal(h.cards.length, 0); assert.equal(h.byId('details-notes').value, '');
    assert.equal(h.byId('protection-panel').hidden, true); assert.equal(h.requests.length, 1);
    assert.equal(h.byId('reset-last-played').disabled, true); assert.equal(h.byId('reset-times-played').disabled, true);
  });
}


function sourceCheckResult(changes: Record<string, unknown> = {}): any {
  return { status: 'checked', total: 15, sameSize: 1, differentSize: 2, missing: 3, unverified: 4, ignored: 5, ...changes };
}
function sourceCheckButton(h: ReturnType<typeof harness>): ElementStub {
  return h.byId('source-folders-list').children[0].querySelector('[data-action="check-source"]')!;
}

test('saved-file check has an accessible compact action, ephemeral count report and no private paths', async () => {
  const h = harness({ checkSource: async () => sourceCheckResult({ path: '/PRIVATE-CHECK', filenames: ['PRIVATE-CHECK.mp4'] }) });
  await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
  assert.equal(sourceCheckButton(h).textContent, 'Check saved files…');
  assert.equal(sourceCheckButton(h).getAttribute('aria-label'), 'Check saved files in Source folder 1');
  assert.equal(sourceCheckButton(h).getAttribute('aria-describedby'), 'source-check-help');
  sourceCheckButton(h).fire('click'); await settle();
  assert.deepEqual(h.sourceChecks, [sourceFolder().id]);
  assert.equal(h.sourceReads, 2);
  const report = h.byId('source-folders-status').textContent;
  assert.match(report, /15 saved file locations/);
  for (const label of ['Same recorded size: 1', 'Different size: 2', 'Missing: 3', 'Not verified: 4', 'Ignored: 5']) {
    assert.ok(report.includes(label), label);
  }
  assert.match(report, /point-in-time.*same size does not prove.*unchanged or playable.*Ignored locations were not checked/s);
  assert.doesNotMatch(report, /PRIVATE-CHECK/);
  assert.equal(h.focused, sourceCheckButton(h));
  h.byId('refresh-source-folders').fire('click'); await settle();
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /Same recorded size/);
  sourceCheckButton(h).fire('click'); await settle();
  h.byId('close-source-folders').fire('click');
  assert.equal(h.byId('source-folders-status').textContent, '');
  assert.match(html, /id="source-check-help"[^>]*>Check saved files reads file metadata.*10,000 saved locations.*without opening video contents.*Results are not saved/);
  assert.match(readFileSync(path.join(galleryRoot, 'gallery.css'), 'utf8'), /#source-folders-status[^}]*white-space:\s*pre-line/);
  const unavailable = harness({ checkAvailable: false });
  await settle(); unavailable.byId('source-folders-toggle').fire('click'); await settle();
  assert.equal(sourceCheckButton(unavailable).disabled, true);
});

test('saved-file check preserves notes, tags, rating and selected revision while refreshing grant status', async () => {
  let connected = false;
  const h = harness({ sources: async () => ({ status: 'ready', items: [sourceFolder(1, { connected })] }),
    checkSource: async () => { connected = true; return sourceCheckResult(); } });
  await selectFirst(h);
  draftNotes(h, 'Draft notes'); draftTag(h, 'Draft tag');
  h.byId('details-rating-input').value = '2'; h.byId('details-rating-input').fire('change');
  h.byId('source-folders-toggle').fire('click'); await settle();
  const requests = h.requests.length;
  sourceCheckButton(h).fire('click'); await settle();
  assert.equal(h.byId('details-notes').value, 'Draft notes');
  assert.equal(h.byId('tag-draft').value, 'Draft tag');
  assert.equal(h.byId('details-rating-input').value, '2');
  assert.equal(h.byId('save-details').disabled, false);
  assert.equal(h.requests.length, requests, 'A metadata-only check must not reload the gallery');
  assert.equal(h.selections.length, 1);
  assert.equal(h.saves.length, 0);
  assert.match(h.byId('source-folders-list').textContent, /Connected for this session/);
  h.byId('save-details').fire('click'); await settle();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].revision, 'a'.repeat(32));
  assert.equal(h.saves[0].notes, 'Draft notes');
});

test('pending saved-file check blocks competing actions, preserves drafts and supports one Cancel check', async () => {
  const pending = deferred();
  const h = harness({ checkSource: () => pending.promise, list: async () => ready([item(), item(1)], 70) });
  await selectFirst(h); draftNotes(h, 'Draft');
  h.byId('source-folders-toggle').fire('click'); await settle();
  sourceCheckButton(h).fire('click');
  for (const id of ['source-folders-toggle', 'refresh-source-folders', 'close-source-folders', 'protection-button',
    'save-details', 'discard-details', 'regenerate-previews', 'play-preview', 'next-page', 'gallery-search']) {
    assert.equal(h.byId(id).disabled, true, id);
  }
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.byId('cancel-source-connection').textContent, 'Cancel check');
  h.cards[1].fire('click'); h.byId('close-details').fire('click'); h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.byId('source-folders-panel').hidden, false);
  assert.equal(h.selections.length, 1);
  h.byId('cancel-source-connection').fire('click'); h.byId('cancel-source-connection').fire('click');
  assert.equal(h.sourceCancellations, 1);
  assert.equal(h.byId('cancel-source-connection').disabled, true);
  pending.resolve(sourceCheckResult()); await settle();
  assert.match(h.byId('source-folders-status').textContent, /Check cancelled.*No results/);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /Same recorded size/);
  assert.equal(h.byId('details-notes').value, 'Draft');
  assert.equal(h.byId('save-details').disabled, false);
  assert.equal(sourceCheckButton(h).disabled, false);
});

for (const status of ['cancelled', 'conflict', 'invalid', 'limit', 'wrong-folder', 'source-unavailable', 'busy', 'unavailable']) {
  test(`saved-file check ${status} shows no partial counts or private error details`, async () => {
    const h = harness({ checkSource: async () => sourceCheckResult({ status, path: '/PRIVATE-CHECK', message: 'PRIVATE-CHECK' }) });
    await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
    sourceCheckButton(h).fire('click'); await settle();
    const report = h.byId('source-folders-status').textContent;
    assert.notEqual(report, ''); assert.doesNotMatch(report, /PRIVATE-CHECK|Same recorded size|15 saved file/);
    if (status === 'limit') { assert.match(report, /10,000 saved file locations.*No results/); }
    assert.equal(h.sourceReads, 2);
    assert.equal(sourceCheckButton(h).disabled, false);
  });
}

test('malformed saved-file counts fail closed without displaying a misleading partial report', async () => {
  for (const response of [null, Object.assign([], sourceCheckResult()), sourceCheckResult({ total: 16 }),
    sourceCheckResult({ missing: -1 }), sourceCheckResult({ sameSize: '1' }), sourceCheckResult({ total: 10_001 }),
    sourceCheckResult({ missing: 0.5 }), sourceCheckResult({ ignored: Infinity })]) {
    const h = harness({ checkSource: async () => response });
    await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
    sourceCheckButton(h).fire('click'); await settle();
    assert.match(h.byId('source-folders-status').textContent, /could not be checked.*No results/);
    assert.doesNotMatch(h.byId('source-folders-status').textContent, /Same recorded size/);
  }
});

test('source-check results and refreshed connections cannot return after lock or pagehide', async () => {
  for (const phase of ['check', 'refresh']) {
    const pending = deferred(); let reads = 0;
    const h = harness({ checkSource: phase === 'check' ? () => pending.promise : async () => sourceCheckResult(),
      sources: () => phase === 'refresh' && ++reads > 1 ? pending.promise : Promise.resolve({ status: 'ready', items: [sourceFolder()] }) });
    await selectFirst(h); draftNotes(h, 'Draft');
    h.byId('source-folders-toggle').fire('click'); await settle();
    sourceCheckButton(h).fire('click'); await settle();
    if (phase === 'check') { h.byId('lock-hub').fire('click'); } else { h.window.fire('pagehide'); }
    pending.resolve(phase === 'check' ? sourceCheckResult() : { status: 'ready', items: [sourceFolder(1, { connected: true })] }); await settle();
    assert.equal(h.byId('source-folders-panel').hidden, true);
    assert.equal(h.byId('source-folders-list').children.length, 0);
    assert.equal(h.byId('source-folders-status').textContent, '');
    assert.equal(h.byId('details-notes').value, '');
  }
});

test('saved-file checking preserves its result after a connection-refresh failure and exposes no exception', async () => {
  let reads = 0;
  const h = harness({ sources: async () => {
    if (++reads > 1) { throw new Error('/PRIVATE-CHECK'); }
    return { status: 'ready', items: [sourceFolder()] };
  } });
  await settle(); h.byId('source-folders-toggle').fire('click'); await settle();
  sourceCheckButton(h).fire('click'); await settle();
  assert.match(h.byId('source-folders-status').textContent, /Check complete.*Same recorded size.*Choose Refresh/s);
  assert.doesNotMatch(h.byId('source-folders-status').textContent, /PRIVATE-CHECK/);
  assert.equal(h.byId('source-folders-list').children.length, 0);
  assert.equal(h.focused, h.byId('refresh-source-folders'));
});

test('saved-file check waits for notes IME, search IME and unsaved Protection settings', async () => {
  for (const kind of ['notes', 'search', 'protection']) {
    const h = harness(); await selectFirst(h);
    if (kind === 'protection') {
      h.byId('protection-button').fire('click'); await settle();
      h.byId('auto-lock-minutes').value = '30'; h.byId('auto-lock-minutes').fire('change');
    }
    h.byId('source-folders-toggle').fire('click'); await settle();
    if (kind !== 'protection') { h.byId(kind === 'notes' ? 'details-notes' : 'gallery-search').fire('compositionstart'); }
    sourceCheckButton(h).fire('click'); await settle();
    assert.deepEqual(h.sourceChecks, []);
    if (kind === 'protection') { assert.match(h.byId('source-folders-status').textContent, /Save your protection settings/); }
  }
});


test('video refresh sends only selection authority and refreshes retired media without autoplay', async () => {
  const pending = deferred();
  const h = harness({ refreshVideo: async () => {
    assert.equal(h.byId('detail-poster').src, '', 'The old decoded image must retire before the asynchronous operation');
    assert.equal(h.byId('detail-poster').onload, null);
    assert.equal(h.byId('detail-poster').hidden, true);
    assert.equal(h.byId('detail-filmstrip').src, '', 'Video refresh retires the old filmstrip before the asynchronous operation');
    assert.equal(h.byId('detail-filmstrip').hidden, true);
    return pending.promise;
  } });
  await selectFirst(h);
  const oldThumbnail = h.images.find(image => image.src.includes('/thumbnails/'))!;
  oldThumbnail.onload!();
  const poster = h.byId('detail-poster');
  poster.onload!();
  h.byId('toggle-filmstrip').fire('click');
  const strip = h.byId('detail-filmstrip');
  const staleStripLoad = strip.onload!;
  h.byId('play-preview').fire('click'); await settle(); await settle();
  const video = h.byId('preview-video');
  h.byId('refresh-video').fire('click');
  assert.deepEqual(h.refreshes, [{ id: 'opaque-0', revision: 'a'.repeat(32) }]);
  assert.equal(video.src, '');
  assert.equal(video.hidden, true);
  assert.equal(poster.src, '');
  assert.equal(poster.hidden, true);
  assert.equal(h.byId('play-preview').disabled, true);
  const freshStripUrl = `theatrum://app/media/filmstrips/0.jpg?v=${'b'.repeat(32)}`;
  pending.resolve({ status: 'refreshed', item: detail(item(), { revision: 'b'.repeat(32), filmstripUrl: freshStripUrl, duration: 32, width: 640, height: 360 }).item });
  await settle(); await settle();
  assert.equal(oldThumbnail.src, '');
  assert.equal(oldThumbnail.isConnected, false);
  assert.ok(h.activeImages.some(image => image !== oldThumbnail && image.src === 'theatrum://app/media/thumbnails/0.jpg'));
  assert.equal(poster.starts.length, 2, 'The same no-store poster URL is requested again');
  assert.equal(video.src, '', 'A generated clip never starts until another explicit Play action');
  assert.equal(video.plays, 1);
  assert.equal(h.byId('generation-status').textContent, 'Video refreshed.');
  assert.equal(h.byId('refresh-video').disabled, false);
  assert.equal(h.byId('details-panel').hidden, false);
  assert.equal(h.byId('details-notes').value, 'Private notes');
  assert.equal(h.byId('details-facts').textContent, '0:32 · 640 × 360');
  assert.equal(strip.src, '', 'Video refresh does not automatically reload a filmstrip');
  h.byId('toggle-filmstrip').fire('click');
  assert.equal(strip.src, freshStripUrl);
  const freshStripLoad = strip.onload!;
  staleStripLoad();
  assert.equal(strip.hidden, true);
  assert.equal(strip.onload, freshStripLoad);
  freshStripLoad();
  assert.equal(strip.hidden, false);
});

test('a retired poster cannot finish during video refresh and recoverable failure reloads its original route', async () => {
  const pending = deferred();
  const h = harness({ refreshVideo: async () => pending.promise });
  await selectFirst(h);
  const poster = h.byId('detail-poster');
  const staleLoaded = poster.onload!;
  const staleError = poster.onerror!;
  h.byId('refresh-video').fire('click');
  assert.equal(poster.src, '');
  staleLoaded(); staleError();
  assert.equal(poster.hidden, true);
  assert.equal(poster.src, '');
  assert.equal(h.byId('detail-placeholder').hidden, false);
  assert.equal(h.timers, 0);
  pending.resolve({ status: 'source-unavailable' });
  await settle(); await settle();
  assert.equal(poster.starts.length, 2);
  assert.equal(poster.src, 'theatrum://app/media/clips/0.jpg');
  assert.equal(poster.hidden, true);
  poster.onload!();
  assert.equal(poster.hidden, false);
  assert.equal(h.byId('detail-placeholder').hidden, true);
  assert.equal(h.byId('preview-video').src, '');
});

test('native-picker cancellation followed by video refresh retires the same poster before each IPC request', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const h = harness({ refreshVideo: async () => {
    assert.equal(h.byId('detail-poster').src, '');
    assert.equal(h.byId('detail-poster').hidden, true);
    return ++calls === 1 ? first.promise : second.promise;
  } });
  await selectFirst(h);
  const poster = h.byId('detail-poster');
  poster.onload!();
  h.byId('refresh-video').fire('click');
  first.resolve({ status: 'cancelled' }); await settle(); await settle();
  assert.equal(poster.starts.length, 2);
  poster.onload!();
  assert.equal(poster.hidden, false);
  h.byId('refresh-video').fire('click');
  assert.equal(poster.src, '');
  second.resolve({ status: 'refreshed', item: detail(item(), { revision: 'c'.repeat(32) }).item });
  await settle(); await settle();
  assert.equal(poster.starts.length, 3);
  poster.onload!();
  assert.equal(poster.hidden, false);
  assert.equal(h.byId('generation-status').textContent, 'Video refreshed.');
});

test('video refresh freezes notes, tags, navigation and duplicate starts while Lock and Cancel stay available', async () => {
  const pending = deferred();
  const h = harness({ list: async () => ready([item(0), item(1)], 50), refreshVideo: async () => pending.promise });
  await selectFirst(h);
  h.byId('refresh-video').fire('click');
  h.byId('refresh-video').fire('click');
  h.cards[1].fire('click');
  h.byId('next-page').fire('click');
  h.byId('gallery-search').value = 'Another search'; h.byId('gallery-search').fire('input');
  h.byId('close-details').fire('click');
  h.byId('save-details').fire('click');
  h.byId('play-preview').fire('click');
  assert.equal(h.refreshes.length, 1);
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
  pending.resolve({ status: 'unavailable' }); await settle(); await settle();
  assert.equal(h.byId('details-notes').readOnly, false);
});

test('Cancel waits for drainage, then reloads metadata and previews even if publication may have occurred', async () => {
  const pending = deferred();
  let latest = false;
  const h = harness({ refreshVideo: async () => pending.promise,
    detail: async () => detail(item(), latest ? { revision: 'c'.repeat(32), notes: 'Latest stored notes' } : {}) });
  await selectFirst(h);
  const oldThumbnail = h.images.find(image => image.src.includes('/thumbnails/'))!;
  h.byId('refresh-video').fire('click');
  h.byId('cancel-regeneration').fire('click');
  h.byId('cancel-regeneration').fire('click');
  h.byId('close-details').fire('click');
  assert.equal(h.cancellations, 1);
  assert.equal(h.byId('cancel-regeneration').disabled, true);
  assert.equal(h.byId('details-notes').readOnly, true);
  assert.equal(h.selections.length, 1, 'No refresh starts until the outstanding operation finishes');
  latest = true;
  pending.resolve({ status: 'cancelled' }); await settle(); await settle();
  assert.equal(h.selections.length, 2);
  assert.equal(h.byId('details-notes').value, 'Latest stored notes');
  assert.equal(h.byId('generation-status').textContent, 'Video refresh stopped. Saved details and previews reloaded.');
  assert.equal(h.byId('details-notes').readOnly, false);
  assert.equal(h.byId('cancel-regeneration').hidden, true);
  assert.equal(oldThumbnail.src, '');
  assert.equal(h.byId('preview-video').src, '');
});

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} clears a running video refresh and ignores late success`, async () => {
    const pending = deferred();
    const h = harness({ refreshVideo: async () => pending.promise, lock: () => {
      assert.equal(h.cards.length, 0);
      assert.equal(h.byId('details-notes').value, '');
      assert.equal(h.byId('generation-status').textContent, '');
      assert.equal(h.byId('preview-video').src, '');
    } });
    await selectFirst(h);
    h.byId('refresh-video').fire('click');
    if (ending === 'lock') { h.byId('lock-hub').fire('click'); }
    else { h.window.fire('pagehide'); }
    pending.resolve({ status: 'refreshed', item: detail(item(), { notes: 'Never redraw private notes' }).item });
    await settle(); await settle();
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
  test(`${status} video refresh reports a generic recoverable status without source diagnostics`, async () => {
    const h = harness({ refreshVideo: async () => ({ status, sourcePath: '/secret/original.mp4', error: 'Private decoder stderr' }) });
    await selectFirst(h);
    h.byId('refresh-video').fire('click'); await settle(); await settle();
    assert.equal(h.byId('refresh-video').disabled, false);
    assert.equal(h.byId('details-notes').readOnly, false);
    assert.equal(h.byId('details-notes').value, 'Private notes');
    assert.equal(h.byId('cancel-regeneration').hidden, true);
    assert.ok(h.byId('generation-status').textContent.length > 0);
    assert.doesNotMatch(h.byId('generation-status').textContent, /secret|original\.mp4|stderr/);
  });
}

test('a video refresh conflict exposes reload even when the video metadata is read-only', async () => {
  let latest = false;
  const h = harness({ refreshVideo: async () => ({ status: 'conflict' }),
    detail: async () => detail(item(), { editable: false, revision: (latest ? 'b' : 'a').repeat(32) }) });
  await selectFirst(h);
  h.byId('refresh-video').fire('click'); await settle(); await settle();
  assert.equal(h.byId('refresh-video').disabled, true);
  assert.equal(h.byId('retry-details').hidden, false);
  assert.equal(h.byId('retry-details').textContent, 'Reload details');
  latest = true;
  h.byId('retry-details').fire('click'); await settle(); await settle();
  assert.equal(h.byId('retry-details').hidden, true);
  assert.equal(h.byId('refresh-video').disabled, false);
  assert.equal(h.byId('details-notes').readOnly, true);
  h.byId('refresh-video').fire('click'); await settle(); await settle();
  assert.equal(h.refreshes[1].revision, 'b'.repeat(32));
});

test('lock during cancellation refresh still suppresses late detail and media updates', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({ refreshVideo: async () => ({ status: 'cancelled' }),
    detail: async () => ++calls === 1 ? detail() : pending.promise });
  await selectFirst(h);
  h.byId('refresh-video').fire('click'); await settle(); await settle();
  assert.equal(h.selections.length, 2);
  assert.equal(h.byId('details-notes').readOnly, true);
  h.byId('lock-hub').fire('click');
  pending.resolve(detail(item(), { notes: 'Never display stale completion' })); await settle(); await settle();
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.byId('generation-status').textContent, '');
  assert.equal(h.requests.length, 1);
  assert.equal(h.activeImages.length, 0);
});



test('video refresh retains notes, tags and rating drafts and respects editor and search composition', async () => {
  for (const kind of ['notes', 'tag', 'rating', 'composition', 'search-composition']) {
    const h = harness(); await selectFirst(h);
    if (kind === 'notes') draftNotes(h);
    if (kind === 'tag') draftTag(h, 'Pending tag');
    if (kind === 'rating') { h.byId('details-rating-input').value = '5'; h.byId('details-rating-input').fire('change'); }
    if (kind === 'composition') h.byId('details-notes').fire('compositionstart');
    if (kind === 'search-composition') h.byId('gallery-search').fire('compositionstart');
    assert.equal(h.byId('refresh-video').disabled, true, kind);
    // An already-queued event is still checked by the handler itself.
    h.byId('refresh-video').disabled = false; h.byId('refresh-video').fire('click'); await settle(); await settle();
    assert.equal(h.refreshes.length, 0, kind); assert.equal(h.generations.length, 0, kind);
    if (kind === 'notes') assert.equal(h.byId('details-notes').value, 'Changed private notes');
    if (kind === 'tag') assert.equal(h.byId('tag-draft').value, 'Pending tag');
    if (kind === 'rating') assert.equal(h.byId('details-rating-input').value, '5');
    assert.equal(h.byId('details-panel').hidden, false);
  }
});

test('video refresh eligibility is independent of regeneration and requires an explicit backend grant', async () => {
  for (const { refreshable, available, regenerable } of [
    { refreshable: false, available: true, regenerable: true },
    { refreshable: undefined, available: true, regenerable: true },
    { refreshable: true, available: false, regenerable: true },
    { refreshable: true, available: true, regenerable: false },
  ]) {
    const h = harness({ refreshAvailable: available, detail: async () => detail(item(), { refreshable, regenerable }) });
    await selectFirst(h);
    assert.equal(h.byId('refresh-video').disabled, refreshable !== true || !available);
    assert.equal(h.byId('regenerate-previews').disabled, !regenerable);
    h.byId('refresh-video').fire('click'); await settle(); await settle();
    assert.equal(h.refreshes.length, refreshable === true && available ? 1 : 0);
    assert.equal(h.generations.length, 0);
    assert.equal(h.byId('details-notes').readOnly, false);
  }
  assert.match(html, /Update technical details and regenerate previews from the saved source\. Notes, tags and playback history stay unchanged\./);
});

test('unsaved protection and credential forms block video refresh without clearing their contents', async () => {
  for (const kind of ['protection', 'password', 'copy', 'touch-id']) {
    const h = harness({ touchIdStatus: async () => ({ outcome: 'available', state: 'disabled' }) });
    await selectFirst(h); h.byId('protection-button').fire('click'); await settle(); await settle();
    if (kind === 'protection') { h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change'); }
    if (kind === 'password') { h.byId('change-password-toggle').fire('click'); h.byId('current-password').value = 'retain'; h.byId('current-password').fire('input'); }
    if (kind === 'copy') { h.byId('unprotected-copy-toggle').fire('click'); h.byId('unprotected-copy-password').value = 'retain'; h.byId('unprotected-copy-password').fire('input'); }
    if (kind === 'touch-id') { h.byId('touch-id-toggle').fire('click'); h.byId('touch-id-password').value = 'retain'; h.byId('touch-id-password').fire('input'); }
    assert.equal(h.byId('refresh-video').disabled, true, kind);
    h.byId('refresh-video').disabled = false; h.byId('refresh-video').fire('click'); await settle(); await settle();
    assert.equal(h.refreshes.length, 0, kind);
    if (kind === 'protection') assert.equal(h.byId('auto-lock-minutes').value, '15');
    if (kind === 'password') assert.equal(h.byId('current-password').value, 'retain');
    if (kind === 'copy') assert.equal(h.byId('unprotected-copy-password').value, 'retain');
    if (kind === 'touch-id') assert.equal(h.byId('touch-id-password').value, 'retain');
  }
});

for (const status of ['cancelled', 'conflict', 'unavailable', 'invalid']) {
  test(`${status} video refresh clears retired row authority when saved details cannot be reloaded`, async () => {
    let selections = 0;
    const h = harness({ refreshVideo: async () => ({ status }),
      detail: async () => ++selections === 1 ? detail() : { status: 'unavailable' } });
    await selectFirst(h);
    const poster = h.byId('detail-poster'); poster.onload!();
    h.byId('refresh-video').fire('click'); await settle(); await settle();
    assert.equal(h.byId('details-panel').hidden, true);
    assert.equal(h.byId('details-notes').value, '');
    assert.equal(h.byId('details-facts').textContent, '');
    assert.equal(poster.src, ''); assert.equal(h.byId('detail-filmstrip').src, '');
    assert.equal(h.requests.length, 2);
    assert.match(h.byId('gallery-status').textContent, /Select the video again/);
    assert.equal(h.byId('refresh-video').disabled, true);
  });
}

test('an uncertain refresh failure reloads actual published metadata instead of restoring stale geometry', async () => {
  let selections = 0;
  const h = harness({ refreshVideo: async () => ({ status: 'unavailable' }),
    detail: async () => ++selections === 1 ? detail() : detail(item(), { width: 640, height: 360, revision: 'c'.repeat(32) }) });
  await selectFirst(h); h.byId('refresh-video').fire('click'); await settle(); await settle();
  assert.equal(h.selections.length, 2);
  assert.match(h.byId('details-facts').textContent, /640 × 360/);
  assert.equal(h.byId('details-notes').value, 'Private notes');
  assert.match(h.byId('generation-status').textContent, /could not be refreshed/);
  h.byId('refresh-video').fire('click'); await settle(); await settle();
  assert.equal(h.refreshes[1].revision, 'c'.repeat(32));
});

test('custom thumbnail preserves unsaved notes, tags, rating and unchanged previews while refreshing gallery media', async () => {
  const pending = deferred();
  const nextUrl = `theatrum://app/media/thumbnails/0.jpg?v=${'b'.repeat(32)}`;
  let updated = false;
  const h = harness({ list: async () => ready([item(0, updated ? { thumbnailUrl: nextUrl } : {})]),
    setCustomThumbnail: async () => pending.promise });
  await selectFirst(h);
  const oldThumbnail = h.images.find(image => image.src.includes('/thumbnails/'))!;
  oldThumbnail.onload!(); h.byId('detail-poster').onload!();
  h.byId('toggle-filmstrip').fire('click'); h.byId('detail-filmstrip').onload!();
  const strip = h.byId('detail-filmstrip').src, poster = h.byId('detail-poster').src;
  h.byId('details-notes').value = 'Unsaved notes'; h.byId('details-notes').fire('input');
  h.byId('tag-draft').value = 'Unsaved tag'; h.byId('tag-draft').fire('input');
  h.byId('details-rating-input').value = '5'; h.byId('details-rating-input').fire('change');
  h.byId('choose-thumbnail').fire('click');
  assert.deepEqual(h.thumbnailChanges, [{ id: 'opaque-0', revision: 'a'.repeat(32) }]);
  assert.equal(h.byId('details-notes').readOnly, true); assert.equal(h.byId('save-details').disabled, true);
  assert.equal(h.byId('cancel-regeneration').hidden, false);
  assert.equal(h.byId('choose-thumbnail').disabled, true);
  h.byId('choose-thumbnail').fire('click'); assert.equal(h.thumbnailChanges.length, 1);
  updated = true;
  pending.resolve({ status: 'updated', item: detail(item(0, { thumbnailUrl: nextUrl })).item });
  await settle(); await settle();
  assert.equal(h.byId('details-notes').value, 'Unsaved notes');
  assert.equal(h.byId('tag-draft').value, 'Unsaved tag'); assert.equal(h.byId('details-rating-input').value, '5');
  assert.equal(h.byId('detail-filmstrip').src, strip); assert.equal(h.byId('detail-poster').src, poster);
  assert.equal(oldThumbnail.src, ''); assert.equal(oldThumbnail.isConnected, false);
  assert.ok(h.activeImages.some(image => image.src === nextUrl));
  assert.equal(h.byId('generation-status').textContent, 'Thumbnail updated.');
  assert.equal(h.byId('save-details').disabled, false);
  h.byId('save-details').fire('click'); await settle();
  assert.equal(h.saves[0].revision, 'a'.repeat(32)); assert.equal(h.saves[0].notes, 'Unsaved notes');
  assert.deepEqual(h.saves[0].tags, ['Nature', 'Unsaved tag']); assert.equal(h.saves[0].rating, 5);
});

test('custom thumbnail cancellation waits for drainage and reconciles the saved thumbnail without replacing drafts', async () => {
  const pending = deferred();
  const nextUrl = `theatrum://app/media/thumbnails/0.jpg?v=${'c'.repeat(32)}`;
  let reads = 0;
  const h = harness({ setCustomThumbnail: async () => pending.promise,
    detail: async () => detail(item(0, ++reads > 1 ? { thumbnailUrl: nextUrl } : {})),
    list: async () => ready([item(0, reads > 1 ? { thumbnailUrl: nextUrl } : {})]) });
  await selectFirst(h);
  h.byId('details-notes').value = 'Keep draft'; h.byId('details-notes').fire('input');
  h.byId('choose-thumbnail').fire('click'); h.byId('cancel-regeneration').fire('click'); h.byId('cancel-regeneration').fire('click');
  assert.equal(h.cancellations, 1); assert.equal(h.selections.length, 1);
  assert.equal(h.byId('cancel-regeneration').disabled, true);
  pending.resolve({ status: 'cancelled' }); await settle(); await settle();
  assert.equal(h.byId('details-notes').value, 'Keep draft'); assert.equal(h.byId('save-details').disabled, false);
  assert.equal(h.byId('generation-status').textContent, 'Thumbnail selection stopped. Saved thumbnail reloaded.');
  assert.equal(h.byId('cancel-regeneration').hidden, true);
  assert.ok(h.activeImages.some(image => image.src === nextUrl));
});

for (const ending of ['lock', 'pagehide']) {
  test(`${ending} clears thumbnail import and suppresses late completion`, async () => {
    const pending = deferred(); const h = harness({ setCustomThumbnail: async () => pending.promise });
    await selectFirst(h); h.byId('choose-thumbnail').fire('click');
    if (ending === 'lock') h.byId('lock-hub').fire('click'); else h.window.fire('pagehide');
    pending.resolve({ status: 'updated', item: detail().item }); await settle(); await settle();
    assert.equal(h.byId('details-notes').value, ''); assert.equal(h.byId('generation-status').textContent, '');
    assert.equal(h.byId('cancel-regeneration').hidden, true); assert.equal(h.requests.length, 1);
  });
}

for (const response of ['conflict', 'unavailable', 'cancelled']) {
  test(`${response} thumbnail outcome preserves drafts and blocks stale edits when the stored revision changed`, async () => {
    let reads = 0;
    const h = harness({ setCustomThumbnail: async () => ({ status: response }),
      detail: async () => detail(item(), ++reads > 1 ? { revision: 'b'.repeat(32), notes: 'Newer saved notes' } : {}) });
    await selectFirst(h); h.byId('details-notes').value = 'Keep draft'; h.byId('details-notes').fire('input');
    h.byId('choose-thumbnail').fire('click'); await settle(); await settle();
    assert.equal(h.byId('details-notes').value, 'Keep draft'); assert.equal(h.byId('save-details').disabled, true);
    assert.equal(h.byId('choose-thumbnail').disabled, true); assert.equal(h.byId('discard-details').disabled, false);
    assert.match(h.byId('generation-status').textContent, /Your edits are still here/);
  });
}

for (const status of ['invalid', 'source-unavailable', 'busy', 'unavailable']) {
  test(`custom thumbnail ${status} reports only fixed diagnostics and preserves editing`, async () => {
    const h = harness({ setCustomThumbnail: async () => ({ status, path: '/private/image.jpg', error: 'private diagnostics' }) });
    await selectFirst(h); h.byId('choose-thumbnail').fire('click'); await settle(); await settle();
    assert.doesNotMatch(h.byId('generation-status').textContent, /private diagnostics|image\.jpg/);
    assert.equal(h.byId('choose-thumbnail').disabled, false); assert.equal(h.byId('cancel-regeneration').hidden, true);
  });
}

test('custom thumbnail requires explicit editability but no regenerable or playable source', async () => {
  for (const enabled of [true, false, undefined]) {
    const h = harness({ detail: async () => detail(item(), { thumbnailEditable: enabled, regenerable: false, playable: false }) });
    await selectFirst(h); assert.equal(h.byId('choose-thumbnail').disabled, enabled !== true);
    h.byId('choose-thumbnail').fire('click'); await settle(); await settle();
    assert.equal(h.thumbnailChanges.length, enabled === true ? 1 : 0);
  }
  const absent = harness({ thumbnailAvailable: false }); await selectFirst(absent);
  assert.equal(absent.byId('choose-thumbnail').disabled, true);
});

test('custom thumbnail helper explains format, encrypted storage and regeneration reset', () => {
  assert.match(html, /Choose a JPEG or PNG image up to 32 MiB and 32 megapixels/);
  assert.match(html, /without embedded metadata is encrypted in this hub/);
  assert.match(html, /Transparent areas use a black background/);
  assert.match(html, /Regenerating previews restores the generated thumbnail/);
});

test('custom thumbnail respects text composition and pending protection or credential drafts', async () => {
  for (const kind of ['notes-composition', 'search-composition', 'protection', 'password', 'copy']) {
    const h = harness(); await selectFirst(h);
    if (kind === 'notes-composition') h.byId('details-notes').fire('compositionstart');
    if (kind === 'search-composition') h.byId('gallery-search').fire('compositionstart');
    if (kind === 'protection') {
      h.byId('protection-button').fire('click'); await settle();
      h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
    }
    if (kind === 'password') { h.byId('protection-button').fire('click'); await settle(); await settle(); h.byId('change-password-toggle').fire('click'); h.byId('current-password').value = 'Unsubmitted'; h.byId('current-password').fire('input'); }
    if (kind === 'copy') { h.byId('protection-button').fire('click'); await settle(); await settle(); h.byId('unprotected-copy-toggle').fire('click'); h.byId('unprotected-copy-password').value = 'Unsubmitted'; h.byId('unprotected-copy-password').fire('input'); }
    // Recheck the event handler even if a stale button is accidentally enabled.
    h.byId('choose-thumbnail').disabled = false; h.byId('choose-thumbnail').fire('click'); await settle();
    assert.equal(h.thumbnailChanges.length, 0, kind);
  }
});


test('interrupted password recovery is an explicit secondary action using the existing masked fields', async () => {
  const h = harness(); await openPasswordForm(h);
  const button = html.match(/<button[^>]+id="resume-password-submit"[^>]*>/)![0];
  assert.match(button, /type="button"/);
  assert.match(button, /aria-describedby="password-recovery-help password-status"/);
  assert.match(html, /new password from that attempt/);
  assert.match(html, /confirm before finishing/);
  assert.equal(h.byId('resume-password-submit').disabled, false);
  fillPasswords(h); h.byId('change-password-form').fire('submit'); await settle();
  assert.equal(h.passwordChanges.length, 1);
  assert.equal(h.passwordResumptions.length, 0, 'Ordinary Enter/submit cannot resume a staged change implicitly.');
  const unavailable = harness({ resumeAvailable: false }); await openPasswordForm(unavailable);
  assert.equal(unavailable.byId('resume-password-submit').disabled, true);
  assert.equal(unavailable.byId('change-password-submit').disabled, false);
});

test('password recovery clears credentials before IPC, stops media and holds admission through native confirmation', async () => {
  const pending = deferred();
  const h = harness({ resumePasswordChange: request => {
    assertPasswordsCleared(h);
    assert.equal(h.byId('preview-video').src, '');
    assert.equal(request.currentPassword, '  old password  ');
    assert.equal(request.newPassword, '  attempted password  ');
    return pending.promise;
  } });
  await selectFirst(h); h.byId('play-preview').fire('click'); await settle();
  await openPasswordForm(h); fillPasswords(h, '  old password  ', '  attempted password  ');
  h.byId('resume-password-submit').fire('click');
  assert.equal(h.passwordResumptions.length, 1); assert.equal(h.passwordChanges.length, 0);
  assert.equal(h.byId('change-password-submit').disabled, true);
  assert.equal(h.byId('resume-password-submit').disabled, true);
  assert.equal(h.byId('save-protection').disabled, true);
  assert.equal(h.byId('lock-hub').disabled, false);
  assert.match(h.byId('password-status').textContent, /Confirm in the dialog/);
  h.byId('change-password-form').fire('submit');
  h.byId('resume-password-submit').fire('click');
  assert.equal(h.passwordResumptions.length + h.passwordChanges.length, 1);
  h.window.fire('blur'); assertPasswordsCleared(h);
  pending.resolve({ status: 'cancelled', path: '/private/untrusted', newPassword: 'DO-NOT-DISPLAY' }); await settle();
  assert.match(h.byId('password-status').textContent, /left unfinished.*unchanged/);
  assert.doesNotMatch(h.byId('password-status').textContent, /untrusted|DO-NOT-DISPLAY/);
  assert.equal(h.byId('resume-password-submit').disabled, false);
  assert.equal(h.byId('details-notes').value, 'Private notes');
  assert.equal(h.byId('preview-video').src, '');
});

test('password recovery validates both passwords and confirmation before invoking the bridge', async () => {
  for (const [current, replacement, confirmation] of [['', 'new', 'new'], ['old', '', ''],
    ['old', 'new', 'different'], ['same', 'same', 'same'], ['old', '\ud800', '\ud800']]) {
    const h = harness(); await openPasswordForm(h); fillPasswords(h, current, replacement, confirmation);
    h.byId('resume-password-submit').fire('click'); await settle();
    assertPasswordsCleared(h); assert.equal(h.passwordResumptions.length, 0);
    assert.ok(h.byId('password-status').textContent.length > 0);
  }
  const h = harness(); await openPasswordForm(h); fillPasswords(h);
  h.byId('new-password').fire('compositionstart'); h.byId('resume-password-submit').fire('click');
  assert.equal(h.passwordResumptions.length, 0);
});

test('password recovery gives fixed outcome guidance and never displays diagnostics', async () => {
  for (const [status, message] of [['not-found', /No interrupted password change/],
    ['incorrect-password', /current password or the password from the interrupted change/],
    ['invalid', /not accepted/], ['busy', /busy/], ['unavailable', /keep its files intact/], ['unknown', /keep its files intact/]] as const) {
    const h = harness({ resumePasswordChange: async () => ({ status, error: 'SECRET-DIAGNOSTICS', path: '/private/hidden' }) });
    await openPasswordForm(h); fillPasswords(h); h.byId('resume-password-submit').fire('click'); await settle();
    assertPasswordsCleared(h); assert.match(h.byId('password-status').textContent, message);
    assert.doesNotMatch(h.byId('password-status').textContent, /SECRET-DIAGNOSTICS|private|hidden/);
    assert.equal(h.lockCalls, 0);
  }
});

test('password recovery refuses video and protection drafts without discarding them', async () => {
  const h = harness(); await selectFirst(h); await openPasswordForm(h);
  h.byId('details-notes').value = 'Unsaved private draft'; h.byId('details-notes').fire('input');
  assert.equal(h.byId('resume-password-submit').disabled, true);
  h.byId('resume-password-submit').fire('click'); assert.equal(h.passwordResumptions.length, 0);
  assert.equal(h.byId('details-notes').value, 'Unsaved private draft');
  h.byId('discard-details').fire('click');
  h.byId('auto-lock-minutes').value = '15'; h.byId('auto-lock-minutes').fire('change');
  assert.equal(h.byId('resume-password-submit').disabled, true);
  assert.equal(h.passwordResumptions.length, 0);
});

test('pending recovery remains gated when concealed and a late reply cannot restore locked content', async () => {
  for (const end of ['conceal', 'lock']) {
    const pending = deferred(); const h = harness({ resumePasswordChange: async () => pending.promise });
    await selectFirst(h); await openPasswordForm(h); fillPasswords(h);
    h.byId('resume-password-submit').fire('click');
    h.byId(end === 'lock' ? 'lock-hub' : 'close-protection').fire('click');
    assertPasswordsCleared(h);
    assert.equal(h.byId('protection-button').disabled, true);
    pending.resolve({ status: 'cancelled' }); await settle();
    assert.equal(h.byId('change-password-form').hidden, true);
    assert.equal(h.byId('password-status').textContent, '');
    if (end === 'lock') { assert.equal(h.cards.length, 0); assert.equal(h.byId('details-notes').value, ''); }
  }
});

test('successful resumed password change clears sensitive gallery content without awaiting renderer locking', async () => {
  const h = harness({ resumePasswordChange: async () => ({ status: 'changed' }) });
  await selectFirst(h); await openPasswordForm(h); fillPasswords(h);
  h.byId('resume-password-submit').fire('click'); await settle();
  assertPasswordsCleared(h); assert.equal(h.cards.length, 0);
  assert.equal(h.byId('details-notes').value, '');
  assert.equal(h.byId('resume-password-submit').disabled, true);
});
