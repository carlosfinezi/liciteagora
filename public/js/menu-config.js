/* Configuração do Menu Lateral - Licite Agora */
/* Adicione novas páginas aqui para que apareçam automaticamente no menu */

/* Módulos do menu (modo 'modulos' — ver sidebar.js).
   A chave É a feature da seção, a mesma que o admin liga por tenant
   (FEATURES em control-plane-routes.js). Logo o seletor de módulos mostra
   exatamente o que foi vendido: nada aqui precisa ser mantido em paralelo.

   Só entram aqui os módulos que agrupam MAIS DE UMA seção e precisam de um
   nome próprio; módulo de uma seção só herda título e ícone dela. 'sistema'
   é o balde das seções sem feature (Configurações), que ninguém contrata. */
const menuModulos = {
    operacional: { titulo: 'Operacional', icone: '🎯' },   // Operacional + Portais
    produtos:    { titulo: 'Suprimentos', icone: '📦' },   // Catálogo + Estoque + Compras
    sistema:     { titulo: 'Sistema',     icone: '⚙️' },
};

const menuConfig = {
    logo: {
        icone: '📋',
        texto: 'Licite Agora',
        link: '/'
    },
    secoes: [
        {
            titulo: 'Licitações',
            icone: '🔍',
            colapsavel: true,
            feature: 'licitacoes',
            itens: [
                { page: 'consulta', icone: '🔍', texto: 'Buscar', link: '/licitacoes/consulta.html' },
                { page: 'interesse', icone: '⭐', texto: 'Interesses', link: '/licitacoes/interesse.html', badge: 'interesseCount' },
                { page: 'agenda', icone: '📅', texto: 'Agenda', link: '/licitacoes/agenda.html' },
                { page: 'sem-interesse', icone: '🚫', texto: 'Sem Interesse', link: '/licitacoes/sem-interesse.html' }
            ]
        },
        {
            titulo: 'Operacional',
            icone: '🎯',
            colapsavel: true,
            feature: 'operacional',
            itens: [
                { page: 'propostas-api', icone: '📝', texto: 'Propostas', link: '/operacional/propostas-api.html' },
                { page: 'lances', icone: '🎯', texto: 'Lances Automáticos', link: '/operacional/lances.html' },
                { page: 'blitz', icone: '🚀', texto: 'Rajadas (Blitz)', link: '/operacional/blitz.html' },
                { page: 'timing-analise', icone: '⏱️', texto: 'Análise de Timing', link: '/operacional/timing-analise.html' },
                { page: 'health-comprasnet', icone: '🩺', texto: 'Saúde Comprasnet', link: '/operacional/health-comprasnet.html' },
                { page: 'tokens', icone: '🔑', texto: 'Tokens Bearer', link: '/operacional/tokens.html' },
                { page: 'conexoes', icone: '🔗', texto: 'Conexões', link: '/operacional/conexoes.html' },
                { page: 'integracoes', icone: '🔌', texto: 'Integrações', link: '/operacional/integracoes.html' },
                { page: 'relatorio-lances', icone: '📊', texto: 'Relatório Lances', link: '/operacional/relatorio-lances.html' },
                { page: 'relatorio-participacoes', icone: '🏆', texto: 'Participações', link: '/operacional/relatorio-participacoes.html' },
                { page: 'comprasnet-monitor', icone: '💬', texto: 'Monitor Comprasnet', link: '/operacional/comprasnet-monitor.html' },
                { page: 'inteligencia', icone: '📈', texto: 'Inteligência', link: '/operacional/inteligencia.html' },
                { page: 'sugestao-produto', icone: '🎯', texto: 'Sugestão de Produto', link: '/operacional/sugestao-config.html' },
                { page: 'analises-ia', icone: '🤖', texto: 'Análises IA', link: '/operacional/analises-ia.html' },
                { page: 'grupos-palavras', icone: '🏷️', texto: 'Grupos de Palavras', link: '/operacional/grupos-palavras.html' },
                { page: 'integracao-comprasnet', icone: '🧩', texto: 'Integração Comprasnet', link: '/operacional/integracao-comprasnet.html' }
            ]
        },
        {
            titulo: 'Portais',
            icone: '🌐',
            colapsavel: true,
            feature: 'operacional',
            itens: [
                { page: 'bnc-proposta', icone: '📝', texto: 'Proposta BNC', link: '/portais/bnc-proposta.html' },
                { page: 'bnc-salas', icone: '📡', texto: 'Salas BNC', link: '/portais/bnc-salas.html' },
                { page: 'bnc-monitor', icone: '💬', texto: 'Monitor BNC', link: '/portais/bnc-monitor.html' },
                { page: 'bll-proposta', icone: '📝', texto: 'Proposta BLL', link: '/portais/bll-proposta.html' },
                { page: 'bll-salas', icone: '📡', texto: 'Salas BLL', link: '/portais/bll-salas.html' },
                { page: 'bll-monitor', icone: '💬', texto: 'Monitor BLL', link: '/portais/bll-monitor.html' },
                { page: 'pcp-proposta', icone: '📝', texto: 'Proposta PCP', link: '/portais/pcp-proposta.html' },
                { page: 'pcp-salas', icone: '📡', texto: 'Salas PCP', link: '/portais/pcp-salas.html' },
                { page: 'pcp-monitor', icone: '💬', texto: 'Monitor PCP', link: '/portais/pcp-monitor.html' }
            ]
        },
        {
            titulo: 'Certidões & Habilitação',
            icone: '📑',
            colapsavel: true,
            feature: 'habilitacao',
            itens: [
                { page: 'habilitacao-certidoes', icone: '📑', texto: 'Certidões & Documentos', link: '/habilitacao/certidoes.html' }
            ]
        },
        {
            titulo: 'Comercial',
            icone: '💼',
            colapsavel: true,
            feature: 'comercial',
            itens: [
                { page: 'pessoas', icone: '👥', texto: 'Clientes & Fornecedores', link: '/comercial/pessoas.html' },
{ page: 'crm-funil', icone: '🎯', texto: 'CRM · Funil', link: '/comercial/crm-funil.html' },
                { page: 'pedidos', icone: '🧾', texto: 'Pedidos', link: '/comercial/pedidos.html' },
                // Venda de balcão (Fase 2.1). NÃO substitui 'pedidos', que segue
                // sendo a gestão administrativa completa: esta é a mesma entidade
                // `pedidos`, por uma interface de operação rápida.
                //
                // Rótulo "Venda rápida" desde 2026-09-12 (auditoria 34, opção B).
                // A CHAVE `pedidos-pdv` NÃO muda: ela é a permissão de RBAC, está
                // gravada em `perfis_acesso.paginas` nos tenants e citada em
                // `perfis-api-map.js`. Renomear a chave exigiria migrar dados de
                // perfil — e esta fase é de navegação, não de banco.
                //
                // ⚠️ `oculto: true` — REGISTRADA, mas fora da barra (2026-09-12).
                //
                // Estas são duas perguntas diferentes, e o item precisa de
                // respostas opostas para cada uma:
                //
                //   "esta página existe para o controle de acesso?"  → SIM
                //   "esta página aparece na barra lateral?"          → NÃO
                //
                // Continuar AQUI é o que mantém a proteção: `perfis-acesso.js`
                // indexa `secoes[].itens[]` sem olhar `oculto`, então a página
                // segue em `POR_LINK` e `podeVerPath` exige a permissão pelo
                // nome. Apagar a linha faria a tela cair no fallback por
                // diretório — qualquer perfil com uma página de /comercial/
                // abriria o balcão. É o que o `test-pdv-rbac.js` B3 barra, com
                // esse nome: "FAIL-OPEN por diretorio".
                //
                // Quem some com ela da barra é `montarMenu`, o único a pedir
                // `secoesVisiveisDoMenu({ paraDesenho: true })`. A busca de
                // rotina e o deep link continuam enxergando — ver a nota lá.
                //
                // O caminho normal é COMERCIAL → Pedidos → [⚡ Venda rápida],
                // botão que também só aparece para quem tem a permissão.
                { page: 'pedidos-pdv', icone: '🛒', texto: 'Venda rápida', oculto: true, link: '/comercial/pedidos-pdv.html' },
                { page: 'comercial-tabelas-preco', icone: '💲', texto: 'Tabelas de Preço', link: '/comercial/tabelas-preco.html' },
                { page: 'comercial-vendas-perdidas', icone: '📉', texto: 'Vendas Perdidas', link: '/comercial/vendas-perdidas.html' },
                { page: 'comercial-metas', icone: '🏁', texto: 'Metas de Vendas', link: '/comercial/metas.html' },
                { page: 'contratos', icone: '📄', texto: 'Contratos', link: '/comercial/contratos.html' },
                { page: 'devolucoes', icone: '↩️', texto: 'Devoluções', link: '/comercial/devolucoes.html' }
            ]
        },
        {
            // Saiu de dentro do Comercial em 2026-08-28: `ssl` é add-on por
            // tenant (add-on fora de todo tier, ver plan-modules.js), e como
            // seção própria a feature vira a chave do módulo — quem contrata
            // ganha um módulo no seletor em vez de um item solto no meio das
            // rotinas de venda. O item não repete mais `feature: 'ssl'`: a
            // seção já é gated pela mesma chave.
            //
            // O arquivo saiu junto, de /comercial/ para /ssl/, porque em
            // perfis-acesso.js o primeiro segmento do path é o que libera as
            // páginas de detalhe: enquanto morasse em /comercial/, um perfil
            // que só tem 'ssl-certificados' abriria contrato.html, pedido.html
            // e crm-oportunidade.html de tabela. Endereço antigo redirecionado
            // em PAGINAS_MOVIDAS (auth-bootstrap.js).
            titulo: 'Certificados SSL',
            icone: '🛡️',
            colapsavel: true,
            feature: 'ssl',
            itens: [
                { page: 'ssl-certificados', icone: '🛡️', texto: 'Certificados SSL', link: '/ssl/certificados.html' },
                // Reemissão é o trabalho recorrente do módulo, não um detalhe da
                // lista: o arquivo vale menos que a assinatura paga, então todo
                // certificado é reemitido dentro do contrato. Com o teto das CAs
                // caindo para 47 dias isso passa de ~1x para ~10x ao ano por
                // certificado — e o que vem pela frente merece tela própria.
                { page: 'ssl-agenda', icone: '📅', texto: 'Agenda de Reemissão', link: '/ssl/agenda.html' },
                // Saiu do modal da tela de certificados: são duas APIs da
                // NicSRS (revenda + painel), três modos de compra e o catálogo
                // de produtos — configuração de módulo, não detalhe de uma
                // lista. Como tela própria também entra no catálogo de perfis
                // (perfis-acesso.js deriva as páginas daqui), o que o modal
                // nunca permitiu.
                { page: 'ssl-integracao', icone: '🔌', texto: 'Integração NicSRS', link: '/ssl/integracao.html' }
            ]
        },
        {
            titulo: 'Ordens de Serviço',
            icone: '🛠️',
            colapsavel: true,
            feature: 'os',
            itens: [
                { page: 'ordens-servico', icone: '🛠️', texto: 'Ordens de Serviço', link: '/os/ordens-servico.html' },
                { page: 'equipamentos', icone: '🖥️', texto: 'Equipamentos', link: '/os/equipamentos.html' },
                { page: 'cadastro-os-tipos', icone: '🏷️', texto: 'Tipos de OS', link: '/os/cadastro-os-tipos.html' },
                { page: 'cadastro-servicos', icone: '📋', texto: 'Cadastro de Serviços', link: '/os/cadastro-servicos.html' },
                { page: 'os-notificacoes', icone: '📬', texto: 'Notificações', link: '/os/os-notificacoes.html' },
                { page: 'os-relatorios', icone: '📊', texto: 'Relatórios', link: '/os/os-relatorios.html' }
            ]
        },
        {
            titulo: 'Catálogo',
            icone: '📦',
            colapsavel: true,
            feature: 'produtos',
            itens: [
                { page: 'produtos', icone: '📦', texto: 'Produtos', link: '/catalogo/produtos.html' },
                // Logo depois de Produtos: é de lá que se vem, e categoria é
                // configuração de uso frequente. As irmãs (Marcas, Modelos,
                // Cores…) já estão neste mesmo nível.
                { page: 'cadastro-categorias', icone: '🗂️', texto: 'Categorias', link: '/catalogo/categorias.html' },
                /* Catálogo Online veio de VAREJO → "Loja virtual" (Fase 46).
                   A CHAVE continua `loja`: ela é a permissão de RBAC e pode
                   estar gravada em `perfis_acesso.paginas` — renomeá-la tiraria
                   o acesso de quem já o tem. Mudou o lugar e o rótulo, não a
                   identidade. */
                { page: 'loja', icone: '🌐', texto: 'Catálogo Online', link: '/catalogo/catalogo-online.html' },
                /* A tela antiga continua viva (upload de logo, publicação em
                   massa, tema completo) e alcançável pela central. Registrada e
                   OCULTA para manter a proteção nominal: sem item no menu, o
                   RBAC cairia na herança do diretório `/varejo/` e quem tem PDV
                   passaria a abrir a loja. */
                { page: 'loja-config', icone: '⚙️', texto: 'Catálogo · Configurações',
                  link: '/varejo/loja.html', oculto: true },
                /* Informações da empresa do catálogo. Oculta como a irmã acima:
                   chega-se por CATÁLOGO → Catálogo Online → ⚙️ Configurações, e
                   duplicá-la no menu lateral criaria dois caminhos para a mesma
                   tela. A chave `loja` mantém o RBAC de quem já vê o catálogo. */
                { page: 'loja', icone: '🏪', texto: 'Catálogo · Informações',
                  link: '/catalogo/loja-informacoes.html', oculto: true },
                /* Entrega e cobertura. Oculta pelo mesmo motivo da irmã: o
                   caminho é CATÁLOGO → Catálogo Online → ⚙️ Configurações. */
                { page: 'loja', icone: '🛵', texto: 'Catálogo · Entrega',
                  link: '/catalogo/loja-entrega.html', oculto: true },
                /* Preço e pagamento. Mesmo desenho das duas irmãs acima: o
                   caminho é CATÁLOGO → Catálogo Online → ⚙️ Configurações, e o
                   registro existe para o RBAC não cair na herança do diretório. */
                { page: 'loja', icone: '💳', texto: 'Catálogo · Preço e pagamento',
                  link: '/catalogo/loja-preco-pagamento.html', oculto: true },
                /* Regras fiscais. Mesma família das três acima: chega-se por
                   CATÁLOGO → Catálogo Online → ⚙️ Configurações, e o registro
                   existe para o RBAC não cair na herança do diretório. */
                { page: 'loja', icone: '🧾', texto: 'Catálogo · Regras fiscais',
                  link: '/catalogo/loja-regras-fiscais.html', oculto: true },
                { page: 'catalogo-etiquetas', icone: '🏷️', texto: 'Etiquetas', link: '/catalogo/etiquetas.html' },
                { page: 'cadastro-marcas', icone: '🏷️', texto: 'Marcas', link: '/catalogo/marcas.html' },
                { page: 'cadastro-modelos', icone: '🔖', texto: 'Modelos', link: '/catalogo/modelos.html' },
                { page: 'cadastro-cores', icone: '🎨', texto: 'Cores', link: '/catalogo/cores.html' },
                { page: 'cadastro-materiais', icone: '🧱', texto: 'Materiais', link: '/catalogo/materiais.html' },
                { page: 'cadastro-generos', icone: '⚥', texto: 'Gêneros', link: '/catalogo/generos.html' }
            ]
        },
        {
            titulo: 'Estoque',
            icone: '🏭',
            colapsavel: true,
            feature: 'produtos',
            itens: [
                { page: 'estoque', icone: '🏭', texto: 'Estoque', link: '/estoque/estoque.html' },
                { page: 'estoque-depositos', icone: '🏬', texto: 'Depósitos', link: '/estoque/depositos.html' },
                { page: 'estoque-transferencias', icone: '🔀', texto: 'Transferências', link: '/estoque/transferencias.html' },
                { page: 'estoque-requisicoes', icone: '📤', texto: 'Requisições', link: '/estoque/requisicoes.html' },
                { page: 'estoque-movimentacoes', icone: '🔁', texto: 'Movimentações', link: '/estoque/movimentacoes.html' },
                { page: 'estoque-inventario', icone: '📋', texto: 'Inventário', link: '/estoque/inventario.html' },
                { page: 'estoque-lotes', icone: '🏷️', texto: 'Lotes', link: '/estoque/lotes.html' },
                { page: 'estoque-serial', icone: '🔢', texto: 'Números de Série', link: '/estoque/serial.html' },
                { page: 'estoque-reservas', icone: '🔒', texto: 'Reservas', link: '/estoque/reservas.html' },
                { page: 'estoque-analises', icone: '📊', texto: 'Análises', link: '/estoque/analises.html' }
            ]
        },
        {
            titulo: 'Compras',
            icone: '🛒',
            colapsavel: true,
            feature: 'produtos',
            itens: [
                { page: 'compras-cotacoes', icone: '📊', texto: 'Cotações', link: '/compras/cotacoes.html' },
                { page: 'pedidos-compra', icone: '🧾', texto: 'Pedidos de Compra', link: '/compras/pedidos.html' },
                { page: 'integracao-tipos', icone: '🧩', texto: 'Tipos de Integração', link: '/compras/integracao-tipos.html' },
                // Irmãs, não duplicatas: necessidade = venda que já existe sem
                // lastro; sugestão = reposição por ponto de reposição/histórico.
                { page: 'compras-necessidades', icone: '🛍️', texto: 'Necessidades de Compra', link: '/compras/necessidades.html' },
                { page: 'compras-sugestao', icone: '🛒', texto: 'Sugestão de Compra', link: '/compras/sugestao.html' },
                // Cadastro unificado (2026-08-20): fornecedor é pessoa com a
                // categoria "fornecedor". O item continua em Compras porque é
                // onde se procura por ele, mas leva à tela única.
                //
                // Duas consequências levantadas na auditoria de 2026-08-28 e
                // mantidas de propósito, para quem for mexer aqui não refazer
                // o mesmo levantamento:
                //
                // 1. É a única `page` repetida no menu. Em perfis-acesso.js o
                //    POR_PAGINA é indexado por page, então a segunda ocorrência
                //    sobrescreve a primeira — inofensivo porque as duas apontam
                //    para /comercial/, mas na tela de Perfis o item aparece nas
                //    duas seções e marcar um marca o outro.
                // 2. Pelo RBAC de diretório, um perfil só-Compras alcança as
                //    telas de detalhe de /comercial/. Medido: contrato.html e
                //    pedido.html já têm TODAS as APIs liberadas para pages de
                //    Compras (/api/contratos e /api/pedidos incluem
                //    'pedidos-compra', 'compras-necessidades' e
                //    'compras-sugestao'), crm-oportunidade.html abre vazia
                //    (/api/crm barrada) e proposta-template.html não chama API.
                //    Ou seja: mover a tela para um diretório neutro não fecharia
                //    nada — quem quiser fechar de verdade mexe no
                //    perfis-api-map.js, que é fail-closed e onde errar tranca
                //    quem já usa o sistema.
                { page: 'pessoas', icone: '🏢', texto: 'Fornecedores', link: '/comercial/pessoas.html?categoria=fornecedor' }
            ]
        },
        {
            titulo: 'Varejo',
            icone: '🏪',
            colapsavel: true,
            feature: 'varejo',
            itens: [
                { page: 'pdv', icone: '🏪', texto: 'PDV', link: '/varejo/pdv.html' },
                { page: 'pdv-config', icone: '⚙️', texto: 'PDV · Config', link: '/varejo/pdv-config.html' },
                { page: 'tef', icone: '💳', texto: 'TEF', link: '/varejo/tef.html' },
                { page: 'marketplaces', icone: '🛍️', texto: 'Marketplaces', link: '/varejo/marketplaces.html' },
                // "Loja virtual" saiu daqui na Fase 46 — virou CATÁLOGO →
                // Catálogo Online, junto dos produtos que ela publica.
                { page: 'romaneios', icone: '🚚', texto: 'Romaneios', link: '/varejo/romaneios.html' }
            ]
        },
        {
            titulo: 'Financeiro',
            icone: '💰',
            colapsavel: true,
            feature: 'financeiro',
            itens: [
                { page: 'contas-a-receber', icone: '📥', texto: 'Contas a Receber', link: '/financeiro/contas-a-receber.html' },
                { page: 'contas-a-pagar', icone: '📤', texto: 'Contas a Pagar', link: '/financeiro/contas-a-pagar.html' },
                { page: 'fin-adiantamentos', icone: '💠', texto: 'Adiantamentos', link: '/financeiro/adiantamentos.html' },
                { page: 'fin-renegociacoes', icone: '🤝', texto: 'Renegociações', link: '/financeiro/renegociacoes.html' },
                { page: 'contas-financeiras', icone: '🏦', texto: 'Contas Financeiras', link: '/financeiro/contas-financeiras.html' },
                // Vieram da seção Contabilidade em 2026-08-25, quando a
                // escrituração virou módulo pago à parte. São do Financeiro:
                // batem em /api/plano-contas e /api/centros-custo (não no
                // /api/contabilidade gated) e estão na descrição da feature
                // `financeiro`. Se ficassem lá, desligar Contabilidade tiraria
                // do cliente duas telas que ele paga. Os arquivos seguem em
                // /contabilidade/ — só o lugar no menu mudou.
                { page: 'plano-contas', icone: '🗂️', texto: 'Plano de Contas · Gerencial', link: '/contabilidade/plano-contas.html' },
                { page: 'centros-custo', icone: '🎯', texto: 'Centros de Custo', link: '/contabilidade/centros-custo.html' },
                { page: 'fluxo-caixa', icone: '💧', texto: 'Fluxo de Caixa', link: '/financeiro/fluxo-caixa.html' },
                { page: 'fin-provisoes', icone: '📌', texto: 'Provisões', link: '/financeiro/provisoes.html' },
                { page: 'fin-orcamento', icone: '🎯', texto: 'Orçamento', link: '/financeiro/orcamento.html' },
                { page: 'livro-caixa', icone: '📒', texto: 'Livro Caixa', link: '/financeiro/livro-caixa.html' },
                { page: 'conciliacao-bancaria', icone: '🔗', texto: 'Conciliação Bancária', link: '/financeiro/conciliacao-bancaria.html' },
                { page: 'fin-conciliacao-regras', icone: '🎛️', texto: 'Regras de Conciliação', link: '/financeiro/conciliacao-regras.html' },
                { page: 'fin-lotes-pagamento', icone: '📦', texto: 'Pagamento em Lote', link: '/financeiro/lotes-pagamento.html' },
                { page: 'fin-cartoes', icone: '💳', texto: 'Agenda de Cartões', link: '/financeiro/cartoes.html' },
                { page: 'adquirentes-cartao', icone: '💳', texto: 'Adquirentes de Cartão', link: '/financeiro/adquirentes-cartao.html' },
                { page: 'politicas-prazo', icone: '⏱️', texto: 'Políticas de Prazo', link: '/financeiro/politicas-prazo.html' },
                // Alçadas vieram para cá em 2026-08-21: quem define teto de
                // pagamento e quem decide na fila é o financeiro, não quem
                // administra o sistema. A fila era um módulo próprio entre
                // Compras e Financeiro e as regras estavam em Configurações;
                // os arquivos seguem em /aprovacoes/ e /configuracoes/ — só o
                // lugar no menu mudou. A fila também governa pedido de compra.
                //
                // SEM `feature: 'governanca'` de propósito: essa chave não
                // existe em FEATURE_KEYS (features-routes.js), então
                // isFeatureEnabled devolve false para todo tenant e o item
                // some do menu — foi o que manteve a Fila invisível enquanto
                // ela era um grupo próprio. Só voltará a fazer sentido quando
                // a flag existir no endpoint e estiver gravada por tenant.
                { page: 'aprovacoes', icone: '🛡️', texto: 'Fila de Aprovações', link: '/aprovacoes/aprovacoes.html', badge: 'aprovacoesCount' },
                { page: 'config-alcadas', icone: '🛡️', texto: 'Regras de Alçada', link: '/configuracoes/alcadas.html' },
                { page: 'recorrencias', icone: '🔄', texto: 'Recorrências (Receber)', link: '/financeiro/recorrencias.html' },
                { page: 'cp-recorrencias', icone: '🔁', texto: 'Recorrências (Pagar)', link: '/financeiro/cp-recorrencias.html' }
            ]
        },
        {
            titulo: 'Cobrança',
            icone: '📨',
            colapsavel: true,
            feature: 'cobranca',
            itens: [
                { page: 'cobrancas', icone: '📨', texto: 'Régua de Cobrança', link: '/cobranca/cobrancas.html' },
                { page: 'cobrancas-config', icone: '⚙️', texto: 'Configuração', link: '/cobranca/cobrancas-config.html' }
            ]
        },
        {
            titulo: 'Contabilidade',
            icone: '📚',
            colapsavel: true,
            feature: 'contabilidade',
            itens: [
                { page: 'ctb-plano', icone: '📚', texto: 'Plano Contábil · Escrituração', link: '/contabilidade/plano-contabil.html' },
                { page: 'ctb-lancamentos', icone: '✍️', texto: 'Lançamentos (Diário)', link: '/contabilidade/lancamentos.html' },
                { page: 'ctb-balancete', icone: '⚖️', texto: 'Balancete', link: '/contabilidade/balancete.html' },
                { page: 'ctb-contabilizacao', icone: '🤖', texto: 'Contabilização Auto', link: '/contabilidade/contabilizacao.html' }
            ]
        },

        {
            titulo: 'Fiscal',
            icone: '🧾',
            colapsavel: true,
            feature: 'fiscal',
            itens: [
                { page: 'fiscal-diagnostico', icone: '🩺', texto: 'Diagnóstico Fiscal', link: '/fiscal/diagnostico.html' },
                { page: 'nova-nota', icone: '📝', texto: 'Emitir NF-e', link: '/fiscal/nova-nota.html' },
                { page: 'nfse', icone: '🧾', texto: 'Emitir NFS-e', link: '/fiscal/nfse.html' },
                { page: 'faturas', icone: '📃', texto: 'Faturas', link: '/fiscal/faturas.html' },
                // Entrada única para a lista unificada: os antigos itens
                // "NFS-e · Emitidas" e "NFC-e · Emitidas" apontavam para esta
                // mesma página só trocando ?tipo=, e como as três dividiam
                // page:'notas-fiscais' acendiam juntas no menu. O filtro por
                // tipo já existe dentro da própria tela.
                { page: 'notas-fiscais', icone: '🗂️', texto: 'Notas Fiscais', link: '/fiscal/notas-fiscais.html' },
                { page: 'manifestador', icone: '📬', texto: 'Manifestador de Documentos', link: '/fiscal/manifestador.html' },
                { page: 'mdfe', icone: '🚛', texto: 'MDF-e', link: '/fiscal/mdfe.html' },
                { page: 'cte', icone: '📦', texto: 'CT-e', link: '/fiscal/cte.html' },
                { page: 'regras-tributarias', icone: '⚖️', texto: 'Regras Tributárias', link: '/fiscal/regras-tributarias.html' },
                { page: 'cadastro-cfops', icone: '🏷️', texto: 'CFOPs', link: '/fiscal/cadastro-cfops.html' },
                { page: 'cadastro-tipos-operacao', icone: '🎯', texto: 'Tipos de Operação', link: '/fiscal/cadastro-tipos-operacao.html' },
                { page: 'retencoes', icone: '✂️', texto: 'Retenções', link: '/fiscal/retencoes.html' },
                { page: 'fiscal-gnre', icone: '🧾', texto: 'GNRE / DIFAL', link: '/fiscal/gnre.html' },
                { page: 'fiscal-ibscbs', icone: '🏛️', texto: 'IBS/CBS (Reforma)', link: '/fiscal/ibscbs.html' },
                { page: 'fiscal-inutilizacao', icone: '🚫', texto: 'Inutilização NF-e', link: '/fiscal/inutilizacao.html' },
                { page: 'apuracao-icms', icone: '📗', texto: 'Apuração de ICMS', link: '/fiscal/apuracao-icms.html' },
                { page: 'apuracao-piscofins', icone: '📘', texto: 'Apuração PIS/COFINS', link: '/fiscal/apuracao-piscofins.html' },
                { page: 'apuracao-ipi', icone: '📙', texto: 'Apuração de IPI', link: '/fiscal/apuracao-ipi.html' },
                { page: 'apuracao-sn', icone: '🧮', texto: 'Apuração SN', link: '/fiscal/apuracao-sn.html' },
                { page: 'dre', icone: '📊', texto: 'DRE', link: '/fiscal/dre.html' },
                { page: 'defis', icone: '📋', texto: 'DEFIS', link: '/fiscal/defis.html' },
                { page: 'fiscal-arquivamento', icone: '🗄️', texto: 'Arquivamento Fiscal', link: '/fiscal/fiscal-arquivamento.html' },
                { page: 'fiscal-configuracao', icone: '⚙️', texto: 'Configuração de Emissão', link: '/fiscal/configuracao.html' }
            ]
        },
        {
            titulo: 'Classificação Fiscal',
            icone: '🔎',
            colapsavel: true,
            feature: 'classificacao_fiscal',
            itens: [
                { page: 'classificacao', icone: '🔎', texto: 'NCM / CEST & Impostos', link: '/classificacao-fiscal/classificacao.html' },
                { page: 'classificacao-lote', icone: '📚', texto: 'Classificação em lote', link: '/classificacao-fiscal/lote.html' },
                { page: 'tabelas-fiscais', icone: '📊', texto: 'Tabelas & Relatórios', link: '/classificacao-fiscal/tabelas.html' }
            ]
        },
        {
            titulo: 'RH',
            icone: '👥',
            colapsavel: true,
            feature: 'rh',
            itens: [
                { page: 'funcionarios', icone: '👷', texto: 'Funcionários', link: '/rh/funcionarios.html' },
                { page: 'comissoes', icone: '💵', texto: 'Comissões', link: '/rh/comissoes.html' }
            ]
        },
        {
            titulo: 'Patrimônio',
            icone: '🏛️',
            colapsavel: true,
            feature: 'patrimonio',
            itens: [
                { page: 'patrimonio-bens', icone: '🏛️', texto: 'Bens', link: '/patrimonio/bens.html' }
            ]
        },
        {
            titulo: 'Restaurante',
            icone: '🍽️',
            colapsavel: true,
            feature: 'restaurante',
            itens: [
                { page: 'restaurante-salao', icone: '🍽️', texto: 'Salão', link: '/restaurante/salao.html' },
                { page: 'restaurante-kds', icone: '👨‍🍳', texto: 'Cozinha (KDS)', link: '/restaurante/kds.html' },
                { page: 'restaurante-caixa', icone: '💵', texto: 'Caixa', link: '/restaurante/caixa.html' },
                { page: 'restaurante-delivery', icone: '🛵', texto: 'Delivery', link: '/restaurante/delivery.html' },
                { page: 'restaurante-ifood', icone: '🔌', texto: 'iFood', link: '/restaurante/ifood.html' },
                { page: 'restaurante-painel-retirada', icone: '📺', texto: 'Painel de Retirada', link: '/restaurante/painel-retirada.html' },
                { page: 'restaurante-cardapio', icone: '📋', texto: 'Cardápio', link: '/restaurante/cardapio.html' },
                { page: 'restaurante-ficha', icone: '🧾', texto: 'Ficha Técnica / CMV', link: '/restaurante/ficha-tecnica.html' },
                { page: 'restaurante-indicadores', icone: '📊', texto: 'Indicadores', link: '/restaurante/indicadores.html' },
                { page: 'restaurante-gorjetas', icone: '💰', texto: 'Gorjetas', link: '/restaurante/gorjetas.html' },
                { page: 'restaurante-config', icone: '⚙️', texto: 'Configuração', link: '/restaurante/config.html' }
            ]
        },
        {
            titulo: 'Farmácia',
            icone: '💊',
            colapsavel: true,
            feature: 'farmacia',
            itens: [
                { page: 'farmacia-medicamentos', icone: '💊', texto: 'Medicamentos', link: '/farmacia/medicamentos.html' },
                { page: 'farmacia-cmed', icone: '⬇️', texto: 'Lista CMED', link: '/farmacia/cmed.html' },
                { page: 'farmacia-receitas', icone: '📝', texto: 'Receitas', link: '/farmacia/receitas.html' },
                { page: 'farmacia-sngpc', icone: '📡', texto: 'SNGPC', link: '/farmacia/sngpc.html' },
                { page: 'farmacia-config', icone: '⚙️', texto: 'Configuração', link: '/farmacia/config.html' }
            ]
        },
        {
            titulo: 'Locação',
            icone: '🔑',
            colapsavel: true,
            feature: 'locacao',
            itens: [
                { page: 'locacao-locacoes', icone: '📋', texto: 'Locações', link: '/locacao/locacoes.html' },
                { page: 'locacao-calendario', icone: '📅', texto: 'Disponibilidade', link: '/locacao/calendario.html' },
                { page: 'locacao-itens', icone: '📦', texto: 'Itens Alugáveis', link: '/locacao/itens.html' },
                { page: 'locacao-tarifas', icone: '💲', texto: 'Preços', link: '/locacao/tarifas.html' },
                { page: 'locacao-manutencao', icone: '🔧', texto: 'Manutenção', link: '/locacao/manutencao.html' },
                { page: 'locacao-painel', icone: '📉', texto: 'Ocupação & Receita', link: '/locacao/painel.html' },
                { page: 'locacao-config', icone: '⚙️', texto: 'Configuração', link: '/locacao/config.html' }
            ]
        },
        {
            titulo: 'Produção',
            icone: '🏭',
            colapsavel: true,
            feature: 'producao',
            itens: [
                { page: 'producao-painel', icone: '📊', texto: 'Produtividade', link: '/producao/painel.html' },
                { page: 'producao-ordens', icone: '📋', texto: 'Ordens de Produção', link: '/producao/ordens.html' },
                { page: 'producao-apontamento', icone: '👷', texto: 'Apontamento', link: '/producao/apontamento.html' },
                { page: 'producao-fichas', icone: '🧱', texto: 'Fichas Técnicas', link: '/producao/fichas.html' },
                { page: 'producao-recursos', icone: '🏭', texto: 'Recursos Produtivos', link: '/producao/recursos.html' },
                { page: 'producao-qualidade', icone: '🧪', texto: 'Qualidade e Ensaios', link: '/producao/qualidade.html' },
                { page: 'producao-projetos', icone: '🏢', texto: 'Projetos', link: '/producao/projetos.html' },
                { page: 'producao-patio', icone: '📦', texto: 'Estoque de Acabados', link: '/producao/patio.html' },
                { page: 'producao-expedicao', icone: '🚚', texto: 'Expedição', link: '/producao/expedicao.html' },
                { page: 'producao-config', icone: '⚙️', texto: 'Configuração', link: '/producao/config.html' }
            ]
        },
        {
            titulo: 'Posto',
            icone: '⛽',
            colapsavel: true,
            feature: 'posto',
            itens: [
                { page: 'posto-pista', icone: '⛽', texto: 'Pista e turno', link: '/posto/pista.html' },
                { page: 'posto-recebimento', icone: '🚚', texto: 'Recebimento e tanques', link: '/posto/recebimento.html' },
                { page: 'posto-lmc', icone: '📒', texto: 'LMC e conciliação', link: '/posto/lmc.html' },
                { page: 'posto-estrutura', icone: '🔧', texto: 'Estrutura', link: '/posto/estrutura.html' }
            ]
        },
        {
            titulo: 'Ótica',
            icone: '🥽',
            colapsavel: true,
            feature: 'optica',
            itens: [
                { page: 'lentes-tipos', icone: '🏷️', texto: 'Lentes — Tipos', link: '/optica/lentes-tipos.html' },
                { page: 'lentes-materiais', icone: '🧪', texto: 'Lentes — Materiais', link: '/optica/lentes-materiais.html' },
                { page: 'lentes-indices', icone: '🔢', texto: 'Lentes — Índices', link: '/optica/lentes-indices.html' },
                { page: 'lentes-tratamentos', icone: '✨', texto: 'Lentes — Tratamentos', link: '/optica/lentes-tratamentos.html' },
                { page: 'receitas-opticas', icone: '📝', texto: 'Receitas', link: '/optica/receitas.html' },
                { page: 'ordens-montagem', icone: '🛠️', texto: 'Ordens de Montagem', link: '/optica/ordens-montagem.html' }
            ]
        },
        {
            titulo: 'Comunicação',
            icone: '📣',
            colapsavel: true,
            feature: 'comunicacao',
            itens: [
                { page: 'conversas', icone: '💬', texto: 'Conversas', link: '/comunicacao/conversas.html', feature: 'whatsapp' },
                { page: 'comunicacao-ia', icone: '🤖', texto: 'IA e Campanhas', link: '/comunicacao/ia.html', feature: 'whatsapp' },
                { page: 'email-log', icone: '📧', texto: 'Log de E-mails', link: '/comunicacao/email-log.html' },
                { page: 'auditoria', icone: '🔎', texto: 'Auditoria', link: '/comunicacao/auditoria.html' }
            ]
        },
        {
            titulo: 'Configurações',
            icone: '⚙️',
            colapsavel: true,
            itens: [
                { page: 'meu-perfil', icone: '👤', texto: 'Meu Perfil', link: '/configuracoes/meu-perfil.html' },
                { page: 'usuarios', icone: '🔑', texto: 'Usuários', link: '/configuracoes/usuarios.html' },
                { page: 'perfis', icone: '🔒', texto: 'Perfis de Acesso', link: '/configuracoes/perfis.html' },
                { page: 'minha-empresa', icone: '🏢', texto: 'Minha Empresa', link: '/configuracoes/minha-empresa.html' },
                { page: 'estabelecimentos', icone: '🏪', texto: 'Estabelecimentos', link: '/configuracoes/estabelecimentos.html' },
                { page: 'importacao', icone: '⬆️', texto: 'Importação', link: '/configuracoes/importacao.html' },
                { page: 'email', icone: '✉️', texto: 'E-mail (SMTP)', link: '/configuracoes/email.html' },
                { page: 'notificacoes', icone: '🔔', texto: 'Notificações', link: '/configuracoes/notificacoes.html' },
                { page: 'config-ia', icone: '🤖', texto: 'IA · Chaves', link: '/configuracoes/ia.html' },
                { page: 'portal-credenciais', icone: '🔐', texto: 'Portal · Credenciais', link: '/configuracoes/portal-credenciais.html' },
                { page: 'status', icone: '📊', texto: 'Status', link: '/configuracoes/status.html' },

            ]
        }
    ]
};

