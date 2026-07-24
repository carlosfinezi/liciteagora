/* Configuração do Menu Lateral - Licite Agora */
/* Adicione novas páginas aqui para que apareçam automaticamente no menu */

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
                { page: 'relatorio-lances', icone: '📊', texto: 'Relatório Lances', link: '/operacional/relatorio-lances.html' },
                { page: 'relatorio-participacoes', icone: '🏆', texto: 'Participações', link: '/operacional/relatorio-participacoes.html' },
                { page: 'monitoramento-chat', icone: '💬', texto: 'Monitor de Chat', link: '/operacional/monitoramento-chat.html' },
                { page: 'inteligencia', icone: '📈', texto: 'Inteligência', link: '/operacional/inteligencia.html' },
                { page: 'sugestao-produto', icone: '🎯', texto: 'Sugestão de Produto', link: '/operacional/sugestao-config.html' },
                { page: 'analises-ia', icone: '🤖', texto: 'Análises IA', link: '/operacional/analises-ia.html' },
                { page: 'grupos-palavras', icone: '🏷️', texto: 'Grupos de Palavras', link: '/operacional/grupos-palavras.html' }
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
                { page: 'bll-proposta', icone: '📝', texto: 'Proposta BLL', link: '/portais/bll-proposta.html' },
                { page: 'bll-salas', icone: '📡', texto: 'Salas BLL', link: '/portais/bll-salas.html' },
                { page: 'pcp-proposta', icone: '📝', texto: 'Proposta PCP', link: '/portais/pcp-proposta.html' },
                { page: 'pcp-salas', icone: '📡', texto: 'Salas PCP', link: '/portais/pcp-salas.html' }
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
                { page: 'comercial-tabelas-preco', icone: '💲', texto: 'Tabelas de Preço', link: '/comercial/tabelas-preco.html' },
                { page: 'comercial-vendas-perdidas', icone: '📉', texto: 'Vendas Perdidas', link: '/comercial/vendas-perdidas.html' },
                { page: 'comercial-metas', icone: '🏁', texto: 'Metas de Vendas', link: '/comercial/metas.html' },
                { page: 'contratos', icone: '📄', texto: 'Contratos', link: '/comercial/contratos.html' },
                { page: 'devolucoes', icone: '↩️', texto: 'Devoluções', link: '/comercial/devolucoes.html' }
            ]
        },
        {
            titulo: 'Ordens de Serviço',
            icone: '🛠️',
            colapsavel: true,
            feature: 'os',
            itens: [
                { page: 'ordens-servico', icone: '🛠️', texto: 'Ordens de Serviço', link: '/os/ordens-servico.html' },
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
                { page: 'compras-sugestao', icone: '🛒', texto: 'Sugestão de Compra', link: '/compras/sugestao.html' },
                { page: 'fornecedores', icone: '🏢', texto: 'Fornecedores', link: '/compras/fornecedores.html' }
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
                { page: 'plano-contas', icone: '🗂️', texto: 'Plano de Contas', link: '/financeiro/plano-contas.html' },
                { page: 'centros-custo', icone: '🎯', texto: 'Centros de Custo', link: '/financeiro/centros-custo.html' },
                { page: 'fluxo-caixa', icone: '💧', texto: 'Fluxo de Caixa', link: '/financeiro/fluxo-caixa.html' },
                { page: 'fin-provisoes', icone: '📌', texto: 'Provisões', link: '/financeiro/provisoes.html' },
                { page: 'fin-orcamento', icone: '🎯', texto: 'Orçamento', link: '/financeiro/orcamento.html' },
                { page: 'livro-caixa', icone: '📒', texto: 'Livro Caixa', link: '/financeiro/livro-caixa.html' },
                { page: 'conciliacao-bancaria', icone: '🔗', texto: 'Conciliação Bancária', link: '/financeiro/conciliacao-bancaria.html' },
                { page: 'fin-conciliacao-regras', icone: '🎛️', texto: 'Regras de Conciliação', link: '/financeiro/conciliacao-regras.html' },
                { page: 'fin-lotes-pagamento', icone: '📦', texto: 'Pagamento em Lote', link: '/financeiro/lotes-pagamento.html' },
                { page: 'fin-cartoes', icone: '💳', texto: 'Agenda de Cartões', link: '/financeiro/cartoes.html' },
                { page: 'faturas', icone: '📃', texto: 'Faturas', link: '/financeiro/faturas.html' },
                { page: 'cobrancas', icone: '📨', texto: 'Cobranças', link: '/financeiro/cobrancas.html' },
                { page: 'cobrancas-config', icone: '⚙️', texto: 'Cobranças · Config', link: '/financeiro/cobrancas-config.html' },
                { page: 'adquirentes-cartao', icone: '💳', texto: 'Adquirentes de Cartão', link: '/financeiro/adquirentes-cartao.html' },
                { page: 'recorrencias', icone: '🔄', texto: 'Recorrências (Receber)', link: '/financeiro/recorrencias.html' },
                { page: 'cp-recorrencias', icone: '🔁', texto: 'Recorrências (Pagar)', link: '/financeiro/cp-recorrencias.html' }
            ]
        },        {
            titulo: 'Contabilidade',
            icone: '📚',
            colapsavel: true,
            feature: 'financeiro',
            itens: [
                { page: 'ctb-plano', icone: '🗂️', texto: 'Plano Contábil', link: '/contabilidade/plano-contabil.html' },
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
                { page: 'nfse', icone: '🧾', texto: 'Emitir NFS-e', link: '/fiscal/nfse.html' },
                { page: 'nfse-emitidas', icone: '📋', texto: 'NFS-e · Emitidas', link: '/fiscal/nfse-emitidas.html' },
                { page: 'nfce-config', icone: '🧮', texto: 'NFC-e · Config', link: '/fiscal/nfce-config.html' },
                { page: 'nfe-config', icone: '📑', texto: 'NF-e · Config', link: '/fiscal/nfe-config.html' },
                { page: 'notas-fiscais', icone: '🗂️', texto: 'Notas Fiscais', link: '/fiscal/notas-fiscais.html' },
                { page: 'nfe-inbox', icone: '📬', texto: 'NF-e · Entrada', link: '/fiscal/nfe-inbox.html' },
                { page: 'mdfe', icone: '🚛', texto: 'MDF-e', link: '/fiscal/mdfe.html' },
                { page: 'cte', icone: '📦', texto: 'CT-e', link: '/fiscal/cte.html' },
                { page: 'cadastro-cfops', icone: '🏷️', texto: 'CFOPs', link: '/fiscal/cadastro-cfops.html' },
                { page: 'retencoes', icone: '✂️', texto: 'Retenções', link: '/fiscal/retencoes.html' },
                { page: 'fiscal-gnre', icone: '🧾', texto: 'GNRE / DIFAL', link: '/fiscal/gnre.html' },
                { page: 'fiscal-ibscbs', icone: '🏛️', texto: 'IBS/CBS (Reforma)', link: '/fiscal/ibscbs.html' },
                { page: 'fiscal-inutilizacao', icone: '🚫', texto: 'Inutilização NF-e', link: '/fiscal/inutilizacao.html' },
                { page: 'apuracao-sn', icone: '🧮', texto: 'Apuração SN', link: '/fiscal/apuracao-sn.html' },
                { page: 'dre', icone: '📊', texto: 'DRE', link: '/fiscal/dre.html' },
                { page: 'defis', icone: '📋', texto: 'DEFIS', link: '/fiscal/defis.html' },
                { page: 'fiscal-arquivamento', icone: '🗄️', texto: 'Arquivamento Fiscal', link: '/fiscal/fiscal-arquivamento.html' }
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
                { page: 'comissoes', icone: '💵', texto: 'Comissões', link: '/rh/comissoes.html' },
                { page: 'patrimonio', icone: '🏛️', texto: 'Patrimônio', link: '/rh/patrimonio.html' }
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
                { page: 'comunicacao', icone: '📣', texto: 'Comunicação', link: '/comunicacao/comunicacao.html' },
                { page: 'whatsapp', icone: '💬', texto: 'WhatsApp', link: '/comunicacao/whatsapp.html', feature: 'whatsapp' },
                { page: 'wa-campanhas', icone: '📣', texto: 'Campanhas WA', link: '/comunicacao/wa-campanhas.html', feature: 'whatsapp' },
                { page: 'wa-simular', icone: '🧪', texto: 'Simular conversa', link: '/comunicacao/wa-simular.html', feature: 'whatsapp' },
                { page: 'wa-agenda', icone: '📅', texto: 'Agenda de campanhas', link: '/comunicacao/wa-agenda.html', feature: 'whatsapp' },
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
                { page: 'config-alcadas', icone: '🛡️', texto: 'Alçadas', link: '/configuracoes/alcadas.html' },
                { page: 'conexoes', icone: '🔗', texto: 'Conexões', link: '/configuracoes/conexoes.html' },
                { page: 'integracoes', icone: '🔌', texto: 'Integrações', link: '/configuracoes/integracoes.html' },
                { page: 'minha-empresa', icone: '🏢', texto: 'Minha Empresa', link: '/configuracoes/minha-empresa.html' },
                { page: 'estabelecimentos', icone: '🏪', texto: 'Estabelecimentos', link: '/configuracoes/estabelecimentos.html' },
                { page: 'cadastro-tipos-operacao', icone: '🎯', texto: 'Tipos de Operação', link: '/configuracoes/cadastro-tipos-operacao.html' },
                { page: 'importacao', icone: '⬆️', texto: 'Importação', link: '/configuracoes/importacao.html' },
                { page: 'jornal', icone: '📰', texto: 'Jornal', link: '/configuracoes/jornal.html' },
                { page: 'email', icone: '✉️', texto: 'E-mail (SMTP)', link: '/configuracoes/email.html' },
                { page: 'notificacoes', icone: '🔔', texto: 'Notificações', link: '/configuracoes/notificacoes.html' },
                { page: 'portal-credenciais', icone: '🔐', texto: 'Portal · Credenciais', link: '/configuracoes/portal-credenciais.html' },
                { page: 'status', icone: '📊', texto: 'Status', link: '/configuracoes/status.html' },
                { page: 'versoes', icone: '💾', texto: 'Versões', link: '/configuracoes/versoes.html' }
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
 * OBSERVAÇÃO: páginas de detalhe (ex.: contrato.html, pedido.html, funcionario.html,
 * ordem-servico.html, /compras/pedido.html, /catalogo/produto.html, romaneio.html,
 * contas-a-pagar-detalhe.html, contas-a-receber-detalhe.html, nfe-entrada-detalhe.html,
 * /estoque/inventario-contagem.html, /estoque/movimentacao-nova.html) não aparecem no menu
 * porque são abertas via link da página de listagem correspondente.
 */
