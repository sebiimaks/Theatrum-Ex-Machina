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
  const collectionControl = byId('gallery-collection');
  const sortControl = byId('gallery-sort');
  const directionControl = byId('gallery-sort-direction');
  const collectionValues = ['all', 'favourites', 'recent'];
  const sortValues = ['catalogue', 'name', 'date-added', 'last-played', 'rating', 'duration', 'file-size'];
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
  const ratingEditor = byId('details-rating-editor');
  const ratingInput = byId('details-rating-input');
  const ratingExisting = byId('details-rating-existing');
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
  const playOriginalButton = byId('play-original');
  const stopPlaybackButton = byId('stop-video');
  const playbackStatus = byId('playback-status');
  const filmstripToggle = byId('toggle-filmstrip');
  const filmstripPanel = byId('filmstrip-panel');
  const filmstripImage = byId('detail-filmstrip');
  const filmstripStatus = byId('filmstrip-status');
  const filmstripViewport = byId('filmstrip-viewport');
  const filmstripPrevious = byId('filmstrip-previous');
  const filmstripNext = byId('filmstrip-next');
  const regenerate = byId('regenerate-previews');
  const refreshVideo = byId('refresh-video');
  const chooseThumbnail = byId('choose-thumbnail');
  const cancelGeneration = byId('cancel-regeneration');
  const generationStatus = byId('generation-status');
  const retryDetails = byId('retry-details');
  const lockButton = byId('lock-hub');
  const lockState = byId('lock-state');
  const protectionButton = byId('protection-button');
  const protectionPanel = byId('protection-panel');
  const protectionSelect = byId('auto-lock-minutes');
  const historySelect = byId('record-playback-history');
  const resetLastPlayed = byId('reset-last-played');
  const resetTimesPlayed = byId('reset-times-played');
  const playbackResetSection = byId('playback-reset-section');
  const playbackResetStatus = byId('playback-reset-status');
  const protectionSave = byId('save-protection');
  const protectionRetry = byId('retry-protection');
  const protectionClose = byId('close-protection');
  const protectionStatus = byId('protection-status');
  const protectionValues = ['0', '1', '5', '15', '30'];
  const sourcesToggle = byId('source-folders-toggle');
  const sourcesPanel = byId('source-folders-panel');
  const sourcesList = byId('source-folders-list');
  const sourcesStatus = byId('source-folders-status');
  const sourceAdd = byId('add-source-folder');
  const sourcesRefresh = byId('refresh-source-folders');
  const sourcesClose = byId('close-source-folders');
  const sourceCancel = byId('cancel-source-connection');
  const importCancel = byId('cancel-video-import');
  const passwordToggle = byId('change-password-toggle');
  const passwordForm = byId('change-password-form');
  const currentPasswordInput = byId('current-password');
  const newPasswordInput = byId('new-password');
  const confirmPasswordInput = byId('confirm-password');
  const passwordInputs = [currentPasswordInput, newPasswordInput, confirmPasswordInput];
  const passwordSubmit = byId('change-password-submit');
  const passwordResume = byId('resume-password-submit');
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
  const resumePasswordChange = typeof credentialBridge?.resumePasswordChange === 'function'
    ? credentialBridge.resumePasswordChange.bind(credentialBridge) : undefined;
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
    setCustomThumbnail: typeof bridge.setCustomThumbnail === 'function' ? bridge.setCustomThumbnail.bind(bridge) : undefined,
    refreshVideo: typeof bridge.refreshVideo === 'function' ? bridge.refreshVideo.bind(bridge) : undefined,
    regenerate: typeof bridge.regenerate === 'function' ? bridge.regenerate.bind(bridge) : undefined,
    playOriginal: typeof bridge.playOriginal === 'function' ? bridge.playOriginal.bind(bridge) : undefined,
    ackOriginalPlayback: typeof bridge.ackOriginalPlayback === 'function' ? bridge.ackOriginalPlayback.bind(bridge) : undefined,
    resetPlaybackHistory: typeof bridge.resetPlaybackHistory === 'function' ? bridge.resetPlaybackHistory.bind(bridge) : undefined,
    stopOriginal: typeof bridge.stopOriginal === 'function' ? bridge.stopOriginal.bind(bridge) : undefined,
    cancelRegeneration: typeof bridge.cancelRegeneration === 'function' ? bridge.cancelRegeneration.bind(bridge) : undefined,
    protection: typeof bridge.protection === 'function' ? bridge.protection.bind(bridge) : undefined,
    setProtection: typeof bridge.setProtection === 'function' ? bridge.setProtection.bind(bridge) : undefined,
    sources: typeof bridge.sources === 'function' ? bridge.sources.bind(bridge) : undefined,
    addSource: typeof bridge.addSource === 'function' ? bridge.addSource.bind(bridge) : undefined,
    connectSource: typeof bridge.connectSource === 'function' ? bridge.connectSource.bind(bridge) : undefined,
    disconnectSource: typeof bridge.disconnectSource === 'function' ? bridge.disconnectSource.bind(bridge) : undefined,
    importProgress: typeof bridge.importProgress === 'function' ? bridge.importProgress.bind(bridge) : undefined,
    checkSource: typeof bridge.checkSource === 'function' ? bridge.checkSource.bind(bridge) : undefined,
    scanSource: typeof bridge.scanSource === 'function' ? bridge.scanSource.bind(bridge) : undefined,
    importVideo: typeof bridge.importVideo === 'function' ? bridge.importVideo.bind(bridge) : undefined,
    cancelImport: typeof bridge.cancelImport === 'function' ? bridge.cancelImport.bind(bridge) : undefined,
    relocateSource: typeof bridge.relocateSource === 'function' ? bridge.relocateSource.bind(bridge) : undefined,
    cancelSourceConnection: typeof bridge.cancelSourceConnection === 'function' ? bridge.cancelSourceConnection.bind(bridge) : undefined,
  } : undefined;

  let locked = false;
  let composing = false;
  let offset = 0;
  let total = 0;
  let query = '';
  let collection = 'all';
  let sort = 'catalogue';
  let direction = 'asc';
  let listEpoch = 0;
  let detailEpoch = 0;
  let selectedId = '';
  let selectedDetail;
  let draftTags = [];
  let ratingTouched = false;
  let draftRating;
  let saving = false;
  let reloading = false;
  let regenerating = false;
  let refreshingVideo = false;
  let choosingThumbnail = false;
  let cancelling = false;
  let listLoading = false;
  let detailLoading = false;
  let protectionPending = '';
  let protectionEpoch = 0;
  let savedProtection;
  let savedPlaybackHistory;
  let historyRefreshId = '';
  let historyRefreshEpoch = 0;
  let playbackResetEpoch = 0;
  let sourceEpoch = 0;
  let sourceItems = [];
  let sourceListReady = false;
  let sourceCancelling = false;
  let sourceImportMode = '';
  let importProgressEpoch = 0;
  let importProgressTimer;
  let touchIdState = 'unavailable';
  let touchIdEpoch = 0;
  let touchIdComposing = false;
  let passwordEpoch = 0;
  let passwordAction = 'change';
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
  let originalPending = false;
  let originalActive = false;
  let originalCancelling = false;
  let playbackHistoryNotice = '';
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
    return editable() && (ratingTouched || detailsNotes.value !== selectedDetail.notes || tagDraft.value !== ''
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
    ratingEditor.hidden = !enabled;
    lockWarning.hidden = !(dirty() || saving || reloading);
    lockWarning.textContent = saving ? 'Locking clears these drafts. A save already in progress may finish.'
      : 'Locking clears unsaved edits.';
    lockButton.title = dirty() ? 'Lock hub and clear unsaved edits'
      : regenerating ? (choosingThumbnail ? 'Lock hub and stop thumbnail selection' : refreshingVideo ? 'Lock hub and stop video refresh' : 'Lock hub and stop preview regeneration') : 'Lock hub';
    regenerate.disabled = locked || pending || editorComposition.size > 0 || selectedDetail?.regenerable !== true
      || conflict || !/^[a-f0-9]{32}$/.test(selectedDetail?.revision) || !api?.regenerate || !api?.cancelRegeneration;
    cancelGeneration.hidden = !regenerating;
    cancelGeneration.disabled = locked || cancelling;
    cancelGeneration.textContent = cancelling ? 'Cancelling…' : refreshingVideo ? 'Cancel refresh' : 'Cancel';
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

  function refreshVideoBlockedMessage() {
    if (locked || !api?.refreshVideo || !api?.cancelRegeneration || selectedDetail?.refreshable !== true) {
      return 'Refresh is unavailable for this video.';
    }
    if (dirty() || editorComposition.size) { return 'Save or discard your edits before refreshing this video.'; }
    if (conflict || !/^[a-f0-9]{32}$/.test(selectedDetail?.revision)) { return 'Reload the saved video details before refreshing this video.'; }
    if (composing) { return 'Finish entering your search before refreshing this video.'; }
    if (browseProtectionDraft()) { return 'Save your protection settings, or restore their saved values, before refreshing this video.'; }
    if (passwordComposition.size || passwordInputs.some(input => input.value !== '') || copyComposing || copyPassword.value !== ''
      || copyAcknowledge.checked || touchIdComposing || touchIdPassword.value !== '') {
      return 'Finish or close the password, Touch ID or unprotected-copy form before refreshing this video.';
    }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    return '';
  }

  function thumbnailBlockedMessage() {
    if (locked || !api?.setCustomThumbnail || !api?.cancelRegeneration || selectedDetail?.thumbnailEditable !== true) {
      return 'Choosing a thumbnail is unavailable for this video.';
    }
    if (editorComposition.size || composing) { return 'Finish entering text before choosing a thumbnail.'; }
    if (conflict || !/^[a-f0-9]{32}$/.test(selectedDetail?.revision)) { return 'Reload the saved video details before choosing a thumbnail.'; }
    if (browseProtectionDraft()) { return 'Save your protection settings, or restore their saved values, before choosing a thumbnail.'; }
    if (passwordComposition.size || passwordInputs.some(input => input.value !== '') || copyComposing || copyPassword.value !== ''
      || copyAcknowledge.checked || touchIdComposing || touchIdPassword.value !== '') {
      return 'Finish or close the password, Touch ID or unprotected-copy form before choosing a thumbnail.';
    }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    return '';
  }

  function updateRefreshVideo() {
    const thumbnailReason = thumbnailBlockedMessage();
    chooseThumbnail.disabled = !!thumbnailReason;
    chooseThumbnail.title = thumbnailReason || 'Choose a JPEG or PNG image to encrypt as this video’s thumbnail.';
    const reason = refreshVideoBlockedMessage();
    refreshVideo.disabled = !!reason;
    refreshVideo.title = reason || 'Update technical details and encrypted previews from the saved source.';
  }

  function updateProtection() {
    updateRefreshVideo();
    const blocked = protectionBlocked() || !!protectionPending;
    protectionButton.disabled = blocked || !api?.protection || !api?.setProtection;
    protectionSelect.disabled = blocked || savedProtection === undefined;
    historySelect.disabled = blocked || savedPlaybackHistory === undefined;
    protectionSave.disabled = protectionSelect.disabled || !protectionValues.includes(protectionSelect.value)
      || !['off', 'on'].includes(historySelect.value) || !browseProtectionDraft();
    protectionSave.textContent = protectionPending === 'saving' ? 'Saving…' : 'Save settings';
    protectionRetry.disabled = blocked;
    protectionClose.disabled = locked || (!!protectionPending && protectionPending !== 'password');
    const resetBlocked = blocked || protectionPanel.hidden || savedProtection === undefined || savedPlaybackHistory === undefined
      || !api?.resetPlaybackHistory;
    resetLastPlayed.disabled = resetBlocked;
    resetTimesPlayed.disabled = resetBlocked;
    playbackResetSection.setAttribute('aria-busy', String(protectionPending === 'history-reset' && !locked));
    search.disabled = locked || !!protectionPending;
    ratingInput.disabled = !editable() || locked || saving || reloading || regenerating || !!protectionPending
      || editorComposition.size > 0 || browseProtectionDraft();
    retryGallery.disabled = locked || !!protectionPending;
    retryDetails.disabled = locked || !!protectionPending;
    updatePlaybackControls();
    if (locked || (regenerating && !choosingThumbnail) || protectionPending) { closeFilmstrip(); }
    filmstripToggle.disabled = locked || saving || reloading || detailLoading || regenerating || !!protectionPending
      || !selectedDetail || !previewUrl(selectedDetail.filmstripUrl, 'filmstrip');
    updateFilmstripNavigation();
    updatePasswordControls();
    updateCopyControls();
    updateTouchIdControls();
    updatePages(listLoading);
    updateSourceControls();
    updateBrowseControls();
  }

  function clearPasswordInputs() {
    for (const input of passwordInputs) { input.value = ''; }
    passwordComposition.clear();
  }

  function passwordBlockedMessage() {
    if (!changePassword) { return 'Password changes are unavailable. Lock this hub and reopen it to try again.'; }
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes, tags and rating before changing the password.'; }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    if (browseProtectionDraft()) {
      return 'Save your protection settings, or restore their saved values, before changing the password.';
    }
    return '';
  }

  function updatePasswordControls() {
    updateRefreshVideo();
    const blocked = locked || !!passwordBlockedMessage();
    for (const input of passwordInputs) { input.disabled = blocked; }
    passwordSubmit.disabled = blocked || passwordComposition.size > 0 || passwordForm.hidden || protectionPanel.hidden;
    const pending = protectionPending === 'password';
    passwordSubmit.textContent = pending && passwordAction === 'change' ? 'Changing password…' : 'Change password and lock';
    passwordResume.disabled = passwordSubmit.disabled || !resumePasswordChange;
    passwordResume.textContent = pending && passwordAction === 'resume' ? 'Finishing interrupted change…' : 'Finish interrupted password change';
    // A pending request can be concealed, but cannot be restarted or reopened.
    passwordToggle.disabled = locked || !changePassword || (!!protectionPending
      && !(protectionPending === 'password' && !passwordForm.hidden));
    if (!passwordForm.hidden && !locked) {
      if (protectionPending === 'password') { passwordStatus.textContent = passwordAction === 'resume'
        ? 'Checking the interrupted change. Confirm in the dialog to finish and lock the hub.'
        : 'Changing the password. The hub will lock when it is saved.'; }
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

  async function submitPasswordChange(resume = false) {
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
      const blocked = passwordBlockedMessage() || (resume && !resumePasswordChange
        ? 'Finishing an interrupted change is unavailable in this build.' : '');
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
      passwordAction = resume ? 'resume' : 'change';
      protectionPending = 'password';
      clearTimeout(searchTimer);
      stopVideo();
      play.hidden = !clipUrl;
      updateEditor();
      try { invocation = (resume ? resumePasswordChange : changePassword)({ currentPassword, newPassword }); }
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
    passwordStatus.textContent = resume && result?.status === 'not-found'
      ? 'No interrupted password change was found. Use Change password and lock for a new change.'
      : resume && result?.status === 'cancelled' ? 'The interrupted change was left unfinished. Your current password is unchanged.'
        : result?.status === 'incorrect-password' ? (resume
          ? 'The current password or the password from the interrupted change is incorrect. Re-enter all three fields.'
          : 'The current password is incorrect. Re-enter all three fields and try again.')
          : result?.status === 'invalid' ? 'The passwords were not accepted. Use different passwords of 1–1,024 UTF-8 bytes and confirm the new one.'
            : result?.status === 'busy' ? 'The hub is busy. Re-enter your passwords and try again when the current operation finishes.'
              : resume ? 'The interrupted change could not be finished. Reopen the hub and keep its files intact.'
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
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes, tags and rating before creating a copy.'; }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    if (browseProtectionDraft()) {
      return 'Save your protection settings, or restore their saved values, before creating a copy.';
    }
    return '';
  }

  function updateCopyControls() {
    updateRefreshVideo();
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
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes, tags and rating before changing Touch ID.'; }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    if (browseProtectionDraft()) {
      return 'Save your protection settings, or restore their saved values, before changing Touch ID.';
    }
    return '';
  }

  function updateTouchIdControls() {
    updateRefreshVideo();
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
    closeSources(false);
    stopVideo();
    const epoch = ++protectionEpoch;
    protectionPanel.hidden = false;
    protectionButton.setAttribute('aria-expanded', 'true');
    savedProtection = undefined;
    protectionSelect.value = '';
    savedPlaybackHistory = undefined;
    historySelect.value = '';
    playbackResetStatus.textContent = '';
    closeTouchIdSection();
    showTouchIdState('unavailable');
    touchIdSummary.textContent = 'Checking Touch ID availability…';
    protectionPending = 'loading';
    protectionStatus.textContent = 'Loading saved protection settings…';
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
    if (result?.status === 'ready' && validProtection(result.autoLockMinutes)
      && (result.recordPlaybackHistory === undefined || typeof result.recordPlaybackHistory === 'boolean')) {
      savedProtection = result.autoLockMinutes;
      protectionSelect.value = String(savedProtection);
      savedPlaybackHistory = result.recordPlaybackHistory === true;
      historySelect.value = savedPlaybackHistory ? 'on' : 'off';
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
      || !protectionValues.includes(protectionSelect.value) || !['off', 'on'].includes(historySelect.value) || !browseProtectionDraft()) { return; }
    const epoch = ++protectionEpoch;
    const autoLockMinutes = Number(protectionSelect.value);
    const recordPlaybackHistory = historySelect.value === 'on';
    stopVideo();
    protectionPending = 'saving';
    protectionStatus.textContent = 'Saving encrypted protection setting…';
    updateEditor();
    let result;
    try { result = await api.setProtection({ autoLockMinutes, recordPlaybackHistory }); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== protectionEpoch) { return; }
    protectionPending = '';
    if (result?.status === 'saved' && result.autoLockMinutes === autoLockMinutes
      && (result.recordPlaybackHistory === undefined || typeof result.recordPlaybackHistory === 'boolean')
      && (result.recordPlaybackHistory === true) === recordPlaybackHistory) {
      savedProtection = autoLockMinutes;
      protectionSelect.value = String(autoLockMinutes);
      savedPlaybackHistory = recordPlaybackHistory;
      historySelect.value = recordPlaybackHistory ? 'on' : 'off';
      protectionStatus.textContent = 'Protection settings saved.';
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

  function playbackResetBlockedMessage() {
    if (!api?.resetPlaybackHistory) { return 'Playback history resets are unavailable. Lock this hub and reopen it to try again.'; }
    if (dirty() || editorComposition.size) { return 'Save or discard your video notes, tags and rating before resetting playback history.'; }
    if (conflict) { return 'Reload the saved video details before resetting playback history.'; }
    if (composing) { return 'Finish entering your search before resetting playback history.'; }
    if (browseProtectionDraft()) { return 'Save your protection settings, or restore their saved values, before resetting playback history.'; }
    if (passwordComposition.size || passwordInputs.some(input => input.value !== '') || copyComposing || copyPassword.value !== ''
      || copyAcknowledge.checked || touchIdComposing || touchIdPassword.value !== '') {
      return 'Finish or close the password, Touch ID or unprotected-copy form before resetting playback history.';
    }
    if (protectionBlocked() || protectionPending) { return 'Wait for the current operation to finish, or lock the hub.'; }
    return '';
  }

  async function resetPlaybackHistory(metric) {
    if (locked || protectionPanel.hidden || !['lastPlayed', 'timesPlayed'].includes(metric)
      || savedProtection === undefined || savedPlaybackHistory === undefined) { return; }
    const blocked = playbackResetBlockedMessage();
    if (blocked) { playbackResetStatus.textContent = blocked; return; }
    const epoch = ++playbackResetEpoch;
    const label = metric === 'lastPlayed' ? 'Last played' : 'Times played';
    clearTimeout(searchTimer);
    query = search.value.slice(0, 200);
    closePasswordSection(); closeCopySection(); closeTouchIdSection();
    stopVideo();
    protectionPending = 'history-reset';
    playbackResetStatus.textContent = `Review resetting ${label} in the confirmation window. Close that window to cancel, or lock the hub.`;
    updateEditor();
    let result;
    try { result = await api.resetPlaybackHistory(metric); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== playbackResetEpoch) { return; }
    protectionPending = '';
    // Main retires issued catalogue IDs even after cancellation or a no-op.
    // This action admits no drafts: retire the old selection and source IDs,
    // then reload the existing search, collection and order without closing Protection.
    closeSources(false);
    closeDetails();
    if (result?.status === 'reset' && Number.isSafeInteger(result.count) && result.count >= 1 && result.count <= 100_000) {
      playbackResetStatus.textContent = `${label} reset for ${result.count.toLocaleString()} catalogue ${result.count === 1 ? 'entry' : 'entries'}. Playback recording is unchanged.`;
    } else if (result?.status === 'unchanged') {
      playbackResetStatus.textContent = `No ${label} values needed resetting. Playback recording is unchanged.`;
    } else if (result?.status === 'cancelled') {
      playbackResetStatus.textContent = 'Reset cancelled. Playback history is unchanged.';
    } else {
      playbackResetStatus.textContent = result?.status === 'busy' ? 'The hub is busy. Review the refreshed catalogue before trying again.'
        : 'The reset could not be confirmed. Review the refreshed catalogue before trying again, or lock the hub.';
    }
    playbackResetStatus.focus({ preventScroll: true });
    void loadPage(offset, 0, undefined, true);
  }

  function sourceOperationPending() {
    return protectionPending.startsWith('source-');
  }

  function sourcesAvailable() {
    return !!api?.sources && !!api?.connectSource && !!api?.disconnectSource && !!api?.cancelSourceConnection;
  }

  function updateSourceControls() {
    const blocked = protectionBlocked() || !!protectionPending;
    sourcesToggle.disabled = blocked || !sourcesAvailable();
    sourcesRefresh.disabled = blocked || !sourcesAvailable();
    sourceAdd.disabled = blocked || !sourcesAvailable() || !api?.addSource || !sourceListReady
      || sourceItems.length >= 256 || dirty() || !!editorComposition.size || conflict;
    sourcesClose.disabled = locked || sourceOperationPending();
    sourceCancel.hidden = !['source-connect', 'source-relocate', 'source-add', 'source-check'].includes(protectionPending);
    sourceCancel.disabled = locked || sourceCancelling;
    sourceCancel.textContent = sourceCancelling ? 'Cancelling…' : protectionPending === 'source-relocate' ? 'Cancel change'
      : protectionPending === 'source-add' ? 'Cancel adding folder' : protectionPending === 'source-check' ? 'Cancel check' : 'Cancel connection';
    importCancel.hidden = protectionPending !== 'source-import';
    importCancel.disabled = locked || sourceCancelling;
    importCancel.textContent = sourceCancelling ? 'Cancelling…' : sourceImportMode === 'scan' ? 'Cancel' : 'Cancel import';
    importCancel.setAttribute('aria-label', sourceImportMode === 'scan' ? 'Cancel finding or importing videos' : 'Cancel import');
    sourcesList.setAttribute('aria-busy', String(sourceOperationPending() && !locked));
    for (const row of sourcesList.children) {
      for (const button of row.querySelectorAll('button')) {
        button.disabled = blocked || (button.getAttribute('data-action') === 'check-source'
          && (!api?.checkSource || composing)) || (button.getAttribute('data-action') === 'relocate-source' && !api?.relocateSource)
          || (button.getAttribute('data-action') === 'import-video'
            && (!api?.importVideo || !api?.cancelImport || dirty() || conflict))
          || (button.getAttribute('data-action') === 'scan-source'
            && (!api?.scanSource || !api?.cancelImport || dirty() || conflict));
      }
    }
  }

  function validSourceItem(item) {
    return !!item && typeof item.id === 'string' && /^[a-f0-9]{32}$/.exec(item.id)?.[0] === item.id && typeof item.title === 'string'
      && /^Source folder ([1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-6])$/.exec(item.title)?.[0] === item.title
      && Number.isSafeInteger(item.videoCount) && item.videoCount >= 0 && item.videoCount <= 100_000 && typeof item.connected === 'boolean';
  }

  function validSourceList(result) {
    return result?.status === 'ready' && Array.isArray(result.items) && result.items.length <= 256
      && Array.from(result.items).every(validSourceItem) && new Set(result.items.map(item => item.id)).size === result.items.length;
  }

  function sourceItem(item) {
    return { id: item.id, title: item.title, videoCount: item.videoCount, connected: item.connected };
  }

  function renderSources() {
    sourcesList.replaceChildren();
    for (const item of sourceItems) {
      const row = textElement('li', 'source-folder-row', '');
      const description = textElement('div', 'source-folder-description', '');
      const title = textElement('h3', 'source-folder-title', item.title);
      const count = textElement('p', 'source-folder-count', `${item.videoCount.toLocaleString()} ${item.videoCount === 1 ? 'video' : 'videos'}`);
      const state = textElement('p', 'source-folder-state', item.connected ? 'Connected for this session' : 'Not connected');
      state.setAttribute('data-connected', String(item.connected));
      description.append(title, count, state);
      const button = textElement('button', 'button button-secondary', item.connected ? 'Disconnect' : 'Connect');
      button.type = 'button';
      button.setAttribute('data-action', item.connected ? 'disconnect-source' : 'connect-source');
      button.setAttribute('aria-label', `${item.connected ? 'Disconnect' : 'Connect'} ${item.title}`);
      button.addEventListener('click', () => { void changeSourceConnection(item); });
      const relocate = textElement('button', 'button button-secondary source-relocate-button', 'Change location…');
      relocate.type = 'button';
      relocate.setAttribute('data-action', 'relocate-source');
      relocate.setAttribute('aria-label', `Change location of ${item.title}`);
      relocate.addEventListener('click', () => { void changeSourceLocation(item); });
      const importButton = textElement('button', 'button button-secondary source-import-button', 'Add videos…');
      importButton.type = 'button';
      importButton.setAttribute('data-action', 'import-video');
      importButton.setAttribute('aria-label', `Add videos from ${item.title}`);
      importButton.addEventListener('click', () => { void importSourceVideo(item); });
      const scanButton = textElement('button', 'button button-secondary source-scan-button', 'Find new videos…');
      scanButton.type = 'button';
      scanButton.setAttribute('data-action', 'scan-source');
      scanButton.setAttribute('aria-label', `Find new videos in ${item.title}`);
      scanButton.setAttribute('aria-describedby', 'source-scan-help');
      scanButton.addEventListener('click', () => { void importSourceVideo(item, true); });
      const checkButton = textElement('button', 'button button-secondary source-check-button', 'Check saved files…');
      checkButton.type = 'button';
      checkButton.setAttribute('data-action', 'check-source');
      checkButton.setAttribute('aria-label', `Check saved files in ${item.title}`);
      checkButton.setAttribute('aria-describedby', 'source-check-help');
      checkButton.addEventListener('click', () => { void checkSourceFiles(item); });
      const actions = textElement('div', 'source-folder-actions', '');
      actions.append(importButton, scanButton, checkButton, relocate);
      row.append(description, button, actions);
      sourcesList.append(row);
    }
    updateSourceControls();
  }

  function closeSources(restoreFocus = true) {
    if (sourceOperationPending()) { return; }
    sourceEpoch++;
    clearImportProgress();
    sourceItems = [];
    sourceListReady = false;
    sourcesList.replaceChildren();
    sourcesStatus.textContent = '';
    sourcesPanel.hidden = true;
    sourcesToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !locked) { sourcesToggle.focus({ preventScroll: true }); }
  }

  async function loadSources() {
    if (protectionBlocked() || protectionPending || !sourcesAvailable()) { return; }
    closeProtection();
    stopVideo();
    const epoch = ++sourceEpoch;
    sourceItems = [];
    sourceListReady = false;
    sourcesList.replaceChildren();
    sourcesPanel.hidden = false;
    sourcesToggle.setAttribute('aria-expanded', 'true');
    sourcesStatus.textContent = 'Checking saved source folders…';
    protectionPending = 'source-loading';
    updateEditor();
    sourcesPanel.focus({ preventScroll: true });
    let result;
    try { result = await api.sources(); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    protectionPending = '';
    if (validSourceList(result)) {
      sourceItems = result.items.map(sourceItem);
      sourceListReady = true;
      sourcesStatus.textContent = sourceItems.length ? 'Choose Connect to select the saved folder.' : 'No saved source folders in this hub.';
      renderSources();
    } else {
      sourcesStatus.textContent = result?.status === 'busy' ? 'The hub is busy. Choose Refresh to try again.'
        : 'Source folders could not be checked. Choose Refresh to try again, or lock the hub.';
    }
    updateEditor();
  }

  async function changeSourceConnection(item) {
    if (protectionBlocked() || protectionPending || sourcesPanel.hidden || !sourcesAvailable() || !sourceItems.includes(item)) { return; }
    const epoch = ++sourceEpoch;
    const connecting = !item.connected;
    protectionPending = connecting ? 'source-connect' : 'source-disconnect';
    sourceCancelling = false;
    sourcesStatus.textContent = connecting ? 'Choose this video source’s saved folder in the folder picker.' : 'Disconnecting source folder…';
    // Retire a playing preview before opening a native picker; drafts stay intact.
    stopVideo();
    play.hidden = !clipUrl;
    updateEditor();
    let result;
    try { result = await (connecting ? api.connectSource(item.id) : api.disconnectSource(item.id)); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    const expectedStatus = connecting ? 'connected' : 'disconnected';
    if (result?.status === expectedStatus && validSourceItem(result.item) && result.item.id === item.id
      && result.item.title === item.title && result.item.connected === connecting) {
      // One grant can cover duplicate saved roots. Refresh all rows together.
      let refreshed;
      try { refreshed = await api.sources(); }
      catch { refreshed = { status: 'unavailable' }; }
      if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
      sourceListReady = validSourceList(refreshed);
      sourceItems = sourceListReady ? refreshed.items.map(sourceItem) : [];
      sourcesStatus.textContent = connecting ? 'Source folder connected until this hub locks.' : 'Source folder disconnected.';
      if (!validSourceList(refreshed)) { sourcesStatus.textContent += ' Choose Refresh to check the saved folders again.'; }
    } else {
      const messages = {
        cancelled: 'Connection cancelled. Choose Connect to try again.',
        conflict: 'The saved source folders changed. Choose Refresh to load them again.',
        'wrong-folder': 'That is not the saved source folder. Choose Connect and select its original location.',
        'source-unavailable': 'The source folder is unavailable. Check that its drive is connected and access is allowed, then try again.',
        busy: 'The hub is busy. Choose Refresh to try again.',
      };
      sourcesStatus.textContent = messages[result?.status] || 'The connection could not be updated. Choose Refresh to check it, or lock the hub.';
      // Ambiguous failures need a fresh check instead of presenting stale grants.
      if (!['cancelled', 'wrong-folder', 'source-unavailable'].includes(result?.status)) { sourceItems = []; sourceListReady = false; }
    }
    protectionPending = '';
    sourceCancelling = false;
    renderSources();
    updateEditor();
    const changedRow = sourceItems.findIndex(current => current.id === item.id);
    (sourcesList.children[changedRow]?.querySelector('button') || sourcesRefresh).focus({ preventScroll: true });
  }

  function sourceCheckSummary(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.status !== 'checked') { return ''; }
    const { total, sameSize, differentSize, missing, unverified, ignored } = result;
    if (![total, sameSize, differentSize, missing, unverified, ignored].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 10_000)
      || sameSize + differentSize + missing + unverified + ignored !== total) { return ''; }
    return `Check complete. ${total.toLocaleString()} saved file ${total === 1 ? 'location' : 'locations'}.`
      + `\nSame recorded size: ${sameSize.toLocaleString()} · Different size: ${differentSize.toLocaleString()}`
      + `\nMissing: ${missing.toLocaleString()} · Not verified: ${unverified.toLocaleString()} · Ignored: ${ignored.toLocaleString()}`
      + '\nThis is a point-in-time check. The same size does not prove a file is unchanged or playable. Ignored locations were not checked.';
  }

  async function checkSourceFiles(item) {
    if (protectionBlocked() || protectionPending || sourcesPanel.hidden || !api?.checkSource
      || !api?.cancelSourceConnection || !sourceItems.includes(item) || composing) { return; }
    if (browseProtectionDraft()) {
      sourcesStatus.textContent = 'Save your protection settings, or restore their saved values, before checking saved files.';
      return;
    }
    if (passwordComposition.size || passwordInputs.some(input => input.value !== '') || copyComposing || copyPassword.value !== ''
      || copyAcknowledge.checked || touchIdComposing || touchIdPassword.value !== '') {
      sourcesStatus.textContent = 'Finish or close the password, Touch ID or unprotected-copy form before checking saved files.';
      return;
    }
    const epoch = ++sourceEpoch;
    protectionPending = 'source-check';
    sourceCancelling = false;
    clearTimeout(searchTimer);
    sourcesStatus.textContent = 'Checking saved file locations… Choose the saved folder if prompted. Original files and catalogue metadata remain unchanged.';
    stopVideo();
    play.hidden = !clipUrl;
    updateEditor();
    sourceCancel.focus({ preventScroll: true });
    let result;
    try { result = await api.checkSource(item.id); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    // The check may establish a session grant. Refresh only source connection
    // labels: catalogue IDs, selected details and all edit drafts stay intact.
    if (sourceCancelling) { result = { status: 'cancelled' }; }
    let refreshed;
    try { refreshed = await api.sources(); }
    catch { refreshed = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    if (sourceCancelling) { result = { status: 'cancelled' }; }
    sourceListReady = validSourceList(refreshed);
    sourceItems = sourceListReady ? refreshed.items.map(sourceItem) : [];
    const messages = {
      cancelled: 'Check cancelled. No results were retained. Original files and catalogue metadata are unchanged.',
      conflict: 'The saved source folders changed. Review the refreshed folders and try again.',
      invalid: 'The saved file locations could not be checked. No results were retained.',
      limit: 'The catalogue or saved locations exceed a supported check limit (up to 10,000 saved file locations per source). No results were retained.',
      'wrong-folder': 'That is not the saved source folder. Choose Check saved files and select its original location.',
      'source-unavailable': 'The source folder is unavailable. Check that its drive is connected and access is allowed, then try again.',
      busy: 'The hub is busy. Choose Check saved files to try again.',
    };
    sourcesStatus.textContent = sourceCheckSummary(result) || (typeof result?.status === 'string' && Object.hasOwn(messages, result.status)
      ? messages[result.status] : 'The saved files could not be checked. No results were retained. Try again, or lock the hub.');
    if (!sourceListReady) { sourcesStatus.textContent += '\nChoose Refresh to check the saved folders again.'; }
    protectionPending = '';
    sourceCancelling = false;
    renderSources();
    updateEditor();
    const checkedRow = sourceItems.findIndex(current => current.id === item.id);
    (sourcesList.children[checkedRow]?.querySelector('[data-action="check-source"]') || sourcesRefresh).focus({ preventScroll: true });
  }

  async function addSourceFolder() {
    if (locked || protectionPending || sourcesPanel.hidden || !sourcesAvailable() || !api?.addSource) { return; }
    if (dirty() || editorComposition.size || conflict) {
      sourcesStatus.textContent = 'Save or discard your video notes, tags and rating before adding a source folder.';
      return;
    }
    if (!sourceListReady || sourceItems.length >= 256 || protectionBlocked()) { return; }
    const epoch = ++sourceEpoch;
    protectionPending = 'source-add';
    sourceCancelling = false;
    clearTimeout(searchTimer);
    sourcesStatus.textContent = 'Choose a source folder to save in this hub. No videos will be added automatically; original files remain unchanged.';
    stopVideo();
    play.hidden = !clipUrl;
    updateEditor();
    sourceCancel.focus({ preventScroll: true });
    let result;
    try { result = await api.addSource(); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    // A catalogue save can finish as cancellation arrives. Refresh both lists
    // for every outcome and retire the old selection and source capabilities.
    sourceItems = [];
    sourceListReady = false;
    sourcesList.replaceChildren();
    closeDetails();
    await loadPage(offset, 0, undefined, true);
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    let refreshed;
    try { refreshed = await api.sources(); }
    catch { refreshed = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    sourceListReady = validSourceList(refreshed);
    sourceItems = sourceListReady ? refreshed.items.map(sourceItem) : [];
    const messages = {
      added: 'Source folder saved and not connected. Choose Connect for playback, or Add videos to import videos. Original files are unchanged.',
      cancelled: 'Adding the folder was cancelled. Check the saved folders; a save already in progress may finish.',
      conflict: 'The catalogue changed before the folder could be saved. Review the current folders and try again.',
      invalid: 'That folder cannot be used. Choose a separate folder that neither contains nor sits inside another saved source folder or the private hub.',
      duplicate: 'That source folder is already saved in this hub.',
      limit: 'Adding this folder would exceed a supported catalogue size or source-folder limit. A hub supports up to 256 saved source folders.',
      'source-unavailable': 'The folder is unavailable. Check that its drive is connected and access is allowed, then try again.',
      busy: 'The hub is busy. Choose Add folder to try again.',
    };
    sourcesStatus.textContent = typeof result?.status === 'string' && Object.hasOwn(messages, result.status)
      ? messages[result.status] : 'The source folder could not be added. Review the current folders and try again, or lock the hub.';
    if (!sourceListReady) { sourcesStatus.textContent += ' Choose Refresh to check the saved folders again.'; }
    protectionPending = '';
    sourceCancelling = false;
    renderSources();
    updateEditor();
    (sourceAdd.disabled ? sourcesRefresh : sourceAdd).focus({ preventScroll: true });
  }

  async function changeSourceLocation(item) {
    if (locked || protectionPending || sourcesPanel.hidden || !api?.relocateSource || !sourceItems.includes(item)) { return; }
    if (dirty() || editorComposition.size || conflict) {
      sourcesStatus.textContent = 'Save or discard your video notes, tags and rating before changing a source location.';
      return;
    }
    if (protectionBlocked()) { return; }
    const epoch = ++sourceEpoch;
    protectionPending = 'source-relocate';
    sourceCancelling = false;
    sourcesStatus.textContent = 'Choose the folder’s new location. The folder will be checked before you confirm its saved location.';
    stopVideo();
    play.hidden = !clipUrl;
    updateEditor();
    let result;
    try { result = await api.relocateSource(item.id); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    // A save already admitted can finish after cancellation. Refresh authoritative
    // state for every outcome; old catalogue selection IDs must not be reused.
    sourceItems = [];
    sourceListReady = false;
    sourcesList.replaceChildren();
    closeDetails();
    await loadPage(offset, 0, undefined, true);
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    let refreshed;
    try { refreshed = await api.sources(); }
    catch { refreshed = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    sourceListReady = validSourceList(refreshed);
    sourceItems = sourceListReady ? refreshed.items.map(sourceItem) : [];
    const messages = {
      relocated: 'Source location saved. Connect the folder to regenerate previews.',
      cancelled: 'Location change cancelled. Check the saved folders; a save already in progress may finish.',
      conflict: 'The catalogue changed before the location could be saved. Review the current folders and try again.',
      invalid: 'That location cannot be used. Choose a separate folder that neither contains nor sits inside a saved source folder. This source also needs videos with recorded file sizes.',
      'source-unavailable': 'The folder could not be verified. Check that every video is present with the same names, subfolders and sizes, and that access is allowed.',
      busy: 'The hub is busy. Choose Change location to try again.',
    };
    sourcesStatus.textContent = typeof result?.status === 'string' && Object.hasOwn(messages, result.status)
      ? messages[result.status] : 'The source location could not be updated. Review the current folders and try again, or lock the hub.';
    if (!validSourceList(refreshed)) { sourcesStatus.textContent += ' Choose Refresh to check the saved folders again.'; }
    protectionPending = '';
    sourceCancelling = false;
    renderSources();
    updateEditor();
    const changedRow = sourceItems.findIndex(current => current.title === item.title);
    (sourcesList.children[changedRow]?.querySelector('button') || sourcesRefresh).focus({ preventScroll: true });
  }

  function importCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return; }
    const { total, processed, imported, duplicates, failed } = value;
    if (![total, processed, imported, duplicates, failed].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 100)
      || total < 1 || processed !== imported + duplicates + failed || processed > total) { return; }
    return { total, processed, imported, duplicates, failed };
  }

  function importSummary(value) {
    const counts = importCounts(value);
    if (value?.status !== 'finished' || !counts || !['completed', 'cancelled', 'stopped'].includes(value.outcome)
      || (value.outcome === 'completed' && counts.processed !== counts.total)) { return ''; }
    const label = value.outcome === 'completed' ? 'Import complete.' : value.outcome === 'cancelled' ? 'Import cancelled.' : 'Import stopped.';
    const summary = `${label} ${counts.imported} added, ${counts.duplicates} already in the catalogue, ${counts.failed} failed, ${counts.total - counts.processed} not processed.`;
    return summary + (value.outcome === 'completed' ? ' Original videos are unchanged.'
      : ' Saved videos remain in the catalogue; an import already being saved may finish. Review the catalogue.');
  }

  function clearImportProgress() {
    importProgressEpoch++;
    clearTimeout(importProgressTimer);
    importProgressTimer = undefined;
  }

  function startImportProgress(sourceRequestEpoch) {
    clearImportProgress();
    if (!api?.importProgress) { return; }
    const epoch = importProgressEpoch;
    const current = () => !locked && epoch === importProgressEpoch && sourceRequestEpoch === sourceEpoch
      && protectionPending === 'source-import' && !sourceCancelling && !sourcesPanel.hidden;
    const poll = async () => {
      importProgressTimer = undefined;
      if (!current()) { return; }
      let result;
      try { result = await api.importProgress(); } catch { /* Keep the last fixed status until completion. */ }
      if (!current()) { return; }
      const counts = importCounts(result);
      if (result?.status === 'running' && counts) {
        sourcesStatus.textContent = `Importing videos: ${counts.processed} of ${counts.total} processed. ${counts.imported} added, ${counts.duplicates} already in the catalogue, ${counts.failed} failed.`;
      }
      importProgressTimer = setTimeout(poll, 500);
    };
    importProgressTimer = setTimeout(poll, 500);
  }

  async function importSourceVideo(item, scan = false) {
    const start = scan ? api?.scanSource : api?.importVideo;
    if (locked || protectionPending || sourcesPanel.hidden || !start || !api?.cancelImport
      || !sourceItems.includes(item)) { return; }
    if (dirty() || editorComposition.size || conflict) {
      sourcesStatus.textContent = 'Save or discard your video notes, tags and rating before adding videos.';
      return;
    }
    if (protectionBlocked()) { return; }
    const epoch = ++sourceEpoch;
    protectionPending = 'source-import';
    sourceImportMode = scan ? 'scan' : 'selection';
    sourceCancelling = false;
    clearTimeout(searchTimer);
    sourcesStatus.textContent = scan ? 'Finding new videos… Review the import before it begins.'
      : 'Choose up to 100 videos inside this source folder. Each video’s previews will be encrypted before it is added to the catalogue.';
    stopVideo();
    play.hidden = !clipUrl;
    updateEditor();
    importCancel.focus();
    startImportProgress(epoch);
    let result;
    try { result = await start(item.id); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    clearImportProgress();
    // Cancellation can race catalogue publication. Reload authoritative state
    // even after a failure; never keep stale selection IDs or claim rollback.
    sourceItems = [];
    sourceListReady = false;
    sourcesList.replaceChildren();
    closeDetails();
    await loadPage(offset, 0, undefined, true);
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    let refreshed;
    try { refreshed = await api.sources(); }
    catch { refreshed = { status: 'unavailable' }; }
    if (locked || epoch !== sourceEpoch || sourcesPanel.hidden) { return; }
    sourceListReady = validSourceList(refreshed);
    sourceItems = sourceListReady ? refreshed.items.map(sourceItem) : [];
    const messages = {
      cancelled: `${scan ? 'Scan or import' : 'Import'} cancelled. Saved videos remain in the catalogue; an import already being saved may finish. Review the catalogue.`,
      conflict: 'The catalogue changed before the video could be added. Review the current catalogue and try again.',
      invalid: 'The selection could not be imported. Choose supported videos inside this source folder.',
      limit: 'Choose no more than 100 videos at a time. No videos from this selection were imported.',
      'nothing-new': 'No new videos found.',
      'scan-limit': 'The folder scan reached its safety limit. Choose Add videos… to select files.',
      duplicate: 'This video is already in the catalogue.',
      'source-unavailable': 'The video or source folder is unavailable. Check that its drive is connected and access is allowed, then try again.',
      'wrong-folder': `That is not the saved source folder. Choose ${scan ? 'Find new videos' : 'Add videos'} again and select the saved folder when prompted.`,
      busy: `The hub is busy. Choose ${scan ? 'Find new videos' : 'Add videos'} to try again.`,
    };
    sourcesStatus.textContent = importSummary(result) || (typeof result?.status === 'string' && Object.hasOwn(messages, result.status)
      ? messages[result.status] : 'The videos could not be added. Review the current catalogue and try again, or lock the hub.');
    if (!validSourceList(refreshed)) { sourcesStatus.textContent += ' Choose Refresh to check the saved folders again.'; }
    protectionPending = '';
    sourceCancelling = false;
    renderSources();
    updateEditor();
    const changedRow = sourceItems.findIndex(current => current.title === item.title);
    sourceImportMode = '';
    (sourcesList.children[changedRow]?.querySelector(scan ? '[data-action="scan-source"]' : '[data-action="import-video"]') || sourcesRefresh).focus({ preventScroll: true });
  }

  function cancelVideoImport() {
    if (locked || protectionPending !== 'source-import' || sourceCancelling || !api?.cancelImport) { return; }
    sourceCancelling = true;
    clearImportProgress();
    sourcesStatus.textContent = sourceImportMode === 'scan'
      ? 'Stopping the scan or import. Close any open confirmation or folder dialog. An import already being saved may finish.'
      : 'Stopping the import. Close any open dialog. An import already being saved may finish.';
    updateSourceControls();
    try { api.cancelImport(); }
    catch { sourcesStatus.textContent = sourceImportMode === 'scan'
      ? 'The scan or import could not be cancelled. Close any open confirmation or folder dialog, or lock the hub.'
      : 'The import could not be cancelled. Close any open dialog, or lock the hub.'; }
  }

  function cancelSourceConnection() {
    if (locked || !['source-connect', 'source-relocate', 'source-add', 'source-check'].includes(protectionPending) || sourceCancelling || !api?.cancelSourceConnection) { return; }
    sourceCancelling = true;
    const relocating = protectionPending === 'source-relocate';
    const adding = protectionPending === 'source-add';
    const checking = protectionPending === 'source-check';
    sourcesStatus.textContent = checking
      ? 'Cancelling the check. Close any open folder picker. No results will be retained.'
      : adding
      ? 'Cancelling the new source folder. Close any open dialog. A save already in progress may finish.'
      : relocating
      ? 'Cancelling the location change. Close any open dialog. A save already in progress may finish.'
      : 'Cancelling connection. Close the folder picker if it is still open, or lock the hub.';
    updateSourceControls();
    try { api.cancelSourceConnection(); }
    catch { sourcesStatus.textContent = checking
      ? 'The check could not be cancelled. Close any open folder picker, or lock the hub.'
      : adding
      ? 'Adding the folder could not be cancelled. Close any open dialog, or lock the hub.'
      : relocating
      ? 'The location change could not be cancelled. Close any open dialog, or lock the hub.'
      : 'The connection could not be cancelled. Close the folder picker, or lock the hub.'; }
  }

  function canNavigate() {
    if (locked) { return false; }
    if (protectionPending) { return false; }
    if (regenerating) {
      generationStatus.textContent = choosingThumbnail
        ? (cancelling ? 'Stopping thumbnail selection. Please wait, or lock the hub.' : 'Choosing a thumbnail. Cancel or wait before leaving this video.')
        : refreshingVideo
        ? (cancelling ? 'Stopping video refresh. Please wait, or lock the hub.' : 'Refreshing video. Cancel or wait before leaving this video.')
        : (cancelling ? 'Stopping regeneration. Please wait, or lock the hub.'
          : 'Regenerating previews. Cancel or wait before leaving this video.');
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

  function browseProtectionDraft() {
    return savedProtection !== undefined && (protectionSelect.value !== String(savedProtection)
      || historySelect.value !== (savedPlaybackHistory ? 'on' : 'off'));
  }

  function restoreBrowseControls() {
    collectionControl.value = collection;
    sortControl.value = sort;
    directionControl.setAttribute('data-direction', direction);
    directionControl.textContent = direction === 'asc' ? '↑ Ascending' : '↓ Descending';
    directionControl.setAttribute('aria-label', direction === 'asc'
      ? 'Sort ascending; activate for descending' : 'Sort descending; activate for ascending');
  }

  function updateBrowseControls() {
    updateRefreshVideo();
    const blocked = locked || !api || saving || reloading || regenerating || !!protectionPending
      || dirty() || editorComposition.size > 0 || composing || browseProtectionDraft();
    collectionControl.disabled = blocked;
    sortControl.disabled = blocked;
    directionControl.disabled = blocked;
  }

  function changeBrowseControl(kind) {
    const nextCollection = collectionControl.value;
    const nextSort = sortControl.value;
    if (!canNavigate() || composing || browseProtectionDraft()) {
      restoreBrowseControls();
      if (!locked && browseProtectionDraft()) {
        protectionStatus.textContent = 'Save your protection settings, or restore their saved values, before changing the catalogue view.';
      }
      return;
    }
    if (!collectionValues.includes(nextCollection) || !sortValues.includes(nextSort)) { restoreBrowseControls(); return; }
    if (kind === 'collection') {
      collection = nextCollection;
      if (collection === 'recent') { sort = 'last-played'; direction = 'desc'; }
    } else if (kind === 'sort') {
      sort = nextSort;
      direction = ['catalogue', 'name'].includes(sort) ? 'asc' : 'desc';
    } else { direction = direction === 'asc' ? 'desc' : 'asc'; }
    restoreBrowseControls();
    clearTimeout(searchTimer);
    // Use the visible search text, including an outstanding debounce, with the
    // new collection/order in one request. loadPage retires images and replies.
    void loadPage(0);
  }

  function restoreSearch() {
    search.value = query;
    if (protectionPending) {
      (originalPending || protectionPending === 'playback-history' ? stopPlaybackButton : sourceOperationPending() ? sourcesPanel : protectionPanel).focus({ preventScroll: true });
      return;
    }
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

  function ratingChoice(item) {
    // Display-only projection can hide nonstandard legacy stars. Preserve them
    // unless the user explicitly chooses an integer rating for this save.
    return Number.isInteger(item?.rating) && item.rating >= 0 && item.rating <= 5
      && item.favourite === (item.rating === 5) ? String(item.rating) : '';
  }

  function renderRatingDraft() {
    ratingInput.value = ratingTouched ? String(draftRating) : ratingChoice(selectedDetail);
    ratingExisting.hidden = ratingInput.value !== '';
  }

  function applyMetadata(item) {
    closeFilmstrip();
    selectedDetail = { ...item, tags: Array.isArray(item.tags) ? item.tags.filter(tag => typeof tag === 'string') : [] };
    draftTags = [...selectedDetail.tags];
    ratingTouched = false;
    draftRating = undefined;
    renderRatingDraft();
    tagDraft.value = '';
    detailsNotes.value = typeof item.notes === 'string' ? item.notes : '';
    conflict = false;
    detailsTitle.textContent = item.title || 'Untitled video';
    detailsFacts.textContent = `${duration(item.duration)} · ${dimensions(item)}`;
    detailsRating.textContent = Number.isFinite(item.rating) && item.rating > 0 && item.rating <= 5
      ? `Saved: ${item.rating} / 5${item.favourite ? ' · Favourite' : ''}` : 'Saved: Unrated';
    shortened.hidden = item.truncated !== true;
    detailsContent.hidden = false;
    editFooter.hidden = false;
    retryDetails.hidden = true;
    retryDetails.textContent = 'Try again';
    renderTags();
    editStatus.textContent = editable() ? 'Changes are saved only when you choose Save changes.' : 'Video details are read-only for this video.';
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
    updatePlaybackControls();
    // Recreate thumbnail elements and retire every old source before loading
    // the same no-store media routes for the newly published encrypted set.
    void loadPage(offset, 0, undefined, true);
  }

  async function setCustomThumbnail() {
    const reason = thumbnailBlockedMessage();
    if (reason) { generationStatus.textContent = reason; return; }
    const id = selectedId, epoch = detailEpoch, revision = selectedDetail.revision;
    const current = () => !locked && epoch === detailEpoch && id === selectedId;
    regenerating = true;
    choosingThumbnail = true;
    cancelling = false;
    stopVideo();
    generationStatus.textContent = 'Choose a JPEG or PNG image. Its resized thumbnail will be encrypted in this hub.';
    updateEditor();
    let result;
    try { result = await api.setCustomThumbnail({ id, revision }); }
    catch { result = { status: 'unavailable' }; }
    if (!current()) { return; }
    const completed = result?.status === 'updated' && result.item?.id === id && result.item.revision === revision;
    let saved = completed ? result.item : undefined;
    if (!completed) {
      // Cancellation may follow publication. Wait for the native operation to
      // drain before reading the saved route, without replacing editor drafts.
      cancelling = true;
      generationStatus.textContent = 'Loading the saved thumbnail…';
      updateEditor();
      try {
        const latest = await api.detail(id);
        if (latest?.status === 'ready' && latest.item?.id === id) { saved = latest.item; }
      } catch { /* The fixed failure message below contains no native details. */ }
      if (!current()) { return; }
    }
    regenerating = false;
    choosingThumbnail = false;
    cancelling = false;
    if (saved?.revision === revision && previewUrl(saved.thumbnailUrl, 'thumbnail')) {
      selectedDetail.thumbnailUrl = saved.thumbnailUrl;
      // Preserve notes, tags, rating, and all other preview routes. The grid
      // replaces decoded thumbnail elements while keeping this editor intact.
      void loadPage(offset, 0, undefined, true);
    } else {
      conflict = true;
      retryDetails.hidden = false;
      retryDetails.textContent = 'Reload details';
    }
    generationStatus.textContent = conflict
      ? 'The saved video details could not be confirmed. Your edits are still here. Discard and reload before making another change.'
      : completed ? 'Thumbnail updated.'
        : result?.status === 'cancelled' ? 'Thumbnail selection stopped. Saved thumbnail reloaded.'
          : result?.status === 'conflict' ? 'This video changed. Your edits are still here. Discard and reload before choosing a thumbnail.'
            : result?.status === 'invalid' ? 'Use a valid JPEG or PNG image up to 32 MiB and 32 megapixels.'
              : result?.status === 'source-unavailable' ? 'The chosen image is unavailable. Choose it again or select another JPEG or PNG image.'
                : result?.status === 'busy' ? 'The hub is busy. Try choosing a thumbnail again shortly.'
                  : 'The thumbnail could not be updated. Try again or lock the hub.';
    if (result?.status === 'conflict') {
      conflict = true;
      retryDetails.hidden = false;
      retryDetails.textContent = 'Reload details';
    }
    updateEditor();
  }

  async function regeneratePreviews(refresh = false) {
    if (refresh) {
      const reason = refreshVideoBlockedMessage();
      if (reason) { generationStatus.textContent = reason; return; }
    }
    if (locked || regenerating || protectionPending || (!refresh && (selectedDetail?.regenerable !== true || !api?.regenerate)) || !api?.cancelRegeneration) { return; }
    if (!canNavigate()) {
      generationStatus.textContent = 'Save or discard your edits before regenerating previews.';
      return;
    }
    if (conflict) { generationStatus.textContent = 'Reload the saved video details before regenerating previews.'; return; }
    const id = selectedId;
    const epoch = detailEpoch;
    const current = () => !locked && epoch === detailEpoch && id === selectedId;
    regenerating = true;
    refreshingVideo = refresh;
    cancelling = false;
    // Retire the existing decoded poster before the IPC await. Removing and
    // restoring an identical URL in one turn can keep Chromium's old image.
    cancelImages('detail');
    stopVideo();
    posterPlaceholder.hidden = false;
    posterPlaceholder.textContent = refresh ? 'Refreshing video…' : 'Regenerating previews…';
    play.disabled = true;
    generationStatus.textContent = refresh
      ? 'Refreshing technical details and previews. The app may ask you to select the source folder.'
      : 'Regenerating previews. The app may ask you to select the source folder.';
    updateEditor();
    let result;
    try { result = await (refresh ? api.refreshVideo : api.regenerate)({ id, revision: selectedDetail.revision }); }
    catch { result = { status: 'unavailable' }; }
    if (!current()) { return; }
    // Cancellation can race publication. Reload both metadata and media after
    // drainage rather than claiming the previous preview set was preserved.
    const completed = result?.status === (refresh ? 'refreshed' : 'generated')
      && result.item?.id === id && typeof result.item.title === 'string';
    let reloaded;
    if (result?.status === 'cancelled' || (refresh && !completed)) {
      cancelling = true;
      generationStatus.textContent = refresh ? 'Loading the latest saved details and previews…' : 'Regeneration stopped. Refreshing previews…';
      updateEditor();
      try { reloaded = await api.detail(id); }
      catch { reloaded = { status: 'unavailable' }; }
      if (!current()) { return; }
    }
    regenerating = false;
    refreshingVideo = false;
    choosingThumbnail = false;
    cancelling = false;
    play.disabled = false;
    if (refresh && !completed) {
      if (reloaded?.status !== 'ready' || reloaded.item?.id !== id || typeof reloaded.item.title !== 'string') {
        // The operation may have published or retired this row. Never restore
        // stale technical details or previews when their authority is uncertain.
        closeDetails();
        const clearedEpoch = detailEpoch;
        await loadPage(offset);
        if (!locked && !selectedId && detailEpoch === clearedEpoch + 1) {
          galleryStatus.textContent = 'Video refresh finished without current details. Select the video again to check its saved details and previews.';
        }
        return;
      }
      applyMetadata(reloaded.item);
    }
    if (completed) {
      applyMetadata(result.item);
      refreshPreviews(result.item);
      generationStatus.textContent = refresh ? 'Video refreshed.' : 'Previews regenerated.';
    } else if (result?.status === 'cancelled') {
      if (reloaded?.status === 'ready' && reloaded.item?.id === id && typeof reloaded.item.title === 'string') {
        applyMetadata(reloaded.item);
        refreshPreviews(reloaded.item);
        generationStatus.textContent = refresh ? 'Video refresh stopped. Saved details and previews reloaded.' : 'Regeneration stopped. Previews refreshed.';
      } else {
        refreshPreviews(selectedDetail);
        generationStatus.textContent = refresh ? 'Video refresh stopped. Reopen this video to check its latest details and previews.'
          : 'Regeneration stopped. Reopen this video to check its latest previews.';
      }
    } else if (result?.status === 'conflict') {
      refreshPreviews(selectedDetail);
      conflict = true;
      retryDetails.hidden = false;
      retryDetails.textContent = 'Reload details';
      generationStatus.textContent = refresh ? 'This video changed. Reload its saved details before refreshing it.'
        : 'This video changed. Reload its saved details before regenerating previews.';
    } else {
      refreshPreviews(selectedDetail);
      generationStatus.textContent = result?.status === 'source-unavailable'
        ? 'The source video is unavailable. Connect its folder and try again.'
        : result?.status === 'wrong-folder' ? 'That folder does not match this video’s source. Try again and choose its source folder.'
          : result?.status === 'busy' ? (refresh ? 'The hub is busy. Try refreshing this video again shortly.' : 'The hub is busy. Try regenerating previews again shortly.')
            : refresh ? 'This video could not be refreshed. Try again or lock the hub.' : 'Previews could not be regenerated. Try again or lock the hub.';
    }
    updateEditor();
  }

  function cancelRegeneration() {
    if (locked || !regenerating || cancelling) { return; }
    cancelling = true;
    generationStatus.textContent = choosingThumbnail ? 'Stopping thumbnail selection. Please wait, or lock the hub.' : refreshingVideo ? 'Stopping video refresh. Please wait, or lock the hub.' : 'Stopping regeneration. Please wait, or lock the hub.';
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
    const request = { id, revision: selectedDetail.revision, notes: detailsNotes.value, tags: [...draftTags],
      ...(ratingTouched ? { rating: draftRating } : {}) };
    // Catalogue writes retire main-process source authority. Clear the player
    // first so buffered originals cannot outlive that transition in the view.
    if (originalActive) { stopVideo(); }
    saving = true;
    editStatus.textContent = 'Saving encrypted video details…';
    updateEditor();
    let result;
    try { result = await api.save(request); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== detailEpoch || id !== selectedId) { return; }
    saving = false;
    if (result?.status === 'saved' && result.item?.id === id && typeof result.item.title === 'string') {
      applyMetadata(result.item);
      editStatus.textContent = 'Changes saved.';
      // Tags and ratings can change collections, ordering and search results. Refresh their projection
      // while retaining the selected detail view and any playing preview.
      void loadPage(offset, 0, undefined, true);
      return;
    }
    conflict = result?.status === 'conflict';
    editStatus.textContent = conflict ? 'These video details changed elsewhere. Your edits are still here. Choose Discard and reload to load the latest saved version.'
      : result?.status === 'invalid' ? 'Changes could not be saved. Check your notes, tag names and rating; your edits are still here.'
        : result?.status === 'busy' ? 'The hub is busy. Your edits are still here; try saving again.'
          : 'Changes could not be saved. Your edits are still here; try again or lock the hub.';
    updateEditor();
  }

  async function discardChanges() {
    if (locked || saving || reloading || regenerating || protectionPending || !selectedDetail || (!dirty() && !conflict)) { return; }
    if (editorComposition.size) { editStatus.textContent = 'Finish entering text before discarding.'; return; }
    const id = selectedId;
    const epoch = detailEpoch;
    if (originalActive) { stopVideo(); }
    reloading = true;
    editStatus.textContent = 'Loading the latest saved video details…';
    updateEditor();
    let result;
    try { result = await api.detail(id); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== detailEpoch || id !== selectedId) { return; }
    reloading = false;
    if (result?.status === 'ready' && result.item?.id === id && typeof result.item.title === 'string') {
      applyMetadata(result.item);
      editStatus.textContent = 'Latest saved video details loaded.';
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

  function updatePlaybackControls() {
    const busy = locked || saving || reloading || detailLoading || regenerating || !!protectionPending;
    const playing = !!video.getAttribute('src');
    play.hidden = !clipUrl || playing || originalPending;
    play.disabled = busy || playing;
    playOriginalButton.hidden = selectedDetail?.playable !== true || !api?.playOriginal || !api?.stopOriginal
      || !/^[a-f0-9]{32}$/.test(selectedDetail?.revision) || playing || originalPending;
    playOriginalButton.disabled = busy || playing || conflict;
    stopPlaybackButton.hidden = !playing && !originalPending;
    stopPlaybackButton.disabled = locked || originalCancelling;
    stopPlaybackButton.textContent = originalPending ? (originalCancelling ? 'Cancelling…' : 'Cancel')
      : originalActive ? 'Stop video' : 'Stop preview';
  }

  function stopVideo() {
    playEpoch++;
    if (originalPending || originalActive) {
      try { api?.stopOriginal?.(); } catch { /* Lock remains available if the bridge has gone away. */ }
    }
    originalPending = false;
    originalActive = false;
    originalCancelling = false;
    playbackHistoryNotice = '';
    if (protectionPending === 'original') { protectionPending = ''; }
    playbackStatus.textContent = '';
    // Returning from fullscreen is presentation cleanup only. Revoke and clear
    // media immediately even if Chromium cannot finish the transition.
    if (document.fullscreenElement === video) {
      try { void Promise.resolve(document.exitFullscreen()).catch(() => {}); } catch { /* The window may already be closing. */ }
    }
    video.onloadeddata = null;
    video.onplaying = null;
    video.onerror = null;
    video.onended = null;
    video.pause();
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    video.hidden = true;
    updatePlaybackControls();
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
    historyRefreshId = '';
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
    ratingTouched = false;
    draftRating = undefined;
    ratingInput.value = '';
    ratingExisting.hidden = true;
    selectedDetail = undefined;
    detailLoading = false;
    saving = false;
    reloading = false;
    regenerating = false;
    refreshingVideo = false;
    choosingThumbnail = false;
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
    if (originalActive) { stopVideo(); updateEditor(); }
    let result;
    try { result = await api.list({ query, offset, collection, sort, direction }); }
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
      if (query) { showEmpty('No matching videos', 'Try a different video title or tag, or choose another collection.'); }
      else if (collection === 'favourites') { showEmpty('No favourites yet', 'This private catalogue has no videos marked as favourites. Choose All videos to browse the catalogue.'); }
      else if (collection === 'recent') { showEmpty('No recently played videos', 'This collection uses saved catalogue history. Turn on Record playback history in Protection to update it when playing original videos.'); }
      else { showEmpty('No videos yet', 'This private catalogue has no videos to display.'); }
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
    updatePlaybackControls();
  }

  async function playPreview() {
    if (locked || regenerating || protectionPending || !clipUrl || !selectedId || play.disabled) { return; }
    stopVideo();
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
    video.onended = () => { if (current() && !video.loop) { stopVideo(); updateEditor(); } };
    video.src = clipUrl;
    updatePlaybackControls();
    try {
      await video.play();
      if (current()) { video.hidden = false; play.hidden = true; }
      // A pending play promise can settle after its source was retired. Pause
      // that work again, while allowing a newer selected preview to keep playing.
      else if (locked || !video.getAttribute('src')) { video.pause(); }
    } catch { failed(); }
  }

  async function playOriginal() {
    if (locked || protectionBlocked() || protectionPending || conflict || playOriginalButton.disabled
      || selectedDetail?.playable !== true || !api?.playOriginal || !api?.stopOriginal
      || !/^[a-f0-9]{32}$/.test(selectedDetail?.revision)) { return; }
    stopVideo();
    const epoch = playEpoch;
    const selected = selectedId;
    const current = () => !locked && epoch === playEpoch && selected === selectedId;
    originalPending = true;
    protectionPending = 'original';
    playbackStatus.textContent = 'Opening video. Choose its saved source folder if asked.';
    updateEditor();
    let result;
    try { result = await api.playOriginal({ id: selected, revision: selectedDetail.revision }); }
    catch { result = { status: 'unavailable' }; }
    // A retired request must not revoke a newer playback capability.
    if (!current()) { return; }
    const wasCancelled = originalCancelling;
    if (wasCancelled || result?.status !== 'ready' || typeof result.url !== 'string'
      || /^theatrum:\/\/app\/original\/[a-f0-9]{64}$/.exec(result.url)?.[0] !== result.url) {
      stopVideo();
      const messages = {
        cancelled: 'Opening video cancelled.',
        conflict: 'This video changed. Reload its saved details before playing it.',
        'source-unavailable': 'The source video is unavailable. Connect its folder and try again.',
        'wrong-folder': 'That is not the saved source folder. Choose Play video and select its original location.',
        unsupported: 'This video format cannot be played in the private hub. Its preview may still be available.',
        busy: 'The hub is busy. Try playing this video again shortly.',
      };
      playbackStatus.textContent = wasCancelled ? messages.cancelled
        : typeof result?.status === 'string' && Object.hasOwn(messages, result.status) ? messages[result.status]
          : 'This video could not be opened. Check its source folder and try again, or lock the hub.';
      updateEditor();
      return;
    }
    originalPending = false;
    protectionPending = '';
    originalActive = true;
    video.preload = 'none';
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    const failed = () => {
      if (!current()) { return; }
      stopVideo();
      playbackStatus.textContent = 'This video could not be played. Its format or codec may be unsupported, or the source may be unavailable. Its preview may still be available.';
      updateEditor();
    };
    const show = () => {
      if (!current()) { return; }
      video.hidden = false;
      playbackStatus.textContent = playbackHistoryNotice || 'Playing original video.';
      updatePlaybackControls();
    };
    video.onerror = failed;
    video.onloadeddata = show;
    let acknowledged = false;
    const selectedEpoch = detailEpoch;
    video.onplaying = event => {
      if (event?.isTrusted !== true || acknowledged || !current() || !originalActive
        || video.getAttribute('src') !== result.url || !api?.ackOriginalPlayback) { return; }
      acknowledged = true;
      void recordOriginalPlayback(result.url, selected, selectedEpoch);
    };
    video.onended = () => {
      if (current() && !video.loop) { stopVideo(); updateEditor(); refreshRecordedHistory(); }
    };
    video.src = result.url;
    playbackStatus.textContent = 'Loading original video…';
    updateEditor();
    try {
      await video.play();
      if (current()) { show(); }
      else if (locked || !video.getAttribute('src')) { video.pause(); }
    } catch { failed(); }
  }

  async function recordOriginalPlayback(url, id, epoch) {
    // Serialize catalogue operations while the main process records this one
    // capability. Stop and Lock remain available and revoke playback immediately.
    protectionPending = 'playback-history';
    updateEditor();
    let result;
    try { result = await api.ackOriginalPlayback(url); }
    catch { result = { status: 'unavailable' }; }
    if (locked || epoch !== detailEpoch || id !== selectedId) { return; }
    if (protectionPending === 'playback-history') { protectionPending = ''; }
    if (result?.status === 'recorded') {
      // History-only writes preserve the public edit revision. Never apply a
      // metadata snapshot here: the current note, tag and rating drafts stay put.
      historyRefreshId = id;
      historyRefreshEpoch = epoch;
    } else if (!['disabled', 'ignored'].includes(result?.status)) {
      playbackHistoryNotice = result?.status === 'conflict'
        ? 'Playback history could not be saved because this video changed. Your edits are still here.'
        : 'Playback history could not be saved. Your video and unsaved edits are unchanged.';
      playbackStatus.textContent = playbackHistoryNotice;
    }
    updateEditor();
    refreshRecordedHistory();
  }

  function refreshRecordedHistory() {
    if (!historyRefreshId || locked || originalActive || originalPending || video.getAttribute('src')
      || protectionPending || saving || reloading || regenerating || listLoading) { return; }
    const matches = historyRefreshId === selectedId && historyRefreshEpoch === detailEpoch;
    historyRefreshId = '';
    if (matches) { void loadPage(offset, 0, undefined, true); }
  }

  function stopPlayback() {
    if (locked) { return; }
    if (originalPending) {
      if (originalCancelling) { return; }
      originalCancelling = true;
      playbackStatus.textContent = 'Cancelling. Close the folder picker if it is still open, or lock the hub.';
      updatePlaybackControls();
      try { api?.stopOriginal?.(); }
      catch { playbackStatus.textContent = 'Cancellation could not be requested. Close the folder picker, or lock the hub.'; }
      return;
    }
    const wasOriginal = originalActive;
    stopVideo();
    updateEditor();
    (wasOriginal ? playOriginalButton : play).focus({ preventScroll: true });
    refreshRecordedHistory();
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
    sourceEpoch++;
    sourceCancelling = false;
    sourceImportMode = '';
    closeSources(false);
    sourcesList.setAttribute('aria-busy', 'false');
    savedProtection = undefined;
    protectionSelect.value = '';
    savedPlaybackHistory = undefined;
    historySelect.value = '';
    playbackResetEpoch++;
    playbackResetStatus.textContent = '';
    playbackResetSection.setAttribute('aria-busy', 'false');
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
    collection = 'all';
    sort = 'catalogue';
    direction = 'asc';
    restoreBrowseControls();
    updateBrowseControls();
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
  sourcesToggle.addEventListener('click', () => {
    if (sourcesPanel.hidden) { void loadSources(); }
    else { closeSources(); }
  });
  sourceAdd.addEventListener('click', () => { void addSourceFolder(); });
  sourcesRefresh.addEventListener('click', () => { void loadSources(); });
  sourcesClose.addEventListener('click', () => { closeSources(); });
  sourceCancel.addEventListener('click', cancelSourceConnection);
  importCancel.addEventListener('click', cancelVideoImport);
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
  passwordResume.addEventListener('click', () => { void submitPasswordChange(true); });
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
  resetLastPlayed.addEventListener('click', () => { void resetPlaybackHistory('lastPlayed'); });
  resetTimesPlayed.addEventListener('click', () => { void resetPlaybackHistory('timesPlayed'); });
  for (const control of [protectionSelect, historySelect]) {
    control.addEventListener('change', () => {
      if (locked || protectionPending || savedProtection === undefined) { return; }
      protectionStatus.textContent = browseProtectionDraft() ? 'Choose Save settings to apply this change.' : 'No unsaved setting changes.';
      updateProtection();
    });
  }
  search.addEventListener('compositionstart', () => { composing = true; clearTimeout(searchTimer); updateBrowseControls(); });
  search.addEventListener('compositionend', () => { composing = false; updateBrowseControls(); scheduleSearch(); });
  function scheduleSearch() {
    if (locked || composing) { return; }
    clearTimeout(searchTimer);
    if (!canNavigate()) { restoreSearch(); return; }
    searchTimer = setTimeout(() => { void loadPage(0); }, 220);
  }
  search.addEventListener('input', scheduleSearch);
  collectionControl.addEventListener('change', () => { changeBrowseControl('collection'); });
  sortControl.addEventListener('change', () => { changeBrowseControl('sort'); });
  directionControl.addEventListener('click', () => { changeBrowseControl('direction'); });
  previous.addEventListener('click', () => { if (!previous.disabled) { void loadPage(Math.max(0, offset - PAGE_SIZE)); } });
  next.addEventListener('click', () => { if (!next.disabled) { void loadPage(offset + PAGE_SIZE); } });
  retryGallery.addEventListener('click', () => { void loadPage(offset); });
  retryDetails.addEventListener('click', () => {
    if (selectedDetail && conflict) { void discardChanges(); }
    else if (selectedId) { void showDetails(selectedId, selectionOrigin); }
  });
  byId('close-details').addEventListener('click', () => { if (canNavigate()) { closeDetails(true); } });
  ratingInput.addEventListener('change', () => {
    if (locked || saving || reloading || regenerating || protectionPending || editorComposition.size || browseProtectionDraft() || !editable()) {
      renderRatingDraft(); return;
    }
    if (!['0', '1', '2', '3', '4', '5'].includes(ratingInput.value)) { renderRatingDraft(); return; }
    draftRating = Number(ratingInput.value);
    ratingTouched = true;
    renderRatingDraft();
    editStatus.textContent = conflict ? 'Your edits are still here. Choose Discard and reload to load the latest saved version.' : 'Unsaved changes.';
    updateEditor();
  });
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
  chooseThumbnail.addEventListener('click', () => { void setCustomThumbnail(); });
  refreshVideo.addEventListener('click', () => { void regeneratePreviews(true); });
  regenerate.addEventListener('click', () => { void regeneratePreviews(); });
  cancelGeneration.addEventListener('click', cancelRegeneration);
  play.addEventListener('click', () => { void playPreview(); });
  playOriginalButton.addEventListener('click', () => { void playOriginal(); });
  stopPlaybackButton.addEventListener('click', stopPlayback);
  filmstripToggle.addEventListener('click', toggleFilmstrip);
  filmstripPrevious.addEventListener('click', () => { scrollFilmstrip(-1); });
  filmstripNext.addEventListener('click', () => { scrollFilmstrip(1); });
  filmstripViewport.addEventListener('scroll', updateFilmstripNavigation);
  window.addEventListener('resize', updateFilmstripNavigation);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) { return; }
    // Let Chromium's player consume Escape to leave fullscreen; keep Details
    // and playback available when the user returns to the gallery.
    if (document.fullscreenElement) { return; }
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) { return; }
    if (!sourcesPanel.hidden) { event.preventDefault(); closeSources(); return; }
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
  restoreBrowseControls();
  updateBrowseControls();
  if (api) { void loadPage(0); }
  else {
    galleryStatus.textContent = '';
    grid.setAttribute('aria-busy', 'false');
    lockState.textContent = 'Unavailable';
    protectionButton.disabled = true;
    sourcesToggle.disabled = true;
    showEmpty('Private hub unavailable', 'Close this window and open the private hub again.');
  }
})();
