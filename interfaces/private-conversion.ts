/** Count-only conversion data shared with the isolated conversion document. */
export interface PrivateConversionReview {
  readonly videos: number;
  readonly availablePreviews: number;
  readonly previewBytes: number;
  readonly missingPreviews: Readonly<Record<'thumbnail' | 'filmstrip' | 'clip-poster' | 'clip', number>>;
}

export interface PrivateConversionProgress {
  readonly stage: 'scanning' | 'copying' | 'verifying' | 'complete';
  readonly completed: number;
  readonly total: number;
}

export type PrivateConversionPhase = 'review' | 'selecting' | 'scanning' | 'copying' | 'verifying' | 'complete' | 'failed';

export type PrivateConversionFailure = 'destination-unavailable' | 'destination-exists' | 'permission-denied'
  | 'storage-full' | 'files-unavailable' | 'source-inspection-failed' | 'source-changed'
  | 'storage-initialization-failed' | 'catalogue-encryption-failed' | 'preview-copy-failed'
  | 'verification-failed' | 'receipt-failed' | 'conversion-failed';

interface PrivateConversionStateCounts {
  readonly review: PrivateConversionReview;
  readonly completed: number;
  readonly total: number;
}

export type PrivateConversionState = PrivateConversionStateCounts & (
  | { readonly phase: Exclude<PrivateConversionPhase, 'failed'>; readonly failure?: never }
  | { readonly phase: 'failed'; readonly failure?: PrivateConversionFailure }
);

/** No file paths, passwords, Electron objects or native diagnostics are returned. */
export interface PrivateConversionBridge {
  getState(): Promise<PrivateConversionState | undefined>;
  submit(password: string, allowMissingPreviews: boolean, acknowledgeOriginals: boolean): Promise<boolean>;
  cancel(): void;
}
