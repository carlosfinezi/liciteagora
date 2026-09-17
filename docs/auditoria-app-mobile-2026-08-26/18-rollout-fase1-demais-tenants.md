# 18 — Rollout da migration da Fase 1 nos tenants restantes

**Data:** 2026-09-11, 09:28–09:35 BRT
**Referência:** [17 — rollout em `labfiscal`](17-rollout-fase1-labfiscal.md)
**Resultado:** **TODOS MIGRADOS** — 19/19 tenants com as 6 colunas, nenhum dado
comercial alterado, nenhum serviço reiniciado.

**Não feito, por instrução:** ligar `pedido-desconto.js` · ativar alçadas · criar
faixas de desconto · alterar `tipoAtendimento` de pedido existente · backfill ·
alterar `cpfCnpj` · marcar `semDocumento` · mexer no Asaas · corrigir o `[DIGEST]`
· reiniciar serviço · commit.

---

## 1. Tenants encontrados

19 registrados em `control.db`, todos com banco no disco.

| Grupo | Tenants |
|---|---|
| Clientes reais | `1bit`, `crsolucoes`, `hseletricista`, `jaagricola`, `josecarloscostafilho`, `levezi`, `lojasemijoias`, `opendesk`, `pccontabilidade`, `produtosbomgosto`, `raeldouglas`, `reimac` (12) |
| Internos | `labfiscal`, `sandbox`, `sandbox2`…`sandbox6` (7) |

Por status: 5 `ACTIVE` (`1bit`, `jaagricola`, `labfiscal`, `produtosbomgosto`,
`reimac`), 1 `TRIAL` (`josecarloscostafilho`), 13 `SUSPENDED`.

Encontrados também `data/tenants/1bit.db` e `data/tenants/produtosbomgosto.db` —
**arquivos de 0 byte**, de julho, fora de qualquer diretório de tenant. Não são
tenants, não foram tocados. Ficam registrados como lixo a limpar um dia.

## 2. Tenants já migrados (não repetidos)

| Tenant | Colunas | Quando |
|---|---|---|
| `labfiscal` | **6/6** | relatório 17, hoje 08:38 |
| `sandbox` | **6/6** | relatório 14, validação da Fase 1 |

Confirmado por `PRAGMA table_info` antes de qualquer ação. O script **recusa**
tenant já migrado — comportamento exercitado na §6.

## 3. Tenants pendentes

**17**, todos com 0/6 colunas na verificação inicial.

## 4. Ordem escolhida

Risco crescente, deliberadamente **não alfabética**. O critério é que cada tenant
só é tocado depois de o procedimento ter funcionado em algo mais barato de
perder:

| # | Tenant | Status | Pedidos | Itens | Pessoas | Por que aqui |
|--:|---|---|--:|--:|--:|---|
| 1–3 | `sandbox2`, `sandbox3`, `sandbox4` | SUSPENDED | 0 | 0 | 0 | internos, vazios, descartáveis |
| 4–5 | `sandbox6`, `sandbox5` | SUSPENDED | 1 / 2 | 1 / 2 | 1 / 2 | internos com dado, ainda descartáveis |
| 6–11 | `crsolucoes`, `hseletricista`, `levezi`, `lojasemijoias`, `opendesk`, `pccontabilidade` | SUSPENDED | 0 | 0 | 0 | clientes sem movimento e suspensos |
| 12 | `reimac` | **ACTIVE** | 0 | 0 | 0 | sem pedidos, mas ativo e 133 MB |
| 13 | `raeldouglas` | SUSPENDED | 2 | 4 | 2 | pouco dado, suspenso |
| 14 | `jaagricola` | **ACTIVE** | 1 | 1 | 4 | pouco dado, porém ativo |
| 15 | `josecarloscostafilho` | **TRIAL** | 11 | 9 | 41 | volume médio |
| 16 | `produtosbomgosto` | **ACTIVE** | 21 | **505** | 8 | maior volume de itens |
| 17 | `1bit` | **ACTIVE** | 29 | 23 | **176** | maior banco (662 MB), tenant principal |

