// estabelecimentos-routes.js
//
// CRUD de Estabelecimentos (matriz + filiais) — Fase 1 do multi-loja.
// A tabela `estabelecimentos` é criada e backfillada (matriz a partir do
// fornecedor singleton) em db-schema.js. Aqui fica só a camada HTTP.
//
// Sincronização com `fornecedor`: a matriz (matriz=1) espelha seus campos de
// identidade fiscal na tabela `fornecedor` (id=1), que continua sendo a fonte
// consumida por TODO o código fiscal/certidões atual. Assim editar a matriz
// aqui mantém o sistema legado funcionando 1:1. Filiais (matriz=0) ainda não
// são consumidas pelo código fiscal — isso chega nas Fases 2/3.
//
// Espelha o padrão de fornecedor-routes.js: registrador (app, db) que usa
// db.prepare direto (o db é resolvido por tenant via AsyncLocalStorage).

const TIPOS = ['MATRIZ', 'FILIAL_MESMA_PJ', 'PJ_DISTINTA'];

const soDigitos = (v) => (v == null ? null : (String(v).replace(/\D/g, '') || null));
const normRegime = (v) => (['MEI', 'SIMPLES_NACIONAL', 'NAO_OPTANTE'].includes(v) ? v : null);
const normPisCofins = (v) => (['cumulativo', 'nao_cumulativo'].includes(v) ? v : null);
const flag = (v) => (v === 1 || v === '1' || v === true || v === 'true') ? 1 : 0;

// Normaliza o corpo da requisição nos campos de identidade fiscal do estabelecimento.
function montarPayload(body) {
  return {
    razaoSocial: body.razaoSocial ?? null,
    nomeFantasia: body.nomeFantasia ?? null,
    cnpj: soDigitos(body.cnpj),
    inscricaoEstadual: body.inscricaoEstadual ?? null,
    inscricaoMunicipal: body.inscricaoMunicipal ?? null,
    regimeTributario: normRegime(body.regimeTributario),
    contribuinteIPI: flag(body.contribuinteIPI),
    regimeApuracaoPISCOFINS: normPisCofins(body.regimeApuracaoPISCOFINS),
    endereco: body.endereco ?? null,
    numero: body.numero ?? null,
    complemento: body.complemento ?? null,
    bairro: body.bairro ?? null,
    cidade: body.cidade ?? null,
    uf: body.uf ? String(body.uf).trim().toUpperCase().slice(0, 2) : null,
    cep: soDigitos(body.cep),
    codigoMunicipio: body.codigoMunicipio ?? null,
    telefone: body.telefone ?? null,
    celular: body.celular ?? null,
    email: body.email ?? null,
    csc: body.csc ?? null,
    cscId: body.cscId ?? null
  };
}

// Espelha os campos compartilhados da matriz na tabela fornecedor (id=1),
// mantendo o código fiscal legado consistente. As colunas fiscais adicionadas
// por migração (codigoMunicipio, regimeTributario...) vão em UPDATEs tolerantes.
function sincronizarMatrizParaFornecedor(db, p) {
  const existe = db.prepare('SELECT id FROM fornecedor WHERE id = 1').get();
  if (existe) {
    db.prepare(`UPDATE fornecedor SET
      razaoSocial=@razaoSocial, nomeFantasia=@nomeFantasia, cnpj=@cnpj,
      inscricaoEstadual=@inscricaoEstadual, inscricaoMunicipal=@inscricaoMunicipal,
      endereco=@endereco, numero=@numero, complemento=@complemento, bairro=@bairro,
      cidade=@cidade, uf=@uf, cep=@cep, telefone=@telefone, celular=@celular, email=@email,
      dataAtualizacao=CURRENT_TIMESTAMP
      WHERE id=1`).run(p);
  } else {
    db.prepare(`INSERT INTO fornecedor
      (id, razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
       endereco, numero, complemento, bairro, cidade, uf, cep, telefone, celular, email)
      VALUES (1, @razaoSocial, @nomeFantasia, @cnpj, @inscricaoEstadual, @inscricaoMunicipal,
       @endereco, @numero, @complemento, @bairro, @cidade, @uf, @cep, @telefone, @celular, @email)`).run(p);
  }
  try { db.prepare('UPDATE fornecedor SET codigoMunicipio=? WHERE id=1').run(p.codigoMunicipio ?? null); } catch {}
  try { db.prepare('UPDATE fornecedor SET regimeTributario=? WHERE id=1').run(p.regimeTributario ?? null); } catch {}
  try { db.prepare('UPDATE fornecedor SET contribuinteIPI=? WHERE id=1').run(p.contribuinteIPI ?? 0); } catch {}
  try { db.prepare('UPDATE fornecedor SET regimeApuracaoPISCOFINS=? WHERE id=1').run(p.regimeApuracaoPISCOFINS ?? null); } catch {}
}

