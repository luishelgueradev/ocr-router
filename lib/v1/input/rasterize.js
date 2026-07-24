// INP-04 / INP-07 / D-02 / D-03 — memory-safe scanned-PDF rasterization.
//
// A scanned page has no embedded text (pdf-text.js#sufficient said "no"), so it
// must be rendered to an image and routed through the cascade. The whole memory
// model of this phase lives here: NEVER rasterize all pages up front into a temp
// dir — read the page count via `pdfinfo` FIRST (cheap), reject an over-cap PDF
// before a single pixel is drawn, then render EXACTLY ONE page at a time to a
// captured stdout buffer via `pdftoppm … -singlefile … -`. Only the input PDF
// is on disk; only one page image is ever in memory (INP-07).
//
// Every subprocess call funnels through the 03-03 `spawnCapture` seam, so this
// module inherits its four-layer decompression-bomb defense (Pitfall 1 / T-03-08):
//   1. pdfinfo page-count cap → typed reject BEFORE any raster (this module)
//   2. a long-side pixel ceiling of RASTER_MAX_DIM, applied as a CEILING and not
//      as a target — see the CR-06 note on renderPage
//   3. `ulimit -v` address-space kill (spawnCapture body)
//   4. MAX_RASTER_STDOUT_BYTES captured-output ceiling (spawnCapture)
// plus the AbortSignal deadline + SIGTERM→SIGKILL escalation from the seam.
//
// poppler is Docker-only (D-11): host `node --test` injects a fake `spawnFn`, so
// the whole module is exercised without a real subprocess.

const { spawnCapture } = require('./spawn-capture');
const { CAPS } = require('./caps');

// pdfinfo prints the page count as a `Pages:   N` line.
const PAGES_RE = /^Pages:\s+(\d+)/m;
// ...and the page geometry as `Page size:  595.276 x 841.89 pts (A4)`, or
// `Page    1 size: ...` when the pages differ in size.
const PAGE_SIZE_RE = /^Page\s+(?:\d+\s+)?size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/m;

// PDF user space is 1/72 inch per unit, so points/72 = inches and
// inches * dpi = the natural pixel count at that resolution.
const PTS_PER_INCH = 72;

// CR-01 — render-output validation. Under a tight `ulimit -v` poppler can exit
// 0 after emitting a TRUNCATED PNG (~90 bytes observed in the 03-07 Docker
// smoke). spawnCapture resolves on `code === 0`, so without this check that
// garbage was routed to a paid OCR provider, came back empty, and was recorded
// as a SUCCESSFUL page with no error — status_rollup stayed 'completed' and the
// client could not tell it apart from a genuinely blank page. For a service
// whose core value is "never fail to return the best available text", silently
// returning nothing while reporting success is worse than failing.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from('IEND', 'ascii');
// A real page render at any usable DPI is orders of magnitude larger than this;
// the floor only has to exclude the degenerate truncation case.
const MIN_PNG_BYTES = 1024;

/**
 * Reject a truncated / degenerate render rather than passing it off as a page.
 *
 * The IEND chunk check is the definitive truncation test: PNG's final chunk is
 * always the 4-byte length, the literal 'IEND', and its CRC, so a complete file
 * ALWAYS ends with `IEND<crc32>`. A render killed mid-write cannot have it.
 *
 * @param {Buffer} png - captured pdftoppm stdout
 * @param {number} page - 1-based page number, for the error payload
 * @throws {Error} typed `raster_output_truncated` (status 422)
 */
function assertRenderedPng(png, page) {
  const bytes = Buffer.isBuffer(png) ? png.length : 0;
  const valid =
    bytes >= MIN_PNG_BYTES &&
    png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) &&
    png.subarray(-8, -4).equals(PNG_IEND);

  if (!valid) {
    const err = new Error('raster_output_truncated');
    err.code = 'raster_output_truncated';
    err.status = 422;
    err.page = page;
    err.bytes = bytes; // a length, never the buffer itself (no payload leak)
    throw err;
  }
}

