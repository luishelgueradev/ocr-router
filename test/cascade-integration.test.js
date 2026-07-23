// End-to-end cascade integration (CASC-05/CASC-06, JOB-02/JOB-04, API-05).
//
// Exercises the LIVE router + worker + runner path with NO keys/network: runOCR
// is mocked on lib/ocr via require.cache and scripted per-engine by model.id
// (mirrors test/cascade-runner.test.js + test/v1-routes.test.js). A real Express
// app boots on port 0; we POST multipart to /v1/ocr and poll /v1/jobs/:id to a
// terminal state, asserting the envelope trace, profile selection, forced bypass,
// capability/profile 422s, and profiles discovery.
//
// Scenarios: (a) clean tier-1 stop, (b) escalate-on-garbage, (c) all-fail
// best-so-far, (d) profile selection (fast vs default balanced), (e) forced
// bypass (single attempt, no escalation), (f) 422s (unknown model/profile),
// (g) GET /v1/models profiles discovery without thresholds.

process.env.API_TOKEN = process.env.API_TOKEN || 'cascade-int-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || 'cascade-int-ollama-key';
process.env.OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'cascade-int-ocrspace-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// --- mock runOCR (keyed by model.id) BEFORE requiring the router -------------
const ocrPath = require.resolve('../lib/ocr');
require(ocrPath); // ensure cached
const originalRunOCR = require.cache[ocrPath].exports.runOCR;

let scripts = {};   // { 'ocrspace-engine2': async (model,...) => result }
let callLog = [];   // ordered model.id list runOCR was invoked with

require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  callLog.push(model.id);
  const fn = scripts[model.id];
  if (!fn) return { ok: false, status: 500, error: 'unscripted engine ' + model.id };
  return fn(model, base64, mime, key, opts);
};
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
});

const router = require('../lib/v1/router');

// --- scripted-result helpers -------------------------------------------------
const CLEAN = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'; // conf 1.0
const GARBAGE = '\x00\x01\x02\x03\x04\x05\x06\x07\x00\x01\x02\x03';            // conf 0

const okClean = () => async () => ({ ok: true, timeMs: 5, text: CLEAN });
const okWeak = async () => ({ ok: true, timeMs: 5, text: 'A', overlay: { HasOverlay: true, wordCount: 0 }, ocrExitCode: 1 }); // conf 0.5
const okGarbage = async () => ({ ok: true, timeMs: 5, text: GARBAGE, overlay: { HasOverlay: false, wordCount: 0 }, ocrExitCode: 1 }); // conf 0
const okEmpty = async () => ({ ok: true, timeMs: 5, text: '' });               // conf 0
const hardFail = async () => ({ ok: false, status: 500, error: 'internal boom' });

function reset() { scripts = {}; callLog = []; }

// --- app / http helpers ------------------------------------------------------
const TOKEN = process.env.API_TOKEN;

function makeApp() {
  const app = express();
  app.use('/v1', router);
  return app;
}
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
    server.on('error', reject);
  });
}
function pngBuffer(extra = 16) {
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([header, Buffer.alloc(extra, 0xAA)]);
}
function buildMultipart({ buffer, mimetype = 'image/png', model, mode, profile, filename = 'test.png' }) {
  const boundary = '----int-' + Math.random().toString(36).slice(2);
  const parts = [];
  if (buffer !== undefined) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`
    ));
    parts.push(buffer);
    parts.push(Buffer.from('\r\n'));
  }
  const field = (name, value) => parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  ));
  if (model !== undefined) field('model', model);
  if (mode !== undefined) field('mode', mode);
  if (profile !== undefined) field('profile', profile);
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function submit(url, opts) {
  const { body, contentType } = buildMultipart(opts);
  return fetch(`${url}/v1/ocr`, { method: 'POST', headers: { 'content-type': contentType }, body });
}

// Poll the job to a terminal state (succeeded|failed) or throw on timeout.
async function pollJob(url, jobId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${url}/v1/jobs/${jobId}`);
    const rec = await res.json();
    if (rec.status === 'succeeded' || rec.status === 'failed') return rec;
    if (Date.now() > deadline) throw new Error('job did not finish: ' + JSON.stringify(rec));
    await new Promise(r => setTimeout(r, 15));
  }
}

