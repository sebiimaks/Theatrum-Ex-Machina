/**
 * Private-hub format v1 foundation. Not yet connected to catalogue/media I/O.
 *
 * Uses Node/OpenSSL's AES-256-GCM and asynchronous scrypt, rather than introducing
 * cryptographic primitives or a password-derived media key. A random per-hub key
 * permits password changes without rewriting every record. The fixed scrypt
 * parameters use 128 MiB; serializing derivations bounds their memory use in this
 * process. They intentionally cannot be selected by an untrusted file.
 *
 * Records are authenticated as a whole before any plaintext is returned. This
 * whole-buffer format is not a streaming/seekable large-video container. Callers
 * must retain keys in the main process, clear returned keys/plaintext after use,
 * and protect temporary files, caches, backups, exports, and original media.
 * JavaScript strings, runtime copies, and OS memory cannot be reliably erased.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

export const PRIVATE_HUB_MAX_HEADER_BYTES = 4096;
export const PRIVATE_HUB_MAX_RECORD_BYTES = 256 * 1024 * 1024;
export const PRIVATE_HUB_RECORD_OVERHEAD_BYTES = 36;
export const PRIVATE_HUB_MAX_SEALED_RECORD_BYTES = PRIVATE_HUB_MAX_RECORD_BYTES + PRIVATE_HUB_RECORD_OVERHEAD_BYTES;
export const PRIVATE_HUB_MAX_PASSWORD_BYTES = 1024;
export const PRIVATE_HUB_MAX_PENDING_DERIVATIONS = 8;

const FORMAT = 'theatrum-private-hub';
const VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 256 * 1024 * 1024;
const RECORD_MAGIC = Buffer.from('TEMPHR01', 'ascii');
const UNLOCK_ERROR = 'Unable to unlock the private hub. Check the password and hub integrity.';
const RECORD_ERROR = 'Unable to authenticate the private hub record.';
let derivationQueue: Promise<void> = Promise.resolve();
let pendingDerivations = 0;

export interface PrivateHubHeader {
  format: 'theatrum-private-hub';
  version: 1;
  hubId: string;
  keyCheck: string;
  kdf: {
    name: 'scrypt';
    salt: string;
    N: 131072;
    r: 8;
    p: 1;
  };
  wrappedKey: {
    algorithm: 'aes-256-gcm';
    nonce: string;
    tag: string;
    ciphertext: string;
  };
}

function invalidHeader(): never {
  throw new Error('Invalid or unsupported private hub header.');
}

/** Reject unknown fields, prototypes and accessors before reading field values. */
function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidHeader();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidHeader();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    return invalidHeader();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      return invalidHeader();
    }
  }
  return value as Record<string, unknown>;
}

function canonicalBase64(value: unknown, bytes: number): string {
  // Buffer's base64 decoder is deliberately forgiving; the on-disk format is not.
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(bytes / 3)) {
    return invalidHeader();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    return invalidHeader();
  }
  return value;
}

function validHubId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
}

/** Returns an independent, canonical plain object with no caller-owned objects. */
export function validatePrivateHubHeader(value: unknown): PrivateHubHeader {
  const header = exactObject(value, ['format', 'version', 'hubId', 'keyCheck', 'kdf', 'wrappedKey']);
  const kdf = exactObject(header.kdf, ['name', 'salt', 'N', 'r', 'p']);
  const wrapped = exactObject(header.wrappedKey, ['algorithm', 'nonce', 'tag', 'ciphertext']);
  if (
    header.format !== FORMAT || header.version !== VERSION || !validHubId(header.hubId)
    || kdf.name !== 'scrypt' || kdf.N !== SCRYPT_N || kdf.r !== SCRYPT_R || kdf.p !== SCRYPT_P
    || wrapped.algorithm !== ALGORITHM
  ) {
    return invalidHeader();
  }
  return {
    format: FORMAT,
    version: VERSION,
    hubId: header.hubId,
    keyCheck: canonicalBase64(header.keyCheck, KEY_BYTES),
    kdf: {
      name: 'scrypt',
      salt: canonicalBase64(kdf.salt, SALT_BYTES),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    },
    wrappedKey: {
      algorithm: ALGORITHM,
      nonce: canonicalBase64(wrapped.nonce, NONCE_BYTES),
      tag: canonicalBase64(wrapped.tag, TAG_BYTES),
      ciphertext: canonicalBase64(wrapped.ciphertext, KEY_BYTES),
    },
  };
}