/**
 * Compute the `-scale-to` long-side pixel target for one page (CR-06).
 *
 * poppler's `-scale-to` "[s]cales each page so that its longer side is <number>
 * pixels in length" and — critically — "**overrides the -r option**". Passing a
 * constant `-scale-to RASTER_MAX_DIM` therefore did the OPPOSITE of the ceiling
 * the comments claimed: it made RASTER_DPI completely inert and FORCED every
 * page to 5000 px on its long edge, upscaling a normal A4 page ~2.1x (≈4.5x the
 * pixels) for zero OCR benefit — interpolated pixels carry no new information —
 * while pushing peak memory toward ULIMIT_V_KB and the PNG toward
 * MAX_RASTER_STDOUT_BYTES.
 *
 * Since poppler has no "scale down only" flag, we compute the target ourselves:
 * the page's NATURAL size at `dpi`, clamped to `maxDim`. Below the cap the page
 * renders at exactly the requested DPI (so RASTER_DPI is finally effective);
 * above it — a hostile or genuinely huge MediaBox — the cap binds and maxDim is
 * a real ceiling, bounding worst-case pixels at maxDim².
 *
 * @param {number} longEdgePts - the page's longer side in PDF points
 * @param {number} dpi - requested render resolution
 * @param {number} maxDim - long-side pixel ceiling
 * @returns {number|null} the -scale-to target, or null if geometry is unknown
 */
function computeScaleTo(longEdgePts, dpi, maxDim) {
  if (!Number.isFinite(longEdgePts) || longEdgePts <= 0) return null;
  if (!Number.isFinite(dpi) || dpi <= 0) return null;
  const natural = Math.round((longEdgePts / PTS_PER_INCH) * dpi);
  return Math.max(1, Math.min(maxDim, natural));
}

/**
 * Read a PDF's page count AND its page geometry via a single `pdfinfo` call
 * (through the sandbox seam). Cheap and robust for linearized/encrypted/broken
 * PDFs — one clean integer we gate on before rasterizing anything, plus the
 * page box renderPage needs to turn RASTER_DPI into a real resolution and
 * RASTER_MAX_DIM into a real ceiling (CR-06).
 *
 * CAVEAT: pdfinfo reports ONE page geometry (the first page's, or the shared one
 * when every page matches). For a PDF whose pages differ in size that figure is
 * a reference, not an exact per-page box, so a smaller page may render slightly
 * larger than its natural DPI size and a larger page slightly smaller. Both
 * stay bounded by `maxDim`, so the ceiling holds either way; only the DPI
 * fidelity of heterogeneous PDFs is approximate.
 *
 * @param {string} pdfPath - path to the input PDF on disk
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - job deadline
 * @param {Function} [opts.spawnFn]   - injected subprocess seam (D-11)
 * @returns {Promise<{pages: number, longEdgePts: number|null}>}
 * @throws {Error} 'pdfinfo_no_page_count' if the field is absent
 */
async function pdfInfo(pdfPath, { signal, spawnFn } = {}) {
  // WR-01 — pdfinfo is the FIRST subprocess to touch an untrusted PDF, so it
  // gets the SAME sandbox as the raster child: address-space cap, CPU cap and a
  // captured-output ceiling. (It previously passed none of these, which made
  // the pre-raster bomb gate the least sandboxed call in the pipeline.)
  const out = (
    await spawnCapture('pdfinfo', [pdfPath], {
      signal,
      ulimitKB: CAPS.ULIMIT_V_KB,
      ulimitCpuSec: CAPS.ULIMIT_CPU_SEC,
      wallMs: CAPS.PDFINFO_WALL_MS,
      maxStdoutBytes: CAPS.PDFINFO_MAX_STDOUT_BYTES,
      spawnFn,
    })
  ).toString();

  const m = out.match(PAGES_RE);
  if (!m) throw new Error('pdfinfo_no_page_count');

  // WR-05 — validate the LOWER bound too. assertPageCountWithinCap only checks
  // the ceiling, and pdfinfo reports `Pages: 0` for some damaged/encrypted
  // files. A zero count made `for (p = 1; p <= 0; p++)` skip every iteration, so
  // the job "completed" with an empty pages[] array, empty text and null
  // engine — a 200-equivalent success containing nothing, with no signal to the
  // client that the PDF was unreadable.
  const pages = Number(m[1]);
  if (!Number.isInteger(pages) || pages < 1) {
    const err = new Error('pdf_no_pages');
    err.code = 'pdf_no_pages';
    err.status = 422; // unreadable/damaged document — a client-side condition
    err.actual = pages;
    throw err;
  }

  let longEdgePts = null;
  const s = out.match(PAGE_SIZE_RE);
  if (s) {
    const w = Number(s[1]);
    const h = Number(s[2]);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      longEdgePts = Math.max(w, h);
    }
  }

  return { pages, longEdgePts };
}

/**
 * Back-compat convenience wrapper: just the page count.
 *
 * @param {string} pdfPath
 * @param {object} [opts] - same as pdfInfo
 * @returns {Promise<number>} the page count
 */
async function pdfPageCount(pdfPath, opts) {
  return (await pdfInfo(pdfPath, opts)).pages;
}

