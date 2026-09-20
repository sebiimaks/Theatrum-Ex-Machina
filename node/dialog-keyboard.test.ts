import { strict as assert } from 'assert';
import { test } from 'node:test';
import { handleDialogKeydown } from '../src/app/common/dialog-keyboard';

function dispatch(key: string, options: { handled?: boolean; composing?: boolean } = {}) {
  let prevented = options.handled || false;
  let stopped = false;
  let dismissed = 0;
  handleDialogKeydown({
    key,
    get defaultPrevented() { return prevented; },
    isComposing: options.composing || false,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  }, () => { dismissed++; });
  return { prevented, stopped, dismissed };
}

test('Escape dismisses only its current dialog and does not reach the workspace', () => {
  assert.deepEqual(dispatch('Escape'), { prevented: true, stopped: true, dismissed: 1 });
});

test('Escape already consumed by a field leaves the dialog open', () => {
  assert.deepEqual(dispatch('Escape', { handled: true }), { prevented: true, stopped: true, dismissed: 0 });
});

test('Escape during text composition leaves the dialog open', () => {
  assert.deepEqual(dispatch('Escape', { composing: true }), { prevented: false, stopped: true, dismissed: 0 });
});

test('native editing and focus navigation stay usable without background shortcuts', () => {
  for (const key of ['z', 'x', 'a', 'Tab', 'ArrowDown', 'Enter', ' ']) {
    assert.deepEqual(dispatch(key), { prevented: false, stopped: true, dismissed: 0 });
  }
});
