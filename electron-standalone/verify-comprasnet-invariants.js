#!/usr/bin/env node
'use strict';

/**
 * verify-comprasnet-invariants.js — GUARD ANTI-REGRESSÃO do Comprasnet.
 *
 * A captura de token do Comprasnet (evitar hCaptcha + renovação contínua do Bearer) é
 * a função central do app e JÁ REGREDIU várias vezes. Este script trava o build se
 * alguma das regras duramente aprendidas for violada. Rode antes de todo build
 * (`npm run build:win:nsis` dispara via prebuild) ou manualmente: `npm run verify:comprasnet`.
 *
 * BNC/BLL/outros portais podem mudar à vontade — nada aqui checa `portals/bnc` ou
 * `portals/bll`. Só protege o núcleo Comprasnet: electron-browser.js (flags),
 * server-sync.js (renovação), portals/comprasnet/{auto-login,integration,reauth}.js.
 *
 * Referência do padrão correto: build ESTÁVEL v1.0.0 enviada pelo cliente
 * (/tmp/uploads-1bit/LiciteAgora-Browser-versao-estavel-login-automatico.zip).
 */

const fs = require('fs');
const path = require('path');

const D = __dirname;
const read = (p) => {
  try { return fs.readFileSync(path.join(D, p), 'utf8'); }
  catch (e) { return null; }
};

const problems = [];
function must(cond, msg) { if (!cond) problems.push('FALTOU:   ' + msg); }
function never(cond, msg) { if (cond) problems.push('PROIBIDO: ' + msg); }

const eb   = read('electron-browser.js') || '';
const ss   = read('server-sync.js') || '';
const al   = read('portals/comprasnet/auto-login.js') || '';
const integ = read('portals/comprasnet/integration.js') || '';
const reauth = read('portals/comprasnet/reauth.js') || '';
const pkg  = read('package.json') || '';

// Descontar linhas de comentário (começam com // ou *) pra checar CÓDIGO, não menções.
const code = (src) => src.split('\n').filter(l => {
  const t = l.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
}).join('\n');
const ebC = code(eb), ssC = code(ss), alC = code(al), integC = code(integ);

// ─── 1. Anti-hCaptcha = flags do Chromium (é ISTO que evita o hCaptcha) ──────
must(/disable-blink-features/.test(ebC) && /AutomationControlled/.test(ebC),
  "electron-browser.js precisa da flag disable-blink-features=AutomationControlled (remove navigator.webdriver no motor — é o que evita o hCaptcha).");
must(/ignore-gpu-blocklist/.test(ebC),
  "electron-browser.js precisa da flag ignore-gpu-blocklist (WebGL p/ fingerprint do hCaptcha).");

// ─── 2. NUNCA reintroduzir stealth JS (piora: cria inconsistência detectável) ─
never(/stealth-preload|__stealthApplied/.test(ebC),
  "injeção de stealth JS (stealth-preload) reintroduzida. As flags do Chromium bastam; stealth por cima cria fingerprint inconsistente → hCaptcha invisível-travado. (regressão 5.2.18)");
never(/will-attach-webview[\s\S]{0,400}?preload/.test(ebC),
  "will-attach-webview setando preload (era o vetor do stealth). Remover.");

// ─── 3. NUNCA destruir o device-trust do acesso.gov.br (motor do ciclo) ──────
never(/rmSync\([^)]*Partitions/.test(ebC),
  "wipe de perfil (rmSync em Partitions/) no electron-browser.js. Apagar o perfil destrói o cookie de trust do acesso.gov.br → hCaptcha volta. (regressão 5.2.16/17)");
never(/wipe-profile-on-start|wipeAndRelaunch|profile-recovery/.test(ebC + ssC + alC + integC),
  "mecanismo de wipe automático de perfil (wipe-profile-on-start / wipeAndRelaunch / profile-recovery) reintroduzido.");
// clearStorageData que apaga cookies = destrói o trust. limparSessaoComprasnet (cookie-a-cookie) é OK.
never(/clearStorageData\((?![^)]*\/\* ok)/.test(alC + integC) && /clearStorageData\([^)]*cookies|clearStorageData\(\s*\)/.test(alC + integC),
  "clearStorageData apagando cookies em portals/comprasnet. Use limparSessaoComprasnet (remove só cookies do comprasnet.gov.br, preserva acesso.gov.br).");

// ─── 4. Renovação = re-auth SSO (NÃO retoken, que nunca funcionou: 0/850) ────
never(/function\s+retokenHTTP|function\s+retokenWebview/.test(ssC),
  "retoken (retokenHTTP/retokenWebview) reintroduzido em server-sync.js. Nunca funcionou (0/850 — endpoint exige cookie de sessão). Renovação é via re-auth SSO.");
never(/function\s+webviewNoLogin/.test(ssC),
  "webviewNoLogin→ssoMorto reintroduzido. Tratar 'webview no loginPortal' como sessão morta mata a sessão saudável em repouso. (regressão que travou a captura contínua no 5.2.19)");
must(/_onNeedReload\(\)/.test(ssC),
  "server-sync.js precisa disparar a renovação via _onNeedReload() (fluxo re-auth SSO) no keepalive.");
must(/reauth-sso/.test(ss),
  "server-sync.js precisa logar 'reauth-sso' na renovação proativa (telemetria de captura contínua).");
must(reauth && /sso\.acesso\.gov\.br\/authorize/.test(reauth) && /cnetmobile/.test(reauth),
  "portals/comprasnet/reauth.js precisa do fluxo authorize→cnetmobile (é ele que re-emite o Bearer novo).");
must(/createOnNeedReload/.test(integ) && /onNeedReload/.test(integ),
  "integration.js precisa fiar reauth.createOnNeedReload como onNeedReload do server-sync.");

// ─── 5. URL www (igual à estável) ────────────────────────────────────────────
must(/www\.comprasnet\.gov\.br\/seguro\/loginPortal/.test(al),
  "auto-login deve navegar em www.comprasnet.gov.br (igual à build estável).");

// ─── Resultado ───────────────────────────────────────────────────────────────
if (problems.length) {
  console.error('\n❌ INVARIANTES DO COMPRASNET VIOLADAS — build bloqueado:\n');
  problems.forEach(p => console.error('   • ' + p));
  console.error('\nLeia electron-standalone/CLAUDE.md antes de mexer no núcleo Comprasnet.');
  console.error('Referência do padrão correto: build estável v1.0.0 em /tmp/uploads-1bit/.\n');
  process.exit(1);
}
console.log('✓ Invariantes do Comprasnet OK (flags anti-hCaptcha + re-auth SSO + trust preservado).');
