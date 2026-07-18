const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-archive-test-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');

test.before(async () => {
  await db.init();
});

test.after(() => {
  db.db.close();
  fs.rmSync(isolatedDataDir, { recursive: true, force: true });
  delete process.env.BROKER_APP_DATA_DIR;
});

let nextKey = 1;
function baseRow(overrides) {
  const key = nextKey++;
  return {
    dedupKey: `archive-test-${key}`,
    demandDate: '2026-07-17',
    brokerName: 'Broker X',
    partyName: 'Acme Gems',
    // A phone number distinct from other test files' defaults, so a shared
    // process/database under --test-isolation=none never cross-flags this
    // file's rows as content duplicates of an unrelated file's rows.
    phone: '9733300000',
    message: `Message ${key}`,
    stoneCount: 1,
    sourceFile: 'test.xlsx',
    dedupComponentSignature: `stone-${key}`,
    ...overrides,
  };
}

test('archiveAllExceptIds archives every other not-yet-archived row, regardless of status', async () => {
  const draftId = await db.insertMessage(baseRow({ partyName: 'Old Draft' }));
  const needsInfoId = await db.insertMessage(baseRow({ partyName: 'Old Needs Info', brokerName: '(unassigned)' }));
  const failedId = await db.insertMessage(baseRow({ partyName: 'Old Failed' }));
  await db.claimMessageForSend(failedId);
  await db.markFailed(failedId, 'simulated failure');
  const keepId = await db.insertMessage(baseRow({ partyName: 'Latest Import Row' }));

  const archivedCount = await db.archiveAllExceptIds([keepId]);
  assert.equal(archivedCount, 3);

  assert.ok((await db.getMessage(draftId)).archived_at);
  assert.ok((await db.getMessage(needsInfoId)).archived_at);
  assert.ok((await db.getMessage(failedId)).archived_at);
  assert.equal((await db.getMessage(keepId)).archived_at, null);
});

test('archiveAllExceptIds never re-archives (and never touches the timestamp of) an already-archived row', async () => {
  const id = await db.insertMessage(baseRow({ partyName: 'Already Archived' }));
  const keepId = await db.insertMessage(baseRow({ partyName: 'First Sweep Survivor' }));
  await db.archiveAllExceptIds([keepId]);
  const firstArchivedAt = (await db.getMessage(id)).archived_at;
  assert.ok(firstArchivedAt);

  const anotherKeepId = await db.insertMessage(baseRow({ partyName: 'Second Sweep Survivor' }));
  await db.archiveAllExceptIds([anotherKeepId]);
  assert.equal((await db.getMessage(id)).archived_at, firstArchivedAt);
});

test('archiveAllExceptIds with an empty id list is a no-op (never blanks the main list)', async () => {
  const id = await db.insertMessage(baseRow({ partyName: 'Untouched By Empty Sweep' }));
  const archivedCount = await db.archiveAllExceptIds([]);
  assert.equal(archivedCount, 0);
  assert.equal((await db.getMessage(id)).archived_at, null);
});

test('markSent archives the row at the moment it is sent', async () => {
  const id = await db.insertMessage(baseRow({ partyName: 'Sent Row' }));
  assert.equal((await db.getMessage(id)).archived_at, null);
  await db.claimMessageForSend(id);
  await db.markSent(id, 'wamid.archive-test');
  const row = await db.getMessage(id);
  assert.equal(row.status, 'sent');
  assert.ok(row.archived_at);
});

test('reconcileUncertainMessage("sent") archives the row, preserving an earlier archive timestamp if already swept', async () => {
  const swept = await db.insertMessage(baseRow({ partyName: 'Reconciled After Sweep' }));
  const keepId = await db.insertMessage(baseRow({ partyName: 'Sweep Survivor' }));
  await db.claimMessageForSend(swept);
  await db.archiveAllExceptIds([keepId]); // sweeps `swept` while it's mid-send
  const archivedAtFromSweep = (await db.getMessage(swept)).archived_at;
  assert.ok(archivedAtFromSweep);

  // Simulate the process dying mid-send, then the operator reconciling it.
  await db.markSendUncertain(swept, 'simulated interruption');
  await db.reconcileUncertainMessage(swept, 'sent');
  const row = await db.getMessage(swept);
  assert.equal(row.status, 'sent');
  assert.equal(row.archived_at, archivedAtFromSweep);
});

test('listMessages({archived}) filters correctly in all three modes', async () => {
  const archivedId = await db.insertMessage(baseRow({ partyName: 'Filter Archived' }));
  const activeId = await db.insertMessage(baseRow({ partyName: 'Filter Active' }));
  await db.archiveAllExceptIds([activeId]);

  const onlyArchived = await db.listMessages({ archived: true });
  assert.ok(onlyArchived.some((r) => r.id === archivedId));
  assert.ok(!onlyArchived.some((r) => r.id === activeId));

  const onlyActive = await db.listMessages({ archived: false });
  assert.ok(onlyActive.some((r) => r.id === activeId));
  assert.ok(!onlyActive.some((r) => r.id === archivedId));

  const everything = await db.listMessages({});
  assert.ok(everything.some((r) => r.id === archivedId));
  assert.ok(everything.some((r) => r.id === activeId));
});

test('listMessages({status, archived}) combines both filters', async () => {
  const archivedFailedId = await db.insertMessage(baseRow({ partyName: 'Combo Archived Failed' }));
  await db.claimMessageForSend(archivedFailedId);
  await db.markFailed(archivedFailedId, 'simulated failure');
  const keepId = await db.insertMessage(baseRow({ partyName: 'Combo Sweep Survivor' }));
  await db.archiveAllExceptIds([keepId]);

  const archivedFailed = await db.listMessages({ status: 'failed', archived: true });
  assert.ok(archivedFailed.some((r) => r.id === archivedFailedId));

  const activeFailed = await db.listMessages({ status: 'failed', archived: false });
  assert.ok(!activeFailed.some((r) => r.id === archivedFailedId));
});
