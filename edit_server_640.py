#!/usr/bin/env python3
"""Edit server.js for onda 6.40.

Extrai autenticacao + session + auth-barrier + protected static para
auth-bootstrap.js. Bonus: purga 3 requires orfaos no topo (axios, fs,
crypto) que sobraram sem consumer.

Operacoes (aplicadas em ordem decrescente):

  T1) Insere require de auth-bootstrap.js logo apos a linha
      `puppeteer.use(StealthPlugin());`.
  R1) Remove linha `const session = require('express-session');`
  R2) Remove linha `const { createSessionStore, criarUsuarioInicial,
      getSessionSecret, getApiKey, requireAuth } = require('./auth');`
  R3) Remove linha `const crypto = require('crypto');`
  R4) Remove linha `const fs = require('fs');`
  R5) Remove linha `const axios = require('axios');`
  B1) Substitui o bloco AUTENTICACAO (header + 3 setup lines + blank +
      comentario + session middleware ate a `}));`, ~15 linhas) por:
      `const { apiKey } = initAuthAndSession(app, db);`
  B2) Substitui o comentario + `app.use(requireAuth(apiKey, db));`
      por `installAuthBarrier(app, db, { apiKey });`
  B3) Substitui o comentario + `app.use(express.static(public));`
      por `installProtectedStatic(app);`

Total mexido:
  - 5 linhas removidas do topo (3 deads + 2 migrados)
  - 1 linha inserida no topo
  - Bloco AUTENTICACAO (15 lin) -> 1 linha
  - Auth barrier (2 lin) -> 1 linha
  - Protected static (2 lin) -> 1 linha
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Ancoras dos requires (topo) ----------
i_axios   = find_exact("const axios = require('axios');", label='require axios')
i_fs      = find_exact("const fs = require('fs');", start=i_axios, label='require fs')
i_stealth = find_exact("puppeteer.use(StealthPlugin());", start=i_fs, label='puppeteer.use(...)')
i_crypto  = find_exact("const crypto = require('crypto');", start=i_stealth, label='require crypto')
i_session = find_exact("const session = require('express-session');", start=i_crypto, label='require session')
i_auth    = find_exact(
    "const { createSessionStore, criarUsuarioInicial, getSessionSecret, getApiKey, requireAuth } = require('./auth');",
    start=i_session, label='require auth symbols')

# ---------- Ancoras do bloco AUTENTICACAO ----------
i_head = find_exact(
    "// ==================== AUTENTICA\u00c7\u00c3O ====================",
    start=i_auth, label='header AUTENTICACAO')
i_session_end = find_exact(
    "}));",
    start=i_head, label='fim do app.use(session(...))')

# Sanity: linhas logo acima do `}));` devem ser do session middleware
session_block = ''.join(lines[i_head : i_session_end + 1])
for needle in (
    "criarUsuarioInicial(db);",
    "const sessionSecret = getSessionSecret(db);",
    "const apiKey = getApiKey(db);",
    "// Session middleware",
    "app.use(session({",
    "store: createSessionStore(session, db),",
    "secret: sessionSecret,",
    "name: 'liciteagora.sid',",
    "resave: false,",
    "saveUninitialized: false,",
    "cookie: { maxAge: 7 * 24 * 60 * 60 * 1000,",
):
    assert needle in session_block, 'bloco AUTENTICACAO nao contem: ' + needle

# ---------- Ancoras da barreira + comentario ----------
i_barrier = find_exact(
    "app.use(requireAuth(apiKey, db));",
    start=i_session_end, label='app.use(requireAuth)')
# Comentario imediatamente acima
assert lines[i_barrier - 1].rstrip('\n') == \
    "// Auth barrier \u2014 tudo abaixo requer autentica\u00e7\u00e3o (exceto webhook e X-Api-Key)", \
    'comentario auth barrier nao bate: %r' % lines[i_barrier - 1]

# ---------- Ancoras do static protegido + comentario ----------
i_static = find_exact(
    "app.use(express.static(path.join(__dirname, 'public')));",
    start=i_barrier, label='static protegido')
# Comentario imediatamente acima
assert lines[i_static - 1].rstrip('\n') == \
    "// Arquivos est\u00e1ticos protegidos (AP\u00d3S rotas de API para que n\u00e3o intercepte)", \
    'comentario static protegido nao bate: %r' % lines[i_static - 1]

print('ancoras:')
print('  axios L%d, fs L%d, puppeteer L%d, crypto L%d, session L%d, auth L%d'
      % (i_axios+1, i_fs+1, i_stealth+1, i_crypto+1, i_session+1, i_auth+1))
print('  AUTENTICACAO L%d..L%d (%d linhas)'
      % (i_head+1, i_session_end+1, i_session_end - i_head + 1))
print('  barrier L%d..L%d; static L%d..L%d'
      % (i_barrier, i_barrier+1, i_static, i_static+1))

# Sanity de ordem relativa
assert i_axios < i_fs < i_stealth < i_crypto < i_session < i_auth < i_head \
    < i_session_end < i_barrier < i_static, 'ordem relativa quebrada'

# ---------- Monta lista de edits (start, end_exclusive, replacement_lines) ----------
# Cada edit e aplicado em ordem decrescente de start para preservar indices.
edits = []

# B3: static protegido: 2 linhas (comentario + call) -> 1 linha
edits.append((
    i_static - 1, i_static + 1,
    ["installProtectedStatic(app);\n"],
))

# B2: barrier: 2 linhas -> 1 linha
edits.append((
    i_barrier - 1, i_barrier + 1,
    ["installAuthBarrier(app, db, { apiKey });\n"],
))

# B1: bloco AUTENTICACAO -> 1 linha (com header + comentario curto)
edits.append((
    i_head, i_session_end + 1,
    [
        "// NFSE-M06 onda 6.40 (2026-04-20): criarUsuarioInicial + sessionSecret +\n",
        "// apiKey + session middleware foram consolidados em auth-bootstrap.js.\n",
        "const { apiKey } = initAuthAndSession(app, db);\n",
    ],
))

# R2: require auth -> removido
edits.append((i_auth, i_auth + 1, []))
# R1: require session -> removido
edits.append((i_session, i_session + 1, []))
# R3: require crypto (orfao) -> removido
edits.append((i_crypto, i_crypto + 1, []))
# R4: require fs (orfao) -> removido
edits.append((i_fs, i_fs + 1, []))
# R5: require axios (orfao) -> removido
edits.append((i_axios, i_axios + 1, []))

# T1: inserir require de auth-bootstrap.js logo APOS puppeteer.use(StealthPlugin());
# Ou seja, no indice i_stealth + 1. Implementamos como replace de range vazio:
edits.append((
    i_stealth + 1, i_stealth + 1,
    [
        "const { initAuthAndSession, installAuthBarrier, installProtectedStatic } = require('./auth-bootstrap');\n",
    ],
))

# Aplica em ordem decrescente de start. Para tie em start (insercoes em mesmo
# indice), ordena por end descrescente nao faz diferenca aqui.
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
