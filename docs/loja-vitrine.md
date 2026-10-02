# A loja como página inicial e a vitrine

Era a seção "A loja como página inicial, e a nova posição do static do login"
do CLAUDE.md até 02/10/2026, e saiu de lá com o texto preservado. As duas regras
que valem (a posição do static do login e o domínio próprio que não existe)
ficaram no CLAUDE.md.

### A loja como página inicial, e a nova posição do static do login

Desde 27/09/2026, com `loja_config.paginaInicial = 1` e a loja publicada
(Catálogo Online › Informações da empresa › "Abrir o catálogo em…"), quem abre
o endereço do tenant sem sessão cai na loja: `/` vai para `/loja/`, caminho
desconhecido recebe `public/loja/404.html` com status 404, e favicon, ícones e
manifest do ERP não são servidos (sai o ícone da loja, ou 404). O dono entra
por `/login`; com sessão, tudo volta a ser o ERP. Tenant suspenso mostra a loja
fechada (`responderLojaFechada`), sem slug nem cobrança.

**Dentro de `/loja/` isso vale com a opção desligada também** (desde
29/09/2026): basta a loja publicada para um caminho inexistente em `/loja/…`
receber o 404 da loja, e não o login, e para o tenant suspenso mostrar a loja
fechada ali. É o caso do `cantinhoverde`, que divulga o `/loja/` e tem a raiz
no login, como os outros tenants. Mudou também o `1bit` e o
`produtosbomgosto`, as outras lojas publicadas: antes, lá, `/loja/inexistente`
levava ao login.

Para isso, **o static de `public/auth` deixou de ser montado antes do
middleware de tenant**. Agora é `base-middleware.servirTelaDeLogin`, chamado
pelo `auth-pipeline` depois da sessão e do `vitrineAntesDoLogin`. Duas
consequências: host desconhecido recebe o 404 do tenant em vez da tela de
login, e o painel admin continua servido porque o host `admin` passa pelo
middleware de tenant. O `vitrineNaBarreira` fica logo antes do
`requireAuth`. A configuração é lida com cache de 15 s por tenant, e quem grava
chama `esquecerVitrine`.

O tema da vitrine tem acabamento desde 28/09/2026 (fundo aquarela, sombras,
topo translúcido, sigla, slogan e o destaque do topo), e o `tema.js` grava as
escolhas como `data-fundo-efeito`, `data-sombra` e `data-topo` no `<html>`:
é neles que a folha do `public/loja/index.html` se apoia. Desde 29/09 o topo
tem a opção `degrade`, que é a regra `.topbar` do protótipo do Cantinho Verde
(degradê 96/78/0% na cor de fundo da loja e `blur(12px)`, sem máscara). A loja
do tenant `cantinhoverde` (até 29/09, `floricultura`) usa tudo isso, e seus
produtos de exemplo têm SKU `EXEMPLO-`.

**Ícones da loja** (29/09/2026): a vitrine com ícone enviado (`faviconPath`)
declara aba em 16 e 32 px, atalho do celular (180) e manifest próprio, pelas
rotas públicas `/loja/icones/<tamanho>.png` e `/loja/manifest.webmanifest`.
As versões por tamanho são arquivos ao lado do ícone, com sufixo (`…-16.png`,
`-32`, `-180`, `-192`), e faltando uma vai o ícone enviado. Quem troca o ícone
pela tela perde as versões: elas eram do arquivo antigo. Ícone pequeno de
desenho detalhado precisa ser redesenhado a 16 px, como o do Cantinho Verde.

O domínio próprio (`floriculturadoamigo.com.br`) **ainda não existe**: o
`resolveFromHost` só reconhece `<slug>.liciteagora.app`.
