# Feature Research

**Domain:** Self-hosted OCR / document-recognition API gateway with multi-engine cascade routing
**Researched:** 2026-07-23
**Confidence:** HIGH (API conventions verified against Textract, Azure Document Intelligence, Google Document AI, Mindee, ocr.space, Mistral OCR, LlamaParse, and OpenAI/Whisper API shape; MEDIUM on niche output-format demand)

> **Legend for reference mapping:**
> - **[REF]** — already implemented in the `test-ocr-qwen3-vl` reference, port as-is
> - **[REF-EXT]** — reference has a foundation, but ocr-router extends it
> - **[NEW]** — net-new work for ocr-router
> - **[SKIP]** — deliberately out of scope (see Anti-Features / PROJECT Out of Scope)

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = the API feels broken, unprofessional, or untrustworthy for automation pipelines (n8n, scripts).

| Feature | Why Expected | Complexity | Notes / Ref Mapping |
|---------|--------------|------------|---------------------|
| Bearer-token auth on all `/v1` routes, fail-closed on missing token | Every OCR API (ocr.space `apikey`, Textract IAM, Mindee token) gates access; unauthenticated OCR is a footgun | LOW | **[REF]** `lib/v1/auth.js` + startup guard. Keep as-is. |
| Sync-or-async submission with `202 + job_id` and `GET /jobs/:id` polling | Textract, Document AI, Azure DI all use async for multi-page docs; n8n consumers expect poll-until-done | MEDIUM | **[REF]** `lib/v1/jobs.js`, `lib/v1/worker.js`. Core shape done. |
| Structured JSON response envelope with terminal states (`queued`/`processing`/`succeeded`/`failed`) + explicit `error` object | Consumers must branch on status; ambiguous states break automation | LOW | **[REF]** Extend envelope with cascade fields ([REF-EXT]). |
| Plain-text output (the actual recognized text) | The one thing every OCR API returns; non-negotiable | LOW | **[REF]** via providers. |
| Per-page results for multi-page inputs (PDF/TIFF) | Textract/DI/Document AI all return page arrays; consumers index by page | MEDIUM | **[NEW]** requires PDF/TIFF pipeline. `pages: [{page, text, engine, confidence}]`. |
| Input format support: common raster images (PNG/JPEG/WebP) | Baseline; a document API that can't take a JPEG is not credible | LOW | **[REF]** image-only today. |
| Input format support: PDF (native text + scanned/rendered) | PDFs are the dominant document format; native-vs-scanned detection is expected of any "document" API | HIGH | **[NEW]** native extraction (fast path, no OCR) + render-per-page → OCR. Heaviest new pipeline. |
| Confidence / quality signal on results | Textract, DI, Google, Mistral OCR all surface per-word/page confidence; consumers gate on it | MEDIUM | **[REF-EXT]** ocr.space overlay score + LLM heuristics. Reference currently discards ocr.space confidence. |
| Language handling (auto-detect default, optional hint) | ocr.space `language`, Textract/DI auto-detect; multilingual docs are common | LOW-MEDIUM | **[NEW]** pass-through hint to ocr.space `language`; LLMs auto-handle. Auto-detect is table stakes, per-language config is not. |
| File-size / page-count limits enforced with clear `413`/`400` error | Every provider caps size (ocr.space 1MB free/5MB paid; Textract 500MB/3000 pg); unbounded upload = OOM/DoS | LOW | **[REF-EXT]** memory guard exists; add explicit limit + error code. |
| Backpressure when overloaded (`503 server_busy` / bounded queue) | Single-concurrency + slow LLMs means overload is real; silent queue growth = OOM | MEDIUM | **[REF]** `lib/v1/worker.js` bounded queue + 503. |
| Health endpoint (`GET /v1/health`) | Liveness/readiness for Docker/Compose, uptime monitors, load balancers | LOW | **[REF]** `lib/v1/health.js`. |
| Capability/model discovery (`GET /v1/models`) | Clients need to know what engines/profiles exist before forcing one | LOW | **[REF]** `lib/models.js`. Extend to expose profiles ([REF-EXT]). |
| Structured logging + request/job IDs for debugging | Self-hosted operators need to trace a failed job; opaque failures are unacceptable | LOW | **[REF]** pino. |
| Graceful shutdown (drain in-flight jobs) | Docker restarts/deploys must not drop or corrupt jobs | LOW | **[REF]** `lib/v1/shutdown.js`. |
| Clear error taxonomy (unsupported type, too large, all-engines-failed, auth) | Automation branches on error codes; generic 500s force human intervention | LOW-MEDIUM | **[REF-EXT]** extend for cascade-exhausted case. |