// ===========================================================================
// (a) no-model clean tier-1 → stops at ocr.space, trace present, conf number
// ===========================================================================
test('(a) no-model clean tier-1 stops at ocr.space with a populated trace + confidence', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  reset();
  scripts['ocrspace-engine2'] = okClean();
  t.after(() => { reset(); return new Promise(r => server.close(r)); });

  const post = await submit(url, { buffer: pngBuffer() }); // no model, no profile → cascade + balanced
  assert.equal(post.status, 202, 'cascade POST is accepted');
  const { job_id } = await post.json();
  const rec = await pollJob(url, job_id);

  assert.equal(rec.status, 'succeeded');
  assert.ok(rec.result.trace, 'result carries the JOB-02 trace');
  assert.equal(rec.result.trace.profile, 'balanced', 'unspecified request defaults to balanced');
  assert.equal(rec.result.trace.winning_engine, 'ocrspace-engine2');
  assert.equal(rec.result.trace.engines_attempted.length, 1, 'clean tier-1 → only one attempt');
  assert.equal(rec.result.trace.low_confidence, false);
  assert.equal(rec.result.low_confidence, false, 'envelope low_confidence mirrors the trace');
  assert.equal(typeof rec.result.pages[0].confidence, 'number', 'pages[0].confidence is a number');
  assert.ok(rec.result.pages[0].confidence > 0);
  assert.equal(rec.result.pages[0].engine, 'ocrspace-engine2');
  assert.deepEqual(callLog, ['ocrspace-engine2'], 'no LLM tier was called');
});

// ===========================================================================
// (b) no-model garbage tier-1 → escalates to the passing LLM tier
// ===========================================================================
test('(b) no-model garbage tier-1 escalates to the LLM tier (low_confidence first attempt)', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  reset();
  scripts['ocrspace-engine2'] = okGarbage;
  scripts['ollama-gemini-3-flash'] = okClean();
  t.after(() => { reset(); return new Promise(r => server.close(r)); });

  const post = await submit(url, { buffer: pngBuffer() });
  const { job_id } = await post.json();
  const rec = await pollJob(url, job_id);

  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.result.trace.engines_attempted[0].outcome, 'low_confidence', 'tier-1 recorded low_confidence');
  assert.equal(rec.result.trace.winning_engine, 'ollama-gemini-3-flash', 'the LLM tier wins');
  assert.equal(rec.result.trace.low_confidence, false);
  assert.equal(rec.result.pages[0].engine, 'ollama-gemini-3-flash');
});

// ===========================================================================
// (c) all-fail scripted → never lost: best-so-far returned, low_confidence true
// ===========================================================================
test('(c) all-fail cascade still succeeds with best-so-far + low_confidence:true', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  reset();
  scripts['ocrspace-engine2'] = okWeak;        // conf 0.5 (best-so-far)
  scripts['ollama-gemini-3-flash'] = okEmpty;  // conf 0
  scripts['ollama-gemma4-31b'] = hardFail;     // failed
  t.after(() => { reset(); return new Promise(r => server.close(r)); });

  const post = await submit(url, { buffer: pngBuffer() });
  const { job_id } = await post.json();
  const rec = await pollJob(url, job_id);

  assert.equal(rec.status, 'succeeded', 'work is never lost — job still succeeds');
  assert.equal(rec.result.low_confidence, true);
  assert.equal(rec.result.trace.low_confidence, true);
  assert.equal(rec.result.trace.stopped_reason, 'all_failed');
  assert.equal(rec.result.trace.winning_engine, 'ocrspace-engine2', 'best-so-far = highest confidence seen');
  assert.equal(rec.result.text, 'A', 'best-so-far text is preserved on the envelope');
});

// ===========================================================================
// (d) profile selection: 'fast' uses the short chain; unspecified → balanced
// ===========================================================================
test('(d) profile:fast selects the short chain (default is balanced)', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  reset();
  scripts['ocrspace-engine2'] = okGarbage;         // escalate
  scripts['ollama-gemini-3-flash'] = okClean();    // fast chain ends here
  t.after(() => { reset(); return new Promise(r => server.close(r)); });

  const post = await submit(url, { buffer: pngBuffer(), profile: 'fast' });
  const { job_id } = await post.json();
  const rec = await pollJob(url, job_id);

  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.result.trace.profile, 'fast', 'the fast profile was selected');
  assert.equal(rec.result.trace.winning_engine, 'ollama-gemini-3-flash');
  const engines = rec.result.trace.engines_attempted.map(a => a.engine);
  assert.ok(!engines.includes('ollama-gemma4-31b'), 'fast chain never reaches gemma');
  assert.ok(!engines.includes('ollama-qwen3-vl-235b'), 'fast chain never reaches qwen');
  assert.ok(!callLog.includes('ollama-gemma4-31b'), 'gemma was not invoked under fast');
});

