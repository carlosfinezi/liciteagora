#!/bin/bash
# verify-servico.sh — o verify fora da sessão. Chamado pelo
# liciteagora-verify.service; roda também à mão, com o mesmo resultado.
#
# Grava em $VERIFY_SAIDA (padrão /var/lib/liciteagora-verify):
#   rodando.log / rodando.json  enquanto a rodada acontece (o json diz "rodando")
#   ultimo.log  / ultimo.json   a última rodada que terminou
#   anterior.*                  a de antes dela
#   tempos-semente.json         tempos por etapa para ordenar o paralelo quando
#                               ainda não há rodada anterior
# Quem volta depois lê o ultimo.json, e não precisa estar olhando quando acaba.
#
# Argumentos extras vão direto ao verify.js (ex.: --rapido arquivo.js).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
SAIDA="${VERIFY_SAIDA:-/var/lib/liciteagora-verify}"
mkdir -p "$SAIDA"

TEMPOS="$SAIDA/ultimo.json"
[ -f "$TEMPOS" ] || TEMPOS="$SAIDA/tempos-semente.json"

node scripts/verify.js --paralelo "${VERIFY_PARALELO:-4}" --json "$SAIDA/rodando.json" --tempos "$TEMPOS" "$@" 2>&1 \
  | gawk '{ print strftime("%F %T"), $0; fflush() }' > "$SAIDA/rodando.log"
codigo=${PIPESTATUS[0]}

if [ "$codigo" -eq 3 ]; then
  # Outra rodada tem a trava: nada desta vale como resultado.
  echo "verify-servico: outra rodada em andamento; nada gravado como resultado" >&2
  exit 3
fi

# O node pode morrer antes de gravar o fim (falta de memória, kill): o json não
# pode continuar dizendo "rodando" para sempre.
if [ -f "$SAIDA/rodando.json" ]; then
  CODIGO="$codigo" ARQ="$SAIDA/rodando.json" node -e '
    const fs = require("fs"); const j = JSON.parse(fs.readFileSync(process.env.ARQ, "utf8"));
    if (j.estado === "rodando") { j.estado = "morreu"; j.fim = new Date().toISOString(); j.codigo = Number(process.env.CODIGO); }
    fs.writeFileSync(process.env.ARQ, JSON.stringify(j, null, 2));'
fi

for f in log json; do
  [ -f "$SAIDA/ultimo.$f" ] && mv -f "$SAIDA/ultimo.$f" "$SAIDA/anterior.$f"
  [ -f "$SAIDA/rodando.$f" ] && mv -f "$SAIDA/rodando.$f" "$SAIDA/ultimo.$f"
done
exit "$codigo"
