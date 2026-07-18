const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// The override exists for isolated automated tests and portable deployments;
// normal installations keep their database in this app instance's data dir.
const dbDir = process.env.BROKER_APP_DATA_DIR
  ? path.resolve(process.env.BROKER_APP_DATA_DIR)
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(path.join(dbDir, 'app.db'));

// Statuses: needs_info (missing broker/phone - must edit before it can be sent),
// draft (ready, waiting for the user to press Send), sending (atomically
// claimed by one worker), sent, failed (a definite send failure), and
// send_uncertain (an interrupted send that must never be retried blindly).
async function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brokers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT NOT NULL UNIQUE,
      demand_date TEXT,
      broker_name TEXT NOT NULL,
      party_name TEXT NOT NULL,
      buyer_name TEXT,
      phone TEXT,
      message TEXT NOT NULL,
      original_message TEXT,
      stone_count INTEGER NOT NULL DEFAULT 0,
      attachment_path TEXT,
      status TEXT NOT NULL DEFAULT 'needs_info',
      error TEXT,
      source_file TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages_log(status);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // SQLite's ALTER TABLE ADD COLUMN has no "IF NOT EXISTS" clause (unlike
  // Postgres) - check first, so this stays safe against a database created
  // before these columns existed.
  ensureColumn('buyer_name', 'TEXT');
  ensureColumn('wa_message_id', 'TEXT');
  ensureColumn('delivery_status', 'TEXT'); // null | sent | delivered | read
  ensureColumn('send_started_at', 'TEXT');
  ensureColumn('reconciled_at', 'TEXT');
  ensureColumn('reconciliation_note', 'TEXT');
  ensureColumn('content_signature', 'TEXT');
  ensureColumn('duplicate_of_id', 'INTEGER');
  ensureColumn('auto_sent', 'INTEGER');
  ensureColumn('archived_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_content_signature ON messages_log(content_signature);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_archived_at ON messages_log(archived_at);');

  // If the process exited after handing a message to WhatsApp but before the
  // final DB commit, delivery is unknowable. Keep that row locked instead of
  // converting it to failed/draft and risking a duplicate on restart.
  db.prepare(`
    UPDATE messages_log
    SET status = 'send_uncertain',
        error = 'The app stopped while this send was in progress. It may already have been delivered; verify in WhatsApp before taking further action.'
    WHERE status = 'sending'
  `).run();
}

function ensureColumn(name, type) {
  const columns = db.prepare(`PRAGMA table_info(messages_log)`).all();
  if (!columns.some((c) => c.name === name)) {
    db.exec(`ALTER TABLE messages_log ADD COLUMN ${name} ${type};`);
  }
}

