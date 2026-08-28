import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const AUTHORITY_FILE_NAME = 'trusted-path-authority.json';
const AUTHORITY_FILE_MAX_BYTES = 1024 * 1024;

interface PathAuthorityStore {
  cataloguePaths: string[];
  playerPaths: string[];
  sourceDecisions: Record<string, boolean>;
  watchDecisions: Record<string, boolean>;
  version: 1;
}

function emptyStore(): PathAuthorityStore {
  return {
    cataloguePaths: [],
    playerPaths: [],
    sourceDecisions: {},
    watchDecisions: {},
    version: 1,
  };
}

function authorityFilePath(settingsPath: string): string {
  return path.join(settingsPath, AUTHORITY_FILE_NAME);
}

function normalizedAbsolutePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32768
    || value.includes('\0')
    || !path.isAbsolute(value)
  ) {
    return undefined;
  }
  return path.normalize(value);
}

function sourceDecisionKey(cataloguePath: string, sourcePath: string): string {
  return createHash('sha256')
    .update(cataloguePath)
    .update('\0')
    .update(sourcePath)
    .digest('hex');
}

function readStore(settingsPath: string): PathAuthorityStore {
  try {
    const filePath = authorityFilePath(settingsPath);
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > AUTHORITY_FILE_MAX_BYTES) {
      return emptyStore();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== 1) {
      return emptyStore();
    }

    const cataloguePaths: string[] = Array.isArray(parsed.cataloguePaths)
      ? parsed.cataloguePaths
        .map(normalizedAbsolutePath)
        .filter((entry: string | undefined): entry is string => Boolean(entry))
      : [];
    const playerPaths: string[] = Array.isArray(parsed.playerPaths)
      ? parsed.playerPaths
        .map(normalizedAbsolutePath)
        .filter((entry: string | undefined): entry is string => Boolean(entry))
      : [];
    const sourceDecisions: Record<string, boolean> = {};
    if (parsed.sourceDecisions && typeof parsed.sourceDecisions === 'object') {
      Object.entries(parsed.sourceDecisions).forEach(([key, decision]) => {
        if (/^[a-f0-9]{64}$/.test(key) && typeof decision === 'boolean') {
          sourceDecisions[key] = decision;
        }
      });
    }
    const watchDecisions: Record<string, boolean> = {};
    if (parsed.watchDecisions && typeof parsed.watchDecisions === 'object') {
      Object.entries(parsed.watchDecisions).forEach(([key, decision]) => {
        if (/^[a-f0-9]{64}$/.test(key) && typeof decision === 'boolean') {
          watchDecisions[key] = decision;
        }
      });
    }
    return {
      cataloguePaths: Array.from(new Set(cataloguePaths)).slice(-256),
      playerPaths: Array.from(new Set(playerPaths)).slice(-32),
      sourceDecisions,
      version: 1,
      watchDecisions,
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(settingsPath: string, store: PathAuthorityStore): void {
  fs.mkdirSync(settingsPath, { recursive: true });
  const destination = authorityFilePath(settingsPath);
  const temporary = path.join(settingsPath, `.${AUTHORITY_FILE_NAME}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

export function loadAuthorizedCataloguePaths(settingsPath: string): string[] {
  return readStore(settingsPath).cataloguePaths;
}

export function loadAuthorizedPlayerPaths(settingsPath: string): string[] {
  return readStore(settingsPath).playerPaths;
}

export function rememberCataloguePathAuthorization(
  settingsPath: string,
  cataloguePath: string,
): void {
  const normalizedCataloguePath = normalizedAbsolutePath(cataloguePath);
  if (!normalizedCataloguePath) {
    throw new Error('The catalogue authorization path is invalid.');
  }
  const store = readStore(settingsPath);
  store.cataloguePaths = Array.from(new Set([
    ...store.cataloguePaths,
    normalizedCataloguePath,
  ])).slice(-256);
  writeStore(settingsPath, store);
}

export function rememberPlayerPathAuthorization(
  settingsPath: string,
  playerPath: string,
): void {
  const normalizedPlayerPath = normalizedAbsolutePath(playerPath);
  if (!normalizedPlayerPath) {
    throw new Error('The video-player authorization path is invalid.');
  }
  const store = readStore(settingsPath);
  store.playerPaths = Array.from(new Set([
    ...store.playerPaths,
    normalizedPlayerPath,
  ])).slice(-32);
  writeStore(settingsPath, store);
}

export function sourceAccessDecision(
  settingsPath: string,
  cataloguePath: string,
  sourcePath: string,
): boolean | undefined {
  const normalizedCataloguePath = normalizedAbsolutePath(cataloguePath);
  const normalizedSourcePath = normalizedAbsolutePath(sourcePath);
  if (!normalizedCataloguePath || !normalizedSourcePath) {
    return undefined;
  }
  return readStore(settingsPath).sourceDecisions[
    sourceDecisionKey(normalizedCataloguePath, normalizedSourcePath)
  ];
}

export function rememberSourceAccessDecision(
  settingsPath: string,
  cataloguePath: string,
  sourcePath: string,
  decision: boolean,
): void {
  const normalizedCataloguePath = normalizedAbsolutePath(cataloguePath);
  const normalizedSourcePath = normalizedAbsolutePath(sourcePath);
  if (!normalizedCataloguePath || !normalizedSourcePath || typeof decision !== 'boolean') {
    throw new Error('The source-folder authorization is invalid.');
  }
  const store = readStore(settingsPath);
  store.sourceDecisions[
    sourceDecisionKey(normalizedCataloguePath, normalizedSourcePath)
  ] = decision;
  writeStore(settingsPath, store);
}

export function sourceWatchDecision(
  settingsPath: string,
  cataloguePath: string,
  sourcePath: string,
): boolean | undefined {
  const normalizedCataloguePath = normalizedAbsolutePath(cataloguePath);
  const normalizedSourcePath = normalizedAbsolutePath(sourcePath);
  if (!normalizedCataloguePath || !normalizedSourcePath) {
    return undefined;
  }
  return readStore(settingsPath).watchDecisions[
    sourceDecisionKey(normalizedCataloguePath, normalizedSourcePath)
  ];
}

export function rememberSourceWatchDecision(
  settingsPath: string,
  cataloguePath: string,
  sourcePath: string,
  decision: boolean,
): void {
  const normalizedCataloguePath = normalizedAbsolutePath(cataloguePath);
  const normalizedSourcePath = normalizedAbsolutePath(sourcePath);
  if (!normalizedCataloguePath || !normalizedSourcePath || typeof decision !== 'boolean') {
    throw new Error('The source-folder watch authorization is invalid.');
  }
  const store = readStore(settingsPath);
  store.watchDecisions[
    sourceDecisionKey(normalizedCataloguePath, normalizedSourcePath)
  ] = decision;
  writeStore(settingsPath, store);
}
