// Relatório da tela de Interesses — CSV, PDF e impressão.
//
// O recorte é sempre `licitacoesFiltradas`, o mesmo array que o `aplicarFiltro`
// acabou de renderizar: o relatório sai igual ao que está na tela, inclusive na
// ordenação escolhida.
//
// As colunas, as linhas e os totais são montados UMA vez, em `relMontar`, e os
// três formatos consomem o mesmo resultado. É de propósito: CSV e PDF do mesmo
// filtro que divergissem no valor total seriam um defeito impossível de notar
// olhando só um dos dois.
//
// Depende de `interesse.js` (globais `licitacoesFiltradas`, `formatarValor`,
// `formatarData`, `dataStr`, `hojeStr`), carregado antes deste arquivo.

// tipo: 'texto' manda o valor cru; 'num' e 'moeda' são formatados por destino
// e por idioma (Excel pt quer 1234,56; en quer 1234.56; a folha impressa quer
// o valor com moeda). larguraPdf é em milímetros — a soma tem de caber nos
// 281mm úteis do A4 deitado, senão o autotable espreme a última coluna.
//
// A coluna guarda `id`, não título: o título depende do idioma e mora em
// REL_TEXTOS. Assim largura e tipo têm uma fonte só, e traduzir não pode
// dessincronizar a tabela.
const REL_COLUNAS = {
    resumo: [
        { id: 'orgao',        tipo: 'texto', larguraPdf: 42 },
        { id: 'uasg',         tipo: 'texto', larguraPdf: 14 },
        { id: 'licitacao',    tipo: 'texto', larguraPdf: 20 },
        { id: 'objeto',       tipo: 'texto', larguraPdf: 70 },
        { id: 'grupo',        tipo: 'texto', larguraPdf: 22 },
        { id: 'abertura',     tipo: 'texto', larguraPdf: 24 },
        { id: 'encerramento', tipo: 'texto', larguraPdf: 24 },
        { id: 'situacao',     tipo: 'texto', larguraPdf: 22 },
        { id: 'itens',        tipo: 'num',   larguraPdf: 11 },
        { id: 'valorTotal',   tipo: 'moeda', larguraPdf: 26 }
    ],
    detalhado: [
        { id: 'orgao',        tipo: 'texto', larguraPdf: 34 },
        { id: 'uasg',         tipo: 'texto', larguraPdf: 13 },
        { id: 'licitacao',    tipo: 'texto', larguraPdf: 19 },
        { id: 'encerramento', tipo: 'texto', larguraPdf: 22 },
        { id: 'objeto',       tipo: 'texto', larguraPdf: 52 },
        { id: 'item',         tipo: 'texto', larguraPdf: 11 },
        { id: 'descricao',    tipo: 'texto', larguraPdf: 62 },
        { id: 'qtd',          tipo: 'num',   larguraPdf: 14 },
        { id: 'valorUnit',    tipo: 'moeda', larguraPdf: 23 },
        { id: 'valorTotal',   tipo: 'moeda', larguraPdf: 25 }
    ]
};

