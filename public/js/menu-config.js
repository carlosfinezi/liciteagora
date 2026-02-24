/* Configuração do Menu Lateral - PNCP Monitor */
/* Adicione novas páginas aqui para que apareçam automaticamente no menu */

const menuConfig = {
    logo: {
        icone: '📋',
        texto: 'PNCP',
        link: '/'
    },
    secoes: [
        {
            titulo: 'Principal',
            itens: [
                { page: 'index', icone: '🔍', texto: 'Buscar Licitações', link: '/' },
                { page: 'interesse', icone: '⭐', texto: 'Meus Interesses', link: '/interesse.html', badge: 'interesseCount' },
                { page: 'propostas', icone: '📝', texto: 'Preparar Propostas', link: '/propostas.html' },
                { page: 'propostas-api', icone: '🚀', texto: 'Propostas via API', link: '/propostas-api.html' },
                { page: 'kanban', icone: '📋', texto: 'Kanban', link: '/kanban.html' },
                { page: 'agenda', icone: '📅', texto: 'Agenda', link: '/agenda.html' },
                { page: 'monitoramento-chat', icone: '💬', texto: 'Monitor de Chat', link: '/monitoramento-chat.html' }
            ]
        },
        {
            titulo: 'Ferramentas',
            itens: [
                { page: 'lances', icone: '🎯', texto: 'Lances Automáticos', link: '/lances.html' },
                { page: 'inteligencia', icone: '📊', texto: 'Inteligência de Negócio', link: '/inteligencia.html' }
            ]
        },
        {
            titulo: 'Configurações',
            itens: [
                { page: 'jornal', icone: '📰', texto: 'Jornal', link: '/jornal.html' },
                { page: 'grupos-palavras', icone: '🏷️', texto: 'Grupos de Palavras', link: '/grupos-palavras.html' },
                { page: 'fornecedor', icone: '🏢', texto: 'Dados do Fornecedor', link: '/fornecedor.html' },
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
 * Opções disponíveis para cada item:
 *   - page: identificador único (deve ser o mesmo passado para initSidebar)
 *   - icone: emoji ou ícone
 *   - texto: texto exibido no menu
 *   - link: URL da página
 *   - badge: (opcional) ID do elemento para mostrar contador (ex: 'interesseCount')
 */
