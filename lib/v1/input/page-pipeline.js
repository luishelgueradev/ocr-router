// INP-03..08 / D-08 / D-10 / Pattern 4/5 — the page-pipeline ORCHESTRATOR.
//
// This is the user-visible keystone of the input phase: it turns any admitted
// document into ORDERED per-page results routed through the unchanged Phase-2
// cascade, with a per-page status rollup. It sits BEFORE the cascade and owns
// the per-page loop; the worker (03-06 runInputJob) owns the one job deadline,
// the temp-dir lifecycle, and job finalization — this module never touches
// jobs.* and never imports a provider directly.
//
// Two seams keep it host-testable (D-11) and cascade-agnostic:
//   - routePage(pageBase64, mimeType) is INJECTED by the worker (bound to
//     runCascade, or to a single forced engine). The pipeline only ever hands it
//     a base64 PNG — it has no idea which engines exist.
//   - spawnFn is INJECTED down to the rasterize seam so poppler (Docker-only)
//     is stubbed on the host; production leaves it undefined → real spawn.
//
// Safety properties (all load-bearing):
//   * Per-page try/catch accumulator (Pattern 4 / INP-06 / T-03-16): a page that
//     throws is recorded as an error page and the loop CONTINUES — one bad page
//     never fails the whole job and is never silently dropped; page order is
//     always preserved.
//   * ONE PAGE IMAGE IN MEMORY AT A TIME (INP-07): a scanned PDF page is
//     rasterized on demand and its buffer released before the next page; image
//     frames are released as they are routed.
//   * Over-cap PDFs are rejected (pdfinfo page count → assertPageCountWithinCap)
//     BEFORE any rasterization (T-03-15) — the typed error propagates out of the
//     loop so the worker can fail the job 413/422.

const path = require('node:path');
const { writeFile } = require('node:fs/promises');

const { getPageTexts, sufficient } = require('./pdf-text');
const { pdfInfo, assertPageCountWithinCap, renderPage } = require('./rasterize');
const { normalizeFrames } = require('./image-normalize');

// Rasterized PDF pages and normalized image frames are always PNG; the cascade
// only ever receives a plain image, so this is the mime it routes under.
const PAGE_IMAGE_MIME = 'image/png';

// Collapse the per-page engines/providers into a top-level summary (Q3): a
// single distinct engine surfaces as itself, differing engines as 'mixed', and
// none (all-failed) as null. Per-page `engine` stays the authoritative value.
function summarize(pages) {
  const engines = new Set();
  const providers = new Set();
  for (const p of pages) {
    if (p.engine) engines.add(p.engine);
    if (p.provider) providers.add(p.provider);
  }
  const pick = (set) => (set.size === 0 ? null : set.size === 1 ? [...set][0] : 'mixed');
  return { engine: pick(engines), provider: pick(providers) };
}

/**
 * Orchestrate an admitted document into ordered per-page results + a rollup.
 *
 * @param {object} args
 * @param {Buffer} args.buffer       - the raw uploaded bytes
 * @param {string} args.sniffedType  - magic-byte MIME (never the client type)
 * @param {string} [args.profile]    - resolved profile name (carried into trace)
 * @param {AbortSignal} [args.signal]- the one job deadline (bounds raster + route)
 * @param {string} args.tempDir      - per-job temp dir (the PDF is written here)
 * @param {Function} args.routePage  - injected (pageBase64, mimeType) → {text,engineId,provider,confidence,trace}
 * @param {Function} [args.spawnFn]  - injected poppler seam (D-11); undefined → real spawn
 * @returns {Promise<{text,pages,status_rollup,engine,provider,trace,low_confidence}>}
 * @throws {Error} typed `pdf_too_many_pages` (pre-raster) or a decoder/normalize error
 */
