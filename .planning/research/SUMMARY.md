# Project Research Summary

**Project:** ocr-router
**Domain:** Dockerized OCR / document-recognition API gateway with automatic cascade routing (ocr.space → Ollama Cloud vision LLMs) + multi-format input normalization
**Researched:** 2026-07-23
**Confidence:** HIGH

## Executive Summary

`ocr-router` is a self-hosted, bearer-secured `/v1` HTTP API that takes a document (image, PDF, later more formats) and internally walks an ordered cascade of recognition engines — cheap/fast `ocr.space` first, then progressively higher-quality Ollama Cloud vision LLMs — falling back on hard failure *or* low-confidence output until it returns the best result any configured engine can produce. Research is unusually well-grounded because a mature reference implementation (`test-ocr-qwen3-vl`) already ships the entire foundation (bearer auth, async job model, single-concurrency worker + bounded queue, backpressure, graceful shutdown, content sniffing, provider abstraction, Caddy/Tailscale deploy). The genuinely new work is **two layers**: a cascade routing engine and a multi-format input-normalization pipeline. The strong recommendation across all four research tracks is to **port the foundation verbatim and slot the two new layers into the seam the reference already exposes** (`worker → runOCR(model, image)`), rather than rewrite anything.

The recommended approach builds bottom-up by dependency: port the foundation (delivers image OCR immediately), then build the cascade on a *single image* (the core differentiator, requiring no heavy new dependencies), then add the input pipeline (extra image formats, then PDF native-text short-circuit, then scanned rasterization), and finally structured extraction as a thin increment on the finished cascade. Architecturally the winning patterns are: a **pure, injectable cascade orchestrator** (chain-walk with injected `runEngine` + `evaluate`, so fallback policy is unit-testable with fakes); **profiles + engine capabilities as data** instead of `if`-branches for structured/forced-model routing; a **lazy async page iterator** that keeps exactly one rendered page in memory; and **providers report raw signals, evaluators judge quality**. Stack-wise the 2025 standard is `unpdf` (serverless PDF.js, no Node floor) for native PDF text, `poppler-utils` `pdftoppm` for memory-frugal page-by-page rasterization, `sharp` (prebuilt libvips, no apt) for image normalization, `heic-convert` (WASM) for HEIC, and `zod` v4 native `z.toJSONSchema()` → Ollama `format` constrained decoding for structured mode. The base image should move off EOL Node 20 to `node:22-bookworm-slim`.

The dominant risks are all concentrated in the two new layers and are well-catalogued. Memory is the sharpest: the single-concurrency queue was sized for `bytes_received ≈ buffer.length`, but PDF rasterization is a decompression step (a 20-page PDF at 300 DPI ≈ 500 MB of bitmaps), so page-by-page streaming with page/DPI/pixel caps is mandatory from day one, not a later optimization. Cost/latency runaway is the second: if the confidence gate is too permissive (or ocr.space is down/unconfigured), *every* request escalates to the slow, quota-hungry Qwen3-VL 235B — so max-tier/attempt/time/budget caps and instrumentation must be built *with* the router. The subtlest is "false good" — ocr.space returning confident garbage — which directly attacks the core promise and demands a multi-signal quality score (length, non-printable ratio, gibberish/language plausibility, plus optional overlay confidence), not a length check. Untrusted-input decode CVEs (libvips 2026 advisories, PDF/image bombs), hung native calls with no abort, temp-file leakage, and non-schema LLM output round out the critical list; each maps cleanly to a phase.

## Key Findings

### Recommended Stack

Keep every reference dependency (express 4.22, multer 2.2, bottleneck, pino, lru-cache, axios) — they remain current best practice; only add libraries for the two *new* subsystems and bump the base image off EOL Node 20. The input pipeline gets four new libraries plus one system package (`poppler-utils`); image processing and HEIC need **no** apt packages because `sharp` bundles libvips and `heic-convert` is WASM. Structured mode is driven by one Zod schema serving as both the LLM contract and the validator. Full detail in `STACK.md`.

