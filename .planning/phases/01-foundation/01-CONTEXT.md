# Phase 1: Foundation - Context

**Gathered:** 2026-07-23
**Status:** Ready for planning
**Mode:** `--auto` (decisions auto-selected from established stack, requirements, and reference implementation per user's autonomous-run instructions)

<domain>
## Phase Boundary

A dockerized, bearer-secured `/v1` HTTP API that accepts a **single raster image** (PNG/JPEG/WebP) and returns OCR text via an **async job model** (`202 + job_id` → poll `GET /v1/jobs/:id`), with a **page-aware response envelope from day one**, deployed behind Caddy with the admin surface Tailscale-bound.

This phase **ports** the mature reference implementation at `/home/luis/proyectos/test-ocr-qwen3-vl` into a new repo, adapting it for (a) the page-aware envelope and (b) the requirements' status/field vocabulary. It does **NOT** build the cascade router (Phase 2), PDF/multi-format input (Phase 3), or structured extraction (Phase 4). A single OCR engine runs per request; the envelope and traceability fields are shaped so Phase 2 can slot the cascade in without a breaking change.

Covers requirements: API-01..08, JOB-01, JOB-03, INP-01, INP-02, OPS-01..05.
</domain>

<decisions>
## Implementation Decisions

### Port strategy
- **D-01:** Port the reference's battle-tested `/v1` modules **as-is with minimal edits** (`lib/v1/auth.js`, `jobs.js`, `worker.js`, `shutdown.js`, `sniff.js`, `health.js`, `errors.js`, `env.js`, `upload.js`, `modes.js`, `router.js`; `lib/logger.js`; providers; `lib/models.js`). Restructure only what the two adaptations below require. Preserve the existing test suite (`node --test`) and its fixes (WR-04/WR-07/WR-08 semantics documented in the reference).
- **D-02:** New repo (already initialized here), not a fork. Copy source files in, do not symlink to the reference.

### Terminal status vocabulary
- **D-03:** Use terminal status **`succeeded`** (not the reference's `completed`) to match REQUIREMENTS API-04 and ROADMAP Phase 1 SC#1. Full status set: `queued` / `processing` / `succeeded` / `failed`. Rename consistently across `jobs.js`, `worker.js`, `shutdown.js`, and all tests. Keep the `finalized`-flag terminal-state guard (WR-04) intact under the new name.

### Page-aware response envelope (JOB-01)
- **D-04:** Job result is a page-aware envelope even for a single image:
  ```json
  "result": {
    "text": "<concatenated page text>",
    "pages": [
      { "page": 1, "text": "<page text>", "engine": "<engine id>", "confidence": null }
    ]
  }
  ```
  Single image ⇒ a **one-element** `pages[]`. Top-level `text` = pages joined by `\n\n`, preserving page order. `engine`/`confidence` per-page fields exist now (populated by the single engine; `confidence` may be `null` in Phase 1) so Phase 2 cascade traceability is additive, not breaking.
- **D-05:** Job-level trace stub: record `engine` used and `created_at`/`started_at`/`completed_at` timestamps now. The richer cascade trace (engines_attempted, per-engine timing, `low_confidence`) is JOB-02, deferred to Phase 2 — envelope leaves room for it.

### Upload contract (INP-01, INP-02, API-07)
- **D-06:** Multipart file field named **`file`** (product accepts "documents", future PDFs) — renamed from the reference's `image`. Accept exactly one file per request. Phase 1 accepts **PNG / JPEG / WebP** only.
- **D-07:** Authoritative type detection by **magic-byte sniff** (`sniff.js`), never the client `Content-Type`. Spoofed types and SVG-with-script are rejected `422 invalid_parameter`. Oversized ⇒ `413 payload_too_large`; unsupported/unsniffable ⇒ `422`. Enforce `multer` `limits.fileSize` and `limits.files=1`.

### Engine selection (pre-cascade)
- **D-08:** Phase 1 has **no cascade**. `model`/`mode` are **optional**; an omitted `model` resolves to a **default engine** (prefer `ocr.space` when `OCR_SPACE_API_KEY` present, else the first configured engine) so a minimal `POST /v1/ocr` with just a file works. Explicit `model` still honored and capability/mode-validated via `modes.js`. `GET /v1/models` lists configured engines + their `modes_supported`/`default_mode`. Fail closed at boot only if **zero** engines are configured.

### Admin / demo surface (OPS-02, OPS-03)
- **D-09:** Port the inherited browser demo/admin surface (`public/index.html` + its non-`/v1` helper routes like `/api/config`). It is the **only** UI (not the product). Caddy exposes **only `/v1/*`** publicly with automatic HTTPS; the admin/demo listener binds to the **Tailscale interface only**, never `0.0.0.0` — enforced by a fail-closed env guard (OPS-03). This surface is the target of the end-of-session Playwright UI evaluation.

### Deploy & ops (OPS-01, OPS-04, OPS-05)
- **D-10:** Docker/Compose stack on **`node:22-bookworm-slim`**; include `poppler-utils` and `tini` in the image now (poppler is needed in Phase 3; installing early keeps the base stable) — but do NOT add `sharp`/PDF code yet. Graceful SIGTERM drain (bounded window) via `shutdown.js`. Structured pino logs carry `request_id`/`job_id`; secrets never logged (keep the redaction verification test).

### Verification tooling
- **D-11:** Test runner is **`node --test`** (port the reference suite, adapted for D-03/D-04/D-06). **No ESLint/TypeScript/typecheck** is configured in the reference and none is added this phase (plain CommonJS JS; adding tooling is out of scope). "Build" = `docker compose build` of the stack. Post-execution verification will run `npm test` + a Docker build smoke check; absence of lint/typecheck is expected and documented, not a failure.

### Claude's Discretion
- Exact module file layout, internal helper naming, and test-file organization follow the reference's structure unless an adaptation forces a change.
- Concatenation separator for multi-page `text` (`\n\n` chosen; a form-feed `\f` is acceptable if a downstream reason emerges).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project intent & scope
- `.planning/PROJECT.md` — product definition, core value, key decisions, out-of-scope boundaries
- `.planning/REQUIREMENTS.md` §API & Auth, §Jobs & Response Envelope, §Input Processing, §Deploy & Operations — the 17 Phase-1 REQ-IDs and their exact contracts
- `.planning/ROADMAP.md` §"Phase 1: Foundation" — goal + 5 success criteria (the acceptance anchor)

### Stack (pinned)
- `CLAUDE.md` §Technology Stack / §Version Compatibility / §"What NOT to Use" — pinned versions and forbidden libraries (Node 22, Express 4.22, multer ^2.2, etc.)

### Reference implementation to port (source of truth for battle-tested modules)
- `/home/luis/proyectos/test-ocr-qwen3-vl/lib/v1/` — `auth.js`, `jobs.js`, `worker.js`, `shutdown.js`, `sniff.js`, `health.js`, `errors.js`, `env.js`, `upload.js`, `modes.js`, `router.js`
- `/home/luis/proyectos/test-ocr-qwen3-vl/lib/` — `logger.js`, `models.js`, `providers/ocrspace.js`, `providers/ollama.js`, `ocr.js`
- `/home/luis/proyectos/test-ocr-qwen3-vl/` — `server.js`, `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `package.json`, `public/index.html`, `test/` (19 test files), `scripts/verify-redaction.js`
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (from the reference)
- **`lib/v1/*` module set**: complete async-job `/v1` API — bearer auth (exempts `/health`), LRU job store with TTL autopurge (JOB-03), single-concurrency `bottleneck` worker + bounded queue with `503 server_busy`/`Retry-After` backpressure (API-08), SIGTERM drain (OPS-04), magic-byte sniff (INP-02), typed errors, env fail-closed guards (API-02).
- **`lib/models.js`**: engine registry with `id`/`provider`/`modes_supported`/`default_mode` — drives `GET /v1/models` and mode validation.
- **`lib/providers/ocrspace.js` + `ollama.js`**: provider adapters (note: `ocrspace.js` currently discards confidence — relevant to Phase 2, not Phase 1).
- **Test suite (`node --test`)**: 19 files + redaction verification — port and adapt.

### Established Patterns
- Fire-and-forget worker scheduling with terminal-state finalization guard (prevents shutdown race overwriting terminal status).
- Reject-before-enqueue queue-depth check so a full queue never holds an extra file buffer (memory-exhaustion guard).
- `intFromEnv` boot-time validation of numeric env vars (fail-fast on typos).

### Integration Points
- `router.js` job-result assembly is where the **page-aware envelope (D-04)** is introduced (wrap single OCR result into `pages[]` + concatenated `text`).
- `jobs.js`/`worker.js`/`shutdown.js` status strings are where **`completed`→`succeeded` (D-03)** rename lands.
- `upload.js`/`router.js` multipart field is where **`image`→`file` (D-06)** rename lands.
</code_context>

<specifics>
## Specific Ideas

- Envelope, status vocabulary, and field name follow REQUIREMENTS/ROADMAP wording exactly where it diverges from the reference (the reference is the implementation source, the planning docs are the contract source).
- Install `poppler-utils` in the Docker base now even though it's unused until Phase 3, to avoid a base-image change mid-project.
</specifics>

<deferred>
## Deferred Ideas

- **Cascade router / automatic fallback / JOB-02 full trace** — Phase 2.
- **PDF (native + scanned), TIFF/HEIC/BMP/GIF normalization, `sharp`, subprocess sandboxing, OPS-06 CVE pinning** — Phase 3.
- **`mode=structured` schema extraction** — Phase 4.
- **`ocrspace.js` overlay/confidence enablement** — Phase 2 (heuristic input).
- None outside phase scope surfaced during analysis.
</deferred>

---

*Phase: 1-Foundation*
*Context gathered: 2026-07-23*
