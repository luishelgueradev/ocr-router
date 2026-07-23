---
phase: 03-input-pipeline
plan: 07
subsystem: testing
tags: [docker, poppler, pdftoppm, heic, sharp, ulimit, subprocess-sandbox, integration-smoke]

# Dependency graph
requires:
  - phase: 03-input-pipeline (03-01..03-06)
    provides: spawnCapture seam, rasterize (pdfinfo/pdftoppm), image-normalize (heic-convert/sharp), temp-dir registry, CAPS
provides:
  - Executed + recorded Docker integration smoke validating the two Phase-3 STATE risk-flags (subprocess-sandbox mechanics A1, HEIC-in-Docker A5)
  - Skip-guarded test/docker-smoke.test.js (green-by-skip on host, executes in the image), kept OUT of the host npm test gate (D-11)
  - scripts/docker-smoke.sh runner (mounts only test/ into /app/test so image lib/ + node_modules are exercised)
  - Real fixtures: test/fixtures/sample.heic (real HEVC-in-HEIF), test/fixtures/scanned-sample.pdf (image-only, no text layer)
  - A real Docker-only bug fix in rasterize.js (pdftoppm stdout streaming) that host unit tests structurally could not catch
affects: [phase-3-verification, any future PDF/image ingestion work, VPS deploy tuning]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Docker-only real-dependency smoke gated on a single binary-presence signal (pdftoppm) → clean host↔image binary"
    - "Runner bind-mounts only test/ into the image's /app/test so lib/ + node_modules resolve to the IMAGE build, never the host"

key-files:
  created:
    - test/docker-smoke.test.js
    - scripts/docker-smoke.sh
    - test/fixtures/sample.heic
    - test/fixtures/scanned-sample.pdf
  modified:
    - README.md
    - lib/v1/input/rasterize.js
    - test/rasterize.test.js

key-decisions:
  - "pdftoppm streams to stdout by OMITTING the output-root, not via a trailing '-' (poppler 22.12.0 writes a file '-.png' for a trailing '-')"
  - "Gate the whole smoke on pdftoppm presence (incl. HEIC/subprocess/temp cases) for a clean host-skip / image-run binary, matching D-11"
  - "Real HEIC fixture also enables the existing image-normalize.test.js HEIC assertion on host — A5 now covered on host AND in Docker"

patterns-established:
  - "Docker validation checkpoint: build image → run skip-guarded smoke inside → record confirmed values (ulimit, HEIC) in the SUMMARY"

requirements-completed: [INP-04, INP-05, INP-08]

# Metrics
duration: ~45min
completed: 2026-07-23
---

# Phase 3 Plan 07: Docker Integration Smoke Summary

**A skip-guarded Docker integration smoke that RAN GREEN inside the built image — validating real poppler rasterization, real HEIC decode, the ulimit/timeout/kill subprocess sandbox, and mid-job temp cleanup — and in doing so caught a real Docker-only stdout bug in `rasterize.js` that the subprocess-stubbed host unit tests could never surface.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-07-23T23:00Z
- **Completed:** 2026-07-23
- **Tasks:** 2 (1 auto + 1 checkpoint executed as a real Docker run)
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- **Executed + recorded the Docker validation checkpoint for real** (Docker was available). The smoke runs GREEN inside `ocr-router:latest`: **8/8 real-dependency cases execute and pass**; on the host all 8 SKIP (poppler absent), so it is green-by-skip and never gates `npm test`.
- **Closed the two STATE Phase-3 risk-flags with recorded values:**
  - **A1 (ulimit -v sizing) — CONFIRMED.** The shipped `ULIMIT_V_KB = 786432` (768 MB) renders a legitimate scanned page fully (70,539-byte PNG) while a 2 MB `-v` cleanly rejects. Measured floor for this page is between 64 MB (degenerate 90-byte output) and 128 MB (full render); 768 MB gives comfortable headroom above the `-scale-to 5000` pixel-bounded worst case. **No CAPS change needed.**
  - **A5 (HEIC-in-Docker) — CONFIRMED.** A real 1440×960 HEVC-in-HEIF (`mif1` brand) decodes through `heic-convert` (WASM) → `sharp` to a valid normalized PNG inside the runtime image (and also on host — the fixture now exercises the existing image-normalize HEIC assertion).
- **A6 CONFIRMED:** dash `ulimit` + coreutils `timeout` exist in `node:22-bookworm-slim` and compose into the sandbox body.
- **Pitfall-4 CONFIRMED:** an `AbortSignal`-bound runaway child is killed within the grace window (~150 ms, not 30 s); `timeout -s KILL 1s` is the wall-clock backstop (~1 s).
- **Pitfall-2 CONFIRMED:** a simulated mid-job SIGTERM (shutdown drain) leaves no temp dir on disk.

## The Docker smoke did its job — caught a real bug

The whole point of D-11 is that poppler is Docker-only, so subprocess mechanics can only be proven against the deployed image. The first in-image run **failed 3/8** and surfaced a genuine bug:

- `rasterize.js` built its `pdftoppm` argv ending in a trailing `-`, believing that streams to stdout. **poppler 22.12.0's `pdftoppm` does NOT** — it writes a file literally named `-.png` to the current directory. As the non-writable `node` user in `/app` that fails outright (`Could not write image to -.png; exiting`); where cwd is writable it silently writes a temp file, **breaking the INP-07 "nothing lands on disk / one page in memory" memory model**.
- **Fix (Rule 1):** omit the output-root entirely — the verified stdout path (`pdftoppm … -singlefile … <pdf>` streams a 70,539-byte PNG, creates no stray file, works in a read-only cwd). Host unit test `rasterize.test.js` updated to assert the argv ends with `<pdfPath>` and no root. `pdftocairo -` was noted as an alternative but the minimal in-`pdftoppm` fix is correct and sufficient.

