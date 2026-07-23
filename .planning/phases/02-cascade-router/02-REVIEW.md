---
phase: 02-cascade-router
reviewed: 2026-07-23T00:00:00Z
depth: deep
files_reviewed: 12
files_reviewed_list:
  - lib/v1/cascade/config.js
  - lib/v1/cascade/heuristic.js
  - lib/v1/cascade/runner.js
  - lib/v1/cascade/trace.js
  - lib/v1/worker.js
  - lib/v1/router.js
  - lib/providers/ocrspace.js
  - lib/providers/ollama.js
  - lib/ocr.js
  - lib/v1/env.js
  - lib/v1/engines.js
  - lib/v1/errors.js
findings:
  critical: 1
  warning: 2
  info: 4
  total: 7
status: issues_found
---

# Phase 2: Code Review Report — Cascade Router

**Reviewed:** 2026-07-23
**Depth:** deep (cross-file: runner ↔ heuristic ↔ providers ↔ worker ↔ router)
**Files Reviewed:** 12 source files (+ 5 test files cross-referenced)
**Status:** issues_found

## Summary

Phase 2 is well-constructed: the heuristic is genuinely pure and config-driven,
prototype-pollution guards (`Object.hasOwn`) are consistent across every profile/
capability/model lookup, provider errors are normalized to `ok:false` fall-through
(verified by `test/provider-signal.test.js`), the trace only ever records code
strings (no keys/buffers), overlay is read as a scalar `overlay.wordCount` and never
fabricated into a confidence, and the deadline signal is genuinely threaded to both
`fetch` (ocr.space) and `axios` (ollama). Duplication was correctly collapsed into
`lib/v1/engines.js` + `lib/providers/util.js`.

One correctness defect defeats the product's stated core value ("never fail to return
the best available text"): the quota short-circuit uses `break`, so a rate-limited
FIRST tier (ocr.space — present in every profile chain and commonly rate-limited on
its free tier) terminates the whole cascade instead of escalating to the Ollama LLM
tiers that would succeed. This path is untested. Two medium issues concern the
renormalization floor letting near-empty LLM output halt fall-through, and the forced
path threading no job deadline into the provider. The rest are low-severity trace/enum
and classification nits.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Quota short-circuit `break` aborts the entire cascade, not just same-provider tiers

**File:** `lib/v1/cascade/runner.js:126-138` (the `break` at line 137)
**Issue:**
On a quota/rate-limit code the runner adds the provider to `skippedProviders`, records
the remaining *same-provider* tiers as skipped, then `break`s out of the whole loop:

```js
if (QUOTA_CODES.has(code)) {
  skippedProviders.add(model.provider);
  for (let j = i + 1; j < chain.length; j++) {
    if (chain[j].provider === model.provider) { recordAttempt(... 'skipped' ...); }
  }
  stoppedReason = 'provider_quota';
  break;                       // ← terminates the cascade, skipping OTHER providers too
}
```

`ocrspace-engine2` is the **first tier of every profile chain** (`config.js:43,49,55`).
ocr.space's free tier returns HTTP 403/429 on its daily/'per-minute rate limits, which
`mapErrorCode` maps to `quota_exceeded` / `rate_limited` (`errors.js:8-15`) — both in
`QUOTA_CODES` (`runner.js:25`). So when ocr.space is rate-limited, the runner `break`s
and **never tries the Ollama LLM tiers**, returning empty/degraded text even though a
downstream provider (different account, different key) would have produced the result.
That directly violates the phase's own focus requirement ("quota short-circuit only
skips SAME-provider tiers") and the product core value. The existing quota test only
exercises Ollama (the terminal provider group), so the ocr.space-first case is
uncovered (`test/cascade-runner.test.js:154`, no integration coverage).

**Fix:** Skip only the offending provider and continue the walk; let the top-of-loop
`skippedProviders.has()` guard record subsequent same-provider tiers as skipped:

```js
if (QUOTA_CODES.has(code)) {
  skippedProviders.add(model.provider);
  stoppedReason = 'provider_quota'; // provisional; overwritten by a later pass/bound
  continue;                          // fall through to OTHER-provider tiers
}
```

The top-of-loop block already records same-provider tiers as `skipped/provider_quota`
(`runner.js:81-87`), so the inner pre-record loop becomes redundant and should be
removed. The existing Ollama quota test still passes (gemma/qwen recorded skipped,
uncalled, best-so-far returned); add a case where `ocrspace-engine2` returns 429 and
assert an Ollama tier is still attempted.

## Warnings

### WR-01: Renormalization floor (0.625) lets near-empty / placeholder LLM output halt fall-through

**File:** `lib/v1/cascade/heuristic.js:78-86`; weights at `lib/v1/cascade/config.js:33`
**Issue:**
When overlay is absent (every LLM tier) the weighted average renormalizes over
`{printable:0.5, length:0.3}` (`wsum = 0.8`). For any garbage-free string, `printableScore = 1`,
so the score is `(0.5 + 0.3·lengthScore)/0.8`, with a hard **floor of 0.625** at
`lengthScore = 0`. This is a structural property of the formula, not a tunable constant:
`balanced` (0.60) and `fast` (0.50) sit *below* the floor, so they can never escalate
past an LLM tier that emits any non-garbage text. The Ollama prompt explicitly instructs
the model to emit `[ILEGIBLE]` for unreadable input (`ollama.js:13`); that 10-char string
scores `(0.5 + 0.3·0.6)/0.8 = 0.85` and passes even `quality` (0.70) — so an "I can't read
this" answer from the middle `gemini` tier stops the cascade and never escalates to the
higher-quality `gemma`/`qwen` tiers. Confirmed by fixtures: `single_char "a"` → 0.625 and
`near_empty "OK"` → 0.65 both pass `balanced` (`test/fixtures/heuristic/fixtures.js:74-84`).
This is partly the documented deferred-calibration deviation, but because it is a formula
floor (not just a threshold number) live-key threshold tuning alone cannot fix it for
`balanced`/`fast` without crossing 0.625.

