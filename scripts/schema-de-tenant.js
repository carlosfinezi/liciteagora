/**
 * schema-de-tenant.js — o schema de produção, extraído na hora.
 *
 * ── O problema que isto resolve ─────────────────────────────────────────────
 *
 * 27 suítes montavam o banco de teste lendo um dump em `/tmp`:
 *
 *     const schema = fs.readFileSync('/tmp/vp-users-schema.sql', 'utf8');
 *
 * Esse arquivo era gerado à mão, uma vez, por quem escreveu a suíte:
 *
 *     sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/vp-users-schema.sql
 *
 * `/tmp` é limpo no reboot. Em 2026-09-17, 15 das 27 já não rodavam — morriam
 * em ENOENT antes do primeiro assert — e as outras 12 só passavam porque o
 * arquivo ainda estava lá, de uma sessão anterior. Elas quebrariam no reboot
 * seguinte, e ninguém saberia por quê: a suíte some do verde sem nunca ter
 * reprovado nada.
 *
 * ── Por que não usar o db-schema.js ─────────────────────────────────────────
 *
 * Seria o caminho óbvio, e não funciona: `initSchema` é migration INCREMENTAL,
 * não criador. Rodado contra um banco vazio ele cria ~50 tabelas e para em
 * `no such table: main.contas_financeiras`, porque assume um schema-base que
 * só existe em tenant de verdade.
 *
 * ── O que este módulo faz ───────────────────────────────────────────────────
 *
 * Abre um tenant em modo SOMENTE LEITURA e devolve o SQL de `sqlite_master`.
 * Nenhuma escrita, nenhum `sqlite3` no PATH, nenhum passo manual. O schema sai
 * sempre atual: se uma migration acrescentou coluna ontem, a suíte de hoje já
 * a vê.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const DIR_TENANTS = path.join(RAIZ, 'data', 'tenants');

/**
 * Devolve o SQL de criação do schema de um tenant.
 *
 * @param {string} [preferido]  slug a tentar primeiro; caindo fora, usa o
 *                              primeiro tenant com banco no disco.
 * @returns {string} SQL pronto para `db.exec()`
 */
function schemaDeTenant(preferido = '1bit') {
  if (!fs.existsSync(DIR_TENANTS)) {
    throw new Error(`data/tenants não existe em ${RAIZ} — rode a suíte a partir da raiz do projeto`);
  }
  const candidatos = fs.readdirSync(DIR_TENANTS)
    .filter((t) => fs.existsSync(path.join(DIR_TENANTS, t, 'pncp.db')));
  if (!candidatos.length) throw new Error('nenhum tenant com pncp.db em data/tenants');

  const slug = candidatos.includes(preferido) ? preferido : candidatos[0];
  // readonly: a suíte NUNCA escreve no banco do tenant. O teste monta a cópia
  // dele em /tmp e mexe só lá.
  const db = new Database(path.join(DIR_TENANTS, slug, 'pncp.db'), { readonly: true });
  try {
    return db.prepare(
      "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
    ).all().map((l) => l.sql).join(';\n') + ';';
  } finally {
    db.close();
  }
}

/**
 * O que as suítes chamam. O parâmetro `caminhoTmp` é aceito e **ignorado**:
 * existe só para que a chamada continue dizendo de onde o schema vinha antes.
 *
 * Ignorar é deliberado, e a primeira versão deste arquivo errava nisso. Ela
 * preferia o dump de `/tmp` quando ele existisse, "para não quebrar quem o
 * gerou à mão" — e era exatamente esse dump, congelado antes de 2026-08-20,
 * que fazia 12 suítes passarem contra um schema sem a remoção da tabela
 * `fornecedores`. Preferir o arquivo local reintroduziria o problema no dia em
 * que alguém regenerasse o dump, e o sintoma seria o pior possível: verde.
 *
 * A fonte é sempre o tenant.
 */
function lerSchema(_caminhoTmpIgnorado, preferido) {
  return schemaDeTenant(preferido);
}

module.exports = { schemaDeTenant, lerSchema };
