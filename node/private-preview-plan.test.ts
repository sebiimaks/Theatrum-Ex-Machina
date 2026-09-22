import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import type { ScreenshotSettings } from '../interfaces/final-object.interface';
import { ffmpegPath, ffprobePath } from './media-tool-paths';
import { buildPrivatePreviewPlan, parsePrivateProbe, privateProbeCommand, validatePrivateJpeg, type PrivateMediaCommandPlan, type PrivateVideoMetadata } from './private-preview-plan';

const cwd = path.resolve(__dirname, '..');
const metadata: PrivateVideoMetadata = { duration: 60, width: 1920, height: 1080, hasAudio: true };
const settings: ScreenshotSettings = { fixed: true, n: 3, height: 144, clipHeight: 144, clipSnippets: 3, clipSnippetLength: 1 };
const canary = 'PRIVATE-PREVIEW-METADATA-CANARY';

function run(plan: PrivateMediaCommandPlan, source?: string, input?: Buffer): Buffer {
  const descriptor = source ? fs.openSync(source, 'r') : undefined;
  try {
    const result = spawnSync(plan.tool === 'ffmpeg' ? ffmpegPath : ffprobePath, [...plan.args], {
      cwd, input, stdio: ['pipe', 'pipe', 'pipe', descriptor ?? 'ignore'],
      timeout: plan.timeoutMs, maxBuffer: plan.maximumBytes, encoding: 'buffer',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  } finally { if (descriptor !== undefined) { fs.closeSync(descriptor); } }
}

async function sourceFixture(t: TestContext, audio: boolean): Promise<string> {
  const temporary = path.join(cwd, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const directory = fs.mkdtempSync(path.join(temporary, 'private-preview-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'synthetic-source.mp4');
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30',
    ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000'] : []), '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast',
    ...(audio ? ['-c:a', 'aac'] : ['-an']), '-metadata', `title=${canary}`, '-metadata', `comment=${canary}`,
    '-metadata:s:v', `title=${canary}`, '-metadata:s:v', `handler_name=${canary}`,
    ...(audio ? ['-metadata:s:a', `handler_name=${canary}`, '-metadata:s:a', 'language=fra'] : []), '-y', source], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return source;
}

test('metadata parser returns only bounded video properties and skips attached cover images', () => {
  const parsed = parsePrivateProbe(Buffer.from(JSON.stringify({ streams: [
    { codec_type: 'video', width: 100, height: 100, disposition: { attached_pic: 1 } },
    { codec_type: 'video', width: 1920, height: 1080, tags: { title: canary } }, { codec_type: 'audio' },
  ], format: { duration: '60.250000', filename: canary, tags: { comment: canary } } })));
  assert.deepEqual(parsed, { duration: 60.25, width: 1920, height: 1080, hasAudio: true });
  assert.equal(Object.isFrozen(parsed), true);
  assert.ok(!JSON.stringify(parsed).includes(canary));
});

test('metadata rejects malformed, oversized, audio-only and unreasonable input', () => {
  for (const value of [null, {}, { streams: [] }, { streams: [{ codec_type: 'audio' }] },
    { streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: 'NaN' } },
    { streams: [{ codec_type: 'video', width: 1000000, height: 1000000 }], format: { duration: 60 } },
    { streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: 10 ** 20 } },
    { streams: Array.from({ length: 33 }, () => ({ codec_type: 'video', width: 100, height: 100 })), format: { duration: 1 } },
  ]) { assert.throws(() => parsePrivateProbe(Buffer.from(JSON.stringify(value)))); }
  assert.throws(() => parsePrivateProbe(Buffer.alloc(65_537)));
  assert.throws(() => parsePrivateProbe(Buffer.from('not JSON')));
});

test('JPEG envelope validation rejects truncated segments, missing scans, and impossible dimensions', () => {
  for (const bytes of [Buffer.alloc(12), Buffer.from('ffd8ffffffffffffffffffd9', 'hex'),
    Buffer.from('ffd8ffc00011080090010003012200021101031101ffd9', 'hex'),
    Buffer.from('ffd8ffe0ffff000000000000ffd9', 'hex')]) {
    assert.throws(() => validatePrivateJpeg(bytes, 256, 144));
  }
});

test('all command plans are immutable bounded FD/pipe-only plans with explicit formats and metadata removal', () => {
  const plan = buildPrivatePreviewPlan(metadata, settings);
  assert.deepEqual(plan.frames.map(frame => frame.timestamp), [15, 30, 45]);
  assert.equal(plan.thumbnail.timestamp, 6);
  assert.equal(plan.screenCount, 3);
  assert.equal(plan.width, 256);
  assert.equal(plan.height, 144);
  assert.deepEqual(plan.clip!.snippets.map(snippet => snippet.outputOffset), [0, 1, 2]);
  assert.equal(plan.clip!.duration, 3);
  const commands = [privateProbeCommand(), plan.thumbnail, ...plan.frames, plan.filmstrip, ...plan.clip!.snippets, plan.clip!.remux, plan.clip!.poster];
  for (const item of commands) {
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(item.args), true);
    assert.equal(item.args[item.args.indexOf('-protocol_whitelist') + 1], 'fd,pipe');
    assert.ok(['fd:', 'pipe:0'].includes(item.args[item.args.indexOf('-i') + 1]));
    assert.ok(item.maximumBytes > 0 && item.maximumBytes <= 256 * 1024 * 1024);
    assert.ok(item.timeoutMs > 0 && item.timeoutMs <= 300_000);
    assert.ok(!item.args.some(arg => /https?:|file:|\/tmp\/|\.mp4$|\.jpg$/.test(arg)));
    if (item.tool === 'ffmpeg') {
      assert.equal(item.args.at(-1), 'pipe:1');
      assert.equal(item.args[item.args.indexOf('-map_metadata') + 1], '-1');
      assert.equal(item.args[item.args.indexOf('-map_chapters') + 1], '-1');
      assert.ok(item.args.includes('-sn') && item.args.includes('-dn'));
    }
  }
});

test('settings and intervals remain bounded without silently dropping requested clips', () => {
  for (const patch of [{ n: 31 }, { n: 2 }, { n: NaN }, { n: 3.5 }, { height: 999 }, { clipHeight: 999 },
    { clipSnippets: 16 }, { clipSnippets: -1 }, { clipSnippets: 1.5 }, { clipSnippetLength: 0.1 }, { clipSnippetLength: 6 }]) {
    assert.throws(() => buildPrivatePreviewPlan(metadata, { ...settings, ...patch } as ScreenshotSettings));
  }
  assert.throws(() => buildPrivatePreviewPlan({ ...metadata, duration: Infinity }, settings));
  const interval = buildPrivatePreviewPlan({ ...metadata, duration: 7 * 24 * 60 * 60 }, { ...settings, fixed: false, n: 1 });
  assert.equal(interval.screenCount, 255);
  assert.ok(interval.width * interval.screenCount <= 65535);
  const short = buildPrivatePreviewPlan({ ...metadata, duration: 0.5 }, settings);
  assert.equal(short.screenCount, 2);
  assert.ok(short.clip!.snippets.every(snippet => snippet.timestamp + snippet.duration <= 0.5));
  assert.equal(buildPrivatePreviewPlan(metadata, { ...settings, clipSnippets: 0 }).clip, undefined);
});

test('real FFmpeg plans generate correctly sized JPEGs and audio-preserving continuous fragmented clips entirely over pipes', async t => {
  const source = await sourceFixture(t, true);
  const probed = parsePrivateProbe(run(privateProbeCommand(), source));
  assert.equal(probed.hasAudio, true);
  const plan = buildPrivatePreviewPlan(probed, settings);
  const thumbnail = run(plan.thumbnail, source);
  validatePrivateJpeg(thumbnail, plan.width, plan.height);
  assert.throws(() => validatePrivateJpeg(thumbnail, plan.width + 1, plan.height));
  assert.throws(() => validatePrivateJpeg(thumbnail.subarray(0, thumbnail.length - 2), plan.width, plan.height));
  const frames = plan.frames.map(frame => run(frame, source));
  for (const frame of frames) { validatePrivateJpeg(frame, plan.width, plan.height); }
  const filmstrip = run(plan.filmstrip, undefined, Buffer.concat(frames));
  validatePrivateJpeg(filmstrip, plan.width * plan.screenCount, plan.height);
  const poster = run(plan.clip!.poster, source);
  validatePrivateJpeg(poster, plan.clip!.width, plan.clip!.height);
  const snippets = plan.clip!.snippets.map(snippet => run(snippet, source));
  const clip = run(plan.clip!.remux, undefined, Buffer.concat(snippets));
  for (const bytes of [thumbnail, filmstrip, poster, clip, ...snippets]) { assert.ok(!bytes.includes(Buffer.from(canary))); }
  assert.ok(clip.includes(Buffer.from('moof')), 'MP4 must be fragmented for nonseekable output');
  const inspected = JSON.parse(run({ tool: 'ffprobe', args: ['-v', 'error', '-protocol_whitelist', 'fd,pipe', '-f', 'mov', '-i', 'pipe:0',
    '-show_entries', 'stream=codec_type,width,height,duration:stream_tags:format=duration:format_tags:packet=stream_index,pts_time,dts_time,duration_time',
    '-show_packets', '-of', 'json'], maximumBytes: 2 * 1024 * 1024, timeoutMs: 30_000 }, undefined, clip).toString());
  assert.deepEqual(inspected.streams.map((stream: { codec_type: string }) => stream.codec_type), ['video', 'audio']);
  assert.equal(inspected.streams[1].tags?.language, 'und', 'source stream language metadata must also be removed');
  assert.equal(inspected.streams[0].width, plan.clip!.width);
  assert.equal(inspected.streams[0].height, plan.clip!.height);
  const videoPackets = inspected.packets.filter((packet: { stream_index: number }) => packet.stream_index === 0);
  assert.equal(videoPackets.length, 90);
  // A nonseekable fragmented MP4's format estimate may cover its first fragment;
  // stream durations and decoded packet times describe the complete piped clip.
  for (const stream of inspected.streams) { assert.ok(Math.abs(Number(stream.duration) - plan.clip!.duration) < 0.1); }
  for (const streamIndex of [0, 1]) {
    const packets = inspected.packets.filter((packet: { stream_index: number }) => packet.stream_index === streamIndex);
    for (let index = 1; index < packets.length; index++) {
      const delta = Number(packets[index].dts_time) - Number(packets[index - 1].dts_time);
      assert.ok(delta > 0 && delta < 0.06, `Stream ${streamIndex} has a discontinuity: ${delta}`);
    }
  }
  assert.ok(!JSON.stringify(inspected).includes(canary));
});

test('real silent source generates silent clips without inventing or requiring an audio stream', async t => {
  const source = await sourceFixture(t, false);
  const metadata = parsePrivateProbe(run(privateProbeCommand(), source));
  assert.equal(metadata.hasAudio, false);
  const plan = buildPrivatePreviewPlan(metadata, settings);
  const clip = run(plan.clip!.remux, undefined, Buffer.concat(plan.clip!.snippets.map(snippet => run(snippet, source))));
  const inspected = JSON.parse(run({ tool: 'ffprobe', args: ['-v', 'error', '-protocol_whitelist', 'fd,pipe', '-f', 'mov', '-i', 'pipe:0',
    '-show_entries', 'stream=codec_type,duration:packet=dts_time', '-show_packets', '-of', 'json'], maximumBytes: 128 * 1024, timeoutMs: 30_000 }, undefined, clip).toString());
  assert.deepEqual(inspected.streams.map((stream: { codec_type: string }) => stream.codec_type), ['video']);
  assert.ok(Math.abs(Number(inspected.streams[0].duration) - plan.clip!.duration) < 0.1);
  assert.equal(inspected.packets.length, 90);
  assert.ok(!clip.includes(Buffer.from(canary)));
  for (let index = 1; index < inspected.packets.length; index++) {
    const delta = Number(inspected.packets[index].dts_time) - Number(inspected.packets[index - 1].dts_time);
    assert.ok(delta > 0 && delta < 0.04);
  }
});
