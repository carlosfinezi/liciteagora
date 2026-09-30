# Fase 2A — motor NFC-e para o Catálogo Online

Levantado e implementado em 28/09/2026, em duas etapas: primeiro a auditoria
da biblioteca e o montador de payload, em arquivos novos; depois as quatro
alterações no emissor. Nada foi transmitido à SEFAZ, nenhum documento fiscal
foi emitido, nenhuma migração rodou e nenhum serviço foi reiniciado.

| Arquivo | O que é |
|---|---|
| `nfce-payload.js` | **novo** — traduz um pedido do catálogo no payload do emissor |
| `nfce-routes.js` | **alterado** — +72 −9 dentro do `emitirNFCe` |
| `scripts/test-nfce-payload.js` | **novo** — 42 asserts sobre a tradução |
| `scripts/test-nfce-lib-mod65.js` | **novo** — 38 asserts sobre a `node-sped-nfe` no modelo 65 |
| `scripts/test-nfce-motor-catalogo.js` | **novo** — 50 asserts sobre o emissor, com a SEFAZ substituída |

As três suítes passam inteiras, e passam sob a guarda
`scripts/guarda-dados.js` — nenhuma escreve em `data/`.

`db-schema.js`, `server.js` e `nfe-emit-routes.js` **não foram tocados**. O
`ordemPt` que outra frente commitou no `nfce-routes.js` às 13:44 está
preservado integralmente.

**O Catálogo Online ainda não está ligado à emissão.** Nenhuma rota da loja
chama o `emitirNFCe`; o que existe é o motor pronto para receber o que o
montador produz.

## 1. O que a biblioteca entrega no modelo 65

### IBS/CBS funciona igual ao modelo 55

`tagProdIBSCBS` aceita no 65 exatamente a mesma estrutura que
`nfe-emit-routes.js:728` monta para o 55, e o acumulador `IBSCBSTot` soma do
mesmo jeito. O bloco IBS/CBS gerado nos dois modelos é **byte a byte
idêntico** — é o assert A5 da suíte da biblioteca, e ele compara os dois XMLs
recortados, não a presença das tags.

A diferença entre um XML 55 e um 65 montados com o mesmo conteúdo é só o que
se espera: `mod`, `tpImp` (4 = DANFE NFC-e), o dígito verificador da chave, o
`infNFeSupl` com QR Code, e a substituição do `xProd` do primeiro item pela
frase de homologação, que a lib faz sozinha no 65.

Consequência prática: quando algum tenant ligar `nfe_config.ibsCbsAtivo`
(hoje são **zero**), a lógica IBS/CBS da NF-e pode ser reaproveitada como
está. Não há trabalho de adaptação por causa do modelo.

### O DANFCe existe e gera PDF

`vendor/node-sped-pdf` (`node-sped-pdf@1.0.66`) exporta `DANFCe`, `DANFe` e
`DAV55`. `DANFCe` é uma função assíncrona que recebe `{ xml, xmlRes, logo,
extras, imgDemo }`. Provada com fixture: **PDF de 4.669 bytes em 304 ms**,
começando em `%PDF-`.

O padrão de chamada é o mesmo que a NF-e 55 já usa em
`nfe-emit-routes.js:1143`:

```js
const { DANFCe } = await import('./vendor/node-sped-pdf/index.js');
const buf = await DANFCe({ xml: nota.xmlAssinado, logo });
```

A prova precisou de fixture porque **nenhum dos 19 tenants tem NFC-e
emitida** — zero registros com `xmlAssinado`.

### O que a lib NÃO faz, e o contorno de cada caso

- **`tagEntrega` lança `"Ainda não configurado!"`.** O grupo `<entrega>` é
  justamente o que distingue a venda com entrega do catálogo. O contorno é o
  mesmo que `farmacia/nfe-med-rastro.js` já usa para `<med>` e `<rastro>`:
  injetar o trecho no XML entre a montagem e a assinatura. Está em
  `nfce-payload.injetarEntrega()`.
  `tagRetirada`, ao contrário, está implementada e gera `<retirada>`.

- **`tagTroco` e `tagDetPag` gravam chaves do mesmo objeto**, então a ordem
  no XML é a ordem em que foram chamadas. Chamar `tagTroco` primeiro produz
  `<vTroco>` antes de `<detPag>`, que é fora da sequência do schema
  (rejeição 215). O assert C3 guarda isso: se a lib passar a ordenar sozinha,
  o teste avisa.

