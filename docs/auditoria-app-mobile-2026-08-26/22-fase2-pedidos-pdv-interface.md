# 22 — Fase 2.1: interface Pedidos PDV

**Data:** 2026-09-11
**Referências:** [19 — Fase 1 funcional](19-fase1-funcional-desconto-atendimento.md) ·
[21 — ativação](21-ativacao-fase1-funcional.md)

**Resultado:** tela implementada, conectada a dados reais e testada.
**Já está no ar** — é frontend estático. Uma parte de backend (RBAC de API)
precisa de restart; detalhado na §17.

**Não feito, por instrução:** pagamento · Catálogo Online · commit · restart ·
backfill · Asaas · alteração em tenant de cliente.

---

## 1. Encaixe no ERP

A tela de **Pedidos** (`/comercial/pedidos.html`) **não foi tocada** e segue
sendo a gestão administrativa completa. Pedidos PDV é outra interface **para a
mesma entidade**: cria `pedidos` com `tipo = 'pdv'`, itens em `pedido_itens`,
desconto nas colunas da Fase 1. Nenhum banco, tabela ou catálogo paralelo;
`rest_comandas` e o PDV fiscal (`/varejo/pdv.html`) não foram usados nem
consultados como base.

Tudo o que a tela precisa **já existia**: a auditoria não encontrou nenhuma API
faltando, e **nenhuma rota nova foi criada**.

## 2. URL e menu

```
/comercial/pedidos-pdv.html        página  →  public/comercial/pedidos-pdv.html
```

Segue o padrão real do sistema (`/comercial/<pagina>.html`). No menu, entre
**Pedidos** e **Tabelas de Preço**, exatamente como pedido:

```
Comercial → pessoas · crm-funil · pedidos · pedidos-pdv ·
            comercial-tabelas-preco · comercial-vendas-perdidas ·
            comercial-metas · contratos · devolucoes
```

`pedidos` preservado, sem duplicidade de página.

**Por que página própria no menu, e não um botão dentro de Pedidos:** o RBAC
deste ERP é **por página**. Item próprio permite dar o balcão a quem opera o
balcão sem entregar a tela de gestão — e vice-versa.

## 3. Arquivos criados e alterados

| Arquivo | O quê |
|---|---|
| `public/comercial/pedidos-pdv.html` | **novo** — a tela inteira (HTML + CSS + JS, 471 linhas de script) |
| `public/js/menu-config.js` | item `pedidos-pdv` na seção Comercial |
| `perfis-api-map.js` | **regerado** por `node scripts/gerar-mapa-api.js` |
| `scripts/test-pdv-fluxo.js` | **novo** — 29 testes do fluxo |

`perfis-api-map.js` não foi editado à mão — o próprio arquivo avisa que é gerado,
e o gerador deriva o mapa varrendo o que cada tela consome.

## 4. APIs reutilizadas

| API | Uso na tela |
|---|---|
| `GET /api/produtos` | catálogo — já devolve `precoVenda`, `saldo`, `categoria`, `imagemPath`, `codigoBarras` |
| `GET /api/pessoas?q=` | busca de cliente por nome, CPF/CNPJ e telefone (com e sem máscara) |
| `POST /api/pessoas` | cadastro rápido |
| `POST /api/pedidos` | abre o pedido com `origem: 'pdv'` e `tipoAtendimento` |
| `GET /api/pedidos/:id` | recarrega o pedido (já traz `itens`) |
| `GET /api/pedidos?status=rascunho&tipo=pdv` | pendentes — **filtro do servidor** |
| `POST /api/pedidos/:id/itens` | adiciona item |
| `PUT /api/pedidos/:id/itens/:itemId` | altera quantidade |
| `DELETE /api/pedidos/:id/itens/:itemId` | remove item |
| `PUT /api/pedidos/:id` | atendimento, desconto, endereço e frete |

## 5. APIs adicionadas

**Nenhuma.** Era o desfecho preferível e foi possível: o único ponto que parecia
exigir rota nova — a lista de categorias — resolveu-se derivando de
`produtos.categoria`, que já vem no payload. Uma rota a mais seria uma superfície
a mais para manter e proteger, por um dado que a tela já tinha em mãos.

## 6. Layout desktop (≥1100px)

Três colunas com rolagem independente; a página não rola.

