import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { privateConversionFailure } from './private-conversion-errors';

async function selectedDirectorySnapshot(directory: string) {
  const directories: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    directories.push(current);
    if (path.dirname(current) === current) { break; }
  }
  const snapshots = [];
  for (const entry of directories.reverse()) {
    const stats = await fs.lstat(entry);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw privateConversionFailure('destination-unavailable');
    }
    snapshots.push({ directory: entry, dev: stats.dev, ino: stats.ino });
  }
  return snapshots;
}

/** Native folder selection chooses a parent, never an existing hub to adopt. */
export async function privateConversionDestination(selectedDirectory: string): Promise<string> {
  if (typeof selectedDirectory !== 'string' || !path.isAbsolute(selectedDirectory)) {
    throw privateConversionFailure('destination-unavailable');
  }
  const selected = path.resolve(selectedDirectory);
  const selectedBefore = await selectedDirectorySnapshot(selected);
  // Native realpath supplies the stored spelling on case-insensitive volumes.
  // Resolve the selection once, before handing it to the strict storage layer.
  // Inspect ancestors too: canonicalizing must never make a linked parent valid.
  const parent = await fs.realpath(selected);
  const before = await fs.lstat(parent);
  const selectedLeaf = selectedBefore[selectedBefore.length - 1];
  if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== selectedLeaf.dev || before.ino !== selectedLeaf.ino) {
    throw privateConversionFailure('destination-unavailable');
  }
  for (let number = 1; number <= 1000; number++) {
    const candidate = path.join(parent, number === 1 ? 'Private hub' : `Private hub ${number}`);
    try { await fs.lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') { throw error; }
      const selectedAfter = await selectedDirectorySnapshot(selected);
      const current = await fs.lstat(parent);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || selectedAfter.some((entry, index) => entry.dev !== selectedBefore[index].dev || entry.ino !== selectedBefore[index].ino)
        || await fs.realpath(selected) !== parent || await fs.realpath(parent) !== parent) {
        throw privateConversionFailure('destination-unavailable');
      }
      // This is only a suggestion. Store.create still uses exclusive mkdir, so
      // a concurrent claimant can never make us overwrite or adopt its files.
      return candidate;
    }
  }
  throw privateConversionFailure('destination-unavailable');
}
