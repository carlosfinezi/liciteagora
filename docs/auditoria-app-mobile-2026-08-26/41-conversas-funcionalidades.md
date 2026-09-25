# 41 — Conversas: dono, aviso, horário de atendimento e base por PDF

**Data:** 2026-09-17
**Base:** comparação com o painel do Loctos (`/dashboard/bot`), feita no mesmo dia ·
[40 — escala tipográfica](40-fase3.5-escala-consumida.md)

**Resultado:** as quatro implementadas, verificadas e **em vigor**. O
`consulta-licitacoes.service` foi reiniciado a pedido às **12:22 BRT** (PID
2099840 → 2317860, `NRestarts=0`, health 302, sem stack de boot no journal).

Esse mesmo restart pôs em vigor o faturamento do contrato por nota avulsa, que
estava pendente desde a manhã, incluindo a migration da coluna
`nfse.contratoId`.

---

## 1. De onde saíram estas quatro

Da comparação entre a nossa tela de Conversas e o painel do Loctos. Onze
diferenças foram levantadas; quatro foram escolhidas por serem as que mudam o
trabalho de quem atende, e não a aparência da tela.

Ficaram de fora, registradas para depois: reengajamento automático de quem
sumiu, tempo configurável até a IA reassumir a conversa, multi-número, Raio-X
arquivado em PDF e edição do prompt por conversa em linguagem natural.

## 2. Dono da conversa

Com 953 conversas abertas, "de quem é esta?" não tinha resposta.

A coluna `donoId` **já existia** em `conv_conversas` desde a criação da tabela e
nunca havia sido usada por tela nenhuma — o `PUT /api/conversas/:id` inclusive
já a gravava, com registro em `conv_eventos`. O que faltava era expor.

| Onde | O quê |
|---|---|
| `GET /api/conversas` | `LEFT JOIN users` para devolver `donoNome`; recortes `minhas` e `semDono`; contagens dos dois |
| `GET /api/conversas/atendentes` | **nova** — id e nome de quem está ativo. Rota própria porque `/api/usuarios` exige admin, e com `?vendedor=1` deixaria de fora justamente o atendente que não vende |
| `PUT /api/conversas/:id` | passa a **recusar** dono inexistente ou inativo |
| tela | filtros "Minhas" e "Sem dono", seletor de dono e botão "assumir" no cabeçalho, nome do dono na lista |

**Duas decisões que valem estar escritas.** Dono organiza fila e **não** vira
permissão: a lista geral continua trazendo tudo, e há um teste que reprova se
alguém transformar atribuição em restrição de acesso. E `minhas` **sem usuário
identificado devolve vazio**, nunca a fila inteira: cair para "todas" faria o
atendente responder conversa que outro já assumiu.

## 3. Aviso de mensagem nova

A inbox já buscava a lista de 30 em 30 segundos e não dizia nada quando algo
chegava. O aviso pega carona nesse ciclo, sem requisição nova: compara o total
de não lidas entre duas voltas e avisa quando sobe.

Som nasce **ligado**, pop-up nasce **desligado**. A diferença é de
consentimento: som é local e some com um clique; notificação precisa de
permissão do navegador, pedida no clique e nunca no carregamento da página.

O defeito que a suíte guarda é a **primeira carga**: abrir a tela com 153 não
lidas e ouvir um alarme sobre mensagem de ontem é o jeito mais rápido de a
pessoa desligar o aviso para sempre.

## 4. Horário de atendimento

Até aqui a IA respondia às três da manhã de domingo com o mesmo tom de terça às
dez, prometendo retorno que ninguém daria.

Módulo novo `atendimento-horario.js`, com a lógica pura e testável, mais uma
porta no `whatsapp-webhook.js`.

**A ordem da porta é a regra inteira.** O horário é consultado **depois** do
escopo de campanha. Se viesse antes, o aviso de "estamos fechados" alcançaria
justamente quem a empresa decidiu não abordar por resposta automática — o escopo
deixaria de valer de madrugada. Há um teste que lê o fonte e reprova a inversão.

Outras decisões:

- **O fuso vem escrito (`America/Sao_Paulo`), não do processo.** O banco grava
  em UTC e a unit pode subir com `TZ` diferente; `new Date().getHours()`
  funcionaria hoje e fecharia a empresa três horas mais cedo no dia em que
  alguém mexesse na unit, sem erro em lugar nenhum. Um teste compara o mesmo
  instante com três `TZ` de processo.
