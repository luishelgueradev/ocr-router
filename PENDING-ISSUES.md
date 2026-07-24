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

### [P3] MEDIUM — An upload declared `application/octet-stream` was rejected before it was ever sniffed — RESOLVED
- **Status:** RESOLVED 2026-07-24 (commit `b5390b5`, quick task 260724-64d). Product decision taken: admit the unlabeled-binary case and let the sniff decide.
- **Was:** `lib/v1/upload.js`'s multer `fileFilter` refused `application/octet-stream` (and an empty Content-Type) BEFORE `sniffImage`, so a valid document uploaded without a precise type — the common n8n binary-payload shape — got `422` even though its bytes were fine.
- **Fix:** the fileFilter now admits the unlabeled-binary case; the authoritative sniff still 422s unknown bytes, and an explicitly-declared non-document type (SVG, text/plain) is still refused early. Covered by two e2e cases and two unit cases; all four fail against the previous filter.

## Phase 4 — Structured Extraction

### [P4] LOW — ReDoS surface via a client-supplied JSON Schema `pattern`
- **Status:** deferred (hardening; bounded today). Surfaced 2026-07-24 (Phase 4).
- **What:** `mode=structured` compiles a client JSON Schema with ajv (`lib/v1/structured/schema.js`). A malicious `pattern`/`patternProperties` regex is compiled to a `RegExp` and run against the model's output during validation. A catastrophic-backtracking pattern could burn CPU on the single-concurrency worker.
- **Why bounded now:** validation runs against the LLM output, which is small (`num_predict`-capped), and the whole job is under `MAX_JOB_MS`. The schema itself is capped at 64 KiB / depth 12. So the blast radius is one job's deadline, not the process.
- **Complete fix (future):** compile+validate inside a worker thread with a hard timeout, or strip/deny `pattern` keywords. Not done in the MVP.
- **Where:** `lib/v1/structured/schema.js` (`parseAndCompileSchema`).

### [P4] LOW — Structured extraction is single-image only
- **Status:** deferred by design (D-S9). PDF and multi-frame TIFF/GIF with `mode=structured` are typed-rejected (422 field=file) before enqueue.
- **Why:** Phase 4 depends on Phase 2, independent of Phase 3. Per-page structured extraction (one schema across N pages, or a page-array schema) is a distinct feature needing its own design.
- **Where:** `lib/v1/structured/input-support.js`, `lib/v1/router.js` (the D-S9 gate).

### [P4] LOW — Admin panel does not expose mode=structured
- **Status:** deferred (API-only this milestone). The `public/` admin panel offers text OCR; structured mode is reachable via the API but not the UI.
- **Where:** `public/` (see the UI review / UI-IMPROVEMENTS.md).

## Live-stack smoke checks (human, not automatable here)
Recorded by the Phase 1 verifier as **informational** — require a real VPS/tailnet/providers, so they are not gaps in the automated suite:
- Real ACME/HTTPS issuance + Tailscale admin binding on the VPS.
- Real-provider OCR round-trip (ocr.space / Ollama Cloud) with live keys.
- Container SIGTERM drain timing under Docker `stop_grace_period`.
