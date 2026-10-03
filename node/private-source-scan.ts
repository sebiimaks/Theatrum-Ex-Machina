import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FinalObject } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';
import { compileIgnoredSubdirectories, sourceFolderPathIsIgnored, type CompiledIgnoredSubdirectories } from '../interfaces/source-folder-path';
import { acceptableFiles } from './main-filenames';

const MAX_ROWS = 100_000;
const MAX_ENTRIES = 10_000;
const MAX_DIRECTORIES = 1_000;
const MAX_DEPTH = 32;
const MAX_FILES = 100;
const CLEANUP_TIMEOUT_MS = 5_000;
const extensions = new Set(acceptableFiles);
const reviews = new WeakSet<object>();
const cleanupFailures = new WeakSet<object>();
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export interface PrivateSourceScanOptions {
  readonly catalogue: FinalObject;
  readonly sourceIndex: number;
  readonly signal: AbortSignal;
  /** Main-owned owner and source-grant authority, already granted before scanning. */
  readonly isCurrent: () => boolean;
}
export interface PrivateSourceScanReview {
  readonly files: readonly string[];
  readonly more: boolean;
  isCurrent(): boolean;
  matchesCatalogue(catalogue: FinalObject): boolean;
  fileCurrent(file: string): boolean;
  dispose(): void;
}
export type PrivateSourceScanResult = { status: 'ready'; review: PrivateSourceScanReview }
  | { status: 'cancelled' | 'invalid' | 'limit' | 'source-unavailable' };
