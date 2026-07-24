#!/bin/bash
# provision-tenant-vhost.sh
#
# Cria vhost HestiaCP + SSL Let's Encrypt para um novo tenant do
# Licite Agora. Invocado pelo control-plane em background após o
# POST /api/admin/tenants ter criado o registro no control.db.
#
# Uso: ./provision-tenant-vhost.sh <slug>
#   ex: ./provision-tenant-vhost.sh empresaX
#
# Exit codes:
#   0  READY         — vhost + SSL OK
#   10 WAITING_DNS   — <slug>.liciteagora.app não resolve p/ SERVER_IP
#   20 ALREADY_OK    — vhost já existe e SSL emitido (idempotente)
#   1  FAILED        — qualquer outro erro

set -euo pipefail

# Inclui Hestia no PATH (systemd/child_process não tem por default).
export PATH="/usr/local/hestia/bin:$PATH"

SLUG="${1:?uso: $0 <slug>}"
DOMAIN="${SLUG}.liciteagora.app"

USER="${HESTIA_USER:-carlosfinezi}"
SERVER_IP="${SERVER_IP:-217.216.85.37}"
TEMPLATE="${HESTIA_TEMPLATE:-nodejs}"

log() { echo "[provision-vhost][$SLUG] $*"; }

# 1. DNS precheck — wildcard *.liciteagora.app já está configurado,
# então qualquer subdomínio deve resolver. Mas validamos mesmo assim
# porque às vezes demora propagar.
RESOLVED=$(dig +short "$DOMAIN" | head -1 || true)
if [ "$RESOLVED" != "$SERVER_IP" ]; then
  log "WAITING_DNS: resolve=${RESOLVED:-<vazio>} esperado=$SERVER_IP"
  exit 10
fi

# 2. Idempotência — se vhost já existe e SSL OK, encerra cedo.
if v-list-web-domain "$USER" "$DOMAIN" >/dev/null 2>&1; then
  SSL_OK=$(v-list-web-domain "$USER" "$DOMAIN" 2>/dev/null | awk '/^LETSENCRYPT:/ {print $2}')
  if [ "$SSL_OK" = "yes" ]; then
    log "ALREADY_OK: vhost + SSL já existem"
    exit 20
  fi
fi

# 3. Cria vhost se ainda não existe.
if ! v-list-web-domain "$USER" "$DOMAIN" >/dev/null 2>&1; then
  log "criando vhost"
  v-add-web-domain "$USER" "$DOMAIN" "$SERVER_IP" no
fi

# 4. Aplica template nodejs (proxy para 127.0.0.1:3000).
log "aplicando template $TEMPLATE"
v-change-web-domain-tpl "$USER" "$DOMAIN" "$TEMPLATE" >/dev/null

# 5. Remove alias automático www.<slug> se Hestia criou — não faz
# sentido para subdomínio de tenant.
v-delete-web-domain-alias "$USER" "$DOMAIN" "www.$DOMAIN" >/dev/null 2>&1 || true

# 6. Emite SSL Let's Encrypt (HTTP-01 challenge). Requer DNS resolvido.
if [ ! -f "/home/$USER/conf/web/$DOMAIN/ssl/$DOMAIN.pem" ]; then
  log "emitindo SSL Let's Encrypt"
  v-add-letsencrypt-domain "$USER" "$DOMAIN"
fi

# 7. Força HTTPS (redirect :80 → :443).
v-add-web-domain-ssl-force "$USER" "$DOMAIN" >/dev/null 2>&1 || true

log "READY: https://$DOMAIN/"
exit 0
