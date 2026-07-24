---
phase: 03-input-pipeline
verified: 2026-07-24T03:07:01Z
status: gaps_found
# The verdict below stands as written — it was correct when written. Both gaps
# and Human-Verification item #1 were closed afterwards; see the appendix at the
# end of this file and the quick task it links to.
gaps_resolved_by: .planning/quick/260724-64d-phase3-gaps-and-monotonic-clock/
gaps_resolved_on: 2026-07-24
score: 5/5 success criteria verified (7/7 requirements satisfied)
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 5/5 success criteria (7/7 requirements)
  gaps_closed:
    - "CR-01 truncated pdftoppm output accepted as a successful page — closed (assertRenderedPng: magic + IEND + length floor, rasterize.js:61-76, exercised by 3 tests that feed genuinely truncated buffers)"
    - "CR-02 no frame-count cap for TIFF/GIF; all frames materialized — closed (assertFrameCountWithinCap + async generator multiFrameToPngs, image-normalize.js:120-161; page-pipeline pulls via normalizeFrames not normalizeToFrames)"
    - "CR-03 BMP/HEIC decode allocates from attacker header before any guard — closed for BMP (real DIB parse), best-effort for HEIC (see G-2)"
    - "CR-04 shutdown drained temp dirs BEFORE the job drain — closed (shutdown.js:94-100 runs after limiter.stop(); ordering + late-registration both asserted)"
    - "CR-05 SIGTERM->SIGKILL escalation never fired — closed (armEscalation armed from the 'error' handler when signal.aborted; cleanup() no longer clears the timer; test fake now emits Node's synchronous AbortError)"
    - "CR-06 -scale-to forced the long edge and made RASTER_DPI inert — closed (computeScaleTo; -r and -scale-to are mutually exclusive; worst case bounded at RASTER_MAX_DIM^2 = 25e6 px)"
    - "CR-07 spawnCapture interpolated into a /bin/sh -c string — closed (constant body, all variable parts as positional argv operands; metacharacter regression test)"
    - "WR-01 pdfinfo ran unsandboxed — closed (full ulimits + stdout ceiling) plus fail-closed spawn_sandbox_limits_required"
    - "WR-02 deadline overrun produced empty 'successful' pages — closed (budget clamp in worker.js:185-190 + engine-less result is a page error in page-pipeline.js:100-104)"
    - "WR-03 decoder/pixel-cap failures surfaced as 500 — closed for sharp/bmp/gif/heic-convert paths (typedDecodeError); one reachable bypass remains (see G-1)"
    - "WR-04 unpdf failure aborted the whole job — closed (try/catch degrades to rasterizing every page, page-pipeline.js:144-149)"
    - "WR-05 zero/bogus pdfinfo page count yielded an empty 'completed' job — closed (pdf_no_pages 422, rasterize.js:154-161)"
    - "WR-06 drainAndCancel never cleared its timeout — closed (clearTimeout at shutdown.js:65; test asserts timer._destroyed === true)"
    - "WR-07 unguarded await in runInputJob finally could replace the job outcome — closed (worker.js:317-323; test induces a real EACCES via chmod 0500)"
    - "WR-08 the SIGKILL-escalation test could not fail — closed (fake child now models Node's spawn({signal}) contract: kill + synchronous 'error')"
    - "WR-09 BMP admitted on a 2-byte signature — closed (KNOWN_DIB_HEADER_SIZES + declaredSize>=26, sniff.js:45-50)"
    - "WR-10 no startup sweep for orphaned ocr-job-* dirs — closed (sweepOrphanedTempDirs, wired at server.js:149-152)"
    - "WR-11 docker-smoke gated HEIC/temp cases on poppler — closed (per-capability guards; Docker run reports 8/8 pass, 0 skipped)"
  gaps_remaining: []
  regressions: []
