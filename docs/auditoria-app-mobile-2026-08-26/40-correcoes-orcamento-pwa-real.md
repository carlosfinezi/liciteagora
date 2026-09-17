# 40 — Correções do fluxo de ORÇAMENTO após teste real no iPhone/PWA

**Data:** 2026-09-12
**Origem:** teste em iPhone físico, ERP instalado como PWA, documento `ORC-2026-00003`
(PARAISO COMERCIO DE ALIMENTOS LTDA, 1 item, R$ 42,50, SKU 3066).
**Natureza:** correção implementada, testada e verificada. Não é auditoria.

---

## 1. A causa exata do `Can't find variable: PEDIDO`

**Nunca existiu uma variável `PEDIDO`.** O objeto do documento sempre se chamou
`pedidoAtual` (declarado em `pedido.html:518`). O que existe com esse prefixo é
`PEDIDO_ID` — uma constante com o id vindo da URL —, e em algum momento alguém
escreveu `PEDIDO` supondo que houvesse um objeto análogo.

Duas linhas o referenciavam, e as duas montavam o **nome do arquivo PDF**:

| Onde | Linha (antes) | O que fazia |
|---|---|---|
| `baixarSeparacao` | `'SEPARACAO-' + ((PEDIDO && PEDIDO.numero) \|\| 'pedido')` | nome da lista de separação |
| `baixarPdf` | `(PEDIDO && PEDIDO.numero ? String(PEDIDO.numero) : 'documento')` | nome do PDF do documento |

### Por que o `&&` não protegeu

Essa é a parte que engana. `PEDIDO && PEDIDO.numero` **parece** uma guarda, e
seria, se `PEDIDO` fosse uma variável declarada com valor `undefined`. Mas
avaliar um identificador que não foi declarado em nenhum escopo lança
`ReferenceError` **antes** de o `&&` ter qualquer chance de curto-circuitar. A
única forma de testar um nome possivelmente inexistente é `typeof PEDIDO`.

### Por que passou despercebido tanto tempo

Três razões que se somam:

1. **`npm run verify` não pega, por construção.** Ele pergunta "isto parseia?",
   e `PEDIDO.numero` parseia perfeitamente — é sintaxe válida. O erro só nasce
   quando a linha *executa*.
2. **A linha só executa no fim do caminho feliz.** Ela vem *depois* do `fetch`
   do PDF e da conversão em Blob. Quem nunca clicou em "Baixar PDF" nunca a
   alcançou.
3. **O `catch` da própria função a engolia.** A exceção caía no
   `catch (e) { showAlert(mensagemDeRede(e)) }`, que a exibia como se fosse
   falha de rede. O PDF era gerado no servidor, chegava ao navegador, e o
   download simplesmente não acontecia — com uma mensagem que não ajudava.

Sobre "por que o Safari acusa e outros ambientes não": **não é diferença de
navegador.** Chrome e Firefox lançam o mesmo `ReferenceError`; só muda o texto
(`PEDIDO is not defined` contra `Can't find variable: PEDIDO`). A diferença é
que o teste real no celular foi a primeira vez que alguém clicou nesse botão.

### O que deixava de executar depois da exceção

Tudo o que vinha em seguida na função: a criação do object URL, o
`<a download>`, o clique programático e o `revokeObjectURL`. Ou seja, **o
download inteiro**. O `finally` ainda restaurava o rótulo do botão, então a
interface voltava ao normal e não havia sinal de que algo se perdera.

### A correção

Não foi trocar um nome em dois lugares. O nome do arquivo passou a sair de uma
função única, para que a confusão não volte por outro caminho:

```js
function nomeDoDocumento(){
  return (pedidoAtual && pedidoAtual.numero) ? String(pedidoAtual.numero) : 'documento';
}
```

### Dois defeitos idênticos que o teste novo encontrou

Ao escrever a verificação contra regressão (§7, bloco A), ela apontou **mais
duas** referências inexistentes, na função `onTrocarTipoOp`:

| Escrito | Nome real |
|---|---|
| `setDirty()` | `marcarDirty()` |
| `recarregar()` | `carregar()` |

Trocar o tipo de operação de um pedido lançava `ReferenceError` na primeira
linha e a função parava ali — a alteração não era marcada como pendente e o
re-cálculo de CFOP nunca acontecia. **Ninguém havia relatado**, e o defeito
estava lá pelo mesmo motivo do `PEDIDO`. Corrigidos os dois.

---

## 2. A causa do WhatsApp voltar para a aba Itens

**Não é submit de formulário.** Descartei essa hipótese cedo: não existe
nenhum `<form>` em `pedido.html` nem em `pedidos.html` (o teste B5 agora trava
isso). Também não é `preventDefault` faltando nem propagação de evento.

A causa é **perda da ativação transitória**:

```js
link = await obterLinkPublico(false);          // ← ida ao servidor
...
window.open(`https://wa.me/...`, '_blank');    // ← já não conta como "resposta ao toque"
fecharDrawer();
```

O navegador só permite abrir uma janela enquanto a ação for consequência direta
de um gesto do usuário. Passado um `await`, essa permissão expira, e o
`window.open` é **descartado em silêncio** — ele devolve `null`, e o código
antigo não olhava o retorno. A execução seguia para `fecharDrawer()`.

Da perspectiva de quem estava com o telefone na mão: o painel de ações fecha, o
WhatsApp não abre, e o que fica na tela é o conteúdo que estava por baixo — a
aba Itens. Parecia navegação; era o painel sumindo sobre uma tela que nunca
tinha saído dali.

### A correção

`location.href` no celular, que é **navegação e não pop-up** — nenhum navegador
a bloqueia. No iPhone ela entrega o link ao aplicativo do WhatsApp e o ERP fica
em segundo plano, de onde se volta pelo alternador de aplicativos. No
computador, manter a aba é melhor, então lá segue `window.open` — **e agora com
o retorno conferido**, caindo para navegação direta se o pop-up for barrado.

### Um segundo defeito no mesmo botão

A mensagem lia `window.EMITENTE_NOME`, **que ninguém nunca preencheu**. O
resultado é que a mensagem saía sem dizer de que empresa era o orçamento — o
cliente recebia número, valor e link, sem emitente. A rota
`POST /api/pedidos/:id/link-publico` passou a devolver a razão social junto do
token, o que resolve sem rota nova e sem chamada extra.

Mensagem atual:

```
Olá! Segue o orçamento *ORC-2026-00003* — PARAISO COMERCIO DE ALIMENTOS LTDA.
EMITENTE LTDA
Total: *R$ 42,50*

