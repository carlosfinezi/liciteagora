#!/usr/bin/env node
/**
 * Semeia o roteiro de visita presencial num tenant.
 *
 *   node scripts/semear-roteiro-visita.js <tenant> [--forcar]
 *
 * O conteúdo é o script do vendedor, com os ajustes decididos em 18/09/2026:
 * o plano vendido em campo é o Avançado (o único com PDV e NFC-e), e por isso
 * entra o filtro de porte antes das cinco perguntas.
 *
 * Não sobrescreve roteiro existente sem `--forcar`: o texto é editado na tela,
 * e rodar o semeador de novo apagaria o ajuste de quem usa.
 */
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules/better-sqlite3'));
const { validar } = require(path.join(__dirname, '..', 'roteiros'));

const CONFIG = {
  corte: 2,
  valores: {
    precoEntrada: 'R$ 1.497',
    plano: 'Avançado',
    implantacao: 'R$ 1.200, com 50% de desconto no contrato anual',
    empresaDesde: '2014',
    donoNome: 'Carlos',
  },
  porte: {
    caixasMin: 2,
    funcionariosMin: 8,
    texto: 'Segue a visita quem tiver dois caixas ou mais, oito funcionários ou mais, '
      + 'ou mais de um ponto. Abaixo disso, deixe o material e siga para a próxima.',
  },
  abertura: 'Oi, tudo bem? Meu nome é {{vendedorNome}}, eu trabalho com a {{empresaNome}}, '
    + 'empresa de tecnologia daqui de {{empresaCidade}}. A gente desenvolveu um sistema de gestão '
    + 'feito aqui, com implantação e suporte presencial. Ele cobre a loja inteira: caixa, nota '
    + 'fiscal, estoque, financeiro e cobrança. Eu não vim te vender nada agora, vim te fazer três '
    + 'perguntas rápidas e, se fizer sentido, te mostrar um vídeo de oito minutos. Posso?',
  perguntas: [
    {
      chave: 'controle',
      texto: 'Hoje, como o senhor controla as vendas e o estoque?',
      opcoes: [
        { id: 'caderno', rotulo: 'Caderno ou planilha', peso: 2, dor: 'controla venda e estoque no caderno ou na planilha' },
        { id: 'nacional', rotulo: 'Sistema nacional (Bling, Tiny)', peso: 1, dor: 'usa sistema de fora, sem ninguém por perto' },
        { id: 'local_antigo', rotulo: 'Sistema local antigo', peso: 1, dor: 'usa sistema local antigo que já não dá conta' },
        { id: 'atende', rotulo: 'Sistema que atende bem', peso: 0 },
      ],
    },
    {
      chave: 'suporte',
      texto: 'E quando dá problema ou o senhor tem dúvida, quem resolve?',
      nota: 'Se ele usa sistema de fora, aqui mora a dor. Deixe desabafar.',
      opcoes: [
        { id: 'chat', rotulo: 'Chat, tutorial, demora', peso: 2, dor: 'suporte por chat e tutorial, com demora para resolver' },
        { id: 'ninguem', rotulo: 'Ninguém resolve, se vira sozinho', peso: 2, dor: 'não tem a quem recorrer quando o sistema falha' },
        { id: 'rapido', rotulo: 'Resolvem rápido', peso: 0 },
      ],
    },
    {
      chave: 'nota',
      texto: 'O senhor emite nota em tudo? NFC-e no balcão, NF-e pra empresa?',
      nota: 'Quem não emite tem medo de fiscalização. Quem emite sofre com sistema travando.',
      opcoes: [
        { id: 'nao_emite', rotulo: 'Não emite tudo', peso: 2, dor: 'não emite nota em tudo, com risco de autuação' },
        { id: 'trava', rotulo: 'Emite, mas o sistema trava', peso: 1, dor: 'perde venda no balcão quando a emissão trava' },
        { id: 'tranquilo', rotulo: 'Emite sem problema', peso: 0 },
      ],
    },
    {
      chave: 'lucro',
      texto: 'Fim do mês, o senhor sabe de cabeça se lucrou? Ou só descobre quando o contador fala?',
      nota: 'Quase todo mundo responde que não sabe. Abre a cabeça para o financeiro e o DRE.',
      opcoes: [
        { id: 'nao_sabe', rotulo: 'Não sabe', peso: 1, dor: 'fecha o mês sem saber se lucrou' },
        { id: 'contador', rotulo: 'Só quando o contador fala', peso: 1, dor: 'só descobre o resultado quando o contador entrega' },
        { id: 'sabe', rotulo: 'Sabe, acompanha', peso: 0 },
      ],
    },
    {
      chave: 'cobranca',
      texto: 'Cliente devendo, quem cobra? O senhor mesmo?',
      nota: 'Cobrança automática por WhatsApp é o recurso que mais gera "isso existe?".',
      opcoes: [
        { id: 'ninguem', rotulo: 'Ninguém cobra', peso: 2, dor: 'cliente devendo sem ninguém cobrar' },
        { id: 'dono', rotulo: 'O próprio dono', peso: 1, dor: 'o dono para o que está fazendo para cobrar cliente' },
        { id: 'processo', rotulo: 'Tem processo de cobrança', peso: 0 },
      ],
    },
  ],
  video: {
    chamada: 'Pelo que o senhor me falou, vale muito a pena ver isso aqui. São oito minutos, '
      + 'mostra uma empresa igual a sua rodando no sistema. Pode ver comigo?',
    instrucao: 'Durante o vídeo, fique quieto. Só pause se ele comentar ou perguntar. '
      + 'Anote em qual parte ele reagiu.',
  },
  agendamento: {
    texto: 'O próximo passo é o seguinte: o {{donoNome}}, que é quem desenvolveu o sistema, faz uma '
      + 'apresentação de 30 minutos por videochamada, e ele cadastra os produtos daqui da sua loja '
      + 'no sistema, na sua frente. O senhor vê o seu negócio rodando nele antes de decidir '
      + 'qualquer coisa. Não paga nada por isso.',
    instrucao: 'Ofereça sempre dois horários, nunca "quando o senhor pode?". Agende na hora e '
      + 'mande o convite na frente dele.',
  },
  objecoes: [
    { chave: 'preco', rotulo: 'Tá caro / quanto custa',
      resposta: 'O plano que atende a sua operação é o {{plano}}, {{precoEntrada}} por mês, com 20% '
        + 'de desconto se for anual. Nele entra tudo: caixa com NFC-e, nota fiscal ilimitada, '
        + 'estoque, financeiro com DRE e apuração do Simples, conciliação do banco e cobrança '
        + 'automática. Quinze usuários, e até três CNPJs se o senhor tiver mais de uma empresa.\n\n'
        + 'Para comparar do jeito certo: quanto o senhor paga hoje somando o sistema, o contador, '
        + 'o tempo da equipe conferindo caixa e o que se perde em produto vencido e cliente que não '
        + 'pagou? Uma multa da SEFAZ por nota errada já passa de mil reais.\n\n'
        + 'E tem a parte que sistema de fora não faz: a gente migra os seus dados, treina sua '
        + 'equipe na loja e atende no WhatsApp com gente daqui. O preço final quem fecha é o '
        + '{{donoNome}} na conversa, porque depende do que o senhor vai usar.',
      regra: 'Nunca negociar preço, e nunca dizer "começa em": o plano de entrada não tem caixa.' },
    { chave: 'ja_uso', rotulo: 'Já uso Bling, Tiny ou outro',
      resposta: 'Ótimo, então o senhor já sabe o valor de ter sistema. Duas perguntas: quando trava, '
        + 'em quanto tempo resolvem? E o financeiro, o senhor fecha o mês dentro do sistema ou joga '
        + 'numa planilha depois? [ouvir] Pois é. O que a gente faz é a loja inteira num lugar só, '
        + 'com quem implanta na sua loja e atende do lado. A migração dos seus dados é por nossa conta.' },
    { chave: 'sem_tempo', rotulo: 'Não tenho tempo de mudar de sistema',
      resposta: 'Perfeito, e é por isso que a implantação é a gente que faz: migração de cadastro, '
        + 'produto e cliente. Sua equipe recebe treinamento na própria loja. O senhor não para a '
        + 'operação um dia sequer. Os 30 minutos com o {{donoNome}} não te comprometem com nada.' },
    { chave: 'sobrinho', rotulo: 'Meu sobrinho cuida da informática',
      resposta: 'Que bom que o senhor tem alguém. Ele pode participar da conversa inclusive, técnico '
        + 'gosta de conversar com técnico. Mas repare que aqui não é só instalação: é nota fiscal na '
        + 'SEFAZ, apuração de imposto, cobrança automática. É responsabilidade grande para deixar '
        + 'num arranjo informal.' },
    { chave: 'pensar', rotulo: 'Vou pensar / deixa o material',
      resposta: 'Claro, o material fica com o senhor. Só me diz uma coisa para eu não te encher a '
        + 'paciência à toa: o que exatamente o senhor precisa pensar? É o preço, é o momento, ou '
        + 'quer ver o sistema funcionando primeiro? [ouvir] Então é isso que a conversa com o '
        + '{{donoNome}} resolve, e não custa nada.',
      regra: 'Isolar a objeção real. "Vou pensar" quase sempre esconde uma das três.' },
    { chave: 'sistema_daqui', rotulo: 'Sistema daqui? E se vocês fecharem?',
      resposta: 'A {{empresaNome}} atende empresas da região desde {{empresaDesde}}. E olha o '
        + 'contrário: se o sistema de fora resolver mudar tudo ou dobrar o preço, para quem o senhor '
        + 'liga? Aqui o senhor liga para o dono. Seus dados são seus, ficam num banco só da sua '
        + 'empresa, e o senhor exporta tudo quando quiser. Isso fica em contrato.' },
    { chave: 'contador', rotulo: 'Meu contador resolve isso',
      resposta: 'Perfeito, e o seu contador vai gostar do sistema, porque ele recebe tudo pronto: '
        + 'notas organizadas e apuração do Simples calculada. Quer que a gente chame ele para a '
        + 'conversa também? Qual escritório cuida do senhor?',
      regra: 'Sempre anotar qual contador. Alimenta o mapa de parcerias com escritórios.' },
  ],
  metas: { visitas: 18, videos: 9, calls: 4, contadores: 10 },
};

