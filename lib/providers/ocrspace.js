const { toString } = require('./util');

const API_URL = 'https://api.ocr.space/parse/image';

async function runOcrSpace(engine, language, base64Image, mimeType, apiKey) {
  const start = Date.now();
  try {
    const form = new FormData();
    form.append('base64Image', `data:${mimeType};base64,${base64Image}`);
    form.append('language', language);
    form.append('OCREngine', String(engine));
    form.append('isOverlayRequired', 'false');
    form.append('detectOrientation', 'true');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { apikey: apiKey },
      body: form,
      signal: AbortSignal.timeout(2 * 60 * 1000),
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

    const text = (data.ParsedResults || [])
      .map(r => r.ParsedText || '')
      .join('\n')
      .trim();

    return { ok: true, timeMs: Date.now() - start, text };
  } catch (e) {
    const raw = e?.message || e;
    return { ok: false, error: toString(raw) };
  }
}

module.exports = { runOcrSpace };
