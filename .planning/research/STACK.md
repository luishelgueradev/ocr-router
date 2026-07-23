# Stack Research

**Domain:** Dockerized OCR / document-recognition API gateway (Node.js/Express, cascade router + multi-format input normalization)
**Researched:** 2026-07-23
**Confidence:** HIGH (versions verified against npm registry + official docs on 2026-07-23; a few ecosystem judgments marked MEDIUM inline)

## Executive Recommendation

The **new** work is two subsystems on top of the proven reference base: a cascade router and a multi-format input-normalization pipeline. For that pipeline the 2025 standard is:

- **PDF native text extraction:** `unpdf` (bundles a serverless PDF.js, zero native deps).
- **PDF scanned-page rasterization:** `poppler-utils` `pdftoppm` (system binary), the OCR-grade gold standard, memory-efficient page-by-page. Optional pure-JS fallback: `unpdf` `renderPageAsImage` + `@napi-rs/canvas`.
- **Image normalization (TIFF multipage / WebP / GIF / resize / grayscale / DPI):** `sharp` (libvips, prebuilt binaries — no apt libvips needed).
- **HEIC decoding:** `heic-convert` (WASM libheif — no system libheif, no HEVC patent build headaches), then hand off to `sharp`.
- **Structured extraction:** `zod` v4 schemas → native `z.toJSONSchema()` → Ollama `format` param (constrained decoding) → `zod.safeParse()` validate + retry loop.

Base image should move from `node:20-alpine` to **`node:22-bookworm-slim`** (Node 20 is EOL; Debian slim is the low-friction host for `poppler-utils` + prebuilt `sharp`/`libheif` WASM). All reference dependencies (express, multer, pino, bottleneck, lru-cache) remain current best practice with minor notes.

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

```bash
# Core NEW capabilities
npm install unpdf sharp heic-convert zod

# Optional — pure-JS PDF rasterization fallback (only if NOT using poppler-utils)
npm install @napi-rs/canvas

# Optional — typed poppler wrapper (still needs poppler-utils in the image)
npm install node-poppler

# Optional — all-in-one WASM PDF path (replaces unpdf + poppler)
# npm install mupdf

# Optional — BMP input support (sharp/libvips cannot read BMP)
# npm install @vingle/bmp-js
```

### Dockerfile (base image + system packages)

```dockerfile
# Move off Node 20 (EOL) → Node 22 LTS; Debian slim hosts poppler + prebuilt sharp cleanly
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \        # pdftoppm (raster), pdftotext, pdfinfo — scanned-PDF rasterization
      ca-certificates \
      tini \
    && rm -rf /var/lib/apt/lists/*

# NOT needed:
#   libvips-dev   → sharp ships prebuilt libvips (@img/sharp-libvips-*)
#   libheif / libde265 / x265 → HEIC handled by heic-convert (WASM), no HEVC build
#   fonts-*       → only matters for rendering text-PDFs; scanned PDFs are already raster
```

**System dependency summary:**

| Need | System package | Notes |
|------|----------------|-------|
| Scanned PDF → image | `poppler-utils` | Provides `pdftoppm`, `pdftotext`, `pdfinfo`. ~Debian poppler 24.x on bookworm. |
| Image processing (TIFF/WebP/GIF/resize) | **none** | `sharp` bundles libvips via `@img/sharp-libvips-*@1.3.2`. |
| HEIC decode | **none** | `heic-convert` is WASM/pure-JS. |
| BMP decode | **none** (JS shim) | Add `@vingle/bmp-js`; libvips prebuilt lacks BMP. |
| PID 1 / signals | `tini` | Already a pattern in the reference. |

> Alpine note: `sharp` prebuilds musl (`linuxmusl`) too, so `node:22-alpine` also works — but `bookworm-slim` is lower-friction for `poppler-utils` and native tooling, and avoids musl edge cases. Recommend **bookworm-slim**. (MEDIUM)

## Input-Normalization Pipeline (recommended flow)

```
upload → sniff MIME
  ├─ PDF:
  │    unpdf.extractText() per page
  │      ├─ text present & sane  → NATIVE path: return text per page (no OCR)
  │      └─ empty/garbage        → SCANNED path: pdftoppm -r 300 -png → per-page PNG → cascade OCR
  ├─ HEIC/HEIF: heic-convert → sharp (normalize) → cascade
  ├─ TIFF (multipage): sharp {pages:-1} → split pages → sharp per page → cascade
  ├─ WebP/GIF/BMP: (bmp-js if BMP →) sharp → normalize (grayscale/resize/DPI) → cascade
  └─ PNG/JPEG: sharp normalize → cascade
```

Key detail: the **native-vs-scanned decision** reuses the same low-confidence heuristic the router already needs (text length, garbage/non-printable ratio). `pdftoppm` renders **one page per invocation/output file**, so peak memory stays bounded — important because each queued job already holds its buffer.

## Structured Extraction Pattern (`mode=structured`)

```js
import { z } from "zod";

const Invoice = z.object({
  vendor: z.string().describe("Legal name of the issuing company"),
  total:  z.number().describe("Grand total including tax"),
  date:   z.string().describe("ISO 8601 invoice date"),
});

const jsonSchema = z.toJSONSchema(Invoice);          // native in Zod v4

// Ollama constrained decoding: pass schema to `format`
const res = await ollama.chat({
  model: "qwen3-vl:235b",
  messages: [{ role: "user", content: prompt, images: [b64] }],
  format: jsonSchema,                                 // grammar-constrains output
});

const parsed = Invoice.safeParse(JSON.parse(res.message.content));
// if (!parsed.success) → feed parsed.error back to the model and retry (self-correction loop)
```

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

**If minimizing container size / avoiding all `apt` packages is a hard requirement:**
- Use `mupdf` (WASM) for both PDF text + rasterization, and `unpdf` can be dropped.
- Accept higher per-page CPU/memory; validate against your largest expected PDFs.

**If OCR quality on scanned PDFs is the priority (default):**
- Use `poppler-utils` `pdftoppm -r 300 -gray -png` (or `-tiff`) — the OCR-tuned, memory-frugal choice.
- Pair with `unpdf` for the cheap native-text short-circuit.

**If you must stay on Node 20 for now:**
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

---
*Stack research for: dockerized OCR / document-recognition API gateway (ocr-router)*
*Researched: 2026-07-23*
