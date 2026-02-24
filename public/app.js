// Mapa de licitações lidas
let licitacoesLidas = {};
// Mapa de licitações com interesse (valor = quantidade de itens)
let licitacoesComInteresse = {};
// Mapa de licitações sem interesse (key → {motivo, data})
let licitacoesSemInteresse = {};
let todasLicitacoesAtuais = [];

// Configuração da API local
const API_BASE_URL = '/api';

// Estado da aplicação
let currentPage = 1;
let currentFilters = {};
let totalResults = 0;

// Elementos do DOM
const searchForm = document.getElementById('searchForm');
const resultsContainer = document.getElementById('resultsContainer');
const loadingContainer = document.getElementById('loadingContainer');
const errorContainer = document.getElementById('errorContainer');
const resultsInfo = document.getElementById('resultsInfo');
const emptyState = document.getElementById('emptyState');
const paginationContainer = document.getElementById('paginationContainer');

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    // Definir datas padrão
    const hoje = new Date();

    // Publicação: último 1 ano até hoje
    const umAnoAtras = new Date(hoje);
    umAnoAtras.setFullYear(hoje.getFullYear() - 1);

    // Fim Propostas: hoje até próximos 30 dias

    const trintaDiasFrente = new Date(hoje);
    trintaDiasFrente.setDate(hoje.getDate() + 30);

    document.getElementById('dataPublicacaoInicial').valueAsDate = umAnoAtras;
    document.getElementById('dataPublicacaoFinal').valueAsDate = hoje;
    document.getElementById('dataAberturaInicial').valueAsDate = hoje;
    document.getElementById('dataAberturaFinal').valueAsDate = trintaDiasFrente;

    // Event listeners
    searchForm.addEventListener('submit', handleSearch);
    document.getElementById('btnPrevPage').addEventListener('click', () => changePage(-1));
    document.getElementById('btnNextPage').addEventListener('click', () => changePage(1));
});

/**
 * Handler para o formulário de busca
 */
async function handleSearch(event) {
    event.preventDefault();

    // Resetar página
    currentPage = 1;

    // Capturar filtros
    currentFilters = {
        numeroLicitacao: document.getElementById('numeroLicitacao').value.trim(),
        uasg: document.getElementById('uasg').value.trim(),
        palavraChave: document.getElementById('palavraChave').value.trim(),
        dataPublicacaoInicial: document.getElementById('dataPublicacaoInicial').value,
        dataPublicacaoFinal: document.getElementById('dataPublicacaoFinal').value,
        dataAberturaInicial: document.getElementById('dataAberturaInicial').value,
        dataAberturaFinal: document.getElementById('dataAberturaFinal').value,
        codigoModalidadeContratacao: document.getElementById('modalidade').value,
        palavraExclusao: document.getElementById('palavraExclusao').value.trim(),
        grupoExclusaoId: document.getElementById('grupoExclusao') ? document.getElementById('grupoExclusao').value : '',
        uf: document.getElementById('uf').value,
        portal: document.getElementById('portal').value,
        ordenacao: document.getElementById('ordenacao').value
    };

    await buscarLicitacoes();
}

/**
 * Buscar licitações na API
 */
async function buscarLicitacoes() {
    try {
        // Mostrar loading
        showLoading();
        hideError();
        hideResults();

        // Construir URL com parâmetros
        const params = new URLSearchParams({
            pagina: currentPage,
            tamanhoPagina: 50
        });

        if (currentFilters.numeroLicitacao) {
            params.append('numeroLicitacao', currentFilters.numeroLicitacao);
        }
        if (currentFilters.uasg) {
            params.append('uasg', currentFilters.uasg);
        }
        if (currentFilters.palavraChave) {
            params.append('palavraChave', currentFilters.palavraChave);
        }
        if (currentFilters.dataPublicacaoInicial) {
            params.append('dataPublicacaoInicial', currentFilters.dataPublicacaoInicial);
        }
        if (currentFilters.dataPublicacaoFinal) {
            params.append('dataPublicacaoFinal', currentFilters.dataPublicacaoFinal);
        }
        if (currentFilters.dataAberturaInicial) {
            params.append('dataAberturaInicial', currentFilters.dataAberturaInicial);
        }
        if (currentFilters.dataAberturaFinal) {
            params.append('dataAberturaFinal', currentFilters.dataAberturaFinal);
        }
        if (currentFilters.codigoModalidadeContratacao) {
            params.append('codigoModalidadeContratacao', currentFilters.codigoModalidadeContratacao);
        }
        if (currentFilters.palavraExclusao) {
            params.append('palavraExclusao', currentFilters.palavraExclusao);
        }
        if (currentFilters.grupoExclusaoId) {
            params.append('grupoExclusaoId', currentFilters.grupoExclusaoId);
        }
        if (currentFilters.uf) {
            params.append('uf', currentFilters.uf);
        }
        if (currentFilters.portal) {
            params.append('portal', currentFilters.portal);
        }
        if (currentFilters.ordenacao) {
            params.append('ordenacao', currentFilters.ordenacao);
        }

        console.log('Buscando licitações:', params.toString());

        // Fazer requisição
        const response = await fetch(`${API_BASE_URL}/licitacoes?${params.toString()}`);
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || 'Erro ao buscar licitações');
        }

        // Processar resultados
        hideLoading();

        if (result.data && result.data.data && result.data.data.length > 0) {
            displayResults(result.data.data);
            updateResultsInfo(result.data);
            showPagination();
        } else {
            showEmptyState();
        }

    } catch (error) {
        console.error('Erro ao buscar licitações:', error);
        hideLoading();
        showError(error.message || 'Erro ao buscar licitações. Tente novamente.');
    }
}

