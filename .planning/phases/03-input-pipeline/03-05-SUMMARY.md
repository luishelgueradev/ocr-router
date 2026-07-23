---
phase: 03-input-pipeline
plan: 05
subsystem: input
tags: [image, sharp, tiff, gif, heic, bmp, heic-convert, bmp-js, multipage, frames, decompression-bomb, limitInputPixels, caps, node-test]

# Dependency graph
requires:
  - phase: 03-input-pipeline (03-01)
    provides: "lib/v1/input/caps.js — MAX_OUTPUT_PIXELS (limitInputPixels ceiling) + RASTER_MAX_DIM (resize long-side cap)"
provides:
  - "normalizeToFrames(buffer, sniffedType, {maxPixels, maxDim}) → Promise<Buffer[]> — any admitted image (TIFF/GIF/PNG/JPEG/WebP/HEIC/BMP) → ordered normalized PNG frame buffers, page-aware, one frame decoded in memory at a time"
affects: [03-06-page-pipeline, worker]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Multipage TIFF/GIF: read frame COUNT via sharp(buf,{pages:-1}).metadata(), then decode each frame individually with {page:p} inside the loop — never an all-frames allocation (INP-07 / Anti-Patterns)"
    - "Decompression-bomb guard on EVERY sharp() call: explicit limitInputPixels:maxPixels (CAPS.MAX_OUTPUT_PIXELS — far below sharp's permissive 268402689 default) + resize {fit:'inside', withoutEnlargement:true} long-side cap (T-03-11 / Pitfall 1)"
    - "HEIC/BMP DECODE-FIRST: heic-convert (WASM) → JPEG buffer and @vingle/bmp-js → raw RGBA are decoded before sharp; sharp() is NEVER handed a raw HEIC/BMP buffer (prebuilt libvips lacks HEVC/libheif + BMP — CLAUDE.md 'What NOT to Use')"
    - "sharp raw handoff for BMP: sharp(data,{raw:{width,height,channels:4},limitInputPixels})"
    - "Unknown/spoofed sniffedType → typed error (code:'unsupported_image_type', status:422), never a silent pass-through"

key-files:
  created:
    - lib/v1/input/image-normalize.js
    - test/fixtures/multi-frame.tif
    - test/fixtures/two-frame.gif
    - test/fixtures/sample.bmp
  modified:
    - test/image-normalize.test.js
    - package.json

key-decisions:
  - "One shared normalizeOne() pipeline (limitInputPixels → resize cap → grayscale → png) is reused by every branch (TIFF/GIF frame, PNG/JPEG/WebP, HEIC JPEG, BMP raw) so the bomb guard cannot be forgotten on any path"
  - "Frame count for TIFF/GIF comes from a single metadata() read that itself carries limitInputPixels — a bomb is rejected at frame-count time, before any pixel decode"
  - "HEIC host test is skip-guarded on the presence of a real test/fixtures/sample.heic (no host HEIC encoder exists); real HEIC decode is validated in the 03-07 Docker smoke (STATE risk-flag A5) — the host suite never hard-depends on an unproducible HEIC"
  - "A structural source-guard test asserts the module requires heic-convert + @vingle/bmp-js and calls bmp.decode() — locking the decode-first contract (no sharp(rawHeic/rawBmp) anywhere)"
  - "Multi-frame fixtures are tiny real binaries built with sharp via raw.pageHeight (frames stacked vertically at pageHeight=frame height); brightness increases per frame so tests assert monotonic mean luminance == page order preserved"

patterns-established:
  - "Multi-frame image fixture recipe: composite N frames vertically into a raw buffer, then sharp(raw,{raw:{width,height,pageHeight}}).tiff()/.gif() → a real multipage/animated file for host decode tests"

requirements-completed: [INP-05, INP-07]

# Metrics
duration: ~4min
completed: 2026-07-23
---

# Phase 3 Plan 05: Image Frame Normalization (TIFF/GIF/HEIC/BMP → routable PNG frames) Summary

**`lib/v1/input/image-normalize.js` now turns any admitted image — multipage TIFF, animated GIF, HEIC, BMP, and straight-through PNG/JPEG/WebP — into an ordered array of routable normalized PNG frame buffers, one frame decoded in memory at a time, with a `limitInputPixels` + resize decompression-bomb guard on every single decode. TIFF/GIF frame counts come from one metadata read then per-`{page:p}` decode; HEIC (heic-convert WASM) and BMP (@vingle/bmp-js pure-JS) are decoded FIRST and only then handed to sharp — never `sharp()` on the raw buffer. Every decoder runs FOR REAL on the host against tiny real fixtures (BMP fully asserted; HEIC skip-guarded → Docker smoke).**

## Performance

- **Duration:** ~4 min
- **Completed:** 2026-07-23
- **Tasks:** 2 completed (both TDD: RED → GREEN)
- **Files:** 6 (4 created, 2 modified)

## Accomplishments

