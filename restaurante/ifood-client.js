/**
 * ifood-client.js — Cliente HTTP da API do iFood.
 *
 * Isolado do restante de propósito: aqui NÃO há acesso a banco nem regra de
 * negócio, só as chamadas HTTP. Isso é o que torna o fluxo testável sem
 * credenciais reais — o `baseUrl` é injetável e um servidor de mentira responde
 * no lugar do iFood.
 *
 * Fluxo oficial (developer.ifood.com.br):
 *   1. POST /authentication/v1.0/oauth/token   → access_token (client_credentials)
 *   2. GET  /order/v1.0/events:polling         → eventos novos
 *   3. POST /order/v1.0/events/acknowledgment  → confirma o recebimento
 *   4. GET  /order/v1.0/orders/{id}            → detalhe do pedido
 *
 * O polling é a parte sensível: a recomendação é chamar a cada 30 s. Espaçar
 * mais faz o iFood entender que o merchant não está respondendo e pode
 * FECHAR a loja na plataforma.
 *
 * Ponto que morde: eventos não confirmados são REENTREGUES. Sem ACK, o mesmo
 * pedido volta no ciclo seguinte — e sem idempotência do lado de cá, vira duas
 * comandas. A idempotência mora no ifood-routes (UNIQUE em canal+eventoId);
 * aqui só garantimos que o ACK é enviado.
 */

const BASE_PADRAO = 'https://merchant-api.ifood.com.br';

// Margem antes de considerar o token vencido: renovar com 5 min de folga evita
// perder um ciclo de polling por 401 no meio da corrida do almoço.
const FOLGA_TOKEN_MS = 5 * 60 * 1000;

async function chamar(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const texto = await r.text();
    let corpo = null;
    try { corpo = texto ? JSON.parse(texto) : null; } catch (_) { corpo = texto; }
    return { status: r.status, ok: r.ok, corpo };
  } finally {
    clearTimeout(t);
  }
}

/**
 * client_credentials do iFood. Devolve { accessToken, expiraEm }.
 */
async function autenticar({ clientId, clientSecret, baseUrl = BASE_PADRAO }) {
  const corpo = new URLSearchParams({
    grantType: 'client_credentials',
    clientId,
    clientSecret,
  });
  const r = await chamar(`${baseUrl}/authentication/v1.0/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corpo.toString(),
  });
  if (!r.ok) {
    throw new Error(`autenticação recusada (${r.status}): ${typeof r.corpo === 'string' ? r.corpo : JSON.stringify(r.corpo)}`);
  }
  const token = r.corpo && (r.corpo.accessToken || r.corpo.access_token);
  if (!token) throw new Error('resposta de autenticação sem accessToken');
  const expiraSeg = Number((r.corpo && (r.corpo.expiresIn || r.corpo.expires_in)) || 3600);
  return { accessToken: token, expiraEm: Date.now() + expiraSeg * 1000 };
}

/**
 * Eventos novos. `merchantIds` filtra por loja via header x-polling-merchants.
 * 204 = nada novo, que é o caso normal na maior parte dos ciclos.
 */
async function polling({ accessToken, merchantIds, baseUrl = BASE_PADRAO }) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (merchantIds && merchantIds.length) {
    headers['x-polling-merchants'] = merchantIds.join(',');
  }
  const r = await chamar(`${baseUrl}/order/v1.0/events:polling`, { headers });
  if (r.status === 204) return [];
  if (!r.ok) throw new Error(`polling falhou (${r.status})`);
  return Array.isArray(r.corpo) ? r.corpo : [];
}

/**
 * Confirma o recebimento dos eventos. SEM isto o iFood reentrega tudo.
 */
async function acknowledge({ accessToken, eventos, baseUrl = BASE_PADRAO }) {
  if (!eventos || !eventos.length) return { ok: true, status: 204 };
  const r = await chamar(`${baseUrl}/order/v1.0/events/acknowledgment`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventos.map(e => ({ id: e.id }))),
  });
  if (!r.ok) throw new Error(`acknowledgment falhou (${r.status})`);
  return { ok: true, status: r.status };
}

async function detalhesPedido({ accessToken, orderId, baseUrl = BASE_PADRAO }) {
  const r = await chamar(`${baseUrl}/order/v1.0/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`detalhe do pedido ${orderId} falhou (${r.status})`);
  return r.corpo;
}

