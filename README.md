# Sistema de Consulta de Licitações - PNCP

Sistema para consulta de licitações públicas através da API do Portal Nacional de Contratações Públicas (PNCP).

## Funcionalidades

- Consulta de licitações públicas em todo o Brasil
- Filtros avançados:
  - Busca por palavras-chave
  - Filtro por período (data inicial e final)
  - Filtro por modalidade de contratação
- Exibição detalhada de cada licitação
- Paginação de resultados
- Interface responsiva e intuitiva

## Tecnologias Utilizadas

### Backend
- Node.js
- Express.js
- Axios (para requisições HTTP)
- CORS (para habilitar requisições cross-origin)

### Frontend
- HTML5
- CSS3 (com design moderno e gradientes)
- JavaScript Vanilla (Fetch API)

## Instalação

1. Clone ou baixe o projeto
2. Entre na pasta do projeto:
```bash
cd pncp-licitacoes
```

3. Instale as dependências:
```bash
npm install
```

## Como Usar

1. Inicie o servidor:
```bash
npm start
```

2. Acesse no navegador:
```
http://localhost:3000
```

3. Use os filtros para buscar licitações:
   - **Palavra-chave**: Digite termos relacionados ao objeto da licitação
   - **Data Inicial/Final**: Defina o período de publicação
   - **Modalidade**: Selecione o tipo de licitação

4. Clique em "Buscar Licitações" para ver os resultados

## Estrutura do Projeto

```
pncp-licitacoes/
├── server.js              # Servidor Express e integração com API do PNCP
├── package.json           # Dependências do projeto
├── README.md             # Documentação
└── public/               # Arquivos estáticos
    ├── index.html        # Interface do usuário
    └── app.js           # Lógica do frontend
```

## API Endpoints

### Backend Local

#### GET /api/licitacoes
Busca licitações com filtros

**Query Parameters:**
- `palavraChave` (string): Palavra-chave para busca
- `dataInicial` (string): Data inicial no formato YYYY-MM-DD
- `dataFinal` (string): Data final no formato YYYY-MM-DD
- `codigoModalidadeContratacao` (number): Código da modalidade
- `pagina` (number): Número da página (padrão: 1)
- `tamanhoPagina` (number): Quantidade por página (padrão: 50)

**Exemplo:**
```
GET http://localhost:3000/api/licitacoes?palavraChave=computador&dataInicial=2025-01-01&dataFinal=2025-01-31
```

#### GET /api/licitacoes/:cnpj/:sequencial/:ano
Busca detalhes de uma licitação específica

#### GET /api/orgaos
Busca órgãos públicos

## Modalidades de Licitação

1. Concorrência
2. Tomada de Preços
3. Convite
4. Concurso
5. Leilão
6. Pregão
7. Dispensa de Licitação
8. Inexigibilidade
9. Diálogo Competitivo

## API do PNCP

Este sistema utiliza a API pública do PNCP:
- **Base URL**: https://pncp.gov.br/api/consulta/v1
- **Documentação**: https://pncp.gov.br/api/consulta/swagger-ui/index.html
- **Acesso**: Não requer autenticação para consultas

## Recursos da Interface

- Design moderno com gradientes
- Cards informativos para cada licitação
- Badges para identificar modalidades
- Formatação de valores em Real (R$)
- Formatação de CNPJ
- Links diretos para o sistema de origem
- Estado de carregamento animado
- Mensagens de erro amigáveis
- Estado vazio quando não há resultados

## Melhorias Futuras

- [ ] Exportar resultados para CSV/Excel
- [ ] Salvar filtros favoritos
- [ ] Notificações de novas licitações
- [ ] Filtro por UF/Estado
- [ ] Filtro por valor estimado
- [ ] Visualização em mapa
- [ ] Histórico de buscas
- [ ] Comparação de licitações

## Licença

ISC

## Autor

Sistema desenvolvido para facilitar o acesso aos dados públicos de licitações no Brasil.

## Links Úteis

- [Portal PNCP](https://pncp.gov.br/)
- [Documentação API PNCP](https://www.gov.br/pncp/pt-br/acesso-a-informacao/dados-abertos)
- [Swagger API](https://pncp.gov.br/api/consulta/swagger-ui/index.html)
