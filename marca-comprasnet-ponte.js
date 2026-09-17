// marca-comprasnet-ponte.js
//
// Ponte servidor↔Electron para coleta de marca/modelo no COMPRASNET.
//
// ─── POR QUE EXISTE ─────────────────────────────────────────────────────────
//
// O Comprasnet é o maior buraco do BI: 190.345 linhas de vencedor e 805 com
// marca (0,4%, medido 08/09/2026). O coletor existe e funciona — validado em
// 21/08 com 1.128 linhas e 100% de alinhamento item-a-item — mas roda DENTRO do
// LiciteAgora Browser, porque a API `/itens/{n}/propostas` exige um token `P1_`
// cunhado por um widget hCaptcha invisível. O servidor não cunha esse token.
//
// Então o servidor enfileira e o Browser coleta. Mesma tubulação da
// `certidao-ponte.js`, com duas diferenças que importam:
//
//  1. A fila vive no CATÁLOGO (PostgreSQL), não no banco do tenant: marca é dado
//     compartilhado, não é de um cliente. Uma fila por servidor, não por tenant.
//  2. O casamento item↔linha é EXATO (numeroItem + niFornecedor), não por
//     descrição. Isso não é detalhe: o casamento por descrição do PCP produziu
//     15% de marca no item errado em agosto e exigiu reverter 2.544 linhas.
//     Aqui a chave é a mesma dos dois lados; não há heurística nenhuma.
//
// ─── O QUE ENTRA NA FILA ────────────────────────────────────────────────────
//
// Só licitações do `Compras.gov.br` que tenham o idCompra NO PRÓPRIO LINK
// (`compra=<17 dígitos>`), vencedor real e ao menos uma linha sem marca.
// São 10.415 hoje. As outras 38,6% exigiriam RECONSTRUIR o idCompra a partir de
// UASG+modalidade+número, e o mapa de modalidade diverge entre as fontes que
// tenho (`compra-id-resolver.js:132` diz 9→'09'; minha anotação dizia 9→'07').
// Coletar com idCompra errado é gravar marca de OUTRA licitação — o mesmo tipo
// de estrago de agosto. Enquanto a divergência não for medida, ficam de fora.

'use strict';

const catalogPg = require('./catalog-pg');
const { _marcaValida } = require('./licitanet-marca');

const RESERVA_MS = 10 * 60 * 1000;   // um lote do Browser leva ~2min; 10 é folga
const LOTE_PADRAO = 5;

async function migrar() {
  await catalogPg.execute(`
    CREATE TABLE IF NOT EXISTS marca_comprasnet_fila (
      id           bigserial PRIMARY KEY,
      cnpj         text    NOT NULL,
      ano          integer NOT NULL,
      sequencial   integer NOT NULL,
      "idCompra"   text    NOT NULL,
      status       text    NOT NULL DEFAULT 'pendente',
      "itensGravados" integer DEFAULT 0,
      tentativas   integer DEFAULT 0,
      erro         text,
      "criadoEm"     timestamptz DEFAULT now(),
      "reservadoEm"  timestamptz,
      "concluidoEm"  timestamptz,
      UNIQUE (cnpj, ano, sequencial)
    )`);
  await catalogPg.execute(
    `CREATE INDEX IF NOT EXISTS idx_marca_cnet_fila_status ON marca_comprasnet_fila (status, id)`);
}

/**
 * Semeia a fila. Prioriza o que o tenant realmente vê no BI (grupos de
 * palavras) e completa com o resto, do mais recente para o mais antigo.
 * Idempotente: ON CONFLICT DO NOTHING pela chave da licitação.
 */
async function semear({ limite = 500, soPrioridade = false } = {}) {
  await migrar();
  const filtroGrupo = soPrioridade
    ? `AND EXISTS (SELECT 1 FROM bi_grupo_item g JOIN itens i ON i.id=g."itemId"
                    WHERE i."licitacaoId"=l.id)`
    : '';
  await catalogPg.execute(`
    INSERT INTO marca_comprasnet_fila (cnpj, ano, sequencial, "idCompra")
    SELECT l.cnpj, l."anoCompra", l."sequencialCompra",
           substring(l."linkSistemaOrigem" from 'compra=([0-9]{17})')
      FROM licitacoes l
     WHERE l."usuarioNome"='Compras.gov.br'
       AND l."linkSistemaOrigem" ~ 'compra=[0-9]{17}'
       ${filtroGrupo}
       AND EXISTS (SELECT 1 FROM resultados_bi rb
                    WHERE rb.cnpj=l.cnpj AND rb.ano=l."anoCompra" AND rb.sequencial=l."sequencialCompra"
                      AND rb."niFornecedor"<>'__sem_resultado__'
                      AND length(coalesce(rb."marcaFabricante",''))=0)
     ORDER BY l."dataPublicacaoPncp" DESC NULLS LAST
     LIMIT $1
    ON CONFLICT (cnpj, ano, sequencial) DO NOTHING`, [limite]);
  const r = await catalogPg.queryOne(
    `SELECT count(*)::int c FROM marca_comprasnet_fila WHERE status='pendente'`);
  return r ? r.c : 0;
}

/** Entrega o próximo lote ao Browser, marcando como reservado. */
async function reservar(n = LOTE_PADRAO) {
  await migrar();
  // Devolve à fila o que foi reservado e nunca respondeu (Browser fechado no
  // meio, máquina suspensa) — senão um lote órfão trava as licitações dele.
  await catalogPg.execute(
    `UPDATE marca_comprasnet_fila SET status='pendente', "reservadoEm"=NULL
      WHERE status='reservado' AND "reservadoEm" < now() - ($1 || ' milliseconds')::interval`,
    [String(RESERVA_MS)]);

  const linhas = await catalogPg.query(
    `UPDATE marca_comprasnet_fila SET status='reservado', "reservadoEm"=now(),
            tentativas = tentativas + 1
      WHERE id IN (SELECT id FROM marca_comprasnet_fila WHERE status='pendente'
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, cnpj, ano, sequencial, "idCompra"`, [n]);
  return linhas || [];
}

