import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FinalObject } from '../interfaces/final-object.interface';

const MAX_SOURCES = 256;
const MAX_ROWS = 100_000;
const MAX_LOCATIONS = 100_000;
const CHUNK_SIZE = 64;
const reviews = new WeakSet<object>();

export interface PrivateSourceAdditionReview {
  readonly sourceIndex: number;
  readonly newRoot: string;
  isCurrent(): boolean;
  matchesCatalogue(catalogue: FinalObject): boolean;
  /** Recheck only the selected directory identity; never enumerate its contents. */
  validate(): Promise<boolean>;
  dispose(): void;
}
export interface PrivateSourceAdditionOptions {
  readonly catalogue: FinalObject;
  /** Main-owned native picker result, never a renderer-supplied path. */
  readonly newRoot: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}
export type PrivateSourceAdditionResult = { status: 'ready'; review: PrivateSourceAdditionReview }
  | { status: 'invalid' | 'duplicate' | 'limit' | 'source-unavailable' | 'cancelled' };
interface Snapshot { sourceIndex: number; digest: string }
class ReviewFailure extends Error {
  constructor(readonly status: 'invalid' | 'duplicate' | 'limit') { super('Private source addition is unavailable.'); }
}

export function isPrivateSourceAdditionReview(value: unknown): value is PrivateSourceAdditionReview {
  return !!value && typeof value === 'object' && reviews.has(value);
}
function rootPath(value: unknown, canonical = true): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768
    || value.includes('\0') || !path.isAbsolute(value)) { return; }
  const root = path.resolve(value);
  return (!canonical || root === value) && root !== path.parse(root).root ? root : undefined;
}
function comparisonPath(value: string): string {
  return process.platform === 'darwin' || process.platform === 'win32' ? value.normalize('NFC').toLowerCase() : value;
}
function within(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
export function privateSourceRootsOverlap(left: string, right: string): boolean {
  const first = comparisonPath(path.resolve(left));
  const second = comparisonPath(path.resolve(right));
  return within(first, second) || within(second, first);
}
function* snapshotSteps(catalogue: FinalObject, newRoot: string): Generator<void, Snapshot> {
  if (!catalogue || typeof catalogue !== 'object' || !Array.isArray(catalogue.images)
    || !catalogue.inputDirs || typeof catalogue.inputDirs !== 'object' || Array.isArray(catalogue.inputDirs)) {
    throw new ReviewFailure('invalid');
  }
  const sources = Object.entries(catalogue.inputDirs);
  if (sources.length >= MAX_SOURCES || catalogue.images.length > MAX_ROWS) { throw new ReviewFailure('limit'); }
  let maximumIndex = -1;
  const index = (value: unknown): void => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) { throw new ReviewFailure('invalid'); }
    maximumIndex = Math.max(maximumIndex, value as number);
  };
  const roots: [string, string][] = [];
  const selected = comparisonPath(newRoot);
  for (const [key, source] of sources) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key))) { throw new ReviewFailure('invalid'); }
    index(Number(key));
    const root = rootPath(source?.path, false);
    if (!root) { throw new ReviewFailure('invalid'); }
    const existing = comparisonPath(root);
    if (existing === selected) { throw new ReviewFailure('duplicate'); }
    if (within(existing, selected) || within(selected, existing)) { throw new ReviewFailure('invalid'); }
    roots.push([key, source.path]);
  }
  let locationCount = 0;
  for (const [row, image] of catalogue.images.entries()) {
    if (row > 0 && row % CHUNK_SIZE === 0) { yield; }
    if (!image || typeof image !== 'object' || Array.isArray(image)) { throw new ReviewFailure('invalid'); }
    // Even deleted rows, placeholders and legacy mirrors reserve their source
    // index. Adding a root must never reconnect a previously dangling reference.
    const legacyValue: unknown = image.inputSource;
    const legacyIndex = typeof legacyValue === 'string' && legacyValue.trim() !== '' ? Number(legacyValue) : legacyValue;

    index(legacyIndex);
    if (image.locations !== undefined) {
      if (!Array.isArray(image.locations) || image.locations.length === 0) { throw new ReviewFailure('invalid'); }
      locationCount += image.locations.length;
      if (locationCount > MAX_LOCATIONS) { throw new ReviewFailure('limit'); }
      for (const [locationIndex, location] of image.locations.entries()) {
        if (locationIndex > 0 && locationIndex % CHUNK_SIZE === 0) { yield; }
        if (!location || typeof location !== 'object' || Array.isArray(location)) { throw new ReviewFailure('invalid'); }
        index(location.inputSource);
      }
    }
  }
  if (maximumIndex >= Number.MAX_SAFE_INTEGER) { throw new ReviewFailure('limit'); }
  const sourceIndex = maximumIndex + 1;
  roots.sort((left, right) => Number(left[0]) - Number(right[0]));
  return { sourceIndex, digest: createHash('sha256').update(JSON.stringify([roots, sourceIndex])).digest('hex') };
}
function snapshot(catalogue: FinalObject, newRoot: string): Snapshot {
  const steps = snapshotSteps(catalogue, newRoot);
  let step = steps.next();
  while (!step.done) { step = steps.next(); }
  return step.value;
}
function sameDirectory(captured: fs.BigIntStats, current: fs.BigIntStats): boolean {
  return current.isDirectory() && !current.isSymbolicLink() && current.dev === captured.dev && current.ino === captured.ino;
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

class AdditionReview implements PrivateSourceAdditionReview {
  readonly sourceIndex: number;
  #root: string;
  #digest: string;
  #identity: fs.BigIntStats | undefined;
  #signal: AbortSignal;
  #predicate: () => boolean;
  #revoked = false;
  #checking = false;
  #validating = false;

  constructor(options: PrivateSourceAdditionOptions, root: string, captured: Snapshot) {
    this.sourceIndex = captured.sourceIndex;
    this.#root = root;
    this.#digest = captured.digest;
    this.#signal = options.signal;
    this.#predicate = options.isCurrent;
    this.#signal.addEventListener('abort', this.abort, { once: true });
  }
  get newRoot(): string { return this.#root; }
  private readonly abort = (): void => { this.dispose(); };
  private ownerCurrent(): boolean {
    if (this.#revoked || this.#signal.aborted || this.#checking) { return false; }
    this.#checking = true;
    let current = false;
    try { current = this.#predicate() === true && !this.#revoked && !this.#signal.aborted; }
    catch { /* Native paths and errors never leave this review. */ }
    finally { this.#checking = false; }
    if (!current) { this.dispose(); }
    return current;
  }
  isCurrent(): boolean {
    if (!this.ownerCurrent() || !this.#identity) { return false; }
    try {
      const identity = fs.lstatSync(this.#root, { bigint: true });
      if (!sameDirectory(this.#identity, identity) || fs.realpathSync.native(this.#root) !== this.#root
        || !this.ownerCurrent()) { throw new Error(); }
      return true;
    } catch { this.dispose(); return false; }
  }
  async capture(): Promise<boolean> {
    if (!this.ownerCurrent()) { return false; }
    try {
      const identity = await fs.promises.lstat(this.#root, { bigint: true });
      if (!this.ownerCurrent() || !identity.isDirectory() || identity.isSymbolicLink()
        || await fs.promises.realpath(this.#root) !== this.#root || !this.ownerCurrent()) { throw new Error(); }
      this.#identity = identity;
      return this.isCurrent();
    } catch { this.dispose(); return false; }
  }
  matchesCatalogue(catalogue: FinalObject): boolean {
    if (!this.isCurrent()) { return false; }
    try { return snapshot(catalogue, this.#root).digest === this.#digest && this.isCurrent(); }
    catch { return false; }
  }
  async validate(): Promise<boolean> {
    if (this.#validating || !this.isCurrent()) { return false; }
    this.#validating = true;
    try {
      const identity = await fs.promises.lstat(this.#root, { bigint: true });
      if (!this.isCurrent() || !this.#identity || !sameDirectory(this.#identity, identity)
        || await fs.promises.realpath(this.#root) !== this.#root || !this.isCurrent()) { throw new Error(); }
      return true;
    } catch { this.dispose(); return false; }
    finally { this.#validating = false; }
  }
  dispose(): void {
    this.#revoked = true;
    this.#signal.removeEventListener('abort', this.abort);
    this.#root = '';
    this.#digest = '';
    this.#identity = undefined;
    this.#predicate = () => false;
  }
}

/** Save a directory identity only; no enumeration, media read, or access grant. */
export async function reviewPrivateSourceAddition(options: PrivateSourceAdditionOptions): Promise<PrivateSourceAdditionResult> {
  let review: AdditionReview | undefined;
  let retained = false;
  const current = (): boolean => {
    try { return options?.signal instanceof AbortSignal && !options.signal.aborted
      && typeof options.isCurrent === 'function' && options.isCurrent() === true && !options.signal.aborted; }
    catch { return false; }
  };
  try {
    if (!current()) { return { status: 'cancelled' }; }
    const root = rootPath(options.newRoot);
    if (!root) { return { status: 'invalid' }; }
    const reading = snapshotSteps(options.catalogue, root);
    let step = reading.next();
    while (!step.done) {
      await turn();
      if (!current()) { return { status: 'cancelled' }; }
      step = reading.next();
    }
    if (!current()) { return { status: 'cancelled' }; }
    review = new AdditionReview(options, root, step.value);
    if (!await review.capture()) { return { status: current() ? 'source-unavailable' : 'cancelled' }; }
    if (!current() || !review.isCurrent()) { return { status: 'cancelled' }; }
    reviews.add(review);
    Object.freeze(review);
    retained = true;
    return { status: 'ready', review };
  } catch (error) {
    return { status: !current() ? 'cancelled' : error instanceof ReviewFailure ? error.status : 'invalid' };
  } finally { if (!retained) { review?.dispose(); } }
}