gaps:
  - truth: "Every decode failure on the HEIC/BMP/image path surfaces as a typed 413/422 client error, never an untyped 500 (WR-03)"
    status: partial
    reason: "assertHeicWithinCap is called OUTSIDE the try/catch in heicToPngs, so a RangeError raised by its own bounds arithmetic escapes untyped. Reproduced: a 28-byte upload that sniffs as image/heic and carries an ispe box truncated after the width field throws RangeError/ERR_OUT_OF_RANGE with status undefined, which worker.js:300 maps to internal_error (HTTP 500) and logs 'job crashed'. This is exactly the alerting-signal destruction WR-03 was raised to fix."
    artifacts:
      - path: "lib/v1/input/image-normalize.js"
        issue: "Line 261 bounds-checks `i + 12 <= buf.length` but line 263 reads readUInt32BE(i + 12), which needs i + 16 <= buf.length. Line 294 calls assertHeicWithinCap before the try that wraps heic-convert, so the RangeError is never typed."
    missing:
      - "Correct the ispe bounds check to `i + 16 <= buf.length`"
      - "Route assertHeicWithinCap and assertBmpWithinCap through typedDecodeError so no arithmetic error on a hostile header can escape as a 500"
      - "Add a regression test feeding a truncated-ispe HEIC and asserting status 413/422"
  - truth: "A HEIC that declares oversized image extents is rejected before libheif allocates (CR-03)"
    status: partial
    reason: "The guard only counts an ispe occurrence when the preceding 4 bytes equal exactly 20 (the canonical 32-bit box). ISO-BMFF also permits a 64-bit extended box (size field == 1 followed by an 8-byte largesize), which libheif's generic box parser accepts but this scan skips entirely — largest stays 0 and the file passes. The module comment documents the residual as 'a file with no recognizable ispe is allowed through', which understates it: a file WITH a structurally valid but non-canonically-sized ispe is also allowed through. The documented fallback bound is 'the container's own memory limit' — but docker-compose.yml sets no mem_limit and the image sets no --max-old-space-size, so that bound does not currently exist."
    artifacts:
      - path: "lib/v1/input/image-normalize.js"
        issue: "assertHeicWithinCap (lines 254-277) requires readUInt32BE(i-4) === 20; any other legal encoding bypasses the guard silently."
      - path: "docker-compose.yml"
        issue: "No mem_limit / deploy.resources.limits.memory on the app service, so the documented fallback bound does not exist."
    missing:
      - "Either handle the 64-bit extended box form (size == 1 + largesize) in the ispe scan, or fail closed when an 'ispe' literal is present but its box header is not understood"
      - "Update the module comment so the stated residual matches the actual blind spot"
      - "Set a container memory limit (docker-compose mem_limit) and/or NODE_OPTIONS=--max-old-space-size so the documented fallback bound is real"
human_verification:
  - test: "Submit a real multi-page scanned PDF and a real HEIC over the live HTTP API (POST /v1 multipart, then poll GET /v1/jobs/:id) against the running container, and inspect the returned envelope."
    expected: "HTTP 200 job accepted; the polled job carries result.pages[] with one entry per page in order, result.status_rollup of 'completed' or 'completed_with_errors', and per-page engine/confidence. An over-cap (51+ page) PDF returns a failed job with code pdf_too_many_pages."
    why_human: "No test in the phase exercises the full wire path (multipart -> router -> bottleneck queue -> worker -> job envelope JSON) for an input-pipeline format. Every link is individually unit-tested and the chain is traceable in code (router.js:178 passes sniffedType as mimeType; worker.js:342 dispatches on INPUT_FORMATS; jobs.complete stores pages/status_rollup; GET /v1/jobs/:id returns the whole job), but the assembled path has never been run."
  - test: "Decide whether the HEIC ispe blind spot (gap G-2) is an acceptable residual risk for this milestone, or must be closed before Phase 4."
    expected: "An explicit accept (recorded as a verification override) or a fix ticket."
    why_human: "Requires a product/security risk judgement about an in-process WASM decoder on an unmetered container, not a programmatic check."
  - test: "Confirm the RASTER_MAX_DIM / MAX_OUTPUT_PIXELS relationship is intended to be maintained by hand."
    expected: "Either a boot-time cross-check that RASTER_MAX_DIM^2 <= MAX_OUTPUT_PIXELS, or an accepted decision that operators must keep them consistent."
    why_human: "The defaults align exactly (5000^2 == 25,000,000) but caps.js validates each key independently, so an operator raising RASTER_MAX_DIM alone silently breaks the documented worst-case pixel bound. Whether that matters is a tuning-policy call."
---

# Phase 3: Input Pipeline Verification Report

**Phase Goal:** The service accepts PDFs (native and scanned) and additional image formats, turning any upload into memory-safe per-page results routed through the already-proven cascade.
**Verified:** 2026-07-24T03:07:01Z
**Status:** gaps_found (5/5 Success Criteria hold; 2 reproducible residual defects in controls the fix pass claimed closed)
**Re-verification:** Yes — after the 17-commit code-review fix pass (`b1eb8d3..HEAD`)

## Why this verification differs from the previous one

