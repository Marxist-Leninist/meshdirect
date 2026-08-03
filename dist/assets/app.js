/* Qwen 3.8 Mesh — meshdirect frontend (no build step, ES2020, Android WebView safe) */
(function () {
  'use strict';

  var BASE = '/qwen38';
  var API = BASE + '/api';
  var NOTIFY_KEY = 'meshdirect.notifications';
  var STATE_POLL_MS = 5000;
  var JOB_POLL_MS = 2500;
  var MAX_MESSAGE = 12000;

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
    drawerOpen: false,
    sidebarCollapsed: false,
    notificationsEnabled: false,
    sending: false
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
    chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z"/>'
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
          '<p class="form-message" id="login-message" role="alert"></p>' +
          '<div class="login-note">The model and SG credentials remain on the server. Your account password is sent only over HTTPS.</div>' +
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
              '<button class="icon-button" id="logout-button" type="button">' + icon('logout', 18) + '<span>Sign out</span></button>' +
            '</div>' +
          '</header>' +
          '<nav class="model-bar" id="model-bar" aria-label="Qwen model"></nav>' +
          '<section class="chat-region" id="chat-region" aria-label="Conversation" tabindex="-1"><div class="messages" id="messages"></div></section>' +
          '<div class="status-strip" id="status-strip" role="status"><div class="status-strip-inner" id="status-strip-inner"></div></div>' +
          '<footer class="composer-shell">' +
            '<form class="composer" id="composer-form">' +
              '<label class="sr-only" for="composer-input">Message Qwen</label>' +
              '<textarea id="composer-input" maxlength="' + MAX_MESSAGE + '" rows="1" placeholder="Message Qwen..." required></textarea>' +
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
    $('#composer-form').addEventListener('submit', function (event) { event.preventDefault(); sendMessage(); });
    $('#abort-button').addEventListener('click', abortJob);
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
        if (lane.running) sub = (lane.running.activity || 'running') + ' · ' + fmtClock(lane.running.elapsedMs) + ' · ' + sub;
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
      if (lane.running) detail = (lane.running.activity || 'Running') + ' · ' + fmtClock(lane.running.elapsedMs);
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

  function messageNode(message) {
    var wrap = el('article', 'message ' + (message.role === 'user' ? 'user' : 'assistant'));
    var meta = el('div', 'message-meta');
    meta.appendChild(el('span', '', message.role === 'user' ? 'You' : 'Qwen'));
    var ts = fmtTimestamp(message.timestamp);
    if (ts) meta.appendChild(el('span', '', ts));
    var bubble = el('div', 'message-bubble');
    bubble.textContent = message.content || '';
    wrap.appendChild(meta);
    wrap.appendChild(bubble);
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

  function renderToolTimeline(container, tools) {
    if (!Array.isArray(tools) || !tools.length) return;
    var timeline = el('section', 'tool-timeline');
    timeline.setAttribute('aria-label', 'Agent tool activity');
    var heading = el('div', 'tool-timeline-heading');
    heading.appendChild(el('strong', '', 'Agent actions'));
    heading.appendChild(el('span', '', tools.length + (tools.length === 1 ? ' tool call' : ' tool calls')));
    timeline.appendChild(heading);
    tools.slice(-20).forEach(function (tool) {
      var status = tool && tool.status ? String(tool.status) : 'running';
      var row = el('div', 'tool-row ' + status);
      row.appendChild(el('span', 'tool-state-dot'));
      var copy = el('span', 'tool-row-copy');
      copy.appendChild(el('strong', '', tool && (tool.label || tool.name) ? String(tool.label || tool.name) : 'tool'));
      var detail = tool && tool.summary ? String(tool.summary) : (status === 'running' ? 'running…' : status);
      if (tool && Number.isFinite(tool.durationMs) && status !== 'running') detail += ' · ' + fmtClock(tool.durationMs);
      copy.appendChild(el('span', '', detail));
      row.appendChild(copy);
      timeline.appendChild(row);
    });
    container.appendChild(timeline);
  }

  function renderActiveJob(container) {
    var job = state.job;
    if (!job || job.model !== state.selectedModel) return;

    // optimistic user bubble
    var user = el('article', 'message user');
    var umeta = el('div', 'message-meta');
    umeta.appendChild(el('span', '', 'You'));
    user.appendChild(umeta);
    user.appendChild(el('div', 'message-bubble', job.message));
    container.appendChild(user);

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
      bubble.textContent = job.reply != null ? job.reply : job.streamText;
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

    renderToolTimeline(container, job.tools);

    // turn state card
    if (job.state !== 'done') {
      var card = el('div', 'turn-state ' + (job.state === 'error' ? 'failed' : (job.state === 'queued' || job.state === 'submitting') ? 'queued' : 'running'));
      var summary = el('div', 'turn-state-summary');
      summary.appendChild(el('span', 'turn-state-marker'));
      var text;
      if (job.state === 'error') text = 'Turn failed: ' + (job.error || 'Unknown error');
      else if (job.state === 'queued') text = 'Queued' + (job.queuePosition ? ' · position ' + job.queuePosition : '') + ' · ' + fmtClock(Date.now() - job.enqueuedAt);
      else if (job.state === 'submitting') text = 'Sending…';
      else {
        var activity = job.activity || 'running';
        var counters = [];
        if (job.step) counters.push('step ' + job.step);
        if (job.toolCalls) counters.push(job.toolCalls + (job.toolCalls === 1 ? ' tool' : ' tools'));
        text = activity + ' · ' + fmtClock(Date.now() - job.enqueuedAt) + (counters.length ? ' · ' + counters.join(' · ') : '') + (job.mode === 'poll' ? ' · polling' : ' · live');
      }
      summary.appendChild(el('span', '', text));
      card.appendChild(summary);
      container.appendChild(card);
    }
  }

  function updateJobCard() {
    // light-touch: update card + typing without full re-render
    renderMessages(false);
  }

  /* ---------------- history ---------------- */

  function loadHistory(modelId, scroll) {
    var hist = state.histories[modelId] || { messages: [], loaded: false, error: '' };
    state.histories[modelId] = hist;
    if (modelId === state.selectedModel) renderMessages(!!scroll);
    return request('/history?model=' + encodeURIComponent(modelId) + '&sessionId=main&limit=120')
      .then(function (payload) {
        var messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
        hist.messages = messages.map(function (m) {
          return {
            id: m && m.id,
            role: m && m.role === 'user' ? 'user' : 'assistant',
            content: m && typeof m.content === 'string' ? m.content : '',
            timestamp: m ? m.timestamp : null,
            tools: m && Array.isArray(m.tools) ? m.tools : []
          };
        });
        hist.loaded = true;
        hist.error = '';
        if (modelId === state.selectedModel && !state.job) renderMessages(!!scroll);
        else if (modelId === state.selectedModel) renderMessages(false);
      })
      .catch(function (err) {
        if (hist.loaded) return; // keep stale history on refresh failure
        hist.loaded = false;
        hist.error = (err && err.message) || 'Could not load history.';
        if (modelId === state.selectedModel) renderMessages(false);
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
    var send = $('#send-button');
    var abort = $('#abort-button');
    var input = $('#composer-input');
    var active = !!state.job && state.job.state !== 'done' && state.job.state !== 'error';
    if (send) {
      send.hidden = active;
      send.disabled = state.sending;
    }
    if (abort) abort.hidden = !active;
    if (input) input.disabled = false; // composing during a turn is allowed; send is blocked below
  }

  function sendMessage() {
    var input = $('#composer-input');
    if (!input || state.sending) return;
    if (state.job && state.job.state !== 'done' && state.job.state !== 'error') {
      setComposerStatus('A turn is already in progress. Stop it first.', true);
      return;
    }
    var message = input.value.trim();
    if (!message) return;
    if (message.length > MAX_MESSAGE) {
      setComposerStatus('Message is too long (max ' + MAX_MESSAGE + ' chars).', true);
      return;
    }
    state.sending = true;
    setComposerStatus('');
    var job = {
      jobId: null,
      model: state.selectedModel,
      message: message,
      state: 'submitting',
      queuePosition: null,
      enqueuedAt: Date.now(),
      streamText: '',
      reply: null,
      usage: null,
      elapsedMs: null,
      error: null,
      mode: 'sse',
      activity: 'submitting',
      step: 0,
      toolCalls: 0,
      currentTool: null,
      tools: []
    };
    state.job = job;
    renderMessages(true);
    updateSendControls();
    request('/chat', {
      method: 'POST',
      body: { message: message, model: job.model, sessionId: 'main' }
    }).then(function (created) {
      state.sending = false;
      input.value = '';
      resizeComposer(input);
      if (!created || typeof created.jobId !== 'string' || !created.jobId) {
        throw new ApiError('The server did not return a job id.', 0);
      }
      job.jobId = created.jobId;
      job.state = created.state === 'running' ? 'running' : 'queued';
      job.queuePosition = Number.isSafeInteger(created.queuePosition) ? created.queuePosition : null;
      setComposerStatus('');
      updateJobCard();
      openStream(job);
      startClock();
    }).catch(function (err) {
      state.sending = false;
      job.state = 'error';
      job.error = (err && err.message) || 'Could not send the message.';
      setComposerStatus(job.error, true);
      updateJobCard();
      updateSendControls();
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
      updateJobCard();
    } else if (name === 'delta') {
      if (typeof data.text === 'string' && data.text) {
        if (job.state !== 'running') { job.state = 'running'; }
        appendDelta(job, data.text);
      }
    } else if (name === 'done') {
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
    if (bubble) {
      bubble.textContent = job.streamText;
      scrollToBottom(false);
    }
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
            finishJob(job, info.reply != null ? String(info.reply) : job.streamText, null, info.elapsedMs);
          } else if (info.state === 'error') {
            failJob(job, typeof info.error === 'string' && info.error ? info.error : 'The turn failed.');
          } else {
            job.state = info.state === 'running' ? 'running' : 'queued';
            job.queuePosition = Number.isSafeInteger(info.queuePosition) ? info.queuePosition : job.queuePosition;
            updateJobCard();
            state.pollTimer = setTimeout(tick, JOB_POLL_MS);
          }
        })
        .catch(function (err) {
          if (state.job !== job) return;
          if (err && err.status === 404) {
            failJob(job, 'That turn is no longer tracked (server restarted?). Send it again.');
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

  function finishJob(job, reply, usage, elapsedMs) {
    if (state.job !== job) return;
    stopJobPoll();
    closeStream();
    job.state = 'done';
    job.reply = reply;
    job.usage = usage || null;
    job.elapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : (Date.now() - job.enqueuedAt);
    stopClock();
    notifyReply(reply);
    announce('Reply received.');
    setComposerStatus('');
    renderMessages(true);
    updateSendControls();
    // reconcile with server history, then clear the optimistic job view
    loadHistory(job.model, false).then(function () {
      if (state.job === job && job.state === 'done') {
        state.job = null;
        renderMessages(false);
      }
      refreshState();
    });
  }

  function failJob(job, message) {
    if (state.job !== job) return;
    stopJobPoll();
    closeStream();
    job.state = 'error';
    job.error = message;
    stopClock();
    setComposerStatus(message, true);
    announce('Turn failed: ' + message);
    renderMessages(true);
    updateSendControls();
    refreshState();
  }

  function abortJob() {
    var job = state.job;
    if (!job || !job.jobId || job.state === 'done' || job.state === 'error') return;
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
      laneText = 'Lane busy';
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
    return Promise.resolve();
  }

  function logout() {
    request('/logout', { method: 'POST', body: {} })
      .catch(function () { /* even on failure, drop local session */ })
      .then(function () {
        stopAll();
        state.authenticated = false;
        state.csrfToken = '';
        state.histories = {};
        state.job = null;
        state.meshState = null;
        renderLogin('');
      });
  }

  function stopAll() {
    stopStatePolling();
    stopJobPoll();
    closeStream();
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
