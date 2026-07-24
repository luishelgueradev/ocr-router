const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Cascade fall-through MATRIX (CASC-01/02/04/07/08, D-12, JOB-02/JOB-04).
//
// The runner is the fall-through engine; this suite proves the whole decision
// matrix with NO network, NO keys, NO images. We mock lib/ocr#runOCR via
// require.cache (mirroring test/worker.test.js) so each engine's outcome is
// scripted deterministically keyed by model.id, and we toggle provider env
// keys to exercise the missing-key tier drop (providerKeyPresent reads
// process.env dynamically). `callLog` records every model.id runOCR was
// invoked with, so the quota short-circuit can assert the skipped same-provider
// tiers were NEVER called.
// ---------------------------------------------------------------------------

const ocrPath = require.resolve('../lib/ocr');
require(ocrPath); // ensure cached
const originalRunOCR = require.cache[ocrPath].exports.runOCR;

// Mutable per-test script table + invocation log.
let scripts = {};       // { 'ocrspace-engine2': async (model,base64,mime,key,opts) => result }
let callLog = [];       // ordered list of model.id runOCR was called with

require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  callLog.push(model.id);
  const fn = scripts[model.id];
  if (!fn) throw new Error('cascade-runner.test: no script for engine ' + model.id);
  return fn(model, base64, mime, key, opts);
};
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
});

// runner is required AFTER the cache patch so its `require('../ocr')` binds the mock.
const { runCascade } = require('../lib/v1/cascade/runner');

// --- scripted-result helpers ------------------------------------------------
const CLEAN = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do'; // clean, long → conf 1.0
const GARBAGE = '\x00\x01\x02\x03\x04\x05\x06\x07\x00\x01\x02\x03'; // C0 controls → garbage-ratio 1 → conf 0

const okClean = (overlayWords) => async () => ({
  ok: true, timeMs: 5, text: CLEAN,
  ...(overlayWords != null ? { overlay: { HasOverlay: true, wordCount: overlayWords }, ocrExitCode: 1 } : {}),
});
// ocr.space single clean char + overlay wordCount 0 → conf exactly 0.5 (below
// balanced 0.6, above 0) — a MEANINGFUL best-so-far for the all-fail/quota tests.
const okWeak = async () => ({ ok: true, timeMs: 5, text: 'A', overlay: { HasOverlay: true, wordCount: 0 }, ocrExitCode: 1 });
const okGarbage = async () => ({ ok: true, timeMs: 5, text: GARBAGE, overlay: { HasOverlay: false, wordCount: 0 }, ocrExitCode: 1 });
const okEmpty = async () => ({ ok: true, timeMs: 5, text: '' });
const hardFail = async () => ({ ok: false, status: 500, error: 'internal boom' });
const exitCode3 = async () => ({ ok: true, timeMs: 5, text: '', overlay: { HasOverlay: false, wordCount: 0 }, ocrExitCode: 3 });
const quota429 = async () => ({ ok: false, status: 429, error: 'rate limit exceeded' });
const slow = (ms) => async () => { await new Promise(r => setTimeout(r, ms)); return okWeak(); };

