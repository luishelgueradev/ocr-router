# ocr-router

Servicio dockerizado de reconocimiento de documentos, expuesto como una API HTTP `/v1` con token bearer. Un cliente sube un archivo (imagen o PDF) y el servicio **rutea cada request por una cascada ordenada de motores** — primero el barato/rápido (`ocr.space`), escalando a LLMs de visión (Ollama Cloud) de más calidad — hasta producir un resultado usable. Todo funciona con un **modelo de jobs asíncrono** (`202 + job_id` → poll `GET /v1/jobs/:id`) y una **respuesta page-aware** (`pages[]`) para documentos multipágina.

Está pensado para desarrolladores y pipelines de automatización (n8n y similares) que necesitan extracción de texto/datos confiable sin administrar a mano múltiples proveedores, claves y lógica de fallback. Además del texto libre, ofrece **extracción estructurada** (`mode=structured`): se pasa un JSON Schema y se recibe JSON validado contra ese esquema, extraído por un LLM de visión con decodificación restringida.

> **Valor central:** nunca fallar en devolver el mejor texto/dato disponible para un documento — la cascada escalona la calidad automáticamente.

## Tecnologías

| Categoría | Tecnología |
|-----------|-----------|
| Lenguaje | Node.js >= 22 |
| HTTP | Express 4 |
| Subida de archivos | multer 2 |
| Cola / concurrencia | bottleneck (worker de concurrencia 1) |
| Store de jobs | lru-cache (TTL + máx. entradas) |
| Logging | pino / pino-http |
| PDF (texto nativo) | unpdf (PDF.js serverless) |
| PDF (rasterización) | poppler-utils (`pdftoppm` / `pdfinfo`) |
| Imágenes (TIFF/WebP/GIF/resize) | sharp (libvips) |
| HEIC | heic-convert (WASM) |
| BMP | @vingle/bmp-js |
| Validación de esquema | ajv 8 |
| Motores OCR | ocr.space + Ollama Cloud (visión) |
| Reverse proxy | Caddy 2 |
| Ingress (home) | Cloudflare Tunnel (cloudflared) |
| Infraestructura | Docker + Docker Compose |
| Tests | `node --test` |

## Requisitos previos

- **Node.js >= 22** (para desarrollo local) o **Docker + Docker Compose v2** (para el stack).
- Al menos una clave de proveedor OCR:
  - **Ollama Cloud** (`OLLAMA_API_KEY`) — necesaria para `mode=structured` y los tiers LLM de visión.
  - **ocr.space** (`OCR_SPACE_API_KEY`) — tier OCR clásico/barato.
- Según el modo de deploy: un **Cloudflare Tunnel** (token) o un **dominio público + IP de Tailscale**.

## Instalación

### Camino principal — instalador automático

El proyecto trae un `install.sh` autosuficiente que instala dependencias, prepara el directorio, clona el repo, **pregunta el modo de deploy**, arma el `.env` interactivamente (genera el `API_TOKEN`, pide las claves de proveedor y el token/dominio) y levanta el stack:

```bash
curl -sL https://raw.githubusercontent.com/luishelgueradev/ocr-router/main/install.sh | bash
```

No hace falta copiar `.env.example` ni editar nada a mano — el instalador genera el `.env` completo. Ver [DEPLOY.md](DEPLOY.md) para el detalle de ambos modos.

### Desarrollo local

```bash
git clone https://github.com/luishelgueradev/ocr-router.git
cd ocr-router
npm install
cp .env.example .env   # completar valores; con NODE_ENV=development se relaja el guard de Tailscale
node server.js         # o: npm run web  → escucha en :3000
```

## Configuración

El instalador genera el `.env`. Para setup manual, la plantilla es `.env.example`. Variables:

| Variable | Default | Descripción |
|----------|---------|-------------|
| `API_TOKEN` | — | **Obligatoria.** Bearer token de `/v1/*`. Generar con `openssl rand -hex 32`. El server no arranca con el placeholder. |
| `OLLAMA_API_KEY` | — | Clave de Ollama Cloud (motores LLM de visión + `mode=structured`). |
| `OCR_SPACE_API_KEY` | — | Clave de ocr.space (tier OCR clásico). |
| `TUNNEL_TOKEN` | — | Token del Cloudflare Tunnel (solo modo tunnel). |
| `DOMAIN` | — | Dominio público para el HTTPS automático de Caddy (solo modo vps). |
| `TAILSCALE_IP` | — | IP tailnet del host; ata el panel admin ahí (solo modo vps). |
| `APP_MEM_LIMIT` | `1g` | Límite de memoria del contenedor (cgroup). |
| `PORT` | `3000` | Puerto interno de la app. |
| `LOG_LEVEL` | `info` | Nivel de pino (trace/debug/info/warn/error). |
| `MAX_UPLOAD_BYTES` | `10485760` | Tamaño máximo de subida (10 MB). |
| `MAX_QUEUE_DEPTH` | `10` | Jobs en cola antes de `503 server_busy`. |
| `JOB_STORE_MAX` | `500` | Máx. de jobs en memoria (LRU). |

