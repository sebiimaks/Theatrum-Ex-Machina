import { PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES, snapshotPrivateHubProtection,
  type PrivateHubProtection } from '../interfaces/private-hub-protection';
import type { PrivateHubStore } from './private-hub-store';

const RECORD = 'settings:protection';
const MAXIMUM_BYTES = 256;
function unavailable(): Error { return new Error('Private hub protection settings are unavailable.'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Validate already-authenticated bytes without reading or changing storage. */
export function parsePrivateHubProtection(bytes: Buffer): PrivateHubProtection {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAXIMUM_BYTES) { throw unavailable(); }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw unavailable(); }
    const fields = value as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (!(fields.version === 1 && keys === 'autoLockMinutes,version')
      && !(fields.version === 2 && keys === 'autoLockMinutes,recordPlaybackHistory,version')) { throw unavailable(); }
    const settings = snapshotPrivateHubProtection({ autoLockMinutes: fields.autoLockMinutes,
      recordPlaybackHistory: fields.version === 1 ? false : fields.recordPlaybackHistory });
    if (!settings) { throw unavailable(); }
    return settings;
  } catch { throw unavailable(); }
}

export async function readPrivateHubProtection(store: PrivateHubStore): Promise<PrivateHubProtection> {
  let bytes: Buffer | undefined;
  try {
    try { bytes = await store.readRecord(RECORD, MAXIMUM_BYTES); }
    catch (error) {
      if (!missing(error)) { throw error; }
      // A surviving backup is evidence of lost primary settings. Never turn
      // damage into default protection or silently recover an older policy.
      try { bytes = await store.readBackupRecord(RECORD, MAXIMUM_BYTES); }
      catch (backupError) {
        if (!missing(backupError)) { throw backupError; }
        return { autoLockMinutes: PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES, recordPlaybackHistory: false };
      }
      throw unavailable();
    }
    return parsePrivateHubProtection(bytes);
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); }
}

export async function writePrivateHubProtection(
  store: PrivateHubStore, value: PrivateHubProtection, isCurrent: () => boolean,
): Promise<PrivateHubProtection> {
  let bytes: Buffer | undefined;
  try {
    const snapshot = snapshotPrivateHubProtection(value);
    if (!snapshot || isCurrent() !== true) { throw unavailable(); }
    // Authenticate existing settings before replacing them, including the
    // missing-primary/surviving-backup case. Preserve explicit recovery.
    const previous = await readPrivateHubProtection(store);
    if (isCurrent() !== true) { throw unavailable(); }
    // Older in-process auto-lock callers cannot accidentally disable an
    // explicitly enabled history policy by omitting the newer field.
    const settings: PrivateHubProtection = { autoLockMinutes: snapshot.autoLockMinutes,
      recordPlaybackHistory: snapshot.recordPlaybackHistory ?? previous.recordPlaybackHistory === true };
    bytes = Buffer.from(JSON.stringify({ version: 2, ...settings }));
    const writing = store.writeRecord(RECORD, bytes, isCurrent);
    bytes.fill(0);
    await writing;
    if (isCurrent() !== true) { throw unavailable(); }
    return settings;
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); }
}
