/**
 * Script para criar pacote de distribuição do PNCP Licitações
 * Cria uma pasta com tudo necessário para rodar em outra máquina
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const DIST_DIR = path.join(__dirname, 'dist');
const APP_DIR = path.join(DIST_DIR, 'pncp-licitacoes');

// Arquivos e pastas para copiar
const FILES_TO_COPY = [
    'server.js',
    'package.json',
    'package-lock.json'
];

const DIRS_TO_COPY = [
    'public',
    'node_modules'
];

// Arquivos para NÃO copiar (dados locais)
const EXCLUDE_FILES = [
    'pncp.db',
    'pncp.db-wal',
    'pncp.db-shm',
    '.env'
];

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyFileSync(src, dest) {
    const destDir = path.dirname(dest);
    ensureDir(destDir);
    fs.copyFileSync(src, dest);
}

function copyDirSync(src, dest) {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (EXCLUDE_FILES.includes(entry.name)) {
            continue;
        }

        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            copyFileSync(srcPath, destPath);
        }
    }
}

function createBatFile() {
    const batContent = `@echo off
title PNCP Licitacoes
cd /d "%~dp0"

echo ========================================
echo   PNCP Licitacoes - Sistema de Gestao
echo ========================================
echo.

REM Verificar se Node.js esta instalado
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] Node.js nao encontrado!
    echo.
    echo Por favor, instale o Node.js:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Verificar se node_modules existe
if not exist "node_modules" (
    echo Instalando dependencias...
    npm install
    echo.
)

echo Iniciando servidor...
echo.
echo Acesse: http://localhost:3000
echo.
echo Pressione Ctrl+C para encerrar
echo ========================================
echo.

node server.js

pause
`;

    fs.writeFileSync(path.join(APP_DIR, 'iniciar.bat'), batContent);
}

function createReadme() {
    const readmeContent = `# PNCP Licitações - Sistema de Gestão

## Requisitos
- Windows 10 ou superior
- Node.js 18+ (https://nodejs.org/)
- Google Chrome (para o robô de lances)

## Instalação

1. Instale o Node.js se ainda não tiver:
   https://nodejs.org/

2. Clique duas vezes em "iniciar.bat"

3. Na primeira execução, as dependências serão instaladas automaticamente

4. Acesse http://localhost:3000 no navegador

## Configuração Inicial

1. Acesse "Dados do Fornecedor" no menu lateral
2. Preencha seus dados (CNPJ, razão social)
3. Configure o Telegram para receber alertas
4. Configure as credenciais do gov.br para o monitoramento

## Funcionalidades

- 🔍 Busca de licitações no PNCP
- ⭐ Marcação de interesses
- 📝 Preparação de propostas
- 📋 Kanban de acompanhamento
- 📅 Agenda de licitações
- 🤖 Robô de lances automático
- 💬 Monitor de mensagens do pregoeiro
- 📄 Geração de PDF com assinatura digital

## Suporte

Em caso de problemas, verifique:
- Se o Node.js está instalado corretamente
- Se a porta 3000 não está em uso
- Se o Chrome está instalado (para o robô)

## Versão
1.0.0
`;

    fs.writeFileSync(path.join(APP_DIR, 'LEIA-ME.txt'), readmeContent);
}

function createInstallBat() {
    const installContent = `@echo off
title Instalador PNCP Licitacoes
cd /d "%~dp0"

echo ========================================
echo   Instalador PNCP Licitacoes
echo ========================================
echo.

REM Verificar Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Node.js nao encontrado. Abrindo pagina de download...
    start https://nodejs.org/
    echo.
    echo Apos instalar o Node.js, execute este instalador novamente.
    pause
    exit /b 1
)

echo Node.js encontrado:
node --version
echo.

echo Instalando dependencias (isso pode demorar alguns minutos)...
npm install

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERRO] Falha ao instalar dependencias!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Instalacao concluida com sucesso!
echo ========================================
echo.
echo Execute "iniciar.bat" para abrir o sistema.
echo.
pause
`;

    fs.writeFileSync(path.join(APP_DIR, 'instalar.bat'), installContent);
}

async function build() {
    console.log('========================================');
    console.log('  Build PNCP Licitações');
    console.log('========================================\n');

    // Limpar e criar diretório
    console.log('1. Preparando diretórios...');
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true });
    }
    ensureDir(APP_DIR);

    // Copiar arquivos
    console.log('2. Copiando arquivos...');
    for (const file of FILES_TO_COPY) {
        const src = path.join(__dirname, file);
        const dest = path.join(APP_DIR, file);
        if (fs.existsSync(src)) {
            copyFileSync(src, dest);
            console.log(`   ✓ ${file}`);
        }
    }

    // Copiar diretórios
    console.log('3. Copiando diretórios...');
    for (const dir of DIRS_TO_COPY) {
        const src = path.join(__dirname, dir);
        const dest = path.join(APP_DIR, dir);
        if (fs.existsSync(src)) {
            console.log(`   Copiando ${dir}...`);
            copyDirSync(src, dest);
            console.log(`   ✓ ${dir}`);
        }
    }

    // Criar arquivos auxiliares
    console.log('4. Criando scripts...');
    createBatFile();
    console.log('   ✓ iniciar.bat');
    createInstallBat();
    console.log('   ✓ instalar.bat');
    createReadme();
    console.log('   ✓ LEIA-ME.txt');

    // Calcular tamanho
    console.log('\n5. Finalizando...');

    console.log('\n========================================');
    console.log('  Build concluído!');
    console.log('========================================');
    console.log(`\nPasta de distribuição: ${APP_DIR}`);
    console.log('\nPara distribuir:');
    console.log('1. Compacte a pasta "pncp-licitacoes" em um .zip');
    console.log('2. Envie o .zip para o cliente');
    console.log('3. O cliente descompacta e executa "instalar.bat"');
}

build().catch(console.error);