The previous pass returned `passed, 5/5, no gaps` and was wrong — a code review immediately afterward found 23 issues. That verifier accepted module header comments and test names as evidence. This pass treated both as claims and did the following instead:

- Read the control flow of every safety property the headers assert, not the header text.
- Read the BODY of every test named after a guard, checking the input actually reaches the failure mode.
- Checked whether each injected fake (`spawnFn`, fake cascade, fake clock, fake limiter, fake temp) can reach the real failure mode or models it away.
- Ran independent adversarial probes in-process against the real modules rather than relying on the reported suite result.

All 18 Critical+Warning findings from `03-REVIEW.md` were independently re-checked against the code. All 18 are genuinely closed. Two NEW residual defects were found by probing, both inside controls the fix pass declared complete.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A native (text-bearing) PDF returns per-page embedded text without invoking OCR; a scanned PDF is rendered page-by-page and each page routed through the cascade | VERIFIED | `pdf-text.js#sufficient` requires MIN_NATIVE_CHARS **and** a `\p{L}{2,}` token (a real false-positive floor, not `length > 0`). `page-pipeline.js:151-168` takes the native branch with `engine:'pdf-native'` and `continue`s — no routePage call. Test `PDF native pages short-circuit OCR: routePage is NEVER called` asserts `routePage.calls.length === 0` against a **real** 2-page PDF through **real** unpdf. The mixed-PDF test proves per-page decisions. Docker smoke `smoke/INP-04` rasterizes through real pdfinfo + pdftoppm and decodes the result with sharp. |
| 2 | Additional image formats (TIFF multipage, HEIC, BMP, GIF) normalized before cascading, with untrusted decode/rasterization in a killable, resource-limited subprocess and temp files always cleaned up (even on mid-job kill) | VERIFIED (scope caveat below) | Formats: `upload.js:16-21` declared-MIME gate, `sniff.js` authoritative magic-byte gate (BMP now DIB-validated — WR-09), `worker.js:18-24` INPUT_FORMATS, `image-normalize.js#normalizeFrames` dispatch. Subprocess: every poppler call funnels through `spawnCapture`, which is fail-closed on missing ulimits (WR-01), builds a constant `sh -c` body with argv-positional operands (CR-07), and escalates SIGTERM->SIGKILL from the `error` handler (CR-05). Temp: `finally` cleanup guarded (WR-07), shutdown drain now runs AFTER the job drain (CR-04), boot sweep for SIGKILL orphans (WR-10). |
| 3 | Multi-page inputs return per-page results with a per-page status rollup, one failed page neither fails the job nor is silently dropped, page order preserved | VERIFIED | `page-pipeline.js:76-89` pushError records the page and continues; `:206` computes the rollup. Critically, WR-02 closed the "silently dropped" hole in both directions: an engine-less cascade result is now a page error (`:100-104`), and a page attempted past the job deadline throws `job_deadline_exceeded` before calling the provider (`worker.js:185-190`). The deadline test manipulates `Date.now` for real and asserts `budgets.length === 1` — past-deadline pages never reach a paid provider yet are still recorded. |
| 4 | Rasterization streams exactly one page image in memory at a time and enforces page-count, DPI, and pixel caps, so a large or decompression-bomb PDF cannot exhaust the memory budget | VERIFIED | See the CR-06 bound analysis below. Page count: `pdfInfo` -> `assertPageCountWithinCap` BEFORE any render (test asserts `pdftoppm` was never invoked). Frames: MAX_IMAGE_FRAMES gate on `meta.pages` before any frame decodes. Streaming: `multiFrameToPngs` is an async generator and `page-pipeline.js:174-203` consumes `normalizeFrames` (the streaming entry), **not** `normalizeToFrames` (the collecting test convenience). Rasterization writes only the input PDF to disk and captures one page to stdout. |
| 5 | Native-decode dependencies pinned to CVE-fixed versions (`sharp>=0.35.0`) and scanned in CI | VERIFIED (caveat) | `package.json` pins `sharp ^0.35.3`, `unpdf ^1.6.2`, `heic-convert ^2.1.0`, `@vingle/bmp-js ^0.2.5`. `scripts.audit = npm audit --omit=dev --audit-level=high`; orchestrator-run `npm run audit` -> exit 0, "found 0 vulnerabilities". README section "Dependency security (OPS-06)" documents scope, remediation and the no-allowlist state. **Caveat:** there is no CI workflow in the repo (`.github/` absent) — the gate is a documented npm script only. D-09 permits "npm audit gate, **or equivalent**", and the project has no CI infrastructure at all, so this is judged satisfied rather than failed. |

