/**
 * posto-movimento.js — Módulo Posto, fase 1: o que mexe no estoque líquido.
 *
 * Quatro eventos, e cada um mexe numa ponta diferente:
 *
 *   ABASTECIMENTO  bico ──► cliente      encerrante SOBE, tanque DESCE
 *   AFERIÇÃO       bico ──► aferidor ──► tanque
 *                                        encerrante SOBE, tanque NÃO muda
 *   DESCARGA       caminhão ──► tanque   tanque SOBE
 *   MEDIÇÃO        (leitura)             não move nada; é o contraditório
 *
 * A aferição é a pegadinha do domínio: ela move o totalizador do bico como se
 * fosse venda, mas o combustível volta ao tanque. Quem não a registra vê o
 * LMC acusar falta de 20 L por bico aferido — e vai procurar ladrão onde só
 * houve fiscalização do INMETRO.
 *
 * O encerrante do bico é a fonte da verdade da saída, e ele só anda para
 * frente: é totalizador mecânico. Por isso todo lançamento aqui é validado
 * contra `posto_bicos.encerranteAtual` e nunca o faz retroceder.
 */

const { logAction } = require('../audit-log');

function r2(n) { return Number((Number(n) || 0).toFixed(2)); }
function r3(n) { return Number((Number(n) || 0).toFixed(3)); }

function agoraISO() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

// O LMC separa os dias comparando STRING (`dataHora BETWEEN '<dia> 00:00:00'
// AND '<dia> 23:59:59'`). Uma data em qualquer outro formato — 'ontem',
// '01/07/2026', ISO com T — grava, responde 200 e o lançamento fica invisível
// para o livro: o encerrante sobe e a venda não existe na escrituração.
// Aceita 'YYYY-MM-DD HH:MM:SS', o mesmo com 'T', e só a data (vira meia-noite).
function normalizarDataHora(valor) {
  if (valor === undefined || valor === null || valor === '') return { ok: true, valor: agoraISO() };
  const s = String(valor).trim().replace('T', ' ');
  let completo = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) completo = `${s} 00:00:00`;
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) completo = `${s}:00`;
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) completo = s;
  if (!completo) {
    return { ok: false, erro: `data/hora inválida: "${valor}" (use YYYY-MM-DD HH:MM:SS)` };
  }
  // A regex garante a FORMA, não a existência: '2026-13-45 99:99:99' passava por
  // ela e era gravado literal — e aí o BETWEEN do LMC nunca casava, deixando o
  // lançamento invisível no livro com o encerrante já movido. Round-trip pelo
  // Date rejeita mês 13, 31 de fevereiro e hora 25.
  const [d, h] = completo.split(' ');
  const iso = new Date(`${d}T${h}Z`);
  if (Number.isNaN(iso.getTime()) || iso.toISOString().slice(0, 19).replace('T', ' ') !== completo) {
    return { ok: false, erro: `data/hora inexistente: "${valor}"` };
  }
  return { ok: true, valor: completo };
}

// Datas de cadastro (só o dia): vigência de preço, aplicação/remoção de lacre.
// O lacre alimenta o registro 1360 do SPED — data inventada ali vira problema
// na escrituração, não na tela.
function normalizarData(valor) {
  if (valor === undefined || valor === null || valor === '') return { ok: true, valor: null };
  const s = String(valor).trim().slice(0, 10);
  const r = normalizarDataHora(s);
  return r.ok ? { ok: true, valor: r.valor.slice(0, 10) } : r;
}

function lerConfigNum(db, chave, fallback) {
  try {
    const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
    const n = Number(r && r.valor);
    return Number.isFinite(n) ? n : fallback;
  } catch (_) {
    return fallback;
  }
}

