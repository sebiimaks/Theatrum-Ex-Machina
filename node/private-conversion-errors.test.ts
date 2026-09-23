import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrivateConversionFailure } from '../interfaces/private-conversion';
import { privateConversionFailure, privateConversionFailureAtStage, privateConversionFailureCode } from './private-conversion-errors';

test('conversion failure identity retains only a fixed category', () => {
  const codes: PrivateConversionFailure[] = ['destination-unavailable', 'destination-exists', 'permission-denied',
    'storage-full', 'files-unavailable', 'source-inspection-failed', 'source-changed', 'storage-initialization-failed',
    'catalogue-encryption-failed', 'preview-copy-failed', 'verification-failed', 'receipt-failed', 'conversion-failed'];
  for (const code of codes) {
    const error = privateConversionFailure(code);
    assert.equal(privateConversionFailureCode(error), code);
    assert.equal(error.message, 'Private conversion failed');
    assert.equal(privateConversionFailureCode(Object.assign(new Error(error.message), error)), 'conversion-failed');
  }
  assert.equal(privateConversionFailureCode(privateConversionFailure('/PRIVATE/SECRET' as PrivateConversionFailure)), 'conversion-failed');
});

test('native errors expose categories without their diagnostics', () => {
  const expected = { EEXIST: 'destination-exists', EACCES: 'permission-denied', EPERM: 'permission-denied',
    EROFS: 'permission-denied', ENOSPC: 'storage-full', EDQUOT: 'storage-full', ENOENT: 'files-unavailable' };
  for (const [code, failure] of Object.entries(expected)) {
    const error = Object.assign(new Error('Password SECRET at /PRIVATE/PATH'), { code, path: '/PRIVATE/PATH' });
    assert.equal(privateConversionFailureCode(error), failure);
    assert.doesNotMatch(privateConversionFailureCode(error), /PRIVATE|SECRET/);
  }
});

test('forged categories, arbitrary diagnostics and error getters cannot cross the boundary', () => {
  const getter = Object.defineProperty(new Error('SECRET'), 'code', { get() { throw new Error('Getter must not run'); } });
  const inherited = Object.setPrototypeOf(new Error('SECRET'), Object.assign(Object.create(Error.prototype), { code: 'ENOSPC' }));
  for (const error of [undefined, null, 'SECRET', {}, { code: 'EACCES' }, getter, inherited,
    new Error('EACCES /PRIVATE/PATH'), Object.assign(new Error('SECRET'), { code: 'destination-unavailable' }),
    Object.assign(new Error('SECRET'), { failure: 'storage-full' }),
    Object.assign(new Error('SECRET'), { code: 'SECRET' }),
    new Error('SECRET', { cause: Object.assign(new Error('SECRET'), { code: 'ENOSPC' }) }),
    new Proxy({}, { getPrototypeOf() { throw new Error('SECRET'); } })]) {
    assert.equal(privateConversionFailureCode(error), 'conversion-failed');
  }
});

test('stage fallbacks retain the original error and never override a brand or native errno', () => {
  const generic = Object.freeze(new Error('SECRET /PRIVATE/PATH'));
  const cleanupIdentity = new WeakSet([generic]);
  assert.equal(privateConversionFailureAtStage(generic, 'catalogue-encryption-failed'), generic);
  assert.equal(cleanupIdentity.has(generic), true);
  assert.equal(privateConversionFailureCode(generic), 'catalogue-encryption-failed');
  privateConversionFailureAtStage(generic, 'verification-failed');
  assert.equal(privateConversionFailureCode(generic), 'catalogue-encryption-failed');
  for (const code of ['source-changed', 'conversion-failed'] as const) {
    const branded = privateConversionFailure(code);
    assert.equal(privateConversionFailureAtStage(branded, 'preview-copy-failed'), branded);
    assert.equal(privateConversionFailureCode(branded), code);
  }
  const native = Object.assign(new Error('SECRET'), { code: 'ENOSPC' });
  assert.equal(privateConversionFailureAtStage(native, 'storage-initialization-failed'), native);
  assert.equal(privateConversionFailureCode(native), 'storage-full');
  const invalid = new Error('SECRET');
  privateConversionFailureAtStage(invalid, '/PRIVATE/SECRET' as PrivateConversionFailure);
  assert.equal(privateConversionFailureCode(invalid), 'conversion-failed');
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('SECRET'); } });
  assert.equal(privateConversionFailureAtStage(hostile, 'preview-copy-failed'), hostile);
});