// Tudo que muda de idioma. Os DADOS não entram aqui: nome de órgão, objeto e
// descrição de item são texto oficial do PNCP e saem em português nos dois
// relatórios — traduzir nome próprio de ente público seria inventá-lo.
//
// A interface (modal, avisos) também fica de fora: ela é sempre em português.
// O que o seletor troca é o idioma do DOCUMENTO.
const REL_TEXTOS = {
    pt: {
        titulo: { resumo: 'Interesses — resumo por licitação', detalhado: 'Interesses — detalhado por item' },
        arquivo: { resumo: 'interesses-resumo', detalhado: 'interesses-detalhado' },
        colunas: {
            orgao: 'Órgão', uasg: 'UASG', licitacao: 'Licitação', objeto: 'Objeto',
            grupo: 'Grupo', abertura: 'Abertura', encerramento: 'Encerramento',
            situacao: 'Situação', itens: 'Itens', item: 'Item', descricao: 'Descrição',
            qtd: 'Qtd', valorUnit: 'Valor unit.', valorTotal: 'Valor total'
        },
        semData: 'Não informada',
        situacao: {
            semPrazo: 'Sem prazo', encerrado: 'Prazo encerrado', hoje: 'Hoje',
            faltam: (n) => 'Faltam ' + n + ' dia' + (n > 1 ? 's' : '')
        },
        filtro: {
            prazo: 'Prazo', periodo: 'Período', ate: 'até', inicio: 'início', fim: 'fim',
            orgao: 'Órgão', grupo: 'Grupo', semGrupo: 'sem grupo', ordem: 'Ordem'
        },
        totais: (t) => relPlural(t.licitacoes, 'licitação', 'licitações') + ' · ' +
                       relPlural(t.itens, 'item', 'itens') + ' · Total estimado ' +
                       relValor(t.valor, 'pt'),
        geradoEm: 'Gerado em',
        pagina: 'Página',
        csvSeparador: ';'
    },
    en: {
        titulo: { resumo: 'Tender interests — summary by tender', detalhado: 'Tender interests — detailed by item' },
        arquivo: { resumo: 'tender-interests-summary', detalhado: 'tender-interests-detailed' },
        colunas: {
            orgao: 'Agency', uasg: 'UASG', licitacao: 'Tender no.', objeto: 'Subject',
            grupo: 'Keyword group', abertura: 'Opening', encerramento: 'Deadline',
            situacao: 'Status', itens: 'Items', item: 'Item', descricao: 'Description',
            qtd: 'Qty', valorUnit: 'Unit price', valorTotal: 'Total value'
        },
        semData: 'Not informed',
        situacao: {
            semPrazo: 'No deadline', encerrado: 'Closed', hoje: 'Today',
            faltam: (n) => 'Closes in ' + n + ' day' + (n > 1 ? 's' : '')
        },
        filtro: {
            prazo: 'Deadline', periodo: 'Period', ate: 'to', inicio: 'start', fim: 'end',
            orgao: 'Agency', grupo: 'Keyword group', semGrupo: 'no group', ordem: 'Sort'
        },
        totais: (t) => relPlural(t.licitacoes, 'tender', 'tenders') + ' · ' +
                       relPlural(t.itens, 'item', 'items') + ' · Estimated total ' +
                       relValor(t.valor, 'en'),
        geradoEm: 'Generated on',
        pagina: 'Page',
        // Vírgula, e não ';': em en-US o decimal é ponto, então a vírgula volta
        // a ser separador de coluna — é assim que o Excel em inglês abre certo.
        csvSeparador: ','
    }
};

// Os filtros da tela são <select> em português. Em pt o cabeçalho copia o texto
// da opção (fica fiel ao que está na tela); em en não há de onde copiar, então
// o mapa é por `value`. Opção nova sem entrada aqui cai no texto português —
// degrada para legível, nunca para vazio.
const REL_FILTRO_EN = {
    periodo: {
        ativas: 'Open', todas: 'All deadlines', hoje: 'Today', semana: 'Next 7 days',
        mes: 'Next 30 days', vencidas: 'Closed', personalizado: 'Custom range'
    },
    ordem: {
        'encerramento-asc': 'Deadline, earliest first',
        'encerramento-desc': 'Deadline, latest first',
        'valor-desc': 'Highest value',
        'valor-asc': 'Lowest value',
        'orgao-asc': 'Agency A-Z',
        'recente': 'Most recently added'
    }
};

let relEmpresaCache = null;   // nome do tenant, buscado uma vez por sessão da tela

function relIdiomaValido(idioma) {
    return idioma === 'en' ? 'en' : 'pt';
}

function relT(idioma) {
    return REL_TEXTOS[relIdiomaValido(idioma)];
}

function relValorItem(item) {
    return (parseFloat(item.valorUnitarioEstimado) || 0) * (parseFloat(item.quantidade) || 1);
}

function relDataBr(iso) {
    const s = dataStr(iso);
    return s ? s.substring(8, 10) + '/' + s.substring(5, 7) + '/' + s.substring(0, 4) : '';
}

// Moeda: em en o código BRL vem por extenso em vez do "R$". Num documento que
// atravessa fronteira, "R$ 1,234.56" é ambíguo (há mais de um "$"); "BRL" não.
function relValor(n, idioma) {
    const v = Number(n) || 0;
    if (relIdiomaValido(idioma) === 'en') {
        return new Intl.NumberFormat('en-US', {
            style: 'currency', currency: 'BRL', currencyDisplay: 'code'
        }).format(v);
    }
    return formatarValor(v);
}

