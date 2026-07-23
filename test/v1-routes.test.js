// Integration tests for the /v1 router (API-01, API-03, API-05, API-06, API-07,
// API-08, AUTH-02 e2e, ASYNC-02 UUIDv7, ASYNC-05, VAL-01, VAL-03, MODE-04).
//
// Strategy: mount lib/v1/router.js on a fresh Express app inside the test
// process. This avoids depending on server.js's boot guards (TAILSCALE_IP,
// pino-http config, graceful shutdown) and gives us a deterministic test
// surface. The bearerAuth-vs-no-auth distinction is exercised in two ways:
//   1) Most tests mount the router WITHOUT bearerAuth (testing route behavior).
//   2) One nested describe-block mounts WITH bearerAuth and verifies the
//      AUTH-02 e2e exemption that /v1/health is public while /v1/models is not.
//
// runOCR is monkey-patched on the lib/ocr module so the worker resolves quickly
// with a deterministic OCR result — no real Ollama / OCR.space calls.

// Set required env BEFORE requiring auth.js (it reads API_TOKEN at module load)
process.env.API_TOKEN = 'route-test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// Configure both providers so the forced-model success paths below represent a
// *configured* engine. The router now fails closed (422) when a forced model's
// provider has no API key (HR-01), so exercising the 202 path requires the keys.
process.env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || 'route-test-ollama-key';
process.env.OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'route-test-ocrspace-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Monkey-patch runOCR on lib/ocr BEFORE requiring router (which transitively
// requires worker, which requires ocr). Replace exports on the cached module
// object so worker's reference sees our fake.
const ocrPath = require.resolve('../lib/ocr');
require('../lib/ocr'); // ensure cached
const originalRunOCR = require.cache[ocrPath].exports.runOCR;
let fakeRunOCRImpl = null;
require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  if (fakeRunOCRImpl) return fakeRunOCRImpl(model, base64, mime, key, opts);
  return { ok: true, timeMs: 1, text: 'fake-text' };
};

const router = require('../lib/v1/router');
const { bearerAuth } = require('../lib/v1/auth');
const jobs = require('../lib/v1/jobs');

const TOKEN = process.env.API_TOKEN;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Build a fresh app per test using port 0 (random)
function makeApp({ withAuth = false } = {}) {
  const app = express();
  if (withAuth) app.use('/v1', bearerAuth, router);
  else app.use('/v1', router);
  return app;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

// Minimal PNG buffer that passes magic-byte sniff (89 50 4E 47 0D 0A 1A 0A)
function pngBuffer(extraBytes = 16) {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([header, Buffer.alloc(extraBytes, 0xAA)]);
}

// Build a multipart body manually so we control the Content-Type with boundary
function buildMultipart({ buffer, mimetype, model, mode, fieldName = 'file', filename = 'test.png' }) {
  const boundary = '----test-' + Math.random().toString(36).slice(2);
  const parts = [];
  if (buffer !== undefined) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype || 'image/png'}\r\n\r\n`
    );
  }
  const bodyParts = [];
  if (buffer !== undefined) {
    bodyParts.push(Buffer.from(parts[0]));
    bodyParts.push(buffer);
    bodyParts.push(Buffer.from('\r\n'));
  }
  if (model !== undefined) {
    bodyParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${model}\r\n`
    ));
  }
  if (mode !== undefined) {
    bodyParts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="mode"\r\n\r\n` +
      `${mode}\r\n`
    ));
  }
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(bodyParts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ---------------------------------------------------------------------------
// API-01, AUTH-02: /v1/health is public, returns 200, dependencies + status:ok
// ---------------------------------------------------------------------------

test('API-01 + AUTH-02 e2e: GET /v1/health is public and returns 200 {status:ok}', async (t) => {
  const app = makeApp({ withAuth: true }); // with bearerAuth — /health must still be reachable
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const res = await fetch(`${url}/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.dependencies, 'body.dependencies required');
  assert.ok('reachable' in body.dependencies.ollama, 'dependencies.ollama.reachable required');
  assert.ok('reachable' in body.dependencies.ocr_space, 'dependencies.ocr_space.reachable required');
});

test('API-07: /v1/health body contains no API keys or secret-looking strings', async (t) => {
  const app = makeApp({ withAuth: true });
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));
  const res = await fetch(`${url}/v1/health`);
  const text = await res.text();
  assert.doesNotMatch(text, /OLLAMA_API_KEY|OCR_SPACE_API_KEY|API_TOKEN|Bearer/);
  assert.doesNotMatch(text, new RegExp(TOKEN));
});

// ---------------------------------------------------------------------------
// API-03 + CATALOG-01: GET /v1/models projection
// AUTH-02 e2e: /v1/models requires the token
// ---------------------------------------------------------------------------

