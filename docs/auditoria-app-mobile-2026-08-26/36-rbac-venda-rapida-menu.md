# 36 — Página registrada para RBAC, oculta da barra lateral

**Data:** 2026-09-12, 11:40–12:35 BRT
**Corrige:** o ponto pendente da [implementação 35](35-venda-rapida-integracao-pedidos.md) §8
**Escopo:** menu e sidebar. **Nenhum banco, endpoint, perfil, regra ou serviço.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, NRestarts 0 | **idêntico** |

Sem restart — nenhum `.js` de servidor foi tocado. `npm run verify` verde antes e depois.

---

## 1. Solução adotada

O problema do relatório 35 era que **duas perguntas estavam coladas numa só**:

> "esta página existe para o controle de acesso?" **e** "esta página aparece na barra?"

O `menu-config.js` respondia às duas com o mesmo fato — estar na lista. Daí o impasse: tirar do menu abria a página; deixar no menu poluía a barra.

**A solução é uma propriedade no item: `oculto: true`.**

```js
{ page: 'pedidos-pdv', icone: '🛒', texto: 'Venda rápida', oculto: true, link: '/comercial/pedidos-pdv.html' },
```

Não havia mecanismo equivalente — procurei por `oculto`, `hidden`, `showInMenu`, `semMenu` e `invisivel` nos três arquivos, e nada existia. A propriedade é nova, em português, seguindo o estilo do arquivo (`colapsavel`, `feature`, `badge`).

### Por que funciona, e por que é seguro

Os dois lados **já liam o menu-config de forma independente** — só faltava um deles ignorar a nova propriedade:

| Consumidor | Onde | O que faz com `oculto` |
|---|---|---|
| **`perfis-acesso.js`** (servidor) | monta `POR_PAGINA` / `POR_LINK` | **ignora** — a página continua indexada, e `podeVerPath` segue exigindo a permissão pelo nome |
| **`catalogo()`** (tela de perfis) | lista páginas atribuíveis | **ignora** — o admin continua podendo conceder `pedidos-pdv` |
| **`sidebar.js`** (barra) | `montarMenu` | **filtra** — o item não é desenhado |

**`perfis-acesso.js` não teve uma linha alterada.** É isso que garante que o controle de acesso não mudou: o arquivo que decide o acesso nem sabe que `oculto` existe.

---

## 2. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/js/menu-config.js` | `oculto: true` no item `pedidos-pdv` |
| `public/js/sidebar.js` | `secoesVisiveisDoMenu({ paraDesenho })` — filtra só no desenho |
| `scripts/test-menu-perfil.js` | `TODAS` passa a ser "páginas desenhadas"; novos casos para as ocultas |
| `scripts/test-menu-oculto-rbac.js` | **novo** — 15 testes |
| `scripts/verify.js` | passo 9 chama a suíte nova |

**Não alterados:** `perfis-acesso.js`, `perfis-api-map.js`, `pedidos.html`, `pedidos-pdv.html`, `test-pdv-rbac.js`.

### O desenho de `secoesVisiveisDoMenu`

O padrão da função é **incluir** os ocultos — quem esquecer o parâmetro mantém o comportamento antigo. Só o desenho pede a lista filtrada:

| Chamador | Filtra? | Por quê |
|---|---|---|
| `montarMenu` | **sim** | é o desenho da barra |
| `buscarRotinas` | não | a busca existe para alcançar o que não está à vista; quem **tem** a permissão não deve perder o atalho |
| `sincronizarModuloComPagina` | não | abrir por link direto no modo 'modulos' precisa saber a que módulo a página pertence, senão o menu abre no módulo errado |

O teste G1 conta as chamadas e reprova se mais de uma passar `paraDesenho: true`.

---

## 3. Como a página continua registrada

```js
// perfis-acesso.js — INALTERADO
for (const secao of menuConfig.secoes) {
  for (const item of secao.itens) {
    POR_PAGINA.set(item.page, { … });   // não olha `oculto`
    POR_LINK.set(item.link, item.page);
  }
}
```

E `podeVerPath`:

