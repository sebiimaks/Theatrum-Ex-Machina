# Private-hub development validation — updated 23 September 2026

This record covers experimental storage, generation, browser isolation, the dedicated password/opening and private-copy workflows, the normal-application pause boundary, the saved-document/application transition adapters, the connected ordinary renderer safeguards, the main host lifecycle integration, and the private gallery with encrypted notes/tag editing, native source selection, per-video encrypted preview regeneration, encrypted automatic-lock settings, authenticated password changes, verified unprotected copies, and native menu/clipboard controls. It is not an application release. The latest macOS development build enables native File menu entry for the password workflow; earlier milestones below describe its previously disabled state. All published verification results below use synthetic catalogue and media fixtures. Touch ID work is deferred at the user's request.

## Earlier checkout and native helper build

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `codex/private-hubs` |
| HEAD | `de9922a22cf2bee4b5b9456f4dfc03a77ab8ad79` |
| Worktree state | Dirty: private-hub implementation and documentation are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Tested runtime | macOS, arm64, Node.js `v22.23.2`, Electron `42.11.1` |
| Build command | `npm run privacy:build` (also invoked by the private-hub test suite) |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/build/privacy-tools/private-hub-lock` |

The native advisory-lock helper was rebuilt by `npm test` for the native-controls milestone. No application package was built or installed. Linux native execution, helper packaging, and code signing remain unverified.

The table above records the earlier integration milestones before commit `0bfe180d953875654d72354796770d648623e2ea`. Later milestones identify their own checkout state below.

## Checks

Run commands from the repository root above, with `TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp` for filesystem tests.

### Catalogue metadata false positive — 23 September 2026

A catalogue metadata update can advance the filesystem change timestamp (`ctime`) without changing the contents or modification timestamp (`mtime`). The previous validation treated that metadata change as a catalogue edit and refused conversion.

A three-second delay in the synthetic packaged picker, without deliberate metadata changes, passed. Reapplying the synthetic catalogue's existing permissions after review then reproduced the exact `source-changed` error in the previous package, while its bytes, size, modification time, inode and permissions remained unchanged. The failure was recorded in `tmp/private-picker-ctime-red-host.log` and `tmp/private-picker-ctime-red-diagnostic.json`. Three headless metadata-only success cases also failed before the fix.

Catalogue comparison now uses its exact SHA-256 content digest together with path, device/inode, size and modification time. A metadata-only `ctime` difference during validation triggers a fresh read through the existing descriptor/identity checks and requires the original content digest to match. The digest remains available after plaintext buffers are wiped. Preview-file and directory checks are unchanged. Same-size content edits with restored modification times remain rejected; cancellation, uncertain descriptor closure and buffer wiping retain their existing handling.

All **60 focused conversion tests** passed: 30 review tests, including seven new metadata/content/cancellation/cleanup cases, and 30 converter tests. Main/renderer/worker and persistence TypeScript checks, application lint, targeted converter/test lint, native-driver syntax and `git diff --check` passed. Logs include `tmp/private-catalogue-metadata-red.log`, `tmp/private-catalogue-metadata-green.log`, `tmp/private-metadata-conversion.log`, `tmp/private-metadata-check.log` and `tmp/private-metadata-persistence-types.log`.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `codex/private-hubs` |
| HEAD | `0bfe180d953875654d72354796770d648623e2ea` |
| Worktree state | Dirty; preceding work preserved and changes uncommitted |
| Release designation | `vha.releaseWorktree=false`; unsigned local test package |
| Application artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-metadata-check/mac-arm64/Theatrum Ex Machina.app` |
| Corresponding media source | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-metadata-check/theatrum-ex-machina-media-source-v2.0.0.tar.xz` |

Exact successful build command:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-metadata-check TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-metadata-build.log 2>&1
```

The package startup, media and licensing verifier passed. No commit, push, installation or production release was performed; previous review apps remain available. Broader real-world conversion acceptance remains outstanding.

The exact packaged failure case passed after the fix with:

```sh
THEATRUM_PRIVATE_PICKER_DELAY_MS=3000 THEATRUM_PRIVATE_PICKER_TOUCH_CTIME=1 THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-metadata-check TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-package:host > tmp/private-picker-ctime-green-host.log 2>&1
```

Both packages saw `ctimeChanged:true`, `mtimeChanged:false`, `identityChanged:false` and `contentEqual:true`. The previous package reported `sourceChangedFailure:true`; the new package reported `false` and passed all five normal/private checkpoints: conversion, decoded preview, encrypted note save, lock/restore, password reopen and clean close. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-tree file checks, without the tested private markers in UTF-8/UTF-16LE form. Eighteen unpacked files and the package were verified unchanged. Archive SHA-256: `ad26d9939828cc3de7c895e539b2d4f6b836c03e6cd10d8acc81317c9ed2e7b0`. This controlled metadata-only reproduction validates the fix; it does not substitute for broader real-world conversion and filesystem-permission acceptance.

### Destination validation and failure diagnostics — 23 September 2026

A path defect was reproduced on a case-insensitive filesystem: native `realpath` returned the stored capitalization, while the selected path used another spelling of the same physical folder. The helper rejected the difference. The JavaScript implementation of `realpathSync` could preserve the supplied capitalization, so validation now uses the native canonical path.

Selection now resolves the stored path before passing it to the strict storage layer. Every selected ancestor is checked for symbolic links and retained device/inode identity; the canonical leaf must identify the same directory. Existing destination entries are still skipped, and exclusive creation is unchanged. Seven destination tests pass, including the two case-alias regressions that failed before the fix and refusal of a symlink ancestor whose leaf is a normal directory. The packaged-host fixture now submits a case-variant selected path where the filesystem supports it.

Conversion failures now identify source inspection, changed source data, storage initialization, catalogue encryption, preview copying, verification or completion receipt publication. Fixed error categories cross IPC, with static user-facing messages. Existing errno categories and branded failures take precedence; original error identity, cancellation and cleanup handling are retained. No exception messages, paths, stacks or credentials cross this boundary or get written to diagnostic logs.

**209 focused tests passed:** seven destination, 66 private-browser, 34 conversion-request, 23 conversion-review, nine conversion-workspace, 30 conversion, four failure-category, 16 conversion-preload and 20 conversion-UI tests. Both capitalization regressions ran on the case-insensitive test volume; none were skipped. Main/renderer/worker and persistence TypeScript checks, lint, JavaScript syntax checks and `git diff --check` passed.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `codex/private-hubs` |
| HEAD | `0bfe180d953875654d72354796770d648623e2ea` |
| Worktree state | Dirty; preceding work preserved and changes uncommitted |
| Release designation | `vha.releaseWorktree=false`; unsigned local test package |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Application artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-path-check/mac-arm64/Theatrum Ex Machina.app` |
| Corresponding media source | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-path-check/theatrum-ex-machina-media-source-v2.0.0.tar.xz` |

Exact successful build command:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-path-check TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-path-build.log 2>&1
```

The standard package verifier passed application startup, media and licensing checks. The preceding app and installed application were preserved. No commit, push, installation or production release was performed.

The packaged-host test passed all five checkpoints with:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-path-check TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-package:host > tmp/private-path-packaged-host.log 2>&1
```

Its synthetic picker returned a case-variant parent, with retained existing files and an occupied **Private hub** name. The packaged main created **Private hub 2**, decoded its preview, saved an encrypted note, locked, reopened by password with the note intact, restored the ordinary workspace and closed cleanly. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-tree file checks; synthetic private-note/password markers were absent in the tested encodings. Eighteen unpacked files and the original package remained unchanged. Archive SHA-256: `952b142212fa7f1761ef7aa50fb16c1535a9f4b5c912d741b3b63149a286b399`. Native picker responses were automated, so this remains a synthetic packaged-application result, not acceptance of real macOS permission prompts.

### Folder-selection correction after first user review — 23 September 2026

The first user review reached conversion counts but failed immediately after selecting a destination on the Mac's internal drive. The user tried creating a folder and selecting that folder again. The old Save dialog could return an existing directory, while encrypted storage intentionally requires an exclusive new directory. A separate regression also showed that creating a sibling folder or `.DS_Store` after review incorrectly invalidated the source-parent fingerprint, even when every catalogue and preview file was unchanged.

The native picker now selects an existing parent folder, with **New Folder** available. Main chooses an unused child named **Private hub**, **Private hub 2**, and so on; the store still creates it exclusively and never adopts or overwrites existing content. Canonical parent identity remains checked. Conversion review now compares the source parent's device/inode rather than unrelated directory timestamps/size, while retaining strict catalogue, preview-file and preview-directory checks. Failure states expose only fixed categories for unavailable/existing destinations, access denial, full storage, missing files or a generic failure; passwords, paths and native diagnostics never enter these messages.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `codex/private-hubs` |
| HEAD | `0bfe180d953875654d72354796770d648623e2ea` |
| Worktree state | Dirty; preceding work preserved and changes uncommitted |
| Release designation | `vha.releaseWorktree=false`; unsigned local test package |
| Application artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-folder-fix/mac-arm64/Theatrum Ex Machina.app` |
| Corresponding media source | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-folder-fix/theatrum-ex-machina-media-source-v2.0.0.tar.xz` |

Exact successful build command:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-folder-fix TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-folder-build.log 2>&1
```

The standard package verifier passed startup, media tools and licensing checks. The prior review app and installed application were preserved. The build used macOS arm64, Node.js `22.23.2` and Electron `42.11.1`; it was not committed, pushed, installed or released.

The corrected native packaged-host regression passed all five checkpoints with:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-folder-fix TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-package:host > tmp/private-folder-packaged-host.log 2>&1
```

The actual packaged main/menu ran in the existing disposable exact-material fixture. Its picker created a new folder beside the source catalogue **after review**, populated it with retained files and an existing **Private hub** folder, then selected that parent. Conversion successfully created **Private hub 2**, preserved the existing contents, displayed the encrypted preview, saved a private note, locked, password reopened with the note intact, restored the ordinary workspace and closed with settings saved. The native picker response is automated; no user catalogue or original video was accessed by this verification.

Six scans completed, with 215 profile, 35 encrypted-hub and 62 ordinary-tree file checks across repeated stages. The encrypted destination is nested in the synthetic ordinary tree for this regression, so its encrypted files are also included in ordinary-tree scans. Synthetic password/private-note markers were absent in UTF-8/UTF-16LE form. Eighteen unpacked files and the original package were verified unchanged; archive SHA-256 was `4c438a32bafcaa76b32e3ee8eaa5d9407154dbafaadf9267f975a86e005dd4b4`. Marker scans retain the earlier memory, transformed-media and OS-trace limitations.

