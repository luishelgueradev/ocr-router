---
phase: 03-input-pipeline
plan: 02
subsystem: input-pipeline
tags: [sniff, magic-bytes, upload, fileFilter, router, pdf, tiff, heic, bmp, gif, spoof-guard, inp-03, inp-04, inp-05, d-06, t-03-02]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "lib/v1/sniff.js magic-byte sniffer (PNG/JPEG/WebP); lib/v1/upload.js multer memoryStorage + fileFilter + size cap; lib/v1/router.js sniff-null → 422 branch"
  - phase: 02-cascade-router
    provides: "router.js authoritative sniffedType → worker mimeType hand-off (runJob)"
provides:
  - "sniffImage recognises PDF/TIFF/HEIC/HEIF/BMP/GIF by magic bytes and returns their canonical mimetype; unknown/spoofed bytes still → null (typed 422 upstream)"
  - "upload.js fileFilter admits the new declared mimetypes (first permissive gate) with the multipart size cap unchanged (API-07)"
  - "router.js forwards the sniffed type as worker mimeType for all admitted formats; 422 message reflects the expanded accepted set"
affects: [phase-03-image-normalize, phase-03-pdf-native, phase-03-rasterize, phase-03-page-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Magic-byte sniff is the single authoritative type decision — client-declared mimetype is never read in sniff.js; the declared-MIME fileFilter is only a permissive first gate before sniffImage"
    - "ISO-BMFF ftyp brand allowlist (heic/heif/heix/mif1) so an .heic-named MP4 (mp42/isom) sniffs as null, not HEIC (T-03-02 false-positive guard)"
    - "Every sniff branch is byte-length-guarded so truncated/empty buffers return null without throwing"

key-files:
  created: []
  modified:
    - lib/v1/sniff.js
    - lib/v1/upload.js
    - lib/v1/router.js
    - test/sniff.test.js
    - test/upload.test.js

key-decisions:
  - "Type decided by magic bytes only (D-06) — sniff.js reads zero client metadata; the fileFilter admits declared mimetypes permissively but sniffImage remains the authoritative second gate and still 422s on null"
  - "HEIC detected via the ftyp box brand at bytes 8-12 against a still-image allowlist {heic,heif,heix,mif1}; a non-image brand (mp42/isom) returns null — an .heic-named MP4 does NOT pass (T-03-02)"
  - "Both TIFF endiannesses accepted: little-endian II*\\0 (49 49 2A 00) and big-endian MM\\0* (4D 4D 00 2A)"
  - "No page-count/pdfinfo/rasterization logic added at the request tier — that stays worker-side (03-04/03-06 per the Architectural Responsibility Map); this plan is purely the front-door type gate"
  - "PNG/JPEG/WebP branches kept byte-identical; sniff API return type unchanged (string|null) so all prior sniff/upload/router tests stay green"

requirements-completed: [INP-03, INP-04, INP-05]

# Metrics
duration: ~4min
completed: 2026-07-23
---

# Phase 3 Plan 02: Extend Magic-Byte Sniff + Accepted-Type Gates Summary

**The front door now admits every Phase-3 format by its real bytes: `sniffImage` recognises PDF (`%PDF`), TIFF (`II*\0`/`MM\0*`), HEIC/HEIF (ISO-BMFF `ftyp` brand allowlist), BMP (`BM`) and GIF (`GIF87a/89a`) alongside the existing PNG/JPEG/WebP, the `upload.js` fileFilter admits their declared mimetypes as a permissive first gate while the multipart size cap stays enforced, and the sniff stays the authoritative second gate so a spoofed `.heic`-named MP4 (`mp42`/`isom` brand) or any unknown bytes still fall through to a typed 422 — all 243 prior tests remain green, now 263 with the 20 new sniff/upload cases.**

## Performance
- **Tasks:** 2 completed (Task 1 `tdd=true` RED→GREEN; Task 2 `type=auto`)
- **Files:** 0 created, 5 modified
- **Suite:** full `npm test` → **263 pass / 0 fail** (243 baseline + 20 new) + 5 verify-redaction checks
- **Sniff suite:** `node --test test/sniff.test.js` → **26 pass / 0 fail**

## What Was Built

### Task 1 — Magic-byte sniffer extension (TDD)
- **RED** (`test/sniff.test.js`): 15 new cases — a positive per new format (real magic-byte prefixes), the HEIC `ftyp` non-image-brand guard (`mp42`/`isom` → null), and truncated-header negatives. Committed failing (9 positives red against the 3-format sniffer).
- **GREEN** (`lib/v1/sniff.js`): added length-guarded branches returning `application/pdf`, `image/tiff`, `image/heic`, `image/bmp`, `image/gif`. HEIC reads the `ftyp` box brand at bytes 8-12 against a `Set` allowlist `{heic,heif,heix,mif1}`; a non-image brand returns null. PNG/JPEG/WebP branches left byte-identical. Client mimetype is never read.

### Task 2 — Accepted-type gates + messaging
- `lib/v1/upload.js`: extended the fileFilter `allowed` array with `application/pdf, image/tiff, image/heic, image/heif, image/bmp, image/gif`. `limits.fileSize` (MAX_UPLOAD_BYTES) and `files: 1` unchanged (API-07). No page/pdfinfo logic added.
- `lib/v1/router.js`: updated the two stale `PNG/JPEG/WebP` 422 message strings to reflect the expanded accepted set. No control-flow change — sniffImage still 422s on null and forwards `mimeType: sniffedType`.
- `test/upload.test.js`: replaced the now-stale `rejects image/gif` / `rejects application/pdf` cases with a per-format accepted loop (pdf/tiff/heic/heif/bmp/gif), plus a retained `application/octet-stream` rejection and the unchanged svg/empty rejections.

## Deviations from Plan

None — plan executed exactly as written. The two upload tests that asserted the old (now-inverted) reject behavior for `image/gif` and `application/pdf` were updated to accept, which the plan's Task 2 explicitly directed ("a PDF/TIFF/HEIC/BMP/GIF declared mimetype passes the fileFilter").

## Threat Model Coverage
- **T-03-02 (Spoofing):** Mitigated — magic-byte sniff is authoritative; the `ftyp` brand allowlist rejects an `.heic`-named MP4; client mimetype never forwarded; unknown/spoofed → typed 422. Covered by the `mp42`/`isom` → null tests.
- **T-03-03 (DoS):** Mitigated — `limits.fileSize` + `files:1` retained unchanged in upload.js (verified present). No new per-job memory surface added at the request tier.

## Known Stubs
None. This plan only extends the type-gate; no placeholder data or unwired components introduced. The worker-side decode/rasterize that consumes these sniffed types lands in 03-03..03-06.

## Self-Check: PASSED
- lib/v1/sniff.js, lib/v1/upload.js, lib/v1/router.js, test/sniff.test.js, test/upload.test.js — all modified and present.
- Commits verified present: 0a932ae (test RED), d0b0391 (feat sniff GREEN), 9b80bcb (feat upload+router).
- Full `npm test`: 263 pass / 0 fail (+5 redaction). Sniff suite: 26 pass / 0 fail.

## TDD Gate Compliance
Task 1 followed RED→GREEN: `test(03-02)` commit 0a932ae (failing sniff cases) precedes `feat(03-02)` commit d0b0391 (implementation). No REFACTOR needed. Gate sequence satisfied.
