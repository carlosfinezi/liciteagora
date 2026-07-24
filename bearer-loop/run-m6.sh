#!/bin/bash
. "$(dirname "$0")/secrets.env" 2>/dev/null || true
# M6: GridTask in-page + SwiftShader (renderizador Google, assinatura de pixel != llvmpipe) + PAT_DISABLE.
cd /home/carlosfinezi/web/liciteagora.com.br/private || exit 1
export HOME=/home/carlosfinezi
export USE_2CAPTCHA_GRID=1 SWIFTSHADER=1 PAT_DISABLE=1
export HEADFUL=1 SERVICE=1 DELIVER=1 TENANT=1bit ROTATE_MIN=90 FULLLOGIN_MAX_FAILS=4
LOG=/home/carlosfinezi/web/liciteagora.com.br/private/bearer-loop/M6.log
while [ ! -f /tmp/stop-m6 ]; do
  echo "[wrapper $(date -u +%H:%M:%S)] === iniciando serviço (M6 GridTask+SwiftShader+PAT_DISABLE) ===" >> "$LOG"
  xvfb-run -a /usr/bin/node govbr-bearer-service.js >> "$LOG" 2>&1
  echo "[wrapper $(date -u +%H:%M:%S)] serviço saiu (rc=$?); reinício em 15s" >> "$LOG"
  sleep 15
done
echo "[wrapper $(date -u +%H:%M:%S)] === STOP sentinel — encerrando M6 ===" >> "$LOG"
