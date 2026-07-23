// WR-07 — env var helpers. Centralises the parse + validate pattern so a
// typo (`JOB_STORE_MAX=fivve-hundred`) fails loudly at boot instead of
// silently falling back to the default with no log line.
//
// Three previous call sites used `Number(process.env.X) || default`, which
// has two pitfalls: `Number('not-a-number')` is NaN (NaN || default works
// by accident), and `Number('-5')` is -5 (truthy, returns -5 instead of
// the safer default). intFromEnv rejects both cases.

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

// floatFromEnv — sibling of intFromEnv for the cascade heuristic, whose
// thresholds/ratios are floats (e.g. 0.60, 0.30). intFromEnv rejects those
// because Number.isInteger(0.6) is false, so a dedicated float parser is
// needed. Same throw-loudly-on-invalid contract: returns fallback when
// unset/empty; throws on non-finite or non-positive (a threshold of 0 or a
// negative ratio is a config mistake, not a valid tuning value).
function floatFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive finite number, got: ${raw}`);
  }
  return n;
}

module.exports = { intFromEnv, floatFromEnv };
