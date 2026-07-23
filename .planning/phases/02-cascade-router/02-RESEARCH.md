# Phase 2: Cascade Router - Research

**Researched:** 2026-07-23
**Domain:** OCR-quality confidence heuristics · multi-engine fallback orchestration · job-deadline abort propagation (Node 22 / Express 4)
**Confidence:** HIGH on architecture & code integration · HIGH on the ocr.space overlay correction · MEDIUM on Ollama quota numbers · LOW on exact heuristic thresholds (need live-key calibration)

## Summary

Phase 2 turns the four already-registered engines (`lib/models.js`) into a declarative, config-driven cascade. The heavy lifting is not the walk-the-chain loop (that is ~40 lines) — it is (1) the **pure confidence heuristic** that decides "good enough to stop," and (2) threading **one authoritative job deadline** through two different HTTP clients (`fetch` for ocr.space, `axios` for ollama) so a hung provider cannot wedge the single-concurrency worker.

The single most important research finding **corrects a locked assumption in CONTEXT.md D-03**: the ocr.space API returns **no confidence score at any level** — not per-word, not mean. When `isOverlayRequired=true` it returns only bounding-box geometry (`WordText`, `Left`, `Top`, `Height`, `Width`) plus a `HasOverlay` boolean. This was verified against the official API docs three independent ways. Consequently the heuristic's "third signal" cannot be a confidence number; the only usable overlay-derived signal is **detected word count / overlay presence**, a weak positive proxy. This is good news for design simplicity: the heuristic becomes **uniform across classic-OCR and LLM engines** — both are judged primarily on text-length and garbage-ratio, with overlay word-count as a low-weight bonus available only for ocr.space.

**Primary recommendation:** Build `lib/v1/cascade/{config,heuristic,runner,trace}.js`. Make `heuristic.computeConfidence(text, { overlay })` a pure function returning `[0,1]` with two hard gates (empty, garbage-ratio) plus a weighted soft score; drive every threshold/weight from `config.js` (env-overridable). Judge all engines on text-quality signals; treat ocr.space overlay word-count as a 0.2-weight bonus, not a confidence. Thread a single `AbortController` deadline (`AbortSignal.any([perEngineTimeout, jobDeadline])`) into both providers. On an Ollama `429`/quota response, **short-circuit all remaining same-provider tiers** (they share one account quota) and return best-so-far.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Engine ordering / profile selection | Cascade config (`config.js`) | — | Declarative data, not branches (CASC-09) |
| Confidence decision | Cascade heuristic (`heuristic.js`, pure) | — | Must be unit-testable in isolation without keys/network (STATE risk-flag) |
| Chain walk, fall-through, budget, best-so-far | Cascade runner (`runner.js`) | Worker | Orchestration owns retries/bounds (CASC-01/02/04/08) |
| Deadline / abort of a hung call | Worker + runner (`AbortController`) | Providers (accept `signal`) | One authoritative timeout at job level (JOB-04); per-engine timeouts subordinate |
| Confidence signal extraction from provider | Providers (`ocrspace.js` overlay parse) | Runner | Provider owns its wire format; runner stays provider-agnostic |
| Trace assembly | Runner → `trace.js` | Worker (attaches to envelope) | Trace is a cascade artifact (JOB-02) |
| Forced-engine capability rejection | Router (`router.js`, pre-enqueue 422) | Config (capability table) | Reject before holding a buffer in queue (existing Phase-1 pattern) |
| Profiles discovery | Router (`GET /v1/models`) | Config | Completes API-05 |

## Standard Stack

No new npm packages are required for this phase. Everything is native Node 22 or already-installed Phase-1 deps.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `AbortController` / `AbortSignal.any` / `AbortSignal.timeout` | Node 22 native | Single job deadline composed with per-engine timeouts (JOB-04) | `AbortSignal.any` landed in Node 20.3, stable in 22; composes multiple signals with no dep. [VERIFIED: node --version >=22 in package.json engines] |
| `axios` | `^1.16.0` (installed) | Ollama HTTP; supports `signal` option for abort | Already the ollama client; axios has honored `AbortController.signal` since v0.22. [CITED: axios docs] |
| `fetch` (native) | Node 22 native | ocr.space HTTP; already used in `ocrspace.js` with `AbortSignal.timeout` | Native, already in place. [VERIFIED: lib/providers/ocrspace.js] |
| `bottleneck` | `^2.19.5` (installed) | Single-concurrency worker — unchanged | Cascade runs *inside* one limiter slot; do not add a second limiter. [VERIFIED: lib/v1/worker.js] |

