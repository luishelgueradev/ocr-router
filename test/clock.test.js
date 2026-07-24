const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// The clock seam (lib/clock.js) and the defect it exists to prevent.
//
// Every budget, deadline and duration used to be computed from `Date.now()` —
// the WALL clock, which NTP steps and a VM resume steps. Captured from a real
// failing run of the CASC-08 budget test on this repo, under full-suite load:
//
//   DBG-FAIL stopped_reason=passed elapsed=-791
//   DBG-attempts=[{"engine":"ocrspace-engine2","time_ms":-791,...}]
//
// The clock stepped ~1.1s BACKWARD mid-run, so `remaining = deadline - now`
// INFLATED past minSliceMs and the runner escalated to a tier the budget had
// already spent. It reproduced roughly 1 full-suite run in 3.
//
// These tests step the wall clock backward DELIBERATELY and assert the budget
// still holds. They mock `Date.now` — which, after the fix, production code no
// longer consults for any of this — so they fail loudly if any deadline or
// duration arithmetic ever regresses onto the wall clock.
// ---------------------------------------------------------------------------

const clock = require('../lib/clock');

const ocrPath = require.resolve('../lib/ocr');
require(ocrPath);
const originalRunOCR = require.cache[ocrPath].exports.runOCR;

let scripts = {};
require.cache[ocrPath].exports.runOCR = async (model, base64, mime, key, opts) => {
  const fn = scripts[model.id];
  if (!fn) throw new Error('clock.test: no script for engine ' + model.id);
  return fn(model, base64, mime, key, opts);
};
process.on('beforeExit', () => {
  require.cache[ocrPath].exports.runOCR = originalRunOCR;
});

const { runCascade } = require('../lib/v1/cascade/runner');

const CLEAN = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do';
const okWeak = async () => ({ ok: true, timeMs: 5, text: 'A', overlay: { HasOverlay: true, wordCount: 0 }, ocrExitCode: 1 });
const okClean = async () => ({ ok: true, timeMs: 5, text: CLEAN });

function withKeys(t) {
  const prev = { o: process.env.OCR_SPACE_API_KEY, l: process.env.OLLAMA_API_KEY };
  process.env.OCR_SPACE_API_KEY = 'test-ocrspace-key';
  process.env.OLLAMA_API_KEY = 'test-ollama-key';
  t.after(() => {
    if (prev.o === undefined) delete process.env.OCR_SPACE_API_KEY; else process.env.OCR_SPACE_API_KEY = prev.o;
    if (prev.l === undefined) delete process.env.OLLAMA_API_KEY; else process.env.OLLAMA_API_KEY = prev.l;
    scripts = {};
  });
}

test('clock: monotonicMs never goes backward, even while the wall clock is stepped back', (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  const before = clock.monotonicMs();
  Date.now = () => realNow() - 60_000; // a full minute backward
  const after = clock.monotonicMs();

  assert.ok(after >= before, `monotonic clock moved backward: ${before} -> ${after}`);
  assert.equal(typeof after, 'number');
});

test('clock: wallMs tracks the wall clock — it is the seam for client timestamps only', (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  Date.now = () => 1_234_567_890_000;
  assert.equal(clock.wallMs(), 1_234_567_890_000, 'wallMs is deliberately NOT monotonic');
});

// The reproduction, deterministic: the wall clock jumps backward mid-cascade by
// more than the whole budget. Before the fix this returned stopped_reason
// 'passed' with a NEGATIVE elapsed, having escalated a tier it could not afford.
test('cascade budget survives a backward wall-clock step mid-run (the reproduced defect)', async (t) => {
  withKeys(t);

  let stepped = false;
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  scripts['ocrspace-engine2'] = async () => {
    // Burn most of the budget, then step the wall clock backward 1.1s — the
    // exact shape captured from the flaking run.
    await new Promise((r) => setTimeout(r, 300));
    if (!stepped) {
      stepped = true;
      Date.now = () => realNow() - 1100;
    }
    return okWeak();
  };
  // Must NOT be reached: after 300ms of a 700ms budget only ~400ms remains,
  // which is below minSliceMs (500). A wall-clock-derived `remaining` would
  // have inflated to ~1500ms and let this tier run.
  let escalated = false;
  scripts['ollama-gemini-3-flash'] = async () => { escalated = true; return okClean(); };

  const { trace } = await runCascade({
    base64: 'x',
    mimeType: 'image/png',
    profile: 'balanced',
    deadlineSignal: new AbortController().signal,
    budgetMs: 700,
  });

  assert.ok(stepped, 'the test actually stepped the clock');
  assert.equal(trace.stopped_reason, 'budget_exhausted', 'the budget bound held across the clock step');
  assert.ok(!escalated, 'no tier ran on budget the clock step had fabricated');
});

test('a backward wall-clock step never produces a negative duration in the trace', async (t) => {
  withKeys(t);

  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });

  scripts['ocrspace-engine2'] = async () => {
    await new Promise((r) => setTimeout(r, 50));
    Date.now = () => realNow() - 5000; // 5s backward, mid-engine
    return okClean();
  };

  const { trace } = await runCascade({
    base64: 'x',
    mimeType: 'image/png',
    profile: 'balanced',
    deadlineSignal: new AbortController().signal,
    budgetMs: 5000,
  });

  assert.ok(trace.elapsed_ms >= 0, `job elapsed_ms went negative: ${trace.elapsed_ms}`);
  for (const attempt of trace.engines_attempted) {
    assert.ok(
      attempt.time_ms >= 0,
      `engine ${attempt.engine} reported a negative duration: ${attempt.time_ms}`,
    );
  }
});

test('the per-engine timeout slice is always an integer (AbortSignal.timeout rejects fractions)', async (t) => {
  withKeys(t);

  // A monotonic reading is fractional, so `min(perEngineMs, remaining)` is too.
  // AbortSignal.timeout throws RangeError on a non-integer delay — unlike
  // setTimeout, which coerces silently. Any budget must therefore survive here.
  scripts['ocrspace-engine2'] = okClean;

  for (const budgetMs of [700, 1234, 999, 5001]) {
    const { trace } = await runCascade({
      base64: 'x',
      mimeType: 'image/png',
      profile: 'balanced',
      deadlineSignal: new AbortController().signal,
      budgetMs,
    });
    assert.equal(trace.stopped_reason, 'passed', `budget ${budgetMs} produced a usable timeout slice`);
  }
});
