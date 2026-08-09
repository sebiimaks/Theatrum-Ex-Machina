/**
 * Decide whether a configured source should be started while a catalogue is
 * initialized. Persistent watchers always start; otherwise only brand-new
 * catalogues request an initial scan.
 */
export function shouldStartSourceOnCatalogueSetup(
  shouldWatch: boolean,
  scanNonWatchingSources: boolean,
): boolean {
  return shouldWatch || scanNonWatchingSources;
}
