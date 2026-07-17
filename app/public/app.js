let currentStatusFilter = '';
let logSearchTerm = '';
let brokerSearchTerm = '';
let lastLogs = [];
let lastBrokers = [];
let waReady = false;
const selectedIds = new Set();
let backupPromptHandled = false;
let backupRefreshInFlight = null;
let lastBackupStatus = null;
let backupModalReturnFocus = null;

// ---------- Theme ----------
const THEME_KEY = 'broker-desk-theme';
function applyStoredTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored) document.documentElement.setAttribute('data-theme', stored);
}
applyStoredTheme();

document.getElementById('themeToggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme')
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
});

// ---------- Toasts ----------
const TOAST_ICON = { success: '✓', error: '✕', info: 'ℹ' };
function showToast(message, type = 'info') {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_ICON[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABEL = {
  needs_info: 'needs info',
  draft: 'draft',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  send_uncertain: 'verify first',
};
const SENDABLE_STATUSES = new Set(['draft', 'failed']);
const EDITABLE_STATUSES = new Set(['needs_info', 'draft', 'failed']);
const WHATSAPP_STATUS_LABEL = {
  starting: 'starting',
  needs_setup: 'setup needed',
  pairing: 'phone code',
  qr: 'QR code',
  authenticated: 'finishing login',
  ready: 'connected',
  disconnected: 'disconnected',
  not_configured: 'not configured',
};

// ---------- WhatsApp connection box ----------
// Only rebuilds the box's HTML when the meaningful state actually changes, so
// a user mid-typing their phone number doesn't get wiped out on the next poll.
// Uses the full qrDataUrl (not just whether one exists) because WhatsApp
// rotates the QR code every ~20-40s while waiting for a scan - comparing only
// a '1'/'0' flag would keep displaying an already-expired code forever.
let lastConnBoxKey = null;
let connectionView = null;
let lastWhatsappStatus = null;
let lastProviderRevision = null;
let lastProviderInstanceId = null;
let statusRequestSequence = 0;
let newestAppliedStatusRequest = 0;
let connectionActionSequence = 0;
let activeConnectionAction = null;

const CONNECTION_POST_TIMEOUT_MS = 60000;
const CONNECTION_POLL_TIMEOUT_MS = 60000;
const CONNECTION_POLL_INTERVAL_MS = 1000;
const STATUS_FETCH_TIMEOUT_MS = 8000;

function providerRevisionOf(wa) {
  if (!wa || wa.revision === undefined || wa.revision === null || wa.revision === '') return null;
  const value = Number(wa.revision);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function providerInstanceIdOf(wa) {
  if (!wa || wa.instanceId === undefined || wa.instanceId === null || wa.instanceId === '') return null;
  return String(wa.instanceId);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectionStateChanged(current, baseline) {
  if (!current || !baseline) return true;
  return current.status !== baseline.status
    || providerInstanceIdOf(current) !== providerInstanceIdOf(baseline)
    || current.qrDataUrl !== baseline.qrDataUrl
    || current.pairingCode !== baseline.pairingCode
    || current.lastError !== baseline.lastError;
}

async function pollForConnectionState(actionId, baseline, { includeNeedsSetup = false } = {}) {
  const deadline = Date.now() + CONNECTION_POLL_TIMEOUT_MS;
  let sawIntermediateState = false;
  const baselineRevision = providerRevisionOf(baseline);

  while (Date.now() < deadline && activeConnectionAction?.id === actionId) {
    const wa = await refreshStatus();
    if (activeConnectionAction?.id !== actionId) return { settled: false, superseded: true };
    if (wa) {
      const revision = providerRevisionOf(wa);
      const revisionAdvanced = revision !== null && baselineRevision !== null && revision > baselineRevision;
      const stateChanged = connectionStateChanged(wa, baseline);
      if (wa.status === 'starting' || wa.status === 'authenticated') sawIntermediateState = true;

      const terminal = ['qr', 'pairing', 'ready', 'disconnected'].includes(wa.status)
        || (includeNeedsSetup && wa.status === 'needs_setup');
      if (terminal && (revisionAdvanced || stateChanged || sawIntermediateState || wa.status === 'ready')) {
        return { settled: true, wa };
      }
    }
    await waitMs(CONNECTION_POLL_INTERVAL_MS);
  }
  return { settled: false, superseded: activeConnectionAction?.id !== actionId };
}

async function connectionPost(url, body, button, {
  workingLabel = 'Working…',
  includeNeedsSetup = false,
} = {}) {
  const previousAction = activeConnectionAction;
  if (previousAction) previousAction.controller.abort('superseded');

  const actionId = ++connectionActionSequence;
  const controller = new AbortController();
  const action = { id: actionId, controller };
  activeConnectionAction = action;
  const idleLabel = button?.textContent || 'Try again';
  const baseline = lastWhatsappStatus ? { ...lastWhatsappStatus } : null;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort('timeout');
  }, CONNECTION_POST_TIMEOUT_MS);

  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHtml(workingLabel)}</span>`;
  }
  try {
    const options = { method: 'POST' };
    options.signal = controller.signal;
    if (body !== undefined && body !== null) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    clearTimeout(timeout);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'WhatsApp setup could not be started.');
    connectionView = null;
    lastConnBoxKey = null;
    const outcome = await pollForConnectionState(actionId, baseline, { includeNeedsSetup });
    if (!outcome.settled && !outcome.superseded && activeConnectionAction?.id === actionId) {
      showToast('WhatsApp is taking longer than expected. Check the status shown here, then try again or reset the setup.', 'error');
    }
    return outcome.settled;
  } catch (err) {
    if (activeConnectionAction?.id !== actionId) return false;
    const message = timedOut || err.name === 'AbortError'
      ? 'WhatsApp did not respond in time. Try again, switch linking method, or reset the setup.'
      : (err.message || 'WhatsApp setup could not be started.');
    showToast(message, 'error');
    return false;
  } finally {
    clearTimeout(timeout);
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = idleLabel;
    }
    if (activeConnectionAction?.id === actionId) {
      activeConnectionAction = null;
      lastConnBoxKey = null;
      if (lastWhatsappStatus) renderConnectionBox(lastWhatsappStatus);
    }
  }
}

function showPhoneSetup() {
  connectionView = 'phone';
  lastConnBoxKey = null;
  if (lastWhatsappStatus) renderConnectionBox(lastWhatsappStatus);
}

function bindSetupSwitches() {
  const phoneBtn = document.getElementById('waUsePhoneBtn');
  if (phoneBtn) phoneBtn.addEventListener('click', showPhoneSetup);

  const qrBtn = document.getElementById('waUseQrBtn');
  if (qrBtn) {
    qrBtn.addEventListener('click', () => connectionPost(
      '/api/whatsapp/setup-qr',
      null,
      qrBtn,
      { workingLabel: 'Starting QR…' },
    ));
  }
}

function bindRefreshBtn() {
  const btn = document.getElementById('waRefreshBtn');
  if (!btn) return;
  btn.addEventListener('click', () => connectionPost(
    '/api/whatsapp/refresh',
    null,
    btn,
    { workingLabel: 'Refreshing…' },
  ));
}

function resetSetupButtonMarkup() {
  return '<button class="btn btn-sm btn-danger-ghost" id="waResetSetupBtn" type="button">Reset WhatsApp setup</button>';
}

function bindResetSetupBtn() {
  const btn = document.getElementById('waResetSetupBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const confirmed = confirm(
      'Reset WhatsApp setup on this device?\n\nThis clears only this installation\'s unfinished local WhatsApp login. It does not delete messages from the phone, but this device must be linked again.',
    );
    if (!confirmed) return;
    const ok = await connectionPost(
      '/api/whatsapp/reset',
      null,
      btn,
      { workingLabel: 'Resetting…', includeNeedsSetup: true },
    );
    if (ok) showToast('WhatsApp setup reset on this device. Link it again with phone code or QR.', 'success');
  });
}

function bindPhoneSetup() {
  const btn = document.getElementById('waConnectBtn');
  if (!btn) return;
  const submit = async () => {
    const phoneInput = document.getElementById('waPhoneInput');
    const phoneNumber = phoneInput.value.trim();
    const digits = phoneNumber.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      showToast('Enter a valid phone number with country code.', 'error');
      phoneInput.focus();
      return;
    }
    await connectionPost(
      '/api/whatsapp/setup',
      { phoneNumber },
      btn,
      { workingLabel: 'Getting code…' },
    );
  };
  btn.addEventListener('click', submit);
  document.getElementById('waPhoneInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  bindSetupSwitches();
  bindResetSetupBtn();
}

function bindDisconnectBtn() {
  const btn = document.getElementById('waDisconnectBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Disconnect this department\'s WhatsApp number? It must be linked again before messages can be sent or passwords recovered.')) return;
    const ok = await connectionPost(
      '/api/whatsapp/disconnect',
      null,
      btn,
      { workingLabel: 'Disconnecting…', includeNeedsSetup: true },
    );
    if (ok) showToast('WhatsApp disconnected. Choose phone code or QR to link again.', 'success');
  });
}

function phoneSetupMarkup() {
  return `
    <div class="field-group connection-phone-field">
      <label for="waPhoneInput">This department's WhatsApp number</label>
      <input type="tel" id="waPhoneInput" inputmode="tel" autocomplete="tel" placeholder="e.g. 91 98765 43210" />
    </div>
    <button class="btn btn-primary" id="waConnectBtn" type="button" style="width:100%">Get phone code</button>
    <p class="qr-hint">On the phone, open WhatsApp &gt; Linked devices &gt; Link a device &gt; Link with phone number.</p>
    <div class="connection-actions">
      <button class="btn btn-sm" id="waUseQrBtn" type="button">Use QR code instead</button>
      ${resetSetupButtonMarkup()}
    </div>
  `;
}

function renderConnectionBox(wa) {
  lastWhatsappStatus = wa;
  const qrBox = document.getElementById('qrBox');
  const key = [wa.instanceId ?? '', wa.revision ?? '', wa.status, wa.pairingCode || '', wa.qrDataUrl || '', wa.lastError || '', wa.lastMethod || '', connectionView || ''].join('|');
  if (key === lastConnBoxKey) return;
  lastConnBoxKey = key;

  if (wa.status === 'ready') {
    connectionView = null;
    qrBox.innerHTML = `
      <p class="muted">Connected for this department. Password recovery is available through this linked account.</p>
      <button class="btn btn-sm" id="waDisconnectBtn" type="button">Disconnect and change number</button>
    `;
    bindDisconnectBtn();
    return;
  }

  if (wa.status === 'not_configured') {
    qrBox.innerHTML = `<p class="muted">${escapeHtml(wa.configHint || 'Not configured yet.')}</p>`;
    return;
  }

  if (connectionView === 'phone' || wa.status === 'needs_setup') {
    qrBox.innerHTML = phoneSetupMarkup();
    bindPhoneSetup();
    return;
  }

  if (wa.status === 'pairing' && wa.pairingCode) {
    qrBox.innerHTML = `
      <p class="muted" style="margin-bottom:8px">Enter this code on the department phone:</p>
      <div class="pairing-code" aria-label="WhatsApp pairing code">${escapeHtml(wa.pairingCode)}</div>
      <p class="qr-hint">WhatsApp &gt; Linked devices &gt; Link a device &gt; Link with phone number.</p>
      <div class="connection-actions">
        <button class="btn btn-sm" id="waRefreshBtn" type="button">Refresh code</button>
        <button class="btn btn-sm" id="waUseQrBtn" type="button">Switch to QR</button>
        <button class="view-link" id="waUsePhoneBtn" type="button">Use another phone number</button>
        ${resetSetupButtonMarkup()}
      </div>
    `;
    bindRefreshBtn();
    bindSetupSwitches();
    bindResetSetupBtn();
    return;
  }

  const safeQr = typeof wa.qrDataUrl === 'string' && /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(wa.qrDataUrl)
    ? wa.qrDataUrl
    : null;
  if (wa.status === 'qr' && safeQr) {
    qrBox.innerHTML = `
      <img src="${safeQr}" alt="QR code for linking this department's WhatsApp" />
      <p class="qr-hint">On the phone, open WhatsApp &gt; Linked devices &gt; Link a device, then scan this code.</p>
      <div class="connection-actions">
        <button class="btn btn-sm" id="waRefreshBtn" type="button">Refresh QR</button>
        <button class="btn btn-sm" id="waUsePhoneBtn" type="button">Switch to phone code</button>
        ${resetSetupButtonMarkup()}
      </div>
    `;
    bindRefreshBtn();
    bindSetupSwitches();
    bindResetSetupBtn();
    return;
  }

  if (wa.status === 'qr' && !safeQr) {
    qrBox.innerHTML = `
      <p class="field-hint" role="alert">WhatsApp reported a QR login, but the QR image is missing or invalid.</p>
      <p class="muted">Refresh it now. If a new QR still does not appear, switch to phone code or reset this device's setup.</p>
      <div class="connection-actions">
        <button class="btn btn-primary btn-sm" id="waRefreshBtn" type="button">Refresh QR</button>
        <button class="btn btn-sm" id="waUsePhoneBtn" type="button">Switch to phone code</button>
        ${resetSetupButtonMarkup()}
      </div>
    `;
    bindRefreshBtn();
    bindSetupSwitches();
    bindResetSetupBtn();
    return;
  }

  if (wa.status === 'starting' || wa.status === 'authenticated') {
    qrBox.innerHTML = `
      <p class="muted">${wa.status === 'authenticated' ? 'WhatsApp accepted the login. Finishing the connection...' : 'Starting WhatsApp setup...'}</p>
      <div class="connection-actions">
        <button class="btn btn-sm" id="waUsePhoneBtn" type="button">Use phone code</button>
        <button class="btn btn-sm" id="waUseQrBtn" type="button">Use QR code</button>
        ${resetSetupButtonMarkup()}
      </div>
    `;
    bindSetupSwitches();
    bindResetSetupBtn();
    return;
  }

  qrBox.innerHTML = `
    <p class="muted">WhatsApp is not connected.</p>
    ${wa.lastError ? `<p class="field-hint" role="alert">${escapeHtml(wa.lastError)}</p>` : ''}
    <div class="connection-actions">
      <button class="btn btn-primary" id="waUsePhoneBtn" type="button">Try phone code</button>
      <button class="btn" id="waUseQrBtn" type="button">Try QR code</button>
      ${resetSetupButtonMarkup()}
    </div>
  `;
  bindSetupSwitches();
  bindResetSetupBtn();
}

// ---------- Daily backup ----------
function backupValue(data, keys) {
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null && data[key] !== '') return data[key];
  }
  return null;
}

function normaliseBackupStatus(data = {}) {
  const folderValue = backupValue(data, ['root', 'folder', 'folderPath', 'backupFolder']);
  const folder = typeof folderValue === 'string' ? folderValue : (folderValue && folderValue.path) || '';
  const lastObject = data.lastBackup && typeof data.lastBackup === 'object' ? data.lastBackup : {};
  const lastSuccess = data.lastSuccess && typeof data.lastSuccess === 'object' ? data.lastSuccess : {};
  const lastError = data.lastError && typeof data.lastError === 'object' ? data.lastError : {};
  const lastBackupAt = lastSuccess.at || backupValue(data, ['lastBackupAt', 'lastRunAt'])
    || lastObject.completedAt || lastObject.at || (typeof data.lastBackup === 'string' ? data.lastBackup : null);
  const nextBackupAt = backupValue(data, ['nextScheduledAt', 'nextBackupAt', 'nextRunAt']);
  let errorValue = lastError.message
    || (typeof data.lastError === 'string' ? data.lastError : '')
    || (typeof data.error === 'string' ? data.error : '')
    || (typeof lastObject.error === 'string' ? lastObject.error : '');
  if (errorValue && lastError.at && lastSuccess.at) {
    const errorTime = new Date(lastError.at).getTime();
    const successTime = new Date(lastSuccess.at).getTime();
    if (!Number.isNaN(errorTime) && !Number.isNaN(successTime) && successTime >= errorTime) errorValue = '';
  }
  return {
    configured: data.configured === true || (data.configured !== false && Boolean(folder)),
    folder,
    lastBackupAt,
    nextBackupAt,
    error: errorValue,
    running: data.running === true || data.inProgress === true,
    scheduleTime: typeof data.scheduleTimeLocal === 'string' ? data.scheduleTimeLocal : '17:00',
    scheduleLabel: typeof data.scheduleLabel === 'string' ? data.scheduleLabel : '',
  };
}

function formatBackupDate(value, fallback) {
  if (!value) return fallback;
  const timestamp = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatBackupTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return '5:00 PM';
  const date = new Date(2000, 0, 1, Number(match[1]), Number(match[2]));
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

function nextLocalBackupTime(value = '17:00') {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || '')) || ['', '17', '00'];
  const next = new Date();
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next;
}

function renderBackupStatus(status) {
  lastBackupStatus = status;
  const state = document.getElementById('backupState');
  const folder = document.getElementById('backupFolder');
  const last = document.getElementById('backupLast');
  const next = document.getElementById('backupNext');
  const error = document.getElementById('backupError');
  const choose = document.getElementById('chooseBackupFolderBtn');
  const run = document.getElementById('runBackupBtn');
  const timeInput = document.getElementById('backupTimeInput');
  const displayTime = formatBackupTime(status.scheduleTime);

  state.title = status.scheduleLabel || `Daily at ${displayTime} on this PC`;
  document.getElementById('backupScheduleSummary').textContent = displayTime;
  if (document.activeElement !== timeInput) timeInput.value = status.scheduleTime;
  folder.textContent = status.folder || 'No folder selected';
  folder.title = status.folder || '';
  last.textContent = formatBackupDate(status.lastBackupAt, 'No backup yet');
  next.textContent = status.configured
    ? formatBackupDate(status.nextBackupAt, formatBackupDate(nextLocalBackupTime(status.scheduleTime), `Daily at ${displayTime}`))
    : 'Choose a folder first';
  error.textContent = status.error;
  error.hidden = !status.error;
  choose.textContent = status.configured ? 'Change folder' : 'Choose folder';
  run.disabled = !status.configured || status.running;
  run.textContent = status.running ? 'Backing up…' : 'Back up now';

  state.className = 'backup-state';
  if (status.running) {
    state.textContent = 'Backing up';
    state.classList.add('running');
  } else if (status.error) {
    state.textContent = 'Needs attention';
    state.classList.add('attention');
  } else if (status.configured) {
    state.textContent = `Daily · ${displayTime}`;
    state.classList.add('ready');
  } else {
    state.textContent = 'Setup needed';
    state.classList.add('attention');
  }
}

function renderBackupUnavailable(message = 'Backup status is unavailable. The local service will be checked again automatically.') {
  const state = document.getElementById('backupState');
  state.textContent = 'Unavailable';
  state.className = 'backup-state attention';
  document.getElementById('backupFolder').textContent = 'Could not check folder';
  document.getElementById('backupLast').textContent = '—';
  document.getElementById('backupNext').textContent = '—';
  const error = document.getElementById('backupError');
  error.textContent = message;
  error.hidden = false;
  document.getElementById('runBackupBtn').disabled = true;
}

async function refreshBackupStatus({ allowPrompt = true } = {}) {
  if (backupRefreshInFlight) return backupRefreshInFlight;
  backupRefreshInFlight = (async () => {
    try {
      const res = await fetch('/api/backup/status');
      if (res.status === 401) { location.reload(); return null; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Backup status could not be loaded.');
      const status = normaliseBackupStatus(data);
      renderBackupStatus(status);
      if (allowPrompt && !backupPromptHandled && !status.configured) showBackupSetupModal();
      return status;
    } catch (err) {
      renderBackupUnavailable(err.message);
      return null;
    } finally {
      backupRefreshInFlight = null;
    }
  })();
  return backupRefreshInFlight;
}

function showBackupSetupModal() {
  backupPromptHandled = true;
  const overlay = document.getElementById('backupSetupOverlay');
  if (overlay.classList.contains('open')) return;
  backupModalReturnFocus = document.activeElement;
  document.getElementById('backupSetupError').hidden = true;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('backupSetupChoose').focus(), 0);
}

function hideBackupSetupModal() {
  const overlay = document.getElementById('backupSetupOverlay');
  if (!overlay.classList.contains('open')) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  if (backupModalReturnFocus && typeof backupModalReturnFocus.focus === 'function') backupModalReturnFocus.focus();
  backupModalReturnFocus = null;
}

function setBackupSetupError(message) {
  const error = document.getElementById('backupSetupError');
  error.textContent = message;
  error.hidden = !message;
}

async function chooseBackupFolder(button, fromSetupModal = false) {
  const idleLabel = button.textContent;
  const chooserHint = document.getElementById(fromSetupModal ? 'backupSetupChooserHint' : 'backupChooserHint');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Opening…';
  chooserHint.hidden = false;
  if (fromSetupModal) setBackupSetupError('');
  try {
    const res = await fetch('/api/backup/choose-folder', { method: 'POST' });
    if (res.status === 401) { location.reload(); return; }
    if (res.status === 204) {
      if (fromSetupModal) setBackupSetupError('No folder was selected. You can try again or choose Not now.');
      else showToast('No folder selected. The backup setting was not changed.', 'info');
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data.cancelled) {
      if (fromSetupModal) setBackupSetupError('No folder was selected. You can try again or choose Not now.');
      else showToast('No folder selected. The backup setting was not changed.', 'info');
      return;
    }
    if (!res.ok) {
      if (data.status && typeof data.status === 'object') {
        const savedStatus = normaliseBackupStatus(data.status);
        renderBackupStatus(savedStatus);
        if (savedStatus.configured) {
          hideBackupSetupModal();
          showToast(data.error || 'Folder saved, but the first backup needs attention.', 'error');
          return;
        }
      }
      throw new Error(data.error || 'The folder chooser is unavailable. Please try again.');
    }
    let status;
    if (data.status && typeof data.status === 'object') {
      status = normaliseBackupStatus(data.status);
      renderBackupStatus(status);
    } else {
      if (backupRefreshInFlight) await backupRefreshInFlight;
      status = await refreshBackupStatus({ allowPrompt: false });
    }
    if (!status || !status.configured) throw new Error('The backup folder was not saved. Please try again.');
    hideBackupSetupModal();
    showToast('Backup folder saved for this department', 'success');
  } catch (err) {
    if (fromSetupModal) setBackupSetupError(err.message || 'The backup folder could not be selected.');
    else showToast(err.message || 'The backup folder could not be selected.', 'error');
  } finally {
    chooserHint.hidden = true;
    button.disabled = false;
    button.textContent = button.id === 'chooseBackupFolderBtn'
      ? ((lastBackupStatus && lastBackupStatus.configured) ? 'Change folder' : 'Choose folder')
      : idleLabel;
  }
}

async function runBackupNow() {
  if (!lastBackupStatus || !lastBackupStatus.configured) {
    showBackupSetupModal();
    return;
  }
  const button = document.getElementById('runBackupBtn');
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Backing up…';
  try {
    const res = await fetch('/api/backup/run', { method: 'POST' });
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The backup could not be completed.');
    showToast(data.message || 'Backup completed', 'success');
  } catch (err) {
    showToast(err.message || 'The backup could not be completed.', 'error');
  } finally {
    await refreshBackupStatus({ allowPrompt: false });
    button.innerHTML = '';
    button.textContent = (lastBackupStatus && lastBackupStatus.running) ? 'Backing up…' : 'Back up now';
    button.disabled = !(lastBackupStatus && lastBackupStatus.configured) || Boolean(lastBackupStatus && lastBackupStatus.running);
  }
}

async function saveBackupTime() {
  const input = document.getElementById('backupTimeInput');
  const button = document.getElementById('saveBackupTimeBtn');
  if (!/^\d{2}:\d{2}$/.test(input.value)) return showToast('Choose a valid daily backup time.', 'error');
  button.disabled = true;
  button.innerHTML = '<span class="spinner" aria-hidden="true"></span> Saving…';
  try {
    const res = await fetch('/api/backup/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time: input.value }),
    });
    if (res.status === 401) { location.reload(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The backup time could not be saved.');
    const status = normaliseBackupStatus(data.status || data);
    renderBackupStatus(status);
    showToast(`Daily backup time saved as ${formatBackupTime(status.scheduleTime)} on this PC`, 'success');
  } catch (error) {
    showToast(error.message || 'The backup time could not be saved.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Save time';
  }
}

document.getElementById('chooseBackupFolderBtn').addEventListener('click', (event) => chooseBackupFolder(event.currentTarget));
document.getElementById('runBackupBtn').addEventListener('click', runBackupNow);
document.getElementById('saveBackupTimeBtn').addEventListener('click', saveBackupTime);
document.getElementById('backupSetupChoose').addEventListener('click', (event) => chooseBackupFolder(event.currentTarget, true));
document.getElementById('backupSetupLater').addEventListener('click', hideBackupSetupModal);
document.getElementById('backupSetupClose').addEventListener('click', hideBackupSetupModal);
document.getElementById('backupSetupOverlay').addEventListener('click', (event) => {
  if (event.target.id === 'backupSetupOverlay') hideBackupSetupModal();
});
document.addEventListener('keydown', (event) => {
  const overlay = document.getElementById('backupSetupOverlay');
  if (!overlay.classList.contains('open')) return;
  if (event.key === 'Escape') {
    hideBackupSetupModal();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...overlay.querySelectorAll('button:not([disabled])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

// ---------- Status / counts ----------
async function refreshStatus() {
  const requestId = ++statusRequestSequence;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), STATUS_FETCH_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch('/api/status', { signal: controller.signal, cache: 'no-store' });
    if (res.status === 401) { location.reload(); return null; } // session expired - show the login gate again
    data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || 'WhatsApp status could not be loaded.');
    if (!data?.whatsapp || typeof data.whatsapp.status !== 'string') {
      throw new Error('The local service returned an invalid WhatsApp status.');
    }
  } catch {
    return lastWhatsappStatus;
  } finally {
    clearTimeout(timeout);
  }

  // Request order is the first guard: a slower, older GET must never repaint
  // over a request that was issued later. Provider revisions then protect
  // against stale state returned by a newer request.
  if (requestId < newestAppliedStatusRequest) return lastWhatsappStatus;

  const incomingInstanceId = providerInstanceIdOf(data.whatsapp);
  if (incomingInstanceId !== null && lastProviderInstanceId !== null
      && incomingInstanceId !== lastProviderInstanceId) {
    // The watchdog started a new server/provider process. Its monotonic
    // revision counter legitimately begins again, so the previous process's
    // revision must not block this status.
    lastProviderRevision = null;
    lastProviderInstanceId = incomingInstanceId;
  } else if (incomingInstanceId !== null && lastProviderInstanceId === null) {
    lastProviderInstanceId = incomingInstanceId;
  }

  const incomingRevision = providerRevisionOf(data.whatsapp);
  const staleByRevision = incomingRevision !== null
    && lastProviderRevision !== null
    && incomingRevision < lastProviderRevision;
  if (staleByRevision) return lastWhatsappStatus;

  newestAppliedStatusRequest = Math.max(newestAppliedStatusRequest, requestId);
  if (incomingRevision !== null) lastProviderRevision = incomingRevision;

  waReady = data.whatsapp.status === 'ready';

  document.getElementById('providerLabel').textContent = data.whatsapp.label || 'WhatsApp';

  const pill = document.getElementById('statusPill');
  pill.textContent = WHATSAPP_STATUS_LABEL[data.whatsapp.status] || data.whatsapp.status;
  pill.className = 'status-pill status-' + data.whatsapp.status;

  const hint = document.getElementById('reviewHint');
  if (waReady) {
    hint.textContent = 'Review each draft, then send it — nothing goes out on its own.';
    hint.classList.remove('hint-warn');
  } else {
    hint.textContent = `${data.whatsapp.label || 'WhatsApp'} isn't connected — Send/Retry are disabled until it is.`;
    hint.classList.add('hint-warn');
  }

  renderConnectionBox(data.whatsapp);

  const dot = document.getElementById('liveDot');
  const label = document.getElementById('liveLabel');
  if (data.whatsapp.status === 'ready') {
    dot.className = 'dot on';
    label.textContent = 'live · ready to send';
  } else if (data.whatsapp.status === 'disconnected') {
    dot.className = 'dot';
    label.textContent = 'disconnected';
  } else if (data.whatsapp.status === 'not_configured') {
    dot.className = 'dot';
    label.textContent = 'not configured';
  } else if (data.whatsapp.status === 'needs_setup') {
    dot.className = 'dot warn';
    label.textContent = 'setup needed';
  } else if (data.whatsapp.status === 'pairing') {
    dot.className = 'dot warn';
    label.textContent = 'enter pairing code';
  } else {
    dot.className = 'dot warn';
    label.textContent = data.whatsapp.status === 'qr' ? 'waiting for scan' : 'connecting…';
  }

  const c = data.counts || {};
  const sent = Number(c.sent || 0);
  const draft = Number(c.draft || 0);
  const needsInfo = Number(c.needs_info || 0);
  const failed = Number(c.failed || 0);
  const sending = Number(c.sending || 0);
  const uncertain = Number(c.send_uncertain || 0);
  const attention = failed + uncertain;
  document.getElementById('cSent').textContent = sent;
  document.getElementById('cDraft').textContent = draft;
  document.getElementById('cNeedsInfo').textContent = needsInfo;
  document.getElementById('cFailed').textContent = attention;

  const total = sent + draft + needsInfo + failed + sending + uncertain;
  const pct = (n) => (total ? (n / total) * 100 : 0);
  document.getElementById('segSent').style.width = pct(sent) + '%';
  document.getElementById('segDraft').style.width = pct(draft + sending) + '%';
  document.getElementById('segNeedsInfo').style.width = pct(needsInfo) + '%';
  document.getElementById('segFailed').style.width = pct(attention) + '%';
  return data.whatsapp;
}