// Resolve o estabelecimento ATIVO da sessão do request. É o ponto que as Fases
// 2/3 (fiscal, licitação, financeiro) vão consumir para saber qual CNPJ opera.
// Regra: se a sessão tem um estabelecimento selecionado que continua ativo e
// contratado (não bloqueado), usa esse; caso contrário cai para a matriz.
// Sempre devolve uma linha válida (a matriz âncora sempre existe).
function getEstabelecimentoAtivo(db, req) {
  // RBAC (Fase 4.3): usuário restrito a uma loja SEMPRE opera nela — ignora a
  // seleção de sessão e NUNCA cai na matriz. Este é o ponto único onde o escopo
  // do usuário é aplicado; como fiscal/certidões/financeiro/estoque derivam daqui,
  // a restrição se propaga por todo o sistema.
  const escopo = req && req.user ? req.user.estabelecimentoId : null;
  if (escopo) {
    return db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(escopo) || null;
  }
  const sid = req && req.session ? req.session.estabelecimentoId : null;
  if (sid) {
    const row = db.prepare('SELECT * FROM estabelecimentos WHERE id = ? AND ativo = 1 AND bloqueado = 0').get(sid);
    if (row) return row;
  }
  return db.prepare('SELECT * FROM estabelecimentos WHERE matriz = 1').get()
      || db.prepare('SELECT * FROM estabelecimentos WHERE ativo = 1 ORDER BY id LIMIT 1').get()
      || null;
}

// Escopo de estabelecimento do usuário logado (NULL = acesso total).
function escopoUsuario(req) {
  return req && req.user ? (req.user.estabelecimentoId || null) : null;
}

/* ==================== RBAC DE ESTABELECIMENTO (Fase 4.3) ====================
 *
 * Regra única do sistema: usuário preso a uma unidade não vê registro EXCLUSIVO
 * de outra unidade. Registro sem vínculo (estabelecimentoId NULL) é da empresa
 * toda — continua visível para todos. Sem essa segunda metade o escopo viraria
 * prisão: hoje quase todo registro é NULL, e cortá-los deixaria o usuário
 * restrito sem nada.
 *
 * Os dados financeiros carregam a dimensão de três formas, e há um helper para
 * cada uma:
 *   - coluna própria (contas_a_pagar, contas_a_receber, faturas) → escopoSql
 *   - herdada de um pai (boleto → conta financeira, DDA → conta a pagar) → escopoSqlHerdado
 *   - por id na URL, em qualquer rota do módulo → guardEscopo
 */

// Filtro para tabela que tem a coluna. `col` aceita alias ('cr.estabelecimentoId').
function escopoSql(req, col = 'estabelecimentoId') {
  const escopo = escopoUsuario(req);
  if (!escopo) return { sql: '', params: [] };
  return { sql: ` AND (${col} = ? OR ${col} IS NULL)`, params: [escopo] };
}

// Filtro para tabela que herda a unidade de um pai via chave estrangeira.
// FK nula = registro solto, visível (mesma lógica do NULL acima).
function escopoSqlHerdado(req, fk, tabelaPai) {
  const escopo = escopoUsuario(req);
  if (!escopo) return { sql: '', params: [] };
  return {
    sql: ` AND (${fk} IS NULL OR ${fk} IN (SELECT id FROM ${tabelaPai} WHERE estabelecimentoId = ? OR estabelecimentoId IS NULL))`,
    params: [escopo],
  };
}

// Um registro específico está no escopo de quem pediu?
function noEscopo(req, estabelecimentoIdDoRegistro) {
  const escopo = escopoUsuario(req);
  return !escopo || !estabelecimentoIdDoRegistro || estabelecimentoIdDoRegistro === escopo;
}

