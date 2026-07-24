#!/bin/bash
# =============================================================================
# ocr-router — Instalador automatico
# =============================================================================
# Uso (desde cualquier maquina):
#   curl -sL https://raw.githubusercontent.com/luishelgueradev/ocr-router/main/install.sh | bash
#
# O desde una copia local del repo:
#   bash install.sh
#
# Desatendido (sin prompts) — preseteando variables de entorno, p.ej. modo tunnel:
#   DEPLOY_MODE=tunnel API_TOKEN=... OLLAMA_API_KEY=... TUNNEL_TOKEN=... \
#     curl -sL .../install.sh | bash
#
# Que hace:
#   1. Instala dependencias que falten (git, curl, openssl, docker + compose v2).
#   2. Prepara /opt/luishelgueradev/ocr-router y permisos (grupo docker).
#   3. Clona (o actualiza) el repo, preservando tu .env previo.
#   4. Pregunta el MODO de deploy: tunnel (home/WSL) o vps (Caddy publico + Tailscale).
#   5. Arma el .env interactivamente (genera API_TOKEN, pide claves, token/dominio).
#   6. Construye e inicia el stack Docker correcto y espera el healthcheck.
#
# Requisitos: una maquina Linux con acceso a internet y sudo (o root).
# =============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
GIT_USER="luishelgueradev"
APP_NAME="ocr-router"
INSTALL_DIR="/opt/${GIT_USER}/${APP_NAME}"
REPO_URL="https://github.com/${GIT_USER}/${APP_NAME}.git"

# -- Colores -----------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "=========================================="
echo "  ocr-router — Instalador"
echo "=========================================="
echo ""

# -- Helpers -----------------------------------------------------------------
have()  { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then have sudo && SUDO="sudo" || warn "sin sudo ni root: instalar paquetes/permisos puede fallar"; fi

PKG=""
for c in apt-get dnf yum apk pacman; do have "$c" && { PKG="$c"; break; }; done

pkg_install() {
  local p="$1"
  case "$PKG" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$p" ;;
    dnf|yum) $SUDO "$PKG" install -y "$p" ;;
    apk)     $SUDO apk add --no-cache "$p" ;;
    pacman)  $SUDO pacman -Sy --noconfirm "$p" ;;
    *)       return 1 ;;
  esac
}

ensure_cmd() {
  local cmd="$1" pkg="${2:-$1}"
  have "$cmd" && { ok "$cmd presente"; return 0; }
  info "Falta '$cmd' — instalando ($pkg)..."
  pkg_install "$pkg" && have "$cmd" && ok "$cmd instalado" \
    || error "No pude instalar '$cmd' automaticamente. Instalalo y reintenta."
}

TTY=""; [ -e /dev/tty ] && TTY="/dev/tty"

prompt() {
  local __var="$1" __msg="$2" __def="${3:-}" __cur
  eval "__cur=\${$__var:-}"
  [ -n "$__cur" ] && return 0
  if [ -z "$TTY" ]; then
    [ -n "$__def" ] && { eval "$__var=\$__def"; return 0; } || error "Falta $__var y no hay terminal para preguntarlo. Pasalo como variable de entorno."
  fi
  local __ans
  if [ -n "$__def" ]; then read -r -p "$__msg [$__def]: " __ans < "$TTY"; __ans="${__ans:-$__def}";
  else read -r -p "$__msg: " __ans < "$TTY"; fi
  eval "$__var=\$__ans"
}

prompt_secret() {
  local __var="$1" __msg="$2" __optional="${3:-}" __cur
  eval "__cur=\${$__var:-}"
  [ -n "$__cur" ] && return 0
  if [ -z "$TTY" ]; then
    [ -n "$__optional" ] && return 0 || error "Falta $__var (secreto) y no hay terminal. Pasalo como variable de entorno."
  fi
  local __ans; read -r -s -p "$__msg: " __ans < "$TTY"; echo ""; eval "$__var=\$__ans"
}

