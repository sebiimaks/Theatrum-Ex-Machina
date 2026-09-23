'use strict';

(() => {
  const form = document.getElementById('conversion-form');
  const credentials = document.getElementById('credentials');
  const passwordInput = document.getElementById('password');
  const confirmationInput = document.getElementById('confirm-password');
  const passwordFields = [passwordInput, confirmationInput];
  const showPassword = document.getElementById('show-password');
  const originalsInput = document.getElementById('acknowledge-originals');
  const missingInput = document.getElementById('allow-missing');
  const cancelButton = document.getElementById('cancel');
  const createButton = document.getElementById('create-copy');
  const status = document.getElementById('conversion-status');
  const progressSection = document.getElementById('progress-section');
  const progress = document.getElementById('conversion-progress');
  const progressLabel = document.getElementById('progress-label');
  const progressCount = document.getElementById('progress-count');
  const missingKinds = ['thumbnail', 'filmstrip', 'clip-poster', 'clip'];
  const phases = ['review', 'selecting', 'scanning', 'copying', 'verifying', 'complete', 'failed'];
  const phaseLabels = {
    selecting: 'Choose a folder for the private copy…',
    scanning: 'Checking the reviewed catalogue and previews…',
    copying: 'Encrypting the catalogue and previews…',
    verifying: 'Verifying the encrypted copy…',
    complete: 'Private copy is ready. Closing setup…',
  };
  const failureMessages = {
    'destination-unavailable': 'The selected folder could not be used. Start again and choose an accessible folder on a connected drive.',
    'destination-exists': 'A private copy already exists at the destination. Start again and choose another folder.',
    'permission-denied': 'Access was denied or a drive is read-only. Check access to the source and destination folders, then start again.',
    'storage-full': 'The destination has insufficient free space or has reached its storage quota. Free some space or choose another drive, then start again.',
    'files-unavailable': 'A required file or folder is no longer available. Reconnect the source and destination drives, then start again.',
    'source-inspection-failed': 'The source catalogue or previews could not be checked. Close this window and reopen the source hub before trying again.',
    'source-changed': 'The source catalogue or previews changed after review. Close this window and start again to review the current hub.',
    'storage-initialization-failed': 'The encrypted storage could not be initialized. Close this window and report this step if it happens again.',
    'catalogue-encryption-failed': 'The catalogue could not be encrypted. Close this window and report this step if it happens again.',
    'preview-copy-failed': 'A preview could not be copied into encrypted storage. Close this window and report this step if it happens again.',
    'verification-failed': 'The encrypted copy could not be verified. Do not use the partial copy. Close this window and report this step if it happens again.',
    'receipt-failed': 'The verified copy could not be marked complete. Close this window and report this step if it happens again.',
    'conversion-failed': 'The private copy could not be completed. Close this window and start again.',
  };
  let reviewReady = false;
  let hasMissing = false;
  let submitted = false;
  let pending = false;
  let terminal = false;
  let cancelled = false;
  let pageActive = true;
  let windowFocused = true;
  let polling = false;
  let pollTimer;
  const composing = new Set();

  function isLive() { return pageActive && !cancelled; }
  function canEdit() {
    return isLive() && reviewReady && !submitted && !terminal && !pending
      && windowFocused && !document.hidden && !form.hidden && !credentials.hidden && !credentials.disabled;
  }
  function clearPasswords() {
    for (const input of passwordFields) { input.value = ''; input.type = 'password'; }
    composing.clear();
    showPassword.textContent = 'Show passwords';
    showPassword.setAttribute('aria-label', 'Show passwords');
    showPassword.setAttribute('aria-pressed', 'false');
  }
  function stopPolling() {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  function setEditable(enabled) {
    credentials.disabled = !enabled;
    for (const input of [...passwordFields, originalsInput, missingInput]) input.disabled = !enabled;
    showPassword.disabled = !enabled;
    createButton.disabled = !enabled;
  }
  function terminalMessage(message, error = false) {
    terminal = true;
    pending = false;
    stopPolling();
    clearPasswords();
    setEditable(false);
    credentials.hidden = true;
    createButton.hidden = true;
    progressSection.hidden = true;
    form.setAttribute('aria-busy', 'false');
    status.dataset.state = error ? 'error' : 'idle';
    status.textContent = message;
    cancelButton.textContent = 'Close';
  }
  function count(value) { return Number.isSafeInteger(value) && value >= 0; }
  function validState(state) {
    const review = state?.review;
    return phases.includes(state?.phase) && count(state.completed) && count(state.total)
      && state.completed <= state.total && review && count(review.videos)
      && count(review.availablePreviews) && count(review.previewBytes)
      && missingKinds.every(kind => count(review.missingPreviews?.[kind]));
  }
  function formatSize(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let unit = 0;
    let value = bytes;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
  }
  function showReview(review) {
    document.getElementById('video-count').textContent = String(review.videos);
    document.getElementById('preview-count').textContent = String(review.availablePreviews);
    document.getElementById('preview-size').textContent = formatSize(review.previewBytes);
    hasMissing = missingKinds.some(kind => review.missingPreviews[kind] > 0);
    for (const kind of missingKinds) {
      document.getElementById(`missing-${kind}`).textContent = String(review.missingPreviews[kind]);
    }
    document.getElementById('review').hidden = false;
    document.getElementById('missing-review').hidden = !hasMissing;
    document.getElementById('missing-consent').hidden = !hasMissing;
  }
  function renderState(state) {
    if (!validState(state)) {
      terminalMessage('This setup is no longer available. Close this window. If copying started, a partial encrypted copy may remain.', true);
      return;
    }
    if (state.phase === 'review') {
      // A review reply already in flight cannot restore an accepted form.
      if (submitted || reviewReady) return;
      showReview(state.review);
      reviewReady = true;
      setEditable(true);
      form.setAttribute('aria-busy', 'false');
      status.textContent = '';
      if (windowFocused && !document.hidden) passwordInput.focus();
      return;
    }
    if (state.phase === 'failed') {
      const message = Object.prototype.hasOwnProperty.call(failureMessages, state.failure)
        ? failureMessages[state.failure] : failureMessages['conversion-failed'];
      terminalMessage(`${message} A partial encrypted copy may remain; the originals are unchanged.`, true);
      return;
    }
    if (state.phase === 'complete') {
      terminalMessage(phaseLabels.complete);
      return;
    }
    pending = true;
    submitted = true;
    clearPasswords();
    setEditable(false);
    credentials.hidden = true;
    createButton.hidden = true;
    progressSection.hidden = false;
    form.setAttribute('aria-busy', 'true');
    progressLabel.textContent = phaseLabels[state.phase];
    if (state.total > 0 && state.phase !== 'selecting') {
      progress.max = state.total;
      progress.value = state.completed;
      progressCount.textContent = `${state.completed} of ${state.total}`;
    } else {
      progress.removeAttribute('value');
      progressCount.textContent = '';
    }
    status.dataset.state = 'pending';
    status.textContent = 'You can cancel while the copy is being prepared. The originals stay in place.';
  }
  async function refreshState() {
    if (!isLive() || terminal || polling) return;
    stopPolling();
    polling = true;
    try {
      if (typeof window.privateConversion?.getState !== 'function') throw new Error();
      const state = await window.privateConversion.getState();
      if (!isLive() || terminal) return;
      renderState(state);
    } catch {
      if (!isLive() || terminal) return;
      terminalMessage('Unable to check this setup. Close this window. If copying started, a partial encrypted copy may remain.', true);
    } finally {
      polling = false;
      if (isLive() && !terminal && pending) pollTimer = setTimeout(refreshState, 400);
    }
  }
  // Count UTF-8 bytes without retaining a second encoding of the password.
  function validPassword(password) {
    let bytes = 0;
    for (let index = 0; index < password.length; index++) {
      const code = password.charCodeAt(index);
      if (code <= 0x7f) bytes++;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = password.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
      else bytes += 3;
      if (bytes > 1024) return false;
    }
    return bytes > 0;
  }
  function showError(message, input) {
    status.dataset.state = 'error';
    status.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
  function cancel() {
    if (!isLive()) return;
    cancelled = true;
    stopPolling();
    clearPasswords();
    setEditable(false);
    cancelButton.disabled = true;
    try {
      if (typeof window.privateConversion?.cancel !== 'function') throw new Error();
      window.privateConversion.cancel();
    } catch {
      status.dataset.state = 'error';
      status.textContent = 'Unable to close this setup. Please close the window.';
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!canEdit() || composing.size > 0) return;
    let password = passwordInput.value;
    const matches = password === confirmationInput.value;
    clearPasswords();
    if (!validPassword(password)) {
      password = '';
      showError('Enter a valid password.', passwordInput);
      return;
    }
    if (!matches) {
      password = '';
      showError('The passwords do not match. Enter both passwords again.', confirmationInput);
      return;
    }
    if (!originalsInput.checked) {
      password = '';
      showError('Confirm that you understand the originals remain unencrypted.', originalsInput);
      return;
    }
    if (hasMissing && !missingInput.checked) {
      password = '';
      showError('Confirm whether to continue without the missing previews.', missingInput);
      return;
    }
    submitted = true;
    pending = true;
    setEditable(false);
    credentials.hidden = true;
    createButton.hidden = true;
    progressSection.hidden = false;
    progressLabel.textContent = phaseLabels.selecting;
    progressCount.textContent = '';
    progress.removeAttribute('value');
    form.setAttribute('aria-busy', 'true');
    status.dataset.state = 'pending';
    status.textContent = 'Choose where to save the private copy in the folder dialog.';
    try {
      if (typeof window.privateConversion?.submit !== 'function') throw new Error();
      const result = window.privateConversion.submit(password, hasMissing && missingInput.checked, originalsInput.checked);
      password = '';
      void refreshState();
      await result;
      // The window can retire before submit replies. Only the state endpoint
      // can report completion or failure; a false reply is not write evidence.
      if (isLive() && !terminal) void refreshState();
    } catch {
      password = '';
      if (isLive() && !terminal) void refreshState();
    } finally {
      password = '';
    }
  });

  showPassword.addEventListener('click', () => {
    if (!canEdit()) return;
    const visible = passwordInput.type === 'password';
    for (const input of passwordFields) input.type = visible ? 'text' : 'password';
    showPassword.textContent = visible ? 'Hide passwords' : 'Show passwords';
    showPassword.setAttribute('aria-label', visible ? 'Hide passwords' : 'Show passwords');
    showPassword.setAttribute('aria-pressed', String(visible));
  });
  for (const input of passwordFields) {
    input.addEventListener('compositionstart', () => { if (canEdit()) composing.add(input); });
    input.addEventListener('compositionend', () => { composing.delete(input); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.isComposing || composing.has(input))) event.preventDefault();
    });
    input.addEventListener('input', () => {
      if (!canEdit()) { clearPasswords(); return; }
      status.textContent = '';
      for (const field of passwordFields) field.removeAttribute('aria-invalid');
    });
  }
  for (const input of [originalsInput, missingInput]) input.addEventListener('change', () => {
    if (!canEdit()) return;
    input.removeAttribute('aria-invalid');
    status.textContent = '';
  });
  cancelButton.addEventListener('click', cancel);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
  });
  function preventExport(event) {
    event.preventDefault();
    if (event.type !== 'copy' && event.type !== 'cut') event.stopImmediatePropagation();
  }
  for (const name of ['copy', 'cut', 'dragstart', 'drop', 'contextmenu']) {
    document.addEventListener(name, preventExport, true);
  }
  document.addEventListener('paste', event => {
    if (passwordFields.includes(event.target) && document.activeElement === event.target && canEdit()
      && !event.target.disabled && !event.target.readOnly && !event.target.hidden) return;
    preventExport(event);
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearPasswords(); });
  const retirePage = () => { pageActive = false; stopPolling(); clearPasswords(); };
  window.addEventListener('pagehide', retirePage);
  window.addEventListener('beforeunload', retirePage);
  window.addEventListener('blur', () => { windowFocused = false; clearPasswords(); });
  window.addEventListener('focus', () => { windowFocused = true; });
  void refreshState();
})();
