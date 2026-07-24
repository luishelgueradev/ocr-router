---
phase: 03-input-pipeline
verified: 2026-07-23T00:00:00Z
status: passed
score: 5/5 success criteria verified (7/7 requirements satisfied)
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
---

# Phase 3: Input Pipeline Verification Report

**Phase Goal:** The service accepts PDFs (native + scanned) and additional image formats (TIFF/HEIC/BMP/GIF), turning any upload into memory-safe per-page results routed through the already-proven cascade.
**Verified:** 2026-07-23
**Status:** passed
**Re-verification:** No — initial verification
**Mode note:** ROADMAP marks this phase `mode: mvp`, but the phase goal is a technical capability statement (not an "As a … I want … so that …" User Story). Per the launching agent's explicit instructions, this was verified goal-backward against the 5 ROADMAP success criteria + INP-03..08 / OPS-06, producing a pass/fail result rather than a User-Flow-Coverage table.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
| - | ----- | ------ | -------- |
| 1 | Native PDF → per-page embedded text WITHOUT OCR; scanned PDF rendered page-by-page & routed | ✓ VERIFIED | `pdf-text.js#getPageTexts` (unpdf, in-process) + `sufficient()` floor (MIN_NATIVE_CHARS + `\p{L}{2,}` word-token, defends false-positive). `page-pipeline.js:125-135`: sufficient page → `engine:'pdf-native'`, `continue` (no cascade); else `renderPage` → `routeAndRecord`. Test `page-pipeline.test.js:74` asserts `routePage.calls.length===0` for native pages; `:87` mixed PDF native-skip + scanned-route. |
| 2 | TIFF/HEIC/BMP/GIF normalized to routable image; untrusted decode/raster in killable resource-limited subprocess; temp always cleaned (incl. mid-job kill) | ✓ VERIFIED | `image-normalize.js#normalizeToFrames` dispatches TIFF/GIF (per-frame), HEIC (heic-convert→sharp), BMP (@vingle/bmp-js→sharp), never `sharp()` on HEIC/BMP. Subprocess isolation `spawn-capture.js`: `spawn({signal,killSignal})` + own SIGTERM→SIGKILL timer + `ulimit -v`/`-t` + `exec timeout -s KILL`. Temp: `temp.js` registry, worker `finally cleanupJobTempDir` (worker.js:296-298), shutdown drain `shutdown.js:31-32 drainAllTempDirs`. |
| 3 | Multi-page → per-page results + rollup (completed/completed_with_errors); one failed page neither fails job nor silently dropped; order preserved | ✓ VERIFIED | `page-pipeline.js:76-89 pushError` records error page (never rethrow/drop); loop `continue`; `:157 status_rollup = hadError ? 'completed_with_errors':'completed'`. Test `page-pipeline.test.js:130` failed page recorded + `:143` `pages.map(page)===[1,2,3]` order preserved + `:144` rollup flips. |
| 4 | Rasterization streams exactly one page in memory; enforces page-count, DPI, pixel caps (bomb-resistant) | ✓ VERIFIED | `rasterize.js`: `pdfPageCount` (pdfinfo) → `assertPageCountWithinCap` BEFORE any render (`page-pipeline.js:115-116`, outside try/catch → typed 413). `renderPage` streams ONE page to stdout via `-singlefile` with **no output-root** (03-07 fix, comment L96-101) + `-r` explicit + `-scale-to RASTER_MAX_DIM`. `png=null` before routing (:134). Four guards: pdfinfo cap, `-scale-to`, `ulimit -v`, `maxStdoutBytes`. sharp path: `limitInputPixels`+resize on every decode. |
| 5 | Native-decode deps pinned to CVE-fixed versions (sharp>=0.35.0) & scanned in CI | ✓ VERIFIED | `package.json` `"sharp":"^0.35.3"`; installed 0.35.3. `scripts.audit = npm audit --omit=dev --audit-level=high`. `npm run audit` → **exit 0, "found 0 vulnerabilities"** (D-09 remediation held). |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `lib/v1/input/caps.js` | Boot-validated env caps | ✓ VERIFIED | `Object.freeze(CAPS)` via `intFromEnv`; MAX_PDF_PAGES/RASTER_DPI/MAX_OUTPUT_PIXELS/RASTER_MAX_DIM/ULIMIT_V_KB/ULIMIT_CPU_SEC/RASTER_WALL_MS/PDFINFO_WALL_MS/MAX_RASTER_STDOUT_BYTES/MIN_NATIVE_CHARS/MAX_JOB_MS all present. |
| `lib/v1/input/spawn-capture.js` | Killable sandboxed seam | ✓ VERIFIED | AbortSignal + SIGKILL escalation + ulimit + exec+timeout + stdout ceiling; `spawnFn` injectable seam. |
| `lib/v1/input/temp.js` | Temp registry drained by shutdown | ✓ VERIFIED | create/cleanup/drainAll; force:true idempotent. |
| `lib/v1/input/pdf-text.js` | unpdf native-text + threshold | ✓ VERIFIED | getPageTexts (mergePages:false) + sufficient(). |
| `lib/v1/input/rasterize.js` | pdfinfo cap + single-page pdftoppm | ✓ VERIFIED | pdfPageCount/assertPageCountWithinCap/renderPage all via spawnCapture + CAPS. |
| `lib/v1/input/image-normalize.js` | sniffedType → PNG frames | ✓ VERIFIED | normalizeToFrames, limitInputPixels on every decode, per-frame loop. |
| `lib/v1/input/page-pipeline.js` | Orchestrator + rollup | ✓ VERIFIED | runPipeline; per-page try/catch; ordered pages[]; rollup. |
| `lib/v1/worker.js` | runInputJob dispatch + deadline + temp | ✓ VERIFIED | INPUT_FORMATS dispatch (:317), one MAX_JOB_MS AbortController (:240-242), temp finally (:296-298); png/jpeg/webp path unchanged. |
| `lib/v1/sniff.js` | Extended magic-byte detector | ✓ VERIFIED | PDF/TIFF(LE+BE)/HEIC(brand-checked)/BMP/GIF added; unknown→null→422. |
| `test/docker-smoke.test.js` + `scripts/docker-smoke.sh` | Skip-guarded real-dep smoke | ✓ VERIFIED | HAS_POPPLER guard; host run = 8 skipped, 0 fail; 03-07 records 8/8 GREEN in-container. |

