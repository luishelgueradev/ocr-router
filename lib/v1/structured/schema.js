// STR-02 / D-S8 — turn an UNTRUSTED client JSON Schema into a reusable ajv
// validator, or a typed 422 rejection. Every guard here runs BEFORE ajv.compile,
// because ajv does not enforce the properties this service needs (a non-object
// root compiles fine) and because a pathological schema must never reach the
// single-concurrency worker's compile step.

const Ajv = require('ajv');

// Bounds on the client schema (D-S8). Env-overridable so an operator can tune
// them, but with safe defaults that comfortably fit any realistic extraction
// schema while refusing a schema built to exhaust the worker.
const { intFromEnv } = require('../env');
const MAX_SCHEMA_BYTES = intFromEnv('STRUCTURED_MAX_SCHEMA_BYTES', 64 * 1024); // 64 KiB
const MAX_SCHEMA_DEPTH = intFromEnv('STRUCTURED_MAX_SCHEMA_DEPTH', 12);

/** Build a typed invalid_parameter(schema) error (422). */
function schemaError(message) {
  const e = new Error(message);
  e.code = 'invalid_parameter';
  e.field = 'schema';
  e.status = 422;
  e.message = message;
  return e;
}

/**
 * Deepest nesting level of a parsed JSON value. Cheap, iterative-safe for the
 * bounded sizes we accept (the byte cap runs first), and it is the guard that
 * stops a deeply-nested schema from blowing the stack in ajv.compile.
 */
function maxDepth(value, depth = 1) {
  if (value === null || typeof value !== 'object') return depth;
  let deepest = depth;
  for (const v of Object.values(value)) {
    const d = maxDepth(v, depth + 1);
    if (d > deepest) deepest = d;
  }
  return deepest;
}

/**
 * Parse, bound, and compile a client-supplied JSON Schema.
 *
 * @param {string|object} raw - the `schema` form field (a JSON string, or an
 *   already-parsed object)
 * @returns {{ validate: import('ajv').ValidateFunction, schema: object }}
 * @throws {Error} typed `invalid_parameter` field=`schema` (422) on any rejection
 */
function parseAndCompileSchema(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw schemaError('mode=structured requires a `schema` field (a JSON Schema object).');
  }

  // Size cap on the RAW string before parsing — a multi-MB schema string must
  // not even be JSON.parsed.
  let schema;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_SCHEMA_BYTES) {
      throw schemaError(`El esquema excede el máximo de ${MAX_SCHEMA_BYTES} bytes.`);
    }
    try {
      schema = JSON.parse(raw);
    } catch {
      throw schemaError('El campo `schema` no es JSON válido.');
    }
  } else if (typeof raw === 'object') {
    schema = raw;
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_BYTES) {
      throw schemaError(`El esquema excede el máximo de ${MAX_SCHEMA_BYTES} bytes.`);
    }
  } else {
    throw schemaError('El campo `schema` debe ser un objeto JSON Schema.');
  }

  // Root MUST be an object schema — ajv would happily compile `{type:"string"}`,
  // but a structured extraction must return a JSON OBJECT the client can key
  // into (and Ollama's `format` expects an object schema).
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw schemaError('El esquema debe ser un objeto JSON Schema.');
  }
  if (schema.type !== 'object') {
    throw schemaError('El esquema raíz debe declarar `"type": "object"`.');
  }

  if (maxDepth(schema) > MAX_SCHEMA_DEPTH) {
    throw schemaError(`El esquema supera la profundidad máxima de anidamiento (${MAX_SCHEMA_DEPTH}).`);
  }

  // Safe ajv construction: allErrors for a complete repair prompt; strict:false
  // to tolerate the loose schemas real clients write; NO $data references and NO
  // remote $ref loader registered, so a client schema cannot pull a remote
  // document or use $data. ajv.compile THROWS on a malformed schema — type it.
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (e) {
    throw schemaError(`Esquema JSON Schema inválido: ${e && e.message ? e.message : 'no compilable'}.`);
  }

  return { validate, schema };
}

/**
 * Render ajv errors as a compact, model-readable correction list for the ONE
 * repair retry (STR-02). Server-produced text only — no client string is echoed
 * verbatim beyond the schema paths ajv itself reports.
 *
 * @param {Array<object>|null|undefined} errors - validate.errors
 * @returns {string}
 */
function formatErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return 'El JSON no cumple el esquema.';
  return errors
    .slice(0, 20) // bound the correction list
    .map((e) => {
      const where = e.instancePath && e.instancePath.length ? e.instancePath : '(raíz)';
      return `- ${where}: ${e.message}`;
    })
    .join('\n');
}

module.exports = { parseAndCompileSchema, formatErrors, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH };
