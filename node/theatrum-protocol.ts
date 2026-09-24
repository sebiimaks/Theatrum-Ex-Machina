import { net, protocol } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  THEATRUM_APP_PROTOCOL,
} from '../interfaces/theatrum-protocol';
import { GLOBALS } from './main-globals';
import { normalOperationScope, type NormalOperationContext } from './normal-operation-scope';
import {
  resolveTheatrumAppFile,
  resolveTheatrumAssetDirectory,
  resolveTheatrumMediaFile,
} from './theatrum-protocol-paths';

import { normalPreviewValidation } from './normal-preview-validation';

const MAX_NORMAL_MEDIA_RESPONSES = 512;
let activeNormalMediaResponses = 0;

function protocolError(status: number): Response {
  return new Response('Not found.', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
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
  signal?: AbortSignal,
): Promise<Response> {
  const response = await net.fetch(pathToFileURL(filePath).toString(), {
    bypassCustomProtocolHandlers: true,
    headers: request.headers,
    method: request.method,
    ...(signal ? { signal } : {}),
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

/**
 * Return headers independently while retaining the fetch/read/cancel promise
 * lifetime in the normal-operation scope. No media bytes are read ahead by this wrapper.
 * Drain evidence covers fetch/read/cancel promises, not Chromium or OS caches.
 */
function fetchNormalMedia(
  filePath: string,
  outputDirectory: string,
  assetDirectory: string,
  request: Request,
  allowDevelopmentMediaOrigin: boolean,
  stillAuthorized: () => boolean,
): Promise<Response> {
  if (activeNormalMediaResponses >= MAX_NORMAL_MEDIA_RESPONSES) { return Promise.resolve(protocolError(404)); }
  activeNormalMediaResponses++;
  return new Promise<Response>(respond => {
    void normalOperationScope.run(async (context: NormalOperationContext) => {
      const nativeController = new AbortController();
      const revoked = AbortSignal.any([context.signal, request.signal]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let outstandingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
      let cancellation: Promise<void> | undefined;
      let finished!: () => void;
      let complete = false;
      const bodyFinished = new Promise<void>(resolve => { finished = resolve; });
      const current = (): boolean => context.isCurrent() && !revoked.aborted
        && !nativeController.signal.aborted && stillAuthorized();
      const retire = (): Promise<void> => {
        if (cancellation) { return cancellation; }
        const ownedReader = reader;
        if (ownedReader) {
          // Reserve before aborting: native cancellation may synchronously
          // revoke the renderer request and reenter this method.
          cancellation = Promise.resolve().then(async () => {
            // cancel() can resolve read() before native cancellation finishes.
            // Keep the operation until both returned promises have settled.
            // A cancellation rejection also settles this lease; it is not
            // evidence that Chromium/OS resources or cached bytes were erased.
            await Promise.allSettled([
              ownedReader.cancel(),
              ...(outstandingRead ? [outstandingRead] : []),
            ]);
            complete = true;
            try { ownedReader.releaseLock(); } catch { /* Already released. */ }
            finished();
          });
        }
        nativeController.abort();
        try { controller?.error(new Error('The media request was cancelled.')); } catch { /* Already closed. */ }
        // A fetch without headers remains tracked by the surrounding await;
        // any late response gets its own reader cancellation before returning.
        return cancellation || Promise.resolve();
      };
      const revoke = (): void => { void retire(); };
      revoked.addEventListener('abort', revoke, { once: true });
      try {
        if (!current()) { respond(protocolError(404)); return; }
        const canonicalFile = await normalPreviewValidation.resolve(filePath, outputDirectory, assetDirectory, revoked);
        if (!canonicalFile || !current()) { respond(protocolError(404)); return; }
        const response = await fetchLocalFile(canonicalFile, request, allowDevelopmentMediaOrigin, nativeController.signal);
        if (response.body) { reader = response.body.getReader(); }
        if (!current()) {
          await retire();
          respond(protocolError(404));
          return;
        }
        if (!reader) { respond(response); return; }
        if (request.method === 'HEAD') {
          await retire();
          respond(context.isCurrent() && !revoked.aborted && stillAuthorized()
            ? new Response(null, { headers: response.headers, status: response.status, statusText: response.statusText })
            : protocolError(404));
          return;
        }
        const body = new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          async pull(target) {
            if (complete || !current()) { await retire(); return; }
            try {
              outstandingRead = reader.read();
              const chunk = await outstandingRead;
              outstandingRead = undefined;
              if (!current()) { await retire(); return; }
              if (chunk.done) {
                complete = true;
                reader.releaseLock();
                target.close();
                finished();
              } else { target.enqueue(chunk.value); }
            } catch { await retire(); }
          },
          cancel() { return retire(); },
        }, { highWaterMark: 0 });
        respond(new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText }));
        await bodyFinished;
        if (cancellation) { await cancellation; }
      } catch {
        await retire();
        respond(protocolError(404));
      } finally {
        revoked.removeEventListener('abort', revoke);
      }
    }).catch(() => { respond(protocolError(404)); })
      .finally(() => { activeNormalMediaResponses--; });
  });
}

/** Keep registration thin so the production handler can be exercised in isolation. */
export function createTheatrumProtocolHandler(
  distDirectory: string,
  allowDevelopmentMediaOrigin = false,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return protocolError(405);
    }

    const mediaRequest = isMediaRequest(request.url);
    const storage = GLOBALS.catalogueStorage;
    const sessionGeneration = GLOBALS.catalogueSessionGeneration;
    const mediaHash = mediaRequest ? authorizedMediaRequestHash(request.url) : undefined;
    const authorizedHashes = GLOBALS.authorizedCatalogueImageHashes;
    if (mediaRequest && storage?.kind !== 'normal') {
      // This handler belongs to the ordinary persistent browser session. Only
      // the isolated private-browser handler may deliver decrypted previews.
      // A private binding must never fall back to old plaintext files either.
      return protocolError(404);
    }
    const outputDirectory = GLOBALS.selectedOutputFolder;
    const hubName = GLOBALS.hubName;
    const assetDirectory = mediaRequest
      ? resolveTheatrumAssetDirectory(outputDirectory, hubName)
      : undefined;
    if (mediaRequest) {
      const filePath = mediaHash && assetDirectory
        ? resolveTheatrumMediaFile(request.url, assetDirectory)
        : undefined;
      const requestStillAuthorized = (): boolean => (
        GLOBALS.catalogueStorage === storage
        && GLOBALS.catalogueSessionGeneration === sessionGeneration
        && GLOBALS.authorizedCatalogueImageHashes === authorizedHashes
        && GLOBALS.selectedOutputFolder === outputDirectory
        && GLOBALS.hubName === hubName
        && authorizedHashes.has(mediaHash)
      );
      return filePath && assetDirectory && normalOperationScope.accepting && requestStillAuthorized()
        ? fetchNormalMedia(filePath, outputDirectory, assetDirectory, request, allowDevelopmentMediaOrigin, requestStillAuthorized)
        : protocolError(404);
    }

    const appFile = resolveTheatrumAppFile(request.url, distDirectory);
    return appFile
      ? fetchLocalFile(appFile, request, false)
      : protocolError(404);
  };
}

/** Register the single privileged-but-restricted application protocol. */
export function registerTheatrumProtocols(distDirectory: string, allowDevelopmentMediaOrigin = false): void {
  protocol.handle(THEATRUM_APP_PROTOCOL, createTheatrumProtocolHandler(distDirectory, allowDevelopmentMediaOrigin));
}
