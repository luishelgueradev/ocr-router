#!/usr/bin/env bash
# 03-07 / D-11 — run the real-dependency integration smoke INSIDE the built image.
#
# The two Phase-3 STATE risk-flags (subprocess-sandbox mechanics on bookworm-slim
# and HEIC-in-Docker decode) can only be proven against the deployed base image,
# not the host (poppler is Docker-only by design). This script builds/uses the
# `ocr-router:latest` image and executes `node --test test/docker-smoke.test.js`
# against REAL pdftoppm/pdfinfo + heic-convert + dash ulimit + coreutils timeout.
#
# The production image intentionally does NOT copy `test/` (Dockerfile ships only
# server.js/lib/public/scripts). So we BIND-MOUNT ONLY the repo's `test/` dir (the
# test file + committed fixtures) into the image at /app/test, then run from /app.
# That way Node resolves `require('../lib/...')` to the IMAGE's own /app/lib (the
# code under test, byte-identical to the committed source the Dockerfile COPYs) and
# `require('sharp')`/`require('heic-convert')` to the IMAGE's /app/node_modules —
# NOT the host's. Mounting the whole repo would shadow /app/node_modules with the
# host build, defeating the point; mounting only test/ preserves the image deps.
# Nothing is written back to the working tree (mount is read-only) and the
# production image's CMD/copy set is never touched.
#
# Usage:
#   bash scripts/docker-smoke.sh            # use existing ocr-router:latest (build if absent)
#   REBUILD=1 bash scripts/docker-smoke.sh  # force a rebuild first
set -euo pipefail

IMAGE="${IMAGE:-ocr-router:latest}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The host ~/.docker/config.json may point at a broken credsStore; isolate config.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$(mktemp -d)}"
[ -f "$DOCKER_CONFIG/config.json" ] || echo '{}' > "$DOCKER_CONFIG/config.json"

need_build=0
if [ "${REBUILD:-0}" = "1" ]; then
  need_build=1
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  need_build=1
fi

if [ "$need_build" = "1" ]; then
  echo ">> Building $IMAGE ..."
  # docker-compose build interpolates TAILSCALE_IP/DOMAIN; a plain build avoids that.
  docker build -t "$IMAGE" "$REPO_ROOT"
fi

echo ">> Running the Docker smoke inside $IMAGE ..."
# --network none: the smoke is fully offline (fixtures are committed). The test/
# mount is read-only so the container never writes back into the working tree;
# per-job temp dirs land in the container's own writable /tmp. Running from /app
# resolves lib/ + node_modules to the IMAGE build (see header note).
exec docker run --rm \
  --network none \
  -v "$REPO_ROOT/test":/app/test:ro \
  -w /app \
  "$IMAGE" \
  node --test test/docker-smoke.test.js