test('AUTH-02 e2e: GET /v1/models without token → 401 + WWW-Authenticate', async (t) => {
  const app = makeApp({ withAuth: true });
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));
  const res = await fetch(`${url}/v1/models`);
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get('www-authenticate') || '',
    /Bearer realm="ocr-api", error="invalid_token"/
  );
});

test('API-03: GET /v1/models with token → 200 + {models:[{id,name,provider,modes_supported,default_mode}]}', async (t) => {
  const app = makeApp({ withAuth: true });
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));
  const res = await fetch(`${url}/v1/models`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.models));
  assert.ok(body.models.length > 0, 'expected at least one model');
  for (const m of body.models) {
    assert.ok(m.id, 'model.id required');
    assert.ok(m.name, 'model.name required (CATALOG-02)');
    assert.ok(m.provider, 'model.provider required');
    assert.ok(Array.isArray(m.modes_supported), 'model.modes_supported required');
    assert.ok(m.default_mode, 'model.default_mode required');
    // Catalog also has `label` and `modelTag` — the projection MUST NOT leak modelTag
    assert.equal(m.modelTag, undefined, 'projection must not include modelTag');
  }
});

// ---------------------------------------------------------------------------
// API-04 + API-05 + API-08 + ASYNC-02: POST /v1/ocr success path
// ---------------------------------------------------------------------------

test('API-05 + ASYNC-02: POST /v1/ocr → 202 + Location + Retry-After + UUIDv7 job_id', async (t) => {
  const app = makeApp(); // no auth wrapper — test the route directly
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  // Stub runOCR so the background worker resolves without real network
  fakeRunOCRImpl = async () => ({ ok: true, timeMs: 5, text: 'hello world' });
  t.after(() => { fakeRunOCRImpl = null; });

  const { body, contentType } = buildMultipart({
    buffer: pngBuffer(),
    mimetype: 'image/png',
    model: 'ollama-qwen3-vl-235b',
    mode: 'quality',
  });

  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

  assert.equal(res.status, 202, 'POST /v1/ocr must respond 202 Accepted');
  assert.equal(res.headers.get('retry-after'), '10', 'Retry-After: 10 required (API-05)');
  const loc = res.headers.get('location');
  assert.ok(loc, 'Location header required (API-05)');
  assert.match(loc, /^\/v1\/jobs\//, 'Location must point at /v1/jobs/');

  const payload = await res.json();
  assert.equal(payload.status, 'queued', 'initial status must be queued');
  assert.ok(payload.job_id, 'job_id required');
  assert.match(payload.job_id, UUID_V7_RE, 'ASYNC-02: job_id must be UUIDv7');
  assert.ok(payload.status_url, 'status_url required (API-05)');
  assert.ok(payload.created_at, 'created_at required');
  assert.ok(payload.expires_at, 'expires_at required');
  assert.equal(loc, `/v1/jobs/${payload.job_id}`, 'Location must match job_id');
});

// ---------------------------------------------------------------------------
// API-06: GET /v1/jobs/:id returns the job record
// ---------------------------------------------------------------------------

test('API-06: GET /v1/jobs/:id returns the job record immediately after 202', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  // Block runOCR so the job stays queued/processing during the test
  let release;
  fakeRunOCRImpl = () => new Promise((r) => { release = () => r({ ok: true, timeMs: 1, text: 'done' }); });
  t.after(() => {
    if (release) release();
    fakeRunOCRImpl = null;
  });

  const { body, contentType } = buildMultipart({
    buffer: pngBuffer(),
    mimetype: 'image/png',
    model: 'ollama-qwen3-vl-235b',
  });
  const post = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  const { job_id } = await post.json();

  const poll = await fetch(`${url}/v1/jobs/${job_id}`);
  assert.equal(poll.status, 200);
  const record = await poll.json();
  assert.equal(record.job_id, job_id);
  assert.ok(['queued', 'processing', 'succeeded'].includes(record.status));
  assert.ok(record.created_at);
  assert.ok(record.expires_at);

  if (release) release();
});

// ---------------------------------------------------------------------------
// ASYNC-05: GET /v1/jobs/unknown → 404 job_not_found
// ---------------------------------------------------------------------------

test('ASYNC-05: GET /v1/jobs/<unknown-id> → 404 {error:"job_not_found", job_id, message}', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const res = await fetch(`${url}/v1/jobs/nonexistent-id-12345`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'job_not_found');
  assert.equal(body.job_id, 'nonexistent-id-12345');
  assert.equal(typeof body.message, 'string');
});

// ---------------------------------------------------------------------------
// VAL-03: unknown model → 422 invalid_parameter field=model
// ---------------------------------------------------------------------------

