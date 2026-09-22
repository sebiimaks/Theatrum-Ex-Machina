import { Menu, type MenuItemConstructorOptions } from 'electron';

export interface PrivateNativeMenuOptions {
  readonly kind: 'password' | 'hub';
  readonly onClose: () => void;
  readonly onPaste: () => void;
  readonly onSelectAll: () => void;
}
export interface PrivateNativeMenuLease {
  /** False is permanent for this lease; callers must retire the private browser. */
  check(): boolean;
  /** Call only after every private renderer and resource has cleanly drained. */
  release(): void;
  /** Retain the restricted menu and its global reservation after unproven cleanup. */
  quarantine(): void;
}
interface Owner {
  state: 'preparing' | 'active' | 'restoring' | 'released' | 'poisoned';
  original?: Menu | null;
  restricted?: Menu;
  checking?: boolean;
  dispatching?: boolean;
  reasserting?: boolean;
}
let active: Owner | undefined;
const cleanupFailures = new WeakSet<object>();
function unavailable(): Error { return new Error('Private native controls are unavailable.'); }
function cleanupFailure(): Error {
  const error = new Error('Private native controls cleanup could not be confirmed.');
  cleanupFailures.add(error);
  return error;
}
export function isPrivateNativeMenuCleanupFailure(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && cleanupFailures.has(error);
}
function reassertRestricted(owner: Owner): void {
  if (active !== owner || owner.state === 'released' || !owner.restricted || owner.reasserting) { return; }
  owner.reasserting = true;
  try { Menu.setApplicationMenu(owner.restricted); } catch { /* Ownership stays poisoned when adoption is uncertain. */ }
  finally { owner.reasserting = false; }
}
function poison(owner: Owner): void {
  if (active !== owner || owner.state === 'released') { return; }
  owner.state = 'poisoned';
  reassertRestricted(owner);
}
function check(owner: Owner): boolean {
  if (active !== owner) { return false; }
  if (owner.state === 'poisoned') { reassertRestricted(owner); return false; }
  if (owner.state !== 'active') { return false; }
  if (owner.checking) { poison(owner); return false; }
  owner.checking = true;
  try {
    const installed = Menu.getApplicationMenu();
    if (active === owner && owner.state === 'active' && installed === owner.restricted) { return true; }
  } catch { /* An unreadable menu is no longer proven restricted. */ }
  finally { owner.checking = false; }
  poison(owner);
  return false;
}
function invoke(owner: Owner, callback: () => void): void {
  if (owner.dispatching) { return; }
  owner.dispatching = true;
  try {
    if (!check(owner)) { return; }
    const result: unknown = callback();
    // Native callbacks never wait on browser disposal. Consume asynchronous
    // failures without allowing a retired callback to disturb a newer owner.
    if (result !== undefined) { void Promise.resolve(result).catch(() => poison(owner)); }
  } catch { poison(owner); }
  finally { owner.dispatching = false; }
}
function release(owner: Owner): void {
  if (active !== owner || owner.state === 'released' || owner.state === 'restoring') { return; }
  if (!check(owner)) { poison(owner); throw cleanupFailure(); }
  owner.state = 'restoring';
  try {
    Menu.setApplicationMenu(owner.original!);
    const installed = Menu.getApplicationMenu();
    if (active !== owner || owner.state !== 'restoring' || installed !== owner.original) { throw new Error(); }
    owner.state = 'released';
    active = undefined;
  } catch {
    poison(owner);
    throw cleanupFailure();
  }
}

/** App-global restriction: per-window menus do not protect macOS menu actions. */
export function acquirePrivateNativeMenu(options: PrivateNativeMenuOptions): PrivateNativeMenuLease {
  if (active?.state === 'poisoned') { reassertRestricted(active); throw cleanupFailure(); }
  if (active || !options || !['password', 'hub'].includes(options.kind)
    || typeof options.onClose !== 'function' || typeof options.onPaste !== 'function'
    || typeof options.onSelectAll !== 'function') { throw unavailable(); }
  const { kind, onClose, onPaste, onSelectAll } = options;
  const owner: Owner = { state: 'preparing' };
  active = owner; // Reserve before any native adapter can reenter acquisition.
  let installationAttempted = false;
  try {
    owner.original = Menu.getApplicationMenu();
    const template: MenuItemConstructorOptions[] = [
      { label: 'Theatrum Ex Machina', submenu: [
        { id: 'private-native-close', label: kind === 'password' ? 'Cancel unlock' : 'Lock hub', click: () => invoke(owner, onClose) },
        { type: 'separator' }, { role: 'hide' }, { role: 'quit' },
      ] },
      { label: 'Edit', submenu: [
        { id: 'private-native-paste', label: 'Paste password', click: () => invoke(owner, onPaste) },
        { id: 'private-native-select-all', label: 'Select all', click: () => invoke(owner, onSelectAll) },
      ] },
    ];
    owner.restricted = Menu.buildFromTemplate(template);
    installationAttempted = true;
    Menu.setApplicationMenu(owner.restricted);
    if (Menu.getApplicationMenu() !== owner.restricted || active !== owner || owner.state !== 'preparing') { throw new Error(); }
    owner.state = 'active';
    return Object.freeze({ check: () => check(owner), release: () => release(owner), quarantine: () => poison(owner) });
  } catch {
    if (installationAttempted) { poison(owner); throw cleanupFailure(); }
    // No native mutation was attempted, so a read/build failure can safely
    // abandon this reservation without replacing the existing normal menu.
    owner.state = 'released';
    if (active === owner) { active = undefined; }
    throw unavailable();
  }
}
