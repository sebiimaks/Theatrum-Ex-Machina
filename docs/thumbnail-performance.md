# Ordinary thumbnail loading: investigation and correction

## Source and scope

- Privacy baseline: `676dc87b49b4dd67b8bc7502634f51f244c73023`, branch `codex/private-hubs`.
- Production reference: `de9922a22cf2bee4b5b9456f4dfc03a77ab8ad79`, branch `main`.
- Repository: `https://github.com/sebiimaks/Theatrum-Ex-Machina.git`.
- Working root: `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs`.
- Preflight was clean; the correction and its tests were built and measured as uncommitted changes on the privacy branch. This worktree is not designated for production releases.
- Electron comparisons used Electron 42.11.1 / Chromium 148.0.7778.280 on macOS arm64. The separate Node worker experiment used Node 22.23.2.

Synthetic fixtures stayed in the workspace. Subsequent application measurements used the user's explicitly authorized default hub. Saved diagnostics contain timings, counts, dimensions, cache flags and application-source call sites; this report contains no media paths, titles, identifiers, images or catalogue contents. Raw diagnostics remain ignored workspace artifacts.

## Findings

The reproduced pause occurs before native media fetching, in ordinary preview canonical-path validation. Background folder watching submits a large burst of asynchronous filesystem work into the shared execution path. A dedicated worker performed simultaneous checks of the same preview paths in under 0.1 ms while the ordinary asynchronous checks waited hundreds of milliseconds. Image delivery and renderer work did not explain those captured pauses.

The onset specifically on the privacy branch remains unconfirmed. Production has the same canonical checks, watcher configuration and relevant dependency versions. The additional JavaScript response-stream wrapper was not established as the cause. The private browser's disabled cache is scoped to its own separate session.

## Synthetic production comparisons

Three balanced fresh-process trials per protocol implementation used the same runtime, bytes, permissions and window geometry. Each viewport mounted 48 images; the unseen viewport used disjoint URLs. No private workspace was opened.

| Median viewport load completion | Production protocol | Privacy baseline protocol |
|---|---:|---:|
| Initial thumbnails | 42.8 ms | 42.3 ms |
| Previously unseen thumbnails | 33.1 ms | 34.8 ms |
| Return to initial thumbnails | 0.7 ms | 0.8 ms |
| Initial filmstrips | 48.9 ms | 48.1 ms |
| Previously unseen filmstrips | 58.1 ms | 47.1 ms |

Initial per-request medians: canonical checks 6.0/4.7 ms, native fetch-to-headers 14.3/14.7 ms, headers-to-EOF 4.6/6.1 ms, renderer request-to-completion 31.7/32.7 ms (production/privacy). These overlapping concurrent intervals are not additive. Separate warm filesystem reads completed a 48-thumbnail batch in 1–3 ms.

Decode tracing did not identify a privacy-specific delay: initial thumbnail decode-event totals were 35.6/33.4 ms, paint totals 1.3/1.4 ms. Totals sum elapsed events across threads and may overlap; they are not serial wall-clock or CPU time. Large filmstrips required substantially more decoding in both variants.

The actual Angular gallery used a synthetic 240-video hub, 20 initially visible images and 25 images after a disjoint scroll. One quarter of entries loaded a default-frame filmstrip. Protocol-only swapping retained the privacy application host; a separate full-production comparison used production main/support sources and renderer.

| Median gallery load completion, three runs | Production protocol in privacy host | Privacy baseline | Full production host |
|---|---:|---:|---:|
| Initial, from pre-Angular instrumentation | 189.9 ms | 186.2 ms | 209.9 ms |
| Unseen viewport, from scroll command | 36.8 ms | 37.2 ms | 36.4 ms |
| Return viewport, from scroll command | 27.4 ms | 30.2 ms | 26.2 ms |

Full-production initial trials ranged 183.7–232.4 ms; unseen scrolling ranged 35.4–45.1 ms. Initial mounting occurred after 165.3–215.8 ms. The synthetic gallery had a startup long task in every configuration, without a corresponding long task during scrolling. Return scrolling made no new media requests in these tests. The reported multi-second pause was absent from the synthetic application comparisons.

## Authorized application measurements

The existing packaged test application's main entrypoint and protocol JavaScript were byte-identical to current baseline TypeScript emission. Instrumentation was installed before application navigation through a paused main-process inspector. Normal authorization, validation, streaming and cancellation remained enabled.

