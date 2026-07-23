const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Deploy artifact validation — static file shape checks for the Dockerfile,
// docker-compose.yml, Caddyfile and .env.example that Plan 01-03 shipped.
// These assertions were rewritten in lockstep with the Alpine→Debian migration
// (D-10): the image is now node:22-bookworm-slim with tini + poppler-utils
// installed via apt-get at /usr/bin/tini, and the compose healthcheck uses a
// Node-native fetch probe (bookworm-slim has no wget/curl — Pitfall 2).
// Behavioral env-guard tests live in test/env-guards.test.js.

const REPO_ROOT = path.resolve(__dirname, '..');
const readFile = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// =========================================================================
// DEPLOY-01: Dockerfile shape (Debian migration — D-10, Pitfall 1)
// =========================================================================

test('DEPLOY-01: Dockerfile first line is BuildKit syntax directive', () => {
  const src = readFile('Dockerfile');
  const firstLine = src.split('\n')[0];
  assert.equal(
    firstLine,
    '# syntax=docker/dockerfile:1.6',
    'first line must be `# syntax=docker/dockerfile:1.6` so BuildKit features are enabled on older docker versions'
  );
});

test('DEPLOY-01: Dockerfile declares two FROM node:22-bookworm-slim stages (deps + runtime)', () => {
  const src = readFile('Dockerfile');
  const stageMatches = src.match(/^FROM node:22-bookworm-slim AS (deps|runtime)$/gm) || [];
  assert.equal(stageMatches.length, 2, `expected exactly 2 multi-stage FROM lines, got ${stageMatches.length}: ${JSON.stringify(stageMatches)}`);
  assert.ok(stageMatches.some((l) => l.endsWith(' AS deps')), 'must have a `deps` stage');
  assert.ok(stageMatches.some((l) => l.endsWith(' AS runtime')), 'must have a `runtime` stage');
});

test('DEPLOY-01: Dockerfile carries NO Alpine base remnants (migration complete)', () => {
  const src = readFile('Dockerfile');
  // Assemble the old Alpine base tag at runtime so this file contains no
  // literal reference to it (keeps the migration grep-clean).
  const oldBase = new RegExp('node:20' + '-alpine');
  assert.doesNotMatch(src, oldBase, 'no Alpine base remnants — the base migrated to node:22-bookworm-slim (D-10)');
});

test('DEPLOY-01: Dockerfile installs tini + poppler-utils via apt-get in the runtime stage (Pitfall 1)', () => {
  const src = readFile('Dockerfile');
  // Debian uses apt-get, not the Alpine package manager. Both packages must be
  // installed with --no-install-recommends, and the apt lists cleaned in-layer.
  assert.match(
    src,
    /apt-get install -y --no-install-recommends tini poppler-utils/,
    'runtime stage must `apt-get install -y --no-install-recommends tini poppler-utils` (Debian package manager — Pitfall 1)'
  );
  assert.match(
    src,
    /rm -rf \/var\/lib\/apt\/lists\/\*/,
    'apt lists must be removed in the same RUN layer so they never ship in the image'
  );
  // Negative: the Alpine package manager must NOT appear anywhere.
  assert.doesNotMatch(src, /\bapk add\b/, 'no `apk add` — the Alpine package manager is absent on bookworm-slim (Pitfall 1)');
});

test('DEPLOY-01: Dockerfile installs poppler-utils (D-10 — Phase 3 PDF path, unused in Phase 1)', () => {
  const src = readFile('Dockerfile');
  assert.match(src, /poppler-utils/, 'poppler-utils must be installed now per D-10 (keeps the base image stable for Phase 3)');
});

test('DEPLOY-01: Dockerfile drops privileges with USER node (D-02)', () => {
  const src = readFile('Dockerfile');
  assert.match(src, /^USER node$/m, 'must contain `USER node` line to drop to uid 1000');
});

test('DEPLOY-01: Dockerfile uses tini as ENTRYPOINT at the Debian path /usr/bin/tini (exec form, D-03)', () => {
  const src = readFile('Dockerfile');
  assert.match(
    src,
    /^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m,
    'ENTRYPOINT must be the exec-form array `["/usr/bin/tini", "--"]` — Debian tini lives under /usr/bin (Alpine /sbin path does not apply)'
  );
  // Negative: the Alpine tini path must NOT appear.
  assert.doesNotMatch(src, /\/sbin\/tini/, 'no /sbin/tini — that is the Alpine path; Debian uses /usr/bin/tini (Pitfall 1)');
});

