# Fase 48 — Cabeçalho editável, ordenação exclusiva da vitrine e menu de configurações

Data: 2026-09-14 · Escopo: Catálogo Online (CATÁLOGO → Catálogo Online)

Referência de comportamento: screenshots do OlaClick fornecidos pelo usuário.
Nenhum código, asset, cor ou elemento de marca foi copiado — a leitura foi de
**fluxo**: onde ficam os controles, o que se edita no lugar e o que vai para um
painel à parte.

---

## 1. O que entrou

| Frente | Onde | Estado |
|---|---|---|
| Banner do cabeçalho (trocar/remover) | `loja_config.bannerPath` + `POST/DELETE /api/loja/banner` | pronto |
| Logotipo trocável pelo cabeçalho | rota `POST /api/loja/logo` já existia — ganhou o botão | pronto |
| Nome do catálogo editável no lugar | `PUT /api/loja/nome` | pronto |
| Link público sobre o banner | `.cap-link` na capa | pronto |
| Publicar / despublicar num clique | `POST /api/loja/publicar` | pronto |
| Ordem das CATEGORIAS na vitrine | `loja_categoria_ordem` + `PUT /api/loja/ordem-categorias` | pronto |
| Ordem dos PRODUTOS na vitrine | `produtos.ordemVitrine` + `PUT /api/loja/ordem-produtos` | pronto |
| Menu de configurações | `#menuCfg` na barra da página | pronto |
| Redes sociais, endereço, horários | — | **não entrou** (ver §7) |

---

## 2. Auditoria prévia (§7 e §14 do pedido)

Antes de escrever qualquer linha, o que já existia:

1. **Upload já existia, para logo.** `POST /api/loja/logo`: multer em
   `memoryStorage`, teto de 4 MB, validação por **assinatura de arquivo**
   (`imgs.tipoReal()`, não o content-type declarado), grava em
   `public/uploads/loja` e atualiza `loja_config.logoPath`. A rota de banner
   **reutiliza esse mesmo caminho** — mesma pasta, mesmo teto, mesma validação.
   Banner não existia: nem campo, nem rota.

2. **`loja_config` tinha** `id ativa nome descricao logoPath whatsapp email
   telefone mostrarPreco mostrarEstoque tema dataAtualizacao pagamentoModo
   pagamentoVencimentoDias`. Não tinha banner, redes sociais nem endereço.

3. **A distinção entre logo fiscal e logo da vitrine já existe por construção**:
   o fiscal é `fornecedor.logoBase64` (base64, usado na NF-e) e o da loja é
   `loja_config.logoPath` (caminho de arquivo). São campos, tabelas e formatos
   diferentes — trocar o da vitrine não toca no documento fiscal.

4. **Horários existem, mas presos ao Restaurante** (`rest_cardapios`,
   `rest_cardapio_horarios`). Reaproveitar exigiria desamarrá-los do cardápio —
   é fase própria, não um botão a mais aqui.

5. **Não havia nenhuma tabela de ordem.** Só `loja_config` e `loja_carrinho`.

---

## 3. Modelagem da ordem — e por que ela NÃO vaza

O pedido foi explícito: *"Não colocar `ordem` diretamente em `produto_lookup` se
isso fizer a ordenação vazar para o restante do ERP."* Ela faria. As duas
decisões:

### Categorias → tabela própria, `loja_categoria_ordem`

Categoria **não é entidade com id**: é texto em `produtos.categoria`, e
`produto_lookup` serve de catálogo de valores para o cadastro de produto. Pôr
`ordem` lá faria a ordenação da vitrine mandar também no datalist do cadastro e
na tela CATÁLOGO → Categorias, que são do ERP.

```sql
CREATE TABLE IF NOT EXISTS loja_categoria_ordem (
  categoria TEXT PRIMARY KEY,
  ordem INTEGER NOT NULL DEFAULT 0,
  dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
);
```

