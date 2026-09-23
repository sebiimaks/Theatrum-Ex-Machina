import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = path.resolve(__dirname, '../private-conversion');
const source = readFileSync(path.join(root, 'conversion.js'), 'utf8');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'conversion.css'), 'utf8');

// Executes the real isolated-page script. Native acceptance separately checks
// Chromium focus, clipboard command routing and the window's preload policy.
interface StubEvent {
  type: string;
  target: ElementStub;
  defaultPrevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
  [key: string]: unknown;
}

class ElementStub {
  value: string | number = '';
  max = 1;
  checked = false;
  type = '';
  textContent = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: StubEvent) => void)[]>();
  captures = new Map<string, boolean[]>();
  onFocus = (_element: ElementStub) => undefined;
  focus(): void { this.onFocus(this); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, handler: (event: StubEvent) => void, capture = false): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]);
    this.captures.set(name, [...this.captures.get(name) ?? [], capture]);
  }
  fire(name: string, properties: Record<string, unknown> = {}): StubEvent {
    const event: StubEvent = { type: name, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...properties };
    if (!(name === 'click' && this.disabled)) {
      for (const handler of this.listeners.get(name) ?? []) handler(event);
    }
    return event;
  }
}

const review = { videos: 3, availablePreviews: 11, previewBytes: 1024 * 1024 + 12,
  missingPreviews: { thumbnail: 0, filmstrip: 0, 'clip-poster': 0, clip: 0 } };
function state(phase = 'review', changes: Record<string, unknown> = {}) {
  return { phase, review, completed: 0, total: 0, ...changes };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness(options: {
  initialState?: unknown;
  getState?: () => Promise<unknown>;
  submit?: (password: string, allowMissing: boolean, acknowledgeOriginals: boolean) => Promise<unknown>;
  cancel?: () => void;
  bridge?: boolean;
} = {}) {
  const document = new ElementStub();
  const window = new ElementStub();
  const elements = new Map<string, ElementStub>();
  let activeElement: ElementStub | undefined;
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new ElementStub();
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    element.type = /\btype="([^"]+)"/.exec(match[2])?.[1] ?? '';
    element.onFocus = value => { activeElement = value; };
    elements.set(match[3], element);
  }
  let currentState = options.initialState ?? state();
  let reads = 0;
  let cancellations = 0;
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  const submissions: { password: string; allowMissing: boolean; acknowledgeOriginals: boolean }[] = [];
  const bridge = {
    getState: () => { reads++; return options.getState?.() ?? Promise.resolve(currentState); },
    submit: (password: string, allowMissing: boolean, acknowledgeOriginals: boolean) => {
      submissions.push({ password, allowMissing, acknowledgeOriginals });
      return options.submit?.(password, allowMissing, acknowledgeOriginals) ?? Promise.resolve(true);
    },
    cancel: () => { cancellations++; options.cancel?.(); },
  };
  runInNewContext(source, {
    document: Object.assign(document, { getElementById: (id: string) => {
      assert.ok(elements.has(id), `Unknown control ${id}`); return elements.get(id);
    } }),
    window: Object.assign(window, { privateConversion: options.bridge === false ? undefined : bridge }),
    navigator: Object.defineProperty({}, 'clipboard', { get() { throw new Error('No clipboard access'); } }),
    localStorage: new Proxy({}, { get() { throw new Error('No persistence'); } }),
    fetch: () => { throw new Error('No network'); },
    setTimeout: (callback: () => unknown, delay: number) => {
      const id = ++nextTimer; timers.set(id, { callback, delay }); return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  }, { filename: path.join(root, 'conversion.js') });
  const byId = (id: string) => elements.get(id)!;
  return { document, window, elements, byId, submissions, timers,
    setState(value: unknown) { currentState = value; },
    get reads() { return reads; }, get cancellations() { return cancellations; },
    tick() {
      assert.equal(timers.size, 1, 'Only one bounded poll may be scheduled');
      const [id, timer] = [...timers][0];
      assert.ok(timer.delay >= 300 && timer.delay <= 500);
      timers.delete(id); timer.callback();
    },
  };
}
function fill(h: ReturnType<typeof harness>, password = '  Synthetic 🐦 password  '): void {
  h.byId('password').value = password;
  h.byId('confirm-password').value = password;
  h.byId('acknowledge-originals').checked = true;
}

