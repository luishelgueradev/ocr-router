# Architecture Research

**Domain:** Dockerized OCR / document-recognition API gateway with cascade routing + multi-format input normalization (`ocr-router`)
**Researched:** 2026-07-23
**Confidence:** HIGH (structure grounded in reading the reference source); MEDIUM on specific input-pipeline libraries (defer final choice to STACK)

## Core Architectural Thesis

Two new layers slot into the **existing** reference cleanly *without* rewriting it, because the reference already draws the right seam:

- Today `lib/v1/worker.js` calls `runOCR(model, base64, ...)` (in `lib/ocr.js`) **exactly once** with **one client-chosen model** on **one image buffer**.
- `runOCR` is already a provider-dispatch adapter (`ollama` | `ocrspace`). **Keep it as the leaf.**

The two new layers wrap that seam:

1. **Cascade engine** *replaces the single `runOCR` call* with an ordered chain-walk that calls `runOCR` once per engine until a result passes a quality gate. It sits **above** `lib/ocr.js` and **below** the worker. The provider abstraction is untouched — engines are just chain-ordered entries in the model registry.
2. **Input normalization** sits **before** routing, inside the worker's job body: it turns any upload into a lazy sequence of *page units*, and the worker feeds each image page through the cascade, aggregating per-page results into one job record.

Everything else (auth, async jobs, concurrency-1 worker + bounded queue, backpressure, graceful shutdown, deploy) is ported verbatim.

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  HTTP / API LAYER          lib/v1/router.js, auth.js, upload.js        │
│  POST /v1/ocr → validate + container-sniff + backpressure → 202 job_id │
│  GET  /v1/jobs/:id → poll                                              │
├──────────────────────────────────────────────────────────────────────┤
│  QUEUE / WORKER LAYER      lib/v1/worker.js  (Bottleneck concurrency=1) │
│  runJob orchestrates:  normalize → per-page route → aggregate          │
├───────────────────────────────┬──────────────────────────────────────┤
│  INPUT NORMALIZATION  (NEW)    │   CASCADE ENGINE  (NEW)               │
│  lib/input/                    │   lib/cascade/                        │
│  ┌──────────────┐              │   ┌────────────────────────────┐     │
│  │ sniff (ext)  │ container →  │   │ engine.js  chain-walk       │     │
│  │ normalize.js │ page         │   │  for each engine in chain:  │     │
│  │  ├ pdf.js    │ iterator →   │   │   runEngine → evaluate      │     │
│  │  └ image.js  │ pages[]      │   │   pass? stop : next         │     │
│  └──────────────┘              │   ├────────────────────────────┤     │
│   yields discriminated pages:  │   │ profiles.js / chains.js     │     │
│   {kind:'text'}  (skip OCR)    │   │  declarative config (data)  │     │
│   {kind:'image'} (→ cascade)   │   ├────────────────────────────┤     │
│                                │   │ quality.js  pluggable       │     │
│                                │   │  evaluators (pass/fail+score)│    │
│                                │   └──────────────┬─────────────┘     │
├────────────────────────────────────────────────┼─────────────────────┤
│  ENGINE ADAPTER   lib/ocr.js  runEngine(engine, image, task)           │
│  (provider dispatch — UNCHANGED SEAM, extended for `task`)             │
├──────────────────────────────────────────────────────────────────────┤
│  PROVIDERS   lib/providers/ollama.js   lib/providers/ocrspace.js       │
├──────────────────────────────────────────────────────────────────────┤
│  STORES   lib/v1/jobs.js (LRU, in-mem, page[]-extended)  · models.js   │
└──────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| `lib/v1/router.js` | Parse request, auth (via `auth.js`), sniff container type, backpressure guard, create job, `202` + enqueue. Now also reads `profile` / `mode` / `model` params. | Ported + widened (accepts more mime types, more params) |
| `lib/v1/worker.js` | Per-job orchestration: `normalize → for-each-page route → aggregate → jobs.complete`. Stays `maxConcurrent:1`. | Ported, body rewritten to call cascade instead of `runOCR` once |
| `lib/input/sniff.js` | Detect *container* type from magic bytes: png/jpeg/webp/pdf/tiff/heic/bmp/gif. Extends existing `sniff.js`. | Magic-byte table (existing pattern) |
| `lib/input/normalize.js` | Dispatch by container → returns an **async page iterator** yielding one page unit at a time (lazy). | Discriminated union: `{kind:'text',text}` \| `{kind:'image',png,meta}` |
| `lib/input/pdf.js` | Per-page: detect text layer → emit `text` page (skip OCR); else render page to PNG → emit `image` page. **One page in memory at a time.** | `pdfjs-dist` text extract + a rasterizer (pdfium/poppler/mupdf — STACK decides) |
| `lib/input/image.js` | Convert TIFF (multipage → N pages) / HEIC / BMP / GIF → PNG page(s). | `sharp` (+ libheif for HEIC) — STACK decides |
| `lib/cascade/engine.js` | **The chain-walk.** For a single image + chain + thresholds + task + evaluator: call `runEngine` per engine, evaluate, fall through on hard-fail OR low-confidence, record every attempt, return winner or best-with-`low_confidence`. **Pure/injectable.** | New; depends only on injected `runEngine` + `evaluator` |
| `lib/cascade/profiles.js` + `chains.js` | Declarative data: named profiles → `{chain[], thresholds, task, evaluatorId}`; chains are ordered engine-id arrays. Validated at boot. | Plain JS objects / JSON |
| `lib/cascade/quality.js` | Pluggable confidence evaluators. Text evaluator (empty/length/garbage-ratio/overlay-score → pass+score). Schema evaluator (JSON-parse + validate). Registry keyed by `evaluatorId`. | Pure functions + registry |
| `lib/models.js` → engine registry | Each engine's identity + `provider` + `modelTag`/`engine` + **`kind`** (`classic-ocr`\|`vision-llm`) + **`capabilities`** (`text`,`structured`) + modes. | Extend existing array |
| `lib/ocr.js` (`runEngine`) | Provider dispatch leaf, extended to accept a `task` (`{kind:'text'|'structured', schema?, promptProfile}`) and return `{ok, text, rawSignals?}`. | Extend existing `runOCR` |
| `lib/providers/*` | Raw HTTP to ocr.space / Ollama Cloud. Return raw text (+ optional raw signals like overlay score). **No quality judgement here.** | Ported; ocrspace optionally sets `isOverlayRequired=true` for a score; ollama gains JSON/structured prompt |
| `lib/v1/jobs.js` | Job record store; schema extended to hold `result.pages[]` + concatenated `text` + `low_confidence` + `document_kind`. | Ported, schema-extended |

