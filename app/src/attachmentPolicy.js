const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024 * 1024;

// Keep this deliberately narrower than "anything WhatsApp might accept".
// These are the media types both providers in this app know how to send.
const ATTACHMENT_TYPES = Object.freeze({
  '.jpg': { mimeType: 'image/jpeg', mediaType: 'image', maxBytes: 5 * MIB },
  '.jpeg': { mimeType: 'image/jpeg', mediaType: 'image', maxBytes: 5 * MIB },
  '.png': { mimeType: 'image/png', mediaType: 'image', maxBytes: 5 * MIB },
  '.webp': { mimeType: 'image/webp', mediaType: 'image', maxBytes: 5 * MIB },
  '.mp4': { mimeType: 'video/mp4', mediaType: 'video', maxBytes: 16 * MIB },
  '.3gp': { mimeType: 'video/3gpp', mediaType: 'video', maxBytes: 16 * MIB },
  '.pdf': { mimeType: 'application/pdf', mediaType: 'document', maxBytes: 100 * MIB },
});

function failure(code, error) {
  return { ok: false, code, error };
}

function policyForPath(filePath) {
  return ATTACHMENT_TYPES[path.extname(String(filePath || '')).toLowerCase()] || null;
}

function validateAttachmentPath(filePath) {
  const policy = policyForPath(filePath);
  if (!policy) {
    return failure('UNSUPPORTED_ATTACHMENT_TYPE', 'Attachment rejected: use JPG, JPEG, PNG, WEBP, MP4, 3GP, or PDF only.');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    return failure('ATTACHMENT_NOT_FOUND', 'Attachment rejected: the named file was not found in the Attachments folder.');
  }

  if (!stat.isFile()) {
    return failure('ATTACHMENT_NOT_FILE', 'Attachment rejected: the attachment must be a regular file.');
  }
  if (stat.size > policy.maxBytes) {
    const maxMb = Math.round(policy.maxBytes / MIB);
    return failure('ATTACHMENT_TOO_LARGE', `Attachment rejected: ${path.extname(filePath).slice(1).toUpperCase()} files must be ${maxMb} MB or smaller.`);
  }

  return {
    ok: true,
    path: path.resolve(filePath),
    size: stat.size,
    ...policy,
  };
}

function isPlainBasename(fileName) {
  if (!fileName || fileName === '.' || fileName === '..') return false;
  // Check both separator styles even when tests/builds run on a non-Windows
  // host; production filenames come from an Excel cell, not the filesystem.
  if (/[\\/]/.test(fileName)) return false;
  return path.win32.basename(fileName) === fileName && path.posix.basename(fileName) === fileName;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Resolves an untrusted Excel cell. Folder components, absolute paths,
// unsupported media, symlink escapes, directories, and oversize files all
// fail closed. The returned path is always a real file inside attachmentsRoot.
function resolveAttachmentFile(rawFileName, attachmentsRoot) {
  const fileName = String(rawFileName || '').trim();
  if (!isPlainBasename(fileName)) {
    return failure('UNSAFE_ATTACHMENT_NAME', 'Attachment rejected: enter a filename only, without a folder or path.');
  }

  const root = path.resolve(attachmentsRoot);
  const candidate = path.resolve(root, fileName);
  if (!isWithinRoot(candidate, root)) {
    return failure('ATTACHMENT_OUTSIDE_FOLDER', 'Attachment rejected: the file must stay inside the Attachments folder.');
  }

  let realRoot;
  let realCandidate;
  try {
    realRoot = fs.realpathSync(root);
    realCandidate = fs.realpathSync(candidate);
  } catch (error) {
    return failure('ATTACHMENT_NOT_FOUND', 'Attachment rejected: the named file was not found in the Attachments folder.');
  }
  if (!isWithinRoot(realCandidate, realRoot)) {
    return failure('ATTACHMENT_OUTSIDE_FOLDER', 'Attachment rejected: the file must stay inside the Attachments folder.');
  }

  return validateAttachmentPath(realCandidate);
}

// Re-check a database path immediately before a send. This protects older DB
// rows and catches a file that was replaced or enlarged after Excel import.
function validateStoredAttachmentPath(filePath, attachmentsRoot) {
  if (!filePath) return { ok: true, path: null };
  const provided = path.resolve(String(filePath));
  const expected = path.resolve(attachmentsRoot, path.basename(provided));
  if (provided !== expected) {
    return failure('ATTACHMENT_OUTSIDE_FOLDER', 'Attachment blocked: its stored path is outside the Attachments folder.');
  }
  return resolveAttachmentFile(path.basename(provided), attachmentsRoot);
}

module.exports = {
  ATTACHMENT_TYPES,
  policyForPath,
  validateAttachmentPath,
  resolveAttachmentFile,
  validateStoredAttachmentPath,
};
