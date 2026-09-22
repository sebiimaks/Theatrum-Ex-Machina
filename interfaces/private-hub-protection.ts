/** Stored inside the encrypted hub; never in ordinary application settings. */
export type PrivateHubAutoLockMinutes = 0 | 1 | 5 | 15 | 30;
export const PRIVATE_HUB_DEFAULT_AUTO_LOCK_MINUTES: PrivateHubAutoLockMinutes = 5;
export interface PrivateHubProtection { autoLockMinutes: PrivateHubAutoLockMinutes; }

export function isPrivateHubAutoLockMinutes(value: unknown): value is PrivateHubAutoLockMinutes {
  return value === 0 || value === 1 || value === 5 || value === 15 || value === 30;
}

export function snapshotPrivateHubProtection(value: unknown): PrivateHubProtection | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || Object.getOwnPropertySymbols(value).length) { return; }
    const property = Object.getOwnPropertyDescriptor(value, 'autoLockMinutes');
    if (!property || !Object.hasOwn(property, 'value') || !isPrivateHubAutoLockMinutes(property.value)) { return; }
    return { autoLockMinutes: property.value };
  } catch { return; }
}
