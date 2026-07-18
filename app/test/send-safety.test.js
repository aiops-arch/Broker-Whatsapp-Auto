const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-send-db-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');
const { sendMessagesByIds } = require('../src/watcher');
const { coordinateMessageSends } = require('../src/sendCoordinator');

let nextKey = 1;
async function createDraft() {
  const key = nextKey++;
  return db.insertMessage({
    dedupKey: `send-test-${key}`,
    demandDate: '2026-07-17',
    brokerName: `Broker ${key}`,
    partyName: `Party ${key}`,
    phone: '9876543210',
    message: `Message ${key}`,
    stoneCount: 1,
    sourceFile: 'test.xlsx',
  });
}

async function createUncertain() {
  const id = await createDraft();
  const claimed = await db.claimMessageForSend(id);
  assert.equal(claimed.status, 'sending');
  await db.init();
  assert.equal((await db.getMessage(id)).status, 'send_uncertain');
  return id;
}

test.before(async () => {
  await db.init();
});

test.after(() => {
  db.db.close();
  fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  delete process.env.BROKER_APP_DATA_DIR;
});

test('requested ids are deduplicated and a sent row cannot be resent', async () => {
  const id = await createDraft();
  let sendCount = 0;
  const whatsapp = {
    isReady: () => true,
    sendMessage: async () => {
      sendCount += 1;
      return 'wamid.once';
    },
  };

  const first = await sendMessagesByIds([id, String(id), id], whatsapp);
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, true);
  assert.equal(first[0].waMessageId, 'wamid.once');
  assert.equal(sendCount, 1);

  const second = await sendMessagesByIds([id], whatsapp);
  assert.equal(second[0].blocked, true);
  assert.match(second[0].error, /already sent/i);
  assert.equal(sendCount, 1);
  assert.equal((await db.getMessage(id)).status, 'sent');
});

test('concurrent callers cannot both send the same row', async () => {
  const id = await createDraft();
  let releaseSend;
  let announceSend;
  let sendCount = 0;
  const started = new Promise((resolve) => { announceSend = resolve; });
  const released = new Promise((resolve) => { releaseSend = resolve; });
  const whatsapp = {
    isReady: () => true,
    sendMessage: async () => {
      sendCount += 1;
      announceSend();
      await released;
      return 'wamid.concurrent';
    },
  };

  const firstPromise = sendMessagesByIds([id], whatsapp);
  await started;
  const secondPromise = sendMessagesByIds([id], whatsapp);
  const second = await secondPromise;
  releaseSend();
  const first = await firstPromise;

  assert.equal(sendCount, 1);
  assert.equal(first[0].ok, true);
  assert.equal(second[0].blocked, true);
  assert.match(second[0].error, /already in progress/i);
});

test('a process restart turns an unfinished claim into locked send_uncertain', async () => {
  const id = await createDraft();
  const claimed = await db.claimMessageForSend(id);
  assert.equal(claimed.status, 'sending');

  // init() is the startup recovery step. It must never make this retryable.
  await db.init();
  const recovered = await db.getMessage(id);
  assert.equal(recovered.status, 'send_uncertain');
  assert.match(recovered.error, /may already have been delivered/i);

  let sendCount = 0;
  const result = await sendMessagesByIds([id], {
    isReady: () => true,
    sendMessage: async () => { sendCount += 1; },
  });
  assert.equal(result[0].blocked, true);
  assert.equal(result[0].uncertain, true);
  assert.equal(sendCount, 0);

  await assert.rejects(
    db.updateMessage(id, { message: 'Try to unlock it' }),
    (error) => error.code === 'MESSAGE_NOT_EDITABLE',
  );
});