test('DEPLOY-01: Dockerfile CMD is exec form ["node", "server.js"], not shell form', () => {
  const src = readFile('Dockerfile');
  assert.match(
    src,
    /^CMD \["node", "server\.js"\]$/m,
    'CMD must be exec-form array — shell form swallows SIGTERM (Pitfall 1)'
  );
  // Negative: absolutely no shell-form CMD line
  assert.doesNotMatch(
    src,
    /^CMD node\b/m,
    'shell-form `CMD node ...` is rejected — would break SIGTERM forwarding'
  );
});

test('DEPLOY-01: Dockerfile carries NO HEALTHCHECK instruction (D-04 — lives in compose)', () => {
  const src = readFile('Dockerfile');
  assert.doesNotMatch(
    src,
    /^\s*HEALTHCHECK\b/m,
    'D-04 keeps the healthcheck in docker-compose.yml so the image stays generic'
  );
});

test('DEPLOY-01: Dockerfile uses npm ci --omit=dev (reproducible, no devDeps)', () => {
  const src = readFile('Dockerfile');
  assert.match(
    src,
    /npm ci --omit=dev/,
    'deps stage must use `npm ci --omit=dev` — never `npm install`'
  );
});

// =========================================================================
// DEPLOY-03: docker-compose.yml two-service shape
// =========================================================================

test('DEPLOY-03: docker-compose.yml has NO top-level `version:` field (Pitfall D)', () => {
  const src = readFile('docker-compose.yml');
  assert.doesNotMatch(
    src,
    /^version:/m,
    'compose v2 plugin treats top-level `version:` as deprecated — must not be present'
  );
});

test('DEPLOY-03: docker-compose.yml declares services: with ocr-app + ocr-caddy containers', () => {
  const src = readFile('docker-compose.yml');
  assert.match(src, /^services:/m, 'top-level `services:` key required');
  assert.match(src, /container_name:\s*ocr-app/, 'app service must declare container_name: ocr-app');
  assert.match(src, /container_name:\s*ocr-caddy/, 'caddy service must declare container_name: ocr-caddy');
});

test('DEPLOY-03: app service builds from local Dockerfile, tags ocr-router:latest, binds ${TAILSCALE_IP}:8780:3000', () => {
  const src = readFile('docker-compose.yml');
  assert.match(src, /dockerfile:\s*Dockerfile/, 'app service must reference the Plan 01-03 Dockerfile');
  assert.match(src, /image:\s*ocr-router:latest/, 'app image tag must be ocr-router:latest (renamed from the reference tag)');
  // The bind must be the tailnet-only form — accept either the plain ${TAILSCALE_IP}
  // or the fail-loud ${TAILSCALE_IP:?...} form (CR-02 fix introduced the latter).
  assert.match(
    src,
    /\$\{TAILSCALE_IP[:?][^}]*\}:8780:3000|\$\{TAILSCALE_IP\}:8780:3000/,
    'app ports must bind to ${TAILSCALE_IP}:8780:3000 — never 0.0.0.0 or plain 3000:3000 (D-07)'
  );
});

test('DEPLOY-03: app service declares stop_grace_period: 40s (D-12 — drain budget)', () => {
  const src = readFile('docker-compose.yml');
  assert.match(
    src,
    /stop_grace_period:\s*40s/,
    'stop_grace_period must be 40s so the 35s SIGTERM drain has a 5s buffer before SIGKILL'
  );
});

test('DEPLOY-03: app service has NO depends_on (D-14 — one-directional caddy→app dependency)', () => {
  const src = readFile('docker-compose.yml');
  // Parse the app block (from `app:` line to the next top-level service line)
  const m = src.match(/^\s{2}app:\s*\n([\s\S]*?)(?=^\s{2}\w+:\s*\n|^networks:|^volumes:)/m);
  assert.ok(m, 'could not locate the `app:` service block in compose file');
  const appBlock = m[1];
  assert.doesNotMatch(
    appBlock,
    /^\s+depends_on:/m,
    'app service must have NO `depends_on` — would break D-14 (`docker compose up app` single-service dev workflow)'
  );
});

