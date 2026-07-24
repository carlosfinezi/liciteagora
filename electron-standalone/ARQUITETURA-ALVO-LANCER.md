# Arquitetura-alvo: Comprasnet via resolução programática de hCaptcha (modelo LANCER)

Data: 2026-07-07. Base: captura de tráfego do **LANCER.exe v2.5.7** (`requisi_es_lancer.har`,
1.920 requisições) — um robô de licitações concorrente que **funciona de forma robusta**.

## Por que mudar de estratégia

O caminho atual do liciteagora ("**evitar** o hCaptcha" com flags do Chromium + device-trust do
`acesso.gov.br` num perfil persistente) é **frágil**: qualquer coisa que apague o perfil (update,
troca de pasta, partição) derruba o trust → hCaptcha volta → login trava. Foi a causa de toda a
novela de 2026-07-07 (ver [ANALISE-HCAPTCHA-DIFF.md](./ANALISE-HCAPTCHA-DIFF.md)).

O LANCER **não usa device-trust nenhum**. Ele **resolve o hCaptcha** e injeta o token. Modelo
robusto, sem perfil sagrado.

## Como o LANCER resolve o hCaptcha (confirmado no HAR)

- Token do hCaptcha = **`P1_<JWT>`** (passcode padrão do hCaptcha). Ex.: nas participações vai como
  `GET /comprasnet-fase-externa/v1/compras/participacoes?captcha=P1_eyJ0eXAi...`.
- O widget do hCaptcha computa um **proof-of-work (`hsw` = hash-based)** **dentro do navegador**:
  - `POST api.hcaptcha.com/checksiteconfig?host=<host>&sitekey=<sitekey>` → config + `req` (JWT).
  - `GET .../c/{hash}/hsw.js` → o JS que computa o PoW (rodado no Chromium).
  - `POST api.hcaptcha.com/getcaptcha/{sitekey}` com `{"type":"hsw","req":"<JWT>"}`. O `req` traz
    `"n":"hsw","c":1000` (dificuldade do PoW), `l` (path do hsw.js), `i` (integridade sha256).
  - No fim, `hcaptcha.getResponse()` devolve o `P1_...`.
- **Não se reimplementa o PoW.** Roda-se o widget do hCaptcha e extrai-se o token — igual o
  `captcha-relay` do BLL/BNC já faz pro reCAPTCHA v3 (`grecaptcha.execute`).
- LANCER = **CefSharp (Chromium embutido)**. Nós = **Electron (Chromium)** → mesma capacidade.

### Dois sitekeys
| Onde | sitekey | Uso |
|---|---|---|
| Gov.br SSO (login) | `93b08d40-d46c-400a-ba07-6f91cda815b9` | passar o hCaptcha da tela de login |
| Comprasnet Mobile (API) | `b8bbded1-9d04-4ace-9952-b67cde081a7b` | `?captcha=P1_...` nas participações/lances |

## Fluxo completo do LANCER (resumo)

1. **Boot:** polling na API do usuário (`/api/sniper/fila-lances|fila-queries`, `/api/tarefas/pendentes`)
   a cada ~5s; check de atualização.
2. **Login SSO Gov.br** (OAuth2): `authorize` → resolve hCaptcha (sitekey Gov.br) → `POST /login`
   → `code` → `landing_sso.asp` → `loginPortalFornecedor.asp` → `intro.htm`.
3. **Token Bearer:** `GET /comprasnet-usuario/v2/sessao/fornecedor/usuario/token/{compras-id}` →
   JWT RS512 usado na API do SERPRO.
4. **Loop:** resolve hCaptcha (~7s) → `GET participacoes?captcha=P1_` (~11s) → navega pregões
   (`pregao0/1.asp`, `Lance.asp`) → WebSocket p/ eventos → **re-auth SSO a cada ~2min** (cookie
   Gov.br ainda válido → 302 sem senha, **sem** re-resolver captcha no re-auth).

## Plano de implementação

- **Fase 1 — Solver hCaptcha** (`portals/comprasnet/hcaptcha-relay.js`): página/webview oculta
  carrega o widget do hCaptcha p/ um sitekey, deixa o `hsw.js` resolver, extrai `P1_`. Reaproveita
  a fiação do captcha-relay. **← EM ANDAMENTO, em harness isolado (`_test-hcaptcha/`).**