- **O QR Code do XML não assinado é só a URL base.** O `Make.xml()` monta o
  `infNFeSupl` com a URL sem parâmetros; o valor definitivo, com o hash SHA-1
  do CSC, só é calculado dentro de `xmlSign`. Quem ler `qrCode` antes de
  assinar pega uma URL nua — é por isso que o emissor lê o `qrCodeUrl` do
  `xmlAssinado`, e não do `xmlRaw`.

- **Contingência offline quebra.** Em `tpEmis != 1`, a função de QR Code lê
  `NFe.Signature.SignedInfo.Reference.DigestValue`, mas ela roda **antes** da
  assinatura — `Signature` ainda não existe. Não nos afeta hoje porque
  `nfce-routes.js:450` crava `tpEmis: '1'`, e o desenho mantém assim. Se
  algum dia a contingência for oferecida, este é o obstáculo.

### As URLs de webservice do modelo 65 estão completas

`consultarNFe` deriva a UF pela chave e troca `PA` por `SVRS`. A combinação
`SVRS` + `mod65` existe na tabela da lib, com `NFeConsultaProtocolo`,
`NFeRecepcaoEvento` e `NFeAutorizacao` nos dois ambientes. Ou seja, a consulta
por chave e o cancelamento funcionam para NFC-e do Pará.

Um detalhe que não atrapalha: `SVRS.mod65` não tem `NFeConsultaQR` nem
`urlChave`. Quem usa essas duas é o `Make`, que indexa pela UF do **emitente**
(`PA`), onde elas existem.

`SVAN` não está na tabela — chave do Maranhão faria `consultarNFe` estourar.
Fora do nosso caso, registrado por ser barato registrar.

## 2. O buraco do retry, e por que ele é o achado mais caro

Hoje, em `nfce-routes.js:562-572`:

```js
try {
  xmlAssinado = await tools.xmlSign(xmlRaw);
  const resposta = await tools.sefazEnviaLote(xmlAssinado, { indSinc: 1 });
  respStr = ...;
} catch (err) {
  if (reservaReceitaIds.length) liberarDispensacao(db, reservaReceitaIds);
  throw err;
}
```

O `catch` trata rede e SEFAZ fora do ar como "não aconteceu nada". Mas o
timeout da lib (`req.setTimeout` → `TimeoutError`) dispara **do nosso lado**, e
não diz nada sobre o que a SEFAZ fez com o lote. Existe uma janela real em que
a nota foi autorizada lá e a resposta não chegou aqui.

O que acontece nessa janela:

1. Nada é gravado em `nfce` — a nota autorizada fica invisível para o ERP.
2. `avancarSerie` não roda, porque só roda no ramo `autorizada`. O próximo
   `nNF` continua sendo o mesmo.
3. A retentativa monta uma nota com o **mesmo número e a mesma série**, e a
   SEFAZ responde 204 (duplicidade) ou 539 (duplicidade com chave diferente,
   quando o `cNF` aleatório mudou).

O segundo caso é o pior: a numeração fica travada, e o operador vê "duplicidade"
sem ter em mãos a nota que a causou.

O conserto não exige campo novo nem tabela nova, porque `consultarNFe(chave)`
responde exatamente a pergunta que falta. A chave é conhecida **antes** do
envio: ela está no `Id` do XML assinado, e o emissor já a extrai assim na
linha 581.

## 3. O que entrou em `nfce-routes.js` — IMPLEMENTADO em 28/09, 15h

Esta era a lista do que faltava, e os quatro primeiros itens **foram
aplicados**. Nenhum criou coluna, tabela ou migração: são alterações dentro do
`emitirNFCe`, +65 −8 linhas, e a suíte `scripts/test-nfce-motor-catalogo.js`
(48 asserts) cobre cada uma.

O arquivo continua **desconectado do Catálogo Online**: nenhuma rota da loja
chama o emissor. O que existe agora é um motor que aceita os campos; quem os
manda é a fase seguinte.

Os quatro campos novos do payload são todos **opcionais**, e a ausência de
cada um reproduz o comportamento anterior. Metade da suíte existe só para
provar isso — o bloco A mede que o balcão sai com `indPres 1`, `modFrete 9`,
`vFrete 0.00` e sem grupo de entrega.

O texto abaixo descreve cada item como ele ficou.