**200 focused tests passed:** 23 conversion-review, 22 conversion, four destination-selection, 66 private-browser, three failure-category, 34 conversion-request, 16 conversion-preload, 20 conversion-UI and twelve package tests. Main/renderer/worker and persistence TypeScript checks, lint, native-driver syntax checks and `git diff --check` passed. Root-run logs include `tmp/private-folder-destination.log`, `tmp/private-folder-browser.log`, `tmp/private-folder-check.log`, `tmp/private-folder-types.log`, `tmp/private-folder-packaging.log`, `tmp/private-folder-root-lint.log`, `tmp/private-conversion-parent-review.log` and `tmp/private-conversion-parent-copy.log`.

This fixes the reproduced selection and source-parent defects. Broader real-world conversion acceptance remains outstanding. Quit the earlier test app before opening the corrected app to avoid launch forwarding to the previous running instance. Touch ID remains deferred.

### First working password-based macOS test build — 23 September 2026

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `codex/private-hubs` |
| HEAD | `0bfe180d953875654d72354796770d648623e2ea` |
| Worktree state | Dirty; existing work and this milestone remain uncommitted |
| Release designation | `vha.releaseWorktree=false`; unsigned local test package |
| Application artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private/mac-arm64/Theatrum Ex Machina.app` |
| Corresponding media source | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private/theatrum-ex-machina-media-source-v2.0.0.tar.xz` |

The macOS File menu now offers **Create private copy…** and **Open private hub…** through main-owned callbacks. No ordinary renderer capability was added. Duplicate clicks share a pending-operation reservation; missing writable catalogues, unavailable operations and password/folder failures receive generic native feedback. Entry remains unavailable on other platforms. Touch ID signing and biometric acceptance are deferred; this review build uses passwords. The [first-build guide](./private-hubs-first-build.md) describes supported operations and the retained unencrypted originals.

The exact build command was:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-first-build.log 2>&1
```

The new test script uses a separate output directory, preserves the earlier test app, explicitly disables publishing and runs the standard package verifier. Ordinary startup, runtime/media payloads and licensing verification passed. No installed app, commit, branch, remote or release was changed. Node.js `22.23.2` and Electron `42.11.1` were used on macOS arm64.

The complete packaged-host acceptance command passed all **five checkpoints**:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-package:host > tmp/private-first-packaged-host.log 2>&1
```

- Loaded the untouched packaged `main.js`, ordinary Angular UI and synthetic catalogue, with the real native File menu registered.
- Invoked **Create private copy…**, completed the actual password/consent form, converted the hub, displayed its encrypted JPEG and saved an encrypted note while the ordinary window was hidden and inert.
- Locked the private gallery, destroyed its isolated session window and restored the ordinary window/menu without changing its files during private use.
- Invoked **Open private hub…**, entered the password in a fresh isolated prompt and verified the saved private note and preview after reopening.
- Locked again, restored the ordinary workspace, closed normally and verified its settings save. No private path was passed to the OS recent-document adapter.

The exact packaged archive, physical UI assets and native resources run in a disposable copied bundle through a test launcher. Unlike the earlier module-level fixture, host mode loads the unmodified production main and invokes its registered MenuItem callbacks; it does not rewrite readiness, inject host exports or bypass the transition. Native pickers select only fixture paths, and recent-document/single-instance adapters are intercepted to avoid touching system state. The original package is checked unchanged before reporting success. Eighteen unpacked files were verified; archive SHA-256 was `3b44826499377c890f90d953d5ece7c5bfc6816ccc5cf3fdbec9da30bdfa78ff`.

Six persistent-storage scans completed: **215 profile-file checks, 35 encrypted-hub-file checks and 17 ordinary-hub-file checks**, including repeated checks between stages. Synthetic password and private-note markers were absent as UTF-8/UTF-16LE bytes. The ordinary directory was hashed before each private period and remained unchanged during those periods. The second ordinary save legitimately rotates its previous catalogue into `.scaena.bak`; the fixture verifies that exact change separately. These scans do not establish secure memory erasure or absence of every OS/transformed-media trace.

**43 focused tests** passed: five native menu, 16 application-host, ten instrumentation and twelve package tests. Main/renderer/worker and persistence TypeScript checks, lint, syntax checks and `git diff --check` passed. The existing host instrumentation now preserves the real platform gate and menu registrations instead of enabling them for a test. Logs are `tmp/private-first-menu.log`, `tmp/private-first-host.log`, `tmp/private-first-instrumentation.log`, `tmp/private-first-packaging.log`, `tmp/private-first-check.log`, `tmp/private-first-types.log` and `tmp/private-first-lint.log`.

This first working test build covers the password-based create/edit/lock/reopen path. Original-video playback/import/relocation in the private gallery, broader platform/OS failure acceptance and performance work remain follow-up items. Real native picker history, hardware input, sleep/lock behavior and signed Touch ID were not established by this run.

### Local macOS test package and packaged private windows — 23 September 2026

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `codex/private-hubs` |
| HEAD | `0bfe180d953875654d72354796770d648623e2ea` |
| Worktree state | Dirty: preceding privacy work and this milestone remain uncommitted |
| Release designation | `vha.releaseWorktree=false`; local unsigned test packaging only |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Application artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test/mac-arm64/Theatrum Ex Machina.app` |
| Corresponding media source | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test/theatrum-ex-machina-media-source-v2.0.0.tar.xz` |

The exact successful build command was:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:test > tmp/private-mac-package-build.log 2>&1
```

The test script explicitly disables publishing and uses the installed Electron distribution. It reuses verified media tools and rebuilds the two native privacy helpers before packaging. Existing runtime/media links resolve only to the other authorized worktree beneath `/Users/sm/Workspace`; those targets were not modified. The full package verifier passed, including ordinary startup of the untouched test app, media tools, architectures and licensing payload. Existing Angular unused-file/CommonJS optimization warnings were nonfatal. No installed application, branch, commit, remote or release was changed.

Actual packaging exposed two defects that source-only checks missed. The main/preload compiler now explicitly emits CommonJS; the previous output mixed ES imports with CommonJS runtime assumptions and failed at packaged startup. The strict private file reader also correctly rejected ASAR virtual file identities. The twelve public private-interface assets and standalone preloads now ship as physical `app.asar.unpacked` files, selected by a fixed main-process resolver. Encrypted catalogue/media records do not use that directory. File identity, link refusal, bounded reads and no-store protocol checks remain intact; no generic archive extraction fallback was added. The package verifier checks unpacked flags, physical files and exact source bytes. Explicit package smoke tests now redirect their profiles, diagnostics, temporary files and downloads into their disposable workspace directory.

The packaged acceptance command passed all **five stages**:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-package:native > tmp/private-packaged-native.log 2>&1
```

1. **Packaged material:** real packaged Electron loaded compiled private modules, the native Touch ID addon and fixed Resources helper paths; an encrypted synthetic hub used the actual native lease.
2. **Static protocols:** all three documents served their HTML/CSS/JavaScript with no-store headers; HEAD requests, forbidden routes and external URLs behaved as expected.
3. **Credential windows:** unlock and conversion screens loaded their narrow bridges in separate nonpersistent sandboxed sessions. Cancellation destroyed each window, drained cleanup and restored the ordinary menu.
4. **Private gallery:** an encrypted JPEG decoded and the synthetic video notes appeared in the isolated gallery. Its disk-cache size remained zero.
5. **Closure:** the gallery was destroyed, the store locked and the menu restored, with zero default-session requests or recent-document writes.

The runner copies the test bundle, verifies its material hashes, and substitutes a launcher only in that disposable copy. It imports the unchanged compiled modules from the original archive renamed `payload.asar`, with identical physical UI companions and native resources. The executable, framework, archive and **18 unpacked files** are checked, and the original test package is reverified before reporting success. It neither changes fuses nor bypasses embedded ASAR integrity; it refuses this fixture method when that integrity fuse is enabled. The archive SHA-256 was `10f77718f9e4e646fd36aca891fc15e008a4cf5e4b264eabbd8323d8df50d0b7`.

Six mandatory persistent-storage scans completed, totaling **93 profile-file checks and 30 encrypted-hub-file checks** across repeated scans. Neither synthetic password nor synthetic note/JPEG-comment markers appeared as UTF-8 or UTF-16LE bytes. Both roots must exist as physical directories and contain scanned files at every checkpoint. These are bounded marker observations, not evidence of secure memory erasure, all transformed media copies, or OS-wide trace absence. Successful synthetic fixtures are removed; failed diagnostic fixtures remain beneath this worktree's `tmp/` directory.

**132 focused tests** passed: 12 package/configuration, 15 UI-path/protocol composition, 13 static protocol, 66 browser lifecycle, 10 Electron security and 16 application-host tests. Main/renderer/worker and persistence TypeScript checks, lint, script syntax checks and `git diff --check` passed. Logs are `tmp/private-packaged-build-config.log`, `tmp/private-ui-paths-tests.log`, `tmp/private-packaged-protocol.log`, `tmp/private-packaged-browser.log`, `tmp/private-packaged-security.log`, `tmp/private-packaged-host.log`, `tmp/private-packaged-check.log`, `tmp/private-ui-paths-types.log` and `tmp/private-packaged-final-lint.log`.

This establishes loading and basic private-window behavior from actual macOS package material, not the untouched app's private entry or full packaged host handoff. The fixture seeds an encrypted hub; it does not submit the conversion form. Touch ID testing loaded the real addon and queried availability only, without Keychain changes or a biometric prompt. Provisioned signed enrollment/unlock/removal, full packaged transitions, native Linux execution and broader fault/OS lifecycle acceptance remain outstanding. `PRIVATE_HUB_UI_READY` remains false and both native entries remain unregistered.

### Private package payload and native-helper paths — 23 September 2026

This milestone uses the same private worktree, branch and commit recorded below, with existing dirty changes preserved and `vha.releaseWorktree=false`. No native helper or application was built, installed or released. Packaging tests created only disposable synthetic ASAR fixtures beneath the worktree's `tmp/` directory.

The package audit found that the builder omitted all private document assets, standalone preloads and native privacy helpers. It also found a development-only lock-helper path and a Git ignore rule hiding the new conversion script. The manifest now lists the three isolated documents and preloads explicitly, includes fixed platform-specific helpers outside ASAR, and retains the conversion script in source control. A builder `beforePack` hook rebuilds helpers before resource copying and checks their binary format, role and architecture. macOS and Linux packaging must run on the native target OS/architecture; Windows packaging includes no unsupported privacy helpers. Existing release-preflight commands and the disabled feature gate are unchanged.

Both lease and Touch ID use one fixed-name resolver: development uses `build/privacy-tools`, packaged main uses `Resources/privacy-tools`. Unknown names, renderer/utility processes, incomplete Electron runtimes, malformed resource roots and paths inside ASAR are refused without a PATH or environment fallback. Package verifiers check the actual archive for exact document/preload bytes and required main modules, reject native acceptance drivers/embedded helper binaries, and check the separate native resources. The unsigned Touch ID gate remains intact.

