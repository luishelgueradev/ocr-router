const axios = require('axios');
const { toString } = require('./util');
const clock = require('../clock');

const API_URL = 'https://ollama.com/api/chat';
const PROMPT = `
Extrae TODO el texto visible de esta imagen.

REGLAS:
- No resumas
- No inventes
- Respeta los saltos de línea
- Si hay tablas, usa markdown
- Si algo no se entiende, escribe [ILEGIBLE]
- Devuelve SOLO el OCR
`.trim();

const SHORT_PROMPT = 'Extrae todo el texto visible de esta imagen. Devuelve solo el texto, sin explicaciones.';

async function runOllama(modelTag, base64Image, apiKey, opts /* optional */) {
  const start = clock.monotonicMs();
  // STR-01/02/03 — structured mode: the caller supplies a JSON Schema in
  // `opts.format` (Ollama constrained decoding) and the injection-safe prompt in
  // `opts.structuredPrompt`. The document still rides the IMAGE channel, never
  // the prompt. When `opts.format` is absent this is byte-for-byte the original
  // free-text OCR call.
  const structured = opts?.format != null;
  const prompt = structured
    ? opts.structuredPrompt
    : (opts?.prompt === 'short' ? SHORT_PROMPT : PROMPT);
  const body = {
    model: modelTag,
    stream: false,
    messages: [
      { role: 'user', content: prompt, images: [base64Image] },
    ],
  };
  if (structured) body.format = opts.format;
  if (opts?.options) body.options = opts.options;
  try {
    const response = await axios.post(
      API_URL,
      body,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        // Job-level deadline (JOB-04): axios aborts the in-flight call when the
        // caller's signal fires; the 5-min timeout stays only as a backstop.
        signal: opts?.signal,
        timeout: 1000 * 60 * 5,
      }
    );
    return {
      ok: true,
      timeMs: Math.round(clock.monotonicMs() - start),
      text: response.data.message?.content || '',
    };
  } catch (err) {
    // Aborted by the job deadline (JOB-04): axios throws ERR_CANCELED /
    // CanceledError. Surface as a clean ok:false the runner falls through on —
    // never a thrown crash that wedges the worker.
    if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') {
      return { ok: false, error: 'Cancelado por deadline del job', status: err.response?.status };
    }
    if (err.code === 'ECONNABORTED') {
      return { ok: false, error: 'Tiempo de espera agotado' };
    }
    const raw =
      err.response?.data ??
      err.response?.statusText ??
      err.message;
    return { ok: false, error: toString(raw), status: err.response?.status };
  }
}

module.exports = { runOllama };