/**
 * Middleware que barra acesso por id fora do escopo — cobre de uma vez todas as
 * rotas `/:id` de um módulo (inclusive as que ainda não existem), em vez de
 * espalhar a checagem por dezenas de handlers.
 *
 * Registrar ANTES das rotas: app.use('/api/contas-a-receber/:id', guardEscopo(db, 'contas_a_receber'))
 *
 * `opts.fk` + `opts.pai` para tabela que herda a unidade (ex.: { fk: 'contaFinanceiraId', pai: 'contas_financeiras' }).
 *
 * Id não numérico passa direto: é rota literal ('resumo', 'csv', 'anexos'), não registro.
 */
function guardEscopo(db, tabela, opts = {}) {
  const { fk = null, pai = null } = opts;
  return (req, res, next) => {
    try {
      const escopo = escopoUsuario(req);
      if (!escopo) return next();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return next();
      const row = fk
        ? db.prepare(`SELECT p.estabelecimentoId AS e FROM ${tabela} t LEFT JOIN ${pai} p ON p.id = t.${fk} WHERE t.id = ?`).get(id)
        : db.prepare(`SELECT estabelecimentoId AS e FROM ${tabela} WHERE id = ?`).get(id);
      // Registro inexistente segue adiante: o 404 é da rota, não do escopo.
      if (row && row.e && row.e !== escopo) {
        return res.status(404).json({ success: false, error: 'Registro nao encontrado' });
      }
      return next();
    } catch (_) {
      return next(); // tabela ainda não migrada: não é hora de derrubar a requisição
    }
  };
}

