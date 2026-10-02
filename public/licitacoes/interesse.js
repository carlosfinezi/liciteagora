// Dados globais para filtro
let todasLicitacoes = [];
let licitacoesFiltradas = [];  // recorte atual do filtro — é sobre ele que o relatório sai
let idsVisiveis = [];          // item ids atualmente filtrados/visíveis
let selectedIds = new Set();   // item ids marcados (podem ficar fora dos visíveis se o filtro mudou)

async function carregarInteresses() {
    const loadingContainer = document.getElementById('loadingContainer');
    const interessesContainer = document.getElementById('interessesContainer');
    const emptyState = document.getElementById('emptyState');
    const totalInfo = document.getElementById('totalInfo');
    const filtroBar = document.getElementById('filtroBar');

    try {
        // A permissão de análise IA vai junto: o botão dela é desenhado no card,
        // e resolvê-la depois obrigaria a re-renderizar a lista inteira.
        const [response] = await Promise.all([fetch('/api/interesse'), iaCarregarPermissao()]);
        const result = await response.json();
        const interesses = result.data || [];
        iaAplicarPermissaoNaBarra();

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
                    situacaoCompraNome: item.situacaoCompraNome || '',
                    // Campos do grid de detalhes. Ficam crus: quem decide se a
                    // linha aparece é o montarDetalhesCard, que descarta vazio.
                    nomeUnidade: item.nomeUnidade || '',
                    municipioNome: item.municipioNome || '',
                    ufSigla: item.ufSigla || '',
                    modalidadeNome: item.modalidadeNome || '',
                    // Portal em que a licitação acontece, como o PNCP o nomeia.
                    // Vazio até o restart que carregar o campo novo da rota.
                    portalOrigem: item.portalOrigem || '',
                    srp: item.srp,
                    dataPublicacaoPncp: item.dataPublicacaoPncp || null,
                    valorTotalLicitacao: item.valorTotalLicitacao || 0,
                    qtdMensagens: item.qtdMensagens || 0,
                    compraId: item.compraId || null,
                    qtdResultado: item.qtdResultado || 0,
                    kanbanStatus: item.kanbanStatus || null,
                    kanbanDataAtualizacao: item.kanbanDataAtualizacao || null,
                    // Cru de propósito: 0/1 do servidor, undefined enquanto o
                    // processo não recarregar a rota. Quem decide o que fazer
                    // com cada um desses três casos é o botoAnaliseIaHtml.
                    temAnalise: item.temAnalise,
                    // null = servidor ainda não manda o campo (processo sem
                    // restart); [] = mandou e nenhuma palavra casou.
                    palavrasChave: null,
                    itens: []
                });
            }
            // Palavras do grupo que o servidor achou neste item; o card mostra
            // a união de todos os itens, sem repetir.
            const lic = licitacoesMap.get(key);
            if (Array.isArray(item.palavrasChave)) {
                lic.palavrasChave = lic.palavrasChave || [];
                for (const p of item.palavrasChave) {
                    if (!lic.palavrasChave.includes(p)) lic.palavrasChave.push(p);
                }
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

// Fase da licitação. A ordem dos testes é o que torna as fases exclusivas: cada
// licitação cai em uma só, e nenhuma aparece em duas contagens.
//
// Suspensa/revogada/anulada é testada ANTES das datas porque a situação do PNCP
// invalida a leitura delas: uma licitação anulada não está em disputa no dia de
// uma sessão que não vai acontecer. As três ficam numa opção única, e não em
// três, porque para quem opera a decisão é a mesma — sair de cima.
const FASES_PARADAS = ['Suspensa', 'Revogada', 'Anulada'];

// Dias após o encerramento em que a licitação segue contando como em disputa.
// O PNCP não publica a data da sessão e fora do Comprasnet não há de onde
// tirá-la, então isto é aproximação, não medida.
let FASE_DIAS_DISPUTA = 30;

const FASE_ROTULOS = {
    recebendo: 'Recebendo proposta',
    disputa: 'Em disputa',
    encerrada: 'Encerrada',
    parada: 'Suspensa, revogada ou anulada',
    'sem-data': 'Sem data de encerramento'
};

function faseDaLicitacao(l) {
    if (FASES_PARADAS.includes(l.situacaoCompraNome)) return 'parada';
    const d = dataStr(l.dataEncerramentoProposta);
    if (!d) return 'sem-data';
    // Dia, e não instante: é a mesma convenção do filtro de período, e sem ela
    // a licitação que encerra hoje apareceria em "Em aberto" e em "Em disputa".
    const hoje = hojeStr();
    if (d >= hoje) return 'recebendo';
    if (d >= somarDias(hoje, -FASE_DIAS_DISPUTA)) return 'disputa';
    return 'encerrada';
}

// ─── Filtro de órgão por busca ─────────────────────────────────────────────
// Lista montada em popularFiltrosDinamicos: { nome, qtd, busca }.
let ORGAOS = [];

// Sem acento e sem caixa nos dois lados: os nomes vêm do PNCP em maiúsculas e
// sem acento ("SAO PAULO", "MINISTERIO"), e quem digita escreve "são".
function normalizarBusca(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function buscarOrgao(q) {
    const lista = document.getElementById('filtroOrgaoLista');
    if (!lista) return;
    const termo = normalizarBusca(q);
    // Todo termo precisa casar, em qualquer ordem: "seguranca sao" acha
    // "SAO PAULO SECRETARIA DA SEGURANCA PUBLICA".
    const termos = termo.split(/\s+/).filter(Boolean);
    // Casa pelo órgão ou por qualquer unidade dele. Quando veio só pela
    // unidade, ela aparece embaixo: sem isso o resultado seria inexplicável —
    // buscar "obras" e receber "COMANDO DO EXERCITO" parece defeito.
    const achados = [];
    for (const o of ORGAOS) {
        if (!termos.length) { achados.push({ org: o, unidades: [] }); continue; }
        const noOrgao = termos.every(t => o.busca.includes(t));
        const unidades = noOrgao ? [] : o.unidades.filter(u => termos.every(t => u.busca.includes(t)));
        if (noOrgao || unidades.length) achados.push({ org: o, unidades });
    }

    if (!achados.length) {
        lista.innerHTML = '<div class="orgao-vazio">Nenhum órgão ou unidade com esse nome.</div>';
        lista.classList.add('active');
        return;
    }
    lista.innerHTML = achados.map(({ org, unidades }) => {
        const extra = unidades.length
            ? `<br><small class="orgao-unidade">${unidades.slice(0, 3).map(u => escHtml(u.nome)).join(' · ')}${unidades.length > 3 ? ' …' : ''}</small>`
            : '';
        return `<div class="autocomplete-item" onclick="escolherOrgao(${JSON.stringify(org.nome).replace(/"/g, '&quot;')})">
            ${escHtml(org.nome)} <span class="orgao-qtd">(${org.qtd})</span>${extra}
        </div>`;
    }).join('');
    lista.classList.add('active');
}

function escolherOrgao(nome) {
    document.getElementById('filtroOrgao').value = nome;
    document.getElementById('filtroOrgaoBusca').value = nome;
    document.querySelector('.filtro-orgao').classList.add('escolhido');
    fecharListaOrgao();
    aplicarFiltro();
}

function limparOrgao() {
    document.getElementById('filtroOrgao').value = '';
    document.getElementById('filtroOrgaoBusca').value = '';
    document.querySelector('.filtro-orgao').classList.remove('escolhido');
    fecharListaOrgao();
    aplicarFiltro();
}

function fecharListaOrgao() {
    const lista = document.getElementById('filtroOrgaoLista');
    if (lista) lista.classList.remove('active');
}

// Clicar fora fecha. E se o campo ficou com texto que não é um órgão escolhido,
// ele volta ao escolhido (ou esvazia) — senão a tela mostraria um nome digitado
// pela metade enquanto o filtro vale outra coisa.
document.addEventListener('click', (e) => {
    // Menu "Abrir ↗" dos cards: clicar em qualquer lugar fora dele fecha.
    if (!e.target.closest('.dropdown')) fecharMenusAbrir();

    if (e.target.closest('.filtro-orgao')) return;
    fecharListaOrgao();
    const campo = document.getElementById('filtroOrgaoBusca');
    const valor = document.getElementById('filtroOrgao');
    if (campo && valor && campo.value !== valor.value) campo.value = valor.value;
});

function popularFiltrosDinamicos() {
    // Fase
    const selectFase = document.getElementById('filtroFase');
    if (selectFase) {
        const contagem = {};
        todasLicitacoes.forEach(l => {
            const f = faseDaLicitacao(l);
            contagem[f] = (contagem[f] || 0) + 1;
        });
        selectFase.innerHTML = '<option value="">Todas as fases</option>';
        Object.keys(FASE_ROTULOS).forEach(f => {
            if (!contagem[f]) return;
            selectFase.innerHTML += `<option value="${f}">${FASE_ROTULOS[f]} (${contagem[f]})</option>`;
        });
    }

    // Órgão — vira a fonte do autocomplete, em ordem alfabética. Antes era um
    // <select> ordenado por quantidade, e a cauda ficava impossível de usar:
    // 149 órgãos para 172 licitações, 140 deles com uma só, ou seja 140 opções
    // "(1)" em ordem arbitrária, com o nome cortado em 40 caracteres.
    //
    // A busca olha o nome do órgão E o da unidade compradora, porque são
    // coisas diferentes e o Comprasnet mostra a UNIDADE: das 81 licitações de
    // interesse com participação lá, 80 têm nome de órgão diferente do que o
    // Comprasnet exibe, e em 71 delas o nome do Comprasnet é o da unidade.
    // Sem isto, procurar por "COMISSÃO REGIONAL DE OBRAS DA 8º REG MILITAR"
    // (o que se lê no portal) nunca chegaria a "COMANDO DO EXERCITO", que é
    // como o PNCP nomeia o órgão. O agrupamento continua sendo por órgão.
    const orgaos = {};
    todasLicitacoes.forEach(l => {
        if (!l.nomeOrgao) return;
        if (!orgaos[l.nomeOrgao]) orgaos[l.nomeOrgao] = { qtd: 0, unidades: new Set() };
        orgaos[l.nomeOrgao].qtd++;
        if (l.nomeUnidade && l.nomeUnidade !== l.nomeOrgao) orgaos[l.nomeOrgao].unidades.add(l.nomeUnidade);
    });
    ORGAOS = Object.entries(orgaos)
        .map(([nome, d]) => ({
            nome,
            qtd: d.qtd,
            busca: normalizarBusca(nome),
            unidades: [...d.unidades].map(u => ({ nome: u, busca: normalizarBusca(u) })),
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    const buscaOrgao = document.getElementById('filtroOrgaoBusca');
    if (buscaOrgao) buscaOrgao.placeholder = `Todos os órgãos (${ORGAOS.length})`;

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
    const orgao = (document.getElementById('filtroOrgao') || {}).value || '';
    const grupo = (document.getElementById('filtroGrupo') || {}).value || '';
    const fase = (document.getElementById('filtroFase') || {}).value || '';

    // Fase e período recortam a MESMA data, e empilhá-los esconderia o
    // resultado: "Encerrada" com o período em "Em aberto" devolve zero card
    // enquanto o rótulo anuncia 104. Escolhida uma fase, ela manda, e o período
    // fica desabilitado para que a tela mostre de quem é a vez.
    const periodoEfetivo = fase ? 'todas' : periodo;
    const personalizado = periodoEfetivo === 'personalizado';
    document.getElementById('filtroPeriodo').disabled = !!fase;

    dataDe.style.display = personalizado ? '' : 'none';
    dataAte.style.display = personalizado ? '' : 'none';
    ateLabel.style.display = personalizado ? '' : 'none';

    const hoje = hojeStr();

    let filtradas = todasLicitacoes;

    // Filtro de data
    if (periodoEfetivo === 'ativas') {
        // Default: licitações com prazo em aberto (hoje ou futuro) ou sem data.
        // Não exclui licitações sem data — só remove explicitamente as vencidas.
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return !d || d >= hoje;
        });
    } else if (periodoEfetivo === 'hoje') {
        filtradas = filtradas.filter(l => dataStr(l.dataEncerramentoProposta) === hoje);
    } else if (periodoEfetivo === 'semana') {
        const fim = somarDias(hoje, 7);
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return d && d >= hoje && d <= fim;
        });
    } else if (periodoEfetivo === 'mes') {
        const fim = somarDias(hoje, 30);
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return d && d >= hoje && d <= fim;
        });
    } else if (periodoEfetivo === 'vencidas') {
        filtradas = filtradas.filter(l => {
            const d = dataStr(l.dataEncerramentoProposta);
            return d && d < hoje;
        });
    } else if (periodoEfetivo === 'personalizado') {
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

    // Filtro de fase
    if (fase) {
        filtradas = filtradas.filter(l => faseDaLicitacao(l) === fase);
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
    licitacoesFiltradas = filtradas;
    renderizarLicitacoes(filtradas);
    updateSelectionUI();

    const info = document.getElementById('filtroInfo');
    const temFiltro = periodo !== 'todas' || orgao || grupo || fase;
    if (!temFiltro) {
        info.textContent = '';
    } else {
        info.textContent = `Mostrando ${filtradas.length} de ${todasLicitacoes.length} licitações`;
    }
}

// ─── Seções do card ────────────────────────────────────────────────────────
// Mesma faixa da tela de busca (Detalhes / Arquivos / Quadro de avisos). O CSS
// mora no app-modern.css, compartilhado com a consulta. A lógica está aqui, e
// não no app.js, porque esta tela não carrega o app.js — e o objeto da
// licitação chega achatado (nomeOrgao, nomeUnidade) em vez de aninhado
// (orgaoEntidade.razaoSocial), que é como a busca o recebe do PNCP.

let PNCP_ARQUIVOS_TIMEOUT_MS = 20000;
let MENSAGENS_TIMEOUT_MS = 15000;

function escHtml(v) {
    return String(v == null ? '' : v)
        .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function licitacaoPorChave(licKey) {
    return todasLicitacoes.find(l => `${l.cnpj}-${l.ano}-${l.sequencial}` === licKey) || null;
}

// Campo sem valor não vira linha: melhor a linha não existir do que existir
// dizendo "N/A". Esfera e modo de disputa não entram porque o catálogo não
// guarda essas colunas — ver o SELECT de /api/interesse.
function montarDetalhesCard(lic) {
    const cidade = lic.municipioNome && lic.ufSigla ? `${lic.municipioNome}/${lic.ufSigla}` : '';
    const srp = lic.srp === true || lic.srp === 1 ? 'Sim'
              : (lic.srp === false || lic.srp === 0 ? 'Não' : '');
    const numero = lic.numeroCompra && lic.ano ? `${lic.numeroCompra}/${lic.ano}` : '';

    const linhas = [
        ['Órgão', lic.nomeOrgao],
        ['Unidade', lic.nomeUnidade],
        ['CNPJ', lic.cnpj ? formatarCNPJ(lic.cnpj) : ''],
        ['Cidade', cidade],
        ['Licitação', numero],
        ['UASG', lic.codigoUnidadeCompradora],
        ['Portal', nomeDoPortal(lic)],
        ['Modalidade', lic.modalidadeNome],
        ['Registro de preço', srp],
        ['Situação', lic.situacaoCompraNome],
        ['Publicação', formatarData(lic.dataPublicacaoPncp)],
        ['Abertura', formatarData(lic.dataAberturaProposta)],
        ['Fim das propostas', formatarData(lic.dataEncerramentoProposta)],
        ['Valor total estimado', lic.valorTotalLicitacao > 0 ? formatarValor(lic.valorTotalLicitacao) : ''],
        ['Grupo de palavras', lic.grupoNome],
        // Grupo sem palavra nos itens marcados é sinal de item marcado errado
        // (ex.: auto-interesse da IA com número de item trocado).
        ['Palavras-chave', !lic.palavrasChave ? ''
            : (lic.palavrasChave.length
                ? lic.palavrasChave.join(', ')
                : (lic.grupoNome ? 'nenhuma palavra do grupo nos itens marcados' : ''))],
    ].filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');

    return `<dl class="det-lista">${linhas.map(([r, v]) =>
        `<div><dt>${escHtml(r)}</dt><dd>${escHtml(v)}</dd></div>`).join('')}</dl>`;
}

// Em que portal a licitação acontece, pelo nome que se usa para falar dela.
//
// O PNCP registra em `usuarioNome` o PROVEDOR do sistema, que muitas vezes não
// é o nome do portal: a 27174093002090-2026-33, do MUNICIPIO DA SERRA, consta
// como "ECustomize Consultoria em Software S.A" e todo mundo a chama de Portal
// de Compras Públicas. Quando o link identifica o portal, ele vence; o provedor
// fica como resposta para os casos que o link não cobre — e são muitos, porque
// 59 das 184 licitações de interesse do 1bit não têm link nenhum.
const PORTAIS_CONHECIDOS = [
    [/portaldecompraspublicas\.com\.br/i, 'Portal de Compras Públicas'],
    [/bllcompras\.com|bll\.org/i,         'BLL Compras'],
    [/bnccompras\.com/i,                  'BNC — Bolsa Nacional de Compras'],
    [/comprasnet\.gov\.br|compras\.gov\.br|gov\.br\/compras|cnetmobile/i, 'Compras.gov.br'],
    [/licitanet\.com\.br/i,               'Licitanet'],
    [/licitardigital\.com\.br/i,          'Licitar Digital'],
    [/bbmnetlicitacoes\.com\.br|bbmnet/i, 'BBMNET'],
    [/licitacoes-e\.com\.br|licitacoes-e/i, 'Licitações-e (Banco do Brasil)'],
];

function nomeDoPortal(lic) {
    const link = String((lic && lic.linkSistemaOrigem) || '');
    if (link) {
        for (const [padrao, nome] of PORTAIS_CONHECIDOS) if (padrao.test(link)) return nome;
    }
    return (lic && lic.portalOrigem) || '';
}

function formatarCNPJ(cnpj) {
    const d = String(cnpj).replace(/\D/g, '');
    if (d.length !== 14) return String(cnpj);
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

// Abre uma seção por vez: duas abertas devolveriam o card gigante.
function alternarSecaoCard(botao, licKey, secao) {
    const painel = document.getElementById('painel-' + licKey);
    if (!painel) return;

    const jaAberta = painel.dataset.secao === secao && painel.classList.contains('aberto');
    botao.closest('.card').querySelectorAll('.card-secao-btn').forEach(b => b.classList.remove('ativo'));

    if (jaAberta) {
        painel.classList.remove('aberto');
        painel.innerHTML = '';
        painel.dataset.secao = '';
        return;
    }

    botao.classList.add('ativo');
    painel.classList.add('aberto');
    painel.dataset.secao = secao;

    const lic = licitacaoPorChave(licKey);
    if (!lic) { painel.innerHTML = '<div class="det-vazio">Dados desta licitação não estão mais em memória. Recarregue a página.</div>'; return; }

    if (secao === 'detalhes') {
        painel.innerHTML = montarDetalhesCard(lic);
    } else if (secao === 'proposta') {
        painel.innerHTML = '<div class="det-vazio">Carregando a proposta…</div>';
        carregarPropostaCard(licKey, painel);
    } else if (secao === 'arquivos') {
        painel.innerHTML = '<div class="det-vazio">Carregando arquivos…</div>';
        carregarArquivosCard(licKey, painel);
    } else if (secao === 'avisos') {
        painel.innerHTML = '<div class="det-vazio">Consultando o quadro…</div>';
        carregarAvisosCard(licKey, lic, painel);
    } else if (secao === 'mensagens') {
        painel.innerHTML = '<div class="det-vazio">Carregando mensagens…</div>';
        carregarMensagensCard(licKey, painel);
    } else if (secao === 'anexos') {
        painel.innerHTML = '<div class="det-vazio">Carregando anexos…</div>';
        abrirAnexosCard(licKey, lic, painel);
    } else if (secao === 'andamento') {
        painel.innerHTML = '<div class="det-vazio">Consultando o Comprasnet…</div>';
        carregarAndamentoCard(licKey, painel);
    }
}

// ─── Resultado da disputa ──────────────────────────────────────────────────
// Quem levou cada item e por quanto. Vem do PNCP, que publica o resultado
// mesmo quando a situação do edital continua "Divulgada no PNCP" — por isso o
// card pode mostrar resultado e situação aparentemente em desacordo.
//
// A fonte guarda TODOS os classificados, não só o vencedor: o servidor ordena
// por item e valor, então a primeira linha de cada item é a vencedora, e as
// demais aparecem recuadas como concorrência.
async function carregarAndamentoCard(licKey, painel) {
    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), MENSAGENS_TIMEOUT_MS);
    try {
        const r = await fetch('/api/interesse/andamento?pncp=' + encodeURIComponent(licKey), { signal: ctrl.signal });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        d.licKey = licKey;
        painel.innerHTML = montarAndamentoCard(d);
    } catch (e) {
        const motivo = e.name === 'AbortError' ? 'a consulta não respondeu a tempo' : e.message;
        painel.innerHTML = `<div class="det-vazio">Não foi possível carregar o andamento: ${escHtml(motivo)}.</div>`;
    } finally {
        clearTimeout(prazo);
    }
}

// O que enviamos, dentro da etapa Proposta — é o conteúdo que antes só existia
// no modal do botão "Proposta enviada", que saiu do topo do card.
async function carregarEnviosDaEtapa(licKey) {
    const box = document.getElementById('envios-' + licKey);
    if (!box) return;
    try {
        const r = await fetch('/api/interesse/historico-proposta?pncp=' + encodeURIComponent(licKey));
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        const envios = d.envios || [];
        if (!envios.length) {
            box.innerHTML = '<div class="det-vazio">Nenhum envio registrado aqui. Envios de BLL e BNC anteriores a 21/09/2026 não guardavam a licitação.</div>';
            return;
        }
        box.innerHTML = envios.map(e => {
            const quando = e.quando ? (formatarData(e.quando) || e.quando) : '';
            // Os itens chegam normalizados pela rota: cada portal grava de um
            // jeito e adivinhar aqui foi o que produzia "Item ?" sem valor.
            // `numeroEhPosicao` marca os portais que não guardam o número do
            // item do edital — dizer "Item 3" sem a ressalva sugeriria o item 3
            // do edital quando é o terceiro item da proposta.
            const itens = (e.itens || []).map(i => {
                const pos = i.numeroEhPosicao;
                const rotulo = pos ? `${i.numero}º da proposta` : `Item ${i.numero}`;
                const dica = pos
                    ? `O ${e.portal} identifica o item por código interno, e não pelo número do edital.`
                    + (i.referencia ? ` Lá ele é o ${i.referencia}.` : '')
                    : '';
                const valor = typeof i.valor === 'number' ? formatarValor(i.valor) : '—';
                const extra = [i.marca, i.modelo, i.fabricante].filter(Boolean).join(' · ');
                const cel = dica
                    ? `<span class="envio-item-pos" title="${escHtml(dica)}">${escHtml(rotulo)}</span>`
                    : escHtml(rotulo);
                return `<tr><td>${cel}</td>
                    <td>${escHtml(valor)}</td>
                    <td>${escHtml(extra)}</td></tr>`;
            }).join('');
            return `<div class="envio">
                <div class="envio-cab">
                    <strong>${escHtml(e.portal)}</strong>
                    <span class="envio-selo ${e.enviada ? 'ok' : 'previa'}">${e.enviada ? 'Enviada' : 'Prévia'}</span>
                    <span class="etapa-janela">${escHtml(quando)}</span>
                </div>
                ${e.resumo ? `<div class="etapa-janela">${escHtml(e.resumo)}</div>` : ''}
                ${itens ? `<table class="envio-itens"><tbody>${itens}</tbody></table>` : ''}
                ${e.comprovanteUrl ? `<a href="${escHtml(e.comprovanteUrl)}" target="_blank" rel="noopener" class="etapa-link">comprovante ↗</a>` : ''}
            </div>`;
        }).join('');
    } catch (e) {
        box.innerHTML = `<div class="det-vazio">Não foi possível listar os envios: ${escHtml(e.message)}.</div>`;
    }
}

const ETAPA_ROTULO = { concluida: 'concluída', 'em-curso': 'em curso', futura: 'a acontecer', indefinida: 'sem data' };
// As três caixas do fluxo de disputa do Comprasnet.
const FASE_DISPUTA = { A: 'aguardando disputa', D: 'em disputa', E: 'encerrada' };

// As duas tabelas que o portal mostra na etapa encerrada. Só chegam pela ponte
// do Electron: o endpoint exige token hCaptcha de uso único e, chamado do
// servidor, responde 204 vazio. Por isso a primeira abertura da aba costuma
// mostrar "aguardando coleta".
//
// O endpoint, medido em 25/09/2026 pela sessão do Electron, é
// /comprasnet-fase-externa/public/v1/compras/{compra}/itens/{n}/propostas — a
// MESMA família que o coletor de marcas já usava. As quatro sondagens anteriores
// falharam por procurá-lo em /comprasnet-disputa/v1, onde ele não mora.
//
// As "duas tabelas" saem de UM payload: cada fornecedor traz os dois valores.
//   propostasItem[].valores.valorPropostaInicial          → proposta inicial
//   propostasItem[].valores.valorPropostaInicialOuLances   → melhor valor dele
// Não existe `dataHora` nem `origem` no nível público: essa forma só existe em
// /comprasnet-disputa/v1/.../lances/por-participante, autenticado, que o
// escada-relay usa durante a disputa VIVA. Encerrada, o que o portal mostra é o
// par acima — e é por isso que aqui é uma tabela só, com as duas colunas.
function tabelasDaDisputa(det) {
    if (!det) return '';
    const titulo = '<div class="and-sub-titulo">Propostas e melhores valores</div>';
    if (det.status === 'pendente' || det.status === 'coletando') {
        return titulo + `<div class="det-vazio">Aguardando coleta pelo Electron — o portal só entrega
            esta tabela a um navegador logado. Reabra a aba em instantes.</div>`;
    }
    if (det.status === 'erro') {
        return titulo + `<div class="det-vazio">Não foi possível coletar: ${escHtml(det.erro || 'motivo não informado')}.</div>`;
    }

    const d = det.dados || {};
    const linhas = Array.isArray(d.propostasItem) ? d.propostasItem : [];
    if (!linhas.length) return '';

    // `valorCalculado.valorTotal` é o total; `valorInformado` é o unitário e vem
    // nulo em disputa por grupo. Preferir o total, que existe nos dois casos.
    const valorDe = (v) => {
        if (!v) return null;
        if (v.valorCalculado && v.valorCalculado.valorTotal != null) return v.valorCalculado.valorTotal;
        return v.valorInformado != null ? v.valorInformado : null;
    };
    const meu = String(det.meuCnpj || '').replace(/\D/g, '');

    const ordenadas = linhas.map(p => {
        const part = p.participante || {};
        const doc = String(part.identificacao || '').replace(/\D/g, '');
        return {
            nome: part.nome || part.razaoSocial || '(fornecedor não identificado)',
            uf: (part.endereco && part.endereco.uf) || '',
            nosso: !!meu && doc === meu,
            inicial: valorDe((p.valores || {}).valorPropostaInicial),
            melhor: valorDe((p.valores || {}).valorPropostaInicialOuLances),
            desclassificado: !!p.motivoDesclassificacao,
            motivo: p.motivoDesclassificacao || '',
            meEpp: p.declaracaoMeEpp === true,
        };
    }).sort((a, b) => {
        // Sem valor vai para o fim: desclassificado não disputa posição.
        if (a.melhor == null) return 1;
        if (b.melhor == null) return -1;
        return a.melhor - b.melhor;
    });

    const corpo = ordenadas.map((f, i) => `
        <tr class="${f.nosso ? 'disputa-nosso' : ''}${f.desclassificado ? ' disputa-fora' : ''}"
            ${f.motivo ? `title="${escHtml(f.motivo)}"` : ''}>
            <td class="disputa-pos">${f.melhor == null ? '—' : i + 1}</td>
            <td>${escHtml(f.nome)}${f.uf ? ` <span class="disputa-uf">${escHtml(f.uf)}</span>` : ''}${
                f.meEpp ? ' <span class="disputa-selo">ME/EPP</span>' : ''}${
                f.nosso ? ' <span class="disputa-selo nosso">nós</span>' : ''}</td>
            <td>${escHtml(f.inicial == null ? '—' : formatarValor(f.inicial))}</td>
            <td>${escHtml(f.melhor == null ? '—' : formatarValor(f.melhor))}</td>
        </tr>`).join('');

    return titulo + `<table class="disputa-tab">
        <thead><tr><th></th><th>Fornecedor</th><th>Proposta inicial</th><th>Melhor valor</th></tr></thead>
        <tbody>${corpo}</tbody></table>`;
}

// Detalhe da etapa Disputa: o fluxo do portal e os melhores valores.
//
// O que NÃO está aqui, e por quê: as listas de "propostas iniciais" e de
// "melhores valores por fornecedor" que o portal exibe. O endpoint delas não
// foi encontrado — /propostas dá 404 nesse nível, /lances dá 204 e
// /lances/melhores só aceita DELETE. O que aparece abaixo é o melhor valor da
// disputa e o nosso, que é o que a API entrega.
function detalheDisputa(d) {
    if (!d) return '';
    const partes = [];

    if (d.fluxo) {
        const caixas = [
            ['Aguardando', d.fluxo.aguardando], ['Em disputa', d.fluxo.emDisputa],
            ['Encerrados', d.fluxo.encerrados], ['Desertos', d.fluxo.desertos],
            ['Fracassados', d.fluxo.fracassados],
        ].filter(([, n]) => n > 0);
        if (caixas.length) {
            partes.push('<div class="disputa-fluxo">' + caixas.map(([r, n]) =>
                `<span class="disputa-caixa">${escHtml(r)} <strong>${n}</strong></span>`).join('') + '</div>');
        }
    }

    // Os três valores lado a lado, e não numa lista de rótulos: é a comparação
    // que decide se ganhamos, e ela tem de ser lida de relance.
    const venceu = d.melhorGeral != null && d.melhorNosso != null
        && Math.abs(d.melhorNosso - d.melhorGeral) < 0.005;
    const painel = (rot, val, classe) => (val == null ? '' :
        `<div class="disputa-valor ${classe || ''}">
            <span class="disputa-valor-rot">${escHtml(rot)}</span>
            <strong>${escHtml(formatarValor(val))}</strong>
        </div>`);

    if (d.valorEstimado != null || d.melhorGeral != null || d.melhorNosso != null) {
        partes.push('<div class="disputa-valores">'
            + painel('Estimado pelo órgão', d.valorEstimado)
            + painel('Melhor da disputa', d.melhorGeral, 'melhor')
            + painel('Nosso melhor', d.melhorNosso, venceu ? 'melhor nosso' : 'nosso')
            + '</div>');

        if (d.melhorGeral != null && d.melhorNosso != null) {
            const dif = d.melhorNosso - d.melhorGeral;
            partes.push(`<div class="disputa-veredito ${venceu ? 'ok' : 'nao'}">${
                venceu ? 'Nosso valor foi o melhor da disputa.'
                       : `Ficamos ${escHtml(formatarValor(Math.abs(dif)))} acima do melhor valor.`}</div>`);
        }
    }

    const notas = [];
    if (d.grupo) notas.push(`Disputado como <strong>${escHtml(d.grupo.rotulo)}</strong>, com ${d.grupo.itens} itens`);
    if (d.fase) notas.push(`Fase do item: <strong>${escHtml(FASE_DISPUTA[d.fase] || d.fase)}</strong>`);
    if (d.desclassificado === true) notas.push('<strong class="disputa-alerta">Consta como desclassificado</strong>');
    if (notas.length) partes.push('<div class="disputa-notas">' + notas.map(n => `<div>${n}</div>`).join('') + '</div>');

    return partes.join('');
}

// Guarda o andamento por licitação: as sub-abas trocam com o que já veio, sem
// nova ida ao portal (que custa ~250ms e é limitado por taxa).
const ANDAMENTO = {};

function montarAndamentoCard(d) {
    // A etapa Proposta saiu daqui em 25/09/2026: compor e enviar virou aba
    // própria do card, e deixar o mesmo nome nos dois lugares faria procurar no
    // lugar errado. O Andamento ficou com o que só o portal sabe — a disputa e
    // o julgamento. A janela de datas que esta etapa mostrava foi para o topo
    // da aba Proposta, tirada do PNCP, sem custo de chamada.
    const etapas = (d.etapas || []).filter(e => e.chave !== 'proposta');
    if (!etapas.length) {
        return `<div class="det-vazio">${escHtml(d.erroPortal
            ? 'Não foi possível consultar as etapas no Comprasnet: ' + d.erroPortal
            : 'Sem participação registrada no Comprasnet — as etapas vêm de lá.')}</div>`;
    }
    ANDAMENTO[d.licKey] = d;

    // Abre na etapa que está acontecendo; tudo concluído, abre na última.
    const emCurso = etapas.findIndex(e => e.estado === 'em-curso');
    const inicial = emCurso >= 0 ? etapas[emCurso].chave : etapas[etapas.length - 1].chave;

    const abas = etapas.map(e => `
        <button type="button" class="and-suba${e.chave === inicial ? ' ativa' : ''}" data-sub="${e.chave}"
            onclick="trocarSubAba('${d.licKey}', '${e.chave}', this)">
            <span class="and-ponto ${escHtml(e.estado)}"></span>${escHtml(e.rotulo)}
        </button>`).join('');

    return `<div class="and-subabas">${abas}</div>
        <div class="and-conteudo" id="and-${escHtml(d.licKey)}">${conteudoSubAba(d, inicial)}</div>`;
}

function trocarSubAba(licKey, chave, botao) {
    const d = ANDAMENTO[licKey];
    if (!d) return;
    botao.parentElement.querySelectorAll('.and-suba').forEach(b => b.classList.remove('ativa'));
    botao.classList.add('ativa');
    const box = document.getElementById('and-' + licKey);
    if (box) box.innerHTML = conteudoSubAba(d, chave);
}

function conteudoSubAba(d, chave) {
    const e = (d.etapas || []).find(x => x.chave === chave);
    if (!e) return '';

    const janela = [e.inicio, e.fim].filter(Boolean)
        .map(x => String(x).slice(0, 16).replace('T', ' ')).join('  →  ');

    const cab = `<div class="and-cab">
        <span class="and-estado ${escHtml(e.estado)}">${escHtml(ETAPA_ROTULO[e.estado] || e.estado)}</span>
        ${janela ? `<span class="and-janela">${escHtml(janela)}</span>` : ''}
        ${e.link ? `<a href="${escHtml(e.link)}" target="_blank" rel="noopener" class="etapa-link">abrir no Comprasnet ↗</a>` : ''}
    </div>`;

    if (chave === 'disputa') {
        return cab
            + (e.detalhe ? `<div class="and-linha-forte">${escHtml(e.detalhe)}</div>` : '')
            + detalheDisputa(e.disputa)
            + tabelasDaDisputa(d.detalheDisputa);
    }
    // julgamento
    const res = d.resultado || [];
    return cab
        + (e.detalhe ? `<div class="and-linha-forte">${escHtml(e.detalhe)}</div>` : '')
        + (res.length
            ? `<div class="and-sub-titulo">Resultado por item</div>` + montarResultadoCard({ itens: res })
            : '<div class="det-vazio">O PNCP ainda não publicou resultado para esta licitação.</div>');
}

function montarResultadoCard(d) {
    const itens = d.itens || [];
    if (!itens.length) return '<div class="det-vazio">O PNCP ainda não publicou resultado para esta licitação.</div>';

    const porItem = new Map();
    for (const l of itens) {
        if (!porItem.has(l.numeroItem)) porItem.set(l.numeroItem, []);
        porItem.get(l.numeroItem).push(l);
    }

    const linhas = [...porItem.entries()].map(([numero, lista]) => {
        const venc = lista[0];
        const outros = lista.slice(1);
        const doc = String(venc.niFornecedor || '').replace(/\D/g, '');
        const marca = [venc.marcaFabricante, venc.modeloVersao].filter(Boolean).join(' · ');
        return `<div class="res-item${venc.nosso ? ' nosso' : ''}">
            <div class="res-cab">
                <strong>Item ${escHtml(numero)}</strong>
                ${venc.nosso ? '<span class="res-selo">nós</span>' : ''}
                <span class="res-valor">${formatarValor(venc.valorTotalHomologado)}</span>
            </div>
            <div class="res-forn">${escHtml(venc.nomeRazaoSocialFornecedor || '(sem nome)')}
                ${doc ? `<span class="res-doc">${escHtml(doc)}</span>` : ''}</div>
            ${marca ? `<div class="res-marca">${escHtml(marca)}</div>` : ''}
            ${outros.length ? `<div class="res-outros">+ ${outros.length} outro(s) classificado(s): ${
                outros.map(o => escHtml(String(o.nomeRazaoSocialFornecedor || '').slice(0, 28))).join(' · ')}</div>` : ''}
        </div>`;
    }).join('');

    return `<div class="res-lista">${linhas}</div>
        <div class="msg-resto">Publicado pelo PNCP. Traz todos os classificados — o primeiro de cada item é quem venceu.</div>`;
}

// ─── Meus anexos ───────────────────────────────────────────────────────────
// Documentos que ANEXAMOS à nossa participação, por item — não confundir com a
// aba "Arquivos", que é o edital publicado pelo órgão no PNCP.
//
// O portal indexa anexo por ITEM (/compras/{c}/itens/{i}/participacao/{cnpj}/
// anexos), e a tela já sabe em quais itens temos interesse, então é por eles
// que a aba se organiza.
let DOCS_HABILITACAO = null;   // carregado uma vez por sessão da tela

// A rota é /api/interesse/documentos, e não /api/habilitacao: o RBAC é
// fail-closed por prefixo e `/api/habilitacao` não libera esta página — a
// chamada voltava 403 e o select dizia "nenhuma certidão com arquivo" mesmo
// com as cinco certidões no lugar. Liberar aquele prefixo daria à tela o POST e
// o DELETE de documento de brinde.
async function carregarDocsHabilitacao() {
    if (DOCS_HABILITACAO) return DOCS_HABILITACAO;
    try {
        const r = await fetch('/api/interesse/documentos');
        const d = await r.json();
        DOCS_HABILITACAO = d.documentos || [];
    } catch { DOCS_HABILITACAO = []; }
    return DOCS_HABILITACAO;
}

function opcoesDocs() {
    const docs = DOCS_HABILITACAO || [];
    if (!docs.length) return '<option value="">(nenhuma certidão com arquivo)</option>';
    return '<option value="">Escolha um documento…</option>' + docs.map(d =>
        `<option value="${d.id}">${escHtml(d.tipo)}${d.dataValidade ? ' — val. ' + escHtml(d.dataValidade) : ''}</option>`).join('');
}

function montarAnexosCard(lic, licKey) {
    const itens = lic.itens || [];
    // O item -1 é a licitação inteira, e é ONDE FICAM OS ANEXOS QUANDO A COMPRA
    // É AGRUPADA: o portal trata o grupo como uma unidade só. Descoberto em
    // 25/09/2026 na compra 93286506000062026 — 10 itens no Grupo 1, todos
    // respondendo lista vazia item a item, e os 13 anexos reais em -1. O -1
    // responde 200 em compra de qualquer tipo, então é sempre seguro consultar.
    const blocos = [{ numeroItem: -1, rotulo: 'Licitação inteira', descricao: 'Onde ficam os anexos quando a compra é por grupo' }]
        .concat(itens.map(i => ({ numeroItem: i.numeroItem, rotulo: 'Item ' + i.numeroItem, descricao: String(i.descricao || '').slice(0, 70) })));

    return blocos.map(i => `
        <div class="anexo-item">
            <div class="anexo-item-cab">
                <strong>${escHtml(i.rotulo)}</strong>
                <span class="anexo-item-desc">${escHtml(i.descricao)}</span>
            </div>
            <div class="anexo-lista" id="anx-${licKey}-${i.numeroItem}">
                <span class="det-vazio">Carregando…</span>
            </div>
            <div class="anexo-envio">
                <select id="anx-doc-${licKey}-${i.numeroItem}">${opcoesDocs()}</select>
                <button type="button" class="btn btn-primary btn-sm"
                    onclick="anexarDocumento('${licKey}', ${i.numeroItem})">Anexar</button>
                <span class="anexo-ou">ou</span>
                <input type="file" id="anx-arq-${licKey}-${i.numeroItem}"
                    accept="${EXT_ANEXO.map(e => '.' + e).join(',')}"
                    onchange="anexarArquivoLocal('${licKey}', ${i.numeroItem}, this)">
            </div>
        </div>`).join('');
}

// Um item por vez, e não todos de uma vez. O Comprasnet limita por taxa: numa
// licitação com 4 itens de interesse, disparar as 4 consultas em paralelo fez
// duas voltarem HTTP 429 (medido em 25/09/2026 na compra 93286506000062026).
// Em série elas passam, e a pausa curta dá folga a quem tem muitos itens.
// Carrega as certidões ANTES de montar: o select é montado junto do painel, e
// montá-lo com a lista ainda vazia o deixava preso em "(nenhuma certidão com
// arquivo)" para sempre — o remendo que tentava repreenchê-lo depois checava
// `!sel.options.length`, que nunca é verdade, porque a opção de aviso já conta.
async function abrirAnexosCard(licKey, lic, painel) {
    await carregarDocsHabilitacao();
    if (painel.dataset.secao !== 'anexos') return;   // trocou de aba enquanto carregava
    painel.innerHTML = montarAnexosCard(lic, licKey);
    carregarAnexosEmSerie(licKey, lic.itens);
}

async function carregarAnexosEmSerie(licKey, itens) {
    // -1 primeiro: em compra agrupada é o único nível que tem anexo.
    const alvos = [-1].concat((itens || []).map(i => i.numeroItem));
    for (const n of alvos) {
        await listarAnexosItem(licKey, n);
        await new Promise(r => setTimeout(r, 350));
    }
}

async function listarAnexosItem(licKey, numeroItem) {
    const box = document.getElementById(`anx-${licKey}-${numeroItem}`);
    if (!box) return;
    try {
        const r = await fetch(`/api/interesse/anexos?pncp=${encodeURIComponent(licKey)}&item=${numeroItem}`);
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) {
            // A rota devolve 200 com success=false quando o PORTAL recusou, e o
            // status dele vem em `d.status`. Sem isto a tela dizia "HTTP 200",
            // que é a resposta da nossa rota e não diz nada de útil.
            const cod = (d && d.status) || r.status;
            throw new Error((d && d.error) || (cod === 429
                ? 'o Comprasnet limitou as consultas (429). Tente de novo em instantes.'
                : 'o Comprasnet respondeu ' + cod));
        }
        if (!d.anexos.length) { box.innerHTML = '<span class="det-vazio">Nenhum anexo neste item.</span>'; return; }
        // O nome do arquivo não prova o conteúdo: o link baixa o que está de
        // fato no portal, que é o que permite conferir se subiu o certo.
        const url = (a) => `/api/interesse/anexos/arquivo?pncp=${encodeURIComponent(licKey)}`
            + `&item=${numeroItem}&nome=${encodeURIComponent(a.nome)}`;
        box.innerHTML = d.anexos.map(a => `
            <div class="anexo-linha">
                <span>📎 <a href="${url(a)}" target="_blank" rel="noopener"
                    title="Baixar do Comprasnet para conferir o conteúdo">${escHtml(a.nomeOriginal)}</a></span>
                <span class="anexo-quando">${escHtml(String(a.dataHora || '').replace('T', ' ').slice(0, 16))}</span>
                ${a.permitidoExcluir
                    ? `<button type="button" class="btn btn-ghost btn-sm" style="color:var(--danger);"
                         onclick="excluirAnexo('${licKey}', ${numeroItem}, '${encodeURIComponent(a.nome)}', ${JSON.stringify(a.nomeOriginal).replace(/"/g, '&quot;')})">Excluir</button>`
                    : '<span class="anexo-quando">—</span>'}
            </div>`).join('');
    } catch (e) {
        box.innerHTML = `<span class="det-vazio">Não foi possível listar: ${escHtml(e.message)}.</span>`;
    }
}

async function anexarDocumento(licKey, numeroItem) {
    const sel = document.getElementById(`anx-doc-${licKey}-${numeroItem}`);
    const documentoId = sel && sel.value;
    if (!documentoId) { if (sel) sel.focus(); return; }

    sel.disabled = true;
    const box = document.getElementById(`anx-${licKey}-${numeroItem}`);
    try {
        const r = await fetch('/api/interesse/anexos', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pncp: licKey, item: numeroItem, documentoId: Number(documentoId) }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        sel.value = '';
        await listarAnexosItem(licKey, numeroItem);
    } catch (e) {
        if (box) box.innerHTML = `<span class="anexo-erro">Não foi anexado: ${escHtml(e.message)}</span>`;
    } finally {
        sel.disabled = false;
    }
}

// ── Arquivo da máquina ─────────────────────────────────────────────────────
// As extensões são as mesmas do `TIPOS_ANEXO` de comprasnet-anexos-routes.js:
// o servidor recusa o que não estiver lá, e repetir a lista aqui é o que faz o
// seletor do sistema operacional já abrir filtrado.
const EXT_ANEXO = ['pdf', 'zip', 'rar', 'png', 'jpg', 'jpeg', 'doc', 'docx', 'xls', 'xlsx', 'txt'];

// O arquivo sobe em base64 dentro do JSON, e o body do Express para em 10 MB
// (base-middleware.js). O base64 infla 33%, então o teto real de arquivo é
// ~7,5 MB — arredondado para baixo, e conferido AQUI para o usuário ler o
// motivo em vez de receber um 413 sem texto.
const MAX_ANEXO_BYTES = 7 * 1024 * 1024;

function lerBase64(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('não foi possível ler o arquivo'));
        // O resultado vem como `data:<mime>;base64,<...>`; o servidor corta o
        // prefixo, e mandar o dataURL inteiro é o que evita fatiar string de
        // megabytes no navegador.
        fr.onload = () => resolve(String(fr.result));
        fr.readAsDataURL(file);
    });
}

async function anexarArquivoLocal(licKey, numeroItem, input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    const box = document.getElementById(`anx-${licKey}-${numeroItem}`);
    const erro = (txt) => { if (box) box.innerHTML = `<span class="anexo-erro">${escHtml(txt)}</span>`; input.value = ''; };

    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!EXT_ANEXO.includes(ext)) {
        return erro(`".${ext}" não é aceito. Envie ${EXT_ANEXO.join(', ')}.`);
    }
    if (file.size > MAX_ANEXO_BYTES) {
        return erro(`O arquivo tem ${(file.size / 1048576).toFixed(1)} MB e o limite é 7 MB.`);
    }

    input.disabled = true;
    if (box) box.innerHTML = `<span class="det-vazio">Enviando ${escHtml(file.name)}…</span>`;
    try {
        const r = await fetch('/api/interesse/anexos', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pncp: licKey, item: numeroItem,
                pdfBase64: await lerBase64(file), nomeArquivo: file.name,
            }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        input.value = '';
        await listarAnexosItem(licKey, numeroItem);
    } catch (e) {
        erro('Não foi anexado: ' + e.message);
    } finally {
        input.disabled = false;
    }
}

async function excluirAnexo(licKey, numeroItem, nomeEnc, nomeOriginal) {
    const onde = Number(numeroItem) === -1 ? 'da licitação' : `do item ${numeroItem}`;
    if (!await Aviso.confirmar(`Excluir o anexo "${nomeOriginal}" ${onde}?`)) return;
    const box = document.getElementById(`anx-${licKey}-${numeroItem}`);
    try {
        const r = await fetch('/api/interesse/anexos', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pncp: licKey, item: numeroItem, nome: decodeURIComponent(nomeEnc) }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        await listarAnexosItem(licKey, numeroItem);
    } catch (e) {
        if (box) box.innerHTML = `<span class="anexo-erro">Não foi excluído: ${escHtml(e.message)}</span>`;
    }
}

// Mensagens do Comprasnet desta licitação, capturadas pelo monitor. Sob demanda
// como os arquivos: são 722 mensagens em 39 licitações no 1bit, e uma delas
// sozinha tem 161 — trazer tudo junto da lista pesaria sem ninguém pedir.
//
// A rota é /api/interesse/mensagens, e não /api/chat/mensagens: o RBAC é
// fail-closed por prefixo e /api/chat pertence à página do monitor.
async function carregarMensagensCard(licKey, painel) {
    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), MENSAGENS_TIMEOUT_MS);
    try {
        const r = await fetch('/api/interesse/mensagens?pncp=' + encodeURIComponent(licKey) + '&limit=50',
            { signal: ctrl.signal });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        painel.innerHTML = montarMensagensCard(d, licKey);
    } catch (e) {
        const motivo = e.name === 'AbortError' ? 'a consulta não respondeu a tempo' : e.message;
        painel.innerHTML = `<div class="det-vazio">Não foi possível carregar as mensagens: ${escHtml(motivo)}.</div>`;
    } finally {
        clearTimeout(prazo);
    }
}

function montarMensagensCard(d, licKey) {
    const lista = d.mensagens || [];
    if (!lista.length) return '<div class="det-vazio">Nenhuma mensagem capturada para esta licitação.</div>';

    const corpo = lista.map(m => {
        const quando = formatarData(m.dataHoraMensagem || m.dataCaptura) || '';
        const alvos = [];
        if (m.palavrasChaveEncontradas) {
            String(m.palavrasChaveEncontradas).split(',').map(p => p.trim()).filter(Boolean)
                .forEach(p => alvos.push(`<span class="msg-tag alerta">${escHtml(p)}</span>`));
        }
        if (m.temCnpjFornecedor) alvos.push('<span class="msg-tag meu">Meu CNPJ</span>');
        if (m.identificadorItem) alvos.push(`<span class="msg-tag">Item ${escHtml(m.identificadorItem)}</span>`);

        return `<div class="msg-item${m.minha ? ' minha' : ''}">
            <div class="msg-cab">
                <strong>${escHtml(m.titulo || m.remetente || 'Mensagem')}</strong>
                <span class="msg-quando">${escHtml(quando)}</span>
            </div>
            <div class="msg-texto">${escHtml(m.mensagem || '')}</div>
            ${alvos.length ? `<div class="msg-tags">${alvos.join('')}</div>` : ''}
        </div>`;
    }).join('');

    // O teto é do servidor (50 por vez): dizer quantas ficaram de fora evita
    // que a lista pareça completa quando não está.
    const resto = (d.total || lista.length) - lista.length;
    const rodape = resto > 0
        ? `<div class="msg-resto">Mostrando as ${lista.length} mais recentes de ${d.total}. As demais estão no Monitor Comprasnet.</div>`
        : '';
    return `<div class="msg-lista">${corpo}</div>${rodape}${formResposta(licKey)}`;
}

// Responder no chat do pregão, como no Monitor Comprasnet. O texto sai PÚBLICO
// no processo e o portal não tem rota de exclusão — por isso a confirmação
// nomeia o alvo (item ou compra inteira) e repete o que será publicado.
function formResposta(licKey) {
    return `
    <div class="msg-responder">
        <textarea id="resp-txt-${licKey}" rows="2" placeholder="Responder no chat do pregão…"></textarea>
        <div class="msg-responder-linha">
            <input type="text" id="resp-item-${licKey}" placeholder="Item (opcional)" inputmode="numeric">
            <span class="msg-aviso">Sai público no processo e não pode ser apagado.</span>
            <button type="button" class="btn btn-primary btn-sm" id="resp-btn-${licKey}"
                onclick="enviarResposta('${licKey}')">Enviar</button>
        </div>
        <div class="msg-retorno" id="resp-msg-${licKey}"></div>
    </div>`;
}

async function enviarResposta(licKey) {
    const ta = document.getElementById('resp-txt-' + licKey);
    const inpItem = document.getElementById('resp-item-' + licKey);
    const btn = document.getElementById('resp-btn-' + licKey);
    const retorno = document.getElementById('resp-msg-' + licKey);
    const texto = (ta && ta.value || '').trim();
    if (!texto) { if (ta) ta.focus(); return; }

    const item = inpItem && inpItem.value.trim() ? inpItem.value.trim() : null;
    const alvo = item ? `o item ${item}` : 'a compra toda';
    if (!await Aviso.confirmar(`Enviar esta mensagem no chat do pregão (${alvo})?\n\n"${texto}"\n\nEla fica pública no processo e não pode ser apagada.`)) return;

    btn.disabled = true;
    const rotulo = btn.textContent;
    btn.textContent = 'Enviando…';
    retorno.textContent = '';
    retorno.className = 'msg-retorno';
    try {
        const r = await fetch('/api/interesse/mensagens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pncp: licKey, texto, item }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.success) throw new Error((d && d.error) || ('HTTP ' + r.status));
        ta.value = '';
        if (inpItem) inpItem.value = '';
        retorno.textContent = 'Mensagem enviada.';
        retorno.className = 'msg-retorno ok';
        // Não recarrega a aba aqui: o que sai não volta pela caixa de entrada do
        // portal (medido em 03/08/2026 — os endpoints de leitura devolvem 204),
        // então recarregar só apagaria esta confirmação sem trazer nada. A
        // enviada aparece na lista pelo registro local, na próxima abertura.
    } catch (e) {
        retorno.textContent = 'Não foi enviada: ' + e.message;
        retorno.className = 'msg-retorno erro';
    } finally {
        btn.disabled = false;
        btn.textContent = rotulo;
    }
}

// Anexos direto do PNCP: a API é pública e libera CORS, então não passa por
// rota nossa. O prazo evita que o PNCP fora do ar deixe "Carregando…" para
// sempre — é `let` para o teste poder encurtá-lo.
async function carregarArquivosCard(licKey, painel) {
    const lic = licitacaoPorChave(licKey);
    if (!lic || !lic.cnpj || !lic.ano || !lic.sequencial) {
        painel.innerHTML = '<div class="det-vazio">Licitação sem identificação no PNCP.</div>';
        return;
    }

    const ctrl = new AbortController();
    const prazo = setTimeout(() => ctrl.abort(), PNCP_ARQUIVOS_TIMEOUT_MS);
    try {
        const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${lic.cnpj}/compras/${lic.ano}/${lic.sequencial}/arquivos`;
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const lista = await r.json();

        if (!Array.isArray(lista) || lista.length === 0) {
            painel.innerHTML = '<div class="det-vazio">Nenhum arquivo publicado no PNCP para esta licitação.</div>';
            return;
        }
        painel.innerHTML = '<ul class="arq-lista">' + lista.map(a => {
            const nome = a.titulo || a.nomeArquivo || 'Documento';
            const quando = a.dataPublicacaoPncp ? formatarData(a.dataPublicacaoPncp) : '';
            return `<li>
                <a href="${escHtml(a.url || a.uri)}" target="_blank" rel="noopener">${escHtml(nome)}</a>
                ${quando ? `<span class="arq-data">${escHtml(quando)}</span>` : ''}
            </li>`;
        }).join('') + '</ul>';
    } catch (e) {
        const motivo = e.name === 'AbortError' ? 'o PNCP não respondeu a tempo' : e.message;
        painel.innerHTML = `<div class="det-vazio">Não foi possível carregar os arquivos: ${escHtml(motivo)}.</div>`;
    } finally {
        clearTimeout(prazo);
    }
}

