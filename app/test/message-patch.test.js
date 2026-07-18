const assert = require('node:assert/strict');
const test = require('node:test');

const {
  withPatchedGreeting, withPatchedSignature, isDeliveryUnconfirmed, DELIVERY_CONFIRM_TIMEOUT_MS,
} = require('../public/messagePatch');

test('withPatchedGreeting fills in a blank greeting from a missing-broker import', () => {
  const message = "Dear ,\n\nPlease find today's demand:\n\nParty Name: Example Party\n1) StoneId: S-1";
  const patched = withPatchedGreeting(message, 'Suyash Umesh Mishra');
  assert.equal(patched, "Dear Suyash Umesh Mishra,\n\nPlease find today's demand:\n\nParty Name: Example Party\n1) StoneId: S-1");
});

test('withPatchedGreeting replaces an existing broker name in the greeting', () => {
  const message = 'Dear Old Broker,\n\nBody text';
  assert.equal(withPatchedGreeting(message, 'New Broker'), 'Dear New Broker,\n\nBody text');
});

test('withPatchedGreeting leaves a custom-worded first line untouched', () => {
  const message = 'Hello there,\n\nBody text';
  assert.equal(withPatchedGreeting(message, 'Someone'), message);
});

test('withPatchedSignature fills in a blank buyer name left after "Regards,"', () => {
  const message = '1) StoneId: N5095757 | Report#: 1523110109 | Color: E | Clarity: SI1 | Cts: 0.53\n\nRegards,';
  const patched = withPatchedSignature(message, 'Suyash Mishra');
  assert.equal(patched, '1) StoneId: N5095757 | Report#: 1523110109 | Color: E | Clarity: SI1 | Cts: 0.53\n\nRegards,\nSuyash Mishra');
});

test('withPatchedSignature replaces an existing buyer name after "Regards,"', () => {
  const message = 'Body\n\nRegards,\nOld Buyer';
  assert.equal(withPatchedSignature(message, 'New Buyer'), 'Body\n\nRegards,\nNew Buyer');
});

test('withPatchedSignature removes the whole signature block when the buyer name is cleared', () => {
  const message = 'Body text\n\nRegards,\nSome Buyer';
  assert.equal(withPatchedSignature(message, ''), 'Body text');
});

test('withPatchedSignature appends a fresh signature when a buyer name is typed for a row imported with none', () => {
  // Matches a real row imported with no buyer name at all (DRAFT-005's
  // {{buyerLine}} never rendered anything), so there is no "Regards," line
  // to find yet - assigning a buyer name here must still put a signature in
  // the actual outgoing message, not just save buyer_name to the database.
  const message = "Dear Broker,\n\nPlease find today's demand:\n\nParty Name: Example Party\n1) StoneId: S-1\n\n";
  const patched = withPatchedSignature(message, 'Suyash Mishra');
  assert.equal(patched, "Dear Broker,\n\nPlease find today's demand:\n\nParty Name: Example Party\n1) StoneId: S-1\n\nRegards,\nSuyash Mishra");
});

test('withPatchedSignature stays a no-op on a custom sign-off when the buyer name is cleared', () => {
  const message = 'Body text with a custom sign-off - Thanks!';
  assert.equal(withPatchedSignature(message, ''), message);
});

const FIXED_NOW = Date.UTC(2026, 6, 18, 12, 0, 0);
function sentAgo(ms) {
  return new Date(FIXED_NOW - ms).toISOString().slice(0, 19).replace('T', ' ');
}

test('isDeliveryUnconfirmed is false for a message that only just sent', () => {
  const row = { status: 'sent', delivery_status: null, sent_at: sentAgo(1000) };
  assert.equal(isDeliveryUnconfirmed(row, FIXED_NOW), false);
});

test('isDeliveryUnconfirmed is true once a sent message has gone unconfirmed past the timeout', () => {
  const row = { status: 'sent', delivery_status: null, sent_at: sentAgo(DELIVERY_CONFIRM_TIMEOUT_MS + 1000) };
  assert.equal(isDeliveryUnconfirmed(row, FIXED_NOW), true);
});

test('isDeliveryUnconfirmed is false once a real delivery_status is recorded, no matter how old', () => {
  const row = { status: 'sent', delivery_status: 'sent', sent_at: sentAgo(DELIVERY_CONFIRM_TIMEOUT_MS * 10) };
  assert.equal(isDeliveryUnconfirmed(row, FIXED_NOW), false);
});

test('isDeliveryUnconfirmed is false for any non-"sent" status', () => {
  const row = { status: 'draft', delivery_status: null, sent_at: sentAgo(DELIVERY_CONFIRM_TIMEOUT_MS * 10) };
  assert.equal(isDeliveryUnconfirmed(row, FIXED_NOW), false);
});
