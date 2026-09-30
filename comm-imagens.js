/**
 * comm-imagens.js — as imagens de um modelo de mensagem.
 *
 * Desde 2026-09-28 o modelo tem um CONJUNTO de imagens, e cada envio sorteia
 * uma delas para mandar a mensagem como legenda, como a campanha legado sempre
 * fez com as dela. Variar a imagem ajuda a mensagem a não parecer disparo. Até
 * então o modelo tinha uma imagem só (`comm_templates.imagemPath`), e nenhum
 * modelo de nenhum tenant chegou a ter uma.
 *
 * Desde 2026-09-30 o conjunto aceita VÍDEO MP4 junto das imagens, a pedido, e o
 * sorteio é entre todos: um vídeo é um arquivo do conjunto como qualquer outro.
 *
 * As imagens ficam numa pasta por modelo, fora de public/: o WhatsApp recebe a
 * imagem lida do disco, então ela não precisa, nem deve, ficar exposta na web.
 * É a pasta que diz quais existem, sem tabela no banco, como no conjunto da
 * campanha legado (wa-campaign-images/<id>/).
 *
 * Usado pelo disparo das campanhas novas (comm-routes.js) e pelo da campanha
 * legado (wa-campaigns-routes.js), para os dois sortearem do mesmo jeito.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_IMAGENS = 20;
// O prefixo continua `img-` nos vídeos: é o nome dos arquivos que já estão no
// disco, e trocá-lo obrigaria a aceitar dois padrões para sempre.
const NOME_VALIDO = /^img-\d+-\d+\.(jpg|png|webp|gif|mp4)$/;
/**
 * O teto do vídeo. Não é o do WhatsApp: o envio daqui passa pela Evolution, que
 * fala o protocolo do WhatsApp Web, e ali o limite de 16 MB da API oficial não
 * vale. O que limita é o caminho: o arquivo vai em base64 dentro do JSON (+33%)
 * e a Evolution aceita corpo de até 136 MB, o que dá cerca de 100 MB de arquivo.
 * 64 MB fica com folga dos dois lados e cabe qualquer anúncio de campanha, sem
 * pôr 130 MB de string na memória do servidor a cada envio.
 */
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;

// Raiz das pastas. É propriedade, e não constante, para as suítes apontarem
// para /tmp: nenhuma suíte grava em data/ (scripts/guarda-dados.js).
const modulo = {
  raiz: path.join(__dirname, 'data', 'tenants'),
};

function pastaDoModelo(slug, modeloId) {
  return path.join(modulo.raiz, String(slug || 'default'), 'comm-imagens', 'modelo-' + Number(modeloId));
}

/** Os nomes dos arquivos, na ordem em que foram enviados. */
function listar(slug, modeloId) {
  try {
    return fs.readdirSync(pastaDoModelo(slug, modeloId)).filter(f => NOME_VALIDO.test(f)).sort();
  } catch (_) { return []; }
}

/** Caminho no disco de uma imagem, ou null se o nome não for de uma delas. */
function caminho(slug, modeloId, nome) {
  const n = path.basename(String(nome || ''));
  if (!NOME_VALIDO.test(n)) return null;
  const c = path.join(pastaDoModelo(slug, modeloId), n);
  return fs.existsSync(c) ? c : null;
}

/** Uma imagem do conjunto, sorteada a cada chamada; null sem imagem. */
function sortear(slug, modeloId) {
  const imgs = listar(slug, modeloId);
  if (!imgs.length) return null;
  return path.join(pastaDoModelo(slug, modeloId), imgs[Math.floor(Math.random() * imgs.length)]);
}

/**
 * Vídeo MP4 pela caixa `ftyp`, que começa no 5º byte. O brand que vem depois
 * dela é o que separa o MP4 do MOV do iPhone (`qt  `), que tem a mesma caixa
 * e não é aceito: o WhatsApp recebe o arquivo como `video/mp4`, e um MOV
 * chegaria quebrado para quem abrisse.
 */
function pareceVideo(buf) {
  return !!buf && buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp';
}

/**
 * Os brands da família MP4 que NÃO são vídeo, e só eles. A regra é por recusa, e
 * não por lista de aceitação: cada editor grava o seu brand (`isom`, `mp42`,
 * `MSNV`, `avc1`, `iso8`…), e uma lista de aceitos barraria vídeo legítimo
 * exportado por um programa que ninguém previu. `qt  ` é o MOV do iPhone, e os
 * `M4A`/`M4B`/`M4P` são áudio com a mesma caixa.
 */
const BRANDS_NAO_VIDEO = /^(qt {2}|M4A |M4B |M4P )$/;

/** Tipo pela assinatura do arquivo, e não pela extensão que o nome diz. */
function tipoReal(buf) {
  const imagem = require('./produto-imagens').tipoReal(buf);
  if (imagem) return imagem;
  return pareceVideo(buf) && !BRANDS_NAO_VIDEO.test(buf.slice(8, 12).toString('ascii')) ? '.mp4' : null;
}

/** Grava uma imagem ou um vídeo no conjunto. Devolve o nome, ou lança o motivo. */
function adicionar(slug, modeloId, buffer) {
  if (!buffer || !buffer.length) throw new Error('Envie o arquivo');
  const ext = tipoReal(buffer);
  if (!ext) {
    const marca = pareceVideo(buffer) ? buffer.slice(8, 12).toString('ascii').trim() : '';
    throw new Error(marca
      ? `Este arquivo é ${marca}, e não um vídeo MP4. Converta para MP4 e envie de novo`
      : 'O arquivo não é uma imagem JPEG, PNG, WEBP ou GIF, nem um vídeo MP4');
  }
  // Acima do teto o envio falharia contato por contato, na resposta da
  // Evolution. Barrar aqui diz o tamanho uma vez, a quem está enviando.
  if (ext === '.mp4' && buffer.length > MAX_VIDEO_BYTES) {
    // Para cima, e não arredondado: com 64 MB e um byte, "64.0 MB" contra um
    // limite de 64 MB pareceria recusa sem motivo.
    throw new Error(`O vídeo tem ${(Math.ceil(buffer.length / 104857.6) / 10).toFixed(1)} MB; `
      + `o limite é ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB`);
  }
  if (listar(slug, modeloId).length >= MAX_IMAGENS) {
    throw new Error(`O modelo já tem ${MAX_IMAGENS} arquivos, o máximo`);
  }
  const dir = pastaDoModelo(slug, modeloId);
  fs.mkdirSync(dir, { recursive: true });
  const nome = `img-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
  fs.writeFileSync(path.join(dir, nome), buffer);
  return nome;
}

function remover(slug, modeloId, nome) {
  const c = caminho(slug, modeloId, nome);
  if (c) fs.unlinkSync(c);
  return !!c;
}

module.exports = Object.assign(modulo, { MAX_IMAGENS, MAX_VIDEO_BYTES, pastaDoModelo, listar, caminho,
                                         sortear, adicionar, remover });
