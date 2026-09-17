# 38 — Auditoria TLS: "Esta Conexão Não É Privada" no Safari/iOS

**Data:** 2026-09-12, 15:05–16:10 BRT
**Natureza:** diagnóstico somente leitura. **Nada alterado, nada reiniciado, nenhum certificado emitido.**

| Serviço | Estado | PID |
|---|---|---|
| `nginx` | active | 3086607 (master de 11/09 06:18:51) |
| `consulta-licitacoes` | active | 3777293 |
| `liciteagora` | active | 3085849 |

---

## 1. Causa exata

**O certificado do `produtosbomgosto.liciteagora.app` está correto. O problema já se resolveu sozinho, e a diferença que você viu entre Safari e Chrome não é entre navegadores — é de horário.**

O Hestia renovou o certificado e escreveu o arquivo novo em disco, mas **o nginx continuou servindo o certificado antigo da memória** até o reload seguinte. Você testou o Safari dentro dessa janela.

### A linha do tempo, dos logs

| Quando | O quê |
|---|---|
| **10/09 02:53:29** | Hestia escreve o certificado **novo** em `ssl/*.pem` |
| **10/09 03:01:59** | **1º acesso do Safari** — 8 minutos depois. nginx ainda com o cert antigo carregado |
| 10/09 04:53 · 14:56 · 22:27 | mais acessos do Safari, todos na mesma janela |
| **11/09 06:18:51** | **nginx master reiniciado** → passa a servir o certificado novo |
| 12/09 02:53:38 | reload de rotina do Hestia |
| **12/09 10:36–10:38** | **1º acesso do Chrome iOS — funcionou**, HTTP/2, status 200 |

**Janela de falha: 10/09 02:53 → 11/09 06:18, cerca de 27 horas.**

Separando os acessos do mesmo iPhone (iOS 18.7.1) por navegador:

```
Safari (WebKit, sem CriOS): 12 requisições — TODAS em 10/Sep
Chrome iOS (CriOS):        109 requisições — TODAS em 12/Sep
Acessos do Safari em 11 ou 12/Sep: 0
```

**O Safari nunca testou depois da correção.** Não há evidência nenhuma de que ele rejeite o certificado atual — ele simplesmente não foi usado desde então.

> **Verificação que você pode fazer agora:** abrir o Safari no mesmo iPhone e acessar `https://produtosbomgosto.liciteagora.app/`. A expectativa é que abra normalmente. Se abrir, o caso está encerrado.

---

## 2. Certificado que está sendo entregue

```
subject     CN = produtosbomgosto.liciteagora.app
issuer      C = US, O = Let's Encrypt, CN = YR1
notBefore   Sep 10 04:54:57 2026 GMT
notAfter    Dec  9 04:54:56 2026 GMT
chave       RSA 4096 bits, sigalg RSA-SHA256
SHA-256     32:FC:D9:73:01:18:E3:E0:DA:9D:AE:76:8D:F3:DE:5E:
            54:4A:3A:52:7A:F2:EA:C0:54:F9:BF:FF:04:2C:C4:70
```

**O que o nginx serve é byte a byte o que está em disco** — os fingerprints SHA-256 conferem. Não há descompasso hoje.

---

## 3. Validade

| | |
|---|---|
| Emitido | 10/09/2026 04:54 UTC |
| Expira | **09/12/2026** 04:54 UTC |
| Hoje | 12/09/2026 |
| Restam | **88 dias** |

**Não está expirado.**

---

## 4. Hostname e SANs

```
X509v3 Subject Alternative Name:
    DNS:produtosbomgosto.liciteagora.app
```

Um SAN, exatamente o hostname acessado. **Coberto corretamente.**

### Não existe wildcard `*.liciteagora.app`

Verificado: cada tenant tem seu próprio certificado de nome único, emitido individualmente pelo Hestia. **Não há, e nunca houve, um wildcard** — o que é relevante para o problema do §7.

---

## 5. Cadeia

Três certificados, na ordem correta:

```
[0] CN = produtosbomgosto.liciteagora.app
     ↑ emitido por
[1] C=US, O=Let's Encrypt, CN = YR1          (2025-09-03 → 2028-09-02)
     ↑ emitido por
[2] C=US, O=ISRG, CN = Root YR               (2026-05-13 → 2032-09-02)
     ↑ cross-assinado por
    ISRG Root X1  ← raiz confiável em qualquer iPhone desde o iOS 14
```

**Cadeia completa, sem intermediário faltando.**

`Root YR` é uma raiz nova do ISRG (maio/2026) e ainda não está no trust store do iOS — mas isso **não importa**, porque o servidor entrega a versão **cross-assinada por ISRG Root X1**, que o iPhone conhece.

### Teste decisivo

Validei a cadeia usando **apenas o ISRG Root X1** como âncora, simulando um iPhone que não conhece o Root YR:

```
$ openssl verify -CAfile ISRG_Root_X1.pem -untrusted intermediarios.pem cert-0.pem
cert-0.pem: OK
```

E a verificação padrão contra o trust store do sistema: `Verify return code: 0 (ok)`.

---

## 6. O que foi descartado, e com que evidência

| Hipótese | Verificação | Resultado |
|---|---|---|
| certificado expirado | `notAfter` = 09/12/2026 | **não** — 88 dias restantes |
| hostname incorreto | SAN = `produtosbomgosto.liciteagora.app` | **não** |
| cadeia incompleta | 3 certs até ISRG Root X1 | **não** |
| intermediário ausente | YR1 presente na cadeia e no `.ca` | **não** |
| self-signed | emitido pelo Let's Encrypt | **não** |
| wildcard incorreto | não existe wildcard | **não se aplica** |
| SNI entregando cert errado | com e sem SNI, mesmo certificado | **não** neste host (mas ver §7) |
| ordem errada no `.pem` | leaf → YR1 → Root YR | **correta** |
| disco ≠ memória | fingerprints SHA-256 idênticos | **iguais hoje** |
| TLS antigo / cipher ruim | TLS 1.2 e 1.3 aceitos, 1.0/1.1 recusados, ciphers modernos | **não** |
| Certificate Transparency | 2 SCTs embutidos — o mínimo que a Apple exige | **não** |
| OCSP stapling quebrado | `no response sent` em **todos** os hosts, inclusive os que funcionam | **não é a causa** |

Sobre o OCSP: o `error.log` mostra `"ssl_stapling" ignored, no OCSP responder URL in the certificate` para dezenas de domínios. É **ruído esperado** — o Let's Encrypt removeu a URL de OCSP dos certificados em 2025. A diretiva `ssl_stapling on` ficou no template do Hestia sem função. Não causa erro em cliente nenhum.

---

## 7. Abrangência — e um problema maior que o relatado

O caso do `produtosbomgosto` já passou. **Mas a auditoria encontrou 8 tenants servindo certificado errado agora**, e dois deles são clientes ativos.

| Tenant | Vhost | CN servido | Status |
|---|---|---|---|
| `1bit` | sim | `1bit.liciteagora.app` | OK |
| `crsolucoes` | sim | próprio | OK |
| `hseletricista` | sim | próprio | OK |
| **`jaagricola`** | **NÃO** | **`server.votoaqui.com.br`** | **ERRADO** |
| `josecarloscostafilho` | sim | próprio | OK |
| **`labfiscal`** | **NÃO** | **`server.votoaqui.com.br`** | **ERRADO** |
| `levezi` · `lojasemijoias` · `opendesk` | sim | próprio | OK |
| `pccontabilidade` · `produtosbomgosto` · `raeldouglas` · `reimac` | sim | próprio | OK |
| `sandbox` … `sandbox6` (6) | **NÃO** | **`server.votoaqui.com.br`** | **ERRADO** |

### A causa é outra, e é simples

`jaagricola.liciteagora.app` e `labfiscal.liciteagora.app` **não têm vhost no nginx**. O diretório `/home/carlosfinezi/conf/web/<host>/` não existe.

O DNS aponta para o servidor (`217.216.85.37`), mas o nginx não tem `server_name` para eles — então a conexão cai no **vhost default**, que serve o certificado de `server.votoaqui.com.br`.

**Isso falha em todos os navegadores, o tempo todo.** Não é intermitente como o caso anterior: `jaagricola` e `labfiscal` são `enterprise`/`ACTIVE` e não conseguem abrir o ERP por HTTPS hoje.

Os 6 sandboxes estão `SUSPENDED` — sem impacto de cliente.

---

## 8. Correção recomendada

### Problema A — `produtosbomgosto` (o que você relatou)

**Nenhuma ação corretiva.** Já está certo desde 11/09 06:18. O que resta é a **causa raiz**, que é operacional:

> O Hestia renova o certificado e escreve em disco, mas não recarrega o nginx no mesmo momento. Até o reload seguinte, o nginx serve o certificado anterior.

Opções, em ordem de invasividade:

| # | Ação | Efeito |
|---|---|---|
| 1 | **`systemctl reload nginx` após cada renovação** (hook no Hestia) | elimina a janela |
| 2 | Monitoramento que compare o cert em disco com o servido | detecta em vez de prevenir |
| 3 | Nada | a janela se repete a cada ~90 dias, por tenant |

A opção 1 é a correção de verdade. `reload` do nginx é gracioso — não derruba conexão.

### Problema B — `jaagricola` e `labfiscal` (o que a auditoria achou)

**Criar o vhost** dos dois hosts e emitir o certificado Let's Encrypt, como os outros 11 já têm. É o mesmo procedimento de provisionamento que funcionou para eles.

Este é o problema que **está afetando cliente agora**.

---

## 9. Risco da correção

| Ação | Risco | Observação |
|---|---|---|
| `reload nginx` | **baixo** | gracioso, sem derrubar conexão. Já acontece sozinho todo dia às 02:53 |
| hook de reload pós-renovação | **baixo** | ⚠️ mas o Hestia **reescreve a própria configuração** no upgrade diário (~04:41) — um hook precisa sobreviver a isso, ou volta |
| criar vhost de `jaagricola`/`labfiscal` | **médio** | provisionamento novo; mexe na config do nginx e emite certificado. Deve seguir o mesmo caminho dos 11 que funcionam |
| emitir certificado | **médio** | o Let's Encrypt tem limite de 5 emissões/semana por domínio exato. Não é problema para dois hosts novos |

**Risco de não corrigir B:** dois clientes ativos com aviso de segurança do navegador em todo acesso.

---

## 10. Exige reload ou restart?

| Correção | Precisa de |
|---|---|
| `produtosbomgosto` | **nada** — já está correto |
| janela de renovação (causa raiz) | `systemctl reload nginx` na renovação — **reload, não restart** |
| vhost de `jaagricola`/`labfiscal` | `reload nginx` após criar (o próprio Hestia faz) |

**Nada exige restart do nginx, nem dos serviços do ERP.** `consulta-licitacoes` e `liciteagora` não têm relação com TLS — quem termina o TLS é o nginx, que faz proxy para eles em HTTP local.

---

## 11. Sobre o PWA

O service worker **não tem relação com o problema** e não o agrava: a allowlist dele tem 7 arquivos estáticos, e `/` e `/login.html` ficam de fora de propósito (relatório 37, §5). Nada de resposta de erro TLS foi ou seria cacheado.

Aliás, os logs mostram o iPhone baixando `/sw.js` com status 200 em 12/09 10:38 — **o PWA está funcionando no aparelho.**

Um ponto que vale saber para os testes de instalação: **um aviso de certificado impede a instalação do PWA**. Em `jaagricola` e `labfiscal`, o app não será instalável enquanto o vhost não existir.

---

## 12. Resumo

| Pergunta | Resposta |
|---|---|
| **Causa exata** | nginx servindo certificado antigo da memória entre a renovação (10/09 02:53) e o reload (11/09 06:18). O Safari foi testado dentro dessa janela; o Chrome, depois dela |
| **Certificado entregue** | `CN = produtosbomgosto.liciteagora.app`, Let's Encrypt YR1 |
| **Validade** | 10/09/2026 → 09/12/2026 (88 dias restantes) |
| **Hostname/SAN** | `DNS:produtosbomgosto.liciteagora.app` — correto |
| **Cadeia** | completa: leaf → YR1 → Root YR (cross-signed por ISRG Root X1) |
| **Abrangência** | `produtosbomgosto` resolvido. **8 outros servem cert errado**, sendo `jaagricola` e `labfiscal` clientes ativos |
| **Correção** | A: reload do nginx na renovação. B: criar vhost dos dois tenants |
| **Reload/restart** | reload do nginx apenas. Nenhum serviço do ERP |

---

## Ressalvas honestas

**O que não consegui provar:** não tenho o certificado anterior em disco — o Hestia sobrescreve sem guardar cópia. Então não posso mostrar a data de expiração dele. A conclusão de que o Safari viu um certificado inválido vem da **correlação de horários** (renovação → acessos do Safari → reload → acessos do Chrome), não do certificado antigo em mãos.

**Uma leitura alternativa, que seria mais benigna:** o certificado anterior podia estar apenas *próximo* de expirar, e o Safari ter reclamado por outro motivo transitório. A evidência de horário é forte, mas não é uma captura do erro.

**O teste que fecharia o caso** é de um minuto: abrir o Safari nesse iPhone agora. Se abrir sem aviso, a causa está confirmada e o problema A está encerrado. Se ainda acusar, há algo que este servidor não consegue enxergar de fora — e aí vale capturar a tela de "Mostrar Detalhes", que mostra qual certificado o aparelho está recebendo.

**Nada foi alterado:** sem renovação, sem certbot, sem Hestia, sem nginx, sem DNS, sem restart, sem commit.
