# Main branch thumbnail validation

## Scope

Backport of the ordinary-preview correction in commit 448bdfe17064e60735b1f622e91df5ed3ca4775e to main, starting at 57572800f0d6abad63cd41ced49aeaedeb94ffdb. The private-hub feature is not included.

Main used the same three asynchronous canonical-path resolutions and file-status check as the pre-fix privacy implementation. These checks share Node's filesystem worker pool with background scans. The earlier investigation identified this contention in real application captures; it did not establish the additional privacy response-stream wrapper as the cause. See [the original investigation](https://github.com/sebiimaks/Theatrum-Ex-Machina/blob/448bdfe17064e60735b1f622e91df5ed3ca4775e/docs/thumbnail-performance.md).

## Main reproduction

On macOS arm64 with Node 22.23.2, the exact main validation function from the starting commit was compared with the exact dedicated worker source from the original fix. Six balanced trials each checked 24 synthetic preview paths. Four PBKDF2 jobs occupied the default four-slot libuv pool to reproduce contention independently of real media. Submission order and contention order alternated; all canonical-path results matched.

| Validation batch | Main median | Warm dedicated worker median |
|---|---:|---:|
| Uncontended | 0.82 ms | 2.01 ms |
| Shared pool occupied | 116.58 ms | 1.71 ms |

Contended ranges were 90.46–120.65 ms for main and 1.41–1.79 ms for the worker. Four fresh-worker trials took a median 16.09 ms versus 1.08 ms for uncontended main. The fix removes observed queue contention at the cost of worker startup and message overhead; it is not a universal per-request speedup.

Fixtures and diagnostics stayed beneath the workspace. Filesystem caches were warm or uncontrolled. This is a validation benchmark, not a cold-storage, image-delivery, decoding or rendering measurement. It confirms that main has the same contention mechanism, not that every hub will show the same delay. The earlier application captures separately cover initial loading, unseen scrolling and return scrolling.

Ignored evidence is in tmp/thumbnail-main-backport/benchmark.cjs and result.json. From the repository root, the measurement command was:

```sh
TMPDIR=/Users/sm/Workspace/Theatrum-Ex-Machina/tmp/thumbnail-main-backport UV_THREADPOOL_SIZE=4 node tmp/thumbnail-main-backport/benchmark.cjs
```

## Correction

The backport reuses the worker, bounded validation queue and standalone operation-lifetime tracker unchanged. The tracker contains no private-hub dependency. Canonical containment, regular-file and current-hub authorization checks remain required before native fetching. An aborted request cannot use a late validation result. No canonical-path cache is added, and native media delivery is unchanged.

The main-process TypeScript target matches the privacy branch's CommonJS/ES2022 configuration so the existing worker implementation is emitted without rewriting it. The Electron version and renderer configuration are unchanged. The worker entry point is explicitly included in compilation and falls under the existing node JavaScript packaging rule.

Regression checks cover worker startup/failure/exit, bounded admission, cancellation, symlink escapes, and authorization changes while validation is pending. The protocol tests exercise the registered main handler in addition to the existing path tests.

Passed on main: 46 tests across operation scope (8), worker validation (13), protocol paths (6), registered protocol handler (11), and Electron security (8). All application TypeScript checks, the persistence-test type check, and lint passed. Main-process compilation to an ignored workspace directory succeeded, and the emitted validator started its default compiled worker and validated a real synthetic fixture. No application packaging, installation or release publication was performed for this backport.