// O PNCP não publica avisos, impugnações nem esclarecimentos por API: os três
// endpoints respondem 404. Esse conteúdo mora no portal de origem, e a seção
// leva para lá em vez de mentir que não há aviso. O caminho pelo Comprasnet
// existe mas exige token de hCaptcha por consulta — ver o comentário longo em
// app.js:402, que guarda a medição de 21/09/2026 para não se refazer.
// Quadro informativo do Comprasnet: avisos, impugnações e esclarecimentos.
//
// O PNCP não publica nada disso por API. O Comprasnet publica, atrás de um
// hCaptcha invisível de uso único — daí a coleta passar pela mesma ponte do
// Electron que traz as propostas da disputa. Abrir a aba ENFILEIRA; a primeira
// abertura costuma mostrar "aguardando", e a seguinte já traz.
//
// Fora do Comprasnet não há o que coletar, e a aba continua mandando ao portal
// de origem — que é o texto que existia aqui desde sempre.
async function carregarAvisosCard(licKey, lic, painel) {
    try {
        const r = await fetch('/api/interesse/quadro?pncp=' + encodeURIComponent(licKey));
        const d = await r.json().catch(() => null);
        if (!d || !d.success || !d.coleta) { painel.innerHTML = montarAvisosCard(lic); return; }
        painel.innerHTML = montarQuadroCard(d.coleta, lic);
    } catch (e) {
        painel.innerHTML = montarAvisosCard(lic);
    }
}