// ---------- Brokers ----------
async function refreshBrokers() {
  const res = await fetch('/api/brokers');
  lastBrokers = await res.json();
  renderBrokers();
}

function renderBrokers() {
  const tbody = document.querySelector('#brokerTable tbody');
  const term = brokerSearchTerm.toLowerCase();
  const rows = lastBrokers.filter((b) => !term || b.name.toLowerCase().includes(term) || (b.phone || '').includes(term));

  if (!lastBrokers.length) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state"><span class="big">—</span>No brokers on file yet. They're added automatically from the sheet, or add one above.</div></td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">No brokers match "${escapeHtml(brokerSearchTerm)}".</div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((b) => `
      <tr data-broker-id="${b.id}">
        <td class="name-cell edit-trigger" data-name="${escapeHtml(b.name)}" data-phone="${escapeHtml(b.phone || '')}">${escapeHtml(b.name)}</td>
        <td class="phone-cell">${escapeHtml(b.phone || '—')}</td>
        <td class="row-actions">
          <button class="btn btn-sm btn-danger-ghost" data-delete-broker="${b.id}" data-name="${escapeHtml(b.name)}" type="button">Remove</button>
        </td>
      </tr>
    `)
    .join('');

  tbody.querySelectorAll('.edit-trigger').forEach((cell) => {
    cell.style.cursor = 'pointer';
    cell.title = 'Click to edit';
    cell.addEventListener('click', () => {
      document.getElementById('brokerName').value = cell.dataset.name;
      document.getElementById('brokerPhone').value = cell.dataset.phone;
      document.getElementById('brokerPhone').focus();
    });
  });

  tbody.querySelectorAll('[data-delete-broker]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove broker "${btn.dataset.name}"? This won't affect past logs.`)) return;
      btn.disabled = true;
      await fetch(`/api/brokers/${btn.dataset.deleteBroker}`, { method: 'DELETE' });
      showToast(`Removed broker "${btn.dataset.name}"`, 'success');
      refreshBrokers();
    });
  });
}

document.getElementById('brokerSearch').addEventListener('input', (e) => {
  brokerSearchTerm = e.target.value;
  renderBrokers();
});

document.getElementById('saveBrokerBtn').addEventListener('click', async () => {
  const name = document.getElementById('brokerName').value.trim();
  const phone = document.getElementById('brokerPhone').value.trim();
  if (!name) return showToast('Broker name is required', 'error');
  await fetch('/api/brokers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone }),
  });
  showToast(`Saved "${name}"`, 'success');
  document.getElementById('brokerName').value = '';
  document.getElementById('brokerPhone').value = '';
  refreshBrokers();
});

// ---------- Log table ----------
// Remembers each row's last-seen status so we can flash a brief
// success/failure highlight the moment a send actually resolves.
const lastKnownStatus = new Map();

async function refreshLogs() {
  const url = '/api/logs' + (currentStatusFilter ? `?status=${currentStatusFilter}` : '');
  const res = await fetch(url);
  const newLogs = await res.json();

  const transitions = [];
  for (const row of newLogs) {
    const prev = lastKnownStatus.get(row.id);
    if (prev && prev !== row.status && ['sent', 'failed', 'send_uncertain'].includes(row.status)) {
      transitions.push({ id: row.id, status: row.status });
    }
    lastKnownStatus.set(row.id, row.status);
  }

  lastLogs = newLogs;
  const liveIds = new Set(lastLogs.map((r) => r.id));
  const sendableIds = new Set(lastLogs.filter((row) => SENDABLE_STATUSES.has(row.status)).map((row) => row.id));
  [...selectedIds].forEach((id) => {
    if (!liveIds.has(id) || !sendableIds.has(id)) selectedIds.delete(id);
  });
  renderLogs();
  transitions.forEach(({ id, status }) => flashRow(id, status));
}

function flashRow(id, status) {
  const row = document.querySelector(`#logTable tbody tr[data-row-id="${id}"]`);
  if (!row) return;
  const cls = status === 'sent' ? 'flash-success' : 'flash-failed';
  row.classList.add(cls);
  setTimeout(() => row.classList.remove(cls), 1600);
}

function updateBulkBar() {
  document.getElementById('selectedCount').textContent = selectedIds.size;
  document.getElementById('sendSelectedBtn').disabled = selectedIds.size === 0 || !waReady;
  document.getElementById('sendAllDraftsBtn').disabled = !waReady;
  const tip = waReady ? '' : 'Connect WhatsApp before sending';
  document.getElementById('sendSelectedBtn').title = tip;
  document.getElementById('sendAllDraftsBtn').title = tip;
}

function deliveryBadge(row) {
  if (row.status !== 'sent' || !row.delivery_status) return '';
  const map = {
    sent: { icon: '✓', cls: 'delivery-sent', title: 'Sent' },
    delivered: { icon: '✓✓', cls: 'delivery-delivered', title: 'Delivered' },
    read: { icon: '✓✓', cls: 'delivery-read', title: 'Read' },
  };
  const d = map[row.delivery_status];
  if (!d) return '';
  return ` <span class="delivery-badge ${d.cls}" title="${d.title}">${d.icon}</span>`;
}

function renderLogs() {
  const tbody = document.querySelector('#logTable tbody');
  const term = logSearchTerm.toLowerCase();
  const rows = lastLogs.filter((r) => !term
    || r.broker_name.toLowerCase().includes(term)
    || r.party_name.toLowerCase().includes(term)
    || (r.buyer_name || '').toLowerCase().includes(term)
    || (r.phone || '').includes(term));

  if (!lastLogs.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><span class="big">—</span>No messages yet. Drop today's Excel file into <code>incoming/</code> to get started.</div></td></tr>`;
    updateBulkBar();
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state">Nothing matches "${escapeHtml(logSearchTerm)}".</div></td></tr>`;
    updateBulkBar();
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const disabledAttr = waReady ? '' : 'disabled title="Connect WhatsApp before sending"';
      const canSelect = SENDABLE_STATUSES.has(r.status);
      const note = r.error || r.reconciliation_note || '';
      const actions = [`<button class="view-link" data-view="${r.id}" type="button">View</button>`];
      if (EDITABLE_STATUSES.has(r.status)) actions.push(`<button class="btn btn-sm" data-edit="${r.id}" type="button">Edit</button>`);
      if (r.status === 'draft') actions.push(`<button class="btn btn-sm btn-primary" data-send="${r.id}" type="button" ${disabledAttr}>Send</button>`);
      if (r.status === 'failed') actions.push(`<button class="btn btn-sm btn-gold" data-retry="${r.id}" type="button" ${disabledAttr}>Retry</button>`);

      return `
      <tr class="status-cell-row ${r.status}" data-row-id="${r.id}">
        <td><input type="checkbox" class="row-check" data-id="${r.id}" aria-label="Select message ${r.id}" ${selectedIds.has(r.id) ? 'checked' : ''} ${canSelect ? '' : 'disabled'} /></td>
        <td class="tabular">${r.id}</td>
        <td>${escapeHtml(r.demand_date || '')}</td>
        <td class="name-cell" title="${escapeHtml(r.broker_name)}">${escapeHtml(r.broker_name)}</td>
        <td title="${escapeHtml(r.party_name)}">${escapeHtml(r.party_name)}</td>
        <td title="${escapeHtml(r.buyer_name || '')}">${escapeHtml(r.buyer_name || '—')}</td>
        <td class="phone-cell">${escapeHtml(r.phone || '—')}</td>
        <td class="tabular">${r.stone_count}</td>
        <td><span class="tag ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>${deliveryBadge(r)}</td>
        <td class="${r.error ? 'error-text' : 'note-text'}">${escapeHtml(note)}</td>
        <td class="row-actions">${actions.join('')}</td>
      </tr>
    `;
    })
    .join('');

  tbody.querySelectorAll('.row-check').forEach((box) => {
    box.addEventListener('change', () => {
      const id = Number(box.dataset.id);
      if (box.checked) selectedIds.add(id); else selectedIds.delete(id);
      updateBulkBar();
    });
  });

  tbody.querySelectorAll('[data-send]').forEach((btn) => {
    btn.addEventListener('click', () => runSend(btn, btn.dataset.send, '/send', 'Sent'));
  });
  tbody.querySelectorAll('[data-retry]').forEach((btn) => {
    btn.addEventListener('click', () => runSend(btn, btn.dataset.retry, '/retry', 'Sent'));
  });
  tbody.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => openViewModal(Number(btn.dataset.view)));
  });
  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => openEditModal(Number(btn.dataset.edit)));
  });

  updateBulkBar();
}

