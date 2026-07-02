; installer.nsh — hooks customizados do NSIS para LiciteAgora Browser
;
; Objetivo: garantir que o app suba sozinho após reboot do Windows
; (Task Scheduler /sc onlogon) e seja removido na desinstalação.
;
; Nome da task: "LiciteAgora Browser" (mesmo nome do produto, sem espaços
; em variável NSIS para evitar quebra de quoting). Roda com privilégios
; elevados (/rl highest) e o usuário corrente no logon.
;
; Trigger: ${INSTALLER_PRODUCT_NAME} é "LiciteAgora Browser" (de
; productName). $INSTDIR é o diretório escolhido pelo usuário (default
; C:\Program Files\LiciteAgora Browser\).
;
; A flag --minimized faz o app subir só no system tray (sem janela
; visível) — usuário expande pela bandeja quando precisar.

!macro customInstall
  DetailPrint "Registrando inicialização automática (Task Scheduler)..."

  ; Remove qualquer task antiga antes de criar (idempotente em upgrades)
  nsExec::ExecToLog 'schtasks /Delete /TN "LiciteAgora Browser" /F'
  Pop $0

  ; Cria task que dispara no logon do usuário corrente, executando
  ; o exe instalado com --minimized (vai pra tray sem janela visível).
  ; /RL LIMITED (não-elevado): instalação per-user (%LOCALAPPDATA%) não tem
  ; admin pra criar task HIGHEST, e o app não precisa de elevação (o dir de
  ; instalação já é gravável pelo usuário — auto-update silencioso sem UAC).
  nsExec::ExecToLog 'schtasks /Create /TN "LiciteAgora Browser" /TR "\"$INSTDIR\LiciteAgora Browser.exe\" --minimized" /SC ONLOGON /RL LIMITED /F'
  Pop $0
  ${If} $0 == 0
    DetailPrint "[OK] Task Scheduler configurado — app sobe automaticamente após reboot."
  ${Else}
    DetailPrint "[AVISO] Falha ao criar Task Scheduler (codigo $0). App ainda pode ser iniciado manualmente."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removendo Task Scheduler do LiciteAgora Browser..."
  nsExec::ExecToLog 'schtasks /Delete /TN "LiciteAgora Browser" /F'
  Pop $0
!macroend