Ver e baixar o orçamento:
https://<tenant>.liciteagora.app/orcamento-comercial.html?token=<64 hex>
```

---

## 3. A causa do problema de "Baixar PDF" no iPhone/PWA

O gerador está correto e **não foi tocado** — o teste E2/E4 confirma que o PDF
sai com número, emitente, cliente, SKU, descrição completa, unidade,
quantidade, valores e o aviso "ORÇAMENTO — SEM VALOR FISCAL".

O backend também já estava certo: `?download=1` responde
`Content-Disposition: attachment; filename="ORC-2026-00003.pdf"`, e sem o
parâmetro responde `inline`.

O problema era **inteiramente do lado do navegador**, e tem duas camadas:

1. **O `ReferenceError` do §1** interrompia o download antes de ele começar.
   Essa era a falha imediata.
2. **Mesmo corrigido, `<a download>` não é confiável no iOS.** O Safari ignora
   o atributo em boa parte dos casos, e em PWA instalado não há barra do
   navegador: o PDF ocupa a tela inteira e não há caminho de volta. Foi
   exatamente o que você descreveu no item 5.

### A correção

Um caminho único, `entregarPdf()`, que escolhe pelo que o aparelho oferece:

| Ambiente | Caminho | O que o usuário vê |
|---|---|---|
| iPhone / Android moderno | `navigator.share({ files })` | folha nativa: Salvar em Arquivos, Imprimir, WhatsApp, Mail |
| Desktop (baixar) | `<a download>` com Blob | arquivo `ORC-2026-00003.pdf` na pasta de downloads |
| Desktop (imprimir) | iframe oculto + `print()` | diálogo de impressão, sem sair da página |

Cancelar a folha nativa (`AbortError`) **não é tratado como erro** — é o usuário
fechando de propósito.

Nada aqui usa `window.open` sujeito a bloqueio. E como a folha nativa é chamada
logo após o `fetch` do PDF, ela cabe com folga na janela de ~5 s de ativação do
WebKit; se ainda assim for recusada, a função cai para o download em vez de
deixar o usuário sem nada.

---

## 4. A causa do problema de impressão

`imprimirPdf()` era uma linha: `window.open('/api/pedidos/N/pdf', '_blank')`.

Em PWA instalado no iOS isso abre o visualizador de PDF **sem os controles do
Safari** — sem "Concluído", sem botão de compartilhar, sem seletor de
impressora. Não havia como controlar o diálogo porque **não havia diálogo**: o
iOS não expõe a impressão para JavaScript de página.

Tentar desenhar uma barra de impressão própria seria inventar uma interface
falsa, que é o que você pediu para não fazer. A saída correta é a que o próprio
iOS oferece: a **folha de compartilhamento tem "Imprimir"**, junto de salvar e
enviar. Então "Imprimir PDF" no celular passa pelo mesmo `entregarPdf()`, e o
usuário fecha a folha com um toque em Cancelar — sempre há retorno.

No computador nada disso se aplica, e lá o iframe oculto abre o diálogo de
impressão de verdade sem tirar ninguém da página.

O mesmo vale para "Visualizar PDF" (item 5): no celular vai para a folha
nativa, de onde se volta com um toque; no computador abre em aba nova, que tem
a barra do navegador.

---

## 5. Orçamento funciona antes de virar pedido

**Auditei o caminho inteiro procurando condição que exigisse conversão,
faturamento, status ou id pós-conversão. Não existe nenhuma.**

As rotas `/api/pedidos/:id/pdf`, `/separacao`, `/link-publico` e
`/api/orcamento-publico/:token` são todas leitura — `SELECT` mais geração de
PDF. A única escrita em todo o fluxo é o `UPDATE pedidos SET tokenPublico`, que
grava só o token de compartilhamento.

O teste **E14** prova isso rodando o fluxo inteiro e conferindo o banco depois:

```
modoDocumento .... 'orcamento'      (inalterado)
numero ........... ORC-2026-00003   (inalterado)
status ........... 'rascunho'       (inalterado)
faturaId ......... nulo
faturas .......................... 0 registros
estoque_movimentos ............... 0
reservas_estoque ................. 0
contas_a_receber ................. 0
notas_fiscais / nfe / nfce ....... 0
```

Nenhuma das ações converte, fatura, emite NF-e/NFC-e, baixa ou reserva estoque,
gera financeiro ou muda o status comercial.

**Uma coisa que passei a fazer, e o motivo:** as ações de documento salvam o
cabeçalho antes de gerar o PDF, se houver alteração pendente. Sem isso o PDF
sairia do banco e o cliente receberia um documento diferente do que está na
tela. É o mesmo auto-save que já acontecia ao trocar de aba, e **não converte
nada**.

---

## 6. Lista de separação em orçamento — a análise e a decisão

Você pediu para analisar antes de remover. A análise:

**Efeito operacional:** nenhum, tecnicamente. A rota é somente leitura e não
toca estoque — visualizar não reserva nem baixa nada.

**Risco real:** de interpretação, e é sério. A folha se chama "LISTA DE
SEPARAÇÃO", traz quantidades, caixas de conferência e campos "Separado por" e
"Conferido por". Quem a recebe no estoque **não tem como saber que a venda
ainda não existe** — o documento não diz isso em lugar nenhum. Uma folha dessas
circulando antes da aprovação do cliente faz separar mercadoria de uma venda
que talvez não aconteça.

**Decisão implementada:** as três ações só aparecem quando o documento já é
**pedido**, num grupo próprio chamado "Expedição". A rota **não foi
restringida** — ela continua servindo o pedido convertido, e restringi-la
quebraria o uso legítimo sem ganho. O que mudou é o menu deixar de oferecê-la
enquanto for orçamento.

---

## 7. Arquivos alterados

| Arquivo | O que mudou |
|---|---|
| `public/comercial/pedido.html` | `PEDIDO` → `pedidoAtual`; `setDirty`/`recarregar` → `marcarDirty`/`carregar`; `entregarPdf()` unificado; `abrirWhatsApp()` sem pop-up; painel de link público; título dinâmico do painel; separação só em pedido; PDF e WhatsApp no cabeçalho; descrição em textarea; abas com indicador e rolagem |
| `public/comercial/pedidos.html` | menu de ações por linha com Baixar PDF e WhatsApp |
| `public/js/sidebar.js` | `mensagemDeRede(e, oque)` — mensagem específica e distinção entre falha de rede e bug |
| `pedidos-routes.js` | `POST /link-publico` devolve `emitente` (razão social) |
| `scripts/verify.js` | passos 14 e 15 |

### Testes

| Arquivo | Situação |
|---|---|
| `scripts/test-orcamento-pwa.js` | **novo** — 37 asserções |
| `scripts/test-orcamento-responsivo.js` | **novo** — 18 asserções, Chrome real |
| `scripts/test-correcoes-mobile.js` | ajustado: D1, C5, E5, **F3 reescrito**, F4 novo |
| `scripts/test-separacao-danfe.js` | ajustado: C2, C3; **C4 novo** |
| `scripts/test-fase321-ux.js` | ajustado: G passa a verificar comportamento, não a forma da linha |

### O teste F3 estava medindo a coisa errada

Vale registrar, porque é o tipo de erro que passa por bom: ele contava tokens
nos bancos de **produção** e exigia zero. Passava enquanto ninguém usava o
recurso, e reprovou hoje — no **seu** compartilhamento real do ORC-2026-00003.
Ou seja, reprovava o sistema funcionando. Reescrito para provar a garantia que
importa: existe **um** ponto no código que grava `tokenPublico`, e é a rota que
o botão chama; abrir o pedido não gera token.

---

## 8. Como sei que os testes valem — as sabotagens

Um teste que passa não prova nada até se saber que ele reprovaria o defeito.
Reintroduzi cada um e conferi a reprovação:

| Sabotagem | Reprovou em |
|---|---|
| `pedidoAtual` → `PEDIDO` no nome do arquivo | `A4` (embutida no teste) |
| `window.open` direto depois do `await` no WhatsApp | `C1` |
| lista de separação de volta ao orçamento | `B2` **e** `C4` |
| título fixo "Ações do pedido" | `B1` |
| descrição volta a ser `<input type="text">` | `D2` **e** o teste no navegador |

Em todas o código foi restaurado logo em seguida.

O bloco A merece uma palavra: ele **não é busca de texto**. Monta a árvore
sintática com o `acorn`, coleta tudo que o script declara (incluindo parâmetros,
desestruturação e `window.X = ...` publicado de dentro de IIFE nos scripts
externos) e tudo que ele referencia em posição de leitura, e reprova a
diferença. Renomear a variável não engana o teste — foi assim que ele achou
`setDirty` e `recarregar` sozinho.

---

## 9. Resultados

```
npm run verify — 15 passos, 51,5 s

  1. .js da raiz e de scripts/                  535/535 OK
  2. .js de public/                             25/25 OK
  3. <script> inline das telas                  425/425 OK
  4–13. suítes anteriores                       todas verdes
  14. fluxo do orcamento (test-orcamento-pwa)   37 ok, 0 falha(s)
  15. responsivo real                           18 ok, 0 falha(s)

