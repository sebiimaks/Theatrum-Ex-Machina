import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const brandingDirectory = path.join(projectDirectory, 'src', 'assets', 'branding');
const sourceVariants = {
  light: {
    svg: path.join(brandingDirectory, 'theatrum-ex-machina-logo-light.svg'),
    png: path.join(brandingDirectory, 'theatrum-ex-machina-logo-light.png'),
    svgHash: '0cb36fc31b839d898034af6743a017d9387e828fcc5c5278f495ef49e5da7fed',
    pngHash: '0c2a9c2797b4eaf198969634f243b65a2f5318b0974ed9f938ca79678f0ec786',
  },
  dark: {
    svg: path.join(brandingDirectory, 'theatrum-ex-machina-logo-dark.svg'),
    png: path.join(brandingDirectory, 'theatrum-ex-machina-logo-dark.png'),
    svgHash: '0784d277c8c97fba170b349dda9b17cc95e12254a6ea5f83b6a5d14f3b896a53',
    pngHash: '05a987157905f7259f071082a8eb2e47f5b1aebc2cd55a212d5bdd200f87007b',
  },
};
const platformMasterPng = sourceVariants.dark.png;

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'theatrum-ex-machina-branding-'));
const stagingDirectory = path.join(temporaryDirectory, 'staged');
const stagedPngDirectory = path.join(stagingDirectory, 'icons', 'png');
const iconsetDirectory = path.join(temporaryDirectory, 'TheatrumExMachina.iconset');
const validatedIconsetDirectory = path.join(temporaryDirectory, 'ValidatedTheatrumExMachina.iconset');
fs.mkdirSync(stagedPngDirectory, { recursive: true });
fs.mkdirSync(iconsetDirectory);
process.on('exit', () => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed.`);
  }
  return result.stdout;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifySources() {
  for (const variant of Object.values(sourceVariants)) {
    for (const [sourcePath, expectedHash] of [
      [variant.svg, variant.svgHash],
      [variant.png, variant.pngHash],
    ]) {
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Missing branding source: ${sourcePath}`);
      }
      if (sha256(sourcePath) !== expectedHash) {
        throw new Error(
          `Branding source changed without review: ${sourcePath}. `
          + 'Review all supplied light and dark source files and update their approved hashes together.',
        );
      }
    }
    assertPng(variant.png, 1024);
  }
}

function imageProperties(imagePath) {
  const output = run('sips', [
    '-g', 'pixelWidth',
    '-g', 'pixelHeight',
    '-g', 'hasAlpha',
    imagePath,
  ]);
  const width = Number(output.match(/pixelWidth:\s+(\d+)/)?.[1]);
  const height = Number(output.match(/pixelHeight:\s+(\d+)/)?.[1]);
  const hasAlpha = output.match(/hasAlpha:\s+(\S+)/)?.[1];
  return { width, height, hasAlpha };
}

function assertPng(imagePath, expectedSize) {
  const properties = imageProperties(imagePath);
  if (
    properties.width !== expectedSize
    || properties.height !== expectedSize
    || properties.hasAlpha !== 'yes'
  ) {
    throw new Error(
      `Invalid PNG ${imagePath}: expected ${expectedSize}x${expectedSize} with alpha, `
      + `received ${properties.width}x${properties.height} with alpha=${properties.hasAlpha}.`,
    );
  }
}

function resize(sourcePath, size, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  run('sips', [
    '--resampleHeightWidth', String(size), String(size),
    sourcePath,
    '--out', outputPath,
  ]);
}

function writeIco(outputPath, imagePaths) {
  const images = imagePaths.map((imagePath) => fs.readFileSync(imagePath));
  const headerLength = 6 + (16 * images.length);
  const header = Buffer.alloc(headerLength);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = headerLength;
  imagePaths.forEach((imagePath, index) => {
    const size = Number.parseInt(path.basename(imagePath), 10);
    const entryOffset = 6 + (index * 16);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(images[index].length, entryOffset + 8);
    header.writeUInt32LE(offset, entryOffset + 12);
    offset += images[index].length;
  });

  fs.writeFileSync(outputPath, Buffer.concat([header, ...images]));
}

function assertIco(icoPath, expectedSizes) {
  const ico = fs.readFileSync(icoPath);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error(`Invalid ICO header: ${icoPath}`);
  }
  if (ico.readUInt16LE(4) !== expectedSizes.length) {
    throw new Error(`Invalid ICO image count: ${icoPath}`);
  }
  expectedSizes.forEach((expectedSize, index) => {
    const entryOffset = 6 + (index * 16);
    const width = ico.readUInt8(entryOffset) || 256;
    const height = ico.readUInt8(entryOffset + 1) || 256;
    const imageLength = ico.readUInt32LE(entryOffset + 8);
    const imageOffset = ico.readUInt32LE(entryOffset + 12);
    if (
      width !== expectedSize
      || height !== expectedSize
      || imageLength === 0
      || imageOffset + imageLength > ico.length
    ) {
      throw new Error(`Invalid ${expectedSize}px ICO entry: ${icoPath}`);
    }
  });
}

