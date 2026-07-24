// STR-01/02/03 — the structured extraction runner.
//
// This is the structured twin of cascade/runner.js, but its PASS criterion is
// ajv schema-validation, not the confidence heuristic — so it is a SEPARATE path
// and runCascade is left byte-for-byte unchanged (D-S6). It reuses the provider
// seam (runOCR) and the structured-capable chain (capability.js).
//
// Per engine: constrained-decode → JSON.parse → validate. On failure, exactly
// ONE repair retry feeding the ajv errors back. A second failure falls through
// to the next structured engine. If none validate, a typed
// `structured_extraction_failed` (422). Unvalidated JSON is NEVER returned.

const { runOCR } = require('../../ocr');
const { findModel, envKeyFor } = require('../engines');
const { structuredChain } = require('./capability');
const { formatErrors } = require('./schema');
const { STRUCTURED_PROMPT, repairPrompt } = require('./prompt');
const clock = require('../../clock');
const CONFIG = require('../cascade/config');

/** Typed 422 for "no structured engine produced schema-valid JSON". */
function extractionFailed(detail) {
  const e = new Error('structured_extraction_failed');
  e.code = 'structured_extraction_failed';
  e.status = 422;
  e.detail = detail; // a bounded string, never a buffer/schema
  return e;
}

/**
 * Attempt ONE engine: initial constrained decode + validate, then at most one
 * repair retry. Returns the validated object, or null if the engine could not
 * produce schema-valid JSON within its one retry (→ caller falls through).
 *
 * A provider hard-failure (ok:false) or a JSON.parse failure is treated exactly
 * like a validation failure: it consumes the retry and then falls through. It is
 * never a thrown crash (the worker must keep its typed-outcome guarantee).
 */
async function tryEngine(model, base64, mimeType, apiKey, validate, signal) {
  let prompt = STRUCTURED_PROMPT;

  for (let attempt = 0; attempt < 2; attempt++) { // initial + exactly one repair
    let res;
    try {
      res = await runOCR(model, base64, mimeType, apiKey, {
        signal,
        format: validate.schema, // ajv attaches the source schema to the validator
        structuredPrompt: prompt,
        options: { temperature: 0 },
      });
    } catch {
      res = { ok: false };
    }

    if (res && res.ok && typeof res.text === 'string') {
      let parsed;
      let parseOk = true;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        parseOk = false;
      }

      if (parseOk && validate(parsed)) {
        return parsed; // schema-valid — the only way an object is ever returned
      }

      // Set up the single repair retry with the concrete errors.
      const errs = parseOk ? validate.errors : [{ instancePath: '', message: 'La respuesta no es JSON válido.' }];
      prompt = repairPrompt(formatErrors(errs));
    }
    // On a provider hard-failure the retry still runs once with the same prompt;
    // a second hard-failure ends this engine's turn (loop exits) → fall through.
  }

  return null;
}

/**
 * Run structured extraction over the structured-capable chain (or a single
 * forced engine), returning the first schema-valid result.
 *
 * @param {object} args
 * @param {string} args.base64
 * @param {string} args.mimeType
 * @param {string} args.profile
 * @param {import('ajv').ValidateFunction} args.validate - carries `.schema`
 * @param {AbortSignal} [args.deadlineSignal]
 * @param {object|null} [args.model] - a forced structured-capable model, or null for the chain
 * @param {string|null} [args.apiKey] - forced model's key (chain resolves per engine)
 * @returns {Promise<{ structured: object, engineId: string, provider: string, elapsedMs: number }>}
 * @throws {Error} typed `structured_extraction_failed` (422) when nothing validates
 */
async function runStructured({ base64, mimeType, profile, validate, deadlineSignal, model, apiKey }) {
  const start = clock.monotonicMs();

  // Forced path: exactly the one engine (already capability-checked by the
  // router). Cascade path: the structured-capable chain, cheapest first.
  const engineIds = model ? [model.id] : structuredChain(profile);

  let attempted = 0;
  for (const engineId of engineIds) {
    const m = model && model.id === engineId ? model : findModel(engineId);
    if (!m) continue;
    const key = model ? apiKey : envKeyFor(m.provider);
    if (!key) continue; // missing-key tier is a silent drop, same as the cascade
    attempted += 1;

    const result = await tryEngine(m, base64, mimeType, key, validate, deadlineSignal);
    if (result !== null) {
      return {
        structured: result,
        engineId: m.id,
        provider: m.provider,
        elapsedMs: Math.round(clock.monotonicMs() - start),
      };
    }
  }

  throw extractionFailed(
    attempted === 0
      ? 'no structured-capable engine is configured'
      : 'no structured-capable engine produced schema-valid JSON',
  );
}

module.exports = { runStructured, tryEngine, _extractionFailed: extractionFailed };
