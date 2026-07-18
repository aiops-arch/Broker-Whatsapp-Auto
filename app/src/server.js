// Install persistent diagnostics before loading the database, WhatsApp
// provider, or any other module that can fail during startup. The launcher
// supplies BROKER_APP_DATA_DIR for packaged installs; development falls back
// to app/data.
require('./runtimeLogger').installRuntimeLogger();

const path = require('node:path');
const fs = require('node:fs');

// A bundled installer ships its own Chromium under runtime/puppeteer-cache so
// the target machine needs nothing preinstalled - point puppeteer at it when
// present, before whatsapp-web.js (and puppeteer) gets required below. On a
// dev checkout this folder doesn't exist, so puppeteer just uses its own
// default (~/.cache/puppeteer) as normal.
const bundledPuppeteerCache = path.join(__dirname, '..', 'runtime', 'puppeteer-cache');
if (fs.existsSync(bundledPuppeteerCache)) {
  process.env.PUPPETEER_CACHE_DIR = bundledPuppeteerCache;
}

const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const db = require('./db');
const {
  MIN_PASSWORD_LENGTH,
  RECOVERY_CODE_TTL_MS,
  hashPassword,
  verifyPassword,
  createRecoveryManager,
} = require('./auth');
const { createProvider } = require('./providers');
const {
  startWatcher,
  sendMessagesByIds,
  sendAllDrafts,
  UPLOAD_STAGING_DIR,
  ensureImportDirectories,
  quarantineFailedImport,
  queueUploadedWorkbook,
} = require('./watcher');
const { parseWorkbook } = require('./excelParser');
const { createConfigRouter } = require('./configRoutes');
const {
  MAX_WORKBOOK_BYTES,
  UPLOAD_LIMITS,
  operatorMessage,
  validateUploadFileName,
} = require('./importFiles');
const { createBackupManager, chooseWindowsBackupFolder } = require('./backup');
const bus = require('./events');
const { SESSION_IDLE_TIMEOUT_MS, createSQLiteSessionStore } = require('./sqliteSessionStore');

const PORT = process.env.PORT || 4173;

