# MONITORAMENTO - Instruções para Reconstrução em Electron

## 1. VISÃO GERAL DO SISTEMA

O MONITORAMENTO é um sistema desktop (originalmente WinForms + CefSharp) que monitora portais de licitações públicas (Banco do Brasil, ComprasNet, etc.) automaticamente. Ele navega nos sites usando um browser embutido, detecta licitações, envia lances e mantém sessão ativa.

A nova versão será construída em Electron (Node.js + Chromium).

---

## 2. ARQUITETURA ORIGINAL (WinForms)

### 2.1 Telas (Forms)

| Form | Função |
|------|--------|
| `frmPrincipal` | Tela principal. Contém o controle `crtCN` com os browsers. Gerencia empresa, usuário logado, e controla os timers. Tem `_suporte_manual` e `_auth`. |
| `frmLogin` | Login por CPF/CNPJ + senha. Tem checkbox "Lembrar credenciais". Valida contra banco SQL Server remoto e verifica versão do sistema (auto-update). |
| `frmLoginManual` | Login manual quando o automático falha. |
| `frmEmpresa` | Cadastro/seleção de empresa. |
| `frmConfiguracao` | Configurações do sistema. |
| `frmPalavraChave` | Gerenciamento de palavras-chave para filtrar licitações. |
| `frmCompra` | Tela de detalhes da compra/licitação. Contém 4 browsers próprios para múltiplos portais simultâneos. Tem `_auth` próprio e `CookieContainer` compartilhado. |

### 2.2 Controles

| Controle | Função |
|----------|--------|
| `crtCN` | UserControl principal. Contém `chromeBrowser` (principal) e `chromeBrowserAux` (auxiliar). Gerencia toda a lógica de navegação, monitoramento e automação. Possui 8 timers, interceptação de auth, e lógica de manutenção de sessão. |

### 2.3 Classes de Dados

| Classe | Função |
|--------|--------|
| `Pagina` | Dados de uma página de resultados. |
| `Root2B` | Root de retorno da API 2B (portal de licitações). |
| `clsDados2B` | Dados do portal 2B. |
| `clsMsgBB2` | Mensagens do Banco do Brasil. |
| `SqC` | Dados de sequência de compra. |
| `Choice`, `Message`, `Usage`, `CompletionTokensDetails`, `PromptTokensDetails` | Classes para integração com API de IA (OpenAI/ChatGPT) - usadas para análise de licitações. |
| `WebClientWithTimeout` | WebClient customizado com timeout configurável e CookieContainer. |

### 2.4 Portais Monitorados

O sistema monitora pelo menos 3 portais:

- **BB** (Banco do Brasil) - `monitoramento_bb`
- **CP** (ComprasNet/Compras Públicas) - `monitoramento_cp`
- **CN** (ComprasNet novo) - `monitoramento_cn`

Cada portal tem tratamento específico de HTML, navegação e extração de dados.

### 2.5 Integrações

- **SQL Server remoto** - banco principal (login, empresas, configurações)
- **SQL Server CE local** (.sdf) - cache de credenciais, dados offline
- **API de IA** (OpenAI) - análise de licitações com ChatGPT
- **API 2B** - portal de licitações
- **HtmlAgilityPack** - parsing de HTML das páginas dos portais

---

## 3. MECANISMOS DE SESSÃO ATIVA (Detalhe Completo)

O sistema usa 8 timers + 1 interceptor HTTP para manter sessão. A seguir, todos detalhados com tradução para Electron.

### 3.1 INTERCEPTAÇÃO DE TOKEN (Authorization Header)

**O que faz:** Intercepta toda requisição HTTP do browser embutido e captura o header `Authorization`. Armazena em `_auth` para uso nas chamadas HTTP feitas pelo sistema.

