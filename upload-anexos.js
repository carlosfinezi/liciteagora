/**
 * upload-anexos.js — o que todo endpoint de anexo precisa fazer igual.
 *
 * Cada módulo (CP, CR, OS, pessoas, contratos) monta o próprio multer, com
 * pasta, tamanho e extensões que fazem sentido para ele. O que NÃO deve
 * divergir é o tratamento do erro, e era justamente aí que os cinco diferiam:
 * o erro do multer subia como erro de middleware, o Express devolvia 500 com
 * uma página HTML de stack, e a tela mostrava "Internal Server Error" no lugar
 * de "Apenas PDF ou imagens".
 *
 * Uso:
 *   const { comTratamentoDeErro } = require('./upload-anexos');
 *   app.post('/rota', comTratamentoDeErro(upload.single('arquivo')),
 *            reentrarContextoTenant, handler)
 *
 * O `reentrarContextoTenant` continua sendo responsabilidade de quem registra
 * a rota — ele mora em tenant-middleware.js e vale para qualquer middleware
 * que leia o corpo por stream, não só upload.
 */

/**
 * Envolve o middleware do multer e converte o erro em resposta JSON:
 *   - limite de tamanho / de quantidade / extensão barrada → 400 com o motivo
 *   - falha de disco (EACCES, ENOSPC…)                     → 500 genérico,
 *     com o código real no log — o usuário não tem o que fazer com "EACCES",
 *     e o caminho do servidor não deve vazar para a tela.
 */
function comTratamentoDeErro(middlewareMulter, { rotulo = 'upload', limiteMb, maxArquivos } = {}) {
  return function (req, res, next) {
    middlewareMulter(req, res, (err) => {
      if (!err) return next();

      if (err.code === 'LIMIT_FILE_SIZE') {
        // O limite vem de quem montou o multer; sem ele a mensagem fica
        // genérica, que é pior mas não erra o número.
        return res.status(400).json({ success: false,
          error: limiteMb ? `Arquivo maior que ${limiteMb} MB` : 'Arquivo maior que o limite permitido' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ success: false,
          error: maxArquivos ? `No máximo ${maxArquivos} arquivos por vez` : 'Arquivos demais neste envio' });
      }
      // Erro do fileFilter chega sem `code` e com a mensagem já escrita para
      // quem está olhando a tela.
      if (!err.code) {
        return res.status(400).json({ success: false, error: err.message });
      }
      console.error(`[${rotulo}] falha ao gravar anexo:`, err.code, err.message);
      return res.status(500).json({ success: false, error: 'Não foi possível gravar o arquivo no servidor' });
    });
  };
}

/**
 * Nome original do arquivo em UTF-8.
 *
 * O busboy (dentro do multer) decodifica o nome do arquivo como latin1 quando
 * o multipart não declara charset — que é o caso de todo navegador. Resultado:
 * "Autorização.pdf" chega como "AutorizaÃ§Ã£o.pdf" e é assim que fica gravado
 * no banco e exibido na tela.
 *
 * A volta é reinterpretar os bytes como UTF-8. Só aceita o resultado se ele
 * for válido: nome que já veio correto (ou que é ASCII puro) passa intacto,
 * porque reconverter destruiria o que estava certo.
 */
function nomeOriginalUtf8(originalname) {
  const nome = String(originalname || '');
  // Sem byte alto não há o que reinterpretar.
  if (!/[-ÿ]/.test(nome)) return nome;
  try {
    const convertido = Buffer.from(nome, 'latin1').toString('utf8');
    // U+FFFD = a conversão não fazia sentido; o nome já estava em UTF-8.
    if (convertido.includes('�')) return nome;
    return convertido;
  } catch (_) {
    return nome;
  }
}

module.exports = { comTratamentoDeErro, nomeOriginalUtf8 };
