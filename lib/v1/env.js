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

module.exports = { intFromEnv };