function registrarRotasPostoMovimento(app, db, gateFlag) {

  // ==================== TURNOS ====================

  app.get('/api/posto/turnos', gateFlag, (req, res) => {
    try {
      const limite = Math.min(Number(req.query.limite) || 50, 500);
      const items = db.prepare(`
        SELECT t.*,
               (SELECT COUNT(*) FROM posto_abastecimentos a WHERE a.turnoId = t.id) AS abastecimentos
          FROM posto_turnos t
         ORDER BY t.abertoEm DESC
         LIMIT ?
      `).all(limite);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/posto/turnos/aberto', gateFlag, (req, res) => {
    try {
      const turno = db.prepare("SELECT * FROM posto_turnos WHERE status = 'aberto' ORDER BY abertoEm DESC LIMIT 1").get();
      if (!turno) return res.json({ success: true, turno: null });
      const bicos = db.prepare(`
        SELECT tb.*, bi.numero AS bicoNumero, bi.encerranteAtual, b.codigo AS bombaCodigo,
               c.nome AS combustivelNome
          FROM posto_turno_bicos tb
          JOIN posto_bicos bi ON bi.id = tb.bicoId
          JOIN posto_bombas b ON b.id = bi.bombaId
          JOIN posto_tanques tq ON tq.id = bi.tanqueId
          JOIN posto_combustiveis c ON c.id = tq.combustivelId
         WHERE tb.turnoId = ?
         ORDER BY b.codigo, bi.numero
      `).all(turno.id);
      res.json({ success: true, turno, bicos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Abrir turno congela o encerrante de cada bico ativo. Sem esse retrato o
  // fechamento não teria contra o que comparar — e a comparação é justamente
  // o que pega venda não lançada.
  app.post('/api/posto/turnos', gateFlag, (req, res) => {
    try {
      const aberto = db.prepare("SELECT id, frentistaNome FROM posto_turnos WHERE status = 'aberto' LIMIT 1").get();
      if (aberto) {
        return res.status(400).json({
          success: false,
          error: `turno #${aberto.id} (${aberto.frentistaNome}) ainda está aberto — feche antes de abrir outro`,
        });
      }
      const nome = String(req.body?.frentistaNome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome do frentista é obrigatório' });

      const bicos = db.prepare('SELECT id, encerranteAtual FROM posto_bicos WHERE ativo = 1').all();
      if (!bicos.length) {
        return res.status(400).json({ success: false, error: 'nenhum bico ativo cadastrado' });
      }
      // `abertoEm` é a chave do ORDER BY que elege o turno aberto: lixo aqui
      // desordena a fila de turnos, não só a data exibida.
      const dhAbre = normalizarDataHora(req.body?.abertoEm);
      if (!dhAbre.ok) return res.status(400).json({ success: false, error: dhAbre.erro });

      let turnoId;
      const tx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO posto_turnos (frentistaNome, funcionarioId, abertoEm, status, caixaAberturaValor, observacao)
          VALUES (?, ?, ?, 'aberto', ?, ?)
        `).run(
          nome,
          req.body?.funcionarioId || null,
          dhAbre.valor,
          Number(req.body?.caixaAberturaValor) || 0,
          req.body?.observacao ? String(req.body.observacao).trim() : null,
        );
        turnoId = r.lastInsertRowid;
        const ins = db.prepare(`
          INSERT INTO posto_turno_bicos (turnoId, bicoId, encerranteInicio) VALUES (?, ?, ?)
        `);
        for (const b of bicos) ins.run(turnoId, b.id, b.encerranteAtual);
      });
      tx();
      try { logAction(db, req, 'create', 'posto_turno', turnoId, { frentista: nome }); } catch (_) { /* */ }
      res.json({ success: true, id: turnoId, bicos: bicos.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fechar turno: confere encerrante contra o que foi lançado, bico a bico.
  // A aferição entra na conta dos litros registrados porque também move o
  // totalizador — ignorá-la faria todo bico aferido parecer ter venda a menos.
  app.post('/api/posto/turnos/:id/fechar', gateFlag, (req, res) => {
    try {
      const turno = db.prepare('SELECT * FROM posto_turnos WHERE id = ?').get(req.params.id);
      if (!turno) return res.status(404).json({ success: false, error: 'turno não encontrado' });
      if (turno.status === 'fechado') {
        return res.status(400).json({ success: false, error: 'turno já está fechado' });
      }

      const leituras = Array.isArray(req.body?.bicos) ? req.body.bicos : [];
      const linhas = db.prepare('SELECT * FROM posto_turno_bicos WHERE turnoId = ?').all(turno.id);
      const porBico = new Map(linhas.map(l => [l.bicoId, l]));

      // Bico repetido no corpo era processado duas vezes e dobrava o valor
      // apurado — R$ 600 de venda viravam R$ 1.200 de "quebra" contra o caixa.
      const vistos = new Set();
      for (const leitura of leituras) {
        const id = Number(leitura.bicoId);
        if (vistos.has(id)) {
          return res.status(400).json({ success: false, error: `bico ${leitura.bicoId} informado mais de uma vez` });
        }
        vistos.add(id);
      }

      // Valida tudo antes de gravar qualquer coisa: fechamento pela metade
      // deixaria o turno num estado que nenhuma tela sabe representar.
      for (const leitura of leituras) {
        const linha = porBico.get(Number(leitura.bicoId));
        if (!linha) {
          return res.status(400).json({ success: false, error: `bico ${leitura.bicoId} não faz parte deste turno` });
        }
        const fim = Number(leitura.encerranteFim);
        if (!Number.isFinite(fim)) {
          return res.status(400).json({ success: false, error: `encerrante final inválido no bico ${leitura.bicoId}` });
        }
        if (fim < linha.encerranteInicio) {
          return res.status(400).json({
            success: false,
            error: `encerrante do bico ${leitura.bicoId} não pode diminuir (abertura ${linha.encerranteInicio}, informado ${fim})`,
          });
        }
      }

      // Fechamento é do TURNO INTEIRO, não dos bicos que vieram no corpo.
      // Faltando bico, o `valorApurado` sairia menor que a venda real e a
      // quebra de caixa apareceria a favor do frentista; e com a lista vazia o
      // turno fechava zerado, sem encerrante nenhum gravado — e não há rota de
      // reabrir turno, então isso era perda definitiva da apuração.
      const faltando = linhas.filter(l => !leituras.some(x => Number(x.bicoId) === l.bicoId));
      if (faltando.length) {
        const bicos = db.prepare(
          `SELECT id, numero FROM posto_bicos WHERE id IN (${faltando.map(() => '?').join(',')})`
        ).all(...faltando.map(l => l.bicoId));
        return res.status(400).json({
          success: false,
          error: `faltou a leitura do encerrante em ${faltando.length} bico(s): ${bicos.map(b => b.numero).join(', ')}`,
          bicosFaltando: bicos,
        });
      }

      const dhFecha = normalizarDataHora(req.body?.fechadoEm);
      if (!dhFecha.ok) return res.status(400).json({ success: false, error: dhFecha.erro });
      const fechadoEm = dhFecha.valor;
      let valorApurado = 0;
      const resumo = [];

      const tx = db.transaction(() => {
        for (const leitura of leituras) {
          const linha = porBico.get(Number(leitura.bicoId));
          const fim = Number(leitura.encerranteFim);
          const apurados = r3(fim - linha.encerranteInicio);

          const somaAbast = db.prepare(`
            SELECT COALESCE(SUM(litros), 0) AS litros, COALESCE(SUM(valorTotal), 0) AS valor
              FROM posto_abastecimentos WHERE turnoId = ? AND bicoId = ?
          `).get(turno.id, linha.bicoId);
          // Por turnoId, não por janela de horário: com `abertoEm` retroativo a
          // janela reabsorvia aferição de turno já fechado e inventava litros
          // registrados que ninguém lançou aqui.
          const somaAfer = db.prepare(`
            SELECT COALESCE(SUM(volumeMedidoMl), 0) AS ml
              FROM posto_afericoes WHERE turnoId = ? AND bicoId = ?
          `).get(turno.id, linha.bicoId);

          const registrados = r3(somaAbast.litros + (somaAfer.ml / 1000));
          const divergencia = r3(apurados - registrados);

          db.prepare(`
            UPDATE posto_turno_bicos
               SET encerranteFim = ?, litrosApurados = ?, litrosRegistrados = ?, divergenciaLitros = ?
             WHERE id = ?
          `).run(fim, apurados, registrados, divergencia, linha.id);

          // O encerrante do bico passa a ser o do fechamento: a leitura física
          // vence o acumulado dos lançamentos, porque é ela que o fiscal lê.
          db.prepare('UPDATE posto_bicos SET encerranteAtual = ? WHERE id = ?').run(fim, linha.bicoId);

          valorApurado += somaAbast.valor;
          resumo.push({ bicoId: linha.bicoId, apurados, registrados, divergencia });
        }

        const entregue = Number(req.body?.valorEntregue) || 0;
        db.prepare(`
          UPDATE posto_turnos
             SET fechadoEm = ?, status = 'fechado', valorApurado = ?, valorEntregue = ?,
                 diferencaCaixa = ?, observacao = COALESCE(?, observacao)
           WHERE id = ?
        `).run(
          fechadoEm, r2(valorApurado), r2(entregue), r2(entregue - valorApurado),
          req.body?.observacao ? String(req.body.observacao).trim() : null,
          turno.id,
        );
      });
      tx();

      try { logAction(db, req, 'update', 'posto_turno', turno.id, { fechado: true, valorApurado: r2(valorApurado) }); } catch (_) { /* */ }
      res.json({
        success: true,
        valorApurado: r2(valorApurado),
        divergencias: resumo.filter(r => Math.abs(r.divergencia) > 0.001),
        bicos: resumo,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ABASTECIMENTOS ====================

  app.get('/api/posto/abastecimentos', gateFlag, (req, res) => {
    try {
      const where = [];
      const params = [];
      if (req.query.turnoId) { where.push('a.turnoId = ?'); params.push(req.query.turnoId); }
      if (req.query.bicoId)  { where.push('a.bicoId = ?');  params.push(req.query.bicoId); }
      if (req.query.de)      { where.push('a.dataHora >= ?'); params.push(req.query.de); }
      if (req.query.ate)     { where.push('a.dataHora <= ?'); params.push(String(req.query.ate) + ' 23:59:59'); }
      const limite = Math.min(Number(req.query.limite) || 200, 2000);
      const items = db.prepare(`
        SELECT a.*, bi.numero AS bicoNumero, b.codigo AS bombaCodigo,
               t.codigo AS tanqueCodigo, c.nome AS combustivelNome
          FROM posto_abastecimentos a
          JOIN posto_bicos bi ON bi.id = a.bicoId
          JOIN posto_bombas b ON b.id = bi.bombaId
          JOIN posto_tanques t ON t.id = bi.tanqueId
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY a.dataHora DESC, a.id DESC
         LIMIT ?
      `).all(...params, limite);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Aceita os dois jeitos de lançar, porque os dois existem na pista:
  //   { litros: 30 }            → digitado do visor da bomba
  //   { encerranteFim: 12345 }  → lido do totalizador (é o que o concentrador
  //                               vai mandar na fase 3, sem tocar nesta rota)
  app.post('/api/posto/abastecimentos', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const bico = db.prepare(`
        SELECT bi.*, c.precoLitro, c.nome AS combustivelNome
          FROM posto_bicos bi
          JOIN posto_tanques t ON t.id = bi.tanqueId
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         WHERE bi.id = ?
      `).get(b.bicoId);
      if (!bico) return res.status(400).json({ success: false, error: 'bico inexistente' });
      if (!bico.ativo) return res.status(400).json({ success: false, error: 'bico inativo' });

      const encInicio = bico.encerranteAtual;
      let litros;
      if (b.encerranteFim !== undefined && b.encerranteFim !== null && b.encerranteFim !== '') {
        const fim = Number(b.encerranteFim);
        if (!Number.isFinite(fim)) return res.status(400).json({ success: false, error: 'encerrante final inválido' });
        if (fim < encInicio) {
          return res.status(400).json({
            success: false,
            error: `encerrante não pode retroceder (atual ${encInicio}, informado ${fim})`,
          });
        }
        litros = r3(fim - encInicio);
      } else {
        litros = r3(b.litros);
      }
      if (!Number.isFinite(litros) || litros <= 0) {
        return res.status(400).json({ success: false, error: 'informe litros ou o encerrante final' });
      }

      const tipo = ['venda', 'interno', 'afericao'].includes(b.tipo) ? b.tipo : 'venda';
      // Consumo interno não é venda: sai do estoque sem receita, então preço 0
      // é um resultado legítimo e não deve ser "corrigido" pelo preço da bomba.
      const preco = b.precoLitro !== undefined ? Number(b.precoLitro)
        : (tipo === 'venda' ? Number(bico.precoLitro) || 0 : 0);
      if (!Number.isFinite(preco) || preco < 0) {
        return res.status(400).json({ success: false, error: 'preço inválido' });
      }

      const dh = normalizarDataHora(b.dataHora);
      if (!dh.ok) return res.status(400).json({ success: false, error: dh.erro });

      const turnoAberto = db.prepare("SELECT id FROM posto_turnos WHERE status = 'aberto' ORDER BY abertoEm DESC LIMIT 1").get();
      // `turnoId` vindo do corpo era aceito sem conferência: apontando para um
      // turno já fechado, a venda entrava num turno APURADO — não somava no
      // valor dele (já calculado) e o estorno era recusado por turno fechado.
      // Dinheiro que não apura e não sai.
      let turnoId;
      if (b.turnoId !== undefined && b.turnoId !== null && b.turnoId !== '') {
        const alvo = db.prepare('SELECT id, status FROM posto_turnos WHERE id = ?').get(b.turnoId);
        if (!alvo) return res.status(400).json({ success: false, error: `turno ${b.turnoId} inexistente` });
        if (alvo.status !== 'aberto') {
          return res.status(400).json({ success: false, error: `turno ${b.turnoId} já está fechado` });
        }
        turnoId = alvo.id;
      } else {
        turnoId = turnoAberto ? turnoAberto.id : null;
      }
      const encFim = r3(encInicio + litros);
      const valorTotal = r2(litros * preco);

      let id;
      const tx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO posto_abastecimentos
            (turnoId, bicoId, dataHora, litros, precoLitro, valorTotal, encerranteInicio, encerranteFim,
             tipo, origem, pessoaId, placa, odometro, documento, observacao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          turnoId, bico.id, dh.valor, litros, preco, valorTotal, encInicio, encFim,
          tipo,
          ['manual', 'concentrador', 'importado'].includes(b.origem) ? b.origem : 'manual',
          b.pessoaId || null,
          b.placa ? String(b.placa).trim().toUpperCase() : null,
          b.odometro ? Number(b.odometro) : null,
          b.documento ? String(b.documento).trim() : null,
          b.observacao ? String(b.observacao).trim() : null,
        );
        id = r.lastInsertRowid;
        db.prepare('UPDATE posto_bicos SET encerranteAtual = ? WHERE id = ?').run(encFim, bico.id);

        // Bico cadastrado com o turno JÁ aberto não entrou na foto da abertura,
        // mas a venda nele é amarrada ao turno aberto. Sem esta linha o
        // fechamento não o conhece: declará-lo dava "não faz parte deste turno"
        // e omiti-lo tirava a venda do valor apurado — uma sobra de caixa que
        // não existe. Entra na foto no primeiro uso, com o encerrante de antes.
        if (turnoId) {
          db.prepare(`
            INSERT OR IGNORE INTO posto_turno_bicos (turnoId, bicoId, encerranteInicio)
            VALUES (?, ?, ?)
          `).run(turnoId, bico.id, encInicio);
        }
      });
      tx();
      res.json({ success: true, id, litros, valorTotal, encerranteInicio: encInicio, encerranteFim: encFim, turnoId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Estornar devolve o encerrante SÓ se o abastecimento for o último do bico —
  // senão o totalizador ficaria menor que lançamentos posteriores. Nos demais
  // casos a linha some e a diferença aparece no fechamento do turno, que é
  // exatamente onde se quer que ela apareça.
  app.delete('/api/posto/abastecimentos/:id', gateFlag, (req, res) => {
    try {
      const abast = db.prepare('SELECT * FROM posto_abastecimentos WHERE id = ?').get(req.params.id);
      if (!abast) return res.status(404).json({ success: false, error: 'abastecimento não encontrado' });
      const turno = abast.turnoId
        ? db.prepare('SELECT status FROM posto_turnos WHERE id = ?').get(abast.turnoId) : null;
      if (turno && turno.status === 'fechado') {
        return res.status(400).json({ success: false, error: 'turno já fechado — não é possível estornar' });
      }
      // O dia do LMC já escriturado é a outra trava, e faltava: sem turno
      // (turnoId null) o estorno passava mesmo com o livro fechado, e aí o
      // gravado dizia 300 L enquanto o recálculo dizia 0 — duas verdades para
      // o mesmo dia, sem ninguém comparar. Reabrir o dia é decisão consciente.
      const diaFechado = db.prepare(`
        SELECT d.data, c.nome AS combustivelNome
          FROM posto_lmc_dias d
          JOIN posto_combustiveis c ON c.id = d.combustivelId
          JOIN posto_tanques t ON t.combustivelId = c.id
          JOIN posto_bicos bi ON bi.tanqueId = t.id
         WHERE bi.id = ? AND d.data = ? AND d.status = 'fechado'
         LIMIT 1
      `).get(abast.bicoId, String(abast.dataHora).slice(0, 10));
      if (diaFechado) {
        return res.status(400).json({
          success: false,
          error: `o LMC de ${diaFechado.data} (${diaFechado.combustivelNome}) já está fechado — reabra o dia antes de estornar`,
          sugestao: 'reabrir-lmc',
          data: diaFechado.data,
        });
      }
      const bico = db.prepare('SELECT * FROM posto_bicos WHERE id = ?').get(abast.bicoId);
      const ehUltimo = bico && Math.abs(bico.encerranteAtual - abast.encerranteFim) < 0.001;
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM posto_abastecimentos WHERE id = ?').run(req.params.id);
        if (ehUltimo) {
          db.prepare('UPDATE posto_bicos SET encerranteAtual = ? WHERE id = ?')
            .run(abast.encerranteInicio, abast.bicoId);
        }
      });
      tx();
      try { logAction(db, req, 'delete', 'posto_abastecimento', req.params.id, { litros: abast.litros, encerranteRevertido: ehUltimo }); } catch (_) { /* */ }
      res.json({ success: true, encerranteRevertido: ehUltimo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== DESCARGAS ====================

  app.get('/api/posto/descargas', gateFlag, (req, res) => {
    try {
      const limite = Math.min(Number(req.query.limite) || 100, 1000);
      const items = db.prepare(`
        SELECT d.*, t.codigo AS tanqueCodigo, c.nome AS combustivelNome
          FROM posto_descargas d
          JOIN posto_tanques t ON t.id = d.tanqueId
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         ORDER BY d.dataHora DESC, d.id DESC
         LIMIT ?
      `).all(limite);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/descargas', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const tanque = db.prepare('SELECT * FROM posto_tanques WHERE id = ?').get(b.tanqueId);
      if (!tanque) return res.status(400).json({ success: false, error: 'tanque inexistente' });

      const litrosNota = Number(b.litrosNota) || 0;
      const antes = b.medicaoAntesLitros !== undefined && b.medicaoAntesLitros !== '' ? Number(b.medicaoAntesLitros) : null;
      const depois = b.medicaoDepoisLitros !== undefined && b.medicaoDepoisLitros !== '' ? Number(b.medicaoDepoisLitros) : null;

      // Recebidos vem da medição quando ela existe (é a única prova do que
      // entrou); sem medição, cai no que a nota diz — que é o que o posto sem
      // sonda tem. O campo `diferencaLitros` deixa explícito quando é 0 por
      // falta de conferência, e não por conferência bem-sucedida.
      let recebidos;
      if (antes !== null && depois !== null) {
        if (depois < antes) {
          return res.status(400).json({ success: false, error: 'medição depois não pode ser menor que antes' });
        }
        recebidos = r3(depois - antes);
      } else {
        recebidos = r3(b.litrosRecebidos !== undefined ? b.litrosRecebidos : litrosNota);
      }
      if (!Number.isFinite(recebidos) || recebidos < 0) {
        return res.status(400).json({ success: false, error: 'volume recebido inválido' });
      }

      // Cabe no tanque? Descarga que estoura a capacidade é erro de digitação
      // ou transbordo — nos dois casos vale barrar.
      if (depois !== null && depois > tanque.capacidadeLitros) {
        return res.status(400).json({
          success: false,
          error: `medição final (${depois} L) acima da capacidade do tanque (${tanque.capacidadeLitros} L)`,
        });
      }

      const dh = normalizarDataHora(b.dataHora);
      if (!dh.ok) return res.status(400).json({ success: false, error: dh.erro });

      const r = db.prepare(`
        INSERT INTO posto_descargas
          (tanqueId, dataHora, notaFiscal, fornecedorId, litrosNota, medicaoAntesLitros, medicaoDepoisLitros,
           litrosRecebidos, temperaturaC, litros20C, diferencaLitros, lacreConferido, amostraTestemunha,
           responsavel, observacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tanque.id, dh.valor,
        b.notaFiscal ? String(b.notaFiscal).trim() : null,
        b.fornecedorId || null,
        litrosNota, antes, depois, recebidos,
        b.temperaturaC !== undefined && b.temperaturaC !== '' ? Number(b.temperaturaC) : null,
        b.litros20C !== undefined && b.litros20C !== '' ? Number(b.litros20C) : null,
        litrosNota ? r3(recebidos - litrosNota) : null,
        b.lacreConferido ? 1 : 0,
        b.amostraTestemunha ? 1 : 0,
        b.responsavel ? String(b.responsavel).trim() : null,
        b.observacao ? String(b.observacao).trim() : null,
      );
      try { logAction(db, req, 'create', 'posto_descarga', r.lastInsertRowid, { tanque: tanque.codigo, litros: recebidos }); } catch (_) { /* */ }
      res.json({
        success: true,
        id: r.lastInsertRowid,
        litrosRecebidos: recebidos,
        diferencaLitros: litrosNota ? r3(recebidos - litrosNota) : null,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== AFERIÇÕES ====================

  app.get('/api/posto/afericoes', gateFlag, (req, res) => {
    try {
      const limite = Math.min(Number(req.query.limite) || 100, 1000);
      const items = db.prepare(`
        SELECT a.*, bi.numero AS bicoNumero, b.codigo AS bombaCodigo, c.nome AS combustivelNome
          FROM posto_afericoes a
          JOIN posto_bicos bi ON bi.id = a.bicoId
          JOIN posto_bombas b ON b.id = bi.bombaId
          JOIN posto_tanques t ON t.id = bi.tanqueId
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         ORDER BY a.dataHora DESC, a.id DESC
         LIMIT ?
      `).all(limite);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Tolerância da Portaria INMETRO 227/2022 em 20 L: de −60 ml a +100 ml.
  // Assimétrica de propósito — a bomba pode entregar a mais, nunca a menos.
  app.post('/api/posto/afericoes', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const bico = db.prepare('SELECT * FROM posto_bicos WHERE id = ?').get(b.bicoId);
      if (!bico) return res.status(400).json({ success: false, error: 'bico inexistente' });
      // Mesma regra do abastecimento: bico desativado não move encerrante.
      if (!bico.ativo) return res.status(400).json({ success: false, error: 'bico inativo' });

      const padrao = Number(b.volumePadraoMl) || lerConfigNum(db, 'posto_afericao_padrao_ml', 20000);
      const medido = Number(b.volumeMedidoMl);
      if (!Number.isFinite(medido) || medido <= 0) {
        return res.status(400).json({ success: false, error: 'volume medido inválido' });
      }
      const tolMais = lerConfigNum(db, 'posto_afericao_tol_mais_ml', 100);
      const tolMenos = lerConfigNum(db, 'posto_afericao_tol_menos_ml', 60);
      const desvio = r3(medido - padrao);
      const aprovado = desvio <= tolMais && desvio >= -tolMenos ? 1 : 0;

      const dh = normalizarDataHora(b.dataHora);
      if (!dh.ok) return res.status(400).json({ success: false, error: dh.erro });

      const retorna = b.retornouAoTanque === 0 || b.retornouAoTanque === false ? 0 : 1;
      const encInicio = bico.encerranteAtual;
      // O que passou pelo bico é o volume medido, não o padrão do aferidor.
      const encFim = r3(encInicio + medido / 1000);
      const turnoAberto = db.prepare(
        "SELECT id FROM posto_turnos WHERE status = 'aberto' ORDER BY abertoEm DESC LIMIT 1").get();
      const turnoId = turnoAberto ? turnoAberto.id : null;

      let id;
      const tx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO posto_afericoes
            (bicoId, turnoId, dataHora, volumePadraoMl, volumeMedidoMl, desvioMl, aprovado,
             encerranteInicio, encerranteFim, retornouAoTanque, responsavel, observacao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          bico.id, turnoId, dh.valor, padrao, medido, desvio, aprovado,
          encInicio, encFim, retorna,
          b.responsavel ? String(b.responsavel).trim() : null,
          b.observacao ? String(b.observacao).trim() : null,
        );
        id = r.lastInsertRowid;
        db.prepare('UPDATE posto_bicos SET encerranteAtual = ? WHERE id = ?').run(encFim, bico.id);
        // Mesma razão do abastecimento: a aferição move o encerrante, então o
        // bico precisa estar na foto do turno para o fechamento fechar a conta.
        if (turnoId) {
          db.prepare(`
            INSERT OR IGNORE INTO posto_turno_bicos (turnoId, bicoId, encerranteInicio)
            VALUES (?, ?, ?)
          `).run(turnoId, bico.id, encInicio);
        }
      });
      tx();
      try { logAction(db, req, 'create', 'posto_afericao', id, { bicoId: bico.id, desvio, aprovado }); } catch (_) { /* */ }
      res.json({
        success: true, id, desvioMl: desvio, aprovado: !!aprovado,
        tolerancia: { mais: tolMais, menos: tolMenos },
        encerranteFim: encFim,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== MEDIÇÕES DE TANQUE ====================

  app.get('/api/posto/medicoes', gateFlag, (req, res) => {
    try {
      const where = [];
      const params = [];
      if (req.query.tanqueId) { where.push('m.tanqueId = ?'); params.push(req.query.tanqueId); }
      if (req.query.data)     { where.push('m.data = ?');     params.push(req.query.data); }
      const limite = Math.min(Number(req.query.limite) || 100, 1000);
      const items = db.prepare(`
        SELECT m.*, t.codigo AS tanqueCodigo, c.nome AS combustivelNome
          FROM posto_medicoes m
          JOIN posto_tanques t ON t.id = m.tanqueId
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY m.dataHora DESC, m.id DESC
         LIMIT ?
      `).all(...params, limite);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/medicoes', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const tanque = db.prepare('SELECT * FROM posto_tanques WHERE id = ?').get(b.tanqueId);
      if (!tanque) return res.status(400).json({ success: false, error: 'tanque inexistente' });
      const litros = Number(b.litrosFisico);
      if (!Number.isFinite(litros) || litros < 0) {
        return res.status(400).json({ success: false, error: 'volume medido inválido' });
      }
      if (litros > tanque.capacidadeLitros) {
        return res.status(400).json({
          success: false,
          error: `medição (${litros} L) acima da capacidade do tanque (${tanque.capacidadeLitros} L)`,
        });
      }
      const dhm = normalizarDataHora(b.dataHora);
      if (!dhm.ok) return res.status(400).json({ success: false, error: dhm.erro });
      const dataHora = dhm.valor;
      // A conciliação casa medição com dia por igualdade de string. Data em
      // outro formato grava, responde 200 e some do LMC: o operador vê
      // "medição salva" e o livro continua dizendo que falta medir.
      const dataDia = b.data || String(dataHora).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDia)) {
        return res.status(400).json({ success: false, error: `data inválida: "${dataDia}" (use YYYY-MM-DD)` });
      }
      const r = db.prepare(`
        INSERT INTO posto_medicoes
          (tanqueId, dataHora, data, tipo, litrosFisico, alturaCm, aguaCm, temperaturaC, origem, responsavel, observacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        tanque.id, dataHora, dataDia,
        ['abertura', 'fechamento', 'avulsa'].includes(b.tipo) ? b.tipo : 'fechamento',
        litros,
        b.alturaCm !== undefined && b.alturaCm !== '' ? Number(b.alturaCm) : null,
        b.aguaCm !== undefined && b.aguaCm !== '' ? Number(b.aguaCm) : null,
        b.temperaturaC !== undefined && b.temperaturaC !== '' ? Number(b.temperaturaC) : null,
        ['manual', 'sonda'].includes(b.origem) ? b.origem : 'manual',
        b.responsavel ? String(b.responsavel).trim() : null,
        b.observacao ? String(b.observacao).trim() : null,
      );

      // Água no fundo do tanque é problema de qualidade, não de volume: avisa
      // sem barrar. Acima de 2,5 cm a ANP manda drenar antes de vender.
      const alertas = [];
      if (b.aguaCm && Number(b.aguaCm) > 2.5) alertas.push('água acima de 2,5 cm — drenar o tanque');
      if (tanque.estoqueMinimoLitros && litros < tanque.estoqueMinimoLitros) {
        alertas.push(`estoque abaixo do mínimo (${tanque.estoqueMinimoLitros} L) — risco de pane seca`);
      }
      res.json({ success: true, id: r.lastInsertRowid, alertas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Estoque corrente por tanque: última medição + descargas − saídas ocorridas
  // depois dela. É a estimativa que a tela mostra entre uma medição e outra.
  app.get('/api/posto/estoque', gateFlag, (req, res) => {
    try {
      const tanques = db.prepare(`
        SELECT t.*, c.nome AS combustivelNome, c.codigo AS combustivelCodigo
          FROM posto_tanques t
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         WHERE t.ativo = 1
         ORDER BY t.codigo
      `).all();

      const items = tanques.map(t => {
        const med = db.prepare(`
          SELECT * FROM posto_medicoes WHERE tanqueId = ? ORDER BY dataHora DESC, id DESC LIMIT 1
        `).get(t.id);
        const desde = med ? med.dataHora : '0000-01-01';
        const ent = db.prepare(`
          SELECT COALESCE(SUM(litrosRecebidos), 0) AS l FROM posto_descargas
           WHERE tanqueId = ? AND dataHora > ?
        `).get(t.id, desde);
        // Aferição volta ao tanque: não é saída. Consumo interno é.
        const sai = db.prepare(`
          SELECT COALESCE(SUM(a.litros), 0) AS l
            FROM posto_abastecimentos a
            JOIN posto_bicos bi ON bi.id = a.bicoId
           WHERE bi.tanqueId = ? AND a.dataHora > ? AND a.tipo <> 'afericao'
        `).get(t.id, desde);

        const base = med ? med.litrosFisico : 0;
        const estimado = r3(base + ent.l - sai.l);
        return {
          ...t,
          ultimaMedicaoL: med ? med.litrosFisico : null,
          ultimaMedicaoEm: med ? med.dataHora : null,
          entradasDesdeL: r3(ent.l),
          saidasDesdeL: r3(sai.l),
          estoqueEstimadoL: estimado,
          ocupacaoPct: t.capacidadeLitros ? r2((estimado / t.capacidadeLitros) * 100) : null,
          abaixoDoMinimo: !!(t.estoqueMinimoLitros && estimado < t.estoqueMinimoLitros),
        };
      });
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasPostoMovimento, normalizarDataHora, normalizarData };
