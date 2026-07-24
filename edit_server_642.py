#!/usr/bin/env python3
"""Edit server.js + role-dispatch.js for onda 6.42.

Move os requires dos 5 schedulers que ate a onda 6.41 viviam no topo do
server.js apenas para serem repassados ao createRoleDispatch:

    iniciarReconciliadorS6  <- nfse-routes
    agendarPollingBoletos   <- financeiro-routes
    agendarRecorrencias     <- recorrencia-scheduler
    agendarCobrancas        <- cobranca-scheduler
    agendarJornal           <- jornal-scheduler

Pattern: role-dispatch eh o unico consumer desses simbolos vindos do
server.js. scheduler.js (entrypoint ROLE=master) tem seus proprios
requires diretos e nao usa role-dispatch. Logo, internalizar no
role-dispatch e clean.

Operacoes server.js:
  R1) Remove 5 requires (linhas 7-11).
  B1) Encolhe o destructure dentro da chamada createRoleDispatch de
      13 simbolos (3 linhas) para 8 simbolos (1 linha).

Operacoes role-dispatch.js:
  T2) Insere 5 requires + 4 comment lines apos o jsdoc/comentario topo
      de abertura (logo antes de `function createRoleDispatch`).
  B2) Encolhe o destructure interno de 13 simbolos para 8 simbolos.
"""
import os

# -----------------------------------------------------------
# PARTE 1: server.js
# -----------------------------------------------------------
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    slines = f.readlines()

def find_exact_in(arr, needle, start=0, label=''):
    for i in range(start, len(arr)):
        if arr[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact) in %s: %s' % (label or 'array', needle))

# Ancoras dos 5 requires
i_nfse   = find_exact_in(slines, "const { iniciarReconciliadorS6 } = require('./nfse-routes');",         label='require nfse')
i_fin    = find_exact_in(slines, "const { agendarPollingBoletos } = require('./financeiro-routes');",    start=i_nfse,   label='require financeiro')
i_rec    = find_exact_in(slines, "const { agendarRecorrencias } = require('./recorrencia-scheduler');",  start=i_fin,    label='require recorrencia')
i_cob    = find_exact_in(slines, "const { agendarCobrancas } = require('./cobranca-scheduler');",        start=i_rec,    label='require cobranca')
i_jornal = find_exact_in(slines, "const { agendarJornal } = require('./jornal-scheduler');",             start=i_cob,    label='require jornal')

# Ancoras do destructure da chamada createRoleDispatch
i_call_db = find_exact_in(
    slines,
    "  db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,",
    start=i_jornal, label='createRoleDispatch linha 1')
assert slines[i_call_db + 1].rstrip('\n') == \
    "  pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,", \
    'createRoleDispatch linha 2 nao bate: %r' % slines[i_call_db + 1]
assert slines[i_call_db + 2].rstrip('\n') == \
    "  agendarPollingBoletos, iniciarReconciliadorS6,", \
    'createRoleDispatch linha 3 nao bate: %r' % slines[i_call_db + 2]

# Sanity: nao ha consumer dos schedulers fora da chamada createRoleDispatch
# no server.js (deveriam ter sido apenas passados adiante).
for sym in ('iniciarReconciliadorS6', 'agendarPollingBoletos',
            'agendarRecorrencias', 'agendarCobrancas', 'agendarJornal'):
    hits = []
    for i, L in enumerate(slines):
        if sym in L:
            # Ignora a propria linha de require e as 3 linhas do destructure.
            if i in (i_nfse, i_fin, i_rec, i_cob, i_jornal):
                continue
            if i_call_db <= i <= i_call_db + 2:
                continue
            hits.append((i + 1, L.rstrip('\n')))
    assert not hits, 'Consumer inesperado de %s fora da passagem: %r' % (sym, hits)

print('[server.js] ancoras:')
print('  requires  nfse L%d, financeiro L%d, recorrencia L%d, cobranca L%d, jornal L%d' %
      (i_nfse+1, i_fin+1, i_rec+1, i_cob+1, i_jornal+1))
