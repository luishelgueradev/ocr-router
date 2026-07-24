const { test } = require('node:test');
const assert = require('node:assert/strict');

// Monkey-patch runOCR on lib/ocr BEFORE requiring the worker so the success-path
// test drives a deterministic result envelope without a real provider call.
// worker.js destructures `const { runOCR } = require('../ocr')` at load time, so
// the patch must be applied to the cached exports object first. Mirrors the
// require.cache technique in test/worker-logging.test.js.
const ocrPath = require.resolve('../lib/ocr');
require(ocrPath); // ensure cached
const originalRunOCR = require.cache[ocrPath].exports.runOCR;
let fakeRunOCRImpl = null;
require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  if (fakeRunOCRImpl) return fakeRunOCRImpl(model, base64, mime, key, opts);
  return { ok: true, timeMs: 1, text: 'fake-text' };
};
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
});

const jobs = require('../lib/v1/jobs');
const { runJob } = require('../lib/v1/worker');

// D-04 success path: runJob wraps a single OCR result into the page-aware
// envelope. Asserts jobs.complete produced result.pages[0] (page:1, engine,
// confidence:null) plus a top-level result.text joined from the pages, and the
// terminal status is `succeeded` (D-03).
test('D-04: runJob success path produces the page-aware envelope (result.pages[0] + result.text)', async (t) => {
  fakeRunOCRImpl = async () => ({ ok: true, timeMs: 21, text: 'extracted page text' });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-success-envelope-' + Date.now();
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  const fakeModel = { id: 'ollama-qwen35-397b', provider: 'ollama', modes_supported: ['quality'] };
  await runJob(jobId, {
    model: fakeModel,
    buffer: Buffer.alloc(64, 0x41),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'unused',
    preset: undefined,
    requestId: 'req-envelope',
  });

  const done = jobs.get(jobId);
  assert.equal(done.status, 'succeeded', 'terminal status must be succeeded (D-03)');
  assert.ok(Array.isArray(done.result.pages), 'result.pages must be an array (D-04 envelope)');
  assert.equal(done.result.pages.length, 1, 'single image ⇒ one-element pages[]');

  const page = done.result.pages[0];
  assert.equal(page.page, 1, 'pages[0].page must be 1');
  assert.equal(page.text, 'extracted page text', 'pages[0].text carries the OCR text');
  assert.equal(page.engine, 'ollama-qwen35-397b', 'pages[0].engine records the engine id');
  // Phase 2 (D-11 forced bypass): driving runJob with an explicit model now
  // exercises the forced-bypass path, which COMPUTES a confidence for the
  // winning engine — the Phase-1 `null` assertion is intentionally updated.
  assert.equal(typeof page.confidence, 'number', 'pages[0].confidence is a computed number on the winning path');
  assert.ok(page.confidence >= 0 && page.confidence <= 1, 'pages[0].confidence stays within [0,1]');

  // Top-level text === pages joined by '\n\n' (== pages[0].text for one page).
  assert.equal(done.result.text, 'extracted page text', 'result.text is the joined page text');
});

// Regression (UAT-3): runJob MUST early-return when the job is already finalized.
// Defense in depth for the shutdown race: bottleneck.stop({dropWaitingJobs:true})
// drops queued jobs, but a job already pulled into bottleneck's "executing" slot
// before stop() ran can still arrive at runJob with finalized: true. Without
// this guard, the worker called the provider (real Ollama API spend) and then
// emitted "job complete" even though jobs.complete is a no-op on finalized
// jobs — making the operator think the job ran to completion when its real
// terminal state was failed{shutdown_cancelled}.
test('runJob: early-returns when job is already finalized (UAT-3 regression)', async (t) => {
  const jobId = 'worker-early-return-' + Date.now();
  jobs.create(jobId, { model_id: 'test' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  // Simulate drainAndCancel finalizing the job before bottleneck pulls it.
  jobs.fail(jobId, { code: 'shutdown_cancelled', message: 'pre-finalized by drain' });
  const before = jobs.get(jobId);
  assert.equal(before.status, 'failed');
  assert.equal(before.finalized, true);

  // Throw if runOCR is reached — proves runJob exited before any provider work.
  const fakeModel = { id: 'fake', provider: 'fake', modes_supported: ['quality'] };
  await assert.doesNotReject(
    runJob(jobId, {
      model: fakeModel,
      buffer: Buffer.from([0]),
      mimeType: 'image/png',
      mode: 'quality',
      apiKey: 'unused',
      preset: undefined,
      requestId: 'req-test',
    }),
    'runJob must early-return without throwing'
  );

  // State must remain the pre-finalized terminal state.
  const after = jobs.get(jobId);
  assert.equal(after.status, 'failed', 'status untouched');
  assert.equal(after.error.code, 'shutdown_cancelled', 'error.code preserved');
  // setProcessing was NOT called, so started_at must NOT be set by runJob.
  assert.equal(after.started_at, undefined, 'started_at must not be set when runJob early-returns');
});

test('runJob: early-returns when job does not exist in store (defensive)', async (t) => {
  // No jobs.create — store has no entry for this id.
  const fakeModel = { id: 'fake', provider: 'fake', modes_supported: ['quality'] };
  await assert.doesNotReject(
    runJob('nonexistent-' + Date.now(), {
      model: fakeModel,
      buffer: Buffer.from([0]),
      mimeType: 'image/png',
      mode: 'quality',
      apiKey: 'unused',
      preset: undefined,
      requestId: 'req-test',
    }),
    'runJob must early-return without throwing for unknown ids'
  );
});
