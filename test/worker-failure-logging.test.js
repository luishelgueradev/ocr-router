// OBSV-05: safe failure logging. The 'job failed' log line carries ONLY
// status, errorCode, and message — never the raw error object or any field
// that could leak Authorization, axios config, base64 image data, or OCR text.
// The 'job crashed' line (outer catch) carries ONLY errorCode='internal_error'.
//
// Strategy mirrors test/worker-logging.test.js — substitute lib/logger.js in
// require.cache and monkey-patch runOCR on lib/ocr to inject failure results.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const pino = require('pino');

// ---------------------------------------------------------------------------
// Logger substitution BEFORE requiring worker
// ---------------------------------------------------------------------------

const loggerPath = require.resolve('../lib/logger');
const originalLoggerExports = require(loggerPath);

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
// runOCR monkey-patch
// ---------------------------------------------------------------------------

const ocrPath = require.resolve('../lib/ocr');
require(ocrPath);
const originalRunOCR = require.cache[ocrPath].exports.runOCR;
let fakeRunOCRImpl = null;
require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  if (fakeRunOCRImpl) return fakeRunOCRImpl(model, base64, mime, key, opts);
  return { ok: true, timeMs: 1, text: 'fake-text' };
};

const jobs = require('../lib/v1/jobs');
const { runJob } = require('../lib/v1/worker');

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

// Allow-list of keys a 'job failed' log line is permitted to contain.
// Anything outside this set is a leak surface and fails the assertion.
//
//   - pino internals: level, time, pid, hostname, msg
//   - bound via logger.child: job_id, request_id
//   - explicit log data: status, errorCode, message
const FAILED_ALLOWED_KEYS = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'job_id',
  'request_id',
  'status',
  'errorCode',
  'message',
]);

const CRASHED_ALLOWED_KEYS = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'job_id',
  'request_id',
  'errorCode',
]);

// Tokens that must NEVER appear in a serialized failure log — these are the
// shapes axios errors / raw response objects tend to carry.
const FORBIDDEN_TOKENS = [
  'Authorization',
  'authorization', // header name (lower-case form pino-http would emit)
  'config',        // axios error config
  'axios',
  'headers',
  'data:image',    // base64 image prefix
  'buffer',
  // (we accept 'message' and 'error' because the contract uses them; the
  // strings below catch the raw response/payload shapes only)
];

// ---------------------------------------------------------------------------
// OBSV-05 / failure path: only status, errorCode, message
// ---------------------------------------------------------------------------

test('OBSV-05: job failed line contains only status, errorCode, message (no raw error fields)', async (t) => {
  clearLines();

  fakeRunOCRImpl = async () => ({
    ok: false,
    status: 401,
    error: 'Unauthorized',
    timeMs: 5,
  });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-fail-auth-' + Date.now();
  const requestId = 'fail-trace-1';
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer: Buffer.alloc(20),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'k',
    preset: undefined,
    requestId,
  });
  await flush();

  const failedLines = captured.filter(
    (l) => l.msg === 'job failed' && l.job_id === jobId
  );
  assert.equal(failedLines.length, 1, `expected exactly 1 job failed line, got ${failedLines.length}`);

  const line = failedLines[0];

  // Required fields
  assert.equal(line.status, 401, 'failed line must carry status');
  assert.equal(line.errorCode, 'auth_failed', '401 maps to errorCode=auth_failed');
  assert.equal(line.message, 'Unauthorized', 'message must come from result.error');
  assert.equal(line.job_id, jobId);
  assert.equal(line.request_id, requestId);

  // The line MUST NOT contain any key outside the allow-list
  for (const key of Object.keys(line)) {
    assert.ok(
      FAILED_ALLOWED_KEYS.has(key),
      `unexpected key '${key}' on 'job failed' line — potential data-leak surface. Full line: ${JSON.stringify(line)}`
    );
  }

  // Serialized form must not contain raw-error tokens
  const serialized = JSON.stringify(line);
  for (const token of FORBIDDEN_TOKENS) {
    assert.ok(
      !serialized.includes(token),
      `forbidden token '${token}' appears in 'job failed' line: ${serialized}`
    );
  }
});

// ---------------------------------------------------------------------------
// OBSV-05 / different error shape: ECONNREFUSED -> provider_unavailable
// ---------------------------------------------------------------------------

