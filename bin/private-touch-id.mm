// In-process N-API bridge: secrets never become command arguments or files.
// This addon intentionally has no test bypass for signing or Keychain policy.
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <node_api.h>
#include <array>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>

static NSString *const BundleID = @"com.github.sebiimaks.theatrumexmachina";
static NSString *const Service = @"com.github.sebiimaks.theatrumexmachina.private-hub.touch-id.v1";
static constexpr size_t SecretBytes = 64;
static void Wipe(void *bytes, size_t size) {
  volatile unsigned char *cursor = static_cast<volatile unsigned char *>(bytes);
  while (size--) { *cursor++ = 0; }
}
enum class Kind { Availability, Has, Enroll, Unlock, Remove };
enum class Phase { Primary, Rollback };
enum class Status { Available, Unavailable, Present, Absent, Enrolled, Cancelled, Secret, Removed, Missing, Error, CleanupFailed };
struct Operation {
  napi_env env = nullptr;
  napi_async_work work = nullptr;
  napi_async_cleanup_hook_handle cleanup = nullptr;
  napi_deferred deferred = nullptr;
  napi_ref genericFailure = nullptr;
  uint32_t identifier = 0;
  Kind kind = Kind::Availability;
  Phase phase = Phase::Primary;
  Status status = Status::Error;
  Status afterRollback = Status::Cancelled;
  std::atomic<bool> cancelled{false};
  std::atomic<bool> shuttingDown{false};
  std::mutex contextMutex;
  __strong LAContext *context = nil;
  __strong NSString *identity = nil;
  __strong NSString *group = nil;
  __strong NSData *ownedReference = nil;
  std::array<unsigned char, SecretBytes> secret{};
  bool waitingForAcknowledgment = false;
  bool created = false;
  bool mutationAttempted = false;
  bool cleanupContext = false; // guarded by contextMutex
  ~Operation() { Wipe(secret.data(), secret.size()); }
};
static std::mutex globalMutex;
static Operation *active = nullptr;
static bool quarantined = false;
static uint32_t nextIdentifier = 0;

static const char *StatusName(Status status) {
  switch (status) {
    case Status::Available: return "available";
    case Status::Unavailable: return "unavailable";
    case Status::Present: return "present";
    case Status::Absent: return "absent";
    case Status::Enrolled: return "enrolled";
    case Status::Cancelled: return "cancelled";
    case Status::Secret: return "secret";
    case Status::Removed: return "removed";
    case Status::Missing: return "missing";
    case Status::CleanupFailed: return "cleanup-failed";
    default: return "error";
  }
}
static napi_value Fail(napi_env env) {
  napi_throw_error(env, nullptr, "Touch ID is unavailable.");
  return nullptr;
}
static void Invalidate(Operation *operation) {
  LAContext *context;
  { std::lock_guard<std::mutex> guard(operation->contextMutex); context = operation->context; }
  [context invalidate];
}
static void Cancel(Operation *operation) {
  operation->cancelled.store(true);
  LAContext *context;
  {
    std::lock_guard<std::mutex> guard(operation->contextMutex);
    context = operation->cleanupContext ? nil : operation->context;
  }
  [context invalidate];
}
static LAContext *NewContext(Operation *operation, bool interactive) {
  LAContext *context = [[LAContext alloc] init];
  context.touchIDAuthenticationAllowableReuseDuration = 0;
  context.localizedFallbackTitle = @"";
  context.localizedCancelTitle = @"Cancel";
  context.localizedReason = @"Unlock this private hub in Theatrum Ex Machina";
  context.interactionNotAllowed = !interactive;
  {
    std::lock_guard<std::mutex> guard(operation->contextMutex);
    [operation->context invalidate];
    operation->context = context;
    operation->cleanupContext = operation->phase == Phase::Rollback;
    if (operation->cancelled.load() && !operation->cleanupContext) { [context invalidate]; }
  }
  return context;
}

