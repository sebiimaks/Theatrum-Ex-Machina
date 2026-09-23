import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Script } from 'node:vm';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { Arch } = require('builder-util');
const ts = require('typescript');
const { privateAssets, privateModules, helperNames, verifyNativeHelpers, verifyPrivacyPayload } = require('../bin/privacy-package.cjs');
const { preparePrivacyPackage } = require('../bin/prepare-privacy-package.cjs');
const repository = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const builder = JSON.parse(await fs.readFile(path.join(repository, 'electron-builder.json'), 'utf8'));

function nativeHeader(platform, arch, addon = false) {
  const header = Buffer.alloc(64);
  if (platform === 'darwin') {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    header.writeUInt32LE(addon ? 8 : 2, 12);
  } else {
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header.writeUInt16LE(3, 16);
    header.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  }
  return header;
}
async function fixture(t, platform = 'darwin', arch = 'arm64') {
  const root = await fs.mkdtemp(path.join(repository, 'tmp', 'private-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = path.join(root, 'content');
  const resourcesPath = path.join(root, 'resources');
  const helperDirectory = path.join(resourcesPath, 'privacy-tools');
  await fs.mkdir(content);
  await fs.mkdir(helperDirectory, { recursive: true });
  for (const file of privateAssets) {
    await fs.mkdir(path.dirname(path.join(content, file)), { recursive: true });
    await fs.copyFile(path.join(repository, file), path.join(content, file));
  }
  for (const file of privateModules) {
    await fs.mkdir(path.dirname(path.join(content, file)), { recursive: true });
    await fs.writeFile(path.join(content, file), '/* Synthetic compiled module; no runtime acceptance claimed. */');
  }
  for (const name of helperNames(platform)) {
    await fs.writeFile(path.join(helperDirectory, name), nativeHeader(platform, arch, name.endsWith('.node')), { mode: 0o755 });
  }
  const archive = path.join(resourcesPath, 'app.asar');
  const rebuild = async (unpack = true) => {
    asar.uncache(archive);
    await asar.createPackageWithOptions(content, archive, unpack ? { unpack: '{' + privateAssets.map(file => path.join(content, file)).join(',') + '}' } : {});
    asar.uncache(archive);
  };
  await rebuild();
  return { root, content, resourcesPath, helperDirectory, rebuild,
    verify: () => verifyPrivacyPayload({ resourcesPath, projectDirectory: repository, platform, arch, asar }) };
}

test('builder includes every isolated document/preload and only fixed platform native helpers', () => {
  for (const file of privateAssets) { assert.ok(builder.files.includes(file), 'Missing private asset: ' + file); }
  assert.deepEqual(builder.asarUnpack, privateAssets);
  assert.equal(builder.beforePack, './bin/prepare-privacy-package.cjs');
  assert.deepEqual(builder.mac.extraResources, [{ from: 'build/privacy-tools', to: 'privacy-tools', filter: helperNames('darwin') }]);
  assert.deepEqual(builder.linux.extraResources, [{ from: 'build/privacy-tools', to: 'privacy-tools', filter: helperNames('linux') }]);
  assert.equal(builder.win.extraResources, undefined);
  assert.ok(!builder.files.some(file => typeof file === 'string' && /(?:tmp|build\/privacy-tools|node\/\*\*\/\*\.cjs)/.test(file)));
});

test('beforePack rebuilds native helpers and verifies outputs before package copying', () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    let verified = false;
    preparePrivacyPackage({ electronPlatformName: platform, arch: Arch.arm64, packager: { projectDir: repository } }, {
      platform, arch: 'arm64',
      run(command, args, options) {
        assert.equal(command, process.execPath);
        assert.equal(options.cwd, repository);
        calls.push(path.basename(args[0]));
        return { status: 0 };
      },
      verify(directory, targetPlatform, arch) {
        assert.equal(directory, path.join(repository, 'build', 'privacy-tools'));
        assert.equal(targetPlatform, platform); assert.equal(arch, 'arm64'); verified = true;
      },
    });
    assert.deepEqual(calls, platform === 'darwin' ? ['build-privacy-tools.mjs', 'build-touch-id.mjs'] : ['build-privacy-tools.mjs']);
    assert.equal(verified, true);
  }
});

test('cross-target compilation and helper compilation/verification failures stop packaging', () => {
  const context = { electronPlatformName: 'darwin', arch: Arch.arm64, packager: { projectDir: repository } };
  const run = () => { assert.fail('Mismatched targets must fail before compilation.'); };
  assert.throws(() => preparePrivacyPackage(context, { platform: 'linux', arch: 'arm64', run }), /natively/);
  assert.throws(() => preparePrivacyPackage(context, { platform: 'darwin', arch: 'x64', run }), /natively/);
  assert.throws(() => preparePrivacyPackage({ ...context, arch: Arch.universal }, { platform: 'darwin', arch: 'arm64', run }), /natively/);
  assert.throws(() => preparePrivacyPackage(context, { platform: 'darwin', arch: 'arm64', run: () => ({ status: 1 }) }), /compilation failed/);
  assert.throws(() => preparePrivacyPackage(context, { platform: 'darwin', arch: 'arm64', run: () => ({ status: 0 }),
    verify: () => { throw new Error('Stale output'); } }), /Stale output/);
  preparePrivacyPackage({ electronPlatformName: 'win32' }, { run });
});

test('actual ASAR payload accepts complete macOS and Linux layouts', async t => {
  for (const platform of ['darwin', 'linux']) {
    const sample = await fixture(t, platform);
    assert.doesNotThrow(sample.verify);
  }
});