function semear(tenant, forcar) {
  const arq = path.join(__dirname, '..', 'data', 'tenants', tenant, 'pncp.db');
  const db = new Database(arq);
  const problemas = validar(CONFIG);
  if (problemas.length) {
    console.error('Roteiro inválido:\n  ' + problemas.join('\n  '));
    process.exit(1);
  }
  // A tabela nasce na migration, que roda no boot do serviço. Rodar o semeador
  // antes do restart é o caminho comum de quem acabou de subir o código, e o
  // stack cru do SQLite não diz o que fazer.
  const temTabela = db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='roteiros'").get().n;
  if (!temTabela) {
    console.error(`Tenant ${tenant}: a tabela "roteiros" ainda não existe.\n`
      + 'Ela é criada na migration, no boot do consulta-licitacoes.service. '
      + 'Reinicie o serviço e rode de novo.');
    process.exit(1);
  }
  const existe = db.prepare("SELECT id FROM roteiros WHERE canal = 'visita' ORDER BY id LIMIT 1").get();
  if (existe && !forcar) {
    console.log(`Tenant ${tenant}: já existe roteiro de visita (#${existe.id}). Use --forcar para substituir.`);
    return;
  }
  const json = JSON.stringify(CONFIG);
  if (existe) {
    db.prepare(`UPDATE roteiros SET nome = ?, config = ?, corte = ?, padrao = 1, ativo = 1,
      dataAtualizacao = datetime('now') WHERE id = ?`)
      .run('Visita presencial — comércio', json, CONFIG.corte, existe.id);
    console.log(`Tenant ${tenant}: roteiro #${existe.id} substituído.`);
  } else {
    const r = db.prepare(`INSERT INTO roteiros (nome, canal, corte, padrao, config)
      VALUES (?, 'visita', ?, 1, ?)`).run('Visita presencial — comércio', CONFIG.corte, json);
    console.log(`Tenant ${tenant}: roteiro #${r.lastInsertRowid} criado.`);
  }
}

if (require.main === module) {
  const tenant = process.argv[2];
  if (!tenant) { console.error('Uso: node scripts/semear-roteiro-visita.js <tenant> [--forcar]'); process.exit(1); }
  semear(tenant, process.argv.includes('--forcar'));
}

module.exports = { CONFIG, semear };
