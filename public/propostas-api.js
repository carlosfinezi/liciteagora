/**
 * propostas-api.js — Envio de propostas via API Comprasnet (sem extensão no browser)
 *
 * Fluxo:
 * 1. Carrega participações do banco (sincronizadas pela extensão)
 * 2. Para cada uma, busca itens via API do servidor
 * 3. Usuário configura valores
 * 4. Envia proposta via POST /api/proposta/enviar-api (server → Comprasnet API)
 */

let participacoesData = [];
let disputasData = new Map(); // compraId → { itens, orgao, objeto, ... }
let valoresLocais = {}; // compraId:itemNumero → { valor, marca, modelo, fabricante, selecionado }

// ==================== STORAGE LOCAL ====================

function salvarValoresLocal() {
    try {
        localStorage.setItem('propostas-api-valores', JSON.stringify(valoresLocais));
    } catch (e) {}
}

function carregarValoresLocal() {
    try {
        const saved = localStorage.getItem('propostas-api-valores');
        if (saved) valoresLocais = JSON.parse(saved);
    } catch (e) {}
}

function keyItem(compraId, numero) {
    return `${compraId}:${numero}`;
}

function getValorItem(compraId, numero) {
    return valoresLocais[keyItem(compraId, numero)] || {
        valor: null, marca: '', modelo: '', fabricante: '', selecionado: false
    };
}

function setValorItem(compraId, numero, dados) {
    valoresLocais[keyItem(compraId, numero)] = {
        ...getValorItem(compraId, numero),
        ...dados
    };
    salvarValoresLocal();
}

// ==================== TOKEN STATUS ====================

async function atualizarTokenStatus() {
    const div = document.getElementById('tokenStatus');
    try {
        const resp = await fetch('/api/sniper/status');
        const result = await resp.json();
        const s = result.status || result;

        if (s.temToken && !s.tokenExpirado) {
            div.innerHTML = `<span class="token-ok">Token ativo (${s.tokenIdade})</span>`;
            div.className = 'token-status ok';
        } else if (s.temToken && s.tokenExpirado) {
            div.innerHTML = `<span class="token-warn">Token expirado (${s.tokenIdade})</span>`;
            div.className = 'token-status warn';
        } else {
            div.innerHTML = `<span class="token-err">Sem token</span>`;
            div.className = 'token-status err';
        }
    } catch (e) {
        div.innerHTML = `<span class="token-err">Erro ao verificar token</span>`;
        div.className = 'token-status err';
    }
}

// ==================== CARREGAR DADOS ====================

async function carregarParticipacoes() {
    const loading = document.getElementById('loadingContainer');
    const container = document.getElementById('participacoesContainer');
    const empty = document.getElementById('emptyState');

    try {
        // Carregar participações do banco
        const resp = await fetch('/api/proposta/participacoes');
        const result = await resp.json();
        participacoesData = result.data || [];

        // Carregar disputas ativas (cache da extensão)
        try {
            const dResp = await fetch('/api/sniper/disputas-ativas');
            const dResult = await dResp.json();
            if (dResult.disputas) {
                dResult.disputas.forEach(d => disputasData.set(d.compraId, d));
            }
        } catch (e) {}

        loading.style.display = 'none';

        if (participacoesData.length === 0) {
            empty.style.display = 'block';
            return;
        }

        carregarValoresLocal();
        renderizarParticipacoes();
        container.style.display = 'block';
        document.getElementById('filtrosContainer').style.display = 'block';
        popularFiltros();

        // Atualizar stats
        const stats = result.stats || {};
        document.getElementById('statsInfo').innerHTML =
            `${participacoesData.length} participações | ${stats.emAndamento || 0} em andamento | ${stats.encerradas || 0} encerradas`;

    } catch (error) {
        console.error('Erro:', error);
        loading.innerHTML = '<h3 style="color: #f44336;">Erro ao carregar participações</h3>';
    }
}

// ==================== FILTROS ====================

