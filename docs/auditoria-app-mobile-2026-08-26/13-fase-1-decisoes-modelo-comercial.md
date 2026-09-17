# Fase 1 — decisões aprovadas e modelo comercial consolidado

Data: 2026-09-10 · Continuação de [`12`](12-fase-1-fundacao-pdv-catalogo.md).

> **Migration NÃO aplicada em produção.** Nenhum serviço reiniciado, nenhum
> commit, nenhum backfill, nada no Asaas, PDV/NFC-e fiscal intocado.

---

## 1. Decisões aprovadas e o que foi feito com cada uma

| # | Decisão | Estado |
|---|---|---|
| 1 | Reutilizar `pedidos.tipo` como origem | **implementado** (Fase 1 anterior) |
| 2 | Alçada em **percentual**, com **fail-closed** e autoridade própria | **implementado** em `pedido-desconto.js` |
| 3 | Fatura **herda** o desconto do pedido | **implementado** em `faturas-routes.js` |
| 4 | CPF/CNPJ **não** obrigatório no catálogo público | **auditado → resposta (C)**, ver §7 |
| 5 | Dedup por documento; telefone **sugere, não funde** | **implementado e testado** |
| 6 | `tipoAtendimento`: `no_local` / `retirada` / `entrega` | **na migration**, valores ajustados |
| 7 | Não conectar `pedido-desconto.js` enquanto depender de coluna | **respeitado** — ver §15 |
| 8 | Revisar as colunas propostas | **feito**: 5 → **6**, com justificativa |

---

## 2. Schema final proposto

**6 colunas. Todas aditivas. Nenhuma tabela nova, nenhuma tabela recriada.**

| # | Tabela | Coluna | Tipo | Default | Null? |
|---|---|---|---|---|---|
| 1 | `pedidos` | `descontoTipo` | TEXT | — | sim |
| 2 | `pedidos` | `descontoValor` | REAL | 0 | sim |
| 3 | `pedidos` | `descontoAplicado` | REAL | 0 | sim |
| 4 | `pedidos` | `descontoMotivo` | TEXT | — | sim |
| 5 | `pedidos` | `tipoAtendimento` | TEXT | — | sim |
| 6 | **`pessoas`** | **`semDocumento`** | INTEGER | 0 | sim |

---

## 3. As colunas, uma a uma

### 3.1 `pedidos.descontoTipo` — TEXT, nullable

**Significado:** como o desconto foi informado — `'valor'` ou `'percentual'`.
NULL = pedido sem desconto.

**Escrevem:** `POST /api/pedidos/:id/desconto` (a criar) e o `PUT` do pedido.
**Leem:** a tela do pedido/PDV, para mostrar "10%" em vez de "R$ 50,00"; o
relatório de descontos concedidos.

**Por que não foi eliminada:** sem ela só resta o valor em reais, e a tela não
consegue devolver ao operador o que ele digitou. É a diferença entre "você deu
10%" e "você deu R$ 50,00" num pedido que mudou de tamanho depois.

### 3.2 `pedidos.descontoValor` — REAL, default 0

**Significado:** o número que o operador digitou (`50` ou `10`), na unidade de
`descontoTipo`. **Não** é o que entra no total.

**Escrevem:** os mesmos da 3.1. **Leem:** tela e auditoria.

### 3.3 `pedidos.descontoAplicado` — REAL, default 0

**Significado:** o abatimento **sempre em R$**, calculado pelo servidor. **É esta
que entra na conta do total.**

**Escrevem:** `pedido-desconto.calcularDesconto` via rota de desconto.
**Leem:** `recalcularTotal` (quando conectado), `descontoDoPedido` e — desde
hoje — `POST /api/pedidos/:id/faturar`, para herdar.

**Por que separada de `descontoValor`:** com desconto percentual, o valor em
reais muda quando um item entra ou sai. Guardar só o percentual obrigaria a
recalcular em todo lugar que lê o total; guardar só os reais perderia a
intenção. As duas juntas descrevem o fato inteiro.

### 3.4 `pedidos.descontoMotivo` — TEXT, nullable

**Significado:** por que o desconto foi dado. É o que o aprovador da alçada lê
antes de decidir.

**Escrevem:** a rota de desconto. **Leem:** a tela de aprovações e o `audit_log`.

**Reavaliada:** poderia ser eliminada, já que `audit_log` registra autor e
`aprovacoes` registra o fluxo. **Mantida** porque a aprovação nasce assíncrona —
o gerente decide depois, olhando uma linha numa lista, e sem o motivo ele decide
no escuro. É a única das seis que carrega informação que nenhuma outra tabela
tem.

