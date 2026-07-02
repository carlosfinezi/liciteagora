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
  // EMAIL-01 (2026-04-18): validar certificado TLS. Para servidores SMTP locais com
  // certificado auto-assinado, setar SMTP_ALLOW_SELF_SIGNED=1 no systemd (não padrão).
  const allowSelfSigned = process.env.SMTP_ALLOW_SELF_SIGNED === '1';
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    requireTLS: !cfg.secure, // STARTTLS em 587
    tls: { rejectUnauthorized: !allowSelfSigned, minVersion: 'TLSv1.2' },
  });
}

/**
 * Envia email com DANFSE PDF + info do boleto
 */
async function enviarEmailNfse(db, { to, cc, subject, nfseNumero, descricao, valor, competencia, pdfBuffer, boletoWritableLine, boletoUrl }) {
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
    const mailOpts = {
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to,
      subject: finalSubject,
      html,
      attachments,
    };
    if (cc) mailOpts.cc = cc;

    const info = await transport.sendMail(mailOpts);

    registrarLog(db, {
      tipo: nfseNumero ? 'nfse' : 'boleto', to: cc ? `${to}, ${cc}` : to, subject: finalSubject,
      nfseNumero, descricao, valor, competencia,
      temPdf: !!pdfBuffer, temBoleto: !!boletoWritableLine,
      messageId: info.messageId, status: 'enviado',
    });

    console.log(`[Email] NFSe ${nfseNumero} enviada para ${to}${cc ? ' cc:' + cc : ''} (messageId: ${info.messageId})`);
  } catch (err) {
    registrarLog(db, {
      tipo: nfseNumero ? 'nfse' : 'boleto', to: cc ? `${to}, ${cc}` : to, subject: finalSubject,
      nfseNumero, descricao, valor, competencia,
      temPdf: !!pdfBuffer, temBoleto: !!boletoWritableLine,
      status: 'erro', erro: err.message,
    });
    throw err;
  }
}

/**
 * Envia a NF-e de produto (DANFE PDF + XML) ao destinatário.
 * SEFAZ obriga o emitente a disponibilizar o XML ao destinatário.
 */
