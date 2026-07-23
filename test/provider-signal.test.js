// Provider-layer abort propagation + ocr.space overlay-shape proofs (JOB-04,
// CASC-03). Pure unit tests: NO network, NO keys. global.fetch is stubbed for
// ocr.space; axios.post is monkey-patched via require.cache for ollama. Each
// stub is scoped and restored with t.after so the tiny surface never leaks.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runOcrSpace } = require('../lib/providers/ocrspace');

// ---------------------------------------------------------------------------
// ocr.space: stub global.fetch with a fake ocr.space JSON body.
// ---------------------------------------------------------------------------

function fakeFetchResolving(body, { status = 200, ok = true } = {}) {
  return async () => ({ ok, status, json: async () => body });
}

test('ocr.space: overlay word-count + HasOverlay + ocrExitCode are extracted, no raw geometry', async (t) => {
  const N = 5;
  const words = Array.from({ length: N }, (_, i) => ({
    WordText: `w${i}`, Left: i, Top: i, Height: 10, Width: 10,
  }));
  const originalFetch = global.fetch;
  global.fetch = fakeFetchResolving({
    IsErroredOnProcessing: false,
    OCRExitCode: 1,
    ParsedResults: [
      {
        ParsedText: 'hello world foo bar baz',
        TextOverlay: { HasOverlay: true, Lines: [{ Words: words }] },
      },
    ],
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await runOcrSpace(2, 'spa', 'YmFzZTY0', 'image/png', 'fake-key');

  assert.equal(res.ok, true, 'success path is ok:true');
  assert.equal(res.text, 'hello world foo bar baz');
  assert.ok(res.overlay, 'overlay object present');
  assert.equal(res.overlay.wordCount, N, 'overlay.wordCount === mocked word count');
  assert.equal(res.overlay.HasOverlay, true, 'overlay.HasOverlay reflects the body');
  assert.equal(res.ocrExitCode, 1, 'ocrExitCode surfaced for the runner');

  // No raw geometry leaked into the public return object.
  const keys = JSON.stringify(res);
  assert.ok(!/"Left"|"Top"|"WordText"|"Words"/.test(keys), 'no raw geometry keys in return');
});

test('ocr.space: OCRExitCode 3 (all pages failed) is returned so the runner can branch', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = fakeFetchResolving({
    IsErroredOnProcessing: false,
    OCRExitCode: 3,
    ParsedResults: [{ ParsedText: '', TextOverlay: { HasOverlay: false, Lines: [] } }],
  });
  t.after(() => { global.fetch = originalFetch; });

  const res = await runOcrSpace(2, 'spa', 'YmFzZTY0', 'image/png', 'fake-key');
  assert.equal(res.ok, true, 'ok:true even though every page failed');
  assert.equal(res.ocrExitCode, 3, 'ocrExitCode 3 surfaced — runner treats it as a hard failure');
});

test('ocr.space: an aborted fetch resolves to ok:false (fall-through), never throws', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
  t.after(() => { global.fetch = originalFetch; });

  const ac = new AbortController();
  ac.abort();
  const res = await runOcrSpace(2, 'spa', 'YmFzZTY0', 'image/png', 'fake-key', { signal: ac.signal });
  assert.equal(res.ok, false, 'aborted fetch → ok:false, not a thrown crash');
  assert.equal(typeof res.error, 'string', 'error normalized to a string');
});

// ---------------------------------------------------------------------------
// ollama: monkey-patch axios.post via require.cache so no real request escapes.
// ollama.js does `const axios = require('axios')` and calls `axios.post(...)`.
// ---------------------------------------------------------------------------

test('ollama: an ERR_CANCELED abort resolves to ok:false with a non-crashing error string', async (t) => {
  const axiosPath = require.resolve('axios');
  const axios = require(axiosPath);
  const originalPost = axios.post;
  axios.post = async () => {
    const err = new Error('canceled');
    err.code = 'ERR_CANCELED';
    err.name = 'CanceledError';
    throw err;
  };
  t.after(() => { axios.post = originalPost; });

  const { runOllama } = require('../lib/providers/ollama');
  const ac = new AbortController();
  ac.abort();
  const res = await runOllama('qwen3-vl:235b-cloud', 'YmFzZTY0', 'fake-key', { signal: ac.signal });

  assert.equal(res.ok, false, 'aborted axios call → ok:false fall-through');
  assert.equal(typeof res.error, 'string', 'error is a normalized string');
  assert.ok(res.error.length > 0, 'error is non-empty (runner can log it)');
});