### 3.5 `pedidos.tipoAtendimento` — TEXT, nullable

**Significado:** `'no_local'` | `'retirada'` | `'entrega'`. **NULL = pedido que
não declara atendimento** — todos os 64 existentes, e todo pedido do ERP
tradicional daqui para a frente.

**Escrevem:** PDV e catálogo (obrigatório); ERP (opcional).
**Leem:** o painel do PDV, a validação de endereço e o roteiro de entrega.

**Por que não reaproveitei `tipoFrete`:** `tipoFrete` é o CIF/FOB da NF-e —
quem paga o frete, não como o cliente recebe. São eixos diferentes: uma entrega
pode ser CIF ou FOB.

### 3.6 `pessoas.semDocumento` — INTEGER, default 0

**Significado:** `1` = cadastro sem CPF/CNPJ real; a chave em `cpfCnpj` é
identificador interno. `0` = documento fiscal de verdade.

**Escrevem:** o checkout público e o cadastro rápido, quando não houver
documento. **Leem:** o fiscal (para recusar emissão), os relatórios (para
separar os grupos) e a tela de clientes (para sinalizar "completar cadastro").

**Por que existe:** é a alternativa ao `cpfCnpj` nullable — ver §7.

---

## 4. Comportamento da alçada

Uma faixa `(limiteValor = 10, papelAprovador = 'gerente-comercial')` lê-se:
**"desconto acima de 10% exige a autoridade do papel gerente-comercial"**.

Daí saem quatro respostas, nesta ordem:

| Situação | Resposta | `autoridade` |
|---|---|---|
| **Nenhuma faixa cadastrada** | ver §5 (fail-closed) | — |
| Abaixo da menor faixa | **passa direto** | `alcada_base` |
| Acima de uma faixa, **e o solicitante já tem o papel que ela exige** | **passa direto, sem aprovação** | `propria` |
| Acima de uma faixa cuja autoridade ele não tem | vai ao motor de aprovação | — |

**O terceiro caso é a mudança que você pediu.** Um gerente que dá 20% cai na
faixa de 10%, cuja autoridade é justamente a dele — não faz sentido pedir que
outro gerente aprove o que ele mesmo aprovaria. Testado em `E3-b`.

`admin` satisfaz qualquer papel, exatamente como `podeDecidir` já faz do outro
lado do balcão. Divergir disso criaria duas noções de autoridade no mesmo fluxo.

**Cadastro de "vendedor até 10%, gerente até 25%":**

| `limiteValor` | `papelAprovador` | Efeito |
|---:|---|---|
| **10** | `gerente-comercial` | até 10% qualquer um aplica; acima, precisa de gerente — e o gerente aplica direto |
| **25** | `admin` | acima de 25%, só admin — e o admin aplica direto |

O motor **não foi alterado**. `regras_alcada.limiteValor` é REAL e
`regraAplicavel` só compara números; o que muda é a unidade lida para este
`tipoEvento`.

---

## 5. Fail-closed — sem alçada, desconto é 0%

**Antes:** tabela de faixas vazia era lida como "nada a barrar", e qualquer
desconto passava. Para o balcão isso é inaceitável.

**Agora:**

| Ator | Sem nenhuma faixa cadastrada |
|---|---|
| Vendedor, gerente, qualquer perfil restrito | **desconto máximo 0%** — `{ liberado: false, status: 'sem_alcada' }` |
| **Ator privilegiado** | passa — `{ liberado: true, autoridade: 'privilegiado' }` |
| Chamada por `X-Api-Key` (sem `req.user`) | passa como `sistema` |

**Privilegiado é `politicas.atorIrrestrito`** — o mesmo que o preço e o vendedor
já usam: `role='admin'`, X-Api-Key, ou usuário cujo role não tem perfil
cadastrado. **Reutilizado de propósito**: uma terceira definição de
"privilegiado" no mesmo fluxo é como nascem divergências de permissão. Por isso
`atorIrrestrito` passou a ser exportado.

Duas notas importantes:

1. **Não bloqueia venda, bloqueia desconto.** O pedido continua saindo pelo
   preço oficial. E desconto zero é sempre aceito (`E0-a`).
