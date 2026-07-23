# Phase 3: Input Pipeline - Context

**Gathered:** 2026-07-23
**Status:** Ready for planning
**Mode:** `--auto` (decisions auto-selected from the pinned stack in CLAUDE.md, requirements, STATE risk-flags, and the shipped Phase 1/2 codebase)

<domain>
## Phase Boundary

The service accepts **PDFs (native + scanned) and additional image formats (TIFF multipage, HEIC, BMP, GIF)**, turning any upload into **memory-safe per-page results** routed through the already-proven cascade (Phase 2). Native-text PDF pages short-circuit OCR; scanned pages and non-PNG/JPEG/WebP images are normalized/rasterized to a routable image first, with untrusted decode/rasterization isolated in a killable, resource-limited subprocess and temp files always cleaned up.

Covers: INP-03, INP-04, INP-05, INP-06, INP-07, INP-08, OPS-06. Does NOT add structured extraction (Phase 4). Greenfield — the reference implementation has no PDF/image-normalization code.
</domain>

<decisions>
## Implementation Decisions

### Native PDF text extraction (INP-03)
- **D-01:** Use **`unpdf`** (`^1.6.2`, bundles serverless PDF.js — zero native deps, no Node floor) for per-page embedded-text extraction. If a page has sufficient embedded text (above a min-char/coverage threshold), take it **directly as that page's result WITHOUT OCR** (cheap fast path) — record `engine: 'pdf-native'`, confidence high/1.0, no cascade call. A page with little/no embedded text is treated as **scanned** and rasterized (D-02).

### Scanned PDF rasterization (INP-04, INP-07)
- **D-02:** Rasterize scanned pages with **poppler `pdftoppm`** (the OCR-grade gold standard; already installed in the Phase-1 Docker image alongside `tini`). Render **page-by-page** at a controllable DPI (default ~200–300) via `child_process`, streaming **exactly one page image in memory at a time** (INP-07). Do NOT use the pure-JS `@napi-rs/canvas` fallback — poppler is in the image. Each rendered page image is routed through the cascade (`runCascade`).
- **D-03:** Enforce hard caps (config): **page-count**, **DPI**, and **output pixel** ceilings so a 100-page or huge-MediaBox / decompression-bomb PDF cannot exhaust the memory budget (INP-07). Read page count via `pdfinfo` before rasterizing; reject over-cap uploads with a typed `413`/`422`.

### Image normalization (INP-05)
- **D-04:** Use **`sharp`** (`^0.35.3`, prebuilt libvips — no apt libvips) for TIFF (multipage via `{pages:-1}`/`{page:n}`), WebP, GIF, resize, grayscale, DPI/density normalization → a routable PNG/JPEG. Multipage TIFF/GIF → one page per frame (page-aware).
- **D-05:** **HEIC** → **`heic-convert`** (`^2.1.0`, WASM libheif — no system libheif/HEVC build) to a JPEG/PNG buffer, then hand to `sharp`. **BMP** → **`@vingle/bmp-js`** decode → raw pixels → `sharp` (libvips prebuilt cannot read BMP). Both are pure-JS/WASM — no system deps. **AMENDED (research):** use **`@vingle/bmp-js@^0.2.5`** — the CLAUDE.md `^0.1.0` pin does NOT exist on npm (only 0.2.x is published).

### Content sniffing extension (INP-02 continuation)
- **D-06:** Extend `lib/v1/sniff.js` magic-byte detection to recognize **PDF** (`%PDF`), **TIFF** (`II*\0`/`MM\0*`), **HEIC/HEIF** (`ftyp` brand `heic`/`heif`/`heix`/`mif1`), **BMP** (`BM`), **GIF** (`GIF87a`/`GIF89a`) in addition to PNG/JPEG/WebP. Type is decided by magic bytes, never the client content-type; spoofed/unknown → typed `422`. The multipart size limit stays enforced (API-07).

### Untrusted decode/rasterization isolation (INP-08)
- **D-07:** Run untrusted decode/rasterization (poppler `pdftoppm`, and — where feasible — sharp/heic/bmp decode of hostile input) in a **killable, resource-limited child process**: bounded by the **Phase-2 job deadline** (JOB-04 `AbortController`) so a hung/malicious decode is aborted, not left to wedge the concurrency-1 worker. Use a **per-job temp directory** (`fs.mkdtemp`) for all intermediate page files, and **always clean it up** — on success, on error, AND on mid-job kill / SIGTERM (register cleanup so the graceful-shutdown drain removes temp dirs). No temp file leaks.

### Per-page results + status rollup (INP-06)
- **D-08:** Multi-page inputs return **per-page results in the existing page-aware envelope** (`pages[]` from Phase-1 D-04, now genuinely multi-element), **page order preserved**. Add a **per-page status rollup**: job result carries `status_rollup: 'completed' | 'completed_with_errors'` — one failed page is **recorded (with its error) but does NOT fail the whole job**, and is never silently dropped. Each page records its engine/confidence/error.

### Dependency security (OPS-06)
- **D-09:** Pin **`sharp>=0.35.0`** (CVE-fixed) and the other native/WASM decoders to the CLAUDE.md versions; add a **CI dependency scan** (`npm audit` gate, or equivalent) so a future vulnerable pin is caught. Document the audit step. **AMENDED (research):** the audit gate would **red-fail on the first run** — current prod deps (`axios`, `form-data`) already carry 2 high + 2 moderate advisories. So the gate must ship WITH remediation: bump the offending deps to fixed versions AND/OR scope the gate (e.g. `--audit-level=high` with a documented, time-boxed allowlist for anything unfixable). The gate must be GREEN when the phase completes, not aspirational.

