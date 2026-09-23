import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrivateHubSession } from './private-hub-session';
import { parseTheatrumMediaRequest } from './theatrum-protocol-paths';
import { resolvePrivateUiDirectory } from './private-ui-paths';

export const PRIVATE_BROWSER_ENTRY_URL = 'theatrum://app/index.html';
const MAX_STATIC_BYTES = 8 * 1024 * 1024;
const MAX_STATIC_READS = 4;
const CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
});

export interface PrivateBrowserProtocolOptions {
  hub: PrivateHubSession;
  generation: number;
  appDirectory: string;
  /** Main-owned capsule lifetime check; never derived from request data. */
  isCurrent: () => boolean;
}

export interface PrivateUnlockProtocolOptions {
  appDirectory: string;
  /** Main-owned prompt lifetime. This protocol has no hub or media authority. */
  isCurrent: () => boolean;
}

const UNLOCK_ASSETS = new Set(['/index.html', '/unlock.js', '/unlock.css']);
const CONVERSION_ASSETS = new Set(['/index.html', '/conversion.js', '/conversion.css']);

export function isPrivateConversionRequestAllowed(url: string, method: string): boolean {
  const requestPath = allowedPath(url, method);
  return !!requestPath && CONVERSION_ASSETS.has(requestPath);
}

export function isPrivateUnlockRequestAllowed(url: string, method: string): boolean {
  const requestPath = allowedPath(url, method);
  return !!requestPath && UNLOCK_ASSETS.has(requestPath);
}

