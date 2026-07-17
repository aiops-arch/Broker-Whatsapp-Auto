const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const multer = require('multer');

const { UPLOAD_LIMITS, validateUploadFileName } = require('../src/importFiles');

async function withUploadServer(t) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-upload-multipart-test-'));
  const upload = multer({
    dest: staging,
    limits: UPLOAD_LIMITS,
    fileFilter: (_req, file, callback) => {
      const validation = validateUploadFileName(file.originalname);
      callback(validation.ok ? null : validation.error, validation.ok);
    },
  });
  const app = express();
  app.post('/upload', (req, res) => {
    upload.single('file')(req, res, (error) => {
      if (error) return res.status(400).json({ code: error.code || 'UPLOAD_REJECTED' });
      if (!req.file) return res.status(400).json({ code: 'FILE_REQUIRED' });
      return res.json({ ok: true, originalName: req.file.originalname });
    });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(staging, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}/upload`;
}

test('a browser-style multipart request accepts one xlsx file', async (t) => {
  const url = await withUploadServer(t);
  const form = new FormData();
  form.append('file', new Blob(['workbook-bytes']), 'Demand.XLSX');

  const response = await fetch(url, { method: 'POST', body: form });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, originalName: 'Demand.XLSX' });
});

test('multipart upload still rejects extra form content', async (t) => {
  const url = await withUploadServer(t);
  const form = new FormData();
  form.append('file', new Blob(['workbook-bytes']), 'Demand.xlsx');
  form.append('unexpected', 'extra');

  const response = await fetch(url, { method: 'POST', body: form });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.code, /^LIMIT_(FIELD|PART)_COUNT$/);
});
