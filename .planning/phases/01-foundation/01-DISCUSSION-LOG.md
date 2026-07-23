# Phase 1: Foundation — Discussion Log

**Mode:** `--auto` (autonomous run; decisions selected from established stack, requirements, and reference implementation. User absent by instruction.)

## Areas auto-decided

| Area | Question | Selected (recommended default) | Grounding |
|------|----------|-------------------------------|-----------|
| Port strategy | Port reference modules verbatim or rewrite? | Port `lib/v1/*` as-is, minimal edits | PROJECT.md "reuse reference base" |
| Terminal status | `completed` (reference) vs `succeeded` (requirements)? | `succeeded` | REQUIREMENTS API-04, ROADMAP SC#1 |
| Envelope shape | How to make single-image result page-aware? | `result.pages[]` (1 elem) + concatenated `text`; per-page `engine`/`confidence` stubs | JOB-01, Phase-2 additivity |
| Upload field | Keep `image` or rename? | `file` (documents, future PDF) | PROJECT.md "submits a document" |
| Content types | Which inputs in Phase 1? | PNG/JPEG/WebP only, magic-byte sniff | INP-01, INP-02 |
| Engine selection | Required `model` or default? | `model` optional; default engine; no cascade yet | ROADMAP phase boundary (cascade = Phase 2) |
| Admin surface | Include demo UI? | Port `public/index.html`, Tailscale-bound admin, Caddy exposes only `/v1/*` | OPS-02, OPS-03, PROJECT out-of-scope |
| Base image / deps | Node + system packages? | `node:22-bookworm-slim` + `poppler-utils` + `tini` (poppler early) | OPS-01, STACK.md |
| Verification | Lint/typecheck/build? | `node --test` only; no lint/tsc (none in reference); build = docker compose build | reference package.json |

## Deferred
Cascade (P2), PDF/multi-format (P3), structured extraction (P4), ocr.space overlay confidence (P2).

## Scope creep
None surfaced.
