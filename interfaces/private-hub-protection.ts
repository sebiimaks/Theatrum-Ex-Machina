/** Stored inside the encrypted hub; never in ordinary application settings. */
export type PrivateHubAutoLockMinutes = 0 | 1 | 5 | 15 | 30;
export const PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES: PrivateHubAutoLockMinutes = 5;
export interface PrivateHubProtection {
  autoLockMinutes: PrivateHubAutoLockMinutes;
  /** Missing on legacy callers; a settings update preserves the saved value. */
  recordPlaybackHistory?: boolean;
}

export function isPrivateHubAutoLockMinutes(value: unknown): value is PrivateHubAutoLockMinutes {
  return value === 0 || value === 1 || value === 5 || value === 15 || value === 30;
}

export function snapshotPrivateHubProtection(value: unknown): PrivateHubProtection | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { return; }
    const keys = Reflect.ownKeys(value);
    if (!keys.length || keys.some(key => key !== 'autoLockMinutes' && key !== 'recordPlaybackHistory')) { return; }
    const property = Object.getOwnPropertyDescriptor(value, 'autoLockMinutes');
    if (!property?.enumerable || !Object.hasOwn(property, 'value') || !isPrivateHubAutoLockMinutes(property.value)) { return; }
    const history = Object.getOwnPropertyDescriptor(value, 'recordPlaybackHistory');
    if (history && (!history.enumerable || !Object.hasOwn(history, 'value') || typeof history.value !== 'boolean')) { return; }
    return { autoLockMinutes: property.value, ...(history ? { recordPlaybackHistory: history.value } : {}) };
  } catch { return; }
}
