// lib/v1/cascade/heuristic.js
//
// CASC-03 — the pure confidence heuristic. computeConfidence(text,{overlay})
// returns a number in [0,1] deciding "good enough to stop the cascade here".
// PURE: no I/O, no network, no keys, no provider requires — every weight,
// bound, and threshold is sourced from lib/v1/cascade/config.js (env-tunable),
// so calibration never touches this logic (D-01/D-02/CASC-09).
//
// Two hard gates first (empty→0, garbage-ratio>max→0), then a weighted average
// over the PRESENT signals, renormalizing when overlay is absent. The overlay
// signal is a WORD COUNT proxy (overlay.wordCount), NOT a confidence — ocr.space
// emits no confidence at any level (D-03 amended). NEVER sum overlay.Lines[].

const CONFIG = require('./config');

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// A code point is "bad" (decode failure / control noise) when it is:
//   C0 controls 0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F   (allow \t=09 \n=0A \r=0D)
//   DEL 0x7F, C1 controls 0x80–0x9F
//   Latin-1 symbol/punctuation block 0xA0–0xBF EXCEPT ¡ (0xA1) and ¿ (0xBF)
//     — a dense run of these (£¤§©®°µ«»… plus NBSP) is the tell-tale of a
//       UTF-8-decoded-as-Latin-1 mojibake stream; ¡/¿ are kept because they are
//       valid, frequent Spanish punctuation. Accented Spanish letters live in
//       0xC0–0xFF and are intentionally NOT flagged. A lone symbol in real text
//       is diluted well under maxGarbageRatio; only dense runs hard-gate.
//       (Calibration extension beyond RESEARCH §1c to satisfy the mojibake
//        gate — plan Task 3 AC: 'Ã¿Ø£�' must score 0.)
//   U+FFFD replacement char, U+FFFE / U+FFFF non-chars
//   lone surrogates 0xD800–0xDFFF
function isBadCodePoint(cp) {
  if ((cp >= 0x00 && cp <= 0x08) || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f)) return true;
  if (cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;
  // Allow ¡(0xA1) ¿(0xBF) and the common Spanish ordinals ª(0xAA) º(0xBA) ° (0xB0)
  // — legitimate, frequent characters ("1.º", "3.ª", "20°") that must NOT count as
  // garbage (IN-02); the rest of the block still hard-gates mojibake runs.
  if (cp >= 0xa0 && cp <= 0xbf && cp !== 0xa1 && cp !== 0xbf && cp !== 0xaa && cp !== 0xba && cp !== 0xb0) return true;
  if (cp === 0xfffd || cp === 0xfffe || cp === 0xffff) return true;
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  return false;
}

// garbageRatio — bad code points over total code points. Uses [...text] for a
// code-POINT count (Pitfall 4: text.length counts UTF-16 units and skews the
// ratio for emoji/CJK). Deterministic O(n), no regex backtracking (T-02-02).
function garbageRatio(text) {
  const cps = [...(text ?? '')];
  const len = cps.length;
  if (len === 0) return 0;
  let bad = 0;
  for (const ch of cps) {
    if (isBadCodePoint(ch.codePointAt(0))) bad += 1;
  }
  return bad / Math.max(len, 1);
}

// computeConfidence — pure [0,1] score. cfg defaults to the heuristic block in
// config.js; passing an explicit cfg (e.g. in a unit test) overrides it.
function computeConfidence(text, { overlay } = {}, cfg = CONFIG.heuristic) {
  const t = (text ?? '').normalize('NFC').trim();
  const len = [...t].length;

  // Hard gate 1: empty / whitespace-only ⇒ never accept, always fall through.
  if (len < cfg.absMinChars) return 0;

  // Hard gate 2: mojibake / decode failure (too many bad code points).
  const garbage = garbageRatio(t);
  if (garbage > cfg.maxGarbageRatio) return 0;

  // Soft signals -----------------------------------------------------------
  const lengthScore = clamp((len - cfg.absMinChars) / (cfg.goodChars - cfg.absMinChars), 0, 1);
  const printableScore = 1 - garbage;
  // Overlay word-count proxy — present only when ocr.space returned an overlay.
  // Read the scalar overlay.wordCount (D-03 amended); never sum Lines[].
  const wordCount = overlay && overlay.HasOverlay ? overlay.wordCount : null;
  const overlayScore = wordCount == null ? null : clamp(wordCount / cfg.goodWords, 0, 1);

  // Weighted average over PRESENT signals, renormalizing when overlay absent
  // (all LLM tiers). printable + length are always present.
  const parts = [
    [cfg.w.printable, printableScore],
    [cfg.w.length, lengthScore],
    ...(overlayScore == null ? [] : [[cfg.w.overlay, overlayScore]]),
  ];
  const wsum = parts.reduce((s, [w]) => s + w, 0);
  return parts.reduce((s, [w, v]) => s + w * v, 0) / wsum; // ∈ [0,1]
}

// passesThreshold — does this confidence clear the profile's stop threshold?
// Resolves the threshold via an Object.hasOwn ALLOWLIST so a hostile profile
// key ('__proto__', 'constructor', …) never reaches the prototype chain
// (Pitfall 5 / T-02-01). Unknown profile ⇒ false (never accept).
function passesThreshold(conf, profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(CONFIG.profiles, profile)) {
    return false;
  }
  return conf >= CONFIG.profiles[profile].threshold;
}

module.exports = { computeConfidence, passesThreshold, garbageRatio };
