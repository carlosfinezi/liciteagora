let currentDate = new Date();
let eventos = [];
let agendamentos = [];      // atividades do CRM (agendamentos com data/hora)
let eventoSelecionado = null;
let agendSelecionado = null;
let ocultarEncerradas = false;
let visao = 'mes';          // 'mes' (grade) ou 'lista' (agenda agrupada por dia)

// Quantas pílulas cabem na célula antes de virar "+N mais" (mantém a grade alinhada).
const MAX_EVENTOS_DIA = 3;

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
        renderizar();
    } catch (error) {
        console.error('Erro ao carregar agenda:', error);
    }
}

// Decide qual das duas visões desenhar. Ambas leem os mesmos dados já carregados.
function renderizar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    document.getElementById('currentMonth').textContent = `${meses[month]} ${year}`;

    const cal = document.querySelector('.calendar');
    const lista = document.getElementById('agendaLista');
    if (visao === 'lista') {
        cal.style.display = 'none';
        lista.style.display = '';
        renderizarLista();
    } else {
        cal.style.display = '';
        lista.style.display = 'none';
        renderizarCalendario();
    }
}

function setVisao(v) {
    visao = v;
    document.getElementById('viewMes').className = 'btn btn-sm ' + (v === 'mes' ? 'btn-primary' : 'btn-ghost');
    document.getElementById('viewLista').className = 'btn btn-sm ' + (v === 'lista' ? 'btn-primary' : 'btn-ghost');
    renderizar();
}

function renderizarCalendario() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

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

    const dateStr = formatarData(date);
    const itens = itensDoDia(dateStr);

    if (itens.length > 0) {
        const eventsDiv = document.createElement('div');
        eventsDiv.className = 'day-events';

        itens.slice(0, MAX_EVENTOS_DIA).forEach(item => eventsDiv.appendChild(criarEventoEl(item)));

        if (itens.length > MAX_EVENTOS_DIA) {
            const more = document.createElement('div');
            more.className = 'day-more';
            more.textContent = `+${itens.length - MAX_EVENTOS_DIA} mais`;
            more.onclick = () => abrirModalDia(date, itens);
            eventsDiv.appendChild(more);
        }

        div.appendChild(eventsDiv);
    }

    return div;
}

// Licitações + agendamentos do CRM de um dia, na mesma lista e em ordem cronológica.
function itensDoDia(dateStr) {
    const agora = new Date();
    const itens = [];

    eventos.forEach(evento => {
        if (!evento.dataEncerramentoProposta) return;
        if (evento.dataEncerramentoProposta.split('T')[0] !== dateStr) return;

        const dataEnc = new Date(evento.dataEncerramentoProposta);
        let classe;
        if (dataEnc < agora) classe = 'status-vencida';
        else if (evento.status === 'enviada') classe = 'status-enviada';
        else if (evento.status === 'proposta') classe = 'status-proposta';
        else classe = 'status-analise';

        if (ocultarEncerradas && classe === 'status-vencida') return;

        itens.push({
            hora: (evento.dataEncerramentoProposta.split('T')[1] || '').slice(0, 5),
            classe,
            texto: truncar(evento.objetoCompra || 'Sem objeto', 30),
            title: evento.objetoCompra || '',
            abrir: () => abrirModal(evento)
        });
    });

    agendamentos.forEach(ag => {
        if (!ag.dataHora || ag.dataHora.split('T')[0] !== dateStr) return;
        if (ocultarEncerradas && ag.concluida) return;
        itens.push({
            hora: (ag.dataHora.split('T')[1] || '').slice(0, 5),
            classe: 'agend-event' + (ag.concluida ? ' agend-done' : ''),
            texto: truncar(ag.titulo || 'Agendamento', 26),
            title: `${TIPO_AGEND_LABEL[ag.tipo] || ag.tipo} — ${ag.titulo || ''}${ag.clienteNome ? ' · ' + ag.clienteNome : ''}`,
            abrir: () => abrirModalAgend(ag)
        });
    });

    // Sem hora vai para o fim.
    itens.sort((a, b) => (a.hora || '99:99').localeCompare(b.hora || '99:99'));
    return itens;
}

// `completo`: usa a descrição inteira em vez da truncada (lista e modal têm largura de sobra).
function criarEventoEl(item, completo = false) {
    const el = document.createElement('div');
    el.className = 'day-event ' + item.classe;
    if (item.hora) {
        const h = document.createElement('span');
        h.className = 'ev-hora';
        h.textContent = item.hora;
        el.appendChild(h);
    }
    el.appendChild(document.createTextNode(completo ? (item.title || item.texto) : item.texto));
    el.title = item.title;
    el.onclick = item.abrir;
    return el;
}

// Visão lista: só os dias do mês que têm algo, em ordem, sem células vazias.
function renderizarLista() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const totalDays = new Date(year, month + 1, 0).getDate();
    const hojeStr = formatarData(new Date());

    const container = document.getElementById('agendaLista');
    container.innerHTML = '';
    let total = 0;

    for (let day = 1; day <= totalDays; day++) {
        const date = new Date(year, month, day);
        const dateStr = formatarData(date);
        const itens = itensDoDia(dateStr);
        if (itens.length === 0) continue;
        total += itens.length;

        const grupo = document.createElement('div');
        grupo.className = 'lista-dia' + (dateStr === hojeStr ? ' is-hoje' : '');

        const head = document.createElement('div');
        head.className = 'lista-dia-head';
        const label = document.createElement('strong');
        label.textContent = date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
        const cont = document.createElement('span');
        cont.textContent = `${itens.length} item(s)`;
        head.appendChild(label);
        head.appendChild(cont);
        grupo.appendChild(head);

        const corpo = document.createElement('div');
        corpo.className = 'dia-lista';
        itens.forEach(item => corpo.appendChild(criarEventoEl(item, true)));
        grupo.appendChild(corpo);

        container.appendChild(grupo);
    }

    if (total === 0) {
        const vazio = document.createElement('div');
        vazio.className = 'lista-vazia';
        vazio.textContent = ocultarEncerradas
            ? 'Nada em aberto neste mês.'
            : 'Nenhum compromisso neste mês.';
        container.appendChild(vazio);
    }
}

function toggleEncerradas(el) {
    ocultarEncerradas = el.checked;
    renderizar();
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

// ----- Dia cheio ("+N mais") -----
function abrirModalDia(date, itens) {
    document.getElementById('diaModalTitulo').textContent = date.toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });
    document.getElementById('diaModalCount').textContent = `${itens.length} item(s)`;

    const lista = document.getElementById('diaModalLista');
    lista.innerHTML = '';
    itens.forEach(item => {
        const el = criarEventoEl(item, true);
        el.onclick = () => { fecharModalDia(); item.abrir(); };
        lista.appendChild(el);
    });

    document.getElementById('diaModal').classList.add('open');
}

function fecharModalDia() {
    document.getElementById('diaModal').classList.remove('open');
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
document.getElementById('diaModal').addEventListener('click', (e) => {
    if (e.target.id === 'diaModal') fecharModalDia();
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { fecharModal(); fecharModalAgend(); fecharModalDia(); }
});

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', carregarEventos);