```
┌───────────────────────────────────────────────────────────────┐
│ Pedidos PDV   [No local][Retirada][Entrega]  [Pendentes] [+ Novo pedido] │
├──────────┬──────────────────────────┬─────────────────────────┤
│Categorias│ 🔎 Buscar produto…       │ Cliente · PED-000124    │
│          │ ┌──────┐┌──────┐┌──────┐ │ ─────────────────────── │
│ Todos  5 │ │ foto ││ foto ││ foto │ │ Café 500g      R$ 74,70 │
│ Mercearia│ │ Café ││Açúcar││Cader.│ │ [−] 3 [+] [🗑]  24,90 un│
│ Papelaria│ │24,90 ││ 5,40 ││18,00 │ │                         │
│ Sem cat. │ └──────┘└──────┘└──────┘ │ Subtotal       R$ 74,70 │
│          │                          │ Desconto (5%)  − R$3,74 │
│          │                          │ Frete          R$ 15,00 │
│          │                          │ TOTAL          R$ 85,96 │
│          │                          │ [% Desconto] [Entrega]  │
│          │                          │ [    Continuar     ]    │
└──────────┴──────────────────────────┴─────────────────────────┘
```

Cards com imagem grande (proporção 4:3), nome em duas linhas, preço destacado e
saldo. Total em 1,28rem, o maior número da tela.

O CSS mora na própria página: é layout de uma tela só, e mexer no
`app-modern.css` por causa disso afetaria as outras ~140. Os tokens visuais
(`--bg-*`, `--accent`, `--r-*`) são os do sistema — a identidade não muda.

## 7. Layout tablet e celular

**A tela do celular não é a do desktop encolhida.**

| Faixa | Comportamento |
|---|---|
| **≥1100px** | três colunas |
| **640–1099px** | categorias viram faixa horizontal rolável; produtos ocupam a área; **o pedido vira gaveta** lateral com fundo escurecido |
| **<640px** | idem, com grade de cards menor (mín. 142px) e os três modos de atendimento em largura total |

No tablet e no celular há **barra fixa no rodapé**:

```
  3 itens                          [ Ver pedido ]
  R$ 314,00
```

Toque abre a gaveta do pedido. A barra respeita `env(safe-area-inset-bottom)`
(notch do iPhone). Em telas de toque (`pointer: coarse`) os botões de quantidade
crescem para 38px.

**PWA:** a tela já tem `viewport-fit=cover`, `theme-color` e layout de aplicativo.
Falta apenas `manifest.json` e service worker — não criados aqui porque instalação
e cache offline merecem etapa própria.

## 8. Cliente

Fluxo do **+ Novo pedido**, em dois passos, nessa ordem:

1. **Tipo de atendimento** — `no_local` · `retirada` · `entrega`;
2. **Cliente** — busca por nome, CPF/CNPJ ou telefone.

**Todo pedido tem cliente cadastrado. Não há "Consumidor Final" anônimo** — o
botão de iniciar fica desabilitado até haver um cliente escolhido.

**Cadastro rápido** (`+ Novo cliente`) dentro do próprio modal, sem sair da tela:
Nome/Razão Social, CPF/CNPJ e Telefone/WhatsApp. Segue as regras atuais do ERP —
`POST /api/pessoas` exige documento, e é o que a tela cobra. **A identificação
sem documento (`pessoa-sem-documento.js`) é do Catálogo Online e não foi ligada
aqui**, conforme instruído.

## 9. Produtos

Produtos reais do ERP, sem catálogo paralelo. Cada card traz foto (`imagemPath`,
com `📦` quando não há), nome, preço e saldo — em vermelho quando zerado.

**O preço nunca sai do frontend.** Ao adicionar item, a tela envia apenas
`produtoId`, `descricao` e `quantidade`; `precoUnitario` **não é enviado**, e
quem resolve é `pedido-politicas.precoDeItem`. O teste D2 manda um preço falso de
R$ 0,01 de propósito e confirma que o servidor grava R$ 24,90.

Produto sem estoque **continua visível e vendável** — o ERP permite venda a
descoberto e barrar aqui inventaria uma regra que o backend não tem.

## 10. Categorias

Derivadas de `produtos.categoria`, com contagem por categoria e **"Todos"**
sempre presente. Os sem categoria caem em **"Sem categoria"**, sempre no fim.

**Limitação documentada:** o ERP **não tem tabela de categorias de produto**
(auditado). `produtos.categoria` é **TEXT livre** — sem hierarquia, sem ordem
própria, sem cor ou ícone, e sujeito a divergência de digitação ("Mercearia" e
"mercearia" viram duas). Ainda assim é o campo certo a reutilizar: já é usado de
verdade em produção (`1bit`: Certificado SSL, Hospedagem VPS, Material de
Escritório; `produtosbomgosto`: PRODUTOS BOM GOSTO). Modelar categorias
comerciais de verdade é decisão de outra etapa.

## 11. Carrinho / pedido atual