**Score:** 5/5 truths verified.

### CR-06 worst-case pixel bound — independently checked

The deviation the fixer declared was verified against three cases:

| Case | `longEdgePts` | Resolution flag emitted | Long-edge px | Worst-case pixels |
|------|--------------|------------------------|--------------|-------------------|
| Normal A4 | 841.89 | `-scale-to 2339` | 2339 | ~5.5e6 |
| Degenerate / hostile MediaBox (200 in) | 14400 | `-scale-to 5000` | 5000 (clamped) | 25e6 = RASTER_MAX_DIM^2 |
| Geometry missing or unparseable | null | `-r 200` (never a bare `-scale-to`) | unbounded | bounded by `ulimit -v` 768 MB and MAX_RASTER_STDOUT_BYTES 40 MB |

`computeScaleTo` returns `max(1, min(maxDim, natural))`, so the emitted target is **always** <= maxDim; poppler's `-scale-to` scales the long edge and derives the short edge from the aspect ratio, so the short edge is also <= maxDim. Worst case is therefore exactly `RASTER_MAX_DIM^2 = 25,000,000` px, equal to MAX_OUTPUT_PIXELS. The bound holds.

The null-geometry fallback (`-r` alone) is honestly documented and is not a memory-budget breach: a runaway render is killed by `ulimit -v` (non-zero exit -> `subprocess_failed` -> per-page error) or rejected by the 40 MB stdout ceiling, and the parent's own memory is bounded by that ceiling regardless. In practice pdfinfo emits `Page size:` whenever it emits `Pages:`, so this path is near-unreachable. Both regex forms (`Page size:` and per-page `Page N size:`) are covered by a test.

The heterogeneous-PDF caveat in the `pdfInfo` docstring is accurate and matters only for DPI fidelity, never for the ceiling — every page's target is clamped by the same `maxDim`.

### CR-03 residual (HEIC guard) — judgement

The fixer's declared deviation is that the HEIC guard is a targeted `ispe` scan and "a file with no recognizable `ispe` is allowed through". **That understatement is itself the problem.** The scan only counts an occurrence when `readUInt32BE(i-4) === 20`, so a structurally valid ISO-BMFF 64-bit extended box (`size == 1` + 8-byte `largesize`) — which libheif's generic box parser accepts — is skipped entirely and the file passes with `largest = 0`. The residual is wider than described.

Whether that is acceptable is a human risk call (human verification item 2), because the documented fallback bound ("the container's own memory limit") does not currently exist: `docker-compose.yml` sets no `mem_limit` and the image sets no `--max-old-space-size`. I do **not** treat this as a Success-Criterion failure: D-07 scoped in-process image decode as "where feasible", the upload cap is 10 MB, and exploitation requires a crafted non-canonical box.

### WR-06 (shutdown timer not unref'd) — reasoning confirmed

