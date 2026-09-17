/**
 * Compra de certificado OV/EV na NicSRS — o payload, a mescla e a guarda.
 *
 * Origem: a compra do #61 (*.saobernardo.sp.gov.br, Certum Trusted Wildcard OV)
 * foi recusada cinco vezes em 15-16/09/2026. Foram DUAS causas independentes,
 * e a segunda ficou escondida atrás da primeira.
 *
 * 1ª — contatos. A recusa vinha como seis queixas repetidas três vezes ("The
 *      administrator's organation is required", idem postCode, country,
 *      address, state, city, e o mesmo para tech e finance). O contato gravado
 *      no certificado SUBSTITUÍA inteiro o do tenant, que é o único lugar com
 *      organização e endereço. DV nunca acusou porque não valida organização, e
 *      até o #61 todo OV desta conta tinha o campo de contato vazio.
 *
 * 2ª — o bloco `organizationInfo`, que num OV/EV é OBRIGATÓRIO e usa nomes de
 *      campo PRÓPRIOS: organizationName, organizationAddress, organizationCity,
 *      organizationCountry, organizationPostCode, organizationMobile. Nenhum
 *      coincide com os dos contatos (organation/city/state), e a documentação
 *      não os lista. O sistema não mandava o bloco, e a recusa dizia apenas
 *      "organizationInfo is required".
 *
 *      Como a lista foi obtida: mandando `{x:1}` — um objeto qualquer NÃO
 *      vazio — a API troca a queixa genérica por uma que nomeia cada campo que
 *      falta. Com `{}` ela trata como ausente e não diz nada. Foi o que
 *      destravou o caso, depois de seis tentativas adivinhando o formato.
 *
 *      Junto disso saiu o `Object.assign(params, org)`, que espalhava a
 *      organização na RAIZ do payload: entrou em 181c65f (24/08) e nunca
 *      funcionou, porque de lá até 16/09 nenhum certificado COM cliente foi
 *      comprado — as cinco compras OV do período tinham clienteId vazio.
 *
 * Duas hipóteses foram testadas contra a API e REFUTADAS; ficam registradas
 * para não serem tentadas de novo:
 *   - mandar `organizationInfo: {}` sempre. Para a NicSRS, bloco vazio é bloco
 *     ausente. O `{}` que aparece no applyParams lido por /ssl/collect é
 *     normalização da RESPOSTA, não o que foi enviado.
 *   - preencher o telefone do cliente. O cadastro do município estava sem
 *     telefone (a Receita não publica o de órgão público), e a suspeita era que
 *     `phone: ''` invalidasse o bloco. Preenchido, a recusa continuou igual.
 *     A guarda contra campo vazio ficou, por valer por si.
 *
 * Aqui não se chama a NicSRS: as funções são puras e a massa é sintética.
 */
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const { mesclarContato, erroDadosOv, paraContatoNicsrs, montarParams, organizacaoDoCliente } = require(path.join(RAIZ, 'ssl-certificados-routes.js'));

