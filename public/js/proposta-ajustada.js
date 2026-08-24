/* proposta-ajustada.js — Proposta AJUSTADA (pós-disputa) a partir de Participações.
 *
 * Documento diferente da proposta comercial de propostas-api.js: aquela sai com o
 * valor de proposta INICIAL; esta sai com o valor efetivamente ARREMATADO, que é o
 * que o pregoeiro pede na convocação de anexos (categoria 830).
 *
 * Fluxo: valores da proposta → arrematados → catálogo do item → fornecedor
 *        → jsPDF → /api/pdf/assinar (certificado A1 do servidor)
 *        → /api/comprasnet/anexos (multipart no portal), um POST por item.
 *
 * Depende só de APIs — não usa estado em memória de outra página. Requer jsPDF
 * carregado antes (jspdf.umd.min.js).
 *
 * DÉBITO CONHECIDO: o layout do PDF é próximo do de propostas-api.js
 * (gerarPDFIndividual) mas independente. Se o leiaute da proposta mudar, tem que
 * mudar nos dois lugares — vale unificar num módulo compartilhado depois.
 */
(function () {
  'use strict';

  const money = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  async function getJSON(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return r.json();
  }

  // Itens que realmente disputamos: os marcados como selecionados em valores_proposta.
  async function itensSelecionados(compraId) {
    const j = await getJSON(`/api/proposta/valores-compra/${encodeURIComponent(compraId)}`);
    const valores = (j && j.valores) || {};
    return Object.keys(valores)
      .filter((n) => valores[n] && valores[n].selecionado)
      .map((n) => ({ numero: parseInt(n, 10), ...valores[n] }))
      .filter((x) => !isNaN(x.numero))
      .sort((a, b) => a.numero - b.numero);
  }

  // ── Sincronizar arrematados ────────────────────────────────────────────────
  async function sincronizarArrematados(compraId) {
    let itens;
    try { itens = await itensSelecionados(compraId); }
    catch (e) { alert('Não consegui ler os itens da proposta: ' + e.message); return; }

    if (!itens.length) {
      alert('Nenhum item selecionado nesta compra.\nMarque os itens em Propostas antes de sincronizar.');
      return;
    }

    // O portal devolve 429 sem intervalo; o servidor espaça as chamadas em 4s.
    const segundos = Math.max(1, (itens.length - 1) * 4);
    if (!confirm(`Buscar no Comprasnet o valor arrematado de ${itens.length} item(ns)?\nLeva cerca de ${segundos}s.`)) return;

    try {
      const r = await fetch('/api/comprasnet/resultado-item/sincronizar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ compra: compraId, itens: itens.map((i) => i.numero) }),
      });
      const j = await r.json();
      if (!j.success) { alert('Falha: ' + (j.error || r.status)); return; }
      const linhas = (j.itens || []).map((i) =>
        `item ${i.numeroItem}: ${i.valorArrematado != null ? money(i.valorArrematado) : '(sem valor)'}` +
        (i.ganhamos === 1 ? ' — ganhamos' : i.ganhamos === 0 ? ' — não ganhamos' : '')
      );
      const falhas = (j.falhas || []).map((f) => `item ${f.item}: ${f.status || f.erro}`);
      alert(`Arrematados sincronizados (${j.gravados}):\n${linhas.join('\n')}` +
            (falhas.length ? `\n\nFalhas:\n${falhas.join('\n')}` : ''));
    } catch (e) { alert('Erro: ' + e.message); }
  }

  // ── Montagem do PDF ────────────────────────────────────────────────────────
  function construirPDF({ fornecedor, participacao, itens }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 20;

    doc.setFont('helvetica');
    if (fornecedor && fornecedor.logoBase64) {
      try { doc.addImage(fornecedor.logoBase64, 'PNG', 15, y - 5, 45, 22); } catch (e) { /* logo inválida: segue sem */ }
    }
    doc.setFontSize(18); doc.setTextColor(0, 51, 102);
    doc.text('PROPOSTA AJUSTADA', 105, y + (fornecedor && fornecedor.logoBase64 ? 8 : 0), { align: 'center' });
    y += fornecedor && fornecedor.logoBase64 ? 25 : 12;

    doc.setDrawColor(0, 51, 102); doc.setLineWidth(0.5);
    doc.line(15, y, 195, y); y += 8;

    doc.setFontSize(10); doc.setTextColor(0, 0, 0);
    const cab = [
      `Órgão: ${participacao.orgao || '-'}`,
      `UASG: ${participacao.uasg || '-'}   ·   Pregão ${participacao.numero || '-'}/${participacao.ano || '-'}`,
      `Compra: ${participacao.compraId}`,
    ];
    if (participacao.objeto) cab.push(`Objeto: ${String(participacao.objeto).slice(0, 180)}`);
    cab.forEach((l) => { doc.splitTextToSize(l, 180).forEach((s) => { doc.text(s, 15, y); y += 5; }); });
    y += 4;

    doc.setFontSize(11); doc.setTextColor(0, 51, 102);
    doc.text('ITENS — VALORES APÓS A DISPUTA', 15, y); y += 3;
    doc.setTextColor(0, 0, 0);

    doc.autoTable({
      startY: y,
      head: [['Item', 'Descrição', 'Qtd', 'Un.', 'Vl. unitário', 'Vl. total']],
      body: itens.map((i) => [
        String(i.numero),
        i.descricao || '',
        String(i.quantidade),
        i.unidade || 'UN',
        money(i.valorUnitario),
        money(i.valorUnitario * i.quantidade),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [0, 51, 102], textColor: 255 },
      columnStyles: { 1: { cellWidth: 78 }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      margin: { left: 15, right: 15 },
    });
    y = doc.lastAutoTable.finalY + 8;

    const total = itens.reduce((s, i) => s + i.valorUnitario * i.quantidade, 0);
    doc.setFontSize(11);
    doc.text(`VALOR TOTAL: ${money(total)}`, 195, y, { align: 'right' });
    y += 12;

    // Marca/modelo, quando informados
    const comMarca = itens.filter((i) => i.marca || i.modelo);
    if (comMarca.length) {
      doc.setFontSize(9);
      comMarca.forEach((i) => {
        doc.text(`Item ${i.numero}: ${[i.marca && 'Marca ' + i.marca, i.modelo && 'Modelo ' + i.modelo].filter(Boolean).join(' · ')}`, 15, y);
        y += 5;
      });
      y += 4;
    }

    if (y > 240) { doc.addPage(); y = 20; }
    doc.setFontSize(9);
    doc.splitTextToSize(
      'Declaramos que os valores acima correspondem aos lances finais registrados na sessão pública, ' +
      'e que nesta proposta estão inclusos todos os custos, tributos e encargos necessários à execução do objeto.',
      180
    ).forEach((s) => { doc.text(s, 15, y); y += 5; });
    y += 10;

    const dataAtual = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    doc.setFontSize(10);
    doc.text(fornecedor && fornecedor.cidade
      ? `${fornecedor.cidade}/${fornecedor.uf || ''}, ${dataAtual}`
      : `Local e Data: _________________________, ${dataAtual}`, 15, y);
    y += 20;

    doc.line(40, y, 170, y); y += 5;
    doc.setFontSize(9);
    if (fornecedor && fornecedor.representanteLegal) {
      doc.text(fornecedor.representanteLegal, 105, y, { align: 'center' }); y += 4;
      doc.text([
        fornecedor.cpfRepresentante ? `CPF: ${fornecedor.cpfRepresentante}` : '',
        fornecedor.cargoRepresentante || '',
      ].filter(Boolean).join(' - ') || 'Representante Legal', 105, y, { align: 'center' });
    } else {
      doc.text('Assinatura do Representante Legal', 105, y, { align: 'center' });
    }

    const paginas = doc.internal.getNumberOfPages();
    for (let i = 1; i <= paginas; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(128, 128, 128);
      doc.text(`Página ${i} de ${paginas}`, 195, 290, { align: 'right' });
    }
    return doc;
  }

  // ── Gerar + assinar + anexar ───────────────────────────────────────────────
  async function gerarPropostaAjustada(compraId, opts) {
    opts = opts || {};
    if (!window.jspdf) { alert('Biblioteca de PDF não carregou. Recarregue a página.'); return; }

    let selecionados, arrematados, catalogo, fornecedor, participacao;
    try {
      selecionados = await itensSelecionados(compraId);
      if (!selecionados.length) {
        alert('Nenhum item selecionado nesta compra.\nMarque os itens em Propostas antes de gerar.');
        return;
      }

      const jRes = await getJSON(`/api/comprasnet/resultado-item/compra/${encodeURIComponent(compraId)}`);
      arrematados = (jRes && jRes.porItem) || {};

      const jPart = await getJSON(`/api/relatorios/participacoes?q=${encodeURIComponent(compraId)}`);
      participacao = (jPart.participacoes || []).find((x) => String(x.compraId) === String(compraId));
      if (!participacao) { alert('Participação não encontrada para esta compra.'); return; }
      // compraId = {uasg:6}{modalidade:2}{numero:5}{ano:4}. A linha de participações
      // às vezes vem sem `numero`/`ano`; deriva do próprio id para o cabeçalho não
      // sair com "Pregão -/-" num documento que vai assinado.
      const cid = String(compraId).replace(/\D/g, '');
      participacao.uasg = cid.slice(0, 6);
      if (!participacao.numero && cid.length >= 9) participacao.numero = String(parseInt(cid.slice(-9, -4), 10));
      if (!participacao.ano && cid.length >= 4) participacao.ano = cid.slice(-4);

      // Catálogo local (PNCP) para descrição/quantidade/unidade dos itens.
      catalogo = {};
      try {
        const jCat = await getJSON(`/api/licitacoes/${participacao.cnpj}/${String(participacao.sequencial).padStart(6, '0')}/${participacao.ano}/itens`);
        for (const it of (jCat.data || jCat.itens || [])) catalogo[it.numeroItem] = it;
      } catch (e) { catalogo = {}; }

      const jForn = await getJSON('/api/fornecedor');
      fornecedor = jForn.fornecedor || jForn.data || jForn;
    } catch (e) { alert('Erro ao montar a proposta: ' + e.message); return; }

    // Trava: proposta ajustada sem valor arrematado sairia com o preço PRÉ-disputa,
    // e assinada digitalmente. Melhor não gerar do que gerar errado.
    const semValor = selecionados.filter((s) => {
      const a = arrematados[s.numero];
      return !a || typeof a.valorArrematado !== 'number';
    }).map((s) => s.numero);
    if (semValor.length) {
      alert(`Sem valor arrematado para o(s) item(ns) ${semValor.join(', ')}.\n\n` +
            'Clique em "Sincronizar arrematados" antes de gerar — do contrário o PDF sairia ' +
            'com o valor da proposta inicial.');
      return;
    }

    const itens = selecionados.map((s) => {
      const cat = catalogo[s.numero] || {};
      return {
        numero: s.numero,
        descricao: cat.descricao || '',
        quantidade: Number(cat.quantidade) || 1,
        unidade: cat.unidadeMedida || 'UN',
        valorUnitario: arrematados[s.numero].valorArrematado,
        marca: s.marca || '',
        modelo: s.modelo || '',
      };
    });

    const resumo = itens.map((i) => `item ${i.numero}: ${money(i.valorUnitario)}`).join('\n');
    if (!confirm(`Gerar a PROPOSTA AJUSTADA assinada${opts.anexar ? ' e anexar no Comprasnet' : ''}?\n\n` +
                 `Compra ${compraId}\n${resumo}\n\n` +
                 (opts.anexar ? 'O envio ao portal não pode ser desfeito por aqui (só excluindo o anexo depois).' : ''))) return;

    let doc;
    try { doc = construirPDF({ fornecedor, participacao, itens }); }
    catch (e) { alert('Erro ao montar o PDF: ' + e.message); return; }

    const nomeArquivo = `proposta_ajustada_${participacao.numero || 'compra'}_${participacao.ano || ''}_${new Date().toISOString().slice(0, 10)}.pdf`;
    const baixar = (b64) => {
      const a = document.createElement('a');
      a.href = 'data:application/pdf;base64,' + b64;
      a.download = nomeArquivo;
      a.click();
    };

    // Assinatura com o certificado A1 do servidor.
    let assinado;
    try {
      const r = await fetch('/api/pdf/assinar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ pdfBase64: doc.output('datauristring').split(',')[1] }),
      });
      const j = await r.json();
      if (!j.success) {
        alert('Não consegui assinar: ' + (j.error || r.status) + '\nBaixando sem assinatura.');
        doc.save(nomeArquivo.replace('.pdf', '_sem_assinatura.pdf'));
        return;
      }
      assinado = j.pdfAssinado;
    } catch (e) {
      alert('Erro ao assinar: ' + e.message + '\nBaixando sem assinatura.');
      doc.save(nomeArquivo.replace('.pdf', '_sem_assinatura.pdf'));
      return;
    }

    if (!opts.anexar) { baixar(assinado); alert('Proposta ajustada assinada gerada.'); return; }

    // Um anexo por item — o portal indexa anexo por item, não por compra.
    const ok = []; const falhas = [];
    for (const i of itens) {
      try {
        const r = await fetch('/api/comprasnet/anexos', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ compra: compraId, item: i.numero, pdfBase64: assinado, nomeArquivo }),
        });
        const j = await r.json();
        if (j.success) ok.push(i.numero); else falhas.push(`item ${i.numero}: ${j.error || j.message || j.status}`);
      } catch (e) { falhas.push(`item ${i.numero}: ${e.message}`); }
    }

    if (ok.length && !falhas.length) alert(`Proposta anexada no Comprasnet (item ${ok.join(', ')}).`);
    else if (ok.length) alert(`Anexado no(s) item(ns) ${ok.join(', ')}.\nFalhou em:\n${falhas.join('\n')}`);
    else { alert(`Não consegui anexar:\n${falhas.join('\n')}\n\nBaixando o PDF para envio manual.`); baixar(assinado); }
  }

  window.sincronizarArrematados = sincronizarArrematados;
  window.gerarPropostaAjustada = gerarPropostaAjustada;
})();
