# Live renderer integration status

The ordinary renderer implements the saved-document handoff, and the main host owns the transition singleton and close/quit integration. The macOS development build enables **File → Create private copy…** and **File → Open private hub…** for the first password-based private-hub workflow. The private gallery includes encrypted notes/tag editing, per-video preview regeneration, automatic locking, authenticated password changes and verified unprotected copies. Touch ID is deferred. See the [first-build guide](./private-hubs-first-build.md) for supported operations and review directions; this is not a production release.

## Implemented

- Home uses the dedicated request/snapshot/release channels through the reviewed preload allowlists. Each active writable hub supplies its full catalogue, even when clean; only no-hub and read-only sessions supply `null`. The projection includes notes, source locations, manual tag definitions/colors, automatic tags and screenshot settings.
- A shared renderer mutation lifetime records every persisted edit, including repeated writes to an already-true dirty flag. Image, automatic-tag and manual-tag services guard their mutators. Save acknowledgements clear bookkeeping without replacing live tag arrays.
- The catalogue editor registers a synchronous row-tag draft flusher. Valid drafts, including rows outside the current filter, commit before the frozen revision is captured. Invalid tag paths refuse the handoff. Unapplied bulk commands remain unapplied.
- Composition tracking refuses the handoff while IME text entry is unfinished. The DOM guard blurs the active input before snapshotting, makes the entire body inert (including Material overlays), blocks editing/clipboard/drag events, pauses ordinary media and disables existing autoplay. Delayed clip playback, reload retries and detached clips also check their captured mutation lifetime.
- Editor, tag-tray and Home confirmation callbacks retain their original mutation epoch. Pausing invalidates them permanently, including after handback. Existing dialogs close during handback, after main admission resumes.
- Native invokes retain a renderer pending hold through their immediate `.then`/`await` consumers, until the next event-loop task. Handoff is refused while a hold or ordinary save/close request is pending. Direct asynchronous clipboard writes also retain a hold. Future consumers that defer model application beyond that task must retain an explicit hold through the entire update.
- Incoming ordinary IPC callbacks are deferred while frozen, then replayed in order. They invalidate the saved revision and are never silently discarded. Unsubscribed listeners stay unsubscribed. A partially applied failing callback is not retried: the editor is quarantined.
- The native factory prepares the release after private disposal, restores the normal window while still paused, reopens main admission, then sends the renderer release. A failed release send re-seals normal admission. Optional monitoring/queue refresh remains separate from this critical handback.

## Connected host lifecycle

- `main.ts` owns one `PrivateApplicationWorkspace`; constructing it opens no files, sessions or windows. Its native File entries refuse inherited ordinary operation scopes and add no ordinary renderer capabilities.
- Normal close, shutdown and window-all-closed paths delegate to the active private transition before sending `please-shut-down-ASAP`. Private disposal and normal restoration must finish before the ordinary save/quit flow retries.
- Only a main-proven Keep Working choice or close-save failure acknowledges an abandoned quit. The notification captures the original window, frame, navigation and catalogue authority, rather than trusting a separate renderer cancellation message.
- Normal catalogue-open requests received during private use stay in a bounded, deduplicated memory queue. They obtain filesystem authority only after returning to normal admission. A pending private quit continues to defer those requests and blocks renderer catalogue changes and source checks until the main process confirms Keep Working or a close failure; a settings-error dialog cannot let a new hub replace its original owner.
- After clean settlement, a fresh main operation resets transient renderer progress, restores source monitoring and dispatches deferred normal opens. The renderer preserves catalogue edits and source grants while clearing interrupted scan/generation indicators.

## Private gallery

The isolated gallery supports paged browsing, title/tag search, selected video details, explicit notes/tag Save and Discard, encrypted clip playback, on-demand filmstrip viewing, preview regeneration with cancellation, encrypted inactivity settings, and locking. A separate preload exposes only list, detail, save, regenerate, cancelRegeneration, protection, setProtection and lock. Main validates the exact live window/frame/generation, limits metadata and page size, issues per-window selection/revision IDs, and rejects stale completions. No normal preload, source paths, keys or full catalogue are supplied to this renderer. Ordinary file actions remain outside this bridge.

