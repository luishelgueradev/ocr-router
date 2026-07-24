---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: verifying
stopped_at: Phase 3 verification gaps (G-1, G-2, HVR#1) closed by quick task 260724-64d, plus a monotonic-clock defect and a test temp-root race found while re-auditing
last_updated: "2026-07-24T05:00:00.000Z"
last_activity: 2026-07-24
progress:
  total_phases: 4
  completed_phases: 3
  total_plans: 14
  completed_plans: 14
  percent: 75
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-23)

**Core value:** Never fail to return the best available text/data for a document — the cascade escalates quality automatically so one API call always yields the best result any configured engine could produce.
**Current focus:** Phase 3 — Input Pipeline

## Current Position

Phase: 3 (Input Pipeline) — REVIEWED + FIXED + RE-VERIFIED; verification gaps CLOSED
Plan: 7 of 7
Status: 7/7 plans done. Code review found 23 issues (7 Critical, 11 Warning, 5 Info); all 18 Critical+Warning fixed. Re-verification returned `gaps_found` (G-1, G-2 + 3 human-verification items); quick task **260724-64d** closed G-1, G-2 and Human-Verification #1, and fixed two further defects it surfaced — see the appendix in `03-VERIFICATION.md`.

Current evidence (re-run, not cited): host suite **364 passed / 0 failed / 2 skipped** (the poppler-gated PDF E2E cases), stable across 3 consecutive runs; in-container **E2E 8/8, 0 skipped** and **Docker smoke 8/8, 0 skipped** against a rebuilt image.

Still open: Human-Verification #3 (caps cross-validation policy — operator convention vs boot check), the 5 Info findings in `03-REVIEW.md`, and one new deferred item in `PENDING-ISSUES.md` (uploads declared `application/octet-stream` are rejected before sniffing).
Last activity: 2026-07-24

Progress: [██████████] 100%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: — min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

*Updated after each plan completion*
| Phase 1 P01-01 | 20 | 3 tasks | 25 files |
| Phase 1 P01-02 | 12 | 2 tasks | 17 files |
| Phase 1 P01-03 | 7 | 2 tasks | 5 files |
| Phase 02-cascade-router P01 | 7min | 3 tasks | 5 files |
| Phase 02-cascade-router P02 | 2min | 3 tasks | 4 files |
| Phase 2 P03 | 4min | 3 tasks | 3 files |
| Phase 2 P04 | 4min | 3 tasks | 5 files |
| Phase 3 P01 | 6min | 2 tasks | 5 files |
| Phase 3 P02 | 4 | 2 tasks | 5 files |
| Phase 03-input-pipeline P03 | 18min | 2 tasks | 7 files |
| Phase 3 P04 | ~3min | 2 tasks | 6 files |
| Phase 03-input-pipeline P05 | ~4min | 2 tasks | 6 files |
| Phase 03 P06 | 30 | 2 tasks | 5 files |
| Phase 3 P03-07 | 45min | 2 tasks | 7 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Dependency-ordered build — Foundation (port) → Cascade Router → Input Pipeline → Structured Extraction.
- [Roadmap]: Cascade built on plain images BEFORE the input pipeline (core value + lowest-dependency layer).
- [Roadmap]: Page-aware response envelope (`pages[]`) designed in Phase 1 even while image-only, or multi-page becomes a breaking change.
- [Roadmap]: OPS-01..05 folded into Phase 1 (ported deploy/foundation); OPS-06 lives in Phase 3 where sharp/native decoders land.
- [Phase ?]: [01-01]: succeeded status (D-03), page-aware envelope (D-04), file field (D-06), default-engine resolver + zero-engine guard (D-08)
- [Phase 1]: [01-02]: Ported node --test acceptance suite (16 files + verify-redaction) green against Plan 01 app; env-guards boot test supplies OCR key for the D-08 zero-engine guard; worker.test.js gained a D-04 page-aware-envelope success-path test
- [Phase ?]: [01-03]: Deploy stack migrated to node:22-bookworm-slim + poppler-utils + tini (/usr/bin/tini); Node-native fetch healthcheck (bookworm has no wget/curl); ocr-router:latest; docker compose build verified real; full npm test 189/189 green
- [Phase 02]: Cascade routing is declarative data in lib/v1/cascade/config.js (no engine-selecting branches, CASC-09)
- [Phase 02]: Confidence heuristic is a pure env-tunable function; threshold numbers provisional pending live-key calibration (deferred ops)
- [Phase ?]: Job AbortSignal composed with per-engine timeout via AbortSignal.any in ocr.space; ollama axios gets {signal}; provider aborts fall through as ok:false (JOB-04)
- [Phase ?]: ocr.space overlay returns scalar overlay.wordCount+HasOverlay+ocrExitCode only, no fabricated confidence or raw geometry (D-03 amended)
- [Phase 2]: Cascade runner short-circuits Ollama quota across same-provider tiers, returning best-so-far (D-12)
- [Phase 2]: One authoritative job deadline composed via AbortSignal.any; per-engine timeout = min(perEngineMs, remaining) (JOB-04)
- [Phase 3]: Phase 3 input caps centralised in lib/v1/input/caps.js (boot-validated env; MAX_JOB_MS is the whole-job budget) — Single validated config surface for every downstream rasterize/normalize ceiling; fails loudly at boot
- [Phase 3]: OPS-06 npm audit gate shipped GREEN via npm audit fix (0 vulns, no Express-5 bump, no allowlist) — Pre-existing axios/form-data/qs/body-parser advisories remediated transitively; gate is a live guard not aspirational
- [Phase ?]: spawnCapture: ulimit -v (not -m), exec mandatory in sh -c, worker-owned SIGTERM->SIGKILL escalation timer; per-job temp registry drained by shutdown
- [Phase 3]: PDF native-text short-circuit (unpdf sufficiency floor + word-token) skips OCR; scanned pages rasterize one-at-a-time via pdftoppm -singlefile stdout with a pdfinfo pre-raster page-count cap gate (typed 413) — Cheap fast path for digital PDFs; memory-safe single-page raster with four layered decompression-bomb guards through the 03-03 sandbox seam
- [Phase ?]: 03-05: normalizeToFrames — one shared limitInputPixels-guarded normalize pipeline for all image branches; HEIC/BMP decoded first (heic-convert/@vingle/bmp-js) then sharp, never sharp() on raw; multipage TIFF/GIF decoded one {page:p} frame at a time (INP-07)
- [Phase ?]: 03-06: page-pipeline owns per-page ordering+rollup; worker runInputJob owns ONE MAX_JOB_MS deadline (raster+all cascades) + always-cleaned temp dir; additive envelope adds status_rollup, single-image path byte-unchanged
- [Phase ?]: 03-07: pdftoppm streams to stdout via omitted output-root (not trailing '-') on poppler 22.12.0 — Docker smoke caught the bug; A1 (768MB ulimit) + A5 (HEIC-in-Docker) confirmed
- [Phase 3]: 03-REVIEW: `-scale-to` OVERRIDES `-r` in poppler (measured: -r 50/150/300 with -scale-to 5000 all emit a byte-identical 70539-byte PNG). RASTER_DPI was inert and RASTER_MAX_DIM was a forced UPSCALE target. Fixed by deriving `-scale-to` from real pdfinfo page geometry at RASTER_DPI, clamped to RASTER_MAX_DIM — the cap is now a ceiling, not a target
- [Phase 3]: 03-REVIEW: subprocess sandbox was silently bypassable — `ulimit -v undefined` is rejected by dash, which without `set -e` then ran the child COMPLETELY UNSANDBOXED. spawnCapture now fails closed (exit 71 / spawn_sandbox_limits_required) and passes argv positionally instead of interpolating into the shell string
- [Phase 3]: 03-REVIEW: SIGTERM→SIGKILL escalation was unreachable — Node's own `spawn({signal})` abort listener runs first and synchronously emits 'error', and a listener removed mid-dispatch is never invoked per the EventTarget spec. Escalation is now armed from the 'error' handler itself and cleanup() deliberately does NOT clear the kill timer (settling the promise says nothing about whether the child died)
- [Phase 3]: 03-REVIEW: temp drain ran BEFORE the job drain, rm -rf'ing the input PDF out from under in-flight pdftoppm — the exact Pitfall-2 it claimed to close. Reordered after limiter.stop(), plus a boot-time sweep of orphaned ocr-job-* dirs to recover from SIGKILL leaks
- [Phase 3]: 03-REVIEW: process lesson — the phase verifier passed 5/5 with "no gaps" on code carrying 7 blockers, because it checked that the code matched what module headers CLAIMED, and several of those claims were false. Tests encoded the bugs too (a case named "BMP path still applies limitInputPixels (no OOM)" fed a VALID large BMP). Verification must not treat in-code assertions as evidence

