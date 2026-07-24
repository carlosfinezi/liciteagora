#!/usr/bin/env python3
"""Edit server.js for onda 6.41: consolidar DB bootstrap em db-bootstrap.js.

Operacoes (aplicadas em ordem decrescente de indice):

  B) Substitui o bloco "DB bootstrap" (analise-ia destructure + dbPath +
     new Database + initSchema + createPersistence + pncpSync.init +
     createConfigHelpers, ~41 linhas) por 7 linhas:

        // Modulo de analise IA
        const { processarFilaAnalise } = require('./analise-ia');

        // NFSE-M06 onda 6.41 (2026-04-20): DB open + schema + persistencia
        // + pncpSync.init + configHelpers consolidados em db-bootstrap.js.
        const { bootstrapDatabase } = require('./db-bootstrap');
        const { db, dbPath, salvarItens, pncpSync, getConfigValue, setConfigValue, getIAKeys } = bootstrapDatabase({ processarFilaAnalise });

  R1) Remove linha `const path = require('path');` (orfao apos B).
  R2) Remove linha `const Database = require('better-sqlite3');` (orfao apos B).

Bonus implicito em B: descarta destructure de `analisarLicitacao`
(importado mas sem consumer em server.js) e `salvarLicitacao` (idem).
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Ancoras dos requires orfaos (topo) ----------
i_database = find_exact("const Database = require('better-sqlite3');", label='require Database')
i_path     = find_exact("const path = require('path');", start=i_database, label='require path')

# ---------- Ancoras do bloco DB bootstrap ----------
# Usamos o comentario "// Modulo de analise IA" como inicio e a linha
# da config-helpers como fim (inclusive).
i_block_start = find_exact(
    "// M\u00f3dulo de an\u00e1lise IA",
    start=i_path, label='comentario Modulo de analise IA')
i_block_end = find_exact(
    "const { getConfigValue, setConfigValue, getIAKeys } = createConfigHelpers(db);",
    start=i_block_start, label='createConfigHelpers destructure')

# Sanity: bloco contem as pecas esperadas
block = ''.join(lines[i_block_start : i_block_end + 1])
for needle in (
    "const { analisarLicitacao, processarFilaAnalise } = require('./analise-ia');",
    "// Banco de dados SQLite",
    "const dbPath = path.join(__dirname, 'pncp.db');",
    "const db = new Database(dbPath);",
    "// Criar tabelas",
    "const { initSchema } = require('./db-schema');",
    "initSchema(db);",
    "const { createPersistence } = require('./licitacoes-persistence');",
    "const { salvarLicitacao, salvarItens } = createPersistence(db);",
    "const pncpSync = require('./pncp-sync-scheduler');",
    "pncpSync.init({ db, processarFilaAnalise });",
    "const { createConfigHelpers } = require('./config-helpers');",
    "const { getConfigValue, setConfigValue, getIAKeys } = createConfigHelpers(db);",
):
    assert needle in block, 'bloco DB bootstrap nao contem: ' + needle

# Sanity: nao ha consumidores de Database / path fora das zonas removidas.
# path.join eh usado dentro do bloco (linha de dbPath). Database so no bloco.
# Apos remocao, esses simbolos devem ficar totalmente ausentes.
outside_hits_db = []
outside_hits_path = []
for i, L in enumerate(lines):
    if i == i_database or (i_block_start <= i <= i_block_end):
        continue
    if 'Database' in L and 'better-sqlite3' not in L:
        # Procura uso de Database (nao o require).
        # Nao esperamos nenhum.
        outside_hits_db.append((i + 1, L.rstrip('\n')))

for i, L in enumerate(lines):
    if i == i_path or (i_block_start <= i <= i_block_end):
        continue
    # path.xxx uso fora -- qualquer mencao de `path.` ou `'path'` conta.
    if 'path.' in L or "require('path')" in L:
        outside_hits_path.append((i + 1, L.rstrip('\n')))

assert not outside_hits_db, \
    'Encontrei consumer de Database fora do bloco: %r' % outside_hits_db
assert not outside_hits_path, \
    'Encontrei consumer de path fora do bloco: %r' % outside_hits_path

print('ancoras:')
print('  Database L%d, path L%d' % (i_database + 1, i_path + 1))
print('  DB bootstrap L%d..L%d (%d linhas)'
      % (i_block_start + 1, i_block_end + 1, i_block_end - i_block_start + 1))

# Sanity de ordem relativa
assert i_database < i_path < i_block_start < i_block_end, 'ordem relativa quebrada'

# ---------- Monta edits (start, end_exclusive, replacement_lines) ----------
edits = []

# B: substitui bloco DB bootstrap por 7 linhas
edits.append((
    i_block_start, i_block_end + 1,
    [
        "// M\u00f3dulo de an\u00e1lise IA\n",
        "const { processarFilaAnalise } = require('./analise-ia');\n",
        "\n",
        "// NFSE-M06 onda 6.41 (2026-04-20): DB open + schema + persist\u00eancia +\n",
        "// pncpSync.init + configHelpers consolidados em db-bootstrap.js.\n",
        "const { bootstrapDatabase } = require('./db-bootstrap');\n",
        "const { db, dbPath, salvarItens, pncpSync, getConfigValue, setConfigValue, getIAKeys } = bootstrapDatabase({ processarFilaAnalise });\n",
    ],
))

# R1: remove require path
edits.append((i_path, i_path + 1, []))

# R2: remove require Database
edits.append((i_database, i_database + 1, []))

# Aplica em ordem decrescente de start
for start, end, repl in sorted(edits, key=lambda t: -t[0]):
    lines[start:end] = repl

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
