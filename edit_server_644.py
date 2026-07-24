#!/usr/bin/env python3
"""Edit server.js + route-registry.js + role-dispatch.js for onda 6.44:
centralizar PORT / PNCP_API_BASE / PNCP_API_ITENS em config.js.

server.js para de declarar essas 3 constantes e para de injeta-las em
deps de route-registry e role-dispatch. Cada modulo passa a carregar
config.js diretamente.

Operacoes:

  SERVER.JS
    R1) Remove linha `const PORT = 3000;`
    R2) Remove bloco PNCP_API (comentario + 2 consts)
    B1) Encolhe destructure de registerProtectedRoutes (5 chaves em
        4 linhas -> 1 linha com 7 chaves)
    B2) Encolhe destructure de createRoleDispatch (1 linha 8 chaves ->
        1 linha 6 chaves -- mesmo shape, 2 chaves a menos)

  ROUTE-REGISTRY.JS
    T1) Insere require('./config') antes de `function registerProtectedRoutes`
    B3) Destructure de deps: remove PORT, PNCP_API_BASE, PNCP_API_ITENS

  ROLE-DISPATCH.JS
    T2) Insere require('./config') antes de `function createRoleDispatch`
    B4) Destructure interno: remove PORT, PNCP_API_BASE
"""

def find_exact_in(arr, needle, start=0, label=''):
    for i in range(start, len(arr)):
        if arr[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact) in %s: %s' % (label or 'array', needle))

def sweep_blanks(arr):
    cleaned = []
    blank_run = 0
    for L in arr:
        if L.strip() == '':
            blank_run += 1
            if blank_run <= 2:
                cleaned.append(L)
        else:
            blank_run = 0
            cleaned.append(L)
    return cleaned

# ============================================================
# PARTE 1: server.js
# ============================================================
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    slines = f.readlines()

# R1 anchor
i_port = find_exact_in(slines, "const PORT = 3000;", label='const PORT')

# R2 anchors: comentario "// Configuração da API do PNCP" + 2 linhas
i_pncp_head = find_exact_in(slines, "// Configura\u00e7\u00e3o da API do PNCP",
                             start=i_port, label='header PNCP')
assert slines[i_pncp_head + 1].rstrip('\n') == \
    "const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';", \
    'linha PNCP_API_BASE nao bate: %r' % slines[i_pncp_head + 1]
assert slines[i_pncp_head + 2].rstrip('\n') == \
    "const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';", \
    'linha PNCP_API_ITENS nao bate: %r' % slines[i_pncp_head + 2]

# B1 anchors: registerProtectedRoutes(app, { ... });
i_rp_open = find_exact_in(slines, "registerProtectedRoutes(app, {",
                          start=i_pncp_head, label='registerProtectedRoutes open')
# Linhas internas do destructure (4 linhas)
assert slines[i_rp_open + 1].rstrip('\n') == "  db, dbPath, PORT,", \
    'rp L1 nao bate: %r' % slines[i_rp_open + 1]
assert slines[i_rp_open + 2].rstrip('\n') == "  pncpSync, salvarItens,", \
    'rp L2 nao bate: %r' % slines[i_rp_open + 2]
assert slines[i_rp_open + 3].rstrip('\n') == "  PNCP_API_BASE, PNCP_API_ITENS,", \
    'rp L3 nao bate: %r' % slines[i_rp_open + 3]
assert slines[i_rp_open + 4].rstrip('\n') == "  getConfigValue, setConfigValue, getIAKeys,", \
    'rp L4 nao bate: %r' % slines[i_rp_open + 4]
assert slines[i_rp_open + 5].rstrip('\n') == "});", \
    'rp close nao bate: %r' % slines[i_rp_open + 5]

# B2 anchor: createRoleDispatch destructure linha unica
i_crd_line = find_exact_in(
    slines,
    "  db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue, pncpSync,",
    start=i_rp_open, label='createRoleDispatch destructure')

print('[server.js] ancoras:')
print('  PORT L%d' % (i_port + 1))
print('  PNCP header L%d..L%d' % (i_pncp_head + 1, i_pncp_head + 3))
print('  registerProtectedRoutes L%d..L%d' % (i_rp_open + 1, i_rp_open + 5))
print('  createRoleDispatch destructure L%d' % (i_crd_line + 1))

# Ordem relativa
assert i_port < i_pncp_head < i_rp_open < i_crd_line, 'ordem server.js quebrada'

# Edits server.js
edits_s = []

# B2: createRoleDispatch destructure -- 1 linha substitui 1 linha
edits_s.append((
    i_crd_line, i_crd_line + 1,
    ["  db, app, apiKey, dbPath, getConfigValue, pncpSync,\n"],
))

# B1: registerProtectedRoutes destructure 4 linhas -> 1 linha
edits_s.append((
    i_rp_open + 1, i_rp_open + 5,
    ["  db, dbPath, pncpSync, salvarItens, getConfigValue, setConfigValue, getIAKeys,\n"],
))

# R2: remove PNCP header + 2 consts
edits_s.append((i_pncp_head, i_pncp_head + 3, []))

# R1: remove const PORT
edits_s.append((i_port, i_port + 1, []))

for start, end, repl in sorted(edits_s, key=lambda t: -t[0]):
    slines[start:end] = repl

slines = sweep_blanks(slines)

with open(path_server, 'w', encoding='utf-8') as f:
    f.writelines(slines)
print('server.js editado, total de linhas:', len(slines))

