# 17 — Rollout controlado da migration da Fase 1 no tenant `labfiscal`

**Data:** 2026-09-11, 08:35–08:45 BRT
**Escopo autorizado:** aplicar a migration da Fase 1 **somente** em `labfiscal`.
**Não feito, por instrução:** migration em qualquer outro tenant · ligar
`pedido-desconto.js` às rotas · alterar alçadas · reiniciar serviço · commit ·
backfill · mexer no Asaas.

**Resultado:** migration aplicada, 6 colunas criadas, **nenhum dado comercial
alterado**, integridade preservada, serviços intocados. Recomendação final na
§16.

---

## 1. Identificação do tenant

| Campo | Valor |
|---|---|
| slug | `labfiscal` |
| nome | Lab Fiscal (NF manual + tributação) |
| status | `ACTIVE` |
| plano | enterprise |
| `provision_status` | `NOT_STARTED` |
| proprietário | `atendimento@…` — **o próprio dono do sistema**, não cliente externo |
| banco | `data/tenants/labfiscal/pncp.db`, 4,3 MB |
| última modificação | 2026-09-11 06:18 |

A escolha se sustenta em dois fatos, não em preferência: o dono do tenant é o
próprio operador (nenhum cliente externo é exposto ao risco) e o banco não tem
movimento comercial recente — a última fatura e a última conta a receber são de
**2026-08-25**, 17 dias antes.

## 2. Volume de dados antes da operação

| Tabela | Linhas |
|---|---:|
| `pedidos` | **0** |
| `pedido_itens` | **0** |
| `pessoas` | 1 |
| `produtos` | 11 |
| `faturas` | 3 |
| `fatura_itens` | 3 |
| `contas_a_receber` | 2 |
| `reservas_estoque` | 0 |
| `movimentacoes_estoque` | 22 |
| `users` | 1 |

**O ponto fraco deste rollout está aqui e precisa ser dito antes de qualquer
conclusão:** `labfiscal` tem **zero pedidos**. Toda verificação de "pedido
antigo não foi alterado" é, neste tenant, verdadeira por vacuidade — não porque
a migration preserve pedidos, mas porque não há pedido nenhum para preservar.
Isso é tratado na §11.

## 3. Schema antes

- 364 tabelas · 570 índices · 7 triggers · 0 views
- `pedidos`: 43 colunas · `pessoas`: 74 colunas
- As 6 colunas da Fase 1: **todas ausentes**, confirmado uma a uma via
  `PRAGMA table_info`.

## 4. Backup

```
/home/carlosfinezi/backups/labfiscal-fase1-20260911-083835/pncp.db
```

Gerado com `sqlite3 .backup` — nunca `cp`, que corromperia o banco em WAL.

| Verificação | Resultado |
|---|---|
| `integrity_check` no original, antes | `ok` |
| `integrity_check` no backup | `ok` |
| tamanho original × backup | 4.440.064 = 4.440.064 bytes |
| backup abre e responde | sim — 364 tabelas, contagens idênticas |

O backup não foi considerado válido por existir: foi **aberto e consultado**.
Backup que nunca foi lido é esperança, não garantia.

## 5. Snapshot lógico antes (a prova de que o dado não mudou)

Além das contagens, foram gravadas somas monetárias e uma **impressão digital
sha256 por tabela**:

```
SUM(faturas.valorTotal)            = 270,00
SUM(contas_a_receber.valor)        = 220,00
SUM(movimentacoes_estoque.qtd)     = 1706,2
```

Para `pedidos` e `pessoas` o hash usa uma **lista explícita das colunas antigas**,
não `SELECT *`. Sem isso o hash mudaria só porque a migration acrescenta colunas,
e a comparação não provaria nada — mediria a própria mudança de schema em vez do
conteúdo.

> Nota de método: a primeira versão do script de hash tinha sintaxe SQLite
> inválida e devolvia hash vazio para todas as tabelas — ou seja, "todos iguais".
> Um resultado bom demais. Foi refeito com `sqlite3 -separator '|' … | sha256sum`
> e só então usado como prova.

## 6. Dry-run

`node scripts/migrate-fase1-pedido.js labfiscal` (sem `--aplicar`) listou as 6
colunas a criar e não escreveu nada. O script recusa `--aplicar` sem tenant
nomeado por desenho — não existe modo "todos".