test('missing conversion script and changed standalone preload are rejected from actual ASAR', async t => {
  const sample = await fixture(t);
  const script = path.join(sample.content, 'private-conversion', 'conversion.js');
  await fs.unlink(script); await sample.rebuild();
  assert.throws(sample.verify, /missing/);
  await fs.copyFile(path.join(repository, 'private-conversion', 'conversion.js'), script);
  await fs.appendFile(path.join(sample.content, 'private-conversion-preload.cjs'), '\n/* unreviewed */');
  await sample.rebuild();
  assert.throws(sample.verify, /differs/);
});

test('virtual-only and linked static UI payloads are rejected', async t => {
  const sample = await fixture(t);
  await sample.rebuild(false);
  assert.throws(sample.verify, /physical unpacked/);
  await sample.rebuild();
  const preload = path.join(sample.resourcesPath, 'app.asar.unpacked', 'private-password-preload.cjs');
  await fs.unlink(preload);
  await fs.symlink(path.join(repository, 'private-password-preload.cjs'), preload);
  assert.throws(sample.verify, /regular file/);
});

test('absent resolver, misplaced helper and native acceptance driver fail archive verification', async t => {
  const sample = await fixture(t);
  const resolver = path.join(sample.content, 'node', 'private-helper-paths.js');
  await fs.unlink(resolver); await sample.rebuild();
  assert.throws(sample.verify, /main-process module/);
  await fs.writeFile(resolver, '/* Synthetic resolver */');
  const embedded = path.join(sample.content, 'privacy-tools');
  await fs.mkdir(embedded); await fs.writeFile(path.join(embedded, 'private-hub-lock'), 'misplaced');
  await sample.rebuild();
  assert.throws(sample.verify, /outside/);
  await fs.rm(embedded, { recursive: true });
  await fs.writeFile(path.join(sample.content, 'node', 'private-host-instrumentation.cjs'), '/* test-only gate override */');
  await sample.rebuild();
  assert.throws(sample.verify, /acceptance drivers/);
});

test('native resource verification rejects missing, stale-architecture, non-executable and linked helpers', async t => {
  const sample = await fixture(t);
  const addon = path.join(sample.helperDirectory, 'private-touch-id.node');
  await fs.unlink(addon);
  assert.throws(sample.verify, /ENOENT/);
  await fs.writeFile(addon, nativeHeader('darwin', 'x64', true), { mode: 0o755 });
  assert.throws(sample.verify, /architecture/);
  await fs.writeFile(addon, nativeHeader('darwin', 'arm64', true));
  await fs.chmod(addon, 0o644);
  assert.throws(sample.verify, /EACCES/);
  await fs.unlink(addon);
  await fs.symlink(path.join(sample.helperDirectory, 'private-hub-lock'), addon);
  assert.throws(sample.verify, /regular file/);
});

test('native headers reject foreign formats and wrong binary roles', async t => {
  const sample = await fixture(t, 'linux', 'x64');
  const lock = path.join(sample.helperDirectory, 'private-hub-lock');
  await fs.writeFile(lock, nativeHeader('darwin', 'x64'));
  assert.throws(() => verifyNativeHelpers(sample.helperDirectory, 'linux', 'x64'), /ELF64/);
  const header = nativeHeader('linux', 'x64'); header.writeUInt16LE(1, 16);
  await fs.writeFile(lock, header);
  assert.throws(() => verifyNativeHelpers(sample.helperDirectory, 'linux', 'x64'), /executable/);
});

test('both existing package verifiers require the private payload', async () => {
  for (const verifier of ['verify-packaged-app.mjs', 'verify-packaged-linux.mjs']) {
    const source = await fs.readFile(path.join(repository, 'bin', verifier), 'utf8');
    assert.match(source, /verifyPrivacyPayload\(\{ resourcesPath, projectDirectory, platform:/);
  }
  const ignore = await fs.readFile(path.join(repository, '.gitignore'), 'utf8');
  assert.match(ignore, /^!private-conversion\/conversion\.js$/m);
});

test('local macOS test packaging uses the installed runtime and cannot publish', async () => {
  const { scripts } = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  assert.match(scripts['electron:mac:test'], /--mac dir --arm64 --publish never/);
  assert.match(scripts['electron:mac:test'], /--config\.electronDist=node_modules\/electron\/dist/);
  assert.match(scripts['electron:mac:test'], /--config\.directories\.output=release-test/);
  assert.match(scripts['electron:mac:release'], /npm run release:preflight/);
  assert.doesNotMatch(scripts['electron:mac:release'], /release-test|config\.electronDist/);
  const privateTest = scripts['electron:mac:private:test'];
  assert.match(privateTest, /--publish never/);
  assert.match(privateTest, /--config\.directories\.output=.*release-test-private/);
  assert.match(privateTest, /--config\.electronDist=node_modules\/electron\/dist/);
  assert.match(privateTest, /verify-packaged-app\.mjs/);
});

test('the actual main/preload build emits CommonJS for Electron startup', () => {
  const configFile = ts.readConfigFile(path.join(repository, 'tsconfig-serve.json'), ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repository);
  assert.equal(config.errors.length, 0);
  assert.equal(config.options.module, ts.ModuleKind.CommonJS);
  for (const name of ['main.ts', 'preload.ts']) {
    const source = ts.sys.readFile(path.join(repository, name));
    const compiled = ts.transpileModule(source, { fileName: name, compilerOptions: config.options }).outputText;
    assert.doesNotThrow(() => new Script(compiled, { filename: name.replace('.ts', '.js') }));
    assert.match(compiled, /require\(/);
  }
});
