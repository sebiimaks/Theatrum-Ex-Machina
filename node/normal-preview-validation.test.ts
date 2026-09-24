import * as assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import * as ts from 'typescript';
import { NormalOperationScope } from './normal-operation-scope';
import { NormalPreviewValidation } from './normal-preview-validation';
import { resolveCanonicalPreviewFile, type PreviewValidationInput } from './normal-preview-validation-worker';

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const example: PreviewValidationInput = {
  outputDirectory: '/synthetic/hub', assetDirectory: '/synthetic/hub/previews', filePath: '/synthetic/hub/previews/one.jpg',
};

class FakeWorker extends EventEmitter {
  messages: (PreviewValidationInput & { id: number })[] = [];
  terminations = 0;
  postMessage(message: PreviewValidationInput & { id: number }): void { this.messages.push(message); }
  terminate(): Promise<number> { this.terminations++; return Promise.resolve(0); }
  reply(index = this.messages.length - 1, result: string | null = example.filePath): void {
    this.emit('message', { id: this.messages[index].id, path: result });
  }
  exit(): void { this.emit('exit', 0); }
}

function harness(idleTimeoutMs = 1000) {
  const scope = new NormalOperationScope();
  const workers: FakeWorker[] = [];
  const validator = new NormalPreviewValidation(scope, () => {
    const worker = new FakeWorker(); workers.push(worker);
    return worker as unknown as Worker;
  }, idleTimeoutMs);
  const resolve = (signal?: AbortSignal) => validator.resolve(
    example.filePath, example.outputDirectory, example.assetDirectory, signal,
  );
  return { scope, workers, validator, resolve };
}

function fixture(t: TestContext) {
  const root = path.resolve(__dirname, '..');
  const tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'normal-preview-validation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputDirectory = path.join(directory, 'hub');
  const assetDirectory = path.join(outputDirectory, 'previews');
  fs.mkdirSync(assetDirectory, { recursive: true });
  const filePath = path.join(assetDirectory, 'one.jpg');
  fs.writeFileSync(filePath, 'synthetic preview');
  return { directory, input: { outputDirectory, assetDirectory, filePath } };
}

test('canonical checks allow only real files contained by both canonical directories', t => {
  const { directory, input } = fixture(t);
  assert.equal(resolveCanonicalPreviewFile(input), fs.realpathSync.native(input.filePath));
  assert.equal(resolveCanonicalPreviewFile({ ...input, filePath: input.assetDirectory }), undefined);
  assert.equal(resolveCanonicalPreviewFile({ ...input, assetDirectory: input.outputDirectory }), undefined);
  assert.equal(resolveCanonicalPreviewFile({ ...input, filePath: path.join(input.assetDirectory, 'missing') }), undefined);
  assert.equal(resolveCanonicalPreviewFile({ ...input, filePath: 'relative.jpg' }), undefined);
  const outside = path.join(directory, 'outside.jpg');
  fs.writeFileSync(outside, 'outside');
  const escapedFile = path.join(input.assetDirectory, 'escape.jpg');
  fs.symlinkSync(outside, escapedFile);
  assert.equal(resolveCanonicalPreviewFile({ ...input, filePath: escapedFile }), undefined);
  const escapedAssets = path.join(input.outputDirectory, 'escape');
  fs.symlinkSync(directory, escapedAssets, 'dir');
  assert.equal(resolveCanonicalPreviewFile({ ...input, assetDirectory: escapedAssets,
    filePath: path.join(escapedAssets, 'outside.jpg') }), undefined);
  const internalLink = path.join(input.assetDirectory, 'internal.jpg');
  fs.symlinkSync(input.filePath, internalLink);
  assert.equal(resolveCanonicalPreviewFile({ ...input, filePath: internalLink }), fs.realpathSync.native(input.filePath));
});

