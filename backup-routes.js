// backup-routes.js
//
// Backup do banco e informação de versão do código.
//
// 2026-08-02 — três rotas foram REMOVIDAS por serem executáveis por qualquer
// usuário autenticado, de qualquer papel e de qualquer tenant:
//
//   POST /api/versao/tag       `git tag -a ${nome}` — nome vinha do corpo da
//   POST /api/versao/restaurar `git checkout ${tag}` — requisição e ia direto
//                              para o shell: injeção de comando no servidor
//                              compartilhado. E o checkout trocaria o código
//                              de TODOS os tenants.
//   POST /api/backup/restaurar path.join(backupsDir, arquivo) aceitava
//                              "../.." e copiava o arquivo escolhido por cima
//                              do banco do tenant.
//
// DELETE /api/backup/:arquivo tinha a mesma travessia de caminho e continua
// existindo (é a limpeza normal de backups): agora exige admin, valida o nome
// e confere que o caminho resolvido não saiu da pasta.
//
// Nenhuma tela chamava as três. Rollback de código e restauração de banco são
// operação de servidor (SSH), não de API voltada ao cliente.
//
// O que sobrou exige papel admin.

const fs = require('fs');
const { requireRole } = require('./auth');
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
  app.post('/api/backup/criar', requireRole(['admin']), async (req, res) => {
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
  app.get('/api/backup/listar', requireRole(['admin']), (req, res) => {
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

  // Excluir backup
  app.delete('/api/backup/:arquivo', requireRole(['admin']), (req, res) => {
    try {
      const { arquivo } = req.params;
      // O nome vem da URL: sem esta checagem, "..%2F..%2Falgo" saía da pasta
      // de backups e apagava arquivo do servidor.
      if (!/^[A-Za-z0-9._-]+$/.test(arquivo) || arquivo.includes('..')) {
        return res.status(400).json({ success: false, error: 'Nome de arquivo inválido' });
      }
      const caminhoBackup = path.join(backupsDir, arquivo);
      const caminhoMetadados = path.join(backupsDir, `${arquivo}.json`);
      // Cinto e suspensório: mesmo com o nome validado, confirma que o caminho
      // resolvido continua dentro da pasta de backups.
      if (!path.resolve(caminhoBackup).startsWith(path.resolve(backupsDir) + path.sep)) {
        return res.status(400).json({ success: false, error: 'Caminho fora da pasta de backups' });
      }

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
  app.get('/api/versao', requireRole(['admin']), async (req, res) => {
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
  app.get('/api/versao/tags', requireRole(['admin']), (req, res) => {
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

  // Restaurar código para uma versão/tag específica

  console.log('[Backup] Rotas registradas');
}

module.exports = { registrarRotasBackup };