print('  createRoleDispatch destructure L%d..L%d' % (i_call_db+1, i_call_db+3))

# Edits server.js (ordem decrescente de start)
edits_s = []
# B1: encolhe destructure 3 linhas -> 1 linha
edits_s.append((
    i_call_db, i_call_db + 3,
    ["  db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue, pncpSync,\n"],
))
# R1: remove os 5 requires (aplicados em ordem decrescente individual)
for i in (i_jornal, i_cob, i_rec, i_fin, i_nfse):
    edits_s.append((i, i + 1, []))

for start, end, repl in sorted(edits_s, key=lambda t: -t[0]):
    slines[start:end] = repl

# Sweep blank runs
cleaned = []
blank_run = 0
for L in slines:
    if L.strip() == '':
        blank_run += 1
        if blank_run <= 2:
            cleaned.append(L)
    else:
        blank_run = 0
        cleaned.append(L)
slines = cleaned

with open(path_server, 'w', encoding='utf-8') as f:
    f.writelines(slines)
print('server.js editado, total de linhas:', len(slines))

# -----------------------------------------------------------
# PARTE 2: role-dispatch.js
# -----------------------------------------------------------
path_rd = 'role-dispatch.js'
with open(path_rd, 'r', encoding='utf-8') as f:
    rlines = f.readlines()

# Ancora: linha "function createRoleDispatch(deps) {"
i_func = find_exact_in(rlines, "function createRoleDispatch(deps) {", label='function createRoleDispatch')

# Ancoras do destructure interno
i_rd_db = find_exact_in(
    rlines,
    "    db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,",
    start=i_func, label='destructure interno linha 1')
assert rlines[i_rd_db + 1].rstrip('\n') == \
    "    pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,", \
    'destructure interno linha 2 nao bate: %r' % rlines[i_rd_db + 1]
assert rlines[i_rd_db + 2].rstrip('\n') == \
    "    agendarPollingBoletos, iniciarReconciliadorS6,", \
    'destructure interno linha 3 nao bate: %r' % rlines[i_rd_db + 2]
assert rlines[i_rd_db + 3].rstrip('\n') == "  } = deps;", \
    'fim do destructure nao bate: %r' % rlines[i_rd_db + 3]

print('[role-dispatch.js] ancoras:')
print('  function createRoleDispatch L%d' % (i_func + 1))
print('  destructure interno L%d..L%d' % (i_rd_db + 1, i_rd_db + 3))

# Edits role-dispatch (ordem decrescente)
edits_r = []

# B2: encolhe destructure 3 linhas -> 1 linha
edits_r.append((
    i_rd_db, i_rd_db + 3,
    ["    db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue, pncpSync,\n"],
))

# T2: insere 5 requires + comentario antes de `function createRoleDispatch`
edits_r.append((
    i_func, i_func,
    [
        "// NFSE-M06 onda 6.42 (2026-04-20): schedulers que antes eram passados\n",
        "// como deps via server.js viraram requires diretos do modulo. Nada\n",
        "// muda no comportamento -- scheduler.js (ROLE=master entrypoint) tem\n",
        "// requires independentes e nao usa role-dispatch.\n",
        "const { iniciarReconciliadorS6 } = require('./nfse-routes');\n",
        "const { agendarPollingBoletos } = require('./financeiro-routes');\n",
        "const { agendarRecorrencias } = require('./recorrencia-scheduler');\n",
        "const { agendarCobrancas } = require('./cobranca-scheduler');\n",
        "const { agendarJornal } = require('./jornal-scheduler');\n",
        "\n",
    ],
))

for start, end, repl in sorted(edits_r, key=lambda t: -t[0]):
    rlines[start:end] = repl

# Sweep blank runs
cleaned = []
blank_run = 0
for L in rlines:
    if L.strip() == '':
        blank_run += 1
        if blank_run <= 2:
            cleaned.append(L)
    else:
        blank_run = 0
        cleaned.append(L)
rlines = cleaned

with open(path_rd, 'w', encoding='utf-8') as f:
    f.writelines(rlines)
print('role-dispatch.js editado, total de linhas:', len(rlines))