/**
 * Exibir resultados
 */
function displayResults(licitacoes) {
    resultsContainer.innerHTML = '';
    todasLicitacoesAtuais = licitacoes; // Armazenar para uso posterior

    licitacoes.forEach(licitacao => {
        const card = createLicitacaoCard(licitacao);
        resultsContainer.appendChild(card);
    });
    atualizarContadorLidas();
    aplicarFiltros();

    resultsContainer.style.display = 'grid';
}

/**
 * Criar card de licitação
 */
function createLicitacaoCard(licitacao) {
    const card = document.createElement('div');
    const cnpj = licitacao.orgaoEntidade?.cnpj;
    const ano = licitacao.anoCompra;
    const seq = licitacao.sequencialCompra;

    const lidaClass = isLida(cnpj, ano, seq) ? ' lida' : '';
    const interesseClass = hasInteresse(cnpj, ano, seq) ? ' com-interesse' : '';
    const semInteresseClass = isSemInteresse(cnpj, ano, seq) ? ' sem-interesse' : '';
    card.className = 'licitacao-card' + lidaClass + interesseClass + semInteresseClass;

    // Formatação de dados - usar modalidadeNome do banco se disponível
    const modalidade = licitacao.modalidadeNome || getModalidadeNome(licitacao.codigoModalidadeContratacao || licitacao.modalidadeId);
    const dataPublicacao = formatarData(licitacao.dataPublicacaoPncp);
    const dataAbertura = formatarDataHora(licitacao.dataEncerramentoProposta);
    const valorEstimado = licitacao.valorTotalEstimado ?
        formatarValor(licitacao.valorTotalEstimado) : 'Não informado';

    // Badges de status
    const qtdInteresse = getQtdInteresse(cnpj, ano, seq);
    const badgeLida = isLida(cnpj, ano, seq) ? '<span class="status-badge badge-lida">✓ Lida</span>' : '';
    const badgeInteresse = qtdInteresse > 0 ? `<span class="status-badge badge-interesse">⭐ ${qtdInteresse} item(s) de interesse</span>` : '';
    const siInfo = licitacoesSemInteresse[cnpj + '-' + ano + '-' + seq];
    const badgeSemInteresse = siInfo ? `<span class="status-badge badge-sem-interesse" title="${siInfo.motivo || ''}">🚫 Sem interesse</span>` : '';

    card.innerHTML = `
        <div class="licitacao-header">
            <div class="licitacao-titulo">
                ${licitacao.objetoCompra || 'Objeto não informado'}
            </div>
            <div class="licitacao-badges">
                ${badgeSemInteresse}${badgeInteresse}${badgeLida}
                <span class="licitacao-badge badge-modalidade">${modalidade}</span>
            </div>
        </div>

        <div class="licitacao-info">
            <div class="info-item">
                <span class="info-label">Número</span>
                <span class="info-value">${licitacao.numeroCompra || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Ano</span>
                <span class="info-value">${licitacao.anoCompra || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">UASG</span>
                <span class="info-value">${licitacao.unidadeOrgao?.codigoUnidade || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Esfera</span>
                <span class="info-value">${getEsferaNome(licitacao.orgaoEntidade?.esferaId)}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Publicação</span>
                <span class="info-value">${dataPublicacao}</span>
            </div>
            <div class="info-item" style="background: #fff3e0;">
                <span class="info-label" style="color: #e65100;">Fim Propostas</span>
                <span class="info-value" style="color: #e65100; font-weight: bold;">${dataAbertura || 'N/A'}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Situação</span>
                <span class="info-value">${licitacao.situacaoCompra || 'N/A'}</span>
            </div>
        </div>

        ${licitacao.orgaoEntidade ? `
        <div class="licitacao-objeto">
            <div class="objeto-label">Órgão</div>
            <div class="objeto-text">
                ${licitacao.orgaoEntidade.razaoSocial || 'Não informado'}
                ${licitacao.orgaoEntidade.cnpj ? `<br>CNPJ: ${formatarCNPJ(licitacao.orgaoEntidade.cnpj)}` : ''}
                ${licitacao.unidadeOrgao?.nomeUnidade ? `<br>Unidade: ${licitacao.unidadeOrgao.nomeUnidade}` : ''}
                ${licitacao.unidadeOrgao?.municipioNome && licitacao.unidadeOrgao?.ufSigla ? `<br>Local: ${licitacao.unidadeOrgao.municipioNome}/${licitacao.unidadeOrgao.ufSigla}` : ''}
            </div>
        </div>
        ` : ''}

        <div class="licitacao-footer">
            <div>
                <div class="info-label">Valor Estimado</div>
                <div class="valor-estimado">${valorEstimado}</div>
            </div>
            <div>
                <button class="btn-marcar-lida${isLida(licitacao.orgaoEntidade?.cnpj, licitacao.anoCompra, licitacao.sequencialCompra) ? ' lida' : ''}"
                        onclick="toggleLida('${licitacao.orgaoEntidade?.cnpj}', ${licitacao.anoCompra}, ${licitacao.sequencialCompra}, this)">
                        ${isLida(licitacao.orgaoEntidade?.cnpj, licitacao.anoCompra, licitacao.sequencialCompra) ? '✓ Lida' : '👁 Marcar lida'}
                    </button>
                    <button class="btn-sem-interesse${isSemInteresse(cnpj, ano, seq) ? ' marcado' : ''}"
                        onclick="toggleSemInteresse('${cnpj}', ${ano}, ${seq}, this)">
                        ${isSemInteresse(cnpj, ano, seq) ? '🚫 Sem interesse' : '🚫 Não tenho interesse'}
                    </button>
                    <button class="btn-ver-itens" onclick="abrirModalItens('${licitacao.orgaoEntidade?.cnpj || ''}', ${licitacao.anoCompra || 0}, ${licitacao.sequencialCompra || 0})">Ver Itens</button>
                ${licitacao.linkSistemaOrigem ? `
                    <a href="${licitacao.linkSistemaOrigem}" target="_blank">
                        <button class="btn-detalhes">Abrir no Sistema</button>
                    </a>
                ` : `
                    <a href="https://pncp.gov.br/app/editais/${licitacao.orgaoEntidade?.cnpj || licitacao.cnpj}/${licitacao.anoCompra}/${String(licitacao.sequencialCompra).padStart(6, '0')}" target="_blank">
                        <button class="btn-detalhes" style="background: #ff9800;">Ver no PNCP</button>
                    </a>
                `}
            </div>
        </div>
    `;

    return card;
}

