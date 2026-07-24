#!/usr/bin/env python3
"""Edit server.js for onda 6.36: extrair registrarRotas* pos-auth para
route-registry.js.

Operacoes (indices originais 0-based):
  A) Remove lines 14-32  (linhas 15-33: registrarRotasUsuarios..Licitacoes) -- 19
  B) Remove lines 34-37  (linhas 35-38: createMonitorMensagens..Sniper) -- 4
  C) Split line  38      (linha 39: Nfse + iniciarReconciliadorS6)      (keep reconciliador only)
  D) Split line  39      (linha 40: Financeiro + agendarPollingBoletos) (keep polling only)
  E) Remove lines 40-63  (linhas 41-64: Recorrencia..CFOPs)             -- 24
  F) Remove lines 65-89  (linhas 66-90: Cobrancas..ParticipacaoMonit)   -- 25
  G) Remove line  92     (linha 93: WhatsApp)                            -- 1
  H) Remove lines 226-352 (linhas 227-353: comment Licitacoes + registro
     + Telegram wrappers + blocos MonitorV2..ParticipacaoMonit +
     wiring monitor-mensagens)                                            -- 127
  I) Insere bloco de onda 6.36 + registerProtectedRoutes call NO lugar
     onde o bloco H foi removido.

Remocoes sao feitas em ordem decrescente de indice para nao invalidar.
Splits (C, D) sao feitos em-place -- indices nao mudam.

Ancoras:
  - inicio A: 'const { registrarRotasUsuarios } = require(\\'./usuarios-routes\\');'
  - inicio H: '// NFSE-M06 onda 6.29 (2026-04-20): 5 rotas do catálogo PNCP migradas'
  - fim    H: "registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });"
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Localiza ancoras no bloco de requires ----------
i_usuarios = find_exact(
    "const { registrarRotasUsuarios } = require('./usuarios-routes');",
    label='requer Usuarios')
i_tef = find_exact(
    "const { registrarRotasTEF } = require('./tef-routes');",
    start=i_usuarios, label='requer TEF')
i_monitorv2 = find_exact(
    "const { registrarRotasMonitorV2, inicializarMonitorV2, getMonitor } = require('./monitor-v2-routes');",
    start=i_tef, label='requer MonitorV2')
i_licitacoes = find_exact(
    "const { registrarRotasLicitacoes } = require('./licitacoes-routes');",
    start=i_monitorv2, label='requer Licitacoes')
i_auth = find_exact(
    "const { registrarRotasAuthPublicas, registrarRotasAuthProtegidas } = require('./auth-routes');",
    start=i_licitacoes, label='requer AuthRoutes (KEEP)')
i_createMonitor = find_exact(
    "const { createMonitorMensagens } = require('./monitor-mensagens-core');",
    start=i_auth, label='requer createMonitorMensagens')
i_sniper = find_exact(
    "const { registrarRotasSniper, getSniper, getPuppeteerSession } = require('./sniper-lance-routes');",
    start=i_createMonitor, label='requer Sniper')
i_nfse = find_exact(
    "const { registrarRotasNfse, iniciarReconciliadorS6 } = require('./nfse-routes');",
    start=i_sniper, label='requer Nfse')
i_financeiro = find_exact(
    "const { registrarRotasFinanceiro, agendarPollingBoletos } = require('./financeiro-routes');",
    start=i_nfse, label='requer Financeiro')
i_recorrencia = find_exact(
    "const { registrarRotasRecorrencia } = require('./recorrencia-routes');",
    start=i_financeiro, label='requer Recorrencia')
i_cfops = find_exact(
    "const { registrarRotasCFOPs } = require('./cfops-routes');",
    start=i_recorrencia, label='requer CFOPs')
i_recorr_sched = find_exact(
    "const { agendarRecorrencias } = require('./recorrencia-scheduler');",
    start=i_cfops, label='requer recorrencia-scheduler (KEEP)')
i_cobrancas = find_exact(
    "const { registrarRotasCobrancas } = require('./cobrancas-routes');",
    start=i_recorr_sched, label='requer Cobrancas')
i_parcmon = find_exact(
    "const { registrarRotasParticipacaoMonitoramento } = require('./participacao-monitoramento-routes');",
    start=i_cobrancas, label='requer ParticipacaoMonitoramento')
i_whatsapp = find_exact(
    "const { registrarRotasWhatsApp } = require('./whatsapp-adapter');",
    start=i_parcmon, label='requer WhatsApp')

# Sanity: ordem esperada
assert i_usuarios < i_tef < i_monitorv2 < i_licitacoes < i_auth, \
    'ordem inesperada Usuarios..Auth'
assert i_auth + 1 == i_createMonitor, \
    'createMonitorMensagens deveria vir logo apos Auth: got %d, %d' % (i_auth, i_createMonitor)
assert i_createMonitor + 3 == i_sniper, \
    'Sniper deveria estar 3 linhas apos createMonitorMensagens: %d, %d' % (i_createMonitor, i_sniper)
assert i_sniper + 1 == i_nfse, 'Nfse logo apos Sniper'
assert i_nfse + 1 == i_financeiro, 'Financeiro logo apos Nfse'
assert i_financeiro + 1 == i_recorrencia, 'Recorrencia logo apos Financeiro'
assert i_recorrencia < i_cfops < i_recorr_sched, 'ordem Recorr..Sched'
assert i_recorr_sched + 1 == i_cobrancas, 'Cobrancas logo apos recorrencia-scheduler'
assert i_cobrancas < i_parcmon < i_whatsapp, 'ordem Cobrancas..WhatsApp'

# ---------- Localiza ancoras no bloco de registracoes ----------
i_comment_licit = find_exact(
    '// NFSE-M06 onda 6.29 (2026-04-20): 5 rotas do cat\u00e1logo PNCP migradas',
    start=i_whatsapp, label='comentario onda 6.29 antes de registrarRotasLicitacoes')
i_reg_parcmon = find_exact(
    "registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });",
    start=i_comment_licit, label='ultima registracao pre-role-dispatch')

# Sanity: entre i_comment_licit e i_reg_parcmon estao todos os registros
block_regs = ''.join(lines[i_comment_licit : i_reg_parcmon + 1])
for needle in (
    "registrarRotasLicitacoes(app, db,",
    "registrarRotasMonitorV2(app, db,",
    "registrarRotasSniper(app, getMonitor, db);",
    "registrarRotasNfse(app, db);",
    "registrarRotasCobrancas(app, db);",
    "registrarRotasWhatsApp(app, db);",
    "registrarRotasFinanceiro(app, db);",
    "registrarRotasRecorrencia(app, db);",
    "registrarRotasProdutos(app, db);",
    "registrarRotasPortalAdmin(app, db);",
    "registrarRotasBackup(app, db, { dbPath, PORT });",
    "registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys });",
    "registrarRotasSync(app, db, { pncpSync });",
    "registrarRotasAdmin(app, db, { getConfigValue, setConfigValue });",
    "registrarRotasExtensoes(app, { getConfigValue });",
    "const { MonitorMensagensComprasnet, MonitorChat } = createMonitorMensagens({",
    "const govbrApi = registrarRotasGovBr(app, db,",
    "registrarRotasMonitorMensagens(app, db, { MonitorChat });",
    "registrarRotasExtensaoChrome(app, db,",
    "registrarRotasChatMonitoramento(app, db);",
    "registrarRotasChatMensagens(app, db);",
    "registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram });",
    "async function enviarTelegram(mensagem)",
    "async function enviarNotificacaoTelegram(dados)",
):
    assert needle in block_regs, 'bloco de registracoes nao contem: ' + needle

# Sanity: o bloco NAO contem a linha de role-dispatch (confirma limite superior)
assert "createRoleDispatch({" not in block_regs, 'bloco de registracoes vazou para role-dispatch'

print('requires a remover:')
print('  A) lines', i_usuarios + 1, '..', i_licitacoes + 1, '(19)')
print('  B) lines', i_createMonitor + 1, '..', i_sniper + 1, '(4)')
print('  C/D splits: lines', i_nfse + 1, ',', i_financeiro + 1)
print('  E) lines', i_recorrencia + 1, '..', i_cfops + 1)
print('  F) lines', i_cobrancas + 1, '..', i_parcmon + 1)
print('  G) line', i_whatsapp + 1)
print('  H) lines', i_comment_licit + 1, '..', i_reg_parcmon + 1, '(bloco de registracoes)')

# ---------- C/D Splits em-place ----------
lines[i_nfse] = "const { iniciarReconciliadorS6 } = require('./nfse-routes');\n"
lines[i_financeiro] = "const { agendarPollingBoletos } = require('./financeiro-routes');\n"

# ---------- Replacement do bloco H ----------
replacement_H = [
    "// NFSE-M06 onda 6.36 (2026-04-20): ~55 registros de rotas protegidas\n",
    "// (MonitorV2, Licitacoes, Sniper, NFSe, Cobrancas, Financeiro, suprimentos,\n",
    "// fiscais, wiring do rob\u00f4 monitor-mensagens etc.) + wrappers enviarTelegram /\n",
    "// enviarNotificacaoTelegram migraram para route-registry.js. Depend\u00eancias\n",
    "// passadas uma vez; a ordem interna de registro \u00e9 preservada 1:1.\n",
    "const { registerProtectedRoutes } = require('./route-registry');\n",
    "registerProtectedRoutes(app, {\n",
    "  db, dbPath, PORT,\n",
    "  pncpSync, salvarItens,\n",
    "  PNCP_API_BASE, PNCP_API_ITENS,\n",
    "  getConfigValue, setConfigValue, getIAKeys,\n",
    "});\n",
]

# ---------- Coleta todas as remocoes como (start, end_exclusive) em indices originais ----------
# Ordem importa: removemos em ordem decrescente de start para nao invalidar.
removals = []
removals.append(('H', i_comment_licit, i_reg_parcmon + 1, replacement_H))
removals.append(('G', i_whatsapp, i_whatsapp + 1, []))
removals.append(('F', i_cobrancas, i_parcmon + 1, []))
removals.append(('E', i_recorrencia, i_cfops + 1, []))
removals.append(('B', i_createMonitor, i_sniper + 1, []))
removals.append(('A', i_usuarios, i_licitacoes + 1, []))

# Aplica em ordem decrescente
for label, start, end, repl in sorted(removals, key=lambda t: -t[1]):
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
