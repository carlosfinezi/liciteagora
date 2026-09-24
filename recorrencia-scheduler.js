/**
 * recorrencia-scheduler.js — Agendador de recorrencias NFSe (dia 1 de cada mes, 08:00 BRT)
 */

const crypto = require('crypto');
const { emitirNfseInterno, carregarCertificado, dataBrasilia } = require('./nfse-routes');
const { NfseClient } = require('./nfse-client');
const { enviarEmailNfse, loadSmtpConfig } = require('./email-client');

// Multi-tenant: um timeout por instância de db. Antes era um único `let`
// global, o que fazia cada chamada de agendarRecorrencias(db) cancelar o
// agendamento do tenant anterior — só o último tenant ficava agendado.
const recorrenciaTimeouts = new Map();

function agendarRecorrencias(db) {
  const existing = recorrenciaTimeouts.get(db);
  if (existing) {
    clearTimeout(existing);
    recorrenciaTimeouts.delete(db);
  }

  // Proximo 08:00 BRT (UTC-3 = 11:00 UTC)
  const agora = new Date();
  const proxima = new Date();
  proxima.setUTCHours(11, 0, 0, 0); // 08:00 BRT

  if (proxima <= agora) {
    proxima.setDate(proxima.getDate() + 1);
  }

  const msAteProxima = proxima.getTime() - agora.getTime();
  const brt = new Date(proxima.getTime() - 3 * 60 * 60 * 1000);
  console.log(`[Recorrencia] Proximo check: ${brt.toISOString().replace('T', ' ').substring(0, 19)} BRT`);

  const timer = setTimeout(async () => {
    // Verificar se e dia 1
    const hojeBrt = dataBrasilia(); // YYYY-MM-DD
    const dia = parseInt(hojeBrt.substring(8, 10), 10);

    if (dia === 1) {
      console.log(`[Recorrencia] Dia 1 detectado — executando recorrencias...`);
      await executarRecorrencias(db);
    } else {
      console.log(`[Recorrencia] Dia ${dia} — nada a fazer`);
    }

    // Reagendar
    agendarRecorrencias(db);
  }, msAteProxima);
  recorrenciaTimeouts.set(db, timer);
}

// ==================== EXECUÇÃO EM LOTE ====================
//
// Uma execução em lote por tenant, venha ela do botão (server.js) ou do
// agendador do dia 1 (scheduler.js). São PROCESSOS diferentes, então a trava
// não pode morar em memória: fica no banco do tenant, na chave
// `recorrencias_lote` da tabela config, junto com o andamento que a tela lê.
//
// Uma execução que morre no meio (restart, crash) deixaria a trava presa para
// sempre. Por isso ela vence: sem avançar por LOTE_TRAVA_VENCE_MS, outra pode
// assumir. Cada recorrência leva segundos (SEFIN, mais o DANFSE com até 3
// tentativas), então 15 minutos parados só acontecem sem ninguém rodando.
const CHAVE_LOTE = 'recorrencias_lote';
const LOTE_TRAVA_VENCE_MS = 15 * 60 * 1000;

const SQL_RECORRENCIAS_ATIVAS = `
    SELECT r.*, p.cpfCnpj, p.razaoSocial, p.inscricaoMunicipal, p.email, p.emailsAdicionais,
      p.endereco, p.numero, p.complemento, p.bairro, p.codigoMunicipio, p.uf, p.cep
    FROM nfse_recorrencias r
    JOIN pessoas p ON p.id = r.pessoaId
    WHERE r.ativo = 1
    ORDER BY r.id`;

function lerEstadoLote(db) {
  const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(CHAVE_LOTE);
  if (!row) return null;
  try { return JSON.parse(row.valor); } catch { return null; }
}

function gravarEstadoLote(db, estado) {
  db.prepare(`INSERT INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, dataAtualizacao = CURRENT_TIMESTAMP`)
    .run(CHAVE_LOTE, JSON.stringify(estado));
}

function loteEmAndamento(estado, agora = Date.now()) {
  return !!estado && estado.status === 'rodando'
    && agora - Date.parse(estado.atualizadoEm) < LOTE_TRAVA_VENCE_MS;
}

