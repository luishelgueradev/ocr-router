const API_URL = 'https://api.ocr.space/parse/image';

function toString(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

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

    const data = await res.json();

    if (data.IsErroredOnProcessing) {
      const raw = (data.ErrorMessage || []).join('; ') || 'OCR.space falló';
      return { ok: false, error: toString(raw) };
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
