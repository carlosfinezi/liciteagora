#!/usr/bin/env python3
"""Edit server.js for onda 6.38: varre os dois blocos de comentario stale
que sobraram depois da 6.35.

Bloco 1 (linhas 10-11): criarVerificador foi movido para
pncp-sync-scheduler.js. Sem codigo associado.

Bloco 2 (linhas 96-99): gerarDiasEntre + buscarLicitacoesDoDia + demais
helpers foram movidos para pncp-sync-scheduler.js. Sem codigo associado.

Total removido: 6 linhas. Sem mudanca comportamental.
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

# ---------- Bloco 1: criarVerificador (2 linhas) ----------
i_b1_first = find_exact(
    "// NFSE-M06 onda 5C: criarVerificador s\u00f3 era usado pelo motor PNCP; agora \u00e9",
    label='bloco1 linha1')
# Sanity: segunda linha e continuacao do comentario
assert lines[i_b1_first + 1].rstrip('\n') == \
    "// instanciado internamente em pncp-sync-scheduler.js. Removido daqui.", \
    'bloco1 linha2 nao bate: %r' % lines[i_b1_first + 1]
# Sanity: linha anterior e `puppeteer.use(StealthPlugin());`
assert lines[i_b1_first - 1].rstrip('\n') == 'puppeteer.use(StealthPlugin());', \
    'bloco1 ancora superior nao bate: %r' % lines[i_b1_first - 1]

# ---------- Bloco 2: gerarDiasEntre (4 linhas) ----------
i_b2_first = find_exact(
    "// NFSE-M06 onda 5C passo 2 (2026-04-20): gerarDiasEntre, buscarLicitacoesDoDia,",
    start=i_b1_first + 2, label='bloco2 linha1')
expected_b2 = [
    "// NFSE-M06 onda 5C passo 2 (2026-04-20): gerarDiasEntre, buscarLicitacoesDoDia,",
    "// buscarItensLicitacao, getIAKeys, dispararAnaliseIA, sincronizarCompleta,",
    "// sincronizarIncremental, agendarProximaSync e iniciarWatchdogSync foram",
    "// integralmente movidos para pncp-sync-scheduler.js. Consulte aquele m\u00f3dulo.",
]
for k, want in enumerate(expected_b2):
    got = lines[i_b2_first + k].rstrip('\n')
    assert got == want, 'bloco2 linha%d nao bate: %r != %r' % (k + 1, got, want)

print('remocoes:')
print('  bloco1: linhas %d..%d (criarVerificador)' % (i_b1_first + 1, i_b1_first + 2))
print('  bloco2: linhas %d..%d (gerarDiasEntre et al)' % (i_b2_first + 1, i_b2_first + 4))

# ---------- Aplica em ordem decrescente ----------
del lines[i_b2_first : i_b2_first + 4]
del lines[i_b1_first : i_b1_first + 2]

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