Host `npm test` stubs the subprocess seam (D-11) and structurally **cannot** exercise a real `pdftoppm`, so it never caught this — exactly the gap this Docker checkpoint exists to close.

## Task Commits

1. **Task 1: Skip-guarded real-dependency smoke + runner + fixtures** — `8621013` (test)
2. **Checkpoint (executed as a real Docker run): rasterize stdout bug fix** — `5f7ca83` (fix)

**Plan metadata:** _(final docs commit)_

## Exact Docker smoke command + result

```bash
# built with the DOCKER_CONFIG workaround (host credsStore is broken):
export DOCKER_CONFIG=/tmp/.../dockercfg   # contains {}
docker build -t ocr-router:latest .
bash scripts/docker-smoke.sh              # docker run --rm --network none \
                                          #   -v <repo>/test:/app/test:ro -w /app \
                                          #   ocr-router:latest node --test test/docker-smoke.test.js
```

Result (after the fix, image rebuilt):

```
ok 1 - smoke/A6: dash ulimit + coreutils timeout wrap a child in the base image
ok 2 - smoke/INP-04: scanned PDF rasterizes page-by-page through real pdfinfo + pdftoppm
ok 3 - smoke/INP-04: a multi-page native PDF renders each page independently
ok 4 - smoke/A1: real ulimit -v ALLOWS a legit page but a tiny -v REJECTS the same render
ok 5 - smoke/A5: a real HEIC decodes through heic-convert → sharp to a normalized PNG
ok 6 - smoke/Pitfall-4: a runaway child bound to an AbortSignal is killed within the grace window
ok 7 - smoke/Pitfall-4: coreutils timeout is the hard wall-clock backstop
ok 8 - smoke/Pitfall-2: a mid-job SIGTERM (shutdown drain) leaves no temp dir on disk
# tests 8   # pass 8   # fail 0   # skipped 0
```

Host: `node --test test/docker-smoke.test.js` → exit 0, **8 skipped** (poppler absent). Full `npm test` → exit 0 (green; the new HEIC fixture additionally makes the pre-existing image-normalize HEIC case execute for real on host).

## Files Created/Modified

- `test/docker-smoke.test.js` — skip-guarded (pdftoppm-presence) integration smoke: A6 wrapper, INP-04 scanned + multi-page rasterization, A1 ulimit allow/reject, A5 HEIC decode, Pitfall-4 abort+timeout kill, Pitfall-2 temp drain.
- `scripts/docker-smoke.sh` — builds/uses `ocr-router:latest`, runs the smoke inside it mounting only `test/` into `/app/test` (image lib/ + node_modules exercised; production copy set untouched). Includes the DOCKER_CONFIG credsStore workaround.
- `test/fixtures/sample.heic` — real 41 KB HEVC-in-HEIF (`mif1`), decodes via heic-convert.
- `test/fixtures/scanned-sample.pdf` — 9 KB image-only PDF (JPEG XObject, DCTDecode, no text layer) = a genuine scanned page; validated with unpdf (1 page, 0 embedded chars).
- `README.md` — documents the Docker/human smoke command + the risk-flag table it validates.
- `lib/v1/input/rasterize.js` — **fix:** drop the trailing `-`; `pdftoppm` streams to stdout via omitted output-root.
- `test/rasterize.test.js` — argv assertion updated to `<pdfPath>` (no output-root).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] pdftoppm did not stream to stdout on the real image**
- **Found during:** Checkpoint (first in-image smoke run — 3/8 failed)
- **Issue:** `renderPage` argv ended in a trailing `-`; poppler 22.12.0 writes a file `-.png` instead of streaming to stdout, failing as the non-writable `node` user in `/app` and (where writable) violating the "nothing on disk" memory model.
- **Fix:** Omit the output-root; verified `pdftoppm … -singlefile … <pdf>` streams the PNG to stdout with no stray file, in a read-only cwd.
- **Files modified:** `lib/v1/input/rasterize.js`, `test/rasterize.test.js`, `test/docker-smoke.test.js` (A1 args)
- **Commit:** `5f7ca83`

### Checkpoint handling

The plan's Task 2 is a `checkpoint:human-verify`. Per the orchestrator's explicit direction (Docker available in this environment — RUN the smoke for real and record results), the checkpoint was executed programmatically rather than deferred to a human: the image was built and the smoke run for real, and the confirmed ulimit value (768 MB) + HEIC decode result are recorded above (A1/A5 closed).

## Observations (non-blocking)

- Under a too-tight `ulimit -v` (≈32–64 MB for this page) `pdftoppm` can exit 0 with a truncated 90-byte PNG rather than a clean failure. This is not a concern at the shipped 768 MB (full render), and the layered defense (`pdfinfo` page cap → `-scale-to 5000` → `ulimit -v` → `sharp.limitInputPixels` → `maxStdoutBytes`) bounds the real pixel work well before `-v` matters. Recorded for future per-VPS tuning; no change made.

## Known Stubs

None — all real-dependency paths were exercised unstubbed inside the image.

## Self-Check: PASSED

- Created files verified on disk: `test/docker-smoke.test.js`, `scripts/docker-smoke.sh`, `test/fixtures/sample.heic`, `test/fixtures/scanned-sample.pdf`, `03-07-SUMMARY.md`.
- Commits verified in git log: `8621013` (test), `5f7ca83` (fix).
