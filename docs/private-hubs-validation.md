# Private-hub development validation — updated 8 October 2026

This record covers experimental storage, generation, browser isolation, the dedicated password/opening and private-copy workflows, the normal-application pause boundary, the saved-document/application transition adapters, the connected ordinary renderer safeguards, the main host lifecycle integration, and the private gallery with collections and sorting, encrypted notes/tag/rating editing, optional encrypted playback history and metric resets, isolated original-video playback, native source selection, session source-folder connections, saved-location changes and read-only saved-file checks, manual selected-video batch import, reviewed source-folder discovery, saved source-folder addition, per-video encrypted preview regeneration and single-location technical metadata refresh, custom JPEG and static PNG thumbnail import, encrypted automatic-lock settings, authenticated password changes, verified unprotected copies, and native menu/clipboard controls. It is not an application release. The latest macOS development build enables native File menu entry for the password workflow; earlier milestones below describe its previously disabled state. All published verification results below use synthetic catalogue and media fixtures. Touch ID work is deferred at the user's request.

## Earlier checkout and native helper build

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
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

### Catalogue-recovery storage foundation — 8 October 2026

The main process now has an explicit, reviewed transaction for restoring a missing, unauthenticatable or schema-invalid catalogue from its authenticated backup. This stage adds the storage transaction and catalogue adapter only. It does not connect recovery to opening, IPC or the gallery, and no new application package was built.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; prior work preserved; this stage is uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2` |

A valid primary returns without confirmation or writes. A recoverable backup must authenticate and satisfy the same catalogue schema and active-video hash limits as normal opening. Recovery requires an existing valid activation marker and current protection policy; it never creates activation, recovers policy from an older backup or treats backup-only policy as default settings. A narrow protection-parser extraction keeps ordinary settings validation unchanged. The confirmation receives a frozen video count without catalogue text or source paths. Exact primary, backup and guard identities and bytes are checked before and after confirmation and again after staging sync. The store queue and native lease remain held until the review drains; callbacks must not await queued same-store operations.

Before replacement, any damaged primary is saved in a new authenticated encrypted evidence file with an opaque random name. Tests decrypt the evidence and compare its metadata and raw payload against the exact original, including accidental plaintext and empty-file cases. The backup stays unchanged. Oversized evidence is refused before confirmation, including an actual 256 MiB sparse damaged-file case. Permission, submitted-read, link, header and cleanup failures are not treated as catalogue corruption. Owned decrypted record buffers are cleared before confirmation; the unlocked store key remains live until lock. Errors after recovery writing starts lock the store, and unconfirmed cleanup retains process quarantine.

**234 targeted tests passed**, with no failures, skips or cancellations:

| Command | Tests | Evidence under `tmp/private-catalogue-recovery-stage` |
| --- | ---: | --- |
| `npm run test:private-hub-record-recovery` | 59 | `store-recovery.log` |
| `node_modules/.bin/ts-node --preferTsExts --project tsconfig.persistence-tests.json node/private-catalogue-recovery.test.ts` | 27 | `adapter.log` |
| `npm run test:private-hub-protection` | 21 | Tool output summarized in `adapter-results.json` |
| `npm run test:private-catalogue-recovery-interruption` | 2 | `interruption.log` |
| `npm run test:private-hub-store` | 35 | `store-regression.log` |
| `npm run test:private-hub-session` | 53 | `session-regression.log` |
| `npm run test:private-hub-password-resume` | 37 | `password-resume-regression.log` |

The two process-interruption cases kill an owned writer immediately before and after the real primary rename, after the encrypted evidence has been published. A competing opener is refused while the writer holds its lease. Tests wait for both writer closure and its captured native helper's exit before reopening. Before replacement, the damaged primary and backup survive and explicit retry succeeds; after replacement, the restored primary opens and retry does not offer another recovery. Earlier evidence, backup and orphan staging files remain unchanged. Fixture file scans and zero child output found no configured synthetic password or catalogue canary in UTF-8 or UTF-16LE. This tests local process termination, including a point before directory sync; it does not establish power-loss durability, GUI cancellation, packaged application recovery, Linux execution or absence of OS diagnostic/swap copies.

`npm run check`, the full persistence-test TypeScript check, child-driver syntax and `git diff --check` passed. The three new suites are registered in `test:private-hubs`. The full private-hub suite was not rerun. Source files and results are local; no commit, push, promotion, installation or packaging was performed. User-facing integration still needs an owned confirmation during opening and an explanation that catalogue recovery can roll back membership and metadata while preview records and protection settings remain current.

### Local password-recovery test package — 8 October 2026

A new unsigned Apple Silicon development app includes the current JPEG/PNG thumbnail work, failure handling and explicit interrupted-password recovery. Earlier test packages remain in place. This package was built locally and has not been installed, published or promoted.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; prior uncommitted implementation included and preserved |
| Release designation | `vha.releaseWorktree=false` |
| Target | macOS arm64, unsigned, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-password-recovery/mac-arm64/Theatrum Ex Machina.app` |
| ASAR SHA-256 | `71afb1b1fab857af273518b749a3198f85f67d3309d2604c1b4bd58a458388d8` |

Exact build command, run from the repository root:

```sh
test ! -e release-test-private-password-recovery && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-password-recovery TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-password-recovery-build/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-password-recovery-build/build.log 2>&1
```

The build and its packaged runtime/startup, media-tool and licensing checks passed. The existing Electron runtime resolves beneath `/Users/sm/Workspace`; media and privacy helpers are local to this checkout. Build caches and temporary files were directed into the privacy checkout. No installed application was changed. Angular reported unused-compilation/CommonJS optimization warnings without failing the build.

Independent package inspection found **116 application-owned compiled modules, main/preload and private UI files byte-identical to the workspace at packaging time**. All password-recovery entry points were present. Test sources, node test files and every node `.cjs` driver—including the process-kill fixtures—were absent. Physical private assets and native helper architectures passed verification. Details are in `tmp/private-password-recovery-build/package-source-verification.json`.

The actual packaged-host fixture was extended through the current main process’s native menu entries, DOM, preload, IPC and store. It passed **seven checkpoints**: ordinary startup, conversion, ordinary restoration, private reopen, recovery review, confirmed recovery/reopen, and orderly close/settings save. It checked both incorrect credentials before prompting, Cancel-default native confirmation, cancellation with byte-identical files, exact staging inode adoption, unchanged encrypted records, independent private locking, old-password rejection and new-password reopening with saved notes and decoded previews. Ordinary actions stayed paused during private work and restored afterward. The native confirmation adapter inspected the dialog options and supplied responses; this does not claim manual system-sheet interaction.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-password-recovery TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-password-recovery-build/temp npm run test:private-package:host > tmp/private-password-recovery-build/packaged-host.log 2>&1
```

Eight scans performed **283 profile-file, 50 encrypted-hub and 87 ordinary-hub checks** for the configured synthetic secrets. Private disk-cache size remained zero. The wrapper verified **18 unpacked files** and preserved the original packaged ASAR/resources. These checks concern the isolated synthetic fixture, not personal hubs, OS diagnostics, swap or arbitrary transformed data. Ten instrumentation tests and syntax/whitespace checks passed; the production implementation was already covered by the focused and native results in the next section and did not change during this packaging stage.

The package retains the existing unsigned test configuration. This is not signing, notarization, Linux or Touch ID acceptance. `tmp/private-password-recovery-build/results.json` records the build identity and packaged-host results. The [review directions](./private-hubs-first-build.md#local-test-package) now point to this new app. No commit or push was performed.

### Finish an interrupted password change — 8 October 2026

The gallery now provides **Protection → Change password → Finish interrupted password change**. Enter the password that currently opens the hub and the intended new password from the interrupted attempt. Storage authenticates both before a native confirmation with Cancel selected by default. Normal password changes continue to refuse unexplained credential files; recovery is a separate explicit action.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; prior changes preserved; recovery implementation is uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |

Recovery accepts exactly one complete regular staging file with the expected opaque suffix. The saved and staged envelopes must authenticate to the same active hub and data key. After confirmation the store rechecks namespace, identity and content, syncs the verified staging inode and atomically renames it onto the active header. It verifies the resulting file and syncs the directory before success. No old-header backup is created. Encrypted records are not rewritten. Unknown siblings, multiple candidates, links, foreign keys/hubs and malformed data are refused and retained. Cancellation is read-only. Ambiguous publication locks the session; unconfirmed cleanup preserves quarantine.

The handler shares credential admission, immediate revocation and disposal drainage with ordinary password changes. Native confirmation cannot outlive that authority and publish a late result. Successful recovery invalidates IPC and independently locks the session and browser. The renderer clears masked fields before invocation, keeps draft/composition/focus guards, and displays fixed statuses only. Ordinary form submission does not implicitly invoke recovery.

**1,096 focused tests passed**, with no failures, cancellations or skips:

| Command | Tests | Log in `tmp/private-password-resume-stage` |
| --- | ---: | --- |
| `npm run test:private-hub-password-resume` | 37 | `store.log` |
| `npm run test:private-hub-password-change` | 20 | `password-change.log` |
| `npm run test:private-hub-store` | 35 | `store-regression.log` |
| `npm run test:private-password-recovery-session` | 6 | `session-integration.log` |
| `npm run test:private-hub-password-session` | 9 | `password-session-regression.log` |
| `npm run test:private-gallery-request` | 423 | `request-integration.log` |
| `npm run test:private-gallery-preload` | 102 | `preload-integration.log` |
| `npm run test:private-hub-browser` | 100 | `browser-integration.log` |
| `npm run test:private-gallery-ui` | 362 | `ui.log` |
| `npm run test:private-password-interruption` | 2 | `interruptions.log` |

Storage cases cover wrong passwords, absent/ambiguous/corrupt/linked/foreign candidates, substitutions during confirmation, lock and cancellation, key wiping, staging sync failure, uncertain close, rename/directory-sync failures and the existing Touch ID removal policy through a synthetic provider. The actual killed-writer test now also resumes its real orphan, verifies exact staged-header adoption, confirms other bytes are unchanged and reopens with the replacement password.

The native Electron run passed **16 checkpoints** across two processes. The new recovery checkpoint checked a separate synthetic encrypted copy: wrong credentials did not prompt, Cancel preserved every file, confirmed recovery adopted the staged inode, encrypted records remained byte-identical, the old password failed and the new password reopened in a fresh nonpersistent session. Its control remained fully reachable at 600 × 400. The original synthetic hub remained unchanged. The native dialog adapter verified message/buttons and Cancel defaults and supplied decline/accept responses; it does not test a physical click in the system sheet.

Eighteen scans made **344 profile-file and 2,584 encrypted-file checks**. Configured synthetic markers were absent, the private cache remained empty, and network connection/HTTP/WebSocket/UDP counters were all zero. These observations concern the fixture roots and specified markers, not universal absence from memory, swap or OS diagnostics.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-password-resume-stage/temp npm run test:private-browser:native > tmp/private-password-resume-stage/native-browser.log 2>&1
npm run check > tmp/private-password-resume-stage/check.log 2>&1
```

Component filesystem tests used the same `TMPDIR`. TypeScript, lint, JavaScript syntax and whitespace checks passed; `results.json` records the aggregate. Independent store, integration and UI reviews found no blocking issue.

This does not recover forgotten passwords or damaged/missing primary headers, handle multiple ambiguous credential files, revoke earlier saved copies, or establish power-loss durability. Native Linux and provisioned Touch ID remain unverified. User directions now describe the explicit recovery action and its limits. No application package was built or installed, and no commit, push or promotion was performed. Earlier packaged test artifacts do not include this new action.

### Password-change interruption — 8 October 2026

