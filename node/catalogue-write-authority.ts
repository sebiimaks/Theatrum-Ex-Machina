import type { FinalObject, InputSources } from '../interfaces/final-object.interface';
import { normalizeIgnoredSubdirectories } from '../interfaces/source-folder-path';
import { requireConfiguredSourceRoot } from './local-operation-safety';

/**
 * Clone renderer-owned catalogue state while preserving source-folder paths
 * and watcher configuration from the main process. Sources may be removed,
 * but a renderer payload cannot add or remap one.
 */
export function prepareAuthorizedCatalogueWrite(
  value: unknown,
  configuredSources: InputSources,
  hubName: string,
): FinalObject {
  if (!value || typeof value !== 'object') {
    throw new Error('The catalogue data is invalid.');
  }
  const cloned = JSON.parse(JSON.stringify(value)) as FinalObject;
  if (!cloned.inputDirs || typeof cloned.inputDirs !== 'object' || !Array.isArray(cloned.images)) {
    throw new Error('The catalogue data is incomplete.');
  }

  const authorizedInputDirs: InputSources = {};
  Object.keys(cloned.inputDirs).forEach((rawKey: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(rawKey)) {
      throw new Error('The catalogue contains an invalid source-folder key.');
    }
    const sourceKey = Number(rawKey);
    const incomingSource = cloned.inputDirs[sourceKey];
    const configuredSource = configuredSources[sourceKey];
    if (!incomingSource || !configuredSource) {
      throw new Error('The catalogue attempted to add an unselected source folder.');
    }
    requireConfiguredSourceRoot(incomingSource.path, [configuredSource.path]);

    const ignoredSubdirectories = normalizeIgnoredSubdirectories(
      configuredSource.ignoredSubdirectories,
    );
    authorizedInputDirs[sourceKey] = {
      ...(ignoredSubdirectories.length > 0 ? { ignoredSubdirectories } : {}),
      path: configuredSource.path,
      watch: configuredSource.watch === true,
    };
  });

  cloned.hubName = hubName;
  cloned.inputDirs = authorizedInputDirs;
  return cloned;
}