test('VAL-03: POST /v1/ocr with unknown model → 422 invalid_parameter field=model', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const { body, contentType } = buildMultipart({
    buffer: pngBuffer(),
    mimetype: 'image/png',
    model: 'no-such-model-anywhere',
  });
  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  assert.equal(res.status, 422);
  const payload = await res.json();
  assert.equal(payload.error, 'invalid_parameter');
  assert.equal(payload.field, 'model');
  assert.match(payload.message, /v1\/models|modelos/i);
});

// ---------------------------------------------------------------------------
// MODE-04: unsupported mode → 422 invalid_parameter field=mode
// ---------------------------------------------------------------------------

test('MODE-04: POST /v1/ocr with unsupported mode → 422 invalid_parameter field=mode', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const { body, contentType } = buildMultipart({
    buffer: pngBuffer(),
    mimetype: 'image/png',
    model: 'ollama-qwen3-vl-235b',
    mode: 'ludicrous',
  });
  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  assert.equal(res.status, 422);
  const payload = await res.json();
  assert.equal(payload.error, 'invalid_parameter');
  assert.equal(payload.field, 'mode');
});

test('MODE-04: ocrspace + mode=speed → 422 (speed not in modes_supported)', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const { body, contentType } = buildMultipart({
    buffer: pngBuffer(),
    mimetype: 'image/png',
    model: 'ocrspace-engine2',
    mode: 'speed',
  });
  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  assert.equal(res.status, 422);
  const payload = await res.json();
  assert.equal(payload.field, 'mode');
});

// ---------------------------------------------------------------------------
// VAL-01: payload > MAX_UPLOAD_BYTES → 413 payload_too_large
// ---------------------------------------------------------------------------

test('VAL-01: oversize upload → 413 payload_too_large with limit_bytes', async (t) => {
  // Run a fresh test process for this — we need MAX_UPLOAD_BYTES low so we
  // can construct an oversize buffer cheaply. But intFromEnv is read at
  // module load and the module is already cached, so we set it before
  // re-requiring via cache delete in a child process? Easier path:
  // construct a 12 MiB buffer and rely on the default 10 MiB limit.
  // (Generates ~12 MiB of zeros — fast to allocate.)
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const oversize = Buffer.alloc(12 * 1024 * 1024); // 12 MiB > default 10 MiB
  oversize[0] = 0x89; oversize[1] = 0x50; oversize[2] = 0x4E; oversize[3] = 0x47;

  const { body, contentType } = buildMultipart({
    buffer: oversize,
    mimetype: 'image/png',
    model: 'ollama-qwen3-vl-235b',
  });
  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  assert.equal(res.status, 413);
  const payload = await res.json();
  assert.equal(payload.error, 'payload_too_large');
  assert.equal(typeof payload.limit_bytes, 'number');
  assert.ok(payload.limit_bytes > 0);
});

// ---------------------------------------------------------------------------
// VAL-02: non-image buffer that passes declared MIME but fails magic-byte sniff
// ---------------------------------------------------------------------------

test('VAL-02: declared image/png but garbage bytes → 422 field=file (sniff guard)', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const fake = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const { body, contentType } = buildMultipart({
    buffer: fake,
    mimetype: 'image/png', // lies about being PNG
    model: 'ollama-qwen3-vl-235b',
  });
  const res = await fetch(`${url}/v1/ocr`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  assert.equal(res.status, 422);
  const payload = await res.json();
  assert.equal(payload.error, 'invalid_parameter');
  assert.equal(payload.field, 'file');
});

// ---------------------------------------------------------------------------
// API-07: error responses are valid JSON across all paths
// ---------------------------------------------------------------------------

test('API-07: 404 job_not_found body is valid JSON', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));
  const res = await fetch(`${url}/v1/jobs/never-existed`);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.equal(typeof body, 'object');
});

// ---------------------------------------------------------------------------
// API-08: all routes versioned under /v1/*
// ---------------------------------------------------------------------------

test('API-08: all routes mounted at /v1/* prefix', () => {
  // Inspect the router's stack at the express level to confirm the four routes
  const paths = router.stack.map(layer => layer.route?.path).filter(Boolean);
  assert.ok(paths.includes('/ocr'), 'router has /ocr → mounted at /v1/ocr');
  assert.ok(paths.includes('/jobs/:id'), 'router has /jobs/:id → mounted at /v1/jobs/:id');
  assert.ok(paths.includes('/health'), 'router has /health → mounted at /v1/health');
  assert.ok(paths.includes('/models'), 'router has /models → mounted at /v1/models');
});

// Cleanup — restore the real runOCR after this file's tests run
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
});
