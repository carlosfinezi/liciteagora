/**
 * pedido-desconto.js — desconto comercial do pedido, com alçada.
 *
 * LIGADO em 2026-09-11 (Fase 1 funcional) a `pedidos-routes.js` — POST, PUT e
 * confirmação — e já antes a `faturas-routes.js`, que herda o desconto do
 * pedido. As 6 colunas existem nos 19 tenants desde o rollout do relatório 18.
 *
 * Tudo aqui continua tolerante à ausência da coluna: `descontoDoPedido()`
 * devolve zero quando ela não existe e `totalDoPedido()` segue somando
 * itens + frete. Isso não é resto de transição — é o que faz um tenant novo,
 * criado antes de a migration rodar nele, funcionar sem desconto em vez de
 * quebrar a cada item adicionado.
 *
 * ── Por que desconto vira conceito próprio ──────────────────────────────────
 *
 * Até aqui, desconto no pedido só existia embutido no `precoUnitario` — e a
 * política de preço de 2026-09-10 fechou esse caminho para o vendedor restrito.
 * Na prática, ele ficou sem como dar desconto nenhum. Este módulo devolve a
 * capacidade pela porta certa: o preço do item continua sendo o oficial,
 * resolvido pelo servidor, e o abatimento aparece separado, auditável e sujeito
 * a alçada.
 *
 * ── O que este módulo NÃO faz ───────────────────────────────────────────────
 *
 *   - desconto por ITEM. Fica para depois: os exemplos do pedido são todos de
 *     cabeçalho, e `fatura_itens.valorDesconto` já não é preenchido hoje (o
 *     rateio por item não existe no ERP, nem para o desconto digitado ao
 *     faturar). Introduzir rateio aqui seria resolver um problema que não é
 *     desta fase.
 *   - acréscimo. Não foi pedido.
 */

const alcadas = require('./governanca-alcadas');
const politicas = require('./pedido-politicas');

const TIPOS_DESCONTO = ['valor', 'percentual'];

/** Evento de governança. Só passa a existir quando a migration o cadastra. */
const EVENTO_ALCADA = 'desconto_venda';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** A coluna existe neste tenant? Sem ela, tudo se comporta como desconto zero. */
function temColunaDesconto(db) {
  try {
    return db.prepare('PRAGMA table_info(pedidos)').all()
      .some((c) => c.name === 'descontoAplicado');
  } catch { return false; }
}

/**
 * Converte o desconto informado em reais.
 *
 * Recusa, não corrige: valor fora da regra volta como erro, para quem enviou
 * saber por quê. Mesma escolha de `erroValorFrete` e `erroQuantidade`.
 *
 * @returns {{ ok, aplicado, tipo, valor, percentual, erro }}
 */
function calcularDesconto({ subtotal, tipo, valor }) {
  const base = r2(subtotal);
  if (valor === undefined || valor === null || valor === '') {
    return { ok: true, aplicado: 0, tipo: null, valor: null, percentual: 0 };
  }
  const t = String(tipo || 'valor').toLowerCase();
  if (!TIPOS_DESCONTO.includes(t)) {
    return { ok: false, erro: `descontoTipo deve ser ${TIPOS_DESCONTO.join(' ou ')}` };
  }
  const v = Number(valor);
  if (!Number.isFinite(v)) return { ok: false, erro: 'desconto invalido' };
  if (v < 0) return { ok: false, erro: 'desconto nao pode ser negativo' };
  if (v === 0) return { ok: true, aplicado: 0, tipo: t, valor: 0, percentual: 0 };

  if (t === 'percentual') {
    if (v > 100) return { ok: false, erro: 'desconto percentual nao pode passar de 100%' };
    const aplicado = r2(base * v / 100);
    return { ok: true, aplicado, tipo: t, valor: v, percentual: r2(v) };
  }

  const aplicado = r2(v);
  if (base > 0 && aplicado > base) {
    return { ok: false,
      erro: `desconto (${aplicado.toFixed(2)}) maior que o subtotal dos itens (${base.toFixed(2)})` };
  }
  // Subtotal zero com desconto em reais: não há o que abater, e deixar passar
  // produziria total negativo assim que o primeiro item entrasse.
  if (base <= 0 && aplicado > 0) {
    return { ok: false, erro: 'pedido sem itens nao aceita desconto' };
  }
  return { ok: true, aplicado, tipo: t, valor: aplicado, percentual: base > 0 ? r2(aplicado * 100 / base) : 0 };
}

