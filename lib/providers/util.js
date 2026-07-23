// Safe stringify shared by provider adapters. Previously copy-pasted verbatim
// in ollama.js and ocrspace.js with drift risk (code review LR-01).
function toString(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

module.exports = { toString };