### Supporting (already installed)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | `^10.3.1` | Per-engine attempt logging (child logger already threaded in worker) | Log each attempt outcome; never log buffers/keys (OPS-05) |
| `lru-cache` (via `jobs.js`) | `^11.5.0` | Job store — trace attaches to `job.result` | Unchanged; trace rides the existing envelope |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Native `AbortSignal.any` | `p-timeout` / manual `Promise.race` | Extra dep; `AbortSignal.any` is native in Node 22 and actually aborts the socket, not just the promise. Avoid. |
| Weighted-sum heuristic | ML/dictionary-based OCR quality classifier | Massive overkill; needs a language model/dictionary, non-deterministic, hard to unit-test. The whole point (STATE risk-flag) is a *pure, tunable, testable* function. |
| ocr.space overlay confidence | (does not exist) | See correction below — no confidence field is returned; do not design around one. |

**Installation:** none — `npm install` unchanged for this phase.

## Package Legitimacy Audit

**Not applicable.** Phase 2 installs **zero** new external packages. All functionality uses Node 22 built-ins (`AbortController`, `AbortSignal.any/timeout`, `fetch`) or Phase-1 dependencies already vetted in `CLAUDE.md`. No slopcheck run required.

Optional new helper is a **local module**, not a package: add `floatFromEnv()` beside `intFromEnv()` in `lib/v1/env.js` (thresholds/ratios are floats; `intFromEnv` rejects `0.6`).

---

## PRIORITY 1 — Confidence Heuristic (deepest)

### 1a. The overlay correction (read this first)

CONTEXT.md D-03 assumes the ocr.space overlay yields "per-word/mean confidence." **It does not.** Verified against the official API docs:

- With `isOverlayRequired=true`, each `ParsedResults[i].TextOverlay` contains `Lines[].Words[]` where each word is `{ WordText, Left, Top, Height, Width }` plus line-level `MaxHeight`/`MinTop`, and `HasOverlay: bool`, `Message`. **No confidence key exists at word, line, page, or result level.** [CITED: ocr.space/ocrapi — "The API documentation contains no mention of confidence scoring… zero instances of the word 'confidence'"]
- `OCRExitCode` (top-level): `1`=success, `2`=partial (multi-page), `3`=all failed, `4`=fatal. `FileParseExitCode` (per result): `1`=success, `-10`=parse error, `-20`=timeout, `-30`=validation, `-99`=unknown. [CITED: ocr.space/OCRAPI]

**Design consequence (this replaces the D-03 "overlay score" signal):** the only overlay-derived signal is **detected word count** (`sum(Lines[].Words.length)`) and `HasOverlay`. Use it as a *weak positive bonus* (many well-formed words ⇒ likely real text), never as the primary judge. This unifies the heuristic: **all engines are judged on text-length + garbage-ratio; ocr.space additionally contributes a small word-count bonus.**

> **[ASSUMED → flag for user]** CONTEXT.md D-03 should be amended: "ocr.space overlay contributes a *word-count* signal, not a confidence score." Still recommend enabling `isOverlayRequired=true` (cheap, gives word count + future-proofs geometry), but the planner/discuss-phase should confirm the amended framing.

### 1b. How OCR-quality heuristics are normally done

Standard post-OCR "garbage / quality" filters in the literature and in tools like Tesseract/OCRopus post-filters combine cheap character-statistics signals, because a real confidence number is often unavailable or unreliable [ASSUMED — general domain knowledge, not fetched this session]:
- **Alphabetic / alphanumeric ratio** — proportion of chars that are letters/digits vs symbols/control.
- **Non-printable / replacement-char ratio** — presence of `U+FFFD` (�) and C0/C1 control chars signals decode failure or mojibake.
- **Length floor** — near-empty output is almost always a failure.
- **Dictionary-word ratio** (heavier; needs a wordlist) — we deliberately *skip* this to keep the function pure/dependency-free.
- **Mean recognition confidence** — the gold signal *when the engine emits it*; ours do not (ocr.space: none; LLMs: none reliable), so we fall back to the character statistics above.

Our heuristic uses the first three (pure, deterministic, no dictionary), which is the defensible minimal set.

### 1c. Concrete signal definitions

Let `text = raw.normalize('NFC')` then `trimmed = text.trim()`, `len = [...trimmed].length` (code-point count, not UTF-16 units — emoji/CJK safe).

**Signal A — length**
```
ABS_MIN_CHARS = 1     // <= this after trim ⇒ EMPTY hard-fail
GOOD_CHARS    = 16    // length at/above which length is fully satisfied
length_score  = clamp((len - ABS_MIN_CHARS) / (GOOD_CHARS - ABS_MIN_CHARS), 0, 1)
```

