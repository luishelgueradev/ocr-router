// lib/v1/cascade/runner.js
//
// CASC-01/02/04/07/08 · JOB-02 · JOB-04 · D-04/D-09/D-10/D-12 — the cascade
// RUNNER. This is the product's core value: walk a profile's chain cheapest
// tier first, judge each result with the pure heuristic, FALL THROUGH on hard
// failure OR low confidence, track best-so-far so work is never lost, bound the
// run by max-attempts + chain length + one authoritative time budget, short-
// circuit a dead Ollama quota, and emit the full JOB-02 trace.
//
// Provider-agnostic: it only ever calls runOCR (lib/ocr.js). Declarative: the
// chain, thresholds and bounds all come from config.js — there is no per-engine
// `if`/`switch` here. Security: the profile is resolved via an Object.hasOwn
// allowlist (T-02-08, never a bare index), and nothing leaks buffers/keys —
// trace errors are mapErrorCode CODE strings only (OPS-05 / T-02-11).

const CONFIG = require('./config');
const { computeConfidence, passesThreshold } = require('./heuristic');
const { newTrace, recordAttempt, finalizeTrace } = require('./trace');
const { findModel, envKeyFor, providerKeyPresent } = require('../engines');
const { mapErrorCode } = require('../errors');
const { runOCR } = require('../../ocr');
const clock = require('../../clock');

// Provider error codes that mean "this account's quota is spent" — every
// same-provider tier shares one key, so hammering them just burns budget (D-12).
const QUOTA_CODES = new Set(['quota_exceeded', 'rate_limited']);

// Shape the winner (or best-so-far) into the result the worker attaches to the
// page-aware envelope. overlay stays internal — only carried for the winner.
function makeResult(best) {
  if (!best) {
    return { text: '', engineId: null, provider: null, confidence: null };
  }
  const r = { text: best.text, engineId: best.engineId, provider: best.provider, confidence: best.confidence };
  if (best.overlay !== undefined) r.overlay = best.overlay;
  return r;
}

async function runCascade({ base64, mimeType, profile, deadlineSignal, budgetMs } = {}) {
  // --- Resolve profile via allowlist (T-02-08 / Pitfall 5) -------------------
  const profileName =
    typeof profile === 'string' && Object.hasOwn(CONFIG.profiles, profile)
      ? profile
      : CONFIG.defaultProfile;
  const prof = CONFIG.profiles[profileName];
  const effectiveBudget = typeof budgetMs === 'number' ? budgetMs : prof.budgetMs;

  const trace = newTrace({ profile: profileName, budgetMs: effectiveBudget });
  // Monotonic: a wall-clock step must never move this deadline (see lib/clock.js).
  const start = clock.monotonicMs();
  const deadline = start + effectiveBudget;

  // --- Chain assembly (D-09 / CASC-07): only present-key engines ------------
  // A missing provider key is a SILENT tier drop, not an error.
  const chain = prof.chain
    .map(id => findModel(id))
    .filter(m => m && providerKeyPresent(m.provider));

  // Defensive: zero engines only if nothing is configured (boot guard already
  // prevents this) — fail typed rather than throw.
  if (chain.length === 0) {
    finalizeTrace(trace, {
      winningEngine: null,
      lowConfidence: true,
      stoppedReason: 'no_engine_configured',
      elapsedMs: Math.round(clock.monotonicMs() - start),
    });
    return {
      result: { text: '', engineId: null, provider: null, confidence: null, error: 'no_engine_configured' },
      trace,
    };
  }

  let best = null;                 // highest-confidence ok result seen so far
  let attempts = 0;
  let stoppedReason = null;
  const skippedProviders = new Set();

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];

    // Same-account quota short-circuit already tripped for this provider (D-12).
    if (skippedProviders.has(model.provider)) {
      recordAttempt(trace, {
        engine: model.id, provider: model.provider, outcome: 'skipped',
        confidence: null, timeMs: 0, error: null, reason: 'provider_quota',
      });
      continue;
    }

    // Bound: max-attempts (CASC-08).
    if (attempts >= prof.maxAttempts) { stoppedReason = 'max_attempts'; break; }

    // Bound: cumulative budget (CASC-08 / JOB-04). Too little left to try → stop.
    const remaining = deadline - clock.monotonicMs();
    if (remaining <= CONFIG.minSliceMs) { stoppedReason = 'budget_exhausted'; break; }

    // Single authoritative deadline: per-engine timeout = min(perEngineMs,
    // remaining), composed with the job deadline signal (JOB-04 / Pitfall 3).
    // FLOOR, for two reasons. `AbortSignal.timeout()` rejects a non-integer
    // delay outright (RangeError ERR_OUT_OF_RANGE) and `remaining` is now
    // fractional because it comes from a monotonic reading — unlike setTimeout,
    // which quietly coerces. And rounding DOWN is the only safe direction: the
    // slice must never outlast the budget it was carved from.
    const perEngineMs = Math.floor(Math.min(CONFIG.perEngineMs, remaining));
    const timeoutSignal = AbortSignal.timeout(perEngineMs);
    const signal = deadlineSignal
      ? AbortSignal.any([deadlineSignal, timeoutSignal])
      : timeoutSignal;

    attempts += 1;
    const engStart = clock.monotonicMs();
    let res;
    try {
      res = await runOCR(model, base64, mimeType, envKeyFor(model.provider), { signal });
    } catch (e) {
      // A thrown provider is normalized to a hard-failure fall-through — never
      // let it wedge the run. Only a code string reaches the trace (OPS-05).
      res = { ok: false, error: (e && e.message) || 'provider_error' };
    }
    const timeMs = Math.round(clock.monotonicMs() - engStart);

    // --- Hard failure (error / 5xx / abort) → fall through -------------------
    if (!res || res.ok === false) {
      const { code } = mapErrorCode(res || {});
      recordAttempt(trace, {
        engine: model.id, provider: model.provider, outcome: 'failed',
        confidence: null, timeMs, error: code,
      });
      // Same-account quota (429/quota): mark this provider spent and skip its
      // remaining tiers (recorded at the top of the loop) — but CONTINUE to
      // OTHER-provider tiers. A rate-limited ocr.space (tier 1 of every chain)
      // must still escalate to the Ollama LLM tiers, or the cascade would return
      // degraded text while a different-account provider would have succeeded
      // (CR-01 — this is the product's "never fail to return" core value).
      // `stoppedReason` is provisional here: a later passing tier clears it, a
      // bound overwrites it, and it only surfaces if best-so-far is ultimately
      // returned (D-12 / Pitfall 2).
      if (QUOTA_CODES.has(code)) {
        skippedProviders.add(model.provider);
        stoppedReason = 'provider_quota';
        continue;
      }
      continue;
    }

    // ocr.space "all pages failed" is a hard failure even behind ok:true.
    if (res.ocrExitCode === 3) {
      recordAttempt(trace, {
        engine: model.id, provider: model.provider, outcome: 'failed',
        confidence: null, timeMs, error: 'ocr_all_pages_failed',
      });
      continue;
    }

    // --- Score the result ---------------------------------------------------
    const confidence = computeConfidence(res.text, { overlay: res.overlay });

    if (passesThreshold(confidence, profileName)) {
      recordAttempt(trace, {
        engine: model.id, provider: model.provider, outcome: 'passed',
        confidence, timeMs, error: null,
      });
      best = { engineId: model.id, provider: model.provider, text: res.text, overlay: res.overlay, confidence };
      finalizeTrace(trace, {
        winningEngine: model.id, lowConfidence: false,
        stoppedReason: 'passed', elapsedMs: Math.round(clock.monotonicMs() - start),
      });
      return { result: makeResult(best), trace };
    }

    // Below threshold — record + update best-so-far (never lose the work).
    recordAttempt(trace, {
      engine: model.id, provider: model.provider, outcome: 'low_confidence',
      confidence, timeMs, error: null,
    });
    if (!best || confidence > best.confidence) {
      best = { engineId: model.id, provider: model.provider, text: res.text, overlay: res.overlay, confidence };
    }
  }

  // Nothing cleared the threshold. Return best-so-far marked low_confidence
  // (CASC-04). If the loop ended without hitting a bound, the reason is
  // all_failed.
  if (!stoppedReason) stoppedReason = 'all_failed';
  finalizeTrace(trace, {
    winningEngine: best ? best.engineId : null,
    lowConfidence: true,
    stoppedReason,
    elapsedMs: Math.round(clock.monotonicMs() - start),
  });
  return { result: makeResult(best), trace };
}

module.exports = { runCascade };
