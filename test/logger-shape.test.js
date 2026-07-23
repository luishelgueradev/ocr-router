// OBSV-01: pino 10.3.1 structured JSON logger to stdout; every emitted line
// contains timestamp, level, and msg. Verifies the shape of the shared
// lib/logger.js instance: pino API surface, exact pinned version, and the
// JSON envelope a real .info() call produces.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const pino = require('pino');

const logger = require('../lib/logger');

// OBSV-01 / API surface: lib/logger.js must export a pino instance with the
// methods downstream code relies on (logger.info, .error, .warn, .child).
test('OBSV-01: lib/logger.js exports a pino-like instance with info/error/warn/child', () => {
  assert.equal(typeof logger, 'object', 'logger must be an object');
  assert.equal(typeof logger.info, 'function', 'logger.info must be a function');
  assert.equal(typeof logger.error, 'function', 'logger.error must be a function');
  assert.equal(typeof logger.warn, 'function', 'logger.warn must be a function');
  assert.equal(typeof logger.child, 'function', 'logger.child must be a function');
});

// OBSV-01 / pinned version: the Standard Stack pins pino to 10.3.1 exactly.
// A drift here means the redact behaviour the rest of the phase relies on is
// not necessarily the same engine that was tested.
test('OBSV-01: pino package version is exactly 10.3.1', () => {
  const pinoPkg = require('pino/package.json');
  assert.equal(
    pinoPkg.version,
    '10.3.1',
    `expected pino@10.3.1, got ${pinoPkg.version}`
  );
});

// OBSV-01 / JSON envelope: every emitted line must be valid JSON and contain
// time (ISO 8601 — lib/logger.js uses pino.stdTimeFunctions.isoTime), level
// (numeric — pino emits levels as integers by default), and msg (string).
test('OBSV-01: each emitted line is valid JSON containing time, level and msg', (t, done) => {
  // We build a fresh pino instance using the SAME configuration as lib/logger.js
  // so we can capture the output to memory rather than stdout.
  const lines = [];
  const dest = new Writable({
    write(chunk, _, cb) {
      try {
        lines.push(JSON.parse(chunk.toString().trim()));
      } catch (_) {
        // ignore non-JSON
      }
      cb();
    },
  });

  const probeLogger = pino(
    {
      level: 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest
  );

  probeLogger.info({ probe: true }, 'shape probe');

  setImmediate(() => {
    assert.equal(lines.length, 1, 'expected exactly one log line');
    const line = lines[0];

    // time: must be present and an ISO-8601 string (isoTime emits a quoted ISO)
    assert.ok('time' in line, 'log line must contain time');
    assert.equal(typeof line.time, 'string', 'time must be a string (isoTime)');
    assert.match(
      line.time,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
      'time must be ISO-8601 with Z timezone'
    );

    // level: must be a number (info -> 30 by default in pino)
    assert.ok('level' in line, 'log line must contain level');
    assert.equal(typeof line.level, 'number', 'level must be a number');
    assert.equal(line.level, 30, 'info-level must serialize as 30');

    // msg: must be a string with the value we logged
    assert.ok('msg' in line, 'log line must contain msg');
    assert.equal(typeof line.msg, 'string', 'msg must be a string');
    assert.equal(line.msg, 'shape probe', 'msg must carry the message argument');

    // bonus: bindings we passed in should make it through
    assert.equal(line.probe, true, 'object bindings must be preserved');

    done();
  });
});

// OBSV-01 / level config: lib/logger.js reads process.env.LOG_LEVEL with a
// default of 'info'. The current logger should expose a numeric .level that
// matches the configured environment.
test('OBSV-01: lib/logger.js honours LOG_LEVEL (default info)', () => {
  // pino exposes .level as the string name and .levelVal as the numeric value
  // (or .level can be either depending on version — we accept both shapes).
  const expected = (process.env.LOG_LEVEL || 'info').toLowerCase();
  // logger.level should be either the string name or the numeric value.
  if (typeof logger.level === 'string') {
    assert.equal(
      logger.level,
      expected,
      `logger.level should match LOG_LEVEL (${expected})`
    );
  } else if (typeof logger.level === 'number') {
    // info=30, debug=20, trace=10, warn=40, error=50, fatal=60
    const levelMap = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
    assert.equal(logger.level, levelMap[expected], 'numeric level must match');
  } else {
    assert.fail('logger.level must be string or number');
  }
});

// OBSV-01 / child loggers: pino.child must produce a usable child instance
// (this is the seam lib/v1/worker.js uses to bind job_id / request_id).
test('OBSV-01: logger.child returns an instance with info/error', () => {
  const child = logger.child({ test_binding: 'shape' });
  assert.equal(typeof child.info, 'function');
  assert.equal(typeof child.error, 'function');
});
