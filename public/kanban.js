let kanbanData = [];
let interessesData = [];
let draggedCard = null;

async function carregarKanban() {
    try {
        const response = await fetch('/api/kanban');
        const result = await response.json();
        kanbanData = result.data || [];
        renderizarKanban();
    } catch (error) {
        console.error('Erro ao carregar kanban:', error);
    }
}

async function carregarInteresses() {
    try {
        const response = await fetch('/api/interesse');
        const result = await response.json();
        interessesData = result.data || [];
    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
    }
}

function renderizarKanban() {
    const colunas = ['analise', 'proposta', 'enviada', 'vencida'];

    colunas.forEach(status => {
        const container = document.getElementById(`cards-${status}`);
        container.innerHTML = '';

        const cards = kanbanData.filter(item => {
            // Verificar se está vencida
            const agora = new Date();
            const dataEnc = new Date(item.dataEncerramentoProposta);

            if (status === 'vencida') {
                return dataEnc < agora && item.status !== 'enviada';
            }
            if (item.status === status) {
                return dataEnc >= agora || status === 'enviada';
            }
            return false;
        });

        document.getElementById(`count-${status}`).textContent = cards.length;

        if (cards.length === 0) {
            container.innerHTML = '<div class="empty-column">Nenhuma licitação</div>';
            return;
        }

        cards.forEach(item => {
            container.appendChild(criarCard(item));
        });
    });
}

function criarCard(item) {
    const card = document.createElement('div');
    card.className = 'kanban-card';
    card.draggable = true;
    card.dataset.cnpj = item.cnpj;
    card.dataset.ano = item.ano;
    card.dataset.sequencial = item.sequencial;

    // Eventos de drag
    card.ondragstart = (e) => {
        draggedCard = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    };
    card.ondragend = () => {
        card.classList.remove('dragging');
        draggedCard = null;
        document.querySelectorAll('.column-cards').forEach(col => col.classList.remove('drag-over'));
    };

    // Data de encerramento
    const dataEnc = new Date(item.dataEncerramentoProposta);
    const agora = new Date();
    const diffDias = Math.ceil((dataEnc - agora) / (1000 * 60 * 60 * 24));

    let dataClass = 'card-date';
    let dataTexto = dataEnc.toLocaleDateString('pt-BR');
    if (diffDias < 0) {
        dataClass += ' urgente';
        dataTexto = 'Encerrada';
    } else if (diffDias === 0) {
        dataClass += ' hoje';
        dataTexto = 'Hoje às ' + dataEnc.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDias <= 3) {
        dataClass += ' urgente';
        dataTexto = `Em ${diffDias} dia(s)`;
    }

    card.innerHTML = `
        <div class="card-title">${item.objetoCompra || 'Sem objeto'}</div>
        <div class="card-info">
            <span>${item.nomeOrgao || 'Órgão não informado'}</span>
        </div>
        <div class="card-info">
            <span class="${dataClass}">📅 ${dataTexto}</span>
            <span>📦 ${item.qtdItens || 0} itens</span>
        </div>
        ${item.observacao ? `<div class="card-obs">${item.observacao}</div>` : ''}
        <div class="card-actions">
            ${item.linkSistemaOrigem ? `
                <button class="card-btn abrir" onclick="abrirSistema('${item.linkSistemaOrigem}')">Abrir</button>
            ` : ''}
            <button class="card-btn proposta" onclick="window.location.href='propostas-api.html'">Proposta</button>
            <button class="card-btn remover" onclick="removerDoKanban('${item.cnpj}', ${item.ano}, ${item.sequencial})">✕</button>
        </div>
    `;

    return card;
}

function allowDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}