2. **Fail-closed também quando a governança está indisponível** — tenant sem as
   tabelas de aprovação não vira "tudo liberado". É o oposto do fail-open que o
   resto do módulo usa para *perfil*, e é deliberado: não saber qual é a alçada
   não é razão para presumir que não há nenhuma.

> ⚠️ **Efeito colateral que precisa ficar dito** (§13): se um tenant **não
> cadastrar perfil** para o role do gerente, `atorIrrestrito` aplica o fail-open
> de `perfis-acesso.js` e ele vira **privilegiado** — escapando do fail-closed.
> Descobri isso porque meu próprio teste falhou por esse motivo. A defesa é
> cadastrar perfil para todo role em uso; a alternativa seria endurecer
> `atorIrrestrito`, o que mexeria em preço e vendedor também.

---

## 6. Pedido → fatura

### Caminhos auditados

Sete lugares criam fatura. Só **um** cria fatura a partir de pedido comercial:

| Caminho | Origem dos valores | Alterado? |
|---|---|---|
| **`POST /api/pedidos/:id/faturar`** (`faturas-routes.js:212`) | o pedido | **SIM** |
| `os-routes.js:2326` | a OS (que tem `valorDesconto` próprio) | não |
| `marketplaces-ml.js:540` | a API do ML | não |
| `devolucoes-routes.js:865`, `devolucao-venda.js:320`, `devolucao-compra.js:258` | a nota espelhada | não |
| `nf-avulsa-routes.js:135` | NF avulsa, sem pedido | não |

### A regra implementada

```
corpo NÃO informa valorDesconto  →  HERDA o desconto do pedido
corpo informa valorDesconto      →  SUBSTITUI (nunca soma)
```

**Substitui, não complementa** — e isso é o ponto crítico. Somar seria o pior
dos mundos: quem digita o mesmo desconto de novo (o hábito de hoje, já que a
fatura sempre pediu o número) veria o abatimento **dobrar em silêncio**.

**A distinção é por PRESENÇA do campo, não por valor.** Antes era
`Number(b.valorDesconto) || 0`, que não distingue ausente de zero. Agora:

- omitir `valorDesconto` = "use o do pedido";
- `valorDesconto: 0` = "faturar sem desconto".

Duas guardas novas, que não existiam: desconto **negativo** e desconto **maior
que a fatura** passam a ser recusados com 400.

**Compatibilidade com tenant sem a migration:** `descontoDoPedido` verifica a
coluna por `PRAGMA` e devolve 0 quando ela não existe — o comportamento fica
**idêntico ao de hoje**. É o que permite este código conviver com rollout
parcial sem 500, conforme a decisão 7.

**Rateio por item: não implementado**, conforme sua instrução — e registrando
que `fatura_itens.valorDesconto` **já não é preenchido hoje**, nem para o
desconto digitado ao faturar. Não foi agravado por esta fase.

---

## 7. Auditoria: `cpfCnpj` nullable

### Resposta objetiva: **(C) — outra solução é tecnicamente melhor.**

### O que foi medido

| Vetor | Resultado |
|---|---|
| Arquivos que tocam `cpfCnpj` | **95 `.js` + 30 `.html`**, 364 ocorrências |
| **Chamadas de método direto** (`.replace`, `.trim`, `.slice`…) que quebrariam com NULL | **3** |
| — `pedidos-routes.js:1765` | é de **transportadoras**, outra tabela, e já tem guarda `if (!b.cpfCnpj)` → **não afetado** |
| — `nfse-xml.js:176` e `nfse-routes.js:623` | usam `tomador.cpfCnpj`, e o tomador vem de **`req.body.tomador`**, não de `pessoas` → **não afetados**. Emitir NFS-e exige documento no payload, que é onde deve ser exigido |
| Lookups `WHERE cpfCnpj = ?` | todos condicionais (`digits ? … : null`, `if (doc)`) → não quebram |
| `detectarTipoPessoa` | já é `(cpfCnpj \|\| '')` → **seguro com NULL** |
| Índice `UNIQUE(cpfCnpj)` com NULL | **comprovado em execução**: N NULLs convivem e o duplicado real continua barrado (`SQLITE_CONSTRAINT_UNIQUE`) |

Até aqui, o código **aguentaria** NULL com adaptações pequenas. O problema não é
o código — é o schema.

### O impeditivo

**O SQLite não tem `ALTER COLUMN`** (comprovado: `near "ALTER": syntax error`,
versão 3.51.1). Remover o `NOT NULL` exige o procedimento de 12 passos —
**recriar `pessoas`, copiar os dados, dropar, renomear**.

