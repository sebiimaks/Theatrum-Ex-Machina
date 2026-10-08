import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { sanitizePrivateThumbnailPng, validatePrivateThumbnailPngHeader } from './private-thumbnail-png';

const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4); return result;
}
function header(width = 8, height = 8, depth = 8, colour = 6, interlace = 0): Buffer {
  const data = Buffer.alloc(13); data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = colour; data[12] = interlace;
  return Buffer.concat([signature, chunk('IHDR', data)]);
}
function png(parts: Buffer[] = [], first = header()): Buffer {
  return Buffer.concat([first, ...parts, chunk('IDAT', Buffer.from([1])), chunk('IEND')]);
}
function refuses(bytes: Buffer): void {
  assert.throws(() => sanitizePrivateThumbnailPng(bytes), { message: 'The private thumbnail could not be updated.' });
}

for (const [colour, depths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]] as const) {
  for (const depth of depths) {
    test(`PNG accepts colour ${colour}, depth ${depth}, and both interlace modes`, () => {
      for (const interlace of [0, 1]) {
        const bytes = png(colour === 3 ? [chunk('PLTE', Buffer.from([255, 0, 0]))] : [], header(8, 8, depth, colour, interlace));
        const result = sanitizePrivateThumbnailPng(bytes);
        assert.deepEqual(result, bytes); assert.notEqual(result, bytes);
        result.fill(0); assert.ok(bytes.some(byte => byte !== 0));
      }
    });
  }
}
test('PNG bounds the encoded size, dimensions and total pixels before decoding', () => {
  for (const [width, height] of [[0, 1], [1, 0], [16385, 1], [1, 16385], [8000, 4001], [0xffffffff, 1]]) {
    assert.throws(() => validatePrivateThumbnailPngHeader(header(width, height), 100));
  }
  validatePrivateThumbnailPngHeader(header(8000, 4000), 32 * 1024 * 1024);
  validatePrivateThumbnailPngHeader(header(16384, 1), 100);
  for (const size of [32, -1, NaN, 1.5, 32 * 1024 * 1024 + 1]) {
    assert.throws(() => validatePrivateThumbnailPngHeader(header(), size));
  }
  assert.throws(() => validatePrivateThumbnailPngHeader(Buffer.alloc(34), 33));
  assert.throws(() => validatePrivateThumbnailPngHeader(undefined as unknown as Buffer, 100));
});
test('PNG refuses forged signatures, truncated or corrupt IHDR, and invalid encoding parameters', () => {
  const valid = header();
  for (const offset of [0, 8, 12, 29]) {
    const bytes = Buffer.from(valid); bytes[offset] ^= 1;
    assert.throws(() => validatePrivateThumbnailPngHeader(bytes, bytes.length));
  }
  for (const length of [0, 8, 32]) { assert.throws(() => validatePrivateThumbnailPngHeader(valid.subarray(0, length), 100)); }
  for (const [depth, colour] of [[0, 0], [3, 0], [4, 2], [16, 3], [1, 4], [4, 6], [8, 1], [8, 5], [8, 255]]) {
    assert.throws(() => validatePrivateThumbnailPngHeader(header(8, 8, depth, colour), 100));
  }
  for (const offset of [26, 27, 28]) {
    const bytes = header(); bytes[offset] = 2; bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    assert.throws(() => validatePrivateThumbnailPngHeader(bytes, 100));
  }
  const highBit = header(); highBit[12] |= 0x80; highBit.writeUInt32BE(crc32(highBit.subarray(12, 29)), 29);
  assert.throws(() => validatePrivateThumbnailPngHeader(highBit, 100));
});
test('PNG strips all ancillary metadata, including compressed profiles and text after pixels, without inflating it', () => {
  const marker = Buffer.from('PRIVATE_PNG_METADATA');
  const types = ['tEXt', 'zTXt', 'iTXt', 'iCCP', 'eXIf', 'gAMA', 'cHRM', 'sRGB', 'pHYs', 'vpAg'];
  const bytes = Buffer.concat([header(), ...types.map(type => chunk(type, marker)),
    chunk('IDAT', Buffer.from([1])), ...types.map(type => chunk(type, marker)), chunk('IEND')]);
  const original = Buffer.from(bytes);
  const sanitized = sanitizePrivateThumbnailPng(bytes);
  assert.deepEqual(sanitized, png()); assert.equal(sanitized.includes(marker), false);
  assert.deepEqual(bytes, original);
});
test('PNG preserves palette and transparency pixel information', () => {
  for (const [colour, depth, parts] of [
    [3, 1, [chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])), chunk('tRNS', Buffer.from([0, 128]))]],
    [0, 8, [chunk('tRNS', Buffer.from([0, 255]))]],
    [0, 16, [chunk('tRNS', Buffer.from([255, 255]))]],
    [2, 8, [chunk('tRNS', Buffer.from([0, 255, 0, 0, 0, 255]))]],
    [2, 16, [chunk('tRNS', Buffer.from([255, 255, 128, 128, 0, 0]))]],
    [6, 8, [chunk('PLTE', Buffer.from([255, 0, 0]))]],
  ] as [number, number, Buffer[]][]) {
    const bytes = png(parts, header(8, 8, depth, colour)); assert.deepEqual(sanitizePrivateThumbnailPng(bytes), bytes);
  }
});
for (const depth of [1, 2, 4]) {
  for (let transparentSample = 0; transparentSample < 2 ** depth; transparentSample++) {
    test(`PNG maps transparent ${depth}-bit grayscale sample ${transparentSample} to equivalent palette pixels`, () => {
      const firstData = chunk('IDAT', Buffer.from([120, 156, 64, 37]));
      const secondData = chunk('IDAT', Buffer.from([9, 0, 6, 0, 3]));
      for (const interlace of [0, 1]) {
        const bytes = Buffer.concat([header(8, 8, depth, 0, interlace), chunk('tEXt', Buffer.from('private metadata')),
          chunk('tRNS', Buffer.from([0, transparentSample])), firstData, secondData, chunk('IEND')]);
        const original = Buffer.from(bytes);
        const alpha = Buffer.alloc(2 ** depth, 255); alpha[transparentSample] = 0;
        const palette = Buffer.from(Array.from({ length: 2 ** depth }, (_, value) =>
          Array(3).fill(value * (depth === 1 ? 255 : depth === 2 ? 85 : 17))).flat());
        const expected = Buffer.concat([header(8, 8, depth, 3, interlace), chunk('PLTE', palette),
          chunk('tRNS', alpha), firstData, secondData, chunk('IEND')]);
        const result = sanitizePrivateThumbnailPng(bytes);
        assert.deepEqual(result, expected);
        // A second pass validates all newly generated CRCs without changing the palette PNG.
        assert.deepEqual(sanitizePrivateThumbnailPng(result), result);
        result.fill(0); assert.deepEqual(bytes, original);
      }
    });
  }
}
test('PNG leaves grayscale without transparency and higher-depth grayscale unchanged', () => {
  for (const depth of [1, 2, 4]) {
    const plain = png([], header(8, 8, depth, 0));
    assert.deepEqual(sanitizePrivateThumbnailPng(plain), plain);
  }
  for (const depth of [8, 16]) {
    const bytes = png([chunk('tRNS', Buffer.from([0, 1]))], header(8, 8, depth, 0));
    assert.deepEqual(sanitizePrivateThumbnailPng(bytes), bytes);
  }
});
test('PNG rejects invalid palette sizes, colour types, ordering and missing required palettes', () => {
  const palette = chunk('PLTE', Buffer.from([255, 0, 0]));
  for (const size of [0, 1, 4, 769]) { refuses(png([chunk('PLTE', Buffer.alloc(size))], header(8, 8, 8, 3))); }
  refuses(png([chunk('PLTE', Buffer.alloc(9))], header(8, 8, 1, 3)));
  for (const colour of [0, 4]) { refuses(png([palette], header(8, 8, 8, colour))); }
  refuses(png([palette, palette], header(8, 8, 8, 3)));
  refuses(png([], header(8, 8, 8, 3)));
  refuses(png([chunk('tRNS', Buffer.alloc(6)), palette], header(8, 8, 8, 2)));
  refuses(Buffer.concat([header(), chunk('IDAT', Buffer.from([1])), palette, chunk('IEND')]));
});
test('PNG rejects malformed, duplicate, late or disallowed transparency', () => {
  const palette = chunk('PLTE', Buffer.from([255, 0, 0]));
  for (const size of [0, 2, 257]) { refuses(png([palette, chunk('tRNS', Buffer.alloc(size))], header(8, 8, 8, 3))); }
  refuses(png([chunk('tRNS', Buffer.from([0]))], header(8, 8, 8, 3)));
  for (const colour of [4, 6]) { refuses(png([chunk('tRNS', Buffer.from([0]))], header(8, 8, 8, colour))); }
  for (const [colour, size] of [[0, 1], [0, 3], [2, 2], [2, 7]]) {
    refuses(png([chunk('tRNS', Buffer.alloc(size))], header(8, 8, 8, colour)));
  }
  for (const colour of [0, 2]) {
    const data = Buffer.alloc(colour === 0 ? 2 : 6); data[0] = 1;
    refuses(png([chunk('tRNS', data)], header(8, 8, 8, colour)));
  }
  const trns = chunk('tRNS', Buffer.alloc(2));
  refuses(png([trns, trns], header(8, 8, 8, 0)));
  refuses(Buffer.concat([header(8, 8, 8, 0), chunk('IDAT', Buffer.from([1])), trns, chunk('IEND')]));
});
test('PNG validates every CRC and bounded chunk length, including discarded metadata', () => {
  for (const type of ['IDAT', 'tEXt', 'IEND']) {
    const bad = chunk(type, type === 'IEND' ? Buffer.alloc(0) : Buffer.from([1])); bad[bad.length - 1] ^= 1;
    refuses(Buffer.concat([header(), chunk('IDAT', Buffer.from([1])), bad, chunk('IEND')]));
  }
  const huge = chunk('tEXt'); huge.writeUInt32BE(0xffffffff, 0); refuses(png([huge]));
  for (const length of [1, 4, 8, 11]) { refuses(Buffer.concat([header(), Buffer.alloc(length)])); }
});
test('PNG rejects animated images, duplicate headers and unknown or malformed critical chunks', () => {
  for (const type of ['acTL', 'fcTL', 'fdAT', 'ABCD', 'abcd', 'a1Cd', 'ABC\u0000']) {
    refuses(png([chunk(type)]));
    refuses(Buffer.concat([header(), chunk('IDAT', Buffer.from([1])), chunk(type), chunk('IEND')]));
  }
  refuses(png([header().subarray(8)]));
  const highBit = chunk('tEXt'); highBit[4] |= 0x80;
  highBit.writeUInt32BE(crc32(highBit.subarray(4, -4)), highBit.length - 4); refuses(png([highBit]));
});
test('PNG requires contiguous nonempty aggregate IDAT data and one final empty IEND', () => {
  refuses(Buffer.concat([header(), chunk('IEND')]));
  refuses(Buffer.concat([header(), chunk('IDAT'), chunk('IEND')]));
  refuses(Buffer.concat([header(), chunk('IDAT', Buffer.from([1]))]));
  refuses(Buffer.concat([header(), chunk('IDAT', Buffer.from([1])), chunk('IEND', Buffer.from([1]))]));
  refuses(Buffer.concat([png(), chunk('IEND')])); refuses(Buffer.concat([png(), Buffer.from([0])]));
  refuses(Buffer.concat([header(), chunk('IDAT', Buffer.from([1])), chunk('tEXt'), chunk('IDAT'), chunk('IEND')]));
  const valid = Buffer.concat([header(), chunk('IDAT'), chunk('IDAT', Buffer.from([1])), chunk('IDAT'), chunk('IEND')]);
  assert.deepEqual(sanitizePrivateThumbnailPng(valid), valid);
});
test('PNG bounds chunk count before decoding thousands of empty chunks', () => {
  const accepted = png(Array.from({ length: 4093 }, () => chunk('tEXt')));
  assert.deepEqual(sanitizePrivateThumbnailPng(accepted), png());
  refuses(png(Array.from({ length: 4094 }, () => chunk('tEXt'))));
});
