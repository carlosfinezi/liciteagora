# Provisionamento de tenant e documento fiscal — correção dos dois bloqueadores

Data: 2026-09-11 · Continuação de [`14`](14-sandbox-validacao-fase1.md) §1.5 e §9.2.

> **Nenhum tenant de cliente foi alterado.** A migration da Fase 1 continua só
> no `sandbox`. Nenhum serviço reiniciado, nenhum commit, nenhum backfill, nada
> no Asaas.

---

## 1. Causa raiz do provisionamento

O relatório 14 apontou `faturas.isDevolucao` como causa. **Era só a primeira de
uma cadeia.** Instrumentei um provisionamento real (banco em `/tmp`, com
`db.exec`/`db.prepare` interceptados para capturar até o que o `alterSafe`
engole) e o quadro é maior:

| Camada | O que se descobriu |
|---|---|
| **`initSchema` (db-schema.js)** | **212 ALTERs falhavam em silêncio** — todos `no such table` |
| **Abort da cadeia** | uma exceção abortava `registerProtectedRoutes` e os módulos seguintes **nunca** registravam |
| **Ordem interna nos arquivos** | ALTER escrito **antes** do CREATE da mesma tabela, no mesmo arquivo |
| **Terceira camada de migrations** | módulos que só migram no **boot loop do `server.js`**, que o provisionamento não executava |

### 1.1 Por que 212 ALTERs falhavam

`db-schema.js` acumula migrations de compatibilidade escritas para tenants que
**já existiam** — `ALTER TABLE contas_a_receber ADD COLUMN parcelaNumero`,
`fatura_itens ADD COLUMN valorDesconto`, e assim por diante. Só que
`contas_a_receber` nasce em `financeiro-routes.js` e `fatura_itens` em
`faturas-routes.js`, que rodam **depois**.

Num tenant que já existe, a ordem histórica fazia sentido. Num tenant novo ela
se inverte: o ALTER chega primeiro, cai em `no such table`, o `alterSafe`
engole — e a coluna **nunca nasce**, porque `initSchema` roda uma vez só.

### 1.2 A cadeia de aborts

Não era um caso, eram vários encadeados. Corrigido um, o próximo aparecia:

| Abort | Quem lançava | Por quê |
|---|---|---|
| 1º | `tipos-operacao-routes.js:245` | usava `faturas.isDevolucao`, que o `alterSafe` do `db-schema` não conseguiu criar |
| 2º | `tipos-operacao-routes.js:224` | usava `pedidos.naoEmitirNFe` — ver 1.3 |

O código de `tipos-operacao` **já tinha guards** para `devolucoes` e `os_ordens`,
com comentários explicando exatamente este problema. Faltava perceber que a
classe do defeito era geral, não pontual.

### 1.3 O erro de ordem mais caro: `pedidos` com 20 colunas

Em `db-schema.js`, o bloco
`for (const col of [...]) alterSafe('ALTER TABLE pedidos ADD COLUMN …')`
estava na **linha 1026** e o `CREATE TABLE … pedidos`, na **linha 1217**.
**O ALTER rodava 191 linhas antes do CREATE, no mesmo arquivo.**

Resultado num tenant novo: `pedidos` com **20 colunas** em vez de 43. Faltavam
`transportadoraId`, `tipoFrete`, `valorFrete`, `meioPagamento`, `modoDocumento`,
`tabelaPrecoId`, `politicaPrazoId`, `naoEmitirNFe` e **os dez campos de endereço
de entrega**.

O mesmo padrão em `comissoes-routes.js`: os ALTERs de `comissoes_regras` e
`comissoes_apuracao` vinham antes do `CREATE` das mesmas tabelas, dentro da
própria `migrarDB`.

### 1.4 `pedidos.depositoId` não nascia em lugar nenhum

A coluna só é criada por `scripts/migrate-deposito-documentos.js` — um **script
avulso que nunca roda no provisionamento**. Nenhum tenant novo a tinha, e
`pedidos-routes.js` a escreve no INSERT.

### 1.5 A terceira camada de migrations

Quatro módulos não migram no registro — o comentário deles explica ("contra o
proxy seria no-op"). Eles migram no **boot loop do `server.js`** (`:140-149`),
que itera os tenants a cada inicialização. **O provisionamento não fazia isso**,
e por isso faltavam `faturas.faturaOrigemId`, `fatura_itens.valorDesconto` e o
schema do espelho de devolução.

---

## 2. Correções implementadas

| # | Arquivo | O que mudou |
|---|---|---|
| 1 | **`route-registry.js`** | isolamento por módulo, **ligado só no provisionamento** |
| 2 | **`tenant-provision.js`** | 3 passadas + 2ª passada do `db-schema` + as migrations do boot loop |
| 3 | **`db-schema.js`** | bloco de ALTERs de `pedidos` movido para **depois** do CREATE; `depositoId` acrescentada; `isDevolucao` & cia. **removidas** daqui |
| 4 | **`faturas-routes.js`** | `isDevolucao`, `devolucaoId`, `refNFeOriginal` passam a nascer junto da tabela |
| 5 | **`comissoes-routes.js`** | ALTERs movidos para depois do CREATE |

### 2.1 Isolamento por módulo — e por que não é try/catch vazio

```js
const isolar = !!(deps && deps.isolarFalhasDeMigracao);
const R = (nome, fn) => {
  if (!isolar) return fn();
  try { return fn(); }
  catch (err) {
    falhasDeMigracao.push({ modulo: nome, erro: err.message });
    console.warn(`[route-registry] módulo "${nome}" falhou na migração: ${err.message}`);
  }
};
```

As 124 chamadas viraram `R('Pedidos', () => registrarRotasPedidos(app, db))`.

Três decisões, todas deliberadas:

- **O erro não é escondido**: vai para `console.warn` **com o nome do módulo** e
  volta em `falhasDeMigracao` para quem chamou decidir. O `tenant-provision`
  lista as que sobrevivem às três passadas.
- **No BOOT do servidor nada muda.** Sem a flag, a exceção sobe e o processo
  morre — que é o certo em produção: subir pela metade, escondendo um módulo
  quebrado, é pior do que não subir.
- **Três passadas, com parada objetiva.** As dependências são encadeadas (A cria
  o que B altera; B cria o que C usa). O laço para assim que uma passada não
  deixa nenhuma falha.

### 2.2 Reexecutar o `db-schema` no fim — e por que é seguro

Em vez de mover 212 ALTERs, um a um, para 40 módulos diferentes, o
`tenant-provision` **roda `initSchema` de novo** depois das rotas e do
`criarUsuarioInicial`. Aí todas as tabelas já existem e os ALTERs pegam.

Roda por último de propósito: `users` só nasce em `criarUsuarioInicial`
(`auth.js`), e os ALTERs de `users` precisam dela no lugar.

**É seguro porque `initSchema` é idempotente**, e isso foi **verificado em
execução**, não presumido: rodando duas vezes num banco limpo, **nenhuma das 199
tabelas muda de contagem de linhas**.

### 2.3 Dependências de ordem documentadas

| Depende de | Que é criada por | Como ficou resolvido |
|---|---|---|
| `faturas.isDevolucao` (tipos-operacao) | `faturas-routes` | coluna movida para junto da tabela |
| `pedidos.naoEmitirNFe` e +22 (tipos-operacao) | `db-schema`, mais abaixo | bloco movido para depois do CREATE |
| `comissoes_*` (próprio módulo) | `comissoes-routes` | ALTERs movidos para depois do CREATE |
| `contas_a_receber.*`, `fatura_itens.*` (db-schema) | financeiro/faturas-routes | 2ª passada do `db-schema` |
| `users.*` (db-schema) | `auth.criarUsuarioInicial` | 2ª passada depois dele |
| `faturas.faturaOrigemId` e cia. | boot loop do `server.js` | passaram a rodar no provisionamento |

---

## 3. Tenant novo, criado do zero

`scripts/sandbox-criar.js` ganhou `--slug=` para permitir tenants de teste
descartáveis. Foram criados `sandbox2` … `sandbox5`, todos **SUSPENDED, sem
vhost, sem SSL, sem e-mail, sem cobrança** — o mesmo desenho do relatório 14.

O `sandbox5` é o da validação final, criado **com todas as correções** e **sem
nenhum script de "completar schema"**.

| Momento | Tabelas | `pedidos` | Módulos com falha |
|---|---:|---:|---|
| Antes (relatório 14) | **277** | **20 colunas** | cadeia abortada |
| Depois | **364** | **43 colunas** | **nenhum** |

---

## 4. Comparação de schema — relevante, não só contagem

`sandbox5` × `1bit` (referência), tabela por tabela:

```
pedidos ok (43) · pedido_itens ok (8) · pedido_parcelas ok (8) · pessoas ok (74)
produtos ok (61) · faturas ok (38) · contas_a_receber ok (32) · contas_a_pagar ok (36)
contas_receber_pagamentos ok (21) · movimentacoes_estoque ok (22) · reservas_estoque ok (16)
comissoes_regras ok (15) · comissoes_apuracao ok (18) · metas_vendas ok (6)
crm_funis ok (6) · crm_oportunidades ok (23) · tipos_operacao ok (21)
perfis_acesso ok (8) · users ok · regras_alcada ok (8) · aprovacoes ok (18)
depositos ok (8) · produto_lookup ok (5) · produto_imagens ok (12) · tabelas_preco ok (7)
```

**Uma única divergência: `fatura_itens` sem `vBCIcms` e `vBCST`.** E ela **não é
do provisionamento**: `grep` por `vBCIcms` **não encontra nenhuma ocorrência em
nenhum `.js` do repositório**. São colunas órfãs no `1bit`, criadas por SQL
manual em algum momento. O provisionamento cria tudo o que o código cria.

**Tabelas ausentes: 16**, todas de subsistemas que dependem de uso — WhatsApp
(`wa_*`), sniper (`sniper_config`, `sniper_log`), Comprasnet
(`resultado_*`), `email_log`, `stone_config`, `api_endpoints`, `certidao_fila`,
`crm_propostas`, `mensagens_enviadas`. Nenhuma do núcleo comercial.

---

## 5. Teste funcional do tenant novo

`scripts/test-provisionamento-tenant-novo.js` — **15 testes, 15 OK**, contra o
`sandbox5`, **sem nenhum remendo de schema**.

| # | Verificação | Resultado |
|---|---|---|
| 1 | usuários, perfis, `sessions`, `audit_log` | ✅ |
| 2 | **permissões**: perfil restrito reconhecido e limitado | ✅ |
| 3 | criação de **cliente** pela API | ✅ |
| 4 | criação de **produto** pela API | ✅ |
| 5 | **criação de pedido** — *era aqui que dava 500* | ✅ |
| 6 | **`vendedorId` gravado** | ✅ |
| 7 | item com preço resolvido pelo servidor | ✅ |
| 8 | confirmação | ✅ |
| 9 | **reserva de estoque** | ✅ |
| 10 | API de **disponibilidade** (100 − 3 reservados = 97) | ✅ |
| 11 | entrega baixa o estoque | ✅ |
| 12 | **faturamento** | ✅ |
| 13 | **financeiro**: conta a receber legível | ✅ |
| 14 | listagem com escopo de vendedor | ✅ |
| 15 | nenhum 500 por schema nas 15 tabelas centrais | ✅ |

O script recusa rodar em qualquer slug que não seja `sandbox\d*`.

---

## 6. Regressão

| Verificação | Resultado |
|---|---|
| **Schema de tenant existente** | **não modificado** — as correções mudam só a ORDEM das migrations; nenhum ALTER em massa |
| Tenants de cliente com colunas da Fase 1 | **0**, verificado um a um |
| `npm run verify` | OK |
| Boot do serviço | **não alterado** — sem a flag, `registerProtectedRoutes` se comporta como antes |
| Scheduler | não tocado |
| Integrações externas | nenhuma disparada; os sandboxes nascem SUSPENDED |
| Dados de cliente | não alterados |

Por que o tenant existente não é afetado: mover um `alterSafe` de lugar é no-op
onde a coluna já existe, e a 2ª passada do `db-schema` só roda no
**provisionamento**, não no boot.

---

## 7. Auditoria fiscal

### 7.1 Onde `pessoas.cpfCnpj` sai do ERP

| Destino | Origem do documento | Alcançado por cadastro sem documento? |
|---|---|---|
| **NF-e** (`nfe-emit-routes.js:319`) | **`pessoas.cpfCnpj`**, via JOIN com `faturas` | **SIM** |
| **Boletos / Pix** (`boleto-orchestrator.js:243,320`) | **`pessoas.cpfCnpj`** → campo `pagador.documento` do provedor | **SIM** |
| NFC-e (`nfce-routes.js:294`) | `payload.consumidorCpfCnpj` (corpo) | não |
| NFS-e (`nfse-routes.js:912`) | `req.body.tomador` (corpo) | não |
| CT-e / MDF-e | nenhum uso de `pessoas.cpfCnpj` | não |

**Dois caminhos**, e os dois foram tratados.

### 7.2 `documentoFiscalDe()` — a função única

Três recusas, nesta ordem:

1. `semDocumento = 1` → **null** (a declaração explícita manda, mesmo que haja
   um documento gravado);
2. `cpfCnpj` com o prefixo `SD-` → **null** (funciona mesmo em tenant sem a
   coluna `semDocumento` — importante no rollout parcial);
3. **qualquer LETRA no valor → null**, independente de quantos dígitos sobrem.

A terceira regra é nova e é o que protege os legados (§7.4).

E `exigirDocumentoFiscal(pessoa, paraQue)` para quem não pode seguir sem o
documento: devolve `{ documento }` ou `{ erro }` com mensagem pronta, em vez de
cada emissor inventar a própria frase.

### 7.3 Onde foi ligada

**NF-e** (`nfe-emit-routes.js`): o `destCpfCnpj` agora sai de
`documentoFiscalDe`. Sem documento, a tag `CPF`/`CNPJ` simplesmente **não é
montada** — que é o tratamento correto de consumidor não identificado
(`indIEDest = 9`, logo abaixo, já existente). Nenhuma regra tributária foi
inventada.

> **Um cuidado que evitou quebrar 13 tenants:** minha primeira versão lia
> `COALESCE(p.semDocumento, 0)` no SELECT. Testei e **quebra** com
> `no such column` em tenant sem a migration da Fase 1 — ou seja, **em todos os
> clientes**. Revertido: a função não precisa da coluna, porque o prefixo `SD-`
> e a regra da letra já bastam.

**Boletos/Pix** (`boleto-orchestrator.js`): a emissão é **barrada antes** de
chamar o provedor, com a mensagem de `exigirDocumentoFiscal`. Sem isso, o
`SD-…` iria como `pagador.documento` e voltaria uma rejeição da API do Asaas que
ninguém entende.

### 7.4 Identificadores legados — o caso perigoso

Os quatro que existem hoje em produção (`EX-NICSRS`, `EX-CONTABO`,
`TARIFA-asaas`, `193099`) e o `UASG-<código>` de
`resolverClienteDeParticipacao` **já não viravam documento** pelo critério de
comprimento — nenhum deles sobra com 11 ou 14 dígitos.

Mas o padrão é frágil: **`UASG-12345678901` sobraria com 11 dígitos e viraria
CPF** dentro de uma nota. Não existe hoje, mas nada impedia. Por isso a regra da
letra: qualquer caractere alfabético desqualifica o valor, e a família inteira
fica protegida — inclusive as que ainda não foram inventadas.

**Nenhum backfill foi feito**, conforme sua instrução. Os cadastros legados
continuam como estão.

### 7.5 Risco medido e eliminado na origem (do relatório 14)

`SD-<uuid hex>` passando pelo `replace(/\D/g,'')` dos emissores: **1,14% viravam
11 ou 14 dígitos** em 200.000 gerações. O gerador passou a regerar nesse caso —
remedido, **0 em 200.000**, sem colisões.

---

## 8. Testes

| Suíte | Resultado |
|---|---|
| **`test-provisionamento-tenant-novo.js`** (novo) | **15 OK, 0 falhas** |
| **`test-documento-fiscal.js`** (novo) | **16 OK, 0 falhas** |
| `test-app-backend` | 79 OK |
| `test-fase1-desconto-origem` | 57 OK |
| `sandbox-seed-e-testes` | 26 OK |
| `test-fase0-pagamento-pedido` · `test-fase1-rollout-parcial` | 15 · 10 OK |
| `test-reservas-pedido` · `test-venda-perdida-pedido` · `test-metas-bi` | 11 · 16 · 21 OK |
| `test-deposito-movimentacao` · `test-devolucao-venda-espelho` | 14 · 17 OK |
| `test-devolucoes-credito-metas-comissao` · `test-devolucoes-custo-saldo-estorno` | 22 · 22 OK |
| `npm run verify` | OK |

**Zero falhas em tudo.** O bloco `3-c` do teste fiscal é o que mais importa:
prova que `UASG-12345678901`, `EX-12345678000199` e `TARIFA-11144477735` — os
casos que virariam documento falso — são recusados.

---

## 9. Serviços e restarts externos

| Serviço | PID e start no **início** da sessão (07:56) | **Agora** |
|---|---|---|
| `consulta-licitacoes.service` | 3085545 · 2026-09-11 06:18:47 | **3085545 · 06:18:47** |
| `liciteagora.service` | 3085849 · 2026-09-11 06:18:49 | **3085849 · 06:18:49** |

**Mesmos PIDs, mesmo start: nenhum restart durante esta sessão**, nem meu nem
externo. `NRestarts=0` nos dois.

Registro da sessão anterior, para o histórico: às **06:18 de hoje** o cron do
Hestia (`v-update-sys-queue restart`) reiniciou **55 serviços**, incluindo os
dois — sem reinicialização da máquina (uptime de 15 semanas). **Nenhuma das
correções deste relatório está em vigor**: todas são posteriores àquele horário.

---

## 10. Objetivo C — a Fase 1 foi preservada

| Item | Estado |
|---|---|
| `sandbox` e sua migration | intactos |
| `pedido-desconto.js` · `pessoa-sem-documento.js` | intactos (o segundo foi **estendido**) |
| origem `pdv`/`catalogo` | intacta |
| herança de desconto na fatura | intacta |
| `tipoAtendimento` | intacto |
| Testes da Fase 1 | **todos verdes** |
| Migration nos clientes | **não aplicada** |

---

## 11. Riscos restantes

| Risco | Gravidade | Situação |
|---|---|---|
| **Correções não estão em vigor** | alta | exigem restart do `consulta-licitacoes.service`, que **não fiz**. Até lá, tenant novo continua nascendo quebrado |
| Duplicação entre boot loop e provisionamento | média | a lista de 4 módulos existe em dois lugares; módulo novo que migre por lá precisa entrar nos dois (comentado no código) |
| 212 ALTERs ainda no lugar errado no `db-schema` | média | a 2ª passada os resolve, mas a causa estrutural (migration de compatibilidade misturada com schema base) continua |
| `fatura_itens.vBCIcms`/`vBCST` órfãs no `1bit` | baixa | não vêm de código nenhum; tenant novo não as terá |
| NFC-e e NFS-e ainda leem documento do corpo | média | não alcançadas por `pessoas`, mas quando o catálogo público gerar NFC-e isso precisa passar por `documentoFiscalDe` |
| 4 sandboxes de teste (`sandbox2`…`5`) | baixa | SUSPENDED, sem vhost; ocupam disco. Podem ser removidos quando quiser |
| `semDocumento` não é lido pela NF-e | baixa | por escolha — o prefixo basta e evita quebrar tenant sem migration |

---

## 12. Próximo passo recomendado

1. **Revisar e aprovar este relatório.**
2. **Reiniciar o `consulta-licitacoes.service`** — sem isso, as correções não
   valem e um cliente novo continua nascendo quebrado. É a ação mais urgente.
3. **Provisionar um tenant novo de verdade** (o próximo cliente) e rodar
   `test-provisionamento-tenant-novo.js` contra ele.
4. Só então: migration da Fase 1 nos clientes, e o PDV/Catálogo.

---

## 13. Confirmação

- **Migration da Fase 1 NÃO aplicada nos 13 tenants** — verificado um a um.
- **Nenhum tenant de cliente alterado.** Os bancos deles foram lidos com
  `readonly: true` quando usados como referência.
- **Nenhum serviço reiniciado** — mesmos PIDs do início da sessão.
- **Nenhum commit**, nenhum `reset`/`stash`/`clean`, **nenhum backfill**, nada
  no Asaas.
- Arquivos de aplicação alterados: **8** — `route-registry.js`,
  `tenant-provision.js`, `db-schema.js`, `faturas-routes.js`,
  `comissoes-routes.js`, `pessoa-sem-documento.js`, `nfe-emit-routes.js`,
  `boleto-orchestrator.js`. Mais dois scripts de teste novos e o `--slug` no
  script do sandbox.
