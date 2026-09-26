import { net, protocol } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  THEATRUM_APP_PROTOCOL,
} from '../interfaces/theatrum-protocol';
import { GLOBALS } from './main-globals';
import { normalPreviewValidation } from './normal-preview-validation';
import {
  resolveTheatrumAppFile,
  resolveTheatrumAssetDirectory,
  resolveTheatrumMediaFile,
} from './theatrum-protocol-paths';

function protocolError(status: number): Response {
  return new Response('Not found.', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    status,
  });
}

function isMediaRequest(requestUrl: string): boolean {
  try {
    return new URL(requestUrl).pathname.startsWith('/media/');
  } catch {
    return false;
  }
}

function authorizedMediaRequestHash(requestUrl: string): string | undefined {
  try {
    const decodedPath = decodeURIComponent(new URL(requestUrl).pathname);
    const fileName = path.posix.basename(decodedPath);
    const hash = fileName.slice(0, -path.posix.extname(fileName).length);
    return /^[a-zA-Z0-9_-]{1,200}$/.test(hash)
      && GLOBALS.authorizedCatalogueImageHashes.has(hash)
      ? hash
      : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLocalFile(
  filePath: string,
  request: Request,
  allowDevelopmentMediaOrigin: boolean,
): Promise<Response> {
  const response = await net.fetch(pathToFileURL(filePath).toString(), {
    bypassCustomProtocolHandlers: true,
    headers: request.headers,
    method: request.method,
  });
  if (!allowDevelopmentMediaOrigin || request.headers.get('origin') !== 'http://localhost:4200') {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', 'http://localhost:4200');
  headers.set('vary', 'Origin');
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Register the single privileged-but-restricted application protocol. */
export function registerTheatrumProtocols(
  distDirectory: string,
  allowDevelopmentMediaOrigin = false,
): void {
  protocol.handle(THEATRUM_APP_PROTOCOL, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return protocolError(405);
    }

    const mediaRequest = isMediaRequest(request.url);
    const mediaHash = mediaRequest ? authorizedMediaRequestHash(request.url) : undefined;
    const authorizedHashes = GLOBALS.authorizedCatalogueImageHashes;
    const outputDirectory = GLOBALS.selectedOutputFolder;
    const hubName = GLOBALS.hubName;
    const assetDirectory = mediaRequest
      ? resolveTheatrumAssetDirectory(outputDirectory, hubName)
      : undefined;
    if (mediaRequest) {
      const filePath = mediaHash && assetDirectory
        ? resolveTheatrumMediaFile(request.url, assetDirectory)
        : undefined;
      const canonicalMediaFile = filePath && assetDirectory
        ? await normalPreviewValidation.resolve(filePath, outputDirectory, assetDirectory, request.signal)
        : undefined;
      const requestStillAuthorized = Boolean(
        canonicalMediaFile
        && !request.signal.aborted
        && GLOBALS.authorizedCatalogueImageHashes === authorizedHashes
        && GLOBALS.selectedOutputFolder === outputDirectory
        && GLOBALS.hubName === hubName
        && authorizedHashes.has(mediaHash),
      );
      return requestStillAuthorized
        ? fetchLocalFile(canonicalMediaFile, request, allowDevelopmentMediaOrigin)
        : protocolError(404);
    }

    const appFile = resolveTheatrumAppFile(request.url, distDirectory);
    return appFile
      ? fetchLocalFile(appFile, request, false)
      : protocolError(404);
  });
}
