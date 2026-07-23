# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-23)

**Core value:** Never fail to return the best available text/data for a document — the cascade escalates quality automatically so one API call always yields the best result any configured engine could produce.
**Current focus:** Phase 1 — Foundation

## Current Position

Phase: 1 of 4 (Foundation)
Plan: 0 of TBD in current phase
Status: Ready to plan
Last activity: 2026-07-23 — Roadmap created (4 phases, 38/38 requirements mapped)

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: — min
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: —
- Trend: —

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Dependency-ordered build — Foundation (port) → Cascade Router → Input Pipeline → Structured Extraction.
- [Roadmap]: Cascade built on plain images BEFORE the input pipeline (core value + lowest-dependency layer).
- [Roadmap]: Page-aware response envelope (`pages[]`) designed in Phase 1 even while image-only, or multi-page becomes a breaking change.
- [Roadmap]: OPS-01..05 folded into Phase 1 (ported deploy/foundation); OPS-06 lives in Phase 3 where sharp/native decoders land.

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 2]: Confidence heuristic is the hardest-to-tune, highest-risk logic (false-good garbage detection). Research-flag: warrants a focused spike + small labeled calibration sample during planning.
- [Phase 2]: Ollama Cloud quota resets on 5h/7-day windows and burns fastest on the 235B model — confirm real quota numbers before finalizing the global budget cap.
- [Phase 3]: Subprocess sandboxing mechanics (memory/pid caps, clean kill) and HEIC-in-Docker (patched libheif) need validation against the target VPS/Docker setup. Research-flag.

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| *(none)* | | | |

## Session Continuity

Last session: 2026-07-23
Stopped at: ROADMAP.md and STATE.md created; REQUIREMENTS.md traceability populated (38/38 mapped)
Resume file: None
