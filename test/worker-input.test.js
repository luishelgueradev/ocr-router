// 03-06 / INP-03..08 — worker runInputJob dispatch. Drives the multi-page input
// path end-to-end on the host: the poppler seam is a fake spawnFn (D-11) and the
// Phase-2 cascade is monkey-patched to a deterministic runCascade, so NO real
// poppler and NO real provider run. Mirrors the worker-logging capture strategy:
// substitute lib/logger in require.cache and patch cascade/runner.runCascade
// BEFORE requiring the worker (which destructures runCascade at load time).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('stream');
const { EventEmitter } = require('node:events');
const pino = require('pino');

// --- logger substitution (before worker require) ---------------------------
const loggerPath = require.resolve('../lib/logger');
const originalLoggerExports = require(loggerPath);

const captured = [];
function clearLines() { captured.length = 0; }

const captureDest = new Writable({
  write(chunk, _, cb) {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      try { captured.push(JSON.parse(line)); } catch (_) { /* ignore */ }
    }
    cb();
  },
});
const fakeLogger = pino({ level: 'info', timestamp: pino.stdTimeFunctions.isoTime }, captureDest);
require.cache[loggerPath].exports = fakeLogger;

// --- cascade substitution (before worker require) --------------------------
// worker.js does `const { runCascade } = require('./cascade/runner')`, capturing
// the reference at load — so we replace it on the cached module FIRST.
const runnerPath = require.resolve('../lib/v1/cascade/runner');
require(runnerPath);
const originalRunCascade = require.cache[runnerPath].exports.runCascade;
let fakeCascadeImpl = null;
require.cache[runnerPath].exports.runCascade = async (opts) => {
  if (fakeCascadeImpl) return fakeCascadeImpl(opts);
  return {
    result: { text: 'ocr', engineId: 'ollama-x', provider: 'ollama', confidence: 0.9 },
    trace: { winning_engine: 'ollama-x', elapsed_ms: 5, low_confidence: false, stopped_reason: 'passed' },
  };
};

const jobs = require('../lib/v1/jobs');
const temp = require('../lib/v1/input/temp');
const { CAPS } = require('../lib/v1/input/caps');
const { runJob } = require('../lib/v1/worker');

process.on('beforeExit', () => {
  require.cache[runnerPath].exports.runCascade = originalRunCascade;
  require.cache[loggerPath].exports = originalLoggerExports;
});

function flush() { return new Promise((r) => setImmediate(r)); }

const FIX = path.join(__dirname, 'fixtures');
const TIFF = fs.readFileSync(path.join(FIX, 'multi-frame.tif')); // 3 frames
const NATIVE_PDF = fs.readFileSync(path.join(FIX, 'native-sample.pdf'));

