const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// API-01: GET /v1/health always returns 200 even if a dependency is down.
// API-02: dependency reachability + latency, refreshed at most every 10s (cached).
// T-01-14: no env value / token / key in the body.

// We test the health module in isolation by clearing it from the require cache
// before each test and monkey-patching global.fetch to count probe calls.

function loadFreshHealth() {
  // Clear the cached health module + this test's own snapshot of its require.cache
  const healthPath = require.resolve('../lib/v1/health');
  delete require.cache[healthPath];
  return require('../lib/v1/health');
}

function mockRes() {
  const captured = { code: null, body: null };
  return {
    captured,
    status(c) { captured.code = c; return this; },
    json(b) { captured.body = b; return this; },
  };
}

// Wait for any pending microtasks + a tick of the event loop.
function flush() { return new Promise(r => setImmediate(r)); }

test('API-01: healthHandler returns 200 {status:"ok"} on first call (before any probe completes)', () => {
  // Mock fetch with a slow-resolving fetch so the first response is served from cache
  const origFetch = global.fetch;
  global.fetch = () => new Promise(() => {}); // never resolves
  try {
    const { healthHandler } = loadFreshHealth();
    const res = mockRes();
    healthHandler({}, res);
    assert.equal(res.captured.code, 200);
    assert.equal(res.captured.body.status, 'ok');
    assert.ok(res.captured.body.dependencies);
    assert.ok('reachable' in res.captured.body.dependencies.ollama);
    assert.ok('reachable' in res.captured.body.dependencies.ocr_space);
  } finally {
    global.fetch = origFetch;
  }
});

test('API-01: healthHandler returns 200 even when all probes throw', async () => {
  const origFetch = global.fetch;
  global.fetch = () => Promise.reject(new Error('network down'));
  try {
    const { healthHandler } = loadFreshHealth();

    // First call kicks off background probe (which will reject)
    const res1 = mockRes();
    healthHandler({}, res1);
    assert.equal(res1.captured.code, 200, 'first call must be 200 regardless');

    // Give the rejected probes a tick to settle
    await flush();
    await flush();

    // Second call (still within cache window) must also be 200
    const res2 = mockRes();
    healthHandler({}, res2);
    assert.equal(res2.captured.code, 200, 'liveness must remain 200 even after probe failure');
    assert.equal(res2.captured.body.status, 'ok');
  } finally {
    global.fetch = origFetch;
  }
});

test('API-02: probe is cached — two calls within 10s do not double-invoke fetch', async () => {
  const origFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => {
    fetchCalls++;
    // Resolve quickly with a fake response so refreshIfStale completes
    return Promise.resolve({ ok: true, status: 200 });
  };
  try {
    const { healthHandler } = loadFreshHealth();
    // First call: triggers probe (lastProbe was 0, stale → fires fetch for both hosts)
    healthHandler({}, mockRes());
    await flush();
    await flush();
    const afterFirst = fetchCalls;
    assert.ok(afterFirst >= 2, `expected at least 2 fetch calls (ollama+ocrspace) on first probe; got ${afterFirst}`);

    // Second call right after: lastProbe is fresh, must NOT fire fetch again
    healthHandler({}, mockRes());
    healthHandler({}, mockRes());
    healthHandler({}, mockRes());
    await flush();
    await flush();
    assert.equal(
      fetchCalls,
      afterFirst,
      `API-02: subsequent calls within 10s must read from cache — fetch should not have been called again (was ${fetchCalls}, expected ${afterFirst})`
    );
  } finally {
    global.fetch = origFetch;
  }
});

test('API-02 + T-01-14: health body never contains an API key / token / secret', async () => {
  // Configure fake secrets in env; ensure they never leak into the body
  process.env.API_TOKEN = 'super-secret-token-must-not-leak';
  process.env.OLLAMA_API_KEY = 'oll-key-must-not-leak';
  process.env.OCR_SPACE_API_KEY = 'ocs-key-must-not-leak';

  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve({ ok: true, status: 200 });
  try {
    const { healthHandler } = loadFreshHealth();
    const res = mockRes();
    healthHandler({}, res);
    await flush();
    await flush();
    const dump = JSON.stringify(res.captured.body);
    assert.doesNotMatch(dump, /super-secret-token-must-not-leak/);
    assert.doesNotMatch(dump, /oll-key-must-not-leak/);
    assert.doesNotMatch(dump, /ocs-key-must-not-leak/);
    assert.doesNotMatch(dump, /OLLAMA_API_KEY|OCR_SPACE_API_KEY|API_TOKEN/);
  } finally {
    global.fetch = origFetch;
  }
});

test('API-02: probe records reachable boolean and numeric latency_ms after run', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => {
    // Tiny delay so latency_ms > 0
    await new Promise(r => setTimeout(r, 5));
    return { ok: true, status: 200 };
  };
  try {
    const { healthHandler } = loadFreshHealth();

    // Prime the probe
    healthHandler({}, mockRes());
    // Wait for probe to finish
    await new Promise(r => setTimeout(r, 50));

    const res = mockRes();
    healthHandler({}, res);
    assert.equal(res.captured.body.dependencies.ollama.reachable, true);
    assert.equal(typeof res.captured.body.dependencies.ollama.latency_ms, 'number');
    assert.ok(res.captured.body.dependencies.ollama.latency_ms >= 0);
    assert.equal(res.captured.body.dependencies.ocr_space.reachable, true);
    assert.equal(typeof res.captured.body.dependencies.ocr_space.latency_ms, 'number');
  } finally {
    global.fetch = origFetch;
  }
});

test('API-01: healthHandler returns body with dependencies.ollama and dependencies.ocr_space keys', () => {
  const origFetch = global.fetch;
  global.fetch = () => new Promise(() => {});
  try {
    const { healthHandler } = loadFreshHealth();
    const res = mockRes();
    healthHandler({}, res);
    const deps = res.captured.body.dependencies;
    assert.ok(deps.ollama, 'dependencies.ollama required');
    assert.ok(deps.ocr_space, 'dependencies.ocr_space (snake_case) required');
  } finally {
    global.fetch = origFetch;
  }
});
