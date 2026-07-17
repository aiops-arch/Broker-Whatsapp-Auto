const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const { WhatsAppWebProvider, resolveAuthDataPath } = require('../src/providers/whatsappWeb');

function providerWithoutBrowser() {
  const provider = Object.create(WhatsAppWebProvider.prototype);
  provider.status = 'disconnected';
  provider.instanceId = 'test-provider-instance';
  provider.client = null;
  provider._generation = 1;
  provider._clients = new Set();
  provider._stoppingClients = new WeakMap();
  provider._initializingClients = new WeakMap();
  provider._browserDisconnectHandlers = new WeakMap();
  provider._lateCleanupClients = new WeakSet();
  provider._pendingStart = Promise.resolve();
  provider._qrSequence = 0;
  provider.statusRevision = 0;
  provider.qrIssuedAt = null;
  provider.qrDataUrl = null;
  provider.pairingCode = null;
  provider.lastError = null;
  provider.lastMethod = null;
  provider.lastPhoneNumber = null;
  provider._authenticatedReadyTimer = null;
  provider._startupTimeoutMs = 50;
  provider._stopTimeoutMs = 20;
  provider._directRefreshTimeoutMs = 30;
  provider._authenticatedReadyTimeoutMs = 30;
  provider._encodeQr = async (value) => `data:image/png;base64,${Buffer.from(value).toString('base64')}`;
  provider._now = () => 1710000000000;
  provider._fsPromises = fs.promises;
  provider._resetInProgress = false;
  provider.authDataPath = resolveAuthDataPath(path.join(os.tmpdir(), 'unused-provider-data'));
  provider.authSessionPath = path.join(provider.authDataPath, 'session');
  return provider;
}

function fakeBrowserClient(overrides = {}) {
  const browser = new EventEmitter();
  let connected = true;
  browser.isConnected = () => connected;
  browser.process = () => ({
    killed: false,
    kill: () => { connected = false; },
  });
  browser.close = async () => { connected = false; };

  const client = new EventEmitter();
  Object.assign(client, {
    pupBrowser: browser,
    pupPage: {
      isClosed: () => false,
      evaluate: async () => undefined,
    },
    initialize: async () => undefined,
    destroy: async () => { connected = false; },
    logout: async () => { connected = false; },
  }, overrides);
  return { client, browser, setConnected: (value) => { connected = value; } };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('phone and QR setup can replace any non-ready setup state', async () => {
  const provider = providerWithoutBrowser();
  const starts = [];
  provider._startClient = async (...args) => { starts.push(args); };
  provider.isReady = () => false;
  provider.client = { stale: true };

  await provider.beginSetup('9876543210');
  await provider.beginSetupWithQr();

  assert.deepEqual(starts, [
    ['phone', '919876543210'],
    ['qr'],
  ]);
  assert.equal(provider.lastMethod, 'qr');
});

test('recovery targets only the active installation own WhatsApp identity', async () => {
  const provider = providerWithoutBrowser();
  const sends = [];
  provider.status = 'ready';
  provider.client = {
    info: { wid: { user: '919876543210', server: 'c.us', _serialized: '919876543210@c.us' } },
    sendMessage: async (destination, body) => {
      sends.push({ destination, body });
      return { id: { _serialized: 'reset-message-id' } };
    },
  };

  assert.deepEqual(provider.getRecoveryInfo(), { available: true, maskedPhone: '•••• 3210' });
  assert.equal(await provider.sendRecoveryCode('123456'), 'reset-message-id');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].destination, '919876543210@c.us');
  assert.match(sends[0].body, /123456/);
});

test('recovery rejects stale, disconnected, or inconsistent identities', async () => {
  const provider = providerWithoutBrowser();
  assert.equal(provider.getRecoveryInfo().available, false);
  await assert.rejects(() => provider.sendRecoveryCode('123456'), /not connected/i);

  provider.status = 'ready';
  provider.client = {
    info: { wid: { user: '111111111111', server: 'c.us', _serialized: '222222222222@c.us' } },
    sendMessage: async () => { throw new Error('must not send'); },
  };
  assert.equal(provider.getRecoveryInfo().available, false);
  await assert.rejects(() => provider.sendRecoveryCode('123456'), /identity/i);
});

test('LocalAuth resolves below the installation-specific app data directory', () => {
  const appData = path.resolve(os.tmpdir(), 'broker-provider-env-test');
  assert.equal(resolveAuthDataPath(appData), path.join(appData, 'wwebjs_auth'));
});

