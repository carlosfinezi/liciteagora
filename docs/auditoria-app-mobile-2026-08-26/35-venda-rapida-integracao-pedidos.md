# 35 — "Venda rápida": integração ao fluxo de Pedidos

**Data:** 2026-09-12, 10:20–11:15 BRT
**Decisão implementada:** opção B da [auditoria 34](34-pedidos-vs-pedidos-pdv.md)
**Escopo:** navegação, rótulos e integração visual. **Nenhum backend, banco, endpoint ou regra.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, NRestarts 0 | **idêntico** |

Sem restart. `git status`: 365 entradas antes, 367 depois (os dois arquivos novos desta fase). `npm run verify` verde antes e depois.

---

## 1. A descoberta que mudou a execução

O pedido pedia, como direção final, **uma só entrada no menu**. Ao verificar as dependências antes de remover `Pedidos PDV`, encontrei o motivo para **não remover agora** — e ele estava escrito num teste, de propósito.

`podeVerPath`, em `perfis-acesso.js`, decide em duas etapas:

```js
const page = POR_LINK.get(pathname);
if (page) return permitidas.has(page);      // registrada no menu → checagem NOMINAL
…
for (const p of permitidas) {                // não registrada → herda o DIRETÓRIO
  if (POR_PAGINA.get(p)?.dir === dir) return true;
}
```

Ou seja: **tirar a página do menu faria a Venda rápida cair no fallback por diretório**, e qualquer perfil com uma página de `/comercial/` passaria a abri-la.

Não é hipótese minha. O `test-pdv-rbac.js` tem um teste com esse nome exato:

> **B3.** `'FAIL-OPEN por diretorio: ter /comercial/pedidos.html liberou /comercial/pedidos-pdv.html'`

Ele foi escrito na Fase 2.1 justamente para barrar isso. Conforme sua instrução — *"se descobrir que remover quebra permissões, NÃO force"* — **a entrada continua no menu**, apenas renomeada.

### O efeito colateral que isso criou, e como foi resolvido

Se a página exige permissão nominal, **o botão novo na listagem levaria metade dos usuários a um bloqueio**. Medido nos tenants em 2026-09-12:

| Tenant | Perfil | Tem `pedidos` | Tem `pedidos-pdv` |
|---|---|---|---|
| `josecarloscostafilho` | `comercial` | sim | **não** |
| `sandbox` | `comercial` | sim | **não** |
| `sandbox` | `gerente-comercial` | sim | **não** |

**Nenhum perfil cadastrado alcança a Venda rápida hoje.** Por isso o botão nasce `hidden` e só aparece para quem a permissão alcança — usando o **mesmo cache** que a sidebar usa para filtrar o menu (`acessoCache`, de `/api/perfis/meu-acesso`). Nenhuma requisição nova, e as duas decisões não podem divergir.

> Isto é apresentação, não controle de acesso. Quem barra de verdade continua sendo o servidor, se alguém digitar a URL.

---

## 2. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/comercial/pedidos.html` | botão `⚡ Venda rápida` (oculto por padrão) + `mostrarVendaRapida()` |
| `public/comercial/pedidos-pdv.html` | `<title>`, `<h1>`, subtítulo, seta de retorno + CSS de ambos |
| `public/js/menu-config.js` | rótulo `Pedidos PDV` → `Venda rápida` (**chave e link intactos**) |
| `scripts/test-venda-rapida-nav.js` | **novo** — 15 testes |
| `scripts/verify.js` | passo 8 chama a suíte nova |

**Nenhum arquivo renomeado, movido ou apagado.**

---

## 3. Navegação final

```
COMERCIAL → Pedidos            (listagem)
   ├── [ + Novo orçamento ]
   ├── [ ⚡ Venda rápida ]     → /comercial/pedidos-pdv.html   (aparece se o perfil alcança)
   └── [ + Novo pedido ]       → fluxo tradicional

Venda rápida
   └── [ ← ]                   → /comercial/pedidos.html

COMERCIAL → Venda rápida       (entrada do menu, mantida — §1)
```

