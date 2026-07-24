# Phase 4: Structured Extraction — Research

**Researched:** 2026-07-24 · targeted (thin MVP increment, not a domain survey)

## 1. Ollama structured outputs (`format`) — the constrained-decoding primitive

`POST https://ollama.com/api/chat` accepts a top-level **`format`** field set to a
**JSON Schema object**. The model is then constrained to emit JSON matching that
schema; the docs confirm this **works with vision models**, which is exactly our
case (image on the `images` channel + schema on `format`).

Request body the provider will send (extends the existing ollama.js call):

```json
{
  "model": "qwen3-vl:235b-cloud",
  "stream": false,
  "messages": [{ "role": "user", "content": "<structured prompt>", "images": ["<base64>"] }],
  "format": { "type": "object", "properties": { ... }, "required": [ ... ] },
  "options": { "temperature": 0, "num_predict": 4096 }
}
```

Response: the JSON arrives as a **string** in `response.data.message.content`, which
we `JSON.parse` then ajv-validate. `temperature: 0` for determinism.

**Pitfall:** `format` constrains *shape*, not *truthfulness* — the model can still
put a plausible-but-wrong value in a required field. That is why STR-03's "null for
absent fields" lives in the **prompt**, and why validation + a human-meaningful
schema (nullable fields) matter. Constrained decoding removes the "reply with JSON"
unreliability, not the need to validate.

## 2. ajv v8 — validator (VERIFIED with real calls, not from memory)

```js
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);   // may THROW on a malformed schema → try/catch
const ok = validate(data);              // boolean
validate.errors;                        // [{ instancePath, message, keyword, params }]
```

Verified behaviors this phase depends on:
- `{ total: { type: ["number","null"] } }` accepts both `42` and `null` → nullable fields work, backing STR-03's null discipline.
- On failure, `errors` gives `instancePath` + `message` (`"must have required property 'name'"`, `"must be number,null"`) — a compact, model-readable correction list for the ONE repair retry.
- `additionalProperties:false` yields a precise `must NOT have additional properties` error.
- **`ajv.compile` does NOT reject a non-object root** (`{type:"string"}` compiles fine) — so **D-S8's `type:"object"` root guard is ours to enforce**, not ajv's.
- `new Ajv({strict:false})` tolerates the loose schemas real clients write; `allErrors:true` returns the full error set for a single, complete repair prompt.

**Security defaults:** construct ajv with no `$data` and do not register remote
`$ref` loaders, so a client schema cannot pull a remote document or use `$data`
references. Root-guard + size/depth bounds (D-S8) run BEFORE `ajv.compile`.

## 3. Where this bolts onto the shipped code (seams already in place)

- `lib/v1/cascade/config.js` — `capabilities[*].supports_structured` already exists, all `false`. Flip the three Ollama engines to `true`; ocr.space stays `false`. **No schema change** — the architecture pre-wired this (config.js:66-72 comment).
- `lib/ocr.js` / `lib/providers/ollama.js` — `runOCR(model, base64, mime, key, opts)` already threads an `opts` bag (`signal`, `options`, `prompt`). Add `opts.format` (→ body.format) and a structured prompt selector. ocr.space provider is untouched (it never runs structured).
- `lib/v1/router.js` — mode/profile/forced resolution already here; add `schema` parsing + the structured capability gate (ocr.space forced + structured → 422) before enqueue.
- `lib/v1/worker.js` — `runJob` already dispatches forced / cascade / input paths; add a `runStructuredJob` branch. `runCascade` is NOT touched (D-S6).
- Envelope — `jobs.complete(jobId, result)` stores an arbitrary result object; adding a `structured` field is additive (jobs/router unchanged).

## 4. Testing approach (no network, no keys)

- **ajv/schema unit** — real ajv, no mocks: root guard, size/depth bounds, valid/invalid/null cases, error-shape for the repair prompt.
- **provider unit** — monkey-patch `axios.post` via `require.cache` (the established `test/provider-signal.test.js` pattern) to assert the request carries `format` and the structured prompt, and that a returned JSON string is surfaced.
- **structured-extract unit** — inject a fake `runOCR` (the `require.cache` swap used by `test/cascade-runner.test.js` / `test/worker-input.test.js`) to drive: first-try-valid, invalid-then-repaired, invalid-twice-then-fall-through, all-fail-typed-error, injection-attempt-ignored, absent-field-null.
- **E2E over HTTP** — extend the `test/e2e-input-http.test.js` harness: POST multipart image + `schema`, poll to terminal, assert the `structured` envelope; a forced ocr.space + structured → 422 at submit; a garbage-declared schema → 422 field=`schema`.

## 5. Deliberately out of scope (recorded, not silently dropped)

- **PDF / multi-frame structured extraction** — D-S9 rejects them typed; multi-page structured is a future phase (would need per-page schema semantics).
- **ReDoS via a client `pattern`** — ajv compiles client regexes; bounded here by the job deadline + small `num_predict`, logged as a hardening follow-up.
- **zod / `z.toJSONSchema()`** — that path is for **server**-authored schemas; ours are client-authored JSON Schema, so ajv is the correct tool per CLAUDE.md.