// Confirma/despacha/cancela um pedido no iFood.
async function acaoPedido({ accessToken, orderId, acao, motivo, baseUrl = BASE_PADRAO }) {
  const rotas = {
    confirmar: 'confirm',
    despachar: 'dispatch',
    pronto: 'readyToPickup',
    cancelar: 'requestCancellation',
  };
  const rota = rotas[acao];
  if (!rota) throw new Error(`ação desconhecida: ${acao}`);
  const r = await chamar(`${baseUrl}/order/v1.0/orders/${encodeURIComponent(orderId)}/${rota}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: acao === 'cancelar' ? JSON.stringify({ reason: motivo || 'Não foi possível atender' }) : undefined,
  });
  if (!r.ok) throw new Error(`${acao} falhou (${r.status})`);
  return { ok: true, status: r.status };
}

/**
 * Normaliza o pedido do iFood para o formato que a comanda entende.
 *
 * O payload deles é aninhado e mudou de forma entre versões; concentrar a
 * leitura aqui evita espalhar `pedido?.customer?.name` por todo o módulo.
 * Todo campo tem fallback porque pedido sem telefone ou sem complemento é
 * comum e não pode derrubar a importação.
 */
function normalizarPedido(p) {
  if (!p) return null;
  const entrega = p.delivery || {};
  const endereco = entrega.deliveryAddress || {};
  const total = p.total || {};

  return {
    idExterno: String(p.id || p.orderId || ''),
    numeroDisplay: p.displayId || null,
    tipo: p.orderType || 'DELIVERY',           // DELIVERY | TAKEOUT | INDOOR
    cliente: {
      nome: (p.customer && p.customer.name) || 'Cliente iFood',
      telefone: (p.customer && p.customer.phone && (p.customer.phone.number || p.customer.phone)) || null,
    },
    endereco: {
      logradouro: endereco.streetName || null,
      numero: endereco.streetNumber || null,
      complemento: endereco.complement || null,
      referencia: endereco.reference || null,
      bairro: endereco.neighborhood || null,
    },
    itens: (p.items || []).map(i => {
      // Complementos (adicionais) vêm em grupos aninhados.
      const opcoes = (i.options || []).map(o => ({
        nome: o.name,
        quantidade: Number(o.quantity || 1),
        preco: Number(o.price || 0),
      }));
      // O `totalPrice` do item NÃO inclui os complementos — eles entram
      // separados no subTotal do pedido. Somar aqui é o que faz a comanda
      // fechar pelo mesmo valor que o cliente viu no app; sem isso, um pedido
      // de R$ 101 entra como R$ 93 e a diferença sai do caixa.
      const base = Number(i.totalPrice || (Number(i.unitPrice || 0) * Number(i.quantity || 1)));
      const adicionais = opcoes.reduce((s, o) => s + o.preco * o.quantidade, 0);
      return {
        nome: i.name,
        quantidade: Number(i.quantity || 1),
        precoUnitario: Number(i.unitPrice || 0),
        precoTotal: Math.round((base + adicionais) * 100) / 100,
        observacao: i.observations || null,
        codigoExterno: i.externalCode || null,
        opcoes,
      };
    }),
    // A taxa de entrega do iFood é dele, não nossa: entra como linha própria.
    taxaEntrega: Number(total.deliveryFee || (entrega.deliveryFee) || 0),
    subTotal: Number(total.subTotal || 0),
    total: Number(total.orderAmount || total.total || 0),
    pagamento: {
      // 'ONLINE' = já pago no app; 'OFFLINE' = paga na entrega.
      tipo: (p.payments && p.payments.methods && p.payments.methods[0] && p.payments.methods[0].method) || null,
      online: !!(p.payments && p.payments.methods
        && p.payments.methods.some(m => String(m.type || '').toUpperCase() === 'ONLINE')),
      troco: Number((p.payments && p.payments.methods && p.payments.methods[0]
        && p.payments.methods[0].cash && p.payments.methods[0].cash.changeFor) || 0),
    },
    observacao: p.observations || null,
  };
}

module.exports = {
  autenticar,
  polling,
  acknowledge,
  detalhesPedido,
  acaoPedido,
  normalizarPedido,
  BASE_PADRAO,
  FOLGA_TOKEN_MS,
};
