# 44 — Gestão de categorias de produtos (implementação)

**Data:** 2026-09-13 · Implementa a Fase 43, aprovada.
**Sem tabela nova, sem FK, sem migration.**

---

## 1. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/catalogo/categorias.html` | **novo** — a tela |
| `produto-lookup-routes.js` | validação de duplicata, `PUT` (renomear), `POST …/excluir`, listagem com contagem |
| `public/js/menu-config.js` | item `cadastro-categorias`, entre Produtos e Etiquetas |
| `perfis-api-map.js` | `cadastro-categorias` em `/api/produto-lookup` e `/api/produtos` |
| `scripts/test-categorias-produtos.js` | **novo** — 27 asserções |
| `scripts/verify.js` | passo 18 |
| `test-sidebar-botoes` · `test-fase33-topbar` · `test-venda-rapida-nav` · `test-fase321-ux` | contagem do menu virou piso (ver §12) |

Nada de `produtos.categoria`, Venda rápida, orçamento, PDF, WhatsApp, fiscal,
CFOP, fotos ou crop.

---

## 2. A tela

`CATÁLOGO → Categorias` → `/catalogo/categorias.html`, logo depois de Produtos.
Segue o padrão das irmãs (Marcas, Cores…): mesmo cabeçalho, mesma toolbar com
busca, mesma tabela, mesmo modal.

Colunas: **Categoria · Produtos · Status · Ações**. Ordem alfabética
(`COLLATE NOCASE`) — sem coluna `ordem`, como combinado.

Dois avisos acima da tabela, quando cabem:

- **produtos sem categoria** — contagem, com o recado de que *isso não é uma
  categoria cadastrada*, é o campo em branco. Não vira linha da tabela nem
  registro no lookup;
- **duplicatas de caixa** — mostra `OUTROS` e `Outros` lado a lado, explica que
  o sistema as trata como diferentes, e aponta o caminho para unificar. **Não
  faz merge.**

---

## 3. Endpoints

Reutilizados, sem mudar contrato:

| | |
|---|---|
| `GET /api/produto-lookup/categoria` | **inalterado** — só ativos, `{id, valor}`. É o que o datalist de seis telas consome; mexer nele mudaria todas |
| `POST /api/produto-lookup/categoria` | agora valida duplicata de caixa |
| `DELETE /api/produto-lookup/categoria/:valor` | **inalterado** — continua sendo *inativar* |

Ampliados / novos:

| | |
|---|---|
| `GET …/categoria?todos=1&contagem=1` | inclui inativas, contagem de produtos e a marca `reservada` |
| `PUT …/categoria/:valor` | **renomear**, transacional e em cascata |
| `POST …/categoria/:valor/excluir` | **excluir** com destino dos produtos |

O teste `A2` trava a forma da resposta sem parâmetros, justamente porque seis
telas dependem dela.

---

## 4. Criar

`trim` nas bordas; vazio e só-espaços recusados com mensagem em português; e
**duplicata ignorando maiúsculas** recusada com 409, dizendo qual já existe:

> Já existe "TEMPEROS". Para o sistema, os dois seriam a mesma coisa escrita de
> formas diferentes.

A guarda vive **no servidor** (`conflitoDeCaixa`, com `COLLATE NOCASE`), não na
tela — por isso o botão `+` do cadastro de produto e a importação de planilha
passam por ela de graça. Reenviar o **mesmo** texto continua sendo reativação,
como nas telas irmãs.

Nenhum texto existente é alterado sem autorização.

---

## 5. Renomear

É a operação que toca dado de negócio em mais de um lugar. Roda dentro de
`db.transaction()`, que no better-sqlite3 é tudo-ou-nada:

```js
db.transaction(() => {
  UPDATE produto_lookup SET valor = ? WHERE id = ?
  UPDATE produtos            SET categoria       = ? WHERE categoria       = ?
  UPDATE comissoes_regras    SET categoriaProduto = ? WHERE categoriaProduto = ?
})();
```

A lista de destinos é declarada e comentada em `CONSUMIDORES_TEXTO_CATEGORIA`,
e cada tabela tem a existência conferida antes (módulos são opcionais por
tenant).

Recusa renomear para um nome que já exista em outra caixa. **Permite** corrigir
a caixa do próprio nome (`outros` → `OUTROS`), que não é duplicata — é o mesmo
registro se acertando.

Produtos **inativos** também são atualizados: eles guardam o texto e voltariam
com o nome velho.

---

## 6. Comissões

`comissoes-calculo.js:86` faz `r.categoriaProduto !== produto.categoria` —
igualdade exata de string. Um rename que atualizasse só `produtos` faria a regra
**deixar de casar**: sem erro, sem log, e a comissão sairia errada no fechamento
do mês.

