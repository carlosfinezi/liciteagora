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

  console.log('[Estabelecimentos] Rotas registradas');
}

module.exports = { registrarRotasEstabelecimentos, getEstabelecimentoAtivo };
