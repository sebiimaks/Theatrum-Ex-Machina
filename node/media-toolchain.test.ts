import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';

import { NewImageElement } from '../interfaces/final-object.interface.ts';
import { buildFfprobeArguments } from './local-operation-safety.ts';
import {
  extractAll,
  extractConcealedFrameArgs,
  extractFilmstripWithRecovery,
  extractFirstFrameArgs,
  extractRecoveryFrameArgs,
  extractSingleFrameArgs,
  extractThumbnailWithRecovery,
  fillMissingRecoveryFrames,
  generatePreviewClipArgs,
  generateScreenshotStripArgs,
  readJpegDimensions,
  replaceThumbnailWithNewImage,
  selectRecoveryFrameIndexes,
  setExtractionDurations,
  spawn_ffmpeg_and_run,
  spawn_ffmpeg_and_run_detailed,
  stackRecoveredFramesArgs,
} from './main-extract.ts';
import { ffmpegPath, ffprobePath } from './media-tool-paths.ts';

const temporaryDirectories: string[] = [];

interface ToolResult {
  stderr: string;
  stdout: string;
  status: number | null;
}

function runTool(command: string, args: string[], timeout = 30_000): ToolResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    stderr: result.stderr || '',
    stdout: result.stdout || '',
    status: result.status,
  };
}

function readVersion(command: string): { line: string; major: number; minor: number } {
  const result = runTool(command, ['-version']);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n')[0];
  const match = line.match(/version\s+(\d+)\.(\d+)/);
  assert.ok(match, `Could not parse media-tool version: ${line}`);
  return {
    line,
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-media-'));
  temporaryDirectories.push(directory);
  return directory;
}

class FakeMediaProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: (NodeJS.Signals | undefined)[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
  }
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory: string) => {
    fs.rmSync(directory, { force: true, recursive: true });
  });
});

test('bundles matching FFmpeg and FFprobe 8.1.2 executables', () => {
  const ffmpegVersion = readVersion(ffmpegPath);
  const ffprobeVersion = readVersion(ffprobePath);

  assert.match(ffmpegVersion.line, /^ffmpeg version 8\.1\.2(?:\s|$)/);
  assert.match(ffprobeVersion.line, /^ffprobe version 8\.1\.2(?:\s|$)/);
  assert.deepEqual(
    [ffprobeVersion.major, ffprobeVersion.minor],
    [ffmpegVersion.major, ffmpegVersion.minor],
    'FFmpeg and FFprobe must come from the same release series.',
  );
  const configuration = runTool(ffmpegPath, ['-version']).stdout;
  assert.match(configuration, /--enable-gpl/);
  assert.match(configuration, /--enable-libx264/);
});

test('retains the extended thumbnail and filmstrip timeout allowances', () => {
  const durations = setExtractionDurations(720, 4, 144, 3, 1, 144);
  assert.equal(durations.thumb, 15_000);
  assert.equal(durations.filmstrip, 30_000);

  const expensiveDurations = setExtractionDurations(2160, 30, 504, 3, 1, 144);
  assert.equal(expensiveDurations.thumb, 2000 * 4 * (1 + (3.5 * 3.5 / 4)));
  assert.equal(expensiveDurations.filmstrip, 1400 * 4 * (1 + (3.5 * 3.5 / 4)) * 30);
});

test('recovery arguments tolerate damaged input without weakening the normal path', () => {
  const scanArgs = extractRecoveryFrameArgs('damaged.mp4', 90, 2, 'recovered.jpg', 'scan');
  const inputIndex = scanArgs.indexOf('-i');
  const seekIndex = scanArgs.indexOf('-ss');

  assert.ok(scanArgs.indexOf('-fflags') < inputIndex);
  assert.ok(scanArgs.indexOf('-err_detect') < inputIndex);
  assert.ok(seekIndex > inputIndex, 'scan recovery must not rely on the media index');
  assert.deepEqual(scanArgs.slice(scanArgs.indexOf('-map'), scanArgs.indexOf('-map') + 2), ['-map', '0:V:0']);
  assert.ok(scanArgs.includes('-max_error_rate'));
  assert.ok(scanArgs.includes('-y'));

  const fastArgs = extractRecoveryFrameArgs('damaged.mp4', 90, 20, 'recovered.jpg', 'fast');
  assert.ok(fastArgs.indexOf('-ss') < fastArgs.indexOf('-i'));

  const concealedArgs = extractConcealedFrameArgs('damaged.mp4', 90, 'concealed.jpg');
  assert.ok(concealedArgs.indexOf('-flags') < concealedArgs.indexOf('-i'));
  assert.equal(concealedArgs[concealedArgs.indexOf('-flags') + 1], '+output_corrupt');
  assert.equal(concealedArgs[concealedArgs.indexOf('-map') + 1], '0:V:0');
});

