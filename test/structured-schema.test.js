const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAndCompileSchema, formatErrors, MAX_SCHEMA_BYTES, MAX_SCHEMA_DEPTH,
} = require('../lib/v1/structured/schema');

// STR-02 / D-S8 — an untrusted client schema becomes a reusable ajv validator
// or a typed 422. Real ajv, no mocks.

const OK_SCHEMA = {
  type: 'object',
  properties: {
    invoice_no: { type: 'string' },
    total: { type: ['number', 'null'] },
    vendor: { type: ['string', 'null'] },
  },
  required: ['invoice_no'],
  additionalProperties: false,
};

test('parseAndCompileSchema: a valid JSON-string schema compiles and validates', () => {
  const { validate } = parseAndCompileSchema(JSON.stringify(OK_SCHEMA));
  assert.equal(typeof validate, 'function');
  assert.equal(validate({ invoice_no: 'A-1', total: 42, vendor: 'Acme' }), true);
});

test('parseAndCompileSchema: accepts an already-parsed object schema too', () => {
  const { validate } = parseAndCompileSchema(OK_SCHEMA);
  assert.equal(validate({ invoice_no: 'A-1' }), true);
});

test('parseAndCompileSchema: a nullable field accepts null (STR-03 null discipline)', () => {
  const { validate } = parseAndCompileSchema(OK_SCHEMA);
  assert.equal(validate({ invoice_no: 'A-1', total: null, vendor: null }), true, 'null is a valid absent-field value');
});

test('parseAndCompileSchema: missing schema → typed 422 field=schema', () => {
  for (const raw of [undefined, null, '']) {
    assert.throws(() => parseAndCompileSchema(raw), (e) => {
      assert.equal(e.code, 'invalid_parameter');
      assert.equal(e.field, 'schema');
      assert.equal(e.status, 422);
      return true;
    });
  }
});

test('parseAndCompileSchema: malformed JSON → typed 422', () => {
  assert.throws(() => parseAndCompileSchema('{not json'), (e) => e.status === 422 && e.field === 'schema');
});

test('parseAndCompileSchema: a non-object root is rejected (ajv would accept it)', () => {
  // ajv.compile({type:"string"}) succeeds; our guard must not.
  assert.throws(() => parseAndCompileSchema(JSON.stringify({ type: 'string' })), (e) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /object/i);
    return true;
  });
  assert.throws(() => parseAndCompileSchema(JSON.stringify([1, 2, 3])), (e) => e.status === 422);
  assert.throws(() => parseAndCompileSchema(JSON.stringify({ properties: {} })), (e) => e.status === 422, 'no type:object');
});

test('parseAndCompileSchema: an over-size schema string → 422 before parsing', () => {
  const huge = '{"type":"object","x":"' + 'a'.repeat(MAX_SCHEMA_BYTES + 10) + '"}';
  assert.throws(() => parseAndCompileSchema(huge), (e) => e.status === 422 && /bytes/.test(e.message));
});

test('parseAndCompileSchema: an over-deep schema → 422', () => {
  // Build nesting deeper than the cap.
  let node = { type: 'object' };
  const root = node;
  for (let i = 0; i < MAX_SCHEMA_DEPTH + 3; i++) {
    node.properties = { child: { type: 'object' } };
    node = node.properties.child;
  }
  assert.throws(() => parseAndCompileSchema(root), (e) => e.status === 422 && /profundidad|depth/i.test(e.message));
});

test('parseAndCompileSchema: a structurally-invalid JSON Schema → typed 422 (compile throws)', () => {
  // `type` must be a string/array of strings; a number is invalid → ajv throws.
  assert.throws(
    () => parseAndCompileSchema(JSON.stringify({ type: 'object', properties: { a: { type: 5 } } })),
    (e) => e.status === 422 && e.field === 'schema',
  );
});

test('formatErrors: renders instancePath + message, bounded', () => {
  const { validate } = parseAndCompileSchema(OK_SCHEMA);
  validate({ total: 'not-a-number' }); // missing required invoice_no + wrong type
  const rendered = formatErrors(validate.errors);
  assert.match(rendered, /invoice_no|raíz/);
  assert.match(rendered, /total/);
  assert.ok(rendered.split('\n').length <= 20);
});

test('formatErrors: empty/absent errors still yields a usable string', () => {
  assert.equal(typeof formatErrors(null), 'string');
  assert.ok(formatErrors([]).length > 0);
});
