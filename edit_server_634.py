#!/usr/bin/env python3
"""Edit server.js for onda 6.34: extrair _logStartupBanner,
_iniciarSchedulersMaster, _iniciarWorkerHttp e o dispatch process.env.ROLE
para role-dispatch.js.

Remove, em um único intervalo contíguo:
  - comentário '// NFSE-M06 (2026-04-20): cada systemd unit tinha sua
    própria corrida para bindar :3000 ...' e seu bloco de 8 linhas
    sobre o split master/worker
  - function _logStartupBanner(role) { ... }
  - function _iniciarSchedulersMaster() { ... }
  - function _iniciarWorkerHttp() { ... }
  - const _SERVER_ROLE = process.env.ROLE || 'master';
  - if (_SERVER_ROLE === 'master') { _iniciarSchedulersMaster(); } else { _iniciarWorkerHttp(); }

Insere no lugar:
  const { createRoleDispatch } = require('./role-dispatch');
  createRoleDispatch({
    db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,
    pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,
    agendarPollingBoletos, iniciarReconciliadorS6,
  }).dispatch();

Ambos os ramos (master/worker) continuam no factory; a semântica é
preservada 1:1 — inclusive o default ROLE='master' quando a variável
de ambiente não está setada (mesmo que produção use scheduler.js para
o master e `ROLE=worker` explícito para o server.js).
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Âncora de início ----------
# O comentário de 8 linhas sobre o split master/worker começa com:
#   // NFSE-M06 (2026-04-20): cada systemd unit tinha sua própria corrida para bindar
idx_start = find_exact(
    '// NFSE-M06 (2026-04-20): cada systemd unit tinha sua própria corrida para bindar',
    label='comentário split master/worker')

# Sanity: próxima linha continua o comentário
assert lines[idx_start + 1].startswith('// :3000 dentro de app.listen()'), \
    repr(lines[idx_start + 1])

# ---------- Âncora de fim ----------
# O dispatch termina com:
#   if (_SERVER_ROLE === 'master') {
#     _iniciarSchedulersMaster();
#   } else {
#     _iniciarWorkerHttp();
#   }
# Procuramos o `}` que fecha o else (penúltima linha, última é blank ou EOF).
idx_if = find_exact("if (_SERVER_ROLE === 'master') {",
                     idx_start + 1, label='if dispatch')
# O bloco é: if {, stmt, } else {, stmt, }
idx_end = idx_if + 4
assert lines[idx_end].rstrip('\n') == '}', \
    'fecho do if/else não encontrado em idx_if+4: ' + repr(lines[idx_end])

# Sanity: trecho do if/else
dispatch_slice = ''.join(lines[idx_if : idx_end + 1])
for needle in (
    "if (_SERVER_ROLE === 'master') {",
    "_iniciarSchedulersMaster();",
    "} else {",
    "_iniciarWorkerHttp();",
):
    assert needle in dispatch_slice, 'if/else dispatch incompleto: falta ' + needle

# ---------- Sanity do bloco completo ----------
block_text = ''.join(lines[idx_start : idx_end + 1])
for needle in (
    "function _logStartupBanner(role)",
    "function _iniciarSchedulersMaster()",
    "function _iniciarWorkerHttp()",
    "app.listen(PORT",
    "iniciarReconciliadorS6(db)",
    "const _SERVER_ROLE = process.env.ROLE || 'master';",
):
    assert needle in block_text, 'bloco startup não contém ' + needle

print('bloco startup+dispatch: linhas', idx_start + 1, '..', idx_end + 1,
      '(' + str(idx_end - idx_start + 1) + ' linhas)')

# ---------- Substituição ----------
replacement = [
    "// NFSE-M06 onda 6.34 (2026-04-20): _logStartupBanner,\n",
    "// _iniciarSchedulersMaster, _iniciarWorkerHttp e o dispatch de\n",
    "// process.env.ROLE migraram para role-dispatch.js. O factory recebe\n",
    "// todas as dependências (db, app, PORT, schedulers...) uma vez e expõe\n",
    "// dispatch(role?) que roda o ramo correto. Produção: consulta-licitacoes\n",
    "// (ROLE=worker) aterra aqui; liciteagora.service usa scheduler.js direto.\n",
    "const { createRoleDispatch } = require('./role-dispatch');\n",
    "createRoleDispatch({\n",
    "  db, app, PORT, apiKey, dbPath, PNCP_API_BASE, getConfigValue,\n",
    "  pncpSync, agendarJornal, agendarRecorrencias, agendarCobrancas,\n",
    "  agendarPollingBoletos, iniciarReconciliadorS6,\n",
    "}).dispatch();\n",
]

lines[idx_start : idx_end + 1] = replacement

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
