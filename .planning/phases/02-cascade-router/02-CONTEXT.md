# Phase 2: Cascade Router - Context

**Gathered:** 2026-07-23
**Status:** Ready for planning
**Mode:** `--auto` (decisions auto-selected from requirements, ROADMAP success criteria, STATE risk-flags, and the Phase 1 codebase per the autonomous-run instructions)

<domain>
## Phase Boundary

Every image request automatically **escalates through an ordered chain of engines**, returning the best result any configured engine can produce — with full traceability, bounded cost/latency, and graceful degradation. This is the product's core value, proven on plain images (still image-only; PDF/multi-format is Phase 3).

Builds on Phase 1's `/v1` API, page-aware envelope, worker, and `lib/v1/engines.js` helper. The 4 cascade engines already exist in `lib/models.js` (`ocrspace-engine2`, `ollama-gemini-3-flash`, `ollama-gemma4-31b`, `ollama-qwen3-vl-235b`). This phase adds the routing/heuristic/config/trace/timeout layer over them.

Covers: CASC-01..09, JOB-02, JOB-04. Does NOT add PDF/multi-format (Phase 3) or structured mode (Phase 4).
</domain>

<decisions>
## Implementation Decisions

### Declarative cascade config (CASC-09)
- **D-01:** Routing is **data, not branches**. A single config module (`lib/v1/cascade/config.js`) declares: the ordered default **chain** (engine ids `['ocrspace-engine2','ollama-gemini-3-flash','ollama-gemma4-31b','ollama-qwen3-vl-235b']`), the **engine capability table** (provider, modes, whether it emits a confidence signal), the named **profiles**, and the **confidence thresholds/bounds**. Adding/reordering an engine or tuning a threshold is a config edit, never a code branch. The heuristic reads its thresholds from here.

### Confidence heuristic (CASC-03 — highest-risk logic)
- **D-02:** Fall-through-on-low-confidence uses a **multi-signal heuristic** combining: (a) **text length** (empty or below a min-char floor → low), (b) **garbage/non-printable ratio** (fraction of non-printable / replacement / control chars over the text → high ratio = low), and (c) when available, the **ocr.space overlay score** (per-word/mean confidence). Signals combine to a normalized `confidence ∈ [0,1]` compared against the profile's threshold. Thresholds live in D-01 config. Research MUST propose concrete starting thresholds and a tiny labeled clean-vs-garbage fixture set to calibrate; keep the logic pure + unit-tested with synthetic clean/garbage/empty inputs (STATE risk-flag).
- **D-03:** Enable the **ocr.space overlay** (`isOverlayRequired=true`) so the classic-OCR tier contributes a real confidence signal (PROJECT "known detail"). LLM engines emit no reliable score → their confidence derives from the text-quality signals (a) + (b) only. Overlay data stays **internal** to the heuristic (never in the public API — per REQUIREMENTS out-of-scope on unified overlay).

