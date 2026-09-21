# Workbench interface redesign — review checkpoint 7

Branch: `codex/workbench-ui-redesign`

Base: `503d2e4fcb726952d73533599efb6ad1fa967a4b`

Worktree: `/Users/sm/Workspace/Theatrum-Ex-Machina-redesign`

This review checkpoint translates the Workbench concept into the existing Angular application. It is a development checkpoint for review, not a packaged release.

## Review the running interface

Open http://127.0.0.1:8767/review.html while the local review server is running. The preview uses the compiled application with 18 fictional videos, original sample thumbnails/filmstrips/clips, a source tree, ratings, tags and playlist entries. Changes reset on reload. File operations and external playback show preview notices.

Try the video inspector, the rename dialog, and Library tools → Catalogue editor / New catalogue, along with the seven views, search and filters, Settings search, and Library & sources. Useful feedback is whether controls are easy to find, whether information density feels right, and which repeated tasks still take too many steps.

Local restart instructions are in ignored `tmp/ui/README.md`; run `node tmp/ui/preview-server.cjs` from this worktree. The server binds only to 127.0.0.1.

## Implemented

- Persistent catalogue switcher, global search, seven-view selector and Settings access.
- Collapsible pinned toolbar, retaining the existing configurable controls.
- Library navigation for all videos, folders, favourites, playlist and recently played. Collection changes retain search terms and choose a compatible view for folder browsing.
- Gallery toolbar for sorting, filters, tags, details and preview scale.
- Compact file rows with aligned metadata columns, accessible favourite controls, selection/playlist indicators and responsive column visibility. The existing 30px virtual row geometry is retained.
- Searchable Settings workspace with eleven categories: Appearance, Gallery & previews, Playback, Search & filters, Sorting, Tags & notes, Library & sources, Import & creation, Keyboard shortcuts, Maintenance and About.
- All 94 existing settings keys mapped into the new settings structure. Setting values and toolbar visibility remain independent controls. Actions and gallery-view choices use distinct controls.
- Existing source management, catalogue statistics, shortcuts, external-player selection, language/zoom, file extensions and About controls remain available. Search offers navigation to source management and shortcuts.
- Shared Workbench surfaces and accent colours for light and dark themes.
- Persistent filter labels, keyboard-removable search terms, separate tag-completion hints and a direct link to filter preferences. Secondary library tools use a collapsible group.
- Consistent gallery preview surfaces and native keyboard-accessible favourite, playlist and details buttons, with existing virtual-scroll measurements retained.
- Clear Add folder / Edit folders actions, visible scanning explanations, and edit-mode thumbnail maintenance. Existing read-only, busy-state and confirmation safeguards remain.
- More compact preference rows and matching primary-action colours.
- Always-visible Expand all / Collapse all tag controls and larger branch arrows. Collapse works during tag searches; clearing the search restores the prior ordinary tree expansion. The review fixture uses canonical hierarchical tags, including a three-level branch.

- Redesigned video inspector with separate metadata, file location and preview sections; visible Close, native frame/cover/path buttons, bounded zoom controls, labelled ratings/year/notes, explicit tag Add and visible tag removal.
- Explicit inspector frame buttons open playback independently of the gallery double-click setting. The first frame now resolves its timestamp correctly when timestamp playback is enabled for the selected player.
- Open/create catalogue screen with native recent-catalogue buttons and collapsible preview options. Existing screenshot/clip configuration and creation guards remain intact.
- Responsive rename dialog with current filename, labelled new filename, fixed extension and error/busy feedback. Informational dialogs have a visible Close button.
- Catalogue editor with persistent header Save, collapsible bulk changes and scroll access at short window heights. Search, metadata-transfer previews, bulk scope, confirmations and save guards remain unchanged.
- Shared light/dark Workbench palette now reaches the wizard and body-level dialogs. An isolated gallery stacking context keeps toolbars below modal surfaces.
- Keyboard focus stays within Settings, the inspector, catalogue editor, rename/create screens and tag colour picker, and returns to the opening control when closed. Escape dismisses the current surface, respects tag drafts and editor validation, and preserves busy-operation guards. Native text editing does not trigger background workspace shortcuts.
- Video action menu uses native buttons with arrow-key, Home/End and Escape navigation. Tag colour swatches have accessible names and a visible Close button. Shortcut capture supports Escape cancellation and Tab navigation.
- Catalogue editor moves focus to Close while saving or importing/exporting metadata, keeps both Tab directions within the busy dialog, and restores the previous control after completion.

