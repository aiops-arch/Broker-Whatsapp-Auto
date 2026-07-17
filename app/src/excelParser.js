const crypto = require('node:crypto');
const fs = require('node:fs');
const ExcelJS = require('exceljs');
const { MAX_WORKBOOK_BYTES, importError } = require('./importFiles');

const HEADER_MAP = {
  'invoice no.': 'invoiceNo',
  'demand date': 'demandDate',
  'party name': 'partyName',
  'stoneid': 'stoneId',
  'reportno.': 'reportNo',
  'color': 'color',
  'clarity': 'clarity',
  'cts': 'cts',
  'broker name': 'brokerName',
  'broker contact number': 'brokerPhone',
  'buyer name': 'buyerName',
  'attachment': 'attachmentFile',
};

const REQUIRED_HEADERS = Object.freeze({
  invoiceNo: 'Invoice No.',
  demandDate: 'Demand Date',
  partyName: 'Party Name',
  stoneId: 'StoneId',
  reportNo: 'ReportNo.',
  color: 'Color',
  clarity: 'Clarity',
  cts: 'CTS',
  brokerName: 'Broker Name',
  brokerPhone: 'Broker Contact Number',
});

// A row without these values cannot be grouped or identified reliably. Broker
// details may remain blank because the dashboard deliberately supports fixing
// them before sending.
const REQUIRED_ROW_FIELDS = Object.freeze({
  demandDate: 'Demand Date',
  partyName: 'Party Name',
  stoneId: 'StoneId',
});

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

function cellText(cell) {
  if (cell == null) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'object') {
    if (cell.result != null) return cellText(cell.result);
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text || '').join('').trim();
    if (cell.text != null) return String(cell.text).trim();
  }
  return String(cell).trim();
}

function formatDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return cellText(v);
}

function formatCts(v) {
  const text = cellText(v);
  if (!text) return '';
  const n = Number(text);
  return Number.isFinite(n) ? n.toFixed(2) : cellText(v);
}

function workbookError(code, message, technicalDetail) {
  const error = importError(code, message, 422);
  error.operatorMessage = message;
  if (technicalDetail) error.technicalDetail = String(technicalDetail);
  return error;
}

function assertRealXlsxFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw workbookError('WORKBOOK_NOT_FOUND', 'The workbook file could not be found.', error.message);
  }
  if (!stat.isFile()) {
    throw workbookError('WORKBOOK_NOT_FILE', 'The selected workbook is not a regular file.');
  }
  if (stat.size === 0) {
    throw workbookError('EMPTY_WORKBOOK_FILE', 'The workbook is empty. Choose a populated .xlsx file.');
  }
  if (stat.size > MAX_WORKBOOK_BYTES) {
    throw workbookError('WORKBOOK_TOO_LARGE', `The workbook is larger than ${Math.round(MAX_WORKBOOK_BYTES / (1024 * 1024))} MB.`);
  }

  const signature = Buffer.alloc(4);
  const handle = fs.openSync(filePath, 'r');
  try {
    fs.readSync(handle, signature, 0, signature.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  const isZip = signature[0] === 0x50 && signature[1] === 0x4b && (
    (signature[2] === 0x03 && signature[3] === 0x04)
    || (signature[2] === 0x05 && signature[3] === 0x06)
    || (signature[2] === 0x07 && signature[3] === 0x08)
  );
  if (!isZip) {
    throw workbookError(
      'NOT_AN_XLSX_WORKBOOK',
      'This is not a real .xlsx workbook. Open legacy .xls files in Excel and save them as .xlsx first.',
    );
  }
}

// Reads the dropped workbook and groups rows into one message per
// (Broker Name, Party Name, Demand Date) group, matching the required template.
async function parseWorkbook(filePath) {
  assertRealXlsxFile(filePath);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(filePath);
  } catch (error) {
    throw workbookError(
      'MALFORMED_XLSX_WORKBOOK',
      'The .xlsx workbook is damaged or cannot be read. Re-save it from Excel and try again.',
      error.message,
    );
  }
  if (wb.worksheets.length === 0) {
    throw workbookError('WORKBOOK_HAS_NO_SHEETS', 'The workbook does not contain a worksheet.');
  }
  const ws = wb.worksheets[0];

  const headerRow = ws.getRow(1);
  const colIndexToField = {};
  const foundFields = new Set();
  const duplicateFields = new Set();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = normalizeHeader(cellText(cell.value));
    const field = HEADER_MAP[key];
    if (!field) return;
    if (foundFields.has(field)) duplicateFields.add(field);
    foundFields.add(field);
    colIndexToField[colNumber] = field;
  });

  if (duplicateFields.size > 0) {
    const labels = [...duplicateFields].map((field) => REQUIRED_HEADERS[field] || field);
    throw workbookError('DUPLICATE_WORKBOOK_HEADERS', `The header row contains duplicate columns: ${labels.join(', ')}.`);
  }

  const missingHeaders = Object.entries(REQUIRED_HEADERS)
    .filter(([field]) => !foundFields.has(field))
    .map(([, label]) => label);
  if (missingHeaders.length > 0) {
    throw workbookError('MISSING_REQUIRED_HEADERS', `Required columns are missing: ${missingHeaders.join(', ')}.`);
  }

  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (row.cellCount === 0) continue;
    const rec = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const field = colIndexToField[colNumber];
      if (field) rec[field] = cell.value;
    });
    const hasMappedContent = Object.values(rec).some((value) => cellText(value) !== '');
    if (!hasMappedContent) continue;

    const missingValues = Object.entries(REQUIRED_ROW_FIELDS)
      .filter(([field]) => cellText(rec[field]) === '')
      .map(([, label]) => label);
    if (missingValues.length > 0) {
      throw workbookError('MALFORMED_DATA_ROW', `Row ${r} is missing required values: ${missingValues.join(', ')}.`);
    }

    const partyName = cellText(rec.partyName);

    rows.push({
      invoiceNo: cellText(rec.invoiceNo),
      demandDate: formatDate(rec.demandDate),
      partyName,
      stoneId: cellText(rec.stoneId),
      reportNo: cellText(rec.reportNo),
      color: cellText(rec.color),
      clarity: cellText(rec.clarity),
      cts: formatCts(rec.cts),
      brokerName: cellText(rec.brokerName),
      brokerPhone: cellText(rec.brokerPhone),
      buyerName: cellText(rec.buyerName),
      attachmentFile: cellText(rec.attachmentFile),
    });
  }

  if (rows.length === 0) {
    throw workbookError('NO_DATA_ROWS', 'The workbook has the correct headers but contains no demand rows.');
  }

  // Group by broker + party + demand date
  const groups = new Map();
  for (const row of rows) {
    const brokerNameRaw = row.brokerName;
    const groupKey = `${brokerNameRaw}||${row.partyName}||${row.demandDate}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        brokerName: brokerNameRaw,
        partyName: row.partyName,
        demandDate: row.demandDate,
        phoneFromSheet: row.brokerPhone || null,
        buyerName: null,
        attachmentFile: null,
        stones: [],
      });
    }
    const group = groups.get(groupKey);
    if (!group.attachmentFile && row.attachmentFile) group.attachmentFile = row.attachmentFile;
    if (!group.buyerName && row.buyerName) group.buyerName = row.buyerName;
    group.stones.push(row);
  }

  const results = [];
  for (const g of groups.values()) {
    const brokerName = g.brokerName.trim();
    const stoneLines = g.stones
      .map((s, i) => `${i + 1}) StoneId: ${s.stoneId} | Report#: ${s.reportNo} | Color: ${s.color} | Clarity: ${s.clarity} | Cts: ${s.cts}`)
      .join('\n');

    const dedupSource = [brokerName, g.partyName, g.demandDate, g.stones.map((s) => s.stoneId).sort().join(',')].join('|');
    const dedupKey = crypto.createHash('sha256').update(dedupSource).digest('hex');

    const buyerLine = g.buyerName ? `\nBuyer Name: ${g.buyerName}` : '';
    const message = brokerName
      ? `Dear ${brokerName},\n\nPlease find today's demand:\n\nParty Name: ${g.partyName}${buyerLine}\n${stoneLines}\n\nRegards,\nPrashant Sanghavi`
      : '';

    results.push({
      brokerName,
      partyName: g.partyName,
      demandDate: g.demandDate,
      phoneFromSheet: g.phoneFromSheet,
      buyerName: g.buyerName || null,
      attachmentFile: g.attachmentFile,
      stoneCount: g.stones.length,
      message,
      dedupKey,
    });
  }

  return results;
}

module.exports = { parseWorkbook };