/**
 * Alçada do desconto, sobre o motor de governança que já existe.
 *
 * **A unidade do limite é PERCENTUAL**, não reais — e isso é deliberado. A
 * alçada comercial se enuncia em percentual ("vendedor até 10%"), e um limite em
 * reais mudaria de significado conforme o tamanho do pedido: R$ 50 é 50% de um
 * pedido de R$ 100 e 0,5% de um de R$ 10.000.
 *
 * O motor não precisou mudar: `regras_alcada.limiteValor` é REAL e
 * `regraAplicavel` só compara números. O que muda é a leitura do campo para
 * este `tipoEvento`.
 *
 * ── Como uma faixa se lê ────────────────────────────────────────────────────
 *
 * `(limiteValor = 10, papelAprovador = 'gerente-comercial')` quer dizer:
 * **desconto acima de 10% exige a autoridade do papel 'gerente-comercial'**.
 *
 * Daí saem as três respostas, nesta ordem:
 *
 *   1. **Abaixo da menor faixa** → passa direto. É a alçada base de todo mundo.
 *   2. **Acima de uma faixa, e o solicitante JÁ TEM o papel que ela exige** →
 *      passa direto, sem aprovação. Era o ponto que faltava: um gerente que dá
 *      20% cai na faixa de 10%, cuja autoridade é justamente a dele — não faz
 *      sentido pedir que outro gerente aprove o que ele mesmo aprovaria.
 *   3. **Acima de uma faixa cuja autoridade ele NÃO tem** → vai para o motor de
 *      aprovação, que cria/reaproveita a solicitação para o papel exigido.
 *
 * `admin` satisfaz qualquer papel — é o que `podeDecidir` já faz do outro lado
 * do balcão, e divergir disso criaria duas noções de autoridade.
 *
 * ── FAIL-CLOSED: sem alçada configurada, desconto é zero ────────────────────
 *
 * Até 2026-09-10 a ausência de faixas liberava qualquer desconto — a tabela
 * vazia era lida como "nada a barrar". Para o balcão isso é inaceitável: um
 * tenant que ainda não configurou a governança teria o vendedor dando 90%.
 *
 * Agora, **sem nenhuma faixa cadastrada, o desconto permitido é 0%** para quem
 * não é ator privilegiado. Não é bloqueio de venda: é bloqueio de DESCONTO —
 * o pedido continua saindo pelo preço oficial.
 *
 * **Privilegiado** aqui é o mesmo `atorIrrestrito` que o resto do módulo de
 * pedido já usa (`pedido-politicas.js`): `role='admin'`, chamada por X-Api-Key
 * sem sessão, ou usuário cujo role não tem perfil cadastrado. Reutilizado de
 * propósito — uma terceira definição de "privilegiado" no mesmo fluxo é como
 * nascem as divergências de permissão.
 *
 * @returns {{ liberado, status?, aprovacaoId?, regra?, motivo?, autoridade? }}
 */
