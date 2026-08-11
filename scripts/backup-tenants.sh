#!/usr/bin/env bash
#
# backup-tenants.sh — backup dos bancos do LiciteAgora.
#
# Passo 1 do "fechamento" (ver CLAUDE.md). Também serve sozinho, antes de
# qualquer mexida em schema.
#
# Uso:
#   scripts/backup-tenants.sh                  # rotina: tenants + control + catálogo seletivo
#   scripts/backup-tenants.sh --catalogo-full  # + pg_dump inteiro do catálogo (54 GB, horas)
#
# O --catalogo-full NUNCA entra na rotina — é chamada manual, sob demanda.
#
# Nada aqui apaga: nem banco, nem backup antigo. Restaurar não é rotina.
# Roda como root (os DBs são do carlosfinezi; o catálogo sai via `sudo -u postgres`).

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$RAIZ/backups/db/$(date +%Y-%m-%d-%H%M)"
DONO="carlosfinezi:carlosfinezi"
CATALOGO_FULL=0
[ "${1:-}" = "--catalogo-full" ] && CATALOGO_FULL=1

mkdir -p "$DEST"
echo "destino: $DEST"
echo

# --- SQLite: um pncp.db por tenant + control.db ------------------------------
# `.backup` é backup online do próprio SQLite: consistente mesmo com WAL ligado
# e escrita concorrente. `cp`/`rsync` de .db vivo CORROMPE (o -wal fica para
# trás) — não trocar por cópia de arquivo.

echo "[sqlite] tenants"
for db in "$RAIZ"/data/tenants/*/pncp.db; do
  tenant="$(basename "$(dirname "$db")")"
  sqlite3 "$db" ".backup '$DEST/$tenant.db'"
  echo "  ok  $tenant.db  $(du -h "$DEST/$tenant.db" | cut -f1)"
done

sqlite3 "$RAIZ/data/control.db" ".backup '$DEST/control.db'"
echo "  ok  control.db  $(du -h "$DEST/control.db" | cut -f1)"
echo

# --- Catálogo (PostgreSQL liciteagora_catalog) -------------------------------
# Dump seletivo: só o que NÃO volta do PNCP de graça — cursores dos backfills,
# derivados de IA, marcas do coletor Licitanet e a marca extraída dos itens.
# licitacoes/itens/resultados_bi ficam de fora de propósito (ver CLAUDE.md).

TABELAS=(
  catalog_sync_state
  bi_item_classificacao_ia
  bi_item_sugestao_produto
  bi_sugestao_catalogo
  bi_grupo_item
  bi_grupo_membership_meta
  marca_portal_backfill
  marca_portal_fila
  fiscal_classificacao_cache
)
ARGS=()
for t in "${TABELAS[@]}"; do ARGS+=(-t "$t"); done

echo "[catálogo] dump seletivo"
sudo -u postgres pg_dump -Fc -d liciteagora_catalog "${ARGS[@]}" > "$DEST/catalogo-seletivo.dump"
echo "  ok  catalogo-seletivo.dump  $(du -h "$DEST/catalogo-seletivo.dump" | cut -f1)"

sudo -u postgres psql -d liciteagora_catalog -q -c \
  "\copy (SELECT id, \"marcaExtraida\", \"marcaConfianca\", \"marcaExtraidaEm\" FROM itens WHERE \"marcaExtraida\" IS NOT NULL) TO STDOUT WITH CSV HEADER" \
  | gzip > "$DEST/itens-marca.csv.gz"
echo "  ok  itens-marca.csv.gz  $(du -h "$DEST/itens-marca.csv.gz" | cut -f1)"
echo

if [ "$CATALOGO_FULL" = 1 ]; then
  echo "[catálogo] dump COMPLETO — 54 GB de origem, pode levar horas"
  sudo -u postgres pg_dump -Fc -d liciteagora_catalog > "$DEST/catalogo-full.dump"
  echo "  ok  catalogo-full.dump  $(du -h "$DEST/catalogo-full.dump" | cut -f1)"
  echo
fi

chown -R "$DONO" "$DEST"

echo "total desta rodada: $(du -sh "$DEST" | cut -f1)"
echo "conjuntos em backups/db (nada é apagado automaticamente):"
du -sh "$RAIZ"/backups/db/*/ 2>/dev/null | sort -k2
echo "livre em disco: $(df -h "$RAIZ" | awk 'NR==2 {print $4}')"
