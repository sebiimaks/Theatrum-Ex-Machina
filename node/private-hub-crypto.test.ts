import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

import {
  changePrivateHubPassword,
  createPrivateHub,
  decryptPrivateHubRecord,
  encryptPrivateHubRecord,
  PRIVATE_HUB_MAX_HEADER_BYTES,
  PRIVATE_HUB_MAX_PASSWORD_BYTES,
  PRIVATE_HUB_MAX_PENDING_DERIVATIONS,
  PRIVATE_HUB_MAX_RECORD_BYTES,
  PRIVATE_HUB_MAX_SEALED_RECORD_BYTES,
  PRIVATE_HUB_RECORD_OVERHEAD_BYTES,
  unlockPrivateHub,
  validatePrivateHubHeader,
} from './private-hub-crypto.ts';
import type { PrivateHubHeader } from './private-hub-crypto.ts';

const PASSWORD = ' private hub passphrase 🔒 café ';
const WRONG_PASSWORD = 'another private hub passphrase';
const UNLOCK_ERROR = 'Unable to unlock the private hub. Check the password and hub integrity.';
let hub: { header: PrivateHubHeader; key: Buffer };

before(async () => { hub = await createPrivateHub(PASSWORD); });
after(() => { hub?.key.fill(0); });

function changedByte(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

test('creates an independently unlockable, bounded, JSON-serializable private hub', async () => {
  assert.match(hub.header.hubId, /^[a-f0-9]{32}$/);
  assert.equal(hub.key.length, 32);
  const serialized = JSON.stringify(hub.header);
  assert.ok(Buffer.byteLength(serialized) < PRIVATE_HUB_MAX_HEADER_BYTES);
  assert.ok(!serialized.includes(PASSWORD));
  assert.ok(!serialized.includes(hub.key.toString('base64')));
  const unlocked = await unlockPrivateHub(JSON.parse(serialized), PASSWORD);
  try {
    assert.deepEqual(unlocked, hub.key);
    assert.notEqual(unlocked, hub.key);
  } finally {
    unlocked.fill(0);
  }
});

test('new hubs have independent identities, salts and keys even with the same password', async () => {
  const other = await createPrivateHub(PASSWORD);
  try {
    assert.notEqual(other.header.hubId, hub.header.hubId);
    assert.notEqual(other.header.kdf.salt, hub.header.kdf.salt);
    assert.notEqual(other.header.wrappedKey.nonce, hub.header.wrappedKey.nonce);
    assert.notDeepEqual(other.key, hub.key);
  } finally {
    other.key.fill(0);
  }
});

test('preserves password whitespace and Unicode normalization exactly', async () => {
  await assert.rejects(unlockPrivateHub(hub.header, PASSWORD.trim()), { message: UNLOCK_ERROR });
  await assert.rejects(unlockPrivateHub(hub.header, PASSWORD.normalize('NFD')), { message: UNLOCK_ERROR });
});

test('uses the same unlock failure for wrong passwords, malformed headers and damaged ciphertext', async () => {
  const damaged = structuredClone(hub.header);
  damaged.wrappedKey.ciphertext = changedByte(damaged.wrappedKey.ciphertext);
  for (const [header, password] of [[hub.header, WRONG_PASSWORD], [{}, PASSWORD], [damaged, PASSWORD]] as const) {
    await assert.rejects(unlockPrivateHub(header, password), { message: UNLOCK_ERROR });
  }
});

test('authenticates hub identity, key check, salt, nonce and tag before returning a key', async () => {
  const changedHeaders: PrivateHubHeader[] = [];
  for (const field of ['hubId', 'keyCheck', 'salt', 'nonce', 'tag'] as const) {
    const altered = structuredClone(hub.header);
    if (field === 'hubId') {
      altered.hubId = 'f'.repeat(32);
    } else if (field === 'keyCheck') {
      altered.keyCheck = changedByte(altered.keyCheck);
    } else if (field === 'salt') {
      altered.kdf.salt = changedByte(altered.kdf.salt);
    } else {
      altered.wrappedKey[field] = changedByte(altered.wrappedKey[field]);
    }
    changedHeaders.push(altered);
  }
  for (const altered of changedHeaders) {
    await assert.rejects(unlockPrivateHub(altered, PASSWORD), { message: UNLOCK_ERROR });
  }
});

test('validates headers independently of property order and returns an independent clone', async () => {
  const reordered = {
    wrappedKey: { ...hub.header.wrappedKey },
    kdf: { p: 1, r: 8, N: 131072, salt: hub.header.kdf.salt, name: 'scrypt' },
    keyCheck: hub.header.keyCheck,
    hubId: hub.header.hubId,
    version: 1,
    format: 'theatrum-private-hub',
  };
  const clone = validatePrivateHubHeader(reordered);
  assert.deepEqual(clone, hub.header);
  clone.kdf.salt = changedByte(clone.kdf.salt);
  assert.equal(reordered.kdf.salt, hub.header.kdf.salt);
  const unlocked = await unlockPrivateHub(reordered, PASSWORD);
  unlocked.fill(0);
});

test('rejects unsupported formats and hostile KDF costs before attempting password derivation', async () => {
  const invalidHeaders: unknown[] = [undefined, null, [], 'header', 1, true];
  for (const [field, value] of [
    ['format', 'other-format'], ['version', 2], ['hubId', 'X'.repeat(32)], ['extra', true],
  ] as const) {
    invalidHeaders.push({ ...hub.header, [field]: value });
  }
  for (const [field, value] of [
    ['name', 'pbkdf2'], ['N', 0], ['N', 2 ** 31], ['N', '131072'], ['N', Infinity],
    ['N', 131072.5], ['N', 65536], ['r', 1024], ['p', 10000], ['maxmem', 2 ** 40],
  ] as const) {
    invalidHeaders.push({ ...hub.header, kdf: { ...hub.header.kdf, [field]: value } });
  }
  invalidHeaders.push({ ...hub.header, wrappedKey: { ...hub.header.wrappedKey, algorithm: 'aes-256-cbc' } });
  invalidHeaders.push({ ...hub.header, wrappedKey: { ...hub.header.wrappedKey, extra: 'ignored?' } });
  for (const invalid of invalidHeaders) {
    assert.throws(() => validatePrivateHubHeader(invalid), /Invalid or unsupported/);
    await assert.rejects(unlockPrivateHub(invalid, PASSWORD), { message: UNLOCK_ERROR });
  }
});

test('rejects noncanonical and incorrectly sized base64 instead of forgiving malformed input', () => {
  for (const field of ['keyCheck', 'salt', 'nonce', 'tag', 'ciphertext'] as const) {
    const original = field === 'keyCheck' ? hub.header.keyCheck
      : field === 'salt' ? hub.header.kdf.salt : hub.header.wrappedKey[field];
    for (const value of ['', original + '\n', original.slice(1), ' '.repeat(original.length), 'A'.repeat(100000)]) {
      const altered = structuredClone(hub.header);
      if (field === 'keyCheck') {
        altered.keyCheck = value;
      } else if (field === 'salt') {
        altered.kdf.salt = value;
      } else {
        altered.wrappedKey[field] = value;
      }
      assert.throws(() => validatePrivateHubHeader(altered), /Invalid or unsupported/);
    }
  }
  // Node accepts ignored low padding bits; format v1 requires canonical encoding.
  const noncanonical = structuredClone(hub.header);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const originalSalt = noncanonical.kdf.salt;
  const last = alphabet.indexOf(originalSalt.at(-2));
  noncanonical.kdf.salt = originalSalt.slice(0, -2) + alphabet[last | 1] + '=';
  assert.equal(Buffer.from(noncanonical.kdf.salt, 'base64').toString('base64'), originalSalt);
  assert.throws(() => validatePrivateHubHeader(noncanonical), /Invalid or unsupported/);
});

test('does not invoke accessor properties or accept unexpected prototypes and symbols', () => {
  const accessor = structuredClone(hub.header);
  Object.defineProperty(accessor, 'hubId', { get: () => { throw new Error('getter executed'); } });
  assert.throws(() => validatePrivateHubHeader(accessor), /Invalid or unsupported/);
  const inherited = Object.assign(Object.create({ inherited: true }), hub.header);
  assert.throws(() => validatePrivateHubHeader(inherited), /Invalid or unsupported/);
  const symbol = { ...hub.header, [Symbol('extra')]: true };
  assert.throws(() => validatePrivateHubHeader(symbol), /Invalid or unsupported/);
});

test('bounds password bytes and rejects ambiguous invalid Unicode', async () => {
  for (const invalid of ['', 'x'.repeat(PRIVATE_HUB_MAX_PASSWORD_BYTES + 1), '🔒'.repeat(257), '\ud800', '\udc00']) {
    await assert.rejects(createPrivateHub(invalid), /private hub password/);
    await assert.rejects(unlockPrivateHub(hub.header, invalid), { message: UNLOCK_ERROR });
  }
  const maximum = '🔒'.repeat(256);
  const maximumHub = await createPrivateHub(maximum);
  const unlocked = await unlockPrivateHub(maximumHub.header, maximum);
  try {
    assert.deepEqual(unlocked, maximumHub.key);
  } finally {
    maximumHub.key.fill(0);
    unlocked.fill(0);
  }
});

test('encrypts binary and empty records without storing readable metadata or JPEG bytes', () => {
  for (const plaintext of [Buffer.alloc(0), Buffer.from('Private title /videos/private.mp4 notes'), randomBytes(64 * 1024)]) {
    const original = Buffer.from(plaintext);
    const sealed = encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', plaintext);
    assert.equal(sealed.length, plaintext.length + PRIVATE_HUB_RECORD_OVERHEAD_BYTES);
    if (plaintext.length > 0) {
      assert.ok(!sealed.includes(plaintext));
    }
    assert.deepEqual(decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', sealed), plaintext);
    assert.deepEqual(plaintext, original);
  }
});

test('uses a fresh nonce for repeated writes of identical content to the same record', () => {
  const plaintext = Buffer.from('same private data');
  const first = encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', plaintext);
  const second = encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', plaintext);
  assert.notDeepEqual(first.subarray(8, 20), second.subarray(8, 20));
  assert.notDeepEqual(first, second);
  assert.deepEqual(decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', second), plaintext);
});

test('rejects cross-hub, cross-record, and wrong-key substitutions', () => {
  const sealed = encryptPrivateHubRecord(hub.key, hub.header.hubId, 'thumbnails/hash', Buffer.from('private thumbnail'));
  assert.throws(() => decryptPrivateHubRecord(hub.key, 'f'.repeat(32), 'thumbnails/hash', sealed), /authenticate/);
  assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, 'filmstrips/hash', sealed), /authenticate/);
  assert.throws(() => decryptPrivateHubRecord(randomBytes(32), hub.header.hubId, 'thumbnails/hash', sealed), /authenticate/);
});

test('rejects modified magic, nonce, tag or ciphertext and any truncation or appended bytes', () => {
  const sealed = encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', Buffer.from('secret catalogue'));
  for (const position of [0, 7, 8, 19, 20, 35, 36, sealed.length - 1]) {
    const altered = Buffer.from(sealed);
    altered[position] ^= 1;
    assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', altered), /authenticate/);
  }
  for (let length = 0; length < sealed.length; length += 1) {
    assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', sealed.subarray(0, length)), /authenticate/);
  }
  assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', Buffer.concat([sealed, Buffer.from([0])])), /authenticate/);
});

test('rejects malformed key, record IDs and payloads before encryption or decryption', () => {
  const data = Buffer.from('test');
  for (const key of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), new Uint8Array(32)]) {
    assert.throws(() => encryptPrivateHubRecord(key as Buffer, hub.header.hubId, 'catalogue', data), /Invalid private hub key/);
    assert.throws(() => decryptPrivateHubRecord(key as Buffer, hub.header.hubId, 'catalogue', data), /Invalid private hub key/);
  }
  for (const recordId of ['', 'x'.repeat(257), 'has space', '\n', '\0', 'é', '\x7f']) {
    assert.throws(() => encryptPrivateHubRecord(hub.key, hub.header.hubId, recordId, data), /record identity/);
    assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, recordId, data), /record identity/);
  }
  assert.throws(() => encryptPrivateHubRecord(hub.key, 'invalid-hub', 'catalogue', data), /record identity/);
  assert.throws(() => encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', new Uint8Array(10) as Buffer), /Invalid or oversized/);
  assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', new Uint8Array(50) as Buffer), /authenticate/);
});

