/**
 * monitor-mensagens-core.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.26).
 *
 * Hospeda as duas classes do robô de monitoramento de mensagens do
 * Comprasnet:
 *   - MonitorMensagensComprasnet (monitor global, via puppeteer)
 *   - MonitorChat (legado, mantido por compatibilidade)
 *
 * API: createMonitorMensagens({ db, getConfigValue, enviarTelegram })
 *      → { MonitorMensagensComprasnet, MonitorChat }
 *
 * Dependências externas (require no topo): axios, puppeteer-extra, path,
 * fs, crypto. O `puppeteer-extra` compartilha singleton via cache de
 * require, então o StealthPlugin aplicado em server.js vale aqui também.
 * Deps específicas do server (db/getConfigValue/enviarTelegram) entram
 * via closure do factory.
 *
 * Rotas /api/chat/iniciar-monitoramento, /parar-monitoramento, /status-
 * monitoramento/:cnpj/:ano/:sequencial e /monitoramentos-ativos + função
 * autoIniciarMonitoramentoMensagens permanecem em server.js
 * (extração prevista para onda futura).
 */

const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function createMonitorMensagens({ db, getConfigValue, enviarTelegram }) {

  // Instância única do monitor de mensagens

  // Classe para monitorar TODAS as mensagens do Comprasnet (área de comunicados)
  class MonitorMensagensComprasnet {
    constructor() {
      this.browser = null;
      this.page = null;
      this.ativo = false;
      this.intervalo = null;
      this.mensagensProcessadas = new Set();
      this.logs = [];
      this.ultimaVerificacao = null;
      this.totalMensagensNovas = 0;
    }

    log(mensagem) {
      const timestamp = new Date().toLocaleTimeString('pt-BR');
      const logEntry = `[${timestamp}] ${mensagem}`;
      this.logs.push(logEntry);
      console.log(`[Monitor Mensagens] ${mensagem}`);
      if (this.logs.length > 100) this.logs.shift();
    }

    async iniciar() {
      if (this.ativo) {
        this.log('Monitor já está ativo');
        return { success: true, message: 'Já está ativo' };
      }

      try {
        this.log('Iniciando monitoramento de mensagens do Comprasnet...');

        // Verificar modo de login manual
        const loginManual = getConfigValue('chat_login_manual') === '1';
        if (loginManual) {
          this.log('Modo de LOGIN MANUAL ativado');
        }

        // Verificar se há certificado digital configurado (prioridade)
        const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular FROM certificado_digital WHERE id = 1').get();
        const usarCertificado = !!cert && !!cert.certificadoBase64;

        // Buscar credenciais CPF/senha como fallback
        const cpf = getConfigValue('govbr_cpf');
        const senha = getConfigValue('govbr_senha');

        // No modo manual, não exigir credenciais
        if (!loginManual && !usarCertificado && (!cpf || !senha)) {
          throw new Error('Configure o certificado digital OU as credenciais gov.br em Configurações > Dados do Fornecedor');
        }

        this.loginManual = loginManual;

        // Preparar certificado se disponível
        let certInstalado = false;
        if (usarCertificado) {
          this.log('Certificado digital encontrado - usando login com certificado');
          const os = require('os');
          const fs = require('fs');
          const { execSync } = require('child_process');

          const certTempPath = path.join(os.tmpdir(), `cert_${Date.now()}.pfx`);
          const certBuffer = Buffer.from(cert.certificadoBase64, 'base64');
          const certSenha = Buffer.from(cert.senhaCriptografada, 'base64').toString();
          fs.writeFileSync(certTempPath, certBuffer);
          this.log('Certificado salvo em arquivo temporário');

          // Verificar se o certificado já está instalado no Windows
          try {
            const result = execSync('certutil -store -user My', { encoding: 'utf8', stdio: 'pipe' });
            if (cert.titular && result.includes(cert.titular.split(':')[0])) {
              certInstalado = true;
              this.log('Certificado já está instalado no Windows');
            }
          } catch (e) {}

          // Tentar instalar certificado
          if (!certInstalado) {
            try {
              execSync(`certutil -f -p "${certSenha}" -user -importpfx "${certTempPath}"`, { stdio: 'pipe' });
              this.log('Certificado instalado no Windows Certificate Store');
              certInstalado = true;
            } catch (e) {
              this.log('Aviso: Não foi possível instalar certificado automaticamente');
            }
          }

          // Limpar arquivo temporário
          try { fs.unlinkSync(certTempPath); } catch (e) {}
        }

        // Flag para saber qual método de login usar
        this.usarCertificado = usarCertificado && certInstalado;
        this.cpf = cpf;
        this.senhaGovbr = senha;

        if (this.usarCertificado) {
          this.log('Login será feito com certificado digital');
        } else if (cpf && senha) {
          this.log('Login será feito com CPF/senha');
        } else {
          throw new Error('Nenhum método de autenticação disponível');
        }

        // Configurar argumentos do navegador
        const browserArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--ignore-certificate-errors',
          '--ignore-ssl-errors=true',
          '--ignore-certificate-errors-spki-list',
          '--allow-running-insecure-content',
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--window-size=1366,768',
          '--disable-extensions',
          '--disable-popup-blocking'
        ];

        // Auto-selecionar certificado para gov.br
        if (this.usarCertificado) {
          browserArgs.push('--auto-select-certificate-for-urls={"pattern":"*gov.br*","filter":{}}');
        }

        // Verificar proxy
        const proxyAtivo = getConfigValue('proxy_ativo');
        const proxyServidor = getConfigValue('proxy_servidor');
        const proxyPorta = getConfigValue('proxy_porta');

        if (proxyAtivo === '1' && proxyServidor && proxyPorta) {
          browserArgs.push(`--proxy-server=${proxyServidor}:${proxyPorta}`);
          this.log(`Usando proxy: ${proxyServidor}:${proxyPorta}`);
        }

        // NOVA ABORDAGEM: Conectar a um Chrome já aberto pelo usuário
        // Isso evita problemas de detecção do reCaptcha
        const os = require('os');
        const userDataDir = path.join(os.homedir(), '.pncp-monitor-data');
        const chromeExecutable = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        const debuggingPort = 9222;

        // Tentar conectar a um Chrome já aberto
        let conectadoAoExistente = false;
        try {
          this.log(`Tentando conectar ao Chrome existente na porta ${debuggingPort}...`);
          const response = await axios.get(`http://127.0.0.1:${debuggingPort}/json/version`, { timeout: 2000 });
          const wsEndpoint = response.data.webSocketDebuggerUrl;

          this.browser = await puppeteer.connect({
            browserWSEndpoint: wsEndpoint,
            defaultViewport: null
          });

          this.log(`✅ Conectado ao Chrome existente!`);
          conectadoAoExistente = true;

          // Buscar a aba correta do cnetmobile (onde está logado)
          const pages = await this.browser.pages();
          this.log(`Abas abertas: ${pages.length}`);

          // Priorizar aba do cnetmobile que não seja acesso-nao-autorizado
          for (const p of pages) {
            const url = p.url();
            this.log(`  Aba: ${url.substring(0, 80)}...`);
          }

          // Primeiro tentar encontrar aba do cnetmobile logada
          this.page = pages.find(p => {
            const url = p.url();
            return url.includes('cnetmobile') &&
                   !url.includes('acesso-nao-autorizado') &&
                   (url.includes('/compras') || url.includes('/fornecedor'));
          });

          // Se não encontrou, tentar qualquer aba do cnetmobile
          if (!this.page) {
            this.page = pages.find(p => p.url().includes('cnetmobile') && !p.url().includes('acesso-nao-autorizado'));
          }

          // Se ainda não encontrou, usar a primeira aba válida
          if (!this.page) {
            this.page = pages.find(p => !p.url().includes('about:blank')) || pages[0];
          }

          if (!this.page) {
            this.page = await this.browser.newPage();
          }

          this.log(`Usando aba: ${this.page.url().substring(0, 80)}`);

        } catch (e) {
          // Chrome não está rodando com depuração - iniciar novo
          this.log(`Chrome não encontrado na porta ${debuggingPort}, iniciando novo...`);
          this.log(`⚠️ IMPORTANTE: Faça login MANUALMENTE no gov.br e depois reinicie o servidor!`);

          // Adicionar porta de depuração
          browserArgs.push(`--remote-debugging-port=${debuggingPort}`);

          this.browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: browserArgs,
            userDataDir: userDataDir,
            executablePath: chromeExecutable,
            ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection']
          });

          this.log(`Chrome iniciado com depuração na porta ${debuggingPort}`);
          this.log(`Usando diretório de dados do navegador: ${userDataDir}`);

          this.page = await this.browser.newPage();
        }

        this.page.setDefaultTimeout(120000);

        // Ignorar erros de SSL/certificado
        try {
          await this.page.setBypassCSP(true);
          const client = await this.page.target().createCDPSession();
          await client.send('Security.enable');
          await client.send('Security.setIgnoreCertificateErrors', { ignore: true });
        } catch (e) {
          // Ignorar erros ao configurar
        }

        // Autenticar proxy se necessário
        const proxyUsuario = getConfigValue('proxy_usuario');
        const proxySenha = getConfigValue('proxy_senha');
        if (proxyAtivo === '1' && proxyUsuario && proxySenha) {
          await this.page.authenticate({ username: proxyUsuario, password: proxySenha });
        }

        // Se conectou a Chrome existente, verificar se já está logado
        let jaLogado = false;
        if (conectadoAoExistente) {
          const url = this.page.url();
          if (url.includes('cnetmobile') && !url.includes('acesso-nao-autorizado')) {
            this.log(`✅ Já está logado no cnetmobile!`);
            jaLogado = true;
          } else if (url.includes('comprasnet') && !url.includes('login')) {
            this.log(`✅ Já está logado no comprasnet!`);
            jaLogado = true;
          }
        }

        // Fazer login apenas se necessário
        if (!jaLogado) {
          await this.fazerLogin();
        }

        // Ir para área de mensagens do Comprasnet
        await this.irParaMensagens();

        this.ativo = true;
        this.log('Monitoramento iniciado com sucesso!');

        // Notificar no Telegram
        await enviarTelegram('🟢 <b>Monitor de Mensagens Ativo</b>\n\nMonitorando comunicações de pregoeiros no Comprasnet.');

        // Iniciar loop de verificação
        this.iniciarVerificacao();

        return { success: true };
      } catch (error) {
        this.log('Erro ao iniciar: ' + error.message);
        await this.parar();
        throw error;
      }
    }

    async fazerLogin() {
      // IMPORTANTE: O fluxo correto é acessar primeiro o Comprasnet, que redireciona para gov.br
      // Após login no gov.br, ele redireciona de volta ao Comprasnet com a sessão autenticada

      this.log('Verificando sessão existente...');

      // Primeiro, tentar acessar área segura do Comprasnet antigo para verificar sessão
      try {
        await this.page.goto('https://www.comprasnet.gov.br/seguro/indexgov.asp', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        let urlAtual = this.page.url();
        this.log(`URL ao verificar sessão (antigo): ${urlAtual}`);

        // Se conseguiu acessar área segura sem redirecionamento para login, já está logado
        if (urlAtual.includes('comprasnet.gov.br/seguro') && !urlAtual.includes('login')) {
          this.log('Sessão existente válida encontrada no Comprasnet ANTIGO!');
          this.portalAntigo = true;
          return; // Já está logado
        }
      } catch (e) {
        this.log('Comprasnet antigo: erro ou sem sessão');
      }

      // Tentar também o Comprasnet novo
      try {
        await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        let urlAtual = this.page.url();
        this.log(`URL ao verificar sessão (novo): ${urlAtual}`);

        if (urlAtual.includes('seguro/fornecedor') && !urlAtual.includes('acesso-nao-autorizado')) {
          this.log('Sessão existente válida encontrada no Comprasnet NOVO!');
          this.portalAntigo = false;
          return; // Já está logado
        }
      } catch (e) {
        this.log('Comprasnet novo: erro ou sem sessão');
      }

      this.log('Nenhuma sessão válida encontrada, iniciando login...');

      // MODO MANUAL: Aguardar usuário fazer login manualmente
      if (this.loginManual) {
        this.log('🖐️ MODO MANUAL: Faça login e navegue até o CNETMOBILE');
        this.log('Aguardando login manual (máximo 5 minutos)...');
        this.log('IMPORTANTE: Após login, clique em "Compras" e acesse uma licitação no sistema novo!');

        // Notificar via Telegram
        await enviarTelegram('🖐️ <b>Login Manual Necessário</b>\n\nO navegador foi aberto para você fazer login.\n\n<b>IMPORTANTE:</b> Após login, navegue até o sistema novo (cnetmobile):\n1. Clique em "Compras"\n2. Acesse uma licitação\n\nTempo limite: 5 minutos');

        // Ir diretamente para a página de login do fornecedor
        this.log('Abrindo página de login do Compras.gov.br...');
        try {
          // Acessar diretamente a página de login do fornecedor
          // URL baseada na foto 1 das evidências
          await this.page.goto('https://compras.gov.br/acesso-ao-sistema', { waitUntil: 'networkidle2', timeout: 60000 }).catch(async () => {
            // Se não existir, tentar comprasnet.gov.br
            await this.page.goto('https://www.comprasnet.gov.br/seguro/loginPortal.asp', { waitUntil: 'networkidle2', timeout: 60000 });
          });

          await new Promise(r => setTimeout(r, 3000));

          // Verificar URL atual
          let urlAtual = this.page.url();
          this.log(`URL após carregar: ${urlAtual}`);

          // Se ainda não está na página de login SSO, tentar navegar para login do fornecedor
          if (!urlAtual.includes('sso.acesso.gov.br') && !urlAtual.includes('cnetmobile')) {
            // Tentar clicar em "Fornecedor Brasileiro" se estiver visível
            const clicouFornecedor = await this.page.evaluate(() => {
              const elementos = Array.from(document.querySelectorAll('a, button, div, span'));
              for (const el of elementos) {
                const texto = (el.textContent || '').toLowerCase();
                if (texto.includes('fornecedor brasileiro') || texto.includes('fornecedor') && texto.includes('brasileiro')) {
                  el.click();
                  return { clicked: true, text: texto.substring(0, 50) };
                }
              }
              // Tentar "Acesso ao Sistema"
              for (const el of elementos) {
                const texto = (el.textContent || '').trim().toLowerCase();
                if (texto === 'acesso ao sistema' || (texto.includes('acesso') && texto.includes('sistema'))) {
                  el.click();
                  return { clicked: true, text: 'Acesso ao Sistema' };
                }
              }
              return { clicked: false };
            });

            if (clicouFornecedor.clicked) {
              this.log(`Clicou em: ${clicouFornecedor.text}`);
              await new Promise(r => setTimeout(r, 3000));
            }

            // Verificar se apareceu modal de login
            urlAtual = this.page.url();
            if (!urlAtual.includes('sso.acesso.gov.br')) {
              // Tentar clicar em "Entrar com Gov.br"
              await this.page.evaluate(() => {
                const elementos = Array.from(document.querySelectorAll('a, button, div'));
                for (const el of elementos) {
                  const texto = (el.textContent || '').toLowerCase();
                  if (texto.includes('gov.br') || texto.includes('entrar')) {
                    el.click();
                    return true;
                  }
                }
                return false;
              });
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        } catch (e) {
          this.log('Erro ao acessar Compras.gov.br: ' + e.message);
          this.log('Tentando comprasnet.gov.br como fallback...');
          await this.page.goto('https://www.comprasnet.gov.br/seguro/loginPortal.asp', { waitUntil: 'networkidle2', timeout: 60000 });
        }
        await new Promise(r => setTimeout(r, 2000));

        this.log('Página de login aberta - faça login com certificado ou CPF/senha');

        // Aguardar até 5 minutos para login manual
        let loginSucesso = false;
        this.avisouCnetmobile = false; // Flag para avisar apenas uma vez
        for (let i = 0; i < 60; i++) { // 60 x 5s = 5 minutos
          await new Promise(r => setTimeout(r, 5000));

          // Verificar todas as abas/páginas do navegador (login pode abrir nova aba)
          const pages = await this.browser.pages();
          let url = this.page.url();

          // Logar todas as URLs das abas a cada 30 segundos para debug
          if (i % 6 === 0) {
            this.log(`Abas abertas: ${pages.length}`);
            for (let p = 0; p < pages.length; p++) {
              const pageUrl = pages[p].url();
              this.log(`  Aba ${p}: ${pageUrl.substring(0, 100)}`);
            }
          }

          // Procurar em todas as abas por uma que indique login bem-sucedido
          for (const page of pages) {
            const pageUrl = page.url();
            // Verificar várias URLs possíveis após login
            const isLoginPage =
                pageUrl.includes('comprasnet.gov.br/intro') ||
                pageUrl.includes('comprasnet.gov.br/Fornecedor') ||
                pageUrl.includes('comprasnet.gov.br/seguro') ||
                pageUrl.includes('compras.gov.br/fornecedor') ||
                pageUrl.includes('Area-Trabalho-do-Fornecedor') ||
                (pageUrl.includes('cnetmobile') && !pageUrl.includes('acesso-nao-autorizado'));

            if (isLoginPage) {
              // Encontrou aba com login - mudar para ela
              this.page = page;
              url = pageUrl;
              this.log(`✅ Detectada aba com login: ${url.substring(0, 80)}...`);
              break;
            }
          }

          this.log(`URL atual: ${url.substring(0, 80)}...`);

          // PRIORIDADE 1: Verificar se há aba do cnetmobile (melhor cenário)
          let temCnetmobile = false;
          for (const page of pages) {
            const pageUrl = page.url();
            if (pageUrl.includes('cnetmobile') && !pageUrl.includes('acesso-nao-autorizado')) {
              this.page = page;
              loginSucesso = true;
              temCnetmobile = true;
              this.log('✅ Login detectado no cnetmobile!');
              break;
            }
          }
          if (temCnetmobile) break;

          // PRIORIDADE 2: Detectar login no comprasnet antigo
          let loginComprasnetAntigo = false;
          if (url.includes('comprasnet.gov.br/intro.htm') ||
              url.includes('comprasnet.gov.br/seguro') ||
              url.includes('comprasnet.gov.br/fornecedor')) {
            loginComprasnetAntigo = true;
          }

          // Se detectou login no comprasnet antigo, avisar para navegar até cnetmobile
          if (loginComprasnetAntigo && !this.avisouCnetmobile) {
            this.log('⚠️ Login OK no Comprasnet antigo - agora navegue até o cnetmobile!');
            this.log('➡️ Clique em "Compras" e acesse uma licitação no sistema novo');
            this.avisouCnetmobile = true;
            await enviarTelegram('⚠️ <b>Login OK - Continue navegando!</b>\n\nLogin detectado no Comprasnet antigo.\n\n<b>Agora navegue até o cnetmobile:</b>\n1. Clique em "Compras"\n2. Acesse uma licitação no sistema novo');
          }

          // Só aceitar login do comprasnet antigo se estiver nos últimos 60 segundos
          if (loginComprasnetAntigo && i >= 48) { // 48 * 5 = 240 segundos = 4 minutos
            loginSucesso = true;
            this.log('Aceitando login do Comprasnet antigo (tempo quase esgotado)');
            break;
          }

          // Mostrar status a cada 30 segundos
          if (i % 6 === 0) {
            this.log(`Aguardando login manual... (${Math.floor((300 - i * 5) / 60)} min restantes)`);
          }
        }

        if (!loginSucesso) {
          throw new Error('Timeout aguardando login manual. Reinicie o monitor e tente novamente.');
        }

        this.log('Login manual detectado com sucesso!');
        await enviarTelegram('✅ <b>Login Detectado</b>\n\nLogin manual realizado com sucesso. Iniciando monitoramento...');

        // Mover navegador para fora da tela para não atrapalhar
        try {
          this.log('Movendo navegador para segundo plano...');
          const pages = await this.browser.pages();
          if (pages.length > 0) {
            // Mover janela para fora da tela visível
            const session = await pages[0].target().createCDPSession();
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', {
              windowId,
              bounds: { left: -2000, top: -2000, width: 800, height: 600 }
            });
            this.log('✅ Navegador movido para fora da tela - monitoramento em segundo plano');
          }
        } catch (e) {
          this.log('Não foi possível mover janela: ' + e.message);
          // Tentar minimizar via JavaScript
          try {
            await this.page.evaluate(() => {
              window.moveTo(-2000, -2000);
              window.resizeTo(800, 600);
            });
            this.log('✅ Janela movida via JavaScript');
          } catch (e2) {
            this.log('Continuando com janela visível: ' + e2.message);
          }
        }

        // IMPORTANTE: Após login, verificar TODAS as abas para encontrar uma no cnetmobile já logada
        const todasAbas = await this.browser.pages();
        this.log(`Verificando ${todasAbas.length} abas após login...`);

        let abaCnetmobile = null;
        for (const aba of todasAbas) {
          const abaUrl = aba.url();
          this.log(`  Verificando: ${abaUrl.substring(0, 80)}`);
          if (abaUrl.includes('cnetmobile.estaleiro.serpro.gov.br') && !abaUrl.includes('acesso-nao-autorizado')) {
            abaCnetmobile = aba;
            this.log(`✅ Encontrada aba do cnetmobile já logada: ${abaUrl}`);
            break;
          }
        }

        // Se encontrou aba do cnetmobile, usar ela!
        if (abaCnetmobile) {
          this.page = abaCnetmobile;
          await this.page.bringToFront(); // Trazer para frente
          this.log('Usando aba do cnetmobile já logada!');
        } else {
          // Verificar onde estamos após login e navegar para área de licitações
          const urlAtual = this.page.url();
          this.log(`URL após login: ${urlAtual}`);

          // Se já está no cnetmobile na aba atual, ótimo!
          if (urlAtual.includes('cnetmobile.estaleiro.serpro.gov.br') && !urlAtual.includes('acesso-nao-autorizado')) {
            this.log('✅ Já está no cnetmobile com sessão válida!');
          }
          // Precisa navegar para o cnetmobile via menu "Compras"
          this.log('Navegando para área de licitações...');

          try {
            // Se está em compras.gov.br ou comprasnet.gov.br, procurar menu "Compras"
            await new Promise(r => setTimeout(r, 2000));

            const currentUrl = this.page.url();
            this.log(`URL atual para navegação: ${currentUrl}`);

            // A página intro.htm usa frames - verificar se há frames
            const frames = this.page.frames();
            this.log(`Número de frames na página: ${frames.length}`);

            // Listar todos os frames para debug
            for (let i = 0; i < frames.length; i++) {
              const frame = frames[i];
              const frameUrl = frame.url();
              this.log(`Frame ${i}: ${frameUrl.substring(0, 80)}`);
            }

            // Procurar menu "Compras" e fazer hover para abrir submenu
            this.log('Procurando menu "Compras" na barra de navegação...');

            // Usar evaluate para encontrar o elemento por texto (funciona no Puppeteer)
            let menuEncontrado = false;
            let navegouParaCnetmobile = false;

            // Tentar em cada frame
            for (const frame of frames) {
              try {
                const frameUrl = frame.url();

                // Listar todos os links no frame para debug
                const todosLinks = await frame.evaluate(() => {
                  return Array.from(document.querySelectorAll('a')).slice(0, 30).map(el => ({
                    text: (el.textContent || el.innerText || '').trim().substring(0, 50),
                    href: (el.href || '').substring(0, 80),
                    className: el.className || ''
                  }));
                });

                if (todosLinks.length > 0) {
                  this.log(`Frame ${frameUrl.substring(0, 50)}: ${todosLinks.length} links encontrados`);
                }

                // Procurar link direto para "Licitação e Dispensa (novo)" ou cnetmobile
                const linkDireto = await frame.evaluate(() => {
                  const links = Array.from(document.querySelectorAll('a'));
                  for (const el of links) {
                    const texto = (el.textContent || el.innerText || '').trim();
                    const textoLower = texto.toLowerCase();
                    const href = el.href || '';

                    // Procurar "Licitação e Dispensa (novo)" diretamente
                    if ((textoLower.includes('licitação') || textoLower.includes('licita')) &&
                        textoLower.includes('novo')) {
                      return { found: true, text: texto, href: href, type: 'submenu' };
                    }

                    // Procurar link para cnetmobile
                    if (href.includes('cnetmobile') || href.includes('comprasnet-web/seguro')) {
                      return { found: true, text: texto, href: href, type: 'cnetmobile' };
                    }
                  }
                  return { found: false };
                });

                if (linkDireto.found) {
                  this.log(`Link direto encontrado: "${linkDireto.text}" (${linkDireto.type}) -> ${linkDireto.href}`);

                  // Clicar no link usando evaluate
                  await frame.evaluate((texto) => {
                    const links = Array.from(document.querySelectorAll('a'));
                    for (const el of links) {
                      const t = (el.textContent || el.innerText || '').trim();
                      if (t === texto || t.includes(texto.substring(0, 20))) {
                        el.click();
                        return true;
                      }
                    }
                    return false;
                  }, linkDireto.text);

                  await new Promise(r => setTimeout(r, 5000));
                  navegouParaCnetmobile = true;
                  menuEncontrado = true;
                  break;
                }

                // Se não encontrou link direto, tentar hover no menu "Compras"
                // Usando JavaScript para disparar eventos de mouse diretamente
                const menuResult = await frame.evaluate(() => {
                  const elementos = Array.from(document.querySelectorAll('a, span, div, li, td'));
                  for (const el of elementos) {
                    const texto = (el.textContent || el.innerText || '').trim();
                    if (texto.toLowerCase() === 'compras' || texto === 'Compras') {
                      // Logar informações do elemento
                      const info = {
                        tag: el.tagName,
                        text: texto,
                        hasOnmouseover: !!el.onmouseover,
                        hasOnclick: !!el.onclick,
                        className: el.className,
                        id: el.id,
                        parentTag: el.parentElement ? el.parentElement.tagName : 'none'
                      };

                      // Disparar eventos de mouse
                      const mouseEnter = new MouseEvent('mouseenter', { bubbles: true, cancelable: true });
                      const mouseOver = new MouseEvent('mouseover', { bubbles: true, cancelable: true });
                      el.dispatchEvent(mouseEnter);
                      el.dispatchEvent(mouseOver);

                      // Também tentar trigger de onmouseover se existir
                      if (el.onmouseover) {
                        el.onmouseover();
                      }

                      return { found: true, info };
                    }
                  }
                  return { found: false };
                });

                if (menuResult.found) {
                  this.log(`Menu "Compras" encontrado: ${JSON.stringify(menuResult.info)}`);
                  this.log('Eventos de mouse disparados, aguardando submenu...');
                  await new Promise(r => setTimeout(r, 2500)); // Aguardar submenu abrir

                  menuEncontrado = true;

                  // Verificar se há submenus visíveis agora
                  const submenu = await frame.evaluate(() => {
                    // Procurar elementos que possam ser submenus (geralmente ul, div com display diferente de none)
                    const todosElementos = Array.from(document.querySelectorAll('a, li, span, div'));
                    const resultados = [];
                    for (const el of todosElementos) {
                      const texto = (el.textContent || el.innerText || '').trim();
                      const textoLower = texto.toLowerCase();

                      // Procurar "Licitação e Dispensa (novo)" ou variações
                      if ((textoLower.includes('licitação') || textoLower.includes('licita')) &&
                          textoLower.includes('novo')) {
                        const style = window.getComputedStyle(el);
                        resultados.push({
                          text: texto,
                          href: el.href || '',
                          visible: style.display !== 'none' && style.visibility !== 'hidden',
                          tag: el.tagName
                        });
                      }
                      // Também procurar "Dispensa" apenas
                      if (textoLower.includes('dispensa') && el.href) {
                        resultados.push({
                          text: texto,
                          href: el.href || '',
                          visible: true,
                          tag: el.tagName
                        });
                      }
                    }
                    return resultados;
                  });

                  this.log(`Itens encontrados após hover: ${JSON.stringify(submenu)}`);

                  // Procurar pelo item correto
                  const itemLicitacao = submenu.find(s =>
                    s.text.toLowerCase().includes('novo') &&
                    (s.text.toLowerCase().includes('licitação') || s.text.toLowerCase().includes('licita'))
                  );

                  if (itemLicitacao) {
                    this.log(`Submenu encontrado: ${itemLicitacao.text} -> ${itemLicitacao.href}`);

                    // Se tiver href, navegar diretamente
                    if (itemLicitacao.href && itemLicitacao.href.startsWith('http')) {
                      await this.page.goto(itemLicitacao.href, { waitUntil: 'networkidle2', timeout: 30000 });
                      navegouParaCnetmobile = true;
                    } else {
                      // Clicar no elemento
                      await frame.evaluate((texto) => {
                        const links = Array.from(document.querySelectorAll('a'));
                        for (const el of links) {
                          const t = (el.textContent || el.innerText || '').trim();
                          if (t.toLowerCase().includes('licitação') && t.toLowerCase().includes('novo')) {
                            el.click();
                            return true;
                          }
                        }
                        return false;
                      }, itemLicitacao.text);
                      await new Promise(r => setTimeout(r, 5000));
                      navegouParaCnetmobile = true;
                    }
                  } else {
                    this.log('Submenu "Licitação e Dispensa (novo)" não encontrado');

                    // Tentar clicar no próprio menu "Compras" para ver se abre algo
                    const clicouCompras = await frame.evaluate(() => {
                      const elementos = Array.from(document.querySelectorAll('a, span, div'));
                      for (const el of elementos) {
                        const texto = (el.textContent || el.innerText || '').trim();
                        if (texto.toLowerCase() === 'compras') {
                          el.click();
                          return true;
                        }
                      }
                      return false;
                    });
                    if (clicouCompras) {
                      this.log('Clicou no menu "Compras"');
                      await new Promise(r => setTimeout(r, 3000));
                    }
                  }
                }

                if (navegouParaCnetmobile) break;
              } catch (frameErr) {
                // Frame pode estar inacessível
                this.log(`Erro ao processar frame: ${frameErr.message}`);
              }
            }

            // Se não conseguiu navegar via menu nos frames, tentar clicar na aba "Compras" na página principal
            // O fluxo correto (conforme evidências): após login, área do fornecedor tem abas no topo
            // Clicar na aba "Compras" leva ao cnetmobile
            if (!navegouParaCnetmobile) {
              this.log('Tentando clicar na aba "Compras" na página principal...');

              try {
                // Na área do fornecedor (tela verde), procurar aba "Compras" e CLICAR (não hover)
                const clicouAbaCompras = await this.page.evaluate(() => {
                  // Procurar em toda a página por link/aba "Compras"
                  const elementos = Array.from(document.querySelectorAll('a, li, span, div, button'));
                  for (const el of elementos) {
                    const texto = (el.textContent || el.innerText || '').trim();
                    // Procurar aba "Compras" exata ou link que contenha "Compras"
                    if (texto === 'Compras' || texto.toLowerCase() === 'compras') {
                      el.click();
                      return { clicked: true, text: texto, tag: el.tagName };
                    }
                  }
                  // Também tentar por href que contenha cnetmobile
                  const links = Array.from(document.querySelectorAll('a'));
                  for (const el of links) {
                    const href = el.href || '';
                    if (href.includes('cnetmobile') || href.includes('comprasnet-web/seguro')) {
                      el.click();
                      return { clicked: true, href: href, tag: 'A' };
                    }
                  }
                  return { clicked: false };
                });

                if (clicouAbaCompras.clicked) {
                  this.log(`Clicou na aba/link: ${JSON.stringify(clicouAbaCompras)}`);
                  await new Promise(r => setTimeout(r, 5000));
                  navegouParaCnetmobile = true;
                } else {
                  this.log('Aba "Compras" não encontrada na página principal');
                }
              } catch (e) {
                this.log(`Erro ao clicar na aba Compras: ${e.message}`);
              }
            }

            if (!menuEncontrado && !navegouParaCnetmobile) {
              this.log('Menu "Compras" não encontrado, listando todos os links na página...');

              // Listar todos os links disponíveis para debug
              const todosLinks = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                return links.slice(0, 30).map(el => ({
                  text: (el.textContent || '').trim().substring(0, 40),
                  href: (el.href || '').substring(0, 80)
                }));
              });
              this.log(`Links disponíveis: ${JSON.stringify(todosLinks, null, 2)}`);

              // Tentar clicar em qualquer link para cnetmobile
              const clicouDireto = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                for (const el of links) {
                  const href = el.href || '';
                  if (href.includes('cnetmobile') || href.includes('comprasnet-web/seguro')) {
                    el.click();
                    return { clicked: true, href: href };
                  }
                }
                return { clicked: false };
              });

              if (clicouDireto.clicked) {
                this.log(`Clicou em link direto: ${clicouDireto.href}`);
                await new Promise(r => setTimeout(r, 5000));
              }
            }

            await new Promise(r => setTimeout(r, 3000));
            const urlFinal = this.page.url();
            this.log(`URL após navegação: ${urlFinal}`);

            if (urlFinal.includes('cnetmobile') && !urlFinal.includes('acesso-nao-autorizado')) {
              this.log('✅ Navegou para cnetmobile com sucesso!');
            } else if (urlFinal.includes('acesso-nao-autorizado')) {
              this.log('⚠️ Sessão não transferida - acesso não autorizado');
            } else {
              // Se ainda não chegou no cnetmobile, verificar se há link na página atual
              this.log('Verificando links disponíveis na página atual...');
              const linksDisponiveis = await this.page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                return links.slice(0, 20).map(el => ({
                  text: (el.textContent || '').trim().substring(0, 50),
                  href: (el.href || '').substring(0, 80)
                }));
              });
              this.log('Primeiros 20 links: ' + JSON.stringify(linksDisponiveis, null, 2));
            }
          } catch (e) {
            this.log('Erro ao navegar para área de licitações: ' + e.message);
          }
        }

        return;
      }

      this.log('Acessando Comprasnet para iniciar fluxo de autenticação...');

      // Acessar página principal do Comprasnet (área segura) para iniciar o fluxo de SSO
      try {
        await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras', { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (e) {
        this.log('Aguardando carregamento inicial...');
      }
      await new Promise(r => setTimeout(r, 3000));

      // Verificar se foi redirecionado para login ou se já está logado
      let urlAtual = this.page.url();
      this.log(`URL após acessar Comprasnet: ${urlAtual}`);

      // Procurar botão de login no Comprasnet
      let precisaLogin = false;
      try {
        const btnEntrar = await this.page.$('a[href*="login"], button:has-text("Entrar"), button:has-text("Login"), a:has-text("Entrar"), a:has-text("gov.br")');
        if (btnEntrar) {
          precisaLogin = true;
          await btnEntrar.click();
          this.log('Clicou no botão de login do Comprasnet');
          await new Promise(r => setTimeout(r, 5000));
        }
      } catch (e) {
        // Tentar clicar em qualquer link de login
        try {
          const links = await this.page.$$('a');
          for (const link of links) {
            const texto = await link.evaluate(el => el.innerText?.toLowerCase() || '');
            const href = await link.evaluate(el => el.href?.toLowerCase() || '');
            if (texto.includes('entrar') || texto.includes('login') || texto.includes('gov.br') || href.includes('login')) {
              await link.click();
              this.log('Clicou no link de login');
              precisaLogin = true;
              await new Promise(r => setTimeout(r, 5000));
              break;
            }
          }
        } catch (e2) {}
      }

      // Verificar se foi redirecionado para gov.br
      urlAtual = this.page.url();
      if (!urlAtual.includes('acesso.gov.br') && !urlAtual.includes('sso')) {
        // Tentar acessar área segura para forçar redirect
        this.log('Acessando área segura para iniciar SSO...');
        await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 5000));
        urlAtual = this.page.url();
      }

      this.log(`URL atual: ${urlAtual}`);

      // Verificar se estamos na página de login do gov.br
      if (!urlAtual.includes('acesso.gov.br') && !urlAtual.includes('sso')) {
        // Se não redirecionou, tentar ir direto mas com client_id do Comprasnet
        this.log('Acessando SSO gov.br via Comprasnet...');
        await this.page.goto('https://sso.acesso.gov.br/login?client_id=portal-logado.estaleiro.serpro.gov.br', { waitUntil: 'domcontentloaded', timeout: 120000 });
        await new Promise(r => setTimeout(r, 3000));
      }

      try {
        await this.page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });
      } catch (e) {
        this.log('Aguardando carregamento da página...');
      }

      // Se usar certificado, clicar na opção de certificado digital
      if (this.usarCertificado) {
        this.log('Procurando opção de login com certificado digital...');
        await new Promise(r => setTimeout(r, 2000));

        // Procurar link/botão de certificado digital
        let certLink = null;
        try {
          const links = await this.page.$$('a, button, div[role="button"]');
          for (const link of links) {
            const texto = await link.evaluate(el => el.innerText.toLowerCase());
            if (texto.includes('certificado') || texto.includes('digital')) {
              certLink = link;
              this.log('Link de certificado encontrado');
              break;
            }
          }
        } catch (e) {}

        if (certLink) {
          await certLink.click();
          this.log('Clicou no login com certificado digital');

          // Aguardar popup de seleção de certificado (pode levar até 30s)
          this.log('Aguardando seleção de certificado pelo Windows...');
          await new Promise(r => setTimeout(r, 10000));

          // Verificar se foi redirecionado para página de certificado
          const urlAposCert = this.page.url();
          this.log(`URL após certificado: ${urlAposCert}`);

          // Aguardar redirecionamento após seleção do certificado
          try {
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 });
          } catch (e) {
            this.log('Timeout aguardando navegação após certificado');
          }
          await new Promise(r => setTimeout(r, 5000));

          // Verificar se login foi bem sucedido (deve redirecionar de volta ao Comprasnet)
          const urlFinal = this.page.url();
          this.log(`URL final: ${urlFinal}`);

          if (urlFinal.includes('comprasnet') || urlFinal.includes('cnetmobile')) {
            this.log('Login com certificado realizado com sucesso!');
            return;
          }

          if (!urlFinal.includes('login') && !urlFinal.includes('acesso.gov.br/login')) {
            this.log('Redirecionado - verificando login...');
            await new Promise(r => setTimeout(r, 3000));
            const urlVerificacao = this.page.url();
            if (urlVerificacao.includes('comprasnet') || urlVerificacao.includes('cnetmobile')) {
              this.log('Login com certificado realizado com sucesso!');
              return;
            }
          }

          this.log('Login com certificado pode ter falhado, tentando CPF/senha...');
        } else {
          this.log('Link de certificado não encontrado, usando CPF/senha...');
        }
      }

      // Login com CPF/senha (fallback ou método principal)
      if (!this.cpf || !this.senhaGovbr) {
        throw new Error('Credenciais CPF/senha não disponíveis');
      }

      this.log('Fazendo login com CPF/senha...');

      // Verificar se estamos na página de login, senão navegar para ela mantendo o client_id
      urlAtual = this.page.url();
      if (!urlAtual.includes('acesso.gov.br')) {
        await this.page.goto('https://sso.acesso.gov.br/login?client_id=portal-logado.estaleiro.serpro.gov.br', { waitUntil: 'networkidle2', timeout: 120000 });
        await new Promise(r => setTimeout(r, 5000));
      }

      // Preencher CPF
      this.log('Preenchendo CPF...');
      let cpfInput = null;
      for (let i = 0; i < 10; i++) {
        cpfInput = await this.page.$('input[name="accountId"]') || await this.page.$('input[type="text"]');
        if (cpfInput) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!cpfInput) throw new Error('Campo CPF não encontrado');

      await cpfInput.click();
      await cpfInput.type(this.cpf.replace(/\D/g, ''), { delay: 50 });

      // Clicar em continuar
      await new Promise(r => setTimeout(r, 500));
      const btnContinuar = await this.page.$('button[type="submit"]');
      if (btnContinuar) await btnContinuar.click();
      else await this.page.keyboard.press('Enter');

      // Aguardar navegação após clicar em continuar
      this.log('Aguardando transição para tela de senha...');
      try {
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      } catch (e) {
        // Pode ser SPA sem navegação real
      }
      await new Promise(r => setTimeout(r, 5000));

      // Preencher senha
      this.log('Preenchendo senha...');
      let senhaInput = null;
      for (let i = 0; i < 30; i++) {
        senhaInput = await this.page.$('input[name="password"]') || await this.page.$('input[type="password"]');
        if (senhaInput) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!senhaInput) {
        const pageText = await this.page.evaluate(() => document.body.innerText);
        if (pageText.includes('código') || pageText.includes('verificação')) {
          throw new Error('Login requer verificação por código. Faça login manualmente primeiro.');
        }
        throw new Error('Campo de senha não encontrado');
      }

      await senhaInput.click();
      await senhaInput.type(this.senhaGovbr, { delay: 50 });

      // Clicar em entrar
      await new Promise(r => setTimeout(r, 500));
      const btnLogin = await this.page.$('button[type="submit"]');
      if (btnLogin) await btnLogin.click();
      else await this.page.keyboard.press('Enter');

      this.log('Aguardando login...');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 3000));

      // Verificar se login foi bem sucedido
      let url = this.page.url();
      if (url.includes('login') || url.includes('acesso.gov.br/login')) {
        const content = await this.page.content();
        if (content.includes('incorret') || content.includes('inválid')) {
          throw new Error('CPF ou senha incorretos');
        }
      }

      this.log(`URL após login: ${url}`);

      // Verificar se foi redirecionado para página de recuperação (redirecionamento incorreto)
      if (url.includes('recupera') || url.includes('validacao-facial')) {
        this.log('⚠️ Redirecionamento incorreto para página de recuperação detectado!');
        this.log('Tentando contornar voltando para área do Comprasnet...');

        // Limpar cookies do gov.br e tentar novamente
        try {
          // Navegar diretamente para o Comprasnet ignorando o redirect incorreto
          await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/', { waitUntil: 'networkidle2', timeout: 60000 });
          await new Promise(r => setTimeout(r, 5000));

          url = this.page.url();
          this.log(`URL após contorno: ${url}`);

          // Se ainda está no login ou recuperação, tentar fluxo alternativo
          if (url.includes('acesso.gov.br') || url.includes('recupera')) {
            this.log('Tentando fluxo de login alternativo via portal Compras.gov.br...');

            // Ir para página pública e clicar em entrar
            await this.page.goto('https://www.gov.br/compras/pt-br', { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 3000));

            // Procurar link de login
            const loginLinks = await this.page.$$('a');
            for (const link of loginLinks) {
              const href = await link.evaluate(el => el.href || '');
              const texto = await link.evaluate(el => el.innerText?.toLowerCase() || '');
              if (texto.includes('entrar') || texto.includes('acesse') || href.includes('login')) {
                await link.click();
                this.log('Clicou em entrar no portal Compras.gov.br');
                await new Promise(r => setTimeout(r, 5000));
                break;
              }
            }

            url = this.page.url();
            this.log(`URL após fluxo alternativo: ${url}`);
          }
        } catch (e) {
          this.log('Erro no contorno: ' + e.message);
        }
      }

      // Verificar se foi redirecionado de volta ao Comprasnet
      if (!url.includes('comprasnet') && !url.includes('cnetmobile')) {
        // Tentar navegar para área segura do Comprasnet
        this.log('Navegando para área segura do Comprasnet...');
        await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 5000));

        url = this.page.url();
        this.log(`URL após redirecionamento: ${url}`);

        // Verificar se ainda precisa autenticar
        if (url.includes('acesso.gov.br') || url.includes('sso')) {
          this.log('Ainda na página de login - sessão pode não ter sido estabelecida corretamente');
          // Tentar aguardar mais um pouco por navegação
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          url = this.page.url();
        }
      }

      // Verificar se chegou ao Comprasnet com sucesso
      if (url.includes('acesso-nao-autorizado')) {
        throw new Error('Acesso não autorizado. Verifique suas credenciais e permissões.');
      }

      this.log('Login realizado com sucesso!');
    }

    async carregarParticipacoes() {
      // Buscar licitações AUTOMATICAMENTE da página de participações do cnetmobile
      this.log('Buscando participações automaticamente do Comprasnet...');

      // Buscar CNPJ do fornecedor
      const cnpjFornecedor = getConfigValue('cnpj');
      this.cnpjFornecedor = cnpjFornecedor ? cnpjFornecedor.replace(/\D/g, '') : null;

      if (this.cnpjFornecedor) {
        this.log(`CNPJ do fornecedor: ${this.cnpjFornecedor}`);
      }

      // Navegar para a página de participações
      const urlParticipacoes = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';

      try {
        // SEMPRE navegar para a página de participações para garantir
        const urlAtual = this.page.url();
        this.log(`URL atual: ${urlAtual}`);

        this.log('Navegando para página de participações...');
        await this.page.goto(urlParticipacoes, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));

        // Garantir que estamos na aba "Minhas participações"
        await this.page.evaluate(() => {
          const abas = document.querySelectorAll('.p-tabview-nav-link');
          for (const aba of abas) {
            if (aba.textContent?.includes('Minhas participações')) {
              aba.click();
              break;
            }
          }
        });
        await new Promise(r => setTimeout(r, 2000));

        // Extrair todas as licitações da página (baseado nos botões de acompanhar)
        const participacoes = await this.page.evaluate(() => {
          const licitacoes = [];
          const jaAdicionadas = new Set();

          // Encontrar todos os botões de acompanhar (visíveis)
          const botoes = Array.from(document.querySelectorAll('[aria-label*="Participar"], [aria-label*="acompanhar"]'))
            .filter(b => b.offsetParent !== null);

          botoes.forEach((btn, index) => {
            // Subir na árvore DOM para encontrar o card pai
            let card = btn.closest('[class*="card"]') || btn.closest('[class*="ng-star-inserted"]') || btn.parentElement?.parentElement?.parentElement;
            if (!card) return;

            const texto = card.innerText || '';

            // Verificar se parece ser um card de licitação (tem número de dispensa/pregão)
            const matchNumero = texto.match(/(PREGÃO|DISPENSA|CONCORRÊNCIA|COTAÇÃO)[^0-9]*N[°º]?\s*(\d+)\/(\d{4})/i);
            const matchOrgao = texto.match(/(\d{6})\s*-\s*([A-Z\s]+)/);
            const matchEtapa = texto.match(/Etapa:\s*([^\n]+)/i);

            if (matchNumero) {
              // Criar chave única para evitar duplicatas
              const chave = `${matchNumero[1]}_${matchNumero[2]}_${matchNumero[3]}_${matchOrgao ? matchOrgao[1] : ''}`;

              if (!jaAdicionadas.has(chave)) {
                jaAdicionadas.add(chave);
                licitacoes.push({
                  tipo: matchNumero[1],
                  numero: matchNumero[2],
                  ano: matchNumero[3],
                  orgao: matchOrgao ? matchOrgao[2].trim() : '',
                  uasg: matchOrgao ? matchOrgao[1] : '',
                  etapa: matchEtapa ? matchEtapa[1].trim() : '',
                  indiceBotao: index // Índice do botão para clicar
                });
              }
            }
          });

          return licitacoes;
        });

        this.log(`Encontradas ${participacoes.length} licitações nas participações`);

        // Salvar as participações
        this.participacoes = participacoes;

        // Log das licitações encontradas
        participacoes.forEach((p, i) => {
          this.log(`  ${i + 1}. ${p.tipo} ${p.numero}/${p.ano} - ${p.orgao} (${p.etapa})`);
        });

        return participacoes;

      } catch (error) {
        this.log(`Erro ao carregar participações: ${error.message}`);
        this.participacoes = [];
        return [];
      }
    }

    async irParaMensagens() {
      // Carregar participações automaticamente da página
      await this.carregarParticipacoes();

      if (this.participacoes.length === 0) {
        this.log('Nenhuma licitação encontrada nas participações');
        this.log('Verifique se você está logado e tem participações ativas');
      } else {
        this.log(`Pronto para monitorar ${this.participacoes.length} licitações`);
      }

      this.log('Navegação inicial concluída');
    }

    async acessarLicitacaoPorIndice(indice) {
      // SEMPRE navegar para a página de participações primeiro
      this.log(`Voltando para lista de participações...`);
      await this.page.goto('https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras', { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(r => setTimeout(r, 2000));

      // Garantir que estamos na aba "Minhas participações"
      await this.page.evaluate(() => {
        const abas = document.querySelectorAll('.p-tabview-nav-link');
        for (const aba of abas) {
          if (aba.textContent?.includes('Minhas participações')) {
            aba.click();
            break;
          }
        }
      });
      await new Promise(r => setTimeout(r, 1000));

      // Clicar no botão de acompanhar da licitação no índice especificado
      const clicou = await this.page.evaluate((idx) => {
        // Encontrar todos os botões de acompanhar (visíveis)
        const botoes = Array.from(document.querySelectorAll('[aria-label*="Participar"], [aria-label*="acompanhar"]'))
          .filter(b => b.offsetParent !== null); // Só visíveis

        if (botoes[idx]) {
          botoes[idx].click();
          return { success: true, total: botoes.length };
        }
        return { success: false, total: botoes.length };
      }, indice);

      if (clicou.success) {
        await new Promise(r => setTimeout(r, 3000));
        this.log(`Acessou licitação ${indice + 1} de ${clicou.total}`);
        return true;
      } else {
        this.log(`Não foi possível clicar na licitação ${indice + 1} (${clicou.total} disponíveis)`);
        return false;
      }
    }

    construirUrlAcompanhamento(participacao) {
      // Se já tem URL cadastrada, usar diretamente
      if (participacao.urlCompra) {
        return participacao.urlCompra;
      }

      // URL do acompanhamento: https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=CNPJ+SEQUENCIAL+ANO
      const cnpj = participacao.cnpjOrgao.replace(/\D/g, '');
      const sequencial = participacao.sequencial.toString().padStart(5, '0');
      const ano = participacao.ano.toString();
      const compraId = `${cnpj}${sequencial}${ano}`;
      return `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compraId}`;
    }

    // Classifica a prioridade da licitação baseada na etapa
    getPrioridade(etapa) {
      if (!etapa) return 2; // Média se não tem etapa
      const etapaLower = etapa.toLowerCase();

      // ALTA PRIORIDADE (verificar sempre) - etapas críticas de julgamento
      const altaPrioridade = [
        'seleção de fornecedores', 'selecao de fornecedores', 'seleção', 'selecao',
        'disputa', 'lance', 'lances',
        'análise', 'analise', 'julgamento',
        'negociação', 'negociacao',
        'habilitação', 'habilitacao',
        'envio de proposta', 'proposta',
        'em andamento', 'aberta'
      ];

      // BAIXA PRIORIDADE (verificar menos) - etapas finalizadas ou iniciais
      const baixaPrioridade = [
        'encerrada', 'encerrado', 'finalizada', 'finalizado',
        'homologada', 'homologado', 'adjudicada', 'adjudicado',
        'cancelada', 'cancelado', 'suspensa', 'suspenso',
        'deserta', 'fracassada', 'revogada', 'anulada',
        'publicada', 'agendada'
      ];

      for (const termo of altaPrioridade) {
        if (etapaLower.includes(termo)) return 1; // Alta
      }

      for (const termo of baixaPrioridade) {
        if (etapaLower.includes(termo)) return 3; // Baixa
      }

      return 2; // Média
    }

    iniciarVerificacao() {
      // Controle de priorização
      this.indiceAtual = 0;
      this.cicloAtual = 0;
      this.ultimasVerificacoes = new Map(); // Rastreia última verificação de cada licitação

      // Verificar mensagens a cada 20 segundos (reduzido de 30)
      this.intervalo = setInterval(async () => {
        if (!this.ativo) return;

        try {
          await this.verificarMensagensLicitacao();
        } catch (error) {
          this.log('Erro na verificação: ' + error.message);
        }
      }, 20000);

      // Fazer primeira verificação imediatamente
      this.verificarMensagensLicitacao();
    }

    // Seleciona a próxima licitação baseada em prioridade
    selecionarProximaLicitacao() {
      if (!this.participacoes || this.participacoes.length === 0) return null;

      const agora = Date.now();

      // Configuração de intervalos mínimos por prioridade (em ms)
      const intervalos = {
        1: 20000,   // Alta: verificar a cada ciclo (~20s)
        2: 60000,   // Média: verificar a cada 3 ciclos (~1min)
        3: 180000   // Baixa: verificar a cada 9 ciclos (~3min)
      };

      // Ordenar por prioridade e tempo desde última verificação
      const candidatas = this.participacoes.map((p, idx) => {
        const prioridade = this.getPrioridade(p.etapa);
        const ultimaVerif = this.ultimasVerificacoes.get(idx) || 0;
        const tempoDesde = agora - ultimaVerif;
        const intervaloMinimo = intervalos[prioridade];
        const prontoParaVerificar = tempoDesde >= intervaloMinimo;

        return {
          participacao: p,
          indice: idx,
          prioridade,
          tempoDesde,
          prontoParaVerificar,
          // Score: prioridade baixa = melhor, tempo desde último = melhor
          score: prontoParaVerificar ? (prioridade * 1000 - tempoDesde) : Infinity
        };
      });

      // Filtrar apenas as prontas para verificar e ordenar por score
      const prontas = candidatas
        .filter(c => c.prontoParaVerificar)
        .sort((a, b) => a.score - b.score);

      if (prontas.length > 0) {
        const escolhida = prontas[0];
        this.log(`[Prioridade ${escolhida.prioridade}] ${escolhida.participacao.tipo} ${escolhida.participacao.numero}/${escolhida.participacao.ano} - ${escolhida.participacao.etapa || 'sem etapa'}`);
        return escolhida;
      }

      // Se nenhuma está pronta, pegar a de maior prioridade
      candidatas.sort((a, b) => a.prioridade - b.prioridade || b.tempoDesde - a.tempoDesde);
      return candidatas[0];
    }

    async verificarMensagensLicitacao() {
      try {
        this.ultimaVerificacao = new Date();
        this.cicloAtual++;

        // Recarregar participações a cada 20 ciclos (~6-7 minutos)
        if (!this.participacoes || this.participacoes.length === 0 || this.cicloAtual % 20 === 1) {
          await this.carregarParticipacoes();
          if (this.participacoes.length === 0) {
            this.log('Nenhuma participação encontrada - aguardando próximo ciclo');
            return;
          }
        }

        // Selecionar licitação baseada em prioridade
        const selecionada = this.selecionarProximaLicitacao();
        if (!selecionada) {
          this.log('Nenhuma licitação para verificar neste ciclo');
          return;
        }

        // Atualizar última verificação
        this.ultimasVerificacoes.set(selecionada.indice, Date.now());
        this.indiceAtual = selecionada.indice;

        // Pegar licitação atual
        const participacao = selecionada.participacao;

        this.log(`Verificando licitação ${this.indiceAtual + 1}/${this.participacoes.length}: ${participacao.tipo} ${participacao.numero}/${participacao.ano} - ${participacao.orgao}`);

        // Acessar a licitação clicando no botão (usando indiceBotao se disponível)
        const indiceBotao = participacao.indiceBotao !== undefined ? participacao.indiceBotao : this.indiceAtual;
        const acessou = await this.acessarLicitacaoPorIndice(indiceBotao);

        if (!acessou) {
          this.log('Não foi possível acessar a licitação - tentando próxima');
          this.indiceAtual = (this.indiceAtual + 1) % this.participacoes.length;
          return;
        }

        // Verificar se sessão expirou
        const urlAtual = this.page.url();
        if (urlAtual.includes('acesso-nao-autorizado') || urlAtual.includes('login')) {
          this.log('Sessão expirada - tentando re-autenticar...');

          // Tentar refazer login
          try {
            await this.fazerLogin();
            // Voltar para a licitação
            await this.acessarLicitacaoPorIndice(this.indiceAtual);

            const urlAposRelogin = this.page.url();
            if (urlAposRelogin.includes('acesso-nao-autorizado')) {
              this.log('Falha ao re-autenticar - parando monitoramento');
              await this.parar();
              await enviarTelegram('🔴 <b>Monitor Parado</b>\n\nSessão expirou e não foi possível re-autenticar. Reinicie o monitor manualmente.');
              return;
            }
          } catch (e) {
            this.log('Erro ao re-autenticar: ' + e.message);
            return;
          }
        }

        // Buscar mensagens do chat na página
        await this.extrairMensagensChat(participacao);

        // Avançar para próxima licitação (circular)
        this.indiceAtual = (this.indiceAtual + 1) % this.participacoes.length;

      } catch (error) {
        this.log('Erro ao verificar licitação: ' + error.message);
        // Avançar mesmo com erro
        this.indiceAtual = (this.indiceAtual + 1) % Math.max(1, this.participacoes.length);
      }
    }

    // Gera chave única para a licitação
    getChaveLicitacao(participacao) {
      return `${participacao.uasg || ''}_${participacao.tipo || ''}_${participacao.numero || ''}_${participacao.ano || ''}`;
    }

    // Verifica se há mensagens mais recentes no portal
    async verificarMensagemMaisRecente(participacao) {
      try {
        // Buscar última verificação do banco
        const chave = this.getChaveLicitacao(participacao);
        const ultimaVerif = db.prepare('SELECT ultimaDataHoraMensagem, totalMensagens FROM chat_ultima_verificacao WHERE chave = ?').get(chave);

        // Capturar rapidamente a última mensagem visível na página
        const infoMensagens = await this.page.evaluate(() => {
          const mensagens = document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="msg-"], .p-card, [class*="comunicado"]');
          if (mensagens.length === 0) return { total: 0, ultimaData: null };

          const ultimaMensagem = mensagens[mensagens.length - 1] || mensagens[0];
          const textoData = ultimaMensagem.innerText || '';
          const matchData = textoData.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}|\d{2}:\d{2}\s+\d{2}\/\d{2}\/\d{4})/);

          return {
            total: mensagens.length,
            ultimaData: matchData ? matchData[1] : null,
            textoPreview: textoData.substring(0, 100)
          };
        });

        // Se não tem registro anterior, precisa sincronizar
        if (!ultimaVerif) {
          this.log(`[NOVA] Licitação sem histórico - sincronizando...`);
          return { precisaSincronizar: true, motivo: 'sem_historico' };
        }

        // Comparar quantidade de mensagens
        if (infoMensagens.total > (ultimaVerif.totalMensagens || 0)) {
          this.log(`[ATUALIZAR] Novas mensagens detectadas: ${infoMensagens.total} vs ${ultimaVerif.totalMensagens} salvas`);
          return { precisaSincronizar: true, motivo: 'novas_mensagens', novas: infoMensagens.total - (ultimaVerif.totalMensagens || 0) };
        }

        // Comparar data/hora se disponível
        if (infoMensagens.ultimaData && ultimaVerif.ultimaDataHoraMensagem) {
          if (infoMensagens.ultimaData !== ultimaVerif.ultimaDataHoraMensagem) {
            this.log(`[ATUALIZAR] Data diferente: ${infoMensagens.ultimaData} vs ${ultimaVerif.ultimaDataHoraMensagem}`);
            return { precisaSincronizar: true, motivo: 'data_diferente' };
          }
        }

        // Sem mudanças detectadas
        this.log(`[SKIP] Sem novas mensagens - pulando extração completa`);
        return { precisaSincronizar: false, motivo: 'sem_mudancas' };

      } catch (error) {
        this.log(`Erro na verificação rápida: ${error.message} - sincronizando por segurança`);
        return { precisaSincronizar: true, motivo: 'erro' };
      }
    }

    // Atualiza registro de última verificação
    atualizarUltimaVerificacao(participacao, ultimaDataHora, totalMensagens, ultimoHash) {
      const chave = this.getChaveLicitacao(participacao);
      try {
        db.prepare(`
          INSERT INTO chat_ultima_verificacao (chave, ultimaDataHoraMensagem, ultimoHashMensagem, totalMensagens, dataVerificacao)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(chave) DO UPDATE SET
            ultimaDataHoraMensagem = excluded.ultimaDataHoraMensagem,
            ultimoHashMensagem = excluded.ultimoHashMensagem,
            totalMensagens = excluded.totalMensagens,
            dataVerificacao = CURRENT_TIMESTAMP
        `).run(chave, ultimaDataHora, ultimoHash, totalMensagens);
      } catch (e) {
        this.log(`Erro ao atualizar última verificação: ${e.message}`);
      }
    }

    async extrairMensagensChat(participacao) {
      try {
        const crypto = require('crypto');

        // OTIMIZAÇÃO: Verificar se há mensagens novas antes de extrair tudo
        const verificacao = await this.verificarMensagemMaisRecente(participacao);
        if (!verificacao.precisaSincronizar) {
          return; // Pula extração completa - sem mensagens novas
        }

        this.log(`Extraindo mensagens do chat (motivo: ${verificacao.motivo})...`);

        // Primeiro, clicar no ícone de envelope/chat para abrir o painel de mensagens
        try {
          this.log('Procurando ícone de chat/mensagens...');

          // Procurar e clicar no ícone de envelope/chat
          const chatAberto = await this.page.evaluate(() => {
            // Seletores para o ícone de chat/mensagens no Comprasnet
            const seletoresChat = [
              // Ícones Font Awesome
              '.fa-envelope',
              '.fa-comments',
              '.fa-comment',
              '.fa-comment-alt',
              '.fa-message',
              // Ícones Material
              '.material-icons:contains("chat")',
              '.material-icons:contains("mail")',
              // PrimeNG icons
              '.pi-envelope',
              '.pi-comments',
              // Botões com texto
              'button[title*="chat" i]',
              'button[title*="mensagem" i]',
              'button[title*="message" i]',
              'button[aria-label*="chat" i]',
              'button[aria-label*="mensagem" i]',
              // Links com ícones
              'a[title*="chat" i]',
              'a[title*="mensagem" i]',
              // Ícone com classe específica
              '[class*="chat-icon"]',
              '[class*="message-icon"]',
              '[class*="envelope"]',
              // Menu de ações
              '.p-menuitem-icon.fa-envelope',
              '.p-menuitem-icon.fa-comments',
              // Elementos com data-*
              '[data-action="chat"]',
              '[data-action="messages"]'
            ];

            for (const seletor of seletoresChat) {
              try {
                const elementos = document.querySelectorAll(seletor);
                for (const el of elementos) {
                  if (el && el.offsetParent !== null) { // Visível
                    el.click();
                    return { clicked: true, seletor };
                  }
                }
              } catch (e) {
                // Seletor inválido, tentar próximo
              }
            }

            // Tentar encontrar por texto do elemento pai
            const todosBotoes = document.querySelectorAll('button, a, span, i, div[role="button"]');
            for (const btn of todosBotoes) {
              const texto = (btn.innerText || btn.title || btn.getAttribute('aria-label') || '').toLowerCase();
              const classe = (btn.className || '').toLowerCase();

              if ((texto.includes('mensagem') || texto.includes('chat') || texto.includes('message') ||
                   classe.includes('envelope') || classe.includes('comment') || classe.includes('message')) &&
                  btn.offsetParent !== null) {
                btn.click();
                return { clicked: true, seletor: 'texto/classe encontrado' };
              }
            }

            // Verificar se já existe painel de chat aberto
            const painelChat = document.querySelector('[class*="chat-panel"], [class*="message-panel"], .p-sidebar, .p-dialog');
            if (painelChat && painelChat.offsetParent !== null) {
              return { clicked: false, jaAberto: true };
            }

            return { clicked: false };
          });

          if (chatAberto.clicked) {
            this.log(`Clicou no ícone de chat (${chatAberto.seletor}), aguardando painel...`);
            await new Promise(r => setTimeout(r, 2000));
          } else if (chatAberto.jaAberto) {
            this.log('Painel de chat já está aberto');
          } else {
            this.log('Ícone de chat não encontrado - tentando extrair da página atual');
          }
        } catch (e) {
          this.log('Erro ao abrir chat: ' + e.message);
        }

        // DEBUG: Capturar estrutura da página para encontrar os seletores corretos
        const estruturaPagina = await this.page.evaluate(() => {
          const debugInfo = {
            url: window.location.href,
            classes: [],
            divs: [],
            tables: [],
            textosSample: [],
            botoesEIcones: [],
            sidebars: []
          };

          // Pegar todas as classes únicas na página
          const allClasses = new Set();
          document.querySelectorAll('*').forEach(el => {
            if (el.classList) {
              el.classList.forEach(c => allClasses.add(c));
            }
          });
          debugInfo.classes = [...allClasses].slice(0, 100);

          // Helper para obter className de forma segura (SVG tem className como objeto)
          const getClassName = (el) => {
            try {
              if (!el || !el.className) return '';
              if (typeof el.className === 'string') return el.className;
              if (el.className && el.className.baseVal !== undefined) return el.className.baseVal; // SVGAnimatedString
              if (el.classList && el.classList.length > 0) return Array.from(el.classList).join(' ');
              return String(el.className || '');
            } catch (e) {
              return '';
            }
          };

          // Pegar TODOS os botões e ícones
          document.querySelectorAll('button, a, i, span[class*="icon"], span[class*="fa-"], [role="button"]').forEach(el => {
            if (el.offsetParent !== null) { // Só visíveis
              debugInfo.botoesEIcones.push({
                tag: el.tagName,
                classe: getClassName(el).substring(0, 80),
                texto: (el.innerText || '').substring(0, 50),
                title: el.title || '',
                ariaLabel: el.getAttribute('aria-label') || ''
              });
            }
          });
          debugInfo.botoesEIcones = debugInfo.botoesEIcones.slice(0, 50);

          // Pegar sidebars e painéis
          document.querySelectorAll('.p-sidebar, .p-dialog, [class*="panel"], [class*="sidebar"], [class*="drawer"]').forEach(el => {
            debugInfo.sidebars.push({
              classe: getClassName(el).substring(0, 80),
              visivel: el.offsetParent !== null,
              textoResumido: (el.innerText || '').substring(0, 200)
            });
          });

          // Pegar divs com texto relevante (possivelmente mensagens)
          document.querySelectorAll('div, span, p, td').forEach(el => {
            const texto = el.innerText?.trim();
            if (texto && texto.length > 20 && texto.length < 500 && !el.querySelector('div')) {
              // Elemento com texto que não contém outros divs (elemento folha)
              debugInfo.textosSample.push({
                tag: el.tagName,
                classe: getClassName(el).substring(0, 50),
                texto: texto.substring(0, 100)
              });
            }
          });
          debugInfo.textosSample = debugInfo.textosSample.slice(0, 20);

          // Procurar elementos específicos de chat
          const chatElements = document.querySelectorAll('[class*="chat"], [class*="mensagem"], [class*="message"], [class*="timeline"], [class*="historico"]');
          debugInfo.chatElementsCount = chatElements.length;

          return debugInfo;
        });

        // Salvar debug em arquivo para análise
        const fs = require('fs');
        fs.writeFileSync('C:/Users/User/pncp-licitacoes/debug-pagina.json', JSON.stringify(estruturaPagina, null, 2));
        this.log(`DEBUG: Estrutura salva em debug-pagina.json (${estruturaPagina.textosSample.length} textos encontrados)`);

        // Extrair mensagens do chat do Comprasnet
        const mensagensExtraidas = await this.page.evaluate(() => {
          const mensagens = [];

          // Seletores específicos do Comprasnet (baseado na estrutura típica)
          const seletores = [
            // Chat do pregão
            '.chat-container .mensagem',
            '.chat-box .message',
            '.mensagens-chat .item',
            // Timeline de eventos
            '.timeline .event',
            '.historico .item',
            // Tabela de mensagens
            'table tbody tr',
            // Genéricos
            '[class*="mensagem"]',
            '[class*="message"]',
            '.card-body',
            // Div com texto de chat
            '.chat-content div',
            '.messages div'
          ];

          // Tentar cada seletor
          for (const seletor of seletores) {
            const elementos = document.querySelectorAll(seletor);
            if (elementos.length > 0) {
              elementos.forEach(el => {
                const texto = el.innerText?.trim();
                if (texto && texto.length > 10 && texto.length < 5000) {
                  // Tentar extrair remetente e hora
                  let remetente = '';
                  let hora = '';

                  // Procurar padrões comuns de remetente/hora
                  const matchRemetente = texto.match(/^([A-Za-záàâãéèêíïóôõöúçñÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇÑ\s]+?)[\s:-]/);
                  const matchHora = texto.match(/(\d{2}[:/]\d{2}(?:[:/]\d{2})?)/);

                  if (matchRemetente) remetente = matchRemetente[1].trim();
                  if (matchHora) hora = matchHora[1];

                  mensagens.push({
                    texto: texto,
                    remetente: remetente || 'Pregoeiro/Sistema',
                    hora: hora || new Date().toLocaleTimeString('pt-BR')
                  });
                }
              });
              if (mensagens.length > 0) break;
            }
          }

          // Se não encontrou com seletores, tentar extrair do texto geral
          if (mensagens.length === 0) {
            const bodyText = document.body.innerText;
            // Dividir por linhas que parecem ser mensagens (contém hora ou padrão de chat)
            const linhas = bodyText.split('\n').filter(l => l.trim().length > 20);
            linhas.forEach(linha => {
              if (linha.match(/\d{2}:\d{2}/) || linha.toLowerCase().includes('pregoeiro')) {
                mensagens.push({
                  texto: linha.trim(),
                  remetente: 'Sistema',
                  hora: new Date().toLocaleTimeString('pt-BR')
                });
              }
            });
          }

          return mensagens;
        });

        this.log(`Mensagens extraídas: ${mensagensExtraidas.length}`);

        if (mensagensExtraidas.length === 0) {
          this.log('Nenhuma mensagem encontrada com os seletores atuais');
        }

        // Buscar palavras-chave
        const palavrasChave = db.prepare('SELECT palavra FROM chat_palavras_chave WHERE ativo = 1').all();

        // Identificador da licitação para hash e log
        const licitacaoId = `${participacao.uasg || ''}_${participacao.tipo || ''}_${participacao.numero || ''}_${participacao.ano || ''}`;
        const licitacaoDisplay = `${participacao.tipo || ''} ${participacao.numero || ''}/${participacao.ano || ''} - ${participacao.orgao || ''}`;

        // Processar cada mensagem extraída
        for (const msg of mensagensExtraidas) {
          // FILTRAR mensagens de erro de Captcha e mensagens de sistema
          const textoLimpo = msg.texto.toLowerCase();
          if (textoLimpo.includes('captcha') ||
              textoLimpo.includes('não foi possível realizar a validação') ||
              textoLimpo.includes('não há mensagens para esta compra') ||
              textoLimpo.includes('tente mais tarde') ||
              msg.remetente === 'Informação' ||
              msg.remetente === 'Não') {
            continue; // Ignorar mensagens de erro/sistema
          }

          // Criar hash único da mensagem
          const hashMensagem = crypto
            .createHash('md5')
            .update(`${licitacaoId}_${msg.texto}`)
            .digest('hex');

          // Verificar se já existe no banco
          const jaExiste = db.prepare('SELECT id, notificado FROM chat_mensagens WHERE hashMensagem = ?').get(hashMensagem);

          if (jaExiste) {
            continue; // Mensagem já processada
          }

          // Verificar CNPJ do fornecedor
          const temCnpj = this.cnpjFornecedor && msg.texto.includes(this.cnpjFornecedor);

          // Verificar palavras-chave
          const textoLower = msg.texto.toLowerCase();
          const palavrasEncontradas = palavrasChave
            .filter(p => textoLower.includes(p.palavra.toLowerCase()))
            .map(p => p.palavra);

          // Salvar mensagem no banco
          try {
            db.prepare(`
              INSERT INTO chat_mensagens (cnpjOrgao, ano, sequencial, remetente, mensagem, dataHoraMensagem, hashMensagem, temCnpjFornecedor, palavrasChaveEncontradas, notificado)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              participacao.uasg || licitacaoId,
              participacao.ano || 0,
              participacao.numero || 0,
              msg.remetente,
              msg.texto,
              msg.hora,
              hashMensagem,
              temCnpj ? 1 : 0,
              palavrasEncontradas.length > 0 ? palavrasEncontradas.join(',') : null,
              0
            );
          } catch (e) {
            // Mensagem já existe (race condition)
            continue;
          }

          this.totalMensagensNovas++;

          // Notificar se tiver CNPJ ou palavras-chave
          if (temCnpj || palavrasEncontradas.length > 0) {
            let emoji = '🔔';
            let titulo = 'NOVA MENSAGEM NO CHAT';

            if (temCnpj) {
              emoji = '🚨';
              titulo = 'SEU CNPJ FOI CITADO!';
            } else if (palavrasEncontradas.length > 0) {
              emoji = '⚠️';
              titulo = 'ALERTA - PALAVRA-CHAVE';
            }

            this.log(`${emoji} ${titulo}: ${msg.texto.substring(0, 50)}...`);

            // Destacar palavras-chave na mensagem
            let mensagemFormatada = msg.texto;
            for (const palavra of palavrasEncontradas) {
              const regex = new RegExp(`(${palavra})`, 'gi');
              mensagemFormatada = mensagemFormatada.replace(regex, '<b>[$1]</b>');
            }

            // Destacar CNPJ se encontrado
            if (temCnpj && this.cnpjFornecedor) {
              mensagemFormatada = mensagemFormatada.replace(
                new RegExp(this.cnpjFornecedor, 'g'),
                `<b>[${this.cnpjFornecedor}]</b>`
              );
            }

            // Montar alerta
            let alertaTelegram = `${emoji} <b>${titulo}</b>\n\n`;
            alertaTelegram += `<b>Licitação:</b> ${licitacaoDisplay}\n`;
            if (participacao.orgao) {
              alertaTelegram += `<b>Órgão:</b> ${participacao.orgao}\n`;
            }
            alertaTelegram += `\n<b>📩 Mensagem do ${msg.remetente}:</b>\n`;
            alertaTelegram += `<i>${mensagemFormatada.substring(0, 800)}</i>`;

            if (palavrasEncontradas.length > 0) {
              alertaTelegram += `\n\n<b>🔑 Palavras:</b> ${palavrasEncontradas.join(', ')}`;
            }

            // Não adicionar link direto pois usamos navegação por clique agora
            alertaTelegram += `\n\n📎 <i>Acesse o Comprasnet para ver detalhes</i>`;

            await enviarTelegram(alertaTelegram);

            // Marcar como notificado
            db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE hashMensagem = ?').run(hashMensagem);
          }
        }

      } catch (error) {
        this.log('Erro ao extrair mensagens: ' + error.message);
        console.error('Stack trace:', error);
      }
    }

    async verificarMensagens() {
      // Método mantido para compatibilidade, chama o novo método
      await this.verificarMensagensLicitacao();
    }

    async parar() {
      this.ativo = false;

      if (this.intervalo) {
        clearInterval(this.intervalo);
        this.intervalo = null;
      }

      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {}
        this.browser = null;
        this.page = null;
      }

      this.log('Monitoramento parado');
      await enviarTelegram('🔴 <b>Monitor de Mensagens Parado</b>');
    }

    getStatus() {
      return {
        ativo: this.ativo,
        ultimaVerificacao: this.ultimaVerificacao,
        totalMensagensNovas: this.totalMensagensNovas,
        logs: this.logs.slice(-30)
      };
    }
  }

  // Classe MonitorChat mantida para compatibilidade (código legado)
  class MonitorChat {
    constructor(cnpj, ano, sequencial, linkSistema) {
      this.cnpj = cnpj;
      this.ano = ano;
      this.sequencial = sequencial;
      this.linkSistema = linkSistema;
      this.browser = null;
      this.page = null;
      this.ativo = false;
      this.intervalo = null;
      this.mensagensProcessadas = new Set();
      this.logs = [];
    }

    log(mensagem) {
      const timestamp = new Date().toLocaleTimeString('pt-BR');
      const logEntry = `[${timestamp}] ${mensagem}`;
      this.logs.push(logEntry);
      console.log(`[Monitor ${this.cnpj}/${this.ano}/${this.sequencial}] ${mensagem}`);
      // Manter apenas últimos 100 logs
      if (this.logs.length > 100) this.logs.shift();
    }

    async iniciar() {
      try {
        this.log('Iniciando monitoramento...');

        // Verificar se há certificado digital configurado
        const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada, titular FROM certificado_digital WHERE id = 1').get();
        const usarCertificado = !!cert;

        if (usarCertificado) {
          this.log('Certificado digital encontrado - usando login com certificado');
        } else {
          this.log('Certificado não encontrado - usando login com CPF/senha');
        }

        // Buscar credenciais (fallback se certificado falhar)
        const usuario = db.prepare("SELECT valor FROM config WHERE chave = 'comprasnet_usuario'").get();
        const senha = db.prepare("SELECT valor FROM config WHERE chave = 'comprasnet_senha'").get();

        if (!usarCertificado && (!usuario || !senha)) {
          throw new Error('Credenciais do Comprasnet não configuradas e certificado não disponível');
        }

        // Verificar configuração de proxy
        const proxyAtivo = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_ativo'`).get();
        const proxyServidor = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_servidor'`).get();
        const proxyPorta = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_porta'`).get();
        const proxyUsuario = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_usuario'`).get();
        const proxySenha = db.prepare(`SELECT valor FROM config WHERE chave = 'proxy_senha'`).get();

        // Preparar certificado se necessário
        let certTempPath = null;
        let certSenha = null;
        if (usarCertificado) {
          const os = require('os');
          const fs = require('fs');
          const { execSync } = require('child_process');

          certTempPath = path.join(os.tmpdir(), `cert_${Date.now()}.pfx`);
          const certBuffer = Buffer.from(cert.certificadoBase64, 'base64');
          certSenha = Buffer.from(cert.senhaCriptografada, 'base64').toString();
          fs.writeFileSync(certTempPath, certBuffer);
          this.log('Certificado salvo em arquivo temporário');

          // Verificar se o certificado já está instalado no Windows
          let certInstalado = false;
          try {
            const result = execSync('certutil -store -user My', { encoding: 'utf8', stdio: 'pipe' });
            if (result.includes(cert.titular.split(':')[0])) {
              certInstalado = true;
              this.log('Certificado já está instalado no Windows');
            }
          } catch (e) {}

          // Tentar instalar certificado no Windows Certificate Store (precisa de admin)
          if (!certInstalado) {
            try {
              execSync(`certutil -f -p "${certSenha}" -user -importpfx "${certTempPath}"`, { stdio: 'pipe' });
              this.log('Certificado instalado no Windows Certificate Store');
              certInstalado = true;
            } catch (e) {
              this.log('ATENÇÃO: Não foi possível instalar o certificado automaticamente.');
              this.log('Para usar login com certificado, execute como Administrador OU instale o certificado manualmente:');
              this.log(`  1. Clique duas vezes no arquivo: ${certTempPath}`);
              this.log('  2. Siga o assistente de importação');
              this.log('  3. Use a senha do certificado quando solicitado');
              this.log('Tentando login com CPF/senha como alternativa...');
              // Não usar certificado se não está instalado
              // Continuar com CPF/senha
            }
          }

          // Limpar arquivo temporário se certificado foi instalado
          if (certInstalado) {
            try { fs.unlinkSync(certTempPath); } catch (e) {}
          }

          // Atualizar flag para refletir se certificado pode ser usado
          if (!certInstalado) {
            this.log('Certificado não instalado - login será feito com CPF/senha');
          }
          // Guardar estado do certificado
          this.certInstalado = certInstalado;
        }

        // Flag final para saber se pode usar certificado
        const podUsarCertificado = usarCertificado && this.certInstalado;

        // Configurar argumentos do navegador
        const browserArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--ignore-certificate-errors',
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-default-apps',
          '--mute-audio',
          '--disable-infobars',
          '--window-size=1366,768'
        ];

        // Auto-selecionar certificado para gov.br
        if (podUsarCertificado) {
          browserArgs.push('--auto-select-certificate-for-urls={"pattern":"*gov.br*","filter":{}}');
        }

        // Adicionar proxy se configurado
        if (proxyAtivo?.valor === '1' && proxyServidor?.valor && proxyPorta?.valor) {
          const proxyUrl = `${proxyServidor.valor}:${proxyPorta.valor}`;
          browserArgs.push(`--proxy-server=${proxyUrl}`);
          this.log(`Usando proxy: ${proxyUrl}`);
        }

        // Iniciar navegador
        this.browser = await puppeteer.launch({
          headless: false, // Visível para debug
          defaultViewport: { width: 1366, height: 768 },
          args: browserArgs
        });

        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(90000);

        // Configurar autenticação do proxy se necessário
        if (proxyAtivo?.valor === '1' && proxyUsuario?.valor && proxySenha?.valor) {
          await this.page.authenticate({
            username: proxyUsuario.valor,
            password: proxySenha.valor
          });
          this.log('Autenticação de proxy configurada');
        }

        // Configurar user-agent para evitar bloqueios
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Fazer login no gov.br
        this.log('Acessando página de login gov.br...');
        await this.page.goto('https://sso.acesso.gov.br/login', { waitUntil: 'domcontentloaded', timeout: 90000 });

        // Aguardar o carregamento do React/JavaScript (até 2 minutos)
        this.log('Aguardando carregamento da página...');
        try {
          await this.page.waitForFunction(() => {
            return document.body.innerText.length > 100;
          }, { timeout: 120000 }); // 2 minutos
        } catch (e) {
          this.log('Página ainda não carregou completamente, tentando continuar...');
        }

        // Se pode usar certificado, clicar na opção de certificado digital
        if (podUsarCertificado) {
          this.log('Procurando opção de login com certificado digital...');
          await new Promise(r => setTimeout(r, 2000));

          // Procurar link/botão de certificado digital
          const seletoresCertificado = [
            'a[href*="certificado"]',
            'button:has-text("certificado")',
            '[class*="certificado"]',
            'a:has-text("certificado digital")',
            'div[role="button"]:has-text("certificado")'
          ];

          let certLink = null;

          // Tentar encontrar por texto
          try {
            const links = await this.page.$$('a, button, div[role="button"]');
            for (const link of links) {
              const texto = await link.evaluate(el => el.innerText.toLowerCase());
              if (texto.includes('certificado digital') || texto.includes('seu certificado')) {
                certLink = link;
                this.log('Link de certificado encontrado');
                break;
              }
            }
          } catch (e) {}

          if (certLink) {
            await certLink.click();
            this.log('Clicou no login com certificado digital');
            await new Promise(r => setTimeout(r, 5000));

            // Aguardar redirecionamento ou seleção de certificado
            // O Chrome deve auto-selecionar o certificado configurado
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});

            const urlAtual = this.page.url();
            this.log(`URL após certificado: ${urlAtual}`);

            // Verificar se login foi bem sucedido
            if (!urlAtual.includes('login') && !urlAtual.includes('acesso.gov.br')) {
              this.log('Login com certificado realizado com sucesso!');
            } else {
              this.log('Login com certificado pode ter falhado, verificando página...');
            }
          } else {
            this.log('Link de certificado não encontrado, tentando login com CPF/senha...');
          }

          // Limpar arquivo temporário
          if (certTempPath) {
            try {
              require('fs').unlinkSync(certTempPath);
            } catch (e) {}
          }
        }

        // Se não usou certificado ou falhou, tentar CPF/senha
        const urlAtual = this.page.url();
        if (urlAtual.includes('login') || urlAtual.includes('acesso.gov.br')) {
          if (!usuario || !senha) {
            throw new Error('Login com certificado falhou e credenciais CPF/senha não configuradas');
          }

          this.log('Tentando login com CPF/senha...');

          // Seletores possíveis para o campo de CPF
          const seletoresCPF = [
            'input[name="accountId"]',
            'input[id="accountId"]',
            'input[type="text"]',
            'input[placeholder*="CPF"]',
            'input[aria-label*="CPF"]'
          ];

          let cpfInput = null;
          for (const seletor of seletoresCPF) {
            try {
              cpfInput = await this.page.$(seletor);
              if (cpfInput) {
                this.log(`Campo CPF encontrado: ${seletor}`);
                break;
              }
            } catch (e) { continue; }
          }

          if (!cpfInput) {
            throw new Error('Campo de CPF não encontrado na página de login');
          }

          // Preencher CPF
          this.log('Preenchendo CPF...');
          await cpfInput.click();
          await cpfInput.type(usuario.valor, { delay: 50 });

          // Clicar no botão de continuar
          const seletoresBotao = [
            'button[type="submit"]',
            'button[data-testid="enter-account-id"]',
            'button.primary',
            'button:not([disabled])'
          ];

          let botao = null;
          for (const seletor of seletoresBotao) {
            try {
              botao = await this.page.$(seletor);
              if (botao) break;
            } catch (e) { continue; }
          }

          if (botao) {
            await botao.click();
          } else {
            await this.page.keyboard.press('Enter');
          }

          this.log('CPF enviado, aguardando próxima etapa...');
          await new Promise(r => setTimeout(r, 3000)); // Aguardar transição

          // Aguardar campo de senha (pode demorar)
          const seletoresSenha = [
            'input[name="password"]',
            'input[type="password"]',
            'input[id="password"]',
            'input[aria-label*="senha"]'
          ];

          let senhaInput = null;
          for (let tentativa = 0; tentativa < 10 && !senhaInput; tentativa++) {
            for (const seletor of seletoresSenha) {
              try {
                senhaInput = await this.page.$(seletor);
                if (senhaInput) {
                  this.log(`Campo senha encontrado: ${seletor}`);
                  break;
                }
              } catch (e) { continue; }
            }
            if (!senhaInput) {
              await new Promise(r => setTimeout(r, 2000));
            }
          }

          if (!senhaInput) {
            // Pode ser que o gov.br pediu verificação por celular/email
            const pageContent = await this.page.content();
            const pageText = await this.page.evaluate(() => document.body.innerText);
            const urlAtualSenha = this.page.url();
            this.log(`URL atual após CPF: ${urlAtualSenha}`);

            // Capturar título e texto visível para debug
            const titulo = await this.page.title();
            this.log(`Título da página: ${titulo}`);

            // Verificar se o campo de senha pode aparecer em outro formato
            const passwordField = await this.page.$('input[type="password"]');
            if (passwordField) {
              senhaInput = passwordField;
              this.log('Campo de senha encontrado por type="password"');
            } else {
              // Verificar mensagens específicas de erro
              if (pageText.includes('código de acesso') || pageText.includes('verificação') || pageText.includes('enviamos um código')) {
                throw new Error('Login requer verificação por código (celular/email). Faça login manualmente primeiro no gov.br.');
              }
              if (pageText.includes('não encontrado') || pageText.includes('não cadastrado') || pageText.includes('CPF inválido')) {
                throw new Error('CPF não encontrado ou inválido no gov.br.');
              }
              if (pageText.includes('bloqueado') || pageText.includes('suspenso')) {
                throw new Error('Conta gov.br bloqueada ou suspensa.');
              }

              // Log do texto visível para debug
              this.log(`Texto na página: ${pageText.substring(0, 500)}...`);
              throw new Error('Campo de senha não apareceu. A página pode estar pedindo verificação adicional ou as credenciais estão incorretas.');
            }
          }

          // Preencher senha
          this.log('Preenchendo senha...');
          await senhaInput.click();
          await senhaInput.type(senha.valor, { delay: 50 });

          // Clicar no botão de login
          await new Promise(r => setTimeout(r, 500));
          const botaoLogin = await this.page.$('button[type="submit"]');
          if (botaoLogin) {
            await botaoLogin.click();
          } else {
            await this.page.keyboard.press('Enter');
          }

          this.log('Login realizado, aguardando redirecionamento...');
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));

          // Verificar se login foi bem sucedido
          const urlFinal = this.page.url();
          if (urlFinal.includes('login') || urlFinal.includes('acesso.gov.br')) {
            const pageContent = await this.page.content();
            if (pageContent.includes('incorret') || pageContent.includes('inválid')) {
              throw new Error('CPF ou senha incorretos');
            }
          }
        }

        // Navegar para o link do sistema
        if (this.linkSistema && this.linkSistema.trim() && !this.linkSistema.includes('sigep')) {
          this.log('Acessando sessão da licitação...');
          const linkCompleto = this.linkSistema.startsWith('http') ? this.linkSistema : `https://${this.linkSistema}`;
          await this.page.goto(linkCompleto, { waitUntil: 'networkidle2', timeout: 60000 });
        }

        this.ativo = true;
        this.log('Monitoramento iniciado com sucesso!');

        // Enviar notificação
        await enviarTelegram(`🟢 <b>Monitoramento iniciado</b>\n\nLicitação: ${this.cnpj}/${this.ano}/${this.sequencial}`);

        // Iniciar loop de verificação
        this.iniciarVerificacao();

        return { success: true };
      } catch (error) {
        this.log('Erro ao iniciar: ' + error.message);
        await this.parar();
        throw error;
      }
    }

    iniciarVerificacao() {
      // Verificar chat a cada 5 segundos
      this.intervalo = setInterval(async () => {
        if (!this.ativo) return;

        try {
          await this.verificarChat();
        } catch (error) {
          this.log('Erro na verificação: ' + error.message);
        }
      }, 5000);
    }

    async verificarChat() {
      try {
        // Tentar encontrar mensagens do chat
        // Seletores podem variar dependendo do sistema (Comprasnet, ComprasGov, etc)
        const seletoresChat = [
          '.chat-mensagem',
          '.mensagem-chat',
          '[class*="chat"] [class*="message"]',
          '.message-content',
          '#chat-container .message',
          '.chat-item',
          '.msg-item'
        ];

        let mensagens = [];

        for (const seletor of seletoresChat) {
          try {
            mensagens = await this.page.$$(seletor);
            if (mensagens.length > 0) break;
          } catch (e) {
            continue;
          }
        }

        if (mensagens.length === 0) {
          // Tentar buscar por iframe do chat
          const frames = this.page.frames();
          for (const frame of frames) {
            try {
              for (const seletor of seletoresChat) {
                mensagens = await frame.$$(seletor);
                if (mensagens.length > 0) break;
              }
              if (mensagens.length > 0) break;
            } catch (e) {
              continue;
            }
          }
        }

        // Processar mensagens encontradas
        for (const msg of mensagens) {
          try {
            const texto = await msg.evaluate(el => el.innerText);
            const msgId = await msg.evaluate(el => el.getAttribute('data-id') || el.innerText.substring(0, 50));

            if (!this.mensagensProcessadas.has(msgId)) {
              this.mensagensProcessadas.add(msgId);

              // Extrair remetente e conteúdo
              let remetente = 'Pregoeiro';
              let conteudo = texto;

              // Tentar separar remetente do conteúdo
              const partes = texto.split(':');
              if (partes.length > 1) {
                remetente = partes[0].trim();
                conteudo = partes.slice(1).join(':').trim();
              }

              // Ignorar mensagens do próprio fornecedor
              if (remetente.toLowerCase().includes('fornecedor')) continue;

              this.log(`Nova mensagem de ${remetente}: ${conteudo.substring(0, 50)}...`);

              // Verificar palavras-chave
              const palavrasChave = db.prepare('SELECT palavra FROM chat_palavras_chave WHERE ativo = 1').all();
              const conteudoLower = conteudo.toLowerCase();
              const palavrasEncontradas = palavrasChave
                .filter(p => conteudoLower.includes(p.palavra.toLowerCase()))
                .map(p => p.palavra);

              // Definir emoji e urgência baseado nas palavras-chave
              let emoji = '🔔';
              let tipoAlerta = 'NOVA MENSAGEM NO CHAT';
              if (palavrasEncontradas.length > 0) {
                emoji = '🚨';
                tipoAlerta = 'ALERTA IMPORTANTE - PALAVRA-CHAVE DETECTADA';
                this.log(`⚠️ Palavras-chave detectadas: ${palavrasEncontradas.join(', ')}`);
              }

              // Enviar alerta
              let mensagemTelegram = `${emoji} <b>${tipoAlerta}</b>\n\n` +
                `<b>Licitação:</b> ${this.cnpj}/${this.ano}/${this.sequencial}\n\n` +
                `<b>De:</b> ${remetente}\n` +
                `<b>Mensagem:</b>\n${conteudo}`;

              if (palavrasEncontradas.length > 0) {
                mensagemTelegram += `\n\n⚠️ <b>Palavras-chave:</b> ${palavrasEncontradas.join(', ')}`;
              }

              await enviarTelegram(mensagemTelegram);

              // Salvar no banco
              db.prepare(`
                INSERT INTO chat_mensagens (cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora, notificado)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)
              `).run(this.cnpj, this.ano, this.sequencial, msgId, remetente, conteudo);
            }
          } catch (e) {
            continue;
          }
        }
      } catch (error) {
        this.log('Erro ao verificar chat: ' + error.message);
      }
    }

    async parar() {
      this.ativo = false;

      if (this.intervalo) {
        clearInterval(this.intervalo);
        this.intervalo = null;
      }

      if (this.browser) {
        try {
          await this.browser.close();
        } catch (e) {}
        this.browser = null;
        this.page = null;
      }

      this.log('Monitoramento parado');
      await enviarTelegram(`🔴 <b>Monitoramento parado</b>\n\nLicitação: ${this.cnpj}/${this.ano}/${this.sequencial}`);
    }

    getStatus() {
      return {
        ativo: this.ativo,
        logs: this.logs.slice(-20)
      };
    }
  }

  return { MonitorMensagensComprasnet, MonitorChat };
}

module.exports = { createMonitorMensagens };
