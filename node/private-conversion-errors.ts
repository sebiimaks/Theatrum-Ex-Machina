import type { PrivateConversionFailure } from '../interfaces/private-conversion';

const failures = new WeakMap<Error, PrivateConversionFailure>();
const codes: readonly PrivateConversionFailure[] = ['destination-unavailable', 'destination-exists', 'permission-denied',
  'storage-full', 'files-unavailable', 'source-inspection-failed', 'source-changed', 'storage-initialization-failed',
  'catalogue-encryption-failed', 'preview-copy-failed', 'verification-failed', 'receipt-failed', 'conversion-failed'];

/** Main-only identity: public error properties never confer a failure category. */
export function privateConversionFailure(code: PrivateConversionFailure): Error {
  const error = new Error('Private conversion failed');
  failures.set(error, codes.includes(code) ? code : 'conversion-failed');
  return error;
}

/** Only a fixed category crosses IPC; never messages, paths, causes or stacks. */
export function privateConversionFailureCode(error: unknown): PrivateConversionFailure {
  try {
    if (!(error instanceof Error)) { return 'conversion-failed'; }
    const branded = failures.get(error);
    if (branded) { return branded; }
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    switch (code) {
      case 'EEXIST': return 'destination-exists';
      case 'EACCES': case 'EPERM': case 'EROFS': return 'permission-denied';
      case 'ENOSPC': case 'EDQUOT': return 'storage-full';
      case 'ENOENT': return 'files-unavailable';
      default: return 'conversion-failed';
    }
  } catch { return 'conversion-failed'; }
}

/** Add a fallback to the original error, retaining identity-based cleanup and errno decisions. */
export function privateConversionFailureAtStage<T>(error: T, fallback: PrivateConversionFailure): T {
  try {
    if (error instanceof Error && !failures.has(error) && codes.includes(fallback)
      && privateConversionFailureCode(error) === 'conversion-failed') {
      failures.set(error, fallback);
    }
  } catch { /* Error objects can be proxies; diagnostics must never replace the failure. */ }
  return error;
}