async function enviarEmailNfe(db, { to, cc, numero, chave, valor, danfePdf, xmlBuffer, clienteNome }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  const transport = criarTransport(cfg);
  const valorFmt = Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">Nota Fiscal Eletronica (NF-e)</h2>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #ddd;">
        <p>Prezado(a)${clienteNome ? ' ' + clienteNome : ''},</p>
        <p>Seguem em anexo o DANFE (PDF) e o XML da Nota Fiscal Eletronica.</p>
        <table style="width:100%;border-collapse:collapse;margin:15px 0;">
          <tr><td style="padding:4px 10px;color:#666;width:140px;">NF-e</td><td style="padding:4px 10px;font-weight:bold;">${numero || ''}</td></tr>
          ${chave ? `<tr><td style="padding:4px 10px;color:#666;">Chave de acesso</td><td style="padding:4px 10px;font-family:monospace;font-size:12px;">${chave}</td></tr>` : ''}
          <tr><td style="padding:4px 10px;color:#666;">Valor</td><td style="padding:4px 10px;font-weight:bold;">${valorFmt}</td></tr>
        </table>
      </div>
      <div style="background:#f5f5f5;padding:10px;text-align:center;font-size:12px;color:#999;border-radius:0 0 8px 8px;">
        Email enviado automaticamente. Nao responda este email.
      </div>
    </div>
  `;

  const attachments = [];
  if (danfePdf) attachments.push({ filename: `DANFE-${numero}.pdf`, content: danfePdf, contentType: 'application/pdf' });
  if (xmlBuffer) attachments.push({ filename: `${chave || numero}.xml`, content: xmlBuffer, contentType: 'application/xml' });

  const finalSubject = `NF-e ${numero || ''} - ${cfg.fromName || ''}`.trim();
  try {
    const mailOpts = { from: `"${cfg.fromName}" <${cfg.fromEmail}>`, to, subject: finalSubject, html, attachments };
    if (cc) mailOpts.cc = cc;
    const info = await transport.sendMail(mailOpts);
    registrarLog(db, {
      tipo: 'nfe', to: cc ? `${to}, ${cc}` : to, subject: finalSubject,
      nfseNumero: numero, descricao: chave, valor, temPdf: !!danfePdf, temBoleto: false,
      messageId: info.messageId, status: 'enviado',
    });
    console.log(`[Email] NF-e ${numero} enviada para ${to}${cc ? ' cc:' + cc : ''} (messageId: ${info.messageId})`);
    return info;
  } catch (err) {
    registrarLog(db, {
      tipo: 'nfe', to, subject: finalSubject, nfseNumero: numero, descricao: chave, valor,
      temPdf: !!danfePdf, temBoleto: false, status: 'erro', erro: err.message,
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

/**
 * Envia cobrança via PIX: QR dinâmico (imagem inline) + copia-e-cola + link de pagamento.
 */
async function enviarEmailPix(db, { to, cc, descricao, valor, vencimento, clienteNome, pixPayload, pixQrImage, pixUrl }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');
  const transport = criarTransport(cfg);
  const valorFmt = Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const vencFmt = vencimento ? String(vencimento).split('-').reverse().join('/') : '';

  const attachments = [];
  let qrHtml = '';
  if (pixQrImage) {
    attachments.push({ filename: 'pix-qrcode.png', content: Buffer.from(pixQrImage, 'base64'), cid: 'pixqr', contentType: 'image/png' });
    qrHtml = `<tr><td style="padding:8px 10px;color:#666;">QR Code</td><td style="padding:8px 10px;"><img src="cid:pixqr" alt="QR Code PIX" style="width:180px;height:180px;"></td></tr>`;
  }
  const copiaHtml = pixPayload
    ? `<tr><td style="padding:8px 10px;color:#666;">PIX Copia e Cola</td><td style="padding:8px 10px;font-family:monospace;font-size:12px;word-break:break-all;background:#f5f5f5;border-radius:6px;">${pixPayload}</td></tr>`
    : '';
  const linkHtml = pixUrl
    ? `<tr><td style="padding:8px 10px;color:#666;">Pagar</td><td style="padding:8px 10px;"><a href="${pixUrl}" style="color:#fff;background:#00b894;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Abrir link de pagamento</a></td></tr>`
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">Cobrança via PIX</h2>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #ddd;">
        <p>Prezado(a) ${clienteNome || ''},</p>
        <p>Pague com PIX escaneando o QR Code, copiando o código, ou pelo link:</p>
        <table style="width:100%;border-collapse:collapse;margin:15px 0;">
          <tr><td style="padding:8px 10px;color:#666;width:140px;">Descrição</td><td style="padding:8px 10px;">${descricao || ''}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Valor</td><td style="padding:8px 10px;font-weight:bold;font-size:16px;">${valorFmt}</td></tr>
          ${vencFmt ? `<tr><td style="padding:8px 10px;color:#666;">Vencimento</td><td style="padding:8px 10px;">${vencFmt}</td></tr>` : ''}
          ${qrHtml}
          ${copiaHtml}
          ${linkHtml}
        </table>
      </div>
      <div style="background:#f5f5f5;padding:10px;text-align:center;font-size:12px;color:#999;border-radius:0 0 8px 8px;">
        Email enviado automaticamente.
      </div>
    </div>
  `;

  const subject = `Cobrança PIX - ${descricao || ''} - ${valorFmt}`;
  const mailOpts = { from: `"${cfg.fromName}" <${cfg.fromEmail}>`, to, subject, html, attachments };
  if (cc) mailOpts.cc = cc;
  try {
    const info = await transport.sendMail(mailOpts);
    registrarLog(db, { tipo: 'pix', to: cc ? `${to}, ${cc}` : to, subject, descricao, valor, competencia: vencimento, temBoleto: !!pixPayload, messageId: info.messageId, status: 'enviado' });
    console.log(`[Email] PIX enviado para ${to} (messageId: ${info.messageId})`);
    return info;
  } catch (err) {
    registrarLog(db, { tipo: 'pix', to, subject, descricao, valor, competencia: vencimento, temBoleto: !!pixPayload, status: 'erro', erro: err.message });
    throw err;
  }
}

/**
 * Envia email de cancelamento de NFSe
 */
async function enviarEmailCancelamento(db, { to, cc, nfseNumero, descricao, valor, competencia, motivo }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  const transport = criarTransport(cfg);

  const valorFmt = Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const compFmt = competencia ? competencia.substring(0, 7) : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#c92020;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">Cancelamento de Nota Fiscal</h2>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #ddd;">
        <p>Prezado(a),</p>
        <p>Informamos que a Nota Fiscal de Servico Eletronica (NFSe) abaixo foi <strong style="color:#c92020;">cancelada</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:15px 0;">
          <tr><td style="padding:8px 10px;color:#666;width:140px;">NFSe</td><td style="padding:8px 10px;font-weight:bold;">${nfseNumero}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Competencia</td><td style="padding:8px 10px;">${compFmt}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Descricao</td><td style="padding:8px 10px;">${descricao}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Valor</td><td style="padding:8px 10px;font-weight:bold;">${valorFmt}</td></tr>
          <tr><td style="padding:8px 10px;color:#666;">Motivo</td><td style="padding:8px 10px;color:#c92020;font-weight:bold;">${motivo}</td></tr>
        </table>
        <p style="color:#666;font-size:0.9em;">Caso tenha sido gerado boleto referente a esta nota, desconsidere-o.</p>
      </div>
      <div style="background:#f5f5f5;padding:10px;text-align:center;font-size:12px;color:#999;border-radius:0 0 8px 8px;">
        Email enviado automaticamente. Nao responda este email.
      </div>
    </div>
  `;

  const subject = `CANCELAMENTO NFSe ${nfseNumero} - ${compFmt}`;
  try {
    const mailOpts = {
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to,
      subject,
      html,
    };
    if (cc) mailOpts.cc = cc;

    const info = await transport.sendMail(mailOpts);

    registrarLog(db, {
      tipo: 'cancelamento', to: cc ? `${to}, ${cc}` : to, subject,
      nfseNumero, descricao, valor, competencia,
      messageId: info.messageId, status: 'enviado',
    });

    console.log(`[Email] Cancelamento NFSe ${nfseNumero} enviado para ${to}${cc ? ' cc:' + cc : ''} (messageId: ${info.messageId})`);
  } catch (err) {
    registrarLog(db, {
      tipo: 'cancelamento', to: cc ? `${to}, ${cc}` : to, subject,
      nfseNumero, descricao, valor, competencia,
      status: 'erro', erro: err.message,
    });
    throw err;
  }
}