The session performs each metadata edit as a queued read/compare/write transaction against the selected row's complete private revision. Changed rows conflict instead of being overwritten; unrelated catalogue fields and legacy tag strings survive. Storage rechecks the captured authority before encrypted publication. Oversized persisted metadata stays read-only, and browser navigation cannot silently discard a draft. Lock clears drafts immediately and invalidates late save responses; a write already admitted to the filesystem may have completed.

Regeneration accepts only an issued ID/revision and uses a native picker for the preferred source root from encrypted storage. Grants stay in main-process memory and expire with the browser; root replacement invalidates reuse. A pending picker is drained during teardown and cannot grant access after cancellation. Dirty drafts refuse generation; accepted jobs stop playback and hold editing/navigation until completion, while Cancel and Lock remain available. Failed descriptor closure or an unconfirmed decoder exit revokes the session and prevents normal restoration. Source relocation, imports, changed preview geometry and original-file actions remain unavailable.

Protection reads and saves one encrypted per-hub timeout: Off, 1, 5, 15 or 30 minutes, with five minutes as the default. It shares the bridge's pending-operation gate and preserves video drafts. Main owns the timer and renews it only for native key, button and wheel events. DOM activity, IPC and media playback cannot keep the hub unlocked. An expired deadline cannot be extended by a late input or save; changing the policy preserves elapsed inactivity. Automatic locking uses the same destructive teardown and cleanup path as Lock hub. Off does not disable sleep or screen-lock handling.

The separate `privateCredentials.changePassword` method submits only bounded current/new passwords from the same isolated private window. It shares the gallery's pending-operation gate, rechecks exact frame/generation authority, and returns no credentials or storage diagnostics. The store verifies the current header/password and atomically replaces only the wrapped key. The session buffers queued credentials for synchronous wiping on lock, blocks competing writers/generation, and rechecks final authority. A successful request locks the session independently of window cleanup, awaits its storage drain and quarantines failed observers; late retry responses cannot reach a revoked frame.

Protection includes a collapsible three-field form. It requires saved/discarded video drafts, preserves password text exactly, clears fields before IPC and on concealment/focus loss, stops playback and keeps Lock available while pending. The new password is confirmed locally. Old copies of the hub/header retain their original password because this operation does not rotate the data key.

`privateCredentials.createUnprotectedCopy` accepts only a bounded password and explicit acknowledgement; `cancelUnprotectedCopy` cancels the current admitted copy. Both share the credential/gallery pending gate. Session reauthentication finishes and its owned password buffer is wiped before the main-owned native destination picker runs. No source or output path crosses the renderer bridge. A wrong password is retryable, successful copying keeps the encrypted session open, and cancellation/failure never promises removal of partial plaintext files.

Protection contains a separate masked-password and acknowledgement form. Video drafts and unsaved protection settings must be resolved first. Submission immediately clears the controls, pauses preview playback and keeps Cancel copy and Lock hub reachable. The native picker and exporter stay inside session/browser drainage; late selections cannot publish after revocation. An unconfirmed exporter descriptor/iterator cleanup permanently quarantines restoration, including when failure arrives after locking started.

The thumbnail/poster/filmstrip queue is limited to three simultaneous images, reserving capacity for a selected clip. Filmstrips load only after an explicit Show filmstrip action and remain confined to the selected details panel. Hiding the strip cancels its job and retries; selection changes, regeneration, protection operations and lock clear it. Late image callbacks cannot repaint a closed or replaced selection. Details alone carry the fixed filmstrip URL; no new IPC method or source authority is introduced. Page changes, selection changes and lock cancel stale UI work and remove old media sources. Native verification is recorded in [the validation log](./private-hubs-validation.md).

## Native controls

`PrivateHubBrowser` acquires an app-wide menu lease before its first asynchronous setup step and before renderer allocation. Per-window `setMenu(null)` alone does not cover macOS's application menu. The lease installs a restricted menu, preserves the original Menu object, validates ownership, and binds custom actions to one private window. Cleanup releases it only after browser destruction and all private drainage, using `revocationDrained(generation)` captured while the session is current to cover externally initiated locks. A poisoned global owner keeps its cleanup-failure classification on later acquisition attempts, preventing the outer transition from treating that state as a safely disposed prompt.

