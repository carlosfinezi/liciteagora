// jornal-scheduler.js
//
// Envio automático do Jornal de Licitações via Telegram.
// Extraído de server.js em NFSE-M06 onda 5A (2026-04-20): schedulers
// pertencem ao processo master (ROLE=master). Este módulo mantém o
// timer interno (_jornalTimeout) e expõe três funções:
//
//   - agendarJornal(db)        — liga o timer diário (NO-OP no worker)
//   - executarJornal(db)       — dispara um envio agora (manual/scheduled)
//   - gerarConteudoJornal(db)  — gera payload sem enviar (preview na UI)
//
// Comportamento em multi-process:
//   Antes da onda 5A o POST /api/jornal/config chamava agendarJornal()
//   diretamente — isso era executado no *worker* e criava um segundo
//   timer, duplicando o envio do telegrama. Com o gate ROLE=master
//   dentro desta função o worker apenas registra a config e loga;
//   o master, quando dispara no próximo ciclo, já lê config fresh
//   do DB. Mudanças de horário demoram até um ciclo para "pegar" —
//   trade-off aceitável dado que o jornal roda uma vez ao dia.

let _jornalTimeout = null;

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function gerarConteudoJornal(db) {
  const config = db.prepare('SELECT * FROM jornal_config WHERE id = 1').get();
  const gruposAtivos = db.prepare(`
    SELECT jg.grupoId, g.nome, g.cor
    FROM jornal_grupos jg
    JOIN grupos_palavras g ON g.id = jg.grupoId
    WHERE jg.ativo = 1
  `).all();

  if (gruposAtivos.length === 0) {
    return { grupos: [], totalLicitacoes: 0, mensagem: 'Nenhum grupo configurado' };
  }

  // Calcular período de busca
  const hoje = new Date();
  const dataInicial = hoje.toISOString().split('T')[0];
  const dataFinal = new Date(hoje.getTime() + (config.diasAntecedencia || 7) * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const resultados = [];
  let totalLicitacoes = 0;

  for (const grupo of gruposAtivos) {
    // Buscar palavras do grupo
    const palavras = db.prepare(`
      SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?
    `).all(grupo.grupoId).map(p => p.palavra);

    if (palavras.length === 0) continue;

    // Construir query de busca
    const conditions = palavras.map(() =>
      `(LOWER(l.objetoCompra) LIKE ? OR LOWER(l.informacaoComplementar) LIKE ? OR LOWER(i.descricao) LIKE ?)`
    ).join(' OR ');

    const params = [];
    palavras.forEach(p => {
      const termo = `%${p.toLowerCase()}%`;
      params.push(termo, termo, termo);
    });

    // Buscar licitações do período
    const licitacoes = db.prepare(`
      SELECT DISTINCT l.id, l.numeroControlePNCP, l.objetoCompra, l.razaoSocial,
        l.nomeUnidade, l.ufSigla, l.municipioNome, l.modalidadeNome,
        l.valorTotalEstimado, l.dataEncerramentoProposta, l.linkSistemaOrigem
      FROM licitacoes l
      LEFT JOIN itens i ON i.licitacaoId = l.id
      WHERE l.dataEncerramentoProposta >= ? AND l.dataEncerramentoProposta <= ?
        AND (${conditions})
      ORDER BY l.dataEncerramentoProposta ASC
      LIMIT 50
    `).all(dataInicial, dataFinal + 'T23:59:59', ...params);

    if (licitacoes.length > 0) {
      resultados.push({
        grupo: grupo.nome,
        cor: grupo.cor,
        palavras: palavras,
        licitacoes: licitacoes,
        total: licitacoes.length
      });
      totalLicitacoes += licitacoes.length;
    }
  }

  return {
    grupos: resultados,
    totalLicitacoes,
    periodo: { dataInicial, dataFinal },
    dataGeracao: new Date().toISOString()
  };
}

async function enviarTelegramJornal(db, conteudo) {
  const telegramConfig = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();

  if (!telegramConfig) {
    throw new Error('Telegram não configurado');
  }

  const { grupos, totalLicitacoes, periodo } = conteudo;

  // Formatar mensagem usando HTML (mais seguro que Markdown)
  let mensagem = `📰 <b>JORNAL DE LICITAÇÕES</b>\n`;
  mensagem += `📅 ${new Date().toLocaleDateString('pt-BR')}\n`;
  mensagem += `📆 Período: ${periodo.dataInicial} a ${periodo.dataFinal}\n`;
  mensagem += `📊 Total: ${totalLicitacoes} licitações encontradas\n\n`;

  for (const resultado of grupos) {
    mensagem += `━━━━━━━━━━━━━━━━━━━━\n`;
    mensagem += `🏷️ <b>${escapeHtml(resultado.grupo)}</b> (${resultado.total})\n\n`;

    for (const lic of resultado.licitacoes.slice(0, 5)) {
      const dataEnc = new Date(lic.dataEncerramentoProposta).toLocaleDateString('pt-BR');
      const valor = lic.valorTotalEstimado
        ? `R$ ${Number(lic.valorTotalEstimado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
        : 'Não informado';

      const objeto = escapeHtml(lic.objetoCompra?.substring(0, 100) || '');
      mensagem += `📋 <b>${escapeHtml(lic.nomeUnidade)}</b>\n`;
      mensagem += `${objeto}${lic.objetoCompra?.length > 100 ? '...' : ''}\n`;
      mensagem += `💰 ${valor} | 📅 Enc: ${dataEnc}\n`;
      if (lic.linkSistemaOrigem) {
        mensagem += `🔗 ${lic.linkSistemaOrigem}\n`;
      }
      mensagem += `\n`;
    }

    if (resultado.total > 5) {
      mensagem += `<i>...e mais ${resultado.total - 5} licitações</i>\n`;
    }
  }

  mensagem += `\n✅ Acesse o sistema para ver todas as licitações`;

  // Enviar via Telegram
  const url = `https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`;

  // Telegram tem limite de 4096 caracteres
  let textoEnviar = mensagem;
  if (mensagem.length > 4000) {
    // Enviar resumo
    textoEnviar = `📰 <b>JORNAL DE LICITAÇÕES</b>\n`;
    textoEnviar += `📅 ${new Date().toLocaleDateString('pt-BR')}\n`;
    textoEnviar += `📆 Período: ${periodo.dataInicial} a ${periodo.dataFinal}\n`;
    textoEnviar += `📊 Total: ${totalLicitacoes} licitações\n\n`;

    for (const resultado of grupos) {
      textoEnviar += `🏷️ <b>${escapeHtml(resultado.grupo)}</b>: ${resultado.total} licitações\n`;
    }

    textoEnviar += `\n✅ Acesse o sistema para detalhes`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramConfig.chatId,
      text: textoEnviar,
      parse_mode: 'HTML'
    })
  });

  const result = await response.json();

  if (!result.ok) {
    console.error('[JORNAL] Erro Telegram:', result.description);
    throw new Error(`Telegram: ${result.description}`);
  }

  return true;
}

async function executarJornal(db) {
  console.log('[JORNAL] Iniciando execução do jornal...');

  try {
    const config = db.prepare('SELECT * FROM jornal_config WHERE id = 1').get();

    if (!config.ativo) {
      console.log('[JORNAL] Jornal está desativado');
      return { status: 'desativado' };
    }

    // Gerar conteúdo
    const conteudo = await gerarConteudoJornal(db);

    if (conteudo.totalLicitacoes === 0) {
      console.log('[JORNAL] Nenhuma licitação encontrada');

      // Registrar no histórico
      db.prepare(`
        INSERT INTO jornal_historico (totalLicitacoes, gruposProcessados, status, mensagem)
        VALUES (0, ?, 'vazio', 'Nenhuma licitação encontrada no período')
      `).run(JSON.stringify(conteudo.grupos.map(g => g.grupo)));

      return { status: 'vazio', totalLicitacoes: 0 };
    }

    // Enviar no Telegram
    if (config.enviarTelegram) {
      await enviarTelegramJornal(db, conteudo);
      console.log('[JORNAL] Enviado para o Telegram com sucesso');
    }

    // Atualizar data de último envio
    db.prepare('UPDATE jornal_config SET dataUltimoEnvio = CURRENT_TIMESTAMP WHERE id = 1').run();

    // Registrar no histórico
    db.prepare(`
      INSERT INTO jornal_historico (totalLicitacoes, gruposProcessados, status, mensagem)
      VALUES (?, ?, 'sucesso', 'Jornal enviado com sucesso')
    `).run(conteudo.totalLicitacoes, JSON.stringify(conteudo.grupos.map(g => g.grupo)));

    console.log(`[JORNAL] Concluído! ${conteudo.totalLicitacoes} licitações em ${conteudo.grupos.length} grupos`);

    return {
      status: 'sucesso',
      totalLicitacoes: conteudo.totalLicitacoes,
      grupos: conteudo.grupos.length
    };

  } catch (error) {
    console.error('[JORNAL] Erro:', error.message);

    // Registrar erro no histórico
    db.prepare(`
      INSERT INTO jornal_historico (totalLicitacoes, status, mensagem)
      VALUES (0, 'erro', ?)
    `).run(error.message);

    throw error;
  }
}

function agendarJornal(db) {
  // NFSE-M06 onda 5A: schedulers rodam só no master. POST /api/jornal/config
  // no worker ainda chama agendarJornal() por compat — logamos e saímos.
  // Próximo disparo do master já lê config fresh via executarJornal.
  const role = process.env.ROLE || 'master';
  if (role !== 'master') {
    console.log('[JORNAL] agendarJornal() ignorado em role=worker — master reagenda no próximo ciclo.');
    return;
  }

  // Limpar agendamento anterior
  if (_jornalTimeout) {
    clearTimeout(_jornalTimeout);
    _jornalTimeout = null;
  }

  const config = db.prepare('SELECT ativo, horario FROM jornal_config WHERE id = 1').get();

  if (!config || !config.ativo) {
    console.log('[JORNAL] Agendamento desativado');
    return;
  }

  const [hora, minuto] = (config.horario || '08:00').split(':').map(Number);

  // Calcular próxima execução
  const agora = new Date();
  const proxima = new Date();
  proxima.setHours(hora, minuto, 0, 0);

  // Se já passou do horário hoje, agendar para amanhã
  if (proxima <= agora) {
    proxima.setDate(proxima.getDate() + 1);
  }

  const msAteProxima = proxima.getTime() - agora.getTime();

  console.log(`[JORNAL] Próximo envio agendado para ${proxima.toLocaleString('pt-BR')}`);

  _jornalTimeout = setTimeout(async () => {
    try {
      await executarJornal(db);
    } catch (e) {
      console.error('[JORNAL] Erro na execução agendada:', e && e.message);
    }
    // Reagendar para o próximo dia
    agendarJornal(db);
  }, msAteProxima);
}

function pararJornal() {
  if (_jornalTimeout) {
    clearTimeout(_jornalTimeout);
    _jornalTimeout = null;
  }
}

module.exports = {
  agendarJornal,
  executarJornal,
  gerarConteudoJornal,
  pararJornal,
};