test('rejects oversized buffers using byte bounds without attempting cryptographic processing', () => {
  // Uninitialized bytes are never inspected or processed: rejection precedes reads.
  const oversized = Buffer.allocUnsafe(PRIVATE_HUB_MAX_SEALED_RECORD_BYTES + 1);
  assert.throws(() => encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', oversized.subarray(0, PRIVATE_HUB_MAX_RECORD_BYTES + 1)), /oversized/);
  assert.throws(() => decryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', oversized), /authenticate/);
});

test('changing a password preserves hub identity, data key and existing encrypted records', async () => {
  const originalHeader = JSON.stringify(hub.header);
  const originalKey = Buffer.from(hub.key);
  const plaintext = Buffer.from('notes survive password changes');
  const sealed = encryptPrivateHubRecord(hub.key, hub.header.hubId, 'catalogue', plaintext);
  const changed = await changePrivateHubPassword(hub.header, hub.key, WRONG_PASSWORD);
  assert.equal(changed.hubId, hub.header.hubId);
  assert.equal(changed.keyCheck, hub.header.keyCheck);
  assert.notEqual(changed.kdf.salt, hub.header.kdf.salt);
  assert.notEqual(changed.wrappedKey.nonce, hub.header.wrappedKey.nonce);
  assert.equal(JSON.stringify(hub.header), originalHeader);
  assert.deepEqual(hub.key, originalKey);
  await assert.rejects(unlockPrivateHub(changed, PASSWORD), { message: UNLOCK_ERROR });
  const unlocked = await unlockPrivateHub(changed, WRONG_PASSWORD);
  try {
    assert.deepEqual(unlocked, hub.key);
    assert.deepEqual(decryptPrivateHubRecord(unlocked, changed.hubId, 'catalogue', sealed), plaintext);
  } finally {
    unlocked.fill(0);
    originalKey.fill(0);
  }
});

test('password changes fail closed for mismatched keys and invalid new passwords', async () => {
  await assert.rejects(changePrivateHubPassword(hub.header, randomBytes(32), WRONG_PASSWORD), /does not belong/);
  await assert.rejects(changePrivateHubPassword(hub.header, Buffer.alloc(0), WRONG_PASSWORD), /Invalid private hub key/);
  await assert.rejects(changePrivateHubPassword(hub.header, hub.key, ''), /private hub password/);
  const key = await unlockPrivateHub(hub.header, PASSWORD);
  key.fill(0);
});


test('password rewrap owns its key across asynchronous derivation', async () => {
  const suppliedKey = Buffer.from(hub.key);
  const pending = changePrivateHubPassword(hub.header, suppliedKey, WRONG_PASSWORD);
  suppliedKey.fill(0);
  const changed = await pending;
  const unlocked = await unlockPrivateHub(changed, WRONG_PASSWORD);
  try {
    assert.deepEqual(unlocked, hub.key);
  } finally {
    unlocked.fill(0);
  }
});

test('bounds pending expensive password operations and releases capacity afterward', async () => {
  const requests = Array.from({ length: PRIVATE_HUB_MAX_PENDING_DERIVATIONS }, () => unlockPrivateHub(hub.header, PASSWORD));
  await assert.rejects(createPrivateHub(PASSWORD), /Too many pending/);
  const keys = await Promise.all(requests);
  keys.forEach(key => key.fill(0));
  const unlocked = await unlockPrivateHub(hub.header, PASSWORD);
  unlocked.fill(0);
});