test('partial filmstrip recovery keeps the configured number of cells', () => {
  assert.deepEqual(selectRecoveryFrameIndexes(5), [0, 1, 2, 3, 4]);
  assert.deepEqual(selectRecoveryFrameIndexes(100, 3), [0, 50, 99]);

  const recovered = new Map<number, string>([[0, 'early.jpg'], [3, 'late.jpg']]);
  assert.deepEqual(
    fillMissingRecoveryFrames(5, recovered, 'fallback.jpg'),
    ['early.jpg', 'early.jpg', 'late.jpg', 'late.jpg', 'late.jpg'],
  );

  const stackArgs = stackRecoveredFramesArgs(
    ['early.jpg', 'early.jpg', 'late.jpg'],
    'strip.jpg',
  );
  assert.match(stackArgs[stackArgs.indexOf('-filter_complex') + 1], /hstack=inputs=3$/);
});

test('media extraction timeout settles even when the child never closes', async () => {
  const mediaProcess = new FakeMediaProcess();
  const extraction = spawn_ffmpeg_and_run([], 10, 'timeout regression test', () => mediaProcess);
  let watchdog: NodeJS.Timeout | undefined;

  try {
    const result = await Promise.race([
      extraction,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('Timed-out extraction did not settle')), 250);
      }),
    ]);
    assert.equal(result, false);
    assert.deepEqual(mediaProcess.killSignals, [undefined]);
  } finally {
    if (watchdog) {
      clearTimeout(watchdog);
    }
    mediaProcess.exit(null, 'SIGTERM');
    mediaProcess.close(null, 'SIGTERM');
  }
});

test('media extraction resolves successfully when the child exits before its timeout', async () => {
  const mediaProcess = new FakeMediaProcess();
  const extraction = spawn_ffmpeg_and_run([], 250, 'successful extraction test', () => mediaProcess);
  queueMicrotask(() => mediaProcess.exit(0, null));

  assert.equal(await extraction, true);
  assert.deepEqual(mediaProcess.killSignals, []);
  mediaProcess.close(0, null);
});

test('media process results distinguish warning exits from timeouts and spawn errors', async () => {
  const warningProcess = new FakeMediaProcess();
  const warningResult = spawn_ffmpeg_and_run_detailed(
    [],
    250,
    'warning result test',
    () => warningProcess,
  );
  queueMicrotask(() => warningProcess.exit(69, null));

  assert.deepEqual(await warningResult, {
    exitCode: 69,
    processError: false,
    success: false,
    timedOut: false,
  });
  warningProcess.close(69, null);

  const errorProcess = new FakeMediaProcess();
  const errorResult = spawn_ffmpeg_and_run_detailed(
    [],
    250,
    'spawn error result test',
    () => errorProcess,
  );
  queueMicrotask(() => errorProcess.emit('error', new Error('spawn failed')));

  assert.deepEqual(await errorResult, {
    exitCode: null,
    processError: true,
    success: false,
    timedOut: false,
  });
  errorProcess.close(null, null);
});

test('successful media exit is not timed out while stdio close is delayed', async () => {
  const mediaProcess = new FakeMediaProcess();
  const extraction = spawn_ffmpeg_and_run([], 20, 'delayed close regression test', () => mediaProcess);

  setTimeout(() => mediaProcess.exit(0, null), 5);
  assert.equal(await extraction, true);

  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(mediaProcess.killSignals, []);
  mediaProcess.close(0, null);
});

