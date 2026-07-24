# Deploy — ocr-router

Servicio dockerizado de reconocimiento de documentos: API HTTP `/v1` con token bearer y cascada de motores OCR (ocr.space + LLMs de visión de Ollama Cloud), más un panel admin.

## Instalación rápida

```bash
curl -sL https://raw.githubusercontent.com/luishelgueradev/ocr-router/main/install.sh | bash
```

> El `install.sh` es autosuficiente: instala dependencias (git, docker, docker compose, openssl), prepara `/opt/luishelgueradev/ocr-router`, clona el repo, **pregunta el modo de deploy**, arma el `.env` interactivamente (genera el `API_TOKEN`, pide las claves de proveedor y el token del túnel o el dominio+Tailscale), construye e inicia el stack y espera el healthcheck. Si tu rama por defecto es `master`, cambiá `main` por `master` en la URL.

Desatendido (todo por entorno):
```bash
DEPLOY_MODE=tunnel API_TOKEN=xxxx OLLAMA_API_KEY=xxxx TUNNEL_TOKEN=xxxx \
  curl -sL https://raw.githubusercontent.com/luishelgueradev/ocr-router/main/install.sh | bash
```

## Requisitos

- Linux con `sudo` (o root) y acceso a internet.
- Docker + plugin `docker compose` v2 (el instalador los instala si faltan).
- Al menos una clave de proveedor OCR: **Ollama Cloud** (`OLLAMA_API_KEY`, necesaria para el modo `structured` y los tiers LLM) y/o **ocr.space** (`OCR_SPACE_API_KEY`). El servicio no arranca sin ninguna (guard de cero-motores).
- Según el modo: un **Cloudflare Tunnel** (token) o un **dominio + IP de Tailscale**.

## Arquitectura

Stack Docker Compose con tres piezas. Hay **dos modos** que difieren solo en el ingress:

```
Modo tunnel (home/WSL):
  internet ─TLS→ Cloudflare edge ─túnel→ cloudflared ─http→ caddy:80 ─/v1→ app:3000

Modo vps (servidor):
  internet ─HTTPS→ caddy:443 (Let's Encrypt) ─/v1→ app:3000
  tailnet  ─http→  app:8780 (panel admin, atado a ${TAILSCALE_IP})
```

| Servicio | Imagen | Rol |
|----------|--------|-----|
| `app` (ocr-app) | build `./Dockerfile` (node:22-bookworm-slim + poppler + tini, `USER node`) | API `/v1` + worker de concurrencia 1 + panel admin en `/`. Escucha en `:3000`. |
| `caddy` (ocr-caddy) | `caddy:2-alpine` | Reverse proxy **default-deny**: solo `/v1/*` pasa; `/`, `/api/*` → 404. Es el perímetro de seguridad. |
| `cloudflared` (ocr-cloudflared) | `cloudflare/cloudflared:latest` | *Solo modo tunnel.* Mantiene el túnel saliente hacia Cloudflare (sin puertos entrantes). |

**Seguridad clave:** el panel admin (`/`, `/api/*`) usa las claves de proveedor **sin bearer** y NUNCA debe quedar público. Por eso el túnel/HTTPS entra a **Caddy** (que 404ea todo lo que no sea `/v1`), no directo a `app`. En modo vps el panel se ata a `${TAILSCALE_IP}:8780` (solo tu tailnet); en modo tunnel se ata a `127.0.0.1:8780` (solo la máquina local).

Archivos por modo:

| Modo | Compose | Caddyfile | Ingress |
|------|---------|-----------|---------|
| `tunnel` | `docker-compose.tunnel.yml` | `Caddyfile.tunnel` (`:80` plano) | Cloudflare Tunnel → `caddy:80` |
| `vps` | `docker-compose.yml` | `Caddyfile` (`{$DOMAIN}` con ACME) | Caddy público 80/443 |

## Variables de entorno

Se arman en `.env` (nunca en el repo; `chmod 600`). Base en `.env.example`.

| Variable | Descripción | Ejemplo | Requerida |
|----------|-------------|---------|-----------|
| `API_TOKEN` | Bearer token de `/v1`. Fail-closed si falta o es el placeholder. | `openssl rand -hex 32` | **Sí** (el instalador lo genera) |
| `OLLAMA_API_KEY` | Ollama Cloud. Necesaria para `mode=structured` y los tiers LLM. | `sk-...` | Sí* |
| `OCR_SPACE_API_KEY` | ocr.space (tier OCR clásico/barato). | `K8...` | Sí* |
| `TUNNEL_TOKEN` | Token del Cloudflare Tunnel. | `eyJ...` | Solo modo `tunnel` |
| `DOMAIN` | Dominio público (Caddy/ACME). | `ocr.tudominio.dev` | Solo modo `vps` |
| `TAILSCALE_IP` | IP tailnet del server para atar el panel admin. | `100.x.x.x` | Solo modo `vps` |
| `APP_MEM_LIMIT` | Límite de memoria del contenedor (cgroup). | `1g` | No (default `1g`) |
| `PORT` | Puerto interno de la app. | `3000` | No (default `3000`) |
| `LOG_LEVEL` | pino: trace/debug/info/warn/error. | `info` | No |
| `MAX_UPLOAD_BYTES` | Tamaño máximo de subida. | `10485760` | No (10 MB) |
| `MAX_QUEUE_DEPTH` | Cola máx. antes de `503 server_busy`. | `10` | No |
| `JOB_STORE_MAX` | Máx. de jobs en memoria (LRU). | `500` | No |