function popularFiltros() {
    const situacoes = new Set();
    participacoesData.forEach(p => {
        if (p.situacao) situacoes.add(p.situacao);
    });
    const select = document.getElementById('filtroSituacao');
    select.innerHTML = '<option value="">Todas situações</option>';
    Array.from(situacoes).sort().forEach(s => {
        select.innerHTML += `<option value="${s}">${s}</option>`;
    });
}

function aplicarFiltros() {
    const texto = document.getElementById('filtroTexto').value.toLowerCase().trim();
    const situacao = document.getElementById('filtroSituacao').value;

    let total = 0, visiveis = 0;
    document.querySelectorAll('#participacoesContainer .panel[data-compra-id]').forEach(panel => {
        total++;
        const compraId = panel.dataset.compraId;
        const p = participacoesData.find(x => x.compraId === compraId);
        if (!p) return;

        let visivel = true;
        if (texto) {
            const t = `${p.objeto || ''} ${p.orgao || ''} ${p.compraId || ''}`.toLowerCase();
            if (!t.includes(texto)) visivel = false;
        }
        if (situacao && p.situacao !== situacao) visivel = false;

        panel.style.display = visivel ? '' : 'none';
        if (visivel) visiveis++;
    });

    const resultado = document.getElementById('filtroResultado');
    resultado.textContent = (texto || situacao) ? `Exibindo ${visiveis} de ${total}` : '';
}

function limparFiltros() {
    document.getElementById('filtroTexto').value = '';
    document.getElementById('filtroSituacao').value = '';
    aplicarFiltros();
}

// ==================== RENDERIZAR ====================

function renderizarParticipacoes() {
    const container = document.getElementById('participacoesContainer');
    container.innerHTML = '';

    participacoesData.forEach(p => {
        const disputa = disputasData.get(p.compraId);
        const div = document.createElement('div');
        div.className = 'panel';
        div.dataset.compraId = p.compraId;

        const situacaoLabel = formatarSituacao(p.situacao);
        const faseLabel = p.faseCompra || p.etapa || '';

        div.innerHTML = `
            <div class="participacao-header">
                <div class="participacao-info">
                    <div class="participacao-objeto">${p.objeto || 'Objeto não disponível'}</div>
                    <div class="participacao-orgao">${p.orgao || ''}</div>
                    <div class="participacao-meta">
                        <span class="badge-compra">${p.compraId}</span>
                        <span class="badge-situacao badge-sit-${(p.situacao || '').toUpperCase()}">${situacaoLabel}</span>
                        ${faseLabel ? `<span class="badge-fase">${faseLabel}</span>` : ''}
                        ${p.dataSessao ? `<span class="meta-data">${formatarData(p.dataSessao)}</span>` : ''}
                    </div>
                </div>
                <div class="participacao-acoes">
                    <a href="https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=${p.compraId}"
                       target="_blank" class="btn-comprasnet">Comprasnet</a>
                </div>
            </div>

            <div class="itens-container" id="itens-${p.compraId}">
                ${disputa && disputa.itens?.length > 0
                    ? renderizarItens(p.compraId, disputa.itens)
                    : `<div class="itens-loading" id="itens-loading-${p.compraId}">
                         <button class="btn btn-sm btn-outline" onclick="carregarItens('${p.compraId}')">
                           Carregar itens
                         </button>
                       </div>`
                }
            </div>

            <div class="participacao-actions" id="actions-${p.compraId}" ${!disputa ? 'style="display:none"' : ''}>
                <button class="btn-action btn-enviar" onclick="enviarProposta('${p.compraId}')">
                    Enviar Proposta
                </button>
                <button class="btn-action btn-csv-action" onclick="exportarCSVCompra('${p.compraId}')">
                    CSV
                </button>
                <a href="https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=${p.compraId}"
                   target="_blank" class="btn-action btn-link-action">Cadastro Manual</a>
            </div>
        `;
        container.appendChild(div);
    });
}

