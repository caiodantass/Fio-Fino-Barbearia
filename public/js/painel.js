/**
 * Painel administrativo — relatório diário, agenda do dia e exportação para planilha.
 * Autenticação: ADMIN_TOKEN enviado no header Authorization (guardado no sessionStorage).
 */
const TZ = 'America/Fortaleza';
const SS_TOKEN = 'fiofino:admin-token';
const SS_DATA = 'fiofino:admin-data';

const $ = (s) => document.querySelector(s);
const reais = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatarWhats = (n) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(n ?? '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n;
};
const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const somarDias = (data, n) => {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const STATUS = {
  confirmado: 'Confirmado',
  concluido: 'Concluído',
  nao_compareceu: 'Faltou',
  cancelado: 'Cancelado',
};
const PAGAMENTOS = { pix: 'Pix', dinheiro: 'Dinheiro', debito: 'Débito', credito: 'Crédito', outro: 'Outro' };

let token = sessionStorage.getItem(SS_TOKEN);
// Recupera a data salva na sessão se o usuário recarregar a página (F5)
let dataAtual = sessionStorage.getItem(SS_DATA) || hoje();

// ═════════════════════════════ HTTP ═════════════════════════════
async function adminApi(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    ...opcoes,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    cache: 'no-store',
  });
  if (resp.status === 401) {
    sair();
    throw new Error('Sessão expirada ou token inválido.');
  }
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}));
    throw new Error(json?.erro?.mensagem || 'Erro ao comunicar com o servidor.');
  }
  return resp;
}