- Pinned controls stay on one horizontally scrollable row at narrow widths, with a visible native scrollbar and automatic scrolling to keyboard focus. The fixed 40px ribbon height is retained.
- Empty results explain recovery options, empty catalogues link to source management, and catalogues without clip previews offer a direct return to thumbnails. Search/view focus is restored after recovery.
- Gallery favourite, playlist and details actions include the video name in their accessible labels.
- Recently played is a played-only collection, independent of sorting. The Recent tray uses the same playback-history rule; resetting play counts preserves history. Collection changes retain search terms.
- Compact Settings stack category navigation above the content and keep search, close and zoom recovery reachable. At very short heights the whole settings surface can scroll.
- Bottom trays overlay the gallery in short windows, with independently scrolling content and a keyboard-accessible Close button that restores focus to the active tray tab. Narrow toolbars scroll, Settings stays reachable, and the sidebar and breadcrumbs share the gallery width. Context menus stay within the viewport and scroll when necessary.

- New Workbench labels and revised welcome/creation guidance are translated into all 19 supported non-English languages. Translation keys and interpolation placeholders are checked against English. The Settings language selector retains its selected value when its card is recreated by category navigation or search.
- The inspector updates its displayed/copyable file path immediately after a rename, and clearly labels the filename control as a disk rename.
- At maximum application zoom and the minimum native window size, keyboard-focused settings controls remain visible below the Close button.
- Creating a catalogue saves the current dirty catalogue before creating new folders or changing the active session. Save or authority-validation failures leave the previous catalogue and renderer source/output state intact.
- Import completion refreshes generated thumbnail, filmstrip and clip URLs, including folder/inspector previews. This fixes initial missing images without recreating gallery cards or resetting selection and hover state.

## Validation

Checks for checkpoints 1–3 passed on 18 September 2026; checkpoint 4 passed on 19 September 2026 (Australia/Brisbane). The builds for checkpoints 1–4 used this worktree on `design/workbench-ui` at the base commit above with uncommitted changes (dirty working tree), expected origin `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`, and `vha.releaseWorktree=false`. Output: `/Users/sm/Workspace/Theatrum-Ex-Machina-redesign/dist/`.

