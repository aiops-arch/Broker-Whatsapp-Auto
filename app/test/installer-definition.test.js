const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('installer exclusions are root-anchored and preserve runtime dependencies', () => {
  const setupPath = path.resolve(__dirname, '..', '..', 'installer', 'setup.iss');
  const setup = fs.readFileSync(setupPath, 'utf8');
  const filesEntry = setup.split(/\r?\n/).find((line) => (
    line.includes('Source: "..\\app\\*"') && line.includes('Excludes:')
  ));

  assert.ok(filesEntry, 'application [Files] entry is missing');
  for (const directory of [
    'data',
    'incoming',
    'processed',
    'attachments',
    'failed-imports',
    '.wwebjs_auth',
    '.wwebjs_cache',
    'test',
    'coverage',
    'tmp',
    '.playwright-cli',
  ]) {
    assert.ok(
      filesEntry.includes(`\\${directory}\\*`),
      `${directory} must be excluded only at the app source root`,
    );
  }

  const tmpDependency = path.resolve(__dirname, '..', 'node_modules', 'tmp', 'package.json');
  assert.equal(fs.existsSync(tmpDependency), true, 'exceljs runtime dependency node_modules/tmp is missing');
});

test('uninstall offers to remove exactly the same local data folders the installer excludes from tracking', () => {
  const setupPath = path.resolve(__dirname, '..', '..', 'installer', 'setup.iss');
  const setup = fs.readFileSync(setupPath, 'utf8');

  // Only usPostUninstall may trigger this - a version-to-version upgrade
  // never calls the uninstaller at all (LIFE-002), so this can never fire
  // outside an explicit, full uninstall.
  assert.match(setup, /CurUninstallStepChanged/);
  assert.match(setup, /CurUninstallStep\s*=\s*usPostUninstall/);
  assert.match(setup, /MB_YESNO/);

  for (const directory of [
    'data', 'incoming', 'processed', 'attachments', 'failed-imports', '.wwebjs_auth', '.wwebjs_cache',
  ]) {
    assert.ok(
      setup.includes(`{app}\\${directory}'`),
      `uninstall cleanup must cover the same excluded folder: ${directory}`,
    );
  }
});
