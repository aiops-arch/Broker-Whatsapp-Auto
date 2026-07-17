const crypto = require('node:crypto');

const MIN_PASSWORD_LENGTH = 8;
const RECOVERY_CODE_TTL_MS = 10 * 60 * 1000;
const RECOVERY_REQUEST_COOLDOWN_MS = 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;

// Node's built-in scrypt - no extra dependency (bcrypt would need a native
// build, which we specifically avoid so the app stays portable/bundleable).
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Keeps recovery codes entirely in process memory. Only the salted scrypt
// digest is retained; the six-digit value exists just long enough to hand it
// to the supplied send function.
function createRecoveryManager({
  now = Date.now,
  randomInt = crypto.randomInt,
  ttlMs = RECOVERY_CODE_TTL_MS,
  cooldownMs = RECOVERY_REQUEST_COOLDOWN_MS,
  maxAttempts = RECOVERY_MAX_ATTEMPTS,
} = {}) {
  let activeCode = null;
  let nextRequestAt = 0;
  let requestInFlight = false;

  function getStatus() {
    const currentTime = now();
    if (activeCode && currentTime >= activeCode.expiresAt) activeCode = null;
    return {
      codePending: !!activeCode,
      expiresInMs: activeCode ? Math.max(0, activeCode.expiresAt - currentTime) : 0,
      cooldownRemainingMs: Math.max(0, nextRequestAt - currentTime),
    };
  }

  async function request(sendCode) {
    if (typeof sendCode !== 'function') {
      throw new TypeError('A recovery-code sender is required.');
    }

    const currentTime = now();
    if (requestInFlight || currentTime < nextRequestAt) {
      return {
        ok: false,
        reason: 'cooldown',
        retryAfterMs: Math.max(1000, nextRequestAt - currentTime),
      };
    }

    requestInFlight = true;
    nextRequestAt = currentTime + cooldownMs;

    try {
      const code = String(randomInt(0, 1000000)).padStart(6, '0');
      const salt = crypto.randomBytes(16);
      const digest = crypto.scryptSync(code, salt, 32);
      await sendCode(code);
      activeCode = {
        salt,
        digest,
        expiresAt: now() + ttlMs,
        failedAttempts: 0,
      };
      return { ok: true };
    } catch (error) {
      activeCode = null;
      return { ok: false, reason: 'send_failed' };
    } finally {
      requestInFlight = false;
    }
  }

  function verify(code) {
    const currentTime = now();
    if (!activeCode || currentTime >= activeCode.expiresAt) {
      activeCode = null;
      return { ok: false, reason: 'invalid_or_expired' };
    }

    activeCode.failedAttempts += 1;
    let matches = false;
    const submittedCode = String(code || '');
    if (/^\d{6}$/.test(submittedCode)) {
      const actual = crypto.scryptSync(submittedCode, activeCode.salt, 32);
      matches = crypto.timingSafeEqual(actual, activeCode.digest);
    }

    if (matches) {
      activeCode = null;
      return { ok: true };
    }

    if (activeCode.failedAttempts >= maxAttempts) activeCode = null;
    return { ok: false, reason: 'invalid_or_expired' };
  }

  function clear() {
    activeCode = null;
  }

  return { getStatus, request, verify, clear };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  RECOVERY_CODE_TTL_MS,
  RECOVERY_REQUEST_COOLDOWN_MS,
  RECOVERY_MAX_ATTEMPTS,
  hashPassword,
  verifyPassword,
  createRecoveryManager,
};
