let licitacoesData = new Map();
let valoresProposta = {};
let saveTimeout = null; // Para debounce do salvamento

// Função para salvar valores de uma licitação no banco
async function salvarValoresProposta(cnpj, ano, sequencial) {
    // Coletar todos os itens desta licitação
    const key = `${cnpj}-${ano}-${sequencial}`;
    const licitacao = licitacoesData.get(key);
    if (!licitacao) return;

    const itens = licitacao.itens.map(item => ({
        numeroItem: item.numeroItem,
        valorUnitario: valoresProposta[item.id]?.valorUnitario || null,
        marca: valoresProposta[item.id]?.marca || '',
        modelo: valoresProposta[item.id]?.modelo || '',
        fabricante: valoresProposta[item.id]?.fabricante || '',
        selecionado: valoresProposta[item.id]?.selecionado || false
    }));

    try {
        await fetch('/api/valores-proposta/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpj, ano, sequencial, itens })
        });
    } catch (error) {
        console.error('Erro ao salvar valores da proposta:', error);
    }
}

// Função para carregar valores salvos de uma licitação
async function carregarValoresSalvos(cnpj, ano, sequencial, itens) {
    try {
        const response = await fetch(`/api/valores-proposta/${cnpj}/${ano}/${sequencial}`);
        const result = await response.json();

        if (result.success && result.valores) {
            // Aplicar valores salvos aos itens
            itens.forEach(item => {
                const valorSalvo = result.valores[item.numeroItem];
                if (valorSalvo) {
                    valoresProposta[item.id] = {
                        ...valoresProposta[item.id],
                        valorUnitario: valorSalvo.valorUnitario,
                        marca: valorSalvo.marca || '',
                        modelo: valorSalvo.modelo || '',
                        fabricante: valorSalvo.fabricante || '',
                        selecionado: valorSalvo.selecionado
                    };
                }
            });
        }
    } catch (error) {
        console.error('Erro ao carregar valores salvos:', error);
    }
}

// Debounce para salvar automaticamente
function agendarSalvamento(cnpj, ano, sequencial) {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        salvarValoresProposta(cnpj, ano, sequencial);
    }, 1000); // Salva 1 segundo após a última alteração
}

async function carregarItensInteresse() {
    const loadingContainer = document.getElementById('loadingContainer');
    const propostasContainer = document.getElementById('propostasContainer');
    const emptyState = document.getElementById('emptyState');

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
        licitacoesData = new Map();

        interesses.forEach(item => {
            const key = `${item.cnpj}-${item.ano}-${item.sequencial}`;
            if (!licitacoesData.has(key)) {
                licitacoesData.set(key, {
                    cnpj: item.cnpj,
                    ano: item.ano,
                    sequencial: item.sequencial,
                    objetoCompra: item.objetoCompra || 'Objeto não disponível',
                    nomeOrgao: item.nomeOrgao || 'Órgão não disponível',
                    codigoUnidadeCompradora: item.codigoUnidadeCompradora || '',
                    linkSistemaOrigem: item.linkSistemaOrigem || '',
                    modalidadeNome: item.modalidadeNome || '',
                    numeroCompra: item.numeroCompra || '',
                    itens: []
                });
            }
            licitacoesData.get(key).itens.push({
                id: item.id,
                numeroItem: item.numeroItem,
                descricao: item.descricao || `Item ${item.numeroItem}`,
                valorUnitarioEstimado: parseFloat(item.valorUnitarioEstimado) || 0,
                quantidade: parseFloat(item.quantidade) || 1,
                unidadeMedida: item.unidadeMedida || 'UN',
                selecionado: false,
                valorProposta: null
            });

            // Inicializar valores com valor de referência como padrão
            const valorRef = parseFloat(item.valorUnitarioEstimado) || 0;
            valoresProposta[item.id] = {
                selecionado: false,
                valorUnitario: valorRef > 0 ? valorRef : null,
                marca: '',
                modelo: '',
                fabricante: ''
            };
        });

        // Carregar valores salvos de cada licitação
        const promises = [];
        licitacoesData.forEach((licitacao, key) => {
            promises.push(carregarValoresSalvos(licitacao.cnpj, licitacao.ano, licitacao.sequencial, licitacao.itens));
        });
        await Promise.all(promises);

        renderizarLicitacoes();
        propostasContainer.style.display = 'block';

        // Mostrar filtros e popular dropdown de modalidades
        document.getElementById('filtrosContainer').style.display = 'block';
        popularFiltroModalidades();

    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
        loadingContainer.innerHTML = '<h3 style="color: #f44336;">Erro ao carregar itens de interesse</h3>';
    }
}

// Popular dropdown de modalidades
function popularFiltroModalidades() {
    const modalidades = new Set();
    licitacoesData.forEach(lic => {
        if (lic.modalidadeNome) modalidades.add(lic.modalidadeNome);
    });

    const select = document.getElementById('filtroModalidade');
    select.innerHTML = '<option value="">Todas</option>';
    Array.from(modalidades).sort().forEach(mod => {
        select.innerHTML += `<option value="${mod}">${mod}</option>`;
    });
}

// Aplicar filtros
function aplicarFiltros() {
    const texto = document.getElementById('filtroTexto').value.toLowerCase().trim();
    const modalidade = document.getElementById('filtroModalidade').value;
    const status = document.getElementById('filtroStatus').value;

    let totalLicitacoes = 0;
    let licitacoesVisiveis = 0;

    const panels = document.querySelectorAll('#propostasContainer .panel');

    panels.forEach((panel) => {
        const key = panel.getAttribute('data-licitacao-key');
        const licitacao = licitacoesData.get(key);
        if (!licitacao) return;

        totalLicitacoes++;
        let visivel = true;

        // Filtro de texto (objeto, órgão, UASG)
        if (texto) {
            const textoLicitacao = `${licitacao.objetoCompra} ${licitacao.nomeOrgao} ${licitacao.codigoUnidadeCompradora}`.toLowerCase();
            if (!textoLicitacao.includes(texto)) {
                visivel = false;
            }
        }

        // Filtro de modalidade
        if (modalidade && licitacao.modalidadeNome !== modalidade) {
            visivel = false;
        }

        // Filtro de status (com/sem valor)
        if (status) {
            const temValorPreenchido = licitacao.itens.some(item =>
                valoresProposta[item.id] && valoresProposta[item.id].valorUnitario
            );
            if (status === 'comValor' && !temValorPreenchido) visivel = false;
            if (status === 'semValor' && temValorPreenchido) visivel = false;
        }

        // Aplicar visibilidade no panel inteiro
        if (visivel) {
            panel.style.display = '';
            licitacoesVisiveis++;
        } else {
            panel.style.display = 'none';
        }
    });

    // Mostrar resultado do filtro
    const resultado = document.getElementById('filtroResultado');
    if (texto || modalidade || status) {
        resultado.textContent = `Exibindo ${licitacoesVisiveis} de ${totalLicitacoes} licitações`;
    } else {
        resultado.textContent = '';
    }
}