function registrarRotasEstabelecimentos(app, db) {
  // Lista os estabelecimentos. Usuário restrito vê só o seu (RBAC).
  app.get('/api/estabelecimentos', (req, res) => {
    try {
      const escopo = escopoUsuario(req);
      const rows = escopo
        ? db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').all(escopo)
        : db.prepare('SELECT * FROM estabelecimentos ORDER BY matriz DESC, id ASC').all();
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Erro ao listar estabelecimentos:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Estabelecimento ativo da sessão (com fallback para a matriz)
  app.get('/api/estabelecimento-ativo', (req, res) => {
    try {
      res.json({ success: true, data: getEstabelecimentoAtivo(db, req) });
    } catch (error) {
      console.error('Erro ao obter estabelecimento ativo:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Troca o estabelecimento ativo da sessão. Só permite ativos e contratados.
  app.post('/api/estabelecimento-ativo', (req, res) => {
    try {
      // RBAC: usuário restrito não pode trocar para fora do seu estabelecimento.
      const escopo = escopoUsuario(req);
      if (escopo && Number(req.body.id) !== Number(escopo)) {
        return res.status(403).json({ success: false, error: 'Sem acesso a este estabelecimento' });
      }
      const row = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(req.body.id);
      if (!row) return res.status(404).json({ success: false, error: 'Estabelecimento não encontrado' });
      if (!row.ativo) return res.status(400).json({ success: false, error: 'Estabelecimento inativo' });
      if (row.bloqueado) return res.status(400).json({ success: false, error: 'Estabelecimento ainda não contratado' });
      if (req.session) req.session.estabelecimentoId = row.id;
      res.json({ success: true, data: row });
    } catch (error) {
      console.error('Erro ao trocar estabelecimento ativo:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Um por id
  app.get('/api/estabelecimentos/:id', (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ success: false, error: 'Estabelecimento não encontrado' });
      res.json({ success: true, data: row });
    } catch (error) {
      console.error('Erro ao buscar estabelecimento:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Cria filial. A matriz nunca é criada aqui (só pelo backfill / Minha Empresa),
  // então força matriz=0. Nasce bloqueada até a contratação do CNPJ (decisão de produto).
  app.post('/api/estabelecimentos', (req, res) => {
    try {
      if (escopoUsuario(req)) return res.status(403).json({ success: false, error: 'Sem permissão para gerenciar estabelecimentos' });
      const tipo = (TIPOS.includes(req.body.tipo_vinculo) && req.body.tipo_vinculo !== 'MATRIZ')
        ? req.body.tipo_vinculo : 'FILIAL_MESMA_PJ';
      const p = montarPayload(req.body);
      const info = db.prepare(`INSERT INTO estabelecimentos
        (matriz, tipo_vinculo, ativo, bloqueado,
         razaoSocial, nomeFantasia, cnpj, inscricaoEstadual, inscricaoMunicipal,
         regimeTributario, contribuinteIPI, regimeApuracaoPISCOFINS,
         endereco, numero, complemento, bairro, cidade, uf, cep, codigoMunicipio,
         telefone, celular, email, csc, cscId)
        VALUES (0, @tipo_vinculo, 1, 1,
         @razaoSocial, @nomeFantasia, @cnpj, @inscricaoEstadual, @inscricaoMunicipal,
         @regimeTributario, @contribuinteIPI, @regimeApuracaoPISCOFINS,
         @endereco, @numero, @complemento, @bairro, @cidade, @uf, @cep, @codigoMunicipio,
         @telefone, @celular, @email, @csc, @cscId)`).run({ ...p, tipo_vinculo: tipo });
      res.json({ success: true, id: info.lastInsertRowid, message: 'Filial cadastrada. Nasce bloqueada até a contratação do CNPJ.' });
    } catch (error) {
      console.error('Erro ao criar estabelecimento:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Atualiza matriz ou filial. Ao salvar a matriz, sincroniza para `fornecedor`.
  app.put('/api/estabelecimentos/:id', (req, res) => {
    try {
      if (escopoUsuario(req)) return res.status(403).json({ success: false, error: 'Sem permissão para gerenciar estabelecimentos' });
      const atual = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Estabelecimento não encontrado' });
      const p = montarPayload(req.body);

      // A matriz é sempre 'MATRIZ'; filiais podem alternar entre os dois tipos de vínculo.
      let tipo = atual.tipo_vinculo;
      if (!atual.matriz && TIPOS.includes(req.body.tipo_vinculo) && req.body.tipo_vinculo !== 'MATRIZ') {
        tipo = req.body.tipo_vinculo;
      }

      db.prepare(`UPDATE estabelecimentos SET
        tipo_vinculo=@tipo_vinculo,
        razaoSocial=@razaoSocial, nomeFantasia=@nomeFantasia, cnpj=@cnpj,
        inscricaoEstadual=@inscricaoEstadual, inscricaoMunicipal=@inscricaoMunicipal,
        regimeTributario=@regimeTributario, contribuinteIPI=@contribuinteIPI,
        regimeApuracaoPISCOFINS=@regimeApuracaoPISCOFINS,
        endereco=@endereco, numero=@numero, complemento=@complemento, bairro=@bairro,
        cidade=@cidade, uf=@uf, cep=@cep, codigoMunicipio=@codigoMunicipio,
        telefone=@telefone, celular=@celular, email=@email, csc=@csc, cscId=@cscId,
        dataAtualizacao=CURRENT_TIMESTAMP
        WHERE id=@id`).run({ ...p, tipo_vinculo: tipo, id: atual.id });

      if (atual.matriz) sincronizarMatrizParaFornecedor(db, p);
      res.json({ success: true, message: 'Estabelecimento atualizado.' });
    } catch (error) {
      console.error('Erro ao atualizar estabelecimento:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Ativa/desativa e contrata (desbloqueia) uma filial. A matriz é intocável aqui.
  app.patch('/api/estabelecimentos/:id/status', (req, res) => {
    try {
      if (escopoUsuario(req)) return res.status(403).json({ success: false, error: 'Sem permissão para gerenciar estabelecimentos' });
      const atual = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Estabelecimento não encontrado' });
      if (atual.matriz) return res.status(400).json({ success: false, error: 'A matriz não pode ser desativada ou bloqueada.' });

      const sets = [];
      const vals = { id: atual.id };
      if (req.body.ativo !== undefined) { sets.push('ativo=@ativo'); vals.ativo = flag(req.body.ativo); }
      if (req.body.bloqueado !== undefined) {
        sets.push('bloqueado=@bloqueado');
        vals.bloqueado = flag(req.body.bloqueado);
        // Contratar = desbloquear: carimba contratadoEm na primeira vez.
        if (!vals.bloqueado && !atual.contratadoEm) sets.push('contratadoEm=CURRENT_TIMESTAMP');
      }
      if (!sets.length) return res.json({ success: true, message: 'Nada a alterar.' });

      db.prepare(`UPDATE estabelecimentos SET ${sets.join(', ')}, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=@id`).run(vals);
      res.json({ success: true, message: 'Status atualizado.' });
    } catch (error) {
      console.error('Erro ao alterar status do estabelecimento:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---- Configuração de emissão da FILIAL (Fiscal > Configuração de emissão) ----
  // A matriz continua em nfe_config/nfce_config/nfse_config (rotas próprias de
  // cada documento). A filial guarda série e numeração em estabelecimento_serie,
  // que até aqui só era escrita pela emissão — não havia como corrigir uma
  // numeração de filial pela interface.
  const MODELOS_SERIE = ['55', '65', 'NFSE'];

  app.get('/api/estabelecimentos/:id/emissao', (req, res) => {
    try {
      const estab = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(req.params.id);
      if (!estab) return res.status(404).json({ success: false, error: 'Estabelecimento não encontrado' });
      const escopo = escopoUsuario(req);
      if (escopo && Number(escopo) !== estab.id) {
        return res.status(403).json({ success: false, error: 'Sem permissão para este estabelecimento' });
      }

      const series = {};
      for (const modelo of MODELOS_SERIE) {
        const row = db.prepare(
          'SELECT serie, proximoNumero FROM estabelecimento_serie WHERE estabelecimentoId = ? AND modelo = ? ORDER BY serie LIMIT 1'
        ).get(estab.id, modelo);
        // Sem linha ainda: a emissão cria com 1/1. Mostrar o mesmo default evita
        // a tela dizer "vazio" e a nota sair com número 1 sem aviso.
        series[modelo] = { serie: row ? row.serie : 1, proximoNumero: row ? row.proximoNumero : 1, gravado: !!row };
      }

      res.json({
        success: true,
        estabelecimento: { id: estab.id, matriz: estab.matriz, razaoSocial: estab.razaoSocial, cnpj: estab.cnpj },
        series,
        cscId: estab.cscId || null,
        cscCadastrado: !!estab.csc,
      });
    } catch (error) {
      console.error('Erro ao ler emissão do estabelecimento:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.put('/api/estabelecimentos/:id/emissao', (req, res) => {
    try {
      if (escopoUsuario(req)) return res.status(403).json({ success: false, error: 'Sem permissão para gerenciar estabelecimentos' });
      const estab = db.prepare('SELECT * FROM estabelecimentos WHERE id = ?').get(req.params.id);
      if (!estab) return res.status(404).json({ success: false, error: 'Estabelecimento não encontrado' });
      if (estab.matriz) {
        return res.status(400).json({
          success: false,
          error: 'A matriz usa as configurações de NF-e/NFC-e/NFS-e, não estabelecimento_serie.',
        });
      }

      const series = req.body.series || {};
      for (const modelo of MODELOS_SERIE) {
        const entrada = series[modelo];
        if (!entrada) continue;
        const serie = Number(entrada.serie);
        const proximo = Number(entrada.proximoNumero);
        if (!Number.isInteger(serie) || serie < 1 || !Number.isInteger(proximo) || proximo < 1) {
          return res.status(400).json({ success: false, error: `Série e próximo número do modelo ${modelo} devem ser inteiros ≥ 1` });
        }
        const row = db.prepare('SELECT id FROM estabelecimento_serie WHERE estabelecimentoId = ? AND modelo = ? ORDER BY serie LIMIT 1').get(estab.id, modelo);
        if (row) {
          db.prepare('UPDATE estabelecimento_serie SET serie = ?, proximoNumero = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(serie, proximo, row.id);
        } else {
          db.prepare('INSERT INTO estabelecimento_serie (estabelecimentoId, modelo, serie, proximoNumero) VALUES (?, ?, ?, ?)').run(estab.id, modelo, serie, proximo);
        }
      }

      // CSC da NFC-e: em branco preserva o token guardado (mesma regra da matriz
      // em nfce-routes); cscLimpar apaga de fato.
      if (req.body.cscId !== undefined) {
        db.prepare('UPDATE estabelecimentos SET cscId = ? WHERE id = ?').run(req.body.cscId || null, estab.id);
      }
      if (req.body.cscLimpar) {
        db.prepare('UPDATE estabelecimentos SET csc = NULL WHERE id = ?').run(estab.id);
      } else if (req.body.csc) {
        db.prepare('UPDATE estabelecimentos SET csc = ? WHERE id = ?').run(req.body.csc, estab.id);
      }
      db.prepare('UPDATE estabelecimentos SET dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(estab.id);

      res.json({ success: true, message: 'Configuração de emissão atualizada.' });
    } catch (error) {
      console.error('Erro ao salvar emissão do estabelecimento:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Estabelecimentos] Rotas registradas');
}

module.exports = {
  registrarRotasEstabelecimentos, getEstabelecimentoAtivo,
  escopoUsuario, escopoSql, escopoSqlHerdado, noEscopo, guardEscopo,
};