# ============================================================
# PARTE 2: route-registry.js
# ============================================================
path_rr = 'route-registry.js'
with open(path_rr, 'r', encoding='utf-8') as f:
    rrlines = f.readlines()

# T1 anchor: `function registerProtectedRoutes(app, deps) {`
i_rr_func = find_exact_in(rrlines, "function registerProtectedRoutes(app, deps) {",
                           label='function registerProtectedRoutes')

# B3 anchors: destructure linhas dentro da funcao
assert rrlines[i_rr_func + 1].rstrip('\n') == "  const {", \
    'rr destructure open nao bate: %r' % rrlines[i_rr_func + 1]
assert rrlines[i_rr_func + 2].rstrip('\n') == "    db, dbPath, PORT,", \
    'rr L1 nao bate: %r' % rrlines[i_rr_func + 2]
assert rrlines[i_rr_func + 3].rstrip('\n') == "    pncpSync, salvarItens,", \
    'rr L2 nao bate: %r' % rrlines[i_rr_func + 3]
assert rrlines[i_rr_func + 4].rstrip('\n') == "    PNCP_API_BASE, PNCP_API_ITENS,", \
    'rr L3 nao bate: %r' % rrlines[i_rr_func + 4]
assert rrlines[i_rr_func + 5].rstrip('\n') == "    getConfigValue, setConfigValue, getIAKeys,", \
    'rr L4 nao bate: %r' % rrlines[i_rr_func + 5]
assert rrlines[i_rr_func + 6].rstrip('\n') == "  } = deps;", \
    'rr destructure close nao bate: %r' % rrlines[i_rr_func + 6]

print('[route-registry.js] ancoras:')
print('  function registerProtectedRoutes L%d' % (i_rr_func + 1))
print('  destructure interno L%d..L%d' % (i_rr_func + 2, i_rr_func + 5))

# Edits route-registry
edits_rr = []

# B3: encolhe destructure 4 linhas -> 2 linhas (sem PORT, PNCP_API_BASE, PNCP_API_ITENS)
edits_rr.append((
    i_rr_func + 2, i_rr_func + 6,
    [
        "    db, dbPath, pncpSync, salvarItens,\n",
        "    getConfigValue, setConfigValue, getIAKeys,\n",
    ],
))

# T1: insere require('./config') antes de `function registerProtectedRoutes`
edits_rr.append((
    i_rr_func, i_rr_func,
    [
        "// NFSE-M06 onda 6.44 (2026-04-20): PORT + PNCP_API_BASE + PNCP_API_ITENS\n",
        "// saem do deps bag e viram require direto de config.js. server.js nao\n",
        "// precisa mais repassar essas constantes.\n",
        "const { PORT, PNCP_API_BASE, PNCP_API_ITENS } = require('./config');\n",
        "\n",
    ],
))

for start, end, repl in sorted(edits_rr, key=lambda t: -t[0]):
    rrlines[start:end] = repl

rrlines = sweep_blanks(rrlines)

with open(path_rr, 'w', encoding='utf-8') as f:
    f.writelines(rrlines)
print('route-registry.js editado, total de linhas:', len(rrlines))

# ============================================================
# PARTE 3: role-dispatch.js
# ============================================================
path_rd = 'role-dispatch.js'
with open(path_rd, 'r', encoding='utf-8') as f:
    rdlines = f.readlines()

# Ancora: linha do destructure interno de createRoleDispatch
i_rd_destr = find_exact_in(
    rdlines,
    "    db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue, pncpSync,",
    label='role-dispatch destructure interno')
# Verifica que a linha anterior e `  const {` e a seguinte e `  } = deps;`
assert rdlines[i_rd_destr - 1].rstrip('\n') == "  const {", \
    'rd destructure open nao bate: %r' % rdlines[i_rd_destr - 1]
assert rdlines[i_rd_destr + 1].rstrip('\n') == "  } = deps;", \
    'rd destructure close nao bate: %r' % rdlines[i_rd_destr + 1]

# Ancora para insercao: `function createRoleDispatch(deps) {`
i_rd_func = find_exact_in(rdlines, "function createRoleDispatch(deps) {",
                           label='function createRoleDispatch')
# Sanity: i_rd_func vem antes de i_rd_destr
assert i_rd_func < i_rd_destr, 'ordem role-dispatch quebrada'

print('[role-dispatch.js] ancoras:')
print('  function createRoleDispatch L%d' % (i_rd_func + 1))
print('  destructure interno L%d' % (i_rd_destr + 1))

# Edits role-dispatch
edits_rd = []

# B4: destructure interno 1 linha -> 1 linha, sem PORT nem PNCP_API_BASE
edits_rd.append((
    i_rd_destr, i_rd_destr + 1,
    ["    db, app, apiKey, dbPath, getConfigValue, pncpSync,\n"],
))

# T2: insere require('./config') antes de `function createRoleDispatch`
edits_rd.append((
    i_rd_func, i_rd_func,
    [
        "// NFSE-M06 onda 6.44 (2026-04-20): PORT + PNCP_API_BASE saem do deps bag\n",
        "// e viram require direto de config.js. Reduz o contrato com server.js.\n",
        "const { PORT, PNCP_API_BASE } = require('./config');\n",
        "\n",
    ],
))

for start, end, repl in sorted(edits_rd, key=lambda t: -t[0]):
    rdlines[start:end] = repl

rdlines = sweep_blanks(rdlines)

with open(path_rd, 'w', encoding='utf-8') as f:
    f.writelines(rdlines)
print('role-dispatch.js editado, total de linhas:', len(rdlines))
