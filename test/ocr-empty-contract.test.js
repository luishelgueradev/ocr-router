const { test } = require('node:test');
const assert = require('node:assert/strict');

// CONTRATO DE VACÍO en los prompts de OCR.
//
// El defecto que cierran: PROMPT y SHORT_PROMPT decían qué hacer con el texto
// que hay, pero no qué hacer cuando no hay. El VLM improvisaba y devolvía prosa
// ("No hay texto visible. La imagen muestra una fotografía de...") en el mismo
// campo que una extracción real. Medido en producción el 2026-08-13: 8 de 9
// respuestas del tier de visión eran descripciones, y la heurística las puntuaba
// MEJOR que la única extracción real (1.0 vs 0.975) — así que ningún filtro
// aguas abajo podía separarlas.
//
// La asimetría es el punto: vacío = "no hay texto", nunca "no pude leerlo".
// Sin la segunda regla el prompt sobre-corrige y el tier de visión deja de
// aportar lo único que justifica su costo — leer lo que ocr.space no pudo.
//
// Sin red: axios.post monkey-patcheado, mismo patrón que describe-mode.test.js.

const { runOllama } = require('../lib/providers/ollama');

function capturePrompt(t) {
  const axios = require('axios');
  const original = axios.post;
  const seen = {};
  axios.post = async (_url, body) => {
    seen.prompt = body.messages[0].content;
    return { data: { message: { content: '' } } };
  };
  t.after(() => { axios.post = original; });
  return seen;
}

test('EMPTY-01: el prompt completo ordena devolver vacío cuando no hay texto', async (t) => {
  const seen = capturePrompt(t);
  await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'full' });

  assert.match(seen.prompt, /NO CONTIENE NINGÚN texto/);
  assert.match(seen.prompt, /cadena VACÍA/);
  // Y prohíbe explícitamente la salida que motivó todo esto.
  assert.match(seen.prompt, /No describas la imagen/);
});

test('EMPTY-02: el prompt completo prohíbe devolver vacío por texto DIFÍCIL', async (t) => {
  // Sin esta regla el arreglo se come el caso que justifica el tier de visión:
  // texto que ocr.space no pudo leer y el VLM sí (p. ej. "GASSER KERRUNK").
  const seen = capturePrompt(t);
  await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'full' });

  assert.match(seen.prompt, /NUNCA devuelvas vacío por texto difícil/);
  assert.match(seen.prompt, /\[ILEGIBLE\]/);
});

test('EMPTY-03: el prompt corto lleva el MISMO contrato en sus dos sentidos', async (t) => {
  // speed y quality tienen que coincidir en el contrato de datos: si el modo
  // barato describiera imágenes, el consumidor tendría dos semánticas según un
  // parámetro que ni siquiera envía.
  const seen = capturePrompt(t);
  await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'short' });

  assert.match(seen.prompt, /cadena vacía/);
  assert.match(seen.prompt, /no describas la imagen/i);
  assert.match(seen.prompt, /nunca devuelvas vacío por texto difícil/i);
});

test('EMPTY-04: describe NO lleva el contrato de vacío — describir es su trabajo', async (t) => {
  // La contracara: si el contrato se filtrara al prompt de describe, mode=describe
  // devolvería vacío ante una foto sin texto, que es exactamente lo que se le pide
  // describir.
  const seen = capturePrompt(t);
  await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'describe' });

  assert.doesNotMatch(seen.prompt, /cadena vacía/i);
  assert.match(seen.prompt, /Describí qué muestra esta imagen/);
});

test('EMPTY-04b: un vacío "efectivo" se normaliza a cadena vacía exacta', async (t) => {
  // Medido en vivo: con el contrato aplicado, gemma4:31b devolvió U+200B en vez
  // de ''. Un carácter invisible puntúa 0.625 en la heurística, supera el umbral
  // de balanced (0.60) y GANA la cascada — el consumidor recibe un carácter
  // invisible como "texto extraído". Un fence vacío hace lo mismo.
  const axios = require('axios');
  const original = axios.post;
  t.after(() => { axios.post = original; });

  for (const emptyish of ['​', '```\n```', '```text\n​\n```', '   \n  ', '﻿']) {
    axios.post = async () => ({ data: { message: { content: emptyish } } });
    const res = await runOllama('gemma4:31b', 'YmFzZTY0', 'k', { prompt: 'full' });
    assert.equal(res.text, '', `${JSON.stringify(emptyish)} debería normalizar a ''`);
  }
});

test('EMPTY-04c: una extracción real NO se toca, ni siquiera si viene en un fence', async (t) => {
  // La contracara del test anterior: normalizar es sólo para el vacío. Recortar
  // o de-fencear una extracción genuina arriesga justo lo que el tier aporta.
  const axios = require('axios');
  const original = axios.post;
  t.after(() => { axios.post = original; });

  for (const real of ['GASSER KERRUNK', '```\nFACTURA A 0001\n```', '0']) {
    axios.post = async () => ({ data: { message: { content: real } } });
    const res = await runOllama('gemma4:31b', 'YmFzZTY0', 'k', { prompt: 'full' });
    assert.equal(res.text, real, `${JSON.stringify(real)} debe llegar intacto`);
  }
});

test('EMPTY-05: una respuesta vacía del modelo se propaga como cadena vacía, no como fallo', async (t) => {
  // El runner de la cascada trata '' como confianza 0 y sigue escalando; lo que
  // NO debe pasar es que el proveedor lo convierta en ok:false o en null.
  const axios = require('axios');
  const original = axios.post;
  axios.post = async () => ({ data: { message: { content: '' } } });
  t.after(() => { axios.post = original; });

  const res = await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'full' });

  assert.equal(res.ok, true);
  assert.equal(res.text, '');
});