**Core technologies (new capabilities):**
- `unpdf@^1.6.2`: native PDF text extraction (per-page) — serverless PDF.js bundle, no Node-version floor, no native deps; enables the cheap "skip OCR" short-circuit.
- `poppler-utils` `pdftoppm` (Debian 24.x): scanned-PDF rasterization — industry OCR standard, renders **page-by-page** (bounded peak memory), controllable DPI; spawn as a killable subprocess.
- `sharp@^0.35.3`: image normalization (TIFF multipage, WebP, GIF, resize, grayscale, DPI) — prebuilt libvips, no apt; pin `>=0.35.0` for 2026 CVE fixes; cannot decode HEIC/BMP.
- `heic-convert@^2.1.0`: HEIC/HEIF decode → hand to sharp — pure-JS WASM, zero system deps, avoids HEVC patent/build pain.
- `zod@^4.4.3`: schema + validation for `mode=structured` — native `z.toJSONSchema()` feeds Ollama's `format` param for constrained decoding.
- Base image: `node:22-bookworm-slim` (Node 20 is EOL; Debian slim is low-friction for poppler + prebuilt sharp).

### Expected Features

The product identity is **automatic cascade routing with fallback** — no commercial API does cheap-classic→LLM escalation in one call, and it aligns exactly with the Core Value ("never fail to return the best available text/data"). Most table stakes are already in the reference and only need porting; the differentiators are almost all NEW. Full detail in `FEATURES.md`.

**Must have (table stakes, mostly [REF] port):**
- Bearer auth fail-closed on all `/v1` routes — every OCR API gates access.
- Async `202 + job_id` + `GET /jobs/:id` polling — n8n/automation consumers expect it.
- Structured JSON envelope with terminal states + explicit error taxonomy — consumers branch on status/error codes.
- Image input (PNG/JPEG/WebP) + plain-text output — non-negotiable baseline.
- File-size/page limits (`413`/`400`), backpressure `503`, health endpoint, graceful shutdown — operational credibility.
- **Page-aware response envelope designed from day one** (even while image-only) — avoids a breaking change when multi-page lands.

**Should have (differentiators, mostly [NEW]):**
- Cascade routing with hard-failure fallback (ocr.space → Gemini 3 Flash → Gemma 4 31B → Qwen3-VL 235B), skip absent engines — THE product.
- Confidence-heuristic fallback (empty/short/garbage-ratio + optional overlay score) — escalate on *bad output*, not just errors.
- Named routing profiles (`fast`/`balanced`/`quality`) + client-forced override — intent over implementation.
- Full per-job traceability (engines attempted, winner, timing, confidence, `low_confidence`) — cheap once cascade exists, high trust value.
- Graceful degradation when a key/engine is absent; schema-driven structured extraction; multi-format normalization.