Casamento por nome. Categoria **ausente da tabela** nunca foi ordenada: vai para
o fim, em ordem alfabética. Ordenar três categorias não embaralha as outras
trinta.

### Produtos → coluna `produtos.ordemVitrine`

Coluna, e não tabela de ligação, por **coerência com o que já existe**:
`publicadoNaLoja` e `destaqueNaLoja` já são atributos de vitrine morando em
`produtos`. Uma tabela só para o terceiro criaria dois lugares para a mesma
coisa.

Ela não vaza porque **ninguém mais a lê**. O bloco D do teste vigia isso: nenhum
de `produtos-routes.js`, `pedidos-routes.js`, `estoque-routes.js`,
`produto-lookup-routes.js` nem a Venda rápida menciona `ordemVitrine`, e
`loja_categoria_ordem` só é lida por `loja-routes.js` e `db-schema.js`.

### O valor `0` e o CASE

`0` significa **"nunca ordenado"**, não "primeiro". Por isso o ORDER BY é:

```sql
ORDER BY CASE WHEN COALESCE(p.ordemVitrine, 0) > 0 THEN 0 ELSE 1 END,
         COALESCE(p.ordemVitrine, 0),
         p.descricao COLLATE NOCASE
```

Sem o `CASE`, todo produto nunca ordenado subiria ao topo — o oposto do
esperado. As posições gravadas começam em **1**.

---

## 4. A migration, contra o erro da Fase 46

O pedido pediu migration **aditiva, idempotente, aplicada aos tenants existentes
pelo caminho REAL, e testada contra o erro da Fase 46** (migration existir no
teste e não alcançar produção).

O caminho real é **`db-schema.js` / `initSchema`**: `tenant-manager.js:507` o
chama no **primeiro open de cada tenant**. O `migrar*DB()` dos `*-routes.js` é
no-op em multi-tenant — no registro das rotas o `db` ainda é o proxy sem
contexto. Foi exatamente isso que deixou `destaqueNaLoja` em 0 dos 19 tenants na
Fase 46, com 18 testes verdes.

### O achado que mudou o desenho: `crsolucoes`

Auditando os 19 tenants antes de mexer em schema:

```
1bit ✓  crsolucoes ✗  hseletricista ✓  jaagricola ✓  josecarloscostafilho ✓
labfiscal ✓  levezi ✓  lojasemijoias ✓  opendesk ✓  pccontabilidade ✓
produtosbomgosto ✓  raeldouglas ✓  reimac ✓  sandbox…sandbox6 ✓
```

**`crsolucoes` não tem a tabela `loja_config`.** E o `alterSafe` do
`db-schema.js` engole `no such table` em silêncio (linha 700). Um `ALTER TABLE
loja_config` só ali seria no-op calado justamente nesse tenant — e a tabela,
quando nascesse, viria sem a coluna.

Por isso o ALTER de `bannerPath` vai em **dois lugares**, e cada tenant é
alcançado por um deles:

| Caminho | Alcança |
|---|---|
| `db-schema.js` (boot, por tenant) | os 18 que já têm `loja_config` |
| `migrarLojaDB` (criação da tabela) | tenant novo e o `crsolucoes` quando a tabela nascer |

`produtos.ordemVitrine` e `loja_categoria_ordem` ficam **só** no `db-schema.js`:
`produtos` existe em todos os 19, então um caminho basta.

Nada é destrutivo: são `ALTER ADD COLUMN` com default e `CREATE TABLE IF NOT
EXISTS`. Nenhuma linha existente é reescrita.

---

## 5. UX

**Cabeçalho.** Os controles ficam **sobre o banner**, em pílula escura
translúcida — o banner é imagem do lojista e pode ser clara ou escura, então
contraste fixo com o tema não serve.

- **Link público** no canto superior esquerdo, com *Copiar* e *Abrir*. Saiu do
  rodapé da capa: é o que o lojista mais procura ali, e no rodapé passava batido.
  O rodapé foi removido — manter os dois duplicaria a mesma URL.