gen_token_hex32() { openssl rand -hex 32 2>/dev/null || python3 -c "import secrets;print(secrets.token_hex(32))"; }

# -- 1. Dependencias ---------------------------------------------------------
info "Resolviendo dependencias..."
ensure_cmd git
ensure_cmd curl
ensure_cmd openssl

if ! have docker; then
  info "Docker no esta instalado — instalando desde get.docker.com..."
  curl -fsSL https://get.docker.com | $SUDO sh || error "No pude instalar Docker automaticamente."
  $SUDO systemctl enable --now docker 2>/dev/null || true
fi
have docker || error "Docker no quedo disponible tras la instalacion."
docker compose version >/dev/null 2>&1 || error "Falta el plugin 'docker compose' v2. Instala docker-compose-plugin y reintenta."
ok "docker + docker compose v2 presentes"

# -- 2. Permisos, carpeta y grupo docker ------------------------------------
$SUDO mkdir -p "/opt/${GIT_USER}"
$SUDO chown "$(id -un)":"$(id -gn)" "/opt/${GIT_USER}" 2>/dev/null || true

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  # sin acceso directo al socket → usar sudo para docker en esta corrida
  if $SUDO docker info >/dev/null 2>&1; then DOCKER="$SUDO docker"; else error "El daemon de Docker no responde (ni con sudo). Arranca Docker y reintenta."; fi
fi
if have docker && ! id -nG "$(id -un)" | grep -qw docker; then
  info "Agregando $(id -un) al grupo docker (efectivo tras reloguear)..."
  $SUDO usermod -aG docker "$(id -un)" 2>/dev/null || true
fi
compose() { $DOCKER compose "$@"; }

# -- 3. Proteccion anti-pisado + instalacion previa -------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  DIRTY_FILES=$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null | wc -l)
  if [ "$DIRTY_FILES" -gt 0 ]; then
    error "$INSTALL_DIR tiene cambios sin commitear — parece un repo de desarrollo. Abortando para no pisarlo."
  fi
fi

ENV_BACKUP=""
if [ -f "$INSTALL_DIR/.env" ]; then
  ENV_BACKUP="$(mktemp)"; cp "$INSTALL_DIR/.env" "$ENV_BACKUP"
  info "Backup de .env previo guardado."
fi
if [ -d "$INSTALL_DIR" ]; then
  info "Instalacion previa detectada — bajando el stack..."
  ( cd "$INSTALL_DIR" && compose -f docker-compose.tunnel.yml down 2>/dev/null; compose down 2>/dev/null ) || true
  $SUDO rm -rf "$INSTALL_DIR"
fi

# -- 4. Clonar ---------------------------------------------------------------
info "Clonando $REPO_URL ..."
if ! git clone --quiet "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
  # Repo privado → intentar via gh
  if have gh || ensure_cmd gh; then
    gh auth status >/dev/null 2>&1 || { [ -n "$TTY" ] && gh auth login --hostname github.com --git-protocol https < "$TTY" || error "Repo privado sin auth. Corre 'gh auth login' o pasa GH_TOKEN."; }
    gh auth setup-git >/dev/null 2>&1 || true
    git clone --quiet "$REPO_URL" "$INSTALL_DIR" || error "No pude clonar $REPO_URL (verifica que exista y tengas acceso)."
  else
    error "No pude clonar $REPO_URL. Verifica que el repo exista y sea accesible."
  fi
fi
cd "$INSTALL_DIR"
ok "Repo en $INSTALL_DIR"

# Restaurar .env previo
if [ -n "$ENV_BACKUP" ]; then cp "$ENV_BACKUP" "$INSTALL_DIR/.env"; rm -f "$ENV_BACKUP"; info ".env previo restaurado."; fi

