/**
 * email-client.js — Envio de emails via SMTP (nodemailer)
 */

const nodemailer = require('nodemailer');

/**
 * Cria tabela email_log se nao existir
 */
function migrarEmailLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT NOT NULL DEFAULT 'nfse',
    destinatario TEXT NOT NULL,
    assunto TEXT,
    nfseNumero TEXT,
    descricao TEXT,
    valor REAL,
    competencia TEXT,
    temPdf INTEGER DEFAULT 0,
    temBoleto INTEGER DEFAULT 0,
    messageId TEXT,
    status TEXT NOT NULL DEFAULT 'enviado',
    erro TEXT,
    dataEnvio TEXT DEFAULT (datetime('now'))
  )`);
}

/**
 * Registra envio no email_log
 */
function registrarLog(db, dados) {
  try {
    migrarEmailLog(db);
    db.prepare(`INSERT INTO email_log (tipo, destinatario, assunto, nfseNumero, descricao, valor, competencia, temPdf, temBoleto, messageId, status, erro)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(dados.tipo || 'nfse', dados.to, dados.subject, dados.nfseNumero || null,
        dados.descricao || null, dados.valor || null, dados.competencia || null,
        dados.temPdf ? 1 : 0, dados.temBoleto ? 1 : 0,
        dados.messageId || null, dados.status || 'enviado', dados.erro || null);
  } catch (err) {
    console.error('[Email Log] Erro ao registrar:', err.message);
  }
}

/**
 * Carrega config SMTP do banco
 */
function loadSmtpConfig(db) {
  const rows = db.prepare('SELECT key, value FROM smtp_config').all();
  if (!rows.length) return null;

  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;

  if (!cfg.host || !cfg.user) return null;

  return {
    host: cfg.host,
    port: parseInt(cfg.port || '587', 10),
    secure: cfg.secure === '1',
    user: cfg.user,
    pass: cfg.pass || '',
    fromName: cfg.fromName || '',
    fromEmail: cfg.fromEmail || cfg.user,
  };
}

function criarTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: false },
  });
}

/**
 * Envia email com DANFSE PDF + info do boleto
 */
async function enviarEmailNfse(db, { to, subject, nfseNumero, descricao, valor, competencia, pdfBuffer, boletoWritableLine, boletoUrl }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  const transport = criarTransport(cfg);

  const valorFmt = Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const compFmt = competencia ? competencia.substring(0, 7) : '';

  let boletoHtml = '';
  if (boletoWritableLine) {
    boletoHtml = `
      <tr><td colspan="2" style="padding:15px 0 5px 0;font-weight:bold;color:#333;border-top:1px solid #eee;">Dados do Boleto</td></tr>
      <tr><td style="padding:4px 10px;color:#666;">Linha Digitavel</td><td style="padding:4px 10px;font-family:monospace;font-size:13px;">${boletoWritableLine}</td></tr>
      ${boletoUrl ? `<tr><td style="padding:4px 10px;color:#666;">Boleto PDF</td><td style="padding:4px 10px;"><a href="${boletoUrl}" style="color:#4dabf7;font-weight:bold;">Clique aqui para visualizar/imprimir o boleto</a></td></tr>` : ''}
    `;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">Nota Fiscal de Servico</h2>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #ddd;">
        <p>Prezado(a),</p>
        <p>Segue em anexo a Nota Fiscal de Servico Eletronica (NFSe).</p>
        <table style="width:100%;border-collapse:collapse;margin:15px 0;">
          <tr><td style="padding:4px 10px;color:#666;width:140px;">NFSe</td><td style="padding:4px 10px;font-weight:bold;">${nfseNumero}</td></tr>
          <tr><td style="padding:4px 10px;color:#666;">Competencia</td><td style="padding:4px 10px;">${compFmt}</td></tr>
          <tr><td style="padding:4px 10px;color:#666;">Descricao</td><td style="padding:4px 10px;">${descricao}</td></tr>
          <tr><td style="padding:4px 10px;color:#666;">Valor</td><td style="padding:4px 10px;font-weight:bold;">${valorFmt}</td></tr>
          ${boletoHtml}
        </table>
      </div>
      <div style="background:#f5f5f5;padding:10px;text-align:center;font-size:12px;color:#999;border-radius:0 0 8px 8px;">
        Email enviado automaticamente. Nao responda este email.
      </div>
    </div>
  `;

  const attachments = [];
  if (pdfBuffer) {
    attachments.push({
      filename: `DANFSE_${nfseNumero}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    });
  }

  const finalSubject = subject || `NFSe ${nfseNumero} - ${compFmt}`;
  try {
    const info = await transport.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to,
      subject: finalSubject,
      html,
      attachments,
    });

    registrarLog(db, {
      tipo: nfseNumero ? 'nfse' : 'boleto', to, subject: finalSubject,
      nfseNumero, descricao, valor, competencia,
      temPdf: !!pdfBuffer, temBoleto: !!boletoWritableLine,
      messageId: info.messageId, status: 'enviado',
    });

    console.log(`[Email] NFSe ${nfseNumero} enviada para ${to} (messageId: ${info.messageId})`);
  } catch (err) {
    registrarLog(db, {
      tipo: nfseNumero ? 'nfse' : 'boleto', to, subject: finalSubject,
      nfseNumero, descricao, valor, competencia,
      temPdf: !!pdfBuffer, temBoleto: !!boletoWritableLine,
      status: 'erro', erro: err.message,
    });
    throw err;
  }
}