// Limpar filtros
function limparFiltros() {
    document.getElementById('filtroTexto').value = '';
    document.getElementById('filtroModalidade').value = '';
    document.getElementById('filtroStatus').value = '';
    aplicarFiltros();
}

function renderizarLicitacoes() {
    const container = document.getElementById('propostasContainer');
    container.innerHTML = '';

    licitacoesData.forEach((licitacao, key) => {
        const div = document.createElement('div');
        div.className = 'panel';
        div.setAttribute('data-licitacao-key', key);
        div.innerHTML = `
            <div class="licitacao-group">
                <div class="licitacao-header">
                    <div>
                        <div class="licitacao-titulo">${licitacao.objetoCompra}</div>
                        <div class="licitacao-orgao">${licitacao.nomeOrgao} - UASG: ${licitacao.codigoUnidadeCompradora}</div>
                    </div>
                    ${licitacao.linkSistemaOrigem ?
                        `<a href="${licitacao.linkSistemaOrigem.startsWith('http') ? licitacao.linkSistemaOrigem : 'https://' + licitacao.linkSistemaOrigem}"
                           target="_blank" class="btn-comprasnet">
                            Abrir no Sistema
                        </a>` :
                        `<span style="color: #888; font-size: 0.9em;">Link não disponível</span>`
                    }
                </div>

                <div class="select-all-container">
                    <input type="checkbox" id="selectAll-${key}" onchange="toggleSelectAll('${key}')">
                    <label for="selectAll-${key}">Selecionar todos os itens desta licitação</label>
                    <span class="badge-qtd">${licitacao.itens.length} itens</span>
                </div>

                <div class="itens-proposta">
                    ${licitacao.itens.map(item => renderizarItem(item, key)).join('')}
                </div>

                <div class="licitacao-actions" id="actions-${key}">
                    <button class="btn-action btn-csv" onclick="exportarCSVLicitacao('${key}')" title="Exportar CSV">
                        <span>📊</span> CSV
                    </button>
                    <button class="btn-action btn-pdf" onclick="gerarPDFLicitacao('${key}', true)" title="Gerar PDF Assinado">
                        <span>🔐</span> PDF Assinado
                    </button>
                    <button class="btn-action btn-enviar" onclick="abrirModalEnvioLicitacao('${key}')" title="Enviar via Comprasnet">
                        <span>🚀</span> Enviar Comprasnet
                    </button>
                </div>
            </div>
        `;
        container.appendChild(div);
    });

    atualizarResumo();
}

function renderizarItem(item, licitacaoKey) {
    const valorRef = item.valorUnitarioEstimado;
    const totalRef = valorRef * item.quantidade;
    const dados = valoresProposta[item.id] || {};
    const valorProposta = dados.valorUnitario;
    const selecionado = dados.selecionado;

    let descontoHtml = '';
    if (valorProposta && valorRef > 0) {
        const desconto = ((valorRef - valorProposta) / valorRef * 100);
        if (desconto > 0) {
            descontoHtml = `<div class="desconto-info desconto-positivo">-${desconto.toFixed(2)}%</div>`;
        } else if (desconto < 0) {
            descontoHtml = `<div class="desconto-info desconto-negativo">+${Math.abs(desconto).toFixed(2)}%</div>`;
        }
    }

    const totalProposta = valorProposta ? (valorProposta * item.quantidade) : 0;

    return `
        <div class="item-proposta ${selecionado ? 'selecionado' : ''}" id="item-row-${item.id}">
            <div>
                <input type="checkbox" class="item-checkbox" id="check-${item.id}"
                       ${selecionado ? 'checked' : ''}
                       onchange="toggleItem(${item.id}, '${licitacaoKey}')">
            </div>
            <div class="item-descricao">
                <div class="item-numero">Item ${item.numeroItem}</div>
                ${item.descricao}
                <div style="color: #888; font-size: 0.85em; margin-top: 5px;">
                    Qtd: ${item.quantidade} ${item.unidadeMedida}
                </div>
            </div>
            <div class="item-valor-ref">
                <div style="color: #888; font-size: 0.8em;">Valor Ref.</div>
                <span>${formatarValor(valorRef)}</span>
            </div>
            <div class="item-input">
                <label>Valor Unit.</label>
                <input type="number" step="0.01" min="0"
                       id="valor-${item.id}"
                       value="${valorProposta || ''}"
                       placeholder="0,00"
                       onchange="atualizarValor(${item.id}, this.value, '${licitacaoKey}')"
                       onfocus="if(!document.getElementById('check-${item.id}').checked) toggleItem(${item.id}, '${licitacaoKey}')">
                ${descontoHtml}
            </div>
            <div class="item-extras">
                <input type="text" id="marca-${item.id}" value="${dados.marca || ''}"
                       placeholder="Marca" onchange="atualizarExtras(${item.id}, 'marca', this.value, '${licitacaoKey}')">
                <input type="text" id="modelo-${item.id}" value="${dados.modelo || ''}"
                       placeholder="Modelo" onchange="atualizarExtras(${item.id}, 'modelo', this.value, '${licitacaoKey}')">
                <input type="text" id="fabricante-${item.id}" value="${dados.fabricante || ''}"
                       placeholder="Fabricante" onchange="atualizarExtras(${item.id}, 'fabricante', this.value, '${licitacaoKey}')">
            </div>
            <div class="item-total">
                ${valorProposta ? formatarValor(totalProposta) : '-'}
            </div>
        </div>
    `;
}

function atualizarExtras(itemId, campo, valor, licitacaoKey) {
    if (valoresProposta[itemId]) {
        valoresProposta[itemId][campo] = valor;

        // Agendar salvamento automático
        const [cnpj, ano, sequencial] = licitacaoKey.split('-');
        agendarSalvamento(cnpj, parseInt(ano), parseInt(sequencial));
    }
}

function toggleItem(itemId, licitacaoKey) {
    const checkbox = document.getElementById(`check-${itemId}`);
    valoresProposta[itemId].selecionado = checkbox.checked;

    // Atualizar visual
    const row = document.getElementById(`item-row-${itemId}`);
    if (checkbox.checked) {
        row.classList.add('selecionado');
    } else {
        row.classList.remove('selecionado');
    }

    // Verificar se todos da licitação estão selecionados
    const licitacao = licitacoesData.get(licitacaoKey);
    const todosSelecionados = licitacao.itens.every(item => valoresProposta[item.id].selecionado);
    document.getElementById(`selectAll-${licitacaoKey}`).checked = todosSelecionados;

    // Agendar salvamento automático
    const [cnpj, ano, sequencial] = licitacaoKey.split('-');
    agendarSalvamento(cnpj, parseInt(ano), parseInt(sequencial));

    atualizarResumo();
    atualizarSteps();
}

