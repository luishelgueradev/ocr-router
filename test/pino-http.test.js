// OBSV-02: pino-http 11.0.0 logs each request with method, url, status,
// latency_ms, and request_id. Verifies the production pinoHttp configuration
// (mirrored from server.js byte-faithfully):
//   - genReqId reads X-Request-Id and sanitizes it (control chars stripped,
//     capped at 64 chars); uuidv7 fallback otherwise
//   - customLogLevel: 5xx -> error (50), else info (30)
//   - customAttributeKeys: responseTime -> latency_ms
//   - customProps: { request_id: req.id }
//   - autoLogging: { ignore: () => false } -> exactly ONE log line per request
//                                              (the "request received" line
//                                              is suppressed)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('stream');
const net = require('net');
const express = require('express');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { v7: uuidv7 } = require('uuid');

// UUIDv7 pattern (mirrors test/v1-routes.test.js convention)
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Build the pino-http middleware using the SAME configuration block as
// server.js. If server.js drifts from this block (e.g. drops autoLogging or
// renames latency_ms), the assertions below catch it.
function buildHttpLogger(linesArr) {
  const dest = new Writable({
    write(chunk, _, cb) {
      try {
        linesArr.push(JSON.parse(chunk.toString().trim()));
      } catch (_) {
        // ignore non-JSON
      }
      cb();
    },
  });

  const testLogger = pino(
    {
      level: 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest
  );

  // ---- BEGIN production-config mirror (server.js lines 14-35) ----
  return pinoHttp({
    logger: testLogger,
    genReqId(req, res) {
      const incoming = req.headers['x-request-id'];
      if (incoming && typeof incoming === 'string') {
        const sanitized = incoming.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
        if (sanitized.length > 0) return sanitized;
      }
      return uuidv7();
    },
    customLogLevel(req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      return 'info';
    },
    customAttributeKeys: {
      responseTime: 'latency_ms',
    },
    customProps(req, res) {
      return { request_id: req.id };
    },
    autoLogging: { ignore: () => false },
  });
  // ---- END production-config mirror ----
}

// Build a fresh Express app with the production-mirror pinoHttp middleware.
function makeApp(linesArr) {
  const app = express();
  app.use(buildHttpLogger(linesArr));
  app.get('/probe', (req, res) => res.status(200).json({ ok: true }));
  app.get('/empty', (req, res) => res.status(204).end());
  app.get('/boom', (req, res) => res.status(500).json({ error: 'boom' }));
  return app;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

// Wait one tick after the response for pino's async destination to flush.
function flush() {
  return new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// OBSV-02 / one line per request + required fields
// ---------------------------------------------------------------------------

test('OBSV-02: exactly ONE JSON line per request (request-received line suppressed)', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/probe`);
  assert.equal(res.status, 200);
  await flush();

  assert.equal(
    lines.length,
    1,
    `expected exactly 1 log line per HTTP request, got ${lines.length}`
  );
});

test('OBSV-02: log line contains method, url, status, latency_ms, request_id', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  await fetch(`${url}/probe`);
  await flush();

  assert.equal(lines.length, 1);
  const line = lines[0];

  // method + url come from pino-http's req serializer
  assert.equal(line.req.method, 'GET', 'req.method must be GET');
  assert.equal(line.req.url, '/probe', 'req.url must be /probe');

  // status comes from res.statusCode (pino-http default)
  assert.equal(line.res.statusCode, 200, 'res.statusCode must be 200');

  // latency_ms (renamed from responseTime by customAttributeKeys)
  assert.ok('latency_ms' in line, 'log line must contain latency_ms');
  assert.equal(typeof line.latency_ms, 'number', 'latency_ms must be numeric');
  assert.ok(line.latency_ms >= 0, 'latency_ms must be non-negative');

  // request_id from customProps
  assert.ok('request_id' in line, 'log line must contain request_id');
  assert.equal(typeof line.request_id, 'string', 'request_id must be a string');
});

// ---------------------------------------------------------------------------
// OBSV-02 / D-03 + D-04: X-Request-Id honored; uuidv7 fallback
// ---------------------------------------------------------------------------

test('OBSV-02: X-Request-Id header is honored as request_id', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  await fetch(`${url}/probe`, {
    headers: { 'X-Request-Id': 'probe-trace-1' },
  });
  await flush();

  assert.equal(lines.length, 1);
  assert.equal(
    lines[0].request_id,
    'probe-trace-1',
    'incoming X-Request-Id must become request_id'
  );
});

test('OBSV-02: missing X-Request-Id falls back to uuidv7', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  await fetch(`${url}/probe`);
  await flush();

  assert.equal(lines.length, 1);
  assert.match(
    lines[0].request_id,
    UUID_V7_RE,
    `fallback request_id must be UUIDv7, got: ${lines[0].request_id}`
  );
});

// ---------------------------------------------------------------------------
// OBSV-02 / D-05: sanity guard — strip control chars, cap at 64
// ---------------------------------------------------------------------------

test('OBSV-02: X-Request-Id with control chars is sanitized and capped at 64 chars', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  // Wire-level note: undici fetch and node's http client both validate
  // header values client-side, and node's HTTP server parser is strict —
  // RFC-violating control chars (most of \x01..\x1f and \x7f) trip the
  // parser to 400 before pino-http sees the request. The one control char
  // the parser does accept inside a header value is \x09 (HTAB).
  //
  // We use raw TCP so we can transmit a HTAB without the client libraries
  // refusing it. The genReqId guard's regex is `[\x00-\x1f\x7f]` which
  // includes \x09 — so a request carrying "pre<TAB>post..." must come out
  // as "prepost..." in the logged request_id. We pad with 100 'A's to also
  // exercise the slice(0, 64) cap on the same request.
  const u = new URL(url);
  const evilBody = 'pre\x09post' + 'A'.repeat(100); // ~107 chars including TAB
  const rawRequest =
    `GET /probe HTTP/1.1\r\n` +
    `Host: ${u.hostname}:${u.port}\r\n` +
    `X-Request-Id: ${evilBody}\r\n` +
    `Connection: close\r\n` +
    `\r\n`;

  await new Promise((resolve, reject) => {
    let received = '';
    const sock = net.createConnection(Number(u.port), u.hostname, () => {
      sock.write(rawRequest);
    });
    sock.on('data', (chunk) => {
      received += chunk.toString('utf8');
    });
    sock.on('end', () => resolve(received));
    sock.on('close', () => resolve(received));
    sock.on('error', reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      resolve(received);
    });
  });
  // pino writes asynchronously; give it a tick beyond socket close.
  await new Promise((r) => setTimeout(r, 20));
  await flush();

  assert.equal(lines.length, 1, 'expected exactly one log line');
  const reqId = lines[0].request_id;

  // Length must be capped at 64 (D-05 cap)
  assert.ok(
    reqId.length <= 64,
    `request_id length must be <= 64, got ${reqId.length}`
  );
  // The cap-firing input should produce exactly 64 chars (since the
  // post-strip body is ~107 chars).
  assert.equal(
    reqId.length,
    64,
    `request_id should be capped to exactly 64 chars, got ${reqId.length}`
  );
  // Must not contain any control character — \x09 in particular must be
  // stripped by the regex [\x00-\x1f\x7f].
  assert.doesNotMatch(
    reqId,
    /[\x00-\x1f\x7f]/,
    'request_id must not contain control characters'
  );
  // Must contain the surviving body (TAB stripped between 'pre' and 'post')
  assert.ok(
    reqId.startsWith('prepost'),
    `expected sanitized request_id to start with 'prepost' (TAB stripped), got: ${reqId}`
  );
});

// ---------------------------------------------------------------------------
// OBSV-02 / D-11: customLogLevel mapping (5xx -> error, 2xx -> info)
// ---------------------------------------------------------------------------

test('OBSV-02: 5xx response logs at error level (50)', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/boom`);
  assert.equal(res.status, 500);
  await flush();

  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 50, '5xx response must log at level 50 (error)');
  assert.equal(lines[0].res.statusCode, 500);
});

