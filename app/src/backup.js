const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { backup: sqliteBackup } = require('node:sqlite');
const db = require('./db');

const APP_INSTALL_DIR = path.resolve(__dirname, '..');

// True when `child` is `parent` itself or nested inside it.
function isPathContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const BACKUP_ROOT_SETTING = 'backup_root';
const BACKUP_LAST_SUCCESS_SETTING = 'backup_last_success';
const BACKUP_LAST_ERROR_SETTING = 'backup_last_error';
const BACKUP_TIME_SETTING = 'backup_time_local';
const SCHEDULE_HOUR_LOCAL = 17;
const DEFAULT_BACKUP_TIME = '17:00';
const FAILED_BACKUP_RETRY_MS = 15 * 60 * 1000;
const MAX_FOLDER_PATH_LENGTH = 1000;

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

function localDateParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid date is required.');
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    millisecond: date.getMilliseconds(),
  };
}

function localDateKey(value) {
  const parts = localDateParts(value);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

function normalizeBackupTime(input) {
  const value = String(input || '').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    const error = new Error('Choose a valid daily backup time.');
    error.code = 'INVALID_BACKUP_TIME';
    throw error;
  }
  return `${match[1]}:${match[2]}`;
}

function backupTimeParts(value = DEFAULT_BACKUP_TIME) {
  const normalized = normalizeBackupTime(value);
  const [hour, minute] = normalized.split(':').map(Number);
  return { normalized, hour, minute };
}

function backupTimeLabel(value = DEFAULT_BACKUP_TIME) {
  const { hour, minute } = backupTimeParts(value);
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${pad(minute)} ${period}`;
}

function localScheduledTime(value, backupTime = DEFAULT_BACKUP_TIME) {
  const date = value instanceof Date ? value : new Date(value);
  const { hour, minute } = backupTimeParts(backupTime);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function nextScheduledTime(value, backupTime = DEFAULT_BACKUP_TIME) {
  const now = value instanceof Date ? value : new Date(value);
  const next = localScheduledTime(now, backupTime);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

// The latest 5 PM boundary in local device time. Before 5 PM this is
// yesterday at 5 PM, which lets an existing installation catch up after a
// reboot the following morning. We intentionally create only this one latest
// snapshot; a current database cannot reconstruct multiple historical days.
function latestDueScheduledTime(value, backupTime = DEFAULT_BACKUP_TIME) {
  const now = value instanceof Date ? value : new Date(value);
  const due = localScheduledTime(now, backupTime);
  if (due.getTime() > now.getTime()) due.setDate(due.getDate() - 1);
  return due;
}

function parseStoredJson(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown backup error.');
  return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || 'Unknown backup error.';
}

function normalizeBackupRoot(input) {
  if (typeof input !== 'string' || !input.trim()) {
    const error = new Error('Choose a folder for backups.');
    error.code = 'INVALID_BACKUP_FOLDER';
    throw error;
  }
  const value = input.trim();
  if (value.length > MAX_FOLDER_PATH_LENGTH || value.includes('\0')) {
    const error = new Error('The selected backup folder path is invalid.');
    error.code = 'INVALID_BACKUP_FOLDER';
    throw error;
  }
  if (!path.isAbsolute(value)) {
    const error = new Error('Choose an absolute folder path for backups.');
    error.code = 'INVALID_BACKUP_FOLDER';
    throw error;
  }
  const resolved = path.normalize(path.resolve(value));

  // A backup destination inside the app's own data or install directory
  // would be destroyed right alongside the primary data it's meant to
  // protect (disk failure, accidental folder deletion, uninstall), silently
  // defeating the whole point of an "independent" backup.
  const dataDir = path.resolve(db.DATA_DIR);
  const unsafe = isPathContained(dataDir, resolved)
    || isPathContained(resolved, dataDir)
    || isPathContained(APP_INSTALL_DIR, resolved);
  if (unsafe) {
    const error = new Error('Choose a backup folder outside this application\'s installation and data folders, so backups stay independent from the data they protect.');
    error.code = 'INVALID_BACKUP_FOLDER';
    throw error;
  }

  return resolved;
}

function validateWritableDirectory(input, { fsApi = fs } = {}) {
  const root = normalizeBackupRoot(input);
  try {
    fsApi.mkdirSync(root, { recursive: true });
    const probe = path.join(root, `.broker-demand-backup-write-test-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    let probeCreated = false;
    try {
      fsApi.writeFileSync(probe, 'backup folder write test', { flag: 'wx' });
      probeCreated = true;
    } finally {
      if (probeCreated) {
        try { fsApi.unlinkSync(probe); } catch (_) { /* best-effort cleanup */ }
      }
    }
    const stat = fsApi.statSync(root);
    if (!stat.isDirectory()) throw new Error('The selected path is not a folder.');
    return root;
  } catch (cause) {
    const error = new Error(`The selected backup folder is not writable: ${sanitizeError(cause)}`);
    error.code = 'BACKUP_FOLDER_NOT_WRITABLE';
    throw error;
  }
}

