import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import type { PrivateHubStore } from './private-hub-store';
import { writePrivateHubMedia } from './private-hub-media';
import { createPrivatePreviewSet, privatePreviewSetMemberId, publishPrivatePreviewSet, readPrivatePreviewSet,
  type PrivatePreviewSet } from './private-hub-preview-set';
import { isPrivateMediaProcessCleanupFailure, streamPrivateMediaProcess } from './private-media-process';
import { buildPrivatePreviewPlan, parsePrivateProbe, privateProbeCommand, validatePrivateJpeg,
  type PrivateMediaCommandPlan } from './private-preview-plan';
import { isPrivatePreviewSource, isPrivatePreviewSourceCleanupFailure, type PrivatePreviewSource } from './private-preview-source';

let generating = false;
function unavailable(): Error { return new Error('Private preview generation could not be completed.'); }
/** Trusted main-only cleanup classification, preserved across nested producers. */
export function isPrivatePreviewGenerationCleanupFailure(error: unknown): error is Error {
  return isPrivateMediaProcessCleanupFailure(error) || isPrivatePreviewSourceCleanupFailure(error);
}
export interface PrivatePreviewGenerationOptions {
  /** Trusted main-process session/catalogue authority; never supplied by the renderer. */
  isCurrent: () => boolean;
  signal?: AbortSignal;
  /** Session regeneration must preserve the authenticated catalogue's strip geometry. */
  expectedScreenCount?: number;
}

/**
 * Main-process backend, not an IPC handler. One admitted job globally bounds
 * decoder concurrency: one encoder and (for filmstrips/clips) one assembler.
 * Every asset is encrypted under an immutable generation before publication.
 * The caller owns and must close the source capability after the operation.
 */