// ===========================================================================
// (e) forced model → single-attempt bypass, NO escalation even when low-conf
// ===========================================================================
test('(e) forced model bypasses the cascade (single attempt, no escalation)', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  reset();
  // Force ocr.space and script it LOW-confidence: a cascade would escalate, but
  // a forced engine must run exactly once (D-07). Provide a higher tier too to
  // prove it is never called.
  scripts['ocrspace-engine2'] = okWeak;            // conf 0.5 (< balanced 0.6)
  scripts['ollama-gemini-3-flash'] = okClean();    // MUST NOT be called
  t.after(() => { reset(); return new Promise(r => server.close(r)); });

  const post = await submit(url, { buffer: pngBuffer(), model: 'ocrspace-engine2' });
  assert.equal(post.status, 202);
  const { job_id } = await post.json();
  const rec = await pollJob(url, job_id);

  assert.equal(rec.status, 'succeeded');
  assert.equal(rec.result.trace.engines_attempted.length, 1, 'forced ⇒ exactly one attempt');
  assert.equal(rec.result.trace.winning_engine, 'ocrspace-engine2');
  assert.equal(rec.result.trace.low_confidence, true, 'low confidence recorded but NOT escalated');
  assert.equal(rec.result.trace.stopped_reason, 'forced');
  assert.equal(typeof rec.result.pages[0].confidence, 'number');
  assert.deepEqual(callLog, ['ocrspace-engine2'], 'no escalation — only the forced engine ran');
});

// ===========================================================================
// (f) capability/profile 422s — concretely reachable, pre-enqueue
// ===========================================================================
test('(f) unknown forced model → 422 field=model; unknown profile → 422 field=profile', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  reset();
  t.after(() => { reset(); return new Promise(r => server.close(r)); });

  // unknown model id (concretely reachable capability rejection, pre-enqueue)
  const badModel = await submit(url, { buffer: pngBuffer(), model: 'no-such-engine' });
  assert.equal(badModel.status, 422);
  const bm = await badModel.json();
  assert.equal(bm.error, 'invalid_parameter');
  assert.equal(bm.field, 'model');

  // unknown profile
  const badProfile = await submit(url, { buffer: pngBuffer(), profile: 'bogus' });
  assert.equal(badProfile.status, 422);
  const bp = await badProfile.json();
  assert.equal(bp.field, 'profile');

  // prototype-pollution profile key is rejected via the Object.hasOwn allowlist
  const proto = await submit(url, { buffer: pngBuffer(), profile: '__proto__' });
  assert.equal(proto.status, 422, '__proto__ is not an own profile key → 422');
  assert.equal((await proto.json()).field, 'profile');

  // the buffer was never enqueued for any of these — no runOCR invocation
  assert.deepEqual(callLog, [], 'rejected requests never reach the worker');
});

// ===========================================================================
// (g) GET /v1/models profiles discovery — no threshold leakage
// ===========================================================================
test('(g) GET /v1/models advertises profiles (id/default/description/engines) without thresholds', async (t) => {
  const app = makeApp();
  const { server, url } = await listen(app);
  t.after(() => new Promise(r => server.close(r)));

  const res = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(Array.isArray(body.models), 'models projection unchanged (API-03)');
  assert.ok(Array.isArray(body.profiles), 'profiles array present (API-05)');
  const ids = body.profiles.map(p => p.id).sort();
  assert.deepEqual(ids, ['balanced', 'fast', 'quality'], 'all three profiles advertised');

  const defaults = body.profiles.filter(p => p.default === true);
  assert.equal(defaults.length, 1, 'exactly one default profile');
  assert.equal(defaults[0].id, 'balanced', 'balanced is the default');

  for (const p of body.profiles) {
    assert.equal(typeof p.description, 'string', 'each profile has a description');
    assert.ok(Array.isArray(p.engines), 'each profile lists its chain engine ids');
    assert.ok(p.engines.includes('ocrspace-engine2'), 'chains start at the cheap tier');
    assert.ok(!('threshold' in p), 'threshold numbers are NEVER exposed (T-02-15)');
  }
  // Hard guarantee: no threshold key leaks anywhere in the profiles payload.
  assert.ok(!JSON.stringify(body.profiles).includes('threshold'), 'no threshold field in profiles JSON');
});
