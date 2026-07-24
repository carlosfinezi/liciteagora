#!/usr/bin/env python3
"""Edit server.js for onda 6.43: consolidar pipeline de autenticacao.

Substitui em server.js:
  - Os 2 requires de auth-bootstrap + auth-routes (linhas 5-6)
  - O bloco de wiring da autenticacao (6 passos, ~25 linhas com
    comentarios + o require de pre-auth-routes que vivia no meio)

Por um unico require + chamada de installAuthPipeline(app, db).
apiKey sai do retorno para ser consumido por createRoleDispatch.

Operacoes:
  R1) Remove linha 5 (require auth-bootstrap).
  R2) Remove linha 6 (require auth-routes).
  B1) Substitui bloco que vai de "// NFSE-M06 onda 6.40 ... initAuthAndSession"
      ate "installProtectedStatic(app);" por:

         // NFSE-M06 onda 6.43 (2026-04-20): wiring completo da autenticacao
         // (initAuthAndSession + rotas publicas + pre-auth + barrier +
         // rotas protegidas + static protegido) consolidado em auth-pipeline.js.
         const { installAuthPipeline } = require('./auth-pipeline');
         const { apiKey } = installAuthPipeline(app, db);

Nada mais muda. registerProtectedRoutes e createRoleDispatch continuam
iguais; apiKey continua disponivel no escopo do server.js.
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Ancoras dos 2 requires ----------
i_req_boot = find_exact(
    "const { initAuthAndSession, installAuthBarrier, installProtectedStatic } = require('./auth-bootstrap');",
    label='require auth-bootstrap')
i_req_auth = find_exact(
    "const { registrarRotasAuthPublicas, registrarRotasAuthProtegidas } = require('./auth-routes');",
    start=i_req_boot, label='require auth-routes')

# ---------- Ancoras do bloco auth wiring ----------
# Inicio: comentario da onda 6.40 (ou a propria chamada initAuthAndSession)
# Fim: installProtectedStatic(app);
i_auth_start = find_exact(
    "// NFSE-M06 onda 6.40 (2026-04-20): criarUsuarioInicial + sessionSecret +",
    start=i_req_auth, label='inicio do bloco auth wiring')
i_auth_end = find_exact(
    "installProtectedStatic(app);",
    start=i_auth_start, label='fim do bloco auth wiring')

# Sanity: bloco contem todos os 6 passos do pipeline
block = ''.join(lines[i_auth_start : i_auth_end + 1])
for needle in (
    "const { apiKey } = initAuthAndSession(app, db);",
    "registrarRotasAuthPublicas(app, db);",
    "const { registerPreAuthRoutes } = require('./pre-auth-routes');",
    "registerPreAuthRoutes(app, db, { apiKey });",
    "installAuthBarrier(app, db, { apiKey });",
    "registrarRotasAuthProtegidas(app, db, { apiKey });",
    "installProtectedStatic(app);",
):
    assert needle in block, 'bloco auth wiring nao contem: ' + needle

# Sanity: nao ha consumer de installAuthBarrier/installProtectedStatic/
# initAuthAndSession/registrarRotasAuthPublicas/registrarRotasAuthProtegidas
# /registerPreAuthRoutes fora do bloco (apos a nossa remocao tudo deve
# ser encapsulado em auth-pipeline.js).
for sym in ('initAuthAndSession', 'installAuthBarrier', 'installProtectedStatic',
            'registrarRotasAuthPublicas', 'registrarRotasAuthProtegidas',
            'registerPreAuthRoutes'):
    hits = []
    for i, L in enumerate(lines):
        if sym not in L:
            continue
        # Ignora os 2 requires do topo
        if i == i_req_boot or i == i_req_auth:
            continue
        # Ignora o bloco inteiro
        if i_auth_start <= i <= i_auth_end:
            continue
        hits.append((i + 1, L.rstrip('\n')))
    assert not hits, 'Consumer inesperado de %s: %r' % (sym, hits)

print('ancoras:')
print('  require auth-bootstrap L%d, require auth-routes L%d' %
      (i_req_boot + 1, i_req_auth + 1))
print('  bloco auth wiring L%d..L%d (%d linhas)' %
      (i_auth_start + 1, i_auth_end + 1, i_auth_end - i_auth_start + 1))

# Sanity de ordem relativa
assert i_req_boot < i_req_auth < i_auth_start < i_auth_end, 'ordem relativa quebrada'

# ---------- Monta edits ----------
edits = []

# B1: substitui bloco auth wiring por 5 linhas
edits.append((
    i_auth_start, i_auth_end + 1,
    [
        "// NFSE-M06 onda 6.43 (2026-04-20): wiring completo da autentica\u00e7\u00e3o\n",
        "// (initAuthAndSession + rotas p\u00fablicas + pre-auth + barrier +\n",
        "// rotas protegidas + static protegido) consolidado em auth-pipeline.js.\n",
        "const { installAuthPipeline } = require('./auth-pipeline');\n",
        "const { apiKey } = installAuthPipeline(app, db);\n",
    ],
))

# R1/R2: remove os 2 requires
edits.append((i_req_auth, i_req_auth + 1, []))
edits.append((i_req_boot, i_req_boot + 1, []))

# Aplica em ordem decrescente
for start, end, repl in sorted(edits, key=lambda t: -t[0]):
    lines[start:end] = repl

# ---------- Sweep blank runs ----------
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
