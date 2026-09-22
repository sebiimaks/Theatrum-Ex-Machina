'use strict';

(() => {
  const form = document.getElementById('unlock-form');
  const passwordInput = document.getElementById('password');
  const showPassword = document.getElementById('show-password');
  const cancelButton = document.getElementById('cancel');
  const unlockButton = document.getElementById('unlock');
  const touchIdButton = document.getElementById('use-touch-id');
  const touchIdHelp = document.getElementById('touch-id-help');
  const status = document.getElementById('unlock-status');
  let pending = false;
  let cancelled = false;
  let windowFocused = true;
  let pageActive = true;

  function clearPassword() {
    passwordInput.value = '';
    passwordInput.type = 'password';
    showPassword.textContent = 'Show';
    showPassword.setAttribute('aria-label', 'Show password');
    showPassword.setAttribute('aria-pressed', 'false');
  }

  // Count UTF-8 bytes without retaining another copy of the password.
  function isValidPassword(password) {
    let bytes = 0;
    for (let i = 0; i < password.length; i++) {
      const code = password.charCodeAt(i);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = password.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        bytes += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
      else bytes += 3;
      if (bytes > 1024) return false;
    }
    return bytes > 0;
  }

  function setPending(value) {
    pending = value;
    form.setAttribute('aria-busy', String(value));
    passwordInput.disabled = value;
    showPassword.disabled = value;
    unlockButton.disabled = value;
    touchIdButton.disabled = value;
    unlockButton.textContent = value ? 'Unlocking…' : 'Unlock';
  }

  function showError(message) {
    status.dataset.state = 'error';
    status.textContent = message;
    passwordInput.setAttribute('aria-invalid', 'true');
  }

  function cancel() {
    if (cancelled) return;
    const wasPending = pending;
    cancelled = true;
    clearPassword();
    setPending(true);
    unlockButton.textContent = 'Unlock';
    try {
      if (typeof window.privateUnlock?.cancel !== 'function') throw new Error();
      window.privateUnlock.cancel();
    } catch {
      cancelled = false;
      setPending(wasPending);
      showError('Unable to close this prompt. Please close the window.');
    }
  }

  showPassword.addEventListener('click', () => {
    if (pending || cancelled) return;
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    showPassword.textContent = visible ? 'Hide' : 'Show';
    showPassword.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    showPassword.setAttribute('aria-pressed', String(visible));
  });

  passwordInput.addEventListener('input', () => {
    status.textContent = '';
    passwordInput.removeAttribute('aria-invalid');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || cancelled) return;
    let password = passwordInput.value;
    clearPassword();
    if (!isValidPassword(password)) {
      password = '';
      showError('Enter a valid password.');
      passwordInput.focus();
      return;
    }

    setPending(true);
    passwordInput.removeAttribute('aria-invalid');
    status.dataset.state = 'pending';
    status.textContent = 'Unlocking your private hub…';
    try {
      if (typeof window.privateUnlock?.submit !== 'function') throw new Error();
      const result = window.privateUnlock.submit(password);
      password = '';
      const unlocked = await result;
      if (cancelled) return;
      if (unlocked !== true) throw new Error();
      status.textContent = 'Opening private hub…';
    } catch {
      password = '';
      if (cancelled) return;
      unlockButton.textContent = 'Unlock';
      showError('Unable to open this hub. Close this window and try again.');
    } finally {
      password = '';
    }
  });

  touchIdButton.addEventListener('click', async () => {
    if (pending || cancelled || !pageActive || touchIdButton.hidden || !windowFocused || document.hidden) return;
    clearPassword();
    setPending(true);
    status.dataset.state = 'pending';
    status.textContent = 'Continuing with Touch ID…';
    try {
      if (typeof window.privateUnlock?.useTouchId !== 'function') throw new Error();
      const accepted = await window.privateUnlock.useTouchId();
      if (cancelled || !pageActive) return;
      if (accepted !== true) throw new Error();
      status.textContent = 'Follow the Touch ID prompt to unlock your hub.';
    } catch {
      if (cancelled || !pageActive) return;
      showError('Unable to use Touch ID. Close this window and try your hub password.');
    }
  });
  async function checkTouchId() {
    let available = false;
    try {
      available = typeof window.privateUnlock?.touchIdAvailable === 'function'
        && typeof window.privateUnlock?.useTouchId === 'function'
        && await window.privateUnlock.touchIdAvailable() === true;
    } catch { /* Password remains available. */ }
    if (!pageActive || cancelled || pending) return;
    touchIdButton.hidden = !available;
    touchIdHelp.hidden = !available;
  }
  void checkTouchId();
  cancelButton.addEventListener('click', cancel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
  function preventExport(event) {
    event.preventDefault();
    if (event.type !== 'copy' && event.type !== 'cut') { event.stopImmediatePropagation(); }
  }
  for (const name of ['copy', 'cut', 'dragstart', 'drop', 'contextmenu']) {
    document.addEventListener(name, preventExport, true);
  }
  document.addEventListener('paste', event => {
    // The same exact control is allowed while masked or revealed. Chromium
    // handles the paste; application code never reads the clipboard.
    if (event.target === passwordInput && document.activeElement === passwordInput
      && pageActive && windowFocused && !document.hidden && !pending && !cancelled
      && !passwordInput.disabled && !passwordInput.readOnly && !passwordInput.hidden && !form.hidden) { return; }
    preventExport(event);
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearPassword();
  });
  const retirePage = () => { pageActive = false; clearPassword(); };
  window.addEventListener('pagehide', retirePage);
  window.addEventListener('beforeunload', retirePage);
  window.addEventListener('blur', () => { windowFocused = false; clearPassword(); });
  window.addEventListener('focus', () => { windowFocused = true; });
})();
