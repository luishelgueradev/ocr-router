const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapErrorCode } = require('../lib/v1/errors');

// ASYNC-06 + MODE-04-adjacent + D-04/D-04a — mapErrorCode emits typed snake_case codes
// from a provider failure envelope { ok:false, error, status? }. Status takes
// priority over the string fallback per the locked RESEARCH §3 table.

test('mapErrorCode: status 401 → auth_failed', () => {
  const r = mapErrorCode({ ok: false, error: 'whatever', status: 401 });
  assert.equal(r.code, 'auth_failed');
  assert.equal(r.message, 'whatever');
});

test('mapErrorCode: string "unauthorized" → auth_failed (no status)', () => {
  const r = mapErrorCode({ ok: false, error: 'request unauthorized' });
  assert.equal(r.code, 'auth_failed');
});

test('mapErrorCode: status 403 → quota_exceeded', () => {
  const r = mapErrorCode({ ok: false, error: 'forbidden', status: 403 });
  assert.equal(r.code, 'quota_exceeded');
});

test('mapErrorCode: string "quota" → quota_exceeded', () => {
  const r = mapErrorCode({ ok: false, error: 'monthly quota reached' });
  assert.equal(r.code, 'quota_exceeded');
});

test('mapErrorCode: status 404 → model_not_found', () => {
  const r = mapErrorCode({ ok: false, error: 'no model', status: 404 });
  assert.equal(r.code, 'model_not_found');
});

test('mapErrorCode: string "model not found" → model_not_found', () => {
  const r = mapErrorCode({ ok: false, error: 'Model not found' });
  assert.equal(r.code, 'model_not_found');
});

test('mapErrorCode: status 429 → rate_limited with retryable:true', () => {
  const r = mapErrorCode({ ok: false, error: 'slow down', status: 429 });
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryable, true);
});

test('mapErrorCode: status 502 → provider_unavailable with retryable:true', () => {
  const r = mapErrorCode({ ok: false, error: 'bad gateway', status: 502 });
  assert.equal(r.code, 'provider_unavailable');
  assert.equal(r.retryable, true);
});

test('mapErrorCode: status 503 → provider_unavailable', () => {
  const r = mapErrorCode({ ok: false, error: 'service unavailable', status: 503 });
  assert.equal(r.code, 'provider_unavailable');
});

// ASYNC-06: connection errors at dispatch time MUST land on provider_unavailable
test('mapErrorCode: ECONNREFUSED (no status) → provider_unavailable (ASYNC-06)', () => {
  const r = mapErrorCode({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:11434' });
  assert.equal(r.code, 'provider_unavailable');
  assert.equal(r.retryable, true);
});

test('mapErrorCode: ENOTFOUND (no status) → provider_unavailable (ASYNC-06)', () => {
  const r = mapErrorCode({ ok: false, error: 'getaddrinfo ENOTFOUND ollama.com' });
  assert.equal(r.code, 'provider_unavailable');
});

test('mapErrorCode: "fetch failed" (no status) → provider_unavailable', () => {
  const r = mapErrorCode({ ok: false, error: 'fetch failed' });
  assert.equal(r.code, 'provider_unavailable');
});

test('mapErrorCode: timeout string → inference_timeout', () => {
  const r = mapErrorCode({ ok: false, error: 'Tiempo de espera agotado' });
  assert.equal(r.code, 'inference_timeout');
});

test('mapErrorCode: unknown status + unknown string → provider_error (fallback)', () => {
  const r = mapErrorCode({ ok: false, error: 'something weird happened', status: 418 });
  assert.equal(r.code, 'provider_error');
  assert.equal(r.message, 'something weird happened');
});

test('mapErrorCode: status takes precedence over string mismatch', () => {
  // status 401 wins even when error message says "timeout" (status-first priority)
  const r = mapErrorCode({ ok: false, error: 'Tiempo de espera agotado', status: 401 });
  assert.equal(r.code, 'auth_failed');
});

test('mapErrorCode: empty error string with unknown status → provider_error', () => {
  const r = mapErrorCode({ ok: false, error: '', status: 999 });
  assert.equal(r.code, 'provider_error');
});

test('mapErrorCode: rate-limited string → rate_limited retryable', () => {
  const r = mapErrorCode({ ok: false, error: 'rate limit exceeded' });
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryable, true);
});