function allowedPath(url: string, method: string): string | undefined {
  if ((method !== 'GET' && method !== 'HEAD') || typeof url !== 'string' || url.length > 4096
    || !url.startsWith('theatrum://app/') || /[^\x21-\x7e]|[\\#]/.test(url)) { return undefined; }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'theatrum:' || parsed.hostname !== 'app' || parsed.port || parsed.username || parsed.password || parsed.hash) { return undefined; }
    const rawPath = url.slice('theatrum://app'.length).split('?')[0];
    if (rawPath !== parsed.pathname || rawPath.length > 2048 || rawPath.includes('%')) { return undefined; }
    const segments = rawPath.slice(1).split('/');
    if (segments.length > 32 || segments.some(segment => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(segment))) { return undefined; }
    if (url.includes('?')) {
      if (!/^\?v=[a-zA-Z0-9._~%-]{1,768}$/.test(parsed.search)) { return undefined; }
      const cacheKey = decodeURIComponent(parsed.search.slice(3));
      if (!/^[a-zA-Z0-9._~-]{1,256}$/.test(cacheKey)) { return undefined; }
    }
    if (segments[0] === 'media') {
      return parseTheatrumMediaRequest(url) ? rawPath : undefined;
    }
    const extension = path.posix.extname(rawPath).toLowerCase();
    return Object.hasOwn(TYPES, extension) && (extension !== '.html' || rawPath === '/index.html') ? rawPath : undefined;
  } catch { return undefined; }
}

/** A route allowlist only; actual reads also require the captured live hub and capsule. */
export function isPrivateBrowserRequestAllowed(url: string, method: string): boolean {
  return allowedPath(url, method) !== undefined;
}

function headers(): Headers {
  return new Headers({
    'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
  });
}

function empty(status: number): Response {
  const result = headers();
  result.set('Content-Length', '0');
  if (status === 405) { result.set('Allow', 'GET, HEAD'); }
  return new Response(null, { status, headers: result });
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function unchanged(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function validFile(stats: fs.BigIntStats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n && stats.size >= 0n && stats.size <= BigInt(MAX_STATIC_BYTES);
}

/**
 * Isolated private-window protocol. Static assets come exclusively from one
 * canonical app directory; previews exclusively from the captured private hub.
 * No application globals, normal-hub resolver, Electron fetch, or file URL exists here.
 */
export function createPrivateBrowserProtocolHandler(options: PrivateBrowserProtocolOptions): (request: Request) => Promise<Response> {
  return createProtocolHandler(options, { hub: options.hub, generation: options.generation });
}

/** Credentials are entered before unlocking: only the three bundled prompt assets exist here. */
export function createPrivateUnlockProtocolHandler(options: PrivateUnlockProtocolOptions): (request: Request) => Promise<Response> {
  return createProtocolHandler(options);
}

/** Creation has no media authority and serves only its three bundled assets. */
export function createPrivateConversionProtocolHandler(options: PrivateUnlockProtocolOptions): (request: Request) => Promise<Response> {
  return createProtocolHandler(options, undefined, CONVERSION_ASSETS);
}

function createProtocolHandler(
  options: PrivateUnlockProtocolOptions,
  mediaAuthority?: Pick<PrivateBrowserProtocolOptions, 'hub' | 'generation'>,
  staticAssets = UNLOCK_ASSETS,
): (request: Request) => Promise<Response> {
  const capsuleCurrent = options.isCurrent;
  let root: string | undefined;
  let rootIdentity: fs.BigIntStats | undefined;
  let reading = 0;
  try {
    if (typeof options.appDirectory !== 'string' || !path.isAbsolute(options.appDirectory) || options.appDirectory.includes('\0')
      || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) { throw new Error(); }
    root = resolvePrivateUiDirectory(path.resolve(options.appDirectory));
    rootIdentity = fs.lstatSync(root, { bigint: true });
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || fs.realpathSync.native(root) !== root) { throw new Error(); }
  } catch { root = undefined; rootIdentity = undefined; }

  const current = (request: Request): boolean => {
    try {
      const mediaCurrent = (): boolean => !mediaAuthority || mediaAuthority.hub.isCurrent(mediaAuthority.generation);
      return !!root && !!rootIdentity && !request.signal.aborted && mediaCurrent()
        && capsuleCurrent() === true && !request.signal.aborted && mediaCurrent();
    } catch { return false; }
  };
  const check = (request: Request): void => { if (!current(request)) { throw new Error('Private browser resource unavailable.'); } };
  const checkRoot = async (request: Request): Promise<void> => {
    check(request);
    const stat = await fs.promises.lstat(root!, { bigint: true });
    check(request);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(rootIdentity!, stat) || await fs.promises.realpath(root!) !== root) { throw new Error(); }
    check(request);
  };

  const readStatic = async (request: Request, requestPath: string): Promise<Response> => {
    await checkRoot(request);
    const file = path.join(root!, requestPath.slice(1));
    const before = await fs.promises.lstat(file, { bigint: true });
    check(request);
    if (!validFile(before) || await fs.promises.realpath(file) !== file) { throw new Error(); }
    check(request);
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
      check(request);
      const opened = await handle.stat({ bigint: true });
      check(request);
      if (!validFile(opened) || !unchanged(before, opened)) { throw new Error(); }
      if (request.method === 'GET') {
        bytes = Buffer.alloc(Number(opened.size) + 1);
        let offset = 0;
        while (offset < bytes.length) {
          check(request);
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          check(request);
          if (read.bytesRead === 0) { break; }
          offset += read.bytesRead;
        }
        if (offset !== Number(opened.size)) { throw new Error(); }
      }
      const after = await handle.stat({ bigint: true });
      check(request);
      const latest = await fs.promises.lstat(file, { bigint: true });
      check(request);
      if (!validFile(after) || !validFile(latest) || !unchanged(opened, after) || !unchanged(opened, latest)
        || await fs.promises.realpath(file) !== file) { throw new Error(); }
      await checkRoot(request);
      check(request);
      const resultHeaders = headers();
      resultHeaders.set('Content-Type', TYPES[path.posix.extname(requestPath).toLowerCase()]);
      resultHeaders.set('Content-Length', String(opened.size));
      return new Response(bytes ? Uint8Array.from(bytes.subarray(0, Number(opened.size))) : null, { headers: resultHeaders });
    } finally { bytes?.fill(0); await handle.close(); }
  };

  return async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') { return empty(405); }
    const requestPath = allowedPath(request.url, request.method);
    if (!requestPath || (!mediaAuthority && !staticAssets.has(requestPath)) || !current(request)) { return empty(404); }
    let response: Response | undefined;
    let admittedStaticRead = false;
    try {
      const media = requestPath.startsWith('/media/') ? parseTheatrumMediaRequest(request.url) : undefined;
      if (media) {
        if (!mediaAuthority) { return empty(404); }
        const kind = media.assetType === 'thumbnails' ? 'thumbnail' : media.assetType === 'filmstrips' ? 'filmstrip' : media.video ? 'clip' : 'clip-poster';
        response = await mediaAuthority.hub.createPreviewResponse(mediaAuthority.generation, kind, media.hash, request, { isAuthorized: () => current(request) });
        check(request);
        const resultHeaders = new Headers(response.headers);
        headers().forEach((value, name) => resultHeaders.set(name, value));
        if (request.method === 'HEAD') { await response.body?.cancel(); check(request); }
        response = new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
      } else {
        if (reading >= MAX_STATIC_READS) { return empty(503); }
        reading++;
        admittedStaticRead = true;
        response = await readStatic(request, requestPath);
      }
      check(request);
      return response;
    } catch {
      void response?.body?.cancel().catch(() => undefined);
      return empty(404);
    } finally { if (admittedStaticRead) { reading--; } }
  };
}
