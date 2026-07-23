---
phase: 03-input-pipeline
plan: 04
subsystem: input
tags: [pdf, unpdf, poppler, pdftoppm, pdfinfo, rasterize, native-text, sufficiency, decompression-bomb, caps, node-test]

# Dependency graph
requires:
  - phase: 03-input-pipeline (03-03)
    provides: "spawnCapture — the injectable, sandboxed subprocess seam (ulimit + timeout + AbortSignal + SIGKILL escalation + stdout ceiling)"
  - phase: 03-input-pipeline (03-01)
    provides: "lib/v1/input/caps.js — MAX_PDF_PAGES, RASTER_DPI, RASTER_MAX_DIM, ULIMIT_V_KB/CPU_SEC, RASTER_WALL_MS, PDFINFO_WALL_MS, MAX_RASTER_STDOUT_BYTES, MIN_NATIVE_CHARS"
provides:
  - "getPageTexts(pdfBuffer) → string[] — per-page embedded text via unpdf (mergePages:false), page order preserved"
  - "sufficient(text, min) → boolean — native-vs-scanned decision (MIN_NATIVE_CHARS floor + word-token guard)"
  - "pdfPageCount(pdfPath,{signal,spawnFn}) → number — pdfinfo page count through the seam"
  - "assertPageCountWithinCap(n) — pre-raster over-cap gate → typed pdf_too_many_pages (413)"
  - "renderPage(pdfPath,page,{dpi,maxDim,signal,spawnFn}) → Buffer — one-page PNG via pdftoppm stdout"
