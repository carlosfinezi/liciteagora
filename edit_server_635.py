#!/usr/bin/env python3
"""Edit server.js for onda 6.35: varre comentarios "ja extraido" sem codigo.

Apos 10 ondas de extracao, o server.js acumulou blocos descritivos que
apenas explicam o que foi movido -- nenhum codigo vivo. Removemos em
uma so passada 10 blocos (~38 linhas); o blank-run sweep consolida
espacos vazios em seguida.

Nao ha mudanca de comportamento: puramente cosmetico/ruido.

Blocos removidos (todos 100% comentario, confirmado por grep/inspecao):
  1. CERTIFICADO DIGITAL -- onda 6.7
  2. ALERTA DISPUTA -- onda 5C passo 2
  3. verificador de lacunas -- onda 5C passo 2
  4. PROPOSTAS -- onda 6.2
  5. GRUPOS DE PALAVRAS -- onda 6.3
  6. JORNAL -- onda 6.6
  7. BACKUP -- onda 6.4
  8. ANALISE IA (header) -- onda 6.5
  9. BI -- onda 6.1
 10. ANALISE IA (Bloco B) -- onda 6.5
"""
path_server = 'server.js'
with open(path_server, 'r', encoding='utf-8') as f:
    lines = f.readlines()

def find_exact(needle, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].rstrip('\n') == needle:
            return i
    raise AssertionError('not found (exact): ' + (label or needle))

def find_prefix(prefix, start=0, label=''):
    for i in range(start, len(lines)):
        if lines[i].startswith(prefix):
            return i
    raise AssertionError('not found (prefix): ' + (label or prefix))

# (first_line_exact, count, label)
BLOCKS = [
    ('// ==================== CERTIFICADO DIGITAL \u2014 extra\u00eddo ====================',
     3, 'certificado'),
    ('// ==================== ALERTA DISPUTA (Telegram 30 min antes) ====================',
     6, 'alerta_disputa'),
    ('// NFSE-M06 onda 5C passo 2: o verificador de lacunas (verificarECorrigirLacunas',
     6, 'verificador_lacunas'),
    ('// PROPOSTAS (v1 /api/proposta/enviar + v2 via participa\u00e7\u00f5es)',
     3, 'propostas'),
    ('// GRUPOS DE PALAVRAS-CHAVE (pesquisa/exclus\u00e3o) + rota /pesquisar',
     3, 'grupos_palavras'),
    ('// ==================== JORNAL DE LICITA\u00c7\u00d5ES \u2014 extra\u00eddo ====================',
     3, 'jornal'),
    ('// SISTEMA DE BACKUP E VERSIONAMENTO (backup SQLite + git tags)',
     3, 'backup'),
    ('// ==================== AN\u00c1LISE IA (rotas) \u2014 extra\u00eddo ====================',
     3, 'analise_ia_header'),
    ('// BI \u2014 registrado via bi-routes.js (NFSE-M06 onda 6.1, 2026-04-20).',
     3, 'bi'),
    # Prefix-match porque a linha tem ~30 box-drawings \u2500 no final, dificil
    # de contar byte-a-byte; o prefixo ate "extraido " e inequivoco.
    ('// \u2500\u2500\u2500 ROTAS DE AN\u00c1LISE IA (Bloco B) \u2014 extra\u00eddo ',
     5, 'analise_ia_bloco_b', 'prefix'),
]

# Localiza todos os blocos primeiro (indices originais)
found = []
for entry in BLOCKS:
    if len(entry) == 4 and entry[3] == 'prefix':
        first, count, label, _ = entry
        idx = find_prefix(first, label=label)
    else:
        first, count, label = entry
        idx = find_exact(first, label=label)
    # Sanity: todas as linhas do bloco comecam com //
    for k in range(count):
        assert lines[idx + k].lstrip().startswith('//'), \
            'linha %d do bloco %s nao e comentario: %r' % (k, label, lines[idx + k])
    # Sanity: a linha apos o bloco e blank ou inicia novo bloco/code
    after = lines[idx + count] if idx + count < len(lines) else ''
    # (sem restricao dura aqui, so para debug)
    found.append((idx, count, label, after.rstrip('\n')))
    print('bloco %s: linhas %d..%d' % (label, idx + 1, idx + count))

# Remove em ordem decrescente para nao invalidar indices
for idx, count, label, _ in sorted(found, key=lambda t: -t[0]):
    del lines[idx : idx + count]

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
