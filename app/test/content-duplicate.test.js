const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-content-duplicate-test-'));
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
    dedupKey: `content-dup-${key}`,
    demandDate: '2026-07-17',
    brokerName: 'Broker X',
    partyName: 'Acme Gems',
    // A phone number distinct from other test files' defaults (e.g.
    // send-safety.test.js, auto-send.test.js) - under the release build's
    // --test-isolation=none, all test files share one process/database, so
    // an identical phone+party combination across files would trip this
    // file's own duplicate-content checks against an unrelated file's rows.
    phone: '9722200000',
    message: `Message ${key}`,
    stoneCount: 1,
    sourceFile: 'test.xlsx',
    dedupComponentSignature: 'stone-1',
    ...overrides,
  };
}

test('a second import with the same phone+party+stones is flagged against the first, even with a different dedupKey/date/wording', async () => {
  const firstId = await db.insertMessage(baseRow({ message: 'Original wording' }));
  const secondId = await db.insertMessage(baseRow({
    demandDate: '2026-08-01',
    message: 'Completely different wording, same actual demand',
  }));

  const first = await db.getMessage(firstId);
  const second = await db.getMessage(secondId);
  assert.equal(first.duplicate_of_id, null);
  assert.equal(second.duplicate_of_id, firstId);
  assert.ok(first.content_signature);
  assert.equal(first.content_signature, second.content_signature);
});

test('a different party or different stones does not get flagged', async () => {
  const firstId = await db.insertMessage(baseRow({ partyName: 'Party One' }));
  const differentParty = await db.insertMessage(baseRow({ partyName: 'Party Two' }));
  const differentStones = await db.insertMessage(baseRow({ partyName: 'Party One', dedupComponentSignature: 'stone-2' }));

  assert.equal((await db.getMessage(differentParty)).duplicate_of_id, null);
  assert.equal((await db.getMessage(differentStones)).duplicate_of_id, null);
  void firstId;
});

test('a phone punctuation/spacing difference does not defeat the match (digits-only comparison)', async () => {
  const firstId = await db.insertMessage(baseRow({ phone: '98765 43210', partyName: 'Format Party' }));
  const secondId = await db.insertMessage(baseRow({ phone: '(98765)-43210', partyName: 'Format Party' }));
  assert.equal((await db.getMessage(secondId)).duplicate_of_id, firstId);
});

test('a failed row never counts as a duplicate source', async () => {
  const firstId = await db.insertMessage(baseRow({ partyName: 'Failed Source Party' }));
  await db.claimMessageForSend(firstId);
  await db.markFailed(firstId, 'simulated failure');
  assert.equal((await db.getMessage(firstId)).status, 'failed');

  const secondId = await db.insertMessage(baseRow({ partyName: 'Failed Source Party' }));
  assert.equal((await db.getMessage(secondId)).duplicate_of_id, null);
});

test('needs_info, draft, and sent rows all count as duplicate sources', async () => {
  // needs_info due to a missing/unassigned broker, but a real phone still on
  // the row (e.g. it came from the sheet) - a signature is still stored,
  // since the check is about the phone number, not the send-readiness status.
  const needsInfoId = await db.insertMessage(baseRow({ partyName: 'Coverage Party NI', brokerName: '(unassigned)' }));
  assert.equal((await db.getMessage(needsInfoId)).status, 'needs_info');
  const afterNeedsInfoId = await db.insertMessage(baseRow({ partyName: 'Coverage Party NI' }));
  assert.equal((await db.getMessage(afterNeedsInfoId)).duplicate_of_id, needsInfoId);

  const draftId = await db.insertMessage(baseRow({ partyName: 'Coverage Party A' }));
  const secondDraftId = await db.insertMessage(baseRow({ partyName: 'Coverage Party A' }));
  assert.equal((await db.getMessage(secondDraftId)).duplicate_of_id, draftId);

  const sentId = await db.insertMessage(baseRow({ partyName: 'Coverage Party B' }));
  await db.claimMessageForSend(sentId);
  await db.markSent(sentId, 'wamid.coverage');
  const afterSentId = await db.insertMessage(baseRow({ partyName: 'Coverage Party B' }));
  assert.equal((await db.getMessage(afterSentId)).duplicate_of_id, sentId);
});

test('a row without a resolved phone never computes or matches a signature', async () => {
  const id = await db.insertMessage(baseRow({ partyName: 'No Phone Party', phone: null }));
  const row = await db.getMessage(id);
  assert.equal(row.content_signature, null);
  assert.equal(row.duplicate_of_id, null);

  const secondId = await db.insertMessage(baseRow({ partyName: 'No Phone Party', phone: null }));
  assert.equal((await db.getMessage(secondId)).duplicate_of_id, null);
});

test('an exact re-import (same dedupKey) is rejected with DUPLICATE_DEDUP_KEY instead of a generic error', async () => {
  const row = baseRow({ partyName: 'Exact Reimport Party', dedupKey: 'exact-reimport-key' });
  await db.insertMessage(row);
  await assert.rejects(
    db.insertMessage({ ...row, message: 'Same dedup key, inserted again' }),
    (error) => error.code === 'DUPLICATE_DEDUP_KEY',
  );
});