function verificarAlcadaDesconto(db, { pedidoId, percentual, req = null, usuario = null, simular = false }) {
  const pct = r2(percentual);
  if (!(pct > 0)) return { liberado: true };

  const quem = usuario || (req && req.user && req.user.username) || null;
  const papel = (req && req.user && req.user.role) || null;
  let privilegiado;
  try { privilegiado = politicas.atorIrrestrito(db, req); }
  catch { privilegiado = !req; }

  let lista;
  try {
    lista = alcadas.faixas(db, EVENTO_ALCADA);
  } catch (e) {
    // Tenant sem as tabelas de governança. Fail-closed igual: não dá para
    // afirmar que o desconto está dentro de uma alçada que não existe.
    console.warn('[desconto] governança indisponível:', e.message);
    return privilegiado
      ? { liberado: true, autoridade: 'privilegiado', indisponivel: true }
      : { liberado: false, status: 'sem_alcada', indisponivel: true,
          motivo: 'Governança de desconto indisponível neste tenant — desconto não autorizado' };
  }

  if (!lista.length) {
    return privilegiado
      ? { liberado: true, autoridade: 'privilegiado' }
      : { liberado: false, status: 'sem_alcada',
          motivo: 'Nenhuma alçada de desconto configurada — o limite é 0%. '
                + 'Cadastre as faixas em Governança para liberar desconto.' };
  }

  const regra = alcadas.regraAplicavel(db, EVENTO_ALCADA, pct);
  if (!regra) return { liberado: true, autoridade: 'alcada_base' };

  // Já tem a autoridade que a faixa exige: aplica sem pedir a ninguém.
  if (papel && (papel === 'admin' || papel === regra.papelAprovador)) {
    return { liberado: true, autoridade: 'propria', regra };
  }
  if (!req) return { liberado: true, autoridade: 'sistema', regra };   // X-Api-Key

  // Modo simulação: responde "precisaria de aprovação" SEM abrir a solicitação.
  // Existe para que a exigência de motivo possa ser cobrada antes — sem isto, uma
  // tentativa sem justificativa já teria criado a solicitação, e o aprovador
  // receberia justamente o pedido sem motivo que a regra quer impedir.
  if (simular) return { liberado: false, status: 'pendente', simulado: true, regra };

  try {
    return alcadas.verificarAlcada(db, {
      tipoEvento: EVENTO_ALCADA,
      referenciaId: Number(pedidoId),
      valor: pct,
      usuario: quem,
    });
  } catch (e) {
    console.warn('[desconto] alçada indisponível:', e.message);
    return { liberado: false, status: 'sem_alcada', indisponivel: true,
      motivo: 'Não foi possível verificar a alçada — desconto não autorizado' };
  }
}

/**
 * Quanto este operador pode descontar SEM pedir aprovação a ninguém.
 *
 * Existe para a tela poder escrever "Limite disponível: R$ XX,XX" ao lado do
 * campo. É **informativo, e só**: quem decide continua sendo
 * `verificarAlcadaDesconto`, chamado no PUT. Nenhuma linha desta função é
 * consultada na hora de gravar — se ela mentir, o desconto ainda assim é
 * recusado pela alçada.
 *
 * O teto é o **menor limite cuja autoridade o operador não tem**. Um vendedor
 * sem papel nenhum esbarra na primeira faixa; um gerente-comercial passa pela
 * faixa que exige o papel dele e só para na seguinte. É a mesma leitura de
 * `verificarAlcadaDesconto`, e de propósito: duas contas diferentes para o mesmo
 * teto dariam ao operador um número que o servidor depois desmente.
 *
 * @returns {{ percentual, valor, ilimitado, motivo }} — `percentual` null quando
 *          não há teto; `valor` é o teto em reais sobre o subtotal atual.
 */
