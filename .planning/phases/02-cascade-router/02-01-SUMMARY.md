---
phase: 02-cascade-router
plan: 01
subsystem: api
tags: [ocr, cascade, heuristic, confidence, config, node-test, env]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "lib/models.js engine catalog, lib/v1/engines.js provider helpers, lib/v1/env.js intFromEnv pattern"
provides:
  - "Pure, config-driven computeConfidence(text,{overlay}) → [0,1] + passesThreshold allowlist"
  - "Declarative cascade config (chains, profiles, capability table, heuristic bounds) in lib/v1/cascade/config.js"
  - "floatFromEnv env helper for float thresholds/ratios"
  - "10-fixture calibration suite discharging the STATE false-good-garbage risk-flag at unit level"
affects: [cascade-runner, worker-integration, trace, forced-engine-validation, profiles-discovery, structured-mode]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Routing as declarative data (no if/switch engine selection) — config.js is the single source of truth"
    - "Pure heuristic over (text, overlay) — unit-testable without images/keys/network"
    - "Env-tunable thresholds via floatFromEnv; require-cache clear proves tunability without editing test logic"
    - "Prototype-pollution-safe key lookup via Object.hasOwn allowlist"

key-files:
  created:
    - lib/v1/cascade/config.js
    - lib/v1/cascade/heuristic.js
    - test/cascade-heuristic.test.js
    - test/fixtures/heuristic/fixtures.js
  modified:
    - lib/v1/env.js

key-decisions:
  - "Weight renormalization (mandated) gives garbage-free text a 0.625 floor — short clean strings clear balanced, not 'fast only'; documented as a calibration deviation from research §1g illustrative bands"
  - "Extended the garbage bad-set to the Latin-1 symbol block 0xA0–0xBF (excluding ¡/¿) to gate UTF-8→Latin-1 mojibake while preserving valid Spanish"
  - "supports_structured:false included in the capability table now so Phase 4 is additive"
  - "Threshold numbers (0.50/0.60/0.70) are provisional LOW-confidence values pending a live-key calibration spike (deferred ops task)"

patterns-established:
  - "config.js declarative-data module: chain/profiles/capabilities/heuristic bounds, no routing branches (grep-gated)"
  - "Pure heuristic module: no provider/network requires; all constants sourced from config"

requirements-completed: [CASC-03, CASC-09]

# Metrics
duration: 7min
completed: 2026-07-23
---

# Phase 2 Plan 01: Confidence Heuristic + Declarative Cascade Config Summary

**A pure, config-driven `computeConfidence(text,{overlay}) → [0,1]` with two hard gates and a weighted renormalized soft score, backed by a declarative cascade config and proven by a 10-fixture, keyless, table-driven calibration suite (34/34 green).**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-23T20:50:32Z
- **Completed:** 2026-07-23T20:57:42Z
- **Tasks:** 3 completed
- **Files created/modified:** 5

## Accomplishments
- Built the highest-risk Phase-2 logic first: a **pure** confidence heuristic that hard-gates empty text and garbage (>0.30 ratio) to 0, scores clean docs high, and never leaves [0,1] — discharging the STATE "false-good garbage detection" risk-flag at the unit level.
- Made routing **declarative data** (CASC-09): `config.js` holds the ordered per-profile chains, engine capability table, and all heuristic thresholds/weights/bounds, with zero engine-selecting branches (grep-gated to 0).
- Proved **tunability**: overriding `PROFILE_BALANCED_THRESHOLD` via env and re-requiring config flips a borderline fixture's pass/fail with no test-logic edits.
- Kept the whole Phase-1 suite green (219/219 total, including 34 new).

## Task Commits

Each task committed atomically (TDD RED→GREEN on tasks 2–3):

1. **Task 1: floatFromEnv + declarative cascade config** — `e1a1637` (feat)
2. **Task 2: RED — 10-fixture heuristic calibration suite** — `3932598` (test)
3. **Task 3: GREEN — pure confidence heuristic** — `01c8923` (feat)

## Files Created/Modified
- `lib/v1/cascade/config.js` — declarative CONFIG: per-profile chains, `defaultProfile:'balanced'`, capability table (`supports_structured:false`), heuristic bounds/weights, runner deadline bounds. No routing branches.
- `lib/v1/cascade/heuristic.js` — pure `computeConfidence` / `passesThreshold` / `garbageRatio`; NFC+trim, code-point counting, hard gates, weighted renormalized soft score; overlay signal reads scalar `overlay.wordCount` (never sums `Lines[]`); `Object.hasOwn` allowlist guards profile lookup.
- `test/cascade-heuristic.test.js` — table-driven `node:test` suite: [0,1] invariant, band, pass/fail matrix across fast/balanced/quality, hard-gate + prototype-pollution + env-tunability proofs.
- `test/fixtures/heuristic/fixtures.js` — the 10 named fixtures (pure strings + scalar mock overlay).
- `lib/v1/env.js` — added `floatFromEnv` (positive finite floats; throws on non-finite/≤0), exported beside `intFromEnv`.