function toggleSelectAll(licitacaoKey) {
    const selectAll = document.getElementById(`selectAll-${licitacaoKey}`);
    const licitacao = licitacoesData.get(licitacaoKey);

    licitacao.itens.forEach(item => {
        valoresProposta[item.id].selecionado = selectAll.checked;
        document.getElementById(`check-${item.id}`).checked = selectAll.checked;

        const row = document.getElementById(`item-row-${item.id}`);
        if (selectAll.checked) {
            row.classList.add('selecionado');
        } else {
            row.classList.remove('selecionado');
        }
    });

    // Agendar salvamento automático
    const [cnpj, ano, sequencial] = licitacaoKey.split('-');
    agendarSalvamento(cnpj, parseInt(ano), parseInt(sequencial));

    atualizarResumo();
    atualizarSteps();
}

function atualizarValor(itemId, valor, licitacaoKey) {
    const valorNumerico = parseFloat(valor) || null;
    valoresProposta[itemId].valorUnitario = valorNumerico;

    // Auto-selecionar se tiver valor
    if (valorNumerico && !valoresProposta[itemId].selecionado) {
        valoresProposta[itemId].selecionado = true;
        document.getElementById(`check-${itemId}`).checked = true;
        document.getElementById(`item-row-${itemId}`).classList.add('selecionado');
    }

    // Atualizar item específico
    let itemData = null;
    licitacoesData.forEach(lic => {
        const found = lic.itens.find(i => i.id === itemId);
        if (found) itemData = found;
    });

    if (itemData) {
        // Atualizar total do item
        const totalCell = document.getElementById(`item-row-${itemId}`).querySelector('.item-total');
        if (valorNumerico) {
            totalCell.textContent = formatarValor(valorNumerico * itemData.quantidade);
        } else {
            totalCell.textContent = '-';
        }

        // Atualizar desconto
        if (itemData.valorUnitarioEstimado > 0 && valorNumerico) {
            const desconto = ((itemData.valorUnitarioEstimado - valorNumerico) / itemData.valorUnitarioEstimado * 100);
            const inputContainer = document.getElementById(`valor-${itemId}`).parentElement;
            let descontoEl = inputContainer.querySelector('.desconto-info');

            if (!descontoEl) {
                descontoEl = document.createElement('div');
                descontoEl.className = 'desconto-info';
                inputContainer.appendChild(descontoEl);
            }

            if (desconto > 0) {
                descontoEl.className = 'desconto-info desconto-positivo';
                descontoEl.textContent = `-${desconto.toFixed(2)}%`;
            } else if (desconto < 0) {
                descontoEl.className = 'desconto-info desconto-negativo';
                descontoEl.textContent = `+${Math.abs(desconto).toFixed(2)}%`;
            } else {
                descontoEl.textContent = '';
            }
        }
    }

    // Agendar salvamento automático
    const [cnpj, ano, sequencial] = licitacaoKey.split('-');
    agendarSalvamento(cnpj, parseInt(ano), parseInt(sequencial));

    atualizarResumo();
    atualizarSteps();
}

function atualizarResumo() {
    const resumoDiv = document.getElementById('resumoGeral');
    const resumoConteudo = document.getElementById('resumoConteudo');

    let itensSelecionados = [];
    let totalGeral = 0;
    let totalReferencia = 0;

    licitacoesData.forEach((licitacao, key) => {
        licitacao.itens.forEach(item => {
            if (valoresProposta[item.id].selecionado) {
                const valorUnit = valoresProposta[item.id].valorUnitario || 0;
                const total = valorUnit * item.quantidade;
                totalGeral += total;
                totalReferencia += item.valorUnitarioEstimado * item.quantidade;

                itensSelecionados.push({
                    ...item,
                    licitacao: licitacao,
                    valorProposta: valorUnit,
                    totalProposta: total
                });
            }
        });
    });

    if (itensSelecionados.length === 0) {
        resumoDiv.style.display = 'none';
        return;
    }

    resumoDiv.style.display = 'block';

    const descontoGeral = totalReferencia > 0 ? ((totalReferencia - totalGeral) / totalReferencia * 100) : 0;

    resumoConteudo.innerHTML = `
        <div class="resumo-proposta">
            <div class="resumo-item">
                <span>Itens selecionados</span>
                <span>${itensSelecionados.length}</span>
            </div>
            <div class="resumo-item">
                <span>Valor de referência total</span>
                <span>${formatarValor(totalReferencia)}</span>
            </div>
            <div class="resumo-item">
                <span>Desconto médio</span>
                <span class="${descontoGeral > 0 ? 'desconto-positivo' : 'desconto-negativo'}">
                    ${descontoGeral > 0 ? '-' : '+'}${Math.abs(descontoGeral).toFixed(2)}%
                </span>
            </div>
            <div class="resumo-total">
                <span>TOTAL DA PROPOSTA</span>
                <span>${formatarValor(totalGeral)}</span>
            </div>
        </div>
    `;
}

function atualizarSteps() {
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');

    // Verificar se há itens selecionados
    let temSelecionados = false;
    let todosComValor = true;

    Object.values(valoresProposta).forEach(item => {
        if (item.selecionado) {
            temSelecionados = true;
            if (!item.valorUnitario) {
                todosComValor = false;
            }
        }
    });

    // Step 1 - Selecionar
    if (temSelecionados) {
        step1.classList.remove('active');
        step1.classList.add('completed');
    } else {
        step1.classList.add('active');
        step1.classList.remove('completed');
    }

    // Step 2 - Valores
    if (temSelecionados && !todosComValor) {
        step2.classList.add('active');
        step2.classList.remove('completed');
    } else if (temSelecionados && todosComValor) {
        step2.classList.remove('active');
        step2.classList.add('completed');
    } else {
        step2.classList.remove('active');
        step2.classList.remove('completed');
    }

    // Step 3 - Enviar
    if (temSelecionados && todosComValor) {
        step3.classList.add('active');
    } else {
        step3.classList.remove('active');
        step3.classList.remove('completed');
    }
}

function copiarItem(event, itemId) {
    let itemData = null;
    let licitacaoData = null;

    licitacoesData.forEach((lic, key) => {
        const found = lic.itens.find(i => i.id === itemId);
        if (found) {
            itemData = found;
            licitacaoData = lic;
        }
    });

    if (!itemData) return;

    const valorProposta = valoresProposta[itemId].valorUnitario;

    const texto = [
        `Item: ${itemData.numeroItem}`,
        `Descrição: ${itemData.descricao}`,
        `Quantidade: ${itemData.quantidade} ${itemData.unidadeMedida}`,
        `Valor Referência: ${formatarValor(itemData.valorUnitarioEstimado)}`,
        `Valor Proposta: ${valorProposta ? formatarValor(valorProposta) : 'Não definido'}`,
        `Total: ${valorProposta ? formatarValor(valorProposta * itemData.quantidade) : 'Não definido'}`
    ].join('\n');

    navigator.clipboard.writeText(texto).then(() => {
        const btn = event.target;
        const textoOriginal = btn.textContent;
        btn.textContent = 'Copiado!';
        btn.style.background = '#4caf50';
        setTimeout(() => {
            btn.textContent = textoOriginal;
            btn.style.background = '';
        }, 1500);
    });
}

