# Suítes fora do verify — classificação de 2026-09-17

Levantamento feito no fechamento por frentes de 16-17/09. Na véspera o verify
rodava **26** das **130** suítes de `scripts/`. As outras 104 foram executadas
uma a uma, cronometradas e classificadas.

**Este documento existe por um motivo específico:** boa parte das suítes que
falham descreve comportamento que **mudou de propósito**. Quem for consertá-las
precisa saber que o teste é que está velho, não o código. Sem isso, o conserto
"óbvio" é reverter uma decisão deliberada.

## Resultado

| Grupo | Quantas | O que se fez |
|---|---:|---|
| Passam limpas | 72 | entraram no verify |
| Dependiam de dump em `/tmp` | 27 | consertadas; 17 entraram, 10 caíram no grupo 3 |
| Falham por outro motivo | 17 | **não mexidas** — este documento |
| Fora por construção | 2 | `test-menu-e2e`, `test-catalogo-fase52` |

## O defeito estrutural do `/tmp`, que era maior do que parecia

27 suítes montavam o banco de teste lendo um dump gerado à mão:

```
sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/vp-users-schema.sql
```

`/tmp` é limpo no reboot. Em 17/09, **15 já não rodavam** e **12 passavam só
porque o arquivo ainda estava lá**, de uma sessão anterior.

O que a correção revelou é pior que a fragilidade: **aquele dump era de antes
de 2026-08-20**, quando a tabela `fornecedores` deixou de existir. As 12 que
"passavam" validavam contra um schema congelado havia quase um mês. Ao trocar
pelo schema real, oito delas passaram a falhar — e a falha é legítima.

A correção é o `scripts/schema-de-tenant.js`: abre um tenant em modo somente
leitura e extrai `sqlite_master`. Sem passo manual, sem `sqlite3` no PATH, e o
schema sai sempre atual.

**Por que não o `db-schema.js`:** seria o caminho óbvio e não funciona.
`initSchema` é migration incremental, não criador — contra um banco vazio ele
cria ~50 tabelas e para em `no such table: main.contas_financeiras`.

---

# Grupo 3: as 17 que falham, com a causa de cada uma

## A. Testam a tabela `fornecedores`, removida em 2026-08-20 (14)

Fornecedor deixou de ser tabela própria e virou `pessoas` com categoria. Estas
suítes são anteriores à mudança e morrem em `no such table: fornecedores` (ou
`fornecedor_contatos`).

```
test-boletos-pagar          test-comissoes             test-item14-lab
test-item24-lab             test-orcamento             test-pedido-compra
test-adiantamentos          test-cotacao-rateio        test-nf-config-empresa
test-patrimonio-contabil    test-pix-automatico        test-sugestao-demanda-perdida
test-fornecedores-crud      test-usuarios
```

**O código está certo.** Consertar é reescrever o fixture para criar `pessoas`
com `categoria = 'fornecedor'`. O `test-item24-lab` é o caso mais explícito:
ele reprova com `FALHOU: fornecedores.chavePix existe` — está exigindo uma
coluna de uma tabela que não deveria existir.

Note que `test-nf-config-empresa` estava entre as que "passavam": ela passou a
falhar quando o schema deixou de ser o dump velho. Ela foi **retirada** do
verify por isso.

## B. Cascata da guarda do tipo de OS (2)

`test-os-equipamento` (5 ok, **14 falhas**) e `test-os-notificacoes` (7 ok, 6
falhas).

As 14 falhas da primeira têm uma raiz só, na primeira linha da saída:

```
FALHA OS cria o equipamento a partir dos textos
  -> falhou: Informe o tipo de OS (ele define o tratamento fiscal e financeiro).
```

As 13 seguintes são `Cannot read properties of undefined (reading 'equipamentoId')`
— consequência de a OS não ter sido criada.

**A guarda está funcionando como projetada.** O tipo de OS virou obrigatório no
commit `332da50` (25/08), quando passou a definir tratamento fiscal,
precificação e faturamento. As suítes são anteriores e não informam o tipo.
Consertar é acrescentar `tipoOsId` ao fixture, nunca afrouxar a guarda.

## C. O menu está certo e o teste está velho (1)

`test-menu-perfil` — **202 de 207 casos conformes**, 5 divergências, todas
explicáveis:

- **`pessoas` aparecendo duas vezes**: intencional. A mesma permissão dá acesso
  a "Clientes & Fornecedores" e a "Fornecedores" (`?categoria=fornecedor`),
  consequência da mesma unificação de 20/08.
- **`loja` visível quando o teste a espera oculta**: a chave `loja` virou o
  "Catálogo Online", visível. O que é `oculto: true` hoje é `loja-config`. Há
  comentário em `public/js/menu-config.js:197` explicando que a chave foi
  mantida como permissão de RBAC.

## D. Falha isolada, asserção desatualizada (5)

| Suíte | Placar | Observação |
|---|---|---|
| `test-serie-dps` | 28 ok, 1 falha | autodenuncia: *"schema de produção já tinha serieDps — fixture inválida"* |
| `test-ml-anuncios` | 29 ok, 1 falha | usa mock, não API externa; a asserção é que envelheceu |
| `test-notas-unificadas` | 24 ok, 1 falha | `nDPS` quando não há chave |
| `test-producao-f1` | 171 ok, 1 falha | "três OPs concluídas no período" |
| `test-cartao-recebiveis` | 12 ok, 1 falha | — |

Custo baixo de conserto e alto valor: as quatro primeiras já cobrem quase tudo
e falham num ponto só.

## E. Outras duas, com falha ampla (2)

`test-conciliacao-regras` (3 falhas) e `test-dre-origens` (18 falhas). As duas
saíram do grupo `/tmp` depois da correção do schema; a causa ainda não foi
diagnosticada. São as **únicas do grupo 3 sem explicação fechada**, e portanto
as primeiras a olhar quando alguém retomar.

---

# Fora do verify por construção (2)

- **`test-menu-e2e`** exige credencial: `node scripts/test-menu-e2e.js <usuario>
  <senha> [tenant] [porta]`. Não roda sem interação.
- **`test-catalogo-fase52`** leva ~6 minutos (363s) e tem 1 falha. Sozinha
  aumentaria o verify em 20%.

---

# O que NÃO foi feito, de propósito

Nenhuma das 17 foi consertada. Elas descrevem o sistema como ele era, e três
delas descrevem decisões que continuam valendo: a unificação de fornecedor, a
obrigatoriedade do tipo de OS e a visibilidade do Catálogo Online.

Corrigir cada uma é reescrever o fixture para o schema de hoje. O que não se
deve fazer é o contrário: mexer no código para o teste voltar a passar.
