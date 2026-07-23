# ocr-router

A dockerized document-recognition service exposed as a bearer-secured `/v1` HTTP
API. A client submits a file (image today; PDF and more later) and the service
returns extracted text via an **async job model** (`202 + job_id` → poll
`GET /v1/jobs/:id`). The response is a **page-aware envelope** from day one so
multi-page documents are additive, not breaking.

Built for developers and automation pipelines (n8n and similar) that need
reliable text extraction without hand-managing multiple OCR providers, keys, and
fallback logic. The eventual product routes each request through an ordered
cascade of engines (cheap/fast first, escalating to cloud vision LLMs); this
**Phase 1 walking skeleton** runs a single engine per request with the envelope
and traceability fields shaped for the cascade to slot in later.

> **Core value:** never fail to return the best available text/data for a
> document.

## API surface (`/v1`, bearer-secured)

| Method | Route             | Purpose                                                        |
| ------ | ----------------- | ------------------------------------------------------------- |
| POST   | `/v1/ocr`         | Submit one file (multipart, field `file`) → `202 { job_id }`  |
| GET    | `/v1/jobs/:id`    | Poll job status → terminal `succeeded` / `failed` + result    |
| GET    | `/v1/models`      | List configured engines + their `modes_supported`             |
| GET    | `/v1/health`      | Unauthenticated liveness probe                                 |

All `/v1/*` routes except `/v1/health` require `Authorization: Bearer <API_TOKEN>`.
Phase 1 accepts **PNG / JPEG / WebP**, one file per request, type detected by
magic-byte sniff (never the client `Content-Type`). Oversized ⇒ `413`;
unsupported/spoofed ⇒ `422`; full queue ⇒ `503 server_busy` + `Retry-After`.

## Required environment

Copy `.env.example` to `.env` and fill in the values.

| Variable            | Required | Notes                                                                                     |
| ------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `API_TOKEN`         | **yes**  | Bearer token for `/v1/*`. Generate with `openssl rand -hex 32`. Server refuses to boot on the placeholder. |
| `TAILSCALE_IP`      | **yes**  | Tailnet IP of this host (`tailscale ip -4`). The admin panel binds here only — never `0.0.0.0`. Fail-closed. |
| `DOMAIN`            | **yes**  | Public domain (A record) for Caddy automatic HTTPS.                                        |
| `OLLAMA_API_KEY`    | cond.    | Ollama Cloud key for the vision LLM engines.                                               |
| `OCR_SPACE_API_KEY` | optional | Enables the `ocr.space` engine (preferred default when set). Leave empty to disable.       |
| `PORT`              | optional | App port inside the container. Default `3000`.                                             |
| `MAX_UPLOAD_BYTES`  | optional | Upload size cap. Default `10485760` (10 MB).                                               |
| `LOG_LEVEL`         | optional | pino level. Default `info`.                                                                |
| `MAX_QUEUE_DEPTH`   | optional | Queued jobs before `503`. Default `10`.                                                    |
| `JOB_STORE_MAX`     | optional | Max in-memory job records (LRU). Default `500`.                                            |

At least one provider key must be present at boot, or the service fails closed
(zero-engine guard, D-08).

## Deploy (Docker Compose + Caddy)

The stack is two services on a private bridge network:

- **app** — this image, bound **only** to `${TAILSCALE_IP}:8780:3000` (tailnet).
  The admin/demo panel (`/`, `/api/*`) is reachable only over the tailnet.
- **caddy** — `caddy:2-alpine` on public `80/443` (+ `443/udp` for HTTP/3),
  automatic HTTPS, default-deny: only `/v1/*` is proxied; everything else `404`s.

The image is `node:22-bookworm-slim` with `tini` (PID 1 signal forwarding) and
`poppler-utils` (installed now for the Phase 3 PDF path; unused in Phase 1). The
healthcheck lives in compose and uses a Node-native `fetch` probe (bookworm-slim
ships no `wget`/`curl`).

```bash
# 1. Configure
cp .env.example .env
# edit .env: set API_TOKEN, TAILSCALE_IP, DOMAIN, and at least one provider key

# 2. Build the image (the D-11 "build" gate)
docker compose build

# 3. Run the full stack (app + Caddy)
docker compose up -d

# Dev: run ONLY the app (Caddy is opt-in; dependency is one-directional)
docker compose up app
```

`stop_grace_period` is 40s, giving the SIGTERM drain (35s budget) a 5s buffer to
finish in-flight jobs before Docker SIGKILLs the container.

## Local development

```bash
npm install          # Node >= 22
cp .env.example .env  # fill in values (set NODE_ENV unset/development to relax the tailnet guard locally)
node server.js        # or: npm run web
```

## Tests

The test runner is `node --test` (no ESLint/TypeScript in this milestone).

```bash
npm test   # all suites + scripts/verify-redaction.js
```

Deploy-artifact shape (this file, the Dockerfile, compose, Caddyfile) is covered
by `test/deploy.test.js`. The build itself is validated by `docker compose build`.

## Dependency security (OPS-06)

Production dependencies are scanned with `npm audit` so a future vulnerable pin
is caught before ship:

```bash
npm run audit   # npm audit --omit=dev --audit-level=high  → exits non-zero on any high+ advisory
```

- **Scope:** `--omit=dev` audits only what ships to production; `--audit-level=high`
  fails the gate on `high`/`critical` advisories (moderate/low are surfaced but
  non-blocking for this milestone).
- **Native/WASM decoder pins:** `sharp>=0.35.0` is the CVE-fixed floor (older
  libvips-linked builds carried advisories); `unpdf`, `heic-convert`, and
  `@vingle/bmp-js` are pinned to the researched versions in `CLAUDE.md`.
- **Remediation:** the pre-existing transitive advisories (axios / form-data /
  body-parser / qs, reachable via express + multer + axios) were remediated with
  `npm audit fix` — no Express-5 major bump (the ported v4 middleware is kept per
  `CLAUDE.md`). The gate currently reports **0 vulnerabilities**, so there is **no
  allowlist**. If a future advisory is genuinely unfixable, add a documented,
  time-boxed allowlist entry here (advisory ID + rationale + review date) rather
  than lowering the gate threshold.