/**
 * Envia email de teste para verificar config SMTP
 */
async function enviarEmailTeste(db, toEmail) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  const transport = criarTransport(cfg);

  await transport.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
    to: toEmail,
    subject: 'Teste SMTP - Licite Agora',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:20px;">
        <h3 style="color:#4dabf7;">Teste de Email</h3>
        <p>Se voce recebeu este email, a configuracao SMTP esta funcionando corretamente.</p>
        <p style="color:#888;font-size:12px;">Enviado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
      </div>
    `,
  });

  console.log(`[Email] Teste enviado para ${toEmail}`);
}

/**
 * Envia email de cobrança com dados do boleto (sem NFSe)
 */
async function enviarEmailBoleto(db, { to, descricao, valor, vencimento, clienteNome, boletoWritableLine, boletoUrl }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  const transport = criarTransport(cfg);

  const valorFmt = Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const vencFmt = vencimento ? vencimento.split('-').reverse().join('/') : '';

  let boletoHtml = '';
  if (boletoWritableLine) {
    boletoHtml = `
      <tr><td style="padding:8px 10px;color:#666;">Linha Digitável</td><td style="padding:8px 10px;font-family:monospace;font-size:13px;word-break:break-all;">${boletoWritableLine}</td></tr>`;
  }
  if (boletoUrl) {
    boletoHtml += `
      <tr><td style="padding:8px 10px;color:#666;">Boleto</td><td style="padding:8px 10px;"><a href="${boletoUrl}" style="color:#fff;background:#4dabf7;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Visualizar / Imprimir Boleto</a></td></tr>`;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">Cobrança</h2>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #ddd;">
        <p>Prezado(a) ${clienteNome || ''},</p>
        <p>Segue abaixo os dados para pagamento:</p>
        <table style="width:100%;border-collapse:collapse;margin:15px 0;">
          <tr><td style="padding:8px 10px;color:#666;width:140px;">Descrição</td><td style="padding:8px 10px;">${descricao}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Valor</td><td style="padding:8px 10px;font-weight:bold;font-size:16px;">${valorFmt}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Vencimento</td><td style="padding:8px 10px;">${vencFmt}</td></tr>
          ${boletoHtml}
        </table>
      </div>
      <div style="background:#f5f5f5;padding:10px;text-align:center;font-size:12px;color:#999;border-radius:0 0 8px 8px;">
        Email enviado automaticamente.
      </div>
    </div>
  `;

  const subject = `Cobrança - ${descricao} - ${valorFmt}`;
  try {
    const info = await transport.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to,
      subject,
      html,
    });

    registrarLog(db, {
      tipo: 'boleto', to, subject,
      descricao, valor, competencia: vencimento,
      temBoleto: !!boletoWritableLine,
      messageId: info.messageId, status: 'enviado',
    });

    console.log(`[Email] Boleto enviado para ${to} (messageId: ${info.messageId})`);
    return info;
  } catch (err) {
    registrarLog(db, {
      tipo: 'boleto', to, subject,
      descricao, valor, competencia: vencimento,
      temBoleto: !!boletoWritableLine,
      status: 'erro', erro: err.message,
    });
    throw err;
  }
}

module.exports = { loadSmtpConfig, enviarEmailNfse, enviarEmailBoleto, enviarEmailTeste };
