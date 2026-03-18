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
                { page: 'monitoramento-chat', icone: '💬', texto: 'Monitor de Chat', link: '/monitoramento-chat.html' },
                { page: 'inteligencia', icone: '📊', texto: 'Inteligência', link: '/inteligencia.html' },
                { page: 'analises-ia', icone: '🤖', texto: 'Análises IA', link: '/analises-ia.html' }
            ]
        },
        {
            titulo: 'Financeiro',
            colapsavel: true,
            itens: [
                { page: 'pessoas', icone: '👥', texto: 'Clientes', link: '/pessoas.html' },
                { page: 'financeiro', icone: '💰', texto: 'Contas a Receber', link: '/financeiro.html' },
                { page: 'nfse', icone: '🧾', texto: 'NFSe', link: '/nfse.html' },
                { page: 'recorrencias', icone: '🔄', texto: 'Recorrências', link: '/recorrencias.html' }
            ]
        },
        {
            titulo: 'Configurações',
            colapsavel: true,
            itens: [
                { page: 'conexoes', icone: '🔗', texto: 'Conexões', link: '/conexoes.html' },
                { page: 'fornecedor', icone: '🏢', texto: 'Fornecedor', link: '/fornecedor.html' },
                { page: 'grupos-palavras', icone: '🏷️', texto: 'Grupos de Palavras', link: '/grupos-palavras.html' },
                { page: 'jornal', icone: '📰', texto: 'Jornal', link: '/jornal.html' },
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
 */
