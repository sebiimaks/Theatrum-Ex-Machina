import * as assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { getMediaToolPath } from './media-tool-paths.ts';
import { PRIVATE_MEDIA_PROCESS_CHUNK_BYTES, isPrivateMediaProcessCleanupFailure, streamPrivateMediaProcess,
  type PrivateMediaProcessOptions } from './private-media-process.ts';
import { buildPrivatePreviewPlan, privateProbeCommand } from './private-preview-plan.ts';

const chunkSize = PRIVATE_MEDIA_PROCESS_CHUNK_BYTES;
const sourceArgs = ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'fd,pipe', '-fd', '3', '-i', 'fd:',
  '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'];
const inputArgs = ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'fd,pipe', '-f', 'image2pipe', '-i', 'pipe:0',
  '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'];
const failure = { name: 'Error', message: 'Private media generation failed.' };

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough({ highWaterMark: chunkSize });
  readonly stdin: Writable;
  readonly writes: Buffer[] = [];
  readonly written: Buffer[] = [];
  readonly kills: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  ignoreTerm = false;
  ignoreAllKills = false;
  holdWrites = false;
  constructor() {
    super();
    this.stdin = new Writable({ write: (bytes: Buffer, _encoding, callback) => {
      this.writes.push(bytes);
      this.written.push(Buffer.from(bytes));
      if (!this.holdWrites) { callback(); }
    } });
  }
  finish(code = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    if (!this.ignoreAllKills && !(signal === 'SIGTERM' && this.ignoreTerm)) {
      queueMicrotask(() => { this.finish(1, signal); });
    }
    return true;
  }
}

function options(overrides: Partial<PrivateMediaProcessOptions> = {}): PrivateMediaProcessOptions {
  return { tool: 'ffmpeg', args: sourceArgs, sourceFd: 41, signal: new AbortController().signal,
    isCurrent: () => true, maximumBytes: 4 * chunkSize, timeoutMs: 5_000, ...overrides };
}

function mockSpawn(t: TestContext, action: (child: FakeChild) => void = () => undefined): {
  child: FakeChild; calls: { executable: string; args: readonly string[]; options: childProcess.SpawnOptions }[];
} {
  const child = new FakeChild();
  const calls: { executable: string; args: readonly string[]; options: childProcess.SpawnOptions }[] = [];
  t.mock.method(childProcess, 'spawn', (executable: string, args: readonly string[], spawnOptions: childProcess.SpawnOptions) => {
    calls.push({ executable, args, options: spawnOptions });
    queueMicrotask(() => action(child));
    return child as unknown as childProcess.ChildProcess;
  });
  return { child, calls };
}

async function collect(iterable: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try { for await (const bytes of iterable) { chunks.push(bytes); } return Buffer.concat(chunks); }
  finally { for (const bytes of chunks) { bytes.fill(0); } }
}

function tick(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

test('spawning is lazy, uses only fixed tools and FD3, and strips inherited reporting and loader variables', async t => {
  const mocked = mockSpawn(t, child => { child.stdout.write(Buffer.from('output')); child.finish(); });
  const previous = process.env.FFREPORT;
  process.env.FFREPORT = 'file=private-report.log';
  t.after(() => { if (previous === undefined) { delete process.env.FFREPORT; } else { process.env.FFREPORT = previous; } });
  const args = [...sourceArgs];
  const iterator = streamPrivateMediaProcess(options({ args }));
  args.splice(0, args.length, '-report');
  assert.equal(mocked.calls.length, 0);
  assert.equal((await collect(iterator)).toString(), 'output');
  const call = mocked.calls[0];
  assert.equal(call.executable, getMediaToolPath('ffmpeg'));
  assert.deepEqual(call.args, sourceArgs);
  assert.equal(call.options.cwd, path.dirname(call.executable));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, false);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'ignore', 41]);
  assert.deepEqual(call.options.env, { LANG: 'C', LC_ALL: 'C', AV_LOG_FORCE_NOCOLOR: '1' });
});