### Task 1 — sharp frame normalization for TIFF/GIF/PNG/JPEG/WebP (INP-05 / INP-07 / D-04)
- `normalizeToFrames(buffer, sniffedType, {maxPixels=CAPS.MAX_OUTPUT_PIXELS, maxDim=CAPS.RASTER_MAX_DIM})` dispatches on the magic-byte sniffed type.
- **Multipage TIFF / animated GIF:** `sharp(buf,{limitInputPixels:maxPixels,pages:-1}).metadata()` reads the frame count, then a loop decodes ONE frame per iteration via `sharp(buf,{limitInputPixels:maxPixels,page:p}).resize({width:maxDim,height:maxDim,fit:'inside',withoutEnlargement:true}).grayscale().png().toBuffer()`, pushing each PNG and letting the prior raw decode be GC'd before the next (INP-07 — never an all-frames allocation).
- **PNG/JPEG/WebP:** single-frame straight-through normalize via the same shared `normalizeOne()` pipeline → a 1-element array.
- **Every** `sharp()` call carries `limitInputPixels` (guard #4 from Pitfall 1); the resize `fit:'inside'` caps the long side as a second layer.
- Unknown/spoofed sniffedType throws a typed `unsupported_image_type` (status 422).
- Tiny **real** fixtures built with sharp (`raw.pageHeight`): a 3-frame TIFF (`multi-frame.tif`) and a 2-frame GIF (`two-frame.gif`), each with progressively brighter frames so the tests assert monotonic mean luminance == page order preserved.

### Task 2 — HEIC (heic-convert) + BMP (@vingle/bmp-js) decode → sharp handoff (INP-05 / D-05)
- **BMP:** `@vingle/bmp-js` `decode(buffer)` → `{data,width,height}` raw RGBA → `sharp(data,{raw:{width,height,channels:4},limitInputPixels:maxPixels}).resize(...).png()` → 1-element array. Fully asserted on the host against a real `sample.bmp` fixture (dimensions + PNG format preserved) plus a limitInputPixels-rejection case.
- **HEIC:** `heic-convert` `{buffer,format:'JPEG',quality:0.92}` (WASM) → JPEG buffer → the same normalize pipeline → 1-element array. heic-convert is largely synchronous WASM (Pitfall 5 / T-03-12) — acceptable at concurrency-1, documented; a worker_thread is a future out-of-scope mitigation.
- Both branches **decode FIRST then sharp** — `sharp()` is never handed a raw HEIC/BMP buffer (prebuilt libvips excludes HEVC/libheif + BMP; CLAUDE.md 'What NOT to Use'). A structural source-guard test locks this contract.

## Deviations from Plan

None — the plan executed exactly as written. Both tasks followed the RED→GREEN TDD gate. Task 1's GREEN deliberately left the HEIC/BMP branches as clearly-marked throwing stubs (`image_decode_not_implemented`) so Task 2's RED (the real BMP host assertion) failed first, preserving the RED-first gate before Task 2's GREEN filled them.

## Test Results

- `node --test test/image-normalize.test.js` → **10 pass / 0 fail / 1 skipped**, running sharp/@vingle/bmp-js FOR REAL on the host:
  - multipage TIFF → 3 ordered PNG frames (monotonic brightness); animated GIF → 2 ordered PNG frames; PNG/JPEG/WebP → 1 frame each.
  - over-pixel MULTIPAGE input rejected at the metadata() guard; over-pixel SINGLE-frame input rejected at toBuffer — both via `limitInputPixels` (no OOM), proving the guard is on every path.
  - unknown sniffedType → typed `unsupported_image_type`.
  - BMP → single valid PNG (24×18 preserved) via bmp-js → sharp raw handoff; BMP over-pixel rejection.
  - HEIC host test **skipped** (no host HEIC fixture — real decode validated in 03-07 Docker smoke, A5).
  - source-guard: heic-convert + @vingle/bmp-js required, `bmp.decode()` called (decode-first).
- **Full suite `npm test` → 303 pass / 0 fail / 1 skipped** (main `node --test`) **+ 5 pass** (redaction). 293 baseline + 10 new host assertions, no regressions. `test/image-normalize.test.js` registered in `package.json`.

## Threat Model Coverage

| Threat ID | Disposition | Mitigation delivered |
|-----------|-------------|----------------------|
| T-03-11 (pixel bomb via crafted TIFF/GIF/HEIC/BMP) | mitigate | `limitInputPixels: CAPS.MAX_OUTPUT_PIXELS` on EVERY sharp() call (metadata + every frame decode + HEIC/BMP sharp step) + `resize fit:'inside'` long-side cap; multipage decoded one frame at a time. Tested: over-pixel input rejects rather than OOMs on both the multipage-metadata and single-frame paths, and on the BMP branch. Real per-box `MAX_OUTPUT_PIXELS` sizing stays a 03-07 Docker/deploy tuning item. |
| T-03-12 (event-loop stall on large HEIC WASM) | accept | Documented known characteristic (heic-convert is largely synchronous); acceptable at concurrency-1. Future mitigation (worker_thread) out of scope this phase. |
| T-03-13 (decoder crash on hostile input) | mitigate | Each decode surfaces as a rejected promise / typed error, never a process crash; the 03-06 page-pipeline's per-page try/catch records one bad frame without failing the whole job. |

## Known Stubs

None. `image-normalize.js` is complete for all seven admitted image types; 03-06 page-pipeline will orchestrate `normalizeToFrames` → per-frame `runCascade`, releasing each frame buffer between routes.

## Docker-gated follow-ups (not host gates, per D-11)

- Real HEIC decode correctness on the target box (`heic-convert` WASM against actual HEIC samples) remains the 03-07 Docker integration smoke (STATE risk-flag A5) — recorded, not a host-suite gate. The host suite skip-guards the HEIC assertion and never hard-depends on an unproducible HEIC.

## Self-Check: PASSED

- FOUND: lib/v1/input/image-normalize.js
- FOUND: test/image-normalize.test.js
- FOUND: test/fixtures/multi-frame.tif
- FOUND: test/fixtures/two-frame.gif
- FOUND: test/fixtures/sample.bmp
- FOUND commit 03a939a (test: image-normalize RED — Task 1)
- FOUND commit 8cb41d6 (feat: sharp frame normalization GREEN — Task 1)
- FOUND commit 9d44ce7 (test: HEIC/BMP RED — Task 2)
- FOUND commit ea71c78 (feat: HEIC/BMP decode-first GREEN — Task 2)