// fake ChildProcess emitting "Pages: N" for pdfinfo, a fake PNG for pdftoppm.
function makePdfSpawn({ pages }) {
  return (cmd, args) => {
    const body = args[1];
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter();
    cp.stderr = new EventEmitter();
    cp.kill = () => {};
    queueMicrotask(() => {
      if (/pdfinfo/.test(body)) cp.stdout.emit('data', Buffer.from(`Pages: ${pages}\n`));
      else if (/pdftoppm/.test(body)) cp.stdout.emit('data', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      cp.emit('close', 0, null);
    });
    return cp;
  };
}

test('runInputJob: multi-page TIFF → pages[] envelope + status_rollup, temp cleaned', async (t) => {
  clearLines();
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  const jobId = 'input-tiff-' + Date.now();
  jobs.create(jobId, { model_id: 'cascade:balanced' });
  const buffer = TIFF;

  await runJob(jobId, {
    model: null,
    forced: false,
    profile: 'balanced',
    buffer,
    mimeType: 'image/tiff', // sniffedType
    mode: 'quality',
    apiKey: null,
    preset: undefined,
    requestId: 'input-req-1',
  });
  await flush();

  const job = jobs.get(jobId);
  assert.equal(job.status, 'succeeded', 'multi-page job succeeds');
  assert.equal(job.result.pages.length, 3, 'one page per TIFF frame');
  assert.deepEqual(job.result.pages.map((p) => p.page), [1, 2, 3], 'order preserved');
  assert.equal(job.result.status_rollup, 'completed', 'all frames succeeded');
  assert.equal(job.result.engine, 'ollama-x', 'top-level engine summary');
  assert.equal(job.result.bytes_received, buffer.length);

  const complete = captured.find((l) => l.msg === 'job complete' && l.job_id === jobId);
  assert.ok(complete, 'job complete line emitted');
  assert.equal(complete.winning_engine, 'ollama-x', 'complete carries winning_engine');
  assert.equal(typeof complete.elapsed_ms, 'number', 'complete carries elapsed_ms');
  assert.equal(complete.bytes_received, buffer.length, 'complete carries bytes_received');

  const start = captured.find((l) => l.msg === 'job start' && l.job_id === jobId);
  assert.ok(start, 'job start line emitted');
  assert.equal(start.bytes_received, buffer.length);

  assert.equal(temp._activeDirsForTest().length, 0, 'per-job temp dir was cleaned up');
});

test('runInputJob: a page failure is recorded but the job still completes_with_errors', async (t) => {
  clearLines();
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });
  t.after(() => { fakeCascadeImpl = null; });

  // Fail the 2nd cascade call only.
  let n = 0;
  fakeCascadeImpl = async () => {
    n += 1;
    if (n === 2) throw new Error('cascade blew up');
    return {
      result: { text: `p${n}`, engineId: 'ollama-x', provider: 'ollama', confidence: 0.8 },
      trace: { winning_engine: 'ollama-x', elapsed_ms: 2, low_confidence: false },
    };
  };

  const jobId = 'input-partial-' + Date.now();
  jobs.create(jobId, { model_id: 'cascade:balanced' });

  await runJob(jobId, {
    model: null, forced: false, profile: 'balanced',
    buffer: TIFF, mimeType: 'image/tiff', mode: 'quality',
    apiKey: null, preset: undefined, requestId: 'input-req-2',
  });
  await flush();

  const job = jobs.get(jobId);
  assert.equal(job.status, 'succeeded', 'a single bad page does NOT fail the whole job');
  assert.equal(job.result.pages.length, 3, 'no page dropped');
  assert.equal(job.result.status_rollup, 'completed_with_errors');
  assert.ok(job.result.pages[1].error, 'the failed page carries its error');
  assert.equal(temp._activeDirsForTest().length, 0, 'temp dir cleaned even with a page error');
});

test('runInputJob: over-cap PDF fails typed (pdf_too_many_pages), temp cleaned', async (t) => {
  clearLines();
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  const jobId = 'input-cap-' + Date.now();
  jobs.create(jobId, { model_id: 'cascade:balanced' });

  await runJob(jobId, {
    model: null, forced: false, profile: 'balanced',
    buffer: NATIVE_PDF, mimeType: 'application/pdf', mode: 'quality',
    apiKey: null, preset: undefined, requestId: 'input-req-3',
    spawnFn: makePdfSpawn({ pages: CAPS.MAX_PDF_PAGES + 1 }), // D-11 seam
  });
  await flush();

  const job = jobs.get(jobId);
  assert.equal(job.status, 'failed', 'an over-cap PDF fails the job');
  assert.equal(job.error.code, 'pdf_too_many_pages', 'typed cap failure code');
  assert.equal(temp._activeDirsForTest().length, 0, 'temp dir cleaned on the typed failure');

  const failed = captured.find((l) => l.msg === 'job failed' && l.job_id === jobId);
  assert.ok(failed, 'job failed line emitted');
  assert.equal(failed.errorCode, 'pdf_too_many_pages');
});

test('runInputJob: single-image PNG still routes to the unchanged forced/cascade path', async (t) => {
  clearLines();
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  // A PNG is NOT an input-pipeline format → it must NOT create a temp dir / hit
  // runInputJob; it stays on the Phase-1/2 single-image cascade path.
  const jobId = 'input-png-' + Date.now();
  jobs.create(jobId, { model_id: 'cascade:balanced' });

  await runJob(jobId, {
    model: null, forced: false, profile: 'balanced',
    buffer: Buffer.alloc(32, 0x10), mimeType: 'image/png', mode: 'quality',
    apiKey: null, preset: undefined, requestId: 'input-req-4',
  });
  await flush();

  const job = jobs.get(jobId);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.pages.length, 1, 'single-image path stays 1-element');
  assert.equal(job.result.status_rollup, undefined, 'no rollup on the single-image path');
  assert.equal(temp._activeDirsForTest().length, 0, 'single-image path creates no temp dir');
});
