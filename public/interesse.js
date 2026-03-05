// Dados globais para filtro
let todasLicitacoes = [];

async function carregarInteresses() {
    const loadingContainer = document.getElementById('loadingContainer');
    const interessesContainer = document.getElementById('interessesContainer');
    const emptyState = document.getElementById('emptyState');
    const totalInfo = document.getElementById('totalInfo');
    const filtroBar = document.getElementById('filtroBar');

    try {
        const response = await fetch('/api/interesse');
        const result = await response.json();
        const interesses = result.data || [];

        loadingContainer.style.display = 'none';

        if (interesses.length === 0) {
            emptyState.style.display = 'block';
            return;
        }

        // Agrupar por licitação
        const licitacoesMap = new Map();

        interesses.forEach(item => {
            const key = item.cnpj + '-' + item.ano + '-' + item.sequencial;
            if (!licitacoesMap.has(key)) {
                licitacoesMap.set(key, {
                    cnpj: item.cnpj,
                    ano: item.ano,
                    sequencial: item.sequencial,
                    numeroCompra: item.numeroCompra || '',
                    objetoCompra: item.objetoCompra || 'Objeto não disponível',
                    nomeOrgao: item.nomeOrgao || 'Órgão não disponível',
                    codigoUnidadeCompradora: item.codigoUnidadeCompradora || '',
                    linkSistemaOrigem: item.linkSistemaOrigem || '',
                    dataAberturaProposta: item.dataAberturaProposta || null,
                    dataEncerramentoProposta: item.dataEncerramentoProposta || null,
                    itens: []
                });
            }
            licitacoesMap.get(key).itens.push({
                id: item.id,
                numeroItem: item.numeroItem,
                descricao: item.descricao || 'Item ' + item.numeroItem,
                valorUnitarioEstimado: item.valorUnitarioEstimado || 0,
                quantidade: item.quantidade || 1
            });
        });

        todasLicitacoes = Array.from(licitacoesMap.values());
        filtroBar.style.display = 'flex';
        aplicarFiltro();

    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
        loadingContainer.innerHTML = '<h3 style="color: #f44336;">Erro ao carregar interesses</h3>';
    }
}

function aplicarFiltro() {
    const periodo = document.getElementById('filtroPeriodo').value;
    const dataDe = document.getElementById('filtroDataDe');
    const dataAte = document.getElementById('filtroDataAte');
    const ateLabel = document.getElementById('filtroAte');
    const personalizado = periodo === 'personalizado';

    dataDe.style.display = personalizado ? '' : 'none';
    dataAte.style.display = personalizado ? '' : 'none';
    ateLabel.style.display = personalizado ? '' : 'none';

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    let filtradas = todasLicitacoes;

    if (periodo === 'hoje') {
        const amanha = new Date(hoje);
        amanha.setDate(amanha.getDate() + 1);
        filtradas = todasLicitacoes.filter(l => {
            if (!l.dataEncerramentoProposta) return false;
            const d = new Date(l.dataEncerramentoProposta);
            return d >= hoje && d < amanha;
        });
    } else if (periodo === 'semana') {
        const fim = new Date(hoje);
        fim.setDate(fim.getDate() + 7);
        filtradas = todasLicitacoes.filter(l => {
            if (!l.dataEncerramentoProposta) return false;
            const d = new Date(l.dataEncerramentoProposta);
            return d >= hoje && d < fim;
        });
    } else if (periodo === 'mes') {
        const fim = new Date(hoje);
        fim.setDate(fim.getDate() + 30);
        filtradas = todasLicitacoes.filter(l => {
            if (!l.dataEncerramentoProposta) return false;
            const d = new Date(l.dataEncerramentoProposta);
            return d >= hoje && d < fim;
        });
    } else if (periodo === 'vencidas') {
        filtradas = todasLicitacoes.filter(l => {
            if (!l.dataEncerramentoProposta) return false;
            const d = new Date(l.dataEncerramentoProposta);
            return d < hoje;
        });
    } else if (periodo === 'personalizado') {
        const de = dataDe.value ? new Date(dataDe.value + 'T00:00:00') : null;
        const ate = dataAte.value ? new Date(dataAte.value + 'T23:59:59') : null;
        filtradas = todasLicitacoes.filter(l => {
            if (!l.dataEncerramentoProposta) return false;
            const d = new Date(l.dataEncerramentoProposta);
            if (de && d < de) return false;
            if (ate && d > ate) return false;
            return true;
        });
    }

    renderizarLicitacoes(filtradas);

    const info = document.getElementById('filtroInfo');
    if (periodo === 'todas') {
        info.textContent = '';
    } else {
        info.textContent = `Mostrando ${filtradas.length} de ${todasLicitacoes.length} licitações`;
    }
}

