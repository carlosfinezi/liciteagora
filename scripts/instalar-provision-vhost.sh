#!/bin/bash
# instalar-provision-vhost.sh — deixa o provisionamento de vhost rodar como
# root sem senha, com segurança.
#
# Uso, como root, uma vez — e de novo toda vez que o
# scripts/provision-tenant-vhost.sh mudar:
#
#   sudo bash /home/carlosfinezi/web/liciteagora.com.br/private/scripts/instalar-provision-vhost.sh
#
# O que instala, e por que é assim:
#
# 1. Uma CÓPIA do provision-tenant-vhost.sh em
#    /usr/local/sbin/liciteagora-provision-vhost, de posse do root, sem
#    escrita para mais ninguém. A regra do sudo aponta para ela, e não para o
#    script do projeto: uma regra NOPASSWD sobre um arquivo que o usuário
#    edita libera qualquer comando como root — bastaria trocar o conteúdo.
#    Era assim até 2026-09-24.
#
# 2. A regra em /etc/sudoers.d/liciteagora-provision liberando, sem senha e
#    só para o carlosfinezi, EXATAMENTE a cópia. A regra passa pelo visudo
#    ANTES de ser gravada: um sudoers com erro de sintaxe tranca o sudo
#    inteiro da máquina.
#
# Antes de instalar, mostra o diff entre a cópia em uso e o fonte: quem roda
# isto como root está assinando o conteúdo do fonte, que o carlosfinezi pode
# editar. Leia o diff.
#
# Reinstalar é rodar de novo: o script é idempotente.

set -euo pipefail

USUARIO="carlosfinezi"
FONTE="/home/$USUARIO/web/liciteagora.com.br/private/scripts/provision-tenant-vhost.sh"
COPIA="/usr/local/sbin/liciteagora-provision-vhost"
REGRA="/etc/sudoers.d/liciteagora-provision"

log() { echo "[instalar-provision-vhost] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "rode como root: sudo bash $0"; exit 1; }
[ -f "$FONTE" ] || { echo "não achei $FONTE"; exit 1; }
id "$USUARIO" >/dev/null 2>&1 || { echo "o usuário $USUARIO não existe"; exit 1; }

# O fonte tem de ser bash válido antes de virar comando de root.
bash -n "$FONTE" || { echo "o $FONTE não passa no bash -n; não instalei"; exit 1; }

# 0. O que muda em relação à cópia em uso.
if [ -f "$COPIA" ]; then
  if cmp -s "$COPIA" "$FONTE"; then
    log "a cópia em uso já é igual ao fonte"
  else
    log "diferença entre a cópia em uso e o fonte:"
    diff -u "$COPIA" "$FONTE" || true
  fi
else
  log "primeira instalação: ainda não há cópia em $COPIA"
fi

# 1. A cópia: root:root, 755, e o diretório dela também é do root.
install -o root -g root -m 755 "$FONTE" "$COPIA"
DONO=$(stat -c '%U %a' "$COPIA")
[ "$DONO" = "root 755" ] || { echo "a cópia ficou com $DONO, esperava root 755"; exit 1; }
DIR_DONO=$(stat -c '%U %a' "$(dirname "$COPIA")")
[ "$DIR_DONO" = "root 755" ] || { echo "$(dirname "$COPIA") está com $DIR_DONO, esperava root 755"; exit 1; }
log "cópia instalada em $COPIA (sha256 $(sha256sum "$COPIA" | cut -d' ' -f1))"

# 2. A regra, conferida pelo visudo antes de ir para o lugar.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
cat > "$TMP" <<EOF
# Provisionamento de vhost/SSL de tenant do LiciteAgora, sem senha, para o
# worker HTTP. Instalado por scripts/instalar-provision-vhost.sh. SÓ a cópia
# de posse do root; nunca o script do projeto, que o $USUARIO edita.
#
# O script chama os v-* do Hestia, que exigem ler
# /usr/local/hestia/conf/hestia.conf (acessível só para root).
$USUARIO ALL=(root) NOPASSWD: $COPIA
EOF
visudo -cf "$TMP" >/dev/null || { echo "a regra não passou no visudo; não gravei"; exit 1; }
install -o root -g root -m 0440 "$TMP" "$REGRA"
visudo -c >/dev/null || { echo "o sudoers ficou inválido depois de gravar $REGRA — REMOVA-O: rm $REGRA"; exit 1; }
log "regra gravada em $REGRA"

# 3. Nenhuma regra pode continuar apontando para o script do projeto.
if grep -rn "$FONTE" /etc/sudoers /etc/sudoers.d/ 2>/dev/null; then
  echo "ainda há regra do sudo apontando para $FONTE (acima); remova-a"
  exit 1
fi

# 4. Prova, do ponto de vista do usuário: o sudo tem de listar a cópia.
log "o que o sudo libera para $USUARIO sem senha:"
sudo -l -U "$USUARIO" | grep -E 'NOPASSWD' || { echo "o sudo -l não mostra a regra"; exit 1; }
sudo -l -U "$USUARIO" | grep -q "$COPIA" || { echo "o sudo -l não mostra $COPIA"; exit 1; }
log "pronto. Como $USUARIO, sem senha: sudo -n $COPIA <slug>"
