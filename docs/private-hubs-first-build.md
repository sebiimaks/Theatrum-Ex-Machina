# Try password-protected private hubs

Private hubs are available in the macOS development build on `codex/private-hubs`. They are not part of the published 2.0.0 release. Touch ID is deferred; use a hub password for this build.

## Create a private copy

1. Open a writable `.scaena` hub in the ordinary application.
2. Choose **File → Create private copy…** from the macOS menu bar. The app saves pending edits and pauses the ordinary hub while the private workspace is open.
3. Review the video and preview counts. Acknowledge that the original files will remain. If previews are missing, either cancel and generate them in the ordinary hub, or explicitly allow a copy with those previews missing.
4. Enter and confirm a password. Keep it somewhere safe: there is no password-reset service.
5. Choose an existing folder on a connected local drive, or use **New Folder** in the picker. The app creates a separate **Private hub** folder inside it. If that name is already taken, it uses **Private hub 2**, **Private hub 3**, and so on; existing files and folders are retained. Wait for copying and verification to finish. The private gallery opens when the copy is ready.

The destination is a folder containing encrypted catalogue and preview records. Keep the whole folder together. Do not rename or edit individual files inside it. Back up the folder after locking the hub.

## Browse, edit and lock

Select a video to inspect its saved previews, notes and tags. Save changes to notes and tags before locking. The private gallery also provides saved filmstrips and preview clips when present, per-video preview regeneration through an explicit source-folder selection, password changes, and automatic-lock settings under **Protection**.

Choose **Lock hub** to close the private workspace and return to the ordinary hub. To reopen it, choose **File → Open private hub…**, select the encrypted folder and enter its password. Private hubs are not added to the ordinary recent-catalogue list.

An incorrect password or an unavailable folder returns to the ordinary workspace with a message. Choose **Open private hub…** again to retry. If cleanup cannot be confirmed, restart the app before continuing.

This initial private gallery plays generated preview clips. Original-video playback, importing new videos and relocating source folders remain ordinary-hub operations.

## Make an ordinary copy

To use the catalogue outside the private workspace, choose **Create unprotected copy** under **Protection**, authenticate with the current password and select a new destination. This writes a separate ordinary catalogue and preview files. Locking the private hub does not encrypt that exported copy.

## What is protected

The private folder encrypts catalogue information—including paths, tags and notes—and generated thumbnails, filmstrips and preview clips. Decrypted previews are served to the isolated private window while it is unlocked.

Creating a private copy does not remove or encrypt the original `.scaena` file, preview folders, backups or source videos. Those remain accessible to other applications. The operating system can still observe the running app, folder location, file sizes, native picker locations and anything visible on screen. Encryption here protects stored private-hub content, not a compromised account or an unlocked screen.

## Local test package

Run `npm run electron:mac:private:test` from the privacy worktree to build an unsigned Apple Silicon test app in `release-test-private/mac-arm64/Theatrum Ex Machina.app`. This command does not publish or install it. The output uses a separate directory from earlier test packages.

The current test build is in `release-test-private-metadata-check/mac-arm64/Theatrum Ex Machina.app`. Set `THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-metadata-check` when building or running `npm run test:private-package:host` to use this separate output folder. Folder selection accepts capitalization differences on case-insensitive drives. Catalogue metadata updates are accepted only when the catalogue contents remain unchanged; actual edits still stop conversion. If conversion fails, the message identifies the failed step, such as checking the source, creating encrypted storage, copying previews or verifying the copy.

Open that local app to review the workflow. Close other running copies of Theatrum Ex Machina first so that macOS does not forward the launch to a different running version. Normal catalogue settings are shared unless a separate portable settings directory is selected when launching; the automated acceptance tests use isolated disposable profiles.

See the [validation record](./private-hubs-validation.md) for the tested checkout, commands and limits. This is an experimental storage format; retain an ordinary backup while reviewing it.