// An Apple-issued signing identity, hardened runtime, exact bundle identity,
// and matching application-identifier entitlement are required before any
// LocalAuthentication/Keychain operation. No ad-hoc or legacy-keychain fallback.
static NSString *SignedAccessGroup() {
  SecCodeRef code = nullptr;
  SecStaticCodeRef staticCode = nullptr;
  SecRequirementRef requirement = nullptr;
  CFDictionaryRef infoRef = nullptr;
  NSString *group = nil;
  NSString *expression = [NSString stringWithFormat:
    @"anchor apple generic and identifier \"%@\" and entitlement[\"com.apple.application-identifier\"] exists and entitlement[\"com.apple.developer.team-identifier\"] exists", BundleID];
  if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess || !code) { goto done; }
  if (SecRequirementCreateWithString((__bridge CFStringRef)expression, kSecCSDefaultFlags, &requirement) != errSecSuccess || !requirement) { goto done; }
  if (SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) != errSecSuccess) { goto done; }
  if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &staticCode) != errSecSuccess || !staticCode) { goto done; }
  if (SecCodeCopySigningInformation(staticCode, kSecCSSigningInformation, &infoRef) != errSecSuccess || !infoRef) { goto done; }
  {
    NSDictionary *info = (__bridge NSDictionary *)infoRef;
    NSDictionary *entitlements = info[(__bridge id)kSecCodeInfoEntitlementsDict];
    NSString *team = info[(__bridge id)kSecCodeInfoTeamIdentifier];
    NSNumber *flags = info[(__bridge id)kSecCodeInfoFlags];
    if (![entitlements isKindOfClass:[NSDictionary class]] || ![team isKindOfClass:[NSString class]]
      || ![flags isKindOfClass:[NSNumber class]] || !(flags.unsignedIntValue & kSecCodeSignatureRuntime)
      || ![info[(__bridge id)kSecCodeInfoIdentifier] isEqual:BundleID]
      || team.length != 10 || [team rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] invertedSet]].location != NSNotFound
      || ![entitlements[@"com.apple.developer.team-identifier"] isEqual:team]
      || [entitlements[@"com.apple.security.get-task-allow"] boolValue]
      || [entitlements[@"get-task-allow"] boolValue]
      || [entitlements[@"com.apple.security.cs.disable-library-validation"] boolValue]
      || [entitlements[@"com.apple.security.cs.allow-unsigned-executable-memory"] boolValue]
      || [entitlements[@"com.apple.security.cs.allow-dyld-environment-variables"] boolValue]) { goto done; }
    NSString *expected = [NSString stringWithFormat:@"%@.%@", team, BundleID];
    if (![entitlements[@"com.apple.application-identifier"] isEqual:expected]) { goto done; }
    group = expected;
  }
done:
  if (infoRef) { CFRelease(infoRef); }
  if (staticCode) { CFRelease(staticCode); }
  if (requirement) { CFRelease(requirement); }
  if (code) { CFRelease(code); }
  return group;
}