test('failure categories provide static recovery directions and retain the originals notice', async () => {
  const expected = {
    'destination-unavailable': /selected folder could not be used/,
    'destination-exists': /already exists/,
    'permission-denied': /Access was denied/,
    'storage-full': /insufficient free space/,
    'files-unavailable': /no longer available/,
    'source-inspection-failed': /could not be checked/,
    'source-changed': /changed after review/,
    'storage-initialization-failed': /storage could not be initialized/,
    'catalogue-encryption-failed': /catalogue could not be encrypted/,
    'preview-copy-failed': /preview could not be copied/,
    'verification-failed': /could not be verified/,
    'receipt-failed': /could not be marked complete/,
    'conversion-failed': /could not be completed/,
  };
  for (const [failure, message] of Object.entries(expected)) {
    const h = harness({ initialState: state('failed', { failure, message: '/PRIVATE/SECRET', completed: 1, total: 2 }) });
    await settle();
    const text = h.byId('conversion-status').textContent;
    assert.match(text, message); assert.match(text, /partial encrypted copy may remain; the originals are unchanged/);
    assert.doesNotMatch(text, /PRIVATE|SECRET/);
    assert.equal(h.byId('cancel').textContent, 'Close');
    fill(h); h.byId('conversion-form').fire('submit'); assert.equal(h.submissions.length, 0);
  }
  for (const failure of [undefined, '/PRIVATE/SECRET', '__proto__']) {
    const h = harness({ initialState: state('failed', { failure }) }); await settle();
    assert.match(h.byId('conversion-status').textContent, /could not be completed/);
    assert.doesNotMatch(h.byId('conversion-status').textContent, /PRIVATE|SECRET|object Object/);
  }
});

test('conversion review displays counts and conditional missing consent without source metadata', async () => {
  const missing = { thumbnail: 1, filmstrip: 2, 'clip-poster': 3, clip: 4 };
  for (const missingPreviews of [review.missingPreviews, missing]) {
    const h = harness({ initialState: state('review', { review: { ...review, missingPreviews,
      path: '/PRIVATE/SOURCE', notes: 'PRIVATE NOTE' } }) });
    assert.equal(h.byId('create-copy').disabled, true);
    await settle();
    assert.equal(h.byId('video-count').textContent, '3');
    assert.equal(h.byId('preview-count').textContent, '11');
    assert.equal(h.byId('preview-size').textContent, '1.0 MiB');
    assert.equal(h.byId('missing-review').hidden, missingPreviews !== missing);
    assert.equal(h.byId('missing-consent').hidden, missingPreviews !== missing);
    for (const kind of Object.keys(missing)) assert.equal(h.byId(`missing-${kind}`).textContent, String(missingPreviews[kind]));
    for (const element of h.elements.values()) assert.doesNotMatch(element.textContent, /PRIVATE/);
    assert.equal(h.byId('create-copy').disabled, false);
    assert.equal(h.timers.size, 0, 'An idle review needs no periodic polling');
  }
  assert.match(html, /original catalogue, previews, backups and source videos remain unencrypted/);
  assert.match(html, /separate copy and does not automatically delete or protect the originals/);
});