`npm run test:private-password-interruption` adds two real writer-process termination cases to the private-hub suite. A test-only child receives synthetic credentials over IPC and calls the production `PrivateHubStore.changePassword`. Filesystem wrappers stop immediately before the header rename or after the actual rename returns, before the store adopts the new header and syncs the directory. No production hook or implementation change was added.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; prior work preserved; this stage is uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2` |

The parent confirms a competing opener is refused, sends `SIGKILL` only to its owned writer child, then waits for its close event and the observed native lease helper’s disappearance. The saved synthetic catalogue and storage-level preview record each have an authenticated backup.

| Interrupted point | Password accepted after reopening | Additional result |
| --- | --- | --- |
| Before header rename | Previous password; replacement rejected | Encrypted staged header remains; another password change is refused without modifying stored files |
| After header rename, before directory sync | New password; previous rejected | No staged header or old-password header backup remains; a subsequent password change succeeds |

Both cases retained the encrypted catalogue, preview record and their backups byte for byte. Authenticated content matched after reopening, and an ordinary catalogue save survived another reopen. Wrong-password attempts were read-only. The pre-rename orphan was neither promoted nor removed. The post-rename case also completed a further password change and reopened with that credential. The child emitted no stdout/stderr; the specified synthetic credentials and catalogue marker were absent from scanned hub files in UTF-8 and UTF-16LE form.

The targeted result was **39 passing tests**, none failed, cancelled or skipped:

| Command | Tests | Log in `tmp/private-password-interruption-stage` |
| --- | ---: | --- |
| `npm run test:private-password-interruption` | 2 | `native-password-tests.log` |
| `npm run test:private-hub-password-change` | 20 | `change.log` |
| `npm run test:private-hub-password-session` | 9 | `session.log` |
| `npm run test:private-hub-password-verification` | 8 | `verification.log` |

All filesystem tests used `TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-password-interruption-stage/temp`. TypeScript, lint and whitespace checks passed. Code-check output is in `check.log`; `results.json` records the aggregate. Independent production-code, fixture and user-guidance review found no blocking issue.

The two interruption points use a fully written, synced staged header. They do not establish incomplete-write behavior, power-loss durability, packaged whole-app crash recovery, native Linux behavior, Touch ID behavior, or image/video decoding. Preview payloads in this fixture are synthetic record bytes. Marker scans cover the fixture hub only, not swap, diagnostics or transformed data elsewhere. The current app cannot reconcile an orphaned credential header, and tests deliberately preserve it rather than bypass that restriction.

User directions now explain changing a password, checking which password survived an interruption, and retaining the complete hub folder. No application was built, installed, committed, pushed or promoted.

### Encrypted save interruption — 8 October 2026

`npm run test:private-save-interruption` adds four real writer-process termination cases to the private-hub suite. The test child uses the production encrypted catalogue writer, store and native lease. Test-only filesystem wrappers pause immediately before or after a real rename; no production interruption hooks were added. Fixtures and redirected temporary files stay beneath this checkout.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; earlier changes preserved; this stage is uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2` |

Each case starts with saved catalogue B and backup A, then attempts C. The parent waits for the selected filesystem boundary, confirms a competing opener is refused, and sends `SIGKILL` only to its own writer child. It waits for the writer’s `close` event and the observed lock helper’s disappearance before reopening.

| Interrupted point | Authenticated primary after reopen | Authenticated backup after reopen |
| --- | --- | --- |
| Before backup rename | B | A |
| After backup rename | B | B |
| Before primary rename | B | B |
| After primary rename, before directory sync | C | B |

All four outcomes matched. Independent staging files and an unrelated fixture file were retained byte for byte; reopening neither promoted nor removed them. Saving catalogue D then reopening succeeded in every case, with the preceding primary preserved as its backup. Synthetic password and catalogue markers were absent from scanned hub files in UTF-8 and UTF-16LE form. Credentials and catalogue data travel to the child over IPC, not command arguments, and the writer produced no stdout/stderr output.

The targeted result was **106 passing tests**, none failed, cancelled or skipped:

| Command | Tests | Log in `tmp/private-save-interruption-stage` |
| --- | ---: | --- |
| `npm run test:private-save-interruption` | 4 | `native-save-tests.log` |
| `npm run test:private-hub-store` | 35 | `store.log` |
| `npm run test:private-hub-lock` | 14 | `lease.log` |
| `npm run test:private-hub-session` | 53 | `session.log` |

All test commands used `TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-save-interruption-stage/temp`. TypeScript, lint and whitespace checks passed; `check.log` records the code checks and `results.json` contains the aggregate. Independent storage and fixture review found no blocking issue.

This covers process termination while replacing a catalogue on the tested local filesystem. It does not simulate power loss, storage-device failure, password-header interruption, or termination of the packaged app. Native Linux execution remains unverified; unsupported-platform cases are skipped. Exact marker scans do not establish absence of transformed data, swap or OS diagnostics. Existing authenticated-backup recovery tests remain separate, and the gallery does not yet expose damaged-catalogue recovery.

No production defect was found and no application implementation changed. User directions now explain uncertain save completion and retaining the complete encrypted folder after an opening failure. No app was built, installed, committed, pushed or promoted.

### Native decoder interruption — 8 October 2026

`npm run test:private-decoder-failure` now exercises actual bundled media processes against small synthetic source files and a real encrypted store. Six cases interrupt FFprobe, the thumbnail decoder, the filmstrip assembler with a live nested frame decoder, the clip remuxer with a live nested encoder, and custom PNG/JPEG thumbnail replacement. The new suite is included in `test:private-hubs`.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; prior JPEG/PNG and renderer-failure work preserved; this stage is uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, bundled FFmpeg/FFprobe `8.1.2` |

The fixture observes real child handles returned by the production spawn call. It suspends the selected child to hold a deterministic interruption point, confirms a second job is refused, and sends `SIGKILL` only to that owned child. For nested assembly, a live nested child is also suspended; production cleanup must terminate it through SIGTERM/SIGKILL. Tests require every real child `close` event, closed source FileHandles and invalid inherited parent descriptors before operation rejection returns. Test teardown runs afterward and cannot satisfy those assertions on production's behalf.

All six cases preserved the bytes of existing encrypted records, including the catalogue, active preview-set record and custom-thumbnail override. Decrypted thumbnails, filmstrips, posters and clips still matched their prior contents. Original video/image files were unchanged, and the test roots gained no readable intermediate media files. The stored source-name/notes canary was absent from inspected encrypted-directory files. The hub reopened successfully and a subsequent generation or thumbnail replacement succeeded with the same process-local admission state. Observed PNG stdin copies were zeroed after failure. Errors contained the fixed public message rather than native diagnostics or source paths.

The targeted result was **49 passing tests**, with none failed, cancelled or skipped on macOS:

| Command | Tests | Log in `tmp/private-decoder-failure-stage` |
| --- | ---: | --- |
| `npm run test:private-decoder-failure` | 6 | `native-process-tests.log` |
| `npm run test:private-media-process` | 24 | `media-process.log` |
| `npm run test:private-hub-preview-failure` | 7 | `preview-failure.log` |
| `npm run test:private-custom-thumbnail-session` | 12 | `thumbnail-session.log` |

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-decoder-failure-stage/temp npm run test:private-decoder-failure > tmp/private-decoder-failure-stage/native-process-tests.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-decoder-failure-stage/temp npm run test:private-media-process > tmp/private-decoder-failure-stage/media-process.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-decoder-failure-stage/temp npm run test:private-hub-preview-failure > tmp/private-decoder-failure-stage/preview-failure.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-decoder-failure-stage/temp npm run test:private-custom-thumbnail-session > tmp/private-decoder-failure-stage/thumbnail-session.log 2>&1
npm run check > tmp/private-decoder-failure-stage/check.log 2>&1
```

TypeScript, lint and whitespace checks passed. Independent code and fixture reviews found no blocking issue.

The clip-remux interruption occurs before its first output; it does not establish native failure behavior after provisional output. The PNG case observes an actual input write and its cleared owned copy, without forcing pipe backpressure. Mocked fault tests retain coverage for those precise handoffs, delayed encrypted writes and unconfirmed cleanup. SIGKILL is an external interruption, not malformed-input crash testing. These backend tests do not exercise GUI error handling, whole-app abrupt termination, OS diagnostic retention or native decoder memory erasure. POSIX signal cases are skipped on Windows; native Linux execution remains unverified.

No production defect was found, and no application implementation changed during this stage. No new app was built, installed, committed, pushed or promoted.

### Private renderer failure acceptance — 8 October 2026

The packaged-host fixture now provides `npm run test:private-package:crash`. It terminates a real private renderer during unsent password entry, with an unsaved notes draft after encrypted image decoding, and while native source selection is pending. Each termination uses `SIGKILL` only after checking the live private renderer PID differs from main and every other live WebContents. This tests unexpected renderer death, not a main-process crash, decoder crash, machine power failure or operating-system crash-report generation.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; existing JPEG/PNG work and this acceptance stage are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Existing tested artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-png-thumbnail/mac-arm64/Theatrum Ex Machina.app` |

The production failure handlers required no change. This stage adds tests and review directions. Thirty-two packaged implementation files, including main, the browser, protocol and workspace transition, matched the current workspace byte for byte. The unchanged ASAR SHA-256 is `9601a293ca39c93d7ada95aa4eec7c4bfac38b4512528e29e2a8be17e2a4316f`; details are in `tmp/private-renderer-failure-stage/package-source-verification.json`. No new app was built or installed.

The native run passed **nine checkpoints**. Within the renderer-death event, it observed removal of the password-cancel or gallery-lock listener while ordinary work remained paused and the restricted menu stayed active. The dead window was destroyed. A held source picker prevented ordinary restoration until its promise settled; the returned file-path getter was never read. The encrypted files remained unchanged during those failures. Fresh password entry reopened saved notes in new nonpersistent sessions, without retaining unsaved drafts or a source grant. The ordinary window and menus recovered afterward, and normal close saved settings without adding a private recent-document entry.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-png-thumbnail TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-renderer-failure-stage/temp npm run test:private-package:crash > tmp/private-renderer-failure-stage/packaged-crash-final.log 2>&1
```

Ten scans performed **351 profile-file, 63 encrypted-hub and 110 ordinary-hub checks**. The synthetic password and saved/unsaved note markers were absent from those targets in UTF-8 and UTF-16 form. Private disk-cache size was zero; the redirected fixture crash directory stayed empty. Eighteen unpacked files and the original package identity were verified. These observations do not establish absence of transformed data, OS diagnostics, swap or decoded-memory remnants outside the scanned fixture roots.

Image decoding uses the production image route and a fresh cache key. An initial fixture probe used `fetch`, which the gallery's `connect-src 'none'` policy correctly rejected; the probe was corrected to use `Image.decode()` without changing that policy. Unowned main-process `session.fetch` probes are denied both before and after renderer death and again after reopening. They are supplementary isolation observations, not independent proof of revoking a previously authorized request. Broader IPC retirement and media response revocation are covered by the component tests.

Twelve new browser tests cover renderer death, unresponsiveness and direct destruction during pending source/thumbnail selection, stale requests, separate picker/storage drainage, late credential submission, preload failure and failed native destruction. The complete targeted results were **178 passing tests**, none skipped or cancelled:

| Command | Tests | Log in `tmp/private-renderer-failure-stage` |
| --- | ---: | --- |
| `npm run test:private-hub-browser` | 99 | `browser.log` |
| `npm run test:private-browser-protocol` | 17 | `protocol.log` |
| `npm run test:private-application-transition` | 23 | `transition.log` |
| `npm run test:private-hub-workspace` | 9 | `workspace.log` |
| `npm run test:private-native-menu` | 30 | `native-menu.log` |

All commands ran with `TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-renderer-failure-stage/temp`. JavaScript syntax and whitespace checks passed. Unit tests establish synchronous generation/IPC revocation and failed-cleanup quarantine; the native fixture observes the production host without substituting its lifecycle handlers. Native file-picker answers and system recent-document/single-instance adapters remain controlled by the fixture.

The existing `--host` acceptance path also passed all five checkpoints. Six scans checked 215 profile, 35 encrypted-hub and 62 ordinary-hub files. It was run separately using:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-png-thumbnail TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-renderer-failure-stage/temp npm run test:private-package:host > tmp/private-renderer-failure-stage/packaged-host.log 2>&1
```

No production promotion, commit, push, release or installed-application replacement was performed. Whole-app abrupt termination, in-flight encrypted publication/decoder failures and OS diagnostic behavior still need native acceptance.

### Protected custom PNG thumbnails — 7 October 2026

**Choose thumbnail** now accepts JPEG and static PNG. Transparent pixels are composited over black before resizing, and the result remains a metadata-stripped encrypted JPEG. The exact-file picker, source identity checks, shared preview admission, cancellation, locking and encrypted publication protections are retained. The selected image is never modified, and the renderer receives no filesystem path.

