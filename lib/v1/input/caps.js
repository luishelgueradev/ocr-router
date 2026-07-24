// INP-07 — Input-pipeline memory & resource caps.
//
// Every downstream input task (PDF native-text short-circuit, poppler
// rasterization, sharp/heic/bmp normalization, the killable subprocess
// sandbox, and the whole-job deadline) reads its ceilings from HERE — one
// boot-validated config surface instead of scattered magic numbers. Each
// value is env-overridable (env var name == the UPPERCASE key) and parsed
// through intFromEnv, so a bad override (`RASTER_DPI=x`, `MAX_PDF_PAGES=-5`)
// fails LOUDLY at boot rather than silently degrading the memory guard.
//
// Defaults are the research-recommended conservative budget for a
// single-concurrency worker (03-RESEARCH §"Open Questions" Q1/Q2) — safe on
// a small VPS out of the box. NOTE: exact per-box tuning (real RAM ceiling)
// is a DEFERRED Docker-smoke item (D-11) — these defaults must stay safe,
// not optimal.
//
// Units are documented per-key below.

const { intFromEnv } = require('../env');

const CAPS = Object.freeze({
  // Max pages we will accept/rasterize from a single PDF. Read via `pdfinfo`
  // before rasterizing; over-cap uploads are rejected (413/422) so a
  // 100-page decompression-bomb PDF cannot exhaust the budget. (pages)
  MAX_PDF_PAGES: intFromEnv('MAX_PDF_PAGES', 50),

  // pdftoppm render resolution. Higher DPI = sharper OCR input but more
  // pixels/memory per page; balanced against MAX_OUTPUT_PIXELS. (dots/inch)
  RASTER_DPI: intFromEnv('RASTER_DPI', 200),

  // Hard ceiling on decoded pixels for any single page image. Passed to
  // sharp `limitInputPixels` (whose own default 268402689 ≈ 16383² is far
  // too permissive for our budget) and bounds the rasterized page. (pixels)
  MAX_OUTPUT_PIXELS: intFromEnv('MAX_OUTPUT_PIXELS', 25_000_000),

  // pdftoppm `-scale-to` long-side ceiling: caps output pixels regardless of
  // a hostile MediaBox, independent of DPI. (pixels, longest edge)
  RASTER_MAX_DIM: intFromEnv('RASTER_MAX_DIM', 5000),

  // `ulimit -v` virtual-memory ceiling for the rasterization child process —
  // kills the child if poppler still over-allocates past the pixel guards.
  // 786432 KB ≈ 768 MB. (kilobytes)
  ULIMIT_V_KB: intFromEnv('ULIMIT_V_KB', 786_432),

  // `ulimit -t` CPU-seconds ceiling for the rasterization child — bounds a
  // CPU-spinning malicious decode independent of the wall-clock deadline.
  // (seconds of CPU time)
  ULIMIT_CPU_SEC: intFromEnv('ULIMIT_CPU_SEC', 20),

  // Wall-clock deadline for a single pdftoppm page render before the child
  // is killed (belt to the AbortController's braces). (milliseconds)
  RASTER_WALL_MS: intFromEnv('RASTER_WALL_MS', 30_000),

  // Wall-clock deadline for the `pdfinfo` page-count probe. (milliseconds)
  PDFINFO_WALL_MS: intFromEnv('PDFINFO_WALL_MS', 10_000),

  // Max bytes buffered from `pdfinfo` stdout. Real pdfinfo output is a few
  // hundred bytes; this is the same captured-output ceiling the raster child
  // gets, so the FIRST subprocess to touch an untrusted PDF is sandboxed too
  // (WR-01). 65536 B = 64 KB. (bytes)
  PDFINFO_MAX_STDOUT_BYTES: intFromEnv('PDFINFO_MAX_STDOUT_BYTES', 65_536),

  // Max bytes we will buffer from a rasterization child's stdout before
  // aborting — stops an oversized page image from blowing the heap.
  // 41943040 B ≈ 40 MB. (bytes)
  MAX_RASTER_STDOUT_BYTES: intFromEnv('MAX_RASTER_STDOUT_BYTES', 41_943_040),

  // Minimum embedded characters a PDF page must yield (via unpdf) to be
  // treated as a native-text page and short-circuit OCR; below this the page
  // is deemed scanned and rasterized. (characters)
  MIN_NATIVE_CHARS: intFromEnv('MIN_NATIVE_CHARS', 16),

  // Whole-job wall-clock ceiling (resolves Open Question Q1: the budget is a
  // single deadline shared across all N pages, not per-page). Bounds
  // rasterization + every cascade call together. (milliseconds)
  MAX_JOB_MS: intFromEnv('MAX_JOB_MS', 180_000),
});

module.exports = { CAPS };