/**
 * Atualizar informações de resultados
 */
function updateResultsInfo(data) {
    const count = data.data ? data.data.length : 0;
    document.getElementById('resultsCount').textContent = count;
    document.getElementById('currentPage').textContent = currentPage;
    document.getElementById('pageNumber').textContent = currentPage;

    resultsInfo.style.display = 'flex';
}

/**
 * Mudar página
 */
async function changePage(direction) {
    currentPage += direction;
    if (currentPage < 1) {
        currentPage = 1;
        return;
    }

    await buscarLicitacoes();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Limpar filtros
 */
function limparFiltros() {
    document.getElementById('searchForm').reset();
    document.getElementById('palavraExclusao').value = '';

    // Redefinir datas padrão
    const hoje = new Date();

    // Publicação: último 1 ano até hoje
    const umAnoAtras = new Date(hoje);
    umAnoAtras.setFullYear(hoje.getFullYear() - 1);

    // Fim Propostas: hoje até próximos 30 dias

    const trintaDiasFrente = new Date(hoje);
    trintaDiasFrente.setDate(hoje.getDate() + 30);

    document.getElementById('dataPublicacaoInicial').valueAsDate = umAnoAtras;
    document.getElementById('dataPublicacaoFinal').valueAsDate = hoje;
    document.getElementById('dataAberturaInicial').valueAsDate = hoje;
    document.getElementById('dataAberturaFinal').valueAsDate = trintaDiasFrente;

    // Limpar resultados
    currentPage = 1;
    currentFilters = {};
    hideResults();
    hideError();
}

/**
 * Funções de exibição
 */
function showLoading() {
    loadingContainer.style.display = 'block';
    document.getElementById('btnBuscar').disabled = true;
}

function hideLoading() {
    loadingContainer.style.display = 'none';
    document.getElementById('btnBuscar').disabled = false;
}

function showError(message) {
    errorContainer.innerHTML = `<div class="error-message">${message}</div>`;
    errorContainer.style.display = 'block';
}

function hideError() {
    errorContainer.style.display = 'none';
    errorContainer.innerHTML = '';
}

function hideResults() {
    resultsContainer.style.display = 'none';
    resultsInfo.style.display = 'none';
    paginationContainer.style.display = 'none';
    emptyState.style.display = 'none';
}

function showEmptyState() {
    resultsContainer.style.display = 'none';
    resultsInfo.style.display = 'none';
    paginationContainer.style.display = 'none';
    emptyState.style.display = 'block';
}

function showPagination() {
    paginationContainer.style.display = 'flex';

    const btnPrev = document.getElementById('btnPrevPage');
    btnPrev.disabled = currentPage === 1;
}

/**
 * Funções auxiliares de formatação
 */
function formatarDataHora(dataISO) {
    if (!dataISO) return null;
    try {
        const data = new Date(dataISO);
        if (isNaN(data.getTime())) return null;
        const dia = String(data.getDate()).padStart(2, '0');
        const mes = String(data.getMonth() + 1).padStart(2, '0');
        const ano = data.getFullYear();
        const hora = String(data.getHours()).padStart(2, '0');
        const min = String(data.getMinutes()).padStart(2, '0');
        return dia + '/' + mes + '/' + ano + ' ' + hora + ':' + min;
    } catch (e) {
        return null;
    }
}

function formatarData(dataISO) {
    if (!dataISO) return 'N/A';

    try {
        const data = new Date(dataISO);
        return data.toLocaleDateString('pt-BR');
    } catch (e) {
        return dataISO;
    }
}

function formatarValor(valor) {
    if (!valor || valor === 0) return 'Não informado';

    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(valor);
}

function formatarCNPJ(cnpj) {
    if (!cnpj) return '';

    // Remove caracteres não numéricos
    cnpj = cnpj.replace(/\D/g, '');

    // Aplica máscara XX.XXX.XXX/XXXX-XX
    return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function getModalidadeNome(codigo) {
    const modalidades = {
        1: 'Concorrência',
        2: 'Tomada de Preços',
        3: 'Convite',
        4: 'Concurso',
        5: 'Leilão',
        6: 'Pregão',
        7: 'Dispensa de Licitação',
        8: 'Inexigibilidade',
        9: 'Diálogo Competitivo'
    };

    return modalidades[codigo] || 'Não especificada';
}

function getEsferaNome(esferaId) {
    const esferas = {
        'F': 'Federal',
        'E': 'Estadual',
        'M': 'Municipal',
        'D': 'Distrital'
    };

    return esferas[esferaId] || 'N/A';
}


// ==================== FUNCOES DO MODAL DE ITENS ====================

let currentLicitacao = null;
let itensSelecionados = new Set();

async function abrirModalItens(cnpj, ano, sequencial) {
    // Buscar dados completos da licitação no array
    const licitacaoCompleta = todasLicitacoesAtuais.find(l =>
        (l.orgaoEntidade?.cnpj === cnpj || l.cnpj === cnpj) &&
        l.anoCompra === ano &&
        l.sequencialCompra === sequencial
    );

    currentLicitacao = {
        cnpj,
        ano,
        sequencial,
        objetoCompra: licitacaoCompleta?.objetoCompra || 'Licitação',
        orgao: licitacaoCompleta?.orgaoEntidade?.razaoSocial || licitacaoCompleta?.razaoSocial || '',
        dataEncerramentoProposta: licitacaoCompleta?.dataEncerramentoProposta || null,
        linkSistemaOrigem: licitacaoCompleta?.linkSistemaOrigem || null
    };
    itensSelecionados = new Set();

    // Marcar automaticamente como lida ao ver itens
    marcarComoLida(cnpj, ano, sequencial);

    const modal = document.getElementById('modalItens');
    const modalBody = document.getElementById('modalBody');
    const modalSubtitle = document.getElementById('modalSubtitle');

    modalSubtitle.textContent = "CNPJ: " + cnpj + " | Ano: " + ano + " | Seq: " + sequencial;
    modalBody.innerHTML = '<div class="loading-itens">Carregando itens...</div>';
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden';

    atualizarContadorSelecionados();

    try {
        const response = await fetch(API_BASE_URL + '/licitacoes/' + cnpj + '/' + sequencial + '/' + ano + '/itens');
        const result = await response.json();

        if (result.success && result.data && result.data.length > 0) {
            renderizarItens(result.data);
        } else {
            modalBody.innerHTML = '<div class="no-itens">Nenhum item encontrado para esta licitacao.</div>';
        }
    } catch (error) {
        console.error('Erro ao buscar itens:', error);
        modalBody.innerHTML = '<div class="no-itens">Erro ao carregar itens. Tente novamente.</div>';
    }
}

// Armazena todos os itens para filtragem
let todosItensLicitacao = [];

function renderizarItens(itens) {
    todosItensLicitacao = itens;
    const modalBody = document.getElementById('modalBody');

    // Barra de filtros
    let html = `
        <div class="filtros-itens">
            <div class="filtro-grupo">
                <input type="text" id="filtroDescricao" placeholder="Buscar na descrição..."
                       onkeyup="aplicarFiltrosItens()" class="filtro-input">
            </div>
            <div class="filtro-grupo">
                <input type="number" id="filtroValorMin" placeholder="Valor mín."
                       onchange="aplicarFiltrosItens()" class="filtro-input filtro-valor" step="0.01">
                <span>até</span>
                <input type="number" id="filtroValorMax" placeholder="Valor máx."
                       onchange="aplicarFiltrosItens()" class="filtro-input filtro-valor" step="0.01">
            </div>
            <button onclick="limparFiltrosItens()" class="btn-limpar-filtros">Limpar Filtros</button>
            <span class="filtro-resultado" id="filtroResultado">${itens.length} itens</span>
        </div>
    `;

    html += renderizarTabelaItens(itens);
    modalBody.innerHTML = html;
}

function highlightTexto(texto, busca) {
    if (!busca || !texto) return texto;
    const regex = new RegExp('(' + busca.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return texto.replace(regex, '<mark class="highlight">$1</mark>');
}

function renderizarTabelaItens(itens, termoBusca) {
    const busca = termoBusca || '';

    let html = '<table class="itens-table"><thead><tr>' +
        '<th><input type="checkbox" id="selecionarTodos" onchange="toggleSelecionarTodos(this)"></th>' +
        '<th>Item</th><th>Descricao</th><th>Descricao Detalhada</th>' +
        '<th>Qtd</th><th>Valor Unit.</th><th>Valor Total</th></tr></thead><tbody>';

    itens.forEach(function(item) {
        var valorUnit = item.valorUnitarioEstimado ? formatarValor(item.valorUnitarioEstimado) : 'N/A';
        var valorTotal = item.valorTotal ? formatarValor(item.valorTotal) : 'N/A';
        var selecionado = itensSelecionados.has(item.numeroItem) ? 'item-selecionado' : '';
        var checked = itensSelecionados.has(item.numeroItem) ? 'checked' : '';

        var descricao = highlightTexto(item.descricao || 'N/A', busca);
        var descricaoDetalhada = highlightTexto(item.descricaoDetalhada || item.descricao || 'N/A', busca);

        html += '<tr id="item-row-' + item.numeroItem + '" class="' + selecionado + '">' +
            '<td style="text-align: center;"><input type="checkbox" class="item-checkbox" data-numero="' + item.numeroItem + '" ' + checked + ' onchange="toggleItemSelecionado(' + item.numeroItem + ')"></td>' +
            '<td class="item-numero">' + (item.numeroItem || 'N/A') + '</td>' +
            '<td class="item-descricao">' + descricao + '</td>' +
            '<td class="item-descricao-detalhada">' + descricaoDetalhada + '</td>' +
            '<td class="item-quantidade">' + (item.quantidade || 'N/A') + ' ' + (item.unidadeMedida || '') + '</td>' +
            '<td class="item-valor">' + valorUnit + '</td>' +
            '<td class="item-valor">' + valorTotal + '</td></tr>';
    });

    html += '</tbody></table>';
    return html;
}

function aplicarFiltrosItens() {
    const descricao = (document.getElementById('filtroDescricao').value || '');
    const descricaoLower = descricao.toLowerCase();
    const valorMin = parseFloat(document.getElementById('filtroValorMin').value) || 0;
    const valorMax = parseFloat(document.getElementById('filtroValorMax').value) || Infinity;

    const itensFiltrados = todosItensLicitacao.filter(item => {
        const textoItem = ((item.descricao || '') + ' ' + (item.descricaoDetalhada || '')).toLowerCase();
        const valorItem = item.valorUnitarioEstimado || 0;

        const matchDescricao = !descricaoLower || textoItem.includes(descricaoLower);
        const matchValor = valorItem >= valorMin && valorItem <= valorMax;

        return matchDescricao && matchValor;
    });

    // Atualizar apenas a tabela, mantendo os filtros, passando o termo de busca para highlight
    const tabela = document.querySelector('.itens-table');
    if (tabela) {
        tabela.outerHTML = renderizarTabelaItens(itensFiltrados, descricao);
    }

    // Atualizar contador
    document.getElementById('filtroResultado').textContent =
        itensFiltrados.length + ' de ' + todosItensLicitacao.length + ' itens';
}

function limparFiltrosItens() {
    document.getElementById('filtroDescricao').value = '';
    document.getElementById('filtroValorMin').value = '';
    document.getElementById('filtroValorMax').value = '';
    aplicarFiltrosItens();
}

function toggleItemSelecionado(numeroItem) {
    var row = document.getElementById('item-row-' + numeroItem);
    
    if (itensSelecionados.has(numeroItem)) {
        itensSelecionados.delete(numeroItem);
        row.classList.remove('item-selecionado');
    } else {
        itensSelecionados.add(numeroItem);
        row.classList.add('item-selecionado');
    }
    
    atualizarContadorSelecionados();
}

function toggleSelecionarTodos(checkbox) {
    var checkboxes = document.querySelectorAll('.item-checkbox');
    
    checkboxes.forEach(function(cb) {
        var numeroItem = parseInt(cb.dataset.numero);
        var row = document.getElementById('item-row-' + numeroItem);
        
        if (checkbox.checked) {
            cb.checked = true;
            itensSelecionados.add(numeroItem);
            row.classList.add('item-selecionado');
        } else {
            cb.checked = false;
            itensSelecionados.delete(numeroItem);
            row.classList.remove('item-selecionado');
        }
    });
    
    atualizarContadorSelecionados();
}

function atualizarContadorSelecionados() {
    document.getElementById('qtdSelecionados').textContent = itensSelecionados.size;
}

function fecharModal() {
    document.getElementById('modalItens').style.display = 'none';
    document.body.style.overflow = 'auto';
    currentLicitacao = null;
    itensSelecionados = new Set();
}

async function salvarInteresse() {
    if (itensSelecionados.size === 0) {
        alert('Selecione pelo menos um item para salvar.');
        return;
    }

    try {
        const response = await fetch(API_BASE_URL + '/interesse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cnpj: currentLicitacao.cnpj,
                ano: currentLicitacao.ano,
                sequencial: currentLicitacao.sequencial,
                itens: Array.from(itensSelecionados)
            })
        });

        const result = await response.json();

        if (result.success) {
            // Atualizar mapa local de interesses
            const key = currentLicitacao.cnpj + '-' + currentLicitacao.ano + '-' + currentLicitacao.sequencial;
            const qtdAtual = licitacoesComInteresse[key] || 0;
            licitacoesComInteresse[key] = qtdAtual + itensSelecionados.size;

            // Atualizar visual do card
            atualizarCardInteresse(currentLicitacao.cnpj, currentLicitacao.ano, currentLicitacao.sequencial);

            // Perguntar se quer adicionar ao Google Calendar
            if (currentLicitacao.dataEncerramentoProposta) {
                const adicionarCalendario = confirm(
                    itensSelecionados.size + ' item(s) salvos com sucesso!\n\n' +
                    'Deseja adicionar esta licitação ao Google Calendar?'
                );

                if (adicionarCalendario) {
                    abrirGoogleCalendar(currentLicitacao);
                }
            } else {
                alert(itensSelecionados.size + ' item(s) salvos com sucesso!');
            }
            fecharModal();
        } else {
            throw new Error(result.error || 'Erro ao salvar interesse');
        }
    } catch (error) {
        console.error('Erro ao salvar interesse:', error);
        alert('Erro ao salvar interesse. Tente novamente.');
    }
}

