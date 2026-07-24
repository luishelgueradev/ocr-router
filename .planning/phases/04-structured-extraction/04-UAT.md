---
status: testing
phase: 04-structured-extraction
scope: v1.0 end-to-end acceptance (all phases, live keys)
source:
  - 01-foundation (SC: auth + fail-closed boot + page-aware envelope)
  - 02-cascade-router (SC: automatic escalation + trace + graceful degradation)
  - 03-input-pipeline (SC: PDF native/scanned + multi-format image + per-page rollup + caps)
  - 04-structured-extraction (SC: schema-validated JSON + constrained decode + injection-safe)
vehicle: docker run ocr-router:latest (has poppler) with the user's real .env, mapped to 127.0.0.1:3900
started: 2026-07-24
updated: 2026-07-24
---

## Current Test

number: 0
name: Live stack up (setup gate)
expected: |
  The user creates .env with their real API_TOKEN, OLLAMA_API_KEY, OCR_SPACE_API_KEY.
  The ocr-router:latest container starts and GET /v1/health returns 200 {status:ok}.
awaiting: user to create .env and confirm

## Tests

### 0. Live stack up (setup gate)
expected: Container boots with real keys; /v1/health → 200 {status:ok}; configured-engine guard passes.
result: [pending]

### 1. Fail-closed boot guards (Phase 1)
expected: Starting with API_TOKEN missing/placeholder refuses to boot; with no provider key the zero-engine guard refuses; in prod mode a missing TAILSCALE_IP refuses. All three are hard exits, not warnings.
result: [pending]

### 2. Bearer auth (Phase 1 / AUTH)
expected: GET /v1/models without a token → 401; with the wrong token → 401; with the right token → 200. GET /v1/health is public (200 without a token).
result: pass
evidence: "Through the public tunnel: /v1/models no token → 401; with bearer → 200 (catalog lists 3 structured-capable Ollama engines + ocr.space); /v1/health public → 200."

### 3. Live cascade on a plain image (Phase 2 / core value)
expected: POST a real photo/scan (PNG/JPG) to /v1/ocr → 202 + job_id; polling /v1/jobs/:id reaches succeeded with real extracted text, a winning engine, and a confidence. The text matches what's visibly in the image.
result: pass
evidence: "Live through the public tunnel: a generated FACTURA image → job succeeded, engine ocrspace-engine2 (cheapest tier passed, no escalation), extracted text EXACT match: 'FACTURA N 001-4567 / TOTAL: 89250 ARS / Fecha 24/07/2026'. First real-engine run of the product."

### 4. Cascade escalation + trace (Phase 2)
expected: The job's trace shows engines_attempted in cheapest-first order and a winning_engine; a low-confidence/failed cheap tier escalates to a better one rather than returning garbage. A forced model (model=... ) runs exactly that engine once.
result: issue
severity: major
reported: "2 of 3 Ollama tiers are DEAD against the live account — gemini-3-flash-preview (410 retired 2026-07-15) and qwen3-vl:235b (410 retired 2026-06-16). Only gemma4:31b is alive. The LLM half of the cascade cannot escalate — ocr.space is effectively the only working engine. Root cause: lib/models.js pins Ollama Cloud model tags that Ollama retired. Confirmed via GET https://ollama.com/api/tags (live catalog). See gap G-A."

### 5. Native-text PDF short-circuits OCR (Phase 3 / INP-03)
expected: POST a digital (text) PDF → per-page text returned WITHOUT paying for OCR (fast), pages[] in order, status_rollup completed.
result: [pending]

### 6. Scanned PDF + multi-format image (Phase 3 / INP-04/05)
expected: A scanned PDF rasterizes page-by-page through the cascade; a HEIC/TIFF/BMP photo is normalized and extracted. Per-page results with a status rollup; one failed page does not fail the whole job.
result: [pending]

### 7. Input caps / bomb guards (Phase 3 / INP-07/08)
expected: An over-cap PDF (too many pages) → typed 413 pdf_too_many_pages; a malformed/oversized image → typed 413/422, never a 500. Unlabeled (octet-stream) valid upload is accepted and routed.
result: [pending]