function limiteDescontoDisponivel(db, { pedidoId, req = null, subtotal = null }) {
  const base = subtotal == null ? subtotalItens(db, pedidoId) : r2(subtotal);
  const semTeto = (motivo) => ({ percentual: null, valor: null, ilimitado: true, motivo });

  let privilegiado;
  try { privilegiado = politicas.atorIrrestrito(db, req); }
  catch { privilegiado = !req; }
  if (privilegiado) return semTeto('ator irrestrito');

  let lista;
  try { lista = alcadas.faixas(db, EVENTO_ALCADA); }
  catch {
    return { percentual: 0, valor: 0, ilimitado: false,
      motivo: 'Governança de desconto indisponível neste tenant' };
  }
  if (!lista.length) {
    return { percentual: 0, valor: 0, ilimitado: false,
      motivo: 'Nenhuma alçada de desconto configurada — o limite é 0%' };
  }

  const papel = (req && req.user && req.user.role) || null;
  if (papel === 'admin') return semTeto('admin');

  const barram = lista.filter((f) => f.papelAprovador !== papel);
  if (!barram.length) return semTeto('o operador tem a autoridade de todas as faixas');

  const teto = r2(Math.min(...barram.map((f) => Number(f.limiteValor) || 0)));
  return { percentual: teto, valor: r2(base * teto / 100), ilimitado: false, motivo: null };
}

/** Desconto gravado no pedido, em reais. Zero quando a coluna não existe. */
function descontoDoPedido(db, pedidoId) {
  if (!temColunaDesconto(db)) return 0;
  try {
    const p = db.prepare('SELECT descontoAplicado FROM pedidos WHERE id = ?').get(pedidoId);
    return Math.max(0, Number(p && p.descontoAplicado) || 0);
  } catch { return 0; }
}

/**
 * A fórmula do total, num lugar só:
 *
 *     subtotal dos itens − desconto + frete
 *
 * O frete entra com piso zero (invariável da Fase 0) e o desconto nunca leva o
 * total abaixo de zero — se o subtotal encolher depois de o desconto ter sido
 * dado (item removido), o abatimento é limitado ao que restou, em vez de virar
 * crédito.
 */
function totalDoPedido({ subtotalItens, desconto = 0, frete = 0 }) {
  const itens = r2(subtotalItens);
  const desc = Math.min(Math.max(0, r2(desconto)), Math.max(0, itens));
  const fre = Math.max(0, r2(frete));
  return r2(itens - desc + fre);
}

/** Subtotal dos itens do pedido — a base de todo cálculo de desconto. */
function subtotalItens(db, pedidoId) {
  const r = db.prepare('SELECT COALESCE(SUM(valorTotal), 0) AS t FROM pedido_itens WHERE pedidoId = ?')
    .get(pedidoId);
  return r2(r && r.t);
}

/**
 * O corpo da requisição traz desconto? E em que unidade?
 *
 * ── A fonte canônica é o PERCENTUAL ─────────────────────────────────────────
 *
 * Quem informa percentual não precisa saber o subtotal, e a alçada — que é em
 * percentual — fica sem conversão no meio. Por isso `descontoPercentual` é a
 * entrada preferida, e `descontoValor` existe para o caso de o combinado ter
 * sido em reais ("tiro R$ 50 e fechamos").
 *
 * ── Os dois juntos são RECUSADOS, não conciliados ───────────────────────────
 *
 * `{ descontoPercentual: 10, descontoValor: 70 }` sobre R$ 500 é uma
 * contradição: 10% são R$ 50. Qualquer regra de desempate ("o percentual vence")
 * resolveria o caso na marra e gravaria um número que ninguém pediu — e o
 * operador só descobriria na fatura. Recusar devolve a decisão a quem sabe qual
 * dos dois era o combinado.
 *
 * A exceção é quando os dois são **consistentes entre si**: aí não há
 * contradição a resolver, e recusar seria pedantismo. A tolerância é de um
 * centavo, para não brigar com arredondamento de tela.
 *
 * @returns {{ presente, tipo, valor, erro }}
 */
