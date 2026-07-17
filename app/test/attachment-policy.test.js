const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ATTACHMENT_TYPES,
  resolveAttachmentFile,
  validateStoredAttachmentPath,
} = require('../src/attachmentPolicy');

test('Excel attachment names are basenames inside the attachment directory', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-attachments-'));
  const root = path.join(sandbox, 'attachments');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const safePath = path.join(root, 'demand.JPG');
  fs.writeFileSync(safePath, Buffer.from('image'));

  const safe = resolveAttachmentFile('demand.JPG', root);
  assert.equal(safe.ok, true);
  assert.equal(safe.path, fs.realpathSync(safePath));
  assert.equal(safe.mimeType, 'image/jpeg');

  for (const unsafeName of [
    '../outside.pdf',
    '..\\outside.pdf',
    'nested/file.pdf',
    'nested\\file.pdf',
    path.resolve(sandbox, 'outside.pdf'),
  ]) {
    const result = resolveAttachmentFile(unsafeName, root);
    assert.equal(result.ok, false, unsafeName);
    assert.equal(result.code, 'UNSAFE_ATTACHMENT_NAME', unsafeName);
  }

  assert.equal(validateStoredAttachmentPath(path.join(sandbox, 'outside.pdf'), root).ok, false);
});

test('unsupported, missing, non-file, and oversized attachments are rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-attachment-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, 'payload.exe'), Buffer.from('x'));
  assert.equal(resolveAttachmentFile('payload.exe', root).code, 'UNSUPPORTED_ATTACHMENT_TYPE');
  assert.equal(resolveAttachmentFile('missing.pdf', root).code, 'ATTACHMENT_NOT_FOUND');

  fs.mkdirSync(path.join(root, 'folder.pdf'));
  assert.equal(resolveAttachmentFile('folder.pdf', root).code, 'ATTACHMENT_NOT_FILE');

  const tooLarge = path.join(root, 'oversize.jpg');
  fs.writeFileSync(tooLarge, Buffer.alloc(0));
  fs.truncateSync(tooLarge, ATTACHMENT_TYPES['.jpg'].maxBytes + 1);
  assert.equal(resolveAttachmentFile('oversize.jpg', root).code, 'ATTACHMENT_TOO_LARGE');
});
