---
phase: 02-cascade-router
verified: 2026-07-23T00:00:00Z
status: passed
score: 5/5 success criteria verified (11/11 requirements SATISFIED)
overrides_applied: 0
re_verification:
deferred:
  - truth: "Confidence threshold NUMBERS (0.50/0.60/0.70) are production-calibrated"
    addressed_in: "Ops checkpoint (live-key calibration spike)"
    evidence: "D-02 in 02-CONTEXT.md: threshold constants are LOW-confidence, env-overridable, calibration deferred to a live-key ops task; formula shape is HIGH-confidence. Explicitly an accepted deferred item, not a phase gap."
---

# Phase 2: Cascade Router Verification Report

**Phase Goal:** Every image request automatically escalates through an ordered chain of engines (ocr.space → Gemini 3 Flash → Gemma 4 31B → Qwen3-VL 235B), returning the best result any configured engine can produce — with full traceability, bounded cost/latency, and graceful degradation.
**Verified:** 2026-07-23
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | No-model request walks the ordered chain, returns first result passing the heuristic; clean doc stops at cheap tier-1 (P50 winner not top tier) | ✓ VERIFIED | `runner.js:77-165` walks `prof.chain` in order, returns on first `passesThreshold`. Heuristic spot-check: clean text → conf 1.000, passes balanced (0.60) → stops at ocr.space tier-1. Test `cascade-runner`: "tier-1 stop: clean ocr.space result stops the cascade at the cheap first tier"; integration test (a). |
| 2 | Falls through on hard failure (error/timeout/5xx) AND low-confidence (empty/short, garbage ratio, ocr.space signal); when nothing clears returns best-so-far `low_confidence:true` | ✓ VERIFIED | `runner.js:117-140` (`res.ok===false` → `continue`), `143-149` (ocrExitCode 3 hard fail), `167-174` (low-conf best-so-far tracking), `180-187` (returns best marked low_confidence). Heuristic hard gates: empty→0, garbage→0 (spot-checked). Tests: "escalate-on-garbage", "escalate-on-failure" (x2), "all-fail-best". |
| 3 | Trace records engines attempted, winning engine, per-engine timing, confidence, low_confidence; single authoritative job timeout aborts a hung provider | ✓ VERIFIED | `trace.js` shape: `engines_attempted[]` (engine/provider/outcome/confidence/time_ms/error), `winning_engine`, `low_confidence`, `elapsed_ms`, `stopped_reason`. `worker.js:95-97` one `AbortController`+`setTimeout(budgetMs)` deadline threaded as `deadlineSignal`. Tests: integration (a) populated trace; runner "budget-exhausted". |
| 4 | Client selects named profile (fast/balanced/quality, default balanced) or forces an engine; forcing an engine lacking capability → typed error | ✓ VERIFIED | `router.js:63-74` profile allowlist → 422 `field=profile` on unknown; `router.js:86-130` forced path capability check → 422 `field=model`; default `balanced` via `CONFIG.defaultProfile`. Tests: integration (d) profile:fast, (e) forced bypass single attempt, (f) unknown model/profile → 422. |
| 5 | Bounded by max-tier/max-attempts/cumulative budget; assembles only present-key engines (missing key = clean drop); fails closed at boot only if zero engines; routing/profiles/thresholds/capabilities declarative config not branches | ✓ VERIFIED | `config.js` maxAttempts+budgetMs+per-profile chain length (max-tier); `runner.js:90` max_attempts, `93-94` budget_exhausted, `53-55` `providerKeyPresent` filter (silent drop), `59-70` no_engine_configured. `config.js` pure data (no if/switch — grep confirmed). Tests: "missing-key-drop", "budget-exhausted", "quota-short-circuit". |