function lerDescontoDoCorpo(body, subtotal) {
  const b = body || {};
  const temCampo = (v) => v !== undefined && v !== null && v !== '';
  const temPct = temCampo(b.descontoPercentual);
  const temVal = temCampo(b.descontoValor);

  if (!temPct && !temVal) return { presente: false };

  if (temPct && temVal) {
    const pct = Number(b.descontoPercentual);
    const val = Number(b.descontoValor);
    const esperado = r2(r2(subtotal) * pct / 100);
    if (Number.isFinite(pct) && Number.isFinite(val) && Math.abs(esperado - val) <= 0.01) {
      return { presente: true, tipo: 'percentual', valor: pct };
    }
    return { presente: true, erro:
      `desconto inconsistente: ${pct}% de ${r2(subtotal).toFixed(2)} são `
      + `${esperado.toFixed(2)}, e veio ${Number.isFinite(val) ? val.toFixed(2) : b.descontoValor}. `
      + 'Envie descontoPercentual OU descontoValor, não os dois.' };
  }

  if (temPct) return { presente: true, tipo: 'percentual', valor: b.descontoPercentual };

  // `descontoTipo` só é honrado junto de `descontoValor`, e serve para dizer
  // "este número é percentual" sem usar o campo dedicado — é o formato que o
  // schema grava, e aceitá-lo evita dois contratos para a mesma coisa.
  const tipo = String(b.descontoTipo || 'valor').toLowerCase();
  return { presente: true, tipo: TIPOS_DESCONTO.includes(tipo) ? tipo : tipo, valor: b.descontoValor };
}

/**
 * Motivo obrigatório acima da alçada — e opcional dentro dela.
 *
 * Auditado antes de implementar: o motor de governança **não tinha** regra
 * equivalente. `aprovacoes.motivo` existe, mas é preenchido por quem DECIDE
 * (a justificativa da reprovação), não por quem solicita — nenhum caminho exige
 * justificativa para abrir a solicitação. Então isto é regra nova, e vive aqui
 * em vez de no motor: é específica de desconto comercial, e impô-la a
 * `pagamento_cp` mudaria um fluxo que ninguém pediu para mudar.
 *
 * Dentro da própria autoridade o motivo é opcional porque quem tem a alçada não
 * presta contas a ninguém sobre ela — prestar contas é o que a alçada já
 * resolveu. Acima dela há um aprovador humano do outro lado, e "aprove 30%"
 * sem dizer por quê é um pedido que ninguém consegue julgar.
 */
const MOTIVO_MINIMO = 3;

function erroMotivo(motivo) {
  const m = String(motivo == null ? '' : motivo).trim();
  if (m.length < MOTIVO_MINIMO) {
    return 'Desconto acima da sua alçada exige descontoMotivo — '
      + 'quem for aprovar precisa saber por quê';
  }
  return null;
}

/**
 * Aplica desconto no pedido: valida, calcula, consulta a alçada e grava.
 *
 * **Este é o único lugar que escreve as colunas de desconto.** O POST e o PUT de
 * pedido chamam esta função; nenhum dos dois inclui `descontoAplicado` na sua
 * whitelist de campos, justamente para que não exista um segundo caminho que
 * grave desconto sem passar pela alçada.
 *
 * Grava quando o desconto é liberado **ou** quando fica pendente de aprovação —
 * no segundo caso o pedido continua em rascunho e a confirmação é bloqueada
 * (`bloqueioDeConfirmacao`). Gravar o pendente é deliberado: sem isso o aprovador
 * não teria o que olhar. O que ele NÃO faz é virar venda.
 *
 * Não grava, e devolve erro, quando o desconto é recusado — fail-closed por falta
 * de alçada, reprovado, expirado ou acima do valor já aprovado.
 *
 * @returns {{ ok, status, erro, aplicado, percentual, alcada, gravou }}
 */