function copiarResumo() {
    let texto = 'RESUMO DA PROPOSTA\n';
    texto += '='.repeat(50) + '\n\n';

    licitacoesData.forEach((licitacao, key) => {
        const itensLic = licitacao.itens.filter(item => valoresProposta[item.id].selecionado);

        if (itensLic.length === 0) return;

        texto += `LICITAÇÃO: ${licitacao.objetoCompra}\n`;
        texto += `Órgão: ${licitacao.nomeOrgao}\n`;
        texto += `UASG: ${licitacao.codigoUnidadeCompradora}\n`;
        texto += '-'.repeat(40) + '\n';

        itensLic.forEach(item => {
            const valor = valoresProposta[item.id].valorUnitario;
            texto += `Item ${item.numeroItem}: ${item.descricao}\n`;
            texto += `  Qtd: ${item.quantidade} | Valor Unit: ${formatarValor(valor)} | Total: ${formatarValor(valor * item.quantidade)}\n`;
        });

        texto += '\n';
    });

    navigator.clipboard.writeText(texto).then(() => {
        alert('Resumo copiado para a área de transferência!');
    });
}

async function gerarPDF(assinar = false) {
    const { jsPDF } = window.jspdf;

    // Coletar itens selecionados agrupados por licitação
    const licitacoesParaPDF = [];

    licitacoesData.forEach((licitacao, key) => {
        const itensSelecionados = licitacao.itens.filter(item =>
            valoresProposta[item.id].selecionado && valoresProposta[item.id].valorUnitario
        );

        if (itensSelecionados.length > 0) {
            licitacoesParaPDF.push({
                ...licitacao,
                itensParaPDF: itensSelecionados.map(item => ({
                    ...item,
                    valorProposta: valoresProposta[item.id].valorUnitario,
                    totalProposta: valoresProposta[item.id].valorUnitario * item.quantidade,
                    marca: valoresProposta[item.id].marca || '',
                    modelo: valoresProposta[item.id].modelo || '',
                    fabricante: valoresProposta[item.id].fabricante || ''
                }))
            });
        }
    });

    if (licitacoesParaPDF.length === 0) {
        alert('Selecione ao menos um item com valor definido para gerar o PDF.');
        return;
    }

    // Buscar dados do fornecedor
    let fornecedor = null;
    try {
        const response = await fetch('/api/fornecedor');
        const result = await response.json();
        if (result.success && result.data) {
            fornecedor = result.data;
        }
    } catch (error) {
        console.error('Erro ao buscar dados do fornecedor:', error);
    }

    // Gerar um PDF para cada licitação
    for (const licitacao of licitacoesParaPDF) {
        const doc = new jsPDF();
        let y = 20;

        // Configurações de fonte
        doc.setFont('helvetica');

        // === CABEÇALHO COM OU SEM LOGO ===
        if (fornecedor && fornecedor.logoBase64) {
            // Com logo: logo à esquerda, título à direita
            try {
                doc.addImage(fornecedor.logoBase64, 'PNG', 15, y - 5, 45, 22);
                doc.setFontSize(18);
                doc.setTextColor(0, 51, 102);
                doc.text('PROPOSTA COMERCIAL', 130, y + 8, { align: 'center' });
                y += 25;
            } catch (e) {
                console.log('Erro ao adicionar logo:', e);
                // Fallback sem logo
                doc.setFontSize(18);
                doc.setTextColor(0, 51, 102);
                doc.text('PROPOSTA COMERCIAL', 105, y, { align: 'center' });
                y += 15;
            }
        } else {
            // Sem logo: título centralizado
            doc.setFontSize(18);
            doc.setTextColor(0, 51, 102);
            doc.text('PROPOSTA COMERCIAL', 105, y, { align: 'center' });
            y += 15;
        }

        // Linha separadora
        doc.setDrawColor(0, 51, 102);
        doc.setLineWidth(0.5);
        doc.line(15, y, 195, y);
        y += 10;

        // === DADOS DA EMPRESA ===
        doc.setFontSize(11);
        doc.setTextColor(0, 0, 0);
        doc.setFont('helvetica', 'bold');
        doc.text('DADOS DO FORNECEDOR', 15, y);
        y += 7;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);

        if (fornecedor && fornecedor.razaoSocial) {
            // Dados preenchidos do fornecedor
            doc.text(`Razão Social: ${fornecedor.razaoSocial}`, 15, y);
            y += 6;
            doc.text(`CNPJ: ${fornecedor.cnpj || 'N/A'}    Inscrição Estadual: ${fornecedor.inscricaoEstadual || 'N/A'}`, 15, y);
            y += 6;
            const enderecoCompleto = [
                fornecedor.endereco,
                fornecedor.numero ? `nº ${fornecedor.numero}` : '',
                fornecedor.complemento,
                fornecedor.bairro
            ].filter(Boolean).join(', ');
            doc.text(`Endereço: ${enderecoCompleto || 'N/A'}`, 15, y);
            y += 6;
            doc.text(`Cidade: ${fornecedor.cidade || 'N/A'}    UF: ${fornecedor.uf || 'N/A'}    CEP: ${fornecedor.cep || 'N/A'}`, 15, y);
            y += 6;
            doc.text(`Telefone: ${fornecedor.telefone || fornecedor.celular || 'N/A'}    E-mail: ${fornecedor.email || 'N/A'}`, 15, y);
            y += 12;
        } else {
            // Campos em branco para preenchimento manual
            doc.text('Razão Social: ________________________________________________________', 15, y);
            y += 6;
            doc.text('CNPJ: ___________________________ Inscrição Estadual: _________________', 15, y);
            y += 6;
            doc.text('Endereço: ___________________________________________________________', 15, y);
            y += 6;
            doc.text('Cidade: _________________________ UF: ______ CEP: ___________________', 15, y);
            y += 6;
            doc.text('Telefone: ______________________ E-mail: ____________________________', 15, y);
            y += 12;
        }

        // === DADOS DA LICITAÇÃO ===
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('DADOS DA LICITAÇÃO', 15, y);
        y += 7;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);

        doc.text(`Órgão: ${licitacao.nomeOrgao}`, 15, y);
        y += 6;
        doc.text(`UASG: ${licitacao.codigoUnidadeCompradora || 'N/A'}`, 15, y);
        y += 6;
        doc.text(`Número: ${licitacao.numeroCompra || 'N/A'}/${licitacao.ano}`, 15, y);
        y += 6;
        doc.text(`Modalidade: ${licitacao.modalidadeNome || 'Pregão Eletrônico'}`, 15, y);
        y += 12;

        // === TABELA DE ITENS ===
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('ITENS DA PROPOSTA', 15, y);
        y += 5;

        // Preparar dados da tabela
        const tableData = licitacao.itensParaPDF.map(item => [
            item.numeroItem,
            item.descricao,
            item.marca || '-',
            item.modelo || '-',
            item.fabricante || '-',
            `${item.quantidade} ${item.unidadeMedida}`,
            formatarValorPDF(item.valorProposta),
            formatarValorPDF(item.totalProposta)
        ]);

        // Calcular total geral
        const totalGeral = licitacao.itensParaPDF.reduce((sum, item) => sum + item.totalProposta, 0);

        // Adicionar linha de total
        tableData.push(['', '', '', '', '', '', { content: 'TOTAL:', styles: { fontStyle: 'bold', halign: 'right' } },
                       { content: formatarValorPDF(totalGeral), styles: { fontStyle: 'bold' } }]);

        // Renderizar tabela
        doc.autoTable({
            startY: y,
            head: [['Item', 'Descrição', 'Marca', 'Modelo', 'Fabricante', 'Qtd', 'Valor Unit.', 'Valor Total']],
            body: tableData,
            theme: 'striped',
            headStyles: {
                fillColor: [0, 51, 102],
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                fontSize: 8
            },
            bodyStyles: {
                fontSize: 7
            },
            columnStyles: {
                0: { cellWidth: 10, halign: 'center' },
                1: { cellWidth: 'auto' },
                2: { cellWidth: 22 },
                3: { cellWidth: 22 },
                4: { cellWidth: 22 },
                5: { cellWidth: 18, halign: 'center' },
                6: { cellWidth: 22, halign: 'right' },
                7: { cellWidth: 22, halign: 'right' }
            },
            styles: {
                overflow: 'linebreak',
                cellPadding: 2
            },
            margin: { left: 10, right: 10 }
        });

        y = doc.lastAutoTable.finalY + 15;

        // === OBSERVAÇÕES ADICIONAIS ===
        if (fornecedor && fornecedor.observacoes && fornecedor.observacoes.trim()) {
            if (y > 240) {
                doc.addPage();
                y = 20;
            }
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(10);
            doc.text('OBSERVAÇÕES', 15, y);
            y += 6;

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(9);
            const obsLines = doc.splitTextToSize(fornecedor.observacoes, 180);
            doc.text(obsLines, 15, y);
            y += obsLines.length * 4 + 8;
        }

        // === ASSINATURA ===
        // Se passar do limite da página, criar nova página
        if (y > 250) {
            doc.addPage();
            y = 20;
        }

        const dataAtual = new Date().toLocaleDateString('pt-BR', {
            day: '2-digit',
            month: 'long',
            year: 'numeric'
        });

        doc.setFontSize(10);
        if (fornecedor && fornecedor.cidade) {
            doc.text(`${fornecedor.cidade}/${fornecedor.uf || ''}, ${dataAtual}`, 15, y);
        } else {
            doc.text(`Local e Data: _________________________, ${dataAtual}`, 15, y);
        }
        y += 20;

        doc.line(40, y, 170, y);
        y += 5;
        doc.setFontSize(9);

        if (fornecedor && fornecedor.representanteLegal) {
            doc.text(fornecedor.representanteLegal, 105, y, { align: 'center' });
            y += 4;
            const infoRepresentante = [
                fornecedor.cpfRepresentante ? `CPF: ${fornecedor.cpfRepresentante}` : '',
                fornecedor.cargoRepresentante || ''
            ].filter(Boolean).join(' - ');
            doc.text(infoRepresentante || 'Representante Legal', 105, y, { align: 'center' });
        } else {
            doc.text('Assinatura do Representante Legal', 105, y, { align: 'center' });
            y += 4;
            doc.text('(Nome, CPF e Cargo)', 105, y, { align: 'center' });
        }

        // === RODAPÉ ===
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(128, 128, 128);
            doc.text(`Página ${i} de ${pageCount}`, 195, 290, { align: 'right' });
        }

        // Gerar nome do arquivo
        const nomeArquivo = `proposta_${licitacao.numeroCompra || licitacao.sequencial}_${licitacao.ano}_${new Date().toISOString().split('T')[0]}${assinar ? '_assinado' : ''}.pdf`;

        if (assinar) {
            // Enviar PDF para assinatura digital
            const pdfBase64 = doc.output('datauristring').split(',')[1];

            try {
                const response = await fetch('/api/pdf/assinar', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pdfBase64 })
                });

                const result = await response.json();

                if (result.success) {
                    // Download do PDF assinado
                    const link = document.createElement('a');
                    link.href = 'data:application/pdf;base64,' + result.pdfAssinado;
                    link.download = nomeArquivo;
                    link.click();

                    // Mostrar aviso se a assinatura criptográfica falhou
                    if (result.aviso) {
                        console.warn('Aviso de assinatura:', result.aviso);
                    }
                } else {
                    alert('Erro ao assinar: ' + result.error);
                    // Fazer download do PDF sem assinatura
                    doc.save(nomeArquivo.replace('_assinado', ''));
                }
            } catch (error) {
                console.error('Erro ao assinar PDF:', error);
                alert('Erro ao assinar PDF. Gerando versão sem assinatura.');
                doc.save(nomeArquivo.replace('_assinado', ''));
            }
        } else {
            // Download do PDF sem assinatura
            doc.save(nomeArquivo);
        }
    }

    if (licitacoesParaPDF.length === 1) {
        alert(assinar ? 'PDF assinado gerado com sucesso!' : 'PDF gerado com sucesso!');
    } else {
        alert(`${licitacoesParaPDF.length} PDFs ${assinar ? 'assinados ' : ''}gerados com sucesso!`);
    }
}

