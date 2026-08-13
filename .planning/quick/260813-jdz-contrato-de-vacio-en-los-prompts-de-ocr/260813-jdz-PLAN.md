---
quick_id: 260813-jdz
description: Contrato de vacío en los prompts de OCR (PROMPT y SHORT_PROMPT)
date: 2026-08-13
mode: quick
---

# Quick Task 260813-jdz: contrato de vacío en los prompts de OCR

## El defecto

`PROMPT` y `SHORT_PROMPT` en `lib/providers/ollama.js` dicen qué hacer con el
texto que hay, pero **no dicen qué hacer cuando no hay texto**. El VLM improvisa
y devuelve prosa: *"No hay texto visible en esta imagen. La imagen muestra una
fotografía de una persona…"*. Eso llega al consumidor como `extracted_text`,
indistinguible de una extracción real.

## Evidencia (reportada por el consumidor, 18 filas de producción, 2026-08-13)

| provider | filas | descripciones |
|---|---|---|
| ocrspace | 8 | 0 |
| pdf-native | 1 | 0 |
| ollama | 9 | **8** + 1 extracción real ("GASSER KERRUNK") |

Y la heurística las ordena al revés (WR-01): las 8 descripciones puntúan
confidence **1.0**; la extracción real, **0.975**. Prosa fluida gana; texto corto
y raro pierde. Cualquier clasificador aguas abajo se construiría sobre ese bug.

## La asimetría que hay que codificar

El riesgo del arreglo es sobre-corregir: si el prompt solo dice "sin texto →
vacío", el modelo devuelve vacío ante **texto difícil**, y ahí se pierde el caso
GASSER KERRUNK, que es exactamente el valor del tier de visión. El prompt debe
separar los dos casos de forma explícita:

- **no hay texto** ⇒ cadena vacía
- **hay texto pero cuesta leerlo** ⇒ transcribir lo que se pueda + `[ILEGIBLE]`,
  **nunca** vacío

## Tareas

### T1 — Contrato de vacío en ambos prompts
- **files:** `lib/providers/ollama.js`
- **action:** agregar a `PROMPT` la regla de vacío junto con su contraparte
  anti-sobre-corrección; reescribir `SHORT_PROMPT` con la misma semántica en una
  línea. `DESCRIBE_PROMPT` y el estructurado no se tocan.
- **verify:** `npm test`
- **done:** ambos prompts declaran el contrato en los dos sentidos.

### T2 — Tests del contrato
- **files:** `test/describe-mode.test.js` (o nuevo bloque) / `test/ocr-empty-contract.test.js`
- **action:** fijar que `PROMPT` y `SHORT_PROMPT` contienen la regla de vacío y
  la excepción de texto difícil, y que `DESCRIBE_PROMPT` **no** la contiene
  (describe debe seguir describiendo).
- **verify:** `npm test`
- **done:** suite verde.

### T3 — Verificación en vivo contra las dos clases
- **action:** desplegar y probar contra una imagen sin texto y una con texto
  real; confirmar vacío en la primera y extracción en la segunda.
- **done:** evidencia registrada en el SUMMARY.

## Decisión pendiente (NO se resuelve acá)

Con el contrato aplicado, una imagen sin texto ya no para en el primer VLM
(hoy para porque la prosa puntúa 1.0): recorre la cadena hasta agotarla.
Delta real medido sobre `balanced`: **+1 llamada a Ollama** por imagen sin texto
(1 → 2); en `quality`, +2 (1 → 3). El early-stop de "vacío confiable" cambia
recall por costo y es decisión del dueño del proyecto — se plantea al usuario con
los números, no se implementa por default.

## must_haves
- **truths:** vacío = no hay texto; nunca vacío por texto difícil.
- **artifacts:** `lib/providers/ollama.js`, tests del contrato.
- **key_links:** `lib/v1/cascade/heuristic.js:67` (hard-gate de vacío), `lib/v1/cascade/config.js:41` (perfiles).
