const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

// excelParser.js now reads its column mapping and message template from
// messageConfig.js (backed by the app_settings SQLite table), so this test
// file needs its own isolated data directory - set before requiring
// anything that transitively requires db.js.
const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-import-test-db-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');
const messageConfig = require('../src/messageConfig');
const { parseWorkbook } = require('../src/excelParser');

const DEFAULT_FIELDS = messageConfig.getDefaultFieldMapping();
const HEADERS = DEFAULT_FIELDS.map((f) => f.sourceHeader);
const brokerPhoneLabel = DEFAULT_FIELDS.find((f) => f.role === 'broker_phone').label;
const primaryGroupLabel = DEFAULT_FIELDS.find((f) => f.primaryGroupField).label;

test.before(async () => {
  await db.init();
});

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-import-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function writeWorkbook(filePath, headers = HEADERS, rows = []) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Demand');
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
}

test('the default column mapping and message template render the expected message byte-for-byte', async (t) => {
  const filePath = path.join(tempDirectory(t), 'valid.xlsx');
  await writeWorkbook(filePath, HEADERS, [[
    'INV-1', new Date('2026-07-17T00:00:00Z'), 'Example Party', 'S-1', 'R-1',
    'D', 'VS1', 1.2, 'Example Broker', '919876543210', 'Buyer', '',
  ]]);

  const groups = await parseWorkbook(filePath);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].partyName, 'Example Party');
  assert.equal(groups[0].demandDate, '2026-07-17');
  assert.equal(groups[0].buyerName, 'Buyer');
  assert.equal(groups[0].stoneCount, 1);
  assert.equal(
    groups[0].message,
    "Dear Example Broker,\n\nPlease find today's demand:\n\nParty Name: Example Party\n1) StoneId: S-1 | Report#: R-1 | Color: D | Clarity: VS1 | Cts: 1.20\n\nRegards,\nBuyer",
  );
  assert.equal(groups[0].dedupComponentSignature, 'S-1');
});

test('dedupComponentSignature sorts multiple stone ids regardless of row order', async (t) => {
  const filePath = path.join(tempDirectory(t), 'multi-stone.xlsx');
  await writeWorkbook(filePath, HEADERS, [
    ['INV-1', '2026-07-17', 'Example Party', 'S-2', 'R-2', 'D', 'VS1', 1.0, 'Example Broker', '919876543210', '', ''],
    ['INV-1', '2026-07-17', 'Example Party', 'S-1', 'R-1', 'D', 'VS1', 1.2, 'Example Broker', '919876543210', '', ''],
  ]);

  const groups = await parseWorkbook(filePath);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stoneCount, 2);
  assert.equal(groups[0].dedupComponentSignature, 'S-1,S-2');
});

test('missing required headers are rejected with the exact missing columns', async (t) => {
  const filePath = path.join(tempDirectory(t), 'missing-header.xlsx');
  const headers = HEADERS.filter((header) => header !== brokerPhoneLabel);
  await writeWorkbook(filePath, headers, []);

  await assert.rejects(
    parseWorkbook(filePath),
    (error) => error.code === 'MISSING_REQUIRED_HEADERS'
      && new RegExp(brokerPhoneLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(error.message),
  );
});

test('header-only workbooks are rejected instead of being archived silently', async (t) => {
  const filePath = path.join(tempDirectory(t), 'header-only.xlsx');
  await writeWorkbook(filePath);

  await assert.rejects(parseWorkbook(filePath), (error) => error.code === 'NO_DATA_ROWS');
});

test('partially populated rows missing key business values are rejected', async (t) => {
  const filePath = path.join(tempDirectory(t), 'bad-row.xlsx');
  await writeWorkbook(filePath, HEADERS, [[
    'INV-1', '2026-07-17', '', 'S-1', 'R-1', 'D', 'VS1', 1.2, 'Broker', '919876543210', '', '',
  ]]);

  await assert.rejects(
    parseWorkbook(filePath),
    (error) => error.code === 'MALFORMED_DATA_ROW'
      && /Row 2/.test(error.message)
      && new RegExp(primaryGroupLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(error.message),
  );
});

test('a legacy or renamed non-ZIP file is not accepted as xlsx', async (t) => {
  const filePath = path.join(tempDirectory(t), 'renamed-legacy.xlsx');
  fs.writeFileSync(filePath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]));

  await assert.rejects(parseWorkbook(filePath), (error) => error.code === 'NOT_AN_XLSX_WORKBOOK');
});

test('a ZIP-looking but malformed workbook is rejected clearly', async (t) => {
  const filePath = path.join(tempDirectory(t), 'broken.xlsx');
  fs.writeFileSync(filePath, Buffer.from('PK\x03\x04not-an-office-workbook', 'binary'));

  await assert.rejects(parseWorkbook(filePath), (error) => error.code === 'MALFORMED_XLSX_WORKBOOK');
});

test('a custom column mapping and template are honored end-to-end', async (t) => {
  const customFields = [
    { key: 'agent', label: 'Agent', sourceHeader: 'Agent Name', role: 'broker_name', requiredHeader: true, requiredRow: false },
    { key: 'agentMobile', label: 'Mobile', sourceHeader: 'Mobile', role: 'broker_phone', requiredHeader: true, requiredRow: false },
    {
      key: 'client', label: 'Client', sourceHeader: 'Client', role: 'group',
      requiredHeader: true, requiredRow: true, primaryGroupField: true, dedupComponent: true,
    },
    {
      key: 'itemCode', label: 'Item Code', sourceHeader: 'Item Code', role: 'line',
      requiredHeader: true, requiredRow: true, dedupComponent: true,
    },
    { key: 'qty', label: 'Qty', sourceHeader: 'Qty', role: 'line', requiredHeader: true, requiredRow: false },
  ];
  await messageConfig.setFieldMapping(customFields);
  await messageConfig.setMessageTemplate({
    headerTemplate: 'Hi {{agent}}, order for {{client}}:\n{{lineItems}}',
    lineItemTemplate: '- {{itemCode}} x{{qty}}',
    buyerLineTemplate: '',
    lineItemSeparator: '\n',
  });
  t.after(async () => {
    await db.setSetting('field_mapping_config_v1', null);
    await db.setSetting('message_template_config_v1', null);
  });

  const filePath = path.join(tempDirectory(t), 'custom.xlsx');
  await writeWorkbook(filePath, ['Agent Name', 'Mobile', 'Client', 'Item Code', 'Qty'], [
    ['Rahul', '9998887771', 'Acme Co', 'IC-1', 5],
    ['Rahul', '9998887771', 'Acme Co', 'IC-2', 2],
  ]);

  const groups = await parseWorkbook(filePath);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stoneCount, 2);
  assert.equal(groups[0].message, 'Hi Rahul, order for Acme Co:\n- IC-1 x5\n- IC-2 x2');
});
