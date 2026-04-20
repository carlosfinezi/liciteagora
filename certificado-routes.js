// certificado-routes.js
//
// Rotas HTTP para gestão do Certificado Digital A1 da empresa (PKCS#12 .pfx).
// Extraído de server.js em NFSE-M06 onda 6.7.
//
// Bloco é puramente CRUD sobre a tabela `certificado_digital` (id=1,
// singleton): GET status (sem retornar o base64), POST salva+valida, DELETE
// remove. A validação do .pfx usa node-forge para extrair CN (titular) e
// notAfter (validade), rejeita certificados expirados e senhas erradas.
//
// IMPORTANTE: a senha é "criptografada" com Buffer.toString('base64') — isto
// é obfuscação, não criptografia real (a chave para decifrar está no próprio
// processo). Foi assim no monolito original, mantido 1:1. Endurecer a
// proteção de senha é uma onda de segurança separada — não é escopo aqui.

const forge = require('node-forge');

function registrarRotasCertificado(app, db) {
  // Verificar status do certificado
  app.get('/api/certificado/status', (req, res) => {
    try {
      const cert = db.prepare('SELECT titular, validade FROM certificado_digital WHERE id = 1').get();

      if (cert) {
        res.json({
          success: true,
          configurado: true,
          titular: cert.titular,
          validade: cert.validade
        });
      } else {
        res.json({ success: true, configurado: false });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar certificado
  app.post('/api/certificado', (req, res) => {
    try {
      const { certificado, senha } = req.body;

      if (!certificado || !senha) {
        return res.status(400).json({ success: false, error: 'Certificado e senha são obrigatórios' });
      }

      // Converter base64 para buffer e validar o certificado
      const p12Buffer = Buffer.from(certificado, 'base64');
      const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, senha);

      // Extrair informações do certificado
      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const certBag = certBags[forge.pki.oids.certBag][0];
      const certificate = certBag.cert;

      // Pegar o titular (CN do subject)
      const cnAttr = certificate.subject.getField('CN');
      const titular = cnAttr ? cnAttr.value : 'Não identificado';

      // Pegar a validade
      const validade = certificate.validity.notAfter.toLocaleDateString('pt-BR');

      // Verificar se o certificado não expirou
      if (new Date() > certificate.validity.notAfter) {
        return res.status(400).json({ success: false, error: 'Certificado expirado!' });
      }

      // Criptografar a senha antes de salvar (simples, pode ser melhorado)
      const senhaCripto = Buffer.from(senha).toString('base64');

      // Verificar se já existe registro
      const existe = db.prepare('SELECT id FROM certificado_digital WHERE id = 1').get();

      if (existe) {
        db.prepare(`
          UPDATE certificado_digital SET
            certificadoBase64 = ?, senhaCriptografada = ?, titular = ?, validade = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = 1
        `).run(certificado, senhaCripto, titular, validade);
      } else {
        db.prepare(`
          INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada, titular, validade)
          VALUES (1, ?, ?, ?, ?)
        `).run(certificado, senhaCripto, titular, validade);
      }

      res.json({ success: true, message: 'Certificado salvo com sucesso', titular, validade });
    } catch (error) {
      console.error('Erro ao salvar certificado:', error.message);
      if (error.message.includes('Invalid password') || error.message.includes('PKCS#12')) {
        return res.status(400).json({ success: false, error: 'Senha incorreta ou certificado inválido' });
      }
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover certificado
  app.delete('/api/certificado', (req, res) => {
    try {
      db.prepare('DELETE FROM certificado_digital WHERE id = 1').run();
      res.json({ success: true, message: 'Certificado removido' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Certificado] Rotas registradas');
}

module.exports = { registrarRotasCertificado };
