#!/usr/bin/env node
/**
 * Semeia o roteiro de qualificação por WhatsApp num tenant.
 *
 *   node scripts/semear-roteiro-whatsapp.js <tenant> [--forcar]
 *
 * Diferenças para o roteiro de visita, e elas mudam o conteúdo inteiro:
 *
 *   - quem conduz é a IA, uma pergunta por mensagem, e só depois de responder
 *     o que o contato perguntou;
 *   - o fechamento é o teste de 14 dias, e não uma call. A conversa com o dono
 *     fica para quem tem porte maior ou dúvida que o teste não resolve;
 *   - a primeira pergunta vira a pergunta final da campanha, que hoje a
 *     `leads-pa-pregao` não tem.
 */
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules/better-sqlite3'));
const { validar } = require(path.join(__dirname, '..', 'roteiros'));

const CONFIG = {
  corte: 2,
  valores: {
    trial: '14 dias',
    linkTrial: 'https://liciteagora.app/trial.html',
    planoEntrada: 'Starter, R$ 297 por mês',
    planoIA: 'Profissional, R$ 697 por mês',
    donoNome: 'Carlos',
  },
  /* A IA conduz, e a precedência precisa estar escrita: um roteiro de cinco
     perguntas com resposta curta e sem insistir é instrução que se contradiz, e
     o modelo resolve isso do jeito dele. */
  conducao: [
    'Responda primeiro o que a pessoa perguntou. A pergunta do roteiro vem depois.',
    'Uma pergunta por mensagem, e só quando ela couber no assunto.',
    'Se a pessoa não demonstrar interesse, pare o roteiro e encerre com cordialidade.',
    'Pergunta que ficou sem resposta volta na conversa seguinte, nunca na mesma.',
  ],
  perguntas: [
    {
      chave: 'vende_governo',
      texto: 'Sua empresa já vende para órgão público, ou é coisa que você ainda quer começar?',
      primeira: true,
      opcoes: [
        { id: 'parou', rotulo: 'Já vendeu e parou', peso: 2, dor: 'já vendeu ao governo e parou' },
        { id: 'quer_comecar', rotulo: 'Quer começar, nunca vendeu', peso: 2, dor: 'quer vender ao governo e não sabe por onde começar' },
        { id: 'as_vezes', rotulo: 'Vende de vez em quando', peso: 1, dor: 'vende ao governo sem regularidade' },
        { id: 'frequente', rotulo: 'Vende com frequência', peso: 1 },
        { id: 'sem_interesse', rotulo: 'Não tem interesse', peso: 0, encerra: true },
      ],
    },
    {
      chave: 'acha_edital',
      texto: 'E como você fica sabendo dos editais que servem para o seu ramo?',
      opcoes: [
        { id: 'acaso', rotulo: 'Não fica sabendo, aparece por acaso', peso: 2, dor: 'só fica sabendo do edital por acaso' },
        { id: 'na_mao', rotulo: 'Olha os portais na mão', peso: 2, dor: 'garimpa os portais à mão quando sobra tempo' },
        { id: 'terceiro', rotulo: 'Alguém avisa (contador, despachante)', peso: 1, dor: 'depende de terceiro para saber dos editais' },
        { id: 'sistema', rotulo: 'Tem alerta ou sistema', peso: 0 },
      ],
    },
    {
      chave: 'le_edital',
      texto: 'Quando aparece um edital, quem lê as 200 páginas? Quanto tempo leva?',
      opcoes: [
        { id: 'desiste', rotulo: 'Ninguém lê inteiro, ou desiste do edital', peso: 2, dor: 'desiste de editais por não conseguir ler o documento inteiro' },
        { id: 'dono_dias', rotulo: 'O dono lê, leva dias', peso: 2, dor: 'o dono gasta dias lendo edital' },
        { id: 'equipe_horas', rotulo: 'Alguém da equipe, leva horas', peso: 1, dor: 'a equipe gasta horas por edital' },
        { id: 'rapido', rotulo: 'Resolvem rápido', peso: 0 },
      ],
    },
    {
      chave: 'habilitacao',
      texto: 'Já perdeu alguma por documento vencido ou detalhe de habilitação?',
      opcoes: [
        { id: 'varias', rotulo: 'Já, mais de uma vez', peso: 2, dor: 'já foi inabilitado mais de uma vez por documento' },
        { id: 'uma', rotulo: 'Já aconteceu uma vez', peso: 1, dor: 'já perdeu licitação por documento vencido' },
        { id: 'nunca', rotulo: 'Nunca', peso: 0 },
      ],
    },
    {
      chave: 'preco_lance',
      texto: 'Na hora do lance, como você decide até onde dá para baixar o preço?',
      opcoes: [
        { id: 'feeling', rotulo: 'No feeling, na hora', peso: 2, dor: 'decide o lance no feeling, sem histórico de preço' },
        { id: 'custo', rotulo: 'Calcula o custo, sem olhar o histórico', peso: 1, dor: 'calcula custo mas não conhece o preço homologado' },
        { id: 'historico', rotulo: 'Consulta preço homologado anterior', peso: 0 },
      ],
    },
  ],
  /* O que fazer com a nota. A faixa decide o desfecho, e é o que impede a IA de
     oferecer teste a quem disse que não tem interesse. */
  desfechos: [
    { de: 6, ate: 99, acao: 'Ofereça o teste de {{trial}} na hora, com o link {{linkTrial}}, '
      + 'avisando que em 30 segundos ele está dentro do sistema.' },
    { de: 3, ate: 5, acao: 'Responda a dor mais forte com um número concreto e ofereça o teste '
      + 'de {{trial}} em {{linkTrial}}.' },
    { de: 0, ate: 2, acao: 'Não insista. Deixe a comunidade do WhatsApp e as notícias, e encerre '
      + 'com cordialidade.' },
  ],
  objecoes: [
    { chave: 'preco', rotulo: 'Quanto custa',
      resposta: 'Começa no {{planoEntrada}}, e o plano com a análise de edital por IA é o '
        + '{{planoIA}}, com 20% de desconto no anual. Mas dá para ver o sistema rodando antes de '
        + 'falar em preço: são {{trial}} sem cartão.' },
    { chave: 'garante', rotulo: 'Vocês garantem que eu ganho',
      resposta: 'Não, e essa é a resposta honesta. O sistema encontra o edital, lê o edital e '
        + 'mostra por quanto o órgão já comprou aquilo antes. Quem decide o preço e assume o risco '
        + 'é você.',
      regra: 'Nunca prometer vitória. É o que vendedor de curso faz, e não é o que este sistema é.' },
    { chave: 'contador', rotulo: 'Meu contador cuida disso',
      resposta: 'O contador cuida da parte fiscal, e o sistema entrega a dele mais organizada. O '
        + 'que ele não faz é olhar os portais todo dia procurando edital do seu ramo, nem ler 200 '
        + 'páginas para dizer se você é habilitado.' },
    { chave: 'nao_entendo', rotulo: 'Não entendo de licitação',
      resposta: 'Boa parte dos clientes começou assim. O parecer da IA sai em blocos: o que o '
        + 'órgão quer, quais documentos exigem, quais são os riscos e um checklist do que você '
        + 'precisa ter. É a parte que assusta, e é a que o sistema mastiga.' },
    { chave: 'carta_marcada', rotulo: 'É tudo carta marcada',
      resposta: 'Isso acontece, e não vou dizer que não. Mas os dados são públicos: dá para ver '
        + 'quem ganhou, por quanto e quantas vezes. É isso que o sistema mostra antes de você '
        + 'gastar tempo. Se um órgão sempre compra do mesmo, você descobre antes.' },
    { chave: 'sem_tempo', rotulo: 'Não tenho tempo de aprender sistema',
      resposta: 'Comece pelo {{planoEntrada}}, que avisa quando aparece edital do seu ramo. Você '
        + 'usa o resto quando quiser.' },
    { chave: 'dados', rotulo: 'E os meus dados',
      resposta: 'Banco separado por empresa, e você exporta quando quiser.' },
  ],
};