PNG admission validates the signature, IHDR, dimensions, color/depth combinations, every chunk CRC, ordering and complete IEND. Limits are 32 MiB, 16,384 pixels per side, 32 million pixels and 4,096 chunks. APNG and unknown critical chunks are refused. Ancillary metadata, including compressed text and color profiles, is removed before native decoding. Capability reads are bounded to 256 KiB; sanitized input reaches the decoder through a memory pipe. No plaintext intermediate file is created. Embedded color profiles are discarded, so color-managed images may look different.

Pixel tests identified a native decoder issue with transparency in 1-, 2- and 4-bit grayscale PNGs. Those inputs are normalized to equivalent grayscale palettes in memory while retaining their compressed image data. Tests verify both transparent and opaque pixels. Input and output limits constrain admitted data and application buffers, not total native memory or OS memory retention.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; JPEG and PNG custom-thumbnail changes are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-png-thumbnail/mac-arm64/Theatrum Ex Machina.app` |

The media tools were rebuilt with system zlib enabled, retaining FFmpeg 8.1.2 and the pinned x264 version. The former shared `build/media-tools` symlink was retained as `build/media-tools-shared-reference`; the new binaries use a real directory in this private worktree. The shared target was not modified. macOS linkage checks found only system libraries. Linux build instructions and Debian dependencies include zlib; native Linux execution remains unverified.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-png-thumbnail-stage/temp npm run media:build > tmp/private-png-thumbnail-stage/media-build.log 2>&1
```

All **2,448 tests across 82 privacy component suites** passed in one complete run, with none failed, cancelled or skipped. `tmp/private-png-thumbnail-stage/privacy-suite-results.json` verifies every component declared by `test:private-hubs` completed exactly once. This includes 48 PNG sanitizer and 27 custom-thumbnail tests. Fixtures cover RGB, RGBA, grayscale alpha, indexed palettes, 16-bit samples, interlacing, grayscale transparency, corrupt CRCs, animation refusal, oversized inputs, compressed metadata removal, reads spanning multiple capability chunks and cancellation while input/output buffers are owned.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-png-thumbnail-stage/temp npm run test:private-hubs > tmp/private-png-thumbnail-stage/full-private-tests.log 2>&1
node tmp/private-png-thumbnail-stage/verify-privacy-suite.mjs
npm run check > tmp/private-png-thumbnail-stage/check.log 2>&1
```

TypeScript and lint passed. Focused toolchain checks passed 27 media-toolchain, one Linux-packaging and three corresponding-source tests against the rebuilt tools. Packaging verification now requires an available PNG decoder and decodes an independent RGBA fixture into a JPEG of the expected geometry.

Native browser acceptance passed two phases and fifteen checkpoints. It verified JPEG replacement with a PNG, opaque/transparent/half-transparent output pixels, removal of a PNG text canary, unchanged source images, catalogue and other previews, preserved metadata drafts, picker cancellation, lock drainage, late-choice refusal, explicit plaintext export, reopening and process restart. Compact control bounds and hit tests passed at 600×400; `tmp/private-png-thumbnail-stage/compact-custom-thumbnail.png` was visually inspected.

Seventeen persistence scans performed 324 profile-file and 1,603 encrypted-file checks. Private markers were absent from those scan targets; network traffic, default-session private requests and private disk-cache sizes were zero. Source fixtures, deliberate plaintext exports and review screenshots are excluded from those targets. Native picker answers remain fixture-controlled; these checks do not establish real permission-dialog behavior, OS-wide erasure or signing acceptance.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-png-thumbnail-stage/temp npm run test:private-browser:native > tmp/private-png-thumbnail-stage/native-browser.log 2>&1
```

Exact local test-packaging command:

```sh
test ! -e release-test-private-png-thumbnail && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-png-thumbnail TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-png-thumbnail-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-png-thumbnail-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Twenty-five packaged implementation files matched the workspace byte for byte. ASAR SHA-256: `9601a293ca39c93d7ada95aa4eec7c4bfac38b4512528e29e2a8be17e2a4316f`. The file list is recorded in `tmp/private-png-thumbnail-stage/package-source-verification.json`.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-png-thumbnail TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-png-thumbnail-stage/temp npm run test:private-package:host > tmp/private-png-thumbnail-stage/packaged-host.log 2>&1
```

Packaged-host acceptance passed five checkpoints against the unchanged packaged main and registered native menus. Creation, preview decoding, saving notes, restoring the ordinary window, reopening and close passed. Six scans checked 215 profile, 35 encrypted-hub and 62 ordinary-hub files; eighteen unpacked files were verified. PNG interaction was exercised in native browser acceptance, with the matching implementation verified inside the packaged archive.

This is an unsigned local test build. No commit, push, production promotion, release or installed-application replacement was performed.

### Protected custom JPEG thumbnails — 7 October 2026

**Choose thumbnail** selects one JPEG through a native picker and saves a resized, metadata-stripped encrypted thumbnail. The original video can remain disconnected. Unsaved notes, tag and rating drafts survive the operation, and catalogue bytes, filmstrips, posters, clips and source images are preserved. JPEG is the only supported format in this stage: the bundled decoder has no PNG decoder. Encoded input is limited to 32 MiB, dimensions to 16,384 per side and 32 million pixels, and pre-decode header inspection to 256 KiB.

An immutable encrypted image is published through a strict authenticated override bound to the current generated-preview generation or initial converted-preview format. Regeneration and refresh supersede it. Invalid overrides, missing active members and missing primaries with surviving backups fail closed. Plaintext export includes the active thumbnail and rechecks the override before catalogue publication. Preview jobs share admission, cancellation and cleanup quarantine; exact-file selection does not retain a source-folder grant. Older encrypted members and backups remain; this is not secure erasure.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Branch | `private-hubs` |
| HEAD | `9d71f2d8c254a8dd6013bcb9c31b4521ba5d8a63` |
| Worktree state | Dirty; this custom-thumbnail stage is uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-custom-thumbnail/mac-arm64/Theatrum Ex Machina.app` |

All **2,385 tests across 81 privacy component suites** passed, with no skipped or cancelled tests. The run was completed in two parts after updating two existing assertions to count the added authenticated thumbnail-override lookup; the original preview buffer and admission limits were retained. `tmp/private-custom-thumbnail-stage/privacy-suite-results.json` verifies that every component listed by `test:private-hubs` has one passing result. Its source logs are `full-private-tests-verified.log` (passing prefix) and `remaining-private-tests.log` (session suite onward).

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-custom-thumbnail-stage/temp npm run test:private-hubs > tmp/private-custom-thumbnail-stage/full-private-tests-verified.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-custom-thumbnail-stage/temp node tmp/private-custom-thumbnail-stage/remaining-privacy-tests.cjs > tmp/private-custom-thumbnail-stage/remaining-private-tests.log 2>&1
```

Focused checks passed **11 override, 13 decoder, 12 session, 32 plaintext-export, 7 preview-failure, 412 controller, 355 UI, 99 preload and 87 browser tests**. Coverage includes corruption and backup boundaries, legacy/generated preview compatibility, immutable members, export mutation checks, JPEG geometry/header bounds, metadata removal, exact-file substitution, cancellation during buffer handoff or publication, reentrant write exclusion, descriptor drainage, cleanup-failure quarantine, strict bridge projection, stale rows and draft preservation. TypeScript and lint passed. Independent backend and gallery reviews found no remaining blocking issues. Review caught competing JPEG frame headers before decoding; the header check now rejects duplicates and unsupported frame types before the scan.

Native acceptance passed two phases and fifteen checkpoints, including decoded gold/purple thumbnail pixels, metadata canaries, exact catalogue/other-preview preservation, missing original-video sources, native picker cancellation without writes, draft preservation, replacement, Lock waiting for a held picker, late-choice refusal, unprotected export, reopening and a new Electron process. The first native run found that the gallery closed the open filmstrip during thumbnail-only work; the UI was corrected and regression-tested. The new control passed bounds and hit tests at 600×400, and `tmp/private-custom-thumbnail-stage/compact-custom-thumbnail.png` was visually inspected.

Seventeen persistence scans performed 324 profile-file and 1,603 encrypted-file checks. Synthetic private markers were absent from those targets; measured network counters, default-session private requests and private disk-cache sizes were zero. Original synthetic images, explicit plaintext copies and review screenshots are excluded from those scan targets. Picker answers remain fixture-controlled; this is not verification of real permission dialogs, OS-wide erasure or signing.

```sh
npm run check > tmp/private-custom-thumbnail-stage/check-final.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-custom-thumbnail-stage/temp npm run test:private-browser:native > tmp/private-custom-thumbnail-stage/native-browser-final.log 2>&1
```

Exact local test-packaging command:

```sh
test ! -e release-test-private-custom-thumbnail && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-custom-thumbnail TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-custom-thumbnail-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-custom-thumbnail-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Twenty-three packaged implementation files matched the workspace byte for byte. ASAR SHA-256: `910174d9d319b1b21740718eec156a710af50860be189af166c5b0d6761918e1`. The file list is recorded in `tmp/private-custom-thumbnail-stage/package-source-verification.json`.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-custom-thumbnail TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-custom-thumbnail-stage/temp npm run test:private-package:host > tmp/private-custom-thumbnail-stage/packaged-host.log 2>&1
```

Packaged-host acceptance passed all five checkpoints using the unchanged packaged main and its registered native menus. Creation, encrypted preview decoding, notes saving, restoration, reopening and ordinary close passed without private recent-history writes. Six scans checked 215 profile, 35 encrypted-hub and 62 ordinary-hub files; eighteen unpacked files were verified. Custom-thumbnail interaction was exercised in native browser acceptance; its packaged implementation was separately matched to the tested workspace files.

All local `main` commits through `7a569c7936f8f71b2af2af097ddad03aa2510e3e` remain included (`git rev-list --count HEAD..main` returned zero). No merge or branch switch was needed. This is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Other image formats, alternate-location refresh, broader filesystem/lifecycle fault acceptance and other-platform verification remain separate work.

### Single-location video refresh — 7 October 2026

The private gallery now provides **Refresh video** separately from **Regenerate previews**. It refreshes technical metadata and all configured encrypted previews from a single saved, authorized source location. Entries with alternate locations or shared preview identifiers are refused. Notes, tags, title, rating, playback history, playlist membership, date added and unknown raw fields are retained. Invalid or out-of-range default-frame selections are cleared; missing flags and import-error metadata are preserved.

The operation uses a new main-generated preview namespace. Complete encrypted previews are prepared before one guarded catalogue write replaces the row’s hash and measured technical fields together. Before that write the previous catalogue/preview pair remains authoritative; the old namespace is never overwritten. The controller re-reads storage after admitted outcomes, including cancellation after publication, and retires stale row authority. Uncertain publication and unproven descriptor/decoder cleanup lock or quarantine the session. Old encrypted previews, recovery backups and unused staged records remain; this is not secure erasure.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `e436afe6845e33e06e486a54a900823936af4e41` |
| Worktree state | Dirty; preceding history/reset/source-check work and this refresh stage are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-refresh/mac-arm64/Theatrum Ex Machina.app` |

The full privacy suite passed **2,293 tests across 78 files**, with no failures, skips or cancellations. Focused verification passed **27 refresh-helper, 24 refresh-session, 384 controller, 86 browser, 341 UI and 94 preload tests**. TypeScript and lint passed. Independent storage and controller/UI cross-reviews found no blocking issues. Coverage includes namespace collisions, retained/deleted namespace owners, raw metadata and optional omissions, stale rows and source/settings changes, source replacement, invalid probe results, write admission before reentrant callbacks, no-write cancellation, Lock and descriptor drainage, post-publication uncertainty, strict bridge projection, draft/IME/Protection/credential guards, and late responses or retired selection IDs.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-refresh-stage/temp npm run test:private-hubs > tmp/private-refresh-stage/full-private-tests.log 2>&1
npm run check > tmp/private-refresh-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-refresh-stage/temp npm run test:private-browser:native > tmp/private-refresh-stage/native-browser-restart.log 2>&1
```

Native acceptance passed two phases and fourteen checkpoints. A dedicated synthetic encrypted hub started with stale 1,920×1,080, twenty-frame metadata for a 32×18, four-second source. Refresh replaced its technical fields and three-frame encrypted filmstrip while preserving user/unknown metadata and leaving the alternate-location entry and original bytes unchanged. Native picker cancellation performed no catalogue or preview writes. A dirty notes draft blocked refresh and remained intact. The existing source grant was reused. A held response after actual catalogue publication allowed cancellation; the gallery correctly loaded the newly saved preview namespace. Saved metadata and previews survived both reopening and a new Electron process.

