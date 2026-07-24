const { toString } = require('./util');
const clock = require('../clock');

const API_URL = 'https://api.ocr.space/parse/image';

async function runOcrSpace(engine, language, base64Image, mimeType, apiKey, opts /* optional */) {
  const start = clock.monotonicMs();
  try {
    const form = new FormData();
    form.append('base64Image', `data:${mimeType};base64,${base64Image}`);
    form.append('language', language);
    form.append('OCREngine', String(engine));
    // Overlay ON: the only ocr.space signal the heuristic consumes is a scalar
    // word count (Signal C, CASC-03). ocr.space returns NO confidence at any
    // level (D-03 amended) — we extract word count only, never fabricate one.
    form.append('isOverlayRequired', 'true');
    form.append('detectOrientation', 'true');

    // Single authoritative deadline (JOB-04): compose the caller's job signal
    // (if any) with the 2-min per-engine backstop so a hung socket can be
    // aborted by the job deadline, while the timeout stays as a subordinate cap.
    const backstop = AbortSignal.timeout(2 * 60 * 1000);
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, backstop])
      : backstop;

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { apikey: apiKey },
      body: form,
      signal,
    });

    // Capture the HTTP status so mapErrorCode can classify auth/quota/5xx even when
    // the body is HTML or non-JSON (LR-03). Guard res.json() so a non-JSON error
    // body does not throw an opaque parse error that masks the real status.
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, status: res.status, error: `OCR.space respondió ${res.status} con cuerpo no-JSON` };
    }

    if (!res.ok || data.IsErroredOnProcessing) {
      // OCR.space returns ErrorMessage as a string in some failure modes (e.g. invalid
      // API key) and as an array in others — normalize both so `.join` never throws
      // a TypeError that swallows the real error (MR-02).
      const em = data.ErrorMessage;
      const raw = (Array.isArray(em) ? em.join('; ') : em) || 'OCR.space falló';
      return { ok: false, status: res.status, error: toString(raw) };
    }

    const results = data.ParsedResults || [];
    const text = results
      .map(r => r.ParsedText || '')
      .join('\n')
      .trim();

    // Extract ONLY the scalar overlay word count (Signal C) — never surface raw
    // geometry (Words/Left/Top). Overlay stays internal to the heuristic; the
    // public API exposes no overlay (PROJECT/REQUIREMENTS out-of-scope).
    let wordCount = 0;
    let hasOverlay = false;
    for (const r of results) {
      const overlay = r.TextOverlay;
      if (overlay?.HasOverlay) hasOverlay = true;
      for (const ln of overlay?.Lines || []) wordCount += ln.Words?.length || 0;
    }

    // Return OCRExitCode so the runner can treat "all pages failed" (3) as a
    // hard failure even though ok:true here (D-04 fall-through).
    return {
      ok: true,
      timeMs: Math.round(clock.monotonicMs() - start),
      text,
      overlay: { HasOverlay: hasOverlay, wordCount },
      ocrExitCode: data.OCRExitCode,
    };
  } catch (e) {
    const raw = e?.message || e;
    return { ok: false, error: toString(raw) };
  }
}

module.exports = { runOcrSpace };
