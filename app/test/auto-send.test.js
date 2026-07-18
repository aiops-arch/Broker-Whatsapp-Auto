const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-auto-send-test-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');
const messageConfig = require('../src/messageConfig');
const { maybeAutoSend } = require('../src/watcher');

test.before(async () => {
  await db.init();
});

test.after(() => {
  db.db.close();
  fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  delete process.env.BROKER_APP_DATA_DIR;
});

let nextKey = 1;
async function createDraft(overrides = {}) {
  const key = nextKey++;
  return db.insertMessage({
    dedupKey: `auto-send-${key}`,
    demandDate: '2026-07-17',
    brokerName: `Broker ${key}`,
    partyName: `Party ${key}`,
    // A phone number distinct from other test files' defaults (e.g.
    // send-safety.test.js) - under the release build's
    // --test-isolation=none, all test files share one process/database, so
    // an identical phone+party combination across files would trip the new
    // cross-import duplicate-content flag against an unrelated file's rows.
    phone: '9711100000',
    message: `Message ${key}`,
    stoneCount: 1,
    sourceFile: 'test.xlsx',
    ...overrides,
  });
}

test('auto-send is off by default and never sends anything', async () => {
  const id = await createDraft();
  let sendCount = 0;
  await maybeAutoSend([id], { isReady: () => true, sendMessage: async () => { sendCount += 1; return 'wamid.x'; } });
  assert.equal(sendCount, 0);
  assert.equal((await db.getMessage(id)).status, 'draft');
});

test('when enabled, a complete non-flagged just-imported row sends automatically and is tagged auto_sent', async () => {
  await messageConfig.setAutoSendEnabled(true);
  try {
    const id = await createDraft({ partyName: 'Auto Party' });
    let sendCount = 0;
    await maybeAutoSend([id], { isReady: () => true, sendMessage: async () => { sendCount += 1; return 'wamid.auto'; } });
    assert.equal(sendCount, 1);
    const row = await db.getMessage(id);
    assert.equal(row.status, 'sent');
    assert.equal(row.auto_sent, 1);
  } finally {
    await messageConfig.setAutoSendEnabled(false);
  }
});

test('when enabled, a needs_info row (missing broker) is never auto-sent', async () => {
  await messageConfig.setAutoSendEnabled(true);
  try {
    const id = await createDraft({ brokerName: '(unassigned)', partyName: 'Needs Info Party' });
    assert.equal((await db.getMessage(id)).status, 'needs_info');
    let sendCount = 0;
    await maybeAutoSend([id], { isReady: () => true, sendMessage: async () => { sendCount += 1; return 'wamid.x'; } });
    assert.equal(sendCount, 0);
    assert.equal((await db.getMessage(id)).status, 'needs_info');
  } finally {
    await messageConfig.setAutoSendEnabled(false);
  }
});

test('when enabled, a duplicate-flagged row is never auto-sent, even though it is otherwise complete', async () => {
  await messageConfig.setAutoSendEnabled(true);
  try {
    const firstId = await createDraft({ partyName: 'Dup Auto Party', dedupComponentSignature: 'stone-auto' });
    const secondId = await createDraft({ partyName: 'Dup Auto Party', dedupComponentSignature: 'stone-auto' });
    assert.equal((await db.getMessage(secondId)).duplicate_of_id, firstId);

    let sendCount = 0;
    await maybeAutoSend([firstId, secondId], {
      isReady: () => true,
      sendMessage: async () => { sendCount += 1; return 'wamid.dup-auto'; },
    });
    // Only the first (non-flagged) row auto-sends; the flagged one is left untouched.
    assert.equal(sendCount, 1);
    assert.equal((await db.getMessage(firstId)).status, 'sent');
    assert.equal((await db.getMessage(secondId)).status, 'draft');
  } finally {
    await messageConfig.setAutoSendEnabled(false);
  }
});

test('turning auto-send on never sweeps up older drafts already sitting in the queue', async () => {
  const preExistingId = await createDraft({ partyName: 'Pre-existing Party' });
  await messageConfig.setAutoSendEnabled(true);
  try {
    // Simulate a brand-new import that has nothing to do with the older draft.
    const newId = await createDraft({ partyName: 'New Import Party' });
    let sendCount = 0;
    // maybeAutoSend is only ever called with the ids from the just-completed
    // import - the pre-existing draft's id is never passed in.
    await maybeAutoSend([newId], { isReady: () => true, sendMessage: async () => { sendCount += 1; return 'wamid.scoped'; } });
    assert.equal(sendCount, 1);
    assert.equal((await db.getMessage(newId)).status, 'sent');
    assert.equal((await db.getMessage(preExistingId)).status, 'draft');
  } finally {
    await messageConfig.setAutoSendEnabled(false);
  }
});

test('auto-send never sends when WhatsApp is not ready, and does not throw', async () => {
  await messageConfig.setAutoSendEnabled(true);
  try {
    const id = await createDraft({ partyName: 'Not Ready Party' });
    let sendCount = 0;
    await assert.doesNotReject(maybeAutoSend([id], {
      isReady: () => false,
      getStatus: () => ({ label: 'WhatsApp' }),
      sendMessage: async () => { sendCount += 1; },
    }));
    assert.equal(sendCount, 0);
    assert.equal((await db.getMessage(id)).status, 'draft');
  } finally {
    await messageConfig.setAutoSendEnabled(false);
  }
});
