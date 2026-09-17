# 34 — Pedido tradicional × Pedidos PDV: continuar separado ou incorporar?

**Data:** 2026-09-12, 09:10–10:05 BRT
**Natureza:** auditoria somente leitura. **Nada implementado.**
**Base:** [32 — consolidação do varejo](32-consolidacao-varejo-pdv-loja.md) · [33 — os três PDVs](33-auditoria-tres-pdvs.md)

| Unidade | PID | NRestarts | Desde |
|---|---|---|---|
| `consulta-licitacoes.service` | 3777293 | 0 | 2026-09-11 12:14:16 |
| `liciteagora.service` | 3085849 | 0 | 2026-09-11 06:18:49 |

Idênticos antes e depois, sem restart externo. Árvore com 365 entradas pendentes (estado herdado). Apenas `SELECT`/`PRAGMA`.

---

## 1. As duas telas

| | Tradicional | Pedidos PDV novo |
|---|---|---|
| Arquivo | `public/comercial/pedido.html` | `public/comercial/pedidos-pdv.html` |
| Linhas | **2.543** | **1.051** |
| Menu | COMERCIAL → Pedidos (abre pelo grid) | COMERCIAL → Pedidos PDV |
| Funções JS | **~110** | **~35** |
| Endpoints | **19** | **6** |

---

## 2. Matriz de funcionalidades

| Funcionalidade | Tradicional | PDV novo | Classificação |
|---|---|---|---|
| criar pedido | sim | sim | **nos dois** |
| editar pedido | sim, completo | itens e desconto | **parcial no novo** |
| busca de cliente | autocomplete | busca própria | **nos dois** |
| **cadastro rápido de cliente** | **não** | **sim** (`salvarCliente` → POST `/api/pessoas`) | **só no novo** |
| cliente obrigatório | não (rascunho) | não | nos dois |
| **vendedor** | **sim** (`preencherVendedores`, `/api/usuarios`) | **não** | **só no tradicional** |
| **tabela de preço** | **sim** (`/api/tabelas-preco`, `/api/precos/resolver`) | **não** | **só no tradicional** |
| produtos | autocomplete | grade + autocomplete | nos dois |
| busca de produto | sim | sim | nos dois |
| **categorias** | **não** | **sim** (26 refs) | **só no novo** |
| **cards visuais** | não (tabela) | **sim** (40 refs) | **só no novo** |
| **foto do produto** | **não** | **sim** (12 refs) | **só no novo** |
| código de barras | não | não | **não existe** |
| quantidade | sim | sim | nos dois |
| preço | servidor (`precoDeItem`) | servidor (`precoDeItem`) | **nos dois, mesma regra** |
| **desconto** | **não tem o campo** | **sim** (22 refs) | **só no novo** |
| **alçada de desconto** | **não** | **sim** | **só no novo** |
| frete | sim | sim | nos dois |
| endereço | sim (`copiarEnderecoCliente`) | sim (entrega) | nos dois |
| **No local / Retirada / Entrega** | **não** | **sim** (`tipoAtendimento`) | **só no novo** |
| observações | sim | não | só no tradicional |
| **pagamento / parcelamento** | **sim** (120 refs, `gerarParcelas`, `distribuirRestante`) | não | **só no tradicional** |
| pagamento misto | sim (meios por parcela) | não | só no tradicional |
| venda a prazo | sim | não | só no tradicional |
| **condição de pagamento** | **sim** (`/api/politicas-prazo/aplicaveis`) | **não** | **só no tradicional** |
| salvar rascunho | sim | sim | nos dois |
| **pedido pendente / retomar** | não | **sim** (`abrirPendentes`, `retomar`) | **só no novo** |
| confirmar | sim | sim | nos dois |
| entregar | sim | **não** | só no tradicional |
| estoque | via ciclo | via ciclo | **nos dois, mesma regra** |
| **faturar** | **sim** (`faturarAgora`, `executarFaturar`) | **não** | **só no tradicional** |
| **NF-e 55** | **sim** (`emitirNFe`, `verificarNFeRejeitada`) | **não** | **só no tradicional** |
| financeiro | via parcelas/CR | não | só no tradicional |
| **impressão** | **sim** (`imprimirPdf`, `enviarWhatsApp`) | **não** | **só no tradicional** |
| **CFOP / tipo de operação** | **sim** (27 e 10 refs) | **não** | **só no tradicional** |
| **transportadora** | **sim** (20 refs, consulta CNPJ) | **não** | **só no tradicional** |
| **depósito** | **sim** | **não** | **só no tradicional** |
| **venda perdida** | **sim** (`confirmarPerda`, motivos) | **não** | **só no tradicional** |
| **falta / ruptura → compra** | **sim** (`gerarCompraDaFalta`) | **não** | **só no tradicional** |
| histórico | sim (`carregarHistorico`) | não | só no tradicional |
| auditoria | via `pedido_historico` | via `pedido_historico` | **nos dois** (backend) |
| RBAC | `/api/pedidos` → página `pedidos` | `/api/pedidos` → página `pedidos-pdv` | **nos dois, mesmo gate** |
| **responsividade** | 1 breakpoint | **4 breakpoints** | **só no novo de verdade** |
| **uso touch/tablet** | não | **sim** (`pointer: coarse`) | **só no novo** |
| atalhos de teclado | 2 refs | não | parcial no tradicional |