test('stdout chunks are bounded and unread output stays under stream backpressure', async t => {
  const bytes = Buffer.alloc(chunkSize * 2 + 7, 0x71);
  const mocked = mockSpawn(t, child => { assert.equal(child.stdout.write(bytes), false); child.finish(); });
  const iterator = streamPrivateMediaProcess(options());
  const first = await iterator.next();
  assert.equal(first.value.length, chunkSize);
  const buffered = mocked.child.stdout.readableLength;
  await tick();
  assert.equal(mocked.child.stdout.readableLength, buffered, 'the runner does not prefetch between pulls');
  const second = await iterator.next();
  const third = await iterator.next();
  assert.equal(second.value.length, chunkSize);
  assert.equal(third.value.length, 7);
  assert.equal((await iterator.next()).done, true);
  assert.deepEqual(Buffer.concat([first.value, second.value, third.value]), bytes);
});

test('successful completion waits for close and stdout EOF, rather than merely exit', async t => {
  const mocked = mockSpawn(t, child => {
    child.stdout.write(Buffer.from('complete'));
    child.stdout.end();
    child.exitCode = 0;
    child.emit('exit', 0, null);
  });
  const iterator = streamPrivateMediaProcess(options());
  assert.equal((await iterator.next()).value.toString(), 'complete');
  let finished = false;
  const completion = iterator.next().then(result => { finished = true; return result; });
  await tick();
  assert.equal(finished, false);
  mocked.child.emit('close', 0, null);
  assert.equal((await completion).done, true);
});

test('a nonzero close after provisional output throws instead of completing a publishable stream', async t => {
  const mocked = mockSpawn(t, child => { child.stdout.write(Buffer.from('provisional')); });
  const iterator = streamPrivateMediaProcess(options());
  const delivered = (await iterator.next()).value;
  mocked.child.finish(1);
  await assert.rejects(iterator.next(), failure);
  assert.equal(delivered.toString(), 'provisional', 'consumer-owned bytes are not overwritten');
});

test('output ceiling failure erases the oversized owned chunk and queued bytes', async t => {
  const bytes = Buffer.alloc(chunkSize * 2, 0x7a);
  const mocked = mockSpawn(t, child => { child.stdout.write(bytes); });
  const iterator = streamPrivateMediaProcess(options({ maximumBytes: 10 }));
  await assert.rejects(iterator.next(), failure);
  assert.ok(bytes.every(byte => byte === 0));
  assert.deepEqual(mocked.child.kills, ['SIGTERM']);
});

test('abort between pulls kills promptly and wipes unread bytes without changing delivered ownership', async t => {
  const controller = new AbortController();
  const queued = Buffer.from('queued-secret');
  const mocked = mockSpawn(t, child => { child.stdout.write(Buffer.from('delivered')); });
  const iterator = streamPrivateMediaProcess(options({ signal: controller.signal }));
  const delivered = (await iterator.next()).value;
  mocked.child.stdout.write(queued);
  controller.abort('/sensitive/source/path');
  assert.ok(queued.every(byte => byte === 0));
  await assert.rejects(iterator.next(), failure);
  assert.equal(delivered.toString(), 'delivered');
  assert.deepEqual(mocked.child.kills, ['SIGTERM']);
});

test('revoked authority stops an idle child between consumer pulls', async t => {
  let current = true;
  const mocked = mockSpawn(t, child => { child.stdout.write(Buffer.from('delivered')); });
  const iterator = streamPrivateMediaProcess(options({ isCurrent: () => current }));
  await iterator.next();
  current = false;
  await new Promise<void>(resolve => mocked.child.once('close', () => resolve()));
  assert.deepEqual(mocked.child.kills, ['SIGTERM']);
  await assert.rejects(iterator.next(), failure);
});