test('unavailable or malformed review closes safely and never exposes returned errors', async () => {
  const invalid = [null, {}, state('/PRIVATE/PHASE'), state('review', { completed: 2, total: 1 }),
    state('review', { review: { ...review, videos: -1 } }),
    state('review', { review: { ...review, previewBytes: Infinity } }),
    state('review', { review: { ...review, missingPreviews: { clip: 0 } } })];
  for (const value of invalid) {
    const h = harness({ getState: async () => value }); await settle();
    assert.equal(h.byId('create-copy').hidden, true);
    assert.equal(h.byId('cancel').textContent, 'Close');
    assert.doesNotMatch(h.byId('conversion-status').textContent, /PRIVATE/);
    fill(h); h.byId('conversion-form').fire('submit'); assert.equal(h.submissions.length, 0);
    assert.equal(h.timers.size, 0);
  }
  for (const h of [harness({ bridge: false }), harness({ getState: async () => { throw new Error('/PRIVATE/ERROR'); } })]) {
    await settle(); assert.match(h.byId('conversion-status').textContent, /Unable to check/);
    assert.doesNotMatch(h.byId('conversion-status').textContent, /PRIVATE/);
  }
});

test('conversion requires matching valid bounded Unicode passwords before submission', async () => {
  const h = harness(); await settle();
  for (const password of ['', '\ud800', '\udc00', 'é'.repeat(513), 'a'.repeat(1025)]) {
    fill(h, password); h.byId('conversion-form').fire('submit'); await settle();
    assert.equal(h.submissions.length, 0); assert.equal(h.byId('password').value, '');
    assert.equal(h.byId('confirm-password').value, '');
    assert.match(h.byId('conversion-status').textContent, /valid password/);
  }
  fill(h, '  Exact password  '); h.byId('confirm-password').value = 'Exact password';
  h.byId('conversion-form').fire('submit');
  assert.equal(h.submissions.length, 0); assert.match(h.byId('conversion-status').textContent, /do not match/);
  assert.equal(h.byId('confirm-password').getAttribute('aria-invalid'), 'true');
});

test('originals acknowledgement is mandatory and missing consent is separately required', async () => {
  const h = harness({ initialState: state('review', { review: { ...review,
    missingPreviews: { ...review.missingPreviews, filmstrip: 1 } } }) });
  await settle(); fill(h); h.byId('acknowledge-originals').checked = false;
  h.byId('allow-missing').checked = true; h.byId('conversion-form').fire('submit');
  assert.equal(h.submissions.length, 0); assert.match(h.byId('conversion-status').textContent, /originals remain unencrypted/);
  fill(h); h.byId('allow-missing').checked = false; h.byId('conversion-form').fire('submit');
  assert.equal(h.submissions.length, 0); assert.match(h.byId('conversion-status').textContent, /missing previews/);
  fill(h); h.byId('allow-missing').checked = true; h.byId('conversion-form').fire('submit');
  assert.deepEqual(h.submissions, [{ password: '  Synthetic 🐦 password  ', allowMissing: true, acknowledgeOriginals: true }]);
});

test('submission clears both revealed passwords before dispatch and preserves exact Unicode', async () => {
  const pending = deferred<boolean>();
  const h = harness({ submit: (password, allowMissing, originals) => {
    assert.equal(h.byId('password').value, ''); assert.equal(h.byId('confirm-password').value, '');
    assert.equal(h.byId('password').type, 'password'); assert.equal(h.byId('confirm-password').type, 'password');
    assert.equal(password, '  Synthetic 🐦 password  '); assert.equal(allowMissing, false); assert.equal(originals, true);
    return pending.promise;
  } });
  await settle(); fill(h); h.byId('show-password').fire('click');
  assert.equal(h.byId('password').type, 'text'); assert.equal(h.byId('confirm-password').type, 'text');
  h.byId('allow-missing').checked = true;
  h.byId('conversion-form').fire('submit'); h.byId('conversion-form').fire('submit');
  assert.equal(h.submissions.length, 1); assert.equal(h.byId('cancel').disabled, false);
  assert.equal(h.byId('credentials').hidden, true); assert.equal(h.byId('create-copy').hidden, true);
  pending.resolve(true); await settle();
  assert.equal(h.byId('create-copy').hidden, true, 'A stale review cannot reopen consumed consent');
});

