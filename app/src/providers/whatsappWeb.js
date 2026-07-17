const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const DEFAULT_COUNTRY_CODE = process.env.WA_DEFAULT_COUNTRY_CODE || '91';
// Never send back-to-back - a minimum human-like gap between messages
// reduces the chance of the number being flagged for spam.
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 8000;
const STARTUP_TIMEOUT_MS = 45000;
const CLIENT_STOP_TIMEOUT_MS = 10000;
const DIRECT_REFRESH_TIMEOUT_MS = 12000;
const AUTHENTICATED_READY_TIMEOUT_MS = 120000;
const RECOVERY_CODE_PATTERN = /^\d{4,10}$/;
const SELF_CHAT_SERVERS = new Set(['c.us', 'lid']);

function resolveAuthDataPath(appDataDir = process.env.BROKER_APP_DATA_DIR) {
  const dataRoot = appDataDir
    ? path.resolve(String(appDataDir))
    : path.resolve(__dirname, '..', '..', 'data');
  return path.join(dataRoot, 'wwebjs_auth');
}

const AUTH_DATA_PATH = resolveAuthDataPath();

function timeoutError(message, code = 'WHATSAPP_OPERATION_TIMEOUT') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function describeError(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err || 'Unknown error');
}

function normalizePairingPhone(rawPhoneNumber) {
  let digits = String(rawPhoneNumber || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // The rest of the application already treats a 10-digit number as a local
  // number. Do the same here; whatsapp-web.js requires an international number
  // for pairing and otherwise returns codes that can never link the device.
  if (digits.length === 10) digits = DEFAULT_COUNTRY_CODE + digits;
  if (digits.length < 11 || digits.length > 15) {
    throw new Error('Enter a valid phone number with country code.');
  }
  return digits;
}

// Drives your own WhatsApp account through an unofficial Web session. Works
// immediately with no approval process, but isn't sanctioned by Meta - see
// providers/whatsappCloudApi.js for the official alternative.
//
// First run: no session yet, so the app waits (status: needs_setup) for a
// phone number via beginSetup() and links using a pairing code - no QR/camera
// needed. beginSetupWithQr() is the fallback if pairing-code linking doesn't
// work for some reason. Every run after that, the saved session logs back in
// automatically.
class WhatsAppWebProvider extends EventEmitter {
  constructor(options = {}) {
    super();
    this.kind = 'whatsapp_web';
    this.label = 'WhatsApp Web';
    this.instanceId = options.instanceId || crypto.randomUUID();
    this.qrDataUrl = null;
    this.pairingCode = null;
    this.lastError = null;
    this.lastMethod = null; // 'phone' | 'qr' - remembered so refreshCode() can redo the same one
    this.lastPhoneNumber = null;
    this.queue = [];
    this.processing = false;
    this.client = null;
    this._generation = 0;
    this._clients = new Set();
    this._stoppingClients = new WeakMap();
    this._initializingClients = new WeakMap();
    this._browserDisconnectHandlers = new WeakMap();
    this._lateCleanupClients = new WeakSet();
    this._pendingStart = Promise.resolve();
    this._qrSequence = 0;
    this.statusRevision = 0;
    this.qrIssuedAt = null;
    this._authenticatedReadyTimer = null;
    this._startupTimeoutMs = STARTUP_TIMEOUT_MS;
    this._stopTimeoutMs = CLIENT_STOP_TIMEOUT_MS;
    this._directRefreshTimeoutMs = DIRECT_REFRESH_TIMEOUT_MS;
    this._authenticatedReadyTimeoutMs = AUTHENTICATED_READY_TIMEOUT_MS;
    this._encodeQr = (value) => qrcode.toDataURL(value);
    this._now = () => Date.now();
    this._fsPromises = fs.promises;
    this._resetInProgress = false;
    this.authDataPath = AUTH_DATA_PATH;
    this.authSessionPath = path.join(this.authDataPath, 'session');

    // The Chromium profile folder gets created just by launching the browser,
    // whether or not a login ever succeeded - so it's not a reliable signal.
    // Instead, always try to restore silently first: a valid session logs
    // straight in with no 'qr' event; only a genuinely new/invalid session
    // ever fires 'qr', at which point we switch to needs_setup and wait for
    // a phone number instead of ever showing that QR code.
    this.status = 'starting'; // starting | needs_setup | pairing | qr | authenticated | ready | disconnected
    this._startClient('probe');
  }

  _isCurrentClient(client, generation) {
    return this.client === client && this._generation === generation;
  }

  _emitStatus(status) {
    this.status = status;
    this.statusRevision = Number(this.statusRevision || 0) + 1;
    this.emit('status', status);
  }

  _setTimer(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  }

  _clearTimer(timer) {
    if (timer) clearTimeout(timer);
  }

  _withTimeout(operation, timeoutMs, message, code) {
    const boundedMs = Math.max(1, Number(timeoutMs) || 1);
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = this._setTimer(() => reject(timeoutError(message, code)), boundedMs);
    });
    return Promise.race([Promise.resolve(operation), timeout])
      .finally(() => this._clearTimer(timer));
  }

  _invalidateQr() {
    this._qrSequence = Number(this._qrSequence || 0) + 1;
    this.qrDataUrl = null;
    this.qrIssuedAt = null;
  }

  _clearAuthenticatedReadyTimer() {
    this._clearTimer(this._authenticatedReadyTimer);
    this._authenticatedReadyTimer = null;
  }

  _startAuthenticatedReadyTimer(client, generation) {
    this._clearAuthenticatedReadyTimer();
    this._authenticatedReadyTimer = this._setTimer(() => {
      this._authenticatedReadyTimer = null;
      if (!this._isCurrentClient(client, generation) || this.status !== 'authenticated') return;
      this._retireCurrentClient(
        client,
        generation,
        'disconnected',
        'WhatsApp accepted the login but did not become ready in time. Reset the setup or try linking again.',
      );
    }, this._authenticatedReadyTimeoutMs || AUTHENTICATED_READY_TIMEOUT_MS);
  }

  _detachBrowserDisconnect(client) {
    const entry = this._browserDisconnectHandlers?.get(client);
    if (!entry) return;
    try { entry.browser.off?.('disconnected', entry.handler); } catch { /* browser is already gone */ }
    this._browserDisconnectHandlers.delete(client);
  }

  _attachBrowserDisconnect(client, generation) {
    if (!client?.pupBrowser || this._browserDisconnectHandlers?.has(client)) return;
    const browser = client.pupBrowser;
    const handler = () => {
      if (!this._isCurrentClient(client, generation)) return;
      if (this._stoppingClients?.has(client)) return;
      this._retireCurrentClient(
        client,
        generation,
        'disconnected',
        'The WhatsApp browser closed unexpectedly. Try linking again or reset the setup.',
      );
    };
    browser.on?.('disconnected', handler);
    this._browserDisconnectHandlers.set(client, { browser, handler });
  }

  // Stops are shared so a quick phone -> QR -> phone switch never tries to
  // destroy the same browser three times or opens two Chromium instances on
  // the same LocalAuth profile.
  async _forceCloseClientBrowser(client) {
    const browser = client?.pupBrowser;
    if (!browser) return;

    try {
      const browserProcess = browser.process?.();
      if (browserProcess && !browserProcess.killed) browserProcess.kill();
    } catch (err) {
      console.error('[whatsapp_web] could not terminate the stuck browser process:', describeError(err));
    }

    if (browser.isConnected?.()) {
      try {
        await this._withTimeout(
          browser.close?.(),
          Math.min(this._stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS, 2000),
          'Timed out force-closing the WhatsApp browser.',
          'WHATSAPP_BROWSER_CLOSE_TIMEOUT',
        );
      } catch { /* the owned browser process was already terminated */ }
    }
  }

  _scheduleLateBrowserCleanup(client, initialization) {
    if (!initialization || this._lateCleanupClients?.has(client)) return;
    this._lateCleanupClients?.add(client);
    let initializationSettled = false;
    const closeIfStale = async () => {
      if (this.client === client) return;
      if (client?.pupBrowser?.isConnected?.()) await this._forceCloseClientBrowser(client);
    };

    // Promise finalizer handles a browser which appears when initialization
    // eventually resolves/rejects. The bounded monitor also catches a browser
    // that appears while page navigation remains pending indefinitely.
    void Promise.resolve(initialization).then(
      () => { initializationSettled = true; },
      () => { initializationSettled = true; },
    ).then(closeIfStale).catch((error) => {
      console.error('[whatsapp_web] late browser cleanup error:', describeError(error));
    });

    void (async () => {
      const monitorMs = Math.max(
        this._startupTimeoutMs || STARTUP_TIMEOUT_MS,
        this._stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS,
      );
      const deadline = Date.now() + monitorMs;
      while (!client.pupBrowser && !initializationSettled && Date.now() < deadline) {
        await new Promise((resolve) => this._setTimer(resolve, 50));
      }
      await closeIfStale();
    })().catch((error) => {
      console.error('[whatsapp_web] late browser monitor error:', describeError(error));
    });
  }

  _stopClient(client, { logout = false } = {}) {
    if (!client) return Promise.resolve(true);
    const alreadyStopping = this._stoppingClients.get(client);
    if (alreadyStopping) return alreadyStopping;

    const stopping = (async () => {
      let stoppedCleanly = true;
      try {
        this._detachBrowserDisconnect(client);
        const operation = logout ? client.logout() : client.destroy();
        await this._withTimeout(
          operation,
          this._stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS,
          `Timed out ${logout ? 'logging out of' : 'closing'} the WhatsApp browser.`,
          'WHATSAPP_CLIENT_STOP_TIMEOUT',
        );
      } catch (err) {
        stoppedCleanly = false;
        console.error(`[whatsapp_web] ${logout ? 'logout' : 'shutdown'} error:`, describeError(err));
        // logout() can fail before it closes Chromium. A final destroy is safe
        // even if the browser did close and makes the next setup retry usable.
        if (logout) {
          try {
            await this._withTimeout(
              client.destroy(),
              this._stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS,
              'Timed out closing the WhatsApp browser after logout failed.',
              'WHATSAPP_CLIENT_STOP_TIMEOUT',
            );
          } catch { /* force-close below */ }
        }
        await this._forceCloseClientBrowser(client);
      }

      // destroy() is a no-op when called during puppeteer.launch(), before
      // whatsapp-web.js assigns pupBrowser. Wait for that in-flight launch and
      // close the late browser before opening another client on the same
      // LocalAuth directory.
      const initialization = this._initializingClients.get(client);
      if (initialization && !client.pupBrowser) {
        this._scheduleLateBrowserCleanup(client, initialization);
        let initializationSettled = false;
        void initialization.then(() => { initializationSettled = true; }, () => { initializationSettled = true; });
        try {
          await this._withTimeout((async () => {
            while (!client.pupBrowser && !initializationSettled) {
              await new Promise((resolve) => this._setTimer(resolve, 50));
            }
          })(), this._stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS,
          'Timed out waiting for the WhatsApp browser launch to settle.',
          'WHATSAPP_INITIALIZATION_STOP_TIMEOUT');
        } catch {
          stoppedCleanly = false;
        }
      }
      if (client.pupBrowser?.isConnected?.()) {
        try {
          await this._withTimeout(
            client.destroy(),
            this._stopTimeoutMs || CLIENT_STOP_TIMEOUT_MS,
            'Timed out closing a late WhatsApp browser.',
            'WHATSAPP_CLIENT_STOP_TIMEOUT',
          );
        } catch {
          stoppedCleanly = false;
          await this._forceCloseClientBrowser(client);
        }
      }

      this._detachBrowserDisconnect(client);
      client.removeAllListeners?.();
      this._clients?.delete(client);
      return stoppedCleanly;
    })().finally(() => {
      this._stoppingClients.delete(client);
    });
    this._stoppingClients.set(client, stopping);
    return stopping;
  }

  _retireCurrentClient(client, generation, status, errorMessage) {
    if (!this._isCurrentClient(client, generation)) return;
    this.client = null;
    this._generation += 1;
    this._clearAuthenticatedReadyTimer();
    this._invalidateQr();
    this.pairingCode = null;
    this.lastError = errorMessage || null;
    this._emitStatus(status);
    void this._stopClient(client);
  }

  // client.initialize() is a long-running promise. It is intentionally not
  // awaited by setup routes, but every rejection is handled here. The bound
  // client + generation checks prevent an old browser from changing the state
  // after the user switches linking methods.
  _initialize(client, generation) {

    // client.initialize()'s promise only resolves once fully 'ready' - it can
    // legitimately stay pending for a long time just waiting on a human to
    // scan/enter a code, so this timeout only fires if NOTHING happened at
    // all (e.g. Chromium failed to launch on that machine) - it's a no-op
    // once we've reached qr/pairing/ready/authenticated.
    const timeout = this._setTimer(() => {
      if (!this._isCurrentClient(client, generation)) return;
      if (['qr', 'pairing', 'ready', 'authenticated'].includes(this.status)) return;
      console.error('[whatsapp_web] timed out waiting for the browser to start.');
      this._retireCurrentClient(
        client,
        generation,
        'disconnected',
        'Timed out starting the WhatsApp browser session. Security software may be blocking it. Try phone code or QR again, or check the logs.',
      );
    }, this._startupTimeoutMs || STARTUP_TIMEOUT_MS);

    const initialization = Promise.resolve().then(() => client.initialize());
    this._initializingClients.set(client, initialization);
    initialization.then(() => {
      if (this._isCurrentClient(client, generation)) this._attachBrowserDisconnect(client, generation);
    }, () => {});
    initialization.catch((err) => {
      if (!this._isCurrentClient(client, generation)) return;
      const message = describeError(err);
      console.error('[whatsapp_web] initialize failed:', message);
      this._retireCurrentClient(client, generation, 'disconnected', message);
    }).finally(() => {
      this._clearTimer(timeout);
      this._initializingClients.delete(client);
    });
  }

  _createClient(method, pairWithPhoneNumber, generation) {
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.authDataPath || AUTH_DATA_PATH }),
      // A fixed local WhatsApp Web HTML cache can outlive a compatible backend
      // release and make every newly generated QR invalid. Always load the
      // currently served WhatsApp Web application instead.
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
      ...(pairWithPhoneNumber ? { pairWithPhoneNumber: { phoneNumber: pairWithPhoneNumber, showNotification: true } } : {}),
    });
    return this._bindClientEvents(client, method, generation);
  }

  _bindClientEvents(client, method, generation) {
    this.client = client;
    this._clients.add(client);

    client.on('qr', (qr) => {
      if (!this._isCurrentClient(client, generation)) return;
      this._attachBrowserDisconnect(client, generation);
      if (method === 'probe') {
        // Initial probe, no session, and QR wasn't explicitly requested - ask
        // for a setup method instead of choosing one for the user.
        this.client = null;
        this._generation += 1;
        this._invalidateQr();
        this.pairingCode = null;
        this.lastError = null;
        this._emitStatus('needs_setup');
        void this._stopClient(client);
        return;
      }

      // QR encoding is asynchronous; re-check after it finishes because the
      // user may have switched methods or WhatsApp may have already emitted a
      // newer QR in the meantime.
      const qrSequence = Number(this._qrSequence || 0) + 1;
      this._qrSequence = qrSequence;
      const encodeQr = this._encodeQr || ((value) => qrcode.toDataURL(value));
      void encodeQr(qr).then((dataUrl) => {
        if (!this._isCurrentClient(client, generation) || this._qrSequence !== qrSequence) return;
        this.qrDataUrl = dataUrl;
        this.qrIssuedAt = new Date((this._now || Date.now)()).toISOString();
        this.pairingCode = null;
        this.lastError = null;
        this._emitStatus('qr');
      }).catch((err) => {
        if (!this._isCurrentClient(client, generation) || this._qrSequence !== qrSequence) return;
        this._retireCurrentClient(client, generation, 'disconnected', `Could not create the QR code: ${describeError(err)}`);
      });
    });

    client.on('code', (code) => {
      if (!this._isCurrentClient(client, generation)) return;
      this._attachBrowserDisconnect(client, generation);
      this._invalidateQr();
      this.pairingCode = code;
      this.lastError = null;
      this._emitStatus('pairing');
    });

    client.on('authenticated', () => {
      if (!this._isCurrentClient(client, generation)) return;
      this._attachBrowserDisconnect(client, generation);
      this._invalidateQr();
      this.pairingCode = null;
      this.lastError = null;
      this._emitStatus('authenticated');
      this._startAuthenticatedReadyTimer(client, generation);
    });

    client.on('ready', () => {
      if (!this._isCurrentClient(client, generation)) return;
      this._attachBrowserDisconnect(client, generation);
      this._clearAuthenticatedReadyTimer();
      this._invalidateQr();
      this.pairingCode = null;
      this.lastError = null;
      this._emitStatus('ready');
    });

    client.on('auth_failure', (message) => {
      if (!this._isCurrentClient(client, generation)) return;
      const detail = message ? `: ${String(message)}` : '';
      this._retireCurrentClient(client, generation, 'disconnected', `WhatsApp authentication failed${detail}. Try linking again with phone code or QR.`);
    });

    client.on('disconnected', (reason) => {
      if (!this._isCurrentClient(client, generation)) return;
      const detail = reason ? ` (${String(reason)})` : '';
      this._retireCurrentClient(client, generation, 'disconnected', `WhatsApp disconnected${detail}. Try linking again with phone code or QR.`);
    });

    // Fires whenever a sent message's delivery state changes - lets callers
    // track sent -> delivered -> read without needing the official Cloud API.
    client.on('message_ack', (message, ack) => {
      if (!this._isCurrentClient(client, generation)) return;
      const ACK_TO_LABEL = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
      const label = ACK_TO_LABEL[ack];
      const waMessageId = message?.id?._serialized;
      // WhatsApp occasionally emits acknowledgement events without a normal
      // message id (for example, internal/protocol messages). Never forward an
      // undefined value into SQLite or let that event destabilise the client.
      if (label && typeof waMessageId === 'string' && waMessageId.trim()) {
        this.emit('ack', waMessageId, label);
      }
    });

    return client;
  }

  _startClient(method, pairWithPhoneNumber = null) {
    const generation = this._generation + 1;
    this._generation = generation;
    this.client = null;
    this._clearAuthenticatedReadyTimer();
    this._invalidateQr();
    this.pairingCode = null;
    this.lastError = null;
    this._emitStatus('starting');

    // Capture every browser still shutting down, not only this.client. This is
    // important when users click the two setup methods in quick succession.
    const staleClients = [...this._clients];
    const starting = (async () => {
      await Promise.all(staleClients.map((client) => this._stopClient(client)));
      if (this._generation !== generation) return;

      let client;
      try {
        client = this._createClient(method, pairWithPhoneNumber, generation);
      } catch (err) {
        if (this._generation !== generation) return;
        const message = describeError(err);
        console.error('[whatsapp_web] could not create client:', message);
        this.lastError = message;
        this._emitStatus('disconnected');
        return;
      }
      if (!this._isCurrentClient(client, generation)) {
        await this._stopClient(client);
        return;
      }
      this._initialize(client, generation);
    })();

    // _startClient is also called by synchronous Express handlers. Keep its
    // promise handled even when the caller intentionally does not await it.
    this._pendingStart = starting.catch((err) => {
      if (this._generation !== generation) return;
      const message = describeError(err);
      console.error('[whatsapp_web] setup restart failed:', message);
      this.lastError = message;
      this._emitStatus('disconnected');
    });
    return this._pendingStart;
  }

  // Called from the dashboard's first-run setup screen once the user types
  // in their WhatsApp phone number.
  beginSetup(rawPhoneNumber) {
    if (this.isReady()) throw new Error('WhatsApp is already connected. Disconnect it before linking another account.');
    if (this._resetInProgress) throw new Error('WhatsApp setup is being reset. Wait a moment and try again.');
    const digits = normalizePairingPhone(rawPhoneNumber);

    this.lastMethod = 'phone';
    this.lastPhoneNumber = digits;
    return this._startClient('phone', digits);
  }

  // Fallback for the "or scan a QR code instead" link on the setup screen -
  // same provider, same session storage, just the other linking method.
  beginSetupWithQr() {
    if (this.isReady()) throw new Error('WhatsApp is already connected. Disconnect it before linking another account.');
    if (this._resetInProgress) throw new Error('WhatsApp setup is being reset. Wait a moment and try again.');
    this.lastMethod = 'qr';
    this.lastPhoneNumber = null;
    return this._startClient('qr');
  }

  _hasHealthySetupClient(client = this.client) {
    if (!client || client !== this.client) return false;
    const browser = client.pupBrowser;
    const page = client.pupPage;
    if (!browser || !page) return false;
    if (typeof browser.isConnected === 'function' && !browser.isConnected()) return false;
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    return true;
  }

  _waitForStatus(predicate, timeoutMs, message) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        this.off('status', onStatus);
        this._clearTimer(timer);
      };
      const onStatus = () => {
        if (!predicate()) return;
        cleanup();
        resolve();
      };
      this.on('status', onStatus);
      timer = this._setTimer(() => {
        cleanup();
        reject(timeoutError(message, 'WHATSAPP_CODE_REFRESH_TIMEOUT'));
      }, timeoutMs);
    });
  }

  async _refreshQrDirect(client, generation) {
    if (!this._hasHealthySetupClient(client)) throw new Error('The WhatsApp browser is not available.');
    const previousRevision = Number(this.statusRevision || 0);
    await this._withTimeout(
      client.pupPage.evaluate(() => {
        const command = window.require('WAWebCmd')?.Cmd;
        if (!command || typeof command.refreshQR !== 'function') {
          throw new Error('WhatsApp QR refresh is unavailable.');
        }
        return command.refreshQR();
      }),
      this._directRefreshTimeoutMs || DIRECT_REFRESH_TIMEOUT_MS,
      'Timed out asking WhatsApp for a fresh QR code.',
      'WHATSAPP_CODE_REFRESH_TIMEOUT',
    );
    await this._waitForStatus(
      () => this._isCurrentClient(client, generation)
        && this.status === 'qr'
        && Number(this.statusRevision || 0) > previousRevision,
      this._directRefreshTimeoutMs || DIRECT_REFRESH_TIMEOUT_MS,
      'WhatsApp did not provide a fresh QR code in time.',
    );
  }

  async _refreshPhoneDirect(client, generation, phoneNumber) {
    if (!this._hasHealthySetupClient(client) || typeof client.requestPairingCode !== 'function') {
      throw new Error('The WhatsApp pairing session is not available.');
    }
    const previousRevision = Number(this.statusRevision || 0);
    const code = await this._withTimeout(
      client.requestPairingCode(phoneNumber, true),
      this._directRefreshTimeoutMs || DIRECT_REFRESH_TIMEOUT_MS,
      'Timed out asking WhatsApp for a fresh phone code.',
      'WHATSAPP_CODE_REFRESH_TIMEOUT',
    );
    if (this._isCurrentClient(client, generation)
        && typeof code === 'string'
        && code
        && (this.status !== 'pairing' || this.pairingCode !== code || Number(this.statusRevision || 0) === previousRevision)) {
      this._invalidateQr();
      this.pairingCode = code;
      this.lastError = null;
      this._emitStatus('pairing');
    }
    await this._waitForStatus(
      () => this._isCurrentClient(client, generation)
        && this.status === 'pairing'
        && Number(this.statusRevision || 0) > previousRevision,
      this._directRefreshTimeoutMs || DIRECT_REFRESH_TIMEOUT_MS,
      'WhatsApp did not provide a fresh phone code in time.',
    );
  }

  // Forces a brand new QR/pairing code right now, instead of waiting for
  // WhatsApp's own ~20-40s rotation - same linking method as last time.
  async refreshCode() {
    if (this.isReady()) throw new Error('WhatsApp is already connected; there is no setup code to refresh.');
    if (this._resetInProgress) throw new Error('WhatsApp setup is being reset. Wait a moment and try again.');

    if (this.lastMethod === 'phone' && this.lastPhoneNumber) {
      const client = this.client;
      const generation = this._generation;
      if (this._hasHealthySetupClient(client)) {
        try {
          await this._refreshPhoneDirect(client, generation, this.lastPhoneNumber);
          return;
        } catch (err) {
          console.error('[whatsapp_web] direct phone-code refresh failed; restarting the setup client:', describeError(err));
        }
      }
      await this._startClient('phone', this.lastPhoneNumber);
      return;
    }
    this.lastMethod = 'qr';
    const client = this.client;
    const generation = this._generation;
    if (this._hasHealthySetupClient(client) && this.status === 'qr') {
      try {
        await this._refreshQrDirect(client, generation);
        return;
      } catch (err) {
        console.error('[whatsapp_web] direct QR refresh failed; restarting the setup client:', describeError(err));
      }
    }
    await this._startClient('qr');
  }

  // Fully unlinks the connected number (properly logs out on WhatsApp's side
  // too, not just locally) so a different phone number can be linked instead.
  async disconnect() {
    const client = this.client;
    const wasReady = this.status === 'ready';
    const generation = this._generation + 1;
    this._generation = generation;
    this.client = null;
    this._clearAuthenticatedReadyTimer();
    this._invalidateQr();
    this.pairingCode = null;
    this.lastError = null;
    this.lastMethod = null;
    this.lastPhoneNumber = null;
    this._emitStatus('needs_setup');

    const clients = [...this._clients];
    const outcomes = await Promise.all(clients.map((item) => this._stopClient(item, { logout: item === client && wasReady })));
    // A newer setup request owns the state now; never overwrite it when this
    // older disconnect finally finishes.
    if (this._generation !== generation) return;
    if (wasReady && outcomes.some((stoppedCleanly) => !stoppedCleanly)) {
      this.lastError = 'The linked WhatsApp session could not be fully logged out. Try again before linking a different account.';
      this._emitStatus('disconnected');
    }
  }

  // Graceful process/upgrade shutdown: close every browser with the same
  // bounded stop path, but deliberately keep the LocalAuth profile so the
  // linked account can restore on the next launch.
  async shutdown() {
    const generation = Number(this._generation || 0) + 1;
    this._generation = generation;
    this.client = null;
    this._clearAuthenticatedReadyTimer();
    this._invalidateQr();
    this.pairingCode = null;
    const clients = [...(this._clients || [])];
    const outcomes = await Promise.all(clients.map((client) => this._stopClient(client)));
    if (this._generation === generation) this._emitStatus('disconnected');
    return outcomes.every(Boolean);
  }

  _resolveOwnedAuthSessionPath() {
    const authRoot = path.resolve(String(this.authDataPath || AUTH_DATA_PATH));
    const sessionPath = path.resolve(String(this.authSessionPath || path.join(authRoot, 'session')));
    const relative = path.relative(authRoot, sessionPath);
    if (relative !== 'session' || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
      const error = new Error('Refusing to reset WhatsApp because the session path is outside this installation.');
      error.code = 'UNSAFE_WHATSAPP_SESSION_PATH';
      throw error;
    }
    return { authRoot, sessionPath };
  }

  async _verifySessionPathIsNotLink(authRoot, sessionPath) {
    const fileSystem = this._fsPromises || fs.promises;
    try {
      const [authRootStat, sessionStat] = await Promise.all([
        fileSystem.lstat(authRoot),
        fileSystem.lstat(sessionPath),
      ]);
      if (authRootStat.isSymbolicLink() || sessionStat.isSymbolicLink()) {
        const error = new Error('Refusing to reset a linked WhatsApp session directory.');
        error.code = 'UNSAFE_WHATSAPP_SESSION_PATH';
        throw error;
      }
      const [realRoot, realSession] = await Promise.all([
        fileSystem.realpath(authRoot),
        fileSystem.realpath(sessionPath),
      ]);
      if (path.dirname(realSession) !== realRoot || path.basename(realSession) !== 'session') {
        const error = new Error('Refusing to reset WhatsApp because the resolved session path is outside this installation.');
        error.code = 'UNSAFE_WHATSAPP_SESSION_PATH';
        throw error;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  // Clears only an incomplete, non-ready LocalAuth profile. A connected
  // account must go through disconnect()/logout so WhatsApp is notified too.
  async resetSetup() {
    if (this.isReady()) {
      throw new Error('Disconnect the connected WhatsApp account before resetting setup.');
    }
    if (this._resetInProgress) throw new Error('WhatsApp setup is already being reset.');
    const { authRoot, sessionPath } = this._resolveOwnedAuthSessionPath();
    this._resetInProgress = true;
    const generation = Number(this._generation || 0) + 1;
    this._generation = generation;
    this.client = null;
    this._clearAuthenticatedReadyTimer();
    this._invalidateQr();
    this.pairingCode = null;
    this.lastError = null;
    this.lastMethod = null;
    this.lastPhoneNumber = null;
    this._emitStatus('starting');

    try {
      const clients = [...(this._clients || [])];
      await Promise.all(clients.map((client) => this._stopClient(client)));
      if (this._generation !== generation) throw new Error('WhatsApp setup changed while the reset was running. Try again.');
      await this._verifySessionPathIsNotLink(authRoot, sessionPath);
      const fileSystem = this._fsPromises || fs.promises;
      await fileSystem.rm(sessionPath, { recursive: true, force: true, maxRetries: 4 });
      if (this._generation !== generation) throw new Error('WhatsApp setup changed while the reset was running. Try again.');
      this._emitStatus('needs_setup');
      return this.getStatus();
    } catch (error) {
      if (this._generation === generation) {
        this.lastError = `WhatsApp setup could not be reset: ${describeError(error)}`;
        this._emitStatus('disconnected');
      }
      throw error;
    } finally {
      this._resetInProgress = false;
    }
  }

  getStatus() {
    return {
      kind: this.kind,
      label: this.label,
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      pairingCode: this.pairingCode,
      lastError: this.lastError,
      lastMethod: this.lastMethod,
      revision: Number(this.statusRevision || 0),
      statusRevision: Number(this.statusRevision || 0),
      qrIssuedAt: this.qrIssuedAt || null,
      instanceId: this.instanceId || null,
    };
  }

  isReady() {
    return this.status === 'ready';
  }

  _getOwnIdentity(client = this.client) {
    const wid = client?.info?.wid;
    if (!wid || typeof wid !== 'object') return null;

    const serialized = typeof wid._serialized === 'string' ? wid._serialized : '';
    const match = serialized.match(/^([0-9]+)@(c\.us|lid)$/);
    let user = match?.[1] || (wid.user == null ? '' : String(wid.user));
    let server = match?.[2] || (wid.server == null ? '' : String(wid.server));
    if (!/^[0-9]+$/.test(user) || !SELF_CHAT_SERVERS.has(server)) return null;

    // If whatsapp-web.js supplies both forms they must describe the same ID.
    // Refusing inconsistent data is safer than ever guessing a reset target.
    if (match && wid.user != null && String(wid.user) !== user) return null;
    if (match && wid.server != null && String(wid.server) !== server) return null;

    return { chatId: `${user}@${server}`, user };
  }

  getRecoveryInfo() {
    if (!this.isReady() || !this.client) {
      return {
        available: false,
        maskedPhone: null,
        reason: 'Connect WhatsApp on this device before requesting a reset code.',
      };
    }
    const identity = this._getOwnIdentity(this.client);
    if (!identity) {
      return {
        available: false,
        maskedPhone: null,
        reason: 'The linked WhatsApp account identity is not available yet.',
      };
    }
    const lastFour = identity.user.slice(-4);
    return { available: true, maskedPhone: `•••• ${lastFour}` };
  }

  // Sends only a fixed reset message to the account represented by this
  // installation's active client.info.wid. There is deliberately no phone or
  // chat destination argument and no environment/config fallback.
  async sendRecoveryCode(code) {
    const normalizedCode = String(code || '').trim();
    if (!RECOVERY_CODE_PATTERN.test(normalizedCode)) {
      throw new Error('Reset code must contain 4 to 10 digits.');
    }
    if (!this.isReady() || !this.client) {
      throw new Error('WhatsApp is not connected on this device.');
    }

    const client = this.client;
    const generation = this._generation;
    const identity = this._getOwnIdentity(client);
    if (!identity) {
      throw new Error('The linked WhatsApp account identity is not available.');
    }
    if (!this._isCurrentClient(client, generation)) {
      throw new Error('WhatsApp connection changed. Request a new reset code.');
    }

    const body = [
      'Broker Demand Desk password reset',
      '',
      `Your verification code is: ${normalizedCode}`,
      '',
      'Use this code only on the device where you requested it. If you did not request it, ignore this message.',
    ].join('\n');
    const sentMessage = await client.sendMessage(identity.chatId, body);
    return sentMessage?.id?._serialized || null;
  }

  formatChatId(rawPhone) {
    let digits = String(rawPhone || '').replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.length === 10) digits = DEFAULT_COUNTRY_CODE + digits;
    return `${digits}@c.us`;
  }

  // Queues a send so messages go out one at a time with a randomized
  // human-like delay (never less than MIN_DELAY_MS).
  sendMessage(phone, message, attachmentPath) {
    if (!this.isReady()) {
      return Promise.reject(new Error(`WhatsApp is not connected (status: ${this.status}). Finish connecting it first.`));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ phone, message, attachmentPath, resolve, reject });
      this._drainQueue();
    });
  }

  async _drainQueue() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        if (!this.isReady()) {
          throw new Error(`WhatsApp is not connected (status: ${this.status}). Finish connecting it first.`);
        }
        const chatId = this.formatChatId(job.phone);
        if (!chatId) throw new Error('No valid phone number for this broker.');

        let sentMessage;
        if (job.attachmentPath) {
          const media = MessageMedia.fromFilePath(job.attachmentPath);
          sentMessage = await this.client.sendMessage(chatId, media, { caption: job.message });
        } else {
          sentMessage = await this.client.sendMessage(chatId, job.message);
        }
        job.resolve(sentMessage?.id?._serialized || null);
      } catch (err) {
        job.reject(err);
      }
      const delay = MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
      await new Promise((r) => setTimeout(r, delay));
    }
    this.processing = false;
  }
}

module.exports = { WhatsAppWebProvider, resolveAuthDataPath };
