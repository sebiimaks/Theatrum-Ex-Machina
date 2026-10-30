import * as path from 'node:path';
import { physicalMediaPathKey } from '../interfaces/folder-rescan';
import { normalizeAbsolutePath } from './local-operation-safety';

/** Pure lexical cache projection; reconnect must never probe the source tree. */
export function rebaseKnownSourcePaths(
  oldPaths: ReadonlySet<string>,
  oldRootValue: string,
  newRootValue: string,
): { paths: Set<string>; replacements: Map<string, string>; invalidatedPhysicalKeys: Set<string> } {
  // A catalogue can arrive from another OS. Historical cache paths confer no
  // authority; only the native replacement root must pass absolute-path validation.
  const oldPathApi = path.isAbsolute(oldRootValue) ? path
    : path.win32.isAbsolute(oldRootValue) ? path.win32 : undefined;
  const oldRoot = oldPathApi?.normalize(oldRootValue);
  const newRoot = normalizeAbsolutePath(newRootValue, 'Replacement source folder');
  const paths = new Set<string>();
  const replacements = new Map<string, string>();
  const invalidatedPhysicalKeys = new Set<string>();
  for (const oldPath of oldPaths) {
    invalidatedPhysicalKeys.add(physicalMediaPathKey(oldPath));
    if (!oldPathApi || !oldRoot) {
      continue;
    }
    const relative = oldPathApi.relative(oldRoot, oldPath);
    if (relative === '' || relative === '..' || relative.startsWith('..' + oldPathApi.sep) || oldPathApi.isAbsolute(relative)) {
      continue;
    }
    const replacement = path.resolve(newRoot, ...relative.split(oldPathApi.sep));
    paths.add(replacement);
    replacements.set(oldPath, replacement);
    invalidatedPhysicalKeys.add(physicalMediaPathKey(replacement));
  }
  return { paths, replacements, invalidatedPhysicalKeys };
}