- **Trocar capa / Remover** no canto superior direito. *Remover* só aparece
  quando há banner.
- **Logotipo** clicável, com lápis no canto.
- **Nome editável no lugar** (`contenteditable`), sem modal: é um campo só, e
  mandar o lojista a um formulário inteiro para trocar uma palavra é o que fazia
  ninguém trocar. `Enter` ou sair salva; `Esc` desiste.
- **Selo de status** virou botão: publica e despublica num clique.

**Menu de configurações** (⚙️), com Aparência, Gerenciar categorias, Contato ·
preço · pagamento, e Ver a vitrine publicada. Um menu, e não seis botões na
barra: são ajustes ocasionais, e ocupando a barra empurrariam para baixo o que se
usa todo dia.

**Ordenação por setas ▲▼**, nas categorias (painel da esquerda) e nos produtos
(dentro do bloco da categoria). Ponta da lista tem a seta correspondente
desabilitada. Cada clique manda a **lista inteira** na ordem nova, não um delta:
com deltas, uma requisição perdida deixa a numeração furada para sempre e nada
avisa.

**Com busca ativa, as setas somem.** A lista na tela é um recorte, e subir "uma
posição" dentro dele moveria o produto para um lugar que o lojista não está
vendo.

---

## 6. Testes

`scripts/test-catalogo-48.js` — **28 casos, 28 verdes**.

| Bloco | O que mede |
|---|---|
| **A** (4) | Migration pelo caminho REAL. Chama `initSchema` e só ele. A2 reproduz o tenant que já tem `loja_config`; A3 reproduz o `crsolucoes` |
| **B** (9) | Ordem no servidor, contra SQLite de verdade: grava, relê, confere. Inclui a vitrine pública e as recusas de entrada inválida |
| **C** (11) | UX no Chrome: clicar, digitar, `Esc`, medir geometria |
| **D** (4) | O que o pedido proibiu: vazamento para o ERP, byte NUL, JS inline que não parseia |

### Dois defeitos que os testes pegaram

1. **`Esc` gravava a razão social como nome próprio.** `salvarNome` comparava o
   texto digitado com `loja.nome` **do banco**. Quando o nome vem por recuo da
   razão social, `nomeProprio` é falso, mas o campo **mostra** o nome da empresa
   — então repor o texto e sair gravava esse nome como escolha do lojista, sem
   ninguém ter digitado nada. Corrigido com `onfocus`, que memoriza o **texto
   exibido**; a comparação passou a ser contra ele.

2. **O harness não reproduzia o shell — e isso escondia cliques impossíveis.**
   `IN_SHELL` (`sidebar.js:10`) exige `window.parent.__liciteShell === true`. O
   shell falso do teste não declarava isso, então a tela se julgava avulsa e
   desenhava a **própria topbar fixa** sobre os 52px de cima do conteúdo. Um
   clique por coordenada no cabeçalho acertava a barra, não o botão. Em produção
   a topbar é do `app.html`, que reserva o espaço posicionando o iframe em `top:
   var(--topbar-h)`. O harness passou a fazer as duas coisas.

   Vale registrar: **os harness das fases anteriores têm a mesma lacuna.** Eles
   passaram porque não clicavam por coordenada no cabeçalho.

### Sabotagem

Teste que passa não é teste que prova. Cada defeito foi plantado de propósito,
um por vez, exigindo que o caso correspondente **reprovasse**.

<!-- RESULTADOS-SABOTAGEM -->

Cópias em `/tmp/sab48-*.bak` e restauração ao final — nunca `git checkout`, que
nesta árvore apaga trabalho não commitado.

---

## 7. O que NÃO entrou, e por quê

- **Redes sociais, endereço e horário de funcionamento.** Nenhum tem campo hoje,
  e horário esbarra em `rest_cardapio_horarios`, preso ao Restaurante.
  Preferi **não colocar botão que finge funcionar**: um campo que não persiste é
  pior que campo nenhum.