The fixer's reasoning holds. `clearTimeout(timer)` at `shutdown.js:65` fires on both race outcomes, so a fast drain releases the loop immediately — the 35 s `docker stop` symptom is gone. Leaving the timer ref'd is correct: it is the only handle guaranteeing the process stays alive long enough for the timeout branch to fail in-flight jobs with `shutdown_timeout`, and it exists only during an actual shutdown drain, which is precisely when the process should not exit. The test proves the fix mechanically (`grace.t._destroyed === true`), not by timing.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `lib/v1/input/caps.js` | Boot-validated env-overridable caps | VERIFIED | 92 lines, 13 frozen keys via `intFromEnv`; test proves a negative/non-numeric override throws at load. |
| `lib/v1/input/spawn-capture.js` | Killable sandboxed subprocess seam | VERIFIED | Constant `sh -c` body + positional argv; fail-closed on missing ulimits; SIGKILL escalation survives promise settlement. Used by `rasterize.js` for both pdfinfo and pdftoppm — no other `child_process` call exists in the input pipeline. |
| `lib/v1/input/rasterize.js` | Page-count gate + one-page render + output validation | VERIFIED | `pdfInfo` (count + geometry in one call), `assertPageCountWithinCap`, `computeScaleTo`, `assertRenderedPng`, `renderPage`. Wired from `page-pipeline.js:33`. |
| `lib/v1/input/image-normalize.js` | Streaming normalized PNG frames with bomb guards | VERIFIED (2 partials — see gaps) | Generator streaming confirmed; frame cap confirmed; BMP header guard confirmed by probe; HEIC guard partial. |
| `lib/v1/input/pdf-text.js` | Native-text extraction + native/scanned decision | VERIFIED | Real unpdf via dynamic import; `sufficient()` has a genuine word-token floor. |
| `lib/v1/input/page-pipeline.js` | Ordered per-page results + rollup | VERIFIED | Wired from `worker.js:266`. |
| `lib/v1/input/temp.js` | Per-job temp registry + drain + boot sweep | VERIFIED | Wired from `worker.js:12/259/319`, `shutdown.js:95`, `server.js:149`. |
| `lib/v1/sniff.js` | Magic-byte gate for PDF/TIFF/HEIC/BMP/GIF | VERIFIED | BMP now requires a known DIB header size; HEIC brand allowlist; every branch length-guarded. |
| `lib/v1/shutdown.js` | Drain ordering + grace timer | VERIFIED | Temp drain after job drain; timer cleared. |
| `lib/v1/worker.js` | `runInputJob` — one deadline, temp lifecycle, typed failures | VERIFIED | Deadline clamp, guarded finally, 413/422 mapping. |
| `package.json` | Pinned decoders + audit gate | VERIFIED | See SC5. |
| `Dockerfile` | poppler-utils + tini in runtime image | VERIFIED | Line 23 installs `tini poppler-utils` on `node:22-bookworm-slim`; `USER node`. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `router.js` | `worker.runJob` | `mimeType: sniffedType` (`router.js:178`) | WIRED | The authoritative sniffed type, never the client mimetype, reaches the worker. |
| `worker.runJob` | `runInputJob` | `INPUT_FORMATS.has(mimeType)` (`worker.js:342`) | WIRED | PDF/TIFF/HEIC/BMP/GIF only; PNG/JPEG/WebP stay on the unchanged single-image path (asserted by test). |
| `runInputJob` | `page-pipeline.runPipeline` | injected `routePage` + `signal` + `tempDir` + `spawnFn` | WIRED | One AbortController bounds rasterization AND every cascade call. |
| `page-pipeline` | `image-normalize.normalizeFrames` | `:174` (generator, not the collecting helper) | WIRED | This is what makes the one-frame-in-memory property real rather than aspirational. |
| `page-pipeline` | `rasterize.pdfInfo` / `renderPage` | `:130` / `:161` (geometry threaded through) | WIRED | Exactly one pdfinfo call serves both the cap gate and the render geometry (asserted). |
| `rasterize` | `spawnCapture` | both pdfinfo and pdftoppm | WIRED | No unsandboxed subprocess remains. |
| `runInputJob` | `jobs.complete` | `pages` + `status_rollup` (`worker.js:276-286`) | WIRED | `GET /v1/jobs/:id` returns the whole job (`router.js:196`), so the envelope reaches the client. |
| `shutdown.drainAndCancel` | `temp.drainAllTempDirs` | after `limiter.stop()` (`shutdown.js:94-100`) | WIRED | Ordering asserted; late-registered dir asserted removed. |
| `server.js` | `temp.sweepOrphanedTempDirs` | boot, fire-and-forget (`server.js:149-152`) | WIRED | |
| `image-normalize` HEIC branch | `typedDecodeError` | `heicToPngs:294` guard sits OUTSIDE the try | **PARTIAL** | Gap G-1 — the pre-decode guard's own throws bypass the typing layer. |

### Data-Flow Trace (Level 4)

| Artifact | Data variable | Source | Produces real data | Status |
|----------|--------------|--------|--------------------|--------|
| `page-pipeline` PDF branch | `texts[]` | real `unpdf` `extractText({mergePages:false})` on the uploaded buffer | Yes — test asserts the concatenated output contains "page one" / "Second page" from a real fixture PDF | FLOWING |
| `page-pipeline` PDF branch | `png` | real `pdftoppm` in the Docker smoke; validated fake on host | Yes — Docker smoke decodes the captured buffer with sharp and asserts real width/height | FLOWING |
| `page-pipeline` image branch | frame buffers | real `sharp`/`heic-convert`/`bmp-js` on host | Yes — TIFF/GIF frame-order tests compare real per-frame luminance means; BMP test asserts preserved 24x18 dimensions | FLOWING |
| `jobs.result.pages[]` | per-page envelope | `runPipeline` return | Yes — `worker-input.test.js` reads `job.result.pages` back out of the real jobs store | FLOWING |