## Recommended Project Structure

```
lib/
├── v1/
│   ├── router.js        # HTTP: validate, sniff container, enqueue (widened)
│   ├── worker.js        # orchestrates normalize → cascade → aggregate (rewritten body)
│   ├── jobs.js          # LRU job store, pages[]-extended schema
│   ├── auth.js env.js errors.js health.js shutdown.js upload.js  # ported as-is
│   └── sniff.js         # -> superseded by lib/input/sniff.js (container-level)
├── input/               # NEW — normalization pipeline (buffer → page iterator)
│   ├── sniff.js         # container-type magic-byte detection
│   ├── normalize.js     # dispatch by container → async page iterator
│   ├── pdf.js           # text-layer detect (skip OCR) | lazy per-page rasterize
│   └── image.js         # TIFF/HEIC/BMP/GIF → PNG (multipage-aware)
├── cascade/             # NEW — routing engine
│   ├── engine.js        # chain-walk orchestrator (pure, injectable deps)
│   ├── profiles.js      # named profiles → chain + thresholds + task + evaluatorId
│   ├── chains.js        # ordered engine-id arrays
│   └── quality.js       # pluggable evaluators: text-heuristic + schema-validator
├── models.js            # engine registry (kind + capabilities added)
├── ocr.js               # runEngine(engine, image, task) — provider dispatch leaf
├── providers/
│   ├── ollama.js        # + structured/JSON prompt support
│   └── ocrspace.js      # + optional overlay score
└── logger.js
```

### Structure Rationale

- **`lib/input/` and `lib/cascade/` are new top-level siblings**, not folded into `v1/`, because they are transport-agnostic domain logic. A future `/v2` or a CLI could reuse them; `v1/` stays about HTTP + jobs.
- **`lib/ocr.js` stays the single provider seam.** The cascade must call providers *through* it, never reach into `lib/providers/*` directly — otherwise provider knowledge duplicates and the "add a local engine later as just another provider" decision breaks.
- **Config (`profiles/chains/quality thresholds`) is separated from mechanism (`engine.js`).** The chain-walk knows nothing about *which* engines or *what* thresholds — it receives them. This is what makes it unit-testable with a fake `runEngine`.