### Differentiators (Competitive Advantage)

Features that set ocr-router apart. These align directly with the Core Value: *"never fail to return the best available text/data."*

| Feature | Value Proposition | Complexity | Notes / Ref Mapping |
|---------|-------------------|------------|---------------------|
| **Automatic cascade routing with fallback** (ocr.space → Gemini 3 Flash → Gemma 4 31B → Qwen3-VL 235B) | THE product. One call, best result; client never manages keys/engines/retry logic. No commercial API does cheap-classic→LLM escalation in one call | HIGH | **[NEW]** the heart of ocr-router. |
| **Confidence-heuristic fallback trigger** (empty/short text, garbage/non-printable ratio, low overlay score) beyond just hard failure | Escalates on *bad output*, not just errors — the difference between "returned garbage" and "returned the good result" | MEDIUM-HIGH | **[NEW]** ocr.space overlay + text-quality signals. Tuning is the risk (see PITFALLS). |
| **Named routing profiles** (e.g. `fast`, `balanced`, `quality`, `cheap`) | Consumers pick intent, not implementation; decouples client from engine list so you can swap engines without breaking clients | MEDIUM | **[NEW]** builds on reference speed/quality modes. |
| **Full per-job traceability** (engines attempted, winner, per-engine timing, confidence, `low_confidence` flag) | Operators/consumers can audit *why* a result came from a given engine and cost/latency of the cascade — rare transparency | LOW-MEDIUM | **[NEW]** cheap to add once cascade exists; high trust value. |
| **Optional client-forced engine/model override** (escape hatch) | Power users bypass the cascade for a known-good engine; A/B and debugging | LOW | **[REF-EXT]** reference already lets client pick model; wire into router. |
| **Schema-driven structured extraction** (`mode=structured`, JSON schema in → validated JSON out via vision LLM) | Competes with Mindee/Document AI custom extractors but self-hosted and schema-flexible (not fixed to invoice/receipt templates) | HIGH | **[NEW]** LLM + schema validation. Depends on cascade + JSON-output-capable engine. |
| **Cost/quality-aware escalation** (stop at cheapest engine that clears threshold) | Doesn't burn the 235B model when ocr.space suffices — real cost control the client would otherwise hand-build | MEDIUM | **[NEW]** implicit in cascade ordering + threshold. |
| **Graceful degradation when a key/engine is absent** (skip missing engines, still serve) | Self-hosted operators may configure only ocr.space or only Ollama; API keeps working with whatever is present | LOW-MEDIUM | **[REF-EXT]** provider abstraction supports; router must skip-not-fail. |
| **Multi-format normalization** (TIFF multipage, HEIC, BMP, GIF → normalized before routing) | Handles messy real-world inputs (phone HEIC photos, fax TIFF) that many APIs reject outright | MEDIUM | **[NEW]** normalize layer feeds one clean path to the router. |
| Markdown output option for LLM/RAG consumers | LlamaParse/Mistral OCR made markdown the RAG-preferred format; LLM engines produce it natively | LOW-MEDIUM | **[NEW-optional]** cheap when the winning engine is an LLM; harder to synthesize from classic OCR. Offer, don't guarantee, layout fidelity. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem valuable but create disproportionate complexity, scope creep, or false promises for this product.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Bounding boxes / word-level overlay / spatial coordinates in the API response** | Textract/DI/Google all expose them; feels "complete" | Engines disagree on coordinate systems; LLM engines don't emit reliable boxes at all — the cascade would return boxes for some engines and not others, which is worse than none. False consistency promise | Expose ocr.space overlay *internally* for confidence heuristic only. If demanded later, offer per-engine passthrough clearly labeled, not a unified schema. |
| **hOCR / ALTO / PAGE XML output formats** | Digitization/archival crowd expects them; "standards" | Only classic OCR emits them; LLM engines can't. Pure overhead for an automation/n8n audience that wants JSON/text/markdown. Cross-engine consistency impossible | Ship text + JSON + optional markdown. Add hOCR only if a real archival user appears, and only for the ocr.space path. |
| **Multi-tenant API keys / per-client quotas / usage metering / billing** | "SaaS-ready" instinct | Requires a key store, admin CRUD, rate-limit-per-key, dashboards — a whole product. PROJECT explicitly scopes to single shared token | Single shared bearer token now (PROJECT decision). Global rate limit if abuse appears. Revisit only at real multi-consumer need. |
| **Web UI / dashboard as the product** | Nice for demos/non-devs | API-first product; a UI is a second app to build/secure/maintain and dilutes focus | Keep the Tailscale-bound admin surface inherited from reference. Ship OpenAPI/docs for devs. |
| **Local OCR engine bundled in the image (Tesseract/PaddleOCR)** | "No external dependency," offline | Bloats the Docker image, adds native build deps, and the whole architecture is already a provider cascade | PROJECT decision: add later as *just another provider* in the cascade if needed. Not MVP. |
| **Audio / speech / general "AI everything"** | Whisper-style API invites the comparison | Out of domain; documents only. Scope explosion | Explicitly documents-only. |
| **Office docs (docx/pptx) + arbitrary URL ingestion in MVP** | Users have Word files; URL fetch is convenient | URL ingestion = SSRF/attack surface; Office parsing = new format pipeline. Both are post-core | Deferred phase (PROJECT). Land images→PDF→structured first. |
| **Streaming partial results (SSE/chunked page-by-page)** | Feels modern; "see pages as they finish" | Async poll model already covers it; streaming multiplies connection/state complexity against a single-concurrency worker | Per-page results become visible via job polling as pages complete; expose `pages_done/total`. No streaming transport. |
| **Client-tunable per-request confidence thresholds / heuristic weights** | Power users want to tune fallback | Exposes internal heuristics as API contract, freezing them; hard to reason about and support | Profiles encode intent (`fast` vs `quality`). Keep thresholds server-side/config, not per-request API params. |
| **Automatic retries of the *entire cascade* on transient provider errors, unbounded** | "Just make it work" | Can stack latency and cost, and mask systemic outages; against single-concurrency backpressure | Bounded per-engine retry (1 retry, short backoff) inside the cascade step; then fall through to next engine. Fail the job after cascade exhausted. |

