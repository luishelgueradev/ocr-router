// Set API_TOKEN before requiring auth.js — it captures the value at module load.
process.env.API_TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { bearerAuth } = require('../lib/v1/auth');

const TOKEN = process.env.API_TOKEN;
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(REPO_ROOT, 'server.js');

// Build a minimal res mock that records the call sequence.
function mockRes() {
  const captured = { code: null, headers: {}, body: null };
  return {
    captured,
    status(c) { captured.code = c; return this; },
    set(k, v) { captured.headers[k] = v; return this; },
    json(b) { captured.body = b; return this; },
  };
}

// AUTH-02 — /health is exempt from the bearer requirement (no token required)
test('AUTH-02: /health is exempt — next() is called with no Authorization header', () => {
  const res = mockRes();
  let called = false;
  bearerAuth({ path: '/health', headers: {} }, res, () => { called = true; });
  assert.equal(called, true, '/health must skip auth and call next()');
  assert.equal(res.captured.code, null, '/health must NOT receive a status (no early response)');
});

test('AUTH-02: /health with garbage Authorization is still allowed', () => {
  const res = mockRes();
  let called = false;
  bearerAuth({ path: '/health', headers: { authorization: 'Bearer wrong-token' } }, res, () => { called = true; });
  assert.equal(called, true, '/health bypasses auth entirely');
});

// AUTH-02 — every non-/health path requires auth
test('AUTH-02: /ocr without Authorization → 401', () => {
  const res = mockRes();
  let called = false;
  bearerAuth({ path: '/ocr', headers: {} }, res, () => { called = true; });
  assert.equal(called, false, 'next() must NOT be called');
  assert.equal(res.captured.code, 401);
});

test('AUTH-02: /jobs/abc without Authorization → 401', () => {
  const res = mockRes();
  let called = false;
  bearerAuth({ path: '/jobs/abc', headers: {} }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.captured.code, 401);
});

test('AUTH-02: /models without Authorization → 401', () => {
  const res = mockRes();
  let called = false;
  bearerAuth({ path: '/models', headers: {} }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.captured.code, 401);
});

// AUTH-04 — WWW-Authenticate header and JSON body envelope
test('AUTH-04: 401 carries RFC 6750 WWW-Authenticate header', () => {
  const res = mockRes();
  bearerAuth({ path: '/ocr', headers: {} }, res, () => {});
  assert.equal(
    res.captured.headers['WWW-Authenticate'],
    'Bearer realm="ocr-api", error="invalid_token"',
    'AUTH-04 requires the RFC 6750 WWW-Authenticate value verbatim'
  );
});

test('AUTH-04: 401 body is JSON with error="invalid_token" and a string message', () => {
  const res = mockRes();
  bearerAuth({ path: '/ocr', headers: {} }, res, () => {});
  assert.equal(res.captured.body.error, 'invalid_token');
  assert.equal(typeof res.captured.body.message, 'string');
  assert.ok(res.captured.body.message.length > 0);
});

test('AUTH-04: 401 body never leaks the configured token value', () => {
  const res = mockRes();
  bearerAuth({ path: '/ocr', headers: { authorization: 'Bearer evil' } }, res, () => {});
  const dump = JSON.stringify(res.captured);
  assert.equal(dump.includes(TOKEN), false, 'token must never appear in any 401 response');
});

// AUTH-03 — timingSafeEqual with length pre-check (never throws on length mismatch)
test('AUTH-03: length-mismatch token returns 401 without throwing (timingSafeEqual length guard)', () => {
  const res = mockRes();
  // The expected token is 60 chars; provide a much shorter "Bearer x" — would
  // throw inside timingSafeEqual without the length pre-check.
  assert.doesNotThrow(() => {
    bearerAuth({ path: '/ocr', headers: { authorization: 'Bearer x' } }, res, () => {});
  });
  assert.equal(res.captured.code, 401);
});

