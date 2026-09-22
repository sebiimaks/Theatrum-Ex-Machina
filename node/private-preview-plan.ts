import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import { calculateScreenshotCount } from './thumbnail-count';

const IMAGE_LIMIT = 32 * 1024 * 1024;
const HEIGHTS = new Set([144, 216, 288, 360, 432, 504]);
const MAX_DURATION = 7 * 24 * 60 * 60;
const MAX_SOURCE_DIMENSION = 32_768;
const MAX_SOURCE_PIXELS = 268_435_456;
const MAX_FRAMES = 255;
const VIDEO_RATE = 30;

export interface PrivateMediaCommandPlan {
  readonly tool: 'ffmpeg' | 'ffprobe';
  readonly args: readonly string[];
  readonly maximumBytes: number;
  readonly timeoutMs: number;
}
export interface PrivateVideoMetadata {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly hasAudio: boolean;
}
export interface PrivateFramePlan extends PrivateMediaCommandPlan { readonly timestamp: number; }
export interface PrivateClipSnippetPlan extends PrivateFramePlan {
  readonly duration: number;
  readonly outputOffset: number;
}
export interface PrivatePreviewPlan {
  readonly width: number;
  readonly height: number;
  readonly screenCount: number;
  readonly thumbnail: PrivateFramePlan;
  readonly frames: readonly PrivateFramePlan[];
  readonly filmstrip: PrivateMediaCommandPlan;
  readonly clip?: {
    readonly width: number;
    readonly height: number;
    readonly duration: number;
    readonly snippets: readonly PrivateClipSnippetPlan[];
    readonly remux: PrivateMediaCommandPlan;
    readonly poster: PrivateFramePlan;
  };
}

