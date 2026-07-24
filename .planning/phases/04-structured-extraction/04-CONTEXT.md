# Phase 4: Structured Extraction - Context

**Gathered:** 2026-07-24
**Status:** Ready for planning
**Mode:** `--auto` (decisions auto-selected from the pinned stack in CLAUDE.md, the STR requirements, the Phase-4 success criteria, and the shipped Phase 1/2 codebase — the operator is away and authorized deciding by the established stack, UI style, and priorities)

<domain>
## Phase Boundary

A client requests `mode=structured` with a **schema** and gets back **JSON validated against that schema**, extracted by a **vision LLM** with constrained decoding. ocr.space is excluded by capability. Invalid model output triggers exactly **one** bounded repair retry before failing typed — unvalidated JSON is never returned. Document content reaches the model as **delimited data, never instructions** (prompt-injection mitigation), and absent fields come back `null` rather than fabricated.

Covers: **STR-01, STR-02, STR-03**. 

**Depends on Phase 2 (cascade), independent of Phase 3 (input pipeline).** Structured mode therefore operates on the **single-image** surface Phase 2 established (the base64 image a vision LLM consumes directly). PDFs and the Phase-3 multi-format/multi-frame inputs are OUT OF SCOPE for structured mode in this milestone and are rejected with a typed error — keeping Phase 4 a thin increment that reuses the finished cascade unchanged.

Does NOT: modify `runCascade` (the confidence-scored text path stays byte-for-byte); add per-page structured extraction; add a structured UI beyond a minimal, additive admin-panel affordance if trivial.
</domain>

<decisions>
## Implementation Decisions

### Schema transport & source of truth (STR-01)
- **D-S1:** The client supplies a **JSON Schema object** as a multipart form field `schema` (a JSON string), alongside the file. Rationale: Ollama's `format` parameter *is* a JSON Schema, and the schema is **client-authored** — so it is "hand-written JSON Schema" from our side. Per CLAUDE.md's stack table that is exactly the `ajv` case, NOT the `zod`/`z.toJSONSchema()` case (which is for **server**-authored schemas). No zod at runtime.
- **D-S2:** Validate the model's JSON against that same schema with **`ajv@^8`** (CLAUDE.md-pinned). One compiled validator per job, reused for the initial attempt and the repair retry.

### Constrained decoding + validation + repair (STR-02)
- **D-S3:** Send the client schema to Ollama `/api/chat` as the **`format`** field — schema-constrained decoding, which the docs confirm works with vision models. This is the primary guarantee that output shape matches the schema.
- **D-S4:** After decoding, **validate with ajv**. On failure, perform **exactly one** repair retry, feeding the ajv error list back into the prompt as correction guidance. A second failure on an engine falls through to the next structured-capable engine; if none pass, fail with a typed `structured_extraction_failed` (422). **Unvalidated JSON is never returned** — the envelope's `structured` field is only ever an ajv-validated object.

### Engine capability & cascade reuse (STR-01)
- **D-S5:** Flip the three **Ollama** engines to `supports_structured: true` in `config.js`; **ocr.space stays `false`**. Structured mode routes only over structured-capable engines. **Forcing `ocrspace-engine2` with `mode=structured` → typed 422** (capability gate, before enqueue).
- **D-S6:** Structured mode is a **dedicated worker path** (`runStructuredJob`) that reuses the provider seam (`runOCR`) and the profile chain config, filtered to structured-capable engines. It does **NOT** touch `runCascade` — the "pass" criterion here is *schema validation*, not the confidence heuristic, so conflating them would risk the proven text path. Fall-through across structured engines mirrors the cascade's "never fail to return the best available" value.

### Prompt-injection mitigation & null discipline (STR-03)
- **D-S7:** The document image is passed on the model's **image channel** (`images: [base64]`), never interpolated into the prompt — it is data by construction. The prompt explicitly frames the image as **untrusted content**, forbids following any instructions found inside it, and instructs **`null` for any field not present in the document** (no fabrication). Constrained decoding (`format`) enforces the shape regardless of what the document says, which is the strongest injection mitigation.

### Client-schema safety (hardening)
- **D-S8:** A client-supplied JSON Schema is untrusted input. Guard before compiling: **root must be `type: "object"`**, reject non-object/malformed JSON (422 `invalid_parameter` field=`schema`), and bound **serialized size** and **nesting depth** so a pathological schema cannot exhaust the single-concurrency worker. `ajv` is constructed with safe defaults (no `$data`, no remote `$ref`). The residual ReDoS-via-`pattern` surface (ajv compiles client regexes) is bounded by the job deadline + small `num_predict` output and logged as a hardening follow-up, not solved in this MVP.

### Input scope (thin increment)
- **D-S9:** Structured mode accepts the **vision-ready single-image** inputs (sniffed PNG/JPEG/WebP directly; HEIC/BMP normalized via the existing Phase-3 `normalizeFrames` single-frame path so a phone photo still works). **PDF and multi-frame TIFF/GIF in structured mode → typed 422 `structured_unsupported_input`** for this milestone (multi-page structured extraction is a future phase). This keeps Phase 4 within its "depends on Phase 2, independent of Phase 3" boundary while not gratuitously rejecting a single HEIC/BMP photo.

### Response envelope (additive)
- **D-S10:** The job result gains an additive **`structured`** field (the validated object) plus `engine`/`provider`/`mode: 'structured'`. The existing text-path envelope is unchanged. `GET /v1/jobs/:id` returns it as-is.
</decisions>

<specifics>
## Specific Ideas

- Reuse the exact request→queue→worker→envelope wiring Phase 3's E2E test now covers; structured mode is a new branch in the worker dispatch, not a new endpoint.
- The structured prompt is a constant template (no client string interpolated into the instruction region — only the ajv error list on the repair retry, itself a controlled server-produced string).
- Keep the ocr.space exclusion declarative (the `supports_structured` flag already in `config.js`), not a hardcoded engine-id check.
</specifics>

<canonical_refs>
## Canonical References

- `CLAUDE.md` — "Structured Extraction Pattern (`mode=structured`)": Ollama `format` constrained decoding (incl. vision), one schema as source of truth, bounded repair retry. Stack table: `ajv@^8.20.0` for hand-written JSON Schema; `zod` only for server-authored schemas.
- `.planning/REQUIREMENTS.md` — STR-01/02/03.
- `.planning/ROADMAP.md` — Phase 4 goal + success criteria.
- Ollama docs — `/api/chat` `format` (JSON Schema) structured outputs with vision models.
</canonical_refs>
