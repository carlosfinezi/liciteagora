// Resolve pra qual tela de proposta uma licitação deve ir, conforme o portal de origem.
// BNC/BLL/PCP → tela própria (deep-link por pncp). Comprasnet federal → Propostas via API.
// Outros portais (sem integração) → null (botão não aparece).
//
// Recebe qualquer objeto com linkSistemaOrigem, cnpj, ano e sequencial — o formato
// que tanto /api/interesse quanto a agenda já devolvem.
// Compartilhado por licitacoes/agenda.js e licitacoes/interesse.js.
function resolverPortalProposta(lic) {
    if (!lic) return null;
    const link = lic.linkSistemaOrigem || '';
    const pncp = `${lic.cnpj}-${lic.ano}-${lic.sequencial}`;
    if (/bnccompras\.com/i.test(link)) return { label: 'BNC', url: `/portais/bnc-proposta.html?pncp=${pncp}` };
    if (/bllcompras\.com/i.test(link)) return { label: 'BLL', url: `/portais/bll-proposta.html?pncp=${pncp}` };
    if (/portaldecompraspublicas\.com\.br/i.test(link)) return { label: 'PCP', url: `/portais/pcp-proposta.html?pncp=${pncp}` };
    if (/comprasnet\.gov\.br|compras\.gov\.br|gov\.br\/compras|cnetmobile/i.test(link)) return { label: 'Comprasnet', url: '/operacional/propostas-api.html' };
    return null;
}
