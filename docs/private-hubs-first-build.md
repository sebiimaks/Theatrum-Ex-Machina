# Try password-protected private hubs

Private hubs are available in the macOS development build on `codex/private-hubs`. Touch ID is deferred; use a hub password for this build.

## Create a private copy

1. Open a writable `.scaena` hub in the ordinary application.
2. Choose **File → Create private copy…** from the macOS menu bar. The app saves pending edits and pauses the ordinary hub while the private workspace is open.
3. Review the video and preview counts. Acknowledge that the original files will remain. If previews are missing, either cancel and generate them in the ordinary hub, or explicitly allow a copy with those previews missing.
4. Enter and confirm a password. Keep it somewhere safe: there is no password-reset service.
5. Choose an existing folder on a connected local drive, or use **New Folder** in the picker. The app creates a separate **Private hub** folder inside it. If that name is already taken, it uses **Private hub 2**, **Private hub 3**, and so on; existing files and folders are retained. Wait for copying and verification to finish. The private gallery opens when the copy is ready.

The destination is a folder containing encrypted catalogue and preview records. Keep the whole folder together. Do not rename or edit individual files inside it. Back up the folder after locking the hub.

## Browse, edit and lock

Select a video to inspect its saved previews, rating, notes and tags. Save changes before locking. The private gallery also provides saved filmstrips and preview clips when present, original-video playback, per-video preview regeneration and metadata refresh, password changes, and automatic-lock settings under **Protection**.

Choose **Lock hub** to close the private workspace and return to the ordinary hub. To reopen it, choose **File → Open private hub…**, select the encrypted folder and enter its password. Private hubs are not added to the ordinary recent-catalogue list.

An incorrect password or an unavailable folder returns to the ordinary workspace with a message. Choose **Open private hub…** again to retry. If cleanup cannot be confirmed, restart the app before continuing.

## Choose collections and sorting

Use **Collection** to choose **All videos**, **Favourites** or **Recently played**. Search titles and tags within the chosen collection. **Recently played** includes only videos with a saved last-played date and initially shows the newest first. It uses saved catalogue history. To record future original-video plays, enable **Record playback history** in **Protection**.

Use **Sort by** to choose **Catalogue order**, **Name**, **Date added**, **Last played**, **Rating**, **Duration** or **File size**. The direction button switches between **Ascending** and **Descending**. Missing dates, durations and file sizes stay at the end in either direction. Changing a collection or sort returns to the first page.

Save or discard notes, tag and rating edits before changing the view. Resolve an unsaved automatic-lock setting first as well. These browsing choices do not change the saved catalogue order, playback history or source files, and do not require connecting source folders. Locking clears the search and view choices; reopening starts with **All videos**, **Catalogue order**, **Ascending**.

## Rate videos and manage favourites

Select a video and choose **Rating** in its details. Choose **Unrated** or one to five stars. Five-star videos appear in **Favourites**; choosing a lower rating removes that favourite status.

Choose **Save changes** to store the rating, notes and tags together in the encrypted catalogue, or **Discard** to restore their saved values. Changes refresh the current collection and sort order. If a video leaves Favourites after saving, its details stay open so you can continue editing it. Save or discard a rating draft before navigating elsewhere; locking clears unsaved drafts.

Rating does not require connecting a source folder and does not change original files or playback history. Editing notes or tags alone preserves the saved rating, including older catalogue values.

## Play videos and previews

Select a video, then choose **Play video** to play its original file inside the private window. If its source folder is not connected for this session, select the saved folder in the native picker. A connection already granted through **Source folders**, playback or preview regeneration can be reused. Opening a video does not relocate its source or choose an alternate copy.

**Play preview** plays the generated clip stored in the encrypted hub, when available. It does not need the original source folder. Selecting a catalogue item starts neither kind of playback automatically.

Use the player’s **Full screen** control to expand an original video or a saved preview. Press **Escape** to return to its details. The automatic-lock timeout still applies in fullscreen.

Use **Cancel** while a video is opening, or **Stop video** to close its player. Changing the selected video, closing its details, opening Protection or Source folders, regenerating previews, or saving/discarding metadata also stops original playback. Unsaved notes and tags survive starting or stopping playback; save or discard them before navigating away. **Lock hub** always remains available and clears unsaved edits.

