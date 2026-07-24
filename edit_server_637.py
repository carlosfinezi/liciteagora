#!/usr/bin/env python3
"""Edit server.js for onda 6.37: extrair bloco pre-auth para pre-auth-routes.js.

Operacoes:
  A) Remove linha 21: require('./comprasnet-login-routes') — migra para o
     modulo (unico consumer era o app.use em /api/comprasnet daqui).
  B) Remove linhas 123-141 (bloco pre-auth: portal + download + comprasnet
     mount + electron require/call).
  C) Insere no lugar do bloco B: require + registerPreAuthRoutes(app, db,
     { apiKey }).

Preservado 1:1:
  - Ordem portal > download > comprasnet > electron (dentro do modulo).
  - Barreira requireAuth() continua na mesma linha relativa em server.js.
  - `registrarRotasPortalAdmin` (re-require no route-registry.js) nao e
     tocado aqui — Node cacheia o modulo, essa duplicacao e gratis.
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Ancoras ----------
i_require_comprasnet = find_exact(
    "const comprasnetLoginRoutes = require('./comprasnet-login-routes');",
    label='require comprasnet-login-routes')

i_portal_header = find_exact(
    "// ==================== PORTAL DO CLIENTE (antes do auth) ====================",
    start=i_require_comprasnet, label='header portal pre-auth')

i_electron_call = find_exact(
    "registrarRotasElectron(app, db, { apiKey });",
    start=i_portal_header, label='fim do bloco pre-auth (electron call)')

# Sanity: bloco pre-auth deve ter exatamente 19 linhas
assert i_electron_call - i_portal_header == 18, \
    'bloco pre-auth com tamanho inesperado: %d..%d' % (i_portal_header + 1, i_electron_call + 1)

# Sanity: conteudo do bloco
block = ''.join(lines[i_portal_header : i_electron_call + 1])
for needle in (
    "app.use('/portal', express.static(",
    "const { registrarRotasPortal, registrarRotasPortalAdmin } = require('./portal-routes');",
    "registrarRotasPortal(app, db);",
    "// ==================== DOWNLOAD P\u00daBLICO (antes do auth) ====================",
    "app.get('/download/:file',",
    "allowed = ['LiciteAgora-Browser-win.zip']",
    "res.download(filePath);",
    "// ==================== COMPRASNET AUTO-LOGIN (P\u00fablico - antes do auth) ====================",
    "app.use('/api/comprasnet', comprasnetLoginRoutes);",
    "// ==================== ELECTRON REMOTO (antes do auth) ====================",
    "const { registrarRotasElectron } = require('./electron-routes');",
    "registrarRotasElectron(app, db, { apiKey });",
):
    assert needle in block, 'bloco pre-auth nao contem: ' + needle

# Sanity: a linha imediatamente depois do bloco deve ser em branco + barreira requireAuth
after_block = ''.join(lines[i_electron_call + 1 : i_electron_call + 4])
assert "app.use(requireAuth(" in after_block, \
    'depois do bloco pre-auth deveria vir a barreira requireAuth: %r' % after_block

print('remocoes:')
print('  A) linha %d (require comprasnet)' % (i_require_comprasnet + 1))
print('  B) linhas %d..%d (bloco pre-auth, %d linhas)' %
      (i_portal_header + 1, i_electron_call + 1, i_electron_call - i_portal_header + 1))

# ---------- Replacement do bloco B ----------
replacement_B = [
    "// NFSE-M06 onda 6.37 (2026-04-20): bloco pre-auth (Portal do Cliente +\n",
    "// download publico do Browser + Comprasnet auto-login + Electron remoto)\n",
    "// migrou para pre-auth-routes.js. Fica antes de app.use(requireAuth()) e\n",
    "// preserva a ordem portal > download > comprasnet > electron.\n",
    "const { registerPreAuthRoutes } = require('./pre-auth-routes');\n",
    "registerPreAuthRoutes(app, db, { apiKey });\n",
]

# ---------- Aplica em ordem decrescente ----------
# Remove bloco B primeiro (com replacement), depois remove require A.
lines[i_portal_header : i_electron_call + 1] = replacement_B
# i_require_comprasnet esta antes do bloco, continua valido.
del lines[i_require_comprasnet : i_require_comprasnet + 1]

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
