/** DOM interaction is blocked in addition to, never instead of, mutation guards. */
export class RendererInteractionFreeze {
  private composing = false;
  private frozen = false;
  private readonly compositionStart = (): void => { this.composing = true; };
  private readonly compositionEnd = (): void => { this.composing = false; };
  private readonly stopPlayback = (event: Event): void => {
    if (!this.frozen) { return; }
    const media = event.target as HTMLMediaElement | null;
    media?.pause?.();
    event.stopImmediatePropagation();
  };
  private readonly block = (event: Event): void => {
    if (!this.frozen) { return; }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private readonly events = [
    'beforeinput', 'input', 'change', 'keydown', 'keyup', 'click', 'dblclick',
    'pointerdown', 'pointerup', 'contextmenu', 'cut', 'copy', 'paste', 'dragstart', 'drop', 'submit',
  ];

  constructor(private readonly document: Document) {
    document.addEventListener('compositionstart', this.compositionStart, true);
    document.addEventListener('compositionend', this.compositionEnd, true);
    document.addEventListener('play', this.stopPlayback, true);
    for (const name of this.events) { document.addEventListener(name, this.block, true); }
  }

  freeze(): () => void {
    // Blur cannot reliably commit an IME composition. Refuse the handoff rather
    // than saving incomplete notes or altering the user's unfinished input.
    if (this.composing || this.frozen) { throw new Error('Finish the current text entry before opening a private hub.'); }
    const active = this.document.activeElement as HTMLElement | null;
    active?.blur?.();
    if (this.composing) { throw new Error('Text composition is still active.'); }
    const mediaState = Array.from(this.document.querySelectorAll<HTMLMediaElement>('video, audio'))
      .map(media => ({ media, autoplay: media.autoplay }));
    for (const { media } of mediaState) { media.pause(); media.autoplay = false; }
    const body = this.document.body;
    const previousInert = body.inert;
    body.inert = true; // Includes Material overlays outside app-home.
    this.frozen = true;
    let released = false;
    return () => {
      if (released) { return; }
      body.inert = previousInert;
      this.frozen = false;
      released = true;
      for (const { media, autoplay } of mediaState) {
        try { if (media.isConnected) { media.autoplay = autoplay; } }
        catch { /* Restoring an old preview is optional. */ }
      }
      try {
        if (!previousInert && active?.isConnected) { active.focus({ preventScroll: true }); }
      } catch { /* Focus restoration is optional; the input may have been removed. */ }
    };
  }

  dispose(): void {
    this.document.removeEventListener('compositionstart', this.compositionStart, true);
    this.document.removeEventListener('compositionend', this.compositionEnd, true);
    this.document.removeEventListener('play', this.stopPlayback, true);
    for (const name of this.events) { this.document.removeEventListener(name, this.block, true); }
  }
}