// Named requests explicitly target the same device-local data-protection
// keychain and the host's private access group. Owned-reference requests below
// select only the exact item already created by this restricted add query.
static NSMutableDictionary *Query(Operation *operation, LAContext *context, bool interactive) {
  NSMutableDictionary *query = [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService: Service,
    (__bridge id)kSecAttrAccount: [@"hub-v1:" stringByAppendingString:operation->identity],
    (__bridge id)kSecAttrAccessGroup: operation->group,
    (__bridge id)kSecUseDataProtectionKeychain: @YES,
    (__bridge id)kSecAttrSynchronizable: @NO,
    (__bridge id)kSecUseAuthenticationContext: context,
    (__bridge id)kSecUseAuthenticationUI: (__bridge id)(interactive ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail),
  } mutableCopy];
  return query;
}
static NSMutableDictionary *OwnedQuery(Operation *operation, LAContext *context, bool interactive = false) {
  // This is a trusted reference returned only by our exact non-syncing,
  // access-group-scoped add. DP reference queries reject extra attributes, so
  // service/account/group/sync filters cannot be repeated here. The reference
  // narrows access to exactly that one newly-owned item; it never crosses JS.
  // kSecMatchItemList is legacy-only and cannot target the DP keychain.
  return [@{
    (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecUseDataProtectionKeychain: @YES,
    (__bridge id)kSecValuePersistentRef: operation->ownedReference,
    (__bridge id)kSecUseAuthenticationContext: context,
    (__bridge id)kSecUseAuthenticationUI: (__bridge id)(interactive ? kSecUseAuthenticationUIAllow : kSecUseAuthenticationUIFail),
  } mutableCopy];
}
static OSStatus Exists(NSMutableDictionary *query) {
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  query[(__bridge id)kSecReturnAttributes] = @YES;
  CFTypeRef result = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  if (result) { CFRelease(result); }
  return status;
}
static bool Rollback(Operation *operation) {
  if (!operation->created) { return true; }
  if (!operation->ownedReference || !operation->group) { return false; }
  LAContext *context = NewContext(operation, false);
  OSStatus removed = SecItemDelete((__bridge CFDictionaryRef)OwnedQuery(operation, context));
  if (removed != errSecSuccess && removed != errSecItemNotFound) { return false; }
  if (Exists(OwnedQuery(operation, context)) != errSecItemNotFound) { return false; }
  operation->created = false;
  operation->ownedReference = nil;
  return true;
}
static bool TouchIDAvailable(LAContext *context) {
  NSError *error = nil;
  return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&error]
    && context.biometryType == LABiometryTypeTouchID;
}
static Status ReadSecret(Operation *operation, LAContext *context, bool enrollment) {
  NSMutableDictionary *query = enrollment ? OwnedQuery(operation, context, true) : Query(operation, context, true);
  query[(__bridge id)kSecReturnData] = @YES;
  query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = nullptr;
  OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
  Status outcome = Status::Error;
  if (operation->cancelled.load() || status == errSecUserCanceled) { outcome = Status::Cancelled; }
  else if (status == errSecItemNotFound) { outcome = Status::Missing; }
  else if (status == errSecAuthFailed || status == errSecNotAvailable || status == errSecInteractionNotAllowed) { outcome = Status::Unavailable; }
  else if (status == errSecSuccess && result && CFGetTypeID(result) == CFDataGetTypeID()
    && CFDataGetLength((CFDataRef)result) == SecretBytes) {
    const unsigned char *bytes = CFDataGetBytePtr((CFDataRef)result);
    if (enrollment) {
      unsigned char difference = 0;
      for (size_t i = 0; i < SecretBytes; ++i) { difference |= bytes[i] ^ operation->secret[i]; }
      outcome = difference == 0 ? Status::Enrolled : Status::Error;
    } else { std::memcpy(operation->secret.data(), bytes, SecretBytes); outcome = Status::Secret; }
  }
  // Security owns this immutable NSData allocation; release it promptly. The
  // bridge can explicitly wipe only its own mutable buffers, not Apple's copy.
  if (result) { CFRelease(result); }
  return outcome;
}