- [Phase 3]: 260724-64d: ALL deadline/duration arithmetic runs on a monotonic clock (lib/clock.js); Date.now survives only behind clock.wallMs() for client-facing absolute timestamps (jobs.js expires_at) — a backward wall-clock step was inflating `remaining` and letting the cascade escalate past its budget, and the same arithmetic backed worker.js MAX_JOB_MS
- [Phase 3]: 260724-64d: temp.js's orphan sweep documents a "single-instance per container" precondition that the parallel test runner violates — test processes get a private TMPDIR (test/helpers/isolated-tmp.js) rather than weakening the sweep
- [Phase 3]: 260724-64d: process lesson — the prior verification CITED "host suite 352/352" without re-running it; the first run this session was 347 tests with 3 failures. Re-run the gate, and prove each new test fails against the pre-fix code before believing it

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 2]: Confidence heuristic is the hardest-to-tune, highest-risk logic (false-good garbage detection). Research-flag: warrants a focused spike + small labeled calibration sample during planning.
- [Phase 2]: Ollama Cloud quota resets on 5h/7-day windows and burns fastest on the 235B model — confirm real quota numbers before finalizing the global budget cap.
- [Phase 3]: Subprocess sandboxing mechanics (memory/pid caps, clean kill) and HEIC-in-Docker (patched libheif) need validation against the target VPS/Docker setup. Research-flag.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260724-64d | Close Phase 3 verification gaps (G-1, G-2, HVR#1) + monotonic clock defect | 2026-07-24 | 65568d1 | [260724-64d-phase3-gaps-and-monotonic-clock](./quick/260724-64d-phase3-gaps-and-monotonic-clock/) |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-07-24
Stopped at: Quick task 260724-64d complete — Phase 3 verification gaps G-1 and G-2 closed, Human-Verification #1 closed by a real HTTP E2E test, plus two defects found while re-auditing (wall-clock deadlines; a cross-process temp-dir race in the test suite). All evidence re-run, not cited: host 364/0/2-skipped across 3 runs; in-container E2E 8/8 and Docker smoke 8/8, both 0 skipped, on a rebuilt image.
Resume file: None
Next action: Phase 4 (Structured Extraction) — independent of Phase 3. Optional first: decide Human-Verification #3 (enforce RASTER_MAX_DIM^2 <= MAX_OUTPUT_PIXELS at boot, or keep it an operator convention) and triage the new PENDING-ISSUES item about `application/octet-stream` uploads, which matters for n8n-style clients.
