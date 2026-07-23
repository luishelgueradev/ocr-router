const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getPageTexts, sufficient } = require('../lib/v1/input/pdf-text');
const { CAPS } = require('../lib/v1/input/caps');

// INP-03 / D-01 / Pattern 3 — native per-page embedded-text extraction + the
// native-vs-scanned sufficiency threshold. unpdf is pure JS/WASM (bundled
// serverless PDF.js) so these tests run it FOR REAL on the host — no poppler,
// no stub. A real 2-page text-bearing PDF fixture proves per-page order + text;
// the sufficient() cases lock the floor that stops a stray-glyph scanned page
// from falsely short-circuiting the OCR the product promises (Pitfall 3).

const FIXTURE = path.join(__dirname, 'fixtures', 'native-sample.pdf');

test('getPageTexts: returns one entry per page, order preserved, real unpdf', async () => {
  const buf = fs.readFileSync(FIXTURE);
  const texts = await getPageTexts(buf);

  assert.ok(Array.isArray(texts), 'resolves a string[]');
  assert.equal(texts.length, 2, 'one entry per page (2-page fixture)');
  assert.match(texts[0], /native PDF fixture page one/, 'page 1 text');
  assert.match(texts[1], /Second page/, 'page 2 text');
  // Page order preserved: the "one" sentence precedes the "Second" sentence.
  assert.ok(
    texts[0].includes('page one') && texts[1].includes('Second page'),
    'page order preserved',
  );
});

test('sufficient: empty and whitespace-only text is NOT native', () => {
  assert.equal(sufficient(''), false, 'empty string → false');
  assert.equal(sufficient('   '), false, 'whitespace-only → false');
  assert.equal(sufficient('\n\t  \n'), false, 'newlines/tabs → false');
  assert.equal(sufficient(null), false, 'null → false');
  assert.equal(sufficient(undefined), false, 'undefined → false');
});

test('sufficient: a short stray-glyph string below the floor is NOT native', () => {
  // A handful of chars — a scanned page number / stray ligature — must fail the
  // MIN_NATIVE_CHARS floor so it rasterizes instead of skipping OCR.
  assert.ok('ab cd'.trim().length < CAPS.MIN_NATIVE_CHARS, 'sanity: below floor');
  assert.equal(sufficient('ab cd'), false, 'short word-bearing string → false');
});

test('sufficient: a real sentence at/above the floor IS native', () => {
  const sentence = 'This is a real sentence with words.';
  assert.ok(sentence.trim().length >= CAPS.MIN_NATIVE_CHARS, 'sanity: clears floor');
  assert.equal(sufficient(sentence), true, 'real sentence → true');
});

test('sufficient: 16+ chars of punctuation/digits with no word token is NOT native', () => {
  // Clears the length floor but has zero \p{L}{2,} word tokens → must be false,
  // otherwise a page of stray digits/symbols would falsely skip OCR.
  const noWords = '1234567890 .,;:!?-';
  assert.ok(noWords.trim().length >= CAPS.MIN_NATIVE_CHARS, 'sanity: clears length floor');
  assert.equal(sufficient(noWords), false, 'no word-like token → false');
});

test('sufficient: honors an explicit min override', () => {
  const s = 'short';
  assert.equal(sufficient(s, 3), true, 'clears a lowered floor with a word token');
  assert.equal(sufficient(s, 100), false, 'fails a raised floor');
});