export async function generatePrivateHubPreviews(
  store: PrivateHubStore, source: PrivatePreviewSource, settings: ScreenshotSettings,
  options: PrivatePreviewGenerationOptions,
): Promise<PrivatePreviewSet> {
  if (generating || !isPrivatePreviewSource(source) || !options || typeof options.isCurrent !== 'function') { throw unavailable(); }
  const screenshotSettings = Object.freeze({ ...settings });
  const authorized = options.isCurrent;
  const callerSignal = options.signal;
  const expectedScreenCount = options.expectedScreenCount;
  if (expectedScreenCount !== undefined && (!Number.isSafeInteger(expectedScreenCount) || expectedScreenCount < 1 || expectedScreenCount > 255)) {
    throw unavailable();
  }
  let published: PrivatePreviewSet | undefined;
  let failed = false;
  let cleanupFailure: Error | undefined;
  const rememberCleanupFailure = (error: unknown): void => {
    if (isPrivatePreviewGenerationCleanupFailure(error)) { cleanupFailure ??= error; }
  };
  const controller = new AbortController();
  const owned = new Set<Buffer>();
  const running = new Set<AsyncGenerator<Buffer>>();
  const revoke = (): void => { controller.abort(); for (const bytes of owned) { bytes.fill(0); } };
  const signals = [store.lockSignal, source.signal, ...(callerSignal ? [callerSignal] : [])];
  const isCurrent = (): boolean => {
    let current = false;
    try {
      current = !controller.signal.aborted && !store.locked && source.isCurrent() && authorized() === true
        && !controller.signal.aborted && !store.locked && source.isCurrent();
    } catch { /* fail closed without exposing source diagnostics */ }
    if (!current) { revoke(); }
    return current;
  };
  const check = (): void => { if (!isCurrent()) { throw unavailable(); } };
  const discard = (bytes: Buffer): void => { bytes.fill(0); owned.delete(bytes); };
  generating = true;
  for (const signal of signals) {
    signal.addEventListener('abort', revoke, { once: true });
    if (signal.aborted) { revoke(); }
  }

  async function drain(
    stream: AsyncIterableIterator<Buffer> | undefined,
    lease: Awaited<ReturnType<PrivatePreviewSource['open']>> | undefined,
  ): Promise<void> {
    let failure: unknown;
    try { await stream?.return?.(); }
    catch (error) { rememberCleanupFailure(error); failure = error; }
    try { await lease?.close(); }
    catch (error) { rememberCleanupFailure(error); failure ??= error; }
    if (failure !== undefined) { throw failure; }
  }

  function run(plan: PrivateMediaCommandPlan, input?: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
    const iterator = (async function* (): AsyncGenerator<Buffer> {
      let lease: Awaited<ReturnType<PrivatePreviewSource['open']>> | undefined;
      let stream: AsyncIterableIterator<Buffer> | undefined;
      try {
        check();
        lease = input ? undefined : await source.open();
        check();
        stream = streamPrivateMediaProcess({ ...plan, ...(lease ? { sourceFd: lease.fd } : { input }),
          signal: controller.signal, isCurrent });
        // Drain explicitly: for-await can suppress return() failures when its
        // body already threw, which would hide an unreaped child on revocation.
        while (true) {
          const next = await stream.next();
          if (next.done) { break; }
          const bytes = next.value;
          owned.add(bytes);
          try { check(); yield bytes; }
          finally { discard(bytes); }
        }
        check();
      } catch (error) {
        rememberCleanupFailure(error);
        throw error;
      } finally {
        try { await drain(stream, lease); }
        finally { running.delete(iterator); }
      }
    })();
    running.add(iterator);
    return iterator;
  }

  async function collect(plan: PrivateMediaCommandPlan, input?: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let total = 0;
    let result: Buffer | undefined;
    try {
      for await (const bytes of run(plan, input)) {
        check();
        total += bytes.length;
        if (total > plan.maximumBytes) { throw unavailable(); }
        const copy = Buffer.from(bytes);
        owned.add(copy);
        pieces.push(copy);
      }
      check();
      if (total === 0) { throw unavailable(); }
      result = Buffer.concat(pieces, total);
      owned.add(result);
      check();
      return result;
    } catch (error) { if (result) { discard(result); } throw error; }
    finally { for (const bytes of pieces) { discard(bytes); } }
  }

  async function image(plan: PrivateMediaCommandPlan, width: number, height: number, input?: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const bytes = await collect(plan, input);
    try { check(); validatePrivateJpeg(bytes, width, height); return bytes; }
    catch (error) { discard(bytes); throw error; }
  }

  async function saveImage(set: PrivatePreviewSet, kind: 'thumbnail' | 'filmstrip' | 'clip-poster', bytes: Buffer): Promise<void> {
    let verified: Buffer | undefined;
    try {
      check();
      const id = privatePreviewSetMemberId(set, kind);
      await store.writeNewRecord(id, bytes);
      check();
      verified = await store.readRecord(id, bytes.length);
      owned.add(verified);
      check();
      if (!verified.equals(bytes)) { throw unavailable(); }
    } finally { discard(bytes); if (verified) { discard(verified); } }
  }

  try {
    check();
    // Reject corruption of an existing active set before staging a replacement.
    await readPrivatePreviewSet(store, source.hash);
    check();
    const probe = await collect(privateProbeCommand());
    let plan: ReturnType<typeof buildPrivatePreviewPlan>;
    try { check(); plan = buildPrivatePreviewPlan(parsePrivateProbe(probe), screenshotSettings); }
    finally { discard(probe); }
    if (expectedScreenCount !== undefined && plan.screenCount !== expectedScreenCount) { throw unavailable(); }
    const set = createPrivatePreviewSet(source.hash, plan.width, plan.height, plan.screenCount, !!plan.clip);
    await saveImage(set, 'thumbnail', await image(plan.thumbnail, plan.width, plan.height));
    const frames = async function* (): AsyncGenerator<Buffer> {
      for (const frame of plan.frames) {
        const bytes = await image(frame, plan.width, plan.height);
        try { check(); yield bytes; }
        finally { discard(bytes); }
      }
    };
    await saveImage(set, 'filmstrip', await image(plan.filmstrip, plan.width * plan.screenCount, plan.height, frames()));
    if (plan.clip) {
      const clip = plan.clip;
      await saveImage(set, 'clip-poster', await image(clip.poster, clip.width, clip.height));
      const snippets = async function* (): AsyncGenerator<Buffer> {
        for (const snippet of clip.snippets) { yield* run(snippet); }
      };
      await writePrivateHubMedia(store, privatePreviewSetMemberId(set, 'clip'), run(clip.remux, snippets()));
    }
    check();
    // Store rechecks this guard after staging/fsync, immediately before the
    // final rename/link. After submission, completion can be uncertain; it is
    // never safe to claim rollback for an already-published filesystem write.
    await publishPrivatePreviewSet(store, set, isCurrent);
    check();
    published = set;
  } catch (error) { failed = true; rememberCleanupFailure(error); }
  finally {
    revoke();
    // Chunk storage requests iterator cancellation without waiting on arbitrary
    // producers. Here we own the producers, so also drain their child processes
    // and descriptor leases before admitting another generation job.
    const drained = await Promise.allSettled([...running].map(iterator => iterator.return(undefined)));
    for (const result of drained) {
      if (result.status === 'rejected') { failed = true; rememberCleanupFailure(result.reason); }
    }
    for (const signal of signals) { signal.removeEventListener('abort', revoke); }
    owned.clear();
    // Unproven decoder/descriptor cleanup quarantines generation for the rest
    // of this process. Normal cancellation may release admission only after
    // every owned producer and descriptor has completed its cleanup.
    if (!cleanupFailure) { generating = false; }
  }
  if (cleanupFailure) { throw cleanupFailure; }
  if (failed) { throw unavailable(); }
  // Cleanup awaits child/descriptor drainage. Revocation during that wait must
  // not return success; the publication itself may already have committed.
  try {
    if (!published || callerSignal?.aborted || store.locked || !source.isCurrent() || authorized() !== true
      || callerSignal?.aborted || store.locked || !source.isCurrent()) { throw unavailable(); }
    return published;
  } catch { throw unavailable(); }
}