- `npm run check` — TypeScript and lint.
- `npm run build:prod` — unpackaged compilation to `dist/`; no Electron release packaging.
- Settings presentation/workspace, collection navigation, gallery geometry, virtual scrolling, settings startup and tag hierarchy tests.
- Browser checks passed for settings search, category navigation, source-management access, theme switching, library search, retained search when changing collections, pinned-toolbar geometry, view transitions, the tags panel at 900px, and accessible settings/sorting at 420px.
- Second-pass browser checks: all seven gallery modes render without console errors; clips load and decode; filter entry/removal and keyboard favourite controls work; source editing exposes maintenance actions; source settings adapt at 680px.
- Browser smoke checks use the actual compiled Angular application with an ignored, local IPC fixture and fictional catalogue data. They do not open or modify a real catalogue.
- Tag-collapse feedback fix: 38 hierarchy tests pass, including five expansion/search-state regressions; TypeScript, lint and `npm run build:prod` pass. Browser checks confirm individual and global collapse during search, keyboard activation, restoration after clearing search, and no console errors.
- Third-pass checks: catalogue editor 18/18, metadata transfer 16/16, dialog presentation 4/4, settings presentation 13/13, gallery layout 7/7, virtual scroll 11/11, tag hierarchy 38/38; TypeScript and lint pass.
- Third-pass browser checks: add/remove hierarchical tags (including keyboard removal), both inspector zoom limits, frame playback dispatch, cover selection, explicit Close, correct modal layering, shared light/dark theme, all wizard preview options, rename empty/changed validation, filtered bulk confirmation and cancellation, and shared metadata controls in Details view. No console errors observed.
- Responsive checks: inspector, rename and editor at 420px; editor at 500×250 with its entry fields reachable by scrolling. Bulk cancellation retained the original Year value for the six filtered sample entries.
- Fourth-pass checks: dialog keyboard 4/4, settings presentation 13/13, dialog presentation 4/4, catalogue editor 18/18, metadata transfer 16/16, tag hierarchy 38/38; TypeScript and lint pass.
- Fourth-pass browser checks: inspector Tab/Shift+Tab wrapping, staged Escape for a tag draft, return focus after inspector/settings/rename/wizard/colour-picker close, shortcut capture Escape/Tab cancellation, video action-menu arrow wrapping, and editor initial focus. Delayed in-memory save and metadata-picker cancellation keep both Tab directions on Close while busy, then restore the original control; Escape respects the busy guard. Invalid tag paths keep the editor open, and Escape from a nested bulk confirmation returns to its Apply button without closing the editor. No console errors observed. These are fixture checks, not native file-operation tests.
- Fifth-pass checks (20 September 2026): `npm run check` passes; settings presentation 13/13, gallery layout 7/7, virtual scroll 11/11 and workbench navigation 3/3 pass. `git diff --check` passes.
- Fifth-pass browser checks: pinned controls remain a single 40px row at 600px and 420px, keyboard navigation reveals the last button, and flat icons retain the same geometry. Empty-results recovery restores search focus; empty catalogues open Library & sources; unavailable clip previews return to thumbnails and focus the view selector. Light and dark themes checked. A 5,000-video fictional catalogue rendered 16 thumbnail cards initially and 23 text rows at the bottom; its final entry remained searchable. No console errors observed. These checks demonstrate bounded rendering, not a native performance benchmark.
- Latest unpackaged build: exact command `npm run build:prod`; root `/Users/sm/Workspace/Theatrum-Ex-Machina-redesign`; branch `codex/workbench-ui-redesign`; HEAD `db29b8a092948e1accf01a8a34834e4a69a4ecc4`; dirty authorized redesign worktree; artifact `/Users/sm/Workspace/Theatrum-Ex-Machina-redesign/dist/`; build hash `6f8aad9f4a1082bf` (20 September 2026). Existing unused-compilation-entry and CommonJS `path` warnings remain.
- Sixth-pass checks (20 September 2026): `npm run check` and `git diff --check` pass. Workbench navigation 9/9, gallery layout 7/7, virtual scroll 11/11, settings presentation 13/13, settings workspace 7/7 and dialog keyboard 4/4 pass (51 total). The five persistence/media suites pass 71/71, using a fresh workspace-local temporary directory and workspace-contained media binaries; these include real disk roundtrips and FFmpeg/FFprobe extraction.
- Sixth-pass browser checks: Recently played contains 13 of the 18 sample videos and retains its identity after alphabetical sorting; the Recent tray excludes unplayed videos and its keyboard-accessible Show more opens that collection. Settings navigation/content work at 320×568, 320×250 and 500×250, with search and zoom reset reachable at the tester's minimum actual viewport of 240×160. The requested 168×100 override was clamped by the browser tester, so that exact size is not claimed as verified. At 420×250, tray content scrolls while Close remains visible and restores focus to the active tab; gallery height remains 123px instead of becoming negative. At normal height the tray still reserves 170px. Sidebar and breadcrumb bounds remain inside 420×250 with the optional top panel shown. Context-menu End navigation reveals its last action at 240×160; menus opened from trays stay above them. No browser console errors observed.
- Isolated native Electron startup passed with `THEATRUM_PACKAGED_SMOKE_READY` and exit code 0. This is an unpackaged startup check, not a production release test.

The fixture generator, assets, adapter, review page and server live under ignored `tmp/ui/`. The adapter changes only the media URL prefix in the server response; application source and compiled files are unchanged by the fixture.