Um pedido criado na Venda rápida é o **mesmo registro** e abre na tela completa pelo mesmo `id`. A listagem não filtra por `tipo` — testado (E3).

---

## 4. Nomes visíveis alterados

| Onde | Antes | Depois |
|---|---|---|
| Menu lateral | Pedidos PDV | **Venda rápida** |
| `<title>` da aba | Pedidos PDV · Licite Agora | **Venda rápida · Licite Agora** |
| `<h1>` da tela | Pedidos PDV | **Venda rápida** |
| Subtítulo | — | *"Crie pedidos de forma simples e rápida no balcão, celular ou tablet."* |
| Listagem | — | botão **⚡ Venda rápida** |

**Nomes técnicos preservados** — `pedidos-pdv` continua sendo o arquivo, o link, a chave de RBAC e a entrada em `perfis-api-map.js`. Renomear a chave exigiria migrar `perfis_acesso.paginas` nos tenants, e esta fase não toca em banco.

### O subtítulo e o balcão

Ele só aparece **a partir de 1100px**. Medido no Chrome:

| Largura | Altura do cabeçalho | Subtítulo |
|---|---|---|
| 1400px | 69px | visível |
| 900px | 62px | oculto |
| 600px | 105px | oculto |

Abaixo de 1100px o cabeçalho já divide a linha com três modos de atendimento e dois botões. Uma segunda linha de texto empurraria a grade de produtos para baixo — justamente onde a tela é usada em pé.

---

## 5. O que foi preservado

### Da Venda rápida — verificado por teste (E1)

Cliente primeiro · busca de cliente · **cadastro rápido** · categorias · cards de produto · carrinho · **desconto com alçada** · `tipoAtendimento` · No local · Retirada · Entrega · pendentes · retomar · responsividade · `pointer: coarse` · CSS mobile · as três suítes (`test-pdv-fluxo` 29, `test-pdv-rbac` 11, `test-pdv-visual` 32).

### Do pedido tradicional — não foi tocado

`public/comercial/pedido.html` **não teve uma linha alterada**. Faturamento, NF-e 55, parcelamento, condição de pagamento, CFOP, tipo de operação, transportadora, entrega e edição detalhada seguem exatamente como estavam.

A única mudança em `pedidos.html` (a listagem) foi **aditiva**: um botão e uma função. `criarPedidoVazio`, `criarOrcamentoVazio`, `abrirModalImport` e `aplicarAcaoMassa` intactos — testado (E2).

### Backend — zero

Nenhum endpoint novo. Nenhuma tabela. Nenhuma numeração. Nenhuma regra. O teste A3 reprova se aparecer `/api/venda-rapida` em qualquer lugar.

---

## 6. Testes

`scripts/test-venda-rapida-nav.js` — **15 testes, 15 OK**:

| Bloco | Cobre |
|---|---|
| A (3) | as duas portas na listagem · aponta para a tela existente · **nenhum endpoint novo** |
| B (3) | título e `<title>` · subtítulo que não rouba espaço · caminho de volta com alvo de 36px |
| C (2) | menu com rótulo novo e **chave intacta** · menu não mudou de tamanho (190) |
| D (4) | **botão respeita o RBAC** · nasce oculto · usa o cache da sidebar · página segue protegida |
| E (3) | Venda rápida preservou tudo · listagem não perdeu nada · **os dois fluxos na mesma listagem** |

**O D1 executa a função real** contra os quatro estados de acesso (admin, perfil com a página, perfil sem, sem cache) — não é leitura de código.

**Provado por sabotagem:** removendo a condição do `mostrarVendaRapida`, o D1 reprova com *"perfil SEM pedidos-pdv: botão visível, esperado oculto"*. Restaurado em seguida.

### Regressão — zero falhas

