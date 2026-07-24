#!/bin/bash
. "$(dirname "$0")/secrets.env" 2>/dev/null || true
# M3: GridTask in-page + WebGL spoof + puppeteer-extra-plugin-stealth (evasões completas).
# Teste limpo de "stealth SEM proxy" no servidor headless.
cd /home/carlosfinezi/web/liciteagora.com.br/private || exit 1
export HOME=/home/carlosfinezi
export USE_2CAPTCHA_GRID=1 USE_STEALTH=1 WEBGL_SPOOF=1
export HEADFUL=1 SERVICE=1 DELIVER=1 TENANT=1bit ROTATE_MIN=90 FULLLOGIN_MAX_FAILS=4
LOG=/home/carlosfinezi/web/liciteagora.com.br/private/bearer-loop/M3.log
while [ ! -f /tmp/stop-m3 ]; do
  echo "[wrapper $(date -u +%H:%M:%S)] === iniciando serviço (M3 GridTask+spoof+stealth) ===" >> "$LOG"
  xvfb-run -a /usr/bin/node govbr-bearer-service.js >> "$LOG" 2>&1
  echo "[wrapper $(date -u +%H:%M:%S)] serviço saiu (rc=$?); reinício em 15s" >> "$LOG"
  sleep 15
done
echo "[wrapper $(date -u +%H:%M:%S)] === STOP sentinel — encerrando M3 ===" >> "$LOG"
