// INP-05 / INP-07 / D-04 / D-05 — normalize any admitted image to routable PNG frames.
//
// The cascade only routes plain single images, but the pipeline admits four
// awkward formats: multipage TIFF and animated GIF (multi-FRAME), plus HEIC and
// BMP (undecodable by prebuilt libvips directly). This module turns any of them
// — and the already-plain PNG/JPEG/WebP — into an ORDERED array of normalized
// PNG frame buffers the page-pipeline (03-06) can route one at a time.
//
// Two safety properties are non-negotiable here (T-03-11 / Pitfall 1):
//   1. DECOMPRESSION-BOMB GUARD ON EVERY DECODE. sharp's own limitInputPixels
//      default (268402689 ≈ 16383²) is far too permissive for the single-worker
//      memory budget, so EVERY sharp() call is constructed with an explicit
//      `limitInputPixels: maxPixels` (from CAPS.MAX_OUTPUT_PIXELS) AND a
//      long-side resize cap (`fit:'inside', withoutEnlargement:true`). A crafted
//      gigapixel image is rejected at decode, never allocated.
//   2. ONE FRAME IN MEMORY AT A TIME. For TIFF/GIF we read the frame COUNT via a
//      cheap metadata() call, then decode each frame individually with
//      `{ page: p }` inside the loop — we never decode all N frames into one
//      giant allocation (Anti-Patterns).
//
// HEIC and BMP must be DECODED FIRST (heic-convert WASM / @vingle/bmp-js pure-JS)
// and only then handed to sharp — `sharp(heicBuffer)` / `sharp(bmpBuffer)` throw
// because the prebuilt libvips excludes HEVC/libheif and BMP (CLAUDE.md
// "What NOT to Use"). All decoders are in-process (no subprocess), so this whole
// module is host-tested for real.

const sharp = require('sharp');
const { CAPS } = require('./caps');

// Sniffed types that sharp reads natively. TIFF/GIF are multi-frame; the rest
// are single-frame. HEIC/BMP are handled separately (decode-first).
const MULTIFRAME = new Set(['image/tiff', 'image/gif']);
const SHARP_SINGLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Run the shared normalize pipeline on ONE already-decodable input and return a
 * PNG buffer: bound decode by `limitInputPixels`, cap the long side by `maxDim`,
 * grayscale (OCR-friendly, smaller), re-encode PNG. `inputOpts` lets callers add
 * `{ page: p }` (one TIFF/GIF frame) or `{ raw: {...} }` (a bmp-js raw buffer).
 *
 * @param {Buffer} buf - the source bytes (or raw pixels when inputOpts.raw set)
 * @param {number} maxPixels - limitInputPixels ceiling
 * @param {number} maxDim - resize long-side ceiling
 * @param {object} [inputOpts] - extra sharp constructor options
 * @returns {Promise<Buffer>} a normalized PNG buffer
 */
function normalizeOne(buf, maxPixels, maxDim, inputOpts = {}) {
  return sharp(buf, { limitInputPixels: maxPixels, ...inputOpts })
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .png()
    .toBuffer();
}

/**
 * Decode a multipage TIFF or animated GIF into one normalized PNG per frame,
 * in page order, ONE FRAME IN MEMORY AT A TIME.
 *
 * The frame count comes from a single metadata() read (itself carrying
 * limitInputPixels so a bomb is rejected before any pixels are decoded); each
 * frame is then decoded independently via `{ page: p }` and released before the
 * next iteration — never an all-frames allocation.
 *
 * @param {Buffer} buf
 * @param {number} maxPixels
 * @param {number} maxDim
 * @returns {Promise<Buffer[]>} ordered PNG frame buffers
 */
async function multiFrameToPngs(buf, maxPixels, maxDim) {
  const meta = await sharp(buf, { limitInputPixels: maxPixels, pages: -1 }).metadata();
  const n = meta.pages || 1;
  const out = [];
  for (let p = 0; p < n; p++) {
    // Decode exactly one frame this iteration; push its PNG and let the raw
    // decode be GC'd before the next `{ page }` read (INP-07).
    out.push(await normalizeOne(buf, maxPixels, maxDim, { page: p }));
  }
  return out;
}

// --- HEIC / BMP decode-first branches ------------------------------------
// These formats CANNOT be handed to sharp() directly (the prebuilt libvips
// excludes HEVC/libheif and BMP — CLAUDE.md "What NOT to Use"); they must be
// decoded by heic-convert (WASM) / @vingle/bmp-js (pure-JS) FIRST, then run
// through the same normalize pipeline. Task 2 (03-05) fills these in.
async function heicToPngs(buf, maxPixels, maxDim) { // eslint-disable-line no-unused-vars
  throw new Error('image_decode_not_implemented: heic');
}
async function bmpToPngs(buf, maxPixels, maxDim) { // eslint-disable-line no-unused-vars
  throw new Error('image_decode_not_implemented: bmp');
}

/**
 * Normalize an admitted image to an ordered array of routable PNG frame buffers.
 *
 * Dispatches on the magic-byte sniffed type (never the client content-type):
 *   - image/tiff, image/gif        → one PNG per frame, order preserved
 *   - image/png, image/jpeg,       → a single-element array (straight-through)
 *     image/webp
 *   - image/heic                   → heic-convert → sharp (1 frame)
 *   - image/bmp                    → @vingle/bmp-js → sharp (1 frame)
 * Every path carries a decompression-bomb guard (limitInputPixels + resize cap).
 * An unrecognized type is a typed error, never a silent pass-through.
 *
 * @param {Buffer} buffer - the raw image bytes
 * @param {string} sniffedType - magic-byte MIME (image/tiff|gif|heic|bmp|png|jpeg|webp)
 * @param {object} [opts]
 * @param {number} [opts.maxPixels=CAPS.MAX_OUTPUT_PIXELS] - limitInputPixels ceiling
 * @param {number} [opts.maxDim=CAPS.RASTER_MAX_DIM]       - resize long-side ceiling
 * @returns {Promise<Buffer[]>} ordered normalized PNG frame buffers
 * @throws {Error} typed `unsupported_image_type` for an unknown sniffedType
 */
async function normalizeToFrames(buffer, sniffedType, {
  maxPixels = CAPS.MAX_OUTPUT_PIXELS,
  maxDim = CAPS.RASTER_MAX_DIM,
} = {}) {
  if (MULTIFRAME.has(sniffedType)) {
    return multiFrameToPngs(buffer, maxPixels, maxDim);
  }
  if (SHARP_SINGLE.has(sniffedType)) {
    return [await normalizeOne(buffer, maxPixels, maxDim)];
  }
  if (sniffedType === 'image/heic') {
    return heicToPngs(buffer, maxPixels, maxDim);
  }
  if (sniffedType === 'image/bmp') {
    return bmpToPngs(buffer, maxPixels, maxDim);
  }

  const err = new Error('unsupported_image_type');
  err.code = 'unsupported_image_type';
  err.status = 422; // spoofed/unknown → typed client error, never a crash
  err.sniffedType = sniffedType;
  throw err;
}

module.exports = { normalizeToFrames };