`raeldouglas` (2 pedidos, SUSPENDED) vem antes de `jaagricola` (1 pedido, ACTIVE)
de propósito: um pedido a mais pesa menos que estar no ar.

## 5. Script de rollout

`scripts/rollout-fase1-tenants.js` — sequencial, lista explícita, abort total no
primeiro erro. Três decisões merecem registro:

1. **A DDL não está nele.** Quem escreve é `migrate-fase1-pedido.js`, chamado
   como subprocesso — o mesmo binário que rodou no `labfiscal`. Duplicar a DDL
   criaria duas fontes de verdade que divergem no dia em que alguém editar uma.
2. **A lista das 6 colunas está nele, e a duplicação é proposital.** Ela não
   executa nada; confere. Se alguém alterar a migration, esta verificação
   reprova — que é exatamente o que se quer.
3. **O hash do DEPOIS usa as colunas capturadas ANTES.** Um `SELECT *` mudaria
   de resultado só porque a migration acrescenta colunas, e a comparação estaria
   medindo a mudança de schema em vez do dado. Esse erro já ocorreu uma vez
   (relatório 17 §5) e devolveu um confortável "tudo igual".

Por tenant, **antes**: arquivo existe → 6 colunas ausentes (nem parcial) →
`integrity_check` → `foreign_key_check` → snapshot (counts, somas, hashes) →
backup `sqlite3 .backup` → backup aberto e conferido. **Depois**:
`integrity_check` → `foreign_key_check` → 6 colunas presentes → **nenhuma coluna
antiga removida** → counts → somas → hashes → comparação → nenhuma coluna nova
preenchida.

## 6. Validação do script antes de usá-lo

| Teste | Resultado |
|---|---|
| `node --check` | OK |
| Dry-run nos 17 | 17/17, nada escrito |
| **Recusa tenant já migrado** | `labfiscal` → `JÁ MIGRADO`, **STOP TOTAL**, `1bit` não tocado |
| Ensaio real em clone de `produtosbomgosto` | 6/6, 8/8 hashes iguais |
| Ensaio real em clone de `1bit` (661 MB) | 6/6, 8/8 hashes iguais |
| Tenants reais após os ensaios | intactos, 0 colunas |

### 6.1 O teste que realmente importa: o detector reprova?

`scripts/test-rollout-fase1.js` — **17 testes, 17 OK**. Existe porque *"hashes
iguais"* só significa alguma coisa se o verificador for capaz de reprovar:

| Caso | Detectado |
|---|---|
| alteração de **um centavo** em `valorTotal` | sim |
| troca de `status`, `vendedorId` ou `tipo` | sim |
| `NULL` virando string vazia | sim (não colidem) |
| `DELETE` de uma linha | sim |
| contagem diferente | sim |
| soma monetária diferente | sim |
| **troca cruzada de valores entre dois pedidos** (soma idêntica, conteúdo trocado) | sim — pelo hash |
| coluna nova acrescentada, dado intacto | **não acusa** (correto) |
| `descontoAplicado` preenchido | sim |
| `tipoAtendimento` preenchido | sim |
| `semDocumento = 1` (backfill indevido) | sim |
| `semDocumento NULL` (default não aplicou) | sim |
| lista de colunas alterada / ordem com repetição | sim |

O caso da troca cruzada é o que separa este verificador de um que só soma
totais: a soma continua igual e o conteúdo não.

## 7. Resultado por tenant

Todos com: backup verificado · integrity antes=ok / depois=ok · FK antes=0 /
depois=0 · migration 6/6 · **8/8 hashes iguais** · 10 somas conferidas · nenhum
preenchimento automático.