static void Execute(napi_env, void *data) {
  Operation *operation = static_cast<Operation *>(data);
  @autoreleasepool {
    @try {
      if (operation->phase == Phase::Rollback) {
        operation->status = Rollback(operation) ? operation->afterRollback : Status::CleanupFailed;
        return;
      }
      if (operation->cancelled.load()) { operation->status = Status::Cancelled; return; }
      operation->group = SignedAccessGroup();
      if (!operation->group) { operation->status = Status::Unavailable; return; }
      if (operation->cancelled.load()) { operation->status = Status::Cancelled; return; }
      bool interactive = operation->kind == Kind::Enroll || operation->kind == Kind::Unlock;
      LAContext *context = NewContext(operation, interactive);
      if (operation->kind == Kind::Availability) {
        operation->status = TouchIDAvailable(context) ? Status::Available : Status::Unavailable;
        return;
      }
      if (operation->kind == Kind::Has) {
        OSStatus status = Exists(Query(operation, context, false));
        operation->status = status == errSecItemNotFound ? Status::Absent
          : (status == errSecSuccess || status == errSecInteractionNotAllowed ? Status::Present : Status::Error);
        return;
      }
      if (operation->kind == Kind::Remove) {
        if (operation->cancelled.load()) { operation->status = Status::Cancelled; return; }
        operation->mutationAttempted = true;
        OSStatus status = SecItemDelete((__bridge CFDictionaryRef)Query(operation, context, false));
        // Once deletion starts, prove absence even if the request is cancelled.
        // Use a fresh noninteractive context, independent of cancellation.
        operation->phase = Phase::Rollback;
        context = NewContext(operation, false);
        operation->status = (status == errSecSuccess || status == errSecItemNotFound)
          && Exists(Query(operation, context, false)) == errSecItemNotFound ? Status::Removed : Status::CleanupFailed;
        return;
      }
      if (!TouchIDAvailable(context)) { operation->status = Status::Unavailable; return; }
      if (operation->cancelled.load()) { operation->status = Status::Cancelled; return; }
      if (operation->kind == Kind::Unlock) {
        operation->status = ReadSecret(operation, context, false);
        return;
      }
      CFErrorRef error = nullptr;
      SecAccessControlRef control = SecAccessControlCreateWithFlags(kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAccessControlBiometryCurrentSet, &error);
      if (error) { CFRelease(error); }
      if (!control) { operation->status = Status::Unavailable; return; }
      NSMutableDictionary *query = Query(operation, context, true);
      query[(__bridge id)kSecAttrAccessControl] = (__bridge id)control;
      query[(__bridge id)kSecAttrLabel] = @"Theatrum Ex Machina private hub";
      query[(__bridge id)kSecValueData] = [NSData dataWithBytesNoCopy:operation->secret.data() length:SecretBytes freeWhenDone:NO];
      query[(__bridge id)kSecReturnPersistentRef] = @YES;
      CFTypeRef reference = nullptr;
      operation->mutationAttempted = true;
      OSStatus status = SecItemAdd((__bridge CFDictionaryRef)query, &reference);
      CFRelease(control);
      if (status != errSecSuccess) {
        operation->mutationAttempted = false;
        if (reference) { CFRelease(reference); }
        // In particular, duplicates never reach a delete or update operation.
        operation->status = operation->cancelled.load() || status == errSecUserCanceled ? Status::Cancelled : Status::Error;
        return;
      }
      operation->created = true;
      if (reference && CFGetTypeID(reference) == CFDataGetTypeID() && CFDataGetLength((CFDataRef)reference) > 0
        && CFDataGetLength((CFDataRef)reference) <= 4096) {
        operation->ownedReference = (__bridge NSData *)reference;
      }
      if (reference) { CFRelease(reference); }
      if (!operation->ownedReference) { operation->status = Status::CleanupFailed; return; }
      operation->status = operation->cancelled.load() ? Status::Cancelled : ReadSecret(operation, context, true);
      if (operation->status == Status::Missing) { operation->status = Status::Error; }
      if (operation->status != Status::Enrolled) {
        operation->phase = Phase::Rollback;
        if (!Rollback(operation)) { operation->status = Status::CleanupFailed; }
      }
    } @catch (NSException *) {
      operation->status = operation->mutationAttempted ? Status::CleanupFailed : Status::Error;
      if (operation->created) {
        operation->phase = Phase::Rollback;
        @try { if (!Rollback(operation)) { operation->status = Status::CleanupFailed; } }
        @catch (NSException *) { operation->status = Status::CleanupFailed; }
      }
    } @finally {
      Invalidate(operation);
      if (operation->status != Status::Secret) { Wipe(operation->secret.data(), operation->secret.size()); }
    }
  }
}
static napi_value Result(Operation *operation) {
  napi_value result, status;
  if (napi_create_object(operation->env, &result) != napi_ok
    || napi_create_string_utf8(operation->env, StatusName(operation->status), NAPI_AUTO_LENGTH, &status) != napi_ok
    || napi_set_named_property(operation->env, result, "status", status) != napi_ok) { return nullptr; }
  if (operation->status == Status::Secret) {
    napi_value secret;
    if (napi_create_buffer_copy(operation->env, SecretBytes, operation->secret.data(), nullptr, &secret) != napi_ok
      || napi_set_named_property(operation->env, result, "secret", secret) != napi_ok) { return nullptr; }
  }
  return result;
}
static void ClearPendingException(napi_env env) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
    napi_value ignored;
    napi_get_and_clear_last_exception(env, &ignored);
  }
}
static void Reject(Operation *operation) {
  if (operation->shuttingDown.load()) { return; }
  ClearPendingException(operation->env);
  napi_value error;
  // Allocated before any native work starts, so completion does not need to
  // allocate another JS object merely to settle a failed native result.
  if (operation->genericFailure && napi_get_reference_value(operation->env, operation->genericFailure, &error) == napi_ok) {
    napi_reject_deferred(operation->env, operation->deferred, error);
  }
}
static void Dispose(Operation *operation) {
  Invalidate(operation);
  if (operation->work) { napi_delete_async_work(operation->env, operation->work); }
  {
    std::lock_guard<std::mutex> guard(globalMutex);
    if (operation->status == Status::CleanupFailed) { quarantined = true; }
    if (active == operation) { active = nullptr; }
  }
  if (operation->genericFailure) { napi_delete_reference(operation->env, operation->genericFailure); }
  if (operation->cleanup) { napi_remove_async_cleanup_hook(operation->cleanup); }
  delete operation;
}
static bool Queue(Operation *operation);
static void Complete(napi_env env, napi_status status, void *data) {
  Operation *operation = static_cast<Operation *>(data);
  if (operation->work) { napi_delete_async_work(env, operation->work); operation->work = nullptr; }
  if (status != napi_ok) { operation->status = operation->created ? Status::CleanupFailed : Status::Error; }
  if (operation->status == Status::Enrolled && operation->created) {
    if (operation->cancelled.load() || operation->shuttingDown.load()) {
      operation->phase = Phase::Rollback;
      operation->afterRollback = Status::Cancelled;
      if (Queue(operation)) { return; }
      operation->status = Status::CleanupFailed;
    } else {
      // Retain exclusive ownership and the returned persistent reference until
      // JS synchronously accepts or rejects this provisional enrollment.
      operation->waitingForAcknowledgment = true;
      napi_value result = Result(operation);
      if (result && napi_resolve_deferred(env, operation->deferred, result) == napi_ok) { return; }
      ClearPendingException(env);
      operation->waitingForAcknowledgment = false;
      operation->phase = Phase::Rollback;
      operation->afterRollback = Status::Error;
      if (Queue(operation)) { return; }
      operation->status = Status::CleanupFailed;
    }
  }
  if (operation->cancelled.load() && operation->status == Status::Secret) {
    Wipe(operation->secret.data(), operation->secret.size());
    operation->status = Status::Cancelled;
  }
  if (!operation->shuttingDown.load()) {
    napi_value result = Result(operation);
    if (!result || napi_resolve_deferred(env, operation->deferred, result) != napi_ok) { Reject(operation); }
  }
  Dispose(operation);
}
static bool Queue(Operation *operation) {
  napi_value name;
  if (napi_create_string_utf8(operation->env, "private-touch-id", NAPI_AUTO_LENGTH, &name) != napi_ok
    || napi_create_async_work(operation->env, nullptr, name, Execute, Complete, operation, &operation->work) != napi_ok) { return false; }
  if (napi_queue_async_work(operation->env, operation->work) != napi_ok) {
    napi_delete_async_work(operation->env, operation->work); operation->work = nullptr; return false;
  }
  return true;
}
static void Cleanup(napi_async_cleanup_hook_handle, void *data) {
  Operation *operation = static_cast<Operation *>(data);
  operation->shuttingDown.store(true);
  Cancel(operation);
  if (operation->waitingForAcknowledgment) {
    operation->waitingForAcknowledgment = false;
    operation->phase = Phase::Rollback;
    operation->afterRollback = Status::Cancelled;
    if (!Queue(operation)) { operation->status = Status::CleanupFailed; Dispose(operation); }
  }
}
static bool String(napi_env env, napi_value value, char *target, size_t capacity) {
  napi_valuetype type;
  size_t size;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_string
    && napi_get_value_string_utf8(env, value, nullptr, 0, &size) == napi_ok && size < capacity
    && napi_get_value_string_utf8(env, value, target, capacity, &size) == napi_ok && std::strlen(target) == size;
}
static napi_value Begin(napi_env env, napi_callback_info info) {
  size_t count = 4;
  napi_value args[4];
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count < 2 || count > 3) { return Fail(env); }
  char name[24] = {}, identity[65] = {};
  if (!String(env, args[0], name, sizeof(name)) || !String(env, args[1], identity, sizeof(identity))) { return Fail(env); }
  Kind kind;
  if (std::strcmp(name, "availability") == 0) { kind = Kind::Availability; }
  else if (std::strcmp(name, "has") == 0) { kind = Kind::Has; }
  else if (std::strcmp(name, "enroll") == 0) { kind = Kind::Enroll; }
  else if (std::strcmp(name, "unlock") == 0) { kind = Kind::Unlock; }
  else if (std::strcmp(name, "remove") == 0) { kind = Kind::Remove; }
  else { return Fail(env); }
  if (kind == Kind::Availability ? identity[0] != '\0' : std::strlen(identity) != 64) { return Fail(env); }
  for (size_t i = 0; identity[i]; ++i) {
    if (!(identity[i] >= '0' && identity[i] <= '9') && !(identity[i] >= 'a' && identity[i] <= 'f')) { return Fail(env); }
  }
  bool buffer = false;
  void *bytes = nullptr;
  size_t size = 0;
  if (kind == Kind::Enroll) {
    if (count != 3 || napi_is_buffer(env, args[2], &buffer) != napi_ok || !buffer
      || napi_get_buffer_info(env, args[2], &bytes, &size) != napi_ok || size != SecretBytes) { return Fail(env); }
  } else if (count == 3) {
    napi_valuetype type;
    if (napi_typeof(env, args[2], &type) != napi_ok || type != napi_undefined) { return Fail(env); }
  }
  Operation *operation = new Operation();
  {
    std::lock_guard<std::mutex> guard(globalMutex);
    if (quarantined) {
      delete operation;
      napi_throw_error(env, "PRIVATE_TOUCH_ID_CLEANUP_FAILED", "Touch ID cleanup could not be confirmed.");
      return nullptr;
    }
    if (active || nextIdentifier == UINT32_MAX) { delete operation; return Fail(env); }
    operation->identifier = ++nextIdentifier;
    active = operation;
  }
  operation->env = env;
  operation->kind = kind;
  operation->identity = [NSString stringWithUTF8String:identity];
  if (bytes) { std::memcpy(operation->secret.data(), bytes, SecretBytes); }
  napi_value result, promise, identifier, message, failure;
  if (napi_create_promise(env, &operation->deferred, &promise) != napi_ok
    || napi_create_string_utf8(env, "Touch ID is unavailable.", NAPI_AUTO_LENGTH, &message) != napi_ok
    || napi_create_error(env, nullptr, message, &failure) != napi_ok
    || napi_create_reference(env, failure, 1, &operation->genericFailure) != napi_ok
    || napi_create_object(env, &result) != napi_ok
    || napi_create_uint32(env, operation->identifier, &identifier) != napi_ok
    || napi_set_named_property(env, result, "operation", identifier) != napi_ok
    || napi_set_named_property(env, result, "result", promise) != napi_ok
    || napi_add_async_cleanup_hook(env, Cleanup, operation, &operation->cleanup) != napi_ok
    || !Queue(operation)) { Dispose(operation); return Fail(env); }
  return result;
}
static bool Identifier(napi_env env, napi_value value, uint32_t *identifier) {
  napi_valuetype type;
  double numeric;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number
    || napi_get_value_double(env, value, &numeric) != napi_ok || !std::isfinite(numeric) || numeric < 1 || numeric > UINT32_MAX) { return false; }
  *identifier = static_cast<uint32_t>(numeric);
  return numeric == *identifier;
}
static napi_value CancelCall(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2], result;
  uint32_t identifier;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1
    || !Identifier(env, args[0], &identifier)) { return Fail(env); }
  {
    std::lock_guard<std::mutex> guard(globalMutex);
    if (active && active->env == env && active->identifier == identifier) { Cancel(active); }
  }
  napi_get_undefined(env, &result);
  return result;
}
static napi_value FinishEnrollment(napi_env env, napi_callback_info info) {
  size_t count = 3;
  napi_value args[3], promise;
  uint32_t identifier;
  bool accept;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2
    || !Identifier(env, args[0], &identifier) || napi_get_value_bool(env, args[1], &accept) != napi_ok) { return Fail(env); }
  Operation *operation;
  {
    std::lock_guard<std::mutex> guard(globalMutex);
    operation = active;
    if (!operation || operation->env != env || operation->identifier != identifier
      || !operation->waitingForAcknowledgment || operation->kind != Kind::Enroll) { return Fail(env); }
  }
  if (napi_create_promise(env, &operation->deferred, &promise) != napi_ok) {
    // No acknowledgment was made. Preserve the owned reference for rollback,
    // even though this synchronous call cannot return a new Promise.
    ClearPendingException(env);
    operation->waitingForAcknowledgment = false;
    operation->phase = Phase::Rollback;
    operation->afterRollback = Status::Cancelled;
    if (!Queue(operation)) { operation->status = Status::CleanupFailed; Dispose(operation); }
    return Fail(env);
  }
  operation->waitingForAcknowledgment = false;
  if (accept && !operation->cancelled.load()) {
    // The caller's acknowledgment is the linearization point. Cancellation
    // after this moment cannot retroactively turn a successful enable into a
    // failure; the hub lifecycle then owns any subsequent explicit removal.
    napi_value result = Result(operation);
    if (result && napi_resolve_deferred(env, operation->deferred, result) == napi_ok) {
      operation->created = false;
      operation->ownedReference = nil;
      Dispose(operation);
    } else {
      // Never relinquish the only safe rollback reference before success is
      // delivered. Failure still owns the item, and the returned promise must
      // settle only after rollback (or a branded ambiguous-cleanup failure).
      ClearPendingException(env);
      operation->phase = Phase::Rollback;
      operation->afterRollback = Status::Cancelled;
      if (!Queue(operation)) { operation->status = Status::CleanupFailed; Reject(operation); Dispose(operation); }
    }
  } else {
    operation->phase = Phase::Rollback;
    operation->afterRollback = Status::Cancelled;
    if (!Queue(operation)) {
      operation->status = Status::CleanupFailed;
      napi_value result = Result(operation);
      if (!result || napi_resolve_deferred(env, operation->deferred, result) != napi_ok) { Reject(operation); }
      Dispose(operation);
    }
  }
  return promise;
}
NAPI_MODULE_INIT() {
  napi_property_descriptor descriptors[] = {
    { "begin", nullptr, Begin, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "cancel", nullptr, CancelCall, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "finishEnrollment", nullptr, FinishEnrollment, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  if (napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors) != napi_ok) { return Fail(env); }
  return exports;
}
