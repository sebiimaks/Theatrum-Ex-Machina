import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Input } from 'electron';
import { privateNativeInputAction } from './private-native-input';

const input = (value: Partial<Input>): Input => ({ type: 'keyDown', key: '', code: '', isAutoRepeat: false,
  isComposing: false, location: 0, modifiers: [], shift: false, control: false, alt: false, meta: false, ...value });
for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(platform + ' blocks export and document commands before renderer and menu dispatch', () => {
    for (const key of ['c', 'x', 'e', 's', 'p', 'r', 'i', 'j', 'u']) {
      for (const modifier of [{ control: true }, { meta: true }, { control: true, shift: true }]) {
        assert.equal(privateNativeInputAction(input({ key, ...modifier }), platform), 'block');
        assert.equal(privateNativeInputAction(input({ key: 'Other', code: 'Key' + key.toUpperCase(), ...modifier }), platform), 'block');
        assert.equal(privateNativeInputAction(input({ key, type: 'keyUp', ...modifier }), platform), 'block');
      }
    }
    for (const value of [{ key: 'Insert', control: true }, { key: 'Delete', shift: true }, { key: 'F12' }]) {
      assert.equal(privateNativeInputAction(input(value), platform), 'block');
    }
  });
  test(platform + ' routes only explicit one-shot native actions and preserves ordinary editing', () => {
    const primary = platform === 'darwin' ? { meta: true } : { control: true };
    for (const [key, action] of [['v', 'paste'], ['a', 'select-all'], ['w', 'close'], ['q', 'quit']] as const) {
      assert.equal(privateNativeInputAction(input({ key, ...primary }), platform), action);
      for (const extra of [{ type: 'keyUp' }, { isAutoRepeat: true }, { isComposing: true }] as const) {
        assert.equal(privateNativeInputAction(input({ key, ...primary, ...extra }), platform), 'block');
      }
    }
    assert.equal(privateNativeInputAction(input({ key: 'Insert', shift: true }), platform), 'paste');
    for (const key of ['c', 'x', 'v', 'a', 'Enter', 'ArrowLeft', 'Backspace', 'Delete', 'Home', 'End']) {
      assert.equal(privateNativeInputAction(input({ key }), platform), undefined);
    }
    assert.equal(privateNativeInputAction(input({ key: 'z', ...primary }), platform), undefined);
    assert.equal(privateNativeInputAction(input({ key: 'ArrowLeft', ...primary }), platform), undefined);
  });
}
test('macOS native lookup and kill-ring commands cannot export or import selected text', () => {
  for (const key of ['k', 'u', 'y', 'w']) {
    assert.equal(privateNativeInputAction(input({ key, control: true }), 'darwin'), 'block');
  }
  assert.equal(privateNativeInputAction(input({ key: 'd', control: true, meta: true }), 'darwin'), 'block');
});