test('recovers a thumbnail and fixed-width filmstrip from truncated media', async () => {
  const directory = createTemporaryDirectory();
  const completePath = path.join(directory, 'complete source.mp4');
  const damagedPath = path.join(directory, 'truncated source.mp4');
  const normalFilmstripPath = path.join(directory, 'normal filmstrip must fail.jpg');
  const thumbnailPath = path.join(directory, 'recovered thumbnail.jpg');
  const filmstripPath = path.join(directory, 'recovered filmstrip.jpg');

  const generation = runTool(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=24:duration=12',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-g', '48',
    '-movflags', '+faststart',
    '-y',
    completePath,
  ], 60_000);
  assert.equal(generation.status, 0, generation.stderr);

  const normalThumbnailPath = path.join(directory, 'normal thumbnail.jpg');
  let unnecessarySystemRequests = 0;
  assert.equal(await extractThumbnailWithRecovery(
    completePath,
    90,
    12,
    normalThumbnailPath,
    5000,
    {
      createSystemThumbnail: async () => {
        unnecessarySystemRequests++;
        throw new Error('The normal FFmpeg path should have succeeded.');
      },
    },
  ), true);
  assert.equal(unnecessarySystemRequests, 0);

  fs.copyFileSync(completePath, damagedPath);
  fs.truncateSync(damagedPath, Math.floor(fs.statSync(damagedPath).size * 0.6));

  assert.equal(await extractThumbnailWithRecovery(
    damagedPath,
    90,
    120,
    thumbnailPath,
    1000,
  ), true, 'an alternate early seek should recover a thumbnail');

  const normalFilmstrip = runTool(
    ffmpegPath,
    ['-nostdin', '-hide_banner', ...generateScreenshotStripArgs(
      damagedPath,
      30,
      90,
      5,
      normalFilmstripPath,
    )],
  );
  assert.notEqual(normalFilmstrip.status, 0, 'the all-or-nothing filmstrip path must fail for this fixture');
  assert.equal(
    fs.existsSync(normalFilmstripPath)
      ? readJpegDimensions(fs.readFileSync(normalFilmstripPath))?.width
      : undefined,
    undefined,
  );

  assert.equal(await extractFilmstripWithRecovery(
    damagedPath,
    30,
    90,
    5,
    thumbnailPath,
    filmstripPath,
    2000,
  ), true, 'available frames should be assembled and missing cells filled');

  assert.deepEqual(readJpegDimensions(fs.readFileSync(thumbnailPath)), { width: 160, height: 90 });
  assert.deepEqual(readJpegDimensions(fs.readFileSync(filmstripPath)), { width: 800, height: 90 });
});

test('recovery rejects invalid media without publishing a partial thumbnail', async () => {
  const directory = createTemporaryDirectory();
  const invalidMediaPath = path.join(directory, 'invalid source.mp4');
  const thumbnailPath = path.join(directory, 'must not be published.jpg');
  fs.writeFileSync(invalidMediaPath, 'not media');
  let emptySystemRequests = 0;

  assert.equal(await extractThumbnailWithRecovery(
    invalidMediaPath,
    90,
    30,
    thumbnailPath,
    250,
    {
      createSystemThumbnail: async () => {
        emptySystemRequests++;
        return Buffer.alloc(0);
      },
    },
  ), false);
  assert.equal(emptySystemRequests, 1);
  assert.equal(fs.existsSync(thumbnailPath), false);
  assert.equal(
    fs.readdirSync(directory).some((fileName: string) => fileName.includes('.tmp.jpg')),
    false,
  );
});

test('uses an injected operating-system thumbnail when FFmpeg cannot decode the video', async () => {
  const directory = createTemporaryDirectory();
  const invalidMediaPath = path.join(directory, 'system-playable source.mov');
  const systemJpegPath = path.join(directory, 'system thumbnail source.jpg');
  const thumbnailPath = path.join(directory, 'system recovered thumbnail.jpg');
  fs.writeFileSync(invalidMediaPath, 'not decodable by ffmpeg');

  const systemImage = runTool(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=orange:size=300x200',
    '-frames:v', '1', '-q:v', '2', '-y', systemJpegPath,
  ]);
  assert.equal(systemImage.status, 0, systemImage.stderr);

  let systemRequests = 0;
  assert.equal(await extractThumbnailWithRecovery(
    invalidMediaPath,
    90,
    30,
    thumbnailPath,
    250,
    {
      createSystemThumbnail: async (videoPath: string, width: number, height: number) => {
        systemRequests++;
        assert.equal(videoPath, invalidMediaPath);
        assert.equal(width, 160);
        assert.equal(height, 90);
        return fs.readFileSync(systemJpegPath);
      },
    },
  ), true);
  assert.equal(systemRequests, 1);
  assert.deepEqual(readJpegDimensions(fs.readFileSync(thumbnailPath)), { width: 160, height: 90 });
});

