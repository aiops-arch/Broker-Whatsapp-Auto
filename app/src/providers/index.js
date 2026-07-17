const { WhatsAppWebProvider } = require('./whatsappWeb');
const { WhatsAppCloudApiProvider } = require('./whatsappCloudApi');

// Set WA_PROVIDER=cloud_api once the official Meta Cloud API is configured -
// everything else in the app (server.js, watcher.js) talks to whichever
// provider this returns through the same sendMessage/getStatus contract.
function createProvider() {
  const kind = (process.env.WA_PROVIDER || 'whatsapp_web').toLowerCase();
  if (kind === 'whatsapp_web') return new WhatsAppWebProvider();
  if (kind === 'cloud_api') return new WhatsAppCloudApiProvider();
  throw new Error(`Unknown WA_PROVIDER "${kind}" - expected "whatsapp_web" or "cloud_api".`);
}

module.exports = { createProvider };