The private player accepts MP4, M4V, MOV, WebM and Ogg video containers. Playback also depends on the codecs supported by the bundled player. An unsupported codec or unavailable source produces an error; the app does not open an external player or convert the original as a fallback. A saved preview may still play.

Original playback updates **Last played** and **Times played** only when **Record playback history** is enabled in Protection. Playing a preview never updates history. Playback does not keep the hub unlocked: the inactivity timeout still applies. Original files remain unencrypted in their existing folders and can be accessed outside the app. Use **Source folders → Add videos…** to import up to 100 selected videos at a time.

## Choose whether to record playback history

Open **Protection**, set **Record playback history** to **On**, then choose **Save settings**. Recording starts **Off** for new hubs and hubs saved by earlier builds. The choice is saved inside this encrypted hub, independently of ordinary application settings.

When recording is On, starting an original video through **Play video** saves the current **Last played** time and adds one to **Times played** after playback begins. Pausing, resuming, seeking and looping the same open player do not add plays. Stopping and choosing **Play video** again starts a new play. Previews, failed openings and merely selecting a video do not update history.

**Recently played** and last-played sorting reflect saved plays when the gallery refreshes after playback or on the next browse. Notes, tag and rating drafts remain unsaved until you choose **Save changes**. If a history update cannot be recorded, the playback status reports it; existing history is retained.

Set recording to **Off** and save to stop recording future plays. Turning it off keeps previously saved history. A play already admitted for saving may finish after **Stop video**. Locking still revokes access and waits for outstanding work. Playback and automatic history updates do not extend the inactivity timeout.

Saving Protection settings in this build updates their encrypted format. Earlier private-hub builds cannot read that newer settings format; use this build or a later compatible build to reopen the hub.

## Reset saved playback history

Open **Protection** and choose **Reset Last played…** or **Reset Times played…**. Save or discard video edits and save or restore changed Protection settings first. Review the number of catalogue entries in the confirmation, then confirm the named reset. **Cancel** is the default.

Each action resets only its named value throughout the current encrypted catalogue, including retained entries marked deleted. Resetting Last played empties **Recently played**; resetting Times played keeps Last played unchanged. Missing values remain absent. When all values are already missing or zero, no confirmation or catalogue write is needed.

The recording preference stays unchanged. If recording is On, later original-video playback will record new history. Notes, tags, ratings, previews and original videos are unaffected. A reset already being saved may finish if you lock the hub; a confirmation returned after locking cannot start a reset.

Resetting changes the current catalogue. Encrypted recovery backups, exported hubs and separately saved copies may retain earlier history. This action does not securely erase those copies.

## Connect source folders

Open **Source folders** to see the saved folders and how many catalogue videos reference each one. **Not connected** means the app has no current permission for that folder in this private session; it does not mean the videos or saved previews are missing.

Choose **Connect** and select the existing folder shown by the native picker. After connection, **Play video**, **Add videos…**, **Find new videos…**, **Check saved files…**, **Regenerate previews** and **Refresh video** can reuse that session access. **Refresh** checks current connections after reconnecting a drive. If a folder has disappeared or been replaced, connect it again. Cancelling a connection keeps the hub open.

**Disconnect** removes the app's permission for that folder in this private session. It does not delete files, change the catalogue or unmount the drive. All connections expire when the private hub locks, and saved encrypted previews remain available without connecting source folders.

Folders use generic numbered labels in the private window; the native picker identifies the saved location. Connect reconnects folders at their saved locations. Use **Change location…** when a folder has moved.

## Add a source folder

Save or discard video edits, open **Source folders**, and choose **Add folder…**. Select an existing folder that is separate from the other saved source folders and the encrypted hub’s own storage folder. The app saves its location in the encrypted catalogue. It does not scan the folder, add videos, enable watching or change its files.

The new folder initially shows **Not connected**. Choose **Connect** to grant access for this session, or **Add videos…** to grant access and select videos to import. Saved folder locations survive locking; permission to use them does not. The private gallery supports up to 256 saved source folders.

**Cancel adding folder** stops the operation once cancellation is observed. Close any open native picker to finish cancellation. A save already in progress may finish, so check the refreshed folder list before retrying.

## Add videos

