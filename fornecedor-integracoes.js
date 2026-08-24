/**
 * fornecedor-integracoes.js — como cada fornecedor recebe um pedido de compra.
 *
 * Sem integração, "enviar ao fornecedor" só muda o status do pedido — alguém
 * manda o PDF por e-mail e a vida segue. Com integração, o envio EXECUTA algo:
 * na NicSRS, compra a assinatura do certificado.
 *
 * O módulo de Compras não conhece nenhum fornecedor em particular: ele pergunta
 * qual o adaptador do fornecedor e delega. Fornecedor novo é um adaptador novo,
 * sem tocar em compras-routes.js.
 *
 * Mesma forma que o projeto já usa em `marketplaces_integracoes`: canal +
 * parâmetros (JSON) + ativo.
 *
 * Contrato de um adaptador:
 *   nome                            rótulo no select de canais do fornecedor
 *   rotulo(params)                  texto do botão na tela do pedido
 *   confirmacao(params)             o que avisar antes de executar (ou null)
 *   validar(db, ctx)                { ok, pendencias: [] } — SEM efeito colateral,
 *                                   roda a cada abertura da tela do pedido
 *   executar(db, ctx)               faz o trabalho; devolve
 *                                   { resumo, nenhuma, parcial, ... }
 *
 * ctx = { pedido, itens, usuario, parametros }
 *
 * Como criar um canal novo — só mexe neste arquivo:
 *
 *   1. Acrescente uma entrada em ADAPTADORES com a chave do canal.
 *   2. Implemente `validar` (o que impede a transmissão) e `executar`.
 *   3. Pronto: o canal aparece sozinho no select da aba Fornecedor, e o botão
 *      do pedido passa a usar seu rótulo. Nada muda em compras-routes.js nem
 *      na tela de pedido.
 *
 * `executar` deve sinalizar o desfecho para o módulo de Compras decidir o
 * status do pedido:
 *   nenhuma: true   nada foi transmitido -> pedido volta a 'rascunho'
 *   parcial: true   parte transmitida    -> 'enviado_parcial'
 *   (nenhum dos dois)                    -> 'enviado'
 *
 * Canais que só transmitem (e-mail, WhatsApp) não têm como saber se o
 * fornecedor recebeu de fato: eles reportam o envio, não a aceitação.
 */

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fornecedor_integracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fornecedorId INTEGER NOT NULL UNIQUE,
      canal TEXT NOT NULL,
      parametros TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fornecedorId) REFERENCES pessoas(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fornecedor_integracoes ON fornecedor_integracoes(fornecedorId, ativo);

    -- TIPOS de integração. A execução (handler) é código; o resto é dado:
    -- nome, descrição, texto do botão, confirmação e quais campos o canal
    -- oferece no formulário. Assim dá para criar um tipo "Portal XYZ" em cima
    -- do handler "webhook", com campos e textos próprios, sem programar.
    CREATE TABLE IF NOT EXISTS integracao_tipos (
      slug TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      descricao TEXT,
      handler TEXT NOT NULL,
      campos TEXT,
      rotuloPadrao TEXT,
      confirmacaoPadrao TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 0,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  semearTipos(db);

  // Fornecedor passa a apontar para um canal configurado.
  try {
    db.exec('ALTER TABLE fornecedor_integracoes ADD COLUMN canalId INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
  // Qual canal o botão usa quando o fornecedor tem mais de um.
  try {
    db.exec('ALTER TABLE fornecedor_integracoes ADD COLUMN padrao INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  permitirVariosCanaisPorFornecedor(db);
  dissolverCanais(db);
}

/**
 * Desfaz a camada de canais: cada integração passa a guardar o tipo e os
 * parâmetros direto na linha do fornecedor.
 *
 * A camada existiu por pouco tempo e provou-se burocracia — a configuração é
 * sempre de um fornecedor só. Idempotente: se não houver mais canalId
 * preenchido nem a tabela, não faz nada.
 */
function dissolverCanais(db) {
  let pendentes;
  try {
    pendentes = db.prepare(`
      SELECT f.id, f.parametros, c.tipo, c.parametros AS paramsCanal
      FROM fornecedor_integracoes f
      JOIN integracao_canais c ON c.id = f.canalId
      WHERE f.canalId IS NOT NULL
    `).all();
  } catch (_) { return 0; }

  if (pendentes.length) {
    const atualizar = db.prepare(`
      UPDATE fornecedor_integracoes
      SET canal = ?, parametros = ?, canalId = NULL, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    db.transaction(() => {
      for (const p of pendentes) {
        // Parâmetros do canal entram como base; o que estava na linha do
        // fornecedor vence, que era a precedência anterior.
        const juntos = { ...parseJson(p.paramsCanal), ...parseJson(p.parametros) };
        atualizar.run(p.tipo, JSON.stringify(juntos), p.id);
      }
    })();
  }
  try { db.exec('DROP TABLE IF EXISTS integracao_canais'); } catch (_) { /* já não existe */ }
  return pendentes.length;
}

/**
 * Remove o UNIQUE de `fornecedorId`: um fornecedor pode receber pedido por
 * mais de um caminho (e-mail para o comercial, API para o sistema).
 *
 * SQLite não faz DROP CONSTRAINT, então a tabela é recriada e os dados
 * copiados. Só roda se o índice único ainda existir.
 */
function permitirVariosCanaisPorFornecedor(db) {
  let precisa = false;
  try {
    // O UNIQUE de coluna vira um índice automático (sqlite_autoindex_*).
    precisa = db.prepare(`
      SELECT COUNT(*) AS n FROM pragma_index_list('fornecedor_integracoes')
      WHERE "unique" = 1 AND origin = 'u'
    `).get().n > 0;
  } catch (_) { return 0; }
  if (!precisa) return 0;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE fornecedor_integracoes_nova (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fornecedorId INTEGER NOT NULL,
        canal TEXT NOT NULL,
        canalId INTEGER,
        parametros TEXT,
        ativo INTEGER NOT NULL DEFAULT 1,
        padrao INTEGER NOT NULL DEFAULT 0,
        observacoes TEXT,
        dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
        dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (fornecedorId) REFERENCES pessoas(id) ON DELETE CASCADE
      );
      INSERT INTO fornecedor_integracoes_nova
        (id, fornecedorId, canal, canalId, parametros, ativo, padrao, observacoes, dataCriacao, dataAtualizacao)
        SELECT id, fornecedorId, canal, canalId, parametros, ativo, 1, observacoes, dataCriacao, dataAtualizacao
        FROM fornecedor_integracoes;
      DROP TABLE fornecedor_integracoes;
      ALTER TABLE fornecedor_integracoes_nova RENAME TO fornecedor_integracoes;
      CREATE INDEX IF NOT EXISTS idx_fornecedor_integracoes ON fornecedor_integracoes(fornecedorId, ativo);
      -- O mesmo tipo duas vezes no mesmo fornecedor não faz sentido.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fornec_integr_tipo
        ON fornecedor_integracoes(fornecedorId, canal);
    `);
  })();
  return 1;
}

// Campos que cada handler entende. Vira o formulário do canal, e fica
// editável na tela de Tipos — quem cria um tipo em cima do handler `webhook`
// pode renomear os campos ou esconder o que não usa.
const CAMPOS_PADRAO = {
  nicsrs: [
    { chave: 'apiToken', rotulo: 'API token da NicSRS',
      dica: 'vazio = usa o token do tenant (Certificados SSL › Integração NicSRS)' },
  ],
  email: [
    { chave: 'destinatario', rotulo: 'Destinatário', dica: 'vazio = usa o e-mail do cadastro do fornecedor' },
    { chave: 'copiaPara', rotulo: 'Cópia para (CC)' },
  ],
  whatsapp: [
    { chave: 'numero', rotulo: 'Número', dica: 'vazio = usa o celular/telefone do fornecedor' },
  ],
  webhook: [
    { chave: 'url', rotulo: 'URL *', dica: 'http:// ou https://' },
    { chave: 'metodo', rotulo: 'Método', dica: 'POST por padrão' },
    { chave: 'headers', rotulo: 'Cabeçalhos (JSON)', dica: 'ex.: {"Authorization":"Bearer ..."}' },
    { chave: 'corpo', rotulo: 'Corpo (template)', tipo: 'textarea',
      dica: 'vazio = JSON padrão. Aceita {{numero}}, {{dataEmissao}}, {{dataPrevistaEntrega}}, {{observacoes}}, {{total}}, {{itens}}' },
  ],
};

/** A feature exigida pelo adaptador está ligada neste tenant? */
function featureAtiva(db, chave) {
  if (!chave) return true;
  try {
    const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave + '_enabled');
    return !!(row && row.valor === '1');
  } catch (_) { return false; }
}

/**
 * Registra na tabela os tipos que vêm do código. Idempotente e conservador:
 * só INSERE o que falta — nome e textos editados na tela não são
 * sobrescritos a cada boot.
 *
 * Adaptador com `requerFeature` só é semeado onde a feature está ligada, e é
 * REMOVIDO se a feature for desligada — desde que nenhum canal dependa dele.
 */
function semearTipos(db) {
  const existe = db.prepare('SELECT slug FROM integracao_tipos WHERE slug = ?');
  const inserir = db.prepare(`
    INSERT INTO integracao_tipos (slug, nome, descricao, handler, campos, rotuloPadrao, confirmacaoPadrao, ativo, builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)
  `);
  for (const [slug, a] of Object.entries(ADAPTADORES)) {
    if (!featureAtiva(db, a.requerFeature)) {
      // Feature ausente: garante que o tipo não fique sobrando de um seed
      // anterior. Canal existente segura a remoção — não se apaga configuração
      // em uso por causa de uma flag.
      try {
        const emUso = db.prepare('SELECT COUNT(*) AS n FROM fornecedor_integracoes WHERE canal = ?').get(slug).n;
        if (!emUso) db.prepare('DELETE FROM integracao_tipos WHERE slug = ? AND builtin = 1').run(slug);
      } catch (_) { /* tabela ainda não existe */ }
      continue;
    }
    if (existe.get(slug)) continue;
    inserir.run(slug, a.nome || slug, a.descricao || null, slug,
                JSON.stringify(CAMPOS_PADRAO[slug] || []),
                a.rotulo ? a.rotulo({}) : null,
                a.confirmacao ? a.confirmacao({}) : null);
  }
}

/** Metadados do tipo (banco), com defaults do código quando não há linha. */
function lerTipo(db, slug) {
  try {
    const row = db.prepare('SELECT * FROM integracao_tipos WHERE slug = ?').get(slug);
    if (row) return { ...row, campos: JSON.parse(row.campos || '[]') };
  } catch (_) { /* tenant sem a tabela ainda */ }
  const a = ADAPTADORES[slug];
  if (!a) return null;
  return {
    slug, nome: a.nome || slug, handler: slug, campos: CAMPOS_PADRAO[slug] || [],
    rotuloPadrao: a.rotulo ? a.rotulo({}) : null,
    confirmacaoPadrao: a.confirmacao ? a.confirmacao({}) : null,
    ativo: 1, builtin: 1,
  };
}

// ==================== adaptadores ====================

/** Texto do pedido para os canais que só transmitem (e-mail, WhatsApp). */
function resumoDoPedido(db, pedido, itens) {
  const linhas = itens.map(i => {
    const qtd = Number(i.quantidade) || 0;
    const unit = Number(i.custoUnitario) || 0;
    return `  ${qtd} x ${i.descricao || ('produto #' + i.produtoId)}`
      + (unit ? ` — R$ ${unit.toFixed(2)} (subtotal R$ ${(qtd * unit).toFixed(2)})` : '');
  });
  const total = itens.reduce((t, i) => t + (Number(i.quantidade) || 0) * (Number(i.custoUnitario) || 0), 0);
  return [
    `Pedido de compra ${pedido.numero}`,
    pedido.dataEmissao ? `Emissão: ${pedido.dataEmissao}` : null,
    pedido.dataPrevistaEntrega ? `Entrega prevista: ${pedido.dataPrevistaEntrega}` : null,
    '',
    'Itens:',
    ...linhas,
    '',
    `Total: R$ ${total.toFixed(2)}`,
    pedido.observacoes ? `\nObservações: ${pedido.observacoes}` : null,
  ].filter(l => l !== null).join('\n');
}

function dadosDoFornecedor(db, fornecedorId) {
  try {
    return db.prepare('SELECT id, razaoSocial, email, telefone, celular FROM pessoas WHERE id = ?').get(fornecedorId) || {};
  } catch (_) { return {}; }
}

/** Substitui {{campos}} do template pelos dados do pedido. */
function aplicarTemplate(texto, pedido, itens) {
  const total = itens.reduce((t, i) => t + (Number(i.quantidade) || 0) * (Number(i.custoUnitario) || 0), 0);
  const valores = {
    numero: pedido.numero || '',
    dataEmissao: pedido.dataEmissao || '',
    dataPrevistaEntrega: pedido.dataPrevistaEntrega || '',
    observacoes: pedido.observacoes || '',
    total: total.toFixed(2),
    itens: JSON.stringify(itens.map(i => ({
      produto: i.descricao || null, sku: i.sku || null,
      quantidade: Number(i.quantidade) || 0, custoUnitario: Number(i.custoUnitario) || 0,
    }))),
  };
  return String(texto || '').replace(/\{\{(\w+)\}\}/g, (_, chave) =>
    Object.prototype.hasOwnProperty.call(valores, chave) ? valores[chave] : `{{${chave}}}`);
}

const ADAPTADORES = {
  /**
   * Webhook: transmite o pedido para uma URL do fornecedor.
   *
   * Existe para integrar fornecedor com API própria SEM escrever adaptador:
   * o canal guarda URL, método, cabeçalhos e um template de corpo, tudo
   * configurável pela tela. Serve para a maioria das APIs REST simples.
   *
   * Parâmetros: { url, metodo, headers{}, corpo }
   * No corpo valem {{numero}}, {{dataEmissao}}, {{dataPrevistaEntrega}},
   * {{observacoes}}, {{total}} e {{itens}} (array JSON).
   */
  webhook: {
    nome: 'Webhook / API do fornecedor (configurável)',
    rotulo: (p) => (p && p.rotuloBotao) || 'Transmitir pedido',
    confirmacao: (p) => `Transmitir o pedido para ${(p && p.url) || 'o endpoint configurado'}?`,

    validar(db, { parametros }) {
      const pendencias = [];
      const url = parametros && parametros.url;
      if (!url) pendencias.push('URL não configurada no canal');
      else if (!/^https?:\/\//i.test(url)) pendencias.push('URL deve começar com http:// ou https://');
      return { ok: pendencias.length === 0, pendencias };
    },

    async executar(db, { pedido, itens, parametros }) {
      const p = parametros || {};
      const corpo = p.corpo
        ? aplicarTemplate(p.corpo, pedido, itens)
        : JSON.stringify({
            numero: pedido.numero, dataEmissao: pedido.dataEmissao,
            dataPrevistaEntrega: pedido.dataPrevistaEntrega, observacoes: pedido.observacoes,
            itens: itens.map(i => ({ sku: i.sku, produto: i.descricao,
              quantidade: Number(i.quantidade) || 0, custoUnitario: Number(i.custoUnitario) || 0 })),
          });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let resp, texto;
      try {
        resp = await fetch(p.url, {
          method: p.metodo || 'POST',
          headers: { 'Content-Type': 'application/json', ...(p.headers || {}) },
          body: corpo,
          signal: ctrl.signal,
        });
        texto = await resp.text();
      } catch (err) {
        throw new Error(`falha ao chamar ${p.url}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`o fornecedor respondeu HTTP ${resp.status}: ${texto.slice(0, 200)}`);
      return { resumo: `Pedido transmitido para ${p.url} (HTTP ${resp.status})`, nenhuma: false, parcial: false };
    },
  },

  /**
   * E-mail: transmite o pedido para o fornecedor sem integração de sistema.
   * É o caso da maioria — o fornecedor recebe a lista de itens e responde
   * por fora. Não há confirmação automática de recebimento.
   */
  email: {
    nome: 'E-mail (envia o pedido ao fornecedor)',
    rotulo: (p) => (p && p.rotuloBotao) || 'Enviar pedido por e-mail',
    confirmacao: (p) => (p && p.confirmacao) || 'Enviar o pedido por e-mail ao fornecedor agora?',

    validar(db, { pedido, parametros }) {
      const pendencias = [];
      const f = dadosDoFornecedor(db, pedido.fornecedorId);
      const destino = (parametros && parametros.destinatario) || f.email;
      if (!destino) pendencias.push('fornecedor sem e-mail cadastrado (preencha aqui ou no cadastro)');
      try {
        if (!require('./email-client').loadSmtpConfig(db)) pendencias.push('SMTP não configurado no tenant');
      } catch (_) { pendencias.push('módulo de e-mail indisponível'); }
      return { ok: pendencias.length === 0, pendencias };
    },

    async executar(db, { pedido, itens, parametros }) {
      const { enviarEmailSimples } = require('./email-client');
      const f = dadosDoFornecedor(db, pedido.fornecedorId);
      const to = (parametros && parametros.destinatario) || f.email;

      // Anexa o PDF do pedido. Se a geração falhar, o e-mail vai só com o
      // texto — melhor transmitir sem anexo do que não transmitir.
      const anexos = [];
      try {
        const emitente = db.prepare('SELECT * FROM estabelecimentos WHERE matriz = 1 LIMIT 1').get() || {};
        const pdf = await require('./pedido-compra-pdf').gerarBuffer(pedido, itens, emitente);
        anexos.push({ filename: `${pedido.numero || 'pedido'}.pdf`, content: pdf });
      } catch (err) {
        console.error('[fornecedor-integracoes] PDF do pedido falhou:', err.message);
      }

      const r = await enviarEmailSimples(db, {
        to,
        cc: (parametros && parametros.copiaPara) || undefined,
        assunto: `Pedido de compra ${pedido.numero}`,
        texto: resumoDoPedido(db, pedido, itens),
        anexos,
      });
      // enviarEmailSimples NÃO lança: devolve { success:false, error }. Sem
      // checar, uma falha de SMTP viraria "pedido enviado".
      if (!r || r.success === false) throw new Error(r && r.error ? r.error : 'falha no envio do e-mail');

      return {
        resumo: `Pedido enviado por e-mail para ${to}` + (anexos.length ? ' (com PDF)' : ' (sem PDF)'),
        destino: to, nenhuma: false, parcial: false,
      };
    },
  },

  /**
   * WhatsApp: mesmo papel do e-mail, para fornecedor que responde por lá.
   * Usa o adaptador de WhatsApp já configurado no tenant.
   */
  whatsapp: {
    nome: 'WhatsApp (envia o pedido ao fornecedor)',
    rotulo: (p) => (p && p.rotuloBotao) || 'Enviar pedido por WhatsApp',
    confirmacao: (p) => (p && p.confirmacao) || 'Enviar o pedido por WhatsApp ao fornecedor agora?',

    validar(db, { pedido, parametros }) {
      const pendencias = [];
      const f = dadosDoFornecedor(db, pedido.fornecedorId);
      const numero = (parametros && parametros.numero) || f.celular || f.telefone;
      if (!numero) pendencias.push('fornecedor sem celular/telefone cadastrado');
      return { ok: pendencias.length === 0, pendencias };
    },

    async executar(db, { pedido, itens, parametros }) {
      const { enviarWhatsApp } = require('./whatsapp-adapter');
      const f = dadosDoFornecedor(db, pedido.fornecedorId);
      const numero = (parametros && parametros.numero) || f.celular || f.telefone;
      // A assinatura é { telefone, texto } — o adaptador normaliza o número e
      // prefixa 55 quando falta.
      const r = await enviarWhatsApp(db, { telefone: numero, texto: resumoDoPedido(db, pedido, itens) });
      if (r && r.success === false) throw new Error(r.error || 'WhatsApp recusou o envio');
      // O adaptador pode enfileirar em vez de enviar na hora (controle de
      // ritmo do número): isso conta como transmitido.
      const enfileirado = r && r.queued;
      return {
        resumo: `Pedido ${enfileirado ? 'enfileirado' : 'enviado'} por WhatsApp para ${numero}`,
        destino: numero, nenhuma: false, parcial: false,
      };
    },
  },

  /**
   * NicSRS: enviar o pedido É comprar a assinatura na API de revenda.
   *
   * Não exige domínio, CSR nem DCV — na NicSRS a compra adquire a assinatura e
   * a configuração do certificado é etapa posterior. Cada unidade da
   * quantidade vira uma assinatura independente, com seu próprio ciclo de
   * reemissão (decisão de 2026-08-21).
   */
  nicsrs: {
    nome: 'NicSRS (certificados SSL)',
    // Add-on por tenant: este tipo só existe onde o módulo SSL foi contratado.
    // Sem isto ele apareceria no catálogo de tipos dos 11 tenants.
    requerFeature: 'ssl',
    rotulo: (p) => (p && p.rotuloBotao) || 'Comprar na NicSRS',
    confirmacao: (p) => (p && p.confirmacao)
      || 'Isto debita o saldo da conta NicSRS e não se desfaz sem cancelamento. Confirmar a compra?',

    validar(db, { itens, parametros }) {
      const pendencias = [];
      const ssl = require('./ssl-certificados-routes');
      // Token do canal permite uma conta NicSRS diferente da do tenant; sem
      // ele, vale o token global configurado em Integração NicSRS.
      const token = (parametros && parametros.apiToken) || ssl.getConfig(db, 'nicsrs_api_token');
      if (!token) pendencias.push('token da NicSRS não configurado (nem no canal, nem no tenant)');

      let temProdutoNicsrs = false;
      for (const item of itens) {
        const p = db.prepare('SELECT code, maxYear FROM ssl_produtos_nicsrs WHERE produtoId = ?').get(item.produtoId);
        if (!p) {
          pendencias.push(`item "${item.descricao || item.produtoId}" não é um produto da NicSRS`);
          continue;
        }
        temProdutoNicsrs = true;
        if ((Number(item.quantidade) || 1) < 1) pendencias.push(`quantidade inválida no item "${item.descricao}"`);
      }
      if (!temProdutoNicsrs) pendencias.push('nenhum item do pedido é um certificado da NicSRS');
      return { ok: pendencias.length === 0, pendencias };
    },

    async executar(db, { pedido, itens, usuario, parametros }) {
      const ssl = require('./ssl-certificados-routes');
      return ssl.comprarAssinaturasDoPedido(db, pedido, itens, usuario, {
        apiToken: parametros && parametros.apiToken,
      });
    },
  },
};

// ==================== consulta ====================

function parseJson(texto) {
  try { return texto ? JSON.parse(texto) : {}; } catch (_) { return {}; }
}

/**
 * Resolve a integração de um fornecedor.
 *
 * Duas formas convivem: `canalId` aponta para um canal configurado na tela
 * (forma atual) e `canal` guarda o tipo direto (forma antiga, de quem foi
 * configurado antes dos canais existirem). Os parâmetros do canal e os do
 * fornecedor são mesclados — o do fornecedor vence, para permitir ajuste
 * pontual sem duplicar canal.
 */
/** Todos os canais ativos do fornecedor, o padrão primeiro. */
function lerIntegracoes(db, fornecedorId) {
  let linhas;
  try {
    linhas = db.prepare(`
      SELECT * FROM fornecedor_integracoes
      WHERE fornecedorId = ? AND ativo = 1
      ORDER BY padrao DESC, id
    `).all(fornecedorId);
  } catch (_) { return []; }
  return linhas.map(l => resolverLinha(db, l)).filter(Boolean);
}

function lerIntegracao(db, fornecedorId, integracaoId) {
  try {
    const row = integracaoId
      ? db.prepare('SELECT * FROM fornecedor_integracoes WHERE id = ? AND fornecedorId = ? AND ativo = 1')
          .get(integracaoId, fornecedorId)
      : db.prepare(`
          SELECT * FROM fornecedor_integracoes WHERE fornecedorId = ? AND ativo = 1
          ORDER BY padrao DESC, id LIMIT 1
        `).get(fornecedorId);
    if (!row) return null;
    return resolverLinha(db, row);
  } catch (_) {
    // Tenant sem a tabela ainda: comporta-se como fornecedor sem integração.
    return null;
  }
}

/**
 * Uma linha de integração vira o que a tela e o envio precisam.
 *
 * Não há camada de "canal" entre o fornecedor e o tipo: cada configuração é de
 * um fornecedor só (destinatário, URL e token são dele), então uma entidade
 * intermediária custava dois passos em duas telas sem entregar reuso.
 */
function resolverLinha(db, row) {
  try {
    const tipo = row.canal;
    const parametros = parseJson(row.parametros);

    // O tipo diz QUAL handler executa e quais textos usar. Um tipo criado na
    // tela ("Portal XYZ" sobre o handler webhook) resolve para o mesmo código,
    // com nome e rótulo próprios.
    const meta = lerTipo(db, tipo);
    if (!meta || !meta.ativo) return null;
    const adaptador = ADAPTADORES[meta.handler];
    if (!adaptador) return null;

    // Texto do botão e confirmação são atributos do TIPO.
    if (meta.rotuloPadrao) parametros.rotuloBotao = meta.rotuloPadrao;
    if (meta.confirmacaoPadrao) parametros.confirmacao = meta.confirmacaoPadrao;

    return { ...row, canal: tipo, tipoMeta: meta, nomeCanal: meta.nome, parametros, adaptador };
  } catch (_) {
    // Tenant sem a tabela ainda: comporta-se como fornecedor sem integração.
    return null;
  }
}

/** O que a tela do pedido precisa saber para desenhar o botão. */
function descreverParaPedido(db, pedido, itens) {
  const integracao = lerIntegracao(db, pedido.fornecedorId);
  if (!integracao) {
    return { canal: null, rotulo: 'Enviar ao fornecedor', confirmacao: null, ok: true, pendencias: [] };
  }
  const { adaptador, parametros } = integracao;
  let validacao = { ok: true, pendencias: [] };
  try {
    if (adaptador.validar) validacao = adaptador.validar(db, { pedido, itens, parametros });
  } catch (err) {
    validacao = { ok: false, pendencias: [err.message] };
  }
  return {
    canal: integracao.canal,
    rotulo: adaptador.rotulo ? adaptador.rotulo(parametros) : 'Enviar ao fornecedor',
    confirmacao: adaptador.confirmacao ? adaptador.confirmacao(parametros) : null,
    ...validacao,
  };
}

/** Executa a integração do fornecedor. Devolve null se não houver nenhuma. */
async function executarParaPedido(db, pedido, itens, usuario) {
  const integracao = lerIntegracao(db, pedido.fornecedorId);
  if (!integracao || !integracao.adaptador.executar) return null;
  return integracao.adaptador.executar(db, { pedido, itens, usuario, parametros: integracao.parametros });
}

function registrarRotasFornecedorIntegracoes(app, db) {
  ensureSchema(db);

  // Tipos de adaptador disponíveis (código) + canais configurados (usuário).
  app.get('/api/fornecedor-integracoes/canais', (req, res) => {
    try {
      // Tipos vêm do banco (editáveis na tela de Tipos); o código é fallback
      // para tenant que ainda não tenha a tabela.
      let tipos;
      try {
        tipos = db.prepare('SELECT slug AS tipo, nome, campos FROM integracao_tipos WHERE ativo = 1 ORDER BY nome')
          .all().map(t => ({ ...t, campos: JSON.parse(t.campos || '[]') }));
      } catch (_) {
        tipos = Object.entries(ADAPTADORES).map(([tipo, a]) => ({ tipo, nome: a.nome || tipo, campos: CAMPOS_PADRAO[tipo] || [] }));
      }
      res.json({ success: true, tipos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CRUD de tipos ====================

  app.get('/api/integracao-tipos', (req, res) => {
    try {
      const tipos = db.prepare(`
        SELECT t.*, (SELECT COUNT(*) FROM fornecedor_integracoes f WHERE f.canal = t.slug) AS fornecedores
        FROM integracao_tipos t ORDER BY t.nome
      `).all().map(t => ({ ...t, campos: JSON.parse(t.campos || '[]') }));
      // Handlers de add-on não contratado não entram na lista de escolha.
      const handlers = Object.entries(ADAPTADORES)
        .filter(([, a]) => featureAtiva(db, a.requerFeature)).map(([h]) => h);
      res.json({ success: true, tipos, handlers });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/integracao-tipos', (req, res) => {
    try {
      const { slug, nome, descricao, handler, campos, rotuloPadrao, confirmacaoPadrao, ativo } = req.body;
      if (!slug || !nome || !handler) {
        return res.status(400).json({ success: false, error: 'slug, nome e handler são obrigatórios' });
      }
      if (!/^[a-z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ success: false, error: 'slug deve ter só letras minúsculas, números, hífen ou _' });
      }
      // O handler é o que executa de fato: tem de existir no código.
      if (!ADAPTADORES[handler]) {
        return res.status(400).json({ success: false,
          error: `Handler inexistente (disponíveis: ${Object.keys(ADAPTADORES).join(', ')})` });
      }
      if (db.prepare('SELECT slug FROM integracao_tipos WHERE slug = ?').get(slug)) {
        return res.status(409).json({ success: false, error: `Já existe um tipo com o slug "${slug}"` });
      }
      db.prepare(`
        INSERT INTO integracao_tipos (slug, nome, descricao, handler, campos, rotuloPadrao, confirmacaoPadrao, ativo, builtin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(slug, nome, descricao || null, handler,
             JSON.stringify(campos || CAMPOS_PADRAO[handler] || []),
             rotuloPadrao || null, confirmacaoPadrao || null, ativo === false ? 0 : 1);
      res.json({ success: true, slug });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/integracao-tipos/:slug', (req, res) => {
    try {
      const tipo = db.prepare('SELECT * FROM integracao_tipos WHERE slug = ?').get(req.params.slug);
      if (!tipo) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      const { nome, descricao, handler, campos, rotuloPadrao, confirmacaoPadrao, ativo } = req.body;

      // Trocar o handler de um tipo nativo mudaria o que ele faz sem mudar o
      // nome — o canal continuaria dizendo "Comprar na NicSRS" e passaria a
      // fazer outra coisa. Nome, textos e campos seguem editáveis.
      if (handler && handler !== tipo.handler) {
        if (tipo.builtin) {
          return res.status(400).json({ success: false,
            error: 'Tipo nativo não permite trocar o handler — crie um tipo novo sobre o handler desejado' });
        }
        if (!ADAPTADORES[handler]) {
          return res.status(400).json({ success: false,
            error: `Handler inexistente (disponíveis: ${Object.keys(ADAPTADORES).join(', ')})` });
        }
      }
      db.prepare(`
        UPDATE integracao_tipos SET
          nome = COALESCE(?, nome), descricao = ?, handler = COALESCE(?, handler),
          campos = COALESCE(?, campos), rotuloPadrao = ?, confirmacaoPadrao = ?,
          ativo = COALESCE(?, ativo), dataAtualizacao = CURRENT_TIMESTAMP
        WHERE slug = ?
      `).run(nome || null, descricao !== undefined ? descricao : tipo.descricao,
             handler || null, campos !== undefined ? JSON.stringify(campos) : null,
             rotuloPadrao !== undefined ? rotuloPadrao : tipo.rotuloPadrao,
             confirmacaoPadrao !== undefined ? confirmacaoPadrao : tipo.confirmacaoPadrao,
             ativo === undefined ? null : (ativo ? 1 : 0), tipo.slug);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/integracao-tipos/:slug', (req, res) => {
    try {
      const tipo = db.prepare('SELECT * FROM integracao_tipos WHERE slug = ?').get(req.params.slug);
      if (!tipo) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      if (tipo.builtin) {
        return res.status(400).json({ success: false,
          error: 'Tipo nativo não pode ser excluído — desative se não quiser usá-lo' });
      }
      const emUso = db.prepare('SELECT COUNT(*) AS n FROM fornecedor_integracoes WHERE canal = ?').get(tipo.slug).n;
      if (emUso) {
        return res.status(409).json({ success: false, error: `Tipo em uso por ${emUso} fornecedor(es)` });
      }
      db.prepare('DELETE FROM integracao_tipos WHERE slug = ?').run(tipo.slug);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/fornecedor-integracoes/:fornecedorId', (req, res) => {
    try {
      const linhas = db.prepare(
        'SELECT * FROM fornecedor_integracoes WHERE fornecedorId = ? ORDER BY padrao DESC, id'
      ).all(Number(req.params.fornecedorId))
        .map(l => ({ ...l, parametros: parseJson(l.parametros) }));
      res.json({
        success: true,
        integracoes: linhas,
        // Compatibilidade: a tela antiga lia uma só.
        integracao: linhas[0] || null,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Acrescenta ou atualiza UMA integração do fornecedor. Sem id, cria.
  app.post('/api/fornecedor-integracoes/:fornecedorId', (req, res) => {
    try {
      const fornecedorId = Number(req.params.fornecedorId);
      const { id, tipo, parametros, ativo, padrao, observacoes } = req.body;
      if (!tipo) return res.status(400).json({ success: false, error: 'tipo é obrigatório' });
      const meta = lerTipo(db, tipo);
      if (!meta) return res.status(400).json({ success: false, error: `Tipo "${tipo}" não existe` });

      db.transaction(() => {
        if (id) {
          db.prepare(`
            UPDATE fornecedor_integracoes
            SET canal = ?, parametros = ?, ativo = ?, padrao = ?, observacoes = ?, dataAtualizacao = CURRENT_TIMESTAMP
            WHERE id = ? AND fornecedorId = ?
          `).run(tipo, JSON.stringify(parametros || {}), ativo === false ? 0 : 1,
                 padrao ? 1 : 0, observacoes || null, Number(id), fornecedorId);
        } else {
          db.prepare(`
            INSERT INTO fornecedor_integracoes (fornecedorId, canal, parametros, ativo, padrao, observacoes)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(fornecedorId, tipo, JSON.stringify(parametros || {}),
                 ativo === false ? 0 : 1, padrao ? 1 : 0, observacoes || null);
        }
        // Só um padrão por fornecedor.
        if (padrao) {
          db.prepare(`
            UPDATE fornecedor_integracoes SET padrao = 0
            WHERE fornecedorId = ? AND id <> (SELECT MAX(id) FROM fornecedor_integracoes WHERE fornecedorId = ? AND padrao = 1)
          `).run(fornecedorId, fornecedorId);
        }
        // Nenhum padrão definido: o primeiro assume, para o botão ter o que usar.
        const temPadrao = db.prepare('SELECT COUNT(*) AS n FROM fornecedor_integracoes WHERE fornecedorId = ? AND padrao = 1 AND ativo = 1').get(fornecedorId).n;
        if (!temPadrao) {
          db.prepare(`
            UPDATE fornecedor_integracoes SET padrao = 1
            WHERE id = (SELECT MIN(id) FROM fornecedor_integracoes WHERE fornecedorId = ? AND ativo = 1)
          `).run(fornecedorId);
        }
      })();
      res.json({ success: true });
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) {
        return res.status(409).json({ success: false, error: 'Este fornecedor já tem uma integração deste tipo' });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/fornecedor-integracoes/:fornecedorId/:id', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM fornecedor_integracoes WHERE id = ? AND fornecedorId = ?')
        .run(Number(req.params.id), Number(req.params.fornecedorId));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Integração não encontrada' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/fornecedor-integracoes/:fornecedorId/:id', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM fornecedor_integracoes WHERE id = ? AND fornecedorId = ?')
        .run(Number(req.params.id), Number(req.params.fornecedorId));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Integração não encontrada' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

}

module.exports = {
  ensureSchema,
  CAMPOS_PADRAO,
  lerTipo,
  registrarRotasFornecedorIntegracoes,
  ADAPTADORES,
  lerIntegracao,
  descreverParaPedido,
  executarParaPedido,
};