```js
const page = POR_LINK.get(pathname);
if (page) return permitidas.has(page);   // ← continua caindo aqui
```

Como `/comercial/pedidos-pdv.html` segue em `POR_LINK`, a checagem é **nominal**. O fallback por diretório — o trecho seguinte da função — nunca é alcançado para ela.

---

## 4. Como foi ocultada da barra

Um único ponto:

```js
const itens = secao.itens.filter(it =>
    (!it.feature || isFeatureEnabled(it.feature))
    && isPaginaPermitida(it.page)
    && !(paraDesenho && it.oculto));      // ← a única linha nova
```

Resultado na sidebar:

```
COMERCIAL
  Clientes & Fornecedores
  CRM · Funil
  Pedidos                    ← e dentro dela, o botão ⚡ Venda rápida
  Tabelas de Preço
  Vendas Perdidas
  Metas de Vendas
  Contratos
  Devoluções
```

---

## 5. Testes

`scripts/test-menu-oculto-rbac.js` — **15 testes, 15 OK**. Usa banco em memória (`:memory:`), nunca um tenant.

| Seu pedido | Teste | Resultado |
|---|---|---|
| **A.** continua registrada | A1, A2, A3 | ok — inclusive continua **atribuível** na tela de perfis |
| **B.** não aparece na sidebar | B1, B2, B3 | ok — some até para o irrestrito, e o resto do Comercial fica inteiro |
| **C.** com `pedidos` e sem `pedidos-pdv` | C1 | **não abre a URL direta** |
| **D.** com `pedidos-pdv` | D1 | abre a URL direta |
| **E.** sem fail-open por diretório | E1, E2 | ok — ver §6 |
| **F.** expandida e compacta | F1, F2 | ok — e a Venda rápida ainda recolhe a barra sozinha |

Dois testes que você não pediu e que valem citar:

- **B4/B5:** a **busca de rotina** continua achando a Venda rápida para quem tem a permissão, e **não** a oferece para quem não tem. Escondê-la também da busca tiraria um caminho legítimo sem ganho.
- **A3:** a página continua no `catalogo()`. Sem isso a permissão existiria e seria **inconcedível** — o admin não teria onde marcá-la.

### Provado por sabotagem

| Sabotagem | O que reprovou |
|---|---|
| **apagar a linha do menu-config** (o erro provável: "limpar a sidebar") | A1, **C1** (*"FAIL-OPEN: ocultar do menu liberou a URL direta"*), **E1**, E2 |
| **remover `oculto: true`** | A1, B1, B2 |

---

## 6. O fail-open por diretório NÃO voltou

Esta é a confirmação que importa, e ela é **executada**, não lida.

O teste **E2** exerce as duas regras lado a lado, com o `podeVerPath` real e um perfil que tem `pedidos` e não tem `pedidos-pdv`:

| Caminho | No menu? | Resultado esperado | Resultado |
|---|---|---|---|
| `/comercial/pedido.html` (detalhe) | não | **abre** por herança de diretório | abre |
| `/comercial/pedidos-pdv.html` | **sim** (oculta) | **bloqueia** — checagem nominal | bloqueia |

As duas convivendo é a prova de que `oculto` mexeu no desenho e não no mecanismo de acesso.

**A intenção do `test-pdv-rbac.js` B3 está preservada** — o teste continua passando sem uma linha alterada (11 ok).

---

## 7. Perfis atuais — levantamento, sem alteração

**Nenhum perfil foi criado, alterado ou concedido.** Somente leitura.

| Tenant | Perfil | tem `pedidos` | tem `pedidos-pdv` |
|---|---|---|---|
| `josecarloscostafilho` | `comercial` | sim | **não** |
| `sandbox` | `comercial` · `gerente-comercial` | sim | **não** |
| `sandbox2` … `sandbox6` | `comercial` · `gerente-comercial` | sim | **não** |

**13 perfis cadastrados, nenhum com `pedidos-pdv`.**

Os demais **12 tenants não têm perfil cadastrado** e caem no fail-open de `acessoDoUsuario` (`motivo: 'sem-perfil'` → irrestrito): `1bit`, `crsolucoes`, `hseletricista`, `jaagricola`, `labfiscal`, `levezi`, `lojasemijoias`, `opendesk`, `pccontabilidade`, `produtosbomgosto`, `raeldouglas`, `reimac`.