The refresh button passed bounds and hit tests at 600×400, and `tmp/private-refresh-stage/compact-refresh.png` was visually inspected. Existing source-check, import/discovery, playback/history/reset, regeneration, password/export and isolation checks also passed. Sixteen persistence scans performed 304 profile-file and 1,404 encrypted-file checks. Synthetic private markers were absent; measured network counters, default-session private requests and private disk-cache sizes were zero. Intentional plaintext sources/exports and review screenshots are excluded from those scan targets. Native picker answers remain fixture-controlled; these observations do not establish real permission-dialog behavior, OS-wide erasure or signed Touch ID acceptance.

All local `main` commits through `7a569c7936f8f71b2af2af097ddad03aa2510e3e` are included; `git rev-list --count HEAD..main` returned zero. No merge or branch switch was needed.

Exact local test-packaging command:

```sh
test ! -e release-test-private-refresh && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-refresh TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-refresh-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-refresh-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Seventeen packaged implementation files matched the tested workspace byte for byte, including the new video-refresh helper. ASAR SHA-256: `0ff0953cb6a34946cd79d11fcd736d91c18d6b925d929da5937ea92ed783f158`. The file list is recorded in `tmp/private-refresh-stage/package-source-verification.json`.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-refresh TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-refresh-stage/temp npm run test:private-package:host > tmp/private-refresh-stage/packaged-host.log 2>&1
```

Packaged-host acceptance passed all five checkpoints using the unchanged packaged main and registered native menus. Creation, encrypted preview decoding, notes save, restoration, reopening and ordinary close passed without private recent-history writes. Six scans checked 215 profile, 35 encrypted-hub and 62 ordinary-hub files; eighteen unpacked files were verified. The new refresh interaction was tested by native browser acceptance, with the packaged implementation separately matched to those tested files.

This is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Alternate-location reconciliation, custom-thumbnail operations, broader filesystem/lifecycle fault acceptance and other-platform verification remain separate work.

### Read-only saved-source checks — 5 October 2026

**Source folders → Check saved files…** explicitly checks catalogue-listed locations under one granted source folder. It returns only counts for the same recorded size, different size, missing, not verified and ignored. Multiple stored locations count separately. Matching size is not content verification. Unknown recorded sizes, symbolic links, non-file locations and inaccessible paths are not verified; ignored locations are not probed. A lost or replaced root refuses the report instead of misreporting all videos as missing. There is no directory enumeration, media-content read, decoder, catalogue write, preview change, missing-flag update or watcher.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `e436afe6845e33e06e486a54a900823936af4e41` |
| Worktree state | Dirty; previous history/reset work and this source-check stage are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-source-check/mac-arm64/Theatrum Ex Machina.app` |

The full privacy suite passed **2,177 tests across 76 files**, with no failures, skips or cancellations. Focused suites passed **36 source-check, 345 controller, 86 browser, 320 UI and 89 preload tests**. TypeScript and lint passed. Independent helper and controller/bridge reviews found no blocking issues.

Coverage includes validation before source access, bounded catalogue/location handling, aliases, ignored paths, unknown sizes, permission errors versus missing files, root/ancestor/leaf replacements, strict count-only responses, native grant reuse and revocation, late reader/picker results, Lock and cancellation drainage, stale catalogue/source configuration, and draft/selection preservation. The helper is bounded to 100,000 catalogue rows/raw locations, 256 sources, 10,000 selected references and 8,388,608 cumulative relative-path characters. Paths deeper than 32 parent levels are not probed. Path-based pre/post identity checks detect observed replacements; they are not a descriptor-relative traversal sandbox or a content-integrity guarantee.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-source-check-stage/temp npm run test:private-hubs > tmp/private-source-check-stage/full-private-tests.log 2>&1
npm run check > tmp/private-source-check-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-source-check-stage/temp npm run test:private-browser:native > tmp/private-source-check-stage/native-browser-layout.log 2>&1
```

Native acceptance passed two phases and thirteen checkpoints. A dedicated synthetic encrypted hub checked nine saved locations: three the same recorded size, one different size, one missing, three not verified and one ignored. The UI displayed the counts; its bridge omitted the internal revision and paths. Cancellation in the native picker did not start metadata checking. Cancellation during a held metadata request waited for settlement and discarded the report. Root disconnection refused the check; reconnecting recovered. Lock drained a held native picker and refused its late grant. Unsaved notes remained intact throughout checks and were not silently saved on Lock. Encrypted catalogue and original-file fingerprints remained unchanged; reopening cleared session connections and transient results.

The initial native run caught the extra action wrapping and clipping the first source row at 600×400. Widening the source panel from 430px to 500px while preserving its viewport clamp fixed the layout; the existing visibility assertion remained unchanged. Both the action and report passed the rerun, and `tmp/private-source-check-stage/compact-check.png` and `compact-report.png` were visually inspected. Existing history/reset, import, playback/fullscreen, source relocation, regeneration, password/export and isolation acceptance also passed.

Fifteen persistence scans performed 284 profile-file and 1,218 encrypted-file checks. Synthetic private markers were absent from scanned files; measured network counters, default-session private requests and private disk-cache sizes were zero. Intentional plaintext sources/exports and review screenshots are outside those scan targets. The native picker/system adapters remain controlled fixtures, and these checks do not establish OS-wide erasure or real permission-dialog behavior.

Exact local test-packaging command:

```sh
test ! -e release-test-private-source-check && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-source-check TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-source-check-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-source-check-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Sixteen packaged implementation files matched the tested workspace byte for byte, including the new source-check helper. ASAR SHA-256: `f0465871215143ddbb27237da1677e40234c005b922c8c2a1e569959c205acb0`. The file list is recorded in `tmp/private-source-check-stage/package-source-verification.json`.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-source-check TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-source-check-stage/temp npm run test:private-package:host > tmp/private-source-check-stage/packaged-host.log 2>&1
```

Packaged-host acceptance passed all five checkpoints using the untouched packaged main and registered native menus. Creation, encrypted preview decoding, notes save, restoration, reopening and ordinary close passed without private recent-history writes. Six scans checked 215 profile, 35 encrypted-hub and 62 ordinary-hub files; eighteen unpacked files were verified. The source-check interaction was exercised by native browser acceptance, with the packaged implementation separately matched to those tested files.

This is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Changed-file reconciliation, custom-thumbnail operations, broader filesystem/lifecycle fault acceptance and other-platform verification remain separate work.

### Playback-history maintenance — 4 October 2026

Protection now provides separate **Reset Last played…** and **Reset Times played…** actions. Each operates on the current encrypted catalogue after a count-only native confirmation whose default is Cancel. The recording preference and unrelated raw catalogue fields stay unchanged. Missing and already-zero fields do not need a write. Explicit reset includes malformed metric values and retained deleted/folder entries. Existing encrypted recovery backups are retained; this is not secure erasure.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `e436afe6845e33e06e486a54a900823936af4e41` |
| Worktree state | Dirty; earlier playback-history work and this maintenance stage are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-history-reset/mac-arm64/Theatrum Ex Machina.app` |

The full privacy suite passed **2,083 tests across 75 files**, with no failures, skips or cancellations. Focused suites passed **18 reset-session, 306 controller, 86 browser, 305 UI and 85 preload tests**. Coverage includes queue ownership through confirmation, input and response bounds, raw-field preservation, malformed/deleted entries, duplicate no-op requests, no-write cancellation, history independence, encrypted backup retention, Lock during confirmation, stale publication authority, storage failures, pending cleanup, unsaved drafts, credential/composition guards, and stale gallery IDs. TypeScript and lint passed. Independent storage and UI/bridge reviews found no blocking issues.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-reset-stage/temp npm run test:private-hubs > tmp/private-history-reset-stage/full-private-tests.log 2>&1
npm run check > tmp/private-history-reset-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-reset-stage/temp npm run test:private-browser:native > tmp/private-history-reset-stage/native-browser-verified.log 2>&1
```

Native acceptance passed two phases and twelve checkpoints. The reset stage checked cancellation without writes, each metric independently, repeated no-op resets without another prompt or write, the unchanged recording preference, Recently played refresh, retired selection IDs, and unchanged notes, other metadata and original bytes. Lock held restoration until an outstanding confirmation returned, then refused its late affirmative answer without writing. Both reset buttons passed bounds and hit tests at 600×400; `tmp/private-history-reset-stage/compact-reset.png` was visually inspected. Reopening and a fresh process retained the reset values. The existing playback-history recording, imports, source management, preview generation, encryption, password, export and isolation acceptance also passed.

The first native run completed all application checks but failed the harness's final expected-checkpoint list, which omitted the newly added reset checkpoint. Adding that expected checkpoint produced the successful rerun without changing product behavior. Fourteen persistence scans performed 264 profile-file and 1,049 encrypted-file checks. Scanned synthetic private markers were absent; measured network counters, default-session private requests and private disk-cache sizes were zero. Intentional plaintext sources/exports and synthetic review screenshots are outside those scan targets. These checks do not establish OS-wide erasure or signing acceptance.

Exact local test-packaging command:

```sh
test ! -e release-test-private-history-reset && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-history-reset TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-reset-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-history-reset-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Fifteen packaged files matched the tested workspace byte for byte, including the gallery, preload, interfaces, controller, browser, session and playback-history module. ASAR SHA-256: `af0d63d8c49c8309d33b94c79c093c87c2c285450d07533f941538907dec07d9`. The file list is recorded in `tmp/private-history-reset-stage/package-source-verification.json`.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-history-reset TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-reset-stage/temp npm run test:private-package:host > tmp/private-history-reset-stage/packaged-host.log 2>&1
```

Packaged-host acceptance passed all five checkpoints using the unchanged packaged main and registered native menus. It covered private-copy creation, preview decoding and notes save, restoration, reopening and normal close without private recent-history writes. Six scans checked 215 profile, 35 encrypted-hub and 62 ordinary-hub files; eighteen unpacked files were verified. The new reset workflow was exercised by native browser acceptance, with the packaged implementation separately matched to those tested sources.

This is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Source reconciliation/watching, broader filesystem/lifecycle fault acceptance and other-platform verification remain separate work.

### Optional encrypted playback history — 4 October 2026

**Protection → Record playback history** defaults Off, including hubs with missing settings or older version-1 settings. Enabling it records Last played and increments Times played once after an original video starts playing. Previews, loading, failed starts, pause/resume, seek and loops do not add plays. A new explicit Play video action can add another. Turning recording off preserves existing history. Notes/tag/rating drafts remain separate from the automatic history update.

The UI acknowledges only the first trusted original `playing` event. Main accepts an exact current opaque URL, checks the source grant and actual byte delivery, binds the saved row/revision, supplies its own timestamp and consumes the acknowledgement once. Delivery does not prove decoding; the controlled gallery event is the playback indication. The session reads encrypted policy inside the same serial transaction as raw-catalogue full-row CAS and guarded publication. Missing metrics can initialize; malformed and overflowing metrics remain unchanged. The known history-only mutation advances the main cached persisted revision and sorting metric while preserving the editor's public revision. Ordinary Stop allows an already admitted play to finish recording; lock/frame revocation cancels authority and drains it. No renderer-supplied timestamp, count or filesystem path is accepted.

Protection settings now write version 2; an omitted history flag from an older in-process caller preserves the saved policy. Reading legacy version 1 does not rewrite it. Earlier builds reject the new settings version, so hubs whose Protection settings are saved here require this or a later compatible build. Damaged settings, uncertain writes, session isolation, source authority and inactivity limits retain their fail-closed behavior.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `e436afe6845e33e06e486a54a900823936af4e41` |
| Worktree state | Dirty; playback-history changes are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-history/mac-arm64/Theatrum Ex Machina.app` |

The full privacy suite passed **2,001 tests across 74 test files**, with no failures, skips or cancellations. Focused tests passed: **7 history-helper, 21 history-session, 21 protection, 9 password-session, 270 request-controller, 81 browser, 20 source-playback, 287 UI and 80 preload tests**. They cover migration/default-off/no-write behavior, policy ordering, strict snapshots, raw-field preservation, queue limits and buffer clearing, malformed metrics, CAS conflicts, duplicate/stale acknowledgements, delivered-data gating, main-owned time, delayed Stop/Lock outcomes, dirty-draft preservation, deferred list refresh, and late playback callback messages. TypeScript and lint passed.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-stage/temp npm run test:private-hubs > tmp/private-history-stage/full-private-tests.log 2>&1
npm run check > tmp/private-history-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-stage/temp npm run test:private-browser:native > tmp/private-history-stage/native-browser-verified.log 2>&1
```