Por isso `comissoes_regras` entra na mesma transação, e por isso os testes `H` e
`I` existem. O `H` termina verificando que produto e regra continuam apontando
um para o outro; o `I` derruba a transação de propósito e exige que **nada**
tenha sido gravado.

A exclusão com "mover" leva as regras para o mesmo destino — deixá-las apontando
para uma categoria que não existe mais é uma regra morta que ninguém vê.

---

## 7. Ótica

Confirmado antes de implementar. São comparações **exatas, em minúsculas**:

```
produtos-routes.js:76    AND p.categoria NOT IN ('armacao','lente')
produtos-routes.js:198   if (categoria === 'armacao') { …specs óticas… }
optica-routes.js:948     WHERE … p.categoria = 'lente'
optica-routes.js:1041    WHERE … prod.categoria IN ('lente','armacao')
```

`CATEGORIAS_RESERVADAS = {'armacao', 'lente'}` bloqueia renomear e excluir, com
**423** e a razão dita:

> "armacao" é usada internamente pelo módulo Ótica e não pode ser renomeada.

Na tela elas aparecem com a etiqueta **reservada** e sem botões — a explicação é
mais útil que um botão que vai recusar.

Bloqueia **nos dois sentidos**: também não deixa renomear uma categoria comum
*para* `armacao`/`lente`, o que plantaria produtos que a Ótica passaria a tratar
como armação/lente sem specs.

**Protegidas sempre**, inclusive com a Ótica desligada: o tenant pode ligá-la
depois, e aí o estrago já estaria feito e antigo.

---

## 8. Desativar

Inativa (`ativo = 0`) e reativa pelo POST, como as irmãs.

Comportamento documentado, e testado:

| | |
|---|---|
| Produtos que já a usam | **continuam com ela** — nada muda (teste `M`) |
| Datalist do cadastro de produto | **não a sugere** mais (teste `L`) |
| Tela de Categorias | mostra com "Mostrar inativas", para poder reativar |
| Relatórios e histórico | intactos — o texto continua no produto |
| Venda rápida / Loja | continuam derivando dos produtos, então ela segue aparecendo enquanto houver produto usando-a |

---

## 9. Excluir

Sem produtos: exclui direto.

Com produtos, **não exclui em silêncio** — devolve `409` com
`precisaDecisao: true` e a contagem, e a tela pede:

1. **mover** os produtos para outra categoria (destino escolhido; não pode ser
   ela mesma; tem de existir);
2. **deixar sem categoria** — `produtos.categoria = NULL`, que é o mesmo estado
   que o projeto já usa. Nada de gravar a string "Sem categoria";
3. cancelar.

Tudo numa transação, com as regras de comissão acompanhando.

---

## 10. Duplicidade

`Outros` e `OUTROS` **permanecem como estão** — conferido depois dos testes: as
7 categorias e os 6 produtos intactos. A tela apenas as aponta.

Novas duplicatas já não são aceitas, na criação e no rename.

**Nenhum índice `NOCASE` foi criado** — ele falharia com os dados atuais, como a
auditoria previu. Fica para a operação de unificação.

---

## 11. RBAC e multi-tenant

Perfil `cadastro-categorias`, como as irmãs. Sem coluna de tenant: o isolamento
é o banco por tenant, e o teste `T` prova com dois bancos que um rename num não
alcança o outro.

### Um problema que eu causei e o teste pegou

Rodei `scripts/gerar-mapa-api.js`, que é o jeito documentado de atualizar o
mapa. **Ele causou duas regressões:**

1. **removeu `'/api/orcamento-publico'` de `LIBERADOS`** — o link público do
   orçamento, aprovado na Fase 41. É um ajuste manual que o gerador não conhece;
2. **ampliou `pedidos-pdv` de 3 para 21 prefixos**, dando-lhe `/api/contratos`,
   `/api/cobrancas` e outros. `test-pdv-rbac` reprovou:
   *"pedidos-pdv liberou APIs alheias: /api/contratos"*.

Revertí o arquivo inteiro e adicionei **à mão** só o necessário: a página nova
nas duas listas que ela consome. O total de prefixos continua **176**, o
`pedidos-pdv` voltou a **3**, e o `orcamento-publico` está de volta.

> **Pendência para outra fase, fora deste escopo:** o gerador está
> dessincronizado do arquivo em produção. Enquanto isso não for resolvido,
> `node scripts/gerar-mapa-api.js` **não deve ser executado** — ele desfaz
> ajustes manuais e amplia acessos.

---

## 12. Testes

`scripts/test-categorias-produtos.js` — **27 asserções**, banco descartável
montado com o DDL real do tenant (recortado às tabelas envolvidas: o schema
inteiro leva 11 s por banco e o teste não terminava).