- **Fase 2 — Login sem device-trust:** resolve+injeta o token do sitekey Gov.br no login → passa
  sozinho, sem hCaptcha na tela, sem depender de perfil/trust.
- **Fase 3 — Token pra API:** resolve o sitekey cnetmobile → `?captcha=P1_` nas participações/lances.
- **Fase 4 — Aposentar o frágil:** remover dependência de device-trust/persistência de perfil.

## O que o liciteagora JÁ tem (escopo menor do que parece)
- SSO OAuth2, Bearer JWT, API `comprasnet-fase-externa`, `token-manager.js`.
- Sniper/fila: `sniper-lance-routes.js`, `lance-processor.js`, monitoramento de participações.
- **`captcha-relay`** (BLL/BNC) — a mesma arquitetura do solver, hoje pra reCAPTCHA.

## Riscos
- hCaptcha pode **escalar p/ desafio visual** se não confiar no ambiente. As flags anti-automação
  (`disable-blink-features=AutomationControlled`) ajudam a manter no modo `hsw`. O LANCER consegue
  `hsw` puro — precisa **validar** que nós também.
- hCaptcha atualiza o `hsw.js` periodicamente → **manutenção eventual**.
- **Domínio do sitekey:** o hCaptcha amarra o sitekey a domínios permitidos; o widget precisa rodar
  no contexto/origem certo (`cnetmobile.estaleiro.serpro.gov.br`). O teste da Fase 1 valida isso.

## Fase 1 — resultado (2026-07-07, harness `_test-hcaptcha/`)

Harness isolado: Electron 41 (mesmo Chromium 146 da produção) sob `xvfb`, flags anti-automação,
UA limpo (`Chrome/146.0.7680.80`, sem Electron), carregando a origem `cnetmobile` e injetando
`hcaptcha.render({size:'invisible'}) + execute()`.

**Resultado:** o **mecanismo funciona** — `api.js` carrega (sem bloqueio de CSP), `render`+`execute`
rodam, o sitekey `b8bbded1` é aceito no domínio cnetmobile. **MAS** o hCaptcha **escalou pra
desafio visual** (`open-callback` disparou) em vez de devolver token `hsw` passivo.

**Causa (não é bug de código):** este servidor é **IP de datacenter + headless (WebGL por
software/swiftshader)**. O hCaptcha pontua isso como não-confiável e escala. O LANCER passa no
`hsw` porque roda no **IP residencial/empresarial real do cliente + GPU/display real**. Ver
memória `feedback_no_datacenter_ip`.

**Conclusão da Fase 1:** a abordagem (rodar o widget e extrair o `P1_`) está **mecanicamente
validada**. A variável que decide passivo-vs-visual é o **ambiente de confiança (IP real +
display/GPU real)** — que só existe na **máquina do cliente**. Portanto a validação final do
token passivo tem de ser feita **na máquina do cliente** (como o LANCER), não neste servidor.

**Próximo passo:** empacotar o harness como um mini-teste que o cliente roda **na máquina dele**
(IP real) e reporta se sai `P1_` no `hsw` passivo. Se sair (esperado, dado que o LANCER consegue),
seguimos pras Fases 2/3. Se escalar até lá, aí sim é sinal de que precisa de mais fingerprint.

### ✅ VALIDADO na máquina do cliente (2026-07-07)

Mini-teste (`hCaptcha-Test-LiciteAgora.exe`, portable, build isolada de `_test-hcaptcha/`) rodado
na máquina do cliente (IP/GPU reais): **PASSOU NO HSW PASSIVO, sem desafio visual, com token
`P1_...` válido.** Confirma que nosso Electron resolve o hCaptcha do Comprasnet igual o LANCER —
sem humano, sem device-trust. **A abordagem está provada.** Seguir pras Fases 2 (login) e 3 (API),
sempre validando em build-de-teste na máquina do cliente ANTES de promover pra produção.

Nota operacional: token hCaptcha expira (~2min) → o solver roda **on-demand** antes de cada
login/consulta (o LANCER resolve a cada ~7s). Sitekeys: Gov.br `93b08d40…` (login), cnetmobile
`b8bbded1…` (API). O widget precisa rodar na **origem certa** (cnetmobile / a página de login do
Gov.br) — como no mini-teste.

## Regras deste trabalho
- **Nunca na produção do cliente.** Harness isolado aqui; validar antes de qualquer build que chegue no cliente.
- Manter o guard (`verify-comprasnet-invariants.js`) e as flags anti-automação.
