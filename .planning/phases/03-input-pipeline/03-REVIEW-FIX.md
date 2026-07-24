---
phase: 03-input-pipeline
fixed_at: 2026-07-24T00:00:00Z
review_path: .planning/phases/03-input-pipeline/03-REVIEW.md
iteration: 1
findings_in_scope: 18
fixed: 18
skipped: 0
status: all_fixed
---

# Phase 3: Code Review Fix Report

**Fixed at:** 2026-07-24
**Source review:** `.planning/phases/03-input-pipeline/03-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 18 (7 Critical + 11 Warning; Info tier out of scope)
- Fixed: 18
- Skipped: 0

**Test suite:** 352 pass / 0 fail / 0 skipped (baseline before these changes: 313 pass / 0 fail / 0 skip). +39 tests. Suite run three times with identical results — no flakiness observed.

Two Info findings were fixed incidentally because they were the same defect as a
Critical one: **IN-04** (dead `dpi` parameter) is resolved by CR-06, and **IN-01**
(module headers asserting properties the code does not implement) is resolved
across CR-02/CR-03/CR-06 — every header claim that the review flagged as false is
now either true or corrected in place.

## Verification approach

Every fix that changes behaviour has a test that was confirmed to **FAIL against
the pre-fix code** and pass after. This was checked explicitly for CR-01, CR-03,
CR-04, CR-05, WR-02, WR-03, WR-04, WR-06, WR-07 and WR-09 by reverting the
source file, running the new test, and restoring. Several pre-existing tests
were rewritten because they asserted the buggy behaviour or used fakes that
could not reach the real failure mode — details per finding below.

## Fixed Issues

### CR-01: Truncated / degenerate `pdftoppm` output accepted as a successful page

**Files modified:** `lib/v1/input/rasterize.js`, `test/rasterize.test.js`, `test/page-pipeline.test.js`, `test/worker-input.test.js`
**Commit:** `8ead22f`
**Applied fix:** Added `assertRenderedPng()` — PNG magic + a 1024-byte floor + the terminating `IEND` chunk (the definitive truncation test) — and made `renderPage` await and validate before returning. A failure is a typed `raster_output_truncated` (422) carrying only the byte count, so page-pipeline records it as a per-page error instead of base64-ing garbage to a paid provider and reporting `status_rollup: 'completed'`.

Test fakes across three files emitted 4–8 byte stub "PNGs" that the new validator correctly rejects; they now build structurally complete fake PNGs. Added a pipeline-level test proving a truncated render yields `completed_with_errors` with **zero** provider calls.

### CR-02: No frame-count cap for TIFF/GIF — unbounded memory and provider calls

**Files modified:** `lib/v1/input/image-normalize.js`, `lib/v1/input/caps.js`, `lib/v1/input/page-pipeline.js`, `test/image-normalize.test.js`, `test/caps.test.js`
**Commit:** `9ee3666`
**Applied fix:** Added `MAX_IMAGE_FRAMES` (default 50, mirroring `MAX_PDF_PAGES`) and `assertFrameCountWithinCap`, gated **before** any frame decodes. Converted `normalizeToFrames` into an async generator `normalizeFrames` and switched page-pipeline to pull one frame at a time, so the header's "ONE FRAME IN MEMORY AT A TIME" claim is now true rather than aspirational. `normalizeToFrames` survives as an explicitly-documented array-collecting test convenience.

Because an async generator body does not run until the first `next()`, the pipeline primes the iterator outside the per-page try/catch — so `too_many_frames` / `unsupported_image_type` / a pixel-cap breach still fail the job typed **before** any page is routed. A mid-stream decode failure is recorded as a page error rather than discarding pages already routed and paid for.

### CR-03: BMP/HEIC decode allocates from attacker-controlled header before any pixel guard

**Files modified:** `lib/v1/input/image-normalize.js`, `test/image-normalize.test.js`
**Commit:** `555586b`
**Applied fix:** Added `assertBmpWithinCap` (parses the DIB header, handling both `BITMAPCOREHEADER`'s 16-bit and `BITMAPINFOHEADER`+'s 32-bit dimensions, and a negative height as a legal top-down bitmap) and `assertHeicWithinCap` (scans every `ispe` box, length-checked at 20 bytes, and takes the largest declared image). Both run before their decoder touches the buffer. Corrected the module header, which claimed a decompression-bomb guard on *every* decode — it now states plainly that `limitInputPixels` cannot cover BMP/HEIC and points at the two explicit pre-checks.

Replaced the test the review called out as proving the opposite of its title: `"BMP path still applies limitInputPixels (no OOM)"` encoded a genuinely large **valid** BMP, so bmp-js allocated the whole framebuffer successfully and only then did sharp reject — the OOM had already happened. The replacement feeds a 54-byte file whose header claims 20000×20000 (a 1.6 GB `Buffer.alloc` without the guard). The HEIC test tampers with the real fixture's `ispe` box to claim 30000×30000.

**Known limit, stated in the code:** the HEIC check is a targeted `ispe` scan, not a full ISO-BMFF parser. A file with no recognizable `ispe` box is allowed through, because failing closed there would reject valid HEICs the scan simply failed to understand. libheif needs an `ispe` to size its own decode, so a bomb must declare one — but this is best-effort, not a proof. A worker-thread decode with a hard `--max-old-space-size` remains the complete fix and is out of scope here. This caveat is documented at the function.

### CR-04: Shutdown drains temp dirs before the job drain

**Files modified:** `lib/v1/shutdown.js`, `lib/v1/input/temp.js`, `test/shutdown.test.js`
**Commit:** `96e3762`
**Applied fix:** Moved `drainAllTempDirs()` from the first step of `drainAndCancel` to after the job drain completes, so the in-flight job's `input.pdf` is no longer `rm -rf`'d out from under a running `pdftoppm` at t=0. Also changed `drainAllTempDirs` to deregister exactly the dirs it snapshotted instead of `active.clear()`, which would otherwise drop any dir registered during the await and lose track of it permanently.

The existing test passed regardless of ordering (it only checked the dir was eventually gone), so two new tests were added: one asserting the observed order is `['jobs_drained', 'temp_drained']`, one creating a temp dir *during* the drain window and asserting it is still removed. Both fail against the pre-fix code.

### CR-05: SIGTERM→SIGKILL escalation never fires in production

**Files modified:** `lib/v1/input/spawn-capture.js`, `test/spawn-capture.test.js`
**Commit:** `f2e8cfb`
**Applied fix:** The escalation no longer depends on abort-listener ordering. Node's own `spawn({signal})` listener is registered first and synchronously emits `'error'`, which settled the promise and removed `escalate` inside the same dispatch — and per the EventTarget spec a listener removed mid-dispatch is never invoked. Two changes make it reachable: the `'error'` handler arms the escalation itself when `signal.aborted`, and `cleanup()` no longer clears the timer (settling the promise says nothing about whether the child died; only `'close'` does, and that is where the timer is now cleared). The timer stays unref'd so a pending SIGKILL never holds the process open.

**WR-08 fixed in the same commit** (same mechanism): `makeFakeChild` was a bare `EventEmitter` that never emitted `'error'`, so the old escalation test could not fail. It now models Node's real contract — registered from inside `spawnFn` so the ordering matches production, killing with SIGTERM and synchronously emitting an AbortError, with an `ignoresSigterm` option. Added a CR-05 regression test (**confirmed failing pre-fix**), a test that a compliant child is signalled exactly once, and a test that a genuine spawn failure (ENOENT, no abort) does *not* arm the escalation.

### CR-06: `-scale-to` overrides `-r` — `RASTER_DPI` inert, small pages upscaled

**Files modified:** `lib/v1/input/rasterize.js`, `lib/v1/input/caps.js`, `lib/v1/input/page-pipeline.js`, `test/rasterize.test.js`, `test/page-pipeline.test.js`
**Commit:** `d87cefc`
**Applied fix:** Neither of the review's two options alone satisfied the constraint that the caps must still bound worst-case pixels (Option A drops the dimension ceiling entirely), so I implemented Option B without adding a subprocess. `pdfPageCount` became `pdfInfo`, which parses **both** `Pages:` and the page geometry from the *same* pdfinfo call it was already making. `renderPage` then computes `computeScaleTo(longEdgePts, dpi, maxDim)` = the page's natural pixel size at `dpi`, clamped to `maxDim`.

`-r` and `-scale-to` are now mutually exclusive, because poppler ignores `-r` whenever `-scale-to` is present:
- geometry known (normal path) → `-scale-to <computed>` only. A4 at 200 DPI renders at 2339 px, not the 5000 px ceiling; raising `RASTER_DPI` genuinely raises resolution; a 200-inch hostile MediaBox clamps to 5000 px, bounding worst case at `maxDim²` = 25 M px = `MAX_OUTPUT_PIXELS`.
- geometry unknown → `-r <dpi>` only, never a bare `-scale-to maxDim` (which would upscale rather than cap). The ceiling there falls to `ulimit -v` and `MAX_RASTER_STDOUT_BYTES`, which is documented explicitly rather than implied.

Corrected the falsified comments in `rasterize.js` (guard #2) and `caps.js` (`RASTER_DPI` and `RASTER_MAX_DIM`). `test/rasterize.test.js` argv assertions were rewritten and extended with DPI-effectiveness, mutual-exclusion, clamping and `computeScaleTo` unit cases; a pipeline test asserts the geometry flows from the single pdfinfo call through to pdftoppm.

**Honest caveat, documented at `pdfInfo`:** pdfinfo reports one page geometry (the first page's, or the shared one). For a PDF with differently-sized pages that figure is a reference, not an exact per-page box, so DPI fidelity on heterogeneous PDFs is approximate. The `maxDim` ceiling holds in every case.

### CR-07: `spawnCapture` builds a `/bin/sh -c` string by unquoted interpolation

**Files modified:** `lib/v1/input/spawn-capture.js`, `test/spawn-capture.test.js`, `test/rasterize.test.js`, `test/page-pipeline.test.js`, `test/worker-input.test.js`
**Commit:** `8d7a743`
**Applied fix:** The shell body is now a **constant**. Every variable part rides argv as a positional parameter: `sh -c '<body>' sh <ulimitKB> <cpuSec> <wallSec>s <cmd> <args...>`, with the body doing `ulimit -v "$1"; ulimit -t "$2"; shift 2; exec timeout -s KILL "$@"`. Injection is structurally impossible, and a `TMPDIR` containing a space no longer silently splits the argument.

Three test helpers dispatched on the shell body (`/pdfinfo/.test(body)`) and now read the command from argv index 6 instead. Assertions moved from regexing the body to `deepEqual` on the argv — the more meaningful assertion, as the review noted. Added a regression test feeding `'/tmp/my dir; touch /tmp/pwned; #/input.pdf'` and asserting it survives as one intact operand and never appears in the body.

### WR-01: `pdfinfo` runs with no `ulimit` and no stdout ceiling

**Files modified:** `lib/v1/input/spawn-capture.js`, `lib/v1/input/rasterize.js`, `lib/v1/input/caps.js`, `test/spawn-capture.test.js`, `test/rasterize.test.js`, `test/caps.test.js`
**Commit:** `80c8d50`
**Applied fix:** `pdfPageCount` now passes `ULIMIT_V_KB`, `ULIMIT_CPU_SEC` and a new `PDFINFO_MAX_STDOUT_BYTES` cap (64 KB), so the first subprocess to touch an untrusted PDF is sandboxed like the raster child. `spawnCapture` **fails closed**: a missing or non-positive limit rejects with `spawn_sandbox_limits_required` and no child is created. The shell body also has `|| exit 71` on each `ulimit`, so a kernel-refused limit aborts rather than continuing unsandboxed (the old body had no `set -e`, so `ulimit: Illegal number: undefined` printed to stderr and execution simply carried on to the `exec`).

### WR-02: Job-deadline overrun produces pages that look successful but are empty

**Files modified:** `lib/v1/worker.js`, `lib/v1/input/page-pipeline.js`, `test/worker-input.test.js`, `test/page-pipeline.test.js`
**Commit:** `f69999b`
**Applied fix:** `makeCascadeRoutePage` clamps `remaining` to `>= 0` and throws a typed `job_deadline_exceeded` when the budget is spent, so a negative budget never reaches `runCascade` and no wasted provider call is made. `routeAndRecord` now treats an engine-less result as a page failure, surfacing the cascade's `stopped_reason` (e.g. `budget_exhausted`) as the error code, falling back to `no_engine_result`.

The worker test drives a controllable clock offset from the fake cascade — the first page burns the whole budget, so pages 2 and 3 are genuinely past the deadline. (An earlier attempt stubbing `Date.now()` by call count was abandoned as unreliable: pino's timestamp function also calls `Date.now`, making the count nondeterministic.)

### WR-03: Decoder/pixel-cap failures surface as HTTP 500 `internal_error`

**Files modified:** `lib/v1/input/image-normalize.js`, `test/image-normalize.test.js`
**Commit:** `318c966`
**Applied fix:** Added `typedDecodeError()` and routed **every** decode site through it — `normalizeOne`, the multi-frame `metadata()` read, the `heic-convert` call and the `bmp.decode` call. sharp's `limitInputPixels` breach and `ERR_OUT_OF_RANGE` map to `image_pixel_cap_exceeded` (413); anything else maps to `image_decode_failed` (422). Already-typed errors pass through untouched. The message detail is preserved on a bounded `detail` string field for debugging (never a buffer).

The two existing pixel-limit tests asserted on sharp's raw message text; they now assert the typed code and status. Added a table-driven test over malformed GIF/HEIC/PNG/JPEG inputs asserting none can escape as an untyped 500.

### WR-04: An `unpdf` failure aborts the whole job with no rasterization fallback

**Files modified:** `lib/v1/input/page-pipeline.js`, `test/page-pipeline.test.js`
**Commit:** `951e255`
**Applied fix:** Wrapped `getPageTexts` so any unpdf/PDF.js throw degrades to `texts = []`, which makes `sufficient('')` false for every page and rasterizes them all. pdfinfo has already succeeded at that point, proving poppler can read the file. New test uses a PDF body unpdf cannot parse and asserts both pages come back OCR'd with a clean `completed` rollup.

### WR-05: A zero / bogus `pdfinfo` page count yields a "completed" job with no pages

**Files modified:** `lib/v1/input/rasterize.js`, `test/rasterize.test.js`
**Commit:** `095e2b5`
**Applied fix:** Added lower-bound validation in `pdfInfo` — a non-integer or `< 1` page count throws typed `pdf_no_pages` (422), which `runInputJob` already maps to a client failure. Previously `for (p = 1; p <= 0; p++)` skipped every iteration and the job completed with an empty envelope indistinguishable from a genuinely empty document.

### WR-06: `drainAndCancel` never clears its timeout timer

**Files modified:** `lib/v1/shutdown.js`, `test/shutdown.test.js`
**Commit:** `094857f`
**Applied fix:** The grace-window timer is captured and `clearTimeout`'d after the race resolves.

**Deviation from the suggested fix, deliberate:** the review also suggested `unref()`ing the timer. I applied that first and it broke three pre-existing tests — this timer is the only thing keeping the event loop alive while awaiting `limiter.stop()`, so unref'ing let the process exit before the timeout branch could fail in-flight jobs with `shutdown_timeout`. `clearTimeout` on the winning path is sufficient to release the loop and is what actually fixes the 35 s lingering. The reasoning is recorded in a comment at the call site so it is not "fixed" back later.

### WR-07: Unguarded `await` in `runInputJob`'s `finally` can replace the job outcome

**Files modified:** `lib/v1/worker.js`, `test/worker-input.test.js`
**Commit:** `0042475`
**Applied fix:** Wrapped `cleanupJobTempDir` in try/catch, logging `temp_cleanup_failed` instead of letting an `fs.rm` rejection propagate out of the `finally` and overwrite a completed job with `internal_error`.

The test reaches the **real** failure mode rather than stubbing fs: monkey-patching `node:fs/promises` does not work because `temp.js` destructures `rm` at require time. Instead it `chmod 0o500`s the job's own temp dir mid-flight (via the pdfinfo spawn hook), so the recursive `rm` hits a genuine `EACCES` unlinking `input.pdf` — `force: true` only suppresses `ENOENT`. Confirmed to fail pre-fix with exactly `EACCES: permission denied, unlink '/tmp/ocr-job-*/input.pdf'`.

### WR-08: The SIGKILL-escalation test cannot fail

Fixed together with CR-05 — see that entry. **Commit:** `f2e8cfb`

### WR-09: BMP admitted on a 2-byte signature with no structural validation

**Files modified:** `lib/v1/sniff.js`, `test/sniff.test.js`
**Commit:** `4cf3765`
**Applied fix:** BMP now requires ≥18 bytes, a DIB header size in the known set `{12, 40, 52, 56, 64, 108, 124}`, and a declared file size ≥ 26. A `BM`-prefixed file that fails those returns `null` rather than falling through to later branches. Added a test with plain text starting `"BMW service manual..."`, plus unknown-DIB-size and truncated-header cases, and a test that the real `sample.bmp` fixture still sniffs correctly (the guard must not reject genuine BMPs).

### WR-10: No startup sweep for orphaned `ocr-job-*` temp dirs

**Files modified:** `lib/v1/input/temp.js`, `server.js`, `test/temp.test.js`
**Commit:** `4204fa3`
**Applied fix:** Added `sweepOrphanedTempDirs()` — reads `os.tmpdir()`, removes every `ocr-job-*` directory **not** in the live in-process registry, and returns the count. Wired into `server.js` before the listener, fire-and-forget, so a sweep failure can never block startup. Three tests: orphans (with their leaked `input.pdf`) are removed, a dir this process currently owns survives, and unrelated tmpdir entries are untouched. The single-instance-per-container assumption and the mtime-gating escape hatch are documented at the function.

### WR-11: `docker-smoke.sh` gates HEIC and temp-lifecycle cases on an unrelated binary

**Files modified:** `test/docker-smoke.test.js`
**Commit:** `a2f356d`
**Applied fix:** Replaced the single `requirePoppler` switch with a `requireCap(t, ok, why)` helper plus per-capability guards. The A5 HEIC case is gated on `heic-convert` and the temp-lifecycle case on nothing at all (it is pure fs). On the host this file went from 8 skipped to **2 passing / 6 skipped** — the A5 HEIC decode risk-flag, called out in CLAUDE.md as the reason `heic-convert` was chosen over sharp, now genuinely executes instead of reporting a green skip. Updated the file header, which described the old single-switch design, and noted that `t.skip()` does not halt execution so the caller's `return` is load-bearing.

Also aligned the A1 tiny-`ulimit` case's hand-built argv with `renderPage`'s post-CR-06 output (`-r` alone, never `-r` together with `-scale-to`) so the old misleading pattern is not preserved in the smoke.

## Skipped Issues

None — all 18 in-scope findings were fixed.

## Notes for the verifier

- `scripts/docker-smoke.sh` was **not** run, per instructions — the orchestrator runs the in-container smoke.
- Two changes are worth watching in that smoke because they alter real poppler invocations:
  1. **CR-06** changed the pdftoppm argv. Where page geometry is available (the normal path) it now passes `-scale-to <computed>` and **no** `-r`. Expect rendered pages to be *smaller* than before (A4 at 200 DPI: ~2339 px long edge instead of a forced 5000 px) — that is the intended fix, and it should also reduce peak memory and PNG size.
  2. **WR-01** added `|| exit 71` to the `ulimit` lines. If the container's hard address-space limit were ever below `ULIMIT_V_KB` (768 MB), renders would now fail closed with exit 71 rather than running unsandboxed. The existing smoke already exercised `ulimit -v 786432` successfully, so this is expected to be inert, but exit 71 is the signal to look for if raster cases regress.
- `CAPS` gained three keys — `MAX_IMAGE_FRAMES` (50), `PDFINFO_MAX_STDOUT_BYTES` (65536) — and all are env-overridable through the existing `intFromEnv` boot validation.
- `rasterize.js` exports changed: `pdfInfo` is new and `pdfPageCount` is retained as a thin wrapper over it (`docker-smoke.test.js` still uses the latter).
- `image-normalize.js` now exports `normalizeFrames` (the streaming production entry point) alongside `normalizeToFrames` (array-collecting, documented as a test convenience).

---

_Fixed: 2026-07-24_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