function scheduledDestination(root, value) {
  const parts = localDateParts(value);
  const directory = path.join(root, pad(parts.year, 4), pad(parts.month));
  return {
    directory,
    destination: path.join(directory, `broker-demand-${localDateKey(value)}.db`),
  };
}

function manualDestination(root, value, fsApi = fs) {
  const parts = localDateParts(value);
  const directory = path.join(root, pad(parts.year, 4), pad(parts.month));
  const base = `broker-demand-manual-${localDateKey(value)}_${pad(parts.hour)}-${pad(parts.minute)}-${pad(parts.second)}-${pad(parts.millisecond, 3)}`;
  let counter = 0;
  let destination;
  do {
    destination = path.join(directory, `${base}${counter ? `-${counter + 1}` : ''}.db`);
    counter += 1;
  } while (fsApi.existsSync(destination));
  return { directory, destination };
}

function createBackupManager({
  database,
  store,
  backupDatabase = sqliteBackup,
  fsApi = fs,
  clock = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  randomSuffix = () => crypto.randomBytes(8).toString('hex'),
  logger = console,
} = {}) {
  if (!database) throw new TypeError('database is required.');
  if (!store || typeof store.getSetting !== 'function' || typeof store.setSetting !== 'function') {
    throw new TypeError('A settings store with getSetting and setSetting is required.');
  }

  let started = false;
  let root = null;
  let backupTime = DEFAULT_BACKUP_TIME;
  let timer = null;
  let timerTarget = null;
  let timerKind = null;
  let running = false;
  let lastSuccess = null;
  let lastError = null;
  let operationQueue = Promise.resolve();

  const saveJsonSetting = async (key, value) => {
    await store.setSetting(key, value ? JSON.stringify(value) : '');
  };

  const enqueue = (operation) => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  const isScheduledBackupPresent = (date) => {
    if (!root) return false;
    const { destination } = scheduledDestination(root, date);
    try {
      const stat = fsApi.statSync(destination);
      return stat.isFile() && stat.size > 0;
    } catch (_) {
      return false;
    }
  };

  const usableFileWithinRoot = (candidate) => {
    if (!root || typeof candidate !== 'string' || !candidate) return false;
    try {
      const resolvedCandidate = path.resolve(candidate);
      const relative = path.relative(path.resolve(root), resolvedCandidate);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      const stat = fsApi.statSync(resolvedCandidate);
      return stat.isFile() && stat.size > 0;
    } catch (_) {
      return false;
    }
  };

  const isDueBoundaryCovered = (due) => {
    if (isScheduledBackupPresent(due)) return true;
    if (!lastSuccess?.at || !usableFileWithinRoot(lastSuccess.path)) return false;
    const completedAt = new Date(lastSuccess.at);
    return !Number.isNaN(completedAt.getTime()) && completedAt.getTime() >= due.getTime();
  };

  const performBackup = async ({ kind, date }) => {
    if (!root) {
      const error = new Error('Choose a backup folder before running a backup.');
      error.code = 'BACKUP_NOT_CONFIGURED';
      throw error;
    }

    const when = date instanceof Date ? new Date(date.getTime()) : new Date(date);
    const location = kind === 'scheduled'
      ? scheduledDestination(root, when)
      : manualDestination(root, when, fsApi);

    if (kind === 'scheduled' && isScheduledBackupPresent(when)) {
      return { ok: true, skipped: true, reason: 'already_exists', path: location.destination };
    }

    running = true;
    let tempPath = null;
    try {
      fsApi.mkdirSync(location.directory, { recursive: true });
      tempPath = path.join(location.directory, `.${path.basename(location.destination)}.${process.pid}.${randomSuffix()}.tmp`);
      await backupDatabase(database, tempPath);

      const tempStat = fsApi.statSync(tempPath);
      if (!tempStat.isFile() || tempStat.size < 1) {
        throw new Error('SQLite did not produce a valid backup file.');
      }

      fsApi.renameSync(tempPath, location.destination);
      tempPath = null;
      const completedAt = clock();
      lastSuccess = {
        at: completedAt.toISOString(),
        path: location.destination,
        kind,
        scheduledDate: kind === 'scheduled' ? localDateKey(when) : null,
      };
      lastError = null;
      await saveJsonSetting(BACKUP_LAST_SUCCESS_SETTING, lastSuccess);
      await saveJsonSetting(BACKUP_LAST_ERROR_SETTING, null);
      return { ok: true, skipped: false, ...lastSuccess };
    } catch (cause) {
      if (tempPath) {
        try { fsApi.unlinkSync(tempPath); } catch (_) { /* best-effort cleanup */ }
      }
      const error = cause instanceof Error ? cause : new Error(String(cause));
      lastError = {
        at: clock().toISOString(),
        message: sanitizeError(error),
        kind,
      };
      try { await saveJsonSetting(BACKUP_LAST_ERROR_SETTING, lastError); } catch (_) { /* keep in-memory status */ }
      logger.error?.('[backup] failed:', lastError.message);
      throw error;
    } finally {
      running = false;
    }
  };

  const catchUpLatestDue = async () => {
    if (!root) return null;
    const due = latestDueScheduledTime(clock(), backupTime);
    // An immediate baseline made after this boundary already captures a newer
    // database state. Treat it as coverage so a same-morning restart does not
    // create a misleading file dated for yesterday.
    if (isDueBoundaryCovered(due)) return null;
    return performBackup({ kind: 'scheduled', date: due });
  };

  const clearTimer = () => {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    timerTarget = null;
    timerKind = null;
  };

  const scheduleRetry = () => {
    clearTimer();
    if (!started || !root) return;
    const now = clock();
    timerTarget = new Date(now.getTime() + FAILED_BACKUP_RETRY_MS);
    timerKind = 'retry';
    timer = setTimeoutFn(() => {
      enqueue(catchUpLatestDue).then(scheduleNext).catch(scheduleRetry);
    }, FAILED_BACKUP_RETRY_MS);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const scheduleNext = () => {
    clearTimer();
    if (!started || !root) return;
    const now = clock();
    const target = nextScheduledTime(now, backupTime);
    timerTarget = target;
    timerKind = 'scheduled';
    timer = setTimeoutFn(() => {
      // Use the latest 5 PM boundary at callback time. If the computer slept
      // across multiple days, one current catch-up is useful; manufacturing
      // several identical historical snapshots is not.
      enqueue(catchUpLatestDue).then(scheduleNext).catch(scheduleRetry);
    }, Math.max(0, target.getTime() - now.getTime()));
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const getStatus = () => ({
    configured: !!root,
    root,
    running,
    scheduleHourLocal: backupTimeParts(backupTime).hour,
    scheduleTimeLocal: backupTime,
    scheduleLabel: `Daily at ${backupTimeLabel(backupTime)} (this device's local time)`,
    lastSuccess,
    lastError,
    nextRunKind: timerKind,
    nextScheduledAt: started && root
      ? (timerTarget || nextScheduledTime(clock(), backupTime)).toISOString()
      : null,
  });

  return {
    async start() {
      if (started) return getStatus();
      root = (await store.getSetting(BACKUP_ROOT_SETTING)) || null;
      if (root) {
        try { root = normalizeBackupRoot(root); } catch (_) { root = null; }
      }
      lastSuccess = parseStoredJson(await store.getSetting(BACKUP_LAST_SUCCESS_SETTING));
      lastError = parseStoredJson(await store.getSetting(BACKUP_LAST_ERROR_SETTING));
      try {
        backupTime = normalizeBackupTime(await store.getSetting(BACKUP_TIME_SETTING) || DEFAULT_BACKUP_TIME);
      } catch (_) {
        backupTime = DEFAULT_BACKUP_TIME;
      }
      started = true;
      if (root) {
        try {
          await enqueue(catchUpLatestDue);
          scheduleNext();
        } catch (_) {
          scheduleRetry();
        }
      }
      return getStatus();
    },

    stop() {
      started = false;
      clearTimer();
    },

    getStatus,

    validateRoot(value) {
      return validateWritableDirectory(value, { fsApi });
    },

    setRoot(value) {
      return enqueue(async () => {
        const normalized = validateWritableDirectory(value, { fsApi });
        const isNewSelection = root !== normalized;
        await store.setSetting(BACKUP_ROOT_SETTING, normalized);
        root = normalized;
        // A newly selected folder gets an immediate manual baseline. It does
        // not manufacture a historical scheduled backup; the regular 5 PM
        // schedule begins at the next 5 PM boundary.
        if (isNewSelection) {
          try {
            await performBackup({ kind: 'manual', date: clock() });
            scheduleNext();
          } catch (error) {
            scheduleNext();
            throw error;
          }
        } else {
          try {
            await catchUpLatestDue();
            scheduleNext();
          } catch (error) {
            scheduleRetry();
            throw error;
          }
        }
        return getStatus();
      });
    },

    clearRoot() {
      return enqueue(async () => {
        await store.setSetting(BACKUP_ROOT_SETTING, '');
        root = null;
        clearTimer();
        return getStatus();
      });
    },

    setScheduleTime(value) {
      return enqueue(async () => {
        const normalized = normalizeBackupTime(value);
        await store.setSetting(BACKUP_TIME_SETTING, normalized);
        backupTime = normalized;
        if (root) {
          try {
            await catchUpLatestDue();
            scheduleNext();
          } catch (error) {
            scheduleRetry();
            throw error;
          }
        }
        return getStatus();
      });
    },

    runNow() {
      return enqueue(() => performBackup({ kind: 'manual', date: clock() }));
    },

    runScheduledForTesting(date) {
      return enqueue(() => performBackup({ kind: 'scheduled', date }));
    },
  };
}

const WINDOWS_FOLDER_CHOOSER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose the Broker Demand Desk backup folder'
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'Broker Demand Desk - Choose backup folder'
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0.01
try {
  $owner.Show()
  $owner.Activate()
  [System.Windows.Forms.Application]::DoEvents()
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::Write($dialog.SelectedPath)
    exit 0
  }
  exit 2
} finally {
  $owner.Close()
  $owner.Dispose()
  $dialog.Dispose()
}
`;

function chooseWindowsBackupFolder({
  platform = process.platform,
  spawnFn = spawn,
  timeoutMs = 10 * 60 * 1000,
} = {}) {
  if (platform !== 'win32') {
    const error = new Error('The native folder chooser is available only on Windows. Enter an absolute folder path instead.');
    error.code = 'FOLDER_CHOOSER_UNSUPPORTED';
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const child = spawnFn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_FOLDER_CHOOSER_SCRIPT,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) { /* process already ended */ }
      finish(() => {
        const error = new Error('The folder chooser timed out. Please try again.');
        error.code = 'FOLDER_CHOOSER_TIMEOUT';
        reject(error);
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_FOLDER_PATH_LENGTH + 10) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1000) stderr += chunk.toString('utf8');
    });
    child.on('error', (cause) => finish(() => {
      const error = new Error(`Could not open the Windows folder chooser: ${sanitizeError(cause)}`);
      error.code = 'FOLDER_CHOOSER_FAILED';
      reject(error);
    }));
    child.on('close', (code) => finish(() => {
      if (code === 2) return resolve({ cancelled: true, path: null });
      if (code !== 0) {
        const error = new Error(`Could not choose a backup folder${stderr.trim() ? `: ${sanitizeError(stderr)}` : '.'}`);
        error.code = 'FOLDER_CHOOSER_FAILED';
        return reject(error);
      }
      try {
        return resolve({ cancelled: false, path: normalizeBackupRoot(stdout.trim()) });
      } catch (error) {
        error.code = 'FOLDER_CHOOSER_FAILED';
        return reject(error);
      }
    }));
  });
}

module.exports = {
  BACKUP_TIME_SETTING,
  DEFAULT_BACKUP_TIME,
  BACKUP_ROOT_SETTING,
  BACKUP_LAST_SUCCESS_SETTING,
  BACKUP_LAST_ERROR_SETTING,
  SCHEDULE_HOUR_LOCAL,
  FAILED_BACKUP_RETRY_MS,
  createBackupManager,
  chooseWindowsBackupFolder,
  localDateKey,
  localScheduledTime,
  latestDueScheduledTime,
  nextScheduledTime,
  normalizeBackupRoot,
  normalizeBackupTime,
  scheduledDestination,
  validateWritableDirectory,
};