// Data e hora do MESMO instante nos dois idiomas. O 'sv-SE' é o atalho conhecido
// para o formato ISO (2026-09-25 14:30) — e, por passar pelo mesmo mecanismo de
// fuso que o `formatarData` da tela, garante que trocar o idioma do relatório
// não desloque a hora. Ler a string ISO por substring, aqui, faria justamente
// isso quando o valor viesse com 'Z'.
// Carimbo de "gerado em": o instante de agora, no formato do idioma do
// documento.
function relCarimboData(idioma) {
    return relDataHora(new Date().toISOString(), idioma);
}

function relDataHora(iso, idioma) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    if (relIdiomaValido(idioma) === 'en') {
        return d.toLocaleString('sv-SE', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit'
        });
    }
    return formatarData(iso);
}

// Mesma leitura do badge da tela, em texto puro: o relatório impresso precisa
// dizer o prazo sem depender de cor nem de HTML.
function relSituacao(dataIso, idioma) {
    const s = relT(idioma).situacao;
    const d = dataStr(dataIso);
    if (!d) return s.semPrazo;
    const hoje = hojeStr();
    if (d < hoje) return s.encerrado;
    if (d === hoje) {
        const hora = dataIso.length >= 16 ? dataIso.substring(11, 16) : '';
        return hora ? s.hoje + ' ' + hora : s.hoje;
    }
    const dias = Math.round((new Date(d + 'T12:00:00') - new Date(hoje + 'T12:00:00')) / 86400000);
    return s.faltam(dias);
}

// Descreve o filtro em vigor para o cabeçalho do relatório. Sem isso, uma folha
// impressa com 12 de 300 licitações não diz por que são só essas 12.
function relDescricaoFiltro(idioma) {
    const lang = relIdiomaValido(idioma);
    const t = relT(lang).filtro;
    const textoOpcao = (id) => {
        const e = document.getElementById(id);
        const o = e && e.options[e.selectedIndex];
        return o ? o.textContent.trim() : '';
    };
    // Em en o rótulo vem do mapa por value; sem entrada, cai no texto da tela.
    const rotulo = (id, mapa) => {
        const e = document.getElementById(id);
        const v = e ? e.value : '';
        return (lang === 'en' && mapa[v]) || textoOpcao(id);
    };
    const partes = [];

    const periodo = document.getElementById('filtroPeriodo');
    if (periodo && periodo.value === 'personalizado') {
        const de = (document.getElementById('filtroDataDe') || {}).value;
        const ate = (document.getElementById('filtroDataAte') || {}).value;
        // As datas do filtro são YYYY-MM-DD puro: em en ficam como estão (já é
        // ISO), em pt viram dd/mm/aaaa.
        const fmt = (s) => (lang === 'en' ? s : relDataBr(s));
        partes.push(t.periodo + ': ' + (de ? fmt(de) : t.inicio) + ' ' + t.ate + ' ' + (ate ? fmt(ate) : t.fim));
    } else {
        partes.push(t.prazo + ': ' + rotulo('filtroPeriodo', REL_FILTRO_EN.periodo));
    }

    // Órgão e grupo vêm do .value, não do texto da opção: o texto é truncado em
    // 40 caracteres e carrega a contagem entre parênteses. E o valor é o nome
    // real do órgão — dado, não rótulo, então não se traduz.
    const orgao = document.getElementById('filtroOrgao');
    if (orgao && orgao.value) partes.push(t.orgao + ': ' + orgao.value);

    const grupo = document.getElementById('filtroGrupo');
    if (grupo && grupo.value) {
        partes.push(t.grupo + ': ' + (grupo.value === 'SEM_GRUPO' ? t.semGrupo : grupo.value));
    }

    partes.push(t.ordem + ': ' + rotulo('ordenacao', REL_FILTRO_EN.ordem));
    return partes.join('  ·  ');
}