| Capture | Relevant observation |
|---|---|
| `capture-5Du2Bf` | Initial thumbnail requests included a 406 ms wait and a group waiting 664–667 ms before native fetch. Fetch-to-EOF for that group took 9–13 ms. A filmstrip waited 1,153 ms before fetch and 3.2 ms for delivery. |
| `capture-1zRgYA` | 13,878 `lstat` calls and 391 directory reads; peak 1,545 outstanding logical filesystem calls. Slow-call stacks identified readdirp enumeration and chokidar watcher setup. Individual preview validation waits reached 4.3 seconds. |
| `capture-1DIays` | Increasing `UV_THREADPOOL_SIZE` from 4 to 16 retained the same 13,878 `lstat` calls and still produced 1.1–2.5 second filmstrip validation waits. Increasing the pool was not a sufficient correction. |
| `capture-BFj3PU` | Paired shadow checks of the same paths used synchronous calls in a dedicated worker; results did not replace or bypass actual validation. Sixteen delayed asynchronous operations took 259–1,207 ms each while paired worker filesystem calls took 0.0065–0.094 ms. All shadow checks succeeded. |

In the first capture, images mounted around 546–557 ms after instrumentation. The initial thumbnail group finished native delivery at 1,242 ms; its last observed image load followed within approximately 1 ms and the subsequent frame opportunity within 15 ms. The renderer's measured startup long task preceded this wait. Two animation frames establish opportunities to render, not proof of physical display presentation; `img.decode()` readiness is not equivalent to original decode duration.

A 20 ms main-loop heartbeat and slow synchronous-filesystem observer found no matching main-thread stall during the delayed requests in the pool-4 attribution capture. The more intrusive pool-16 capture did show main-loop gaps, so it cannot support an unqualified claim that every diagnostic run was free of main-thread overhead. Global filesystem observers retain stacks and add Promise work; their outstanding count measures logical API operations, not directly occupied libuv threads or kernel queue depth.

Watcher traversal is broader than the catalogue's video count. It visits configured, non-excluded directories, including directories containing unrelated files. Nonmedia files are filtered after metadata is available. Chokidar 4.0.3, readdirp 4.1.2 and fdir 6.5.0 are unchanged from production. The four-operation fdir limit does not constrain chokidar's independent enumeration.

These results establish contention in the shared asynchronous filesystem path as the actionable mechanism. They do not provide native kernel queue/service-time measurements, nor establish which historical change first made the symptoms noticeable.

## Scrolling and caches

Fresh process/profile tests isolate Chromium cache state, not OS cache state. Synthetic fixtures were recently written and OS filesystem caches were warm or uncontrolled throughout; no system-wide purge was performed. Real-hub restarts also reused filesystem caches and should not be described as cold-disk tests.

Unseen scrolling after the watcher burst could complete quickly even in the baseline. Requests during the burst, including filmstrips requested by hovering, could stall. These phases must be distinguished from return scrolling, which reused already loaded URLs.

Completing a source scan can send `import-progress-update` with stage `done`, even when extraction queues are idle. The renderer then increments its preview revision, changing all preview URLs and causing another request burst without a scroll. This behavior exists in production; a changed revision does not prove that preview files were regenerated. Corrected scrolling measurements must separate these invalidations from first exposure to an image.

## Correction and independent isolation check

`normal-preview-validation` moves the same three canonical-path resolutions, containment comparisons and file-type check into one lazy worker using synchronous filesystem calls on that worker's thread. The main process remains asynchronous. No canonical result cache or persistent path list is introduced. The existing response streaming, per-chunk authorization, cancellation and private-session separation remain in place.

Admission is bounded to 512 queued/active lookups. Queued cancellation clears its input; active work remains owned until a reply or actual worker exit. The worker's entire lifetime, including idle time, belongs to the ordinary-operation epoch. Private handoff waits for termination, including idle workers; late replies cannot restore revoked authority. Errors and malformed replies fail closed.

An independent workspace-only experiment submitted 24 checks under four synthetic PBKDF2 jobs occupying a four-slot libuv pool. Six trials alternated submission order. Median batch completion changed from 92.76 ms through ordinary filesystem promises to 1.69 ms through a warm dedicated worker. Without contention, corresponding medians were 1.04 and 2.23 ms. Worker startup cost 16.05 ms separately. This verifies isolation under synthetic contention; it is not a network-storage or rendering benchmark.

