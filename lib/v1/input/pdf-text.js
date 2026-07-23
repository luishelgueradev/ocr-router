// INP-03 / D-01 / Pattern 3 — native PDF text: the cheap fast path.
//
// A digital PDF already carries selectable text per page; extracting it with
// `unpdf` (bundled serverless PDF.js — pure JS/WASM, no native deps, no Node
// floor) lets a text-bearing page short-circuit OCR entirely: the caller
// records `engine:'pdf-native'`, high confidence, and NEVER calls the cascade.
//
// The single subtle risk is a FALSE POSITIVE (Pitfall 3 / T-03-09): a scanned
// page that happens to carry a stray glyph or a page-number text layer would,
// under a naive `length > 0` test, be judged "native" and wrongly skip the OCR
// the product promises. So `sufficient()` is a real floor — MIN_NATIVE_CHARS of
// content AND at least one word-like token — not merely non-empty. When in
// doubt the page is treated as scanned and rasterized (D-02).
//
// unpdf is ESM-only, so it is loaded via a dynamic `import()` from this CJS
// module (safe even if it also shipped CJS — A7).

const { CAPS } = require('./caps');

// A "word-like" token: two or more consecutive letters in ANY script (Unicode
// property escape). Digits/punctuation alone never satisfy it, so a page of
// stray numbers/symbols cannot masquerade as native text. Module-level so the
// regex is compiled once.
const WORD = /\p{L}{2,}/u;

/**
 * Extract embedded text for every page of a PDF, in page order.
 *
 * Runs `unpdf` (real PDF.js) in-process — no subprocess, no poppler. Pages with
 * no embedded text come back as empty/near-empty strings (the caller then
 * rasterizes them). `mergePages:false` keeps the per-page array so mixed PDFs
 * (some native, some scanned) are decided page-by-page.
 *
 * @param {Buffer|Uint8Array} pdfBuffer - the raw PDF bytes
 * @returns {Promise<string[]>} one text entry per page, order preserved
 */
async function getPageTexts(pdfBuffer) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

/**
 * Decide whether a page's extracted text is "native enough" to skip OCR.
 *
 * Requires BOTH a meaningful length floor (defends against stray glyphs) AND a
 * word-like token (defends against a length-passing run of digits/punctuation).
 * The default floor comes from caps.js so it stays boot-validated + env-tunable
 * (`MIN_NATIVE_CHARS`).
 *
 * @param {string} t - a page's extracted text
 * @param {number} [min=CAPS.MIN_NATIVE_CHARS] - minimum trimmed chars
 * @returns {boolean} true → take as native (no OCR); false → treat as scanned
 */
function sufficient(t, min = CAPS.MIN_NATIVE_CHARS) {
  const s = (t || '').trim();
  return s.length >= min && WORD.test(s);
}

module.exports = { getPageTexts, sufficient };