### O que isso significa hoje

| Quem | Vê o item no menu | Vê o botão em Pedidos | Abre a URL |
|---|---|---|---|
| admin / tenant sem perfil | não (oculto) | **sim** | sim |
| `comercial`, `gerente-comercial` | não | **não** | **não** |

Ou seja: **quem opera com perfil restrito ainda não alcança a Venda rápida** — e agora não vê promessa nenhuma dela, nem no menu nem na listagem. Coerente, mas é a **política padrão que ficou para você decidir**: conceder `pedidos-pdv` aos perfis comerciais, ou mantê-la como permissão de exceção.

---

## 8. Uma falha pré-existente encontrada — e não corrigida

`test-menu-perfil.js` já falhava antes desta fase, e continua com **3 falhas**, todas da mesma causa:

```js
linha  93: { page: 'pessoas', texto: 'Clientes & Fornecedores', link: '/comercial/pessoas.html' }
linha 255: { page: 'pessoas', texto: 'Fornecedores',            link: '/comercial/pessoas.html?categoria=fornecedor' }
```

**`page: 'pessoas'` aparece duas vezes**, em seções diferentes. O menu desenha dois itens, e o teste recebe `pessoas,pessoas` onde esperava `pessoas`.

Medi com e sem a minha mudança: **7 falhas com a mudança, 3 sem** — as 4 de diferença eram premissas de que "toda página registrada aparece no menu", que `oculto` torna inválidas. Essas eu corrigi (`TODAS` passou a ser "páginas desenhadas", mais dois casos novos para as ocultas). **As 3 restantes são anteriores e não toquei**: corrigi-las exige decidir se "Fornecedores" deve ter `page` própria — o que criaria uma permissão nova e é decisão de produto, não conserto de passagem.

O teste não está no `verify` nem no `package.json` — é de execução manual.

### Regressão — zero falhas novas

| Suíte | |
|---|---|
| `npm run verify` (agora com o passo 9) | **OK, 1,8 s** |
| `test-menu-oculto-rbac` | **15 ok** |
| **`test-pdv-rbac`** | **11 ok** — intenção do B3 preservada |
| `test-venda-rapida-nav` | 15 ok |
| `test-pdv-fluxo` · `test-pdv-visual` | 29 · 32 ok |
| `test-sidebar-botoes` · `test-fase321-ux` | 23 · 20 ok |
| `test-shell-boot` · `test-tema-global` | 24 · 21 ok |
| `test-fase33-topbar` · `test-fase34-identidade` | 40 · 26 ok |
| `test-fase1-funcional` · `test-app-backend` | 57 · 79 ok |
| `test-alcadas` · `test-governanca-percentual` | 41 · 29 ok |
| `test-menu-perfil` | 3 falhas **pré-existentes** (§8) |

---

## 9. O que o mecanismo abre para o futuro

`oculto: true` é genérico, não um remendo para esta página. Qualquer tela que precise de permissão própria sem poluir a barra pode usá-lo — telas de operação alcançadas por botão, assistentes, painéis de exceção. O teste G1 protege o desenho: só o desenho filtra.

---

## GO / STOP

**GO** para o que está no ar: tudo estático, já servido. Nenhum restart necessário.

**STOP** aqui, como pedido.

**Não foi feito:** alteração de perfil, banco, schema, endpoint, regra, tenant, serviço, commit. Nenhuma emissão fiscal, cobrança ou chamada externa.

**Ficou para você decidir** (§7): a política padrão de `pedidos-pdv` nos perfis comerciais. Hoje nenhum perfil restrito a tem — o sistema está coerente, mas esses usuários não alcançam a Venda rápida por caminho nenhum.

A ressalva honesta: validei executando `podeVerPath` e `gerarMenuHTML` reais em DOM e banco simulados. **Não abri o ERP autenticado com um perfil restrito** para ver a barra sem o item — a prova disso são os testes B1/B2, que montam o menu de verdade.
