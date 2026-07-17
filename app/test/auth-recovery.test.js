const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecoveryManager } = require('../src/auth');

test('recovery code is sent once, hashed in memory, and verifies once', async () => {
  let currentTime = 1000;
  let deliveredCode = null;
  const recovery = createRecoveryManager({
    now: () => currentTime,
    randomInt: () => 42,
    ttlMs: 10_000,
    cooldownMs: 1_000,
    maxAttempts: 5,
  });

  const requested = await recovery.request(async (code) => { deliveredCode = code; });
  assert.deepEqual(requested, { ok: true });
  assert.equal(deliveredCode, '000042');
  assert.equal(recovery.getStatus().codePending, true);
  assert.deepEqual(recovery.verify('000042'), { ok: true });
  assert.deepEqual(recovery.verify('000042'), { ok: false, reason: 'invalid_or_expired' });
});

test('recovery code expires and enforces cooldown and attempt limit', async () => {
  let currentTime = 1000;
  const recovery = createRecoveryManager({
    now: () => currentTime,
    randomInt: () => 123456,
    ttlMs: 100,
    cooldownMs: 50,
    maxAttempts: 2,
  });

  await recovery.request(async () => {});
  assert.equal((await recovery.request(async () => {})).reason, 'cooldown');
  assert.equal(recovery.verify('111111').ok, false);
  assert.equal(recovery.verify('222222').ok, false);
  assert.equal(recovery.getStatus().codePending, false);

  currentTime = 2000;
  await recovery.request(async () => {});
  currentTime = 2200;
  assert.deepEqual(recovery.verify('123456'), { ok: false, reason: 'invalid_or_expired' });
});

test('failed delivery never leaves an active reset code', async () => {
  const recovery = createRecoveryManager({ randomInt: () => 654321, cooldownMs: 1 });
  const result = await recovery.request(async () => { throw new Error('offline'); });
  assert.deepEqual(result, { ok: false, reason: 'send_failed' });
  assert.equal(recovery.getStatus().codePending, false);
});
