const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-send-db-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');
const { sendMessagesByIds } = require('../src/watcher');

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
