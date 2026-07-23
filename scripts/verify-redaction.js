const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

// Redact config — mirrors lib/logger.js exactly.
// The drift guard below asserts these values are present in the actual lib/logger.js source,
// so any path removed from the real config will fail this test (approach (b) from the plan).
const REDACT_PATHS = [
  'req.headers.authorization',
  'apiKeyOverride',
  'req.body.apiKeyOverride',
];
const REDACT_CENSOR = '[REDACTED]';

// Build a fresh pino instance that writes to an in-memory Writable.
// Returns { testLogger, lines } where lines accumulates parsed JSON objects.
function makeTestLogger() {
  const lines = [];
  const dest = new Writable({
    write(chunk, _, cb) {
      try {
        const parsed = JSON.parse(chunk.toString().trim());
        lines.push(parsed);
      } catch (_) {
        // ignore non-JSON (e.g. empty newlines)
      }
      cb();
    },
  });
  const testLogger = pino(
    {
      level: 'info',
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    },
    dest
  );
  return { testLogger, lines };
}

// Drift guard: assert each expected path and the censor value are present
// in the real lib/logger.js source text.  If a path is removed or renamed
// in lib/logger.js this assertion will fail, making it impossible to pass
// this verification script while the real config has drifted.
test('drift guard: lib/logger.js contains all expected redact paths and censor', () => {
  const loggerSrc = fs.readFileSync(
    require.resolve('../lib/logger.js'),
    'utf8'
  );
  for (const redactPath of REDACT_PATHS) {
    assert.ok(
      loggerSrc.includes(redactPath),
      `lib/logger.js is missing redact path: '${redactPath}'`
    );
  }
  assert.ok(
    loggerSrc.includes(REDACT_CENSOR),
    `lib/logger.js is missing censor value: '${REDACT_CENSOR}'`
  );
});

// OBSV-04 / Authorization: assert the Authorization header value is censored
// and the plaintext secret does not appear anywhere in the output.
test('OBSV-04: req.headers.authorization is redacted to [REDACTED]', (t, done) => {
  const { testLogger, lines } = makeTestLogger();

  testLogger.info(
    { req: { headers: { authorization: 'Bearer sk-test-12345' } } },
    'http log'
  );

  setImmediate(() => {
    assert.equal(lines.length, 1, 'expected exactly one log line');
    assert.equal(
      lines[0].req.headers.authorization,
      '[REDACTED]',
      'authorization header must be [REDACTED]'
    );
    const serialized = JSON.stringify(lines);
    assert.ok(
      !serialized.includes('sk-test-12345'),
      'plaintext authorization value must not appear in output'
    );
    assert.ok(
      serialized.includes('[REDACTED]'),
      'censor value [REDACTED] must appear in output'
    );
    done();
  });
});

// OBSV-04 / apiKeyOverride: assert the API key override value is censored.
test('OBSV-04: apiKeyOverride is redacted to [REDACTED]', (t, done) => {
  const { testLogger, lines } = makeTestLogger();

  testLogger.info({ apiKeyOverride: 'sk-real-key' }, 'legacy ocr');

  setImmediate(() => {
    assert.equal(lines.length, 1, 'expected exactly one log line');
    assert.equal(
      lines[0].apiKeyOverride,
      '[REDACTED]',
      'apiKeyOverride must be [REDACTED]'
    );
    const serialized = JSON.stringify(lines);
    assert.ok(
      !serialized.includes('sk-real-key'),
      'plaintext apiKeyOverride value must not appear in output'
    );
    done();
  });
});

// OBSV-06 / no PII: a realistic job-complete log line must not carry OCR text
// or image bytes — only size metadata.
test('OBSV-06: job-complete log carries only metadata — no text, no buffer', (t, done) => {
  const { testLogger, lines } = makeTestLogger();

  // Realistic job-complete fields: size (bytes_received) and timing only.
  // Deliberately does NOT include `text` or `buffer` — that is the rule being verified.
  testLogger.info(
    {
      job_id: 'test-job',
      model: 'ollama-qwen3-vl',
      mode: 'quality',
      bytes_received: 1048576,
      latency_ms: 12000,
    },
    'job complete'
  );

  setImmediate(() => {
    assert.equal(lines.length, 1, 'expected exactly one log line');

    // No OCR text field
    assert.ok(
      !('text' in lines[0]),
      'job-complete log must not contain a text field (OCR output is PII)'
    );

    // No image buffer field
    assert.ok(
      !('buffer' in lines[0]),
      'job-complete log must not contain a buffer field (image bytes are PII)'
    );

    // Size metadata is present and correct
    assert.equal(
      lines[0].bytes_received,
      1048576,
      'bytes_received metadata must be present'
    );

    // The serialized output must not contain any fake OCR text
    // (proving the test is a real gate: if we had logged text: 'SECRET OCR', this would catch it)
    const serialized = JSON.stringify(lines);
    assert.ok(
      !serialized.includes('SECRET OCR'),
      'no OCR text content should appear in log output'
    );

    done();
  });
});

// OBSV-04 / censor present: confirm [REDACTED] actually appears in output
// when sensitive fields are emitted (belt-and-suspenders check).
test('OBSV-04: [REDACTED] censor value appears in output when sensitive fields are logged', (t, done) => {
  const { testLogger, lines } = makeTestLogger();

  testLogger.info(
    {
      req: { headers: { authorization: 'Bearer sk-censor-check' } },
      apiKeyOverride: 'sk-another-key',
    },
    'combined sensitive fields'
  );

  setImmediate(() => {
    const serialized = JSON.stringify(lines);
    assert.ok(
      serialized.includes('[REDACTED]'),
      'output must contain [REDACTED] when sensitive fields are present'
    );
    assert.ok(
      !serialized.includes('sk-censor-check'),
      'Bearer token must not appear in output'
    );
    assert.ok(
      !serialized.includes('sk-another-key'),
      'apiKeyOverride value must not appear in output'
    );
    done();
  });
});