// --- env helpers ------------------------------------------------------------
function withKeys({ ocrspace = true, ollama = true } = {}) {
  const prev = { o: process.env.OCR_SPACE_API_KEY, l: process.env.OLLAMA_API_KEY };
  if (ocrspace) process.env.OCR_SPACE_API_KEY = 'test-ocrspace-key'; else delete process.env.OCR_SPACE_API_KEY;
  if (ollama) process.env.OLLAMA_API_KEY = 'test-ollama-key'; else delete process.env.OLLAMA_API_KEY;
  return () => {
    if (prev.o === undefined) delete process.env.OCR_SPACE_API_KEY; else process.env.OCR_SPACE_API_KEY = prev.o;
    if (prev.l === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = prev.l;
  };
}

function reset() { scripts = {}; callLog = []; }
const deadline = () => new AbortController().signal; // never-aborting job signal

// ===========================================================================

// SC#1 / CASC-01: a clean tier-1 doc STOPS at ocr.space (P50 winner is not the top tier).
test('tier-1 stop: clean ocr.space result stops the cascade at the cheap first tier', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = okClean(80);

  const { result, trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.equal(trace.engines_attempted.length, 1, 'only the first tier is attempted');
  assert.equal(trace.winning_engine, 'ocrspace-engine2');
  assert.equal(trace.low_confidence, false);
  assert.equal(trace.stopped_reason, 'passed');
  assert.equal(trace.engines_attempted[0].outcome, 'passed');
  assert.equal(result.engineId, 'ocrspace-engine2');
  assert.equal(result.text, CLEAN, 'winning text is carried in result');
  assert.deepEqual(callLog, ['ocrspace-engine2'], 'no LLM tier was called');
});

// CR-01 regression: a rate-limited FIRST tier (ocr.space) must NOT abort the whole
// cascade — it escalates to the OTHER-provider (Ollama) tiers. Previously the quota
// short-circuit `break` terminated the cascade, violating the "never fail to return"
// core value whenever ocr.space (tier-1 of every chain) was rate-limited.
test('quota at tier-1 (ocr.space 429) escalates to the Ollama tier, not aborts the cascade', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = quota429;        // tier-1 rate-limited (different account)
  scripts['ollama-minimax-m3'] = okClean();  // next-provider tier succeeds

  const { result, trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.ok(callLog.includes('ollama-minimax-m3'), 'must escalate to the Ollama tier after ocr.space quota');
  assert.equal(trace.winning_engine, 'ollama-minimax-m3');
  assert.equal(trace.stopped_reason, 'passed');
  assert.equal(trace.low_confidence, false);
  assert.equal(result.engineId, 'ollama-minimax-m3');
  const ocrspaceAttempt = trace.engines_attempted.find(a => a.engine === 'ocrspace-engine2');
  assert.equal(ocrspaceAttempt.outcome, 'failed', 'ocr.space recorded as a failed (quota) attempt');
});

// CASC-02/CASC-03: garbage at tier-1 ESCALATES to the LLM tier which passes.
test('escalate-on-garbage: low-confidence ocr.space falls through to the passing LLM tier', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = okGarbage;
  scripts['ollama-minimax-m3'] = okClean();

  const { result, trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.equal(trace.engines_attempted[0].outcome, 'low_confidence', 'tier-1 recorded as low_confidence');
  assert.equal(trace.winning_engine, 'ollama-minimax-m3', 'the LLM tier wins');
  assert.equal(trace.stopped_reason, 'passed');
  assert.equal(trace.low_confidence, false);
  assert.equal(result.engineId, 'ollama-minimax-m3');
});

// CASC-02: a hard failure (ok:false OR ocrExitCode:3) ESCALATES.
test('escalate-on-failure: ok:false at tier-1 escalates (outcome failed)', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = hardFail;
  scripts['ollama-minimax-m3'] = okClean();

  const { trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.equal(trace.engines_attempted[0].outcome, 'failed', 'hard failure recorded as failed');
  assert.equal(typeof trace.engines_attempted[0].error, 'string', 'error is a code string, never an object (OPS-05)');
  assert.equal(trace.winning_engine, 'ollama-minimax-m3');
  assert.equal(trace.stopped_reason, 'passed');
});

test('escalate-on-failure: ocrExitCode:3 (all pages failed) is a hard failure despite ok:true', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = exitCode3;
  scripts['ollama-minimax-m3'] = okClean();

  const { trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.equal(trace.engines_attempted[0].outcome, 'failed', 'OCRExitCode 3 → failed');
  assert.equal(trace.winning_engine, 'ollama-minimax-m3');
});

// CASC-04: when nothing clears threshold, return BEST-SO-FAR marked low_confidence (never lose work).
test('all-fail-best: no tier passes ⇒ best-so-far returned with low_confidence:true', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = okWeak;            // conf 0.5 — the highest observed
  scripts['ollama-minimax-m3'] = okEmpty;      // conf 0
  scripts['ollama-gemma4-31b'] = hardFail;         // failed

  const { result, trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.equal(trace.stopped_reason, 'all_failed');
  assert.equal(trace.low_confidence, true, 'nothing cleared threshold → low_confidence');
  assert.equal(trace.winning_engine, 'ocrspace-engine2', 'best-so-far = highest observed confidence');
  assert.equal(result.text, 'A', 'work is NOT lost — best text is returned');
  assert.ok(result.confidence > 0, 'best-so-far confidence preserved');
  // maxAttempts bound: non-skipped attempts never exceed the profile cap (CASC-08).
  const attempted = trace.engines_attempted.filter(a => a.outcome !== 'skipped').length;
  assert.ok(attempted <= 3, 'attempts within balanced.maxAttempts (3)');
});

// D-12: an ollama 429/quota SHORT-CIRCUITS the remaining same-provider tiers (they are NOT called).
test('quota-short-circuit: ollama 429 skips remaining ollama tiers (uncalled) and returns best-so-far', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = okWeak;            // conf 0.5 (best-so-far)
  scripts['ollama-minimax-m3'] = quota429;     // 429 → short-circuit
  scripts['ollama-gemma4-31b'] = okClean();         // MUST NOT be called
  scripts['ollama-qwen35-397b'] = okClean();      // MUST NOT be called

  const { result, trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'quality', deadlineSignal: deadline(), budgetMs: 120000 });

  assert.equal(trace.stopped_reason, 'provider_quota');
  assert.ok(!callLog.includes('ollama-gemma4-31b'), 'gemma NOT invoked after quota');
  assert.ok(!callLog.includes('ollama-qwen35-397b'), 'qwen NOT invoked after quota');
  const skipped = trace.engines_attempted.filter(a => a.outcome === 'skipped');
  assert.ok(skipped.length >= 2, 'remaining ollama tiers recorded as skipped');
  assert.ok(skipped.every(a => a.reason === 'provider_quota'), 'skip reason is provider_quota');
  assert.equal(trace.winning_engine, 'ocrspace-engine2', 'best-so-far returned');
  assert.equal(trace.low_confidence, true);
  assert.equal(result.text, 'A');
});