function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length === 0 || password.length > PRIVATE_HUB_MAX_PASSWORD_BYTES) {
    throw new Error('The private hub password must contain 1 to 1024 UTF-8 bytes.');
  }
  // Reject ill-formed UTF-16 rather than silently mapping different passwords to
  // the same UTF-8 replacement character. Otherwise preserve passwords exactly.
  for (let index = 0; index < password.length; index += 1) {
    const code = password.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = password.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('The private hub password contains invalid Unicode.');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('The private hub password contains invalid Unicode.');
    }
  }
  if (Buffer.byteLength(password, 'utf8') > PRIVATE_HUB_MAX_PASSWORD_BYTES) {
    throw new Error('The private hub password must contain 1 to 1024 UTF-8 bytes.');
  }
}

function validateKey(key: unknown): asserts key is Buffer {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('Invalid private hub key.');
  }
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  validatePassword(password);
  if (pendingDerivations >= PRIVATE_HUB_MAX_PENDING_DERIVATIONS) {
    throw new Error('Too many pending private hub password operations.');
  }
  pendingDerivations += 1;
  const predecessor = derivationQueue;
  let release: () => void;
  derivationQueue = new Promise<void>(resolve => { release = resolve; });
  await predecessor;
  const passwordBytes = Buffer.from(password, 'utf8');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(passwordBytes, salt, KEY_BYTES, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY,
      }, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    passwordBytes.fill(0);
    pendingDerivations -= 1;
    release();
  }
}

function keyCheck(key: Buffer, hubId: string): Buffer {
  return createHmac('sha256', key).update(JSON.stringify([FORMAT, VERSION, 'key-check', hubId]), 'utf8').digest();
}

function keyMatchesHeader(key: Buffer, header: PrivateHubHeader): boolean {
  const actual = keyCheck(key, header.hubId);
  try {
    return timingSafeEqual(actual, Buffer.from(header.keyCheck, 'base64'));
  } finally {
    actual.fill(0);
  }
}

function headerAssociatedData(header: PrivateHubHeader): Buffer {
  // Explicit ordering is independent of JSON property order in a saved file.
  return Buffer.from(JSON.stringify([
    header.format, header.version, 'wrapped-key', header.hubId, header.keyCheck,
    header.kdf.name, header.kdf.salt, header.kdf.N, header.kdf.r, header.kdf.p,
    header.wrappedKey.algorithm,
  ]), 'utf8');
}

function recordAssociatedData(hubId: unknown, recordId: unknown): Buffer {
  if (!validHubId(hubId) || typeof recordId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(recordId)) {
    throw new Error('Invalid private hub record identity.');
  }
  // Structured fields avoid delimiter ambiguity and separate records from key wraps.
  return Buffer.from(JSON.stringify([FORMAT, VERSION, 'record', hubId, recordId]), 'utf8');
}

