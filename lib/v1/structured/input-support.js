// D-S9 — which sniffed inputs structured mode accepts, and how.
//
// Phase 4 depends on Phase 2 (single image), independent of Phase 3. So
// structured mode operates on ONE vision-ready image:
//   'direct'    — png/jpeg/webp: the vision LLM consumes the bytes as-is.
//   'normalize' — heic/bmp: a single still that prebuilt libvips cannot decode
//                 raw; run it through the existing Phase-3 single-frame
//                 normalize so a phone photo still works, then send the PNG.
//   null        — pdf and multi-FRAME tiff/gif: multi-page structured extraction
//                 is a future phase; the router rejects these typed (422).
//
// Kept declarative + separately testable so the boundary is explicit, not buried
// in a worker branch.

const STRUCTURED_DIRECT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const STRUCTURED_NORMALIZE_TYPES = new Set(['image/heic', 'image/bmp']);

/**
 * @param {string} sniffedType - magic-byte MIME
 * @returns {'direct'|'normalize'|null}
 */
function structuredImageSupport(sniffedType) {
  if (STRUCTURED_DIRECT_TYPES.has(sniffedType)) return 'direct';
  if (STRUCTURED_NORMALIZE_TYPES.has(sniffedType)) return 'normalize';
  return null;
}

module.exports = { structuredImageSupport, STRUCTURED_DIRECT_TYPES, STRUCTURED_NORMALIZE_TYPES };
