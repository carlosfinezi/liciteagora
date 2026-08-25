/**
 * os-routes.js — Ordem de Serviço (OS): assistência, manutenção, instalação.
 *
 * Modelo:
 *   os_ordens         — cabeçalho (cliente, técnico, status, equipamento, defeito, solução)
 *   os_itens_pecas    — produtos consumidos (gera saída de estoque ao concluir)
 *   os_itens_servicos — serviços/horas (linha livre)
 *   os_apontamentos   — registro de tempo de execução
 *
 * Status: aberta | em-andamento | aguardando-peca | concluida | faturada | cancelada
 *
 * Faturamento: cria um pedido vinculado com itens de peças + linhas de serviço como
 * itens (sem produtoId). NF-e/NFSe ficam manuais.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { reentrarContextoTenant } = require('./tenant-middleware');
const { comTratamentoDeErro, nomeOriginalUtf8 } = require('./upload-anexos');
const { logAction } = require('./audit-log');
const { emitirNfseInterno } = require('./nfse-routes');
const { emitirNFe } = require('./nfe-emit-routes');
const { criarReservasOS, consumirReservasOS, cancelarReservasOS } = require('./reservas-routes');
const { erroMeioPermitido } = require('./meios-pagamento');
const { prazoDaPessoa } = require('./prazo-pagamento');
// Custo médio vigente para gravar na baixa da peça (custo histórico da OS).
const { calcularCustoMedio, resolverDeposito } = require('./estoque-routes');
const {
  criarContaAPagar,
  atualizarContaAPagarSeAberta,
  removerContaAPagarSeAberta,
  contaAPagarTemPagamento,
} = require('./contas-pagar-routes');
const { enviarEmailCobranca } = require('./email-client');
const { enviarWhatsApp } = require('./whatsapp-adapter');
const {
  EVENTOS: EVENTOS_NOTIF, EVENTOS_VALIDOS, CANAIS, PLACEHOLDERS,
  migrarNotificacoesDB, dispatchNotificacoes, enviarTeste,
} = require('./os-notificacoes');
const osPdf = require('./os-pdf');

// Fase 9.1 (2026-04-22): status expandidos.
// rascunho → orcamento → (aprovado) → em-andamento → (concluida → faturada) | cancelada
const STATUS = ['rascunho', 'orcamento', 'aberta', 'em-andamento', 'aguardando-peca', 'concluida', 'faturada', 'cancelada'];

const UPLOAD_DIR_OS = path.join(__dirname, 'public', 'uploads', 'os');
try { fs.mkdirSync(UPLOAD_DIR_OS, { recursive: true }); } catch (_) { /* */ }

const uploadOSAnexo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR_OS, String(req.params.id));
      // O erro TEM de ir pelo callback: um throw aqui vira uncaughtException
      // e derruba o servidor inteiro (aconteceu em 2026-08-20, EACCES no mkdir).
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return cb(err);
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext.startsWith('.') ? '' : '.'}${ext}`.replace(/\.+/g,'.'));
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB (aceita foto grande)
  fileFilter: (req, file, cb) => {
    // Quem decide é a EXTENSÃO, não o mimetype — ver a nota em
    // contas-pagar-routes.js. octet-stream deixava passar um .exe.
    const ok = /\.(pdf|png|jpg|jpeg|webp|heic|mp4|mov)$/i.test(file.originalname);
    cb(ok ? null : new Error('Formato não aceito (pdf, imagem ou vídeo)'), ok);
  },
});

// Helper único para registrar evento em os_eventos — viabiliza timeline.
function registrarEvento(db, osId, tipo, descricao, usuario, payload) {
  try {
    // Snapshot financeiro: grava quanto a OS valia NO MOMENTO do evento.
    // Sem isso o histórico responde "o que aconteceu" mas não "quanto valia
    // quando aconteceu" — a pergunta que aparece ao revisar uma aprovação ou
    // um faturamento depois de a OS ter mudado.
    let snap = null;
    try {
      const o = db.prepare(`SELECT valorPecas, valorServicos, valorDesconto, valorTotal,
                                   kmPercorrido, valorDeslocamento, status
                            FROM os_ordens WHERE id = ?`).get(osId);
      if (o) {
        snap = {
          pecas: Number(o.valorPecas) || 0,
          servicos: Number(o.valorServicos) || 0,
          desconto: Number(o.valorDesconto) || 0,
          total: Number(o.valorTotal) || 0,
          km: o.kmPercorrido != null ? Number(o.kmPercorrido) : null,
          deslocamento: o.valorDeslocamento != null ? Number(o.valorDeslocamento) : null,
          status: o.status,
        };
      }
    } catch (_) { /* colunas novas podem faltar em banco não migrado */ }
    const corpo = snap ? { ...(payload || {}), _snapshot: snap } : payload;
    db.prepare(`
      INSERT INTO os_eventos (osId, tipo, descricao, usuario, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(osId, tipo, descricao || null, usuario || null, corpo ? JSON.stringify(corpo) : null);
  } catch (_) { /* tabela pode não existir em boot antigo */ }
  // Dispara notificações configuradas em os_notificacoes_config (fase 9.5).
  // Roda em background — falhas não afetam a escrita do evento.
  try {
    dispatchNotificacoes(db, osId, tipo, descricao, payload).catch(() => {});
  } catch (_) { /* */ }
}

// O dispatcher de notificações mora em os-notificacoes.js — o sweep de
// SLA no scheduler precisa do mesmo código, e antes ele fazia INSERT
// direto em os_eventos, sem notificar ninguém.

// Fase 9.4 (2026-04-22): calcula o slaStatus de uma OS com base na
// dataPromessa, status atual e dataConclusao. Derivado (não persistido
// aqui — o scheduler master persiste via reconciliador SLA).
//   'cumprido'  — concluída dentro do prazo
//   'estourado' — concluída depois do prazo
//   'atrasado'  — ativa, hoje > dataPromessa
//   'risco'     — ativa, hoje + 1d >= dataPromessa (<= 24h para vencer)
//   'no-prazo'  — ativa, dentro do prazo
//   null        — sem dataPromessa (SLA não definido)
function calcSlaStatus(os) {
  if (!os.dataPromessa) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const promessa = new Date(os.dataPromessa + 'T00:00:00');
  if (['concluida', 'faturada'].includes(os.status)) {
    if (!os.dataConclusao) return 'cumprido';
    const fim = new Date(os.dataConclusao.slice(0, 10) + 'T00:00:00');
    return fim.getTime() <= promessa.getTime() ? 'cumprido' : 'estourado';
  }
  if (os.status === 'cancelada') return null;
  if (hoje.getTime() > promessa.getTime()) return 'atrasado';
  const diff = (promessa.getTime() - hoje.getTime()) / (24 * 60 * 60 * 1000);
  if (diff <= 1) return 'risco';
  return 'no-prazo';
}

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      clienteId INTEGER NOT NULL,
      tecnicoId INTEGER,
      status TEXT NOT NULL DEFAULT 'aberta',
      titulo TEXT NOT NULL,
      equipamento TEXT,
      marca TEXT,
      modelo TEXT,
      numeroSerieEquipamento TEXT,
      defeitoRelatado TEXT,
      diagnostico TEXT,
      solucao TEXT,
      garantiaDias INTEGER DEFAULT 0,
      observacoes TEXT,
      valorPecas REAL DEFAULT 0,
      valorServicos REAL DEFAULT 0,
      valorTotal REAL DEFAULT 0,
      pedidoId INTEGER,
      dataAbertura TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dataInicioExecucao TEXT,
      dataConclusao TEXT,
      dataFaturamento TEXT,
      dataCancelamento TEXT,
      motivoCancelamento TEXT,
      usuarioCriacao TEXT,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (tecnicoId) REFERENCES users(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_os_status ON os_ordens(status, dataAbertura);
    CREATE INDEX IF NOT EXISTS idx_os_cliente ON os_ordens(clienteId);
    CREATE INDEX IF NOT EXISTS idx_os_tecnico ON os_ordens(tecnicoId);

    CREATE TABLE IF NOT EXISTS os_itens_pecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL,
      valorUnitario REAL NOT NULL,
      valorTotal REAL NOT NULL,
      loteId INTEGER,
      serialIds TEXT,
      movSaidaId INTEGER,
      FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (loteId) REFERENCES lotes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_os_pecas_os ON os_itens_pecas(osId);

    CREATE TABLE IF NOT EXISTS os_itens_servicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      horas REAL,
      valorHora REAL,
      valorTotal REAL NOT NULL,
      FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_os_servicos_os ON os_itens_servicos(osId);

    CREATE TABLE IF NOT EXISTS os_apontamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER NOT NULL,
      tecnicoId INTEGER,
      dataInicio TEXT NOT NULL,
      dataFim TEXT,
      horas REAL,
      descricao TEXT,
      FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (tecnicoId) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_os_apont_os ON os_apontamentos(osId);
  `);

  // Colunas adicionadas depois da criação original (alterSafe idempotente)
  const alterSafe = (sql) => { try { db.exec(sql); } catch { /* já existe */ } };
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN formaPagamento TEXT`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN dataVencimento TEXT`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN numeroParcelas INTEGER DEFAULT 1`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN naoEmitirNFe INTEGER DEFAULT 0`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN statusFiscal TEXT`);
  // Colunas que vivem em db-schema.js mas precisam ser garantidas em
  // tenants que tiveram db-schema rodando antes de os_ordens existir
  // (alterSafe lá foi no-op pra coluna em tabela inexistente).
  for (const col of [
    'tipoId INTEGER', 'contratoId INTEGER', 'oportunidadeId INTEGER', 'osPaiId INTEGER',
    'enderecoExecucao TEXT', 'numeroExecucao TEXT', 'complementoExecucao TEXT',
    'bairroExecucao TEXT', 'municipioExecucao TEXT', 'ufExecucao TEXT', 'cepExecucao TEXT',
    'prazoSLADias INTEGER', 'dataPromessa TEXT',
    "slaStatus TEXT DEFAULT 'no-prazo'", "orcamentoStatus TEXT DEFAULT 'rascunho'",
    'orcamentoToken TEXT', 'dataEnvioOrcamento TEXT', 'dataRespostaOrcamento TEXT',
    'motivoRejeicao TEXT', 'assinaturaClienteDataUrl TEXT', 'assinaturaClienteData TEXT',
    'assinaturaTecnicoDataUrl TEXT', 'assinaturaTecnicoData TEXT',
    'emGarantia INTEGER DEFAULT 0', "ambienteFiscal TEXT DEFAULT 'sefaz'",
    'kmPercorrido REAL', 'valorDeslocamento REAL',
    'tipoOperacaoId INTEGER',
    // Equipamento deixou de ser só texto solto — ver tabela equipamentos.
    'equipamentoId INTEGER',
    // De qual depósito as peças saem.
    'depositoId INTEGER',
  ]) alterSafe(`ALTER TABLE os_ordens ADD COLUMN ${col}`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_os_equipamento ON os_ordens(equipamentoId, dataAbertura)`);
  // Custo da peça no momento da baixa. Sem isso, o custo histórico se
  // perdia e a lucratividade só podia usar o custo de hoje.
  alterSafe(`ALTER TABLE os_itens_pecas ADD COLUMN custoUnitario REAL`);

  // Desconto em dois níveis, como em ERP: na linha e no rodapé.
  //  - item:  o valorTotal do item já sai líquido, então capa, contas a
  //           receber e nota fiscal batem sem ninguém precisar lembrar.
  //  - capa:  rateado proporcionalmente entre peças e serviços no faturamento
  //           (mesmo algoritmo do frete da NF-e) e informado como desconto no
  //           documento — vDesc na NF-e, vDescIncond na NFS-e.
  alterSafe(`ALTER TABLE os_itens_pecas ADD COLUMN desconto REAL DEFAULT 0`);
  alterSafe(`ALTER TABLE os_itens_servicos ADD COLUMN desconto REAL DEFAULT 0`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN valorDesconto REAL DEFAULT 0`);

  // Orçado × Confirmado por item. Antes o orçamento era da OS inteira
  // (os_ordens.orcamentoStatus), tudo-ou-nada: não dava para o cliente aprovar
  // 3 de 5 itens nem faturar parte agora e parte depois.
  //
  // REGRA: só item 'confirmado' entra no financeiro — totais da capa, baixa de
  // estoque, contas a receber e nota fiscal. Item 'orcado' é proposta: aparece
  // no orçamento e no PDF, não vira dinheiro.
  //
  // Default 'confirmado' de propósito: sem isso todo item já existente viraria
  // orçamento e as OS abertas zerariam o total no primeiro recálculo.
  alterSafe(`ALTER TABLE os_itens_pecas ADD COLUMN situacao TEXT DEFAULT 'confirmado'`);
  alterSafe(`ALTER TABLE os_itens_servicos ADD COLUMN situacao TEXT DEFAULT 'confirmado'`);
  // Linhas gravadas antes da coluna existir ficam com NULL, não com o default.
  alterSafe(`UPDATE os_itens_pecas SET situacao = 'confirmado' WHERE situacao IS NULL`);
  alterSafe(`UPDATE os_itens_servicos SET situacao = 'confirmado' WHERE situacao IS NULL`);
  alterSafe(`ALTER TABLE nfse ADD COLUMN valorDescontoIncondicionado REAL DEFAULT 0`);

  // Condição de pagamento escolhida: aponta para politicas_prazo, o cadastro
  // que já define prazo, parcelas e meios aceitos. Antes a OS guardava só o
  // tPag solto e o prazo vinha do cadastro da pessoa por baixo dos panos.
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN politicaPrazoId INTEGER`);

  // Comportamento ditado pelo Tipo de OS. Espelha db-schema.js — aqui garante
  // as colunas em tenant que só passa pelo ensureMigrated.
  for (const col of [
    "natureza TEXT DEFAULT 'cliente'",
    "localPrestacao TEXT DEFAULT 'indefinido'",
    'bloqueiaFaturamento INTEGER DEFAULT 0',
    'obrigarDataPrevista INTEGER DEFAULT 0',
    "deslocamentoModo TEXT DEFAULT 'manual'",
    'deslocamentoValorKm REAL',
    'deslocamentoValorFixo REAL',
    "encerraPecaPendente TEXT DEFAULT 'permitido'",
    "encerraServicoPendente TEXT DEFAULT 'permitido'",
    "encerraTerceiroPendente TEXT DEFAULT 'permitido'",
    "encerraKmPendente TEXT DEFAULT 'permitido'",
    "encerraApontamentoAberto TEXT DEFAULT 'permitido'",
    "servicoCalculoModo TEXT DEFAULT 'livre'",
    'servicoValorHoraPadrao REAL',
    'permiteAlterarCalculoServico INTEGER DEFAULT 1',
    "faturarPara TEXT DEFAULT 'cliente'",
  ]) alterSafe(`ALTER TABLE os_tipos ADD COLUMN ${col}`);
  alterSafe(`ALTER TABLE os_itens_servicos ADD COLUMN origem TEXT`);
  alterSafe(`ALTER TABLE servicos ADD COLUMN tempoPadraoHoras REAL`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN pagadorId INTEGER`);

  // Peça retirada do equipamento por defeito. Tabela à parte, e não um flag em
  // os_itens_pecas, porque ela não é vendida: não pode entrar no valorPecas
  // nem virar item de nota. O que importa aqui é rastrear o que saiu do
  // equipamento e para onde foi (garantia do fabricante, descarte, devolução).
  alterSafe(`CREATE TABLE IF NOT EXISTS os_pecas_defeito (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    osId INTEGER NOT NULL,
    produtoId INTEGER,
    descricao TEXT NOT NULL,
    quantidade REAL NOT NULL DEFAULT 1,
    numeroSerie TEXT,
    laudo TEXT,
    destino TEXT,
    dataRegistro TEXT DEFAULT CURRENT_TIMESTAMP,
    usuario TEXT,
    FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE
  )`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_os_pecas_defeito_os ON os_pecas_defeito(osId)`);
  alterSafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_os_orcamento_token ON os_ordens(orcamentoToken) WHERE orcamentoToken IS NOT NULL`);

  // ==================== EQUIPAMENTOS ====================
  //
  // Antes o equipamento eram 4 colunas de texto livre em os_ordens
  // (equipamento/marca/modelo/numeroSerieEquipamento). Sem identidade não
  // havia reincidência, histórico nem base instalada, e a garantia era
  // procurada por comparação de string dentro do mesmo clienteId.
  //
  // As colunas de texto continuam na OS como snapshot do que foi digitado
  // na época: renomear o equipamento depois não reescreve o histórico.
  db.exec(`
    CREATE TABLE IF NOT EXISTS equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clienteId INTEGER,
      descricao TEXT NOT NULL,
      marca TEXT,
      modelo TEXT,
      numeroSerie TEXT,
      patrimonio TEXT,
      -- Quando o equipamento foi vendido por nós, aponta para o produto e
      -- para a série já rastreada em serial_numbers.
      produtoId INTEGER,
      serialNumberId INTEGER,
      dataAquisicao TEXT,
      garantiaFabricanteAte TEXT,
      observacoes TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_equip_cliente ON equipamentos(clienteId, ativo);
    CREATE INDEX IF NOT EXISTS idx_equip_serie ON equipamentos(numeroSerie);
    CREATE INDEX IF NOT EXISTS idx_equip_modelo ON equipamentos(marca, modelo);

    -- Troca de dono, baixa, observações: o que acontece com o equipamento
    -- e não cabe dentro de uma OS.
    CREATE TABLE IF NOT EXISTS equipamento_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamentoId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      descricao TEXT,
      clienteAnteriorId INTEGER,
      clienteNovoId INTEGER,
      osId INTEGER,
      usuario TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipamentoId) REFERENCES equipamentos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_equip_ev ON equipamento_eventos(equipamentoId, data);
  `);
  // Série é a identidade forte quando existe, mas só dentro do mesmo
  // cliente: fabricantes diferentes repetem numeração.
  alterSafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_equip_serie_unica
             ON equipamentos(clienteId, numeroSerie)
             WHERE numeroSerie IS NOT NULL AND numeroSerie <> ''`);

  // Log de envio das notificações: sem ele, canal fora do ar era
  // indistinguível de "nenhuma regra configurada".
  try { migrarNotificacoesDB(db); } catch { /* idempotente */ }
  alterSafe(`ALTER TABLE contas_a_receber ADD COLUMN osId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_receber ADD COLUMN pedidoId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_receber ADD COLUMN origemTipo TEXT`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_cr_os ON contas_a_receber(osId)`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_cr_pedido ON contas_a_receber(pedidoId)`);
  // Phase 2: link nfse/faturas → OS
  alterSafe(`ALTER TABLE nfse ADD COLUMN osId INTEGER`);
  alterSafe(`ALTER TABLE faturas ADD COLUMN osId INTEGER`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_nfse_os ON nfse(osId)`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_faturas_os ON faturas(osId)`);
  // Catálogo de serviços (cadastro-servicos.html): item da OS pode referenciar
  // um serviço para herdar fiscais (cNBS, cTribNac) na emissão da NFS-e.
  alterSafe(`ALTER TABLE os_itens_servicos ADD COLUMN servicoId INTEGER`);

  // Aquisição de terceiro: oficina compra peça/serviço de fora para a OS.
  // Gera contas_a_pagar vinculado ao item; CR cobrada do cliente fica intacta.
  for (const tab of ['os_itens_pecas', 'os_itens_servicos']) {
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN compradoTerceiro INTEGER DEFAULT 0`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN fornecedorId INTEGER`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN custoTerceiro REAL`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN notaFiscalTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN dataCompraTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN formaPagamentoTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN dataVencimentoTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN contasPagarId INTEGER`);
  }
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_osip_terceiro ON os_itens_pecas(compradoTerceiro)`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_osis_terceiro ON os_itens_servicos(compradoTerceiro)`);
  alterSafe(`ALTER TABLE contas_a_pagar ADD COLUMN osId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_pagar ADD COLUMN osItemId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_pagar ADD COLUMN osItemTipo TEXT`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_cp_os ON contas_a_pagar(osId)`);
}