Cabeçalho com cliente, número do pedido e o modo de atendimento. Por item:
descrição, total, `−` / quantidade / `+`, remover e preço unitário.

Resumo: **Subtotal · Desconto · Frete · TOTAL**. Desconto e frete só aparecem
quando existem.

**Todos os números vêm do pedido que o servidor devolveu.** Depois de cada ação a
tela chama `GET /api/pedidos/:id` e redesenha. Não há soma paralela em
JavaScript — o que se vê é o que está gravado.

## 12. Desconto

Ação `% Desconto` no painel. O modal mostra subtotal, campo de percentual, valor
calculado (prévia, só para o operador ver enquanto digita) e motivo.

**Não é possível editar o preço do produto na tela** — nem existe campo para
isso. O abatimento entra pela porta da Fase 1.

A tela **não tem regra de alçada nenhuma**: envia `descontoPercentual` e exibe o
que o backend respondeu.

| Resposta do backend | O que o operador vê |
|---|---|
| dentro da alçada | "Desconto aplicado", total atualizado |
| acima da alçada | **"Aguardando aprovação de …"**, chip amarelo no pedido, modal aberto com o aviso |
| sem motivo acima da alçada | a mensagem de erro do servidor |
| sem faixa cadastrada | a mensagem de fail-closed do servidor |

Duplicar a decisão de alçada no navegador criaria duas respostas para a mesma
pergunta — e a do navegador é a que muda com o DevTools aberto.

## 13. Atendimento e entrega

Os três modos ficam no topo e no modal de novo pedido, gravando exatamente
`no_local`, `retirada` e `entrega`. Trocar o modo com um pedido aberto faz `PUT`
e recarrega.

Com `entrega`, aparece o botão **Entrega**: endereço, número, bairro, cidade, UF
e frete. **Reutiliza os campos que já existiam** (`enderecoEntrega`,
`numeroEntrega`, `bairroEntrega`, `cidadeEntrega`, `ufEntrega`, `valorFrete`) —
nenhum campo novo. Em branco, vale o endereço do cadastro do cliente, como a
Fase 1 definiu.

Frete negativo é barrado na tela **e** pelo servidor (422). `no_local` e
`retirada` não pedem endereço.

## 14. Pedidos pendentes

Botão **Pendentes** no topo lista os rascunhos de balcão
(`status=rascunho&tipo=pdv`, filtrado pelo servidor). Um clique retoma o pedido
com itens e totais.

**Rascunho não reserva estoque — confirmado no backend, não presumido:**
`criarReservasPedido` é chamado somente na confirmação, na reabertura e na troca
de status; nunca na criação ou na edição de itens. Testes G2 e G3 verificam que
a tabela `reservas_estoque` fica vazia e que o saldo do produto não muda com o
pedido aberto. **O lifecycle não foi alterado.**

## 15. Permissões

Acesso pela página `pedidos-pdv`, dentro do RBAC que já existe:

- **admin** — irrestrito, acessa;
- **perfis cadastrados** — precisam ter `pedidos-pdv` marcada na tela de Perfis
  (ela aparece lá automaticamente, porque o catálogo é montado do `menu-config`);
- **anônimo** — `GET` da página sem sessão devolve **302 para `/login.html`**.
  Verificado.

O mapa de API foi regerado e liberou para `pedidos-pdv` **exatamente três**
prefixos — `/api/pedidos`, `/api/pessoas`, `/api/produtos` —, que são os que a
tela consome. O total de prefixos mapeados não mudou (175 antes e depois):
nenhuma API foi aberta de carona.

**Isolamento de tenant** herdado do middleware, e testado: catálogo, clientes e
pedidos de um tenant não aparecem no outro (B1, B2).

## 16. Testes

`scripts/test-pdv-fluxo.js` — **29 testes, 29 OK** — percorre as mesmas chamadas
que a tela faz, na mesma ordem, em dois bancos descartáveis (para provar
isolamento).

| Bloco | Cobertura |
|---|---|
| A | catálogo com preço/saldo/categoria/imagem · derivação e ordem das categorias · busca por nome, SKU e código de barras · produto sem estoque |
| B | **isolamento de tenant** (catálogo e pedido) |
| C | busca de cliente pelos três campos · cadastro rápido · recusa sem documento |
| D | pedido nasce `tipo=pdv` · **preço do servidor vence o do corpo** · quantidade ± · remover · quantidade negativa recusada |
| E | trocar atendimento · valor inválido 422 · entrega grava nos campos existentes · frete negativo 422 · confirmar entrega sem endereço 422 |
| F | fail-closed sem faixa · dentro da alçada aplica · acima devolve "aguardando aprovação" · sem motivo 422 · **preço de item não pode ser editado** |
| G | pendentes filtrados pelo servidor · **rascunho não reserva estoque** · saldo intacto · retomar |