test('AUTH-03: equal-length-but-different token returns 401 (timingSafeEqual fails)', () => {
  const res = mockRes();
  // Same length as TOKEN (60 chars after 'Bearer '), all 'b'
  const wrong = 'b'.repeat(TOKEN.length);
  let called = false;
  bearerAuth(
    { path: '/ocr', headers: { authorization: `Bearer ${wrong}` } },
    res,
    () => { called = true; }
  );
  assert.equal(called, false);
  assert.equal(res.captured.code, 401);
});

test('AUTH-03: equal-length-but-different token does NOT throw', () => {
  const res = mockRes();
  const wrong = 'c'.repeat(TOKEN.length);
  assert.doesNotThrow(() => {
    bearerAuth(
      { path: '/ocr', headers: { authorization: `Bearer ${wrong}` } },
      res,
      () => {}
    );
  });
});

// Happy path — correct token reaches the route
test('AUTH-02: correct token reaches the route (next called)', () => {
  const res = mockRes();
  let called = false;
  bearerAuth(
    { path: '/ocr', headers: { authorization: `Bearer ${TOKEN}` } },
    res,
    () => { called = true; }
  );
  assert.equal(called, true, 'next() must be called on correct token');
  assert.equal(res.captured.code, null, 'no early response on success');
});

// Bearer scheme handling
test('AUTH-04: missing scheme prefix → 401 (e.g. just the token)', () => {
  const res = mockRes();
  bearerAuth({ path: '/ocr', headers: { authorization: TOKEN } }, res, () => {});
  assert.equal(res.captured.code, 401);
});

test('AUTH-04: Basic auth scheme → 401', () => {
  const res = mockRes();
  bearerAuth({ path: '/ocr', headers: { authorization: 'Basic xyz' } }, res, () => {});
  assert.equal(res.captured.code, 401);
});

// RFC 6750 §2.1 — scheme is case-insensitive (server.js implementation accepts lower/upper)
test('AUTH-02: lowercase "bearer" scheme accepted (RFC 6750 case-insensitive)', () => {
  const res = mockRes();
  let called = false;
  bearerAuth(
    { path: '/ocr', headers: { authorization: `bearer ${TOKEN}` } },
    res,
    () => { called = true; }
  );
  assert.equal(called, true, 'RFC 6750 §2.1 says scheme is case-insensitive');
});

// ---------------------------------------------------------------------------
// AUTH-01 — server refuses to boot when API_TOKEN is unset/empty
//
// Spawn-based behavioural test. Mirrors env-guards.test.js pattern.
// ---------------------------------------------------------------------------

// Spawn server.js with cwd set to a directory WITHOUT a .env file so dotenv's
// auto-load is a no-op and the test env is the sole source of truth.
const os = require('node:os');
const fs = require('node:fs');
const TMP_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));

function spawnServer(env, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      cwd: TMP_CWD,
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr += b.toString(); });
    child.on('exit', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// Pointing dotenv at a non-existent file makes dotenv a no-op so the child
// process really runs with the env we hand it (and nothing from .env).
const DOTENV_NOOP = { DOTENV_CONFIG_PATH: '/dev/null' };

test('AUTH-01: server refuses to boot when API_TOKEN is completely unset', async () => {
  const { code, stdout, stderr } = await spawnServer({
    ...DOTENV_NOOP,
    NODE_ENV: 'development',
    PORT: '39871',
  });
  assert.notEqual(code, 0, 'server must exit non-zero when API_TOKEN is unset');
  const combined = stdout + stderr;
  assert.match(
    combined,
    /API_TOKEN missing/i,
    `expected throw mentioning API_TOKEN missing; got:\n${combined}`
  );
});

test('AUTH-01: server refuses to boot when API_TOKEN is empty string', async () => {
  const { code, stdout, stderr } = await spawnServer({
    ...DOTENV_NOOP,
    NODE_ENV: 'development',
    PORT: '39872',
    API_TOKEN: '',
  });
  assert.notEqual(code, 0, 'server must exit non-zero when API_TOKEN is empty');
  const combined = stdout + stderr;
  assert.match(combined, /API_TOKEN/i);
});
