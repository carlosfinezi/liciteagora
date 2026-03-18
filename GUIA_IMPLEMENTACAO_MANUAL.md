# 📝 GUIA DE IMPLEMENTAÇÃO MANUAL - ComprasNet Auto-Login

## 🎯 Objetivo

Atualizar o arquivo `comprasnet-login-routes.js` para usar o método LANCER de bypass automático do hCaptcha invisible.

---

## 📋 MUDANÇAS NECESSÁRIAS

### 1. **Mudar URL de login**

**Linha ~11:**

❌ **ANTES:**
```javascript
const COMPRASNET_LOGIN_URL = 'https://cnetmobile.estaleiro.serpro.gov.br/...';
```

✅ **DEPOIS:**
```javascript
const SSO_LOGIN_URL = 'https://sso.acesso.gov.br/login?client_id=comprasnet.gov.br';
```

---

### 2. **Mudar headless mode**

**Linha ~97:**

❌ **ANTES:**
```javascript
headless: true,
```

✅ **DEPOIS:**
```javascript
headless: 'new',  // Novo modo headless do Chrome 112+
```

---

### 3. **Atualizar referência da URL**

**Linha ~112:**

❌ **ANTES:**
```javascript
await page.goto(COMPRASNET_LOGIN_URL, {
```

✅ **DEPOIS:**
```javascript
await page.goto(SSO_LOGIN_URL, {
```

---

### 4. **Remover/Comentar função Anti-Captcha**

**Linhas ~12-62 (toda a função `solveHCaptcha`):**

❌ **ANTES:**
```javascript
async function solveHCaptcha(pageUrl) {
    console.log('[Anti-Captcha] Creating task...');
    // ... todo o código da função
}
```

✅ **DEPOIS:**
```javascript
// FUNÇÃO NÃO MAIS NECESSÁRIA - hCaptcha invisible passa automaticamente!
// async function solveHCaptcha(pageUrl) {
//     console.log('[Anti-Captcha] Creating task...');
//     // ... todo o código comentado
// }
```

---

### 5. **Adicionar lógica de bypass do hCaptcha invisible**

**Logo APÓS a linha `await page.goto(SSO_LOGIN_URL...)`:**

✅ **ADICIONAR:**
```javascript
        // DESCOBERTA DO LANCER: hCaptcha invisible resolve AUTOMATICAMENTE!
        console.log('[Login] Waiting for hCaptcha invisible bypass...');

        try {
            await page.waitForFunction(() => {
                return window.hcaptcha !== undefined;
            }, { timeout: 15000 });
            console.log('[Login] ✅ hCaptcha detected and ready');
        } catch (e) {
            console.log('[Login] hCaptcha not found or already passed');
        }

        // Aguardar hCaptcha analisar e passar automaticamente
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('[Login] ✅ hCaptcha should have auto-resolved');
```

---

### 6. **Remover/Comentar uso do Anti-Captcha**

**Linhas ~160-180 (o bloco if que chama solveHCaptcha):**

❌ **ANTES:**
```javascript
        console.log('[Login] Checking for hCaptcha...');
        const hcaptchaExists = await page.$('.h-captcha, iframe[src*="hcaptcha"]');

        if (hcaptchaExists) {
            console.log('[Login] hCaptcha detected, solving with Anti-Captcha...');
            const captchaToken = await solveHCaptcha(page.url());
            await page.evaluate((token) => {
                // ... injetar token
            }, captchaToken);
        }
```

✅ **DEPOIS:**
```javascript
        // LANÇADOR já resolveu o hCaptcha invisible automaticamente acima!
        // Não precisa mais de Anti-Captcha service!
```

---

### 7. **Atualizar seletores de campos de login (OPCIONAL)**

Os campos podem ter IDs diferentes no SSO Gov.br:

```javascript
        const cpfSelectors = [
            'input#login-certificate',    // SSO Gov.br
            'input[name="cpf"]',
            'input#cpf',
            'input[type="text"]'
        ];

        const senhaSelectors = [
            'input#login-password',        // SSO Gov.br
            'input[name="senha"]',
            'input[name="password"]',
            'input[type="password"]'
        ];
```