function seal(key: Buffer, nonce: Buffer, associatedData: Buffer, plaintext: Buffer): { ciphertext: Buffer; tag: Buffer } {
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

function unseal(key: Buffer, nonce: Buffer, associatedData: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(tag);
  let provisional: Buffer | undefined;
  try {
    // update() returns unverified bytes. Never expose them before final() succeeds.
    provisional = decipher.update(ciphertext);
    const tail = decipher.final();
    if (tail.length === 0) {
      return provisional;
    }
    const plaintext = Buffer.concat([provisional, tail]);
    provisional.fill(0);
    tail.fill(0);
    return plaintext;
  } catch (error) {
    provisional?.fill(0);
    throw error;
  }
}

async function wrapKey(hubId: string, key: Buffer, password: string): Promise<PrivateHubHeader> {
  validatePassword(password);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header: PrivateHubHeader = {
    format: FORMAT,
    version: VERSION,
    hubId,
    keyCheck: keyCheck(key, hubId).toString('base64'),
    kdf: { name: 'scrypt', salt: salt.toString('base64'), N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    wrappedKey: { algorithm: ALGORITHM, nonce: nonce.toString('base64'), tag: '', ciphertext: '' },
  };
  const wrappingKey = await deriveKey(password, salt);
  try {
    const encrypted = seal(wrappingKey, nonce, headerAssociatedData(header), key);
    header.wrappedKey.tag = encrypted.tag.toString('base64');
    header.wrappedKey.ciphertext = encrypted.ciphertext.toString('base64');
    return header;
  } finally {
    wrappingKey.fill(0);
  }
}

export async function createPrivateHub(password: string): Promise<{ header: PrivateHubHeader; key: Buffer }> {
  validatePassword(password);
  const hubId = randomBytes(16).toString('hex');
  const key = randomBytes(KEY_BYTES);
  try {
    return { header: await wrapKey(hubId, key, password), key };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

/** Wrong passwords, corrupt headers, and failed authentication share one error. */
export async function unlockPrivateHub(value: unknown, password: string): Promise<Buffer> {
  let wrappingKey: Buffer | undefined;
  let dataKey: Buffer | undefined;
  try {
    const header = validatePrivateHubHeader(value);
    validatePassword(password);
    wrappingKey = await deriveKey(password, Buffer.from(header.kdf.salt, 'base64'));
    dataKey = unseal(wrappingKey, Buffer.from(header.wrappedKey.nonce, 'base64'), headerAssociatedData(header),
      Buffer.from(header.wrappedKey.tag, 'base64'), Buffer.from(header.wrappedKey.ciphertext, 'base64'));
    if (!keyMatchesHeader(dataKey, header)) {
      throw new Error(UNLOCK_ERROR);
    }
    return dataKey;
  } catch {
    dataKey?.fill(0);
    throw new Error(UNLOCK_ERROR);
  } finally {
    wrappingKey?.fill(0);
  }
}

/** Stable, opaque device credential name. It contains no hub path or title. */
export function privateHubTouchIdIdentity(value: unknown): string {
  const header = validatePrivateHubHeader(value);
  return createHash('sha256').update(JSON.stringify([FORMAT, VERSION, 'touch-id-account', header.hubId]), 'utf8').digest('hex');
}

function touchIdHeaderDigest(header: PrivateHubHeader): Buffer {
  // Validation returns a canonical independent object, including every wrap field.
  // Password rewrapping changes this binding even though the data key is unchanged.
  return createHash('sha256').update(JSON.stringify([FORMAT, VERSION, 'touch-id-header', header]), 'utf8').digest();
}

/** Main-only Keychain payload; caller owns and must wipe the returned buffer. */
export function createPrivateHubTouchIdSecret(value: unknown, key: Buffer): Buffer {
  const header = validatePrivateHubHeader(value);
  validateKey(key);
  if (!keyMatchesHeader(key, header)) { throw new Error(UNLOCK_ERROR); }
  const digest = touchIdHeaderDigest(header);
  try { return Buffer.concat([digest, key]); }
  finally { digest.fill(0); }
}

/** Authenticate both the complete saved envelope and the returned device key. */
export function unlockPrivateHubWithTouchId(value: unknown, secret: Buffer): Buffer {
  let key: Buffer | undefined;
  let digest: Buffer | undefined;
  try {
    const header = validatePrivateHubHeader(value);
    if (!Buffer.isBuffer(secret) || secret.length !== 2 * KEY_BYTES) { throw new Error(); }
    digest = touchIdHeaderDigest(header);
    if (!timingSafeEqual(digest, secret.subarray(0, KEY_BYTES))) { throw new Error(); }
    key = Buffer.from(secret.subarray(KEY_BYTES));
    if (!keyMatchesHeader(key, header)) { throw new Error(); }
    return key;
  } catch {
    key?.fill(0);
    throw new Error(UNLOCK_ERROR);
  } finally { digest?.fill(0); }
}

/** Rewrap only; callers must atomically replace the saved header after success. */
export async function changePrivateHubPassword(value: unknown, key: Buffer, password: string): Promise<PrivateHubHeader> {
  const header = validatePrivateHubHeader(value);
  validateKey(key);
  validatePassword(password);
  if (!keyMatchesHeader(key, header)) {
    throw new Error('The key does not belong to this private hub.');
  }
  // A lock may clear the caller's key while the asynchronous KDF is pending.
  // Own a snapshot so a successful return never wraps a changed/cleared key.
  // The session owner must still discard this result if the session was locked.
  const ownedKey = Buffer.from(key);
  try {
    return await wrapKey(header.hubId, ownedKey, password);
  } finally {
    ownedKey.fill(0);
  }
}

export function encryptPrivateHubRecord(key: Buffer, hubId: string, recordId: string, plaintext: Buffer): Buffer {
  validateKey(key);
  const associatedData = recordAssociatedData(hubId, recordId);
  if (!Buffer.isBuffer(plaintext) || plaintext.length > PRIVATE_HUB_MAX_RECORD_BYTES) {
    throw new Error('Invalid or oversized private hub record.');
  }
  const nonce = randomBytes(NONCE_BYTES);
  const encrypted = seal(key, nonce, associatedData, plaintext);
  return Buffer.concat([RECORD_MAGIC, nonce, encrypted.tag, encrypted.ciphertext]);
}

export function decryptPrivateHubRecord(key: Buffer, hubId: string, recordId: string, sealed: Buffer): Buffer {
  validateKey(key);
  const associatedData = recordAssociatedData(hubId, recordId);
  if (!Buffer.isBuffer(sealed) || sealed.length < PRIVATE_HUB_RECORD_OVERHEAD_BYTES
    || sealed.length > PRIVATE_HUB_MAX_SEALED_RECORD_BYTES || !sealed.subarray(0, 8).equals(RECORD_MAGIC)) {
    throw new Error(RECORD_ERROR);
  }
  try {
    return unseal(key, sealed.subarray(8, 20), associatedData, sealed.subarray(20, 36), sealed.subarray(36));
  } catch {
    throw new Error(RECORD_ERROR);
  }
}
