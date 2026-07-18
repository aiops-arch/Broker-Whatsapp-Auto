// Pure, DOM-free string helpers shared by app.js's Edit-draft modal and
// node:test - loaded as a plain global-scope script before app.js (classic
// script tags, no bundler/module loader in this app), and required directly
// by tests via the module.exports guard below, which is a no-op in the
// browser since `module` is never defined there.

function withPatchedGreeting(message, brokerName) {
  const lines = String(message).split('\n');
  if (/^Dear .*,$/.test(lines[0])) {
    lines[0] = `Dear ${brokerName},`;
    return lines.join('\n');
  }
  return message; // first line isn't a recognizable greeting - leave custom wording alone
}

function withPatchedSignature(message, buyerName) {
  const lines = String(message).split('\n');
  let signatureLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === 'Regards,') { signatureLine = i; break; }
  }
  if (signatureLine === -1) {
    // No existing "Regards," block - the row was most likely imported with
    // no buyer name at all (so DRAFT-005's {{buyerLine}} never rendered one).
    // Appending it the first time a buyer name is entered closes the loop:
    // otherwise buyer_name silently saves to the database while the actual
    // outgoing message text never gains a signature at all.
    if (!buyerName) return message;
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [...lines, '', 'Regards,', buyerName].join('\n');
  }
  const before = lines.slice(0, signatureLine);
  while (before.length && before[before.length - 1] === '') before.pop();
  return buyerName ? [...before, '', 'Regards,', buyerName].join('\n') : before.join('\n');
}

// A 'sending' -> 'sent' transition only means WhatsApp Web accepted the call
// locally (see db.js's markSent) - delivery_status stays null until a real
// 'message_ack' event confirms WhatsApp's own servers actually received it.
// Past this timeout with still no confirmation, surface it instead of
// looking identical to a message that's fully, quietly confirmed. `now`
// defaults to Date.now() but is injectable for deterministic tests.
const DELIVERY_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

function isDeliveryUnconfirmed(row, now = Date.now()) {
  if (row.status !== 'sent' || row.delivery_status || !row.sent_at) return false;
  // SQLite's datetime('now') is UTC, formatted without a timezone suffix.
  const sentAtMs = Date.parse(`${row.sent_at.replace(' ', 'T')}Z`);
  return Number.isFinite(sentAtMs) && now - sentAtMs > DELIVERY_CONFIRM_TIMEOUT_MS;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { withPatchedGreeting, withPatchedSignature, isDeliveryUnconfirmed, DELIVERY_CONFIRM_TIMEOUT_MS };
}
