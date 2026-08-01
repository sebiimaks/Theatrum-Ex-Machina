import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectDirectory, 'build', 'media-legal');
const packageLock = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'package-lock.json'), 'utf8'));

const licenseCandidates = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
];

const standardMitTerms = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function authorDisplay(author) {
  if (typeof author === 'string') {
    return author;
  }
  if (author && typeof author === 'object') {
    return [author.name, author.email, author.url].filter(Boolean).join(' | ');
  }
  return 'See the distributed package metadata and source files for attribution.';
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

for (const [relativePackageDirectory, lockEntry] of Object.entries(packageLock.packages)) {
  if (!relativePackageDirectory.startsWith('node_modules/') || lockEntry.dev) {
    continue;
  }

  const packageDirectory = path.join(projectDirectory, relativePackageDirectory);
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Installed runtime package is missing: ${relativePackageDirectory}`);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const identity = `${packageJson.name}@${packageJson.version}`;
  if (runtimePackages.has(identity)) {
    continue;
  }

  const licensePath = firstLicenseFile(packageDirectory);
  const declaredLicense = packageJson.license || lockEntry.license || 'not declared';
  if (!licensePath && declaredLicense !== 'MIT') {
    missingLicenses.push(`${identity} (${declaredLicense})`);
    continue;
  }

  const licenseText = licensePath
    ? fs.readFileSync(licensePath, 'utf8').trim()
    : [
        'The installed package declares the MIT License but does not ship a separate',
        'license file. Its package metadata and source remain included in the',
        'application archive. Recorded author metadata:',
        authorDisplay(packageJson.author),
        '',
        standardMitTerms,
      ].join('\n');

  runtimePackages.set(identity, {
    identity,
    declaredLicense,
    licenseText,
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
  '='.repeat(80),
  entry.licenseText,
].join('\n'));

const notices = [
  'Theatrum Ex Machina - third-party runtime notices',
  '',
  'This file is generated from the exact production dependency lock and installed',
  'package license files. Theatrum Ex Machina itself remains licensed under the MIT',
  'License in the application root. FFmpeg and x264 notices are supplied separately.',
  '',
  ...sections,
  '',
].join('\n');

fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'), notices, 'utf8');
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

console.log(`Generated notices for ${orderedPackages.length} runtime packages.`);