test('a custom thumbnail wins when it starts during operating-system recovery', async () => {
  const directory = createTemporaryDirectory();
  const invalidMediaPath = path.join(directory, 'system fallback source.mov');
  const incomingImagePath = path.join(directory, 'custom request.png');
  const systemJpegPath = path.join(directory, 'system image.jpg');
  const customJpegPath = path.join(directory, 'custom image.jpg');
  const thumbnailPath = path.join(directory, 'recovered thumbnail.jpg');
  fs.writeFileSync(invalidMediaPath, 'not decodable by ffmpeg');
  fs.copyFileSync(path.join(__dirname, '../src/assets/logo.png'), incomingImagePath);

  const systemImage = runTool(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=orange:size=300x200',
    '-frames:v', '1', '-q:v', '2', '-y', systemJpegPath,
  ]);
  assert.equal(systemImage.status, 0, systemImage.stderr);
  const customImage = runTool(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=blue:size=320x180',
    '-frames:v', '1', '-q:v', '2', '-y', customJpegPath,
  ]);
  assert.equal(customImage.status, 0, customImage.stderr);

  let releaseSystemRequest: () => void = () => undefined;
  let reportSystemRequestStarted: () => void = () => undefined;
  const systemRequestGate = new Promise<void>((resolve) => {
    releaseSystemRequest = resolve;
  });
  const systemRequestStarted = new Promise<void>((resolve) => {
    reportSystemRequestStarted = resolve;
  });
  const backgroundResult = extractThumbnailWithRecovery(
    invalidMediaPath,
    90,
    30,
    thumbnailPath,
    250,
    {
      createSystemThumbnail: async () => {
        reportSystemRequestStarted();
        await systemRequestGate;
        return fs.readFileSync(systemJpegPath);
      },
    },
  );

  await systemRequestStarted;
  assert.equal(await replaceThumbnailWithNewImage(
    thumbnailPath,
    incomingImagePath,
    90,
    () => fs.readFileSync(customJpegPath),
  ), true);
  const publishedCustomImage = fs.readFileSync(thumbnailPath);

  releaseSystemRequest();
  assert.equal(
    await backgroundResult,
    true,
    'the recovery pipeline should continue with the custom image',
  );
  assert.deepEqual(fs.readFileSync(thumbnailPath), publishedCustomImage);
  assert.deepEqual(readJpegDimensions(publishedCustomImage), { width: 160, height: 90 });
});

test('converts a dropped PNG into the custom JPEG thumbnail dimensions', async () => {
  const directory = createTemporaryDirectory();
  const incomingImagePath = path.join(directory, 'Custom Preview.PNG');
  const decoderOutputPath = path.join(directory, 'electron decoder output.jpg');
  const thumbnailPath = path.join(directory, 'custom thumbnail.jpg');

  fs.copyFileSync(path.join(__dirname, '../src/assets/logo.png'), incomingImagePath);

  const decoderOutput = runTool(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=blue:size=320x180',
    '-frames:v', '1',
    '-q:v', '2',
    '-y',
    decoderOutputPath,
  ], 60_000);
  assert.equal(decoderOutput.status, 0, decoderOutput.stderr);

  assert.equal(await replaceThumbnailWithNewImage(
    thumbnailPath,
    incomingImagePath,
    90,
    (imagePath: string) => {
      assert.equal(imagePath, incomingImagePath);
      return fs.readFileSync(decoderOutputPath);
    },
  ), true);
  assert.ok(fs.statSync(thumbnailPath).size > 0);

  const probe = runTool(ffprobePath, ['-v', 'error', '-of', 'json', '-show_streams', thumbnailPath]);
  const metadata = JSON.parse(probe.stdout);
  assert.equal(metadata.streams[0].width, 160);
  assert.equal(metadata.streams[0].height, 90);
});