Save or discard any video edits, open **Source folders**, and choose **Add videos…** beside a saved folder. Connect the folder if prompted, then select up to 100 videos inside it. The app processes them one at a time. For each video, it reads technical metadata and generates encrypted thumbnails, filmstrips and any preview clip enabled by the hub’s existing preview settings. The catalogue entry is saved after its previews.

Progress and the final summary show how many videos were added, already catalogued, failed or not processed. A file already catalogued at the same path is skipped. Separate copies at different paths are treated as separate videos. Unreadable or unsupported files can fail while other selected files continue; a changed source folder or lost access stops the batch. Linked files/folders and ignored subfolders are refused. Every selected path must be inside the saved source folder; an invalid or oversized selection is rejected before importing any videos.

Original videos stay in place and remain unencrypted. Use **Add folder…** to save another source folder first. Choose **Find new videos…** to review new files discovered in a saved folder. Automatic watching is not enabled.

Choose **Cancel import** during **Add videos…**, or **Cancel** during **Find new videos…**, to stop further work once cancellation is observed. Close any open native picker to finish cancellation. Videos already added remain saved. A catalogue save already in progress may complete, so check the refreshed catalogue before retrying. Locking also cancels import and waits for its decoder and file access to finish. The automatic-lock timeout still applies during a batch; progress updates do not keep the hub unlocked. Interrupted work may leave unused encrypted preview records; it does not create readable preview files beside the source.

## Refresh a changed video

Select a video and choose **Refresh video** in its details. Save or discard notes, tag and rating drafts first. Select the saved source folder if asked. The app reads that video’s technical details and creates fresh encrypted thumbnails, filmstrips and any preview clip enabled by the hub’s current preview settings. Original files remain unchanged.

The refresh updates file size, filesystem dates, duration, dimensions, frame rate, calculated bitrate and filmstrip frame count. Notes, tags, rating, title, playback history, playlist membership and date added are retained. A saved default-frame selection is cleared only if it is invalid for the new filmstrip.

This action currently requires one saved location for the video and a unique preview identifier. Entries with alternate locations cannot be refreshed this way: checking one copy does not establish that the others contain the same video. It does not relocate files, clear missing flags, merge entries or start a watcher. **Check saved files…** remains a separate read-only size check, and **Regenerate previews** retains its existing behavior.

Choose **Cancel** to stop and wait for outstanding file and decoder work to finish. A catalogue save already in progress may complete; the gallery reloads the saved details and previews before another action. Locking also cancels and drains the operation. If the app reports a failed save or cannot confirm cleanup, reopen the hub after restarting the app.

The app prepares encrypted previews before replacing the catalogue entry. An interruption before that catalogue save leaves the previous entry and previews authoritative. Older encrypted preview records and catalogue recovery backups remain in the hub; refresh does not securely erase them. Generated previews and technical metadata stay inside the encrypted hub.

## Check saved files in a folder

Open **Source folders** and choose **Check saved files…** beside a saved folder. Select that folder if asked to connect it. The check visits only locations already listed in this catalogue; it does not search for new videos. Unsaved notes, tags and ratings remain in the editor.

The summary counts saved file locations, so one video with alternate locations can contribute more than once:

- **Same recorded size:** a regular file was found with the recorded size.
- **Different size:** a regular file was found with a different size.
- **Missing:** the saved location was not found while its source folder remained connected.
- **Not verified:** the location could not be safely checked, its recorded size is unknown, or it exceeds the supported path depth. Links, non-file entries and permission failures belong here.
- **Ignored:** the location is inside an ignored subfolder and was not inspected.

This is a point-in-time metadata check. Matching size does not prove unchanged content or successful playback. If the source folder disconnects or its saved configuration changes, the report is refused instead of treating its files as missing. Reconnect or choose **Refresh**, then try again.

Each check supports up to 10,000 saved locations in the selected source, within the gallery's 100,000-entry limit. Paths deeper than 32 subfolders are not verified. If an overall limit is reached, no partial report is shown. Choose **Cancel check** to stop; close an open folder picker to let cancellation finish. Locking also cancels and waits for outstanding access to settle.

The check reads file metadata only. It does not read video contents, update missing flags, repair entries, regenerate previews, start a watcher or save the report. The summary disappears when the panel is refreshed or closed.

## Find new videos in a folder