/*
 * COMO ADICIONAR NOVA PÁGINA:
 *
 * 1. Crie o arquivo HTML da nova página
 *
 * 2. Adicione no <head>:
 *    <link rel="stylesheet" href="/css/sidebar.css">
 *
 * 3. Adicione antes do </body>:
 *    <script src="/js/menu-config.js"></script>
 *    <script src="/js/sidebar.js"></script>
 *    <script>initSidebar('nome-da-pagina');</script>
 *
 * 4. Adicione a entrada no array 'itens' da seção apropriada acima:
 *    { page: 'nome-da-pagina', icone: '🔧', texto: 'Título no Menu', link: '/nome-da-pagina.html' }
 *
 * Opções de seção:
 *   - colapsavel: true/false — se true, o grupo pode ser retraído/expandido
 *
 * Opções de item:
 *   - page: identificador único (deve ser o mesmo passado para initSidebar)
 *   - icone: emoji ou ícone
 *   - texto: texto exibido no menu
 *   - link: URL da página
 *   - badge: (opcional) ID do elemento para mostrar contador (ex: 'interesseCount')
 *
 * ATENÇÃO: este arquivo também é lido pelo backend (perfis-acesso.js) como
 * catálogo de páginas do RBAC. Item novo aqui = item novo na tela de Perfis de
 * Acesso, sem lista paralela para manter.
 *
 * OBSERVAÇÃO: páginas de detalhe (ex.: contrato.html, pedido.html, funcionario.html,
 * ordem-servico.html, /compras/pedido.html, /catalogo/produto.html, romaneio.html,
 * contas-a-pagar-detalhe.html, contas-a-receber-detalhe.html, nfe-entrada-detalhe.html,
 * /estoque/inventario-contagem.html, /estoque/movimentacao-nova.html) não aparecem no menu
 * porque são abertas via link da página de listagem correspondente.
 */

// O backend usa este mesmo arquivo como catálogo de páginas do RBAC
// (perfis-acesso.js). No navegador `module` não existe e a linha é ignorada.
if (typeof module !== 'undefined' && module.exports) module.exports = { menuConfig };