### Key Link Verification

| From | To | Status | Details |
| ---- | -- | ------ | ------- |
| `router.js` | `sniff.js sniffImage` | ✓ WIRED | `sniffImage(req.file.buffer)` (:49); `mimeType: sniffedType` forwarded to worker (:178). |
| `worker.js runInputJob` | `page-pipeline runPipeline` | ✓ WIRED | worker.js:254 runPipeline(...) with signal/tempDir/routePage/spawnFn. |
| `page-pipeline` | `cascade runCascade` (via routePage) | ✓ WIRED | routePage injected by worker (makeCascadeRoutePage / makeForcedRoutePage); native pages bypass it. |
| `rasterize` | `spawn-capture spawnCapture` | ✓ WIRED | pdfinfo + pdftoppm both funnel through seam. |
| `shutdown drainAndCancel` | `temp drainAllTempDirs` | ✓ WIRED | shutdown.js:31-32. |
| `worker` | `temp create/cleanup` | ✓ WIRED | createJobTempDir (:247) + cleanupJobTempDir in finally (:298). |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
| ----------- | ----------- | ------ | -------- |
| INP-03 | Native PDF embedded text per page without OCR | ✓ SATISFIED | pdf-text.js + short-circuit; test asserts 0 cascade calls. |
| INP-04 | Scanned PDF rendered page-by-page, routed | ✓ SATISFIED | rasterize.renderPage + routeAndRecord; docker smoke real pdftoppm. |
| INP-05 | TIFF/HEIC/BMP/GIF normalized before routing | ✓ SATISFIED | image-normalize dispatch all four + PNG/JPEG/WebP. |
| INP-06 | Per-page results + rollup; failed page not silently dropped | ✓ SATISFIED | pushError + status_rollup; order-preserved test. |
| INP-07 | One page in memory; page-count/DPI/pixel caps | ✓ SATISFIED | pdfinfo pre-gate + -scale-to + limitInputPixels + png=null release. |
| INP-08 | Killable resource-limited subprocess; temp always cleaned | ✓ SATISFIED | spawn-capture sandbox + temp registry + shutdown drain. |
| OPS-06 | sharp>=0.35.0 pinned + CI scan | ✓ SATISFIED | sharp 0.35.3; `npm run audit` exit 0. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Full host suite green | `npm test` | 313 tests, 313 pass, 0 fail, 0 skipped | ✓ PASS |
| CI dependency scan green | `npm run audit` | exit 0, "found 0 vulnerabilities" | ✓ PASS |
| Docker smoke skip-guarded on host | `node --test test/docker-smoke.test.js` | 8 tests, 0 pass, 0 fail, 8 skipped | ✓ PASS |
| Deps pinned to CVE-fixed | node_modules versions | sharp 0.35.3 / unpdf 1.6.2 / heic-convert 2.1.0 / bmp-js 0.2.5 | ✓ PASS |