test('actual worker validates files, denies escaping symlinks, and exits before drain completes', async t => {
  const { directory, input } = fixture(t);
  const workerFile = path.join(directory, 'validator.cjs');
  fs.writeFileSync(workerFile, ts.transpileModule(
    fs.readFileSync(path.join(__dirname, 'normal-preview-validation-worker.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText);
  const scope = new NormalOperationScope();
  const validator = new NormalPreviewValidation(scope, () => new Worker(workerFile, { execArgv: [] }));
  t.after(async () => { await scope.seal(); });
  assert.equal(await validator.resolve(input.filePath, input.outputDirectory, input.assetDirectory),
    fs.realpathSync.native(input.filePath));
  const outside = path.join(directory, 'outside.jpg'); fs.writeFileSync(outside, 'outside');
  const link = path.join(input.assetDirectory, 'escape.jpg'); fs.symlinkSync(outside, link);
  assert.equal(await validator.resolve(link, input.outputDirectory, input.assetDirectory), undefined);
  fs.unlinkSync(input.filePath); fs.symlinkSync(outside, input.filePath);
  assert.equal(await validator.resolve(input.filePath, input.outputDirectory, input.assetDirectory), undefined);
  scope.assertDrained(await scope.seal());
});

test('one worker starts lazily, processes requests serially, and retains its idle lease', async () => {
  const h = harness(); assert.equal(h.workers.length, 0);
  const first = h.resolve(); const second = h.resolve();
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].messages.length, 1);
  assert.equal(h.scope.pendingCount, 3);
  h.workers[0].reply(); assert.equal(await first, example.filePath);
  assert.equal(h.workers[0].messages.length, 2);
  h.workers[0].reply(); assert.equal(await second, example.filePath);
  assert.equal(h.scope.pendingCount, 1);
  let drained = false; const drain = h.scope.seal().then(proof => { drained = true; return proof; });
  await turn(); assert.equal(drained, false); assert.equal(h.workers[0].terminations, 1);
  h.workers[0].exit(); h.scope.assertDrained(await drain);
});

test('queued cancellation performs no filesystem work; active cancellation awaits its reply', async () => {
  const h = harness(); const active = new AbortController(); const queued = new AbortController();
  let activeSettled = false;
  const first = h.resolve(active.signal).then(result => { activeSettled = true; return result; });
  const second = h.resolve(queued.signal); queued.abort();
  assert.equal(await second, undefined); assert.equal(h.workers[0].messages.length, 1);
  active.abort(); await turn(); assert.equal(activeSettled, false);
  h.workers[0].reply(); assert.equal(await first, undefined);
  assert.equal(h.workers[0].messages.length, 1);
  const drain = h.scope.seal(); h.workers[0].exit(); await drain;
});

test('seal revokes active and queued work and waits for actual exit, ignoring late replies', async () => {
  const h = harness(); let firstSettled = false; let drained = false;
  const first = h.resolve().then(result => { firstSettled = true; return result; });
  const second = h.resolve();
  const drain = h.scope.seal().then(proof => { drained = true; return proof; });
  assert.equal(await second, undefined);
  h.workers[0].reply(); await turn();
  assert.equal(firstSettled, false); assert.equal(drained, false);
  assert.equal(await h.resolve(), undefined); assert.equal(h.workers.length, 1);
  h.workers[0].exit(); assert.equal(await first, undefined);
  h.scope.assertDrained(await drain);
});

test('idle termination waits for exit before handing a new request to a replacement worker', async () => {
  const h = harness(1); const first = h.resolve();
  h.workers[0].reply(); await first;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.workers[0].terminations, 1);
  const next = h.resolve(); assert.equal(h.workers.length, 1);
  h.workers[0].exit(); assert.equal(h.workers.length, 2);
  h.workers[1].reply(); assert.equal(await next, example.filePath);
  const drain = h.scope.seal(); h.workers[1].exit(); await drain;
});

test('worker errors fail closed without releasing active work or restarting before actual exit', async () => {
  const h = harness(); let settled = false;
  const first = h.resolve().then(result => { settled = true; return result; });
  const second = h.resolve();
  h.workers[0].emit('error', new Error('synthetic failure'));
  assert.equal(await second, undefined); assert.equal(await h.resolve(), undefined);
  await turn(); assert.equal(settled, false); assert.equal(h.workers.length, 1);
  h.workers[0].exit(); assert.equal(await first, undefined);
  const next = h.resolve(); assert.equal(h.workers.length, 2);
  h.workers[1].reply(); assert.equal(await next, example.filePath);
  const drain = h.scope.seal(); h.workers[1].exit(); await drain;
});

test('unexpected exit discards queued requests rather than silently reusing stale work', async () => {
  const h = harness(); const first = h.resolve(); const second = h.resolve();
  h.workers[0].exit();
  assert.equal(await first, undefined); assert.equal(await second, undefined);
  assert.equal(h.workers.length, 1); h.scope.assertDrained(await h.scope.seal());
});

test('malformed and mismatched replies terminate the worker and cannot authorize media', async () => {
  for (const reply of [null, {}, { id: 999, path: example.filePath }, { id: 1, path: 'relative.jpg' },
    { id: 1, path: 42 }, { id: 1, path: '/bad\0path' }]) {
    const h = harness(); let settled = false;
    const result = h.resolve().then(value => { settled = true; return value; });
    h.workers[0].emit('message', reply); await turn();
    assert.equal(settled, false); assert.equal(h.workers[0].terminations, 1);
    h.workers[0].exit(); assert.equal(await result, undefined); await h.scope.seal();
  }
});

test('startup and postMessage failures fail closed and retain any existing worker until exit', async () => {
  const scope = new NormalOperationScope();
  const validator = new NormalPreviewValidation(scope, () => { throw new Error('synthetic startup failure'); });
  assert.equal(await validator.resolve(example.filePath, example.outputDirectory, example.assetDirectory), undefined);
  assert.equal(scope.pendingCount, 0); scope.assertDrained(await scope.seal());
  const h = harness(); const first = h.resolve();
  h.workers[0].postMessage = () => { throw new Error('synthetic send failure'); };
  const second = h.resolve(); h.workers[0].reply();
  assert.equal(await first, example.filePath); assert.equal(h.workers[0].terminations, 1);
  const drain = h.scope.seal(); h.workers[0].exit(); assert.equal(await second, undefined); await drain;
});

test('admission is bounded to 512 active or queued lookups', async () => {
  const h = harness(); const admitted = Array.from({ length: 512 }, () => h.resolve());
  assert.equal(await h.resolve(), undefined); assert.equal(h.workers[0].messages.length, 1);
  assert.equal(h.scope.pendingCount, 513);
  const drain = h.scope.seal(); await turn();
  assert.equal(h.scope.pendingCount, 2);
  h.workers[0].exit(); assert.deepEqual(await Promise.all(admitted), Array(512).fill(undefined));
  h.scope.assertDrained(await drain);
});

test('revocation during worker startup still tracks and terminates the newly returned worker', async () => {
  const scope = new NormalOperationScope(); const worker = new FakeWorker();
  let drain: ReturnType<NormalOperationScope['seal']>;
  const validator = new NormalPreviewValidation(scope, () => {
    drain = scope.seal(); return worker as unknown as Worker;
  });
  const result = validator.resolve(example.filePath, example.outputDirectory, example.assetDirectory);
  assert.equal(await result, undefined); assert.equal(worker.messages.length, 0);
  assert.equal(worker.terminations, 1); assert.equal(scope.pendingCount, 1);
  worker.exit(); scope.assertDrained(await drain);
});

test('resuming a drained epoch starts a fresh worker and rejects old aborted request signals', async () => {
  const h = harness(); const revoked = new AbortController(); const first = h.resolve(revoked.signal);
  const drain = h.scope.seal(); revoked.abort(); h.workers[0].exit(); assert.equal(await first, undefined);
  h.scope.resume(await drain);
  assert.equal(await h.resolve(revoked.signal), undefined);
  const next = h.resolve(); assert.equal(h.workers.length, 2);
  h.workers[1].reply(); assert.equal(await next, example.filePath);
  const finalDrain = h.scope.seal(); h.workers[1].exit(); await finalDrain;
});