\* Al menos **una** de `OLLAMA_API_KEY` / `OCR_SPACE_API_KEY`.

## Red y acceso

Este proyecto trae su **propio reverse proxy (Caddy)** — no usa Traefik. Red Docker: `ocr_net` (bridge). Los contenedores se hablan por nombre (`app:3000`, `caddy:80`).

### Modo tunnel (home/WSL) — recomendado sin IP pública

1. En Cloudflare **Zero Trust → Networks → Tunnels** creá un túnel `ocr` (tipo Cloudflared) y copiá el **token** → `.env` (`TUNNEL_TOKEN`).
2. En ese túnel, **Public Hostname → Add**: subdominio + dominio (ej. `ocr` + `tudominio.dev`), **Type HTTP, URL `caddy:80`**. Cloudflare crea el CNAME solo.
3. `docker compose -f docker-compose.tunnel.yml up -d --build`.

Resultado: `https://ocr.tudominio.dev/v1/*` público; `/` y `/api/*` → 404. Panel admin solo en `http://localhost:8780/`.

### Modo vps — Caddy HTTPS público + Tailscale

- **DNS:** registro **A** `ocr.tudominio.dev` → IP pública del server.
- **Panel admin (tailnet):** en el `/etc/hosts` de tu máquina cliente agregá `TAILSCALE_IP  ocr-admin` (o accedé directo a `http://TAILSCALE_IP:8780/`). Obtené la IP con `tailscale ip -4`.
- Caddy emite el cert Let's Encrypt automáticamente para `$DOMAIN`.

## Comandos útiles

```bash
cd /opt/luishelgueradev/ocr-router
CF=docker-compose.tunnel.yml   # o docker-compose.yml en modo vps

docker compose -f $CF logs -f            # logs
docker compose -f $CF ps                 # estado
docker compose -f $CF restart app        # reiniciar la app
docker compose -f $CF down               # detener
docker compose -f $CF up -d --build      # actualizar tras un git pull
curl -s http://localhost:8780/v1/health  # health local
```

## Actualización

```bash
cd /opt/luishelgueradev/ocr-router
git pull
docker compose -f docker-compose.tunnel.yml up -d --build   # o docker-compose.yml
```

El `.env` se preserva. Re-correr `install.sh` también actualiza (hace backup del `.env`, re-clona y reconstruye).

## Troubleshooting

- **El contenedor no arranca / reinicia en loop.** Casi siempre falta una clave de proveedor (guard de cero-motores) o el `API_TOKEN` quedó en el placeholder. Revisá `docker compose -f $CF logs app`.
- **`structured_extraction_failed` o el tier LLM falla con HTTP 410.** Ollama Cloud **retira tags de modelo** cada tanto. Verificá los tags vivos con `curl -s https://ollama.com/api/tags -H "Authorization: Bearer $OLLAMA_API_KEY"` y actualizá `lib/models.js` (`modelTag`). Los modelos deben soportar **imágenes** (visión).
- **El modelo devuelve JSON pero `structured` falla.** Ya mitigado: el parser tolera JSON envuelto en fences ```` ```json ````. Si aparece otra variante, revisá `lib/v1/structured/extract.js`.
- **502/404 en el túnel.** El Public Hostname debe apuntar a **`caddy:80`** (no `app:3000`). Verificá que los 3 contenedores estén up: `docker compose -f docker-compose.tunnel.yml ps`.
- **El panel admin quedó accesible desde afuera.** No debería: Caddy 404ea todo lo que no sea `/v1`. Probá `curl https://tu-dominio/api/config` → debe dar **404**. Si da 200, el ingress apunta mal (a `app` en vez de `caddy`).
- **`docker compose up` aborta pidiendo `TAILSCALE_IP`.** Estás usando el compose de modo vps sin esa var. En home/WSL usá `docker-compose.tunnel.yml`.

## Estructura del proyecto (deploy)

```
ocr-router/
├── install.sh                  # instalador (curl | bash), pregunta el modo
├── docker-compose.yml          # modo vps  (Caddy HTTPS público + Tailscale)
├── docker-compose.tunnel.yml   # modo tunnel (home/WSL + Cloudflare Tunnel)
├── Caddyfile                   # proxy vps  ({$DOMAIN}, ACME)
├── Caddyfile.tunnel            # proxy tunnel (:80 plano)
├── Dockerfile                  # node:22-bookworm-slim + poppler + tini, USER node
├── .env.example                # plantilla de variables
├── server.js                   # boot + guards fail-closed + /api admin + /v1
└── lib/                         # router, worker, cascada, input pipeline, structured
```
