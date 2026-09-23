import * as path from 'node:path';
import type * as Electron from 'electron';

export type PrivateHelperName = 'private-hub-lock' | 'private-touch-id.node';

function unavailable(): Error { return new Error('Private native support is unavailable.'); }

/** Fixed main-owned binaries only: never an environment override, PATH lookup or ASAR executable. */
export function getPrivateHelperPath(helper: PrivateHelperName): string {
  if (helper !== 'private-hub-lock' && helper !== 'private-touch-id.node') { throw unavailable(); }
  let root: string;
  if (process.versions.electron) {
    // Electron renderer and utility processes must never load native privacy capabilities.
    if (process.type !== 'browser') { throw unavailable(); }
    const { app } = require('electron') as typeof Electron;
    if (!app || typeof app.isPackaged !== 'boolean') { throw unavailable(); }
    root = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', 'build');
  } else {
    // Plain Node is supported by storage tests. Electron-shaped but incomplete
    // runtimes must not silently fall back to development binaries.
    if (process.type !== undefined || process.resourcesPath !== undefined) { throw unavailable(); }
    root = path.resolve(__dirname, '..', 'build');
  }
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes('\0')
    || root.split(/[\\/]/).some(segment => segment.toLowerCase().endsWith('.asar'))) { throw unavailable(); }
  return path.join(root, 'privacy-tools', helper);
}
