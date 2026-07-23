# syntax=docker/dockerfile:1.6

# --------- Stage 1: deps (install production node_modules) ---------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Copy ONLY package files first to maximize cache hit on source-only changes
COPY package.json package-lock.json ./

# npm ci is reproducible (uses lock); --omit=dev strips devDeps; --no-audit/--no-fund speed up CI
RUN npm ci --omit=dev --no-audit --no-fund

# --------- Stage 2: runtime (final image) ---------
FROM node:22-bookworm-slim AS runtime

# Install tini for proper PID 1 / signal forwarding and poppler-utils for the
# Phase 3 PDF rasterization path (installed now per D-10 to keep the base image
# stable — NO PDF/sharp code is added or used in Phase 1). On Debian bookworm
# the packages come from apt-get (Pitfall 1: the Alpine package manager is
# absent here), and tini installs under /usr/bin (the Alpine /sbin location
# does not apply). Clean the apt lists in the same layer so they never ship.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring deps from the deps stage — no npm cache, no devDeps in final image
COPY --from=deps /app/node_modules ./node_modules

# Bring app source — order: package.json first (rarely changes), then source
COPY package.json package-lock.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

# Drop to non-root user (uid=1000(node) ships in node:bookworm-slim — D-02)
USER node

# CR-01 fix — make NODE_ENV=production the default for the runtime image so the
# TAILSCALE_IP fail-closed guard in server.js fires in every Docker/compose
# context. docker-compose.yml ALSO sets this explicitly (belt-and-suspenders) so
# the guard does not depend on Dockerfile defaults bleeding through.
ENV NODE_ENV=production

# Document the port; Compose still controls actual publishing
EXPOSE 3000

# Use tini as init (defense-in-depth) + exec form CMD (Pitfall 1, D-03).
# Debian installs tini under /usr/bin (the Alpine /sbin location does not apply).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
