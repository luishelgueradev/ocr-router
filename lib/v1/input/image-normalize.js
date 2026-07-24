// INP-05 / INP-07 / D-04 / D-05 — normalize any admitted image to routable PNG frames.
//
// The cascade only routes plain single images, but the pipeline admits four
// awkward formats: multipage TIFF and animated GIF (multi-FRAME), plus HEIC and
// BMP (undecodable by prebuilt libvips directly). This module turns any of them
// — and the already-plain PNG/JPEG/WebP — into an ORDERED STREAM of normalized
// PNG frame buffers the page-pipeline (03-06) routes one at a time.
//
// Three safety properties are non-negotiable here (T-03-11 / Pitfall 1):
//   1. DECOMPRESSION-BOMB GUARD ON EVERY DECODE. sharp's own limitInputPixels
//      default (268402689 ≈ 16383²) is far too permissive for the single-worker
//      memory budget, so EVERY sharp() call is constructed with an explicit
//      `limitInputPixels: maxPixels` (from CAPS.MAX_OUTPUT_PIXELS) AND a
//      long-side resize cap (`fit:'inside', withoutEnlargement:true`). A crafted
//      gigapixel image is rejected at decode, never allocated.
//      CAVEAT (CR-03): BMP and HEIC decode to raw pixels BEFORE sharp sees them,
//      so limitInputPixels cannot protect those two. They carry their own
//      explicit header-dimension pre-check instead — see assertBmpWithinCap /
//      assertHeicWithinCap. Do not assume "sharp guards it" on those paths.
//   2. FRAME-COUNT CAP (CR-02). `meta.pages` is attacker-controlled: a small
//      animated GIF or multipage TIFF can declare thousands of frames, each of
//      which costs memory AND a paid cascade call. MAX_IMAGE_FRAMES gates it
//      before any frame is decoded, exactly as MAX_PDF_PAGES gates a PDF.
//   3. ONE FRAME IN MEMORY AT A TIME. `normalizeFrames` is an async GENERATOR:
//      for TIFF/GIF we read the frame COUNT via a cheap metadata() call, then
//      decode each frame individually with `{ page: p }` and YIELD it, so the
//      consumer releases it before the next is decoded. (The earlier version
//      accumulated every frame into one array and only claimed this property —
//      `normalizeToFrames` still collects, and is documented as such, but it is
//      a test convenience and not the production path.)
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
 * Pre-decode frame gate (CR-02) — the image-path twin of
 * `rasterize.assertPageCountWithinCap`. `meta.pages` comes straight out of an
 * attacker-supplied header, so it is checked BEFORE any frame is decoded.
 *
 * @param {number} n - declared frame count
 * @param {number} maxFrames - the cap
 * @throws {Error} typed `too_many_frames` (status 413) when n > cap
 */
function assertFrameCountWithinCap(n, maxFrames) {
  if (n > maxFrames) {
    const err = new Error('too_many_frames');
    err.code = 'too_many_frames';
    err.status = 413; // Payload Too Large — too many frames for the memory budget
    err.limit = maxFrames;
    err.actual = n;
    throw err;
  }
}

/**
 * Yield one normalized PNG per frame of a multipage TIFF / animated GIF, in
 * page order, ONE FRAME IN MEMORY AT A TIME.
 *
 * The frame count comes from a single metadata() read (itself carrying
 * limitInputPixels so a bomb is rejected before any pixels are decoded) and is
 * gated against MAX_IMAGE_FRAMES before the loop starts. Each frame is then
 * decoded independently via `{ page: p }` and YIELDED rather than accumulated,
 * so the consumer can release it before the next one is decoded (INP-07).
 *
 * @param {Buffer} buf
 * @param {number} maxPixels
 * @param {number} maxDim
 * @param {number} maxFrames
 * @yields {Buffer} a normalized PNG frame
 */
async function* multiFrameToPngs(buf, maxPixels, maxDim, maxFrames) {
  const meta = await sharp(buf, { limitInputPixels: maxPixels, pages: -1 }).metadata();
  const n = meta.pages || 1;
  assertFrameCountWithinCap(n, maxFrames);
  for (let p = 0; p < n; p++) {
    // Decode exactly one frame this iteration; yield its PNG and let the raw
    // decode be GC'd before the next `{ page }` read (INP-07).
    yield await normalizeOne(buf, maxPixels, maxDim, { page: p });
  }
}

// --- HEIC / BMP decode-first branches ------------------------------------
// These formats CANNOT be handed to sharp() directly (the prebuilt libvips
// excludes HEVC/libheif and BMP — CLAUDE.md "What NOT to Use"); they are decoded
// by heic-convert (WASM) / @vingle/bmp-js (pure-JS) FIRST, then run through the
// same limitInputPixels-guarded normalize pipeline.
//
// CR-03 — and this is exactly why these two paths need their OWN guard. sharp's
// `limitInputPixels` only takes effect once sharp is reached, but both decoders
// allocate the full raw framebuffer BEFORE that: they size the allocation from
// the file HEADER, with no cross-check against the actual file length. A ~60-byte
// upload declaring 20000x20000 makes @vingle/bmp-js run
// `Buffer.alloc(20000 * 20000 * 4)` = 1.6 GB — enough to OOM-kill the container
// on a small VPS. So the declared dimensions are validated against maxPixels
// BEFORE either decoder is handed the buffer.

