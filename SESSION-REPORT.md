# Session Report — 2026-07-24

Resumed after an interrupted session, then took the milestone to feature-complete.
Everything below is re-run evidence, not cited numbers.

## Headline

- **Milestone v1.0 is feature-complete**: all 4 phases done. Phase 4 (Structured
  Extraction) built this session via the GSD workflow (discuss → research → plan →
  execute) and verified goal-backward.
- **Host suite: 406 passed / 0 failed / 2 skipped** (the two skips are the
  poppler-gated input-PDF e2e cases, which run green in the container).
- **In-container**: structured e2e 38/38, input e2e 10/10, Docker smoke 8/8 — all
  0 skipped, on a rebuilt image. `npm audit` 0 vulnerabilities. `node --check`
  clean. Docker build succeeds with the memory cgroup enforced. Working tree clean.

## 1. Fix carried over from the previous session — octet-stream uploads

The multer `fileFilter` refused `application/octet-stream` (and empty Content-Type)
before the authoritative sniff, rejecting valid documents from clients that don't
label their upload — the common n8n binary-payload shape. Fixed: the unlabeled-
binary case is admitted and the sniff decides; an explicitly-declared non-document
type (SVG, text/plain) is still refused early. Two e2e + two unit cases, all
non-vacuous. (`b5390b5`)

## 2. Phase 4 — Structured Extraction (GSD: discuss → research → plan → execute)

`mode=structured` extracts schema-validated JSON from a single document image via a
vision LLM. Artifacts: `04-CONTEXT.md`, `04-RESEARCH.md`, `04-01-PLAN.md`,
`04-01-SUMMARY.md`, `04-VERIFICATION.md`.

Decisions taken autonomously per the established stack (client-authored JSON Schema
→ Ollama `format` constrained decoding → **ajv** validation → one bounded repair
retry; zod is for server schemas, so ajv was the correct pick per CLAUDE.md).

Delivered across 7 atomic commits (`6c191b7`…`1243718`):
- Ollama engines marked structured-capable; ocr.space excluded declaratively; a
  capability-filtered chain.
- Bounded untrusted-schema guard (root type:object, 64 KiB, depth 12) → ajv
  validator or typed 422; repair-error formatter.
- Provider constrained decoding via `opts.format`; injection-safe delimited-data
  prompt (image on the image channel, never the prompt; null for absent fields).
- Structured runner: constrained-decode → validate → exactly one repair → fall
  through the structured chain → typed failure; never returns unvalidated JSON.
- Router/worker wiring with an additive `structured` envelope; `runCascade`
  untouched. `GET /v1/models` advertises `supports_structured`.

**Verification: 3/3 success criteria + STR-01/02/03**, goal-backward — see
`04-VERIFICATION.md`. Every new test proven against the boundary it guards (e.g.
the ocr.space-exclusion, the exactly-one-repair count, the injection-echo
rejection, the null-field acceptance).

## 3. Corrections made during the reinforced post-execution review

The operator asked for tests + linter + typecheck + build + a duplication/error/
edge-case review after each execution.

- **tests / audit / build**: all green (see Headline).
- **linter / typecheck**: none configured in this plain-JS project (no eslint,
  no tsconfig — deliberate per CLAUDE.md). Used `node --check` on all source as
  the available parse gate — clean. No linter was fabricated.
- **Review findings acted on (1 cycle, no defect required a second):**
  - Coverage gap: the D-S9 `normalize` branch (HEIC/BMP in structured mode) was
    only reasoned about — added an end-to-end HEIC test that exercises the real
    heic-convert→sharp normalize before extraction (`1243718`). Test-only.
  - Verified the additive `structured` envelope breaks no consumer (`jobs.complete`
    is shape-agnostic; the `result.text`/`result.pages` reads are all local vars of
    other paths).
  - Duplication: the timer/deadline pattern in `runStructuredJob` mirrors the three
    existing worker paths; extracting it would touch passing code, so it was left
    per the "don't touch what already passes" rule.

## 4. UI review (Playwright, admin panel at 1440 / 768 / 375)

Screenshots captured at all three widths (idle, error, settings modal). Console and
basic a11y evaluated.

**Low-risk fixes applied inline (`419ede3`):**
- **Mobile 375 header overflow** (real bug): `flex justify-between` didn't wrap, so
  the model `<select>` ran off-viewport and the settings gear was pushed off-screen.
  Header now wraps and the select shrinks/truncates. Verified: no horizontal
  overflow at 375 (`scrollWidth === viewport`).
- **favicon.ico 404** (the only console error): inline SVG favicon → 0 console
  errors.
- **Basic a11y**: aria-labels on the model select and gear; the dropzone is now a
  keyboard-operable `role=button` (tabindex 0, Enter/Space opens the picker, focus
  ring) — additive, existing click/drag/paste unchanged. Verified focusable.

**Structural items → `UI-IMPROVEMENTS.md` (not changed):** Tailwind-from-CDN
(offline/CSP risk on the Tailscale-bound panel), password-inputs-in-a-`<form>`, and
the feature gap where the admin UI does not yet expose the cascade profiles or
`mode=structured`.

**Healthy:** consistent visual language; all interaction states present and
distinct (idle/empty, processing, success, error); clean layout at 1440/768; solid
settings modal.

## 5. Pending / deferred (all in `PENDING-ISSUES.md`)

- **[P4] ReDoS via a client-schema `pattern`** — bounded today (job deadline + small
  `num_predict` + 64 KiB/depth-12 caps); complete fix is a worker-thread compile
  with a timeout.
- **[P4] Multi-page structured extraction** — deferred by design; PDF/multi-frame
  are typed-rejected in structured mode this milestone.
- **[P4] Admin panel does not expose structured mode** — API-only this milestone
  (also in `UI-IMPROVEMENTS.md`).
- **[P3] Human-Verification #3** — enforce `RASTER_MAX_DIM² ≤ MAX_OUTPUT_PIXELS` at
  boot vs. keep it an operator convention (unchanged).
- Five Info findings in `03-REVIEW.md` (unchanged).

## 6. Commits this session (newest first)

```
5851233 docs(ui): log structural admin-panel improvements
419ede3 fix(ui): low-risk admin-panel fixes from the Playwright review
97d6951 docs(04): verification, summary, and milestone state
1243718 test(04): cover the structured HEIC normalize branch end to end
85c7618 test(04): surface supports_structured in GET /v1/models
53e1ed4 feat(04): route + worker wiring for mode=structured
e12acaf feat(04): structured runner — decode, validate, one repair, fall-through
257eb29 feat(04): ollama constrained-decoding + injection-safe prompt
55f547d feat(04): bounded client-schema guard + ajv validator
6c191b7 feat(04): structured-capable engines + capability-filtered chain
84163c3 docs(04): plan Structured Extraction; add ajv
7f10973 docs(quick-260724-64d): mark octet-stream item resolved
b5390b5 fix(quick-260724-64d): admit unlabeled uploads so the sniff can decide
```
(plus the earlier quick-task 260724-64d commits from this session: G-1, G-2,
monotonic clock, temp-root race, HTTP e2e — see `git log`.)

## 7. How to reproduce the evidence

```
npm test                              # 406 pass / 0 fail / 2 skip (host)
npm run audit                         # 0 vulnerabilities
REBUILD=1 bash scripts/docker-smoke.sh                        # 8/8 in-container
docker run --rm --network none -v "$PWD/test":/app/test:ro -w /app \
  ocr-router:latest node --test test/e2e-structured-http.test.js  # 8/8, 0 skipped
```

_Session: 2026-07-24 · milestone v1.0 feature-complete._