**Fix:** Either (a) raise `length`'s weight relative to `printable` (e.g. `{printable:0.35,
length:0.45, overlay:0.2}`) so short text is genuinely penalized, or (b) add a soft
short-text penalty / minimum-length gate above `absMinChars` (e.g. treat `len < ~6`
words/chars as a distinct low band), or (c) detect the `[ILEGIBLE]` sentinel as a
non-content marker before scoring. Document the chosen shape so calibration only moves
the thresholds, not the fall-through envelope.

### WR-02: Forced path threads no job deadline into the provider — a hung engine wedges the single-concurrency worker

**File:** `lib/v1/worker.js:40-41` (`runForced`)
**Issue:**
`runForced` builds `opts` from the preset only and calls `runOCR(model, base64, mimeType,
apiKey, opts)` with **no `signal`** — unlike the cascade path, which composes a job
`AbortController` deadline (`worker.js:95-103`) and threads it through
(`runner.js:100-108`). A forced job therefore has no job-level budget; it is bounded only
by the provider's internal backstop — 5 minutes for axios/ollama (`ollama.js:42`), 2
minutes for ocr.space (`ocrspace.js:21`). Because the worker is `maxConcurrent:1`
(`worker.js:18-22`), a single hung forced provider blocks *all* queued jobs for up to 5
minutes with no way for a job budget to abort it earlier. Phase 2 introduced signal
threading for exactly this reason but did not wire it into the forced branch.

**Fix:** Wrap the forced call in the same authoritative deadline used by the cascade,
resolving the budget from the effective profile:

```js
const budgetMs = CONFIG.profiles[resolveProfileName(profile)].budgetMs;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), budgetMs);
if (timer.unref) timer.unref();
try {
  const opts = { ...(preset?.options ? { options: preset.options, prompt: preset.prompt } : {}),
                 signal: controller.signal };
  const result = await runOCR(model, base64, mimeType, apiKey, opts);
  ...
} finally { clearTimeout(timer); }
```

The provider adapters already normalize an abort to `ok:false`, so this stays a clean
failure path.

## Info

### IN-01: Forced path ignores `ocrExitCode:3` (all-pages-failed), succeeding with empty text

**File:** `lib/v1/worker.js:42-73` (`runForced`)
**Issue:** The cascade treats `res.ocrExitCode === 3` as a hard failure
(`runner.js:143-149`), but `runForced` only branches on `result.ok`. A forced
`ocrspace-engine2` that fails every page returns `ok:true, text:'', ocrExitCode:3`, so the
job is marked `succeeded` with empty text (confidence 0 → `low_confidence:true`) instead of
`failed`. Inconsistent with the cascade's contract for the same provider result.
**Fix:** In `runForced`, treat `result.ok && result.ocrExitCode === 3` as a failure via
`mapErrorCode({ error: 'ocr_all_pages_failed' })` (or reuse the runner's constant), matching
the cascade branch.

### IN-02: Latin-1 block garbage gate flags common Spanish ordinals ª/º/° as "bad" code points

**File:** `lib/v1/cascade/heuristic.js:37`
**Issue:** `isBadCodePoint` flags the entire `0xA0–0xBF` block except `¡`(0xA1)/`¿`(0xBF).
That block includes `ª`(0xAA), `º`(0xBA) and `°`(0xB0) — legitimate, frequent Spanish
characters ("1.º", "3.ª", "20°"). They contribute to `garbageRatio` and depress
`printableScore`. Impact is low because the hard gate needs >30% bad and real text dilutes
them, but a short field like `"3.ª"` is disproportionately penalized.
**Fix:** Exclude `0xAA`, `0xBA`, `0xB0` (and consider `§`0xA7, `©`0xA9) from the bad set, or
narrow the flagged sub-range, so only the true mojibake symbols remain gated.

### IN-03: `maxAttempts` bound is vacuous — it equals chain length in every profile

**File:** `lib/v1/cascade/config.js:46,52,58`; check at `lib/v1/cascade/runner.js:90`
**Issue:** Every profile sets `maxAttempts` equal to its `chain.length` (fast 2/2, balanced
3/3, quality 4/4). Since a non-skipped attempt increments once per tier and the `for` loop
already bounds on `chain.length`, `attempts >= prof.maxAttempts` can never trigger before
the loop exhausts — the CASC-08 attempt bound provides no independent protection and
`stopped_reason: 'max_attempts'` is unreachable. Not a bug, but the bound is currently
dead configuration.
**Fix:** Either set `maxAttempts` strictly below chain length where an independent cap is
intended (e.g. balanced `maxAttempts:2` to stop before the most expensive tier), or drop the
field and document that chain length is the attempt bound.

### IN-04: Trace `stopped_reason` enum drifts from the implementation

**File:** `lib/v1/cascade/trace.js:16` (documented enum) vs. producers
**Issue:** The documented enum is `{ passed | budget_exhausted | max_tier | max_attempts |
all_failed | provider_quota }`, but the code emits `'no_engine_configured'`
(`runner.js:63`) and `'forced'` (`worker.js:58`), which are absent from the doc, while
`'max_tier'` and `'max_attempts'` are documented but never produced (see IN-03). Downstream
consumers keying on the enum could mishandle the undocumented values.
**Fix:** Reconcile the enum comment with the actual set of emitted reasons (add
`no_engine_configured`, `forced`; remove `max_tier`; keep/remove `max_attempts` per IN-03).

---

_Reviewed: 2026-07-23_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