**Signal B — garbage / non-printable ratio** (primary quality signal)
```
// "bad" code points:
//   C0 controls 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F  (allow \t \n \r)
//   DEL 0x7F, C1 controls 0x80–0x9F
//   U+FFFD replacement char, U+FFFE/U+FFFF non-chars, lone surrogates
garbage_ratio   = badCodePoints / max(len, 1)
MAX_GARBAGE_RATIO = 0.30            // > this ⇒ GARBAGE hard-fail
printable_score  = 1 - garbage_ratio
```

**Signal C — overlay word count (ocr.space only; null for LLMs)**
```
GOOD_WORDS   = 4
word_count   = overlay?.HasOverlay ? sum(Lines[].Words.length) : null
overlay_score = word_count == null ? null : clamp(word_count / GOOD_WORDS, 0, 1)
```

### 1d. Combined confidence formula (proposed, [0,1])

```
function computeConfidence(text, { overlay } = {}, cfg = CONFIG.heuristic) {
  const t = (text ?? '').normalize('NFC').trim();
  const len = [...t].length;

  // Hard gates → confidence 0 (never accept; always fall through)
  if (len < cfg.absMinChars) return 0;                 // empty / whitespace-only
  const garbage = garbageRatio(t);
  if (garbage > cfg.maxGarbageRatio) return 0;          // mojibake / decode failure

  // Soft signals
  const lengthScore    = clamp((len - cfg.absMinChars) / (cfg.goodChars - cfg.absMinChars), 0, 1);
  const printableScore = 1 - garbage;
  const wordCount      = overlay?.HasOverlay ? overlayWordCount(overlay) : null;
  const overlayScore   = wordCount == null ? null : clamp(wordCount / cfg.goodWords, 0, 1);

  // Weighted average over PRESENT signals (renormalize when overlay absent)
  const parts = [
    [cfg.w.printable, printableScore],
    [cfg.w.length,    lengthScore],
    ...(overlayScore == null ? [] : [[cfg.w.overlay, overlayScore]]),
  ];
  const wsum = parts.reduce((s, [w]) => s + w, 0);
  return parts.reduce((s, [w, v]) => s + w * v, 0) / wsum;   // ∈ [0,1]
}
```

Recommended starting weights (`cfg.w`): `printable 0.5, length 0.3, overlay 0.2`. With overlay absent (all LLM tiers) they renormalize to `printable 0.625, length 0.375`.

### 1e. Per-profile thresholds (starting values — LOW confidence, tune with fixtures/live keys)

`passesThreshold(conf, profile) => conf >= cfg.profiles[profile].threshold`

| Profile | threshold | Rationale |
|---------|-----------|-----------|
| `fast` | **0.50** | Accept early → fewest escalations, cheapest/fastest |
| `balanced` (default) | **0.60** | Accept genuinely-good classic OCR; escalate on doubt |
| `quality` | **0.70** | Demand more before accepting a cheap tier ⇒ escalates more often |

Higher threshold ⇒ more escalation (harder to satisfy). This matches intent: `quality` climbs the chain more readily.

**SC#1 sanity check (clean scanned doc must PASS at ocr.space):**
`len=500, garbage≈0.01, word_count≈80` → `printable≈0.99, length=1, overlay=1` → `conf = 0.5·0.99 + 0.3·1 + 0.2·1 = 0.995`. Clears even `quality` (0.70) → **stops at tier 1** → P50 winner is not the top tier. ✓

**Garbage FAILS:** `garbage_ratio=0.5 > 0.30` → hard-gate → `conf=0` → escalate. ✓
**Empty/whitespace FAILS:** `len<1` → `conf=0`. ✓
**Known edge (document):** a clean 2-char result (`"OK"`) scores `≈0.59` — passes `fast`, fails `balanced`/`quality`. This is an acceptable, documented tradeoff (fast = accept cheap short results); tune `goodChars`/weights if undesirable. Flag for calibration.

### 1f. Config block (lives in `config.js`, env-overridable)

```js
heuristic: {
  absMinChars:     intFromEnv('HEURISTIC_MIN_CHARS', 1),
  goodChars:       intFromEnv('HEURISTIC_GOOD_CHARS', 16),
  goodWords:       intFromEnv('HEURISTIC_GOOD_WORDS', 4),
  maxGarbageRatio: floatFromEnv('HEURISTIC_MAX_GARBAGE', 0.30),
  w: { printable: 0.5, length: 0.3, overlay: 0.2 },
},
profiles: {
  fast:     { chain:['ocrspace-engine2','ollama-gemini-3-flash'], threshold: floatFromEnv('PROFILE_FAST_THRESHOLD',0.50),     maxAttempts:2, budgetMs:30000 },
  balanced: { chain:['ocrspace-engine2','ollama-gemini-3-flash','ollama-gemma4-31b'], threshold: floatFromEnv('PROFILE_BALANCED_THRESHOLD',0.60), maxAttempts:3, budgetMs:60000 },
  quality:  { chain:['ocrspace-engine2','ollama-gemini-3-flash','ollama-gemma4-31b','ollama-qwen3-vl-235b'], threshold: floatFromEnv('PROFILE_QUALITY_THRESHOLD',0.70), maxAttempts:4, budgetMs:120000 },
},
defaultProfile: 'balanced',
```
Add `floatFromEnv()` to `lib/v1/env.js` (mirrors `intFromEnv`; rejects non-finite / negative). Threshold changes are then a config/env edit — no code change (D-01/D-02, CASC-09).

