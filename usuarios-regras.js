/**
 * usuarios-regras.js — o que precisa ser verdade num cadastro de usuário.
 *
 * A parte de segurança do login já está resolvida (rate limit por IP, mensagem
 * uniforme anti-enumeração, regeneração de sessão, auditoria de tentativas).
 * O que faltava é do outro lado: os campos do cadastro que outros módulos usam
 * para mover dinheiro, e que ninguém validava na origem.
 *
 *   comissaoPercentual — virou regra de comissão quando o vendedor não tem
 *                        regra escrita. 500 digitado no lugar de 5 paga 500%
 *                        da venda, e o erro só aparece na apuração.
 *   cpfCnpj            — é por ele que o pagamento da comissão encontra o
 *                        fornecedor. Inválido ou vazio trava o pagamento com
 *                        "vendedor sem fornecedor vinculado".
 *   metaMensal         — alimenta gatilho e acelerador de meta.
 *   email              — destino de notificação; sem validação vira envio que
 *                        falha em silêncio.
 *
 * Nenhum deles tinha uma linha de validação. É o mesmo padrão que aparece em
 * todo o sistema: campo coletado, ligado a dinheiro, sem checagem na entrada.
 */

const erro = (codigo, mensagem, extra = {}) => ({ nivel: 'erro', codigo, mensagem, ...extra });
const aviso = (codigo, mensagem, extra = {}) => ({ nivel: 'aviso', codigo, mensagem, ...extra });

const { E_FORNECEDOR } = require('./pessoas-fornecedor');

const VENDEDOR_TIPOS = ['interno', 'externo', 'representante'];
const SENHA_MINIMA = 6;   // igual à regra já aplicada nas rotas

// ==================== DOCUMENTO ====================

function digitos(v) { return String(v || '').replace(/\D/g, ''); }

function cpfValido(cpf) {
  const d = digitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const [ate, pos] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (pos - i);
    if ((soma * 10) % 11 % 10 !== Number(d[ate])) return false;
  }
  return true;
}

function cnpjValido(cnpj) {
  const d = digitos(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (base) => {
    let peso = base.length - 7, soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(d.slice(0, 12)) === Number(d[12]) && calc(d.slice(0, 13)) === Number(d[13]);
}

function documentoValido(v) {
  const d = digitos(v);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

function emailValido(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t || t.length > 254) return false;
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(t)) return false;
  return /^[a-z]{2,}$/.test(t.split('.').pop());
}

// ==================== SENHA ====================

/**
 * Força da senha. Não bloqueia além do mínimo já exigido pelas rotas — barrar
 * senha "fraca porém legal" travaria o admin no meio de um cadastro. Mas senha
 * igual ao username ou óbvia é bloqueio: essas caem no primeiro chute de quem
 * já sabe o nome de usuário.
 */
const SENHAS_OBVIAS = new Set([
  '123456', '1234567', '12345678', '123456789', 'senha', 'senha123', 'password',
  'admin', 'admin123', 'qwerty', 'abc123', '111111', 'mudar123', 'trocar123',
]);

function avaliarSenha(senha, { username, nome } = {}) {
  const p = [];
  const s = String(senha || '');
  if (s.length < SENHA_MINIMA) {
    return [erro('senha_curta', `Senha deve ter ao menos ${SENHA_MINIMA} caracteres`)];
  }
  const baixa = s.toLowerCase();
  if (SENHAS_OBVIAS.has(baixa)) {
    p.push(erro('senha_obvia', 'Senha muito comum — é a primeira que se tenta num ataque'));
  }
  if (username && baixa.includes(String(username).toLowerCase()) && String(username).length >= 3) {
    p.push(erro('senha_igual_username', 'Senha não pode conter o nome de usuário'));
  }
  if (nome) {
    const primeiro = String(nome).trim().split(/\s+/)[0];
    if (primeiro.length >= 4 && baixa.includes(primeiro.toLowerCase())) {
      p.push(aviso('senha_com_nome', 'A senha contém o nome do usuário — fácil de adivinhar'));
    }
  }
  const variedade = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(s)).length;
  if (variedade <= 1 && s.length < 12) {
    p.push(aviso('senha_pouco_variada',
      'Senha só de um tipo de caractere — misture maiúsculas, números ou símbolos, ou use uma frase longa'));
  }
  return p;
}

// ==================== CADASTRO ====================

/**
 * @param {object} opts.id  id do usuário quando é edição (evita acusar o
 *   próprio registro nas checagens de duplicidade).
 */
