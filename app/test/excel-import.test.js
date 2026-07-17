const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { parseWorkbook } = require('../src/excelParser');

const HEADERS = [
  'Invoice No.',
  'Demand Date',
  'Party Name',
  'StoneId',
  'ReportNo.',
  'Color',
  'Clarity',
  'CTS',
  'Broker Name',
  'Broker Contact Number',
  'Buyer Name',
  'Attachment',
];

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

test('a real workbook with the required schema produces demand groups', async (t) => {
  const filePath = path.join(tempDirectory(t), 'valid.xlsx');
  await writeWorkbook(filePath, HEADERS, [[
    'INV-1', new Date('2026-07-17T00:00:00Z'), 'Example Party', 'S-1', 'R-1',
    'D', 'VS1', 1.2, 'Example Broker', '919876543210', 'Buyer', '',
  ]]);

  const groups = await parseWorkbook(filePath);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].partyName, 'Example Party');
  assert.equal(groups[0].stoneCount, 1);
  assert.match(groups[0].message, /Cts: 1\.20/);
});

test('missing required headers are rejected with the exact missing columns', async (t) => {
  const filePath = path.join(tempDirectory(t), 'missing-header.xlsx');
  const headers = HEADERS.filter((header) => header !== 'Broker Contact Number');
  await writeWorkbook(filePath, headers, []);

  await assert.rejects(
    parseWorkbook(filePath),
    (error) => error.code === 'MISSING_REQUIRED_HEADERS'
      && /Broker Contact Number/.test(error.message),
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
      && /Party Name/.test(error.message),
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