function formatarValorPDF(valor) {
    return 'R$ ' + valor.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Gerar PDF para uma licitação individual (usado por gerarPDFLicitacao)
async function gerarPDFIndividual(licitacao, assinar = false) {
    const { jsPDF } = window.jspdf;

    // Buscar dados do fornecedor
    let fornecedor = null;
    try {
        const response = await fetch('/api/fornecedor');
        const result = await response.json();
        if (result.success && result.data) {
            fornecedor = result.data;
        }
    } catch (error) {
        console.error('Erro ao buscar dados do fornecedor:', error);
    }

    const doc = new jsPDF();
    let y = 20;

    // Configurações de fonte
    doc.setFont('helvetica');

    // === CABEÇALHO COM OU SEM LOGO ===
    if (fornecedor && fornecedor.logoBase64) {
        try {
            doc.addImage(fornecedor.logoBase64, 'PNG', 15, y - 5, 45, 22);
            doc.setFontSize(18);
            doc.setTextColor(0, 51, 102);
            doc.text('PROPOSTA COMERCIAL', 130, y + 8, { align: 'center' });
            y += 25;
        } catch (e) {
            doc.setFontSize(18);
            doc.setTextColor(0, 51, 102);
            doc.text('PROPOSTA COMERCIAL', 105, y, { align: 'center' });
            y += 15;
        }
    } else {
        doc.setFontSize(18);
        doc.setTextColor(0, 51, 102);
        doc.text('PROPOSTA COMERCIAL', 105, y, { align: 'center' });
        y += 15;
    }

    // Linha separadora
    doc.setDrawColor(0, 51, 102);
    doc.setLineWidth(0.5);
    doc.line(15, y, 195, y);
    y += 10;

    // === DADOS DA EMPRESA ===
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.text('DADOS DO FORNECEDOR', 15, y);
    y += 7;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    if (fornecedor && fornecedor.razaoSocial) {
        doc.text(`Razão Social: ${fornecedor.razaoSocial}`, 15, y);
        y += 6;
        doc.text(`CNPJ: ${fornecedor.cnpj || 'N/A'}    Inscrição Estadual: ${fornecedor.inscricaoEstadual || 'N/A'}`, 15, y);
        y += 6;
        const enderecoCompleto = [
            fornecedor.endereco,
            fornecedor.numero ? `nº ${fornecedor.numero}` : '',
            fornecedor.complemento,
            fornecedor.bairro
        ].filter(Boolean).join(', ');
        doc.text(`Endereço: ${enderecoCompleto || 'N/A'}`, 15, y);
        y += 6;
        doc.text(`Cidade: ${fornecedor.cidade || 'N/A'}    UF: ${fornecedor.uf || 'N/A'}    CEP: ${fornecedor.cep || 'N/A'}`, 15, y);
        y += 6;
        doc.text(`Telefone: ${fornecedor.telefone || fornecedor.celular || 'N/A'}    E-mail: ${fornecedor.email || 'N/A'}`, 15, y);
        y += 12;
    } else {
        doc.text('Razão Social: ________________________________________________________', 15, y);
        y += 6;
        doc.text('CNPJ: ___________________________ Inscrição Estadual: _________________', 15, y);
        y += 6;
        doc.text('Endereço: ___________________________________________________________', 15, y);
        y += 6;
        doc.text('Cidade: _________________________ UF: ______ CEP: ___________________', 15, y);
        y += 6;
        doc.text('Telefone: ______________________ E-mail: ____________________________', 15, y);
        y += 12;
    }

    // === DADOS DA LICITAÇÃO ===
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('DADOS DA LICITAÇÃO', 15, y);
    y += 7;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    doc.text(`Órgão: ${licitacao.nomeOrgao}`, 15, y);
    y += 6;
    doc.text(`UASG: ${licitacao.codigoUnidadeCompradora || 'N/A'}`, 15, y);
    y += 6;
    doc.text(`Número: ${licitacao.numeroCompra || 'N/A'}/${licitacao.ano}`, 15, y);
    y += 6;
    doc.text(`Modalidade: ${licitacao.modalidadeNome || 'Pregão Eletrônico'}`, 15, y);
    y += 12;

    // === TABELA DE ITENS ===
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('ITENS DA PROPOSTA', 15, y);
    y += 5;

    const tableData = licitacao.itensParaPDF.map(item => [
        item.numeroItem,
        item.descricao,
        item.marca || '-',
        item.modelo || '-',
        item.fabricante || '-',
        `${item.quantidade} ${item.unidadeMedida}`,
        formatarValorPDF(item.valorProposta),
        formatarValorPDF(item.totalProposta)
    ]);

    const totalGeral = licitacao.itensParaPDF.reduce((sum, item) => sum + item.totalProposta, 0);

    tableData.push(['', '', '', '', '', '', { content: 'TOTAL:', styles: { fontStyle: 'bold', halign: 'right' } },
                   { content: formatarValorPDF(totalGeral), styles: { fontStyle: 'bold' } }]);

    doc.autoTable({
        startY: y,
        head: [['Item', 'Descrição', 'Marca', 'Modelo', 'Fabricante', 'Qtd', 'Valor Unit.', 'Valor Total']],
        body: tableData,
        theme: 'striped',
        headStyles: {
            fillColor: [0, 51, 102],
            textColor: [255, 255, 255],
            fontStyle: 'bold',
            fontSize: 8
        },
        bodyStyles: { fontSize: 7 },
        columnStyles: {
            0: { cellWidth: 10, halign: 'center' },
            1: { cellWidth: 'auto' },
            2: { cellWidth: 22 },
            3: { cellWidth: 22 },
            4: { cellWidth: 22 },
            5: { cellWidth: 18, halign: 'center' },
            6: { cellWidth: 22, halign: 'right' },
            7: { cellWidth: 22, halign: 'right' }
        },
        styles: { overflow: 'linebreak', cellPadding: 2 },
        margin: { left: 10, right: 10 }
    });

    y = doc.lastAutoTable.finalY + 15;

    // === OBSERVAÇÕES ===
    if (fornecedor && fornecedor.observacoes && fornecedor.observacoes.trim()) {
        if (y > 240) { doc.addPage(); y = 20; }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('OBSERVAÇÕES', 15, y);
        y += 6;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        const obsLines = doc.splitTextToSize(fornecedor.observacoes, 180);
        doc.text(obsLines, 15, y);
        y += obsLines.length * 4 + 8;
    }

    // === ASSINATURA ===
    if (y > 250) { doc.addPage(); y = 20; }

    const dataAtual = new Date().toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'long', year: 'numeric'
    });

    doc.setFontSize(10);
    if (fornecedor && fornecedor.cidade) {
        doc.text(`${fornecedor.cidade}/${fornecedor.uf || ''}, ${dataAtual}`, 15, y);
    } else {
        doc.text(`Local e Data: _________________________, ${dataAtual}`, 15, y);
    }
    y += 20;

    doc.line(40, y, 170, y);
    y += 5;
    doc.setFontSize(9);

    if (fornecedor && fornecedor.representanteLegal) {
        doc.text(fornecedor.representanteLegal, 105, y, { align: 'center' });
        y += 4;
        const infoRepresentante = [
            fornecedor.cpfRepresentante ? `CPF: ${fornecedor.cpfRepresentante}` : '',
            fornecedor.cargoRepresentante || ''
        ].filter(Boolean).join(' - ');
        doc.text(infoRepresentante || 'Representante Legal', 105, y, { align: 'center' });
    } else {
        doc.text('Assinatura do Representante Legal', 105, y, { align: 'center' });
        y += 4;
        doc.text('(Nome, CPF e Cargo)', 105, y, { align: 'center' });
    }

    // === RODAPÉ ===
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(8);
        doc.setTextColor(128, 128, 128);
        doc.text(`Página ${i} de ${pageCount}`, 195, 290, { align: 'right' });
    }

    const nomeArquivo = `proposta_${licitacao.numeroCompra || licitacao.sequencial}_${licitacao.ano}_${new Date().toISOString().split('T')[0]}${assinar ? '_assinado' : ''}.pdf`;

    if (assinar) {
        const pdfBase64 = doc.output('datauristring').split(',')[1];
        try {
            const response = await fetch('/api/pdf/assinar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pdfBase64 })
            });
            const result = await response.json();
            if (result.success) {
                const link = document.createElement('a');
                link.href = 'data:application/pdf;base64,' + result.pdfAssinado;
                link.download = nomeArquivo;
                link.click();
            } else {
                alert('Erro ao assinar: ' + result.error);
                doc.save(nomeArquivo.replace('_assinado', ''));
            }
        } catch (error) {
            alert('Erro ao assinar PDF. Gerando versão sem assinatura.');
            doc.save(nomeArquivo.replace('_assinado', ''));
        }
    } else {
        doc.save(nomeArquivo);
    }

    alert(assinar ? 'PDF assinado gerado com sucesso!' : 'PDF gerado com sucesso!');
}

