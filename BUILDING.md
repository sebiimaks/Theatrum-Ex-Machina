# Building from source

[Back to the user guide](./README.md)

Use the [release downloads](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases) to install a published application. The commands below are for development and package verification.

## Prerequisites

Use a Node.js version supported by `package.json` (`^22.12.0` or `>=24.0.0`) and install dependencies with `npm ci`. Build natively on Apple Silicon macOS or AMD64 Linux. Media-tool compilation requires `curl`, `make`, `pkg-config`, `tar`, and a C compiler; Linux also requires `nasm` and `xz`.

Review [LICENSE](./LICENSE), [third-party notices](./legal/THIRD_PARTY_NOTICES.txt), and [media-tool licensing](./legal/MEDIA-TOOLS.md) before distributing a package.

Run `npm run check` for TypeScript and lint checks, and `npm test` for the automated test suites. `npm start` starts the development app.

The experimental private-hub foundation has a focused suite, `npm run test:private-hubs`. This first compiles its advisory-lock helper and, on macOS, the in-process Touch ID module using `npm run privacy:build`, then tests encryption, process locking, recovery, streaming, copy conversion, protected preview generation, encrypted inactivity settings, automatic locking, authenticated password changes, verified unprotected copies, native menu ownership and clipboard-event policy, Touch ID adapters and encrypted-store integration, session revocation, and storage/protocol/IPC boundaries. Generation tests also require the bundled FFmpeg/FFprobe tools prepared by the normal media setup; they create synthetic sources and pass generated previews through memory pipes. Both development binaries are built in `build/privacy-tools/`; they are not yet included in application packages. The macOS module uses the pinned `node-api-headers` development dependency. Real Touch ID requires a provisioned signed host; see [Touch ID build and acceptance requirements](./docs/private-hubs-touch-id.md). Review [the private-hub design and integration gates](./docs/private-hubs.md) before extending it. Private hubs are not yet available in the application interface.

The Electron main-process TypeScript build targets ES2022, consistent with the supported Node.js runtime. Private-hub sessions and storage use native private fields; no additional npm dependencies are required.

Run `npm run test:private-browser:native` separately to exercise the private browser in the installed development Electron runtime. Prepare the privacy helper and bundled media tools first. The harness opens temporary native windows with synthetic data, uses disposable profiles under the checkout's `tmp/` directory, and probes only its own loopback listeners. It installs a synthetic ordinary application menu and tests private replacement/restoration, native export-shortcut filtering, Copy/Cut prevention and credential-only synthetic paste. Clipboard backstops prevent the fixture from reading or replacing the user's clipboard. It also tests password entry, cancellation, encrypted-hub opening, incorrect passwords, the real gallery assets and bridge, paging/search, notes/tag Save and Discard, protection settings and minimum-window layout, password changes with mismatched/incorrect credentials, unprotected-copy authentication and picker cancellation, byte-identical copy verification, source selection cancellation, real encrypted preview regeneration, decrypted image and clip playback, storage clearing, profile/encrypted-file markers, network restrictions, locking, reopening, and saved metadata/generated previews/protection settings and the new password in a second Electron process. The automatic-lock check advances a main-process test clock, verifies that native keyboard input renews the deadline and DOM events do not, then checks window destruction and workspace drainage. The native folder picker result is automated for synthetic data; real OS permission prompts and picker history require manual checks. The automation window disables background throttling for playback and becomes visible for layout, playback and input checks; production window settings are unchanged. It retains images of the empty unlock screen at `tmp/private-unlock-review.png` and synthetic gallery at `tmp/private-gallery-review.png`, plus Protection panel views at `tmp/private-protection-review.png` and `tmp/private-protection-small-review.png`, the empty password-change form at `tmp/private-password-change-review.png`, and the unprotected-copy form at `tmp/private-unprotected-copy-review.png` and `tmp/private-unprotected-copy-small-review.png`. The full Angular-to-private workflow, real OS clipboard paste and Linux selection buffers are not covered by this harness. It does not build or install the application. The explicitly requested synthetic unprotected copy is outside the profile/encrypted-file scan targets. Successful fixtures are removed; failed fixtures remain for diagnosis. This GUI test is separate from `npm test`; a graphical session is required. Review [the recorded validation and its limits](./docs/private-hubs-validation.md).

Run `npm run test:normal-protocol:native` to verify ordinary preview delivery and cancellation with the existing development Electron and media-tool runtimes. It tests real GET, HEAD and range responses, image decoding, clip playback, paused requests, and resuming through a fresh normal-operation epoch. Synthetic media and disposable browser profiles stay in the checkout's `tmp/` directory. This separate GUI test does not package or install the app.

Run `npm run test:renderer-handoff:native` to verify the production renderer pause coordinators in a synthetic Electron editor. It uses real text insertion, browser input and overlay controls, clip playback and main/renderer IPC to check draft capture, mutation blocking, deferred results, refusal and restoration failures. It requires the existing development Electron runtime, bundled FFmpeg and a graphical session, and normally finishes within a minute. Fixtures and the disposable profile stay under `tmp/`; successful fixtures are removed and failures remain for diagnosis. This test is separate from `npm test` and does not package or install the app. It does not cover the full Angular Home/private-gallery transition or hardware IME input.

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