- **Na dúvida, atende.** Configuração ausente, JSON quebrado ou agenda com os
  sete dias fechados **não** calam a IA. Uma porta que emudece o atendimento
  sozinha, por gravação incompleta, seria pior que o problema original.
- **Faixa que atravessa a meia-noite** (22h às 6h) é tratada como plantão: sem
  isso, o turno fecharia à meia-noite em ponto.
- **O aviso não se repete**: uma vez a cada 8 horas por conversa.
- **Sem mensagem configurada, a IA apenas cala.** Mandar texto genérico que
  ninguém escreveu é pior que o silêncio.

## 5. Base da IA por PDF

`pdftotext` já estava na máquina (é o mesmo usado na leitura de edital) e o
`multer` já rodava no `bll-routes.js`.

O ponto que exigiu decisão: `ia_base.conteudo` guarda 4.000 caracteres, e um PDF
passa disso na primeira página. Gravar truncado seria o pior resultado possível,
porque **parece** que funcionou e a IA passa a responder com meia informação. O
texto é fatiado em vários itens, o corte procura quebra de parágrafo, e o título
numera as partes. Acima de 20 trechos, a resposta **diz** quantos ficaram de
fora em vez de engolir.

PDF digitalizado (sem camada de texto) é recusado com o motivo dito, e arquivo
que não é PDF é recusado pelos bytes, não pela extensão.

## 6. Verificação

Quatro suítes novas, todas registradas no verify:

| Etapa | Suíte | Resultado |
|---|---|---|
| 110 | `test-conversas-dono` | 14 ok |
| 111 | `test-conversas-aviso` | 13 ok |
| 112 | `test-atendimento-horario` | 25 ok |
| 113 | `test-ia-base-pdf` | 7 ok |

Duas delas foram **sabotadas de propósito** para conferir que reprovam:

- removida a guarda do `minhas` sem usuário → `C3` reprovou com "veio 3
  conversas rotuladas como minhas sem ninguém logado";
- removida a validação de atendente inativo → `B2`, `C1` e `C5` reprovaram;
- removida a guarda da primeira carga do aviso → 7 dos 13 testes reprovaram.

A suíte do PDF gera um PDF de verdade, em bytes, e roda o `pdftotext` de
verdade. Ela acusou um defeito real logo na primeira rodada — só que do próprio
teste: 120 linhas numa página A4 só, e o extrator descarta o que passa do
rodapé. O PDF de teste passou a paginar, que é como documento real se comporta.

## 7. A convivência com o servidor antigo, que durou algumas horas

Tudo já está em vigor desde o restart das 12:22. O que segue ficou registrado
porque a janela entre salvar a tela e reiniciar o servidor volta a existir a
cada mudança deste tipo, e o desenho que a atravessou sem quebrar nada é
reaproveitável.

A tela foi escrita para conviver com o servidor antigo, e isso foi conferido no
navegador, em produção, antes do restart:

| Recurso | Com o servidor antigo |
|---|---|
| Filtros "Minhas" e "Sem dono" | **não aparecem** — um filtro que o servidor ignora devolveria a fila inteira com o rótulo errado |
| Seletor de dono e "assumir" | **não aparecem** — a lista de atendentes vem vazia |
| Formulário de horário | **bloco inteiro escondido** — metade do formulário visível faria a pessoa configurar e salvar no vazio |
| Botão "Enviar PDF" | aparece, e o erro diz "o servidor ainda não conhece este envio — ele passa a valer no próximo restart" |

Nada quebrou, e nada prometeu o que ainda não existia.

## 8. Conferido depois do restart, em produção

| O quê | Resultado |
|---|---|
| Filtros de dono | aparecem: "Minhas" e "Sem dono 953" |
| `GET /api/conversas/atendentes` | devolve `admin` e `Guilherme`, com `eu: 1` |
| Formulário de horário | os 7 dias desenhados, padrão comercial, **desligado** |
| `POST /api/ia/base/pdf` | viva: recusa envio sem arquivo com JSON e 400 |
| Journal do serviço | sem stack de boot |

O horário nasceu **disponível e desligado**: até alguém marcar a caixa e
salvar, a IA atende a qualquer hora, exatamente como antes. A outra mudança de
comportamento que passou a valer sozinha é a recusa de atribuir conversa a
usuário inativo.
