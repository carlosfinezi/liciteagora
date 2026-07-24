#!/usr/bin/env python3
"""Edit server.js for onda 6.22: extract the "ROTAS DA EXTENSÃO CHROME"
block (13 routes + monitor-status + 2 in-memory ring buffers) to
extensao-chrome-routes.js.

The block is contiguous: from banner
  '// ==================== ROTAS DA EXTENSÃO CHROME ===================='
through the last '});' of GET /api/chat/navegacao, followed by a blank
separator and the next function declaration
  'async function autoIniciarMonitoramentoMensagens()'.

Inside the block is a SECOND nested banner
  '// ==================== ROTAS DO MONITOR DE MENSAGENS ===='
that we intentionally include in the extraction (the module's JSDoc
documents this). This banner sits between /progresso/:compraId DELETE
and the debug-logs/navegacao cluster.

Note on monitorMensagens: it is a `let` in server.js (line ~127) mutated
by /admin/iniciar-monitor, /admin/parar-monitor, and the auto-iniciar
boot logic. We pass it via a getter closure `() => monitorMensagens`
so the module sees the latest reference, not a stale boot-time value.
"""
path = 'server.js'
with open(path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# --- 1) Locate block start: banner "ROTAS DA EXTENSÃO CHROME" ---
block_start = None
for i, L in enumerate(lines):
    if L.strip().startswith('// ==================== ROTAS DA EXTENSÃO CHROME'):
        block_start = i
        break
assert block_start is not None, "banner 'ROTAS DA EXTENSÃO CHROME' not found"

# --- 2) Locate block end: line before 'async function autoIniciarMonitoramentoMensagens' ---
auto_iniciar = None
for j in range(block_start, len(lines)):
    if lines[j].strip().startswith('async function autoIniciarMonitoramentoMensagens'):
        auto_iniciar = j
        break
assert auto_iniciar is not None, "'autoIniciarMonitoramentoMensagens' anchor not found"

# Expect a comment "// Função para auto-iniciar..." at auto_iniciar-1 and blank at -2
assert lines[auto_iniciar - 1].strip().startswith('// Função para auto-iniciar'), \
    repr(lines[auto_iniciar - 1])
assert lines[auto_iniciar - 2].strip() == '', repr(lines[auto_iniciar - 2])

# Delete up to (but not including) the blank separator
del_end = auto_iniciar - 2  # exclusive — keep the blank line before the comment

# --- 3) Sanity: all 13 routes inside block ---
block_text = ''.join(lines[block_start:del_end])
for needle in (
    "app.get('/api/chat/status',",
    "app.post('/api/chat/keep-alive',",
    "app.post('/api/chat/mensagens/extensao',",
    "app.get('/api/chat/progresso/:compraId',",
    "app.post('/api/chat/progresso',",
    "app.get('/api/chat/progresso',",
    "app.delete('/api/chat/progresso/reset-all',",
    "app.delete('/api/chat/progresso/:compraId',",
    "app.get('/api/chat/monitor-status',",
    "app.post('/api/chat/debug-logs',",
    "app.get('/api/chat/debug-logs',",
    "app.post('/api/chat/navegacao',",
    "app.get('/api/chat/navegacao',",
    "const extensaoDebugLogs = [];",
    "const navegacaoLogs = [];",
    "crypto.createHash('md5')",
    "enviarNotificacaoTelegram({",
    "if (monitorMensagens) {",
):
    assert needle in block_text, f"expected {needle!r} in block"

# Sanity: the line right BEFORE the block is a blank
assert lines[block_start - 1].strip() == '', repr(lines[block_start - 1])

print(f'extensao-chrome block: [{block_start}:{del_end}]  delete={del_end - block_start}')

# --- 4) Delete block ---
del lines[block_start:del_end]

# --- 5) Insert factory call after registrarRotasExtensoes call ---
for i, L in enumerate(lines):
    if L.strip() == 'registrarRotasExtensoes(app, { getConfigValue });':
        lines.insert(i + 1,
            'registrarRotasExtensaoChrome(app, db, { getConfigValue, enviarNotificacaoTelegram, getMonitor: () => monitorMensagens });\n')
        break
else:
    raise AssertionError("registrarRotasExtensoes call not found")

# --- 6) Insert require after registrarRotasExtensoes require ---
for i, L in enumerate(lines):
    if L.strip() == "const { registrarRotasExtensoes } = require('./extensoes-routes');":
        lines.insert(i + 1,
            "const { registrarRotasExtensaoChrome } = require('./extensao-chrome-routes');\n")
        break
else:
    raise AssertionError("registrarRotasExtensoes require not found")

with open(path, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print('server.js edit OK, total lines:', len(lines))
