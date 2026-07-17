const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_WORKBOOK_BYTES,
  UPLOAD_LIMITS,
  importError,
  moveFileExclusive,
  quarantineFile,
  safeImportFileName,
  validateUploadFileName,
} = require('../src/importFiles');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-import-files-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('upload policy accepts only xlsx and enforces one bounded file', () => {
  assert.equal(validateUploadFileName('demand.xlsx').ok, true);
  assert.equal(validateUploadFileName('DEMAND.XLSX').ok, true);
  assert.equal(validateUploadFileName('legacy.xls').error.code, 'INVALID_WORKBOOK_EXTENSION');
  assert.equal(validateUploadFileName('notes.txt').ok, false);
  assert.equal(UPLOAD_LIMITS.files, 1);
  assert.equal(UPLOAD_LIMITS.fields, 0);
  assert.equal(UPLOAD_LIMITS.parts, 2);
  assert.equal(UPLOAD_LIMITS.fileSize, MAX_WORKBOOK_BYTES);
});

test('untrusted upload names cannot retain a path or Windows device name', () => {
  const traversal = safeImportFileName('../../outside<>name.xlsx', { forceXlsx: true });
  assert.equal(traversal, 'outside__name.xlsx');
  assert.equal(path.basename(traversal), traversal);
  assert.equal(safeImportFileName('CON.xlsx', { forceXlsx: true }), '_CON.xlsx');
});

test('collision-safe moves preserve existing files and choose a suffix', (t) => {
  const root = tempDirectory(t);
  const source = path.join(root, 'staged');
  const destination = path.join(root, 'incoming');
  fs.mkdirSync(destination);
  fs.writeFileSync(source, 'new workbook');
  fs.writeFileSync(path.join(destination, 'demand.xlsx'), 'existing workbook');

  const moved = moveFileExclusive(source, destination, 'demand.xlsx');
  assert.equal(path.basename(moved), 'demand (2).xlsx');
  assert.equal(fs.readFileSync(path.join(destination, 'demand.xlsx'), 'utf8'), 'existing workbook');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'new workbook');
  assert.equal(fs.existsSync(source), false);
});

test('failed imports are retained with a readable error sidecar', (t) => {
  const root = tempDirectory(t);
  const source = path.join(root, 'upload-temp');
  const failedDirectory = path.join(root, 'failed-imports');
  fs.writeFileSync(source, 'bad workbook');
  const error = importError('MISSING_REQUIRED_HEADERS', 'Required columns are missing: Demand Date.');

  const result = quarantineFile(source, failedDirectory, '..\\unsafe-name.xlsx', error);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(result.quarantinedPath), true);
  assert.equal(path.dirname(result.quarantinedPath), failedDirectory);
  const report = fs.readFileSync(result.sidecarPath, 'utf8');
  assert.match(report, /MISSING_REQUIRED_HEADERS/);
  assert.match(report, /Required columns are missing: Demand Date/);
  assert.match(report, /No messages were sent automatically/);
});