**Fluxo real no sandbox**, com dados de verdade e limpeza ao final:

```
catalogo carregado              5 produto(s)
novo pedido                     PED-2026-00124  tipo=pdv  atend=no_local
2 itens adicionados             total=R$ 450,00
quantidade 2 -> 5               total=R$ 750,00
desconto 3% (dentro da alcada)  aplicado=R$ 22,50  total=R$ 727,50  aprovacao=nao
desconto 12% (acima)            aprovacao=SIM (gerente-comercial)
reservas do rascunho            0  (nao prende mercadoria)
aparece em pendentes            SIM
limpeza                         pedido de smoke removido
```

**Regressão — zero falhas novas:** `verify` OK · JS inline das três telas OK ·
`test-pdv-fluxo` 29 · `test-fase1-funcional` 57 · `test-governanca-percentual` 29
· `test-alcadas` 41 · `test-app-backend` 79 · `test-fase1-rollout-parcial` 10.

**Nenhum tenant de cliente foi tocado:** 0 pedidos `tipo='pdv'` em todos os 13.
A massa ficou no `sandbox`.

## 17. Restart

| Item | Já visível? | Precisa de restart? |
|---|---|---|
| `public/comercial/pedidos-pdv.html` | **SIM** — servida, HTTP 200, 38.972 bytes | não |
| `public/js/menu-config.js` (item no menu) | **SIM** — já aparece na sidebar | não |
| `perfis-api-map.js` | não | **SIM** — `consulta-licitacoes.service** |

**O que funciona agora, sem restart:** a tela abre, o menu mostra o item, e
**para admin tudo opera** — admin é irrestrito e não passa pelo mapa de API.

**O que precisa do restart:** o RBAC de API em memória ainda não conhece a página
`pedidos-pdv`. Para um **perfil restrito**, as três APIs continuam liberadas por
herança (quem tem a página `pedidos`, que está nos mesmos arrays, já pode
chamá-las) — então o risco prático é baixo. Mas um perfil que receba **só**
`pedidos-pdv`, sem `pedidos`, seria barrado até o restart.

**Serviço a reiniciar quando você decidir:** `consulta-licitacoes.service`, e só
ele. `liciteagora.service` não carrega nada disto.

**Nada foi reiniciado.** Estado atual: `consulta-licitacoes` PID 3637675 (11:17:35),
`liciteagora` PID 3085849 (06:18:49).

## 18. Limitações conhecidas

1. **Categorias são texto livre** (§10) — sem hierarquia nem normalização.
2. **Pagamento não existe** — o botão **Continuar** salva o pedido como pendente
   e avisa que o pagamento é a próxima etapa. Nada de PIX, cartão, dinheiro,
   misto ou a prazo, como instruído.
3. **O pedido não é confirmado pela tela.** Fica em rascunho; a confirmação
   (que reserva estoque) virá com o pagamento na Fase 2.2.
4. **Sem leitor de código de barras por hardware** — a busca já encontra pelo
   código digitado, mas não há captura de scanner. Não criei infraestrutura nova.
5. **Imagens são raras no acervo real** — 2 de 109 produtos no `1bit`, 0 em
   `produtosbomgosto`. O card cai no ícone `📦`; quem quiser a experiência visual
   completa precisa subir fotos em Produtos.
6. **Sem PWA instalável ainda** — falta `manifest.json` e service worker (§7).
7. **A tela não tem teste de navegador** — os 29 testes exercitam as APIs na
   ordem da tela e a lógica de apresentação (categorias, busca), mas nenhum
   clique real foi simulado.

## 19. Próximo passo recomendado

1. **Reiniciar `consulta-licitacoes.service`** para o RBAC de API reconhecer a
   página nova (§17). Só isso falta para o comportamento ficar completo.
2. **Abrir a tela e usá-la** num tenant interno, com produtos e fotos de
   verdade — é o tipo de defeito visual que nenhum teste de API pega.
3. **Fase 2.2 — pagamento:** modal com dinheiro, PIX, cartão, misto e a prazo,
   terminando em confirmação do pedido (que é quando a reserva de estoque
   acontece). É também onde a fila de aprovação de desconto precisa ficar
   visível ao aprovador — hoje a solicitação nasce e só aparece a quem for olhar.
4. **Depois:** `manifest.json` + service worker para o balcão funcionar como
   aplicativo instalado; e o **Catálogo Online**, que é outra audiência e onde
   `pessoa-sem-documento.js` finalmente entra.
