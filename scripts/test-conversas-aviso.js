/**
 * Aviso de mensagem nova na inbox — som e notificação.
 *
 * ── Como esta suíte testa ──────────────────────────────────────────────────
 *
 * A lógica mora no `<script>` da tela. Ela é EXTRAÍDA do HTML e EXECUTADA sobre
 * stubs, em vez de conferida por regex: o relatório 24 mostrou um arquivo que
 * nem parseava passando por 14 testes de regex verdes. Aqui, se o recorte não
 * achar o bloco, ou o bloco não executar, a suíte quebra ruidosamente.
 *
 * ── O que ela protege ──────────────────────────────────────────────────────
 *
 *  1. **A primeira carga não avisa.** Abrir a tela com 153 não lidas e ouvir um
 *     alarme sobre mensagem de ontem é o jeito mais rápido de a pessoa desligar
 *     o aviso para sempre. É o teste que mais importa aqui.
 *  2. **Só avisa quando SOBE.** Ler conversas derruba o contador, e cair não é
 *     evento.
 *  3. **Pop-up desligado não notifica, som desligado não toca.** Interruptor que
 *     não desliga é pior que interruptor nenhum.
 *  4. **Sem permissão do navegador, não tenta notificar.**
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public/comunicacao/conversas.html'), 'utf8');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- recorta o bloco do aviso ----------
const INICIO = HTML.indexOf('const AVISO = {');
const FIM = HTML.indexOf('* Dono da conversa.');
if (INICIO < 0 || FIM < 0 || FIM < INICIO) {
  console.log('FALHA recorte -> o bloco do aviso não foi encontrado em conversas.html '
    + '(procurei de "const AVISO = {" até "* Dono da conversa.")');
  process.exit(1);
}
const CODIGO = HTML.slice(INICIO, HTML.lastIndexOf('/**', FIM));

/** Um ambiente novo por teste: o estado (NAO_LIDAS_ANTES) é justamente o que se mede. */
function ambiente({ som = true, popup = false, permissao = 'granted' } = {}) {
  const guardado = { convAvisoSom: som ? '1' : '0', convAvisoPopup: popup ? '1' : '0' };
  const reg = { beeps: 0, notificacoes: [], alertas: [] };

  const elAvisos = { innerHTML: '' };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (k) => (k in guardado ? guardado[k] : null),
      setItem: (k, v) => { guardado[k] = v; },
    },
    document: { getElementById: (id) => (id === 'avisos' ? elAvisos : null) },
    showAlert: (m) => reg.alertas.push(m),
    setTimeout: () => 0,
    Notification: class {
      constructor(titulo, opcoes) { reg.notificacoes.push({ titulo, ...opcoes }); }
      static permission = permissao;
      static requestPermission() { return Promise.resolve(permissao); }
    },
    AudioContext: class {
      createOscillator() { return { frequency: {}, connect() {}, start() { reg.beeps++; }, stop() {} }; }
      createGain() { return { gain: {}, connect() {} }; }
      close() {}
      get currentTime() { return 0; }
    },
    Promise, JSON, Math, Date, Object, Error, String, Number, Boolean,
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // `const` não vira propriedade do global no vm (fica no escopo do script), e é
  // por isso que AVISO precisa ser exposto de dentro. As `function` viram.
  new vm.Script(CODIGO + '\n;globalThis.__aviso = AVISO;',
    { filename: 'conversas.html:aviso' }).runInContext(ctx);
  return { ctx, reg };
}

// ==================== A. quando avisa ====================

t('A1. a PRIMEIRA carga nunca avisa, mesmo com 153 nao lidas', () => {
  const { ctx, reg } = ambiente();
  ctx.avisarSeChegou(153);
  assert(reg.beeps === 0,
    'tocou na primeira carga — isso alarma sobre mensagem que já estava lá, e a pessoa desliga o aviso');
});

t('A2. avisa quando o total SOBE', () => {
  const { ctx, reg } = ambiente();
  ctx.avisarSeChegou(153);
  ctx.avisarSeChegou(155);
  assert(reg.beeps === 1, `esperava 1 aviso, houve ${reg.beeps}`);
});

t('A3. NAO avisa quando o total cai (alguem leu as conversas)', () => {
  const { ctx, reg } = ambiente();
  ctx.avisarSeChegou(153);
  ctx.avisarSeChegou(100);
  assert(reg.beeps === 0, 'avisou numa queda — ler conversa não é mensagem nova');
});

