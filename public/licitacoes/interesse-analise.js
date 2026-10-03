// Análise IA sob demanda na tela de Interesses.
//
// A rota já existia (`POST /api/licitacoes/:cnpj/:ano/:sequencial/analisar`);
// o que faltava era poder chamá-la daqui, sem passar pela tela de Consulta.
// O resultado NÃO é renderizado aqui: ao terminar, o botão "Análise IA" que já
// existe no card leva à tela de Análises, que sabe desenhá-lo.
//
// Três coisas que o código abaixo trata e não são detalhe:
//
//   1. CADA CLIQUE É UMA CHAMADA PAGA. A análise baixa até 5 documentos do PNCP
//      e manda o texto para o provider. Por isso o lote confirma antes, pula
//      quem já tem análise e pode ser parado no meio.
//   2. O LOTE É SEQUENCIAL, de propósito. O `analise-ia.js` documenta que o WAF
//      do PNCP trava downloads simultâneos do mesmo IP — paralelizar aqui
//      derrubaria o download lá dentro.
//   3. O RBAC é fail-closed por PREFIXO, e `/api/licitacoes` não lista a página
//      'interesse'. Perfil restrito tomaria 403; então o botão só aparece para
//      quem a chamada de fato atenderia. Ver iaCarregarPermissao().
//
// Depende de `interesse.js` (globais `todasLicitacoes`, `licitacoesFiltradas`,
// `selectedIds`) e de `relEsc()`, o escape de HTML do `interesse-relatorio.js`.

// As páginas que hoje liberam o prefixo /api/licitacoes no perfis-api-map.js.
// Se o mapa mudar, esta lista precisa acompanhar — é cópia, não leitura.
const IA_PAGINAS_DO_PREFIXO = ['comprasnet-monitor', 'consulta', 'propostas-api', 'relatorio-participacoes'];

// Uma análise baixa 5 PDFs em sequência e ainda espera o provider. 4 minutos é
// folgado para o caso normal e curto o bastante para não virar espera eterna:
// sem prazo, um fetch preso deixaria o botão girando para sempre.
// É `let` para o teste automatizado poder encurtá-lo — esperar 4 minutos para
// provar a guarda faria o teste ser abandonado, que é como guarda morre.
let IA_TIMEOUT_MS = 240000;

let iaPodeAnalisar = false;
let iaLoteRodando = false;
let iaLotePararPedido = false;
let iaAbortAtual = null;

// Decide se os botões aparecem. Sem permissão eles não são desenhados: mostrar
// um botão que só devolve 403 é pior do que não mostrar botão nenhum.
function iaCarregarPermissao() {
    return fetch('/api/perfis/meu-acesso')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
            if (!d || !d.success) { iaPodeAnalisar = false; return false; }
            const paginas = Array.isArray(d.paginas) ? d.paginas : [];
            iaPodeAnalisar = d.irrestrito === true ||
                IA_PAGINAS_DO_PREFIXO.some(p => paginas.includes(p));
            return iaPodeAnalisar;
        })
        .catch(() => { iaPodeAnalisar = false; return false; });
}

// UM botão por licitação, não dois. Já analisada, ele leva ao resultado; ainda
// não analisada, ele roda a análise. São ações que nunca fazem sentido ao mesmo
// tempo, e oferecer as duas obrigava o usuário a saber qual valia.
//
// O terceiro caso é o que sustenta o desenho: `temAnalise` só vem depois que o
// processo do servidor recarrega a rota `/api/interesse`. Enquanto não vier, o
// campo é `undefined` e NÃO se sabe se há análise — aí vale o link, que é o
// comportamento antigo. Só o 0/false explícito libera o botão de gastar uma
// chamada paga: na dúvida, nunca gastar.
function botaoAnaliseIaHtml(lic) {
    const pncp = `${lic.cnpj}-${lic.ano}-${lic.sequencial}`;
    const semAnalise = lic.temAnalise === 0 || lic.temAnalise === false;

    if (semAnalise && iaPodeAnalisar) {
        return `<button class="btn btn-ghost btn-sm btn-ia" data-lic-key="${pncp}"
            onclick="analisarIa('${pncp}', this)"
            title="Esta licitação ainda não tem análise. Rodar agora — baixa o edital e consome uma chamada paga">🤖 Analisar IA</button>`;
    }

    const titulo = semAnalise
        ? 'Abrir a tela de Análises nesta licitação (ela ainda não foi analisada)'
        : 'Ver a análise IA desta licitação';
    return `<a href="/operacional/analises-ia.html?pncp=${pncp}" class="btn btn-ghost btn-sm btn-ia-link"
        data-lic-key="${pncp}" style="text-decoration:none;white-space:nowrap;"
        title="${titulo}">Análise IA</a>`;
}