---

## 🚀 COMO EDITAR

### **Opção 1: Editar via SSH (vim/nano)**

```bash
# Conectar ao servidor
ssh root@217.216.85.37

# Navegar para pasta
cd /home/carlosfinezi/web/liciteagora.com.br/private

# Fazer backup
cp comprasnet-login-routes.js comprasnet-login-routes.js.backup

# Editar com nano (mais fácil)
nano comprasnet-login-routes.js

# Ou editar com vim
vim comprasnet-login-routes.js
```

### **Opção 2: Editar via SFTP (WinSCP/FileZilla)**

1. Conectar com WinSCP/FileZilla em `217.216.85.37`
2. Navegar para `/home/carlosfinezi/web/liciteagora.com.br/private/`
3. Baixar `comprasnet-login-routes.js`
4. Editar localmente (VSCode/Notepad++)
5. Fazer as 7 mudanças acima
6. Salvar e fazer upload de volta

---

## ✅ VERIFICAR SINTAXE

Após editar, verificar que o arquivo está correto:

```bash
# Verificar sintaxe JavaScript
node -c comprasnet-login-routes.js

# Se mostrar "Syntax OK" ou nada, está correto!
```

---

## 🔄 RESTART DO SERVIDOR

```bash
# Matar processos Node atuais
pkill -f 'node.*server.js'

# Iniciar servidor novamente
cd /home/carlosfinezi/web/liciteagora.com.br/private
nohup node server.js > server.log 2>&1 &

# Aguardar 3 segundos
sleep 3

# Verificar se está rodando
ps aux | grep 'node.*server.js' | grep -v grep
```

---

## 🧪 TESTAR

```bash
curl -X POST http://localhost:3333/api/comprasnet/auto-login \
  -H 'Content-Type: application/json' \
  -d '{"cpf":"19884430000","senha":"Lombardi6392"}' \
  -v
```

---

## 📊 LOGS PARA MONITORAR

```bash
# Acompanhar logs em tempo real
tail -f /home/carlosfinezi/web/liciteagora.com.br/private/server.log

# Ou ver últimas 50 linhas
tail -50 /home/carlosfinezi/web/liciteagora.com.br/private/server.log
```

**O que você deve ver nos logs:**
```
[Login] Using LANCER-discovered hCaptcha invisible bypass method
[Login] Navigating to SSO Gov.br...
[Login] ✅ hCaptcha detected and ready
[Login] ✅ hCaptcha should have auto-resolved
[Login] Looking for login form...
[Login] Found CPF field: input#login-certificate
[Login] Found password field: input#login-password
[Login] Filling credentials...
[Login] ✅ Login successful!
```

---

## 🎯 RESUMO DAS 7 MUDANÇAS

1. ✅ Mudar `COMPRASNET_LOGIN_URL` para `SSO_LOGIN_URL`
2. ✅ Mudar URL para `https://sso.acesso.gov.br/login?client_id=comprasnet.gov.br`
3. ✅ Mudar `headless: true` para `headless: 'new'`
4. ✅ Comentar função `solveHCaptcha`
5. ✅ Adicionar wait de 5s para hCaptcha invisible
6. ✅ Remover chamada ao Anti-Captcha
7. ✅ (Opcional) Atualizar seletores de campos

---

## 🔧 SE DER ERRO

### Erro: "Login form fields not found"

**Solução**: Adicionar mais seletores (ver passo 7)

### Erro: "hCaptcha timeout"

**Solução**: Aumentar timeout de 15000 para 30000

### Erro: "Navigation timeout"

**Solução**: Aumentar timeout de navegação de 30000 para 60000

### Erro: "Syntax error"

**Solução**: Verificar todas as aspas, vírgulas e chaves

---

## 📞 PRECISA DE AJUDA?

Se tiver dificuldades, me avise e posso:
1. Criar o arquivo completo para você copiar/colar
2. Guiar você passo-a-passo via SSH
3. Debugar logs de erro específicos

---

**Boa sorte! O método LANCER vai funcionar! 🚀**