E `pessoas` é referenciada por **32 tabelas**:

```
contas_a_receber, pedidos, faturas, os_ordens, contratos, devolucoes,
crm_oportunidades, crm_atividades, crm_propostas, comissoes_regras,
cliente_logins, contas_a_pagar, pedidos_compra, nfe_entrada, patrimonio_bens,
ssl_certificados, locacao_contratos, prod_projetos, cotacao_fornecedores,
pessoas_contatos, pessoas_enderecos_adicionais, pessoas_dados_bancarios,
pessoas_anexos, pessoas_documentos, optica_receitas, comm_envios,
comm_lista_membros, cobrancas_log, nfse_recorrencias, contas_pagar_recorrencias,
romaneio_paradas, fornecedor_integracoes
```

Recriar a tabela central do cadastro, em 13 bancos, é **o oposto de aditivo** —
e a sua instrução foi que a migration fosse aditiva e com rollback lógico.

### A solução proposta (C)

**`cpfCnpj` continua NOT NULL, recebendo um identificador interno, e a coluna
nova `pessoas.semDocumento` torna o estado explícito.**

Justificativa arquitetural, que você pediu antes de aceitar prefixo:

1. **O ERP já faz exatamente isso, em produção, e não fui eu que inventei.**
   Quatro cadastros hoje têm em `cpfCnpj` valores que não são documento:
   `EX-NICSRS`, `EX-CONTABO`, `TARIFA-asaas` e `193099`. Mais
   `resolverClienteDeParticipacao`, que grava `UASG-<código>` quando a licitação
   não traz CNPJ. O padrão existe, está em uso e nenhuma rotina fiscal o
   confunde com documento.
2. **O que falta hoje é a explicitude, não o padrão.** Sem a coluna, saber se um
   cadastro tem documento exige adivinhar pelo prefixo — frágil e não
   consultável. Com `semDocumento = 1`, o fiscal barra com um `WHERE`, o
   relatório separa os grupos e a tela sinaliza "completar cadastro".
3. **O identificador não se passa por documento.** CPF e CNPJ são só dígitos, 11
   ou 14. Qualquer chave com letra é rejeitada por qualquer validador — inclusive
   os do próprio ERP.

**O formato exato do identificador ainda precisa da sua aprovação (§14, item 3)**
— proponho algo como `SD-<hex>`, mas não gravei nada e não há código que o
gere ainda.

### O que NÃO fiz

Não criei CPF falso, não usei valor com cara de documento válido, e **não
escrevi nenhuma linha que gere identificador** — a decisão do formato é sua.

---

## 8. Deduplicação de cliente

| Cenário | Comportamento |
|---|---|
| **Com CPF/CNPJ** | chave forte. `UNIQUE(cpfCnpj)` resolve; `POST /api/pessoas` já atualiza em vez de duplicar e reativa inativo |
| **Sem documento, telefone igual** | a busca **encontra e sugere**; **nunca funde** |

Testado em `K2`: duas pessoas distintas com o mesmo telefone aparecem **as duas**
na busca, continuam distintas, e nenhuma é inativada ou reescrita.

Por que não fundir: telefone é reaproveitado, compartilhado em família e digitado
errado. Mesclar duas pessoas é irreversível na prática — histórico, crédito,
comissão e contas vão junto. A ambiguidade tem que chegar à tela e ser decidida
por gente.

O cadastro rápido do PDV continua criando **pessoa normal do ERP**, completável
depois em Comercial → Clientes & Fornecedores.

---

## 9. Tipo de atendimento

| Modo | Cliente | Endereço | Frete | Obrigatório em |
|---|---|---|---|---|
| `no_local` | sim | não | ≥ 0, normalmente 0 | `tipo='pdv'` |
| `retirada` | sim | não | ≥ 0 | `tipo='pdv'` e `'catalogo'` |
| `entrega` | sim | **sim** | ≥ 0 | `tipo='pdv'` e `'catalogo'` |

- **Pedidos antigos continuam válidos com NULL** — testado em `J2`, inclusive a
  confirmação.
- **Data/hora de retirada**: `dataEntregaPrevista` já existe e serve; não
  proponho coluna nova.
- O endereço pode vir do cadastro, de `pessoas_enderecos_adicionais` ou ser
  digitado — os campos do pedido são override, por desenho.
- A **obrigatoriedade** para `pdv`/`catalogo` ainda **não é aplicada**: depende
  da migration e da conexão do módulo. O teste `J3` documenta esse estado atual
  em vez de fingir que já vale.

