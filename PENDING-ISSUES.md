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

## Phase 2 — Cascade Router

### [P2] MEDIUM — Heuristic renormalization floor (0.625) limits fall-through; needs live-key calibration (code review WR-01)
- **Status:** deferred to the live-key calibration spike (below). NOT fixed in-phase.
- **What:** When overlay is absent (every LLM tier), `computeConfidence` renormalizes over `{printable:0.5, length:0.3}` (wsum 0.8), so any garbage-free string floors at **0.625** — above both `fast` (0.50) and `balanced` (0.60). Consequence: the cascade will not escalate past an LLM tier that emits *any* non-garbage text, including the prompt-instructed `[ILEGIBLE]` sentinel (a 10-char "I can't read this" scores ~0.85 and passes even `quality`).
- **Why deferred:** The fix is a **formula/threshold recalibration**, not a one-line change. Any reweighting (reviewer's option a) or short-text penalty (option b) rewrites the 34 calibrated heuristic fixtures, and choosing the right shape is exactly what the live-key spike exists to decide against real OCR outputs — guessing weights without ground-truth OCR data is as arbitrary as the current values. Note: a text-only heuristic fundamentally cannot distinguish "clean but wrong" from "clean and right"; the meaningful escalation trigger is garbage/emptiness, which IS handled. The `[ILEGIBLE]`-sentinel case (option c) is the concrete pathology to resolve.
- **Recommendation for the spike:** decide (1) whether an `[ILEGIBLE]`-dominant result should force escalation (a sentinel/low-content gate above `absMinChars`), and (2) the printable-vs-length weighting, then move ONLY the thresholds in config once the fall-through envelope is fixed. Document the chosen shape.
- **Where:** `lib/v1/cascade/heuristic.js` (weights/renorm), `lib/v1/cascade/config.js` (thresholds/weights), `test/fixtures/heuristic/fixtures.js`.

### [P2] LOW — `maxAttempts` bound is vacuous (code review IN-03)
- **Status:** deferred (dead config, not a bug).
- **What:** Every profile sets `maxAttempts == chain.length` (fast 2/2, balanced 3/3, quality 4/4), so the `attempts >= maxAttempts` check can never fire before the `for` loop exhausts the chain; `stopped_reason:'max_attempts'` is unreachable.
- **Why deferred:** Harmless (chain length already bounds attempts). Tightening it (e.g. balanced `maxAttempts:2` to stop before the most expensive tier) is a cost-tuning decision best made alongside the WR-01 live calibration.
- **Where:** `lib/v1/cascade/config.js` (per-profile `maxAttempts`).

### [P2] deferred ops checkpoints (from planning) — live-key calibration spike
- **Live-key heuristic-threshold calibration:** confirm the provisional thresholds (`fast 0.50 / balanced 0.60 / quality 0.70`) and the WR-01 formula shape against real ocr.space + Ollama outputs on a small labeled clean/garbage/hard sample. All thresholds are env-overridable (`PROFILE_*_THRESHOLD`) so this needs no code change once the shape is fixed.
- **Ollama Cloud quota-headroom:** confirm the real 5h / 7-day window numbers and that the `budgetMs` / chain defaults fit within them (235B burns fastest). The code already reacts to a live 429 (quota short-circuit, CR-01-fixed) rather than to fixed numbers, so this is verification, not a code blocker.

## Phase 3 — Input Pipeline

### [P3] MEDIUM — An upload declared `application/octet-stream` is rejected before it is ever sniffed
- **Status:** deferred (product decision, not a defect). Surfaced 2026-07-24 while writing the E2E HTTP test (quick task 260724-64d).
- **What:** `lib/v1/upload.js`'s multer `fileFilter` is an allowlist on the **client-declared** mimetype and runs BEFORE `sniffImage`. A client that uploads a genuinely valid HEIC/TIFF/PDF but labels it `application/octet-stream` — the default for many HTTP clients and a common n8n binary-payload shape — gets `422 invalid_parameter` with a message listing the very format it just sent. The magic-byte sniff, which would have routed it correctly, never runs.
- **Why it matters:** The target consumers are automation pipelines, which are exactly the clients most likely to omit a precise content type. It sits against the project's core value ("never fail to return the best available text/data"), because the bytes were fine.
- **Why deferred:** The two-gate design is deliberate and documented in `upload.js`; admitting `application/octet-stream` widens the accepted surface at the door, so the trade-off (accept-and-sniff vs reject-early) is a product call, not a bug fix. The authoritative sniff already 422s anything whose real bytes are unknown, so admitting octet-stream would not weaken the actual content check.
- **Where:** `lib/v1/upload.js` (the `allowed` array), `lib/v1/router.js` (the sniff that follows), `test/e2e-input-http.test.js` (documents the current contract in the HEIC case's comment).

## Live-stack smoke checks (human, not automatable here)
Recorded by the Phase 1 verifier as **informational** — require a real VPS/tailnet/providers, so they are not gaps in the automated suite:
- Real ACME/HTTPS issuance + Tailscale admin binding on the VPS.
- Real-provider OCR round-trip (ocr.space / Ollama Cloud) with live keys.
- Container SIGTERM drain timing under Docker `stop_grace_period`.
