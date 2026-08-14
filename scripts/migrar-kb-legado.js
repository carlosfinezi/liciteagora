#!/usr/bin/env node
// migrar-kb-legado.js — leva o conhecimento do campo antigo
// (config.whatsapp_ai_kb, um bloco de texto só) para itens de ia_base.
//
// Por que: o campo legado era editado pela tela antiga do WhatsApp, que saiu
// do ar na unificação de 2026-08-14, e continuava sendo concatenado no prompt
// sem que ninguém conseguisse vê-lo ou corrigi-lo. Item em ia_base tem título,
// origem, data e liga/desliga — e é o que o botão "corrigir" alimenta.
//
// O texto do 1bit é um scrape de páginas, com "# <url>" separando cada uma:
// isso vira um item por página, com a URL na origem. Formato diferente disso
// vira um item único, sem tentar adivinhar divisão.
//
// Uso:
//   node scripts/migrar-kb-legado.js            (simula)
//   node scripts/migrar-kb-legado.js --aplicar  (executa)
//
// O campo antigo NÃO é apagado: fica como está, mas deixa de ser lido pelo
// prompt (ver buildSystemAtendimento). Assim dá para conferir a migração
// depois, e desfazer é copiar de volta.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarConversasDB } = require('../conversas-routes');

const APLICAR = process.argv.includes('--aplicar');
const MAX_CONTEUDO = 4000;   // mesmo teto do POST /api/ia/base

// Divide o scrape em uma parte por URL. Sem cabeçalho, devolve um bloco só.
function dividir(texto) {
  const t = String(texto || '').trim();
  if (!t) return [];
  const partes = [];
  const re = /^#{1,4}\s*(.+)$/gm;
  const marcas = [...t.matchAll(re)];
  if (!marcas.length) {
    return [{ titulo: 'Base anterior do WhatsApp', origem: 'campo antigo whatsapp_ai_kb', conteudo: t }];
  }
  for (let i = 0; i < marcas.length; i++) {
    const cab = marcas[i][1].trim();
    const ini = marcas[i].index + marcas[i][0].length;
    const fim = i + 1 < marcas.length ? marcas[i + 1].index : t.length;
    const corpo = t.slice(ini, fim).trim();
    if (!corpo) continue;
    // A URL é um título ruim para ler na tela, mas é uma origem excelente.
    const dominio = cab.replace(/^https?:\/\//, '').replace(/\/$/, '');
    partes.push({
      titulo: ('Site — ' + dominio).slice(0, 120),
      origem: cab.slice(0, 120),
      conteudo: corpo,
    });
  }
  return partes;
}

// Conteúdo maior que o teto vira mais de um item, cortado em parágrafo.
function fatiar(item) {
  if (item.conteudo.length <= MAX_CONTEUDO) return [item];
  const pedacos = [];
  let resto = item.conteudo;
  let n = 1;
  while (resto.length) {
    let corte = resto.length <= MAX_CONTEUDO ? resto.length : resto.lastIndexOf('\n', MAX_CONTEUDO);
    if (corte < MAX_CONTEUDO * 0.5) corte = Math.min(MAX_CONTEUDO, resto.length);
    pedacos.push({ ...item, titulo: `${item.titulo} (${n})`.slice(0, 120), conteudo: resto.slice(0, corte).trim() });
    resto = resto.slice(corte).trim();
    n++;
  }
  return pedacos;
}

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrar-kb] ${tenants.length} tenant(s) · modo: ${APLICAR ? 'APLICAR' : 'simulação'}`);

let total = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_ai_kb'").get();
    if (!row?.valor?.trim()) { continue; }

    migrarConversasDB(db);
    const jaMigrado = db.prepare("SELECT COUNT(*) n FROM ia_base WHERE origem LIKE 'http%' OR origem = 'campo antigo whatsapp_ai_kb'").get().n;
    if (jaMigrado) {
      console.log(`  ${t.slug}: já migrado (${jaMigrado} item(ns) com origem do campo antigo)`);
      continue;
    }

    const itens = dividir(row.valor).flatMap(fatiar);
    console.log(`  ${t.slug}: ${row.valor.length} chars → ${itens.length} item(ns)`);
    for (const i of itens) {
      console.log(`      ${i.titulo}  (${i.conteudo.length} chars, origem ${i.origem})`);
      if (APLICAR) {
        db.prepare('INSERT INTO ia_base (titulo, conteudo, origem) VALUES (?,?,?)')
          .run(i.titulo, i.conteudo, i.origem);
      }
    }
    total += itens.length;
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
  } finally {
    db.close();
  }
}
console.log(`[migrar-kb] ${total} item(ns) ${APLICAR ? 'criados' : 'a criar'}`);
if (!APLICAR) console.log('[migrar-kb] simulação — rode com --aplicar para executar');