## Key Technical Details

**Heuristic formula (config-driven):**
`conf = weighted-avg(printable=1−garbage, length=clamp((len−1)/15,0,1)[, overlay=clamp(wordCount/4,0,1)])`, weights `{printable:0.5, length:0.3, overlay:0.2}` renormalized to `{0.625, 0.375}` when overlay is absent. Hard gates: `len<1 → 0`, `garbageRatio>0.30 → 0`.

**SC#1 basis:** a ~300-char clean string scores 1.0 and clears even `quality` (0.70) → a clean doc stops at the cheap tier-1, so the P50 winner is not the top tier.

## Deviations from Plan

### Auto-fixed / Calibration Adjustments

**1. [Rule 1 — Calibration] Fixture bands reconciled with the mandated renormalization**
- **Found during:** Task 2 (computing expected scores before writing the RED suite).
- **Issue:** Research §1g's illustrative bands are inconsistent with the plan-mandated weight renormalization. Renormalization gives any garbage-free non-empty string a hard floor of 0.625 (printable weight 0.5/0.8), so `clean_receipt` (garbage-free, len 35) saturates to 1.0 rather than 0.75–0.90, and `near_empty "OK"` (0.65) / `single_char "a"` (0.625) clear `balanced` (0.60) rather than being "fast only".
- **Fix:** Set the test bands and pass/fail matrix to the formula's actual, self-consistent output while preserving the load-bearing behavior (hard gates → 0, clean-doc scores high, [0,1] invariant, all 10 named fixtures, tunability). The `balanced`/`quality` split still separates short from substantial clean text (len ≥ 4 clears quality).
- **Files:** `test/fixtures/heuristic/fixtures.js`
- **Commit:** `3932598`

**2. [Rule 1 — Bug] Garbage bad-set extended to Latin-1 symbols for mojibake gating**
- **Found during:** Task 3 (acceptance check `computeConfidence('Ã¿Ø£�') === 0`).
- **Issue:** Research §1c's narrow bad-set (C0/C1/DEL/FFFD/surrogates) classifies UTF-8→Latin-1 mojibake like `Ã¿Ø£` as printable (only the `�` counted → 0.20 garbage), so the plan's mojibake gate did not fire.
- **Fix:** Extended `isBadCodePoint` to include the Latin-1 symbol/punctuation block `0xA0–0xBF` **except** `¡ (0xA1)` and `¿ (0xBF)`, which are valid, frequent Spanish punctuation. Accented Spanish letters (`0xC0–0xFF`) are intentionally left printable. A lone symbol in real text stays diluted below the 0.30 gate; only dense mojibake runs hard-gate. Verified `¿Cuánto es el total?...` still scores 1.0.
- **Files:** `lib/v1/cascade/heuristic.js`
- **Commit:** `01c8923`

## TDD Gate Compliance
- RED gate: `test(02-01)` commit `3932598` (suite failed — heuristic.js absent).
- GREEN gate: `feat(02-01)` commit `01c8923` (34/34 pass).
- REFACTOR: not needed (implementation clean on first green).

## Threat Model Compliance
- **T-02-01 (prototype pollution):** mitigated — `passesThreshold` resolves via `Object.hasOwn(CONFIG.profiles, profile)`; `__proto__`/`constructor`/unknown → false (tested).
- **T-02-02 (DoS on hostile text):** mitigated — deterministic O(n) code-point scan, no regex backtracking, no dictionary/network.
- **T-02-03 (install surface):** accept — zero new npm packages; Node built-ins + Phase-1 deps only.

## Calibration Note (for downstream / ops)
Threshold numbers (`fast 0.50 / balanced 0.60 / quality 0.70`) and weights are **provisional LOW-confidence** starting values. Final tuning requires a live-key calibration spike (run genuine clean/garbage/near-empty images through ocr.space + one LLM tier and adjust). This is a deferred ops/`checkpoint:human-verify` task, **not a code blocker** — the heuristic is fully env-tunable without code change.

## Known Stubs
None. All exports are wired and exercised by the suite; no placeholder data paths.

## Self-Check: PASSED
- Files exist: `lib/v1/cascade/config.js`, `lib/v1/cascade/heuristic.js`, `test/cascade-heuristic.test.js`, `test/fixtures/heuristic/fixtures.js`, `lib/v1/env.js` (floatFromEnv) — all confirmed.
- Commits exist: `e1a1637`, `3932598`, `01c8923` — all confirmed in git log.
- Suite: `node --test test/cascade-heuristic.test.js` → 34/34 pass; full suite 219/219.