# -- 5. Elegir modo de deploy -----------------------------------------------
# tunnel = home/WSL detras de un Cloudflare Tunnel (solo /v1 publico via Caddy).
# vps    = servidor con Caddy HTTPS publico (80/443) + panel admin atado a Tailscale.
if [ -z "${DEPLOY_MODE:-}" ]; then
  if [ -n "$TTY" ]; then
    echo ""
    echo "  Modo de deploy:"
    echo "    1) tunnel  — home/WSL detras de un Cloudflare Tunnel (recomendado si no tenes IP publica)"
    echo "    2) vps     — servidor con Caddy HTTPS publico + panel admin via Tailscale"
    echo ""
    read -r -p "  Elegi [1/2]: " __m < "$TTY"
    case "${__m:-1}" in 2|vps) DEPLOY_MODE="vps" ;; *) DEPLOY_MODE="tunnel" ;; esac
  else
    DEPLOY_MODE="tunnel"
  fi
fi
[ "$DEPLOY_MODE" = "vps" ] || DEPLOY_MODE="tunnel"
ok "Modo: $DEPLOY_MODE"

COMPOSE_FILE="docker-compose.yml"
[ "$DEPLOY_MODE" = "tunnel" ] && COMPOSE_FILE="docker-compose.tunnel.yml"

# -- 6. Armar .env (interactivo, conservando lo existente) ------------------
# Cargar valores ya presentes en un .env restaurado para no re-preguntarlos.
if [ -f "$INSTALL_DIR/.env" ]; then set -a; . "$INSTALL_DIR/.env" 2>/dev/null || true; set +a; fi

# API_TOKEN — obligatorio, sin placeholder. Generar si falta.
if [ -z "${API_TOKEN:-}" ] || [ "${API_TOKEN}" = "generate-with-openssl-rand-hex-32" ]; then
  API_TOKEN="$(gen_token_hex32)"; info "API_TOKEN generado."
fi

# Claves de proveedor — al menos UNA es obligatoria (guard de cero-motores).
info "Claves de proveedores OCR (al menos una es obligatoria):"
prompt_secret OLLAMA_API_KEY   "  OLLAMA_API_KEY (Ollama Cloud; enter para omitir)" optional
prompt_secret OCR_SPACE_API_KEY "  OCR_SPACE_API_KEY (ocr.space; enter para omitir)" optional
if [ -z "${OLLAMA_API_KEY:-}${OCR_SPACE_API_KEY:-}" ]; then
  error "Se necesita al menos OLLAMA_API_KEY u OCR_SPACE_API_KEY — el servicio no arranca sin ningun motor."
fi

# Especifico por modo
DOMAIN="${DOMAIN:-}"; TAILSCALE_IP="${TAILSCALE_IP:-}"; TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
if [ "$DEPLOY_MODE" = "tunnel" ]; then
  echo ""
  info "Cloudflare Tunnel: crea un tunel 'ocr' en Zero Trust (Networks > Tunnels),"
  info "agrega el Public Hostname  ->  Service: HTTP  URL: caddy:80,  y pega su token."
  prompt_secret TUNNEL_TOKEN "  TUNNEL_TOKEN (del dashboard de Cloudflare)"
  [ -n "${TUNNEL_TOKEN:-}" ] || error "El modo tunnel necesita TUNNEL_TOKEN."
else
  prompt DOMAIN "  DOMAIN publico (ej: ocr.tudominio.dev)"
  prompt TAILSCALE_IP "  TAILSCALE_IP del server (para el panel admin)" "$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "${DOMAIN:-}" ] && [ -n "${TAILSCALE_IP:-}" ] || error "El modo vps necesita DOMAIN y TAILSCALE_IP."
fi

