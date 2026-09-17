// certidao-ponte.js
//
// Ponte servidor↔Electron para emissão de certidões que o SERVIDOR NÃO CONSEGUE
// emitir sozinho. Hoje: CND Federal (Receita/PGFN).
//
// ─── POR QUE ESTA PONTE EXISTE ──────────────────────────────────────────────
//
// O robô local (`cndfed-emitir.js`, Puppeteer sob xvfb) nunca emitiu: 023/106 em
// TODAS as combinações de perfil × IP testadas (03/09/2026). O que emite é o
// Chrome instalado na máquina do usuário, com perfil persistente e aquecido —
// 12 de 12 (LiciteAgora Browser 6.2.0, `portals/receita/cdp-emissor.js`).
//
// Então o servidor PEDE e o Electron ENTREGA. Mesmo desenho da ponte de captcha
// da BNC (`bnc-captcha-bridge.js`), com UMA diferença essencial:
//
// ─── A FILA É NO BANCO, NÃO EM MEMÓRIA ──────────────────────────────────────
//
// A ponte da BNC guarda os pedidos num Map do processo. Aqui isso NÃO serve: a
// renovação diária (`habilitacao-renovar.js`) roda em processo SEPARADO do
// worker web, e um pedido enfileirado na memória do cron seria invisível para o
// Electron, que consulta o worker. Fila em SQLite no banco DO TENANT resolve os
// dois casos (botão da tela e cron) e ainda sobrevive a restart.
//
// ─── FLUXO ──────────────────────────────────────────────────────────────────
//
//   1) habilitacao-provedores/cndfed.js chama enfileirar() e depois aguardar()
//   2) Electron: GET  /api/electron/certidao/pending    → reservar()
//   3) Electron roda o Chrome, emite, e devolve o PDF em base64
//      POST /api/electron/certidao/resultado            → concluir()
//   4) concluir() faz o parse do PDF, grava o arquivo e as datas no documento
//   5) aguardar() enxerga a linha terminal e devolve ao provider
//
// O parse do PDF fica AQUI, não no Electron: a lógica já existe e foi medida em
// `cndfed-emitir.js`; duplicá-la no cliente significaria versioná-la em dois
// lugares e depender de update do desktop para corrigir uma regex.

'use strict';

const fs = require('fs');
const path = require('path');