// Reserva a execução do tenant. Devolve { ocupado: false, estado } com o estado
// inicial, ou { ocupado: true, estado } com o de quem já está rodando. A
// transação é IMMEDIATE para que dois pedidos simultâneos não leiam os dois a
// trava livre.
function iniciarLote(db, origem) {
  return db.transaction(() => {
    const atual = lerEstadoLote(db);
    if (loteEmAndamento(atual)) return { ocupado: true, estado: atual };
    const agora = new Date().toISOString();
    const estado = {
      id: crypto.randomUUID(), status: 'rodando', origem,
      competencia: dataBrasilia().substring(0, 7),
      total: db.prepare('SELECT COUNT(*) AS n FROM nfse_recorrencias WHERE ativo = 1').get().n,
      processadas: 0, sucesso: 0, jaEmitidas: 0, falha: 0,
      iniciadoEm: agora, atualizadoEm: agora, concluidoEm: null,
    };
    if (atual && atual.status === 'rodando') {
      console.warn(`[Recorrencia] trava de lote vencida (${atual.origem}, ${atual.processadas}/${atual.total}, parada desde ${atual.atualizadoEm}) — assumindo`);
    }
    gravarEstadoLote(db, estado);
    return { ocupado: false, estado };
  }).immediate();
}

// Processa as recorrências ativas com a trava já reservada por iniciarLote,
// gravando o andamento a cada uma. A gravação só acontece se a trava ainda for
// desta execução, conferida na mesma transação: se outra a assumiu por
// vencimento, esta para em vez de emitir em dobro com ela, e sem sobrescrever
// o andamento da outra (o que faria a outra se achar a perdedora e parar).
async function processarLote(db, estado) {
  const recorrencias = db.prepare(SQL_RECORRENCIAS_ATIVAS).all();
  estado.total = recorrencias.length;
  const salvar = () => db.transaction(() => {
    const vigente = lerEstadoLote(db);
    if (!vigente || vigente.id !== estado.id) return false;
    estado.atualizadoEm = new Date().toISOString();
    gravarEstadoLote(db, estado);
    return true;
  }).immediate();
  const perdeuTrava = () => {
    console.warn(`[Recorrencia] lote ${estado.id} perdeu a trava em ${estado.processadas}/${estado.total} — parando`);
    return estado;
  };
  if (!salvar()) return perdeuTrava();
  console.log(`[Recorrencia] lote ${estado.origem}: ${recorrencias.length} recorrencias ativas para ${estado.competencia}`);

  try {
    for (const rec of recorrencias) {
      try {
        const r = await executarUmaRecorrencia(db, rec, estado.competencia);
        if (r && r.jaEmitida) estado.jaEmitidas++;
        else if (r && r.status === 'sucesso') estado.sucesso++;
        else estado.falha++;
      } catch (err) {
        estado.falha++;
        console.error(`[Recorrencia] Erro recorrencia #${rec.id}:`, err.message);
      }
      estado.processadas++;
      if (!salvar()) return perdeuTrava();
    }
    estado.status = 'concluido';
  } catch (err) {
    estado.status = 'erro';
    estado.erro = err.message;
    console.error(`[Recorrencia] lote ${estado.id} interrompido:`, err.message);
  }
  estado.concluidoEm = new Date().toISOString();
  if (!salvar()) return perdeuTrava();
  console.log(`[Recorrencia] lote ${estado.origem} ${estado.competencia}: ${estado.sucesso} emitidas, ${estado.jaEmitidas} ja emitidas, ${estado.falha} com falha`);
  return estado;
}

// Execução completa, aguardando o fim: é o que o agendador do dia 1 chama.
// Com outra execução em andamento (o botão), não inicia outra.
async function executarRecorrencias(db, { origem = 'agendador' } = {}) {
  const r = iniciarLote(db, origem);
  if (r.ocupado) {
    console.log(`[Recorrencia] ja existe execucao em lote em andamento (${r.estado.origem}, ${r.estado.processadas}/${r.estado.total}) — ${origem} nao inicia outra`);
    return { ocupado: true, estado: r.estado };
  }
  return processarLote(db, r.estado);
}