function exportarCSV() {
    let csv = 'Licitacao;Orgao;UASG;Item;Descricao;Quantidade;Unidade;Valor Referencia;Valor Proposta;Total Proposta\n';

    licitacoesData.forEach((licitacao, key) => {
        licitacao.itens.forEach(item => {
            if (!valoresProposta[item.id].selecionado) return;

            const valor = valoresProposta[item.id].valorUnitario || 0;
            csv += [
                `"${licitacao.objetoCompra.replace(/"/g, '""')}"`,
                `"${licitacao.nomeOrgao.replace(/"/g, '""')}"`,
                licitacao.codigoUnidadeCompradora,
                item.numeroItem,
                `"${item.descricao.replace(/"/g, '""')}"`,
                item.quantidade,
                item.unidadeMedida,
                item.valorUnitarioEstimado.toFixed(2).replace('.', ','),
                valor.toFixed(2).replace('.', ','),
                (valor * item.quantidade).toFixed(2).replace('.', ',')
            ].join(';') + '\n';
        });
    });

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `propostas_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
}

// Exportar CSV de uma licitação específica
function exportarCSVLicitacao(licitacaoKey) {
    const licitacao = licitacoesData.get(licitacaoKey);
    if (!licitacao) return;

    const itensSelecionados = licitacao.itens.filter(item => valoresProposta[item.id].selecionado);
    if (itensSelecionados.length === 0) {
        alert('Selecione ao menos um item desta licitação para exportar.');
        return;
    }

    let csv = 'Item;Descricao;Quantidade;Unidade;Valor Referencia;Valor Proposta;Total Proposta\n';

    itensSelecionados.forEach(item => {
        const valor = valoresProposta[item.id].valorUnitario || item.valorUnitarioEstimado;
        csv += [
            item.numeroItem,
            `"${item.descricao.replace(/"/g, '""')}"`,
            item.quantidade,
            item.unidadeMedida,
            item.valorUnitarioEstimado.toFixed(2).replace('.', ','),
            valor.toFixed(2).replace('.', ','),
            (valor * item.quantidade).toFixed(2).replace('.', ',')
        ].join(';') + '\n';
    });

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `proposta_${licitacao.numeroCompra || licitacao.sequencial}_${licitacao.ano}.csv`;
    link.click();
}

