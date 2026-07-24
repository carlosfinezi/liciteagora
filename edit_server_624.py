#!/usr/bin/env python3
"""Edit server.js for onda 6.24: extract "ROTAS DE MENSAGENS CAPTURADAS"
block (10 routes in /api/chat/mensagens/*) to chat-mensagens-routes.js.

Block: from banner '// ==================== ROTAS DE MENSAGENS CAPTURADAS ===='
through the last '});' of /api/chat/mensagens/stats, followed by 2 blank
lines and the comment '// Função para auto-iniciar monitoramento de
mensagens'. We preserve a SINGLE blank separator before that comment.
"""
path = 'server.js'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# --- 1) Locate block start ---
block_start = None
for i, L in enumerate(lines):
    if L.strip().startswith('// ==================== ROTAS DE MENSAGENS CAPTURADAS'):
        block_start = i
        break
assert block_start is not None, "banner 'ROTAS DE MENSAGENS CAPTURADAS' not found"

# --- 2) Locate block end: line of '// Função para auto-iniciar monitoramento de mensagens' ---
auto_anchor = None
for j in range(block_start, len(lines)):
    if lines[j].strip() == '// Função para auto-iniciar monitoramento de mensagens':
        auto_anchor = j
        break
assert auto_anchor is not None, "'// Função para auto-iniciar monitoramento de mensagens' anchor not found"

# Sanity: 2 blank lines precede the anchor
assert lines[auto_anchor - 1].strip() == '', repr(lines[auto_anchor - 1])
assert lines[auto_anchor - 2].strip() == '', repr(lines[auto_anchor - 2])

# Delete [block_start, auto_anchor - 1) — keeps ONE blank as separator
del_end = auto_anchor - 1

# --- 3) Sanity: all 10 route declarations (incl. the 2x nao-lidas) ---
block_text = ''.join(lines[block_start:del_end])
for needle in (
    "app.get('/api/chat/mensagens/nao-lidas',",   # should appear twice
    "app.post('/api/chat/mensagens/marcar-lida',",
    "app.post('/api/chat/mensagens/marcar-todas-lidas',",
    "app.get('/api/chat/mensagens',",
    "app.get('/api/chat/mensagens/licitacoes',",
    "app.get('/api/chat/mensagens/orgaos',",
    "app.post('/api/chat/mensagens/:id/lido',",
    "app.post('/api/chat/mensagens/lidas',",
    "app.get('/api/chat/mensagens/stats',",
):
    assert needle in block_text, f"expected {needle!r} in block"

# Double-registration sanity: '/api/chat/mensagens/nao-lidas' appears 2x
nao_lidas_count = block_text.count("app.get('/api/chat/mensagens/nao-lidas',")
assert nao_lidas_count == 2, f"expected /nao-lidas to appear 2x, got {nao_lidas_count}"

# Sanity: line before block is blank
assert lines[block_start - 1].strip() == '', repr(lines[block_start - 1])

print(f'chat-mensagens block: [{block_start}:{del_end}]  delete={del_end - block_start}')
print(f'  /nao-lidas registrations preserved: {nao_lidas_count}')

# --- 4) Delete block ---
del lines[block_start:del_end]

# --- 5) Insert factory call after registrarRotasChatMonitoramento ---
target_call = 'registrarRotasChatMonitoramento(app, db);'
for i, L in enumerate(lines):
    if L.strip() == target_call:
        lines.insert(i + 1, 'registrarRotasChatMensagens(app, db);\n')
        break
else:
    raise AssertionError("registrarRotasChatMonitoramento call not found")

# --- 6) Insert require after registrarRotasChatMonitoramento require ---
target_req = "const { registrarRotasChatMonitoramento } = require('./chat-monitoramento-routes');"
for i, L in enumerate(lines):
    if L.strip() == target_req:
        lines.insert(i + 1,
            "const { registrarRotasChatMensagens } = require('./chat-mensagens-routes');\n")
        break
else:
    raise AssertionError("registrarRotasChatMonitoramento require not found")

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print('server.js edit OK, total lines:', len(lines))
