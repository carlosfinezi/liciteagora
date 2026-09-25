# 43 — Pop-up de mensagem nova, inclusive com o ERP fechado

**Data:** 2026-09-17
**Base:** [42 — inbox redesenhada](42-conversas-inbox-redesenho.md) ·
[41 — funcionalidades](41-conversas-funcionalidades.md)

**Resultado:** implementado e em vigor (`consulta-licitacoes.service` reiniciado
às **17:42** e às **17:45**). **Nasce desligado**: ligar é decisão de quem
configura, em Comunicação → IA e Campanhas → Canal.

---

## 1. O que existia e o que faltava

O aviso de mensagem nova do relatório 41 só funcionava **com a tela de Conversas
aberta** — o polling era dela. Quem estivesse num pedido, no estoque ou no
financeiro não sabia de nada. E a preferência ficava no navegador de cada um,
sem nenhuma decisão da empresa por trás.

Agora são três camadas, e cada uma resolve um caso:

| Situação | Quem avisa |
|---|---|
| Tela de Conversas aberta | o aviso da própria tela (relatório 41), com som |
| ERP aberto, em qualquer outra tela | o pop-up do shell (`aviso-mensagem.js`) |
| ERP fechado, navegador rodando | a notificação do sistema, pelo service worker |

## 2. As duas decisões que moldaram o desenho

**Sem biblioteca.** `web-push` não está instalado e `npm install` é vedado nesta
árvore. O VAPID (RFC 8292) é um JWT ES256, que o `crypto` do Node assina
nativamente. O que a biblioteca faria a mais — criptografar o conteúdo, RFC
8291 — não é preciso por causa da segunda decisão.

**O push vai vazio.** Ele carrega um sinal, não a mensagem. O service worker
acorda e busca nome e trecho em `/api/push/pendentes`, com a sessão da própria
pessoa.

Isso não é contorno: o push passa pelo servidor da Google ou da Mozilla, e o
conteúdo é a conversa de um cliente com a empresa. Mandar *"João Silva: preciso
da betoneira amanhã"* por um intermediário seria entregar a terceiros justamente
o que o sistema existe para guardar. Vazio, o intermediário só sabe que **algo**
chegou.

O custo assumido: com a aba fechada e sem rede no instante do push, o service
worker não busca o conteúdo e mostra um aviso genérico. É o comportamento certo
— melhor aviso sem detalhe do que detalhe vazando.

## 3. Dois interruptores, e a diferença entre eles

| | Onde mora | O que decide |
|---|---|---|
| **Chave da empresa** (`whatsapp_popup_ativo`) | `config` do tenant | se o sistema avisa alguém. Desligar cala todos de uma vez |
| **Inscrição do aparelho** | `push_inscricoes` | qual aparelho recebe. Quem atende no computador e no celular liga nos dois |

Quem está numa reunião com a tela projetada silencia só o próprio aparelho, sem
tirar o aviso da equipe. A permissão do navegador é pedida **no clique**, nunca
no carregamento: pedido automático é o que faz o navegador — e a pessoa — negar
por reflexo.

## 4. O defeito que a conferência pegou, e que era de desenho

A primeira versão guardava o par VAPID em `data/vapid.json`, com permissão 0600.
**Durou uma tarde.** O arquivo nasceu `root:root` — quem chamou primeiro foi um
processo root — e o servidor web, que roda como `carlosfinezi`, não conseguia
**ler a própria chave**. A rota devolvia erro, o recurso ficava morto e não havia
uma linha no log.

A causa não era permissão errada: era o lugar. Dois processos com usuários
diferentes escrevendo o mesmo arquivo. A chave passou para o `config` do tenant,
que é por onde toda configuração já passa, e onde essa disputa não existe. Uma
chave por tenant também é mais correta: a inscrição do navegador é amarrada à
**origem**, e cada tenant tem o seu subdomínio.

**Fica um órfão:** `data/vapid.json`, com dono root. Nada o lê mais. Não foi
apagado porque `rm` é vedado nesta árvore — pode ser removido com segurança.

## 5. Verificação

`scripts/test-push-mensagem.js`, etapa **115**, **22 ok**. O que ela guarda:

- **a assinatura do JWT é verificada com a chave pública**, que é o que o Google
  faz do outro lado. Sabotei a conversão DER→JOSE e o teste acusou na hora
  ("assinatura com 71 bytes — JOSE exige 64");
- a chave pública sai em raw de 65 bytes começando em `0x04` — no DER do SPKI, o
  navegador recusa a inscrição e a mensagem de erro não ajuda ninguém;
- **o push sai sem corpo**: um servidor de push de mentira recebe o envio e o
  teste conta os bytes;
- 410 remove a inscrição, 500 **não** remove;
- com a chave da empresa desligada, nada sai;
- `pendentes` traz só mensagem recebida (não a resposta da própria IA), só dos
  últimos 10 minutos, com o trecho cortado **no servidor**;
- o webhook avisa apenas em mensagem nova e recebida, e **sem `await`** — um
  servidor de push lento não pode atrasar o 200 para a Evolution.

A suíte do PWA (`test-pwa`, 26 ok) teve o teste `C7` trocado: ele proibia `push`
e `postMessage` dizendo "ficaram para outra fase". Esta é a fase. No lugar da
proibição entraram `C8` e `C9`, mais específicos que ela: o service worker **não
pode ler o payload do push** (senão o conteúdo volta a trafegar por terceiros) e
a busca do conteúdo precisa ir com a sessão, sem cache e sem tocar em `caches`.

## 6. Arquivos

| Arquivo | O quê |
|---|---|
| `push-web.js` | **novo** — VAPID, JWT ES256, DER→JOSE, envio do sinal |
| `push-routes.js` | **novo** — chave, inscrever, desinscrever, pendentes, `avisarInscritos` |
| `public/js/aviso-mensagem.js` | **novo** — o pop-up dentro do ERP, montado no shell |
| `public/auth/sw.js` | eventos `push` e `notificationclick` |
| `public/app.html` | carrega o aviso no shell |
| `public/comunicacao/ia.html` | a configuração e o botão por aparelho |
| `db-schema.js` | tabela `push_inscricoes` |
| `whatsapp-adapter.js` | lê e grava `whatsapp_popup_ativo` |
| `whatsapp-webhook.js` | dispara o aviso na mensagem do lead |
| `route-registry.js` | registra as rotas |
| `scripts/test-push-mensagem.js` | **nova** — etapa 115 |
| `scripts/test-pwa.js` | `C7` trocado por `C8` e `C9` |

## 7. Ressalvas para quem for ligar

- **iPhone:** o Safari só entrega push se o ERP estiver **instalado na tela de
  início**. No navegador comum, o botão avisa que aquele aparelho não recebe.
- **O aviso não toca som fora da tela de Conversas.** Som é decisão da inbox, que
  tem interruptor próprio; dois avisos sonoros para o mesmo evento levam a pessoa
  a desligar os dois.
- **O clique na notificação leva à lista de Conversas**, não à conversa exata: a
  inbox ainda não lê um parâmetro de conversa na URL. Prometer no clique o que
  não se entrega seria pior que levar até a lista.