// Quanto tempo um pedido reservado pode ficar sem resposta antes de voltar para
// a fila. Uma emissão leva ~50s; 5 min cobre a 2ª passada do lote com folga.
const RESERVA_MS = 5 * 60 * 1000;
// Teto de espera do provider. Acima disso o usuário recebe erro em vez de a tela
// girar para sempre — o caso comum é o PC do cliente estar desligado.
const ESPERA_PADRAO_MS = 10 * 60 * 1000;
const TIPO_CND_FED = 'CND Federal (Receita/PGFN)';

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS certidao_fila (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      docId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      cnpj TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendente',
      origem TEXT NOT NULL DEFAULT 'manual',
      erro TEXT,
      resultado TEXT,
      criadoEm TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reservadoEm TEXT,
      concluidoEm TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_certidao_fila_estado ON certidao_fila(estado, id);
  `);
}

const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// ─── lado do servidor: pedir ────────────────────────────────────────────────

function enfileirar(db, { docId, cnpj, tipo = TIPO_CND_FED, origem = 'manual' }) {
  migrar(db);
  const doc = soDigitos(cnpj);
  if (doc.length !== 14) throw new Error(`CNPJ inválido para a fila: "${cnpj}"`);
  // Um pedido vivo por documento. Sem isto, clicar "Buscar" três vezes na tela
  // enfileira três emissões da MESMA certidão — e a Receita responde 106 a
  // rajada, que é justamente o erro que a ponte existe para evitar.
  const vivo = db.prepare(
    `SELECT * FROM certidao_fila WHERE docId = ? AND estado IN ('pendente','reservado') ORDER BY id DESC LIMIT 1`
  ).get(docId);
  if (vivo) return { id: vivo.id, reaproveitado: true };
  const r = db.prepare(
    `INSERT INTO certidao_fila (docId, tipo, cnpj, origem) VALUES (?, ?, ?, ?)`
  ).run(docId, tipo, doc, origem);
  return { id: r.lastInsertRowid, reaproveitado: false };
}

function aguardar(db, id, { timeoutMs = ESPERA_PADRAO_MS, intervaloMs = 2000 } = {}) {
  const limite = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let l;
      try { l = db.prepare('SELECT * FROM certidao_fila WHERE id = ?').get(id); }
      catch (e) { return reject(e); }
      if (!l) return reject(new Error('pedido sumiu da fila'));
      if (l.estado === 'concluido') {
        let r = {}; try { r = JSON.parse(l.resultado || '{}'); } catch (_) {}
        return resolve(r);
      }
      if (l.estado === 'erro') return reject(new Error(l.erro || 'falha na emissão'));
      if (Date.now() > limite) {
        db.prepare(`UPDATE certidao_fila SET estado='erro', erro=?, concluidoEm=? WHERE id=?`)
          .run('ninguém atendeu o pedido', agora(), id);
        // Diagnóstico honesto: quase sempre é o desktop desligado, não um bug.
        const espera = timeoutMs >= 60000 ? `${Math.round(timeoutMs / 60000)} min` : `${Math.round(timeoutMs / 1000)}s`;
        return reject(new Error(
          'Nenhum LiciteAgora Browser atendeu o pedido em ' + espera +
          '. A CND Federal só pode ser emitida pelo navegador instalado na máquina ' +
          '(o servidor é recusado pela Receita). Deixe o Browser aberto e tente de novo.'
        ));
      }
      setTimeout(tick, intervaloMs);
    };
    tick();
  });
}

// ─── lado do Electron: pegar e devolver ─────────────────────────────────────

function reservar(db) {
  migrar(db);
  // Devolve à fila o que foi reservado e nunca respondeu (Browser fechado no
  // meio, máquina suspensa). Sem isto um pedido órfão trava o documento.
  db.prepare(
    `UPDATE certidao_fila SET estado='pendente', reservadoEm=NULL
      WHERE estado='reservado' AND reservadoEm IS NOT NULL
        AND (julianday('now') - julianday(reservadoEm)) * 86400000 > ?`
  ).run(RESERVA_MS);

  const l = db.prepare(`SELECT * FROM certidao_fila WHERE estado='pendente' ORDER BY id LIMIT 1`).get();
  if (!l) return null;
  db.prepare(`UPDATE certidao_fila SET estado='reservado', reservadoEm=? WHERE id=?`).run(agora(), l.id);
  return { id: l.id, docId: l.docId, tipo: l.tipo, cnpj: l.cnpj };
}

const brParaIso = (b) => { const [d, m, y] = b.split('/'); return `${y}-${m}-${d}`; };
const isoHoje = () => new Date().toISOString().slice(0, 10);
const isoMais = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

// Mesmas regras do `cndfed-emitir.js` — não reinventar: elas já foram medidas
// contra PDFs reais da Receita.
async function lerPdf(buf) {
  const out = { dataEmissao: null, dataValidade: null, numero: null, negativa: null };
  try {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const data = await parser.getText();
    await parser.destroy().catch(() => {});
    const txt = (data.text || '').replace(/\s+/g, ' ');
    out.negativa = /CERTID[ÃA]O NEGATIVA|n[ãa]o consta.*pend[êe]ncia|regular/i.test(txt) && !/POSITIVA/i.test(txt)
      ? true : (/POSITIVA/i.test(txt) ? false : null);
    const emi = txt.match(/Emitida.*?(\d{2}\/\d{2}\/\d{4})|Data da emiss[ãa]o[:\s]*(\d{2}\/\d{2}\/\d{4})/i);
    const val = txt.match(/V[áa]lida at[ée][:\s]*(\d{2}\/\d{2}\/\d{4})|Validade[:\s]*.*?(\d{2}\/\d{2}\/\d{4})/i);
    if (emi) out.dataEmissao = brParaIso(emi[1] || emi[2]);
    if (val) out.dataValidade = brParaIso(val[1] || val[2]);

    // O número vem do "Código de controle da certidão: 041C.88E5.FBC7.9570".
    // NÃO usar alternância numa regex só: `Certid[ãa]o n[º°.:\s]*(...)` casa mais
    // à ESQUERDA, no título "CERTIDÃO NEGATIVA", e captura "EGATIVA" — foi o que
    // a primeira emissão real gravou no documento. Padrões separados, na ordem
    // de confiança, e o resultado tem de conter dígito.
    for (const re of [
      /C[óo]digo de controle[^:]*:\s*([\dA-Za-z.]{8,})/i,
      /Certid[ãa]o\s+n[º°.:]\s*([\dA-Za-z./-]+)/i,
    ]) {
      const m = txt.match(re);
      const v = m ? (m[1] || '').replace(/[.\s]+$/, '') : '';
      if (v && /\d/.test(v)) { out.numero = v; break; }
    }
  } catch (_) { /* PDF ilegível não invalida a emissão; datas caem no default */ }
  return out;
}

/**
 * Conclui um pedido com o que o Electron devolveu.
 * @param {object} db      banco DO TENANT
 * @param {string} raizPub caminho de `private/public` (para montar o path relativo)
 * @param {number} id      id na certidao_fila
 * @param {object} payload { estado, pdfBase64?, erro? }
 */
async function concluir(db, raizPub, id, payload) {
  migrar(db);
  const l = db.prepare('SELECT * FROM certidao_fila WHERE id = ?').get(id);
  if (!l) return { ok: false, error: 'pedido desconhecido' };
  if (l.estado === 'concluido' || l.estado === 'erro') return { ok: false, error: 'pedido já encerrado' };

  const { estado, pdfBase64, erro } = payload || {};

  if (estado !== 'emitida' || !pdfBase64) {
    const msg = erro || MENSAGEM[estado] || `emissão não concluída (${estado || 'sem estado'})`;
    db.prepare(`UPDATE certidao_fila SET estado='erro', erro=?, concluidoEm=? WHERE id=?`)
      .run(String(msg).slice(0, 400), agora(), id);
    return { ok: true, gravado: false };
  }

  const pdf = Buffer.from(pdfBase64, 'base64');
  if (pdf.length < 1000 || pdf.slice(0, 4).toString() !== '%PDF') {
    db.prepare(`UPDATE certidao_fila SET estado='erro', erro=?, concluidoEm=? WHERE id=?`)
      .run('o cliente devolveu um arquivo que não é PDF', agora(), id);
    return { ok: false, error: 'arquivo não é PDF' };
  }

  const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(l.docId);
  if (!doc) return { ok: false, error: `documento ${l.docId} não existe` };

  const meta = await lerPdf(pdf);
  const dataEmissao = meta.dataEmissao || isoHoje();
  const dataValidade = meta.dataValidade || isoMais(180);

  const destDir = path.join(raizPub, 'uploads', 'habilitacao', String(l.docId));
  fs.mkdirSync(destDir, { recursive: true });
  // CNPJ no nome: `public/uploads/habilitacao/<docId>/` é COMPARTILHADO entre
  // tenants (o id é por banco de tenant), então dois tenants com o mesmo docId
  // gravariam por cima um do outro. Com o CNPJ no nome isso não acontece.
  const nome = `cnd-federal-${l.cnpj}-${dataValidade}.pdf`;
  fs.writeFileSync(path.join(destDir, nome), pdf);
  const rel = path.relative(raizPub, path.join(destDir, nome)).replace(/\\/g, '/');

  if (doc.arquivo && doc.arquivo !== rel) {
    try { const antigo = path.join(raizPub, doc.arquivo); if (fs.existsSync(antigo)) fs.unlinkSync(antigo); } catch (_) {}
  }

  db.prepare(`UPDATE habilitacao_documentos SET
      orgaoEmissor=COALESCE(NULLIF(orgaoEmissor,''),'Receita Federal / PGFN'), esfera='federal',
      numero=?, dataEmissao=?, dataValidade=?,
      arquivo=?, arquivoNome=?, arquivoMime='application/pdf', arquivoTamanho=?,
      origem='automatico', ultimaBuscaAuto=CURRENT_TIMESTAMP,
      ultimoErroAuto=NULL, ultimoErroAutoEm=NULL, dataAtualizacao=CURRENT_TIMESTAMP
    WHERE id=?`)
    .run(meta.numero || doc.numero, dataEmissao, dataValidade, rel, nome, pdf.length, l.docId);

  const resultado = { dataEmissao, dataValidade, numero: meta.numero, negativa: meta.negativa, arquivo: rel, tamanho: pdf.length };
  db.prepare(`UPDATE certidao_fila SET estado='concluido', resultado=?, concluidoEm=? WHERE id=?`)
    .run(JSON.stringify(resultado), agora(), id);
  return { ok: true, gravado: true, resultado };
}

// Desfechos do emissor que NÃO são falha técnica — a mensagem tem de dizer o que
// fazer, senão a tela mostra "erro" para algo que nenhum retry resolve.
const MENSAGEM = {
  sem_info: 'A PGFN não tem informações suficientes para emitir a certidão conjunta deste CNPJ. ' +
            'É preciso resolver isso junto ao órgão — reprocessar não adianta.',
  filial: 'Este CNPJ é filial: a CND Federal é emitida para o CNPJ da matriz.',
  analisando: 'A Receita ainda está processando o pedido. Tente novamente em alguns minutos.',
  recusado: 'A Receita recusou a emissão neste momento. Tente novamente em alguns minutos.',
  timeout: 'A página da Receita não respondeu a tempo.',
};

function estatisticas(db) {
  migrar(db);
  return db.prepare(`SELECT estado, COUNT(*) n FROM certidao_fila GROUP BY estado`).all();
}

module.exports = { migrar, enfileirar, aguardar, reservar, concluir, estatisticas, TIPO_CND_FED, ESPERA_PADRAO_MS };