# Escribir .env final (600). Solo se persisten claves con valor.
umask 077
{
  echo "# Generado por install.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo now)"
  echo "API_TOKEN=${API_TOKEN}"
  [ -n "${OLLAMA_API_KEY:-}" ]   && echo "OLLAMA_API_KEY=${OLLAMA_API_KEY}"
  [ -n "${OCR_SPACE_API_KEY:-}" ] && echo "OCR_SPACE_API_KEY=${OCR_SPACE_API_KEY}"
  echo "APP_MEM_LIMIT=${APP_MEM_LIMIT:-1g}"
  echo "LOG_LEVEL=${LOG_LEVEL:-info}"
  echo "MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES:-10485760}"
  echo "MAX_QUEUE_DEPTH=${MAX_QUEUE_DEPTH:-10}"
  echo "JOB_STORE_MAX=${JOB_STORE_MAX:-500}"
  if [ "$DEPLOY_MODE" = "tunnel" ]; then
    echo "TUNNEL_TOKEN=${TUNNEL_TOKEN}"
  else
    echo "DOMAIN=${DOMAIN}"
    echo "TAILSCALE_IP=${TAILSCALE_IP}"
  fi
} > "$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"
ok ".env escrito (chmod 600)."

# -- 7. Build + up ----------------------------------------------------------
info "Construyendo e iniciando el stack ($COMPOSE_FILE)..."
compose -f "$COMPOSE_FILE" up -d --build || { compose -f "$COMPOSE_FILE" logs --tail 40 || true; error "El stack no arranco. Revisa los logs de arriba."; }

# -- 8. Health check --------------------------------------------------------
info "Esperando el healthcheck de ocr-app..."
RETRIES=0; MAX_RETRIES=30; HEALTHY=""
while [ $RETRIES -lt $MAX_RETRIES ]; do
  ST=$($DOCKER inspect --format='{{.State.Health.Status}}' ocr-app 2>/dev/null || echo "starting")
  [ "$ST" = "healthy" ] && { HEALTHY="1"; break; }
  RETRIES=$((RETRIES + 1)); sleep 2
done
if [ -z "$HEALTHY" ]; then
  warn "ocr-app no llego a 'healthy' en $((MAX_RETRIES*2))s. Ultimos logs:"
  compose -f "$COMPOSE_FILE" logs --tail 40 ocr-app || true
  error "Health check fallido. Revisa .env (claves de proveedor) y los logs."
fi
ok "ocr-app healthy."

# -- 9. Resultado -----------------------------------------------------------
echo ""
echo "=========================================="
echo -e "  ${GREEN}ocr-router instalado${NC} (modo: $DEPLOY_MODE)"
echo "=========================================="
echo "  Directorio : $INSTALL_DIR"
echo "  Compose    : $COMPOSE_FILE"
echo "  Token API  : guardado en .env (API_TOKEN) — usalo como 'Authorization: Bearer <token>'"
if [ "$DEPLOY_MODE" = "tunnel" ]; then
  echo "  API publica: https://<tu-hostname-del-tunel>/v1   (solo /v1 sale; el panel NO)"
  echo "  Panel admin: http://localhost:8780/   (solo desde esta maquina)"
  echo ""
  echo "  Falta 1 paso en Cloudflare si aun no lo hiciste:"
  echo "    Tunnel 'ocr' -> Public Hostname -> Service HTTP  URL: caddy:80"
else
  echo "  API publica: https://${DOMAIN}/v1"
  echo "  Panel admin: http://${TAILSCALE_IP}:8780/   (solo via tu tailnet)"
  echo ""
  echo "  DNS: crea un registro A  ${DOMAIN} -> IP publica del server."
fi
echo ""
echo "  Logs   : (cd $INSTALL_DIR && docker compose -f $COMPOSE_FILE logs -f)"
echo "  Estado : (cd $INSTALL_DIR && docker compose -f $COMPOSE_FILE ps)"
echo "  Parar  : (cd $INSTALL_DIR && docker compose -f $COMPOSE_FILE down)"
echo ""
echo "  Probar:  curl -s https://<host>/v1/health   (o http://localhost:8780/v1/health)"
echo ""