**Defer (v1.x / v2+):**
- PDF pipeline + multi-format normalization + structured extraction are P2 (add after cascade is proven on images).
- Markdown output (LLM-won only), webhooks, batch endpoint, local OCR provider, Office docs/URL ingestion, multi-tenant keys — v2+.
- **Anti-features to actively avoid:** unified cross-engine bounding boxes / hOCR / ALTO (LLM engines can't emit them — false consistency), streaming partial results, client-tunable heuristic thresholds, unbounded whole-cascade retries.
- **Borderline table-stakes:** a job-TTL sweep of completed jobs belongs in v1 (in-memory jobs leak otherwise).

### Architecture Approach

Two new layers wrap the reference's existing seam without rewriting it: today `worker.js` calls `runOCR(model, image)` once with one client-chosen model; the **cascade engine** replaces that single call with an ordered chain-walk (sits above `lib/ocr.js`, below the worker), and **input normalization** sits before routing inside the worker's job body, turning any upload into a lazy sequence of page units. Everything else is ported verbatim. `lib/ocr.js` stays the *single* provider seam — the cascade calls providers only through it, never reaching into `lib/providers/*`. Full detail in `ARCHITECTURE.md`.

**Major components:**
1. `lib/cascade/engine.js` — pure, injectable chain-walk: per engine `runEngine → evaluate`, fall through on hard-fail OR low-confidence, record every attempt, return winner or best+`low_confidence`. Unit-testable with a fake `runEngine`.
2. `lib/cascade/profiles.js` + `chains.js` + `quality.js` — declarative config (named profiles → chain + thresholds + task + evaluatorId) and pluggable evaluators (text-heuristic, schema-validator). Config is separated from mechanism.
3. `lib/input/` (`sniff`, `normalize`, `pdf`, `image`) — container-type magic-byte detection → async page iterator yielding discriminated units `{kind:'text'}` (skip OCR) | `{kind:'image'}` (→ cascade); **one page buffer in flight**.
4. `lib/models.js` engine registry — each engine gets `kind` (classic-ocr | vision-llm) + `capabilities` (text, structured) so ocr.space is auto-excluded from structured chains by data, not `if`-branches.
5. Ported verbatim: `lib/v1/*` (router, worker, jobs, auth, health, shutdown, upload) + `lib/providers/*`.

**Key decision — page-array-in-one-job, NOT sub-jobs:** the worker is `maxConcurrent:1`, so per-page sub-jobs buy zero parallelism and only multiply queued buffers + fragment UX. One job record accumulates *text results* (KB), never an array of page *images* (MB each).

### Critical Pitfalls

Top risks from `PITFALLS.md` (16 total; these are the ones that break the product if missed):

1. **PDF rasterization blows the memory budget** — the queue holds full buffers, and rasterization decompresses (20 pages @300 DPI ≈ 500 MB). Render page-by-page, free before next; cap page count (`pdfinfo` first), cap DPI (150–200), bound pixels. *Design the page-streaming contract before writing the PDF provider.*
2. **Cost/latency runaway — every request escalates to the 235B model** — if the gate is too strict or ocr.space is down, all jobs hit the slowest/quota-hungriest engine. Build max-tier/max-attempts/cumulative-time/global-budget caps + per-job escalation metrics *with* the router; degrade to best-so-far + `low_confidence`.
3. **False "good" — ocr.space returns confident garbage and stops early** — length-only checks pass gibberish/wrong-language/partial reads. Build a multi-signal score (length-vs-area, non-printable ratio, gibberish/language plausibility, + optional overlay confidence via `isOverlayRequired:true`); per-engine/per-language thresholds.
4. **Untrusted decode = DoS/RCE** — libvips 2026 CVEs (TIFF/GIF/HEIC) + PDF/image bombs; one bad file DoSes a single-concurrency service. Pin `sharp>=0.35.0`, CVE-scan the image in CI, run decode/rasterize in a **killable subprocess** with pixel/page/memory/time limits, `limitInputPixels`/`failOn`.
5. **Hung native/HTTP calls wedge the sole worker slot** — reference Ollama axios call has **no abort**. Establish one authoritative `JOB_TIMEOUT_MS`, wire an `AbortController` through fetch + subprocess `kill()`, actually abort on shutdown.

Also material and phase-mapped: temp-file leakage (`finally` cleanup + sweeper + tmpfs), non-schema LLM output (constrained decoding + Ajv/Zod validate + one repair retry + null-allowing schema), content-type spoofing/SVG (sniff + allowlist, reject SVG), prompt injection (delimit content as data + constrained output), image/token truncation (right-size before vision LLM), job-store growth/TTL, graceful degradation (assemble cascade from configured engines at boot, fail closed if zero), and SSRF in the deferred URL phase (reserve the seam now).

## Implications for Roadmap

Research strongly converges on a **dependency-ordered, low-to-high-dependency build**. The reference foundation is worth porting, not rewriting, and the cascade should be built on plain images *before* the heavy input pipeline. Suggested phase structure:

### Phase 1: Foundation (port)
**Rationale:** Everything imports jobs/worker/providers/models; it's battle-tested and delivers value immediately. Port verbatim — no new heavy dependencies.
**Delivers:** Dockerized bearer-secured `/v1` API, async jobs + single-concurrency worker + bounded-queue backpressure (503), health, graceful shutdown, content sniffing, pino, Caddy/Tailscale deploy, image (PNG/JPEG/WebP) OCR with a client-chosen model. **Move base image to `node:22-bookworm-slim`.**
**Addresses:** All table-stakes [REF] features; **page-aware response envelope designed here** even while image-only.
**Avoids:** Content-type spoofing (Pitfall 11 — verify sniff is authoritative), job-store sizing baseline (14).

### Phase 2: Cascade Router
**Rationale:** The core differentiator and most test-sensitive logic. Operates on *one image* — the exact unit the ported foundation produces — so it needs **no new heavy deps** and delivers "never fail to return the best result" on plain images first. Building it here lets the later input pipeline plug per-page images into an already-proven router.
**Delivers:** Injectable pure `runCascade` chain-walk, hard-failure + confidence-heuristic fallback, named profiles + forced-model override (capability-validated), full per-job traceability, graceful degradation (assemble cascade from configured engines at boot), job-TTL sweep.
**Uses:** No new libs (reuses reference providers). Early task: enable ocr.space overlay confidence in `ocrspace.js`.
**Implements:** `lib/cascade/{engine,profiles,chains,quality}.js`; engine registry `kind`+`capabilities`.
**Avoids:** Cost runaway (6 — caps + metrics), false-good garbage (7 — multi-signal score), retry loops (8 — bounded attempts + error classification), hung calls (3 — unified deadline + abort), provider degradation (15).

### Phase 3: Input Pipeline
**Rationale:** Third by PROJECT's own phasing and by surface area. Sub-sequence: (a) extra image formats → PNG (self-contained, one sharp-class dep), then (b) PDF native-text extraction (cheap skip-OCR path, `unpdf`) before (c) scanned rasterization (heavier `pdftoppm` subprocess). Introduces worker fan-out + `jobs.js` `pages[]` schema.
**Delivers:** Multi-format normalization (TIFF multipage, HEIC, BMP, GIF), PDF native + scanned pipeline, per-page results via the lazy async page iterator.
**Uses:** `unpdf`, `poppler-utils`/`pdftoppm`, `sharp>=0.35.0`, `heic-convert`.
**Implements:** `lib/input/{sniff,normalize,pdf,image}.js`; lazy page iterator (Pattern 3).
**Avoids:** Memory blowup (1 — page-by-page streaming, page/DPI/pixel caps), decode bombs + libvips CVEs (2, 4 — killable sandboxed subprocess, sharp pin, CVE scan), temp-file leakage (5), multi-page partial failure (9 — per-page status rollup), image/token sizing (13). **Reserve the input-acquisition seam for the later URL phase (16).**

### Phase 4: Structured Extraction
**Rationale:** A thin increment on the finished cascade — add `capabilities:['structured']` to vision engines, a `structured` profile, a `schema` evaluator, and a JSON/`format` prompt path in `providers/ollama.js`. Reuses `runCascade` unchanged; ocr.space is excluded by capability data.
**Delivers:** `mode=structured` — Zod schema in → constrained-decoded, validated JSON out via vision LLM.
**Uses:** `zod` v4 `z.toJSONSchema()` → Ollama `format` param.
**Avoids:** Non-schema LLM output (10 — constrained decoding + validate + one repair retry + null-allowing schema), prompt injection (12 — delimit content, constrain output), token truncation (13).

### Phase 5 (v2+): Deferred — Office docs / URL ingestion, local OCR provider, webhooks, batch
**Rationale:** Post-core; more attack/complexity surface (PROJECT Out of Scope). URL ingestion in particular carries SSRF risk against the Tailscale-bound admin surface.
**Avoids:** SSRF (16 — resolve-and-validate IP, block private/link-local/CGNAT, re-check on redirect).

### Phase Ordering Rationale

- **Dependency order is the spine:** foundation → cascade (one image, low-dep) → input pipeline (per-page images into proven router) → structured (thin increment on cascade). Building the cascade before the input pipeline was explicitly weighed against the reverse and chosen because the cascade is the core value *and* the lower-dependency layer.
- **The page-aware envelope must be designed in Phase 1** even while image-only, or multi-page (Phase 3) forces a breaking change — a cross-phase constraint the roadmap must honor.
- **Pitfall prevention is front-loaded into the phase that owns it:** memory streaming, subprocess sandboxing, and CVE scanning are Phase 3 design contracts (not later optimizations); cost caps + the confidence heuristic are Phase 2 core design (not a post-ship tuning pass).

### Research Flags

Phases likely needing deeper research during planning (`/gsd:plan-phase --research-phase`):
- **Phase 2 (Cascade Router):** the confidence heuristic is the hardest-to-tune, highest-risk logic (false-good garbage detection, per-engine/per-language thresholds, gibberish/entropy scoring). Warrants a focused spike on quality-scoring approaches + a small labeled calibration sample.
- **Phase 3 (Input Pipeline):** subprocess sandboxing mechanics (ulimit/cgroup memory caps, killability), HEIC-in-Docker (verify base image bundles patched libheif), and the exact native-vs-scanned PDF decision heuristic. STACK named libraries but the sandboxing + Docker-packaging details need validation.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** verbatim port of a mature reference — no research needed beyond reading the source.
- **Phase 4 (Structured Extraction):** well-documented pattern (Zod v4 → Ollama `format` → validate + retry) already fully specified in STACK.md.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions verified against npm registry + official docs on 2026-07-23; a few ecosystem judgments (bottleneck longevity, mupdf alternative) marked MEDIUM inline. |
| Features | HIGH | API conventions cross-checked against Textract, Azure DI, Document AI, Mindee, ocr.space, Mistral OCR, LlamaParse; MEDIUM only on niche output-format demand (hOCR/markdown). |
| Architecture | HIGH | Grounded in direct reading of the reference source; MEDIUM only on specific input-pipeline library choices, which STACK resolves. |
| Pitfalls | HIGH | Grounded in the reference codebase + current CVE/rate-limit sources; a few LLM-behavior items (hallucination long-tail) are MEDIUM. |

**Overall confidence:** HIGH — unusually so, because a mature reference implementation anchors the foundation and the new work is well-scoped to two layers.

### Gaps to Address

- **Confidence-heuristic tuning (Phase 2):** no amount of research substitutes for calibration on real documents. Plan a small labeled sample to set per-engine/per-language thresholds; instrument escalation distribution from day one and treat P50-reaching-top-tier as a bug signal.
- **Subprocess sandboxing details (Phase 3):** the *approach* is clear (killable subprocess with limits) but the concrete mechanism (ulimit vs cgroup vs sidecar `--memory`, clean kill wiring) needs validation against the target VPS/Docker setup.
- **HEIC in the Docker image (Phase 3):** `heic-convert` is WASM/self-contained, but verify decode actually works *in-container* on real phone HEIC; gate behind a feature flag if fragile.
- **Ollama Cloud quota behavior (Phases 2/3):** limits reset on 5h/7-day windows (not hourly) and burn fastest on the 235B model — the global budget cap design depends on real quota numbers for the subscription tier, which should be confirmed during Phase 2 planning.
- **ocr.space overlay confidence (Phase 2):** the reference discards it; enabling `isOverlayRequired:true` is a concrete `ocrspace.js` change whose signal quality should be validated before the heuristic depends on it (the MVP text-quality signals need no provider change and can ship first).

## Sources

### Primary (HIGH confidence)
- Reference codebase `test-ocr-qwen3-vl` (`lib/v1/*`, `lib/providers/*`, `lib/ocr.js`, `lib/models.js`) — architecture seam, memory model, provider gaps (Ollama no-abort, ocr.space discarded confidence).
- `.planning/PROJECT.md` — scope, engine tiers, phasing decisions, constraints.
- npm registry (`npm view`, 2026-07-23) — verified versions + `engines`: unpdf 1.6.2, sharp 0.35.3 (+libvips 1.3.2), heic-convert 2.1.0, zod 4.4.3, pdfjs-dist 6.1.200 (Node >=22.13), multer 2.2.0, etc.
- sharp/libvips security advisories GHSA-f88m-g3jw-g9cj, GHSA-523x-vhfw-6r76 (2026 CVEs, fixed in sharp 0.35.0 / libvips 8.18.3).
- docs.ollama.com (structured outputs `format` param, incl. vision) + zod.dev (native `toJSONSchema`); Node.js release schedule (Node 20 EOL).

### Secondary (MEDIUM confidence)
- Commercial OCR feature comparisons — Textract / Azure DI / Google Document AI / Mindee / Mistral OCR / LlamaParse (invoicedataextraction.com, imagetotable.ai, signisys.com, llamaindex.ai).
- PDF text-extraction option comparisons (unpdf vs pdf-parse vs pdfjs-dist; Nutrient PDF.js guide); node-poppler, @hyzyla/pdfium, MuPDF.js rasterization docs.
- ocr.space free-tier limits (~500 req/day, file-size caps); Ollama Cloud limits (5h/7-day resets, usage levels, 90% quota email).
- Vision-LLM structured-extraction / hallucination / constrained-decoding practices; `@pdfme/pdf-lib` decompression-bomb advisory; OWASP SSRF guidance applied to Tailscale/CGNAT.

### Tertiary (LOW confidence)
- None material — all findings trace to primary source reading or multi-source secondary consensus.

---
*Research completed: 2026-07-23*
*Ready for roadmap: yes*