### A surpresa da matriz

**A tela tradicional não tem campo de desconto.** Verifiquei três vezes — `grep -c "desconto"` retorna **0** em `pedido.html`. O desconto ali é implícito: edita-se o `precoUnitario` da linha. E `pedido_itens` confirma — só tem `precoUnitario` e `valorTotal`, sem coluna de desconto.

O desconto **com alçada** existe apenas no PDV novo, e vive no cabeçalho do pedido (`pedidos.descontoTipo/descontoValor/descontoAplicado/descontoMotivo`), colunas criadas na Fase 1.

Isso inverte a leitura ingênua de que "o novo é um subconjunto do antigo": **em governança de desconto, o novo está à frente.**

---

## 3. Backend — o quanto realmente compartilham

### Endpoints

Os 6 do PDV novo são **subconjunto exato** dos 19 do tradicional. Mesmas rotas base: `/api/pedidos`, `/api/pessoas`, `/api/produtos`.

Os 13 exclusivos do tradicional: `tabelas-preco`, `precos/resolver`, `politicas-prazo/aplicaveis`, `tipos-operacao`, `cfops`, `depositos`, `transportadoras`, `adquirentes`, `usuarios`, `vendas-perdidas`, `faturas`, `compras/gerar-de-necessidade`, `recalcular-cfop`.

### **Não há regra de negócio duplicada** — e isto é o achado central

Verifiquei os três pontos onde a duplicação costuma aparecer:

**Preço.** Nenhuma das duas multiplica preço × quantidade no frontend (`grep` por `* qtd` → 0 nas duas). Quem decide é `politicas.precoDeItem(db, …)`, em `pedidos-routes.js`, chamado em três lugares do backend.

**Desconto.** O próprio `pedidos-routes.js:27` declara:

> *"O desconto tem um **único ponto de escrita** — `aplicarDescontoNoPedido`"*

e na linha 403:

> *"A regra inteira vive em `pedido-desconto.aplicarDescontoNoPedido`; aqui só…"*

O PDV novo aplica desconto por `PUT /api/pedidos/:id` com `descontoPercentual` — a **mesma rota genérica** que qualquer tela usaria. Alçada, aprovação e motivo obrigatório vêm de graça.

**Totais.** `pedido-desconto.totalDoPedido` é descrito como *"compartilhada com quem mais precise"*.

**Conclusão:** as duas telas são **camadas de apresentação sobre o mesmo backend**. Não há regra comercial duplicada — e, o mais importante, **incorporar uma na outra não exige tocar em regra nenhuma.**

---

## 4. Modelo de dados

Ambas escrevem em `pedidos` e `pedido_itens`. **O PDV novo não criou nenhuma estrutura paralela** — zero tabelas próprias, zero endpoints próprios.

