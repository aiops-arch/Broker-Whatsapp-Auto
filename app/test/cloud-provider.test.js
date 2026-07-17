const test = require('node:test');
const assert = require('node:assert/strict');

const { WhatsAppCloudApiProvider } = require('../src/providers/whatsappCloudApi');

test('Cloud API sendMessage returns the outbound WhatsApp id or null', async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.WA_CLOUD_API_TOKEN;
  const originalPhoneId = process.env.WA_CLOUD_API_PHONE_NUMBER_ID;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.WA_CLOUD_API_TOKEN;
    else process.env.WA_CLOUD_API_TOKEN = originalToken;
    if (originalPhoneId === undefined) delete process.env.WA_CLOUD_API_PHONE_NUMBER_ID;
    else process.env.WA_CLOUD_API_PHONE_NUMBER_ID = originalPhoneId;
  });

  process.env.WA_CLOUD_API_TOKEN = 'test-token';
  process.env.WA_CLOUD_API_PHONE_NUMBER_ID = 'test-phone-id';
  const responses = [
    { messages: [{ id: 'wamid.outbound-123' }] },
    { messaging_product: 'whatsapp', contacts: [] },
  ];
  global.fetch = async () => ({ ok: true, json: async () => responses.shift() });

  const provider = new WhatsAppCloudApiProvider();
  assert.equal(await provider.sendMessage('9876543210', 'First'), 'wamid.outbound-123');
  assert.equal(await provider.sendMessage('9876543210', 'Second'), null);
});
