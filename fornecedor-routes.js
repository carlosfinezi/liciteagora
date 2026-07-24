// fornecedor-routes.js
//
// Rotas HTTP de Dados do Fornecedor (a empresa dona do sistema). Extraído
// de server.js em NFSE-M06 onda 6.9.
//
// CRUD singleton (id=1) sobre a tabela `fornecedor`: GET devolve o registro
// inteiro (ou null), POST faz UPSERT manual — SELECT id para decidir entre
// UPDATE e INSERT, sem INSERT OR REPLACE.
//
// IMPORTANTE: `codigoMunicipio` é gravado num UPDATE separado pós-UPSERT,
// embrulhado em try/catch silencioso. Isso mantém o comportamento original
// do monolito: a coluna foi adicionada por migração do módulo NF-e em outra
// onda, e nem todas as instâncias têm essa coluna. Falhar silenciosamente
// aqui (com `catch {}`) garante compat com bancos legados onde a migração
// ainda não rodou. Mantido 1:1.

function registrarRotasFornecedor(app, db) {
  // Buscar dados do fornecedor
  app.get('/api/fornecedor', (req, res) => {
    try {
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      res.json({ success: true, data: fornecedor || null });
    } catch (error) {
      console.error('Erro ao buscar fornecedor:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar dados do fornecedor
  app.post('/api/fornecedor', (req, res) => {
    try {
      const {
        razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
        endereco, numero, complemento, bairro, cidade, uf, cep, codigoMunicipio,
        telefone, celular, email, site,
        representanteLegal, cpfRepresentante, cargoRepresentante,
        banco, agencia, conta, tipoConta,
        logoBase64, observacoes,
        declaracaoMeEpp, declaracaoProgramasIntegridade, declaracaoEquidadeGenero,
        regimeTributario, contribuinteIPI, regimeApuracaoPISCOFINS
      } = req.body;

      // Verificar se já existe registro
      const existe = db.prepare('SELECT id FROM fornecedor WHERE id = 1').get();

      if (existe) {
        // Atualizar
        db.prepare(`
          UPDATE fornecedor SET
            razaoSocial = ?, nomeFantasia = ?, cnpj = ?, inscricaoEstadual = ?, inscricaoMunicipal = ?,
            endereco = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, cep = ?,
            telefone = ?, celular = ?, email = ?, site = ?,
            representanteLegal = ?, cpfRepresentante = ?, cargoRepresentante = ?,
            banco = ?, agencia = ?, conta = ?, tipoConta = ?,
            logoBase64 = ?, observacoes = ?,
            declaracaoMeEpp = ?, declaracaoProgramasIntegridade = ?, declaracaoEquidadeGenero = ?,
            dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = 1
        `).run(
          razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
          endereco, numero, complemento, bairro, cidade, uf, cep,
          telefone, celular, email, site,
          representanteLegal, cpfRepresentante, cargoRepresentante,
          banco, agencia, conta, tipoConta,
          logoBase64, observacoes,
          declaracaoMeEpp ? 1 : 0, declaracaoProgramasIntegridade ? 1 : 0, declaracaoEquidadeGenero ? 1 : 0
        );
      } else {
        // Inserir
        db.prepare(`
          INSERT INTO fornecedor (
            id, razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
            endereco, numero, complemento, bairro, cidade, uf, cep,
            telefone, celular, email, site,
            representanteLegal, cpfRepresentante, cargoRepresentante,
            banco, agencia, conta, tipoConta,
            logoBase64, observacoes,
            declaracaoMeEpp, declaracaoProgramasIntegridade, declaracaoEquidadeGenero
          ) VALUES (
            1, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?,
            ?, ?, ?
          )
        `).run(
          razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
          endereco, numero, complemento, bairro, cidade, uf, cep,
          telefone, celular, email, site,
          representanteLegal, cpfRepresentante, cargoRepresentante,
          banco, agencia, conta, tipoConta,
          logoBase64, observacoes,
          declaracaoMeEpp ? 1 : 0, declaracaoProgramasIntegridade ? 1 : 0, declaracaoEquidadeGenero ? 1 : 0
        );
      }

      // Grava codigoMunicipio separadamente (coluna adicionada pela migração NF-e)
      try {
        if (codigoMunicipio != null) {
          db.prepare('UPDATE fornecedor SET codigoMunicipio = ? WHERE id = 1').run(codigoMunicipio);
        }
      } catch {}

      // regimeTributario (coluna adicionada pela migração NFSe; ignora se não existir)
      try {
        if (regimeTributario !== undefined) {
          const norm = ['MEI', 'SIMPLES_NACIONAL', 'NAO_OPTANTE'].includes(regimeTributario)
            ? regimeTributario : null;
          db.prepare('UPDATE fornecedor SET regimeTributario = ? WHERE id = 1').run(norm);
        }
      } catch {}

      // Configuração fiscal extra (composição de custo de aquisição).
      try {
        if (contribuinteIPI !== undefined) {
          // Aceita 0/1 numérico, true/false e strings "0"/"1"/"true"/"false".
          const flag = (contribuinteIPI === 1 || contribuinteIPI === '1' ||
                        contribuinteIPI === true || contribuinteIPI === 'true') ? 1 : 0;
          db.prepare('UPDATE fornecedor SET contribuinteIPI = ? WHERE id = 1').run(flag);
        }
        if (regimeApuracaoPISCOFINS !== undefined) {
          const norm = ['cumulativo', 'nao_cumulativo'].includes(regimeApuracaoPISCOFINS)
            ? regimeApuracaoPISCOFINS : null;
          db.prepare('UPDATE fornecedor SET regimeApuracaoPISCOFINS = ? WHERE id = 1').run(norm);
        }
      } catch {}

      // Auto-cadastro de palavras-chave personalizadas (raiz do CNPJ + início da razão social)
      // Idempotente via INSERT OR IGNORE. Não remove palavras antigas se o fornecedor mudar —
      // o usuário pode limpá-las manualmente na tela de palavras-chave.
      try {
        const personalizadas = [];
        if (cnpj) {
          const d = String(cnpj).replace(/\D/g, '');
          if (d.length >= 8) {
            personalizadas.push(`${d.substring(0,2)}.${d.substring(2,5)}.${d.substring(5,8)}`.toLowerCase());
          }
        }
        if (razaoSocial) {
          const tokens = String(razaoSocial).trim().split(/\s+/).slice(0, 2);
          const inicio = tokens.join(' ').toLowerCase();
          if (inicio.length >= 2) personalizadas.push(inicio);
        }
        const stmt = db.prepare('INSERT OR IGNORE INTO chat_palavras_chave (palavra) VALUES (?)');
        for (const p of personalizadas) { try { stmt.run(p); } catch (_) {} }
      } catch (err) {
        console.warn('[Fornecedor] Falha ao auto-cadastrar palavras-chave:', err.message);
      }

      res.json({ success: true, message: 'Dados do fornecedor salvos com sucesso' });
    } catch (error) {
      console.error('Erro ao salvar fornecedor:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Fornecedor] Rotas registradas');
}

module.exports = { registrarRotasFornecedor };