function toast(texto, erro = false) {
  const el = $('#toast');
  el.textContent = texto;
  el.className = `toast${erro ? ' toast--erro' : ''}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 3000);
}

// ═════════════════════════════ Login ═════════════════════════════
function mostrarTela() {
  $('#tela-login').hidden = Boolean(token);
  $('#tela-painel').hidden = !token;
  if (token) carregar();
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('#token').value.trim();
  try {
    await adminApi(`/admin/relatorio-diario?data=${dataAtual}`);
    sessionStorage.setItem(SS_TOKEN, token);
    $('#login-erro').hidden = true;
    mostrarTela();
    conectarTempoReal();
  } catch {
    token = null;
    $('#login-erro').textContent = 'Token inválido.';
    $('#login-erro').hidden = false;
  }
});

function sair() {
  token = null;
  sessionStorage.removeItem(SS_TOKEN);
  mostrarTela();
}
$('#sair').addEventListener('click', sair);

// ═════════════════════════════ Carregamento ═════════════════════════════
async function carregar() {
  $('#data').value = dataAtual;
  try {
    const [rel, ag] = await Promise.all([
      adminApi(`/admin/relatorio-diario?data=${dataAtual}`).then((r) => r.json()),
      adminApi(`/admin/agendamentos?data=${dataAtual}`).then((r) => r.json()),
    ]);
    renderRelatorio(rel);
    renderAgenda(ag.agendamentos);
  } catch (e) {
    toast(e.message, true);
  }
}

function renderRelatorio(r) {
  const d = r.detalhes;
  $('#kpi-clientes').textContent = r.clientes_atendidos;
  $('#kpi-faturamento').textContent = reais(r.faturamento_total_centavos);
  $('#kpi-previstos').textContent = d.agendamentos_previstos;
  $('#kpi-receita-prevista').textContent = `Receita prevista: ${reais(d.receita_prevista_centavos)}`;
  $('#kpi-faltas').textContent = `${d.faltas} · ${d.cancelamentos}`;

  $('#por-barbeiro').innerHTML = d.por_barbeiro.map((b) => {
    const isAtivo = b.barbeiro_ativo !== 0;
    if (!isAtivo) {
      return `
        <article class="barbeiro-card barbeiro-card--breve">
          <div class="barbeiro-card__info">
            <span class="barbeiro-card__avatar barbeiro-card__avatar--breve">✦</span>
            <div>
              <span class="barbeiro-card__nome">${esc(b.barbeiro_nome)}</span>
              <small class="texto-suave">Nova cadeira de atendimento</small>
            </div>
          </div>
          <span class="badge-breve">Em breve</span>
        </article>`;
    }
    return `
      <article class="barbeiro-card">
        <div class="barbeiro-card__info">
          <span class="barbeiro-card__avatar">${esc(b.barbeiro_nome.trim()[0])}</span>
          <div>
            <span class="barbeiro-card__nome">${esc(b.barbeiro_nome)}</span>
            <small class="texto-suave">${b.atendimentos} atendimento(s) concluído(s)</small>
          </div>
        </div>
        <strong>${reais(b.faturamento_centavos)}</strong>
      </article>`;
  }).join('') || '<p class="texto-suave">Nenhum profissional cadastrado.</p>';
}

function renderAgenda(lista) {
  const corpo = $('#agenda-corpo');
  if (!lista.length) {
    corpo.innerHTML = '<tr><td colspan="7" class="vazio">Nenhum agendamento para este dia.</td></tr>';
    return;
  }
  corpo.innerHTML = lista.map((a) => `
    <tr class="linha--${a.status}" data-id="${a.id}">
      <td data-rotulo="Hora"><strong>${a.inicio.slice(11)}</strong><small>até ${a.fim.slice(11)}</small></td>
      <td data-rotulo="Cliente">
        ${esc(a.cliente_nome)}
        <small><a href="https://wa.me/${a.cliente_whatsapp}" target="_blank" rel="noopener">${formatarWhats(a.cliente_whatsapp)}</a></small>
      </td>
      <td data-rotulo="Serviço">${esc(a.servico_nome)} <span class="origem">· ${a.origem}</span></td>
      <td data-rotulo="Profissional">${esc(a.barbeiro_nome)}</td>
      <td data-rotulo="Valor">${reais(a.valor_centavos)}${a.forma_pagamento ? `<small>${PAGAMENTOS[a.forma_pagamento] ?? a.forma_pagamento}</small>` : ''}</td>
      <td data-rotulo="Status"><span class="selo selo--${a.status}">${STATUS[a.status] ?? a.status}</span></td>
      <td>${acoesHtml(a)}</td>
    </tr>`).join('');
}

function acoesHtml(a) {
  if (a.status === 'confirmado') {
    return `<div class="acoes">
      <select aria-label="Forma de pagamento" data-pagamento>
        ${Object.entries(PAGAMENTOS).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
      </select>
      <button class="btn btn--prata" data-acao="concluido">Concluído</button>
      <button class="btn btn--contorno" data-acao="nao_compareceu">Faltou</button>
      <button class="btn btn--contorno" data-acao="cancelado">Cancelar</button>
    </div>`;
  }
  if (a.status === 'cancelado') return '<span class="texto-suave">—</span>';
  // Concluído ou falta: permite desfazer (o trigger do banco estorna a receita)
  return `<div class="acoes"><button class="btn btn--contorno" data-acao="confirmado">Desfazer</button></div>`;
}

// ═════════════════════════════ Ações ═════════════════════════════
$('#agenda-corpo').addEventListener('click', async (e) => {
  const botao = e.target.closest('[data-acao]');
  if (!botao) return;
  const linha = botao.closest('tr');
  const status = botao.dataset.acao;
  if (status === 'cancelado' && !confirm('Cancelar este agendamento? O horário será liberado no site.')) return;

  const forma = linha.querySelector('[data-pagamento]')?.value;
  botao.disabled = true;
  try {
    await adminApi(`/admin/agendamentos/${linha.dataset.id}/status`, {
      method: 'PATCH',
      body: { status, forma_pagamento: status === 'concluido' ? forma : undefined },
    });
    toast(status === 'concluido' ? 'Atendimento concluído ✔' : 'Status atualizado');
    carregar();
  } catch (err) {
    toast(err.message, true);
    botao.disabled = false;
  }
});

function irPara(data) {
  dataAtual = data;
  sessionStorage.setItem(SS_DATA, data);
  carregar();
}
$('#data').addEventListener('change', (e) => e.target.value && irPara(e.target.value));
$('#dia-anterior').addEventListener('click', () => irPara(somarDias(dataAtual, -1)));
$('#dia-seguinte').addEventListener('click', () => irPara(somarDias(dataAtual, 1)));
$('#hoje').addEventListener('click', () => irPara(hoje()));

// Exporta Planilha Excel Formatada (.xls) do DIA
$('#exportar').addEventListener('click', async () => {
  try {
    const resp = await adminApi(`/admin/relatorio-diario?data=${dataAtual}&formato=xls`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `Relatorio-FioFino-${dataAtual}.xls` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Planilha diária gerada com sucesso ✔');
  } catch (e) {
    toast(e.message, true);
  }
});

// Exporta Planilha Excel Formatada (.xls) do MÊS
$('#exportar-mes').addEventListener('click', async () => {
  const mesAtual = dataAtual.slice(0, 7); // AAAA-MM
  try {
    const resp = await adminApi(`/admin/relatorio-mensal?mes=${mesAtual}&formato=xls`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `Relatorio-Mensal-FioFino-${mesAtual}.xls` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Planilha mensal (${mesAtual}) gerada com sucesso ✔`);
  } catch (e) {
    toast(e.message, true);
  }
});

// ═════════════════════════════ Tempo real ═════════════════════════════
let fonte = null;
function conectarTempoReal() {
  if (fonte || !token || !('EventSource' in window)) return;
  fonte = new EventSource('/api/eventos');
  const indicador = document.querySelector('.ao-vivo');
  fonte.onopen = () => indicador.classList.remove('ao-vivo--off');
  fonte.onerror = () => indicador.classList.add('ao-vivo--off');
  let espera;
  fonte.addEventListener('agenda', (ev) => {
    const { data } = JSON.parse(ev.data);
    if (data !== dataAtual) return;
    clearTimeout(espera);
    espera = setTimeout(carregar, 300); // agrupa eventos em rajada (ex.: remarcação gera 2)
  });
}

mostrarTela();
if (token) conectarTempoReal();
