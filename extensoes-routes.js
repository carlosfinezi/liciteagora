// extensoes-routes.js
//
// Delivery de extensões de browser hospedadas no servidor (hoje só a
// token-relay do Comprasnet). Extraído de server.js em NFSE-M06 onda 6.20.
//
// Escopo: 2 rotas + 3 helpers + 1 mapa estático:
//   GET  /api/extensoes                lista extensões disponíveis com
//                                       versão lida do manifest.json.
//   GET  /api/extensoes/:slug/download gera zip dinâmico da extensão:
//                                       (a) copia o diretório para /tmp,
//                                       (b) substitui placeholder
//                                       `__SERVER_URL__` por server_url
//                                       configurado (fallback para
//                                       auto-detecção via req.protocol+host),
//                                       (c) empacota com `zip -r` (spawn),
//                                       (d) res.download() e limpeza.
//
//   copiarDiretorioSync(src, dest)       fs recursivo manual (sem deps
//                                        extras além do fs core).
//   removerDiretorioSync(dir)            fs.rmSync com recursive+force.
//   substituirPlaceholders(dir, url)     walk recursivo editando só
//                                        .js/.json/.html que contenham
//                                        a string `__SERVER_URL__`.
//
// MAPA estático extensoesDisponiveis: para adicionar uma nova extensão
// basta adicionar uma entrada `{ dir, nome, descricao }` — o frontend
// pega `slug` do Object.keys().
//
// DEPENDÊNCIAS:
//   - fs, path, os        core
//   - child_process.spawn para rodar `zip -r` (executável do SO,
//                          não é lib npm — requer `zip` instalado, o
//                          que o server.votoaqui.com.br já tem).
//   - opts.getConfigValue(k) para ler server_url (mesmo helper de
//                          admin-routes/analise-ia-routes).
//
// SEGURANÇA: :slug é validado contra o mapa estático extensoesDisponiveis
// antes de qualquer uso em path — não há risco de path traversal.
// O `zip` é spawned com cwd controlado e args literais (não shell).
//
// __dirname aqui resolve para o mesmo diretório de server.js (ambos
// residem no mesmo path de instalação), então `path.join(__dirname,
// ext.dir)` encontra `extensions/token-relay/` corretamente.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Mapa das extensões disponíveis
const extensoesDisponiveis = {
  'token-relay': {
    dir: 'extensions/token-relay',
    nome: 'Licite Agora Token Relay',
    descricao: 'Captura tokens e sincroniza dados do Comprasnet automaticamente'
  }
};

// Copia diretório recursivamente
function copiarDiretorioSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copiarDiretorioSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Remove diretório recursivamente
function removerDiretorioSync(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Substitui placeholders nos arquivos da extensão
function substituirPlaceholders(dir, serverUrl) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      substituirPlaceholders(filePath, serverUrl);
    } else if (/\.(js|json|html)$/.test(entry.name)) {
      let conteudo = fs.readFileSync(filePath, 'utf-8');
      if (conteudo.includes('__SERVER_URL__')) {
        conteudo = conteudo.replace(/__SERVER_URL__/g, serverUrl);
        fs.writeFileSync(filePath, conteudo, 'utf-8');
      }
    }
  }
}

function registrarRotasExtensoes(app, { getConfigValue }) {
  if (!getConfigValue) {
    throw new Error('extensoes-routes: getConfigValue é obrigatório');
  }

  // Listar extensões disponíveis
  app.get('/api/extensoes', (req, res) => {
    try {
      const lista = Object.entries(extensoesDisponiveis).map(([slug, ext]) => {
        const manifestPath = path.join(__dirname, ext.dir, 'manifest.json');
        let versao = '-';
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          versao = manifest.version || '-';
        } catch (e) {}
        return { slug, nome: ext.nome, descricao: ext.descricao, versao };
      });
      res.json({ success: true, extensoes: lista });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Download de extensão como ZIP
  app.get('/api/extensoes/:slug/download', (req, res) => {
    const ext = extensoesDisponiveis[req.params.slug];
    if (!ext) {
      return res.status(404).json({ success: false, error: 'Extensão não encontrada' });
    }

    const extDir = path.join(__dirname, ext.dir);
    if (!fs.existsSync(extDir)) {
      return res.status(404).json({ success: false, error: 'Diretório da extensão não encontrado' });
    }

    // Obter URL do servidor configurada (fallback para auto-detecção)
    const serverUrl = getConfigValue('server_url') || (req.protocol + '://' + req.get('host'));

    // Copiar para diretório temporário e substituir placeholders
    const tmpDir = path.join(os.tmpdir(), `extensao-${Date.now()}-${ext.dir}`);
    const zipFileName = `${ext.dir}.zip`;
    const tmpZipPath = path.join(os.tmpdir(), `extensao-${Date.now()}-${zipFileName}`);

    try {
      copiarDiretorioSync(extDir, tmpDir);
      substituirPlaceholders(tmpDir, serverUrl);
    } catch (err) {
      console.error('Erro ao preparar extensão:', err);
      removerDiretorioSync(tmpDir);
      return res.status(500).json({ success: false, error: 'Erro ao preparar extensão para download' });
    }

    // Gerar zip em arquivo temporário para garantir Content-Length correto
    const zipProcess = spawn('zip', ['-r', tmpZipPath, '.'], {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    zipProcess.on('close', (code) => {
      // Limpar diretório temporário
      removerDiretorioSync(tmpDir);

      if (code !== 0) {
        try { fs.unlinkSync(tmpZipPath); } catch (e) {}
        return res.status(500).json({ success: false, error: 'Erro ao gerar arquivo zip' });
      }

      res.download(tmpZipPath, zipFileName, (err) => {
        // Limpar arquivo zip temporário após envio
        try { fs.unlinkSync(tmpZipPath); } catch (e) {}
        if (err && !res.headersSent) {
          res.status(500).json({ success: false, error: 'Erro ao enviar arquivo' });
        }
      });
    });

    zipProcess.on('error', (err) => {
      console.error('Erro ao gerar zip:', err);
      removerDiretorioSync(tmpDir);
      try { fs.unlinkSync(tmpZipPath); } catch (e) {}
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Erro ao gerar arquivo zip' });
      }
    });
  });

  console.log('[Extensoes] Rotas registradas');
}

module.exports = { registrarRotasExtensoes };