- **Arrastar e soltar.** Setas ▲▼ funcionam no toque e no teclado sem biblioteca
  nova. Arrastar entra depois, se o uso pedir.
- **Ordem dos destaques.** A faixa de destaques usa a mesma coluna
  `ordemVitrine`, então já segue a ordem da categoria de origem. Ordem própria
  para destaques exigiria uma segunda coluna — não foi pedido.

---

## 8. Pendências que seguem abertas

- **`crsolucoes` não tem `loja_config`** — a loja dele já não funcionava antes
  desta fase (o `GET /api/loja/catalogo` responde 500 em `lerConfig`). Não
  corrigi: está fora do escopo pedido e mexer nisso é decisão sua. O caminho é
  rodar `migrarLojaDB` nesse tenant.
- `scripts/gerar-mapa-api.js` continua **interditado** e precisa de conserto.
  Nada aqui exigiu tocá-lo: `/api/loja` já é prefixo conhecido do
  `perfis-api-map.js`, e as cinco rotas novas entram por ele.
- vhost de `jaagricola` / `labfiscal`; `daemon-reload` da unit systemd.
- 3 falhas pré-existentes em `test-menu-perfil`; `test-comissoes` e
  `test-orcamento.js` quebrados por `no such table: fornecedores` desde 20/08.

---

## 9. Fechamento da fase — diagnóstico no ambiente real (14/09, tarde)

### 9.1 Causa raiz nº 1: a Fase 48 nunca esteve em vigor

Medido no tenant `produtosbomgosto`, contra a produção viva:

| Verificação | Resultado |
|---|---|
| `PUT /api/loja/ordem-categorias` | **404** — a rota não existe no processo vivo |
| `banner` no JSON de `/api/loja/catalogo` | ausente |
| `produtos.ordemVitrine` | **não existe** |
| `loja_categoria_ordem` | **não existe** |
| `loja_config.bannerPath` | **não existe** |
| `consulta-licitacoes.service` no ar desde | 09:44 |
| `loja-routes.js` / `db-schema.js` alterados em | 10:34–10:36 |

A tela é estática (`public/`), então o HTML novo **já estava no ar** com os
controles ▲▼ — mas o backend que responde é anterior à fase. O clique saía,
levava 404 e virava *"Não foi possível concluir a operação."*

O schema não chegou a tenant nenhum porque `initSchema` roda **no primeiro open
de cada tenant, dentro do processo** (`tenant-manager.js:507`), e o processo vivo
é anterior às mudanças. **Sem restart, nada da fase existe.**

### 9.2 Causa raiz nº 2: contexto de tenant perdido no upload

Reproduzido no tenant real, não deduzido:

```
POST /api/loja/logo -> 400
{"success":false,"error":"tenant-middleware: currentDb() chamado fora de contexto de tenant"}
```

O multer lê o corpo com busboy, e **callback de stream não carrega o
AsyncLocalStorage**: os callbacks rodam no contexto de quando o socket nasceu,
antes do `tenantStorage.run()`. Quando o handler executa, o store sumiu e o
proxy do db estoura na primeira query.

O projeto **já tinha o remédio**: `reentrarContextoTenant`
(`tenant-middleware.js:224`), com a explicação escrita no próprio arquivo. Ele é
usado por contas-receber, contratos, financeiro, OS, importação, contas-pagar e
conciliação. As rotas de logo e banner eram as **únicas de upload da loja sem
ele** — o logo desde a Fase 45; o banner herdou o defeito por espelhar a rota de
logo sem notar que ela já estava quebrada.

**Evidência colateral:** `public/uploads/loja/` guardava dois logos órfãos, de
10:25 e 10:28 (2,4 MB e 1,3 MB) — as tentativas do usuário, em que o arquivo
subiu e a gravação no banco falhou. Nenhum tenant os referencia. Mantidos: são
imagens dele, não resíduo de teste.