Colunas de `pedidos` e quem as usa:

| Coluna | Tradicional | PDV novo |
|---|---|---|
| `clienteId`, `numero`, `status`, `tipo` | sim | sim |
| `vendedorId` | **sim** | não (existe, não usada) |
| `tabelaPrecoId` | **sim** | não |
| `tipoOperacaoId` | **sim** | não |
| `descontoTipo/Valor/Aplicado/Motivo` | **não** | **sim** |
| `tipoAtendimento` | **não** | **sim** |
| `tipoFrete` | sim | sim |
| `origemLoja` | — | — (é da Loja) |
| `depositoId` | **sim** | não |

Outras tabelas: o tradicional alcança `faturas`, `pedido_parcelas`, `transportadoras`, `adquirentes_cartao`, `tabelas_preco`, `politicas_prazo`, `tipos_operacao`, `cfops`, `vendas_perdidas`. O novo alcança `aprovacoes` (pela alçada). `pedido_historico` e `movimentacoes_estoque` são escritos pelo backend nos dois casos.

---

## 5. O que o tradicional tem e não podemos perder

### CRÍTICO — sem isto não se fecha uma venda no ERP

| Item | Onde |
|---|---|
| **Faturamento** | `faturarAgora`, `executarFaturar`, `confirmarBandeiraEFaturar` |
| **Emissão de NF-e 55** | `emitirNFe`, `verificarNFeRejeitada`, `cancelarFatura` |
| **Parcelamento e condição de pagamento** | 120 referências: `gerarParcelas`, `distribuirRestante`, `adicionarParcela`, `salvarParcelas`, `aoTrocarPolitica`, `meiosDisponiveis` |
| **Tipo de operação e CFOP** | `carregarTiposOperacao`, `carregarCfops`, `recalcular-cfop` — é o que decide tributação, financeiro e estoque |
| **Entregar** (baixa de estoque) | `acao('entregar')` — pré-requisito obrigatório do faturamento |

### IMPORTANTE — perda causaria retrabalho ou erro comercial

| Item | Onde |
|---|---|
| **Vendedor** | `preencherVendedores` — base de comissão |
| **Tabela de preço** | `carregarTabelasPreco`, `resolverPrecoItem` |
| **Transportadora e frete** | `acTransportadora`, `consultarCnpjTransp`, `salvarTransportadora` |
| **Depósito** | `preencherDepositos` — multi-depósito |
| **Impressão / PDF / WhatsApp** | `imprimirPdf`, `enviarWhatsApp` |
| **Histórico** | `carregarHistorico` |
| **Adquirente de cartão** | `acBandeira`, `selBandeira` — recebíveis |

### SECUNDÁRIO — valioso, mas não bloqueia venda

| Item | Onde |
|---|---|
| Venda perdida | `abrirModalPerda`, `confirmarPerda`, motivos, concorrente |
| Falta/ruptura → pedido de compra | `abrirModalFalta`, `gerarCompraDaFalta`, `podeComprarFalta` |
| Compras vinculadas | `renderComprasVinculadas` |
| Converter pedido ↔ orçamento | `converterModo` |

---

## 6. O que o PDV novo faz melhor

| Ganho | Detalhe | Reaproveitável no Comercial? |
|---|---|---|
| **Cliente primeiro** | o fluxo começa pelo cliente, não por um formulário | **sim** — é ordem de tela |
| **Cadastro rápido de cliente** | `abrirNovoCliente`/`salvarCliente` → POST `/api/pessoas`. **O tradicional só faz autocomplete, não cria** | **sim, e faz falta lá** |
| **Grade por categoria** | 26 refs; `pintarCategorias`, `filtrarCat` | **sim** |
| **Cards com foto** | 12 refs de imagem | **sim** |
| **Desconto com alçada** | único lugar com governança de desconto | **sim — deveria estar nos dois** |
| **No local / Retirada / Entrega** | `tipoAtendimento`, coluna real | **sim** |
| **Pedidos pendentes / retomar** | `abrirPendentes`, `retomar` — volta a um rascunho | **sim** |
| **Touch real** | `@media (pointer: coarse)`, alvos grandes | **sim** |
| **Responsividade de verdade** | 4 breakpoints, 0 tabelas, 13 inputs | **sim** |
| **Skeleton / feedback** | `pintarSkeleton` | sim |
| **Gaveta lateral** | `abrirGaveta` — pedido sempre visível no mobile | sim |