function formatarData(dataStr) {
    if (!dataStr) return null;
    const d = new Date(dataStr);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function badgeEncerramento(dataStr) {
    if (!dataStr) return '<span class="data-abertura-badge sem-data">Sem prazo</span>';
    const d = new Date(dataStr);
    const agora = new Date();
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);

    if (d < agora) {
        return `<span class="data-abertura-badge passado">Prazo encerrado</span>`;
    } else if (d < amanha) {
        return `<span class="data-abertura-badge hoje">Hoje ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>`;
    } else {
        const dias = Math.ceil((d - hoje) / 86400000);
        return `<span class="data-abertura-badge futuro">Faltam ${dias} dia${dias > 1 ? 's' : ''}</span>`;
    }
}

function renderizarLicitacoes(licitacoes) {
    const interessesContainer = document.getElementById('interessesContainer');
    const emptyState = document.getElementById('emptyState');
    const totalInfo = document.getElementById('totalInfo');

    if (licitacoes.length === 0) {
        interessesContainer.innerHTML = '';
        emptyState.style.display = 'block';
        totalInfo.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';

    // Calcular totais
    let totalItens = 0;
    let valorTotal = 0;
    licitacoes.forEach(l => {
        totalItens += l.itens.length;
        l.itens.forEach(item => {
            valorTotal += (parseFloat(item.valorUnitarioEstimado) || 0) * (parseFloat(item.quantidade) || 1);
        });
    });

    document.getElementById('totalLicitacoes').textContent = licitacoes.length;
    document.getElementById('totalItens').textContent = totalItens;
    document.getElementById('valorTotal').textContent = formatarValor(valorTotal);
    totalInfo.style.display = 'flex';

    // Renderizar cards
    interessesContainer.innerHTML = '';

    licitacoes.forEach(licitacao => {
        const valorLicitacao = licitacao.itens.reduce((sum, item) => {
            return sum + (parseFloat(item.valorUnitarioEstimado) || 0) * (parseFloat(item.quantidade) || 1);
        }, 0);

        const card = document.createElement('div');
        card.className = 'interesse-card';
        card.innerHTML = `
            <div class="interesse-header">
                <div class="interesse-titulo">${licitacao.objetoCompra}</div>
            </div>
            <div class="interesse-info">
                <div class="info-item">
                    <span class="info-label">Órgão</span>
                    <span class="info-value">${licitacao.nomeOrgao}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">UASG</span>
                    <span class="info-value">${licitacao.codigoUnidadeCompradora}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Licitação</span>
                    <span class="info-value">${licitacao.numeroCompra || licitacao.sequencial}/${licitacao.ano}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Abertura</span>
                    <span class="info-value">${formatarData(licitacao.dataAberturaProposta) || 'Não informada'}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Encerramento</span>
                    <span class="info-value">${formatarData(licitacao.dataEncerramentoProposta) || 'Não informada'} ${badgeEncerramento(licitacao.dataEncerramentoProposta)}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Valor Total</span>
                    <span class="info-value" style="color: #4caf50;">${formatarValor(valorLicitacao)}</span>
                </div>
            </div>
            <div class="itens-lista">
                <h4>Itens de Interesse (${licitacao.itens.length})</h4>
                ${licitacao.itens.map(item => `
                    <div class="item-interesse">
                        <div class="item-info">
                            <span class="item-numero">Item ${item.numeroItem}</span>
                            <span class="item-descricao">${item.descricao}</span>
                        </div>
                        <span class="item-valor">${formatarValor(item.valorUnitarioEstimado * item.quantidade)}</span>
                        <button class="btn-remover" onclick="removerInteresse(${item.id})">Remover</button>
                    </div>
                `).join('')}
            </div>
            <div class="interesse-footer">
                ${licitacao.linkSistemaOrigem ?
                    `<a href="${licitacao.linkSistemaOrigem.startsWith('http') ? licitacao.linkSistemaOrigem : 'https://' + licitacao.linkSistemaOrigem}" target="_blank" class="btn-detalhes">Abrir no Sistema</a>` :
                    `<a href="https://pncp.gov.br/app/editais/${licitacao.cnpj}/${licitacao.ano}/${licitacao.sequencial}" target="_blank" class="btn-detalhes">Ver no PNCP</a>`
                }
            </div>
        `;
        interessesContainer.appendChild(card);
    });
}

async function removerInteresse(id) {
    if (!confirm('Deseja remover este item de interesse?')) return;

    try {
        const response = await fetch('/api/interesse/' + id, { method: 'DELETE' });
        if (response.ok) {
            carregarInteresses();
        } else {
            alert('Erro ao remover interesse');
        }
    } catch (error) {
        console.error('Erro:', error);
        alert('Erro ao remover interesse');
    }
}

function formatarValor(valor) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(valor);
}

async function excluirTodosInteresses() {
    if (!confirm('Tem certeza que deseja EXCLUIR TODOS os interesses?\n\nEsta ação não pode ser desfeita!')) return;

    try {
        const response = await fetch('/api/interesse', { method: 'DELETE' });
        const result = await response.json();

        if (result.success) {
            alert(`${result.removidos} interesse(s) removido(s) com sucesso!`);
            carregarInteresses();
        } else {
            alert('Erro ao excluir interesses: ' + result.error);
        }
    } catch (error) {
        console.error('Erro:', error);
        alert('Erro ao excluir interesses');
    }
}

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', carregarInteresses);