## 7. Aplicação

```
node scripts/migrate-fase1-pedido.js labfiscal --aplicar
→ 6 coluna(s) criada(s) ✔
→ 0 faixa(s) de alçada semeada(s)
```

Nenhuma faixa de alçada foi criada, conforme instruído: os percentuais são
decisão da proprietária, na tela de governança.

## 8. Schema depois

| Coluna | Tipo | Nulo | Default |
|---|---|---|---|
| `pedidos.descontoTipo` | TEXT | sim | — |
| `pedidos.descontoValor` | REAL | sim | 0 |
| `pedidos.descontoAplicado` | REAL | sim | 0 |
| `pedidos.descontoMotivo` | TEXT | sim | — |
| `pedidos.tipoAtendimento` | TEXT | sim | — |
| `pessoas.semDocumento` | INTEGER | sim | 0 |

| Antes | Depois | |
|---|---|---|
| `pedidos` 43 col | 48 col | +5 |
| `pessoas` 74 col | 75 col | +1 |
| 364 tabelas | 364 | 0 |
| 570 índices | 570 | 0 |
| 7 triggers | 7 | 0 |

**Nada foi removido** — nenhuma tabela, coluna, índice ou trigger. A migration é
estritamente aditiva.

## 9. Integridade depois

- `PRAGMA integrity_check` → `ok`
- `PRAGMA foreign_key_check` → sem violações

## 10. Comparação de dados: antes × depois

Todas as contagens idênticas. Todas as somas monetárias idênticas.
**As 8 impressões digitais sha256: IGUAL, sem exceção.**

Conclusão literal: nenhum dado comercial foi alterado pela migration.

## 11. Pedidos antigos — e por que `labfiscal` não basta como prova

Em `labfiscal`: `tipoAtendimento` não-nulo = 0 · `descontoAplicado <> 0` = 0 ·
`descontoTipo` não-nulo = 0 · `SUM(valorTotal)` = 0. Correto, mas **vacuamente
verdadeiro**: são 0 pedidos.

Como a recomendação da §16 vale para tenants que **têm** pedidos, essa lacuna foi
fechada com dado real, sem tocar em cliente nenhum: um **clone descartável** de
`produtosbomgosto` foi gerado em `/tmp` via `.backup` (o banco do cliente só foi
**lido**) e a migration foi aplicada ao clone.

| | Antes | Depois |
|---|---:|---:|
| `pedidos` | 21 | 21 |
| `pedido_itens` | 505 | 505 |
| `SUM(valorTotal)` | R$ 46.069,50 | R$ 46.069,50 |
| `integrity_check` | ok | ok |
| hash dos 21 pedidos (colunas antigas) | — | **IGUAL** |
| hash dos 505 itens | — | **IGUAL** |
| `tipoAtendimento` não-nulo | — | 0 |
| `descontoAplicado <> 0` | — | 0 |

Confirmado ao final que `produtosbomgosto` **real continua sem as colunas** — o
clone não vazou para o tenant.

Isto é o esperado da implementação: `ALTER TABLE … ADD COLUMN` no SQLite não
reescreve linha alguma; grava o default no schema e o devolve na leitura. A
diferença é que agora está **medido em 21 pedidos e 505 itens reais**, e não
apenas deduzido.

## 12. Pessoas sem documento

1 pessoa no tenant · `semDocumento = 0` · nenhuma com `1` · nenhuma `NULL`.
O cadastro existente tem documento de 14 dígitos, legítimo.

**Nenhum backfill foi executado**, conforme instruído. O default `0` da coluna
já deixa todo cadastro antigo corretamente marcado como "tem documento".

## 13. Smoke test (leitura)

| Rota | HTTP |
|---|---|
| `GET /api/usuarios/me` com chave inválida | **401** (fail-closed funcionando) |
| `GET /api/pessoas` | 200 |
| `GET /api/produtos?limit=3` | 200 |
| `GET /api/pedidos` | 200 — lista vazia, `escopo: todos` |
| `GET /api/pedidos/resumo` | 200 |
| `POST /api/produtos/disponibilidade` | 200 |
| `GET /api/contas-a-receber` | 200 |
| `GET /api/faturas` | 200 |
| `GET /api/estoque/posicao` | 404 — **rota inexistente**, chute de URL meu, não regressão |

