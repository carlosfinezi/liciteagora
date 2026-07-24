#!/bin/bash
# Verificador de validade contínua do Bearer.
# Uso: verifier.sh <LOG> <METHOD> <PROC_PATTERN>
# Sucesso = 3600s de streak contínuo (entregas < 660s de gap + processo vivo).
LOG="$1"; METHOD="$2"; PROC="$3"
D=/home/carlosfinezi/web/liciteagora.com.br/private/bearer-loop
OUT="$D/verifier.out"
LAST_COUNT=0; LAST_DELIVER=0; STREAK_START=0; MAX=0; prev_valid=0; tick=0
echo "[verifier $(date -u +%H:%M:%S)] === iniciado method=$METHOD log=$(basename "$LOG") ===" >> "$OUT"
while [ ! -f /tmp/stop-verifier ]; do
  now=$(date +%s)
  count=$(grep -cE "entrega /api/auth/token|re-mint OK|Bearer válido entregue" "$LOG" 2>/dev/null)
  [ -z "$count" ] && count=0
  if [ "$count" -gt "$LAST_COUNT" ]; then LAST_DELIVER=$now; LAST_COUNT=$count; fi
  alive=$(pgrep -x node | while read p; do tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | grep -q "$PROC" && echo "$p" && break; done)
  valid=0
  if [ -n "$alive" ] && [ "$LAST_DELIVER" -gt 0 ] && [ $((now - LAST_DELIVER)) -lt 660 ]; then valid=1; fi
  if [ "$valid" = "1" ]; then
    if [ "$prev_valid" = "0" ]; then STREAK_START=$LAST_DELIVER; echo "[verifier $(date -u +%H:%M:%S)] ▶ streak INICIOU $METHOD (deliveries=$count)" >> "$OUT"; fi
    streak=$((now - STREAK_START))
    [ "$streak" -gt "$MAX" ] && MAX=$streak
    if [ "$streak" -ge 3600 ]; then
      echo "[verifier $(date -u +%H:%M:%S)] ✅✅✅ SUCESSO $METHOD streak=${streak}s (>=3600). Bearer valido 60min ininterruptos!" >> "$OUT"
      touch /tmp/bearer-loop-success; echo "$METHOD" > /tmp/bearer-loop-winner; break
    fi
  else
    if [ "$prev_valid" = "1" ]; then echo "[verifier $(date -u +%H:%M:%S)] ⚠ QUEDA $METHOD apos streak=$((now-STREAK_START))s (deliveries=$count alive=${alive:+sim} lastDeliverAge=$([ $LAST_DELIVER -gt 0 ] && echo $((now-LAST_DELIVER)) || echo NA)s)" >> "$OUT"; fi
    STREAK_START=0
  fi
  prev_valid=$valid
  tick=$((tick+1))
  if [ $((tick % 4)) -eq 0 ]; then
    cs=$([ "$STREAK_START" -gt 0 ] && echo $((now-STREAK_START)) || echo 0)
    echo "[verifier $(date -u +%H:%M:%S)] $METHOD valid=$valid streak=${cs}s max=${MAX}s deliveries=$count alive=${alive:+sim}" >> "$OUT"
  fi
  sleep 30
done
echo "[verifier $(date -u +%H:%M:%S)] === encerrado method=$METHOD MAX_STREAK=${MAX}s ===" >> "$OUT"
