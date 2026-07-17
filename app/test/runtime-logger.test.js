const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRuntimeLogWriter,
  isRecoverableBrowserNavigationRace,
  redactSensitiveText,
} = require('../src/runtimeLogger');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'broker-runtime-log-'));
}

test('runtime diagnostics are timestamped, redacted, and rotated within a bound', () => {
  const dataDir = temporaryDirectory();
  try {
    const logger = createRuntimeLogWriter({ dataDir, maxBytes: 1024, maxEntryBytes: 300 });
    logger.write('error', [{ token: 'top-secret', qrDataUrl: 'data:image/png;base64,AAAA' }]);

    const first = fs.readFileSync(logger.logPath, 'utf8');
    assert.match(first, /^\d{4}-\d{2}-\d{2}T.* \[ERROR\]/);
    assert.doesNotMatch(first, /top-secret|base64,AAAA/);
    assert.match(first, /\[REDACTED\]/);

    for (let i = 0; i < 20; i++) logger.write('log', [`entry-${i} ${'x'.repeat(180)}`]);

    assert.equal(fs.existsSync(logger.rotatedLogPath), true);
    assert.ok(fs.statSync(logger.logPath).size <= 1024);
    assert.ok(fs.statSync(logger.rotatedLogPath).size <= 1024);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('runtime logging never throws when its destination is unwritable or invalid', () => {
  const root = temporaryDirectory();
  try {
    const notADirectory = path.join(root, 'blocked');
    fs.writeFileSync(notADirectory, 'file blocks directory creation');
    const logger = createRuntimeLogWriter({ dataDir: notADirectory });
    assert.doesNotThrow(() => logger.write('error', ['cannot be persisted']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('common credential text is scrubbed before persistence', () => {
  const scrubbed = redactSensitiveText(
    "Authorization: Bearer abc.def; password='secret'; pairingCode=123456; sessionId: cookie-value",
  );
  assert.doesNotMatch(scrubbed, /abc\.def|secret|123456|cookie-value/);
  assert.match(scrubbed, /\[REDACTED\]/);
});

test('only known transient Puppeteer navigation races are recoverable', () => {
  assert.equal(isRecoverableBrowserNavigationRace(new Error("Attempted to use detached Frame 'ABC'.")), true);
  assert.equal(isRecoverableBrowserNavigationRace(new Error('Execution context was destroyed, most likely because of a navigation.')), true);
  assert.equal(isRecoverableBrowserNavigationRace(new Error('Database write failed')), false);
});
