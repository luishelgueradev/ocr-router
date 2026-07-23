# Phase 3: Input Pipeline - Research

**Researched:** 2026-07-23
**Domain:** Memory-safe multi-format document ingestion (PDF native+scanned, TIFF/HEIC/BMP/GIF), killable resource-limited subprocess sandboxing, guaranteed temp cleanup, per-page result rollup
**Confidence:** HIGH (stack + poppler flags + sharp/heic verified against npm registry + Debian bookworm manpages; subprocess sandbox mechanics verified against Node core docs; one Docker-only validation gap flagged per D-11)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01 (INP-03):** Use **`unpdf`** (`^1.6.2`, bundles serverless PDF.js — zero native deps, no Node floor) for per-page embedded-text extraction. If a page has sufficient embedded text (above a min-char/coverage threshold), take it **directly as that page's result WITHOUT OCR** (cheap fast path) — record `engine: 'pdf-native'`, confidence high/1.0, no cascade call. A page with little/no embedded text is treated as **scanned** and rasterized (D-02).
- **D-02 (INP-04/07):** Rasterize scanned pages with **poppler `pdftoppm`** (OCR-grade gold standard; already installed in the Phase-1 Docker image alongside `tini`). Render **page-by-page** at a controllable DPI (default ~200–300) via `child_process`, streaming **exactly one page image in memory at a time** (INP-07). Do NOT use the pure-JS `@napi-rs/canvas` fallback — poppler is in the image. Each rendered page image is routed through the cascade (`runCascade`).
- **D-03 (INP-07):** Enforce hard caps (config): **page-count**, **DPI**, and **output pixel** ceilings so a 100-page or huge-MediaBox / decompression-bomb PDF cannot exhaust the memory budget. Read page count via `pdfinfo` before rasterizing; reject over-cap uploads with a typed `413`/`422`.
- **D-04 (INP-05):** Use **`sharp`** (`^0.35.3`, prebuilt libvips — no apt libvips) for TIFF (multipage via `{pages:-1}`/`{page:n}`), WebP, GIF, resize, grayscale, DPI/density normalization → a routable PNG/JPEG. Multipage TIFF/GIF → one page per frame (page-aware).
- **D-05 (INP-05):** **HEIC** → **`heic-convert`** (`^2.1.0`, WASM libheif — no system libheif/HEVC build) to a JPEG/PNG buffer, then hand to `sharp`. **BMP** → **`@vingle/bmp-js`** decode → raw pixels → `sharp` (libvips prebuilt cannot read BMP). Both pure-JS/WASM — no system deps.
- **D-06 (INP-02 cont.):** Extend `lib/v1/sniff.js` magic-byte detection to recognize **PDF** (`%PDF`), **TIFF** (`II*\0`/`MM\0*`), **HEIC/HEIF** (`ftyp` brand `heic`/`heif`/`heix`/`mif1`), **BMP** (`BM`), **GIF** (`GIF87a`/`GIF89a`) in addition to PNG/JPEG/WebP. Type decided by magic bytes, never client content-type; spoofed/unknown → typed `422`. Multipart size limit stays enforced (API-07).
- **D-07 (INP-08):** Run untrusted decode/rasterization in a **killable, resource-limited child process**: bounded by the **Phase-2 job deadline** (JOB-04 `AbortController`) so a hung/malicious decode is aborted, not left to wedge the concurrency-1 worker. Use a **per-job temp directory** (`fs.mkdtemp`) for all intermediate page files, and **always clean it up** — on success, on error, AND on mid-job kill / SIGTERM (register cleanup so graceful-shutdown drain removes temp dirs). No temp file leaks.
- **D-08 (INP-06):** Multi-page inputs return **per-page results in the existing page-aware envelope** (`pages[]`), **page order preserved**. Add a **per-page status rollup**: `status_rollup: 'completed' | 'completed_with_errors'` — one failed page is **recorded (with its error) but does NOT fail the whole job**, never silently dropped. Each page records engine/confidence/error.
- **D-09 (OPS-06):** Pin **`sharp>=0.35.0`** (CVE-fixed) and other native/WASM decoders to CLAUDE.md versions; add a **CI dependency scan** (`npm audit` gate) so a future vulnerable pin is caught. Document the audit step.
- **D-10:** Pipeline sits **before** the cascade: `upload → sniff → (PDF: native-text-or-rasterize per page) | (image: normalize to N page frames) → for each page: native-text short-circuit OR runCascade(pageImage) → assemble ordered pages[] + rollup`. Single-concurrency worker processes **one page image in memory at a time**; buffers released between pages. Reuse the Phase-2 cascade unchanged.
- **D-11:** **poppler is NOT on the host** (Docker-only). `pdftoppm`/`pdfinfo` invocation must be behind a thin, **mockable seam** so unit tests (host `npm test`) can stub the subprocess boundary deterministically; a **real-poppler rasterization test runs only in Docker** (or is skip-guarded when `pdftoppm` is absent) and is recorded as a Docker/human smoke check, not a host-suite gate. sharp/heic-convert/unpdf/bmp-js DO work on host and are unit-tested for real. STATE risk-flags (subprocess sandbox mechanics + HEIC-in-Docker) validated by a Docker integration smoke.

### Claude's Discretion
Module layout under `lib/v1/input/` (sniff-ext, pdf, image-normalize, rasterize, page-pipeline), temp-dir naming, exact DPI/pixel/page-count default caps (set by research within memory budget), and the native-text sufficiency threshold.

### Deferred Ideas (OUT OF SCOPE)
- `mode=structured` schema extraction — Phase 4.
- Office documents (docx/pptx), URL ingestion — v2.
- Live-key OCR of rasterized pages against real providers — folds into the standing live-key smoke.
- Real-poppler / HEIC-in-Docker validation — a Docker integration smoke (D-11), recorded rather than a host-suite gate.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INP-03 | Native PDFs have embedded text extracted per page without OCR | `unpdf` `getDocumentProxy` + per-page `extractText` (§Standard Stack, §Code Examples); native-text sufficiency threshold (§Pitfall 3) |
| INP-04 | Scanned PDFs rendered page-by-page, each page routed through cascade | `pdftoppm -r <dpi> -png -f N -l N -singlefile … -` streamed to stdout buffer; `pdfinfo` page count (§Code Examples) |
| INP-05 | TIFF multipage, HEIC, BMP, GIF normalized before routing | `sharp {pages:-1}` frame loop; `heic-convert`→sharp; `@vingle/bmp-js`→sharp raw (§Code Examples) |
| INP-06 | Per-page results + status rollup; one failed page ≠ whole-job fail | Per-page try/catch accumulator → ordered `pages[]` + `status_rollup` on the existing envelope (§Pattern 4) |
| INP-07 | One page image in memory at a time; page/DPI/pixel caps | pdftoppm single-page stdout; `pdfinfo` precheck; sharp `limitInputPixels`; caps table (§Pattern 2, §Pitfall 1) |
| INP-08 | Killable, resource-limited subprocess; temp files always cleaned | `spawn({signal, killSignal})` + SIGTERM→SIGKILL escalation + `sh -c 'ulimit …; exec'` + `timeout(1)`; temp-dir registry hooked into `shutdown.js` (§Pattern 1, §Code Examples) |
| OPS-06 | CVE-fixed pins (`sharp>=0.35.0`) + CI scan | Version table verified on npm 2026-07-23; `npm audit --audit-level` gate (§Package Legitimacy Audit, §Pattern 6). **Existing deps already carry high-severity advisories** (§Open Questions Q4) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Actionable directives extracted from CLAUDE.md — treat with same authority as locked decisions:

- **Forbidden libraries (hard AVOID list):** `pdfjs-dist@6` on Node<22.13; `pdf-parse@1.x`; `pdf-image` / ImageMagick-`convert`-for-PDF; **`pdf2pic`** (pulls GraphicsMagick + Ghostscript); `sharp` for HEIC input (prebuilt libvips has no HEVC/libheif); `sharp` for BMP input (needs libmagick); `zod-to-json-schema`; free-form "reply with JSON" prompting; `node:20-*` base. The pipeline MUST NOT introduce any of these.
- **Docker image discipline:** do NOT add `libvips-dev`, `libheif`/`libde265`/`x265`, or `fonts-*`. sharp ships prebuilt libvips; HEIC handled by WASM `heic-convert`. The ONLY system package the input pipeline needs is `poppler-utils` — **already installed** in the Phase-1 Dockerfile (line 23).
- **Memory model:** single-concurrency worker + bounded in-memory queue; each queued job holds its file buffer. PDF rasterization increases per-job memory — page-level processing must be buffer-mindful (release each page buffer before the next).
- **Security:** Bearer token on all `/v1` routes (already enforced); typed 4xx on bad input; never trust client content-type (magic-byte sniff is authoritative — already the pattern in `router.js`).
- **Testing:** `node --test` only — no external test framework. Add tests for the router fallback matrix + per-format normalization.
- **PID 1:** `tini` already the init (Dockerfile ENTRYPOINT) — this is what forwards SIGTERM to Node and is why child processes must be reaped/killed by the Node worker, not left orphaned.
- **GSD workflow:** all file edits go through a GSD command (this is a planning artifact, not a code edit).

## Summary