function relMontar(nivel, idioma) {
    const lang = relIdiomaValido(idioma);
    const t = relT(lang);
    const licitacoes = Array.isArray(licitacoesFiltradas) ? licitacoesFiltradas : [];
    const colunas = REL_COLUNAS[nivel].map(c => ({ ...c, titulo: t.colunas[c.id] }));
    const linhas = [];
    let totalItens = 0;
    let totalValor = 0;

    licitacoes.forEach(l => {
        const numero = (l.numeroCompra || l.sequencial) + '/' + l.ano;
        const valorLic = l.itens.reduce((s, i) => s + relValorItem(i), 0);
        totalItens += l.itens.length;
        totalValor += valorLic;

        if (nivel === 'detalhado') {
            l.itens.forEach(i => linhas.push([
                l.nomeOrgao || '',
                l.codigoUnidadeCompradora || '',
                numero,
                relDataHora(l.dataEncerramentoProposta, lang) || t.semData,
                l.objetoCompra || '',
                String(i.numeroItem),
                i.descricao || '',
                parseFloat(i.quantidade) || 1,
                parseFloat(i.valorUnitarioEstimado) || 0,
                relValorItem(i)
            ]));
        } else {
            linhas.push([
                l.nomeOrgao || '',
                l.codigoUnidadeCompradora || '',
                numero,
                l.objetoCompra || '',
                l.grupoNome || '',
                relDataHora(l.dataAberturaProposta, lang) || t.semData,
                relDataHora(l.dataEncerramentoProposta, lang) || t.semData,
                relSituacao(l.dataEncerramentoProposta, lang),
                l.itens.length,
                valorLic
            ]);
        }
    });

    return {
        nivel: nivel,
        idioma: lang,
        titulo: t.titulo[nivel],
        arquivo: t.arquivo[nivel] + '-' + hojeStr(),
        colunas: colunas,
        linhas: linhas,
        filtro: relDescricaoFiltro(lang),
        totais: { licitacoes: licitacoes.length, itens: totalItens, valor: totalValor }
    };
}

function relCelula(valor, tipo, destino, idioma) {
    const lang = relIdiomaValido(idioma);
    if (tipo === 'moeda') {
        const n = Number(valor) || 0;
        // No CSV vai o número puro, sem moeda: o decimal segue o idioma porque
        // é ele que decide se a planilha lê 1234,56 ou 1234.56 como número.
        if (destino !== 'csv') return relValor(n, lang);
        return lang === 'en' ? n.toFixed(2) : n.toFixed(2).replace('.', ',');
    }
    if (tipo === 'num') {
        const n = Number(valor) || 0;
        if (destino !== 'csv') return n.toLocaleString(lang === 'en' ? 'en-US' : 'pt-BR');
        return lang === 'en' ? String(n) : String(n).replace('.', ',');
    }
    return valor == null ? '' : String(valor);
}

function relPlural(n, singular, plural) {
    return n + ' ' + (n === 1 ? singular : plural);
}

function relResumoTotais(totais, idioma) {
    return relT(idioma).totais(totais);
}

// Os caracteres que o WinAnsi tem ACIMA do latin-1 — a faixa 0x80-0x9F, que
// inclui o travessão do próprio título e as aspas curvas que vêm do PNCP.
// Sem esta lista, um filtro por ÿ sozinho os comeria.
const REL_PDF_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹Œ' +
                       'Ž‘’“”•–—˜™š' +
                       '›œžŸ';
const REL_PDF_FORA = new RegExp('[^\\u0000-\\u00ff' + REL_PDF_EXTRAS + ']', 'g');

// A fonte padrão do jsPDF é WinAnsi: o que estiver fora dela sai como lixo
// silencioso no papel (o "↑" da ordenação virava !'). Os sinais que o sistema
// realmente usa viram texto; qualquer outro caractere de fora vira espaço, que
// é feio mas legível — ao contrário do lixo, que parece erro de dado.
function relPdfTexto(s) {
    return String(s == null ? '' : s)
        .replace(/↑/g, '(cresc.)')
        .replace(/↓/g, '(decr.)')
        .replace(REL_PDF_FORA, ' ');
}

function relEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Nome do tenant para o cabeçalho. Se a rota falhar, o relatório sai sem a
// linha da empresa — inventar um nome num documento que vai ser enviado a
// terceiro é pior do que não ter nenhum.
function relCarregarEmpresa() {
    if (relEmpresaCache !== null) return Promise.resolve(relEmpresaCache);
    return fetch('/api/tenant-atual')
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
            const t = d && d.success && d.tenant;
            relEmpresaCache = t && t.nome ? String(t.nome) : '';
            return relEmpresaCache;
        })
        .catch(() => {
            relEmpresaCache = '';
            return '';
        });
}

// ===== Modal =====

