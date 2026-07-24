// backup-routes.js
//
// Sistema de backup do banco SQLite (cópia + metadados JSON + restore) e
// versionamento via Git (info do HEAD, listar/criar/restaurar tags).
// Extraído de server.js em NFSE-M06 onda 6.4.
//
// Dependências externas: fs, path, child_process (Node built-ins) +
// Express (app) + better-sqlite3 (db). dbPath e PORT chegam via options
// para preservar a semântica original 1:1 — o backup precisa do caminho
// do arquivo do banco; /api/versao expõe a porta no retorno JSON.
//
// __dirname aqui aponta para o mesmo diretório onde server.js vive
// (layout flat em /home/carlosfinezi/web/liciteagora.com.br/private/),
// então git rev-parse etc. operam no mesmo repo que antes.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Fase 3g (2026-05-23): stats catalog via PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

async function _catalogStats() {
  if (USE_PG) {
    // COUNT(*) exato em `itens` (18M+ linhas) estoura o statement_timeout de 30s.
    // São números de display: usar estimativa de pg_class.reltuples (instantâneo).
    const est = await catalogPg.queryOne(
      `SELECT
         (SELECT reltuples::bigint FROM pg_class WHERE oid = 'licitacoes'::regclass) AS lic,
         (SELECT reltuples::bigint FROM pg_class WHERE oid = 'itens'::regclass) AS itens`
    );
    return { licitacoes: Number(est?.lic || 0), itens: Number(est?.itens || 0) };
  }
  return null;
}

