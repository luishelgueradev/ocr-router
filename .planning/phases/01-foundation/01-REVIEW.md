---
phase: 01-foundation
reviewed: 2026-07-23T20:15:52Z
depth: deep
files_reviewed: 24
files_reviewed_list:
  - server.js
  - lib/logger.js
  - lib/models.js
  - lib/ocr.js
  - lib/providers/ocrspace.js
  - lib/providers/ollama.js
  - lib/v1/auth.js
  - lib/v1/env.js
  - lib/v1/errors.js
  - lib/v1/health.js
  - lib/v1/jobs.js
  - lib/v1/modes.js
  - lib/v1/router.js
  - lib/v1/shutdown.js
  - lib/v1/sniff.js
  - lib/v1/upload.js
  - lib/v1/worker.js
  - public/index.html
  - scripts/verify-redaction.js
  - Dockerfile
  - docker-compose.yml
  - Caddyfile
  - package.json
  - .env.example
findings:
  critical: 0
  high: 2
  medium: 4
  low: 5
  total: 11
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-07-23T20:15:52Z
**Depth:** deep
**Files Reviewed:** 24
**Status:** issues_found

## Summary

Phase 1 is a well-structured port. The three deliberate adaptations were applied cleanly and verified: no `completed` terminal status or `image` multipart field survives anywhere in `lib/` or `server.js` (grep-confirmed); the D-04 page envelope is single-page-correct (`text === pages[0].text` because `join('\n\n')` over one element is a no-op); the D-08 default-engine resolver and zero-engine boot guard are present and deterministic; the deploy stack (Dockerfile/compose/Caddyfile) is coherent with layered TAILSCALE_IP fail-closed defenses. Frontend rendering uses `textContent` everywhere — no XSS. Redaction config and the shutdown finalized-guard race handling are genuinely thoughtful.

No CRITICAL security holes were found. However, two HIGH correctness/availability defects undermine the product's core "never fail to return" value: (1) a forced model whose provider has no configured key is accepted, enqueued, and passed a `null` apiKey instead of being rejected up front — inconsistent with the legacy route's own guard; and (2) the `jobs.create` size guard returns 503 based on total stored jobs (including terminal ones held for the 1-hour TTL), so sustained throughput above `JOB_STORE_MAX`/hour produces spurious "server busy" 503s even when the worker is idle. Remaining findings are error-path robustness, an ignored content-sniff result, and duplication.

## High

### HR-01: Forced model with unconfigured provider is enqueued with a null API key instead of rejected

**File:** `lib/v1/router.js:102` (and `:140-148`)
**Issue:** When a client forces a valid `model` whose provider has no env key (e.g. `model=ollama-qwen3-vl-235b` while only `OCR_SPACE_API_KEY` is set), the route does not reject. `findModel` succeeds, `envKeyFor(model.provider)` returns `null` (line 102), and the job is enqueued and run with `apiKey: null`. `runOllama` then sends `Authorization: Bearer null`, wastes a bounded queue slot behind the single-concurrency worker, and fails with a misleading `auth_failed`. The legacy `/api/ocr` route (server.js:83-89) correctly guards this exact case with a 400 "Falta API key" — the v1 route dropped that check, so the two surfaces are inconsistent and the D-08 fail-closed philosophy is not enforced for forced models.
**Fix:** Guard before enqueue, mirroring the legacy route:
```js
const apiKey = envKeyFor(model.provider);
if (!apiKey) {
  return res.status(422).json({
    error: 'invalid_parameter',
    field: 'model',
    message: `El motor ${model.id} no está configurado (falta su API key). Use GET /v1/models.`,
  });
}
```

### HR-02: `jobs.create` size guard 503s on terminal jobs, capping throughput well below worker capacity

**File:** `lib/v1/jobs.js:19` (guard) with `lib/v1/router.js:117-124` (503 path)
**Issue:** `create()` returns `{ full: true }` when `store.size >= JOB_MAX` (default 500), producing a 503 `server_busy`. But `store` holds every job — `queued`, `processing`, **and terminal `succeeded`/`failed`** — for the full `JOB_TTL_MS` (1 hour). Job records never hold the image buffer (buffers live only in the `limiter.schedule` closure, confirmed router.js:141-147), so the memory justification cited in the comment does not apply to terminal records. The real memory bound is `MAX_QUEUE_DEPTH` (bottleneck), which is enforced separately at router.js:106. Net effect: once 500 mostly-terminal jobs accumulate within an hour, all new submissions get 503 "processing the maximum number of jobs" even though the worker queue is empty — a false availability failure that directly contradicts the core "never fail to return" value. The guard also defeats the LRU's own eviction (which would otherwise drop the oldest, typically-terminal record).
**Fix:** Either let the LRU evict (drop the pre-guard and rely on `max` + TTL), or count only non-terminal jobs against the cap:
```js
function activeCount() {
  let n = 0;
  for (const j of store.values()) if (!j.finalized) n++;
  return n;
}
function create(jobId, meta) {
  if (activeCount() >= JOB_MAX) return { full: true };
  // ...
}
```

## Medium

### MR-01: Deep content-sniff result is computed then discarded; client-declared mimetype is forwarded to the provider

**File:** `lib/v1/router.js:59-65` and `:143`
**Issue:** `sniffImage(req.file.buffer)` is called only for its pass/fail side effect; its return value (the *true* content type) is thrown away. Downstream, `mimeType: req.file.mimetype` (line 143) uses the attacker-controlled multipart `Content-Type`, which `ocrspace.js:13` embeds verbatim into `data:${mimeType};base64,...`. A JPEG uploaded under `Content-Type: image/png` passes the sniff (valid JPEG magic) yet is sent to ocr.space labelled `image/png`. The whole point of the sniff (D-07) is to stop trusting the declared type — but the declared type is exactly what gets used.
**Fix:** Use the sniffed type as the source of truth:
```js
const sniffed = sniffImage(req.file.buffer);
if (sniffed === null) { /* 422 as today */ }
// ...
limiter.schedule(() => runJob(jobId, { model, buffer: req.file.buffer, mimeType: sniffed, ... }));
```

### MR-02: `ocrspace` error path throws when the API returns `ErrorMessage` as a string, masking the real error

**File:** `lib/providers/ocrspace.js:28`
**Issue:** `(data.ErrorMessage || []).join('; ')` assumes `ErrorMessage` is always an array. The OCR.space API returns `ErrorMessage` as a **string** in several failure modes (e.g. invalid API key). When it is a string, `.join` is `undefined` → `TypeError`, which is swallowed by the outer `catch` (line 38) and returned as a generic JS error string. The genuine provider error (which `mapErrorCode` needs to classify `auth_failed`/`quota_exceeded`) is lost.
**Fix:** Normalize to an array first:
```js
const em = data.ErrorMessage;
const raw = (Array.isArray(em) ? em.join('; ') : em) || 'OCR.space falló';
```

### MR-03: Duplicated model/provider-key logic across `server.js` and `router.js`, plus a re-derived `JOB_MAX`

**File:** `server.js:54-62, 123-128, 150-155` and `lib/v1/router.js:13-21, 28-34`
**Issue:** `findModel` and `envKeyFor` are byte-for-byte duplicated in both files. `providerKeyPresent` (server.js) and `envKeyFor`/`resolveDefaultEngine` (router.js) independently encode "which providers have keys" — a third provider would require edits in three places, and they can silently diverge. Worse, `server.js:150-155` **recomputes** `JOB_MAX` by re-reading `JOB_STORE_MAX` with a hardcoded `500` default rather than importing it from `jobs.js`; if the `jobs.js` default ever changes, the startup log will report a value the store does not use.
**Fix:** Extract a shared `lib/v1/engines.js` (or extend `lib/models.js`) exporting `findModel`, `envKeyFor`, `providerKeyPresent`, `resolveDefaultEngine`, and have both files import it. Export `JOB_MAX` from `jobs.js` and import it in `server.js` instead of recomputing.

### MR-04: `/api/ocr` catch block discards the caught error, leaving no diagnostics

**File:** `server.js:96-99`
**Issue:** `catch (e) { logger.error({ msg: 'Error interno en /api/ocr' }); ... }` logs a static string and never references `e`. Any real failure in `runOCR` or validation is completely invisible in logs, making the legacy admin path undebuggable in production. (Pino's redaction already protects sensitive fields, so logging the error is safe.)
**Fix:**
```js
} catch (e) {
  logger.error({ err: e && e.message }, 'Error interno en /api/ocr');
  return res.status(500).json({ ok: false, error: 'Error interno' });
}
```

## Low

### LR-01: `toString` helper duplicated verbatim in both providers

**File:** `lib/providers/ollama.js:18-21` and `lib/providers/ocrspace.js:3-6`
**Issue:** Identical `toString(x)` safe-stringify helper is copy-pasted. Minor drift risk.
**Fix:** Move to a shared `lib/providers/util.js` and import in both.

### LR-02: Graceful shutdown may stall on idle keep-alive sockets until the 38s hard-kill

**File:** `server.js:182` and `:198-200`
**Issue:** `httpServer.close(resolve)` does not close idle keep-alive connections (Caddy holds these), so `httpClosed` can remain pending until the 38s `armHardKillTimer` fires, making "graceful" shutdown routinely wait for the backstop rather than completing promptly.
**Fix:** After initiating close, call `httpServer.closeIdleConnections()` (Node ≥18) so idle sockets drop immediately and only in-flight responses hold the promise open.

### LR-03: `ocrspace` never checks `res.ok`/`res.status`, losing HTTP status for error mapping

**File:** `lib/providers/ocrspace.js:25`
**Issue:** The code goes straight to `res.json()` without inspecting `res.status`. On a 403/5xx that returns HTML (or on any non-JSON body), `res.json()` throws and the real HTTP status never reaches `mapErrorCode` (which keys on `result.status`), degrading error classification to regex-on-message only.
**Fix:** Capture `res.status` and return it on the result object; short-circuit non-OK responses with the status attached.

### LR-04: Compose `${TAILSCALE_IP:?...}` guards only unset/empty, not a mis-set public value

**File:** `docker-compose.yml:50`
**Issue:** The `:?` form fails loud when `TAILSCALE_IP` is unset or empty, but a wrong value (`0.0.0.0`, a public IP, or trailing whitespace) still binds the admin panel where intended-private routing does not hold. This is acknowledged as relying on a manual `ss -tlnp` check, but there is no automated shape validation.
**Fix:** Add a documented startup assertion (or entrypoint check) that `TAILSCALE_IP` matches the `100.x` CGNAT range before publishing the port.

### LR-05: Trailing-slash `/v1/health/` is not exempt from bearer auth

**File:** `lib/v1/auth.js:6`
**Issue:** `req.path === '/health'` is an exact match, so `/v1/health/` (trailing slash) falls through to the auth check and returns 401 instead of the public liveness response. Fails closed (not a security issue) but is an inconsistency a health-probe misconfiguration could trip on.
**Fix:** Normalize: `if (req.path === '/health' || req.path === '/health/') return next();` or compare against a trimmed path.

---

_Reviewed: 2026-07-23T20:15:52Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
