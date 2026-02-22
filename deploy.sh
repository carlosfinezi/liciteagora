#!/bin/bash
# Deploy LiciteAgora - pull código e reiniciar
# Rode como root: bash deploy.sh

set -e

cd /home/carlosfinezi/web/liciteagora.com.br/private

echo "=== Deploy LiciteAgora ==="

echo "[1] Puxando código..."
git pull

echo "[2] Reiniciando serviço..."
systemctl restart liciteagora

sleep 3

echo "[3] Verificando..."
if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
    echo "✅ Deploy OK — servidor respondendo"
else
    echo "❌ ERRO — verificando logs:"
    journalctl -u liciteagora --lines 20 --no-pager
fi