/**
 * Envia email de cobranca customizado (com assunto e corpo livre).
 * Usa o tipo 'cobranca' no email_log.
 */
async function enviarEmailCobranca(db, { to, cc, assunto, texto, valor, boletoWritableLine, boletoUrl }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  const transport = criarTransport(cfg);

  const textoHtml = String(texto || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  let boletoHtml = '';
  if (boletoWritableLine || boletoUrl) {
    boletoHtml = `
      <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#f5f5f5;border-radius:6px;">
        <tr><td colspan="2" style="padding:12px 15px;font-weight:bold;color:#333;border-bottom:1px solid #ddd;">Dados do Boleto</td></tr>
        ${boletoWritableLine ? `<tr><td style="padding:8px 15px;color:#666;width:140px;">Linha Digitável</td><td style="padding:8px 15px;font-family:monospace;font-size:13px;word-break:break-all;">${boletoWritableLine}</td></tr>` : ''}
        ${boletoUrl ? `<tr><td style="padding:8px 15px;color:#666;">Boleto</td><td style="padding:8px 15px;"><a href="${boletoUrl}" style="color:#fff;background:#4dabf7;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Visualizar / Imprimir Boleto</a></td></tr>` : ''}
      </table>
    `;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1a1a2e;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;">Aviso de Cobrança</h2>
      </div>
      <div style="background:#fff;padding:25px;border:1px solid #ddd;line-height:1.6;color:#333;">
        ${textoHtml}
        ${boletoHtml}
      </div>
      <div style="background:#f5f5f5;padding:10px;text-align:center;font-size:12px;color:#999;border-radius:0 0 8px 8px;">
        Em caso de dúvidas, entre em contato. Se o pagamento já foi realizado, desconsidere este e-mail.
      </div>
    </div>
  `;

  const finalAssunto = assunto || 'Aviso de cobrança';
  try {
    const mailOpts = {
      from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
      to, subject: finalAssunto, html,
    };
    if (cc) mailOpts.cc = cc;

    const info = await transport.sendMail(mailOpts);
    registrarLog(db, {
      tipo: 'cobranca', to: cc ? `${to}, ${cc}` : to, subject: finalAssunto,
      valor, temBoleto: !!boletoWritableLine,
      messageId: info.messageId, status: 'enviado',
    });
    console.log(`[Email] Cobranca enviada para ${to} (messageId: ${info.messageId})`);
    return info;
  } catch (err) {
    registrarLog(db, {
      tipo: 'cobranca', to: cc ? `${to}, ${cc}` : to, subject: finalAssunto,
      valor, temBoleto: !!boletoWritableLine,
      status: 'erro', erro: err.message,
    });
    throw err;
  }
}

/**
 * Email genérico pra alertas (token inválido, disputa sem blitz, digest, etc.).
 * Recebe HTML pronto (mesmo body usado no Telegram), gera versão texto plana
 * pelo strip de tags, e envia pros destinatários configurados.
 */
async function enviarEmailAlerta(db, { subject, htmlBody, to }) {
  const cfg = loadSmtpConfig(db);
  if (!cfg) throw new Error('SMTP nao configurado');

  let destinatarios = to;
  if (Array.isArray(destinatarios)) destinatarios = destinatarios.join(', ');
  if (!destinatarios || !String(destinatarios).trim()) throw new Error('Sem destinatário(s) de email');

  const transport = criarTransport(cfg);
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail;

  // Plain text: strip de tags + normaliza \n
  const text = String(htmlBody || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  // HTML pronto pra email: troca \n por <br> só fora dos tags existentes
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.5;white-space:pre-wrap;">${htmlBody}</div>`;

  const info = await transport.sendMail({ from, to: destinatarios, subject, html, text });
  registrarLog(db, { tipo: 'alerta', destinatario: destinatarios, assunto: subject, status: 'enviado', messageId: info.messageId });
  return info;
}

module.exports = { loadSmtpConfig, enviarEmailNfse, enviarEmailNfe, enviarEmailBoleto, enviarEmailPix, enviarEmailCobranca, enviarEmailCancelamento, enviarEmailTeste, enviarEmailAlerta };