/**
 * Reject a BMP whose HEADER declares more pixels than the cap, before
 * @vingle/bmp-js allocates `width * height * 4` bytes from those very numbers.
 *
 * @param {Buffer} buf - raw BMP bytes
 * @param {number} maxPixels - decoded-pixel ceiling
 * @throws {Error} typed `bmp_truncated` (422) / `image_pixel_cap_exceeded` (413)
 */
function assertBmpWithinCap(buf, maxPixels) {
  // 14-byte file header + at least a 12-byte BITMAPCOREHEADER.
  if (!Buffer.isBuffer(buf) || buf.length < 26) {
    const e = new Error('bmp_truncated');
    e.code = 'bmp_truncated';
    e.status = 422;
    throw e;
  }

  const dibSize = buf.readUInt32LE(14);
  let width;
  let height;
  if (dibSize === 12) {
    // BITMAPCOREHEADER: 16-bit dimensions.
    width = buf.readUInt16LE(18);
    height = buf.readUInt16LE(20);
  } else {
    // BITMAPINFOHEADER and later: 32-bit. A negative height is a legal
    // top-down bitmap, so compare on the magnitude.
    width = buf.readInt32LE(18);
    height = Math.abs(buf.readInt32LE(22));
  }

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    const e = new Error('bmp_truncated');
    e.code = 'bmp_truncated';
    e.status = 422;
    throw e;
  }

  const pixels = width * height;
  if (pixels > maxPixels) {
    const e = new Error('image_pixel_cap_exceeded');
    e.code = 'image_pixel_cap_exceeded';
    e.status = 413;
    e.limit = maxPixels;
    e.actual = pixels;
    throw e;
  }
}

// An HEIF `ispe` (ImageSpatialExtents) box is exactly 20 bytes:
// [4] size | 'ispe' | [1] version + [3] flags | [4] width | [4] height.
// It is where libheif reads the image dimensions from, so it is also where a
// decode-bomb has to declare them.
const ISPE_BOX_SIZE = 20;

/**
 * Reject a HEIC whose declared image extents exceed the cap, before
 * heic-convert (libheif WASM) allocates the full-size framebuffer.
 *
 * This is a targeted SCAN for `ispe` boxes rather than a full ISO-BMFF parser:
 * it walks every `ispe` occurrence, sanity-checks the box length, and takes the
 * LARGEST declared image (a HEIC carries one per item — typically the primary
 * image plus a thumbnail — and any of them may be decoded).
 *
 * KNOWN LIMIT, stated plainly: a file with no recognizable `ispe` box is allowed
 * through, because failing closed there would reject valid HEICs this scan
 * simply failed to understand. libheif needs an `ispe` to size its own decode,
 * so a bomb must declare one — but this guard is best-effort, NOT a proof, and
 * the residual exposure is bounded only by the container's own memory limit.
 * A worker-thread decode with a hard `--max-old-space-size` remains the
 * complete fix and is out of scope here.
 *
 * @param {Buffer} buf - raw HEIC bytes
 * @param {number} maxPixels - decoded-pixel ceiling
 * @throws {Error} typed `image_pixel_cap_exceeded` (413)
 */
function assertHeicWithinCap(buf, maxPixels) {
  if (!Buffer.isBuffer(buf)) return;

  let largest = 0;
  let i = 0;
  while ((i = buf.indexOf('ispe', i, 'ascii')) !== -1) {
    // The 4-byte box size sits immediately BEFORE the type.
    if (i >= 4 && i + 12 <= buf.length && buf.readUInt32BE(i - 4) === ISPE_BOX_SIZE) {
      const width = buf.readUInt32BE(i + 8);
      const height = buf.readUInt32BE(i + 12);
      if (width > 0 && height > 0) largest = Math.max(largest, width * height);
    }
    i += 4;
  }

  if (largest > maxPixels) {
    const e = new Error('image_pixel_cap_exceeded');
    e.code = 'image_pixel_cap_exceeded';
    e.status = 413;
    e.limit = maxPixels;
    e.actual = largest;
    throw e;
  }
}

/**
 * HEIC → sharp handoff. `sharp(heicBuffer)` throws (no HEVC/libheif in the
 * prebuilt libvips), so heic-convert (WASM) decodes to a JPEG buffer FIRST, then
 * the shared normalize pipeline (still limitInputPixels + resize capped) runs.
 * NOTE: heic-convert works largely synchronously (Pitfall 5 / T-03-12) —
 * acceptable at concurrency-1; a worker_thread is a future, out-of-scope
 * mitigation. Real HEIC decode on the target box is validated by the 03-07
 * Docker smoke (STATE risk-flag A5).
 *
 * @param {Buffer} buf
 * @param {number} maxPixels
 * @param {number} maxDim
 * @yields {Buffer} the single normalized PNG
 */