function validarUsuario(db, dados, opts = {}) {
  const p = [];
  const id = opts.id || -1;

  if (dados.email != null && String(dados.email).trim() !== '' && !emailValido(dados.email)) {
    p.push(erro('email_invalido', 'E-mail inválido'));
  }

  // E-mail duplicado não é ilegal, mas quebra recuperação de senha e faz a
  // notificação chegar na pessoa errada.
  if (dados.email && emailValido(dados.email)) {
    try {
      const outro = db.prepare(
        'SELECT id, username FROM users WHERE LOWER(TRIM(COALESCE(email,\'\'))) = ? AND id <> ?')
        .get(String(dados.email).trim().toLowerCase(), id);
      if (outro) {
        p.push(aviso('email_duplicado',
          `E-mail já usado por ${outro.username} — notificações dos dois vão para a mesma caixa`,
          { usuarioId: outro.id }));
      }
    } catch { /* coluna ausente */ }
  }

  const ehVendedor = [1, '1', true, 'true'].includes(dados.ehVendedor);

  // ---- documento ----
  const doc = String(dados.cpfCnpj || '').trim();
  if (doc && !documentoValido(doc)) {
    p.push(erro('documento_invalido', 'CPF/CNPJ inválido — confira os dígitos'));
  }
  if (doc && documentoValido(doc)) {
    try {
      const outro = db.prepare(`SELECT id, username FROM users
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cpfCnpj,''),'.',''),'-',''),'/',''),' ','') = ?
          AND id <> ?`).get(digitos(doc), id);
      if (outro) p.push(erro('documento_duplicado', `CPF/CNPJ já cadastrado para ${outro.username}`));
    } catch { /* coluna ausente */ }
  }

  // ---- campos que viram dinheiro ----
  if (dados.comissaoPercentual != null && dados.comissaoPercentual !== '') {
    const v = Number(dados.comissaoPercentual);
    if (!Number.isFinite(v) || v < 0) {
      p.push(erro('comissao_invalida', 'Percentual de comissão deve ser um número não negativo'));
    } else if (v > 100) {
      // O motor de comissão usa este número como percentual sobre a venda
      // quando não há regra escrita: 500 aqui paga 5x o valor vendido.
      p.push(erro('comissao_acima_de_100',
        `Comissão de ${v}% — o campo é percentual sobre a venda, vai de 0 a 100`));
    } else if (v > 30) {
      p.push(aviso('comissao_alta', `Comissão de ${v}% é incomum — confirme antes de gravar`));
    }
  }

  if (dados.metaMensal != null && dados.metaMensal !== '') {
    const v = Number(dados.metaMensal);
    if (!Number.isFinite(v) || v < 0) {
      p.push(erro('meta_invalida', 'Meta mensal deve ser um valor não negativo'));
    }
  }

  if (dados.vendedorTipo && !VENDEDOR_TIPOS.includes(dados.vendedorTipo)) {
    p.push(erro('vendedor_tipo_invalido', `Tipo de vendedor deve ser: ${VENDEDOR_TIPOS.join(', ')}`));
  }

  // ---- coerência do vendedor ----
  if (ehVendedor) {
    if (!doc) {
      // A rota de pagamento resolve o fornecedor pelo documento do vendedor;
      // sem ele a comissão é apurada e não consegue ser paga.
      p.push(aviso('vendedor_sem_documento',
        'Vendedor sem CPF/CNPJ: a comissão vai ser apurada, mas o pagamento não encontra o fornecedor'));
    } else if (documentoValido(doc)) {
      try {
        const forn = db.prepare(`SELECT id FROM pessoas
          WHERE ${E_FORNECEDOR}
            AND REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cpfCnpj,''),'.',''),'-',''),'/',''),' ','') = ?`)
          .get(digitos(doc));
        if (!forn) {
          p.push(aviso('vendedor_sem_fornecedor',
            'Não há fornecedor com este CPF/CNPJ — cadastre-o para conseguir pagar a comissão'));
        }
      } catch { /* tenant sem fornecedores */ }
    }
    const temPercentual = dados.comissaoPercentual != null && dados.comissaoPercentual !== ''
      && Number(dados.comissaoPercentual) > 0;
    if (!temPercentual && opts.checarRegras !== false) {
      try {
        const regras = db.prepare(`SELECT COUNT(*) n FROM comissoes_regras
          WHERE ativo = 1 AND (vendedorId IS NULL OR vendedorId = ?)`).get(id).n;
        if (!regras) {
          p.push(aviso('vendedor_sem_comissao',
            'Vendedor sem percentual no cadastro e sem regra de comissão que o alcance — '
            + 'as vendas dele vão apurar zero'));
        }
      } catch { /* tenant sem o módulo de comissões */ }
    }
  } else {
    // Campos de vendedor preenchidos com a flag desligada não são usados por
    // ninguém — quem preencheu acha que configurou algo.
    const sobras = ['comissaoPercentual', 'metaMensal', 'vendedorTipo', 'telefoneVendedor']
      .filter((c) => dados[c] != null && dados[c] !== '');
    if (sobras.length) {
      p.push(aviso('campos_de_vendedor_ignorados',
        `${sobras.join(', ')} só valem com "é vendedor" marcado — hoje esses valores não são usados`));
    }
  }

  return p;
}

// ==================== DIAGNÓSTICO ====================

const DIAS = 86400000;

