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
            colapsavel: false,
            itens: [
                { page: 'index', icone: '🔍', texto: 'Buscar', link: '/' },
                { page: 'interesse', icone: '⭐', texto: 'Interesses', link: '/interesse.html', badge: 'interesseCount' },
                { page: 'kanban', icone: '📋', texto: 'Kanban', link: '/kanban.html' },
                { page: 'agenda', icone: '📅', texto: 'Agenda', link: '/agenda.html' },
                { page: 'sem-interesse', icone: '🚫', texto: 'Sem Interesse', link: '/sem-interesse.html' }
            ]
        },
        {
            titulo: 'Operacional',
            colapsavel: true,
            itens: [
                { page: 'propostas-api', icone: '📝', texto: 'Propostas', link: '/propostas-api.html' },
                { page: 'lances', icone: '🎯', texto: 'Lances Automáticos', link: '/lances.html' },
                { page: 'relatorio-lances', icone: '📊', texto: 'Relatório Lances', link: '/relatorio-lances.html' },
                { page: 'monitoramento-chat', icone: '💬', texto: 'Monitor de Chat', link: '/monitoramento-chat.html' },
                { page: 'inteligencia', icone: '📈', texto: 'Inteligência', link: '/inteligencia.html' },
                { page: 'analises-ia', icone: '🤖', texto: 'Análises IA', link: '/analises-ia.html' }
            ]
        },
        {
            titulo: 'Comercial',
            colapsavel: true,
            itens: [
                { page: 'pessoas', icone: '👥', texto: 'Clientes & Fornecedores', link: '/pessoas.html' },
                { page: 'crm-funil', icone: '🎯', texto: 'CRM · Funil', link: '/crm-funil.html' },
                { page: 'crm-oportunidade', icone: '💼', texto: 'CRM · Oportunidades', link: '/crm-oportunidade.html' },
                { page: 'pedidos', icone: '🧾', texto: 'Pedidos', link: '/pedidos.html' },
                { page: 'contratos', icone: '📄', texto: 'Contratos', link: '/contratos.html' },
                { page: 'ordens-servico', icone: '🛠️', texto: 'Ordens de Serviço', link: '/ordens-servico.html' },
                { page: 'devolucoes', icone: '↩️', texto: 'Devoluções', link: '/devolucoes.html' }
            ]
        },
        {
            titulo: 'Produtos & Estoque',
            colapsavel: true,
            itens: [
                { page: 'produtos', icone: '📦', texto: 'Produtos', link: '/produtos.html' },
                { page: 'estoque', icone: '🏭', texto: 'Estoque', link: '/estoque.html' },
                { page: 'estoque-movimentacoes', icone: '🔁', texto: 'Movimentações', link: '/estoque-movimentacoes.html' },
                { page: 'estoque-inventario', icone: '📋', texto: 'Inventário', link: '/estoque-inventario.html' },
                { page: 'estoque-lotes', icone: '🏷️', texto: 'Lotes', link: '/estoque-lotes.html' },
                { page: 'estoque-serial', icone: '🔢', texto: 'Números de Série', link: '/estoque-serial.html' },
                { page: 'estoque-reservas', icone: '🔒', texto: 'Reservas', link: '/estoque-reservas.html' },
                { page: 'estoque-sugestao-compra', icone: '🛒', texto: 'Sugestão de Compra', link: '/estoque-sugestao-compra.html' },
                { page: 'estoque-analises', icone: '📊', texto: 'Análises de Estoque', link: '/estoque-analises.html' },
                { page: 'pedidos-compra', icone: '🧾', texto: 'Pedidos de Compra', link: '/pedidos-compra.html' }
            ]
        },
        {
            titulo: 'Varejo',
            colapsavel: true,
            itens: [
                { page: 'pdv', icone: '🏪', texto: 'PDV', link: '/pdv.html' },
                { page: 'tef', icone: '💳', texto: 'TEF', link: '/tef.html' },
                { page: 'marketplaces', icone: '🛍️', texto: 'Marketplaces', link: '/marketplaces.html' },
                { page: 'romaneios', icone: '🚚', texto: 'Romaneios', link: '/romaneios.html' }
            ]
        },
        {
            titulo: 'Financeiro',
            colapsavel: true,
            itens: [
                { page: 'financeiro', icone: '💰', texto: 'Financeiro (visão geral)', link: '/financeiro.html' },
                { page: 'contas-a-receber', icone: '📥', texto: 'Contas a Receber', link: '/contas-a-receber.html' },
                { page: 'contas-a-pagar', icone: '📤', texto: 'Contas a Pagar', link: '/contas-a-pagar.html' },
                { page: 'contas-financeiras', icone: '🏦', texto: 'Contas Financeiras', link: '/contas-financeiras.html' },
                { page: 'plano-contas', icone: '🗂️', texto: 'Plano de Contas', link: '/plano-contas.html' },
                { page: 'centros-custo', icone: '🎯', texto: 'Centros de Custo', link: '/centros-custo.html' },
                { page: 'fluxo-caixa', icone: '💧', texto: 'Fluxo de Caixa', link: '/fluxo-caixa.html' },
                { page: 'livro-caixa', icone: '📒', texto: 'Livro Caixa', link: '/livro-caixa.html' },
                { page: 'conciliacao-bancaria', icone: '🔗', texto: 'Conciliação Bancária', link: '/conciliacao-bancaria.html' },
                { page: 'faturas', icone: '📃', texto: 'Faturas', link: '/faturas.html' },
                { page: 'cobrancas', icone: '📨', texto: 'Cobranças', link: '/cobrancas.html' },
                { page: 'cobrancas-config', icone: '⚙️', texto: 'Cobranças · Config', link: '/cobrancas-config.html' },
                { page: 'adquirentes-cartao', icone: '💳', texto: 'Adquirentes de Cartão', link: '/adquirentes-cartao.html' },
                { page: 'recorrencias', icone: '🔄', texto: 'Recorrências (Receber)', link: '/recorrencias.html' },
                { page: 'cp-recorrencias', icone: '🔁', texto: 'Recorrências (Pagar)', link: '/cp-recorrencias.html' }
            ]
        },
        {
            titulo: 'Fiscal',
            colapsavel: true,
            itens: [
                { page: 'nfse', icone: '🧾', texto: 'NFS-e', link: '/nfse.html' },
                { page: 'nfce-config', icone: '🧮', texto: 'NFC-e · Config', link: '/nfce-config.html' },
                { page: 'nfe-config', icone: '📑', texto: 'NF-e · Config', link: '/nfe-config.html' },
                { page: 'nfe-inbox', icone: '📬', texto: 'NF-e · Entrada', link: '/nfe-inbox.html' },
                { page: 'mdfe', icone: '🚛', texto: 'MDF-e', link: '/mdfe.html' },
                { page: 'cte', icone: '📦', texto: 'CT-e', link: '/cte.html' },
                { page: 'importacao', icone: '⬆️', texto: 'Importação', link: '/importacao.html' },
                { page: 'cadastro-cfops', icone: '🏷️', texto: 'CFOPs', link: '/cadastro-cfops.html' },
                { page: 'retencoes', icone: '✂️', texto: 'Retenções', link: '/retencoes.html' },
                { page: 'apuracao-sn', icone: '🧮', texto: 'Apuração SN', link: '/apuracao-sn.html' },
                { page: 'dre', icone: '📊', texto: 'DRE', link: '/dre.html' },
                { page: 'defis', icone: '📋', texto: 'DEFIS', link: '/defis.html' },
                { page: 'fiscal-arquivamento', icone: '🗄️', texto: 'Arquivamento Fiscal', link: '/fiscal-arquivamento.html' }
            ]
        },
        {
            titulo: 'RH & Acesso',
            colapsavel: true,
            itens: [
                { page: 'funcionarios', icone: '👷', texto: 'Funcionários', link: '/funcionarios.html' },
                { page: 'comissoes', icone: '💵', texto: 'Comissões', link: '/comissoes.html' },
                { page: 'patrimonio', icone: '🏛️', texto: 'Patrimônio', link: '/patrimonio.html' },
                { page: 'usuarios', icone: '🔑', texto: 'Usuários', link: '/usuarios.html' },
                { page: 'meu-perfil', icone: '👤', texto: 'Meu Perfil', link: '/meu-perfil.html' }
            ]
        },
        {
            titulo: 'Comunicação',
            colapsavel: true,
            itens: [
                { page: 'comunicacao', icone: '📣', texto: 'Comunicação', link: '/comunicacao.html' },
                { page: 'email-log', icone: '📧', texto: 'Log de E-mails', link: '/email-log.html' },
                { page: 'auditoria', icone: '🔎', texto: 'Auditoria', link: '/auditoria.html' }
            ]
        },
        {
            titulo: 'Configurações',
            colapsavel: true,
            itens: [
                { page: 'conexoes', icone: '🔗', texto: 'Conexões', link: '/conexoes.html' },
                { page: 'fornecedor', icone: '🏢', texto: 'Fornecedor (config)', link: '/fornecedor.html' },
                { page: 'grupos-palavras', icone: '🏷️', texto: 'Grupos de Palavras', link: '/grupos-palavras.html' },
                { page: 'jornal', icone: '📰', texto: 'Jornal', link: '/jornal.html' },
                { page: 'portal-credenciais', icone: '🔐', texto: 'Portal · Credenciais', link: '/portal-credenciais.html' },
                { page: 'status', icone: '📊', texto: 'Status', link: '/status.html' },
                { page: 'versoes', icone: '💾', texto: 'Versões', link: '/versoes.html' }
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
 * ordem-servico.html, pedido-compra.html, produto.html, romaneio.html,
 * contas-a-pagar-detalhe.html, contas-a-receber-detalhe.html, nfe-entrada-detalhe.html,
 * estoque-inventario-contagem.html, estoque-movimentacao-nova.html) não aparecem no menu
 * porque são abertas via link da página de listagem correspondente.
 */