### Integration & memory model
- **D-10:** The input pipeline sits **before** the cascade: `upload → sniff → (PDF: native-text-or-rasterize per page) | (image: normalize to N page frames) → for each page: native-text short-circuit OR runCascade(pageImage) → assemble ordered pages[] + rollup`. The single-concurrency worker processes **one page image in memory at a time** (INP-07); buffers are released between pages. Reuse the Phase-2 cascade unchanged.

### Testability constraint (host vs Docker)
- **D-11:** **poppler is NOT on the host** (Docker-only). Therefore `pdftoppm`/`pdfinfo` invocation must be behind a thin, **mockable seam** so unit tests (host `npm test`) can stub the subprocess boundary deterministically; a **real-poppler rasterization test runs only in Docker** (or is skip-guarded when `pdftoppm` is absent) and is recorded as a Docker/human smoke check, not a host-suite gate. sharp/heic-convert/unpdf/bmp-js DO work on host and are unit-tested for real. The STATE risk-flags (subprocess sandbox mechanics + HEIC-in-Docker) are validated by a Docker integration smoke.

### Claude's Discretion
- Module layout under `lib/v1/input/` (sniff-ext, pdf, image-normalize, rasterize, page-pipeline), temp-dir naming, exact DPI/pixel/page-count default caps (set by research within memory budget), and the native-text sufficiency threshold.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Stack (authoritative — pinned versions + forbidden libs)
- `CLAUDE.md` §Technology Stack / §Installation / §Dockerfile / §"What NOT to Use" / §"Version Compatibility" — unpdf/poppler-utils/sharp/heic-convert/@vingle/bmp-js pins and the explicit AVOID list (no pdfjs-dist@6 on Node<22.13, no pdf2pic/ImageMagick, no sharp-for-HEIC/BMP)

### Requirements & goal
- `.planning/REQUIREMENTS.md` §Input Processing (INP-03..08) + §Deploy & Operations (OPS-06)
- `.planning/ROADMAP.md` §"Phase 3: Input Pipeline" — goal + 5 success criteria
- `.planning/PROJECT.md` §Constraints (per-job memory / single-concurrency worker; PDF rasterization increases per-job memory) + §Out of Scope
- `.planning/STATE.md` §Blockers/Concerns — Phase 3: subprocess sandboxing mechanics + HEIC-in-Docker validation (research-flag)

### Phase 1/2 foundation (build on, don't rebuild)
- `.planning/phases/01-foundation/01-CONTEXT.md` — page-aware envelope (D-04), sniff, worker, Docker base (poppler already installed)
- `.planning/phases/02-cascade-router/02-CONTEXT.md` + code — `runCascade` (route each page image), the JOB-04 `AbortController` job deadline (reuse to bound subprocesses)
- Shipped code: `lib/v1/sniff.js` (extend), `lib/v1/worker.js` (multi-page integration point), `lib/v1/upload.js`/`router.js` (accepted types + size), `lib/v1/cascade/runner.js` (`runCascade`), `lib/v1/shutdown.js` (temp-dir cleanup on drain), `Dockerfile` (poppler-utils present)
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `lib/v1/cascade/runner.js#runCascade` — route each page image (native-text pages skip it).
- Phase-2 job deadline (`worker.js` AbortController) — reuse to bound/kill subprocesses (INP-08/JOB-04).
- `lib/v1/sniff.js` — extend magic-byte table (currently PNG/JPEG/WebP only).
- `lib/v1/shutdown.js` drainAndCancel — hook per-job temp-dir cleanup so mid-job kill leaks nothing.
- Page-aware envelope (`pages[]`) already exists — now genuinely multi-element.
- Dockerfile already installs `poppler-utils` + `tini` (Phase-1 D-10).

### Established Patterns
- Typed 4xx errors + magic-byte sniff (reuse for new formats + over-cap rejection).
- Single-concurrency worker + bounded queue — the memory model the per-page streaming must respect.
- `AbortSignal`-based cancellation (Phase 2) — extend to `child_process` kill.

### Integration Points
- New `lib/v1/input/` module set feeding `runCascade` per page, assembled in `worker.js`.
- `sniff.js` + `upload.js`/`router.js` accepted-type expansion.
- `package.json` gains unpdf/sharp/heic-convert/@vingle/bmp-js (pinned); CI audit step.
</code_context>

<specifics>
## Specific Ideas
- poppler `pdftoppm` page-by-page (`-r <dpi> -png`, one page per invocation or bounded) is the memory-frugal, OCR-tuned choice — NOT ImageMagick/Ghostscript/pdf2pic (CLAUDE.md forbids).
- Native-text short-circuit (unpdf) is the cheap fast path — most digital PDFs never touch OCR.
- Temp files ALWAYS cleaned (success/error/kill) — the single most important safety property here.
</specifics>

<deferred>
## Deferred Ideas
- `mode=structured` schema extraction — Phase 4.
- Office documents (docx/pptx), URL ingestion — v2 (out of scope).
- Live-key OCR of rasterized pages against real providers — folds into the standing live-key smoke (PENDING-ISSUES).
- Real-poppler / HEIC-in-Docker validation — a Docker integration smoke (D-11), recorded rather than a host-suite gate.
</deferred>

---

*Phase: 3-Input-Pipeline*
*Context gathered: 2026-07-23*