**Todos são ganhos de interface e ordem de fluxo.** Nenhum depende de backend próprio — logo, **todos podem viver dentro do Comercial sem manter um módulo independente.**

---

## 7. Mobile — a pergunta técnica

| | Tradicional | PDV novo |
|---|---|---|
| breakpoints | **1** (`max-width: 768px`) | **4** (1099, 639, `pointer: coarse`, `prefers-reduced-motion`) |
| `<table>` | **5** | **0** |
| `<input>` | **65** | **13** |
| `display: grid` | 0 | 3 |
| referências a modal | 68 | 16 |

**Tornar `pedido.html` responsivo não é trabalho de CSS.** Cinco tabelas e 65 inputs não "espremem" — teriam de virar cards, acordeões e etapas. Isso é **redesenho de conteúdo**, não de layout, numa tela de 2.543 linhas que contém o faturamento fiscal em produção.

**Tecnicamente melhor: preservar a interface nova como modo "Venda rápida".** Ela já nasceu com a estrutura certa para toque, e o risco de mexer nela é ordens de grandeza menor.

Isso responde diretamente à sua preocupação: não se trata de espremer 2.543 linhas no celular — trata-se de ter **uma porta de entrada enxuta** que usa o mesmo backend.

---

## 8. Uso real

| Tenant | Total | manual | pdv | catalogo | os | licitacao |
|---|---:|---:|---:|---:|---:|---:|
| `1bit` | 29 | **21** | 0 | 0 | 2 | 2 |
| `produtosbomgosto` | 22 | **21** | **1** | 0 | 0 | 0 |
| `josecarloscostafilho` | 11 | 5 | 0 | 0 | 6 | 0 |
| `raeldouglas` | 2 | 0 | 0 | 0 | 2 | 0 |
| `jaagricola` | 1 | 1 | 0 | 0 | 0 | 0 |
| `sandbox` | 131 | 44 | **75** | **12** | 0 | 0 |
| `sandbox5/6` | 3 | 3 | 0 | 0 | 0 | 0 |

**Em produção real: 65 pedidos, 48 `manual`, 1 `pdv`, 0 `catalogo`.** Os 75 `pdv` e 12 `catalogo` são do `sandbox` — testes desta semana.

Leitura honesta: **a tela tradicional é a que sustenta a operação hoje.** O PDV novo tem um único pedido real. Isso não o desqualifica — ele foi ativado há um dia — mas pesa contra torná-lo a interface principal agora.

---

## 9. Pedido único — a arquitetura suporta?

**Sim, e já suporta hoje.** Três evidências:

1. **Mesma tabela, mesma numeração.** Tradicional, PDV novo e Loja virtual fazem `INSERT INTO pedidos`. O `tipo` (`manual`/`pdv`/`catalogo`/`os`/`licitacao`) registra a origem sem separar o objeto.
2. **O funil fiscal não filtra origem.** Auditado no relatório 33: `/api/pedidos/:id/faturar` só checa existência, cliente, e `status='entregue'`. **Não há `WHERE tipo = …`.**
3. **A regra é única.** Preço, desconto e totais têm um ponto de escrita no backend.

**Pedido do catálogo na listagem:** aparece normalmente — `/api/pedidos` aceita filtro por `tipo` e `modoDocumento`, mas não os exige. Um pedido `catalogo` em `rascunho` é visível, editável e faturável como qualquer outro.

O que **falta** para o ciclo completo a partir de qualquer origem: nada estrutural. Falta apenas a NFC-e (relatório 33, §7) — que está fora desta auditoria por sua instrução.

---

## 10. As três opções

