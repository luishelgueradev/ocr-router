---
phase: 02-cascade-router
plan: 04
subsystem: api
tags: [cascade, worker, router, profiles, forced-bypass, trace, envelope, discovery, node-test]

# Dependency graph
requires:
  - phase: 02-cascade-router
    provides: "Plan 01 config.js (profiles/chain/capabilities/thresholds) + heuristic.js (computeConfidence/passesThreshold)"
  - phase: 02-cascade-router
    provides: "Plan 03 runner.js (runCascade → {result, trace}) + trace.js (newTrace/recordAttempt/finalizeTrace)"
  - phase: 01-foundation
    provides: "lib/v1/worker.js envelope, lib/v1/router.js forced-model + HR-01 guard, lib/v1/engines.js, lib/v1/modes.js, lib/v1/jobs.js"
provides:
  - "Cascade wired into the live /v1 path: no-model POST auto-escalates via runCascade; the page-aware envelope carries the JOB-02 trace + populated confidence"
  - "Named profiles (fast/balanced/quality) selectable per request; balanced default via Object.hasOwn allowlist"
  - "Forced-engine bypass (single attempt, no escalation) + capability/key 422 rejection pre-enqueue"
  - "GET /v1/models profiles discovery (id/default/description/engines) — completes API-05"
  - "package.json test script registers all four Phase-2 suites → npm test runs whole (242 green)"
affects: [phase-03-pdf-multiformat, phase-04-structured-mode]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One authoritative job deadline in the worker: AbortController + unref'd setTimeout(budgetMs) threaded into runCascade as deadlineSignal (JOB-04)"
    - "Forced vs cascade branch in runJob keyed on model presence; forced logging kept byte-identical to Phase-1 (OBSV-03/05 allow-lists intact)"
    - "Prototype-pollution-safe request routing: profile + capability lookups via Object.hasOwn allowlist, never a bare index (T-02-13)"
    - "Additive envelope evolution: trace + low_confidence + computed confidence added without renaming/removing any Phase-1 key (Pitfall 6)"

key-files:
  created:
    - test/cascade-integration.test.js
  modified:
    - lib/v1/worker.js
    - lib/v1/router.js
    - test/worker.test.js
    - package.json

key-decisions:
  - "runJob treats model-present as the forced path (forced flag is belt-and-suspenders) so the existing worker.test.js — which passes a model but no forced flag — exercises the bypass and now asserts a computed confidence"
  - "Forced path is judged against the resolved profile threshold for the low_confidence flag but NEVER escalates (stopped_reason:'forced', exactly one trace attempt)"
  - "Cascade path completes (succeeds) on all-fail with best-so-far; only zero-engines-configured (result.error) fails the job — the product never loses work"
  - "Capability-422 is a concretely-reachable pre-enqueue rejection: unknown model id (findModel), model absent from the capability allowlist, or unsupported mode (resolveMode) — no vacuous assertion"
  - "profiles discovery projects id/default/description/engines only; thresholds are asserted absent from the JSON (T-02-15)"
  - "resolveDefaultEngine removed — the cascade path no longer pre-resolves a single default engine (CASC-07 missing-key tier drop is owned by the runner)"

requirements-completed: [CASC-05, CASC-06, JOB-02, JOB-04]

# Metrics
duration: 4min
completed: 2026-07-23
---

# Phase 2 Plan 04: Cascade Integration (Worker + Router) Summary

**The cascade is now user-observable end-to-end: an image POST with no model auto-escalates through the profile chain and returns the best result plus a JOB-02 trace, a client can pick a profile or force a capability-validated engine (bypassing the cascade), and GET /v1/models advertises the profiles — all without breaking a single Phase-1 test (full suite 242 green).**

## Performance
- **Tasks:** 3 completed (all `type=auto`)
- **Files:** 1 created, 4 modified
- **Suite:** `node --test test/cascade-integration.test.js` → 7/7; full `npm test` → **242 pass / 0 fail** (237 main run + 5 verify-redaction), up from 231 with the 4 Phase-2 suites now registered

