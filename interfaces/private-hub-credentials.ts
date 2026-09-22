/** Exact password text is preserved; no trimming or Unicode normalization. */
export function isPrivateHubPassword(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) { return false; }
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) { return false; }
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) { return false; }
    else { bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3; }
    if (bytes > 1024) { return false; }
  }
  return true;
}

export interface PrivateHubPasswordChangeRequest { currentPassword: string; newPassword: string; }

/** Capture bounded data properties only; never execute caller accessors. */
export function snapshotPrivateHubPasswordChange(value: unknown): PrivateHubPasswordChangeRequest | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('currentPassword') || !keys.includes('newPassword')) { return; }
    const current = Object.getOwnPropertyDescriptor(value, 'currentPassword');
    const next = Object.getOwnPropertyDescriptor(value, 'newPassword');
    if (!current || !next || !Object.hasOwn(current, 'value') || !Object.hasOwn(next, 'value')
      || !isPrivateHubPassword(current.value) || !isPrivateHubPassword(next.value)
      || current.value === next.value) { return; }
    return { currentPassword: current.value, newPassword: next.value };
  } catch { return; }
}

export interface PrivateHubPlaintextCopyRequest { password: string; acknowledge: true; }

/** Explicit consent and a bounded password; never evaluate caller accessors. */
export function snapshotPrivateHubPlaintextCopyRequest(value: unknown): PrivateHubPlaintextCopyRequest | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('password') || !keys.includes('acknowledge')) { return; }
    const password = Object.getOwnPropertyDescriptor(value, 'password');
    const acknowledge = Object.getOwnPropertyDescriptor(value, 'acknowledge');
    if (!password || !acknowledge || !Object.hasOwn(password, 'value') || !Object.hasOwn(acknowledge, 'value')
      || !isPrivateHubPassword(password.value) || acknowledge.value !== true) { return; }
    return { password: password.value, acknowledge: true };
  } catch { return; }
}

export interface PrivateHubTouchIdEnableRequest { password: string; }

/** A single bounded credential, with no accessors or extra fields. */
export function snapshotPrivateHubTouchIdEnable(value: unknown): PrivateHubTouchIdEnableRequest | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
    const keys = Reflect.ownKeys(value);
    const password = Object.getOwnPropertyDescriptor(value, 'password');
    if (keys.length !== 1 || keys[0] !== 'password' || !password || !Object.hasOwn(password, 'value')
      || !isPrivateHubPassword(password.value)) { return; }
    return { password: password.value };
  } catch { return; }
}