Cobre os itens A–T pedidos, mais: a resposta sem parâmetros não mudou (`A2`),
rename só de caixa (`I3`), destino inválido (`P2`), nenhum tenant fixo (`T2`),
menu e RBAC (`T3`), e ausência de migration (`U`).

### Os quatro testes que ajustei, e por quê

Quatro suítes travavam **`itens do menu === 190`** — travas de escopo de fases
que não deviam mexer no menu ("a Fase 3.2 é visual", "esta fase só renomeia").

Esta fase adiciona um item **aprovado**, então o número mudou para 191.
Trocá-lo por 191 só adiaria o problema: é um número mágico em quatro arquivos
que envelhece a cada tela nova. Troquei por **piso** (`>= 190`), porque o risco
que eles cobrem não é o total mudar — é **perder** um item, já que a chave do
menu está gravada em `perfis_acesso.paginas` nos tenants e removê-la tira o
acesso de quem já o tinha.

A garantia forte de cada suíte (os itens específicos daquela fase continuam lá)
não foi tocada. E a contagem de **rotas** do mapa de API (176) continua sendo
igualdade exata — essa eu não afrouxei, e foi ela que confirmou que minha
alteração de RBAC foi mínima.

---

## 13. Sabotagens

| Sabotagem | Reprovou |
|---|---|
| rename esquecendo `comissoes_regras` | `H` — *"a regra ficou com TEMPEROS — deixaria de casar"* |
| rename **sem transação** | `I` — *"o lookup ficou com o nome novo apesar da falha"* |
| aceitar duplicata de caixa | `E`, `I2`, `R` |
| excluir com produtos sem pedir decisão | `O` — *"excluiu sem pedir decisão (status 200)"* |
| remover a proteção da Ótica | `J` — *"armacao pôde ser renomeada"* |

---

## 14. Resultados

```
npm run verify — 18 passos, 228,3 s, todos verdes
  18. categorias de produto (test-categorias-produtos)   27 ok, 0 falha(s)
```

Relacionadas: `test-pdv-rbac` 11, `test-fase321-ux` 20, `test-app-backend` 79,
`test-etiquetas` 14, `test-pdv-fluxo` 29, `test-isolamento-tenant` 20 — todas
verdes.

**Falha pré-existente, não desta rodada:** `test-comissoes` quebra em
`no such table: fornecedores` — tabela removida em 20/08/2026, quando o cadastro
de fornecedor foi unificado em `pessoas`. Não toquei.

**Produção intacta**, conferido depois dos testes: as 7 categorias do
`produtosbomgosto` no lugar, `OUTROS` com 5 produtos e `Outros` com 1, e o
schema de `produto_lookup` sem alteração.

---

## 15. Migration

**Nenhuma.** Nenhum `ALTER TABLE`, nenhuma tabela nova, nenhum índice. O teste
`U` verifica que `produto_lookup` continua com as cinco colunas originais e que
não apareceu `ordem` nem uma segunda estrutura de categorias.

---

## 16. Restart

```
systemctl restart consulta-licitacoes.service
```

**Necessário:** `produto-lookup-routes.js` e `perfis-api-map.js` são carregados
pelo `server.js`. Sem o restart, a tela nova carrega (é estática) mas o
`PUT`/`excluir` respondem 404 e o RBAC não conhece a página.

Conferir depois:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health   # espera 302
```

Nenhuma variável de ambiente. Nenhum outro serviço.

---

## 17. O que testar

1. **CATÁLOGO → Categorias.** Devem aparecer as 7, com a contagem de produtos ao
   lado, e o aviso apontando `OUTROS` / `Outros`.
2. **Criar** `Temperos` (com essa grafia) → deve recusar, dizendo que já existe
   `TEMPEROS`.
3. **Criar** `CHOCOLATES` → deve entrar.
4. **Renomear** `CONFEITOS` para `CONFEITARIA` → 2 produtos acompanham. Confira
   em Produtos, e na **Venda rápida** a barra lateral deve mostrar o nome novo.
5. **Inativar** `CHOCOLATES` → some das sugestões no cadastro de produto, mas
   continua na tela com "Mostrar inativas". Reative.
6. **Excluir** `CHOCOLATES` (sem produtos) → sai direto.
7. **Excluir** `CONFEITARIA` (com produtos) → deve **pedir a decisão**. Escolha
   *mover* para outra e confirme que os produtos migraram.
8. Se o tenant tiver Ótica, confira que `armacao`/`lente` aparecem como
   **reservadas**, sem botões.

Para desfazer o passo 4, é só renomear de volta — a operação é simétrica.