/**
 * Gerar link e abrir Google Calendar para adicionar evento
 */
function abrirGoogleCalendar(licitacao) {
    if (!licitacao.dataEncerramentoProposta) return;

    const dataEnc = new Date(licitacao.dataEncerramentoProposta);

    // Formatar data para o Google Calendar (YYYYMMDDTHHmmssZ)
    const formatarDataGoogle = (date) => {
        return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };

    // Evento começa 1 hora antes do encerramento (para lembrete)
    const dataInicio = new Date(dataEnc.getTime() - 60 * 60 * 1000);
    const dataFim = dataEnc;

    const titulo = encodeURIComponent('Licitação: ' + (licitacao.objetoCompra || '').substring(0, 100));
    const descricao = encodeURIComponent(
        'Órgão: ' + (licitacao.orgao || 'Não informado') + '\n' +
        'CNPJ: ' + licitacao.cnpj + '\n' +
        'Ano: ' + licitacao.ano + ' | Sequencial: ' + licitacao.sequencial + '\n\n' +
        (licitacao.linkSistemaOrigem ? 'Link: ' + licitacao.linkSistemaOrigem : 'Ver no PNCP: https://pncp.gov.br/app/editais/' + licitacao.cnpj + '/' + licitacao.ano + '/' + String(licitacao.sequencial).padStart(6, '0'))
    );
    const local = encodeURIComponent(licitacao.orgao || '');

    const googleCalendarUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
        '&text=' + titulo +
        '&dates=' + formatarDataGoogle(dataInicio) + '/' + formatarDataGoogle(dataFim) +
        '&details=' + descricao +
        '&location=' + local;

    window.open(googleCalendarUrl, '_blank');
}