function relNivelEscolhido() {
    const marcado = document.querySelector('input[name="relNivel"]:checked');
    return marcado && marcado.value === 'detalhado' ? 'detalhado' : 'resumo';
}

function relIdiomaEscolhido() {
    const marcado = document.querySelector('input[name="relIdioma"]:checked');
    return relIdiomaValido(marcado && marcado.value);
}

// Mostra o que o relatório vai conter ANTES de gerar: é a confirmação de que o
// escopo é o da tela, e não "tudo". O texto é sempre em português — quem lê é
// quem opera o sistema; o idioma escolhido vale para o arquivo.
function relAtualizarEscopo() {
    const info = document.getElementById('relEscopoInfo');
    if (!info) return;
    const rel = relMontar(relNivelEscolhido(), 'pt');
    info.textContent = rel.totais.licitacoes === 0
        ? 'Nenhuma licitação no filtro atual — ajuste os filtros da tela antes de gerar.'
        : `Vai sair: ${relResumoTotais(rel.totais, 'pt')} · ${relPlural(rel.linhas.length, 'linha', 'linhas')}`;
}

function relAbrirModal() {
    relAtualizarEscopo();
    document.getElementById('modalRelatorio').classList.add('open');
    relCarregarEmpresa();   // adianta a busca enquanto o usuário escolhe o nível
}

function relFecharModal() {
    document.getElementById('modalRelatorio').classList.remove('open');
}

// Guarda comum aos três formatos: gerar arquivo vazio é pior que não gerar,
// porque só se descobre ao abrir.
function relPreparar() {
    const rel = relMontar(relNivelEscolhido(), relIdiomaEscolhido());
    if (rel.linhas.length === 0) {
        Aviso.erro('Nada para gerar — o filtro atual não tem nenhuma licitação.');
        return null;
    }
    return rel;
}

// ===== CSV =====