| Suíte | |
|---|---|
| `npm run verify` (agora com o passo 8) | **OK, 1,5 s** |
| `test-venda-rapida-nav` | **15 ok** |
| **`test-pdv-rbac`** | **11 ok** — o que eu quase quebrei |
| `test-pdv-fluxo` · `test-pdv-visual` | 29 · 32 ok |
| `test-shell-boot` · `test-tema-global` | 24 · 21 ok |
| `test-fase33-topbar` · `test-fase34-identidade` | 40 · 26 ok |
| `test-sidebar-botoes` · `test-fase321-ux` | 23 · 20 ok |
| `test-fase1-funcional` · `test-app-backend` | 57 · 79 ok |
| `test-alcadas` · `test-governanca-percentual` | 41 · 29 ok |

### Validação visual

Renderizado no Chrome, tema claro e escuro, em 1400 / 900 / 600px. Sidebar expandida e compacta não foram tocadas (o `PAGINAS_COMPACTAS = ['pedidos-pdv']` continua, então a Venda rápida ainda recolhe a barra sozinha).

---

## 7. Riscos

| Risco | Gravidade | Observação |
|---|---|---|
| **A entrada do menu não foi removida** | — | **decisão consciente** (§1). A direção acordada segue pendente e precisa da sua decisão sobre RBAC |
| **Nenhum perfil alcança a Venda rápida hoje** | **média** | os três perfis cadastrados não têm `pedidos-pdv`. Para eles, o botão **e** o item de menu ficam invisíveis. Só admin e perfis sem cadastro (fail-open) veem |
| Cabeçalho +4px no mobile | baixa | medido: 101px → 105px em 600px. A quebra de linha dos modos **já existia** — a seta não a causou |
| Botão depende do cache | baixa | no primeiro acesso num navegador novo, fica oculto e aparece na próxima carga. Esconder demais é preferível a oferecer porta trancada |
| Dois caminhos para a mesma tela | baixa | menu e botão. É transitório, até a decisão do §8 |

---

## 8. A decisão que ficou pendente — e as opções

Para chegar a **uma só entrada no menu**, é preciso escolher entre duas coisas que hoje não convivem:

**Opção 1 — remover a página do menu.**
A Venda rápida passa a ser tratada como tela de detalhe (igual a `pedido.html`), herdando o acesso de `/comercial/`. Quem tem `pedidos` abre a Venda rápida.
*Custo:* acaba a granularidade "balcão sem gestão", e o teste `test-pdv-rbac` B3 precisa ser reescrito — ele hoje afirma o contrário.

**Opção 2 — manter a página registrada e conceder a permissão.**
O item sai do menu por outro caminho (uma flag `oculto: true`, a criar), mas a checagem nominal continua. Cada tenant precisaria adicionar `pedidos-pdv` aos perfis que devem operar o balcão.
*Custo:* mexe em dados de perfil nos tenants — fora do escopo desta fase.

**Recomendo a opção 1**, por três razões: a granularidade nunca foi usada (nenhum perfil a tem); `pedido.html` — que fatura e emite NF-e — já é acessível por herança de diretório, então o critério seria inconsistente; e é reversível. Mas é **decisão sua**, porque afrouxa um controle de acesso que alguém desenhou de propósito.

---

## 9. Próximo passo, se aprovado

1. decidir entre as opções do §8;
2. se for a 1: remover o item do `menu-config.js` e **reescrever** o `test-pdv-rbac` B3 para afirmar a nova regra (herança de diretório), com o motivo documentado;
3. rodar a regressão e confirmar que nenhum perfil perdeu acesso a outra coisa.

Enquanto isso não for decidido, **o estado atual é consistente e seguro**: quem pode, vê as duas portas; quem não pode, não vê nenhuma promessa falsa.

---

## GO / STOP

**GO** para o que está no ar: tudo é estático e já está sendo servido. Nenhum restart necessário — nenhum `.js` de servidor foi tocado.

**STOP** para a remoção do item de menu, que depende da sua decisão no §8.

**Não foi feito:** commit, migration, alteração de tenant, emissão fiscal, cobrança, chamada à SEFAZ, restart.

A ressalva honesta: validei por execução de testes e renderização no Chrome. **Não abri o ERP autenticado com um perfil restrito** para ver o botão sumir na prática — a prova disso é o teste D1, que exercita a função real, não uma observação em tela.
