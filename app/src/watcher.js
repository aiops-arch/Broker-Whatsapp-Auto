const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');
const { parseWorkbook } = require('./excelParser');
const db = require('./db');
const bus = require('./events');
const { resolveAttachmentFile, validateStoredAttachmentPath } = require('./attachmentPolicy');
const { coordinateMessageSends } = require('./sendCoordinator');
const {
  importError,
  isXlsxName,
  moveFileExclusive,
  uniqueImportName,
  quarantineFile,
  operatorMessage,
  validateUploadFileName,
} = require('./importFiles');

const INCOMING_DIR = path.join(__dirname, '..', 'incoming');
const PROCESSED_DIR = path.join(__dirname, '..', 'processed');
const ATTACHMENTS_DIR = path.join(__dirname, '..', 'attachments');
const FAILED_IMPORTS_DIR = path.join(__dirname, '..', 'failed-imports');
const UPLOAD_STAGING_DIR = path.join(INCOMING_DIR, '.upload-staging');

function ensureImportDirectories() {
  for (const dir of [INCOMING_DIR, PROCESSED_DIR, ATTACHMENTS_DIR, FAILED_IMPORTS_DIR, UPLOAD_STAGING_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function recordWatcherError(error) {
  ensureImportDirectories();
  const line = `${new Date().toISOString()} ${error?.code || 'WATCHER_ERROR'}: ${operatorMessage(error)}\n`;
  try {
    fs.appendFileSync(path.join(FAILED_IMPORTS_DIR, 'watcher-errors.log'), line, 'utf8');
  } catch (logError) {
    console.error('[watcher] could not write the local watcher error log:', logError.message);
  }
}

function quarantineFailedImport(filePath, error, originalName = path.basename(filePath)) {
  ensureImportDirectories();
  const result = quarantineFile(filePath, FAILED_IMPORTS_DIR, originalName, error);
  console.error(`[watcher] quarantined ${path.basename(originalName)}: ${operatorMessage(error)}`);
  bus.emit('update');
  return result;
}

function queueUploadedWorkbook(stagedPath, originalName) {
  ensureImportDirectories();
  const validation = validateUploadFileName(originalName);
  if (!validation.ok) throw validation.error;
  return moveFileExclusive(stagedPath, INCOMING_DIR, uniqueImportName(validation.safeName));
}

// Drops from the Excel file only ever create drafts for review - nothing is
// sent automatically. Sending is always an explicit action from the dashboard.
async function ingestFile(filePath, whatsappService) {
  ensureImportDirectories();
  const fileName = path.basename(filePath);
  try {
    if (!isXlsxName(fileName)) {
      throw importError(
        'INVALID_WORKBOOK_EXTENSION',
        'Only Excel .xlsx workbooks are supported. Convert legacy .xls files to .xlsx before importing.',
        415,
      );
    }
    const groups = await parseWorkbook(filePath);

    for (const g of groups) {
      const existing = await db.findByDedupKey(g.dedupKey);
      if (existing) continue; // exact duplicate demand already logged

      let phone = g.phoneFromSheet || (g.brokerName ? await db.getBrokerPhone(g.brokerName) : null);
      if (g.brokerName && g.phoneFromSheet) {
        await db.upsertBroker(g.brokerName, g.phoneFromSheet);
      } else if (g.brokerName && !(await db.getBrokerPhone(g.brokerName))) {
        await db.upsertBroker(g.brokerName, null);
      }

      let attachmentPath = null;
      let attachmentError = null;
      if (g.attachmentFile) {
        const attachment = resolveAttachmentFile(g.attachmentFile, ATTACHMENTS_DIR);
        if (attachment.ok) attachmentPath = attachment.path;
        else attachmentError = attachment.error;
      }

      await db.insertMessage({
        dedupKey: g.dedupKey,
        demandDate: g.demandDate,
        brokerName: g.brokerName || '(unassigned)',
        partyName: g.partyName,
        buyerName: g.buyerName,
        phone,
        message: g.message || '(no message - broker name missing in source sheet)',
        stoneCount: g.stoneCount,
        attachmentPath,
        validationError: attachmentError,
        sourceFile: fileName,
      });
      bus.emit('update');
    }

    const processedPath = moveFileExclusive(filePath, PROCESSED_DIR, uniqueImportName(fileName));
    bus.emit('update');
    return { ok: true, groupCount: groups.length, processedPath };
  } catch (error) {
    console.error(`[watcher] failed to import ${fileName}:`, operatorMessage(error));
    if (!fs.existsSync(filePath)) {
      recordWatcherError(error);
      return { ok: false, error: operatorMessage(error), code: error.code || 'IMPORT_FAILED' };
    }
    try {
      const quarantine = quarantineFailedImport(filePath, error, fileName);
      return {
        ok: false,
        error: operatorMessage(error),
        code: error.code || 'IMPORT_FAILED',
        quarantinedPath: quarantine.quarantinedPath,
        sidecarPath: quarantine.sidecarPath,
      };
    } catch (quarantineError) {
      recordWatcherError(quarantineError);
      throw quarantineError;
    }
  }
}

// Sends a specific set of message rows (used by the per-row Send/Retry button
// and by bulk "Send selected"/"Send all drafts"), one at a time.
async function sendMessagesByIds(ids, whatsappService) {
  return coordinateMessageSends(ids, whatsappService, {
    store: db,
    notifyUpdate: () => bus.emit('update'),
    validateAttachment: (attachmentPath) => validateStoredAttachmentPath(attachmentPath, ATTACHMENTS_DIR),
  });
}

async function sendAllDrafts(whatsappService) {
  const drafts = await db.listMessages({ status: 'draft' });
  return sendMessagesByIds(drafts.map((r) => r.id), whatsappService);
}

function startWatcher(whatsappService) {
  ensureImportDirectories();

  const watcher = chokidar.watch(INCOMING_DIR, {
    ignoreInitial: false,
    ignored: (watchedPath) => path.resolve(watchedPath).startsWith(path.resolve(UPLOAD_STAGING_DIR)),
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    depth: 0,
  });

  watcher.on('add', (filePath) => {
    ingestFile(filePath, whatsappService).catch((err) => {
      console.error('[watcher] ingest error:', err.message);
      recordWatcherError(err);
    });
  });

  watcher.on('error', (error) => {
    console.error('[watcher] filesystem error:', error.message);
    recordWatcherError(error);
  });

  return watcher;
}

module.exports = {
  startWatcher,
  ingestFile,
  sendMessagesByIds,
  sendAllDrafts,
  INCOMING_DIR,
  PROCESSED_DIR,
  ATTACHMENTS_DIR,
  FAILED_IMPORTS_DIR,
  UPLOAD_STAGING_DIR,
  ensureImportDirectories,
  quarantineFailedImport,
  queueUploadedWorkbook,
  recordWatcherError,
};