function aplicarDescontoNoPedido(db, { pedidoId, body, req = null }) {
  if (!temColunaDesconto(db)) return { ok: true, aplicado: 0, gravou: false, semColuna: true };

  const subtotal = subtotalItens(db, pedidoId);
  const lido = lerDescontoDoCorpo(body, subtotal);
  if (!lido.presente) return { ok: true, aplicado: null, gravou: false };
  if (lido.erro) return { ok: false, status: 422, erro: lido.erro };

  const calc = calcularDesconto({ subtotal, tipo: lido.tipo, valor: lido.valor });
  if (!calc.ok) return { ok: false, status: 422, erro: calc.erro };

  const motivo = body && body.descontoMotivo != null ? String(body.descontoMotivo).trim() : null;

  // Desconto zero: sempre permitido, sem alçada e sem motivo. É como se corrige
  // um desconto dado por engano, e barrar isso prenderia o pedido.
  if (!(calc.percentual > 0)) {
    db.prepare(`UPDATE pedidos SET descontoTipo = ?, descontoValor = ?, descontoAplicado = 0,
                descontoMotivo = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(calc.tipo, calc.valor, motivo || null, pedidoId);
    return { ok: true, aplicado: 0, percentual: 0, gravou: true, alcada: { liberado: true } };
  }

  // Duas passagens pela alçada, e a ordem importa. A primeira é SIMULADA: ela
  // responde se haveria aprovação sem abrir solicitação nenhuma. Só depois de o
  // motivo ser cobrado é que a solicitação nasce de verdade — do contrário, uma
  // tentativa sem justificativa deixaria a solicitação aberta e o aprovador
  // receberia exatamente o pedido sem motivo que esta regra quer impedir.
  const previa = verificarAlcadaDesconto(db, { pedidoId, percentual: calc.percentual, req, simular: true });

  if (!previa.liberado && previa.status !== 'pendente') {
    return { ok: false, status: 422, alcada: previa,
      erro: previa.motivo || `Desconto de ${calc.percentual.toFixed(2)}% não autorizado` };
  }

  // Acima da própria alçada: há um humano do outro lado, e ele precisa do porquê.
  if (previa.status === 'pendente') {
    const e = erroMotivo(motivo);
    if (e) return { ok: false, status: 422, alcada: previa, erro: e };
  }

  const alcada = previa.liberado
    ? previa
    : verificarAlcadaDesconto(db, { pedidoId, percentual: calc.percentual, req });

  if (!alcada.liberado && alcada.status !== 'pendente') {
    return { ok: false, status: 422, alcada,
      erro: alcada.motivo || `Desconto de ${calc.percentual.toFixed(2)}% não autorizado` };
  }

  db.prepare(`UPDATE pedidos SET descontoTipo = ?, descontoValor = ?, descontoAplicado = ?,
              descontoMotivo = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(calc.tipo, calc.valor, calc.aplicado, motivo || null, pedidoId);

  return { ok: true, gravou: true, aplicado: calc.aplicado, percentual: calc.percentual,
    tipo: calc.tipo, valor: calc.valor, motivo, alcada };
}

/**
 * Mantém o desconto PERCENTUAL fiel ao seu percentual quando o subtotal muda.
 *
 * Sem isto, "10% de R$ 1.000 = R$ 100" continuaria valendo R$ 100 depois de o
 * pedido encolher para R$ 200 — 50% na prática, sem passar por alçada nenhuma.
 * O percentual é o que foi autorizado; é ele que tem de ser preservado, não o
 * número em reais que dele saiu.
 *
 * Desconto em VALOR não é reprecificado: ali o combinado era o número em reais.
 * Ele já não derruba o total abaixo de zero — `totalDoPedido` o limita ao
 * subtotal.
 *
 * Chamado por `recalcularTotal`, isto é, sempre que itens ou frete mudam.
 */
function reprecificarDesconto(db, pedidoId, subtotal) {
  if (!temColunaDesconto(db)) return 0;
  let p;
  try {
    p = db.prepare('SELECT descontoTipo, descontoValor, descontoAplicado FROM pedidos WHERE id = ?')
      .get(pedidoId);
  } catch { return 0; }
  if (!p) return 0;
  const atual = Math.max(0, Number(p.descontoAplicado) || 0);
  if (p.descontoTipo !== 'percentual') return atual;

  const pct = Number(p.descontoValor) || 0;
  if (!(pct > 0)) return atual;
  const novo = r2(r2(subtotal) * pct / 100);
  if (Math.abs(novo - atual) > 0.005) {
    db.prepare('UPDATE pedidos SET descontoAplicado = ? WHERE id = ?').run(novo, pedidoId);
  }
  return novo;
}

/**
 * Há aprovação de desconto pendente ou negada barrando este pedido?
 *
 * Consultado na CONFIRMAÇÃO. O desenho não cria status novo em `pedidos`:
 * o pedido fica em **rascunho** e a confirmação é recusada com 409. Inventar um
 * `aguardando_aprovacao` em `STATUS_VALIDOS` obrigaria a revisar toda tela,
 * filtro, relatório e transição que hoje lê os seis status — um custo grande
 * para expressar algo que "rascunho + motivo do bloqueio" já expressa: o pedido
 * ainda não é venda.
 *
 * @returns {{ bloqueado, status?, motivo?, aprovacaoId? }}
 */
function bloqueioDeConfirmacao(db, pedidoId, req = null) {
  if (!temColunaDesconto(db)) return { bloqueado: false };
  let p;
  try {
    p = db.prepare('SELECT descontoAplicado FROM pedidos WHERE id = ?').get(pedidoId);
  } catch { return { bloqueado: false }; }
  const aplicado = Number(p && p.descontoAplicado) || 0;
  if (!(aplicado > 0)) return { bloqueado: false };

  // O percentual é recalculado do estado ATUAL, e não lido da solicitação: entre
  // pedir a aprovação e confirmar, itens podem ter entrado ou saído. Quem aprovou
  // "20%" aprovou 20% — e é esse número que `verificarAlcada` compara com o teto.
  const base = subtotalItens(db, pedidoId);
  const pct = base > 0 ? r2(aplicado * 100 / base) : 0;

  // MESMO caminho de decisão usado ao aplicar o desconto. É ele que consome a
  // aprovação — uma verificação própria aqui deixaria a aprovação aberta para
  // sempre, reutilizável em quantas confirmações quisessem.
  const a = verificarAlcadaDesconto(db, { pedidoId, percentual: pct, req });
  if (a.liberado) return { bloqueado: false, autoridade: a.autoridade, aprovacaoId: a.aprovacaoId };

  const rotulos = {
    pendente: `Desconto de ${pct.toFixed(2)}% aguarda aprovação de `
      + `"${(a.regra && a.regra.papelAprovador) || 'admin'}"`
      + (a.aprovacaoId ? ` (solicitação #${a.aprovacaoId})` : ''),
    reprovada: `Desconto reprovado${a.motivo ? `: ${a.motivo}` : ''}. Altere o desconto para confirmar.`,
    expirada: a.motivo || 'A aprovação do desconto venceu. Solicite de novo.',
    valor_excedido: a.motivo || 'O desconto atual passa do que foi aprovado.',
    sem_alcada: a.motivo || 'Desconto não autorizado.',
  };
  return { bloqueado: true, status: a.status, aprovacaoId: a.aprovacaoId, percentual: pct,
    motivo: rotulos[a.status] || `Desconto de ${pct.toFixed(2)}% não autorizado` };
}

module.exports = {
  TIPOS_DESCONTO,
  EVENTO_ALCADA,
  MOTIVO_MINIMO,
  temColunaDesconto,
  calcularDesconto,
  verificarAlcadaDesconto,
  limiteDescontoDisponivel,
  descontoDoPedido,
  totalDoPedido,
  subtotalItens,
  lerDescontoDoCorpo,
  erroMotivo,
  aplicarDescontoNoPedido,
  reprecificarDesconto,
  bloqueioDeConfirmacao,
};