test('review permits valid passwords exactly at the UTF-8 byte limit', async () => {
  for (const password of ['a'.repeat(1024), 'é'.repeat(512), '🐦'.repeat(256)]) {
    const h = harness(); await settle(); fill(h, password); h.byId('conversion-form').fire('submit');
    assert.equal(h.submissions[0].password, password);
  }
});

test('progress polling is bounded, non-overlapping and shows only current count information', async () => {
  let read = 0;
  const pending = deferred<unknown>();
  const h = harness({ getState: () => ++read === 1 ? Promise.resolve(state()) : pending.promise,
    submit: async () => false });
  await settle(); fill(h); h.byId('conversion-form').fire('submit'); await settle();
  assert.equal(h.reads, 2); assert.equal(h.timers.size, 0, 'An unresolved request cannot start another poll');
  pending.resolve(state('copying', { completed: 2, total: 12, error: '/PRIVATE/ERROR' })); await settle();
  assert.equal(h.byId('progress-label').textContent, 'Encrypting the catalogue and previews…');
  assert.equal(h.byId('conversion-progress').value, 2); assert.equal(h.byId('conversion-progress').max, 12);
  assert.equal(h.byId('progress-count').textContent, '2 of 12');
  assert.doesNotMatch(h.byId('conversion-status').textContent, /PRIVATE/);
  h.tick(); await settle(); assert.equal(h.reads, 3); assert.equal(h.timers.size, 1);
  h.byId('cancel').fire('click'); assert.equal(h.timers.size, 0);
});

test('each conversion phase uses static accessible text and close-only terminal states', async () => {
  const pending = deferred<boolean>();
  const h = harness({ submit: () => pending.promise }); await settle();
  h.setState(state('selecting')); fill(h); h.byId('conversion-form').fire('submit'); await settle();
  assert.match(h.byId('progress-label').textContent, /Choose a folder/);
  assert.equal(h.byId('progress-count').textContent, '');
  for (const phase of ['scanning', 'copying', 'verifying']) {
    h.setState(state(phase, { completed: 1, total: 4 })); h.tick(); await settle();
    assert.equal(h.byId('progress-count').textContent, '1 of 4');
    assert.equal(h.byId('conversion-form').getAttribute('aria-busy'), 'true');
    assert.equal(h.byId('cancel').disabled, false);
  }
  h.setState(state('complete')); h.tick(); await settle();
  assert.equal(h.byId('cancel').textContent, 'Close');
  assert.match(h.byId('conversion-status').textContent, /Private copy is ready/);
  assert.equal(h.byId('conversion-form').getAttribute('aria-busy'), 'false');
  assert.equal(h.timers.size, 0);
  pending.resolve(false); await settle(); assert.match(h.byId('conversion-status').textContent, /Private copy is ready/);
});

test('authoritative failure explains possible partial encrypted output and does not permit retry', async () => {
  const pending = deferred<boolean>();
  const h = harness({ submit: () => pending.promise }); await settle();
  fill(h); h.setState(state('failed')); h.byId('conversion-form').fire('submit'); await settle();
  assert.match(h.byId('conversion-status').textContent, /could not be completed/);
  assert.match(h.byId('conversion-status').textContent, /partial encrypted copy may remain; the originals are unchanged/);
  assert.equal(h.byId('cancel').textContent, 'Close');
  fill(h); h.byId('conversion-form').fire('submit'); assert.equal(h.submissions.length, 1);
  pending.reject(new Error('/PRIVATE/WRITE')); await settle();
  assert.doesNotMatch(h.byId('conversion-status').textContent, /PRIVATE/);
  assert.equal(h.timers.size, 0);
});

