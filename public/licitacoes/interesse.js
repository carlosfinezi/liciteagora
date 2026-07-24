// Dados globais para filtro
let todasLicitacoes = [];
let idsVisiveis = [];          // item ids atualmente filtrados/visíveis
let selectedIds = new Set();   // item ids marcados (podem ficar fora dos visíveis se o filtro mudou)

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
                    kanbanStatus: item.kanbanStatus || null,
                    kanbanDataAtualizacao: item.kanbanDataAtualizacao || null,
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

        // Deep-link: ?lic=cnpj-ano-sequencial. Vindo do /operacional/analises-ia.html,
        // o usuário clicou em "Ver em Interesses" pra encontrar a licitação aqui.
        const params = new URLSearchParams(location.search);
        const licAlvo = params.get('lic');
        if (licAlvo) {
            // Aguarda o render do aplicarFiltro
            setTimeout(() => {
                const el = document.getElementById('lic-' + licAlvo);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.style.transition = 'box-shadow 0.3s, outline 0.3s';
                    el.style.outline = '3px solid var(--accent)';
                    el.style.boxShadow = '0 0 0 4px var(--accent-soft)';
                    setTimeout(() => {
                        el.style.outline = '';
                        el.style.boxShadow = '';
                    }, 3500);
                } else {
                    // Licitação não está em interesses — mostra banner amarelo
                    const banner = document.createElement('div');
                    banner.style.cssText = 'background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn);border-radius:var(--r-md);padding:12px 16px;margin-bottom:12px;font-size:0.9em;';
                    banner.innerHTML = '⚠️ A licitação <code>' + licAlvo + '</code> não está marcada como interesse. Ela aparece na análise IA, mas só será listada aqui se você marcar interesse em pelo menos um item dela.';
                    const main = document.querySelector('main.main-content') || document.body;
                    main.insertBefore(banner, main.firstChild.nextSibling);
                }
            }, 200);
        }

    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
        loadingContainer.innerHTML = '<h3 style="color: var(--danger);">Erro ao carregar interesses</h3>';
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
    if (periodo === 'ativas') {
        // Default: licitações com prazo em aberto (hoje ou futuro) ou sem data.
        // Não exclui licitações sem data — só remove explicitamente as vencidas.
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return !d || d >= hoje;
        });
    } else if (periodo === 'hoje') {
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

    idsVisiveis = filtradas.flatMap(l => l.itens.map(i => i.id));
    renderizarLicitacoes(filtradas);
    updateSelectionUI();

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

function badgePropostaEnviada(status, dataAtualizacao) {
    if (status !== 'enviada') return '';
    const quando = formatarData(dataAtualizacao);
    const titulo = quando ? `Proposta enviada via API · ${quando}` : 'Proposta enviada via API';
    return `<span class="badge emitida" title="${titulo}" style="margin-top:6px;display:inline-block;">✓ Proposta enviada</span>`;
}

function badgeEncerramento(dataIso) {
    if (!dataIso) return '<span class="badge inativo">Sem prazo</span>';
    const dStr = dataStr(dataIso);
    if (!dStr) return '<span class="badge inativo">Sem prazo</span>';
    const hoje = hojeStr();

    if (dStr < hoje) {
        return `<span class="badge vencida">Prazo encerrado</span>`;
    } else if (dStr === hoje) {
        const hora = dataIso.length >= 16 ? dataIso.substring(11, 16) : '';
        return `<span class="badge processando">Hoje${hora ? ' ' + hora : ''}</span>`;
    } else {
        const hDt = new Date(hoje + 'T12:00:00');
        const dDt = new Date(dStr + 'T12:00:00');
        const dias = Math.round((dDt - hDt) / 86400000);
        return `<span class="badge ativo">Faltam ${dias} dia${dias > 1 ? 's' : ''}</span>`;
    }
}

function renderizarLicitacoes(licitacoes) {
    const interessesContainer = document.getElementById('interessesContainer');
    const emptyState = document.getElementById('emptyState');
    const totalInfo = document.getElementById('totalInfo');

    const btnExcluir = document.getElementById('btnExcluirTodos');

    if (licitacoes.length === 0) {
        interessesContainer.innerHTML = '';
        emptyState.style.display = 'block';
        totalInfo.style.display = 'none';
        if (btnExcluir) btnExcluir.style.display = 'none';
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
    totalInfo.style.display = '';
    if (btnExcluir) btnExcluir.style.display = '';

    // Renderizar cards
    interessesContainer.innerHTML = '';

    licitacoes.forEach(licitacao => {
        const valorLicitacao = licitacao.itens.reduce((sum, item) => {
            return sum + (parseFloat(item.valorUnitarioEstimado) || 0) * (parseFloat(item.quantidade) || 1);
        }, 0);

        const linkPncp = `https://pncp.gov.br/app/editais/${licitacao.cnpj}/${licitacao.ano}/${licitacao.sequencial}`;
        const linkOrigem = licitacao.linkSistemaOrigem
            ? (licitacao.linkSistemaOrigem.startsWith('http') ? licitacao.linkSistemaOrigem : 'https://' + licitacao.linkSistemaOrigem)
            : '';
        const licKey = `${licitacao.cnpj}-${licitacao.ano}-${licitacao.sequencial}`;

        const card = document.createElement('div');
        card.className = 'card';
        card.id = 'lic-' + licKey;
        card.style.marginBottom = '14px';
        card.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border);">
                <div style="display:flex;align-items:flex-start;gap:10px;flex:1;">
                  <input type="checkbox" class="lic-check" data-lic-key="${licKey}" onchange="toggleSelecaoLicitacao('${licKey}', this.checked)" style="width:16px;height:16px;cursor:pointer;margin-top:6px;flex:none;" title="Selecionar todos os itens desta licitação">
                  <div style="flex:1;">
                    <h3 style="margin:0;">${licitacao.objetoCompra}</h3>
                    ${badgePropostaEnviada(licitacao.kanbanStatus, licitacao.kanbanDataAtualizacao)}
                  </div>
                </div>
                <div style="display:flex;gap:8px;flex:none;">
                  <a href="/operacional/analises-ia.html?pncp=${licitacao.cnpj}-${licitacao.ano}-${licitacao.sequencial}" class="btn btn-ghost btn-sm" style="text-decoration:none;white-space:nowrap;" title="Ver análise IA desta licitação">Análise IA</a>
                  <a href="${linkPncp}" target="_blank" class="btn btn-primary btn-sm" style="text-decoration:none;white-space:nowrap;" title="Abrir o edital no Portal Nacional de Contratações Públicas">Abrir no PNCP</a>
                  ${linkOrigem ? `<a href="${linkOrigem}" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none;white-space:nowrap;" title="Link de origem informado pelo órgão (pode ser genérico)">Site de origem</a>` : ''}
                </div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px 18px;margin-bottom:14px;">
                ${infoRow('Órgão', licitacao.nomeOrgao)}
                ${infoRow('UASG', licitacao.codigoUnidadeCompradora)}
                ${infoRow('Licitação', `${licitacao.numeroCompra || licitacao.sequencial}/${licitacao.ano}`)}
                ${infoRow('Abertura', formatarData(licitacao.dataAberturaProposta) || 'Não informada')}
                ${infoRow('Encerramento', `${formatarData(licitacao.dataEncerramentoProposta) || 'Não informada'} ${badgeEncerramento(licitacao.dataEncerramentoProposta)}`)}
                ${infoRow('Valor total', `<span style="color:var(--success);font-weight:600;">${formatarValor(valorLicitacao)}</span>`)}
            </div>

            <div style="font-size:0.82em;color:var(--text-2);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:8px;">
                Itens de interesse (${licitacao.itens.length})
            </div>
            <div class="tbl-wrap">
              <table>
                <tbody>
                  ${licitacao.itens.map(item => `
                    <tr>
                      <td style="width:36px;text-align:center;">
                        <input type="checkbox" class="item-check" data-item-id="${item.id}" data-lic-key="${licKey}" onchange="toggleSelecaoItem(${item.id}, this.checked)" style="width:16px;height:16px;cursor:pointer;">
                      </td>
                      <td style="width:90px;color:var(--text-2);">Item ${item.numeroItem}</td>
                      <td>${item.descricao}</td>
                      <td style="text-align:right;white-space:nowrap;font-weight:600;">${formatarValor(item.valorUnitarioEstimado * item.quantidade)}</td>
                      <td style="text-align:right;width:90px;">
                        <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="removerInteresse(${item.id})">Remover</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
        `;
        interessesContainer.appendChild(card);
    });
}

function infoRow(label, value) {
    return `
        <div style="display:flex;flex-direction:column;gap:3px;">
            <span style="font-size:0.72em;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-2);font-weight:600;">${label}</span>
            <span style="color:var(--text-0);font-size:0.9em;">${value || '—'}</span>
        </div>`;
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

// ===== Seleção em massa =====

function toggleSelecaoItem(id, checked) {
    if (checked) selectedIds.add(id); else selectedIds.delete(id);
    updateSelectionUI();
}

function toggleSelecaoLicitacao(licKey, checked) {
    const lic = todasLicitacoes.find(l => `${l.cnpj}-${l.ano}-${l.sequencial}` === licKey);
    if (!lic) return;
    lic.itens.forEach(it => {
        if (checked) selectedIds.add(it.id); else selectedIds.delete(it.id);
    });
    updateSelectionUI();
}

function toggleSelecionarTodos(checked) {
    idsVisiveis.forEach(id => {
        if (checked) selectedIds.add(id); else selectedIds.delete(id);
    });
    updateSelectionUI();
}

function limparSelecao() {
    selectedIds.clear();
    updateSelectionUI();
}

function updateSelectionUI() {
    // Sincroniza checkbox de cada item visível
    document.querySelectorAll('.item-check').forEach(cb => {
        const id = Number(cb.dataset.itemId);
        cb.checked = selectedIds.has(id);
    });

    // Sincroniza checkbox de cada licitação (tri-state via indeterminate)
    document.querySelectorAll('.lic-check').forEach(cb => {
        const key = cb.dataset.licKey;
        const lic = todasLicitacoes.find(l => `${l.cnpj}-${l.ano}-${l.sequencial}` === key);
        if (!lic) return;
        const total = lic.itens.length;
        const sel = lic.itens.filter(it => selectedIds.has(it.id)).length;
        cb.checked = sel === total && total > 0;
        cb.indeterminate = sel > 0 && sel < total;
    });

    // Master da toolbar (tri-state sobre os visíveis)
    const master = document.getElementById('masterCheck');
    if (master) {
        const visiveisSelecionados = idsVisiveis.filter(id => selectedIds.has(id)).length;
        master.checked = visiveisSelecionados === idsVisiveis.length && idsVisiveis.length > 0;
        master.indeterminate = visiveisSelecionados > 0 && visiveisSelecionados < idsVisiveis.length;
    }

    // Barra flutuante
    const bar = document.getElementById('selectionBar');
    const count = document.getElementById('selectionCount');
    if (bar && count) {
        if (selectedIds.size > 0) {
            bar.style.display = 'flex';
            count.textContent = `${selectedIds.size} selecionado${selectedIds.size > 1 ? 's' : ''}`;
        } else {
            bar.style.display = 'none';
        }
    }
}

async function excluirSelecionados() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`Excluir ${ids.length} interesse${ids.length > 1 ? 's' : ''} selecionado${ids.length > 1 ? 's' : ''}?\n\nEsta ação não pode ser desfeita.`)) return;
    try {
        const r = await fetch('/api/interesse/bulk-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const result = await r.json();
        if (result.success) {
            selectedIds.clear();
            alert(`${result.removidos} interesse(s) removido(s).`);
            carregarInteresses();
        } else {
            alert('Erro ao excluir: ' + (result.error || 'desconhecido'));
        }
    } catch (e) {
        console.error(e);
        alert('Erro ao excluir selecionados.');
    }
}

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', carregarInteresses);