const QUADRO_SECOES = [
    ['avisos', 'Avisos'],
    ['impugnacoes', 'Impugnações'],
    ['esclarecimentos', 'Esclarecimentos'],
];

function montarQuadroCard(coleta, lic) {
    if (coleta.status === 'pendente' || coleta.status === 'coletando') {
        return `<div class="det-vazio">Aguardando coleta pelo Electron — o Comprasnet só entrega o
            quadro a um navegador que resolva o captcha. Reabra a aba em instantes.</div>`;
    }
    if (coleta.status === 'erro') {
        return `<div class="det-vazio">Não foi possível coletar o quadro: ${escHtml(coleta.erro || 'motivo não informado')}.</div>`
            + montarAvisosCard(lic);
    }

    const d = coleta.dados || {};
    const partes = [];
    let total = 0;

    for (const [chave, rotulo] of QUADRO_SECOES) {
        // Formato MEDIDO na primeira coleta real, em 26/09/2026:
        //   { tipo: 'A', quantidade: 2, permitirInclusao: false, informativos: [...] }
        // A lista é `informativos`. Antes disto a leitura procurava `resultado`,
        // que não existe — as seções vinham com quantidade 2 e apareciam vazias.
        const bruto = d[chave];
        const lista = Array.isArray(bruto) ? bruto
                    : (bruto && Array.isArray(bruto.informativos) ? bruto.informativos : []);
        if (!lista.length) continue;
        total += lista.length;

        partes.push(`<div class="and-sub-titulo">${escHtml(rotulo)} (${lista.length})</div>`
            + lista.map(x => montarQuadroItem(x)).join(''));
    }

    if (!total) {
        return `<div class="det-vazio">O Comprasnet não registrou aviso, impugnação nem
            esclarecimento para esta licitação${coleta.coletadoEm
                ? ' (conferido em ' + escHtml(formatarData(coleta.coletadoEm) || coleta.coletadoEm) + ')' : ''}.</div>`;
    }
    return partes.join('');
}

