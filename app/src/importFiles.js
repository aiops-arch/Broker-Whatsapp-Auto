const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;
const MAX_WORKBOOK_BYTES = 10 * MIB;
const UPLOAD_LIMITS = Object.freeze({
  fileSize: MAX_WORKBOOK_BYTES,
  files: 1,
  fields: 0,
  // Busboy emits partsLimit when the count becomes equal to the limit. A
  // limit of 1 therefore rejects the first (and only) file part. Setting 2
  // accepts exactly one file while a second file/field still trips the bound.
  parts: 2,
  fieldNameSize: 32,
  headerPairs: 20,
});

function importError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isXlsxName(fileName) {
  return path.extname(String(fileName || '')).toLowerCase() === '.xlsx';
}

// Upload names are untrusted HTTP metadata. Keep a readable basename while
// removing path components, control characters, Windows-reserved characters,
// trailing dots/spaces, and device names. Every accepted upload is forced to
// the only workbook format this application actually parses: .xlsx.
function safeImportFileName(rawName, { forceXlsx = false } = {}) {
  const raw = String(rawName || '').normalize('NFKC');
  const basename = path.win32.basename(path.posix.basename(raw));
  const suppliedExtension = path.extname(basename).toLowerCase();
  const extension = forceXlsx ? '.xlsx' : suppliedExtension;
  let stem = basename.slice(0, basename.length - suppliedExtension.length);

  stem = stem
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!stem) stem = 'workbook';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;

  // Stay comfortably below Windows' component limit after adding timestamps,
  // collision suffixes, and an error-sidecar extension.
  stem = stem.slice(0, 120).replace(/[. ]+$/g, '') || 'workbook';
  return `${stem}${extension || ''}`;
}

function validateUploadFileName(fileName) {
  if (!isXlsxName(fileName)) {
    return {
      ok: false,
      error: importError(
        'INVALID_WORKBOOK_EXTENSION',
        'Only Excel .xlsx workbooks are accepted. Open legacy .xls files in Excel and save them as .xlsx first.',
        415,
      ),
    };
  }
  return { ok: true, safeName: safeImportFileName(fileName, { forceXlsx: true }) };
}

function suffixName(fileName, attempt) {
  if (attempt === 1) return fileName;
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  return `${stem} (${attempt})${extension}`;
}

// COPYFILE_EXCL gives collision protection on both Windows and POSIX. A plain
// rename can overwrite an existing file on POSIX, so it is not safe here.
function moveFileExclusive(sourcePath, destinationDirectory, desiredName) {
  fs.mkdirSync(destinationDirectory, { recursive: true });
  const safeName = safeImportFileName(desiredName);
  let lastCollision = null;

  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const targetPath = path.join(destinationDirectory, suffixName(safeName, attempt));
    try {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      try {
        fs.unlinkSync(sourcePath);
      } catch (unlinkError) {
        try { fs.unlinkSync(targetPath); } catch (_) { /* preserve the original error */ }
        throw unlinkError;
      }
      return targetPath;
    } catch (error) {
      if (error.code === 'EEXIST') {
        lastCollision = error;
        continue;
      }
      throw error;
    }
  }

  const error = new Error(`Could not reserve a unique filename for ${safeName}.`);
  error.code = 'IMPORT_NAME_COLLISION';
  error.cause = lastCollision;
  throw error;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function uniqueImportName(originalName, date = new Date()) {
  const safeName = safeImportFileName(originalName);
  const nonce = crypto.randomBytes(4).toString('hex');
  return `${timestampForFile(date)}_${nonce}_${safeName}`;
}

function operatorMessage(error) {
  return String(error?.operatorMessage || error?.message || 'The workbook could not be processed.');
}

function quarantineFile(sourcePath, failedDirectory, originalName, error) {
  const quarantinedName = uniqueImportName(originalName || path.basename(sourcePath));
  const quarantinedPath = moveFileExclusive(sourcePath, failedDirectory, quarantinedName);
  const sidecarPath = `${quarantinedPath}.error.txt`;
  const detail = error?.technicalDetail && error.technicalDetail !== operatorMessage(error)
    ? `\nTechnical detail: ${error.technicalDetail}`
    : '';
  const report = [
    'Broker Demand Desk - failed workbook import',
    `Time: ${new Date().toISOString()}`,
    `Original file: ${safeImportFileName(originalName || path.basename(sourcePath))}`,
    `Failure code: ${error?.code || 'IMPORT_FAILED'}`,
    `Reason: ${operatorMessage(error)}${detail}`,
    '',
    'No messages were sent automatically. Correct the workbook, save it as .xlsx, and import it again.',
    '',
  ].join('\n');
  fs.writeFileSync(sidecarPath, report, { encoding: 'utf8', flag: 'wx' });
  return { quarantinedPath, sidecarPath, message: operatorMessage(error) };
}

module.exports = {
  MAX_WORKBOOK_BYTES,
  UPLOAD_LIMITS,
  importError,
  isXlsxName,
  safeImportFileName,
  validateUploadFileName,
  moveFileExclusive,
  uniqueImportName,
  quarantineFile,
  operatorMessage,
};
