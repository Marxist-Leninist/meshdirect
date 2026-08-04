/* Qwen 3.8 Mesh — meshdirect frontend (no build step, ES2020, Android WebView safe) */
(function () {
  'use strict';

  var BASE = '/qwen38';
  var API = BASE + '/api';
  var NOTIFY_KEY = 'meshdirect.notifications';
  var PENDING_TURN_KEY = 'meshdirect.pendingTurn.v1';
  var QUEUED_TURNS_KEY = 'meshdirect.queuedTurns.v1';
  var ACTIVE_SEND_MODE_KEY = 'meshdirect.activeSendMode.v1';
  var STATE_POLL_MS = 5000;
  var JOB_POLL_MS = 2500;
  var MAX_MESSAGE = 12000;
  var MAX_IMAGES = 4;
  var MAX_IMAGE_BYTES = 5000000;
  var MAX_IMAGE_TOTAL_BYTES = 12000000;

  var root = document.getElementById('app');

  var state = {
    authenticated: false,
    username: '',
    csrfToken: '',
    brand: 'Qwen 3.8 Mesh',
    plan: 'Preview · Token Plan',
    workspace: 'Stable · Token Plan',
    models: [
      { id: 'preview', label: 'Qwen 3.8 Preview', detail: 'Mesh supervisor with Stable handoff' },
      { id: 'stable', label: 'Qwen 3.8', detail: 'Direct stable model session' }
    ],
    selectedModel: 'preview',
    // history cache: modelId -> { messages: [], loaded: bool }
    histories: {},
    // active job (only one at a time from this tab)
    job: null, // {jobId, model, state, queuePosition, enqueuedAt, runningSince, reply, usage, streamText, mode:'sse'|'poll'}
    meshState: null, // last /state payload
    meshStateError: '',
    stateTimer: null,
    clockTimer: null,
    pollTimer: null,
    streamController: null,
    submitController: null,
    drawerOpen: false,
    sidebarCollapsed: false,
    notificationsEnabled: false,
    attachments: [],
    sending: false,
    steering: false,
    activeSendMode: readActiveSendMode(),
    queuedTurns: readQueuedTurns()
  };

  /* ---------------- icons ---------------- */

  var ICONS = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    panelOpen: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M14 9l3 3-3 3"/>',
    panelClose: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M17 9l-3 3 3 3"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    logout: '<path d="M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    bellOff: '<path d="M8.7 3a6 6 0 0 1 9.3 5v3.6M6.3 6.5C6.1 7 6 7.5 6 8c0 7-3 8-3 8h14.5"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="m2 2 20 20"/>',
    spark: '<path d="M12 2v4m0 12v4M2 12h4m12 0h4M5 5l2.5 2.5m9 9L19 19M5 19l2.5-2.5m9-9L19 5"/>',
    chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z"/>',
    attach: '<path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'
  };

  function icon(name, size) {
    return '<svg class="svg-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') + '</svg>';
  }

  /* ---------------- tiny dom helpers ---------------- */

  function $(sel) { return document.querySelector(sel); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function announce(message) {
    var target = $('#app-live');
    if (!target) return;
    target.textContent = '';
    requestAnimationFrame(function () { target.textContent = message; });
  }

  var toastTimer = null;
  function showToast(message) {
    var old = $('.toast');
    if (old) old.remove();
    var toast = el('div', 'toast');
    toast.setAttribute('role', 'alert');
    toast.textContent = message;
    document.body.appendChild(toast);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.remove(); }, 6000);
  }

  function fmtClock(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m > 0 ? m + 'm ' : '') + s + 's';
  }

  function fmtTokens(n) {
    if (!Number.isFinite(n)) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function fmtTimestamp(value) {
    var date = value == null ? null : new Date(value);
    if (!date || Number.isNaN(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short'
      }).format(date);
    } catch (e) {
      return date.toLocaleString();
    }
  }

  /* ---------------- http ---------------- */

  function ApiError(message, status) {
    this.message = message;
    this.status = status || 0;
  }

  function request(path, options) {
    options = options || {};
    var headers = { 'Accept': 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    return fetch(API + path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    }).then(function (res) {
      if (res.status === 204) return null;
      var isJson = (res.headers.get('content-type') || '').indexOf('json') !== -1;
      return (isJson ? res.json() : res.text()).then(function (data) {
        if (!res.ok) {
          var msg = data && typeof data === 'object' && data.error ? String(data.error)
            : (typeof data === 'string' && data ? data : 'Request failed (' + res.status + ')');
          throw new ApiError(msg, res.status);
        }
        return data;
      });
    }).catch(function (err) {
      if (err && err.status === 401 && state.authenticated) {
        handleSessionExpired();
      }
      throw err;
    });
  }

  function handleSessionExpired() {
    stopAll();
    state.authenticated = false;
    state.csrfToken = '';
    renderLogin('Your session expired. Sign in again.');
  }

  /* ---------------- session / auth ---------------- */

  function applySession(session) {
    state.authenticated = !!(session && session.authenticated);
    if (!state.authenticated) return false;
    state.username = typeof session.username === 'string' ? session.username : '';
    state.csrfToken = typeof session.csrfToken === 'string' ? session.csrfToken : '';
    if (typeof session.model === 'string' && session.model) state.brand = session.model;
    if (typeof session.plan === 'string' && session.plan) state.plan = session.plan;
    if (typeof session.workspace === 'string' && session.workspace) state.workspace = session.workspace;
    if (Array.isArray(session.models)) {
      var models = session.models.filter(function (m) {
        return m && (m.id === 'preview' || m.id === 'stable');
      }).map(function (m) {
        return { id: m.id, label: String(m.label || m.id), detail: String(m.detail || '') };
      });
      if (models.length) state.models = models;
    }
    if (!state.models.some(function (m) { return m.id === state.selectedModel; })) {
      state.selectedModel = session.defaultModel === 'stable' ? 'stable' : 'preview';
    }
    return true;
  }

  function initNotifications() {
    try {
      state.notificationsEnabled = localStorage.getItem(NOTIFY_KEY) === '1' &&
        'Notification' in window && Notification.permission === 'granted';
    } catch (e) {
      state.notificationsEnabled = false;
    }
  }

  function persistNotifications() {
    try { localStorage.setItem(NOTIFY_KEY, state.notificationsEnabled ? '1' : '0'); } catch (e) { /* storage may be blocked */ }
  }

  function attachmentKey(items) {
    return (Array.isArray(items) ? items : []).map(function (item) {
      return [item.fileName || '', item.mimeType || '', Number(item.size) || 0].join(':');
    }).join('|');
  }

  function readPendingTurn() {
    try {
      var raw = localStorage.getItem(PENDING_TURN_KEY);
      if (!raw) return null;
      var pending = JSON.parse(raw);
      if (!pending || typeof pending !== 'object'
        || typeof pending.clientTurnId !== 'string'
        || !/^[A-Za-z0-9_-]{12,80}$/.test(pending.clientTurnId)
        || (pending.model !== 'preview' && pending.model !== 'stable')) {
        localStorage.removeItem(PENDING_TURN_KEY);
        return null;
      }
      return pending;
    } catch (e) {
      return null;
    }
  }

  function persistPendingTurn(job, status) {
    if (!job || typeof job.clientTurnId !== 'string') return;
    var existing = readPendingTurn();
    var descriptor = {
      clientTurnId: job.clientTurnId,
      username: state.username || '',
      jobId: typeof job.jobId === 'string' ? job.jobId : null,
      userMessageId: typeof job.userMessageId === 'string' ? job.userMessageId : null,
      model: job.model,
      message: typeof job.requestMessage === 'string' ? job.requestMessage : (typeof job.message === 'string' ? job.message : ''),
      displayMessage: typeof job.message === 'string' ? job.message : '',
      enqueuedAt: Number.isFinite(job.enqueuedAt) ? job.enqueuedAt : Date.now(),
      status: status || job.state || 'submitting',
      attachmentCount: Number.isSafeInteger(job.attachmentCount)
        ? job.attachmentCount
        : (Array.isArray(job.attachments) ? job.attachments.length : (existing && existing.attachmentCount) || 0),
      attachmentKey: typeof job.attachmentKey === 'string'
        ? job.attachmentKey
        : (Array.isArray(job.attachments) && job.attachments.length
          ? attachmentKey(job.attachments)
          : (existing && existing.clientTurnId === job.clientTurnId && existing.attachmentKey) || '')
    };
    try { localStorage.setItem(PENDING_TURN_KEY, JSON.stringify(descriptor)); } catch (e) { /* storage may be blocked */ }
  }

  function clearPendingTurn(clientTurnId) {
    try {
      var pending = readPendingTurn();
      if (!clientTurnId || !pending || pending.clientTurnId === clientTurnId) {
        localStorage.removeItem(PENDING_TURN_KEY);
      }
    } catch (e) { /* storage may be blocked */ }
  }

  function pendingMatchesDraft(pending, model, message, attachments) {
    return !!pending && pending.model === model && pending.message === message
      && (pending.attachmentKey || '') === attachmentKey(attachments);
  }

  /* ---------------- passkeys (WebAuthn) ---------------- */

  // The browser speaks ArrayBuffers, the API speaks base64url. These two keep
  // that translation in one place.
  function b64urlToBuf(value) {
    var s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = atob(s);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out.buffer;
  }

  function bufToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function passkeysUsable() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }

  // Windows Hello / Touch ID rather than a roaming security key.
  function platformAuthenticatorAvailable() {
    if (!passkeysUsable() || !window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
      return Promise.resolve(false);
    }
    return window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
      .catch(function () { return false; });
  }

  function passkeyLogin() {
    return request('/webauthn/login/options', { method: 'POST', body: {} })
      .then(function (opts) {
        return navigator.credentials.get({
          publicKey: {
            challenge: b64urlToBuf(opts.challenge),
            rpId: opts.rpId,
            timeout: opts.timeout,
            userVerification: opts.userVerification,
            allowCredentials: (opts.allowCredentials || []).map(function (c) {
              return { type: 'public-key', id: b64urlToBuf(c.id) };
            })
          }
        });
      })
      .then(function (cred) {
        if (!cred) throw new ApiError('No passkey was selected.', 0);
        return request('/webauthn/login/verify', {
          method: 'POST',
          body: {
            id: cred.id,
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            authenticatorData: bufToB64url(cred.response.authenticatorData),
            signature: bufToB64url(cred.response.signature)
          }
        });
      });
  }

  function passkeyRegister(label) {
    return request('/webauthn/register/options', { method: 'POST', body: {} })
      .then(function (opts) {
        return navigator.credentials.create({
          publicKey: {
            challenge: b64urlToBuf(opts.challenge),
            rp: opts.rp,
            user: {
              id: b64urlToBuf(opts.user.id),
              name: opts.user.name,
              displayName: opts.user.displayName
            },
            pubKeyCredParams: opts.pubKeyCredParams,
            timeout: opts.timeout,
            attestation: opts.attestation,
            authenticatorSelection: opts.authenticatorSelection,
            excludeCredentials: (opts.excludeCredentials || []).map(function (c) {
              return { type: 'public-key', id: b64urlToBuf(c.id) };
            })
          }
        });
      })
      .then(function (cred) {
        if (!cred) throw new ApiError('Passkey creation was cancelled.', 0);
        var resp = cred.response;
        // getPublicKey() gives us SPKI directly, so the server never has to
        // decode CBOR attestation objects.
        if (!resp.getPublicKey) throw new ApiError('This browser cannot export the passkey public key.', 0);
        var spki = resp.getPublicKey();
        if (!spki) throw new ApiError('This browser did not return a passkey public key.', 0);
        return request('/webauthn/register/verify', {
          method: 'POST',
          body: {
            id: cred.id,
            clientDataJSON: bufToB64url(resp.clientDataJSON),
            authenticatorData: bufToB64url(resp.getAuthenticatorData()),
            publicKeySpki: bufToB64url(spki),
            alg: resp.getPublicKeyAlgorithm(),
            label: label || 'Windows Hello'
          }
        });
      });
  }

  /* ---------------- login view ---------------- */

  function renderLogin(message) {
    stopAll();
    document.body.classList.remove('drawer-open');
    root.innerHTML =
      '<section class="login-shell">' +
        '<form class="login-card" id="login-form" autocomplete="on">' +
          '<div class="brand-mark" aria-hidden="true">Q</div>' +
          '<h1>Qwen 3.8 Mesh</h1>' +
          '<p>One private account for the website and Android app.</p>' +
          '<div class="badge-row" aria-label="Available features">' +
            '<span class="badge">Preview</span><span class="badge">Stable</span><span class="badge">Shared history</span>' +
          '</div>' +
          '<div class="field"><label for="username">Username</label>' +
            '<input id="username" name="username" type="text" autocomplete="username" maxlength="128" required /></div>' +
          '<div class="field"><label for="password">Password</label>' +
            '<input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required /></div>' +
          '<button class="primary-button" id="login-button" type="submit">Sign in</button>' +
          '<button class="icon-button passkey-button" id="passkey-button" type="button" hidden>' + icon('logout', 18) + '<span>Sign in with Windows Hello</span></button>' +
          '<p class="form-message" id="login-message" role="alert"></p>' +
          '<div class="login-note">The model and gateway credentials remain on the server. Your account password is sent only over HTTPS.</div>' +
        '</form>' +
      '</section>';
    var form = $('#login-form');
    var username = $('#username');
    var password = $('#password');
    var button = $('#login-button');
    var msg = $('#login-message');
    if (state.username) username.value = state.username;
    if (message) msg.textContent = message;
    (state.username ? password : username).focus();

    // Offer the passkey path only when this browser can actually do it and the
    // server has at least one credential enrolled.
    var passkeyBtn = $('#passkey-button');
    if (passkeyBtn && passkeysUsable()) {
      request('/webauthn/support', { method: 'GET' })
        .then(function (info) {
          if (!info || !info.enabled || !info.anyRegistered) return;
          passkeyBtn.hidden = false;
          passkeyBtn.addEventListener('click', function () {
            passkeyBtn.disabled = true;
            msg.textContent = '';
            passkeyLogin()
              .then(function (session) {
                if (!applySession(session)) throw new ApiError('Sign-in failed.', 0);
                return enterApp();
              })
              .catch(function (err) {
                msg.textContent = (err && err.message) || 'Passkey sign-in failed.';
                passkeyBtn.disabled = false;
              });
          });
        })
        .catch(function () { /* passkeys simply stay hidden */ });
    }
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var u = username.value.trim();
      var p = password.value;
      if (!u || !p) return;
      button.disabled = true;
      button.textContent = 'Signing in...';
      msg.textContent = '';
      request('/login', { method: 'POST', body: { username: u, password: p } })
        .then(function (session) {
          password.value = '';
          if (!applySession(session)) throw new ApiError('Sign-in failed.', 0);
          return enterApp();
        })
        .catch(function (err) {
          msg.textContent = (err && err.message) || 'Sign-in failed.';
          password.select();
        })
        .then(function () {
          button.disabled = false;
          button.textContent = 'Sign in';
        });
    });
  }

  /* ---------------- app shell ---------------- */

  function renderApp() {
    root.innerHTML =
      '<section class="chat-app" id="chat-app">' +
        '<button class="sidebar-backdrop" id="sidebar-backdrop" type="button" aria-label="Close chat history"></button>' +
        '<aside class="chat-sidebar" id="chat-sidebar" aria-label="Chat history"></aside>' +
        '<section class="app-shell" id="main-pane">' +
          '<header class="app-header">' +
            '<button class="header-icon-button" id="sidebar-toggle" type="button" aria-controls="chat-sidebar" aria-expanded="true" aria-label="Toggle chat history"></button>' +
            '<div class="header-brand">' +
              '<div class="header-logo" aria-hidden="true">Q</div>' +
              '<div class="header-title"><h1 id="header-brand">Qwen 3.8 Mesh</h1><p id="header-subtitle"></p></div>' +
            '</div>' +
            '<div class="header-actions">' +
              '<button class="icon-button notification-button" id="notification-button" type="button" aria-pressed="false" aria-label="Enable reply notifications"></button>' +
              '<button class="icon-button" id="passkey-add-button" type="button" hidden>' + icon('logout', 18) + '<span>Add passkey</span></button>' +
              '<button class="icon-button" id="logout-button" type="button">' + icon('logout', 18) + '<span>Sign out</span></button>' +
            '</div>' +
          '</header>' +
          '<nav class="model-bar" id="model-bar" aria-label="Qwen model"></nav>' +
          '<section class="chat-region" id="chat-region" aria-label="Conversation" tabindex="-1"><div class="messages" id="messages"></div></section>' +
          '<div class="status-strip" id="status-strip" role="status"><div class="status-strip-inner" id="status-strip-inner"></div></div>' +
          '<footer class="composer-shell">' +
            '<div class="active-turn-panel" id="active-turn-panel" hidden>' +
              '<div class="active-turn-copy">' +
                '<span class="active-turn-dot" aria-hidden="true"></span>' +
                '<span><strong id="active-turn-title">Queue next</strong><small id="active-turn-help">Runs as a separate turn after the current work finishes.</small></span>' +
              '</div>' +
              '<div class="active-mode-switch" id="active-mode-switch" role="group" aria-label="Choose what this message should do">' +
                '<button class="active-mode-button" type="button" data-active-mode="steer" aria-pressed="false">Steer current</button>' +
                '<button class="active-mode-button" type="button" data-active-mode="queue" aria-pressed="true">Queue next</button>' +
              '</div>' +
            '</div>' +
            '<section class="queued-turns-panel" id="queued-turns-panel" aria-label="Queued messages" hidden></section>' +
            '<div class="attachment-preview" id="attachment-preview" aria-live="polite"></div>' +
            '<form class="composer" id="composer-form">' +
              '<input id="image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden />' +
              '<button class="attach-button" id="attach-button" type="button" aria-label="Attach images">' + icon('attach', 20) + '</button>' +
              '<label class="sr-only" for="composer-input">Message Qwen</label>' +
              '<textarea id="composer-input" maxlength="' + MAX_MESSAGE + '" rows="1" placeholder="Message Qwen..."></textarea>' +
              '<button class="send-button" id="send-button" type="submit" aria-label="Send message">' + icon('send', 20) + '</button>' +
              '<button class="abort-button" id="abort-button" type="button" aria-label="Stop this turn" hidden>' + icon('stop', 18) + '</button>' +
            '</form>' +
            '<div class="composer-status" id="composer-status"></div>' +
          '</footer>' +
        '</section>' +
        '<div class="sr-only" id="app-live" aria-live="polite" aria-atomic="true"></div>' +
      '</section>';

    $('#sidebar-toggle').addEventListener('click', toggleSidebar);
    $('#sidebar-backdrop').addEventListener('click', function () { closeDrawer(); });
    $('#notification-button').addEventListener('click', toggleNotifications);
    $('#logout-button').addEventListener('click', logout);
    var addPasskey = $('#passkey-add-button');
    if (addPasskey && passkeysUsable()) {
      platformAuthenticatorAvailable().then(function (available) {
        if (!available) return;
        addPasskey.hidden = false;
        addPasskey.addEventListener('click', function () {
          addPasskey.disabled = true;
          passkeyRegister('Windows Hello')
            .then(function () { window.alert('Passkey added. You can now sign in with Windows Hello.'); })
            .catch(function (err) { window.alert((err && err.message) || 'Could not add passkey.'); })
            .then(function () { addPasskey.disabled = false; });
        });
      });
    }
    $('#composer-form').addEventListener('submit', function (event) { event.preventDefault(); sendMessage(); });
    $('#attach-button').addEventListener('click', function () { $('#image-input').click(); });
    $('#image-input').addEventListener('change', selectImages);
    $('#abort-button').addEventListener('click', abortJob);
    $('#active-mode-switch').addEventListener('click', handleActiveModeAction);
    $('#queued-turns-panel').addEventListener('click', handleQueuedTurnAction);
    var input = $('#composer-input');
    input.addEventListener('input', function () { resizeComposer(input); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    $('#header-brand').textContent = state.brand;
    $('#header-subtitle').textContent = state.plan + ' · ' + state.workspace;
    updateSidebarToggleIcon();
    renderSidebar();
    renderModelBar();
    updateNotificationButton();
    renderStrip();
    renderAttachments();
    renderQueuedTurns();
    updateSendControls();
  }

  function isMobile() { return window.matchMedia('(max-width: 820px)').matches; }

  function toggleSidebar() {
    if (isMobile()) {
      state.drawerOpen = !state.drawerOpen;
      var app = $('#chat-app');
      if (app) app.classList.toggle('drawer-open', state.drawerOpen);
      document.body.classList.toggle('drawer-open', state.drawerOpen);
    } else {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      var app2 = $('#chat-app');
      if (app2) app2.classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
    }
    updateSidebarToggleIcon();
  }

  function closeDrawer() {
    state.drawerOpen = false;
    var app = $('#chat-app');
    if (app) app.classList.remove('drawer-open');
    document.body.classList.remove('drawer-open');
  }

  function updateSidebarToggleIcon() {
    var btn = $('#sidebar-toggle');
    if (!btn) return;
    var expanded = isMobile() ? state.drawerOpen : !state.sidebarCollapsed;
    btn.setAttribute('aria-expanded', String(expanded));
    btn.innerHTML = icon(isMobile() ? 'menu' : (expanded ? 'panelClose' : 'panelOpen'), 20);
  }

  function resizeComposer(input) {
    input.style.height = 'auto';
    input.style.height = Math.min(180, input.scrollHeight) + 'px';
  }

  function selectImages(event) {
    var files = Array.prototype.slice.call((event.target && event.target.files) || []);
    event.target.value = '';
    if (!files.length) return;
    if (state.attachments.length + files.length > MAX_IMAGES) {
      showToast('Attach no more than ' + MAX_IMAGES + ' images.');
      return;
    }
    var currentBytes = state.attachments.reduce(function (sum, item) { return sum + item.size; }, 0);
    var incomingBytes = files.reduce(function (sum, file) { return sum + file.size; }, 0);
    if (files.some(function (file) { return file.size > MAX_IMAGE_BYTES; })) {
      showToast('Each image must be 5 MB or smaller.');
      return;
    }
    if (currentBytes + incomingBytes > MAX_IMAGE_TOTAL_BYTES) {
      showToast('Attached images must total 12 MB or less.');
      return;
    }
    var allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (files.some(function (file) { return allowed.indexOf(file.type) === -1; })) {
      showToast('Use PNG, JPEG, WebP, or GIF images.');
      return;
    }
    Promise.all(files.map(function (file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          resolve({ fileName: file.name || 'image', mimeType: file.type, content: String(reader.result || ''), size: file.size });
        };
        reader.onerror = function () { reject(new Error('Could not read ' + (file.name || 'image'))); };
        reader.readAsDataURL(file);
      });
    })).then(function (items) {
      state.attachments = state.attachments.concat(items);
      if (currentJobActive() && state.activeSendMode === 'steer') {
        state.activeSendMode = 'queue';
        persistActiveSendMode();
        setComposerStatus('Switched to Queue next because images cannot be injected into a running turn.');
      }
      renderAttachments();
      updateSendControls();
      announce(items.length + (items.length === 1 ? ' image attached.' : ' images attached.'));
    }).catch(function (error) {
      showToast(error.message || 'Could not read the selected image.');
    });
  }

  function removeAttachment(index) {
    state.attachments.splice(index, 1);
    renderAttachments();
    updateSendControls();
  }

  function renderAttachments() {
    var target = $('#attachment-preview');
    if (!target) return;
    target.replaceChildren();
    state.attachments.forEach(function (item, index) {
      var chip = el('div', 'attachment-chip');
      var image = document.createElement('img');
      image.src = item.content;
      image.alt = '';
      chip.appendChild(image);
      var name = el('span', '', item.fileName);
      name.title = item.fileName;
      chip.appendChild(name);
      var remove = el('button', '', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + item.fileName);
      remove.addEventListener('click', function () { removeAttachment(index); });
      chip.appendChild(remove);
      target.appendChild(chip);
    });
    target.hidden = state.attachments.length === 0;
  }

  /* ---------------- notifications ---------------- */

  function updateNotificationButton() {
    var button = $('#notification-button');
    if (!button) return;
    var supported = 'Notification' in window;
    button.disabled = !supported;
    button.setAttribute('aria-pressed', String(state.notificationsEnabled));
    button.setAttribute('aria-label', supported
      ? (state.notificationsEnabled ? 'Disable reply notifications' : 'Enable reply notifications')
      : 'Reply notifications are unavailable');
    button.innerHTML = icon(state.notificationsEnabled ? 'bell' : 'bellOff', 18) +
      '<span>' + (state.notificationsEnabled ? 'Notifications on' : 'Notify me') + '</span>';
  }

  function toggleNotifications() {
    if (!('Notification' in window)) {
      showToast('This browser does not support notifications.');
      return;
    }
    if (state.notificationsEnabled) {
      state.notificationsEnabled = false;
      persistNotifications();
      updateNotificationButton();
      announce('Reply notifications disabled.');
      return;
    }
    var settled = false;
    var finish = function (permission) {
      if (settled) return;
      settled = true;
      if (permission !== 'granted') {
        state.notificationsEnabled = false;
        persistNotifications();
        updateNotificationButton();
        showToast('Notifications were not enabled. You can change this in browser settings.');
        return;
      }
      state.notificationsEnabled = true;
      persistNotifications();
      updateNotificationButton();
      announce('Reply notifications enabled.');
    };
    if (Notification.permission === 'default') {
      try {
        var result = Notification.requestPermission(finish);
        if (result && typeof result.then === 'function') result.then(finish, function () {
          showToast('The browser could not open notification permission settings.');
        });
      } catch (e) {
        showToast('The browser could not open notification permission settings.');
      }
    } else {
      finish(Notification.permission);
    }
  }

  function notifyReply(reply) {
    if (!state.notificationsEnabled || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    var body = String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    try {
      new Notification('Qwen 3.8 Mesh', { body: body || 'Reply ready.', tag: 'qwen38-mesh-reply' });
    } catch (e) { /* platform support can change after opt-in */ }
  }

  /* ---------------- sidebar ---------------- */

  function modelInfo(id) {
    for (var i = 0; i < state.models.length; i++) {
      if (state.models[i].id === id) return state.models[i];
    }
    return { id: id, label: id, detail: '' };
  }

  function meshModel(id) {
    var list = state.meshState && Array.isArray(state.meshState.models) ? state.meshState.models : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].model === id) return list[i];
    }
    return null;
  }

  function laneInfo(id) {
    var lanes = state.meshState && state.meshState.lanes ? state.meshState.lanes : {};
    return lanes[id] || { running: null, queued: 0 };
  }

  function renderSidebar() {
    var sidebar = $('#chat-sidebar');
    if (!sidebar) return;
    sidebar.innerHTML =
      '<div class="sidebar-header">' +
        '<div><strong>Chats</strong><span>Web and Android history</span></div>' +
        '<button class="sidebar-close" id="sidebar-close" type="button" aria-label="Close chat history">' + icon('close', 21) + '</button>' +
      '</div>' +
      '<nav class="chat-navigation" id="chat-navigation">' +
        '<div class="chat-group"><h2>Sessions</h2><ul id="chat-list"></ul></div>' +
      '</nav>' +
      '<div class="sidebar-footer" id="sidebar-footer"></div>';

    $('#sidebar-close').addEventListener('click', function () {
      if (isMobile()) closeDrawer(); else toggleSidebar();
    });

    var list = $('#chat-list');
    state.models.forEach(function (model) {
      var item = el('li', 'chat-list-item' + (model.id === state.selectedModel ? ' active' : ''));
      var btn = el('button', 'chat-select');
      btn.type = 'button';
      btn.dataset.model = model.id;
      var leading = el('span', 'chat-leading');
      leading.innerHTML = icon('chat', 17);
      var copy = el('span', 'chat-copy');
      copy.appendChild(el('strong', '', model.label));
      var info = meshModel(model.id);
      var lane = laneInfo(model.id);
      var sub = 'main session';
      if (info) {
        var parts = [];
        if (Number.isFinite(info.messageCount)) parts.push(info.messageCount + ' messages');
        if (info.lastActivityAt) parts.push(fmtTimestamp(info.lastActivityAt));
        if (parts.length) sub = parts.join(' · ');
        if (lane.running) sub = 'running ' + fmtClock(lane.running.elapsedMs) + ' · ' + sub;
        else if (info.busy) sub = 'busy · ' + sub;
        else if (lane.queued > 0) sub = lane.queued + ' queued · ' + sub;
      }
      copy.appendChild(el('span', '', sub));
      btn.appendChild(leading);
      btn.appendChild(copy);
      btn.addEventListener('click', function () { selectModel(model.id); });
      item.appendChild(btn);
      list.appendChild(item);
    });

    var footer = $('#sidebar-footer');
    footer.textContent = state.username ? 'Signed in as ' + state.username : '';
  }

  /* ---------------- model bar ---------------- */

  function renderModelBar() {
    var bar = $('#model-bar');
    if (!bar) return;
    bar.replaceChildren();
    state.models.forEach(function (model) {
      var info = meshModel(model.id);
      var lane = laneInfo(model.id);
      var busy = !!(info && info.busy) || !!lane.running;
      var button = el('button', 'model-button');
      button.type = 'button';
      button.dataset.model = model.id;
      button.setAttribute('aria-pressed', String(model.id === state.selectedModel));
      var dot = el('span', 'model-dot' + (busy ? ' busy' : ''));
      dot.setAttribute('aria-hidden', 'true');
      var copy = el('span', 'model-copy');
      copy.appendChild(el('strong', '', model.label));
      var detail = model.detail || '';
      if (lane.running) detail = 'Running ' + fmtClock(lane.running.elapsedMs);
      else if (lane.queued > 0) detail = lane.queued + ' in queue';
      else if (busy) detail = 'Busy';
      copy.appendChild(el('span', '', detail));
      button.appendChild(dot);
      button.appendChild(copy);
      button.addEventListener('click', function () { selectModel(model.id); });
      bar.appendChild(button);
    });
  }

  function selectModel(modelId) {
    if (modelId === state.selectedModel) {
      if (isMobile()) closeDrawer();
      return;
    }
    state.selectedModel = modelId;
    if (isMobile()) closeDrawer();
    renderSidebar();
    renderModelBar();
    renderStrip();
    loadHistory(modelId, true);
    requestAnimationFrame(function () {
      var input = $('#composer-input');
      if (input && !isMobile()) input.focus();
    });
  }

  /* ---------------- messages ---------------- */

  function historyFor(modelId) {
    return state.histories[modelId] || { messages: [], loaded: false };
  }

  function scrollToBottom(force) {
    var region = $('#chat-region');
    if (!region) return;
    var nearBottom = region.scrollHeight - region.scrollTop - region.clientHeight < 140;
    if (force || nearBottom) region.scrollTop = region.scrollHeight;
  }

  function renderAssistantMarkdown(target, content) {
    if (window.MeshMarkdown && typeof window.MeshMarkdown.renderInto === 'function') {
      window.MeshMarkdown.renderInto(target, content);
    } else {
      target.textContent = content == null ? '' : String(content);
    }
  }

  function scheduleStreamingMarkdown(job) {
    if (job.markdownFrame) return;
    job.markdownFrame = requestAnimationFrame(function () {
      job.markdownFrame = null;
      if (state.job !== job) return;
      var bubble = $('#stream-bubble');
      if (!bubble) return;
      renderAssistantMarkdown(bubble, job.reply != null ? job.reply : job.streamText);
      scrollToBottom(false);
    });
  }

  function messageNode(message) {
    var wrap = el('article', 'message ' + (message.role === 'user' ? 'user' : 'assistant'));
    var meta = el('div', 'message-meta');
    meta.appendChild(el('span', '', message.role === 'user' ? 'You' : 'Qwen'));
    var ts = fmtTimestamp(message.timestamp);
    if (ts) meta.appendChild(el('span', '', ts));
    var bubble = el('div', 'message-bubble');
    if (message.role === 'assistant') renderAssistantMarkdown(bubble, message.content || '');
    else bubble.textContent = message.content || '';
    wrap.appendChild(meta);
    wrap.appendChild(bubble);
    if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length) {
      var gallery = el('div', 'message-images');
      message.attachments.forEach(function (attachment) {
        var preview = document.createElement('img');
        preview.src = attachment.content || attachment.url || '';
        preview.alt = attachment.fileName || 'Attached image';
        preview.loading = 'lazy';
        gallery.appendChild(preview);
      });
      wrap.appendChild(gallery);
    }
    if (message.role === 'assistant' && Array.isArray(message.tools) && message.tools.length) {
      var tools = el('div', 'message-tools');
      message.tools.slice(0, 20).forEach(function (tool) {
        var label = tool && typeof tool === 'object' ? (tool.label || tool.name || 'tool') : String(tool);
        tools.appendChild(el('span', 'tool-chip', label));
      });
      wrap.appendChild(tools);
    }
    return wrap;
  }

  function renderMessages(scroll) {
    var container = $('#messages');
    if (!container) return;
    container.replaceChildren();
    var hist = historyFor(state.selectedModel);
    if (!hist.loaded && !hist.error && !state.job) {
      container.appendChild(emptyState('Loading history…', 'Reading the shared session.'));
      return;
    }
    if (hist.error && !state.job) {
      container.appendChild(emptyState('History unavailable', hist.error));
      return;
    }
    if (!hist.messages.length && !state.job) {
      container.appendChild(emptyState(
        'Message ' + modelInfo(state.selectedModel).label,
        'Replies stream in live. This session is shared with the Android app.'
      ));
      return;
    }
    hist.messages.forEach(function (message) {
      container.appendChild(messageNode(message));
    });
    renderActiveJob(container);
    if (scroll) scrollToBottom(true);
  }

  function emptyState(title, text) {
    var box = el('div', 'empty-state');
    var iconHolder = document.createElement('span');
    iconHolder.innerHTML = icon('spark', 26);
    box.appendChild(iconHolder.firstChild);
    box.appendChild(el('strong', '', title));
    box.appendChild(el('span', '', text));
    return box;
  }

  /* ---------------- active job rendering ---------------- */

  function renderToolActivity(container, tools) {
    if (!Array.isArray(tools) || !tools.length) return;
    var recent = tools.slice(-10);
    var running = recent.filter(function (tool) { return tool && tool.status === 'running'; }).length;
    var panel = el('section', 'tool-activity');
    panel.setAttribute('aria-label', 'Live tool activity');
    var heading = el('div', 'tool-activity-heading');
    heading.appendChild(el('strong', '', 'Tools'));
    heading.appendChild(el('span', '', running ? running + ' active now' : recent.length + ' used'));
    panel.appendChild(heading);
    recent.forEach(function (tool) {
      var status = tool && tool.status === 'complete' ? 'complete' : (tool && tool.status === 'error' ? 'error' : 'running');
      var row = el('div', 'tool-activity-row ' + status);
      row.appendChild(el('span', 'tool-activity-dot'));
      row.appendChild(el('span', 'tool-activity-name', tool && (tool.label || tool.name) ? String(tool.label || tool.name) : 'Tool'));
      row.appendChild(el('span', 'tool-activity-status', status === 'complete' ? 'Done' : (status === 'error' ? 'Failed' : 'Using now')));
      panel.appendChild(row);
    });
    container.appendChild(panel);
  }

  function renderActiveJob(container) {
    var job = state.job;
    if (!job || job.model !== state.selectedModel) return;

    // Optimistic user bubble. Do not duplicate the accepted row after restoring a turn.
    var hist = historyFor(job.model);
    var userAlreadyInHistory = !!job.userMessageId && hist.messages.some(function (message) {
      return message && message.id === job.userMessageId;
    });
    if (!userAlreadyInHistory) {
      var user = el('article', 'message user');
      var umeta = el('div', 'message-meta');
      umeta.appendChild(el('span', '', 'You'));
      user.appendChild(umeta);
      user.appendChild(el('div', 'message-bubble', job.message));
      if (Array.isArray(job.attachments) && job.attachments.length) {
        var gallery = el('div', 'message-images');
        job.attachments.forEach(function (attachment) {
          var preview = document.createElement('img');
          preview.src = attachment.content;
          preview.alt = attachment.fileName || 'Attached image';
          gallery.appendChild(preview);
        });
        user.appendChild(gallery);
      }
      container.appendChild(user);
    }

    // streaming / finished assistant bubble
    if (job.reply != null || job.streamText) {
      var wrap = el('article', 'message assistant');
      var meta = el('div', 'message-meta');
      meta.appendChild(el('span', '', 'Qwen'));
      if (job.reply != null && job.elapsedMs != null) {
        meta.appendChild(el('span', '', fmtClock(job.elapsedMs)));
      }
      var bubble = el('div', 'message-bubble' + (job.reply == null ? ' streaming' : ''));
      bubble.id = 'stream-bubble';
      renderAssistantMarkdown(bubble, job.reply != null ? job.reply : job.streamText);
      wrap.appendChild(meta);
      wrap.appendChild(bubble);
      container.appendChild(wrap);
    } else if (job.state === 'running' || job.state === 'queued' || job.state === 'submitting') {
      var typing = el('div', 'typing');
      typing.id = 'typing-indicator';
      typing.setAttribute('aria-label', 'Qwen is thinking');
      typing.appendChild(el('span'));
      typing.appendChild(el('span'));
      typing.appendChild(el('span'));
      container.appendChild(typing);
    }

    // Tool use must be visible before Qwen starts writing the final reply.
    renderToolActivity(container, job.tools);

    var steering = normalizeSteeringSummary(job.steering);
    if (steering.pending || steering.applied || steering.notApplied) {
      var steeringPanel = el('div', 'steering-state');
      steeringPanel.appendChild(el('strong', '', 'Live steering'));
      if (steering.pending) steeringPanel.appendChild(el('span', 'pending', steering.pending + ' waiting'));
      if (steering.applied) steeringPanel.appendChild(el('span', 'applied', steering.applied + ' applied'));
      if (steering.notApplied) steeringPanel.appendChild(el('span', 'not-applied', steering.notApplied + ' not applied'));
      container.appendChild(steeringPanel);
    }

    // turn state card
    if (job.state !== 'done') {
      var card = el('div', 'turn-state ' + (job.state === 'error' ? 'failed' : (job.state === 'queued' || job.state === 'submitting') ? 'queued' : 'running'));
      var summary = el('div', 'turn-state-summary');
      summary.appendChild(el('span', 'turn-state-marker'));
      var text;
      if (job.state === 'error') text = 'Turn failed: ' + (job.error || 'Unknown error');
      else if (job.state === 'queued') text = 'Queued' + (job.queuePosition ? ' · position ' + job.queuePosition : '') + ' · ' + fmtClock(Date.now() - job.enqueuedAt);
      else if (job.state === 'submitting') text = (job.activity || 'Sending') + '…';
      else text = (job.activity || 'Running') + ' · ' + fmtClock(Date.now() - job.enqueuedAt) + (job.mode === 'poll' ? ' · polling' : ' · live');
      summary.appendChild(el('span', '', text));
      card.appendChild(summary);
      container.appendChild(card);
    }
  }

  function updateJobCard() {
    // light-touch: update card + typing without full re-render
    renderMessages(false);
  }



  /* ---------------- active-turn queue / steering mode ---------------- */

  function readActiveSendMode() {
    try { return localStorage.getItem(ACTIVE_SEND_MODE_KEY) === 'steer' ? 'steer' : 'queue'; }
    catch (error) { return 'queue'; }
  }

  function persistActiveSendMode() {
    try { localStorage.setItem(ACTIVE_SEND_MODE_KEY, state.activeSendMode === 'steer' ? 'steer' : 'queue'); }
    catch (error) { /* storage may be blocked */ }
  }

  function currentJobActive() {
    return !!state.job && state.job.state !== 'done' && state.job.state !== 'error';
  }

  function canSteerCurrentJob() {
    return currentJobActive() && state.job.state === 'running' && !state.job.stopRequested;
  }

  function effectiveActiveSendMode() {
    if (!currentJobActive()) return 'send';
    return state.activeSendMode === 'steer' && canSteerCurrentJob() ? 'steer' : 'queue';
  }

  function renderActiveTurnPanel(active, steerable, mode) {
    var panel = $('#active-turn-panel');
    if (!panel) return;
    panel.hidden = !active;
    if (!active) return;
    var title = $('#active-turn-title');
    var help = $('#active-turn-help');
    var selected = mode === 'steer' ? 'steer' : 'queue';
    if (title) title.textContent = selected === 'steer' ? 'Steer current turn' : 'Queue next turn';
    if (help) {
      if (selected === 'steer') {
        help.textContent = state.steering
          ? 'Sending the instruction safely. The current turn keeps its place.'
          : 'Applies at the next safe model step and revises stale draft text.';
      } else if (!steerable && state.activeSendMode === 'steer') {
        help.textContent = 'This turn is not running yet, so messages are queued until steering becomes available.';
      } else {
        help.textContent = 'Runs separately after the current turn. Nothing is interrupted.';
      }
    }
    panel.classList.toggle('steer-selected', selected === 'steer');
    panel.classList.toggle('queue-selected', selected === 'queue');
    panel.querySelectorAll('[data-active-mode]').forEach(function (button) {
      var buttonMode = button.dataset.activeMode;
      var pressed = buttonMode === selected;
      button.classList.toggle('selected', pressed);
      button.setAttribute('aria-pressed', String(pressed));
      button.disabled = buttonMode === 'steer' && !steerable;
    });
  }

  function setActiveSendMode(mode, notify) {
    if (mode !== 'steer' && mode !== 'queue') return;
    if (mode === 'steer' && state.attachments.length) {
      setComposerStatus('Images cannot be injected into a running turn. Keep Queue next selected for this message.', true);
      return;
    }
    if (mode === 'steer' && !canSteerCurrentJob()) {
      setComposerStatus('Steering becomes available when the current turn is running.');
      return;
    }
    state.activeSendMode = mode;
    persistActiveSendMode();
    setComposerStatus(mode === 'steer'
      ? 'The next message will steer the current turn.'
      : 'The next message will run as a separate queued turn.');
    updateSendControls();
    if (notify) announce(mode === 'steer' ? 'Steer current selected.' : 'Queue next selected.');
    var input = $('#composer-input');
    if (input) input.focus();
  }

  function handleActiveModeAction(event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-active-mode]') : null;
    if (!button || button.disabled) return;
    setActiveSendMode(button.dataset.activeMode, true);
  }

  function emptySteeringSummary() {
    return { pending: 0, applied: 0, notApplied: 0, items: [] };
  }

  function normalizeSteeringSummary(value) {
    if (!value || typeof value !== 'object') return emptySteeringSummary();
    var items = Array.isArray(value.items) ? value.items.flatMap(function (item) {
      if (!item || typeof item.id !== 'string') return [];
      var itemState = item.state === 'applied' || item.state === 'not-applied' ? item.state : 'pending';
      return [{
        id: item.id,
        clientSteeringId: typeof item.clientSteeringId === 'string'
          ? item.clientSteeringId
          : (typeof item.clientSteerId === 'string' ? item.clientSteerId : ''),
        state: itemState,
        createdAt: Number(item.createdAt) || null,
        appliedAt: Number(item.appliedAt) || null,
        interrupted: !!item.interrupted,
      }];
    }) : [];
    function count(name) { return items.filter(function (item) { return item.state === name; }).length; }
    return {
      pending: Number.isSafeInteger(value.pending) ? Math.max(0, value.pending) : count('pending'),
      applied: Number.isSafeInteger(value.applied) ? Math.max(0, value.applied) : count('applied'),
      notApplied: Number.isSafeInteger(value.notApplied) ? Math.max(0, value.notApplied) : count('not-applied'),
      items: items,
    };
  }

  function reconcilePendingSteering(job) {
    var pending = job && job.pendingSteeringRequest;
    if (!pending) return false;
    var summary = normalizeSteeringSummary(job.steering);
    var matched = summary.items.find(function (item) {
      return item.clientSteeringId && item.clientSteeringId === pending.clientSteeringId;
    });
    if (!matched) return false;
    var input = $('#composer-input');
    if (input && input.value.trim() === pending.message) {
      input.value = '';
      resizeComposer(input);
    }
    job.pendingSteeringRequest = null;
    state.steering = false;
    if (matched.state === 'applied') {
      setComposerStatus('Steering applied. Qwen is revising the current turn.');
    } else if (matched.state === 'not-applied') {
      setComposerStatus('The turn ended before that steering instruction could be applied.', true);
    } else {
      setComposerStatus('Steering accepted. It will apply at the next safe model step.');
    }
    return true;
  }

  function applySteeringEvent(job, data) {
    var summary = normalizeSteeringSummary(job.steering);
    var items = summary.items.slice();
    var ids = Array.isArray(data.ids) ? data.ids.filter(function (id) { return typeof id === 'string'; }) : [];
    if (typeof data.id === 'string') ids.push(data.id);
    ids = ids.filter(function (id, index) { return ids.indexOf(id) === index; });
    if (data.state === 'accepted' && typeof data.id === 'string') {
      var existing = items.find(function (item) { return item.id === data.id; });
      if (!existing) {
        items.push({
          id: data.id,
          clientSteeringId: typeof data.clientSteeringId === 'string'
            ? data.clientSteeringId
            : (typeof data.clientSteerId === 'string' ? data.clientSteerId : ''),
          state: 'pending',
          createdAt: Number(data.createdAt) || Date.now(),
          appliedAt: null,
          interrupted: !!data.interrupted,
        });
      }
    } else if (data.state === 'applied' || data.state === 'not-applied') {
      ids.forEach(function (id) {
        var item = items.find(function (candidate) { return candidate.id === id; });
        if (item) {
          item.state = data.state;
          item.appliedAt = Number(data.appliedAt) || Date.now();
        }
      });
    }
    job.steering = normalizeSteeringSummary({
      pending: Number.isSafeInteger(data.pending) ? data.pending : undefined,
      applied: Number.isSafeInteger(data.applied) ? data.applied : undefined,
      notApplied: Number.isSafeInteger(data.notApplied) ? data.notApplied : undefined,
      items: items,
    });
    if (data.resetOutput) {
      if (job.markdownFrame) cancelAnimationFrame(job.markdownFrame);
      job.markdownFrame = null;
      job.streamText = '';
      job.reply = null;
    }
    if (data.state === 'accepted') {
      job.activity = data.interrupted
        ? 'Steering accepted; stopping the stale model draft'
        : 'Steering accepted; waiting for the next model step';
    } else if (data.state === 'applied') {
      job.activity = data.resetOutput ? 'Revising the reply from your steering' : 'Applying your steering';
      setComposerStatus('Steering applied. Qwen is revising the current turn.');
    } else if (data.state === 'not-applied') {
      job.activity = 'Steering could not be applied';
      setComposerStatus(data.reason || 'The turn ended before steering could be applied.', true);
    }
    reconcilePendingSteering(job);
    persistPendingTurn(job, job.stopRequested ? 'stopping' : job.state);
    updateJobCard();
    updateSendControls();
    renderStrip();
  }

  /* ---------------- queued turns ---------------- */

  function readQueuedTurns() {
    try {
      var parsed = JSON.parse(localStorage.getItem(QUEUED_TURNS_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap(function (item) {
        if (!item || typeof item !== 'object') return [];
        if (item.model !== 'preview' && item.model !== 'stable') return [];
        if (typeof item.message !== 'string' || !item.message.trim() || item.message.length > MAX_MESSAGE) return [];
        return [{
          id: typeof item.id === 'string' ? item.id : newClientTurnId(),
          model: item.model,
          message: item.message,
          attachments: [],
          createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : Date.now(),
        }];
      });
    } catch (error) {
      try { localStorage.removeItem(QUEUED_TURNS_KEY); } catch (e) { /* storage may be blocked */ }
      return [];
    }
  }

  function persistQueuedTurns() {
    try {
      // Image data can exceed localStorage by itself. Text turns survive reload;
      // image turns remain queued in memory and the UI explicitly says to keep
      // this page open until they have been submitted.
      var durable = state.queuedTurns.filter(function (item) {
        return !item.attachments || item.attachments.length === 0;
      }).map(function (item) {
        return {
          id: item.id,
          model: item.model,
          message: item.message,
          createdAt: item.createdAt,
        };
      });
      if (durable.length) localStorage.setItem(QUEUED_TURNS_KEY, JSON.stringify(durable));
      else localStorage.removeItem(QUEUED_TURNS_KEY);
    } catch (error) { /* storage may be blocked */ }
  }

  function queuedTurnSummary(item) {
    var text = String(item.message || '').replace(/\s+/g, ' ').trim();
    var count = Array.isArray(item.attachments) ? item.attachments.length : 0;
    if (!text) text = count === 1 ? 'Attached image' : count + ' attached images';
    return text.length > 92 ? text.slice(0, 89) + '…' : text;
  }

  function renderQueuedTurns() {
    var panel = $('#queued-turns-panel');
    if (!panel) return;
    panel.replaceChildren();
    if (!state.queuedTurns.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    var heading = el('div', 'queued-turns-heading');
    heading.appendChild(el('strong', '', state.queuedTurns.length === 1 ? '1 queued turn' : state.queuedTurns.length + ' queued turns'));
    heading.appendChild(el('span', '', 'Runs in order'));
    panel.appendChild(heading);
    state.queuedTurns.forEach(function (item, index) {
      var row = el('div', 'queued-turn-row');
      row.appendChild(el('span', 'queued-turn-index', String(index + 1)));
      var copy = el('span', 'queued-turn-copy');
      copy.appendChild(el('strong', '', queuedTurnSummary(item)));
      var imageCount = Array.isArray(item.attachments) ? item.attachments.length : 0;
      var detail = modelInfo(item.model).label + ' · waiting';
      if (imageCount) detail += ' · ' + imageCount + (imageCount === 1 ? ' image' : ' images') + ' · keep page open';
      copy.appendChild(el('span', '', detail));
      row.appendChild(copy);
      var remove = el('button', 'queued-turn-cancel', 'Cancel');
      remove.type = 'button';
      remove.dataset.queuedTurnId = item.id;
      remove.setAttribute('aria-label', 'Cancel queued turn ' + (index + 1));
      row.appendChild(remove);
      panel.appendChild(row);
    });
  }

  function handleQueuedTurnAction(event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-queued-turn-id]') : null;
    if (!button) return;
    var id = button.dataset.queuedTurnId;
    var before = state.queuedTurns.length;
    state.queuedTurns = state.queuedTurns.filter(function (item) { return item.id !== id; });
    if (state.queuedTurns.length === before) return;
    persistQueuedTurns();
    renderQueuedTurns();
    setComposerStatus('Queued turn cancelled.');
    announce('Queued turn cancelled.');
  }

  function queueCurrentDraft(input, noteOverride) {
    var message = input.value.trim();
    var attachments = state.attachments.slice();
    if (!message && !attachments.length) return;
    if (message.length > MAX_MESSAGE) {
      setComposerStatus('Message is too long (max ' + MAX_MESSAGE + ' chars).', true);
      return;
    }
    state.queuedTurns.push({
      id: 'queued-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      model: state.selectedModel,
      message: message,
      attachments: attachments,
      createdAt: Date.now(),
    });
    input.value = '';
    state.attachments = [];
    resizeComposer(input);
    renderAttachments();
    persistQueuedTurns();
    renderQueuedTurns();
    updateSendControls();
    var note = noteOverride || (attachments.length
      ? 'Queued with ' + attachments.length + (attachments.length === 1 ? ' image. Keep this page open until it sends.' : ' images. Keep this page open until they send.')
      : 'Message queued. It will send automatically after the current turn.');
    setComposerStatus(note);
    announce('Message queued.');
  }

  function drainQueuedTurn() {
    var active = !!state.job && state.job.state !== 'done' && state.job.state !== 'error';
    if (active || state.sending || state.steering || !state.queuedTurns.length) return;
    if (state.job && (state.job.state === 'done' || state.job.state === 'error')) state.job = null;
    var item = state.queuedTurns.shift();
    persistQueuedTurns();
    renderQueuedTurns();
    state.selectedModel = item.model;
    renderSidebar();
    renderModelBar();
    var input = $('#composer-input');
    if (!input) {
      state.queuedTurns.unshift(item);
      persistQueuedTurns();
      return;
    }
    input.value = item.message;
    state.attachments = Array.isArray(item.attachments) ? item.attachments : [];
    resizeComposer(input);
    renderAttachments();
    setComposerStatus('Sending the next queued turn…');
    announce('Sending the next queued turn.');
    setTimeout(function () {
      var becameActive = !!state.job && state.job.state !== 'done' && state.job.state !== 'error';
      if (becameActive || state.sending || state.steering) {
        state.queuedTurns.unshift(item);
        persistQueuedTurns();
        renderQueuedTurns();
        return;
      }
      sendMessage();
    }, 40);
  }

  /* ---------------- history ---------------- */

  function loadHistory(modelId, scroll) {
    var hist = state.histories[modelId] || { messages: [], loaded: false, error: '' };
    state.histories[modelId] = hist;
    if (modelId === state.selectedModel) renderMessages(!!scroll);
    return request('/history?model=' + encodeURIComponent(modelId) + '&sessionId=main&limit=120')
      .then(function (payload) {
        var messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
        var priorAttachments = {};
        hist.messages.forEach(function (message) {
          if (message.id && Array.isArray(message.attachments) && message.attachments.length) {
            priorAttachments[message.id] = message.attachments;
          }
        });
        var activeJob = state.job && state.job.model === modelId ? state.job : null;
        hist.messages = messages.map(function (m) {
          var attachments = m && Array.isArray(m.attachments) ? m.attachments : [];
          if (!attachments.length && m && m.id && priorAttachments[m.id]) attachments = priorAttachments[m.id];
          if (!attachments.length && activeJob && m && m.id === activeJob.userMessageId) {
            attachments = activeJob.attachments || [];
          }
          return {
            id: m && m.id,
            role: m && m.role === 'user' ? 'user' : 'assistant',
            content: m && typeof m.content === 'string' ? m.content : '',
            timestamp: m ? m.timestamp : null,
            tools: m && Array.isArray(m.tools) ? m.tools : [],
            attachments: attachments
          };
        });
        hist.loaded = true;
        hist.error = '';
        if (modelId === state.selectedModel && !state.job) renderMessages(!!scroll);
        else if (modelId === state.selectedModel) renderMessages(false);
        return true;
      })
      .catch(function (err) {
        if (hist.loaded) return false; // keep stale history and the optimistic completed job
        hist.loaded = false;
        hist.error = (err && err.message) || 'Could not load history.';
        if (modelId === state.selectedModel) renderMessages(false);
        return false;
      });
  }

  /* ---------------- chat send / stream / poll / abort ---------------- */

  function setComposerStatus(message, isError) {
    var target = $('#composer-status');
    if (!target) return;
    target.textContent = message || '';
    target.classList.toggle('error', !!isError);
  }

  function updateSendControls() {
    var form = $('#composer-form');
    var send = $('#send-button');
    var abort = $('#abort-button');
    var attach = $('#attach-button');
    var input = $('#composer-input');
    var active = currentJobActive();
    var steerable = canSteerCurrentJob();
    var mode = effectiveActiveSendMode();
    var controlsBusy = state.sending || state.steering;
    if (form) {
      form.classList.toggle('queue-active', active && mode === 'queue');
      form.classList.toggle('steer-active', active && mode === 'steer');
    }
    if (send) {
      var label = mode === 'steer' ? 'Steer current turn' : (mode === 'queue' ? 'Queue next message' : 'Send message');
      send.hidden = false;
      send.disabled = controlsBusy;
      send.setAttribute('aria-label', label);
      send.title = active ? label : '';
    }
    if (abort) {
      abort.hidden = !active;
      abort.disabled = !!(state.job && state.job.stopInFlight);
    }
    if (attach) {
      attach.disabled = controlsBusy || (active && mode === 'steer');
      attach.title = active && mode === 'steer' ? 'Switch to Queue next to attach images' : '';
    }
    if (input) {
      input.disabled = state.steering;
      input.placeholder = mode === 'steer'
        ? 'Steer the current turn…'
        : (mode === 'queue' ? 'Queue another message…' : 'Message Qwen…');
    }
    renderActiveTurnPanel(active, steerable, mode);
    renderQueuedTurns();
  }

  function newClientTurnId() {
    return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }

  function waitMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function lookupClientTurn(clientTurnId, attempts) {
    attempts = Math.max(1, attempts || 1);
    return request('/chat/by-client/' + encodeURIComponent(clientTurnId))
      .catch(function (err) {
        if (attempts <= 1 || (err && err.status && err.status !== 404 && err.status < 500)) throw err;
        // A cancelled submission can reach the server just after our lookup.
        // Retry both transient transport failures and a short-lived 404 race.
        var delay = err && err.status === 404 ? 450 : 900;
        return waitMs(delay).then(function () { return lookupClientTurn(clientTurnId, attempts - 1); });
      });
  }

  function clearAcceptedDraft(job) {
    var input = $('#composer-input');
    if (input && input.value.trim() === (job.requestMessage || '')) {
      input.value = '';
      resizeComposer(input);
    }
    if (attachmentKey(state.attachments) === (job.attachmentKey || '')) {
      state.attachments = [];
      renderAttachments();
    }
  }

  function hydrateRecoveredJob(pending, info) {
    info = info || {};
    var requestMessage = typeof pending.message === 'string' ? pending.message : '';
    var displayMessage = typeof info.message === 'string' && info.message
      ? info.message
      : (pending.displayMessage || requestMessage || 'Submitted turn');
    return {
      jobId: typeof info.jobId === 'string' ? info.jobId : (pending.jobId || null),
      clientTurnId: pending.clientTurnId,
      userMessageId: typeof info.userMessageId === 'string' ? info.userMessageId : (pending.userMessageId || null),
      model: info.model === 'stable' || info.model === 'preview' ? info.model : pending.model,
      requestMessage: requestMessage,
      message: displayMessage,
      attachments: [],
      attachmentCount: Number.isSafeInteger(pending.attachmentCount) ? pending.attachmentCount : 0,
      attachmentKey: typeof pending.attachmentKey === 'string' ? pending.attachmentKey : '',
      state: typeof info.state === 'string' ? info.state : 'queued',
      queuePosition: Number.isSafeInteger(info.queuePosition) ? info.queuePosition : null,
      enqueuedAt: Number.isFinite(info.createdAt) ? info.createdAt : (Number(pending.enqueuedAt) || Date.now()),
      streamText: '',
      reply: info.reply != null ? String(info.reply) : null,
      usage: info.usage || null,
      elapsedMs: Number.isFinite(info.elapsedMs) ? info.elapsedMs : null,
      error: typeof info.error === 'string' ? info.error : null,
      activity: typeof info.activity === 'string' ? info.activity : 'Recovering turn',
      tools: Array.isArray(info.tools) ? info.tools : [],
      steering: normalizeSteeringSummary(info.steering),
      mode: 'sse'
    };
  }

  function adoptClientTurn(job, info, quiet) {
    if (!info || typeof info.jobId !== 'string' || !info.jobId) {
      throw new ApiError('The server returned an invalid turn.', 0);
    }
    job.jobId = info.jobId;
    job.userMessageId = typeof info.userMessageId === 'string' ? info.userMessageId : job.userMessageId;
    job.model = info.model === 'stable' || info.model === 'preview' ? info.model : job.model;
    job.enqueuedAt = Number.isFinite(info.createdAt) ? info.createdAt : job.enqueuedAt;
    job.state = info.state;
    job.queuePosition = Number.isSafeInteger(info.queuePosition) ? info.queuePosition : null;
    job.activity = typeof info.activity === 'string' ? info.activity : job.activity;
    job.tools = Array.isArray(info.tools) ? info.tools : job.tools;
    job.steering = normalizeSteeringSummary(info.steering || job.steering);
    state.job = job;
    reconcilePendingSteering(job);
    state.sending = false;
    clearAcceptedDraft(job);
    if (state.selectedModel !== job.model) state.selectedModel = job.model;
    renderSidebar();
    renderModelBar();

    if (info.state === 'done') {
      finishJob(job, info.reply != null ? String(info.reply) : job.streamText, info.usage, info.elapsedMs, !!quiet);
      return;
    }
    if (info.state === 'error') {
      failJob(job, typeof info.error === 'string' && info.error ? info.error : 'The turn failed.');
      return;
    }
    if (info.state !== 'queued' && info.state !== 'running') {
      throw new ApiError('The server returned an unknown turn state.', 0);
    }
    persistPendingTurn(job, info.state);
    setComposerStatus('');
    renderMessages(true);
    updateSendControls();
    openStream(job);
    startClock();
  }

  function markTurnUnconfirmed(job, message, status) {
    if (state.job !== job) return;
    stopJobPoll();
    closeStream();
    job.state = 'error';
    job.error = message;
    job.activity = status === 'retryable' ? 'Ready to retry safely' : 'Status unknown';
    persistPendingTurn(job, status || 'uncertain');
    stopClock();
    setComposerStatus(message, true);
    renderMessages(true);
    updateSendControls();
    refreshState();
  }

  function recoverSubmittedJob(job, originalError, retryableOnNotFound) {
    return lookupClientTurn(job.clientTurnId, 3)
      .then(function (info) {
        if (state.job !== job) return false;
        adoptClientTurn(job, info, false);
        return true;
      })
      .catch(function (lookupError) {
        if (state.job !== job) return false;
        var missing = lookupError && lookupError.status === 404;
        var detail = (originalError && originalError.message) || 'The connection ended before the server replied.';
        if (missing && retryableOnNotFound) {
          markTurnUnconfirmed(job, detail + ' The server did not accept it; retry will use the same turn id.', 'retryable');
        } else {
          markTurnUnconfirmed(job, detail + ' Its server status is unknown. Retry the same message or reload to recover it.', 'uncertain');
        }
        return false;
      });
  }

  function terminalClientState(info) {
    return !!info && (info.state === 'done' || info.state === 'error');
  }

  function waitForTerminalClientTurn(clientTurnId, attempts) {
    return lookupClientTurn(clientTurnId, 1).then(function (info) {
      if (terminalClientState(info) || attempts <= 1) return info;
      return waitMs(500).then(function () {
        return waitForTerminalClientTurn(clientTurnId, attempts - 1);
      });
    });
  }

  function resumeAfterStopAttempt(job, info, stopAccepted) {
    if (state.job !== job || job.state === 'done' || job.state === 'error') return;
    adoptClientTurn(job, info, true);
    if (state.job !== job || job.state === 'done' || job.state === 'error') return;
    if (!stopAccepted) job.stopRequested = false;
    job.activity = stopAccepted ? 'Waiting for stop confirmation' : 'Turn continues';
    persistPendingTurn(job, stopAccepted ? 'stopping' : job.state);
    setComposerStatus(stopAccepted
      ? 'Stop accepted; waiting for terminal confirmation…'
      : 'The stop could not be confirmed. The turn is still connected.', !stopAccepted);
    updateJobCard();
  }

  function issueSubmittedAbort(job, canReissue) {
    return request('/chat/by-client/' + encodeURIComponent(job.clientTurnId) + '/abort', { method: 'POST', body: {} })
      .then(function (result) {
        if (state.job !== job || job.state === 'done' || job.state === 'error') return;
        if (terminalClientState(result) && result.jobId) {
          adoptClientTurn(job, result, true);
          return;
        }
        if (result && result.aborted) {
          // A running job may need a moment to unwind. Do not label it stopped
          // until GET by-client reports a terminal state.
          return waitForTerminalClientTurn(job.clientTurnId, 4)
            .then(function (info) {
              if (state.job !== job || job.state === 'done' || job.state === 'error') return;
              if (terminalClientState(info)) adoptClientTurn(job, info, true);
              else resumeAfterStopAttempt(job, info, true);
            })
            .catch(function () {
              if (state.job === job && job.state !== 'done' && job.state !== 'error') {
                markTurnUnconfirmed(job, 'The stop request was accepted, but its terminal server status could not be confirmed. Reload to recover it.', 'uncertain');
              }
            });
        }
        return lookupClientTurn(job.clientTurnId, 3)
          .then(function (info) {
            if (state.job !== job || job.state === 'done' || job.state === 'error') return;
            if (terminalClientState(info)) {
              adoptClientTurn(job, info, true);
            } else if (canReissue) {
              return issueSubmittedAbort(job, false);
            } else {
              resumeAfterStopAttempt(job, info, false);
            }
          })
          .catch(function () {
            if (state.job === job && job.state !== 'done' && job.state !== 'error') {
              markTurnUnconfirmed(job, 'The stop status could not be confirmed. Retry the same message or reload to recover it.', 'uncertain');
            }
          });
      })
      .catch(function (abortError) {
        if (state.job !== job || job.state === 'done' || job.state === 'error') return;
        // The first abort may have raced ahead of enqueue. Find the turn and
        // reissue the abort once after it becomes visible.
        return lookupClientTurn(job.clientTurnId, 3)
          .then(function (info) {
            if (state.job !== job || job.state === 'done' || job.state === 'error') return;
            if (terminalClientState(info)) {
              adoptClientTurn(job, info, true);
            } else if (canReissue) {
              return issueSubmittedAbort(job, false);
            } else {
              resumeAfterStopAttempt(job, info, false);
            }
          })
          .catch(function () {
            if (state.job === job && job.state !== 'done' && job.state !== 'error') {
              markTurnUnconfirmed(job,
                ((abortError && abortError.message) || 'The stop request failed.') + ' Its server status is unknown; reload to recover it.',
                'uncertain');
            }
          });
      });
  }


  function newClientSteeringId() {
    return 'steer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }

  function requestSteering(job, message, clientSteeringId, attempts) {
    var path = job.clientTurnId
      ? '/chat/by-client/' + encodeURIComponent(job.clientTurnId) + '/steer'
      : '/chat/' + encodeURIComponent(job.jobId) + '/steer';
    return request(path, {
      method: 'POST',
      body: { message: message, clientSteeringId: clientSteeringId }
    }).catch(function (error) {
      if (attempts > 1 && (!error || !error.status || error.status >= 500)) {
        return waitMs(650).then(function () {
          return requestSteering(job, message, clientSteeringId, attempts - 1);
        });
      }
      throw error;
    });
  }


  function requireSeparateTurnConfirmation(job, message) {
    state.activeSendMode = 'queue';
    persistActiveSendMode();
    if (job) {
      job.pendingSteeringRequest = null;
      job.activity = 'Steering unavailable; waiting for your queue confirmation';
    }
    setComposerStatus(message, true);
    updateJobCard();
    updateSendControls();
    var input = $('#composer-input');
    if (input) input.focus();
  }

  function sendSteering(input) {
    if (!input || state.steering) return;
    var job = state.job;
    if (!job || job.state !== 'running' || job.stopRequested) {
      requireSeparateTurnConfirmation(job,
        'The current turn is no longer steerable. Queue next is selected; press send again to run this message separately.');
      return;
    }
    if (state.attachments.length) {
      requireSeparateTurnConfirmation(job,
        'Images cannot be injected into a running turn. Queue next is selected; press send again to run this message separately.');
      return;
    }
    var message = input.value.trim();
    if (!message) return;
    if (message.length > MAX_MESSAGE) {
      setComposerStatus('Message is too long (max ' + MAX_MESSAGE + ' chars).', true);
      return;
    }
    var previous = job.pendingSteeringRequest;
    var clientSteeringId = previous && previous.message === message
      ? previous.clientSteeringId
      : newClientSteeringId();
    job.pendingSteeringRequest = { clientSteeringId: clientSteeringId, message: message };
    state.steering = true;
    job.activity = 'Sending live steering instruction';
    setComposerStatus('Sending steering without interrupting the current turn…');
    updateJobCard();
    updateSendControls();

    requestSteering(job, message, clientSteeringId, 2).then(function (result) {
      state.steering = false;
      job.pendingSteeringRequest = null;
      if (result && result.steering) job.steering = normalizeSteeringSummary(result.steering);
      if (input.value.trim() === message) {
        input.value = '';
        resizeComposer(input);
      }
      var instruction = result && result.instruction;
      var applied = instruction && instruction.state === 'applied';
      var interrupted = instruction && instruction.interrupted;
      job.activity = applied
        ? 'Steering applied; revising the reply'
        : (interrupted ? 'Steering accepted; stopping the stale model draft' : 'Steering accepted; waiting for the next model step');
      setComposerStatus(applied
        ? 'Steering was already applied. Qwen is revising the current turn.'
        : (interrupted
          ? 'Steering accepted. The stale model draft is stopping so Qwen can replan now.'
          : 'Steering accepted. It will apply after the active tool finishes.'));
      announce('Steering instruction accepted.');
      if (state.job === job && job.state !== 'done' && job.state !== 'error') {
        persistPendingTurn(job, job.stopRequested ? 'stopping' : job.state);
      }
      renderMessages(false);
      updateSendControls();
      renderStrip();
      drainQueuedTurn();
    }).catch(function (error) {
      state.steering = false;
      if (!job.pendingSteeringRequest || job.pendingSteeringRequest.clientSteeringId !== clientSteeringId) {
        setComposerStatus('Steering was confirmed by the live stream.');
        updateSendControls();
        return;
      }
      if (error && (error.status === 404 || error.status === 409)) {
        requireSeparateTurnConfirmation(job,
          'The turn finished before steering was accepted. Your text is untouched; press send again to start it as a separate turn.');
        return;
      }
      job.activity = 'Steering status not confirmed; current turn continues';
      setComposerStatus(((error && error.message) || 'Could not confirm steering.') + ' Retry keeps the same instruction id.', true);
      updateJobCard();
      updateSendControls();
    });
  }

  function sendMessage() {
    var input = $('#composer-input');
    if (!input || state.sending || state.steering) return;
    if (currentJobActive()) {
      if (effectiveActiveSendMode() === 'steer') sendSteering(input);
      else queueCurrentDraft(input);
      return;
    }
    var message = input.value.trim();
    var attachments = state.attachments.slice();
    if (!message && !attachments.length) return;
    if (message.length > MAX_MESSAGE) {
      setComposerStatus('Message is too long (max ' + MAX_MESSAGE + ' chars).', true);
      return;
    }
    var pending = readPendingTurn();
    var reusePending = pending && (pending.status === 'uncertain' || pending.status === 'retryable')
      && pendingMatchesDraft(pending, state.selectedModel, message, attachments);
    if (pending && pending.status === 'uncertain' && !reusePending) {
      setComposerStatus('The previous turn still has an unknown server status. Retry the same message or reload before starting another.', true);
      return;
    }
    if (pending && pending.status === 'retryable' && !reusePending
      && pending.attachmentCount > 0 && pending.message === message && attachments.length === 0) {
      setComposerStatus('Reattach the image' + (pending.attachmentCount === 1 ? '' : 's') + ' before retrying that turn.', true);
      return;
    }
    if (pending && !reusePending) clearPendingTurn(pending.clientTurnId);

    state.sending = true;
    var submitController = new AbortController();
    state.submitController = submitController;
    setComposerStatus('');
    var job = {
      jobId: null,
      model: state.selectedModel,
      requestMessage: message,
      message: message || 'Attached ' + attachments.length + (attachments.length === 1 ? ' image' : ' images'),
      attachments: attachments,
      attachmentCount: attachments.length,
      attachmentKey: attachmentKey(attachments),
      state: 'submitting',
      queuePosition: null,
      enqueuedAt: Date.now(),
      streamText: '',
      reply: null,
      usage: null,
      elapsedMs: null,
      error: null,
      activity: 'Sending',
      tools: [],
      steering: emptySteeringSummary(),
      mode: 'sse'
    };
    job.clientTurnId = reusePending ? pending.clientTurnId : newClientTurnId();
    state.job = job;
    persistPendingTurn(job, 'submitting');
    renderMessages(true);
    updateSendControls();
    request('/chat', {
      method: 'POST',
      signal: submitController.signal,
      body: {
        message: message,
        model: job.model,
        sessionId: 'main',
        clientTurnId: job.clientTurnId,
        attachments: attachments.map(function (item) {
          return { fileName: item.fileName, mimeType: item.mimeType, content: item.content };
        })
      }
    }).then(function (created) {
      if (state.submitController === submitController) state.submitController = null;
      state.sending = false;
      if (!created || typeof created.jobId !== 'string' || !created.jobId) {
        throw new ApiError('The server did not return a job id.', 0);
      }
      adoptClientTurn(job, created, false);
    }).catch(function (err) {
      if (state.submitController === submitController) state.submitController = null;
      state.sending = false;
      if (submitController.signal.aborted) {
        // abortJob owns confirmation for user-requested stops. A local fetch
        // abort alone does not prove the server did not enqueue the turn.
        if (state.authenticated && !job.stopRequested && job.state !== 'error') {
          recoverSubmittedJob(job, new Error('The send was interrupted.'), false);
        }
        return;
      }
      setComposerStatus('Checking whether the server accepted this turn…');
      recoverSubmittedJob(job, err, true);
    });
  }

  /* --- SSE stream --- */

  function openStream(job) {
    closeStream();
    var controller = new AbortController();
    state.streamController = controller;
    fetch(API + '/chat/' + encodeURIComponent(job.jobId) + '/stream', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'text/event-stream' },
      signal: controller.signal
    }).then(function (res) {
      if (!res.ok || !res.body) throw new ApiError('Stream failed (' + res.status + ')', res.status);
      job.mode = 'sse';
      return consumeSse(res.body.getReader(), job, controller);
    }).catch(function (err) {
      if (controller.signal.aborted) return;
      if (job.state === 'done' || job.state === 'error') return;
      // graceful degradation: poll the job endpoint instead
      job.mode = 'poll';
      setComposerStatus('Live stream unavailable (' + ((err && err.message) || 'network error') + '); polling instead.');
      updateJobCard();
      startJobPoll(job);
    });
  }

  function consumeSse(reader, job, controller) {
    var decoder = new TextDecoder();
    var buffer = '';
    var eventName = '';
    var dataLines = [];

    function dispatch() {
      var name = eventName;
      var raw = dataLines.join('\n');
      eventName = '';
      dataLines = [];
      if (!name || !raw) return;
      var data;
      try { data = JSON.parse(raw); } catch (e) { return; }
      handleSseEvent(job, name, data || {}, controller);
    }

    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          processChunk(true);
          dispatch();
          handleStreamEnd(job, controller);
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        processChunk(null);
        return pump();
      });
    }

    function processChunk(force) {
      var index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        var line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
        handleLine(line);
      }
      if (force) {
        var rest = buffer;
        buffer = '';
        if (rest) handleLine(rest);
      }
    }

    function handleLine(line) {
      if (!line) { dispatch(); return; }
      if (line.charAt(0) === ':') return; // heartbeat comment
      if (line.indexOf('event:') === 0) { eventName = line.slice(6).trim(); return; }
      if (line.indexOf('data:') === 0) {
        var value = line.slice(5);
        if (value.charAt(0) === ' ') value = value.slice(1);
        dataLines.push(value);
      }
    }

    return pump();
  }

  function handleSseEvent(job, name, data, controller) {
    if (state.job !== job) return;
    if (name === 'status') {
      if (data.state === 'queued') {
        job.state = 'queued';
        job.queuePosition = Number.isSafeInteger(data.queuePosition) ? data.queuePosition : job.queuePosition;
      } else if (data.state === 'running') {
        job.state = 'running';
        job.queuePosition = null;
      }
      if (data.steering) {
        job.steering = normalizeSteeringSummary(data.steering);
        reconcilePendingSteering(job);
      }
      persistPendingTurn(job, job.stopRequested ? 'stopping' : job.state);
      updateJobCard();
      updateSendControls();
    } else if (name === 'delta') {
      if (typeof data.text === 'string' && data.text) {
        if (job.state !== 'running') { job.state = 'running'; }
        appendDelta(job, data.text);
      }
    } else if (name === 'activity') {
      if (typeof data.label === 'string' && data.label) job.activity = data.label;
      if (data.tool) {
        var active = job.tools.filter(function (tool) {
          return tool && tool.label === data.tool && tool.status === 'running';
        })[0];
        if (active) active.status = data.status || active.status;
        else if (data.status === 'running') {
          job.tools.push({ label: String(data.tool), status: 'running', time: new Date().toISOString() });
        }
        job.tools = job.tools.slice(-20);
      }
      updateJobCard();
    } else if (name === 'steer') {
      applySteeringEvent(job, data);
    } else if (name === 'done') {
      if (Array.isArray(data.tools)) job.tools = data.tools;
      finishJob(job, data.reply != null ? String(data.reply) : job.streamText, data.usage, data.elapsedMs);
    } else if (name === 'error') {
      failJob(job, typeof data.error === 'string' && data.error ? data.error : 'The turn failed.');
    }
  }

  function appendDelta(job, text) {
    job.streamText += text;
    var bubble = $('#stream-bubble');
    if (!bubble) {
      var typing = $('#typing-indicator');
      if (typing) typing.remove();
      renderMessages(false);
      bubble = $('#stream-bubble');
    }
    if (bubble) scheduleStreamingMarkdown(job);
  }

  function handleStreamEnd(job, controller) {
    if (state.job !== job) return;
    if (job.state === 'done' || job.state === 'error') return;
    // server closed without done/error: verify via one poll cycle
    job.mode = 'poll';
    startJobPoll(job);
  }

  function closeStream() {
    if (state.streamController) {
      try { state.streamController.abort(); } catch (e) { /* noop */ }
      state.streamController = null;
    }
  }

  /* --- poll fallback --- */

  function startJobPoll(job) {
    stopJobPoll();
    var tick = function () {
      if (state.job !== job || !job.jobId) return;
      if (job.state === 'done' || job.state === 'error') return;
      request('/chat/' + encodeURIComponent(job.jobId))
        .then(function (info) {
          if (state.job !== job) return;
          if (!info) return;
          if (info.state === 'done') {
            if (Array.isArray(info.tools)) job.tools = info.tools;
            finishJob(job, info.reply != null ? String(info.reply) : job.streamText, null, info.elapsedMs);
          } else if (info.state === 'error') {
            failJob(job, typeof info.error === 'string' && info.error ? info.error : 'The turn failed.');
          } else {
            job.state = info.state === 'running' ? 'running' : 'queued';
            job.queuePosition = Number.isSafeInteger(info.queuePosition) ? info.queuePosition : job.queuePosition;
            if (typeof info.activity === 'string') job.activity = info.activity;
            if (Array.isArray(info.tools)) job.tools = info.tools;
            if (info.steering) {
              job.steering = normalizeSteeringSummary(info.steering);
              reconcilePendingSteering(job);
            }
            persistPendingTurn(job, job.stopRequested ? 'stopping' : job.state);
            updateJobCard();
            updateSendControls();
            state.pollTimer = setTimeout(tick, JOB_POLL_MS);
          }
        })
        .catch(function (err) {
          if (state.job !== job) return;
          if (err && err.status === 404) {
            markTurnUnconfirmed(job, 'That turn is no longer tracked (the server may have restarted). Retry will use the same turn id.', 'retryable');
            return;
          }
          state.pollTimer = setTimeout(tick, JOB_POLL_MS * 2);
        });
    };
    state.pollTimer = setTimeout(tick, 400);
  }

  function stopJobPoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /* --- job finish/fail/abort --- */

  function finishJob(job, reply, usage, elapsedMs, quiet) {
    if (state.job !== job) return;
    stopJobPoll();
    closeStream();
    clearPendingTurn(job.clientTurnId);
    job.state = 'done';
    job.reply = reply;
    job.usage = usage || null;
    job.elapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : (Date.now() - job.enqueuedAt);
    stopClock();
    if (!quiet) {
      notifyReply(reply);
      announce('Reply received.');
    }
    setComposerStatus('');
    renderMessages(true);
    updateSendControls();
    // Reconcile with server history, then hand the composer to the next
    // queued turn. The queue must continue even if a history refresh fails.
    loadHistory(job.model, false).then(function () {
      if (state.job === job && job.state === 'done') {
        state.job = null;
        renderMessages(false);
      }
      refreshState();
      drainQueuedTurn();
    });
  }

  function failJob(job, message) {
    if (state.job !== job) return;
    stopJobPoll();
    closeStream();
    clearPendingTurn(job.clientTurnId);
    job.state = 'error';
    job.error = message;
    stopClock();
    setComposerStatus(message, true);
    announce('Turn failed: ' + message);
    renderMessages(true);
    updateSendControls();
    loadHistory(job.model, false).then(function () {
      if (state.job === job && job.state === 'error') {
        state.job = null;
        renderMessages(false);
      }
      refreshState();
      drainQueuedTurn();
    });
  }

  function abortJob() {
    var job = state.job;
    if (!job || job.state === 'done' || job.state === 'error') return;
    if (job.stopInFlight) return;
    if (job.clientTurnId) {
      job.stopInFlight = true;
      job.stopRequested = true;
      var controller = state.submitController;
      state.submitController = null;
      state.sending = false;
      if (controller) {
        try { controller.abort(); } catch (e) { /* noop */ }
      }
      job.activity = 'Confirming stop with server';
      persistPendingTurn(job, 'stopping');
      setComposerStatus('Confirming stop with the server…');
      updateJobCard();
      updateSendControls();
      // Use a fresh request: aborting a submission fetch does not prove the
      // server did not accept and enqueue it. The same path also keeps normal
      // stops honest by waiting for a terminal snapshot.
      issueSubmittedAbort(job, true).then(function () {
        job.stopInFlight = false;
        if (state.job === job) updateSendControls();
      }, function () {
        job.stopInFlight = false;
        if (state.job === job) updateSendControls();
      });
      return;
    }
    if (!job.jobId) return;
    setComposerStatus('Stopping…');
    request('/chat/' + encodeURIComponent(job.jobId) + '/abort', { method: 'POST', body: {} })
      .then(function (result) {
        if (state.job !== job) return;
        if (result && result.aborted) {
          failJob(job, 'Turn stopped by you.');
        } else {
          setComposerStatus('The turn could not be stopped (it may already be finishing).', true);
          refreshState();
        }
      })
      .catch(function (err) {
        setComposerStatus((err && err.message) || 'Abort failed.', true);
      });
  }

  /* --- live elapsed clock --- */

  function startClock() {
    stopClock();
    state.clockTimer = setInterval(function () { renderStrip(); }, 1000);
  }

  function stopClock() {
    if (state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
    renderStrip();
  }

  /* ---------------- state endpoint + always-on strip ---------------- */

  function refreshState() {
    return request('/state')
      .then(function (payload) {
        state.meshState = payload || null;
        state.meshStateError = '';
        renderStrip();
        renderSidebar();
        renderModelBar();
      })
      .catch(function (err) {
        state.meshStateError = (err && err.message) || 'State unavailable.';
        renderStrip();
      });
  }

  function startStatePolling() {
    stopStatePolling();
    refreshState();
    state.stateTimer = setInterval(refreshState, STATE_POLL_MS);
  }

  function stopStatePolling() {
    if (state.stateTimer) {
      clearInterval(state.stateTimer);
      state.stateTimer = null;
    }
  }

  function renderStrip() {
    var strip = $('#status-strip-inner');
    if (!strip) return;
    strip.replaceChildren();
    var modelId = state.selectedModel;
    var info = meshModel(modelId);
    var lane = laneInfo(modelId);
    var job = state.job;
    var jobActive = job && job.model === modelId && job.state !== 'done' && job.state !== 'error';

    // model
    var modelItem = el('span', 'strip-item');
    modelItem.appendChild(el('strong', '', modelInfo(modelId).label));
    strip.appendChild(modelItem);

    // lane status
    var laneItem = el('span', 'strip-item');
    var dotClass = 'status-dot idle';
    var laneText = 'Lane idle';
    if (jobActive && job.state === 'queued') {
      dotClass = 'status-dot busy';
      laneText = 'Queued';
    } else if (jobActive || lane.running || (info && info.busy)) {
      dotClass = 'status-dot running';
      laneText = jobActive && job.activity ? job.activity : 'Lane busy';
    }
    laneItem.appendChild(el('span', dotClass));
    laneItem.appendChild(el('span', '', laneText));
    strip.appendChild(laneItem);

    // queue position
    if (jobActive && job.state === 'queued') {
      var qp = el('span', 'strip-item strip-queue');
      qp.textContent = job.queuePosition ? 'Queue position ' + job.queuePosition : 'Waiting for a free lane';
      strip.appendChild(qp);
    } else if (!jobActive && lane.queued > 0) {
      var q2 = el('span', 'strip-item strip-queue');
      q2.textContent = lane.queued + ' queued';
      strip.appendChild(q2);
    }

    if (jobActive) {
      var steeringStatus = normalizeSteeringSummary(job.steering);
      if (steeringStatus.pending) {
        var steerItem = el('span', 'strip-item strip-steering');
        steerItem.textContent = steeringStatus.pending + (steeringStatus.pending === 1 ? ' steering instruction waiting' : ' steering instructions waiting');
        strip.appendChild(steerItem);
      }
    }

    // elapsed
    var elapsedItem = el('span', 'strip-item');
    var elapsedMs = null;
    if (jobActive) elapsedMs = Date.now() - job.enqueuedAt;
    else if (lane.running && Number.isFinite(lane.running.elapsedMs)) elapsedMs = lane.running.elapsedMs;
    else if (info && info.busy && Number.isFinite(info.turnElapsedSeconds)) elapsedMs = info.turnElapsedSeconds * 1000;
    if (elapsedMs != null) {
      elapsedItem.appendChild(el('span', '', 'Elapsed'));
      var clock = el('span', '');
      clock.id = 'status-elapsed';
      clock.textContent = fmtClock(elapsedMs);
      elapsedItem.appendChild(clock);
    } else {
      elapsedItem.appendChild(el('span', '', 'Idle'));
    }
    strip.appendChild(elapsedItem);

    // token / window gauge
    if (info && info.stats) {
      var stats = info.stats;
      var total = Number.isFinite(stats.totalTokens) ? stats.totalTokens : 0;
      var window_ = Number.isFinite(stats.contextTokens) && stats.contextTokens > 0 ? stats.contextTokens : 262144;
      var pct = Math.min(100, Math.round((total / window_) * 100));
      var gauge = el('span', 'strip-item token-gauge');
      gauge.title = total.toLocaleString() + ' of ' + window_.toLocaleString() + ' context tokens (' + pct + '%)';
      var track = el('span', 'token-gauge-track');
      var fill = el('span', 'token-gauge-fill' + (pct >= 80 ? ' hot' : ''));
      fill.style.width = pct + '%';
      track.appendChild(fill);
      gauge.appendChild(el('span', '', 'Tokens'));
      gauge.appendChild(track);
      gauge.appendChild(el('span', '', fmtTokens(total) + ' / ' + fmtTokens(window_)));
      strip.appendChild(gauge);
    }

    // errors: job error, state lastError, provider progress errors, transport error
    var errorText = '';
    if (jobActive === false && job && job.model === modelId && job.state === 'error' && job.error) {
      errorText = job.error;
    } else if (info && info.lastError && info.lastError.error) {
      errorText = String(info.lastError.error);
    } else if (info && info.progress && info.progress.latestError) {
      errorText = String(info.progress.latestError);
    } else if (state.meshStateError) {
      errorText = 'Status: ' + state.meshStateError;
    }
    if (errorText) {
      var err = el('span', 'strip-item strip-error');
      err.appendChild(el('strong', '', 'Error:'));
      err.appendChild(el('span', '', errorText));
      strip.appendChild(err);
    }
  }

  function recoverPendingTurn() {
    var pending = readPendingTurn();
    if (!pending) return Promise.resolve(false);
    if (pending.username && pending.username !== state.username) {
      clearPendingTurn(pending.clientTurnId);
      return Promise.resolve(false);
    }

    var job = hydrateRecoveredJob(pending, {});
    job.state = 'submitting';
    job.activity = 'Recovering saved turn';
    state.job = job;
    state.sending = false;
    state.selectedModel = job.model;
    var input = $('#composer-input');
    if (input && !input.value && pending.message) {
      input.value = pending.message;
      resizeComposer(input);
    }
    setComposerStatus('Recovering the turn from the server…');
    renderSidebar();
    renderModelBar();
    renderMessages(true);
    updateSendControls();

    return lookupClientTurn(pending.clientTurnId, 3)
      .then(function (info) {
        if (state.job !== job) return false;
        adoptClientTurn(job, info, true);
        if (pending.status === 'stopping' && state.job === job
          && job.state !== 'done' && job.state !== 'error') {
          job.stopRequested = true;
          job.stopInFlight = true;
          job.activity = 'Restoring stop request';
          persistPendingTurn(job, 'stopping');
          setComposerStatus('Restoring the pending stop request…');
          updateJobCard();
          updateSendControls();
          return issueSubmittedAbort(job, true).then(function () {
            job.stopInFlight = false;
            if (state.job === job) updateSendControls();
            return true;
          }, function () {
            job.stopInFlight = false;
            if (state.job === job) updateSendControls();
            return false;
          });
        }
        return true;
      })
      .catch(function (err) {
        if (state.job !== job) return false;
        if (err && err.status === 404 && pending.status !== 'stopping') {
          markTurnUnconfirmed(job,
            pending.attachmentCount > 0
              ? 'The saved image turn is no longer tracked. Reattach the image' + (pending.attachmentCount === 1 ? '' : 's') + ' to retry it safely.'
              : 'The saved turn is no longer tracked. Retry will use the same turn id.',
            'retryable');
        } else {
          markTurnUnconfirmed(job,
            pending.status === 'stopping'
              ? 'The final stop status is unknown. Reload when connected to check again.'
              : 'Could not confirm the saved turn with the server. Retry the same message or reload to recover it.',
            'uncertain');
        }
        return false;
      });
  }

  /* ---------------- lifecycle ---------------- */

  function enterApp() {
    renderApp();
    initNotifications();
    updateNotificationButton();
    loadHistory(state.selectedModel, true);
    state.models.forEach(function (model) {
      if (model.id !== state.selectedModel) loadHistory(model.id, false);
    });
    startStatePolling();
    return recoverPendingTurn().then(function (recovered) {
      if (!state.job) drainQueuedTurn();
      return recovered;
    });
  }

  function logout() {
    request('/logout', { method: 'POST', body: {} })
      .then(function () {
        stopAll();
        state.authenticated = false;
        state.csrfToken = '';
        state.histories = {};
        state.job = null;
        state.queuedTurns = [];
        persistQueuedTurns();
        state.meshState = null;
        renderLogin('');
      })
      .catch(function (error) {
        showToast((error && error.message) || 'Could not sign out.');
      });
  }

  function stopAll() {
    stopStatePolling();
    stopJobPoll();
    closeStream();
    if (state.submitController) {
      state.submitController.abort();
      state.submitController = null;
    }
    if (state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
  }

  function boot() {
    request('/session')
      .then(function (session) {
        if (applySession(session)) {
          return enterApp();
        }
        renderLogin('');
      })
      .catch(function () {
        renderLogin('');
      });
  }

  window.addEventListener('resize', function () { updateSidebarToggleIcon(); });
  window.addEventListener('pagehide', function () {
    if (state.job) persistPendingTurn(state.job, state.job.stopRequested ? 'stopping' : state.job.state);
  });
  window.addEventListener('pageshow', function (event) {
    // Back/Forward cache can preserve the old DOM while its stream has gone stale.
    if (event.persisted && state.authenticated && readPendingTurn()) recoverPendingTurn();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
