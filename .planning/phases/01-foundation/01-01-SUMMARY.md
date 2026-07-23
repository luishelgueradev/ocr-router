---
phase: 01-foundation
plan: 01
subsystem: api
tags: [express, multer, bottleneck, lru-cache, pino, ocr, async-jobs, bearer-auth]

# Dependency graph
requires:
  - phase: (none — first execution plan)
    provides: PROJECT/CONTEXT/RESEARCH decisions D-01..D-11 + reference impl at /home/luis/proyectos/test-ocr-qwen3-vl
provides:
  - "Running bearer-secured /v1 async OCR API (POST /v1/ocr → poll GET /v1/jobs/:id → terminal succeeded)"
  - "Page-aware result envelope (result.text + result.pages[{page,text,engine,confidence}]) from day one"
  - "Single-concurrency bottleneck worker + bounded queue (503 server_busy backpressure)"
  - "LRU job store with TTL autopurge; finalized terminal-state guard (WR-04)"
  - "Default-engine resolver (D-08) + zero-engine fail-closed boot guard"
  - "Ported lib/** module set (auth, sniff, upload, jobs, worker, shutdown, health, errors, env, modes, models, providers, logger)"
  - "Two node --test suites proving the vertical slice (v1-routes.test.js, jobs.test.js)"
affects: [02-cascade-router, 03-input-pipeline, 04-structured-extraction]

# Tech tracking
tech-stack:
  added: [express@4.22, multer@2.2, bottleneck@2.19, lru-cache@11, pino@10, pino-http@11, axios@1.16, uuid@13, dotenv@17]
  patterns:
    - "Async submit→poll (202 + job_id → GET /v1/jobs/:id)"
    - "Fire-and-forget worker on single-concurrency limiter with terminal-state finalization guard"
    - "Reject-before-enqueue queue-depth guard (memory-exhaustion protection)"
    - "Magic-byte type sniff, never client Content-Type"
    - "Page-aware envelope written join-ready so multi-page is additive"
    - "Fail-closed boot guards (API_TOKEN, TAILSCALE_IP, zero-engine)"

key-files:
  created:
    - package.json
    - package-lock.json
    - .gitignore
    - .dockerignore
    - .env.example
    - lib/logger.js
    - lib/models.js
    - lib/ocr.js
    - lib/providers/ocrspace.js
    - lib/providers/ollama.js
    - lib/v1/auth.js
    - lib/v1/env.js
    - lib/v1/errors.js
    - lib/v1/health.js
    - lib/v1/modes.js
    - lib/v1/sniff.js
    - lib/v1/upload.js
    - lib/v1/jobs.js
    - lib/v1/worker.js
    - lib/v1/shutdown.js
    - lib/v1/router.js
    - server.js
    - public/index.html
    - test/v1-routes.test.js
    - test/jobs.test.js
  modified: []

key-decisions:
  - "D-03: terminal status `succeeded` (renamed from reference `completed`); function name complete() and finalized guard kept"
  - "D-04/D-05: page-aware envelope even for a single image; top-level text = pages.map(p=>p.text).join('\\n\\n')"
  - "D-06: multipart field renamed image→file (upload.js + router.js)"
  - "D-08: model optional; resolveDefaultEngine() prefers ocrspace when OCR_SPACE_API_KEY set; zero-engine boot guard"
  - "package-lock.json vendored from reference (deviation) so npm install/Docker npm ci are reproducible"

patterns-established:
  - "Wholesale port with surgical edits (D-01): copy battle-tested modules AS-IS, change only the three adaptation points"
  - "Grep-enumerated rename checklist prevents mixed vocabulary (Pitfall 4)"

requirements-completed: [API-01, API-02, API-03, API-04, API-05, API-06, API-07, API-08, JOB-01, JOB-03, INP-01, INP-02, OPS-03, OPS-04, OPS-05]

# Metrics
duration: 20min
completed: 2026-07-23
---

# Phase 1 Plan 01: Foundation (Walking Skeleton) Summary

**Ported the mature `test-ocr-qwen3-vl` reference into this repo as a working, bearer-secured `/v1` async OCR API — POST an image, poll the job, get a terminal `succeeded` status carrying a page-aware envelope — proven GREEN by the ported `node --test` slice (19/19).**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-23T19:44Z
- **Completed:** 2026-07-23T19:52Z
- **Tasks:** 3 completed
- **Files modified/created:** 25

## Accomplishments
- Full `lib/**` + `server.js` app runtime ported and running; the vertical OCR slice works end-to-end (POST /v1/ocr → single-concurrency worker → GET /v1/jobs/:id).
- The three mechanical adaptations applied exactly: D-03 (`completed`→`succeeded`), D-04/D-05 (page-aware envelope), D-06 (`image`→`file`).
- New default-engine resolver (D-08) + zero-engine fail-closed boot guard implemented; a minimal POST with just a file (no `model`) returns 202 and resolves to the default engine.
- WR-04/WR-05/WR-07/WR-08 reference fixes preserved through the renames.
- Repo scaffold committed: `package.json` (multer ^2.2.0, engines node>=22, no chalk, `node --test` runner), `.gitignore`/`.dockerignore`/`.env.example` (placeholders byte-for-byte).
- Local boot smoke verified: `GET /v1/health` → 200 `{status:ok}`; authed `POST /v1/ocr` (no model) → 202 + `Location` + `Retry-After`, default engine `ocrspace-engine2`; poll returns the live job record.

## Task Commits

Each task was committed atomically (walking-skeleton RED → GREEN → test-adapt):