| # | Tenant | Backup | Migration | Hashes | Tempo | Resultado |
|--:|---|--:|---|---|--:|---|
| 1 | `sandbox2` | 3,9 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 2 | `sandbox3` | 3,9 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 3 | `sandbox4` | 4,0 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 4 | `sandbox6` | 4,0 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 5 | `sandbox5` | 4,0 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 6 | `crsolucoes` | 3,3 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 7 | `hseletricista` | 4,1 MB | 6/6 | 8/8 IGUAL | 0,4 s | OK |
| 8 | `levezi` | 4,1 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 9 | `lojasemijoias` | 4,1 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 10 | `opendesk` | 4,1 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 11 | `pccontabilidade` | 3,4 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 12 | `reimac` | 132,7 MB | 6/6 | 8/8 IGUAL | 1,6 s | OK |
| 13 | `raeldouglas` | 4,2 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 14 | `jaagricola` | 4,1 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 15 | `josecarloscostafilho` | 4,9 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 16 | `produtosbomgosto` | 4,9 MB | 6/6 | 8/8 IGUAL | 0,3 s | OK |
| 17 | `1bit` | 661,3 MB | 6/6 | 8/8 IGUAL | 19,7 s | OK |

**17/17**, das 09:31:20 às 09:31:46 — cerca de 26 segundos no total.

## 8. Backups

`/home/carlosfinezi/backups/fase1-rollout-20260911/<tenant>/` — 17 diretórios,
**856 MB**. Cada um contém:

```
pncp.db               cópia por `sqlite3 .backup` (nunca cp: o -wal ficaria para trás)
metadata-antes.json   counts, somas e hashes antes
metadata-depois.json  os mesmos, depois
hashes.txt            antes -> depois, com o veredito por tabela
integridade.txt       integrity_check e foreign_key_check
```

Nenhuma senha, token ou segredo foi gravado — os metadados são contagens, somas
e hashes.

Cada backup foi **aberto e consultado** antes de a migration rodar: `integrity_check`
e conferência das 8 contagens contra o original. Backup que nunca foi lido é
esperança, não garantia.

> Observação para quem for restaurar: ao lado de cada `pncp.db` há um
> `pncp.db-shm` e um `pncp.db-wal` de **0 byte**, criados quando o script abriu o
> backup para conferi-lo. São inofensivos — o WAL vazio significa que não há
> transação pendente —, mas leve os três arquivos juntos ou nenhum deles.

## 9. `integrity_check`

`ok` em todos os 17, antes e depois. Reconferido depois do rollout, por uma
verificação independente do script: **19/19 tenants `ok`**.

## 10. `foreign_key_check`

**0 violações** em todos os 17, antes e depois. Reconferido: 19/19 com 0.

## 11. Schema antes e depois

Antes: 0/6 colunas em cada um dos 17. Depois: 6/6 em cada um.

| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| `pedidos.descontoTipo` | TEXT | sim | — |
| `pedidos.descontoValor` | REAL | sim | 0 |
| `pedidos.descontoAplicado` | REAL | sim | 0 |
| `pedidos.descontoMotivo` | TEXT | sim | — |
| `pedidos.tipoAtendimento` | TEXT | sim | — |
| `pessoas.semDocumento` | INTEGER | sim | 0 |

**Nenhuma coluna antiga desapareceu** em tenant nenhum — verificado nome a nome,
comparando a lista de antes com a de depois. Nenhuma coluna foi acrescentada além
destas 6.

Estado final em todos os 19:

```
tenants com 6/6 colunas: 19 de 19
```

## 12. Hashes

8 tabelas por tenant — `pedidos`, `pedido_itens`, `pessoas`, `produtos`,
`faturas`, `fatura_itens`, `contas_a_receber`, `movimentacoes_estoque` — **136
comparações no total, 136 iguais**.

Exemplo (`1bit`, o maior):

