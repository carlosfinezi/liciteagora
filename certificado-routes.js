// certificado-routes.js
//
// Rotas HTTP para gestão do Certificado Digital A1 da empresa (PKCS#12 .pfx).
// Extraído de server.js em NFSE-M06 onda 6.7.
//
// Multi-loja (Fase 1): o CRUD opera sobre o ESTABELECIMENTO ATIVO da sessão.
//   - Matriz → linha legada id=1 (que todo o emitente fiscal lê hoje via
//     WHERE id=1). Comportamento single-CNPJ inalterado; só carimbamos o
//     estabelecimentoId nela.
//   - Filial → linha própria (estabelecimentoId = filial.id).
// A validação do .pfx usa node-forge para extrair CN (titular) e notAfter
// (validade), rejeita certificados expirados e senhas erradas.
//
// IMPORTANTE: a senha é "criptografada" com Buffer.toString('base64') — isto
// é obfuscação, não criptografia real (a chave para decifrar está no próprio
// processo). Foi assim no monolito original, mantido 1:1. Endurecer a
// proteção de senha é uma onda de segurança separada — não é escopo aqui.

const forge = require('node-forge');
const { getEstabelecimentoAtivo } = require('./estabelecimentos-routes');

// Determina como localizar/gravar o certificado do estabelecimento ativo.
// Matriz (ou ausência de estabelecimento) usa a linha legada id=1; filial usa
// a própria linha via estabelecimentoId.
function alvoCertificado(db, req) {
  const estab = getEstabelecimentoAtivo(db, req);
  const usarLegado = !estab || !!estab.matriz;
  return {
    estab,
    estabId: estab ? estab.id : null,
    buscar: (cols) => usarLegado
      ? db.prepare(`SELECT ${cols} FROM certificado_digital WHERE id = 1`).get()
      : db.prepare(`SELECT ${cols} FROM certificado_digital WHERE estabelecimentoId = ?`).get(estab.id),
    usarLegado
  };
}

function registrarRotasCertificado(app, db) {
  // Verificar status do certificado (do estabelecimento ativo)
  app.get('/api/certificado/status', (req, res) => {
    try {
      const alvo = alvoCertificado(db, req);
      const cert = alvo.buscar('titular, validade');
      const nomeEstab = alvo.estab ? (alvo.estab.nomeFantasia || alvo.estab.razaoSocial || null) : null;

      if (cert) {
        res.json({
          success: true,
          configurado: true,
          titular: cert.titular,
          validade: cert.validade,
          estabelecimento: nomeEstab
        });
      } else {
        res.json({ success: true, configurado: false, estabelecimento: nomeEstab });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar certificado (do estabelecimento ativo)
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

      const alvo = alvoCertificado(db, req);
      if (alvo.usarLegado) {
        // Matriz: linha id=1 (lida pelo emitente fiscal). Carimba estabelecimentoId.
        const existe = db.prepare('SELECT id FROM certificado_digital WHERE id = 1').get();
        if (existe) {
          db.prepare(`
            UPDATE certificado_digital SET
              certificadoBase64 = ?, senhaCriptografada = ?, titular = ?, validade = ?,
              estabelecimentoId = ?, dataAtualizacao = CURRENT_TIMESTAMP
            WHERE id = 1
          `).run(certificado, senhaCripto, titular, validade, alvo.estabId);
        } else {
          db.prepare(`
            INSERT INTO certificado_digital (id, certificadoBase64, senhaCriptografada, titular, validade, estabelecimentoId)
            VALUES (1, ?, ?, ?, ?, ?)
          `).run(certificado, senhaCripto, titular, validade, alvo.estabId);
        }
      } else {
        // Filial: linha própria via estabelecimentoId.
        const existe = db.prepare('SELECT id FROM certificado_digital WHERE estabelecimentoId = ?').get(alvo.estabId);
        if (existe) {
          db.prepare(`
            UPDATE certificado_digital SET
              certificadoBase64 = ?, senhaCriptografada = ?, titular = ?, validade = ?, dataAtualizacao = CURRENT_TIMESTAMP
            WHERE estabelecimentoId = ?
          `).run(certificado, senhaCripto, titular, validade, alvo.estabId);
        } else {
          db.prepare(`
            INSERT INTO certificado_digital (certificadoBase64, senhaCriptografada, titular, validade, estabelecimentoId)
            VALUES (?, ?, ?, ?, ?)
          `).run(certificado, senhaCripto, titular, validade, alvo.estabId);
        }
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

  // Remover certificado (do estabelecimento ativo)
  app.delete('/api/certificado', (req, res) => {
    try {
      const alvo = alvoCertificado(db, req);
      if (alvo.usarLegado) {
        db.prepare('DELETE FROM certificado_digital WHERE id = 1').run();
      } else {
        db.prepare('DELETE FROM certificado_digital WHERE estabelecimentoId = ?').run(alvo.estabId);
      }
      res.json({ success: true, message: 'Certificado removido' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Certificado] Rotas registradas');
}

module.exports = { registrarRotasCertificado };
