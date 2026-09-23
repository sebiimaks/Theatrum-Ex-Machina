# Touch ID for private hubs

Touch ID work is deferred while the first password-based private-hub build is reviewed. The macOS development build offers **File → Create private copy…** and **File → Open private hub…** with password unlock. Follow the [first-build guide](./private-hubs-first-build.md) for that workflow. The retained Touch ID implementation and the signed-app verification still required for it are described below.

## Controls for a future signed build

The unsigned first build reports Touch ID as unavailable. These directions describe the retained implementation for later signed-app verification.

In the private gallery, open **Protection**, then **Touch ID on this Mac**. Enter the current hub password and choose **Enable Touch ID**. In a correctly signed build, macOS authenticates access to the new Keychain item before enrollment is accepted. The app does not save the password in Keychain.

An enrolled hub offers **Unlock with Touch ID** on its unlock screen. The password field remains available. Touch ID enrollment belongs to this Mac and this app identity; the saved key is not copied with the hub and does not synchronize through iCloud. An unchanged copy on the same Mac shares its existing enrollment, so removing that enrollment affects those copies too. Keep the hub password for another Mac, unavailable hardware, biometric lockout, or changes to enrolled fingerprints.

Use **Disable Touch ID** to remove this hub's saved Keychain item. When Touch ID is unavailable, **Remove stored Touch ID key** remains available for an earlier enrollment. An unavailable result does not mean that a saved item was deleted. These controls leave the hub encrypted.

Changing the hub password invalidates Touch ID for the current hub header. If the app can access its existing enrollment, it removes that item before publishing the new password envelope. An unsigned build, another app signing identity, or another Mac cannot prove deletion of inaccessible credentials. Old hub/header copies remain subject to the format's existing rollback limitations. Re-enable Touch ID with the new hub password.

## Key protection

The native module runs inside Electron's main process. It uses Apple's data-protection Keychain with a fixed app service, an opaque per-hub account, device-only accessibility while the Mac is unlocked, and `biometryCurrentSet` access control. Every query selects that Keychain implementation explicitly. There is no legacy-Keychain or standalone-authentication-prompt fallback.

The stored 64-byte payload contains the hub's random data key and a digest of its complete canonical password envelope. Retrieved payloads must match the current header, key check, authenticated activation record and catalogue before the session opens. Paths, hub names and passwords are not Keychain attributes. Password entry, key retrieval and encrypted storage remain in their existing isolated/main-process boundaries; renderer bridges expose only narrow actions and status.

Each operation has a fresh authentication context, with authentication reuse disabled. Native work runs off the JavaScript event loop. Locking and cancellation invalidate the context, reject stale results and wait for cleanup. Enrollment is provisional until the caller accepts it. Failed or cancelled enrollment removes only the newly created item's persistent reference; uncertain cleanup prevents the private session from being reused.

Mutable buffers owned by the app are wiped after use. This does not establish erasure of operating-system memory, Apple's internal allocations, runtime copies or previously saved hub copies.

## Signing and verification

The current development build is unsigned. It reports Touch ID as unavailable and keeps password unlock working. The native module requires the expected app identifier, an Apple-issued signing identity, matching application/team entitlements, hardened runtime, enabled library validation and disabled debugging, unsigned-executable-memory and DYLD-environment exceptions before it consults LocalAuthentication or Keychain. There is no development bypass for these checks.

For a local interactive test, prepare a provisioned app identity with Keychain access for `com.github.sebiimaks.theatrumexmachina`, sign the app and its native code consistently, and use a build without the debugging entitlement. Apple's capability table lists Keychain Sharing for a free Apple Developer account as well as paid development and Developer ID distribution. A distributable Developer ID build requires the appropriate distribution identity and profile. No account, certificate or provisioning profile is created by the test suite.

The native module compiles with `npm run privacy:build` to `build/privacy-tools/private-touch-id.node`. The macOS packaging hook rebuilds it for the native target architecture and includes it in `Resources/privacy-tools`; the main process loads that fixed packaged path. The local unsigned test package passed the standard package verifier and ordinary application startup. A separate fixture using its exact packaged modules and native resources also loaded the addon with `app.isPackaged` true and exercised the availability check. This verifies packaged resource resolution and native-module compatibility; signed biometric acceptance remains outstanding. Do not copy the development artifact into an installed application as a substitute for signing and packaging verification.

Automated tests exercise encrypted-store and session integration, UI controls, restricted bridges, cancellation, stale headers, password fallback and failed-cleanup quarantine. The development Electron UI fixture uses an explicitly synthetic in-memory credential provider. Native tests cover addon argument validation, refusal of an unsigned/unentitled host, and packaged loading with an availability check. These tests do not authenticate a real fingerprint or read, add or delete a real Keychain item. Run `npm run test:private-package:native` against the local test package for the packaged-resource fixture; its separate launcher does not establish signed-app acceptance. Commands, results and boundaries are recorded in [the validation log](./private-hubs-validation.md).

Interactive acceptance still needs a signed app and a person using Touch ID: enroll and retrieve, cancel, biometric lockout, fingerprint enrollment changes, disable while biometric authentication is unavailable, system lock during a pending prompt, relaunch, signed-app updates and changed signing identity. Confirm new enrollment rollback and persistent-reference deletion on the supported macOS versions before enabling the feature in the main application.

## Platform references

- [Apple: restricting Keychain item accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility)
- [Apple: current biometric enrollment access control](https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/biometrycurrentset)
- [Apple TN3137: macOS Keychain implementations, host entitlements and provisioning](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- [Apple: supported macOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-macos)