## Validation and local build

Passed: worker validation/lifecycle tests (13), ordinary/private protocol tests (20), normal-operation scope, normal-application pause, protocol-path validation, and main-application drain tests; TypeScript checks and lint also passed. Coverage includes symlink escapes, cancellation, queue limits, malformed replies, startup/posting failures, idle termination, epoch restart and waiting for actual worker exit.

Local test packaging used the working root, privacy branch and baseline commit listed above, with the task's tracked changes present. Exact command:

```sh
npm run media:prepare && npm run build:prod && ./node_modules/.bin/electron-builder build --mac dir --arm64 --publish never --config.electronDist=node_modules/electron/dist --config.directories.output=release-test-thumbnail-performance && sh ./bin/package-media-source.sh ./release-test-thumbnail-performance && node ./bin/verify-packaged-app.mjs './release-test-thumbnail-performance/mac-arm64/Theatrum Ex Machina.app'
```

Artifact: `/Users/sm/Workspace/Theatrum-Ex-Machina-private-hubs/release-test-thumbnail-performance/mac-arm64/Theatrum Ex Machina.app`. The initial sandboxed verifier launch aborted; rerunning the same verifier with GUI execution permission passed runtime and licensing checks. This is a local test artifact, not a production release. No installed application was replaced.

## Corrected application measurements

The corrected package ran with the same default hub, default four-worker pool, access protections and watcher workload (13,878 status calls and 391 directory reads). The sequence included corrected run A, an original-build control, then corrected run B, so improvement cannot be explained solely by running the correction after the original warmed the filesystem cache.

| Observed timing | Original control after correction | Corrected A | Corrected B |
|---|---:|---:|---:|
| Initial 30 thumbnail responses, maximum | 11.6 ms | 43.0 ms | 27.4 ms |
| Slowest preview response in the complete capture | 804.1 ms | 83.4 ms | 39.2 ms |
| Unseen-scroll preview responses, maximum | 157.7 ms | 83.4 ms | 34.3 ms |
| Unseen images: mount-to-load median | 163.5 ms | 25.4 ms | 19.2 ms |
| Unseen images: mount-to-load maximum | 165.9 ms | 101.8 ms | 40.8 ms |

These are bounded diagnostic runs, not matched per-file benchmark trials. Scrolling occurred at approximately 21.3, 19.7 and 7.5 seconds respectively; all three overlapped the initial scan. Scroll groups include requests submitted within 700 ms of the recorded scroll, rather than the earlier phase-arm command. Hovered filmstrip requests can accompany thumbnails. The original's fastest initial thumbnails completed before scan contention; a previous original run delayed most initial thumbnail responses by approximately 672 ms. Thus the correction removes observed contention stalls but adds worker startup/communication cost to uncontended requests. It is not a universal per-request speedup.

Corrected run B completed the early unseen viewport's observed image loads within 53 ms of scrolling, with two-frame opportunities within 74 ms. No corresponding long renderer task explains the original filesystem pauses. Later source-scan revision invalidation still caused a reload as designed. Repeating the already-revised 35-image viewport generated **zero new protocol requests**; those images were already complete at mount. All captured original and corrected media responses returned status 200.

The corrected runs are `capture-OTrOq6` and `capture-HrKwtH`; the intervening original control is `capture-yiEsaI`. Earlier original captures reached 1.15–4.28 seconds. The packaged protocol and both worker modules were byte-identical to compiled workspace files; the worker ran successfully from the ASAR. Corrected ASAR SHA-256: `9a24d3e5043126beaeab06b0ac557a3e84c07baaa36a5802ee86c4ba2104d7d8`. Diagnostic processes and inspectors were closed after measurement.

The remaining limits are true cold OS/storage caches, other hub/storage configurations, and the historical reason the slowdown first became noticeable. The correction remains on the privacy branch; no production promotion, release publication, or installed-app replacement was performed.

## Local evidence

Ignored workspace evidence is under `tmp/ordinary-perf/` (protocol comparison), `tmp/thumbnail-host-benchmark/` (gallery protocol swaps and `fullproduction-1` through `fullproduction-3`), `tmp/personal-performance/` (sanitized authorized application measurements), and `tmp/ordinary-perf/worker-isolation/` (script, raw synthetic timings and methodology). Only this aggregate report and implementation/tests belong in source control.