test('consumer return cancels a pending read and reaps its child', async t => {
  const mocked = mockSpawn(t);
  const iterator = streamPrivateMediaProcess(options());
  const pending = iterator.next();
  assert.equal((await iterator.return!()).done, true);
  assert.equal((await pending).done, true);
  assert.deepEqual(mocked.child.kills, ['SIGTERM']);
});

test('timeouts escalate ignored SIGTERM to SIGKILL before rejecting', async t => {
  const mocked = mockSpawn(t);
  mocked.child.ignoreTerm = true;
  await assert.rejects(streamPrivateMediaProcess(options({ timeoutMs: 10 })).next(), failure);
  assert.deepEqual(mocked.child.kills, ['SIGTERM', 'SIGKILL']);
});

test('an unreaped child rejects with a trusted sticky cleanup failure after bounded force-kill attempts', async t => {
  const mocked = mockSpawn(t);
  mocked.child.ignoreAllKills = true;
  const iterator = streamPrivateMediaProcess(options({ timeoutMs: 10 }));
  const started = Date.now();
  let cleanup: Error | undefined;
  await assert.rejects(iterator.next(), error => {
    assert.ok(isPrivateMediaProcessCleanupFailure(error));
    assert.equal(error.message, failure.message);
    cleanup = error;
    return true;
  });
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(mocked.child.kills, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
  await assert.rejects(iterator.return!(), error => error === cleanup);
  await assert.rejects(iterator.next(), error => error === cleanup);
  mocked.child.finish(1, 'SIGKILL');
  await assert.rejects(iterator.return!(), error => error === cleanup, 'late closure cannot silently clear caller quarantine');
  assert.equal(isPrivateMediaProcessCleanupFailure(new Error(failure.message)), false);
  assert.equal(isPrivateMediaProcessCleanupFailure({ ...cleanup }), false);
  assert.equal(isPrivateMediaProcessCleanupFailure(null), false);
});

test('consumer return and its pending read both reject when exit does not establish child closure', async t => {
  const mocked = mockSpawn(t);
  mocked.child.ignoreAllKills = true;
  const iterator = streamPrivateMediaProcess(options());
  const pending = iterator.next();
  mocked.child.exitCode = 0;
  mocked.child.emit('exit', 0, null);
  const cancelled = iterator.return!();
  const results = await Promise.allSettled([pending, cancelled]);
  assert.ok(results.every(result => result.status === 'rejected' && isPrivateMediaProcessCleanupFailure(result.reason)));
  assert.equal((results[0] as PromiseRejectedResult).reason, (results[1] as PromiseRejectedResult).reason);
  mocked.child.finish(1, 'SIGKILL');
});

test('spawn and stream errors are sanitized without exposing source diagnostics', async t => {
  const mocked = mockSpawn(t, child => { child.emit('error', new Error('Failed /sensitive/source/path')); });
  await assert.rejects(streamPrivateMediaProcess(options()).next(), failure);
  assert.deepEqual(mocked.child.kills, ['SIGTERM']);
});

test('stdin writes are bounded owned copies and are erased after the write callback', async t => {
  const input = Buffer.alloc(chunkSize * 2 + 9, 0x51);
  const mocked = mockSpawn(t, child => {
    child.stdin.once('finish', () => { child.stdout.write(Buffer.from('assembled')); child.finish(); });
  });
  const source = async function* (): AsyncGenerator<Uint8Array> { yield input; };
  const result = await collect(streamPrivateMediaProcess(options({ sourceFd: undefined, input: source(), args: inputArgs })));
  assert.equal(result.toString(), 'assembled');
  assert.deepEqual(mocked.child.written.map(bytes => bytes.length), [chunkSize, chunkSize, 9]);
  assert.deepEqual(Buffer.concat(mocked.child.written), input);
  assert.ok(mocked.child.writes.every(bytes => bytes.every(byte => byte === 0)));
  assert.ok(input.every(byte => byte === 0x51), 'the producer retains ownership of its input');
  assert.deepEqual(mocked.calls[0].options.stdio, ['pipe', 'pipe', 'ignore', 'ignore']);
});

test('abort during a pending stdin write erases the copy and returns the producer', async t => {
  const controller = new AbortController();
  const mocked = mockSpawn(t);
  mocked.child.holdWrites = true;
  let returned = false;
  const input = Buffer.alloc(100, 0x55);
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() { return this; },
    next: async () => ({ done: false, value: input }),
    return: async () => { returned = true; return { done: true, value: undefined }; },
  };
  const iterator = streamPrivateMediaProcess(options({ sourceFd: undefined, input: source, args: inputArgs, signal: controller.signal }));
  const pending = iterator.next();
  await tick();
  assert.equal(mocked.child.writes.length, 1);
  controller.abort();
  await assert.rejects(pending, failure);
  assert.ok(mocked.child.writes[0].every(byte => byte === 0));
  assert.ok(input.every(byte => byte === 0x55));
  assert.equal(returned, true);
});

