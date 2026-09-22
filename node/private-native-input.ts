import type { Input } from 'electron';

export type PrivateNativeInputAction = 'block' | 'paste' | 'select-all' | 'close' | 'quit';

/** Native shortcuts must not bypass the private document's export policy. */
export function privateNativeInputAction(input: Input, platform: NodeJS.Platform = process.platform): PrivateNativeInputAction | undefined {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') { return; }
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  const code = typeof input.code === 'string' ? input.code.toLowerCase() : '';
  const is = (value: string): boolean => key === value || code === 'key' + value;
  const primary = platform === 'darwin' ? input.meta : input.control;
  const command = input.meta || input.control;
  if (key === 'f12' || code === 'f12') { return 'block'; }
  // Legacy clipboard shortcuts and macOS's shared Find/kill-ring commands.
  if ((input.control && (key === 'insert' || code === 'insert'))
    || (input.shift && (key === 'delete' || code === 'delete'))
    || (command && ['c', 'x', 'e', 's', 'p', 'r', 'i', 'j', 'u'].some(is))
    || (platform === 'darwin' && input.control && ['k', 'y', 'w'].some(is))) { return 'block'; }
  const invoke = (action: PrivateNativeInputAction): PrivateNativeInputAction =>
    input.type === 'keyDown' && !input.isAutoRepeat && !input.isComposing ? action : 'block';
  if (!input.alt && input.shift && !command && (key === 'insert' || code === 'insert')) { return invoke('paste'); }
  if (primary && !input.alt && !(input.meta && input.control)) {
    if (is('v')) { return invoke('paste'); }
    if (is('a')) { return invoke('select-all'); }
    if (is('w')) { return invoke('close'); }
    if (is('q')) { return invoke('quit'); }
  }
  // Native lookup/service combinations must not see the selected private text.
  if (platform === 'darwin' && input.meta && input.control) { return 'block'; }
  return;
}