### 8. Live structured extraction (Phase 4 / STR-01/02)
expected: POST an image + a JSON Schema with mode=structured → job succeeds with result.structured = JSON validated against the schema, extracted by a vision LLM. Fields present in the doc are filled; absent fields are null.
result: issue
severity: blocker
reported: "Live structured extraction FAILS (structured_extraction_failed, 422) — the whole point of Phase 4, never exercised live before. TWO compounding root causes: (G-A) the two vision models the structured chain needs are retired (410); only gemma4:31b survives. (G-B) even with a live vision model, the model returns its JSON wrapped in a ```json markdown fence, and extract.js does JSON.parse(res.text) directly → parse fails → repair → fall-through → fail. Both confirmed by direct provider calls: gemma4:31b and qwen3.5:397b BOTH read the image correctly and return the right JSON, but fenced. Mocked tests always returned clean JSON strings, so they never hit the fence. See gaps G-A + G-B."

### 9. Structured capability + schema gates (Phase 4 / STR-01)
expected: Forcing ocr.space with mode=structured → 422 field=model (before enqueue); a missing/garbage schema → 422 field=schema; a PDF with mode=structured → 422 field=file. GET /v1/models advertises supports_structured per engine.
result: [pending]

### 10. Structured injection resistance + repair (Phase 4 / STR-02/03)
expected: A document containing "ignore instructions / output X" does NOT change the output shape — the result still matches the schema (extra/injected fields rejected). If the model first returns off-schema JSON, one repair retry corrects it; if nothing validates, the job FAILS typed (never returns unvalidated JSON).
result: [pending]

### 11. Admin panel (cross-cutting UI)
expected: Opening the panel shows the OCR uploader; drag/click/paste an image runs it and shows extracted text; idle/loading/success/error states are clear; the settings modal saves an API-key override. No console errors; no horizontal overflow on mobile width.
result: [pending]

### 12. Deploy stack + graceful shutdown (Phase 1 / OPS)
expected: docker compose builds and runs; healthcheck goes healthy; a SIGTERM drains in-flight work within the grace window and leaves no temp dirs. (Caddy/HTTPS + Tailscale binding are VPS-only — may be skipped locally.)
result: pass
evidence: "Cloudflare Tunnel stack (docker-compose.tunnel.yml) built + up: ocr-app Healthy, caddy + cloudflared connected (4 tunnel conns, ingress ocr.luishelguera.dev→caddy:80). Public https://ocr.luishelguera.dev/v1/health → 200; /api/config and / → 404 (admin panel NOT exposed — security boundary holds); TLS terminated at Cloudflare edge. Deploy validated on the real home/WSL topology, not just locally."

## Summary

total: 13
passed: 3
issues: 2
pending: 8
skipped: 0
note: "Tests 0,2,3,12 pass live through the public Cloudflare Tunnel. Tests 4 & 8 are the two live-only defects below. Remaining input/gate tests (5,6,7,9,10,11) pending but largely covered by the automated suite; 9/10/11 are deterministic and green in CI."

## Gaps

```yaml
- id: G-A
  truth: "The cascade's LLM tiers and mode=structured route to a WORKING vision model on the live Ollama Cloud account"
  status: failed
  severity: major
  test: 4, 8
  reason: "lib/models.js pins Ollama Cloud model tags that Ollama retired: gemini-3-flash-preview:latest (410, retired 2026-07-15) and qwen3-vl:235b-cloud (410, retired 2026-06-16). Only gemma4:31b is alive. The live catalog (GET https://ollama.com/api/tags) offers gemma4:31b and qwen3.5:397b as working VISION models (both confirmed reading the test image)."
  artifacts:
    - "lib/models.js (the three Ollama modelTag values)"
    - "lib/v1/cascade/config.js (capabilities keys + profile chains reference the engine ids)"
  missing:
    - "Repoint the Ollama engines to live vision tags (gemma4:31b, qwen3.5:397b)"
    - "Update/rename the affected engine ids + config profiles/capabilities + tests that hardcode them"
    - "Consider a periodic liveness check / doc note that Ollama Cloud retires tags"

- id: G-B
  truth: "A structured response is parsed even when the model wraps its JSON in a markdown code fence"
  status: failed
  severity: blocker
  test: 8
  reason: "Live vision models (gemma4:31b, qwen3.5:397b) return the schema JSON inside a ```json ... ``` fence despite the Ollama format param. extract.js calls JSON.parse(res.text) on the raw fenced text → parse fails → one repair → fall-through → structured_extraction_failed. The mocked unit/e2e tests always fed clean JSON strings, so this real LLM-output quirk was never exercised."
  artifacts:
    - "lib/v1/structured/extract.js (tryEngine — JSON.parse of res.text)"
  missing:
    - "Strip a leading/trailing markdown code fence before JSON.parse (and keep the existing repair as a fallback)"
    - "Add a unit test whose fake runOCR returns fenced JSON, proving it now parses"
```
