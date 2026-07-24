#!/usr/bin/env python3
"""Edit server.js for onda 6.39: extrair CORS + body parsers + login static
para base-middleware.js.

Operacoes:
  A) Remove require de cors (unico consumer era o app.use deste bloco).
  B) Remove bloco de middleware (header "// Middleware" ate a linha do
     static de login inclusive).
  C) Insere no lugar do bloco B: require + chamada applyBaseMiddleware(app).
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- A) require cors ----------
i_require_cors = find_exact(
    "const cors = require('cors');",
    label='require cors')

# ---------- B) bloco de middleware ----------
i_header = find_exact(
    "// Middleware",
    start=i_require_cors + 1, label='header Middleware')
i_login_static = find_exact(
    "app.use(express.static(path.join(__dirname, 'public', 'auth')));",
    start=i_header, label='login static (fim do bloco)')

# Sanity: bloco tem as pecas esperadas
block = ''.join(lines[i_header : i_login_static + 1])
for needle in (
    "// SEC-05 (2026-04-18): CORS com origem expl",
    "const _corsAllow = (origin, cb) =>",
    "chrome-extension:",
    "liciteagora",
    "votoaqui",
    "app.use(cors({ origin: _corsAllow, credentials: true }));",
    "app.use(express.json({ limit: '10mb' }));",
    "app.use(express.urlencoded({ limit: '10mb', extended: true }));",
    "// Login page (p\u00fablico, antes do auth)",
    "app.use(express.static(path.join(__dirname, 'public', 'auth')));",
):
    assert needle in block, 'bloco middleware nao contem: ' + needle

# Sanity: a linha logo abaixo deveria ser uma blank ou o comentario PNCP
after = lines[i_login_static + 1 : i_login_static + 4]
assert any("Configura" in L or L.strip() == '' for L in after), \
    'depois do bloco middleware esperava blank/comentario PNCP: %r' % after

# Sanity: nao ha outros consumidores de `cors` em server.js fora do
# require (linha i_require_cors) e do bloco middleware [i_header, i_login_static].
outside_hits = []
for i, L in enumerate(lines):
    if 'cors' not in L:
        continue
    if i == i_require_cors:
        continue
    if i_header <= i <= i_login_static:
        continue
    outside_hits.append((i + 1, L.rstrip('\n')))
assert not outside_hits, \
    'encontrei consumidores de "cors" fora das zonas removidas: %r' % outside_hits

print('remocoes:')
print('  A) linha %d (require cors)' % (i_require_cors + 1))
print('  B) linhas %d..%d (bloco middleware, %d linhas)' %
      (i_header + 1, i_login_static + 1, i_login_static - i_header + 1))

# ---------- Replacement do bloco B ----------
replacement_B = [
    "// NFSE-M06 onda 6.39 (2026-04-20): middleware base (CORS allow-list +\n",
    "// body parsers + static da login page) extraido para base-middleware.js.\n",
    "const { applyBaseMiddleware } = require('./base-middleware');\n",
    "applyBaseMiddleware(app);\n",
]

# ---------- Aplica em ordem decrescente (B primeiro, depois A) ----------
lines[i_header : i_login_static + 1] = replacement_B
del lines[i_require_cors : i_require_cors + 1]

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