---

## 10. Migration final

`scripts/migrate-fase1-pedido.js` — **6 colunas**, duas tabelas.

- **Dry-run por padrão**; escreve só com `--aplicar`.
- **Recusa `--aplicar` sem tenant nomeado** (sai com código 2).
- Só `ALTER TABLE ADD COLUMN`. Nenhuma coluna removida, nenhuma tabela
  recriada, **nenhum dado reescrito**.
- Colunas nascem NULL/0 → **todo pedido existente mantém o total de antes**
  (teste `A3`).
- Idempotente, com conferência por `PRAGMA` antes e depois (teste `A2`).
- **Não semeia faixas de alçada** — os percentuais são seus.

**Rollback lógico:** parar de escrever nas colunas. `recalcularTotal` volta a
somar itens + frete, a fatura volta a herdar 0 e nada mais muda. `DROP COLUMN`
não está no script de propósito (risco maior que o benefício num banco com
índices e FKs).

Dry-run de hoje: **6 colunas a criar em cada um dos 13 tenants. Nada escrito.**

---

## 11. Testes

`scripts/test-fase1-desconto-origem.js` — **57 testes, 57 OK, 0 falhas.**
A migration é aplicada no descartável **pelo próprio script que rodará em
produção**.

| Bloco | Cobertura |
|---|---|
| **A. Migration** (3) | 6 colunas criadas; idempotente; pedido antigo mantém o total |
| **B. Origem** (6) | ERP/PDV/app; origem interna forjada recusada; desconhecida → `manual`; vocabulário completo |
| **C. Desconto** (8) | percentual, valor, zero, > subtotal, negativo, > 100%, tipo inválido, subtotal zero |
| **D. Total** (4) | `itens − desconto + frete`; frete negativo não reduz; nunca negativo; **não altera o item** |
| **E0. Fail-closed** (4) | **sem alçada + 0% aceita**; **sem alçada + >0 rejeita**; **admin passa**; **gerente é barrado** |
| **E. Alçada** (10) | alçada base; acima abre pendente; **gerente dentro da própria aplica direto**; **gerente acima exige admin**; **admin direto**; faixa de maior limite; aprovada consome; valor travado; zero; X-Api-Key |
| **F/K. Cliente** (5) | telefone com/sem máscara; documento; cadastro rápido; cliente obrigatório; **telefone duplicado sugere sem fundir** |
| **I. Pedido → fatura** (5) | **herda**; sem desconto compat; **substitui, não soma**; **zero explícito**; negativo/maior recusado |
| **J. Atendimento** (4) | `no_local`/`retirada`/`entrega`; ERP com NULL confirma; PDV nasce NULL; endereço só na entrega |
| **G/H. Regressão** (8) | estoque reserva/baixa; frete e quantidade negativos 422; preço do restrito; 410 |

### Regressão

`npm run verify` → OK. `test-app-backend` **79 OK**, `test-fase0-pagamento-pedido`
15 OK, `test-reservas-pedido` 11, `test-venda-perdida-pedido` 16, `test-metas-bi`
21, `test-deposito-movimentacao` 14, `test-devolucao-venda-espelho` 17,
`test-devolucoes-*` 22 + 22 — **todos 0 falhas**.

Falhas **pré-existentes**, não corrigidas: `test-cartao-recebiveis` (1),
`test-notas-unificadas` (1, sobre numeração nNFSe/nDPS), `test-comissoes`,
`test-boletos-pagar`, `test-pedido-compra`, e as de OS/ML documentadas no
relatório 12. **Nenhuma delas usa `POST /api/pedidos/:id/faturar`** — as de
fatura inserem direto na tabela (verificado por grep).

---

## 12. Rollout proposto

| Etapa | O quê | Estado |
|---|---|---|
| **1** | banco descartável | ✅ **feito** — migration aplicada e 57 testes verdes |
| **2** | um tenant interno/de teste | ⚠️ **ver abaixo** |
| **3** | validar pedido manual, PDV/catálogo simulado, faturamento, estoque, desconto | pendente |
| **4** | demais tenants | pendente |

### ⚠️ Não existe tenant interno ou de teste

Você pediu para informar em vez de escolher um cliente real. **Informo: não
existe.** Os 13 são todos de gente real:

| Perfil | Tenants |
|---|---|
| **Seus** (`atendimento@1bit…`) | `1bit` (29 pedidos, 176 pessoas, 103 CRs, loja ativa, boletos Asaas), `jaagricola`, `labfiscal` |
| Clientes ativos | `produtosbomgosto` (21 pedidos), `reimac` |
| Trial | `crsolucoes` (vazio), `josecarloscostafilho` (11 pedidos, 29 CRs) |
| Suspensos | `hseletricista`, `levezi`, `lojasemijoias`, `opendesk`, `pccontabilidade`, `raeldouglas` |

**Candidatos menos ruins, em ordem** — e todos exigem sua palavra:

1. **`crsolucoes`** — TRIAL, **zero pedidos, zero pessoas, zero CRs**. É o mais
   próximo de um sandbox, mas é conta de cliente em avaliação.
2. **`levezi` / `lojasemijoias` / `opendesk` / `pccontabilidade`** — suspensos e
   vazios. Ninguém usa, mas o dado é do cliente.
3. **`labfiscal`** — seu, praticamente vazio (1 pessoa, 2 CRs).

**Minha recomendação:** criar um tenant novo só para isso (`sandbox` ou
`liciteagora-teste`) pelo control plane, em vez de usar conta de terceiro.
Custa um provisionamento e resolve este e todos os rollouts futuros. **Não
criei** — seria criar tenant em produção sem autorização.

---

## 13. Riscos

| Risco | Gravidade | Situação |
|---|---|---|
| **Role sem perfil cadastrado escapa do fail-closed** | **média** | §5 — `atorIrrestrito` é fail-open por desenho; endurecer mexeria em preço e vendedor |
| Formato do identificador sem documento indefinido | média | §7 — nada gerado ainda |
| Obrigatoriedade de `tipoAtendimento` não aplicada | baixa | depende da migration; `J3` documenta |
| Desconto na fatura substitui em silêncio | baixa–média | é a regra aprovada; a tela precisa mostrar o herdado para o operador não redigitar |
| Rateio de desconto por item | baixa | **já não existe hoje**, não agravado |
| Sem tenant de teste | **média** | §12 |
| `pedido-desconto.js` ainda não ligado | informativo | proposital |
| As mudanças no disco não estão no processo | informativo | só valem no próximo restart |

---

## 14. Decisões que ainda precisam de você

**1. Aplicar a migration** — 6 colunas, e em qual tenant primeiro (§12).

**2. Criar um tenant sandbox?** Recomendo, para não usar conta de cliente.

**3. Formato do identificador de cliente sem documento.** Proponho `SD-<hex>`
(letras ⇒ nunca confundido com CPF/CNPJ), com `semDocumento = 1`. Não gerei
nada.

**4. Os percentuais das faixas de alçada.** Sem faixas, **agora o desconto é 0%**
para todo perfil restrito — o fail-closed está ligado nos testes e passará a
valer quando o módulo for conectado. Sem seus números, ninguém dá desconto.

**5. Conectar `pedido-desconto.js`** às rotas, depois da migration. Envolve
`recalcularTotal`, `PUT /api/pedidos/:id` e a rota nova
`POST /api/pedidos/:id/desconto`.

**6. A tela deve mostrar o desconto herdado ao faturar?** Recomendo que sim —
sem isso o operador redigita por hábito e o "substitui" vira surpresa.

**7. Endurecer `atorIrrestrito`** para o fail-closed não ter escapatória? Mexe
em preço e vendedor também; por isso não fiz.

---

## 15. Confirmação

- **Migration NÃO aplicada em produção** — só dry-run (13 tenants) e execução
  em `/tmp`. Conferido: 0 colunas novas em produção.
- **`pedido-desconto.js` não foi conectado** às rotas de pedido. A única função
  dele usada em produção é `descontoDoPedido`, em `faturas-routes.js` — e ela é
  **tolerante à ausência da coluna** (devolve 0), então não há risco de 500 em
  rollout parcial. Era exatamente a condição da decisão 7.
- **Nenhum serviço reiniciado**; `liciteagora.service` e scheduler intocados.
- **Banco de produção não alterado**; nenhum backfill; nada no Asaas.
- **Nenhum commit**, nenhum `reset`/`stash`/`clean`.
- PDV/NFC-e fiscal intocado; nenhum frontend criado.
- Arquivos de aplicação alterados nesta etapa: **3** —
  `pedido-politicas.js` (exporta `atorIrrestrito`), `pedido-desconto.js`
  (alçada com fail-closed), `faturas-routes.js` (herança do desconto).