Debe existir **al menos una** de `OLLAMA_API_KEY` / `OCR_SPACE_API_KEY`, o el servicio falla al arrancar (guard de cero-motores). El `API_TOKEN` y (en modo vps) `TAILSCALE_IP` son fail-closed: el server se niega a bootear si faltan o son placeholders.

## Uso

| Comando | Descripción |
|---------|-------------|
| `npm run web` | Arranca el server (`node server.js`) en `:3000`. |
| `npm test` | Corre todas las suites (`node --test`) + `scripts/verify-redaction.js`. |
| `npm run audit` | Auditoría de dependencias de producción (`npm audit --omit=dev --audit-level=high`). |
| `bash scripts/docker-smoke.sh` | Smoke de integración dentro de la imagen (poppler/HEIC reales). |

### Flujo típico (API)

```bash
export TOKEN=...  # el API_TOKEN del .env
BASE=https://tu-host   # o http://localhost:8780 en local

# 1. Subir un documento → 202 + job_id
curl -s -H "Authorization: Bearer $TOKEN" -F "file=@factura.png" $BASE/v1/ocr

# 2. Pollear hasta terminal
curl -s -H "Authorization: Bearer $TOKEN" $BASE/v1/jobs/EL_JOB_ID

# 3. Extracción estructurada (JSON validado contra un esquema)
curl -s -H "Authorization: Bearer $TOKEN" \
  -F "file=@factura.png" -F "mode=structured" \
  -F 'schema={"type":"object","properties":{"total":{"type":["string","null"]}},"required":["total"]}' \
  $BASE/v1/ocr
```

### Panel admin

La app sirve un panel web en `/` (uploader con drag/paste, selector de modelo, OCR en vivo). Es una superficie **solo local/tailnet** — nunca se expone por el ingress público (ver Deploy).

## Arquitectura del proyecto

```
ocr-router/
├── server.js                  # boot, guards fail-closed, panel /api, monta /v1
├── lib/
│   ├── ocr.js                 # seam runOCR(model, ...) → provider
│   ├── models.js              # catálogo de motores (id, modelTag, modos)
│   ├── clock.js               # reloj monotónico (deadlines/duraciones)
│   ├── providers/             # ocrspace.js, ollama.js
│   └── v1/
│       ├── router.js          # rutas /v1, gates (auth, formato, esquema)
│       ├── worker.js          # dispatch: forzado / cascada / input / structured
│       ├── jobs.js            # store LRU de jobs + envelope
│       ├── cascade/           # runner, config (perfiles/capacidades), heurística, trace
│       ├── input/             # sniff, pdf-text, rasterize, image-normalize, page-pipeline, sandbox
│       └── structured/        # schema (ajv), prompt, extract, capability, input-support
├── public/index.html          # panel admin
├── Dockerfile                 # node:22-bookworm-slim + poppler + tini, USER node
├── docker-compose.yml         # modo vps (Caddy HTTPS público + Tailscale)
├── docker-compose.tunnel.yml  # modo tunnel (home/WSL + Cloudflare Tunnel)
├── Caddyfile / Caddyfile.tunnel
├── install.sh / DEPLOY.md
└── test/                      # node --test (suites de host) + docker-smoke
```

Flujo de un request:

```
multipart → router (auth + sniff magic-byte + gates) → cola (bottleneck, conc. 1)
  → worker → { forzado | cascada | input-pipeline (PDF/multi-formato) | structured }
  → envelope (pages[] / structured) → GET /v1/jobs/:id
```

La cascada es **declarativa** (`lib/v1/cascade/config.js`: perfiles `fast`/`balanced`/`quality` + tabla de capacidades) — sin `if`/`switch` por motor. `mode=structured` es una ruta aparte que reutiliza el seam del proveedor pero valida contra el esquema (ajv), con un reintento de reparación y fall-through; nunca devuelve JSON sin validar.

## API / Endpoints