## Feature Dependencies

```
[Bearer auth] ──REF, gates──> everything

[Async job model + worker/queue] ──REF──> [Cascade routing]
                                              ├─requires─> [Provider abstraction] (REF: ollama, ocrspace)
                                              ├─requires─> [Confidence heuristic] ──enhances──> [Fallback trigger]
                                              ├─enables──> [Named profiles]
                                              ├─enables──> [Client-forced override] (REF-EXT)
                                              ├─enables──> [Cost/quality escalation]
                                              └─produces─> [Per-job traceability]

[Input normalization layer] ──requires──> [Content sniffing] (REF: lib/v1/sniff.js)
        ├─enables─> [PDF pipeline: native + scanned] ──produces──> [Per-page results]
        └─enables─> [TIFF/HEIC/BMP/GIF support]
                        └──all feed──> [Cascade routing] (one clean path in)

[Structured extraction mode] ──requires──> [Cascade routing]
        ├─requires─> [LLM engine with JSON output] (Gemini/Gemma/Qwen)
        └─requires─> [Schema validation]

[Markdown output] ──requires──> winning engine is an LLM (best-effort, not guaranteed)

[File-size/page limits] ──enhances──> [Backpressure/memory guard] (REF)
[Graceful degradation] ──requires──> [Provider abstraction] + router skip-missing logic
```

### Dependency Notes

- **Cascade routing requires the async job model + provider abstraction:** both exist in the reference; the router is the orchestration layer *on top* of them. This is why the reference foundation is worth porting, not rewriting.
- **Fallback trigger requires the confidence heuristic:** hard-failure fallback is trivial; the *value* (escalate on garbage) depends on the text-quality + overlay heuristic. Ship hard-failure fallback first, layer the heuristic second so the cascade is testable earlier.
- **Per-page results require the PDF/TIFF pipeline:** the response schema must be page-aware *before* multi-page inputs land, or you get a breaking change. Design the envelope for pages from day one even while image-only.
- **Structured extraction requires an LLM engine in the winning path:** it cannot run on ocr.space output alone. It implicitly forces escalation past the classic-OCR tier, which affects cost/latency expectations.
- **Traceability is cheap once the cascade exists** but must be threaded through every engine step — retrofitting it later means touching every provider call. Build it in with the router.
- **Markdown/structured output conflict with a unified cross-engine schema:** they only work well when an LLM wins. Document them as engine-dependent, not universal guarantees.

