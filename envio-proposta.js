/**
 * Modulo de Envio de Propostas via Puppeteer
 * Automatiza o envio de propostas no Comprasnet
 * ATUALIZADO: Fluxo correto baseado na interface real do Comprasnet
 */

const puppeteer = require('puppeteer');
const path = require('path');
const os = require('os');

// URLs do Comprasnet
const COMPRASNET_COMPRAS = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras?compra=';
const COMPRASNET_CADASTRO_PROPOSTAS = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas';
const TIMEOUT = 60000;

// Funcao de espera
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let statusAtual = {
    ativo: false,
    etapa: '',
    progresso: 0,
    mensagens: [],
    erro: null
};

function atualizarStatus(etapa, progresso, mensagem) {
    statusAtual.etapa = etapa;
    statusAtual.progresso = progresso;
    if (mensagem) {
        statusAtual.mensagens.push({ time: new Date().toISOString(), msg: mensagem });
        console.log(`[PROPOSTA] ${mensagem}`);
    }
}

function getStatus() {
    return statusAtual;
}

/**
 * Clica em um elemento usando evaluate (mais robusto)
 */
async function clicarElementoJS(page, seletor, descricao = '') {
    try {
        const resultado = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
                el.click();
                return true;
            }
            return false;
        }, seletor);

        if (resultado && descricao) {
            console.log(`[PROPOSTA] Clicou (JS): ${descricao}`);
        }
        return resultado;
    } catch (e) {
        console.log(`[PROPOSTA] Erro ao clicar JS ${descricao || seletor}: ${e.message}`);
        return false;
    }
}

/**
 * Encontra e clica em elemento por texto
 */