test('a stalled or rejecting input producer cannot prevent cancellation and child reaping', async t => {
  const controller = new AbortController();
  const mocked = mockSpawn(t);
  let returned = false;
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => undefined),
    return: async () => { returned = true; throw new Error('/sensitive/producer/path'); },
  };
  const iterator = streamPrivateMediaProcess(options({ sourceFd: undefined, input: source, args: inputArgs, signal: controller.signal }));
  const pending = iterator.next();
  await tick();
  controller.abort();
  await assert.rejects(pending, failure);
  assert.equal(returned, true);
  assert.deepEqual(mocked.child.kills, ['SIGTERM']);
});

test('zero exit before a producer finishes is rejected as incomplete input', async t => {
  mockSpawn(t, child => child.finish());
  const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) };
  await assert.rejects(streamPrivateMediaProcess(options({ sourceFd: undefined, input: source, args: inputArgs })).next(), failure);
});

test('unsafe commands, invalid bounds and missing authority never spawn', async t => {
  const mocked = mockSpawn(t);
  const unsafe: Partial<PrivateMediaProcessOptions>[] = [
    { args: [...sourceArgs, '-report'] }, { args: [...sourceArgs.slice(0, -1), '/private/output.jpg'] },
    { args: ['-progress', '/private/report', ...sourceArgs] }, { args: ['-vf', 'movie=/private/image.jpg', ...sourceArgs] },
    { args: sourceArgs.map(arg => arg === 'fd:' ? 'https://example.test/private' : arg) },
    { args: sourceArgs.map(arg => arg === 'fd,pipe' ? 'file,http,fd,pipe' : arg) },
    { args: ['-attach', '/private/notes', ...sourceArgs] }, { sourceFd: undefined }, { sourceFd: 1 },
    { maximumBytes: 0 }, { maximumBytes: Number.MAX_SAFE_INTEGER }, { timeoutMs: 0 },
    { isCurrent: () => false }, { isCurrent: () => { throw new Error('/private/authority'); } },
  ];
  for (const overrides of unsafe) { await assert.rejects(streamPrivateMediaProcess(options(overrides)).next(), failure); }
  assert.equal(mocked.calls.length, 0);
});

test('concurrent next calls are rejected without corrupting the first pending read', async t => {
  const mocked = mockSpawn(t);
  const iterator = streamPrivateMediaProcess(options());
  const first = iterator.next();
  await assert.rejects(iterator.next(), failure);
  mocked.child.stdout.write(Buffer.from('valid'));
  mocked.child.finish();
  assert.equal((await first).value.toString(), 'valid');
  assert.equal((await iterator.next()).done, true);
});

test('abort in the staged-output handoff wipes bytes before next resolves', async t => {
  const controller = new AbortController();
  const bytes = Buffer.from('staged-secret');
  const mocked = mockSpawn(t, child => { child.stdout.write(bytes); });
  const originalRead = mocked.child.stdout.read.bind(mocked.child.stdout);
  t.mock.method(mocked.child.stdout, 'read', (size?: number) => {
    const result = originalRead(size);
    if (Buffer.isBuffer(result)) { queueMicrotask(() => controller.abort()); }
    return result;
  });
  await assert.rejects(streamPrivateMediaProcess(options({ signal: controller.signal })).next(), failure);
  assert.ok(bytes.every(byte => byte === 0));
});