/**
 * Grava o que o Browser coletou.
 *
 * @param {number} id      linha da fila
 * @param {object} payload { ok, erro, itens: [{ numeroItem, propostas:[{niFornecedor, marcaFabricante, modeloVersao}] }] }
 */
async function concluir(id, payload) {
  await migrar();
  const linha = await catalogPg.queryOne(`SELECT * FROM marca_comprasnet_fila WHERE id=$1`, [id]);
  if (!linha) return { ok: false, error: 'pedido desconhecido' };
  if (linha.status === 'concluido') return { ok: false, error: 'pedido já encerrado' };

  const { ok, erro, itens } = payload || {};
  if (!ok || !Array.isArray(itens)) {
    await catalogPg.execute(
      `UPDATE marca_comprasnet_fila SET status=$2, erro=$3, "concluidoEm"=now() WHERE id=$1`,
      [id, 'erro', String(erro || 'coletor não devolveu itens').slice(0, 400)]);
    return { ok: true, gravados: 0 };
  }

  // Estado atual das linhas desta licitação, por (numeroItem, niFornecedor).
  // Ler ANTES e decidir aqui evita depender do UPDATE para saber o que mudou.
  const atuais = new Map();
  for (const r of await catalogPg.query(
    `SELECT "numeroItem", "niFornecedor", "marcaFabricante", "modeloVersao"
       FROM resultados_bi WHERE cnpj=$1 AND ano=$2 AND sequencial=$3
        AND "niFornecedor"<>'__sem_resultado__'`,
    [linha.cnpj, linha.ano, linha.sequencial])) {
    atuais.set(`${r.numeroItem}|${String(r.niFornecedor || '').replace(/\D/g, '')}`,
      { marca: r.marcaFabricante || '', modelo: r.modeloVersao || '' });
  }

  // Os contadores separam três "não gravei" que NÃO são falha, e por isso
  // precisam aparecer distintos no log:
  //   semLinha  — proposta de quem perdeu (resultados_bi só guarda o vencedor)
  //   jaTinha   — outro coletor chegou antes
  //   semMarca  — o vencedor não declara marca. É SERVIÇO, não defeito: a
  //               compra 92971606001002026 ("Manutenção de Extintores") devolve
  //               7 itens, 35 propostas e nenhuma marca — e está certo.
  // Sem essa distinção, "gravou 0" vira falso alarme de coletor quebrado.
  let gravados = 0, semLinha = 0, jaTinha = 0, semMarca = 0;
  for (const it of itens) {
    for (const p of (it.propostas || [])) {
      const forn = String(p.niFornecedor || '').replace(/\D/g, '');
      if (!forn) continue;
      const chave = `${it.numeroItem}|${forn}`;
      const atual = atuais.get(chave);
      if (!atual) { semLinha++; continue; }

      const marcaOk = _marcaValida(p.marcaFabricante);
      const gravaMarca = !atual.marca.trim() && marcaOk;
      const gravaModelo = !atual.modelo.trim() && String(p.modeloVersao || '').trim() !== '';
      if (!gravaMarca && !gravaModelo) {
        if (atual.marca.trim()) jaTinha++; else if (!marcaOk) semMarca++;
        continue;
      }

      // NUNCA sobrescreve: o CASE repete a guarda dentro do UPDATE, para o caso
      // de outro coletor ter preenchido entre a leitura acima e este write.
      await catalogPg.execute(
        `UPDATE resultados_bi SET
           "marcaFabricante" = CASE WHEN (("marcaFabricante" IS NULL OR "marcaFabricante"='') AND $5<>'')
                                    THEN $5 ELSE "marcaFabricante" END,
           "modeloVersao"    = CASE WHEN (("modeloVersao" IS NULL OR "modeloVersao"='') AND $6<>'')
                                    THEN $6 ELSE "modeloVersao" END,
           "dataCache"=now()
         WHERE cnpj=$1 AND ano=$2 AND sequencial=$3 AND "numeroItem"=$4
           AND regexp_replace(coalesce("niFornecedor",''),'\\D','','g')=$7`,
        [linha.cnpj, linha.ano, linha.sequencial, it.numeroItem,
         gravaMarca ? String(p.marcaFabricante).trim() : '',
         gravaModelo ? String(p.modeloVersao).trim() : '', forn]);
      gravados++;
    }
  }

  await catalogPg.execute(
    `UPDATE marca_comprasnet_fila SET status='concluido', "itensGravados"=$2,
            erro=NULL, "concluidoEm"=now() WHERE id=$1`, [id, gravados]);
  return { ok: true, gravados, semLinha, jaTinha, semMarca };
}

async function estatisticas() {
  await migrar();
  return await catalogPg.query(
    `SELECT status, count(*)::int licitacoes, sum("itensGravados")::int marcas,
            max("concluidoEm") ultima
       FROM marca_comprasnet_fila GROUP BY status ORDER BY 2 DESC`);
}

module.exports = { migrar, semear, reservar, concluir, estatisticas, LOTE_PADRAO };

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const num = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
    if (args.includes('--seed')) {
      console.log('fila pendente:', await semear({ limite: num('--seed', 500) }));
    } else if (args.includes('--stats')) {
      console.table(await estatisticas());
    } else {
      console.log('uso: node marca-comprasnet-ponte.js --seed [n] | --stats');
    }
    process.exit(0);
  })().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
