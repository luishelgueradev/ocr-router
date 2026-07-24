const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// INP-07 — lib/v1/input/caps.js boot-validated memory caps.
//
// caps.js reads every ceiling from env THROUGH intFromEnv at require time and
// freezes the result. So each case must (a) set/unset the env var, then (b)
// re-require caps.js AND its env.js dependency with a clean module cache —
// otherwise the first require wins and later env changes are invisible.

const CAPS_PATH = path.resolve(__dirname, '..', 'lib', 'v1', 'input', 'caps.js');
const ENV_PATH = path.resolve(__dirname, '..', 'lib', 'v1', 'env.js');

// Load a fresh copy of caps.js with the current process.env. Clears the cached
// caps.js + env.js modules first so intFromEnv re-reads env on this require.
function freshCaps() {
  delete require.cache[CAPS_PATH];
  delete require.cache[ENV_PATH];
  return require(CAPS_PATH).CAPS;
}

// Run `fn` with `overrides` merged into process.env, restoring env afterward.
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// The full set of caps + their research-recommended defaults.
const EXPECTED_DEFAULTS = {
  MAX_PDF_PAGES: 50,
  MAX_IMAGE_FRAMES: 50,
  RASTER_DPI: 200,
  MAX_OUTPUT_PIXELS: 25_000_000,
  RASTER_MAX_DIM: 5000,
  ULIMIT_V_KB: 786_432,
  ULIMIT_CPU_SEC: 20,
  RASTER_WALL_MS: 30_000,
  PDFINFO_WALL_MS: 10_000,
  MAX_RASTER_STDOUT_BYTES: 41_943_040,
  PDFINFO_MAX_STDOUT_BYTES: 65_536,
  MIN_NATIVE_CHARS: 16,
  MAX_JOB_MS: 180_000,
};

test('INP-07 caps: defaults are all present, positive integers, and match the research budget', () => {
  // Ensure none of the cap env vars are set for the default read.
  const clear = {};
  for (const key of Object.keys(EXPECTED_DEFAULTS)) clear[key] = undefined;

  withEnv(clear, () => {
    const CAPS = freshCaps();
    for (const [key, expected] of Object.entries(EXPECTED_DEFAULTS)) {
      assert.ok(key in CAPS, `CAPS is missing ${key}`);
      assert.equal(CAPS[key], expected, `${key} default should be ${expected}`);
      assert.ok(Number.isInteger(CAPS[key]) && CAPS[key] > 0, `${key} must be a positive integer`);
    }
  });
});

test('INP-07 caps: the CAPS object is frozen (immutable at runtime)', () => {
  const CAPS = freshCaps();
  assert.ok(Object.isFrozen(CAPS), 'CAPS must be Object.freeze()d');
  assert.throws(
    () => { 'use strict'; CAPS.MAX_PDF_PAGES = 999; },
    TypeError,
    'mutating a frozen CAPS should throw in strict mode'
  );
});

test('INP-07 caps: a valid env override replaces the default', () => {
  withEnv({ MAX_PDF_PAGES: '10', RASTER_DPI: '300' }, () => {
    const CAPS = freshCaps();
    assert.equal(CAPS.MAX_PDF_PAGES, 10, 'MAX_PDF_PAGES override should win');
    assert.equal(CAPS.RASTER_DPI, 300, 'RASTER_DPI override should win');
    // Untouched keys still fall back to their defaults.
    assert.equal(CAPS.MAX_JOB_MS, EXPECTED_DEFAULTS.MAX_JOB_MS);
  });
});

test('INP-07 caps: a negative override throws loudly at load (fail-fast)', () => {
  withEnv({ MAX_OUTPUT_PIXELS: '-5' }, () => {
    assert.throws(
      () => freshCaps(),
      /MAX_OUTPUT_PIXELS must be a positive integer/,
      'a negative cap must be rejected at boot, not silently accepted'
    );
  });
});

test('INP-07 caps: a non-numeric override throws loudly at load (fail-fast)', () => {
  withEnv({ RASTER_DPI: 'x' }, () => {
    assert.throws(
      () => freshCaps(),
      /RASTER_DPI must be a positive integer/,
      'a non-numeric cap must be rejected at boot'
    );
  });
});