Open **Source folders** and choose **Find new videos…** beside a saved folder. Save or discard video edits first, and connect the folder if prompted. Discovery checks subfolders for supported video extensions, skipping paths already in the catalogue, linked files and folders, ignored subfolders, and folders whose names begin with `vha-`. It reads directory entries and file metadata; it does not decode originals or generate previews during discovery.

Review the number of discovered video candidates in the native confirmation, then choose **Import videos** to begin. **Cancel** is the default. The confirmation shows counts rather than a filename list. Each batch contains up to 100 videos. If the confirmation reports more, finish the batch and choose **Find new videos…** again; saved entries are skipped on later scans. A matching extension does not guarantee that a video can be decoded.

Discovery stops at 10,000 entries, 1,000 directories or 32 nested folder levels. If a safety limit is reached, no batch is imported: use **Add videos…** to select files directly. **No new videos found** means the scan found no new eligible paths.

Confirmed imports use the same encrypted previews, progress counts and per-video saves as **Add videos…**. **Cancel** stops discovery or import once cancellation is observed; close any open native confirmation or folder picker to finish cancellation. Completed entries remain saved, and an active catalogue save may finish. Review the refreshed catalogue before retrying. Locking also cancels the operation, and the automatic-lock timeout still applies. This action does not enable automatic scans or folder watching.

## Update a moved source folder

Save or discard video edits, open **Source folders**, and choose **Change location…** beside the relevant folder. Select its new location in the native picker. Keep the same filenames and subfolder layout. The app checks that every referenced video is present as a regular file and has the size recorded in the catalogue, including videos previously marked missing.

Review the selected path and video count in the native confirmation, then choose **Save location**. This saves the new path in the encrypted catalogue. It does not move videos or change notes, tags, previews, watch settings or missing-file flags. Choose **Connect** afterward to grant access for playback and preview regeneration during the current session. The saved location survives locking; the connection does not.

Choose a separate location that does not overlap another saved source folder or the old location. Linked folders/files, incomplete sets and entries without recorded positive file sizes are refused. Checks compare names, relative paths and sizes; they do not compare video contents. If checking fails, correct the selected folder or use the ordinary hub to repair incomplete file information first.

**Cancel change** stops work once cancellation is observed. A save already in progress may finish, so the panel refreshes the saved state after every outcome. Locking retains its usual cancellation and cleanup behavior.

## Make an ordinary copy

To use the catalogue outside the private workspace, choose **Create unprotected copy** under **Protection**, authenticate with the current password and select a new destination. This writes a separate ordinary catalogue and preview files. Locking the private hub does not encrypt that exported copy.

## What is protected

The private folder encrypts catalogue information—including paths, tags and notes—and generated thumbnails, filmstrips and preview clips. Decrypted previews are served to the isolated private window while it is unlocked.

Creating a private copy does not remove or encrypt the original `.scaena` file, preview folders, backups or source videos. Those remain accessible to other applications. The operating system can still observe the running app, folder location, file sizes, native picker locations and anything visible on screen. Encryption here protects stored private-hub content, not a compromised account or an unlocked screen.

## Local test package

Run `npm run electron:mac:private:test` from the privacy worktree to build an unsigned Apple Silicon test app in `release-test-private/mac-arm64/Theatrum Ex Machina.app`. This command does not publish or install it. The output uses a separate directory from earlier test packages.

The video-refresh test-build output is `release-test-private-refresh/mac-arm64/Theatrum Ex Machina.app`. Set `THEATRUM_PRIVATE_TEST_OUTPUT=release-test-private-refresh` when building or running `npm run test:private-package:host` to use this separate output folder. Folder selection accepts capitalization differences on case-insensitive drives. Catalogue metadata updates are accepted only when the catalogue contents remain unchanged; actual edits still stop conversion. If conversion fails, the message identifies the failed step, such as checking the source, creating encrypted storage, copying previews or verifying the copy.

Open that local app to review the workflow. Close other running copies of Theatrum Ex Machina first so that macOS does not forward the launch to a different running version. Normal catalogue settings are shared unless a separate portable settings directory is selected when launching; the automated acceptance tests use isolated disposable profiles.

See the [validation record](./private-hubs-validation.md) for the tested checkout, commands and limits. This is an experimental storage format; retain an ordinary backup while reviewing it.