/**
 * Pre-raster gate (Pitfall 1 guard #1 / T-03-08): reject a PDF whose page count
 * exceeds MAX_PDF_PAGES BEFORE any rasterization, so a 100-page decompression
 * bomb can never exhaust the budget. Throws a typed error the worker maps to a
 * 413/422 client response.
 *
 * @param {number} n - the page count from pdfPageCount
 * @throws {Error} typed `pdf_too_many_pages` (status 413) when n > cap
 */
function assertPageCountWithinCap(n) {
  if (n > CAPS.MAX_PDF_PAGES) {
    const err = new Error('pdf_too_many_pages');
    err.code = 'pdf_too_many_pages';
    err.status = 413; // Payload Too Large — too many pages for the memory budget
    err.limit = CAPS.MAX_PDF_PAGES;
    err.actual = n;
    throw err;
  }
}

/**
 * Render exactly ONE page of a PDF to a PNG buffer via `pdftoppm`, streamed to
 * stdout (`-singlefile`, output-root OMITTED) so nothing lands in a temp dir and
 * only one page image is ever in memory.
 *
 * Resolution control (CR-06): `-r` and `-scale-to` are MUTUALLY EXCLUSIVE in
 * poppler — `-scale-to` overrides `-r`. So exactly one is passed:
 *   - Page geometry KNOWN (the normal path, from pdfInfo): pass only
 *     `-scale-to computeScaleTo(...)`, i.e. the page's natural size at `dpi`
 *     clamped to `maxDim`. DPI is honoured; maxDim is a true ceiling.
 *   - Page geometry UNKNOWN (pdfinfo omitted the page box): pass only `-r dpi`,
 *     never a bare `-scale-to maxDim` — that would UPSCALE the page rather than
 *     cap it. Here the ceiling falls to the remaining guards, `ulimit -v` and
 *     MAX_RASTER_STDOUT_BYTES, which bound the render by killing/rejecting it.
 * Either way `-r`'s poppler default (a too-low 150 — Pitfall 6) is never used.
 *
 * @param {string} pdfPath - path to the input PDF on disk
 * @param {number} page - 1-based page number to render
 * @param {object} [opts]
 * @param {number} [opts.dpi=CAPS.RASTER_DPI]      - render resolution
 * @param {number} [opts.maxDim=CAPS.RASTER_MAX_DIM]- long-side pixel CEILING
 * @param {number} [opts.longEdgePts]              - page long side in points (pdfInfo)
 * @param {AbortSignal} [opts.signal]              - job deadline
 * @param {Function} [opts.spawnFn]                - injected subprocess seam (D-11)
 * @returns {Promise<Buffer>} the one-page PNG buffer, VALIDATED (CR-06/CR-01)
 * @throws {Error} typed `raster_output_truncated` when poppler exits 0 with a
 *   truncated/degenerate image — recorded by page-pipeline as a per-page error
 *   (INP-06) instead of being routed as if it were a real page.
 */
async function renderPage(pdfPath, page, {
  dpi = CAPS.RASTER_DPI,
  maxDim = CAPS.RASTER_MAX_DIM,
  longEdgePts,
  signal,
  spawnFn,
} = {}) {
  // -f/-l pin the single page; -singlefile with NO output-root streams the one
  // PNG to stdout (03-07 Docker smoke: poppler 22.12.0's pdftoppm does NOT treat
  // a trailing '-' as stdout — it writes a file named '-.png' to cwd, which both
  // breaks the "nothing lands on disk" memory model AND fails outright as the
  // non-writable `node` user in /app. OMITTING the root is the correct, verified
  // stdout path). Order OCR-conventional.
  const scaleTo = computeScaleTo(longEdgePts, dpi, maxDim);
  const resolution = scaleTo == null
    ? ['-r', String(dpi)]
    : ['-scale-to', String(scaleTo)];

  const args = [
    ...resolution,
    '-png',
    '-f', String(page),
    '-l', String(page),
    '-singlefile',
    pdfPath,
  ];

  const png = await spawnCapture('pdftoppm', args, {
    signal,
    ulimitKB: CAPS.ULIMIT_V_KB,        // guard #3: address-space kill
    ulimitCpuSec: CAPS.ULIMIT_CPU_SEC,
    wallMs: CAPS.RASTER_WALL_MS,       // wall-clock backstop
    maxStdoutBytes: CAPS.MAX_RASTER_STDOUT_BYTES, // guard #4: output ceiling
    spawnFn,
  });

  // Exit 0 is NOT proof of a usable page (CR-01) — validate before returning.
  assertRenderedPng(png, page);
  return png;
}

module.exports = {
  pdfInfo,
  pdfPageCount,
  assertPageCountWithinCap,
  renderPage,
  computeScaleTo,
  assertRenderedPng,
  MIN_PNG_BYTES,
};
