# Building from source

[Back to the user guide](./README.md)

Use the [release downloads](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases) to install a published application. The commands below are for development and package verification.

## Prerequisites

Use a Node.js version supported by `package.json` (`^22.12.0` or `>=24.0.0`) and install dependencies with `npm ci`. Build natively on Apple Silicon macOS or AMD64 Linux. Media-tool compilation requires `curl`, `make`, `pkg-config`, `tar`, and a C compiler; Linux also requires `nasm` and `xz`.

Review [LICENSE](./LICENSE), [third-party notices](./legal/THIRD_PARTY_NOTICES.txt), and [media-tool licensing](./legal/MEDIA-TOOLS.md) before distributing a package.

Run `npm run check` for TypeScript and lint checks, and `npm test` for the automated test suites. `npm start` starts the development app.

## Production preflight

Production package commands run the tracked `release:preflight`. They require a clean, designated `main` release worktree, the canonical `Theatrum-Ex-Machina` repository directory, the fork origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and the worktree-specific Git setting `vha.releaseWorktree=true`. Development and test worktrees are not production release worktrees.

Use the test package commands below for development builds. Do not bypass the release preflight.

## macOS ARM64

For a local production ZIP, run:

```sh
npm run electron:mac:local
```

This runs the release preflight, builds the application and ARM64 ZIP in `release/`, creates the matching media-source archive, and verifies the packaged application and licensing payload. It neither publishes a release nor installs the app. The application is unsigned and unnotarized.

`npm run electron:mac:release` builds and verifies a DMG instead. DMG creation requires temporary disk-image mounts outside the repository; use the ZIP command when the build must remain within a workspace.

For an unpacked development test application in `release-test/`, run:

```sh
npm run electron:mac:test
```

Test packages are not production releases.

## Debian/Ubuntu AMD64 test packages

The manual [Linux Debian package workflow](https://github.com/sebiimaks/Theatrum-Ex-Machina/actions/workflows/linux-deb.yml) builds natively on GitHub's Ubuntu 22.04 AMD64 runner. It compiles the reviewed FFmpeg and x264 sources, runs the static and automated test suites, builds and installs the `.deb`, verifies architecture and linkage, checks application contents and desktop integration, validates licensing and corresponding source, exercises media extraction, starts the packaged app under Xvfb, and verifies SHA-256 checksums.

The expiring Actions artifact contains the `.deb`, its platform-qualified media-source archive, and `SHA256SUMS-linux-amd64`. The workflow has read-only repository permissions and cannot publish a GitHub release. Its output is a CI test build, not an official release. Desktop installation, catalogue opening, scanning, playback, Trash, network volumes, and `.scaena` file association still require testing on a normal Debian/Ubuntu desktop before public distribution.

For a local development package, run `npm run electron:linux:test` on an AMD64 Linux host. A designated native Linux AMD64 production worktree can run `npm run electron:linux:release` for the release package and verification path.

## Distribution contents

Every published application must be accompanied by the exact matching media-source archive, a checksum manifest, and the licence and build materials required by its FFmpeg and x264 executables. GitHub's automatically generated project-source archives do not replace the media-source archive.

Packaged applications include the project MIT licence, version-pinned Node/runtime notices, production renderer notices, Electron's MIT licence, Chromium's third-party credits, and media-program notices. Locally built applications do not include automatic update checking.
