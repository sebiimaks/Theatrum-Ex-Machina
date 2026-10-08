import type { PrivateHubStore } from './private-hub-store';
import { readPrivatePreviewSet } from './private-hub-preview-set';
import { createPrivateThumbnailOverride, privateThumbnailOverrideMemberId, publishPrivateThumbnailOverride,
  readPrivateThumbnailOverride, type PrivateThumbnailOverride } from './private-thumbnail-override';
import { isPrivatePreviewSource, type PrivatePreviewSource } from './private-preview-source';
import { streamPrivateMediaProcess } from './private-media-process';
import { sanitizePrivateThumbnailPng, validatePrivateThumbnailPngHeader } from './private-thumbnail-png';
import { isPrivatePreviewGenerationCleanupFailure } from './private-hub-preview-generation';
import { validatePrivateJpeg } from './private-preview-plan';
import { admitPrivatePreviewJob } from './private-preview-admission';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
function unavailable(): Error { return new Error('The private thumbnail could not be updated.'); }
function dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 16_384 || height > 16_384 || width * height > 32_000_000) { throw unavailable(); }
}

/** Bounded signature/header check before any decoder sees untrusted compressed pixels. */
export function privateThumbnailInputCodec(bytes: Buffer, byteLength: number): 'mjpeg' | 'png' {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(byteLength) || byteLength < 12 || byteLength > MAX_IMAGE_BYTES
    || bytes.length > MAX_HEADER_BYTES || bytes.length > byteLength) { throw unavailable(); }
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    validatePrivateThumbnailPngHeader(bytes, byteLength);
    return 'png';
  }
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8) { throw unavailable(); }
  let offset = 2;
  let foundDimensions = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) { throw unavailable(); }
    while (bytes[offset] === 0xff) { offset++; }
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length || marker === 0xd9) { throw unavailable(); }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) { throw unavailable(); }
    if (marker === 0xda) {
      if (!foundDimensions || length < 6) { throw unavailable(); }
      return 'mjpeg';
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (foundDimensions || length < 11 || bytes[offset + 2] !== 8 || length !== 8 + 3 * bytes[offset + 7]) { throw unavailable(); }
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      foundDimensions = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
      throw unavailable();
    }
    offset += length;
  }
  throw unavailable();
}

/** Strip every APP/COM header, then require one baseline scan with no later metadata or trailing data. */
export function stripPrivateThumbnailMetadata(bytes: Buffer, width: number, height: number): Buffer {
  validatePrivateJpeg(bytes, width, height);
  const pieces = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) { throw unavailable(); }
    while (bytes[offset] === 0xff) { offset++; }
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) { throw unavailable(); }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) { throw unavailable(); }
    if (marker === 0xc1 || marker === 0xc2) { throw unavailable(); }
    if (marker === 0xda) {
      let scan = offset + length;
      while (scan < bytes.length - 2) {
        if (bytes[scan++] !== 0xff) { continue; }
        while (bytes[scan] === 0xff) { scan++; }
        const code = bytes[scan++];
        if (code !== 0x00 && !(code >= 0xd0 && code <= 0xd7)) { throw unavailable(); }
      }
      if (scan !== bytes.length - 2) { throw unavailable(); }
      pieces.push(bytes.subarray(start));
      const stripped = Buffer.concat(pieces);
      try { validatePrivateJpeg(stripped, width, height); return stripped; }
      catch (error) { stripped.fill(0); throw error; }
    }
    if (marker !== 0xfe && !(marker >= 0xe0 && marker <= 0xef)) { pieces.push(bytes.subarray(start, offset + length)); }
    offset += length;
  }
  throw unavailable();
}

