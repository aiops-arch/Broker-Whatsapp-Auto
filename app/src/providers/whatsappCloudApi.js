const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { validateAttachmentPath } = require('../attachmentPolicy');

const GRAPH_VERSION = process.env.WA_CLOUD_API_GRAPH_VERSION || 'v20.0';

// The official Meta WhatsApp Business Cloud API - same sendMessage/getStatus
// contract as WhatsAppWebProvider, so switching providers.index.js over to
// this one is a one-line change once credentials exist.
//
// Not wired up yet - inert (status: 'not_configured') until you set:
//   WA_CLOUD_API_TOKEN            - permanent access token from Meta
//   WA_CLOUD_API_PHONE_NUMBER_ID  - the sending number's phone_number_id
//
// IMPORTANT difference from WhatsApp Web: Meta only allows freeform text (what
// this app sends today) to a broker who has messaged you in the last 24h, or
// to Meta's test numbers during development. For real, business-initiated
// daily demand messages you must register an approved message template in
// Meta Business Manager and send via the template payload shape instead of
// freeform text - that mapping isn't built yet since it depends on the exact
// template you get approved. Everything else here (images, video, status)
// works today against a configured account.
class WhatsAppCloudApiProvider extends EventEmitter {
  constructor() {
    super();
    this.kind = 'cloud_api';
    this.label = 'WhatsApp Business Cloud API (official)';
    this.token = process.env.WA_CLOUD_API_TOKEN || null;
    this.phoneNumberId = process.env.WA_CLOUD_API_PHONE_NUMBER_ID || null;
    this.status = this.token && this.phoneNumberId ? 'ready' : 'not_configured';
  }

  getStatus() {
    return {
      kind: this.kind,
      label: this.label,
      status: this.status,
      qrDataUrl: null,
      configHint: this.status === 'not_configured'
        ? 'Set WA_CLOUD_API_TOKEN and WA_CLOUD_API_PHONE_NUMBER_ID to activate the official API.'
        : null,
    };
  }

  isReady() {
    return this.status === 'ready';
  }

  formatE164(rawPhone) {
    let digits = String(rawPhone || '').replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.length === 10) digits = (process.env.WA_DEFAULT_COUNTRY_CODE || '91') + digits;
    return digits;
  }

  async _uploadMedia(filePath) {
    const attachment = validateAttachmentPath(filePath);
    if (!attachment.ok) throw new Error(attachment.error);
    const { mimeType, mediaType } = attachment;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: mimeType }), path.basename(filePath));

    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'Media upload to WhatsApp failed');
    return { id: data.id, mimeType, mediaType };
  }

  async sendMessage(phone, message, attachmentPath) {
    if (!this.isReady()) {
      throw new Error('Official WhatsApp API is not configured yet - set WA_CLOUD_API_TOKEN and WA_CLOUD_API_PHONE_NUMBER_ID.');
    }
    const to = this.formatE164(phone);
    if (!to) throw new Error('No valid phone number for this broker.');

    let payload;
    if (attachmentPath) {
      const { id, mediaType } = await this._uploadMedia(attachmentPath);
      payload = { messaging_product: 'whatsapp', to, type: mediaType, [mediaType]: { id, caption: message } };
    } else {
      payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } };
    }

    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || 'WhatsApp Cloud API send failed');
    const outboundId = data?.messages?.[0]?.id;
    return typeof outboundId === 'string' && outboundId.trim() ? outboundId : null;
  }
}

module.exports = { WhatsAppCloudApiProvider };
