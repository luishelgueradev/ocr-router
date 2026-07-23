---
phase: 02-cascade-router
plan: 03
subsystem: cascade
tags: [cascade, runner, fall-through, trace, abortsignal, budget, quota, node-test, tdd]

# Dependency graph
requires:
  - phase: 02-cascade-router
    provides: "Plan 01 config.js (profiles/chain/bounds/thresholds) + heuristic.js (computeConfidence/passesThreshold)"
  - phase: 02-cascade-router
    provides: "Plan 02 providers accept a job AbortSignal; ocr.space returns overlay.wordCount + ocrExitCode; ollama abort → ok:false"
  - phase: 01-foundation
    provides: "lib/v1/engines.js (findModel/envKeyFor/providerKeyPresent), lib/v1/errors.js (mapErrorCode), lib/ocr.js (runOCR), lib/models.js"
provides:
  - "lib/v1/cascade/trace.js — pure JOB-02 trace builders (newTrace/recordAttempt/finalizeTrace)"
  - "lib/v1/cascade/runner.js — runCascade({base64,mimeType,profile,deadlineSignal,budgetMs}) → {result, trace}"
  - "The fall-through decision engine: tier-1 stop, escalate-on-low/failure, best-so-far, budget/max-attempts/max-tier bounds, Ollama quota short-circuit, missing-key tier drop"
  - "test/cascade-runner.test.js — mocked-provider fall-through matrix (no keys/network)"
