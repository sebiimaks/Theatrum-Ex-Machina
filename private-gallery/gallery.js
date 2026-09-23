(() => {
  'use strict';

  const PAGE_SIZE = 48;
  // Leave session admission capacity available for an explicit video preview.
  const IMAGE_CONCURRENCY = 3;
  const IMAGE_ATTEMPTS = 3;
  const NOTES_LIMIT = 65536;
  const TAG_LIMIT = 128;
  const TAG_LENGTH = 512;
  const byId = id => document.getElementById(id);
  const search = byId('gallery-search');
  const grid = byId('gallery-grid');
  const galleryStatus = byId('gallery-status');
  const summary = byId('result-summary');
  const empty = byId('empty-state');
  const retryGallery = byId('retry-gallery');
  const previous = byId('previous-page');
  const next = byId('next-page');
  const pageLabel = byId('page-label');
  const details = byId('details-panel');
  const detailsScroll = byId('details-scroll');
  const detailsContent = byId('details-content');
  const detailsStatus = byId('details-status');
  const detailsTitle = byId('details-title');
  const detailsFacts = byId('details-facts');
  const detailsRating = byId('details-rating');
  const detailsTags = byId('details-tags');
  const detailsNotes = byId('details-notes');
  const tagDraft = byId('tag-draft');
  const addTag = byId('add-tag');
  const saveButton = byId('save-details');
  const discardButton = byId('discard-details');
  const editStatus = byId('edit-status');
  const editFooter = byId('edit-footer');
  const lockWarning = byId('lock-warning');
  const shortened = byId('shortened-notice');
  const poster = byId('detail-poster');
  const posterPlaceholder = byId('detail-placeholder');
  const video = byId('preview-video');
  const play = byId('play-preview');
  const filmstripToggle = byId('toggle-filmstrip');
  const filmstripPanel = byId('filmstrip-panel');
  const filmstripImage = byId('detail-filmstrip');
  const filmstripStatus = byId('filmstrip-status');
  const filmstripViewport = byId('filmstrip-viewport');
  const filmstripPrevious = byId('filmstrip-previous');
  const filmstripNext = byId('filmstrip-next');
  const regenerate = byId('regenerate-previews');
  const cancelGeneration = byId('cancel-regeneration');
  const generationStatus = byId('generation-status');
  const retryDetails = byId('retry-details');
  const lockButton = byId('lock-hub');
  const lockState = byId('lock-state');
  const protectionButton = byId('protection-button');
  const protectionPanel = byId('protection-panel');
  const protectionSelect = byId('auto-lock-minutes');
  const protectionSave = byId('save-protection');
  const protectionRetry = byId('retry-protection');
  const protectionClose = byId('close-protection');
  const protectionStatus = byId('protection-status');
  const protectionValues = ['0', '1', '5', '15', '30'];
  const passwordToggle = byId('change-password-toggle');
  const passwordForm = byId('change-password-form');
  const currentPasswordInput = byId('current-password');
  const newPasswordInput = byId('new-password');
  const confirmPasswordInput = byId('confirm-password');
  const passwordInputs = [currentPasswordInput, newPasswordInput, confirmPasswordInput];
  const passwordSubmit = byId('change-password-submit');
  const passwordStatus = byId('password-status');
  const copyToggle = byId('unprotected-copy-toggle');
  const copyForm = byId('unprotected-copy-form');
  const copyPassword = byId('unprotected-copy-password');
  const copyAcknowledge = byId('unprotected-copy-acknowledge');
  const copySubmit = byId('unprotected-copy-submit');
  const copyCancel = byId('cancel-unprotected-copy');
  const copyStatus = byId('unprotected-copy-status');
  const touchIdSummary = byId('touch-id-summary');
  const touchIdToggle = byId('touch-id-toggle');
  const touchIdDisable = byId('touch-id-disable');
  const touchIdForm = byId('touch-id-form');
  const touchIdPassword = byId('touch-id-password');
  const touchIdSubmit = byId('touch-id-submit');
  const touchIdStatus = byId('touch-id-status');
  const credentialBridge = globalThis.privateCredentials;
  const touchIdStatusRequest = typeof credentialBridge?.touchIdStatus === 'function'
    ? credentialBridge.touchIdStatus.bind(credentialBridge) : undefined;
  const enableTouchId = typeof credentialBridge?.enableTouchId === 'function'
    ? credentialBridge.enableTouchId.bind(credentialBridge) : undefined;
  const disableTouchId = typeof credentialBridge?.disableTouchId === 'function'
    ? credentialBridge.disableTouchId.bind(credentialBridge) : undefined;
  const changePassword = typeof credentialBridge?.changePassword === 'function'
    ? credentialBridge.changePassword.bind(credentialBridge) : undefined;
  const createUnprotectedCopy = typeof credentialBridge?.createUnprotectedCopy === 'function'
    ? credentialBridge.createUnprotectedCopy.bind(credentialBridge) : undefined;
  const cancelUnprotectedCopy = typeof credentialBridge?.cancelUnprotectedCopy === 'function'
    ? credentialBridge.cancelUnprotectedCopy.bind(credentialBridge) : undefined;
  const bridge = globalThis.privateGallery;
  const available = bridge && typeof bridge.list === 'function'
    && typeof bridge.detail === 'function' && typeof bridge.lock === 'function';
  const api = available ? {
    list: bridge.list.bind(bridge), detail: bridge.detail.bind(bridge), lock: bridge.lock.bind(bridge),
    save: typeof bridge.save === 'function' ? bridge.save.bind(bridge) : undefined,
    regenerate: typeof bridge.regenerate === 'function' ? bridge.regenerate.bind(bridge) : undefined,
    cancelRegeneration: typeof bridge.cancelRegeneration === 'function' ? bridge.cancelRegeneration.bind(bridge) : undefined,
    protection: typeof bridge.protection === 'function' ? bridge.protection.bind(bridge) : undefined,
    setProtection: typeof bridge.setProtection === 'function' ? bridge.setProtection.bind(bridge) : undefined,
  } : undefined;

  let locked = false;
  let composing = false;
  let offset = 0;
  let total = 0;
  let query = '';
  let listEpoch = 0;
  let detailEpoch = 0;
  let selectedId = '';
  let selectedDetail;
  let draftTags = [];
  let saving = false;
  let reloading = false;
  let regenerating = false;
  let cancelling = false;
  let listLoading = false;
  let detailLoading = false;
  let protectionPending = '';
  let protectionEpoch = 0;
  let savedProtection;
  let touchIdState = 'unavailable';
  let touchIdEpoch = 0;
  let touchIdComposing = false;
  let passwordEpoch = 0;
  let copyEpoch = 0;
  let copyComposing = false;
  let copyCancelling = false;
  let passwordWindowFocused = true;
  const passwordComposition = new Set();
  let conflict = false;
  const editorComposition = new Set();
  let selectionOrigin;
  let clipUrl = '';
  let playEpoch = 0;
  let searchTimer;
  let listRetryTimer;
  let detailRetryTimer;
  let observer;
  const imageJobs = new Set();
  const imageQueue = [];
  const runningImages = new Set();
  const cards = new Map();

  function previewUrl(value, kind) {
    if (typeof value !== 'string' || value.length > 4096) { return ''; }
    if (kind === 'filmstrip') {
      return /^theatrum:\/\/app\/media\/filmstrips\/[a-zA-Z0-9_-]{1,200}\.jpg(?:\?v=[a-f0-9]{32})?$/.exec(value)?.[0] === value ? value : '';
    }
    try {
      const url = new URL(value);
      const prefix = kind === 'thumbnail' ? '/media/thumbnails/' : '/media/clips/';
      if (url.protocol !== 'theatrum:' || url.hostname !== 'app' || url.port || url.username
        || url.password || url.hash || !url.pathname.startsWith(prefix)) { return ''; }
      return value;
    } catch { return ''; }
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) { return '—'; }
    const value = Math.floor(seconds);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value / 60) % 60;
    const remainder = String(value % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
  }

  function dimensions(item) {
    return Number.isFinite(item.width) && item.width > 0 && Number.isFinite(item.height) && item.height > 0
      ? `${item.width} × ${item.height}` : 'Resolution unavailable';
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function editable(item = selectedDetail) {
    return !!api?.save && item?.editable === true && /^[a-f0-9]{32}$/.test(item.revision)
      && typeof item.notes === 'string' && item.notes.length <= NOTES_LIMIT
      && Array.isArray(item.tags) && item.tags.length <= TAG_LIMIT
      && item.tags.every(tag => typeof tag === 'string' && tag.length <= TAG_LENGTH);
  }

  function dirty() {
    return editable() && (detailsNotes.value !== selectedDetail.notes || tagDraft.value !== ''
      || draftTags.length !== selectedDetail.tags.length
      || draftTags.some((tag, index) => tag !== selectedDetail.tags[index]));
  }

  function updateEditor() {
    const enabled = editable();
    const pending = saving || reloading || regenerating || !!protectionPending;
    detailsNotes.readOnly = !enabled || pending || locked;
    tagDraft.disabled = !enabled || pending || locked;
    addTag.disabled = tagDraft.disabled || !tagDraft.value.trim() || draftTags.length >= TAG_LIMIT || editorComposition.size > 0;
    saveButton.hidden = !enabled;
    discardButton.hidden = !enabled;
    saveButton.disabled = !enabled || pending || locked || conflict || !dirty() || editorComposition.size > 0;
    discardButton.disabled = !enabled || pending || locked || (!dirty() && !conflict);
    saveButton.textContent = saving ? 'Saving…' : 'Save changes';
    discardButton.textContent = conflict ? 'Discard and reload' : 'Discard';
    byId('tag-entry').hidden = !enabled;
    lockWarning.hidden = !(dirty() || saving || reloading);
    lockWarning.textContent = saving ? 'Locking clears these drafts. A save already in progress may finish.'
      : 'Locking clears unsaved edits.';
    lockButton.title = dirty() ? 'Lock hub and clear unsaved edits'
      : regenerating ? 'Lock hub and stop preview regeneration' : 'Lock hub';
    regenerate.disabled = locked || pending || editorComposition.size > 0 || selectedDetail?.regenerable !== true
      || conflict || !/^[a-f0-9]{32}$/.test(selectedDetail?.revision) || !api?.regenerate || !api?.cancelRegeneration;
    cancelGeneration.hidden = !regenerating;
    cancelGeneration.disabled = locked || cancelling;
    cancelGeneration.textContent = cancelling ? 'Cancelling…' : 'Cancel';
    for (const chip of detailsTags.children) {
      const remove = chip.querySelector('button');
      if (remove) { remove.disabled = !enabled || pending || locked; }
    }
    updateProtection();
    updateEditFooter();
  }

  function updateEditFooter() {
    editFooter.hidden = !selectedDetail || detailsContent.hidden
      || (!filmstripPanel.hidden && !dirty() && !saving && !reloading && !conflict);
  }

  function protectionBlocked() {
    return locked || saving || reloading || regenerating || listLoading || detailLoading || editorComposition.size > 0;
  }

  function updateProtection() {
    const blocked = protectionBlocked() || !!protectionPending;
    protectionButton.disabled = blocked || !api?.protection || !api?.setProtection;
    protectionSelect.disabled = blocked || savedProtection === undefined;
    protectionSave.disabled = protectionSelect.disabled || !protectionValues.includes(protectionSelect.value)
      || protectionSelect.value === String(savedProtection);
    protectionSave.textContent = protectionPending === 'saving' ? 'Saving…' : 'Save setting';
    protectionRetry.disabled = blocked;
    protectionClose.disabled = locked || (!!protectionPending && protectionPending !== 'password');
    search.disabled = locked || !!protectionPending;
    retryGallery.disabled = locked || !!protectionPending;
    retryDetails.disabled = locked || !!protectionPending;
    play.disabled = locked || regenerating || !!protectionPending || !!video.getAttribute('src');
    if (locked || regenerating || protectionPending) { closeFilmstrip(); }
    filmstripToggle.disabled = locked || saving || reloading || detailLoading || regenerating || !!protectionPending
      || !selectedDetail || !previewUrl(selectedDetail.filmstripUrl, 'filmstrip');
    updateFilmstripNavigation();
    updatePasswordControls();
    updateCopyControls();
    updateTouchIdControls();
    updatePages(listLoading);
  }

  function clearPasswordInputs() {
    for (const input of passwordInputs) { input.value = ''; }
    passwordComposition.clear();
  }

  function passwordBlockedMessage() {
    if (!changePassword) { return 'Password changes are unavailable. Lock this hub and reopen it to try again.'; }
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes and tags before changing the password.'; }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    if (savedProtection !== undefined && protectionSelect.value !== String(savedProtection)) {
      return 'Save your auto-lock setting, or restore its saved value, before changing the password.';
    }
    return '';
  }

  function updatePasswordControls() {
    const blocked = locked || !!passwordBlockedMessage();
    for (const input of passwordInputs) { input.disabled = blocked; }
    passwordSubmit.disabled = blocked || passwordComposition.size > 0 || passwordForm.hidden || protectionPanel.hidden;
    passwordSubmit.textContent = protectionPending === 'password' ? 'Changing password…' : 'Change password and lock';
    // A pending request can be concealed, but cannot be restarted or reopened.
    passwordToggle.disabled = locked || !changePassword || (!!protectionPending
      && !(protectionPending === 'password' && !passwordForm.hidden));
    if (!passwordForm.hidden && !locked) {
      if (protectionPending === 'password') { passwordStatus.textContent = 'Changing the password. The hub will lock when it is saved.'; }
      else if (passwordBlockedMessage()) { passwordStatus.textContent = passwordBlockedMessage(); }
    }
  }

  function closePasswordSection() {
    passwordEpoch++;
    clearPasswordInputs();
    passwordForm.hidden = true;
    passwordToggle.setAttribute('aria-expanded', 'false');
    passwordStatus.textContent = '';
  }

  function togglePasswordSection() {
    if (locked || protectionPanel.hidden) { clearPasswordInputs(); return; }
    if (!passwordForm.hidden) {
      closePasswordSection();
      updateProtection();
      (protectionPending === 'password' ? lockButton : passwordToggle).focus({ preventScroll: true });
      return;
    }
    if (protectionBlocked() || protectionPending || !changePassword) { return; }
    closeCopySection();
    closeTouchIdSection();
    passwordEpoch++;
    clearPasswordInputs();
    passwordStatus.textContent = '';
    passwordForm.hidden = false;
    passwordToggle.setAttribute('aria-expanded', 'true');
    updateProtection();
    if (!currentPasswordInput.disabled) { currentPasswordInput.focus({ preventScroll: true }); }
  }

  function passwordProblem(value, label) {
    if (!value.length) { return `Enter ${label.toLowerCase()}.`; }
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) { return `${label} contains an incomplete character. Re-enter it.`; }
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return `${label} contains an incomplete character. Re-enter it.`;
      } else { bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3; }
      if (bytes > 1024) { return `${label} is too long. Use no more than 1,024 UTF-8 bytes.`; }
    }
    return '';
  }

  async function submitPasswordChange() {
    if (passwordComposition.size) { return; }
    let currentPassword = currentPasswordInput.value;
    let newPassword = newPasswordInput.value;
    let confirmation = confirmPasswordInput.value;
    // Erase the controls synchronously, even for rejected submissions. Only
    // local strings survive validation, and those references retire after IPC.
    clearPasswordInputs();
    let invocation;
    let epoch;
    try {
      if (locked || passwordForm.hidden || protectionPanel.hidden) { return; }
      if (!passwordWindowFocused || document.hidden) {
        passwordStatus.textContent = 'Return to this window and re-enter your passwords.';
        return;
      }
      const blocked = passwordBlockedMessage();
      if (blocked) { passwordStatus.textContent = blocked; return; }
      let problem = passwordProblem(currentPassword, 'Current password');
      let invalidInput = currentPasswordInput;
      if (!problem) { problem = passwordProblem(newPassword, 'New password'); invalidInput = newPasswordInput; }
      if (!problem) { problem = passwordProblem(confirmation, 'Password confirmation'); invalidInput = confirmPasswordInput; }
      if (!problem && newPassword !== confirmation) { problem = 'New passwords do not match. Re-enter all three fields.'; invalidInput = newPasswordInput; }
      if (!problem && newPassword === currentPassword) { problem = 'Choose a new password different from your current password.'; invalidInput = newPasswordInput; }
      if (problem) {
        passwordStatus.textContent = problem;
        invalidInput.focus({ preventScroll: true });
        return;
      }
      epoch = ++passwordEpoch;
      protectionPending = 'password';
      clearTimeout(searchTimer);
      stopVideo();
      play.hidden = !clipUrl;
      updateEditor();
      try { invocation = changePassword({ currentPassword, newPassword }); }
      catch { invocation = Promise.resolve({ status: 'unavailable' }); }
    } finally {
      currentPassword = '';
      newPassword = '';
      confirmation = '';
    }
    let result;
    try { result = await invocation; }
    catch { result = { status: 'unavailable' }; }
    finally { invocation = undefined; }
    if (locked) { return; }
    protectionPending = '';
    if (result?.status === 'changed') {
      // Main owns locking after a committed change. Clear this view too if its
      // reply arrives before pagehide; successful locking does not depend on it.
      clearSensitiveView();
      return;
    }
    updateEditor();
    if (epoch !== passwordEpoch || passwordForm.hidden || protectionPanel.hidden) { return; }
    passwordStatus.textContent = result?.status === 'incorrect-password'
      ? 'The current password is incorrect. Re-enter all three fields and try again.'
      : result?.status === 'invalid' ? 'The passwords were not accepted. Use different passwords of 1–1,024 UTF-8 bytes and confirm the new one.'
        : result?.status === 'busy' ? 'The hub is busy. Re-enter your passwords and try again when the current operation finishes.'
          : 'The password could not be changed. Lock the hub and reopen it before trying again.';
    if (passwordWindowFocused && !document.hidden) { currentPasswordInput.focus({ preventScroll: true }); }
  }

  function clearPasswordsOnBlur() {
    clearPasswordInputs();
    clearCopyInputs();
    clearTouchIdPassword();
    if (!locked && !touchIdForm.hidden && protectionPending !== 'touch-id-enable') {
      touchIdStatus.textContent = 'Password cleared while this window was inactive. Re-enter it to continue.';
    }
    if (!locked && !passwordForm.hidden && protectionPending !== 'password') {
      passwordStatus.textContent = 'Password fields cleared while this window was inactive. Re-enter them to continue.';
    }
    if (!locked && !copyForm.hidden && protectionPending !== 'copy') {
      copyStatus.textContent = 'Password and acknowledgement cleared while this window was inactive. Re-enter them to continue.';
    }
    updatePasswordControls();
    updateCopyControls();
    updateTouchIdControls();
  }

  function clearCopyInputs() {
    copyPassword.value = '';
    copyAcknowledge.checked = false;
    copyComposing = false;
  }

  function copyBlockedMessage() {
    if (!createUnprotectedCopy || !cancelUnprotectedCopy) { return 'Unprotected copies are unavailable. Lock this hub and reopen it to try again.'; }
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes and tags before creating a copy.'; }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    if (savedProtection !== undefined && protectionSelect.value !== String(savedProtection)) {
      return 'Save your auto-lock setting, or restore its saved value, before creating a copy.';
    }
    return '';
  }

  function updateCopyControls() {
    const pending = protectionPending === 'copy';
    const blocked = locked || !!copyBlockedMessage();
    copyPassword.disabled = blocked;
    copyAcknowledge.disabled = blocked;
    copySubmit.disabled = blocked || copyComposing || !copyAcknowledge.checked || copyForm.hidden || protectionPanel.hidden;
    copySubmit.textContent = pending ? 'Copying…' : 'Create unprotected copy';
    copyToggle.disabled = locked || !!protectionPending || !createUnprotectedCopy || !cancelUnprotectedCopy;
    copyCancel.hidden = !pending || locked;
    copyCancel.disabled = !pending || locked || copyCancelling;
    copyCancel.textContent = copyCancelling ? 'Cancelling…' : 'Cancel copy';
    copyForm.setAttribute('aria-busy', String(pending && !locked));
    if (!copyForm.hidden && !locked) {
      if (pending) {
        copyStatus.textContent = copyCancelling
          ? 'Stopping the copy. Any files already copied remain unencrypted in the selected folder.'
          : 'Preparing the unprotected copy. Choose a new destination when prompted, then wait for copying to finish.';
      } else if (copyBlockedMessage()) { copyStatus.textContent = copyBlockedMessage(); }
    }
  }

  function closeCopySection() {
    copyEpoch++;
    clearCopyInputs();
    copyForm.hidden = true;
    copyToggle.setAttribute('aria-expanded', 'false');
    copyStatus.textContent = '';
    copyCancel.hidden = true;
  }

  function toggleCopySection() {
    if (locked || protectionPanel.hidden) { clearCopyInputs(); return; }
    if (protectionPending) { return; }
    if (!copyForm.hidden) {
      closeCopySection();
      updateProtection();
      copyToggle.focus({ preventScroll: true });
      return;
    }
    if (protectionBlocked() || !createUnprotectedCopy || !cancelUnprotectedCopy) { return; }
    closePasswordSection();
    closeTouchIdSection();
    copyEpoch++;
    clearCopyInputs();
    copyStatus.textContent = '';
    copyForm.hidden = false;
    copyToggle.setAttribute('aria-expanded', 'true');
    updateProtection();
    if (!copyPassword.disabled) { copyPassword.focus({ preventScroll: true }); }
  }

  async function submitUnprotectedCopy() {
    if (copyComposing) { return; }
    let password = copyPassword.value;
    let acknowledge = copyAcknowledge.checked === true;
    clearCopyInputs();
    updateCopyControls();
    let invocation;
    let epoch;
    try {
      if (locked || copyForm.hidden || protectionPanel.hidden) { return; }
      if (!passwordWindowFocused || document.hidden) {
        copyStatus.textContent = 'Return to this window, re-enter your password and acknowledge the warning.';
        return;
      }
      const blocked = copyBlockedMessage();
      if (blocked) { copyStatus.textContent = blocked; return; }
      const problem = passwordProblem(password, 'Current password');
      if (problem || !acknowledge) {
        copyStatus.textContent = problem || 'Acknowledge that the new copy will be stored as ordinary, unencrypted files before continuing.';
        (problem ? copyPassword : copyAcknowledge).focus({ preventScroll: true });
        return;
      }
      epoch = ++copyEpoch;
      protectionPending = 'copy';
      copyCancelling = false;
      clearPasswordInputs();
      clearTimeout(searchTimer);
      stopVideo();
      play.hidden = !clipUrl;
      updateEditor();
      copyCancel.focus();
      try { invocation = createUnprotectedCopy({ password, acknowledge: true }); }
      catch { invocation = Promise.resolve({ status: 'unavailable' }); }
    } finally {
      password = '';
      acknowledge = false;
    }
    let result;
    try { result = await invocation; }
    catch { result = { status: 'unavailable' }; }
    finally { invocation = undefined; }
    if (locked) { return; }
    protectionPending = '';
    copyCancelling = false;
    updateEditor();
    if (epoch !== copyEpoch || copyForm.hidden || protectionPanel.hidden) { return; }
    copyStatus.textContent = result?.status === 'copied'
      ? 'Unprotected copy created. The encrypted hub and original videos were kept.'
      : result?.status === 'incorrect-password' ? 'The current password is incorrect. Re-enter it and acknowledge the warning to try again.'
        : result?.status === 'cancelled' ? 'Copy cancelled. Any files already copied remain unencrypted in the selected folder. The encrypted hub was kept.'
          : result?.status === 'failed' ? 'The copy could not be completed. Any files already copied remain unencrypted in the selected folder. The encrypted hub was kept.'
            : result?.status === 'invalid' ? 'Enter a password of 1–1,024 UTF-8 bytes and acknowledge that the new copy will be unencrypted.'
              : result?.status === 'busy' ? 'The hub is busy. Re-enter your password and acknowledge the warning to try again later.'
                : 'The copy is unavailable. Lock the hub and reopen it before trying again. Any files already copied remain unencrypted in the selected folder.';
    if (passwordWindowFocused && !document.hidden) {
      (result?.status === 'copied' || result?.status === 'cancelled' ? copyStatus : copyPassword).focus({ preventScroll: true });
    }
  }

  function requestCopyCancellation() {
    if (locked || protectionPending !== 'copy' || copyCancelling || !cancelUnprotectedCopy) { return; }
    copyCancelling = true;
    updateCopyControls();
    try { cancelUnprotectedCopy(); }
    catch {
      copyStatus.textContent = 'Cancellation could not be requested. Wait for completion or lock the hub. Any files already copied remain unencrypted in the selected folder.';
    }
  }

  function clearTouchIdPassword() {
    touchIdPassword.value = '';
    touchIdComposing = false;
  }

  function closeTouchIdSection() {
    touchIdEpoch++;
    clearTouchIdPassword();
    touchIdForm.hidden = true;
    touchIdToggle.setAttribute('aria-expanded', 'false');
    touchIdStatus.textContent = '';
  }

  function touchIdBlockedMessage(removing = false) {
    if (!disableTouchId || (!removing && (touchIdState === 'unavailable' || !enableTouchId))) {
      return 'Touch ID is unavailable in this build or on this Mac. Use your hub password.';
    }
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes and tags before changing Touch ID.'; }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    if (savedProtection !== undefined && protectionSelect.value !== String(savedProtection)) {
      return 'Save your auto-lock setting, or restore its saved value, before changing Touch ID.';
    }
    return '';
  }

  function updateTouchIdControls() {
    const blocked = locked || !!touchIdBlockedMessage();
    touchIdToggle.hidden = touchIdState !== 'disabled';
    touchIdDisable.hidden = !disableTouchId || touchIdState === 'disabled';
    touchIdToggle.disabled = blocked;
    touchIdToggle.textContent = touchIdForm.hidden ? 'Enable Touch ID' : 'Cancel setup';
    touchIdDisable.disabled = locked || !!touchIdBlockedMessage(true);
    touchIdPassword.disabled = blocked;
    touchIdSubmit.disabled = blocked || touchIdComposing || touchIdForm.hidden || protectionPanel.hidden;
    touchIdSubmit.textContent = protectionPending === 'touch-id-enable' ? 'Enabling Touch ID…' : 'Enable Touch ID';
    touchIdDisable.textContent = protectionPending === 'touch-id-disable' ? 'Removing stored key…'
      : touchIdState === 'unavailable' ? 'Remove stored Touch ID key' : 'Disable Touch ID';
    touchIdForm.setAttribute('aria-busy', String(protectionPending === 'touch-id-enable' && !locked));
    if (!locked && !touchIdForm.hidden && touchIdBlockedMessage()) { touchIdStatus.textContent = touchIdBlockedMessage(); }
  }

  function showTouchIdState(state) {
    touchIdState = state;
    touchIdSummary.setAttribute('data-state', state);
    touchIdSummary.textContent = state === 'enabled' ? 'Touch ID is on for this hub on this Mac.'
      : state === 'disabled' ? 'Touch ID is off for this hub on this Mac.'
        : 'Touch ID is unavailable in this build or on this Mac. Use your hub password. If you enabled it before on this Mac, try removing its stored key below.';
  }

  function toggleTouchIdSection() {
    if (locked || protectionPanel.hidden) { clearTouchIdPassword(); return; }
    if (touchIdBlockedMessage() || touchIdState !== 'disabled') { return; }
    if (!touchIdForm.hidden) { closeTouchIdSection(); updateProtection(); return; }
    closePasswordSection();
    closeCopySection();
    touchIdEpoch++;
    clearTouchIdPassword();
    touchIdStatus.textContent = '';
    touchIdForm.hidden = false;
    touchIdToggle.setAttribute('aria-expanded', 'true');
    updateProtection();
    touchIdPassword.focus({ preventScroll: true });
  }

  async function changeTouchId(enabling) {
    if (enabling && touchIdComposing) { return; }
    let password = touchIdPassword.value;
    clearTouchIdPassword();
    let invocation;
    let epoch;
    try {
      if (locked || protectionPanel.hidden || (enabling && touchIdForm.hidden)) { return; }
      if (!passwordWindowFocused || document.hidden) {
        touchIdStatus.textContent = 'Return to this window to change Touch ID. Re-enter your password if needed.';
        return;
      }
      const blocked = touchIdBlockedMessage(!enabling);
      if (blocked) { touchIdStatus.textContent = blocked; return; }
      if (enabling ? touchIdState !== 'disabled' : !['enabled', 'unavailable'].includes(touchIdState)) { return; }
      if (enabling) {
        const problem = passwordProblem(password, 'Current password');
        if (problem) { touchIdStatus.textContent = problem; touchIdPassword.focus({ preventScroll: true }); return; }
      }
      closePasswordSection();
      closeCopySection();
      epoch = ++touchIdEpoch;
      protectionPending = enabling ? 'touch-id-enable' : 'touch-id-disable';
      clearTimeout(searchTimer);
      stopVideo();
      play.hidden = !clipUrl;
      updateEditor();
      touchIdStatus.textContent = enabling ? 'Follow the Touch ID prompt to enable unlocking on this Mac.' : 'Disabling Touch ID…';
      try { invocation = enabling ? enableTouchId({ password }) : disableTouchId(); }
      catch { invocation = Promise.resolve({ outcome: 'unavailable' }); }
    } finally { password = ''; }
    let result;
    try { result = await invocation; }
    catch { result = { outcome: 'unavailable' }; }
    finally { invocation = undefined; }
    if (locked || epoch !== touchIdEpoch) { return; }
    protectionPending = '';
    if (result?.outcome === (enabling ? 'enabled' : 'disabled')) {
      closeTouchIdSection();
      showTouchIdState(enabling ? 'enabled' : 'disabled');
      touchIdStatus.textContent = enabling ? 'Touch ID enabled. Your hub password still works.' : 'Touch ID disabled. Use your hub password to unlock.';
    } else if (enabling && result?.outcome === 'incorrect-password') {
      touchIdStatus.textContent = 'The current password is incorrect. Re-enter it and try again.';
    } else if (enabling && result?.outcome === 'cancelled') {
      touchIdStatus.textContent = 'Touch ID setup cancelled. You can continue using your hub password.';
    } else {
      closeTouchIdSection();
      showTouchIdState('unavailable');
      if (!enabling) { touchIdStatus.textContent = 'The stored Touch ID key could not be removed. It may still be present on this Mac.'; }
    }
    updateEditor();
  }

  function validProtection(value) {
    return typeof value === 'number' && protectionValues.includes(String(value));
  }

  async function loadProtection() {
    if (protectionBlocked() || protectionPending || !api?.protection || !api?.setProtection) { return; }
    const epoch = ++protectionEpoch;
    protectionPanel.hidden = false;
    protectionButton.setAttribute('aria-expanded', 'true');
    savedProtection = undefined;
    protectionSelect.value = '';
    closeTouchIdSection();
    showTouchIdState('unavailable');
    touchIdSummary.textContent = 'Checking Touch ID availability…';
    protectionPending = 'loading';
    protectionStatus.textContent = 'Loading saved protection setting…';
    protectionRetry.hidden = true;
    updateEditor();
    protectionPanel.focus({ preventScroll: true });
    let result;
    try { result = await api.protection(); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== protectionEpoch) { return; }
    let touchIdResult;
    try { touchIdResult = await touchIdStatusRequest?.(); } catch { /* Password remains available. */ }
    if (locked || epoch !== protectionEpoch) { return; }
    showTouchIdState(touchIdResult?.outcome === 'available' && ['enabled', 'disabled'].includes(touchIdResult.state)
      && enableTouchId && disableTouchId ? touchIdResult.state : 'unavailable');
    protectionPending = '';
    if (result?.status === 'ready' && validProtection(result.autoLockMinutes)) {
      savedProtection = result.autoLockMinutes;
      protectionSelect.value = String(savedProtection);
      protectionStatus.textContent = 'Choose a setting, then save to apply it.';
      updateEditor();
      protectionSelect.focus({ preventScroll: true });
    } else {
      protectionStatus.textContent = result?.status === 'busy' ? 'The hub is busy. Try loading this setting again.'
        : 'The saved setting could not be loaded. Try again or lock the hub.';
      protectionRetry.hidden = false;
      updateEditor();
      protectionRetry.focus({ preventScroll: true });
    }
  }

  async function saveProtection() {
    if (protectionBlocked() || protectionPending || savedProtection === undefined || !api?.setProtection
      || !protectionValues.includes(protectionSelect.value) || protectionSelect.value === String(savedProtection)) { return; }
    const epoch = ++protectionEpoch;
    const autoLockMinutes = Number(protectionSelect.value);
    protectionPending = 'saving';
    protectionStatus.textContent = 'Saving encrypted protection setting…';
    updateEditor();
    let result;
    try { result = await api.setProtection({ autoLockMinutes }); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== protectionEpoch) { return; }
    protectionPending = '';
    if (result?.status === 'saved' && result.autoLockMinutes === autoLockMinutes) {
      savedProtection = autoLockMinutes;
      protectionSelect.value = String(autoLockMinutes);
      protectionStatus.textContent = 'Protection setting saved.';
    } else {
      protectionStatus.textContent = result?.status === 'busy' ? 'The hub is busy. Your selection is still here; try saving again.'
        : 'The setting could not be saved. Your selection is still here; try again or lock the hub.';
    }
    updateEditor();
  }

  function closeProtection() {
    clearPasswordInputs();
    clearCopyInputs();
    clearTouchIdPassword();
    if (locked || (protectionPending && protectionPending !== 'password')) { return; }
    closePasswordSection();
    closeCopySection();
    closeTouchIdSection();
    protectionPanel.hidden = true;
    protectionButton.setAttribute('aria-expanded', 'false');
    (protectionPending === 'password' ? lockButton : protectionButton).focus({ preventScroll: true });
  }

  function canNavigate() {
    if (locked) { return false; }
    if (protectionPending) { return false; }
    if (regenerating) {
      generationStatus.textContent = cancelling ? 'Stopping regeneration. Please wait, or lock the hub.'
        : 'Regenerating previews. Cancel or wait before leaving this video.';
      return false;
    }
    if (saving || reloading) {
      editStatus.textContent = saving ? 'Saving changes. Please wait, or lock the hub.' : 'Loading saved changes. Please wait, or lock the hub.';
      return false;
    }
    if (dirty() || editorComposition.size) {
      editStatus.textContent = conflict ? 'Your edits are still here. Choose Discard and reload to load the latest saved version.'
        : 'Save or discard your edits before leaving this video.';
      return false;
    }
    return true;
  }

  function restoreSearch() {
    search.value = query;
    if (protectionPending) { protectionPanel.focus({ preventScroll: true }); return; }
    if (!details.hidden && editable()) {
      (tagDraft.value ? tagDraft : detailsNotes).focus({ preventScroll: true });
    }
  }

  function renderTags() {
    detailsTags.replaceChildren();
    draftTags.forEach((tag, index) => {
      const chip = textElement('span', 'detail-tag', '');
      chip.append(textElement('span', '', tag));
      if (editable()) {
        const remove = textElement('button', 'remove-tag', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove tag ${tag}`);
        remove.addEventListener('click', () => {
          if (locked || saving || reloading || regenerating || protectionPending || !editable()) { return; }
          draftTags.splice(index, 1);
          renderTags();
          editStatus.textContent = 'Unsaved changes.';
          updateEditor();
          tagDraft.focus({ preventScroll: true });
        });
        chip.append(remove);
      }
      detailsTags.append(chip);
    });
  }

  function addDraftTag() {
    if (locked || saving || reloading || regenerating || protectionPending || !editable() || editorComposition.size) { return false; }
    const tag = tagDraft.value.trim();
    if (!tag) { editStatus.textContent = 'Enter a tag first.'; return false; }
    if (tagDraft.value.length > TAG_LENGTH || draftTags.length >= TAG_LIMIT) {
      editStatus.textContent = 'Use up to 128 tags, with no more than 512 characters in each tag.';
      return false;
    }
    if (!draftTags.includes(tag)) { draftTags.push(tag); }
    tagDraft.value = '';
    renderTags();
    editStatus.textContent = dirty() ? 'Unsaved changes.' : 'No unsaved changes.';
    updateEditor();
    return true;
  }

  function applyMetadata(item) {
    closeFilmstrip();
    selectedDetail = { ...item, tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string') : [] };
    draftTags = [...selectedDetail.tags];
    tagDraft.value = '';
    detailsNotes.value = typeof item.notes === 'string' ? item.notes : '';
    conflict = false;
    detailsTitle.textContent = item.title || 'Untitled video';
    detailsFacts.textContent = `${duration(item.duration)} · ${dimensions(item)}`;
    detailsRating.textContent = Number.isFinite(item.rating) && item.rating > 0 && item.rating <= 5
      ? `${item.rating} / 5${item.favourite ? ' · Favourite' : ''}` : 'Unrated';
    shortened.hidden = item.truncated !== true;
    detailsContent.hidden = false;
    editFooter.hidden = false;
    retryDetails.hidden = true;
    retryDetails.textContent = 'Try again';
    renderTags();
    editStatus.textContent = editable() ? 'Changes are saved only when you choose Save changes.' : 'Notes and tags are read-only for this video.';
    updateEditor();
  }

  function refreshPreviews(item) {
    closeFilmstrip();
    cancelImages('detail');
    stopVideo();
    const posterUrl = previewUrl(item.posterUrl, 'clip');
    posterPlaceholder.textContent = posterUrl ? 'Loading preview…' : 'No preview available';
    posterPlaceholder.hidden = false;
    queueImage(poster, posterPlaceholder, posterUrl, 'detail');
    clipUrl = previewUrl(item.clipUrl, 'clip');
    play.hidden = !clipUrl;
    // Recreate thumbnail elements and retire every old source before loading
    // the same no-store media routes for the newly published encrypted set.
    void loadPage(offset, 0, undefined, true);
  }

  async function regeneratePreviews() {
    if (locked || regenerating || protectionPending || selectedDetail?.regenerable !== true || !api?.regenerate || !api?.cancelRegeneration) { return; }
    if (!canNavigate()) {
      generationStatus.textContent = 'Save or discard your edits before regenerating previews.';
      return;
    }
    if (conflict) { generationStatus.textContent = 'Reload the saved video details before regenerating previews.'; return; }
    const id = selectedId;
    const epoch = detailEpoch;
    const current = () => !locked && epoch === detailEpoch && id === selectedId;
    regenerating = true;
    cancelling = false;
    // Retire the existing decoded poster before the IPC await. Removing and
    // restoring an identical URL in one turn can keep Chromium's old image.
    cancelImages('detail');
    stopVideo();
    posterPlaceholder.hidden = false;
    posterPlaceholder.textContent = 'Regenerating previews…';
    play.disabled = true;
    generationStatus.textContent = 'Regenerating previews. The app may ask you to select the source folder.';
    updateEditor();
    let result;
    try { result = await api.regenerate({ id, revision: selectedDetail.revision }); }
    catch { result = { status: 'unavailable' }; }
    if (!current()) { return; }
    // Cancellation can race publication. Reload both metadata and media after
    // drainage rather than claiming the previous preview set was preserved.
    let reloaded;
    if (result?.status === 'cancelled') {
      cancelling = true;
      generationStatus.textContent = 'Regeneration stopped. Refreshing previews…';
      updateEditor();
      try { reloaded = await api.detail(id); }
      catch { reloaded = { status: 'unavailable' }; }
      if (!current()) { return; }
    }
    regenerating = false;
    cancelling = false;
    play.disabled = false;
    if (result?.status === 'generated' && result.item?.id === id && typeof result.item.title === 'string') {
      applyMetadata(result.item);
      refreshPreviews(result.item);
      generationStatus.textContent = 'Previews regenerated.';
    } else if (result?.status === 'cancelled') {
      if (reloaded?.status === 'ready' && reloaded.item?.id === id && typeof reloaded.item.title === 'string') {
        applyMetadata(reloaded.item);
        refreshPreviews(reloaded.item);
        generationStatus.textContent = 'Regeneration stopped. Previews refreshed.';
      } else {
        refreshPreviews(selectedDetail);
        generationStatus.textContent = 'Regeneration stopped. Reopen this video to check its latest previews.';
      }
    } else if (result?.status === 'conflict') {
      refreshPreviews(selectedDetail);
      conflict = true;
      retryDetails.hidden = false;
      retryDetails.textContent = 'Reload details';
      generationStatus.textContent = 'This video changed. Reload its saved details before regenerating previews.';
    } else {
      refreshPreviews(selectedDetail);
      generationStatus.textContent = result?.status === 'source-unavailable'
        ? 'The source video is unavailable. Connect its folder and try again.'
        : result?.status === 'wrong-folder' ? 'That folder does not match this video’s source. Try again and choose its source folder.'
          : result?.status === 'busy' ? 'The hub is busy. Try regenerating previews again shortly.'
            : 'Previews could not be regenerated. Try again or lock the hub.';
    }
    updateEditor();
  }

  function cancelRegeneration() {
    if (locked || !regenerating || cancelling) { return; }
    cancelling = true;
    generationStatus.textContent = 'Stopping regeneration. Please wait, or lock the hub.';
    updateEditor();
    try { api.cancelRegeneration(); }
    catch { generationStatus.textContent = 'Cancellation could not be requested. Wait for completion or lock the hub.'; }
  }

  async function saveChanges() {
    if (locked || saving || reloading || regenerating || protectionPending || conflict || !editable()) { return; }
    if (editorComposition.size) { editStatus.textContent = 'Finish entering text before saving.'; return; }
    if (tagDraft.value !== '' && !addDraftTag()) { return; }
    if (!dirty()) { return; }
    if (detailsNotes.value.length > NOTES_LIMIT || draftTags.length > TAG_LIMIT
      || draftTags.some(tag => tag.length > TAG_LENGTH)) {
      editStatus.textContent = 'Use up to 65,536 characters in notes and 128 tags of up to 512 characters each.';
      return;
    }
    const id = selectedId;
    const epoch = detailEpoch;
    const request = { id, revision: selectedDetail.revision, notes: detailsNotes.value, tags: [...draftTags] };
    saving = true;
    editStatus.textContent = 'Saving encrypted notes and tags…';
    updateEditor();
    let result;
    try { result = await api.save(request); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== detailEpoch || id !== selectedId) { return; }
    saving = false;
    if (result?.status === 'saved' && result.item?.id === id && typeof result.item.title === 'string') {
      applyMetadata(result.item);
      editStatus.textContent = 'Changes saved.';
      // Tags can change the current search results. Refresh their projection
      // while retaining the selected detail view and any playing preview.
      void loadPage(offset, 0, undefined, true);
      return;
    }
    conflict = result?.status === 'conflict';
    editStatus.textContent = conflict ? 'These notes or tags changed elsewhere. Your edits are still here. Choose Discard and reload to load the latest saved version.'
      : result?.status === 'invalid' ? 'Changes could not be saved. Check your notes and tag names; your edits are still here.'
        : result?.status === 'busy' ? 'The hub is busy. Your edits are still here; try saving again.'
          : 'Changes could not be saved. Your edits are still here; try again or lock the hub.';
    updateEditor();
  }

  async function discardChanges() {
    if (locked || saving || reloading || regenerating || protectionPending || !selectedDetail || (!dirty() && !conflict)) { return; }
    if (editorComposition.size) { editStatus.textContent = 'Finish entering text before discarding.'; return; }
    const id = selectedId;
    const epoch = detailEpoch;
    reloading = true;
    editStatus.textContent = 'Loading the latest saved notes and tags…';
    updateEditor();
    let result;
    try { result = await api.detail(id); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== detailEpoch || id !== selectedId) { return; }
    reloading = false;
    if (result?.status === 'ready' && result.item?.id === id && typeof result.item.title === 'string') {
      applyMetadata(result.item);
      editStatus.textContent = 'Latest saved notes and tags loaded.';
      generationStatus.textContent = '';
      void loadPage(offset, 0, undefined, true);
    } else {
      editStatus.textContent = 'Saved changes could not be loaded. Your edits are still here; try Discard again.';
      updateEditor();
    }
  }

  function imageIsCurrent(job) {
    return !locked && imageJobs.has(job) && job.image.isConnected
      && job.epoch === (job.scope === 'list' ? listEpoch : detailEpoch);
  }

  function cancelImages(scope) {
    for (const job of imageJobs) {
      if (scope && job.scope !== scope) { continue; }
      clearTimeout(job.timer);
      if (job.target) {
        observer?.unobserve(job.target);
        delete job.target.__privatePreviewJob;
      }
      job.image.onload = null;
      job.image.onerror = null;
      job.image.removeAttribute('src');
      job.image.hidden = true;
      runningImages.delete(job);
      imageJobs.delete(job);
    }
    for (let index = imageQueue.length - 1; index >= 0; index--) {
      if (!imageJobs.has(imageQueue[index])) { imageQueue.splice(index, 1); }
    }
  }

  function pumpImages() {
    while (!locked && runningImages.size < IMAGE_CONCURRENCY && imageQueue.length) {
      const job = imageQueue.shift();
      if (!imageIsCurrent(job)) { continue; }
      job.attempts++;
      runningImages.add(job);
      const finish = success => {
        if (!runningImages.delete(job)) { return; }
        job.image.onload = null;
        job.image.onerror = null;
        if (imageIsCurrent(job)) {
          if (success) {
            job.image.hidden = false;
            job.placeholder.hidden = true;
            if (job.scope === 'filmstrip') {
              filmstripViewport.hidden = false;
              filmstripPanel.setAttribute('aria-busy', 'false');
              updateFilmstripNavigation();
            }
          } else {
            job.image.removeAttribute('src');
            if (job.attempts < IMAGE_ATTEMPTS) {
              // Native image errors do not expose HTTP status. Retry transient
              // admission failures briefly; a missing/corrupt preview stays generic.
              job.timer = setTimeout(() => {
                if (imageIsCurrent(job)) { imageQueue.push(job); pumpImages(); }
              }, job.attempts * 300);
            } else {
              job.placeholder.textContent = job.scope === 'filmstrip'
                ? 'Filmstrip unavailable. Hide it and try again.' : 'Preview unavailable';
              if (job.scope === 'filmstrip') { filmstripPanel.setAttribute('aria-busy', 'false'); }
            }
          }
        }
        pumpImages();
      };
      job.image.onload = () => finish(true);
      job.image.onerror = () => finish(false);
      job.image.src = job.url;
    }
  }

  function queueImage(image, placeholder, url, scope, target) {
    if (!url || locked) { return; }
    const job = { image, placeholder, url, scope, target, epoch: scope === 'list' ? listEpoch : detailEpoch, attempts: 0 };
    imageJobs.add(job);
    if (target && observer) {
      target.__privatePreviewJob = job;
      observer.observe(target);
    } else {
      imageQueue.push(job);
      pumpImages();
    }
  }

  function stopVideo() {
    playEpoch++;
    video.onloadeddata = null;
    video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    video.hidden = true;
    play.disabled = false;
  }

  function updateFilmstripNavigation() {
    const unavailable = locked || filmstripPanel.hidden || filmstripImage.hidden || saving || reloading
      || regenerating || !!protectionPending;
    const maximum = Math.max(0, filmstripViewport.scrollWidth - filmstripViewport.clientWidth);
    filmstripPrevious.disabled = unavailable || filmstripViewport.scrollLeft <= 1;
    filmstripNext.disabled = unavailable || filmstripViewport.scrollLeft >= maximum - 1;
  }

  function closeFilmstrip() {
    cancelImages('filmstrip');
    // Clear the element even when it never reached the image queue.
    filmstripImage.onload = null;
    filmstripImage.onerror = null;
    filmstripImage.removeAttribute('src');
    filmstripImage.hidden = true;
    filmstripPanel.hidden = true;
    filmstripPanel.setAttribute('aria-busy', 'false');
    filmstripViewport.hidden = true;
    filmstripViewport.scrollLeft = 0;
    filmstripStatus.textContent = '';
    filmstripStatus.hidden = false;
    filmstripToggle.textContent = 'Show filmstrip';
    filmstripToggle.setAttribute('aria-expanded', 'false');
    filmstripPrevious.disabled = true;
    filmstripNext.disabled = true;
    updateEditFooter();
    pumpImages();
  }

  function toggleFilmstrip() {
    if (filmstripToggle.disabled || locked || saving || reloading || detailLoading || regenerating || protectionPending) { return; }
    if (!filmstripPanel.hidden) { closeFilmstrip(); return; }
    const url = previewUrl(selectedDetail?.filmstripUrl, 'filmstrip');
    if (!url) { return; }
    filmstripPanel.hidden = false;
    filmstripPanel.setAttribute('aria-busy', 'true');
    filmstripStatus.textContent = 'Loading filmstrip…';
    filmstripStatus.hidden = false;
    filmstripToggle.textContent = 'Hide filmstrip';
    filmstripToggle.setAttribute('aria-expanded', 'true');
    updateEditFooter();
    // Scroll only this panel. scrollIntoView can also move the clipped root
    // viewport in a short window and make Lock hub unreachable.
    detailsScroll.scrollTop = 0;
    queueImage(filmstripImage, filmstripStatus, url, 'filmstrip');
  }

  function scrollFilmstrip(direction) {
    if (locked || filmstripPanel.hidden || filmstripImage.hidden || saving || reloading || regenerating || protectionPending) { return; }
    filmstripViewport.scrollLeft += direction * Math.max(144, filmstripViewport.clientWidth * .8);
    updateFilmstripNavigation();
  }

  function closeDetails(restoreFocus = false) {
    detailEpoch++;
    clearTimeout(detailRetryTimer);
    cancelImages('detail');
    closeFilmstrip();
    stopVideo();
    clipUrl = '';
    selectedId = '';
    details.hidden = true;
    detailsScroll.scrollTop = 0;
    detailsContent.hidden = true;
    detailsStatus.textContent = '';
    detailsTitle.textContent = '';
    detailsFacts.textContent = '';
    detailsRating.textContent = '';
    detailsTags.replaceChildren();
    detailsNotes.value = '';
    detailsNotes.textContent = '';
    tagDraft.value = '';
    draftTags = [];
    selectedDetail = undefined;
    detailLoading = false;
    saving = false;
    reloading = false;
    regenerating = false;
    cancelling = false;
    conflict = false;
    editorComposition.clear();
    editStatus.textContent = '';
    generationStatus.textContent = '';
    editFooter.hidden = true;
    updateEditor();
    shortened.hidden = true;
    posterPlaceholder.hidden = false;
    play.hidden = true;
    retryDetails.hidden = true;
    for (const card of cards.values()) { card.setAttribute('aria-pressed', 'false'); }
    if (restoreFocus && !locked) {
      const target = selectionOrigin?.isConnected ? selectionOrigin : search;
      target.focus({ preventScroll: true });
    }
    selectionOrigin = undefined;
    pumpImages();
  }

  function clearPage(preserveDetails = false) {
    observer?.disconnect();
    observer = undefined;
    cancelImages(preserveDetails ? 'list' : undefined);
    if (!preserveDetails) { closeDetails(); }
    cards.clear();
    grid.replaceChildren();
  }

  function showEmpty(title, message, retry = false) {
    byId('empty-title').textContent = title;
    byId('empty-message').textContent = message;
    retryGallery.hidden = !retry;
    empty.hidden = false;
  }

  function updatePages(busy = false) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pageLabel.textContent = total ? `Page ${Math.floor(offset / PAGE_SIZE) + 1} of ${pages}` : 'Page 1';
    previous.disabled = locked || busy || !!protectionPending || offset === 0;
    next.disabled = locked || busy || !!protectionPending || offset + PAGE_SIZE >= total;
  }

  function renderCards(items) {
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) { continue; }
          observer?.unobserve(entry.target);
          const job = entry.target.__privatePreviewJob;
          delete entry.target.__privatePreviewJob;
          if (job && imageIsCurrent(job)) { imageQueue.push(job); }
        }
        pumpImages();
      }, { root: byId('gallery-content'), rootMargin: '180px 0px' });
    }
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') { continue; }
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'video-card';
      card.setAttribute('aria-pressed', String(item.id === selectedId));
      card.setAttribute('aria-controls', 'details-panel');
      const thumbnail = textElement('span', 'thumbnail', '');
      const thumbnailUrl = previewUrl(item.thumbnailUrl, 'thumbnail');
      const placeholder = textElement('span', 'thumbnail-placeholder', thumbnailUrl ? 'Loading preview…' : 'Preview unavailable');
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.referrerPolicy = 'no-referrer';
      image.decoding = 'async';
      // Observe the visible thumbnail box, not a display:none image.
      image.hidden = true;
      placeholder.hidden = false;
      thumbnail.append(placeholder, image, textElement('span', 'video-duration', duration(item.duration)));
      if (item.favourite) {
        const favourite = textElement('span', 'video-favourite', '♥');
        favourite.setAttribute('aria-label', 'Favourite');
        thumbnail.append(favourite);
      }
      const caption = textElement('span', 'video-caption', '');
      caption.append(textElement('span', 'video-title', item.title || 'Untitled video'), textElement('span', 'video-meta', dimensions(item)));
      card.append(thumbnail, caption);
      card.addEventListener('click', () => { if (!locked) { showDetails(item.id, card); } });
      grid.append(card);
      cards.set(item.id, card);
      if (item.id === selectedId) { selectionOrigin = card; }
      queueImage(image, placeholder, thumbnailUrl, 'list', thumbnail);
    }
  }

  async function loadPage(nextOffset, attempt = 0, expectedEpoch, preserveDetails = false) {
    if (locked || !api) { return; }
    let epoch = expectedEpoch;
    if (attempt === 0) {
      if (!preserveDetails && !canNavigate()) { restoreSearch(); return; }
      listLoading = true;
      epoch = ++listEpoch;
      clearTimeout(listRetryTimer);
      offset = nextOffset;
      if (!preserveDetails) { query = search.value.slice(0, 200); }
      clearPage(preserveDetails);
      empty.hidden = true;
      summary.textContent = '';
      galleryStatus.textContent = 'Loading catalogue…';
      grid.setAttribute('aria-busy', 'true');
      updatePages(true);
      updateProtection();
    }
    if (epoch !== listEpoch) { return; }
    let result;
    try { result = await api.list({ query, offset }); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== listEpoch) { return; }
    if (result?.status === 'busy' && attempt < 2) {
      listRetryTimer = setTimeout(() => { void loadPage(offset, attempt + 1, epoch, preserveDetails); }, (attempt + 1) * 350);
      return;
    }
    listLoading = false;
    updateProtection();
    grid.setAttribute('aria-busy', 'false');
    galleryStatus.textContent = '';
    if (result?.status !== 'ready' || !Array.isArray(result.items) || result.items.length > PAGE_SIZE
      || !Number.isSafeInteger(result.total) || result.total < 0 || result.offset !== offset) {
      total = 0;
      showEmpty('Catalogue unavailable', 'The private catalogue could not be loaded. Try again or lock this hub.', true);
      updatePages();
      return;
    }
    total = result.total;
    if (preserveDetails && offset > 0 && offset >= total) {
      void loadPage(Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE, 0, undefined, true);
      return;
    }
    updatePages();
    summary.textContent = `${total.toLocaleString()} ${total === 1 ? 'video' : 'videos'}`;
    if (!result.items.length) {
      showEmpty(query ? 'No matching videos' : 'No videos yet', query ? 'Try a different video title or tag.' : 'This private catalogue has no videos to display.');
      return;
    }
    renderCards(result.items);
    galleryStatus.textContent = `${offset + 1}–${offset + result.items.length} of ${total.toLocaleString()} videos`;
  }

  async function showDetails(id, origin, attempt = 0, expectedEpoch) {
    if (locked || !api) { return; }
    let epoch = expectedEpoch;
    if (attempt === 0) {
      if (id === selectedId && selectedDetail) { return; }
      if (!canNavigate()) { return; }
      closeDetails();
      detailLoading = true;
      selectedId = id;
      selectionOrigin = origin;
      epoch = detailEpoch;
      origin?.setAttribute('aria-pressed', 'true');
      details.hidden = false;
      detailsStatus.textContent = 'Loading video details…';
      updateProtection();
    }
    if (epoch !== detailEpoch || id !== selectedId) { return; }
    let result;
    try { result = await api.detail(id); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== detailEpoch || id !== selectedId) { return; }
    if (result?.status === 'busy' && attempt < 2) {
      detailRetryTimer = setTimeout(() => { void showDetails(id, origin, attempt + 1, epoch); }, (attempt + 1) * 350);
      return;
    }
    detailLoading = false;
    updateProtection();
    const item = result?.item;
    if (result?.status !== 'ready' || !item || item.id !== id || typeof item.title !== 'string') {
      detailsStatus.textContent = 'Video details are unavailable.';
      retryDetails.hidden = false;
      return;
    }
    detailsStatus.textContent = '';
    applyMetadata(item);
    posterPlaceholder.textContent = 'No preview available';
    posterPlaceholder.hidden = false;
    queueImage(poster, posterPlaceholder, previewUrl(item.posterUrl, 'clip'), 'detail');
    clipUrl = previewUrl(item.clipUrl, 'clip');
    play.hidden = !clipUrl;
  }

  async function playPreview() {
    if (locked || regenerating || protectionPending || !clipUrl || !selectedId || play.disabled) { return; }
    play.disabled = true;
    const epoch = ++playEpoch;
    const selected = selectedId;
    const current = () => !locked && epoch === playEpoch && selected === selectedId;
    video.preload = 'none';
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    const failed = () => {
      if (!current()) { return; }
      stopVideo();
      detailsStatus.textContent = 'This preview is unavailable.';
      play.hidden = false;
    };
    video.onerror = failed;
    video.onloadeddata = () => {
      if (current()) { video.hidden = false; play.hidden = true; }
    };
    video.src = clipUrl;
    try {
      await video.play();
      if (current()) { video.hidden = false; play.hidden = true; }
      // A pending play promise can settle after its source was retired. Pause
      // that work again, while allowing a newer selected preview to keep playing.
      else if (locked || !video.getAttribute('src')) { video.pause(); }
    } catch { failed(); }
  }

  function clearSensitiveView() {
    locked = true;
    closePasswordSection();
    closeCopySection();
    closeTouchIdSection();
    showTouchIdState('unavailable');
    touchIdSummary.textContent = '';
    copyCancelling = false;
    protectionEpoch++;
    protectionPending = '';
    savedProtection = undefined;
    protectionSelect.value = '';
    protectionStatus.textContent = '';
    protectionPanel.hidden = true;
    protectionRetry.hidden = true;
    protectionButton.setAttribute('aria-expanded', 'false');
    listLoading = false;
    listEpoch++;
    clearTimeout(searchTimer);
    clearTimeout(listRetryTimer);
    clearPage();
    search.value = '';
    search.disabled = true;
    query = '';
    total = 0;
    offset = 0;
    summary.textContent = '';
    byId('empty-title').textContent = '';
    byId('empty-message').textContent = '';
    empty.hidden = true;
    galleryStatus.textContent = 'Locking private hub…';
    pageLabel.textContent = '';
    previous.disabled = true;
    next.disabled = true;
    retryGallery.disabled = true;
    lockButton.disabled = true;
    lockState.textContent = 'Locking…';
    grid.setAttribute('aria-busy', 'false');
  }

  lockButton.addEventListener('click', () => {
    if (locked) { return; }
    clearSensitiveView();
    try { api?.lock(); } catch { galleryStatus.textContent = 'Private hub unavailable. Close this window.'; }
  });
  protectionButton.addEventListener('click', () => {
    if (protectionPanel.hidden) { void loadProtection(); }
    else { closeProtection(); }
  });
  protectionClose.addEventListener('click', closeProtection);
  touchIdToggle.addEventListener('click', toggleTouchIdSection);
  touchIdDisable.addEventListener('click', () => { void changeTouchId(false); });
  touchIdForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isComposing) { void changeTouchId(true); }
  });
  const touchIdInputActive = () => !locked && passwordWindowFocused && !document.hidden && !touchIdForm.hidden && !protectionPanel.hidden;
  touchIdPassword.addEventListener('input', () => {
    if (!touchIdInputActive() || protectionPending) { clearTouchIdPassword(); return; }
    touchIdStatus.textContent = '';
    updateTouchIdControls();
  });
  touchIdPassword.addEventListener('compositionstart', () => {
    if (touchIdInputActive() && !protectionPending) { touchIdComposing = true; updateTouchIdControls(); }
    else { clearTouchIdPassword(); }
  });
  touchIdPassword.addEventListener('compositionend', () => {
    touchIdComposing = false;
    if (!touchIdInputActive() || protectionPending) { clearTouchIdPassword(); }
    updateTouchIdControls();
  });
  touchIdPassword.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || touchIdComposing)) { event.preventDefault(); }
  });
  passwordToggle.addEventListener('click', togglePasswordSection);
  copyToggle.addEventListener('click', toggleCopySection);
  copyCancel.addEventListener('click', requestCopyCancellation);
  copyForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isComposing) { void submitUnprotectedCopy(); }
  });
  const copyInputsActive = () => !locked && passwordWindowFocused && !document.hidden && !copyForm.hidden && !protectionPanel.hidden;
  copyPassword.addEventListener('input', () => {
    if (!copyInputsActive() || protectionPending) { clearCopyInputs(); return; }
    copyStatus.textContent = '';
    updateCopyControls();
  });
  copyAcknowledge.addEventListener('change', () => {
    if (!copyInputsActive() || protectionPending) { clearCopyInputs(); return; }
    copyStatus.textContent = '';
    updateCopyControls();
  });
  copyPassword.addEventListener('compositionstart', () => {
    if (copyInputsActive() && !protectionPending) { copyComposing = true; updateCopyControls(); }
    else { clearCopyInputs(); }
  });
  copyPassword.addEventListener('compositionend', () => {
    copyComposing = false;
    if (!copyInputsActive() || protectionPending) { clearCopyInputs(); }
    updateCopyControls();
  });
  copyPassword.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || copyComposing)) { event.preventDefault(); }
  });
  passwordForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isComposing) { void submitPasswordChange(); }
  });
  for (const input of passwordInputs) {
    const active = () => !locked && passwordWindowFocused && !document.hidden && !passwordForm.hidden && !protectionPanel.hidden;
    input.addEventListener('input', () => {
      if (!active() || protectionPending) { clearPasswordInputs(); return; }
      passwordStatus.textContent = '';
      updatePasswordControls();
    });
    input.addEventListener('compositionstart', () => {
      if (active() && !protectionPending) { passwordComposition.add(input); updatePasswordControls(); }
      else { clearPasswordInputs(); }
    });
    input.addEventListener('compositionend', () => {
      passwordComposition.delete(input);
      if (!active() || protectionPending) { clearPasswordInputs(); }
      updatePasswordControls();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229 || passwordComposition.size)) { event.preventDefault(); }
    });
  }
  protectionRetry.addEventListener('click', () => { void loadProtection(); });
  protectionSave.addEventListener('click', () => { void saveProtection(); });
  protectionSelect.addEventListener('change', () => {
    if (locked || protectionPending || savedProtection === undefined) { return; }
    protectionStatus.textContent = protectionSelect.value === String(savedProtection) ? 'No unsaved setting changes.'
      : 'Choose Save setting to apply this change.';
    updateProtection();
  });
  search.addEventListener('compositionstart', () => { composing = true; clearTimeout(searchTimer); });
  search.addEventListener('compositionend', () => { composing = false; scheduleSearch(); });
  function scheduleSearch() {
    if (locked || composing) { return; }
    clearTimeout(searchTimer);
    if (!canNavigate()) { restoreSearch(); return; }
    searchTimer = setTimeout(() => { void loadPage(0); }, 220);
  }
  search.addEventListener('input', scheduleSearch);
  previous.addEventListener('click', () => { if (!previous.disabled) { void loadPage(Math.max(0, offset - PAGE_SIZE)); } });
  next.addEventListener('click', () => { if (!next.disabled) { void loadPage(offset + PAGE_SIZE); } });
  retryGallery.addEventListener('click', () => { void loadPage(offset); });
  retryDetails.addEventListener('click', () => {
    if (selectedDetail && conflict) { void discardChanges(); }
    else if (selectedId) { void showDetails(selectedId, selectionOrigin); }
  });
  byId('close-details').addEventListener('click', () => { if (canNavigate()) { closeDetails(true); } });
  detailsNotes.addEventListener('input', () => {
    if (locked || saving || reloading || regenerating || protectionPending || !editable()) { return; }
    editStatus.textContent = conflict ? 'Your edits are still here. Choose Discard and reload to load the latest saved version.' : 'Unsaved changes.';
    updateEditor();
  });
  tagDraft.addEventListener('input', () => {
    if (!locked && !saving && !reloading && !regenerating && !protectionPending) { updateEditor(); }
  });
  for (const input of [detailsNotes, tagDraft]) {
    input.addEventListener('compositionstart', () => { editorComposition.add(input); updateEditor(); });
    input.addEventListener('compositionend', () => { editorComposition.delete(input); updateEditor(); });
  }
  addTag.addEventListener('click', () => { if (addDraftTag()) { tagDraft.focus(); } });
  tagDraft.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && !editorComposition.size) {
      event.preventDefault();
      addDraftTag();
    }
  });
  saveButton.addEventListener('click', () => { void saveChanges(); });
  discardButton.addEventListener('click', () => { void discardChanges(); });
  regenerate.addEventListener('click', () => { void regeneratePreviews(); });
  cancelGeneration.addEventListener('click', cancelRegeneration);
  play.addEventListener('click', () => { void playPreview(); });
  filmstripToggle.addEventListener('click', toggleFilmstrip);
  filmstripPrevious.addEventListener('click', () => { scrollFilmstrip(-1); });
  filmstripNext.addEventListener('click', () => { scrollFilmstrip(1); });
  filmstripViewport.addEventListener('scroll', updateFilmstripNavigation);
  window.addEventListener('resize', updateFilmstripNavigation);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) { return; }
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) { return; }
    if (!protectionPanel.hidden) { event.preventDefault(); closeProtection(); return; }
    if (details.hidden) { return; }
    event.preventDefault();
    if (canNavigate()) { closeDetails(true); }
  });
  function preventExport(event) {
    event.preventDefault();
    if (event.type !== 'copy' && event.type !== 'cut') { event.stopImmediatePropagation(); }
  }
  for (const name of ['copy', 'cut', 'dragstart', 'drop', 'contextmenu']) {
    document.addEventListener(name, preventExport, true);
  }
  document.addEventListener('paste', event => {
    const input = event.target;
    const passwordField = passwordInputs.includes(input) && !passwordForm.hidden && !passwordBlockedMessage();
    const copyField = input === copyPassword && !copyForm.hidden && !copyBlockedMessage();
    const touchIdField = input === touchIdPassword && !touchIdForm.hidden && !touchIdBlockedMessage();
    // Let Chromium paste directly into the active credential field. Never read,
    // copy or retain clipboard data in application code.
    if ((passwordField || copyField || touchIdField) && !locked && !protectionPending && passwordWindowFocused
      && !document.hidden && !protectionPanel.hidden && input === document.activeElement
      && !input.disabled && !input.readOnly && !input.hidden) { return; }
    preventExport(event);
  }, true);
  window.addEventListener('blur', () => { passwordWindowFocused = false; clearPasswordsOnBlur(); });
  window.addEventListener('focus', () => { passwordWindowFocused = true; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearPasswordsOnBlur(); } });
  window.addEventListener('pagehide', clearSensitiveView);
  if (api) { void loadPage(0); }
  else {
    galleryStatus.textContent = '';
    grid.setAttribute('aria-busy', 'false');
    lockState.textContent = 'Unavailable';
    protectionButton.disabled = true;
    showEmpty('Private hub unavailable', 'Close this window and open the private hub again.');
  }
})();