Native acceptance passed two phases and eleven checkpoints. Default-off original playback left the encrypted catalogue unchanged. Enabling recording and starting an imported synthetic video saved one play; seeking, pause/resume and an attempted duplicate acknowledgement did not increment it. Its unsaved note remained a draft and subsequently saved without a conflict. A separate start recorded a second play, Recently played included the video, and previews added no plays. Disabling recording preserved both plays and prevented another increment. The count, last-played timestamp, saved note and disabled policy survived process restart; source video bytes remained unchanged.

Earlier fixture attempts exposed timing assumptions in navigation clicks during a pending acknowledgement and an incorrect empty-string expectation for absent imported notes. The final fixture waits for the existing pending gate and asserts that absent notes remain absent. No recording behavior was weakened for those checks. The new Protection select was bounds- and hit-tested at 600×400 after panel scrolling, and `tmp/private-history-stage/compact-history.png` was visually inspected. Existing source management, discovery/import, rating, collections, encrypted previews, playback/fullscreen, protection, export and lock checks also passed.

Thirteen persistence scans covered 244 profile and 940 encrypted-file checks. Synthetic secret markers were absent from the scanned files; measured network counters, default-session private requests and disk-cache sizes were zero. Plaintext synthetic sources, intentional exports and review screenshots are excluded. These observations do not establish OS-wide erasure, native permission/picker-history behavior or proof of decoding independent of the trusted gallery event.

Exact local test-packaging command:

```sh
test ! -e release-test-private-history && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-history TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-history-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Fifteen packaged files matched their tested workspace sources byte for byte: gallery HTML/CSS/JavaScript, preload, both interfaces, request controller, playback-history helper, protection helper, session, browser, protocol, source playback, captured source and metadata helper. ASAR SHA-256: `899569273e88285e9686d10469119feb9168534490c7ec155c2b76d29929696e`. Results are recorded in `tmp/private-history-stage/package-source-verification.json`.

Packaged-host acceptance passed all five checkpoints using the untouched packaged main and registered menus: private-copy creation, encrypted preview decoding and notes save, lock/restoration, password reopening, and ordinary close without private recent-history entries. Six scans checked 215 profile files, 35 encrypted files and 62 ordinary fixture files; eighteen unpacked files were verified. The new playback-history interaction is covered by the native browser workflow above; its package files were separately matched byte for byte.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-history TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-history-stage/temp npm run test:private-package:host > tmp/private-history-stage/packaged-host.log 2>&1
```

This is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Source reconciliation/watching, broader failure/reconnection acceptance and other-platform verification remain separate work.

### Reviewed source-folder discovery — 3 October 2026

**Source folders → Find new videos…** explicitly discovers uncatalogued files beneath a saved, connected source folder. Discovery reads metadata only. It skips existing catalogue paths, symbolic links, ignored subfolders, generated `vha-*` folders and unsupported extensions. A native count-only confirmation defaults to Cancel before any media content is read for import. At most 100 candidates are offered per batch; a further scan can find more after successful imports. Discovery stops without import if it exceeds 10,000 entries, 1,000 directories or depth 32, with **Add videos…** as the manual fallback.

The main-owned review binds the source configuration and ignored-folder policy, root and ancestor identities, and candidate identity, size and timestamps. These are rechecked around confirmation and during the existing serial encrypted import transaction. Its own successful catalogue appends do not invalidate the remaining candidates. The renderer receives generic statuses and numeric progress, never candidate paths. Cancellation drains pending directory access and native confirmation; completed imports remain saved. Directory-close failures or the five-second close deadline quarantine the session. No automatic watcher or background scan is added.

The directory API is path-based. Pre/post identity and realpath checks detect observed replacements, but do not establish a descriptor-relative traversal sandbox against hostile, rapidly swapped ancestors. Original files remain unencrypted. Native dialogs use controlled answers in acceptance tests; real permission/picker history behavior and OS-wide erasure are not established by these fixtures.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; previous privacy stages and folder discovery are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-scan/mac-arm64/Theatrum Ex Machina.app` |

The full privacy suite passed **1,913 tests across 72 test files**, with no failures, skips or cancellations. Focused tests passed: **24 scanner, 246 request-controller, 81 browser, 264 UI and 73 preload tests**. These cover scan bounds, extension/ignore/link exclusions, identity replacement, stale grants and source policy, late directory access, close failure/deadline, cancellation during confirmation and import, import progress, draft guards, strict bridge validation and count-only confirmation. Main/renderer/worker TypeScript and lint passed.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-scan-stage/temp npm run test:private-hubs > tmp/private-scan-stage/full-private-tests.log 2>&1
npm run check > tmp/private-scan-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-scan-stage/temp npm run test:private-browser:native > tmp/private-scan-stage/native-browser.log 2>&1
```

Native acceptance passed two phases and eleven checkpoints. Declining confirmation and cancelling before a late affirmative response left the encrypted catalogue unchanged. A confirmed scan imported exactly two new videos, including one nested file with an uppercase extension; linked, ignored, generated-preview and already catalogued files were excluded. A repeated scan found nothing new and did not prompt again. Both encrypted thumbnails decoded and both entries survived a process restart. Source bytes and links remained unchanged. Existing metadata, rating, collections, import, source management, playback/fullscreen, protection, export and lock checks also passed.

The discovery control was bounds- and hit-tested at 600×400 after normal panel scrolling; `tmp/private-scan-stage/compact-source-scan.png` was visually inspected. Thirteen persistence scans covered 244 profile and 933 encrypted-file checks. Synthetic secrets were absent from scanned persistent files; measured network counters, default-session private requests and disk-cache sizes were zero. Plaintext synthetic sources, intentional exports and review screenshots are excluded from those scans.

All local `main` commits through `7a569c7936f8f71b2af2af097ddad03aa2510e3e` are included; `git rev-list --count HEAD..main` returned zero. No branch switch or merge was needed.

Exact test-packaging command:

```sh
test ! -e release-test-private-scan && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-scan TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-scan-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-scan-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. Thirteen packaged files matched the tested workspace byte for byte: gallery HTML/CSS/JavaScript, preload, compiled interface, request controller, scanner, source access, captured source, video import, session, browser and protocol. ASAR SHA-256: `69bead37b948ea47873077ffbf4aeb90de855df9d51bb271b63da599316f95da`. File results are recorded in `tmp/private-scan-stage/package-source-verification.json`.

Packaged-host acceptance passed all five checkpoints using the untouched packaged main and registered menus: private-copy creation, encrypted preview decoding and notes save, lock/restoration, password reopening, and ordinary close without private recent-history entries. Six scans checked 215 profile files, 35 encrypted files and 62 ordinary fixture files; eighteen unpacked files were verified. This packaged-host scenario exercises the existing application transition; new discovery behavior is covered by the native browser workflow above, with its packaged code separately matched byte for byte.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-scan TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-scan-stage/temp npm run test:private-package:host > tmp/private-scan-stage/packaged-host.log 2>&1
```

The package is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Private play-history updates, folder reconciliation/watching, broader failure/reconnection acceptance and other-platform verification remain separate work.

### Encrypted rating and favourite editing — 3 October 2026

Private video details now provide **Rating** with Unrated and one-to-five stars. Five stars is a Favourite, matching the ordinary application's existing `stars === 5.5` convention. Ratings participate in the same explicit Save/Discard flow as notes and tags; there is no autosave or independent favourite field. Saved changes immediately refresh collection membership and sort order. When a video leaves Favourites, its saved Details remain open.

An optional integer `rating` extends the existing edit request. Only an explicitly supplied zero-to-five value changes raw `stars` to `rating + 0.5`; omission preserves the exact stored value, including absent and malformed legacy data. UI intent is tracked separately from the display projection so notes/tag edits never normalize a rating silently. Main and preload snapshot own enumerable data fields and plain string tag entries; undefined, null, fractional, out-of-range, accessor, symbol and extra-field requests are rejected before queue admission. The existing full-row revision, original-index identity, encrypted transaction, source-authority retirement, bounded buffers, cancellation and lock drainage remain in place. No source access, history write or new IPC method is added.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; previous privacy stages and rating editing are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-rating/mac-arm64/Theatrum Ex Machina.app` |

All local `main` commits through `7a569c7936f8f71b2af2af097ddad03aa2510e3e` are included; `git rev-list --count HEAD..main` returned zero. No branch switch or merge was needed.

The full privacy suite passed **1,856 tests across 71 test files**, with no failures, skips or cancellations. Focused checks passed **23 encrypted-metadata, 227 request, 257 UI and 70 preload tests**. They cover all six persisted rating values, combined edits, raw legacy preservation, invalid requests rejected before storage reads, queued-request detachment, full-row conflicts, cancellation before publication, a committed write drained during lock, stable selection IDs, Favourites and sorting refresh, draft navigation/composition/protection guards, failed saves and stale responses. Persistence and main/renderer/worker TypeScript, lint, JavaScript syntax and whitespace checks passed.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-rating-stage/temp npm run test:private-hubs > tmp/private-rating-stage/full-private-tests.log 2>&1
npm run check > tmp/private-rating-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-rating-stage/temp npm run test:private-browser:native > tmp/private-rating-stage/native-browser.log 2>&1
```

The native browser workflow passed two phases and eleven checkpoints. A synthetic video went from an unsaved five-star draft back to Unrated through Discard, then saved five stars and appeared in Favourites. Saving three stars removed it from that collection while retaining Details. The rating sort reflected the change; three stars survived password reopening and a full process restart, while other saved ratings and original file bytes were unchanged. Existing collection, import, source connection/relocation, playback/fullscreen, notes/tags, protection, password, export and lock checks also passed.

The rating editor, Save, Discard and Lock controls were bounds- and hit-tested at 600×400 after normal scrolling within Details. Paint-synchronized captures were inspected at `tmp/private-rating-stage/compact-rating.png` and `tmp/private-rating-stage/rating.png`. Thirteen scans covered 244 profile and 849 encrypted-file checks. Synthetic secrets were absent from scanned persistent files; network counters, default-session private requests and reported disk-cache sizes were zero. These bounded checks do not establish OS-wide erasure or real permission-dialog acceptance.

Exact test-packaging command:

```sh
test ! -e release-test-private-rating && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-rating TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-rating-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-rating-stage/build.log 2>&1
```

Packaging, runtime startup and licensing checks passed. Ten packaged files matched the tested workspace byte for byte: gallery HTML/CSS/JavaScript, preload, compiled interface, request controller, metadata transaction helper, session, browser and protocol. ASAR SHA-256: `6a1290a38bbc544061df8b233c3494569ef3ff4149bb39280c3ce8782d71df27`.

Packaged-host acceptance passed all five checkpoints using the untouched packaged main and its registered menus: private-copy creation, encrypted preview decoding and notes save, lock/restoration, password reopening, and ordinary close without private recent-history entries. Six scans checked 215 profile files, 35 encrypted files and 62 ordinary fixture files; eighteen unpacked files were verified. This packaged-host scenario exercises notes editing; rating acceptance is the native browser scenario above, with its compiled package files separately matched byte for byte.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-rating TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-rating-stage/temp npm run test:private-package:host > tmp/private-rating-stage/packaged-host.log 2>&1
```

The package is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred; private play-history updates and broader folder scans/watching remain separate work.

### Collections and sorting — 3 October 2026

The private gallery now provides All videos, Favourites and Recently played, plus catalogue order, natural name, date added, last played, rating, duration and file-size sorting in either direction. Recently played excludes missing, zero and invalid saved timestamps and initially orders newest first. Private playback still does not update history. Search applies within the chosen collection. Missing metrics remain last in either direction, ties retain original catalogue order, and sorting preserves row identities and editing authority.

Fixed optional selectors extend the existing list request; no IPC method or public item field was added. Sort metrics stay in main. Browsing grants no source access and makes no catalogue writes. UI changes return to page one, use the visible search text, retire stale responses and media, and preserve unsaved notes/tags and protection drafts. Browse state is cleared on lock or page exit. The short-window layout retains search, collections, sorting and privacy controls while leaving usable thumbnail space.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; previous privacy stages and collections/sorting are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-library/mac-arm64/Theatrum Ex Machina.app` |

