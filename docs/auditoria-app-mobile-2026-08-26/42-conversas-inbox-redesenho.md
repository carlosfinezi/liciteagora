# 42 — Conversas: a inbox separada da configuração, e redesenhada

**Data:** 2026-09-17
**Base:** [40 — escala tipográfica](40-fase3.5-escala-consumida.md) ·
[41 — funcionalidades](41-conversas-funcionalidades.md)

**Resultado:** as duas fases que faltavam do plano. As telas são estáticas e já
estão no ar. **Restart pendente** do `consulta-licitacoes.service` para um item
só (ver §7).

---

## 1. Por que separar

A tela juntava cinco coisas: a inbox de atendimento e quatro abas de
configuração (Base da IA, Campanhas, Canal, Relatório). A inbox é uso diário e
dividia espaço com o que se configura uma vez por mês.

| | Antes | Depois |
|---|---|---|
| `comunicacao/conversas.html` | 2.272 linhas, 5 abas | **664 linhas**, só a inbox |
| `comunicacao/ia.html` | não existia | 1.808 linhas, 4 abas |
| `style=` inline na inbox | **172** (o recorde do ERP) | **14** |

As duas ficam no mesmo diretório `/comunicacao/`, então o gate de RBAC por
diretório continua o mesmo — mas há uma armadilha nisso, e ela está no §5.

## 2. O que mudou na inbox

| Antes | Depois |
|---|---|
| Toda linha trazia `aberta` e `sem cadastro` | Marca só no **excepcional**: estado diferente de aberta, IA desligada, dono |
| Sem avatar; a coluna era texto corrido | Iniciais do nome, com o contador de não lidas no próprio avatar |
| 4 caixas de KPI, uma com borda vermelha em "753 sem nenhuma resposta" | Números no topo que **filtram** ao clique, e o selecionado se marca |
| Filtros em 4 botões retangulares, 2 linhas | Chips numa linha, sem repetir o que virou número |
| "Selecione uma conversa" + "Nenhuma conversa aberta" | **Um** estado vazio |
| "A ficha do cliente aparece aqui" | A ficha vazia fica **em branco** |
| Subtítulo emendado com travessão | Sem subtítulo; o título já diz |
| 3 painéis com borda dentro de uma página com borda | Uma caixa só, com as colunas divididas por linha |

O número "sem nenhuma resposta" virou filtro de verdade: entrou o recorte
`semResposta` em `conversas-routes.js` (`primeiraRespostaEm IS NULL`).
`aguardando` não servia — lá entra quem escreveu por último, inclusive em
conversa já atendida antes.

## 3. Dois defeitos que a conferência pegou

**O `sidebar.js` sumiu das duas telas.** O corte por intervalo de linhas levou o
`<script>initSidebar(...)</script>` e deixou para trás o `<script src>` da linha
anterior. As telas subiram sem menu. A suíte acusou na primeira rodada com
"initSidebar is not defined".

**A lista parou de rolar.** Sem `min-height:0` e `overflow:hidden` na coluna do
grid, as 300 conversas esticaram a página para **20.595px** de altura — e, como
as colunas do grid compartilham a altura, a conversa e a ficha esticaram junto.
Só apareceu em produção: com as 5 conversas da suíte, nada disso acontece. A
suíte passou a carregar uma fila de 300 exatamente por isso, e o teste foi
sabotado para confirmar que reprova (acusou 20.246px).

**A aba que abre estava em branco.** O painel da Base da IA veio do corte sem a
classe `active`: as quatro abas apareciam e a primeira não mostrava nada, sem
erro em lugar nenhum.

## 4. Verificação

`scripts/test-conversas-ux.js`, etapa **114** do verify, **24 ok**. Sobe Chrome
porque o que está sob teste é o que a pessoa vê: marca que aparece em toda linha
vira textura, e contar `innerHTML` não distingue uma coisa da outra.

As respostas de API são fixas na suíte de propósito. Medir contra o banco vivo
faz o teste reprovar no primeiro uso legítimo do sistema, quando uma conversa
nova muda a contagem.

## 5. A armadilha de permissão de partir uma tela em duas

A metade nova entra no menu com `page` própria (`comunicacao-ia`), e **toda
permissão já gravada em banco deixa de alcançá-la**. O perfil que via a tela
inteira ontem levaria 403 hoje, sem ninguém ter tirado acesso de ninguém. Pior:
não aparece para quem é admin, que é justamente quem testa.

A alternativa seria uma migration mexendo na lista de páginas de cada perfil de
cada tenant. Preferiu-se declarar a herança no código, em `perfis-acesso.js` e
no `sidebar.js`:

```
HERDA_DE = { 'comunicacao-ia': 'conversas' }
```

Quem pode ver Conversas alcança a configuração dela. Quem **nunca** teve
Conversas continua bloqueado — a herança não é porta dos fundos, e há teste para
cada um dos dois lados, mais um terceiro que exige que menu e servidor
concordem: se o menu esconder o que o servidor libera, a tela existe e ninguém
acha o caminho.

## 6. Arquivos

| Arquivo | O quê |
|---|---|
| `public/comunicacao/conversas.html` | reescrita: só a inbox, redesenhada |
| `public/comunicacao/ia.html` | **nova**: Base da IA, Campanhas, Canal, Relatório |
| `public/js/menu-config.js` | entrada "IA e Campanhas" (ícone `🤖` → `bot`, que existe no mapa Lucide) |
| `public/js/sidebar.js` | herança de permissão no menu |
| `perfis-acesso.js` | `HERDA_DE` e o uso dele em `podeVerPath` |
| `conversas-routes.js` | recorte e contagem `semResposta` |
| `scripts/test-conversas-ux.js` | **nova** — etapa 114 |
| `scripts/test-atendimento-horario.js` | G1–G3 passam a ler `ia.html`, que é onde o horário mora agora |

## 7. O que falta entrar em vigor

Só `conversas-routes.js` (recorte `semResposta`) e `perfis-acesso.js` (a
herança). Enquanto o servidor não reiniciar:

- o número "sem nenhuma resposta" **não aparece** no topo — a tela só o desenha
  quando o servidor manda a contagem, e é por isso que ele não aparece errado;
- perfis restritos levam **403** em `/comunicacao/ia.html`. No `1bit` isso não
  afeta ninguém hoje: `admin` é irrestrito e é o único que usa a tela.