## MVP Definition

### Launch With (v1) — the core cascade product

- [ ] **[REF]** Port foundation: bearer auth, async jobs, worker/queue + 503 backpressure, health, graceful shutdown, content sniffing, pino logging, Caddy/Tailscale deploy
- [ ] **[NEW]** Cascade routing with hard-failure fallback (ocr.space → Gemini 3 Flash → Gemma 4 31B → Qwen3-VL 235B), skip absent engines
- [ ] **[NEW]** Confidence-heuristic fallback (empty/short/garbage-ratio + optional ocr.space overlay score)
- [ ] **[NEW]** Named routing profiles + client-forced engine override
- [ ] **[NEW]** Per-job traceability (engines attempted, winner, timing, confidence, `low_confidence`)
- [ ] **[REF-EXT]** Page-aware response envelope (works for single image now, multi-page later)
- [ ] **[REF]** Image input (PNG/JPEG/WebP), plain-text + JSON output
- [ ] **[REF-EXT]** File-size/page limits with explicit `413`/`400`

### Add After Validation (v1.x)

- [ ] **[NEW]** PDF pipeline: native text extraction (fast path) + scanned render-per-page → OCR, per-page results — *trigger: cascade proven on images*
- [ ] **[NEW]** Multi-format normalization (TIFF multipage, HEIC, BMP, GIF) — *trigger: real inputs demand it*
- [ ] **[NEW]** Schema-driven structured extraction (`mode=structured`) — *trigger: consumers ask for fields, not just text*
- [ ] **[NEW-optional]** Markdown output for LLM-won results — *trigger: RAG/LLM consumer demand*

### Future Consideration (v2+)

- [ ] Local OCR engine (Tesseract/PaddleOCR) as an additional cascade provider — *defer: image weight; only if offline/cost need appears*
- [ ] Webhook/callback on job completion (vs polling) — *defer: polling suffices for n8n; add if long jobs + many consumers*
- [ ] Batch submission endpoint (array of files → array of jobs) — *defer: clients can loop; add if bulk throughput matters*
- [ ] Office docs (docx/pptx) + URL ingestion — *defer: attack/complexity surface (PROJECT Out of Scope)*
- [ ] Multi-tenant keys / metering — *defer: single token sufficient (PROJECT decision)*
- [ ] Job retention/expiry policy + result TTL cleanup — *defer past MVP but needed before long production run to bound memory/disk*

### Note on job retention (borderline table-stakes)

In-memory jobs must eventually expire or the process leaks memory. A minimal **TTL sweep of completed jobs** (e.g., drop results after N minutes/hours) is closer to table stakes than a differentiator for a long-running self-hosted service — flag it for v1 if jobs live in memory. Persistent job storage (SQLite/disk) is a v1.x concern only if restart-survival is required.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Cascade routing + hard-failure fallback | HIGH | HIGH | P1 |
| Confidence-heuristic fallback | HIGH | MEDIUM-HIGH | P1 |
| Named profiles + forced override | HIGH | MEDIUM | P1 |
| Per-job traceability | MEDIUM-HIGH | LOW-MEDIUM | P1 |
| Page-aware response envelope | MEDIUM | LOW | P1 (design early) |
| File-size/page limits + error taxonomy | MEDIUM | LOW | P1 |
| Graceful degradation (skip missing engines) | MEDIUM | LOW-MEDIUM | P1 |
| Job TTL/expiry sweep | MEDIUM | LOW | P1-P2 |
| PDF pipeline (native + scanned) | HIGH | HIGH | P2 |
| Multi-format normalization (TIFF/HEIC/…) | MEDIUM | MEDIUM | P2 |
| Schema-driven structured extraction | HIGH | HIGH | P2 |
| Markdown output (LLM-won) | MEDIUM | LOW-MEDIUM | P2-P3 |
| Webhook/callback completion | MEDIUM | MEDIUM | P3 |
| Batch endpoint | LOW-MEDIUM | MEDIUM | P3 |
| Bounding boxes (unified) | LOW | HIGH | P3 / anti |
| hOCR/ALTO output | LOW | MEDIUM | P3 / anti |
| Local OCR provider | MEDIUM | HIGH | P3 |

