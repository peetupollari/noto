(function () {
  const authAPI = window.authAPI;
  const page = String(document.body && document.body.dataset && document.body.dataset.authPage || 'login').toLowerCase();
  const form = document.getElementById('auth-form');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const confirmPasswordInput = document.getElementById('confirm-password');
  const submitButton = document.getElementById('submit-btn');
  const messageEl = document.getElementById('auth-message');
  const skipButton = document.getElementById('skip-btn');

  const minBtn = document.getElementById('min-button');
  const maxBtn = document.getElementById('max-button');
  const closeBtn = document.getElementById('close-button');
  const THEME_MODE_STORAGE_KEY = 'notoThemeMode';
  const APP_SIZE_MODE_STORAGE_KEY = 'notoAppSizeMode';
  const THEME_MODE_VALUES = new Set(['system', 'light', 'dark']);
  const APP_SIZE_MODE_PRESETS = {
    normal: { zoom: 1 },
    smaller: { zoom: 0.92 },
    smallest: { zoom: 0.86 }
  };
  const PENDING_SIGNUP_EMAIL_KEY = 'notoPendingSignupEmail';
  const PENDING_SIGNUP_PASSWORD_KEY = 'notoPendingSignupPassword';
  let systemThemeMediaQuery = null;
  let pendingSignup = null;

  function wireWindowControls() {
    if (!window.electronAPI) return;
    if (minBtn) minBtn.onclick = () => window.electronAPI.minimize();
    if (maxBtn) maxBtn.onclick = () => window.electronAPI.maximize();
    if (closeBtn) closeBtn.onclick = () => window.electronAPI.close();
  }

  function readThemeMode() {
    try {
      const raw = String(window.localStorage.getItem(THEME_MODE_STORAGE_KEY) || '').trim().toLowerCase();
      return THEME_MODE_VALUES.has(raw) ? raw : 'system';
    } catch (error) {
      return 'system';
    }
  }

  function resolveAppliedTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (error) {
      return 'light';
    }
  }

  function applySavedTheme() {
    const root = document.documentElement;
    if (!root) return;
    const themeMode = readThemeMode();
    root.setAttribute('data-theme-mode', themeMode);
    root.setAttribute('data-theme', resolveAppliedTheme(themeMode));
  }

  function handleSystemThemePreferenceChange() {
    if (readThemeMode() === 'system') applySavedTheme();
  }

  function ensureSystemThemePreferenceListener() {
    if (!window.matchMedia) return;
    if (!systemThemeMediaQuery) {
      try {
        systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      } catch (error) {
        systemThemeMediaQuery = null;
      }
    }
    if (!systemThemeMediaQuery) return;
    try {
      if (typeof systemThemeMediaQuery.addEventListener === 'function') {
        systemThemeMediaQuery.addEventListener('change', handleSystemThemePreferenceChange);
      } else if (typeof systemThemeMediaQuery.addListener === 'function') {
        systemThemeMediaQuery.addListener(handleSystemThemePreferenceChange);
      }
    } catch (error) {}
  }

  function readAppSizeMode() {
    try {
      const raw = String(window.localStorage.getItem(APP_SIZE_MODE_STORAGE_KEY) || '').trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(APP_SIZE_MODE_PRESETS, raw) ? raw : 'normal';
    } catch (error) {
      return 'normal';
    }
  }

  function applySavedAppSize() {
    const sizeMode = readAppSizeMode();
    const preset = APP_SIZE_MODE_PRESETS[sizeMode] || APP_SIZE_MODE_PRESETS.normal;
    const root = document.documentElement;
    if (root) root.setAttribute('data-app-size-mode', sizeMode);
    if (!window.electronAPI || typeof window.electronAPI.setZoomFactor !== 'function') return;
    try {
      window.electronAPI.setZoomFactor(preset.zoom);
    } catch (error) {}
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function setMessage(message, type) {
    if (!messageEl) return;
    messageEl.textContent = String(message || '');
    messageEl.classList.toggle('error', type === 'error');
  }

  function setSubmitLabel(label) {
    if (!submitButton) return;
    const safeLabel = String(label || '').trim();
    if (!safeLabel) return;
    submitButton.textContent = safeLabel;
    submitButton.dataset.originalText = safeLabel;
  }

  function setInputsEnabled(enabled) {
    const controls = [emailInput, passwordInput, confirmPasswordInput, submitButton].filter(Boolean);
    controls.forEach((el) => {
      el.disabled = !enabled;
    });
  }

  function setBusy(busy) {
    setInputsEnabled(!busy);
    if (!submitButton) return;
    if (busy) submitButton.dataset.originalText = submitButton.textContent || '';
    const original = submitButton.dataset.originalText || submitButton.textContent || '';
    submitButton.textContent = busy ? 'Please wait...' : original;
  }

  function readPendingSignup() {
    try {
      const email = normalizeEmail(window.localStorage.getItem(PENDING_SIGNUP_EMAIL_KEY));
      const password = String(window.localStorage.getItem(PENDING_SIGNUP_PASSWORD_KEY) || '');
      if (!email || !password) return null;
      return { email, password };
    } catch (error) {
      return null;
    }
  }

  function writePendingSignup(email, password) {
    const safeEmail = normalizeEmail(email);
    const safePassword = String(password || '');
    if (!safeEmail || !safePassword) return;
    pendingSignup = { email: safeEmail, password: safePassword };
    try {
      window.localStorage.setItem(PENDING_SIGNUP_EMAIL_KEY, safeEmail);
      window.localStorage.setItem(PENDING_SIGNUP_PASSWORD_KEY, safePassword);
    } catch (error) {}
  }

  function clearPendingSignup() {
    pendingSignup = null;
    try {
      window.localStorage.removeItem(PENDING_SIGNUP_EMAIL_KEY);
      window.localStorage.removeItem(PENDING_SIGNUP_PASSWORD_KEY);
    } catch (error) {}
  }

  function getPendingSignupMessage() {
    return 'Check your email where a confirmation link was sent. After checking it and confirming your account, click Continue.';
  }

  function enterPendingSignupState(email, password, message) {
    writePendingSignup(email, password);
    setSubmitLabel('Continue');
    setMessage(message || getPendingSignupMessage(), 'info');
  }

  function restorePendingSignupState() {
    if (page !== 'signup') return;
    const stored = readPendingSignup();
    if (!stored) return;
    pendingSignup = stored;
    setSubmitLabel('Continue');
    setMessage(getPendingSignupMessage(), 'info');
  }

  function storePasswordLength(password) {
    const length = String(password || '').length;
    if (!Number.isFinite(length) || length <= 0) return;
    try {
      window.localStorage.setItem('notoPasswordLength', String(length));
    } catch (e) {}
  }

  function storePasswordPlain(password) {
    const value = String(password || '');
    if (!value) return;
    try {
      window.localStorage.setItem('notoPasswordPlain', value);
    } catch (e) {}
  }

  function goToApp() {
    window.location.replace('index.html');
  }

  function goToSignup() {
    window.location.replace('signup.html');
  }

  function readFormValues(options = {}) {
    const email = normalizeEmail(emailInput && emailInput.value);
    const password = String(passwordInput && passwordInput.value || '');
    const confirmPassword = String(confirmPasswordInput && confirmPasswordInput.value || '');
    const requirePasswordConfirmation = page === 'signup' && options.requirePasswordConfirmation !== false;

    if (!email || !password) {
      setMessage('Email and password are required.', 'error');
      return null;
    }

    if (password.length < 6) {
      setMessage('Password must be at least 6 characters.', 'error');
      return null;
    }

    if (requirePasswordConfirmation && confirmPasswordInput && password !== confirmPassword) {
      setMessage('Passwords do not match.', 'error');
      return null;
    }

    return { email, password };
  }

  async function bootstrap() {
    wireWindowControls();
    if (page === 'welcome') {
      if (submitButton) submitButton.focus();
      if (authAPI) {
        try {
          const state = await authAPI.getState();
          if (state && state.authenticated) {
            goToApp();
            return;
          }
        } catch (error) {}
      }
      setInputsEnabled(true);
      return;
    }
    if (!authAPI) {
      console.error('Auth API bridge is not available.');
      setMessage('Authentication is unavailable right now.', 'error');
      setInputsEnabled(false);
      return;
    }

    try {
      const state = await authAPI.getState();
      if (state && state.authenticated) {
        goToApp();
        return;
      }

      if (state && state.configured === false) {
        const msg = state.error || 'Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY or fill supabase.config.json.';
        setMessage(msg, 'error');
        setInputsEnabled(false);
        return;
      }
    } catch (e) {
      setMessage('Failed to initialize auth state.', 'error');
      setInputsEnabled(false);
      return;
    }

    restorePendingSignupState();
    setInputsEnabled(true);
    if (emailInput) emailInput.focus();
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (page === 'welcome') {
      goToSignup();
      return;
    }
    if (!authAPI) {
      setMessage('Authentication is unavailable right now.', 'error');
      return;
    }
    setMessage('', 'info');
    setBusy(true);

    try {
      if (page === 'signup' && pendingSignup && pendingSignup.email && pendingSignup.password) {
        const continueResult = await authAPI.signIn(pendingSignup.email, pendingSignup.password);
        if (continueResult && continueResult.success && continueResult.authenticated) {
          storePasswordLength(pendingSignup.password);
          storePasswordPlain(pendingSignup.password);
          clearPendingSignup();
          goToApp();
          return;
        }
        setSubmitLabel('Continue');
        setMessage(
          (continueResult && continueResult.error)
            ? continueResult.error
            : 'Your account is not ready yet. Check your email, open the confirmation link, then click Continue again.',
          'error'
        );
        return;
      }

      const values = readFormValues();
      if (!values) return;

      if (page === 'signup') {
        const result = await authAPI.signUp(values.email, values.password);
        if (result && result.success && result.authenticated) {
          storePasswordLength(values.password);
          storePasswordPlain(values.password);
          clearPendingSignup();
          goToApp();
          return;
        }
        if (result && result.success && result.requiresEmailConfirmation) {
          enterPendingSignupState(values.email, values.password, getPendingSignupMessage());
          return;
        }
        clearPendingSignup();
        setMessage((result && result.error) ? result.error : 'Signup failed.', 'error');
        return;
      }

      const loginResult = await authAPI.signIn(values.email, values.password);
      if (loginResult && loginResult.success && loginResult.authenticated) {
        storePasswordLength(values.password);
        storePasswordPlain(values.password);
        clearPendingSignup();
        goToApp();
        return;
      }
      setMessage((loginResult && loginResult.error) ? loginResult.error : 'Login failed.', 'error');
    } catch (e) {
      setMessage('Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  applySavedTheme();
  applySavedAppSize();
  ensureSystemThemePreferenceListener();
  if (form) form.addEventListener('submit', onSubmit);
  if (skipButton) skipButton.addEventListener('click', goToApp);
  bootstrap();
})();