Checkpoint 7 uses a fresh, isolated native profile, six generated videos and a separately named **Theatrum Workbench QA 7** development app under `tmp/ui/native-review-checkpoint7/`. The app copy uses the existing Workspace Electron runtime with a distinct bundle ID and an ad-hoc development signature; this is not a packaged release. Settings, Electron mutable paths, logs and temporary files are all inside this workspace directory. Native file choices and confirmations remain enabled; authority is not seeded. The older `tmp/ui/native-review/` profile belongs to the user-selected session and must not be reused for disposable QA.

- Native checks passed: opening the generated catalogue through the file picker and folder confirmation; actual file rename; year/rating/tag/playlist editing; explicit catalogue-editor save; filtered metadata export/import with a one-entry preview and confirmation; normal close/reopen with metadata and settings preserved.
- The renamed path now updates inside the still-open inspector. Native folder rescanning and six-video thumbnail regeneration completed, with valid generated JPEG files and gallery previews displayed.
- Native window checks reached 420×250 at application zoom 2.5 (effective 168×100). Reset Zoom and Close remained keyboard reachable and visible after correcting the sticky header overlap.
- Browser language checks covered German, Japanese and Arabic labels and translated settings search at 420×568; the Settings dialog had no horizontal overflow. These are layout/function checks, not native-speaker or complete right-to-left validation. Japanese was also visually checked in the native app, and the selected language survived search and category changes after the binding correction.
- Seventh-pass regression checks: settings workspace 8/8, settings presentation 13/13, workbench navigation 9/9, dialog keyboard 4/4, catalogue editor 18/18 and metadata transfer 16/16 passed (68 total). Translation validation covers all 138 Workbench keys and their placeholders in every supported locale. TypeScript, lint and unpackaged compilation passed.
- Final creation verification passed in native Electron: an unsaved `Review > Save before create` tag was absent from the old catalogue on disk before creation and present afterwards. The new six-video catalogue displayed all generated thumbnails immediately, without reopening, and normal close persisted its six entries.
- Additional final checks passed: catalogue creation 8/8, legacy opening 10/10, catalogue write authority 2/2, media authority 7/7, preload bridge 2/2, preview freshness 4/4, protocol paths 6/6, gallery layout 7/7 and virtual scrolling 11/11. Creation tests execute the actual handler and cover deferred save, failures preserving old state/permissions, stale callbacks and blocked operations. Preview tests use the Angular components and service, retaining card/selection/default-frame state. All seven browser gallery views passed a final smoke check with no console errors.


Native startup command previously checked in this worktree on `design/workbench-ui`, at `503d2e4fcb726952d73533599efb6ad1fa967a4b` with uncommitted changes:

```sh
env PORTABLE_EXECUTABLE_DIR=/Users/sm/Workspace/Theatrum-Ex-Machina-redesign/tmp/native-smoke THEATRUM_PACKAGED_SMOKE_TEST=1 VIDEO_HUB_APP_SIN_MEDIA_TOOLS=/Users/sm/Workspace/Theatrum-Ex-Machina/build/media-tools ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```

This stores test preferences and user data beneath `tmp/native-smoke/` and exits automatically. The launch printed an ignored relative catalogue-argument warning for `.` and an existing Electron event-deprecation warning; renderer startup completed successfully.

## Remaining review work

- Incorporate feedback on information density, inspector and create/edit workflows, and default panel choices.
- Validate external-player handoff and timestamp playback with the user's chosen player. Browser dispatch and the frame-zero timestamp regression are checked; actual external-player playback is not yet claimed.
- Native-speaker review of the new translations and a full right-to-left layout pass remain. Some older application strings still use their existing English fallback.
- A large real-world catalogue performance review remains; the 5,000-entry browser fixture verifies bounded rendering, not a native performance benchmark.
- Complete branch review before merging to `main`. No production release has been packaged or published.

The catalogue format, existing IPC channel allowlist and media extraction implementation are unchanged. The creation IPC payload now includes the current catalogue snapshot; main validates and saves it before switching sessions.
