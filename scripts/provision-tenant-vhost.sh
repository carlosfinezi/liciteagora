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

# 2. Idempotência — se vhost já existe, SSL OK e sem proxy template,
# encerra cedo. O proxy entra na condição de propósito: um vhost com SSL
# válido mas com proxy `default` está quebrado (ver passo 4b), e sair
# cedo aqui deixaria o tenant fora do ar sem conserto.
if v-list-web-domain "$USER" "$DOMAIN" >/dev/null 2>&1; then
  INFO=$(v-list-web-domain "$USER" "$DOMAIN" 2>/dev/null)
  SSL_OK=$(awk '/^LETSENCRYPT:/ {print $2}' <<<"$INFO")
  PROXY_TPL=$(awk '/^PROXY:/ {print $2}' <<<"$INFO")
  if [ "$SSL_OK" = "yes" ] && [ -z "$PROXY_TPL" ]; then
    log "ALREADY_OK: vhost + SSL já existem, sem proxy template"
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

# 4b. Remove o proxy template que o v-add-web-domain atribui sozinho.
#
# Desde que o upgrade 1.10.2 ligou PROXY_SYSTEM='nginx' (2026-08-15),
# todo domínio novo nasce com proxy `default`, e é o template de PROXY
# que gera o nginx.ssl.conf — o `v-change-web-domain-tpl` acima nunca
# chega ao arquivo final. O `default` faz proxy_pass https://<ip>:443,
# isto é, devolve a requisição ao próprio nginx: laço infinito, header
# X-Forwarded-For crescendo a cada salto, até estourar o buffer → 400
# "Request Header Or Cookie Too Large". Foi o que quebrou o crsolucoes
# em 2026-08-27 e, em agosto, os 27 domínios do incidente do loop.
#
# PROXY='' é o estado dos demais tenants e o que sobreviveu àquele
# incidente. O delete PRECISA ser seguido do rebuild: sozinho ele apaga
# o vhost em vez de regenerá-lo, e o domínio sai do ar.
if v-list-web-domain "$USER" "$DOMAIN" 2>/dev/null | awk '/^PROXY:/ {print $2}' | grep -q .; then
  log "removendo proxy template herdado do Hestia"
  v-delete-web-domain-proxy "$USER" "$DOMAIN" >/dev/null
  v-rebuild-web-domain "$USER" "$DOMAIN" >/dev/null
fi

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

# 8. Verificação — o vhost tem de encaminhar para a app local. Sem esta
# checagem o script já gravou READY no control.db uma vez com o vhost em
# laço de proxy, e o tenant só apareceu quebrado no primeiro acesso.
SSL_CONF="/home/$USER/conf/web/$DOMAIN/nginx.ssl.conf"
if ! grep -q 'proxy_pass http://127.0.0.1:3000' "$SSL_CONF" 2>/dev/null; then
  log "FAILED: $SSL_CONF nao encaminha para 127.0.0.1:3000 — template de proxy errado"
  exit 1
fi

log "READY: https://$DOMAIN/"
exit 0
