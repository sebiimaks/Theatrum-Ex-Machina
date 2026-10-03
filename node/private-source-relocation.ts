import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FinalObject } from '../interfaces/final-object.interface';
import { getImageLocations } from '../interfaces/media-locations';

const MAX_SOURCES = 256;
const MAX_ROWS = 100_000;
const MAX_REFERENCES = 100_000;
const CHUNK_SIZE = 32;
const reviews = new WeakSet<object>();

export interface PrivateSourceRelocationReview {
  readonly sourceIndex: number;
  readonly newRoot: string;
  readonly videoCount: number;
  isCurrent(): boolean;
  matchesCatalogue(catalogue: FinalObject): boolean;
  /** Recheck every reviewed file immediately before admitting the catalogue write. */
  validate(): Promise<boolean>;
  dispose(): void;
}
export interface PrivateSourceRelocationOptions {
  readonly catalogue: FinalObject;
  readonly sourceIndex: number;
  /** Selected by the main-owned native directory picker, never the renderer. */
  readonly newRoot: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}
export type PrivateSourceRelocationResult = { status: 'ready'; review: PrivateSourceRelocationReview }
  | { status: 'cancelled' | 'invalid' | 'source-unavailable' };
interface Reference { relative: string; size: number }
interface CatalogueSnapshot { digest: string; videoCount: number; references: Reference[] }
interface CapturedFile extends Reference { stat: fs.BigIntStats }

/** A structural lookalike must not authorize the session's catalogue transaction. */
export function isPrivateSourceRelocationReview(value: unknown): value is PrivateSourceRelocationReview {
  return !!value && typeof value === 'object' && reviews.has(value);
}

function rootPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768
    || value.includes('\0') || !path.isAbsolute(value)) { return; }
  const root = path.resolve(value);
  return root !== path.parse(root).root ? root : undefined;
}
function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function* snapshotSteps(catalogue: FinalObject, sourceIndex: number, newRoot: string): Generator<void, CatalogueSnapshot> {
  if (!catalogue || typeof catalogue !== 'object' || !Array.isArray(catalogue.images)
    || catalogue.images.length > MAX_ROWS || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0
    || !catalogue.inputDirs || typeof catalogue.inputDirs !== 'object' || Array.isArray(catalogue.inputDirs)) { throw new Error(); }
  const sources = Object.entries(catalogue.inputDirs);
  if (sources.length > MAX_SOURCES || !Object.hasOwn(catalogue.inputDirs, sourceIndex)) { throw new Error(); }
  for (const [key, source] of sources) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key))) { throw new Error(); }
    const root = rootPath(source?.path);
    if (!root || overlaps(root, newRoot) || overlaps(newRoot, root)) { throw new Error(); }
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify([sourceIndex, catalogue.inputDirs[sourceIndex].path]));
  const references: Reference[] = [];
  let videoCount = 0;
  let locationCount = 0;
  for (const [index, image] of catalogue.images.entries()) {
    if (index > 0 && index % CHUNK_SIZE === 0) { yield; }
    if (!image || typeof image !== 'object') { throw new Error(); }
    if (image.deleted || image.cleanName === '*FOLDER*') { continue; }
    locationCount += Array.isArray(image.locations) ? image.locations.length : 1;
    if (locationCount > MAX_REFERENCES) { throw new Error(); }
    const locations = getImageLocations(image).filter(location => location.inputSource === sourceIndex);
    if (!locations.length) { continue; }
    if (!Number.isSafeInteger(image.fileSize) || image.fileSize <= 0 || typeof image.hash !== 'string'
      || !/^[a-zA-Z0-9_-]{1,200}$/.test(image.hash)) { throw new Error(); }
    if (locations.some(location => location.fileName.length > 4_096)) { throw new Error(); }
    videoCount++;
    hash.update(JSON.stringify([index, image.hash, image.fileSize, locations]));
    for (const location of locations) {
      const relative = path.join(location.partialPath.replace(/^\/+/, ''), location.fileName);
      const file = path.resolve(newRoot, relative);
      if (relative.length > 32_768 || !overlaps(newRoot, file) || file === newRoot
        || references.length >= MAX_REFERENCES) { throw new Error(); }
      references.push({ relative, size: image.fileSize });
    }
  }
  if (!videoCount) { throw new Error(); }
  return { digest: hash.digest('hex'), videoCount, references };
}
function snapshot(catalogue: FinalObject, sourceIndex: number, newRoot: string): CatalogueSnapshot {
  const reading = snapshotSteps(catalogue, sourceIndex, newRoot);
  let step = reading.next();
  while (!step.done) { step = reading.next(); }
  return step.value;
}
function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && sameIdentity(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Metadata-only review: relative names and sizes, never media-content identity. */
class RelocationReview implements PrivateSourceRelocationReview {
  readonly sourceIndex: number;
  readonly videoCount: number;
  #newRoot: string;
  #digest: string;
  #files: CapturedFile[] = [];
  #root: fs.BigIntStats | undefined;
  #signal: AbortSignal;
  #predicate: () => boolean;
  #revoked = false;
  #checking = false;
  #validating = false;

  constructor(options: PrivateSourceRelocationOptions, newRoot: string, captured: CatalogueSnapshot) {
    this.sourceIndex = options.sourceIndex;
    this.videoCount = captured.videoCount;
    this.#newRoot = newRoot;
    this.#digest = captured.digest;
    this.#signal = options.signal;
    this.#predicate = options.isCurrent;
    this.#signal.addEventListener('abort', this.abort, { once: true });
  }
  get newRoot(): string { return this.#newRoot; }
  private readonly abort = (): void => { this.dispose(); };
  private ownerCurrent(): boolean {
    if (this.#revoked || this.#signal.aborted || this.#checking) { return false; }
    this.#checking = true;
    let current = false;
    try { current = this.#predicate() === true && !this.#revoked && !this.#signal.aborted; }
    catch { /* Never propagate source locations or native errors. */ }
    finally { this.#checking = false; }
    if (!current) { this.dispose(); }
    return current;
  }
  isCurrent(): boolean {
    if (!this.ownerCurrent() || !this.#root) { return false; }
    try {
      const root = fs.lstatSync(this.#newRoot, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || !sameIdentity(this.#root, root)
        || fs.realpathSync.native(this.#newRoot) !== this.#newRoot || !this.ownerCurrent()) { throw new Error(); }
      return true;
    } catch { this.dispose(); return false; }
  }
  /** Do not follow a saved relative-directory symlink while probing its leaf. */
  private async parentsCurrent(relative: string): Promise<boolean> {
    try {
      const segments = path.dirname(relative).split(path.sep).filter(segment => segment !== '.');
      let directory = this.#newRoot;
      for (const [index, segment] of segments.entries()) {
        if (!this.isCurrent()) { return false; }
        directory = path.join(directory, segment);
        const stat = await fs.promises.lstat(directory, { bigint: true });
        if (!this.isCurrent() || !stat.isDirectory() || stat.isSymbolicLink()
          || await fs.promises.realpath(directory) !== directory || !this.isCurrent()) { throw new Error(); }
        if ((index + 1) % CHUNK_SIZE === 0) { await turn(); }
      }
      return this.isCurrent();
    } catch { this.dispose(); return false; }
  }
  async capture(references: Reference[]): Promise<boolean> {
    if (!this.ownerCurrent()) { return false; }
    try {
      const root = await fs.promises.lstat(this.#newRoot, { bigint: true });
      if (!this.ownerCurrent() || !root.isDirectory() || root.isSymbolicLink()
        || await fs.promises.realpath(this.#newRoot) !== this.#newRoot || !this.ownerCurrent()) { throw new Error(); }
      this.#root = root;
      for (const [index, reference] of references.entries()) {
        if (!this.isCurrent() || !await this.parentsCurrent(reference.relative)) { return false; }
        const file = path.join(this.#newRoot, reference.relative);
        const stat = await fs.promises.lstat(file, { bigint: true });
        if (!this.isCurrent() || !stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(reference.size)
          || await fs.promises.realpath(file) !== file || !this.isCurrent()) { throw new Error(); }
        this.#files.push({ ...reference, stat });
        if ((index + 1) % CHUNK_SIZE === 0) { await turn(); }
      }
      return this.isCurrent();
    } catch { this.dispose(); return false; }
  }
  matchesCatalogue(catalogue: FinalObject): boolean {
    if (!this.isCurrent()) { return false; }
    try { return snapshot(catalogue, this.sourceIndex, this.#newRoot).digest === this.#digest && this.isCurrent(); }
    catch { return false; }
  }
  async validate(): Promise<boolean> {
    if (this.#validating || !this.isCurrent()) { return false; }
    this.#validating = true;
    try {
      for (const [index, captured] of this.#files.entries()) {
        if (!this.isCurrent() || !await this.parentsCurrent(captured.relative)) { return false; }
        const file = path.join(this.#newRoot, captured.relative);
        const stat = await fs.promises.lstat(file, { bigint: true });
        if (!this.isCurrent() || !sameFile(captured.stat, stat)
          || await fs.promises.realpath(file) !== file || !this.isCurrent()) { throw new Error(); }
        if ((index + 1) % CHUNK_SIZE === 0) { await turn(); }
      }
      return this.isCurrent();
    } catch { this.dispose(); return false; }
    finally { this.#validating = false; }
  }
  dispose(): void {
    this.#revoked = true;
    this.#signal.removeEventListener('abort', this.abort);
    this.#files = [];
    this.#root = undefined;
    this.#digest = '';
    this.#newRoot = '';
    this.#predicate = () => false;
  }
}

export async function reviewPrivateSourceRelocation(options: PrivateSourceRelocationOptions): Promise<PrivateSourceRelocationResult> {
  let review: RelocationReview | undefined;
  const current = (): boolean => {
    try { return options?.signal instanceof AbortSignal && !options.signal.aborted
      && typeof options.isCurrent === 'function' && options.isCurrent() === true && !options.signal.aborted; }
    catch { return false; }
  };
  try {
    if (!current()) { return { status: 'cancelled' }; }
    const root = rootPath(options.newRoot);
    if (!root) { return { status: 'invalid' }; }
    const reading = snapshotSteps(options.catalogue, options.sourceIndex, root);
    let step = reading.next();
    while (!step.done) {
      await turn();
      if (!current()) { return { status: 'cancelled' }; }
      step = reading.next();
    }
    const captured = step.value;
    if (!current()) { return { status: 'cancelled' }; }
    review = new RelocationReview(options, root, captured);
    if (!await review.capture(captured.references)) {
      return { status: current() ? 'source-unavailable' : 'cancelled' };
    }
    if (!current() || !review.isCurrent()) { review.dispose(); return { status: 'cancelled' }; }
    reviews.add(review);
    Object.freeze(review);
    return { status: 'ready', review };
  } catch { review?.dispose(); return { status: current() ? 'invalid' : 'cancelled' }; }
}
