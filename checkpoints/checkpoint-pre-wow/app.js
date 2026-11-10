/**
 * Fio Fino Barbearia — lógica do site (sem frameworks).
 *
 * Fluxo de agendamento: Serviço → Profissional → Dia → Horário → Nome + WhatsApp.
 * Tempo real: escuta /api/eventos (SSE). Se um horário for reservado em outro canal
 * (outro navegador, IA no WhatsApp, painel), a grade é recarregada na hora.
 */
const CFG = window.FIOFINO_CONFIG;
const TZ = 'America/Fortaleza';
const DIAS_EXIBIDOS = 30; // Janela completa de 1 mês (30 dias) para agendamentos
const LS_CLIENTE = 'fiofino:cliente';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ═════════════════════════════ Estado ═════════════════════════════
const estado = {
  servicos: [],
  barbeiros: [],
  servico: null,   // objeto
  barbeiro: null,  // objeto
  data: null,      // 'YYYY-MM-DD'
  inicio: null,    // 'YYYY-MM-DDTHH:MM'
  grade: [],       // horários do dia carregado
  enviando: false, // trava o listener SSE enquanto o próprio cliente está enviando
};
let controleHorarios = null; // AbortController da busca de horários em andamento

// ═════════════════════════════ API ═════════════════════════════
async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    headers: { 'Content-Type': 'application/json' },
    ...opcoes,
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error(json?.erro?.mensagem || 'Não foi possível concluir. Tente novamente.');
    erro.status = resp.status;
    erro.codigo = json?.erro?.codigo;
    erro.detalhes = json?.erro?.detalhes;
    throw erro;
  }
  return json;
}

// ═════════════════════════════ Datas (fuso da barbearia) ═════════════════════════════
function hojeNaBarbearia() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function somarDias(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaSemana = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();
const SEMANA_CURTA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const SEMANA_LONGA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function dataHumana(inicio) {
  const [data, hora] = inicio.split('T');
  const [, m, d] = data.split('-');
  return `${SEMANA_LONGA[diaSemana(data)]}, ${d}/${m} às ${hora}`;
}

// ═════════════════════════════ WhatsApp ═════════════════════════════
function mascaraWhatsapp(valor) {
  const d = valor.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '').slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 3)} ${d.slice(3, 7)}-${d.slice(7)}`;
}
const whatsappValido = (v) => /^\d{10,11}$/.test(v.replace(/\D/g, ''));
const linkWhatsapp = (texto) => `https://wa.me/${CFG.whatsappIA}?text=${encodeURIComponent(texto)}`;

// ═════════════════════════════ Conteúdo institucional ═════════════════════════════
function preencherInstitucional() {
  $('#ano').textContent = new Date().getFullYear();
  $$('[data-texto]').forEach((el) => { el.textContent = CFG[el.dataset.texto] ?? ''; });

  const links = {
    instagram: CFG.instagram,
    'whatsapp-ia': linkWhatsapp(CFG.mensagemWhatsapp),
    maps: CFG.mapsUrl,
  };
  $$('[data-link]').forEach((el) => { el.href = links[el.dataset.link] ?? '#'; });

  // Botões dos barbeiros na seção de contatos alternativos
  const htmlBarbeiros = (CFG.barbeirosContato || []).map((b) => {
    if (b.ativo && b.telefone) {
      return `
        <a href="tel:+${b.telefone}" class="btn-contato">
          <span class="btn-contato__icone"><svg class="ico"><use href="#i-phone"/></svg></span>
          <span class="btn-contato__info">
            <span class="btn-contato__cargo">${esc(b.cargo)} · ${esc(b.nome)}</span>
            <span class="btn-contato__num">${esc(b.telefoneFormatado)}</span>
          </span>
        </a>`;
    }
    return `
      <div class="btn-contato btn-contato--breve" aria-disabled="true">
        <span class="btn-contato__icone">✦</span>
        <span class="btn-contato__info">
          <span class="btn-contato__cargo">${esc(b.cargo)}</span>
          <span class="btn-contato__num">Em breve</span>
        </span>
      </div>`;
  }).join('');
  $$('[data-lista="barbeiros-contato"]').forEach((el) => { el.innerHTML = htmlBarbeiros; });

  // Bloco de Suporte / Dúvidas e Auxílio (Administração)
  if (CFG.suporteContato) {
    const s = CFG.suporteContato;
    const htmlSuporte = `
      <div class="suporte-card">
        <div class="suporte-card__cabecalho">
          <span class="suporte-card__tag">Recepção & Administração</span>
          <h3 class="suporte-card__titulo">${esc(s.titulo)}</h3>
          <p class="suporte-card__desc">${esc(s.subtitulo)}</p>
        </div>
        <a href="tel:+${s.telefone}" class="btn btn--contorno btn--bloco suporte-card__btn">
          <svg class="ico"><use href="#i-phone"/></svg>
          <span>Ligar · ${esc(s.telefoneFormatado)}</span>
        </a>
      </div>`;
    $$('[data-bloco="suporte-contato"]').forEach((el) => { el.innerHTML = htmlSuporte; });
  }

  // Contatos resumidos no Rodapé
  const barbeiroAtivo = (CFG.barbeirosContato || []).find((b) => b.ativo && b.telefone);
  const sup = CFG.suporteContato;
  const htmlRodape = [
    barbeiroAtivo ? `
      <a href="tel:+${barbeiroAtivo.telefone}" class="btn btn--contorno btn--sm">
        <svg class="ico"><use href="#i-phone"/></svg>
        <span>Barbeiros · ${esc(barbeiroAtivo.telefoneFormatado)}</span>
      </a>` : '',
    sup ? `
      <a href="tel:+${sup.telefone}" class="btn btn--contorno btn--sm">
        <svg class="ico"><use href="#i-phone"/></svg>
        <span>Dúvidas · ${esc(sup.telefoneFormatado)}</span>
      </a>` : '',
  ].join('');
  $$('[data-lista="rodape-contatos"]').forEach((el) => { el.innerHTML = htmlRodape; });
}

