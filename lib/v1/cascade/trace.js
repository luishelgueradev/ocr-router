// lib/v1/cascade/trace.js
//
// JOB-02 / D-10 — the cascade TRACE. Pure data builders so runner.js stays
// readable: no I/O, no provider/axios/fetch imports, no keys/buffers. Every
// attempt records only codes + timings + confidence (OPS-05 / T-02-11): an
// attempt.error is ALWAYS a short code string (e.g. 'quota_exceeded') or null,
// never an Error object, stack, or raw provider body.
//
// Shape (RESEARCH §PRIORITY 5):
//   {
//     profile, budget_ms, elapsed_ms,
//     engines_attempted: [ { engine, provider, outcome, confidence, time_ms, error, reason? } ],
//     winning_engine, low_confidence, stopped_reason
//   }
//   outcome        ∈ { passed | low_confidence | failed | skipped }
//   stopped_reason ∈ { passed | budget_exhausted | max_attempts | all_failed |
//                      provider_quota | no_engine_configured | forced }
//     (reconciled with actual producers — IN-04. 'max_tier' is not emitted;
//      'max_attempts' is currently unreachable while maxAttempts == chain length,
//      see PENDING-ISSUES IN-03.)
//   reason (skipped only) e.g. 'provider_quota'

// newTrace — a fresh trace with an empty attempt list and null job-level fields.
function newTrace({ profile, budgetMs } = {}) {
  return {
    profile: profile ?? null,
    engines_attempted: [],
    winning_engine: null,
    low_confidence: false,
    budget_ms: budgetMs ?? null,
    elapsed_ms: 0,
    stopped_reason: null,
  };
}

// recordAttempt — push a normalized attempt record. `error` is coerced to a
// string code or null (never an object — OPS-05); a `reason` is included only
// when provided (skipped tiers carry e.g. 'provider_quota').
function recordAttempt(trace, { engine, provider, outcome, confidence, timeMs, error, reason } = {}) {
  const attempt = {
    engine: engine ?? null,
    provider: provider ?? null,
    outcome: outcome ?? null,
    confidence: typeof confidence === 'number' ? confidence : null,
    time_ms: typeof timeMs === 'number' ? timeMs : null,
    // Defensive: only ever a string or null — never leak an Error/stack/secret.
    error: typeof error === 'string' ? error : null,
  };
  if (reason != null) attempt.reason = String(reason);
  trace.engines_attempted.push(attempt);
  return attempt;
}

// finalizeTrace — set the job-level summary fields once the walk is done.
function finalizeTrace(trace, { winningEngine, lowConfidence, stoppedReason, elapsedMs } = {}) {
  trace.winning_engine = winningEngine ?? null;
  trace.low_confidence = Boolean(lowConfidence);
  trace.stopped_reason = stoppedReason ?? null;
  if (typeof elapsedMs === 'number') trace.elapsed_ms = elapsedMs;
  return trace;
}

module.exports = { newTrace, recordAttempt, finalizeTrace };