// Gerar PDF de uma licitação específica
async function gerarPDFLicitacao(licitacaoKey, assinar = false) {
    const licitacao = licitacoesData.get(licitacaoKey);
    if (!licitacao) return;

    const itensSelecionados = licitacao.itens.filter(item =>
        valoresProposta[item.id].selecionado
    );

    if (itensSelecionados.length === 0) {
        alert('Selecione ao menos um item desta licitação para gerar o PDF.');
        return;
    }

    // Criar licitação formatada para PDF
    const licitacaoParaPDF = {
        ...licitacao,
        itensParaPDF: itensSelecionados.map(item => ({
            ...item,
            valorProposta: valoresProposta[item.id].valorUnitario || item.valorUnitarioEstimado,
            totalProposta: (valoresProposta[item.id].valorUnitario || item.valorUnitarioEstimado) * item.quantidade,
            marca: valoresProposta[item.id].marca || '',
            modelo: valoresProposta[item.id].modelo || '',
            fabricante: valoresProposta[item.id].fabricante || ''
        }))
    };

    // Chamar função de geração de PDF individual
    await gerarPDFIndividual(licitacaoParaPDF, assinar);
}

// Abrir modal de envio para uma licitação específica
function abrirModalEnvioLicitacao(licitacaoKey) {
    const licitacao = licitacoesData.get(licitacaoKey);
    if (!licitacao) return;

    const itensSelecionados = licitacao.itens.filter(item => valoresProposta[item.id].selecionado);

    if (itensSelecionados.length === 0) {
        alert('Selecione ao menos um item desta licitação para enviar.');
        return;
    }

    licitacaoParaEnvio = {
        cnpj: licitacao.cnpj,
        ano: licitacao.ano,
        sequencial: licitacao.sequencial,
        objetoCompra: licitacao.objetoCompra,
        nomeOrgao: licitacao.nomeOrgao,
        linkSistemaOrigem: licitacao.linkSistemaOrigem,
        itens: itensSelecionados.map(item => ({
            numeroItem: item.numeroItem,
            descricao: item.descricao,
            valorUnitario: valoresProposta[item.id].valorUnitario || item.valorUnitarioEstimado,
            quantidade: item.quantidade
        }))
    };

    // Mostrar info da licitação
    document.getElementById('envioLicitacaoInfo').innerHTML = `
        <div style="background: #1a1a2e; padding: 15px; border-radius: 8px;">
            <div style="font-weight: 600; margin-bottom: 10px;">${licitacaoParaEnvio.objetoCompra}</div>
            <div style="color: #888; font-size: 0.9em;">${licitacaoParaEnvio.nomeOrgao}</div>
            <div style="margin-top: 10px; color: #4dabf7;">${itensSelecionados.length} item(ns) para enviar</div>
        </div>
    `;

    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('envioMensagem').textContent = 'Clique em "Iniciar Envio" para começar';
    document.getElementById('envioLog').innerHTML = '';
    document.getElementById('btnIniciarEnvio').disabled = false;

    document.getElementById('modalEnvio').style.display = 'flex';
}

function formatarValor(valor) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(valor);
}

// ==================== CREDENCIAIS ====================

