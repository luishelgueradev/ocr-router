---
phase: 01-foundation
plan: 03
subsystem: deploy
tags: [docker, docker-compose, caddy, tini, poppler-utils, tailscale, healthcheck, node-test]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Ported /v1 app runtime (server.js, lib/**), package.json (multer ^2.2, engines node>=22), .env.example placeholders, .dockerignore"
provides:
  - "Buildable Docker image ocr-router:latest on node:22-bookworm-slim with tini (/usr/bin/tini) + poppler-utils (Phase 3 PDF path, unused now)"
  - "Two-service Compose stack: app tailnet-bound (${TAILSCALE_IP}:8780:3000, never 0.0.0.0) + Caddy public (only /v1/*, automatic HTTPS, default-deny)"
  - "Node-native fetch healthcheck (bookworm-slim has no wget/curl) with 40s stop_grace_period SIGTERM drain buffer"
  - "test/deploy.test.js (37 assertions) proving the Debian artifact shape in lockstep with the Dockerfile/compose/Caddyfile"
  - "README.md documenting env vars, docker compose build/run, and local dev path"
affects: [03-input-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-stage Docker build (deps + runtime) on node:22-bookworm-slim; system deps via apt-get --no-install-recommends + apt-list cleanup in-layer"
    - "Healthcheck in compose (not Dockerfile) so the image stays generic; Node-native global-fetch probe replaces busybox wget on Debian"
    - "Tailnet-only admin bind (${TAILSCALE_IP:?...} fail-loud) + Caddy default-deny as the public/tailnet trust boundary"
    - "Static deploy-artifact assertions (deploy.test.js) kept byte-in-lockstep with the deploy files"

key-files:
  created:
    - Dockerfile
    - docker-compose.yml
    - Caddyfile
    - test/deploy.test.js
    - README.md
  modified: []

key-decisions:
  - "D-10: node:22-bookworm-slim base; tini + poppler-utils installed via apt-get now (poppler unused in Phase 1); NO sharp/PDF code added"
  - "Pitfall 1: Debian tini path /usr/bin/tini (not the Alpine /sbin path); apt-get replaces the Alpine package manager"
  - "Pitfall 2: healthcheck rewritten to a Node 22 global-fetch probe because bookworm-slim ships no wget/curl"
  - "Image tag renamed to ocr-router:latest; Caddyfile ported AS-IS (only project-name comment changed)"

patterns-established:
  - "Reword comments so migration greps (apk, /sbin/tini, node:20-alpine, wget/curl) stay clean without losing the explanatory intent"

requirements-completed: [OPS-01, OPS-02, OPS-03, OPS-04, OPS-05]

# Metrics
duration: 7min
completed: 2026-07-23
---

# Phase 1 Plan 03: Deploy Stack (Debian Migration) Summary

**Migrated the reference deploy stack from Alpine/Node 20 to `node:22-bookworm-slim` + `poppler-utils` + `tini`, rewrote `test/deploy.test.js` in lockstep, and proved it for real — `docker compose build` builds `ocr-router:latest` (tini 0.19.0 @ /usr/bin/tini, pdftoppm 22.12.0, node v22.22.2) and the full `npm test` suite is 189/189 green.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-07-23T20:01Z
- **Completed:** 2026-07-23T20:09Z
- **Tasks:** 2 completed
- **Files created:** 5

## Accomplishments
- **Dockerfile rewritten** to a two-stage `node:22-bookworm-slim` build: `apt-get install -y --no-install-recommends tini poppler-utils` with `rm -rf /var/lib/apt/lists/*` in-layer, `ENTRYPOINT ["/usr/bin/tini", "--"]` (Debian path), exec-form `CMD ["node", "server.js"]`, `USER node`, `ENV NODE_ENV=production`, `EXPOSE 3000`, no HEALTHCHECK (lives in compose). No PDF/sharp code — poppler is present but unused this phase.
- **docker-compose.yml** ported near-AS-IS with the two Debian fixes: Node-native `fetch` healthcheck probe (Pitfall 2) and image tag `ocr-router:latest`. Retained `${TAILSCALE_IP:?...}:8780:3000` fail-loud bind, `stop_grace_period: 40s`, caddy `caddy:2-alpine` with cert volumes + `service_healthy` gate, `ocr_net` bridge.
- **Caddyfile** ported AS-IS: default-deny, four `/v1/*` handle blocks with per-route timeouts + `dial_timeout 2s`, `{$DOMAIN}` automatic HTTPS, terminal `handle { error 404 }`, commented `acme_ca` staging hint. Only the project-name header comment changed.
- **test/deploy.test.js** rewritten (37 assertions) tracking the migration: DEPLOY-01 bookworm stages + apt-get tini/poppler-utils + `/usr/bin/tini`, DEPLOY-07 Node-fetch healthcheck (negative asserts no wget/curl), DEPLOY-03 image tag `ocr-router:latest`; DEPLOY-03/04/06 kept.
- **README.md** written: product one-liner, `/v1` surface table, required-env table, `docker compose build`/`up` + local `node server.js` dev path, test instructions.
- **Real build gate (D-11/OPS-01) executed:** `docker compose build` succeeded; `docker run` confirmed tini at `/usr/bin/tini`, `pdftoppm` 22.12.0, and node v22.22.2 inside the image.

## Task Commits

1. **Task 1: Rewrite Dockerfile + port Caddyfile + adapt compose** — `4248106` (feat)
2. **Task 2: Rewrite deploy.test.js + README; build smoke + full npm test** — `0272902` (test)

## Deviations from Plan

### Auto-fixed (Rule 3 — blocking issue, environment)

**1. [Rule 3 - Blocking] Docker BuildKit credential-helper failure worked around**
- **Found during:** Task 2 (the `docker compose build` gate).
- **Issue:** The `# syntax=docker/dockerfile:1.6` directive makes BuildKit pull the `docker/dockerfile:1.6` frontend image; the host `~/.docker/config.json` sets `"credsStore": "desktop.exe"`, and `docker-credential-desktop.exe` is not on PATH in this WSL2 shell, so the anonymous public-image pull failed with `error getting credentials`.
- **Fix:** Since `auths` was empty (only anonymous public pulls needed), pointed `DOCKER_CONFIG` at a scratch config containing `{"auths":{}}` (no credsStore) for the build/run commands. No repo file changed; the Dockerfile/compose are correct. This is a host Docker Desktop/WSL config quirk, not a deploy-artifact regression.
- **Files modified:** none (env-only workaround for the build invocation).
- **Commit:** n/a (no artifact change).

No other deviations. The Dockerfile migration, Caddyfile port, compose edits, and deploy.test.js rewrite were implemented exactly as specified. No architectural (Rule 4) changes; no auth gates.

## Verification Results
- **Task 1 automated verify:** `grep` gate → `DEPLOY-ARTIFACTS-OK`. `node:22-bookworm-slim` ×2 in Dockerfile, `node:20-alpine` ×0, `HEALTHCHECK` ×0, `apk` ×0, `/sbin/tini` ×0, `reverse_proxy app:3000` ×4 in Caddyfile.
- **Task 2 automated verify:** `node --test test/deploy.test.js` → **37/37 pass, 0 fail**. `node:22-bookworm-slim` ≥1, `node:20-alpine` ×0, `/usr/bin/tini` present, `poppler-utils` present in the test file.
- **Build gate (D-11/OPS-01):** `docker compose build` → **success**, `ocr-router:latest` built. `docker run` proofs: `tini version 0.19.0` at `/usr/bin/tini`; `pdftoppm version 22.12.0`; `node v22.22.2`.
- **Phase acceptance gate:** full `npm test` (19 test files + `scripts/verify-redaction.js`) → **189 tests, 189 pass, 0 fail**.

## Known Stubs
None that block the plan goal. Phase-scoped intentional (documented, resolved later):
- `poppler-utils` is installed in the image but **unused in Phase 1** — installed early per D-10 to keep the base image stable; the PDF rasterization code lands in Phase 3.

## Notes for Next Plans
- The deploy stack is buildable and Tailscale-isolated on the correct Debian base. Phase 3 can add `sharp`/PDF code with poppler-utils already present (no base-image change).
- `test/deploy.test.js` is byte-coupled to the deploy files — any future Dockerfile/compose/Caddyfile edit must update its assertions in lockstep.
- On this WSL2 host, Docker builds require `DOCKER_CONFIG` pointed at a credsStore-free config (host `~/.docker/config.json` references a missing `docker-credential-desktop.exe`).

## Self-Check: PASSED

All 5 created files verified present; both task commits (4248106, 0272902) verified in git history. (See Self-Check appendix below.)