document.addEventListener('click', function(e) {
    var modal = document.getElementById('modalItens');
    if (e.target === modal) {
        fecharModal();
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        fecharModal();
    }
});


// ========================================
// Funções para licitações lidas
// ========================================

async function carregarLidas() {
    try {
        const response = await fetch('/api/lidas');
        const data = await response.json();
        if (data.success) {
            licitacoesLidas = data.data;
            atualizarContadorLidas();
        }
    } catch (error) {
        console.error('Erro ao carregar lidas:', error);
    }
}

function isLida(cnpj, ano, sequencial) {
    return licitacoesLidas[cnpj + '-' + ano + '-' + sequencial] === true;
}

// Funções para licitações com interesse
async function carregarInteresses() {
    try {
        const response = await fetch('/api/interesses/licitacoes');
        const data = await response.json();
        if (data.success) {
            licitacoesComInteresse = data.data;
        }
    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
    }
}

function hasInteresse(cnpj, ano, sequencial) {
    return licitacoesComInteresse[cnpj + '-' + ano + '-' + sequencial] > 0;
}

function getQtdInteresse(cnpj, ano, sequencial) {
    return licitacoesComInteresse[cnpj + '-' + ano + '-' + sequencial] || 0;
}

function atualizarCardInteresse(cnpj, ano, sequencial) {
    // Encontrar o card correspondente e atualizar visual
    const cards = document.querySelectorAll('.licitacao-card');
    cards.forEach(card => {
        const btnVerItens = card.querySelector('.btn-ver-itens');
        if (btnVerItens) {
            const onclick = btnVerItens.getAttribute('onclick');
            if (onclick && onclick.includes(cnpj) && onclick.includes(ano) && onclick.includes(sequencial)) {
                // Adicionar classe de interesse
                card.classList.add('com-interesse');

                // Atualizar ou adicionar badge de interesse
                const badgesDiv = card.querySelector('.licitacao-badges');
                if (badgesDiv) {
                    const qtd = getQtdInteresse(cnpj, ano, sequencial);
                    let badgeInteresse = badgesDiv.querySelector('.badge-interesse');
                    if (badgeInteresse) {
                        badgeInteresse.textContent = `⭐ ${qtd} item(s) de interesse`;
                    } else {
                        const newBadge = document.createElement('span');
                        newBadge.className = 'status-badge badge-interesse';
                        newBadge.textContent = `⭐ ${qtd} item(s) de interesse`;
                        badgesDiv.insertBefore(newBadge, badgesDiv.firstChild);
                    }
                }
            }
        }
    });
}

