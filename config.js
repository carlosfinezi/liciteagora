// config.js
//
// NFSE-M06 onda 6.44 (2026-04-20): constantes compartilhadas entre
// modulos (PORT, PNCP_API_BASE, PNCP_API_ITENS) centralizadas aqui.
// Ate a onda 6.43 viviam inline no server.js e eram repassadas como
// deps para route-registry e role-dispatch. Agora esses dois modulos
// carregam config.js diretamente, server.js fica mais enxuto e nao
// precisa conhecer os valores.
//
// PORT           -- porta HTTP do worker (consulta-licitacoes.service).
//                   O master (liciteagora.service) nao escuta HTTP.
// PNCP_API_BASE  -- endpoint publico de consulta do PNCP v1
//                   (licitacoes, orgaos, contratacoes).
// PNCP_API_ITENS -- endpoint de consulta de itens (pncp/v1).
//
// Observacao: pncp-sync-scheduler.js, verificacao-lacunas.js e
// verificar-e-corrigir-sync.js ainda declaram PNCP_API_BASE inline
// (historico). Migrar esses modulos para require('./config') fica
// como follow-up (onda futura); nao afeta server.js agora.

module.exports = {
  PORT: 3000,
  PNCP_API_BASE: 'https://pncp.gov.br/api/consulta/v1',
  PNCP_API_ITENS: 'https://pncp.gov.br/api/pncp/v1',
};
