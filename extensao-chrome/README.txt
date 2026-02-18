============================================
  MONITOR COMPRASNET - EXTENSAO CHROME
============================================

Esta extensao captura automaticamente as mensagens
de licitacoes do Comprasnet e envia para o servidor local.

--------------------------------------------
  COMO INSTALAR
--------------------------------------------

1. Abra o Chrome
2. Digite na barra de endereco: chrome://extensions
3. Ative o "Modo do desenvolvedor" (canto superior direito)
4. Clique em "Carregar sem compactacao"
5. Selecione a pasta: C:\Users\User\pncp-licitacoes\extensao-chrome
6. A extensao aparecera na barra de extensoes do Chrome

--------------------------------------------
  COMO USAR
--------------------------------------------

1. Certifique-se que o servidor esta rodando (node server.js)
2. Acesse o Comprasnet normalmente no Chrome
3. Faca login com seu certificado digital
4. Navegue ate uma licitacao
5. Clique no icone de mensagens (envelope)
6. As mensagens serao capturadas automaticamente!

--------------------------------------------
  FUNCIONALIDADES
--------------------------------------------

- Captura automatica: Quando voce abre o painel de
  mensagens no Comprasnet, a extensao captura tudo.

- Captura manual: Clique no icone da extensao e
  depois em "Capturar Mensagens Agora"

- Status em tempo real: O icone mostra se o servidor
  esta online e quantas mensagens foram capturadas.

- Notificacoes: Receba alertas quando novas mensagens
  importantes forem detectadas.

--------------------------------------------
  REQUISITOS
--------------------------------------------

- Servidor rodando em http://localhost:3000
- Chrome versao 88 ou superior
- Acesso ao Comprasnet com certificado digital

--------------------------------------------
  SUPORTE
--------------------------------------------

Se o icone mostrar "!" vermelho, significa que o
servidor nao esta rodando. Inicie o servidor:

  cd C:\Users\User\pncp-licitacoes
  node server.js

============================================