async function toggleLida(cnpj, ano, sequencial, btn) {
    const key = cnpj + '-' + ano + '-' + sequencial;
    const jaLida = licitacoesLidas[key];

    try {
        if (jaLida) {
            // Desmarcar
            await fetch('/api/lida/' + cnpj + '/' + ano + '/' + sequencial, { method: 'DELETE' });
            delete licitacoesLidas[key];
            btn.textContent = '👁 Marcar lida';
            btn.classList.remove('lida');
            btn.closest('.licitacao-card').classList.remove('lida');
        } else {
            // Marcar como lida
            await fetch('/api/lida', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cnpj, ano, sequencial })
            });
            licitacoesLidas[key] = true;
            btn.textContent = '✓ Lida';
            btn.classList.add('lida');
            btn.closest('.licitacao-card').classList.add('lida');
        }
        atualizarContadorLidas();
        aplicarFiltroLidas();
    } catch (error) {
        console.error('Erro ao alternar lida:', error);
    }
}

/**
 * Marcar licitação como lida (sem alternar)
 */
async function marcarComoLida(cnpj, ano, sequencial) {
    const key = cnpj + '-' + ano + '-' + sequencial;

    // Se já está lida, não faz nada
    if (licitacoesLidas[key]) return;

    try {
        await fetch('/api/lida', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpj, ano, sequencial })
        });
        licitacoesLidas[key] = true;

        // Atualizar o botão e card na interface
        const btns = document.querySelectorAll('.btn-marcar-lida');
        btns.forEach(btn => {
            const onclickStr = btn.getAttribute('onclick') || '';
            if (onclickStr.includes(cnpj) && onclickStr.includes(String(ano)) && onclickStr.includes(String(sequencial))) {
                btn.textContent = '✓ Lida';
                btn.classList.add('lida');
                const card = btn.closest('.licitacao-card');
                if (card) card.classList.add('lida');
            }
        });

        atualizarContadorLidas();
    } catch (error) {
        console.error('Erro ao marcar como lida:', error);
    }
}

