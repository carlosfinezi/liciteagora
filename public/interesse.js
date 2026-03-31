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
                    grupoNome: item.grupoNome || '',
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
        popularFiltrosDinamicos();
        aplicarFiltro();

    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
        loadingContainer.innerHTML = '<h3 style="color: #f44336;">Erro ao carregar interesses</h3>';
    }
}

function dataStr(iso) {
    // Extrai YYYY-MM-DD da string ISO sem conversão de fuso
    if (!iso || iso.length < 10) return null;
    const s = iso.substring(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function hojeStr() {
    const n = new Date();
    const pad = x => String(x).padStart(2, '0');
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
}

function somarDias(baseStr, dias) {
    const dt = new Date(baseStr + 'T12:00:00');
    dt.setDate(dt.getDate() + dias);
    const pad = x => String(x).padStart(2, '0');
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function popularFiltrosDinamicos() {
    // Órgão
    const orgaos = {};
    todasLicitacoes.forEach(l => {
        if (l.nomeOrgao) orgaos[l.nomeOrgao] = (orgaos[l.nomeOrgao] || 0) + 1;
    });
    const selectOrgao = document.getElementById('filtroOrgao');
    if (selectOrgao) {
        selectOrgao.innerHTML = `<option value="">Todos os órgãos (${Object.keys(orgaos).length})</option>`;
        Object.entries(orgaos).sort((a, b) => b[1] - a[1]).forEach(([org, qtd]) => {
            const label = org.length > 40 ? org.substring(0, 40) + '…' : org;
            selectOrgao.innerHTML += `<option value="${org}" title="${org}">${label} (${qtd})</option>`;
        });
    }

    // Grupo de palavras-chave
    const grupos = {};
    let semGrupo = 0;
    todasLicitacoes.forEach(l => {
        if (l.grupoNome) grupos[l.grupoNome] = (grupos[l.grupoNome] || 0) + 1;
        else semGrupo++;
    });
    const selectGrupo = document.getElementById('filtroGrupo');
    if (selectGrupo) {
        selectGrupo.innerHTML = `<option value="">Todos os grupos</option>`;
        Object.entries(grupos).sort((a, b) => a[0].localeCompare(b[0])).forEach(([g, qtd]) => {
            selectGrupo.innerHTML += `<option value="${g}">${g} (${qtd})</option>`;
        });
        if (semGrupo > 0) {
            selectGrupo.innerHTML += `<option value="SEM_GRUPO">Sem grupo (${semGrupo})</option>`;
        }
    }
}

function aplicarFiltro() {
    const periodo = document.getElementById('filtroPeriodo').value;
    const dataDe = document.getElementById('filtroDataDe');
    const dataAte = document.getElementById('filtroDataAte');
    const ateLabel = document.getElementById('filtroAte');
    const personalizado = periodo === 'personalizado';
    const orgao = (document.getElementById('filtroOrgao') || {}).value || '';
    const grupo = (document.getElementById('filtroGrupo') || {}).value || '';

    dataDe.style.display = personalizado ? '' : 'none';
    dataAte.style.display = personalizado ? '' : 'none';
    ateLabel.style.display = personalizado ? '' : 'none';

    const hoje = hojeStr();

    let filtradas = todasLicitacoes;

    // Filtro de data
    if (periodo === 'hoje') {
        filtradas = filtradas.filter(l => dataStr(l.dataEncerramentoProposta) === hoje);
    } else if (periodo === 'semana') {
        const fim = somarDias(hoje, 7);
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return d && d >= hoje && d <= fim;
        });
    } else if (periodo === 'mes') {
        const fim = somarDias(hoje, 30);
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return d && d >= hoje && d <= fim;
        });
    } else if (periodo === 'vencidas') {
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return d && d < hoje;
        });
    } else if (periodo === 'personalizado') {
        const de = dataDe.value || null;
        const ate = dataAte.value || null;
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            if (!d) return false;
            if (de && d < de) return false;
            if (ate && d > ate) return false;
            return true;
        });
    }

    // Filtro de órgão
    if (orgao) {
        filtradas = filtradas.filter(l => l.nomeOrgao === orgao);
    }

    // Filtro de grupo
    if (grupo === 'SEM_GRUPO') {
        filtradas = filtradas.filter(l => !l.grupoNome);
    } else if (grupo) {
        filtradas = filtradas.filter(l => l.grupoNome === grupo);
    }

    // Ordenação
    const ordenacao = (document.getElementById('ordenacao') || {}).value || 'encerramento-asc';
    filtradas.sort((a, b) => {
        switch (ordenacao) {
            case 'encerramento-asc': {
                const da = dataStr(a.dataEncerramentoProposta) || '9999-12-31';
                const db = dataStr(b.dataEncerramentoProposta) || '9999-12-31';
                return da.localeCompare(db);
            }
            case 'encerramento-desc': {
                const da = dataStr(a.dataEncerramentoProposta) || '0000-01-01';
                const db = dataStr(b.dataEncerramentoProposta) || '0000-01-01';
                return db.localeCompare(da);
            }
            case 'valor-desc': {
                const va = a.itens.reduce((s, i) => s + (parseFloat(i.valorUnitarioEstimado) || 0) * (parseFloat(i.quantidade) || 1), 0);
                const vb = b.itens.reduce((s, i) => s + (parseFloat(i.valorUnitarioEstimado) || 0) * (parseFloat(i.quantidade) || 1), 0);
                return vb - va;
            }
            case 'valor-asc': {
                const va = a.itens.reduce((s, i) => s + (parseFloat(i.valorUnitarioEstimado) || 0) * (parseFloat(i.quantidade) || 1), 0);
                const vb = b.itens.reduce((s, i) => s + (parseFloat(i.valorUnitarioEstimado) || 0) * (parseFloat(i.quantidade) || 1), 0);
                return va - vb;
            }
            case 'orgao-asc':
                return (a.nomeOrgao || '').localeCompare(b.nomeOrgao || '');
            case 'recente': {
                const ia = Math.max(...a.itens.map(i => i.id));
                const ib = Math.max(...b.itens.map(i => i.id));
                return ib - ia;
            }
            default: return 0;
        }
    });

    renderizarLicitacoes(filtradas);

    const info = document.getElementById('filtroInfo');
    const temFiltro = periodo !== 'todas' || orgao || grupo;
    if (!temFiltro) {
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

function badgeEncerramento(dataIso) {
    if (!dataIso) return '<span class="data-abertura-badge sem-data">Sem prazo</span>';
    const dStr = dataStr(dataIso);
    if (!dStr) return '<span class="data-abertura-badge sem-data">Sem prazo</span>';
    const hoje = hojeStr();

    if (dStr < hoje) {
        return `<span class="data-abertura-badge passado">Prazo encerrado</span>`;
    } else if (dStr === hoje) {
        const hora = dataIso.length >= 16 ? dataIso.substring(11, 16) : '';
        return `<span class="data-abertura-badge hoje">Hoje${hora ? ' ' + hora : ''}</span>`;
    } else {
        const hDt = new Date(hoje + 'T12:00:00');
        const dDt = new Date(dStr + 'T12:00:00');
        const dias = Math.round((dDt - hDt) / 86400000);
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
