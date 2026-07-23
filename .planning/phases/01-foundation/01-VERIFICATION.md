---
phase: 01-foundation
verified: 2026-07-23T00:00:00Z
status: passed
score: 5/5 success criteria verified · 17/17 Phase-1 requirements satisfied
overrides_applied: 0
re_verification:
  previous_status: none
  note: initial verification
gaps: []
human_verification:
  - test: "docker compose up on a real VPS with Tailscale + a public DOMAIN"
    expected: "Caddy issues a Let's Encrypt cert (auto HTTPS); GET https://DOMAIN/v1/health → 200; GET https://DOMAIN/api/config → 404; admin panel reachable only on http://TAILSCALE_IP:8780"
    why_human: "Requires a live host, real DNS/ACME, and a tailnet — not verifiable statically or in unit tests"
  - test: "End-to-end OCR round-trip with a real OCR_SPACE_API_KEY / OLLAMA_API_KEY"
    expected: "POST /v1/ocr with a PNG → 202; polling /v1/jobs/:id reaches succeeded with real extracted text in the pages[] envelope"
    why_human: "Provider calls are stubbed in tests; real extraction quality needs a live key + network"
  - test: "SIGTERM during an in-flight job on the running container"
    expected: "In-flight response completes, queued jobs marked shutdown_cancelled, process exits within the 40s grace window"
    why_human: "Real signal + Docker stop_grace_period timing is a runtime behavior; unit tests exercise drainAndCancel logic only"
---

# Phase 1: Foundation Verification Report

**Phase Goal:** A dockerized, bearer-secured `/v1` HTTP API that accepts an image and returns OCR text via an async job model, with a page-aware response envelope from day one, deployed behind Caddy with the admin surface Tailscale-bound.
**Verified:** 2026-07-23
**Status:** passed
**Re-verification:** No — initial verification