function atualizarContadorLidas() {
    const total = todasLicitacoesAtuais.length;
    const lidas = todasLicitacoesAtuais.filter(l =>
        isLida(l.orgaoEntidade?.cnpj, l.anoCompra, l.sequencialCompra)
    ).length;

    const el = document.getElementById('lidasCount');
    if (el && total > 0) {
        el.textContent = '(' + lidas + ' lidas, ' + (total - lidas) + ' não lidas)';
    }
}

// ========================================
// Funções para licitações sem interesse
// ========================================

async function carregarSemInteresse() {
    try {
        const response = await fetch('/api/sem-interesse');
        const data = await response.json();
        if (data.success) {
            licitacoesSemInteresse = data.data;
        }
    } catch (error) {
        console.error('Erro ao carregar sem interesse:', error);
    }
}

function isSemInteresse(cnpj, ano, sequencial) {
    return !!licitacoesSemInteresse[cnpj + '-' + ano + '-' + sequencial];
}

function toggleSemInteresse(cnpj, ano, sequencial, btn) {
    if (isSemInteresse(cnpj, ano, sequencial)) {
        removerSemInteresse(cnpj, ano, sequencial, btn);
    } else {
        abrirModalSemInteresse(cnpj, ano, sequencial);
    }
}

function abrirModalSemInteresse(cnpj, ano, sequencial) {
    const modal = document.getElementById('modalSemInteresse');
    modal.dataset.cnpj = cnpj;
    modal.dataset.ano = ano;
    modal.dataset.sequencial = sequencial;
    document.getElementById('motivoSemInteresse').value = '';
    modal.style.display = 'flex';
}

