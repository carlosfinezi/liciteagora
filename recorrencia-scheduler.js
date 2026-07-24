/**
 * recorrencia-scheduler.js — Agendador de recorrencias NFSe (dia 1 de cada mes, 08:00 BRT)
 */

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

async function executarRecorrencias(db) {
  const competencia = dataBrasilia().substring(0, 7); // YYYY-MM

  const recorrencias = db.prepare(`
    SELECT r.*, p.cpfCnpj, p.razaoSocial, p.inscricaoMunicipal, p.email, p.emailsAdicionais,
      p.endereco, p.numero, p.complemento, p.bairro, p.codigoMunicipio, p.uf, p.cep
    FROM nfse_recorrencias r
    JOIN pessoas p ON p.id = r.pessoaId
    WHERE r.ativo = 1
  `).all();

  console.log(`[Recorrencia] ${recorrencias.length} recorrencias ativas para ${competencia}`);

  for (const rec of recorrencias) {
    try {
      await executarUmaRecorrencia(db, rec, competencia);
    } catch (err) {
      console.error(`[Recorrencia] Erro recorrencia #${rec.id}:`, err.message);
    }
  }
}

async function executarUmaRecorrencia(db, rec, competencia) {
  // Verificar duplicata — so bloqueia se ja teve sucesso
  const jaExiste = db.prepare(
    'SELECT id, status FROM nfse_recorrencias_log WHERE recorrenciaId = ? AND competencia = ?'
  ).get(rec.id, competencia);

  if (jaExiste && jaExiste.status === 'sucesso') {
    console.log(`[Recorrencia] #${rec.id} ja emitida com sucesso para ${competencia}, pulando`);
    return jaExiste;
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
    // Calcular data vencimento boleto
    const [ano, mes] = competencia.split('-').map(Number);
    const diaVenc = rec.diaVencimentoBoleto || 10;
    const dataVencBoleto = `${ano}-${String(mes).padStart(2, '0')}-${String(diaVenc).padStart(2, '0')}`;

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

module.exports = { agendarRecorrencias, executarRecorrencias, executarUmaRecorrencia };
