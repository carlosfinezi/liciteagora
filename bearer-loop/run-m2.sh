#!/bin/bash
. "$(dirname "$0")/secrets.env" 2>/dev/null || true
# M2: 2Captcha GridTask in-page (worker humano decide os quadros, nós clicamos no
# widget real) + WebGL spoof. Solve verdadeiro no nosso browser (mantém PAT).
cd /home/carlosfinezi/web/liciteagora.com.br/private || exit 1
export HOME=/home/carlosfinezi
export USE_2CAPTCHA_GRID=1 WEBGL_SPOOF=1
export HEADFUL=1 SERVICE=1 DELIVER=1 TENANT=1bit ROTATE_MIN=90 FULLLOGIN_MAX_FAILS=4
LOG=/home/carlosfinezi/web/liciteagora.com.br/private/bearer-loop/M2.log
while [ ! -f /tmp/stop-m2 ]; do
  echo "[wrapper $(date -u +%H:%M:%S)] === iniciando serviço (M2 GridTask+spoof) ===" >> "$LOG"
  xvfb-run -a /usr/bin/node govbr-bearer-service.js >> "$LOG" 2>&1
  echo "[wrapper $(date -u +%H:%M:%S)] serviço saiu (rc=$?); reinício em 15s" >> "$LOG"
  sleep 15
done
echo "[wrapper $(date -u +%H:%M:%S)] === STOP sentinel — encerrando M2 ===" >> "$LOG"