async function drop(e, novoStatus) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');

    if (!draggedCard) return;

    const cnpj = draggedCard.dataset.cnpj;
    const ano = draggedCard.dataset.ano;
    const sequencial = draggedCard.dataset.sequencial;

    try {
        const response = await fetch(`/api/kanban/${cnpj}/${ano}/${sequencial}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: novoStatus })
        });

        if (response.ok) {
            // Atualizar dados locais
            const item = kanbanData.find(k =>
                k.cnpj === cnpj && k.ano == ano && k.sequencial == sequencial
            );
            if (item) item.status = novoStatus;
            renderizarKanban();
        }
    } catch (error) {
        console.error('Erro ao atualizar status:', error);
    }
}

function abrirSistema(link) {
    let url = link;
    if (!url.startsWith('http')) url = 'https://' + url;
    window.open(url, '_blank');
}

async function removerDoKanban(cnpj, ano, sequencial) {
    if (!confirm('Remover esta licitação do Kanban?')) return;

    try {
        const response = await fetch(`/api/kanban/${cnpj}/${ano}/${sequencial}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            kanbanData = kanbanData.filter(k =>
                !(k.cnpj === cnpj && k.ano == ano && k.sequencial == sequencial)
            );
            renderizarKanban();
        }
    } catch (error) {
        console.error('Erro ao remover do kanban:', error);
    }
}

async function abrirModalInteresses() {
    await carregarInteresses();

    // Agrupar interesses por licitação
    const licitacoesMap = new Map();
    interessesData.forEach(item => {
        const key = `${item.cnpj}-${item.ano}-${item.sequencial}`;
        if (!licitacoesMap.has(key)) {
            licitacoesMap.set(key, {
                cnpj: item.cnpj,
                ano: item.ano,
                sequencial: item.sequencial,
                objetoCompra: item.objetoCompra,
                nomeOrgao: item.nomeOrgao,
                dataEncerramentoProposta: item.dataEncerramentoProposta,
                linkSistemaOrigem: item.linkSistemaOrigem,
                qtdItens: 0
            });
        }
        licitacoesMap.get(key).qtdItens++;
    });

    const container = document.getElementById('interesseList');
    container.innerHTML = '';

    if (licitacoesMap.size === 0) {
        container.innerHTML = '<p style="color: #888; text-align: center;">Nenhum interesse cadastrado</p>';
    } else {
        licitacoesMap.forEach((lic, key) => {
            const jaNoKanban = kanbanData.some(k =>
                k.cnpj === lic.cnpj && k.ano == lic.ano && k.sequencial == lic.sequencial
            );

            const div = document.createElement('div');
            div.className = 'interesse-item' + (jaNoKanban ? ' added' : '');
            div.innerHTML = `
                <h4>${lic.objetoCompra || 'Sem objeto'}</h4>
                <p>${lic.nomeOrgao} - ${lic.qtdItens} item(s)</p>
                ${jaNoKanban ? '<p style="color: #4dabf7;">Já no Kanban</p>' : ''}
            `;

            if (!jaNoKanban) {
                div.onclick = () => adicionarAoKanban(lic);
            }

            container.appendChild(div);
        });
    }

    document.getElementById('interesseModal').classList.add('show');
}

async function adicionarAoKanban(lic) {
    try {
        const response = await fetch(`/api/kanban/${lic.cnpj}/${lic.ano}/${lic.sequencial}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'analise' })
        });

        if (response.ok) {
            // Adicionar aos dados locais
            kanbanData.push({
                ...lic,
                status: 'analise'
            });
            fecharModal();
            renderizarKanban();
        }
    } catch (error) {
        console.error('Erro ao adicionar ao kanban:', error);
    }
}

function fecharModal() {
    document.getElementById('interesseModal').classList.remove('show');
}

// Fechar modal ao clicar fora
document.getElementById('interesseModal').addEventListener('click', (e) => {
    if (e.target.id === 'interesseModal') {
        fecharModal();
    }
});

// Highlight da coluna durante drag
document.querySelectorAll('.column-cards').forEach(col => {
    col.addEventListener('dragleave', () => {
        col.classList.remove('drag-over');
    });
});

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', () => {
    carregarKanban();
    carregarInteresses();
});
