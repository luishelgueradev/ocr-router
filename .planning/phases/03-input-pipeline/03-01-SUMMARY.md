---
phase: 03-input-pipeline
plan: 01
subsystem: input-pipeline
tags: [dependencies, decoders, sharp, unpdf, heic-convert, bmp-js, npm-audit, caps, memory-guard, ops-06, inp-07]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "lib/v1/env.js intFromEnv/floatFromEnv boot-validated env helpers; Dockerfile with poppler-utils already installed"
provides:
  - "Four pinned native/WASM decoders installed + host-verified: unpdf@^1.6.2, sharp@^0.35.3 (>=0.35.0 CVE floor), heic-convert@^2.1.0, @vingle/bmp-js@^0.2.5"
  - "lib/v1/input/caps.js — frozen CAPS object, every memory/resource ceiling env-overridable + boot-validated via intFromEnv (INP-07)"
  - "OPS-06 npm audit gate GREEN: 'npm run audit' (--omit=dev --audit-level=high) exits 0, 0 vulnerabilities, no allowlist"
affects: [phase-03-rasterize, phase-03-image-normalize, phase-03-pdf-native, phase-03-page-pipeline]

# Tech tracking
tech-stack:
  added:
    - "unpdf@^1.6.2 (native PDF text extraction — bundled serverless PDF.js)"
    - "sharp@^0.35.3 (image normalization — prebuilt libvips, CVE-fixed floor >=0.35.0)"
    - "heic-convert@^2.1.0 (HEIC decode — WASM libheif)"
    - "@vingle/bmp-js@^0.2.5 (BMP decode — pure JS; corrected pin, 0.1.x does not exist on npm)"
  patterns:
    - "Single boot-validated caps surface: every downstream input ceiling reads from lib/v1/input/caps.js CAPS, built entirely from intFromEnv so a bad override fails loudly at boot"
    - "Audit gate ships WITH remediation (npm audit fix), not aspirationally — green from first CI run, no Express-5 major bump"

key-files:
  created:
    - lib/v1/input/caps.js
    - test/caps.test.js
  modified:
    - package.json
    - package-lock.json
    - README.md

key-decisions:
  - "caps.js resolves Open Question Q1: MAX_JOB_MS is a single whole-job budget shared across all N pages (not per-page), default 180000ms"
  - "Cap defaults are the research-recommended conservative VPS budget (Q2): MAX_PDF_PAGES 50, RASTER_DPI 200, MAX_OUTPUT_PIXELS 25M, RASTER_MAX_DIM 5000, ULIMIT_V_KB 768MB — exact per-box tuning deferred to Docker smoke (D-11)"
  - "npm audit fix fully remediated all 5 pre-existing advisories (2 high axios/form-data, 2 moderate qs/body-parser, 1 low) transitively via the lockfile — axios resolved 1.16->1.18.1 — with NO change to package.json dependency ranges and NO Express-5 bump; express stays 4.22.2"
  - "Gate scoped --omit=dev --audit-level=high per plan key_links; 0 vulnerabilities at all levels so no allowlist entry was needed"
  - "@vingle/bmp-js pinned ^0.2.5 (D-05 amendment) — the CLAUDE.md ^0.1.0 pin is unpublished and would fail install"

requirements-completed: [OPS-06, INP-07]

# Metrics
duration: ~6min
completed: 2026-07-23
---

# Phase 3 Plan 01: Decoder Deps + Caps + Audit Gate Summary

**The input pipeline's dependency + configuration foundation is laid: the four pinned native/WASM decoders (unpdf, sharp>=0.35.0, heic-convert, @vingle/bmp-js) install and load on the host, every memory/resource ceiling is centralised in a boot-validated `lib/v1/input/caps.js`, and the OPS-06 `npm run audit` gate is actually GREEN (0 vulnerabilities) after remediating the pre-existing axios/form-data/body-parser/qs advisories — no Express-5 bump, no allowlist, and all 238 prior tests still pass (now 243 with the 5 caps tests).**

## Performance
- **Tasks:** 2 completed (both `type=auto`)
- **Files:** 2 created, 3 modified
- **Suite:** full `npm test` → **243 pass / 0 fail** (238 baseline + 5 new caps tests) + 5 verify-redaction checks, zero regression from the transitive audit-fix bumps
- **Audit:** `npm run audit` → **0 vulnerabilities**, exit 0