function renderizarItens(compraId, itens) {
    if (!itens || itens.length === 0) return '<div class="empty-itens">Sem itens disponíveis</div>';

    let html = `
        <div class="select-all-bar">
            <input type="checkbox" id="selectAll-${compraId}" onchange="toggleSelectAll('${compraId}')">
            <label for="selectAll-${compraId}">Selecionar todos</label>
            <span class="badge-qtd">${itens.length} itens</span>
        </div>
        <div class="itens-grid">
            <div class="item-header-row">
                <div></div>
                <div>Item / Descrição</div>
                <div>Melhor R$</div>
                <div>Nosso R$</div>
                <div>Valor Proposta</div>
                <div>Marca / Modelo</div>
                <div>Situação</div>
            </div>
    `;

    itens.forEach(item => {
        const num = item.numero;
        const dados = getValorItem(compraId, num);
        const sit = item.situacaoParticipante || '';
        const sitLabel = {
            G: 'Ganhando', P: 'Participando', C: 'Reafirmado',
            D: 'Desclassif.', I: 'Excluída', A: 'Desclassif.',
            F: 'Desclassif.', R: 'Recusada'
        }[sit] || sit || '-';

        html += `
            <div class="item-row ${dados.selecionado ? 'selecionado' : ''}" id="row-${compraId}-${num}">
                <div>
                    <input type="checkbox" class="item-checkbox"
                           id="chk-${compraId}-${num}"
                           ${dados.selecionado ? 'checked' : ''}
                           onchange="toggleItem('${compraId}', ${num})">
                </div>
                <div class="item-desc">
                    <span class="item-num">Item ${num}</span>
                    <span class="item-texto">${item.descricao || ''}</span>
                    ${item.valorEstimado ? `<span class="item-ref">Ref: ${fmtValor(item.valorEstimado)}</span>` : ''}
                </div>
                <div class="item-valor">${item.melhorValor != null ? fmtValor(item.melhorValor) : '-'}</div>
                <div class="item-valor ${sit === 'G' ? 'valor-ganhando' : sit === 'P' ? 'valor-participando' : ''}">
                    ${item.nossoValor != null ? fmtValor(item.nossoValor) : '-'}
                </div>
                <div class="item-input-cell">
                    <input type="number" step="0.01" min="0"
                           id="val-${compraId}-${num}"
                           value="${dados.valor || ''}"
                           placeholder="0,00"
                           onchange="atualizarValor('${compraId}', ${num}, this.value)"
                           onfocus="autoSelect('${compraId}', ${num})">
                </div>
                <div class="item-extras-cell">
                    <input type="text" id="marca-${compraId}-${num}" value="${dados.marca || ''}"
                           placeholder="Marca" onchange="atualizarExtra('${compraId}', ${num}, 'marca', this.value)">
                    <input type="text" id="modelo-${compraId}-${num}" value="${dados.modelo || ''}"
                           placeholder="Modelo" onchange="atualizarExtra('${compraId}', ${num}, 'modelo', this.value)">
                </div>
                <div>
                    <span class="badge-sit badge-sit-${sit}">${sitLabel}</span>
                </div>
            </div>
        `;
    });

    html += '</div>';
    return html;
}

// ==================== CARREGAR ITENS INDIVIDUAL ====================

async function carregarItens(compraId) {
    const container = document.getElementById(`itens-${compraId}`);
    container.innerHTML = '<div class="itens-loading">Carregando itens...</div>';

    try {
        const resp = await fetch(`/api/proposta/itens-compra/${compraId}`);
        const result = await resp.json();

        if (result.success && result.itens?.length > 0) {
            disputasData.set(compraId, {
                compraId,
                itens: result.itens,
                orgao: result.orgao || '',
                objeto: result.objeto || '',
            });
            container.innerHTML = renderizarItens(compraId, result.itens);
            // Mostrar actions
            const actions = document.getElementById(`actions-${compraId}`);
            if (actions) actions.style.display = '';
        } else {
            container.innerHTML = `<div class="empty-itens">
                ${result.error || 'Nenhum item encontrado'}
                <br><small>Fonte: ${result.fonte || 'api'}</small>
            </div>`;
        }
    } catch (error) {
        container.innerHTML = `<div class="empty-itens" style="color:#f44336;">
            Erro: ${error.message}
        </div>`;
    }
}

// ==================== INTERAÇÃO ====================

