import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FinalObject } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { compileIgnoredSubdirectories, sourceFolderPathIsIgnored } from '../interfaces/source-folder-path';

const MAX_ROWS = 100_000;
const MAX_REFERENCES = 10_000;
const MAX_DEPTH = 32;
const MAX_PATH_CHARACTERS = 8 * 1024 * 1024;
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export interface PrivateSourceCheckOptions {
  readonly catalogue: FinalObject;
  readonly sourceIndex: number;
  readonly signal: AbortSignal;
  /** Main-owned session, exact frame and native source grant; never a saved path alone. */
  readonly isCurrent: () => boolean;
}
export interface PrivateSourceCheckCounts {
  total: number;
  sameSize: number;
  differentSize: number;
  missing: number;
  unverified: number;
  ignored: number;
}
export type PrivateSourceCheckResult = ({ status: 'checked'; revision: string } & PrivateSourceCheckCounts)
  | { status: 'cancelled' | 'invalid' | 'limit' | 'source-unavailable' };
type FailureStatus = Exclude<PrivateSourceCheckResult['status'], 'checked'>;
type Outcome = Exclude<keyof PrivateSourceCheckCounts, 'total'>;
interface Reference { relative: string; size: number | undefined; ignored: boolean; depth: number }
interface Snapshot { root: string; references: Reference[]; revision: string }
interface Directory { path: string; stat: fs.BigIntStats }
class CheckFailure extends Error {
  constructor(readonly status: FailureStatus) { super('Private source check is unavailable.'); }
}

function* snapshotSteps(catalogue: FinalObject, sourceIndex: number): Generator<void, Snapshot> {
  if (!catalogue || typeof catalogue !== 'object' || !Array.isArray(catalogue.images)
    || !catalogue.inputDirs || typeof catalogue.inputDirs !== 'object' || Array.isArray(catalogue.inputDirs)
    || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || !Object.hasOwn(catalogue.inputDirs, sourceIndex)) {
    throw new CheckFailure('invalid');
  }
  const sources = Object.keys(catalogue.inputDirs);
  if (catalogue.images.length > MAX_ROWS || sources.length > 256) { throw new CheckFailure('limit'); }
  if (sources.some(key => !/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key)))) {
    throw new CheckFailure('invalid');
  }
  const source = catalogue.inputDirs[sourceIndex];
  const savedRoot = source?.path;
  if (typeof savedRoot !== 'string' || !savedRoot || savedRoot.length > 32_768 || savedRoot.includes('\0')
    || !path.isAbsolute(savedRoot)) { throw new CheckFailure('invalid'); }
  const root = path.resolve(savedRoot);
  if (root === path.parse(root).root) { throw new CheckFailure('invalid'); }
  const ignored = compileIgnoredSubdirectories(source.ignoredSubdirectories);
  const hash = createHash('sha256').update(JSON.stringify([sourceIndex, savedRoot, ignored.scopes]));
  const references: Reference[] = [];
  let rawLocations = 0;
  let pathCharacters = 0;
  for (const [index, image] of catalogue.images.entries()) {
    if (index > 0 && index % 32 === 0) { yield; }
    if (!image || typeof image !== 'object' || Array.isArray(image)) { throw new CheckFailure('invalid'); }
    rawLocations += Array.isArray(image.locations) ? image.locations.length : 1;
    if (rawLocations > MAX_ROWS) { throw new CheckFailure('limit'); }
    if (image.deleted || image.cleanName === '*FOLDER*') { continue; }
    // Validate the complete active location list before any filesystem access.
    const locations = getImageLocations(image);
    for (const location of locations) {
      if (location.fileName.length > 4096 || !Object.hasOwn(catalogue.inputDirs, location.inputSource)) {
        throw new CheckFailure('invalid');
      }
      if (location.inputSource !== sourceIndex) { continue; }
      if (references.length === MAX_REFERENCES) { throw new CheckFailure('limit'); }
      const relative = path.join(location.partialPath.replace(/^\/+/, ''), location.fileName);
      const file = path.resolve(root, relative);
      const contained = path.relative(root, file);
      if (!contained || contained === '..' || contained.startsWith('..' + path.sep) || path.isAbsolute(contained)
        || file.length > 32_768) { throw new CheckFailure('invalid'); }
      pathCharacters += relative.length;
      if (pathCharacters > MAX_PATH_CHARACTERS) { throw new CheckFailure('limit'); }
      const size = Number.isSafeInteger(image.fileSize) && image.fileSize > 0 ? image.fileSize : undefined;
      const skipped = sourceFolderPathIsIgnored(location.partialPath, ignored);
      references.push({ relative, size, ignored: skipped, depth: relative.split(path.sep).length - 1 });
      hash.update(JSON.stringify([index, location.partialPath, location.fileName, image.fileSize]));
    }
  }
  return { root, references, revision: hash.digest('hex') };
}

/** Main-only comparison token. Invalid or oversized catalogues throw a path-free error. */
export function privateSourceCheckRevision(catalogue: FinalObject, sourceIndex: number): string {
  try {
    const reading = snapshotSteps(catalogue, sourceIndex);
    let step = reading.next();
    while (!step.done) { step = reading.next(); }
    return step.value.revision;
  } catch { throw new Error('Private source check is unavailable.'); }
}

