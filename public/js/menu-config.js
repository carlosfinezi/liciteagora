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
                { page: 'comercial-tabelas-preco', icone: '💲', texto: 'Tabelas de Preço', link: '/comercial/tabelas-preco.html' },
                { page: 'comercial-vendas-perdidas', icone: '📉', texto: 'Vendas Perdidas', link: '/comercial/vendas-perdidas.html' },
                { page: 'comercial-metas', icone: '🏁', texto: 'Metas de Vendas', link: '/comercial/metas.html' },
                { page: 'contratos', icone: '📄', texto: 'Contratos', link: '/comercial/contratos.html' },
                { page: 'ssl-certificados', icone: '🛡️', texto: 'Certificados SSL', link: '/comercial/ssl-certificados.html', feature: 'ssl' },
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
                { page: 'loja', icone: '🛍️', texto: 'Loja virtual', link: '/varejo/loja.html' },
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
            feature: 'financeiro',
            itens: [
                { page: 'plano-contas', icone: '🗂️', texto: 'Plano de Contas · Gerencial', link: '/contabilidade/plano-contas.html' },
                { page: 'centros-custo', icone: '🎯', texto: 'Centros de Custo', link: '/contabilidade/centros-custo.html' },
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
                { page: 'cadastro-cfops', icone: '🏷️', texto: 'CFOPs', link: '/fiscal/cadastro-cfops.html' },
                { page: 'cadastro-tipos-operacao', icone: '🎯', texto: 'Tipos de Operação', link: '/fiscal/cadastro-tipos-operacao.html' },
                { page: 'retencoes', icone: '✂️', texto: 'Retenções', link: '/fiscal/retencoes.html' },
                { page: 'fiscal-gnre', icone: '🧾', texto: 'GNRE / DIFAL', link: '/fiscal/gnre.html' },
                { page: 'fiscal-ibscbs', icone: '🏛️', texto: 'IBS/CBS (Reforma)', link: '/fiscal/ibscbs.html' },
                { page: 'fiscal-inutilizacao', icone: '🚫', texto: 'Inutilização NF-e', link: '/fiscal/inutilizacao.html' },
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