test('DEPLOY-03: app service has NO public 0.0.0.0 bind or plain 3000:3000 publish', () => {
  const src = readFile('docker-compose.yml');
  assert.doesNotMatch(src, /network_mode:\s*host/, 'network_mode: host would expose admin panel on 0.0.0.0');
  assert.doesNotMatch(src, /"0\.0\.0\.0:/, 'no 0.0.0.0 host bind allowed anywhere');
  assert.doesNotMatch(
    src,
    /^\s+ports:\s*\[\s*"3000:3000"/m,
    'plain 3000:3000 publish is rejected — would expose admin panel publicly'
  );
});

test('DEPLOY-03: caddy service uses caddy:2-alpine, mounts Caddyfile + cert volumes, public 80/443', () => {
  const src = readFile('docker-compose.yml');
  assert.match(src, /image:\s*caddy:2-alpine/, 'caddy image must be pinned to caddy:2-alpine');
  assert.match(src, /\.\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/, 'caddy must mount ./Caddyfile read-only');
  assert.match(src, /caddy_data:\/data/, 'caddy_data volume must be mounted at /data (cert persistence — Pitfall A)');
  assert.match(src, /caddy_config:\/config/, 'caddy_config volume must be mounted at /config');
  assert.match(src, /"80:80"/, 'caddy must publish 80:80');
  assert.match(src, /"443:443"/, 'caddy must publish 443:443');
  assert.match(src, /"443:443\/udp"/, 'caddy must publish 443:443/udp for HTTP/3');
});

test('DEPLOY-03: caddy depends_on.app.condition: service_healthy', () => {
  const src = readFile('docker-compose.yml');
  // Find the caddy block
  const m = src.match(/^\s{2}caddy:\s*\n([\s\S]*?)(?=^networks:|^volumes:|^\s{2}\w+:\s*\n)/m);
  assert.ok(m, 'could not locate the `caddy:` service block');
  const caddyBlock = m[1];
  assert.match(caddyBlock, /depends_on:/, 'caddy must depend_on app');
  assert.match(caddyBlock, /condition:\s*service_healthy/, 'caddy must wait for app health (gate routing on healthcheck)');
});

test('DEPLOY-03: top-level networks declares ocr_net with driver: bridge', () => {
  const src = readFile('docker-compose.yml');
  assert.match(src, /^networks:/m, 'top-level networks: block required');
  assert.match(src, /ocr_net:/, 'ocr_net network must be declared');
  assert.match(src, /driver:\s*bridge/, 'ocr_net driver must be explicit bridge');
});

test('DEPLOY-03: top-level volumes declares caddy_data + caddy_config', () => {
  const src = readFile('docker-compose.yml');
  assert.match(src, /^volumes:/m, 'top-level volumes: block required');
  // The volume names appear both as service-side mounts and as top-level
  // declarations; check the top-level volumes block contains them.
  const volBlock = src.match(/^volumes:\s*\n([\s\S]*)$/m);
  assert.ok(volBlock, 'top-level volumes block must exist');
  assert.match(volBlock[1], /caddy_data:/, 'caddy_data volume must be declared at top level');
  assert.match(volBlock[1], /caddy_config:/, 'caddy_config volume must be declared at top level');
});

// =========================================================================
// DEPLOY-04: Caddyfile default-deny shape
// =========================================================================

test('DEPLOY-04: Caddyfile uses {$DOMAIN} env interpolation (D-13)', () => {
  const src = readFile('Caddyfile');
  assert.match(src, /\{\$DOMAIN\}/, 'site block must reference {$DOMAIN} — env var substituted at startup');
});

test('DEPLOY-04: Caddyfile has explicit handle blocks for /v1/health, /v1/ocr, /v1/jobs/*, /v1/*', () => {
  const src = readFile('Caddyfile');
  assert.match(src, /handle\s+\/v1\/health\s*\{/, 'handle /v1/health { block required');
  assert.match(src, /handle\s+\/v1\/ocr\s*\{/, 'handle /v1/ocr { block required');
  assert.match(src, /handle\s+\/v1\/jobs\/\*\s*\{/, 'handle /v1/jobs/* block required');
  assert.match(src, /handle\s+\/v1\/\*\s*\{/, 'handle /v1/* catch-all required');
});

test('DEPLOY-04: Caddyfile has default-deny terminal handle that errors 404 (D-16)', () => {
  const src = readFile('Caddyfile');
  // The default-deny handle is the only `handle { ... error 404 ... }` block
  // with no path argument.
  assert.match(
    src,
    /handle\s*\{\s*[^}]*error\s+404[^}]*\}/,
    'terminal `handle { error 404 }` required — everything outside /v1/* must 404'
  );
});

test('DEPLOY-04: Caddyfile has exactly 4 reverse_proxy directives (one per allowed handle)', () => {
  const src = readFile('Caddyfile');
  const matches = src.match(/reverse_proxy\s+app:3000/g) || [];
  assert.equal(
    matches.length,
    4,
    `expected exactly 4 reverse_proxy directives, got ${matches.length} — default-deny handle must NOT reverse_proxy`
  );
});

test('DEPLOY-04: Caddyfile per-route timeouts: 3s health, 5s jobs, 10s ocr + catch-all', () => {
  const src = readFile('Caddyfile');
  // All four timeouts must be present at least once.
  assert.match(src, /response_header_timeout\s+3s/, 'health route needs 3s response_header_timeout');
  assert.match(src, /response_header_timeout\s+5s/, 'jobs route needs 5s response_header_timeout');
  // 10s appears in /v1/ocr AND /v1/* catch-all — should be ≥2 occurrences.
  const tenSecond = (src.match(/response_header_timeout\s+10s/g) || []).length;
  assert.ok(tenSecond >= 2, `expected at least 2 occurrences of response_header_timeout 10s (ocr + catch-all), got ${tenSecond}`);
});

test('DEPLOY-04: Caddyfile dial_timeout 2s appears on every reverse_proxy (Pitfall 8)', () => {
  const src = readFile('Caddyfile');
  const dial = (src.match(/dial_timeout\s+2s/g) || []).length;
  assert.ok(dial >= 4, `expected dial_timeout 2s on each of the 4 reverse_proxy blocks, got ${dial}`);
});

test('DEPLOY-04: Caddyfile has no uncommented log_credentials, header_up, or header_down (D-15, Pitfall 9)', () => {
  const src = readFile('Caddyfile');
  // Filter out lines that begin with optional whitespace + `#` (comments).
  const live = src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.doesNotMatch(live, /\blog_credentials\b/, 'no uncommented log_credentials — would defeat Caddy 2.5+ auto-redaction (Pitfall 9)');
  assert.doesNotMatch(live, /\bheader_up\b/, 'no header_up directives — would violate D-15 (X-Request-Id passthrough)');
  assert.doesNotMatch(live, /\bheader_down\b/, 'no header_down directives — would violate D-15');
});

test('DEPLOY-04: Caddyfile does not route / or /api/* publicly (D-08 trust boundary)', () => {
  const src = readFile('Caddyfile');
  // Strip comments first; the doc comments at the top legitimately mention `/api/*`.
  const live = src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.doesNotMatch(live, /handle\s+\/\s*\{/, 'no `handle / {` — admin panel must stay off the public surface');
  assert.doesNotMatch(live, /handle\s+\/api\//, 'no `handle /api/...` — admin API must stay off the public surface');
});

test('DEPLOY-04: Caddyfile contains commented acme_ca staging hint (Pitfall A dev escape hatch)', () => {
  const src = readFile('Caddyfile');
  assert.match(
    src,
    /#\s*acme_ca\s+https:\/\/acme-staging/,
    'commented `# acme_ca https://acme-staging...` line required as dev escape hatch (Pitfall A)'
  );
});

// =========================================================================
// DEPLOY-06: .env.example documents every required env var
// =========================================================================

test('DEPLOY-06: .env.example declares API_TOKEN with the literal server.js-coupled placeholder', () => {
  const src = readFile('.env.example');
  assert.match(
    src,
    /^API_TOKEN=generate-with-openssl-rand-hex-32$/m,
    'API_TOKEN line must be byte-identical to the server.js PLACEHOLDER_API_TOKEN constant'
  );
});

test('DEPLOY-06: .env.example declares TAILSCALE_IP=100.x.x.x (literal placeholder, Pitfall 11)', () => {
  const src = readFile('.env.example');
  assert.match(
    src,
    /^TAILSCALE_IP=100\.x\.x\.x$/m,
    'TAILSCALE_IP line must be byte-identical to the server.js PLACEHOLDER_TAILSCALE_IP constant'
  );
});

test('DEPLOY-06: .env.example declares DOMAIN, PORT, OCR_SPACE_API_KEY, MAX_UPLOAD_BYTES, LOG_LEVEL, MAX_QUEUE_DEPTH, JOB_STORE_MAX', () => {
  const src = readFile('.env.example');
  assert.match(src, /^DOMAIN=/m, 'DOMAIN= line required');
  assert.match(src, /^PORT=3000$/m, 'PORT=3000 line required');
  assert.match(src, /^OCR_SPACE_API_KEY=$/m, 'OCR_SPACE_API_KEY= (empty value) line required');
  assert.match(src, /^MAX_UPLOAD_BYTES=10485760$/m, 'MAX_UPLOAD_BYTES=10485760 required');
  assert.match(src, /^LOG_LEVEL=info$/m, 'LOG_LEVEL=info required');
  assert.match(src, /^MAX_QUEUE_DEPTH=10$/m, 'MAX_QUEUE_DEPTH=10 required');
  assert.match(src, /^JOB_STORE_MAX=500$/m, 'JOB_STORE_MAX=500 required');
});

test('DEPLOY-06: .env.example has OLLAMA_API_KEY with a demonstrably fake placeholder (Pitfall 11)', () => {
  const src = readFile('.env.example');
  assert.match(src, /^OLLAMA_API_KEY=/m, 'OLLAMA_API_KEY= line required');
  // Negative regex: the value must NOT look like a realistic ~20+ char alnum/dash token.
  assert.doesNotMatch(
    src,
    /^OLLAMA_API_KEY=[a-zA-Z0-9-]{20,}$/m,
    'OLLAMA_API_KEY placeholder must be demonstrably fake (use angle brackets or similar) — a 20+ char alnum value would look like a real token'
  );
});

test('DEPLOY-06: .env.example does NOT contain OLLAMA_MODEL (CLI-only var)', () => {
  const src = readFile('.env.example');
  assert.doesNotMatch(
    src,
    /^OLLAMA_MODEL=/m,
    'OLLAMA_MODEL belongs to the CLI batch script, not the web server'
  );
});

// =========================================================================
// DEPLOY-07: Docker healthcheck declared in compose (NOT in Dockerfile),
// Node-native fetch probe (bookworm-slim has no wget/curl — Pitfall 2)
// =========================================================================

test('DEPLOY-07: docker-compose.yml healthcheck uses a Node-native fetch probe on /v1/health (Pitfall 2)', () => {
  const src = readFile('docker-compose.yml');
  // Locate the healthcheck test line specifically (not the surrounding comments).
  const testLine = (src.split('\n').find((l) => /^\s*test:/.test(l))) || '';
  assert.match(
    testLine,
    /node -e/,
    'healthcheck probe must invoke `node -e` — bookworm-slim ships no wget/curl (Pitfall 2)'
  );
  assert.match(
    testLine,
    /fetch\('http:\/\/localhost:3000\/v1\/health'\)/,
    "healthcheck must fetch('http://localhost:3000/v1/health')"
  );
  assert.match(
    testLine,
    /process\.exit\(r\.ok\?0:1\)/,
    'healthcheck must exit 0 when the response is ok, 1 otherwise'
  );
  assert.match(
    testLine,
    /catch\(\(\)=>process\.exit\(1\)\)/,
    'healthcheck must exit 1 on network/parse errors (fetch rejection)'
  );
  // Negative: the Alpine busybox wget probe (and curl) must be gone from the probe line.
  assert.doesNotMatch(testLine, /wget/, 'no wget in the healthcheck probe — bookworm-slim has no busybox wget (Pitfall 2)');
  assert.doesNotMatch(testLine, /curl/, 'no curl in the healthcheck probe — bookworm-slim has no curl (Pitfall 2)');
});

test('DEPLOY-07: docker-compose.yml healthcheck declares interval/timeout/retries/start_period', () => {
  const src = readFile('docker-compose.yml');
  assert.match(src, /interval:\s*30s/, 'healthcheck interval must be 30s');
  assert.match(src, /timeout:\s*5s/, 'healthcheck timeout must be 5s');
  assert.match(src, /retries:\s*3/, 'healthcheck retries must be 3');
  assert.match(src, /start_period:\s*10s/, 'healthcheck start_period must be 10s');
});

test('DEPLOY-07: Dockerfile contains NO HEALTHCHECK instruction (healthcheck lives in compose, D-04)', () => {
  const src = readFile('Dockerfile');
  assert.doesNotMatch(
    src,
    /^\s*HEALTHCHECK\b/m,
    'D-04 requires the healthcheck to be declared in docker-compose.yml only — never in the Dockerfile'
  );
});
