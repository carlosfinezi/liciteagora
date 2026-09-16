# Módulo Farmácia — levantamento de requisitos

Data: 2026-08-26. Escopo deste documento: **o que uma farmácia exige de um
sistema** e **o tamanho do buraco entre isso e o LiciteAgora hoje**. Não é
plano de implementação — a integração será planejada depois.

---

## 1. Regulatório — sem isso a farmácia não opera legalmente

### 1.1 SNGPC (ANVISA, RDC 22/2014)

Escrituração eletrônica obrigatória de tudo que é medicamento sujeito à
**Portaria SVS/MS 344/1998** (entorpecentes, psicotrópicos, listas C) e aos
**antimicrobianos da RDC 20/2011**.

- Transmite **XML** com entradas (compra, transferência), saídas (venda, perda,
  transformação) e **inventário** (inicial obrigatório antes da primeira
  transmissão, e periódico).
- Prazo: até **7 dias**; um arquivo pode agrupar até 7 dias consecutivos.
- Acesso do **farmacêutico RT é exclusivo e intransferível**; login
  compartilhado é infração. Troca de RT fecha o inventário e abre contagem nova.
- Obrigatoriedade retomada em calendário escalonado — Nordeste desde
  **02/01/2026**.
- Novidade: receita de antimicrobiano prescrita por enfermeiro já pode ir no XML
  com o registro **COREN**.

**O que isso impõe ao software:** no ato da venda de um controlado, capturar
prescritor (nome, conselho/UF/número), receita (tipo, número, data), paciente e
comprador (nome, documento, endereço), **lote** e quantidade — com bloqueio se
faltar dado. O estoque por lote tem de fechar, porque a ANVISA compara o
declarado com o movimentado.

### 1.2 Fiscal: grupos `med` e `rastro` na NF-e/NFC-e (NT 2021.004)

- NCM iniciando em **3001–3006** obriga o grupo `med`: `cProdANVISA` (registro
  ANVISA ou literal `ISENTO`) e `vPMC`. Com `ISENTO`, o motivo/número da isenção
  vira obrigatório.
- Medicamento obriga o grupo `rastro`: `nLote`, `qLote`, `dFab`, `dVal`.
- Faltando: **rejeição 840**.

Este é o gap fiscal mais duro — nosso emissor não monta nenhum dos dois grupos.

### 1.3 Preço regulado — CMED

- **PF** (teto de compra) e **PMC** (teto de venda ao consumidor); o PMC varia
  **por UF** (alíquota de ICMS) e por lista.
- Reajuste anual em março/abril (Lei 10.742/2003), com lista publicada
  mensalmente em XLS/PDF pela ANVISA.
- O sistema precisa importar a tabela, guardar PMC por UF, **travar venda acima
  do PMC** e reprecificar em massa no reajuste.

### 1.4 Tributação

- **PIS/COFINS**: lista **negativa** = monofásico (a indústria paga; a farmácia
  sai com CST 04/06); lista **positiva** = alíquota zero; **neutra** =
  crédito/débito normal (Lei 10.147/2000).
- **ICMS-ST**: quase todo o mix entra com ST (CST 60 / CSOSN 500), sem novo
  destaque na saída.
- O `fiscal-tributacao.js` já trata CST 60 e grupo de ST. Falta o vínculo
  **produto → lista CMED** e o CST de PIS/COFINS derivado dela.

### 1.5 Portaria 344/98 no balcão

Retenção de receita, notificação de receita A (amarela) / B (azul), receituário
de controle especial em duas vias, validade da receita, quantidade máxima por
receita, livro de registro. Tudo isso é validação **no ato da venda**, não
relatório posterior.

### 1.6 RDC 44/2009 — dispensação remota

Delivery/telefone/site são permitidos, mas: **vedado para controlados**,
farmacêutico presente no horário todo, site em domínio `.com.br`, estoque na
própria farmácia aberta ao público.

### 1.7 SNCM / serialização — **não é mais requisito**

A **RDC 886, de 12/07/2024**, revogou todas as normas de rastreabilidade do
SNCM. Não existe hoje obrigação de serialização unitária. Rastro por lote
continua obrigatório, mas pela NF-e (`rastro`), não pelo SNCM. Registrado aqui
para que ninguém gaste esforço nisso.

---

## 2. Comercial — é o que faz a farmácia escolher o sistema

### 2.1 Farmácia Popular

- Desde fev/2025 é **100% gratuito** (fim do copagamento): 41 itens para 11
  doenças, mais contraceptivos e fraldas geriátricas.
- Integração é **webservice do DATASUS** (XML), conexão direta ou por
  concentrador. Exige **homologação** (venda e estorno) antes da produção; a
  virada para produção leva ~72h.
- A **Portaria GM/MS 12.091, de 11/08/2026**, reescreveu o programa: entrada por
  **convocação** (acabou a adesão espontânea), 10 documentos exigidos,
  **declaração formal do representante legal de que a farmácia tem emissão de
  nota eletrônica e sistema de gestão web**, renovação bienal, monitoramento por
  risco automatizado com classificação (baixo a muito alto).
- Dispensação amarrada ao **EAN vigente**: código fora da lista atual é
  rejeitado automaticamente na venda.

### 2.2 PBM (programas de benefício em medicamentos)

Autorizadores que concentram o mercado: **Portal da Drogaria (Seven PDV),
Funcional Card, ePharma, Vidalink, Orizon, Transaction Centre**. Cada um é uma
integração própria (webservice ou TEF/POSWEB) com **homologação individual do
software**.

Impacto no PDV: no meio da venda, autoriza **item a item**, aplica o desconto do
convênio, e o valor coberto **não entra no caixa** — vira recebível do PBM, com
repasse a conciliar depois. Isso exige contas a receber por PBM e conciliação de
repasse.

### 2.3 Convênio empresa e crediário

Cliente PJ com limite, lista de autorizados, fechamento quinzenal/mensal e
boleto. Aqui a base do sistema já é forte.

### 2.4 PDV de balcão

Busca por **princípio ativo/DCB**, sugestão de **genérico intercambiável e
similar**, preço limitado ao PMC, regras de desconto por convênio/produto/
cliente, **sangria, suprimento e conta gerente**, TEF, multi-forma, venda
vinculada a receita, delivery.

### 2.5 Estoque FEFO

Lote **mais próximo do vencimento sai primeiro**, bloqueio automático de venda
de vencido, alerta de vencimento, devolução ao fornecedor, curva ABC e controle
de ruptura.

### 2.6 Cadastro de produto farmacêutico

Registro ANVISA, princípio ativo/DCB, laboratório, classe terapêutica, tarja
(livre / vermelha / preta / lista da 344), PF e PMC por UF, lista CMED
(positiva/negativa/neutra), apresentação e fracionamento, EAN.

Ninguém cadastra ~40 mil itens à mão: precisa de **importação de base**. A tabela
CMED da ANVISA é pública e traz preço e EAN (com EANs sabidamente sujos); base
comercial completa (ABCFarma e equivalentes) é paga.

### 2.7 Serviços farmacêuticos

Aplicação de injetáveis, aferição de pressão/glicemia, vacinas: agendamento mais
declaração de serviço farmacêutico. O módulo de OS/serviços dá a base.

### 2.8 Manipulação (RDC 67/2007) — **tratar em separado**

É outro sistema dentro do sistema: fórmula-padrão, ordem de manipulação, cálculo
por fator de correção e teor, matéria-prima com laudo, rótulo normatizado,
controle de qualidade, rastreio por preparação. Recomendação: **fase 2 própria**,
não misturar com drogaria.

---

## 3. O que já temos e serve de base

| Peça | Onde | Serve para |
|---|---|---|
| Lotes com fabricação/validade e saldo por lote | `estoque-routes.js`, `lotes-routes.js` | rastro, SNGPC, FEFO |
| Alerta de lote vencendo | `lotes-routes.js` (`/api/lotes/vencendo`) | gestão de validade |
| NFC-e, TEF, PDV, meios de pagamento | `nfce-routes.js`, `tef-routes.js`, `public/varejo/pdv.html` | balcão |
| Motor de tributação por regime, CST 60 e ST | `fiscal-tributacao.js` | ICMS-ST do mix |
| CR/CP, conciliação, boletos, cobrança recorrente | módulo financeiro | convênio, PBM, crediário |
| Múltiplos códigos de barras por produto | `produto_codigos` | EAN da CMED / Farmácia Popular |
| Inventário físico, compras, NF-e entrada, manifestador | vários | entrada de mercadoria e SNGPC |
| **Vertical `otica` completa** | slug em `plan-modules.js`, `optica/optica-routes.js`, `public/optica/` | **molde arquitetural pronto** para a vertical farmácia |

O precedente da ótica é o achado mais útil: já existe no repo a forma de uma
vertical — slug de módulo no `plan-modules.js`, pasta própria na raiz com
`<vertical>-routes.js`, telas em `public/<vertical>/`. O módulo farmácia deve
nascer com essa mesma forma.

---

## 4. Gaps, por dureza

**Tier 0 — sem isso não se vende um comprimido dentro da lei**

1. Grupos `med` e `rastro` na NFC-e/NF-e.
2. Campos regulatórios no cadastro de produto (registro ANVISA, tarja/lista,
   PMC por UF, lista CMED).
3. Venda com lote obrigatório, FEFO e bloqueio de vencido — **hoje não existe
   FEFO em lugar nenhum do código**.
4. SNGPC: captura na venda, geração e transmissão do XML, inventário.
5. Captura de receita e validação da 344/98 e RDC 20/2011 no PDV.

**Tier 1 — sem isso não se ganha o cliente**

6. Farmácia Popular (webservice DATASUS + homologação).
7. Um ou mais PBMs.
8. Importação da base CMED e reprecificação em massa.
9. PDV de balcão de farmácia (princípio ativo, genérico/similar, convênio,
   crediário, conta gerente).
10. Financeiro de convênio e PBM (recebível por autorizador, conciliação de
    repasse).

**Tier 2 — diferenciação**

11. Serviços farmacêuticos, delivery/e-commerce sob RDC 44, curva ABC e ruptura,
    manipulação.

---

## 5. Escopo fechado (decidido em 2026-08-26)

| Ponto | Decisão | Consequência |
|---|---|---|
| Tipo de farmácia | **Drogaria apenas** | RDC 67/2007 e todo o subsistema de manipulação saem do escopo. Corta perto de metade do módulo. |
| UF | **Pará** | Alíquota interna do PA: **19%** — é a coluna de PMC da CMED a ser usada. Confirmar na SEFAZ-PA se medicamento tem tratamento diferenciado e quais as MVAs do Convênio 76/94 no RICMS-PA. |
| Tenant piloto | **`labfiscal`** | Banco pequeno (3 MB), serve de sandbox. `data/tenants/labfiscal/pncp.db`. |
| Farmácia Popular | **Fora da v1** | Some a dependência externa de convocação do Ministério da Saúde (Portaria 12.091/2026) e a homologação no DATASUS. Grande ganho de cronograma. |
| PBM | **Indefinido** | Fica fora da v1 por consequência. Recomendação para quando entrar: **Portal da Drogaria** (SevenPDV/Interplayers) — ~1.600 programas em um único autorizador e ~35 mil farmácias, é o hub natural de drogaria independente. Os corporativos (Funcional Card, ePharma, Vidalink, Orizon) só fazem sentido se o cliente tiver a demanda. |
| Base de produtos | **Lista de preços da CMED (ANVISA), pública e mensal** | Basta. Traz laboratório, CNPJ, produto, **substância (princípio ativo)**, **classe terapêutica**, apresentação, **registro ANVISA**, **EAN-13**, **regime de preço** (regulado/liberado), **PF e PMC por alíquota de ICMS**, **tarja**, restrição hospitalar e a **lista de crédito tributário** (positiva/negativa/neutra) que define o PIS/COFINS. Ressalva conhecida: EANs com sujeira na origem — o importador precisa tolerar. |

### O que sobra para a v1

Com Farmácia Popular e PBM fora, a v1 é **exatamente o Tier 0** mais o mínimo de
balcão e de cadastro:

1. Importador da lista CMED → cadastro farmacêutico do produto (registro, tarja,
   lista tributária, PMC 19% do PA, princípio ativo, classe).
2. Grupos `med` e `rastro` na NFC-e/NF-e.
3. Venda com lote obrigatório, FEFO e bloqueio de vencido.
4. Captura de receita e validação da Portaria 344/98 e da RDC 20/2011 no PDV.
5. SNGPC: escrituração, inventário e transmissão do XML.
6. PDV de balcão: busca por princípio ativo, genérico/similar, trava de PMC.

### Itens a confirmar antes de codar

- **SEFAZ-PA**: alíquota efetiva de medicamento no Pará (a geral é 19%, mas
  medicamento costuma ter tratamento próprio), MVAs do Convênio 76/94 no
  RICMS-PA e eventual redução de base. Isso define qual coluna de PMC usar e como
  o `fiscal-tributacao.js` fecha o ICMS-ST. É pergunta para o contador, não para
  a internet.
- **Regime tributário do CNPJ piloto** (Simples ou normal): muda o CST/CSOSN e o
  tratamento do PIS/COFINS monofásico.

---

## Fontes

- ANVISA — SNGPC: https://www.gov.br/anvisa/pt-br/assuntos/fiscalizacao-e-monitoramento/sngpc
- ANVISA — Rastreabilidade / revogação do SNCM (RDC 886/2024):
  https://www.gov.br/anvisa/pt-br/assuntos/fiscalizacao-e-monitoramento/rastreabilidade
  e https://www.fukumaadvogados.com.br/informativos/rdc-revoga-normas-relacionadas-a-rastreabilidade-de-medicamentos/
- SNGPC — obrigações, prazos e erros comuns:
  https://m2farma.com/blog/sngpc-obrigacoes-erros-comuns/
- SNGPC — retorno da obrigatoriedade (Nordeste, 02/01/2026):
  https://agevisa.pb.gov.br/noticias/agevisa-alerta-farmacias-para-retorno-da-escrituracao-obrigatoria-de-medicamentos-controlados-no-sngpc
- SNGPC — antimicrobianos prescritos por enfermeiros (COREN):
  https://www.cofen.gov.br/anvisa-atualiza-sngpc-e-inclui-prescricoes-de-antimicrobianos-por-enfermeiros/
- CMED — como consultar as listas (ANVISA):
  https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/como-consultar/como-consultar-as-listas
- CMED — PF, PMC, PMVG e listas positiva/negativa/neutra:
  https://simtax.com.br/o-que-e-cmed-entenda-as-regras-de-precos-medicamentos/
- NF-e — rejeição 840, grupo `med` e grupo `rastro`:
  https://atendimento.tecnospeed.com.br/hc/pt-br/articles/4419366327191
  e https://www.totvs.com/blog/fiscal-clientes/nf-e-nfc-e-nota-tecnica-2021-004-v-1-0-inclui-novas-regras-de-validacao-e-campos/
- Farmácia Popular — webservice/DNS do autorizador:
  https://febrafar.com.br/farmacia-popular-dns-webservice-autorizador/
- Farmácia Popular — manual do sistema (Ministério da Saúde):
  https://bvsms.saude.gov.br/bvs/publicacoes/farmacia_popular_manual_sistema_copagamento_2ed.pdf
- Farmácia Popular — Portaria GM/MS 12.091/2026:
  https://p2saude.com.br/portaria-12091-2026-farmacia-popular-novas-regras/
- PBM — autorizadores e integração via webservice (base Linx Farma):
  https://share.linx.com.br/pages/viewpage.action?pageId=101513978
  e https://www.inovafarma.com.br/blog/guia-pbm-programa-desconto-medicamentos/
- PDV de farmácia — funcionalidades esperadas:
  https://xfarmacompany.com/blog/pdv-farmacia-o-que-avaliar
  e https://galago.com.br/blog/sistema-para-farmacia.html
- RDC 44/2009 — dispensação remota:
  https://bvsms.saude.gov.br/bvs/saudelegis/anvisa/2009/rdc0044_17_08_2009.pdf
- RDC 67/2007 — manipulação:
  https://portal.crfsp.org.br/orientacao-farmaceutica/legislacao/113-juridico/legislacao/2595-resolucao-rdc-no-67-de-08-de-outubro-de-2007-anexo.html