async function runSend(btn, id, path, successLabel) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';
  const res = await fetch(`/api/logs/${id}${path}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) showToast(data.error || 'Send failed', 'error');
  else showToast(`${successLabel} to the broker on WhatsApp`, 'success');
  refreshLogs();
  refreshStatus();
}

document.getElementById('logSearch').addEventListener('input', (e) => {
  logSearchTerm = e.target.value;
  renderLogs();
});

document.querySelectorAll('#statusTabs button[data-status]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#statusTabs button[data-status]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentStatusFilter = btn.dataset.status;
    refreshLogs();
  });
});

document.getElementById('exportBtn').addEventListener('click', () => {
  window.location.href = '/api/logs/export';
});

document.getElementById('selectAllCheckbox').addEventListener('change', (e) => {
  const term = logSearchTerm.toLowerCase();
  const visible = lastLogs.filter((r) => SENDABLE_STATUSES.has(r.status) && (
    !term
    || r.broker_name.toLowerCase().includes(term)
    || r.party_name.toLowerCase().includes(term)
    || (r.phone || '').includes(term)
  ));
  visible.forEach((r) => { if (e.target.checked) selectedIds.add(r.id); else selectedIds.delete(r.id); });
  renderLogs();
});

document.getElementById('selectAllBtn').addEventListener('click', () => {
  lastLogs.filter((r) => r.status === 'draft').forEach((r) => selectedIds.add(r.id));
  renderLogs();
  showToast(`Selected ${selectedIds.size} draft(s) ready to send`, 'success');
});

document.getElementById('sendSelectedBtn').addEventListener('click', async () => {
  const ids = [...selectedIds];
  if (!ids.length) return;
  const btn = document.getElementById('sendSelectedBtn');
  const originalHtml = btn.innerHTML; // includes the #selectedCount span - must come back after
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending…';
  try {
    const res = await fetch('/api/logs/send-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    const okCount = (data.results || []).filter((r) => r.ok).length;
    const failCount = (data.results || []).length - okCount;
    showToast(`${okCount} sent${failCount ? `, ${failCount} failed` : ''}`, failCount ? 'error' : 'success');
    selectedIds.clear();
  } finally {
    // Restore the button's original markup (its #selectedCount span) before
    // refreshLogs()/updateBulkBar() tries to update that span - otherwise
    // it no longer exists (destroyed by the innerHTML overwrite above) and
    // the button is left stuck showing "Sending…" forever.
    btn.innerHTML = originalHtml;
    refreshLogs();
    refreshStatus();
  }
});

document.getElementById('sendAllDraftsBtn').addEventListener('click', async () => {
  const btn = document.getElementById('sendAllDraftsBtn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Sending…';
  const res = await fetch('/api/logs/send-all-drafts', { method: 'POST' });
  const data = await res.json();
  btn.disabled = false;
  btn.textContent = originalText;
  const okCount = (data.results || []).filter((r) => r.ok).length;
  const failCount = (data.results || []).length - okCount;
  if (!data.results || !data.results.length) showToast('No drafts ready to send', 'info');
  else showToast(`${okCount} sent${failCount ? `, ${failCount} failed` : ''}`, failCount ? 'error' : 'success');
  refreshLogs();
  refreshStatus();
});

// ---------- Modal: View (read-only) ----------
function metaBlock(row) {
  return `
    <span><b>Broker:</b> ${escapeHtml(row.broker_name)}</span>
    <span><b>Party:</b> ${escapeHtml(row.party_name)}</span>
    <span><b>Buyer:</b> ${escapeHtml(row.buyer_name || '—')}</span>
    <span><b>Phone:</b> ${escapeHtml(row.phone || '—')}</span>
    <span><b>Stones:</b> ${row.stone_count}</span>
    <span><b>Status:</b> ${STATUS_LABEL[row.status] || row.status}${deliveryBadge(row)}</span>
  `;
}

function openViewModal(id) {
  const row = lastLogs.find((r) => r.id === id);
  if (!row) return;
  document.getElementById('modalTitle').textContent = 'Message — original';
  const edited = row.original_message && row.message !== row.original_message;
  document.getElementById('modalBody').innerHTML = `
    <div class="modal-meta">${metaBlock(row)}</div>
    <div class="message-note">${escapeHtml(row.original_message || row.message)}</div>
    ${edited ? `<p class="field-hint" style="margin-top:10px">This draft has been edited from the original — see "Edit" for the current version that will actually be sent.</p>` : ''}
    ${row.reconciliation_note ? `<p class="field-hint" style="margin-top:10px"><strong>Verification record:</strong> ${escapeHtml(row.reconciliation_note)}</p>` : ''}
    ${row.status === 'send_uncertain' ? `
      <div class="uncertain-panel" role="alert">
        <p><strong>Do not retry yet.</strong> The app stopped after sending began, so this message may already be in the broker's WhatsApp chat.</p>
        <p>Open WhatsApp, check this broker's chat, then choose exactly what you found:</p>
        <div class="modal-footer">
          <button class="btn" id="uncertainDeliveredBtn" type="button">Message is present — mark sent</button>
          <button class="btn btn-gold" id="uncertainRetryBtn" type="button">Message is absent — allow retry</button>
        </div>
        <p class="field-hint" id="uncertainError" role="alert" style="display:none"></p>
      </div>
    ` : ''}
  `;
  document.getElementById('modalBackdrop').classList.add('open');
  if (row.status === 'send_uncertain') {
    document.getElementById('uncertainDeliveredBtn').addEventListener('click', (event) => reconcileUncertain(row.id, 'sent', event.currentTarget));
    document.getElementById('uncertainRetryBtn').addEventListener('click', (event) => reconcileUncertain(row.id, 'retry', event.currentTarget));
  }
}

async function reconcileUncertain(id, decision, button) {
  const wording = decision === 'sent'
    ? 'Confirm that you personally checked WhatsApp and this exact message is present in the broker chat.'
    : 'Confirm that you personally checked WhatsApp and this exact message is absent. This will enable one explicit retry.';
  if (!confirm(wording)) return;

  const buttons = document.querySelectorAll('#uncertainDeliveredBtn, #uncertainRetryBtn');
  buttons.forEach((item) => { item.disabled = true; });
  const original = button.textContent;
  button.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(`/api/logs/${id}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The verification result could not be saved.');
    closeModal();
    showToast(decision === 'sent' ? 'Verified and marked as sent' : 'Verified as not delivered; Retry is now available', 'success');
    await Promise.all([refreshLogs(), refreshStatus()]);
  } catch (error) {
    const target = document.getElementById('uncertainError');
    if (target) {
      target.textContent = error.message || 'The verification result could not be saved.';
      target.style.display = 'block';
    }
    buttons.forEach((item) => { item.disabled = false; });
    button.textContent = original;
  }
}

