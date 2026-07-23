const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// DEPLOY-05 — boot-time env-var guards.
//
// server.js declares two PLACEHOLDER_* constants that MUST be byte-identical to
// the corresponding lines in .env.example (Pitfall 11 coupling). It then refuses
// to boot if API_TOKEN or TAILSCALE_IP are missing/equal to those placeholders.
//
// Tests:
//   1. Drift guard — parse .env.example for API_TOKEN= and TAILSCALE_IP=, then
//      assert server.js declares each constant with the SAME literal value.
//      Catches future edits that change one side without the other.
//   2. Spawn-based behavioral tests — start `node server.js` with various env
//      combinations and assert it either throws the expected message or boots
//      cleanly. SIGTERM round-trip proves the shutdown plumbing too.

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(REPO_ROOT, 'server.js');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');

// Pick a high randomized port to avoid collisions with a running dev server.
function pickPort() {
  return 39990 + Math.floor(Math.random() * 1000);
}

// Spawn `node server.js` with the provided env vars; collect stdout + stderr;
// return { code, signal, stdout, stderr } after the process exits (or after
// `timeoutMs` if `expectBoot` is true and the server keeps running).
function spawnServer(env, opts = {}) {
  const { expectBoot = false, sendSignal = null, waitForLine = null, timeoutMs = 4000 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      cwd: REPO_ROOT,
      // Wipe inherited env: the user's real .env (and any host vars) must not
      // bleed in and accidentally satisfy a guard the test is meant to trip.
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let booted = false;
    let killTimer = null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (killTimer) clearTimeout(killTimer);
      // Always reap.
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      resolve(result);
    };

    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
      if (waitForLine && !booted && stdout.includes(waitForLine)) {
        booted = true;
        if (sendSignal) {
          // Give the listener a few ms to attach signal handlers after `server ready`.
          setTimeout(() => {
            try { child.kill(sendSignal); } catch (_) { /* ignore */ }
          }, 50);
        } else if (expectBoot) {
          // Caller just wanted to confirm boot; tear down now.
          finish({ code: null, signal: null, stdout, stderr, booted: true });
        }
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });

    child.on('exit', (code, signal) => {
      finish({ code, signal, stdout, stderr, booted });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(err);
    });

    // Watchdog: if nothing happens, kill and resolve so the test fails on the
    // assertion, not on a hang.
    killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Drift guard — placeholder constants byte-coupled to .env.example
// ---------------------------------------------------------------------------