Todas las rutas `/v1/*` (excepto `/v1/health`) requieren `Authorization: Bearer <API_TOKEN>`.

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/v1/ocr` | Sube un archivo (multipart, campo `file`) → `202 { job_id, status_url }`. |
| GET | `/v1/jobs/:id` | Pollea el job → terminal `succeeded` / `failed` + `result`. |
| GET | `/v1/models` | Lista los motores configurados, sus `modes_supported` y `supports_structured`. |
| GET | `/v1/health` | Liveness sin auth. |

### POST `/v1/ocr` — campos (multipart)

| Campo | Descripción |
|-------|-------------|
| `file` | El documento. Tipo detectado por magic-byte (nunca el `Content-Type` del cliente). |
| `model` | *(opcional)* fuerza un motor específico (bypass de la cascada). |
| `profile` | *(opcional)* `fast` / `balanced` / `quality`. |
| `mode` | *(opcional)* `structured` para extracción JSON validada. |
| `schema` | *(con `mode=structured`)* JSON Schema (`type: object`) al que ajustar la salida. |

Formatos admitidos: **PNG, JPEG, WebP, PDF (nativo y escaneado), TIFF, HEIC, BMP, GIF**. Un upload sin `Content-Type` preciso (`application/octet-stream`) también se acepta y se decide por sniff. Respuestas: sobre-tamaño ⇒ `413`; formato desconocido/spoofeado ⇒ `422`; cola llena ⇒ `503 server_busy` + `Retry-After`; sin token / token inválido ⇒ `401`.

`mode=structured` es single-image en esta versión (PNG/JPEG/WebP directo; HEIC/BMP normalizados). Forzar `ocrspace-engine2` con `mode=structured` ⇒ `422` (excluido por capacidad). Un PDF con `mode=structured` ⇒ `422`.

## Docker

Imagen `node:22-bookworm-slim` con `tini` (PID 1) y `poppler-utils` (rasterización de PDF escaneado). El healthcheck vive en el compose y usa un probe `fetch` nativo de Node (bookworm-slim no trae `wget`/`curl`). `stop_grace_period` de 40s le da al drain de SIGTERM (35s) margen para terminar jobs en vuelo antes del SIGKILL.

El stack tiene tres piezas sobre la red `ocr_net`: **app** (API + worker), **caddy** (reverse proxy **default-deny**: solo `/v1/*` sale, el resto `404`) y, en modo tunnel, **cloudflared** (túnel saliente).

```bash
# Modo tunnel (home/WSL)
docker compose -f docker-compose.tunnel.yml up -d --build
# Modo vps (servidor público)
docker compose up -d --build
# Logs / estado / parar
docker compose -f <compose> logs -f
docker compose -f <compose> down
```

Las variables se leen de `.env` (ver Configuración).

## Deploy

Dos modos (detalle completo en [DEPLOY.md](DEPLOY.md)):

- **tunnel** (home/WSL, sin IP pública): `docker-compose.tunnel.yml` + `Caddyfile.tunnel`. Un Cloudflare Tunnel entra a `caddy:80`; Cloudflare termina el TLS en el borde. El panel admin queda solo en `127.0.0.1:8780`.
- **vps** (servidor): `docker-compose.yml` + `Caddyfile`. Caddy emite HTTPS Let's Encrypt para `$DOMAIN` en 80/443; el panel admin se ata a `${TAILSCALE_IP}:8780` (solo tu tailnet).

**Perímetro de seguridad (ambos modos):** solo `/v1/*` es público (vía Caddy default-deny). El panel admin y `/api/*` usan las claves de proveedor **sin bearer** y nunca se exponen por el ingress. El `install.sh` documentado arriba automatiza todo el flujo y pregunta el modo al correr.

## Tests

El runner es `node --test` (sin ESLint/TypeScript en este milestone).

```bash
npm test   # todas las suites + scripts/verify-redaction.js
```

### Smoke de integración Docker (poppler + HEIC reales)

Dos comportamientos del input-pipeline dependen de la imagen desplegada y **no** se pueden probar en el host: el sandbox de subproceso (dash `ulimit`/`timeout` alrededor de `pdftoppm`/`pdfinfo` reales) y el decode de HEIC. `poppler-utils` es Docker-only por diseño, así que `test/docker-smoke.test.js` es un smoke Docker **excluido de `npm test`**:

```bash
bash scripts/docker-smoke.sh            # usa/construye ocr-router:latest
REBUILD=1 bash scripts/docker-smoke.sh  # fuerza rebuild
```

En el host cada caso con dependencia real **SKIPea** (verde por skip); dentro de la imagen cada caso **ejecuta** contra los binarios reales (rasterización page-by-page, límite `ulimit -v` de 768 MB, decode HEIC→PNG, kill dentro de la ventana de gracia, drenaje de temp dirs).

## Seguridad de dependencias

Las dependencias de producción se escanean con `npm audit`:

```bash
npm run audit   # npm audit --omit=dev --audit-level=high  → falla en high/critical
```

`--omit=dev` audita solo lo que va a producción. `sharp>=0.35.0` es el piso con CVE corregido; `unpdf`, `heic-convert`, `@vingle/bmp-js` y `ajv` están pinneados a las versiones investigadas en `CLAUDE.md`. El gate reporta **0 vulnerabilidades** (sin allowlist). Si un futuro advisory fuera realmente irreparable, agregar una entrada de allowlist documentada y con fecha de revisión, en vez de bajar el umbral.

## Estado del proyecto

**Milestone v1.0 — completo (4 de 4 fases).** Foundation (API + auth + deploy), Cascade Router (escalonamiento automático + trazabilidad), Input Pipeline (PDF nativo/escaneado + normalización multi-formato + resultados por página) y Structured Extraction (`mode=structured`). Validado con suite automatizada verde y UAT en vivo end-to-end (OCR real por ocr.space y extracción estructurada real por Ollama visión). Último avance: 2026-07-24.