async function runPipeline({ buffer, sniffedType, profile, signal, tempDir, routePage, spawnFn } = {}) {
  const start = Date.now();
  const pages = [];
  const pageTraces = [];
  let hadError = false;
  let anyLowConfidence = false;

  // Record a page whose work threw — never rethrow, never drop it (INP-06).
  const pushError = (pageNum, err) => {
    hadError = true;
    pages.push({
      page: pageNum,
      text: '',
      engine: null,
      provider: null,
      confidence: null,
      error: {
        code: (err && err.code) || 'page_failed',
        message: (err && err.message) || 'page processing failed',
      },
    });
  };

  // Route one prepared page image and record its success result + per-page trace.
  const routeAndRecord = async (pageNum, b64) => {
    const r = await routePage(b64, PAGE_IMAGE_MIME);
    pages.push({
      page: pageNum,
      text: r.text,
      engine: r.engineId,
      provider: r.provider,
      confidence: r.confidence,
    });
    if (r.trace) {
      pageTraces.push(r.trace);
      if (r.trace.low_confidence) anyLowConfidence = true;
    }
  };

  if (sniffedType === 'application/pdf') {
    // Write the upload to ONE temp file; only the input PDF is ever on disk.
    const pdfPath = path.join(tempDir, 'input.pdf');
    await writeFile(pdfPath, buffer);

    // Pre-raster gate (T-03-15): reject an over-cap PDF before a single pixel is
    // drawn. This throw is intentionally OUTSIDE the per-page try/catch so it
    // propagates to the worker as a typed 413/422 job failure.
    // The same pdfinfo call also yields the page geometry, which renderPage
    // needs to make RASTER_DPI effective and RASTER_MAX_DIM a real ceiling
    // rather than a forced upscale target (CR-06). No extra subprocess.
    const { pages: pageCount, longEdgePts } = await pdfInfo(pdfPath, { signal, spawnFn });
    assertPageCountWithinCap(pageCount);

    // One in-process unpdf pass gives per-page embedded text for the
    // native-vs-scanned decision (mixed PDFs decided page-by-page).
    //
    // WR-04 — native-text extraction is an OPTIMIZATION, never a requirement.
    // This used to sit outside any try/catch, so ANY unpdf/PDF.js throw (a
    // password-protected PDF, a malformed xref, a construct PDF.js chokes on)
    // failed the ENTIRE job as internal_error — even though pdfinfo had already
    // succeeded, proving poppler can read the file and would have rasterized
    // every page just fine. Degrading to "treat all pages as scanned" is both
    // the product's stated core value (never fail to return the best available
    // text) and this module's own per-page-resilience design.
    let texts = [];
    try {
      texts = await getPageTexts(buffer);
    } catch {
      texts = []; // → sufficient('') is false for every page → all rasterized
    }

    for (let p = 1; p <= pageCount; p++) {
      try {
        const pageText = texts[p - 1] || '';
        if (sufficient(pageText)) {
          // Native fast path — record the embedded text and SKIP OCR entirely.
          pages.push({ page: p, text: pageText, engine: 'pdf-native', provider: 'pdf-native', confidence: 1 });
          continue;
        }
        // Scanned page — rasterize exactly this page, release the buffer before
        // routing so only one page image is ever held (INP-07).
        let png = await renderPage(pdfPath, p, { signal, spawnFn, longEdgePts });
        const b64 = png.toString('base64');
        png = null;
        await routeAndRecord(p, b64);
      } catch (err) {
        pushError(p, err);
      }
    }
  } else {
    // Image path — PULL ordered PNG frames one at a time (TIFF/GIF → N frames;
    // HEIC/BMP/PNG/JPEG/WebP → 1). Streaming rather than collecting is what
    // makes INP-07 real on the image path: only the frame being routed is held
    // (CR-02).
    const frames = normalizeFrames(buffer, sniffedType, {});

    // The FIRST pull runs the generator's dispatch, pixel guard and frame-count
    // gate. Deliberately outside the per-page try/catch: unsupported_image_type
    // / too_many_frames / a pixel-cap breach must fail the job typed BEFORE any
    // page is routed and paid for.
    let next = await frames.next();

    let p = 0;
    while (!next.done) {
      p += 1;
      try {
        let png = next.value;
        const b64 = png.toString('base64');
        png = null;       // release the frame before routing (INP-07)
        next.value = null;
        await routeAndRecord(p, b64);
      } catch (err) {
        pushError(p, err);
      }

      try {
        next = await frames.next();
      } catch (err) {
        // A frame that fails to DECODE mid-stream is recorded as a page error
        // rather than discarding the pages already routed (and paid for).
        pushError(p + 1, err);
        break;
      }
    }
  }

  const status_rollup = hadError ? 'completed_with_errors' : 'completed';
  const { engine, provider } = summarize(pages);
  // Concatenated text joins only the non-empty (successful/native) page texts.
  const text = pages.map((p) => p.text).filter((t) => t && t.length > 0).join('\n\n');

  // Job-level trace summary — preserves the winning_engine + elapsed_ms keys the
  // OBSV-03 worker logging asserts on, plus a compact per-page breakdown.
  const trace = {
    profile: profile ?? null,
    winning_engine: engine,
    low_confidence: anyLowConfidence,
    elapsed_ms: Date.now() - start,
    stopped_reason: status_rollup,
    pages_total: pages.length,
    pages_failed: pages.filter((p) => p.error).length,
    pages: pageTraces,
  };

  return { text, pages, status_rollup, engine, provider, trace, low_confidence: anyLowConfidence };
}

module.exports = { runPipeline };