function invalid(): Error { return new Error('Unsupported private preview input or settings.'); }
function decimal(value: number): string { return value.toFixed(6).replace(/\.?0+$/, '') || '0'; }
function boundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function dimensions(width: unknown, height: unknown): width is number {
  return boundedNumber(width, 1, MAX_SOURCE_DIMENSION) && boundedNumber(height, 1, MAX_SOURCE_DIMENSION)
    && Number.isInteger(width) && Number.isInteger(height) && width * height <= MAX_SOURCE_PIXELS;
}
function command(tool: PrivateMediaCommandPlan['tool'], args: string[], maximumBytes: number, timeoutMs: number): PrivateMediaCommandPlan {
  return Object.freeze({ tool, args: Object.freeze(args), maximumBytes, timeoutMs });
}
function common(): string[] { return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-max_alloc', '268435456', '-filter_threads', '1', '-filter_complex_threads', '1']; }
function source(): string[] { return ['-threads', '1', '-protocol_whitelist', 'fd,pipe', '-fd', '3']; }
function stripped(): string[] {
  return ['-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', '-metadata', 'encoder=', '-metadata:s:v', 'encoder=', '-metadata:s:v', 'rotate=0', '-fflags', '+bitexact', '-flags:v', '+bitexact'];
}
function scale(width: number, height: number): string {
  return `scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
}

/** Numeric and codec information only: no path, tags, chapters, or packet payloads. */
export function privateProbeCommand(): PrivateMediaCommandPlan {
  return command('ffprobe', ['-hide_banner', '-loglevel', 'error', '-max_alloc', '268435456', ...source(),
    '-show_entries', 'format=duration:stream=codec_type,width,height,duration:stream_disposition=attached_pic', '-of', 'json', '-i', 'fd:'], 64 * 1024, 30_000);
}

export function parsePrivateProbe(bytes: Buffer): PrivateVideoMetadata {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 64 * 1024) { throw invalid(); }
    const value = JSON.parse(bytes.toString('utf8')) as {
      format?: { duration?: unknown };
      streams?: { codec_type?: unknown; width?: unknown; height?: unknown; duration?: unknown; disposition?: { attached_pic?: unknown } }[];
    };
    if (!value || !Array.isArray(value.streams) || value.streams.length > 32) { throw invalid(); }
    const streams = value.streams.filter(stream => stream && typeof stream === 'object');
    const video = streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    if (!video || !dimensions(video.width, video.height)) { throw invalid(); }
    const rawDuration = value.format?.duration ?? video.duration;
    const duration = typeof rawDuration === 'string' && /^\d+(?:\.\d+)?$/.test(rawDuration) ? Number(rawDuration) : rawDuration;
    if (!boundedNumber(duration, 0.001, MAX_DURATION)) { throw invalid(); }
    return Object.freeze({ duration, width: video.width, height: video.height as number, hasAudio: streams.some(stream => stream.codec_type === 'audio') });
  } catch { throw invalid(); }
}

function frame(timestamp: number, width: number, height: number): PrivateFramePlan {
  return Object.freeze({ ...command('ffmpeg', [...common(), ...source(), '-ss', decimal(timestamp), '-i', 'fd:',
    '-map', '0:V:0', '-an', '-sn', '-dn', ...stripped(), '-threads', '1', '-frames:v', '1', '-vf', scale(width, height),
    '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], IMAGE_LIMIT, 90_000), timestamp });
}

/** Plans contain only fixed codecs/filters and bounded numbers; never input/output filesystem paths. */
export function buildPrivatePreviewPlan(metadata: PrivateVideoMetadata, settings: ScreenshotSettings): PrivatePreviewPlan {
  if (!metadata || !dimensions(metadata.width, metadata.height) || !boundedNumber(metadata.duration, 0.001, MAX_DURATION)
    || typeof metadata.hasAudio !== 'boolean' || !settings || !HEIGHTS.has(settings.height) || !HEIGHTS.has(settings.clipHeight)
    || typeof settings.fixed !== 'boolean' || !boundedNumber(settings.n, settings.fixed ? 3 : 1, settings.fixed ? 30 : 1440)
    || (settings.fixed && !Number.isInteger(settings.n)) || !Number.isInteger(settings.clipSnippets)
    || !boundedNumber(settings.clipSnippets, 0, 15) || !boundedNumber(settings.clipSnippetLength, 1, 5)) { throw invalid(); }
  const width = settings.height * 16 / 9;
  const height = settings.height;
  const screenCount = calculateScreenshotCount(settings, metadata.duration);
  if (!Number.isInteger(screenCount) || screenCount < 1 || screenCount > MAX_FRAMES || width * screenCount > 65_535) { throw invalid(); }
  const frames = Object.freeze(Array.from({ length: screenCount }, (_, index) => frame((index + 1) * metadata.duration / (screenCount + 1), width, height)));
  const filmstrip = command('ffmpeg', [...common(), '-threads', '1', '-protocol_whitelist', 'fd,pipe', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '1', '-i', 'pipe:0',
    '-map', '0:v:0', '-an', '-sn', '-dn', ...stripped(), '-threads', '1', '-frames:v', '1',
    '-vf', `tile=${screenCount}x1:nb_frames=${screenCount}:padding=0:margin=0`, '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'], IMAGE_LIMIT, 120_000);
  let clip: PrivatePreviewPlan['clip'];
  if (settings.clipSnippets > 0) {
    const clipWidth = settings.clipHeight * 16 / 9;
    let offset = 0;
    const snippets = Object.freeze(Array.from({ length: settings.clipSnippets }, (_, index) => {
      const timestamp = (index + 1) * metadata.duration / (settings.clipSnippets + 1);
      const duration = Math.min(settings.clipSnippetLength, metadata.duration - timestamp);
      const outputOffset = offset;
      offset += duration;
      const audio = metadata.hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000'] : ['-an'];
      return Object.freeze({ ...command('ffmpeg', [...common(), ...source(), '-ss', decimal(timestamp), '-t', decimal(duration), '-i', 'fd:',
        '-map', '0:V:0', ...audio, '-sn', '-dn', ...stripped(), '-threads', '1', '-vf', scale(clipWidth, settings.clipHeight),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(VIDEO_RATE), '-g', String(VIDEO_RATE), '-bf', '0',
        '-output_ts_offset', decimal(outputOffset), '-avoid_negative_ts', 'disabled', '-mpegts_copyts', '1', '-muxdelay', '0', '-muxpreload', '0',
        '-mpegts_flags', '+resend_headers+initial_discontinuity', '-f', 'mpegts', 'pipe:1'], 32 * 1024 * 1024, 120_000), timestamp, duration, outputOffset });
    }));
    const remux = command('ffmpeg', [...common(), '-threads', '1', '-protocol_whitelist', 'fd,pipe', '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:V:0', ...(metadata.hasAudio ? ['-map', '0:a:0'] : ['-an']), '-sn', '-dn', ...stripped(), '-c', 'copy',
      ...(metadata.hasAudio ? ['-bsf:a', 'aac_adtstoasc'] : []),
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof+disable_chpl', '-write_tmcd', '0', '-f', 'mp4', 'pipe:1'], 256 * 1024 * 1024, 300_000);
    clip = Object.freeze({ width: clipWidth, height: settings.clipHeight, duration: offset, snippets, remux,
      poster: frame(snippets[0].timestamp, clipWidth, settings.clipHeight) });
  }
  return Object.freeze({ width, height, screenCount, thumbnail: frame(metadata.duration / 10, width, height), frames, filmstrip, ...(clip ? { clip } : {}) });
}

/** Check the JPEG envelope and encoded dimensions; successful FFmpeg decoding/encoding supplies image validity. */
export function validatePrivateJpeg(bytes: Buffer, width: number, height: number): void {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > IMAGE_LIMIT || bytes.readUInt16BE(0) !== 0xffd8
    || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9 || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 1 || height < 1 || width > 65_535 || height > 65_535) { throw invalid(); }
  let offset = 2;
  let foundDimensions = false;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) { throw invalid(); }
    while (bytes[offset] === 0xff) { offset++; }
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === undefined || offset + 2 > bytes.length) { break; }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) { throw invalid(); }
    if (marker === 0xda) {
      if (!foundDimensions || length < 6 || offset + length >= bytes.length - 2) { throw invalid(); }
      return;
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (foundDimensions || length < 11 || bytes[offset + 2] !== 8 || bytes.readUInt16BE(offset + 3) !== height
        || bytes.readUInt16BE(offset + 5) !== width || length !== 8 + 3 * bytes[offset + 7]) { throw invalid(); }
      foundDimensions = true;
    }
    offset += length;
  }
  throw invalid();
}