**Note on MVP mode:** ROADMAP marks this phase `Mode: mvp`, but the phase goal is a capability statement rather than a strict `As a…, I want to…, so that…` User Story. Per the orchestrator's explicit instruction, verification was performed goal-backward against the 5 Success Criteria and 17 requirement IDs (the binding contract). This is noted, not treated as a blocker.

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Valid bearer → POST /v1/ocr = 202 + job_id + status_url; poll to `succeeded` with text; missing/invalid → 401; refuses boot when API_TOKEN missing/placeholder | ✓ VERIFIED | `lib/v1/router.js:128-137` (202 + status_url + Location); `lib/v1/auth.js:5-26` (401 + WWW-Authenticate, timing-safe, case-insensitive Bearer); `server.js:102-105` boot guard; tests `v1-routes.test.js` (202/401), `worker.test.js:48` (`succeeded`), `env-guards.test.js:143` (boot refusal, real subprocess spawn asserting non-zero exit) |
| 2 | Job result is a page-aware envelope (`pages[]` + concatenated `text`) even for a single image | ✓ VERIFIED | `lib/v1/worker.js:41-50` builds `pages:[{page:1,text,engine,confidence:null}]` with `text = pages.map(p=>p.text).join('\n\n')`; tests `worker.test.js:49-59`, `jobs.test.js:36-44` assert array shape + joined text |
| 3 | Oversized → 413; unsupported/spoofed types via magic-byte sniff → 400/422; full queue → 503 server_busy + Retry-After | ✓ VERIFIED | `lib/v1/router.js:40-48` (413 LIMIT_FILE_SIZE / 422 filter), `router.js:59-65` authoritative `sniffImage(buffer)` (not client content-type), `lib/v1/sniff.js` magic bytes PNG/JPEG/WebP; `router.js:106-124` two 503 paths (queue depth + store full) both set `Retry-After`; tests `v1-routes.test.js` VAL-01 (413), VAL-02 (sniff 422), `jobs.test.js:76` (store full:true) |
| 4 | GET /v1/health unauthenticated; GET /v1/models lists engines; completed/failed jobs swept after TTL | ✓ VERIFIED | `lib/v1/auth.js:6` exempts `/health`; `lib/v1/health.js:44-57` 200 booleans-only; `router.js:171-181` models catalog; `lib/v1/jobs.js:4,12` `JOB_TTL_MS=1h` + `ttlAutopurge:true`; tests `v1-routes.test.js` (health public, models shape), `jobs-extra.test.js:65` (TTL eviction) |
| 5 | Runs on node:22-bookworm-slim via Compose behind Caddy (auto HTTPS, only /v1/* public, admin Tailscale-bound never 0.0.0.0); drains on SIGTERM; structured logs w/ request/job IDs, no secrets | ✓ VERIFIED | `Dockerfile:4,14` node:22-bookworm-slim + tini + poppler-utils, `USER node`; `docker-compose.yml:49-50` `${TAILSCALE_IP:?…}:8780:3000` fail-loud bind; `Caddyfile:38-101` default-deny 404 except `/v1/*`; `server.js:170-215` + `lib/v1/shutdown.js` drain+cancel; `lib/logger.js:6-13` redact paths; tests `deploy.test.js` (28+ config assertions), `pino-http.test.js`, `logger-shape.test.js`, `scripts/verify-redaction.js` |

**Score:** 5/5 success criteria verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `server.js` | App bootstrap, boot guards, graceful shutdown | ✓ VERIFIED | Fail-closed guards for API_TOKEN, TAILSCALE_IP, zero-engine; pino-http wired; SIGTERM/SIGINT handlers |
| `lib/v1/router.js` | /v1 routes (ocr, jobs, health, models) | ✓ VERIFIED | All routes present, sniff+size+queue guards wired |
| `lib/v1/auth.js` | Bearer auth, /health exempt | ✓ VERIFIED | timingSafeEqual, case-insensitive, 401 + WWW-Authenticate |
| `lib/v1/worker.js` | Concurrency-1 worker, page envelope | ✓ VERIFIED | Bottleneck maxConcurrent:1 highWater bounded; envelope build |
| `lib/v1/jobs.js` | LRU job store, TTL sweep | ✓ VERIFIED | TTL 1h, ttlAutopurge, finalized-guard against shutdown race |
| `lib/v1/shutdown.js` | Drain in-flight, cancel queued | ✓ VERIFIED | Promise-deduped drain, hard timeout, terminal marking |
| `lib/v1/sniff.js` | Magic-byte type detection | ✓ VERIFIED | PNG/JPEG/WebP signatures; null on spoof |
| `Dockerfile` | node:22-bookworm-slim + tini + poppler | ✓ VERIFIED | Multi-stage, non-root, exec-form CMD, no HEALTHCHECK (in compose) |
| `docker-compose.yml` | Tailscale bind, drain window, Caddy | ✓ VERIFIED | Fail-loud TAILSCALE_IP, stop_grace_period 40s, least-priv Caddy env |
| `Caddyfile` | Auto HTTPS, /v1/* only, default-deny | ✓ VERIFIED | Default-deny 404 block; bare proxy dirs; no log_credentials |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| router POST /ocr | worker.runJob | `limiter.schedule` fire-and-forget | ✓ WIRED | router.js:140-150 |
| worker | jobs store | `jobs.setProcessing/complete/fail` | ✓ WIRED | worker.js:31-58 |
| worker | provider | `runOCR` → ollama/ocrspace | ✓ WIRED | lib/ocr.js:3-12 |
| server.js | v1 router | `app.use('/v1', bearerAuth, v1Router)` | ✓ WIRED | server.js:133-135 |
| server.js SIGTERM | shutdown.drainAndCancel | signal handler | ✓ WIRED | server.js:184,207-215 |
| Caddy | app:3000 | reverse_proxy /v1/* | ✓ WIRED | Caddyfile:51-91 |

### Requirements Coverage (17 Phase-1 IDs)

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| API-01 | Bearer on every /v1; missing/invalid → 401 | ✓ SATISFIED | auth.js; v1-routes.test.js AUTH-02 |
| API-02 | Refuse start when API_TOKEN missing/placeholder | ✓ SATISFIED | server.js:102-105; env-guards.test.js:143 (subprocess exit≠0) |
| API-03 | POST /v1/ocr → 202 + job_id + status_url | ✓ SATISFIED | router.js:128-137; v1-routes.test.js |
| API-04 | Poll /v1/jobs/:id → status envelope + typed error | ✓ SATISFIED | router.js:155-165; jobs.js states; errors.js mapErrorCode |
| API-05 | GET /v1/models lists engines/profiles | ✓ SATISFIED | router.js:171-181; models-shape.test.js |
| API-06 | Unauthenticated GET /v1/health | ✓ SATISFIED | auth.js:6 exempt; health.js; v1-routes.test.js |
| API-07 | 413/400/422 on oversized/unsupported | ✓ SATISFIED | router.js:40-65; upload.js limits; v1-routes VAL-01/VAL-02 |
| API-08 | Full queue → 503 server_busy + Retry-After | ✓ SATISFIED | router.js:106-124 (impl + Retry-After); building blocks unit-tested (concurrency.test.js, jobs.test.js:76). Minor: no route-level 503 integration test — implementation and inputs are covered |
| JOB-01 | Page-aware envelope from day one | ✓ SATISFIED | worker.js:41-50; worker.test.js:49-59, jobs.test.js:36-44 |
| JOB-03 | Completed/failed swept after configurable TTL | ✓ SATISFIED | jobs.js:4,12; jobs-extra.test.js TTL eviction |
| INP-01 | Accepts PNG/JPEG/WebP, routes through engine | ✓ SATISFIED | upload.js allowed list; sniff.js; ocr.js routing |
| INP-02 | Authoritative magic-byte sniff, reject spoofed | ✓ SATISFIED | router.js:59-65 sniffs buffer not content-type; sniff.test.js, VAL-02 |
| OPS-01 | Compose on node:22-bookworm-slim + poppler-utils | ✓ SATISFIED | Dockerfile:4,14,22-24; deploy.test.js DEPLOY-01 |
| OPS-02 | Caddy auto HTTPS, only /v1/* public | ✓ SATISFIED | Caddyfile:38-101 default-deny; deploy.test.js |
| OPS-03 | Admin binds Tailscale only, never 0.0.0.0 | ✓ SATISFIED | compose:49-50 fail-loud; server.js:114-117 guard; deploy.test.js DEPLOY-03 |
| OPS-04 | Drain in-flight on SIGTERM within window | ✓ SATISFIED | server.js:173-215; shutdown.js; shutdown.test.js |
| OPS-05 | Structured logs w/ request/job IDs, no secrets | ✓ SATISFIED | logger.js redact; server.js pino-http genReqId; worker child logger; verify-redaction.js |

All 17 requirements SATISFIED. No orphaned requirements (JOB-02/JOB-04/CASC-*/INP-03..08/STR-*/OPS-06 are correctly mapped to Phases 2–4, not Phase 1).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full test suite | `node --test test/*.test.js` (env: API_TOKEN, TAILSCALE_IP, keys set) | tests 184 · pass 184 · fail 0 | ✓ PASS |
| Redaction script | `node --test scripts/verify-redaction.js` | pass 5/5 | ✓ PASS |
| Boot fail-closed | subprocess spawn with placeholder API_TOKEN (env-guards.test.js) | exit≠0 + expected message | ✓ PASS |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TBD/FIXME/XXX debt markers in server.js, lib/, scripts/ | ℹ️ Info | Clean; extensive rationale comments only |