test('DEPLOY-05 drift guard: server.js PLACEHOLDER_API_TOKEN matches .env.example API_TOKEN literally', () => {
  const envSrc = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');

  const envMatch = envSrc.match(/^API_TOKEN=(.+)$/m);
  assert.ok(envMatch, '.env.example must declare API_TOKEN=<placeholder>');
  const envValue = envMatch[1];

  const constMatch = serverSrc.match(/PLACEHOLDER_API_TOKEN\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(constMatch, 'server.js must declare const PLACEHOLDER_API_TOKEN = "..."');
  const constValue = constMatch[1];

  assert.equal(
    constValue,
    envValue,
    `Pitfall 11 drift: PLACEHOLDER_API_TOKEN (${JSON.stringify(constValue)}) must equal .env.example API_TOKEN (${JSON.stringify(envValue)})`
  );
});

test('DEPLOY-05 drift guard: server.js PLACEHOLDER_TAILSCALE_IP matches .env.example TAILSCALE_IP literally', () => {
  const envSrc = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');

  const envMatch = envSrc.match(/^TAILSCALE_IP=(.+)$/m);
  assert.ok(envMatch, '.env.example must declare TAILSCALE_IP=<placeholder>');
  const envValue = envMatch[1];

  const constMatch = serverSrc.match(/PLACEHOLDER_TAILSCALE_IP\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(constMatch, 'server.js must declare const PLACEHOLDER_TAILSCALE_IP = "..."');
  const constValue = constMatch[1];

  assert.equal(
    constValue,
    envValue,
    `Pitfall 11 drift: PLACEHOLDER_TAILSCALE_IP (${JSON.stringify(constValue)}) must equal .env.example TAILSCALE_IP (${JSON.stringify(envValue)})`
  );
});

// ---------------------------------------------------------------------------
// Behavioral guards — spawn server.js with various env and inspect output
// ---------------------------------------------------------------------------

test('DEPLOY-05: server refuses to boot when API_TOKEN equals the placeholder', async () => {
  const PORT = pickPort();
  // NODE_ENV=development bypasses the TAILSCALE_IP guard so we isolate the
  // API_TOKEN check. The API_TOKEN guard fires unconditionally.
  const { code, stdout, stderr } = await spawnServer({
    NODE_ENV: 'development',
    PORT: String(PORT),
    API_TOKEN: 'generate-with-openssl-rand-hex-32',
  }, { timeoutMs: 3000 });

  assert.notEqual(code, 0, `server should exit non-zero when API_TOKEN is the placeholder; got code=${code}`);
  const combined = stdout + stderr;
  assert.match(
    combined,
    /API_TOKEN missing or still set to placeholder/i,
    `expected throw message about API_TOKEN placeholder; got:\n${combined}`
  );
});

test('DEPLOY-05: server refuses to boot when TAILSCALE_IP is empty (non-development NODE_ENV)', async () => {
  const PORT = pickPort();
  const { code, stdout, stderr } = await spawnServer({
    // No NODE_ENV — current server.js fails closed unless NODE_ENV === 'development'.
    PORT: String(PORT),
    API_TOKEN: crypto.randomBytes(32).toString('hex'),
    TAILSCALE_IP: '',
  }, { timeoutMs: 3000 });

  assert.notEqual(code, 0, `server should exit non-zero when TAILSCALE_IP is empty; got code=${code}`);
  const combined = stdout + stderr;
  assert.match(
    combined,
    /TAILSCALE_IP missing or still placeholder/i,
    `expected throw message about TAILSCALE_IP empty/placeholder; got:\n${combined}`
  );
});

test('DEPLOY-05: server refuses to boot when TAILSCALE_IP equals the placeholder (non-development NODE_ENV)', async () => {
  const PORT = pickPort();
  const { code, stdout, stderr } = await spawnServer({
    PORT: String(PORT),
    API_TOKEN: crypto.randomBytes(32).toString('hex'),
    TAILSCALE_IP: '100.x.x.x',
  }, { timeoutMs: 3000 });

  assert.notEqual(code, 0, `server should exit non-zero when TAILSCALE_IP is the placeholder; got code=${code}`);
  const combined = stdout + stderr;
  assert.match(
    combined,
    /TAILSCALE_IP missing or still placeholder/i,
    `expected throw message about TAILSCALE_IP placeholder; got:\n${combined}`
  );
});

test('DEPLOY-05: server boots and shuts down cleanly with real API_TOKEN + NODE_ENV=development', async () => {
  const PORT = pickPort();
  const result = await spawnServer({
    NODE_ENV: 'development',
    PORT: String(PORT),
    API_TOKEN: crypto.randomBytes(32).toString('hex'),
    // TAILSCALE_IP intentionally omitted — NODE_ENV=development bypasses that guard.
    // OCR_SPACE_API_KEY supplied so the D-08 zero-engine boot guard (added in Plan 01-01)
    // is satisfied and the server can reach "server ready" for the SIGTERM round-trip.
    OCR_SPACE_API_KEY: 'test-key-for-boot-guard',
  }, {
    waitForLine: 'server ready',
    sendSignal: 'SIGTERM',
    timeoutMs: 8000,
  });

  assert.ok(result.booted, `server should log "server ready"; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(result.code, 0, `server should exit 0 after SIGTERM; got code=${result.code} signal=${result.signal}`);
  assert.match(
    result.stdout,
    /shutdown_complete/,
    `expected "shutdown_complete" log line; got:\n${result.stdout}`
  );
});
