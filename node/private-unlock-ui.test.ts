import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = path.resolve(__dirname, '../private-unlock');
const source = readFileSync(path.join(root, 'unlock.js'), 'utf8');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

// Runs the production page script. Native tests separately check Chromium's
// dispatch and edit-command routing without touching the user's clipboard.
class ElementStub {
  value = '';
  type = '';
  textContent = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  captures = new Map<string, boolean[]>();
  onFocus = (_element: ElementStub) => undefined;
  focus(): void { this.onFocus(this); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
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
      for (const handler of this.listeners.get(name) ?? []) handler(event);
    }
    return event;
  }
}

function harness(submit: (password: string) => Promise<boolean> = async () => true, options: {
  availability?: () => Promise<unknown>; touchId?: () => Promise<unknown>;
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
  const submitted: string[] = [];
  let cancellations = 0;
  let availabilityReads = 0;
  let touchIdChoices = 0;
  const clipboardTrap = new Proxy({}, { get() { throw new Error('No clipboard API may be accessed'); } });
  runInNewContext(source, {
    document: Object.assign(document, { getElementById: (id: string) => {
      assert.ok(elements.has(id), `Unknown control ${id}`); return elements.get(id);
    } }),
    window: Object.assign(window, { privateUnlock: {
      touchIdAvailable: () => { availabilityReads++; return options.availability?.() ?? Promise.resolve(false); },
      useTouchId: () => { touchIdChoices++; return options.touchId?.() ?? Promise.resolve(true); },
      submit: (password: string) => { submitted.push(password); return submit(password); },
      cancel: () => { cancellations++; },
    } }),
    navigator: Object.defineProperty({}, 'clipboard', { get: () => clipboardTrap }),
  }, { filename: path.join(root, 'unlock.js') });
  const byId = (id: string) => elements.get(id)!;
  byId('password').focus();
  return { document, window, byId, submitted, get availabilityReads() { return availabilityReads; },
    get touchIdChoices() { return touchIdChoices; }, get cancellations() { return cancellations; } };
}

const exportEvents = ['copy', 'cut', 'dragstart', 'drop', 'contextmenu'];
const clipboardTrap = { getData() { throw new Error('Application code must not read clipboard data'); },
  setData() { throw new Error('Application code must not write clipboard data'); } };

async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('unlock captures and prevents copy, cut and drag of masked and revealed credentials', () => {
  const h = harness();
  const password = h.byId('password');
  password.value = 'Synthetic password';
  for (const visible of [false, true]) {
    if (visible) h.byId('show-password').fire('click');
    assert.equal(password.type, visible ? 'text' : 'password');
    for (const name of exportEvents) {
      assert.deepEqual(h.document.captures.get(name), [true]);
      for (const target of [password, h.byId('privacy-description'), h.document]) {
        const event = h.document.fire(name, { target, clipboardData: clipboardTrap, dataTransfer: clipboardTrap });
        assert.equal(event.defaultPrevented, true, name);
        // Copy/cut remain observable by the native fixture's safe backstop.
        assert.equal(event.stopped, name !== 'copy' && name !== 'cut', name);
      }
      assert.equal(password.value, 'Synthetic password', 'Cut must not delete the draft');
    }
  }
  assert.equal(h.submitted.length, 0);
  assert.match(html, /Copying and dragging are disabled\. You can paste into password fields\./);
});

test('unlock admits native paste into the focused exact masked or revealed password field', () => {
  const h = harness();
  const input = h.byId('password');
  assert.deepEqual(h.document.captures.get('paste'), [true]);
  for (const visible of [false, true]) {
    if (visible) h.byId('show-password').fire('click');
    input.focus();
    const event = h.document.fire('paste', { target: input, clipboardData: clipboardTrap });
    assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false);
    // Browser insertion is deliberately separate from application admission.
    input.value = '  Synthetic 🐦 password  '; input.fire('input');
    assert.equal(input.value, '  Synthetic 🐦 password  ');
  }
  assert.equal(h.submitted.length, 0);
});

test('unlock rejects paste into other targets and lookalike password controls', () => {
  const h = harness();
  for (const target of [h.document, h.byId('privacy-description'), h.byId('show-password'), new ElementStub()]) {
    target.focus();
    const event = h.document.fire('paste', { target, clipboardData: clipboardTrap });
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  }
  assert.equal(h.byId('password').value, '');
});

test('unlock refuses paste when the exact credential field is disabled, hidden, readonly or unfocused', () => {
  for (const state of ['disabled', 'readonly', 'hidden', 'form-hidden', 'unfocused']) {
    const h = harness(); const input = h.byId('password');
    if (state === 'disabled') input.disabled = true;
    if (state === 'readonly') input.readOnly = true;
    if (state === 'hidden') input.hidden = true;
    if (state === 'form-hidden') h.byId('unlock-form').hidden = true;
    if (state === 'unfocused') h.byId('cancel').focus();
    const event = h.document.fire('paste', { target: input, clipboardData: clipboardTrap });
    assert.equal(event.defaultPrevented, true, state); assert.equal(event.stopped, true);
  }
});

test('unlock refuses background paste and permits it only after focus or visibility returns', () => {
  const h = harness(); const input = h.byId('password'); input.value = 'Synthetic';
  h.byId('show-password').fire('click');
  h.window.fire('blur');
  assert.equal(input.value, ''); assert.equal(input.type, 'password');
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true);
  h.window.fire('focus'); input.focus();
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, false);
  h.document.hidden = true; h.document.fire('visibilitychange');
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true);
  h.document.hidden = false; h.document.fire('visibilitychange');
  assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, false);
});