Both password and gallery documents cancel export events. Credential-only paste predicates require exact focused, visible and enabled inputs and current page/form state. Native keyboard filtering applies to both windows, precedes DOM/menu dispatch and retains native idle activity tracking. Deliberate paste and selection are forwarded only to the current focused private web contents; no clipboard data or edit command is exposed through either preload. Closed-window callbacks are ignored and cannot poison an otherwise clean menu restoration.

The separate native private-browser harness verifies these controls with an ordinary synthetic application menu, real Copy/Cut and keyboard commands, safe clipboard backstops and synthetic paste events. It never reads or overwrites the user's clipboard. The full Angular transition, real OS paste behavior and platform selection buffers are not covered by that fixture.

## Actual Angular/native composition verification

`npm run test:private-application:native` now exercises the compiled Angular Home and catalogue editor with the production normal preload, `createPrivateApplicationWorkspace`, saved-document writer, ordinary media protocol, isolated password screen and private gallery. The eight-stage synthetic run saves normal notes and an uncommitted row-tag draft before opening, holds normal input and media admission while private, edits encrypted notes, and restores the ordinary window and exact menu after Lock. It also checks unlock cancellation, synthetic composition events, invalid tag-draft refusal, a real filesystem save failure, an intercepted quit retry, main-owned quit-cancellation acknowledgement and subsequent reopening.

The harness supplies a synthetic startup adapter, source pause/resume callbacks, directory-picker selection and ordinary menu. It does not launch `main.ts`, real watchers or extraction queues, the actual ordinary quit/save dialogue, hardware IME, system sleep/lock events, conversion activation or signed Touch ID. The ordinary protocol and operation scope are real; the media-denial check does not establish live extraction or watcher drainage. This factory-level fixture does not test the native File menu entry.

The production Angular build exposed renderer imports of main-process state through Home and file-size presentation. Both now use public build/platform metadata instead. A runtime import-graph regression check rejects main-process storage and privileged Node dependencies reachable from the application and tag-worker entry points. Compilation and the native fixture retain the normal CSP and context isolation.

Compile the acceptance assets, then run the harness from the development repository root:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp node_modules/.bin/ng build --configuration production --base-href ./ --output-path tmp/private-transition-angular
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-application:native
```

The output directory contains test-only browser assets; these commands do not package or install the application. Review results and scan limits in [the validation log](./private-hubs-validation.md).

## Actual main-host verification

`npm run test:private-host:native` extends the preceding fixture to the actual `main.ts` singleton, startup, source grants, watchers, scan/extraction queues, normal IPC and close/save handlers. It reuses the production Angular assets built above. The test compiler validates the production macOS admission and native menu registration, then changes only the ordinary preload/asset paths in an in-memory copy, adding a frozen main-process driver. It does not replace the readiness gate or menu callbacks and adds no test switch to the application.

Seven native stages verify normal draft snapshotting, isolated opening, ordinary watcher closure during private use, and watcher/scan recovery after Lock. A synthetic video added while private is discovered after normal restoration. A legacy minimize IPC request from the ordinary preload is denied while private. The actual catalogue-close failure flow preserves the live draft when **Keep Working** is chosen. A separate private quit reaches the actual settings-write error handler: while its acknowledgement is held, a second catalogue request stays deferred and cannot gain authority; the trusted acknowledgement releases it. Reopening/cancelling and a final normal window close verify ordinary settings and catalogue persistence.

The fixture automates native dialog choices to owned synthetic paths and records recent-document API calls without forwarding them to macOS. Single-instance APIs are substituted because the native macOS socket does not stay inside the redirected fixture temporary directory. Cross-process arbitration is therefore outside this test. Its private hub has a direct synthetic activation marker; conversion UI and first-activation receipt acceptance are tested separately. Real OS permission dialogs, sleep/lock events, forced crashes, hardware IME, real clipboard behavior and signed Touch ID remain unverified.

After compiling the acceptance assets above, run:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-host:native
```

## Conversion cleanup propagation

Conversion now confirms its source descriptor closures, producer/verification iterator returns and final `store.lock()` settlement. Individual descriptor/iterator cleanup has a five-second deadline. Final store drainage has a separate thirty-second deadline to accommodate sequential queued work and lease shutdown. A failure or timeout receives a main-process identity brand and remains an error even if the original operation later succeeds. The completion event follows confirmed closure. First activation retains this brand through its public generic unlock error; session disposal and the outer application transition remain quarantined instead of restoring ordinary admission.

