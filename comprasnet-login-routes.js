const express = require('express');
const router = express.Router();
const http = require('http');

const CHROME_API = 'http://127.0.0.1:9600';
const ELECTRON_API = 'http://127.0.0.1:9500'; // backup

const activeTokens = new Map();

function getTokenExpiration(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], 'base64').toString());
        if (payload.exp) {
            return new Date(payload.exp * 1000).toLocaleString('pt-BR');
        }
    } catch (e) {
        console.error('[Token] Error:', e.message);
    }
    return null;
}

router.get('/auto-login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ComprasNet Auto-Login</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
        .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; width: 400px; max-width: 95vw; }
        h1 { font-size: 20px; margin-bottom: 4px; color: #58a6ff; }
        .subtitle { font-size: 13px; color: #8b949e; margin-bottom: 24px; }
        label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 6px; margin-top: 16px; }
        input { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 15px; outline: none; }
        input:focus { border-color: #58a6ff; }
        .actions { margin-top: 24px; display: flex; gap: 10px; }
        button { flex: 1; padding: 10px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
        .btn-save { background: #238636; color: #fff; }
        .btn-save:hover { background: #2ea043; }
        .btn-login { background: #1f6feb; color: #fff; }
        .btn-login:hover { background: #388bfd; }
        .btn-login:disabled, .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
        .status { margin-top: 16px; padding: 12px; border-radius: 6px; font-size: 13px; display: none; word-break: break-word; }
        .status.info { display: block; background: #0d1117; border: 1px solid #30363d; color: #8b949e; }
        .status.ok { display: block; background: #0d2212; border: 1px solid #238636; color: #3fb950; }
        .status.err { display: block; background: #2d1117; border: 1px solid #da3633; color: #f85149; }
        .status.loading { display: block; background: #0d1117; border: 1px solid #1f6feb; color: #58a6ff; }
        .saved-info { margin-top: 12px; font-size: 12px; color: #8b949e; }
        .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #58a6ff; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .log-box { margin-top: 16px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px; max-height: 250px; overflow-y: auto; font-family: monospace; font-size: 11px; color: #8b949e; display: none; }
        .log-box.active { display: block; }
        .log-box .line { margin: 2px 0; }
        .log-box .line.err { color: #f85149; }
        .log-box .line.ok { color: #3fb950; }
        .log-box .line.info { color: #58a6ff; }
    </style>
</head>
<body>
    <div class="card">
        <h1>ComprasNet Auto-Login</h1>
        <p class="subtitle">Login automatico via Gov.br (Chrome real + CDP)</p>

        <label for="cpf">CPF</label>
        <input type="text" id="cpf" placeholder="000.000.000-00" maxlength="14">

        <label for="senha">Senha Gov.br</label>
        <input type="password" id="senha" placeholder="Sua senha">

        <div class="actions">
            <button class="btn-save" onclick="salvar()">Salvar</button>
            <button class="btn-login" id="btnLogin" onclick="login()">Fazer Login</button>
        </div>

        <div class="status" id="status"></div>
        <div class="log-box" id="logBox"></div>
        <div class="saved-info" id="savedInfo"></div>
    </div>

    <script>
        const statusEl = document.getElementById('status');
        const savedInfo = document.getElementById('savedInfo');
        const cpfInput = document.getElementById('cpf');
        const senhaInput = document.getElementById('senha');
        const btnLogin = document.getElementById('btnLogin');

        // Formatar CPF enquanto digita
        cpfInput.addEventListener('input', () => {
            let v = cpfInput.value.replace(/\\D/g, '').slice(0, 11);
            if (v.length > 9) v = v.replace(/(\\d{3})(\\d{3})(\\d{3})(\\d+)/, '$1.$2.$3-$4');
            else if (v.length > 6) v = v.replace(/(\\d{3})(\\d{3})(\\d+)/, '$1.$2.$3');
            else if (v.length > 3) v = v.replace(/(\\d{3})(\\d+)/, '$1.$2');
            cpfInput.value = v;
        });

        // Carregar credenciais salvas
        const saved = JSON.parse(localStorage.getItem('comprasnet_creds') || 'null');
        if (saved) {
            cpfInput.value = saved.cpf || '';
            senhaInput.value = saved.senha || '';
            savedInfo.textContent = 'Credenciais carregadas do navegador.';
        }

        function setStatus(msg, type) {
            statusEl.className = 'status ' + type;
            statusEl.innerHTML = msg;
        }

        function salvar() {
            const cpf = cpfInput.value.trim();
            const senha = senhaInput.value;
            if (!cpf || !senha) { setStatus('Preencha CPF e senha.', 'err'); return; }
            localStorage.setItem('comprasnet_creds', JSON.stringify({ cpf, senha }));
            setStatus('Credenciais salvas no navegador.', 'ok');
        }

        const logBox = document.getElementById('logBox');
        let evtSource = null;

        function startLogStream() {
            logBox.className = 'log-box active';
            logBox.innerHTML = '';
            if (evtSource) evtSource.close();
            evtSource = new EventSource(window.location.href + '/logs');
            evtSource.onmessage = (e) => {
                try {
                    const { log: line } = JSON.parse(e.data);
                    const div = document.createElement('div');
                    div.className = 'line' + (line.includes('ERRO') ? ' err' : line.includes('OK') ? ' ok' : line.includes('Poll') ? ' info' : '');
                    div.textContent = line;
                    logBox.appendChild(div);
                    logBox.scrollTop = logBox.scrollHeight;
                } catch (ex) {}
            };
        }

        function stopLogStream() {
            if (evtSource) { evtSource.close(); evtSource = null; }
        }

        async function login() {
            const cpf = cpfInput.value.replace(/\\D/g, '');
            const senha = senhaInput.value;
            if (!cpf || !senha) { setStatus('Preencha CPF e senha.', 'err'); return; }

            btnLogin.disabled = true;
            setStatus('<span class="spinner"></span> Enviando login ao Chrome browser... (pode levar ate 90s)', 'loading');
            startLogStream();

            try {
                const resp = await fetch(window.location.href, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cpf, senha })
                });
                const data = await resp.json();
                stopLogStream();
                if (data.success) {
                    setStatus('Login realizado com sucesso!<br>Token: ' + (data.token || '-').substring(0, 40) + '...', 'ok');
                } else {
                    setStatus('Erro: ' + (data.error || 'Falha desconhecida'), 'err');
                }
            } catch (e) {
                stopLogStream();
                setStatus('Erro de conexao: ' + e.message, 'err');
            } finally {
                btnLogin.disabled = false;
            }
        }

        // Enter para fazer login
        senhaInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    </script>
</body>
</html>`);
});

// Helper: fetch da Chrome API (porta 9600) com fallback para Electron (porta 9500)
function chromeFetch(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, CHROME_API);
        const opts = { hostname: '127.0.0.1', port: 9600, path: url.pathname, method, headers: { 'Content-Type': 'application/json' } };
        const req = http.request(opts, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: data }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('Chrome API não respondeu (porta 9600). Verifique se o chrome-login.js está rodando.')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// Alias para compatibilidade
const electronFetch = chromeFetch;

// Log buffer para SSE (últimos 50 logs)
const loginLogs = [];
function loginLog(msg) {
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    const line = `[${ts}] ${msg}`;
    console.log('[Login] ' + msg);
    loginLogs.push(line);
    if (loginLogs.length > 50) loginLogs.shift();
    // Notificar SSE clients
    sseClients.forEach(c => c.write(`data: ${JSON.stringify({ log: line })}\n\n`));
}

// SSE endpoint para frontend acompanhar logs em tempo real
const sseClients = new Set();
router.get('/auto-login/logs', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    // Enviar logs anteriores
    loginLogs.forEach(line => res.write(`data: ${JSON.stringify({ log: line })}\n\n`));
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
});

router.post('/auto-login', async (req, res) => {
    console.log('[Login POST] Requisição recebida! body:', JSON.stringify(req.body));
    const { cpf, senha } = req.body;
    if (!cpf || !senha) {
        return res.status(400).json({ success: false, error: 'CPF e senha obrigatórios' });
    }
    try {
        // 1. Verificar se Chrome está rodando
        loginLog('Conectando ao Chrome browser (CDP) na porta 9600...');
        let status;
        try {
            status = await chromeFetch('/status');
        } catch (e) {
            loginLog('ERRO: Chrome API não acessível: ' + e.message);
            return res.status(500).json({ success: false, error: 'Chrome browser não está rodando. Execute: DISPLAY=:1 node chrome-login.js' });
        }
        loginLog(`Chrome conectado! Estado: ${status.state} | Bearer: ${status.bearerToken ? status.bearerToken : 'nenhum'} | TTL: ${status.tokenTTL}s | URL: ${status.url}`);

        // Se já está logado com bearer fresco, retornar direto
        if (status.state === 'logged_in' && status.bearerFresh) {
            loginLog('Chrome já está logado com Bearer fresco!');
            const bearerResp = await chromeFetch('/bearer');
            loginLog(`Bearer age: ${bearerResp.age}s`);
            return res.json({ success: true, message: 'Sessão Chrome já ativa', token: bearerResp.bearer, bearerAge: bearerResp.age });
        }

        // 2. Enviar login ao Chrome
        const cpfLimpo = cpf.replace(/\D/g, '');
        loginLog(`Enviando POST /login ao Chrome (CPF: ${cpfLimpo.substring(0, 3)}***${cpfLimpo.substring(cpfLimpo.length - 2)})...`);
        let loginResp;
        try {
            loginResp = await chromeFetch('/login', 'POST', { cpf: cpfLimpo, senha });
        } catch (e) {
            loginLog('ERRO ao enviar login ao Chrome: ' + e.message);
            return res.status(500).json({ success: false, error: 'Falha ao comunicar com Chrome: ' + e.message });
        }
        loginLog(`Chrome respondeu: ${JSON.stringify(loginResp)}`);

        // 3. Polling do status a cada 3s por até 90s
        loginLog('Iniciando polling do status (timeout: 90s)...');
        const startTime = Date.now();
        const TIMEOUT = 90000;
        let pollCount = 0;
        while (Date.now() - startTime < TIMEOUT) {
            await new Promise(r => setTimeout(r, 3000));
            pollCount++;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);

            let check;
            try {
                check = await chromeFetch('/status');
            } catch (e) {
                loginLog(`Poll #${pollCount} (${elapsed}s): ERRO ao consultar status: ${e.message}`);
                continue;
            }

            loginLog(`Poll #${pollCount} (${elapsed}s): estado=${check.state} | bearer=${check.bearerToken ? 'SIM (' + check.bearerAge + 's)' : 'NAO'} | url=${check.url}`);

            if (check.state === 'logged_in' && check.bearerToken) {
                const bearerResp = await chromeFetch('/bearer');
                loginLog(`LOGIN OK! Bearer capturado (age: ${bearerResp.age}s, token: ${(bearerResp.bearer || '').substring(0, 40)}...)`);
                return res.json({ success: true, message: 'Login via Chrome (CDP)', token: bearerResp.bearer, bearerAge: bearerResp.age });
            }

            if (check.state === 'error') {
                loginLog('Chrome reportou estado ERROR. Verifique logs do chrome-login.js');
                return res.json({ success: false, error: 'Chrome reportou erro no login. Verifique os logs do chrome-login.js' });
            }
        }

        loginLog('TIMEOUT: 90s sem obter Bearer. Último estado do Chrome consultado acima.');
        return res.json({ success: false, error: 'Timeout (90s). Login não completou. Verifique os logs do chrome-login.js' });

    } catch (error) {
        loginLog('ERRO GERAL: ' + error.message + (error.stack ? '\n' + error.stack : ''));
        return res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/token/:cpf', (req, res) => {
    const data = activeTokens.get(req.params.cpf.replace(/\D/g, ''));
    if (!data) return res.status(404).json({ success: false });
    return res.json({ success: true, token: data.token, expiration: data.expiration });
});

router.delete('/token/:cpf', (req, res) => {
    const deleted = activeTokens.delete(req.params.cpf.replace(/\D/g, ''));
    return res.json({ success: deleted });
});

module.exports = router;
