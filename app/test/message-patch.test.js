const assert = require('node:assert/strict');
const test = require('node:test');

const { withPatchedGreeting, withPatchedSignature } = require('../public/messagePatch');

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

test('withPatchedSignature does nothing when there is no recognizable "Regards," line', () => {
  const message = 'Body text with a custom sign-off - Thanks!';
  assert.equal(withPatchedSignature(message, 'Someone'), message);
});