test('a hung Chromium destroy is bounded and force-closes only its owned browser', async () => {
  const provider = providerWithoutBrowser();
  provider._stopTimeoutMs = 10;
  const { client, browser } = fakeBrowserClient({
    destroy: () => new Promise(() => {}),
  });
  let killed = false;
  browser.process = () => ({ killed: false, kill: () => { killed = true; } });
  browser.isConnected = () => !killed;
  provider._clients.add(client);

  const startedAt = Date.now();
  const clean = await provider._stopClient(client);
  const elapsed = Date.now() - startedAt;

  assert.equal(clean, false);
  assert.equal(killed, true);
  assert.equal(provider._clients.has(client), false);
  assert.ok(elapsed < 500, `shutdown took ${elapsed}ms`);
});

test('a browser launched after the bounded stop is force-closed in the background', async () => {
  const provider = providerWithoutBrowser();
  provider._stopTimeoutMs = 5;
  provider._startupTimeoutMs = 100;
  const client = new EventEmitter();
  client.pupBrowser = null;
  client.destroy = async () => undefined;
  provider._clients.add(client);
  const initialization = new Promise(() => {});
  provider._initializingClients.set(client, initialization);

  await provider._stopClient(client);

  let killed = false;
  const browser = new EventEmitter();
  browser.isConnected = () => !killed;
  browser.process = () => ({ killed: false, kill: () => { killed = true; } });
  browser.close = async () => { killed = true; };
  client.pupBrowser = browser;
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(killed, true);
});

test('QR refresh uses the healthy page directly and publishes a revisioned fresh QR', async () => {
  const provider = providerWithoutBrowser();
  const { client } = fakeBrowserClient();
  provider.status = 'qr';
  provider.lastMethod = 'qr';
  provider.qrDataUrl = 'old-qr';
  let evaluations = 0;
  client.pupPage.evaluate = async () => {
    evaluations += 1;
    client.emit('qr', 'fresh-qr');
  };
  provider._bindClientEvents(client, 'qr', provider._generation);
  let restarts = 0;
  provider._startClient = async () => { restarts += 1; };

  await provider.refreshCode();

  assert.equal(evaluations, 1);
  assert.equal(restarts, 0);
  assert.match(provider.qrDataUrl, /ZnJlc2gtcXI=$/);
  assert.equal(provider.status, 'qr');
  assert.equal(provider.statusRevision, 1);
  assert.equal(provider.getStatus().revision, 1);
  assert.equal(provider.getStatus().instanceId, 'test-provider-instance');
  assert.ok(provider.qrIssuedAt);
});

test('phone-code refresh calls requestPairingCode directly on a healthy client', async () => {
  const provider = providerWithoutBrowser();
  const { client } = fakeBrowserClient();
  provider.status = 'pairing';
  provider.lastMethod = 'phone';
  provider.lastPhoneNumber = '919876543210';
  provider.pairingCode = 'OLD-CODE';
  const requested = [];
  client.requestPairingCode = async (phone, notify) => {
    requested.push([phone, notify]);
    client.emit('code', 'NEW-CODE');
    return 'NEW-CODE';
  };
  provider._bindClientEvents(client, 'phone', provider._generation);
  let restarts = 0;
  provider._startClient = async () => { restarts += 1; };

  await provider.refreshCode();

  assert.deepEqual(requested, [['919876543210', true]]);
  assert.equal(provider.pairingCode, 'NEW-CODE');
  assert.equal(provider.status, 'pairing');
  assert.equal(restarts, 0);
});

test('a stuck direct QR refresh times out and falls back to a bounded client restart', async () => {
  const provider = providerWithoutBrowser();
  provider._directRefreshTimeoutMs = 10;
  const { client } = fakeBrowserClient();
  provider.status = 'qr';
  provider.lastMethod = 'qr';
  client.pupPage.evaluate = () => new Promise(() => {});
  provider._bindClientEvents(client, 'qr', provider._generation);
  const starts = [];
  provider._startClient = async (...args) => { starts.push(args); };

  await provider.refreshCode();

  assert.deepEqual(starts, [['qr']]);
});

test('a slower stale QR encoding can never overwrite a newer QR', async () => {
  const provider = providerWithoutBrowser();
  const { client } = fakeBrowserClient();
  provider.status = 'qr';
  const pending = new Map();
  provider._encodeQr = (value) => new Promise((resolve, reject) => pending.set(value, { resolve, reject }));
  provider._bindClientEvents(client, 'qr', provider._generation);

  client.emit('qr', 'old');
  client.emit('qr', 'new');
  pending.get('new').resolve('new-data-url');
  await nextTurn();
  assert.equal(provider.qrDataUrl, 'new-data-url');
  assert.equal(provider.statusRevision, 1);

  pending.get('old').resolve('old-data-url');
  await nextTurn();
  assert.equal(provider.qrDataUrl, 'new-data-url');
  assert.equal(provider.statusRevision, 1);
});

test('unexpected Puppeteer browser disconnect retires the active setup client', async () => {
  const provider = providerWithoutBrowser();
  const { client, browser } = fakeBrowserClient();
  provider.status = 'qr';
  provider._bindClientEvents(client, 'qr', provider._generation);
  provider._attachBrowserDisconnect(client, provider._generation);

  browser.emit('disconnected');
  await nextTurn();

  assert.equal(provider.status, 'disconnected');
  assert.equal(provider.client, null);
  assert.match(provider.lastError, /closed unexpectedly/i);
});