affects: [03-06-page-pipeline, worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "unpdf ESM loaded via dynamic import() from CJS; extractText mergePages:false for per-page native-vs-scanned decision"
    - "Native-text sufficiency = length floor AND \\p{L}{2,} word token (not length>0) — stops scanned stray-glyph false positives (Pitfall 3 / T-03-09)"
    - "pdfinfo page-count read FIRST → typed over-cap reject BEFORE any raster (Pitfall 1 guard #1)"
    - "pdftoppm -singlefile <pdf> - streams ONE page to stdout: one page image in memory at a time (INP-07); never all-pages temp explosion"
    - "All poppler calls funnel through the 03-03 spawnCapture seam; host tests inject a fake spawnFn — zero real poppler (D-11)"

key-files:
  created:
    - lib/v1/input/pdf-text.js
    - lib/v1/input/rasterize.js
    - test/pdf-text.test.js
    - test/rasterize.test.js
    - test/fixtures/native-sample.pdf
  modified:
    - package.json

key-decisions:
  - "Over-cap page count throws a typed error with code 'pdf_too_many_pages' + status 413 (Payload Too Large) + {limit, actual} diagnostics — worker maps it to the client response"
  - "Sufficiency floor default sourced from caps.js (MIN_NATIVE_CHARS, env-tunable); word-token regex is a module-level compiled \\p{L}{2,}"
  - "renderPage ALWAYS passes -r (never poppler's silent 150 default, Pitfall 6) and ALWAYS -scale-to (second pixel guard) — no optional flags on the memory-guard path"
  - "Native-PDF tests run unpdf FOR REAL on host (pure JS/WASM); rasterize tests stub poppler via fake spawnFn (D-11) — the host suite never needs poppler"

patterns-established:
  - "Fake-spawn seam test helper: EventEmitter ChildProcess emitting stdout then close(0), recording (cmd,args,body,opts) for sandbox-body assertions"

requirements-completed: [INP-03, INP-04, INP-07]

# Metrics
duration: ~3min
completed: 2026-07-23
---

# Phase 3 Plan 04: PDF Native-Text Short-Circuit + Single-Page Rasterization Summary

**The PDF path now exists as two host-proven modules: `pdf-text.js` extracts embedded text per page with a defensible sufficiency threshold (the cheap fast path that skips OCR entirely for digital PDFs), and `rasterize.js` reads the page count via `pdfinfo` first (typed pre-raster cap gate) then renders exactly one scanned page to a captured PNG buffer through the sandboxed `spawnCapture` seam — one page image in memory at a time, four layered decompression-bomb guards, and zero real poppler on the host.**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-07-23T22:33:51Z
- **Completed:** 2026-07-23
- **Tasks:** 2 completed (both TDD: RED → GREEN)
- **Files:** 6 (5 created, 1 modified)

## Accomplishments

### Task 1 — `pdf-text.js`: native per-page text + sufficiency threshold (INP-03 / D-01)
- `getPageTexts(pdfBuffer)` dynamic-`import()`s ESM `unpdf`, builds a `Uint8Array`, `getDocumentProxy` + `extractText(pdf, { mergePages:false })`, returns the per-page `text[]` (page order preserved).
- `sufficient(t, min=CAPS.MIN_NATIVE_CHARS)` = `s.length >= min && /\p{L}{2,}/u.test(s)` — a real content floor AND a word-like token, not `length>0`. Defends against a scanned page's stray glyph / page-number text layer being wrongly judged "native" and skipping the OCR the product promises (Pitfall 3 / T-03-09). Default floor from `caps.js` so it stays boot-validated + env-tunable; regex compiled once at module level.
- A real 2-page text-bearing PDF fixture (`test/fixtures/native-sample.pdf`, hand-built with correct xref offsets) drives unpdf FOR REAL on the host — proving per-page order and text extraction with no stub.

### Task 2 — `rasterize.js`: pdfinfo cap gate + single-page pdftoppm render via the seam (INP-04 / INP-07 / D-02 / D-03)
- `pdfPageCount(pdfPath,{signal,spawnFn})` calls `spawnCapture('pdfinfo',[pdfPath],{signal,wallMs:CAPS.PDFINFO_WALL_MS,spawnFn})`, matches `/^Pages:\s+(\d+)/m`, throws `pdfinfo_no_page_count` when the field is absent.
- `assertPageCountWithinCap(n)` — the pre-raster gate (Pitfall 1 guard #1 / T-03-08): `n > CAPS.MAX_PDF_PAGES` throws a typed error (`code:'pdf_too_many_pages'`, `status:413`, `limit`, `actual`) BEFORE a single pixel is drawn.
- `renderPage(pdfPath,page,{dpi,maxDim,signal,spawnFn})` builds `-r <DPI> -png -f <p> -l <p> -singlefile -scale-to <MAX_DIM> <pdfPath> -` and funnels through `spawnCapture('pdftoppm', …, { ulimitKB:ULIMIT_V_KB, ulimitCpuSec:ULIMIT_CPU_SEC, wallMs:RASTER_WALL_MS, maxStdoutBytes:MAX_RASTER_STDOUT_BYTES, spawnFn })`. One page to stdout, one page in memory (INP-07). Always `-r` (never poppler's silent 150 — Pitfall 6) and always `-scale-to` (guard #2).
- Inherits the full four-layer decompression-bomb defense (page cap → -scale-to → ulimit -v → stdout ceiling) plus the AbortSignal deadline + SIGKILL escalation from the 03-03 seam.

## Deviations from Plan

None — the plan executed exactly as written. Both tasks followed the RED→GREEN TDD gate; the typed over-cap error uses the `code`/`status`/`limit`/`actual` shape the plan's `<behavior>` specified (413).

## Test Results

- `node --test test/pdf-text.test.js` → **6 pass / 0 fail**, running unpdf FOR REAL (no stub): per-page order + text from the fixture, and every `sufficient()` floor case (empty/whitespace/null → false; short stray-glyph → false; 16+ chars of digits/punctuation with no word token → false; real sentence → true; explicit-min override both directions).
- `node --test test/rasterize.test.js` → **7 pass / 0 fail** with a fake `spawnFn` only — **ZERO real poppler processes**: `Pages:` parse, missing-field throw, typed over-cap error (413) before any render, exact one-page argv (`-r`/`-png`/`-f`/`-l`/`-singlefile`/`-scale-to`, ends `<pdfPath> -`), ulimit caps in the sandbox body, dpi/maxDim/page overrides, and the AbortSignal reaching the child.
- **Full suite `npm test` → 288 pass / 0 fail** (main `node --test`) **+ 5 pass / 0 fail** (redaction) — 275 baseline + 13 new, no regressions. Both new test files registered in `package.json`.

## Threat Model Coverage

| Threat ID | Mitigation delivered |
|-----------|----------------------|
| T-03-08 (decompression / pixel bomb) | Four layered guards wired: `assertPageCountWithinCap` (pre-raster reject) → `-scale-to RASTER_MAX_DIM` long-side ceiling → `ulimit -v` (via seam) → `MAX_RASTER_STDOUT_BYTES` stdout cap. Real `ulimit -v` numeric sizing remains a 03-07 Docker smoke (A1). |
| T-03-09 (native-text false positive skips needed OCR) | `sufficient()` = MIN_NATIVE_CHARS floor + `\p{L}{2,}` word-token test, not `length>0`; when in doubt the page rasterizes. |
| T-03-10 (malicious PDF exploits renderer) | Every pdfinfo/pdftoppm call funnels through `spawnCapture` (ulimit + timeout + AbortSignal kill), reusing the 03-03 sandbox. |

## Known Stubs

None. Both modules are complete and independently host-testable; 03-06 page-pipeline will orchestrate them (native short-circuit vs. rasterize→runCascade per page).

## Docker-gated follow-ups (not host gates, per D-11)

- Real-poppler `pdfinfo`/`pdftoppm` through `spawnCapture`, the concrete `ulimit -v` sizing (A1), and the sufficiency threshold calibration against a mixed native/scanned sample (A3) remain the 03-07 Docker integration smoke — recorded, not a host-suite gate.

## Self-Check: PASSED

- FOUND: lib/v1/input/pdf-text.js
- FOUND: lib/v1/input/rasterize.js
- FOUND: test/pdf-text.test.js
- FOUND: test/rasterize.test.js
- FOUND: test/fixtures/native-sample.pdf
- FOUND commit 94245cd (test: pdf-text RED)
- FOUND commit fa0c0ef (feat: pdf-text GREEN)
- FOUND commit 87ce43a (test: rasterize RED)
- FOUND commit 5c659fb (feat: rasterize GREEN)
- FOUND commit 23e88e0 (chore: register test files)