## Architectural Patterns

### Pattern 1: Cascade as an injectable pure orchestrator

**What:** `engine.js` exports `runCascade({ image, chain, thresholds, task, runEngine, evaluate })`. It owns *only* the fall-through policy (hard-fail OR score-below-threshold → next engine; record every attempt; return winner or best+`low_confidence`). Both `runEngine` and `evaluate` are injected.

**When to use:** always — it is the core differentiator and the most test-sensitive logic.

**Trade-offs:** one extra indirection vs. total testability + zero provider/HTTP coupling in the decision logic.

```javascript
// lib/cascade/engine.js  (shape, not final)
async function runCascade({ image, chain, thresholds, task, runEngine, evaluate }) {
  const attempts = [];
  let best = null;
  for (const engine of chain) {
    const t0 = Date.now();
    const res = await runEngine(engine, image, task);        // -> lib/ocr.js
    if (!res.ok) { attempts.push({ engine: engine.id, ok:false, error:res.error, ms:Date.now()-t0 }); continue; }
    const q = evaluate(res, thresholds);                     // -> lib/cascade/quality.js
    attempts.push({ engine: engine.id, ok:true, score:q.score, signals:q.signals, ms:Date.now()-t0 });
    if (!best || q.score > best.score) best = { engine, text:res.text, score:q.score };
    if (q.pass) return { winner: engine.id, text: res.text, score: q.score, low_confidence:false, attempts };
  }
  return best
    ? { winner: best.engine.id, text: best.text, score: best.score, low_confidence:true, attempts }
    : { winner: null, text:'', low_confidence:true, attempts };
}
```
Test in isolation: inject a `runEngine` returning `[fail, low-quality, good]` and assert it stops at engine 3; inject all-low and assert `low_confidence:true` with the best.

### Pattern 2: Profiles + engine capabilities instead of `if` branches

**What:** Every routing behavior is a *named profile* (data), and every special constraint is an *engine capability* (data). `mode=structured` selects the `structured` profile; the router never branches on "is this structured".

**When to use:** for structured-mode, forced-model, and any future routing variant.

**Trade-offs:** slightly more config up front; eliminates scattered special-casing (the explicit goal of the question).

```javascript
// lib/cascade/profiles.js
module.exports = {
  default:    { chain: 'cascade_full', thresholds: TEXT_THRESHOLDS, task: { kind:'text' },       evaluatorId: 'text' },
  fast:       { chain: 'cascade_fast', thresholds: TEXT_THRESHOLDS, task: { kind:'text' },       evaluatorId: 'text' },
  quality:    { chain: 'vision_only',  thresholds: TEXT_THRESHOLDS, task: { kind:'text' },       evaluatorId: 'text' },
  structured: { chain: 'vision_only',  thresholds: SCHEMA_THRESHOLDS, task: { kind:'structured' }, evaluatorId: 'schema' },
};
// chains.js: 'cascade_full' = ['ocrspace-engine2','ollama-gemini-3-flash','ollama-gemma4-31b','ollama-qwen3-vl-235b']
//            'vision_only'  = [...same minus ocrspace]   ← ocr.space lacks capability 'structured'
```

Resolution + validation happens once, in the router:
- `profile` param → look up profile (default `default`).
- `mode=structured` → force `structured` profile.
- `model` param (forced) → build a one-engine chain `[model]`, **but validate** `engine.capabilities.includes(task.kind)`; reject `422` if a client forces ocr.space with `mode=structured`.

Because ocr.space is excluded from any structured chain **by capability data**, "must skip ocr.space / force a vision LLM" is enforced in one place, not sprinkled around.

### Pattern 3: Lazy page iterator (one image buffer in flight)

**What:** `normalize()` returns an **async generator** that yields page units on demand. The worker consumes one, routes it, records the *text result* (small), then lets the page image be GC'd before pulling the next page. Never materialize `pages[]` as an array of image buffers.

**When to use:** all multi-page inputs (PDF, multipage TIFF).

**Trade-offs:** strictly sequential (fine — the worker is concurrency-1); peak memory ≈ one rendered page, not the whole document — the exact mitigation the PROJECT constraint calls for.