test('OBSV-02: 2xx response logs at info level (30)', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/probe`);
  assert.equal(res.status, 200);
  await flush();

  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 30, '2xx response must log at level 30 (info)');
});

test('OBSV-02: 204 response logs at info level (30)', async (t) => {
  const lines = [];
  const app = makeApp(lines);
  const { server, url } = await listen(app);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/empty`);
  assert.equal(res.status, 204);
  await flush();

  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 30, '2xx response must log at level 30 (info)');
});

// ---------------------------------------------------------------------------
// OBSV-02 / drift guard: assert server.js still contains the production block
// ---------------------------------------------------------------------------

test('OBSV-02: server.js pinoHttp block contains the required option keys', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  // These tokens must all be present in the production config for the
  // assertions above to mirror real behaviour. If anyone drops one of these
  // from server.js, this test catches the drift.
  assert.ok(src.includes('pinoHttp('), 'server.js must invoke pinoHttp(...)');
  assert.ok(src.includes('genReqId'), 'server.js must set genReqId');
  assert.ok(
    src.includes("'x-request-id'") || src.includes('"x-request-id"'),
    'server.js genReqId must read x-request-id header'
  );
  assert.ok(src.includes('customLogLevel'), 'server.js must set customLogLevel');
  assert.ok(
    src.includes("responseTime: 'latency_ms'") ||
      src.includes('responseTime: "latency_ms"'),
    'server.js must rename responseTime to latency_ms'
  );
  assert.ok(
    src.includes('request_id: req.id'),
    'server.js customProps must set request_id: req.id'
  );
  assert.ok(
    src.includes('autoLogging'),
    'server.js must set autoLogging (to suppress request-received line)'
  );
});