| Critério | A — duas telas | B — Pedidos com "Venda rápida" | C — PDV como principal |
|---|---|---|---|
| Facilidade p/ usuário | ruim — "qual eu uso?" | **boa** — um lugar, dois modos | média — força balcão em venda complexa |
| Duplicidade | **de interface** | **nenhuma nova** | inverte o problema |
| Manutenção | duas telas para cada mudança | uma navegação, duas visões | tradicional vira secundária mas continua crítica |
| Risco | baixo (é o estado atual) | **baixo** — só navegação | **alto** — muda a porta de 48 pedidos reais |
| Celular | novo serve | **novo serve** | novo serve |
| Balcão | novo serve | **novo serve** | novo serve |
| Venda externa | novo serve | **novo serve** | novo serve |
| Pedidos complexos | tradicional | **tradicional, a um clique** | atrito: começa no simples e migra |
| Faturamento | só no tradicional | **onde sempre esteve** | precisaria de ponte |
| Treinamento | duas telas | **uma tela, dois botões** | retreinar quem já usa |

### Recomendação: **OPÇÃO B**

Motivos, na arquitetura e não na estética:

- **Custo de implementação quase nulo.** O backend já é o mesmo, o RBAC já cobre as duas páginas (`/api/pedidos` → `pedidos` **e** `pedidos-pdv`), e não há regra a mover. É trabalho de **navegação**.
- **Resolve a confusão sem risco.** A opção C mudaria a porta de entrada dos 48 pedidos reais que hoje nascem na tela tradicional — e essa tela é a que fatura e emite NF-e.
- **Preserva a força de cada uma.** Venda rápida para balcão e celular; pedido completo para negociação, parcelamento, transportadora e faturamento.
- **É reversível.** Se a Venda rápida não pegar, volta-se sem migração.

---

## 11. O que preservar do PDV novo — nada se apaga

| Camada | O que | Destino |
|---|---|---|
| **HTML** | grade de categorias, cards de produto, gaveta do pedido, modais de cliente/desconto/entrega | vira a visão "Venda rápida" |
| **CSS** | `.pdv-topo`, `.grade`, `.pdv-pedido`, os 4 breakpoints, `pointer: coarse` | **inteiro** — é a base mobile do Comercial |
| **JS** | `pintarCategorias`, `filtrarCat`, `pintarProdutos`, `abrirNovoCliente`/`salvarCliente`, `aplicarDesconto`/`previewDesc`, `abrirEntrega`/`salvarEntrega`, `abrirPendentes`/`retomar`, `mudarQtd`, `debBusca`/`debCli`, `pintarSkeleton` | funções reaproveitáveis quase sem alteração |
| **Endpoints** | nenhum próprio a preservar — já são os do ERP | — |
| **Regras** | desconto com alçada, `tipoAtendimento`, preço pelo servidor | **já estão no backend** — não se perdem em hipótese alguma |
| **Testes** | `test-pdv-fluxo` (29), `test-pdv-rbac` (11), `test-pdv-visual` (32) | continuam válidos; mudaria só o caminho da tela |

**O trabalho das Fases 1, 2.1 e 2.2 está inteiro no backend e no CSS.** Nenhuma linha precisa ser descartada na opção B.

---

## 12. Menu recomendado (apenas recomendação)

```
COMERCIAL
  ├── Clientes & Fornecedores
  ├── CRM · Funil
  ├── Pedidos                    ← uma entrada só
  │     [ + Novo pedido ]        → pedido.html   (completo)
  │     [ ⚡ Venda rápida ]       → pedidos-pdv.html (balcão/celular)
  ├── Tabelas de Preço
  └── …
```

`COMERCIAL → Pedidos PDV` sai do menu; a tela **continua existindo** e passa a ser alcançada pelo botão. Um pedido criado na Venda rápida abre no pedido completo quando precisar de parcelamento ou faturamento — mesma URL, mesmo `id`.

**VAREJO → PDV permanece intacto**, conforme sua instrução.

---

## 13. Risco de migração

**Sim, é possível fazer só na camada de interface/navegação** — que é a sua preferência, e a auditoria a sustenta:

