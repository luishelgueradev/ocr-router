---
phase: 01-foundation
plan: 02
subsystem: api
tags: [node-test, ported-suite, auth, env-guards, redaction, shutdown, worker, envelope, D-03, D-04]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Running /v1 app runtime (lib/**, server.js) with succeeded status (D-03), page-aware envelope (D-04), file field (D-06), default-engine resolver + zero-engine boot guard (D-08)"
provides:
  - "Full ported node --test acceptance suite (16 files + verify-redaction) green against the Plan 01 app"
  - "shutdown.test.js drain semantics proven with the succeeded terminal vocabulary (D-03)"
  - "worker.test.js proves the page-aware envelope (result.pages[0]) produced by runJob (D-04)"
  - "env-guards.test.js proves API_TOKEN + TAILSCALE_IP placeholder-drift fail-closed guards"
  - "verify-redaction.js proves secrets never reach structured logs (OPS-05)"
affects: [01-03-deploy, 02-cascade-router]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reference test suite ported wholesale; only status/envelope-coupled files adapted (D-03/D-04)"
    - "require.cache monkey-patch of runOCR to drive worker success path deterministically"
    - "Boot-guard-aware spawn tests: supply OCR key so D-08 zero-engine guard is satisfied"

key-files:
  created:
    - test/auth.test.js
    - test/concurrency.test.js
    - test/env-guards.test.js
    - test/errors.test.js
    - test/health.test.js
    - test/logger-shape.test.js
    - test/models-shape.test.js
    - test/modes.test.js
    - test/pino-http.test.js
    - test/sniff.test.js
    - test/upload.test.js
    - test/shutdown.test.js
    - test/worker.test.js
    - test/jobs-extra.test.js
    - test/worker-logging.test.js
    - test/worker-failure-logging.test.js
    - scripts/verify-redaction.js
  modified: []

key-decisions:
  - "env-guards boots-cleanly spawn test supplies OCR_SPACE_API_KEY so the D-08 zero-engine boot guard (added in 01-01) is satisfied — the reference predates that guard"
  - "worker.test.js gained a D-04 success-path test (reference exercised only the early-return path) to satisfy the plan's page-aware-envelope must_have and prove runJob's jobs.complete envelope shape"
  - "worker-logging / worker-failure-logging ported AS-IS — the 'job complete'/'job failed'/'job crashed' log shapes were left unchanged in 01-01"

patterns-established:
  - "AS-IS port + surgical D-03/D-04 edits; grep-enumerated 'completed' checklist keeps vocabulary consistent (Pitfall 4)"

requirements-completed: [API-01, API-02, API-07, API-08, JOB-01, JOB-03, INP-01, INP-02, OPS-04, OPS-05]

# Metrics
duration: 12min
completed: 2026-07-23
---

# Phase 1 Plan 02: Ported Acceptance Test Suite Summary

**Ported the remaining 16 reference `node --test` files + `scripts/verify-redaction.js` into this repo and applied the D-03/D-04 adaptations, so the full Phase 1 acceptance suite (minus the 01-03-owned `deploy.test.js`) runs green against the Plan 01 app — 152/152 tests + 5/5 redaction checks.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 2 completed
- **Files created:** 17 (16 test files + verify-redaction.js)

## Accomplishments

- **Task 1 — AS-IS ports (12 files):** `auth`, `concurrency`, `env-guards`, `errors`, `health`, `logger-shape`, `models-shape`, `modes`, `pino-http`, `sniff`, `upload` test files + `scripts/verify-redaction.js`. All green against the ported `lib/**` with matching exports (`healthHandler`, `mapErrorCode`, `MAX_UPLOAD_BYTES`, `limiter`, redact paths).
- **Task 2 — status/envelope-coupled ports (5 files):** `shutdown`, `worker`, `jobs-extra`, `worker-logging`, `worker-failure-logging`. D-03 (`completed`→`succeeded`) applied to the terminal-status literals in `shutdown.test.js` and `jobs-extra.test.js`; D-04 page-aware envelope proven by a new success-path test in `worker.test.js`.
- Full ported suite green: **152/152 tests + 5/5 redaction** (all 19 test files now exist except `deploy.test.js`, which 01-03 owns).
- Proven guarantees: bearer auth (AUTH-02/03/04) + fail-closed API_TOKEN boot (AUTH-01), placeholder-drift guards (DEPLOY-05), upload limits + memoryStorage (VAL-01/02/05), magic-byte sniff anti-spoof (VAL-02), single-concurrency + serialization (ASYNC-03), typed error mapping (mapErrorCode), health liveness + no-secret-leak (API-01/02), structured logging shapes (OBSV-01/02/03/05), log redaction (OBSV-04/OPS-05), SIGTERM drain semantics (OPS-04).

## Task Commits

1. **Task 1: Port AS-IS reference suite + verify-redaction** — `c525747` (test)
2. **Task 2: Adapt status/envelope-coupled tests (D-03/D-04)** — `5fb4e5c` (test)

## Deviations from Plan

### Auto-fixed (Rule 3 — blocking, D-08 boot-guard adaptation)

**1. [Rule 3 - Blocking] env-guards "boots cleanly" test supplied an OCR key**
- **Found during:** Task 1 (env-guards.test.js DEPLOY-05 boot+SIGTERM test failed).
- **Issue:** The reference `env-guards.test.js` "boots and shuts down cleanly" test spawns `server.js` with only `API_TOKEN` + `NODE_ENV=development` and no OCR key. Plan 01-01 added the D-08 zero-engine fail-closed boot guard (`server.js:129`), so the server now throws "No OCR engine configured" before reaching "server ready" — the reference predates that guard.
- **Fix:** Added `OCR_SPACE_API_KEY: 'test-key-for-boot-guard'` to that single spawn env so the D-08 guard is satisfied and the SIGTERM round-trip (`shutdown_complete`) is exercised as intended. No production code changed.
- **Files modified:** `test/env-guards.test.js`
- **Commit:** `c525747`

### Additive (plan behavior + must_have — worker envelope proof)

**2. [Plan behavior] worker.test.js gained a D-04 success-path test**
- **Reason:** The reference `worker.test.js` exercises only the early-return/finalized path; it contains no success-path envelope assertion. The plan's `<behavior>` block and the `contains: "pages"` must_have require `worker.test.js` to assert `jobs.complete` produced `result.pages[0]`.
- **Fix:** Added a success-path test that monkey-patches `runOCR` (via `require.cache`, before requiring the worker) to return a deterministic result, drives `runJob`, and asserts the page-aware envelope: `result.pages[0]` (`page:1`, `engine`, `confidence:null`), joined `result.text`, and terminal status `succeeded`. The two original early-return tests are preserved unchanged.
- **Files modified:** `test/worker.test.js`
- **Commit:** `5fb4e5c`

No other deviations. `worker-logging.test.js` and `worker-failure-logging.test.js` ported AS-IS (log shapes unchanged in 01-01). No architectural (Rule 4) changes; no auth gates.

## Verification Results

- **Explicit 18-file suite + verify-redaction:** `152/152` tests pass, `0` fail; `5/5` redaction checks pass.
- Grep gates: `test/upload.test.js` non-comment `'image'` = 0; `test/shutdown.test.js` `succeeded` ≥ 1 (5) and non-comment `'completed'` = 0; `test/jobs-extra.test.js` non-comment `'completed'` = 0; `test/worker.test.js` `pages` ≥ 1 (11).
- `env-guards.test.js` asserts boot rejection when `API_TOKEN` or `TAILSCALE_IP` equals its placeholder (23 placeholder-related references), and clean boot+SIGTERM.

## Known Stubs

None. This plan adds only test files and a verification script; no production code, no data-flow stubs.

## Notes for Next Plans

- **`npm test` is not yet whole:** the `package.json` `test` script lists `test/deploy.test.js`, which does not exist until 01-03 creates it (Debian Dockerfile-coupled rewrite). Running `npm test` now exits non-zero on the missing file — this is by design. After 01-03 lands `deploy.test.js`, the full `npm test` script passes end-to-end (phase-level gate).
- All 18 non-deploy test files + `verify-redaction.js` are green; 01-03 only needs to add the deploy assertions.

## Self-Check: PASSED