## Accomplishments
- **Task 1 — decoders + caps (`c32dbc8`):** Installed exactly the four researched pins as production deps (`unpdf@^1.6.2`, `sharp@^0.35.3`, `heic-convert@^2.1.0`, `@vingle/bmp-js@^0.2.5`), regenerating the lockfile; no forbidden lib (pdf2pic/pdfjs-dist@6/@napi-rs/canvas) added and the Dockerfile is untouched (`git diff --quiet -- Dockerfile` clean). Created `lib/v1/input/caps.js` exporting a frozen `CAPS` object built entirely from `intFromEnv('../env')`: `MAX_PDF_PAGES` (50), `RASTER_DPI` (200), `MAX_OUTPUT_PIXELS` (25M), `RASTER_MAX_DIM` (5000), `ULIMIT_V_KB` (768MB), `ULIMIT_CPU_SEC` (20), `RASTER_WALL_MS` (30000), `PDFINFO_WALL_MS` (10000), `MAX_RASTER_STDOUT_BYTES` (40MB), `MIN_NATIVE_CHARS` (16), `MAX_JOB_MS` (180000) — each documented with units + intent, VPS-tuning noted as deferred. `test/caps.test.js` (5 tests, registered in the test script) asserts every default is a positive integer at the research value, the object is frozen, a valid override wins, and an invalid override (`-5`, `x`) throws loudly at load via `intFromEnv` (fresh require-per-case).
- **Task 2 — OPS-06 audit gate GREEN (`d21e253`):** Remediated all 5 pre-existing advisories with `npm audit fix` (lockfile-only; `package.json` dependency ranges unchanged, express stays 4.22.2 — no v4→v5 rework). Added the `audit` script (`npm audit --omit=dev --audit-level=high`) and documented the gate, the `sharp>=0.35.0` CVE floor, and the no-allowlist rationale in a README "Dependency security (OPS-06)" section. `npm run audit` exits 0 with 0 vulnerabilities; the full suite stays green (ported express/multer/body-parser behavior unchanged, proven by the existing route/middleware tests).

## npm audit — before / after
| | high | moderate | low | total | gate (`--audit-level=high`) |
|---|---|---|---|---|---|
| **Before** | 2 (axios, form-data) | 2 (qs→express, body-parser) | 1 | 5 | exit 1 (RED) |
| **After `npm audit fix`** | 0 | 0 | 0 | **0** | **exit 0 (GREEN)** |

All fixes were transitive lockfile bumps (e.g. axios 1.16 → 1.18.1) — `package.json` dependency ranges and the Express 4.22 line are untouched.

## Task Commits
1. **Task 1: pinned decoders + boot-validated caps module** — `c32dbc8` (feat)
2. **Task 2: ship OPS-06 npm audit gate GREEN** — `d21e253` (chore)

## Deviations from Plan
None — plan executed exactly as written. `npm audit fix` achieved full remediation, so the plan's fallback (a scoped `--audit-level=high` allowlist for anything unfixable) was not needed; the gate is unconditionally green with no allowlist entries.

## Threat Model Compliance
- **T-03-SC (Tampering — npm installs):** mitigated — installed exactly the four pins the research §"Package Legitimacy Audit" cleared (all `[OK]`, no unexpected postinstall); no `[ASSUMED]`/`[SUS]` package, so no blocking-human legitimacy checkpoint was triggered. The `@vingle/bmp-js` ^0.2.5 correction avoids the unpublished 0.1.x that would have failed install.
- **T-03-01 (Tampering/DoS — vulnerable native decoder pin):** mitigated — `sharp>=0.35.0` CVE-fixed floor pinned; `npm run audit --audit-level=high` gate wired for CI (OPS-06) and shipped GREEN after remediating the pre-existing advisories, so it is a live guard rather than an aspirational one.

## Known Stubs
None. `caps.js` is fully wired (every key reads a real env var through the validated helper); no placeholder or empty-value stubs. Downstream consumers (rasterize/normalize/page-pipeline) will import `CAPS` in later plans — that is the intended forward dependency, not a stub.

## Self-Check: PASSED
- Files exist: `lib/v1/input/caps.js`, `test/caps.test.js`, `package.json`, `package-lock.json`, `README.md` — all confirmed on disk.
- Commits exist: `c32dbc8`, `d21e253` — both confirmed in git log.
- Deps load on host: `require('sharp')`, `require('@vingle/bmp-js')`, `require('heic-convert')`, `await import('unpdf')` all succeed (`deps-ok`).
- Gate: `npm run audit` → 0 vulnerabilities, exit 0. Suite: `npm test` → 243 pass / 0 fail + 5 redaction checks.