| | |
|---|---|
| Endpoints | **nenhuma mudança** — os 6 continuam os mesmos |
| Banco | **nenhuma mudança** — nenhuma coluna, nenhuma migration |
| RBAC | **nenhuma mudança** — `/api/pedidos` já cobre as duas páginas |
| Arquivos | `pedidos-pdv.html` **fica onde está** |
| Mudança real | 2 botões em `pedidos.html` + 1 item de menu |

Riscos residuais:

| Risco | Gravidade | Observação |
|---|---|---|
| perfil restrito com acesso a `pedidos-pdv` mas não a `pedidos` | **média** | o botão sumiria para ele; conferir antes de tirar o item do menu |
| link direto salvo por usuário | baixa | a URL continua funcionando |
| o item do menu sumir e o usuário não achar | baixa | é o motivo de o botão vir **antes** de remover o item |

---

## 14. Respostas diretas

**1. Continuar o Pedidos PDV como módulo separado?**
**NÃO como módulo separado — SIM como interface.** Ele não é um módulo: não tem backend, tabela nem regra próprios. É uma segunda visão do mesmo pedido, e deve ser tratada assim.

**2. Qual opção?**
**B.** Uma entrada "Pedidos" com dois botões. É a de menor risco, menor custo e que resolve a confusão sem tocar nos 48 pedidos reais que nascem na tela tradicional.

**3. O que preservar do PDV novo?**
Tudo. O CSS mobile inteiro (4 breakpoints, `pointer: coarse`), a grade de categorias com cards, o cadastro rápido de cliente — **que o tradicional não tem** —, o desconto com alçada, `tipoAtendimento`, os pendentes/retomar, e as três suítes de teste.

**4. O que preservar obrigatoriamente do tradicional?**
O bloco CRÍTICO da §5: faturamento, NF-e 55, parcelamento e condição de pagamento, tipo de operação/CFOP, e o "entregar". Sem isso não se fecha venda no ERP. Depois, o IMPORTANTE: vendedor, tabela de preço, transportadora, depósito, impressão.

**5. Uma estrutura única de pedido para Comercial + Venda rápida + Catálogo?**
**Sim — e já existe.** Mesma tabela, mesma numeração, mesmo funil fiscal sem filtro de origem. Não há o que unificar: há o que parar de apresentar como se fosse separado.

**6. Menu final?**
§12 — `COMERCIAL → Pedidos` com `[+ Novo pedido]` e `[⚡ Venda rápida]`. VAREJO → PDV intacto.

**7. Próximo passo, se aprovado?**
Uma fase **só de navegação**, sem backend:
1. dois botões em `public/comercial/pedidos.html`;
2. conferir o RBAC dos perfis que hoje alcançam `pedidos-pdv`;
3. no PDV novo, um link "abrir pedido completo" que leva ao mesmo `id`;
4. só depois de validado, remover `Pedidos PDV` do `menu-config.js`.

Nenhuma migration, nenhuma rota nova, nenhum arquivo movido.

---

## Ressalvas honestas

**O que pesa contra a minha recomendação:** o PDV novo tem **1 pedido real**. Está no ar há um dia. É possível que, com uso, apareçam necessidades que mudem a leitura — e a opção B não impede evoluir para C depois; C sem passar por B é que seria arriscado.

**O que não verifiquei:** não executei as telas com usuário real nem medi tempo de operação. A comparação de responsividade é estrutural (contagem de breakpoints, tabelas e inputs), não observada em dispositivo.

**Uma correção ao relatório 32:** lá afirmei que o PDV novo "tem desconto com alçada" como se fosse paridade com o tradicional. Na verdade é **superioridade** — o tradicional não tem campo de desconto nenhum.

---

## GO / STOP

**STOP.** Auditoria concluída. Nenhum código, banco, schema, menu ou serviço alterado. Nenhuma SEFAZ, NFC-e, cobrança ou commit. PIDs e `NRestarts` idênticos ao pré-check.

Aguardando sua decisão sobre a opção B antes de qualquer implementação.