function fecharModalSemInteresse() {
    document.getElementById('modalSemInteresse').style.display = 'none';
}

async function confirmarSemInteresse() {
    const modal = document.getElementById('modalSemInteresse');
    const cnpj = modal.dataset.cnpj;
    const ano = parseInt(modal.dataset.ano);
    const sequencial = parseInt(modal.dataset.sequencial);
    const motivo = document.getElementById('motivoSemInteresse').value.trim();

    try {
        const response = await fetch('/api/sem-interesse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpj, ano, sequencial, motivo: motivo || null })
        });
        const data = await response.json();
        if (data.success) {
            licitacoesSemInteresse[cnpj + '-' + ano + '-' + sequencial] = { motivo: motivo || null, data: new Date().toISOString() };
            atualizarCardSemInteresse(cnpj, ano, sequencial, true);
            fecharModalSemInteresse();
            aplicarFiltros();
        }
    } catch (error) {
        console.error('Erro ao marcar sem interesse:', error);
    }
}

async function removerSemInteresse(cnpj, ano, sequencial, btn) {
    try {
        const response = await fetch(`/api/sem-interesse/${cnpj}/${ano}/${sequencial}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            delete licitacoesSemInteresse[cnpj + '-' + ano + '-' + sequencial];
            atualizarCardSemInteresse(cnpj, ano, sequencial, false);
            aplicarFiltros();
        }
    } catch (error) {
        console.error('Erro ao remover sem interesse:', error);
    }
}

function atualizarCardSemInteresse(cnpj, ano, sequencial, marcado) {
    const cards = document.querySelectorAll('.licitacao-card');
    cards.forEach(card => {
        const btnSI = card.querySelector('.btn-sem-interesse');
        if (!btnSI) return;
        const onclick = btnSI.getAttribute('onclick') || '';
        if (onclick.includes(cnpj) && onclick.includes(String(ano)) && onclick.includes(String(sequencial))) {
            if (marcado) {
                card.classList.add('sem-interesse');
                btnSI.classList.add('marcado');
                btnSI.textContent = '🚫 Sem interesse';
                // Add badge
                const badgesDiv = card.querySelector('.licitacao-badges');
                if (badgesDiv && !badgesDiv.querySelector('.badge-sem-interesse')) {
                    const badge = document.createElement('span');
                    badge.className = 'status-badge badge-sem-interesse';
                    const info = licitacoesSemInteresse[cnpj + '-' + ano + '-' + sequencial];
                    badge.title = info?.motivo || '';
                    badge.textContent = '🚫 Sem interesse';
                    badgesDiv.insertBefore(badge, badgesDiv.firstChild);
                }
            } else {
                card.classList.remove('sem-interesse');
                btnSI.classList.remove('marcado');
                btnSI.textContent = '🚫 Não tenho interesse';
                const badge = card.querySelector('.badge-sem-interesse');
                if (badge) badge.remove();
            }
        }
    });
}

function aplicarFiltroLidas() {
    aplicarFiltros();
}

function aplicarFiltros() {
    const filtroNaoLidas = document.getElementById('filtroNaoLidas')?.checked;
    const filtroComInteresse = document.getElementById('filtroComInteresse')?.checked;
    const filtroSemInteresse = document.getElementById('filtroSemInteresse')?.checked;
    const cards = document.querySelectorAll('.licitacao-card');
    let visiveis = 0;

    cards.forEach(card => {
        let mostrar = true;

        // Filtro de não lidas
        if (filtroNaoLidas && card.classList.contains('lida')) {
            mostrar = false;
        }

        // Filtro de com interesse
        if (filtroComInteresse && !card.classList.contains('com-interesse')) {
            mostrar = false;
        }

        // Filtro ocultar sem interesse
        if (filtroSemInteresse && card.classList.contains('sem-interesse')) {
            mostrar = false;
        }

        card.style.display = mostrar ? '' : 'none';
        if (mostrar) visiveis++;
    });

    // Atualizar contador de visíveis
    const countEl = document.getElementById('resultsCount');
    if (countEl && (filtroNaoLidas || filtroComInteresse || filtroSemInteresse)) {
        const total = cards.length;
        countEl.textContent = visiveis + ' de ' + total;
    }
}

// Carregar lidas, interesses e sem interesse ao iniciar
document.addEventListener('DOMContentLoaded', () => {
    carregarLidas();
    carregarInteresses();
    carregarSemInteresse();
});
