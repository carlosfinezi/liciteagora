/**
 * restaurante-indicadores.js — Módulo Restaurante, fase 8: KPIs do segmento.
 *
 * Os números que um dono de restaurante olha e que nenhum relatório genérico
 * de ERP entrega:
 *
 *   ticket médio        — faturamento ÷ contas fechadas
 *   giro de mesa        — contas ÷ mesas ativas (quantas vezes a mesa girou)
 *   tempo de permanência— quanto tempo a mesa fica ocupada
 *   engenharia de cardápio — matriz popularidade × margem, que classifica cada
 *                            prato em estrela / cavalo / enigma / peso morto
 *   curva ABC           — quais itens sustentam o faturamento
 *
 * A engenharia de cardápio é a peça que muda decisão: um prato "cavalo"
 * (vende muito, margem baixa) não sai do cardápio — ele atrai gente. O que se
 * faz é mexer no preço ou na ficha. Já o "peso morto" sai. Sem os dois eixos
 * juntos, cortar por margem sozinho tira do cardápio justamente o que traz
 * cliente.
 */

const { custoDaFicha } = require('./restaurante-ficha');
const { msDe, FUSO_LOCAL_SQL } = require('./restaurante-comanda');

function arred(v, casas = 2) {
  const f = Math.pow(10, casas);
  return Math.round(Number(v || 0) * f) / f;
}

/**
 * Classificação da engenharia de cardápio.
 *
 * Os cortes são as MÉDIAS do próprio cardápio, não números absolutos: o que é
 * margem alta numa hamburgueria é margem baixa num restaurante fino, e um
 * corte fixo classificaria errado os dois.
 *
 * As médias são calculadas DENTRO de cada categoria do cardápio (a rota agrupa
 * antes de chamar): prato se compara com prato, bebida com bebida. Com a média
 * do cardápio inteiro, a bebida, que sai em unidades muitas vezes maiores,
 * puxava a popularidade média para cima e jogava quase todo prato em "enigma".
 */
function classificar(popularidade, margem, mediaPopularidade, mediaMargem) {
  const pop = popularidade >= mediaPopularidade;
  const mar = margem >= mediaMargem;
  if (pop && mar) return 'estrela';        // vende e dá dinheiro: destaque no cardápio
  if (pop && !mar) return 'cavalo';        // vende e não dá: ajustar preço ou ficha
  if (!pop && mar) return 'enigma';        // dá dinheiro e não vende: promover
  return 'peso-morto';                     // nem vende nem dá: candidato a sair
}

