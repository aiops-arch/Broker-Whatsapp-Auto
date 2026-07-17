const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  BACKUP_TIME_SETTING,
  BACKUP_ROOT_SETTING,
  FAILED_BACKUP_RETRY_MS,
  chooseWindowsBackupFolder,
  createBackupManager,
  latestDueScheduledTime,
  scheduledDestination,
} = require('../src/backup');

const temporaryRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-backup-test-'));
  temporaryRoots.push(root);
  return root;
}

test.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async getSetting(key) { return values.get(key) || null; },
    async setSetting(key, value) { values.set(key, value); },
  };
}

function makeTimers() {
  const calls = [];
  return {
    calls,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      calls.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; },
  };
}

function makeManager({ now, store = makeStore(), backupDatabase, timers = makeTimers(), logger } = {}) {
  let current = now || new Date(2026, 6, 17, 10, 0, 0, 0);
  const calls = [];
  const backupFn = backupDatabase || (async (_database, destination) => {
    calls.push(destination);
    fs.writeFileSync(destination, 'fake sqlite backup');
  });
  const manager = createBackupManager({
    database: { testDatabase: true },
    store,
    backupDatabase: backupFn,
    clock: () => new Date(current.getTime()),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    randomSuffix: () => 'fixed-test-suffix',
    logger: logger || { error() {} },
  });
  return {
    manager,
    store,
    calls,
    timers,
    setNow(value) { current = value; },
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('does nothing until a backup folder is configured', async () => {
  const context = makeManager();
  const status = await context.manager.start();

  assert.equal(status.configured, false);
  assert.equal(status.nextScheduledAt, null);
  assert.equal(context.calls.length, 0);
  assert.equal(context.timers.calls.length, 0);
  await assert.rejects(context.manager.runNow(), (error) => error.code === 'BACKUP_NOT_CONFIGURED');
});

test('a newly selected folder gets an immediate manual baseline and YYYY/MM layout', async () => {
  const root = makeTempRoot();
  const context = makeManager({ now: new Date(2026, 6, 17, 10, 30, 0, 0) });
  await context.manager.start();

  const status = await context.manager.setRoot(root);

  assert.equal(status.configured, true);
  assert.equal(status.root, path.resolve(root));
  assert.equal(context.store.values.get(BACKUP_ROOT_SETTING), path.resolve(root));
  assert.equal(context.calls.length, 1);
  assert.equal(path.dirname(context.calls[0]), path.join(root, '2026', '07'));
  assert.match(path.basename(context.calls[0]), /^\.broker-demand-manual-2026-07-17_10-30-00-000\.db\./);
  assert.equal(status.lastSuccess.kind, 'manual');
  assert.ok(fs.existsSync(status.lastSuccess.path));
  assert.equal(context.timers.calls.at(-1).delay, 6.5 * 60 * 60 * 1000);

  await context.manager.setRoot(root);
  assert.equal(context.calls.length, 1, 'saving the same folder must not create another baseline');
});

test('daily backup time is stored independently and rescheduled on this device', async () => {
  const root = makeTempRoot();
  const store = makeStore();
  const context = makeManager({ now: new Date(2026, 6, 17, 10, 0, 0, 0), store });
  await context.manager.start();
  await context.manager.setScheduleTime('14:45');
  const status = await context.manager.setRoot(root);

  assert.equal(store.values.get(BACKUP_TIME_SETTING), '14:45');
  assert.equal(status.scheduleTimeLocal, '14:45');
  assert.match(status.scheduleLabel, /2:45 PM/);
  assert.equal(context.timers.calls.at(-1).delay, (4 * 60 + 45) * 60 * 1000);

  const restarted = makeManager({ now: new Date(2026, 6, 17, 10, 0, 0, 0), store });
  const restartedStatus = await restarted.manager.start();
  assert.equal(restartedStatus.scheduleTimeLocal, '14:45');
  assert.equal(new Date(restartedStatus.nextScheduledAt).getHours(), 14);
  assert.equal(new Date(restartedStatus.nextScheduledAt).getMinutes(), 45);
  await assert.rejects(restarted.manager.setScheduleTime('25:99'), (error) => error.code === 'INVALID_BACKUP_TIME');
});

test('a same-morning restart treats the existing baseline as coverage, not a fake yesterday backup', async () => {
  const root = makeTempRoot();
  const store = makeStore();
  const now = new Date(2026, 6, 17, 10, 30, 0, 0);
  const initial = makeManager({ now, store });
  await initial.manager.start();
  await initial.manager.setRoot(root);

  const restarted = makeManager({ now, store });
  const status = await restarted.manager.start();
  const yesterday = scheduledDestination(root, new Date(2026, 6, 16, 17, 0, 0, 0)).destination;
  assert.equal(restarted.calls.length, 0);
  assert.equal(fs.existsSync(yesterday), false);
  assert.equal(status.lastSuccess.kind, 'manual');
  assert.equal(status.nextRunKind, 'scheduled');
});

test('reselecting the same configured folder catches up a missing due backup', async () => {
  const root = makeTempRoot();
  const context = makeManager({
    now: new Date(2026, 6, 18, 18, 0, 0, 0),
    store: makeStore({ [BACKUP_ROOT_SETTING]: root }),
  });
  await context.manager.start();
  const firstDuePath = context.manager.getStatus().lastSuccess.path;
  fs.unlinkSync(firstDuePath);
  context.calls.length = 0;

  await context.manager.setRoot(root);
  assert.equal(context.calls.length, 1);
  assert.equal(context.manager.getStatus().lastSuccess.kind, 'scheduled');
  assert.ok(fs.existsSync(context.manager.getStatus().lastSuccess.path));
});

test('restart before 5 PM catches up the most recent missed 5 PM backup once', async () => {
  const root = makeTempRoot();
  const store = makeStore({ [BACKUP_ROOT_SETTING]: root });
  const now = new Date(2026, 6, 18, 9, 0, 0, 0);
  const first = makeManager({ now, store });

  const firstStatus = await first.manager.start();
  const expected = scheduledDestination(root, new Date(2026, 6, 17, 17, 0, 0, 0)).destination;
  assert.equal(first.calls.length, 1);
  assert.equal(firstStatus.lastSuccess.path, expected);
  assert.ok(fs.existsSync(expected));

  const second = makeManager({ now, store });
  const secondStatus = await second.manager.start();
  assert.equal(second.calls.length, 0, 'an existing scheduled file must not be duplicated');
  assert.equal(secondStatus.nextRunKind, 'scheduled');
  assert.equal(new Date(secondStatus.nextScheduledAt).getTime(), new Date(2026, 6, 18, 17, 0, 0, 0).getTime());
});

test('restart after 5 PM catches up today instead of manufacturing older snapshots', async () => {
  const root = makeTempRoot();
  const context = makeManager({
    now: new Date(2026, 6, 20, 20, 15, 0, 0),
    store: makeStore({ [BACKUP_ROOT_SETTING]: root }),
  });

  const status = await context.manager.start();
  assert.equal(context.calls.length, 1);
  assert.equal(status.lastSuccess.scheduledDate, '2026-07-20');
  assert.equal(path.dirname(status.lastSuccess.path), path.join(root, '2026', '07'));
});

test('a failed scheduled run retries in 15 minutes, then resumes the daily schedule', async () => {
  const root = makeTempRoot();
  const yesterday = new Date(2026, 6, 17, 17, 0, 0, 0);
  const yesterdayPath = scheduledDestination(root, yesterday);
  fs.mkdirSync(yesterdayPath.directory, { recursive: true });
  fs.writeFileSync(yesterdayPath.destination, 'existing backup');

  let now = new Date(2026, 6, 18, 16, 59, 0, 0);
  let attempts = 0;
  const timers = makeTimers();
  const context = makeManager({
    now,
    timers,
    store: makeStore({ [BACKUP_ROOT_SETTING]: root }),
    backupDatabase: async (_database, destination) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary drive failure');
      fs.writeFileSync(destination, 'retry succeeded');
    },
  });
  context.setNow(now);
  await context.manager.start();
  const fivePmTimer = timers.calls.at(-1);
  assert.equal(fivePmTimer.delay, 60 * 1000);

  now = new Date(2026, 6, 18, 17, 0, 0, 0);
  context.setNow(now);
  fivePmTimer.callback();
  await flushPromises();
  const retryTimer = timers.calls.at(-1);
  assert.equal(retryTimer.delay, FAILED_BACKUP_RETRY_MS);
  assert.equal(context.manager.getStatus().nextRunKind, 'retry');
  assert.equal(context.manager.getStatus().lastError.kind, 'scheduled');

  now = new Date(2026, 6, 18, 17, 15, 0, 0);
  context.setNow(now);
  retryTimer.callback();
  await flushPromises();
  const status = context.manager.getStatus();
  assert.equal(attempts, 2);
  assert.equal(status.lastError, null);
  assert.equal(status.lastSuccess.scheduledDate, '2026-07-18');
  assert.equal(status.nextRunKind, 'scheduled');
});

test('failed backup removes its temporary file and reports the error', async () => {
  const root = makeTempRoot();
  const due = latestDueScheduledTime(new Date(2026, 6, 18, 9, 0, 0, 0));
  const existing = scheduledDestination(root, due);
  fs.mkdirSync(existing.directory, { recursive: true });
  fs.writeFileSync(existing.destination, 'existing backup');
  const context = makeManager({
    now: new Date(2026, 6, 18, 9, 0, 0, 0),
    store: makeStore({ [BACKUP_ROOT_SETTING]: root }),
    backupDatabase: async (_database, destination) => {
      fs.writeFileSync(destination, 'partial backup');
      throw new Error('simulated copy failure');
    },
  });
  await context.manager.start();

  await assert.rejects(context.manager.runNow(), /simulated copy failure/);
  const files = fs.readdirSync(path.join(root, '2026', '07'));
  assert.equal(files.some((name) => name.endsWith('.tmp')), false);
  assert.equal(context.manager.getStatus().lastError.message, 'simulated copy failure');
});

test('native chooser uses a fixed PowerShell invocation without request interpolation', async () => {
  const chosenRoot = makeTempRoot();
  let invocation = null;
  const spawnFn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.write(chosenRoot);
      child.emit('close', 0);
    });
    return child;
  };

  const result = await chooseWindowsBackupFolder({ platform: 'win32', spawnFn, timeoutMs: 1000 });
  assert.deepEqual(result, { cancelled: false, path: path.resolve(chosenRoot) });
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes('-STA'), true);
  assert.equal(invocation.args.includes('-Command'), true);
  assert.equal(invocation.args.some((argument) => argument.includes(chosenRoot)), false);
  const chooserScript = invocation.args[invocation.args.indexOf('-Command') + 1];
  assert.match(chooserScript, /TopMost\s*=\s*\$true/);
  assert.match(chooserScript, /ShowDialog\(\$owner\)/);
});

test('native chooser reports a clear unsupported result outside Windows', async () => {
  await assert.rejects(
    chooseWindowsBackupFolder({ platform: 'linux' }),
    (error) => error.code === 'FOLDER_CHOOSER_UNSUPPORTED',
  );
});
