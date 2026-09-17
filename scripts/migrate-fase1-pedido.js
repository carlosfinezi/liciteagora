/**
 * Migration da Fase 1 — desconto explícito e tipo de atendimento no pedido.
 *
 * ⚠️ NÃO EXECUTADA EM PRODUÇÃO. Proposta para aprovação — ver
 * docs/auditoria-app-mobile-2026-08-26/12-fase-1-fundacao-pdv-catalogo.md.
 *
 * Por padrão roda em DRY-RUN: mostra o que faria e não escreve nada. Só grava
 * com `--aplicar`, e só nos tenants que você nomear. Não há modo "todos" de
 * propósito: aplicar em 13 bancos de uma vez é o tipo de comando que não se
 * desfaz.
 *
 *   node scripts/migrate-fase1-pedido.js                     dry-run, todos
 *   node scripts/migrate-fase1-pedido.js 1bit                dry-run, um
 *   node scripts/migrate-fase1-pedido.js 1bit --aplicar      aplica em um
 *   node scripts/migrate-fase1-pedido.js --arquivo /tmp/x.db --aplicar
 *
 * Desenho: só ALTER TABLE ADD COLUMN e INSERT idempotente. Nenhuma coluna é
 * removida, nenhum dado existente é reescrito, nenhum DEFAULT muda o passado —
 * as colunas nascem NULL/0 e todo pedido já gravado continua com total igual ao
 * de antes. É reversível na prática: basta parar de escrever nelas.
 *
 * Reversão real (DROP COLUMN) não está aqui de propósito: SQLite só passou a
 * suportá-lo na 3.35 e, num banco com views/índices, é mais arriscado do que
 * conviver com uma coluna a mais e ignorada.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..', 'data', 'tenants');
const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const idxArquivo = args.indexOf('--arquivo');
const arquivoAvulso = idxArquivo >= 0 ? args[idxArquivo + 1] : null;
const alvos = args.filter((a) => !a.startsWith('--') && a !== arquivoAvulso);

/**
 * Colunas novas em `pedidos`. Nenhuma em `pedido_itens`: desconto por item não
 * é desta fase (ver pedido-desconto.js).
 */
const COLUNAS = [
  // Como o desconto foi informado, para a tela poder mostrar "10%" em vez de
  // "R$ 50,00" — e para a auditoria saber o que o operador digitou.
  { tabela: 'pedidos', nome: 'descontoTipo', ddl: "ALTER TABLE pedidos ADD COLUMN descontoTipo TEXT" },
  { tabela: 'pedidos', nome: 'descontoValor', ddl: 'ALTER TABLE pedidos ADD COLUMN descontoValor REAL DEFAULT 0' },
  // O que entra na conta do total. SEMPRE em reais, sempre calculado pelo
  // servidor. É esta coluna que `recalcularTotal` lê.
  { tabela: 'pedidos', nome: 'descontoAplicado', ddl: 'ALTER TABLE pedidos ADD COLUMN descontoAplicado REAL DEFAULT 0' },
  // Por que o desconto foi dado. O aprovador da alçada decide olhando isto.
  { tabela: 'pedidos', nome: 'descontoMotivo', ddl: 'ALTER TABLE pedidos ADD COLUMN descontoMotivo TEXT' },
  // 'no_local' | 'retirada' | 'entrega'. NULL = pedido anterior a esta fase,
  // que não declarava atendimento — e continua válido. Obrigatório só para
  // tipo='pdv' e tipo='catalogo'; o ERP tradicional segue sem declarar.
  { tabela: 'pedidos', nome: 'tipoAtendimento', ddl: 'ALTER TABLE pedidos ADD COLUMN tipoAtendimento TEXT' },

  /**
   * Cliente sem documento, de forma explícita.
   *
   * `pessoas.cpfCnpj` é NOT NULL e tem UNIQUE. Torná-la nullable NÃO é
   * operação aditiva: o SQLite não tem `ALTER COLUMN`, e remover o NOT NULL
   * exige recriar `pessoas` — tabela referenciada por **32 outras**. Auditado
   * no relatório 13; a conclusão foi (C): outra solução é melhor.
   *
   * A solução: a chave interna continua em `cpfCnpj` (como o ERP JÁ faz hoje
   * em 4 cadastros de produção — 'EX-NICSRS', 'EX-CONTABO', 'TARIFA-asaas',
   * '193099'), e esta coluna torna o estado EXPLÍCITO. Sem ela seria preciso
   * adivinhar pelo prefixo, que é frágil; com ela, o fiscal barra com um
   * `WHERE semDocumento = 1` e o relatório separa os dois grupos.
   */
  { tabela: 'pessoas', nome: 'semDocumento', ddl: 'ALTER TABLE pessoas ADD COLUMN semDocumento INTEGER DEFAULT 0' },
];

