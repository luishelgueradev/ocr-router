---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
stopped_at: Completed 03-input-pipeline 03-05-PLAN.md
last_updated: "2026-07-23T22:50:01.413Z"
last_activity: 2026-07-23
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 14
  completed_plans: 12
  percent: 50
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-23)

**Core value:** Never fail to return the best available text/data for a document — the cascade escalates quality automatically so one API call always yields the best result any configured engine could produce.
**Current focus:** Phase 3 — Input Pipeline

## Current Position

Phase: 3 (Input Pipeline) — EXECUTING
Plan: 6 of 7
Status: Ready to execute
Last activity: 2026-07-23

Progress: [█████████░] 86%

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

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 2]: Confidence heuristic is the hardest-to-tune, highest-risk logic (false-good garbage detection). Research-flag: warrants a focused spike + small labeled calibration sample during planning.
- [Phase 2]: Ollama Cloud quota resets on 5h/7-day windows and burns fastest on the 235B model — confirm real quota numbers before finalizing the global budget cap.
- [Phase 3]: Subprocess sandboxing mechanics (memory/pid caps, clean kill) and HEIC-in-Docker (patched libheif) need validation against the target VPS/Docker setup. Research-flag.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-07-23T22:50:01.399Z
Stopped at: Completed 03-input-pipeline 03-05-PLAN.md
Resume file: None