test('authenticated state has a bounded ready timeout', async () => {
  const provider = providerWithoutBrowser();
  provider._authenticatedReadyTimeoutMs = 10;
  const { client } = fakeBrowserClient();
  provider.status = 'qr';
  provider._bindClientEvents(client, 'qr', provider._generation);

  client.emit('authenticated');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(provider.status, 'disconnected');
  assert.match(provider.lastError, /did not become ready/i);
});

test('shutdown closes all owned clients but preserves the LocalAuth profile', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-shutdown-test-'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const authRoot = path.join(tempRoot, 'wwebjs_auth');
  const sessionPath = path.join(authRoot, 'session');
  const statePath = path.join(sessionPath, 'state');
  await fs.promises.mkdir(sessionPath, { recursive: true });
  await fs.promises.writeFile(statePath, 'linked');
  const provider = providerWithoutBrowser();
  provider.status = 'ready';
  provider.authDataPath = authRoot;
  provider.authSessionPath = sessionPath;
  const { client, setConnected } = fakeBrowserClient();
  let destroyCalls = 0;
  client.destroy = async () => { destroyCalls += 1; setConnected(false); };
  provider.client = client;
  provider._clients.add(client);

  assert.equal(await provider.shutdown(), true);

  assert.equal(destroyCalls, 1);
  assert.equal(provider.status, 'disconnected');
  assert.equal(provider._clients.size, 0);
  assert.equal(fs.existsSync(statePath), true);
});

test('resetSetup removes only the contained incomplete LocalAuth session', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-reset-test-'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const authRoot = path.join(tempRoot, 'wwebjs_auth');
  const sessionPath = path.join(authRoot, 'session');
  const siblingPath = path.join(authRoot, 'keep.txt');
  await fs.promises.mkdir(path.join(sessionPath, 'Default'), { recursive: true });
  await fs.promises.writeFile(path.join(sessionPath, 'Default', 'state'), 'partial');
  await fs.promises.writeFile(siblingPath, 'keep');

  const provider = providerWithoutBrowser();
  provider.status = 'disconnected';
  provider.authDataPath = authRoot;
  provider.authSessionPath = sessionPath;
  await provider.resetSetup();

  assert.equal(fs.existsSync(sessionPath), false);
  assert.equal(fs.existsSync(siblingPath), true);
  assert.equal(provider.status, 'needs_setup');

  const outsidePath = path.join(tempRoot, 'outside-session');
  await fs.promises.mkdir(outsidePath);
  provider.status = 'disconnected';
  provider.authSessionPath = outsidePath;
  await assert.rejects(() => provider.resetSetup(), (error) => error.code === 'UNSAFE_WHATSAPP_SESSION_PATH');
  assert.equal(fs.existsSync(outsidePath), true);
});

test('resetSetup rejects a ready account without touching its profile', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-ready-reset-test-'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const authRoot = path.join(tempRoot, 'wwebjs_auth');
  const sessionPath = path.join(authRoot, 'session');
  await fs.promises.mkdir(sessionPath, { recursive: true });
  await fs.promises.writeFile(path.join(sessionPath, 'state'), 'linked');
  const provider = providerWithoutBrowser();
  provider.status = 'ready';
  provider.authDataPath = authRoot;
  provider.authSessionPath = sessionPath;

  await assert.rejects(() => provider.resetSetup(), /Disconnect the connected/i);
  assert.equal(fs.existsSync(path.join(sessionPath, 'state')), true);
});

test('resetSetup rejects a linked or junction auth root', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-linked-root-test-'));
  t.after(() => fs.promises.rm(tempRoot, { recursive: true, force: true }));
  const realAuthRoot = path.join(tempRoot, 'real-auth');
  const realSessionPath = path.join(realAuthRoot, 'session');
  const linkedAuthRoot = path.join(tempRoot, 'wwebjs_auth');
  await fs.promises.mkdir(realSessionPath, { recursive: true });
  const statePath = path.join(realSessionPath, 'state');
  await fs.promises.writeFile(statePath, 'outside');
  try {
    await fs.promises.symlink(realAuthRoot, linkedAuthRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('This environment does not permit creating a test directory link.');
      return;
    }
    throw error;
  }
  const provider = providerWithoutBrowser();
  provider.status = 'disconnected';
  provider.authDataPath = linkedAuthRoot;
  provider.authSessionPath = path.join(linkedAuthRoot, 'session');

  await assert.rejects(() => provider.resetSetup(), (error) => error.code === 'UNSAFE_WHATSAPP_SESSION_PATH');
  assert.equal(fs.existsSync(statePath), true);
});
