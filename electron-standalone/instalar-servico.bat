@echo off
echo ============================================
echo  LiciteAgora Electron - Instalar Auto-Start
echo ============================================
echo.

:: Criar tarefa agendada que inicia com login do usuario (minimizado)
schtasks /create /tn "LiciteAgora Electron" /tr "\"C:\win-unpacked\LiciteAgora Browser.exe\" --minimized" /sc onlogon /rl highest /f

if %errorlevel% equ 0 (
    echo.
    echo [OK] Tarefa criada com sucesso!
    echo.
    echo O Electron vai iniciar MINIMIZADO automaticamente no login.
    echo Ele faz login, captura Bearer, e sincroniza com o servidor.
    echo.
    echo Comandos uteis:
    echo   Iniciar agora:  schtasks /run /tn "LiciteAgora Electron"
    echo   Remover:        schtasks /delete /tn "LiciteAgora Electron" /f
    echo   Status:         curl.exe http://localhost:9500/status
) else (
    echo.
    echo [ERRO] Falha ao criar tarefa. Execute este .bat como Administrador.
)

echo.
pause