function toggleItem(compraId, numero) {
    const chk = document.getElementById(`chk-${compraId}-${numero}`);
    const row = document.getElementById(`row-${compraId}-${numero}`);
    setValorItem(compraId, numero, { selecionado: chk.checked });
    row.classList.toggle('selecionado', chk.checked);
    atualizarResumo();
}

function toggleSelectAll(compraId) {
    const chk = document.getElementById(`selectAll-${compraId}`);
    const disputa = disputasData.get(compraId);
    if (!disputa) return;

    disputa.itens.forEach(item => {
        setValorItem(compraId, item.numero, { selecionado: chk.checked });
        const itemChk = document.getElementById(`chk-${compraId}-${item.numero}`);
        const row = document.getElementById(`row-${compraId}-${item.numero}`);
        if (itemChk) itemChk.checked = chk.checked;
        if (row) row.classList.toggle('selecionado', chk.checked);
    });
    atualizarResumo();
}

function autoSelect(compraId, numero) {
    const chk = document.getElementById(`chk-${compraId}-${numero}`);
    if (!chk.checked) {
        chk.checked = true;
        toggleItem(compraId, numero);
    }
}

function atualizarValor(compraId, numero, valor) {
    setValorItem(compraId, numero, { valor: parseFloat(valor) || null });
    atualizarResumo();
}

function atualizarExtra(compraId, numero, campo, valor) {
    setValorItem(compraId, numero, { [campo]: valor });
}

// ==================== RESUMO ====================

function atualizarResumo() {
    const resumoDiv = document.getElementById('resumoGeral');
    const conteudo = document.getElementById('resumoConteudo');

    let totalItens = 0;
    let totalValor = 0;
    let comprasComItens = new Set();

    Object.entries(valoresLocais).forEach(([key, dados]) => {
        if (dados.selecionado && dados.valor > 0) {
            totalItens++;
            totalValor += dados.valor;
            comprasComItens.add(key.split(':')[0]);
        }
    });

    if (totalItens === 0) {
        resumoDiv.style.display = 'none';
        return;
    }

    resumoDiv.style.display = 'block';
    conteudo.innerHTML = `
        <div class="resumo-grid">
            <div class="resumo-item"><span>Licitações</span><span>${comprasComItens.size}</span></div>
            <div class="resumo-item"><span>Itens selecionados</span><span>${totalItens}</span></div>
            <div class="resumo-total"><span>TOTAL</span><span>${fmtValor(totalValor)}</span></div>
        </div>
    `;
}

// ==================== ENVIO ====================

async function enviarProposta(compraId) {
    const disputa = disputasData.get(compraId);
    if (!disputa) {
        alert('Carregue os itens primeiro.');
        return;
    }

    // Coletar itens selecionados
    const itensSelecionados = [];
    disputa.itens.forEach(item => {
        const dados = getValorItem(compraId, item.numero);
        if (dados.selecionado && dados.valor > 0) {
            itensSelecionados.push({
                numero: item.numero,
                valor: dados.valor,
                marca: dados.marca || '',
                modelo: dados.modelo || '',
                fabricante: dados.fabricante || '',
                descricao: item.descricao || '',
            });
        }
    });

    if (itensSelecionados.length === 0) {
        alert('Selecione ao menos um item com valor definido.');
        return;
    }

    // Abrir modal de envio
    const modal = document.getElementById('modalEnvio');
    const info = document.getElementById('envioInfo');
    const log = document.getElementById('envioLog');
    const msg = document.getElementById('envioMsg');
    const progress = document.getElementById('progressFill');
    const btnEnviar = document.getElementById('btnEnviar');

    const p = participacoesData.find(x => x.compraId === compraId);
    info.innerHTML = `
        <div class="envio-info-box">
            <div class="envio-objeto">${p?.objeto || disputa.objeto || ''}</div>
            <div class="envio-orgao">${p?.orgao || disputa.orgao || ''}</div>
            <div class="envio-meta">${compraId} | ${itensSelecionados.length} item(ns)</div>
        </div>
    `;

    log.innerHTML = '';
    msg.textContent = 'Clique em "Enviar" para enviar via API';
    progress.style.width = '0%';
    btnEnviar.disabled = false;
    btnEnviar.textContent = 'Enviar via API';
    btnEnviar.onclick = () => executarEnvio(compraId, itensSelecionados);

    modal.style.display = 'flex';
}