1. **Task 1: Scaffold repo + failing end-to-end slice test (RED)** — `054cefa` (test)
2. **Task 2: Port app runtime + 3 adaptations + default-engine resolver (GREEN)** — `b1e1a4d` (feat)
3. **Task 3: Adapt job-store unit test + local end-to-end run** — `f059920` (test)

_TDD gate sequence: Task 1 `test(...)` (RED) → Task 2 `feat(...)` (GREEN) → Task 3 `test(...)` (envelope/status assertions). RED and GREEN gate commits both present._

## Files Created/Modified

**Scaffold**
- `package.json` — deps (multer ^2.2.0), engines node>=22, `node --test` script (full 19-file list retained; later plans add the rest), no chalk/batch.
- `package-lock.json` — vendored from reference for reproducible install (deviation).
- `.gitignore`, `.dockerignore` — copied AS-IS.
- `.env.example` — copied with placeholders `API_TOKEN=generate-with-openssl-rand-hex-32` and `TAILSCALE_IP=100.x.x.x` byte-for-byte (server.js drift guard couples to them).

**App runtime (AS-IS ports)**
- `lib/logger.js`, `lib/models.js`, `lib/ocr.js`, `lib/providers/ocrspace.js`, `lib/providers/ollama.js`, `lib/v1/auth.js`, `lib/v1/env.js`, `lib/v1/errors.js`, `lib/v1/health.js`, `lib/v1/modes.js`, `lib/v1/sniff.js`, `lib/v1/shutdown.js`, `public/index.html`.

**App runtime (edited)**
- `lib/v1/upload.js` — D-06: multer unexpected-file field `image`→`file`.
- `lib/v1/jobs.js` — D-03: terminal status literal `completed`→`succeeded`; clarifying comments updated. Finalized guard (WR-04) intact.
- `lib/v1/worker.js` — D-04/D-05: page-aware envelope assembly (`pages:[{page:1,text,engine,confidence:null}]`, top-level `text` join-ready); job-level trace stub retained; `job complete` log shape unchanged.
- `lib/v1/router.js` — D-06: `upload.single('file')`, `field:'file'`, message text; D-08: `resolveDefaultEngine()` + optional `model` (explicit unknown model still 422).
- `server.js` — D-08: zero-engine fail-closed boot guard after API_TOKEN/TAILSCALE_IP guards; legacy `/api/config` + `/api/ocr` admin surface ported AS-IS (no bearer auth, tailnet-trust per D-09).

**Tests**
- `test/v1-routes.test.js` — ported end-to-end slice; `buildMultipart` default field `file`, VAL-02 asserts `field:'file'`, allowed-status array includes `succeeded`.
- `test/jobs.test.js` — terminal-state test asserts `succeeded` + envelope (`result.pages[0].page/engine/confidence`); D-05 trace fields retained.

## Deviations from Plan

### Auto-added (Rule 2/3 — critical for the app to run)

**1. [Rule 3 - Blocking] Vendored `package-lock.json` + ran `npm install`**
- **Found during:** Task 1 (needed before any test could load `express`/`multer`).
- **Issue:** Fresh repo had no `node_modules` and no lockfile; the plan's `files_modified` did not list `package-lock.json`, but the app and every test require the dependencies installed.
- **Fix:** Copied the reference `package-lock.json` (all deps pre-vetted in RESEARCH Package Legitimacy Audit — no new/ambiguous packages) and ran `npm install`, which reconciled the `multer ^2.1.1→^2.2.0` bump. 108 packages installed.
- **Files modified:** `package-lock.json` (added), `node_modules/` (gitignored).
- **Commit:** `054cefa`
- **Not a package-legitimacy risk:** these are the exact deps the plan authored, inherited from the reference's committed lockfile — no similarly-named substitution, so the Rule-3 package-install exclusion (slopsquatting guard) does not apply.

No other deviations — the three adaptations, default-engine resolver, and boot guard were implemented exactly as specified. No architectural (Rule 4) changes; no auth gates encountered.

## Verification Results
- `node --test test/v1-routes.test.js test/jobs.test.js` → **19/19 pass, 0 fail**.
- `grep -rn "'completed'" lib/` → none.
- `grep -rn "'image'" lib/` (excluding `image/*` mimetypes + comments) → none.
- Local boot smoke: `GET /v1/health` → 200 `{status:ok}`; authed `POST /v1/ocr` (no model) → 202 + `Location: /v1/jobs/<uuidv7>` + `Retry-After: 10`, job resolves to default engine `ocrspace-engine2`; poll returns live job record.

## Known Stubs
None that block the plan goal. Phase-scoped intentional placeholders (documented, resolved in later phases):
- Per-page `confidence: null` — populated by Phase 2 cascade (ocr.space overlay/confidence deferred, per D-04/RESEARCH).
- `pages[]` is single-element in Phase 1 — multi-page population is Phase 3 (input pipeline). The join is written additive so this is not a breaking change.
- Dockerfile/docker-compose/Caddyfile migration (D-10/OPS-01) and remaining ported test files are Plans 01-02/01-03; the `package.json` `test` script references them by design.

## Notes for Next Plans
- The `test` script lists all 19 test files + `verify-redaction.js`; only `v1-routes.test.js` and `jobs.test.js` exist so far. Plans 01-02/01-03 port the remainder (including the `deploy.test.js` rewrite coupled to the new Debian Dockerfile) so `npm test` runs whole.
- Envelope fields `engine`/`confidence` and job-level trace stub are in place for the Phase 2 cascade to populate additively.

## Self-Check: PASSED

All 26 created files verified present on disk; all 3 task commits (054cefa, b1e1a4d, f059920) verified in git history.