function configurarTopo() {
  const topo = $('#topo');
  const hero = $('#inicio');
  new IntersectionObserver(([e]) => topo.classList.toggle('topo--visivel', !e.isIntersecting), { threshold: 0.15 })
    .observe(hero);
}

// ═════════════════════════════ Serviços ═════════════════════════════
function renderTabelaServicos() {
  $('#tabela-servicos-corpo').innerHTML = estado.servicos.map((s) => `
    <div class="menu-item" role="listitem">
      <div class="menu-item__info">
        <div class="menu-item__topo">
          <span class="servico__nome">${esc(s.nome)}</span>
          <span class="servico__tempo"><svg class="ico"><use href="#i-clock"/></svg>${s.duracao_min} min</span>
        </div>
        ${s.descricao ? `<p class="servico__desc">${esc(s.descricao)}</p>` : ''}
      </div>
      <div class="menu-item__preco">
        ${s.preco_a_partir ? '<span class="servico__apartir">a partir de</span>' : ''}
        <span class="servico__preco">${reais(s.preco_centavos)}</span>
      </div>
    </div>`).join('');
}

function renderOpcoesServicos() {
  $('#opcoes-servicos').innerHTML = estado.servicos.map((s) => `
    <label class="opcao">
      <input type="radio" name="servico" value="${s.id}" />
      <span class="opcao__caixa">
        <span><span class="opcao__titulo">${esc(s.nome)}</span><span class="opcao__sub">${s.duracao_min} min</span></span>
        <span class="opcao__preco">${s.preco_a_partir ? 'a partir de ' : ''}${reais(s.preco_centavos)}</span>
      </span>
    </label>`).join('');
}

function renderOpcoesBarbeiros() {
  $('#opcoes-barbeiros').innerHTML = estado.barbeiros.map((b) => {
    const isAtivo = b.ativo === 1;
    return `
      <label class="opcao opcao--barbeiro ${isAtivo ? '' : 'opcao--indisponivel'}">
        <input type="radio" name="barbeiro" value="${b.id}" ${isAtivo ? '' : 'disabled'} />
        <span class="opcao__caixa">
          ${b.foto_url
            ? `<img class="avatar" src="${esc(b.foto_url)}" alt="" loading="lazy" />`
            : `<span class="avatar ${isAtivo ? '' : 'avatar--breve'}" aria-hidden="true">${isAtivo ? esc(b.nome.trim()[0]) : '✦'}</span>`}
          <span class="opcao__detalhes">
            <span class="opcao__titulo">${esc(b.nome)}</span>
            ${b.bio ? `<span class="opcao__sub">${esc(b.bio)}</span>` : ''}
          </span>
          ${isAtivo ? '<span class="opcao__status-pill">Disponível</span>' : '<span class="badge-breve">Em breve</span>'}
        </span>
      </label>`;
  }).join('');
}

