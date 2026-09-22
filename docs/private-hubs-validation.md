# Private-hub development validation — 22 September 2026

This record covers experimental storage, generation, browser isolation, the dedicated password/opening workflow, the normal-application pause boundary, the saved-document/application transition adapters, the connected ordinary renderer safeguards, the main host lifecycle integration, and the private gallery with encrypted notes/tag editing, native source selection, per-video encrypted preview regeneration, encrypted automatic-lock settings, authenticated password changes, verified unprotected copies, and native menu/clipboard controls. It is not an application release. Private hubs remain unavailable through the normal app interface. All catalogue, password, and media fixtures were synthetic; no existing user hub was converted.

## Checkout and native helper build

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

## Checks

Run commands from the repository root above, with `TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp` for filesystem tests.

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
- The DOM handoff refuses unfinished composition, blocks the entire body and overlay inputs, pauses ordinary previews and suppresses delayed clip playback. The synthetic native renderer fixture verifies browser input/media behavior; hardware IME, native edit menus and the complete application transition still require acceptance tests.
- The saved-document exchange accepts only one nonce-bound response from the original live main frame. Cancellation waits for a pending write. An issued proof remains held across later private cancellation until the transition explicitly releases it. Renderer revision checks preserve late unsaved edits.
- The concrete snapshot writer captures the normal destination and authority after pause, validates the entire writable document, and never substitutes a new target on failure. Changed source/media authority or a replaced catalogue prevents late authority publication.
- Renderer release now follows successful main admission. A failed release send re-seals normal work and prevents a quit retry or another private opening; window-restore failure never sends the release.
- External private lifecycle mode requires a revocation signal and suppresses autonomous browser/workspace quit retries. The parent transition observes system/window events before native selection and retains its observers and normal freeze when private disposal fails.
- Normal restoration rechecks the original window/frame and pause proof after the native show operation. Quit retries only after clean disposal and normal restoration; a main-owned acknowledgement of Keep Working may restore future private admission without replaying an older quit request.

The normal close guard, trusted close-cancel acknowledgement, deferred catalogue opens, ordinary progress/source restoration, private notes/tag editing, per-video regeneration with session-only folder grants, encrypted automatic-lock settings, authenticated password changes and verified unprotected copies are connected behind the disabled readiness gate. Their regression and compilation checks are recorded above. The full native application transition, real OS permission prompts, source import/relocation and other protected preview operations, complete conversion activation and real Touch ID authentication in a provisioned signed build, broader native cache/crash verification, and native-helper packaging remain integration gates. Native picker history, the complete application menu handoff, real OS paste and other platforms' selection/clipboard behavior still need review. The tests do not establish that the complete application is ready to handle private hubs.

At the end of the Touch ID milestone, the production checkout `/Users/sm/Workspace/Theatrum-Ex-Machina` was confirmed clean on `main` at the same HEAD and origin, with `vha.releaseWorktree=true`. Current work remains in the development checkout; no commits, pushes, releases or installed-application changes are part of this milestone. See [the design](./private-hubs.md) and [live renderer integration checklist](./private-hubs-renderer-integration.md) for the work required before enabling private hubs.
