# ocr-router

## What This Is

`ocr-router` is a dockerized document-recognition service exposed as an HTTP API (`/v1`, bearer-token secured, Whisper-style). A client submits a file — image, PDF, and later other formats — and the service **routes each request internally through an ordered cascade of recognition engines** (the cheap/fast `ocr.space` first, then cloud vision LLMs of increasing quality), automatically falling back up the chain until it produces a usable result. The client never has to know which engine ran; it can optionally force a model or pick a named profile.

It is for developers and automation pipelines (n8n and similar) that need reliable text/data extraction from documents without hand-managing multiple OCR providers, keys, and fallback logic.

## Core Value

**Never fail to return the best available text/data for a document.** The cascade escalates quality automatically so a single API call always yields the best result any configured engine could produce — that reliability is the product.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. -->

- [ ] Dockerized service with a bearer-token-secured `/v1` HTTP API (single shared token, Whisper-style)
- [ ] Async job model: `POST /v1/ocr` → `202 + job_id`, poll `GET /v1/jobs/:id` for result
- [ ] Automatic cascade routing with fallback across engines (ocr.space → cloud vision LLMs)
- [ ] Fallback triggered on hard failure (error/timeout/5xx) OR low-confidence heuristic (empty/short text, high garbage ratio, low ocr.space overlay score)
- [ ] Named routing profiles + optional client-forced model
- [ ] Full traceability per job: engines attempted, winner, timing, confidence, `low_confidence` flag when nothing passed threshold
- [ ] Input support: raster images (PNG/JPEG/WebP)
- [ ] Input support: PDFs — native (embedded text extraction) and scanned (render per page → OCR), per-page results
- [ ] Input support: additional image formats (TIFF multipage, HEIC, BMP, GIF) normalized before routing
- [ ] Structured extraction mode (`mode=structured`): schema-driven JSON via cloud vision LLM, validated
- [ ] Deploy stack: Caddy reverse proxy + automatic HTTPS, admin surface bound to Tailscale only, graceful shutdown, backpressure (503 server_busy)

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Local OCR engine inside the container (Tesseract/PaddleOCR) — deferred; keeps the image light for now. Can be added later as just another provider in the cascade.
- Multi-tenant API keys, per-client quotas/metering — single shared token is enough for the initial product; adds a key store and management surface not yet needed.
- Office documents (docx/pptx) and URL ingestion — real value but more attack/complexity surface; a later phase after the core cascade + PDF pipeline are solid.
- Audio/speech recognition — out of domain (that is Whisper's job); ocr-router is documents only.
- Web UI / dashboard as the product — API-first; the only UI is the existing Tailscale-bound admin surface inherited from the reference.

## Context

- **Reference implementation to reuse:** `/home/luis/proyectos/test-ocr-qwen3-vl` — a mature Node/Express service that already implements much of the foundation and is the source of battle-tested modules to port:
  - `/v1` API with bearer auth (`lib/v1/auth.js`), async jobs (`lib/v1/jobs.js`), single-concurrency worker + queue with backpressure (`lib/v1/worker.js`), graceful shutdown (`lib/v1/shutdown.js`), content sniffing (`lib/v1/sniff.js`), health (`lib/v1/health.js`), structured logging (pino).
  - Provider abstraction (`lib/providers/ollama.js`, `lib/providers/ocrspace.js`) and a model registry with speed/quality modes (`lib/models.js`).
  - Deploy stack: `Dockerfile`, `docker-compose.yml`, `Caddyfile` (public 80/443 → only `/v1/*`; admin bound to `${TAILSCALE_IP}:8780`), env fail-closed guards, solid test suite (`node --test`).
- **Available recognition engines:** `ocr.space` (classic OCR, cheap/fast) + Ollama Cloud vision LLMs via subscription — Gemini 3 Flash (fast), Gemma 4 31B (balanced), Qwen3-VL 235B (max quality). These form the natural quality tiers of the default cascade.
- **What the reference does NOT do yet (the new work):** it only accepts images and the client picks the model by hand — there is no cascade/fallback router and no PDF/multi-format input pipeline. Those two new layers (routing engine + input normalization) are the heart of ocr-router.
- **Known detail:** `lib/providers/ocrspace.js` currently discards confidence (does not request `isOverlayRequired`), so the low-confidence heuristic will rely mainly on text-quality signals (length, garbage/non-printable ratio) plus optionally enabling overlay for a per-word score.

## Constraints

- **Tech stack**: Node.js + Express — reuse the proven reference base rather than rewrite. Keeps the door open to add a local engine later as a provider.
- **Security**: Bearer token required on all `/v1` routes (fail-closed startup guard if `API_TOKEN` is missing/placeholder); admin surface never on `0.0.0.0` — Tailscale-bound only.
- **Deployment**: Must run as a Docker/Compose stack with Caddy + automatic HTTPS, self-hosted on a VPS.
- **External dependencies**: ocr.space API key (optional) and Ollama Cloud API key (subscription) supplied via env; service must degrade gracefully when a key is absent.
- **Resource**: Single-concurrency worker with a bounded in-memory queue (memory-exhaustion guard — each queued job holds its file buffer); adding PDF rasterization increases per-job memory, so page-level processing must be mindful of buffers.

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| New repo reusing reference modules (not fork, not rewrite) | Clean product identity while keeping battle-tested auth/jobs/worker/deploy; stays on proven Node stack | — Pending |
| Automatic cascade routing with fallback (client can override) | Core differentiator vs the reference; reliability without the client managing engines | — Pending |
| Fallback = hard failure + confidence heuristic | Balances cost (don't always escalate) against quality (don't accept garbage) | — Pending |
| Async job API (202 + job_id + polling) | Robust for large PDFs and slow LLMs; matches n8n/queue consumers and the reference | — Pending |
| Single shared bearer token (no multi-tenant) | Sufficient for own/trusted use; avoids key-store complexity in the MVP | — Pending |
| No local OCR engine yet (ocr.space + cloud LLMs) | Keep Docker image light; add Tesseract/Paddle as a provider later if needed | — Pending |
| Phase inputs: images → PDF/multi-format → structured → Office/URLs | All four input types at once is too big for one spec; sequence by value and surface area | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-23 after initialization*
