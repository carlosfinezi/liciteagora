#!/bin/bash
# M1: NopeCHA extensão + restart agressivo. Cada saída = nova chance de pegar desafio fácil.
# Uma vez logado, o modo SERVICE fica vivo (reauth sustenta) e o while só espera.
cd /home/carlosfinezi/web/liciteagora.com.br/private || exit 1
export HOME=/home/carlosfinezi
export USE_EXTENSION=1 SERVICE=1 DELIVER=1 TENANT=1bit NOPECHA_KEY=I-1CNJHEXNNA95 ROTATE_MIN=90 FULLLOGIN_MAX_FAILS=3
LOG=/home/carlosfinezi/web/liciteagora.com.br/private/bearer-loop/M1.log
while [ ! -f /tmp/stop-m1 ]; do
  echo "[wrapper $(date -u +%H:%M:%S)] === iniciando serviço (M1 NopeCHA ext) ===" >> "$LOG"
  xvfb-run -a /usr/bin/node govbr-bearer-service.js >> "$LOG" 2>&1
  echo "[wrapper $(date -u +%H:%M:%S)] serviço saiu (rc=$?); reinício em 15s" >> "$LOG"
  sleep 15
done
echo "[wrapper $(date -u +%H:%M:%S)] === STOP sentinel — encerrando M1 ===" >> "$LOG"
