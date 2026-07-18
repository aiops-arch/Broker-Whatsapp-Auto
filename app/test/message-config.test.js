const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-message-config-test-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');
const messageConfig = require('../src/messageConfig');

test.before(async () => {
  await db.init();
});

function withRole(fields, role, overrides) {
  return fields.map((f) => (f.role === role ? { ...f, ...overrides } : f));
}

test('the default field mapping validates cleanly', () => {
  assert.doesNotThrow(() => messageConfig.validateFieldMapping(messageConfig.getDefaultFieldMapping()));
});

test('the default message template validates against the default mapping', () => {
  assert.doesNotThrow(() => messageConfig.validateMessageTemplate(
    messageConfig.getDefaultMessageTemplate(),
    messageConfig.getDefaultFieldMapping(),
  ));
});

test('mapping without a broker_name role is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping().map((f) => (f.role === 'broker_name' ? { ...f, role: 'ignore' } : f));
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('mapping with two broker_name roles is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  fields[0] = { ...fields[0], role: 'broker_name' };
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('mapping with two broker_phone roles is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  fields[0] = { ...fields[0], role: 'broker_phone' };
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('mapping with no group fields is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping().map((f) => (f.role === 'group' ? { ...f, role: 'header' } : f));
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('mapping with no primary group field is rejected', () => {
  const fields = withRole(messageConfig.getDefaultFieldMapping(), 'group', { primaryGroupField: false });
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('duplicate field keys are rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  fields[1] = { ...fields[1], key: fields[2].key };
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('duplicate source headers (case/whitespace-insensitive) are rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  fields[1] = { ...fields[1], sourceHeader: `  ${fields[2].sourceHeader.toUpperCase()}  ` };
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('a field key that is not a valid identifier is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  fields[3] = { ...fields[3], key: '1-bad key' };
  assert.throws(() => messageConfig.validateFieldMapping(fields), (error) => error.code === 'INVALID_FIELD_MAPPING');
});

test('a template referencing an unmapped placeholder is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  const template = { ...messageConfig.getDefaultMessageTemplate(), headerTemplate: 'Hi {{doesNotExist}} {{lineItems}}' };
  assert.throws(
    () => messageConfig.validateMessageTemplate(template, fields),
    (error) => error.code === 'UNKNOWN_TEMPLATE_PLACEHOLDER' && /doesNotExist/.test(error.message),
  );
});

test('a template missing {{lineItems}} is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  const template = { ...messageConfig.getDefaultMessageTemplate(), headerTemplate: 'Hi {{brokerName}}' };
  assert.throws(() => messageConfig.validateMessageTemplate(template, fields), (error) => error.code === 'MISSING_LINE_ITEMS_PLACEHOLDER');
});

test('a line-item template referencing a header-only field is rejected', () => {
  const fields = messageConfig.getDefaultFieldMapping();
  const template = { ...messageConfig.getDefaultMessageTemplate(), lineItemTemplate: '{{index}}) {{partyName}}' };
  assert.throws(
    () => messageConfig.validateMessageTemplate(template, fields),
    (error) => error.code === 'UNKNOWN_TEMPLATE_PLACEHOLDER' && /partyName/.test(error.message),
  );
});

test('renderTemplate performs plain substitution and never executes injected code', () => {
  const rendered = messageConfig.renderTemplate('Hello {{name}}, balance: {{amount}}', {
    name: '${process.exit(1)}',
    amount: '`touch pwned`',
  });
  assert.equal(rendered, 'Hello ${process.exit(1)}, balance: `touch pwned`');
});

test('renderTemplate leaves unmatched placeholders blank rather than throwing', () => {
  const rendered = messageConfig.renderTemplate('Hello {{missing}}!', {});
  assert.equal(rendered, 'Hello !');
});

test('renderPreviewMessage produces a non-empty illustrative message for the default mapping', () => {
  const message = messageConfig.renderPreviewMessage(
    messageConfig.getDefaultFieldMapping(),
    messageConfig.getDefaultMessageTemplate(),
  );
  assert.match(message, /Dear Sample Broker,/);
  assert.match(message, /1\) StoneId: Sample Stone ID/);
});

test('getFieldMapping seeds and persists the default mapping on first read', async () => {
  const fields = await messageConfig.getFieldMapping();
  assert.equal(fields.length, messageConfig.getDefaultFieldMapping().length);
  const raw = await db.getSetting('field_mapping_config_v1');
  assert.ok(raw && JSON.parse(raw).length === fields.length);
});

test('setFieldMapping rejects an invalid mapping without persisting it', async () => {
  const before = await db.getSetting('field_mapping_config_v1');
  const invalid = messageConfig.getDefaultFieldMapping().map((f) => (f.role === 'broker_name' ? { ...f, role: 'ignore' } : f));
  await assert.rejects(messageConfig.setFieldMapping(invalid), (error) => error.code === 'INVALID_FIELD_MAPPING');
  const after = await db.getSetting('field_mapping_config_v1');
  assert.equal(after, before);
});

test('onboarding completion flag round-trips through settings', async () => {
  // Asserts the round-trip itself, not an assumed pristine starting value -
  // this setting is a single global flag, so it must not assume no other
  // test file (sharing the same process under --test-isolation=none in the
  // release build) has already touched it.
  await messageConfig.setOnboardingCompleted(false);
  assert.equal(await messageConfig.getOnboardingCompleted(), false);
  await messageConfig.setOnboardingCompleted(true);
  assert.equal(await messageConfig.getOnboardingCompleted(), true);
});
