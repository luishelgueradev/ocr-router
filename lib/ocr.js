const { runOllama } = require('./providers/ollama');

async function runOCR(model, base64Image, mimeType, apiKey, opts) {
  if (model.provider === 'ollama') {
    return runOllama(model.modelTag, base64Image, apiKey, opts);
  }
  if (model.provider === 'ocrspace') {
    const { runOcrSpace } = require('./providers/ocrspace');
    return runOcrSpace(model.engine, model.language, base64Image, mimeType, apiKey);
  }
  return { ok: false, error: `Provider desconocido: ${model.provider}` };
}

module.exports = { runOCR };