**Fluxo original (C#):**
```
OnBeforeResourceLoad(request) {
    headers = request.Headers
    if headers.Count > 0 {
        authValue = headers["Authorization"]
        if authValue != null {
            control._auth = authValue
            parentForm._auth = authValue
        }
    }
    return Continue
}
```

**Implementação Electron (main process):**
```javascript
// No main process, ao criar a BrowserWindow/BrowserView:
const { session } = require('electron');

session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const authHeader = details.requestHeaders['Authorization'];
    if (authHeader) {
        // Salva o token para uso no sistema
        global.currentAuthToken = authHeader;

        // Notifica o renderer se necessário
        mainWindow.webContents.send('auth-token-updated', authHeader);
    }
    callback({ requestHeaders: details.requestHeaders });
});
```

**Também captura responses (IResponseFilter):**

O sistema original usa `StreamResponseFilter` para capturar o corpo das responses. Isso é útil para extrair dados dos portais.

```javascript
// Electron equivalente:
session.defaultSession.webRequest.onCompleted((details) => {
    // Log de responses completadas para debug
});

// Para capturar response body, usar protocol interceptor ou devtools:
mainWindow.webContents.debugger.attach('1.3');
mainWindow.webContents.debugger.on('message', (event, method, params) => {
    if (method === 'Network.responseReceived') {
        // Captura response
    }
});
```

### 3.2 TIMER 1 - Motor Principal (Intervalo ~5-10s)

**O que faz:** É o coração do sistema. Verifica se o browser está carregado e a flag de operação está ativa, então executa a lógica principal de monitoramento (navegar páginas, extrair dados de licitações, etc).

**Fluxo:**
1. Verifica se `chromeBrowser != null` e `_operacaoAtiva == true`
2. Executa em thread separada o método async de monitoramento
3. O método navega nas páginas, executa JavaScript, extrai dados via `EvaluateScriptAsync`
4. Se detecta sessão expirada, limpa cookies (`DeleteCookies("", "")`) e navega para URL de login

**Electron:**
```javascript
// No main process:
let motorInterval = setInterval(async () => {
    if (!operacaoAtiva || !mainWindow) return;

    try {
        // Executa JavaScript no browser
        const html = await mainWindow.webContents.executeJavaScript(
            'document.documentElement.outerHTML'
        );

        // Processa o HTML extraído
        await processarPagina(html);
    } catch (err) {
        console.error('Motor principal erro:', err);
    }
}, 5000);
```

### 3.3 TIMER 2 - Redirect / Keep-Alive (Intervalo variável)

**O que faz:** Dois papéis:
1. Se uma flag de redirect está ativa, executa navegação de redirecionamento
2. Sempre executa uma função de keep-alive que verifica estado do sistema

**Fluxo:**
1. Verifica flag `_needsRedirect`
2. Se true: chama HandleRedirect() que obtém o HTML, verifica sessão, navega
3. Sempre: chama KeepAliveCheck() que verifica conectividade e estado

**Electron:**
```javascript
let redirectInterval = setInterval(async () => {
    if (needsRedirect) {
        await handleRedirect();
    }
    await keepAliveCheck();
}, 15000);
```

### 3.4 TIMER 3 - Refresh de Sessão (Intervalo ~30-60s)

**O que faz:** Periodicamente verifica se a sessão do portal ainda está ativa. Se detectar expiração, tenta re-autenticar.

**Fluxo detalhado:**
1. Obtém HTML da página via JavaScript (`document.documentElement.outerHTML`)
2. Analisa o HTML procurando indicadores de expiração:
   - Formulários de login na página (a página redirecionou para login)
   - Mensagens de "sessão expirada"
   - URL contendo palavras-chave de logout
   - Verificação em pelo menos 6 strings diferentes
3. Se detecta expiração:
   - Navega browser principal para URL de re-login
   - Marca flag `_isFirstDetection`
4. Se sessão ativa:
   - Navega para URL principal
   - Atualiza browser auxiliar:
     - a. Obtém HTML do browser auxiliar
     - b. Parseia com HtmlAgilityPack
     - c. Encontra elemento com seletor específico
     - d. Extrai atributo `src`
     - e. Monta nova URL e navega o browser auxiliar
     - f. Faz reload
   - Executa script de keep-alive no browser principal

**Electron:**
```javascript
let refreshInterval = setInterval(async () => {
    try {
        const html = await mainWindow.webContents.executeJavaScript(
            'document.documentElement.outerHTML'
        );

        if (isSessionExpired(html)) {
            await mainWindow.loadURL(LOGIN_URL);
            return;
        }

        // Refresh do conteúdo auxiliar (se usar BrowserView separada)
        if (auxView) {
            const auxHtml = await auxView.webContents.executeJavaScript(
                'document.documentElement.outerHTML'
            );
            await refreshAuxContent(auxHtml);
        }

        // Keep-alive script
        await mainWindow.webContents.executeJavaScript(
            'if(window.keepAlive) window.keepAlive();'
        );
    } catch (err) {
        console.error('Refresh sessao erro:', err);
    }
}, 45000);

function isSessionExpired(html) {
    const indicators = [
        'login-form', 'session-expired', 'sessao-expirada',
        'unauthorized', 'fazer-login', 'autenticacao'
        // Ajustar conforme os portais reais
    ];
    return indicators.some(ind => html.toLowerCase().includes(ind));
}
```

### 3.5 TIMER 4 - Re-Login Automático (Intervalo ~60-120s)

**IMPORTANTE:** Este é o mecanismo mais crítico para manutenção de sessão.

**O que faz:** Calcula o tempo desde o último login. Se detectar que está próximo de expirar (ou já expirou), e o sistema tem credenciais armazenadas, faz re-login automático.

**Condições para executar:**
- NÃO está em modo manual (`_login_manual == false`)
- NÃO está em suporte manual (`_parent._suporte_manual == false`)
- `_usuario` e `_senha` estão preenchidos (não vazios)
- Calcula `TimeSpan` desde o timestamp de login (`_loginTimestamp`)

**Fluxo:**
1. Calcula tempo decorrido: `agora - _loginTimestamp`
2. Converte para minutos inteiros
3. Verifica flags de modo manual
4. Se tem usuario/senha e não é manual: executa re-login
5. Re-login provavelmente navega para a página de login e preenche os campos automaticamente

**Electron:**
```javascript
let reLoginInterval = setInterval(async () => {
    if (loginManual || suporteManual) return;
    if (!savedUsuario || !savedSenha) return;

    const elapsed = Date.now() - lastLoginTimestamp;
    const elapsedMinutes = Math.floor(elapsed / 60000);

    // Se passou de X minutos, re-logar
    if (elapsedMinutes >= SESSION_TIMEOUT_MINUTES) {
        await performAutoLogin(savedUsuario, savedSenha);
        lastLoginTimestamp = Date.now();
    }
}, 60000);

async function performAutoLogin(usuario, senha) {
    // Navega para página de login e preenche credenciais
    await mainWindow.loadURL(LOGIN_URL);
    await mainWindow.webContents.executeJavaScript(`
        document.querySelector('#campo-usuario').value = '${usuario}';
        document.querySelector('#campo-senha').value = '${senha}';
        document.querySelector('#btn-login').click();
    `);
}
```

**SEGURANÇA:** Na versão Electron, usar `safeStorage` para encriptar credenciais:
```javascript
const { safeStorage } = require('electron');

function saveCredentials(usuario, senha) {
    const encUser = safeStorage.encryptString(usuario);
    const encPass = safeStorage.encryptString(senha);
    // Salvar encUser e encPass no store
}

function loadCredentials() {
    const usuario = safeStorage.decryptString(encUser);
    const senha = safeStorage.decryptString(encPass);
    return { usuario, senha };
}
```

### 3.6 TIMER 5 - Simulação de Mouse (Intervalo ~15-30s)

**O que faz:** Simula atividade do usuário no browser para evitar que o portal detecte inatividade e faça logout.

**Como funciona:**
- O delegate recebe o `ChromiumWebBrowser`
- Provavelmente envia eventos de mouse (movimento/clique) via API do CefSharp
- É chamado em 6 pontos do código: pelo timer E após operações específicas

**Electron:**
```javascript
let mouseInterval = setInterval(() => {
    if (!mainWindow) return;

    const x = Math.floor(Math.random() * 400) + 100;
    const y = Math.floor(Math.random() * 400) + 100;

    // Simula movimento do mouse
    mainWindow.webContents.sendInputEvent({
        type: 'mouseMove',
        x: x,
        y: y
    });

    // Opcionalmente, simular scroll leve
    mainWindow.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: 300,
        y: 300,
        deltaX: 0,
        deltaY: -1
    });
}, 20000);
```

### 3.7 TIMER 6 - Monitoramento de Chat (Intervalo variável)

**O que faz:** Verifica se há mensagens de chat prioritárias nos portais de licitação. Executa quando o sistema está autenticado e operacional.

**Fluxo:**
1. Verifica flags `_chatAtivo` e `_sistemaOperacional`
2. Se ambas true, chama processamento de chat em thread separada

**Electron:**
```javascript
let chatInterval = setInterval(async () => {
    if (!chatAtivo || !sistemaOperacional) return;
    await verificarChatPrioritario();
}, 30000);
```

### 3.8 TIMER 7 - Processamento Periódico (Intervalo variável)

**O que faz:** Processamento genérico periódico. Verifica flags de autenticação e operação antes de executar.

### 3.9 TIMER 8 - timerFechar (frmLoginManual)

**O que faz:** Timer do form de login manual. Provavelmente fecha o form após timeout.

### 3.10 COOKIES

**Limpeza inicial:** Na inicialização, o sistema chama `CefSharp.GetCookieManager().DeleteCookies("", "")` para limpar todos os cookies e começar com sessão limpa.

**CookieContainer compartilhado:** O `frmCompra` mantém um `CookieContainer` que é injetado em todos os `HttpClient` e `WebClient` usados para chamadas de API. Isso garante que as chamadas HTTP fora do browser carregam os mesmos cookies de sessão.

**Electron:**
```javascript
// Limpar cookies na inicialização
await session.defaultSession.clearStorageData({
    storages: ['cookies']
});

// Compartilhar cookies entre browser e fetch
async function fetchWithSessionCookies(url, options = {}) {
    const cookies = await session.defaultSession.cookies.get({ url });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    return fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            'Cookie': cookieHeader
        }
    });
}
```

### 3.11 VERIFICAÇÃO DE INTERNET

**O que faz:** Usa `Ping` para verificar conectividade. Atualiza indicador visual (painel verde/vermelho).

**Electron:**
```javascript
// Usar eventos nativos do Chromium
const { net } = require('electron');

// Verificação simples
function checkInternet() {
    return net.isOnline();
}

// Ou com eventos:
// No renderer:
window.addEventListener('online', () => updateStatus('online'));
window.addEventListener('offline', () => updateStatus('offline'));
```

---

## 4. FLUXO DE LOGIN COMPLETO

### 4.1 Login Normal

1. Usuário informa CPF/CNPJ (MaskedTextBox) e senha
2. Sistema valida contra banco SQL Server remoto (stored procedure com parâmetros `@usuario` e `@senha`)
3. Se validação retorna rows > 0, login OK
4. Extrai `contrato_id` do resultado
5. Verifica versão do sistema:
   - Faz download da versão atual do servidor (WebClient)
   - Compara versão local (`versao.txt`) vs remota
   - Se desatualizado: baixa atualizador, executa, fecha o sistema
6. Se checkbox "Lembrar" está marcado: salva CPF e senha no banco local (SQL CE)
7. Se desmarcado: limpa credenciais salvas
8. Seta `_autenticado = true` e fecha o form de login
9. O `frmPrincipal` detecta `_autenticado` e inicia os timers de monitoramento

### 4.2 Login no Portal (Automático)

1. Após login no sistema, os timers iniciam
2. O `timerReLogin` (timer 4) monitora o tempo de sessão
3. Quando necessário, executa JavaScript no browser para preencher campos de login do portal e submeter

### 4.3 Credenciais Armazenadas

No `crtCN`:
- `_auth` - token Authorization capturado das requisições (Bearer token ou similar)
- `_usuario` - CPF/CNPJ do usuário
- `_senha` - senha do usuário
- `_empresa_id` - ID da empresa selecionada
- `_nome_empresa` - nome da empresa
- `_cnpj` - CNPJ da empresa
- `_apelido` - apelido da empresa

---

## 5. LÓGICA DE MONITORAMENTO

### 5.1 Motor de Navegação (crtCN)

O `crtCN` é o núcleo do sistema. Ele:
1. Navega para os portais usando `chromeBrowser.Load(url)`
2. Espera a página carregar (verifica via JavaScript se elementos existem)
3. Extrai dados via `EvaluateScriptAsync` (executa JS e pega resultado)
4. Detecta licitações novas parseando HTML com HtmlAgilityPack
5. Age conforme necessário (abre licitação, envia lance, etc.)

O browser auxiliar (`chromeBrowserAux`) é usado para operações em background sem interferir na navegação principal.

### 5.2 Execução de JavaScript no Browser

O sistema usa intensivamente `EvaluateScriptAsync`:

```csharp
// Padrão no código original:
JavascriptResponse response = await browser.EvaluateScriptAsync(script, timeout);
if (response.Success && response.Result != null) {
    string resultado = response.Result.ToString();
}
```

**Electron equivalente:**
```javascript
const resultado = await mainWindow.webContents.executeJavaScript(script);
```

### 5.3 Navegação por Frames

O sistema navega por iframes dos portais:

```csharp
IFrame frame = browser.GetBrowser().GetFrameByName(frameName);
// ou
IFrame frame = browser.GetBrowser().GetFrame(frameId);
```

**Electron:**
```javascript
// Acessar frames
const frames = mainWindow.webContents.mainFrame.frames;
// Executar JS em frame específico
await frame.executeJavaScript(script);
```

### 5.4 frmCompra - Múltiplos Browsers

O `frmCompra` tem 4 ChromiumWebBrowser separados:
- `c79395b7136e81665057ca6f272a082c9` - Browser portal 1
- `c418f5dfaab87bdee8b81e7c7c552cc09` - Browser portal 2
- `cedd739e603009b250df390429913c440` - Browser portal 3
- `cb1e1ba0d42140c8ea866df666271841d` - Browser portal 4

Cada um com `CancellationTokenSource` para cancelar operações.

**Electron:** Usar múltiplas `BrowserView` ou `<webview>` tags.

---

## 6. BANCO DE DADOS

### 6.1 SQL Server Remoto

Usado para:
- Login/autenticação
- Dados de empresas e contratos
- Configurações do sistema
- Dados de licitações
- Chat

Acesso via `SqlConnection`, `SqlCommand`, `SqlDataAdapter`, `DataSet`.

### 6.2 SQL Server CE Local (.sdf)

Arquivo `DB.sdf` no diretório do Monitoramento.

Usado para:
- Cache de credenciais (lembrar login)
- Possivelmente dados offline

**Electron:** Substituir por `better-sqlite3`, `electron-store`, ou `IndexedDB`.

---

## 7. INTEGRAÇÃO COM IA

O sistema tem classes para integração com API tipo OpenAI:
- `Choice`, `Message`, `Usage`, `CompletionTokensDetails`, `PromptTokensDetails`
- Provavelmente usa para análise automática de editais/licitações

---

## 8. AUTO-UPDATE

No login, o sistema verifica versão:
1. Baixa versão remota via WebClient
2. Compara com `versao.txt` local
3. Se desatualizado:
   - Baixa arquivo do atualizador
   - Verifica processos do atualizador rodando (filtra por nome)
   - Cria diretório e salva o atualizador
   - Executa via `Process.Start`
   - Fecha o sistema atual

**Electron:** Usar `electron-updater` (autoUpdater) do `electron-builder`.

---

## 9. MAPEAMENTO DE ARQUITETURA: WINFORMS → ELECTRON

### 9.1 Estrutura de Pastas Sugerida

```
monitoramento-electron/
├── main/
│   ├── index.js              # Main process
│   ├── session-manager.js    # Gerenciamento de sessão (timers, auth)
│   ├── auth-interceptor.js   # Interceptação de tokens HTTP
│   ├── browser-manager.js    # Gerenciamento de BrowserViews
│   ├── database.js           # Acesso a banco de dados
│   ├── auto-updater.js       # Auto-update
│   └── ipc-handlers.js       # Handlers IPC
├── renderer/
│   ├── pages/
│   │   ├── login.html        # frmLogin
│   │   ├── principal.html    # frmPrincipal
│   │   ├── compra.html       # frmCompra
│   │   ├── config.html       # frmConfiguracao
│   │   ├── empresa.html      # frmEmpresa
│   │   └── palavra-chave.html # frmPalavraChave
│   ├── scripts/
│   │   ├── monitor-engine.js # Lógica do motor (equivalente ao crtCN)
│   │   ├── portal-bb.js     # Lógica específica Banco do Brasil
│   │   ├── portal-cp.js     # Lógica específica ComprasNet
│   │   ├── portal-cn.js     # Lógica específica CN
│   │   └── html-parser.js   # Parsing HTML (substitui HtmlAgilityPack)
│   └── styles/
├── preload/
│   └── preload.js            # Preload scripts
└── package.json
```

### 9.2 Mapeamento de Componentes

| WinForms (C#) | Electron (JS) |
|----------------|----------------|
| `Form` | `BrowserWindow` |
| `UserControl (crtCN)` | Módulo JS + `BrowserView` |
| `ChromiumWebBrowser` | `BrowserView` ou `<webview>` |
| `System.Windows.Forms.Timer` | `setInterval` / `setTimeout` |
| `Thread` + async/await | `async/await` nativo + Workers se necessário |
| `ResourceRequestHandler` | `session.webRequest.onBeforeSendHeaders` |
| `EvaluateScriptAsync` | `webContents.executeJavaScript` |
| `SqlConnection` | `mssql` (npm) ou API REST |
| `SqlServerCe` | `better-sqlite3` ou `electron-store` |
| `HtmlAgilityPack` | `cheerio` (npm) |
| `WebClient/HttpClient` | `node-fetch` / `axios` / `net.request` |
| `Newtonsoft.Json` | `JSON.parse/stringify` nativo |
| `CookieContainer` | `session.cookies` |
| `Process.Start` | `child_process.spawn` |
| `SoundPlayer` | `Howler.js` ou Audio API |

### 9.3 Session Manager (Novo - Centralizado)

Na versão original os 8 timers são espalhados. Na nova versão, centralizar:

```javascript
// session-manager.js
class SessionManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.authToken = '';
        this.usuario = '';
        this.senha = '';
        this.empresaId = '';
        this.loginTimestamp = null;
        this.timers = {};
        this.isOperational = false;
    }

    start() {
        this.setupAuthInterceptor();
        this.startMotorTimer();
        this.startRefreshTimer();
        this.startMouseTimer();
        this.startReLoginTimer();
        this.startChatTimer();
        this.startInternetCheckTimer();
    }

    stop() {
        Object.values(this.timers).forEach(t => clearInterval(t));
        this.timers = {};
    }

    setupAuthInterceptor() {
        const ses = this.mainWindow.webContents.session;
        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const auth = details.requestHeaders['Authorization'];
            if (auth) {
                this.authToken = auth;
                this.mainWindow.webContents.send('auth-updated', auth);
            }
            callback({ requestHeaders: details.requestHeaders });
        });
    }

    startMotorTimer() {
        let running = false;
        this.timers.motor = setInterval(async () => {
            if (running || !this.isOperational) return;
            running = true;
            try {
                await this.executarMotor();
            } finally {
                running = false;
            }
        }, 5000);
    }

    startRefreshTimer() {
        let running = false;
        this.timers.refresh = setInterval(async () => {
            if (running) return;
            running = true;
            try {
                await this.verificarSessao();
            } finally {
                running = false;
            }
        }, 45000);
    }

    startMouseTimer() {
        this.timers.mouse = setInterval(() => {
            this.simularAtividade();
        }, 20000);
    }

    startReLoginTimer() {
        this.timers.relogin = setInterval(async () => {
            await this.verificarReLogin();
        }, 60000);
    }

    startChatTimer() {
        let running = false;
        this.timers.chat = setInterval(async () => {
            if (running || !this.isOperational) return;
            running = true;
            try {
                await this.verificarChat();
            } finally {
                running = false;
            }
        }, 30000);
    }

    startInternetCheckTimer() {
        this.timers.internet = setInterval(() => {
            const online = require('electron').net.isOnline();
            this.mainWindow.webContents.send('internet-status', online);
        }, 15000);
    }

    async verificarSessao() {
        const html = await this.mainWindow.webContents.executeJavaScript(
            'document.documentElement.outerHTML'
        );

        if (this.isSessionExpired(html)) {
            console.log('Sessao expirada, re-autenticando...');
            await this.mainWindow.loadURL(LOGIN_URL);
        }
    }

    isSessionExpired(html) {
        const lower = html.toLowerCase();
        // Ajustar conforme indicadores reais dos portais
        return lower.includes('login') && (
            lower.includes('sessao') ||
            lower.includes('expirad') ||
            lower.includes('autenticar')
        );
    }

    simularAtividade() {
        if (!this.mainWindow) return;
        const x = Math.floor(Math.random() * 400) + 100;
        const y = Math.floor(Math.random() * 400) + 100;
        this.mainWindow.webContents.sendInputEvent({
            type: 'mouseMove', x, y
        });
    }

    async verificarReLogin() {
        if (!this.usuario || !this.senha) return;
        if (!this.loginTimestamp) return;

        const elapsed = Date.now() - this.loginTimestamp;
        const minutes = Math.floor(elapsed / 60000);

        if (minutes >= SESSION_TIMEOUT_MINUTES) {
            await this.performAutoLogin();
        }
    }

    async performAutoLogin() {
        // Implementar conforme portal
        this.loginTimestamp = Date.now();
    }

    async executarMotor() {
        // Implementar lógica principal de monitoramento
    }

    async verificarChat() {
        // Implementar verificação de chat prioritário
    }
}

module.exports = SessionManager;
```

---

## 10. PONTOS CRÍTICOS E CUIDADOS

### 10.1 Race Conditions

O sistema original cria `new Thread()` a cada tick de timer sem verificar se a anterior terminou. Na nova versão, usar flags `running` como mostrado acima.

### 10.2 Credenciais

- Usar `safeStorage` do Electron para encriptar
- **NUNCA** armazenar em plain text no `electron-store`

### 10.3 Detecção de Expiração

O sistema original verifica 6+ strings no HTML. Isso é frágil.

**Melhor:** interceptar status HTTP 401/403 via `session.webRequest.onHeadersReceived`

Se tiver JWT: decodificar e verificar `exp` claim

### 10.4 Múltiplos Browsers

- `frmCompra` usa 4 browsers simultaneamente
- No Electron: usar `BrowserView` (melhor performance) ou `<webview>` (mais isolado)
- Cuidado com limite de memória do Chromium

### 10.5 Cookies entre Contextos

- CefSharp original compartilha cookies via `CookieContainer` manual
- No Electron: `session.defaultSession.cookies` é compartilhado automaticamente entre BrowserViews que usam a mesma session
- Se precisar isolar: criar `session.fromPartition('persist:portal-x')`

### 10.6 HtmlAgilityPack → Cheerio

O sistema usa HtmlAgilityPack para parsear HTML das páginas. Substituir por `cheerio`:

```javascript
const cheerio = require('cheerio');
const $ = cheerio.load(html);
const srcValue = $('iframe#alvo').attr('src');
```

### 10.7 Sons

O sistema tem pasta `Sons/` com arquivos de áudio (provavelmente alertas de licitação). Usar `Howler.js` ou `new Audio()` no renderer.

### 10.8 SQL Server

Acesso via `mssql` (npm). Manter connection pooling:

```javascript
const sql = require('mssql');
const pool = new sql.ConnectionPool(config);
await pool.connect();
```

---

## 11. ORDEM DE IMPLEMENTAÇÃO SUGERIDA

1. **Setup Electron** - Estrutura básica, BrowserWindow, preload
2. **Login** - frmLogin com validação SQL Server
3. **Session Manager** - Auth interceptor + timers básicos
4. **Motor principal** - Navegação e extração de dados de 1 portal
5. **Refresh/ReLogin** - Manutenção de sessão automática
6. **frmPrincipal** - Interface principal com controles
7. **frmCompra** - Detalhes de licitação com múltiplos browsers
8. **Demais portais** - BB, CP, CN
9. **Chat e IA** - Integração com chat e OpenAI
10. **Auto-update** - electron-updater
11. **Polish** - Sons, configurações, palavras-chave