test('only send_uncertain can be manually reconciled as delivered', async () => {
  const ordinaryDraftId = await createDraft();
  assert.equal(await db.reconcileUncertainMessage(ordinaryDraftId, 'sent'), null);
  assert.equal((await db.getMessage(ordinaryDraftId)).status, 'draft');

  const uncertainId = await createUncertain();
  const reconciled = await db.reconcileUncertainMessage(uncertainId, 'sent');
  assert.equal(reconciled.status, 'sent');
  assert.equal(reconciled.wa_message_id, null);
  assert.equal(reconciled.delivery_status, 'sent');
  assert.ok(reconciled.reconciled_at);
  assert.match(reconciled.reconciliation_note, /operator verified.*delivered/i);

  // The transition is one-shot; even the same decision cannot act on sent.
  assert.equal(await db.reconcileUncertainMessage(uncertainId, 'sent'), null);
  let sendCount = 0;
  const sendResult = await sendMessagesByIds([uncertainId], {
    isReady: () => true,
    sendMessage: async () => { sendCount += 1; },
  });
  assert.equal(sendResult[0].blocked, true);
  assert.equal(sendCount, 0);
});

test('operator-verified non-delivery can unlock send_uncertain for one explicit retry', async () => {
  const uncertainId = await createUncertain();
  const reconciled = await db.reconcileUncertainMessage(uncertainId, 'retry');
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.error, /ready for an explicit retry/i);
  assert.ok(reconciled.reconciled_at);
  assert.match(reconciled.reconciliation_note, /operator verified.*not delivered.*approved a retry/i);

  let sendCount = 0;
  const result = await sendMessagesByIds([uncertainId], {
    isReady: () => true,
    sendMessage: async () => {
      sendCount += 1;
      return 'wamid.after-manual-check';
    },
  });
  assert.equal(result[0].ok, true);
  assert.equal(sendCount, 1);
  const sent = await db.getMessage(uncertainId);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.wa_message_id, 'wamid.after-manual-check');
  assert.match(sent.reconciliation_note, /approved a retry/i);

  await assert.rejects(
    db.reconcileUncertainMessage(uncertainId, 'anything-else'),
    (error) => error.code === 'INVALID_RECONCILIATION_DECISION',
  );
});

test('a duplicate-flagged row requires confirmDuplicate before it can be sent, and confirming allows it through', async () => {
  const firstId = await db.insertMessage({
    dedupKey: 'dup-gate-first', demandDate: '2026-07-17', brokerName: 'Broker Dup', partyName: 'Same Party',
    phone: '9990001111', message: 'First message', stoneCount: 1, sourceFile: 'test.xlsx', dedupComponentSignature: 'stone-A',
  });
  const secondId = await db.insertMessage({
    dedupKey: 'dup-gate-second', demandDate: '2026-07-18', brokerName: 'Broker Dup', partyName: 'Same Party',
    phone: '9990001111', message: 'Second message, different wording', stoneCount: 1, sourceFile: 'test2.xlsx', dedupComponentSignature: 'stone-A',
  });

  const secondRow = await db.getMessage(secondId);
  assert.equal(secondRow.duplicate_of_id, firstId);

  let sendCount = 0;
  const whatsapp = { isReady: () => true, sendMessage: async () => { sendCount += 1; return 'wamid.dup'; } };

  const blocked = await sendMessagesByIds([secondId], whatsapp);
  assert.equal(blocked[0].blocked, true);
  assert.equal(blocked[0].duplicate, true);
  assert.equal(blocked[0].duplicateOfId, firstId);
  assert.equal(sendCount, 0);
  assert.equal((await db.getMessage(secondId)).status, 'draft');

  const confirmed = await sendMessagesByIds([secondId], whatsapp, { confirmedIds: [secondId] });
  assert.equal(confirmed[0].ok, true);
  assert.equal(sendCount, 1);
  assert.equal((await db.getMessage(secondId)).status, 'sent');
});