/**
 * Situação de acesso da equipe. Nada aqui bloqueia nada: é o que um
 * administrador precisa ver sem procurar, e que hoje não existe em lugar
 * nenhum — a tela lista nomes e para por aí.
 */
function diagnostico(db, opts = {}) {
  const agora = opts.agora ? new Date(opts.agora) : new Date();
  const hoje = agora.toISOString().slice(0, 10);
  const diasSem = (d) => (d ? Math.floor((agora - new Date(String(d).replace(' ', 'T') + 'Z')) / DIAS) : null);

  const usuarios = db.prepare(`SELECT id, username, nome, email, role, ativo, ultimoLogin, createdAt,
    ehVendedor, cpfCnpj, comissaoPercentual FROM users`).all();

  const ativos = usuarios.filter((u) => u.ativo === 1);
  const admins = ativos.filter((u) => u.role === 'admin');

  const nuncaEntraram = ativos.filter((u) => !u.ultimoLogin)
    .map((u) => ({ id: u.id, username: u.username, criadoEm: u.createdAt,
                   diasDesdeCriacao: diasSem(u.createdAt) }));

  const semAcessoRecente = ativos.filter((u) => u.ultimoLogin && diasSem(u.ultimoLogin) >= (opts.diasInatividade || 60))
    .map((u) => ({ id: u.id, username: u.username, ultimoLogin: u.ultimoLogin, dias: diasSem(u.ultimoLogin) }))
    .sort((a, b) => b.dias - a.dias);

  const semEmail = ativos.filter((u) => !u.email || !emailValido(u.email))
    .map((u) => ({ id: u.id, username: u.username, email: u.email || null }));

  // Vendedores que não conseguem receber: a apuração roda, o pagamento não.
  const vendedores = ativos.filter((u) => u.ehVendedor === 1);
  const vendedoresSemPagamento = vendedores
    .filter((u) => !u.cpfCnpj || !documentoValido(u.cpfCnpj))
    .map((u) => ({ id: u.id, username: u.username, cpfCnpj: u.cpfCnpj || null }));

  let comissaoPendentePorVendedorInativo = [];
  try {
    comissaoPendentePorVendedorInativo = db.prepare(`
      SELECT u.id, u.username, COUNT(*) AS linhas, ROUND(SUM(a.valorComissao), 2) AS valor
      FROM comissoes_apuracao a JOIN users u ON u.id = a.vendedorId
      WHERE a.status = 'pendente' AND u.ativo = 0
      GROUP BY u.id, u.username`).all();
  } catch { /* tenant sem comissões */ }

  return {
    referencia: hoje,
    total: usuarios.length,
    ativos: ativos.length,
    inativos: usuarios.length - ativos.length,
    admins: admins.length,
    // Um administrador só significa que férias, demissão ou senha perdida
    // deixam a empresa sem quem administre o sistema.
    adminUnico: admins.length === 1 ? { id: admins[0].id, username: admins[0].username } : null,
    porRole: Object.entries(ativos.reduce((acc, u) => {
      acc[u.role] = (acc[u.role] || 0) + 1; return acc;
    }, {})).map(([role, n]) => ({ role, n })),
    nuncaEntraram,
    semAcessoRecente,
    semEmail,
    vendedores: vendedores.length,
    vendedoresSemPagamento,
    comissaoPendentePorVendedorInativo,
  };
}

/**
 * O que se perde ao desativar este usuário. Desativar é reversível, mas o
 * trabalho pendente dele não some — só deixa de ter dono.
 */
function impactoDesativacao(db, id) {
  const pendencias = [];
  const contar = (sql, rotulo, params = [id]) => {
    try {
      const n = db.prepare(sql).get(...params).n;
      if (n > 0) pendencias.push({ rotulo, n });
    } catch { /* tabela ausente neste tenant */ }
  };

  contar("SELECT COUNT(*) n FROM comissoes_apuracao WHERE vendedorId = ? AND status = 'pendente'",
    'comissões apuradas e não pagas');
  contar("SELECT COUNT(*) n FROM pedidos WHERE vendedorId = ? AND status IN ('rascunho','confirmado')",
    'pedidos de venda em aberto');
  contar("SELECT COUNT(*) n FROM ordens_servico WHERE responsavelId = ? AND status NOT IN ('concluida','cancelada')",
    'ordens de serviço em andamento');

  const u = db.prepare('SELECT id, username, role, ativo FROM users WHERE id = ?').get(id);
  const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE ativo = 1 AND role = 'admin'").get().n;

  return {
    usuario: u || null,
    pendencias,
    // Bloquear não é possível pelas rotas (o próprio admin não se desativa),
    // mas avisar antes evita descobrir depois.
    ficariaSemAdmin: !!(u && u.role === 'admin' && u.ativo === 1 && admins <= 1),
  };
}

module.exports = {
  VENDEDOR_TIPOS, SENHA_MINIMA,
  cpfValido, cnpjValido, documentoValido, emailValido,
  avaliarSenha,
  validarUsuario,
  diagnostico, impactoDesativacao,
};