**Priority key:** P1 = must have for launch · P2 = add when possible · P3 = future/nice-to-have

## Competitor Feature Analysis

| Feature | Commercial cloud (Textract / Azure DI / Document AI) | Focused parsers (Mindee / Docparser / ocr.space) | LLM-native (Mistral OCR / LlamaParse) | Our Approach (ocr-router) |
|---------|------------------------------------------------------|--------------------------------------------------|----------------------------------------|---------------------------|
| Submission model | Sync (small) + async batch (multipage) | Sync + webhook (Mindee) | Sync API | **Async `202 + job_id` + poll** (uniform; robust for slow LLMs) |
| Multi-engine fallback in one call | No — single engine per API | No | No | **Yes — automatic cascade** (the differentiator) |
| Confidence scores | Per-word/field | Per-field (Mindee) | Per-word/page (Mistral OCR 4) | **Heuristic + ocr.space overlay**, used to drive fallback and surfaced in trace |
| Bounding boxes | Yes (Blocks/layout) | Partial | Yes (per block) | **Internal-only for heuristic**; not a unified API promise (anti-feature) |
| Output formats | JSON (block/field) | JSON, CSV | Markdown + JSON | **Text + JSON**, markdown when LLM wins; no hOCR/ALTO |
| Structured/key-value/tables | Strong (forms, tables, queries) | Strong templated (invoice/receipt) | Emerging | **Schema-driven via LLM** (flexible, not templated) — v1.x |
| Cost/quality tiering | Fixed per-API pricing | Fixed | Fixed | **Cheapest-engine-that-passes** escalation (built-in cost control) |
| Self-hosted | No (cloud only) | ocr.space self-host limited; others cloud | Cloud/API | **Fully self-hosted, single Docker/Compose + Caddy** |
| Auth/tenancy | IAM / API keys, multi-tenant | API keys | API keys | **Single shared bearer token** (intentional simplicity) |
| Webhooks | SNS/SQS (Textract) | Yes (Mindee) | — | **Polling first**, webhook deferred to v2 |

## Sources

- [AWS Textract / Azure DI / Google Document AI comparison — invoicedataextraction.com (2026)](https://invoicedataextraction.com/blog/aws-textract-vs-google-document-ai-vs-azure-document-intelligence)
- [Google Vision vs AWS vs Azure OCR comparison 2026 — imagetotable.ai](https://imagetotable.ai/blog/google-vs-aws-vs-azure-ocr-2026)
- [Azure AI Document Intelligence processing guide 2026 — signisys.com](https://www.signisys.com/blog/azure-ai-document-intelligence/)
- [Amazon Textract guide 2026 — signisys.com](https://www.signisys.com/blog/amazon-textract-the-complete-guide-to-aws-document-processing/)
- [Mindee Invoice OCR API (webhooks, structured JSON, line items)](https://www.mindee.com/product/invoice-ocr-api)
- [Mindee financial document OCR API](https://www.mindee.com/product/financial-document-ocr-api)
- [Best OCR API 2026 — imagetotable.ai](https://imagetotable.ai/blog/best-ocr-api-2026)
- [Best OCR API — LlamaIndex insights (markdown/JSON output, layout-aware)](https://www.llamaindex.ai/insights/best-ocr-api)
- [Mistral OCR 4 — bounding boxes, per-block type + confidence (explainx.ai, 2026)](https://www.explainx.ai/blog/mistral-ocr-4-bounding-boxes-document-ai-api-2026)
- [Mistral OCR Processor docs — output format conventions](https://docs.mistral.ai/studio-api/document-processing/basic_ocr)
- [Self-hosted PDF OCR API with PaddleOCR — dev.to (job queue, polling, page streaming)](https://dev.to/edgaras/using-a-self-hosted-pdf-ocr-api-with-paddleocr-3k52)
- [API gateway rate limiting patterns — Apache APISIX](https://apisix.apache.org/learning-center/api-gateway-rate-limiting/)
- Domain knowledge: OpenAI/Whisper API response shape (`response_format`), ocr.space params (`OCREngine`, `isOverlayRequired`, `filetype`, `language`), Textract Block model — cross-checked against the above.

---
*Feature research for: self-hosted OCR / document-recognition API gateway with multi-engine cascade routing*
*Researched: 2026-07-23*
