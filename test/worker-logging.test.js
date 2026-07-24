// OBSV-03: job lifecycle logs (start, complete) carry job_id, request_id,
// model, provider, mode, bytes_received, and (for completion) latency_ms.
//
// Strategy: substitute a capture-friendly pino instance for lib/logger.js
// in require.cache BEFORE requiring lib/v1/worker.js. The worker binds a
// child logger off the cached module at runtime, so every log call lands in
// our in-memory array. runOCR is also monkey-patched on lib/ocr so runJob
// resolves with a deterministic result envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const pino = require('pino');

// ---------------------------------------------------------------------------
// Logger substitution — must happen BEFORE requiring lib/v1/worker.js so the
// worker's `const logger = require('../logger')` lookup hits our fake.
// ---------------------------------------------------------------------------

const loggerPath = require.resolve('../lib/logger');
const originalLoggerExports = require(loggerPath); // ensure cached

// Shared capture array (reset per test via clearLines() below).
const captured = [];
function clearLines() {
  captured.length = 0;
}

const captureDest = new Writable({
  write(chunk, _, cb) {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        captured.push(JSON.parse(line));
      } catch (_) {
        // ignore non-JSON
      }
    }
    cb();
  },
});

// Replicate the production logger config (lib/logger.js) — same redact paths
// so the test mirrors real behaviour, just written to memory instead of stdout.
const fakeLogger = pino(
  {
    level: 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'apiKeyOverride', 'req.body.apiKeyOverride'],
      censor: '[REDACTED]',
    },
  },
  captureDest
);

require.cache[loggerPath].exports = fakeLogger;

// ---------------------------------------------------------------------------
// Monkey-patch runOCR on lib/ocr BEFORE requiring worker (worker resolves
// runOCR off the cached module). Matches the strategy from test/v1-routes.test.js.
// ---------------------------------------------------------------------------

const ocrPath = require.resolve('../lib/ocr');
require(ocrPath); // ensure cached
const originalRunOCR = require.cache[ocrPath].exports.runOCR;
let fakeRunOCRImpl = null;
require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  if (fakeRunOCRImpl) return fakeRunOCRImpl(model, base64, mime, key, opts);
  return { ok: true, timeMs: 1, text: 'fake-text' };
};

const jobs = require('../lib/v1/jobs');
const { runJob } = require('../lib/v1/worker');

// Restore the real exports after this file's tests run.
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
  require.cache[loggerPath].exports = originalLoggerExports;
});

function flush() {
  return new Promise((r) => setImmediate(r));
}

function makeFakeModel() {
  return {
    id: 'ollama-qwen35-397b',
    provider: 'ollama',
    modes_supported: ['quality'],
  };
}

// ---------------------------------------------------------------------------
// OBSV-03 / success path: 'job start' and 'job complete' both carry the
// required fields, including request_id propagation.
// ---------------------------------------------------------------------------

test('OBSV-03: runJob emits job start + job complete with all required fields', async (t) => {
  clearLines();

  fakeRunOCRImpl = async () => ({ ok: true, timeMs: 42, text: 'extracted' });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-log-success-' + Date.now();
  const requestId = 'test-req-1';
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  const buffer = Buffer.alloc(123, 0x42);

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer,
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'unused',
    preset: undefined,
    requestId,
  });
  await flush();

  // Filter out any pino-internal lines (none expected, but be safe)
  const jobLines = captured.filter(
    (l) => l.msg === 'job start' || l.msg === 'job complete'
  );

  assert.ok(jobLines.length >= 2, `expected >=2 job lifecycle lines, got ${jobLines.length}`);

  const startLine = jobLines.find((l) => l.msg === 'job start');
  const completeLine = jobLines.find((l) => l.msg === 'job complete');

  assert.ok(startLine, 'job start line must be emitted');
  assert.ok(completeLine, 'job complete line must be emitted');

  // ---- job start: required field set ----
  assert.equal(startLine.job_id, jobId, 'job start must carry job_id');
  assert.equal(startLine.request_id, requestId, 'job start must carry request_id');
  assert.equal(startLine.model, 'ollama-qwen35-397b', 'job start must carry model id');
  assert.equal(startLine.provider, 'ollama', 'job start must carry provider');
  assert.equal(startLine.mode, 'quality', 'job start must carry mode');
  assert.equal(startLine.bytes_received, buffer.length, 'job start must carry bytes_received');

  // ---- job complete: required field set + latency_ms ----
  assert.equal(completeLine.job_id, jobId, 'job complete must carry job_id');
  assert.equal(completeLine.request_id, requestId, 'job complete must carry request_id');
  assert.equal(completeLine.model, 'ollama-qwen35-397b', 'job complete must carry model id');
  assert.equal(completeLine.provider, 'ollama', 'job complete must carry provider');
  assert.equal(completeLine.mode, 'quality', 'job complete must carry mode');
  assert.equal(
    completeLine.bytes_received,
    buffer.length,
    'job complete must carry bytes_received'
  );
  assert.equal(
    completeLine.latency_ms,
    42,
    'job complete must carry latency_ms from result.timeMs'
  );
});

// ---------------------------------------------------------------------------
// OBSV-03 / request_id propagation: the job logs must carry the same
// request_id we passed in. (D-01 trace-UX target.)
// ---------------------------------------------------------------------------

test('OBSV-03: request_id propagates from runJob options to every job log line', async (t) => {
  clearLines();

  fakeRunOCRImpl = async () => ({ ok: true, timeMs: 7, text: 'ok' });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-log-correlate-' + Date.now();
  const requestId = 'correlate-trace-xyz';
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer: Buffer.alloc(10),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'k',
    preset: undefined,
    requestId,
  });
  await flush();

  const jobLines = captured.filter((l) => l.job_id === jobId);
  assert.ok(jobLines.length >= 2, 'expected at least 2 lines for this job');
  for (const line of jobLines) {
    assert.equal(
      line.request_id,
      requestId,
      `every line for this job must carry request_id=${requestId}, got ${line.request_id} (msg=${line.msg})`
    );
  }
});

// ---------------------------------------------------------------------------
// OBSV-03 / job start vs job complete: each line is a separate emission
// ---------------------------------------------------------------------------

test('OBSV-03: exactly one job start and one job complete per successful runJob', async (t) => {
  clearLines();

  fakeRunOCRImpl = async () => ({ ok: true, timeMs: 3, text: 'short' });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-log-count-' + Date.now();
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer: Buffer.alloc(8),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'k',
    preset: undefined,
    requestId: 'count-req',
  });
  await flush();

  const starts = captured.filter((l) => l.msg === 'job start' && l.job_id === jobId);
  const completes = captured.filter((l) => l.msg === 'job complete' && l.job_id === jobId);

  assert.equal(starts.length, 1, `expected 1 job start, got ${starts.length}`);
  assert.equal(completes.length, 1, `expected 1 job complete, got ${completes.length}`);
});