function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Deliberately independent of demand_date/broker/dedup_key so it can catch a
// duplicate across two different imports/files - the thing dedup_key cannot
// do, since dedup_key intentionally bakes in the exact broker+date combo.
function computeContentSignature(phone, partyName, dedupComponentSignature) {
  const parts = [
    normalizePhoneDigits(phone),
    String(partyName || '').trim().toLowerCase(),
    String(dedupComponentSignature || ''),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function computeStatus(brokerName, phone) {
  if (!brokerName || brokerName === '(unassigned)') {
    return { status: 'needs_info', error: 'No broker assigned in the source sheet for this party - pick one before sending.' };
  }
  if (!phone) {
    return { status: 'needs_info', error: `No phone number on file for broker "${brokerName}" - add one before sending.` };
  }
  return { status: 'draft', error: null };
}

async function upsertBroker(name, phone) {
  const existing = db.prepare('SELECT id FROM brokers WHERE name = ?').get(name);
  if (existing) {
    db.prepare("UPDATE brokers SET phone = ?, updated_at = datetime('now') WHERE id = ?").run(phone || null, existing.id);
    return existing.id;
  }
  const info = db.prepare('INSERT INTO brokers (name, phone) VALUES (?, ?)').run(name, phone || null);
  return Number(info.lastInsertRowid);
}

async function getBrokerPhone(name) {
  const row = db.prepare('SELECT phone FROM brokers WHERE name = ?').get(name);
  return row ? row.phone : null;
}

async function listBrokers() {
  return db.prepare('SELECT * FROM brokers ORDER BY name').all();
}

async function deleteBroker(id) {
  db.prepare('DELETE FROM brokers WHERE id = ?').run(id);
}

async function findByDedupKey(dedupKey) {
  return db.prepare('SELECT * FROM messages_log WHERE dedup_key = ?').get(dedupKey) || null;
}

async function insertMessage(row) {
  const baseState = computeStatus(row.brokerName, row.phone);
  const status = row.validationError ? 'needs_info' : baseState.status;
  const error = row.validationError || baseState.error;

  // A cross-import "possible duplicate" check - broader than dedup_key, which
  // only catches an exact re-import (same broker+party+date+stones). This
  // catches the same content (party+stones) reaching the same phone number
  // from a DIFFERENT import/file, even with different wording or a different
  // date. Only meaningful when a phone is actually known; a failed send never
  // counts as a duplicate source since it didn't actually deliver anything.
  // The lookup-then-insert below is one synchronous, uninterrupted sequence
  // (node:sqlite's DatabaseSync has no await between them) - race-free for
  // the same reason claimMessageForSend's compare-and-swap is.
  const hasPhone = Boolean(row.phone && String(row.phone).trim());
  const signature = hasPhone ? computeContentSignature(row.phone, row.partyName, row.dedupComponentSignature) : null;
  const match = signature
    ? db.prepare(`SELECT id FROM messages_log WHERE content_signature = ? AND status != 'failed' ORDER BY id ASC LIMIT 1`).get(signature)
    : null;
  const duplicateOfId = match ? match.id : null;

  let info;
  try {
    info = db.prepare(`
      INSERT INTO messages_log
        (dedup_key, demand_date, broker_name, party_name, buyer_name, phone, message, original_message, stone_count, attachment_path, status, error, source_file, content_signature, duplicate_of_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.dedupKey, row.demandDate, row.brokerName, row.partyName, row.buyerName || null,
      row.phone || null, row.message, row.message, row.stoneCount, row.attachmentPath || null, status, error, row.sourceFile,
      signature, duplicateOfId,
    );
  } catch (dbError) {
    if (String(dbError?.message || '').includes('UNIQUE constraint failed') && String(dbError.message).includes('dedup_key')) {
      const tagged = new Error('This exact demand has already been imported.');
      tagged.code = 'DUPLICATE_DEDUP_KEY';
      throw tagged;
    }
    throw dbError;
  }
  return Number(info.lastInsertRowid);
}

async function updateMessage(id, { brokerName, phone, message, buyerName }) {
  const current = await getMessage(id);
  if (!current) return null;
  if (!['needs_info', 'draft', 'failed'].includes(current.status)) {
    const error = new Error('Sent, in-progress, and uncertain messages are locked and cannot be edited.');
    error.code = 'MESSAGE_NOT_EDITABLE';
    throw error;
  }
  const nextBrokerName = brokerName !== undefined ? brokerName : current.broker_name;
  const nextPhone = phone !== undefined ? phone : current.phone;
  const nextMessage = message !== undefined ? message : current.message;
  const nextBuyerName = buyerName !== undefined ? buyerName : current.buyer_name;
  const { status, error } = computeStatus(nextBrokerName, nextPhone);

  const info = db.prepare(`
    UPDATE messages_log
    SET broker_name = ?, phone = ?, message = ?, buyer_name = ?, status = ?, error = ?,
        sent_at = NULL, send_started_at = NULL
    WHERE id = ? AND status IN ('needs_info', 'draft', 'failed')
  `).run(nextBrokerName, nextPhone || null, nextMessage, nextBuyerName || null, status, error, id);
  if (Number(info.changes) !== 1) {
    const lockedError = new Error('This message changed while it was being edited and is now locked.');
    lockedError.code = 'MESSAGE_NOT_EDITABLE';
    throw lockedError;
  }
  return getMessage(id);
}

async function claimMessageForSend(id) {
  const info = db.prepare(`
    UPDATE messages_log
    SET status = 'sending', error = NULL, send_started_at = datetime('now')
    WHERE id = ? AND status IN ('draft', 'failed')
  `).run(id);
  if (Number(info.changes) !== 1) return null;
  return getMessage(id);
}

// delivery_status is deliberately left NULL here rather than assumed 'sent' -
// client.sendMessage() resolving only means WhatsApp Web accepted the call
// locally, not that WhatsApp's own servers actually received it (a false
// "sent" for an address that was never reachable looked identical to a real
// one until this distinction existed). Only a genuine 'message_ack' event
// (see setDeliveryStatusByWaId) or an operator's own manual verification
// (see reconcileUncertainMessage) may set delivery_status - the UI surfaces
// a status='sent' row with a still-null delivery_status past a short
// timeout as "not yet confirmed", per SEND-005.
async function markSent(id, waMessageId, options = {}) {
  const info = db.prepare(`
    UPDATE messages_log
    SET status = 'sent', error = NULL, sent_at = datetime('now'), send_started_at = NULL,
        wa_message_id = ?, auto_sent = ?,
        archived_at = COALESCE(archived_at, datetime('now'))
    WHERE id = ? AND status = 'sending'
  `).run(waMessageId || null, options.auto === true ? 1 : 0, id);
  return Number(info.changes) === 1;
}

// Called from the 'message_ack' event - looks the row up by the WhatsApp
// message id captured at send time, not our own row id.
async function setDeliveryStatusByWaId(waMessageId, deliveryStatus) {
  if (typeof waMessageId !== 'string' || !waMessageId.trim()) return false;
  if (!['sent', 'delivered', 'read'].includes(deliveryStatus)) return false;
  const info = db.prepare(
    'UPDATE messages_log SET delivery_status = ? WHERE wa_message_id = ?',
  ).run(deliveryStatus, waMessageId.trim());
  return Number(info.changes) > 0;
}

async function markFailed(id, error) {
  const info = db.prepare(`
    UPDATE messages_log
    SET status = 'failed', error = ?, send_started_at = NULL
    WHERE id = ? AND status = 'sending'
  `).run(String(error).slice(0, 2000), id);
  return Number(info.changes) === 1;
}

async function markSendUncertain(id, error) {
  const info = db.prepare(`
    UPDATE messages_log
    SET status = 'send_uncertain', error = ?
    WHERE id = ? AND status = 'sending'
  `).run(String(error).slice(0, 2000), id);
  return Number(info.changes) === 1;
}

async function reconcileUncertainMessage(id, decision) {
  if (decision !== 'sent' && decision !== 'retry') {
    const error = new Error('Decision must be either "sent" or "retry".');
    error.code = 'INVALID_RECONCILIATION_DECISION';
    throw error;
  }

  let info;
  if (decision === 'sent') {
    info = db.prepare(`
      UPDATE messages_log
      SET status = 'sent',
          error = NULL,
          sent_at = COALESCE(send_started_at, datetime('now')),
          send_started_at = NULL,
          wa_message_id = NULL,
          delivery_status = 'sent',
          reconciled_at = datetime('now'),
          reconciliation_note = 'Operator verified in the broker chat that this interrupted message was delivered.',
          archived_at = COALESCE(archived_at, datetime('now'))
      WHERE id = ? AND status = 'send_uncertain'
    `).run(id);
  } else {
    info = db.prepare(`
      UPDATE messages_log
      SET status = 'failed',
          error = 'Operator verified in the broker chat that this interrupted message was not delivered; it is ready for an explicit retry.',
          sent_at = NULL,
          send_started_at = NULL,
          wa_message_id = NULL,
          delivery_status = NULL,
          reconciled_at = datetime('now'),
          reconciliation_note = 'Operator verified in the broker chat that this interrupted message was not delivered and approved a retry.'
      WHERE id = ? AND status = 'send_uncertain'
    `).run(id);
  }

  if (Number(info.changes) !== 1) return null;
  return getMessage(id);
}

// Called once a new import has finished inserting its own rows. Sweeps every
// OTHER not-yet-archived row (any status) into the archive, so the main list
// always shows only the latest import - never a mix of it and older
// leftovers. Guard on insertedIds.length before calling this: an empty list
// (e.g. a fully-duplicate re-upload) must never blank the whole main list.
async function archiveAllExceptIds(ids) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE messages_log SET archived_at = datetime('now') WHERE archived_at IS NULL AND id NOT IN (${placeholders})`,
  ).run(...ids);
  return Number(info.changes);
}

async function listMessages({ status, archived } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (archived === true) clauses.push('archived_at IS NOT NULL');
  else if (archived === false) clauses.push('archived_at IS NULL');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM messages_log ${where} ORDER BY id DESC`).all(...params);
}

async function getMessage(id) {
  return db.prepare('SELECT * FROM messages_log WHERE id = ?').get(id) || null;
}

async function getSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

async function counts() {
  const rows = db.prepare('SELECT status, COUNT(*) as n FROM messages_log GROUP BY status').all();
  const out = { sent: 0, failed: 0, draft: 0, needs_info: 0, sending: 0, send_uncertain: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// A new import sweeping an unresolved failed/send_uncertain row into Archive
// (per the operator's own confirmed requirement) must never make that row
// silently disappear - this surfaces it as a small badge on the Archive nav
// item specifically, distinct from the main "Attention" tile (which already
// stays unscoped and still counts it too).
async function archivedAttentionCount() {
  const row = db.prepare(
    `SELECT COUNT(*) as n FROM messages_log WHERE archived_at IS NOT NULL AND status IN ('failed', 'send_uncertain')`,
  ).get();
  return Number(row?.n || 0);
}

module.exports = {
  db,
  DATA_DIR: dbDir,
  init,
  upsertBroker,
  getBrokerPhone,
  listBrokers,
  deleteBroker,
  findByDedupKey,
  insertMessage,
  updateMessage,
  claimMessageForSend,
  markSent,
  markFailed,
  markSendUncertain,
  reconcileUncertainMessage,
  setDeliveryStatusByWaId,
  archiveAllExceptIds,
  archivedAttentionCount,
  listMessages,
  getMessage,
  getSetting,
  setSetting,
  counts,
};