### 1g. Fixture set (pure, no images, no keys)

Because the heuristic is pure over `(text, overlay)`, calibration fixtures are **plain strings + mock overlay objects** — no image files, no network. Put them in `test/fixtures/heuristic/` (as a JS table or `.txt` files) and a `test/heuristic.test.js` table-driven suite.

| Fixture | Content | Expected band | Passes `fast`/`balanced`/`quality` |
|---------|---------|--------------|-------------------------------------|
| `clean_paragraph` | ~300-char normal Spanish paragraph | ≥ 0.90 | ✓ / ✓ / ✓ |
| `clean_receipt` | `"TOTAL: $12.50\nGracias por su compra"` | 0.75–0.90 | ✓ / ✓ / ✓ |
| `clean_with_overlay` | same + mock overlay `{HasOverlay:true, Lines:[…40 words]}` | ≥ 0.95 | ✓ / ✓ / ✓ |
| `mixed_partial` | ~50% real text + `"����▯▯ Ã¿Ø£"` (garbage≈0.35) | 0 (hard gate) | ✗ / ✗ / ✗ |
| `mojibake` | `"Ã¿Ø£�□□ ▯▯▯ \x00\x07"` | 0 | ✗ / ✗ / ✗ |
| `control_chars` | text with >30% C0 controls | 0 | ✗ / ✗ / ✗ |
| `near_empty` | `"OK"` | 0.55–0.62 | ✓ / ✗ / ✗ |
| `single_char` | `"a"` | ~0.5 | ✓(fast only) / ✗ / ✗ |
| `empty` | `""` | 0 | ✗ / ✗ / ✗ |
| `whitespace_only` | `"   \n\t "` | 0 | ✗ / ✗ / ✗ |

**Assertions:** (1) `computeConfidence(...)` ∈ `[0,1]` for every fixture; (2) each fixture's score falls in its expected band; (3) `passesThreshold(score, profile)` matches the expected pass/fail matrix; (4) thresholds are read from config so a threshold tweak re-runs green **without editing test logic** (prove tunability by overriding an env in one test). This directly discharges the STATE risk-flag ("focused spike + small labeled calibration sample").

> **[ASSUMED]** All numbers in 1c–1f are *starting* values. Real calibration requires running a handful of genuine clean/garbage/near-empty images through live ocr.space + one LLM tier and adjusting weights/thresholds so P50 clean docs stop at tier 1 while garbage escalates. Flag as a calibration task needing live keys (Environment Availability below).

---

## PRIORITY 2 — ocr.space Overlay Extraction

**Change in `lib/providers/ocrspace.js`:** set `form.append('isOverlayRequired', 'true')` (currently `'false'`) and return an `overlay` object alongside `text`. Extract a scalar word-count:

```js
// after the existing IsErroredOnProcessing guard:
const results = data.ParsedResults || [];
const text = results.map(r => r.ParsedText || '').join('\n').trim();
let wordCount = 0, hasOverlay = false;
for (const r of results) {
  const lines = r.TextOverlay?.Lines || [];
  if (r.TextOverlay?.HasOverlay) hasOverlay = true;
  for (const ln of lines) wordCount += (ln.Words?.length || 0);
}
return { ok: true, timeMs: Date.now() - start, text,
         overlay: { HasOverlay: hasOverlay, wordCount },
         ocrExitCode: data.OCRExitCode };
```

- The scalar the heuristic consumes is **`overlay.wordCount`** (Signal C). Keep the raw geometry out of the return unless a later phase needs it — PROJECT/REQUIREMENTS forbid exposing overlay in the public API; it stays internal to the heuristic.
- `OCRExitCode === 3` (all pages failed) should be treated by the runner as a **hard failure** (fall through), even though `ok:true`. Return it so the runner can branch.
- No confidence scalar is available — **do not fabricate one.** [CITED: ocr.space/ocrapi, ocr.space/OCRAPI]

