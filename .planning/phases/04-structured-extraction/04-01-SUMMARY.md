---
phase: 04-structured-extraction
plan: 04-01
status: complete
completed: 2026-07-24
requirements: [STR-01, STR-02, STR-03]
commits:
  - 6c191b7 feat(04): mark the Ollama engines structured-capable + a capability-filtered chain
  - 55f547d feat(04): bounded client-schema guard, ajv validator, repair-error formatter
  - 257eb29 feat(04): ollama constrained-decoding via opts.format + injection-safe structured prompt
  - e12acaf feat(04): structured runner — constrained decode, ajv-validate, one repair, fall-through
  - 53e1ed4 feat(04): route + worker wiring for mode=structured with an additive envelope
  - 85c7618 test(04): surface supports_structured in GET /v1/models for client discovery
  - 1243718 test(04): cover the structured HEIC normalize branch end to end
---

# Plan 04-01 Summary — Structured Extraction (MVP)

`mode=structured` extracts schema-validated JSON from a single document image via
a vision LLM with constrained decoding, one bounded repair retry, and an
injection-safe delimited-data prompt. `runCascade` is untouched — structured is a
dedicated worker path whose pass criterion is ajv validation.

## Delivered

| Task | Artifact | What |
|---|---|---|
| 1 | `lib/v1/structured/capability.js` + config flip | Ollama engines structured-capable; ocr.space not; `structuredChain(profile)` declarative filter |
| 2 | `lib/v1/structured/schema.js` | Untrusted client JSON Schema → bounded (root type:object, 64 KiB, depth 12) ajv validator or typed 422; `formatErrors` for the repair prompt |
| 3 | `lib/providers/ollama.js` + `lib/v1/structured/prompt.js` | `opts.format` → constrained decoding; injection-safe prompt; free-text path byte-unchanged |
| 4 | `lib/v1/structured/extract.js` | `runStructured`: walk the structured chain, per engine constrained-decode→validate→one repair→fall-through; typed failure; never unvalidated JSON |
| 5 | `lib/v1/router.js` + `lib/v1/worker.js` + `input-support.js` | schema/capability/input gates before enqueue; `runStructuredJob` dispatch; additive `structured` envelope |
| 6 | `GET /v1/models` | `supports_structured` per engine for client discovery |

New deps: `ajv@^8.20.0` (the client-authored-JSON-Schema case, not the server-schema zod case).

## Verification

3/3 success criteria and STR-01/02/03 — see `04-VERIFICATION.md`. Host suite
406/0/2-skipped; in-container structured 38/38 and input e2e 10/10 (0 skipped) on
a rebuilt image; audit clean; `node --check` clean; Docker build succeeds with the
memory cgroup enforced. Every new test proven against the boundary it guards.

## Deviations from plan

None material. The plan's Task 6 also gained an end-to-end HEIC-normalize e2e
(the D-S9 `normalize` branch was otherwise only reasoned about) — a test-only
addition found during the post-execution review.

## Follow-ups (in PENDING-ISSUES.md)

- ReDoS via a client `pattern` (bounded today; worker-thread compile-with-timeout is the complete fix).
- Multi-page structured extraction (deferred; PDF/multi-frame typed-rejected now).
- Admin panel does not expose structured mode (API-only this milestone).
