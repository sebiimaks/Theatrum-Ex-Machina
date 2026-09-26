import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { isMainThread, parentPort } from 'node:worker_threads';

export interface PreviewValidationInput {
  filePath: string;
  outputDirectory: string;
  assetDirectory: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Same containment and file-type checks as ordinary media delivery, without the shared libuv pool. */
export function resolveCanonicalPreviewFile(input: PreviewValidationInput): string | undefined {
  try {
    if (![input.filePath, input.outputDirectory, input.assetDirectory].every(value =>
      typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && path.isAbsolute(value))) {
      return undefined;
    }
    const output = realpathSync.native(input.outputDirectory);
    const assets = realpathSync.native(input.assetDirectory);
    const file = realpathSync.native(input.filePath);
    return inside(output, assets) && inside(assets, file) && statSync(file).isFile() ? file : undefined;
  } catch { return undefined; }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (message: PreviewValidationInput & { id: number }) => {
    if (!message || !Number.isSafeInteger(message.id) || message.id < 1) { return; }
    // No paths or filesystem errors are logged, cached, or retained between messages.
    parentPort.postMessage({ id: message.id, path: resolveCanonicalPreviewFile(message) ?? null });
  });
}