`runOCR` in `lib/ocr.js` already returns whatever the provider returns, so the `overlay` field propagates with no change there.

---

## PRIORITY 3 — Ollama Cloud Quota (STATE risk-flag / D-12)

**Verified structure (MEDIUM — official docs omit exact numbers; community sources agree on windows):**
- Two reset clocks: **session/5-hour** and **weekly/7-day**. [CITED: dev.to Ollama Cloud 2026 guide; multiple community sources]
- Usage is measured in **GPU-time**, not fixed request/token counts; models are grouped into **usage levels 1–4** ("light" like 20B up to "extra-heavy"). **`qwen3-vl:235b-cloud` is a heavy/top-level model and burns quota fastest** — confirming the D-12 concern that the top tier is the expensive one to reach. [CITED: dev.to]
- On exceeding a cap the API responds **HTTP 429** with a plain-text-ish message such as `"you have reached your weekly usage limit, upgrade for higher limits"`. [CITED: community; exact JSON body not officially documented]

**How the current code sees it:** `lib/providers/ollama.js` returns `{ ok:false, error, status:429 }` on axios error; `lib/v1/errors.js#mapErrorCode` already maps `status===429 || /rate limit/` → `{ code:'rate_limited', retryable:true }` and `status===403 || /quota/` → `{ code:'quota_exceeded' }`. **Both must be treated by the runner as a hard failure that falls through — but with a critical optimization:**

> **Same-account short-circuit (design note):** all three Ollama tiers share ONE `OLLAMA_API_KEY` quota. If tier N returns `429`/`quota_exceeded`, tiers N+1, N+2 (also ollama) will almost certainly 429 too. The runner MUST NOT waste attempts/budget on them — on an ollama quota/429 outcome, **skip all remaining same-provider engines** and return best-so-far (marked `low_confidence` if nothing passed). Record skipped tiers in the trace as `outcome:'skipped', reason:'provider_quota'`. This makes graceful degradation real instead of hammering a dead quota.

**Budget defaults (D-08) implication:** the cumulative time budgets in 1f (`fast 30s / balanced 60s / quality 120s`) are *latency* caps, adequate for LLM round-trips (ollama axios timeout is currently 5 min per call — the job deadline must be the shorter authority). They do not directly cap quota, but the same-account short-circuit plus `maxAttempts` bounds quota burn. Keeping `qwen3-vl-235b` **only in the `quality` chain** (reached only when three cheaper tiers all fail) is the primary quota protector.

> **[ASSUMED]** Exact free/Pro/Max numeric quotas are undocumented and change frequently. The runner logic must not depend on a specific number — it must react to the 429/quota *response*, which it does. Flag "confirm current subscription tier & observed quota headroom" as a live-key ops check before production, not a code blocker.

---

## PRIORITY 4 — Cascade Architecture

### Recommended module layout
```
lib/v1/cascade/
├── config.js     # chain, profiles, engine capability table, heuristic thresholds/bounds (D-01, CASC-09)
├── heuristic.js  # pure: computeConfidence(text,{overlay}) → [0,1]; passesThreshold; garbageRatio helpers (CASC-03)
├── runner.js     # runCascade(...) → { result, trace }; walk, fall-through, best-so-far, budget, quota short-circuit
└── trace.js      # buildTrace() / attempt-record shape (JOB-02)
```
`config.js` is a **JS module** (not JSON) per Claude's Discretion in CONTEXT — allows env-override helpers and inline rationale comments, and reuses the engine ids from `lib/models.js`.

### Runner signature & worker integration (D-11)
```js
// lib/v1/cascade/runner.js
async function runCascade({ base64, mimeType, profile, deadlineSignal, budgetMs }) {
  // returns { result: {text, overlay?, engineId, provider, confidence}, trace }
}
```

`lib/v1/worker.js#runJob` change (the only integration point):
- **Forced model** (`model` present in request) → **bypass**: call `runOCR` once (existing path), wrap single attempt in a one-element trace. (D-07/D-11)
- **No forced model** → build the profile chain, then call `runCascade`. The winning result populates the **unchanged** page-aware envelope: `pages[0] = { page:1, text, engine: winner.engineId, confidence: winner.confidence }`; top-level `text` mirrors `pages[0].text`; attach `trace`.
- Do **not** add a second Bottleneck limiter — the cascade runs inside the existing single slot.

**Chain assembly (D-09):** filter the profile's `chain` to engines whose `providerKeyPresent(model.provider)` is true (reuse `lib/v1/engines.js`). A missing key is a silent tier drop, not an error. If the filtered chain is empty → that only happens when zero engines configured, which the Phase-1 boot guard already prevents; defensively return a typed `failed{no_engine_configured}`.

