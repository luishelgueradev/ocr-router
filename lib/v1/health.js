// Provider hosts for reachability pings — NOT the actual API endpoints (no key sent).
// Overridable via env so the outage path is operable/testable (defaults unchanged).
const OLLAMA_HOST = process.env.OLLAMA_PROBE_URL || 'https://ollama.com';
const OCRSPACE_HOST = process.env.OCRSPACE_PROBE_URL || 'https://api.ocr.space';
const PROBE_TTL_MS = 10000; // refresh cache at most every 10s (API-02)
const PROBE_TIMEOUT_MS = 3000; // cheap reachability ping timeout (T-01-15)
const clock = require('../clock');

// Module-level cache — defaults ok:true so liveness never depends on a live probe (API-01, T-01-16)
const cache = {
  ollama:   { ok: true, ms: null },
  ocrspace: { ok: true, ms: null },
};
let lastProbe = -Infinity; // monotonic ms; -Infinity = never probed (0 is a
                          // VALID monotonic reading right after boot, so it
                          // cannot double as the sentinel)

async function probeHost(url) {
  const start = clock.monotonicMs();
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { ok: true, ms: Math.round(clock.monotonicMs() - start) };
  } catch {
    return { ok: false, ms: Math.round(clock.monotonicMs() - start) };
  }
}

async function runProbe() {
  lastProbe = clock.monotonicMs();
  const [ollamaResult, ocrspaceResult] = await Promise.all([
    probeHost(OLLAMA_HOST),
    probeHost(OCRSPACE_HOST),
  ]);
  cache.ollama   = ollamaResult;
  cache.ocrspace = ocrspaceResult;
}

function refreshIfStale() {
  // Fire-and-forget — caller does NOT await this; request path reads the cache immediately
  if (clock.monotonicMs() - lastProbe >= PROBE_TTL_MS) {
    runProbe().catch(() => {
      // probe errors are non-fatal; keep existing cache values
    });
  }
}

function healthHandler(req, res) {
  // Kick off a background refresh if the cache is stale — do NOT await (T-01-15, API-02)
  refreshIfStale();

  // Always respond 200 — liveness must never fail because a dependency is down (API-01, T-01-16)
  // Body: booleans + latency only — no env value, token, or key ever (T-01-14, Pitfall 7)
  return res.status(200).json({
    status: 'ok',
    dependencies: {
      ollama:    { reachable: cache.ollama.ok,   latency_ms: cache.ollama.ms },
      ocr_space: { reachable: cache.ocrspace.ok, latency_ms: cache.ocrspace.ms },
    },
  });
}

module.exports = { healthHandler };