### Probe Execution

Not a probe-based phase (no `scripts/*/tests/probe-*.sh`). The declared runnable validation is the skip-guarded `test/docker-smoke.test.js`, executed on host (8 skipped, green-by-skip) and recorded as 8/8 GREEN in-container by 03-07. Per the launching agent, the in-container run is an accepted legitimately-run validation.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | — | No TODO/FIXME/XXX/TBD/HACK/PLACEHOLDER in any phase-modified file | — | Completion auditable |

Empty-value grep hits (`png = null`, `let killTimer = null`, `pages.push({...engine:null})`) are intentional buffer-release / error-page / registry-init patterns — not stubs. State is populated by real decode/route paths.

### Regression Check (Phase 1/2)

- Worker-logging assertions green: `worker-logging.test.js` (winning_engine / elapsed_ms / job start / job complete) among the 313 pass; pipeline trace preserves `winning_engine` + `elapsed_ms` keys (`page-pipeline.js:164-173`).
- Envelope additive: `status_rollup` added; single-image PNG/JPEG/WebP path routes through unchanged `runCascadeJob`/`runForced` (worker.js:321-327) — not the input pipeline.

### Human Verification Required

None open. Two items are explicitly accepted by the launching agent and are NOT open gaps:
1. Real-poppler + HEIC-in-Docker smoke — a legitimately-run in-container validation (8/8), recorded per D-11 (not a host-suite gate).
2. Concrete VPS `ulimit`/RAM tuning — an accepted deferred item (CAPS defaults are conservative-safe, not per-box-optimal).

### Gaps Summary

No gaps. All 5 ROADMAP success criteria are observably true in shipped code, all 7 requirements (INP-03..08, OPS-06) satisfied, all key links wired, full host suite (313) green, audit gate green (exit 0), docker smoke green-by-skip on host and recorded green in-container, no debt markers, no Phase 1/2 regression. Every specifically-requested claim confirmed: native-text short-circuit skips OCR (test asserts 0 cascade calls), pdftoppm streams one page to stdout with the 03-07 no-output-root fix, pdfinfo page-count cap fires before rasterizing, subprocess is killable with SIGTERM→SIGKILL + ulimit -v + exec + temp cleanup on success/error/mid-job-kill, rollup flips to completed_with_errors with order preserved, sharp limitInputPixels + caps enforced, sharp>=0.35.0 pinned with a passing audit.

---

_Verified: 2026-07-23_
_Verifier: Claude (gsd-verifier)_