test('abort in the completion handoff cannot turn a stale process into a successfully finished producer', async t => {
  const controller = new AbortController();
  const mocked = mockSpawn(t, child => { child.stdout.write(Buffer.from('provisional')); child.finish(); });
  let finishing = false;
  const iterator = streamPrivateMediaProcess(options({ signal: controller.signal, isCurrent: () => {
    if (finishing) { queueMicrotask(() => controller.abort()); }
    return true;
  } }));
  const delivered = (await iterator.next()).value;
  await tick();
  assert.equal(mocked.child.stdout.readableEnded, true);
  finishing = true;
  await assert.rejects(iterator.next(), failure);
  assert.equal(delivered.toString(), 'provisional');
});

test('empty successful output is rejected and a synchronous spawn exception remains generic', async t => {
  mockSpawn(t, child => child.finish());
  await assert.rejects(streamPrivateMediaProcess(options()).next(), failure);
  t.mock.restoreAll();
  t.mock.method(childProcess, 'spawn', () => { throw new Error('/sensitive/executable/path'); });
  await assert.rejects(streamPrivateMediaProcess(options()).next(), failure);
});

test('every built-in preview plan passes the runner option allowlist', async t => {
  const plan = buildPrivatePreviewPlan({ duration: 30, width: 1920, height: 1080, hasAudio: true },
    { fixed: true, n: 3, height: 144, clipHeight: 144, clipSnippets: 2, clipSnippetLength: 1 });
  const plans = [privateProbeCommand(), plan.thumbnail, ...plan.frames, ...plan.clip!.snippets, plan.clip!.poster];
  for (const command of plans) {
    t.mock.restoreAll();
    mockSpawn(t, child => { child.stdout.write(Buffer.from('ok')); child.finish(); });
    assert.equal((await collect(streamPrivateMediaProcess(options(command)))).toString(), 'ok');
  }
  for (const command of [plan.filmstrip, plan.clip!.remux]) {
    t.mock.restoreAll();
    mockSpawn(t, child => { child.stdin.once('finish', () => { child.stdout.write(Buffer.from('ok')); child.finish(); }); });
    const input = async function* (): AsyncGenerator<Uint8Array> { yield Buffer.from('memory only'); };
    assert.equal((await collect(streamPrivateMediaProcess(options({ ...command, sourceFd: undefined, input: input() })))).toString(), 'ok');
  }
});

test('bundled FFprobe reads an inherited descriptor and returns bounded metadata without a source path', async t => {
  const root = await fs.promises.mkdtemp(path.join(path.resolve(__dirname, '..', 'tmp'), 'private-media-process-'));
  const file = path.join(root, 'synthetic.wav');
  const sampleBytes = 960;
  const wav = Buffer.alloc(44 + sampleBytes);
  wav.write('RIFF'); wav.writeUInt32LE(36 + sampleBytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(sampleBytes, 40);
  await fs.promises.writeFile(file, wav);
  const handle = await fs.promises.open(file, 'r');
  t.after(async () => { await handle.close(); await fs.promises.rm(root, { recursive: true, force: true }); });
  const bytes = await collect(streamPrivateMediaProcess(options({ ...privateProbeCommand(), sourceFd: handle.fd })));
  const parsed = JSON.parse(bytes.toString());
  assert.equal(parsed.streams[0].codec_type, 'audio');
  assert.equal(parsed.format.duration, '0.010000');
  assert.equal(bytes.includes(Buffer.from(file)), false);
  assert.equal(bytes.includes(Buffer.from('filename')), false);
  assert.ok((await handle.stat()).isFile(), 'the caller retains ownership of its source descriptor');
});
