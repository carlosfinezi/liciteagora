let currentDate = new Date();
let eventos = [];
let eventoSelecionado = null;

const meses = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

async function carregarEventos() {
    try {
        const response = await fetch('/api/agenda');
        const result = await response.json();
        eventos = result.data || [];
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
    renderizarCalendario();
}

function proximoMes() {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderizarCalendario();
}

function irParaHoje() {
    currentDate = new Date();
    renderizarCalendario();
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

    // Botão abrir sistema
    const btnAbrir = document.getElementById('btnAbrirSistema');
    if (evento.linkSistemaOrigem) {
        btnAbrir.style.display = 'block';
    } else {
        btnAbrir.style.display = 'none';
    }

    document.getElementById('eventModal').classList.add('show');
}

function fecharModal() {
    document.getElementById('eventModal').classList.remove('show');
    eventoSelecionado = null;
}

function abrirSistema() {
    if (eventoSelecionado && eventoSelecionado.linkSistemaOrigem) {
        let url = eventoSelecionado.linkSistemaOrigem;
        if (!url.startsWith('http')) url = 'https://' + url;
        window.open(url, '_blank');
    }
}

function abrirKanban() {
    window.location.href = 'kanban.html';
}

// Fechar modal ao clicar fora
document.getElementById('eventModal').addEventListener('click', (e) => {
    if (e.target.id === 'eventModal') {
        fecharModal();
    }
});

// Carregar ao iniciar
document.addEventListener('DOMContentLoaded', carregarEventos);
