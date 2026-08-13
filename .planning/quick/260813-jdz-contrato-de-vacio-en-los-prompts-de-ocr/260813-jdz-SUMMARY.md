---
quick_id: 260813-jdz
status: complete
date: 2026-08-13
deployed: true
commits:
  - c5bfb22 fix(ollama): contrato de vacio en los prompts de OCR + normalizacion de vacio efectivo
---

# Quick Task 260813-jdz — contrato de vacío en los prompts de OCR

## Qué se hizo

**`lib/providers/ollama.js`** — dos reglas nuevas en `PROMPT` y su equivalente en
`SHORT_PROMPT`, que van **juntas** a propósito:

1. sin ningún texto ⇒ cadena vacía, sin describir la imagen;
2. con texto difícil ⇒ transcribir lo que se pueda + `[ILEGIBLE]`, **nunca**
   vacío.

La segunda existe porque la primera sola sobre-corrige: el modelo devolvería
vacío ante texto difícil y se perdería el caso que justifica el tier de visión
(leer lo que ocr.space no pudo).

**`normalizeEmptyish()`** — descubierto en la verificación en vivo, no en los
tests. Con el contrato ya aplicado, `gemma4:31b` no devolvía `''` sino `U+200B`:
1 carácter, `lengthScore` 0 pero `printableScore` 1 ⇒ confidence **0.625**,
por encima del umbral de `balanced` (0.60) ⇒ **ganaba la cascada** y el
consumidor recibía un carácter invisible como texto extraído. La función colapsa
a `''` los fences vacíos y los invisibles (ZWSP/ZWNJ/ZWJ/word-joiner/BOM), y
deja **intacto** todo lo demás — de-fencear una extracción real no es su tarea.
El path estructurado no se toca: ya tiene su propio parser
(`structured/extract.js:50`).

**`test/ocr-empty-contract.test.js`** — 7 tests EMPTY-01..05: las dos reglas en
ambos prompts, que `describe` **no** las lleva (describir es su trabajo), que los
5 vacíos efectivos normalizan a `''`, y que `'GASSER KERRUNK'`, un fence con
contenido y `'0'` llegan intactos.

## Verificación en vivo (túnel, `profile=balanced`)

| Entrada | Resultado |
|---|---|
| Imagen con texto | `"FACTURA A 0001-00042\nTotal: $ 15.750,00\nCUIT 30-71234567-9"` — `ocrspace` pasa a confidence 1, ni llega al VLM |
| Imagen sin texto (paisaje 800×600) | `text: ""`, `low_confidence: true`; los 3 motores en `low_confidence 0`. **Reproducible en 2 corridas.** |

`npm test` → **438 tests, 436 pass, 0 fail, 2 skipped**.

## Límite conocido

Un PNG de **1×1 píxel negro** hizo que `minimax-m3` alucinara texto completo
("porque ME PREGUNTE / Y LUCCIO COMO UN CAMPEON…", confidence 1.0). Entrada
degenerada, no representativa — la misma prueba con una imagen sin texto
realista da `''` limpio y reproducible. Se registra porque el contrato de vacío
**no** protege contra alucinación sobre entrada degenerada; para eso haría falta
un guard de tamaño/entropía mínima antes de encolar.

## Decisión pendiente: costo de la cadena completa

Con el contrato aplicado, una imagen sin texto ya no para en el primer VLM (antes
paraba porque la prosa puntuaba 1.0): recorre la cadena hasta agotarla.

| Perfil | Llamadas Ollama antes | Ahora |
|---|---|---|
| `fast` | 1 | 1 (cadena de 2) |
| `balanced` | 1 | **2** |
| `quality` | 1 | **3** |

Medido en vivo, no estimado. El early-stop de "vacío confiable" (parar en el
primer VLM que devuelva `''`) ahorraría esa llamada pero cambia recall por costo:
un modelo más grande a veces lee lo que el chico no pudo, que es exactamente el
valor del tier. Queda planteado al dueño del proyecto, no implementado.
