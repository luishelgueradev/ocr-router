---
phase: 04-structured-extraction
verified: 2026-07-24
status: passed
score: 3/3 success criteria verified (3/3 requirements satisfied)
method: goal-backward, evidence re-run (not cited) — full suite + in-container build
---

# Phase 4 Verification — Structured Extraction

Goal-backward check against the ROADMAP success criteria. Every number here was
re-run this session, not carried from a plan. Provider calls are stubbed (no
network/keys); everything from the multipart boundary through ajv validation and
the envelope is real.

## Evidence base

| Gate | Result |
|---|---|
| Host suite | **406 passed / 0 failed / 2 skipped** (the two poppler-gated input-PDF e2e cases) |
| In-container structured suite | **38/38, 0 skipped** (rebuilt image incl. ajv) |
| In-container input e2e (PDF real) | **10/10, 0 skipped** |
| `npm run audit` | 0 vulnerabilities |
| `node --check` all source | clean (no eslint/tsc configured in this plain-JS project) |
| Docker build | succeeds; `mem_limit` cgroup still enforced (`memory.max=1073741824`) |

## Success Criteria

### SC1 — validated JSON via a vision LLM; ocr.space excluded; forcing it → typed error
**PASS.**
- `test/e2e-structured-http.test.js` "PNG + schema → validated structured envelope": a real multipart POST with `mode=structured` + a JSON Schema returns a job whose `result.structured` is the ajv-validated object, `engine: 'ollama-gemini-3-flash'`, `provider: 'ollama'`, `mode: 'structured'`.
- ocr.space exclusion is **declarative**: `capabilities['ocrspace-engine2'].supports_structured === false` → `structuredChain(profile)` drops it for every profile (`test/structured-capability.test.js`).
- Forcing it: `test/e2e-structured-http.test.js` "forcing ocr.space with mode=structured → 422 field=model", asserted **before enqueue** (`ocrCalls.length === 0`).

### SC2 — constrained decoding + validation; exactly one repair retry; never unvalidated JSON
**PASS.**
- Constrained decoding: `test/structured-provider.test.js` asserts the request carries `body.format = <schema>`; `test/e2e-structured-http.test.js` asserts `ocrCalls.every(hasFormat)`.
- Validation + single repair: `test/structured-extract.test.js` "invalid then repaired" asserts **exactly two** calls to the same engine with the repair prompt carrying the failing field; "invalid twice → fall through" asserts the ordered call log across engines.
- Never unvalidated: "nothing validates across the whole chain → typed `structured_extraction_failed` (422)" (6 calls, throws); e2e "no output validates → job **fails** typed, `result` undefined". A `JSON.parse` failure is handled like a validation failure, not a crash.

### SC3 — delimited data, injection-resistant, null-not-fabricated
**PASS.**
- Delimited data: `test/structured-provider.test.js` asserts the document rides `messages[0].images`, and the base64 is **not** interpolated into the prompt.
- Injection: `prompt.js` frames the image as untrusted and forbids following in-image instructions; `test/structured-extract.test.js` "an output echoing an in-image injection is still gated by the schema" — an extra `system` field (from a tricked model) fails `additionalProperties:false` and never reaches the client. Constrained decoding enforces shape regardless of document content.
- Null discipline: "an absent field returned as null validates" — a nullable field accepts `null`, no coercion/fabrication.

## Requirements

| Req | Status | Where |
|---|---|---|
| STR-01 | SATISFIED | capability flip + `structuredChain`; router capability gate; SC1 evidence |
| STR-02 | SATISFIED | ollama `format`; ajv validate + one repair + fall-through; SC2 evidence |
| STR-03 | SATISFIED | image channel + injection-safe prompt + null discipline; SC3 evidence |

## Scope boundaries honored (D-S9)

- `runCascade` is **byte-for-byte unchanged** — structured is a separate worker path whose pass criterion is schema validation, not the confidence heuristic. The full text/cascade/input suites stayed green (no regression).
- Structured mode is **single-image** this milestone: png/jpeg/webp direct; heic/bmp normalized to one PNG frame (covered end-to-end by the HEIC e2e); PDF and multi-frame tiff/gif → typed 422 field=file before enqueue.

## Residuals (logged, not blocking)

- **ReDoS via a client `pattern`** — ajv compiles client regexes; bounded by the job deadline + small `num_predict` and the 64 KiB / depth-12 schema caps. A worker-thread compile with a timeout is the complete fix; logged in `PENDING-ISSUES.md`.
- **Multi-page structured extraction** — deferred to a future phase (per-page schema semantics); PDF/multi-frame are typed-rejected today.
- **Admin panel** does not yet expose `mode=structured` (API-only this milestone) — see the UI review.

## Review pass (post-execution, per operator instruction)

- **Duplication:** the timer/deadline pattern in `runStructuredJob` mirrors the three existing worker paths; extracting it would touch passing code (declined per instruction). No new duplication introduced.
- **Error handling:** typed 413/422 decoder/extraction errors surface as themselves; everything else is a generic `internal_error` with no detail leaked (OPS-05). Verified the `structured` envelope breaks no envelope consumer (`jobs.complete` is shape-agnostic; the `result.text`/`result.pages` reads are all local vars of other paths).
- **Edge cases:** missing/garbage/non-object/oversize/over-deep schema; missing provider key (chain drop); forced structured-capable model; JSON.parse failure; injection echo; null fields — all covered.

_Verified: 2026-07-24 · goal-backward, evidence re-run._