// Os campos, medidos na primeira coleta real em 26/09/2026:
//   aviso/impugnação  { tipo, dataHoraInclusao, mensagem }
//   esclarecimento    { tipo, dataHoraInclusao, mensagem, resposta }
//
// `tipo` é o código da seção (A de aviso, E de esclarecimento), e NÃO um
// título — mostrá-lo daria uma linha escrita "A".
//
// No esclarecimento, `mensagem` é a PERGUNTA de quem questionou e `resposta` é
// o que o órgão respondeu. Juntar as duas num campo só faria parecer que o
// órgão escreveu a pergunta.
function montarQuadroItem(x) {
    const quando = x.dataHoraInclusao || x.dataHora || '';
    const pergunta = x.mensagem || '';
    const resposta = x.resposta || '';

    return `<div class="envio">
        <div class="envio-cab">
            <span class="etapa-janela">${escHtml(String(quando).slice(0, 16).replace('T', ' '))}</span>
        </div>
        ${pergunta ? `<div class="quadro-texto">${escHtml(pergunta)}</div>` : ''}
        ${resposta ? `<div class="quadro-resposta"><strong>Resposta do órgão</strong>
            <div class="quadro-texto">${escHtml(resposta)}</div></div>` : ''}
    </div>`;
}

function montarAvisosCard(lic) {
    const link = lic.linkSistemaOrigem;
    const destino = link ? (String(link).startsWith('http') ? link : 'https://' + link) : '';
    const itens = ['Avisos', 'Impugnações', 'Esclarecimentos'].map(t => `<li>${t}</li>`).join('');

    return `
        <div class="det-vazio">
            O PNCP não publica avisos, impugnações e esclarecimentos por API.
            <ul class="avisos-lista">${itens}</ul>
            ${destino
                ? `<a href="${escHtml(destino)}" target="_blank" rel="noopener" class="card-secao-link">Abrir o portal de origem ↗</a>`
                : 'Esta licitação não informou portal de origem.'}
        </div>`;
}