```javascript
// lib/v1/worker.js  (job body sketch)
const pageResults = [];
for await (const page of normalize(buffer, containerType)) {   // yields 1 page at a time
  if (page.kind === 'text') {
    pageResults.push({ index: page.index, engine_used: 'pdf-text', text: page.text, low_confidence: false, attempts: [] });
  } else {                                                      // page.kind === 'image'
    const r = await runCascade({ image: page.png, chain, thresholds, task, runEngine, evaluate });
    pageResults.push({ index: page.index, engine_used: r.winner, text: r.text, score: r.score,
                       low_confidence: r.low_confidence, attempts: r.attempts });
  }
  // page.png goes out of scope here → buffer released before next page renders
}
jobs.complete(jobId, {
  document_kind: containerKind,
  page_count: pageResults.length,
  pages: pageResults,
  text: pageResults.map(p => p.text).join('\n\n'),
  low_confidence: pageResults.some(p => p.low_confidence),
});
```

### Pattern 4: Providers report signals, evaluators judge

**What:** `lib/providers/*` return raw `{ok, text, rawSignals?}` (e.g. ocr.space overlay per-word score). `lib/cascade/quality.js` owns *all* pass/fail policy. Providers never decide confidence.

**Trade-offs:** keeps thresholds tunable in one config-driven place and keeps the quality module pluggable (swap `text` evaluator for `schema` evaluator via `evaluatorId`).

```javascript
// lib/cascade/quality.js
const evaluators = {
  text: (res, th) => {
    const t = (res.text || '').trim();
    const garbage = nonPrintableRatio(t);
    const overlay = res.rawSignals?.overlayScore ?? null;
    const pass = t.length >= th.minLen && garbage <= th.maxGarbage && (overlay == null || overlay >= th.minOverlay);
    return { pass, score: qualityScore(t, garbage, overlay), signals: { len:t.length, garbage, overlay } };
  },
  schema: (res, th) => {
    try { const obj = JSON.parse(extractJson(res.text)); const v = validate(obj, th.schema);
          return { pass: v.ok, score: v.ok ? 1 : 0, signals: { errors: v.errors } }; }
    catch (e) { return { pass:false, score:0, signals:{ parse:'fail' } }; }
  },
};
module.exports = { evaluate: (res, th, id='text') => evaluators[id](res, th) };
```

> Note (from PROJECT): `lib/providers/ocrspace.js` currently sends `isOverlayRequired=false` and discards confidence. The overlay-score signal is therefore **optional/enhancement**; the MVP text evaluator relies on length + garbage-ratio + empty checks, which need no provider change. Enabling overlay is a later refinement, not a blocker.

## Data Flow

### Request → Job (unchanged shape, widened)

```
POST /v1/ocr (file, profile?/mode?/model?)
   → auth → sniff container type → backpressure (queue-depth guard) → jobs.create
   → 202 { job_id, status_url } ; limiter.schedule(runJob)   ← fire-and-forget (existing pattern)
```

### Job execution (the new interior)

```
runJob(jobId, {buffer, containerType, profile, mode, model}):
   resolve profile → { chain, thresholds, task, evaluatorId }     (profiles.js; capability-validate forced model)
   normalize(buffer, containerType) ──► async page iterator
        for each page (lazy, 1 in memory):
            page.kind === 'text'   → pageResult from embedded text     [SKIP cascade — native PDF]
            page.kind === 'image'  → runCascade(page.png, chain, ...)   [scanned/image → route]
                                        └► runEngine(engine, image, task) ─► providers ─► raw {text, signals}
                                        └► evaluate(res, thresholds, evaluatorId) → pass/fail+score
            append pageResult ; release page buffer
   jobs.complete → { document_kind, page_count, pages:[{index, engine_used, attempts, text, score, low_confidence}], text:<concat>, low_confidence }
GET /v1/jobs/:id → returns that record (per-page + concatenated + full attempt traceability)
```

### Sub-job vs. page-array-within-job — the decision

**Recommendation: page-array-within-a-single-job-record + lazy per-page rendering. Do NOT create sub-jobs.**

| Approach | Memory (concurrency-1) | UX | Verdict |
|----------|------------------------|-----|---------|
| **Sub-jobs** (1 page = 1 queued job) | Each queued sub-job holds its page buffer → N page buffers contend for `MAX_QUEUE_DEPTH`; breaks the reference's memory accounting (`QUEUED × MAX_UPLOAD_BYTES`) | Client gets many job_ids, must re-aggregate; contradicts "within one job record" requirement | **Reject** |
| **Page-array in one job + lazy iterator** | Peak ≈ one rendered page (iterator yields, worker releases before next) | One `job_id`, one poll, per-page + concatenated result, natural ordering | **Accept** |