/** One selected still image, encrypted before atomic publication; caller owns the source capability. */
export async function setPrivateCustomThumbnail(store: PrivateHubStore, source: PrivatePreviewSource, height: number,
  options: { signal?: AbortSignal; isCurrent: () => boolean }): Promise<PrivateThumbnailOverride> {
  if (!isPrivatePreviewSource(source) || !options || typeof options.isCurrent !== 'function'
    || ![144, 216, 288, 360, 432, 504].includes(height)
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) { throw unavailable(); }
  const authorized = options.isCurrent;
  const callerSignal = options.signal;
  const releaseAdmission = admitPrivatePreviewJob();
  if (!releaseAdmission) { throw unavailable(); }
  const controller = new AbortController();
  const owned = new Set<Buffer>();
  const revoke = (): void => { controller.abort(); for (const bytes of owned) { bytes.fill(0); } };
  const signals = [store.lockSignal, source.signal, ...(callerSignal ? [callerSignal] : [])];
  let cleanupFailure: Error | undefined;
  let lease: Awaited<ReturnType<PrivatePreviewSource['open']>> | undefined;
  let stream: AsyncIterableIterator<Buffer> | undefined;
  let published: PrivateThumbnailOverride | undefined;
  let failed = false;
  const current = (): boolean => {
    try {
      if (!controller.signal.aborted && !store.locked && source.isCurrent() && authorized() === true
        && !controller.signal.aborted && !store.locked && source.isCurrent()) { return true; }
    } catch { /* Path-bearing errors never leave this boundary. */ }
    revoke(); return false;
  };
  const check = (): void => { if (!current()) { throw unavailable(); } };
  const own = (bytes: Buffer): Buffer => { owned.add(bytes); return bytes; };
  for (const signal of signals) { signal.addEventListener('abort', revoke, { once: true }); if (signal.aborted) { revoke(); } }
  try {
    check();
    if (source.byteLength < 12 || source.byteLength > MAX_IMAGE_BYTES) { throw unavailable(); }
    const set = await readPrivatePreviewSet(store, source.hash); check();
    const previous = await readPrivateThumbnailOverride(store, source.hash); check();
    const output = createPrivateThumbnailOverride(source.hash, set?.generation ?? 'legacy', set?.height ?? height);
    lease = await source.open(); check();
    const header = own(await lease.read(0, Math.min(source.byteLength, MAX_HEADER_BYTES))); check();
    const codec = privateThumbnailInputCodec(header, source.byteLength);
    header.fill(0); owned.delete(header);
    let png: Buffer | undefined;
    if (codec === 'png') {
      // Remove even compressed metadata before the native decoder sees it.
      // Capability reads stay bounded; no decoded or intermediate file is written.
      const original = own(Buffer.alloc(source.byteLength));
      for (let offset = 0; offset < original.length; offset += MAX_HEADER_BYTES) {
        const part = own(await lease.read(offset, Math.min(MAX_HEADER_BYTES, original.length - offset)));
        check(); part.copy(original, offset); part.fill(0); owned.delete(part);
      }
      check(); png = own(sanitizePrivateThumbnailPng(original));
      original.fill(0); owned.delete(original); check();
    }
    const input = png ? (async function* () {
      for (let offset = 0; offset < png.length; offset += 64 * 1024) {
        check(); yield png.subarray(offset, Math.min(offset + 64 * 1024, png.length));
      }
    })() : undefined;
    const transparency = codec === 'png' ? 'format=gbrap,premultiply=inplace=1,format=rgb24,' : '';
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '268435456', '-filter_threads', '1',
      '-filter_complex_threads', '1', '-threads', '1', '-protocol_whitelist', 'fd,pipe',
      ...(codec === 'mjpeg' ? ['-fd', '3'] : []),
      '-f', 'image2pipe', '-c:v', codec, '-i', codec === 'mjpeg' ? 'fd:' : 'pipe:0', '-map', '0:v:0', '-an', '-sn', '-dn',
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-metadata', 'encoder=',
      '-metadata:s:v', 'encoder=', '-metadata:s:v', 'rotate=0', '-fflags', '+bitexact', '-flags:v', '+bitexact',
      '-threads', '1', '-frames:v', '1', '-vf', `${transparency}scale=w=${output.width}:h=${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'];
    stream = streamPrivateMediaProcess({ tool: 'ffmpeg', args, sourceFd: codec === 'mjpeg' ? lease.fd : undefined, input, signal: controller.signal,
      isCurrent: current, maximumBytes: MAX_IMAGE_BYTES, timeoutMs: 30_000 });
    const pieces: Buffer[] = [];
    let total = 0;
    while (true) {
      const next = await stream.next();
      if (!next.done) { own(next.value); }
      check();
      if (next.done) { break; }
      const bytes = own(next.value); total += bytes.length;
      if (total > MAX_IMAGE_BYTES) { throw unavailable(); }
      pieces.push(bytes);
    }
    check();
    const encoded = own(Buffer.concat(pieces, total));
    for (const bytes of pieces) { bytes.fill(0); owned.delete(bytes); }
    const jpeg = own(stripPrivateThumbnailMetadata(encoded, output.width, output.height));
    encoded.fill(0); owned.delete(encoded); check();
    const member = privateThumbnailOverrideMemberId(output);
    await store.writeNewRecord(member, jpeg); check();
    const verified = own(await store.readRecord(member, jpeg.length)); check();
    if (!verified.equals(jpeg)) { throw unavailable(); }
    const latest = await readPrivatePreviewSet(store, source.hash); check();
    const latestOverride = await readPrivateThumbnailOverride(store, source.hash); check();
    if (JSON.stringify(latest) !== JSON.stringify(set) || JSON.stringify(latestOverride) !== JSON.stringify(previous)) { throw unavailable(); }
    await publishPrivateThumbnailOverride(store, output, current); check();
    published = output;
  } catch (error) {
    failed = true;
    if (isPrivatePreviewGenerationCleanupFailure(error)) { cleanupFailure = error; }
  } finally {
    revoke();
    for (const cleanup of [() => stream?.return?.(), () => lease?.close()]) {
      try { await cleanup(); }
      catch (error) { failed = true; if (isPrivatePreviewGenerationCleanupFailure(error)) { cleanupFailure ??= error; } }
    }
    for (const signal of signals) { signal.removeEventListener('abort', revoke); }
    owned.clear();
    if (!cleanupFailure) { releaseAdmission(); }
  }
  if (cleanupFailure) { throw cleanupFailure; }
  try {
    if (failed || !published || callerSignal?.aborted || store.locked || !source.isCurrent() || authorized() !== true
      || callerSignal?.aborted || store.locked || !source.isCurrent()) { throw unavailable(); }
    return published;
  } catch { throw unavailable(); }
}