function registrarRotasIndicadores(app, db, gateFlag) {

  app.get('/api/restaurante/indicadores', gateFlag, (req, res) => {
    try {
      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';

      const contas = db.prepare(`
        SELECT id, tipo, canal, mesaId, numeroPessoas, totalGeral, totalItens,
               abertaEm, fechadaEm
          FROM rest_comandas
         WHERE status = 'fechada' AND DATE(fechadaEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
      `).all(de, ate);

      const faturamento = arred(contas.reduce((s, c) => s + Number(c.totalGeral || 0), 0));
      const pessoas = contas.reduce((s, c) => s + Number(c.numeroPessoas || 1), 0);

      // Tempo de permanência: só faz sentido para mesa. Delivery e balcão
      // entrariam como "5 minutos" e derrubariam a média sem significar nada.
      const deMesa = contas.filter(c => c.tipo === 'mesa' && c.abertaEm && c.fechadaEm);
      const duracoes = deMesa
        .map(c => {
          const ini = msDe(c.abertaEm), fim = msDe(c.fechadaEm);
          return ini != null && fim != null ? (fim - ini) / 60000 : null;
        })
        .filter(m => m != null && m >= 0);
      const permanenciaMedia = duracoes.length
        ? arred(duracoes.reduce((s, m) => s + m, 0) / duracoes.length, 1) : null;

      const mesasAtivas = db.prepare('SELECT COUNT(*) AS n FROM rest_mesas WHERE ativo = 1').get().n;

      // Faturamento por canal: mostra o peso real do delivery, que costuma
      // surpreender quem só olha o salão.
      const porCanal = {};
      for (const c of contas) {
        const k = c.canal || 'salao';
        porCanal[k] = porCanal[k] || { contas: 0, faturamento: 0 };
        porCanal[k].contas++;
        porCanal[k].faturamento = arred(porCanal[k].faturamento + Number(c.totalGeral || 0));
      }

      // Faturamento por dia da semana e por hora, para dimensionar escala.
      const porDiaSemana = db.prepare(`
        SELECT CAST(strftime('%w', fechadaEm, '${FUSO_LOCAL_SQL}') AS INTEGER) AS dia,
               COUNT(*) AS contas, COALESCE(SUM(totalGeral), 0) AS total
          FROM rest_comandas
         WHERE status = 'fechada' AND DATE(fechadaEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
         GROUP BY dia ORDER BY dia
      `).all(de, ate);

      const porHora = db.prepare(`
        SELECT CAST(strftime('%H', fechadaEm, '${FUSO_LOCAL_SQL}') AS INTEGER) AS hora,
               COUNT(*) AS contas, COALESCE(SUM(totalGeral), 0) AS total
          FROM rest_comandas
         WHERE status = 'fechada' AND DATE(fechadaEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
         GROUP BY hora ORDER BY hora
      `).all(de, ate);

      res.json({
        success: true,
        periodo: { de, ate },
        faturamento,
        contasFechadas: contas.length,
        pessoasAtendidas: pessoas,
        ticketMedio: contas.length ? arred(faturamento / contas.length) : 0,
        // Ticket por pessoa é o número comparável entre casas; o por conta
        // depende do tamanho do grupo.
        ticketPorPessoa: pessoas ? arred(faturamento / pessoas) : 0,
        giroDeMesa: mesasAtivas ? arred(deMesa.length / mesasAtivas) : null,
        mesasAtivas,
        permanenciaMediaMin: permanenciaMedia,
        porCanal,
        porDiaSemana: porDiaSemana.map(d => ({ ...d, total: arred(d.total) })),
        porHora: porHora.map(h => ({ ...h, total: arred(h.total) })),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Engenharia de cardápio + curva ABC.
   */
  app.get('/api/restaurante/indicadores/cardapio', gateFlag, (req, res) => {
    try {
      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';

      const vendas = db.prepare(`
        SELECT i.produtoId, i.descricao,
               SUM(i.quantidade) AS quantidade,
               SUM(i.precoTotal) AS receita
          FROM rest_comanda_itens i JOIN rest_comandas c ON c.id = i.comandaId
         WHERE c.status = 'fechada' AND i.status <> 'cancelado'
           AND i.produtoId IS NOT NULL
           AND DATE(c.fechadaEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
         GROUP BY i.produtoId, i.descricao
      `).all(de, ate);

      if (!vendas.length) {
        return res.json({
          success: true, periodo: { de, ate }, itens: [],
          mediasPorCategoria: {}, resumo: { estrela: 0, cavalo: 0, enigma: 0, 'peso-morto': 0 },
        });
      }

      // Categoria do item no cardápio. Um produto pode estar em mais de um
      // cardápio (salão, delivery): vale a do primeiro pela ordem.
      const categoriaDe = db.prepare(`
        SELECT ci.categoria FROM rest_cardapio_itens ci JOIN rest_cardapios cp ON cp.id = ci.cardapioId
         WHERE ci.produtoId = ? AND TRIM(COALESCE(ci.categoria, '')) <> ''
         ORDER BY cp.ordem, cp.id, ci.ordem LIMIT 1
      `);

      const totalQtd = vendas.reduce((s, v) => s + Number(v.quantidade), 0);
      const totalReceita = vendas.reduce((s, v) => s + Number(v.receita), 0);

      const linhas = vendas.map(v => {
        const custoUnit = custoDaFicha(db, v.produtoId).custoPorcao;
        const qtd = Number(v.quantidade);
        const receita = Number(v.receita);
        const precoMedio = qtd > 0 ? receita / qtd : 0;
        const margemUnit = precoMedio - custoUnit;
        const cat = categoriaDe.get(v.produtoId);
        return {
          produtoId: v.produtoId,
          descricao: v.descricao,
          categoria: cat ? cat.categoria.trim() : 'Sem categoria',
          quantidade: qtd,
          receita: arred(receita),
          precoMedio: arred(precoMedio),
          custoUnitario: arred(custoUnit, 4),
          margemUnitaria: arred(margemUnit),
          margemTotal: arred(margemUnit * qtd),
          // Popularidade é participação em QUANTIDADE, não em receita: um prato
          // caro vendendo pouco não é popular.
          popularidadePct: arred((qtd / totalQtd) * 100),
          participacaoReceitaPct: arred((receita / totalReceita) * 100),
          semFicha: custoUnit === 0,
        };
      });

      // Classificação dentro de cada categoria: popularidade é a participação
      // do item na quantidade da PRÓPRIA categoria, e as duas médias também são
      // da categoria.
      const porCategoria = new Map();
      for (const l of linhas) {
        if (!porCategoria.has(l.categoria)) porCategoria.set(l.categoria, []);
        porCategoria.get(l.categoria).push(l);
      }
      const mediasPorCategoria = {};
      for (const [cat, itensCat] of porCategoria) {
        const qtdCat = itensCat.reduce((s, l) => s + l.quantidade, 0);
        const mediaPop = 100 / itensCat.length;      // participação de um item "médio" da categoria
        const mediaMargem = itensCat.reduce((s, l) => s + l.margemUnitaria, 0) / itensCat.length;
        for (const l of itensCat) {
          l.popularidadeCategoriaPct = arred(qtdCat > 0 ? (l.quantidade / qtdCat) * 100 : 0);
          l.classificacao = classificar(l.popularidadeCategoriaPct, l.margemUnitaria, mediaPop, mediaMargem);
        }
        mediasPorCategoria[cat] = { itens: itensCat.length, popularidadePct: arred(mediaPop), margemUnitaria: arred(mediaMargem) };
      }

      // Curva ABC por receita acumulada: A até 80%, B até 95%, C o resto.
      const porReceita = [...linhas].sort((a, b) => b.receita - a.receita);
      let acumulado = 0;
      for (const l of porReceita) {
        acumulado += l.receita;
        const pct = (acumulado / totalReceita) * 100;
        l.acumuladoPct = arred(pct);
        l.curvaABC = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
      }

      const resumo = { estrela: 0, cavalo: 0, enigma: 0, 'peso-morto': 0 };
      for (const l of linhas) resumo[l.classificacao]++;

      res.json({
        success: true,
        periodo: { de, ate },
        totalQuantidade: totalQtd,
        totalReceita: arred(totalReceita),
        mediasPorCategoria,
        resumo,
        // Aviso honesto: item sem ficha entra com custo zero e aparece como
        // margem máxima, o que distorce a matriz inteira.
        semFicha: linhas.filter(l => l.semFicha).length,
        itens: porReceita,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Produtividade por garçom: o que ele vendeu e quantas contas atendeu.
   */
  app.get('/api/restaurante/indicadores/garcons', gateFlag, (req, res) => {
    try {
      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';
      const items = db.prepare(`
        SELECT i.garcomUserId AS userId,
               COALESCE(u.nome, u.username, 'não identificado') AS nome,
               COUNT(DISTINCT i.comandaId) AS contas,
               SUM(i.quantidade) AS itens,
               COALESCE(SUM(i.precoTotal), 0) AS vendido
          FROM rest_comanda_itens i
          JOIN rest_comandas c ON c.id = i.comandaId
          LEFT JOIN users u ON u.id = i.garcomUserId
         WHERE c.status = 'fechada' AND i.status <> 'cancelado'
           AND DATE(c.fechadaEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
         GROUP BY i.garcomUserId ORDER BY vendido DESC
      `).all(de, ate);
      res.json({
        success: true,
        periodo: { de, ate },
        items: items.map(g => ({
          ...g,
          vendido: arred(g.vendido),
          ticketMedio: g.contas ? arred(g.vendido / g.contas) : 0,
        })),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Cancelamentos: o painel que expõe furo de caixa. Item cancelado depois de
   * ir para a cozinha é o padrão que interessa — antes disso é só correção de
   * digitação.
   */
  app.get('/api/restaurante/indicadores/cancelamentos', gateFlag, (req, res) => {
    try {
      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';
      const items = db.prepare(`
        SELECT i.id, i.descricao, i.quantidade, i.precoTotal, i.canceladoMotivo, i.canceladoEm,
               i.preparoEm, c.id AS comandaId, m.numero AS mesaNumero,
               COALESCE(u.nome, u.username) AS garcom
          FROM rest_comanda_itens i
          JOIN rest_comandas c ON c.id = i.comandaId
          LEFT JOIN rest_mesas m ON m.id = c.mesaId
          LEFT JOIN users u ON u.id = i.garcomUserId
         WHERE i.status = 'cancelado' AND DATE(i.canceladoEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
         ORDER BY i.canceladoEm DESC
      `).all(de, ate);

      const depoisDoPreparo = items.filter(i => i.preparoEm);
      res.json({
        success: true,
        periodo: { de, ate },
        items,
        resumo: {
          quantidade: items.length,
          valorTotal: arred(items.reduce((s, i) => s + Number(i.precoTotal || 0), 0)),
          // Este é o número que importa: comida que foi produzida e jogada fora.
          depoisDeIrParaCozinha: depoisDoPreparo.length,
          valorDepoisDaCozinha: arred(depoisDoPreparo.reduce((s, i) => s + Number(i.precoTotal || 0), 0)),
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de indicadores registradas');
}

module.exports = { registrarRotasIndicadores, classificar };