// Vencimento da conta de uma competência: o dia de vencimento dentro do mês da
// competência, e se esse dia já passou na data da execução, o mesmo dia do mês
// seguinte. Sem isso, executar depois do dia fazia a conta nascer vencida. Dia
// maior que o mês (31 em setembro) cai no último dia, em vez de gerar uma data
// que não existe.
function vencimentoDaCompetencia(competencia, dia, hoje) {
  const [ano, mes] = competencia.split('-').map(Number);
  const noMes = (a, m) => {
    const y = a + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    const ultimo = new Date(Date.UTC(y, mm, 0)).getUTCDate();
    return `${y}-${String(mm).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
  };
  const venc = noMes(ano, mes);
  return venc < hoje ? noMes(ano, mes + 1) : venc;
}

// Uma emissão 'processando' mais nova que isto é de outra execução viva.
const PROCESSANDO_VIVO_MIN = 15;

async function executarUmaRecorrencia(db, rec, competencia) {
  // Verificar duplicata — so bloqueia se ja teve sucesso
  const jaExiste = db.prepare(
    `SELECT id, status, dataCriacao >= datetime('now', ?) AS recente
       FROM nfse_recorrencias_log WHERE recorrenciaId = ? AND competencia = ?`
  ).get(`-${PROCESSANDO_VIVO_MIN} minutes`, rec.id, competencia);

  if (jaExiste && jaExiste.status === 'sucesso') {
    console.log(`[Recorrencia] #${rec.id} ja emitida com sucesso para ${competencia}, pulando`);
    return { id: jaExiste.id, status: jaExiste.status, jaEmitida: true };
  }

  // 'processando' recente é outra execução emitindo esta mesma recorrência
  // agora (o ▶ da linha durante o lote, por exemplo). Apagar o log dela e
  // emitir de novo, como se faz com 'erro', emitiria a nota em dobro.
  if (jaExiste && jaExiste.status === 'processando' && jaExiste.recente) {
    throw new Error(`Recorrencia #${rec.id} ja esta sendo emitida para ${competencia} por outra execucao`);
  }

  // Se existia com erro, remove para re-tentar
  if (jaExiste) {
    db.prepare('DELETE FROM nfse_recorrencias_log WHERE id = ?').run(jaExiste.id);
    console.log(`[Recorrencia] #${rec.id} removendo log #${jaExiste.id} (${jaExiste.status}) para re-tentar`);
  }

  // Inserir log processando
  const logId = db.prepare(`
    INSERT INTO nfse_recorrencias_log (recorrenciaId, competencia, status)
    VALUES (?, ?, 'processando')
  `).run(rec.id, competencia).lastInsertRowid;

  try {
    const dataVencBoleto = vencimentoDaCompetencia(competencia, rec.diaVencimentoBoleto || 10, dataBrasilia());

    // Montar tomador a partir da pessoa
    const tomador = {
      cpfCnpj: rec.cpfCnpj,
      razaoSocial: rec.razaoSocial,
      inscricaoMunicipal: rec.inscricaoMunicipal,
      email: rec.email,
      endereco: rec.endereco ? {
        logradouro: rec.endereco,
        numero: rec.numero,
        complemento: rec.complemento,
        bairro: rec.bairro,
        codigoMunicipio: rec.codigoMunicipio,
        uf: rec.uf,
        cep: rec.cep,
      } : null,
    };

    const servico = {
      codigoTributacaoNacional: rec.codigoTributacaoNacional,
      codigoListaServico: rec.codigoListaServico || '001',
      descricao: rec.descricao,
      valorServico: rec.valorServico,
      valorDeducoes: rec.valorDeducoes,
      aliquota: rec.aliquota,
      codigoMunicipioPrestacao: rec.codigoMunicipioPrestacao,
    };

    // Emitir NFSe
    const resultado = await emitirNfseInterno(db, {
      tomador,
      servico,
      competencia: dataBrasilia(),
      incluirIM: rec.incluirIM === 1,
      opSimpNac: rec.opSimpNac,
      regEspTrib: rec.regEspTrib,
      pTotTribSN: rec.pTotTribSN,
      gerarBoleto: rec.gerarBoleto === 1,
      dataVencimentoBoleto: dataVencBoleto,
      // Quem decide o e-mail é a caixa "Enviar por e-mail" da recorrência, e o
      // envio é o daqui de baixo (nota + boleto). Deixar a emissão mandar o
      // dela também fazia o cliente receber dois, ou um com a caixa desmarcada.
      enviarEmailTomador: false,
    });

    if (!resultado.success) {
      db.prepare('UPDATE nfse_recorrencias_log SET status = ?, erro = ? WHERE id = ?')
        .run('erro', resultado.error, logId);
      console.error(`[Recorrencia] #${rec.id} erro: ${resultado.error}`);
      return { logId, status: 'erro' };
    }

    // Atualizar log com IDs
    db.prepare(`UPDATE nfse_recorrencias_log SET nfseId = ?, contaReceberId = ?, boletoId = ? WHERE id = ?`)
      .run(
        resultado.nfse?.id || null,
        resultado.conta?.id || null,
        resultado.boleto?.id || null,
        logId
      );

    // Enviar email se configurado
    let emailStatus = 'nao';
    if (rec.enviarEmail === 1 && rec.email) {
      try {
        const smtpCfg = loadSmtpConfig(db);
        if (!smtpCfg) {
          emailStatus = 'erro';
        } else {
          // Tentar baixar DANFSE (3 tentativas, 5s intervalo)
          let pdfBuffer = null;
          if (resultado.nfse?.chaveAcesso) {
            const { p12Buffer, senha } = carregarCertificado(db);
            const nfseClient = new NfseClient(p12Buffer, senha, parseInt(db.prepare("SELECT value FROM nfse_config WHERE key = 'ambiente'").get()?.value || '2', 10));

            for (let tentativa = 0; tentativa < 3; tentativa++) {
              try {
                pdfBuffer = await nfseClient.downloadDanfse(resultado.nfse.chaveAcesso);
                break;
              } catch (pdfErr) {
                console.log(`[Recorrencia] DANFSE tentativa ${tentativa + 1}/3 falhou: ${pdfErr.message}`);
                if (tentativa < 2) await new Promise(r => setTimeout(r, 5000));
              }
            }
          }

          if (!pdfBuffer && resultado.nfse?.chaveAcesso) {
            emailStatus = 'pdf_indisponivel';
          }

          // Buscar dados do boleto
          let boletoWritableLine = null;
          let boletoUrl = null;
          if (resultado.boleto?.id) {
            const boleto = db.prepare('SELECT writableLine, externalUrl FROM boletos WHERE id = ?').get(resultado.boleto.id);
            boletoWritableLine = boleto?.writableLine || null;
            boletoUrl = boleto?.externalUrl || null;
          }

          const ccList = rec.emailsAdicionais
            ? rec.emailsAdicionais.split(',').map(e => e.trim()).filter(Boolean)
            : [];

          await enviarEmailNfse(db, {
            to: rec.email,
            cc: ccList.length ? ccList.join(', ') : undefined,
            nfseNumero: resultado.nfse?.nNFSe || resultado.nfse?.idDps || '',
            descricao: rec.descricao,
            valor: rec.valorServico,
            competencia: competencia,
            pdfBuffer,
            boletoWritableLine,
            boletoUrl,
            origemTipo: resultado.nfse?.id ? 'nfse' : undefined,
            origemId: resultado.nfse?.id || undefined,
          });

          emailStatus = pdfBuffer ? 'sim' : 'pdf_indisponivel';
        }
      } catch (emailErr) {
        console.error(`[Recorrencia] Erro email #${rec.id}:`, emailErr.message);
        emailStatus = 'erro';
      }
    }

    db.prepare('UPDATE nfse_recorrencias_log SET status = ?, emailEnviado = ? WHERE id = ?')
      .run('sucesso', emailStatus, logId);

    console.log(`[Recorrencia] #${rec.id} concluida: NFSe=${resultado.nfse?.nNFSe || 'N/A'}, email=${emailStatus}`);
    return { logId, status: 'sucesso', emailStatus };
  } catch (err) {
    db.prepare('UPDATE nfse_recorrencias_log SET status = ?, erro = ? WHERE id = ?')
      .run('erro', err.message, logId);
    throw err;
  }
}

module.exports = {
  agendarRecorrencias, executarRecorrencias, executarUmaRecorrencia,
  iniciarLote, processarLote, lerEstadoLote, loteEmAndamento, vencimentoDaCompetencia,
  LOTE_TRAVA_VENCE_MS,
};