/**
 * Faixas de alçada de desconto. NÃO são criadas pela migration — a decisão dos
 * percentuais é da proprietária, e um seed com número inventado viraria regra
 * de verdade. A migration só garante que a tabela aceita o tipoEvento novo;
 * o cadastro é feito na tela de governança.
 *
 * Registrado aqui para ficar explícito que a ausência é escolha, não descuido.
 */
const SEED_ALCADA = [];

function estado(db) {
  const cache = {};
  const cols = (tabela) => {
    if (!cache[tabela]) {
      cache[tabela] = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
    }
    return cache[tabela];
  };
  return COLUNAS.map((c) => ({ ...c, existe: cols(c.tabela).has(c.nome) }));
}

function migrar(arquivo, rotulo) {
  if (!fs.existsSync(arquivo)) return null;
  const db = new Database(arquivo, { readonly: !aplicar });
  try {
    const sit = estado(db);
    const faltando = sit.filter((c) => !c.existe);
    const linha = faltando.length
      ? `${faltando.length} coluna(s) a criar: ${faltando.map((c) => c.nome).join(', ')}`
      : 'já migrado';
    console.log(`  ${rotulo.padEnd(24)} ${linha}`);
    if (!aplicar || !faltando.length) return { rotulo, criadas: 0, faltando: faltando.length };

    let criadas = 0;
    const tx = db.transaction(() => {
      for (const c of faltando) { db.exec(c.ddl); criadas++; }
    });
    tx();
    // Conferência imediata: se a coluna não aparecer, o ALTER não valeu.
    const depois = estado(db).filter((c) => !c.existe);
    if (depois.length) throw new Error(`ALTER não persistiu: ${depois.map((c) => c.nome).join(', ')}`);
    console.log(`  ${rotulo.padEnd(24)} ${criadas} coluna(s) criada(s) ✔`);
    return { rotulo, criadas, faltando: 0 };
  } finally { db.close(); }
}

console.log(aplicar
  ? '### APLICANDO a migration da Fase 1 (escrita real)\n'
  : '### DRY-RUN — nada será escrito. Use --aplicar para valer.\n');

if (arquivoAvulso) {
  migrar(arquivoAvulso, path.basename(arquivoAvulso));
} else {
  const slugs = alvos.length
    ? alvos
    : fs.readdirSync(RAIZ, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (aplicar && !alvos.length) {
    console.error('Recusado: --aplicar exige nomear o(s) tenant(s). Aplicar nos 13 de uma vez não é operação de script.');
    process.exit(2);
  }
  for (const s of slugs) migrar(path.join(RAIZ, s, 'pncp.db'), s);
}

console.log(`\n${COLUNAS.length} coluna(s) no plano; ${SEED_ALCADA.length} faixa(s) de alçada semeada(s) `
  + '(as faixas são cadastradas na tela de governança, com os percentuais que a proprietária definir).');
if (!aplicar) console.log('Nada foi escrito.');