Store-owned file and directory handles now use bounded close confirmation, and lease release confirms both helper closure and the parent descriptor. Failures revoke keys/admission and keep the directory quarantined for the process lifetime. Static create/open failures, Touch ID availability and adopted or late-open session drainage preserve the identity brand. Repeated disposal and late settlement cannot restore ordinary admission.

The deadline starts when cleanup begins; it does not bound a stalled read or iterator advance before cleanup. Helper shutdown allows a five-second graceful period, then five seconds to confirm termination; the parent descriptor has its own five-second close deadline. No timeout is evidence of successful closure. Broader native cleanup fault acceptance remains outstanding.

## Conversion inventory review

`reviewCatalogueForPrivateConversion` provides a read-only preparation step for the isolated conversion flow. It opens only the ordinary catalogue, stats referenced preview paths, and returns frozen counts: unique referenced videos, available previews, total preview bytes and missing counts for thumbnails, filmstrips, clip posters and clips. It reads no preview payloads or original media paths, writes nothing and accepts no password. Main retains the exact review object and source writer exclusion; only a cloned count-only display reaches the private document.

Conversion consumes an issued review once, checks the same source-exclusion callback and cancellation signal, rescans the inventory and compares catalogue content plus source identities before creating output. Missing-preview consent now requires that exact review. Forged, cloned, reused and stale reviews fail before destination creation. Complete-hub foundation callers may still convert without a review. The isolated confirmation/password/progress UI, native destination selection and conversion/activation controller are connected to the macOS native creation entry.

## Create private copy

The main-only `PrivateApplicationWorkspace.convert()` action captures the current authorized, writable, canonical ordinary catalogue. It shares the existing opening admission and host lifecycle. It pauses ordinary work, freezes and saves renderer drafts, then hides the normal window before reviewing the source. `createPrivateCopyFromNative` is registered directly with the macOS File menu; `PRIVATE_HUB_UI_READY` admits macOS only.

`createPrivateConversionWorkspace` uses the opening coordinator's `prepareHub` stage under the same process-wide reservation as password unlock. One source-exclusion closure and one cancellation signal bind inventory review and conversion. The separate `private-conversion` document has a standalone preload and an exact three-asset protocol allowlist with no media authority. Its bridge exposes only count-only state, one password/consent submission, and cancellation. No source path, destination path, receipt, catalogue, native error or Electron event enters either the conversion document or the ordinary interface.

The form shows counts, password confirmation and separate acknowledgements for retained originals and missing previews. Submission clears credentials before IPC, then a window-owned native save dialog chooses a new destination. Progress uses bounded, nonoverlapping polling. Cancellation remains available while the native picker or conversion is pending. A failure leaves a generic close-only screen; starting over requires a new review. Partial encrypted output is retained, and the original unencrypted catalogue, previews, backups and source videos remain in place.

Retirement aborts conversion synchronously, destroys the document and waits for the admitted request, native picker and conversion cleanup. Branded conversion/storage uncertainty and failed retirement callbacks reject disposal and retain quarantine. Browser cleanup completes before the prepared destination/password enters `PrivateHubSession.unlock`; first activation independently verifies the encrypted receipt and media before publishing the activation marker and showing the gallery. A cancelled late result cannot activate or show a window. On clean Lock/cancel, the original ordinary workspace is restored through the existing saved-document release path.

The password is copied into a main-owned buffer while selecting and creating the destination, wiped on cancellation and after use, and promptly released from bridge/browser parameters. This reduces owned retention; immutable JavaScript strings, IPC copies and operating-system memory cannot be securely erased. Touch ID enrollment remains implemented as a separate authenticated gallery control, but biometric work is deferred from this unsigned password-based build.

