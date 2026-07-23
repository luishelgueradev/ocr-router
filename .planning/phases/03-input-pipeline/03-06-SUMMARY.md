---
phase: 03-input-pipeline
plan: 06
subsystem: input
tags: [page-pipeline, orchestrator, per-page-rollup, status_rollup, runInputJob, job-deadline, temp-lifecycle, cascade-integration, multi-page-envelope, native-short-circuit, node-test, tdd]

# Dependency graph
requires:
  - phase: 03-input-pipeline (03-01)
    provides: "lib/v1/input/caps.js — CAPS.MAX_JOB_MS (whole-job deadline), MAX_PDF_PAGES"
  - phase: 03-input-pipeline (03-03)
    provides: "lib/v1/input/temp.js — createJobTempDir/cleanupJobTempDir (per-job temp lifecycle)"
  - phase: 03-input-pipeline (03-04)
    provides: "lib/v1/input/{pdf-text,rasterize}.js — getPageTexts/sufficient, pdfPageCount/assertPageCountWithinCap/renderPage"
  - phase: 03-input-pipeline (03-05)
    provides: "lib/v1/input/image-normalize.js — normalizeToFrames (TIFF/GIF/HEIC/BMP/PNG/JPEG/WebP → ordered PNG frames)"
  - phase: 02-cascade-router
    provides: "lib/v1/cascade/runner.js — runCascade (reused UNCHANGED, one call per non-native page)"
provides:
  - "lib/v1/input/page-pipeline.js — runPipeline({buffer,sniffedType,profile,signal,tempDir,routePage,spawnFn}) → ordered pages[] + status_rollup + engine/provider summary + trace; per-page try/catch accumulator, native short-circuit, over-cap pre-raster reject, one page image in memory at a time"
  - "lib/v1/worker.js runInputJob — dispatch branch owning ONE MAX_JOB_MS deadline (raster + every per-page cascade) + guaranteed temp cleanup + additive multi-page envelope; cascade/forced routePage closures"
