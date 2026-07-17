const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const DEFAULT_MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024;
const LOG_FILE_NAME = 'server.log';
const ROTATED_LOG_FILE_NAME = 'server.log.1';

let installedLogger = null;

function isRecoverableBrowserNavigationRace(error) {
  const message = String(error?.message || error || '');
  return (
    /detached Frame/i.test(message)
    || /Execution context was destroyed/i.test(message)
    || /Cannot find context with specified id/i.test(message)
  );
}

function resolveDataDir(explicitDataDir) {
  if (explicitDataDir) return path.resolve(explicitDataDir);
  if (process.env.BROKER_APP_DATA_DIR) return path.resolve(process.env.BROKER_APP_DATA_DIR);
  return path.join(__dirname, '..', 'data');
}

// The logger never inspects requests or application state. This final text
// scrub is defense in depth in case an error from a dependency contains an
// authorization header, session value, pairing code, or rendered QR data URL.
function redactSensitiveText(value) {
  return String(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/_=-]+/gi, '[REDACTED_QR_DATA_URL]')
    .replace(/\bBearer\s+[a-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:password|passcode|token|authorization|cookie|session(?:id)?|pairing(?:code)?|qr(?:dataurl|code)?)[\s"'_]*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[REDACTED]',
    );
}

function limitUtf8(value, maxBytes) {
  const text = String(value);
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return text;

  const suffix = Buffer.from('\n[log entry truncated]', 'utf8');
  const available = Math.max(0, maxBytes - suffix.length);
  return encoded.subarray(0, available).toString('utf8') + suffix.toString('utf8');
}

function formatArguments(args) {
  try {
    return util.formatWithOptions(
      { colors: false, depth: 5, maxArrayLength: 50, maxStringLength: 8000 },
      ...args,
    );
  } catch {
    return args.map((value) => {
      try { return String(value); } catch { return '[unprintable value]'; }
    }).join(' ');
  }
}

function createRuntimeLogWriter({
  dataDir,
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
} = {}) {
  const resolvedDataDir = resolveDataDir(dataDir);
  const logPath = path.join(resolvedDataDir, LOG_FILE_NAME);
  const rotatedLogPath = path.join(resolvedDataDir, ROTATED_LOG_FILE_NAME);
  const boundedMaxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_LOG_BYTES);
  const boundedEntryBytes = Math.max(
    256,
    Math.min(Number(maxEntryBytes) || DEFAULT_MAX_ENTRY_BYTES, Math.floor(boundedMaxBytes / 2)),
  );

  function rotateIfNeeded(incomingBytes) {
    let currentSize = 0;
    try {
      currentSize = fs.statSync(logPath).size;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    if (currentSize + incomingBytes <= boundedMaxBytes) return true;

    try { fs.unlinkSync(rotatedLogPath); } catch { /* no previous rotation */ }
    try {
      fs.renameSync(logPath, rotatedLogPath);
      // A log created by an older build may already be unexpectedly large.
      // Keep the rotation bounded even in that case.
      try {
        if (fs.statSync(rotatedLogPath).size > boundedMaxBytes) {
          fs.truncateSync(rotatedLogPath, boundedMaxBytes);
        }
      } catch { /* rotation still succeeded */ }
      return true;
    } catch {
      // Antivirus can briefly hold a file open on Windows. Truncation is a
      // safe fallback; if that also fails, the outer write simply gives up.
      try {
        fs.truncateSync(logPath, 0);
        return true;
      } catch {
        return false;
      }
    }
  }

  function write(level, args) {
    try {
      fs.mkdirSync(resolvedDataDir, { recursive: true });
      const formatted = redactSensitiveText(formatArguments(Array.isArray(args) ? args : [args]));
      const message = limitUtf8(formatted, boundedEntryBytes);
      const line = `${new Date().toISOString()} [${String(level || 'LOG').toUpperCase()}] ${message}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (!rotateIfNeeded(lineBytes)) return;
      fs.appendFileSync(logPath, line, { encoding: 'utf8' });
    } catch {
      // Runtime diagnostics must never become a startup/runtime failure.
    }
  }

  return { logPath, rotatedLogPath, write };
}

function installRuntimeLogger(options = {}) {
  if (installedLogger) return installedLogger;

  const writer = createRuntimeLogWriter(options);
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  for (const level of ['log', 'warn', 'error']) {
    console[level] = (...args) => {
      try { originalConsole[level](...args); } catch { /* console may be detached */ }
      writer.write(level, args);
    };
  }

  const rejectionErrors = new WeakSet();
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error
      ? reason
      : new Error(`Unhandled promise rejection: ${redactSensitiveText(formatArguments([reason]))}`);
    rejectionErrors.add(error);
    if (isRecoverableBrowserNavigationRace(error)) {
      // whatsapp-web.js uses an async Puppeteer frame-navigation listener that
      // can reject when WhatsApp immediately replaces that frame. The next
      // navigation reinjects normally; terminating the whole app here destroys
      // the in-memory login session and creates a needless restart loop.
      writer.write('warn', ['Recovered from a WhatsApp Web navigation race:', error]);
      return;
    }
    writer.write('fatal', ['Unhandled promise rejection:', error]);

    // Installing an unhandledRejection listener suppresses Node's default
    // fail-fast behavior. Re-throw on the next turn so the watchdog can restart
    // the process exactly as it would without this diagnostic hook.
    setImmediate(() => { throw error; });
  });

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    if (error instanceof Error && rejectionErrors.has(error)) return;
    writer.write('fatal', [`Uncaught exception (${origin || 'unknown origin'}):`, error]);
  });

  writer.write('log', [`Runtime diagnostics started (pid ${process.pid}, Node ${process.version}).`]);
  installedLogger = { ...writer, originalConsole };
  return installedLogger;
}

module.exports = {
  DEFAULT_MAX_LOG_BYTES,
  createRuntimeLogWriter,
  installRuntimeLogger,
  redactSensitiveText,
  isRecoverableBrowserNavigationRace,
};
