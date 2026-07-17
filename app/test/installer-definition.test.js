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