function installTogether(files) {
  const backups = files.map(([sourcePath, destinationPath], index) => {
    const backupPath = path.join(temporaryDirectory, 'backups', String(index));
    const existed = fs.existsSync(destinationPath);
    if (existed) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(destinationPath, backupPath);
    }
    return { sourcePath, destinationPath, backupPath, existed };
  });

  try {
    for (const { sourcePath, destinationPath } of backups) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const pendingPath = `${destinationPath}.branding-${process.pid}`;
      fs.copyFileSync(sourcePath, pendingPath);
      fs.renameSync(pendingPath, destinationPath);
    }
  } catch (error) {
    for (const { destinationPath, backupPath, existed } of backups) {
      if (existed) {
        fs.copyFileSync(backupPath, destinationPath);
      } else {
        fs.rmSync(destinationPath, { force: true });
      }
      fs.rmSync(`${destinationPath}.branding-${process.pid}`, { force: true });
    }
    throw error;
  }
}

if (process.platform !== 'darwin') {
  throw new Error('Brand assets must be regenerated on macOS with sips and iconutil.');
}

verifySources();

const filesToInstall = [];
const pngSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512];
for (const size of pngSizes) {
  const stagedPath = path.join(stagedPngDirectory, `${size}x${size}.png`);
  resize(platformMasterPng, size, stagedPath);
  assertPng(stagedPath, size);
  filesToInstall.push([
    stagedPath,
    path.join(projectDirectory, 'src', 'assets', 'icons', 'png', `${size}x${size}.png`),
  ]);
}

for (const [sourcePath, size, destinationPath] of [
  [platformMasterPng, 162, path.join(projectDirectory, 'src', 'assets', 'logo.png')],
  [sourceVariants.light.png, 162, path.join(projectDirectory, 'src', 'assets', 'logo-light.png')],
  [sourceVariants.dark.png, 162, path.join(projectDirectory, 'src', 'assets', 'logo-dark.png')],
  [platformMasterPng, 512, path.join(projectDirectory, 'src', 'assets', 'favicon.png')],
  [sourceVariants.light.png, 512, path.join(projectDirectory, 'src', 'assets', 'favicon-light.png')],
  [sourceVariants.dark.png, 512, path.join(projectDirectory, 'src', 'assets', 'favicon-dark.png')],
  [platformMasterPng, 512, path.join(projectDirectory, 'src', 'favicon.png')],
]) {
  const stagedPath = path.join(stagingDirectory, `${filesToInstall.length}-${size}.png`);
  resize(sourcePath, size, stagedPath);
  assertPng(stagedPath, size);
  filesToInstall.push([stagedPath, destinationPath]);
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const stagedIco = path.join(stagingDirectory, 'favicon.ico');
writeIco(
  stagedIco,
  icoSizes.map((size) => path.join(stagedPngDirectory, `${size}x${size}.png`)),
);
assertIco(stagedIco, icoSizes);
filesToInstall.push([stagedIco, path.join(projectDirectory, 'src', 'favicon.ico')]);

const iconsetEntries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];
for (const [fileName, size] of iconsetEntries) {
  const stagedPath = path.join(iconsetDirectory, fileName);
  resize(platformMasterPng, size, stagedPath);
  assertPng(stagedPath, size);
}

const stagedIcns = path.join(stagingDirectory, 'icons.icns');
run('iconutil', ['--convert', 'icns', '--output', stagedIcns, iconsetDirectory]);
if (!fs.existsSync(stagedIcns) || fs.statSync(stagedIcns).size === 0) {
  throw new Error(`Invalid ICNS output: ${stagedIcns}`);
}
run('iconutil', ['--convert', 'iconset', '--output', validatedIconsetDirectory, stagedIcns]);
for (const [fileName, size] of iconsetEntries) {
  assertPng(path.join(validatedIconsetDirectory, fileName), size);
}
for (const destinationPath of [
  path.join(projectDirectory, 'src', 'assets', 'icons.icns'),
  path.join(projectDirectory, 'src', 'assets', 'icons', 'icons.icns'),
  path.join(projectDirectory, 'src', 'assets', 'icons', 'mac', 'icons.icns'),
]) {
  filesToInstall.push([stagedIcns, destinationPath]);
}

installTogether(filesToInstall);
console.log('Generated and verified light and dark Theatrum Ex Machina branding assets.');