`npm run test:private-conversion:native` passed review, native-picker cancellation, conversion/gallery handoff and lock/readback against the actual conversion workspace. The extended `npm run test:private-host:native` also passed creation through actual main/Angular pause-and-save: pending notes/tag drafts were copied, a late successful picker result after cancellation created no output, receipt/activation were verified, and password reopening with private editing preserved the entire ordinary source tree. The real watcher stopped and resumed across these handoffs. Both fixtures automate native dialog answers; OS history/permissions and failure coverage remain bounded. See [the validation record](./private-hubs-validation.md#private-copy-creation-through-the-actual-main-host--23-september-2026) for commands, counts and limits.

## Packaged runtime verification

The local unsigned macOS test package built with `npm run electron:mac:test` passed the standard package verifier, including startup of the untouched application's ordinary renderer. Main and preload compile as CommonJS. The isolated documents and preloads are physical files in `app.asar.unpacked`; a fixed main-owned resolver maps only the current module archive's known UI directories and preloads. Static reads retain their canonical-path, no-link and file-descriptor identity checks. Native helpers load from the fixed `Resources/privacy-tools` directory.

`npm run test:private-package:native` passed five stages covering the packaged native lock helper and Touch ID addon loading, static resources for all three private documents, isolated password/conversion screens and cancellation, encrypted thumbnail/notes rendering, and drained gallery cleanup. The run verified hashes for eighteen unpacked files and completed six persistence scans with 93 profile and 30 encrypted-hub file checks. File counts include repeated checks across stages. Scans search for the synthetic password and private-content markers in UTF-8/UTF-16 and filenames; they do not prove OS memory/cache erasure or detect every transformed media copy.

The harness keeps the built test application unchanged. It copies the application to a disposable Workspace fixture, preserves the exact packaged application archive as `payload.asar` with byte-identical physical UI assets and native resources, and adds a separate test launcher. It does not change fuses or register private application entries. The fixture runs with `app.isPackaged` true and calls archived private factories directly. Its gallery starts from a synthetic pre-existing encrypted hub; conversion submission, the untouched packaged app's complete normal/private host transition and signed Touch ID are outside this run. The Touch ID check loads the addon and checks availability only; it does not access a real Keychain item or authenticate a fingerprint.

After building the local test package, run from the development repository root:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/tmp npm run test:private-package:native
```

The default input is `release-test/mac-arm64/Theatrum Ex Machina.app`. The harness does not build, install or release the app. See [the validation log](./private-hubs-validation.md) for the exact build identity, commands and remaining acceptance boundaries.

## Remaining integration

The first working password build additionally passed `npm run test:private-package:host`: it loads the untouched packaged main, invokes the real native menu, creates a private copy, saves notes, locks, password reopens, restores the ordinary workspace and closes with settings saved. See [the latest build record](./private-hubs-validation.md#first-working-password-based-macos-test-build--23-september-2026). Native picker/system adapters remain controlled by the fixture.

The local test package and exact-material private fixture have passed. The native macOS entries are now connected for password-based review. Final acceptance of the complete packaged host workflow is recorded separately in the validation log; the module-level fixture does not replace that check.

The separate private gallery and narrow metadata bridge are implemented. Extend source selection beyond per-video regeneration, actual-host failure/reconnection coverage, platform clipboard behavior and native picker history. Do not expose private paths, passwords or decrypted catalogues through the ordinary bridge. Touch ID signing and interactive verification remain deferred follow-up work.

## Verification boundary

Runtime tests execute production Home, ElectronService, catalogue editor and mutation services with synthetic state and stubbed Angular decorators/native UI. They cover complete snapshots, draft/IME refusal, native-result preservation, failed saves, exact releases, stale callbacks and quarantined failures. Separate Angular no-emit compilation validates templates and dependency injection. These checks do not replace the complete running application transition.

The separate `npm run test:renderer-handoff:native` harness has passed six stages using the production renderer coordinators in a sandboxed, context-isolated Electron window. It verifies native text insertion, row-draft capture, inert body/overlay controls, beforeinput/keyboard blocking, real clip pause/autoplay suppression, focus restoration, deferred native results, composition-event and invalid-draft refusal, pending invokes, repeated handoffs and failure quarantine. Its UI and main adapter are synthetic; it does not verify hardware IME, native application menus, the Angular Home/private-gallery transition or OS cache erasure.

Continue extending the actual-host native checks to reconnection, in-flight generation/playback, pending confirmations and hardware IME. Extend filesystem-save and cleanup fault coverage, and test cancellation at each transition stage, real lock/sleep, navigation and forced crashes. Verify native edit-menu behavior, real clipboard behavior, single-instance arbitration and buffer/cache observations on supported platforms.

Touch ID enrollment, removal and unlock choices remain implemented in the private documents and main-process session, with further work deferred while password-based review proceeds. See [the Touch ID guide](./private-hubs-touch-id.md) for the signing gate and the difference between synthetic-provider UI verification and real biometric acceptance.
