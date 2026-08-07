# Theatrum Ex Machina

**Theatrum Ex Machina** is an unsupported personal fork of [Video Hub App 3](http://www.videohubapp.com/), maintained at [sebiimaks/Theatrum-Ex-Machina](https://github.com/sebiimaks/Theatrum-Ex-Machina). Its name and logo are fork-specific branding and are not associated with or endorsed by the original developer.

**All changes in this fork were made utilising LLMs. Use this software at your own risk.** This fork is not supported or endorsed by the original developer.

- Current fork version: `v3.3.0-tem.3`
- Change summary updated: 07/08/2026

# Fork Changelog

This changelog covers material fork-specific changes made after the upstream baseline at [`dcb3229`](https://github.com/whyboris/Video-Hub-App/commit/dcb3229). Documentation-only, CI-only, release-bookkeeping, and temporary workflow commits are intentionally omitted. Select a commit to expand its details.

Changes under Unreleased are present on the production branch but have not yet been assigned to a tagged release.

## Unreleased

No unreleased changes.

## [v3.3.0-tem.3](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-tem.3) — 7 August 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/371e976"><code>371e976</code></a> — <strong>Add persistent hierarchical tagging</strong></summary>
<p>Manual tags can now be organised into persistent nested hierarchies in the Tags tray. Tags and branches can be created independently of videos, moved or separated with drag and drop, coloured individually, filtered as exact tags or complete branches, and removed catalogue-wide with affected-video safeguards. Unassigned tag definitions survive saving and reopening, while Catalogue Editor metadata import and search preserve canonical hierarchy paths. Batch assignment supports nested tags, and Video Details presents compact individual tag levels whose removal is restricted to the selected hierarchy branch and its descendants, including when unrelated branches use the same visible name.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/fa9e7a4"><code>fa9e7a4</code></a> — <strong>Move hierarchical tags into a right-side source panel</strong></summary>
<p>Replaced the bottom Tags tray with a compact right-side source panel that keeps nested tags visible alongside the gallery. The panel provides filtering, independent tag creation, hierarchy expansion, frequency display, sorting, batch assignment, drag-and-drop organisation, and catalogue-wide removal controls. Gallery and breadcrumb sizing now adapt to the panel, while a floating Tags control opens it without displacing the other tray tabs.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/fa9e7a4"><code>fa9e7a4</code></a> — <strong>Clarify application confirmation dialogs</strong></summary>
<p>Reworked renderer confirmation dialogs into a consistent progressive-disclosure layout with concise summaries, before-and-after transitions, supporting safety guidance, expandable impact details, and action-specific warning or destructive styling. Metadata changes, thumbnail regeneration, file deletion, and hierarchy operations now present their scope more clearly before execution.</p>
</details>

## [v3.3.0-tem.2](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-tem.2) — 4 August 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/4053cbc"><code>4053cbc</code></a> — <strong>Add safe Catalogue Editor metadata transfer</strong></summary>
<p>Added human-readable metadata export and category-selectable import matched solely by globally unique file hashes. Imports are limited to the Catalogue Editor results displayed when import begins, enter a read-only preview showing only affected entries, highlight every proposed field change, require confirmation, and revalidate before mutation. Save notices now follow the actual catalogue save result. The search selector also covers every editable field, visible file detail, and entry state using human-readable values.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/d3a5f73"><code>d3a5f73</code></a> — <strong>Put Catalogue Editor match controls first</strong></summary>
<p>Reordered each Catalogue Editor search line so its Contains or Does Not Contain condition appears before the search text and field selector. The visual order and keyboard tab order now follow the same condition–query–field sequence, with responsive layouts preserving that relationship on narrower windows. Regression coverage guards the intended control order.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/8755aea"><code>8755aea</code></a> — <strong>Stabilise scrolling across gallery detail views</strong></summary>
<p>Full View now uses deterministic row geometry and a small rendering buffer, while gallery measurements are refreshed in a coordinated order after view, size, zoom, ribbon, sidebar, and tray changes. Details View and Details View 2 no longer focus every newly recycled Add tag field, which previously made Chromium race through the catalogue as virtual rows were created. Measurement-distorting height transitions and the decorative virtual-scroller spacer were also removed, with regression coverage added for layout calculations and focus behaviour.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/3d5b67c"><code>3d5b67c</code></a> — <strong>Make rescans recoverable and restore settings feedback</strong></summary>
<p>Repeated folder scans now use isolated per-source snapshots, ignore stale or failed results, and retain temporarily unavailable videos so tags, notes, ratings, play history, Date Added, and other user metadata survive network or external-drive interruptions. Recovered or renamed files replace their previous entry instead of accumulating obsolete records. Unavailable entries stay out of the normal gallery and thumbnail work and can be filtered explicitly in the Catalogue Editor. Settings option icons also retain visible selected states and balanced spacing, while inactive tabs use opaque theme-aware hover feedback.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/a18e18d"><code>a18e18d</code></a> — <strong>Replace branding with theme-aware Blue T icons</strong></summary>
<p>Replaced the previous green roundel throughout the interface, startup screen, file association, Dock integration, and generated macOS, Windows, and Linux icon sets with the supplied Blue T artwork. Dark mode and the dark static application icon are the defaults, while the running macOS Dock icon follows the saved in-app theme. Packaged assets are checked against the reviewed light and dark masters.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/d341e1c"><code>d341e1c</code></a> — <strong>Modernise the interface and Catalogue Editor search</strong></summary>
<p>Applied the Frosted Graphite design across the title bar, toolbar, sidebar, gallery, trays, settings, wizard, Catalogue Editor, video details, dialogs, and context menus. Typography, spacing, semantic colours, controls, focus states, and light and dark mode treatment are now more consistent while preserving existing workflows. Catalogue Editor search rows also gained case-insensitive Contains and Does Not Contain operators that combine cumulatively and handle missing fields correctly.</p>
</details>

## [v3.3.0-tem.1](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-tem.1) — 1 August 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/2f091e6"><code>2f091e6</code></a> — <strong>Rebrand the application as Theatrum Ex Machina</strong></summary>
<p>Renamed the application and replaced inherited package names, platform identifiers, visible links, settings identity, icons, and logos while retaining upstream attribution and licensing. New hubs use the <code>.scaena</code> extension with Finder and wizard support, while legacy <code>.vha2</code> and JSON catalogues remain compatible. The opening wizard follows the saved theme, packaged applications include their complete runtime dependencies, and thumbnail regeneration gained visible progress, cancellation, and shutdown safeguards.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/f472075"><code>f472075</code></a> — <strong>Add persistent Date Added metadata and editing</strong></summary>
<p>Newly discovered videos now receive an absolute Date Added timestamp that is retained through retry, rescan, rename, and move recovery. Legacy entries remain unknown rather than receiving invented dates. The main interface can sort by Date Added, folder rows aggregate the latest known descendant date, and the Catalogue Editor supports validated per-entry and confirmed bulk editing.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/b5a62bf"><code>b5a62bf</code></a> — <strong>Add safe folder thumbnail regeneration and catalogue editing</strong></summary>
<p>Current Hub folders gained confirmed, cancellable thumbnail regeneration with sequential processing, validated staging, rollback, and crash recovery. Unsafe thumbnail settings are normalised, filmstrip scrubbing is stabilised, and conflicting save, close, custom-thumbnail, and editor actions are blocked during regeneration. The Catalogue Editor also gained cumulative search rows, title-case fields, simplified numeric controls, and confirmed bulk replacement for safe metadata fields.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/2caed2a"><code>2caed2a</code></a> — <strong>Show ribbon descriptions beside toolbar icons</strong></summary>
<p>Replaced native ribbon tooltips with a translated inline description that follows pointer hover and keyboard focus. The reserved label area does not shift surrounding controls, and accessible names and visible keyboard-focus indicators remain available.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/44958e5"><code>44958e5</code></a> — <strong>Correct thumbnail regeneration counts</strong></summary>
<p>Regenerated previews now use the current hub extraction settings instead of stale per-video metadata. Completion belongs to the exact queued job, successful counts are synchronised across matching catalogue entries, invalid default screenshots are cleared, and failed or cancelled work leaves catalogue metadata unchanged.</p>
</details>

## [v3.3.0-sin.8](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.8) — 24 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/0e48891"><code>0e48891</code></a> — <strong>Improve Catalogue Editor entry contrast</strong></summary>
<p>Added alternating row backgrounds, stronger borders, and a clearer action divider so dense Catalogue Editor results are easier to distinguish. Hovered, focused, deleted, light-mode, and dark-mode rows receive distinct visual states, reducing the chance of editing the wrong entry.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/55af515"><code>55af515</code></a> — <strong>Add thumbnail regeneration and hash copying</strong></summary>
<p>Added a context-menu command that recreates the selected video's thumbnail, filmstrip, and enabled preview clip through the existing extraction queue and reports completion or failure. The Catalogue Editor also gained an accessible control for copying a file hash.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/6008b94"><code>6008b94</code></a> — <strong>Refine the Current Hub folder list</strong></summary>
<p>Reduced excess spacing between source folders and styled the final folder name separately, making hubs with several locations more compact while keeping the actual destination easier to identify in dark mode.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/4b0cb25"><code>4b0cb25</code></a> — <strong>Handle media import failures gracefully</strong></summary>
<p>Imports now tolerate damaged, incomplete, slow, or temporarily unavailable media, particularly on mounted and network storage. Probing receives longer timeouts and one settling retry; persistent failures create a thumbnail-free entry tagged <code>import_error</code> and continue importing the remaining files instead of stopping the entire operation. Failure placeholders remain usable across the supported views.</p>
</details>

## [v3.3.0-sin.7](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.7) — 22 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/822e274"><code>822e274</code></a> — <strong>Harden local operations and media-tool packaging</strong></summary>
<p>Privileged requests are accepted only from the active application window, while paths, links, renames, deletions, and custom-player launches are validated without assembling shell commands. Shutdown waits for catalogue and settings saves. The application uses locally built FFmpeg and FFprobe binaries with matching source, licence notices, architecture and linkage checks, and extraction verification included with the package.</p>
</details>

## [v3.3.0-sin.6](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.6) — 21 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/dfbf7d0"><code>dfbf7d0</code></a> — <strong>Harden catalogue saves and recovery</strong></summary>
<p>Catalogue and settings writes are validated, atomic, and serialised. New data is written to a temporary file, forced to disk, read back, and then moved into place while the previous valid catalogue remains available as a backup. Opening malformed, empty, unreadable, missing, or disconnected catalogues now produces controlled recovery options instead of crashing, and save failures prevent unsafe hub switching, editor closure, or shutdown.</p>
</details>

## [v3.3.0-sin.5](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.5) — 20 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/0a5e92c"><code>0a5e92c</code></a> — <strong>Add Catalogue Editor tag workflows</strong></summary>
<p>Added normalised comma-separated tag editing, case-insensitive duplicate prevention, autocomplete, support for new custom tags, and batch tagging of the currently displayed results. Closing the editor refreshes the main gallery, Details tray, and scrolling results immediately.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/e4fa163"><code>e4fa163</code></a> — <strong>Improve global tag removal controls</strong></summary>
<p>Manual tags in the Tags tray can now be removed catalogue-wide after a confirmation dialog identifies the tag and affected-video count. Confirming removes the tag from every video, clears its count and colour metadata, marks the catalogue for saving, and refreshes the open details view.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/1417549"><code>1417549</code></a> — <strong>Improve dark-mode details and sidebar contrast</strong></summary>
<p>Moved Video Details notes into a dedicated right-side area so they no longer overlap the path and restyled local zoom controls for consistency. Search-sidebar filter chips now choose black or white foreground text from their background colour, keeping video-name, tag, folder-name, and fuzzy-search values readable in dark mode.</p>
</details>

## [v3.3.0-sin.4](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.4) — 19 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/217b6d9"><code>217b6d9</code></a> — <strong>Apply a fork-specific application identity</strong></summary>
<p>Renamed the application, package metadata, visible interface, file association, repository links, and platform identifiers to distinguish the fork from upstream. Added native Debian package metadata, included the upstream MIT licence in installed applications, and displayed clear fork support and attribution information.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/96e52a8"><code>96e52a8</code></a> — <strong>Use the Linux icon set for Debian packaging</strong></summary>
<p>Changed Linux packaging to use the project's PNG icon set rather than the macOS <code>.icns</code> file, supplying Debian with the expected formats and sizes for a correctly presented installed application.</p>
</details>

## [v3.3.0-sin.3](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.3) — 19 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/22eba40"><code>22eba40</code></a> — <strong>Standardise fork settings and interface wording</strong></summary>
<p>Removed the incompatible upstream update checker and replaced it with clear fork and supported-upstream links. Settings wording, title case, Current Hub grouping, zoom controls, labels, and several copy errors were corrected for a more consistent interface.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/742ea72"><code>742ea72</code></a> — <strong>Improve high-resolution and dark-mode presentation</strong></summary>
<p>Raised the top toolbar to 40 pixels and enlarged its controls and icons, with related offsets adjusted to retain alignment. Dark-mode backgrounds, borders, text, forms, tabs, the Tags tray, sidebar, statistics, and active states gained stronger contrast for improved readability and targeting on high-resolution displays.</p>
</details>

## [v3.3.0-sin.2](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.2) — 18 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/6deb525"><code>6deb525</code></a> — <strong>Exclude development files from application packages</strong></summary>
<p>Replaced the broad Electron package pattern with an explicit runtime allowlist containing compiled application output, main-process JavaScript, shared interfaces, and translations. Development source, caches, and unrelated project files are no longer shipped, reducing package size and making installed contents more predictable.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/324fb48"><code>324fb48</code></a> — <strong>Confirm file deletion from the context menu</strong></summary>
<p>Added a confirmation dialog before moving a selected video to the trash or deleting it permanently. The prompt names the file, and permanent deletion receives a stronger irreversible-action warning before the main process receives the request.</p>
</details>

## [v3.3.0-sin.1](https://github.com/sebiimaks/Theatrum-Ex-Machina/releases/tag/v3.3.0-sin.1) — 18 July 2026

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/8c50f99"><code>8c50f99</code></a> — <strong>Extend extraction timeouts and reset play counts</strong></summary>
<p>Increased thumbnail and filmstrip extraction time allowances to reduce failures with high-resolution, slow, or network-hosted media. Added a Reset Times Played action that clears every video's play count, resets the related filter, marks changed catalogues for saving, and treats missing legacy values as zero.</p>
</details>

<details>
<summary><a href="https://github.com/sebiimaks/Theatrum-Ex-Machina/commit/68f2b47"><code>68f2b47</code></a> — <strong>Add the Catalogue Editor</strong></summary>
<p>Added an in-app editor for searching and correcting catalogue metadata including names, paths, tags, ratings, year, play count, default screenshot, and notes. Entries can be marked deleted or restored, active and deleted counts remain visible, and edits can be saved to the open catalogue without restarting the application.</p>
</details>

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