// Depois de analisar, o botão vira o link: a ação que fazia sentido mudou.
function iaTrocarBotaoPorLink(lic, el) {
    lic.temAnalise = 1;
    if (el && el.outerHTML !== undefined) el.outerHTML = botaoAnaliseIaHtml(lic);
}

function iaLicitacaoPorChave(licKey) {
    return todasLicitacoes.find(l => `${l.cnpj}-${l.ano}-${l.sequencial}` === licKey) || null;
}

// fetch com prazo. Devolve sempre {ok, dados, erro} — quem chama nunca precisa
// distinguir exceção de resposta ruim.
async function iaFetch(url, opcoes) {
    const ctrl = new AbortController();
    iaAbortAtual = ctrl;
    const prazo = setTimeout(() => ctrl.abort(), IA_TIMEOUT_MS);
    try {
        const r = await fetch(url, { ...opcoes, signal: ctrl.signal });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d || d.success === false) {
            return { ok: false, erro: (d && d.error) || `HTTP ${r.status}` };
        }
        return { ok: true, dados: d };
    } catch (e) {
        return { ok: false, erro: e.name === 'AbortError' ? 'tempo esgotado (4 min)' : e.message };
    } finally {
        clearTimeout(prazo);
        iaAbortAtual = null;
    }
}

function iaJaTemAnalise(lic) {
    return iaFetch(`/api/licitacoes/${lic.cnpj}/${lic.ano}/${lic.sequencial}/analise`, { method: 'GET' })
        .then(r => r.ok && !!(r.dados && r.dados.analise));
}

function iaAnalisar(lic) {
    return iaFetch(`/api/licitacoes/${lic.cnpj}/${lic.ano}/${lic.sequencial}/analisar`, { method: 'POST' });
}

// ===== Faixa de estado =====
// Fica no topo da lista e diz o que está acontecendo. É o único retorno visual
// de uma operação que pode levar minutos.
function iaFaixa(html, tipo) {
    let faixa = document.getElementById('iaFaixa');
    if (!faixa) {
        faixa = document.createElement('div');
        faixa.id = 'iaFaixa';
        const container = document.getElementById('interessesContainer');
        container.parentNode.insertBefore(faixa, container);
    }
    const cor = tipo === 'erro' ? 'danger' : (tipo === 'ok' ? 'success' : 'accent');
    faixa.style.cssText = `background:var(--${cor}-soft);color:var(--${cor});border:1px solid var(--${cor});` +
        'border-radius:var(--r-md);padding:10px 14px;margin-bottom:12px;font-size:0.9em;' +
        'display:flex;align-items:center;gap:12px;justify-content:space-between;';
    faixa.innerHTML = html;
}

function iaLimparFaixa() {
    const faixa = document.getElementById('iaFaixa');
    if (faixa) faixa.remove();
}

// ===== Uma licitação =====

async function analisarIa(licKey, btn) {
    const lic = iaLicitacaoPorChave(licKey);
    if (!lic) return;
    if (iaLoteRodando) {
        Aviso.erro('Há uma análise em lote rodando. Espere terminar ou clique em Parar.');
        return;
    }

    const rotuloOriginal = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Analisando…'; }
    iaFaixa(`<span>Analisando <strong>${lic.numeroCompra || lic.sequencial}/${lic.ano}</strong> — baixando o edital e consultando a IA. Pode levar alguns minutos.</span>`);

    const r = await iaAnalisar(lic);

    if (r.ok) {
        iaTrocarBotaoPorLink(lic, btn);
        iaFaixa('<span>Análise concluída. O botão do card virou <strong>Análise IA</strong> e abre o resultado.</span>' +
                '<button class="btn btn-ghost btn-sm" onclick="iaLimparFaixa()">Fechar</button>', 'ok');
    } else {
        if (btn) { btn.disabled = false; btn.innerHTML = rotuloOriginal; }
        iaFaixa(`<span>Não foi possível analisar: ${relEsc(r.erro)}</span>` +
                '<button class="btn btn-ghost btn-sm" onclick="iaLimparFaixa()">Fechar</button>', 'erro');
    }
}

// ===== Lote =====