The branch contains all local `main` commits through `7a569c7936f8f71b2af2af097ddad03aa2510e3e`; `git rev-list --count HEAD..main` returned zero. No branch switch or merge was needed.

The full private suite passed **1,833 tests across 71 test files**, with no failures, skips or cancellations. Focused request, preload and UI checks passed 223, 67 and 247 tests respectively. These cover strict query validation, all sort choices/directions, stable pagination and IDs, invalid metrics, collection/search intersections, stale authority, metadata refreshes, draft/composition guards and asynchronous result retirement. Main/renderer/worker and persistence TypeScript checks, lint, JavaScript syntax and whitespace checks passed. The UI suite also passed after the final compact CSS change.

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-library-stage/temp npm run test:private-hubs > tmp/private-library-stage/full-private-tests.log 2>&1
npm run check > tmp/private-library-stage/check.log 2>&1
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-library-stage/temp npm run test:private-browser:native > tmp/private-library-stage/native-browser-reviewed.log 2>&1
```

The final native workflow passed two phases and eleven checkpoints. A 50-row synthetic encrypted catalogue verified Favourites, saved-history Recent, combined search, no-match results, direction changes and stable 48-row pagination. Forced control events could not discard an unsaved note. Browsing and discarding a draft left encrypted catalogue/preview bytes and original files unchanged. A nondefault Recent view reset to All videos/catalogue order/ascending after locking and reopening. Existing import, playback, fullscreen, relocation, metadata, protection, password, export and restart checks also passed.

Visual inspection caught the initial compact toolbar leaving too little space for thumbnails. The final 600×400 window check measures the actually visible grid area inside its scrolling viewport (at least 120 pixels), checks control bounds and hit testing, and waits for painting before capture. Both `tmp/private-library-stage/compact-library.png` and `tmp/private-library-stage/library.png` were inspected. Thirteen profile scans covered 244 profile and 849 encrypted-file checks; synthetic secrets were absent, all network counters and default-session private requests were zero, and reported disk-cache sizes were zero. These tests do not establish OS-wide erasure or real permission-dialog behavior.

A separate synthetic benchmark exercised the actual list handler with 100,000 in-memory rows. Warm values are medians of five samples:

| Query | Time |
| --- | ---: |
| Fresh row projection, catalogue order (one sample) | 773 ms |
| Fresh projection plus natural name (one sample) | 1,276 ms |
| Warm catalogue order | 5.4 ms |
| Warm natural name, either direction | 399–407 ms |
| Next page with natural name | 423 ms |
| Warm numeric sorts | 17.6–39.2 ms |
| Search yielding 1,000 rows, then natural name | 10.2 ms |
| Favourites (16,666 rows), then duration | 14.3 ms |
| Recently played (90,000 rows), then last played | 29.3 ms |

Natural-name sorting made 1,515,948 comparisons, consistent with ordinary O(n log n) sorting using one collator. Sorting is repeated for each page, so this measured cost remains at the maximum catalogue size. No cache or protection was changed to optimize it. “Fresh” means an empty projected-row cache with the catalogue already in memory, not a cold OS/disk cache. Measurements exclude decryption, media delivery, image decoding and rendering, and concurrent tests may affect timings. Scripts and complete results are in `tmp/private-browse-benchmark/`.

Exact test-packaging command (outside the execution sandbox for native startup verification):

```sh
test ! -e release-test-private-library && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-library TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-library-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-library-stage/build.log 2>&1
```

Packaging, runtime startup and licensing verification passed. The packaged gallery HTML/CSS/JavaScript, preload, compiled interface, request controller, private browser and protocol modules were byte-identical to this workspace (eight files). ASAR SHA-256: `e1bb3d1066531126ea8e511284da56d6ef1614f48b345ead1d27d8cd03d60659`.

Packaged-host acceptance also passed all five checkpoints using the untouched packaged main and registered native menu entries. It created a private copy, decoded a preview, saved notes, locked, reopened with a password, restored the ordinary workspace and closed without private recent-history entries. Six scans checked 215 profile files, 35 encrypted files and 62 ordinary fixture files. Eighteen unpacked files were verified; synthetic secrets were absent from scanned persistent storage.

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-library TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-library-stage/temp npm run test:private-package:host > tmp/private-library-stage/packaged-host.log 2>&1
```

The application is an unsigned local test build. No commit, push, promotion, publication, installation or replacement of the installed app was performed. Touch ID remains deferred. Broader folder scans/watching, private play-history updates, production signing and real OS permission/clipboard acceptance remain separate work.

### Selected-video batch import — 3 October 2026

**Source folders → Add videos…** accepts up to 100 native-selected files from one granted saved root. Main validates and snapshots the whole path list before media access, then revalidates catalogue/source authority for each serial import. The existing transaction generates encrypted previews and appends the catalogue entry afterward; every descriptor is drained before starting the next file. Known duplicate paths are skipped without probing their media. Per-file decoding/read failures are counted independently; cancellation, a changed root, lost authority or cleanup uncertainty stop further work. Completed entries remain saved.

The new `importProgress` bridge returns bounded numeric counters only. It requires the same live main frame and hub generation, grants no source access and does not renew inactivity. The preload allows this status request during a pending import while retaining the gate for other operations. UI polling uses operation epochs and stops on completion, cancellation, lock or page exit. The final summary distinguishes imported, duplicate, failed and unprocessed files; it never describes cancellation as rollback.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; previous privacy stages and batch import are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-batch-reviewed/mac-arm64/Theatrum Ex Machina.app` |

The branch contains all local `main` commits through `7a569c7936f8f71b2af2af097ddad03aa2510e3e`; `git rev-list --count HEAD..main` returned zero. No branch switch or merge was needed.

The full privacy suite passed **1,786 tests in 71 test files**, with no failures, skips or cancellations. Focused checks passed: 191 gallery-request, 77 browser, 65 preload, 234 UI and 15 actual encrypted-session import tests. The latter exercises successful import, duplicate rejection and another successful import consecutively, followed by reopening and decrypting the saved previews. Main/renderer/worker and persistence TypeScript checks, lint, JavaScript syntax and `git diff --check` passed. The full suite preceded the final compact help/focus changes; all 234 UI tests and the native browser workflow passed again afterward.

Exact full-suite command:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-batch-stage/temp npm run test:private-hubs > tmp/private-batch-stage/privacy-suite.log 2>&1
```

Native browser command:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-batch-stage/temp npm run test:private-browser:native > tmp/private-batch-stage/native-browser.log 2>&1
```

Two phases and eleven checkpoints passed. A mixed selection of four files produced two imported videos, one duplicate and one failed synthetic video. A second batch cancelled after one known completed import retained that entry and did not admit later candidates. The encrypted thumbnails decoded, original bytes stayed unchanged, paths remained absent from the DOM, and all 55 expected catalogue rows survived export and a full process restart. Existing fullscreen, source addition/relocation, regeneration, metadata, protection, password, export and locking checks also passed.

Native inspection caught compact help text pushing the first source row out of view; shorter help fixed that layout. Visual review then showed the original batch assertion proved only reachability after test-driven scrolling. Import startup now uses normal focus scrolling to reveal Cancel and adjacent progress. The final test resizes to 600×400 before starting, performs no scrolling itself, verifies progress and Cancel bounds/hit testing and waits for painting before capturing the screenshot. The image was inspected at `tmp/private-batch-import-stage/compact-batch-progress.png`.

The first native attempt stopped at the initial password-screen stage without enough diagnostics to establish the cause; that failure did not recur. Later fixture failures were corrected by waiting for asynchronous source rows and explicit controlled import admission. No production protections were relaxed. Thirteen scans in the successful final run covered 244 profile and 849 encrypted-file checks. Synthetic secrets were absent from those scanned files; network counters, default-session private requests and reported disk-cache sizes were zero. These bounded fixtures do not establish OS-wide memory/cache erasure, real permission-dialog acceptance or signed Touch ID behavior.

Exact final packaging command (outside the execution sandbox for native startup verification):

```sh
test ! -e release-test-private-batch-reviewed && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-batch-reviewed TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-batch-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-batch-stage/reviewed-build.log 2>&1
```

Packaging, native startup, helper payload and licensing verification passed. Packaged host acceptance also passed:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-batch-reviewed TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-batch-stage/temp npm run test:private-package:host > tmp/private-batch-stage/reviewed-packaged-host.log 2>&1
```

Five checkpoints used untouched packaged `main.js`, registered native menus and isolated synthetic ordinary/private hubs. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-hub file checks; 18 unpacked resources stayed unchanged. Twenty-two private assets and compiled modules were byte-compared with the final worktree. ASAR SHA-256: `ae2c62bea93cc70da4a96911d2f1b61c620cb59526eb036e4585167d87cab764`.

Logs and package identity are in `tmp/private-batch-stage/`; focused logs use the `tmp/private-batch-` prefix. The app is an unsigned local test package. Automatic folder scans and Touch ID remain deferred. Nothing was committed, pushed, promoted, published or installed.

### Add a source folder — 2 October 2026

**Source folders → Add folder…** saves a native-selected existing folder in the encrypted catalogue without scanning it, adding videos, enabling watching or granting ongoing access. New folders start disconnected. Connect or Add video grants access for the current session. The review checks directory identity without enumerating its contents and refuses duplicate roots, source-root overlap, linked locations and overlap with encrypted storage.

The branded review reserves every configured or referenced source index, including legacy numeric-string indices and deleted/missing entries. The guarded encrypted transaction appends only the new source with `watch: false`, preserves unknown fields and the original representation of existing paths, and retains cancellation, lock drainage and uncertain-publication handling. Renderer requests contain no filesystem paths. The UI retires stale source/selection IDs and refreshes after each admitted outcome.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; prior privacy stages and source-folder addition are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-add-source-reviewed/mac-arm64/Theatrum Ex Machina.app` |

`npm run test:private-hubs` passed **1,753 tests in 71 test files**, with no failures, skips or cancellations. The new helper/session suites include 24 and 23 tests. Main/renderer/worker and persistence TypeScript checks, lint, native-driver syntax and `git diff --check` passed. After a final limit-message correction, all 226 gallery UI tests passed again. The full suite preceded that text-only correction.

Exact full-suite command:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-add-source-stage/temp npm run test:private-hubs > tmp/private-add-source-stage/privacy-suite.log 2>&1
```

Native browser command:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-add-source-stage/temp npm run test:private-browser:native > tmp/private-add-source-stage/native-browser.log 2>&1
```

Two phases and eleven checkpoints passed. The native workflow covered cancelled selection, duplicate refusal, a saved zero-video disconnected source, a required subsequent grant, one imported video with an encrypted thumbnail, unchanged original bytes and persistence after process restart. Compact 600×400 inspection and hit testing confirmed the Add folder control and first source actions fit. Existing relocation, original/preview playback and fullscreen, regeneration, metadata, password, export and locking checks also passed. Thirteen scans covered 244 private-profile and 723 encrypted-file checks. Synthetic secrets were absent from the scanned profile and encrypted files; all network counters and reported disk-cache sizes were zero. These are bounded synthetic checks using controlled native dialogs, not evidence of OS-wide memory/cache erasure or real permission-dialog acceptance.

Exact final packaging command (run outside the execution sandbox for the native startup check):

```sh
test ! -e release-test-private-add-source-reviewed && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-add-source-reviewed TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-add-source-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-add-source-stage/reviewed-build.log 2>&1
```

Packaging, normal startup, native helper payload and licensing verification passed. The corresponding media-source archive is alongside the app output. The packaged host acceptance passed:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-add-source-reviewed TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-add-source-stage/temp npm run test:private-package:host > tmp/private-add-source-stage/packaged-host.log 2>&1
```

Five packaged-host checkpoints loaded untouched packaged `main.js`, its registered native menus and isolated synthetic ordinary/private hubs. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-hub file checks; 18 unpacked resources stayed unchanged. Twenty-two packaged assets and compiled modules were byte-compared with the reviewed worktree. ASAR SHA-256: `66e2068951d843a8168e8427f3867a8c7da52aee2295afbf968a22aec0c06091`.

