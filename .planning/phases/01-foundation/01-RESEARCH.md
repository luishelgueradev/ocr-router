# Phase 1: Foundation - Research

**Researched:** 2026-07-23
**Domain:** Node.js/Express async HTTP API port; Docker/Caddy/Tailscale deploy
**Confidence:** HIGH (this is a port of a working, tested reference — every claim below is grounded in read source, not inference)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Port the reference's `/v1` modules as-is with minimal edits (`lib/v1/*`, `lib/logger.js`, providers, `lib/models.js`). Restructure only what the two adaptations require. Preserve the `node --test` suite and its WR-04/WR-07/WR-08 fixes.
- **D-02:** New repo (already initialized here), not a fork. Copy source files in; do not symlink.
- **D-03:** Terminal status **`succeeded`** (not reference's `completed`). Full set: `queued`/`processing`/`succeeded`/`failed`. Rename across `jobs.js`, `worker.js`, `shutdown.js`, and all tests. Keep the `finalized`-flag terminal-state guard (WR-04) under the new name.
- **D-04:** Page-aware result envelope even for a single image: `result: { text, pages:[{page,text,engine,confidence}] }`. Single image ⇒ one-element `pages[]`. Top-level `text` = pages joined by `\n\n`. `engine`/`confidence` exist now (`confidence` may be `null` in Phase 1).
- **D-05:** Job-level trace stub: record `engine` used + `created_at`/`started_at`/`completed_at`. Richer cascade trace is JOB-02 (Phase 2).
- **D-06:** Multipart file field named **`file`** (renamed from `image`). Exactly one file per request. PNG/JPEG/WebP only.
- **D-07:** Authoritative type detection by magic-byte sniff (`sniff.js`), never client `Content-Type`. Spoofed/SVG-with-script ⇒ `422 invalid_parameter`. Oversized ⇒ `413 payload_too_large`; unsupported/unsniffable ⇒ `422`. Enforce multer `limits.fileSize` + `limits.files=1`.
- **D-08:** No cascade. `model`/`mode` optional; omitted `model` resolves to a default engine (prefer `ocr.space` when `OCR_SPACE_API_KEY` present, else first configured). Explicit `model` still honored + mode-validated. `GET /v1/models` lists engines + `modes_supported`/`default_mode`. Fail closed at boot only if **zero** engines configured.
- **D-09:** Port the browser demo/admin surface (`public/index.html` + non-`/v1` helpers like `/api/config`). Caddy exposes only `/v1/*` publicly with automatic HTTPS; admin/demo listener binds to Tailscale interface only, never `0.0.0.0` (fail-closed env guard, OPS-03). Target of end-of-session Playwright UI evaluation.
- **D-10:** Docker/Compose on **`node:22-bookworm-slim`**; include `poppler-utils` and `tini` now (poppler needed Phase 3) — but no `sharp`/PDF code yet. Graceful SIGTERM drain via `shutdown.js`. Structured pino logs carry `request_id`/`job_id`; secrets never logged (keep redaction test).
- **D-11:** Test runner **`node --test`** (port suite, adapt for D-03/D-04/D-06). No ESLint/TS/typecheck added. "Build" = `docker compose build`. Verification = `npm test` + Docker build smoke; absence of lint/typecheck is expected.

### Claude's Discretion
- Exact module file layout, internal helper naming, test-file organization follow the reference's structure unless an adaptation forces a change.
- Concatenation separator for multi-page `text`: `\n\n` chosen; form-feed `\f` acceptable if a downstream reason emerges.

### Deferred Ideas (OUT OF SCOPE)
- Cascade router / automatic fallback / JOB-02 full trace — Phase 2.
- PDF (native + scanned), TIFF/HEIC/BMP/GIF normalization, `sharp`, subprocess sandboxing, OPS-06 CVE pinning — Phase 3.
- `mode=structured` schema extraction — Phase 4.
- `ocrspace.js` overlay/confidence enablement — Phase 2.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support (reference status) |
|----|-------------|-------------------------------------|
| API-01 | Bearer token on every `/v1` request; missing/invalid ⇒ 401 | **DONE** — `lib/v1/auth.js` (RFC 6750 case-insensitive scheme, `timingSafeEqual`, `/health` exempt). Port as-is. |
| API-02 | Refuse to start if `API_TOKEN` missing/placeholder | **DONE** — `server.js:102-105`. Port as-is; keep drift guard vs `.env.example`. |
| API-03 | `POST /v1/ocr` (multipart) ⇒ 202 + `job_id` + `status_url` | **DONE** — `router.js:24-125` (also sets `Location` + `Retry-After`). Field rename `image`→`file` (D-06). |
| API-04 | Poll `GET /v1/jobs/:id` ⇒ terminal status + typed `error` on failure | **DONE w/ EDIT** — `router.js:128-138` + `jobs.js`. `completed`→`succeeded` (D-03). |
| API-05 | `GET /v1/models` lists engines (profiles = Phase 2) | **DONE** — `router.js:144-154`. Add `default_mode`/`modes_supported` already present. Profiles discovery deferred. |
| API-06 | Unauthenticated `GET /v1/health` | **DONE** — `health.js` + auth exempt on `/health`. Port as-is. |
| API-07 | Oversized/unsupported ⇒ explicit 413/422 + clear code | **DONE** — `router.js` + `upload.js` + `sniff.js`. Update `field: 'image'`→`'file'`. |
| API-08 | Full queue ⇒ `503 server_busy` + `Retry-After` | **DONE** — `router.js:79-97` + `worker.js` bounded `highWater`. Port as-is. |
| JOB-01 | Page-aware envelope (`pages[]` + concatenated text) from day one | **NEW (small)** — introduce envelope at `worker.js:38` result assembly (D-04). |
| JOB-03 | TTL sweep of terminal jobs | **DONE** — `jobs.js` LRUCache `{ ttl, ttlAutopurge }`. Port as-is. |
| INP-01 | Accept PNG/JPEG/WebP | **DONE** — `upload.js` allowlist + `sniff.js`. Port as-is. |
| INP-02 | Magic-byte sniff, reject spoofed/SVG-with-script | **DONE** — `sniff.js` (PNG/JPEG/WebP magic bytes; returns null otherwise). Port as-is. |
| OPS-01 | Docker/Compose on `node:22-bookworm-slim` + `poppler-utils` | **NEW** — reference is `node:20-alpine`. Rewrite Dockerfile (D-10). |
| OPS-02 | Caddy automatic HTTPS, only `/v1/*` public | **DONE** — `Caddyfile` default-deny + `/v1/*` handles. Port as-is. |
| OPS-03 | Admin binds Tailscale-only, never `0.0.0.0` (fail-closed) | **DONE** — `server.js:107-117` guard + compose `${TAILSCALE_IP:?...}:8780:3000`. Port as-is. |
| OPS-04 | Drain in-flight jobs on SIGTERM (bounded) | **DONE** — `shutdown.js` + `server.js` gracefulShutdown. Port as-is. |
| OPS-05 | Structured logs w/ request/job IDs; no secrets | **DONE** — `logger.js` redact paths + pino-http `request_id`; `verify-redaction.js`. Port as-is. |
</phase_requirements>

## Summary

Phase 1 is a **near-verbatim port** of `/home/luis/proyectos/test-ocr-qwen3-vl` — a working, 19-file-tested Express service — into this fresh repo (only `CLAUDE.md` exists today). **14 of 17 phase requirements are already fully implemented in the reference and port with zero logic changes.** The genuinely new work is small and localized: three mechanical renames (`completed`→`succeeded`, `image`→`file`, the result-envelope wrap), one default-engine resolver (D-08), and a Dockerfile base-image migration (`node:20-alpine` → `node:22-bookworm-slim` + `poppler-utils`).

The single largest *effort* item is not code — it is **updating the test suite** to match D-03/D-04/D-06, plus **rewriting `test/deploy.test.js`** whose assertions are byte-coupled to the old Alpine Dockerfile (`FROM node:20-alpine`, `apk add tini`, `/sbin/tini`). Those regexes will all fail against the new Debian/bookworm image and must be updated in lockstep with the Dockerfile.

**Primary recommendation:** Copy the reference tree in wholesale, then apply the surgical edits catalogued in the Port Map below. Do NOT re-architect — the reference already encodes hard-won fixes (WR-04 finalized guard, WR-05 drain promise, WR-07 `intFromEnv`, WR-08 test clear) that must survive the rename intact. Treat every `completed`/`image` occurrence as a find-and-replace target, not a redesign opportunity.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Bearer auth | API (Express middleware) | — | `bearerAuth` runs before `/v1` router; `/health` exempt |
| Public TLS + route gating | CDN/Edge (Caddy) | — | Caddy terminates HTTPS, default-denies non-`/v1/*` |
| Admin/demo UI network isolation | Deploy (compose port bind) | API (env guard) | Tailscale bind is primary; `server.js` guard is backup |
| File upload + size limit | API (multer) | — | `memoryStorage`, `limits.fileSize/files` |
| Authoritative type detection | API (sniff.js) | — | Magic bytes, never client Content-Type |
| Async job lifecycle + TTL | API (in-memory LRU) | — | `lru-cache` with `ttlAutopurge` — no DB in v1 |
| Single-concurrency worker + backpressure | API (bottleneck) | — | `maxConcurrent:1`, bounded `highWater` |
| OCR engine call | External provider | API (provider adapter) | `ocr.space` HTTP / Ollama Cloud HTTP |
| Graceful drain | API (shutdown.js) | Deploy (`stop_grace_period`) | 35s app drain inside 40s compose grace |
| Structured logging | API (pino/pino-http) | — | request_id/job_id; redaction |

## Port Map (file-by-file)

> Legend: **AS-IS** = copy unchanged · **EDIT** = copy then modify · **REWRITE** = substantially changed · **NEW** = create · **DROP** = do not port

### Source — `lib/`
| File | Action | Change detail |
|------|--------|---------------|
| `lib/logger.js` | AS-IS | pino redact paths intact (OPS-05). |
| `lib/models.js` | AS-IS | Engine registry drives `/v1/models` + mode validation. (Optional: labels are Spanish emoji strings — cosmetic, leave.) |
| `lib/ocr.js` | AS-IS | Dispatch to provider by `model.provider`. |
| `lib/providers/ollama.js` | AS-IS | axios call; timeout; error mapping upstream. |
| `lib/providers/ocrspace.js` | AS-IS | Note: discards confidence (`isOverlayRequired:'false'`) — that's Phase 2, leave as-is now. |
| `lib/v1/auth.js` | AS-IS | API-01/02. RFC 6750 case-insensitive, `timingSafeEqual`. |
| `lib/v1/env.js` | AS-IS | `intFromEnv` boot validation (WR-07). |
| `lib/v1/errors.js` | AS-IS | `mapErrorCode` typed error mapping (API-04). |
| `lib/v1/health.js` | AS-IS | API-06 cached probe; always 200. |
| `lib/v1/modes.js` | AS-IS | `resolveMode`. |
| `lib/v1/sniff.js` | AS-IS | INP-02 magic bytes PNG/JPEG/WebP. |
| `lib/v1/upload.js` | **EDIT** | Line 13: `new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image')` → field `'file'` (D-06). `limits` already correct (INP-01/API-07). |
| `lib/v1/jobs.js` | **EDIT** | D-03: line 55 `job.status = 'completed'` → `'succeeded'`. Comments lines 44/50 mention "completed" (cosmetic but update for clarity). Keep `finalized` guard (WR-04) intact. `create()` still writes `status:'queued'`. |
| `lib/v1/worker.js` | **EDIT** | D-04: line 38 `jobs.complete(jobId, {...})` payload changes from flat `{text, model, provider, mode, bytes_received}` to page-aware envelope (see Adaptation #2). D-05: add `engine` id into per-page + job trace. No status string in this file (delegates to `jobs.complete`). |
| `lib/v1/shutdown.js` | **EDIT** | D-03: line 52 `if (job.status === 'processing')` unchanged; but the "completed jobs untouched" semantics rely on terminal states — no `'completed'` literal appears here (it checks `'queued'`/`'processing'`), so **shutdown.js needs NO status-literal edit** — verify by grep. Keep WR-05 promise pattern. |
| `lib/v1/router.js` | **EDIT** | D-06: line 25 `upload.single('image')` → `'file'`; lines 32/40/49 `field: 'image'` → `'file'`; line 42 message text. D-08: `findModel`/mode block (lines 54-72) — make `model` optional, add `resolveDefaultEngine()` when `modelId` absent (prefer ocrspace if key present). All other logic (202, queue guard, sniff, fire-and-forget) AS-IS. |

### Entry point + deploy
| File | Action | Change detail |
|------|--------|---------------|
| `server.js` | **EDIT** | D-08: add zero-engine fail-closed boot guard (no engine has a key AND registry non-empty ⇒ still boot? per D-08 fail only if *zero engines configured*). Port `/api/config` + legacy `/api/ocr` admin routes (D-09). API_TOKEN + TAILSCALE_IP guards AS-IS. `uuid v7` → keep (or swap to `crypto.randomUUID` per CLAUDE.md — discretionary). |
| `public/index.html` | AS-IS | D-09 admin UI. **Note:** it POSTs to legacy `/api/ocr` (JSON base64, `server.js:64`), NOT `/v1/ocr` multipart — so the `image`→`file` rename does **NOT** touch the UI. Playwright target. |
| `Dockerfile` | **REWRITE** | D-10: `node:20-alpine`→`node:22-bookworm-slim`; `apk add tini`→`apt-get install -y --no-install-recommends tini poppler-utils`; ENTRYPOINT `/sbin/tini`→`/usr/bin/tini` (Debian path). Keep multi-stage, `USER node`, `ENV NODE_ENV=production`, `EXPOSE 3000`. See Pitfall 1. |
| `docker-compose.yml` | **EDIT (near AS-IS)** | Tailscale bind, healthcheck, grace period all correct. **Fix healthcheck**: `wget --spider` is a busybox/Alpine builtin — bookworm-slim has no `wget`. Replace with a node-based probe (see Pitfall 2). Update `image:` tag name to `ocr-router:latest`. |
| `Caddyfile` | AS-IS | OPS-02 default-deny + `/v1/*`. Port unchanged. |
| `.env.example` | **EDIT** | Keep API_TOKEN/TAILSCALE_IP placeholders (byte-coupled to server.js drift guard). Update project name in comments. |
| `.dockerignore` | AS-IS | Correctly excludes `test`, `.planning`, `.env`, `node_modules`. |
| `.gitignore` | AS-IS | `.env`, `node_modules/`. |
| `package.json` | **EDIT** | Bump `multer ^2.1.1`→`^2.2.0` (CLAUDE.md). Drop `chalk` (only used by `test-ocr.js`, not ported). Add `"engines": { "node": ">=22" }`. Update `test` script to match renamed/added test files. Rename `web` script or keep `node server.js`. |
| `test-ocr.js` | **DROP** | Legacy batch CLI (uses chalk); not part of the service. Out of Phase 1 scope. |
| `README.md` | NEW/EDIT | Rewrite for ocr-router (low priority). |

### Tests — `test/` (port + adapt)
| File | Action | Change detail |
|------|--------|---------------|
| `jobs.test.js` | **EDIT** | D-03: line 25 `'completed'`; D-04: lines 27-31 assert flat `result.model/provider/mode/bytes_received` → new envelope `result.text` + `result.pages[0]`. Line 6 test title. |
| `jobs-extra.test.js` | **EDIT** | D-03: line 97 `'completed'`; D-04: line 98 `result.text` (envelope). |
| `shutdown.test.js` | **EDIT** | D-03: lines 52/57/58 seed/assert `status:'completed'` → `'succeeded'`. |
| `v1-routes.test.js` | **EDIT** | D-06: `buildMultipart` default `fieldName='image'`→`'file'` (line 66); line 400 `payload.field === 'image'`→`'file'`; D-03: line 245 `'completed'`→`'succeeded'`. Verify 202/Location/status_url assertions still pass (unchanged). |
| `deploy.test.js` | **REWRITE** | Byte-coupled to old Dockerfile. Update: `FROM node:20-alpine` (2 stages) → `node:22-bookworm-slim`; `apk add tini` → `apt-get ... tini poppler-utils`; `/sbin/tini` → `/usr/bin/tini`; healthcheck regex if wget replaced. Compose Tailscale/grace/caddy assertions AS-IS. Add assertion for `poppler-utils` install. |
| `worker.test.js` | **EDIT** | Failure path asserts `status:'failed'` (unchanged). Verify no `'completed'` literal. If it exercises success, update to envelope. |
| `worker-logging.test.js` / `worker-failure-logging.test.js` | **EDIT** | Verify `'job complete'`/log-shape assertions; update if they assert result shape or status literal. |
| `auth.test.js`, `concurrency.test.js`, `env-guards.test.js`, `errors.test.js`, `health.test.js`, `logger-shape.test.js`, `models-shape.test.js`, `modes.test.js`, `pino-http.test.js`, `sniff.test.js`, `upload.test.js` | AS-IS (verify) | Likely no status/field/envelope coupling. `upload.test.js` — check for `'image'` field literal; `env-guards.test.js` drift guard AS-IS. |
| `scripts/verify-redaction.js` | AS-IS | OPS-05 redaction verification. Keep in test script. |

## The Three Adaptations (exact locations)

### Adaptation #1 — `completed` → `succeeded` (D-03)
**Code occurrences (grep-verified):**
- `lib/v1/jobs.js:55` — `job.status = 'completed';` → `'succeeded';` (the ONLY functional code change)
- `lib/v1/jobs.js:44,50` — comments (update for clarity)
- **`worker.js` / `shutdown.js` have NO `'completed'` status literal** — worker calls `jobs.complete()`; shutdown only tests `'queued'`/`'processing'`. Renaming the *function* `complete()`→`succeed()` is optional/discretionary; the CONTEXT names the status not the function. Recommend: keep function name `complete()`, change only the emitted status string, to minimize churn. (Verify against tests that call `jobs.complete(...)`.)

**Test occurrences:** `jobs.test.js:25`, `jobs-extra.test.js:97`, `shutdown.test.js:52,57,58`, `v1-routes.test.js:245`. Confidence: HIGH (grep-enumerated).

### Adaptation #2 — Page-aware envelope (D-04/D-05)
**Single assembly point:** `lib/v1/worker.js:37-45`. Current:
```js
jobs.complete(jobId, { text: result.text, model: model.id, provider: model.provider, mode, bytes_received: buffer.length });
```
**New shape** (single image ⇒ one page):
```js
jobs.complete(jobId, {
  text: result.text,                       // top-level = pages joined by '\n\n' (1 page ⇒ == page text)
  pages: [{ page: 1, text: result.text, engine: model.id, confidence: null }],
  // D-05 job-level trace stub (keep alongside envelope):
  engine: model.id, provider: model.provider, mode, bytes_received: buffer.length,
});
```
Timestamps `created_at`/`started_at`/`completed_at` already recorded by `jobs.create`/`setProcessing`/`complete` — D-05 satisfied. `confidence:null` (ocr.space confidence deferred to Phase 2). Keep the `\n\n` join helper trivial for 1 page; write it join-ready so multi-page (Phase 3) is additive. Confidence: HIGH.

### Adaptation #3 — Multipart field `image` → `file` (D-06)
**Code occurrences (grep-verified):**
- `lib/v1/router.js:25` — `upload.single('image')` → `upload.single('file')`
- `lib/v1/router.js:32,40,49` — `field: 'image'` → `field: 'file'`
- `lib/v1/router.js:42,50` — user-facing message text ("campo image"/"imagen PNG") → "file"
- `lib/v1/upload.js:13` — `new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'image')` → `'file'`

**Test occurrences:** `v1-routes.test.js:66` (`fieldName='image'` default), `:400` (`payload.field`). **Admin UI (`public/index.html`) is unaffected** — it uses legacy `/api/ocr` JSON, not `/v1/ocr` multipart. Confidence: HIGH (grep-enumerated).

## New Work Beyond the Renames

### N-1 — Default engine resolver + zero-engine boot guard (D-08)
Reference `router.js:56-63` returns `422 invalid_parameter field:model` when `modelId` is absent (model is currently **required**). D-08 makes it optional:
- If `req.body.model` absent ⇒ `resolveDefaultEngine()`: prefer the `ocrspace` engine when `OCR_SPACE_API_KEY` is set, else the first engine in `models` whose provider has a key.
- Explicit `model` still validated via `findModel` + `resolveMode` (unchanged path).
- **Boot guard (server.js):** enumerate engines with a present key; if **zero**, throw at startup (fail-closed), mirroring the API_TOKEN/TAILSCALE guards. Confidence: HIGH (design is explicit in D-08).

### N-2 — Dockerfile Debian migration (D-10) — see Pitfall 1 & 2.

### N-3 — `deploy.test.js` rewrite (D-11) — assertions coupled to Alpine; must track N-2.

## Standard Stack

### Core (all already in reference `package.json` / lockfile — battle-tested, no new npm packages this phase)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `express` | `^4.22.1` | HTTP framework | Reference-proven; CLAUDE.md: stay on 4.x (Express 5 breaks ported middleware). [CITED: CLAUDE.md] |
| `multer` | `^2.2.0` (bump from `^2.1.1`) | Multipart upload w/ `limits` | Maintained 2.x line; set `fileSize`/`files=1`. [CITED: CLAUDE.md] |
| `bottleneck` | `^2.19.5` | Single-concurrency worker + bounded queue | Reference-proven backpressure (API-08). [CITED: CLAUDE.md] |
| `lru-cache` | `^11.5.0` | In-memory job store w/ TTL autopurge | JOB-03 memory sweep. [CITED: CLAUDE.md] |
| `pino` / `pino-http` | `^10.3.1` / `^11.0.0` | Structured logs + request_id | OPS-05. [CITED: CLAUDE.md] |
| `axios` | `^1.16.0` | Ollama provider HTTP | Existing provider code. [CITED: CLAUDE.md] |
| `uuid` | `^13.0.2` | uuidv7 job/request IDs | Keep, or swap to native `crypto.randomUUID` (Node 22) — discretionary. [CITED: CLAUDE.md] |
| `dotenv` | `^17.4.2` | `.env` loading | Reference-proven. [CITED: CLAUDE.md] |

### System packages (Docker image)
| Package | Purpose | Note |
|---------|---------|------|
| `tini` | PID 1 signal forwarding | Debian path `/usr/bin/tini` (Alpine was `/sbin/tini`). [VERIFIED: read Dockerfile + Debian tini packaging] |
| `poppler-utils` | (Phase 3) PDF rasterization | Installed now per D-10; **no code uses it in Phase 1**. [CITED: CLAUDE.md OPS-01] |

**Dropped:** `chalk` (only `test-ocr.js` uses it; not ported).

**Installation (no change from lockfile except multer bump):**
```bash
npm install   # from ported package.json + package-lock.json
```
**Version note:** CLAUDE.md verified all versions against npm registry on 2026-07-23 (today). No independent re-verification needed within validity window.

## Package Legitimacy Audit

All Phase-1 dependencies are pre-existing in the reference's committed `package-lock.json` — no newly-introduced or LLM-suggested packages. slopcheck not run (no new packages to vet); every entry is a top-tier, multi-year, high-download npm package already vendored and tested in the reference.

| Package | Registry | Maturity | Disposition |
|---------|----------|----------|-------------|
| express, multer, bottleneck, lru-cache, pino, pino-http, axios, uuid, dotenv | npm | Established (all >2yr, millions/wk) | Approved (inherited from reference lockfile) |
| chalk | npm | Established | REMOVED (unused after dropping `test-ocr.js`) |

**Packages removed due to slopcheck [SLOP]:** none.
**Packages flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram
```
                         Public Internet
                              │  (80/443 + 443/udp)
                              ▼
                    ┌──────────────────┐
                    │  Caddy (edge)    │  automatic HTTPS
                    │  default-deny;   │  only /v1/* proxied
                    │  /v1/* → app:3000│
                    └────────┬─────────┘
        Tailnet only         │ (docker bridge ocr_net)
   ${TAILSCALE_IP}:8780      ▼
        │            ┌──────────────────────────────────────┐
        │            │  Express app (Node 22, tini PID1)     │
        └───────────►│                                        │
  admin/demo UI      │  bearerAuth ──► /v1 router             │
  /  /api/*          │     │                                  │
  (no bearer;        │     ├─ POST /ocr ─► multer(mem,limits) │
   tailnet=trust)    │     │      └─ sniff() magic bytes      │
                     │     │      └─ resolveDefaultEngine(D8) │
                     │     │      └─ queue-depth guard ─►503  │
                     │     │      └─ jobs.create() ──► 202    │
                     │     │            │ status_url          │
                     │     │            ▼ fire-and-forget     │
                     │     │    bottleneck(maxConcurrent:1)   │
                     │     │            │                     │
                     │     │            ▼ runOCR(model)       │──► ocr.space / Ollama Cloud
                     │     │            ▼ jobs.succeed(env.)  │    (HTTP, per-provider key)
                     │     ├─ GET /jobs/:id ─► LRU store poll │
                     │     ├─ GET /models   ─► registry       │
                     │     └─ GET /health   ─► cached probe   │
                     │                                        │
                     │  SIGTERM ─► shutdown.drainAndCancel()  │
                     └────────────────────────────────────────┘
```

### Pattern: Async submit → poll (already implemented)
`POST /v1/ocr` returns `202 {job_id,status:'queued',status_url}` + `Location` + `Retry-After` immediately; work runs fire-and-forget on the single-concurrency limiter; client polls `GET /v1/jobs/:id` until `succeeded`/`failed`.

### Anti-Patterns to Avoid
- **Re-architecting the port.** The reference encodes fixes (WR-04 finalized guard against shutdown race; WR-05 drain-promise re-entrancy; WR-07 `intFromEnv` fail-loud; WR-08 test store-clear). Renames must not disturb these.
- **Awaiting the worker in the request handler.** It is deliberately fire-and-forget (`router.js:113`), with `.catch` failing the job. Keep it.
- **Reading confidence from ocr.space now.** `isOverlayRequired:'false'` stays — Phase 2 territory.
- **Adding bearer auth to the admin UI.** Tailnet is the trust perimeter (Caddyfile comment / D-09); UI sends no Authorization header.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Concurrency + backpressure | Custom queue | `bottleneck` (`highWater`+OVERFLOW) | Reference-proven; reject-before-enqueue memory guard |
| Job TTL/GC | Manual sweeper | `lru-cache` `{ttl,ttlAutopurge}` | JOB-03 for free |
| Type detection | Trust `Content-Type` | `sniff.js` magic bytes | INP-02 anti-spoof |
| Constant-time token compare | `===` | `crypto.timingSafeEqual` | Timing-attack safe (already in auth.js) |
| Env int parsing | `Number(x)\|\|default` | `intFromEnv` | Fail-loud on typos (WR-07) |
| PID1 signals | bare `node` | `tini` | Zombie reaping + SIGTERM forwarding |

## Runtime State Inventory

> This is a fresh-repo port, not a rename of a running system. The three "renames" (D-03/D-04/D-06) are **API-contract** changes in new source, not migrations of existing stored state.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — job store is in-memory LRU, empty at boot; no persistence in v1. | None. |
| Live service config | None — no deployed instance of this new repo yet. (Reference at `test-ocr-qwen3-vl` is a separate service, untouched.) | None. |
| OS-registered state | None — no cron/systemd/Task Scheduler entries for this repo. Deploy is Docker Compose, created fresh. | None. |
| Secrets/env vars | `API_TOKEN`, `OLLAMA_API_KEY`, `OCR_SPACE_API_KEY`, `TAILSCALE_IP`, `DOMAIN` — names carried over from reference `.env.example` unchanged. Code reads same names. | None (copy `.env.example`; operator fills real values). |
| Build artifacts | None yet — `node_modules` built fresh via `npm ci` in Docker; no committed build output. | None. |

**Nothing to migrate** — the `image`→`file` and `completed`→`succeeded` changes affect only the *new* code + tests and the *client-facing contract*, which has no existing consumers (Phase 1 is first ship).

## Common Pitfalls

### Pitfall 1: Alpine→Debian tini path & package manager
**What goes wrong:** Copying the Dockerfile verbatim breaks — `apk add` doesn't exist on Debian, and `ENTRYPOINT ["/sbin/tini","--"]` points to the Alpine path.
**How to avoid:** On `node:22-bookworm-slim` use `apt-get update && apt-get install -y --no-install-recommends tini poppler-utils && rm -rf /var/lib/apt/lists/*`; Debian's tini lives at **`/usr/bin/tini`**. Update `deploy.test.js` regexes in lockstep.
**Warning signs:** `deploy.test.js` DEPLOY-01 failures; container exits "exec /sbin/tini: no such file". Confidence: HIGH (read Dockerfile; Debian tini packaging known). [VERIFIED: read source + Debian packaging]

### Pitfall 2: Compose healthcheck uses busybox `wget` absent on bookworm-slim
**What goes wrong:** `test: wget --spider -q http://localhost:3000/v1/health` works on Alpine (busybox `wget`) but **bookworm-slim ships no `wget`/`curl`** — healthcheck always fails → container marked unhealthy → Caddy `depends_on service_healthy` never routes.
**How to avoid:** Replace with a Node-native probe (no extra package, Node 22 has global `fetch`):
`test: ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]`
Update `deploy.test.js` DEPLOY-07 healthcheck regex accordingly.
**Warning signs:** `docker compose ps` shows app `unhealthy`; Caddy 502s. Confidence: HIGH (bookworm-slim minimal base). [VERIFIED: read compose + Debian slim base knowledge] — flag for a quick `docker build` smoke check.

### Pitfall 3: Envelope join must be order-preserving and 1-page-safe
**What goes wrong:** A clever `pages.map().join('\n\n')` that reorders or drops the single page, or a top-level `text` that diverges from `pages[0].text` for one image.
**How to avoid:** For 1 page, `text === pages[0].text`; write the join as `pages.map(p=>p.text).join('\n\n')` so Phase 3 multi-page is literally the same line.
**Warning signs:** `jobs.test.js` envelope assertion mismatch.

### Pitfall 4: Partial rename leaves a mixed vocabulary
**What goes wrong:** Renaming `completed`→`succeeded` in `jobs.js` but missing a test seed (`shutdown.test.js:52`) yields a job that's terminal-but-not-recognized, silently mis-asserting.
**How to avoid:** Use the grep-enumerated occurrence lists above as a checklist; `grep -rn "completed\|'image'" lib/ test/` must return only intentional (comment) hits post-edit.

### Pitfall 5: Placeholder drift guard (WR-11)
**What goes wrong:** `env-guards.test.js` byte-couples `server.js` `PLACEHOLDER_API_TOKEN`/`PLACEHOLDER_TAILSCALE_IP` to `.env.example`. Editing one and not the other fails the drift guard.
**How to avoid:** Keep the two placeholder literals identical across `server.js` and `.env.example`. Port both files together.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | dev/test (`node --test`), runtime | verify locally | need ≥22 | Docker provides 22 |
| Docker + Compose v2 | OPS-01 build/run + verify | verify (`docker info`) | — | none (build is the "build" gate) |
| `poppler-utils` | Phase 3 (installed now, unused) | in image only | Debian ~24.x | n/a Phase 1 |
| ocr.space API key | default engine (D-08) if present | operator-supplied env | — | Ollama engine if key absent |
| Ollama Cloud key | LLM engines | operator-supplied env | — | ocr.space if key absent |
| Tailscale (`tailscale ip -4`) | OPS-03 admin bind | operator/VPS | — | none (fail-closed guard) |

**Missing with no fallback (must confirm before deploy):** Docker/Compose on the build host; at least one provider key at boot (D-08 zero-engine guard). **Note:** local `node --test` needs Node ≥22 installed on the dev machine — verify at plan time.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `node:22-bookworm-slim` has no `wget`/`curl`, breaking the ported healthcheck | Pitfall 2 | If wrong, node-probe swap is still harmless; low risk. Verify in build smoke. |
| A2 | Debian `tini` installs to `/usr/bin/tini` | Pitfall 1, Stack | Wrong path ⇒ container won't start; caught immediately by smoke run. |
| A3 | `shutdown.js`/`worker.js` contain no `'completed'` status literal (only `jobs.js:55`) | Adaptation #1 | grep-verified this session; LOW risk. |
| A4 | Admin UI POSTs to legacy `/api/ocr`, so `image`→`file` doesn't touch `public/index.html` | Adaptation #3 | grep-verified (`public/index.html:251`); LOW risk. |
| A5 | "engines configured" for D-08 = provider has an env key present | N-1 | Interpretation of D-08; matches CASC-07 wording. Confirm with planner. |
| A6 | Profiles discovery (API-05) deferred to Phase 2; Phase 1 `/v1/models` lists engines only | phase_requirements | ROADMAP SC#4 says "lists available engines" — supports this. LOW risk. |

## Open Questions

1. **`jobs.complete()` function-name rename?**
   - Known: D-03 renames the *status string*. The function `complete()` / the `'job complete'` log line are internal.
   - Recommendation: keep function/log names to minimize churn and preserve `worker-logging.test.js` assertions; change only the emitted `status` value. Planner may decide otherwise.

2. **Keep `uuid` dep or switch to `crypto.randomUUID`?**
   - CLAUDE.md flags it optional on Node 22. Recommendation: keep `uuid` (v7 time-ordered IDs; `randomUUID` is v4). Low priority.

3. **Legacy `/api/ocr` route retention.**
   - D-09 says port the admin surface + non-`/v1` helpers. `/api/ocr` (JSON base64, synchronous) is what the UI calls. Recommendation: port it as-is so the Playwright UI eval passes; it's tailnet-only and out of the public Caddy surface.

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control (already in reference) |
|---------------|---------|------------------------------------------|
| V2 Authentication | yes | Shared bearer token, `timingSafeEqual`, RFC 6750 (`auth.js`). API-01/02. |
| V3 Session Management | no | Stateless token; no sessions. |
| V4 Access Control | yes | `/v1/*` behind `bearerAuth`; `/health` intentionally public; admin surface network-isolated to tailnet (OPS-03). |
| V5 Input Validation | yes | multer `limits` + magic-byte `sniff.js` (reject spoofed/SVG-with-script); mode/model validation. INP-02/API-07. |
| V6 Cryptography | partial | `crypto.timingSafeEqual`, `crypto` UUID — no hand-rolled crypto. |
| V7 Error/Logging | yes | pino redaction of `authorization`/`apiKeyOverride`; `verify-redaction.js` (OPS-05). |
| V12 Files/Resources | yes | `memoryStorage` + `files:1` + `fileSize` cap; bounded queue prevents memory exhaustion. |

### Known Threat Patterns for Express file-upload API
| Pattern | STRIDE | Standard Mitigation (status) |
|---------|--------|------------------------------|
| Content-type spoofing (exe as png) | Tampering | Magic-byte sniff, reject on null (DONE) |
| SVG-with-script / polyglot | Tampering/XSS | sniff allows only PNG/JPEG/WebP magic (DONE) |
| Upload memory exhaustion / decompression bomb | DoS | `fileSize` + `files:1` + bounded queue (DONE); pixel caps are Phase 3 |
| Token brute-force / timing | Info disclosure | `timingSafeEqual` + length check (DONE) |
| Secret leakage in logs | Info disclosure | pino redact + redaction test (DONE) |
| Admin panel public exposure | Elevation | Tailscale bind + fail-closed guard + Caddy default-deny (DONE) |
| Unbounded queue growth | DoS | reject-before-enqueue `503 server_busy` (DONE) |

## Sources

### Primary (HIGH confidence — read this session)
- Reference source tree `/home/luis/proyectos/test-ocr-qwen3-vl/` — `server.js`, all `lib/v1/*`, `lib/{logger,models,ocr}.js`, `lib/providers/*`, `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `package.json`, `.env.example`, `.dockerignore`, `public/index.html`, `test/*` — read directly.
- Grep enumeration of `completed` / `'image'` / `.complete(` across `lib/` and `test/` — occurrence lists are exhaustive as of this session.
- `/home/luis/proyectos/ocr/CLAUDE.md` — pinned stack + versions (verified against npm registry 2026-07-23) + "What NOT to Use".
- `.planning/{PROJECT,REQUIREMENTS,ROADMAP}.md` + `01-CONTEXT.md` — contract source of truth.

### Secondary (MEDIUM — knowledge, flag for smoke verification)
- Debian bookworm-slim ships no `wget`/`curl`; `tini` at `/usr/bin/tini` — verify in `docker build` smoke (Pitfalls 1-2).

## Metadata

**Confidence breakdown:**
- Port map / adaptations: HIGH — every occurrence grep-verified against read source.
- Stack/versions: HIGH — inherited from a working lockfile + CLAUDE.md (verified today).
- Dockerfile migration (Debian specifics): MEDIUM-HIGH — flagged for build smoke (Pitfalls 1-2).
- D-08 default-engine semantics: MEDIUM — interpretation of CONTEXT; A5 for planner confirm.

**Research date:** 2026-07-23
**Valid until:** 2026-08-22 (stable stack; re-check only if reference source changes).