**64 focused tests** passed: nine package/ASAR tests, nine helper-resolution tests, 14 lease tests, 31 Touch ID tests and the existing Linux packaging configuration test. They cover omitted/tampered assets, missing modules, wrongly embedded binaries, wrong native formats/architectures, symlinked or nonexecutable helpers, compilation failure, cross-target refusal and packaged helper routing. Resolver tests use controlled runtime objects; their lease test runs the existing development helper after asserting the packaged spawn path. Synthetic native headers do not establish that a packaged executable loads. The existing real macOS helper headers were also checked without rebuilding or running a packaged app.

Main/renderer/worker and persistence TypeScript checks, lint, syntax checks and `git diff --check` passed. Logs are `tmp/private-packaging-tests.log`, `tmp/private-helper-paths-current.log`, `tmp/private-helper-lock-current.log`, `tmp/private-helper-touch-id-current.log`, `tmp/private-packaging-linux-config.log`, `tmp/private-packaging-check.log`, `tmp/private-helper-types-current.log` and `tmp/private-packaging-lint.log`. The actual-host native run below passed again after the resolver change. A real test package and packaged private-window/native-helper smoke run, native Linux execution and signed biometric acceptance remain outstanding.

### Private-copy creation through the actual main host — 23 September 2026

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, branch `codex/private-hubs`, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The worktree remains intentionally dirty with preceding privacy work. The existing compiled Angular assets in `tmp/private-transition-angular`, native helper and media tools were reused unchanged. No browser/helper build, application package, install, commit, push or release was performed.

The extended native command passed all **12 stages**, including five new creation stages through actual `main.ts`, its transition singleton, ordinary source monitor/watcher and compiled Angular editor:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-host:native
```

- **Saved review:** pending notes and a row-tag draft were saved before the isolated count-only review appeared. The ordinary window was hidden and inert, its watcher stopped and ordinary admission closed. Concurrent native open/create requests were refused.
- **Late picker cancellation:** the fixture held an admitted destination picker, cancelled the form and confirmed its destruction. Ordinary admission, editing and watching remained paused until the held picker returned a successful selection. That late result created no output. Clean settlement restored the same ordinary catalogue, window, menu and watcher without changing the saved source tree.
- **Creation and activation:** the new destination was created through the real converter, then independently activated through the session. The form was destroyed before the separate private gallery appeared; the saved notes/tag draft and decrypted thumbnail were visible. The ordinary catalogue, previews and original video remained unchanged during private use.
- **Lock and receipt readback:** Lock restored the ordinary workspace and watcher. Reopening the encrypted store independently verified the completion receipt, missing-filmstrip inventory, saved metadata and authenticated activation marker. This destination received no test-injected receipt or activation record.
- **Password reopen and editing:** the normal native opening path reopened the converted hub with its creation password. A new private note was saved and survived encrypted readback after Lock. Full ordinary-tree fingerprints were unchanged, and recorded recent-document requests still contained only the original ordinary catalogue.

The seven earlier stages also passed again, covering ordinary unlock, legacy IPC refusal, real watcher recovery/discovery, close-save failure and Keep Working, deferred ordinary opens during a failed quit, reopening and final catalogue/settings save.

Thirteen scans inspected 456 profile files, 146 encrypted files (including 68 converted-hub files) and 77 ordinary-hub files cumulatively. No private canary or either password appeared in the scanned UTF-8/UTF-16 forms. Converted-hub scans additionally rejected the known plaintext source notes/tag and the complete source JPEG bytes; those values are intentionally allowed in the ordinary profile and source hub. The converted directory and at least one scanned file are required at every checkpoint from creation onward. Private cache size was zero at the review and gallery checkpoints. Results are in `tmp/private-host-creation-native.log`. The final run includes the strengthened plaintext scanning and full-tree preservation checks identified during independent review, and the packaged-helper resolver change.

The eight host-instrumentation tests passed, JavaScript syntax and scoped lint checks passed, and `git diff --check` passed. Logs are `tmp/private-host-creation-instrumentation.log` and `tmp/private-host-creation-lint.log`; lint reported only the existing ESLint configuration deprecation notice. No defect was found in the reviewed host conversion lifecycle; the separate packaging audit and fixes are recorded above.

The main host is compiled in memory with the existing test-only readiness substitution; production entry remains disabled and unregistered. Native dialog answers, recent-document APIs and OS single-instance arbitration remain controlled by the fixture. This verifies the actual application composition with synthetic data, not real permission/picker history, OS sleep/lock, forced crashes, signed Touch ID, other platforms or native cleanup-fault acceptance. Raw scans do not establish memory/OS cache erasure or the absence of transformed copies. Broader failure/reconnection and protected source-operation coverage remain acceptance gates.

### Isolated private-copy creation and verified activation — 23 September 2026

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, branch `codex/private-hubs`, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The worktree remains intentionally dirty with preceding work and these changes. Existing native helpers and media tools were reused; no browser/helper build, application package, install, commit, push or release was performed.

The isolated **Create private copy** screen displays only inventory counts, takes a confirmed password and separate acknowledgements for retained originals and missing previews, and reports bounded progress. Its standalone preload exposes only state, one submission and cancellation. The main-owned native dialog chooses a new destination. Retirement aborts admitted work before draining the request, picker, conversion and browser cleanup; uncertain cleanup retains quarantine. First activation reopens and verifies the completed encrypted receipt and content through the existing session before showing the private gallery. The application adapter captures the authorized writable source, pauses normal work and saves ordinary drafts before review. Opening and creation share admission and the same ordinary restoration path.

The affected headless suites passed **357 tests**, with no failures or skips: 32 conversion-request, 15 conversion-preload, 19 conversion-UI, nine conversion-workspace, 66 browser, 33 opening, 23 application-transition, 20 application-workspace, 16 application-host, eight host-instrumentation, 13 browser-protocol, 30 native-menu, 27 password-request, nine hub-workspace, 27 main-IPC/close and ten Electron-security tests. The preload suite passed again after promptly clearing its submitted argument reference. Main/renderer/worker TypeScript checks, persistence TypeScript checking, lint, JavaScript syntax checks and `git diff --check` passed. Logs are `tmp/private-conversion-integration-final.log`, `tmp/private-conversion-boundaries-final.log`, `tmp/private-conversion-preload-final.log`, `tmp/private-conversion-check-final.log` and `tmp/private-conversion-types-final.log`.

The native command was:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-conversion:native
```

All four stages passed using the actual conversion document, preload, browser, workspace, converter, store, session and gallery:

- **Review:** the isolated window had no ordinary bridge, exposed only counts, displayed missing filmstrips, and started with empty credentials. Controls remained reachable by scrolling at the compact size.
- **Picker cancellation:** both required acknowledgements were enforced. Cancelling the automated native picker destroyed the form, created no destination, preserved the source and restored the ordinary menu.
- **Creation and gallery handoff:** a fresh form session was destroyed before the separate private gallery opened. The encrypted thumbnail decoded, notes were preserved and the ordinary source remained unchanged.
- **Lock and readback:** the gallery was destroyed, the encrypted receipt and content were verified again, the missing-preview inventory and notes were preserved, and the authenticated activation marker was present. The ordinary menu was restored.

Five scans inspected 88 profile files and 18 encrypted files cumulatively, without finding the synthetic private markers or passwords in the scanned UTF-8/UTF-16 forms. Each stage reported zero private cache bytes, default-session requests and recent-document writes. The original plaintext fixture was deliberately outside these scan targets and was independently checked for unchanged content. Results are in `tmp/private-conversion-native.log`. Empty/count-only screenshots `tmp/private-conversion-review.png` and `tmp/private-conversion-small-review.png` were visually inspected; the regular form fits and the compact form scrolls without horizontal overflow.

This standalone harness calls the actual conversion workspace directly with a synthetic source-exclusion guard. Creation through the actual main/Angular save-and-pause transition is covered by the later main-host milestone above. Dialog answers select only owned fixture paths, and recent-document calls are recorded without forwarding to macOS. Real native picker history and permissions, OS sleep/lock, crash cleanup, hardware input, signed Touch ID and supported-platform helper packaging remain unverified. Bounded raw-pattern scans do not prove memory/cache erasure or absence of transformed copies. `PRIVATE_HUB_UI_READY` remains false, and both native opening and creation functions remain unregistered.

### Storage cleanup and conversion inventory review — 23 September 2026

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, branch `codex/private-hubs`, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The worktree remains intentionally dirty with the preceding work and these changes. No application package, browser build, install, commit, push or release was performed.

The store now confirms closure of its read/write/directory-sync descriptors and both streamed directory handles. Failed or timed-out closure immediately revokes keys and new work, remains identity-branded through static create/open and session disposal, and retains a process-local directory quarantine after late settlement. Lease acquisition/release preserves unconfirmed helper or descriptor cleanup separately from safely rejected acquisition. Touch ID availability can no longer hide a storage cleanup failure behind an unavailable result. Repeated session close/unlock cannot reset the failure.

Review found and fixed a startup race: initial header publication and verification now participate in the store queue, so helper loss cannot release the lease or process reservation before startup handles drain. A real-helper-death regression holds that header close and verifies both reservations remain held. Conversion's outer store drain now allows thirty seconds instead of five, accommodating queued file cleanup and the lease's sequential graceful shutdown, forced-termination confirmation and descriptor close. Individual descriptor/iterator deadlines remain five seconds. Fault tests simulate rejected closure and deadline expiry; they do not establish OS cache or memory erasure.

The new `reviewCatalogueForPrivateConversion` API returns frozen counts for referenced videos, available preview files, preview bytes and missing counts by kind. Tests reject source-video metadata access, preview payload reads and filesystem writes during review, and verify owned catalogue buffer wiping. Conversion consumes the exact issued review once and rechecks source content/identities plus writer-exclusion callback and cancellation signal. Missing-preview consent without that proof, forged/cloned reviews, stale inventories, changed lifetimes and replays fail before destination creation. Existing complete-hub foundation callers remain compatible.

The affected suites passed **375 tests**, with no failures or skips: 20 review, 22 conversion, 14 lease, 35 store, 53 session, 27 password-request, 21 media, five catalogue, 37 password-change/session/verification, 39 Touch ID store/session, 37 plaintext export/session, 27 opening, 23 transition and 15 host tests. The conversion suite was rerun after the startup-drain fix and the separate outer timeout change. Main/renderer/worker TypeScript checks, persistence TypeScript checking, lint and `git diff --check` passed. Five existing test-only warnings remain in the broader scoped lint output. Root-run logs are `tmp/private-store-integration-current.log`, `tmp/private-review-conversion-final.log`, `tmp/private-conversion-store-startup-final.log`, `tmp/private-store-check-final.log`, `tmp/private-store-types-final.log` and `tmp/private-store-lint-final.log`. The final lint-only run supersedes a transient test-style failure recorded in the earlier combined check log; it does not bypass any rule.

