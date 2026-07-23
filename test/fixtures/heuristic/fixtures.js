// test/fixtures/heuristic/fixtures.js
//
// The 10 named calibration fixtures for the pure confidence heuristic
// (research 02-RESEARCH.md §1g). Because computeConfidence is PURE over
// (text, overlay), calibration needs no images, no keys, and no network —
// just plain strings and a scalar mock overlay { HasOverlay, wordCount }.
//
// Each row: { name, text, overlay?, band:[lo,hi], passes:{fast,balanced,quality} }
//   band    — inclusive [lo,hi] the computed confidence must fall within.
//   passes  — expected passesThreshold() result per profile at DEFAULT thresholds
//             (fast 0.50 / balanced 0.60 / quality 0.70).
//
// CALIBRATION NOTE (deviation from research §1g illustrative bands): the plan
// mandates weight RENORMALIZATION when overlay is absent, which gives any
// garbage-free non-empty string a hard floor of 0.625 (printable weight
// 0.5/0.8). Consequently:
//   - clean_receipt (garbage-free, len 35) saturates to 1.0, not 0.75–0.90.
//   - near_empty "OK" (0.65) and single_char "a" (0.625) clear balanced (0.60),
//     not "fast only" — they still fail quality (0.70).
// The hard gates (empty→0, garbage>0.30→0), the clean-doc-scores-high truth,
// and the [0,1] invariant all hold. Threshold NUMBERS remain LOW-confidence
// pending live-key calibration (a deferred ops task, not a code blocker).

// Non-printable / mojibake building blocks kept as escapes for a clean source.
const C0 = '\x00\x01\x02\x03\x04\x05'; // C0 control chars (all "bad")
const REPLACEMENT = '�';           // U+FFFD replacement char (decode failure marker)
const BOXES = '□□';           // □□ — printable geometric shapes (NOT garbage)
const LATIN1 = 'Ã¿Ø£'; // Ã¿Ø£ — printable Latin-1 (NOT garbage)

const fixtures = [
  {
    name: 'clean_paragraph',
    text:
      'El presente documento certifica que la operacion fue realizada de forma ' +
      'satisfactoria conforme a las condiciones pactadas entre las partes. Se deja ' +
      'constancia de la entrega de los materiales solicitados y la correspondiente ' +
      'verificacion de calidad efectuada por el personal tecnico autorizado en la ' +
      'fecha indicada.',
    band: [0.90, 1.0],
    passes: { fast: true, balanced: true, quality: true },
  },
  {
    name: 'clean_receipt',
    text: 'TOTAL: $12.50\nGracias por su compra',
    band: [0.90, 1.0], // saturates (garbage-free, len>=goodChars) — see calibration note
    passes: { fast: true, balanced: true, quality: true },
  },
  {
    name: 'clean_with_overlay',
    text: 'TOTAL: $12.50\nGracias por su compra',
    overlay: { HasOverlay: true, wordCount: 40 }, // scalar word-count proxy (D-03 amended) — NOT a confidence
    band: [0.95, 1.0],
    passes: { fast: true, balanced: true, quality: true },
  },
  {
    name: 'mixed_partial',
    text: 'Factura numero 123 total' + REPLACEMENT.repeat(14), // garbage ~0.37 > 0.30 → hard gate
    band: [0, 0],
    passes: { fast: false, balanced: false, quality: false },
  },
  {
    name: 'mojibake',
    text: LATIN1 + C0 + REPLACEMENT + BOXES, // ~0.54 garbage → hard gate
    band: [0, 0],
    passes: { fast: false, balanced: false, quality: false },
  },
  {
    name: 'control_chars',
    text: 'dato' + '\x01\x02\x03\x04\x05\x06\x07', // >30% C0 controls → hard gate
    band: [0, 0],
    passes: { fast: false, balanced: false, quality: false },
  },
  {
    name: 'near_empty',
    text: 'OK',
    band: [0.63, 0.67], // 0.65 — borderline fixture used for the tunability proof
    passes: { fast: true, balanced: true, quality: false },
  },
  {
    name: 'single_char',
    text: 'a',
    band: [0.615, 0.635], // 0.625 renormalization floor
    passes: { fast: true, balanced: true, quality: false },
  },
  {
    name: 'empty',
    text: '',
    band: [0, 0],
    passes: { fast: false, balanced: false, quality: false },
  },
  {
    name: 'whitespace_only',
    text: '   \n\t ',
    band: [0, 0],
    passes: { fast: false, balanced: false, quality: false },
  },
];

module.exports = { fixtures };