test('OBSV-05: ECONNREFUSED failure maps to errorCode=provider_unavailable and stays minimal', async (t) => {
  clearLines();

  fakeRunOCRImpl = async () => ({
    ok: false,
    status: 0,
    error: 'ECONNREFUSED 127.0.0.1:11434',
    timeMs: 5,
  });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-fail-conn-' + Date.now();
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer: Buffer.alloc(20),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'k',
    preset: undefined,
    requestId: 'conn-trace',
  });
  await flush();

  const failedLines = captured.filter(
    (l) => l.msg === 'job failed' && l.job_id === jobId
  );
  assert.equal(failedLines.length, 1);

  const line = failedLines[0];
  assert.equal(line.status, 0, 'status passes through as 0 for transport errors');
  assert.equal(
    line.errorCode,
    'provider_unavailable',
    'ECONNREFUSED maps to provider_unavailable (errors.js mapErrorCode)'
  );
  assert.equal(line.message, 'ECONNREFUSED 127.0.0.1:11434');

  // Allow-list check
  for (const key of Object.keys(line)) {
    assert.ok(
      FAILED_ALLOWED_KEYS.has(key),
      `unexpected key '${key}' on failure line — leak surface`
    );
  }
});

// ---------------------------------------------------------------------------
// OBSV-05 / crash path: outer catch logs ONLY errorCode='internal_error'
// The thrown error's message — which could carry secret material — must NOT
// appear in the captured output anywhere.
// ---------------------------------------------------------------------------

test('OBSV-05: job crashed line contains ONLY errorCode=internal_error (no thrown error fields)', async (t) => {
  clearLines();

  // Craft a thrown error whose message includes a token that would be a
  // disaster if it leaked into logs (Authorization).
  const secret = 'axios error with Authorization: Bearer sk-leak-12345 header';
  fakeRunOCRImpl = async () => {
    const e = new Error(secret);
    // attach axios-style debris that must never reach the log
    e.config = { headers: { Authorization: 'Bearer sk-leak-12345' } };
    e.response = { data: 'data:image/png;base64,iVBOR...' };
    throw e;
  };
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-crash-' + Date.now();
  const requestId = 'crash-trace';
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer: Buffer.alloc(20),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'k',
    preset: undefined,
    requestId,
  });
  await flush();

  const crashLines = captured.filter(
    (l) => l.msg === 'job crashed' && l.job_id === jobId
  );
  assert.equal(crashLines.length, 1, `expected exactly 1 job crashed line, got ${crashLines.length}`);

  const line = crashLines[0];
  assert.equal(line.errorCode, 'internal_error', 'crash line must carry errorCode=internal_error');
  assert.equal(line.job_id, jobId);
  assert.equal(line.request_id, requestId);
  assert.equal(line.msg, 'job crashed');

  // Allow-list check — no leaked fields
  for (const key of Object.keys(line)) {
    assert.ok(
      CRASHED_ALLOWED_KEYS.has(key),
      `unexpected key '${key}' on 'job crashed' line — potential data-leak surface. Full line: ${JSON.stringify(line)}`
    );
  }

  // The thrown error's payload must NOT appear anywhere in the captured
  // output for this jobId (this is the hard OBSV-05 / Pitfall 1 guarantee).
  const jobOutput = JSON.stringify(captured.filter((l) => l.job_id === jobId));
  assert.ok(
    !jobOutput.includes('sk-leak-12345'),
    `thrown error secret leaked into log output: ${jobOutput}`
  );
  assert.ok(
    !jobOutput.includes('Bearer'),
    `Bearer token leaked into log output: ${jobOutput}`
  );
  assert.ok(
    !jobOutput.includes('axios error with Authorization'),
    `thrown error message leaked into log output: ${jobOutput}`
  );
  assert.ok(
    !jobOutput.includes('data:image'),
    `axios response.data leaked into log output: ${jobOutput}`
  );
});

// ---------------------------------------------------------------------------
// OBSV-05 / negative control: the 'job failed' line itself must not leak any
// pre-existing OCR result.text — verifies result.text never reaches the log
// even when present on a failure-shaped result.
// ---------------------------------------------------------------------------

test('OBSV-05: result.text on a failure result never appears in the job failed log', async (t) => {
  clearLines();

  const secretText = 'SUPER-SECRET-OCR-CONTENT-XYZZY';
  fakeRunOCRImpl = async () => ({
    ok: false,
    status: 500,
    error: 'Internal provider error',
    text: secretText, // hypothetical leak vector
    timeMs: 5,
  });
  t.after(() => { fakeRunOCRImpl = null; });

  const jobId = 'worker-fail-leakcheck-' + Date.now();
  jobs.create(jobId, { model_id: 'ollama-qwen35-397b' });
  t.after(() => { if (jobs._clearForTest) jobs._clearForTest(); });

  await runJob(jobId, {
    model: makeFakeModel(),
    buffer: Buffer.alloc(20),
    mimeType: 'image/png',
    mode: 'quality',
    apiKey: 'k',
    preset: undefined,
    requestId: 'leakcheck-trace',
  });
  await flush();

  const jobOutput = JSON.stringify(captured.filter((l) => l.job_id === jobId));
  assert.ok(
    !jobOutput.includes(secretText),
    `result.text leaked into log output for failure path: ${jobOutput}`
  );
});
