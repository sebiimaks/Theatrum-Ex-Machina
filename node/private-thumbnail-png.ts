import { crc32 } from 'node:zlib';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const IHDR = Buffer.from('IHDR', 'ascii');
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
};

function unavailable(): Error { return new Error('The private thumbnail could not be updated.'); }

/** The PNG decoder loses tRNS below eight-bit grayscale; palette indices use the same packed pixels. */
function normalizeGrayscaleTransparency(pieces: Buffer[], transparencyIndex: number, transparentSample: number): Buffer {
  const owned: Buffer[] = [];
  try {
    const header = Buffer.from(pieces[0]); owned.push(header);
    const entries = 2 ** header[24];
    header[25] = 3;
    header.writeUInt32BE(crc32(header.subarray(12, 29)), 29);
    const palette = Buffer.alloc(12 + entries * 3); owned.push(palette);
    palette.writeUInt32BE(entries * 3, 0); palette.write('PLTE', 4, 4, 'ascii');
    for (let index = 0; index < entries; index++) {
      palette.fill(index * 255 / (entries - 1), 8 + index * 3, 11 + index * 3);
    }
    palette.writeUInt32BE(crc32(palette.subarray(4, -4)), palette.length - 4);
    const transparency = Buffer.alloc(12 + entries); owned.push(transparency);
    transparency.writeUInt32BE(entries, 0); transparency.write('tRNS', 4, 4, 'ascii');
    transparency.fill(255, 8, 8 + entries); transparency[8 + transparentSample] = 0;
    transparency.writeUInt32BE(crc32(transparency.subarray(4, -4)), transparency.length - 4);
    return Buffer.concat([header, palette, transparency,
      ...pieces.filter((_, index) => index !== 0 && index !== transparencyIndex)]);
  } finally {
    for (const bytes of owned) { bytes.fill(0); }
  }
}

/** Validate dimensions and the first chunk before allocating or decoding compressed pixels. */
export function validatePrivateThumbnailPngHeader(bytes: Buffer, byteLength: number): void {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(byteLength) || byteLength < 33 || byteLength > MAX_BYTES
    || bytes.length < 33 || bytes.length > byteLength || !bytes.subarray(0, 8).equals(SIGNATURE)
    || bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(IHDR)
    || crc32(bytes.subarray(12, 29)) !== bytes.readUInt32BE(29)) { throw unavailable(); }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24];
  const colour = bytes[25];
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 32_000_000
    || !Object.hasOwn(DEPTHS, colour) || !DEPTHS[colour].includes(depth)
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) { throw unavailable(); }
}

/**
 * Retain only pixel chunks in one bounded still PNG. In particular, compressed
 * text and profiles never reach the decoder's metadata inflation routines.
 * The caller owns the original; the returned independent buffer must be wiped.
 */
export function sanitizePrivateThumbnailPng(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes)) { throw unavailable(); }
  validatePrivateThumbnailPngHeader(bytes, bytes.length);
  const depth = bytes[24];
  const colour = bytes[25];
  const pieces = [bytes.subarray(0, 33)];
  let offset = 33;
  let chunks = 1;
  let paletteEntries = 0;
  let transparency = false;
  let transparencyIndex = -1;
  let transparentSample = -1;
  let imageData = false;
  let imageDataEnded = false;
  let compressedBytes = 0;
  while (offset < bytes.length) {
    if (++chunks > MAX_CHUNKS || bytes.length - offset < 12) { throw unavailable(); }
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) { throw unavailable(); }
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    // PNG's reserved bit (the third letter) must be zero, and names contain only letters.
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)
      || !Buffer.from(type, 'ascii').equals(bytes.subarray(offset + 4, offset + 8))
      || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) { throw unavailable(); }
    if (imageData && type !== 'IDAT') { imageDataEnded = true; }
    switch (type) {
      case 'IHDR': case 'acTL': case 'fcTL': case 'fdAT':
        throw unavailable();
      case 'PLTE':
        if (paletteEntries || transparency || imageData || colour === 0 || colour === 4
          || length < 3 || length > 768 || length % 3 !== 0
          || (colour === 3 && length / 3 > 2 ** depth)) { throw unavailable(); }
        paletteEntries = length / 3;
        pieces.push(bytes.subarray(offset, end));
        break;
      case 'tRNS':
        if (transparency || imageData
          || (colour === 3 ? !paletteEntries || length < 1 || length > paletteEntries
            : colour === 0 ? length !== 2 : colour === 2 ? length !== 6 : true)) { throw unavailable(); }
        if (colour !== 3) {
          for (let channel = offset + 8; channel < end - 4; channel += 2) {
            if (bytes.readUInt16BE(channel) >= 2 ** depth) { throw unavailable(); }
          }
        }
        transparency = true;
        if (colour === 0 && depth < 8) {
          transparencyIndex = pieces.length;
          transparentSample = bytes.readUInt16BE(offset + 8);
        }
        pieces.push(bytes.subarray(offset, end));
        break;
      case 'IDAT':
        if (imageDataEnded || (colour === 3 && !paletteEntries)) { throw unavailable(); }
        imageData = true;
        compressedBytes += length;
        pieces.push(bytes.subarray(offset, end));
        break;
      case 'IEND':
        if (length !== 0 || !imageData || compressedBytes === 0 || end !== bytes.length) { throw unavailable(); }
        pieces.push(bytes.subarray(offset, end));
        return transparencyIndex >= 0 ? normalizeGrayscaleTransparency(pieces, transparencyIndex, transparentSample)
          : Buffer.concat(pieces);
      default:
        if (type[0] === type[0].toUpperCase()) { throw unavailable(); }
        // All remaining ancillary chunks are metadata, not required for pixel decoding.
    }
    offset = end;
  }
  throw unavailable();
}
