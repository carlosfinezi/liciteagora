#!/usr/bin/env bash
#
# Encerra um tenant de demonstração: devolve o banco ao estado combinado,
# devolve o nome original e põe o tenant em SUSPENDED.
#
# É o encerramento dos DOIS tenants de demonstração — o slug é o argumento:
#
#   sudo bash scripts/encerrar-demo.sh sandbox --sim
#   sudo bash scripts/encerrar-demo.sh demo2 --sim
#
# Uma lógica só, e não um script por tenant, para não haver duas cópias que
# divergem com o tempo. O que muda de um para o outro mora em
# backups/<slug>/: o banco de referência e o nome original.
#
# QUAL BANCO ELE RESTAURA
#
#   Por padrão, backups/<slug>/<slug>-pncp-base.db — o tenant vazio, do jeito
#   que nasceu. Se a sua sessão tirou um backup ao começar (e deveria), passe
#   esse arquivo, porque ele tem as migrações que rodaram desde então:
#
#     sudo bash scripts/encerrar-demo.sh sandbox --sim \
#       --pncp backups/video-servicos/sandbox-pncp-antes-servicos.db
#
#   Restaurar um banco antigo demais deixa o servidor vivo batendo em
#   "no such table": as migrações de cada boot criam tabela, e o arquivo de
#   duas semanas atrás não as tem.
#
# A GUARDA
#
#   Sem --sim ele não escreve nada: lista o que o banco vivo tem hoje e para.
#   Leia essa lista. Se houver retrato de outra sessão ali dentro, NÃO encerre
#   — o tenant ACTIVE é de quem o ativou.
#
set -euo pipefail

RAIZ=/home/carlosfinezi/web/liciteagora.com.br/private
CTL="$RAIZ/data/control.db"
ASSINA="$RAIZ/backups/sandbox-video-2026-09-23/assinatura-tabelas.sh"
comoDono() { runuser -u carlosfinezi -- "$@"; }

SLUG=""; PNCP=""; CONFIRMA=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sim)   CONFIRMA=1; shift ;;
    --pncp)  PNCP="${2:?--pncp pede um arquivo}"; shift 2 ;;
    --*)     echo "argumento desconhecido: $1" >&2; exit 2 ;;
    *)       [ -z "$SLUG" ] || { echo "slug já informado: $SLUG" >&2; exit 2; }; SLUG="$1"; shift ;;
  esac
done
[ -n "$SLUG" ] || { echo "uso: $0 <slug> [--pncp <arquivo>] --sim" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "rode como root (sudo)"; exit 1; }

BASE="$RAIZ/backups/$SLUG"
DB="$RAIZ/data/tenants/$SLUG/pncp.db"
PNCP="${PNCP:-$BASE/$SLUG-pncp-base.db}"
[ -f "$BASE/nome-base.txt" ] || { echo "falta $BASE/nome-base.txt — este tenant não é de demonstração?" >&2; exit 2; }
NOME="$(cat "$BASE/nome-base.txt")"
[ -f "$DB" ]   || { echo "não achei o banco do tenant: $DB" >&2; exit 2; }
[ -f "$PNCP" ] || { echo "não achei o banco de referência: $PNCP" >&2; exit 2; }
[ "$(comoDono sqlite3 -readonly "$PNCP" 'PRAGMA integrity_check')" = ok ] \
  || { echo "banco de referência com problema: $PNCP" >&2; exit 1; }

echo "tenant:     $SLUG"
echo "status:     $(comoDono sqlite3 -readonly "$CTL" "SELECT status || ' | ' || name FROM tenants WHERE slug='$SLUG'")"
echo "restaurar:  ${PNCP#$RAIZ/}"
echo "nome volta: $NOME"
echo
echo "o que o banco vivo tem hoje, e que será PERDIDO:"
comoDono sqlite3 -readonly "$DB" "
  SELECT '  pessoas:            ' || COUNT(*) FROM pessoas
  UNION ALL SELECT '  contratos:          ' || COUNT(*) FROM contratos
  UNION ALL SELECT '  ordens de serviço:  ' || COUNT(*) FROM os_ordens
  UNION ALL SELECT '  recorrências:       ' || COUNT(*) FROM nfse_recorrencias
  UNION ALL SELECT '  contas a receber:   ' || COUNT(*) FROM contas_a_receber
  UNION ALL SELECT '  contas a pagar:     ' || COUNT(*) FROM contas_a_pagar
  UNION ALL SELECT '  produtos:           ' || COUNT(*) FROM produtos
  UNION ALL SELECT '  usuários:           ' || COUNT(*) FROM users;" 2>/dev/null || echo "  (não consegui contar — banco em migração?)"

if [ "$CONFIRMA" != 1 ]; then
  echo
  echo "nada foi escrito. Confira a lista acima e, se for seu, repita com --sim."
  exit 0
fi

echo
echo "[1/3] restaurando o banco do tenant"
comoDono sqlite3 "$DB" ".timeout 20000" ".restore '$PNCP'"

echo "[2/3] devolvendo nome e status no control.db"
comoDono sqlite3 "$CTL" ".timeout 20000" "
  BEGIN;
  INSERT INTO tenant_audit (tenant_id, action, actor, payload, at)
    SELECT id, 'SET_STATUS', 'scripts/encerrar-demo.sh $SLUG',
           json_object('from', status, 'to', 'SUSPENDED', 'nomeDe', name, 'nomePara', '$NOME'),
           CAST(strftime('%s','now') AS INTEGER) * 1000
      FROM tenants WHERE slug = '$SLUG';
  UPDATE tenants SET name = '$NOME', status = 'SUSPENDED',
                     suspended_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE slug = '$SLUG';
  COMMIT;"

echo "[3/3] conferindo"
if [ -x "$ASSINA" ]; then
  diff <(comoDono "$ASSINA" "$PNCP") <(comoDono "$ASSINA" "$DB") >/dev/null \
    && echo "  banco idêntico ao de referência" \
    || { echo "  ATENÇÃO: o banco difere do de referência"; exit 1; }
fi
echo "  status: $(comoDono sqlite3 -readonly "$CTL" "SELECT status || ' | ' || name FROM tenants WHERE slug='$SLUG'")"
echo "  HTTP:   $(curl -s -o /dev/null -w '%{http_code}' -H "Host: $SLUG.liciteagora.app" -H 'X-Forwarded-Proto: https' http://localhost:3000/api/tenant-atual) (esperado 402)"
echo "$SLUG encerrado."