// ---------- Modal: Edit ----------
function openEditModal(id) {
  const row = lastLogs.find((r) => r.id === id);
  if (!row) return;
  document.getElementById('modalTitle').textContent = 'Edit draft';
  document.getElementById('modalBody').innerHTML = `
    <div class="field-group">
      <label for="editBroker">Broker name</label>
      <input type="text" id="editBroker" value="${escapeHtml(row.broker_name === '(unassigned)' ? '' : row.broker_name)}" placeholder="e.g. Ashok Harichand Shah" />
    </div>
    <div class="field-group">
      <label for="editPhone">Phone</label>
      <input type="text" id="editPhone" value="${escapeHtml(row.phone || '')}" placeholder="10-digit or +91…" />
    </div>
    <div class="field-group">
      <label for="editBuyer">Buyer name (optional)</label>
      <input type="text" id="editBuyer" value="${escapeHtml(row.buyer_name || '')}" placeholder="e.g. Pramod Sakpal" />
    </div>
    <div class="field-group">
      <label for="editMessage">Message</label>
      <textarea id="editMessage">${escapeHtml(row.message)}</textarea>
    </div>
    ${row.status === 'needs_info' ? '<p class="field-hint">Fill in the missing broker and/or phone so this can be sent.</p>' : ''}
    <div class="modal-footer">
      <button class="btn" id="cancelEditBtn" type="button">Cancel</button>
      <button class="btn btn-primary" id="saveEditBtn" type="button">Save draft</button>
    </div>
  `;
  document.getElementById('modalBackdrop').classList.add('open');

  document.getElementById('cancelEditBtn').addEventListener('click', closeModal);
  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    const brokerName = document.getElementById('editBroker').value.trim();
    const phone = document.getElementById('editPhone').value.trim();
    const buyerName = document.getElementById('editBuyer').value.trim();
    const message = document.getElementById('editMessage').value;
    const saveBtn = document.getElementById('saveEditBtn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner"></span>';
    const res = await fetch(`/api/logs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brokerName, phone, message, buyerName }),
    });
    if (res.ok) {
      showToast('Draft updated', 'success');
      closeModal();
      refreshLogs();
      refreshStatus();
    } else {
      showToast('Could not save changes', 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save draft';
    }
  });
}

function closeModal() { document.getElementById('modalBackdrop').classList.remove('open'); }
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modalBackdrop') closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- Upload ----------
const uploadInput = document.getElementById('fileInput');
const selectedFileName = document.getElementById('selectedFileName');

function renderSelectedUploadFile() {
  const file = uploadInput.files?.[0];
  selectedFileName.textContent = file
    ? `${file.name} (${Math.max(1, Math.ceil(file.size / 1024)).toLocaleString()} KB)`
    : 'No file selected';
  selectedFileName.title = file?.name || '';
}

uploadInput.addEventListener('change', renderSelectedUploadFile);

document.getElementById('uploadBtn').addEventListener('click', async () => {
  const input = uploadInput;
  const btn = document.getElementById('uploadBtn');
  if (!input.files.length) return showToast('Choose a file first', 'error');
  if (input.files.length !== 1) return showToast('Choose exactly one Excel workbook.', 'error');
  const file = input.files[0];
  if (!/\.xlsx$/i.test(file.name)) return showToast('Choose an Excel .xlsx workbook.', 'error');
  if (file.size > 10 * 1024 * 1024) return showToast('Workbook is too large. The maximum size is 10 MB.', 'error');
  const fd = new FormData();
  fd.append('file', file, file.name);
  const msgEl = document.getElementById('uploadMsg');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Uploading…</span>';
  msgEl.className = 'upload-message muted';
  msgEl.textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed. Please try again.');
    msgEl.className = 'upload-message success';
    msgEl.textContent = data.message || 'Workbook validated and queued for processing.';
    showToast('File queued for processing', 'success');
    input.value = '';
    renderSelectedUploadFile();
    setTimeout(() => { refreshLogs(); refreshStatus(); }, 1500);
  } catch (error) {
    msgEl.className = 'upload-message error';
    msgEl.textContent = error.message || 'Upload failed. Please try again.';
    showToast(msgEl.textContent, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload & process';
  }
});

// ---------- Live updates ----------
let tickInFlight = null;
let tickRequestedAgain = false;
function tick() {
  // SSE can emit several updates during one send. Coalesce them into at most
  // one follow-up refresh instead of piling up overlapping table renders.
  if (tickInFlight) {
    tickRequestedAgain = true;
    return tickInFlight;
  }
  tickInFlight = (async () => {
    do {
      tickRequestedAgain = false;
      // Status first: renderLogs/updateBulkBar read waReady.
      await refreshStatus();
      await Promise.allSettled([refreshBackupStatus(), refreshLogs(), refreshBrokers()]);
    } while (tickRequestedAgain);
  })().finally(() => { tickInFlight = null; });
  return tickInFlight;
}

function connectLiveEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = () => { void tick(); };
  es.onerror = () => {
    // EventSource retries on its own; keep the periodic fallback poll running underneath.
  };
}

let bootStarted = false;
function boot() {
  if (bootStarted) return;
  bootStarted = true;
  void tick();
  connectLiveEvents();
  setInterval(() => { void tick(); }, 15000); // fallback in case SSE drops
}

// ---------- Auth gate ----------
// Nothing above (dashboard data, WhatsApp status, etc.) loads until this
// resolves - the overlay starts already visible in the HTML so there's no
// flash of the real dashboard before we know whether the user is logged in.
async function initAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (!data.hasPassword) {
      showAuthForm('setup');
      return;
    }
    if (!data.authenticated) {
      showAuthForm('login');
      return;
    }
    completeAuthentication();
  } catch {
    const body = document.getElementById('authBody');
    document.getElementById('authTitle').textContent = 'App unavailable';
    body.innerHTML = '<p class="field-hint" role="alert">The local service is not responding. Close and reopen Broker Demand Desk, then try again.</p>';
  }
}

function clearAuthSecrets() {
  document.querySelectorAll('#authOverlay input').forEach((input) => { input.value = ''; });
}

function completeAuthentication() {
  clearAuthSecrets();
  document.getElementById('authBody').replaceChildren();
  document.getElementById('authOverlay').classList.remove('open');
  boot();
}

function setAuthError(message) {
  const err = document.getElementById('authError');
  if (!err) return;
  err.textContent = message;
  err.style.display = 'block';
}

function showAuthForm(mode) {
  const overlay = document.getElementById('authOverlay');
  clearAuthSecrets();
  overlay.classList.add('open');
  document.getElementById('authTitle').textContent = mode === 'setup' ? 'Create a password' : 'Sign in';
  document.getElementById('authBody').innerHTML = `
    <div class="field-group">
      <label for="authPassword">${mode === 'setup' ? 'Choose a password' : 'Password'}</label>
      <input type="password" id="authPassword" autocomplete="${mode === 'setup' ? 'new-password' : 'current-password'}" minlength="${mode === 'setup' ? '8' : '1'}" autofocus />
    </div>
    ${mode === 'setup' ? `
      <div class="field-group">
        <label for="authPasswordConfirm">Confirm password</label>
        <input type="password" id="authPasswordConfirm" autocomplete="new-password" minlength="8" />
      </div>
      <p class="qr-hint auth-explainer">Use at least 8 characters. This password belongs only to this department's installation.</p>
    ` : ''}
    <button class="btn btn-primary" id="authSubmitBtn" type="button" style="width:100%">${mode === 'setup' ? 'Create password' : 'Sign in'}</button>
    ${mode === 'login' ? '<button class="view-link auth-secondary-action" id="forgotPasswordBtn" type="button">Forgot password?</button>' : ''}
    <p class="field-hint" id="authError" role="alert" style="display:none"></p>
  `;
  const passwordInput = document.getElementById('authPassword');
  const submit = async () => {
    const password = passwordInput.value;
    if (!password) return setAuthError('Enter your password.');
    if (mode === 'setup') {
      const confirmPassword = document.getElementById('authPasswordConfirm').value;
      if (password.length < 8) return setAuthError('Use at least 8 characters.');
      if (password !== confirmPassword) return setAuthError('The passwords do not match.');
    }
    const btn = document.getElementById('authSubmitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed.');
      completeAuthentication();
    } catch (err) {
      setAuthError(err.message || 'Sign-in failed.');
      btn.disabled = false;
      btn.textContent = mode === 'setup' ? 'Create password' : 'Sign in';
    }
  };
  passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  document.getElementById('authSubmitBtn').addEventListener('click', submit);
  const forgotBtn = document.getElementById('forgotPasswordBtn');
  if (forgotBtn) forgotBtn.addEventListener('click', showRecoveryStart);
}

async function showRecoveryStart() {
  clearAuthSecrets();
  document.getElementById('authTitle').textContent = 'Reset password';
  const body = document.getElementById('authBody');
  body.innerHTML = '<p class="muted"><span class="spinner"></span> Checking this installation\'s linked WhatsApp...</p>';

  let status;
  try {
    const res = await fetch('/api/auth/recovery/status');
    status = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(status.error || 'Recovery status is unavailable.');
  } catch (err) {
    body.innerHTML = `
      <p class="field-hint" role="alert">${escapeHtml(err.message || 'Recovery status is unavailable.')}</p>
      <button class="btn" id="recoveryBackBtn" type="button" style="width:100%">Back to sign in</button>
    `;
    document.getElementById('recoveryBackBtn').addEventListener('click', () => showAuthForm('login'));
    return;
  }

  const maskedPhone = status.maskedPhone || status.maskedDestination || 'the linked number';
  // Once a code has been delivered, verification must remain available even
  // if WhatsApp reconnects or drops offline before the user enters it.
  if (status.codePending) {
    const minutes = Math.max(1, Math.ceil((status.codeExpiresInSeconds || 0) / 60));
    const canReplace = status.available && Number(status.cooldownSeconds || 0) <= 0;
    body.innerHTML = `
      <p class="auth-explainer">A reset code is already active for <strong>${escapeHtml(maskedPhone)}</strong>.</p>
      <p class="qr-hint auth-explainer">Use the code from WhatsApp within about ${minutes} minute${minutes === 1 ? '' : 's'}.</p>
      <button class="btn btn-primary" id="enterRecoveryBtn" type="button" style="width:100%">Enter existing code</button>
      ${canReplace ? '<button class="btn" id="replaceRecoveryBtn" type="button" style="width:100%">Send a replacement code</button>' : ''}
      <button class="view-link auth-secondary-action" id="recoveryBackBtn" type="button">Back to sign in</button>
      <p class="field-hint" id="authError" role="alert" style="display:none"></p>
    `;
    document.getElementById('enterRecoveryBtn').addEventListener('click', () => showRecoveryVerify(maskedPhone));
    const replaceBtn = document.getElementById('replaceRecoveryBtn');
    if (replaceBtn) replaceBtn.addEventListener('click', () => requestRecoveryCode(maskedPhone, replaceBtn));
    document.getElementById('recoveryBackBtn').addEventListener('click', () => showAuthForm('login'));
    return;
  }

  if (!status.available) {
    body.innerHTML = `
      <p class="field-hint" role="alert">${escapeHtml(status.reason || 'WhatsApp is not connected on this installation, so it cannot receive a reset code.')}</p>
      <p class="qr-hint auth-explainer">If this account was already linked, allow a moment for it to reconnect and check again. Recovery never uses another department's WhatsApp or database.</p>
      <button class="btn btn-primary" id="recoveryRetryBtn" type="button" style="width:100%">Check WhatsApp again</button>
      <button class="view-link auth-secondary-action" id="recoveryBackBtn" type="button">Back to sign in</button>
    `;
    document.getElementById('recoveryRetryBtn').addEventListener('click', showRecoveryStart);
    document.getElementById('recoveryBackBtn').addEventListener('click', () => showAuthForm('login'));
    return;
  }

  body.innerHTML = `
    <p class="auth-explainer">Send a one-time reset code to this installation's linked WhatsApp account: <strong>${escapeHtml(maskedPhone)}</strong>.</p>
    <p class="qr-hint auth-explainer">The code expires shortly and can only reset this department's local password.</p>
    <button class="btn btn-primary" id="sendRecoveryBtn" type="button" style="width:100%">Send reset code</button>
    <button class="view-link auth-secondary-action" id="recoveryBackBtn" type="button">Back to sign in</button>
    <p class="field-hint" id="authError" role="alert" style="display:none"></p>
  `;
  document.getElementById('recoveryBackBtn').addEventListener('click', () => showAuthForm('login'));
  const sendBtn = document.getElementById('sendRecoveryBtn');
  sendBtn.addEventListener('click', () => requestRecoveryCode(maskedPhone, sendBtn));
}

async function requestRecoveryCode(maskedPhone, btn) {
  const idleLabel = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending...';
  try {
    const res = await fetch('/api/auth/recovery/request', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'The reset code could not be sent.');
    showRecoveryVerify(data.maskedPhone || data.maskedDestination || maskedPhone);
  } catch (err) {
    setAuthError(err.message || 'The reset code could not be sent.');
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
}

function showRecoveryVerify(maskedPhone) {
  clearAuthSecrets();
  document.getElementById('authTitle').textContent = 'Enter reset code';
  const body = document.getElementById('authBody');
  body.innerHTML = `
    <p class="auth-explainer">A 6-digit code was sent to <strong>${escapeHtml(maskedPhone)}</strong>.</p>
    <div class="field-group recovery-code-field">
      <label for="recoveryCode">Reset code</label>
      <input type="text" id="recoveryCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" autofocus />
    </div>
    <div class="field-group">
      <label for="recoveryPassword">New password</label>
      <input type="password" id="recoveryPassword" autocomplete="new-password" minlength="8" />
    </div>
    <div class="field-group">
      <label for="recoveryPasswordConfirm">Confirm new password</label>
      <input type="password" id="recoveryPasswordConfirm" autocomplete="new-password" minlength="8" />
    </div>
    <button class="btn btn-primary" id="verifyRecoveryBtn" type="button" style="width:100%">Reset password</button>
    <button class="view-link auth-secondary-action" id="recoveryRestartBtn" type="button">Back to reset options</button>
    <p class="field-hint" id="authError" role="alert" style="display:none"></p>
  `;

  const submit = async () => {
    const code = document.getElementById('recoveryCode').value.replace(/\D/g, '');
    const newPassword = document.getElementById('recoveryPassword').value;
    const confirmation = document.getElementById('recoveryPasswordConfirm').value;
    if (!/^\d{6}$/.test(code)) return setAuthError('Enter the complete 6-digit code.');
    if (newPassword.length < 8) return setAuthError('Use at least 8 characters for the new password.');
    if (newPassword !== confirmation) return setAuthError('The new passwords do not match.');

    const btn = document.getElementById('verifyRecoveryBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await fetch('/api/auth/recovery/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The reset code was not accepted.');
      clearAuthSecrets();
      showToast('Password reset for this department', 'success');
      await initAuth();
    } catch (err) {
      setAuthError(err.message || 'The reset code was not accepted.');
      btn.disabled = false;
      btn.textContent = 'Reset password';
    }
  };

  document.getElementById('verifyRecoveryBtn').addEventListener('click', submit);
  document.getElementById('recoveryCode').addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
  document.getElementById('recoveryRestartBtn').addEventListener('click', showRecoveryStart);
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

document.getElementById('changePasswordBtn').addEventListener('click', () => {
  document.getElementById('modalTitle').textContent = 'Change password';
  document.getElementById('modalBody').innerHTML = `
    <div class="field-group">
      <label for="cpCurrent">Current password</label>
      <input type="password" id="cpCurrent" autocomplete="current-password" />
    </div>
    <div class="field-group">
      <label for="cpNew">New password</label>
      <input type="password" id="cpNew" autocomplete="new-password" minlength="8" />
    </div>
    <div class="field-group">
      <label for="cpConfirm">Confirm new password</label>
      <input type="password" id="cpConfirm" autocomplete="new-password" minlength="8" />
    </div>
    <p class="field-hint" id="cpError" style="display:none"></p>
    <div class="modal-footer">
      <button class="btn" id="cpCancelBtn" type="button">Cancel</button>
      <button class="btn btn-primary" id="cpSaveBtn" type="button">Save</button>
    </div>
  `;
  document.getElementById('modalBackdrop').classList.add('open');
  document.getElementById('cpCancelBtn').addEventListener('click', closeModal);
  document.getElementById('cpSaveBtn').addEventListener('click', async () => {
    const currentPassword = document.getElementById('cpCurrent').value;
    const newPassword = document.getElementById('cpNew').value;
    const confirmation = document.getElementById('cpConfirm').value;
    const errorElement = document.getElementById('cpError');
    if (newPassword.length < 8) {
      errorElement.textContent = 'Use at least 8 characters.';
      errorElement.style.display = 'block';
      return;
    }
    if (newPassword !== confirmation) {
      errorElement.textContent = 'The new passwords do not match.';
      errorElement.style.display = 'block';
      return;
    }
    const btn = document.getElementById('cpSaveBtn');
    btn.disabled = true;
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = document.getElementById('cpError');
      err.textContent = data.error || 'Something went wrong';
      err.style.display = 'block';
      btn.disabled = false;
      return;
    }
    document.getElementById('cpCurrent').value = '';
    document.getElementById('cpNew').value = '';
    document.getElementById('cpConfirm').value = '';
    closeModal();
    showToast('Password changed. Sign in again on this device.', 'success');
    setTimeout(() => location.reload(), 500);
  });
});

initAuth();