### 3.1 Reconciliar por chave quando o envio falha (o item 2 acima)

No `catch` do envio, antes de liberar a reserva e propagar:

```js
} catch (err) {
  // A chave já existe no XML assinado, então dá para perguntar à SEFAZ o que
  // ela fez com a nota. Sem esta consulta, um timeout de rede vira nota
  // autorizada invisível e numeração travada em duplicidade.
  const chaveEnviada = xmlAssinado && (xmlAssinado.match(/Id="NFe(\d{44})"/) || [])[1];
  if (chaveEnviada) {
    const sit = await tools.consultarNFe(chaveEnviada).catch(() => null);
    // O cStat que vale é o de DENTRO do <protNFe>, e não o do envelope — é a
    // mesma distinção que as linhas 576-578 já fazem com a resposta do envio.
    // Ela importa: a consulta pode responder 100 no envelope ("consulta
    // atendida") com 217 no protocolo ("não consta na base").
    const prot = sit && (sit.match(/<protNFe[^>]*>([\s\S]*?)<\/protNFe>/) || [])[1];
    if (prot && tag(prot, 'cStat') === '100') { respStr = sit; }
  }
  if (!respStr) {
    if (reservaReceitaIds.length) liberarDispensacao(db, reservaReceitaIds);
    throw err;
  }
}
```

O que faz essa correção caber em oito linhas é que **nada abaixo do `catch`
precisa saber de onde veio o `respStr`**. As linhas 574-581 extraem `cStat`,
`xMotivo`, `nProt` e `chNFe` de dentro do `<protNFe>`, e a resposta da
consulta traz o mesmo grupo. O `montarNFeProc` (`nfe-proc.js:23`) também
recorta `<protNFe>` por expressão regular, sem olhar o envelope. Ou seja: a
gravação, o `avancarSerie`, os efeitos da natureza e o `nfeProc` final
funcionam sem alteração.

Duas coisas que o desenho **não** faz, de propósito:

- não faz retry de envio. Reenviar é o que cria a segunda nota; quem responde
  "já emiti?" é a consulta, não uma nova tentativa. O assert E4 guarda isso:
  conta os envios e exige que continuem sendo um.
- não trata `cStat` diferente de 100 na consulta como autorização. `217`
  ("NF-e não consta na base") é a resposta boa para "pode tentar de novo", e
  aí o erro original sobe como hoje.

Um detalhe que a implementação acrescentou ao esboço acima: a resposta da
consulta é normalizada para texto antes do recorte
(`typeof sit === 'string' ? sit : JSON.stringify(sit)`), como a resposta do
envio já era duas linhas abaixo. Sem isso, um retorno em objeto quebraria o
`.match` com "not a function" dentro de um `catch` — trocando um erro legível
por um erro obscuro justamente no caminho de exceção.

Os asserts que sustentam este item:

| Cenário | O que se prova |
|---|---|
| E1-E8 | timeout + nota autorizada: a emissão segue, grava com o protocolo da consulta, envelopa o `nfeProc` e **a numeração avança** |
| F1-F5 | timeout + `217` no protocolo: o erro do envio sobe, nada é gravado, a numeração não avança |
| F6 | timeout + consulta que também estoura: o erro do envio sobe, e não o da consulta |
| G1-G4 | rejeição 539: a SEFAZ respondeu, então **nenhuma consulta é feita** |

### 3.2 `indPres` vindo do payload

Era `indPres: '1'` fixo; virou `String(payload.indPres || '1')`. O balcão
continua presencial sem mudar nada, e o catálogo manda `'2'`. O `String()`
existe para que `2` numérico funcione igual (assert B2): o XML é texto, e o
campo não deveria depender de quem chama lembrar de aspas.

### 3.3 Frete

Três casas, não duas — foi o que a implementação mostrou:

- o `vNF` passou a somar o frete. Sem isso, o `vPag` do pedido (que já inclui
  o frete) bateria na guarda "soma dos pagamentos não bate com o total" e a
  nota nunca sairia. É o assert C4.
- `vFrete` no `ICMSTot`, só quando há frete.
- `modFrete` no `tagTransp`, vindo do payload em vez do `9` fixo.

**Uma coisa que eu tinha escrito errado aqui:** a versão anterior deste
documento dizia que `vFrete` "só aparece quando existe". Não é verdade — a
`node-sped-nfe` completa o `ICMSTot` e emite `<vFrete>0.00</vFrete>` sempre.
A condicional serve para não sobrescrever esse zero, não para omitir a tag. O
assert A4 pegou o engano: ele media a ausência da tag e reprovou.

