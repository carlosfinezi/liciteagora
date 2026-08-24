# -*- coding: utf-8 -*-
"""Move Faturas para Fiscal e cria o módulo Cobrança com as duas telas dele.

Cobrança vira feature de verdade (catálogo do control-plane + réplica no
tenant), não um bloco solto no menu — senão o super-admin não consegue
ligar/desligar como faz com os outros módulos.
"""
import io, os, re, shutil

# ---------------- 1. arquivos ----------------
MOVIMENTOS = [
    ('public/financeiro/faturas.html',         'public/fiscal/faturas.html'),
    ('public/financeiro/fatura-detalhe.html',  'public/fiscal/fatura-detalhe.html'),
    ('public/financeiro/cobrancas.html',        'public/cobranca/cobrancas.html'),
    ('public/financeiro/cobrancas-config.html', 'public/cobranca/cobrancas-config.html'),
]
for origem, destino in MOVIMENTOS:
    if os.path.exists(destino):
        print('  ja movido: %s' % destino); continue
    if not os.path.exists(origem):
        print('  NAO ENCONTRADO: %s' % origem); continue
    os.makedirs(os.path.dirname(destino), exist_ok=True)
    shutil.move(origem, destino)
    print('  movido: %s -> %s' % (origem, destino))

# ---------------- 2. catálogo canônico de features ----------------
p = 'control-plane-routes.js'
s = io.open(p, encoding='utf-8').read()
alvo = """  { key: 'fiscal', label: 'Módulo Fiscal',"""
novo = """  { key: 'cobranca', label: 'Módulo Cobrança',
    desc: 'Régua de cobrança automática (e-mail/WhatsApp), boletos de cobrança, juros e multa por atraso.' },
  { key: 'fiscal', label: 'Módulo Fiscal',"""
if "key: 'cobranca'" in s:
    print('  control-plane: cobranca ja registrada')
else:
    assert s.count(alvo) == 1, 'ancora do catalogo: %d' % s.count(alvo)
    io.open(p, 'w', encoding='utf-8').write(s.replace(alvo, novo))
    print('  control-plane: feature cobranca registrada')

# ---------------- 3. réplica no tenant ----------------
p = 'features-routes.js'
s = io.open(p, encoding='utf-8').read()
if "'cobranca'" in s:
    print('  features-routes: cobranca ja presente')
else:
    a = "'varejo', 'fiscal', 'financeiro', 'classificacao_fiscal'"
    assert s.count(a) == 1
    io.open(p, 'w', encoding='utf-8').write(s.replace(a, "'varejo', 'fiscal', 'financeiro', 'cobranca', 'classificacao_fiscal'"))
    print('  features-routes: cobranca replicada')

# ---------------- 4. menu ----------------
p = 'public/js/menu-config.js'
s = io.open(p, encoding='utf-8').read()

antigas = """                { page: 'faturas', icone: '📃', texto: 'Faturas', link: '/financeiro/faturas.html' },
                { page: 'cobrancas', icone: '📨', texto: 'Cobranças', link: '/financeiro/cobrancas.html' },
                { page: 'cobrancas-config', icone: '⚙️', texto: 'Cobranças · Config', link: '/financeiro/cobrancas-config.html' },
"""
assert s.count(antigas) == 1, 'entradas antigas: %d' % s.count(antigas)
s = s.replace(antigas, '')

# Faturas entra no Fiscal, junto das notas — é lá que ela emite e cancela NF-e.
alvo_fiscal = """                { page: 'notas-fiscais', icone: '🗂️', texto: 'Notas Fiscais', link: '/fiscal/notas-fiscais.html' },"""
assert s.count(alvo_fiscal) == 1
s = s.replace(alvo_fiscal,
    """                { page: 'faturas', icone: '📃', texto: 'Faturas', link: '/fiscal/faturas.html' },
""" + alvo_fiscal)

# Bloco novo, logo depois do Financeiro.
m = re.search(r"(\n\s*\{\n\s*titulo: 'Contabilidade',)", s)
assert m, 'nao achei o bloco Contabilidade para ancorar'
bloco = """
        {
            titulo: 'Cobrança',
            icone: '📨',
            colapsavel: true,
            feature: 'cobranca',
            itens: [
                { page: 'cobrancas', icone: '📨', texto: 'Régua de Cobrança', link: '/cobranca/cobrancas.html' },
                { page: 'cobrancas-config', icone: '⚙️', texto: 'Configuração', link: '/cobranca/cobrancas-config.html' }
            ]
        },
"""
s = s[:m.start()] + bloco + s[m.start():]
io.open(p, 'w', encoding='utf-8').write(s)
print('  menu atualizado')

# ---------------- 5. link interno que apontava para o caminho antigo ----------------
p = 'public/financeiro/contas-a-receber.html'
s = io.open(p, encoding='utf-8').read()
antes = s
s = s.replace('/financeiro/cobrancas-config.html', '/cobranca/cobrancas-config.html')
if s != antes:
    io.open(p, 'w', encoding='utf-8').write(s)
    print('  contas-a-receber: link para a config de cobranca atualizado')
else:
    print('  contas-a-receber: nada a atualizar')
