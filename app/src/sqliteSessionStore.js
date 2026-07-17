const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function callbackSafe(callback, error, value) {
  if (typeof callback === 'function') callback(error, value);
}

function sessionExpiry(sessionData, now) {
  const expires = sessionData?.cookie?.expires;
  const parsed = expires ? new Date(expires).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : now() + SESSION_IDLE_TIMEOUT_MS;
}

function createSQLiteSessionStore(sessionModule, database, { now = Date.now } = {}) {
  class SQLiteSessionStore extends sessionModule.Store {
    constructor() {
      super();
      database.exec(`
        CREATE TABLE IF NOT EXISTS app_sessions (
          sid TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_app_sessions_expiry ON app_sessions(expires_at);
      `);
      this._deleteExpired = database.prepare('DELETE FROM app_sessions WHERE expires_at <= ?');
      this._get = database.prepare('SELECT data, expires_at FROM app_sessions WHERE sid = ?');
      this._set = database.prepare(`
        INSERT INTO app_sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
      `);
      this._destroy = database.prepare('DELETE FROM app_sessions WHERE sid = ?');
      this._clear = database.prepare('DELETE FROM app_sessions');
    }

    get(sid, callback) {
      try {
        const currentTime = now();
        this._deleteExpired.run(currentTime);
        const row = this._get.get(String(sid));
        if (!row || Number(row.expires_at) <= currentTime) return callbackSafe(callback, null, null);
        return callbackSafe(callback, null, JSON.parse(row.data));
      } catch (error) {
        return callbackSafe(callback, error);
      }
    }

    set(sid, sessionData, callback) {
      try {
        this._deleteExpired.run(now());
        this._set.run(String(sid), JSON.stringify(sessionData), sessionExpiry(sessionData, now));
        return callbackSafe(callback, null);
      } catch (error) {
        return callbackSafe(callback, error);
      }
    }

    touch(sid, sessionData, callback) {
      return this.set(sid, sessionData, callback);
    }

    destroy(sid, callback) {
      try {
        this._destroy.run(String(sid));
        return callbackSafe(callback, null);
      } catch (error) {
        return callbackSafe(callback, error);
      }
    }

    clear(callback) {
      try {
        this._clear.run();
        return callbackSafe(callback, null);
      } catch (error) {
        return callbackSafe(callback, error);
      }
    }
  }

  return new SQLiteSessionStore();
}

module.exports = { SESSION_IDLE_TIMEOUT_MS, createSQLiteSessionStore, sessionExpiry };