let okN = 0, falhas = 0;
const t = (n, f) => { try { f(); console.log('  OK  ' + n); okN++; } catch (e) { falhas++; console.log('FALHA ' + n + ' -> ' + e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };

// O contato do tenant, como está em config `nicsrs_administrator`: completo.
const TENANT = paraContatoNicsrs({
  firstName: 'Carlos', lastName: 'Finezi', email: 'atendimento@1bit.net.br',
  mobile: '+5594991112936', job: 'Administrador',
  organization: '1 BIT GESTAO E CONSULTORIA LTDA',
  address: 'AVN GAVIOES, 158, ANDAR 2', city: 'Maraba', state: 'PA',
  postCode: '68501-160', country: 'BR',
});

// O contato gravado no #61: só a pessoa, nenhum campo de organização.
const DO_CLIENTE = paraContatoNicsrs({
  firstName: 'JULIANA', lastName: 'CONSTANTINO',
  email: 'compras.noreply@saobernardo.sp.gov.br',
  mobile: '+5511989140560', job: 'ADMINISTRATIVO',
});

const EXIGIDOS = ['organation', 'address', 'city', 'state', 'postCode', 'country'];

t('1. `organization` vira `organation` — a grafia da NicSRS', () => {
  eq(TENANT.organation, '1 BIT GESTAO E CONSULTORIA LTDA', 'organation');
  ok(!('organization' in TENANT), 'o campo com "iz" não pode sobrar no payload');
});

t('2. a mescla mantém a PESSOA do cliente', () => {
  const m = mesclarContato(TENANT, DO_CLIENTE);
  eq(m.firstName, 'JULIANA', 'firstName');
  eq(m.email, 'compras.noreply@saobernardo.sp.gov.br', 'email');
  eq(m.job, 'ADMINISTRATIVO', 'job');
});

t('3. a mescla completa o que falta com o contato do tenant', () => {
  const m = mesclarContato(TENANT, DO_CLIENTE);
  for (const k of EXIGIDOS) eq(m[k], TENANT[k], 'campo ' + k);
});

// A regressão exata: substituir em vez de mesclar.
t('4. sem a mescla, o contato do #61 fica sem os 6 campos exigidos', () => {
  const faltando = EXIGIDOS.filter((k) => !String(DO_CLIENTE[k] || '').trim());
  eq(faltando.length, 6, 'a massa deveria reproduzir o contato incompleto do #61');
});

t('5. campo em branco não apaga o que o tenant tem', () => {
  const m = mesclarContato(TENANT, { ...DO_CLIENTE, city: '   ', organation: '' });
  eq(m.city, 'Maraba', 'city em branco sobrescreveu');
  eq(m.organation, '1 BIT GESTAO E CONSULTORIA LTDA', 'organation em branco sobrescreveu');
});

t('6. organização informada no certificado VENCE a do tenant', () => {
  const m = mesclarContato(TENANT, {
    ...DO_CLIENTE,
    organation: 'MUNICIPIO DE SAO BERNARDO DO CAMPO',
    address: 'PRACA SAMUEL SABATINI, 50, CENTRO', city: 'SAO BERNARDO DO CAMPO',
    state: 'SP', postCode: '09750700', country: 'BR',
  });
  eq(m.organation, 'MUNICIPIO DE SAO BERNARDO DO CAMPO', 'organation');
  eq(m.city, 'SAO BERNARDO DO CAMPO', 'city');
  eq(m.firstName, 'JULIANA', 'a pessoa não pode ter se perdido');
});

// ---- a guarda, que evita a ida inútil à NicSRS ----
//
// `organizationInfo` entra aqui preenchido de propósito: estes testes são sobre
// os CONTATOS, e sem o bloco a guarda barraria por outro motivo, escondendo o
// que eles querem medir. Os nomes são os da NicSRS — ver CAMPOS_ORGANIZATION_INFO.
const ORG_OK = {
  organizationName: 'MUNICIPIO DE SAO BERNARDO DO CAMPO',
  organizationAddress: 'PRACA SAMUEL SABATINI, 50, CENTRO',
  organizationCity: 'SAO BERNARDO DO CAMPO',
  organizationCountry: 'BR',
  organizationPostCode: '09750700',
  organizationMobile: '11989140560',
};
const paramsCom = (contato) => ({ Administrator: contato, tech: contato, finance: contato, organizationInfo: ORG_OK });

t('7. OV com contato incompleto é barrado ANTES da API', () => {
  const erro = erroDadosOv(paramsCom(DO_CLIENTE), 'ov');
  ok(erro, 'deveria barrar');
  ok(/organiza|endereço|CEP/i.test(erro), 'o erro precisa nomear o que falta: ' + erro);
  ok(/administrativo/.test(erro) && /técnico/.test(erro) && /financeiro/.test(erro),
     'os três papéis precisam aparecer, como na recusa real: ' + erro);
});

t('8. EV é barrado pela mesma regra', () => {
  ok(erroDadosOv(paramsCom(DO_CLIENTE), 'ev'), 'EV também valida organização');
  ok(erroDadosOv(paramsCom(DO_CLIENTE), 'OV'), 'a comparação não pode depender de caixa');
});

// Barrar DV seria pior que o defeito: bloquearia compra que a NicSRS aceita.
t('9. DV NÃO é barrado — a CA não valida organização nele', () => {
  eq(erroDadosOv(paramsCom(DO_CLIENTE), 'dv'), null, 'DV com contato simples tem de passar');
  eq(erroDadosOv(paramsCom(DO_CLIENTE), null), null, 'produto sem validationType conhecido não opina');
  eq(erroDadosOv(paramsCom(DO_CLIENTE), ''), null, 'idem para vazio');
});

t('10. OV com o contato JÁ MESCLADO passa — é o caminho do #61 corrigido', () => {
  const m = mesclarContato(TENANT, DO_CLIENTE);
  eq(erroDadosOv(paramsCom(m), 'ov'), null, 'a mescla deveria bastar para o OV passar');
});

t('11. a guarda reprova campo a campo, não tudo-ou-nada', () => {
  const quase = { ...mesclarContato(TENANT, DO_CLIENTE), postCode: '' };
  const erro = erroDadosOv(paramsCom(quase), 'ov');
  ok(erro, 'faltando só o CEP, ainda tem de barrar');
  ok(/CEP/.test(erro), 'o erro precisa dizer que é o CEP: ' + erro);
  ok(!/cidade/.test(erro), 'não pode acusar campo que está preenchido: ' + erro);
});

t('12. contato do tenant sozinho passa — é como as compras OV anteriores foram', () => {
  eq(erroDadosOv(paramsCom(TENANT), 'ov'), null,
     'as compras #43/#46/#54/#55/#56/#60 passaram exatamente assim');
});

// ---- o payload montado ----
//
// Corrigidos os contatos, a recusa mudou para "organizationInfo is required" e
// só então a 2ª causa apareceu — ver o cabeçalho. O que estes exercitam é a
// FORMA do payload: nada solto na raiz, nada vazio, organizationInfo só quando
// alguém o informa de verdade.
const DB_FAKE = { prepare: () => ({ get: () => null, all: () => [] }) };
const CERT_BASE = {
  id: 61, commonName: '*.saobernardo.sp.gov.br', dominiosSan: null,
  dcvMethod: 'CNAME_CSR_HASH', servidor: 'NGINX', csr: '-----BEGIN CERTIFICATE REQUEST-----x',
  clienteId: null, contatoAdmin: JSON.stringify({
    firstName: 'JULIANA', lastName: 'CONSTANTINO',
    email: 'compras.noreply@saobernardo.sp.gov.br', mobile: '+5511989140560', job: 'ADMINISTRATIVO',
  }),
};

// NENHUM campo pode viajar vazio.
//
// Esta guarda nasceu de uma hipótese que se mostrou errada — o cadastro do
// município estava sem telefone, e a suspeita era que `phone: ''` invalidasse o
// bloco da organização. Preenchido o telefone, a recusa continuou igual: a
// causa era outra (ver cabeçalho).
//
// A regra ficou porque vale por si: `organizacaoDoCliente` alimenta a tela que
// preenche os contatos, e lá um campo em branco sobrescreveria o do tenant —
// exatamente o que `mesclarContato` existe para impedir. 14 dos 176 cadastros
// ativos seguem sem telefone.
t('19. campo em branco nunca entra na organização', () => {
  const semTelefone = {
    prepare: () => ({
      get: () => ({
        razaoSocial: 'MUNICIPIO DE SAO BERNARDO DO CAMPO', cpfCnpj: '46523239000147',
        endereco: 'PRACA SAMUEL SABATINI', numero: '50', complemento: null, bairro: 'CENTRO',
        cidade: 'SAO BERNARDO DO CAMPO', uf: 'SP', cep: '09750700',
        telefone: '',            // <- o cadastro real, antes de ser preenchido
      }),
      all: () => [],
    }),
  };
  // Medido em organizacaoDoCliente, e não no payload: desde a correção de
  // 16/09 a organização não viaja solta na raiz. Quem a consome é a tela, para
  // preencher os contatos — e lá um `phone: ''` sobrescreveria o do tenant.
  const org = organizacaoDoCliente(semTelefone, 180);
  const vazias = Object.entries(org).filter(([, v]) => String(v || '').trim() === '');
  eq(vazias.length, 0, 'campos vazios: ' + vazias.map(([k]) => k).join(', '));
  ok(!('phone' in org), '`phone` em branco não pode virar chave');
  eq(org.organation, 'MUNICIPIO DE SAO BERNARDO DO CAMPO', 'o que existe tem de continuar indo');
  eq(org.idNumber, '46523239000147', 'CNPJ');
});

// As duas compras Certum OV que deram certo (#43 e #46) foram SEM esta chave;
// mandá-la vazia foi tentado e a NicSRS recusou igual.
t('20. organizationInfo só entra quando informado de verdade', () => {
  const p = montarParams(DB_FAKE, CERT_BASE, TENANT, null);
  ok(!('organizationInfo' in p), 'bloco vazio é tratado como ausente pela NicSRS — não mandar');
  const info = { organation: 'MUNICIPIO DE SAO BERNARDO DO CAMPO' };
  const p2 = montarParams(DB_FAKE, CERT_BASE, TENANT, info);
  eq(p2.organizationInfo.organation, 'MUNICIPIO DE SAO BERNARDO DO CAMPO', 'override manual');
});

// A causa que recusou o #61 quatro vezes. Os campos da organização iam soltos
// na raiz desde 24/08/2026 e nunca haviam sido exercitados: de lá até 16/09
// nenhum certificado COM cliente vinculado foi comprado, e as cinco compras OV
// bem-sucedidas do período tinham clienteId vazio. Ao ver `organation` avulso,
// a NicSRS passa a cobrar o bloco `organizationInfo` formal.
t('21b. nenhum campo de organização vai solto na raiz do payload', () => {
  const comCliente = {
    prepare: () => ({
      get: () => ({
        razaoSocial: 'MUNICIPIO DE SAO BERNARDO DO CAMPO', cpfCnpj: '46523239000147',
        endereco: 'PRACA SAMUEL SABATINI', numero: '50', complemento: null, bairro: 'CENTRO',
        cidade: 'SAO BERNARDO DO CAMPO', uf: 'SP', cep: '09750700', telefone: '11989140560',
      }),
      all: () => [],
    }),
  };
  const p = montarParams(comCliente, { ...CERT_BASE, clienteId: 180 }, TENANT, null);
  const PERMITIDAS = ['csr', 'server', 'domainInfo', 'Administrator', 'tech', 'finance', 'uniqueValue', 'organizationInfo'];
  const intrusas = Object.keys(p).filter((k) => !PERMITIDAS.includes(k));
  eq(intrusas.length, 0, 'chaves soltas na raiz: ' + intrusas.join(', '));
  // Ter cliente muda a forma em UM ponto só, e de propósito: ganha o bloco
  // `organizationInfo`, que a NicSRS exige em OV/EV. O que não pode voltar é
  // campo de organização solto na raiz.
  const semCliente = montarParams(DB_FAKE, { ...CERT_BASE, clienteId: null }, TENANT, null);
  const soNoComCliente = Object.keys(p).filter((k) => !(k in semCliente));
  eq(soNoComCliente.join(','), 'organizationInfo', 'diferença inesperada entre com e sem cliente');
});

t('21. o payload leva os três contatos completos e mesclados', () => {
  const p = montarParams(DB_FAKE, CERT_BASE, TENANT, null);
  for (const papel of ['Administrator', 'tech', 'finance']) {
    eq(p[papel].firstName, 'JULIANA', papel + '.firstName');
    for (const k of EXIGIDOS) ok(String(p[papel][k] || '').trim(), `${papel}.${k} vazio`);
  }
  // A guarda cobre contatos E organização; aqui o certificado não tem cliente,
  // então o bloco da organização entra pela massa — o que se mede é o contato.
  eq(erroDadosOv({ ...p, organizationInfo: ORG_OK }, 'ov'), null,
     'os contatos montados deveriam passar na guarda');
});

// ---- organizationInfo: os nomes são OUTROS ----
//
// Descoberto em 16/09/2026 sondando a própria API: mandando um objeto qualquer
// não-vazio (`{x:1}`), ela troca o "organizationInfo is required" genérico por
// uma recusa que NOMEIA os campos que faltam. São seis, todos com prefixo
// `organization`, e NENHUM coincide com os nomes usados nos contatos
// (`organation`/`city`/`state`). Confundir os dois conjuntos foi o que travou a
// compra do #61 por seis tentativas.
const CAMPOS_ORG_API = ['organizationName', 'organizationAddress', 'organizationCity',
                        'organizationCountry', 'organizationPostCode', 'organizationMobile'];

t('22. organizationInfo é montado do cadastro do cliente, com os nomes da NicSRS', () => {
  const comCliente = {
    prepare: () => ({
      get: () => ({
        razaoSocial: 'MUNICIPIO DE SAO BERNARDO DO CAMPO', cpfCnpj: '46523239000147',
        endereco: 'PRACA SAMUEL SABATINI', numero: '50', complemento: null, bairro: 'CENTRO',
        cidade: 'SAO BERNARDO DO CAMPO', uf: 'SP', cep: '09750700', telefone: '11989140560',
      }),
      all: () => [],
    }),
  };
  const p = montarParams(comCliente, { ...CERT_BASE, clienteId: 180 }, TENANT, null);
  ok(p.organizationInfo, 'organizationInfo não foi montado');
  for (const k of CAMPOS_ORG_API) ok(String(p.organizationInfo[k] || '').trim(), 'campo vazio: ' + k);
  eq(p.organizationInfo.organizationName, 'MUNICIPIO DE SAO BERNARDO DO CAMPO', 'razão social');
  eq(p.organizationInfo.organizationCountry, 'BR', 'país');
  // Os nomes dos CONTATOS não podem vazar para dentro do bloco.
  for (const k of ['organation', 'city', 'state', 'address', 'postCode']) {
    ok(!(k in p.organizationInfo), `nome de contato vazou para organizationInfo: ${k}`);
  }
});

t('23. cadastro incompleto não vira bloco pela metade', () => {
  const semTelefone = {
    prepare: () => ({
      get: () => ({
        razaoSocial: 'X LTDA', cpfCnpj: '46523239000147', endereco: 'RUA A', numero: '1',
        complemento: null, bairro: 'CENTRO', cidade: 'SP', uf: 'SP', cep: '01000000',
        telefone: '',       // <- falta o telefone
      }),
      all: () => [],
    }),
  };
  const p = montarParams(semTelefone, { ...CERT_BASE, clienteId: 1 }, TENANT, null);
  // Bloco incompleto é recusado igual a bloco ausente: melhor não mandar e
  // deixar a guarda explicar em português o que falta no cadastro.
  ok(!p.organizationInfo, 'bloco incompleto não pode ser enviado');
  const erro = erroDadosOv(p, 'ov');
  ok(erro && /organização/.test(erro), 'a guarda precisa explicar o que falta: ' + erro);
  ok(/cadastro do cliente/.test(erro), 'o erro precisa apontar ONDE corrigir: ' + erro);
});

t('24. DV segue sem exigir organização', () => {
  const p = montarParams(DB_FAKE, { ...CERT_BASE, clienteId: null }, TENANT, null);
  eq(erroDadosOv(p, 'dv'), null, 'DV não pode ser barrado por falta de organizationInfo');
});

// ---- a ponta da tela ----
const fs = require('fs');
const vm = require('vm');
const HTML = fs.readFileSync(path.join(RAIZ, 'public/ssl/certificados.html'), 'utf8');
const inline = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const js = inline.join('\n');

t('13. o script inline da tela parseia', () => {
  ok(inline.length > 0, 'nenhum script inline');
  inline.forEach((src, i) => {
    try { new vm.Script(src, { filename: `certificados.html#${i}` }); }
    catch (e) { throw new Error(`bloco ${i}: ${e.message}`); }
  });
});

t('14. o bloco da organização existe e cobre os 6 campos exigidos', () => {
  ok(/id="boxOrganizacao"/.test(HTML), 'container ausente no HTML');
  ok(/function renderOrganizacao/.test(js), 'renderOrganizacao ausente');
  for (const k of EXIGIDOS) ok(new RegExp(`chave:'${k}'`).test(js), 'campo ausente na tela: ' + k);
});

t('15. a organização é gravada nos TRÊS contatos', () => {
  // A NicSRS cobra os campos por contato; um bloco só na tela, aplicado aos
  // três ao salvar. Se colherContato parar de espalhar, o OV volta a falhar.
  ok(/\.\.\.colherOrganizacao\(\)/.test(js), 'colherContato não aplica a organização');
});

// Filtros do catálogo: 69 produtos de 5 CAs numa lista só, e dois vizinhos da
// mesma marca podem ser um DV de US$ 5 e um OV de US$ 25.
t('15b. o catálogo tem filtros de marca, validação e tipo de domínio', () => {
  for (const id of ['fFiltroMarca', 'fFiltroValidacao', 'fFiltroDominio']) {
    ok(new RegExp(`id="${id}"`).test(HTML), 'filtro ausente: ' + id);
    ok(new RegExp(`${id}[^>]*onchange="renderProdutos\\(\\)"`).test(HTML), `${id} não redesenha a lista`);
  }
  ok(/function renderProdutos/.test(js), 'renderProdutos ausente');
  // As marcas vêm do catálogo, não de uma lista fixa que envelheceria.
  ok(/new Set\(PRODUTOS\.map\(p => p\.vendor\)/.test(js), 'marcas fixas em vez de vindas do catálogo');
});

// O filtro de curinga é compatibilidade, não preferência: produto sem wildcard
// para um domínio `*.x.br` seria recusado pela CA.
t('15c. domínio curinga liga o filtro de curinga sozinho', () => {
  ok(/function aoMudarDominio/.test(js), 'aoMudarDominio ausente');
  ok(/id="fCN"[^>]*onchange="aoMudarDominio\(\)"/.test(HTML), 'o campo de domínio não dispara o ajuste');
  ok(/startsWith\('\*\.'\)/.test(js), 'não detecta curinga');
});

// O produto vindo do item do contrato não é escolha de quem está na tela: se um
// filtro o escondesse, `select.value = code` falharia em SILÊNCIO e o cadastro
// sairia sem produto.
t('15d. filtro não pode esconder o produto exigido pelo contrato', () => {
  ok(/function garantirProdutoVisivel/.test(js), 'garantirProdutoVisivel ausente');
  const trecho = js.slice(js.indexOf('if (it.productCode)'), js.indexOf('if (it.productCode)') + 320);
  ok(/garantirProdutoVisivel\(it\.productCode\)/.test(trecho), 'o caminho do contrato não garante a visibilidade');
  ok(trecho.indexOf('garantirProdutoVisivel') < trecho.indexOf('selP.value'),
     'a garantia precisa vir ANTES de atribuir o value');
});

// Editar um certificado não pode trocar o produto dele.
//
// Flagrado em 16/09/2026: `editar()` preenchia domínio, anos, CSR, DCV, custo —
// e NÃO o produto. O select ficava no primeiro item do catálogo, então salvar
// qualquer edição gravava outro produto, de outra marca e outro preço, sem
// aviso. O #61 (certum-ov-wildcard-ssl, US$ 61,60) abria como
// certum-dv-multidomain-ssl. Só apareceria na recusa da CA ou na fatura — e os
// filtros novos pioram o caso, porque mudam qual é o primeiro item.
t('15e. editar() repõe o produto do certificado no select', () => {
  const corpo = js.slice(js.indexOf('async function editar('), js.indexOf('async function editar(') + 3000);
  ok(/garantirProdutoVisivel\(c\.productCode\)/.test(corpo), 'editar() não garante o produto visível');
  ok(/selProd\.value = c\.productCode/.test(corpo), 'editar() não repõe o produto no select');
  // Produto fora do catálogo não pode passar calado apontando para outro.
  ok(/selProd\.value !== c\.productCode/.test(corpo), 'sem verificação de produto fora do catálogo');
  // E o custo GRAVADO tem de sobreviver ao recálculo por tabela.
  const iTroca = corpo.indexOf('aoTrocarProduto();');
  const iCusto = corpo.indexOf("fCustoUsd').value = c.custoUsd", iTroca);
  ok(iTroca > 0 && iCusto > iTroca, 'o custo gravado precisa ser restaurado DEPOIS de aoTrocarProduto()');
});

// O modal pedia mais do que a compra precisa. No painel da NicSRS, comprar é
// escolher produto, quantidade e validade — nada de CSR, contatos ou
// organização. Aqui domínio e DCV precisam ficar (o /ssl/place junta compra e
// emissão), mas o resto deixou de ser exigência de fachada.
t('15f. o CSR não é apresentado como obrigatório', () => {
  ok(!/<label>CSR \*<\/label>/.test(HTML), 'CSR ainda marcado com asterisco');
  ok(/CSR <small class="muted"[^>]*>— opcional/.test(HTML), 'falta dizer que é opcional');
  // O #60 e o #64 foram comprados sem CSR: a mensagem não pode tratar como falta.
  ok(!/falta o CSR/.test(js), 'a mensagem ainda trata ausência de CSR como pendência');
  ok(/NicSRS vai gerar a chave/.test(js), 'falta explicar que a NicSRS gera o par');
});

t('15g. contatos e organização ficam recolhidos, e abrem em OV/EV', () => {
  ok(/<details id="detDadosCA"/.test(HTML), 'bloco não é recolhível');
  // Os containers têm de continuar existindo DENTRO do details.
  const det = HTML.slice(HTML.indexOf('<details id="detDadosCA"'), HTML.indexOf('</details>'));
  ok(/id="boxContatos"/.test(det) && /id="boxOrganizacao"/.test(det),
     'contatos/organização precisam ficar dentro do bloco recolhível');
  ok(/function ajustarDadosCA/.test(js), 'ajustarDadosCA ausente');
  ok(/if \(ov\) det\.open = true/.test(js), 'o bloco não abre sozinho em OV/EV');
  // Nunca fechar o que a pessoa abriu para mexer.
  ok(!/det\.open = false/.test(js), 'o bloco não pode fechar sozinho');
});

// Os dados do PEDIDO vinham todos do tenant quando o certificado não tinha
// contato próprio — foi o que apareceu no pedido RC17895699705875. A
// organização já vinha do cliente (basta vinculá-lo); faltava o mesmo para os
// contatos, que a CA exige com nome, sobrenome e e-mail da pessoa.
t('15h. dá para puxar o CONTATO do cadastro do cliente', () => {
  ok(/function preencherContatoDoCliente/.test(js), 'função ausente');
  ok(/\/api\/ssl\/contato-cliente\//.test(js), 'a tela não chama a rota');
  const rotas = fs.readFileSync(path.join(RAIZ, 'ssl-certificados-routes.js'), 'utf8');
  ok(/app\.get\('\/api\/ssl\/contato-cliente\/:clienteId'/.test(rotas), 'o backend não registra a rota');
  // A fonte preferida é a pessoa de verdade; o cadastro do cliente é fallback.
  ok(/pessoas_contatos/.test(rotas), 'não busca em pessoas_contatos');
  // O que a CA exige tem de ser dito ANTES da compra, não depois da recusa.
  ok(/faltando/.test(rotas) && /A CA ainda exige/.test(js), 'não avisa o que falta');
  // Campo vazio não pode sobrescrever o que já está preenchido na tela.
  ok(/if \(el && d\.contato\[c\.chave\]\)/.test(js), 'campo vazio sobrescreveria o preenchido');
});

t('16. dá para puxar a organização do cadastro do cliente', () => {
  ok(/function preencherOrgDoCliente/.test(js), 'botão sem função');
  ok(/\/api\/ssl\/organizacao-cliente\//.test(js), 'a tela não chama a rota');
  const rotas = fs.readFileSync(path.join(RAIZ, 'ssl-certificados-routes.js'), 'utf8');
  ok(/app\.get\('\/api\/ssl\/organizacao-cliente\/:clienteId'/.test(rotas), 'o backend não registra a rota');
});

// Há TRÊS caminhos até o `place`: o botão "Comprar na NicSRS" e os dois que
// nascem do pedido de compra (assinatura e certificado). Guardar só o primeiro
// deixaria os outros dois falhando com a recusa ilegível — foi o que esta
// checagem pegou quando só o /aprovar tinha a guarda.
t('17. TODA chamada de place é precedida pela guarda', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'ssl-certificados-routes.js'), 'utf8');
  const places = [...rotas.matchAll(/await nicsrs\.place\(/g)].map((m) => m.index);
  const guardas = [...rotas.matchAll(/(?<!function )erroDadosOv\(params/g)].map((m) => m.index);
  ok(places.length >= 3, 'esperava 3 caminhos de compra, achei ' + places.length);
  eq(guardas.length, places.length, 'guardas para cada chamada de place');
  for (const [i, iPlace] of places.entries()) {
    // A guarda de cada caminho tem de estar antes do seu place e depois do
    // anterior — senão uma só estaria "cobrindo" as três na contagem.
    const anterior = i === 0 ? 0 : places[i - 1];
    ok(guardas.some((g) => g > anterior && g < iPlace),
       `a chamada de place em ${iPlace} não tem guarda antes dela`);
  }
});

t('18. os três caminhos sabem o validationType do produto', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'ssl-certificados-routes.js'), 'utf8');
  // Cada guarda recebe um validationType de verdade, não `undefined` — que a
  // faria devolver null e nunca barrar nada.
  const chamadas = [...rotas.matchAll(/(?<!function )erroDadosOv\(params,\s*([^;]+?)\);/g)].map((m) => m[1].trim());
  eq(chamadas.length, 3, 'chamadas da guarda');
  for (const arg of chamadas) {
    ok(/validationType/.test(arg), 'guarda chamada sem validationType: ' + arg);
  }
});

console.log(`\n  ${okN} ok, ${falhas} falha(s)\n`);
process.exit(falhas ? 1 : 0);
