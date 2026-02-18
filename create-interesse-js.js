const fs = require('fs');

const js = `
async function carregarInteresses() {
    const loadingContainer = document.getElementById('loadingContainer');
    const interessesContainer = document.getElementById('interessesContainer');
    const emptyState = document.getElementById('emptyState');
    const totalInfo = document.getElementById('totalInfo');

    try {
        const response = await fetch('/api/interesse');
        const interesses = await response.json();

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
                    objetoCompra: item.objetoCompra || 'Objeto não disponível',
                    nomeOrgao: item.nomeOrgao || 'Órgão não disponível',
                    codigoUnidadeCompradora: item.codigoUnidadeCompradora || '',
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

        // Calcular totais
        let totalLicitacoes = licitacoesMap.size;
        let totalItens = interesses.length;
        let valorTotal = 0;

        interesses.forEach(item => {
            const valor = parseFloat(item.valorUnitarioEstimado) || 0;
            const qtd = parseFloat(item.quantidade) || 1;
            valorTotal += valor * qtd;
        });

        // Exibir totais
        document.getElementById('totalLicitacoes').textContent = totalLicitacoes;
        document.getElementById('totalItens').textContent = totalItens;
        document.getElementById('valorTotal').textContent = formatarValor(valorTotal);
        totalInfo.style.display = 'flex';

        // Renderizar cards
        interessesContainer.innerHTML = '';

        licitacoesMap.forEach((licitacao, key) => {
            const valorLicitacao = licitacao.itens.reduce((sum, item) => {
                return sum + (parseFloat(item.valorUnitarioEstimado) || 0) * (parseFloat(item.quantidade) || 1);
            }, 0);

            const card = document.createElement('div');
            card.className = 'interesse-card';
            card.innerHTML = \`
                <div class="interesse-header">
                    <div class="interesse-titulo">\${licitacao.objetoCompra}</div>
                </div>
                <div class="interesse-info">
                    <div class="info-item">
                        <span class="info-label">Órgão</span>
                        <span class="info-value">\${licitacao.nomeOrgao}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">UASG</span>
                        <span class="info-value">\${licitacao.codigoUnidadeCompradora}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Ano</span>
                        <span class="info-value">\${licitacao.ano}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">Valor Total</span>
                        <span class="info-value" style="color: #4caf50;">\${formatarValor(valorLicitacao)}</span>
                    </div>
                </div>
                <div class="itens-lista">
                    <h4>Itens de Interesse (\${licitacao.itens.length})</h4>
                    \${licitacao.itens.map(item => \`
                        <div class="item-interesse">
                            <div class="item-info">
                                <span class="item-numero">Item \${item.numeroItem}</span>
                                <span class="item-descricao">\${item.descricao}</span>
                            </div>
                            <span class="item-valor">\${formatarValor(item.valorUnitarioEstimado * item.quantidade)}</span>
                            <button class="btn-remover" onclick="removerInteresse(\${item.id})">Remover</button>
                        </div>
                    \`).join('')}
                </div>
                <div class="interesse-footer">
                    <a href="https://pncp.gov.br/app/editais/\${licitacao.cnpj}/\${licitacao.ano}/\${licitacao.sequencial}" target="_blank" class="btn-detalhes">Ver no PNCP</a>
                </div>
            \`;
            interessesContainer.appendChild(card);
        });

    } catch (error) {
        console.error('Erro ao carregar interesses:', error);
        loadingContainer.innerHTML = '<h3 style="color: #f44336;">Erro ao carregar interesses</h3>';
    }
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

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', carregarInteresses);
`;

fs.writeFileSync('public/interesse.js', js.trim());
console.log('interesse.js criado com sucesso!');