Run the new review suite separately with:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-hub-conversion-review
```

At this earlier milestone, the isolated conversion interface, native destination selection and main conversion/activation controller were outstanding; the later private-copy milestone above connects and tests them. `PRIVATE_HUB_UI_READY` remains false and the native entries remain unregistered. Signed Touch ID acceptance, broader native failure/reconnection cases and helper packaging remain required before entry is enabled.

### Actual main-host lifecycle and conversion cleanup — 23 September 2026

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, branch `codex/private-hubs`, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The checkout remains intentionally dirty with the preceding uncommitted work and this milestone. The successful production Angular assets at `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-transition-angular` were reused unchanged. No additional browser build, application package, install, commit, push or release was performed.

The native command was:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-host:native
```

Seven stages passed against actual `main.ts`, its private-workspace singleton, startup/catalogue authority, ordinary source monitor and watchers, scan/extraction queues, trusted IPC and close/save handlers. A test-only TypeScript AST compiler changes exactly the literal-false readiness initializer, ordinary preload path and app-assets path in memory, then appends a frozen main-process driver. It rejects a changed gate, registered entry, unexpected path expressions or noncanonical fixture paths. The production source remains disabled and unregistered; the fixture does not add a shipping test flag or renderer capability.

The run verified:

- Actual startup loaded the synthetic normal catalogue and source grants into the compiled Angular application.
- Normal notes/tag drafts were saved before private opening; the normal window was hidden, private data stayed in a separate nonpersistent session and the normal watcher was stopped. An actual legacy minimize IPC request from the ordinary preload was denied while the private window was focused.
- A real synthetic source video added while private did not restart normal work. After Lock, the real monitor/watcher and scan path resumed and exposed the new video in the ordinary gallery.
- Temporarily making the owned normal-hub directory nonwritable caused the actual catalogue-close failure. Choosing **Keep Working** preserved the draft and restored ordinary use.
- A private quit reached the actual settings-write failure handler. While the fixture held its **OK** acknowledgement, a requested second catalogue remained deferred and unauthorized. The trusted close-failure acknowledgement released that request, which then opened normally.
- Another private open/cancel cycle restored normal use, and closing the real normal window persisted the final ordinary catalogue and settings.

Eight scans inspected 287 profile files, 48 encrypted-hub files and 48 ordinary-hub files cumulatively. No private canary/password patterns were found in the scanned UTF-8/UTF-16 forms; private browser cache size was zero at the open checkpoint. Normal Angular asset caching is expected. Results are in `tmp/private-host-native.log`. The synthetic restored-view capture `tmp/private-host-restored-review.png` was inspected for layout; it retained an earlier input frame, so draft/save evidence comes from DOM assertions and the persisted catalogue, not the capture. Review screenshots are excluded from scans. These observations do not establish memory erasure, absence of transformed copies or operating-system cache/metadata privacy.

Native dialog responses select only owned fixture paths. Recent-document APIs are recorded without forwarding to macOS. Single-instance APIs are substituted because the native macOS socket ignores the redirected fixture temporary directory; cross-process arbitration is not tested. The private hub uses a direct synthetic activation marker, so this run does not verify conversion UI or initial receipt acceptance. Real OS permission prompts, sleep/lock events, crashes, hardware IME, platform clipboard behavior and signed Touch ID remain outside this fixture. The tests do not establish release readiness.

Conversion cleanup now confirms owned source descriptors, source/verification iterator returns and `store.lock()` settlement with a five-second deadline per cleanup operation. Identity-branded failures remain sticky through late closure, suppress the completion event, and survive first activation's generic unlock rejection. Session disposal and the outer transition remain failed and ordinary admission stays sealed. The focused regressions passed **169 tests** with no failures or skips: seven instrumentation, 20 conversion, 50 session, 27 opening, 23 transition, 15 host and 27 main-IPC/close tests. `npm run check`, persistence TypeScript checking, scoped lint, JavaScript syntax checks and `git diff --check` also passed. Scoped lint reported no errors and one existing session-test import-type warning. Logs are `tmp/private-host-regressions.log`, `tmp/private-host-check.log`, `tmp/private-host-types.log` and `tmp/private-host-lint.log`.

At this earlier milestone, store-internal descriptor-close failures were not yet fully surfaced by `store.lock()`; the later storage cleanup milestone addresses that propagation. The cleanup deadline still applies only after cleanup is entered, and a stalled read/iterator advance can delay reaching cleanup. Successful promise settlement must not be described as universal descriptor cleanup. `PRIVATE_HUB_UI_READY` remains false and the native entry remains unregistered.

### Actual Angular/native composition — 23 September 2026

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, branch `codex/private-hubs`, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The checkout is intentionally dirty: the earlier filmstrip changes and this integration work are uncommitted. No commit, push, release package or installed-application change is part of this milestone.

The actual Angular browser assets were compiled with:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp node_modules/.bin/ng build --configuration production --base-href ./ --output-path tmp/private-transition-angular
```

The build passed with production AOT, the existing CSP and normal licence extraction settings. Its artifact directory is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-transition-angular`; these are test-only browser assets, not an application package. The log is `tmp/private-transition-angular-build.log`. The build exposed renderer imports of main-process `GLOBALS` through Home and the file-size pipe. Those imports now use the public `APP_VERSION` constant and preload platform metadata; a runtime import-graph test rejects privileged Node and main-storage dependencies from the renderer entry points.

The focused regressions passed **108 tests**: 10 Electron-security, 19 Home-handoff, 22 editor-handoff, 17 application-workspace, 15 application-host and 25 normal-snapshot tests, with no failures or skips. `npm run check`, persistence TypeScript checking, JavaScript syntax checks, scoped lint and `git diff --check` passed. Scoped lint has no errors; the existing Home import/type warnings remain. Logs are `tmp/private-application-security.log`, `tmp/private-application-regressions.log`, `tmp/private-application-check.log`, `tmp/private-application-types.log` and `tmp/private-application-lint.log`.

Run the native check after compiling these assets:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-application:native
```

Eight stages passed using the compiled Angular Home/catalogue editor, production normal preload, production application-workspace factory and saved-document writer, ordinary media protocol, isolated password screen and private gallery. The run verified:

- Normal notes and a row-tag draft were saved through the atomic normal writer before unlock; an outstanding ordinary operation drained before snapshot capture.
- Normal input was inert, the normal window was hidden, and the ordinary media protocol denied previews while private. The private window used a distinct nonpersistent session and exposed neither the normal bridge nor Node.
- Encrypted notes were edited through the actual private form and saved; Lock destroyed the private window and restored the normal window, exact menu and editable normal notes.
- Cancelling unlock restored normal mode after saving the pending ordinary draft.
- Synthetic composition events and invalid tag hierarchy drafts refused entry, retained drafts and left normal editing usable.
- Making the owned synthetic normal-hub directory temporarily nonwritable caused the real atomic writer to refuse the handoff. The previously saved notes and corrected live draft remained intact; after permissions were restored, the subsequent quit/recovery cycle saved that draft.
- An intercepted quit request drained the private prompt, restored normal mode and retried quit once. A main-owned cancellation acknowledgement permitted another open/cancel cycle. Seven pause/resume cycles completed.

Nine scans inspected 304 profile files, 62 encrypted-hub files and 26 ordinary-hub files cumulatively. No private canary or password patterns were found in their UTF-8/UTF-16 forms. Private-session cache size was zero at open and after Lock. Ordinary Angular asset caching is expected; synthetic review screenshots are excluded. These scans do not establish memory erasure, absence of transformed/compressed copies, crash cleanup or OS metadata privacy. Results are in `tmp/private-application-native.log`. The restored ordinary editor screenshot `tmp/private-application-restored-review.png` was visually reviewed.

This harness uses synthetic startup, source pause/resume and media-queue callbacks, native directory selection and an ordinary menu. It does not launch `main.ts`, real watchers or extraction queues, the actual ordinary quit/save dialogue, hardware IME, real OS sleep/lock events, conversion activation or signed Touch ID. Source callback assertions are not evidence of watcher drainage. `PRIVATE_HUB_UI_READY` remains false and the native entry remains unregistered; this is a bounded integration milestone, not complete native application acceptance.

### Encrypted filmstrip viewing — 23 September 2026

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, branch `codex/private-hubs`, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. Preflight found a clean checkout; the filmstrip changes are uncommitted. No native helper or application package was built, and no application was installed or released during this milestone.

The targeted gallery suites passed **260 tests**: 91 request tests, 39 preload tests and 130 UI tests. They cover detail-only filmstrip projection, exact preview URLs, shared image admission, finite retries, cancellation and stale callbacks, draft preservation, credential-operation cleanup, regenerated URLs and editing controls during clean, dirty, saving and conflicting states. `npm run check`, persistence TypeScript checking, scoped JavaScript/TypeScript lint and `git diff --check` passed. Scoped lint has zero errors and the existing test-file `any`/import warnings. The full 1,643-test checkpoint below was not repeated for this change. Logs are `tmp/private-filmstrip-request.log`, `tmp/private-filmstrip-preload.log`, `tmp/private-filmstrip-ui-tests.log`, `tmp/private-filmstrip-check.log` and `tmp/private-filmstrip-types.log`.

`npm run test:private-browser:native` passed in two Electron processes. The actual private gallery decoded a legacy encrypted 96 × 18 synthetic strip only after Show filmstrip, cleared it on hide and selection changes, reported a missing strip, preserved notes drafts and retired the old image before regeneration. Explicit viewing after regeneration decoded the new 768 × 144 strip through a fresh opaque URL. Reopening the gallery left the filmstrip collapsed. The existing lock, encrypted saves, password change, unprotected-copy and synthetic Touch ID flows also passed.

The first native run exposed root scrolling and sticky-footer occlusion in a 600 × 400 window. The details panel now uses its own scroll viewport with fixed navigation and close controls; clean filmstrip viewing hides disabled editing controls, while drafts restore them. The final compact check measured 114 CSS pixels of visible filmstrip and verified the app header, Lock hub, Protection, Hide filmstrip and close controls were visible and reachable. A separate draft check restored an enabled, reachable Save button. The regular and compact screenshots `tmp/private-filmstrip-review.png` and `tmp/private-filmstrip-small-review.png` were visually reviewed. They contain synthetic colours, not user media.

Thirteen scans inspected 241 profile files and 636 encrypted files cumulatively. They found no synthetic text/password markers or registered plaintext preview-byte patterns; reported browser cache sizes and owned TCP/HTTP/WebSocket/UDP probe connections were zero. Original and regenerated filmstrip bytes were included among the scan patterns. The intentionally plaintext source/export fixtures and screenshots were excluded. Results are in `tmp/private-filmstrip-native.log`. These bounded observations do not prove OS/GPU memory erasure, absence of transformed copies or forced-crash cleanup. Converted legacy JPEGs still have no decoded-pixel limit beyond the encoded-byte cap.

`PRIVATE_HUB_UI_READY` remains false and the native entry remains unregistered. Full application transitions, conversion controls, signed real-device Touch ID acceptance, source import/relocation and platform packaging remain outstanding.

### Touch ID integration milestone

The full regression run passed **1,643 tests across 102 test runs**, with zero failures, cancellations or skips. `npm run check`, persistence TypeScript checking, Angular template compilation, JavaScript/scoped lint and `git diff --check` passed. Root scoped lint reported zero errors and 43 warnings in its checked files; the native provider/store scoped checks had no warnings. Logs are `tmp/touch-id-full-tests.log`, `tmp/touch-id-check.log`, `tmp/touch-id-types-final.log`, `tmp/touch-id-angular.log` and `tmp/touch-id-root-lint.log`. The final small UI label adjustment was also checked by the 121-test gallery suite and the final native Electron rerun.

Focused Touch ID suites include 31 provider/native-validation tests, 30 crypto/store tests and nine session tests. The four standalone UI/preload suites passed 185 tests. `npm run test:private-browser:native` passed in two processes with 13 scans, 241 profile files and 626 encrypted files scanned cumulatively; measured cache sizes and owned TCP/HTTP/WebSocket/UDP probe connections remained zero. The synthetic plaintext export and review screenshots remain excluded from private-profile scans. Native results are in `tmp/touchid-native-controls.log` and `tmp/touchid-native-tests.log`.

Reviewed screenshots are `tmp/private-touch-id-unlock-review.png`, `tmp/private-touch-id-protection-review.png` and `tmp/private-touch-id-protection-small-review.png`. The unlock window height is 620 pixels so Touch ID, password entry, Cancel and Unlock all fit. The regular and compact Protection panels scroll with the enrollment/removal controls reachable.

Touch ID now has a main-process native Keychain provider, full-header-bound encrypted-store/session operations, isolated unlock/enrollment/removal controls and exact private IPC bindings. It remains behind the disabled main-app readiness gate. Real biometric acceptance requires a provisioned signed app; the current unsigned development runtime cannot retrieve a real Keychain credential.

The compiled module validates the host identity and entitlements before LocalAuthentication or Keychain use. Adapter tests use an injected native binding; encrypted-store/session tests use an in-memory credential provider. The compiled addon's native tests exercise input validation and rejection of an unsigned/unentitled host. No test enrolls a real fingerprint or reads/writes/deletes a real Keychain item.

The native Electron fixture exercises the actual UI, preload, bridge, store, session and opening coordinator with an explicitly synthetic credential provider. It checks password reauthentication before enrollment, disabling, re-enrollment, cleared credential buffers, prompt destruction and cleanup before biometric-method unlock, catalogue preservation, application-menu restoration and compact layout. This verifies integration, not Apple's biometric or Keychain behavior.

Review corrected two failure paths that treated uncertain native cleanup as ordinary unavailability. A poisoned status query now locks and quarantines its session; a poisoned unlock-capability query retires the prompt and rejects its disposal. A failed fingerprint/enrollment capability does not imply that an earlier Keychain item is absent: the interface retains a removal action and reports unsuccessful deletion honestly. Password changes invalidate the full-header binding even when a different or unsigned identity cannot inspect an old credential.

Development compilation uses `npm run privacy:build`, which builds the advisory-lock helper and runs `node bin/build-touch-id.mjs` on macOS. The Touch ID artifact is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/build/privacy-tools/private-touch-id.node`, built from the dirty `codex/private-hubs` worktree at `de9922a22cf2bee4b5b9456f4dfc03a77ab8ad79`, with the root and fork recorded above. No application was packaged, signed, installed, committed or pushed. See [Touch ID controls and signing acceptance](./private-hubs-touch-id.md).