function renderDias() {
  const hoje = hojeNaBarbearia();
  const atende = new Set(estado.barbeiro?.dias_atendimento ?? [0, 1, 2, 3, 4, 5, 6]);
  const html = [];
  for (let i = 0; i < DIAS_EXIBIDOS; i++) {
    const data = somarDias(hoje, i);
    const [, m, d] = data.split('-');
    const fechado = !atende.has(diaSemana(data));
    const rotulo = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : SEMANA_CURTA[diaSemana(data)];
    html.push(`
      <label class="opcao dia">
        <input type="radio" name="data" value="${data}" ${fechado ? 'disabled' : ''} ${estado.data === data && !fechado ? 'checked' : ''}
               aria-label="${SEMANA_LONGA[diaSemana(data)]}, ${d}/${m}${fechado ? ' (fechado)' : ''}" />
        <span class="opcao__caixa">
          <span class="dia__semana">${rotulo}</span>
          <span class="dia__num">${d}</span>
          <span class="dia__mes">${MESES[Number(m) - 1]}</span>
        </span>
      </label>`);
  }
  $('#opcoes-dias').innerHTML = html.join('');

  // Se o dia escolhido ficou indisponível (troca de barbeiro), limpa a seleção
  if (estado.data && !atende.has(diaSemana(estado.data))) {
    estado.data = null;
    estado.inicio = null;
  }
}

// ═════════════════════════════ Horários ═════════════════════════════
async function carregarHorarios({ silencioso = false } = {}) {
  const alvo = $('#opcoes-horarios');
  if (!estado.servico || !estado.barbeiro || !estado.data) {
    alvo.innerHTML = '<p class="dica">Selecione serviço, profissional e dia.</p>';
    return;
  }

  controleHorarios?.abort(); // descarta respostas antigas (cliques rápidos)
  controleHorarios = new AbortController();
  if (!silencioso) alvo.innerHTML = '<p class="dica">Carregando horários…</p>';

  const qs = new URLSearchParams({ barbeiro_id: estado.barbeiro.id, servico_id: estado.servico.id, data: estado.data });
  try {
    const resp = await fetch(`/api/horarios-disponiveis?${qs}`, { signal: controleHorarios.signal, cache: 'no-store' });
    const grade = await resp.json();
    if (!resp.ok) throw new Error(grade?.erro?.mensagem);
    estado.grade = grade.horarios;
    renderHorarios(grade);
  } catch (e) {
    if (e.name === 'AbortError') return;
    alvo.innerHTML = '<p class="dica">Não foi possível carregar os horários. <button type="button" class="btn btn--sm btn--contorno" id="tentar-novamente">Tentar novamente</button></p>';
    $('#tentar-novamente')?.addEventListener('click', () => carregarHorarios());
  }
}

function renderHorarios(grade) {
  const alvo = $('#opcoes-horarios');
  if (grade.fechado || grade.horarios.length === 0) {
    alvo.innerHTML = '<p class="dica">Sem atendimento neste dia. Escolha outra data.</p>';
    return selecionarHorario(null);
  }
  const livres = grade.horarios.filter((h) => h.disponivel);
  if (livres.length === 0) {
    alvo.innerHTML = '<p class="dica">Agenda lotada neste dia 😕 Tente outro dia ou outro profissional.</p>';
    return selecionarHorario(null);
  }

  alvo.innerHTML = grade.horarios.map((h) => `
    <label class="opcao horario">
      <input type="radio" name="horario" value="${h.inicio}" ${h.disponivel ? '' : 'disabled'}
             ${estado.inicio === h.inicio && h.disponivel ? 'checked' : ''}
             aria-label="${h.hora}${h.disponivel ? '' : ' (ocupado)'}" />
      <span class="opcao__caixa">${h.hora}</span>
    </label>`).join('');
}

function selecionarHorario(inicio) {
  estado.inicio = inicio;
  atualizarEtapas();
}

// ═════════════════════════════ Etapas / resumo ═════════════════════════════
function atualizarEtapas() {
  $('#etapa-barbeiro').disabled = !estado.servico;
  $('#etapa-data').disabled = !estado.barbeiro;
  $('#etapa-horario').disabled = !estado.data;
  $('#etapa-dados').disabled = !estado.inicio;

  const completo = estado.servico && estado.barbeiro && estado.inicio;
  $('#resumo').hidden = !estado.servico;
  $('#resumo-servico').textContent = estado.servico?.nome ?? '—';
  $('#resumo-barbeiro').textContent = estado.barbeiro?.nome ?? '—';
  $('#resumo-quando').textContent = estado.inicio ? dataHumana(estado.inicio) : '—';
  $('#resumo-valor').textContent = estado.servico
    ? `${estado.servico.preco_a_partir ? 'a partir de ' : ''}${reais(estado.servico.preco_centavos)}` : '—';

  $('#btn-confirmar').disabled = !completo;
}

