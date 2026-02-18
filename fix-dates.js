const fs = require('fs');
let app = fs.readFileSync('public/app.js', 'utf8');

// Update initialization dates
const oldInit = `// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    // Definir data padrão (últimos 30 dias até próximos 15 dias para publicação)
    const hoje = new Date();
    const trintaDiasAtras = new Date(hoje);
    trintaDiasAtras.setDate(hoje.getDate() - 30);

    const quinzeDiasFrente = new Date(hoje);
    quinzeDiasFrente.setDate(hoje.getDate() + 15);

    document.getElementById('dataPublicacaoInicial').valueAsDate = trintaDiasAtras;
    document.getElementById('dataPublicacaoFinal').valueAsDate = quinzeDiasFrente;

    // Event listeners`;

const newInit = `// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    // Definir datas padrão
    const hoje = new Date();

    // Publicação: último 1 ano até hoje
    const umAnoAtras = new Date(hoje);
    umAnoAtras.setFullYear(hoje.getFullYear() - 1);

    // Fim Propostas: amanhã até próximos 30 dias
    const amanha = new Date(hoje);
    amanha.setDate(hoje.getDate() + 1);

    const trintaDiasFrente = new Date(hoje);
    trintaDiasFrente.setDate(hoje.getDate() + 30);

    document.getElementById('dataPublicacaoInicial').valueAsDate = umAnoAtras;
    document.getElementById('dataPublicacaoFinal').valueAsDate = hoje;
    document.getElementById('dataAberturaInicial').valueAsDate = amanha;
    document.getElementById('dataAberturaFinal').valueAsDate = trintaDiasFrente;

    // Event listeners`;

if (app.includes(oldInit)) {
    app = app.replace(oldInit, newInit);
    console.log('Inicialização atualizada!');
} else {
    console.log('Padrão de inicialização não encontrado');
}

// Update limparFiltros dates
const oldLimpar = `    // Redefinir datas padrão (últimos 30 dias até próximos 15 dias para publicação)
    const hoje = new Date();
    const trintaDiasAtras = new Date(hoje);
    trintaDiasAtras.setDate(hoje.getDate() - 30);

    const quinzeDiasFrente = new Date(hoje);
    quinzeDiasFrente.setDate(hoje.getDate() + 15);

    document.getElementById('dataPublicacaoInicial').valueAsDate = trintaDiasAtras;
    document.getElementById('dataPublicacaoFinal').valueAsDate = quinzeDiasFrente;`;

const newLimpar = `    // Redefinir datas padrão
    const hoje = new Date();

    // Publicação: último 1 ano até hoje
    const umAnoAtras = new Date(hoje);
    umAnoAtras.setFullYear(hoje.getFullYear() - 1);

    // Fim Propostas: amanhã até próximos 30 dias
    const amanha = new Date(hoje);
    amanha.setDate(hoje.getDate() + 1);

    const trintaDiasFrente = new Date(hoje);
    trintaDiasFrente.setDate(hoje.getDate() + 30);

    document.getElementById('dataPublicacaoInicial').valueAsDate = umAnoAtras;
    document.getElementById('dataPublicacaoFinal').valueAsDate = hoje;
    document.getElementById('dataAberturaInicial').valueAsDate = amanha;
    document.getElementById('dataAberturaFinal').valueAsDate = trintaDiasFrente;`;

if (app.includes(oldLimpar)) {
    app = app.replace(oldLimpar, newLimpar);
    console.log('LimparFiltros atualizado!');
} else {
    console.log('Padrão de limparFiltros não encontrado');
}

fs.writeFileSync('public/app.js', app);
console.log('Arquivo salvo!');