### Behavioral Spot-Checks (run by this verifier, in-process, against the real modules)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Crafted truncated-`ispe` HEIC is typed, not a 500 | `node -e "assertHeicWithinCap(craftedBuf, 25e6)"` | `THREW: RangeError ERR_OUT_OF_RANGE status=undefined` | **FAIL** — gap G-1 |
| Same buffer end-to-end through sniff + normalize | `node -e "normalizeToFrames(buf, sniffImage(buf))"` | `sniff = image/heic`; `rejected: RangeError code=ERR_OUT_OF_RANGE status=undefined` -> worker maps to `internal_error` (500) | **FAIL** — reachable from a 28-byte upload |
| No debt markers in phase-modified files | `grep -rnE "TODO\|FIXME\|XXX\|TBD\|HACK"` over `lib/v1/input/`, `sniff.js`, `shutdown.js`, `worker.js`, `upload.js`, `server.js` | Only `ocr-job-XXXXXX` (an mkdtemp template) and the Phase-1 `PLACEHOLDER_API_TOKEN` boot guard | PASS |
| `sweepOrphanedTempDirs` actually wired at boot | `grep -rn` across the repo | `server.js:149-150` | PASS |
| Container memory limit backing the CR-03 fallback claim | `grep -nE "mem_limit\|resources\|max-old-space" docker-compose.yml Dockerfile` | no match | **FAIL** — gap G-2 |

### Probe Execution

| Probe | Command | Result | Status |
|-------|---------|--------|--------|
| Host unit suite | `npm test` (run by orchestrator, cited not re-run) | **352 tests, 352 pass, 0 fail, 0 skipped** (baseline before fixes: 313) | PASS |
| Real-dependency Docker smoke | `REBUILD=1 bash scripts/docker-smoke.sh` (orchestrator, freshly rebuilt image) | **8 tests, 8 pass, 0 fail, 0 skipped** against real poppler 22.12.0 / heic-convert / dash / coreutils | PASS |
| Dependency audit | `npm run audit` (orchestrator) | exit 0, "found 0 vulnerabilities" | PASS |
| pdftoppm `-scale-to` empirical bound | in-container measurement (orchestrator) | `-r 50\|150\|300` with `-scale-to 5000` all emit a byte-identical 70539-byte PNG; without `-scale-to`, `-r 50` -> 2116 B and `-r 300` -> 37576 B | PASS — confirms `-scale-to` overrides `-r`, the empirical basis for CR-06 |

Note on the Docker smoke: `test/docker-smoke.test.js` declares 8 tests and 8 were reported passing with **0 skipped**, so the WR-11 per-capability guards (`requirePoppler` / `requireHeic` / none) did not silently green-skip the A5 HEIC or Pitfall-2 cases.

### Requirements Coverage

| Requirement | Source plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| INP-03 | 03-04 | Native PDFs have embedded text extracted per page without OCR | SATISFIED | SC1 evidence |
| INP-04 | 03-04 | Scanned PDFs rendered page-by-page, each routed through the cascade | SATISFIED | SC1 evidence + Docker smoke INP-04 (x2) |
| INP-05 | 03-02, 03-05 | TIFF/HEIC/BMP/GIF normalized before routing | SATISFIED | SC2 evidence; real host decode tests for TIFF/GIF/BMP/HEIC |
| INP-06 | 03-06 | Per-page results + rollup; a single failed page does not fail the job silently | SATISFIED | SC3 evidence; the WR-02 fix is what made "not silently" actually true |
| INP-07 | 03-01, 03-04, 03-05 | One page image in memory at a time; page-count, DPI, pixel caps | SATISFIED | SC4 evidence + the CR-06 bound table |
| INP-08 | 03-03, 03-06 | Untrusted decode/rasterization in a killable, resource-limited subprocess; temp files always cleaned | SATISFIED (scoped) | Rasterization is fully sandboxed. Image decode is in-process by design (D-07: "and — where feasible — sharp/heic/bmp decode"), compensated by header pre-checks + `limitInputPixels` + frame cap. Gap G-2 is the residual on that compensating control. Temp cleanup verified on all three paths (finally / shutdown drain / boot sweep). |
| OPS-06 | 03-01 | `sharp>=0.35.0` pinned, scanned in CI | SATISFIED (caveat) | SC5 evidence; no CI runner exists in the repo |

