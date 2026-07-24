#!/usr/bin/env python3
"""Edit server.js for onda 6.33: extrair schema SQL + migrações ad-hoc para
db-schema.js.

Remove, em um único intervalo contíguo a partir da linha `db.exec(\`` que
abre o bloco de schema:
  - db.exec(`CREATE TABLE IF NOT EXISTS licitacoes (...)`)
    ... todas as ~35 CREATE TABLE IF NOT EXISTS + CREATE INDEX + seed
        INSERT OR IGNORE INTO jornal_config ...
  - bloco até `\`);`
  - blank
  - // Migração: adicionar coluna 'tipo' na tabela grupos_palavras (bloco
    aninhado com migração 'lido' em chat_mensagens preservado byte-a-byte
    — mesmo aninhamento histórico)
  - // Migração: adicionar colunas para sync de mensagens via API v1 global
  - // Migração: adicionar colunas de config ao sniper_itens
  - eventual blank sobrando no fim (sweep limpa)

Insere no lugar:
  const { initSchema } = require('./db-schema');
  initSchema(db);

Âncora de início: a linha exata `db.exec(\`` (única ocorrência em col 0).
Âncora de fim:    a linha `} catch (e) {` seguida de
                  `  console.log('[Migração sniper_itens] Erro:', e.message);`
                  seguida de `}`.
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Âncora de início ----------
# `db.exec(`\n em col 0 — primeira (e única) ocorrência no topo do server.js.
idx_start = find_exact('db.exec(`', label='db.exec abertura schema')

# Sanity: próxima linha é a primeira CREATE TABLE
assert lines[idx_start + 1].strip().startswith('CREATE TABLE IF NOT EXISTS licitacoes'), \
    repr(lines[idx_start + 1])

# ---------- Âncora de fim ----------
# Após o bloco de schema vêm 3 blocos de migração. O último termina com:
#   } catch (e) {
#     console.log('[Migração sniper_itens] Erro:', e.message);
#   }
# Pegar esse `}` como fim.
idx_last_log = None
for j in range(idx_start + 1, len(lines)):
    if lines[j].strip() == "console.log('[Migração sniper_itens] Erro:', e.message);":
        idx_last_log = j
        break
assert idx_last_log is not None, 'log final da migração sniper_itens não encontrado'

# O `}` que fecha o catch está logo abaixo
idx_end = idx_last_log + 1
assert lines[idx_end].rstrip('\n') == '}', \
    'fecho da última migração não encontrado em idx_last_log+1: ' + repr(lines[idx_end])

# ---------- Sanity do bloco ----------
block_text = ''.join(lines[idx_start : idx_end + 1])
for needle in (
    'CREATE TABLE IF NOT EXISTS licitacoes',
    'CREATE TABLE IF NOT EXISTS config',
    'CREATE TABLE IF NOT EXISTS chat_mensagens',
    'CREATE TABLE IF NOT EXISTS sniper_itens',
    'CREATE TABLE IF NOT EXISTS blitz_agendadas',
    "INSERT OR IGNORE INTO jornal_config",
    "// Migração: adicionar coluna 'tipo' na tabela grupos_palavras",
    "// Migração: adicionar coluna 'lido' na tabela chat_mensagens",
    "// Migração: adicionar colunas para sync de mensagens via API v1 global",
    "// Migração: adicionar colunas de config ao sniper_itens",
    "[Migração sniper_itens] Erro:",
):
    assert needle in block_text, 'bloco não contém ' + needle

print('bloco schema+migrações: linhas', idx_start + 1, '..', idx_end + 1,
      '(' + str(idx_end - idx_start + 1) + ' linhas)')

# ---------- Substituição ----------
replacement = [
    "// NFSE-M06 onda 6.33 (2026-04-20): schema SQL (~35 CREATE TABLE + índices +\n",
    "// seed jornal_config) e as 4 migrações ad-hoc (grupos_palavras.tipo +\n",
    "// chat_mensagens.lido aninhado, colunas v1 de chat_mensagens, colunas de\n",
    "// config do sniper_itens) migraram para db-schema.js. initSchema(db) é\n",
    "// idempotente — pode ser chamado em qualquer ordem relativa ao restante\n",
    "// do bootstrap desde que `db` já esteja aberto.\n",
    "const { initSchema } = require('./db-schema');\n",
    "initSchema(db);\n",
]

lines[idx_start : idx_end + 1] = replacement

# ---------- Sweep: colapsa >=3 blanks consecutivos ----------
cleaned = []
blank_run = 0
for L in lines:
    if L.strip() == '':
        blank_run += 1
        if blank_run <= 2:
            cleaned.append(L)
    else:
        blank_run = 0
        cleaned.append(L)
lines = cleaned

# ---------- Escrever ----------
with open(path_server, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print('server.js editado, total de linhas:', len(lines))