test('a later custom-thumbnail request cannot be overwritten by an older one', async () => {
  const directory = createTemporaryDirectory();
  const firstPngPath = path.join(directory, 'first request.png');
  const secondPngPath = path.join(directory, 'second request.png');
  const decoderOutputPath = path.join(directory, 'decoded input.jpg');
  const thumbnailPath = path.join(directory, 'custom thumbnail.jpg');
  fs.copyFileSync(path.join(__dirname, '../src/assets/logo.png'), firstPngPath);
  fs.copyFileSync(path.join(__dirname, '../src/assets/logo.png'), secondPngPath);

  const decoderOutput = runTool(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:size=320x180',
    '-frames:v', '1', '-q:v', '2', '-y', decoderOutputPath,
  ]);
  assert.equal(decoderOutput.status, 0, decoderOutput.stderr);
  const jpegData = fs.readFileSync(decoderOutputPath);

  let releaseFirstDecoder: () => void = () => undefined;
  let reportFirstDecoderStarted: () => void = () => undefined;
  const firstDecoderGate = new Promise<void>((resolve) => {
    releaseFirstDecoder = resolve;
  });
  const firstDecoderStarted = new Promise<void>((resolve) => {
    reportFirstDecoderStarted = resolve;
  });
  const firstReplacement = replaceThumbnailWithNewImage(
    thumbnailPath,
    firstPngPath,
    90,
    async () => {
      reportFirstDecoderStarted();
      await firstDecoderGate;
      return jpegData;
    },
  );

  await firstDecoderStarted;
  const secondReplacement = replaceThumbnailWithNewImage(
    thumbnailPath,
    secondPngPath,
    90,
    () => jpegData,
  );
  assert.equal(await secondReplacement, true);

  releaseFirstDecoder();
  assert.equal(await firstReplacement, false);
  assert.deepEqual(readJpegDimensions(fs.readFileSync(thumbnailPath)), { width: 160, height: 90 });
});

test('background extraction cannot publish over a custom thumbnail already in progress', async () => {
  const directory = createTemporaryDirectory();
  const pngPath = path.join(directory, 'custom request.png');
  const decoderOutputPath = path.join(directory, 'decoded input.jpg');
  const thumbnailPath = path.join(directory, 'custom thumbnail.jpg');
  fs.copyFileSync(path.join(__dirname, '../src/assets/logo.png'), pngPath);

  const decoderOutput = runTool(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=purple:size=320x180',
    '-frames:v', '1', '-q:v', '2', '-y', decoderOutputPath,
  ]);
  assert.equal(decoderOutput.status, 0, decoderOutput.stderr);
  const jpegData = fs.readFileSync(decoderOutputPath);

  let releaseDecoder: () => void = () => undefined;
  let reportDecoderStarted: () => void = () => undefined;
  const decoderGate = new Promise<void>((resolve) => {
    releaseDecoder = resolve;
  });
  const decoderStarted = new Promise<void>((resolve) => {
    reportDecoderStarted = resolve;
  });
  const customReplacement = replaceThumbnailWithNewImage(
    thumbnailPath,
    pngPath,
    90,
    async () => {
      reportDecoderStarted();
      await decoderGate;
      return jpegData;
    },
  );

  await decoderStarted;
  const backgroundResult = extractThumbnailWithRecovery(
    path.join(directory, 'background source.mp4'),
    90,
    30,
    thumbnailPath,
    250,
  );

  releaseDecoder();
  assert.equal(await customReplacement, true);
  assert.equal(await backgroundResult, true, 'the background pipeline should continue with the custom image');
  assert.equal(await extractThumbnailWithRecovery(
    path.join(directory, 'stale queued source.mp4'),
    90,
    30,
    thumbnailPath,
    250,
    { generationVersion: null },
  ), true, 'a stale queue item should reuse the published custom image without overwriting it');
  assert.deepEqual(readJpegDimensions(fs.readFileSync(thumbnailPath)), { width: 160, height: 90 });
});

test('generates, probes, and extracts a thumbnail from media with a difficult filename', () => {
  const directory = createTemporaryDirectory();
  const mediaPath = path.join(directory, 'sample with spaces; $value.mp4');
  const thumbnailPath = path.join(directory, 'thumbnail with spaces; $value.jpg');

  const generation = runTool(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=size=160x90:rate=5:duration=6',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:duration=6',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-y',
    mediaPath,
  ]);
  assert.equal(generation.status, 0, generation.stderr);
  assert.ok(fs.statSync(mediaPath).size > 0);

  const probe = runTool(ffprobePath, buildFfprobeArguments(mediaPath));
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  assert.equal(metadata.streams[0].width, 160);
  assert.equal(metadata.streams[0].height, 90);
  const fullProbe = runTool(ffprobePath, [
    '-v', 'error',
    '-of', 'json',
    '-show_streams',
    mediaPath,
  ]);
  const fullMetadata = JSON.parse(fullProbe.stdout);
  assert.ok(fullMetadata.streams.some((stream: { codec_type?: string }) => stream.codec_type === 'audio'));

  const extraction = runTool(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', '0',
    '-i', mediaPath,
    '-frames:v', '1',
    '-q:v', '2',
    '-y',
    thumbnailPath,
  ]);
  assert.equal(extraction.status, 0, extraction.stderr);
  assert.ok(fs.statSync(thumbnailPath).size > 0);
});