## Accomplishments
- **Worker integration (D-11, Task 1):** `runJob` branches on model presence. FORCED → keeps the single `runOCR` call, computes confidence on the winning text, records a one-element trace (`outcome` passed|low_confidence, `stopped_reason:'forced'`), and NEVER escalates. NO-MODEL → builds one authoritative `AbortController` deadline (`budgetMs` from the resolved profile, unref'd timer), calls `runCascade`, and assembles the UNCHANGED page-aware envelope from the winner — `pages[0].confidence` populated, `trace` + `low_confidence` attached additively. Forced-path logging is byte-identical to Phase 1, so the OBSV-03/05 allow-list tests stay green.
- **Router (D-06/D-07, Task 2):** profile resolved via `Object.hasOwn(CONFIG.profiles, …)` (default balanced); unknown/`__proto__` profile → typed 422 `field:profile`. Forced model keeps `findModel` + HR-01 key guard, adds a capability-table allowlist gate, and passes `forced:true` + the resolved model into `runJob`. No-model requests route to the cascade (`forced:false` + `profile`), with `resolveDefaultEngine` removed. `GET /v1/models` gains a `profiles` array (id/default/description/engines) — thresholds never projected.
- **Integration suite + registration (Task 3):** `test/cascade-integration.test.js` boots a real Express app with mocked providers (keyless) and proves the live router→worker→runner path across seven scenarios (clean tier-1 stop, escalate-on-garbage, all-fail best-so-far, fast-vs-balanced selection, forced single-attempt bypass, unknown-model/unknown-profile/`__proto__` 422s, profiles discovery without thresholds). `package.json` now registers `cascade-heuristic`, `provider-signal`, `cascade-runner`, and `cascade-integration` so `npm test` runs the whole phase.

## Task Commits
1. **Task 1: integrate runner into worker (forced bypass vs cascade)** — `f96b326` (feat)
2. **Task 2: router profile selection, capability 422, profiles discovery** — `cda541c` (feat)
3. **Task 3: e2e integration suite + register Phase-2 tests** — `069561e` (test)

## Deviations from Plan
None — plan executed exactly as written. The `forced` flag is honored, but `runJob` also treats a supplied `model` as forced (belt-and-suspenders) so the pre-existing `test/worker.test.js` case — which passes a model without the new flag — correctly exercises the bypass path per the plan's Task 1 note.

## Threat Model Compliance
- **T-02-13 (Tampering — profile/model key lookup):** mitigated — profile via `Object.hasOwn` allowlist, model via `findModel` + capability-table `Object.hasOwn` gate; unknown/`__proto__` → typed 422; never a bare index.
- **T-02-14 (DoS — forced/expensive-engine spam):** mitigated — forced path is a single attempt bounded by the Phase-1 queue; the 235B tier is only reachable via the quality cascade; capability/key 422 rejects pre-enqueue (no buffer held).
- **T-02-15 (Info disclosure — trace/thresholds):** mitigated — the trace carries codes/timings/confidence only (built by Plan 03's pure trace.js); profiles discovery projects id/default/description/engines and the suite asserts no `threshold` key leaks.
- **T-02-16 (install surface):** accept — zero new packages; the package.json change is test-file registration only.

## Deferred Ops Checks (NON-blocking — for PENDING-ISSUES)
Neither blocks Phase-2 completion; the code reacts to provider responses (429/quota, scored text), not to fixed numbers:
1. **Live-key heuristic threshold calibration** — run real clean/garbage/near-empty images through ocr.space + one LLM tier; confirm P50 clean docs stop at tier-1 and garbage escalates; tune weights/thresholds via env (no code change).
2. **Ollama Cloud quota confirmation** — confirm the current subscription tier + observed quota headroom against the `budgetMs`/max-tier defaults.

## Known Stubs
None. Every envelope field (pages/text/engine/provider/confidence/trace/low_confidence) is populated from a scored provider outcome and exercised by the integration suite.

## Self-Check: PASSED
- Files exist: `test/cascade-integration.test.js`, `lib/v1/worker.js`, `lib/v1/router.js`, `test/worker.test.js`, `package.json` — all confirmed.
- Commits exist: `f96b326`, `cda541c`, `069561e` — all confirmed in git log.
- Suite: `node --test test/cascade-integration.test.js` → 7/7; full `npm test` → 242 pass / 0 fail, zero Phase-1 regression.