OK: sintaxe válida — raiz, scripts/, public/, telas e shell
```

**Mecanismos de validação que este projeto tem:** `npm run verify` (sintaxe por
`vm.Script` + 15 suítes) e as suítes funcionais em `scripts/test-*.js`.
**Não existem** ESLint, TypeScript nem build neste repositório — não há o que
executar nessas três frentes, e nenhum resultado delas é reportado aqui.

### Regressão ampla — as 88 suítes de `scripts/`

Rodei todas. As que tocam o que mexi estão verdes:

| Suíte | Resultado |
|---|---|
| `test-app-backend` (usa `pedidos-routes`) | 79 ok, 0 falha |
| `test-fase0-pagamento-pedido` | 15 ok, 0 falha |
| `test-fase1-funcional` | 57 ok, 0 falha |
| `test-fase1-desconto-origem` | 57 ok, 0 falha |
| `test-pdv-fluxo` / `-rbac` / `-visual` / `-natureza` | todas verdes |
| `test-fase321-ux` | 20 ok, 0 falha — **corrigido nesta rodada** |

**Uma falha era minha e está corrigida.** O `test-fase321-ux` reprovou no
teste G porque ele casava a *forma literal* da linha
`if (preencheuDesc) document.getElementById('itDesc').value = desc`, que virou
bloco quando a descrição passou a ser textarea (precisa reajustar a altura
junto). O comportamento nunca mudou; ajustei o teste para verificar o
comportamento em vez do texto.

**As demais falhas são anteriores a esta rodada e não foram tocadas** — nenhuma
tem relação com o fluxo de orçamento. Duas amostras, para registro:

- `test-orcamento.js` (o nome engana — é de orçamento de **OS**) quebra em
  `no such table: fornecedores`. Essa tabela deixou de existir em 20/08, quando
  o cadastro de fornecedor virou `pessoas` com categoria. Está quebrado desde
  então.
- `test-item24-lab.js` reprova em `fornecedores.chavePix` — mesma causa.
- Vários outros abortam por falta de dump de schema em `/tmp`, que esses testes
  exigem ser gerado antes.

Não corrigi nenhum deles: estão fora do que você pediu, e mexer neles agora
misturaria as coisas no mesmo diff.

### E2E do orçamento — os 16 pontos que você pediu

| # | Prova | Teste |
|---|---|---|
| 1 | permanece ORÇAMENTO | E1, E14 |
| 2 | PDF é gerado | E2 |
| 3 | nome `ORC-AAAA-NNNNN.pdf` | E3 |
| 4 | descrição completa no PDF | E4 |
| 5 | baixar funciona no fluxo suportado | E3 + C3 |
| 6 | token público criado | E5 |
| 7 | link abre sem sessão | E6 |
| 8 | PDF público abre sem sessão | E7 |
| 9 | WhatsApp recebe URL pública | C2 |
| 10 | URL interna não é enviada | C2 |
| 11 | token inválido → erro seguro | E9 |
| 12 | token revogado deixa de funcionar | E11 |
| 13 | novo token pode ser gerado | E12, E13 |
| 14 | página pública não permite edição | F2 |
| 15 | rota interna continua exigindo sessão | F1 |
| 16 | continua ORÇAMENTO no final | E14 |

O E2E roda em **banco descartável** (`/tmp/test-orcamento-pwa/e2e.db`), montado
a partir do schema real de um tenant lido em modo somente-leitura. Nenhum banco
de produção é tocado.

---

## 10. Segurança do link público

Preservada integralmente, e agora coberta por teste:

- token de `crypto.randomBytes(32)` — 64 hex, sem relação com o id (E5);
- **um único** ponto de escrita, a rota que o botão chama (F3);
- revogação apaga o token; o link antigo morre na hora, sem prazo nem cache (E11);
- gerar novo derruba o anterior (E12, E13);
- token inválido, id interno passado como token, `../../etc/passwd` e `%00`
  → todos recusados sem vazar nada (E9, E10);
- o recorte público não traz custo, margem, `vendedorId`, `userId`, `clienteId`,
  `faturaId` nem o próprio token (E8);
- a página pública não tem caminho de escrita nem chama `/api/pedidos/*` (F2);
- **`/api/pedidos/*` continua exigindo sessão** — só `/api/orcamento-publico/`
  está no bypass, e o teste F1 lê a lista real de prefixos liberados em
  `auth.js` para garantir que nada mais entrou (F1);
- isolamento por tenant, sessão e RBAC intocados; nenhum fallback de tenant.

---

## 11. UX mobile

| Item | O que mudou |
|---|---|
| Abas | desvanecido nas pontas indicando continuidade, rolagem suave, aba ativa trazida à área visível ao trocar |
| Descrição do item | `<textarea>` que cresce com o texto, 16px no celular, sem truncar |
| Ações principais | Salvar / PDF / WhatsApp / Ações em grade 2×2 no celular, alvo de 44px |
| Painel de ações | rótulos dizem "orçamento" ou "pedido"; separação some no orçamento |
| Link público | painel com Copiar / Gerar novo / Revogar, com confirmação — no lugar do `prompt` em que se digitava "REVOGAR" |
| Listagem | menu por linha com Baixar PDF, WhatsApp e Abrir |
| Erros | mensagem específica em português; detalhe técnico só no console |

"Converter em pedido" **não** subiu para o cabeçalho, de propósito: é a ação
irreversível do fluxo e não deve ficar encostada em "Baixar PDF".

### O que foi medido e o que não foi

**Medido no Chromium headless**, com a tela dentro de iframe (como o shell a
carrega), em 320, 360, 375, 390 e 430 px — sem estouro horizontal, sem campo
abaixo de 16px, nas três telas do fluxo. Mais: a faixa de abas rola de verdade,
o indicador acende e troca de lado, o painel cabe na tela, e a descrição longa
aparece inteira.

**Não testei em aparelho físico.** Não tenho iPhone nem Android aqui. Chromium
num servidor não reproduz a barra do Safari, o teclado do iOS, o `100vh` que
muda ao rolar, nem — e isto é o mais importante — o comportamento real da folha
de compartilhamento, que é justamente o centro das correções 3 e 4. O que está
provado é geometria e lógica; o resto está no §14.

---

## 12. Migrations, schema e variáveis de ambiente

**Nenhuma.** Nada de schema mudou, e por isso não houve migration nem backup
por esse motivo. A coluna `tokenPublico` já existia desde a rodada anterior.
Nenhuma variável de ambiente nova.

---

## 13. O que você precisa executar no servidor

Só um comando:

```bash
systemctl restart consulta-licitacoes.service
```

**Por quê:** `pedidos-routes.js` é carregado pelo `server.js`, e ele mudou (a
rota do link público passou a devolver o emitente). Sem o restart, o WhatsApp
continua mandando a mensagem sem o nome da empresa — o resto funciona.

Para conferir que subiu:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health
```

Deve responder `302`.

Os arquivos de `public/` (as duas telas e o `sidebar.js`) **já estão no ar** —
são estáticos. Talvez seja preciso forçar a atualização do PWA no iPhone: veja
o passo 0 abaixo.

Nenhum outro serviço precisa reiniciar. `scheduler.js` não carrega nada disso.

---

## 14. A sequência que eu preciso que você teste no iPhone

O que segue é exatamente o que não consigo provar daqui.

**0. Antes de tudo — atualizar o PWA.** O service worker guarda a versão
anterior das telas. Feche o app do LiciteAgora (deslize para cima no alternador),
abra de novo e puxe para atualizar. Se ainda vier a tela antiga, remova o ícone
da tela de início e instale de novo.

**1. Abrir o `ORC-2026-00003`.** Confirmar no topo: "Orçamento ORC-2026-00003",
etiqueta *orçamento*, e os botões **Salvar · PDF · WhatsApp · Ações** cabendo na
tela sem cortar.

**2. Tocar em "Ações".** O título deve dizer **"Ações do orçamento"**. Confirmar
que **não há** nenhuma "lista de separação" na lista, e que existe o grupo
Documentos com "Baixar PDF do orçamento".

**3. Baixar PDF.** Deve abrir a folha de compartilhamento do iOS. Escolher
**"Salvar em Arquivos"** e conferir que o arquivo se chama
`ORC-2026-00003.pdf`. *Este é o ponto mais importante da lista* — é o que
depende do `navigator.share`, que não consigo exercitar aqui.

**4. Visualizar PDF.** Mesma folha. Escolher **"Início Rápido"**. Conferir que
dá para voltar ao ERP tocando em Concluído/Cancelar, sem ficar preso.

**5. Imprimir PDF.** Mesma folha. Escolher **"Imprimir"** e conferir que o iOS
mostra o seletor de impressora. Cancelar volta ao orçamento.

**6. Enviar via WhatsApp.** Deve abrir o aplicativo do WhatsApp com a conversa
e a mensagem pronta, contendo:
número `ORC-2026-00003`, **o nome da sua empresa**, `Total: R$ 42,50` e o link
`https://.../orcamento-comercial.html?token=...`.
Voltar ao ERP pelo alternador de aplicativos e conferir que **continua no
orçamento**, não na aba Itens.

**7. Abrir o link recebido noutro aparelho**, ou no mesmo em janela anônima,
**sem sessão**. Deve mostrar o orçamento e permitir baixar o PDF, sem pedir
login e sem dar acesso a mais nada.

**8. Ações → Link público.** Conferir Copiar, Gerar link novo e Revogar (com
confirmação). Depois de revogar, **reabrir o link antigo** e confirmar que não
abre mais.

**9. Aba Itens.** Buscar o SKU 3066 e conferir que o campo Descrição mostra
**"MEIO TEMPERO COMPLETO COM AÇAFRÃO"** inteiro, em mais de uma linha se
precisar, sem cortar.

**10. Faixa de abas.** Conferir que dá para deslizar, que se percebe haver mais
abas à direita, e que ao escolher "Histórico" a aba escolhida fica visível.

**11. Voltar à listagem** e tocar no **⋯** da linha do ORC-2026-00003.
Conferir Baixar PDF e Enviar via WhatsApp funcionando dali.

**12. Por último, o que NÃO pode ter acontecido:** o documento continua sendo
**orçamento**, com o mesmo número, sem fatura, sem NF-e e sem movimento de
estoque.

Se algo falhar, o que me ajuda é a mensagem exata na tela — as genéricas
("Load failed") não existem mais, e cada erro agora diz o que falhou.

---

## 15. O que ficou de fora, e por quê

- **Não toquei no gerador de PDF.** Você disse que estava correto, e os testes
  confirmam. O que ele já fazia (altura medida, quebra de página, cabeçalho
  repetido, rodapé) continua provado — inclusive num orçamento de **42 itens**
  com descrições longas, no teste E15.
- **Não converto orçamento em pedido em lugar nenhum**, e "Converter" segue
  fora do cabeçalho de propósito.
- **Não restringi a rota `/separacao`** — só o menu deixou de oferecê-la em
  orçamento. Restringir a rota quebraria o pedido convertido sem ganho.
- **Nada de regra fiscal, estoque ou financeiro foi alterado.**
- **Não retomei o skeleton da Venda rápida**, como você pediu.
