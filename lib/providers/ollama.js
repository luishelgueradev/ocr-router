const axios = require('axios');

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

function toString(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch { return String(x); }
}

async function runOllama(modelTag, base64Image, apiKey, opts /* optional */) {
  const start = Date.now();
  const prompt = opts?.prompt === 'short' ? SHORT_PROMPT : PROMPT;
  const body = {
    model: modelTag,
    stream: false,
    messages: [
      { role: 'user', content: prompt, images: [base64Image] },
    ],
  };
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
        timeout: 1000 * 60 * 5,
      }
    );
    return {
      ok: true,
      timeMs: Date.now() - start,
      text: response.data.message?.content || '',
    };
  } catch (err) {
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