Nenhum dado foi criado, alterado ou removido no tenant. A única chamada `POST` é
de consulta de disponibilidade, que não escreve.

## 14. Serviços — nada foi reiniciado

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3310892 @ 08:21:57 | **PID 3310892 @ 08:21:57** |
| `liciteagora.service` | PID 3085849 @ 06:18:49 | **PID 3085849 @ 06:18:49** |

Mesmos PIDs, mesmos horários de início: nenhum restart — nem meu, nem externo
(Hestia). Ambos `active`.

Consequência a registrar: o processo em memória **não conhece** as colunas novas.
Isso é inofensivo porque a migration é aditiva e nenhum código as consulta ainda
(`pedido-desconto.js` segue desligado, por instrução). As colunas só passam a ser
lidas quando houver restart **e** a fiação for feita — duas coisas, nenhuma delas
neste rollout.

## 15. Journal

Desde 08:35, em `consulta-licitacoes.service`:

| Padrão | Ocorrências |
|---|---:|
| `labfiscal` | **0** |
| `no such column` | **0** |
| `SQLITE_ERROR` | **0** |
| `Error:` | **0** |

Nenhum 500 relacionado ao tenant.

**Ruído pré-existente encontrado, alheio a esta operação:**
`[DIGEST] erro na query: no such table: licitacoes` + `[DIGEST] tick falhou:
attempt to write a readonly database`, 393 vezes hoje. Não é regressão:

- começou às **08:00:00**, sob o PID **3085545** — o processo *anterior* ao
  restart das 08:21, e 38 minutos antes da migration;
- já ocorria nos dias anteriores (26 ocorrências em 3 dias);
- a origem é `sniper-lance-routes.js`, que consulta `licitacoes` **no banco do
  tenant** — e **nenhum dos 19 tenants tem essa tabela**, porque o catálogo
  migrou para PostgreSQL. Falha em todos, igualmente, desde antes.

É o mesmo perfil das pendências já conhecidas (`participacoes_comprasnet`,
polling de boletos): defeito antigo que falha calado. **Não investigado aqui** —
está fora do escopo autorizado e não tem relação com a Fase 1. Fica registrado
para um dia próprio.

## 16. Recomendação: **GO** para os demais tenants

A recomendação é GO, e o que a sustenta é o seguinte:

1. A migration é **estritamente aditiva** — 6 `ADD COLUMN`, zero remoções, zero
   recriação de tabela. Nenhum índice, trigger ou tabela foi tocado.
2. **Nenhum dado comercial foi alterado** — provado por hash sha256 em duas
   bases: `labfiscal` (8 tabelas, todas iguais) e um clone real de
   `produtosbomgosto` com 21 pedidos, 505 itens e R$ 46.069,50 intactos.
3. Toda coluna nasce **nullable com default seguro**, e o código que as
   consultaria segue **desligado**. Um tenant migrado e um não-migrado se
   comportam de forma idêntica hoje.
4. `integrity_check` e `foreign_key_check` limpos depois da operação.
5. Serviços intocados: a migration **não exige restart** para ser segura.

**Condições que devem acompanhar o GO**, não sendo opcionais:

- **Backup por `sqlite3 .backup` antes de cada tenant**, e o backup deve ser
  *aberto e consultado*, não apenas criado.
- **Um tenant por vez, nomeado.** O script recusa `--aplicar` sem tenant por
  desenho; manter assim.
- **Snapshot de hash antes/depois em cada tenant**, com lista explícita de
  colunas antigas. É a única verificação que reprova de fato se algo mudar.
- **Nenhum backfill** de `semDocumento` ou `tipoAtendimento`. O default resolve.
- **Não ligar `pedido-desconto.js`** junto do rollout. Migrar schema e mudar
  comportamento na mesma janela transforma dois riscos pequenos em um
  indivisível.
- Preferir a ordem **do menor volume de pedidos para o maior**, deixando `1bit`
  e `produtosbomgosto` por último.

**O que ainda não está provado, e por isso não deve ser assumido:** este rollout
valida a *migration*, não a *funcionalidade* da Fase 1. Desconto, alçada, origem
do pedido e tipo de atendimento continuam exercitados apenas em sandbox e em
banco descartável. O GO acima é para o schema — a fiação é uma decisão separada,
com a sua própria janela.