// Escopo: o que estiver marcado nas caixinhas; sem marcação, o que o filtro
// deixou na tela. Mesma lógica de leitura que o usuário já usa para excluir.
function iaLicitacoesDoLote() {
    const filtradas = Array.isArray(licitacoesFiltradas) ? licitacoesFiltradas : [];
    if (selectedIds.size === 0) return filtradas;
    return filtradas.filter(l => l.itens.some(it => selectedIds.has(it.id)));
}

function iaPararLote() {
    iaLotePararPedido = true;
    if (iaAbortAtual) iaAbortAtual.abort();
}

async function analisarIaLote() {
    if (iaLoteRodando) return;
    const lista = iaLicitacoesDoLote();
    if (lista.length === 0) {
        Aviso.erro('Nenhuma licitação no filtro atual para analisar.');
        return;
    }

    const escopo = selectedIds.size > 0 ? 'selecionada(s)' : 'do filtro atual';
    // Quantas de fato vão gastar chamada. Só dá para dizer se o servidor já
    // manda `temAnalise`; sem isso, o número honesto é "até N".
    const sabidas = lista.filter(l => l.temAnalise === 0 || l.temAnalise === 1 ||
                                      l.temAnalise === false || l.temAnalise === true).length;
    const aAnalisar = lista.filter(l => l.temAnalise === 0 || l.temAnalise === false).length;
    const quantas = sabidas === lista.length
        ? `${aAnalisar} de ${lista.length} licitação(ões) ${escopo} ainda não têm análise`
        : `até ${lista.length} licitação(ões) ${escopo}`;

    if (sabidas === lista.length && aAnalisar === 0) {
        Aviso.erro('Todas as licitações deste recorte já têm análise. Para refazer uma delas, use o botão do card.');
        return;
    }

    const ok = await Aviso.confirmar(
        `Analisar ${quantas}?\n\n` +
        'Cada uma baixa o edital e consome uma chamada paga de IA. ' +
        'As que já têm análise são puladas.\n\n' +
        'Roda uma de cada vez e pode ser interrompida no meio.'
    );
    if (!ok) return;

    iaLoteRodando = true;
    iaLotePararPedido = false;
    let analisadas = 0, puladas = 0, falhas = 0, parouEm = 0;
    const errosVistos = [];

    for (let i = 0; i < lista.length; i++) {
        if (iaLotePararPedido) { parouEm = i; break; }
        const lic = lista[i];
        const nome = `${lic.numeroCompra || lic.sequencial}/${lic.ano}`;
        iaFaixa(
            `<span>Analisando <strong>${i + 1} de ${lista.length}</strong> — ${relEsc(nome)} ` +
            `<small>(${analisadas} concluídas, ${puladas} puladas, ${falhas} com erro)</small></span>` +
            '<button class="btn btn-danger btn-sm" onclick="iaPararLote()">Parar</button>'
        );

        if (await iaJaTemAnalise(lic)) { puladas++; continue; }
        if (iaLotePararPedido) { parouEm = i; break; }

        const r = await iaAnalisar(lic);
        if (r.ok) {
            analisadas++;
            iaTrocarBotaoPorLink(lic,
                document.querySelector(`.btn-ia[data-lic-key="${lic.cnpj}-${lic.ano}-${lic.sequencial}"]`));
        } else if (iaLotePararPedido) {
            // O abort veio do botão Parar, não é falha da análise.
            parouEm = i;
            break;
        } else {
            falhas++;
            if (errosVistos.length < 3) errosVistos.push(`${nome}: ${r.erro}`);
        }
    }

    iaLoteRodando = false;
    const partes = [
        `<strong>${analisadas}</strong> analisada(s)`,
        `${puladas} já tinha(m) análise`,
        `${falhas} com erro`
    ];
    if (iaLotePararPedido) partes.push(`<strong>interrompido</strong> em ${parouEm} de ${lista.length}`);
    const detalhe = errosVistos.length
        ? `<br><small>${relEsc(errosVistos.join(' · '))}</small>`
        : '';
    iaFaixa(
        `<span>${partes.join(' · ')}${detalhe}</span>` +
        '<button class="btn btn-ghost btn-sm" onclick="iaLimparFaixa()">Fechar</button>',
        falhas > 0 ? 'erro' : 'ok'
    );
}

// Mostra ou esconde o botão de lote conforme a permissão resolvida.
function iaAplicarPermissaoNaBarra() {
    const btn = document.getElementById('btnAnalisarLote');
    if (btn) btn.style.display = iaPodeAnalisar ? '' : 'none';
}
