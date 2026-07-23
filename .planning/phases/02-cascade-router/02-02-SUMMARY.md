---
phase: 02-cascade-router
plan: 02
subsystem: providers
tags: [ocr, ocrspace, ollama, abortsignal, overlay, deadline, node-test]

# Dependency graph
requires:
  - phase: 02-cascade-router
    provides: "Plan 01 heuristic — computeConfidence reads scalar overlay.wordCount (Signal C)"
  - phase: 01-foundation
    provides: "lib/ocr.js runOCR dispatch, lib/providers/{ocrspace,ollama,util}.js, per-provider AbortSignal.timeout pattern"
provides:
  - "ocr.space provider returning {text, overlay:{HasOverlay,wordCount}, ocrExitCode} and honoring an external AbortSignal"
  - "ollama provider forwarding a job AbortSignal into axios {signal}; abort mapped to clean ok:false fall-through"
  - "runOCR threading opts.signal into BOTH providers (JOB-04 prerequisite), arg order unchanged"
  - "test/provider-signal.test.js — keyless/networkless abort + overlay-shape proofs"
affects: [cascade-runner, worker-integration, trace, job-deadline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Compose caller job signal with per-engine backstop via AbortSignal.any([opts.signal, AbortSignal.timeout(cap)])"
    - "Provider abort surfaces as ok:false fall-through (never a throw) so the runner escalates and the worker never wedges"
    - "Overlay stays internal: only the scalar wordCount + HasOverlay leave the provider; raw geometry never enters the return"

key-files:
  created:
    - test/provider-signal.test.js
  modified:
    - lib/providers/ocrspace.js
    - lib/providers/ollama.js
    - lib/ocr.js

key-decisions:
  - "ocr.space signal is composed (AbortSignal.any) rather than replaced — the 2-min backstop stays subordinate to the job deadline (JOB-04); the ollama 5-min timeout is likewise demoted to a backstop"
  - "overlay word count is a scalar count only; NO confidence fabricated (D-03 amended) and NO raw geometry surfaced (kept internal to the heuristic per PROJECT/REQUIREMENTS out-of-scope)"
  - "ocrExitCode is returned even on ok:true so the runner (Plan 03) can treat OCRExitCode===3 (all pages failed) as a hard failure fall-through"

patterns-established:
  - "AbortSignal.any composition at the provider boundary for a single authoritative job deadline"
  - "Abort → ok:false normalization (fetch AbortError / axios ERR_CANCELED) via the shared toString guard"

requirements-completed: [JOB-04, CASC-03]

# Metrics
duration: 2min
completed: 2026-07-23
---

# Phase 2 Plan 02: Provider Signal Threading + ocr.space Overlay Summary

**Both providers now accept a single job-level `AbortSignal` (composed with their per-engine timeout via `AbortSignal.any`) that actually aborts the in-flight HTTP call as a clean `ok:false` fall-through, and ocr.space enables overlay to return the scalar `overlay.wordCount`/`HasOverlay` signal plus `ocrExitCode` the cascade runner consumes.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-07-23T21:01:19Z
- **Completed:** 2026-07-23T21:03:00Z
- **Tasks:** 3 completed
- **Files created/modified:** 4

## Accomplishments
- Threaded a single authoritative deadline (JOB-04) into both providers: ocr.space `fetch` composes `opts.signal` with a 2-min backstop via `AbortSignal.any`; ollama `axios` receives `{ signal }` with its 5-min timeout demoted to a backstop. A hung provider socket can now be aborted by the job deadline instead of wedging the single-concurrency worker (mitigates T-02-04).
- Enabled ocr.space overlay (`isOverlayRequired='true'`, was `'false'`) and extracted ONLY the scalar `overlay.{HasOverlay,wordCount}` (Signal C for the Plan 01 heuristic) — no fabricated confidence, no raw geometry (mitigates T-02-06).
- Returned `ocrExitCode` so the runner can treat `OCRExitCode===3` (all pages failed) as a hard failure even behind `ok:true`.
- Mapped both abort paths (fetch `AbortError`, axios `ERR_CANCELED`/`CanceledError`) to a normalized `ok:false` fall-through — never a thrown crash (mitigates T-02-05 via the existing `toString` guard).
- Kept the contract backward-compatible: `runOCR(model, base64, mime, apiKey, opts)` arg order unchanged, `signal` optional. Full suite green at **223/223** (was 219 + 4 new).

## Task Commits

Each task committed atomically:

1. **Task 1: ocr.space overlay word-count + OCRExitCode + external signal** — `d3a505a` (feat)
2. **Task 2: thread signal through ollama axios and runOCR** — `448ad49` (feat)
3. **Task 3: provider abort + overlay-shape unit tests** — `30e3471` (test)

## Files Created/Modified
- `lib/providers/ocrspace.js` — `isOverlayRequired='true'`; composed abort signal (`AbortSignal.any([opts.signal, backstop])` or backstop-only); walks `ParsedResults[].TextOverlay.Lines[].Words` to accumulate `wordCount` and `HasOverlay`; returns `{ ok, timeMs, text, overlay:{HasOverlay,wordCount}, ocrExitCode }`. Existing non-JSON-body and `ErrorMessage`-array normalization guards untouched.
- `lib/providers/ollama.js` — `signal: opts?.signal` added to the axios config; new catch branch maps `ERR_CANCELED`/`CanceledError` → `{ ok:false, error:'Cancelado por deadline del job', status }`; `ECONNABORTED` and generic branches preserved.
- `lib/ocr.js` — `runOcrSpace(...)` now receives `opts` (ollama already did); public arg order unchanged.
- `test/provider-signal.test.js` — 4 `node:test` cases: overlay shape (wordCount===N, HasOverlay, ocrExitCode, no geometry), `OCRExitCode:3` surfaced, aborted fetch → `ok:false`, aborted axios (`ERR_CANCELED`) → `ok:false`. Fully mocked `global.fetch` and `axios.post` (require.cache), no keys/network, each stub `t.after`-restored.

## Deviations from Plan
None — plan executed as written. (Minor note: the plan's acceptance grep `isOverlayRequired','true'` omits the post-comma space; the file follows the existing Prettier style `isOverlayRequired', 'true'`, so `grep -q "isOverlayRequired', 'true'"` returns 1 and the old `'false'` literal is gone. Overlay-enabled intent fully satisfied.)

## Threat Model Compliance
- **T-02-04 (DoS — hung provider socket):** mitigated — job `AbortSignal` composed into fetch (`AbortSignal.any`) and axios (`{signal}`); per-engine timeout subordinate.
- **T-02-05 (info disclosure — provider error body):** mitigated — abort/error paths return short normalized strings via the shared `toString`; no raw bodies/keys.
- **T-02-06 (spoofing — geometry mistaken for confidence):** mitigated — only `overlay.wordCount` (a count) returned; no confidence fabricated, no `Left/Top/WordText` in the return.
- **T-02-07 (install surface):** accept — zero new packages; native `fetch`/`AbortSignal.any` + installed `axios`.

## Calibration Note (for downstream / ops)
Live-key confirmation of ocr.space overlay behavior remains an **open ops item**: the unit tests mock a synthetic overlay body, so the exact real-world `Lines[].Words[]` population (and whether `HasOverlay` is reliably set per engine) is unverified against the live API. This folds into the Plan 01 live-key calibration spike (`checkpoint:human-verify`, deferred) — it is not a code blocker; the extraction is defensive (`?.`-guarded, defaults to `wordCount:0`).

## Known Stubs
None. All new fields are populated from the provider response and exercised by the suite.

## Self-Check: PASSED
- Files exist: `lib/providers/ocrspace.js`, `lib/providers/ollama.js`, `lib/ocr.js`, `test/provider-signal.test.js` — all confirmed.
- Commits exist: `d3a505a`, `448ad49`, `30e3471` — all confirmed in git log.
- Suite: `node --test test/provider-signal.test.js` → 4/4 pass; full suite 223/223.