No orphaned requirements: `.planning/REQUIREMENTS.md` maps exactly INP-03..08 and OPS-06 to Phase 3, and all eight appear in plan frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `lib/v1/input/image-normalize.js` | 261-263 | Off-by-four bounds check before a `readUInt32BE` | WARNING | Untyped RangeError escapes as a 500 (gap G-1) |
| `lib/v1/input/image-normalize.js` | 254-277 | Guard recognizes only one of several legal box encodings | WARNING | Silent bypass of a decompression-bomb pre-check (gap G-2) |
| `test/image-normalize.test.js` | 131-146 | Test titled "streams one frame at a time" asserts only that a returned generator is done after `.return()` — true of ANY generator, eager or lazy | INFO | Title over-claims; the laziness property is nevertheless real and was confirmed by reading `multiFrameToPngs` (per-iteration `sharp(buf, {page: p})`) and confirming `page-pipeline.js:174` consumes the generator, not `normalizeToFrames` |
| `test/docker-smoke.test.js` | 220-239 | "a mid-job SIGTERM (shutdown drain)" calls `drainAllTempDirs()` directly; no signal is sent | INFO | Title over-claims; the actual shutdown ordering is covered properly by the two CR-04 tests in `shutdown.test.js` |
| `test/image-normalize.test.js` | 315-323 | Asserts on module SOURCE TEXT (`require('heic-convert')` appears) | INFO | Known IN-02; harmless as a structural guard because real behavioral BMP/HEIC decode tests sit beside it |
| `lib/v1/input/page-pipeline.js` | 147 | `catch { texts = [] }` swallows the unpdf error with no debug log | INFO | Known IN-03; the degradation is deliberate (WR-04) but the cause is unobservable in logs |
| `lib/v1/input/caps.js` | 44, 51 | `MAX_OUTPUT_PIXELS` and `RASTER_MAX_DIM` are validated independently though the raster path's pixel bound is `RASTER_MAX_DIM^2` | INFO | Defaults align exactly today; an operator raising one alone silently breaks the documented bound |

No BLOCKER-class anti-patterns. No debt markers (`TBD`/`FIXME`/`XXX`) in any phase-modified file.

### Human Verification Required

#### 1. End-to-end wire path for an input-pipeline format

**Test:** Against the running container, POST a real multi-page scanned PDF and a real HEIC as multipart to `/v1`, then poll `GET /v1/jobs/:id`.
**Expected:** 200 on submit; the polled job carries `result.pages[]` with one ordered entry per page, `result.status_rollup` of `completed` or `completed_with_errors`, and per-page `engine`/`confidence`. A 51+ page PDF returns a failed job with code `pdf_too_many_pages`.
**Why human:** No test exercises multipart -> router -> queue -> worker -> job envelope for a PDF/TIFF/HEIC/BMP/GIF. Every link is individually verified and the chain is traceable in code, but the assembled path has never been run. This is the single largest untested seam in the phase.

#### 2. Accept-or-fix decision on the HEIC `ispe` blind spot

**Test:** Decide whether gap G-2 is an acceptable residual for this milestone.
**Expected:** An explicit accept recorded as a verification override, or a fix ticket before Phase 4.
**Why human:** A product/security risk judgement about an in-process WASM decoder running on a container with no memory limit — not a programmatic check.

#### 3. Caps cross-validation policy

**Test:** Decide whether `RASTER_MAX_DIM^2 <= MAX_OUTPUT_PIXELS` should be enforced at boot.
**Expected:** Either a boot-time cross-check in `caps.js` or an accepted decision that operators keep them consistent by hand.
**Why human:** Tuning-policy call; the defaults are correct today.

### Gaps Summary