async function main() {
  await db.init();
  const backupManager = createBackupManager({ database: db.db, store: db });
  await backupManager.start();

  let sessionSecret = await db.getSetting('session_secret');
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    await db.setSetting('session_secret', sessionSecret);
  }

  const whatsapp = createProvider();
  const recoveryManager = createRecoveryManager();
  whatsapp.on('status', () => bus.emit('update'));
  whatsapp.on('ack', (waMessageId, deliveryStatus) => {
    // EventEmitter does not observe rejected async listeners. Contain any
    // unexpected acknowledgement/database failure so WhatsApp cannot crash
    // the server and trigger a login/restart loop.
    Promise.resolve(db.setDeliveryStatusByWaId(waMessageId, deliveryStatus))
      .then((updated) => { if (updated) bus.emit('update'); })
      .catch((error) => console.error('[whatsapp_web] could not save delivery acknowledgement:', error.message));
  });
  startWatcher(whatsapp);

  const app = express();
  // Persist authenticated browser sessions in this installation's SQLite DB.
  // A MemoryStore logs everyone out whenever the watchdog restarts the local
  // server, even though the browser cookie itself is still valid.
  const sessionStore = createSQLiteSessionStore(session, db.db);
  let authGeneration = 0;

  const isAuthenticated = (req) => (
    req.session?.authenticated === true
    && req.session.authGeneration === authGeneration
  );

  const establishAuthenticatedSession = (req, expectedGeneration = authGeneration) => new Promise((resolve, reject) => {
    req.session.regenerate((regenerateError) => {
      if (regenerateError) return reject(regenerateError);
      if (expectedGeneration !== authGeneration) {
        return reject(new Error('Authentication state changed.'));
      }
      req.session.authenticated = true;
      req.session.authGeneration = expectedGeneration;
      req.session.save((saveError) => (saveError ? reject(saveError) : resolve()));
    });
  });

  const invalidateAllSessions = async () => {
    // The generation check invalidates sessions immediately, including any
    // request racing with the persistent store clear. The SQLite store remains
    // local to this installation and is cleared on password/reset operations.
    authGeneration += 1;
    await new Promise((resolve) => {
      sessionStore.clear((error) => {
        if (error) console.error('Could not clear expired login sessions:', error.message);
        resolve();
      });
    });
  };

  app.use(express.json());
  app.use(session({
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION_IDLE_TIMEOUT_MS }, // 30 minutes after last activity
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  ensureImportDirectories();
  const upload = multer({
    dest: UPLOAD_STAGING_DIR,
    limits: UPLOAD_LIMITS,
    fileFilter: (_req, file, callback) => {
      const validation = validateUploadFileName(file.originalname);
      callback(validation.ok ? null : validation.error, validation.ok);
    },
  });

  // Used by the local watchdog to distinguish this installation from an
  // unrelated program that happens to occupy the same loopback port.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, app: 'broker-demand-desk' });
  });

  // ---------- Auth ----------
  app.get('/api/auth/status', async (req, res) => {
    const hasPassword = !!(await db.getSetting('password_hash'));
    res.json({ hasPassword, authenticated: isAuthenticated(req) });
  });

  // First-run only: sets the password for the first time. Once a password
  // exists, this always refuses - use /api/auth/change-password instead.
  app.post('/api/auth/setup', async (req, res) => {
    try {
      const existing = await db.getSetting('password_hash');
      if (existing) return res.status(400).json({ error: 'A password is already set.' });
      const password = String(req.body?.password || '');
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.` });
      }
      await db.setSetting('password_hash', hashPassword(password));
      recoveryManager.clear();
      await establishAuthenticatedSession(req);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not set up the password.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const expectedGeneration = authGeneration;
    try {
      const stored = await db.getSetting('password_hash');
      if (!stored) return res.status(400).json({ error: 'No password set up yet.' });
      if (!verifyPassword(String(req.body?.password || ''), stored)) {
        return res.status(401).json({ error: 'Wrong password.' });
      }
      if (expectedGeneration !== authGeneration) {
        return res.status(401).json({ error: 'Login state changed. Please try again.' });
      }
      await establishAuthenticatedSession(req, expectedGeneration);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not complete login.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.post('/api/auth/change-password', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not logged in.' });
    const expectedGeneration = authGeneration;
    try {
      const stored = await db.getSetting('password_hash');
      if (!verifyPassword(String(req.body?.currentPassword || ''), stored)) {
        return res.status(401).json({ error: 'Current password is wrong.' });
      }
      const nextPassword = String(req.body?.newPassword || '');
      if (nextPassword.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.` });
      }
      if (expectedGeneration !== authGeneration) {
        return res.status(401).json({ error: 'Your login has expired. Please sign in again.' });
      }
      await db.setSetting('password_hash', hashPassword(nextPassword));
      recoveryManager.clear();
      await invalidateAllSessions();
      res.json({ ok: true, authenticated: false, reauthenticationRequired: true });
    } catch (error) {
      res.status(500).json({ error: 'Could not change the password.' });
    }
  });

  const getRecoveryAvailability = async () => {
    if (
      typeof whatsapp.getRecoveryInfo !== 'function'
      || typeof whatsapp.sendRecoveryCode !== 'function'
    ) {
      return {
        available: false,
        reason: 'Password recovery is unavailable because this WhatsApp provider does not support it.',
      };
    }

    try {
      const info = await whatsapp.getRecoveryInfo();
      if (info?.available !== true) {
        return {
          available: false,
          reason: typeof info?.reason === 'string' && info.reason.trim()
            ? info.reason.trim().slice(0, 200)
            : 'Link WhatsApp and wait until it is ready before requesting a recovery code.',
        };
      }
      return {
        available: true,
        maskedDestination: typeof info.maskedPhone === 'string' ? info.maskedPhone : null,
      };
    } catch (error) {
      return {
        available: false,
        reason: 'WhatsApp recovery status could not be checked. Make sure WhatsApp is linked and ready.',
      };
    }
  };

  // All recovery endpoints are intentionally under /api/auth so they remain
  // reachable from the logged-out screen. Recovery is local to this process
  // and can only use this installation's already-linked WhatsApp provider.
  app.get('/api/auth/recovery/status', async (req, res) => {
    try {
      const hasPassword = !!(await db.getSetting('password_hash'));
      const availability = hasPassword
        ? await getRecoveryAvailability()
        : { available: false, reason: 'Set up a password before using password recovery.' };
      const state = recoveryManager.getStatus();
      res.json({
        available: availability.available,
        maskedDestination: availability.maskedDestination || null,
        reason: availability.available ? null : availability.reason,
        codePending: state.codePending,
        codeExpiresInSeconds: Math.ceil(state.expiresInMs / 1000),
        cooldownSeconds: Math.ceil(state.cooldownRemainingMs / 1000),
      });
    } catch (error) {
      res.status(500).json({
        available: false,
        error: 'Password recovery status is temporarily unavailable.',
        code: 'RECOVERY_STATUS_FAILED',
      });
    }
  });

  app.post('/api/auth/recovery/request', async (req, res) => {
    try {
      const hasPassword = !!(await db.getSetting('password_hash'));
      if (!hasPassword) {
        return res.status(409).json({
          error: 'Password recovery is unavailable until a password has been set up.',
          code: 'RECOVERY_NOT_CONFIGURED',
        });
      }

      const availability = await getRecoveryAvailability();
      if (!availability.available) {
        return res.status(503).json({
          error: availability.reason,
          code: 'WHATSAPP_UNAVAILABLE',
        });
      }

      const result = await recoveryManager.request((code) => whatsapp.sendRecoveryCode(code));
      if (!result.ok && result.reason === 'cooldown') {
        const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          error: 'Please wait before requesting another recovery code.',
          code: 'RECOVERY_COOLDOWN',
          retryAfterSeconds,
        });
      }
      if (!result.ok) {
        return res.status(503).json({
          error: 'The recovery code could not be sent. Make sure the linked WhatsApp account is ready, then try again.',
          code: 'WHATSAPP_UNAVAILABLE',
        });
      }

      res.json({
        ok: true,
        message: 'A 6-digit recovery code was sent to the linked WhatsApp account.',
        maskedDestination: availability.maskedDestination || null,
        expiresInSeconds: Math.ceil(RECOVERY_CODE_TTL_MS / 1000),
      });
    } catch (error) {
      res.status(500).json({
        error: 'The recovery request could not be completed.',
        code: 'RECOVERY_REQUEST_FAILED',
      });
    }
  });

  app.post('/api/auth/recovery/verify', async (req, res) => {
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.`,
        code: 'PASSWORD_TOO_SHORT',
      });
    }

    const result = recoveryManager.verify(req.body?.code);
    if (!result.ok) {
      return res.status(400).json({
        error: 'The recovery code is invalid or expired. Request a new code and try again.',
        code: 'INVALID_OR_EXPIRED_CODE',
      });
    }

    try {
      await db.setSetting('password_hash', hashPassword(newPassword));
      await invalidateAllSessions();
      const resetGeneration = authGeneration;
      try {
        await establishAuthenticatedSession(req, resetGeneration);
        return res.json({
          ok: true,
          authenticated: true,
          message: 'Password reset successfully.',
        });
      } catch (sessionError) {
        return res.json({
          ok: true,
          authenticated: false,
          message: 'Password reset successfully. Sign in with the new password.',
        });
      }
    } catch (error) {
      res.status(500).json({
        error: 'The password could not be reset. Request a new recovery code and try again.',
        code: 'PASSWORD_RESET_FAILED',
      });
    }
  });

  // Everything else under /api requires a logged-in session.
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Not logged in.' });
  });

  app.get('/api/status', async (req, res) => {
    res.json({
      whatsapp: whatsapp.getStatus(),
      counts: await db.counts(),
      archivedAttention: await db.archivedAttentionCount(),
    });
  });

  // ---------- Local backups ----------
  // The selected root and all backup history stay in this installation's
  // local app_settings table. Each device chooses its own local daily time;
  // backups are written under <selected root>/YYYY/MM.
  app.get('/api/backup/status', (req, res) => {
    res.json(backupManager.getStatus());
  });

  app.post('/api/backup/validate-folder', (req, res) => {
    try {
      const root = backupManager.validateRoot(req.body?.path);
      res.json({ ok: true, root });
    } catch (error) {
      res.status(400).json({
        error: error.message,
        code: error.code || 'INVALID_BACKUP_FOLDER',
      });
    }
  });

  app.post('/api/backup/folder', async (req, res) => {
    try {
      const status = await backupManager.setRoot(req.body?.path);
      res.json({ ok: true, status });
    } catch (error) {
      const statusCode = error.code === 'INVALID_BACKUP_FOLDER'
        || error.code === 'BACKUP_FOLDER_NOT_WRITABLE'
        ? 400
        : 500;
      res.status(statusCode).json({
        error: error.message,
        code: error.code || 'BACKUP_CONFIGURATION_FAILED',
        status: backupManager.getStatus(),
      });
    }
  });

  app.delete('/api/backup/folder', async (req, res) => {
    try {
      const status = await backupManager.clearRoot();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({ error: 'Could not disable scheduled backups.', code: 'BACKUP_CONFIGURATION_FAILED' });
    }
  });

  // This endpoint executes a constant, argument-free Windows Forms script.
  // No request data is interpolated into PowerShell, avoiding command
  // injection. The chosen path still goes through the same writable-folder
  // validation before it is saved.
  app.post('/api/backup/choose-folder', async (req, res) => {
    try {
      const choice = await chooseWindowsBackupFolder();
      if (choice.cancelled) return res.json({ ok: true, cancelled: true, status: backupManager.getStatus() });
      const status = await backupManager.setRoot(choice.path);
      return res.json({ ok: true, cancelled: false, root: choice.path, status });
    } catch (error) {
      const statusCode = error.code === 'FOLDER_CHOOSER_UNSUPPORTED' ? 501
        : error.code === 'BACKUP_FOLDER_NOT_WRITABLE' ? 400
          : 500;
      return res.status(statusCode).json({
        error: error.message,
        code: error.code || 'FOLDER_CHOOSER_FAILED',
        status: backupManager.getStatus(),
      });
    }
  });

  app.post('/api/backup/run', async (req, res) => {
    try {
      const result = await backupManager.runNow();
      res.json({ ok: true, result, status: backupManager.getStatus() });
    } catch (error) {
      const statusCode = error.code === 'BACKUP_NOT_CONFIGURED' ? 409 : 500;
      res.status(statusCode).json({
        error: error.code === 'BACKUP_NOT_CONFIGURED'
          ? error.message
          : 'The backup could not be completed. Check the selected folder and try again.',
        code: error.code || 'BACKUP_FAILED',
        status: backupManager.getStatus(),
      });
    }
  });

  app.put('/api/backup/schedule', async (req, res) => {
    try {
      const status = await backupManager.setScheduleTime(req.body?.time);
      res.json({ ok: true, status });
    } catch (error) {
      const statusCode = error.code === 'INVALID_BACKUP_TIME' ? 400 : 500;
      res.status(statusCode).json({
        error: error.code === 'INVALID_BACKUP_TIME'
          ? error.message
          : 'The daily backup time could not be saved.',
        code: error.code || 'BACKUP_SCHEDULE_FAILED',
        status: backupManager.getStatus(),
      });
    }
  });

  // First-run only: links WhatsApp using a phone number + pairing code instead
  // of a QR scan. No-ops with an error once a session already exists/started.
  app.post('/api/whatsapp/setup', (req, res) => {
    if (typeof whatsapp.beginSetup !== 'function') {
      return res.status(400).json({ error: 'This provider does not use phone-number setup.' });
    }
    try {
      whatsapp.beginSetup(req.body?.phoneNumber);
      res.json({ ok: true, status: whatsapp.getStatus() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Fallback for the setup screen's "scan a QR code instead" link.
  app.post('/api/whatsapp/setup-qr', (req, res) => {
    if (typeof whatsapp.beginSetupWithQr !== 'function') {
      return res.status(400).json({ error: 'This provider does not support QR setup.' });
    }
    try {
      whatsapp.beginSetupWithQr();
      res.json({ ok: true, status: whatsapp.getStatus() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Forces a fresh QR/pairing code right now instead of waiting for it to rotate on its own.
  app.post('/api/whatsapp/refresh', async (req, res) => {
    if (typeof whatsapp.refreshCode !== 'function') {
      return res.status(400).json({ error: 'This provider does not support refreshing.' });
    }
    try {
      await whatsapp.refreshCode();
      res.json({ ok: true, status: whatsapp.getStatus() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Recovery for an incomplete/corrupt first-time LocalAuth profile. This is
  // deliberately unavailable once connected: a ready account must use the
  // normal Disconnect action so WhatsApp is logged out cleanly. Only this
  // installation's owned session directory is removed by the provider.
  app.post('/api/whatsapp/reset', async (req, res) => {
    if (typeof whatsapp.resetSetup !== 'function') {
      return res.status(400).json({ error: 'This provider does not support resetting setup.' });
    }
    try {
      await whatsapp.resetSetup();
      return res.json({ ok: true, status: whatsapp.getStatus() });
    } catch (err) {
      const statusCode = whatsapp.isReady?.() ? 409 : 400;
      return res.status(statusCode).json({
        error: err.message || 'WhatsApp setup could not be reset.',
        status: whatsapp.getStatus(),
      });
    }
  });

  // Unlinks the connected number so a different one can be set up instead.
  app.post('/api/whatsapp/disconnect', async (req, res) => {
    if (typeof whatsapp.disconnect !== 'function') {
      return res.status(400).json({ error: 'This provider does not support disconnecting.' });
    }
    try {
      await whatsapp.disconnect();
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- Configurable column mapping and message template ----------
  // Lets each installation map its own workbook's column names onto the
  // fields the app understands, and customize the WhatsApp message text,
  // instead of requiring the original fixed headers/wording. Defaults
  // reproduce the application's original fixed behavior exactly, so existing
  // installations are unaffected until an operator changes Settings. Routes
  // live in their own module so they can be exercised in tests without the
  // full app (WhatsApp provider, session store, watcher) running.
  app.use('/api/config', createConfigRouter({ upload, fs }));

  app.get('/api/brokers', async (req, res) => {
    res.json(await db.listBrokers());
  });

  app.post('/api/brokers', async (req, res) => {
    const { name, phone } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const id = await db.upsertBroker(String(name).trim(), phone ? String(phone).trim() : null);
    bus.emit('update');
    res.json({ id });
  });

  app.delete('/api/brokers/:id', async (req, res) => {
    await db.deleteBroker(Number(req.params.id));
    bus.emit('update');
    res.json({ ok: true });
  });

  app.get('/api/logs', async (req, res) => {
    const { status } = req.query;
    const archived = req.query.archived === 'true';
    res.json(await db.listMessages({ status: status || undefined, archived }));
  });

  app.patch('/api/logs/:id', async (req, res) => {
    const id = Number(req.params.id);
    const { brokerName, phone, message, buyerName } = req.body || {};
    try {
      const updated = await db.updateMessage(id, { brokerName, phone, message, buyerName });
      if (!updated) return res.status(404).json({ error: 'not found' });
      bus.emit('update');
      res.json(updated);
    } catch (error) {
      if (error?.code === 'MESSAGE_NOT_EDITABLE') {
        return res.status(409).json({ error: error.message, code: error.code });
      }
      console.error('Could not update message:', error);
      return res.status(500).json({ error: 'Could not update this message.' });
    }
  });

  // Manual resolution for a send interrupted between WhatsApp and the final
  // DB commit. This route sits behind the authenticated /api middleware and
  // can atomically act on send_uncertain rows only. The operator must first
  // verify the broker chat, then choose "sent" or "retry".
  app.post('/api/logs/:id/reconcile', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'A valid message id is required.', code: 'INVALID_MESSAGE_ID' });
    }
    const decision = String(req.body?.decision || '').trim().toLowerCase();
    if (decision !== 'sent' && decision !== 'retry') {
      return res.status(400).json({
        error: 'Decision must be either "sent" or "retry".',
        code: 'INVALID_RECONCILIATION_DECISION',
      });
    }

    try {
      const updated = await db.reconcileUncertainMessage(id, decision);
      if (!updated) {
        const existing = await db.getMessage(id);
        if (!existing) return res.status(404).json({ error: 'not found' });
        return res.status(409).json({
          error: 'Only a message with send_uncertain status can be reconciled.',
          code: 'MESSAGE_NOT_UNCERTAIN',
          status: existing.status,
        });
      }
      bus.emit('update');
      return res.json({ ok: true, decision, message: updated });
    } catch (error) {
      console.error('Could not reconcile uncertain message:', error);
      return res.status(500).json({ error: 'Could not reconcile this message.' });
    }
  });

  // Explicit, one-at-a-time send - this is the only way a message ever goes
  // out (aside from an opt-in auto-send, which never confirms a duplicate).
  // A row flagged as a possible duplicate requires one extra explicit
  // confirmation before it is actually sent.
  app.post('/api/logs/:id/send', async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.getMessage(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.duplicate_of_id && req.body?.confirmDuplicate !== true) {
      return res.status(409).json({
        error: `Possible duplicate of message #${row.duplicate_of_id} (same party/stones already sent or queued to this number).`,
        code: 'POSSIBLE_DUPLICATE',
        duplicateOfId: row.duplicate_of_id,
        requiresConfirmation: true,
      });
    }
    const [result] = await sendMessagesByIds([id], whatsapp, { confirmedIds: [id] });
    if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Send failed', blocked: result?.blocked });
    res.json({ ok: true });
  });

  // Retry is the same action as Send, just for a row that already failed once.
  app.post('/api/logs/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    const row = await db.getMessage(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.duplicate_of_id && req.body?.confirmDuplicate !== true) {
      return res.status(409).json({
        error: `Possible duplicate of message #${row.duplicate_of_id} (same party/stones already sent or queued to this number).`,
        code: 'POSSIBLE_DUPLICATE',
        duplicateOfId: row.duplicate_of_id,
        requiresConfirmation: true,
      });
    }
    const [result] = await sendMessagesByIds([id], whatsapp, { confirmedIds: [id] });
    if (!result || !result.ok) return res.status(400).json({ error: (result && result.error) || 'Retry failed', blocked: result?.blocked });
    res.json({ ok: true });
  });

  app.post('/api/logs/send-bulk', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    if (!ids.length) return res.status(400).json({ error: 'no ids provided' });
    const results = await sendMessagesByIds(ids, whatsapp);
    res.json({ results });
  });

  app.post('/api/logs/send-all-drafts', async (req, res) => {
    const results = await sendAllDrafts(whatsapp);
    res.json({ results });
  });

  // Server-Sent Events: pushes a ping whenever brokers/logs/whatsapp status change,
  // so the dashboard can refresh instantly instead of polling on a timer.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');

    const send = () => res.write('data: update\n\n');
    // A named event carrying import-outcome counts (new/skipped-duplicate/
    // possible-duplicate), so a duplicate re-import doesn't look identical to
    // a fresh one - see the plain "update" ping above, which only triggers a
    // silent data refresh.
    const sendImportSummary = (summary) => res.write(`event: import-summary\ndata: ${JSON.stringify(summary)}\n\n`);
    bus.on('update', send);
    bus.on('import-summary', sendImportSummary);
    const heartbeat = setInterval(() => res.write(':hb\n\n'), 20000);

    req.on('close', () => {
      bus.off('update', send);
      bus.off('import-summary', sendImportSummary);
      clearInterval(heartbeat);
    });
  });

  app.get('/api/logs/export', async (req, res) => {
    const all = await db.listMessages({});
    const rows = all.filter((r) => r.status === 'failed' || r.status === 'needs_info');
    const header = 'id,demand_date,broker_name,party_name,phone,stone_count,source_file,error,created_at\n';
    const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = rows
      .map((r) => [r.id, r.demand_date, r.broker_name, r.party_name, r.phone, r.stone_count, r.source_file, r.error, r.created_at].map(escapeCsv).join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="error_report.csv"');
    res.send(header + body);
  });

  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (uploadError) => {
      if (uploadError) {
        if (uploadError.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: `Workbook is too large. The maximum size is ${Math.round(MAX_WORKBOOK_BYTES / (1024 * 1024))} MB.`,
            code: uploadError.code,
          });
        }
        const statusCode = uploadError.statusCode || 400;
        const isMulterLimit = uploadError instanceof multer.MulterError;
        const multerMessages = {
          LIMIT_PART_COUNT: 'Upload contained extra form data. Choose one .xlsx workbook and try again.',
          LIMIT_FILE_COUNT: 'More than one file was sent. Choose one .xlsx workbook only.',
          LIMIT_FIELD_COUNT: 'Upload contained an unexpected form field. Choose the workbook again and retry.',
          LIMIT_UNEXPECTED_FILE: 'The selected file was sent under an unexpected upload field. Refresh the app and try again.',
        };
        return res.status(statusCode).json({
          error: isMulterLimit
            ? (multerMessages[uploadError.code] || 'Upload rejected. Choose exactly one .xlsx workbook and try again.')
            : operatorMessage(uploadError),
          code: uploadError.code || 'UPLOAD_REJECTED',
        });
      }

      if (!req.file) return res.status(400).json({ error: 'Choose one .xlsx workbook to upload.', code: 'FILE_REQUIRED' });

      (async () => {
        try {
          // Validate both the ZIP/XLSX content and the business workbook schema
          // while the file is still isolated from the watcher. The watcher
          // validates it again immediately before writing any drafts.
          await parseWorkbook(req.file.path);
        } catch (error) {
          try {
            const quarantine = quarantineFailedImport(req.file.path, error, req.file.originalname);
            return res.status(error.statusCode || 422).json({
              error: operatorMessage(error),
              code: error.code || 'INVALID_WORKBOOK',
              quarantinedAs: path.basename(quarantine.quarantinedPath),
            });
          } catch (quarantineError) {
            console.error('[upload] validation failed and quarantine also failed:', quarantineError.message);
            return res.status(500).json({ error: 'The workbook was invalid, but could not be moved to failed-imports.' });
          }
        }

        try {
          queueUploadedWorkbook(req.file.path, req.file.originalname);
          return res.status(202).json({
            ok: true,
            message: 'Workbook validated and queued for local processing.',
          });
        } catch (error) {
          console.error('[upload] could not queue workbook:', error.message);
          if (fs.existsSync(req.file.path)) {
            try { quarantineFailedImport(req.file.path, error, req.file.originalname); } catch (_) { /* already logged */ }
          }
          return res.status(500).json({ error: 'The workbook was valid but could not be queued. It was kept in failed-imports when possible.' });
        }
      })().catch((error) => {
        console.error('[upload] unexpected failure:', error.message);
        if (!res.headersSent) res.status(500).json({ error: 'Unexpected workbook upload failure.' });
      });
      return undefined;
    });
    return undefined;
  });

  // Loopback-only by default - this is a single-user tool with no login, so
  // it shouldn't be reachable from the network unless explicitly asked for
  // (set HOST=0.0.0.0 to test from another device on the same network).
  const HOST = process.env.HOST || '127.0.0.1';
  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`Broker demand WhatsApp app running at http://${HOST}:${PORT} (also try your machine's LAN IP if HOST=0.0.0.0)`);
  });

  // Ctrl+C, service stops, and cooperative upgrade tools get a bounded chance
  // to close this installation's owned Chromium processes without logging out
  // or deleting the saved WhatsApp profile. The Windows Stop shortcut also
  // has a path-contained descendant cleanup for forced termination.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Shutdown requested (${signal}).`);
    backupManager.stop();
    httpServer.close();
    const forcedExit = setTimeout(() => {
      console.error('Graceful shutdown timed out; exiting now.');
      process.exit(1);
    }, 20000);
    forcedExit.unref?.();
    try {
      if (typeof whatsapp.shutdown === 'function') await whatsapp.shutdown();
      clearTimeout(forcedExit);
      process.exit(0);
    } catch (error) {
      console.error('Graceful WhatsApp shutdown failed:', error);
      clearTimeout(forcedExit);
      process.exit(1);
    }
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
