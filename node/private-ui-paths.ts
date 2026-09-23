import * as path from 'node:path';
import type * as Electron from 'electron';

const directories = ['private-unlock', 'private-conversion', 'private-gallery'] as const;
const preloads = ['private-password-preload.cjs', 'private-conversion-preload.cjs', 'private-gallery-preload.cjs'] as const;
type PrivateUiPath = typeof directories[number] | typeof preloads[number];
const moduleRoot = path.resolve(__dirname, '..');
function unavailable(): Error { return new Error('Private interface assets are unavailable.'); }

/** Static application UI only. Encrypted hub records never use these paths. */
export function getPrivateUiPath(name: PrivateUiPath): string {
  if (![...directories, ...preloads].some(value => value === name)) { throw unavailable(); }
  let root = moduleRoot;
  const archived = path.basename(root).toLowerCase().endsWith('.asar');
  if (process.versions.electron) {
    if (process.type !== 'browser') { throw unavailable(); }
    const { app } = require('electron') as typeof Electron;
    if (!app || typeof app.isPackaged !== 'boolean') { throw unavailable(); }
    if (app.isPackaged) {
      // Read physical files, not virtual ASAR metadata or open() extraction.
      // Keep the strict no-link and descriptor-identity checks at each reader.
      if (!archived || path.dirname(root) !== process.resourcesPath) { throw unavailable(); }
      root += '.unpacked';
    } else if (archived) { throw unavailable(); }
  } else if (archived || process.type !== undefined || process.resourcesPath !== undefined) { throw unavailable(); }
  if (root.split(/[\\/]/).some(segment => segment.toLowerCase().endsWith('.asar'))) { throw unavailable(); }
  return path.join(root, name);
}

/** Map only this main module's three known asset directories, never a request path. */
export function resolvePrivateUiDirectory(directory: string): string {
  for (const name of directories) {
    if (directory === path.join(moduleRoot, name)) { return getPrivateUiPath(name); }
  }
  // Explicit physical directories remain supported by development fixtures.
  // There is no generic archive reader or extraction fallback.
  if (directory.split(/[\\/]/).some(segment => segment.toLowerCase().endsWith('.asar'))) { throw unavailable(); }
  return directory;
}