```
pedidos                  fc89130f3a871ed983f847948af85e65  ->  fc89130f3a871ed983f847948af85e65  IGUAL
pedido_itens             f3830f68cf56976e174eb1ba1438ad2a  ->  f3830f68cf56976e174eb1ba1438ad2a  IGUAL
pessoas                  5b06917f6617d6b048b5768d7649213b  ->  5b06917f6617d6b048b5768d7649213b  IGUAL
produtos                 d985e69c6bdf63dcc2b58f0a648c243f  ->  d985e69c6bdf63dcc2b58f0a648c243f  IGUAL
faturas                  9fb88f474782d879b88f7586d4395b67  ->  9fb88f474782d879b88f7586d4395b67  IGUAL
fatura_itens             642cf4ade8131356927300f3a2444c85  ->  642cf4ade8131356927300f3a2444c85  IGUAL
contas_a_receber         2212a82bb8b2c9f7518d50fac78994c8  ->  2212a82bb8b2c9f7518d50fac78994c8  IGUAL
movimentacoes_estoque    ca2fdcb29cd9c3320f2e9fc115c2b3aa  ->  ca2fdcb29cd9c3320f2e9fc115c2b3aa  IGUAL
```

## 13. Pedidos históricos

67 pedidos e 545 itens existiam nos tenants migrados. Depois da migration:

- **quantidade idêntica** — conferida por `COUNT(*)` em cada tenant;
- **`pedido_itens` idênticos** — contagem e hash;
- **totais idênticos** — `SUM(valorTotal)`, `SUM(valorFrete)`;
- **`valorPago` idêntico** — `SUM(valorPago)` e hash linha a linha;
- **`status`, `vendedorId`, `tipo`/origem idênticos** — cobertos pelo hash, que
  inclui essas colunas e foi provado sensível a cada uma delas (§6.1);
- **`tipoAtendimento` preenchido: 0 linhas** em todos os tenants;
- **`descontoAplicado <> 0`: 0 linhas**; `descontoTipo` e `descontoMotivo`
  preenchidos: 0 linhas.

Nenhum pedido sofreu recálculo. É o esperado da implementação — `ALTER TABLE …
ADD COLUMN` no SQLite não reescreve linha alguma —, e agora está medido em 67
pedidos reais de 8 tenants, não só deduzido.

Reconferência independente, tenant a tenant, depois do rollout:

| Tenant | Pedidos | Com desconto/tipoAtendimento |
|---|--:|--:|
| `1bit` | 29 | **0** |
| `produtosbomgosto` | 21 | **0** |
| `josecarloscostafilho` | 11 | **0** |
| `raeldouglas` | 2 | **0** |
| `sandbox5` | 2 | **0** |
| `jaagricola` | 1 | **0** |
| `sandbox6` | 1 | **0** |
| demais 10 | 0 | 0 |

## 14. Pessoas

- **quantidade idêntica** em todos (176 no `1bit`, 41 no `josecarloscostafilho`,
  8 no `produtosbomgosto`, …);
- **`cpfCnpj` e `razaoSocial` idênticos** — cobertos pelo hash de `pessoas`;
- **`semDocumento = 1`: 0 cadastros** em todos os 17 tenants migrados agora;
- **`semDocumento NULL`: 0 cadastros** — o default `0` aplicou em toda linha;
- **nenhum backfill**, nenhuma tentativa de detectar documento histórico,
  nenhum `cpfCnpj` alterado.

