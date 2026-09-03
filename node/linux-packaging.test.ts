import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const projectDirectory = path.resolve(__dirname, '..');

function source(relativePath: string): string {
  return fs.readFileSync(path.join(projectDirectory, relativePath), 'utf8');
}

test('keeps Debian packaging native, AMD64-specific, verified, and non-publishing', () => {
  const packageJson = JSON.parse(source('package.json'));
  const builder = JSON.parse(source('electron-builder.json'));
  const workflow = source('.github/workflows/linux-deb.yml');
  const verifier = source('bin/verify-packaged-linux.mjs');

  assert.ok(builder.linux.target.includes('deb'));
  assert.equal(builder.linux.category, 'AudioVideo;Video');
  assert.equal(builder.linux.desktop.entry.Categories, undefined);
  assert.equal(
    builder.linux.artifactName,
    'theatrum-ex-machina-v${version}-linux-${arch}.${ext}',
  );
  assert.match(packageJson.scripts['electron:linux:release'], /--linux deb --x64 --publish never/);
  assert.match(packageJson.scripts['electron:linux:test'], /--linux deb --x64 --publish never/);
  assert.match(packageJson.scripts['media:source:linux'], /linux-amd64/);
  assert.match(packageJson.scripts['verify:linux:release'], /verify-packaged-linux\.mjs/);

  assert.match(workflow, /runs-on:\s*ubuntu-22\.04/);
  assert.match(workflow, /node-version:\s*24\.16\.0/);
  assert.match(workflow, /npm run media:build/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /--linux deb --x64 --publish never/);
  assert.match(workflow, /THEATRUM_REQUIRE_XVFB_SMOKE:\s*'1'/);
  assert.match(workflow, /SHA256SUMS-linux-amd64/);
  assert.doesNotMatch(workflow, /gh release|--publish\s+(?:always|onTag)/);

  const actionReferences = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)]
    .map((match) => match[1]);
  assert.ok(actionReferences.length >= 3);
  actionReferences.forEach((reference) => assert.match(reference, /^[0-9a-f]{40}$/));

  assert.match(verifier, /Architecture'\), 'amd64'/);
  assert.match(verifier, /Target: linux-amd64/);
  assert.match(verifier, /THEATRUM_PACKAGED_SMOKE_READY/);
  assert.match(verifier, /THIRD_PARTY_NOTICES\.txt/);
  assert.match(verifier, /theatrum-ex-machina-media-source-v\$\{packageVersion\}-linux-amd64/);
});