test('runs the app thumbnail, filmstrip, preview clip, and clip-thumbnail argument sets', () => {
  const directory = createTemporaryDirectory();
  const mediaPath = path.join(directory, 'workflow input with spaces; value.mp4');
  const thumbnailPath = path.join(directory, 'workflow thumbnail.jpg');
  const filmstripPath = path.join(directory, 'workflow filmstrip.jpg');
  const clipPath = path.join(directory, 'workflow clip.mp4');
  const clipThumbnailPath = path.join(directory, 'workflow clip thumbnail.jpg');

  const generation = runTool(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=size=320x180:rate=10:duration=8',
    '-f', 'lavfi',
    '-i', 'sine=frequency=1000:duration=8',
    '-shortest',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-y',
    mediaPath,
  ], 60_000);
  assert.equal(generation.status, 0, generation.stderr);

  const workflows: { args: string[]; output: string }[] = [
    { args: extractSingleFrameArgs(mediaPath, 90, 8, thumbnailPath), output: thumbnailPath },
    { args: generateScreenshotStripArgs(mediaPath, 8, 90, 3, filmstripPath), output: filmstripPath },
    { args: generatePreviewClipArgs(mediaPath, 8, 90, 2, 1, clipPath), output: clipPath },
  ];

  for (const workflow of workflows) {
    const result = runTool(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...workflow.args], 60_000);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.statSync(workflow.output).size > 0);
  }

  const clipThumbnail = runTool(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    ...extractFirstFrameArgs(clipPath, clipThumbnailPath),
  ], 60_000);
  assert.equal(clipThumbnail.status, 0, clipThumbnail.stderr);
  assert.ok(fs.statSync(clipThumbnailPath).size > 0);

  const clipProbe = runTool(ffprobePath, ['-v', 'error', '-of', 'json', '-show_streams', clipPath]);
  const clipMetadata = JSON.parse(clipProbe.stdout);
  assert.ok(clipMetadata.streams.some((stream: { codec_type?: string }) => stream.codec_type === 'video'));
  assert.ok(clipMetadata.streams.some((stream: { codec_type?: string }) => stream.codec_type === 'audio'));
});

test('reports explicit success and failure from the full extraction workflow', async () => {
  const directory = createTemporaryDirectory();
  const mediaPath = path.join(directory, 'callback source.mp4');
  const screenshotFolder = path.join(directory, 'previews');
  fs.mkdirSync(path.join(screenshotFolder, 'thumbnails'), { recursive: true });
  fs.mkdirSync(path.join(screenshotFolder, 'filmstrips'), { recursive: true });
  fs.mkdirSync(path.join(screenshotFolder, 'clips'), { recursive: true });

  const generation = runTool(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc=size=160x90:rate=5:duration=6',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-y',
    mediaPath,
  ], 60_000);
  assert.equal(generation.status, 0, generation.stderr);

  const extract = (fileName: string, hash: string): Promise<boolean> => {
    return new Promise((resolve) => {
      extractAll(
        {
          ...NewImageElement(),
          cleanName: fileName,
          duration: 6,
          fileName,
          fileSize: 1,
          fps: 5,
          hash,
          height: 90,
          inputSource: 0,
          partialPath: '',
          screens: 3,
          width: 160,
        },
        directory,
        screenshotFolder,
        {
          clipHeight: 144,
          clipSnippetLength: 1,
          clipSnippets: 0,
          fixed: true,
          height: 144,
          n: 3,
        },
        (success: boolean) => resolve(success),
      );
    });
  };

  assert.equal(await extract(path.basename(mediaPath), 'successful-callback'), true);
  assert.ok(fs.statSync(path.join(screenshotFolder, 'thumbnails', 'successful-callback.jpg')).size > 0);
  assert.ok(fs.statSync(path.join(screenshotFolder, 'filmstrips', 'successful-callback.jpg')).size > 0);
  assert.equal(await extract('missing.mp4', 'failed-callback'), false);
});