async function verificarCredenciais() {
    try {
        const response = await fetch('/api/credenciais/status');
        const result = await response.json();

        const statusDiv = document.getElementById('statusCredenciais');
        if (result.configurado) {
            statusDiv.innerHTML = `<span class="credenciais-ok">✓ Credenciais configuradas (${result.usuario})</span>`;
        } else {
            statusDiv.innerHTML = `<span class="credenciais-pendente">⚠ Credenciais não configuradas</span>`;
        }
    } catch (error) {
        console.error('Erro ao verificar credenciais:', error);
    }
}

function abrirModalCredenciais() {
    document.getElementById('modalCredenciais').style.display = 'flex';
}

function fecharModalCredenciais() {
    document.getElementById('modalCredenciais').style.display = 'none';
    document.getElementById('inputUsuario').value = '';
    document.getElementById('inputSenha').value = '';
}

async function salvarCredenciais() {
    const usuario = document.getElementById('inputUsuario').value.trim();
    const senha = document.getElementById('inputSenha').value;

    if (!usuario || !senha) {
        alert('Preencha usuário e senha');
        return;
    }

    try {
        const response = await fetch('/api/credenciais', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario, senha })
        });

        const result = await response.json();

        if (result.success) {
            alert('Credenciais salvas com sucesso!');
            fecharModalCredenciais();
            verificarCredenciais();
        } else {
            alert('Erro ao salvar: ' + result.error);
        }
    } catch (error) {
        alert('Erro ao salvar credenciais');
        console.error(error);
    }
}

// ==================== ENVIO DE PROPOSTA ====================

let licitacaoParaEnvio = null;

function abrirModalEnvio() {
    // Pegar a primeira licitação com itens selecionados
    let licitacaoSelecionada = null;
    let itensSelecionados = [];

    licitacoesData.forEach((licitacao, key) => {
        // Permite itens selecionados mesmo sem valor digitado (usará valor de referência)
        const itensLic = licitacao.itens.filter(item =>
            valoresProposta[item.id].selecionado
        );

        if (itensLic.length > 0 && !licitacaoSelecionada) {
            licitacaoSelecionada = { ...licitacao, key };
            itensSelecionados = itensLic.map(item => ({
                numeroItem: item.numeroItem,
                descricao: item.descricao,
                // Usa valor digitado se houver, senão usa valor de referência (valorUnitarioEstimado)
                valorUnitario: valoresProposta[item.id].valorUnitario || item.valorUnitarioEstimado,
                quantidade: item.quantidade
            }));
        }
    });

    if (!licitacaoSelecionada) {
        alert('Selecione ao menos um item para enviar.');
        return;
    }

    licitacaoParaEnvio = {
        cnpj: licitacaoSelecionada.cnpj,
        ano: licitacaoSelecionada.ano,
        sequencial: licitacaoSelecionada.sequencial,
        objetoCompra: licitacaoSelecionada.objetoCompra,
        nomeOrgao: licitacaoSelecionada.nomeOrgao,
        linkSistemaOrigem: licitacaoSelecionada.linkSistemaOrigem,
        itens: itensSelecionados
    };

    // Mostrar info da licitação
    document.getElementById('envioLicitacaoInfo').innerHTML = `
        <div style="background: #1a1a2e; padding: 15px; border-radius: 8px;">
            <div style="font-weight: 600; margin-bottom: 10px;">${licitacaoParaEnvio.objetoCompra}</div>
            <div style="color: #888; font-size: 0.9em;">${licitacaoParaEnvio.nomeOrgao}</div>
            <div style="margin-top: 10px; color: #4dabf7;">${itensSelecionados.length} item(ns) para enviar</div>
        </div>
    `;

    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('envioMensagem').textContent = 'Clique em "Iniciar Envio" para começar';
    document.getElementById('envioLog').innerHTML = '';
    document.getElementById('btnIniciarEnvio').disabled = false;

    document.getElementById('modalEnvio').style.display = 'flex';
}

function fecharModalEnvio() {
    document.getElementById('modalEnvio').style.display = 'none';
    licitacaoParaEnvio = null;
}

async function iniciarEnvio() {
    if (!licitacaoParaEnvio) return;

    const btnEnviar = document.getElementById('btnIniciarEnvio');
    btnEnviar.disabled = true;
    btnEnviar.textContent = 'Enviando...';

    const logDiv = document.getElementById('envioLog');
    const mensagemDiv = document.getElementById('envioMensagem');
    const progressFill = document.getElementById('progressFill');

    logDiv.innerHTML = '<div style="color: #4dabf7;">Iniciando processo de envio...</div>';

    try {
        const response = await fetch('/api/proposta/enviar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(licitacaoParaEnvio)
        });

        const result = await response.json();

        if (result.success) {
            progressFill.style.width = '100%';
            mensagemDiv.innerHTML = '<span style="color: #4caf50;">✓ ' + result.message + '</span>';
            if (result.itensPreenchidos !== undefined && result.totalItens !== undefined) {
                logDiv.innerHTML += `<div style="color: #4caf50; margin-top: 10px;">
                    Itens preenchidos: ${result.itensPreenchidos} de ${result.totalItens}
                </div>`;
            }
            if (result.linkCadastroProposta) {
                logDiv.innerHTML += `<div style="margin-top: 15px; padding: 10px; background: #0f3460; border-radius: 6px;">
                    <a href="${result.linkCadastroProposta}" target="_blank" class="btn-primary" style="text-decoration: none; display: inline-block;">
                        Abrir Cadastro de Proposta
                    </a>
                </div>`;
            }
        } else {
            mensagemDiv.innerHTML = '<span style="color: #f44336;">✗ Não foi possível enviar automaticamente</span>';
            logDiv.innerHTML += `<div style="color: #ff9800; margin-top: 10px;">${result.error}</div>`;

            // Link do PNCP
            if (result.linkPncp) {
                logDiv.innerHTML += `<div style="margin-top: 15px; padding: 10px; background: #0f3460; border-radius: 6px;">
                    <div style="margin-bottom: 10px;">Modalidade: ${result.modalidade || 'Não informada'}</div>
                    <a href="${result.linkPncp}" target="_blank" class="btn-primary" style="text-decoration: none; display: inline-block;">
                        Abrir no PNCP
                    </a>
                </div>`;
            }

            // Link do sistema externo
            if (result.link) {
                logDiv.innerHTML += `<div style="margin-top: 15px; padding: 10px; background: #0f3460; border-radius: 6px;">
                    <a href="${result.link}" target="_blank" class="btn-primary" style="text-decoration: none; display: inline-block;">
                        Abrir no Sistema
                    </a>
                </div>`;
            }
        }

    } catch (error) {
        mensagemDiv.innerHTML = '<span style="color: #f44336;">Erro de conexão</span>';
        logDiv.innerHTML += `<div style="color: #f44336;">Erro: ${error.message}</div>`;
    }

    btnEnviar.textContent = 'Iniciar Envio';
    btnEnviar.disabled = false;
}

// ==================== INICIALIZAÇÃO ====================

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', () => {
    carregarItensInteresse();
    verificarCredenciais();
});
