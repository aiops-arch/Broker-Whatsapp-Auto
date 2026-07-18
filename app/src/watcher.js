const fs = require('node:fs');
const path = require('node:path');
const chokidar = require('chokidar');
const { parseWorkbook } = require('./excelParser');
const db = require('./db');
const messageConfig = require('./messageConfig');
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

// Sends only the ids from the import that JUST completed (never a
// listMessages({status:'draft'}) query), so turning the toggle on can never
// retroactively vacuum up older drafts the operator intentionally left
// unsent. Reuses the exact same sendMessagesByIds path as bulk-send, so
// needs_info/duplicate-flagged/not-ready rows are skipped for free.
async function maybeAutoSend(insertedIds, whatsappService) {
  if (!insertedIds.length || !(await messageConfig.getAutoSendEnabled())) return;
  try {
    await sendMessagesByIds(insertedIds, whatsappService, { auto: true });
  } catch (autoSendError) {
    console.error('[watcher] auto-send failed:', autoSendError.message);
  }
}

// Drops from the Excel file only ever create drafts for review - nothing is
// sent automatically, unless the operator has explicitly turned on auto-send
// in Settings (see the end of the try block below), in which case only THIS
// import's own complete, non-duplicate-flagged rows are sent - never older
// drafts already sitting in the queue.
async function ingestFile(filePath, whatsappService) {
  ensureImportDirectories();
  const fileName = path.basename(filePath);
  const insertedIds = [];
  let insertedCount = 0;
  let duplicateSkippedCount = 0; // exact re-import of the same broker+party+date+stones (dedup_key)
  let contentDuplicateCount = 0; // possible duplicate: same party+stones to the same phone from a different import
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
      if (existing) { duplicateSkippedCount += 1; continue; } // exact duplicate demand already logged

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

      let insertedId;
      try {
        insertedId = await db.insertMessage({
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
          dedupComponentSignature: g.dedupComponentSignature,
        });
      } catch (insertError) {
        if (insertError?.code === 'DUPLICATE_DEDUP_KEY') {
          // A concurrent import raced this exact row in between the
          // findByDedupKey check above and the insert - treat it the same as
          // that check instead of quarantining every other row in this file.
          duplicateSkippedCount += 1;
          continue;
        }
        throw insertError;
      }

      insertedIds.push(insertedId);
      insertedCount += 1;
      const insertedRow = await db.getMessage(insertedId);
      if (insertedRow?.duplicate_of_id) contentDuplicateCount += 1;
      bus.emit('update');
    }

    const processedPath = moveFileExclusive(filePath, PROCESSED_DIR, uniqueImportName(fileName));
    bus.emit('update');
    bus.emit('import-summary', {
      fileName, insertedCount, duplicateSkippedCount, contentDuplicateCount, ok: true, error: null,
    });

    await maybeAutoSend(insertedIds, whatsappService);

    return { ok: true, groupCount: groups.length, processedPath, insertedCount, duplicateSkippedCount, contentDuplicateCount };
  } catch (error) {
    console.error(`[watcher] failed to import ${fileName}:`, operatorMessage(error));
    bus.emit('import-summary', {
      fileName, insertedCount, duplicateSkippedCount, contentDuplicateCount, ok: false, error: operatorMessage(error),
    });
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

// Sends a specific set of message rows (used by the per-row Send/Retry button,
// bulk "Send selected"/"Send all drafts", and the auto-send trigger above),
// one at a time. `options.confirmedIds` (single-row Send/Retry only) and
// `options.auto` (auto-send only) are forwarded to the coordinator - bulk
// callers never set either, so a duplicate-flagged row can only ever be sent
// through its own explicit, confirmed Send/Retry action.
async function sendMessagesByIds(ids, whatsappService, options = {}) {
  return coordinateMessageSends(ids, whatsappService, {
    store: db,
    notifyUpdate: () => bus.emit('update'),
    validateAttachment: (attachmentPath) => validateStoredAttachmentPath(attachmentPath, ATTACHMENTS_DIR),
    confirmedIds: options.confirmedIds,
    auto: options.auto,
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
  maybeAutoSend,
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