function semear(tenant, forcar) {
  const arq = path.join(__dirname, '..', 'data', 'tenants', tenant, 'pncp.db');
  const db = new Database(arq);
  const problemas = validar(CONFIG);
  if (problemas.length) {
    console.error('Roteiro inválido:\n  ' + problemas.join('\n  '));
    process.exit(1);
  }
  const temTabela = db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='roteiros'").get().n;
  if (!temTabela) {
    console.error(`Tenant ${tenant}: a tabela "roteiros" ainda não existe. `
      + 'Ela é criada na migration, no boot do consulta-licitacoes.service.');
    process.exit(1);
  }
  const existe = db.prepare("SELECT id FROM roteiros WHERE canal = 'whatsapp' ORDER BY id LIMIT 1").get();
  if (existe && !forcar) {
    console.log(`Tenant ${tenant}: já existe roteiro de WhatsApp (#${existe.id}). Use --forcar.`);
    return;
  }
  const json = JSON.stringify(CONFIG);
  if (existe) {
    db.prepare(`UPDATE roteiros SET nome = ?, config = ?, corte = ?, ativo = 1,
      dataAtualizacao = datetime('now') WHERE id = ?`)
      .run('WhatsApp — licitações', json, CONFIG.corte, existe.id);
    console.log(`Tenant ${tenant}: roteiro #${existe.id} substituído.`);
  } else {
    const r = db.prepare(`INSERT INTO roteiros (nome, canal, corte, padrao, config)
      VALUES (?, 'whatsapp', ?, 1, ?)`).run('WhatsApp — licitações', CONFIG.corte, json);
    console.log(`Tenant ${tenant}: roteiro #${r.lastInsertRowid} criado.`);
  }
}

if (require.main === module) {
  const tenant = process.argv[2];
  if (!tenant) { console.error('Uso: node scripts/semear-roteiro-whatsapp.js <tenant> [--forcar]'); process.exit(1); }
  semear(tenant, process.argv.includes('--forcar'));
}

module.exports = { CONFIG, semear };