Há também uma guarda nova: frete negativo é recusado antes de qualquer coisa
(assert C9). E a guarda antiga de soma continua valendo com a fórmula nova —
um pagamento que ignora o frete é recusado **antes** de falar com a SEFAZ, sem
queimar numeração (asserts C5 e C6).

### 3.4 Grupo `<entrega>`

Entrou ao lado da injeção de `<med>`/`<rastro>`, pelo mesmo motivo e no mesmo
lugar — entre a montagem e a assinatura:

```js
if (payload.entrega) {
  const { injetarEntrega } = require('./nfce-payload');
  xmlRaw = injetarEntrega(xmlRaw, payload.entrega);
}
```

O `require` é local, e não no topo, para acompanhar o estilo do bloco vizinho
do medicamento. Os asserts D1 a D5 medem a posição no XML de verdade: depois
de `<dest>`, antes do primeiro `<det>`.

### 3.5 Troco — NÃO implementado, e é decisão sua

O checkout do catálogo **não guarda o troco como dado**: ele grava
`"Troco para: R$ X"` dentro de `pedidos.observacao`
(`loja-routes.js:1548`). Para `vTroco` sair no XML seria preciso ou fazer o
montador ler texto de observação — frágil, e é parser de texto livre — ou
gravar o valor em coluna.

O desenho atual **não emite `vTroco`**: manda `vPag` igual ao `vNF`, que é o
que o PDV já faz e é fiscalmente correto. Fica anotado como decisão a tomar,
não como pendência técnica.

## 3.6 Como a suíte do motor roda sem SEFAZ e sem certificado

`scripts/test-nfce-motor-catalogo.js` chama o `emitirNFCe` **de verdade**, e
o `Make` que monta o XML também é o real — é ele que está sob medição. O que
é falso são três métodos, trocados no protótipo do `Tools`: `xmlSign`,
`sefazEnviaLote` e `consultarNFe`.

Dois obstáculos apareceram no caminho, e a forma de contornar cada um vale
para qualquer suíte futura que precise do emissor:

- **A `node-sped-nfe` é ESM nativo** (`"type": "module"`), então patchar o
  `require.cache` não funciona: o `import()` monta um namespace próprio e as
  bindings são imutáveis. O que funciona é mexer no **protótipo da classe** —
  `lib.Tools.prototype.xmlSign = ...`. O namespace congela o nome, não o
  objeto para o qual ele aponta.
- **O certificado é carregado antes de tudo**, dentro do `getTools`, que não é
  exportado. A saída é gravar na cópia do banco um pfx de mentira com a senha
  em **base64 puro** — o formato legado, que `cert-senha.decifrarSenha` lê sem
  a `LICITEAGORA_CHAVE_CERT` (que não existe fora do systemd). O pfx nunca
  chega a ser aberto, porque quem o abriria era justamente o `xmlSign`
  substituído.

A suíte roda sob `scripts/guarda-dados.js` e não escreve em `data/`.

## 3.7 A suíte reprovaria se o defeito existisse?

Teste que passa não prova nada por si: ele pode estar medindo ao lado. Os seis
defeitos abaixo foram introduzidos um a um no `nfce-routes.js`, com resgate
por cópia e `trap`, e a suíte foi rodada contra cada um. **Os seis foram
pegos.**

| Defeito introduzido | O que a suíte fez |
|---|---|
| `indPres` volta a ser fixo | 55/59 — caem B1, B2, H2, I4 |
| o frete some do `vNF` | morre em "Soma dos pagamentos (62,00) não bate com o total (50,00)" |
| `vFrete` não vai ao `ICMSTot` | 56/59 |
| o grupo `<entrega>` deixa de ser injetado | 53/59 |
| a reconciliação aceita o `cStat` do **envelope** | 56/59 |
| a reconciliação some (volta o defeito original) | morre com o timeout do envio propagado |

Ao fim, o arquivo foi conferido por SHA-256 contra a cópia de resgate, a
sintaxe revalidada e a suíte rodada de novo: 59/59, e as três ocorrências de
`ordemPt` intactas.

## 4. Dois achados que não são do motor, mas atrapalham o catálogo