test('false submit and retired state never claim that a completed write failed', async () => {
  const h = harness({ submit: async () => false }); await settle(); fill(h);
  h.setState(undefined); h.byId('conversion-form').fire('submit'); await settle();
  assert.match(h.byId('conversion-status').textContent, /no longer available/);
  assert.doesNotMatch(h.byId('conversion-status').textContent, /failed|could not be completed/);
  assert.equal(h.byId('cancel').textContent, 'Close');
  assert.equal(h.timers.size, 0);
});

test('cancel and Escape clear credentials once and keep late review replies retired', async () => {
  for (const action of ['button', 'Escape']) {
    const pending = deferred<unknown>(); const h = harness({ getState: () => pending.promise });
    fill(h);
    if (action === 'button') h.byId('cancel').fire('click');
    else assert.equal(h.document.fire('keydown', { key: 'Escape' }).defaultPrevented, true);
    h.byId('cancel').fire('click'); h.document.fire('keydown', { key: 'Escape' });
    assert.equal(h.cancellations, 1); assert.equal(h.byId('password').value, '');
    const before = h.byId('conversion-status').textContent;
    pending.resolve(state()); await settle();
    assert.equal(h.byId('create-copy').disabled, true);
    assert.equal(h.byId('conversion-status').textContent, before); assert.equal(h.timers.size, 0);
  }
});

test('cancellation or page retirement prevents late progress and submit replies repainting', async () => {
  for (const ending of ['cancel', 'pagehide', 'beforeunload']) {
    const pendingState = deferred<unknown>(); const pendingSubmit = deferred<boolean>(); let reads = 0;
    const h = harness({ getState: () => ++reads === 1 ? Promise.resolve(state()) : pendingState.promise,
      submit: () => pendingSubmit.promise }); await settle(); fill(h);
    h.byId('conversion-form').fire('submit');
    if (ending === 'cancel') h.byId('cancel').fire('click'); else h.window.fire(ending);
    const before = h.byId('conversion-status').textContent;
    pendingState.resolve(state('complete')); pendingSubmit.resolve(false); await settle();
    assert.equal(h.byId('conversion-status').textContent, before, ending); assert.equal(h.timers.size, 0);
    h.window.fire('focus'); fill(h); h.byId('conversion-form').fire('submit');
    assert.equal(h.submissions.length, 1);
  }
});

test('cancel dispatch failure remains retired and displays only a safe close instruction', async () => {
  const pending = deferred<unknown>(); const h = harness({ getState: () => pending.promise,
    cancel: () => { throw new Error('/PRIVATE/CANCEL'); } });
  h.byId('cancel').fire('click');
  assert.match(h.byId('conversion-status').textContent, /Please close the window/);
  pending.resolve(state()); await settle();
  assert.doesNotMatch(h.byId('conversion-status').textContent, /PRIVATE/);
  assert.equal(h.byId('create-copy').disabled, true);
});

const exportEvents = ['copy', 'cut', 'dragstart', 'drop', 'contextmenu'];
const clipboardTrap = { getData() { throw new Error('No clipboard reads'); },
  setData() { throw new Error('No clipboard writes'); } };

test('copy, cut and drag are blocked for masked and revealed credentials without reading clipboard', async () => {
  const h = harness(); await settle(); fill(h);
  for (const visible of [false, true]) {
    if (visible) h.byId('show-password').fire('click');
    for (const name of exportEvents) {
      assert.deepEqual(h.document.captures.get(name), [true]);
      for (const target of [h.byId('password'), h.byId('confirm-password'), h.byId('review'), h.document]) {
        const event = h.document.fire(name, { target, clipboardData: clipboardTrap, dataTransfer: clipboardTrap });
        assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, name !== 'copy' && name !== 'cut');
      }
    }
    assert.equal(h.byId('password').value, '  Synthetic 🐦 password  ');
  }
  assert.match(html, /Copying and dragging are disabled\. You can paste into password fields\./);
});

