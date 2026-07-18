const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const multer = require('multer');

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-config-routes-test-db-'));
process.env.BROKER_APP_DATA_DIR = isolatedDataDir;

const db = require('../src/db');
const messageConfig = require('../src/messageConfig');
const { createConfigRouter } = require('../src/configRoutes');
const { UPLOAD_LIMITS, validateUploadFileName } = require('../src/importFiles');

test.before(async () => {
  await db.init();
});

async function withConfigServer(t) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-config-routes-upload-'));
  const upload = multer({
    dest: staging,
    limits: UPLOAD_LIMITS,
    fileFilter: (_req, file, callback) => {
      const validation = validateUploadFileName(file.originalname);
      callback(validation.ok ? null : validation.error, validation.ok);
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/config', createConfigRouter({ upload, fs }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(staging, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}/api/config`;
}

test('GET /mapping returns the default field mapping', async (t) => {
  const base = await withConfigServer(t);
  const response = await fetch(`${base}/mapping`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.fields.length, messageConfig.getDefaultFieldMapping().length);
});

test('GET /mapping/default and /template/default return read-only defaults without persisting', async (t) => {
  const base = await withConfigServer(t);
  const beforeMapping = await db.getSetting('field_mapping_config_v1');
  const beforeTemplate = await db.getSetting('message_template_config_v1');

  const mappingResponse = await fetch(`${base}/mapping/default`);
  const mappingBody = await mappingResponse.json();
  assert.equal(mappingResponse.status, 200);
  assert.equal(mappingBody.fields.length, messageConfig.getDefaultFieldMapping().length);

  const templateResponse = await fetch(`${base}/template/default`);
  const templateBody = await templateResponse.json();
  assert.equal(templateResponse.status, 200);
  assert.equal(templateBody.headerTemplate, messageConfig.getDefaultMessageTemplate().headerTemplate);

  assert.equal(await db.getSetting('field_mapping_config_v1'), beforeMapping);
  assert.equal(await db.getSetting('message_template_config_v1'), beforeTemplate);
});

test('PUT /mapping rejects an invalid mapping with field errors', async (t) => {
  const base = await withConfigServer(t);
  const invalid = messageConfig.getDefaultFieldMapping().map((f) => (f.role === 'broker_name' ? { ...f, role: 'ignore' } : f));
  const response = await fetch(`${base}/mapping`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: invalid }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_FIELD_MAPPING');
  assert.ok(Array.isArray(body.fieldErrors) && body.fieldErrors.length > 0);
});

test('PUT /mapping accepts a valid custom mapping and GET reflects it', async (t) => {
  const base = await withConfigServer(t);
  const custom = [
    { key: 'agent', label: 'Agent', sourceHeader: 'Agent', role: 'broker_name', requiredHeader: true, requiredRow: false },
    {
      key: 'client', label: 'Client', sourceHeader: 'Client', role: 'group',
      requiredHeader: true, requiredRow: true, primaryGroupField: true,
    },
  ];
  const putResponse = await fetch(`${base}/mapping`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: custom }),
  });
  assert.equal(putResponse.status, 200);

  const getResponse = await fetch(`${base}/mapping`);
  const body = await getResponse.json();
  assert.equal(body.fields.length, 2);

  t.after(async () => {
    await messageConfig.setFieldMapping(messageConfig.getDefaultFieldMapping());
  });
});

test('PUT /template rejects a template with an unknown placeholder', async (t) => {
  const base = await withConfigServer(t);
  const response = await fetch(`${base}/template`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...messageConfig.getDefaultMessageTemplate(), headerTemplate: 'Hi {{nope}} {{lineItems}}' }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'UNKNOWN_TEMPLATE_PLACEHOLDER');
});

test('POST /template/preview renders an illustrative message without saving', async (t) => {
  const base = await withConfigServer(t);
  const beforeRaw = await db.getSetting('message_template_config_v1');
  const response = await fetch(`${base}/template/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      headerTemplate: 'Hi {{brokerName}}! {{lineItems}}',
      lineItemTemplate: '{{index}}: {{stoneId}}',
      buyerLineTemplate: '',
      lineItemSeparator: '\n',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.message, /Hi Sample Broker!/);
  const afterRaw = await db.getSetting('message_template_config_v1');
  assert.equal(afterRaw, beforeRaw);
});

test('POST /detect-headers returns the header row of an uploaded sample workbook', async (t) => {
  const base = await withConfigServer(t);
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Demand');
  sheet.addRow(['Agent Name', 'Mobile', 'Client']);
  sheet.addRow(['Rahul', '9998887771', 'Acme Co']);
  const buffer = await workbook.xlsx.writeBuffer();

  const form = new FormData();
  form.append('file', new Blob([buffer]), 'sample.xlsx');
  const response = await fetch(`${base}/detect-headers`, { method: 'POST', body: form });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.headers, ['Agent Name', 'Mobile', 'Client']);
});

test('GET/PUT /onboarding round-trip the completion flag', async (t) => {
  const base = await withConfigServer(t);
  const initial = await (await fetch(`${base}/onboarding`)).json();
  assert.equal(initial.completed, false);

  const putResponse = await fetch(`${base}/onboarding`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ completed: true }),
  });
  const putBody = await putResponse.json();
  assert.equal(putBody.completed, true);

  const after = await (await fetch(`${base}/onboarding`)).json();
  assert.equal(after.completed, true);
});

test('GET/PUT /auto-send round-trip the toggle, off by default', async (t) => {
  const base = await withConfigServer(t);
  const initial = await (await fetch(`${base}/auto-send`)).json();
  assert.equal(initial.enabled, false);

  const putResponse = await fetch(`${base}/auto-send`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  const putBody = await putResponse.json();
  assert.equal(putBody.enabled, true);

  const after = await (await fetch(`${base}/auto-send`)).json();
  assert.equal(after.enabled, true);

  t.after(async () => {
    await messageConfig.setAutoSendEnabled(false);
  });
});