function formatarData(dataStr) {
    if (!dataStr) return null;
    const d = new Date(dataStr);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Os dois destinos externos num botão só. Havendo os dois, vira menu (o
// `.dropdown` do app-modern.css); havendo só o PNCP, continua link direto —
// menu de uma opção só custa um clique e não oferece escolha nenhuma.
//
// O site de origem é opcional: o órgão nem sempre informa, e quando informa o
// link pode ser da home do portal em vez do processo — daí o aviso no title.
function botaoAbrir(licKey, linkPncp, linkOrigem) {
    if (!linkOrigem) {
        return `<a href="${linkPncp}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm"
                   style="text-decoration:none;white-space:nowrap;"
                   title="Abrir o edital no Portal Nacional de Contratações Públicas">Ver no PNCP ↗</a>`;
    }
    return `<span class="dropdown" id="abrir-${licKey}">
        <button type="button" class="btn btn-ghost btn-sm" style="white-space:nowrap;"
            onclick="alternarMenuAbrir(event, '${licKey}')"
            title="Abrir o edital — no PNCP ou no portal de origem">Abrir ↗</button>
        <div class="dropdown-menu">
            <a href="${linkPncp}" target="_blank" rel="noopener"
               title="Portal Nacional de Contratações Públicas">Ver no PNCP ↗</a>
            <a href="${linkOrigem}" target="_blank" rel="noopener"
               title="Link informado pelo órgão (pode ser genérico)">Site de origem ↗</a>
        </div>
    </span>`;
}

function alternarMenuAbrir(ev, licKey) {
    ev.stopPropagation();   // senão o listener de fora fecha no mesmo clique
    const d = document.getElementById('abrir-' + licKey);
    if (!d) return;
    const jaAberto = d.classList.contains('open');
    fecharMenusAbrir();
    if (!jaAberto) d.classList.add('open');
}

function fecharMenusAbrir() {
    document.querySelectorAll('#interessesContainer .dropdown.open')
        .forEach(x => x.classList.remove('open'));
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

        // Botão de proposta só faz sentido com prazo em aberto e portal integrado.
        const dEnc = dataStr(licitacao.dataEncerramentoProposta);
        const prazoAberto = !dEnc || dEnc >= hojeStr();
        const alvoProposta = prazoAberto ? resolverPortalProposta(licitacao) : null;

        // Um botão só: enviar quando ainda não há proposta, listar quando já há.
        // O sinal é o kanbanStatus, e não o histórico de envios, porque o
        // histórico só enxerga o que gravou a chave PNCP — os envios de BLL e
        // BNC anteriores a 21/09/2026 ficaram sem ela, e decidir por eles faria
        // licitação já enviada exibir "Enviar proposta". Medido no 1bit em
        // 25/09/2026: 37 licitações com kanban 'enviada' contra 3 rastreáveis
        // pelo histórico, e as 3 estão dentro das 37.
        const propostaEnviada = licitacao.kanbanStatus === 'enviada';
        // O badge "✓ Proposta enviada" que ficava sob o título saiu: dizia o
        // mesmo que este botão, que ainda por cima é acionável. A data que só o
        // badge mostrava veio para o title daqui, para não se perder.
        const quandoEnviada = formatarData(licitacao.kanbanDataAtualizacao);

        // Comprasnet deixou de sair da tela: compor e enviar virou a aba
        // Proposta deste card, e o botão só a abre. BNC, BLL e PCP continuam
        // indo para as telas próprias do módulo Portais, que não foram movidas.
        // Aqui o botão aparece mesmo com proposta já enviada — é por ele que se
        // reenvia, e era isso que o modal antigo oferecia.
        const abaLocal = alvoProposta && alvoProposta.label === 'Comprasnet';
        const botaoProposta = abaLocal
            ? `<button type="button" class="btn btn-success btn-sm" style="white-space:nowrap;"
                   onclick="abrirAbaProposta('${licKey}')"
                   title="${propostaEnviada && quandoEnviada
                       ? `Proposta enviada em ${quandoEnviada} — abrir para ver ou reenviar`
                       : 'Compor valores e enviar a proposta'}">📝 ${propostaEnviada ? 'Proposta enviada' : 'Enviar proposta'}</button>`
            : (propostaEnviada || !alvoProposta
                ? ''
                : `<a href="${alvoProposta.url}" class="btn btn-success btn-sm" style="text-decoration:none;white-space:nowrap;" title="Enviar proposta pelo portal ${alvoProposta.label}">📝 Enviar proposta ${alvoProposta.label}</a>`);

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
                  </div>
                </div>
                <div style="display:flex;gap:8px;flex:none;">
                  ${botaoProposta}
                  ${botaoAnaliseIaHtml(licitacao)}
                  ${botaoAbrir(licKey, linkPncp, linkOrigem)}
                </div>
            </div>

            <div class="card-secoes">
                <button type="button" class="card-secao-btn ativo" data-sec="detalhes"
                    onclick="alternarSecaoCard(this, '${licKey}', 'detalhes')">Detalhes</button>
                <button type="button" class="card-secao-btn" data-sec="proposta"
                    onclick="alternarSecaoCard(this, '${licKey}', 'proposta')"
                    title="Compor valores, gerar o orçamento e enviar a proposta">Proposta</button>
                <button type="button" class="card-secao-btn" data-sec="arquivos"
                    onclick="alternarSecaoCard(this, '${licKey}', 'arquivos')">Arquivos</button>
                <button type="button" class="card-secao-btn" data-sec="avisos"
                    onclick="alternarSecaoCard(this, '${licKey}', 'avisos')">Quadro de avisos</button>
                ${licitacao.qtdMensagens > 0 ? `
                <button type="button" class="card-secao-btn com-contador" data-sec="mensagens"
                    onclick="alternarSecaoCard(this, '${licKey}', 'mensagens')"
                    title="Mensagens do Comprasnet capturadas para esta licitação">Mensagens <span class="secao-contador">${licitacao.qtdMensagens}</span></button>` : ''}
                ${licitacao.compraId ? `
                <button type="button" class="card-secao-btn" data-sec="anexos"
                    onclick="alternarSecaoCard(this, '${licKey}', 'anexos')"
                    title="Documentos que anexamos à nossa participação no Comprasnet">Meus anexos</button>` : ''}
                ${(licitacao.compraId || licitacao.qtdResultado > 0) ? `
                <button type="button" class="card-secao-btn" data-sec="andamento"
                    onclick="alternarSecaoCard(this, '${licKey}', 'andamento')"
                    title="Em que etapa a licitação está e quem levou cada item">Andamento</button>` : ''}
            </div>
            <!-- Detalhes já vem montado e aberto: é a seção que se lê em toda
                 triagem, e deixá-la fechada custava um clique por licitação. -->
            <div class="card-painel aberto" id="painel-${licKey}" data-secao="detalhes">${montarDetalhesCard(licitacao)}</div>

            <!-- Sanfona fechada: as descrições de item são longas (a do item 1
                 tem 300+ caracteres) e empurravam o resto do card para fora da
                 tela. O resumo continua visível no cabeçalho clicável. -->
            <details class="itens-sanfona">
              <summary>
                <span class="itens-resumo">Itens de interesse (${licitacao.itens.length}) ·
                  <span style="color:var(--success);">${formatarValor(valorLicitacao)}</span>
                  ${badgeEncerramento(licitacao.dataEncerramentoProposta)}
                </span>
              </summary>
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
            </details>
        `;
        interessesContainer.appendChild(card);
    });
}

async function removerInteresse(id) {
    if (!await Aviso.confirmar('Deseja remover este item de interesse?')) return;

    try {
        const response = await fetch('/api/interesse/' + id, { method: 'DELETE' });
        if (response.ok) {
            carregarInteresses();
        } else {
            Aviso.erro('Erro ao remover interesse');
        }
    } catch (error) {
        console.error('Erro:', error);
        Aviso.erro('Erro ao remover interesse');
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