Rationale: the worker is deliberately `maxConcurrent:1`, so sub-jobs buy **no parallelism** — only downside (queue memory multiplication + fragmented UX). The single-job model accumulates *text results* (kilobytes), never a full array of *page images* (megabytes each), which is exactly the buffer discipline PROJECT.md's resource constraint demands.

Mitigations to add with this choice: a **page-count cap** (reject/curtail huge PDFs) and an **overall job timeout** — because one document now holds the single worker slot for its whole duration, and a slow late page could starve the queue.

## Build Order (maps to phases)

Dependency-ordered. Each step is independently valuable and testable.

```
1. FOUNDATION (port)         2. CASCADE ENGINE          3. INPUT PIPELINE           4. STRUCTURED MODE
   auth, jobs, worker,   →      engine.js (chain-walk) →    image formats →             capability + profile +
   providers, models,          quality.js, profiles/       (TIFF/HEIC/BMP/GIF)         schema evaluator +
   deploy (Caddy/TS),          chains, engine registry     then PDF (native text        JSON prompt on providers
   images-only passthrough     (kind+capabilities)         extract → scanned render),
                                                           worker fan-out + job pages[]
```

**Why this order (dependency reasoning):**

1. **Foundation first** — everything imports `jobs`/`worker`/`providers`/`models`; port verbatim. Delivers today's single-model image OCR immediately.
2. **Cascade before input pipeline.** The cascade operates on *one image* — the exact unit the ported foundation already produces from a direct upload. So it needs **no new heavy dependencies** (no `sharp`/pdfium yet) and delivers the core differentiator ("never fail to return the best result") on plain images first. Building it here also lets the input pipeline, once added, plug per-page images into an already-proven router.
   - *Alternative considered:* input-pipeline-before-cascade (multi-page passthrough to a client-chosen model). Rejected as first-value: cascade is the product's core value and is lower-dependency.