test('bulk/send-all-drafts-style calls never bypass the duplicate gate, even without an explicit UI selection step', async () => {
  const firstId = await db.insertMessage({
    dedupKey: 'dup-bulk-first', demandDate: '2026-07-17', brokerName: 'Broker Bulk', partyName: 'Bulk Party',
    phone: '9990002222', message: 'm1', stoneCount: 1, sourceFile: 'a.xlsx', dedupComponentSignature: 'stone-B',
  });
  const secondId = await db.insertMessage({
    dedupKey: 'dup-bulk-second', demandDate: '2026-07-18', brokerName: 'Broker Bulk', partyName: 'Bulk Party',
    phone: '9990002222', message: 'm2', stoneCount: 1, sourceFile: 'b.xlsx', dedupComponentSignature: 'stone-B',
  });
  let sendCount = 0;
  const whatsapp = { isReady: () => true, sendMessage: async () => { sendCount += 1; return 'wamid.bulk'; } };
  // No confirmedIds here - exactly how send-bulk/send-all-drafts/auto-send call this.
  const results = await sendMessagesByIds([firstId, secondId], whatsapp);
  const firstResult = results.find((r) => r.id === firstId);
  const secondResult = results.find((r) => r.id === secondId);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.blocked, true);
  assert.equal(secondResult.duplicate, true);
  assert.equal(sendCount, 1);
});

test('a markFailed database failure still resolves to send_uncertain rather than an uncaught throw', async () => {
  const rows = new Map();
  rows.set(1, { id: 1, phone: '999', broker_name: 'B', status: 'draft', attachment_path: null });
  let markSendUncertainCalled = false;
  const store = {
    getMessage: async (id) => rows.get(id),
    claimMessageForSend: async (id) => {
      const row = rows.get(id);
      if (!row || row.status !== 'draft') return null;
      row.status = 'sending';
      return { ...row };
    },
    markFailed: async () => { throw new Error('db write failed'); },
    markSendUncertain: async (id, message) => {
      markSendUncertainCalled = true;
      const row = rows.get(id);
      row.status = 'send_uncertain';
      row.error = message;
      return true;
    },
  };
  const whatsapp = { isReady: () => true, sendMessage: async () => { throw new Error('WhatsApp exploded'); } };

  const results = await coordinateMessageSends([1], whatsapp, { store });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].uncertain, true);
  assert.equal(markSendUncertainCalled, true);
  assert.equal(rows.get(1).status, 'send_uncertain');
});

test('a throwing notifyUpdate listener does not abort the remaining ids in a batch', async () => {
  const id1 = await createDraft();
  const id2 = await createDraft();
  let notifyCount = 0;
  const notifyUpdate = () => { notifyCount += 1; throw new Error('listener exploded'); };
  const whatsapp = { isReady: () => true, sendMessage: async () => 'wamid.notify-test' };
  const results = await coordinateMessageSends([id1, id2], whatsapp, {
    store: db, notifyUpdate, validateAttachment: () => ({ ok: true }),
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.ok(notifyCount > 0);
});

test('malformed WhatsApp acknowledgements cannot crash SQLite delivery tracking', async () => {
  await assert.doesNotReject(db.setDeliveryStatusByWaId(undefined, 'delivered'));
  assert.equal(await db.setDeliveryStatusByWaId(undefined, 'delivered'), false);
  assert.equal(await db.setDeliveryStatusByWaId('wamid.unknown', 'invalid-status'), false);

  const id = await createDraft();
  await db.claimMessageForSend(id);
  await db.markSent(id, 'wamid.delivery-test');
  assert.equal(await db.setDeliveryStatusByWaId('wamid.delivery-test', 'delivered'), true);
  assert.equal((await db.getMessage(id)).delivery_status, 'delivered');
});

test('markSent leaves delivery_status unconfirmed (null) until a real WhatsApp ack arrives', async () => {
  // client.sendMessage() resolving only means WhatsApp Web accepted the call
  // locally - assuming that means "delivered" is exactly what let a message
  // to an unreachable number look identical to a real send.
  const id = await createDraft();
  await db.claimMessageForSend(id);
  await db.markSent(id, 'wamid.unconfirmed-test');
  const row = await db.getMessage(id);
  assert.equal(row.status, 'sent');
  assert.equal(row.delivery_status, null);

  await db.setDeliveryStatusByWaId('wamid.unconfirmed-test', 'sent');
  assert.equal((await db.getMessage(id)).delivery_status, 'sent');
});
