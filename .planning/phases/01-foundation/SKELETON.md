# Walking Skeleton — ocr-router

**Phase:** 1
**Generated:** 2026-07-23

## Phase Goal (User Story)

**As a** developer or automation pipeline (n8n and similar), **I want to** submit a raster image to a bearer-secured HTTP API and poll for the extracted OCR text, **so that** I get reliable document text without hand-managing OCR providers.

## Capability Proven End-to-End

A client with a valid bearer token POSTs a PNG to `POST /v1/ocr`, receives `202 + job_id + status_url + Location`, then polls `GET /v1/jobs/:id` until it returns a terminal `succeeded` status carrying a page-aware result envelope (`result.text` + `result.pages[]`) — running under the local `node server.js` dev path and the `node:22-bookworm-slim` Docker/Compose stack behind Caddy.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Strategy | Wholesale PORT of `/home/luis/proyectos/test-ocr-qwen3-vl` (copy files, apply 3 surgical adaptations) | ~14/17 reqs already implemented + tested; re-architecting would discard hard-won WR fixes (D-01/D-02) |
| Runtime | Node.js 22 + Express 4.22 (CommonJS) | Reference-proven; CLAUDE.md pins Express 4.x (Express 5 breaks ported middleware); Node 20 is EOL |
| Async model | `202 + job_id` → poll `GET /v1/jobs/:id`; fire-and-forget on a single-concurrency `bottleneck` worker | Reference contract; single-concurrency + bounded queue is the memory-exhaustion guard |
| Job store | in-memory `lru-cache` with `{ ttl, ttlAutopurge }` | JOB-03 TTL sweep for free; no DB in v1 |
| Response envelope | page-aware from day one: `result: { text, pages:[{page,text,engine,confidence}] }` | JOB-01/D-04 — multi-page (Phase 3) is additive, never a breaking change |
| Terminal status | `succeeded` (renamed from reference `completed`) | D-03 — matches REQUIREMENTS API-04 + ROADMAP SC#1 vocabulary |
| Upload field | multipart `file` (renamed from `image`); PNG/JPEG/WebP only; magic-byte sniff | D-06/D-07/INP-02 — product accepts "documents"; authoritative type detection, never client Content-Type |
| Engine selection | no cascade; optional `model`; default-engine resolver (prefer ocrspace if key present) | D-08 — Phase 1 runs one engine; envelope shaped so Phase 2 cascade is additive |
| Auth | shared bearer token on `/v1/*` (`/health` exempt), `crypto.timingSafeEqual` | API-01/API-02; fail-closed boot guards (API_TOKEN, zero-engine) |
| Admin surface | inherited `public/index.html` + legacy `/api/*`, Tailscale-bound only, never `0.0.0.0` | D-09/OPS-03 — tailnet is the trust perimeter; Caddy default-denies it publicly |
| Deployment | Docker Compose on `node:22-bookworm-slim` + `poppler-utils` + `tini`, Caddy automatic HTTPS | D-10/OPS-01/OPS-02; poppler installed early to keep the base stable for Phase 3 |
| Test runner | `node --test` (ported reference suite, adapted for D-03/D-04/D-06) | D-11 — no ESLint/TS added; "build" = `docker compose build` |
| Directory layout | `lib/v1/*` (API modules), `lib/providers/*`, `lib/{logger,models,ocr}.js`, `server.js`, `public/`, `test/`, `scripts/` | Follows the reference structure unchanged (Claude's discretion, no adaptation forces a change) |

## Stack Touched in Phase 1

- [x] Project scaffold (package.json with multer ^2.2.0 + engines node>=22, `.gitignore`, `.dockerignore`, `.env.example`, `node --test` runner)
- [x] Routing — real `/v1/ocr`, `/v1/jobs/:id`, `/v1/models`, `/v1/health` routes
- [x] Data layer — real in-memory LRU job store: write on `POST /v1/ocr`, read on `GET /v1/jobs/:id`
- [x] UI — inherited tailnet-only admin/demo (`public/index.html` → legacy `/api/ocr`)
- [x] Deployment — `node:22-bookworm-slim` Docker/Compose stack behind Caddy + documented local `node server.js` full-stack run

## Out of Scope (Deferred to Later Slices)

- Cascade router / automatic engine escalation / confidence heuristic / JOB-02 full trace — **Phase 2**
- PDF (native + scanned), TIFF/HEIC/BMP/GIF normalization, `sharp`, subprocess sandboxing, OPS-06 CVE pinning — **Phase 3** (`poppler-utils` is installed now but unused)
- `mode=structured` schema-validated JSON extraction — **Phase 4**
- Profiles discovery in `/v1/models`, ocr.space overlay/confidence enablement — **Phase 2**
- Multi-page envelope population (the `pages[]` shape exists; only 1 element in Phase 1)

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- **Phase 2 (Cascade Router):** the single-engine call becomes an ordered cascade with a confidence heuristic, per-engine trace, profiles, cost caps — populating the already-present `engine`/`confidence` envelope fields and JOB-02 trace.
- **Phase 3 (Input Pipeline):** PDFs + extra image formats normalized to per-page images (poppler + sharp), populating multi-element `pages[]` through the proven cascade, memory-safe subprocess rasterization.
- **Phase 4 (Structured Extraction):** `mode=structured` with a Zod schema → constrained decoding → validated JSON, reusing the finished cascade unchanged.
