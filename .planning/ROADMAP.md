# Roadmap: ocr-router

## Overview

ocr-router grows bottom-up by dependency. It starts by porting a mature reference implementation verbatim to deliver a dockerized, bearer-secured `/v1` API that does async image OCR behind Caddy/Tailscale — with a page-aware response envelope designed in from day one so multi-page support never becomes a breaking change. It then builds the two genuinely new layers in dependency order: first the **cascade router** (the core differentiator — automatic engine escalation with a confidence heuristic, traceability, and cost caps) on plain images, then the **multi-format input pipeline** (PDF native + scanned, extra image formats) that feeds per-page images into the already-proven router memory-safely. It closes with **structured extraction** as a thin increment on the finished cascade. Every phase ships an end-to-end, user-usable capability.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - Ported bearer-secured `/v1` async OCR API with page-aware envelope, image OCR, and Caddy/Tailscale deploy (completed 2026-07-23)
- [x] **Phase 2: Cascade Router** - Automatic engine escalation with confidence heuristic, traceability, cost caps, and graceful degradation (completed 2026-07-23)
- [ ] **Phase 3: Input Pipeline** - Memory-safe PDF (native + scanned) and multi-format image normalization with per-page results
- [ ] **Phase 4: Structured Extraction** - Schema-driven, validated JSON extraction via vision LLM

## Phase Details

### Phase 1: Foundation
**Goal**: A dockerized, bearer-secured `/v1` HTTP API that accepts an image and returns OCR text via an async job model, with a page-aware response envelope from day one, deployed behind Caddy with the admin surface Tailscale-bound.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: API-01, API-02, API-03, API-04, API-05, API-06, API-07, API-08, JOB-01, JOB-03, INP-01, INP-02, OPS-01, OPS-02, OPS-03, OPS-04, OPS-05
**Success Criteria** (what must be TRUE):
  1. A client with a valid bearer token can POST an image to `POST /v1/ocr`, receive `202` + `job_id` + `status_url`, then poll `GET /v1/jobs/:id` until it returns a terminal `succeeded` status with the extracted text; a missing/invalid token gets `401` and the service refuses to boot when `API_TOKEN` is missing or a placeholder.
  2. The job result is returned as a page-aware envelope (`pages[]` array plus concatenated `text`) even for a single-image job, so multi-page support later is additive rather than a breaking change.
  3. Oversized uploads get `413`, unsupported/spoofed types (determined by authoritative magic-byte sniffing, not the client-declared content-type) get `400`/`422`, and a full queue returns `503 server_busy` with `Retry-After`.
  4. `GET /v1/health` responds unauthenticated, `GET /v1/models` lists available engines, and completed/failed jobs are swept from the in-memory store after the configured TTL.
  5. The stack runs via Docker Compose on `node:22-bookworm-slim` behind Caddy (automatic HTTPS, only `/v1/*` public, admin bound to Tailscale, never `0.0.0.0`), drains in-flight jobs on SIGTERM, and emits structured logs with request/job IDs and no secrets.
**Plans**: 3 plans
Plans:
- [x] 01-01-PLAN.md — Walking skeleton: port app runtime (lib/** + server.js) + 3 adaptations (succeeded/file/envelope) + default-engine resolver; prove the OCR slice end-to-end
- [x] 01-02-PLAN.md — Port + adapt the full node --test suite (16 files + verify-redaction) as the acceptance proof
- [x] 01-03-PLAN.md — Deploy stack: rewrite Dockerfile for node:22-bookworm-slim + poppler-utils + tini, adapt compose/Caddy, rewrite deploy.test.js

### Phase 2: Cascade Router
**Goal**: Every image request automatically escalates through an ordered chain of engines, returning the best result any configured engine can produce — with full traceability, bounded cost/latency, and graceful degradation — the product's core value, proven on plain images.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: CASC-01, CASC-02, CASC-03, CASC-04, CASC-05, CASC-06, CASC-07, CASC-08, CASC-09, JOB-02, JOB-04
**Success Criteria** (what must be TRUE):
  1. A single-image request with no model specified walks the ordered chain (ocr.space → Gemini 3 Flash → Gemma 4 31B → Qwen3-VL 235B) and returns the first result that passes a multi-signal quality heuristic; on a clean document it stops at the cheap first tier (P50 winner is not the top tier).
  2. The router falls through on hard failure (error/timeout/5xx) and on low-confidence output (empty/short text, non-printable/garbage ratio, and — when available — ocr.space overlay score); when no engine clears the threshold it returns the best result obtained, marked `low_confidence: true`, never losing the work.
  3. Each job trace records engines attempted, winning engine, per-engine timing, confidence, and the `low_confidence` flag; a single authoritative job timeout aborts a hung provider rather than wedging the single-concurrency worker.
  4. A client can select a named profile (`fast`/`balanced`/`quality`, with a default when unspecified) or force a specific engine/model, and forcing an engine that lacks the required capability is rejected with a typed error.
  5. The cascade is bounded by max-tier, max-attempts, and a cumulative time budget so no request runs away in cost/latency; it assembles only from engines whose keys/config are present (a missing key is a clean tier drop, not a per-request error) and fails closed at boot only if zero engines are configured. Routing chains, profiles, thresholds, and capabilities are declarative config, not hard-coded branches.
**Plans**: 4 plans
Plans:
- [x] 02-01-PLAN.md — Pure config-driven confidence heuristic + declarative cascade config (10-fixture TDD suite)
- [x] 02-02-PLAN.md — Thread job AbortSignal into both providers + enable ocr.space overlay word-count signal
- [x] 02-03-PLAN.md — Cascade runner + trace: walk/fall-through/best-so-far/budget/quota short-circuit (fall-through matrix TDD)
- [x] 02-04-PLAN.md — Wire cascade into worker + router: profiles, forced-engine bypass/422, trace, profiles discovery

### Phase 3: Input Pipeline
**Goal**: The service accepts PDFs (native and scanned) and additional image formats, turning any upload into memory-safe per-page results routed through the already-proven cascade.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: INP-03, INP-04, INP-05, INP-06, INP-07, INP-08, OPS-06
**Success Criteria** (what must be TRUE):
  1. A native (text-bearing) PDF returns per-page embedded text without invoking OCR (cheap fast path); a scanned PDF is rendered page-by-page and each page is routed through the cascade.
  2. Additional image formats (TIFF multipage, HEIC, BMP, GIF) are normalized to a routable image before cascading, with untrusted decode/rasterization running in a killable, resource-limited subprocess and temp files always cleaned up (even on mid-job kill).
  3. Multi-page inputs return per-page results with a per-page status rollup (`completed` / `completed_with_errors`), so one failed page neither fails the whole job nor is silently dropped, and page order is preserved.
  4. Rasterization streams exactly one page image in memory at a time and enforces page-count, DPI, and pixel caps, so a large or decompression-bomb PDF (100-page or huge-MediaBox) cannot exhaust the memory budget.
  5. Native-decode dependencies are pinned to CVE-fixed versions (`sharp>=0.35.0`) and scanned in CI.
**Plans**: 7 plans
Plans:
- [x] 03-01-PLAN.md — Dependencies + OPS-06 npm audit gate (green) + boot-validated caps config [Wave 1]
- [x] 03-02-PLAN.md — Extend magic-byte sniff + accepted-type gates for PDF/TIFF/HEIC/BMP/GIF [Wave 1]
- [x] 03-03-PLAN.md — Subprocess sandbox seam (spawnCapture) + temp-dir registry + shutdown drain (INP-08) [Wave 1]
- [x] 03-04-PLAN.md — PDF path: unpdf native-text short-circuit + memory-safe single-page rasterize (pdfinfo cap + pdftoppm) [Wave 2]
- [x] 03-05-PLAN.md — Image normalization: sharp TIFF/GIF frames + heic-convert/bmp-js decode → PNG frames [Wave 2]
- [ ] 03-06-PLAN.md — Page-pipeline orchestrator + worker runInputJob: one deadline, temp lifecycle, per-page rollup [Wave 3]
- [ ] 03-07-PLAN.md — Docker integration smoke: real poppler + HEIC + ulimit/kill + temp cleanup (skip-guarded on host) [Wave 4]

### Phase 4: Structured Extraction
**Goal**: Clients can extract schema-validated JSON from a document via a vision LLM, as a thin increment reusing the finished cascade unchanged.
**Mode:** mvp
**Depends on**: Phase 2 (independent of Phase 3)
**Requirements**: STR-01, STR-02, STR-03
**Success Criteria** (what must be TRUE):
  1. A client requests `mode=structured` with a schema and receives JSON validated against that schema, extracted by a vision LLM; ocr.space is excluded by capability, and forcing it with `mode=structured` is rejected with a typed error.
  2. LLM output is constrained to the schema (constrained decoding) and validated; invalid output triggers exactly one bounded repair retry before failing with a typed error, never returning unvalidated JSON.
  3. Document content is passed to the LLM as clearly delimited data (never as instructions), so a document cannot change the output shape (prompt-injection mitigation), and non-present fields come back `null` rather than fabricated.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete   | 2026-07-23 |
| 2. Cascade Router | 4/4 | Complete   | 2026-07-23 |
| 3. Input Pipeline | 5/7 | In Progress|  |
| 4. Structured Extraction | 0/TBD | Not started | - |
