/** Shared main-process decoder admission. Unproven cleanup permanently retains it. */
let active = false;
export function admitPrivatePreviewJob(): (() => void) | undefined {
  if (active) { return undefined; }
  active = true;
  let released = false;
  return () => { if (!released) { released = true; active = false; } };
}
