export interface SourceFolderScanProgress {
  sourceIndex: number;
  sourcePath: string;
  relativeScope: string;
  phase: 'discovering' | 'validating';
  completed: number;
  total?: number;
}

export function isSourceFolderScanProgress(value: unknown): value is SourceFolderScanProgress {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as SourceFolderScanProgress;
  return Number.isSafeInteger(item.sourceIndex) && item.sourceIndex >= 0
    && typeof item.sourcePath === 'string' && item.sourcePath.length > 0
    && typeof item.relativeScope === 'string'
    && (item.phase === 'discovering' || item.phase === 'validating')
    && Number.isSafeInteger(item.completed) && item.completed >= 0
    && (item.total === undefined
      || (Number.isSafeInteger(item.total) && item.total >= item.completed));
}