test('paste is allowed only into each exact visible focused editable password control', async () => {
  for (const id of ['password', 'confirm-password']) {
    const h = harness(); await settle(); const input = h.byId(id);
    for (const visible of [false, true]) {
      if (visible) h.byId('show-password').fire('click'); input.focus();
      assert.equal(h.document.fire('paste', { target: input, clipboardData: clipboardTrap }).defaultPrevented, false);
    }
    for (const target of [new ElementStub(), h.document, h.byId('acknowledge-originals'), h.byId('review')]) {
      target.focus(); assert.equal(h.document.fire('paste', { target, clipboardData: clipboardTrap }).defaultPrevented, true);
    }
  }
});

test('paste refuses disabled, readonly, hidden, background, pending and retired credentials', async () => {
  for (const variant of ['disabled', 'readonly', 'hidden', 'unfocused', 'form-hidden', 'fieldset-hidden', 'fieldset-disabled',
    'blur', 'document-hidden', 'pending', 'cancel', 'pagehide']) {
    const h = harness({ submit: () => new Promise(() => undefined) }); await settle(); fill(h);
    const input = h.byId('password'); input.focus();
    if (variant === 'disabled') input.disabled = true;
    if (variant === 'readonly') input.readOnly = true;
    if (variant === 'hidden') input.hidden = true;
    if (variant === 'unfocused') h.byId('cancel').focus();
    if (variant === 'form-hidden') h.byId('conversion-form').hidden = true;
    if (variant === 'fieldset-hidden') h.byId('credentials').hidden = true;
    if (variant === 'fieldset-disabled') h.byId('credentials').disabled = true;
    if (variant === 'blur' || variant === 'pagehide') h.window.fire(variant);
    if (variant === 'document-hidden') h.document.hidden = true;
    if (variant === 'pending') h.byId('conversion-form').fire('submit');
    if (variant === 'cancel') h.byId('cancel').fire('click');
    assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true, variant);
  }
});

test('backgrounding or concealment clears both password drafts and restores masking', async () => {
  for (const ending of ['blur', 'hidden', 'pagehide', 'beforeunload']) {
    const h = harness(); await settle(); fill(h); h.byId('show-password').fire('click');
    if (ending === 'hidden') { h.document.hidden = true; h.document.fire('visibilitychange'); }
    else h.window.fire(ending);
    for (const id of ['password', 'confirm-password']) {
      assert.equal(h.byId(id).value, ''); assert.equal(h.byId(id).type, 'password');
    }
    assert.equal(h.byId('show-password').getAttribute('aria-pressed'), 'false');
    fill(h); h.byId('password').fire('input'); assert.equal(h.byId('password').value, '');
    h.byId('conversion-form').fire('submit'); assert.equal(h.submissions.length, 0);
  }
});

test('IME composition does not submit early and ordinary editing stays available', async () => {
  const h = harness(); await settle(); fill(h, '組み立て'); const input = h.byId('password');
  input.fire('compositionstart');
  assert.equal(input.fire('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, true);
  h.byId('conversion-form').fire('submit'); assert.equal(h.submissions.length, 0);
  for (const key of ['a', 'ArrowLeft', 'Backspace']) {
    assert.equal(h.document.fire('keydown', { key }).defaultPrevented, false);
  }
  input.fire('compositionend'); h.byId('conversion-form').fire('submit');
  assert.equal(h.submissions[0].password, '組み立て');
});

test('isolated conversion document keeps restrictive resources and small-window controls accessible', () => {
  assert.match(html, /default-src 'none'/); assert.match(html, /connect-src 'none'/); assert.match(html, /form-action 'none'/);
  assert.match(html, /aria-live="polite"/); assert.match(html, /for="confirm-password"/);
  assert.match(html, /aria-controls="password confirm-password"/);
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|fetch\(|clipboard\.|console\./);
  assert.match(css, /@media \(max-width: 520px\)/); assert.match(css, /forced-colors: active/);
  assert.doesNotMatch(css, /(?:body|\.conversion-sheet)\s*\{[^}]*overflow:\s*hidden/);
});
