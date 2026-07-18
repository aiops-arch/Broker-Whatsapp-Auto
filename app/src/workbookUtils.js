const fs = require('node:fs');
const { MAX_WORKBOOK_BYTES, importError } = require('./importFiles');

// Shared, side-effect-free helpers for reading/validating .xlsx files and
// worksheet cell values. Split out from excelParser.js so both excelParser.js
// (full workbook parsing) and messageConfig.js (header detection for the
// setup wizard) can depend on this without creating a circular require
// between the two, since excelParser.js also depends on messageConfig.js for
// the configured field mapping and message template.

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

function formatCts(v) {
  const text = cellText(v);
  if (!text) return '';
  const n = Number(text);
  return Number.isFinite(n) ? n.toFixed(2) : text;
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

module.exports = {
  normalizeHeader,
  cellText,
  formatCts,
  workbookError,
  assertRealXlsxFile,
};
