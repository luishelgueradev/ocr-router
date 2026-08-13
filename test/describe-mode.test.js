const { test } = require('node:test');
const assert = require('node:assert/strict');

// mode=describe — la tarea INVERSA a la de este servicio: interpretar qué
// muestra la imagen en vez de extraer el texto que contiene.
//
// POR QUÉ EXISTE ESTE MODO: antes, cuando el motor OCR clásico no encontraba
// texto, la cascada escalaba a un VLM con el prompt de OCR ("extrae todo el
// texto visible... no resumas, no inventes") y el modelo respondía "No hay
// texto visible. La imagen muestra..." — desobedeciendo el prompt. Esa
// descripción no era una feature: era output no conforme, guardado en el mismo
// campo que una extracción real e indistinguible de ella para el consumidor.
// Si se quieren descripciones, hay que pedirlas explícitamente.
//
// Sin red: axios.post monkey-patcheado vía require.cache, mismo patrón que
// test/structured-provider.test.js y test/provider-signal.test.js.

const { runOllama } = require('../lib/providers/ollama');
const models = require('../lib/models');
const { resolveMode } = require('../lib/v1/modes');

function patchAxios(t, handler) {
  const axiosPath = require.resolve('axios');
  const axios = require(axiosPath);
  const original = axios.post;
  axios.post = handler;
  t.after(() => { axios.post = original; });
}

test('DESCRIBE-01: el prompt pide interpretar la imagen, no extraer su texto', async (t) => {
  let sent;
  patchAxios(t, async (_url, body) => {
    sent = body;
    return { data: { message: { content: 'Una persona con un gato.' } } };
  });

  await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'describe' });

  const prompt = sent.messages[0].content;
  assert.match(prompt, /Describí qué muestra esta imagen/);
  // Y NO es el prompt de OCR: pedir ambas cosas a la vez es lo que producía
  // el output ambiguo que este modo viene a eliminar.
  assert.doesNotMatch(prompt, /Extrae TODO el texto visible/);
});

test('DESCRIBE-02: la imagen viaja por el canal de imagen, nunca interpolada en el prompt', async (t) => {
  let sent;
  patchAxios(t, async (_url, body) => {
    sent = body;
    return { data: { message: { content: 'x' } } };
  });

  await runOllama('minimax-m3', 'BASE64PAYLOAD', 'k', { prompt: 'describe' });

  assert.deepEqual(sent.messages[0].images, ['BASE64PAYLOAD']);
  assert.doesNotMatch(sent.messages[0].content, /BASE64PAYLOAD/);
});

test('DESCRIBE-03: el prompt blinda contra inyección desde la imagen', async (t) => {
  let sent;
  patchAxios(t, async (_url, body) => {
    sent = body;
    return { data: { message: { content: 'x' } } };
  });

  await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'describe' });

  // Mismo blindaje que STRUCTURED_PROMPT: la imagen es dato, no instrucciones.
  assert.match(sent.messages[0].content, /CONTENIDO NO CONFIABLE/);
});

test('DESCRIBE-04: la respuesta lleva el modelo en el encabezado', async (t) => {
  patchAxios(t, async () => ({ data: { message: { content: 'Una persona con un gato.' } } }));

  const res = await runOllama('gemma4:31b', 'YmFzZTY0', 'k', { prompt: 'describe' });

  // La descripción es un JUICIO del modelo, no un hecho de la imagen: quien la
  // lea tiene que saber quién la emitió sin ir a buscar el trace.
  assert.equal(res.text, '[modelo: gemma4:31b]\nUna persona con un gato.');
});

test('DESCRIBE-05: los modos de OCR NUNCA llevan encabezado -- ahí el texto sí es un hecho de la imagen', async (t) => {
  patchAxios(t, async () => ({ data: { message: { content: 'FACTURA A 0001' } } }));

  const full = await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'full' });
  const short = await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'short' });

  assert.equal(full.text, 'FACTURA A 0001');
  assert.equal(short.text, 'FACTURA A 0001');
  assert.doesNotMatch(full.text, /\[modelo:/);
  assert.doesNotMatch(short.text, /\[modelo:/);
});

test('DESCRIBE-06: una respuesta vacía no produce un encabezado huérfano', async (t) => {
  patchAxios(t, async () => ({ data: { message: { content: '' } } }));

  const res = await runOllama('minimax-m3', 'YmFzZTY0', 'k', { prompt: 'describe' });

  assert.equal(res.text, '');
});

test('DESCRIBE-07: solo los modelos de visión declaran el modo; el OCR clásico no', () => {
  const vision = models.filter(m => m.provider === 'ollama');
  const classic = models.filter(m => m.provider !== 'ollama');

  assert.ok(vision.length > 0, 'se esperaba al menos un modelo de visión');
  for (const m of vision) {
    assert.ok(m.modes_supported.includes('describe'), `${m.id} debería admitir describe`);
    assert.equal(m.modes.describe.prompt, 'describe', `${m.id} debe usar el selector de prompt describe`);
  }

  assert.ok(classic.length > 0, 'se esperaba al menos un motor OCR clásico');
  for (const m of classic) {
    assert.ok(!m.modes_supported.includes('describe'), `${m.id} NO puede describir imágenes`);
  }
});

test('DESCRIBE-08: resolveMode acepta describe en visión y lo rechaza en el OCR clásico', () => {
  const vision = models.find(m => m.provider === 'ollama');
  const classic = models.find(m => m.provider !== 'ollama');

  const ok = resolveMode(vision, 'describe');
  assert.equal(ok.mode, 'describe');
  assert.equal(ok.preset.prompt, 'describe');

  // Esto es lo que hace que pedir describe sobre el motor clásico devuelva un
  // 422 tipado sin necesidad de un gate nuevo en el router.
  const rejected = resolveMode(classic, 'describe');
  assert.equal(rejected.error, 'mode');
});

test('DESCRIBE-09: describe usa temperature 0 -- una descripción reproducible vale más que una florida', () => {
  for (const m of models.filter(m => m.provider === 'ollama')) {
    assert.equal(m.modes.describe.options.temperature, 0, `${m.id} describe debe ser determinístico`);
    assert.ok(m.modes.describe.options.num_predict > 0, `${m.id} describe necesita un techo de tokens`);
  }
});