### 9.3 Isolamento entre tenants — o que foi achado e o que foi feito

`uploads/loja` é pasta **única para todos os tenants** — padrão de todas as
pastas de upload deste projeto (`produtos`, `os`, `cr`, `cp`…). Mudar isso agora
quebraria os `logoPath` já gravados, e não foi pedido.

O que **era** risco real: o nome dependia só de `Date.now()`. Dois uploads no
mesmo milissegundo, em tenants diferentes, gravariam no mesmo arquivo — um
sobrescrevendo a imagem do outro. Agora o nome é
`logo-<slug>-<tempo>-<6 bytes aleatórios>.png`: colisão deixa de ser possível na
prática, e o nome passa a dizer de quem é o arquivo.

### 9.4 Arquivos alterados nesta rodada

| Arquivo | Mudança |
|---|---|
| `loja-routes.js` | `reentrarContextoTenant` nas rotas de logo e banner; `nomeImagemLoja()` carimbando o slug |
| `scripts/test-catalogo-48-upload.js` | **novo** — 6 casos, cadeia HTTP real |
| `scripts/test-catalogo-online.js` | harness passou a aplicar os ALTERs de vitrine que o boot aplica |

### 9.5 Testes e sabotagens

| Suíte | Resultado |
|---|---|
| `test-catalogo-48.js` | 28 ok, 0 falha |
| `test-catalogo-48-upload.js` | 6 ok, 0 falha |
| `test-catalogo-online.js` (Fase 46) | 22 ok, 0 falha |
| `test-catalogo-online-ux.js` (Fase 47) | 23 ok, 0 falha |
| `npm run verify` | **OK**, 21 suítes, 328 s |

Sabotagens do upload — **4 de 4 pegas**:

| Defeito plantado | Reprovou |
|---|---|
| `reentrarContextoTenant` removido do logo | E7, com a mensagem literal de produção |
| `reentrarContextoTenant` removido do banner | E8, idem |
| nome volta a ser só timestamp | E9 — "os dois tenants gravaram no MESMO arquivo" |
| validação por assinatura removida | E-extra — aceitou um `.php` renomeado |

O teste usa o **proxy** de db (`createDbProxy`), e não o banco direto: é o proxy
que chama `currentDb()`. Com o banco direto o defeito desaparece e a suíte ficaria
verde sobre código quebrado — que é como ele chegou até produção.

### 9.6 Regressão encontrada e corrigida

`test-catalogo-online.js` (Fase 46) passou a reprovar 8 casos quando
`ordemVitrine` entrou no SELECT do catálogo. O harness montava o banco só com
`migrarLojaDB` — **a migration que o boot real não chama**, exatamente o
anti-padrão listado no pedido. Corrigido: o harness agora aplica os ALTERs que o
`initSchema` aplica no boot.

---

## 10. Estado de produção

- **Working tree = produção.** O código corrigido está salvo, mas **não está em
  vigor**: falta restart do `consulta-licitacoes.service`.
- Banco dos 19 tenants: **intacto**, sem nenhuma das três estruturas da fase.
  Elas nascem no primeiro acesso a cada tenant depois do restart.
- `public/uploads/loja/`: os 7 arquivos de teste foram apagados; os 2 logos do
  usuário foram mantidos.
- `loja_config` do `produtosbomgosto`: `logoPath` continua `NULL`, como estava
  antes — a tentativa de upload falhou antes de gravar.

### Restart: necessário

| Arquivo | Carregado por | Efeito |
|---|---|---|
| `loja-routes.js` | `server.js` | rotas novas passam a existir |
| `db-schema.js` | `server.js` (via `tenant-manager`) | `initSchema` cria as 3 estruturas por tenant |
| `public/catalogo/*` | — | já no ar |

Restart de `consulta-licitacoes.service`. **Não** dispara os avisos de alçada nem
o watchdog do catálogo — aquilo depende do `liciteagora.service`, não tocado.

<!-- ESTADO-PRODUCAO -->