3. **Input pipeline third**, sub-sequenced by surface area (PROJECT's own phasing: images → PDF): (a) extra image formats → PNG (self-contained, one `sharp`-class dep), then (b) PDF — native text extraction (skip-OCR path, `pdfjs-dist`) before scanned rasterization (heavier rasterizer dep). This introduces worker fan-out + `jobs.js` `pages[]` schema — additive, gated behind the page iterator.
4. **Structured mode last** — a thin increment on the finished cascade: add `capabilities:['structured']` to vision engines, a `structured` profile, the `schema` evaluator, and a JSON prompt path in `providers/ollama.js`. No new orchestration; it reuses `runCascade` unchanged. Depends on cascade (2) + vision providers (1).

## Scaling Considerations

| Scale | Adjustments |
|-------|-------------|
| Own/trusted use (target) | Concurrency-1 + bounded queue + in-mem LRU jobs is *by design*. Add page-count cap + per-engine timeouts + overall job timeout. |
| Higher throughput | Run N replicas behind Caddy; move job store from in-mem LRU to shared Redis so any replica can serve `GET /v1/jobs/:id`. Keep per-replica concurrency low (LLM calls are the bottleneck, not CPU). |
| Cost/quality tuning | Because chains + thresholds are config, tune escalation without code: raise thresholds → escalate more (better quality, higher cost); lower → stop earlier (cheaper). ocr.space-first already minimizes vision-LLM spend. |

### First bottlenecks

1. **Vision-LLM latency** (Qwen3-VL 235B is slow) holds the single worker slot → mitigate with per-engine timeouts feeding the cascade's hard-fail path, and profile choice (`fast` chain for latency-sensitive callers).
2. **PDF rasterization memory** → the lazy iterator (Pattern 3) is the primary defense; the page-count cap is the backstop.

## Anti-Patterns

### Anti-Pattern 1: Special-casing structured/PDF with `if` branches in worker/router
**What people do:** `if (mode==='structured') {...} else if (isPdf) {...}` scattered across router and worker.
**Why it's wrong:** every new input type or mode multiplies branches; the router leaks routing policy.
**Instead:** structured = a profile + engine capability (Pattern 2); PDF = a page-kind in the iterator (Pattern 3). The worker has *one* path: normalize → route image pages → aggregate.

### Anti-Pattern 2: Rasterizing the whole PDF into an array of buffers
**What people do:** `const pages = await pdfToImages(buf)` returning `Buffer[]` up front.
**Why it's wrong:** N × page-image megabytes resident at once — blows the VPS memory budget the whole reference is engineered around.
**Instead:** async generator yields one page image; worker releases it before the next render (Pattern 3).

### Anti-Pattern 3: Fanning pages out into sub-jobs on the concurrency-1 queue
**What people do:** enqueue one job per page for "parallelism".
**Why it's wrong:** concurrency-1 gives zero parallelism; sub-jobs only multiply queued buffers and fragment the client UX.
**Instead:** one job record with `pages[]` (see decision table).

### Anti-Pattern 4: Baking chains/thresholds into code
**What people do:** hard-code the engine order and magic numbers inside `engine.js`.
**Why it's wrong:** untestable in isolation, un-tunable without a deploy.
**Instead:** `profiles.js`/`chains.js` as data injected into a pure `runCascade` (Pattern 1).

### Anti-Pattern 5: Cascade reaching into `lib/providers/*` directly
**What people do:** cascade imports `runOllama`/`runOcrSpace` to "save a hop."
**Why it's wrong:** duplicates provider knowledge; breaks the "add a local engine later as just another provider" decision.
**Instead:** cascade calls only `runEngine` in `lib/ocr.js`; providers stay behind that one seam.

### Anti-Pattern 6: Quality judgement inside providers
**What people do:** provider returns `{ok:false}` when text looks short.
**Why it's wrong:** couples confidence policy to HTTP code; can't reuse thresholds or swap the schema evaluator.
**Instead:** providers return raw text + raw signals; `quality.js` decides pass/fail (Pattern 4).

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| ocr.space | `lib/providers/ocrspace.js`, classic-OCR engine, chain position 1 | `capabilities:['text']` only → auto-excluded from structured chains. Set `isOverlayRequired=true` *only* if the overlay-score signal is adopted. Degrade gracefully when key absent (drop from chain). |
| Ollama Cloud (Gemini 3 Flash / Gemma 4 31B / Qwen3-VL 235B) | `lib/providers/ollama.js`, vision-LLM engines, chain positions 2–4 | `capabilities:['text','structured']`. Structured task adds JSON/schema prompt. Per-engine timeout feeds cascade fall-through. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| worker ↔ input | async page iterator (pull) | Backpressure-free by construction; one page in flight |
| worker ↔ cascade | `runCascade({image, chain, thresholds, task, ...})` per image page | Worker owns aggregation; cascade owns per-image escalation |
| cascade ↔ ocr.js (`runEngine`) | `(engine, image, task) → {ok, text, rawSignals}` | The single provider seam |
| cascade ↔ quality | `evaluate(res, thresholds, evaluatorId) → {pass, score, signals}` | Pluggable via `evaluatorId` from the profile |
| router ↔ profiles | resolve `profile`/`mode`/`model` → profile; capability-validate forced model | The one place structured/forced-model rules live |

## Sources

- Reference source read directly: `lib/v1/router.js`, `worker.js`, `jobs.js`, `modes.js`, `errors.js`, `sniff.js`, `upload.js`, `models.js`, `ocr.js`, `providers/ollama.js`, `providers/ocrspace.js` (HIGH — primary).
- `.planning/PROJECT.md` — constraints, engine tiers, phasing decisions (HIGH — primary).
- [Nutrient — extract text from PDF with PDF.js](https://www.nutrient.io/blog/how-to-extract-text-from-a-pdf-using-javascript/) — native-vs-scanned detection pattern (MEDIUM).
- [unpdf vs pdf-parse vs pdfjs-dist (2026)](https://www.pkgpulse.com/guides/unpdf-vs-pdf-parse-vs-pdfjs-dist-pdf-2026) — text-layer extraction options (MEDIUM).
- [node-poppler](https://github.com/Fdawgs/node-poppler), [@hyzyla/pdfium render docs](https://pdfium.js.org/docs/render-pdf), [MuPDF.js](https://mupdf.com/mupdf-js) — server-side per-page rasterization + memory/streaming (MEDIUM; final choice → STACK).

---
*Architecture research for: dockerized cascade OCR API gateway*
*Researched: 2026-07-23*