// O separador entra na conta do que precisa de aspas: em en o campo com vírgula
// é que quebraria a coluna, e não o com ponto-e-vírgula.
function relCsvCampo(s, separador) {
    const v = String(s == null ? '' : s);
    return (v.indexOf(separador) >= 0 || /["\n\r]/.test(v))
        ? '"' + v.replace(/"/g, '""') + '"'
        : v;
}

function relBaixarCSV() {
    const rel = relPreparar();
    if (!rel) return;

    const sep = relT(rel.idioma).csvSeparador;
    const linhas = [rel.colunas.map(c => relCsvCampo(c.titulo, sep)).join(sep)];
    rel.linhas.forEach(l => {
        linhas.push(l.map((v, idx) =>
            relCsvCampo(relCelula(v, rel.colunas[idx].tipo, 'csv', rel.idioma), sep)).join(sep));
    });

    // BOM: sem ele o Excel lê o arquivo como latin-1 e os acentos viram lixo.
    const csv = '\ufeff' + linhas.join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = rel.arquivo + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    relFecharModal();
}

// ===== PDF =====

function relGerarPDF() {
    const rel = relPreparar();
    if (!rel) return;

    const jspdf = window.jspdf;
    if (!jspdf || !jspdf.jsPDF) {
        Aviso.erro('A biblioteca de PDF não carregou (ela vem de CDN e precisa de internet).\n\nUse "Baixar CSV" ou "Imprimir" — a impressão do navegador também salva em PDF.');
        return;
    }

    // O return devolve a promessa para quem quiser esperar o arquivo sair —
    // o onclick ignora, o teste automatizado usa.
    return relCarregarEmpresa().then(empresa => {
        const doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        if (typeof doc.autoTable !== 'function') {
            Aviso.erro('O plugin de tabelas do PDF não carregou. Use "Baixar CSV" ou "Imprimir".');
            return;
        }

        const larguras = {};
        rel.colunas.forEach((c, i) => { larguras[i] = { cellWidth: c.larguraPdf }; });
        rel.colunas.forEach((c, i) => {
            if (c.tipo !== 'texto') larguras[i].halign = 'right';
        });

        const t = relT(rel.idioma);
        const cabecalho = [];
        if (empresa) cabecalho.push(empresa);
        cabecalho.push(rel.filtro);
        cabecalho.push(relResumoTotais(rel.totais, rel.idioma));
        cabecalho.push(t.geradoEm + ' ' + relCarimboData(rel.idioma));
        const cabecalhoPdf = cabecalho.map(relPdfTexto);

        doc.autoTable({
            head: [rel.colunas.map(c => relPdfTexto(c.titulo))],
            body: rel.linhas.map(l => l.map((v, i) => relPdfTexto(relCelula(v, rel.colunas[i].tipo, 'pdf', rel.idioma)))),
            startY: 14 + cabecalho.length * 4.5,
            margin: { top: 14 + cabecalho.length * 4.5, left: 8, right: 8, bottom: 12 },
            styles: { fontSize: 6.5, cellPadding: 1.4, overflow: 'linebreak', valign: 'top' },
            headStyles: { fillColor: [40, 52, 71], fontSize: 6.5, halign: 'left' },
            alternateRowStyles: { fillColor: [244, 246, 249] },
            columnStyles: larguras,
            didDrawPage: () => {
                doc.setFontSize(12);
                doc.text(relPdfTexto(rel.titulo), 8, 11);
                doc.setFontSize(7.5);
                cabecalhoPdf.forEach((linha, i) => doc.text(linha, 8, 16.5 + i * 4.5));

                const pag = doc.internal.getNumberOfPages();
                const alt = doc.internal.pageSize.getHeight();
                const larg = doc.internal.pageSize.getWidth();
                doc.setFontSize(7);
                doc.text(relPdfTexto(t.pagina) + ' ' + pag, larg - 8, alt - 6, { align: 'right' });
            }
        });

        doc.save(rel.arquivo + '.pdf');
        relFecharModal();
    });
}

// ===== Impressão =====

function relImprimir() {
    const rel = relPreparar();
    if (!rel) return;

    return relCarregarEmpresa().then(empresa => {
        // Janela própria em vez de window.print() daqui: a tela roda dentro do
        // iframe do shell, e imprimi-la levaria sidebar, botões e checkboxes
        // para o papel.
        const janela = window.open('', '_blank');
        if (!janela) {
            Aviso.erro('O navegador bloqueou a janela de impressão. Libere os pop-ups deste site e tente de novo — ou use "Gerar PDF".');
            return;
        }

        const corpo = rel.linhas.map(l => '<tr>' + l.map((v, i) => {
            const c = rel.colunas[i];
            const alinha = c.tipo === 'texto' ? '' : ' class="num"';
            return `<td${alinha}>${relEsc(relCelula(v, c.tipo, 'print', rel.idioma))}</td>`;
        }).join('') + '</tr>').join('');

        janela.document.write(`<!DOCTYPE html>
<html lang="${rel.idioma === 'en' ? 'en' : 'pt-BR'}"><head><meta charset="UTF-8"><title>${relEsc(rel.titulo)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 15px; margin: 0 0 6px; }
  .meta { font-size: 9px; color: #444; line-height: 1.5; margin-bottom: 10px; }
  .meta strong { color: #111; }
  table { width: 100%; border-collapse: collapse; font-size: 8px; }
  thead { display: table-header-group; }
  th { background: #283447; color: #fff; text-align: left; padding: 4px 5px; font-weight: 600; }
  td { padding: 3px 5px; border-bottom: 1px solid #dcdfe4; vertical-align: top; }
  td.num { text-align: right; white-space: nowrap; }
  tbody tr:nth-child(even) { background: #f4f6f9; }
  tr { page-break-inside: avoid; }
</style></head>
<body onload="window.print()">
  <h1>${relEsc(rel.titulo)}</h1>
  <div class="meta">
    ${empresa ? '<div><strong>' + relEsc(empresa) + '</strong></div>' : ''}
    <div>${relEsc(rel.filtro)}</div>
    <div><strong>${relEsc(relResumoTotais(rel.totais, rel.idioma))}</strong></div>
    <div>${relEsc(relT(rel.idioma).geradoEm)} ${relEsc(relCarimboData(rel.idioma))}</div>
  </div>
  <table>
    <thead><tr>${rel.colunas.map(c => '<th>' + relEsc(c.titulo) + '</th>').join('')}</tr></thead>
    <tbody>${corpo}</tbody>
  </table>
</body></html>`);
        // O print vai no onload do documento gerado (ver <body onload>): se
        // fosse chamado daqui, dispararia antes de a nova janela ter layout.
        janela.document.close();
        janela.focus();
        relFecharModal();
    });
}

document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('modalRelatorio');
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) relFecharModal();
});
