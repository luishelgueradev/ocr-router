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
//   2. `-scale-to <RASTER_MAX_DIM>` long-side pixel ceiling (independent of DPI)
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

/**
 * Read a PDF's page count via `pdfinfo` (through the sandbox seam). Cheap and
 * robust for linearized/encrypted/broken PDFs — one clean integer we gate on
 * before rasterizing anything.
 *
 * @param {string} pdfPath - path to the input PDF on disk
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - job deadline
 * @param {Function} [opts.spawnFn]   - injected subprocess seam (D-11)
 * @returns {Promise<number>} the page count
 * @throws {Error} 'pdfinfo_no_page_count' if the field is absent
 */
async function pdfPageCount(pdfPath, { signal, spawnFn } = {}) {
  const out = (
    await spawnCapture('pdfinfo', [pdfPath], {
      signal,
      wallMs: CAPS.PDFINFO_WALL_MS,
      spawnFn,
    })
  ).toString();

  const m = out.match(PAGES_RE);
  if (!m) throw new Error('pdfinfo_no_page_count');
  return Number(m[1]);
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
 * stdout (`-singlefile … -`) so nothing lands in a temp dir and only one page
 * image is ever in memory. `-r` is ALWAYS set explicitly (poppler defaults to a
 * too-low 150 — Pitfall 6) and `-scale-to` always caps the long side as the
 * second pixel guard, independent of a hostile MediaBox.
 *
 * @param {string} pdfPath - path to the input PDF on disk
 * @param {number} page - 1-based page number to render
 * @param {object} [opts]
 * @param {number} [opts.dpi=CAPS.RASTER_DPI]      - render resolution
 * @param {number} [opts.maxDim=CAPS.RASTER_MAX_DIM]- `-scale-to` long-side ceiling
 * @param {AbortSignal} [opts.signal]              - job deadline
 * @param {Function} [opts.spawnFn]                - injected subprocess seam (D-11)
 * @returns {Promise<Buffer>} the one-page PNG buffer
 */
function renderPage(pdfPath, page, {
  dpi = CAPS.RASTER_DPI,
  maxDim = CAPS.RASTER_MAX_DIM,
  signal,
  spawnFn,
} = {}) {
  // -f/-l pin the single page; -singlefile with NO output-root streams the one
  // PNG to stdout (03-07 Docker smoke: poppler 22.12.0's pdftoppm does NOT treat
  // a trailing '-' as stdout — it writes a file named '-.png' to cwd, which both
  // breaks the "nothing lands on disk" memory model AND fails outright as the
  // non-writable `node` user in /app. OMITTING the root is the correct, verified
  // stdout path). -scale-to caps the long side (guard #2). Order OCR-conventional.
  const args = [
    '-r', String(dpi),
    '-png',
    '-f', String(page),
    '-l', String(page),
    '-singlefile',
    '-scale-to', String(maxDim),
    pdfPath,
  ];

  return spawnCapture('pdftoppm', args, {
    signal,
    ulimitKB: CAPS.ULIMIT_V_KB,        // guard #3: address-space kill
    ulimitCpuSec: CAPS.ULIMIT_CPU_SEC,
    wallMs: CAPS.RASTER_WALL_MS,       // wall-clock backstop
    maxStdoutBytes: CAPS.MAX_RASTER_STDOUT_BYTES, // guard #4: output ceiling
    spawnFn,
  });
}

module.exports = { pdfPageCount, assertPageCountWithinCap, renderPage };
