#!/bin/bash
# Rotina de teste (2 dias) — registra saúde do Bearer a cada 15min. Auto-desliga em 1783909701.
FIM=1783909701
[ "$(date +%s)" -ge "$FIM" ] && exit 0
cd /home/carlosfinezi/web/liciteagora.com.br/private
/usr/bin/node bearer-health.js 1bit 6 line >> bearer-watch.log 2>&1
