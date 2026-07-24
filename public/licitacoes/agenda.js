let currentDate = new Date();
let eventos = [];
let agendamentos = [];      // atividades do CRM (agendamentos com data/hora)
let eventoSelecionado = null;
let agendSelecionado = null;

const TIPO_AGEND_LABEL = {
  ligacao: '📞 Ligação', reuniao: '🤝 Reunião', visita: '📍 Visita',
  whatsapp: '📱 WhatsApp', email: '✉️ E-mail', tarefa: '✅ Tarefa'
};

const meses = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

async function carregarEventos() {
    try {
        const mes = currentDate.getMonth() + 1; // backend espera 1-12
        const ano = currentDate.getFullYear();
        const y = currentDate.getFullYear();
        const m = currentDate.getMonth();
        // Janela ampla o bastante p/ cobrir as células de mês anterior/seguinte da grade.
        const de = formatarData(new Date(y, m - 1, 1));
        const ate = formatarData(new Date(y, m + 2, 1)) + 'T23:59';
        const [rEventos, rAgend] = await Promise.all([
            fetch(`/api/agenda?mes=${mes}&ano=${ano}`).then(r => r.json()).catch(() => ({})),
            fetch(`/api/crm/atividades?de=${de}&ate=${ate}`).then(r => r.json()).catch(() => ({}))
        ]);
        eventos = rEventos.data || [];
        agendamentos = rAgend.atividades || [];
        renderizarCalendario();
    } catch (error) {
        console.error('Erro ao carregar agenda:', error);
    }
}

function renderizarCalendario() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    // Atualizar título
    document.getElementById('currentMonth').textContent = `${meses[month]} ${year}`;

    // Primeiro dia do mês
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Dia da semana do primeiro dia (0 = Dom, 6 = Sab)
    const startDay = firstDay.getDay();
    const totalDays = lastDay.getDate();

    // Dias do mês anterior
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    const container = document.getElementById('calendarDays');
    container.innerHTML = '';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Dias do mês anterior
    for (let i = startDay - 1; i >= 0; i--) {
        const day = prevMonthLastDay - i;
        const div = criarDia(day, true, new Date(year, month - 1, day));
        container.appendChild(div);
    }

    // Dias do mês atual
    for (let day = 1; day <= totalDays; day++) {
        const date = new Date(year, month, day);
        const isToday = date.getTime() === today.getTime();
        const div = criarDia(day, false, date, isToday);
        container.appendChild(div);
    }

    // Dias do próximo mês para completar a grade
    const remainingDays = 42 - (startDay + totalDays);
    for (let day = 1; day <= remainingDays; day++) {
        const div = criarDia(day, true, new Date(year, month + 1, day));
        container.appendChild(div);
    }
}

function criarDia(day, isOtherMonth, date, isToday = false) {
    const div = document.createElement('div');
    div.className = 'calendar-day';
    if (isOtherMonth) div.classList.add('other-month');
    if (isToday) div.classList.add('today');

    const dayNumber = document.createElement('div');
    dayNumber.className = 'day-number';
    dayNumber.textContent = day;
    div.appendChild(dayNumber);

    // Buscar eventos para este dia
    const dateStr = formatarData(date);
    const eventosHoje = eventos.filter(e => {
        if (!e.dataEncerramentoProposta) return false;
        const eventDate = e.dataEncerramentoProposta.split('T')[0];
        return eventDate === dateStr;
    });

    if (eventosHoje.length > 0) {
        const eventsDiv = document.createElement('div');
        eventsDiv.className = 'day-events';

        eventosHoje.forEach(evento => {
            const eventEl = document.createElement('div');
            eventEl.className = 'day-event';

            // Status visual
            const agora = new Date();
            const dataEnc = new Date(evento.dataEncerramentoProposta);
            if (dataEnc < agora) {
                eventEl.classList.add('status-vencida');
            } else if (evento.status === 'enviada') {
                eventEl.classList.add('status-enviada');
            } else if (evento.status === 'proposta') {
                eventEl.classList.add('status-proposta');
            } else {
                eventEl.classList.add('status-analise');
            }

            eventEl.textContent = truncar(evento.objetoCompra || 'Sem objeto', 30);
            eventEl.title = evento.objetoCompra;
            eventEl.onclick = () => abrirModal(evento);
            eventsDiv.appendChild(eventEl);
        });

        div.appendChild(eventsDiv);
    }

    // Agendamentos do CRM (atividades) neste dia
    const agendHoje = agendamentos.filter(a => a.dataHora && a.dataHora.split('T')[0] === dateStr);
    if (agendHoje.length > 0) {
        const agDiv = document.createElement('div');
        agDiv.className = 'day-events';
        agendHoje.forEach(ag => {
            const el = document.createElement('div');
            el.className = 'day-event agend-event' + (ag.concluida ? ' agend-done' : '');
            const hora = (ag.dataHora.split('T')[1] || '').slice(0, 5);
            el.textContent = (hora ? hora + ' ' : '') + truncar(ag.titulo || 'Agendamento', 26);
            el.title = `${TIPO_AGEND_LABEL[ag.tipo] || ag.tipo} — ${ag.titulo || ''}${ag.clienteNome ? ' · ' + ag.clienteNome : ''}`;
            el.onclick = () => abrirModalAgend(ag);
            agDiv.appendChild(el);
        });
        div.appendChild(agDiv);
    }

    return div;
}