t('A4. NAO avisa quando o total repete', () => {
  const { ctx, reg } = ambiente();
  ctx.avisarSeChegou(10);
  ctx.avisarSeChegou(10);
  ctx.avisarSeChegou(10);
  assert(reg.beeps === 0, `avisou ${reg.beeps} vez(es) sem nada ter chegado — a cada 30s, sem parar`);
});

t('A5. depois de cair, o novo piso e o que vale', () => {
  const { ctx, reg } = ambiente();
  ctx.avisarSeChegou(153);   // primeira carga
  ctx.avisarSeChegou(0);     // leu tudo
  ctx.avisarSeChegou(1);     // chegou uma
  assert(reg.beeps === 1, `esperava 1 aviso, houve ${reg.beeps}`);
});

// ==================== B. os interruptores ====================

t('B1. som desligado nao toca', () => {
  const { ctx, reg } = ambiente({ som: false });
  ctx.avisarSeChegou(1); ctx.avisarSeChegou(5);
  assert(reg.beeps === 0, 'tocou com o som desligado');
});

t('B2. pop-up desligado nao notifica', () => {
  const { ctx, reg } = ambiente({ popup: false });
  ctx.avisarSeChegou(1); ctx.avisarSeChegou(5);
  assert(reg.notificacoes.length === 0, 'notificou com o pop-up desligado');
});

t('B3. pop-up ligado notifica, e o texto diz QUANTAS chegaram', () => {
  const { ctx, reg } = ambiente({ popup: true });
  ctx.avisarSeChegou(1); ctx.avisarSeChegou(4);
  assert(reg.notificacoes.length === 1, `esperava 1 notificação, houve ${reg.notificacoes.length}`);
  assert(/3 mensagens novas/.test(reg.notificacoes[0].titulo),
    `o texto veio "${reg.notificacoes[0].titulo}" — deveria dizer que chegaram 3`);
});

t('B4. uma mensagem so usa o singular', () => {
  const { ctx, reg } = ambiente({ popup: true });
  ctx.avisarSeChegou(0); ctx.avisarSeChegou(1);
  assert(reg.notificacoes[0].titulo === 'Mensagem nova',
    `veio "${reg.notificacoes[0].titulo}"`);
});

t('B5. sem permissao do navegador, nao tenta notificar', () => {
  const { ctx, reg } = ambiente({ popup: true, permissao: 'denied' });
  ctx.avisarSeChegou(1); ctx.avisarSeChegou(9);
  assert(reg.notificacoes.length === 0, 'tentou notificar sem permissão');
  assert(reg.beeps === 1, 'e o som deveria continuar funcionando sozinho');
});

t('B6. as notificacoes se substituem em vez de empilhar', () => {
  // `tag` igual faz o navegador trocar a anterior. Sem isso, meia hora de
  // ausência devolve uma pilha de balões que a pessoa fecha um por um.
  const { ctx, reg } = ambiente({ popup: true });
  ctx.avisarSeChegou(0); ctx.avisarSeChegou(1); ctx.avisarSeChegou(2);
  assert(reg.notificacoes.every(n => n.tag === 'conversas-novas'),
    'as notificações não usam a mesma tag: ' + JSON.stringify(reg.notificacoes.map(n => n.tag)));
});

// ==================== C. a preferencia ====================

t('C1. o estado inicial vem do localStorage', () => {
  const { ctx } = ambiente({ som: false, popup: true });
  assert(ctx.__aviso.som === false && ctx.__aviso.popup === true,
    'a preferência salva foi ignorada: ' + JSON.stringify(ctx.__aviso));
});

t('C2. o som nasce ligado quando nao ha preferencia salva', () => {
  // Som é local e reversível num clique; notificação exige permissão e nasce
  // desligada. A diferença entre os dois padrões é de consentimento.
  const ctx = vm.createContext({
    console: { log() {} }, localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => ({ innerHTML: '' }) }, setTimeout: () => 0,
    Promise, JSON, Math, Date, Object, Error, String, Number, Boolean,
  });
  ctx.window = ctx; ctx.globalThis = ctx;
  new vm.Script(CODIGO + '\n;globalThis.__aviso = AVISO;',
    { filename: 'conversas.html:aviso' }).runInContext(ctx);
  assert(ctx.__aviso.som === true, 'o som nasceu desligado');
  assert(ctx.__aviso.popup === false, 'a notificação nasceu ligada sem ninguém ter autorizado');
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