Logs, compact-layout screenshots and package identity are in `tmp/private-add-source-stage/`. This is an unsigned local test package. Folder scans and batch imports remain unfinished, and Touch ID remains deferred. Nothing was committed, pushed, promoted, published or installed.

### Manual video import — 2 October 2026

**Source folders → Add video…** imports one native-picked video from an explicitly granted saved root. The main process validates root containment, ignored subdirectories, duplicate catalogue paths (including overlapping roots) and source identity. A fresh preview identity stays inaccessible through the gallery until its encrypted previews are generated and one guarded catalogue append commits. The append retains unknown catalogue fields and updates the derived folder count. New metadata comes from immutable numeric file timestamps/size and a fixed descriptor-only probe; FPS is bounded and optional malformed values become zero. Source files remain unchanged and unencrypted. No folder scan, new-root creation, watcher or content-duplicate merging is added.

Mutation admission is held through generation and publication. Cancel/lock drains pickers, decoders and file descriptors; a cleanup failure quarantines the session. A regression caught cancellation after successful catalogue publication but before preview-authority adoption: that boundary now locks instead of retaining an unlocked stale allowlist. A cancelled save can have committed and is never described as rolled back. The UI refreshes catalogue and source identities after every outcome and protects unsaved notes/tags. Compact native review found a clipped source row; the final two-row layout, shorter help and available panel height fit all three actions at 600×400 while retaining scrolling.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; prior privacy stages and manual import are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |
| Artifact | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-import/mac-arm64/Theatrum Ex Machina.app` |

`npm run test:private-hubs` passed **1,672 tests in 69 test files**, with no failures, skips or cancellations. Main/renderer/worker and persistence TypeScript checks, lint, native driver syntax and `git diff --check` passed. New helper/session tests cover duplicate/ignored/outside-root cases, conflicting source/catalogue identities, preservation of unknown fields, bounded metadata, pre-publication preview denial, mutation exclusion/reentry, decode cancellation, lock drainage, post-publication cancellation and cleanup quarantine. Bridge/preload/UI tests cover foreign frames, stale IDs/results, late native pickers, draft preservation, playback retirement and refresh after uncertain completion.

Native browser command:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-import-stage/temp npm run test:private-browser:native > tmp/private-import-stage/native-browser.log 2>&1
```

Two phases and eleven checkpoints passed. A real synthetic video was imported, its encrypted thumbnail and clip decoded, a second import of the same path was refused, its original bytes stayed unchanged, and the catalogue entry/FPS/preview survived process restart. Native picker cancellation, 600×400 button visibility/hit testing, earlier source relocation, regeneration, original playback/fullscreen, password/export and lock checks also passed. Thirteen scans covered 244 private-profile and 681 encrypted-file checks. Synthetic secrets were absent; all network counters and reported disk-cache sizes were zero. These are bounded synthetic checks, not proof of OS/GPU memory erasure or real permission/signing acceptance.

Exact packaging command:

```sh
test ! -e release-test-private-import && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-import TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-import-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-import-stage/build.log 2>&1
```

Packaging and the corresponding-source archive completed. The final GUI smoke check inside the execution sandbox aborted during macOS application registration, leaving this combined command with exit status 1. The supplied crash report's time and parent process matched that launch, with a stack in HIServices/AppKit registration. The existing package was retained without rebuilding or replacing it, and the exact verifier succeeded outside the execution sandbox with an isolated workspace profile:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-import-stage/temp node bin/verify-packaged-app.mjs './release-test-private-import/mac-arm64/Theatrum Ex Machina.app' > tmp/private-import-stage/package-verification.log 2>&1
```

The packaged host acceptance then passed:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-import TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-import-stage/temp npm run test:private-package:host > tmp/private-import-stage/packaged-host.log 2>&1
```

The five packaged-host checkpoints use untouched packaged `main.js`, native menu registration, an isolated profile and synthetic ordinary/private hubs. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-hub file checks; 18 unpacked resources stayed unchanged. Twenty-one packaged assets/compiled modules were byte-compared with the current worktree. ASAR SHA-256: `bce24a1887631131658af5e4b1d3579321ab353b0a500eb334b69d7261ba8550`.

Logs, compact-layout screenshots and package identity are in `tmp/private-import-stage/`. The app is an unsigned local test package. Nothing was committed, pushed, promoted, published or installed; Touch ID remains deferred.

### Player fullscreen correction — 2 October 2026

The private browser denied every permission, including the separate Electron `fullscreen` permission needed by the video control. Fullscreen is now allowed only for an open hub browser’s exact WebContents and live main frame at `theatrum://app/index.html`. Request URL, main-frame status, generation, browser lifetime and the check-handler origin must match. Credential/conversion dialogs and other permissions—including capture, media devices, clipboard, keyboard lock and pointer lock—remain denied. No preload or file-access capability was added.