function formatarData(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function truncar(texto, max) {
    if (texto.length <= max) return texto;
    return texto.substring(0, max) + '...';
}

function mesAnterior() {
    currentDate.setMonth(currentDate.getMonth() - 1);
    carregarEventos();
}

function proximoMes() {
    currentDate.setMonth(currentDate.getMonth() + 1);
    carregarEventos();
}

function irParaHoje() {
    currentDate = new Date();
    carregarEventos();
}

function abrirModal(evento) {
    eventoSelecionado = evento;

    document.getElementById('modalObjeto').textContent = evento.objetoCompra || 'Não disponível';
    document.getElementById('modalOrgao').textContent = evento.nomeOrgao || 'Não disponível';
    document.getElementById('modalModalidade').textContent = evento.modalidadeNome || 'Não disponível';
    document.getElementById('modalItens').textContent = evento.qtdItens + ' item(s)';

    const dataEnc = new Date(evento.dataEncerramentoProposta);
    document.getElementById('modalData').textContent = dataEnc.toLocaleString('pt-BR');

    // Status
    const agora = new Date();
    let statusText = 'Em análise';
    if (dataEnc < agora) {
        statusText = 'Encerrada';
    } else if (evento.status === 'enviada') {
        statusText = 'Proposta enviada';
    } else if (evento.status === 'proposta') {
        statusText = 'Preparando proposta';
    }
    document.getElementById('modalStatus').textContent = statusText;

    // Botão "Enviar proposta" direciona pra tela do portal de origem (quando temos
    // integração: BNC/BLL/PCP têm tela própria; Comprasnet federal usa Propostas via API).
    const alvo = portalProposta(evento);
    const btnProp = document.getElementById('btnEnviarProposta');
    if (alvo) {
        btnProp.style.display = '';
        btnProp.textContent = '📝 Enviar proposta ' + alvo.label;
    } else {
        btnProp.style.display = 'none';
    }

    document.getElementById('eventModal').classList.add('open');
}

// Resolve pra qual tela de proposta um evento deve ir, conforme o portal de origem.
// BNC/BLL/PCP → tela própria (deep-link por pncp). Comprasnet federal → Propostas via API.
// Outros portais (sem integração) → null (botão não aparece).
function portalProposta(evento) {
    const link = evento.linkSistemaOrigem || '';
    const pncp = `${evento.cnpj}-${evento.ano}-${evento.sequencial}`;
    if (/bnccompras\.com/i.test(link)) return { label: 'BNC', url: `/portais/bnc-proposta.html?pncp=${pncp}` };
    if (/bllcompras\.com/i.test(link)) return { label: 'BLL', url: `/portais/bll-proposta.html?pncp=${pncp}` };
    if (/portaldecompraspublicas\.com\.br/i.test(link)) return { label: 'PCP', url: `/portais/pcp-proposta.html?pncp=${pncp}` };
    if (/comprasnet\.gov\.br|compras\.gov\.br|gov\.br\/compras|cnetmobile/i.test(link)) return { label: 'Comprasnet', url: '/operacional/propostas-api.html' };
    return null;
}

function enviarProposta() {
    if (!eventoSelecionado) return;
    const alvo = portalProposta(eventoSelecionado);
    if (!alvo) return;
    window.location.href = alvo.url;
}

function fecharModal() {
    document.getElementById('eventModal').classList.remove('open');
    eventoSelecionado = null;
}

function verEmInteresses() {
    if (!eventoSelecionado) return;
    const { cnpj, ano, sequencial } = eventoSelecionado;
    window.location.href = `/licitacoes/interesse.html?lic=${cnpj}-${ano}-${sequencial}`;
}

function abrirCrmFunil() {
    window.location.href = '/comercial/crm-funil.html';
}

// ----- Agendamentos do CRM -----
function abrirModalAgend(ag) {
    agendSelecionado = ag;
    document.getElementById('agModalTipo').textContent = TIPO_AGEND_LABEL[ag.tipo] || ag.tipo || '—';
    document.getElementById('agModalTitulo').textContent = ag.titulo || '—';
    document.getElementById('agModalCliente').textContent = ag.clienteNome || '—';
    document.getElementById('agModalOp').textContent = ag.oportunidadeTitulo || '—';
    document.getElementById('agModalData').textContent = ag.dataHora ? new Date(ag.dataHora).toLocaleString('pt-BR') : '—';
    document.getElementById('agModalComent').textContent = ag.descricao || '—';
    document.getElementById('agModalStatus').textContent = ag.concluida ? '✅ Concluída' : '⏳ Pendente';
    document.getElementById('btnConcluirAgend').style.display = ag.concluida ? 'none' : '';
    document.getElementById('agendModal').classList.add('open');
}
function fecharModalAgend() {
    document.getElementById('agendModal').classList.remove('open');
    agendSelecionado = null;
}
async function concluirAgend() {
    if (!agendSelecionado) return;
    try {
        const r = await fetch(`/api/crm/atividades/${agendSelecionado.id}/concluir`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error);
        fecharModalAgend();
        carregarEventos();
    } catch (e) {
        alert('Erro ao concluir: ' + e.message);
    }
}
function verOportunidadeAgend() {
    if (!agendSelecionado || !agendSelecionado.oportunidadeId) return abrirCrmFunil();
    window.location.href = '/comercial/crm-oportunidade.html?id=' + agendSelecionado.oportunidadeId;
}

// Fechar modal ao clicar fora ou com ESC
document.getElementById('eventModal').addEventListener('click', (e) => {
    if (e.target.id === 'eventModal') fecharModal();
});
document.getElementById('agendModal').addEventListener('click', (e) => {
    if (e.target.id === 'agendModal') fecharModalAgend();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { fecharModal(); fecharModalAgend(); }
});

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', carregarEventos);
