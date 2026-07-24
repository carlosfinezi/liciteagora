#!/usr/bin/env python3
"""Edit server.js for onda 6.23: extract 3 contiguous banner sections
(PALAVRAS-CHAVE DE ALERTA, SESSÃO DE MONITORAMENTO EXTENSÃO, ROTAS DE
LICITAÇÕES A MONITORAR) to chat-monitoramento-routes.js.

Block boundaries:
  START: '// ==================== PALAVRAS-CHAVE DE ALERTA ====================' (~line 4806)
  END:   line just before '// ==================== ROTAS DE MENSAGENS CAPTURADAS ====================' (~line 5060)

We keep the blank line before the next banner as visual separator.
"""
path = 'server.js'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# --- 1) Locate block start ---
block_start = None
for i, L in enumerate(lines):
    if L.strip().startswith('// ==================== PALAVRAS-CHAVE DE ALERTA'):
        block_start = i
        break
assert block_start is not None, "banner 'PALAVRAS-CHAVE DE ALERTA' not found"

# --- 2) Locate block end: line of next banner 'ROTAS DE MENSAGENS CAPTURADAS' ---
next_banner = None
for j in range(block_start, len(lines)):
    if lines[j].strip().startswith('// ==================== ROTAS DE MENSAGENS CAPTURADAS'):
        next_banner = j
        break
assert next_banner is not None, "next banner 'ROTAS DE MENSAGENS CAPTURADAS' not found"

# Sanity: blank line right before the next banner
assert lines[next_banner - 1].strip() == '', repr(lines[next_banner - 1])

# Deletion range: [block_start : next_banner - 1] exclusive
# (preserve the blank line that separates us from the next banner)
del_end = next_banner - 1

# --- 3) Sanity: 15 routes + 3 sub-banners present ---
block_text = ''.join(lines[block_start:del_end])
for needle in (
    "// ==================== PALAVRAS-CHAVE DE ALERTA",
    "// ==================== SESSÃO DE MONITORAMENTO (EXTENSÃO)",
    "// ==================== ROTAS DE LICITAÇÕES A MONITORAR",
    "app.get('/api/chat/palavras-chave',",
    "app.post('/api/chat/palavras-chave',",
    "app.delete('/api/chat/palavras-chave/:id',",
    "app.get('/api/chat/monitoramento/sessao',",
    "app.post('/api/chat/monitoramento/sessao',",
    "app.delete('/api/chat/monitoramento/sessao',",
    "app.get('/api/chat/captura/verificar/:compraId',",
    "app.get('/api/chat/captura/completas',",
    "app.post('/api/chat/leitura/marcar',",
    "app.post('/api/chat/leitura/marcar-todas',",
    "app.get('/api/chat/licitacoes-monitorar',",
    "app.post('/api/chat/licitacoes-monitorar',",
    "app.post('/api/chat/licitacoes-monitorar/url',",
    "app.delete('/api/chat/licitacoes-monitorar/:id',",
    "app.patch('/api/chat/licitacoes-monitorar/:id',",
):
    assert needle in block_text, f"expected {needle!r} in block"

# Sanity: line before block is blank
assert lines[block_start - 1].strip() == '', repr(lines[block_start - 1])

print(f'chat-monitoramento block: [{block_start}:{del_end}]  delete={del_end - block_start}')

# --- 4) Delete block ---
del lines[block_start:del_end]

# --- 5) Insert factory call after registrarRotasExtensaoChrome call ---
target_call = 'registrarRotasExtensaoChrome(app, db, { getConfigValue, enviarNotificacaoTelegram, getMonitor: () => monitorMensagens });'
for i, L in enumerate(lines):
    if L.strip() == target_call:
        lines.insert(i + 1, 'registrarRotasChatMonitoramento(app, db);\n')
        break
else:
    raise AssertionError("registrarRotasExtensaoChrome call not found")

# --- 6) Insert require after registrarRotasExtensaoChrome require ---
target_req = "const { registrarRotasExtensaoChrome } = require('./extensao-chrome-routes');"
for i, L in enumerate(lines):
    if L.strip() == target_req:
        lines.insert(i + 1,
            "const { registrarRotasChatMonitoramento } = require('./chat-monitoramento-routes');\n")
        break
else:
    raise AssertionError("registrarRotasExtensaoChrome require not found")

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print('server.js edit OK, total lines:', len(lines))