function sameDirectory(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino;
}
function sameFile(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Inspect saved locations only, never video bytes, descriptors or directory entries.
 * Path-based pre/post identity checks detect replacements; they are not an OS
 * descriptor-relative traversal sandbox and the result is a point-in-time check.
 */
export async function checkPrivateSource(options: PrivateSourceCheckOptions): Promise<PrivateSourceCheckResult> {
  let revoked = false;
  let checking = false;
  const current = (): void => {
    let allowed = false;
    if (!revoked && !checking) {
      checking = true;
      try { allowed = options?.signal instanceof AbortSignal && !options.signal.aborted
        && typeof options.isCurrent === 'function' && options.isCurrent() === true && !options.signal.aborted; }
      catch { /* Failed or revoked predicates never regain authority. */ }
      finally { checking = false; }
    }
    if (!allowed) { revoked = true; throw new CheckFailure('cancelled'); }
  };
  try {
    current();
    let captured: Snapshot;
    try {
      const reading = snapshotSteps(options.catalogue, options.sourceIndex);
      let step = reading.next();
      while (!step.done) { await turn(); current(); step = reading.next(); }
      captured = step.value;
    } catch (error) { throw error instanceof CheckFailure ? error : new CheckFailure('invalid'); }
    current();
    const counts: PrivateSourceCheckCounts = { total: captured.references.length, sameSize: 0,
      differentSize: 0, missing: 0, unverified: 0, ignored: 0 };
    const directories = new Map<string, fs.BigIntStats>();
    const unsafeDirectories = new Set<string>();
    const stat = async (file: string): Promise<fs.BigIntStats> => {
      current();
      try { return await fs.promises.lstat(file, { bigint: true }); }
      finally { current(); }
    };
    const canonical = async (file: string): Promise<boolean> => {
      current();
      try { return await fs.promises.realpath(file) === file; }
      finally { current(); }
    };
    let rootStat: fs.BigIntStats;
    try {
      rootStat = await stat(captured.root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !await canonical(captured.root)) { throw new Error(); }
    } catch (error) { throw error instanceof CheckFailure ? error : new CheckFailure('source-unavailable'); }
    const verifyRoot = async (): Promise<void> => {
      try {
        if (!sameDirectory(rootStat, await stat(captured.root)) || !await canonical(captured.root)) { throw new Error(); }
      } catch (error) { throw error instanceof CheckFailure ? error : new CheckFailure('source-unavailable'); }
    };
    const verifyParents = async (parents: Directory[]): Promise<boolean> => {
      await verifyRoot();
      for (const parent of parents) {
        try {
          if (unsafeDirectories.has(parent.path) || !sameDirectory(parent.stat, await stat(parent.path))
            || !await canonical(parent.path)) { throw new Error(); }
        } catch (error) {
          if (error instanceof CheckFailure) { throw error; }
          unsafeDirectories.add(parent.path); await verifyRoot(); return false;
        }
      }
      await verifyRoot(); return true;
    };
    const check = async (reference: Reference): Promise<Outcome> => {
      if (reference.ignored) { return 'ignored'; }
      if (reference.depth > MAX_DEPTH) { return 'unverified'; }
      const parents: Directory[] = [];
      let directory = captured.root;
      const segments = reference.relative.split(path.sep);
      for (const segment of segments.slice(0, -1)) {
        if (!await verifyParents(parents)) { return 'unverified'; }
        directory = path.join(directory, segment);
        if (unsafeDirectories.has(directory)) { return 'unverified'; }
        let parent: fs.BigIntStats;
        try { parent = await stat(directory); }
        catch (error) {
          if (error instanceof CheckFailure) { throw error; }
          if (!await verifyParents(parents)) { return 'unverified'; }
          return missing(error) ? 'missing' : 'unverified';
        }
        if (!await verifyParents(parents)) { return 'unverified'; }
        const previous = directories.get(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || (previous && !sameDirectory(previous, parent))) {
          unsafeDirectories.add(directory); return 'unverified';
        }
        try {
          if (!await canonical(directory)) { unsafeDirectories.add(directory); return 'unverified'; }
        } catch (error) {
          if (error instanceof CheckFailure) { throw error; }
          unsafeDirectories.add(directory); return 'unverified';
        }
        directories.set(directory, parent); parents.push({ path: directory, stat: parent });
      }
      if (!await verifyParents(parents)) { return 'unverified'; }
      const file = path.join(captured.root, reference.relative);
      let fileStat: fs.BigIntStats;
      try { fileStat = await stat(file); }
      catch (error) {
        if (error instanceof CheckFailure) { throw error; }
        if (!await verifyParents(parents)) { return 'unverified'; }
        return missing(error) ? 'missing' : 'unverified';
      }
      if (!await verifyParents(parents) || !fileStat.isFile() || fileStat.isSymbolicLink()) { return 'unverified'; }
      try {
        if (!await canonical(file) || !await verifyParents(parents)
          || !sameFile(fileStat, await stat(file)) || !await verifyParents(parents)) { return 'unverified'; }
      } catch (error) {
        if (error instanceof CheckFailure) { throw error; }
        await verifyRoot(); return 'unverified';
      }
      return reference.size === undefined ? 'unverified'
        : fileStat.size === BigInt(reference.size) ? 'sameSize' : 'differentSize';
    };
    for (const [index, reference] of captured.references.entries()) {
      current(); counts[await check(reference)]++;
      if ((index + 1) % 32 === 0) { await turn(); current(); }
    }
    await verifyRoot(); current();
    return { status: 'checked', ...counts, revision: captured.revision };
  } catch (error) {
    return { status: error instanceof CheckFailure ? error.status : 'source-unavailable' };
  }
}
