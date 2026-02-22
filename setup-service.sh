#!/bin/bash
# Setup LiciteAgora como serviço systemd
# Rode como root: bash setup-service.sh

set -e

echo "=== Instalando serviço LiciteAgora ==="

# 1. Matar processo Node existente
echo "[1] Parando processos existentes..."
pkill -f "node server.js" 2>/dev/null || true
sleep 2

# 2. Copiar service file
echo "[2] Instalando serviço systemd..."
cp /home/carlosfinezi/web/liciteagora.com.br/private/liciteagora.service /etc/systemd/system/liciteagora.service

# 3. Recarregar systemd
echo "[3] Recarregando systemd..."
systemctl daemon-reload

# 4. Habilitar e iniciar
echo "[4] Habilitando e iniciando serviço..."
systemctl enable liciteagora
systemctl start liciteagora

# 5. Verificar
sleep 3
echo ""
echo "=== Status ==="
systemctl status liciteagora --no-pager -l | head -20
echo ""

# 6. Testar
echo "=== Teste ==="
curl -s http://localhost:3000/api/health 2>/dev/null && echo " <- Health OK" || echo "ERRO: servidor não respondeu"
echo ""

echo "=== Comandos úteis ==="
echo "  systemctl status liciteagora    # Ver status"
echo "  systemctl restart liciteagora   # Reiniciar"
echo "  systemctl stop liciteagora      # Parar"
echo "  journalctl -u liciteagora -f    # Ver logs em tempo real"
echo "  tail -f /home/carlosfinezi/web/liciteagora.com.br/private/server.log  # Log arquivo"
echo ""
echo "O servidor agora reinicia automaticamente se crashar!"