affects: [worker-integration, response-envelope, plan-02-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One authoritative job deadline: per-engine signal = AbortSignal.any([deadlineSignal, AbortSignal.timeout(min(perEngineMs, remaining))]) (JOB-04)"
    - "Declarative routing: chain/bounds/thresholds read from config.js — zero per-engine if/switch in the runner"
    - "Same-account quota short-circuit: on ollama 429/quota, remaining same-provider tiers recorded skipped(reason:provider_quota) and never invoked (D-12)"
    - "Best-so-far tracking so a job never loses work: return highest-confidence ok result marked low_confidence when nothing clears threshold (CASC-04)"
    - "Provider-agnostic orchestration: runner only ever calls runOCR; error surfaces are mapErrorCode CODE strings only (OPS-05)"

key-files:
  created:
    - lib/v1/cascade/trace.js
    - lib/v1/cascade/runner.js
    - test/cascade-runner.test.js
  modified: []

key-decisions:
  - "Profile resolved via Object.hasOwn allowlist defaulting to CONFIG.defaultProfile — never a bare index on a plain object (T-02-08 / Pitfall 5)"
  - "Quota short-circuit fires on BOTH mapErrorCode 'quota_exceeded' (403) and 'rate_limited' (429) since either means the shared Ollama account cap is spent (D-12)"
  - "ocrExitCode===3 (ocr.space all-pages-failed) is treated as a hard failure fall-through even behind ok:true"
  - "A thrown provider is normalized to an ok:false fall-through inside the runner (defense-in-depth) so a crash can never wedge the single-concurrency worker slot"
  - "trace.js is pure data assembly (no provider/axios/fetch imports) so the whole matrix is unit-testable with mocked engine fns"

patterns-established:
  - "require.cache override of lib/ocr#runOCR to script deterministic per-engine outcomes keyed by model.id (mirrors test/worker.test.js); callLog proves skipped tiers were never invoked"
  - "AbortSignal.timeout timers are unref'd (Node 22) so lingering per-engine timeouts never keep node:test alive"

requirements-completed: [CASC-01, CASC-02, CASC-04, CASC-07, CASC-08, JOB-02, JOB-04]

# Metrics
duration: 4min
completed: 2026-07-23
---

# Phase 2 Plan 03: Cascade Runner + Trace Summary

**`runCascade` is the product's core value made real: it walks a profile's declarative chain cheapest-tier-first, judges each result with the pure heuristic, falls through on hard failure OR low confidence, tracks best-so-far so work is never lost, bounds the run by max-attempts + chain length + one authoritative `AbortController` deadline, short-circuits a dead Ollama quota, and emits the full JOB-02 trace — proven end-to-end by a keyless/networkless mocked-provider fall-through matrix.**

## Performance

- **Tasks:** 3 completed (1 auto + 2 TDD red/green)
- **Files created:** 3 (no existing files modified)
- **Suite:** `node --test test/cascade-runner.test.js` → 8/8 pass; full suite **231/231** (was 223 + 8 new)

## Accomplishments
- **Trace (JOB-02):** `lib/v1/cascade/trace.js` — pure `newTrace`/`recordAttempt`/`finalizeTrace` builders assembling `engines_attempted[]{engine,provider,outcome,confidence,time_ms,error,reason?}` + `winning_engine` + `low_confidence` + `budget_ms`/`elapsed_ms` + `stopped_reason`. Every `attempt.error` is coerced to a short code string or null — never an object/stack/secret (OPS-05 / T-02-11). Zero provider imports (grep-verified pure).
- **Runner (CASC-01/02/04/07/08 · JOB-02/JOB-04 · D-12):** `lib/v1/cascade/runner.js` — `runCascade({base64,mimeType,profile,deadlineSignal,budgetMs}) → {result, trace}`:
  - Clean tier-1 doc **stops at ocr.space** (SC#1 — P50 winner is not the top tier).
  - Falls through on **low confidence** and on **hard failure** (`ok:false` / `ocrExitCode:3` / thrown → normalized).
  - **Never loses work:** when nothing clears threshold, returns the highest-confidence ok result marked `low_confidence:true`, `stopped_reason:'all_failed'` (CASC-04).
  - **Missing-key tier drop (CASC-07/D-09):** chain assembled only from `providerKeyPresent` engines — a missing key is a silent drop, not an error; ocr.space alone still serves.
  - **Ollama quota short-circuit (D-12):** on `429`/`quota_exceeded`, the remaining same-provider tiers are recorded `skipped(reason:'provider_quota')` and **never invoked**; best-so-far returned with `stopped_reason:'provider_quota'`.
  - **Bounded (CASC-08/JOB-04):** max-attempts + chain length + one cumulative `deadline = now + budgetMs`; per-engine timeout = `min(perEngineMs, remaining)` composed with the job deadline via `AbortSignal.any` — a hung provider cannot wedge the single worker slot.
  - **Declarative + safe:** chain/bounds/thresholds all read from `config.js` (no per-engine branch); profile resolved via `Object.hasOwn` allowlist (T-02-08).
- **Matrix suite:** `test/cascade-runner.test.js` — 8 named `node:test` cases mocking `lib/ocr#runOCR` via `require.cache`, scripting per-engine outcomes by `model.id` and toggling provider env keys. The quota test asserts (via `callLog`) that the skipped ollama tiers were never called.

## Task Commits

Each task committed atomically:

1. **Task 1: define the JOB-02 trace shape (pure builders)** — `7053707` (feat)
2. **Task 2: RED — failing cascade fall-through matrix** — `ff2a855` (test)
3. **Task 3: GREEN — implement runCascade** — `613a100` (feat)

## TDD Gate Compliance
Gate sequence satisfied for the `type: tdd` plan: RED `test(02-03)` commit `ff2a855` precedes GREEN `feat(02-03)` commit `613a100`. No test passed unexpectedly during RED (the suite failed to load because `runner.js` was absent — the intended RED). No REFACTOR commit needed (implementation landed clean).

## Deviations from Plan
None — plan executed exactly as written. (Task 1's acceptance grep in the plan had an unbalanced quote in the shell snippet; the intent — trace.js imports no provider/axios/fetch modules — was verified directly: `grep -cE "require\(.*(ocr|ollama|axios|providers)" lib/v1/cascade/trace.js` returns 0.)

## Threat Model Compliance
- **T-02-08 (Tampering — profile → chain lookup):** mitigated — `Object.hasOwn(CONFIG.profiles, profile)` allowlist, default to `CONFIG.defaultProfile`; never a bare index.
- **T-02-09 (DoS — runaway cost/quota):** mitigated — maxAttempts + max-tier (chain length) + cumulative `budgetMs` deadline + Ollama same-account short-circuit; 235B only in the `quality` chain.
- **T-02-10 (DoS — hung provider wedging the worker):** mitigated — one `AbortController` deadline via `AbortSignal.any`; per-engine timeout = `min(perEngineMs, remaining)`.
- **T-02-11 (Info disclosure — secret/PII via trace):** mitigated — `trace.error` = `mapErrorCode` code string only; no buffers/keys/raw bodies; overlay carried only for the winner, never surfaced by the trace.
- **T-02-12 (install surface):** accept — zero new packages (native `AbortController`/`AbortSignal.any` + Phase-1 deps).

## Calibration / Ops Note (deferred, not a code blocker)
Live-key calibration of the heuristic thresholds and confirmation of real Ollama Cloud quota headroom remain deferred ops checks (per plan `<output>` and 02-RESEARCH Environment Availability). The runner reacts to the provider *response* (429/quota), not to a hard-coded quota number, so no code change is required when those numbers are confirmed. Worker integration (D-11 — wiring `runCascade` into `lib/v1/worker.js` for the non-forced path and populating the envelope trace) is Plan 02-04.

## Known Stubs
None. Every field in the result/trace is populated from a scored provider outcome and exercised by the matrix suite.

## Self-Check: PASSED
- Files exist: `lib/v1/cascade/trace.js`, `lib/v1/cascade/runner.js`, `test/cascade-runner.test.js` — all confirmed.
- Commits exist: `7053707`, `ff2a855`, `613a100` — all confirmed in git log.
- Suite: `node --test test/cascade-runner.test.js` → 8/8 pass; full suite 231/231, zero regressions.
