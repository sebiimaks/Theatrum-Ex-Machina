/** Keep dialog keystrokes local while preserving native text editing. */
export function handleDialogKeydown(event: Pick<KeyboardEvent,
  'key' | 'defaultPrevented' | 'isComposing' | 'stopPropagation' | 'preventDefault'>,
  dismiss: () => void,
): void {
  event.stopPropagation();
  if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) {
    event.preventDefault();
    dismiss();
  }
}