**Score:** 5/5 truths verified

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | Live-key calibration of threshold constants (0.50/0.60/0.70) | Ops checkpoint | D-02: constants are provisional/env-tunable; formula HIGH-confidence. Accepted deferral per task brief, not a gap. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/v1/cascade/config.js` | Declarative chains/profiles/capabilities/thresholds | ✓ VERIFIED | Pure data object; env-overridable via intFromEnv/floatFromEnv; no if/switch. |
| `lib/v1/cascade/heuristic.js` | Pure multi-signal `computeConfidence` + `passesThreshold` | ✓ VERIFIED | Two hard gates + weighted renormalizing soft score; Object.hasOwn allowlist. Spot-checked clean=1.0, garbage=0, empty=0. |
| `lib/v1/cascade/runner.js` | Walk/fall-through/best-so-far/bounds/quota short-circuit/trace | ✓ VERIFIED | Provider-agnostic (only calls runOCR); all bounds + quota skip + trace emit present. |
| `lib/v1/cascade/trace.js` | JOB-02 trace builders | ✓ VERIFIED | newTrace/recordAttempt/finalizeTrace; error coerced to string code only (no secrets/objects). |
| `lib/v1/worker.js` | Cascade wired (forced bypass vs cascade path) + single deadline | ✓ VERIFIED | `runCascadeJob` + `runForced`; AbortController deadline; page-aware envelope + trace attached. |
| `lib/v1/router.js` | Profile select/default, forced 422, profiles discovery | ✓ VERIFIED | 422 typed errors; `/v1/models` advertises profiles (no thresholds projected). |
| `lib/providers/ocrspace.js` | Overlay word-count signal + signal threading | ✓ VERIFIED | `isOverlayRequired='true'`, scalar wordCount only, `AbortSignal.any([opts.signal,backstop])`, ocrExitCode returned. |
| `lib/providers/ollama.js` | Job signal threaded into axios | ✓ VERIFIED | `signal: opts?.signal`; ERR_CANCELED → clean ok:false fall-through. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| worker.js | runner.js | `runCascade({deadlineSignal})` | ✓ WIRED | worker.js:100-103 |
| runner.js | ocr.js/providers | `runOCR(model,...,{signal})` | ✓ WIRED | runner.js:108 |
| runner.js signal | ocrspace fetch | `AbortSignal.any` → `fetch({signal})` | ✓ WIRED | ocrspace.js:22-31 |
| runner.js signal | ollama axios | `signal: opts?.signal` | ✓ WIRED | ollama.js:41 |
| router.js | worker.js | `runJob({profile,forced})` | ✓ WIRED | router.js:173-183 |
| config.js | heuristic/runner/router/worker | require + Object.hasOwn allowlist | ✓ WIRED | grep confirms 6 allowlist sites |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Clean text scores high, passes | computeConfidence(clean) | 1.000, passes balanced=true | ✓ PASS |
| Garbage/mojibake hard-gates to 0 | computeConfidence('Ã¿Ø£…') | 0.000, passes=false | ✓ PASS |
| Empty text hard-gates to 0 | computeConfidence('   ') | 0.000, passes=false | ✓ PASS |
| Hostile profile key rejected | passesThreshold(1.0,'__proto__') | false | ✓ PASS |
| Full suite | `npm test` | 237+5 pass, 0 fail, exit 0 | ✓ PASS |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| CASC-01 | Walk ordered chain, return first passing quality | ✓ SATISFIED | runner.js:77-165; tests tier-1 stop, integration (a) |
| CASC-02 | Fall through on hard failure | ✓ SATISFIED | runner.js:117-140; escalate-on-failure tests |
| CASC-03 | Fall through on low-confidence multi-signal heuristic | ✓ SATISFIED | heuristic.js; escalate-on-garbage; spot-checks |
| CASC-04 | Best result obtained marked low_confidence | ✓ SATISFIED | runner.js:172-187; all-fail-best test, integration (c) |
| CASC-05 | Named profile + default when unspecified | ✓ SATISFIED | config profiles + defaultProfile; router.js:63-74; integration (d) |
| CASC-06 | Force engine, capability-validated escape hatch | ✓ SATISFIED | router.js:86-130; worker runForced; integration (e)(f) |
| CASC-07 | Skip missing-key engines, fail closed only if zero | ✓ SATISFIED | runner.js:53-70; missing-key-drop test |
| CASC-08 | Bounded max-tier/max-attempts/budget | ✓ SATISFIED | config maxAttempts/budgetMs/chain; runner.js:90-94; budget-exhausted test |
| CASC-09 | Declarative config, not hard-coded branches | ✓ SATISFIED | config.js pure data; grep: no engine-id equality branches |
| JOB-02 | Full cascade traceability | ✓ SATISFIED | trace.js; integration (a) populated trace |
| JOB-04 | Single authoritative timeout aborts hung provider | ✓ SATISFIED | worker AbortController deadline → both fetch+axios; provider-signal abort tests |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| ollama.js | 6 | "TODO" in prompt | ℹ️ Info | Spanish "Extrae TODO el texto" (=ALL), not a debt marker — no action |

No debt markers (TBD/FIXME/XXX), no stub returns, no placeholder implementations in phase files.

### Human Verification Required

None. All success criteria are verifiable programmatically via unit/integration tests plus behavioral spot-checks against pure logic. Live-provider threshold calibration is an explicitly accepted deferred ops task (D-02), not a phase acceptance gate.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria and all 11 requirements (CASC-01..09, JOB-02, JOB-04) are satisfied by shipped code and proven by a passing test suite (242 tests, 0 failures). Specifically confirmed against the task brief: declarative config has no routing if/switch branches; the single AbortSignal deadline reaches both ocrspace `fetch` and ollama `axios`; same-provider quota short-circuit records-and-skips uncalled tiers; missing-key tiers are dropped silently; best-so-far is returned with `low_confidence:true`; a clean document stops at tier-1. The provisional threshold constants are an accepted deferred calibration item, not a gap.

---

_Verified: 2026-07-23_
_Verifier: Claude (gsd-verifier)_