// CASC-07 / D-09: a missing provider key is a SILENT tier drop, not an error.
test('missing-key-drop: absent ollama key drops the ollama tiers; ocr.space alone serves', async (t) => {
  const restore = withKeys({ ocrspace: true, ollama: false }); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = okClean(80);

  const { result, trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 60000 });

  assert.equal(trace.engines_attempted.length, 1, 'ollama tiers silently dropped from the chain');
  assert.ok(!trace.engines_attempted.some(a => a.provider === 'ollama'), 'no ollama tier appears in the trace');
  assert.ok(!callLog.some(id => id.startsWith('ollama-')), 'no ollama engine was invoked');
  assert.equal(trace.winning_engine, 'ocrspace-engine2');
  assert.equal(result.engineId, 'ocrspace-engine2');
});

// CASC-08 / JOB-04: the cumulative budget bounds the run (stopped_reason budget_exhausted).
test('budget-exhausted: a slow provider that would exceed budgetMs stops with budget_exhausted', async (t) => {
  const restore = withKeys(); reset();
  t.after(() => { restore(); reset(); });
  scripts['ocrspace-engine2'] = slow(300);         // consumes most of the tiny budget, returns low-conf
  scripts['ollama-minimax-m3'] = okClean();     // must NOT be reached (budget gone)

  const started = Date.now();
  const { trace } = await runCascade({ base64: 'x', mimeType: 'image/png', profile: 'balanced', deadlineSignal: deadline(), budgetMs: 700 });
  const elapsed = Date.now() - started;

  assert.equal(trace.stopped_reason, 'budget_exhausted');
  assert.ok(!callLog.includes('ollama-minimax-m3'), 'no further tier called after budget exhausted');
  assert.ok(elapsed < 700 + 500, 'runner does not blow far past the budget');
});