The fix pass did what it claimed. All 18 Critical and Warning findings from `03-REVIEW.md` are genuinely closed in code — verified by reading control flow, not headers — and the tests that cover them now reach the real failure modes (a real `chmod 0500` EACCES for WR-07, a real `Date.now` shift for WR-02, a fake child that emits Node's synchronous AbortError for CR-05/WR-08, genuinely truncated PNG buffers for CR-01, a 54-byte header-lying BMP for CR-03). The one test the previous verifier was fooled by — "BMP path still applies limitInputPixels (no OOM)", which fed a *valid* large BMP — has been deleted and replaced with three tests that exercise the actual attack shape. The replacement is even documented in-file as proving the opposite of its old title.

All five ROADMAP Success Criteria hold. The phase goal is achieved.

Two residual defects remain, both inside controls the fix pass declared complete, and both found by probing rather than by reading:

- **G-1** is a straightforward bug: `assertHeicWithinCap` bounds-checks `i + 12 <= buf.length` and then reads at `i + 12` (needing `i + 16`), and it is called outside the try/catch that types decoder errors. A 28-byte upload turns into `internal_error` (HTTP 500) plus a spurious `job crashed` error log. That is exactly the alerting-signal destruction WR-03 was raised to eliminate, surviving in the one code path the WR-03 fix did not cover. Small, mechanical fix.
- **G-2** is a scope-of-guard issue: the `ispe` scan recognizes only the canonical 32-bit box header, so a legal 64-bit extended box bypasses it entirely. The module comment describes the residual as "no recognizable `ispe`", which is narrower than the truth. Compounding it, the documented fallback bound — "the container's own memory limit" — does not exist: neither `docker-compose.yml` nor the Dockerfile sets one.

Neither gap invalidates a Success Criterion, and neither is a memory-exhaustion or security bypass on the rasterization path (which is fully sandboxed and bounded). They are listed as `status: partial` so they route to a small focused fix plan rather than blocking Phase 4 outright — but they should be closed before the milestone audit, because both live in the decompression-bomb defense that INP-07/INP-08 exist to provide.

---

_Verified: 2026-07-24T03:07:01Z_
_Verifier: Claude (gsd-verifier), re-verification after code-review fix pass_

---

## Appendix — gap resolution (2026-07-24, quick task 260724-64d)

Everything above is the verifier's report as written. This appendix records what
happened to the open items; it does not amend the verdict.

| Open item | Outcome | Evidence |
|---|---|---|
| **G-1** — ispe bounds off-by-four; untyped `RangeError` → 500 | **closed** | Bound corrected to the 16 bytes the reads consume, and the guard moved inside the WR-03 try. Repro before: `RangeError / ERR_OUT_OF_RANGE / status=undefined`. After: `image_decode_failed / status=422`. Also asserted over full HTTP (`test/e2e-input-http.test.js`). Commit `2959b94`. |
| **G-1 follow-on** — "route `assertBmpWithinCap` through `typedDecodeError` too" | **closed** | Commit `65568d1`. No reachable out-of-bounds read existed on that path; moving it inside the try keeps that true by construction. |
| **G-2** — ispe scan bypassable by legal box encodings | **closed** | Payload offset now resolved per encoding (32-bit, 64-bit extended `size==1`, `size==0` to-EOF). Three new tests **fail against the previous scan** and pass against the new one. Commit `310fab0`. |
| **G-2** — "the container's own memory limit" did not exist | **closed** | `mem_limit` + `memswap_limit` added to `docker-compose.yml`. `docker compose config` renders `1073741824`; the kernel reports `memory.max = 1073741824` inside the running container. The module comment now states the true residual instead of a narrower one. Commit `310fab0`. |
| **Human Verification #1** — the assembled HTTP path had never run | **closed** | `test/e2e-input-http.test.js`: real server, real multipart, real auth, real sniff, real decode, real pipeline, real queue, real worker, real envelope — only `runOCR` is substituted. **8/8 in the container, 0 skipped**, covering TIFF, GIF, HEIC, BMP, native PDF and scanned PDF. Verified non-vacuous. Commit `0f10fd3`. |
| **Human Verification #2** — accept-or-fix on the ispe blind spot | **resolved by fixing**, not by accepting. | See G-2 above. |
| **Human Verification #3** — caps cross-validation policy | **still open** | Untouched; `RASTER_MAX_DIM² <= MAX_OUTPUT_PIXELS` is still an operator convention rather than a boot check. |
| INFO findings IN-02, IN-03, and the two over-claiming test titles | **still open** | Untouched. |

### Two defects the verification did not catch

Found while re-auditing the phase after a session interruption, both by probing
rather than reading:

1. **The suite was not the stable "352/352 green" the phase record asserts** — it
   failed 2 of 6 runs. Root cause was not a flaky test: every budget and deadline
   was computed on the **wall clock**, so a backward NTP/VM step inflated
   `remaining` and let the runner escalate past its budget (captured:
   `stopped_reason=passed elapsed=-791`). The same arithmetic backed
   `worker.js`'s `deadline = Date.now() + MAX_JOB_MS` — the single authoritative
   job deadline JOB-04/CASC-08 exist to enforce. Migrated to a monotonic clock
   (`lib/clock.js`); commit `35e8be4`.
2. **The WR-10 orphan sweep deleted temp dirs owned by other test processes**,
   because `node --test` runs files in parallel against a shared `/tmp` while the
   sweep documents a single-instance precondition. Fixed on the test side; the
   sweep itself is unchanged. Commit `4314563`.

Process note, extending the one already recorded in STATE.md: the previous
verification cited "host suite 352/352" without re-running it. It was 347 tests
with 3 failures on the first run of this session. A cited number is not evidence.
