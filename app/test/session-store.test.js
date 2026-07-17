const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');

const { SESSION_IDLE_TIMEOUT_MS, createSQLiteSessionStore } = require('../src/sqliteSessionStore');

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
}

test('authenticated session survives a server/store restart for at least 30 minutes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-session-store-test-'));
  const database = new DatabaseSync(path.join(root, 'sessions.db'));
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let currentTime = Date.now();
  const now = () => currentTime;
  const expires = new Date(currentTime + SESSION_IDLE_TIMEOUT_MS);
  const original = { authenticated: true, authGeneration: 0, cookie: { expires, maxAge: SESSION_IDLE_TIMEOUT_MS } };

  const firstProcessStore = createSQLiteSessionStore(session, database, { now });
  await callStore(firstProcessStore, 'set', 'session-id', original);

  const restartedProcessStore = createSQLiteSessionStore(session, database, { now });
  assert.equal((await callStore(restartedProcessStore, 'get', 'session-id')).authenticated, true);

  currentTime += SESSION_IDLE_TIMEOUT_MS - 1;
  assert.equal((await callStore(restartedProcessStore, 'get', 'session-id')).authenticated, true);
  currentTime += 1;
  assert.equal(await callStore(restartedProcessStore, 'get', 'session-id'), null);
});

test('clearing sessions invalidates every persisted login', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-session-clear-test-'));
  const database = new DatabaseSync(path.join(root, 'sessions.db'));
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = createSQLiteSessionStore(session, database);
  const sessionData = { authenticated: true, cookie: { expires: new Date(Date.now() + SESSION_IDLE_TIMEOUT_MS) } };
  await callStore(store, 'set', 'one', sessionData);
  await callStore(store, 'set', 'two', sessionData);
  await callStore(store, 'clear');
  assert.equal(await callStore(store, 'get', 'one'), null);
  assert.equal(await callStore(store, 'get', 'two'), null);
});
