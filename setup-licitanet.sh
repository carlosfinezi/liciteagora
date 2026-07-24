#!/bin/bash
# Fecha o coletor Licitanet em produção: persistência das rotas/túnel + serviço.
# Rodar como root: sudo bash setup-licitanet.sh
CONF=/etc/wireguard/wg-loja.conf
PRIV=/home/carlosfinezi/web/liciteagora.com.br/private

echo "== 1) Persistência: PostUp das rotas do licitanet no wg-loja =="
if grep -q '^PostUp' "$CONF"; then
  echo "   PostUp já existe (ok)."
else
  sed -i '/^Table = 100/a PostUp = ip route replace 52.223.56.206/32 dev %i; ip route replace 3.33.156.188/32 dev %i' "$CONF"
  echo "   PostUp adicionado."
fi

echo "== 2) wg-quick@wg-loja no boot =="
systemctl enable wg-quick@wg-loja 2>&1 | tail -1

echo "== 3) Serviço do coletor (a cada 30min pelo túnel) =="
cp "$PRIV/licitanet-collector.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now licitanet-collector.service
sleep 3

echo
echo "===== RESUMO ====="
echo "-- Address/PostUp no wg-loja.conf --"; grep -E '^Address|^PostUp' "$CONF"
echo "-- wg-quick@wg-loja habilitado? --"; systemctl is-enabled wg-quick@wg-loja 2>/dev/null
echo "-- rota licitanet --"; ip route get 52.223.56.206 | head -1
echo "-- coletor ativo? --"; systemctl is-active licitanet-collector.service 2>/dev/null
