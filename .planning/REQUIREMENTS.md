# Requirements: ocr-router

**Defined:** 2026-07-23
**Core Value:** Never fail to return the best available text/data for a document — the cascade escalates quality automatically so one API call always yields the best result any configured engine could produce.

## v1 Requirements

Requirements for the initial milestone. Each maps to a roadmap phase.

### API & Auth

- [x] **API-01**: Client authenticates every `/v1` request with a shared bearer token; missing/invalid token is rejected `401`
- [x] **API-02**: Service refuses to start when `API_TOKEN` is missing or left at the placeholder value (fail-closed)
- [x] **API-03**: Client submits a document to `POST /v1/ocr` (multipart) and receives `202` with a `job_id` and `status_url`
- [x] **API-04**: Client polls `GET /v1/jobs/:id` and receives a JSON envelope with a terminal status (`queued`/`processing`/`succeeded`/`failed`) and, on failure, a typed `error` object
- [x] **API-05**: Client lists available engines and named profiles via `GET /v1/models` (and profiles discovery)
- [x] **API-06**: Client can check service liveness via unauthenticated `GET /v1/health`
- [x] **API-07**: Oversized uploads and unsupported types are rejected with explicit `413`/`400`/`422` and a clear error code (page/size limits enforced)
- [x] **API-08**: When the job queue is full the service returns `503 server_busy` with `Retry-After` (backpressure, no unbounded growth)

### Jobs & Response Envelope

- [x] **JOB-01**: The job result envelope is page-aware from day one — results are returned as a `pages[]` array plus concatenated text, even for a single-image job
- [x] **JOB-02**: Each job records full cascade traceability: engines attempted, winning engine, per-engine timing, confidence, and a `low_confidence` flag when no engine cleared threshold
- [x] **JOB-03**: Completed/failed jobs are swept from the in-memory store after a configurable TTL so the process does not leak memory
- [x] **JOB-04**: Each job honors a single authoritative timeout; a hung provider or subprocess is aborted rather than wedging the worker

### Cascade Routing

- [x] **CASC-01**: For a request the router walks an ordered chain of engines (ocr.space → Gemini 3 Flash → Gemma 4 31B → Qwen3-VL 235B) and returns the first result that passes quality
- [x] **CASC-02**: The router falls through to the next engine on hard failure (error/timeout/5xx)
- [x] **CASC-03**: The router falls through on low-confidence output using a multi-signal heuristic (empty/short text, non-printable/garbage ratio, and — when available — ocr.space overlay score)
- [x] **CASC-04**: When no engine clears the threshold, the job returns the best result obtained, marked `low_confidence: true` (never loses the work)
- [x] **CASC-05**: Client selects behavior by named profile (e.g. `fast`/`balanced`/`quality`); an unspecified request uses the default profile
- [x] **CASC-06**: Client can force a specific engine/model, bypassing the cascade (capability-validated escape hatch)
- [x] **CASC-07**: The router skips engines whose API key/config is absent and still serves with whatever engines are present; it fails closed only if zero engines are configured
- [x] **CASC-08**: The cascade is bounded by max-tier, max-attempts, and a cumulative time budget so a request cannot run away in cost/latency
- [x] **CASC-09**: Routing chains, profiles, thresholds, and engine capabilities are declarative config (data), not hard-coded branches

### Input Processing

- [x] **INP-01**: Service accepts raster images (PNG/JPEG/WebP) and routes them through the cascade
- [x] **INP-02**: Input type is determined by authoritative content sniffing (magic bytes), not the client-declared content-type; spoofed/SVG-with-script inputs are rejected
- [x] **INP-03**: Native (text-bearing) PDFs have their embedded text extracted per page without OCR (cheap fast path)
- [x] **INP-04**: Scanned PDFs are rendered to images page-by-page and each page is routed through the cascade
- [x] **INP-05**: Additional image formats (TIFF multipage, HEIC, BMP, GIF) are normalized before routing
- [x] **INP-06**: Multi-page inputs return per-page results with a per-page status rollup; a single failed page does not fail the whole job silently
- [x] **INP-07**: Page rasterization streams one page image in memory at a time and enforces page-count, DPI, and pixel caps (memory-safe, decompression-bomb resistant)
- [x] **INP-08**: Untrusted decode/rasterization runs in a killable, resource-limited subprocess; temporary files are always cleaned up

### Structured Extraction

- [ ] **STR-01**: Client requests `mode=structured` with a schema and receives validated JSON extracted by a vision LLM (ocr.space is excluded by capability)
- [ ] **STR-02**: LLM output is constrained to the schema and validated; invalid output triggers one bounded repair retry before failing with a typed error
- [ ] **STR-03**: Document content is passed to the LLM as delimited data (not instructions), mitigating prompt injection

### Deploy & Operations

- [x] **OPS-01**: The service runs as a Docker/Compose stack on `node:22-bookworm-slim` with the required system packages (`poppler-utils`)
- [x] **OPS-02**: Caddy fronts the service with automatic HTTPS and routes only `/v1/*` publicly
- [x] **OPS-03**: The admin surface binds only to the Tailscale interface, never `0.0.0.0` (fail-closed guard)
- [x] **OPS-04**: In-flight jobs drain on SIGTERM (graceful shutdown) within a bounded window
- [x] **OPS-05**: Requests and jobs are traceable via structured logs with request/job IDs; secrets are never logged
- [x] **OPS-06**: Native-decode dependencies are pinned to CVE-fixed versions (`sharp>=0.35.0`) and scanned in CI

## v2 Requirements

Deferred to a future milestone. Tracked, not in the current roadmap.

### Extended Inputs & Delivery

- **V2-01**: Office documents (docx/pptx) ingestion (convert → PDF pipeline)
- **V2-02**: URL ingestion with SSRF protection (resolve-and-validate IP, block private/link-local/CGNAT, re-check on redirect)
- **V2-03**: Webhook/callback on job completion (in addition to polling)
- **V2-04**: Batch submission endpoint (array of files → array of jobs)
- **V2-05**: Markdown output option when the winning engine is an LLM
- **V2-06**: Local OCR engine (Tesseract/PaddleOCR) as an additional cascade provider
- **V2-07**: Persistent job store (SQLite/disk) for restart-survival of long jobs

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Multi-tenant API keys / per-client quotas / metering | Single shared bearer token is sufficient; a key store + admin CRUD is a whole separate product |
| Unified cross-engine bounding boxes / word overlay in the API | LLM engines can't emit reliable coordinates; a "unified" box schema is a false-consistency promise. ocr.space overlay stays internal (feeds the heuristic) |
| hOCR / ALTO / PAGE XML output | Only classic OCR emits them; pure overhead for a JSON/text/markdown automation audience |
| Web UI / dashboard as the product | API-first; only UI is the inherited Tailscale-bound admin surface |
| Audio / speech recognition | Out of domain — documents only (that is Whisper's job) |
| Streaming partial results (SSE/chunked) | Async polling + `pages_done/total` already covers progressive visibility against a single-concurrency worker |
| Client-tunable per-request confidence thresholds | Exposing internal heuristics as API contract freezes them; profiles encode intent instead |
| Unbounded whole-cascade retries | Stacks latency/cost and masks outages; bounded per-engine retry then fall through |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| API-01 | Phase 1 | Complete |
| API-02 | Phase 1 | Complete |
| API-03 | Phase 1 | Complete |
| API-04 | Phase 1 | Complete |
| API-05 | Phase 1 | Complete |
| API-06 | Phase 1 | Complete |
| API-07 | Phase 1 | Complete |
| API-08 | Phase 1 | Complete |
| JOB-01 | Phase 1 | Complete |
| JOB-03 | Phase 1 | Complete |
| INP-01 | Phase 1 | Complete |
| INP-02 | Phase 1 | Complete |
| OPS-01 | Phase 1 | Complete |
| OPS-02 | Phase 1 | Complete |
| OPS-03 | Phase 1 | Complete |
| OPS-04 | Phase 1 | Complete |
| OPS-05 | Phase 1 | Complete |
| CASC-01 | Phase 2 | Complete |
| CASC-02 | Phase 2 | Complete |
| CASC-03 | Phase 2 | Complete |
| CASC-04 | Phase 2 | Complete |
| CASC-05 | Phase 2 | Complete |
| CASC-06 | Phase 2 | Complete |
| CASC-07 | Phase 2 | Complete |
| CASC-08 | Phase 2 | Complete |
| CASC-09 | Phase 2 | Complete |
| JOB-02 | Phase 2 | Complete |
| JOB-04 | Phase 2 | Complete |
| INP-03 | Phase 3 | Complete |
| INP-04 | Phase 3 | Complete |
| INP-05 | Phase 3 | Complete |
| INP-06 | Phase 3 | Complete |
| INP-07 | Phase 3 | Complete |
| INP-08 | Phase 3 | Complete |
| OPS-06 | Phase 3 | Complete |
| STR-01 | Phase 4 | Pending |
| STR-02 | Phase 4 | Pending |
| STR-03 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 38 total (note: prior summary said 37 — recount of the enumerated REQ-IDs yields 38; corrected here)
- Mapped to phases: 38 ✓
- Unmapped: 0

**Per-phase counts:** Phase 1 = 17 · Phase 2 = 11 · Phase 3 = 7 · Phase 4 = 3

---
*Requirements defined: 2026-07-23*
*Last updated: 2026-07-23 after roadmap creation (traceability populated, count corrected 37→38)*
