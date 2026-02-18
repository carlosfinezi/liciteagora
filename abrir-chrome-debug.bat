@echo off
echo Abrindo Chrome com depuracao remota...
echo.
echo IMPORTANTE: Faca login no gov.br/compras e acesse o cnetmobile
echo Depois, reinicie o servidor do PNCP para conectar ao Chrome logado.
echo.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.pncp-monitor-data" https://www.gov.br/compras/pt-br
