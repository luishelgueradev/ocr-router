<!-- GSD:project-start source:PROJECT.md -->
## Project

**ocr-router**

`ocr-router` is a dockerized document-recognition service exposed as an HTTP API (`/v1`, bearer-token secured, Whisper-style). A client submits a file — image, PDF, and later other formats — and the service **routes each request internally through an ordered cascade of recognition engines** (the cheap/fast `ocr.space` first, then cloud vision LLMs of increasing quality), automatically falling back up the chain until it produces a usable result. The client never has to know which engine ran; it can optionally force a model or pick a named profile.

It is for developers and automation pipelines (n8n and similar) that need reliable text/data extraction from documents without hand-managing multiple OCR providers, keys, and fallback logic.

**Core Value:** **Never fail to return the best available text/data for a document.** The cascade escalates quality automatically so a single API call always yields the best result any configured engine could produce — that reliability is the product.

### Constraints

- **Tech stack**: Node.js + Express — reuse the proven reference base rather than rewrite. Keeps the door open to add a local engine later as a provider.
- **Security**: Bearer token required on all `/v1` routes (fail-closed startup guard if `API_TOKEN` is missing/placeholder); admin surface never on `0.0.0.0` — Tailscale-bound only.
- **Deployment**: Must run as a Docker/Compose stack with Caddy + automatic HTTPS, self-hosted on a VPS.
- **External dependencies**: ocr.space API key (optional) and Ollama Cloud API key (subscription) supplied via env; service must degrade gracefully when a key is absent.
- **Resource**: Single-concurrency worker with a bounded in-memory queue (memory-exhaustion guard — each queued job holds its file buffer); adding PDF rasterization increases per-job memory, so page-level processing must be mindful of buffers.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Executive Recommendation
- **PDF native text extraction:** `unpdf` (bundles a serverless PDF.js, zero native deps).
- **PDF scanned-page rasterization:** `poppler-utils` `pdftoppm` (system binary), the OCR-grade gold standard, memory-efficient page-by-page. Optional pure-JS fallback: `unpdf` `renderPageAsImage` + `@napi-rs/canvas`.
- **Image normalization (TIFF multipage / WebP / GIF / resize / grayscale / DPI):** `sharp` (libvips, prebuilt binaries — no apt libvips needed).
- **HEIC decoding:** `heic-convert` (WASM libheif — no system libheif, no HEVC patent build headaches), then hand off to `sharp`.
- **Structured extraction:** `zod` v4 schemas → native `z.toJSONSchema()` → Ollama `format` param (constrained decoding) → `zod.safeParse()` validate + retry loop.
## Recommended Stack
### Core Technologies (NEW capabilities)
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `unpdf` | `^1.6.2` | Extract embedded text from native PDFs (per page); optional page rasterization | Modern ESM wrapper bundling a **serverless PDF.js v4.6.82** build, so it has **no Node-version floor** and **no native deps** — unlike `pdfjs-dist` v6 which now requires Node ≥22.13. Clean `extractText()` + `getDocumentProxy()` API gives per-page text for the native-vs-scanned decision. (MEDIUM→HIGH: verified on npm + official README) |
| `poppler-utils` (`pdftoppm`, `pdftotext`) | Debian 22.x (`poppler ~24.x`) | Rasterize scanned PDF pages → PNG/TIFF at controllable DPI for OCR; fast native text extraction | The industry-standard OCR preprocessing tool. `pdftoppm -r 300 -png` renders **page-by-page** (low peak memory — critical given the single-concurrency worker holds file buffers), controllable DPI, battle-tested rendering. Invoke via `child_process` or the `node-poppler` (`^10.0.1`) wrapper. (HIGH) |
| `sharp` | `^0.35.3` | Image normalization: decode/re-encode PNG/JPEG/WebP/GIF/TIFF, extract TIFF pages, grayscale, resize, DPI/density normalization, page compositing | The de-facto Node image pipeline (libvips). Ships **prebuilt libvips binaries** for glibc + musl (`@img/sharp-libvips-*@1.3.2`), so **no `apt install libvips` required**. Full **multipage TIFF** read via `{ pages: -1 }` / `{ page: n }`. Streams, low memory, fast. (HIGH) |
| `heic-convert` | `^2.1.0` | Decode HEIC/HEIF → JPEG/PNG buffer, then pass to `sharp` | `sharp`'s prebuilt libvips **cannot decode HEIC** (HEVC patent → libheif excluded from prebuilts). `heic-convert` uses `heic-decode`/`libheif-js` (WASM) — **pure JS, zero system deps**, matches the "keep the image light" constraint and avoids building libvips-from-source. (HIGH) |
| `zod` | `^4.4.3` | Schema definition + runtime validation for `mode=structured`; source of the JSON Schema sent to the LLM | Zod v4 ships **native `z.toJSONSchema()`** (the old `zod-to-json-schema` is now deprecated), is ~14x faster than v3, and `.describe()` text is carried into the schema as model guidance. One schema drives both the LLM contract and response validation. (HIGH) |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@napi-rs/canvas` | `^1.0.2` | Canvas backend required by `unpdf.renderPageAsImage()` | Only if you choose the **pure-JS rasterization fallback** (no poppler in image). Prebuilt N-API binary, no system deps. |
| `node-poppler` | `^10.0.1` | Typed wrapper over `pdftoppm`/`pdftotext`/`pdfinfo` | Optional convenience over raw `child_process`; still requires `poppler-utils` in the image. |
| `mupdf` (mupdf-js) | `^1.28.0` | All-in-one WASM: PDF text extraction **and** rasterization, single npm package | Alternative if you want **zero system deps** for the whole PDF path (replaces unpdf + poppler). WASM → higher memory/CPU per page than native poppler. (MEDIUM) |
| `bmp-js` / `@vingle/bmp-js` | `^0.1.0` | Decode BMP → raw pixels for `sharp` | Only if BMP input is actually exercised — `sharp`/libvips prebuilt **cannot read BMP** (needs libmagick). Small shim; BMP is rare. |
| `ajv` | `^8.20.0` | JSON Schema validation | Only if you validate against **hand-written JSON Schema** rather than Zod; otherwise redundant with `zod`. |
### Existing Reference Dependencies — Currency Review
| Library | Ref version | Current | Verdict |
|---------|-------------|---------|---------|
| `express` | `^4.22.1` | `4.22.x` / `5.2.1` | **Keep 4.22** for the ported modules. Express 5 is stable but has breaking changes (path-to-regexp, removed helpers) that would force reworking reused route/middleware code — not worth it for this milestone. (HIGH) |
| `multer` | `^2.1.1` | `2.2.0` | **Keep, bump to `^2.2.0`.** 2.x is the maintained line (1.x had advisories). Set `limits.fileSize`/`limits.files` to protect the memory-bounded worker. (HIGH) |
| `bottleneck` | `^2.19.5` | `2.19.5` | **Keep.** Stable and battle-tested though effectively feature-frozen. If you ever want an actively-maintained replacement, `p-queue`/`p-limit` cover concurrency; no reason to migrate now. (MEDIUM) |
| `pino` / `pino-http` | `^10 / ^11` | `10.3.1 / 11.0.0` | **Keep.** Current best practice for structured Node logging. (HIGH) |
| `lru-cache` | `^11.5.0` | `11.5.2` | **Keep** for the in-memory job store (TTL + max entries = natural job GC). (HIGH) |
| `uuid` | `^13.0.2` | `14.0.1` | **Keep or drop.** On Node ≥22 you can use the built-in `crypto.randomUUID()` and remove the dependency entirely; low priority. (HIGH) |
| `axios` | `^1.16.0` | `1.16.x` | **Keep** for existing providers. Native `fetch` is available on Node 22 if you want to shed it later; not required. (HIGH) |
| `dotenv` | `^17.4.2` | current | **Keep.** Node 22 also has `--env-file`, but `dotenv` is fine. (HIGH) |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| `node --test` | Test runner (already in use) | Keep; no external test framework needed. Add tests for router fallback matrix + per-format normalization. |
| `tini` / `dumb-init` | PID 1 signal forwarding | Already used. On `bookworm-slim` use `apt-get install -y tini` or `dumb-init`. |
## Installation
# Core NEW capabilities
# Optional — pure-JS PDF rasterization fallback (only if NOT using poppler-utils)
# Optional — typed poppler wrapper (still needs poppler-utils in the image)
# Optional — all-in-one WASM PDF path (replaces unpdf + poppler)
# npm install mupdf
# Optional — BMP input support (sharp/libvips cannot read BMP)
# npm install @vingle/bmp-js
### Dockerfile (base image + system packages)
# Move off Node 20 (EOL) → Node 22 LTS; Debian slim hosts poppler + prebuilt sharp cleanly
# NOT needed:
#   libvips-dev   → sharp ships prebuilt libvips (@img/sharp-libvips-*)
#   libheif / libde265 / x265 → HEIC handled by heic-convert (WASM), no HEVC build
#   fonts-*       → only matters for rendering text-PDFs; scanned PDFs are already raster
| Need | System package | Notes |
|------|----------------|-------|
| Scanned PDF → image | `poppler-utils` | Provides `pdftoppm`, `pdftotext`, `pdfinfo`. ~Debian poppler 24.x on bookworm. |
| Image processing (TIFF/WebP/GIF/resize) | **none** | `sharp` bundles libvips via `@img/sharp-libvips-*@1.3.2`. |
| HEIC decode | **none** | `heic-convert` is WASM/pure-JS. |
| BMP decode | **none** (JS shim) | Add `@vingle/bmp-js`; libvips prebuilt lacks BMP. |
| PID 1 / signals | `tini` | Already a pattern in the reference. |
## Input-Normalization Pipeline (recommended flow)
## Structured Extraction Pattern (`mode=structured`)
- Ollama's `format` parameter constrains generation to the schema and **works with vision models** — this is the reliable path vs. free-form "return JSON" prompting.
- One Zod schema is the single source of truth for both the LLM contract and validation. `.describe()` doubles as in-schema prompting.
- Keep a bounded retry loop (feed validation errors back) rather than infinite retries — respects the cascade's cost/latency budget.
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `unpdf` (native text) | `pdf-parse@^2.4.5` | `pdf-parse` v2 is revived/maintained (ESM, Node ≥20.16/22.3). Fine if you prefer its simpler `getText` API; `unpdf` wins on per-page control + no Node floor. |
| `unpdf` | `pdfjs-dist@^6.1.200` directly | Only if you need low-level PDF.js APIs **and** are on Node ≥22.13. Otherwise unpdf's bundled serverless PDF.js is less friction. |
| `pdftoppm` (poppler) | `unpdf.renderPageAsImage` + `@napi-rs/canvas` | Choose the JS path to keep the image free of `apt` deps; accept higher memory/CPU and slightly less OCR-tuned rendering. |
| `pdftoppm` (poppler) | `pdf2pic@^3.2.0` | Avoid — `pdf2pic` shells out to GraphicsMagick **and** Ghostscript (`gm` dep), i.e. *more* system packages than poppler alone for the same result. |
| `pdftoppm` + `unpdf` | `mupdf@^1.28.0` | Attractive all-in-one WASM (text + raster, zero system deps). Use if you want a single PDF engine and can absorb WASM memory/CPU per page. (MEDIUM) |
| `heic-convert` | `sharp` + libvips-with-libheif | Only if you already build/maintain a custom libvips with libheif/libde265 — heavier image, HEVC patent surface, more build complexity. Not worth it here. |
| `zod` v4 `toJSONSchema` | `@sinclair/typebox` + `ajv` | Use TypeBox/Ajv if the team prefers JSON-Schema-first authoring; Zod v4 native conversion removes the old reason to reach for these. |
| `express@4` | `express@5.2.1` | New sub-services with no ported express-4 middleware could start on 5; not worth reworking reused modules now. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `pdfjs-dist@6` on Node 20 | v6 `engines` requires Node **≥22.13 \|\| ≥24**; silently unsupported on the reference's Node 20 | `unpdf` (bundled PDF.js, no floor) or upgrade base to Node 22 |
| `pdf-parse@1.x` | Old unmaintained line; the maintained rewrite is v2 | `pdf-parse@^2` or `unpdf` |
| `pdf-image` / ImageMagick-`convert`-for-PDF | Depends on ImageMagick + Ghostscript policy config (PDF often blocked by `policy.xml`), fragile in containers | `pdftoppm` (poppler) |
| `pdf2pic` | Pulls GraphicsMagick **and** Ghostscript — more system deps than poppler for the same output | `pdftoppm` |
| `sharp` for HEIC input | Prebuilt libvips excludes HEVC/libheif; decode throws | `heic-convert` → `sharp` |
| `sharp` for BMP input | libvips BMP needs libmagick (not in prebuilt); decode throws | `@vingle/bmp-js` → `sharp`, or skip BMP |
| `zod-to-json-schema` pkg | Deprecated now that Zod v4 has native `z.toJSONSchema()` | `z.toJSONSchema()` |
| Free-form "reply with JSON" prompting | Unreliable; breaks on long/complex docs | Ollama `format` (schema-constrained) + Zod validate + retry |
| `node:20-*` base | Node 20 reached end-of-life (April 2026) | `node:22-bookworm-slim` (or `node:24`) |
## Stack Patterns by Variant
- Use `mupdf` (WASM) for both PDF text + rasterization, and `unpdf` can be dropped.
- Accept higher per-page CPU/memory; validate against your largest expected PDFs.
- Use `poppler-utils` `pdftoppm -r 300 -gray -png` (or `-tiff`) — the OCR-tuned, memory-frugal choice.
- Pair with `unpdf` for the cheap native-text short-circuit.
- Do **not** use `pdfjs-dist@6`. `unpdf` and `pdf-parse@2` both still work; upgrade to Node 22 at the first opportunity.
## Version Compatibility
| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `pdfjs-dist@^6.1.200` | Node ≥22.13 \|\| ≥24 | Hard engine floor — the reason to prefer `unpdf` or bump Node. |
| `unpdf@^1.6.2` | any modern Node (ESM) | Bundles serverless PDF.js v4.6.82; `renderPageAsImage` needs `@napi-rs/canvas`. |
| `sharp@^0.35.3` | Node ≥20.9; glibc + musl | Prebuilt libvips `1.3.2`; no `apt libvips`. No HEIC/BMP input. |
| `heic-convert@^2.1.0` | any modern Node | Pulls `heic-decode`/`libheif-js` (WASM). |
| `zod@^4.4.3` | any modern Node | `z.toJSONSchema()` native; deprecates `zod-to-json-schema`. |
| `multer@^2.2.0` | `express@4` and `@5` | Set `limits` to protect the bounded worker. |
| `express@4.22` | ported reference modules | Do not jump to Express 5 for reused middleware this milestone. |
## Sources
- npm registry (`npm view`, 2026-07-23) — verified current versions + `engines` for: pdfjs-dist 6.1.200 (Node ≥22.13), unpdf 1.6.2, pdf-parse 2.4.5, mupdf 1.28.0, sharp 0.35.3 (+libvips 1.3.2 prebuilts), heic-convert 2.1.0, zod 4.4.3, express 5.2.1/4.22, multer 2.2.0, bottleneck 2.19.5, pino 10.3.1, lru-cache 11.5.2, uuid 14.0.1, node-poppler 10.0.1, pdf2pic 3.2.0, @napi-rs/canvas 1.0.2. — HIGH
- unpdf README / npm — `extractText`, `getDocumentProxy`, `renderPageAsImage` needs `@napi-rs/canvas`, bundled serverless PDF.js v4.6.82. — HIGH
- github.com/lovell/sharp #3680 / #4479 — prebuilt binaries exclude HEIC (libheif licensing); use `heic-convert`. — HIGH
- libvips docs (multipage-and-animated-images; tiffload) — multipage TIFF via `page`/`n`; BMP requires libmagick. — HIGH
- docs.ollama.com/capabilities/structured-outputs + zod.dev/json-schema — `format` param schema-constrained decoding (incl. vision); Zod v4 native `toJSONSchema`, `zod-to-json-schema` deprecated. — HIGH
- Node.js release schedule — Node 20 EOL (2026), Node 22 LTS. — HIGH
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