**Exceção aparente, que não é do rollout:** o `sandbox` tem 54 pedidos com
desconto/`tipoAtendimento` e 3 cadastros com `semDocumento = 1` (todos "Diego do
Balcão"). São dados criados pelos **testes da Fase 1** no relatório 14, meses
antes desta janela — e o `sandbox` **não está entre os 17**, nem foi tocado hoje.
Fica registrado para que a contagem de 19/19 não pareça contraditória.

## 15. Serviços

| Unidade | Antes (09:31:18) | Depois (09:33) |
|---|---|---|
| `consulta-licitacoes.service` | active, PID **3310892**, desde 08:21:57 | active, PID **3310892**, desde 08:21:57 |
| `liciteagora.service` | active, PID **3085849**, desde 06:18:49 | active, PID **3085849**, desde 06:18:49 |

Mesmos PIDs, mesmos horários de início: **nenhum restart** — nem meu, nem
externo. O Hestia não reiniciou nada durante a janela.

Consequência a registrar: os processos em memória **não conhecem** as colunas
novas. Isso é inofensivo porque a migration é aditiva e nenhum código as consulta
(`pedido-desconto.js` segue desligado). As colunas só passam a ser lidas quando
houver restart **e** a fiação for feita — duas coisas, nenhuma delas aqui.

## 16. Journal

`consulta-licitacoes.service`, desde 09:31:

| Padrão | Ocorrências |
|---|--:|
| `no such column` | **0** |
| `SQLITE_ERROR` | **0** |
| `SQLITE_` (qualquer) | **0** |
| `Error:` | **0** |
| `desconto` | **0** |
| `tipoAtendimento` | **0** |
| `semDocumento` | **0** |

Nenhum 500. Nenhuma menção a `pedidos`, `pessoas` ou `faturas` em contexto de
erro.

**Ruído pré-existente, separado explicitamente e NÃO corrigido nesta janela:**

- `[DIGEST] no such table: licitacoes` — **0 ocorrências desde 09:31**, porque o
  ciclo roda às 08:00. Já documentado no relatório 17 §15: a origem é
  `sniper-lance-routes.js` consultando `licitacoes` no banco do tenant, e
  **nenhum dos 19 tenants tem essa tabela** (o catálogo migrou para PostgreSQL).
  Falha em todos igualmente, desde antes da Fase 1. **Não é falha da migration e
  não foi corrigido**, conforme instruído.
- `[BNC-Chat 1bit] Sessão BNC expirou` e `[AutoLance] Cache vazio` — igualmente
  pré-existentes, sem relação com esta operação.

Estes três são todo o conteúdo de erro do período. Nenhum outro.

## 17. Falhas

**Nenhuma.** O rollout não abortou em momento algum; o caminho de abort foi
exercitado de propósito em teste (§6), não em produção.

## 18. Conclusão: **TODOS MIGRADOS**

19 de 19 tenants com as 6 colunas da Fase 1. Integridade preservada, chaves
estrangeiras limpas, **136 de 136 hashes idênticos**, nenhum dado comercial
alterado, nenhuma coluna removida, nenhum preenchimento automático, nenhum
serviço reiniciado, backup individual verificado para cada um.

O schema da Fase 1 está no lugar em toda a base. **O comportamento, não** — e a
distinção é o ponto principal deste relatório.

## 19. Próximo passo recomendado

O que existe hoje é uma fundação inerte: seis colunas que ninguém lê nem escreve.
O próximo passo é o primeiro que muda comportamento, e por isso deve ser tratado
como mudança de código e não como migração.

**Recomendado, nesta ordem:**

1. **Ligar `pedido-desconto.js` às rotas de pedido**, com o `verificarAlcadaDesconto`
   em modo fail-closed, começando **por um tenant só** — `labfiscal` ou `sandbox`,
   não um cliente. Este módulo nunca foi exercitado dentro de uma requisição
   real; foi testado isoladamente.
2. **Restart de `consulta-licitacoes.service`** — sem ele o código novo não entra
   em vigor. Atenção à pendência já conhecida: o primeiro restart de
   `liciteagora.service` liga o `cicloAvisoAlcadas` e o watchdog do catálogo
   (CLAUDE.md, "Pendências conhecidas"). Isso é motivo para reiniciar **só o
   worker** nesta etapa.
3. **Cadastrar as faixas de alçada** na tela de governança, com os percentuais
   que a proprietária definir. Nenhum percentual foi semeado, de propósito: um
   número inventado por script vira regra de verdade.
4. Só então avaliar o backfill de `tipoAtendimento` para pedidos históricos —
   que continua **não recomendado**: `NULL` significa "pedido anterior a esta
   fase", e isso é informação, não lacuna.

**Pendências herdadas, fora do escopo desta janela e ainda abertas:** o webhook
Asaas de `josecarloscostafilho` (relatório 11), os 4 pedidos de R$ 10.036,00
aguardando decisão de backfill (relatório 07), NFC-e e NFS-e ainda lendo
documento do corpo da requisição (relatório 15) e o `[DIGEST]` da §16.