### Human Verification Recommended (informational — not gaps)

Live-stack behaviors that cannot be proven statically. These are inherent to deploy/external-service integration and do not block phase acceptance since all code/config/test-level criteria pass:

1. **Real Docker + Caddy + Tailscale + ACME on a VPS** — auto HTTPS cert issuance, public /v1/* reachable, /api/* returns 404, admin only on tailnet bind.
2. **End-to-end OCR round-trip with real provider keys** — 202 → poll → `succeeded` with real extracted text.
3. **SIGTERM drain timing on the running container** — in-flight completes, exits within 40s grace.

### Gaps Summary

No gaps. All 5 success criteria and all 17 Phase-1 requirements are implemented in shipped code, wired end-to-end, and backed by 184 passing tests plus a dedicated redaction verifier. Deploy configuration (Dockerfile/compose/Caddyfile) is asserted by a comprehensive deploy.test.js suite. Fail-closed boot guards are proven by real subprocess spawn tests. The only item worth noting is that the route-level 503 `server_busy` path lacks a dedicated HTTP integration test, though its implementation and constituent inputs (limiter queue depth, job-store capacity) are unit-tested — this is a minor coverage observation, not a goal gap.

---

_Verified: 2026-07-23_
_Verifier: Claude (gsd-verifier)_