async function executarEnvio(compraId, itens) {
    const log = document.getElementById('envioLog');
    const msg = document.getElementById('envioMsg');
    const progress = document.getElementById('progressFill');
    const btn = document.getElementById('btnEnviar');

    btn.disabled = true;
    btn.textContent = 'Enviando...';
    log.innerHTML = '<div class="log-info">Enviando proposta via API do servidor...</div>';
    progress.style.width = '30%';

    try {
        const resp = await fetch('/api/proposta/enviar-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ compraId, itens })
        });

        const result = await resp.json();
        progress.style.width = '100%';

        if (result.success) {
            msg.innerHTML = `<span style="color:#4caf50;">${result.message}</span>`;
        } else {
            msg.innerHTML = `<span style="color:#f44336;">${result.error || result.message}</span>`;
        }

        // Mostrar resultados por item
        if (result.resultados) {
            result.resultados.forEach(r => {
                const cls = r.sucesso ? 'log-ok' : 'log-err';
                log.innerHTML += `<div class="${cls}">
                    Item ${r.numero}: ${r.sucesso ? 'OK' : 'Falha'}
                    ${r.status ? `(HTTP ${r.status})` : ''}
                    ${r.erro ? `- ${r.erro}` : ''}
                    ${r.endpoint ? `[${r.endpoint}]` : ''}
                </div>`;
            });
        }

        if (result.linkCadastroProposta) {
            log.innerHTML += `<div class="log-link">
                <a href="${result.linkCadastroProposta}" target="_blank" class="btn btn-sm btn-primary">
                    Abrir Cadastro de Proposta
                </a>
            </div>`;
        }

    } catch (error) {
        msg.innerHTML = `<span style="color:#f44336;">Erro de conexão: ${error.message}</span>`;
    }

    btn.disabled = false;
    btn.textContent = 'Enviar novamente';
}

function fecharModalEnvio() {
    document.getElementById('modalEnvio').style.display = 'none';
}

// ==================== CSV EXPORT ====================

function exportarCSVCompra(compraId) {
    const disputa = disputasData.get(compraId);
    if (!disputa || !disputa.itens) {
        alert('Carregue os itens primeiro.');
        return;
    }

    const p = participacoesData.find(x => x.compraId === compraId);

    let csv = 'Item;Descricao;MelhorValor;NossoValor;ValorProposta;Marca;Modelo;Situacao\n';

    disputa.itens.forEach(item => {
        const dados = getValorItem(compraId, item.numero);
        csv += [
            item.numero,
            `"${(item.descricao || '').replace(/"/g, '""')}"`,
            item.melhorValor != null ? item.melhorValor.toFixed(2).replace('.', ',') : '',
            item.nossoValor != null ? item.nossoValor.toFixed(2).replace('.', ',') : '',
            dados.valor ? dados.valor.toFixed(2).replace('.', ',') : '',
            `"${dados.marca || ''}"`,
            `"${dados.modelo || ''}"`,
            item.situacaoParticipante || ''
        ].join(';') + '\n';
    });

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `proposta_${compraId}_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

// ==================== UTILS ====================

function fmtValor(valor) {
    if (valor == null) return '-';
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
}

function formatarSituacao(sit) {
    const map = {
        'PD': 'Pendente', 'AB': 'Aberta', 'EN': 'Encerrada',
        'FR': 'Fracassada', 'PE': 'Proposta Enviada',
        '5': 'Em Andamento', '2': 'Encerrada',
    };
    return map[(sit || '').toUpperCase()] || sit || '-';
}

function formatarData(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (e) { return iso; }
}

// ==================== INIT ====================

document.addEventListener('DOMContentLoaded', () => {
    carregarParticipacoes();
    atualizarTokenStatus();
    // Atualizar token status a cada 30s
    setInterval(atualizarTokenStatus, 30000);
});
