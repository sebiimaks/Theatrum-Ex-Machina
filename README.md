# Video Hub App SIN

This is an unsupported personal fork of [Video Hub App 3](http://www.videohubapp.com/), maintained at [sebiimaks/Video-Hub-App-SIN](https://github.com/sebiimaks/Video-Hub-App-SIN).

**All changes in this fork were made utilising LLMs. Use this software at your own risk.** This fork is not supported or endorsed by the original developer.

- Current fork version: `v3.3.0-sin.8`
- Change summary updated: 24/07/2026

# Fork Changelog

This changelog covers fork-specific commits made after the upstream baseline at [`dcb3229`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/dcb3229) and groups them under the first tagged fork release that contains them.

Uncommitted test work is not included here.

## [v3.3.0-sin.8](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.8) — 24 July 2026

### [`bfca319`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/bfca319) — Prepare v3.3.0-sin.8 release

Updated the version consistently across the application, package metadata, lockfile, and README. The release documentation now covers resilient media imports, thumbnail regeneration, file-hash copying, Current Hub refinements, CodeQL maintenance, and improved Catalogue Editor contrast. Production macOS packaging also gained the same packaged-application verification used by test builds, including verification of the corresponding media-source archive beside the build being checked.

### [`0e48891`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/0e48891) — Improve JSON editor entry contrast

Made dense Catalogue Editor results easier to distinguish by adding alternating row backgrounds, stronger borders, and a clearer divider beside the action controls. Hovered, keyboard-focused, deleted, light-mode, and dark-mode rows each receive an appropriate visual state, reducing the chance of editing the wrong entry.

### [`55af515`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/55af515) — Add thumbnail regeneration and hash copying

Added a context-menu command that deletes and recreates the selected video's thumbnail, filmstrip, and enabled preview-clip files through the existing extraction queue. The visible item is refreshed afterward and the app reports whether the operation succeeded or failed. The Catalogue Editor also gained an accessible control for copying a file hash, while the remaining added spacing between Current Hub folder rows was removed.

### [`15f1c14`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/15f1c14) — Fix CodeQL workflow

Modernised the GitHub CodeQL workflow to use current checkout and CodeQL actions and to analyse JavaScript and TypeScript explicitly. It also grants the permissions required to publish code-scanning results and removes obsolete checkout and autobuild steps, restoring a smaller and more reliable security-analysis workflow. This changes repository checks rather than application behaviour.

### [`6008b94`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/6008b94) — Refine Current Hub folder list

Reduced the vertical gap between source folders from 18 pixels to 8 pixels so hubs containing several locations use space more efficiently. The final folder name in every path is now marked separately and rendered white in dark mode, making the actual destination easier to identify without hiding the parent path.

### [`4b0cb25`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/4b0cb25) — Handle media import failures gracefully

Made imports tolerant of damaged, incomplete, slow, or temporarily unavailable media, particularly on mounted and network storage. FFprobe now receives a five-minute local timeout or an eight-minute mounted-volume timeout, and quick failures are retried once after the file has had time to settle. If probing still fails, the app creates a path-only catalogue entry tagged `import_error`, skips thumbnail extraction for that entry, shows a clear placeholder, and continues importing the remaining files instead of stopping the whole operation. Focused tests cover timeout selection, retry behaviour, and fallback-entry creation.

## [v3.3.0-sin.7](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.7) — 22 July 2026

### [`822e274`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/822e274) — Prepare v3.3.0-sin.7

Introduced a substantial local-security and packaging upgrade. Privileged application requests are accepted only from the active window; media paths, external links, renames, deletions, and custom-player launches are validated and handled without assembling shell commands; and shutdown waits for catalogue and settings saves to finish. The app now packages locally built FFmpeg 8.1.2 and a pinned x264 revision with network support disabled, corresponding source code, licence notices, checksums, and automated verification of architecture, deployment target, linkage, and extraction behaviour. Public binary-building workflows were removed in favour of source-only GitHub releases and controlled local builds.

## [v3.3.0-sin.6](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.6) — 21 July 2026

### [`baa9229`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/baa9229) — Prepare v3.3.0-sin.6

Synchronised the `v3.3.0-sin.6` version across the runtime, package metadata, lockfile, and README. The release documentation was updated to describe the new atomic-save and backup-recovery protections and to show the matching Debian and macOS package names. This was a release-preparation change and introduced no additional runtime logic.

### [`dfbf7d0`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/dfbf7d0) — Harden catalogue saves and recovery

Replaced direct catalogue and settings writes with validated atomic saves that run one at a time. New data is written to a temporary file, forced to disk, checked by reading it back, and then moved into place; the previous valid catalogue is retained as a `.vha2.bak` backup. Opening a malformed, empty, unreadable, missing, or disconnected catalogue now produces a controlled explanation instead of crashing, offers recovery when a valid backup exists, and preserves a non-empty damaged file for inspection. Save failures are shown to the user and prevent unsafe hub switching, editor closure, or application shutdown, while focused persistence tests exercise the main recovery and overlapping-write cases.

## [v3.3.0-sin.5](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.5) — 20 July 2026

### [`0a5e92c`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/0a5e92c) — Add JSON editor tag workflows

Expanded the Catalogue Editor with normalised comma-separated tag fields, case-insensitive duplicate prevention, support for new custom tags, and autocomplete that can be accepted with the Tab key. A batch toolbar can add tags to every result currently displayed by the editor's search, and closing the editor now refreshes the main gallery, Details tray, and scrolling results list immediately. This commit also promoted the fork to `v3.3.0-sin.5`, updated package names and installation guidance, and documented that the macOS build is unsigned and unnotarized.

### [`e4fa163`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/e4fa163) — Improve global tag removal controls

Added a catalogue-wide removal control to manual tags in the Tags tray. Before anything changes, the confirmation dialog names the tag and reports how many videos use it. Confirming removes the tag from every affected video, clears its count and colour metadata, marks the catalogue for saving, and refreshes any open details view, allowing obsolete tags to be cleaned up without an easy accidental bulk operation.

### [`1417549`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/1417549) — Improve dark-mode details and sidebar contrast

Moved Video Details notes into a dedicated area on the right so they no longer overlap the file path, and restyled the local zoom controls to match the clearer Main Settings design. Search-sidebar filter chips now choose black or white foreground text according to their background colour, keeping video-name, tag, folder-name, and fuzzy-search values readable in dark mode. This was a user-interface change only.

## [v3.3.0-sin.4](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.4) — 19 July 2026

### [`8f2da37`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/8f2da37) — Standardise release filenames

Standardised macOS package names and GitHub Actions artifact names on the lowercase `video-hub-app-sin` convention already used by the Debian package. This makes files easier to identify and reference consistently in documentation and automation. Package contents, application behaviour, and version numbers were unchanged.

### [`217b6d9`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/217b6d9) — Promote fork-specific sin.4 packages

Promoted the fork to `v3.3.0-sin.4` and consistently renamed its application, metadata, visible interface, file association, repository links, and platform identifiers to `Video Hub App SIN`. Added a native Debian package target and an unsigned macOS ARM64 workflow, with checksums and retained build artifacts, and included the upstream MIT licence in packaged applications. Installation, manual-update, attribution, and security-reporting documentation was rewritten so the unsupported fork could not easily be confused with the original supported application.

### [`96e52a8`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/96e52a8) — Use Linux icon set for Debian packaging

Changed Linux packaging to use the project's PNG icon set instead of the macOS `.icns` file. This supplies Electron Builder with the format and sizes expected for Debian packages, avoiding icon-processing failures and improving the installed application's presentation. Runtime behaviour was unchanged.

### [`2b46310`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/2b46310) — Handle legacy peer dependencies in Debian build

Adjusted the Debian workflow to install dependencies using npm's legacy peer-dependency handling. This allows the repository's locked dependency set to install despite an older package declaring an outdated Angular compatibility range. It affects build reliability only and does not alter application behaviour or package identity.

### [`ea91d52`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/ea91d52) — Add Debian AMD64 test build workflow

Added a manually triggered GitHub Actions workflow that checked and built the application on Ubuntu 24.04 with Node.js 22 before creating a Debian AMD64 package and SHA-256 checksum. The result was retained as a temporary CI artifact rather than published automatically, providing an early repeatable way to produce Linux test builds.

## [v3.3.0-sin.3](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.3) — 19 July 2026

### [`9900211`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/9900211) — Refine README settings summary

Reworded the README's Settings summary to state that both option labels and buttons use title case. This was a documentation-only clarification and did not change the interface or application behaviour.

### [`22eba40`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/22eba40) — Promote fork settings and UI updates

Promoted the fork to `v3.3.0-sin.3` and rewrote the README as a structured account of fork changes, their reasons, the support disclaimer, attribution, and links to the original application. Removed the upstream update checker so the fork would not offer potentially incompatible upstream releases, replacing it with clear links to this repository and the supported original app. Settings wording was standardised, Current Hub sections were spaced and grouped more clearly, zoom controls were made more readable, and several labels and copy errors were corrected.

### [`742ea72`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/742ea72) — Improve high-resolution and dark mode UI

Raised the top toolbar from 32 to 40 pixels and enlarged its controls and icons, with related offsets adjusted so the larger toolbar remains aligned throughout the application. Dark-mode backgrounds, borders, text, form controls, tabs, the Tags tray, sidebar, statistics, and active states received stronger contrast. These changes make controls easier to see and target on high-resolution displays without changing catalogue behaviour; test-release directories were also added to `.gitignore`.

## [v3.3.0-sin.2](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.2) — 18 July 2026

### [`6deb525`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/6deb525) — Exclude development files from app package

Replaced the broad Electron package pattern and long exclusion list with an explicit allowlist containing only compiled application output, main-process JavaScript, shared interfaces, and translations. This prevents source files, caches, and other development material from being bundled, keeping application packages smaller and making their contents more predictable.

### [`bc8eeaa`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/bc8eeaa) — Repair ESLint checks

Replaced the removed, undeclared TSLint command with Angular's configured ESLint runner and declared ESLint explicitly as a development dependency. Existing legacy patterns were configured as warnings where appropriate, while the affected source files received type improvements and behaviour-preserving cleanup. This restored a usable static-analysis command for maintainers without intentionally changing the user experience.

### [`324fb48`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/324fb48) — Confirm file deletion from context menu

Added a confirmation dialog before either moving a selected video to the trash or deleting it permanently from the context menu. The prompt names the selected file, and permanent deletion receives a stronger warning that the operation cannot be undone. The main process receives the deletion request only after explicit confirmation, reducing accidental file loss while preserving both available deletion modes.

## [v3.3.0-sin.1](https://github.com/sebiimaks/Video-Hub-App-SIN/releases/tag/v3.3.0-sin.1) — 18 July 2026

### [`f46b133`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/f46b133) — Update README.md

Expanded the README with a dated summary of the Catalogue Editor, play-count reset, and longer extraction timeouts. It also clarified that the fork worked for its maintainer but remained unsupported, and restored explicit thanks and attribution to the original developer. This commit changed documentation only.

### [`8c50f99`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/8c50f99) — Add timeout fix and times played reset addition

Increased thumbnail and filmstrip extraction time allowances to four times their upstream values, reducing failures with high-resolution, slow, or network-hosted media. Added a `Reset Times Played` action that clears every video's play count, resets the related filter, marks the catalogue for saving when any play count changes, and confirms completion. Missing play-count values in older catalogues are treated as zero so they do not produce invalid filter ranges.

### [`8b1c714`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/8b1c714) — Update README.md

Replaced the upstream README with a short introduction identifying this repository as a personal fork whose additions were produced with an LLM. It established the initial support disclaimer and did not change application behaviour.

### [`68f2b47`](https://github.com/sebiimaks/Video-Hub-App-SIN/commit/68f2b47) — Add catalogue JSON editor

Added an in-app Catalogue Editor for searching and directly correcting hub metadata such as names, paths, tags, ratings, year, play count, default screenshot selection, and notes. Entries can be marked as deleted or restored, and the editor displays active and deleted counts while updating filters and tag information as edits are made. Changes can be saved to the currently open catalogue without closing the application, with visible success or failure feedback; the catalogue picker also accepts `.json` files alongside `.vha2` files.

## Distribution and Local Builds

GitHub releases for this fork are source-only. Each version tag provides the source archives generated by GitHub; prebuilt application packages are not attached to releases. Locally built applications do not include automatic update checking.

Before building, install the project's development prerequisites and review `LICENSE`, the generated third-party notices, and the media-tool licensing documentation.

### macOS ARM64

On an Apple Silicon Mac, run `npm run electron:mac:release`. The command builds an unsigned and unnotarized ARM64 DMG, creates the matching media-source archive, and verifies the packaged application and licensing payload. Outputs are written to the ignored `release/` directory. The reproducible unpacked staging application may be deleted after verification.

### Debian 13 AMD64

Debian packages must be built natively on Debian 13 AMD64; cross-building them on macOS is not supported. Run `npm run electron` after installing the required development tools and preparing the platform-specific media binaries. The resulting Debian package and matching media-source archive should be distributed together with all required licence materials if they are shared outside the local system.

## Original and Supported App

This fork exists because the original application is useful and well designed. For the supported Video Hub App, documentation, and official releases, visit [videohubapp.com](http://www.videohubapp.com/) or the [whyboris/Video-Hub-App repository](https://github.com/whyboris/Video-Hub-App).

Please support the original developer, [whyboris](https://github.com/whyboris).