test('unlock rejects paste during submission, after cancellation and after page retirement', async () => {
  for (const ending of ['pending', 'cancel', 'pagehide', 'beforeunload']) {
    let finish!: (value: boolean) => void;
    const h = harness(() => new Promise(resolve => { finish = resolve; }));
    const input = h.byId('password'); input.value = 'Synthetic';
    if (ending === 'pending') h.byId('unlock-form').fire('submit');
    if (ending === 'cancel') h.byId('cancel').fire('click');
    if (ending === 'pagehide' || ending === 'beforeunload') h.window.fire(ending);
    input.disabled = false; input.focus(); h.window.fire('focus');
    assert.equal(input.value, '');
    assert.equal(h.document.fire('paste', { target: input }).defaultPrevented, true, ending);
    if (finish) { finish(true); await settle(); }
  }
});

test('unlock paste preserves exact Unicode and whitespace until synchronous submit clearing', async () => {
  const h = harness(); const input = h.byId('password');
  assert.equal(h.document.fire('paste', { target: input, clipboardData: clipboardTrap }).defaultPrevented, false);
  input.value = '  Synthetic 🐦 password  '; input.fire('input');
  h.byId('unlock-form').fire('submit');
  assert.equal(input.value, ''); assert.equal(input.type, 'password');
  assert.deepEqual(h.submitted, ['  Synthetic 🐦 password  ']);
  await settle();
});

test('unlock export restrictions do not intercept ordinary typing, selection or composition events', () => {
  const h = harness(); const input = h.byId('password');
  for (const key of ['a', 'ArrowLeft', 'Backspace', 'Enter']) {
    const event = h.document.fire('keydown', { target: input, key, metaKey: key === 'a', isComposing: key === 'Enter' });
    assert.equal(event.defaultPrevented, false, key);
  }
  input.fire('compositionstart'); input.value = '組み立て'; input.fire('input'); input.fire('compositionend');
  assert.equal(input.value, '組み立て'); assert.equal(h.submitted.length, 0);
});


test('Touch ID is offered only after explicit availability while password fallback stays usable', async () => {
  for (const value of [true, false, undefined, 'true', { key: '/private' }]) {
    const h = harness(undefined, { availability: async () => value });
    assert.equal(h.byId('use-touch-id').hidden, true);
    await settle();
    assert.equal(h.byId('use-touch-id').hidden, value !== true);
    assert.equal(h.byId('touch-id-help').hidden, value !== true);
    assert.equal(h.byId('password').disabled, false);
    assert.equal(h.byId('unlock').disabled, false);
    assert.equal(h.availabilityReads, 1); assert.equal(h.touchIdChoices, 0);
  }
});

test('Touch ID availability failure keeps ordinary password submission available', async () => {
  const h = harness(undefined, { availability: async () => { throw new Error('/private'); } });
  await settle();
  assert.equal(h.byId('use-touch-id').hidden, true);
  h.byId('password').value = 'synthetic'; h.byId('unlock-form').fire('submit'); await settle();
  assert.deepEqual(h.submitted, ['synthetic']);
  assert.doesNotMatch(h.byId('unlock-status').textContent, /\/private/);
});

test('choosing Touch ID clears revealed passwords synchronously and prevents duplicate choices', async () => {
  let finish!: (value: boolean) => void;
  const h = harness(undefined, { availability: async () => true, touchId: () => new Promise(resolve => { finish = resolve; }) });
  await settle();
  h.byId('password').value = 'synthetic'; h.byId('show-password').fire('click');
  h.byId('use-touch-id').fire('click');
  assert.equal(h.byId('password').value, ''); assert.equal(h.byId('password').type, 'password');
  h.byId('use-touch-id').fire('click'); h.byId('unlock-form').fire('submit');
  assert.equal(h.touchIdChoices, 1); assert.deepEqual(h.submitted, []);
  assert.equal(h.byId('password').disabled, true);
  finish(true); await settle();
  assert.match(h.byId('unlock-status').textContent, /Touch ID prompt/);
});

test('late Touch ID availability cannot reopen actions after cancel, submission or retirement', async () => {
  for (const ending of ['cancel', 'submit', 'pagehide', 'beforeunload']) {
    let finish!: (value: boolean) => void;
    const h = harness(undefined, { availability: () => new Promise(resolve => { finish = resolve; }) });
    if (ending === 'cancel') h.byId('cancel').fire('click');
    else if (ending === 'submit') { h.byId('password').value = 'synthetic'; h.byId('unlock-form').fire('submit'); }
    else h.window.fire(ending);
    finish(true); await settle();
    assert.equal(h.byId('use-touch-id').hidden, true, ending);
    h.byId('use-touch-id').fire('click'); assert.equal(h.touchIdChoices, 0);
  }
});

test('Touch ID choice rejects background actions and sanitizes native failure', async () => {
  const h = harness(undefined, { availability: async () => true, touchId: async () => { throw new Error('/private/key'); } });
  await settle(); h.window.fire('blur'); h.byId('use-touch-id').fire('click');
  assert.equal(h.touchIdChoices, 0);
  h.window.fire('focus'); h.byId('use-touch-id').fire('click'); await settle();
  assert.match(h.byId('unlock-status').textContent, /try your hub password/);
  assert.doesNotMatch(h.byId('unlock-status').textContent, /private\/key/);
});
