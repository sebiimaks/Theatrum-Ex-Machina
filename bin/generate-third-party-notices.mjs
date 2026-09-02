import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectPackagedNodePackagePaths } from './runtime-dependencies.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectDirectory, 'build', 'media-legal');
const trackedNoticePath = path.join(projectDirectory, 'legal', 'THIRD_PARTY_NOTICES.txt');
const packageLock = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package-lock.json'), 'utf8'));
const bundledRendererPackagePaths = new Set([
  'node_modules/@angular/animations',
  'node_modules/@angular/cdk',
  'node_modules/@angular/common',
  'node_modules/@angular/core',
  'node_modules/@angular/forms',
  'node_modules/@angular/material',
  'node_modules/@angular/platform-browser',
  'node_modules/@angular/platform-browser-dynamic',
  'node_modules/@angular/router',
  'node_modules/@tweenjs/tween.js',
  'node_modules/rxjs',
  'node_modules/zone.js',
]);
const shippedPackagePaths = new Set([
  ...collectPackagedNodePackagePaths(packageLock),
  ...bundledRendererPackagePaths,
]);

const licenseCandidates = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'LICENSE-MIT',
  'LICENSE-MIT.txt',
  'license',
  'license.md',
  'license.txt',
];

const licenseOverrides = new Map([
  ['@iharbeck/ngx-virtual-scroller@19.0.1', {
    file: '@iharbeck__ngx-virtual-scroller-19.0.1.txt',
    source: 'https://github.com/iharbeck/ngx-virtual-scroller/tree/v19.0.1',
  }],
  ['assert-plus@1.0.0', {
    file: 'assert-plus-1.0.0.txt',
    source: 'https://github.com/TritonDataCenter/node-assert-plus/tree/v1.0.0',
  }],
]);

function copyrightBearingMitNotice(licenseText) {
  return /^\s*(?:copyright(?:\s*\(c\))?|\(c\)|©)\s+.+$/imu.test(licenseText);
}

function declaredLicenseIncludesMit(declaredLicense) {
  return /(?:^|[()\s])MIT(?:$|[()\s])/u.test(String(declaredLicense));
}

function normalizeNoticeText(value) {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function licenseOverride(identity) {
  const override = licenseOverrides.get(identity);
  if (!override) {
    return null;
  }
  const overridePath = path.join(
    projectDirectory,
    'legal',
    'npm-license-overrides',
    override.file,
  );
  if (!fs.existsSync(overridePath) || !fs.statSync(overridePath).isFile()) {
    throw new Error(`Audited licence override is missing for ${identity}: ${overridePath}`);
  }
  return {
    licenseText: normalizeNoticeText(fs.readFileSync(overridePath, 'utf8')),
    noticeSource: `audited exact-version override (${override.source})`,
  };
}

function firstLicenseFile(packageDirectory) {
  for (const candidate of licenseCandidates) {
    const candidatePath = path.join(packageDirectory, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }
  return null;
}

const runtimePackages = new Map();
const missingLicenses = [];

for (const relativePackageDirectory of shippedPackagePaths) {
  const lockEntry = packageLock.packages[relativePackageDirectory];
  if (!lockEntry) {
    throw new Error(`Locked shipped package is missing: ${relativePackageDirectory}`);
  }

  const packageDirectory = path.join(projectDirectory, relativePackageDirectory);
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Installed runtime package is missing: ${relativePackageDirectory}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (lockEntry.version && packageJson.version !== lockEntry.version) {
    throw new Error(
      `Installed package version does not match package-lock.json: ${packageJson.name}`
      + ` (installed ${packageJson.version}, locked ${lockEntry.version})`,
    );
  }
  if (lockEntry.name && packageJson.name !== lockEntry.name) {
    throw new Error(
      `Installed package name does not match package-lock.json: ${relativePackageDirectory}`,
    );
  }
  const identity = `${packageJson.name}@${packageJson.version}`;
  if (runtimePackages.has(identity)) {
    continue;
  }

  const declaredLicense = packageJson.license || lockEntry.license || 'not declared';
  const licensePath = firstLicenseFile(packageDirectory);
  const override = licenseOverride(identity);
  if (!licensePath && !override) {
    missingLicenses.push(`${identity} (${declaredLicense})`);
    continue;
  }

  const licenseText = override
    ? override.licenseText
    : normalizeNoticeText(fs.readFileSync(licensePath, 'utf8'));
  if (declaredLicenseIncludesMit(declaredLicense) && !copyrightBearingMitNotice(licenseText)) {
    missingLicenses.push(`${identity} (MIT notice has no explicit copyright attribution)`);
    continue;
  }

  runtimePackages.set(identity, {
    identity,
    declaredLicense,
    licenseText,
    noticeSource: override
      ? override.noticeSource
      : `installed package file ${path.basename(licensePath)}`,
  });
}

if (missingLicenses.length > 0) {
  throw new Error(`Runtime package license text is missing:\n${missingLicenses.join('\n')}`);
}

const orderedPackages = [...runtimePackages.values()].sort((left, right) =>
  left.identity.localeCompare(right.identity),
);

const sections = orderedPackages.map((entry) => [
  '='.repeat(80),
  entry.identity,
  `Declared license: ${entry.declaredLicense}`,
  `Notice source: ${entry.noticeSource}`,
  '='.repeat(80),
  entry.licenseText,
].join('\n'));

const notices = [
  'Theatrum Ex Machina - third-party runtime notices',
  '',
  'This file is generated from the exact production dependency lock, bundled renderer',
  'package list, and installed package licence files. Theatrum Ex Machina itself',
  'remains licensed under the MIT License in the application root. FFmpeg and x264',
  'notices are supplied separately.',
  '',
  ...sections,
  '',
].join('\n');

fs.mkdirSync(outputDirectory, { recursive: true });
fs.mkdirSync(path.dirname(trackedNoticePath), { recursive: true });
fs.writeFileSync(trackedNoticePath, notices, 'utf8');
fs.copyFileSync(trackedNoticePath, path.join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'));
fs.copyFileSync(
  path.join(projectDirectory, 'node_modules', 'electron', 'LICENSE'),
  path.join(outputDirectory, 'ELECTRON-LICENSE.txt'),
);
fs.copyFileSync(
  path.join(projectDirectory, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'),
  path.join(outputDirectory, 'LICENSES.chromium.html'),
);
fs.copyFileSync(
  path.join(projectDirectory, 'legal', 'MEDIA-TOOLS.md'),
  path.join(outputDirectory, 'MEDIA-TOOLS.md'),
);

console.log(`Generated notices for ${orderedPackages.length} shipped packages.`);
