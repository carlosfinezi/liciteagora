#!/bin/bash
# migrate-liciteagora.sh — Migra o sistema completo para nova VPS
#
# Pré-requisito: a nova VPS precisa acessar este servidor via SSH (chave ou senha)
#
# Opção A — rodar NA NOVA VPS:
#   scp root@217.216.85.37:/home/carlosfinezi/web/liciteagora.com.br/private/migrate-liciteagora.sh .
#   bash migrate-liciteagora.sh
#
# Opção B — rodar DAQUI para a nova VPS:
#   ssh root@NOVA_VPS 'bash -s' < migrate-liciteagora.sh

set -e

ORIGIN="217.216.85.37"
ORIGIN_PATH="/home/carlosfinezi/web/liciteagora.com.br/private"
DEST_PATH="/opt/liciteagora"

echo "============================================"
echo "  LiciteAgora — Migração para nova VPS"
echo "============================================"
echo ""

# 1. Node.js
echo "=== 1/7. Instalando Node.js 20 ==="
if command -v node &>/dev/null && [[ $(node -v) == v20* ]]; then
    echo "Node.js $(node -v) já instalado"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
apt-get install -y build-essential rsync nginx 2>/dev/null || true

# 2. Diretório
echo ""
echo "=== 2/7. Criando diretório ==="
mkdir -p $DEST_PATH

# 3. Rsync (o mais demorado — banco tem 7.4GB)
echo ""
echo "=== 3/7. Sincronizando arquivos do servidor origem ==="
echo "    Origem: root@$ORIGIN:$ORIGIN_PATH"
echo "    Destino: $DEST_PATH"
echo "    (banco de 7.4GB — pode demorar alguns minutos)"
echo ""
rsync -avz --progress \
  --exclude='node_modules' \
  --exclude='.electron-profile' \
  --exclude='.chrome-profile' \
  --exclude='recordings' \
  --exclude='electron-standalone' \
  --exclude='*.tar.gz' \
  --exclude='electron-standalone-*.zip' \
  --exclude='LiciteAgora-Browser-Win64.zip' \
  --exclude='LiciteAgora-Browser-win.zip' \
  --exclude='electron-standalone-v4.1-retoken.zip' \
  --exclude='server.js.backup*' \
  --exclude='server.js.stable*' \
  root@$ORIGIN:$ORIGIN_PATH/ $DEST_PATH/

# 4. Dependências
echo ""
echo "=== 4/7. Instalando dependências Node.js ==="
cd $DEST_PATH
npm install --production 2>&1 | tail -5

# 5. Nginx
echo ""
echo "=== 5/7. Configurando nginx ==="
cat > /etc/nginx/sites-available/liciteagora << 'NGINX'
server {
    listen 8080;
    server_name _;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/liciteagora /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx
echo "Nginx configurado na porta 8080"

# 6. Serviço systemd
echo ""
echo "=== 6/7. Criando serviço systemd ==="
cat > /etc/systemd/system/liciteagora.service << 'SVC'
[Unit]
Description=LiciteAgora Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/liciteagora
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVC
systemctl daemon-reload
systemctl enable liciteagora
systemctl start liciteagora
echo "Serviço liciteagora criado e iniciado"

# 7. Verificação
echo ""
echo "=== 7/7. Verificando ==="
sleep 3
if curl -sf http://localhost:3000/ > /dev/null 2>&1; then
    echo "✅ Servidor Node.js respondendo na porta 3000"
else
    echo "⚠️ Servidor não respondeu — verifique: journalctl -u liciteagora -n 50"
fi

if curl -sf http://localhost:8080/ > /dev/null 2>&1; then
    echo "✅ Nginx respondendo na porta 8080"
else
    echo "⚠️ Nginx não respondeu na 8080"
fi

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "============================================"
echo "  ✅ MIGRAÇÃO CONCLUÍDA"
echo "============================================"
echo ""
echo "  URL: http://$IP:8080"
echo "  Serviço: systemctl status liciteagora"
echo "  Logs: journalctl -u liciteagora -f"
echo ""
echo "  Latência para Comprasnet (SERPRO):"
for i in 1 2 3; do
    curl -s -o /dev/null -w "    TCP connect: %{time_connect}s\n" \
      https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-disputa/v1/datahorabrasilia 2>/dev/null
done
echo ""
echo "  Próximos passos:"
echo "  1. Apontar Electron para http://$IP:8080"
echo "  2. Acessar http://$IP:8080 e fazer login"
echo "  3. Testar blitz — latência deve ser ~17ms"
echo ""