class ScanFailure extends Error {
  constructor(readonly status: 'invalid' | 'limit' | 'source-unavailable') { super('Private source scan is unavailable.'); }
}
function cleanupFailure(): Error {
  const error = new Error('Private source scan cleanup is unavailable.');
  cleanupFailures.add(error); return error;
}
export function isPrivateSourceScanCleanupFailure(error: unknown): error is Error {
  return !!error && typeof error === 'object' && cleanupFailures.has(error);
}
export function isPrivateSourceScanReview(value: unknown): value is PrivateSourceScanReview {
  return !!value && typeof value === 'object' && reviews.has(value);
}
function rootPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 32_768 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new ScanFailure('invalid');
  }
  const root = path.resolve(value);
  if (root === path.parse(root).root) { throw new ScanFailure('invalid'); }
  return root;
}
function locationKey(file: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? file.toLowerCase() : file;
}
function configuration(catalogue: FinalObject, sourceIndex: number) {
  if (!catalogue || typeof catalogue !== 'object' || !Array.isArray(catalogue.images)
    || !catalogue.inputDirs || typeof catalogue.inputDirs !== 'object' || Array.isArray(catalogue.inputDirs)
    || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0) { throw new ScanFailure('invalid'); }
  if (catalogue.images.length > MAX_ROWS) { throw new ScanFailure('limit'); }
  const entries = Object.entries(catalogue.inputDirs);
  if (entries.length > 256) { throw new ScanFailure('limit'); }
  const roots = new Map<number, string>();
  const fingerprint: [number, string][] = [];
  for (const [key, value] of entries) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key))) { throw new ScanFailure('invalid'); }
    roots.set(Number(key), rootPath(value?.path)); fingerprint.push([Number(key), value.path]);
  }
  const root = roots.get(sourceIndex);
  if (!root) { throw new ScanFailure('invalid'); }
  let ignored: CompiledIgnoredSubdirectories;
  try { ignored = compileIgnoredSubdirectories(catalogue.inputDirs[sourceIndex].ignoredSubdirectories); }
  catch { throw new ScanFailure('invalid'); }
  fingerprint.sort((a, b) => a[0] - b[0]);
  const digest = createHash('sha256').update(JSON.stringify([sourceIndex, fingerprint, ignored.scopes])).digest('hex');
  return { root, roots, ignored, digest };
}
function directoryMatches(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return after.isDirectory() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino;
}
function fileMatches(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
async function closeDirectory(directory: fs.Dir): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([directory.close(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(cleanupFailure()), CLEANUP_TIMEOUT_MS);
    })]);
  } catch { throw cleanupFailure(); }
  finally { if (timer) { clearTimeout(timer); } }
}
interface CapturedDirectory { path: string; stat: fs.BigIntStats }
interface Candidate { stat: fs.BigIntStats; parents: CapturedDirectory[] }
class ScanReview implements PrivateSourceScanReview {
  #root: string;
  #rootStat: fs.BigIntStats | undefined;
  #digest: string;
  #sourceIndex: number;
  #signal: AbortSignal;
  #predicate: () => boolean;
  #revoked = false;
  #checking = false;
  #files: readonly string[] = Object.freeze([]);
  #more = false;
  #candidates = new Map<string, Candidate>();
  constructor(options: PrivateSourceScanOptions, root: string, digest: string) {
    this.#root = root; this.#digest = digest; this.#sourceIndex = options.sourceIndex;
    this.#signal = options.signal; this.#predicate = options.isCurrent;
    this.#signal.addEventListener('abort', this.abort, { once: true });
  }
  get files(): readonly string[] { return this.#files; }
  get more(): boolean { return this.#more; }
  private readonly abort = (): void => { this.dispose(); };
  private ownerCurrent(): boolean {
    if (this.#revoked || this.#signal.aborted || this.#checking) { return false; }
    this.#checking = true;
    let current = false;
    try { current = this.#predicate() === true && !this.#revoked && !this.#signal.aborted; }
    catch { /* Main-only errors never expose source paths. */ }
    finally { this.#checking = false; }
    if (!current) { this.dispose(); }
    return current;
  }
  isCurrent(): boolean {
    if (!this.ownerCurrent() || !this.#rootStat) { return false; }
    try {
      const stat = fs.lstatSync(this.#root, { bigint: true });
      if (!directoryMatches(this.#rootStat, stat) || fs.realpathSync.native(this.#root) !== this.#root || !this.ownerCurrent()) {
        throw new Error();
      }
      return true;
    } catch { this.dispose(); return false; }
  }
  private parentsCurrent(parents: CapturedDirectory[]): boolean {
    for (const parent of parents) {
      if (!this.isCurrent()) { return false; }
      const stat = fs.lstatSync(parent.path, { bigint: true });
      if (!directoryMatches(parent.stat, stat) || fs.realpathSync.native(parent.path) !== parent.path || !this.isCurrent()) { return false; }
    }
    return this.isCurrent();
  }
  fileCurrent(file: string): boolean {
    const captured = this.#candidates.get(file);
    if (!captured || !this.isCurrent()) { return false; }
    try {
      if (!this.parentsCurrent(captured.parents)) { throw new Error(); }
      const stat = fs.lstatSync(file, { bigint: true });
      if (!fileMatches(captured.stat, stat) || fs.realpathSync.native(file) !== file || !this.isCurrent()) { throw new Error(); }
      return true;
    } catch { this.dispose(); return false; }
  }
  matchesCatalogue(catalogue: FinalObject): boolean {
    if (!this.isCurrent()) { return false; }
    try { return configuration(catalogue, this.#sourceIndex).digest === this.#digest && this.isCurrent(); }
    catch { return false; }
  }
  async capture(existing: Set<string>, ignored: CompiledIgnoredSubdirectories): Promise<void> {
    if (!this.ownerCurrent()) { throw new Error(); }
    const root = this.#root;
    const initial = await fs.promises.lstat(root, { bigint: true });
    if (!this.ownerCurrent() || !initial.isDirectory() || initial.isSymbolicLink()
      || await fs.promises.realpath(root) !== root || !this.ownerCurrent()) { throw new Error(); }
    this.#rootStat = initial;
    const stack: { directory: CapturedDirectory; parents: CapturedDirectory[]; depth: number }[] = [
      { directory: { path: root, stat: initial }, parents: [], depth: 0 },
    ];
    let directories = 1; let entries = 0;
    scan: while (stack.length) {
      const work = stack.pop()!;
      const parents = [...work.parents, work.directory];
      if (!this.parentsCurrent(parents)) { throw new Error(); }
      let directory: fs.Dir | undefined;
      try {
        // Node's directory API is path-based. Pre/post identity checks detect
        // replacements, but are not a descriptor-relative OS traversal sandbox.
        directory = await fs.promises.opendir(work.directory.path, { bufferSize: 32 });
        if (!this.parentsCurrent(parents)) { throw new Error(); }
        for (;;) {
          if (!this.parentsCurrent(parents)) { throw new Error(); }
          const entry = await directory.read();
          if (!this.parentsCurrent(parents)) { throw new Error(); }
          if (!entry) { break; }
          if (++entries > MAX_ENTRIES) { throw new ScanFailure('limit'); }
          if (entries % 32 === 0) { await turn(); if (!this.isCurrent()) { throw new Error(); } }
          if (!entry.name || entry.name.length > 4096 || /[/\\\0]/.test(entry.name) || ['.', '..'].includes(entry.name)) { throw new Error(); }
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) { continue; }
          const file = path.join(work.directory.path, entry.name);
          const relative = path.relative(root, file).split(path.sep).join('/');
          if (file.length > 32_768 || relative.length > 4096) { throw new ScanFailure('limit'); }
          if (entry.isDirectory()) {
            if (entry.name.startsWith('vha-') || sourceFolderPathIsIgnored(relative, ignored)) { continue; }
            if (work.depth >= MAX_DEPTH || ++directories > MAX_DIRECTORIES) { throw new ScanFailure('limit'); }
            const stat = await fs.promises.lstat(file, { bigint: true });
            if (!this.parentsCurrent(parents)) { throw new Error(); }
            if (stat.isSymbolicLink()) { continue; }
            if (!stat.isDirectory() || await fs.promises.realpath(file) !== file || !this.parentsCurrent(parents)) { throw new Error(); }
            stack.push({ directory: { path: file, stat }, parents, depth: work.depth + 1 });
          } else {
            if (!extensions.has(path.extname(entry.name).slice(1).toLocaleLowerCase('en-US')) || existing.has(locationKey(file))) { continue; }
            const stat = await fs.promises.lstat(file, { bigint: true });
            if (!this.parentsCurrent(parents)) { throw new Error(); }
            if (stat.isSymbolicLink()) { continue; }
            if (!stat.isFile() || await fs.promises.realpath(file) !== file || !this.parentsCurrent(parents)) { throw new Error(); }
            if (stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) { continue; }
            if (this.#candidates.size === MAX_FILES) { this.#more = true; break scan; }
            this.#candidates.set(file, { stat, parents }); existing.add(locationKey(file));
          }
        }
      } finally { if (directory) { await closeDirectory(directory); } }
    }
    for (const file of this.#candidates.keys()) { if (!this.fileCurrent(file)) { throw new Error(); } }
    if (!this.isCurrent()) { throw new Error(); }
    this.#files = Object.freeze([...this.#candidates.keys()].sort());
  }
  dispose(): void {
    this.#revoked = true; this.#signal.removeEventListener('abort', this.abort);
    this.#candidates.clear(); this.#files = Object.freeze([]); this.#root = ''; this.#digest = '';
    this.#rootStat = undefined; this.#predicate = () => false;
  }
}

/** Metadata-only discovery after a native source grant; no original is decoded or modified. */
export async function reviewPrivateSourceScan(options: PrivateSourceScanOptions): Promise<PrivateSourceScanResult> {
  let review: ScanReview | undefined;
  const current = (): boolean => {
    try { return options?.signal instanceof AbortSignal && !options.signal.aborted
      && typeof options.isCurrent === 'function' && options.isCurrent() === true && !options.signal.aborted; }
    catch { return false; }
  };
  try {
    if (!current()) { return { status: 'cancelled' }; }
    const config = configuration(options.catalogue, options.sourceIndex);
    const existing = new Set<string>(); let locations = 0;
    for (const [index, image] of options.catalogue.images.entries()) {
      if (index % 64 === 0) { await turn(); if (!current()) { return { status: 'cancelled' }; } }
      if (!image || typeof image !== 'object') { throw new ScanFailure('invalid'); }
      locations += Array.isArray(image.locations) ? image.locations.length : 1;
      if (locations > MAX_ROWS) { throw new ScanFailure('limit'); }
      if (image.deleted || image.cleanName === '*FOLDER*') { continue; }
      for (const location of getImageLocations(image)) {
        const root = config.roots.get(location.inputSource);
        if (!root || location.fileName.length > 4096) { throw new ScanFailure('invalid'); }
        const file = path.resolve(root, location.partialPath.replace(/^\/+/, ''), location.fileName);
        if (file.length > 32_768) { throw new ScanFailure('invalid'); }
        existing.add(locationKey(file));
      }
    }
    if (!current()) { return { status: 'cancelled' }; }
    review = new ScanReview(options, config.root, config.digest);
    await review.capture(existing, config.ignored);
    if (!current() || !review.isCurrent()) { return { status: current() ? 'source-unavailable' : 'cancelled' }; }
    reviews.add(review); return { status: 'ready', review: Object.freeze(review) };
  } catch (error) {
    if (isPrivateSourceScanCleanupFailure(error)) { throw error; }
    if (!current()) { return { status: 'cancelled' }; }
    return { status: error instanceof ScanFailure ? error.status : 'source-unavailable' };
  } finally { if (review && !reviews.has(review)) { review.dispose(); } }
}
