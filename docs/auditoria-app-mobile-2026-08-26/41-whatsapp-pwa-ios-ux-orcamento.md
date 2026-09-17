# 41 — WhatsApp no PWA iOS e ajustes de UX do orçamento

**Data:** 2026-09-12
**Origem:** segundo teste em iPhone físico, PWA instalado, `ORC-2026-00003`, após o restart.
**Escopo:** somente os pontos 1–10 do pedido. Não é auditoria nova.

> **Nota de numeração:** já existe um `41-isolamento-multi-tenant.md`. Mantive o
> nome de arquivo que você pediu; são dois documentos com o mesmo número.

**Aprovado no aparelho e por isso intocado:** Baixar PDF, o gerador, a
paginação, o `Content-Disposition` e a integração do PDF com o iOS.

---

## 1. A causa exata da tela vazia

Não é hipótese — está nos cabeçalhos HTTP:

```
$ curl -sSI https://wa.me/5544999990000
HTTP/2 302
location: https://api.whatsapp.com/send/?phone=...&app_absent=0
x-frame-options: DENY
```

**`wa.me` responde `x-frame-options: DENY`.** A correção anterior fazia
`location.href = 'https://wa.me/…'`, e dentro do shell **`location` é a do
iframe**. O navegador tentou carregar o wa.me enquadrado, recusou por política
de enquadramento, e o iframe ficou em branco.

A topbar continuou aparecendo porque **ela não foi navegada**: vive em
`app.html`, o documento de topo, que permaneceu intacto. É exatamente a sua
evidência visual — cabeçalho do LiciteAgora no lugar, tudo abaixo vazio.

O diagnóstico da rodada anterior estava certo sobre o `window.open` (a ativação
transitória realmente se perde após o `await`), mas a troca por `location.href`
resolveu o bloqueio de pop-up **criando um problema pior**: em vez de não
acontecer nada, o conteúdo do ERP foi destruído.

---

## 2. O contexto de navegação, confirmado no código

```
public/app.html:53   <iframe id="conteudo" name="conteudo" title="Conteúdo"></iframe>
public/app.html:55   <script>window.__liciteShell = true;</script>

public/js/sidebar.js:15  (function shellRedirect() {
                     15    if (window.__liciteShell) return;      // o shell não se redireciona
                     18    if (window.self !== window.top) return; // já enquadrada: fica
                     20    location.replace('/app.html#' + location.pathname + …);
```

Ou seja: **`pedido.html` praticamente nunca é a janela.** Toda página top-level
do ERP é mandada para dentro de `/app.html`, e passa a viver no iframe. Dentro
dela, `window` é o iframe e `location` é a dele.

Resposta direta às suas perguntas:

| Pergunta | Resposta |
|---|---|
| Qual URL final? | `https://wa.me/<tel>?text=<mensagem>` |
| wa.me, whatsapp:// ou api.whatsapp.com? | `wa.me`, que redireciona 302 para `api.whatsapp.com` |
| Aplicada ao iframe ou ao top-level? | **ao iframe** — era a falha |
| `pedido.html` roda dentro do shell? | **sim**, sempre, por `shellRedirect()` |
| `location.href` navegava só o iframe? | **sim** |
| Por isso o conteúdo fica vazio e a topbar fica? | **sim** — `x-frame-options: DENY` no wa.me, e `app.html` não foi tocado |

---

## 3. A solução para o iOS

**Web Share API primeiro** — e isto não é aposta: `entregarPdf()` já usa
`navigator.share` **deste mesmo iframe**, e foi o "Baixar PDF" que você aprovou
no aparelho. A capacidade está provada nesta arquitetura, com ativação
transitória sobrevivendo ao `fetch`.

A folha nativa tem uma vantagem que decide o caso: **ela não navega nada**. O
ERP fica exatamente onde está, o usuário escolhe WhatsApp (ou Mensagens, Mail,
o que quiser) e volta para o orçamento — sem risco de tela vazia, por
construção.

```js
const r = await compartilharTexto(msg);
if (r === 'enviado' || r === 'cancelado') { fecharDrawer(); return; }
```

Cancelar a folha **encerra a ação**. Insistir com o deep link depois disso
abriria o WhatsApp contra a vontade de quem acabou de desistir.

A ação continua se chamando **"Enviar orçamento via WhatsApp"**, como você
pediu — o que mudou é o caminho, não o rótulo.

---

## 4. O fallback (Android antigo e desktop)

Sem `navigator.share`, aí sim o deep link — **mas nunca no iframe**:

```js
function janelaDeNavegacao(){
  try {
    if (window.top && window.top !== window && window.top.location.origin === location.origin) {
      return window.top;
    }
  } catch (_) { /* enquadrada por outra origem */ }
  return window;
}
```

`window.top` é o `app.html`, da **mesma origem** — acessá-lo é legítimo e não
esbarra em política de origem cruzada. O `try` existe porque um dia esta tela
pode ser embutida por outro documento, e aí o acesso lança.

A partir dessa janela, `alvo.open(url, '_blank')`: no computador abre aba nova e
o ERP continua visível ao lado.

| Ambiente | Caminho |
|---|---|
| iPhone (Safari e PWA) | folha nativa; o usuário escolhe WhatsApp |
| Android moderno | folha nativa |
| Android antigo / desktop | `wa.me` em aba nova, aberta a partir de `window.top` |
| Pop-up barrado | painel com a mensagem para copiar |

Nenhum caminho navega o iframe. Nenhum usa `window.open` assíncrono sem
conferir o retorno.

### A mensagem

```
Olá! Segue o orçamento *ORC-2026-00003* da EMITENTE LTDA.

Valor total: *R$ 42,50*

Você pode visualizar e baixar o orçamento pelo link:
https://<tenant>.liciteagora.app/orcamento-comercial.html?token=<64 hex>
```

Número, empresa emitente, valor e link público HTTPS — os quatro que você
pediu, no formato que você sugeriu.

---

## 5. O ERP nunca fica em tela vazia

Se nada abrir, aparece um painel com a mensagem pronta, **sem sair do
orçamento**: Copiar mensagem, Abrir WhatsApp (que navega o *shell*, não o
iframe) e Fechar. O documento continua na tela, na aba em que estava.

O teste `C1c` trava isso, e a sabotagem confirma que ele reprova a versão
anterior.

---

## 6. Cabeçalho: só Salvar e Ações

Os atalhos `[PDF]` e `[WhatsApp]` saíram. Você tem razão de que eram
redundantes — subi-los foi decisão minha na rodada passada, e o teste real
mostrou que só poluíam um cabeçalho que no celular já divide espaço com número,
etiquetas, cliente, data e total.

As **funções continuam todas** em "Ações do orçamento": Baixar PDF, Visualizar
PDF, Imprimir PDF, Enviar via WhatsApp, Link público, Converter em pedido, venda
perdida e zona de perigo. O teste `B6` garante que remover o atalho não removeu
a função.

---

## 7. Descrição do item na tabela

**A causa:** a célula editável era um `<input type="text">` com
`min-width: 170px`. Um input é **sempre uma linha** — o `white-space: normal`
que a coluna já tinha nunca teve efeito sobre ele. Daí `MEIO TEMPERO COMPLET…`.

Duas mudanças:

1. **A célula virou `<textarea>` autoajustável**, como o campo do formulário.
2. **No celular a tabela de itens vira cards.** Nove colunas não cabem em 320px
   de jeito nenhum; rolando na horizontal, a descrição ficava espremida e o
   produto deixava de ser reconhecível — que é justamente o motivo de a
   descrição estar ali. Cada linha vira um bloco com rótulo sobre o valor
   (`data-rot`), a descrição ocupa a largura toda, e SKU, Qtd, Un, V.Unit, CFOP,
   Total e Remover continuam todos presentes.

**No computador nada muda:** a tabela continua tabela. Os cards só existem
abaixo de 640px.

### Um defeito que o teste no navegador pegou

`ajustarAltura` rodava na montagem da tabela — mas a aba Itens pode estar
oculta, e **`scrollHeight` de elemento em `display:none` é zero**. A altura saía
errada e o texto nascia cortado do mesmo jeito, só que por outro motivo.
Corrigido: os campos são reajustados quando a aba se torna visível. Não teria
aparecido em leitura de CSS nenhuma.

---

## 8. Nomenclatura contextual

Passaram a seguir o documento:

| Antes (sempre) | Em orçamento |
|---|---|
| Itens do pedido | Itens do orçamento |
| ← Voltar aos pedidos | ← Voltar aos orçamentos |
| Validade do pedido | Validade do orçamento |
| Código do pedido no cliente | Código do orçamento no cliente |
| Nº do pedido no ERP do cliente | Nº do orçamento no ERP do cliente |
| "Tabela do pedido definida" | "Tabela do orçamento definida" |

Somam-se ao título do painel ("Ações do orçamento") e aos rótulos das ações, já
contextuais.

"Confirmar pedido" e "Cancelar pedido" **não** foram tocados: eles só aparecem
quando o documento já é pedido.

**Nada de estrutura mudou** — nenhuma tabela, coluna, rota ou variável. O
documento continua sendo um `pedido` com `modoDocumento = 'orcamento'`, e é
exatamente isso que permite converter um no outro sem migração. O teste `B7`
verifica as duas coisas: os textos são contextuais **e** `modoDocumento`
continua existindo.

---

## 9. Arquivos alterados

| Arquivo | O que mudou |
|---|---|
| `public/comercial/pedido.html` | `compartilharTexto()`; `janelaDeNavegacao()`; `abrirWhatsApp()` fora do iframe; painel de mensagem para copiar; cabeçalho só Salvar/Ações; descrição da tabela vira textarea; cards no celular; `aplicarNomenclatura()`; reajuste de altura ao ativar a aba |
| `public/comercial/pedidos.html` | `janelaDeNavegacao()`; `whatsappLinha` com folha nativa e sem navegar o iframe |
| `scripts/test-orcamento-pwa.js` | `C1` reescrito, `C1b`/`C1c`/`B6`/`B7`/`D2b`/`D2c` novos, `B3` invertido |
| `scripts/test-orcamento-responsivo.js` | 4 verificações novas no Chrome |

Nenhum arquivo de backend mudou nesta rodada.

---

## 10. Testes

O teste do WhatsApp **não** se contenta com "existe `location.href`" — era
exatamente isso que a versão quebrada tinha. Ele verifica o **contexto**:

- nenhuma navegação sai de `location.*` sem passar por `janelaDeNavegacao()`;
- `janelaDeNavegacao` usa `window.top`, confere a origem e tem guarda;
- a folha nativa é tentada **antes** do deep link (senão o iOS nunca a veria);
- cancelar a folha não vira erro;
- falhar não deixa o ERP sem saída;
- a listagem, que roda no mesmo iframe, obedece à mesma regra.

### Sabotagens

| Sabotagem | Reprovou em |
|---|---|
| **a implementação anterior, literal** (`location.href` no iframe) | `C1` e `C1c` |
| folha nativa depois do deep link | `C1b` |
| listagem volta a navegar o iframe | `C1` |

### Resultado

```
npm run verify — 15 passos, 55,5 s, todos verdes

  14. fluxo do orcamento (test-orcamento-pwa)   43 ok, 0 falha(s)
  15. responsivo real                           22 ok, 0 falha(s)

OK: sintaxe válida — raiz, scripts/, public/, telas e shell
```

Suítes relacionadas, todas verdes: `test-app-backend` 79, `test-fase321-ux` 20,
`test-fase0-pagamento-pedido` 15, `test-fase1-funcional` 57,
`test-fase1-desconto-origem` 57, `test-pdv-fluxo` 29, `test-pdv-visual` 32,
`test-sidebar-botoes` 23.

Zero overflow horizontal medido no Chrome em **320, 360, 375, 390 e 430px**, nas
três telas do fluxo.

**Não testei em aparelho físico** — não tenho iPhone aqui. Chromium num servidor
não reproduz a folha de compartilhamento do iOS, que é o centro desta correção.

---

## 11. Restart

**Não é necessário.** Só arquivos de `public/` mudaram, e estáticos já estão no
ar ao salvar. Nenhum `.js` de raiz foi tocado nesta rodada.

**Mas o service worker guarda a versão anterior das telas.** Antes de testar:
feche o LiciteAgora no alternador de aplicativos e abra de novo. Se ainda vier a
tela antiga, remova o ícone da tela de início e instale novamente.

---

## 12. O que testar no iPhone

**1. Atualizar o PWA** (fechar no alternador e reabrir). Confirmar que o
cabeçalho agora tem **só Salvar e Ações**.

**2. Ações → Enviar orçamento via WhatsApp.** Esperado: **a folha de
compartilhamento do iOS** sobe de baixo. Escolher WhatsApp, o contato, e
conferir a mensagem com número, empresa, `R$ 42,50` e o link.
*É o ponto principal desta rodada.*

**3. Voltar ao ERP.** Deve continuar no `ORC-2026-00003`, **na mesma aba** —
sem tela vazia e sem cair em Itens.

**4. Cancelar a folha** numa segunda tentativa: deve simplesmente fechar e
voltar ao orçamento, sem erro e sem abrir o WhatsApp.

**5. Aba Itens.** A descrição do SKU 3066 deve aparecer **inteira**
("MEIO TEMPERO COMPLETO COM AÇAFRÃO"), em duas linhas se precisar, com Qtd,
V.Unit e Total rotulados logo abaixo.

**6. Títulos.** Conferir "Itens do orçamento", "← Voltar aos orçamentos" e
"Validade do orçamento".

**7. Baixar PDF** (regressão do que já estava aprovado): deve continuar abrindo
a folha e salvando `ORC-2026-00003.pdf`.

**8. Listagem → ⋯ → Enviar via WhatsApp:** mesma folha nativa, mesmo resultado.

**9. Por último:** o documento continua **orçamento**, mesmo número, sem fatura,
sem NF-e, sem movimento de estoque.

Se algo falhar, a mensagem na tela agora diz o que falhou — ela ajuda mais que a
descrição do sintoma.

---

## 13. O que não foi tocado

Baixar PDF e o gerador, paginação, cabeçalho/rodapé, `Content-Disposition`,
token público, revogação, isolamento multi-tenant, autenticação, RBAC,
responsividade global, textarea do formulário, abas mobile, lista de separação
só em pedido, orçamento sem gerar estoque/financeiro/fiscal, e a correção do
`PEDIDO`. Nenhuma regra fiscal, de estoque ou financeira.

O skeleton da Venda rápida continua parado, como combinado.