function rolarPara(el) {
  if (!el) return;
  // Rola suavemente para a próxima etapa em qualquer dispositivo
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mostrarAlerta(texto, tipo = 'erro') {
  const el = $('#alerta');
  el.textContent = texto;
  el.className = `alerta${tipo === 'info' ? ' alerta--info' : ''}`;
  el.hidden = !texto;
}

// ═════════════════════════════ Eventos do formulário ═════════════════════════════
function configurarFormulario() {
  const form = $('#form-agendamento');

  form.addEventListener('change', (e) => {
    const { name, value } = e.target;
    mostrarAlerta('');

    if (name === 'servico') {
      estado.servico = estado.servicos.find((s) => s.id === Number(value));
      estado.inicio = null;
      atualizarEtapas();
      carregarHorarios();
      // Se não escolheu barbeiro, rola para a etapa do barbeiro; se já tiver um pré-selecionado, vai direto para a data
      setTimeout(() => {
        if (!estado.barbeiro) {
          rolarPara($('#etapa-barbeiro'));
        } else {
          rolarPara($('#etapa-data'));
        }
      }, 100);
    }
    if (name === 'barbeiro') {
      estado.barbeiro = estado.barbeiros.find((b) => b.id === Number(value));
      estado.inicio = null;
      renderDias();
      atualizarEtapas();
      carregarHorarios();
      setTimeout(() => rolarPara($('#etapa-data')), 100);
    }
    if (name === 'data') {
      estado.data = value;
      estado.inicio = null;
      atualizarEtapas();
      carregarHorarios();
      setTimeout(() => rolarPara($('#etapa-horario')), 100);
    }
    if (name === 'horario') {
      selecionarHorario(value);
      setTimeout(() => {
        rolarPara($('#etapa-dados'));
        const nome = $('#nome');
        if (!nome.value) setTimeout(() => nome.focus({ preventScroll: true }), 300);
      }, 100);
    }
  });

  const whats = $('#whatsapp');
  whats.addEventListener('input', () => {
    whats.value = mascaraWhatsapp(whats.value);
    whats.removeAttribute('aria-invalid');
  });
  $('#nome').addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

  form.addEventListener('submit', enviarAgendamento);
  $('#btn-novo').addEventListener('click', reiniciar);

  // Cliente recorrente: preenche nome e WhatsApp automaticamente (fricção zero)
  try {
    const salvo = JSON.parse(localStorage.getItem(LS_CLIENTE) || 'null');
    if (salvo) {
      $('#nome').value = salvo.nome ?? '';
      whats.value = mascaraWhatsapp(salvo.whatsapp ?? '');
    }
  } catch { /* localStorage indisponível */ }
}

async function enviarAgendamento(e) {
  e.preventDefault();
  const nome = $('#nome');
  const whats = $('#whatsapp');
  let valido = true;

  if (nome.value.trim().length < 2) { nome.setAttribute('aria-invalid', 'true'); valido = false; }
  if (!whatsappValido(whats.value)) { whats.setAttribute('aria-invalid', 'true'); valido = false; }
  if (!valido) {
    mostrarAlerta('Confira seu nome e WhatsApp (com DDD).');
    (nome.getAttribute('aria-invalid') ? nome : whats).focus();
    return;
  }

  const botao = $('#btn-confirmar');
  botao.disabled = true;
  botao.textContent = 'Reservando…';
  estado.enviando = true;
  mostrarAlerta('');

  try {
    const { agendamento } = await api('/api/agendamentos', {
      method: 'POST',
      body: {
        nome: nome.value.trim(),
        whatsapp: whats.value.replace(/\D/g, ''),
        barbeiro_id: estado.barbeiro.id,
        servico_id: estado.servico.id,
        inicio: estado.inicio,
        website: $('#website').value, // honeypot
      },
    });
    try {
      localStorage.setItem(LS_CLIENTE, JSON.stringify({ nome: nome.value.trim(), whatsapp: whats.value.replace(/\D/g, '') }));
    } catch { /* ignore */ }
    mostrarSucesso(agendamento);
  } catch (erro) {
    if (erro.codigo === 'HORARIO_INDISPONIVEL') {
      mostrarAlerta('Esse horário acabou de ser reservado por outra pessoa. Escolha outro, por favor.');
      estado.inicio = null;
      await carregarHorarios({ silencioso: true });
      rolarPara($('#etapa-horario'));
    } else {
      mostrarAlerta(erro.message);
    }
  } finally {
    estado.enviando = false;
    botao.textContent = 'Confirmar agendamento';
    atualizarEtapas();
  }
}

function mostrarSucesso(ag) {
  const primeiroNome = $('#nome').value.trim().split(' ')[0];
  $('#sucesso-texto').innerHTML =
    `<strong>${esc(primeiroNome)}</strong>, seu <strong>${esc(ag.servico_nome)}</strong> com <strong>${esc(ag.barbeiro_nome)}</strong> ` +
    `está marcado para <strong>${esc(dataHumana(ag.inicio))}</strong>. Valor: ${reais(ag.valor_centavos)}.`;
  $('#sucesso a[data-link="whatsapp-ia"]').href =
    linkWhatsapp(`Olá! Fiz um agendamento pelo site: ${ag.servico_nome} com ${ag.barbeiro_nome}, ${dataHumana(ag.inicio)}.`);
  $('#form-agendamento').hidden = true;
  const sucesso = $('#sucesso');
  sucesso.hidden = false;
  sucesso.focus();
  sucesso.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function reiniciar() {
  const ativos = estado.barbeiros.filter((b) => b.ativo === 1);
  const barbeiroPadrao = ativos.length === 1 ? ativos[0] : null;
  Object.assign(estado, { servico: null, barbeiro: barbeiroPadrao, data: null, inicio: null, grade: [], enviando: false });
  $$('#form-agendamento input[type="radio"]').forEach((r) => { r.checked = false; });
  if (barbeiroPadrao) {
    const radio = $(`#opcoes-barbeiros input[value="${barbeiroPadrao.id}"]`);
    if (radio) radio.checked = true;
  }
  renderDias();
  carregarHorarios();
  atualizarEtapas();
  mostrarAlerta('');
  $('#sucesso').hidden = true;
  $('#form-agendamento').hidden = false;
  $('#etapa-servico').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ═════════════════════════════ Tempo real (SSE) ═════════════════════════════
function conectarTempoReal() {
  if (!('EventSource' in window)) return;
  const indicador = $('.ao-vivo');
  const fonte = new EventSource('/api/eventos');

  fonte.onopen = () => indicador?.classList.remove('ao-vivo--off');
  fonte.onerror = () => indicador?.classList.add('ao-vivo--off'); // o navegador reconecta sozinho

  fonte.addEventListener('agenda', async (ev) => {
    // Se este próprio navegador está enviando o agendamento ou já está na tela de sucesso, ignora o aviso
    if (estado.enviando || $('#form-agendamento').hidden) return;
    const { barbeiro_id, data } = JSON.parse(ev.data);
    if (!estado.barbeiro || barbeiro_id !== estado.barbeiro.id || data !== estado.data) return;

    const selecionado = estado.inicio;
    await carregarHorarios({ silencioso: true });

    // O horário que o cliente tinha escolhido foi reservado em outro canal?
    if (selecionado) {
      const slot = estado.grade.find((h) => h.inicio === selecionado);
      if (!slot?.disponivel) {
        selecionarHorario(null);
        mostrarAlerta('Ops! O horário que você escolheu acabou de ser reservado. Escolha outro abaixo.');
        rolarPara($('#etapa-horario'));
      }
    }
  });

  // Ao voltar para a aba depois de um tempo, garante dados frescos
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') carregarHorarios({ silencioso: true });
  });
}

// Garante que, ao recarregar a página (F5 ou refresh do navegador), sempre volte para o topo
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
window.addEventListener('beforeunload', () => {
  window.scrollTo(0, 0);
});

// ═════════════════════════════ Inicialização ═════════════════════════════
async function iniciar() {
  window.scrollTo(0, 0);
  preencherInstitucional();
  configurarTopo();
  configurarFormulario();
  renderDias();
  atualizarEtapas();

  try {
    const [{ servicos }, { barbeiros }] = await Promise.all([api('/api/servicos'), api('/api/barbeiros')]);
    estado.servicos = servicos;
    estado.barbeiros = barbeiros;
    renderTabelaServicos();
    renderOpcoesServicos();
    renderOpcoesBarbeiros();

    // Se só existir 1 profissional ativo, pré-seleciona (agiliza o fluxo)
    const ativos = barbeiros.filter((b) => b.ativo === 1);
    if (ativos.length === 1) {
      estado.barbeiro = ativos[0];
      const radio = $(`#opcoes-barbeiros input[value="${ativos[0].id}"]`);
      if (radio) radio.checked = true;
      renderDias();
    }
  } catch {
    $('#tabela-servicos-corpo').innerHTML =
      '<tr><td colspan="3" class="carregando">Não foi possível carregar os serviços. Atualize a página.</td></tr>';
    mostrarAlerta('Estamos com instabilidade. Você pode agendar pelo WhatsApp logo abaixo.', 'info');
  }

  conectarTempoReal();
}

iniciar();
