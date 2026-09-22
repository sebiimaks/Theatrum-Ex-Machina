import { PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES, snapshotPrivateHubProtection,
  type PrivateHubProtection } from '../interfaces/private-hub-protection';
import type { PrivateHubStore } from './private-hub-store';

const RECORD = 'settings:protection';
const MAXIMUM_BYTES = 256;
function unavailable(): Error { return new Error('Private hub protection settings are unavailable.'); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

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
        return { autoLockMinutes: PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES };
      }
      throw unavailable();
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'autoLockMinutes,version'
      || (value as { version?: unknown }).version !== 1) { throw unavailable(); }
    const settings = snapshotPrivateHubProtection({ autoLockMinutes: (value as PrivateHubProtection).autoLockMinutes });
    if (!settings) { throw unavailable(); }
    return settings;
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); }
}

export async function writePrivateHubProtection(
  store: PrivateHubStore, value: PrivateHubProtection, isCurrent: () => boolean,
): Promise<PrivateHubProtection> {
  let bytes: Buffer | undefined;
  try {
    const settings = snapshotPrivateHubProtection(value);
    if (!settings || isCurrent() !== true) { throw unavailable(); }
    // Authenticate existing settings before replacing them, including the
    // missing-primary/surviving-backup case. Preserve explicit recovery.
    await readPrivateHubProtection(store);
    if (isCurrent() !== true) { throw unavailable(); }
    bytes = Buffer.from(JSON.stringify({ version: 1, ...settings }));
    const writing = store.writeRecord(RECORD, bytes, isCurrent);
    bytes.fill(0);
    await writing;
    if (isCurrent() !== true) { throw unavailable(); }
    return settings;
  } catch { throw unavailable(); }
  finally { bytes?.fill(0); }
}
