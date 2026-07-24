#!/bin/bash
# merge-vps-catalog.sh
#
# Puxa o catalog-vps.db da VPS auxiliar (62.146.227.189) e mescla no
# catalog.db do servidor principal. Roda via cron a cada 1h.
#
# Fluxo:
#   1. SSH na VPS: PRAGMA wal_checkpoint(TRUNCATE) → consolida WAL no main
#   2. rsync apenas o main DB (não WAL/SHM)
#   3. ATTACH local + INSERT OR IGNORE em licitacoes e itens
#   4. Log do que foi mergeado
#
# Dedupe: numeroControlePNCP UNIQUE em licitacoes garante. Itens não tem
# UNIQUE; check NOT EXISTS (licitacaoId, numeroItem) antes do INSERT.
#
# Idempotente: pode rodar múltiplas vezes seguidas sem efeitos colaterais.

set -e

LOCAL_TMP="/tmp/vps-catalog"
TARGET_DB="/home/carlosfinezi/web/liciteagora.com.br/private/data/catalog.db"
LOG="/home/carlosfinezi/web/liciteagora.com.br/private/server.log"

# 3 VPSs auxiliares — cada entry: "rótulo|usuário@ip|chave_ssh"
VPSS=(
  "hostinger|carlosfinezi@62.146.227.189|/tmp/uploads-1bit/id_homologacao"
  "contabo1|cloud-user@147.93.147.40|/tmp/uploads-1bit/contabo_ssh"
  "contabo2|cloud-user@147.93.147.183|/tmp/uploads-1bit/contabo_ssh"
)

mkdir -p "$LOCAL_TMP"

log() { echo "[merge-vps $(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "Iniciando merge dos ${#VPSS[@]} VPSs → principal"

# Loop pelos VPSs: cada um faz checkpoint+rsync+merge
for entry in "${VPSS[@]}"; do
  IFS='|' read -r ROTULO VPS_HOST SSH_KEY <<< "$entry"
  SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o BatchMode=yes -o ConnectTimeout=15"
  LOCAL_DB="$LOCAL_TMP/catalog-$ROTULO.db"

  log "--- [$ROTULO] $VPS_HOST ---"

  # 1. SQLite .backup no VPS → snapshot consistente mesmo com writes ativos.
  #    Rsync direto do main DB durante escrita produz "disk image is malformed".
  #    O .backup API do SQLite serializa páginas garantindo consistência.
  ssh $SSH_OPTS "$VPS_HOST" 'sqlite3 ~/vps-sync/catalog-vps.db ".timeout 30000" ".backup /tmp/catalog-snap.db" 2>&1 || echo "backup falhou"'

  # 2. Stats do snapshot (não do main que pode estar mudando)
  VPS_STATS=$(ssh $SSH_OPTS "$VPS_HOST" 'sqlite3 /tmp/catalog-snap.db "SELECT COUNT(*)||\" lic / \"||(SELECT COUNT(*) FROM itens)||\" itens\" FROM licitacoes" 2>/dev/null')
  log "  estado VPS (snapshot): $VPS_STATS"

  # 3. Rsync do snapshot
  if ! rsync -az --timeout=120 -e "ssh $SSH_OPTS" \
    "$VPS_HOST:/tmp/catalog-snap.db" \
    "$LOCAL_DB" 2>>"$LOG"; then
    log "  rsync FALHOU — pulando esse VPS"
    ssh $SSH_OPTS "$VPS_HOST" 'rm -f /tmp/catalog-snap.db' 2>/dev/null || true
    continue
  fi

  # Cleanup do snapshot remoto (libera disco da VPS)
  ssh $SSH_OPTS "$VPS_HOST" 'rm -f /tmp/catalog-snap.db' 2>/dev/null || true

  VPS_SIZE=$(du -h "$LOCAL_DB" | cut -f1)
  log "  rsync OK ($VPS_SIZE local)"

  # 4. Merge SQL
MERGE_OUT=$(sqlite3 "$TARGET_DB" <<SQL
PRAGMA busy_timeout = 60000;
ATTACH DATABASE '$LOCAL_DB' AS vps;

-- Contagens ANTES do merge
SELECT 'licitacoes_main_antes', COUNT(*) FROM main.licitacoes;
SELECT 'itens_main_antes', COUNT(*) FROM main.itens;

-- Licitações: INSERT OR IGNORE (numeroControlePNCP UNIQUE dedupe)
INSERT OR IGNORE INTO main.licitacoes (
  numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade, codigoUnidade,
  anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
  objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp,
  dataAberturaProposta, dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem,
  usuarioNome, srp, dadosCompletos
)
SELECT
  numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade, codigoUnidade,
  anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
  objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp,
  dataAberturaProposta, dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem,
  usuarioNome, srp, dadosCompletos
FROM vps.licitacoes;

-- Aborts: copia aborts pendentes do VPS pro principal (UNIQUE garante dedupe)
INSERT OR IGNORE INTO main.bi_aborts (dia, modalidade, servidor, motivo, primeiraAbortEm)
SELECT dia, modalidade, COALESCE(servidor, '$ROTULO'), motivo, primeiraAbortEm
  FROM vps.bi_aborts
 WHERE resolvidoEm IS NULL;

-- Itens: insere só pra licitações que existem no main E ainda NÃO têm esse numeroItem
INSERT INTO main.itens (
  licitacaoId, numeroControlePNCP, numeroItem, descricao, quantidade,
  unidadeMedida, valorUnitarioEstimado, valorTotal, dadosCompletos
)
SELECT
  (SELECT id FROM main.licitacoes WHERE numeroControlePNCP = vi.numeroControlePNCP),
  vi.numeroControlePNCP, vi.numeroItem, vi.descricao, vi.quantidade,
  vi.unidadeMedida, vi.valorUnitarioEstimado, vi.valorTotal, vi.dadosCompletos
FROM vps.itens vi
WHERE EXISTS (SELECT 1 FROM main.licitacoes WHERE numeroControlePNCP = vi.numeroControlePNCP)
  AND NOT EXISTS (
    SELECT 1 FROM main.itens mi
    WHERE mi.numeroControlePNCP = vi.numeroControlePNCP AND mi.numeroItem = vi.numeroItem
  );

-- Contagens DEPOIS do merge
SELECT 'licitacoes_main_depois', COUNT(*) FROM main.licitacoes;
SELECT 'itens_main_depois', COUNT(*) FROM main.itens;

DETACH DATABASE vps;
SQL
)

  echo "$MERGE_OUT" | while IFS='|' read -r k v; do
    log "    $k = $v"
  done

  rm -f "$LOCAL_DB"
done

log "Concluído (todos VPSs)."

# WAL pós-merge pode ficar com GBs sem ser truncado (worker mantém conexões
# persistentes, auto-checkpoint PASSIVE não trunca). Força TRUNCATE pra evitar
# que próximas queries varram o WAL inteiro (queries virando timeout 120s+).
log "Checkpoint WAL (TRUNCATE)..."
WAL_ANTES=$(stat -c %s "$TARGET_DB-wal" 2>/dev/null || echo 0)
sqlite3 "$TARGET_DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1
WAL_DEPOIS=$(stat -c %s "$TARGET_DB-wal" 2>/dev/null || echo 0)
log "  WAL: $((WAL_ANTES/1024/1024))MB → $((WAL_DEPOIS/1024/1024))MB"