Phase 3 turns the concurrency-1 image OCR worker into a multi-format, multi-page pipeline that sits **in front of** the unchanged Phase-2 cascade. Every locked library is already pinned and verified in CLAUDE.md; this research confirms all four new packages (`unpdf`, `sharp`, `heic-convert`, `@vingle/bmp-js`) exist on the npm registry with the stated versions and pass a `slopcheck` legitimacy scan (all `[OK]`), and that **the only system dependency (`poppler-utils`) is already in the Docker image**. The three genuinely hard problems are: (1) killable/resource-capped subprocess mechanics for poppler on bookworm-slim, (2) guaranteed temp cleanup on success/error/**mid-job SIGTERM**, and (3) a test seam that lets host `node --test` run without poppler (D-11).

The subprocess story resolves cleanly with Node core primitives plus two Debian coreutils tools that already ship in `bookworm-slim`: `spawn(cmd, args, { signal, killSignal })` wires the existing Phase-2 job `AbortController` straight to child termination, a `sh -c 'ulimit -v … -t …; exec pdftoppm …'` wrapper caps address-space and CPU seconds, and `timeout(1)` provides a hard wall-clock backstop. Node does **not** auto-escalate SIGTERM→SIGKILL, so the worker must implement a short kill-timer itself. Temp cleanup is a per-job `fs.mkdtemp` dir tracked in a module-level registry that `shutdown.js` `drainAndCancel` drains on SIGTERM — this is the single most important safety property and the one that is easy to get wrong under mid-job kill.

The memory model is preserved by streaming: `pdfinfo` reads page count first (cap check → typed 413/422 before any rasterization), then `pdftoppm … -singlefile … -` renders **one page to a captured stdout buffer at a time**, which is base64'd, handed to `runCascade`, and released before the next page. sharp/heic/bmp all decode on the host and get real unit tests; only the poppler path is Docker-gated.

**Primary recommendation:** Build `lib/v1/input/` as five small modules (`sniff-ext`, `pdf-text`, `rasterize`, `image-normalize`, `page-pipeline`) with all `child_process` calls funneled through a single injectable `spawnCapture(cmd, args, { signal, ... })` helper (matching the existing `deps`-injection style in `shutdown.js`). Move the authoritative job `AbortController` up into `worker.js` so one deadline bounds rasterization **and** the per-page cascade; register each job's temp dir for shutdown-time cleanup. Ship a Docker-gated poppler smoke, not a host gate. Verify HEIC-in-Docker and the ulimit/kill behavior in that same smoke.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Magic-byte format detection | API / Backend (`router.js` + `sniff.js`) | — | Already the authoritative pattern; runs synchronously on the request buffer before enqueue (INP-02) |
| Over-cap rejection (page/size) | API / Backend (request path) | Worker (pdfinfo precheck) | Size cap is pre-enqueue (multer + sniff); page-count cap needs `pdfinfo` so it runs at job start in the worker, failing the job typed |
| Native PDF text extraction | Worker (in-process `unpdf`) | — | Pure JS/WASM, no subprocess; runs inside the concurrency-1 worker |
| Scanned PDF rasterization | Worker → **subprocess** (`pdftoppm`) | OS (ulimit/timeout) | Untrusted rendering isolated in a killable child bounded by ulimit + job deadline (INP-08) |
| Image normalization (TIFF/GIF/WebP) | Worker (in-process `sharp`) | — | libvips native addon runs in-process; decompression-bomb guard via `limitInputPixels` |
| HEIC / BMP decode | Worker (in-process WASM/JS) | — | `heic-convert` (WASM) + `@vingle/bmp-js` (pure JS) — no system libs, no subprocess |
| Per-page cascade routing | Worker → cascade (`runCascade`) | External providers | Reuse Phase-2 unchanged; each page image is one cascade run |
| Per-page result rollup | Worker (`page-pipeline` + envelope) | — | Assemble ordered `pages[]` + `status_rollup` without breaking the Phase-1 envelope |
| Temp-file lifecycle / cleanup-on-kill | Worker (registry) ↔ `shutdown.js` | OS (`tini` reaps) | Registry hooked into `drainAndCancel` guarantees cleanup on mid-job SIGTERM |
| Dependency CVE scan | CI / build tier | — | `npm audit` gate outside the runtime (OPS-06) |

## Standard Stack

### Core (NEW for Phase 3 — all pinned in CLAUDE.md, verified on npm 2026-07-23)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `unpdf` | `^1.6.2` | Per-page embedded PDF text extraction (INP-03) | Bundles serverless PDF.js v4.6.82 → no Node floor, zero native deps. `getDocumentProxy()` + `extractText({ mergePages:false })` gives per-page text for the native-vs-scanned decision. [VERIFIED: npm registry — 1.6.2, repo github.com/unjs/unpdf] |
| `sharp` | `^0.35.3` | Image normalization: TIFF multipage, WebP, GIF frames, resize, grayscale, PNG/JPEG re-encode (INP-05); decompression-bomb guard via `limitInputPixels` | De-facto Node image pipeline (libvips); ships prebuilt libvips 1.3.2 for glibc+musl → no apt libvips. `>=0.35.0` is the CVE-fixed floor (OPS-06/D-09). [VERIFIED: npm registry — 0.35.3, repo github.com/lovell/sharp] |
| `heic-convert` | `^2.1.0` | HEIC/HEIF → JPEG/PNG buffer, then hand to sharp (INP-05) | sharp's prebuilt libvips cannot decode HEIC (HEVC patent). Pure WASM libheif, zero system deps. [VERIFIED: npm registry — 2.1.0, repo github.com/catdad-experiments/heic-convert] |
| `@vingle/bmp-js` | **`^0.2.5`** (see NOTE) | BMP decode → raw RGBA pixels → sharp (INP-05) | libvips prebuilt cannot read BMP (needs libmagick). Small pure-JS shim. [VERIFIED: npm registry — 0.2.5, repo github.com/shaozilee/bmp-js] |

> **⚠️ NOTE — CLAUDE.md version error to fix:** CLAUDE.md pins `@vingle/bmp-js` at `^0.1.0`, but **no 0.1.x version exists on npm** — published versions are `0.2.0 … 0.2.5` only. A `^0.1.0` install would fail. The planner MUST pin `^0.2.5` (or `~0.2.5`). [VERIFIED: `npm view @vingle/bmp-js versions` → 0.2.0–0.2.5, no 0.1.x]

### Supporting (system + built-in)

| Tool | Source | Purpose | When to Use |
|------|--------|---------|-------------|
| `poppler-utils` (`pdftoppm`, `pdfinfo`) | Debian bookworm apt (**already in Dockerfile**) | Rasterize scanned PDF pages; read page count | Every scanned-PDF path. `pdftoppm` default DPI is **150** — set `-r` explicitly. [CITED: manpages.debian.org/bookworm/poppler-utils] |
| `timeout(1)` | coreutils (in `bookworm-slim` base) | Hard wall-clock kill backstop for the child | Wrap `pdftoppm`/`pdfinfo`; belt-and-suspenders with the AbortSignal deadline |
| `sh` + `ulimit` | dash (in base) | Cap child address-space (`-v`) + CPU seconds (`-t`) | Wrapper around the poppler invocation to bound memory/CPU |
| `node:child_process` `spawn` | Node 22 built-in | Killable child with `{ signal, killSignal }` | All poppler invocations |
| `node:fs/promises` `mkdtemp`, `rm` | Node 22 built-in | Per-job temp dir + recursive cleanup | Temp lifecycle |
| `node:crypto` `randomUUID` | Node 22 built-in | Temp-dir naming | Avoid collisions (already used via uuid elsewhere) |

### Alternatives Considered (and why the locked choice wins)

| Instead of | Could Use | Tradeoff / Why NOT here |
|------------|-----------|-------------------------|
| `pdftoppm` | `pdf2pic`, `pdf-image`, ImageMagick `convert` | **FORBIDDEN by CLAUDE.md** — pull GraphicsMagick/Ghostscript/ImageMagick (more system packages; PDF often blocked by ImageMagick `policy.xml`). poppler is already installed. |
| `pdftoppm` (subprocess) | `unpdf.renderPageAsImage` + `@napi-rs/canvas` (pure-JS) | D-02 explicitly rejects this — poppler is in the image, and the JS path costs more memory/CPU per page and is less OCR-tuned. |
| `unpdf` | `pdf-parse@^2` | Fine API but `unpdf` gives per-page control needed for the native-vs-scanned decision; keep single PDF-text lib. |
| `unpdf` | `pdfjs-dist@6` directly | **FORBIDDEN on Node<22.13**; unpdf bundles a no-floor PDF.js. |
| `heic-convert` | sharp + custom libvips-with-libheif | Heavier image, HEVC patent surface, build-from-source. CLAUDE.md forbids. |
| in-process poppler | `mupdf` (WASM, all-in-one) | Would replace unpdf+poppler but higher per-page WASM memory/CPU; D-02 already commits to poppler. |

**Installation (planner adds to `package.json` dependencies — pins matter):**
```bash
npm install unpdf@^1.6.2 sharp@^0.35.3 heic-convert@^2.1.0 @vingle/bmp-js@^0.2.5
```
No Dockerfile system-package change is required — `poppler-utils` is already installed (Dockerfile line 23).

**Version verification (run at plan time to reconfirm):**
```bash
npm view unpdf version && npm view sharp version && npm view heic-convert version && npm view @vingle/bmp-js version
```

## Package Legitimacy Audit

Ran `slopcheck install …` (slopcheck 0.6.1) + `npm view` on the correct ecosystem registry (npm) on 2026-07-23. All four new packages resolve to established repos and pass.

| Package | Registry | Age / Repo | slopcheck | Disposition |
|---------|----------|------------|-----------|-------------|
| `unpdf` | npm | github.com/unjs/unpdf (unjs org, mature) | [OK] | Approved |
| `sharp` | npm | github.com/lovell/sharp (industry standard, millions/wk) | [OK] | Approved |
| `heic-convert` | npm | github.com/catdad-experiments/heic-convert | [OK] | Approved |
| `@vingle/bmp-js` | npm | github.com/shaozilee/bmp-js (scoped fork) | [OK] | Approved — **but pin `^0.2.5`, not `^0.1.0`** |

**Packages removed due to slopcheck [SLOP]:** none.
**Packages flagged [SUS]:** none. (`@vingle/bmp-js` is low-traffic but legit and pure-JS with a real source repo; the only action is the version-pin correction above.)
**Postinstall check:** none of the four declare a network/filesystem `postinstall` beyond sharp's standard prebuilt-binary resolution (expected, benign).

## Architecture Patterns

### System Architecture Diagram

```
  POST /v1/ocr (multipart, bearer)                        [router.js — request tier]
        │  multer memoryStorage, fileSize cap (API-07)
        ▼
  sniffType(buffer)  ── magic bytes only ──►  unknown/spoofed ──► 422 invalid_parameter
        │  { pdf | tiff | heic | bmp | gif | png | jpeg | webp }
        ▼  (enqueue: buffer + sniffedType) — bounded queue, 503 if full
  ┌────────────────────── worker.js (concurrency 1) ──────────────────────┐
  │  create ONE AbortController (job deadline, JOB-04) ── unref timer      │
  │  create per-job temp dir (fs.mkdtemp) ── REGISTER in cleanup registry  │
  │                                                                        │
  │   dispatch on sniffedType ──► page-pipeline                            │
  │                                                                        │
  │   ┌── PDF ──────────────────────────────────────────────────────────┐ │
  │   │ pdfinfo(file){signal} → pageCount                                │ │
  │   │   pageCount > MAX_PAGES ─► fail job 413/422 (before rasterizing) │ │
  │   │ for p in 1..pageCount:                                           │ │
  │   │   text = unpdf.extractText(page p)                              │ │
  │   │   if sufficient(text) ─► page result {engine:'pdf-native',c:1}  │ │  ◄─ NO cascade
  │   │   else pdftoppm -r DPI -png -f p -l p -singlefile file -        │ │
  │   │         (ulimit + timeout wrapper, {signal}) ─► one PNG buffer   │ │
  │   │         ─► base64 ─► runCascade(pageImage) ─► page result        │ │
  │   │   RELEASE page buffer before next p (INP-07)                     │ │
  │   └──────────────────────────────────────────────────────────────────┘ │
  │                                                                        │
  │   ┌── image (tiff/gif/heic/bmp/png/jpeg/webp) ──────────────────────┐ │
  │   │ heic ─► heic-convert ─► sharp ; bmp ─► bmp-js ─► sharp(raw)      │ │
  │   │ tiff/gif ─► sharp {pages:-1} ─► N frame buffers (one at a time)  │ │
  │   │ each frame ─► normalize(PNG, grayscale?, resize<=cap) ─►         │ │
  │   │              base64 ─► runCascade(pageImage) ─► page result      │ │
  │   └──────────────────────────────────────────────────────────────────┘ │
  │                                                                        │
  │  assemble ordered pages[]  +  status_rollup (completed |              │
  │            completed_with_errors)  +  concatenated text               │
  │  finally: cleanup temp dir + DEREGISTER  (success | error | throw)     │
  └────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  jobs.complete(envelope)   ◄── unchanged Phase-1 shape, pages[] now N-element

  SIGTERM ─► shutdown.js drainAndCancel ─► for dir in registry: fs.rm(dir,recursive,force)
             (child processes killed via their {signal} when controllers abort)
```

### Recommended Project Structure (Claude's Discretion — proposed)
```
lib/v1/
├── sniff.js                 # EXTEND: add pdf/tiff/heic/bmp/gif magic bytes
├── input/
│   ├── caps.js              # env-driven MAX_PDF_PAGES, RASTER_DPI, MAX_OUTPUT_PIXELS (intFromEnv)
│   ├── spawn-capture.js     # THE subprocess seam: spawnCapture(cmd,args,{signal,ulimit,timeoutMs})
│   ├── temp.js              # createJobTempDir() + registry + cleanupJobTempDir() + drainAllTempDirs()
│   ├── pdf-text.js          # unpdf: getPageTexts(buffer) → string[]; sufficient(text) threshold
│   ├── rasterize.js         # pdfPageCount(path,{signal}); renderPage(path,p,{dpi,signal}) → Buffer(PNG)
│   ├── image-normalize.js   # sharp/heic/bmp → normalized PNG frame buffers (page-aware)
│   └── page-pipeline.js     # orchestrate: sniffedType → frames/pages → runCascade → pages[]+rollup
```
`worker.js` gains a third dispatch branch (`runInputJob`) alongside `runForced`/`runCascadeJob`; `shutdown.js` `drainAndCancel` calls `drainAllTempDirs()`.

### Pattern 1: Killable, resource-limited subprocess (INP-08 — the deepest requirement)

**What:** Every poppler call goes through one `spawnCapture` helper that (a) binds the Phase-2 job `AbortSignal` to child termination, (b) implements SIGTERM→SIGKILL escalation Node does *not* do for you, (c) caps memory/CPU via a `sh -c 'ulimit …; exec'` wrapper, and (d) adds `timeout(1)` as a hard wall-clock backstop.

**Key verified facts:**
- `spawn(cmd, args, { signal })` — when the AbortController aborts, Node kills the child (like `.kill()`); the callback/`error` event gets an `AbortError`. [CITED: nodejs.org/api/child_process — "signal" option]
- `killSignal` (default `'SIGTERM'`) controls **which** signal the abort sends. [CITED: nodejs.org/api/child_process]
- Node does **NOT** auto-escalate to SIGKILL — you must set a timer and call `child.kill('SIGKILL')` yourself if it hasn't exited. [ASSUMED: Node core has no built-in grace-then-kill; confirmed by execa implementing this pattern itself]
- On bookworm-slim, `sh -c 'ulimit -v <KB>; ulimit -t <sec>; exec pdftoppm …'` caps address space (`-v`) and CPU seconds (`-t`); `exec` replaces the shell so the AbortSignal/kill reaches poppler directly (no orphan). `ulimit -m` (RSS) is **not enforced** on modern Linux — use `-v`. [ASSUMED: standard POSIX shell behavior; validate in Docker smoke]
- `tini` (PID 1) reaps any child that does slip through — but the worker must still actively kill, not rely on tini.

**Example shape (verified primitives; validate ulimit numbers in Docker):**
```js
// lib/v1/input/spawn-capture.js
const { spawn } = require('node:child_process');

// deps injection matches shutdown.js house style → node --test stubs `spawnFn`
function spawnCapture(cmd, args, {
  signal,                 // the Phase-2 job AbortSignal
  ulimitKB,               // e.g. 768*1024 address-space cap
  ulimitCpuSec,           // e.g. 20 CPU seconds
  wallMs = 30000,         // timeout(1) backstop
  killGraceMs = 2000,     // SIGTERM → wait → SIGKILL
  maxStdoutBytes,         // cap captured output (pixel-bomb guard on the PNG)
  spawnFn = spawn,        // <-- injectable seam (D-11)
} = {}) {
  // Wrap so ulimit applies, timeout(1) backstops, exec keeps signals flowing to poppler
  const shellCmd =
    `ulimit -v ${ulimitKB}; ulimit -t ${ulimitCpuSec}; ` +
    `exec timeout -s KILL ${Math.ceil(wallMs/1000)}s ${cmd} ${args.join(' ')}`;

  return new Promise((resolve, reject) => {
    const child = spawnFn('/bin/sh', ['-c', shellCmd], {
      signal,
      killSignal: 'SIGTERM',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // SIGTERM→SIGKILL escalation Node does NOT do automatically:
    let killTimer = null;
    const escalate = () => {
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, killGraceMs);
      if (killTimer.unref) killTimer.unref();
    };
    if (signal) signal.addEventListener('abort', escalate, { once: true });

    const chunks = []; let bytes = 0; const errChunks = [];
    child.stdout.on('data', (d) => {
      bytes += d.length;
      if (maxStdoutBytes && bytes > maxStdoutBytes) { try { child.kill('SIGKILL'); } catch {} return reject(new Error('output_pixel_cap_exceeded')); }
      chunks.push(d);
    });
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (e) => { if (killTimer) clearTimeout(killTimer); reject(e); });   // AbortError lands here
    child.on('close', (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(Object.assign(new Error('subprocess_failed'), { code, sig, stderr: Buffer.concat(errChunks).toString() }));
    });
  });
}
module.exports = { spawnCapture };
```

### Pattern 2: Stream one page in memory at a time (INP-04/07)

**What:** `pdftoppm` can write a single page to **stdout** when the output filename is `-` and `-singlefile` is set — so each page is a captured buffer, never an all-pages temp explosion. [CITED: manpages.debian.org — "If the output-file is '-', the output is written to stdout. Using stdout is not valid with image formats unless -singlefile is used."]

**Flow:** write the uploaded PDF buffer to **one** temp file (`input.pdf`) → `pdfinfo input.pdf` for page count (cap check) → loop pages, each `pdftoppm -r <DPI> -png -f p -l p -singlefile input.pdf -` capturing one PNG buffer → base64 → `runCascade` → drop the buffer → next page. Only the input PDF is on disk; only one page image is ever in memory.

**Verified flags** [CITED: manpages.debian.org/bookworm/poppler-utils/pdftoppm.1]:
- `-r N` X&Y DPI (default 150 — **always set explicitly**, e.g. 200–300); `-rx`/`-ry` per-axis
- `-f N` / `-l N` first/last page; `-singlefile` writes one page, no digit suffix (required for stdout)
- `-png` (also `-jpeg`, `-tiff`, `-mono`), `-gray` grayscale
- `-scale-to N` caps the long side to N pixels; `-scale-to-x`/`-scale-to-y` per-axis — **use `-scale-to <MAX_DIM>` as a second-layer pixel ceiling** even after DPI is chosen (defends against huge-MediaBox pages)

### Pattern 3: Native-vs-scanned decision (INP-03)

**What:** `unpdf.getDocumentProxy(uint8)` + per-page `extractText` (`mergePages:false`) yields `text[]`. A page counts as "native" if its extracted text clears a **sufficiency threshold**; otherwise treat as scanned → rasterize.

**Recommended threshold (Claude's Discretion — starting point, tune in Docker smoke):** page is native if `trimmed.length >= MIN_NATIVE_CHARS` (default **~16**) AND it contains at least a few word-like tokens (`/\p{L}{2,}/u` matches). Rationale: scanned pages typically extract to empty or a handful of stray ligature/space chars; a hard floor of ~16 meaningful chars avoids treating a near-empty page as native and skipping OCR that would have found the text. Make it env-tunable (`MIN_NATIVE_CHARS`). Mixed PDFs are handled per-page (some pages native, some rasterized) — this is why per-page extraction matters.

### Pattern 4: Per-page rollup on the UNCHANGED envelope (INP-06)

**What:** The Phase-1 envelope is `{ text, pages:[{page,text,engine,confidence}], engine, provider, mode, trace, low_confidence, bytes_received }`. Phase 3 makes `pages[]` genuinely N-element and adds `status_rollup`. **Additive only** — existing single-image jobs still emit a 1-element `pages[]`.

**Accumulator pattern:** iterate pages/frames in order; wrap each page's work in try/catch. Success → push `{page, text, engine, confidence}`. Failure → push `{page, text:'', engine:null, confidence:null, error:{code,message}}` and set `status_rollup='completed_with_errors'` (never throw out of the loop, never drop the page). Concatenated `text` joins only non-empty page texts. `engine`/`provider` at envelope top become the **winning/most-common** engine or a summary (planner decides; simplest: first successful page's engine, or `'mixed'`). Trace: keep per-page traces under each page or a compact job-level summary — planner decides, but do not break the existing `trace` consumers (worker logging asserts on `trace.winning_engine`, `trace.elapsed_ms`).

### Pattern 5: Move the job deadline up (integration)

**What:** Today the authoritative `AbortController` is created *inside* `runCascadeJob`, wrapping only the cascade. Phase 3's rasterization must **also** be bounded by that single deadline (JOB-04). Create the controller at the **top of the input job** in `worker.js`, pass `signal` to `spawnCapture` (poppler), `pdfinfo`, and as `deadlineSignal` to each `runCascade` call. One deadline → both rasterization and cascade abort together. **Open question:** whether the profile `budgetMs` is the whole-job budget (shared across N pages) or per-page — see Open Questions Q1.

### Pattern 6: CI dependency scan (OPS-06)

```bash
# CI step (fails the build on high+ advisories in production deps)
npm audit --omit=dev --audit-level=high
```
Document in README/CI. **Caveat (real finding):** the *existing* production deps already trip `npm audit` at `high` (axios, form-data) and `moderate` (express→qs, body-parser) — see Open Questions Q4. The gate threshold and a remediation of current advisories must be decided together, or the very first CI run red-fails.

### Anti-Patterns to Avoid
- **Rasterizing all pages up front** into a temp dir then looping — defeats the one-page-in-memory rule (INP-07). Render per page, capture stdout.
- **Relying on `signal` alone to bound memory** — AbortSignal kills on *time*, not on RSS. A decompression-bomb page can blow memory *before* the deadline. Cap with `ulimit -v` + `-scale-to` + `pdfinfo` precheck + `sharp.limitInputPixels`.
- **Assuming Node escalates to SIGKILL** — it does not; a poppler process ignoring SIGTERM would hang the concurrency-1 worker. Implement the kill timer.
- **Letting `sh -c` run poppler without `exec`** — without `exec`, the signal goes to the shell, not poppler → orphaned child. Always `exec`.
- **Cleaning temp only in the happy path** — must be `finally` AND registered for SIGTERM drain. This is the #1 leak vector.
- **Trusting the client content-type / multipart mimetype** — sniff by magic bytes (existing pattern); a `.pdf`-named JPEG must route as JPEG.
- **`sharp(heicBuffer)` or `sharp(bmpBuffer)`** — throws (no HEVC/BMP in prebuilt libvips). Decode first (heic-convert / bmp-js), then sharp.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF → raster page | Custom PDF renderer / ImageMagick shell | `pdftoppm` | Battle-tested Splash backend, per-page low memory, controllable DPI; forbidden alternatives pull GS/IM |
| PDF page count | Parse xref yourself | `pdfinfo` | Handles linearized/encrypted/broken PDFs; one clean integer |
| Embedded PDF text | Byte-scan content streams | `unpdf` (`extractText`) | PDF.js text-layer extraction with proper glyph/space handling |
| Multipage TIFF / GIF frames | Manual IFD/frame parsing | `sharp { pages:-1 }` / `{ page:n }` | libvips reads all frames; you loop and re-encode |
| HEIC decode | libheif build | `heic-convert` (WASM) | No HEVC patent build, no system libheif |
| BMP decode | DIB header parser | `@vingle/bmp-js` | Handles the BMP variants libvips prebuilt can't |
| Decompression-bomb guard | Custom pixel math | `sharp.limitInputPixels` (default 268402689) + `-scale-to` | Built-in, tune the number down to your budget |
| Subprocess wall-clock kill | Homegrown timers only | `timeout(1)` + AbortSignal + kill timer | Layered defense; coreutils `timeout` is a hard OS backstop |
| Child memory/CPU cap | Node has none | `ulimit -v` / `-t` via `sh -c '…; exec'` | Kernel-enforced; Node offers no child resource limits |
| Recursive temp cleanup | `rm -rf` shell | `fs.rm(dir,{recursive:true,force:true})` | Cross-safe, no subprocess, idempotent with `force` |

**Key insight:** Every "hard" part of this phase already has a battle-tested tool. The *engineering* is in the **wiring** — one deadline across raster+cascade, one temp registry drained on SIGTERM, one subprocess seam that's both sandboxed and mockable — not in the decoders themselves.

## Common Pitfalls

### Pitfall 1: Decompression bomb blows memory before the deadline fires
**What goes wrong:** A 20 KB PDF with a 50000×50000 MediaBox rasterized at 300 DPI is tens of GB of pixels; sharp on a crafted tiny TIFF can allocate gigapixels. The AbortSignal deadline is a *time* bound and won't save you — the OOM happens in milliseconds.
**Why:** Pixel count is independent of input bytes (the memory-bounded queue only caps *input* size).
**How to avoid:** Layer four guards — (1) `pdfinfo` page-count cap → reject 413/422 pre-raster; (2) `pdftoppm -scale-to <MAX_DIM>` caps output long-side pixels regardless of MediaBox; (3) `ulimit -v` kills the child if it still over-allocates; (4) `sharp({ limitInputPixels: MAX_OUTPUT_PIXELS })` (default 268402689 ≈ 16383²) — **lower it** to your budget. [CITED: sharp docs — limitInputPixels default; manpages pdftoppm -scale-to]
**Warning signs:** worker RSS spikes; container OOM-kills; a job "succeeds" for tiny inputs but the box restarts.

### Pitfall 2: Temp dir leaks on mid-job SIGTERM
**What goes wrong:** Job is rasterizing when SIGTERM arrives; `drainAndCancel` fails the job but the `finally` cleanup never runs (process exits first) → temp files accumulate across deploys.
**Why:** The existing `drainAndCancel` knows about *jobs*, not *temp dirs*; a killed job's `finally` may not execute within the grace window.
**How to avoid:** Module-level registry `Set<string>` of active temp dirs; `createJobTempDir` adds, `finally` removes, and `drainAndCancel` calls `drainAllTempDirs()` (best-effort `fs.rm` each) inside its shutdown sequence. Idempotent (`force:true`) so double-cleanup is safe. Verify in the Docker smoke: start a job, SIGTERM mid-raster, assert temp dir gone.
**Warning signs:** growing `/tmp` (or the temp root) across restarts.

### Pitfall 3: Native-text false positive skips OCR that was needed
**What goes wrong:** A scanned PDF page that happens to carry a tiny OCR text layer (or a page number) extracts a few chars → judged "native" → OCR skipped → near-empty result returned.
**Why:** A naive `text.length > 0` threshold treats stray glyphs as real content.
**How to avoid:** Require a meaningful floor (`MIN_NATIVE_CHARS ~16`) AND word-like tokens; when in doubt, rasterize (OCR is the fallback the product promises). Make it env-tunable and validate against a mixed sample in the Docker/live smoke.
**Warning signs:** native-PDF jobs returning suspiciously short text vs. a rasterized re-run.

### Pitfall 4: `sh -c` without `exec` orphans poppler
**What goes wrong:** `spawn('/bin/sh',['-c','ulimit …; pdftoppm …'])` (no `exec`) — SIGTERM/abort kills the shell; poppler keeps running as an orphan (reparented to tini), still consuming CPU/memory.
**Why:** Without `exec`, poppler is a *child of the shell*, not the process Node signals.
**How to avoid:** Always `exec` the final command so it *replaces* the shell PID and receives the signal directly.
**Warning signs:** zombie/high-CPU `pdftoppm` after a job was aborted.

### Pitfall 5: HEIC decode blocks the event loop
**What goes wrong:** `heic-convert` does heavy WASM work largely **synchronously**; a big HEIC stalls the single event loop, delaying `/v1/health` and SIGTERM handling.
**Why:** WASM libheif isn't offloaded to a thread by default. [CITED: heic-convert README — "consider using a worker thread in production environments with high concurrency"]
**How to avoid:** Acceptable at concurrency-1 for typical inputs; if health-probe latency matters, cap HEIC input dimensions/size before decode, or (future) move decode to a `worker_thread`. Flag as a known characteristic, not a blocker.
**Warning signs:** health checks flapping during large-HEIC jobs.

### Pitfall 6: `-r` default of 150 DPI silently used
**What goes wrong:** Forgetting `-r` renders at 150 DPI — often too low for reliable OCR of small text, degrading cascade quality for no obvious reason.
**Why:** poppler's default is 150. [CITED: manpages pdftoppm]
**How to avoid:** Always pass `-r` from config (`RASTER_DPI` default 200–300). Balance against the pixel cap.

## Code Examples

### pdfinfo → page count (with the seam + signal)
```js
// lib/v1/input/rasterize.js
const { spawnCapture } = require('./spawn-capture');
async function pdfPageCount(pdfPath, { signal, spawnFn } = {}) {
  const out = (await spawnCapture('pdfinfo', [pdfPath], { signal, wallMs: 10000, spawnFn })).toString();
  const m = out.match(/^Pages:\s+(\d+)/m);       // pdfinfo prints "Pages:   N"
  if (!m) throw new Error('pdfinfo_no_page_count');
  return Number(m[1]);
}
```

### Render one page to a captured PNG buffer
```js
async function renderPage(pdfPath, page, { dpi, maxDim, signal, spawnFn } = {}) {
  // -f/-l pin the page; -singlefile + '-' stream to stdout; -scale-to caps long side
  const args = ['-r', String(dpi), '-png', '-f', String(page), '-l', String(page),
                '-singlefile', '-scale-to', String(maxDim), pdfPath, '-'];
  return spawnCapture('pdftoppm', args, {
    signal, ulimitKB: 768 * 1024, ulimitCpuSec: 20, wallMs: 30000,
    maxStdoutBytes: 40 * 1024 * 1024, spawnFn,           // PNG buffer size ceiling
  });                                                     // → Buffer (one page PNG)
}
```

### unpdf per-page text (native-vs-scanned)
```js
// lib/v1/input/pdf-text.js  (unpdf is ESM → dynamic import from CJS)
async function getPageTexts(pdfBuffer) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
  const { text } = await extractText(pdf, { mergePages: false }); // text: string[] per page
  return text;
}
const WORD = /\p{L}{2,}/u;
function sufficient(t, min = 16) { const s = (t || '').trim(); return s.length >= min && WORD.test(s); }
```

### sharp — multipage TIFF/GIF → per-frame normalized PNG buffers
```js
// lib/v1/input/image-normalize.js
const sharp = require('sharp');
async function tiffOrGifFrames(buf, { maxPixels, maxDim }) {
  const meta = await sharp(buf, { limitInputPixels: maxPixels, pages: -1 }).metadata();
  const n = meta.pages || 1;
  const out = [];
  for (let p = 0; p < n; p++) {                       // one frame in memory at a time
    const png = await sharp(buf, { limitInputPixels: maxPixels, page: p })
      .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
      .grayscale()                                     // optional, OCR-friendly
      .png().toBuffer();
    out.push(png);
  }
  return out;                                          // caller base64s + runCascade per frame, releasing each
}
```

### HEIC / BMP → sharp handoff
```js
async function heicToPng(buf, opts) {
  const convert = require('heic-convert');
  const jpg = await convert({ buffer: buf, format: 'JPEG', quality: 0.92 });
  return sharp(jpg, { limitInputPixels: opts.maxPixels })
    .resize({ width: opts.maxDim, height: opts.maxDim, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
}
function bmpToPng(buf, opts) {
  const bmp = require('@vingle/bmp-js');
  const { data, width, height } = bmp.decode(buf);     // data = raw pixels
  return sharp(data, { raw: { width, height, channels: 4 }, limitInputPixels: opts.maxPixels })
    .png().toBuffer();
}
```

### Temp-dir registry hooked into shutdown
```js
// lib/v1/input/temp.js
const os = require('node:os'); const path = require('node:path');
const { mkdtemp, rm } = require('node:fs/promises');
const active = new Set();
async function createJobTempDir() { const d = await mkdtemp(path.join(os.tmpdir(), 'ocr-job-')); active.add(d); return d; }
async function cleanupJobTempDir(d) { active.delete(d); await rm(d, { recursive: true, force: true }); }
async function drainAllTempDirs() { await Promise.allSettled([...active].map(d => rm(d, { recursive: true, force: true }))); active.clear(); }
module.exports = { createJobTempDir, cleanupJobTempDir, drainAllTempDirs };
// shutdown.js drainAndCancel: add `await require('./input/temp').drainAllTempDirs();` in the shutdown sequence.
```

### Testability seam (D-11) — host node --test stubs the subprocess
```js
// test/rasterize.test.js  — no poppler needed on host
const { test, mock } = require('node:test');
const assert = require('node:assert');
const { pdfPageCount } = require('../lib/v1/input/rasterize');

test('pdfPageCount parses pdfinfo output via injected spawn', async () => {
  const fakeSpawn = () => {                    // returns a fake ChildProcess emitting stdout+close
    const { EventEmitter } = require('node:events');
    const cp = new EventEmitter();
    cp.stdout = new EventEmitter(); cp.stderr = new EventEmitter(); cp.kill = () => {};
    queueMicrotask(() => { cp.stdout.emit('data', Buffer.from('Pages:   7\n')); cp.emit('close', 0, null); });
    return cp;
  };
  assert.equal(await pdfPageCount('/x.pdf', { spawnFn: fakeSpawn }), 7);
});
```
A **real-poppler** test is skip-guarded: `if (!which('pdftoppm')) t.skip('poppler Docker-only')` — runs green in the Docker smoke, skipped on host. `node:test` `mock.method` is available (verified) as an alternative to `spawnFn` injection, but `deps`/`spawnFn` injection matches the existing `shutdown.js(deps)` house style.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `pdfjs-dist` directly | `unpdf` (bundled serverless PDF.js) | pdfjs-dist v6 raised Node floor to ≥22.13 | No Node floor, no native deps for PDF text |
| sharp + custom libvips-with-libheif | `heic-convert` WASM | HEVC patent → prebuilt libvips excludes HEIC | Lighter image, no build-from-source |
| ImageMagick/GraphicsMagick+GS for PDF raster | `pdftoppm` (poppler) | long-standing OCR best practice | Fewer system packages, no policy.xml PDF blocks |
| `Number(env)||default` | `intFromEnv`/`floatFromEnv` (existing) | Phase 1 (WR-07) | Caps validated loudly at boot — reuse for new caps |

**Deprecated/outdated (do not use):** `pdf2pic`, `pdf-image`, ImageMagick `convert` for PDF, `pdfjs-dist@6` on Node<22.13, `sharp` for HEIC/BMP input, `node:20` base — all explicitly forbidden by CLAUDE.md.

## Runtime State Inventory

Not applicable — Phase 3 is **greenfield code addition** for the input layer, not a rename/refactor/migration. No stored data, live-service config, OS-registered state, secrets, or build artifacts carry a string being renamed. (Verified: the phase adds new modules + deps; it does not rename existing identifiers, DB keys, or service names.)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `ulimit -v <KB>` reliably caps poppler address space on bookworm-slim without breaking legitimate rendering | Pattern 1 | Too-low `-v` fails valid large pages; too-high defeats the guard. **Validate the number in the Docker smoke.** |
| A2 | Node has no built-in SIGTERM→SIGKILL escalation; worker must implement the kill timer | Pattern 1 | If wrong, the escalation timer is harmless redundancy; if right (it is), omitting it risks a hung worker |
| A3 | `MIN_NATIVE_CHARS ~16` + word-token test is a defensible native-vs-scanned threshold | Pattern 3 | Mis-tuned → skips needed OCR or over-rasterizes native PDFs. Env-tunable; calibrate on a mixed sample |
| A4 | Default DPI 200–300 and `-scale-to`/pixel caps fit the VPS memory budget at concurrency-1 | Standard Stack, Pattern 2 | Actual VPS RAM unknown to research; caps must be sized to the real budget (see Q2) |
| A5 | `heic-convert` decodes the target VPS's HEIC samples correctly (patched libheif in WASM) | Pitfall 5 | STATE HEIC-in-Docker risk-flag — **must be proven in the Docker smoke**, not assumed |
| A6 | `timeout(1)` and `sh`/`ulimit` (dash) are present in `node:22-bookworm-slim` | Standard Stack | coreutils/dash are in the Debian base; confirm in the Docker smoke |
| A7 | `unpdf` is ESM-only and must be `await import()`ed from the CJS codebase | Code Examples | If it also ships CJS, plain `require` works — dynamic import is safe either way |

## Open Questions

1. **Job budget across N pages (JOB-04 semantics).**
   - Known: today `budgetMs` (per profile) bounds one cascade run; Phase 3 has N pages + rasterization under one deadline (Pattern 5).
   - Unclear: is `budgetMs` the **whole-job** budget (a 50-page PDF must finish within it — likely too tight) or **per-page** (a 50-page scan could run 50× the budget — cost/latency blowup)?
   - Recommendation: introduce a separate whole-job ceiling (e.g. `MAX_JOB_MS`) OR a per-page budget with a page cap so total is bounded; planner decides. Rasterization time also counts against JOB-04 — allocate a slice for it.

2. **Actual VPS memory budget → concrete cap numbers.**
   - Known: caps must fit "the VPS memory budget"; queue depth × upload size already sized in Phase 1.
   - Unclear: real RAM ceiling and safe `MAX_PDF_PAGES` / `RASTER_DPI` / `MAX_OUTPUT_PIXELS` / `ulimit -v`.
   - Recommendation: pick conservative defaults (e.g. MAX_PDF_PAGES 50, DPI 200, MAX_OUTPUT_PIXELS ~25 MP, ulimit -v 768 MB), all env-tunable, and confirm against the deployed box.

3. **Envelope top-level `engine`/`provider`/`trace` for multi-page (INP-06).**
   - Known: worker logging + tests assert on `trace.winning_engine`, `trace.elapsed_ms`, envelope `engine`/`provider`.
   - Unclear: what these mean when pages have different winning engines.
   - Recommendation: set top-level `engine` to a summary (`'mixed'` or the most-frequent), keep per-page engine authoritative, and either nest per-page traces or emit a job-level trace summary that preserves the asserted keys. Planner must review existing worker-logging tests before choosing.

4. **OPS-06 audit gate vs. existing advisories (real finding).**
   - Known: `npm audit` on the *current* production deps already reports **2 high** (axios, form-data), **2 moderate** (express→qs, body-parser), **1 low** on 2026-07-23 — a `--audit-level=high` gate would red-fail immediately.
   - Recommendation: pair the gate with a remediation of the current advisories (bump axios/express/multer stack, run `npm audit fix`) so the first CI run is green; or scope the gate to production deps + an allowlist while remediating. Decide gate strictness (`high` vs `critical`) explicitly.

## Environment Availability

| Dependency | Required By | Available (host) | Available (Docker) | Fallback |
|------------|------------|------------------|--------------------|----------|
| `pdftoppm` / `pdfinfo` (poppler-utils) | Scanned PDF raster + page count | ✗ (confirmed) | ✓ (Dockerfile line 23) | None — Docker-only; host tests stub the seam (D-11) |
| `timeout(1)` (coreutils) | Subprocess wall-clock backstop | likely ✓ | ✓ (Debian base) | AbortSignal + kill timer still bound it |
| `sh`/`ulimit` (dash) | Child memory/CPU cap | ✓ | ✓ (Debian base) | None needed |
| Node 22 (`spawn`, `fs.mkdtemp`, `AbortController`) | Everything | ✓ | ✓ | None |
| `sharp` prebuilt libvips | Image normalize | ✓ (npm prebuilt) | ✓ | None |
| `heic-convert` (WASM) | HEIC decode | ✓ | ✓ (needs Docker smoke — A5) | None |
| `@vingle/bmp-js` / `unpdf` | BMP / PDF text | ✓ | ✓ | None |

**Missing dependencies with no fallback:** poppler is host-absent by design (D-11) — mitigated by the mockable seam (host unit tests) + Docker smoke (real validation). Not a blocker.
**Missing dependencies with fallback:** none blocking.

## Security Domain

`security_enforcement` is not set to `false` in config (absent = enabled) → included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control (this phase) |
|---------------|---------|------------------------------|
| V1 Encoding/Sanitization | yes | Magic-byte sniff is authoritative (never client content-type); reject unknown/spoofed → 422 (D-06) |
| V5 Input Validation | **yes** | Page-count/DPI/pixel caps (D-03); `sharp.limitInputPixels`; `pdfinfo` precheck; multer size cap (API-07) |
| V10 Malicious Code / Deserialization | yes | Untrusted decode/raster isolated in a killable, `ulimit`-bounded subprocess (D-07/INP-08); no eval of doc content |
| V12 Files & Resources | **yes** | Per-job temp dir with guaranteed cleanup incl. mid-job kill; bounded in-memory buffers; no path from client-controlled names |
| V14 Configuration | yes | No new system packages; forbidden-lib list enforced; deps pinned + CI `npm audit` (OPS-06) |
| V2 Auth / V3 Session / V4 Access Control | no | Unchanged from Phase 1 (bearer on `/v1`); this phase adds no auth surface |
| V6 Cryptography | no | No crypto introduced (temp naming uses non-security random) |

### Known Threat Patterns for the input pipeline

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Decompression / pixel bomb (tiny file → gigapixel raster) | Denial of Service | `pdfinfo` page cap + `pdftoppm -scale-to` + `ulimit -v` + `sharp.limitInputPixels` (Pitfall 1) |
| Malicious PDF/HEIC exploiting the decoder | Elevation / Tampering | Isolated subprocess (poppler) with ulimit+timeout+kill; WASM sandbox for HEIC; kill on deadline |
| Content-type spoof (`.pdf` that is a script/JPEG) | Spoofing | Magic-byte sniff decides type; unknown → 422 (D-06) |
| Hung/looping renderer wedges concurrency-1 worker | Denial of Service | AbortSignal + `timeout(1)` + SIGTERM→SIGKILL escalation (Pattern 1) |
| Temp-file leak / disk exhaustion across deploys | Denial of Service | Registry-based cleanup drained by `drainAndCancel` on SIGTERM (Pitfall 2) |
| Orphaned child after abort | Denial of Service | `exec` in `sh -c` so the signal reaches poppler; `tini` reaps stragglers (Pitfall 4) |
| Vulnerable native decoder pin | Tampering / DoS | `sharp>=0.35.0` + CI `npm audit` gate (OPS-06) |

## Sources

### Primary (HIGH confidence)
- nodejs.org/api/child_process — `spawn` `signal`/`killSignal` options; abort → child kill with AbortError. (Node 22)
- manpages.debian.org/bookworm/poppler-utils/pdftoppm.1 — `-r`(default 150)/`-f`/`-l`/`-singlefile`/`-png`/`-gray`/`-scale-to`; stdout via `-` requires `-singlefile`.
- manpages.debian.org/bookworm/poppler-utils/pdfinfo.1 — `Pages:` field.
- npm registry (`npm view`, 2026-07-23) — unpdf 1.6.2, sharp 0.35.3, heic-convert 2.1.0, @vingle/bmp-js 0.2.5 (no 0.1.x), node-poppler 10.0.1.
- slopcheck 0.6.1 `install` scan — all four new packages `[OK]`, real source repos.
- `npm audit` (2026-07-23, current deps) — 2 high (axios, form-data), 2 moderate (qs/express, body-parser), 1 low. (OPS-06 finding)
- CLAUDE.md §Technology Stack / §What NOT to Use / §Version Compatibility — pinned versions + forbidden libs (authoritative).
- Shipped code read: `sniff.js`, `worker.js`, `router.js`, `upload.js`, `cascade/runner.js`, `shutdown.js`, `ocr.js`, `env.js`, `errors.js`, `Dockerfile`, `package.json`.

### Secondary (MEDIUM confidence)
- sharp docs — `limitInputPixels` default 268402689; `pages`/`page` multipage options (cross-checked with lovell/sharp issues).
- heic-convert README (github.com/catdad-experiments/heic-convert) — buffer API + "use a worker thread under high concurrency" note.

### Tertiary (LOW confidence — flagged for Docker-smoke validation)
- `ulimit -v` exact sizing on bookworm-slim (A1); HEIC-in-Docker decode correctness (A5) — both are STATE risk-flags, validated by the Docker integration smoke, not host tests.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified on npm 2026-07-23 + slopcheck; matches CLAUDE.md (one pin error caught: bmp-js).
- Subprocess sandbox mechanics: HIGH on Node primitives (spawn/signal/killSignal), MEDIUM on exact ulimit numbers (Docker-smoke to confirm).
- poppler flags: HIGH — Debian bookworm manpages.
- Architecture/integration: HIGH — read the actual shipped code; integration points concrete.
- HEIC-in-Docker: MEDIUM — library is correct; runtime decode must be proven in the smoke (STATE flag).

**Research date:** 2026-07-23
**Valid until:** ~2026-08-22 (30 days; stable stack). Re-verify `npm view` versions + `npm audit` at plan time.