### Native menu and clipboard controls milestone

The final source snapshot passed **1,536 tests across 99 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, JavaScript syntax checks and `git diff --check` passed. Scoped lint completed with zero errors and 32 warnings in the checked files. Logs are `tmp/private-native-controls-full-tests.log`, `tmp/private-native-controls-check.log`, `tmp/private-native-controls-persistence.log`, `tmp/private-native-controls-angular.log` and `tmp/private-native-controls-scoped-lint.log`.

Focused coverage includes 30 menu-ownership tests, seven native-input tests, 62 browser-lifecycle tests, 48 session tests, 108 gallery UI tests and eight unlock UI tests.

The dedicated password and gallery windows now acquire a restricted application menu before renderer setup. Tests cover exact Menu object/null restoration, overlap refusal, bound actions, stale callbacks, reentrant native adapters, foreign replacement, unreadable menus, ambiguous installation/restoration and permanently branded quarantine. The browser retains that lease through its captured hub-generation drain, including when another component initiates the lock, and refuses ordinary restoration after a late cleanup failure.

DOM regressions cover revealed-password copy/cut/drag prevention, preserved notes, exact credential-only paste targets, disabled/readonly/hidden/inactive/pending controls and continued typing, composition and selection. Native shortcut tests cover macOS, Windows and Linux key classification; these platform-independent unit cases are not native clipboard tests for those other platforms.

Independent review found two cleanup edges beyond the clipboard gap: poisoned menu ownership must remain branded on later acquisition, and an externally initiated hub lock can outlive browser/session cleanup. The first now preserves its permanent failure classification. The second uses a main-only per-generation completion captured while the hub is current, detached before synchronous abort callbacks can reenter locking, and settled from that lock invocation's complete drainage. Browser restoration waits on it without issuing a recursive lock or reading a racy mutable drain field.

The work remains local, uncommitted and behind the disabled private-hub readiness gate. No application packaging, installation, commits or pushes were performed.

### Verified unprotected-copy milestone

The final source snapshot passed **1,466 tests across 96 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, scoped lint, JavaScript syntax checks and `git diff --check` passed. Logs are `tmp/private-copy-full-tests.log`, `tmp/private-copy-check.log`, `tmp/private-copy-persistence-check.log`, `tmp/private-copy-angular.log` and `tmp/private-copy-scoped-lint.log`.

New coverage includes 24 exporter tests, eight read-only password-verification tests and 13 copy-session tests. Gallery coverage now includes 88 request tests, 33 preload tests, 102 UI tests and 49 browser tests. Cases cover byte-preserved catalogue JSON, current generated-set precedence, disabled clips, truly absent legacy previews, corruption and backup-only records, authenticated bounded clip streaming, destination substitution, output readback damage, source fingerprint preservation, native picker cancellation, final publication cancellation and branded descriptor/iterator cleanup failure.

The credential/session tests verify authentication before the picker, shared mutation admission, immediate password-buffer wiping, existing-destination refusal, no late picker or exporter result after revocation, and drainage through locking. Review found that the comparison key from reauthentication needed wiping before the post-authentication filesystem wait; that ordering is fixed and tested. A second regression verifies that an already pending lock rejects a later exporter cleanup failure and permanently prevents reopening that quarantined session. The bridge rechecks cancellation after invoking its trust predicate to prevent a synchronous cancellation callback from opening a picker.

The encrypted source remains authoritative and is not deleted, rewritten or locked by a successful copy. Interrupted output is deliberately retained in the selected new directory. The UI requires explicit acknowledgement, clears the password and checkbox before IPC, preserves unsaved drafts, keeps Cancel copy and Lock reachable, and describes manual/automatic locking and retained plaintext files.

All changes remain uncommitted in the development worktree above, behind `PRIVATE_HUB_UI_READY = false`. The designated production checkout remains clean on `main` at the same HEAD. No commits, pushes, application packaging or installation were performed.

### Authenticated password-change milestone

The final source snapshot passed **1,376 tests across 93 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, JavaScript syntax/scoped lint checks and `git diff --check` passed. Logs are `tmp/private-password-full-tests.log`, `tmp/private-password-check.log`, `tmp/private-password-persistence.log` and `tmp/private-password-angular.log`.

Focused coverage includes 20 password-change storage tests, nine credential/session tests, 70 gallery-request tests, 28 preload tests, 81 gallery UI tests and 48 browser tests. Cases include current-password authentication, unchanged encrypted records/backups, rejecting the old password after replacement, exact new-password reopening, no old-header backup, malformed/accessor/oversized/Unicode input, one credential operation, detached snapshots, synchronous queued-buffer wiping, writer/regeneration interlocks, lock and revocation during queueing/KDF/publication, changed or linked headers, atomic rename and directory-sync failure, and ambiguous late filesystem publication.

Bridge and UI regressions cover a separate fixed credential method, exact live frame/generation ownership, shared pending admission and disposal drainage, payload release, no sensitive response fields, field clearing, mismatched confirmation, incorrect-current-password retries, preserved drafts, composition refusal, playback stop/retry, hiding a pending form and late completion after lock. Independent internal review identified two fixes: the session must lock independently of the window observer, and non-success results need a final authority check after deferred-work adoption. Both are implemented and tested, including throwing/asynchronous observers and reentrant disposal without deadlock.

The designated production checkout remains clean on `main` at the HEAD recorded above. No commits, pushes, application packaging or installation were performed. This milestone remains behind the disabled private-hub readiness gate.

### Automatic-locking and Protection milestone

The final source snapshot passed **1,297 tests across 91 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, JavaScript syntax checks and `git diff --check` passed. Logs are `tmp/private-protection-full-tests.log`, `tmp/private-protection-check.log`, `tmp/private-protection-persistence.log` and `tmp/private-protection-angular.log`. The aggregate was rerun after the final browser-authority fix.

Focused coverage includes 17 encrypted-protection tests, 17 idle-controller tests, 48 browser tests, 48 gallery-request tests, 22 preload tests and 59 gallery UI tests. Cases cover encrypted persistence/reopening, absent settings versus damaged primary/backup records, input snapshots and plaintext-buffer wiping, settings-write admission, revocation during reads/writes, shared pending-operation gates, draft preservation, errors/retries and lock during settings operations. Native input must arrive before the old deadline; policy changes preserve elapsed inactivity. DOM requests cannot renew it. Stale/early timers, clock and scheduler failures, reentrant callbacks and disposal remain retired.

Review found two additional authority edges: a protection read needed a final generation check after leaving the session queue, and a failed browser-owner predicate needed to close the browser rather than only stop its idle controller. Both are fixed. Six browser regressions cover false or throwing owner predicates through timers, native input and requests, including with the timeout Off. Signal-based revocation remains required for immediate notification when no operation or timer observes a changed owner predicate.

The designated production checkout remains clean on `main` at the HEAD recorded above. No commits, pushes, application packaging or installation were performed. This is internal validation of the experimental implementation, not an external security audit or approval to use real private hubs.