### Single authoritative deadline (JOB-04)
Create one `AbortController` per job in `runJob` (or at the top of `runCascade`), `deadline = Date.now() + budgetMs`. Compose per-engine:
```js
const remaining = deadline - Date.now();
if (remaining <= cfg.minSliceMs) break;               // budget exhausted → stop (bounded)
const perEngineMs = Math.min(cfg.perEngineMs, remaining);
const signal = AbortSignal.any([ jobController.signal, AbortSignal.timeout(perEngineMs) ]);
await runOCR(model, base64, mimeType, apiKey, { ...opts, signal });
```
**Provider changes to accept `signal`:**
- `ocrspace.js`: replace the hardcoded `signal: AbortSignal.timeout(2*60*1000)` with the passed-in `signal` (or `AbortSignal.any([passed, AbortSignal.timeout(cap)])`).
- `ollama.js`: axios accepts `{ signal }` — pass it through; keep `timeout` as a backstop. On abort, axios throws `code:'ERR_CANCELED'`; map to a hard-failure fall-through.
`AbortSignal.any` and `AbortSignal.timeout` are native in Node 22. [VERIFIED: engines node>=22]

### Bounds (CASC-08)
Three independent caps, all in config: **max-tier** (implicit in the profile's `chain` length), **maxAttempts** (per profile), **cumulative budgetMs** (deadline). Runner stops on the first cap hit and records `stopped_reason`.

### Forced-engine capability validation (D-07, CASC-06)
Extend `config.js` with a capability table and validate the forced `model` in `router.js` **before enqueue** (reuse the existing typed-422 pattern). For Phase 2 the only real capability gate is provider-key-present (already enforced) + mode support (already enforced); `supports_structured` is a Phase-4 field — include the column now (`false` for ocrspace) so Phase 4 is additive. **Security note:** resolve `profiles[userProfile]` / `findModel(userModel)` via an **allowlist / `Object.hasOwn`**, never a bare `config.profiles[req.body.profile]` on a plain object (prototype-pollution / `__proto__` lookup risk).

---

## PRIORITY 5 — Trace Shape (JOB-02)

Extends the Phase-1 `result` envelope (worker currently emits `{ text, pages, engine, provider, mode, bytes_received }`). Add a `trace`:

```json
{
  "text": "…winning text…",
  "pages": [{ "page": 1, "text": "…", "engine": "ollama-gemini-3-flash", "confidence": 0.94 }],
  "engine": "ollama-gemini-3-flash",
  "provider": "ollama",
  "mode": "quality",
  "bytes_received": 84213,
  "trace": {
    "profile": "balanced",
    "engines_attempted": [
      { "engine": "ocrspace-engine2",       "provider": "ocrspace", "outcome": "low_confidence", "confidence": 0.12, "time_ms": 340,  "error": null },
      { "engine": "ollama-gemini-3-flash",  "provider": "ollama",   "outcome": "passed",         "confidence": 0.94, "time_ms": 2200, "error": null }
    ],
    "winning_engine": "ollama-gemini-3-flash",
    "low_confidence": false,
    "budget_ms": 60000,
    "elapsed_ms": 2540,
    "stopped_reason": "passed"
  }
}
```

- `outcome` vocabulary (per attempt): `passed | low_confidence | failed | skipped` (`skipped` for the same-account quota short-circuit; include `reason`). Aligns D-10.
- `stopped_reason` (job-level): `passed | budget_exhausted | max_tier | max_attempts | all_failed | provider_quota`.
- **`low_confidence: true`** when no engine cleared threshold and best-so-far was returned (CASC-04). In that case `winning_engine` = the engine with the highest observed confidence, and `pages[0].confidence` = that value.
- `error` on a failed attempt = the `mapErrorCode` code string (e.g. `"quota_exceeded"`), never a stack/secret (OPS-05).

`trace.js` owns building attempt records and the final trace so `runner.js` stays readable.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Compose job-deadline + per-engine timeout | Manual `setTimeout`+flag+`Promise.race` | `AbortSignal.any([jobSignal, AbortSignal.timeout(ms)])` | Native, actually aborts the socket, auto-cleans timers |
| Concurrency control | A second queue/limiter | Existing `bottleneck` slot | Cascade runs inside one worker slot; a second limiter risks double-queuing memory |
| Env parsing for thresholds | `Number(process.env.X)||d` | `intFromEnv` / new `floatFromEnv` | Phase-1 already learned this (WR-07); silent-NaN/negative bugs |
| OCR "gibberish" detection | Dictionary/ML classifier | Char-statistics (length + garbage-ratio) | Must be pure/deterministic/testable without keys (STATE risk-flag) |
| ocr.space confidence | Deriving a fake confidence from geometry | word-count bonus + text-quality signals | No confidence exists; a fabricated one would be a false signal |

**Key insight:** the cascade's hard parts are *decision purity* and *abort propagation*, both solvable with native primitives + one pure function. Resist adding libraries.

## Common Pitfalls

### Pitfall 1: Treating ocr.space geometry as confidence
**What goes wrong:** designing the threshold around a non-existent `MeanConfidence`; heuristic silently always-null on the "strongest" signal.
**How to avoid:** overlay yields **word count only**; primary judgment is text-quality. Verified: no confidence field. **Warning sign:** code path reads `word.Confidence` / `MeanConfidence` → those keys are always `undefined`.

### Pitfall 2: Wasting budget/quota on same-account LLM tiers after a 429
**What goes wrong:** gemini 429s (weekly cap) → runner still calls gemma then qwen → three 429s, burned latency, misleading trace.
**How to avoid:** on ollama `quota_exceeded`/`429`, skip remaining ollama tiers, return best-so-far. **Warning sign:** trace shows 3 consecutive `failed{quota_exceeded}` attempts.

### Pitfall 3: Per-provider timeout outliving the job deadline
**What goes wrong:** ollama's 5-min axios timeout keeps a socket open past the job budget; worker slot wedged (single concurrency ⇒ whole service stalls).
**How to avoid:** job `AbortSignal` is authoritative; per-engine timeout = `min(default, remaining budget)`; pass the signal into *both* providers (ocrspace currently ignores any external signal). **Warning sign:** a job's `elapsed_ms` exceeds its `budget_ms`.

### Pitfall 4: Code-unit vs code-point length (garbage-ratio skew)
**What goes wrong:** `text.length` counts UTF-16 units; emoji/CJK inflate length and dilute garbage-ratio, mis-scoring.
**How to avoid:** `[...text]` / `Array.from` for code-point counts; `normalize('NFC')` first.

### Pitfall 5: User-controlled `profile`/`model` key lookup on a plain object
**What goes wrong:** `config.profiles[req.body.profile]` with `profile:'__proto__'` returns the prototype; prototype-pollution surface.
**How to avoid:** allowlist (`Object.hasOwn(config.profiles, p)` or a `Set`/`Map`), reject unknown with typed 422.

### Pitfall 6: Breaking Phase-1 tests by changing the envelope shape
**What goes wrong:** `worker.test.js`, `v1-routes.test.js` assert the exact `result` shape (`pages[0]={page,text,engine,confidence}`). Adding fields is safe; renaming/removing is not.
**How to avoid:** `trace` is **additive**; keep `pages`/`text`/`engine` keys intact. Winning engine now fills `confidence` (was `null`) — check any test asserting `confidence === null` and update intentionally.

## Runtime State Inventory

Not a rename/refactor/migration phase — **section omitted** (greenfield feature addition over Phase-1 code; no stored data, live-service config, OS-registered state, secrets, or build artifacts carry a to-be-renamed string).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 22 (`AbortSignal.any`, `fetch`) | deadline propagation, ocr.space | ✓ (engines `>=22`) | 22.x | — |
| `axios` `^1.16` (signal support) | ollama abort | ✓ installed | 1.16.x | — |
| `OCR_SPACE_API_KEY` (runtime) | live cascade tier-1 + overlay calibration | ✗ at research time | — | Heuristic unit tests are pure (no key); live calibration deferred to ops |
| `OLLAMA_API_KEY` (runtime) | LLM tiers + quota confirmation | ✗ at research time | — | Same-account short-circuit tested with mocked 429; live quota check is an ops task |

**Missing dependencies with no fallback:** none block *implementation or unit tests* — the heuristic and runner logic are testable with pure inputs and mocked providers.
**Missing dependencies with fallback:** live-key calibration of thresholds and confirmation of current Ollama quota headroom are **ops/calibration tasks**, not code blockers. Flag both as `checkpoint:human-verify` before production.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | ocr.space returns **no** confidence at any level (overlay = geometry only) | P1a/P2 | If a paid tier *did* emit confidence, we'd miss a stronger signal — but design still works (word-count bonus). Verified 3× against official docs → low risk. Amend CONTEXT D-03 wording. |
| A2 | Heuristic weights (0.5/0.3/0.2) and thresholds (0.5/0.6/0.7) | P1d/P1e | Mis-calibration ⇒ clean docs escalate (cost) or garbage passes (quality). Mitigated by fixture suite + live calibration. This is THE tunable risk. |
| A3 | Ollama Cloud: 5h + 7-day windows, 429 on cap, 235B heaviest | P3 | Exact numbers undocumented/volatile. Runner reacts to the *response*, not a number → low code risk. Confirm tier headroom in ops. |
| A4 | Standard OCR-quality heuristics rely on char-statistics when confidence absent | P1b | General domain knowledge, not fetched this session. Low risk — our minimal signal set is defensible regardless. |
| A5 | `absMinChars=1` only (short valid results allowed) | P1c/P1e | A short legit result (e.g. `"OK"`) passes `fast` only; if callers expect a higher floor, raise `goodChars`. Tunable. |

**If confirmed:** A1 needs a one-line CONTEXT.md D-03 amendment; A2/A5 need the fixture-calibration task; A3 needs an ops verification checkpoint.

## Open Questions

1. **Should `balanced` include Gemma or stop at Gemini?**
   - Known: D-06 says "through gemma"; SC#1 wants cheap P50 winner.
   - Unclear: whether Gemma-tier escalation is worth its quota cost for the median doc.
   - Recommendation: keep 3-tier `balanced` as specced; the same-account short-circuit + tier-1 usually-passes keeps Gemma rarely reached. Revisit after live P50 data.

2. **Does forcing an engine bypass the confidence gate entirely?**
   - Recommendation: **yes** — forced = "run exactly this, return whatever it produces," single-attempt trace, no fall-through (D-07 "bypassing the cascade"). Confidence is still *computed and recorded* in the trace for observability, but does not trigger escalation.

3. **Expose thresholds in `GET /v1/models` profiles discovery?**
   - Recommendation: **no** — expose `{ id, default, description, engines: chainIds }` only. Thresholds are internal heuristics (REQUIREMENTS out-of-scope: don't freeze internals as API contract).

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (unchanged) | Phase-1 bearer auth covers `/v1`; no new auth surface |
| V4 Access Control | no | Single shared token; no per-resource ACL added |
| V5 Input Validation | **yes** | Validate `profile` / `model` against a config **allowlist** (`Object.hasOwn`/`Set`), typed 422 on unknown; already-present magic-byte sniff unchanged |
| V6 Cryptography | no | No new crypto |
| V7 Error/Logging | **yes** | Trace `error` = code string only; never log buffers/keys/full provider bodies (OPS-05 redaction already tested) |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prototype pollution via user `profile`/`model` key lookup | Tampering | Allowlist / `Object.hasOwn`; never index a plain object with raw user input |
| Secret/PII leak through the new trace field | Info Disclosure | Trace carries codes + timings + confidence only; provider raw errors normalized via `mapErrorCode`; existing pino redaction |
| Quota exhaustion (cost DoS) via forced-235B spam | DoS | Bounded queue (Phase-1) + maxAttempts + budget + same-account 429 short-circuit; 235B only in `quality` chain |
| Prompt injection | Tampering | Out of scope this phase (LLM prompt is fixed OCR instruction; `mode=structured` injection defenses are Phase-4 STR-03) |

## Sources

### Primary (HIGH confidence)
- `ocr.space/ocrapi` + `ocr.space/OCRAPI` — response schema; **no confidence field**; `isOverlayRequired` returns geometry only; `OCRExitCode`/`FileParseExitCode` value tables. [CITED]
- Phase-1 shipped code (read this session): `lib/models.js`, `lib/v1/engines.js`, `lib/v1/worker.js`, `lib/v1/router.js`, `lib/v1/errors.js`, `lib/v1/env.js`, `lib/v1/modes.js`, `lib/v1/jobs.js`, `lib/providers/ocrspace.js`, `lib/providers/ollama.js`, `lib/ocr.js`. [VERIFIED: direct read]
- `package.json` engines `>=22` → `AbortSignal.any`/`fetch` native. [VERIFIED]

### Secondary (MEDIUM confidence)
- dev.to "Ollama Cloud Free vs Pro (2026)" + corroborating community pages — 5h/7-day windows, usage-level 1–4 (235B heavy), GPU-time metering, 429 weekly-limit message. [CITED, exact numbers volatile]

### Tertiary (LOW confidence)
- General OCR post-processing "garbage detection" heuristics (char-ratio/length/replacement-char) — domain knowledge, not fetched this session. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Architecture & code integration: HIGH — based on direct read of shipped signatures, not guesses.
- ocr.space overlay correction: HIGH — verified 3×; materially changes D-03.
- Heuristic formula shape: HIGH — standard, pure, testable; **threshold numbers: LOW** — need live calibration.
- Ollama quota windows/behavior: MEDIUM — windows agreed by multiple sources; exact numbers undocumented (runner reacts to response, not numbers).

**Research date:** 2026-07-23
**Valid until:** ~2026-08-22 for architecture; ~7 days for Ollama quota specifics (fast-moving, per source's own caveat).