### Cascade execution + fall-through (CASC-01, CASC-02, CASC-04)
- **D-04:** The runner walks the chain in order and returns the **first** result that clears the profile threshold. It falls through on **hard failure** (error / timeout / 5xx) AND on **low confidence**. When **no** engine clears the threshold, it returns the **best result obtained** (highest confidence seen) marked `low_confidence: true` — never loses the work. Track best-so-far across attempts.
- **D-05:** On a clean document the cascade **stops at the cheap first tier** (ocr.space) — the P50 winner must not be the top tier (ROADMAP SC#1). The heuristic threshold must therefore accept genuinely-good classic OCR without escalating.

### Profiles & forced engine (CASC-05, CASC-06)
- **D-06:** Named profiles, declarative: `fast` (cheap/short chain, stop early — e.g. ocr.space→gemini), `balanced` (default; chain through gemma), `quality` (full chain to qwen3-vl-235b). An unspecified request uses **`balanced`** (the default). Profiles select the chain slice + threshold, not per-request tunable thresholds (REQUIREMENTS out-of-scope). Expose profiles via `GET /v1/models` (profiles discovery — completes API-05).
- **D-07:** A client can **force** a specific engine/model, **bypassing the cascade** (runs that engine only). Forcing an engine that lacks the required capability is rejected with a **typed error** (capability-validated escape hatch). Phase-1's forced-model path + the HR-01 fail-closed-on-missing-key guard are the foundation; extend to "forced ⇒ no cascade."

### Bounds, timeout, graceful degradation (CASC-07, CASC-08, JOB-04)
- **D-08:** The cascade is bounded by **max-tier**, **max-attempts**, and a **cumulative time budget** (config, D-01) so no request runs away in cost/latency. A single **authoritative job timeout** (JOB-04) via `AbortController`/deadline aborts a hung provider/subprocess rather than wedging the single-concurrency worker; per-engine provider timeouts are subordinate to the job deadline.
- **D-09:** Assemble the chain at request time from **only** engines whose provider key is present (`providerKeyPresent` from `lib/v1/engines.js`) — a **missing key is a clean tier drop**, not a per-request error. Serve with whatever engines are present. Fail closed only if **zero** engines are configured (Phase-1 boot guard already enforces this).

### Traceability (JOB-02)
- **D-10:** Each job records a full cascade **trace**: `engines_attempted[]` (each: engine id, per-engine timing ms, confidence, outcome=passed|low_confidence|failed), the **winning engine**, and the **`low_confidence`** flag when nothing cleared threshold. Attach to the result envelope, extending Phase-1's D-05 trace stub. Per-page `engine`/`confidence` fields (from Phase-1 D-04) are populated by the winning engine.

### Worker integration
- **D-11:** The worker's single-engine call is replaced by the **cascade runner** when no model is forced (forced model → single engine, bypass). The page-aware envelope is unchanged; for a single image the one page's `text`/`engine`/`confidence` come from the winning engine, top-level `text` mirrors it.

### Ollama Cloud quota (STATE risk-flag)
- **D-12:** Research MUST confirm the real Ollama Cloud quota windows (5h / 7-day, burns fastest on the 235B model) before finalizing the cumulative budget cap / max-tier defaults. Treat a quota/429 response as a hard failure that falls through (or halts escalation) rather than failing the job — degrade gracefully.

### Claude's Discretion
- Exact module layout under `lib/v1/cascade/` (config.js, heuristic.js, runner.js, trace shape), helper naming, and whether the config is a JS module vs JSON (JS module chosen for `.describe`-style comments + reuse of engine ids).
- Concrete threshold numbers — set by research/calibration, tunable in config without code change.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & goal
- `.planning/REQUIREMENTS.md` §Cascade Routing (CASC-01..09) + §Jobs & Response Envelope (JOB-02, JOB-04)
- `.planning/ROADMAP.md` §"Phase 2: Cascade Router" — goal + 5 success criteria (acceptance anchor; note SC#1 "P50 winner is not the top tier")
- `.planning/PROJECT.md` §Context (the "known detail": `ocrspace.js` discards confidence — enable overlay) + §Out of Scope (no unified overlay in API; no client-tunable thresholds; no unbounded whole-cascade retries)
- `.planning/STATE.md` §Blockers/Concerns — Phase 2 heuristic calibration + Ollama quota risk-flags

### Phase 1 foundation (build on, don't rebuild)
- `.planning/phases/01-foundation/01-CONTEXT.md` — envelope (D-04), status vocabulary, engines.js decision
- `.planning/phases/01-foundation/01-01-SUMMARY.md`, `01-02-SUMMARY.md` — what shipped
- Shipped code: `lib/v1/engines.js` (findModel/envKeyFor/providerKeyPresent), `lib/v1/worker.js` (result envelope assembly — cascade integration point), `lib/v1/router.js` (forced-model + fail-closed guard), `lib/models.js` (the 4 cascade engines), `lib/providers/ocrspace.js` (overlay enablement point), `lib/providers/ollama.js`, `lib/ocr.js`

### Stack
- `CLAUDE.md` §Technology Stack — pinned versions; note zod is Phase 4 (not needed here)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `lib/models.js`: all 4 cascade engines already defined with `modelTag`, `modes_supported`, `max_bytes`. Chain = ordered engine ids.
- `lib/v1/engines.js`: `providerKeyPresent` (for D-09 tier-drop), `findModel`, `envKeyFor`, `PROVIDER_ENV`.
- `lib/providers/ocrspace.js`: sends `isOverlayRequired='false'` today — the D-03 overlay-enable + confidence-extraction point.
- `lib/providers/ollama.js`, `lib/ocr.js`: provider dispatch the cascade runner will call per engine.
- `lib/v1/worker.js`: builds the page-aware envelope; the D-11 cascade integration point (already emits `engine`/`confidence` per-page stubs).

### Established Patterns
- `AbortSignal.timeout(...)` already used per-provider — extend to a job-level deadline (JOB-04).
- Envelope + terminal `succeeded`/`failed` + `finalized` guard from Phase 1 — the trace attaches to `result`.
- Reject-before-enqueue + typed 422 errors — reuse for forced-engine capability rejection (D-07).

### Integration Points
- New `lib/v1/cascade/` module set (config + heuristic + runner + trace) called from `worker.js`.
- `ocrspace.js` return shape extended with a confidence signal from overlay.
- `router.js`/`/v1/models` extended with profile selection + profiles discovery.
</code_context>

<specifics>
## Specific Ideas
- Cascade order and engine ids are fixed by ROADMAP; profiles slice that order.
- The heuristic is the single hardest, highest-risk piece — keep it pure, config-driven, and unit-tested against synthetic clean/garbage/empty fixtures so thresholds can be tuned without touching logic.
</specifics>

<deferred>
## Deferred Ideas
- PDF (native + scanned), TIFF/HEIC/BMP/GIF normalization, subprocess sandboxing, OPS-06 — Phase 3.
- `mode=structured` schema extraction — Phase 4.
- Unified cross-engine bounding boxes / word overlay in the public API — permanently out of scope (overlay stays internal to the heuristic).
- Client-tunable per-request confidence thresholds — out of scope (profiles encode intent).
- None outside phase scope surfaced.
</deferred>

---

*Phase: 2-Cascade-Router*
*Context gathered: 2026-07-23*