function gerarNumero(db) {
  const ano = new Date().getFullYear();
  const prefix = `OS-${ano}-`;
  const u = db.prepare(`SELECT numero FROM os_ordens WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix+'%');
  let n = 1;
  if (u) { const m = u.numero.match(/-(\d+)$/); if (m) n = parseInt(m[1],10) + 1; }
  return prefix + String(n).padStart(4, '0');
}

// Phase 3: calcula statusFiscal agregado considerando serviços + peças + estado das notas
function recalcStatusFiscal(db, osId) {
  const os = db.prepare('SELECT naoEmitirNFe, valorPecas, valorServicos FROM os_ordens WHERE id = ?').get(osId);
  if (!os) return null;
  const temServicos = (Number(os.valorServicos) || 0) > 0;
  const temPecas = (Number(os.valorPecas) || 0) > 0;
  const nfse = db.prepare(`SELECT status FROM nfse WHERE osId = ? ORDER BY id DESC LIMIT 1`).get(osId);
  const fatura = db.prepare(`SELECT statusSefaz FROM faturas WHERE osId = ? ORDER BY id DESC LIMIT 1`).get(osId);

  const nfseOk = nfse && (nfse.status === 'autorizada' || nfse.status === 'nao_fiscal');
  const nfseReje = nfse && nfse.status === 'rejeitada';
  const nfeOk = fatura && (fatura.statusSefaz === 'autorizada' || fatura.statusSefaz === 'nao_fiscal');
  const nfeReje = fatura && fatura.statusSefaz === 'rejeitada';
  const ambosInternos = nfse?.status === 'nao_fiscal' && fatura?.statusSefaz === 'nao_fiscal';

  let status;
  if (temServicos && temPecas) {
    if (nfseOk && nfeOk) status = ambosInternos ? 'nao_fiscal_mista' : 'mista_ok';
    else if (nfseOk || nfeOk) status = 'mista_parcial';
    else if (nfseReje || nfeReje) status = 'rejeitada';
    else status = 'pendente';
  } else if (temServicos) {
    if (nfseOk) status = nfse.status === 'nao_fiscal' ? 'nao_fiscal_nfse' : 'nfse_autorizada';
    else if (nfseReje) status = 'rejeitada';
    else status = 'pendente';
  } else if (temPecas) {
    if (nfeOk) status = fatura.statusSefaz === 'nao_fiscal' ? 'nao_fiscal_nfe' : 'nfe_autorizada';
    else if (nfeReje) status = 'rejeitada';
    else status = 'pendente';
  } else {
    status = 'pendente';
  }
  db.prepare(`UPDATE os_ordens SET statusFiscal = ? WHERE id = ?`).run(status, osId);
  return status;
}

// Cláusula única do "só confirmado conta". Fica em constante para que quem
// mexer no financeiro depois não precise lembrar de repetir o filtro.
const SO_CONFIRMADOS = ` AND COALESCE(situacao,'confirmado') = 'confirmado'`;

/**
 * Condição de pagamento válida para esta OS.
 *
 * A política vinculada à pessoa é OBRIGATÓRIA: se o cliente tem condição
 * negociada, é ela que vale e nenhuma outra é aceita. Sem vínculo, qualquer
 * política ativa de vendas serve.
 *
 * @returns {{politica:object|null, erro:string|null}}
 */
function resolverPolitica(db, clienteId, politicaPrazoId) {
  const { politicaDaPessoa, valePara } = require('./politicas-prazo');
  const daPessoa = politicaDaPessoa(db, clienteId);
  const obrigatoria = daPessoa && valePara(daPessoa, 'vendas') ? daPessoa : null;

  if (!politicaPrazoId) {
    // Sem escolha explícita: usa a do cliente quando existe.
    return { politica: obrigatoria, erro: null };
  }
  const escolhida = db.prepare('SELECT * FROM politicas_prazo WHERE id = ? AND ativo = 1').get(Number(politicaPrazoId));
  if (!escolhida) return { politica: null, erro: 'Condição de pagamento inválida ou inativa' };
  if (!escolhida.aplicaVendas) return { politica: null, erro: `Condição "${escolhida.nome}" não se aplica a vendas` };
  if (obrigatoria && obrigatoria.id !== escolhida.id) {
    return { politica: null, erro: `Cliente tem condição obrigatória "${obrigatoria.nome}" — não é possível usar outra` };
  }
  return { politica: escolhida, erro: null };
}

/** Meios aceitos por uma política; null = sem restrição. */
function meiosDaPolitica(politica) {
  if (!politica || !politica.meiosPermitidos) return null;
  try {
    const l = JSON.parse(politica.meiosPermitidos);
    return Array.isArray(l) && l.length ? l : null;
  } catch { return null; }
}

/**
 * Regra de comportamento da OS — quem manda é o Tipo de Operação, herdado do
 * Tipo de OS (os_tipos.tipoOperacaoPadraoId).
 *
 * Antes a mesma decisão saía de quatro lugares em cascata
 * (tipoOperacao.emiteNFe > os_tipos.modoFiscal > os_ordens.ambienteFiscal >
 * checkbox naoEmitirNFe), o que permitia estados contraditórios e escondia o
 * `geraFinanceiro` — que não era consultado em lugar nenhum, fazendo OS de
 * garantia gerar cobrança. Agora é uma fonte só.
 *
 * @returns {{emiteNFe:boolean, geraFinanceiro:boolean, codigo:string|null}}
 */
function regraDaOS(db, os) {
  if (os && os.tipoOperacaoId) {
    const op = db.prepare('SELECT codigo, emiteNFe, geraFinanceiro FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId);
    if (op) return { emiteNFe: !!op.emiteNFe, geraFinanceiro: !!op.geraFinanceiro, codigo: op.codigo };
  }
  // OS anterior à migração, sem operação: mantém o comportamento histórico
  // (emite e cobra), em vez de silenciosamente parar de faturar.
  return { emiteNFe: true, geraFinanceiro: true, codigo: null };
}

function recalcTotais(db, osId) {
  const p = db.prepare(`SELECT COALESCE(SUM(valorTotal),0) AS t FROM os_itens_pecas WHERE osId = ?${SO_CONFIRMADOS}`).get(osId).t;
  const s = db.prepare(`SELECT COALESCE(SUM(valorTotal),0) AS t FROM os_itens_servicos WHERE osId = ?${SO_CONFIRMADOS}`).get(osId).t;
  // valorPecas/valorServicos ficam BRUTOS (já líquidos do desconto de item, que
  // está embutido no valorTotal da linha). O desconto de capa entra só no
  // valorTotal — quem fatura o rateia entre os dois lados.
  const d = Math.min(
    Number(db.prepare('SELECT COALESCE(valorDesconto,0) AS d FROM os_ordens WHERE id = ?').get(osId).d) || 0,
    p + s
  );
  db.prepare('UPDATE os_ordens SET valorPecas = ?, valorServicos = ?, valorTotal = ? WHERE id = ?')
    .run(p, s, p + s - d, osId);
}

// Deslocamento cobrável: é o Tipo de OS que decide se o trajeto vira dinheiro.
//
// A linha vive em os_itens_servicos com origem='deslocamento', e não num campo
// à parte, porque assim ela entra no total, na NFS-e e na conta a receber pelo
// mesmo caminho de qualquer outro serviço — sem ninguém precisar lembrar de
// lançá-la à mão, que era a instrução que a própria tela dava.
//
// os_ordens.valorDeslocamento continua espelhando o valor, para o histórico e
// os relatórios que já leem a coluna.
//
// Não chama recalcTotais: quem chama decide quando recalcular (às vezes há
// outras mudanças na mesma transação).
function sincronizarDeslocamento(db, osId) {
  const os = db.prepare('SELECT tipoId, kmPercorrido, emGarantia FROM os_ordens WHERE id = ?').get(osId);
  if (!os) return;

  const remover = () => {
    db.prepare("DELETE FROM os_itens_servicos WHERE osId = ? AND origem = 'deslocamento'").run(osId);
    db.prepare('UPDATE os_ordens SET valorDeslocamento = NULL WHERE id = ?').run(osId);
  };

  const tipo = os.tipoId
    ? db.prepare(`SELECT deslocamentoModo, deslocamentoValorKm, deslocamentoValorFixo
                    FROM os_tipos WHERE id = ?`).get(os.tipoId)
    : null;
  const modo = (tipo && tipo.deslocamentoModo) || 'manual';

  // 'manual' é o comportamento histórico: a linha é do usuário e nada aqui
  // pode tocá-la. É o default, então tipo antigo não muda de comportamento.
  if (modo === 'manual') return;

  // Garantia não cobra deslocamento, seja qual for a regra do tipo — mesma
  // lógica que já força OS-GARANTIA no tipo de operação.
  if (modo === 'nao-cobrar' || os.emGarantia) { remover(); return; }

  const km = Number(os.kmPercorrido) || 0;
  let valor = 0;
  let descricao = 'Deslocamento';
  if (modo === 'por-km') {
    const vKm = Number(tipo.deslocamentoValorKm) || 0;
    valor = Number((km * vKm).toFixed(2));
    descricao = `Deslocamento (${km} km)`;
  } else if (modo === 'valor-fixo') {
    valor = Number(Number(tipo.deslocamentoValorFixo || 0).toFixed(2));
  }

  // Sem km lançado ainda, ou valor não configurado: não existe linha de zero.
  if (valor <= 0) { remover(); return; }

  const atual = db.prepare("SELECT id FROM os_itens_servicos WHERE osId = ? AND origem = 'deslocamento'").get(osId);
  if (atual) {
    db.prepare('UPDATE os_itens_servicos SET descricao = ?, valorTotal = ? WHERE id = ?')
      .run(descricao, valor, atual.id);
  } else {
    db.prepare(`INSERT INTO os_itens_servicos (osId, descricao, valorTotal, origem, situacao)
                VALUES (?, ?, ?, 'deslocamento', 'confirmado')`).run(osId, descricao, valor);
  }
  db.prepare('UPDATE os_ordens SET valorDeslocamento = ? WHERE id = ?').run(valor, osId);
}

// ==================== QUEM PAGA A OS ====================
//
// Por padrão quem paga é o cliente da OS. O Tipo pode dizer que a conta vai
// para outro: garantia de fábrica cobra do fabricante, sinistro cobra da
// seguradora. Quem é esse pagador não cabe no Tipo — muda a cada OS (cada
// sinistro tem sua seguradora), então mora em os_ordens.pagadorId.
//
// O pagador entra no pedido, nas contas a receber e como tomador da NFS-e:
// é a pessoa contra quem o documento é emitido.
const MODOS_FATURAR_PARA = ['cliente', 'fabrica', 'seguradora', 'outro'];
const ROTULO_FATURAR_PARA = {
  cliente: 'o cliente', fabrica: 'a fábrica',
  seguradora: 'a seguradora', outro: 'um terceiro',
};

// Devolve { pagadorId } ou { erro }. Falha explícita quando o tipo manda
// faturar contra outro e ninguém foi informado — emitir nota para o cliente
// nesse caso seria cobrar de quem não deve.
function resolverPagadorOS(db, os, tipo) {
  const modo = (tipo && tipo.faturarPara) || 'cliente';
  if (modo === 'cliente') return { pagadorId: os.clienteId };
  if (!os.pagadorId) {
    return { erro: `Tipo "${tipo.nome}" fatura contra ${ROTULO_FATURAR_PARA[modo] || 'outro'} — informe quem paga antes de faturar` };
  }
  const p = db.prepare('SELECT id FROM pessoas WHERE id = ?').get(os.pagadorId);
  if (!p) return { erro: 'Pagador informado na OS não existe mais no cadastro' };
  return { pagadorId: os.pagadorId };
}

// ==================== PREÇO DO SERVIÇO ====================
//
// O Tipo de OS decide de onde sai o valor da linha de serviço:
//   'livre'         — precedência histórica: valorTotal > horas×valorHora >
//                     valorPadrao do catálogo. É o default.
//   'preco-fixo'    — sempre o valorPadrao do catálogo
//   'horas-x-valor' — horas apontadas × valor hora (do item ou do tipo)
//   'tempo-padrao'  — tempoPadraoHoras do catálogo × valor hora
//
// permiteAlterarCalculoServico=0 recusa um valorTotal digitado que
// contrarie a regra — senão a regra é só sugestão.
const MODOS_CALCULO_SERVICO = ['livre', 'preco-fixo', 'horas-x-valor', 'tempo-padrao'];

function calcularValorServico({ modo, tipo, catalogo, horas, valorHora, valorTotal }) {
  const informado = valorTotal != null && valorTotal !== '' ? Number(valorTotal) : null;
  const h = horas != null && horas !== '' ? Number(horas) : null;
  const vh = valorHora != null && valorHora !== ''
    ? Number(valorHora)
    : (tipo && tipo.servicoValorHoraPadrao != null ? Number(tipo.servicoValorHoraPadrao) : null);

  if (modo === 'livre') {
    if (informado != null) return { total: informado };
    if (h && vh) return { total: h * vh, valorHora: vh };
    if (catalogo && catalogo.valorPadrao != null) return { total: Number(catalogo.valorPadrao) };
    return { erro: 'Informe valorTotal, horas+valorHora ou vincule um serviço com valor padrão' };
  }

  // Um valor digitado só vale se o tipo deixar alterar o cálculo.
  const podeAlterar = !tipo || tipo.permiteAlterarCalculoServico == null || !!tipo.permiteAlterarCalculoServico;
  if (informado != null) {
    if (podeAlterar) return { total: informado };
    return { erro: `Tipo "${tipo.nome}" não permite alterar o valor calculado do serviço` };
  }

  if (modo === 'preco-fixo') {
    if (!catalogo || catalogo.valorPadrao == null) {
      return { erro: 'Preço fixo: vincule um serviço de catálogo com valor padrão' };
    }
    return { total: Number(catalogo.valorPadrao) };
  }
  if (modo === 'horas-x-valor') {
    if (!(h > 0)) return { erro: 'Cálculo por horas: informe as horas' };
    if (!(vh > 0)) return { erro: 'Cálculo por horas: sem valor hora no item nem no Tipo de OS' };
    return { total: Number((h * vh).toFixed(2)), valorHora: vh };
  }
  if (modo === 'tempo-padrao') {
    if (!catalogo || !(Number(catalogo.tempoPadraoHoras) > 0)) {
      return { erro: 'Tempo padrão: vincule um serviço de catálogo com tempo padrão' };
    }
    if (!(vh > 0)) return { erro: 'Tempo padrão: sem valor hora no item nem no Tipo de OS' };
    const ht = Number(catalogo.tempoPadraoHoras);
    return { total: Number((ht * vh).toFixed(2)), horas: ht, valorHora: vh };
  }
  return { erro: `Modo de cálculo desconhecido: ${modo}` };
}

// ==================== ENCERRAMENTO DA OS ====================
//
// O Tipo de OS decide o que fazer com cada pendência na hora de concluir.
// Três regras possíveis:
//   'permitido'     — conclui e ignora (comportamento anterior à Fase 3)
//   'venda-perdida' — conclui e registra o item em vendas_perdidas, para o
//                     que o cliente não aprovou não sumir do relatório
//   'bloqueado'     — recusa a conclusão e devolve a lista do que falta
//
// Só peça e serviço aceitam 'venda-perdida': as outras pendências não são
// item que o cliente deixou de levar, então não há perda a registrar.
const REGRAS_ENCERRAMENTO = ['permitido', 'venda-perdida', 'bloqueado'];
const REGRAS_ENCERRAMENTO_SEM_PERDA = ['permitido', 'bloqueado'];

const CATEGORIAS_ENCERRAMENTO = [
  { chave: 'encerraPecaPendente',      rotulo: 'peça orçada não confirmada',        perda: true },
  { chave: 'encerraServicoPendente',   rotulo: 'serviço orçado não confirmado',     perda: true },
  { chave: 'encerraTerceiroPendente',  rotulo: 'item de terceiro sem custo',        perda: false },
  { chave: 'encerraKmPendente',        rotulo: 'km não informado',                  perda: false },
  { chave: 'encerraApontamentoAberto', rotulo: 'apontamento em aberto',             perda: false },
];

// Levanta o que está pendente na OS, por categoria. Leitura pura.
function coletarPendenciasOS(db, os, tipo) {
  const out = {};

  out.encerraPecaPendente = db.prepare(`
    SELECT pi.id, pi.descricao, pi.quantidade, pi.valorUnitario, pi.produtoId
      FROM os_itens_pecas pi
     WHERE pi.osId = ? AND COALESCE(pi.situacao,'confirmado') = 'orcado'
     ORDER BY pi.id`).all(os.id);

  out.encerraServicoPendente = db.prepare(`
    SELECT id, descricao, valorTotal
      FROM os_itens_servicos
     WHERE osId = ? AND COALESCE(situacao,'confirmado') = 'orcado'
       AND COALESCE(compradoTerceiro,0) = 0
     ORDER BY id`).all(os.id);

  // Terceiro sem custo lançado: a OS fecha e o AP do fornecedor nunca nasce,
  // então o custo desaparece da margem.
  const terceiroPecas = db.prepare(`
    SELECT id, descricao FROM os_itens_pecas
     WHERE osId = ? AND compradoTerceiro = 1 AND (custoTerceiro IS NULL OR custoTerceiro = 0)`).all(os.id);
  const terceiroServicos = db.prepare(`
    SELECT id, descricao FROM os_itens_servicos
     WHERE osId = ? AND compradoTerceiro = 1 AND (custoTerceiro IS NULL OR custoTerceiro = 0)`).all(os.id);
  out.encerraTerceiroPendente = [...terceiroPecas, ...terceiroServicos];

  // Só é pendência quando o tipo cobra por km: aí o km vazio significa
  // deslocamento não cobrado.
  out.encerraKmPendente = (tipo && tipo.deslocamentoModo === 'por-km' && !(Number(os.kmPercorrido) > 0))
    ? [{ descricao: 'Quilometragem não informada' }]
    : [];

  out.encerraApontamentoAberto = db.prepare(`
    SELECT a.id, a.dataInicio, u.username AS tecnico
      FROM os_apontamentos a
      LEFT JOIN users u ON u.id = a.tecnicoId
     WHERE a.osId = ? AND a.dataFim IS NULL
     ORDER BY a.id`).all(os.id);

  return out;
}

// Registra em vendas_perdidas os itens que o cliente não aprovou. Roda dentro
// da transação de conclusão. Motivo 'desistencia' — o orçamento existiu e o
// cliente não seguiu com ele.
function registrarPerdasDaOS(db, os, itens, usuario) {
  if (!itens.length) return 0;
  const data = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ins = db.prepare(`INSERT INTO vendas_perdidas
    (data, produtoId, descricaoLivre, quantidade, precoAlvo, motivo, clienteId,
     origem, observacao, usuario)
    VALUES (?, ?, ?, ?, ?, 'desistencia', ?, 'os_item', ?, ?)`);
  for (const it of itens) {
    const qtd = Number(it.quantidade) > 0 ? Number(it.quantidade) : 1;
    const preco = it.valorUnitario != null ? Number(it.valorUnitario)
                : it.valorTotal != null ? Number(it.valorTotal) / qtd
                : null;
    ins.run(
      data,
      it.produtoId || null,
      it.produtoId ? null : (it.descricao || 'Item da OS'),
      qtd,
      preco,
      os.clienteId || null,
      `Item orçado e não confirmado na OS ${os.numero}`,
      usuario || null,
    );
  }
  return itens.length;
}

// Ratea o desconto de capa entre peças e serviços, proporcional ao valor de
// cada lado. Mesmo algoritmo do frete da NF-e (nfe-emit-routes.js): o resto
// dos centavos cai no último para a soma fechar exatamente com o desconto.
function ratearDesconto(valorPecas, valorServicos, desconto) {
  const base = valorPecas + valorServicos;
  if (!desconto || base <= 0) return { pecas: 0, servicos: 0 };
  const d = Math.min(desconto, base);
  const dPecas = Number((d * (valorPecas / base)).toFixed(2));
  return { pecas: dPecas, servicos: Number((d - dPecas).toFixed(2)) };
}

// Cria mov_entrada para peça/serviço terceiro com produtoId (catálogo).
// Origem='os_terceiro' não dispara atualização de precoCusto (regra:
// apenas NF-e formal atualiza preço de custo do produto).
function lancarEntradaTerceiroPeca(db, osId, item) {
  if (!item.compradoTerceiro || !item.produtoId) return null;
  const data = item.dataCompraTerceiro || new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT INTO movimentacoes_estoque
    (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, motivo, usuario, depositoId)
    VALUES (?, 'entrada', ?, ?, 'os_terceiro', ?, ?, ?, 'Aquisição p/ OS', NULL, ?)`).run(
    item.produtoId, Number(item.quantidade), Number(item.custoTerceiro),
    osId, `OS terceiro item ${item.id}`, data,
    resolverDeposito(db, {
      depositoId: (db.prepare('SELECT depositoId FROM os_ordens WHERE id = ?').get(osId) || {}).depositoId,
      osId, produtoId: item.produtoId }),
  );
  return r.lastInsertRowid;
}

// Saída para peças terceiras com produtoId no momento da conclusão da OS.
// Chamada ao lado de consumirReservasOS — terceiros não têm reserva.
function consumirTerceirosPecasOS(db, osId, dataConsumo, usuario) {
  const itens = db.prepare(`SELECT * FROM os_itens_pecas
    WHERE osId = ? AND compradoTerceiro = 1 AND produtoId IS NOT NULL AND movSaidaId IS NULL`).all(osId);
  for (const it of itens) {
    const r = db.prepare(`INSERT INTO movimentacoes_estoque
      (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, motivo, usuario, depositoId)
      VALUES (?, 'saida', ?, ?, 'os', ?, 'OS terceiro consumido', ?, 'Consumo OS', ?, ?)`).run(
      it.produtoId, Number(it.quantidade), Number(it.custoTerceiro),
      osId, dataConsumo, usuario || null,
      resolverDeposito(db, {
        depositoId: (db.prepare('SELECT depositoId FROM os_ordens WHERE id = ?').get(osId) || {}).depositoId,
        osId, produtoId: it.produtoId }),
    );
    db.prepare('UPDATE os_itens_pecas SET movSaidaId = ? WHERE id = ?').run(r.lastInsertRowid, it.id);
  }
}

// Cria/atualiza o AP vinculado a um item de OS marcado como "comprado de
// terceiro". Retorna o id do AP (novo ou existente) ou null se item não
// é terceiro. Se o item perdeu a flag, cancela/deleta o AP antigo.
//
// Pré-requisitos validados aqui:
//   - compradoTerceiro requer fornecedorId + custoTerceiro
//   - se já existe AP e está pago, lança erro pra não silenciosamente sobrescrever
function sincronizarAPDoItem(db, osId, osItemId, osItemTipo, item) {
  const apIdAtual = item.contasPagarId || null;
  if (!item.compradoTerceiro) {
    if (apIdAtual) {
      if (contaAPagarTemPagamento(db, apIdAtual)) {
        throw new Error('Item já tem AP pago — não é possível desmarcar como terceiro');
      }
      removerContaAPagarSeAberta(db, apIdAtual);
    }
    return null;
  }
  if (!item.fornecedorId || item.custoTerceiro == null) {
    throw new Error('Aquisição de terceiro exige fornecedorId e custoTerceiro');
  }
  const ordem = db.prepare('SELECT numero FROM os_ordens WHERE id = ?').get(osId);
  const descricao = `Aquisição p/ OS ${ordem.numero} — ${item.descricao || ''}`.trim();
  const venc = item.dataVencimentoTerceiro || item.dataCompraTerceiro || new Date().toISOString().slice(0,10);
  const payload = {
    fornecedorId: item.fornecedorId,
    descricao,
    valor: item.custoTerceiro,
    dataEmissao: item.dataCompraTerceiro || null,
    dataVencimento: venc,
    formaPagamento: item.formaPagamentoTerceiro || null,
    observacoes: item.notaFiscalTerceiro ? `NF/cupom: ${item.notaFiscalTerceiro}` : null,
    osId, osItemId, osItemTipo,
  };
  if (apIdAtual) {
    if (contaAPagarTemPagamento(db, apIdAtual)) {
      throw new Error('AP do item já foi pago — edite manualmente em Contas a Pagar');
    }
    const ok = atualizarContaAPagarSeAberta(db, apIdAtual, payload);
    if (!ok) {
      // AP não-aberto (cancelado por outra via): cria novo
      return criarContaAPagar(db, payload);
    }
    return apIdAtual;
  }
  return criarContaAPagar(db, payload);
}