- **`codigoMunicipioEntrega` nunca é preenchido pelo checkout.** A coluna
  existe (`db-schema.js:1272`) e só o cadastro manual de pedido a grava
  (`pedidos-routes.js:87`). O grupo `<entrega>` exige `cMun`, e não há tabela
  de municípios no projeto.

  `nfce-payload.js` resolve o caso que cobre toda entrega própria — mesma
  cidade do emitente, comparada sem acento e sem caixa — e **recusa** o resto
  com mensagem legível, em vez de chutar o código do emitente e tomar
  rejeição 273 depois de a numeração ter sido consumida.

- **Entrega em outra UF não pode ser NFC-e.** O modelo 65 é documento de
  operação interna. O montador recusa e diz para usar NF-e 55.

## 5. O que foi rodado, e o que continua verde

Não foi rodado o verify inteiro — outras frentes estavam trabalhando e a unit
já havia falhado duas vezes hoje por motivos alheios. Rodaram as suítes que
citam o emissor, à mão, todas sob `scripts/guarda-dados.js`:

| Suíte | Resultado |
|---|---|
| `test-nfce-motor-catalogo` (nova) | **59/59** |
| `test-nfce-payload` | **42/42** |
| `test-nfce-lib-mod65` | **38/38** |
| `test-pdv-natureza` | **23/23** — o PDV não mudou |
| `test-catalogo-fiscal` | **35/35** — inclui o K2, "o catálogo NÃO emite NFC-e nesta fase" |
| `test-farmacia-f2` / `f3` / `f6` | **32 / 38 / 34** — a farmácia é o consumidor mais delicado do emissor |
| `test-floricultura` | **29/29** |
| `test-nf-config-empresa` | **quebrada, por motivo antigo e alheio** |

A última estoura na linha 34, num `INSERT INTO fornecedores` — tabela que
deixou de existir em 20/08/2026, quando o cadastro de fornecedor virou
`pessoas` com categoria. A suíte está na versão do git, sem modificação, e
**não faz parte do verify**. Não foi consertada aqui: é trabalho de outra
frente e não tem relação com a Fase 2A.

### Estado da árvore

Continua em movimento, e isso não mudou desde o diagnóstico. Durante este
trabalho havia **três outras sessões** com `cwd` no projeto, e o HEAD avançou
de `8b68689` para `f3385db` em três commits de outras frentes. Um deles,
`c323e54` (13:44), tocou o `nfce-routes.js`: acrescentou o
`require('./ordem-pt')` e trocou dois `ORDER BY` na busca de produtos do PDV.
Essa alteração **está preservada integralmente** — não entrou no diff da Fase
2A, e as três ocorrências de `ordemPt` seguem no arquivo.

Por causa dessa concorrência, cada escrita no `nfce-routes.js` foi precedida
de conferência de SHA-256 contra a versão lida. Nenhuma divergência apareceu.

Uma armadilha de verificação que apareceu no caminho, e que vale para quem
for conferir isto de novo: o `find` desta máquina é o **`bfs`**, e ele
**recusa** `-newermt` com prazo relativo (`-newermt '-3 hours'`) em vez de
interpretá-lo. O erro vai para o stderr e a lista sai vazia, o que se lê como
"nada mudou". Use data absoluta: `-newermt '2026-09-28 07:20'`.

## 6. O que NÃO foi feito, e fica para a Fase 2B

- **O Catálogo Online não chama o emissor.** É a ligação em si, e ela mexe no
  `loja-routes.js`.
- **`vTroco`** — ver 3.5: falta decidir se o troco vira dado estruturado.
- **`codigoMunicipioEntrega` no checkout** — hoje o montador recusa entrega
  fora da cidade do emitente. Gravar o código no pedido resolveria o caso
  geral, mas é alteração no `loja-routes.js` e exige tabela de municípios.
- **Nenhum restart.** As alterações do `nfce-routes.js` **não estão em
  vigor**: o `consulta-licitacoes.service` roda a versão que leu às 13:20.

Uma armadilha de verificação que apareceu no caminho, e que vale para quem
for conferir isto de novo: o `find` desta máquina é o **`bfs`**, e ele
**recusa** `-newermt` com prazo relativo (`-newermt '-3 hours'`) em vez de
interpretá-lo. O erro vai para o stderr e a lista sai vazia, o que se lê como
"nada mudou". Use data absoluta: `-newermt '2026-09-28 07:20'`.