The gallery leaves Escape to the fullscreen player before closing Details. Stop/selection/lock/page-exit cleanup requests fullscreen exit when the video owns it, without awaiting renderer completion or delaying source revocation. Rejected or synchronous exit failures cannot interrupt cleanup. The native test initially sent Escape before macOS completed its transition; waiting for `enter-full-screen` and `leave-full-screen` resolved the test race. This follows [Electron’s documented macOS fullscreen transition behavior](https://www.electronjs.org/docs/latest/api/browser-window#winsetfullscreenflag).

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; prior source/relocation/playback work and this correction are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |

**287 focused tests passed:** 73 private-browser, 190 gallery-UI, 17 idle-lock and seven native-input tests. New checks cover request/check permission boundaries, stale/foreign/subframe requests, denied password and conversion fullscreen, rejected exit promises, and immediate cleanup while an exit is pending. Main/renderer/worker and persistence TypeScript checks, lint, native-driver syntax and `git diff --check` passed. Logs are in `tmp/private-fullscreen-stage/`; the UI log is `tmp/private-fullscreen-ui.log`. The prior full 1,566-test private suite is recorded in the playback milestone below; it was not rerun for this correction.

The native command passed:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-fullscreen-stage/temp npm run test:private-browser:native > tmp/private-fullscreen-stage/native-browser.log 2>&1
```

Actual HTML fullscreen entry was verified for an original video and an encrypted preview, with video bounds covering the viewport. Native Escape returned to the same Details/player, Stop exited fullscreen and retired source access, and locking while fullscreen destroyed the browser and drained original playback. Two phases and eleven checkpoints also passed earlier source, relocation, regeneration, metadata, password, export, inactivity and restart checks. Thirteen repeated scans covered 244 profile and 639 encrypted-file checks; all network counters and reported disk-cache sizes were zero. These use synthetic files and controlled native dialogs within the workspace; no user hub was opened. Real permission dialogs, all codecs, non-macOS behavior and OS memory/cache erasure remain outside this evidence.

The unsigned Apple Silicon test app is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-fullscreen/mac-arm64/Theatrum Ex Machina.app`. Exact build command:

```sh
test ! -e release-test-private-fullscreen && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-fullscreen TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-fullscreen-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-fullscreen-stage/build.log 2>&1
```

Startup, runtime/media and licensing verification passed. Fourteen packaged assets/modules were byte-compared with current inputs, including the gallery and browser correction. Media source: `release-test-private-fullscreen/theatrum-ex-machina-media-source-v2.0.1.tar.xz`. The installed app and earlier test packages remain unchanged. No commit, push, promotion or installation was performed; Touch ID remains deferred.

Packaged-host verification passed all five checkpoints with:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-fullscreen TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-fullscreen-stage/temp npm run test:private-package:host > tmp/private-fullscreen-stage/packaged-host.log 2>&1
```

The untouched packaged main completed synthetic conversion, preview decoding, note saving, lock/ordinary restoration, password reopening and clean shutdown. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-tree checks. Its archive and 18 unpacked files remained unchanged. ASAR SHA-256: `139f5cf76ed87600061f3349e82a3741a1028dd673f68fad4e97f68e1fd6be5c`. Fullscreen interaction coverage comes from the native fixture; this packaged fixture verifies the native opening/editing/locking lifecycle.

### Original-video playback — 1 October 2026

**Play video** opens a supported original inside the isolated private gallery, separately from **Play preview**. It uses an explicit native source-folder grant or an existing current session grant; a renderer-supplied path cannot authorize it. Playback accepts an issued row ID/revision and checks the encrypted row and source mapping before and after authorization. It remains available when preview geometry is missing or a preview hash is shared. Source files stay unencrypted; playback does not update played counters or save drafts.

One main-owned manager issues a random 64-hex capability URL and serves GET/HEAD with single ranges, no-store headers, at most two outstanding responses and demand-driven chunks of at most 256 KiB. Captured source descriptors recheck identity, size, timestamps and parent directories before reads and delivery. Parent symlinks are rejected before probing the leaf. Stop, selection, source/protection changes, metadata operations and lock retire the token and drain pending reads and descriptors. A cleanup failure or five-second timeout remains latched and quarantines restoration. There is no external-player or transcoding fallback. Codec support depends on the bundled player.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; source connections, relocation and playback are uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |

**All 1,566 tests in 67 private-hub test files passed**, with no skips or cancellations, through `npm run test:private-hubs`. This includes 18 original-playback, 27 source-descriptor, 147 gallery-request, 51 preload, 178 UI, 70 private-browser and 17 protocol cases. Coverage includes stale row/source identities, no unapproved source probes, cancellation during native selection or descriptor work, late start supersession, invalid/multipart ranges, bounded read/response admission, source replacement, buffer cleanup and permanently latched cleanup failures. Main/renderer/worker and persistence TypeScript checks, lint, JavaScript syntax and `git diff --check` passed. After the compact CSS correction, all 178 UI tests were rerun and passed. Logs are under `tmp/private-playback-stage/`, with agent-focused logs named `tmp/private-playback-*.log` and `tmp/private-source-playback.log`.

The final native acceptance command passed:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-playback-stage/temp npm run test:private-browser:native > tmp/private-playback-stage/native-browser.log 2>&1
```

Two phases and eleven checkpoints verified actual original MP4 decoding and seeking, reuse of a source grant after relocation, distinct opaque playback URLs, unchanged source/catalogue fingerprints, preserved unsaved notes, retired tokens after Stop/selection/details closure, and lock while an original is open. The native fixture observes the manager used by the real protocol to check explicit range bytes and retired-token denial from main; the gallery's `connect-src 'none'` still blocks JavaScript fetch. That restriction caused an early test failure and was preserved when correcting the test.

Visual inspection caught a clipped Stop button at 600 × 400 with unsaved edits. Short windows now devote the area beneath privacy controls to selected details, with a usable scroller and a full Save/Discard footer; closing details restores the gallery controls. The final native check verifies top, centre and bottom hit testing on Stop, and the screenshot was reviewed at `tmp/private-original-playback-small-review.png`. Existing compact source-folder, filmstrip and protection checks passed too.

Thirteen repeated scans covered 241 profile and 639 encrypted-file checks. Reported disk caches and all network counters were zero. Existing source connection/relocation, encrypted regeneration, metadata, password, export, clipboard, automatic-lock and restart regressions passed. These checks use synthetic data and controlled native dialog results within the workspace; they do not establish OS cache or memory erasure, real permission prompts, all codecs, physical-drive reconnection or non-macOS behavior. No user hub was opened. Touch ID remains deferred.

The unsigned Apple Silicon test app is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-playback/mac-arm64/Theatrum Ex Machina.app`. It was built from the dirty checkout recorded above with this exact command:

```sh
test ! -e release-test-private-playback && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-playback TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-playback-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-playback-stage/build.log 2>&1
```

Startup, runtime/media and licensing verification passed. Twenty packaged UI/preload/compiled files were byte-compared with the current build inputs, including the original-stream manager, source descriptor capability, private protocol, gallery bridge, browser lifecycle and earlier source/relocation stage. The media source archive is `release-test-private-playback/theatrum-ex-machina-media-source-v2.0.1.tar.xz`. Earlier test apps and the installed application were preserved; no commit, push, installation or production release was performed.

Packaged-host acceptance passed all five checkpoints with:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-playback TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-playback-stage/temp npm run test:private-package:host > tmp/private-playback-stage/packaged-host.log 2>&1
```

The untouched packaged main completed synthetic conversion, decoded an encrypted preview, saved a note, restored the ordinary workspace after locking, reopened by password and closed cleanly. Six repeated scans covered 215 profile, 35 encrypted-hub and 62 ordinary-tree checks. The original archive and 18 unpacked files remained unchanged. ASAR SHA-256: `d40675856bbc3723b37ec80fb68055845ffd7327b8df0d837af9474b9770ee23`. Detailed original-playback acceptance comes from the native fixture above; this packaged fixture checks the native opening/editing/locking lifecycle.

### Source-folder relocation — 1 October 2026

**Source folders → Change location…** now checks a native-selected folder, asks for confirmation of its path and video count, and changes only the saved root in the encrypted catalogue. Every active referenced location must contain a regular, non-linked file with the same relative name and positive recorded size; rows already marked missing are included. Empty/incomplete sets, malformed source information, symbolic links and overlap with saved roots are refused. This is metadata matching, not comparison of video contents.

The review is a branded main-process capability. It binds the original root and referenced video identities, checks intermediate directories before leaf metadata, and rechecks target directory and file identity/timestamps before the queued save. Original locations are not probed. Directory/file checks yield between bounded chunks, and cancellation disposes retained paths and metadata. These checks do not provide a filesystem sandbox against a concurrent hostile process running as the same user.

The session reserves writer admission before queueing so preview generation and credential operations cannot overlap validation. Its guarded read/compare/write transaction preserves raw catalogue fields, notes, tags, watch settings and missing flags. Native selection, confirmation and saving share cancellation and cleanup drainage. All issued row IDs and source grants retire before saving, including when a save finishes but completion is cancelled or rejected. UI refreshes after every outcome; saved/discarded video drafts are required before relocation. A relocated folder needs a fresh **Connect** action for session access.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; source connections and relocation remain uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |

**501 focused tests passed:** 37 relocation-review, 12 relocation-session, 117 gallery-request, 45 preload, 68 private-browser, 152 UI, 17 metadata and 53 session tests. They cover identity replacement, no leaf probing through linked parents, deep-path cancellation, stale mapping conflicts, concurrent unrelated field preservation, writer exclusion, buffer wiping, failed writes, late cancellation and revoked frame authority. Main/renderer/worker and persistence TypeScript checks, application lint, native-driver/JavaScript syntax and `git diff --check` passed. Logs are in `tmp/private-relocation-stage/` and `tmp/private-sources-stage/relocation-*.log`; helper results are in `tmp/private-sources-stage/source-relocation.log`.

The final native test command passed:

```sh
env TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-relocation-stage/temp npm run test:private-browser:native > tmp/private-relocation-stage/native-browser.log 2>&1
```

Two phases and eleven checkpoints verified incomplete-folder refusal, cancelled confirmation without catalogue changes, saved relocation, retired IDs, original files unchanged, no selected path in the DOM, explicit reconnection, encrypted preview regeneration from the new folder and persistence through a full process restart. Existing cancellation, lock, password, export and clipboard regressions also passed. At 600 × 400, the full first source row and both actions fit; Refresh and Cancel remain reachable through scrolling. Thirteen repeated scans covered 241 profile and 639 encrypted-file checks. All network counters and reported session disk-cache sizes were zero.

These native checks used synthetic files and controlled dialog responses inside the workspace. Real macOS permission dialogs, physically disconnected drives, memory erasure and arbitrary OS traces remain outside this evidence. Touch ID remains deferred. No user hub was opened.

The unsigned Apple Silicon test app is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-relocation/mac-arm64/Theatrum Ex Machina.app`. It was built from the dirty checkout above using this exact command:

```sh
test ! -e release-test-private-relocation && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-relocation TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-relocation-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-relocation-stage/build.log 2>&1
```

Startup, runtime/media and licensing verification passed. Nine packaged UI/preload/compiled files were byte-compared with the current build inputs. The corresponding media source is `release-test-private-relocation/theatrum-ex-machina-media-source-v2.0.1.tar.xz`. Earlier review apps and the installed application were preserved. No commit, push, installation or production release was performed.

Packaged-host acceptance passed all five checkpoints with this command:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-relocation TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-relocation-stage/temp npm run test:private-package:host > tmp/private-relocation-stage/packaged-host.log 2>&1
```

The untouched packaged main completed synthetic conversion, decoded an encrypted preview, saved a note, locked/restored the ordinary workspace, reopened by password and closed cleanly. Six repeated scans covered 215 profile, 35 encrypted-hub and 62 ordinary-tree checks. The original package and its 18 unpacked files remained unchanged. ASAR SHA-256: `9daf4e44042d5751f0ab916127f2e718ce4b3a74347a429eba89b9735152ee32`. Detailed relocation coverage comes from the native fixture above; this packaged fixture checks the opening/editing/locking lifecycle.

### Session source-folder connections — 1 October 2026

The private gallery now lists saved source folders with generic numbered labels, catalogue video counts and session connection status. **Connect** requires native selection of the saved folder; **Disconnect** revokes that session grant. **Refresh** revalidates existing grants without probing unapproved roots. Preview regeneration reuses valid grants, and locking expires them. This stage does not relocate folders, import videos or enable original-video playback. Touch ID remains deferred.

The main process retains source paths and saved source identities. The renderer receives bounded projections with opaque IDs. Connection requests revalidate catalogue identity before and after native selection, share the existing operation gate and discard late picker results after cancellation. Directory replacement invalidates an existing grant; restoring its old inode does not revive it. Teardown revokes access synchronously and drains the pending picker before restoring the ordinary workspace. Opening or refreshing the panel preserves unsaved notes and tag drafts.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
| HEAD | `dea0b90f016692d6b54dfa7a186a80e1047fdde4` |
| Worktree state | Dirty; source-folder stage uncommitted |
| Release designation | `vha.releaseWorktree=false` |
| Runtime | macOS arm64, Node.js `22.23.2`, Electron `42.11.1` |

**483 focused tests passed:** 22 source-access, 106 gallery-request, 43 preload, 138 gallery-UI, 66 private-browser, 13 protocol, 53 session, 30 native-menu, three preload-bridge and nine workspace tests. Main/renderer/worker and persistence TypeScript checks, application lint, JavaScript syntax and `git diff --check` passed. Logs are in `tmp/private-sources-stage/`.

The native Electron acceptance fixture passed two phases and eleven checkpoints, including explicit connection, disconnection, cancellation of a late successful picker, directory replacement, reconnection, regeneration grant reuse and grant expiry after locking. At the 600 × 400 minimum window size, the first source row and its action are fully visible without scrolling, and Refresh and Cancel are reachable by panel scrolling. Fingerprints verified that connection controls did not rewrite source or encrypted catalogue files. Existing encrypted preview, metadata, password, clipboard, automatic-lock and restart checks also passed. All network counters were zero and each reported session cache size was zero. Thirteen scans covered 241 profile and 636 encrypted-file checks across repeated stages.

Native checks use synthetic catalogues, files and controlled picker results inside the workspace. They do not verify real macOS permission prompts, a physically disconnected drive, process memory or every possible OS trace. No user hub was opened for this stage.

The unsigned Apple Silicon test app is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-private-sources/mac-arm64/Theatrum Ex Machina.app`. The corresponding media source is `release-test-private-sources/theatrum-ex-machina-media-source-v2.0.1.tar.xz`. It was built from the dirty checkout recorded above, with this exact successful command:

```sh
test ! -e release-test-private-sources && THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-sources TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-sources-stage/temp npm_config_cache=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/npm-cache ELECTRON_BUILDER_CACHE=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/electron-builder-cache CSC_IDENTITY_AUTO_DISCOVERY=false npm run electron:mac:private:test > tmp/private-sources-stage/build.log 2>&1
```

The package startup, runtime/media and licensing verifier passed. Six packaged UI/preload/compiled bridge files were byte-compared with the current build inputs. Previous test apps and the installed application were preserved. No commit, push, installation or production release was performed.

The packaged-host acceptance also passed all five checkpoints with:

```sh
THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-sources TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-sources-stage/temp npm run test:private-package:host > tmp/private-sources-stage/packaged-host.log 2>&1
```

The untouched packaged main created a synthetic private copy through the native menu, decoded its preview, saved an encrypted note, locked/restored the ordinary workspace, reopened by password with the note intact and closed cleanly. Six scans covered 215 profile, 35 encrypted-hub and 62 ordinary-tree checks across repeated stages. The package and its 18 unpacked files remained unchanged. ASAR SHA-256: `6fc5e2b25b78095d8caa5a0cf0700a0db9a595c4bee956fa75383bc60062cdb4`. This packaged test covers the complete opening/editing/locking lifecycle; detailed source connection and compact-layout acceptance comes from the native fixture above.

### Catalogue metadata false positive — 23 September 2026

A catalogue metadata update can advance the filesystem change timestamp (`ctime`) without changing the contents or modification timestamp (`mtime`). The previous validation treated that metadata change as a catalogue edit and refused conversion.

A three-second delay in the synthetic packaged picker, without deliberate metadata changes, passed. Reapplying the synthetic catalogue's existing permissions after review then reproduced the exact `source-changed` error in the previous package, while its bytes, size, modification time, inode and permissions remained unchanged. The failure was recorded in `tmp/private-picker-ctime-red-host.log` and `tmp/private-picker-ctime-red-diagnostic.json`. Three headless metadata-only success cases also failed before the fix.

Catalogue comparison now uses its exact SHA-256 content digest together with path, device/inode, size and modification time. A metadata-only `ctime` difference during validation triggers a fresh read through the existing descriptor/identity checks and requires the original content digest to match. The digest remains available after plaintext buffers are wiped. Preview-file and directory checks are unchanged. Same-size content edits with restored modification times remain rejected; cancellation, uncertain descriptor closure and buffer wiping retain their existing handling.

All **60 focused conversion tests** passed: 30 review tests, including seven new metadata/content/cancellation/cleanup cases, and 30 converter tests. Main/renderer/worker and persistence TypeScript checks, application lint, targeted converter/test lint, native-driver syntax and `git diff --check` passed. Logs include `tmp/private-catalogue-metadata-red.log`, `tmp/private-catalogue-metadata-green.log`, `tmp/private-metadata-conversion.log`, `tmp/private-metadata-check.log` and `tmp/private-metadata-persistence-types.log`.

| Field | Value |
| --- | --- |
| Repository root | `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs` |
| Origin | `https://github.com/sebiimaks/Theatrum-Ex-Machina.git` |
| Development workstream | Private hubs |
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
| Development workstream | Private hubs |
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
| Development workstream | Private hubs |
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
| Development workstream | Private hubs |
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
| Development workstream | Private hubs |
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

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, the private-hub development worktree, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The worktree remains intentionally dirty with preceding privacy work. The existing compiled Angular assets in `tmp/private-transition-angular`, native helper and media tools were reused unchanged. No browser/helper build, application package, install, commit, push or release was performed.

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

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, the private-hub development worktree, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The worktree remains intentionally dirty with preceding work and these changes. Existing native helpers and media tools were reused; no browser/helper build, application package, install, commit, push or release was performed.

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

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, the private-hub development worktree, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The worktree remains intentionally dirty with the preceding work and these changes. No application package, browser build, install, commit, push or release was performed.

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

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, the private-hub development worktree, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The checkout remains intentionally dirty with the preceding uncommitted work and this milestone. The successful production Angular assets at `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp/private-transition-angular` were reused unchanged. No additional browser build, application package, install, commit, push or release was performed.

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

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, the private-hub development worktree, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. The checkout is intentionally dirty: the earlier filmstrip changes and this integration work are uncommitted. No commit, push, release package or installed-application change is part of this milestone.

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

This milestone uses `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`, the private-hub development worktree, HEAD `0bfe180d953875654d72354796770d648623e2ea`, origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. Preflight found a clean checkout; the filmstrip changes are uncommitted. No native helper or application package was built, and no application was installed or released during this milestone.

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

Development compilation uses `npm run privacy:build`, which builds the advisory-lock helper and runs `node bin/build-touch-id.mjs` on macOS. The Touch ID artifact is `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/build/privacy-tools/private-touch-id.node`, built from the dirty private-hub development worktree at `de9922a22cf2bee4b5b9456f4dfc03a77ab8ad79`, with the root and fork recorded above. No application was packaged, signed, installed, committed or pushed. See [Touch ID controls and signing acceptance](./private-hubs-touch-id.md).

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