function registrarRotasOS(app, db) {
  migrarDB(db);

  // Migração lazy por-tenant: registrarRotasOS roda em contexto BOOT
  // (proxy é no-op), então tenants provisionados antes do módulo OS podem
  // não ter as tabelas. Garante criação na 1ª chamada por-tenant.
  const tenantsMigrados = new WeakSet();
  function ensureMigrated(req, res, next) {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        migrarDB(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
  app.use('/api/os', ensureMigrated);
  app.use('/api/os-tipos', ensureMigrated);
  app.use('/api/equipamentos', ensureMigrated);

  // ==================== EQUIPAMENTOS ====================

  const normSerie = s => String(s || '').trim().toUpperCase().replace(/[\s\-._/]/g, '');

  /**
   * Acha o equipamento do cliente ou cria um. Série manda: é a identidade
   * forte. Sem série, cai em marca+modelo+descrição, que é o melhor que
   * texto livre permite.
   *
   * A comparação de série ignora espaço, hífen e ponto — "AB-123" e
   * "ab123" são o mesmo aparelho, e era exatamente isso que fazia a
   * garantia por string não achar nada.
   */
  function acharOuCriarEquipamento(db, { clienteId, descricao, marca, modelo, numeroSerie, produtoId, usuario }) {
    const serie = String(numeroSerie || '').trim();
    if (serie) {
      const alvo = normSerie(serie);
      const candidatos = db.prepare(`SELECT * FROM equipamentos WHERE numeroSerie IS NOT NULL AND numeroSerie <> ''`).all();
      const achado = candidatos.find(e => normSerie(e.numeroSerie) === alvo
        && (e.clienteId === clienteId || e.clienteId == null));
      if (achado) {
        // Equipamento sem dono ainda, ou que mudou de mãos.
        if (achado.clienteId == null && clienteId) {
          db.prepare('UPDATE equipamentos SET clienteId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
            .run(clienteId, achado.id);
        }
        return { id: achado.id, criado: false };
      }
      // Série existe em OUTRO cliente: é troca de dono, não duplicidade.
      const deOutro = candidatos.find(e => normSerie(e.numeroSerie) === alvo);
      if (deOutro && clienteId) {
        db.prepare('UPDATE equipamentos SET clienteId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
          .run(clienteId, deOutro.id);
        db.prepare(`INSERT INTO equipamento_eventos (equipamentoId, tipo, descricao, clienteAnteriorId, clienteNovoId, usuario)
          VALUES (?, 'troca_dono', ?, ?, ?, ?)`)
          .run(deOutro.id, 'Equipamento passou a atender outro cliente', deOutro.clienteId, clienteId, usuario || null);
        return { id: deOutro.id, criado: false, trocouDono: true };
      }
    } else {
      // Sem série: casa por marca+modelo+descrição dentro do cliente.
      const achado = db.prepare(`SELECT * FROM equipamentos
        WHERE clienteId IS ? AND (numeroSerie IS NULL OR numeroSerie = '')
          AND LOWER(IFNULL(marca,'')) = LOWER(?) AND LOWER(IFNULL(modelo,'')) = LOWER(?)
          AND LOWER(IFNULL(descricao,'')) = LOWER(?) LIMIT 1`)
        .get(clienteId ?? null, marca || '', modelo || '', descricao || '');
      if (achado) return { id: achado.id, criado: false };
    }

    const r = db.prepare(`INSERT INTO equipamentos
      (clienteId, descricao, marca, modelo, numeroSerie, produtoId)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(clienteId || null,
           (descricao || '').trim() || [marca, modelo].filter(Boolean).join(' ') || 'Equipamento sem descrição',
           (marca || '').trim() || null, (modelo || '').trim() || null,
           serie || null, produtoId || null);
    db.prepare(`INSERT INTO equipamento_eventos (equipamentoId, tipo, descricao, clienteNovoId, usuario)
      VALUES (?, 'cadastro', 'Equipamento cadastrado', ?, ?)`)
      .run(r.lastInsertRowid, clienteId || null, usuario || null);
    return { id: r.lastInsertRowid, criado: true };
  }

  /** Histórico de OS do equipamento + reincidência + garantia vigente. */
  function fichaEquipamento(db, equipamentoId) {
    const eq = db.prepare(`SELECT e.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
                                  pr.sku AS produtoSku
      FROM equipamentos e
      LEFT JOIN pessoas p ON p.id = e.clienteId
      LEFT JOIN produtos pr ON pr.id = e.produtoId
      WHERE e.id = ?`).get(equipamentoId);
    if (!eq) return null;

    const ordens = db.prepare(`SELECT o.id, o.numero, o.status, o.titulo, o.defeitoRelatado, o.solucao,
             o.dataAbertura, o.dataConclusao, o.dataFaturamento, o.garantiaDias, o.valorTotal,
             o.emGarantia, t.username AS tecnicoNome
      FROM os_ordens o LEFT JOIN users t ON t.id = o.tecnicoId
      WHERE o.equipamentoId = ? ORDER BY o.dataAbertura DESC`).all(equipamentoId);

    const agora = Date.now();
    // Garantia vigente = alguma OS faturada cujo prazo ainda não venceu.
    // Antes isso dependia de a série ter sido digitada igual nas duas OS.
    const garantias = ordens
      .filter(o => o.status === 'faturada' && o.dataFaturamento && o.garantiaDias > 0)
      .map(o => {
        const limite = new Date(o.dataFaturamento).getTime() + o.garantiaDias * 86400000;
        return { osId: o.id, numero: o.numero, ate: new Date(limite).toISOString().slice(0, 10),
                 diasRestantes: Math.floor((limite - agora) / 86400000), vigente: limite >= agora };
      });
    const garantiaVigente = garantias.find(g => g.vigente) || null;

    // Reincidência: retorno em até 90 dias da conclusão anterior é o sinal
    // clássico de serviço que não resolveu.
    const concluidas = ordens.filter(o => o.dataConclusao).sort((a, b) => a.dataConclusao < b.dataConclusao ? -1 : 1);
    let retornosRapidos = 0, menorIntervalo = null;
    for (let i = 1; i < concluidas.length; i++) {
      const dias = Math.floor((new Date(concluidas[i].dataAbertura).getTime()
        - new Date(concluidas[i - 1].dataConclusao).getTime()) / 86400000);
      if (dias >= 0 && dias <= 90) retornosRapidos++;
      if (dias >= 0 && (menorIntervalo == null || dias < menorIntervalo)) menorIntervalo = dias;
    }

    const eventos = db.prepare(`SELECT ev.*, pa.razaoSocial AS clienteAnteriorNome, pn.razaoSocial AS clienteNovoNome
      FROM equipamento_eventos ev
      LEFT JOIN pessoas pa ON pa.id = ev.clienteAnteriorId
      LEFT JOIN pessoas pn ON pn.id = ev.clienteNovoId
      WHERE ev.equipamentoId = ? ORDER BY ev.data DESC, ev.id DESC`).all(equipamentoId);

    return {
      equipamento: eq, ordens, eventos, garantias, garantiaVigente,
      resumo: {
        totalOS: ordens.length,
        abertas: ordens.filter(o => !['faturada', 'cancelada', 'concluida'].includes(o.status)).length,
        valorAcumulado: Number(ordens.filter(o => o.status === 'faturada')
          .reduce((s, o) => s + (o.valorTotal || 0), 0).toFixed(2)),
        retornosRapidos, menorIntervaloDias: menorIntervalo,
        primeiraOS: ordens.length ? ordens[ordens.length - 1].dataAbertura : null,
        ultimaOS: ordens.length ? ordens[0].dataAbertura : null,
      },
    };
  }

  app.get('/api/equipamentos', (req, res) => {
    try {
      const { clienteId, q, ativo, limit } = req.query;
      let sql = `SELECT e.*, p.razaoSocial AS clienteNome,
        (SELECT COUNT(*) FROM os_ordens o WHERE o.equipamentoId = e.id) AS totalOS,
        (SELECT MAX(o.dataAbertura) FROM os_ordens o WHERE o.equipamentoId = e.id) AS ultimaOS
        FROM equipamentos e LEFT JOIN pessoas p ON p.id = e.clienteId WHERE 1=1`;
      const params = [];
      if (clienteId) { sql += ' AND e.clienteId = ?'; params.push(Number(clienteId)); }
      if (ativo !== undefined) { sql += ' AND e.ativo = ?'; params.push(Number(ativo)); }
      if (q) {
        sql += ` AND (e.descricao LIKE ? OR e.marca LIKE ? OR e.modelo LIKE ?
                      OR e.numeroSerie LIKE ? OR e.patrimonio LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like, like, like);
      }
      sql += ' ORDER BY e.descricao, e.id LIMIT ?';
      params.push(Math.min(Number(limit) || 200, 500));
      res.json({ success: true, equipamentos: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/equipamentos/:id', (req, res) => {
    try {
      const ficha = fichaEquipamento(db, Number(req.params.id));
      if (!ficha) return res.status(404).json({ success: false, error: 'Equipamento não encontrado' });
      res.json({ success: true, ...ficha });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/equipamentos', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.descricao && !b.marca && !b.modelo) {
        return res.status(400).json({ success: false, error: 'Informe ao menos descrição, marca ou modelo' });
      }
      const out = acharOuCriarEquipamento(db, {
        clienteId: b.clienteId ? Number(b.clienteId) : null,
        descricao: b.descricao, marca: b.marca, modelo: b.modelo,
        numeroSerie: b.numeroSerie, produtoId: b.produtoId ? Number(b.produtoId) : null,
        usuario: req.user?.username || req.session?.username || null,
      });
      // Campos que só o cadastro tem — acharOuCriar cuida da identidade.
      const extras = ['patrimonio', 'dataAquisicao', 'garantiaFabricanteAte', 'observacoes', 'serialNumberId'];
      const sets = extras.filter(k => b[k] !== undefined);
      if (sets.length) {
        db.prepare(`UPDATE equipamentos SET ${sets.map(k => `${k} = ?`).join(', ')},
          dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(...sets.map(k => b[k] === '' ? null : b[k]), out.id);
      }
      logAction(db, req, out.criado ? 'criar' : 'reutilizar', 'equipamento', out.id, { numeroSerie: b.numeroSerie });
      res.json({ success: true, ...out, equipamento: db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(out.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/equipamentos/:id', (req, res) => {
    try {
      const eq = db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(req.params.id);
      if (!eq) return res.status(404).json({ success: false, error: 'Equipamento não encontrado' });
      const campos = ['descricao', 'marca', 'modelo', 'numeroSerie', 'patrimonio', 'produtoId',
                      'serialNumberId', 'dataAquisicao', 'garantiaFabricanteAte', 'observacoes', 'ativo', 'clienteId'];
      const sets = campos.filter(k => req.body[k] !== undefined);
      if (!sets.length) return res.json({ success: true, equipamento: eq });

      // Troca de dono é evento, não um UPDATE silencioso.
      if (req.body.clienteId !== undefined && Number(req.body.clienteId) !== eq.clienteId) {
        db.prepare(`INSERT INTO equipamento_eventos (equipamentoId, tipo, descricao, clienteAnteriorId, clienteNovoId, usuario)
          VALUES (?, 'troca_dono', ?, ?, ?, ?)`)
          .run(eq.id, req.body.motivoTroca || 'Cliente alterado no cadastro', eq.clienteId,
               req.body.clienteId ? Number(req.body.clienteId) : null,
               req.user?.username || req.session?.username || null);
      }
      db.prepare(`UPDATE equipamentos SET ${sets.map(k => `${k} = ?`).join(', ')},
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...sets.map(k => req.body[k] === '' ? null : req.body[k]), eq.id);
      logAction(db, req, 'editar', 'equipamento', eq.id, req.body);
      res.json({ success: true, equipamento: db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(eq.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== LISTAGEM ====================

  app.get('/api/os', (req, res) => {
    try {
      const { clienteId, tecnicoId, status, q, dataIni, dataFim, tipoId, limit } = req.query;
      const de = `
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users t ON t.id = o.tecnicoId
        LEFT JOIN os_tipos tp ON tp.id = o.tipoId
        WHERE 1=1
      `;
      let filtros = '';
      const params = [];
      if (clienteId) { filtros += ' AND o.clienteId = ?'; params.push(Number(clienteId)); }
      if (tecnicoId) { filtros += ' AND o.tecnicoId = ?'; params.push(Number(tecnicoId)); }
      if (tipoId)    { filtros += ' AND o.tipoId = ?';    params.push(Number(tipoId)); }
      if (status)    { filtros += ' AND o.status = ?';    params.push(status); }
      if (dataIni)   { filtros += ' AND o.dataAbertura >= ?'; params.push(dataIni); }
      if (dataFim)   { filtros += ' AND o.dataAbertura <= ?'; params.push(dataFim + ' 23:59:59'); }
      // Cliente não entra aqui: quem filtra por cliente é o `clienteId`, por id
      // exato. Ter os dois duplicava o filtro na tela, e o LIKE em razaoSocial
      // ainda casava homônimo que o autocomplete já resolve.
      if (q)         { filtros += ' AND (o.numero LIKE ? OR o.titulo LIKE ? OR o.equipamento LIKE ?)';
                       const like = `%${q}%`; params.push(like, like, like); }

      const colunas = `SELECT o.*, p.razaoSocial AS clienteNome,
                       t.username AS tecnicoNome, t.nome AS tecnicoNomeExibicao,
                       tp.nome AS tipoNome, tp.cor AS tipoCor `;
      const slaFiltro = req.query.sla; // 'risco' | 'atrasado' | 'no-prazo'
      const porPagina = Math.min(500, Math.max(1, Number(limit) || 50));
      const pagina = Math.max(1, Number(req.query.pagina) || 1);

      // Ordenação: whitelist de expressão SQL por chave. Interpolar o nome
      // vindo da query seria injeção — aqui a query só escolhe um item do mapa.
      const ORDENS = {
        numero: 'o.numero', cliente: 'p.razaoSocial', titulo: 'o.titulo',
        tipo: 'tp.nome', tecnico: 'COALESCE(t.nome, t.username)', status: 'o.status',
        prazo: 'o.dataPromessa', aberta: 'o.dataAbertura', total: 'o.valorTotal',
      };
      const colOrd = ORDENS[req.query.ordem] || 'o.id';
      const dirOrd = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const orderBy = ` ORDER BY ${colOrd} ${dirOrd}` + (colOrd === 'o.id' ? '' : ', o.id DESC');

      // Fase 9.4: slaStatus é calculado em JS (não depende do scheduler ter
      // rodado). Por isso o filtro de SLA não cabe no WHERE: com LIMIT/OFFSET
      // no SQL ele filtraria só a página, devolvendo página e total errados.
      // Nesse caso carrega o conjunto filtrado e pagina em memória.
      let ordens, total;
      if (slaFiltro) {
        const todas = db.prepare(colunas + de + filtros + orderBy).all(...params);
        for (const o of todas) o.slaStatus = calcSlaStatus(o);
        const casadas = todas.filter((o) => o.slaStatus === slaFiltro);
        total = casadas.length;
        ordens = casadas.slice((pagina - 1) * porPagina, pagina * porPagina);
      } else {
        total = db.prepare('SELECT COUNT(*) AS n ' + de + filtros).get(...params).n;
        ordens = db.prepare(colunas + de + filtros + orderBy + ' LIMIT ? OFFSET ?')
          .all(...params, porPagina, (pagina - 1) * porPagina);
        for (const o of ordens) o.slaStatus = calcSlaStatus(o);
      }

      const kpis = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='aberta' THEN 1 ELSE 0 END) AS abertas,
          SUM(CASE WHEN status='em-andamento' THEN 1 ELSE 0 END) AS execucao,
          SUM(CASE WHEN status='aguardando-peca' THEN 1 ELSE 0 END) AS aguardandoPeca,
          SUM(CASE WHEN status='concluida' THEN 1 ELSE 0 END) AS concluidas,
          SUM(CASE WHEN status IN ('concluida','faturada') THEN valorTotal ELSE 0 END) AS receita,
          SUM(CASE WHEN status='faturada' AND (statusFiscal IS NULL OR statusFiscal='pendente') THEN 1 ELSE 0 END) AS faturadasSemNota,
          SUM(CASE WHEN status='faturada' AND statusFiscal='mista_parcial' THEN 1 ELSE 0 END) AS mistaParcial,
          SUM(CASE WHEN status='faturada' AND statusFiscal='rejeitada' THEN 1 ELSE 0 END) AS rejeitadas
        FROM os_ordens
      `).get();

      // KPIs SLA — calculados sobre dataset leve (id, status, dataPromessa, dataConclusao)
      const paraSla = db.prepare(`
        SELECT id, status, dataPromessa, dataConclusao FROM os_ordens
        WHERE status NOT IN ('cancelada') AND dataPromessa IS NOT NULL
      `).all();
      const slaKpis = { atrasadas: 0, risco: 0, noPrazo: 0, cumpridas: 0, estouradas: 0 };
      for (const r of paraSla) {
        const s = calcSlaStatus(r);
        if (s === 'atrasado') slaKpis.atrasadas++;
        else if (s === 'risco') slaKpis.risco++;
        else if (s === 'no-prazo') slaKpis.noPrazo++;
        else if (s === 'cumprido') slaKpis.cumpridas++;
        else if (s === 'estourado') slaKpis.estouradas++;
      }
      res.json({
        success: true, ordens, kpis: { ...kpis, ...slaKpis }, status: STATUS,
        total, pagina, porPagina, paginas: Math.max(1, Math.ceil(total / porPagina)),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Precisa vir ANTES de /api/os/:id senão o Express casa com :id='garantia-sugestoes' e devolve 404.
  app.get('/api/os/garantia-sugestoes', (req, res) => {
    try {
      const { clienteId, numeroSerie, marca, modelo, equipamentoId } = req.query;

      // Caminho novo: com o equipamento identificado, a garantia sai do
      // histórico dele. Não depende de o serial ter sido digitado igual,
      // nem de o cliente ser o mesmo cadastro (matriz × filial).
      if (equipamentoId) {
        const ficha = fichaEquipamento(db, Number(equipamentoId));
        if (!ficha) return res.status(404).json({ success: false, error: 'Equipamento não encontrado' });
        return res.json({
          success: true,
          sugestoes: ficha.garantias.filter(g => g.vigente).map(g => {
            const os = ficha.ordens.find(o => o.id === g.osId) || {};
            return { id: g.osId, numero: g.numero, equipamento: ficha.equipamento.descricao,
                     marca: ficha.equipamento.marca, modelo: ficha.equipamento.modelo,
                     numeroSerieEquipamento: ficha.equipamento.numeroSerie,
                     dataFaturamento: os.dataFaturamento, garantiaDias: os.garantiaDias,
                     valorTotal: os.valorTotal, diasRestantes: g.diasRestantes, dentroPrazo: true };
          }),
          fonte: 'equipamento',
        });
      }

      // Caminho legado, por texto — mantido para OS antiga sem equipamento.
      if (!clienteId) return res.status(400).json({ success: false, error: 'clienteId ou equipamentoId obrigatório' });
      const filters = [`clienteId = ?`, `status = 'faturada'`, `dataFaturamento IS NOT NULL`, `garantiaDias > 0`];
      const params = [Number(clienteId)];
      if (numeroSerie) {
        filters.push(`numeroSerieEquipamento = ?`);
        params.push(String(numeroSerie).trim());
      } else if (marca || modelo) {
        if (marca)  { filters.push(`LOWER(IFNULL(marca,'')) = ?`);  params.push(String(marca).trim().toLowerCase()); }
        if (modelo) { filters.push(`LOWER(IFNULL(modelo,'')) = ?`); params.push(String(modelo).trim().toLowerCase()); }
      } else {
        return res.json({ success: true, sugestoes: [] });
      }
      const candidatas = db.prepare(`
        SELECT id, numero, equipamento, marca, modelo, numeroSerieEquipamento,
               dataFaturamento, garantiaDias, valorTotal
        FROM os_ordens
        WHERE ${filters.join(' AND ')}
        ORDER BY dataFaturamento DESC
        LIMIT 10
      `).all(...params);

      const agora = Date.now();
      const sugestoes = candidatas
        .map(c => {
          const base = new Date(c.dataFaturamento).getTime();
          const limite = base + (c.garantiaDias * 24 * 60 * 60 * 1000);
          const diasRestantes = Math.floor((limite - agora) / (24 * 60 * 60 * 1000));
          return { ...c, diasRestantes, dentroPrazo: limite >= agora };
        })
        .filter(c => c.dentroPrazo);

      res.json({ success: true, sugestoes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/os/:id', (req, res) => {
    try {
      const os = db.prepare(`
        SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
               p.email AS clienteEmail, p.telefone AS clienteTelefone,
               t.username AS tecnicoNome, t.nome AS tecnicoNomeExibicao,
               e.descricao AS equipamentoDescricao, e.numeroSerie AS equipamentoSerie,
               e.marca AS equipamentoMarca, e.modelo AS equipamentoModelo,
               ot.nome AS tipoNome, ot.deslocamentoModo, ot.deslocamentoValorKm,
               ot.deslocamentoValorFixo, ot.faturarPara,
               ot.servicoCalculoModo, ot.servicoValorHoraPadrao, ot.permiteAlterarCalculoServico,
               pg.razaoSocial AS pagadorNome, pg.cpfCnpj AS pagadorCpfCnpj
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users t ON t.id = o.tecnicoId
        LEFT JOIN equipamentos e ON e.id = o.equipamentoId
        LEFT JOIN os_tipos ot ON ot.id = o.tipoId
        LEFT JOIN pessoas pg ON pg.id = o.pagadorId
        WHERE o.id = ?
      `).get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
      // Histórico do equipamento junto do detalhe: o técnico precisa saber
      // que o aparelho já voltou antes de começar a diagnosticar.
      let equipamentoFicha = null;
      if (os.equipamentoId) {
        const f = fichaEquipamento(db, os.equipamentoId);
        if (f) equipamentoFicha = {
          equipamento: f.equipamento, resumo: f.resumo, garantiaVigente: f.garantiaVigente,
          historico: f.ordens.filter(o => o.id !== os.id).slice(0, 10),
        };
      }
      const pecas = db.prepare(`
        SELECT pi.*, pr.sku, pr.rastreiaLote, pr.rastreiaSerial, l.numero AS loteNumero,
               f.razaoSocial AS terceiroFornecedorNome,
               cp.status AS terceiroStatusAP, cp.valor AS terceiroValorAP
        FROM os_itens_pecas pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        LEFT JOIN lotes l ON l.id = pi.loteId
        LEFT JOIN pessoas f ON f.id = pi.fornecedorId
        LEFT JOIN contas_a_pagar cp ON cp.id = pi.contasPagarId
        WHERE pi.osId = ? ORDER BY pi.id
      `).all(os.id);
      // Números de série aplicados: serialIds guarda ids, não os números.
      // Sem esta resolução a visão "com nº de série" mostraria ids crus.
      for (const p of pecas) {
        p.seriais = [];
        if (!p.serialIds) continue;
        try {
          const ids = JSON.parse(p.serialIds) || [];
          if (ids.length) {
            p.seriais = db.prepare(
              `SELECT id, numeroSerie FROM serial_numbers WHERE id IN (${ids.map(() => '?').join(',')})`
            ).all(...ids);
          }
        } catch (_) { /* json inválido em linha antiga */ }
      }
      const pecasDefeito = db.prepare(`
        SELECT d.*, pr.sku FROM os_pecas_defeito d
        LEFT JOIN produtos pr ON pr.id = d.produtoId
        WHERE d.osId = ? ORDER BY d.id
      `).all(os.id);
      const servicos = db.prepare(`
        SELECT i.*,
               sc.codigo AS servicoCodigo, sc.nome AS servicoNome,
               sc.cNBS AS servicoCnbs, sc.xNBS AS servicoXnbs,
               sc.codigoTributacaoNacional AS servicoCtribnac,
               f.razaoSocial AS terceiroFornecedorNome,
               cp.status AS terceiroStatusAP, cp.valor AS terceiroValorAP
        FROM os_itens_servicos i
        LEFT JOIN servicos sc ON sc.id = i.servicoId
        LEFT JOIN pessoas f ON f.id = i.fornecedorId
        LEFT JOIN contas_a_pagar cp ON cp.id = i.contasPagarId
        WHERE i.osId = ? ORDER BY i.id
      `).all(os.id);
      const apontamentos = db.prepare(`
        SELECT a.*, u.username AS tecnicoNome
        FROM os_apontamentos a
        LEFT JOIN users u ON u.id = a.tecnicoId
        WHERE a.osId = ? ORDER BY a.dataInicio DESC
      `).all(os.id);
      const contasReceber = db.prepare(`
        SELECT id, descricao, valor, dataVencimento, dataPagamento, status, origemTipo, nfseId, faturaId
        FROM contas_a_receber WHERE osId = ? ORDER BY id
      `).all(os.id);

      // Fase 9.1: inclui checklist, anexos, eventos, tipo e contagem de reservas
      // ativas — tudo em uma chamada só para a UI renderizar as tabs.
      let tipo = null;
      if (os.tipoId) {
        try { tipo = db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(os.tipoId); } catch (_) {}
      }
      let checklist = [], anexos = [], eventos = [];
      try { checklist = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem, id').all(os.id); } catch (_) {}
      try { anexos = db.prepare('SELECT * FROM os_anexos WHERE osId = ? ORDER BY dataUpload DESC').all(os.id); } catch (_) {}
      try {
        eventos = db.prepare('SELECT * FROM os_eventos WHERE osId = ? ORDER BY data DESC, id DESC LIMIT 50').all(os.id);
        eventos = eventos.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
      } catch (_) {}
      let reservasAtivas = 0;
      try {
        reservasAtivas = db.prepare(`SELECT COUNT(*) c FROM reservas_estoque WHERE osId = ? AND status = 'ativa'`).get(os.id).c;
      } catch (_) {}

      // Fase 9.4: slaStatus dinâmico
      os.slaStatus = calcSlaStatus(os);

      res.json({
        success: true, os, pecas, pecasDefeito, servicos, apontamentos, contasReceber,
        tipo, checklist, anexos, eventos, reservasAtivas, equipamentoFicha,
        // A tela mostra o que o tipo determina (emite nota? cobra?) no lugar
        // do antigo checkbox por OS.
        tipoOperacao: os.tipoOperacaoId
          ? db.prepare('SELECT id, codigo, descricao, emiteNFe, geraFinanceiro FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId)
          : null,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CABEÇALHO ====================

  app.post('/api/os', (req, res) => {
    try {
      const {
        clienteId, tecnicoId, titulo, equipamento, marca, modelo, numeroSerieEquipamento,
        equipamentoId: equipamentoIdBody, depositoId: depositoIdBody,
        defeitoRelatado, garantiaDias, observacoes,
        formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
        tipoOperacaoId,
        // Fase 9.1: novos campos
        tipoId, contratoId, oportunidadeId, osPaiId,
        enderecoExecucao, numeroExecucao, complementoExecucao, bairroExecucao,
        municipioExecucao, ufExecucao, cepExecucao,
        prazoSLADias, dataPromessa,
        kmPercorrido, valorDeslocamento,
        pagadorId,
      } = req.body;

      if (!clienteId || !titulo) return res.status(400).json({ success: false, error: 'clienteId e titulo obrigatórios' });

      const erroMeio = erroMeioPermitido(db, clienteId, formaPagamento);
      if (erroMeio) return res.status(400).json({ success: false, error: erroMeio });

      // Busca o tipo — controla status inicial, checklist padrão, ambiente fiscal.
      let tipo = null;
      if (tipoId) {
        tipo = db.prepare('SELECT * FROM os_tipos WHERE id = ? AND ativo = 1').get(tipoId);
        if (!tipo) return res.status(400).json({ success: false, error: 'tipoId inválido ou inativo' });
      }

      // Validação de endereço quando o tipo exige (ex.: OS de campo).
      // localPrestacao 'externo' implica o mesmo: serviço fora não tem onde
      // acontecer sem endereço.
      if (tipo && (tipo.exigeEnderecoExec || tipo.localPrestacao === 'externo') && !enderecoExecucao) {
        return res.status(400).json({ success: false, error: `Tipo "${tipo.nome}" exige endereço de execução` });
      }

      // Identidade do equipamento: usa o id informado ou resolve pelos
      // textos. É o que permite histórico, reincidência e garantia sem
      // depender de o serial ter sido digitado igual da última vez.
      let equipamentoIdFinal = equipamentoIdBody ? Number(equipamentoIdBody) : null;
      if (!equipamentoIdFinal && (equipamento || marca || modelo || numeroSerieEquipamento)) {
        equipamentoIdFinal = acharOuCriarEquipamento(db, {
          clienteId: Number(clienteId), descricao: equipamento, marca, modelo,
          numeroSerie: numeroSerieEquipamento,
          usuario: req.user?.username || req.session?.username || null,
        }).id;
      }

      // Garantia: retorno dentro do prazo não cobra nem emite nota.
      let emGarantia = 0;
      let osPaiFinal = osPaiId || null;
      if (osPaiId) {
        const pai = db.prepare('SELECT dataFaturamento, garantiaDias FROM os_ordens WHERE id = ?').get(osPaiId);
        if (pai && pai.dataFaturamento && pai.garantiaDias > 0) {
          const limiteGarantia = new Date(pai.dataFaturamento);
          limiteGarantia.setDate(limiteGarantia.getDate() + pai.garantiaDias);
          if (Date.now() <= limiteGarantia.getTime()) emGarantia = 1;
        }
      } else if (equipamentoIdFinal) {
        // Sem OS pai informada: o próprio equipamento diz se está em
        // garantia. Antes isso só acontecia se o atendente lembrasse de
        // vincular a OS anterior à mão.
        const ficha = fichaEquipamento(db, equipamentoIdFinal);
        if (ficha?.garantiaVigente) {
          emGarantia = 1;
          osPaiFinal = ficha.garantiaVigente.osId;
        }
      }
      // A natureza do tipo também decide: OS aberta como garantia é garantia
      // mesmo sem OS pai nem equipamento com cobertura vigente.
      if (!emGarantia && tipo && ['garantia-propria', 'garantia-fabrica'].includes(tipo.natureza)) {
        emGarantia = 1;
      }

      // Tipo de Operação: body > padrão do Tipo de OS. Garantia sobrepõe,
      // porque retorno em garantia não cobra qualquer que seja o tipo.
      let tipoOperacaoFinal = tipoOperacaoId || tipo?.tipoOperacaoPadraoId || null;
      if (emGarantia) {
        const g = db.prepare("SELECT id FROM tipos_operacao WHERE codigo = 'OS-GARANTIA' AND ativo = 1").get();
        if (g) tipoOperacaoFinal = g.id;
      }
      // Sem operação não há como saber se a OS cobra ou emite nota. Em vez de
      // adivinhar, recusa e aponta o cadastro que falta.
      if (!tipoOperacaoFinal) {
        return res.status(400).json({ success: false, error: tipo
          ? `Tipo de OS "${tipo.nome}" está sem Tipo de Operação padrão. Defina em Ordens de Serviço › Tipos de OS.`
          : 'Informe o tipo de OS (ele define o tratamento fiscal e financeiro).' });
      }
      // ambienteFiscal é legado: fica coerente com a operação para não
      // contradizer relatórios antigos que ainda leem a coluna.
      const opEscolhida = db.prepare('SELECT emiteNFe FROM tipos_operacao WHERE id = ?').get(tipoOperacaoFinal);
      const ambienteFiscal = opEscolhida && !opEscolhida.emiteNFe ? 'interno' : 'sefaz';

      // Status inicial: se o tipo exige orçamento aprovado → rascunho; senão → aberta.
      const statusInicial = (tipo && tipo.exigeOrcamentoAprovado) ? 'rascunho' : 'aberta';
      const orcamentoStatus = statusInicial === 'rascunho' ? 'rascunho' : null;

      // Prazo SLA: body tem prioridade, senão padrão do tipo.
      const sla = Number(prazoSLADias) || (tipo ? tipo.slaDiasPadrao : null);
      let promessa = dataPromessa || null;
      if (!promessa && sla) {
        const d = new Date();
        d.setDate(d.getDate() + Number(sla));
        promessa = d.toISOString().slice(0, 10);
      }
      // Tipo que obriga data prevista: sem promessa (informada ou derivada do
      // SLA) a OS não abre — é o prazo que o cliente ouviu no balcão.
      if (tipo && tipo.obrigarDataPrevista && !promessa) {
        return res.status(400).json({ success: false, error: `Tipo "${tipo.nome}" exige data prevista de conclusão` });
      }

      const numero = gerarNumero(db);
      const newId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_ordens (
            numero, clienteId, tecnicoId, status, titulo, equipamento, marca, modelo, numeroSerieEquipamento,
            defeitoRelatado, garantiaDias, observacoes, usuarioCriacao,
            formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
            tipoId, contratoId, oportunidadeId, osPaiId,
            enderecoExecucao, numeroExecucao, complementoExecucao, bairroExecucao,
            municipioExecucao, ufExecucao, cepExecucao,
            prazoSLADias, dataPromessa,
            orcamentoStatus, emGarantia, ambienteFiscal, tipoOperacaoId, equipamentoId, depositoId,
            kmPercorrido, valorDeslocamento, pagadorId
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          numero, clienteId, tecnicoId || null, statusInicial, titulo,
          equipamento || null, marca || null, modelo || null, numeroSerieEquipamento || null,
          defeitoRelatado || null, Number(garantiaDias) || 0, observacoes || null, req.user?.username || null,
          formaPagamento || null, dataVencimento || null, Number(numeroParcelas) || 1, naoEmitirNFe ? 1 : 0,
          tipoId || null, contratoId || null, oportunidadeId || null, osPaiFinal,
          enderecoExecucao || null, numeroExecucao || null, complementoExecucao || null, bairroExecucao || null,
          municipioExecucao || null, ufExecucao || null, cepExecucao || null,
          sla || null, promessa,
          orcamentoStatus, emGarantia, ambienteFiscal, tipoOperacaoFinal, equipamentoIdFinal,
          depositoIdBody ? Number(depositoIdBody) : resolverDeposito(db, {}),
          kmPercorrido != null && kmPercorrido !== '' ? Number(kmPercorrido) : null,
          valorDeslocamento != null && valorDeslocamento !== '' ? Number(valorDeslocamento) : null,
          pagadorId != null && pagadorId !== '' ? Number(pagadorId) : null
        );
        const id = r.lastInsertRowid;

        // Copia checklist padrão do tipo (copy-on-create — OS fica imune a
        // mudanças futuras no template).
        if (tipo && tipo.checklistPadrao) {
          try {
            const items = JSON.parse(tipo.checklistPadrao) || [];
            const stmtChk = db.prepare('INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)');
            for (const ck of items) {
              stmtChk.run(id, Number(ck.ordem) || 0, ck.descricao, ck.obrigatorio ? 1 : 0);
            }
          } catch (_) { /* JSON inválido — ignora */ }
        }

        // Deslocamento cobrável do tipo: se já veio km na abertura, a linha
        // de serviço nasce junto (e o total sai certo desde o começo).
        sincronizarDeslocamento(db, id);
        recalcTotais(db, id);

        registrarEvento(db, id, 'abertura', `OS ${numero} aberta${tipo ? ` (tipo: ${tipo.nome})` : ''}`, req.user?.username, {
          clienteId, tipoId: tipoId || null, status: statusInicial, emGarantia,
        });
        return id;
      })();

      logAction(db, req, 'criar', 'os', newId, { numero, clienteId, titulo, tipoId: tipoId || null });
      res.json({
        success: true,
        os: db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(newId),
      });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/os/:id', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (os.status === 'faturada') return res.status(400).json({ success: false, error: 'OS faturada — não pode editar' });
      if (os.status === 'cancelada') return res.status(400).json({ success: false, error: 'OS cancelada' });
      const camposValidos = ['tecnicoId','titulo','equipamento','marca','modelo','numeroSerieEquipamento',
                             'defeitoRelatado','diagnostico','solucao','garantiaDias','observacoes',
                             'formaPagamento','dataVencimento','numeroParcelas','naoEmitirNFe','tipoOperacaoId',
                             'kmPercorrido','valorDeslocamento','valorDesconto','politicaPrazoId','pagadorId'];
      // Condição de pagamento: mesma regra do faturamento — a política do
      // cliente, quando existe, é obrigatória e nenhuma outra é aceita.
      if (req.body.politicaPrazoId !== undefined || req.body.formaPagamento !== undefined) {
        const { politica, erro } = resolverPolitica(db, os.clienteId,
          req.body.politicaPrazoId !== undefined ? req.body.politicaPrazoId : os.politicaPrazoId);
        if (erro) return res.status(400).json({ success: false, error: erro });
        const meio = req.body.formaPagamento !== undefined ? req.body.formaPagamento : os.formaPagamento;
        const meiosOk = meiosDaPolitica(politica);
        if (meio && meiosOk && !meiosOk.includes(String(meio))) {
          return res.status(400).json({ success: false,
            error: `Condição "${politica.nome}" não aceita esse meio de recebimento` });
        }
      }
      if (req.body.valorDesconto !== undefined) {
        const d = Number(req.body.valorDesconto) || 0;
        const bruto = (Number(os.valorPecas) || 0) + (Number(os.valorServicos) || 0);
        if (d < 0) return res.status(400).json({ success: false, error: 'Desconto não pode ser negativo' });
        if (d > bruto) {
          return res.status(400).json({ success: false, error: `Desconto (${d.toFixed(2)}) maior que o valor da OS (${bruto.toFixed(2)})` });
        }
      }
      if (req.body.formaPagamento !== undefined) {
        const erroMeio = erroMeioPermitido(db, os.clienteId, req.body.formaPagamento);
        if (erroMeio) return res.status(400).json({ success: false, error: erroMeio });
      }
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c] === '' ? null : req.body[c]); }
      }
      if (sets.length) {
        vals.push(os.id);
        db.prepare(`UPDATE os_ordens SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        // Km mudou → o deslocamento cobrável do tipo é recalculado. Quando o
        // tipo cobra, o valorDeslocamento enviado no body é descartado: quem
        // manda no preço é a regra do tipo, não quem digitou.
        if (req.body.kmPercorrido !== undefined || req.body.valorDeslocamento !== undefined) {
          sincronizarDeslocamento(db, os.id);
        }
        // O desconto de capa entra no valorTotal — sem isto a OS ficaria com o
        // total velho até o próximo item mexido.
        if (req.body.valorDesconto !== undefined
            || req.body.kmPercorrido !== undefined
            || req.body.valorDeslocamento !== undefined) {
          recalcTotais(db, os.id);
        }
        logAction(db, req, 'editar', 'os', os.id, req.body);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CICLO DE VIDA ====================

  app.post('/api/os/:id/iniciar', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['aberta','aguardando-peca','orcamento'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'Estado atual não permite iniciar execução' });
      }

      // Fase 9.1: ao iniciar execução, CRIA reservas de estoque para as
      // peças já listadas. Se houver insuficiência, devolve 409 com detalhes
      // — front pode confirmar e chamar novamente com ?forcar=1 para
      // permitir reserva com saldo negativo (caso "pedido maior que estoque").
      let reservaResult = null;
      const trx = db.transaction(() => {
        reservaResult = criarReservasOS(db, os.id);
        db.prepare(`
          UPDATE os_ordens
          SET status = 'em-andamento',
              dataInicioExecucao = COALESCE(dataInicioExecucao, CURRENT_TIMESTAMP)
          WHERE id = ?
        `).run(os.id);
      });
      trx();

      registrarEvento(db, os.id, 'inicio', 'Execução iniciada — estoque reservado', req.user?.username, {
        reservasCriadas: reservaResult.reservasCriadas.length,
        insuficiencias: reservaResult.insuficiencias,
      });
      logAction(db, req, 'iniciar', 'os', os.id, { reservas: reservaResult.reservasCriadas.length });
      res.json({
        success: true,
        reservasCriadas: reservaResult.reservasCriadas.length,
        insuficiencias: reservaResult.insuficiencias,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/aguardar-peca', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['em-andamento','aberta'].includes(os.status)) return res.status(400).json({ success: false, error: 'Estado atual não permite' });
      db.prepare(`UPDATE os_ordens SET status = 'aguardando-peca' WHERE id = ?`).run(os.id);
      // Só fazia o UPDATE: o evento não entrava na timeline e a regra de
      // notificação "Aguardando peça" nunca disparava.
      const motivo = (req.body?.motivo || '').trim();
      registrarEvento(db, os.id, 'aguardando-peca',
        motivo ? `Aguardando peça — ${motivo}` : 'OS aguardando peça',
        req.user?.username || req.session?.username, motivo ? { motivo } : null);
      logAction(db, req, 'aguardar-peca', 'os', os.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Concluir: consome reservas ativas (se houver) OU baixa direta (fallback
  // para OS criadas antes da Fase 9.1 sem reservas). Valida checklist
  // obrigatório e assinatura conforme o tipo exigir.
  app.post('/api/os/:id/concluir', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['em-andamento','aguardando-peca','aberta'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'Estado atual não permite concluir' });
      }
      const { solucao, baixarEstoque } = req.body || {};

      // Fase 9.1: valida checklist obrigatório 100% concluído
      const pendentes = db.prepare(
        'SELECT id, descricao FROM os_checklist WHERE osId = ? AND obrigatorio = 1 AND concluido = 0'
      ).all(os.id);
      if (pendentes.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Há ${pendentes.length} item(ns) obrigatório(s) do checklist pendente(s)`,
          checklist: pendentes,
        });
      }

      const tipoOS = os.tipoId
        ? db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(os.tipoId)
        : null;

      // Fase 9.1: valida assinatura do cliente se o tipo exigir
      if (tipoOS && tipoOS.exigeAssinaturaCliente && !os.assinaturaClienteDataUrl) {
        return res.status(400).json({
          success: false,
          error: `Tipo "${tipoOS.nome}" exige assinatura do cliente antes de concluir`,
        });
      }

      // Fase 3: regras de encerramento do tipo. Levanta tudo antes de agir —
      // um único 400 lista todas as pendências que barram, em vez de o
      // usuário descobrir uma por vez.
      const pendencias = coletarPendenciasOS(db, os, tipoOS);
      const bloqueios = [];
      const paraPerder = [];
      for (const cat of CATEGORIAS_ENCERRAMENTO) {
        const achados = pendencias[cat.chave] || [];
        if (!achados.length) continue;
        const regra = (tipoOS && tipoOS[cat.chave]) || 'permitido';
        if (regra === 'bloqueado') {
          bloqueios.push({ categoria: cat.chave, rotulo: cat.rotulo, itens: achados });
        } else if (regra === 'venda-perdida' && cat.perda) {
          paraPerder.push(...achados);
        }
      }
      if (bloqueios.length) {
        const resumo = bloqueios.map(b => `${b.itens.length} ${b.rotulo}`).join('; ');
        return res.status(400).json({
          success: false,
          error: `Tipo "${tipoOS.nome}" não permite concluir com ${resumo}`,
          pendencias: bloqueios,
        });
      }

      const pecas = db.prepare(`
        SELECT pi.*, pr.sku, pr.rastreiaLote, pr.rastreiaSerial
        FROM os_itens_pecas pi
        JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ? AND COALESCE(pi.situacao,'confirmado') = 'confirmado'
      `).all(os.id);

      // Validações de rastreabilidade (lote/serial)
      const baixar = baixarEstoque !== false;
      if (baixar) {
        for (const it of pecas) {
          if (it.rastreiaLote && !it.loteId) return res.status(400).json({ success: false, error: `Peça ${it.sku} rastreia lote — informe o lote` });
          if (it.rastreiaSerial) {
            const serials = it.serialIds ? JSON.parse(it.serialIds) : [];
            if (serials.length !== Number(it.quantidade)) return res.status(400).json({ success: false, error: `Peça ${it.sku} rastreia série — informe ${it.quantidade} série(s)` });
          }
        }
      }

      const dataHoje = new Date().toISOString().slice(0, 10);

      // Verifica se há reservas ativas para esta OS — se sim, consome via helper.
      const temReservas = db.prepare(
        `SELECT COUNT(*) c FROM reservas_estoque WHERE osId = ? AND status = 'ativa'`
      ).get(os.id).c > 0;

      // Peças próprias (com estoque) — terceiros têm fluxo separado mais abaixo.
      const pecasProprias = pecas.filter(p => !p.compradoTerceiro);
      let perdasRegistradas = 0;
      const trx = db.transaction(() => {
        if (baixar && pecasProprias.length) {
          if (temReservas) {
            // Via reservas (fluxo Fase 9.1)
            consumirReservasOS(db, os.id, dataHoje);
            // Serials: ainda precisa marcar status='baixado' (reservas não fazem isso)
            for (const it of pecasProprias) {
              if (it.serialIds) {
                const movSaida = db.prepare('SELECT movSaidaId FROM os_itens_pecas WHERE id = ?').get(it.id);
                for (const sid of JSON.parse(it.serialIds)) {
                  db.prepare(`UPDATE serial_numbers SET status='baixado', movSaidaId = ? WHERE id = ?`).run(movSaida.movSaidaId, sid);
                }
              }
            }
          } else {
            // Fallback: OS antiga sem reservas — baixa direta
            const stmtMov = db.prepare(`
              INSERT INTO movimentacoes_estoque
                (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, loteId, motivo, usuario, depositoId)
              VALUES (?, 'saida', ?, ?, 'os', ?, ?, ?, ?, NULL, ?, ?)
            `);
            for (const it of pecasProprias) {
              // Custo médio vigente no consumo. Antes ia NULL: o custo
              // histórico da peça se perdia e a lucratividade só podia
              // usar o custo de hoje para uma peça gasta meses atrás.
              const custo = calcularCustoMedio(db, it.produtoId) || null;
              const r = stmtMov.run(it.produtoId, Number(it.quantidade), custo, os.id,
                `OS ${os.numero} (peça)`, dataHoje, it.loteId || null, req.user?.username || null,
                resolverDeposito(db, { depositoId: os.depositoId, osId: os.id, produtoId: it.produtoId }));
              const movId = r.lastInsertRowid;
              db.prepare('UPDATE os_itens_pecas SET movSaidaId = ?, custoUnitario = ? WHERE id = ?')
                .run(movId, custo, it.id);
              if (it.loteId) db.prepare('UPDATE lotes SET saldoAtual = saldoAtual - ? WHERE id = ?').run(Number(it.quantidade), it.loteId);
              if (it.serialIds) {
                for (const sid of JSON.parse(it.serialIds)) {
                  db.prepare(`UPDATE serial_numbers SET status='baixado', movSaidaId = ? WHERE id = ?`).run(movId, sid);
                }
              }
            }
          }
        }
        // Saída de peças terceiras (com produtoId vinculado) — sem reserva.
        if (baixar) consumirTerceirosPecasOS(db, os.id, dataHoje, req.user?.username);
        db.prepare(`
          UPDATE os_ordens
             SET status = 'concluida', dataConclusao = CURRENT_TIMESTAMP,
                 solucao = COALESCE(?, solucao)
           WHERE id = ?
        `).run(solucao || null, os.id);

        // Na mesma transação da conclusão: ou a OS fecha com as perdas
        // registradas, ou nada acontece.
        perdasRegistradas = registrarPerdasDaOS(db, os, paraPerder, req.user?.username);
      });
      trx();

      registrarEvento(db, os.id, 'conclusao', solucao || 'OS concluída', req.user?.username, {
        pecas: pecas.length, viaReservas: temReservas, baixouEstoque: baixar, perdasRegistradas,
      });
      logAction(db, req, 'concluir', 'os', os.id, { baixouEstoque: baixar, pecas: pecas.length, viaReservas: temReservas, perdasRegistradas });
      res.json({ success: true, viaReservas: temReservas, vendasPerdidas: perdasRegistradas });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/cancelar', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada','cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'Não permitido nesse estado' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });

      const trx = db.transaction(() => {
        // Fase 9.1: libera reservas ativas
        cancelarReservasOS(db, os.id, `Cancelamento OS: ${motivo}`);

        // Se já houve baixa de estoque (concluída antes de cancelar), gera estornos
        const itensBaixados = db.prepare(`
          SELECT pi.*, pr.sku
          FROM os_itens_pecas pi JOIN produtos pr ON pr.id = pi.produtoId
          WHERE pi.osId = ? AND pi.movSaidaId IS NOT NULL
        `).all(os.id);
        if (itensBaixados.length > 0) {
          const stmtEstorno = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, origem, origemId, observacao, data, loteId, motivo, usuario, depositoId)
            VALUES (?, 'entrada', ?, 'estorno_os', ?, ?, date('now'), ?, ?, ?, ?)
          `);
          for (const it of itensBaixados) {
            stmtEstorno.run(
              it.produtoId, Number(it.quantidade), os.id,
              `Estorno OS ${os.numero} (cancelada): ${motivo}`,
              it.loteId || null,
              `Cancelamento OS ${os.numero}`,
              req.user?.username || null,
              // Volta para o depósito de onde a peça saiu.
              resolverDeposito(db, { depositoId: os.depositoId, osId: os.id, produtoId: it.produtoId }),
            );
            if (it.loteId) {
              db.prepare('UPDATE lotes SET saldoAtual = saldoAtual + ? WHERE id = ?').run(Number(it.quantidade), it.loteId);
            }
            if (it.serialIds) {
              for (const sid of JSON.parse(it.serialIds)) {
                db.prepare(`UPDATE serial_numbers SET status='ativo', movSaidaId = NULL WHERE id = ?`).run(sid);
              }
            }
          }
        }

        db.prepare(`
          UPDATE os_ordens
          SET status = 'cancelada', dataCancelamento = CURRENT_TIMESTAMP, motivoCancelamento = ?
          WHERE id = ?
        `).run(motivo, os.id);
      });
      trx();

      registrarEvento(db, os.id, 'cancelamento', motivo, req.user?.username, null);
      logAction(db, req, 'cancelar', 'os', os.id, { motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== HELPERS: emissão fiscal extraída ====================
  //
  // Extraídos dos handlers emitir-nfse e emitir-nfe para permitir chamada
  // automática do faturar. Retornam { success, nfseId|faturaId, naoFiscal?, error? }.
  // Fase 9.3 (2026-04-22).

  async function _emitirNfseDaOS(osId, body, usuario) {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(osId);
      if (!os) return { success: false, error: 'OS não encontrada' };
      const servicos = db.prepare(`SELECT * FROM os_itens_servicos WHERE osId = ?${SO_CONFIRMADOS}`).all(osId);
      if (!servicos.length) return { success: true, skipped: true, reason: 'sem serviços' };
      const jaEmitida = db.prepare(`SELECT id FROM nfse WHERE osId = ? AND status IN ('autorizada','processando','nao_fiscal')`).get(osId);
      if (jaEmitida) return { success: true, skipped: true, reason: 'nfse já emitida', nfseId: jaEmitida.id };

      // Tomador da NFS-e é quem paga, não necessariamente o cliente da OS
      // (garantia de fábrica, sinistro de seguradora).
      const tipoNfse = os.tipoId ? db.prepare('SELECT nome, faturarPara FROM os_tipos WHERE id = ?').get(os.tipoId) : null;
      const pagNfse = resolverPagadorOS(db, os, tipoNfse);
      if (pagNfse.erro) return { success: false, error: pagNfse.erro };
      const cliente = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(pagNfse.pagadorId);
      if (!cliente) return { success: false, error: 'Cliente não encontrado' };

      const b = body || {};

      // Derivação fiscal: prioridade catálogo dominante (maior valor) > body > config global.
      // Limitação: leiaute DPS NFS-e nacional comporta um único <cServ> por nota,
      // então itens com cNBS distintos pegam o do dominante.
      const itensComCatalogo = servicos.filter(s => s.servicoId);
      let servicoFiscalDominante = null;
      if (itensComCatalogo.length) {
        const dominante = itensComCatalogo.reduce((a, b2) =>
          (Number(b2.valorTotal) || 0) > (Number(a.valorTotal) || 0) ? b2 : a
        );
        servicoFiscalDominante = db.prepare('SELECT * FROM servicos WHERE id = ?').get(dominante.servicoId);
      }

      const codigoTributacaoNacional =
        servicoFiscalDominante?.codigoTributacaoNacional
        || b.codigoTributacaoNacional
        || db.prepare("SELECT value FROM nfse_config WHERE key = 'codigo_tributacao_default'").get()?.value;
      // Só exigido quando a nota vai mesmo para a SEFIN. Documento interno
      // (garantia, cortesia) não precisa de código de tributação — cobrar isso
      // impedia encerrar OS interna em tenant sem config fiscal.
      if (!codigoTributacaoNacional && regraDaOS(db, os).emiteNFe) {
        return { success: false, error: 'codigoTributacaoNacional padrão não configurado em NFSe > Config' };
      }
      const codigoListaServico = servicoFiscalDominante?.codigoListaServico || b.codigoListaServico || null;
      const cNBS = servicoFiscalDominante?.cNBS || null;
      const xNBS = servicoFiscalDominante?.xNBS || null;

      const descricaoAgregada = servicos.map(s => `${s.descricao}${s.horas ? ` (${s.horas}h)` : ''}`).join(' | ').substring(0, 500);
      const valorTotalServicos = servicos.reduce((sum, s) => sum + (Number(s.valorTotal) || 0), 0);

      // Desconto de capa: a parte que cabe aos serviços vai como desconto
      // INCONDICIONADO (vDescIncond) — é abatimento já concedido, sem condição
      // futura, e por isso reduz a base do ISSQN. O desconto de item não entra
      // aqui: ele já está embutido no valorTotal de cada serviço.
      const pecasBrutoNfse = Number(os.valorPecas) || 0;
      const descontoNfse = ratearDesconto(
        pecasBrutoNfse, valorTotalServicos,
        Math.min(Number(os.valorDesconto) || 0, pecasBrutoNfse + valorTotalServicos)
      ).servicos;

      // Decisão fiscal: só o Tipo de Operação, herdado do Tipo de OS.
      const modo = regraDaOS(db, os).emiteNFe ? 'sefaz' : 'interno';

      if (modo === 'interno' || modo === 'nenhum') {
        const stubId = db.prepare(`
          INSERT INTO nfse (osId, tomadorCpfCnpj, tomadorRazaoSocial, codigoTributacaoNacional,
            cNBS, xNBS, descricaoServico, valorServico, dataCompetencia, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nao_fiscal')
        `).run(osId, cliente.cpfCnpj, cliente.razaoSocial, codigoTributacaoNacional,
          cNBS, xNBS,
          `OS ${os.numero} — ${descricaoAgregada}`, valorTotalServicos,
          new Date().toISOString().slice(0,10)
        ).lastInsertRowid;
        db.prepare(`UPDATE contas_a_receber SET nfseId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE osId = ? AND origemTipo = 'os_servicos' AND nfseId IS NULL`).run(stubId, osId);
        recalcStatusFiscal(db, osId);
        registrarEvento(db, osId, 'faturamento', `NFSe marcada como interna (#${stubId})`, usuario, { modo: 'interno', nfseId: stubId });
        return { success: true, naoFiscal: true, nfseId: stubId };
      }

      // Modo sefaz
      const resultado = await emitirNfseInterno(db, {
        osId,
        tomador: {
          cpfCnpj: cliente.cpfCnpj,
          razaoSocial: cliente.razaoSocial,
          inscricaoMunicipal: cliente.inscricaoMunicipal || null,
          email: cliente.email || null,
          endereco: cliente.endereco ? {
            logradouro: cliente.endereco, numero: cliente.numero,
            complemento: cliente.complemento, bairro: cliente.bairro,
            codigoMunicipio: cliente.codigoMunicipio, uf: cliente.uf, cep: cliente.cep,
          } : null,
        },
        servico: {
          codigoTributacaoNacional,
          codigoListaServico,
          cNBS,
          xNBS,
          descricao: `OS ${os.numero} — ${descricaoAgregada}`,
          valorServico: valorTotalServicos,
          descontoIncondicionado: descontoNfse,
          aliquota: Number(b.aliquota) || null,
        },
      });
      recalcStatusFiscal(db, osId);
      if (!resultado.success) {
        registrarEvento(db, osId, 'faturamento', `Falha NFSe: ${resultado.error}`, usuario, { modo: 'sefaz', erro: resultado.error });
        return { success: false, error: resultado.error, detalhes: resultado };
      }
      registrarEvento(db, osId, 'faturamento', `NFSe emitida #${resultado.nfse?.nNFSe || resultado.nfse?.id}`, usuario, { modo: 'sefaz', nfseId: resultado.nfse?.id });
      return { success: true, nfse: resultado.nfse, conta: resultado.conta };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function _emitirNfeDaOS(osId, usuario) {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(osId);
      if (!os) return { success: false, error: 'OS não encontrada' };
      const pecas = db.prepare(`
        SELECT pi.*, pr.sku, pr.unidade, pr.ncm, pr.cfopPadrao AS cfop, pr.origem
        FROM os_itens_pecas pi LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ? AND COALESCE(pi.situacao,'confirmado') = 'confirmado'
      `).all(osId);
      if (!pecas.length) return { success: true, skipped: true, reason: 'sem peças' };
      const jaEmitida = db.prepare(`SELECT id FROM faturas WHERE osId = ? AND statusSefaz IN ('autorizada','nao_fiscal','processando')`).get(osId);
      if (jaEmitida) return { success: true, skipped: true, reason: 'fatura já existe', faturaId: jaEmitida.id };

      // Destinatário da NF-e de peças: mesmo pagador da OS.
      const tipoNfe = os.tipoId ? db.prepare('SELECT nome, faturarPara FROM os_tipos WHERE id = ?').get(os.tipoId) : null;
      const pagNfe = resolverPagadorOS(db, os, tipoNfe);
      if (pagNfe.erro) return { success: false, error: pagNfe.erro };
      const clienteFatura = pagNfe.pagadorId;

      const valorBruto = pecas.reduce((s, p) => s + Number(p.valorTotal), 0);
      // Parte do desconto de capa que cabe às peças. Vai para faturas.valorDesconto,
      // que o emissor já converte em <vDesc> do ICMSTot (nfe-emit-routes.js:513),
      // com vNF = vProd + vFrete − vDesc.
      const servicosBrutoNfe = Number(os.valorServicos) || 0;
      const descontoNfe = ratearDesconto(
        valorBruto, servicosBrutoNfe,
        Math.min(Number(os.valorDesconto) || 0, valorBruto + servicosBrutoNfe)
      ).pecas;
      const dataEmissao = new Date().toISOString().slice(0, 10);
      const dataVencimento = os.dataVencimento || dataEmissao;

      const ultimaFat = db.prepare(`SELECT numero FROM faturas ORDER BY id DESC LIMIT 1`).get();
      let numFat = 1;
      if (ultimaFat) { const m = String(ultimaFat.numero).match(/(\d+)/); if (m) numFat = parseInt(m[1], 10) + 1; }
      const numeroFatura = String(numFat).padStart(6, '0');

      const modo = regraDaOS(db, os).emiteNFe ? 'sefaz' : 'interno';
      const statusSefazInicial = modo === 'interno' ? 'nao_fiscal' : null;

      const faturaId = db.transaction(() => {
        const fId = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, osId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorFrete, valorDesconto, valorTotal, meioPagamento, observacao, statusSefaz,
            tipoOperacaoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `).run(numeroFatura, os.pedidoId, osId, clienteFatura, dataEmissao, dataVencimento,
          valorBruto, descontoNfe, Number((valorBruto - descontoNfe).toFixed(2)), os.formaPagamento || null,
          `OS ${os.numero} — peças`, statusSefazInicial,
          os.tipoOperacaoId || null
        ).lastInsertRowid;
        for (const p of pecas) {
          db.prepare(`
            INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade,
              quantidade, precoUnitario, valorTotal, ncm, cfop, origem)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fId, p.produtoId || null, p.sku || null, p.descricao, p.unidade || null,
            p.quantidade, p.valorUnitario, p.valorTotal, p.ncm || null, p.cfop || null, p.origem || null);
        }
        db.prepare(`UPDATE contas_a_receber SET faturaId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE osId = ? AND origemTipo = 'os_pecas' AND faturaId IS NULL`).run(fId, osId);
        return fId;
      })();

      if (statusSefazInicial === 'nao_fiscal') {
        recalcStatusFiscal(db, osId);
        registrarEvento(db, osId, 'faturamento', `Fatura #${numeroFatura} marcada como interna`, usuario, { modo: 'interno', faturaId });
        return { success: true, naoFiscal: true, faturaId };
      }

      const emit = await emitirNFe(db, faturaId);
      recalcStatusFiscal(db, osId);
      const autorizada = emit && emit.success !== false;
      registrarEvento(db, osId, 'faturamento',
        autorizada ? `NF-e #${numeroFatura} autorizada` : `Falha NF-e #${numeroFatura}: ${emit?.error || 'ver log'}`,
        usuario, { modo: 'sefaz', faturaId, resultado: emit });
      return { success: true, faturaId, sefaz: emit };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Faturar (Fase 9.3): cria pedido + CRs + emite NFSe/NF-e conforme tipo.
  // Body opcional: { formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
  //                  nfseParams: { codigoTributacaoNacional, codigoListaServico, aliquota } }
  // Resposta inclui resultado de cada emissão separadamente — falhas fiscais NÃO
  // revertem o faturamento local (pedido+CRs ficam preservados; front mostra
  // botão de retry).
  app.post('/api/os/:id/faturar', async (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (os.status !== 'concluida') return res.status(400).json({ success: false, error: 'OS deve estar concluída' });
      if (os.pedidoId) return res.status(400).json({ success: false, error: 'OS já faturada (pedido #'+os.pedidoId+')' });

      const tipoFat = os.tipoId ? db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(os.tipoId) : null;

      // Tipo que não fatura (consumo interno, retrabalho, transferência):
      // a OS existe para registrar o custo, não para virar dinheiro.
      if (tipoFat && tipoFat.bloqueiaFaturamento) {
        return res.status(400).json({ success: false, error: `Tipo "${tipoFat.nome}" não fatura` });
      }

      // Só confirmados: item orçado não vira pedido, conta a receber nem nota.
      const pecas = db.prepare(`SELECT * FROM os_itens_pecas WHERE osId = ?${SO_CONFIRMADOS}`).all(os.id);
      const servicos = db.prepare(`SELECT * FROM os_itens_servicos WHERE osId = ?${SO_CONFIRMADOS}`).all(os.id);
      if (!pecas.length && !servicos.length) {
        const orcados = db.prepare(`SELECT
            (SELECT COUNT(*) FROM os_itens_pecas WHERE osId = ? AND situacao='orcado') +
            (SELECT COUNT(*) FROM os_itens_servicos WHERE osId = ? AND situacao='orcado') AS n`).get(os.id, os.id).n;
        return res.status(400).json({ success: false, error: orcados
          ? `OS só tem itens orçados (${orcados}). Confirme os itens antes de faturar.`
          : 'OS sem peças nem serviços' });
      }

      // Parâmetros de faturamento: body tem prioridade, depois os.campos persistidos, depois defaults
      const b = req.body || {};

      // Fase 4: quem paga pode não ser o cliente da OS. Daqui para baixo o
      // pagador é quem manda em política, meios, prazo, pedido e a receber.
      const pag = resolverPagadorOS(db, os, tipoFat);
      if (pag.erro) return res.status(400).json({ success: false, error: pag.erro });
      const pagadorId = pag.pagadorId;

      // Condição de pagamento manda no prazo, nas parcelas e nos meios aceitos.
      const { politica, erro: erroPolitica } = resolverPolitica(
        db, pagadorId, b.politicaPrazoId ?? os.politicaPrazoId);
      if (erroPolitica) return res.status(400).json({ success: false, error: erroPolitica });

      const formaPagamento = b.formaPagamento ?? os.formaPagamento ?? null;
      const meiosOk = meiosDaPolitica(politica);
      if (formaPagamento && meiosOk && !meiosOk.includes(String(formaPagamento))) {
        return res.status(400).json({ success: false,
          error: `Condição "${politica.nome}" não aceita esse meio de recebimento` });
      }
      const erroMeio = erroMeioPermitido(db, pagadorId, formaPagamento);
      if (erroMeio) return res.status(400).json({ success: false, error: erroMeio });

      const dataHoje = new Date().toISOString().slice(0, 10);
      const addDias = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
      // Prazo: da política escolhida ("30/60/90" → 3 parcelas); 'vista' vence
      // na emissão. Sem política, cai no prazo do cadastro do cliente e, por
      // fim, no +30 de sempre.
      const { parsePrazo } = require('./prazo-pagamento');
      const prazoPolitica = politica
        ? (politica.tipo === 'vista' ? [0] : (parsePrazo(politica.prazoDias) || null))
        : null;
      const prazoCliente = prazoPolitica || prazoDaPessoa(db, pagadorId);
      // O que o usuário realmente escolheu. `os.numeroParcelas` tem DEFAULT 1
      // no schema, então tratá-lo como escolha (era o que o `||` fazia) fazia
      // o prazo parcelado nunca valer: "30/60/90" virava uma parcela só.
      // Só conta como escolha o que veio no corpo da requisição, ou um número
      // de parcelas maior que 1 já gravado na OS.
      const vencEscolhido = b.dataVencimento || os.dataVencimento || null;
      const parcelasEscolhidas = (b.numeroParcelas != null && b.numeroParcelas !== '')
        ? Math.max(1, Number(b.numeroParcelas) || 1)
        : (Number(os.numeroParcelas) > 1 ? Number(os.numeroParcelas) : null);

      let dataVencimento, numeroParcelas, vencDaParcela;
      if (!vencEscolhido && !parcelasEscolhidas && prazoCliente) {
        // Prazo manda: uma parcela por vencimento declarado.
        dataVencimento = addDias(dataHoje, prazoCliente[0]);
        numeroParcelas = prazoCliente.length;
        vencDaParcela = (i) => addDias(dataHoje, prazoCliente[i - 1]);
      } else {
        dataVencimento = vencEscolhido
          || addDias(dataHoje, prazoCliente ? prazoCliente[0] : 30);
        numeroParcelas = parcelasEscolhidas || 1;
        vencDaParcela = (i) => addDias(dataVencimento, (i - 1) * 30);
      }
      // Quem decide se esta OS vira cobrança é o Tipo de Operação do Tipo de
      // OS — não mais um checkbox por OS. Com geraFinanceiro=0 (ex.: garantia)
      // o pedido é criado como DOCUMENTO INTERNO: registra o que foi entregue
      // e não gera conta a receber nem nota.
      const regra = regraDaOS(db, os);
      const naoEmitirNFe = regra.emiteNFe ? 0 : 1;

      // Próximo número de pedido.
      // O faturamento de OS numera com 6 dígitos ("002028"); o módulo de
      // pedidos usa outro padrão ("PED-2026-00029") na MESMA tabela. Ler o
      // último pedido por id e extrair o primeiro grupo de dígitos pegava o
      // ANO do formato PED- (2026 -> tentava gravar "002027", que já existia)
      // e o faturamento morria com UNIQUE constraint. Aqui a base é o maior
      // número entre os que seguem o padrão numérico deste fluxo.
      const ultimo = db.prepare(
        `SELECT numero FROM pedidos WHERE numero GLOB '[0-9]*'
         ORDER BY CAST(numero AS INTEGER) DESC LIMIT 1`
      ).get();
      const numPed = ultimo ? parseInt(String(ultimo.numero), 10) + 1 : 1;
      const numeroPedido = String(numPed).padStart(6, '0');

      // Cria uma ou mais parcelas de CR para um "slot" (peças ou serviços)
      // Peças/serviços aqui são BRUTOS. O desconto de capa é rateado entre os
      // dois e cada lado é cobrado/documentado já líquido — é o que mantém
      // contas a receber, NF-e e NFS-e batendo com o total da OS.
      const valorPecasBruto = Number(os.valorPecas) || 0;
      const valorServicosBruto = Number(os.valorServicos) || 0;
      const descontoCapa = Math.min(Number(os.valorDesconto) || 0, valorPecasBruto + valorServicosBruto);
      const rateio = ratearDesconto(valorPecasBruto, valorServicosBruto, descontoCapa);
      const valorPecas = Number((valorPecasBruto - rateio.pecas).toFixed(2));
      const valorServicos = Number((valorServicosBruto - rateio.servicos).toFixed(2));
      const valorTotal = valorPecas + valorServicos;

      const stmtCR = db.prepare(`
        INSERT INTO contas_a_receber
          (pessoaId, osId, pedidoId, origemTipo, descricao, valor, dataEmissao, dataVencimento, status, formaPagamento)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?)
      `);

      const criarCRs = (pedidoId, valor, origem) => {
        if (valor <= 0) return [];
        const ids = [];
        // arredondar parcelas com ajuste no último para bater o total
        const parcelaBase = Math.floor((valor * 100) / numeroParcelas) / 100;
        let acumulado = 0;
        for (let i = 1; i <= numeroParcelas; i++) {
          const venc = vencDaParcela(i);
          const valorParc = (i === numeroParcelas) ? Number((valor - acumulado).toFixed(2)) : parcelaBase;
          acumulado += valorParc;
          const origemLabel = origem === 'pecas' ? 'Peças' : origem === 'servicos' ? 'Serviços' : 'Total';
          const desc = numeroParcelas > 1
            ? `OS ${os.numero} — ${origemLabel} (${i}/${numeroParcelas}): ${os.titulo}`
            : `OS ${os.numero} — ${origemLabel}: ${os.titulo}`;
          const r = stmtCR.run(pagadorId, os.id, pedidoId, `os_${origem}`, desc, valorParc, dataHoje, venc, formaPagamento);
          ids.push(r.lastInsertRowid);
        }
        return ids;
      };

      // Mapeia tipoOperacao da OS para tipoOperacao do pedido gerado. Preserva a flag emiteNFe:
      //   OS com emiteNFe=1 → pedido VDA-NORMAL (emite NF-e das peças)
      //   OS com emiteNFe=0 (interna/garantia) → pedido VDA-NAOFISCAL (sem NF-e)
      let pedidoTipoOpId = null;
      if (os.tipoOperacaoId) {
        const tipoOpOs = db.prepare('SELECT emiteNFe FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId);
        const codigoAlvo = tipoOpOs?.emiteNFe ? 'VDA-NORMAL' : 'VDA-NAOFISCAL';
        const alvo = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = ?`).get(codigoAlvo);
        pedidoTipoOpId = alvo?.id || null;
      }

      const trx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO pedidos (numero, tipo, clienteId, status, dataPedido, valorTotal, observacao, tipoOperacaoId)
          VALUES (?, 'os', ?, 'confirmado', ?, ?, ?, ?)
        `).run(numeroPedido, pagadorId, dataHoje, valorTotal,
          `Originado da OS ${os.numero}: ${os.titulo}`, pedidoTipoOpId);
        const pedidoId = r.lastInsertRowid;

        const stmtItem = db.prepare(`
          INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const it of pecas) {
          stmtItem.run(pedidoId, it.produtoId, it.descricao, it.quantidade, it.valorUnitario, it.valorTotal);
        }
        for (const sv of servicos) {
          stmtItem.run(pedidoId, null, sv.descricao + (sv.horas ? ` (${sv.horas}h)` : ''),
            sv.horas || 1, sv.valorHora || sv.valorTotal, sv.valorTotal);
        }
        // `pedidos` não tem coluna de desconto: sem esta linha o pedido ficaria
        // com itens somando mais que o próprio valorTotal, sem nada explicando.
        if (descontoCapa > 0) {
          stmtItem.run(pedidoId, null, `Desconto concedido na OS ${os.numero}`, 1, -descontoCapa, -descontoCapa);
        }

        // OS mista → 2 CRs (peças/serviços separados). Caso puro → 1 CR do tipo correspondente.
        // Sem geraFinanceiro (garantia, cortesia) o pedido fica como documento
        // interno e nenhuma conta a receber nasce.
        let crIds = [];
        if (!regra.geraFinanceiro) {
          // nada a cobrar
        } else if (valorPecas > 0 && valorServicos > 0) {
          crIds = crIds.concat(criarCRs(pedidoId, valorPecas, 'pecas'));
          crIds = crIds.concat(criarCRs(pedidoId, valorServicos, 'servicos'));
        } else if (valorPecas > 0) {
          crIds = criarCRs(pedidoId, valorPecas, 'pecas');
        } else if (valorServicos > 0) {
          crIds = criarCRs(pedidoId, valorServicos, 'servicos');
        }

        db.prepare(`UPDATE os_ordens SET status = 'faturada', pedidoId = ?, dataFaturamento = CURRENT_TIMESTAMP,
          formaPagamento = ?, dataVencimento = ?, numeroParcelas = ?, naoEmitirNFe = ?,
          politicaPrazoId = ?, statusFiscal = 'pendente' WHERE id = ?`)
          .run(pedidoId, formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
            politica ? politica.id : null, os.id);
        return { pedidoId, crIds };
      });
      const { pedidoId, crIds } = trx();

      // Emissão fiscal: mesma fonte única do resto (Tipo de Operação).
      // Os helpers criam o registro 'nao_fiscal' quando emiteNFe=0, o que
      // mantém o documento no histórico sem ir para a SEFAZ/SEFIN.
      const resultadoFiscal = { nfse: null, nfe: null };
      const ambiente = regra.emiteNFe ? 'sefaz' : 'interno';
      if (valorServicos > 0) {
        resultadoFiscal.nfse = await _emitirNfseDaOS(os.id, b.nfseParams || {}, req.user?.username);
      }
      if (valorPecas > 0) {
        resultadoFiscal.nfe = await _emitirNfeDaOS(os.id, req.user?.username);
      }

      const rotulo = regra.geraFinanceiro
        ? `OS faturada (pedido #${pedidoId}, ${crIds.length} CR)`
        : `OS encerrada como documento interno (pedido #${pedidoId}, sem cobrança — ${regra.codigo || 'sem operação'})`;
      registrarEvento(db, os.id, 'faturamento', rotulo, req.user?.username,
        { pedidoId, crIds, ambienteFiscal: ambiente, operacao: regra.codigo,
          geraFinanceiro: regra.geraFinanceiro, fiscal: resultadoFiscal });
      logAction(db, req, 'faturar', 'os', os.id, { pedidoId, crIds, ambiente, operacao: regra.codigo, resultadoFiscal });
      res.json({ success: true, pedidoId, crIds, ambienteFiscal: ambiente,
        operacao: regra.codigo, geraFinanceiro: regra.geraFinanceiro, fiscal: resultadoFiscal });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== EMISSÃO MANUAL (retry / uso avulso) ====================
  // Os dois endpoints abaixo delegam aos helpers usados também pelo faturar
  // automático — mantém API antiga e permite retry individual.

  app.post('/api/os/:id/emitir-nfse', async (req, res) => {
    const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(req.params.id);
    if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
    if (os.status !== 'faturada') return res.status(400).json({ success: false, error: 'OS precisa estar faturada' });
    const r = await _emitirNfseDaOS(req.params.id, req.body || {}, req.user?.username);
    if (r.success) {
      logAction(db, req, r.naoFiscal ? 'emitir-nfse-interna' : 'emitir-nfse', 'os', req.params.id, r);
      return res.json(r);
    }
    res.status(400).json(r);
  });

  app.post('/api/os/:id/emitir-nfe', async (req, res) => {
    const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(req.params.id);
    if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
    if (os.status !== 'faturada') return res.status(400).json({ success: false, error: 'OS precisa estar faturada' });
    const r = await _emitirNfeDaOS(req.params.id, req.user?.username);
    if (r.success) {
      logAction(db, req, r.naoFiscal ? 'emitir-nfe-interna' : 'emitir-nfe', 'os', req.params.id, r);
      return res.json(r);
    }
    res.status(400).json(r);
  });

  // ==================== ITENS: PEÇAS ====================

  app.post('/api/os/:id/pecas', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada','cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      const {
        produtoId, descricao, quantidade, valorUnitario, loteId, serialIds,
        compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
        dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro,
      } = req.body;
      const terceiro = compradoTerceiro ? 1 : 0;
      const qtd = Number(quantidade), valor = Number(valorUnitario);

      if (!quantidade || valorUnitario == null) {
        return res.status(400).json({ success: false, error: 'quantidade e valorUnitario obrigatórios' });
      }
      const desconto = Number(req.body.desconto) || 0;
      if (desconto < 0) return res.status(400).json({ success: false, error: 'Desconto não pode ser negativo' });
      if (desconto > qtd * valor) {
        return res.status(400).json({ success: false, error: 'Desconto maior que o valor do item' });
      }
      if (terceiro) {
        if (!descricao) return res.status(400).json({ success: false, error: 'Descrição obrigatória para peça de terceiro' });
        if (!fornecedorId || custoTerceiro == null) {
          return res.status(400).json({ success: false, error: 'Comprado de terceiro exige fornecedor e custo' });
        }
      } else if (!produtoId) {
        return res.status(400).json({ success: false, error: 'produtoId obrigatório para peça do estoque' });
      }

      const newId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_itens_pecas (osId, produtoId, descricao, quantidade, valorUnitario, valorTotal, desconto, situacao, loteId, serialIds,
            compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
            dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(os.id, produtoId || null, descricao || '', qtd, valor, qtd*valor - desconto, desconto,
                req.body.situacao === 'orcado' ? 'orcado' : 'confirmado',
                loteId || null, Array.isArray(serialIds) && serialIds.length ? JSON.stringify(serialIds) : null,
                terceiro,
                terceiro ? Number(fornecedorId) : null,
                terceiro ? Number(custoTerceiro) : null,
                terceiro ? (notaFiscalTerceiro || null) : null,
                terceiro ? (dataCompraTerceiro || null) : null,
                terceiro ? (formaPagamentoTerceiro || null) : null,
                terceiro ? (dataVencimentoTerceiro || null) : null);
        const id = r.lastInsertRowid;
        if (terceiro) {
          const apId = sincronizarAPDoItem(db, os.id, id, 'peca', {
            compradoTerceiro: 1,
            descricao: descricao || '',
            fornecedorId, custoTerceiro,
            notaFiscalTerceiro, dataCompraTerceiro,
            formaPagamentoTerceiro, dataVencimentoTerceiro,
            contasPagarId: null,
          });
          if (apId) db.prepare('UPDATE os_itens_pecas SET contasPagarId = ? WHERE id = ?').run(apId, id);
          // Estoque: gera mov_entrada se há produtoId vinculado
          if (produtoId) {
            const movId = lancarEntradaTerceiroPeca(db, os.id, {
              compradoTerceiro: 1, produtoId, quantidade: qtd,
              custoTerceiro, dataCompraTerceiro, id,
            });
            if (movId) db.prepare('UPDATE os_itens_pecas SET movEntradaTerceiroId = ? WHERE id = ?').run(movId, id);
          }
        }
        return id;
      })();
      recalcTotais(db, os.id);
      logAction(db, req, 'add-peca', 'os', os.id, { produtoId: produtoId || null, quantidade: qtd, terceiro });
      res.json({ success: true, peca: db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(newId) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Edita campos de aquisição de terceiro de uma peça já adicionada
  // (custo, fornecedor, NF, datas). Mantém produtoId/quantidade/valorUnitario
  // imutáveis — para mudar isso, remova e adicione de novo.
  app.put('/api/os/pecas/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(item.osId);
      if (os && ['faturada','cancelada'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      }
      const merged = {
        ...item,
        ...req.body,
        compradoTerceiro: req.body.compradoTerceiro != null ? (req.body.compradoTerceiro ? 1 : 0) : item.compradoTerceiro,
      };
      db.transaction(() => {
        const apId = sincronizarAPDoItem(db, item.osId, item.id, 'peca', merged);
        db.prepare(`UPDATE os_itens_pecas SET
            compradoTerceiro = ?, fornecedorId = ?, custoTerceiro = ?, notaFiscalTerceiro = ?,
            dataCompraTerceiro = ?, formaPagamentoTerceiro = ?, dataVencimentoTerceiro = ?,
            contasPagarId = ?
          WHERE id = ?`).run(
          merged.compradoTerceiro,
          merged.fornecedorId || null,
          merged.custoTerceiro != null ? Number(merged.custoTerceiro) : null,
          merged.notaFiscalTerceiro || null,
          merged.dataCompraTerceiro || null,
          merged.formaPagamentoTerceiro || null,
          merged.dataVencimentoTerceiro || null,
          apId,
          item.id,
        );
      })();
      logAction(db, req, 'edit-peca', 'os', item.osId, { itemId: item.id, terceiro: merged.compradoTerceiro });
      res.json({ success: true, peca: db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(item.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== ORÇADO × CONFIRMADO ====================
  // Muda a situação de um item. Confirmar traz o item para o financeiro;
  // reverter para orçado o tira. Recalcula os totais nos dois sentidos.

  app.post('/api/os/itens/:especie/:itemId/situacao', (req, res) => {
    try {
      const especie = req.params.especie === 'pecas' ? 'pecas'
        : req.params.especie === 'servicos' ? 'servicos' : null;
      if (!especie) return res.status(400).json({ success: false, error: 'espécie inválida' });
      const tabela = especie === 'pecas' ? 'os_itens_pecas' : 'os_itens_servicos';

      const situacao = String(req.body.situacao || '').trim();
      if (!['orcado', 'confirmado'].includes(situacao)) {
        return res.status(400).json({ success: false, error: "situacao deve ser 'orcado' ou 'confirmado'" });
      }
      const item = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Item não encontrado' });
      const os = db.prepare('SELECT id, status FROM os_ordens WHERE id = ?').get(item.osId);
      if (os && ['faturada', 'cancelada'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      }
      // Peça já baixada do estoque não volta a ser proposta: o material saiu.
      if (especie === 'pecas' && situacao === 'orcado' && item.movSaidaId) {
        return res.status(400).json({ success: false, error: 'Peça já baixada do estoque — não pode voltar a orçamento' });
      }

      db.prepare(`UPDATE ${tabela} SET situacao = ? WHERE id = ?`).run(situacao, item.id);
      recalcTotais(db, item.osId);
      recalcStatusFiscal(db, item.osId);
      registrarEvento(db, item.osId, 'orcamento',
        `Item ${situacao === 'confirmado' ? 'confirmado' : 'devolvido ao orçamento'}: ${item.descricao}`,
        req.user?.username, { especie, itemId: item.id, situacao });
      logAction(db, req, 'situacao-item', 'os', item.osId, { especie, itemId: item.id, situacao });
      res.json({ success: true, situacao });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Confirma de uma vez tudo que está orçado — o caso comum quando o cliente
  // aprova o orçamento inteiro.
  app.post('/api/os/:id/confirmar-orcados', (req, res) => {
    try {
      const os = db.prepare('SELECT id, status FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada', 'cancelada'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      }
      const n = db.transaction(() => {
        const a = db.prepare("UPDATE os_itens_pecas SET situacao='confirmado' WHERE osId = ? AND situacao='orcado'").run(os.id).changes;
        const b = db.prepare("UPDATE os_itens_servicos SET situacao='confirmado' WHERE osId = ? AND situacao='orcado'").run(os.id).changes;
        return a + b;
      })();
      recalcTotais(db, os.id);
      recalcStatusFiscal(db, os.id);
      if (n) registrarEvento(db, os.id, 'orcamento', `${n} item(ns) confirmado(s) do orçamento`, req.user?.username, { confirmados: n });
      logAction(db, req, 'confirmar-orcados', 'os', os.id, { confirmados: n });
      res.json({ success: true, confirmados: n });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== PEÇAS COM DEFEITO (retiradas do equipamento) ====================
  // Registro técnico, não financeiro: não soma no total nem vira item de nota.

  app.post('/api/os/:id/pecas-defeito', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'OS cancelada' });
      const { produtoId, descricao, quantidade, numeroSerie, laudo, destino } = req.body;
      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatória' });
      const r = db.prepare(`
        INSERT INTO os_pecas_defeito (osId, produtoId, descricao, quantidade, numeroSerie, laudo, destino, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(os.id, produtoId || null, descricao, Number(quantidade) || 1,
        numeroSerie || null, laudo || null, destino || null, req.user?.username || null);
      registrarEvento(db, os.id, 'edicao', `Peça com defeito registrada: ${descricao}`, req.user?.username,
        { pecaDefeitoId: r.lastInsertRowid });
      logAction(db, req, 'add-peca-defeito', 'os', os.id, { id: r.lastInsertRowid, descricao });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/pecas-defeito/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_pecas_defeito WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      db.prepare('DELETE FROM os_pecas_defeito WHERE id = ?').run(item.id);
      logAction(db, req, 'del-peca-defeito', 'os', item.osId, { id: item.id });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/pecas/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (item.movSaidaId) return res.status(400).json({ success: false, error: 'Peça já baixou estoque — estorne primeiro' });
      if (item.contasPagarId && contaAPagarTemPagamento(db, item.contasPagarId)) {
        return res.status(409).json({ success: false, error: 'AP do terceiro já foi pago — baixe ou cancele em Contas a Pagar antes de remover' });
      }
      db.transaction(() => {
        if (item.contasPagarId) removerContaAPagarSeAberta(db, item.contasPagarId);
        if (item.movEntradaTerceiroId) {
          // Estorno: como ainda não houve saída (validado acima), basta deletar a entrada
          db.prepare('DELETE FROM movimentacoes_estoque WHERE id = ? AND tipo = ?').run(item.movEntradaTerceiroId, 'entrada');
        }
        db.prepare('DELETE FROM os_itens_pecas WHERE id = ?').run(item.id);
      })();
      recalcTotais(db, item.osId);
      logAction(db, req, 'rem-peca', 'os', item.osId, { itemId: item.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ITENS: SERVIÇOS ====================

  app.post('/api/os/:id/servicos', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada','cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      const {
        servicoId, horas, valorHora, valorTotal,
        compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
        dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro,
      } = req.body;
      let { descricao } = req.body;

      // Catálogo de serviços: se servicoId vier, usa nome/descricao/valorPadrao como defaults.
      let catalogo = null;
      if (servicoId != null && servicoId !== '') {
        catalogo = db.prepare('SELECT * FROM servicos WHERE id = ? AND ativo = 1').get(Number(servicoId));
        if (!catalogo) return res.status(400).json({ success: false, error: 'Serviço de catálogo não encontrado ou inativo' });
        if (!descricao) descricao = catalogo.descricao || catalogo.nome;
      }

      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatória' });

      // Preço pela regra do Tipo de OS (Fase 4). O modo 'livre' é o default e
      // mantém a precedência histórica.
      const tipoServ = os.tipoId
        ? db.prepare('SELECT nome, servicoCalculoModo, servicoValorHoraPadrao, permiteAlterarCalculoServico FROM os_tipos WHERE id = ?').get(os.tipoId)
        : null;
      const calc = calcularValorServico({
        modo: (tipoServ && tipoServ.servicoCalculoModo) || 'livre',
        tipo: tipoServ, catalogo, horas, valorHora, valorTotal,
      });
      if (calc.erro) return res.status(400).json({ success: false, error: calc.erro });
      const total = calc.total;
      // O cálculo pode preencher horas/valorHora (tempo padrão, valor do tipo):
      // sem isso a linha ficaria sem mostrar de onde o preço saiu.
      const horasFinal = calc.horas != null ? calc.horas : (horas != null && horas !== '' ? Number(horas) : null);
      const valorHoraFinal = calc.valorHora != null ? calc.valorHora : (valorHora != null && valorHora !== '' ? Number(valorHora) : null);

      const terceiro = compradoTerceiro ? 1 : 0;
      if (terceiro && (!fornecedorId || custoTerceiro == null)) {
        return res.status(400).json({ success: false, error: 'Serviço de terceiro exige fornecedor e custo' });
      }

      const descontoSv = Number(req.body.desconto) || 0;
      if (descontoSv < 0) return res.status(400).json({ success: false, error: 'Desconto não pode ser negativo' });
      if (descontoSv > total) return res.status(400).json({ success: false, error: 'Desconto maior que o valor do serviço' });

      const newId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_itens_servicos (osId, descricao, horas, valorHora, valorTotal, desconto, situacao, servicoId,
            compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
            dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(os.id, descricao, horasFinal, valorHoraFinal, total - descontoSv, descontoSv,
          req.body.situacao === 'orcado' ? 'orcado' : 'confirmado',
          catalogo ? catalogo.id : null,
          terceiro,
          terceiro ? Number(fornecedorId) : null,
          terceiro ? Number(custoTerceiro) : null,
          terceiro ? (notaFiscalTerceiro || null) : null,
          terceiro ? (dataCompraTerceiro || null) : null,
          terceiro ? (formaPagamentoTerceiro || null) : null,
          terceiro ? (dataVencimentoTerceiro || null) : null,
        );
        const id = r.lastInsertRowid;
        if (terceiro) {
          const apId = sincronizarAPDoItem(db, os.id, id, 'servico', {
            compradoTerceiro: 1, descricao,
            fornecedorId, custoTerceiro,
            notaFiscalTerceiro, dataCompraTerceiro,
            formaPagamentoTerceiro, dataVencimentoTerceiro,
            contasPagarId: null,
          });
          if (apId) db.prepare('UPDATE os_itens_servicos SET contasPagarId = ? WHERE id = ?').run(apId, id);
        }
        return id;
      })();

      recalcTotais(db, os.id);
      logAction(db, req, 'add-servico', 'os', os.id, { descricao, total, servicoId: catalogo?.id || null, terceiro });
      res.json({ success: true, servico: db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(newId) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Edita campos de aquisição de terceiro de um serviço já adicionado.
  app.put('/api/os/servicos/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(item.osId);
      if (os && ['faturada','cancelada'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      }
      if (item.origem === 'deslocamento') {
        return res.status(400).json({ success: false,
          error: 'Linha de deslocamento é calculada pelo Tipo de OS — altere o km da OS ou a regra do tipo' });
      }
      const merged = {
        ...item,
        ...req.body,
        compradoTerceiro: req.body.compradoTerceiro != null ? (req.body.compradoTerceiro ? 1 : 0) : item.compradoTerceiro,
      };
      db.transaction(() => {
        const apId = sincronizarAPDoItem(db, item.osId, item.id, 'servico', merged);
        db.prepare(`UPDATE os_itens_servicos SET
            compradoTerceiro = ?, fornecedorId = ?, custoTerceiro = ?, notaFiscalTerceiro = ?,
            dataCompraTerceiro = ?, formaPagamentoTerceiro = ?, dataVencimentoTerceiro = ?,
            contasPagarId = ?
          WHERE id = ?`).run(
          merged.compradoTerceiro,
          merged.fornecedorId || null,
          merged.custoTerceiro != null ? Number(merged.custoTerceiro) : null,
          merged.notaFiscalTerceiro || null,
          merged.dataCompraTerceiro || null,
          merged.formaPagamentoTerceiro || null,
          merged.dataVencimentoTerceiro || null,
          apId,
          item.id,
        );
      })();
      logAction(db, req, 'edit-servico', 'os', item.osId, { itemId: item.id, terceiro: merged.compradoTerceiro });
      res.json({ success: true, servico: db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(item.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/servicos/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (item.contasPagarId && contaAPagarTemPagamento(db, item.contasPagarId)) {
        return res.status(409).json({ success: false, error: 'AP do terceiro já foi pago — baixe ou cancele em Contas a Pagar antes de remover' });
      }
      // Removê-la aqui só a faria voltar no próximo recálculo: para tirar o
      // deslocamento da OS, zere o km ou mude a regra do tipo.
      if (item.origem === 'deslocamento') {
        return res.status(400).json({ success: false,
          error: 'Linha de deslocamento é calculada pelo Tipo de OS — zere o km da OS ou mude a regra do tipo' });
      }
      db.transaction(() => {
        if (item.contasPagarId) removerContaAPagarSeAberta(db, item.contasPagarId);
        db.prepare('DELETE FROM os_itens_servicos WHERE id = ?').run(item.id);
      })();
      recalcTotais(db, item.osId);
      logAction(db, req, 'rem-servico', 'os', item.osId, { itemId: item.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== APONTAMENTOS ====================

  app.post('/api/os/:id/apontamentos', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const { dataInicio, dataFim, horas, descricao, tecnicoId } = req.body;
      if (!dataInicio) return res.status(400).json({ success: false, error: 'dataInicio obrigatória' });
      let h = horas != null ? Number(horas) : null;
      if (!h && dataFim) {
        h = (new Date(dataFim) - new Date(dataInicio)) / 3600000;
      }
      const r = db.prepare(`
        INSERT INTO os_apontamentos (osId, tecnicoId, dataInicio, dataFim, horas, descricao)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(os.id, tecnicoId || os.tecnicoId || req.user?.id || null, dataInicio, dataFim || null, h, descricao || null);
      logAction(db, req, 'apontar', 'os', os.id, { horas: h });
      res.json({ success: true, apontamento: db.prepare('SELECT * FROM os_apontamentos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/apontamentos/:apontId', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM os_apontamentos WHERE id = ?').get(req.params.apontId);
      if (!a) return res.status(404).json({ success: false, error: 'Não encontrado' });
      db.prepare('DELETE FROM os_apontamentos WHERE id = ?').run(a.id);
      logAction(db, req, 'rem-apontamento', 'os', a.osId, { id: a.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== TIPOS DE OS (catálogo) ====================

  // SELECT comum: junta tipos_operacao para expor a "Natureza de Operação"
  // (textoPadraoNFe) que será mostrada em ordens-servico.html ao escolher o
  // Tipo de OS — sem precisar do usuário escolher Tipo de Operação à parte.
  const SQL_OS_TIPOS_BASE = `
    SELECT t.*,
           op.codigo       AS tipoOperacaoPadraoCodigo,
           op.textoPadraoNFe AS tipoOperacaoPadraoTexto
      FROM os_tipos t
      LEFT JOIN tipos_operacao op ON op.id = t.tipoOperacaoPadraoId
  `;

  app.get('/api/os-tipos', (req, res) => {
    try {
      const incluirInativos = req.query.todos === '1';
      const sql = SQL_OS_TIPOS_BASE +
        (incluirInativos ? ' ORDER BY t.ativo DESC, t.nome' : ' WHERE t.ativo = 1 ORDER BY t.nome');
      const rows = db.prepare(sql).all();
      res.json({ success: true, tipos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/os-tipos/:id', (req, res) => {
    try {
      const t = db.prepare(SQL_OS_TIPOS_BASE + ' WHERE t.id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      res.json({ success: true, tipo: t });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  function slugify(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Naturezas aceitas em os_tipos.natureza. As duas de garantia fazem a OS
  // nascer com emGarantia = 1 (ver POST /api/os).
  const NATUREZAS_OS = [
    'cliente', 'garantia-propria', 'garantia-fabrica', 'consumo-interno',
    'retrabalho', 'entrega-tecnica', 'seguro', 'transferencia-interna', 'revisao',
  ];
  const LOCAIS_PRESTACAO = ['indefinido', 'interno', 'externo'];
  // 'manual' preserva o comportamento histórico (usuário lança a linha à mão).
  const MODOS_DESLOCAMENTO = ['manual', 'nao-cobrar', 'por-km', 'valor-fixo'];

  // Valida os enums da Fase 4 e devolve o que gravar. 'livre' e 'cliente'
  // são os defaults que preservam o comportamento anterior.
  function camposFase4DoBody(b, atual) {
    const calculo = b.servicoCalculoModo !== undefined
      ? b.servicoCalculoModo : ((atual && atual.servicoCalculoModo) || 'livre');
    if (!MODOS_CALCULO_SERVICO.includes(calculo)) {
      throw new Error(`servicoCalculoModo inválido: ${calculo}`);
    }
    const faturar = b.faturarPara !== undefined
      ? b.faturarPara : ((atual && atual.faturarPara) || 'cliente');
    if (!MODOS_FATURAR_PARA.includes(faturar)) {
      throw new Error(`faturarPara inválido: ${faturar}`);
    }
    return { calculo, faturar };
  }

  const numOuNull = v => (v == null || v === '' ? null : Number(v));

  // Valida as regras de encerramento vindas do body e devolve o valor a
  // gravar por categoria. Lança com a mensagem pronta quando algo não bate.
  function regrasEncerramentoDoBody(b, atual) {
    const out = {};
    for (const cat of CATEGORIAS_ENCERRAMENTO) {
      const permitidas = cat.perda ? REGRAS_ENCERRAMENTO : REGRAS_ENCERRAMENTO_SEM_PERDA;
      const valor = b[cat.chave] !== undefined
        ? b[cat.chave]
        : ((atual && atual[cat.chave]) || 'permitido');
      if (!permitidas.includes(valor)) {
        throw new Error(`${cat.chave} inválido: ${valor} (aceita ${permitidas.join(', ')})`);
      }
      out[cat.chave] = valor;
    }
    return out;
  }

  // Aceita array de {descricao, obrigatorio} (ordem é renumerada aqui) ou a
  // string JSON já pronta. Devolve string JSON, ou undefined quando o body
  // não trouxe o campo — o que no PUT significa "não mexer".
  function normalizarChecklist(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return '[]';
    let arr = v;
    if (typeof v === 'string') {
      try { arr = JSON.parse(v); } catch { throw new Error('checklistPadrao inválido (JSON malformado)'); }
    }
    if (!Array.isArray(arr)) throw new Error('checklistPadrao deve ser uma lista');
    const itens = arr
      .filter(ck => ck && String(ck.descricao || '').trim())
      .map((ck, i) => ({
        ordem: i + 1,
        descricao: String(ck.descricao).trim(),
        obrigatorio: ck.obrigatorio ? 1 : 0,
      }));
    return JSON.stringify(itens);
  }

  app.post('/api/os-tipos', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const slug = (b.slug && slugify(b.slug)) || slugify(b.nome);
      if (!slug) return res.status(400).json({ success: false, error: 'slug inválido' });
      // Obrigatório: é este vínculo que define se a OS emite nota e se cobra.
      if (b.tipoOperacaoPadraoId == null || b.tipoOperacaoPadraoId === '') {
        return res.status(400).json({ success: false, error: 'Tipo de Operação padrão é obrigatório — é ele que define se a OS emite nota fiscal e se gera cobrança' });
      }
      const natureza = b.natureza || 'cliente';
      if (!NATUREZAS_OS.includes(natureza)) {
        return res.status(400).json({ success: false, error: `natureza inválida: ${natureza}` });
      }
      const localPrestacao = b.localPrestacao || 'indefinido';
      if (!LOCAIS_PRESTACAO.includes(localPrestacao)) {
        return res.status(400).json({ success: false, error: `localPrestacao inválido: ${localPrestacao}` });
      }
      const deslocamentoModo = b.deslocamentoModo || 'manual';
      if (!MODOS_DESLOCAMENTO.includes(deslocamentoModo)) {
        return res.status(400).json({ success: false, error: `deslocamentoModo inválido: ${deslocamentoModo}` });
      }
      const enc = regrasEncerramentoDoBody(b, null);
      const f4 = camposFase4DoBody(b, null);
      const r = db.prepare(`INSERT INTO os_tipos
        (nome, slug, descricao, modoFiscal, slaDiasPadrao, exigeEnderecoExec,
         exigeAssinaturaCliente, exigeOrcamentoAprovado, cor, tipoOperacaoPadraoId,
         checklistPadrao, natureza, localPrestacao, bloqueiaFaturamento, obrigarDataPrevista,
         deslocamentoModo, deslocamentoValorKm, deslocamentoValorFixo,
         encerraPecaPendente, encerraServicoPendente, encerraTerceiroPendente,
         encerraKmPendente, encerraApontamentoAberto,
         servicoCalculoModo, servicoValorHoraPadrao, permiteAlterarCalculoServico, faturarPara)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.nome.trim(), slug, b.descricao || null,
        b.modoFiscal || 'sefaz',
        b.slaDiasPadrao != null && b.slaDiasPadrao !== '' ? Number(b.slaDiasPadrao) : null,
        b.exigeEnderecoExec ? 1 : 0,
        b.exigeAssinaturaCliente ? 1 : 0,
        b.exigeOrcamentoAprovado ? 1 : 0,
        b.cor || '#4dabf7',
        b.tipoOperacaoPadraoId != null && b.tipoOperacaoPadraoId !== '' ? Number(b.tipoOperacaoPadraoId) : null,
        normalizarChecklist(b.checklistPadrao) ?? '[]',
        natureza, localPrestacao,
        b.bloqueiaFaturamento ? 1 : 0,
        b.obrigarDataPrevista ? 1 : 0,
        deslocamentoModo,
        numOuNull(b.deslocamentoValorKm),
        numOuNull(b.deslocamentoValorFixo),
        enc.encerraPecaPendente, enc.encerraServicoPendente, enc.encerraTerceiroPendente,
        enc.encerraKmPendente, enc.encerraApontamentoAberto,
        f4.calculo,
        numOuNull(b.servicoValorHoraPadrao),
        b.permiteAlterarCalculoServico === false ? 0 : 1,
        f4.faturar
      );
      logAction(db, req, 'criar', 'os-tipo', r.lastInsertRowid, { nome: b.nome, slug });
      res.json({ success: true, tipo: db.prepare(SQL_OS_TIPOS_BASE + ' WHERE t.id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/os-tipos/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      const b = req.body || {};
      const slug = b.slug ? slugify(b.slug) : atual.slug;
      // Não deixa apagar o vínculo de um tipo que já o tem.
      if (b.tipoOperacaoPadraoId !== undefined
          && (b.tipoOperacaoPadraoId === null || b.tipoOperacaoPadraoId === '')) {
        return res.status(400).json({ success: false, error: 'Tipo de Operação padrão é obrigatório — é ele que define se a OS emite nota fiscal e se gera cobrança' });
      }
      const natureza = b.natureza !== undefined ? b.natureza : (atual.natureza || 'cliente');
      if (!NATUREZAS_OS.includes(natureza)) {
        return res.status(400).json({ success: false, error: `natureza inválida: ${natureza}` });
      }
      const localPrestacao = b.localPrestacao !== undefined
        ? b.localPrestacao : (atual.localPrestacao || 'indefinido');
      if (!LOCAIS_PRESTACAO.includes(localPrestacao)) {
        return res.status(400).json({ success: false, error: `localPrestacao inválido: ${localPrestacao}` });
      }
      const checklist = normalizarChecklist(b.checklistPadrao);
      const deslocamentoModo = b.deslocamentoModo !== undefined
        ? b.deslocamentoModo : (atual.deslocamentoModo || 'manual');
      if (!MODOS_DESLOCAMENTO.includes(deslocamentoModo)) {
        return res.status(400).json({ success: false, error: `deslocamentoModo inválido: ${deslocamentoModo}` });
      }
      const enc = regrasEncerramentoDoBody(b, atual);
      const f4 = camposFase4DoBody(b, atual);
      db.prepare(`UPDATE os_tipos SET
        nome = ?, slug = ?, descricao = ?, modoFiscal = ?, slaDiasPadrao = ?,
        exigeEnderecoExec = ?, exigeAssinaturaCliente = ?, exigeOrcamentoAprovado = ?,
        cor = ?, ativo = ?, tipoOperacaoPadraoId = ?, checklistPadrao = ?,
        natureza = ?, localPrestacao = ?, bloqueiaFaturamento = ?, obrigarDataPrevista = ?,
        deslocamentoModo = ?, deslocamentoValorKm = ?, deslocamentoValorFixo = ?,
        encerraPecaPendente = ?, encerraServicoPendente = ?, encerraTerceiroPendente = ?,
        encerraKmPendente = ?, encerraApontamentoAberto = ?,
        servicoCalculoModo = ?, servicoValorHoraPadrao = ?,
        permiteAlterarCalculoServico = ?, faturarPara = ?
        WHERE id = ?`).run(
        b.nome != null ? String(b.nome).trim() : atual.nome,
        slug,
        b.descricao !== undefined ? b.descricao : atual.descricao,
        b.modoFiscal || atual.modoFiscal,
        b.slaDiasPadrao !== undefined && b.slaDiasPadrao !== ''
          ? (b.slaDiasPadrao === null ? null : Number(b.slaDiasPadrao))
          : atual.slaDiasPadrao,
        b.exigeEnderecoExec != null ? (b.exigeEnderecoExec ? 1 : 0) : atual.exigeEnderecoExec,
        b.exigeAssinaturaCliente != null ? (b.exigeAssinaturaCliente ? 1 : 0) : atual.exigeAssinaturaCliente,
        b.exigeOrcamentoAprovado != null ? (b.exigeOrcamentoAprovado ? 1 : 0) : atual.exigeOrcamentoAprovado,
        b.cor || atual.cor,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        b.tipoOperacaoPadraoId !== undefined
          ? (b.tipoOperacaoPadraoId === null || b.tipoOperacaoPadraoId === '' ? null : Number(b.tipoOperacaoPadraoId))
          : atual.tipoOperacaoPadraoId,
        checklist !== undefined ? checklist : (atual.checklistPadrao || '[]'),
        natureza, localPrestacao,
        b.bloqueiaFaturamento != null ? (b.bloqueiaFaturamento ? 1 : 0) : (atual.bloqueiaFaturamento || 0),
        b.obrigarDataPrevista != null ? (b.obrigarDataPrevista ? 1 : 0) : (atual.obrigarDataPrevista || 0),
        deslocamentoModo,
        b.deslocamentoValorKm !== undefined ? numOuNull(b.deslocamentoValorKm) : atual.deslocamentoValorKm,
        b.deslocamentoValorFixo !== undefined ? numOuNull(b.deslocamentoValorFixo) : atual.deslocamentoValorFixo,
        enc.encerraPecaPendente, enc.encerraServicoPendente, enc.encerraTerceiroPendente,
        enc.encerraKmPendente, enc.encerraApontamentoAberto,
        f4.calculo,
        b.servicoValorHoraPadrao !== undefined ? numOuNull(b.servicoValorHoraPadrao) : atual.servicoValorHoraPadrao,
        b.permiteAlterarCalculoServico != null
          ? (b.permiteAlterarCalculoServico ? 1 : 0)
          : (atual.permiteAlterarCalculoServico == null ? 1 : atual.permiteAlterarCalculoServico),
        f4.faturar,
        req.params.id
      );
      logAction(db, req, 'editar', 'os-tipo', Number(req.params.id), { nome: b.nome, slug });
      res.json({ success: true, tipo: db.prepare(SQL_OS_TIPOS_BASE + ' WHERE t.id = ?').get(req.params.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os-tipos/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE os_tipos SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Tipo não encontrado ou já inativo' });
      logAction(db, req, 'inativar', 'os-tipo', Number(req.params.id), {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CHECKLIST ====================

  app.get('/api/os/:id/checklist', (req, res) => {
    try {
      const items = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem, id').all(req.params.id);
      res.json({ success: true, checklist: items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/checklist', (req, res) => {
    try {
      const { descricao, obrigatorio, ordem } = req.body || {};
      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatória' });
      const r = db.prepare(
        'INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)'
      ).run(req.params.id, Number(ordem) || 0, descricao, obrigatorio ? 1 : 0);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/os/checklist/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_checklist WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { concluido, descricao, obrigatorio, observacao } = req.body || {};
      const sets = [], vals = [];
      if (descricao !== undefined)  { sets.push('descricao = ?'); vals.push(descricao); }
      if (obrigatorio !== undefined){ sets.push('obrigatorio = ?'); vals.push(obrigatorio ? 1 : 0); }
      if (observacao !== undefined) { sets.push('observacao = ?'); vals.push(observacao || null); }
      if (concluido !== undefined) {
        sets.push('concluido = ?'); vals.push(concluido ? 1 : 0);
        sets.push('dataConclusao = ?'); vals.push(concluido ? new Date().toISOString() : null);
        sets.push('responsavel = ?'); vals.push(concluido ? (req.user?.username || null) : null);
      }
      if (sets.length) {
        vals.push(item.id);
        db.prepare(`UPDATE os_checklist SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/checklist/:itemId', (req, res) => {
    try {
      db.prepare('DELETE FROM os_checklist WHERE id = ?').run(req.params.itemId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ANEXOS (fotos, PDFs) ====================

  app.get('/api/os/:id/anexos', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM os_anexos WHERE osId = ? ORDER BY dataUpload DESC').all(req.params.id);
      res.json({ success: true, anexos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // reentrarContextoTenant: obrigatório depois do multer (ver nota em
  // contas-pagar-routes.js). Aqui pesa mais: anexo de OS é foto de celular,
  // que sempre chega em vários chunks.
  app.post('/api/os/:id/anexos',
    comTratamentoDeErro(uploadOSAnexo.single('arquivo'), { rotulo: 'os-anexo', limiteMb: 15 }),
    reentrarContextoTenant, (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo recebido' });
      const { categoria = 'outro' } = req.body || {};
      const relPath = path.relative(path.join(__dirname, 'public'), req.file.path).replace(/\\/g, '/');
      const r = db.prepare(`
        INSERT INTO os_anexos (osId, categoria, mimeType, nomeOriginal, caminho, tamanho, uploadedBy)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id, categoria, req.file.mimetype, nomeOriginalUtf8(req.file.originalname),
        relPath, req.file.size, req.user?.username || null,
      );
      registrarEvento(db, req.params.id, 'anexo', `Anexo "${nomeOriginalUtf8(req.file.originalname)}" (${categoria})`, req.user?.username, { categoria, tamanho: req.file.size });
      res.json({ success: true, id: r.lastInsertRowid, caminho: relPath });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/os/anexos/:anexoId/download', (req, res) => {
    try {
      const anexo = db.prepare('SELECT * FROM os_anexos WHERE id = ?').get(req.params.anexoId);
      if (!anexo) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const abs = path.join(__dirname, 'public', anexo.caminho);
      if (!fs.existsSync(abs)) return res.status(410).json({ success: false, error: 'Arquivo removido do disco' });
      res.download(abs, anexo.nomeOriginal);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/anexos/:anexoId', (req, res) => {
    try {
      const anexo = db.prepare('SELECT * FROM os_anexos WHERE id = ?').get(req.params.anexoId);
      if (!anexo) return res.status(404).json({ success: false, error: 'Não encontrado' });
      try { fs.unlinkSync(path.join(__dirname, 'public', anexo.caminho)); } catch (_) { /* */ }
      db.prepare('DELETE FROM os_anexos WHERE id = ?').run(anexo.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== TIMELINE DE EVENTOS ====================

  app.get('/api/os/:id/eventos', (req, res) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM os_eventos WHERE osId = ? ORDER BY data DESC, id DESC LIMIT 200'
      ).all(req.params.id);
      res.json({
        success: true,
        eventos: rows.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null })),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PDF da OS (Fase 9.5) ====================

  function _dadosOSparaPDF(osId) {
    const os = db.prepare(`
      SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
             p.telefone AS clienteTelefone, u.username AS tecnicoNome,
             u.nome AS tecnicoNomeExibicao
      FROM os_ordens o
      JOIN pessoas p ON p.id = o.clienteId
      LEFT JOIN users u ON u.id = o.tecnicoId
      WHERE o.id = ?
    `).get(osId);
    if (!os) return null;
    const pecas = db.prepare(`
      SELECT pi.*, pr.sku FROM os_itens_pecas pi
      LEFT JOIN produtos pr ON pr.id = pi.produtoId
      WHERE pi.osId = ? ORDER BY pi.id
    `).all(osId);
    const servicos = db.prepare('SELECT * FROM os_itens_servicos WHERE osId = ? ORDER BY id').all(osId);
    const checklist = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem').all(osId);
    const emitente = db.prepare('SELECT razaoSocial, cnpj, telefone, email FROM fornecedor WHERE id = 1').get() || {};
    return { os, pecas, servicos, checklist, emitente };
  }

  app.get('/api/os/:id/pdf', (req, res) => {
    const d = _dadosOSparaPDF(req.params.id);
    if (!d) return res.status(404).json({ success: false, error: 'Não encontrada' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="OS-${d.os.numero}.pdf"`);
    osPdf.gerar(res, d.os, d.emitente, d.pecas, d.servicos, d.checklist);
  });

  // ==================== ORÇAMENTO PÚBLICO (envio + aprovação) ====================

  // Fase 9.2 (2026-04-22): envia o orçamento ao cliente por email/whatsapp,
  // gera token criptográfico para que ele aprove/rejeite sem login.
  app.post('/api/os/:id/enviar-orcamento', async (req, res) => {
    try {
      const os = db.prepare(`
        SELECT o.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail, p.telefone AS clienteTelefone
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        WHERE o.id = ?
      `).get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['rascunho', 'orcamento'].includes(os.orcamentoStatus || 'rascunho') && os.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'OS já aprovada ou encerrada' });
      }
      const { canal, destinoEmail, destinoWhatsApp, mensagemExtra } = req.body || {};
      if (!['email', 'whatsapp', 'ambos'].includes(canal)) {
        return res.status(400).json({ success: false, error: 'canal deve ser email, whatsapp ou ambos' });
      }

      // Gera token (ou reusa se já existia — permite reenvio sem invalidar)
      let token = os.orcamentoToken;
      if (!token) token = crypto.randomBytes(32).toString('hex');

      // Monta link público — usa o Host atual (tenant) para manter subdomínio
      const host = req.headers.host || 'liciteagora.app';
      const link = `https://${host}/orcamento.html?token=${token}`;

      const assunto = `Orçamento OS ${os.numero} — ${os.titulo || 'Serviço'}`;
      const valorTotal = Number(os.valorTotal || 0);
      const texto = [
        `Olá ${os.clienteNome},`,
        '',
        `Seu orçamento da OS ${os.numero} está pronto:`,
        os.titulo ? `• ${os.titulo}` : null,
        os.equipamento ? `• Equipamento: ${[os.equipamento, os.marca, os.modelo].filter(Boolean).join(' ')}` : null,
        valorTotal > 0 ? `• Valor total: R$ ${valorTotal.toFixed(2).replace('.', ',')}` : null,
        os.dataPromessa ? `• Prazo estimado: ${os.dataPromessa}` : null,
        '',
        'Para aprovar ou rejeitar o orçamento, acesse:',
        link,
        '',
        mensagemExtra || '',
      ].filter(Boolean).join('\n');

      const canais = [];
      const erros = [];

      if (canal === 'email' || canal === 'ambos') {
        const to = destinoEmail || os.clienteEmail;
        if (!to) erros.push('email do cliente não cadastrado');
        else {
          try {
            await enviarEmailCobranca(db, { to, assunto, texto, valor: valorTotal });
            canais.push({ canal: 'email', destino: to, status: 'enviado' });
          } catch (e) { erros.push(`email: ${e.message}`); }
        }
      }
      if (canal === 'whatsapp' || canal === 'ambos') {
        const tel = (destinoWhatsApp || os.clienteTelefone || '').replace(/\D/g, '');
        if (!tel) erros.push('whatsapp/telefone do cliente não cadastrado');
        else {
          try {
            await enviarWhatsApp(db, { telefone: tel, texto });
            canais.push({ canal: 'whatsapp', destino: tel, status: 'enviado' });
          } catch (e) { erros.push(`whatsapp: ${e.message}`); }
        }
      }

      if (canais.length === 0) {
        return res.status(500).json({ success: false, error: 'Falha ao enviar por todos os canais', detalhes: erros });
      }

      // Persiste token + status
      db.prepare(`
        UPDATE os_ordens
        SET orcamentoToken = ?,
            orcamentoStatus = 'enviado',
            status = CASE WHEN status = 'rascunho' THEN 'orcamento' ELSE status END,
            dataEnvioOrcamento = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(token, os.id);

      registrarEvento(db, os.id, 'enviado', `Orçamento enviado via ${canais.map(c=>c.canal).join('+')}`, req.user?.username, {
        canais, link, erros,
      });
      logAction(db, req, 'enviar-orcamento', 'os', os.id, { canais, erros });
      res.json({ success: true, token, link, canais, erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // -------- Rotas PÚBLICAS (sem auth, acesso por token) --------

  // Detecta tentativa de enumeração: token deve ser 64 chars hex.
  const TOKEN_RE = /^[a-f0-9]{64}$/i;

  function _osPorToken(token) {
    if (!TOKEN_RE.test(token)) return null;
    return db.prepare(`
      SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj
      FROM os_ordens o
      JOIN pessoas p ON p.id = o.clienteId
      WHERE o.orcamentoToken = ?
    `).get(token);
  }

  // Dados resumidos do orçamento — para o cliente ver e decidir
  app.get('/api/orcamento/:token', (req, res) => {
    try {
      const os = _osPorToken(req.params.token);
      if (!os) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      // Não exponho dados sensíveis do prestador nem da OS operacional.
      const pecas = db.prepare(`
        SELECT pi.descricao, pi.quantidade, pi.valorUnitario, pi.valorTotal, pr.sku
        FROM os_itens_pecas pi LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ?
      `).all(os.id);
      const servicos = db.prepare(
        'SELECT descricao, horas, valorHora, valorTotal FROM os_itens_servicos WHERE osId = ?'
      ).all(os.id);
      const prestador = db.prepare('SELECT razaoSocial, cnpj, telefone, email FROM fornecedor WHERE id = 1').get() || null;
      res.json({
        success: true,
        orcamento: {
          numero: os.numero,
          titulo: os.titulo,
          equipamento: [os.equipamento, os.marca, os.modelo].filter(Boolean).join(' ') || null,
          defeitoRelatado: os.defeitoRelatado,
          diagnostico: os.diagnostico,
          valorPecas: os.valorPecas,
          valorServicos: os.valorServicos,
          valorTotal: os.valorTotal,
          garantiaDias: os.garantiaDias,
          dataPromessa: os.dataPromessa,
          orcamentoStatus: os.orcamentoStatus,
          dataRespostaOrcamento: os.dataRespostaOrcamento,
          motivoRejeicao: os.motivoRejeicao,
        },
        cliente: { nome: os.clienteNome, cpfCnpj: os.clienteCpfCnpj },
        prestador,
        pecas,
        servicos,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/orcamento/:token/aprovar', (req, res) => {
    try {
      const os = _osPorToken(req.params.token);
      if (!os) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      if (os.orcamentoStatus === 'aprovado') return res.status(400).json({ success: false, error: 'Já aprovado anteriormente' });
      if (os.orcamentoStatus === 'rejeitado') return res.status(400).json({ success: false, error: 'Já rejeitado' });

      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      const ua = req.headers['user-agent'] || '';
      const assinanteNome = (req.body && req.body.assinanteNome) || os.clienteNome;

      db.prepare(`
        UPDATE os_ordens
        SET orcamentoStatus = 'aprovado',
            status = 'aberta',
            dataRespostaOrcamento = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(os.id);

      // O cliente aprovou o orçamento: o que estava orçado vira confirmado e
      // passa a contar no financeiro. Sem isto a aprovação mudaria o status da
      // OS mas deixaria os itens fora do total.
      const confirmados = db.transaction(() => {
        const a = db.prepare("UPDATE os_itens_pecas SET situacao='confirmado' WHERE osId = ? AND situacao='orcado'").run(os.id).changes;
        const b = db.prepare("UPDATE os_itens_servicos SET situacao='confirmado' WHERE osId = ? AND situacao='orcado'").run(os.id).changes;
        return a + b;
      })();
      if (confirmados) { recalcTotais(db, os.id); recalcStatusFiscal(db, os.id); }

      registrarEvento(db, os.id, 'aprovado',
        `Orçamento aprovado pelo cliente (${assinanteNome})${confirmados ? ` — ${confirmados} item(ns) confirmado(s)` : ''}`,
        null, { ip, userAgent: ua, assinanteNome, confirmados });
      res.json({ success: true, numero: os.numero });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/orcamento/:token/rejeitar', (req, res) => {
    try {
      const os = _osPorToken(req.params.token);
      if (!os) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      if (os.orcamentoStatus === 'aprovado') return res.status(400).json({ success: false, error: 'Já aprovado — contate o prestador' });
      if (os.orcamentoStatus === 'rejeitado') return res.status(400).json({ success: false, error: 'Já rejeitado' });

      const motivo = String((req.body?.motivo || '')).trim();
      if (motivo.length < 3) return res.status(400).json({ success: false, error: 'Informe um motivo (mín. 3 chars)' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      const ua = req.headers['user-agent'] || '';

      db.prepare(`
        UPDATE os_ordens
        SET orcamentoStatus = 'rejeitado',
            status = 'cancelada',
            dataRespostaOrcamento = CURRENT_TIMESTAMP,
            motivoRejeicao = ?,
            dataCancelamento = CURRENT_TIMESTAMP,
            motivoCancelamento = ?
        WHERE id = ?
      `).run(motivo, `Orçamento rejeitado pelo cliente: ${motivo}`, os.id);

      registrarEvento(db, os.id, 'rejeitado', motivo, null, { ip, userAgent: ua, motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ASSINATURAS (cliente e técnico) ====================

  app.post('/api/os/:id/assinar', (req, res) => {
    try {
      const { ator, dataUrl } = req.body || {};
      if (!['cliente', 'tecnico'].includes(ator)) {
        return res.status(400).json({ success: false, error: 'ator deve ser "cliente" ou "tecnico"' });
      }
      if (!dataUrl || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
        return res.status(400).json({ success: false, error: 'dataUrl inválido (esperado PNG/JPEG base64)' });
      }
      const col = ator === 'cliente' ? 'assinaturaClienteDataUrl' : 'assinaturaTecnicoDataUrl';
      const colData = ator === 'cliente' ? 'assinaturaClienteData' : 'assinaturaTecnicoData';
      db.prepare(`UPDATE os_ordens SET ${col} = ?, ${colData} = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(dataUrl, req.params.id);
      registrarEvento(db, req.params.id, 'assinatura', `Assinatura do ${ator}`, req.user?.username, { ator });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== NOTIFICAÇÕES CONFIGURÁVEIS (fase 9.5) ====================

  app.get('/api/os/notificacoes-config', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT id, evento, canal, template, ativo
        FROM os_notificacoes_config
        ORDER BY evento, canal
      `).all();
      res.json({ success: true, configs: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Vocabulário para a tela montar os selects — antes a lista morava no
  // HTML e tinha divergido: 3 eventos que ninguém emite e 2 reais de fora.
  app.get('/api/os/notificacoes-vocabulario', (req, res) => {
    res.json({ success: true, eventos: EVENTOS_NOTIF, canais: CANAIS, placeholders: PLACEHOLDERS });
  });

  app.get('/api/os/notificacoes-log', (req, res) => {
    try {
      const limite = Math.min(Number(req.query.limit) || 50, 200);
      const rows = db.prepare(`SELECT l.*, o.numero AS osNumero
        FROM os_notificacoes_log l LEFT JOIN os_ordens o ON o.id = l.osId
        ORDER BY l.id DESC LIMIT ?`).all(limite);
      const falhas = db.prepare(`SELECT COUNT(*) n FROM os_notificacoes_log
        WHERE status = 'erro' AND date(data) >= date('now','-7 days')`).get().n;
      res.json({ success: true, log: rows, falhas7d: falhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Envio de teste: a única forma de descobrir que o canal está fora
  // antes do evento real acontecer.
  app.post('/api/os/notificacoes-config/testar', async (req, res) => {
    try {
      const { evento, canal, template, osId } = req.body || {};
      if (!EVENTOS_VALIDOS.includes(evento)) return res.status(400).json({ success: false, error: 'evento inválido' });
      if (!CANAIS.some(c => c.valor === canal)) return res.status(400).json({ success: false, error: 'canal inválido' });
      const r = await enviarTeste(db, { evento, canal, template, osId: osId ? Number(osId) : null });
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/notificacoes-config', (req, res) => {
    try {
      const { evento, canal, template, ativo } = req.body || {};
      if (!evento || !canal) return res.status(400).json({ success: false, error: 'evento e canal são obrigatórios' });
      if (!EVENTOS_VALIDOS.includes(evento)) {
        return res.status(400).json({ success: false, error: `evento inválido — o sistema não emite "${evento}"` });
      }
      if (!['email', 'whatsapp', 'telegram'].includes(canal)) {
        return res.status(400).json({ success: false, error: 'canal inválido' });
      }
      const info = db.prepare(`
        INSERT INTO os_notificacoes_config (evento, canal, template, ativo)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(evento, canal) DO UPDATE SET template = excluded.template, ativo = excluded.ativo
      `).run(evento, canal, template || null, ativo ? 1 : 0);
      res.json({ success: true, id: info.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/notificacoes-config/:id', (req, res) => {
    try {
      db.prepare(`DELETE FROM os_notificacoes_config WHERE id = ?`).run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== RELATÓRIOS (fase 9.6) ====================
  // Todos aceitam ?de=YYYY-MM-DD&ate=YYYY-MM-DD como filtro de dataAbertura.

  function filtroPeriodo(req) {
    const { de, ate } = req.query;
    const cond = [];
    const params = [];
    if (de)  { cond.push(`date(o.dataAbertura) >= ?`); params.push(de); }
    if (ate) { cond.push(`date(o.dataAbertura) <= ?`); params.push(ate); }
    return { where: cond.length ? ' AND ' + cond.join(' AND ') : '', params };
  }

  // Por técnico: total de OS, receita de serviços, comissão devida.
  app.get('/api/os/relatorios/por-tecnico', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT u.id AS tecnicoId, u.username AS tecnicoNome,
               u.comissaoPercentual AS comissaoPercentual,
               COUNT(o.id) AS totalOS,
               SUM(CASE WHEN o.status = 'faturada' THEN 1 ELSE 0 END) AS faturadas,
               SUM(CASE WHEN o.status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
               COALESCE(SUM(o.valorPecas), 0) AS valorPecas,
               COALESCE(SUM(o.valorServicos), 0) AS valorServicos,
               COALESCE(SUM(o.valorTotal), 0) AS valorTotal,
               COALESCE(SUM(CASE WHEN o.status = 'faturada' THEN o.valorServicos ELSE 0 END), 0) AS receitaServicosFaturada,
               COALESCE(SUM(CASE WHEN o.status = 'faturada' THEN o.valorServicos * IFNULL(u.comissaoPercentual,0) / 100.0 ELSE 0 END), 0) AS comissaoDevida,
               -- Sem custo, um técnico que fatura 10k gastando 9k em peças
               -- ficava idêntico a outro que faturou 10k de mão de obra.
               COALESCE(SUM((
                 SELECT COALESCE(SUM(COALESCE(ip.custoUnitario, pr.precoCusto, 0) * ip.quantidade
                        + CASE WHEN ip.compradoTerceiro = 1 THEN COALESCE(ip.custoTerceiro,0) ELSE 0 END), 0)
                 FROM os_itens_pecas ip LEFT JOIN produtos pr ON pr.id = ip.produtoId
                 WHERE ip.osId = o.id)), 0) AS custoPecas,
               COALESCE(SUM((SELECT COALESCE(SUM(a.horas),0) FROM os_apontamentos a WHERE a.osId = o.id)), 0) AS horasApontadas,
               COALESCE(SUM((SELECT COALESCE(SUM(s.horas),0) FROM os_itens_servicos s WHERE s.osId = o.id)), 0) AS horasCobradas,
               u.valorHora AS valorHora
        FROM os_ordens o
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE 1=1 ${f.where}
        GROUP BY u.id, u.username, u.comissaoPercentual, u.valorHora
        ORDER BY valorTotal DESC
      `).all(...f.params);

      const linhas = rows.map(r => {
        const custoMaoDeObra = Number((r.horasApontadas * (r.valorHora || 0)).toFixed(2));
        const margem = Number((r.valorTotal - r.custoPecas - custoMaoDeObra).toFixed(2));
        return {
          ...r, custoMaoDeObra, margem,
          margemPct: r.valorTotal > 0 ? Number((margem / r.valorTotal * 100).toFixed(1)) : null,
          horasNaoCobradas: Number((r.horasApontadas - r.horasCobradas).toFixed(2)),
          // Aproveitamento: quanto do tempo gasto virou hora faturada.
          aproveitamentoHoras: r.horasApontadas > 0
            ? Number((r.horasCobradas / r.horasApontadas * 100).toFixed(1)) : null,
          semValorHora: !r.valorHora,
        };
      });
      res.json({ success: true, linhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Por cliente
  app.get('/api/os/relatorios/por-cliente', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT p.id AS clienteId, p.razaoSocial AS clienteNome, p.cpfCnpj,
               COUNT(o.id) AS totalOS,
               SUM(CASE WHEN o.status = 'faturada' THEN 1 ELSE 0 END) AS faturadas,
               COALESCE(SUM(o.valorTotal), 0) AS valorTotal,
               COALESCE(SUM(CASE WHEN o.status = 'faturada' THEN o.valorTotal ELSE 0 END), 0) AS receitaFaturada,
               MAX(o.dataAbertura) AS ultimaAbertura,
               -- Mesmo tratamento do por-técnico: cliente que gera receita
               -- alta consumindo peça cara não é cliente bom.
               COALESCE(SUM((
                 SELECT COALESCE(SUM(COALESCE(ip.custoUnitario, pr.precoCusto, 0) * ip.quantidade
                        + CASE WHEN ip.compradoTerceiro = 1 THEN COALESCE(ip.custoTerceiro,0) ELSE 0 END), 0)
                 FROM os_itens_pecas ip LEFT JOIN produtos pr ON pr.id = ip.produtoId
                 WHERE ip.osId = o.id)), 0) AS custoPecas,
               COALESCE(SUM((SELECT COALESCE(SUM(a.horas),0) FROM os_apontamentos a WHERE a.osId = o.id)), 0) AS horasApontadas,
               COALESCE(SUM((SELECT COALESCE(SUM(s.horas),0) FROM os_itens_servicos s WHERE s.osId = o.id)), 0) AS horasCobradas,
               COALESCE(SUM((
                 SELECT COALESCE(SUM(a.horas),0) * COALESCE(u.valorHora,0)
                 FROM os_apontamentos a LEFT JOIN users u ON u.id = o.tecnicoId
                 WHERE a.osId = o.id)), 0) AS custoMaoDeObra,
               COUNT(DISTINCT o.equipamentoId) AS equipamentos
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        WHERE 1=1 ${f.where}
        GROUP BY p.id, p.razaoSocial, p.cpfCnpj
        ORDER BY valorTotal DESC
        LIMIT 100
      `).all(...f.params);

      const linhas = rows.map(r => {
        const margem = Number((r.valorTotal - r.custoPecas - r.custoMaoDeObra).toFixed(2));
        return {
          ...r,
          custoPecas: Number(Number(r.custoPecas).toFixed(2)),
          custoMaoDeObra: Number(Number(r.custoMaoDeObra).toFixed(2)),
          margem,
          margemPct: r.valorTotal > 0 ? Number((margem / r.valorTotal * 100).toFixed(1)) : null,
          horasNaoCobradas: Number((r.horasApontadas - r.horasCobradas).toFixed(2)),
          // Mais OS do que equipamentos = o mesmo aparelho voltando.
          osPorEquipamento: r.equipamentos > 0
            ? Number((r.totalOS / r.equipamentos).toFixed(2)) : null,
        };
      });
      res.json({ success: true, linhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Qualidade do cadastro que sustenta a margem.
   *
   * Os relatórios já avisam que o número está incompleto (semValorHora,
   * custoMaoDeObraEstimado), mas não diziam QUEM ou O QUÊ corrigir. Sem
   * isso a margem fica errada para sempre e ninguém sabe onde mexer.
   */
  app.get('/api/os/relatorios/qualidade-cadastro', (req, res) => {
    try {
      const f = filtroPeriodo(req);

      // Técnicos que apontaram hora no período e não têm valorHora: cada
      // hora deles entra como custo zero.
      const tecnicos = db.prepare(`
        SELECT u.id, COALESCE(u.nome, u.username) AS nome,
               COUNT(DISTINCT o.id) AS osNoPeriodo,
               COALESCE(SUM((SELECT COALESCE(SUM(a.horas),0) FROM os_apontamentos a WHERE a.osId = o.id)), 0) AS horasApontadas
        FROM os_ordens o JOIN users u ON u.id = o.tecnicoId
        WHERE u.ativo = 1 AND (u.valorHora IS NULL OR u.valorHora <= 0) ${f.where}
        GROUP BY u.id
        HAVING horasApontadas > 0
        ORDER BY horasApontadas DESC`).all(...f.params);

      // Produtos consumidos em OS sem custo conhecido em nenhuma fonte.
      const produtos = db.prepare(`
        SELECT pr.id, pr.sku, pr.descricao,
               COUNT(DISTINCT ip.osId) AS osNoPeriodo,
               COALESCE(SUM(ip.quantidade), 0) AS quantidade,
               COALESCE(SUM(ip.valorTotal), 0) AS valorVendido
        FROM os_itens_pecas ip
        JOIN os_ordens o ON o.id = ip.osId
        JOIN produtos pr ON pr.id = ip.produtoId
        WHERE ip.compradoTerceiro = 0
          AND COALESCE(ip.custoUnitario, 0) <= 0
          AND COALESCE(pr.precoCusto, 0) <= 0
          AND NOT EXISTS (SELECT 1 FROM movimentacoes_estoque m
                          WHERE m.produtoId = pr.id AND m.custoMedioPosterior > 0)
          ${f.where}
        GROUP BY pr.id
        ORDER BY valorVendido DESC`).all(...f.params);

      // OS faturada sem técnico: não entra em nenhum rateio por técnico.
      const semTecnico = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(o.valorTotal),0) valor
        FROM os_ordens o
        WHERE o.tecnicoId IS NULL AND o.status IN ('concluida','faturada') ${f.where}`).get(...f.params);

      const receitaAfetada = Number(produtos.reduce((s, p) => s + p.valorVendido, 0).toFixed(2));
      res.json({
        success: true,
        tecnicosSemValorHora: tecnicos,
        produtosSemCusto: produtos,
        osSemTecnico: semTecnico,
        resumo: {
          horasSemCusto: Number(tecnicos.reduce((s, t) => s + t.horasApontadas, 0).toFixed(2)),
          receitaComPecaSemCusto: receitaAfetada,
          // Se está tudo zerado, a margem dos relatórios é confiável.
          cadastroCompleto: !tecnicos.length && !produtos.length && !semTecnico.n,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Por equipamento (agrupado por marca + modelo)
  app.get('/api/os/relatorios/por-equipamento', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      // Agrupa pelo equipamento cadastrado quando existe; o texto livre
      // fica só como fallback das OS antigas. Antes, cada variação de
      // digitação virava uma linha diferente do relatório.
      //
      // Os parênteses no WHERE não são cosméticos: AND liga mais forte que
      // OR, então `marca IS NOT NULL OR modelo IS NOT NULL AND data >= ?`
      // deixava passar toda OS com marca preenchida, ignorando o período.
      const rows = db.prepare(`
        SELECT COALESCE(e.marca, o.marca, '—') AS marca,
               COALESCE(e.modelo, o.modelo, '—') AS modelo,
               COALESCE(e.descricao, o.equipamento, '—') AS equipamento,
               e.id AS equipamentoId, e.numeroSerie,
               COUNT(o.id) AS totalOS,
               SUM(CASE WHEN o.emGarantia = 1 THEN 1 ELSE 0 END) AS emGarantia,
               COUNT(DISTINCT o.clienteId) AS clientes,
               COALESCE(SUM(o.valorTotal), 0) AS valorTotal
        FROM os_ordens o
        LEFT JOIN equipamentos e ON e.id = o.equipamentoId
        WHERE (o.equipamentoId IS NOT NULL OR o.marca IS NOT NULL OR o.modelo IS NOT NULL) ${f.where}
        GROUP BY COALESCE(o.equipamentoId, -1),
                 COALESCE(e.marca, o.marca, '—'),
                 COALESCE(e.modelo, o.modelo, '—'),
                 COALESCE(e.descricao, o.equipamento, '—')
        ORDER BY totalOS DESC
        LIMIT 100
      `).all(...f.params);
      res.json({ success: true, linhas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Lucratividade: receita − custo de peças − custo de mão de obra.
   *
   * A versão anterior lia `produtos.custoMedio`, coluna que NÃO EXISTE —
   * o endpoint estourava com "no such column" e devolvia 500. O custo real
   * vem, em ordem: custo gravado na baixa da peça → custo da movimentação
   * de estoque da OS → último custo médio conhecido do produto →
   * produtos.precoCusto.
   *
   * Mão de obra usa users.valorHora sobre as horas APONTADAS (tempo real
   * gasto), não sobre as horas cobradas — é isso que revela serviço
   * vendido barato demais.
   */
  app.get('/api/os/relatorios/lucratividade', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const custoPecasSQL = `(
        SELECT COALESCE(SUM(
          COALESCE(
            ip.custoUnitario,
            (SELECT m.custoUnitario FROM movimentacoes_estoque m
              WHERE m.id = ip.movSaidaId AND m.custoUnitario IS NOT NULL),
            (SELECT m.custoMedioPosterior FROM movimentacoes_estoque m
              WHERE m.produtoId = ip.produtoId AND m.custoMedioPosterior IS NOT NULL
              ORDER BY m.data DESC, m.id DESC LIMIT 1),
            pr.precoCusto,
            0
          ) * ip.quantidade
          -- Peça comprada de terceiro para a OS: o custo é o que se pagou.
          + CASE WHEN ip.compradoTerceiro = 1 THEN COALESCE(ip.custoTerceiro,0) ELSE 0 END
        ), 0)
        FROM os_itens_pecas ip
        LEFT JOIN produtos pr ON pr.id = ip.produtoId
        WHERE ip.osId = o.id)`;
      const horasApontadasSQL = `(SELECT COALESCE(SUM(a.horas),0) FROM os_apontamentos a WHERE a.osId = o.id)`;
      const horasCobradasSQL = `(SELECT COALESCE(SUM(s.horas),0) FROM os_itens_servicos s WHERE s.osId = o.id)`;
      const custoMOSQL = `(${horasApontadasSQL} * COALESCE(u.valorHora, 0))`;

      const rows = db.prepare(`
        SELECT o.id AS osId, o.numero, o.dataAbertura, o.status,
               p.razaoSocial AS clienteNome,
               COALESCE(u.nome, u.username) AS tecnicoNome,
               o.valorPecas, o.valorServicos, o.valorTotal,
               ${custoPecasSQL} AS custoPecas,
               ${custoMOSQL} AS custoMaoDeObra,
               ${horasApontadasSQL} AS horasApontadas,
               ${horasCobradasSQL} AS horasCobradas,
               (o.valorTotal - ${custoPecasSQL}) AS margemBruta,
               (o.valorTotal - ${custoPecasSQL} - ${custoMOSQL}) AS margemLiquida
        FROM os_ordens o
        LEFT JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.status IN ('concluida','faturada') ${f.where}
        ORDER BY o.dataAbertura DESC
        LIMIT 500
      `).all(...f.params);

      const linhas = rows.map(r => ({
        ...r,
        margemPct: r.valorTotal > 0 ? Number((r.margemLiquida / r.valorTotal * 100).toFixed(1)) : null,
        // Horas gastas além do que foi cobrado: vazamento de produtividade.
        horasNaoCobradas: Number((r.horasApontadas - r.horasCobradas).toFixed(2)),
        // Sem valorHora do técnico o custo de MO é zero e a margem líquida
        // fica igual à bruta — melhor dizer do que deixar parecer lucro.
        custoMaoDeObraEstimado: r.custoMaoDeObra > 0,
      }));
      const totais = linhas.reduce((a, l) => ({
        receita: a.receita + (l.valorTotal || 0),
        custoPecas: a.custoPecas + (l.custoPecas || 0),
        custoMaoDeObra: a.custoMaoDeObra + (l.custoMaoDeObra || 0),
        margemLiquida: a.margemLiquida + (l.margemLiquida || 0),
        horasApontadas: a.horasApontadas + (l.horasApontadas || 0),
        horasCobradas: a.horasCobradas + (l.horasCobradas || 0),
      }), { receita: 0, custoPecas: 0, custoMaoDeObra: 0, margemLiquida: 0, horasApontadas: 0, horasCobradas: 0 });
      for (const k of Object.keys(totais)) totais[k] = Number(totais[k].toFixed(2));
      totais.margemPct = totais.receita > 0 ? Number((totais.margemLiquida / totais.receita * 100).toFixed(1)) : null;
      totais.semValorHora = linhas.filter(l => l.horasApontadas > 0 && !l.custoMaoDeObraEstimado).length;

      res.json({ success: true, linhas, totais });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // SLA: resumo de cumprimento no período
  app.get('/api/os/relatorios/sla', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const resumo = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN slaStatus = 'cumprido' THEN 1 ELSE 0 END) AS cumpridos,
          SUM(CASE WHEN slaStatus = 'estourado' THEN 1 ELSE 0 END) AS estourados,
          SUM(CASE WHEN slaStatus = 'atrasado' THEN 1 ELSE 0 END) AS atrasados,
          SUM(CASE WHEN slaStatus = 'risco' THEN 1 ELSE 0 END) AS emRisco,
          SUM(CASE WHEN slaStatus = 'no-prazo' THEN 1 ELSE 0 END) AS noPrazo,
          SUM(CASE WHEN slaStatus IS NULL THEN 1 ELSE 0 END) AS semSla
        FROM os_ordens o
        WHERE 1=1 ${f.where}
      `).get(...f.params);
      const porTecnico = db.prepare(`
        SELECT u.username AS tecnicoNome,
               COUNT(*) AS total,
               SUM(CASE WHEN o.slaStatus = 'cumprido' THEN 1 ELSE 0 END) AS cumpridos,
               SUM(CASE WHEN o.slaStatus = 'estourado' THEN 1 ELSE 0 END) AS estourados,
               SUM(CASE WHEN o.slaStatus = 'atrasado' THEN 1 ELSE 0 END) AS atrasados
        FROM os_ordens o
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.slaStatus IS NOT NULL ${f.where}
        GROUP BY u.id, u.username
        ORDER BY total DESC
      `).all(...f.params);
      res.json({ success: true, resumo, porTecnico });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Comissões: detalhe por OS faturada
  app.get('/api/os/relatorios/comissoes', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT o.id AS osId, o.numero, o.dataFaturamento,
               u.id AS tecnicoId, u.username AS tecnicoNome,
               u.comissaoPercentual,
               o.valorServicos,
               (o.valorServicos * IFNULL(u.comissaoPercentual, 0) / 100.0) AS comissao
        FROM os_ordens o
        JOIN users u ON u.id = o.tecnicoId
        WHERE o.status = 'faturada' AND u.comissaoPercentual > 0 ${f.where}
        ORDER BY o.dataFaturamento DESC
      `).all(...f.params);
      const totais = rows.reduce((acc, r) => {
        acc.valorServicos += r.valorServicos || 0;
        acc.comissao += r.comissao || 0;
        return acc;
      }, { valorServicos: 0, comissao: 0 });
      res.json({ success: true, linhas: rows, totais });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasOS };
