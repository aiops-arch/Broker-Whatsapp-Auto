// Pure, DOM-free string helpers shared by app.js's Edit-draft modal and
// node:test - loaded as a plain global-scope script before app.js (classic
// script tags, no bundler/module loader in this app), and required directly
// by tests via the module.exports guard below, which is a no-op in the
// browser since `module` is never defined there.

function withPatchedGreeting(message, brokerName) {
  const lines = String(message).split('\n');
  if (/^Dear .*,$/.test(lines[0])) {
    lines[0] = `Dear ${brokerName},`;
    return lines.join('\n');
  }
  return message; // first line isn't a recognizable greeting - leave custom wording alone
}

function withPatchedSignature(message, buyerName) {
  const lines = String(message).split('\n');
  let signatureLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === 'Regards,') { signatureLine = i; break; }
  }
  if (signatureLine === -1) return message; // no recognizable signature block - leave custom wording alone
  const before = lines.slice(0, signatureLine);
  while (before.length && before[before.length - 1] === '') before.pop();
  return buyerName ? [...before, '', 'Regards,', buyerName].join('\n') : before.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { withPatchedGreeting, withPatchedSignature };
}