affects: [03-07-docker-smoke, router, worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-page rollup on the UNCHANGED envelope (Pattern 4/INP-06): iterate in order, wrap each page in try/catch — success pushes {page,text,engine,confidence}, failure pushes {page,text:'',engine:null,confidence:null,error:{code,message}} and flips status_rollup to 'completed_with_errors'; never rethrow, never drop a page, order always preserved"
    - "One authoritative job deadline moved UP into the worker (Pattern 5/JOB-04): a single MAX_JOB_MS AbortController is created at the top of runInputJob and threaded to the poppler seam AND each per-page runCascade (budgetMs = deadline - Date.now()), so rasterization + all pages abort together"
    - "routePage injection seam: the pipeline never imports a provider — the worker binds routePage to runCascade (cascade path) or a single forced engine (forced path, no escalation), returning {text,engineId,provider,confidence,trace}"
    - "spawnFn threaded worker→pipeline→rasterize (D-11): production leaves it undefined (real spawn); host tests inject a fake ChildProcess so NO real poppler runs"
    - "Native-vs-scanned decided page-by-page: sufficient(pageText) → engine 'pdf-native' confidence 1 skipping OCR; else renderPage → base64 → routePage; a page count > text pages naturally rasterizes the tail pages"
    - "Additive envelope: pages[] now genuinely N-element + new status_rollup + engine/provider summary ('mixed' when pages differ, else the single engine); single-image PNG/JPEG/WebP path (runForced/runCascadeJob) left byte-unchanged"

key-files:
  created:
    - lib/v1/input/page-pipeline.js
    - test/page-pipeline.test.js
    - test/worker-input.test.js
  modified:
    - lib/v1/worker.js
    - package.json

key-decisions:
  - "The pipeline owns per-page ordering + rollup ONLY; the worker owns the one job deadline, the temp-dir lifecycle, and jobs.* finalization — the pipeline never touches jobs.* (clean separation, testable in isolation with injected routePage + spawnFn)"
  - "Whole-job budget (Open Question Q1 resolved by CAPS.MAX_JOB_MS): a single deadline shared across all N pages; each per-page cascade draws budgetMs = remaining, so a 50-page PDF cannot run 50× a per-page budget and a hung page is killed by the shared signal"
  - "Top-level engine/provider summary (Q3): distinct set of per-page engines → the single engine, or 'mixed' when they differ, or null when all failed; per-page engine stays authoritative; the job-level trace preserves winning_engine + elapsed_ms so OBSV-03 logging holds for input jobs too"
  - "Forced per-page router THROWS on a hard provider failure so the pipeline records it as a per-page error (INP-06) rather than failing the whole job; cascade per-page router returns best-so-far (runCascade never throws on all-fail — the product never loses work)"
  - "A page-count-cap rejection propagates OUTSIDE the per-page loop (pre-raster) → worker maps it to a typed jobs.fail(pdf_too_many_pages); an unexpected crash → jobs.fail internal_error; the temp dir is cleaned in finally either way"
  - "runInputJob dispatch keyed on sniffedType (mimeType field carries the authoritative sniffed type from router.js) BEFORE the forced/cascade split, so PDF/TIFF/HEIC/BMP/GIF (forced or cascade) route through the pipeline while png/jpeg/webp stay on the unchanged single-image path"

# Metrics
metrics:
  tasks_completed: 2
  duration_minutes: 30
  completed_date: 2026-07-23
---

# Phase 3 Plan 06: Page-Pipeline Orchestrator + Worker runInputJob Summary

End-to-end multi-page capability: an orchestrator (`runPipeline`) turns any admitted document into ordered per-page results — native-text short-circuit OR one cascade call per page — with a `status_rollup`, and a worker `runInputJob` branch owns one authoritative `MAX_JOB_MS` deadline bounding rasterization plus every per-page cascade, with guaranteed per-job temp cleanup, reusing the Phase-2 cascade unchanged.

## What Was Built

**Task 1 — `lib/v1/input/page-pipeline.js` (`runPipeline`)** [TDD: RED `a52f3d5` → GREEN `2a3df11`]
- Dispatches on `sniffedType`: `application/pdf` → write one temp file → `pdfPageCount` → `assertPageCountWithinCap` (typed pre-raster reject) → `getPageTexts` once → per page `sufficient()` → native `{engine:'pdf-native',confidence:1}` (no OCR) OR `renderPage` → base64 → injected `routePage`. Image types → `normalizeToFrames` → per frame `routePage`.
- Per-page try/catch accumulator: a page that throws becomes an error page (`engine:null`, `error:{code,message}`), flips `status_rollup` to `completed_with_errors`, and the loop CONTINUES — page order preserved, no page dropped.
- One page image in memory at a time (INP-07): each rasterized page / frame buffer is released before routing. Top-level `engine`/`provider` summary (`mixed` when pages differ) + a job-level trace preserving `winning_engine`/`elapsed_ms`.

**Task 2 — `lib/v1/worker.js` `runInputJob`** [TDD: RED `d0760bd` → GREEN `719eeed`]
- New dispatch branch keyed on `sniffedType ∈ {application/pdf, image/tiff, image/heic, image/bmp, image/gif}`; png/jpeg/webp stay on the unchanged `runForced`/`runCascadeJob`.
- Creates ONE unref'd `MAX_JOB_MS` `AbortController` at the top (the single deadline over raster + all pages) and a per-job temp dir; `finally` clears the timer AND `cleanupJobTempDir` on success | typed cap failure | crash.
- Builds `routePage` from the forced/cascade decision (cascade → `runCascade` with `deadlineSignal` + `budgetMs = remaining`; forced → single engine once, no escalation), calls `runPipeline`, then `jobs.complete` with the additive multi-page envelope and emits `job start`/`job complete` carrying `winning_engine`/`elapsed_ms`/`bytes_received`.
- A page-count-cap rejection → typed `jobs.fail(pdf_too_many_pages)`; unexpected crash → `jobs.fail internal_error`.

## Verification

- `node --test test/page-pipeline.test.js` — 5/5 pass (native short-circuit never calls routePage; mixed native/scanned → `mixed` summary; TIFF frames ordered; mid-list page failure → `completed_with_errors`, order preserved, no drop; over-cap rejects before any `pdftoppm`).
- `node --test test/worker-input.test.js` — 4/4 pass (multi-page TIFF envelope + rollup + temp cleaned; partial page failure still succeeds `completed_with_errors`; over-cap PDF fails typed; PNG stays on the unchanged single-image path with no temp dir).
- `node --test test/worker-logging.test.js test/worker-failure-logging.test.js test/worker.test.js` — all green (OBSV-03/05 single-image assertions unchanged).
- **FULL `npm test`: 308 tests, 307 pass, 1 skipped (pre-existing HEIC host skip), 0 fail** + 5/5 verify-redaction. Net +9 tests over the 299 baseline.
- `runForced`/`runCascadeJob` byte-unchanged (`git diff` shows only additions plus the `runJob` signature gaining `spawnFn` and the `module.exports` line).

## Deviations from Plan

None — plan executed exactly as written. The optional `spawnFn` param threaded through `runJob`/`runInputJob` is the D-11 test seam the plan's Task 2 action calls for ("fake spawnFn for poppler via the pipeline's injection path"); production callers (router.js) never set it, so the real `spawn` is used unchanged.

## Test File Registration (plan-checker WARNING-1 fix)

Verified EVERY Phase-3 host test file is enumerated in `package.json` `test`: caps, spawn-capture, temp, pdf-text, rasterize, image-normalize, **page-pipeline, worker-input** (the two new files added this plan). A disk-vs-script cross-check reports zero unregistered `test/*.test.js` files. No `test/docker-smoke.test.js` exists yet (03-07); it is correctly absent from the host script.

## Requirements Closed

INP-03 (native short-circuit), INP-04 (scanned per-page raster→cascade), INP-05 (image frame routing), INP-06 (per-page results + status_rollup), INP-07 (one page image in memory), INP-08 (killable subprocess + always-cleaned temp) — integrated into the user-visible envelope.

## Self-Check: PASSED
