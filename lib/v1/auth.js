const { timingSafeEqual } = require('crypto');

const API_TOKEN = process.env.API_TOKEN;

function bearerAuth(req, res, next) {
  if (req.path === '/health') return next();

  const fail = () => res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="ocr-api", error="invalid_token"')
    .json({ error: 'invalid_token', message: 'Missing or invalid bearer token' });

  // WR-01 fix — RFC 6750 §2.1 specifies the scheme is case-insensitive.
  // Previously `startsWith('Bearer ')` rejected `bearer <token>` / `BEARER ...`
  // from curl/n8n with lowercase header forms even when the token was correct.
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return fail();

  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(API_TOKEN);
  if (provided.length !== expected.length) return fail();
  if (!timingSafeEqual(provided, expected)) return fail();

  return next();
}

module.exports = { bearerAuth };