### Source access and regeneration milestone

The final snapshot passed **1,233 tests across 89 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, JavaScript syntax checks and `git diff --check` passed. Logs are `tmp/private-source-full-tests.log`, `tmp/private-source-check.log`, `tmp/private-source-persistence.log` and `tmp/private-source-angular.log`. The aggregate was rerun after the native media-refresh fixes. The designated production checkout remained clean on `main` at the HEAD recorded above. No commits, pushes, application packaging or installation were performed.

Focused coverage includes 17 source-access tests, 22 source-capability tests, 23 media-process tests, seven preview-failure tests, six real-generation tests, 42 session tests, 44 gallery-request tests, 19 preload tests, 47 gallery UI tests and 37 browser lifecycle tests. Cases include wrong/disconnected/replaced folders, no filesystem probes before initial selection, cached-grant invalidation, late picker completion, exact frame/revision authority, descriptor closure failures, unreaped child processes, nested iterator cleanup failures and permanently blocked restoration when cleanup is unproven. Confirmed cancellation remains retryable.

Gallery coverage preserves unsaved drafts, prevents concurrent editing/navigation, keeps Cancel and Lock available, refreshes uncertain publication outcomes, retires stale media and restricts opaque URL refresh tokens. The native flow below exercises the production encrypted generation pipeline and the actual renderer. This is internal validation, not an external security audit.

### Encrypted metadata editing milestone

The final snapshot passed **1,168 tests across 88 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, and `git diff --check` passed. Logs are `tmp/private-metadata-full-tests.log`, `tmp/private-metadata-check.log`, `tmp/private-metadata-persistence.log` and `tmp/private-metadata-angular.log`. An initial aggregate run caught an outdated browser-test handler allowlist; that assertion was updated to include the dedicated save channel, then the complete suite passed.

Focused coverage includes 17 atomic metadata tests, 29 gallery-request tests, 13 standalone-preload tests, 32 gallery UI tests and 36 browser lifecycle tests. Storage tests exercise real encrypted persistence and reopening, complete-row revision conflicts, exact selection among duplicate hashes, row reordering, concurrent updates, preservation of unknown/source/preview fields, unchanged legacy tags including duplicates, malformed/oversized input, queue saturation, detached caller arrays, revocation during reads/writes, lock drainage, storage faults and preview-generation interlocks. Synthetic markers, passwords and source paths were absent from the encrypted fixture files.

Bridge tests cover exact window/frame ownership, opaque per-window revisions, rejecting stale saves, copied metadata, cache/search refresh and late-completion suppression. UI tests exercise Save and Discard, retaining drafts after failure, conflict reload, refusing dirty navigation, text-composition guards, read-only oversized metadata, keeping preview playback during refresh and immediate clearing on lock/pagehide. An independent internal review of the main/preload save boundary found no concrete blocker; this is not an external security audit. Native verification of the same assets and encrypted store is recorded below.

### Previous read-only gallery milestone

The final gallery snapshot passed **1,118 tests across 87 test runs** using `npm test`, with zero failures, cancellations or skipped tests. `npm run check`, persistence-test TypeScript, Angular no-emit compilation and `git diff --check` passed. Logs are `tmp/private-gallery-full-tests.log`, `tmp/private-gallery-check.log`, `tmp/private-gallery-persistence.log` and `tmp/private-gallery-angular.log`. Focused checks passed: 18 gallery-request tests, nine standalone-preload tests, 14 gallery UI tests and 36 browser lifecycle tests. Main and preload tests exercise exact owner/frame/generation matching, malformed payloads, display-only projections, bounded data, stale catalogue completions, lock-before-callback invalidation and registration cleanup. UI tests execute the actual gallery JavaScript against a synthetic DOM, covering loading budgets/retries, stale requests and playback, literal metadata, keyboard/focus and clearing before lock.

### Previous host milestone

The final host-integration snapshot passed **1,073 tests across 84 test runs** using `npm test`, with no failures, cancellations or skipped tests. `npm run check` (application/main/worker TypeScript and Angular lint), `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, and `git diff --check` passed. Angular compilation validates the templates and dependency injection; it is not a running application transition.

That host milestone included 15 main-host integration tests, 27 close/quit tests, and 19 production Home handoff tests. The native renderer harness separately passed six stages, detailed below. Aggregate logs are `tmp/private-host-full-tests.log`, `tmp/private-host-check.log`, `tmp/private-host-persistence.log`, and `tmp/private-host-angular.log`.

The host-specific regression tests execute the actual main singleton configuration, opening/closing helpers and source-monitor callbacks with synthetic Electron objects. They cover closed readiness, in-flight normal work, deferred native catalogue requests, progress restoration, failed cleanup, and the quit interval before Keep Working. Close tests bind acknowledgement to the exact main frame and catalogue, reject same-URL navigation and stale dialog completion, and preserve ordinary save/close behavior. The Home regression checks that transient progress is cleared after handback while notes, tags, source associations, watch settings and discovered directories survive.

### Previous renderer milestone

Before the main singleton/close/quit wiring, `npm test` passed **1,031 tests across 83 test runs** with no failures, cancellations or skipped tests. It includes ordinary application regressions, the complete private-hub suite, and the connected editor/IPC handoff.

| Previous renderer milestone coverage | Tests |
| --- | ---: |
| Main-owned saved-document request | 16 |
| Renderer snapshot/freeze/revision adapter | 12 |
| Captured normal snapshot persistence | 25 |
| Application transition ordering, cancellation and quit | 23 |
| Main-native composition factory | 17 |
| Shared mutation lifetime, services and clip playback | 24 |
| Catalogue editor and tag-tray handoff | 22 |
| DOM/IPC handoff boundaries | 9 |
| Production Home/Electron saved-document integration | 18 |
| Private browser lifecycle and restrictions | 32 |
| Private workspace lifecycle | 9 |

Snapshot tests exercise real synthetic atomic writes and backups, offline sources, surviving source associations, removed-source grant revocation, exact media authority, and context changes during a held write. Transition tests cover late picker/save/opening completion, failed private cleanup, window replacement during restoration, concurrent/reentrant quit, and explicit acknowledgement of a cancelled ordinary close. Factory tests combine the real pause, transition, saved request and snapshot modules with mocked Electron objects and private workspaces. Separate renderer tests execute production Home, ElectronService, catalogue editor and mutation services with stubbed Angular decorators/native UI. They exercise complete clean snapshots, pending notes and row tags, composition/native-request/save/close refusal, exact release matching, stale dialogs, late rename responses, failed saves and quarantined restoration failures. These are production-class tests, not a running native app transition.

`npm run check`, `node_modules/.bin/tsc --project tsconfig.persistence-tests.json --noEmit`, `node_modules/.bin/ngc --project src/tsconfig.app.json --noEmit`, and `git diff --check` passed. Angular compilation checks the actual templates and constructor injection. The normal media-toolchain suite passed all 26 cases. Independent code review covered saved proof authority, renderer revision handling, late cancellation, restoration order, retained freeze on cleanup failure, external lifecycle ownership and quit handback. This is not an external security audit.

The earlier pause/drain milestone passed 856 tests, followed by an additional protocol cancellation-rejection test. All of those cases are included in this aggregate. Earlier ordinary-preview and password/browser native observations are retained below and were not rerun for this renderer milestone. Logs for that preceding run are under `tmp/renderer-handoff-full-tests.log`, `tmp/renderer-handoff-check.log`, `tmp/renderer-handoff-angular.log`, and `tmp/renderer-handoff-persistence.log`.

## Native renderer-handoff verification

During the preceding host milestone, `node bin/test-renderer-handoff.mjs` passed in the development checkout and runtime listed above. The registered command is `npm run test:renderer-handoff:native`. The harness compiled the current production renderer lifetime, DOM freeze, IPC lifetime and snapshot coordinator into a small synthetic editor, then ran them in a hidden, sandboxed, context-isolated Electron window with a narrow fixture-only preload. Its generated H.264 clip, UI, profile, caches and diagnostics stayed under the checkout's `tmp/` directory. Successful fixtures were removed. No application package was produced or installed.

| Stage | Observed result |
| --- | --- |
| Editor drafts | Real Chromium text insertion reached the notes model; the tag draft committed before the snapshot; editing remained frozen |
| Frozen input and media | Body and an outside Material-like overlay were inert; beforeinput and keydown events were blocked; real clip playback paused, autoplay was suppressed, a later native play event was stopped, and focus returned after release |
| Deferred native result | Actual main-to-renderer IPC waited through a wrong release nonce; the rename applied after main admission resumed and remained dirty relative to the earlier snapshot |
| Composition and invalid drafts | Synthetic CompositionEvents and an invalid tag draft refused the handoff; partial interaction freezes rolled back and the invalid text remained |
| Pending native request | An outstanding `ipcRenderer.invoke` refused the freeze; its renderer update completed and appeared in the next snapshot |
| Repeat and failed restoration | Repeated handoffs succeeded; a failing deferred callback kept editing inert and quarantined, and a subsequent snapshot request was refused |

This is a real Chromium/IPC test of production coordinators with a synthetic UI and main adapter. It does not exercise the complete Angular Home/private-gallery workflow, hardware IME input, native edit menus, system lock/sleep events or browser/OS cache erasure.

## Native ordinary-preview verification

During the preceding snapshot/transition milestone, `node bin/test-normal-protocol.mjs` passed on the development runtime in the checkout table above. The equivalent registered command is `npm run test:normal-protocol:native`. It launched a synthetic native Electron fixture with media, profiles, caches and diagnostics under the checkout's `tmp/` directory; successful fixtures were removed. It did not package or install the app.

Seven stages passed: native responses, renderer media, unread-body drain, active-read drain, late-fetch drain, renderer cancellation and fresh reopen. Checks covered exact GET bytes and native headers, empty HEAD, exact 64-byte and suffix ranges, JPEG decoding, H.264 MP4 playback, rejecting late delivery after sealing, retaining a delayed native response until cancellation settled, static assets while media admission was sealed, and successful delivery after resuming with a fresh proof.

The real Electron file-fetch baseline omitted Content-Length and returned status 200 for its range response. The wrapper preserved that native behaviour and returned the exact requested bytes; the test did not assume the status/header behaviour of a mocked HTTP server. These results exercise native browser delivery/cancellation, not erasure of browser/OS caches or proof of underlying kernel-handle closure. The complete live Home-to-private-gallery transition is still unverified.

## Native menu and clipboard verification

The final native run passed in two Electron processes, with 12 scans inspecting 221 profile files and 561 encrypted files cumulatively. All measured cache sizes and owned TCP/HTTP/WebSocket/UDP probe connections remained zero. The fixture recorded 22 restricted-menu observations and 11 exact ordinary-menu restorations, including successful held-browser-cleanup and held-external-storage-drain checks. Results are in `tmp/private-native-controls-native.log`.

`npm run test:private-browser:native` exercises the actual production documents, browser capsule, menu lease and native input handler in the existing development Electron runtime. It starts with a synthetic ordinary application menu so the test covers macOS application-menu replacement rather than relying on a window-local menu. The restricted menu is checked for exactly the three custom close/paste/selection actions and Hide/Quit roles. The exact prior Menu object must return only after clean teardown.

The fixture dispatches real native Copy and Cut against selected synthetic notes and revealed/unrevealed password text. A test-only bubbling backstop records whether the production capture handler has already prevented the default, then always prevents default itself. This prevents a broken test from exporting text to the user's clipboard. Native copy/cut and legacy clipboard key combinations must be intercepted before any page key event; cuts preserve the selected draft. Credential and metadata paste policies use synthetic ClipboardEvents, without retrieving clipboard data or invoking real native Paste.

Menu ownership is checked across unlock submission/cancellation, gallery opening, inactivity lock, an emitted system-lock event, password changes, unprotected copying, reopening and restart. Held native `clearData` verifies that restriction persists during browser cleanup. A held catalogue write plus externally invoked hub lock verifies that native browser cleanup alone cannot release the menu while session storage work remains pending. This is an emitted Electron system event, not a physical screen-lock test.

The profile scans still exclude the intentional plaintext export, synthetic source and review screenshots. These bounded checks do not prove absence of transformed data, OS memory erasure, real OS paste behavior, Linux PRIMARY-selection isolation, Windows clipboard history isolation, Services outside the tested menus, hardware shortcuts or the full Angular-to-private transition. The test never reads, preserves, logs or replaces existing clipboard contents.

`tmp/private-unlock-review.png`, `tmp/private-protection-review.png` and `tmp/private-protection-small-review.png` were inspected after adding the password-paste help. Unlock actions fit, regular Protection fits, and the minimum-size panel scrolls while keeping Close and Lock reachable.

## Native unprotected-copy verification

`npm run test:private-browser:native` passed on the runtime above; results are in `tmp/private-copy-native.log`. The actual gallery, standalone preload, fixed IPC, session, encrypted store and exporter were exercised together. Eight metadata/protection methods remain on `privateGallery`; the separate frozen `privateCredentials` surface contains `changePassword`, `createUnprotectedCopy` and `cancelUnprotectedCopy`.

The native flow clears the password and acknowledgement at submission, rejects an incorrect password without opening the destination picker, cancels a picker without creating output, and then creates a new ordinary hub. Its catalogue matches the authenticated source bytes exactly; all 50 thumbnails are present, and the four selected generated previews match the encrypted originals. The encrypted directory fingerprint remains unchanged and the source window stays open. The two-process flow also rechecks saved metadata, generated previews, inactivity settings, changed passwords, playback, isolation and locking.

Twelve scans inspected 221 profile files and 561 encrypted files cumulatively. Synthetic UTF-8/UTF-16 markers, old/new passwords and complete generated preview sequences were absent from these scan targets. Cache sizes and owned TCP/HTTP/WebSocket/UDP probe connections remained zero. The deliberate unprotected-copy destination, synthetic source and review screenshots are excluded from these scans. The tests do not prove memory erasure, absence of compressed/transformed copies, forced-crash cleanup or operating-system traces. Real native picker history, OS permissions, the full Angular transition and supported-platform packaging still require verification.

Normal and 600 × 400 native window layouts were inspected. The panel and scrolled copy button fit inside the viewport. Images are `tmp/private-unprotected-copy-review.png` and `tmp/private-unprotected-copy-small-review.png`. Initial runs required adding the new checkpoint and its correct order to the harness allowlist; native copy verification had succeeded before those harness assertions. A later capture adds a short visible compositor wait so the small-window screenshot reflects the scrolled controls.

## Native password-change verification

`npm run test:private-browser:native` passed with the final password-change implementation; results are in `tmp/private-password-native.log`. It uses the actual gallery form, standalone preload, request handler, session and encrypted store. The gallery still exposes eight metadata/protection methods, with one separate frozen `privateCredentials.changePassword` method. No ordinary bridge, Node API, credential retrieval or key API is present.

The native flow opens Protection, expands the form, rejects mismatched confirmation, clears all three inputs synchronously, retries an incorrect current password, then saves a correct change. Success destroys the private window and drains the workspace to idle. The old password cannot reopen that hub; the new password opens a fresh nonpersistent window and works again in a second Electron process. Notes, tags, regenerated previews and auto-lock settings survive unchanged. `tmp/private-password-change-review.png` was inspected; it shows the empty form and its complete submit button inside the scrollable panel.

The extended run repeats the previous password/opening, media generation/playback, native inactivity-input and isolation checks. Eleven scans inspected 201 profile files and 496 encrypted files cumulatively. The old and new passwords and synthetic UTF-8/UTF-16 markers were absent, as were complete regenerated media byte sequences. Cache size and owned TCP/HTTP/WebSocket/UDP probe connections remained zero. These bounded scans do not prove memory erasure, absence of compressed/transformed copies, forced-crash cleanup, clipboard/menu behavior or operating-system traces. The synthetic original and review screenshots are outside scan targets. Full Angular application transitions and supported-platform packaging remain unverified.

## Previous native automatic-locking verification

`npm run test:private-browser:native` passed with the final automatic-locking implementation; results are in `tmp/private-protection-native.log`. The real gallery reads the default five-minute setting, saves one minute through the dedicated bridge, reopens it, and verifies it again in a second Electron process. The preload exposes eight fixed methods, including protection and setProtection; it has no renderer heartbeat or general activity channel.

The deadline check uses the production controller and native Electron input, with a main-process test clock advanced across the one-minute boundary. Native Shift key events renew the deadline; page-generated keyboard/mouse events and protection reads do not. Once the advanced clock passes the deadline, a request triggers immediate window destruction and confirmed workspace drainage. This tests deadline logic and native input wiring, not a real one-minute wait or every physical input device. Deterministic tests separately cover scheduled expiry, mouse buttons/wheel events, stale/late events and timer failures.

The extended two-process flow also repeats password cancellation, wrong-password handling, paged gallery browsing, encrypted metadata saves, native source selection cancellation, real preview regeneration, playback and process-restart persistence. Eleven scans inspected 198 profile files and 496 encrypted files cumulatively. Reported cache size and owned TCP/HTTP/WebSocket/UDP probe connections were zero; synthetic markers, passwords and complete regenerated media byte sequences were absent from the scan targets. The limitations of these scans remain the same as the earlier verification below.

The Protection panel was checked at the normal size and a 600 × 400 native window. Its bounds remain inside the content viewport, with scrolling available in the smaller panel. Reviewed screenshots are `tmp/private-protection-review.png` and `tmp/private-protection-small-review.png`. The minimum-width header keeps Lock hub on one line. Initial layout runs timed out while waiting for animation frames or capture after resizing/hiding the test window. The harness now inspects a visible gallery, removes the hidden animation-frame wait, and reports a bounded stage name on timeout. Production rendering settings were not changed.

## Previous native source-access and regeneration verification

`npm run test:private-browser:native` passed with the final source-access/regeneration implementation; results are in `tmp/private-source-native.log`. It uses the production gallery, preload, IPC, source-grant controller, captured descriptors, session, encrypted store and bundled FFmpeg. Only the native picker result is automated: it first cancels, then selects the synthetic saved folder. Real macOS permission prompts and picker history remain unverified.

The test regenerated a 256 × 144 thumbnail/poster, a 768 × 144 three-frame filmstrip and an encrypted clip from a synthetic four-second source. The source hash stayed unchanged; generated media excluded its metadata marker. The gallery refreshed without autoplay, explicit playback decoded the regenerated clip, and the generated set and edited notes/tags survived both reopening and a second Electron process. The isolated preload exposed only six methods: list, detail, save, regenerate, cancelRegeneration and lock. Lock destroyed the window and drained the workspace to idle.

Native verification found Chromium reusing decoded media for unchanged URLs despite no-store responses. Poster retirement now precedes the generation request, and main supplies fresh opaque URL tokens when projecting previews. Regression coverage verifies retirement before IPC, rejection of late image callbacks, refreshed playback URLs and recovery after failed generation. An earlier synthetic fixture had a duration inconsistent with its saved frame count; the geometry guard correctly rejected it, and the fixture was corrected.

The final two-process run reported zero cache bytes and zero owned TCP/HTTP/WebSocket/UDP probe connections. Eleven scans inspected 198 profile files and 491 encrypted-hub files cumulatively, with no UTF-8/UTF-16 synthetic markers or passwords. After regeneration, scans also checked for the complete generated JPEG/MP4 byte sequences. These bounded scans do not prove absence of compressed/transformed copies, memory erasure, forced-crash cleanup or OS traces. The intentionally plaintext synthetic original and review screenshots are outside the scan targets.

`tmp/private-gallery-review.png` was inspected for the regenerated preview, Regenerate previews action and completion message, long tag wrapping, notes editor, close control and visible Save/Discard footer. The ordinary Angular application was not launched. Complete normal-to-private application transitions, actual OS permission prompts, native menus and other platforms remain acceptance gates.

## Previous native metadata-editing verification

The extended `test:private-browser:native` harness passed using the production `private-gallery/` assets, dedicated preload, main request binding, encrypted catalogue/media store and private workspace factory. Its 50-video catalogue, JPEGs, MP4 and notes were synthetic. The ordinary Angular application was not launched.

Observed checks included 48-plus-two pagination, title/tag search, selected-card state, decoded encrypted JPEGs, explicit encrypted H.264 MP4 playback, notes/tag saving and hierarchy normalization, refusing a dirty details close, Discard reloading the stored version, UI Lock hub destroying the window and draining to idle, a fresh partition on reopen, external cancellation and incorrect-password refusal. Saved notes and tags were verified both in the reopened gallery and a second Electron process. Unrelated row/source values survived. The page exposed only `list`, `detail`, `save` and `lock`; ordinary/password bridges and Node globals were absent. The synthetic review image at `tmp/private-gallery-review.png` was inspected for visible thumbnails, literal notes/tags, close controls and fixed-position Save/Discard actions while the panel scrolls. That image has since been refreshed for regeneration.

An earlier playback attempt was interrupted by background throttling in the hidden automation window. The harness disables throttling on that test window only; the production browser configuration is unchanged. The metadata milestone's final two-process run passed, with 11 scans inspecting 198 profile files and 461 encrypted-hub files cumulatively. No UTF-8/UTF-16 test markers or passwords were found in those files. Reported cache sizes stayed at zero, and owned TCP/HTTP/WebSocket/UDP probes saw no connections. The command was `npm run test:private-browser:native`; its result is recorded in `tmp/private-metadata-native.log`. These are bounded observations, not proof of OS/GPU memory erasure, forced-crash cleanup or every possible persistent encoding. Full native Angular handoff, OS sleep/lock, native menus, source permissions and other platforms still require verification.

## Earlier native Electron verification

During the preceding password/opening milestone, `npm run test:private-browser:native` passed with the runtime above and the checkout state in the table. It launched two development Electron processes with temporary synthetic windows. Profiles, temporary files, downloads, and test logs were directed beneath this checkout's `tmp/` directory. The harness used the existing privacy helper and bundled media tools; it did not package or install the app. Its empty unlock-screen image is retained at `tmp/private-unlock-review.png` and was visually reviewed for fit and legibility before credential entry.

| Check | Observed result |
| --- | --- |
| Password window | Only submit/cancel methods exposed; no ordinary bridge, Node globals, or layout overflow; masking and Show/Hide states verified |
| Credential handoff | Prompt destroyed before returning the exact password; fresh empty prompt on reopen; Escape cancelled without a credential result |
| Real opening workflow | Password prompt → session authentication → isolated window → decrypted preview succeeded through the composed workspace factory |
| Revocation and incorrect password | Transition abort destroyed the window synchronously and drained to idle; incorrect password returned unavailable with no window and allowed a fresh attempt |
| Actual decrypted image decoding | 32 × 18 JPEG decoded; its private comment marker matched and the response used no-store headers |
| Session identity | Nonpersistent, no storage path, distinct from the default session; a fresh partition on reopen |
| Default session | Zero private requests |
| Browser storage | Local storage, session storage, and IndexedDB exercised; cookies and CacheStorage writes blocked |
| Lock | Window destroyed despite a blocking `beforeunload` handler; hub locked; all cleanup attempts succeeded |
| Reopen and process restart | Empty local/session storage, IndexedDB, CacheStorage, and cookies |
| Browser cache | Zero bytes at every reported checkpoint |
| Persistent profile scan | Eleven scans, 198 cumulative regular-file inspections; no UTF-8/UTF-16 synthetic secret or password markers |
| Network probes | Zero connections to owned TCP, HTTP, WebSocket, and UDP listeners, including WebRTC STUN/TURN attempts |
| Other browser gates | File and HTTP fetches, popups, workers, shared workers, and service workers denied; attempted download cancelled with no saved file |

The first native attempt found a real WebRTC TCP escape despite request interception, offline emulation, and the restricted WebRTC IP policy. Adding and verifying a fixed unusable proxy with localhost bypass disabled closed that route in the final run. The test remains separate from the headless suite so that Electron upgrades can be checked against real browser behaviour.

These are bounded fixture results. Raw marker scans do not detect every encoding or compressed representation and do not prove secure erasure from browser/GPU memory, swap, OS diagnostics, or forced-crash artifacts. That earlier run did not exercise the gallery assets or encrypted clip playback; the new gallery run above covers those. Native system sleep/lock events, Linux and complete live normal-to-private application transitions remain unverified. Sleep/lock/quit handling during the prompt-to-window gap and renderer failures have unit coverage; the native lifecycle checks cover explicit locking, transition revocation, reopening, and clean process restart.

## Verified failure boundaries

- A helper crash invalidates the storage session immediately, while the parent's shared descriptor retains the kernel lock until queued filesystem operations drain. A regression kills the real helper during a suspended publication and confirms a new opener remains blocked.
- Interrupted hard-link publication is repaired only after authenticating a recognized, target-bound alias. Unknown links and damaged records remain untouched.
- Clip replacement uses immutable encrypted generations; range readers remain pinned to one generation and authenticate each chunk before delivery.
- Response cancellation, locking, revoked session authority, and corrupted chunks prevent delivery of unreturned bytes. Responses expose generic failures and private/no-store headers.
- Copy conversion verifies decrypted content against source hashes, rechecks source state, and publishes an encrypted completion receipt last. Cancellation, missing previews, changed sources, and corrupted destinations have explicit outcomes; originals and their backups stay unchanged.
- First session activation verifies the completed conversion; later legitimate edits can reopen using the authenticated activation marker. Cancelled unlocks dispose late stores, stale completions cannot restore access, and teardown observer failures cannot retain keys.
- Outstanding preview response count and memory reservations are bounded before reads. Delivery, cancellation, failure, and locking release reservations once, including repeated cancellation and lock/reopen races.
- The production code paths for catalogue writing, media routing, and legacy IPC are exercised with synthetic fixtures. Private failures cannot write ordinary catalogues or fetch leftover plaintext previews. Legacy settings/export/clipboard/native-open paths are blocked in private mode; normal exports are cancelled if their active session changes during a save dialog.

- Source capabilities reject malformed paths, symbolic links, FIFO substitution, replaced source/root inodes, changed size/timestamps, revoked grants, and excess descriptor admission. Reopened descriptors have independent seek positions.
- Native generation leaves only encrypted preview records in the destination. Source names do not enter child arguments, and synthetic source metadata is absent from generated JPEGs and clips. Images are dimension-checked; video/audio timelines are checked across clip snippet boundaries.
- A source replacement during final manifest staging prevents publication. A late remux failure preserves the previous active set. Explicitly disabling clips suppresses both clip and poster; corrupt manifests and surviving backups prevent fallback.
- A storage failure after more than one chunk of produced data stops and drains nested encoders/remuxers before admitting another job. Caller cancellation and store locking during pending writes wipe owned buffers, close descriptors, and preserve the previous set after reopening. Cancellation after publication reports uncertain completion rather than stale success.
- Prepared and partially consumed clip responses stay pinned to their selected generation across replacement. Missing generated members never fall back to older encrypted preview records.
- Session-owned generation requires an exact authenticated catalogue location, rejects forged or stale capabilities, and derives settings from the catalogue. Saves and additional jobs are refused while generation is active. Reads remain available. Locking aborts and drains generation, and changed screenshot geometry is refused before staging.
- The default persistent protocol cannot invoke private preview delivery. The isolated protocol validates routes and bounded static files, rejects unsafe links and stale generations, and never falls back to a normal filesystem or network fetch.
- Browser setup refuses persistent/default sessions before modifying them, verifies its proxy and entry document before renderer creation, and remains revoked if setup completes after a lock. Teardown attempts all cleanup operations despite individual failures, defers quit through cleanup, and keeps admission blocked if native window destruction fails.
- Credential IPC rejects other windows, subframes, navigation changes, stale lifetimes, malformed Unicode, oversized inputs, and replay. It snapshots authority/callbacks and never returns diagnostics or Electron objects. A reentrant authority callback cannot release a password after aborting the final handoff.
- Opening cancellation waits for late prompts, key derivation, browsers, and storage to drain before reuse. Unknown resource-cleanup outcomes quarantine admission, including during cancellation. A module-private error brand identifies proven-clean browser factory failures without trusting error text.
- Workspace sleep/screen-lock/shutdown observers are installed before prompting and stay active through derivation, browser setup, and disposal. Repeated quit requests remain intercepted while a delayed unlock or storage drain is pending; natural browser closure also retains these observers through full disposal.
- Normal IPC admission closes synchronously. Native dialog results and detached callbacks retain their original authority and cannot become current again after resume. Pending writes and callbacks are awaited rather than treated as complete when their queue is cancelled.
- The application pause proof is main-owned and single-use. Pause waits for all subsystem drains even when one fails. Failed pause/resume never reopens normal IPC, and a failed resume cannot return the old successful pause result.
- Normal source access callbacks, crawlers, native media work, and watcher closure are retained through completion. Old callbacks cannot report a connection or start a watcher for a replaced source or catalogue.
- Ordinary media delivery checks its captured authority before publishing headers or chunks. Drain observes JavaScript fetch/read/cancel settlement, including rejected cancellation; it does not prove native Chromium file-handle closure or browser/OS cache erasure. Native ordinary-protocol cancellation passed the bounded fixture above; complete application transition verification remains outstanding.
- The shared ordinary renderer lifetime blocks persisted service edits, invalidates confirmation epochs, commits row-tag drafts, and records repeated dirty writes. Pending native invokes retain admission through their immediate result consumers. Frozen incoming callbacks are replayed in order; failed callbacks quarantine the editor without retrying partial changes.
- The DOM handoff refuses unfinished composition, blocks the entire body and overlay inputs, pauses ordinary previews and suppresses delayed clip playback. The synthetic native renderer fixture verifies browser input/media behavior, and the compiled Angular fixture verifies real Home composition/draft refusal and private-window restoration. Hardware IME, full-host native edit menus and the complete application lifecycle still require acceptance tests.
- The saved-document exchange accepts only one nonce-bound response from the original live main frame. Cancellation waits for a pending write. An issued proof remains held across later private cancellation until the transition explicitly releases it. Renderer revision checks preserve late unsaved edits.
- The concrete snapshot writer captures the normal destination and authority after pause, validates the entire writable document, and never substitutes a new target on failure. Changed source/media authority or a replaced catalogue prevents late authority publication.
- Renderer release now follows successful main admission. A failed release send re-seals normal work and prevents a quit retry or another private opening; window-restore failure never sends the release.
- External private lifecycle mode requires a revocation signal and suppresses autonomous browser/workspace quit retries. The parent transition observes system/window events before native selection and retains its observers and normal freeze when private disposal fails.
- Normal restoration rechecks the original window/frame and pause proof after the native show operation. Quit retries only after clean disposal and normal restoration; a main-owned acknowledgement of Keep Working may restore future private admission without replaying an older quit request.

The normal close guard, trusted close-cancel acknowledgement, deferred catalogue opens, ordinary progress/source restoration, private-copy creation and verified activation, private notes/tag editing, per-video regeneration with session-only folder grants, encrypted automatic-lock settings, authenticated password changes and verified unprotected copies are connected behind the disabled readiness gate. Their regression and compilation checks are recorded above. The compiled Angular/private-window composition and actual main host now have bounded native coverage, including private-copy creation, late-picker cancellation, real watcher recovery and close/save handlers, with test-only entry admission and controlled OS adapters. Broader main-host failure/reconnection and native cleanup-fault coverage, real OS permission prompts, source import/relocation and other protected preview operations, real Touch ID authentication in a provisioned signed build, broader native cache/crash verification, and native-helper packaging remain integration gates. Native picker history, the complete application menu handoff, real OS paste and other platforms' selection/clipboard behavior still need review. The tests do not establish that the complete application is ready to handle private hubs.

At the end of the Touch ID milestone, the production checkout `/Users/sm/Workspace/Theatrum-Ex-Machina` was confirmed clean on `main` at the same HEAD and origin, with `vha.releaseWorktree=true`. Current work remains in the development checkout; no commits, pushes, releases or installed-application changes are part of this milestone. See [the design](./private-hubs.md) and [live renderer integration checklist](./private-hubs-renderer-integration.md) for the work required before enabling private hubs.