async function* heicToPngs(buf, maxPixels, maxDim) {
  assertHeicWithinCap(buf, maxPixels); // CR-03: BEFORE libheif allocates
  const convert = require('heic-convert');
  const jpg = await convert({ buffer: buf, format: 'JPEG', quality: 0.92 });
  yield await normalizeOne(Buffer.from(jpg), maxPixels, maxDim);
}

/**
 * BMP → sharp handoff. `sharp(bmpBuffer)` throws (prebuilt libvips lacks BMP),
 * so @vingle/bmp-js decodes to raw RGBA pixels FIRST, which sharp ingests via
 * `{ raw: { width, height, channels: 4 } }` and normalizes (limitInputPixels +
 * resize capped) to PNG.
 *
 * @param {Buffer} buf
 * @param {number} maxPixels
 * @param {number} maxDim
 * @yields {Buffer} the single normalized PNG
 */
async function* bmpToPngs(buf, maxPixels, maxDim) {
  assertBmpWithinCap(buf, maxPixels); // CR-03: BEFORE bmp-js Buffer.alloc's
  const bmp = require('@vingle/bmp-js');
  const { data, width, height } = bmp.decode(buf);
  yield await normalizeOne(data, maxPixels, maxDim, { raw: { width, height, channels: 4 } });
}

/**
 * Normalize an admitted image to an ordered STREAM of routable PNG frames.
 *
 * This is the production entry point (page-pipeline pulls one frame at a time,
 * routes it, and drops it before requesting the next) and the reason the
 * "ONE FRAME IN MEMORY AT A TIME" property above is real rather than aspirational.
 *
 * Dispatches on the magic-byte sniffed type (never the client content-type):
 *   - image/tiff, image/gif        → one PNG per frame, order preserved
 *   - image/png, image/jpeg,       → exactly one frame (straight-through)
 *     image/webp
 *   - image/heic                   → heic-convert → sharp (1 frame)
 *   - image/bmp                    → @vingle/bmp-js → sharp (1 frame)
 * Every path carries a decompression-bomb guard, and multi-frame inputs are
 * additionally gated on MAX_IMAGE_FRAMES. An unrecognized type is a typed
 * error, never a silent pass-through.
 *
 * Because an async generator body does not run until the first `next()`, the
 * dispatch error, the pixel guard and the frame-count gate all surface on that
 * first pull — i.e. BEFORE the caller has routed (and paid for) any page.
 *
 * @param {Buffer} buffer - the raw image bytes
 * @param {string} sniffedType - magic-byte MIME (image/tiff|gif|heic|bmp|png|jpeg|webp)
 * @param {object} [opts]
 * @param {number} [opts.maxPixels=CAPS.MAX_OUTPUT_PIXELS]   - limitInputPixels ceiling
 * @param {number} [opts.maxDim=CAPS.RASTER_MAX_DIM]         - resize long-side ceiling
 * @param {number} [opts.maxFrames=CAPS.MAX_IMAGE_FRAMES]    - frame-count cap
 * @yields {Buffer} normalized PNG frames, in order
 * @throws {Error} typed `unsupported_image_type` (422) / `too_many_frames` (413)
 */
async function* normalizeFrames(buffer, sniffedType, {
  maxPixels = CAPS.MAX_OUTPUT_PIXELS,
  maxDim = CAPS.RASTER_MAX_DIM,
  maxFrames = CAPS.MAX_IMAGE_FRAMES,
} = {}) {
  if (MULTIFRAME.has(sniffedType)) {
    yield* multiFrameToPngs(buffer, maxPixels, maxDim, maxFrames);
    return;
  }
  if (SHARP_SINGLE.has(sniffedType)) {
    yield await normalizeOne(buffer, maxPixels, maxDim);
    return;
  }
  if (sniffedType === 'image/heic') {
    yield* heicToPngs(buffer, maxPixels, maxDim);
    return;
  }
  if (sniffedType === 'image/bmp') {
    yield* bmpToPngs(buffer, maxPixels, maxDim);
    return;
  }

  const err = new Error('unsupported_image_type');
  err.code = 'unsupported_image_type';
  err.status = 422; // spoofed/unknown → typed client error, never a crash
  err.sniffedType = sniffedType;
  throw err;
}

/**
 * Array-collecting convenience over normalizeFrames, for callers that genuinely
 * want every frame at once (the unit tests). This DELIBERATELY materializes all
 * frames, so it does NOT carry the one-frame-in-memory property — production
 * code paths use `normalizeFrames` instead.
 *
 * @param {Buffer} buffer
 * @param {string} sniffedType
 * @param {object} [opts] - same as normalizeFrames
 * @returns {Promise<Buffer[]>} ordered normalized PNG frame buffers
 */
async function normalizeToFrames(buffer, sniffedType, opts = {}) {
  const out = [];
  for await (const frame of normalizeFrames(buffer, sniffedType, opts)) out.push(frame);
  return out;
}

module.exports = {
  normalizeFrames,
  normalizeToFrames,
  assertFrameCountWithinCap,
  assertBmpWithinCap,
  assertHeicWithinCap,
};