async function clicarPorTexto(page, texto, tag = '*') {
    try {
        const resultado = await page.evaluate((texto, tag) => {
            const elementos = document.querySelectorAll(tag);
            for (const el of elementos) {
                if (el.innerText && el.innerText.trim().includes(texto)) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, texto, tag);

        if (resultado) {
            console.log(`[PROPOSTA] Clicou por texto: "${texto}"`);
        }
        return resultado;
    } catch (e) {
        console.log(`[PROPOSTA] Erro ao clicar por texto "${texto}": ${e.message}`);
        return false;
    }
}

/**
 * Preenche um input de forma segura
 */
async function preencherInput(page, seletor, valor, descricao = '') {
    try {
        await page.waitForSelector(seletor, { visible: true, timeout: 10000 });
        await page.click(seletor, { clickCount: 3 }); // Seleciona todo
        await page.type(seletor, valor, { delay: 50 });
        if (descricao) console.log(`[PROPOSTA] Preencheu: ${descricao} = ${valor}`);
        return true;
    } catch (e) {
        console.log(`[PROPOSTA] Erro ao preencher ${descricao || seletor}: ${e.message}`);
        return false;
    }
}

/**
 * Extrai o compraId de um link do Comprasnet
 * Ex: https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=38350006000012026
 * Retorna: 38350006000012026
 */
function extrairCompraId(link) {
    if (!link) return null;

    // Tentar extrair de diferentes formatos de URL
    const patterns = [
        /compra=(\d+)/,                    // ?compra=123456
        /cadastro-propostas\?compra=(\d+)/, // cadastro-propostas?compra=123456
        /acompanhamento-compra\?compra=(\d+)/, // acompanhamento-compra?compra=123456
        /\/(\d{15,})$/                      // /123456789012345 no final da URL
    ];

    for (const pattern of patterns) {
        const match = link.match(pattern);
        if (match) {
            return match[1];
        }
    }

    return null;
}

/**
 * Extrai UASG e numeroCompra de um compraId
 * compraId format: UASG (6 digitos) + numero (5 digitos) + ano (4 digitos) ou variantes
 */
function parseCompraId(compraId) {
    if (!compraId || compraId.length < 10) return null;

    // Formato mais comum: 383500 + 06000 + 01 + 2026 = 17 digitos
    // Ou: 383500 + 06000 + 2026 = 15 digitos
    const str = compraId.toString();

    if (str.length >= 15) {
        return {
            uasg: str.substring(0, 6),
            numero: str.substring(6, 11),
            ano: str.substring(str.length - 4)
        };
    }

    return null;
}

/**
 * Envia proposta para uma licitacao do Comprasnet
 * Aceita link direto ou dados separados
 */
async function enviarProposta(dados) {
    const { linkLicitacao, uasg, numeroCompra, itens, usarPerfilChrome } = dados;

    statusAtual = {
        ativo: true,
        etapa: 'iniciando',
        progresso: 0,
        mensagens: [],
        erro: null
    };

    let browser = null;
    let compraId = null;

    try {
        // Extrair compraId do link se disponivel
        if (linkLicitacao) {
            compraId = extrairCompraId(linkLicitacao);
            console.log(`[PROPOSTA] CompraId extraido: ${compraId}`);
        }

        // Se nao tem compraId do link, construir a partir dos dados
        if (!compraId && uasg && numeroCompra) {
            // Construir compraId no formato esperado
            // Este e um formato aproximado - pode precisar ajustar
            const ano = new Date().getFullYear();
            compraId = `${uasg.padStart(6, '0')}${numeroCompra.padStart(5, '0')}01${ano}`;
        }

        atualizarStatus('iniciando', 5, 'Iniciando navegador...');

        // Configuracao do browser
        const browserOptions = {
            headless: false,
            defaultViewport: null,
            args: [
                '--start-maximized',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-sandbox'
            ]
        };

        // Usar perfil do Chrome para manter sessao logada
        if (usarPerfilChrome !== false) {
            const userDataDir = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
            browserOptions.args.push(`--user-data-dir=${userDataDir}`);
            browserOptions.args.push('--profile-directory=Default');
            atualizarStatus('iniciando', 8, 'Usando perfil do Chrome (sessao existente)');
        }

        browser = await puppeteer.launch(browserOptions);
        const page = await browser.newPage();
        await page.setDefaultTimeout(TIMEOUT);

        // Configurar interceptacao de dialogos
        page.on('dialog', async dialog => {
            console.log(`[PROPOSTA] Dialogo: ${dialog.message()}`);
            await dialog.accept();
        });

        // ===== NAVEGAR DIRETAMENTE PARA PAGINA DE PROPOSTAS =====
        let urlDestino;

        if (compraId) {
            // Ir direto para a pagina de cadastro de propostas
            urlDestino = `${COMPRASNET_CADASTRO_PROPOSTAS}?compra=${compraId}`;
            atualizarStatus('navegando', 15, `Navegando direto para cadastro de propostas (compra=${compraId})...`);
        } else if (linkLicitacao) {
            // Usar o link fornecido
            urlDestino = linkLicitacao;
            atualizarStatus('navegando', 15, 'Navegando para o link da licitacao...');
        } else {
            throw new Error('Nenhum link ou dados de licitacao fornecidos');
        }

        console.log(`[PROPOSTA] URL destino: ${urlDestino}`);
        await page.goto(urlDestino, { waitUntil: 'networkidle2', timeout: TIMEOUT });
        await sleep(3000);

        // Verificar se esta logado
        const urlAtual = page.url();
        if (urlAtual.includes('acesso-nao-autorizado') || urlAtual.includes('sso.acesso.gov.br') || urlAtual.includes('login')) {
            atualizarStatus('login', 20, 'ATENCAO: Voce precisa fazer login! Faca login no navegador que abriu.');

            // Aguarda o usuario fazer login (ate 3 minutos)
            let tentativas = 0;
            while (tentativas < 36) {
                await sleep(5000);
                const novaUrl = page.url();
                if (novaUrl.includes('cadastro-propostas') || novaUrl.includes('fornecedor/compras')) {
                    atualizarStatus('login', 25, 'Login detectado!');
                    await sleep(2000);

                    // Se foi redirecionado para compras, navegar para cadastro
                    if (!novaUrl.includes('cadastro-propostas') && compraId) {
                        await page.goto(`${COMPRASNET_CADASTRO_PROPOSTAS}?compra=${compraId}`, { waitUntil: 'networkidle2' });
                        await sleep(2000);
                    }
                    break;
                }
                tentativas++;
                atualizarStatus('login', 20, `Aguardando login... (${tentativas * 5}s)`);
            }

            if (tentativas >= 36) {
                throw new Error('Timeout aguardando login. Por favor, faca login e tente novamente.');
            }
        }

        // ===== ETAPA 1: Marcar checkbox inicial (aceite) =====
        atualizarStatus('aceitando', 35, 'Marcando aceite inicial...');
        await sleep(2000);

        // Clicar no primeiro checkbox da pagina
        const checkboxClicado = await page.evaluate(() => {
            const checkboxes = document.querySelectorAll('.p-checkbox-box, input[type="checkbox"]');
            if (checkboxes.length > 0) {
                checkboxes[0].click();
                return true;
            }
            return false;
        });

        if (checkboxClicado) {
            console.log('[PROPOSTA] Checkbox inicial clicado');
        }

        await sleep(2000);

        // ===== ETAPA 2: Pop-up de declaracoes - marcar todos =====
        atualizarStatus('aceitando', 45, 'Aceitando declaracoes...');

        // Aguardar pop-up aparecer
        await sleep(1500);

        // Marcar checkbox "todos" no pop-up
        await page.evaluate(() => {
            // Procurar por checkbox "todos" ou "selecionar todos"
            const checkboxes = document.querySelectorAll('.p-checkbox-box, .p-dialog .p-checkbox-box');
            for (const cb of checkboxes) {
                // Clicar em todos os checkboxes do modal
                if (!cb.classList.contains('p-highlight')) {
                    cb.click();
                }
            }
        });

        await sleep(1000);

        // ===== ETAPA 3: Clicar em Confirmar =====
        atualizarStatus('confirmando', 50, 'Confirmando declaracoes...');

        let confirmarClicado = await clicarPorTexto(page, 'Confirmar', 'button');
        if (!confirmarClicado) {
            await page.evaluate(() => {
                const botoes = document.querySelectorAll('.p-dialog button, .modal button, button');
                for (const btn of botoes) {
                    if (btn.innerText && btn.innerText.trim().includes('Confirmar')) {
                        btn.click();
                        return;
                    }
                }
            });
        }

        await sleep(2000);

        // ===== ETAPA 4: Marcar radio button EPP =====
        atualizarStatus('epp', 55, 'Selecionando opcao EPP (nao ultrapassou faturamento)...');

        // Clicar no radio button de EPP (nao ultrapassou faturamento)
        await page.evaluate(() => {
            const radios = document.querySelectorAll('.p-radiobutton-box');
            if (radios.length > 0) {
                // Geralmente o primeiro radio e "Nao ultrapassou"
                radios[0].click();
            }
        });

        await sleep(1500);

        // ===== ETAPA 5: Processar cada item =====
        if (!itens || itens.length === 0) {
            atualizarStatus('concluido', 100, 'Navegador aberto na pagina de propostas. Nenhum item para processar automaticamente.');
            statusAtual.ativo = false;
            return {
                success: true,
                message: 'Navegador aberto na pagina de propostas. Preencha os valores manualmente.',
                itensProcessados: 0,
                totalItens: 0
            };
        }

        atualizarStatus('itens', 60, `Processando ${itens.length} item(s)...`);

        let itensProcessados = 0;

        for (const item of itens) {
            const numeroItem = item.numeroItem || item.numero;
            const valorProposta = item.valorUnitario || item.valor;

            atualizarStatus('itens', 60 + (itensProcessados / itens.length * 30),
                `Processando item ${numeroItem}...`);

            // Expandir o item clicando no chevron
            const itemExpandido = await page.evaluate((numItem) => {
                // Procurar linha do item e clicar no chevron
                const elementos = document.querySelectorAll('tr, div[class*="item"], div[class*="row"]');
                for (const el of elementos) {
                    const texto = el.innerText;
                    // Verificar se e a linha do item correto
                    if (texto && (texto.includes(`Item ${numItem}`) || texto.match(new RegExp(`^\\s*${numItem}\\s`)))) {
                        const chevron = el.querySelector('.fa-chevron-down, .fa-chevron-right, [class*="chevron"], i[class*="fa-chevron"]');
                        if (chevron) {
                            chevron.click();
                            return true;
                        }
                        // Tentar clicar em qualquer icone ou botao expansivel
                        const btn = el.querySelector('button, [role="button"], i');
                        if (btn) {
                            btn.click();
                            return true;
                        }
                    }
                }
                return false;
            }, numeroItem);

            if (!itemExpandido) {
                console.log(`[PROPOSTA] Nao encontrou item ${numeroItem} para expandir`);
                continue;
            }

            await sleep(1500);

            // Preencher valor da proposta
            const valorFormatado = typeof valorProposta === 'number'
                ? valorProposta.toFixed(2).replace('.', ',')
                : valorProposta.toString().replace('.', ',');

            const valorPreenchido = await page.evaluate((valor) => {
                // Procurar input de valor da proposta
                const inputs = document.querySelectorAll('input[data-test="input-valor-proposta"], input.cp-input-proposta, input[class*="proposta"]');
                for (const input of inputs) {
                    // Verificar se o input esta visivel
                    const rect = input.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        input.focus();
                        input.select();
                        input.value = valor;
                        // Disparar evento de input
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                }
                return false;
            }, valorFormatado);

            if (valorPreenchido) {
                console.log(`[PROPOSTA] Item ${numeroItem}: valor ${valorFormatado} preenchido`);
            } else {
                console.log(`[PROPOSTA] Nao conseguiu preencher valor do item ${numeroItem}`);
            }

            await sleep(1000);

            // Clicar em Salvar
            const salvoComSucesso = await page.evaluate(() => {
                const botoes = document.querySelectorAll('button');
                for (const btn of botoes) {
                    if (btn.innerText && btn.innerText.trim() === 'Salvar' && btn.offsetParent !== null) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });

            if (salvoComSucesso) {
                itensProcessados++;
                console.log(`[PROPOSTA] Item ${numeroItem}: proposta salva!`);
            }

            await sleep(2000);
        }

        // ===== CONCLUSAO =====
        atualizarStatus('concluido', 100,
            `Processo finalizado! ${itensProcessados} de ${itens.length} itens processados.`);

        statusAtual.ativo = false;

        return {
            success: itensProcessados > 0,
            message: itensProcessados > 0
                ? `Proposta enviada com sucesso! ${itensProcessados} itens processados.`
                : 'Navegador aberto na pagina de propostas. Verifique e complete manualmente.',
            itensProcessados,
            totalItens: itens.length
        };

    } catch (error) {
        console.error('[PROPOSTA] Erro:', error.message);
        statusAtual.erro = error.message;
        statusAtual.ativo = false;

        return {
            success: false,
            error: error.message,
            etapa: statusAtual.etapa
        };

    } finally {
        // Nao fecha o navegador para o usuario poder revisar
        if (browser && statusAtual.erro) {
            // Se houve erro, fecha apos 60 segundos
            setTimeout(async () => {
                try {
                    await browser.close();
                } catch (e) { }
            }, 60000);
        }
    }
}

/**
 * Abre o Comprasnet para login manual (sem automacao completa)
 */
async function abrirComprasnetLogin() {
    try {
        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized']
        });

        const page = await browser.newPage();
        await page.goto(COMPRASNET_COMPRAS, { waitUntil: 'networkidle2' });

        return { success: true, message: 'Navegador aberto. Faca login manualmente.' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Versao simplificada: apenas navega para a pagina de cadastro de proposta
 */
async function navegarParaProposta(dados) {
    const { compraId, linkLicitacao } = dados;

    try {
        let url;

        if (compraId) {
            url = `${COMPRASNET_CADASTRO_PROPOSTAS}?compra=${compraId}`;
        } else if (linkLicitacao) {
            const id = extrairCompraId(linkLicitacao);
            if (id) {
                url = `${COMPRASNET_CADASTRO_PROPOSTAS}?compra=${id}`;
            } else {
                url = linkLicitacao;
            }
        } else {
            return { success: false, error: 'Nenhum link ou compraId fornecido' };
        }

        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized']
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' });

        return {
            success: true,
            message: `Navegador aberto na pagina de propostas.`,
            url
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    enviarProposta,
    abrirComprasnetLogin,
    navegarParaProposta,
    getStatus,
    extrairCompraId,
    parseCompraId
};
