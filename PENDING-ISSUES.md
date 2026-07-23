# PENDING ISSUES

Issues surfaced during the autonomous build that were **deliberately not fixed** in-phase — either out of the phase's scope, higher-risk than the fix budget allowed, or enhancements rather than defects. Each has enough diagnosis to pick up later.

Format: `[PHASE] SEVERITY — title` · status · why deferred · where.

---

## Phase 1 — Foundation

### [P1] LOW — Automated shape validation for `TAILSCALE_IP` (code review LR-04)
- **Status:** deferred (not a defect; hardening).
- **What:** `docker-compose.yml` uses `${TAILSCALE_IP:?…}`, which fails loud only when the var is **unset/empty**. A *mis-set* value (`0.0.0.0`, a public IP, trailing whitespace) still binds the admin/legacy surface where intended-private routing does not hold. Current mitigation is a manual `ss -tlnp` check.
- **Why deferred:** The fix (an entrypoint assertion that `TAILSCALE_IP` matches the `100.x` CGNAT range before publishing the port, plus a test) expands the deploy surface and risks the container-boot path — beyond the low-risk fix budget for this pass. The existing `:?` guard + `server.js` boot guard already cover the common misconfig (unset/placeholder).
- **Where:** `docker-compose.yml` (admin port publish), optionally a new entrypoint script + `test/deploy.test.js` assertion.

### [P1] LOW — No dedicated HTTP integration test for the `503 server_busy` path
- **Status:** deferred (test-coverage gap, not a bug). Noted by the phase verifier.
- **What:** The two `503 server_busy` branches (queue-depth full at `router.js`, and `jobs.create` returning `{full:true}`) have their **inputs** unit-tested but no end-to-end HTTP test that drives a real full queue and asserts `503` + `Retry-After`.
- **Why deferred:** Simulating a genuinely full single-concurrency queue in-process is fiddly (needs a blocked worker + `MAX_QUEUE_DEPTH+1` submissions) and the underlying logic is already unit-covered; adding it is an enhancement, not a failing test. After the HR-02 fix (`activeCount`), the `jobs.create` 503 branch is now near-unreachable under normal operation — the queue-depth branch is the effective backpressure and is the one worth an integration test.
- **Where:** new test in `test/v1-routes.test.js` (mount router, monkey-patch worker to block, flood submissions).

---

## Live-stack smoke checks (human, not automatable here)
Recorded by the Phase 1 verifier as **informational** — require a real VPS/tailnet/providers, so they are not gaps in the automated suite:
- Real ACME/HTTPS issuance + Tailscale admin binding on the VPS.
- Real-provider OCR round-trip (ocr.space / Ollama Cloud) with live keys.
- Container SIGTERM drain timing under Docker `stop_grace_period`.