function registrarRotasBackup(app, db, { dbPath, PORT }) {
  const backupsDir = path.join(__dirname, 'backups');

  // Garantir que diretório de backups existe
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  // Criar backup do banco de dados
  app.post('/api/backup/criar', async (req, res) => {
    try {
      const { descricao } = req.body;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const nomeArquivo = `pncp-backup-${timestamp}.db`;
      const caminhoBackup = path.join(backupsDir, nomeArquivo);

      // Copiar banco de dados
      fs.copyFileSync(dbPath, caminhoBackup);

      // Salvar metadados do backup
      const metadados = {
        arquivo: nomeArquivo,
        descricao: descricao || 'Backup manual',
        dataHora: new Date().toISOString(),
        tamanho: fs.statSync(caminhoBackup).size,
        stats: await (async () => {
          const catStats = USE_PG ? await _catalogStats() : null;
          return {
            licitacoes: catStats ? catStats.licitacoes : db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
            itens: catStats ? catStats.itens : db.prepare('SELECT COUNT(*) as count FROM itens').get().count,
            interesses: db.prepare('SELECT COUNT(*) as count FROM interesses').get().count
          };
        })()
      };

      const metadadosPath = path.join(backupsDir, `${nomeArquivo}.json`);
      fs.writeFileSync(metadadosPath, JSON.stringify(metadados, null, 2));

      console.log(`[Backup] Criado: ${nomeArquivo} (${(metadados.tamanho / 1024 / 1024).toFixed(2)} MB)`);
      res.json({ success: true, backup: metadados });
    } catch (error) {
      console.error('[Backup] Erro ao criar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar backups disponíveis
  app.get('/api/backup/listar', (req, res) => {
    try {
      const arquivos = fs.readdirSync(backupsDir)
        .filter(f => f.endsWith('.db'))
        .map(arquivo => {
          const metadadosPath = path.join(backupsDir, `${arquivo}.json`);
          let metadados = { arquivo, descricao: 'Sem descrição', dataHora: null, tamanho: 0 };

          if (fs.existsSync(metadadosPath)) {
            metadados = JSON.parse(fs.readFileSync(metadadosPath, 'utf8'));
          } else {
            const stats = fs.statSync(path.join(backupsDir, arquivo));
            metadados.tamanho = stats.size;
            metadados.dataHora = stats.mtime.toISOString();
          }

          return metadados;
        })
        .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));

      res.json({ success: true, backups: arquivos });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Restaurar backup
  app.post('/api/backup/restaurar', (req, res) => {
    try {
      const { arquivo } = req.body;

      if (!arquivo) {
        return res.status(400).json({ success: false, error: 'Nome do arquivo é obrigatório' });
      }

      const caminhoBackup = path.join(backupsDir, arquivo);

      if (!fs.existsSync(caminhoBackup)) {
        return res.status(404).json({ success: false, error: 'Backup não encontrado' });
      }

      // Criar backup do estado atual antes de restaurar
      const timestampAtual = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupAtual = path.join(backupsDir, `pncp-pre-restore-${timestampAtual}.db`);
      fs.copyFileSync(dbPath, backupAtual);

      // Fechar conexão com banco atual
      db.close();

      // Restaurar backup
      fs.copyFileSync(caminhoBackup, dbPath);

      console.log(`[Backup] Restaurado: ${arquivo}`);
      console.log(`[Backup] Estado anterior salvo em: pncp-pre-restore-${timestampAtual}.db`);

      res.json({
        success: true,
        message: 'Backup restaurado. Reinicie o servidor para aplicar as mudanças.',
        backupAnterior: `pncp-pre-restore-${timestampAtual}.db`
      });
    } catch (error) {
      console.error('[Backup] Erro ao restaurar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Excluir backup
  app.delete('/api/backup/:arquivo', (req, res) => {
    try {
      const { arquivo } = req.params;
      const caminhoBackup = path.join(backupsDir, arquivo);
      const caminhoMetadados = path.join(backupsDir, `${arquivo}.json`);

      if (!fs.existsSync(caminhoBackup)) {
        return res.status(404).json({ success: false, error: 'Backup não encontrado' });
      }

      fs.unlinkSync(caminhoBackup);
      if (fs.existsSync(caminhoMetadados)) {
        fs.unlinkSync(caminhoMetadados);
      }

      console.log(`[Backup] Excluído: ${arquivo}`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Obter informações de versão do Git
  app.get('/api/versao', async (req, res) => {
    try {
      let gitInfo = { disponivel: false };

      try {
        const commitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
        const commitMsg = execSync('git log -1 --format=%s', { cwd: __dirname, encoding: 'utf8' }).trim();
        const commitDate = execSync('git log -1 --format=%ci', { cwd: __dirname, encoding: 'utf8' }).trim();
        const branch = execSync('git branch --show-current', { cwd: __dirname, encoding: 'utf8' }).trim();
        const tags = execSync('git tag --points-at HEAD', { cwd: __dirname, encoding: 'utf8' }).trim().split('\n').filter(t => t);

        gitInfo = {
          disponivel: true,
          commit: commitHash,
          mensagem: commitMsg,
          data: commitDate,
          branch,
          tags,
          versao: tags.length > 0 ? tags[0] : `dev-${commitHash}`
        };
      } catch (e) {
        // Git não disponível ou não é um repositório
      }

      const catStats = USE_PG ? await _catalogStats() : null;
      const stats = {
        licitacoes: catStats ? catStats.licitacoes : db.prepare('SELECT COUNT(*) as count FROM licitacoes').get().count,
        itens: catStats ? catStats.itens : db.prepare('SELECT COUNT(*) as count FROM itens').get().count,
        interesses: db.prepare('SELECT COUNT(*) as count FROM interesses').get().count
      };

      res.json({
        success: true,
        sistema: 'PNCP Licitações',
        git: gitInfo,
        banco: stats,
        servidor: {
          porta: PORT,
          uptime: process.uptime(),
          memoria: process.memoryUsage()
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar tags/versões do Git
  app.get('/api/versao/tags', (req, res) => {
    try {
      const tagsOutput = execSync('git tag -l --sort=-version:refname', { cwd: __dirname, encoding: 'utf8' });
      const tags = tagsOutput.trim().split('\n').filter(t => t).map(tag => {
        let info = { nome: tag };
        try {
          const commitInfo = execSync(`git log -1 --format="%h|%ci|%s" ${tag}`, { cwd: __dirname, encoding: 'utf8' }).trim();
          const [hash, data, mensagem] = commitInfo.split('|');
          info = { nome: tag, commit: hash, data, mensagem };
        } catch (e) {}
        return info;
      });

      res.json({ success: true, tags });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Criar nova tag/versão
  app.post('/api/versao/tag', (req, res) => {
    try {
      const { nome, descricao } = req.body;

      if (!nome) {
        return res.status(400).json({ success: false, error: 'Nome da tag é obrigatório' });
      }

      // Verificar se há alterações não commitadas
      const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8' }).trim();
      if (status) {
        return res.status(400).json({
          success: false,
          error: 'Existem alterações não commitadas. Faça commit antes de criar uma tag.'
        });
      }

      execSync(`git tag -a ${nome} -m "${descricao || nome}"`, { cwd: __dirname, encoding: 'utf8' });
      console.log(`[Versão] Tag criada: ${nome}`);

      res.json({ success: true, tag: nome });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Restaurar código para uma versão/tag específica
  app.post('/api/versao/restaurar', (req, res) => {
    try {
      const { tag } = req.body;

      if (!tag) {
        return res.status(400).json({ success: false, error: 'Tag é obrigatória' });
      }

      // Verificar se há alterações não commitadas
      const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf8' }).trim();
      if (status) {
        return res.status(400).json({
          success: false,
          error: 'Existem alterações não commitadas. Faça commit ou descarte antes de restaurar.'
        });
      }

      execSync(`git checkout ${tag}`, { cwd: __dirname, encoding: 'utf8' });
      console.log(`[Versão] Código restaurado para: ${tag}`);

      res.json({
        success: true,
        message: `Código restaurado para ${tag}. Reinicie o servidor para aplicar.`
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Backup] Rotas registradas');
}

module.exports = { registrarRotasBackup };
