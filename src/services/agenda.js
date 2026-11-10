/**
 * Camada de domínio da agenda — ÚNICA fonte de verdade.
 * Site, IA (via API) e Admin passam por aqui; por isso as regras (conflito,
 * expediente, preço congelado, tempo real) valem igualmente para todos os canais.
 */
import { db, transacao } from '../db/index.js';
import { publicar } from '../lib/realtime.js';
import { ErroNegocio } from '../lib/erros.js';
import { normalizarWhatsapp } from '../lib/telefone.js';
import {
  agoraLocal, hojeLocal, validarData, normalizarDataHora, somarMinutos, somarDias,
  diaDaSemana, hhmmParaMin, minParaHhmm,
} from '../lib/tempo.js';

const SLOT = Number(process.env.SLOT_MINUTOS || 30);
const JANELA_DIAS = Number(process.env.JANELA_DIAS || 30);
const ANTECEDENCIA = Number(process.env.ANTECEDENCIA_MIN_MINUTOS || 30);
const MAX_FUTUROS = Number(process.env.MAX_AGENDAMENTOS_FUTUROS_POR_CLIENTE || 3);
const ATIVOS = `('confirmado','concluido')`;

// ───────────────────────────── Consultas de catálogo ─────────────────────────
export function listarServicos() {
  return db.prepare(`
    SELECT id, slug, nome, descricao, preco_centavos, preco_a_partir, duracao_min
    FROM servicos WHERE ativo = 1 ORDER BY ordem, nome`).all();
}

export function listarBarbeiros() {
  const barbeiros = db.prepare(
    'SELECT id, nome, foto_url, bio, ativo FROM barbeiros ORDER BY id').all();
  const dias = db.prepare('SELECT DISTINCT dia_semana FROM expedientes WHERE barbeiro_id = ? ORDER BY 1');
  return barbeiros.map((b) => ({ ...b, dias_atendimento: dias.all(b.id).map((r) => r.dia_semana) }));
}

function obterServico(id) {
  const s = db.prepare('SELECT * FROM servicos WHERE id = ? AND ativo = 1').get(Number(id));
  if (!s) throw new ErroNegocio(404, 'SERVICO_NAO_ENCONTRADO', 'Serviço não encontrado.');
  return s;
}

function obterBarbeiro(id) {
  const b = db.prepare('SELECT * FROM barbeiros WHERE id = ? AND ativo = 1').get(Number(id));
  if (!b) throw new ErroNegocio(404, 'BARBEIRO_NAO_ENCONTRADO', 'Profissional não encontrado.');
  return b;
}

// ───────────────────────────── Disponibilidade ───────────────────────────────
/**
 * Gera a grade de horários de um barbeiro em um dia, marcando cada slot como livre/ocupado.
 * Retornar também os ocupados permite ao front exibir a agenda de forma visual.
 *
 * @param {{barbeiroId:number, data:string, servicoId:number, ignorarAgendamentoId?:number}} p
 * @returns {{data:string, barbeiro_id:number, servico_id:number, duracao_min:number,
 *            fechado:boolean, horarios:{hora:string, inicio:string, disponivel:boolean}[]}}
 */
export function horariosDisponiveis({ barbeiroId, data, servicoId, ignorarAgendamentoId = null }) {
  if (!validarData(data)) throw new ErroNegocio(400, 'DATA_INVALIDA', 'Data inválida. Use AAAA-MM-DD.');
  const barbeiro = obterBarbeiro(barbeiroId);
  const servico = obterServico(servicoId);

  const hoje = hojeLocal();
  const base = { data, barbeiro_id: barbeiro.id, servico_id: servico.id, duracao_min: servico.duracao_min };
  if (data < hoje || data > somarDias(hoje, JANELA_DIAS)) {
    return { ...base, fechado: true, motivo: 'fora_da_janela', horarios: [] };
  }

  const turnos = db.prepare(
    'SELECT inicio, fim FROM expedientes WHERE barbeiro_id = ? AND dia_semana = ? ORDER BY inicio'
  ).all(barbeiro.id, diaDaSemana(data));
  if (turnos.length === 0) return { ...base, fechado: true, motivo: 'sem_expediente', horarios: [] };

  // Intervalos ocupados: agendamentos ativos + bloqueios (do barbeiro ou da barbearia toda)
  const ocupados = [
    ...db.prepare(`
      SELECT inicio, fim FROM agendamentos
      WHERE barbeiro_id = ? AND data = ? AND status IN ${ATIVOS} AND id IS NOT ?`)
      .all(barbeiro.id, data, ignorarAgendamentoId),
    ...db.prepare(`
      SELECT inicio, fim FROM bloqueios
      WHERE (barbeiro_id = ? OR barbeiro_id IS NULL) AND inicio < ? AND fim > ?`)
      .all(barbeiro.id, `${data}T23:59`, `${data}T00:00`),
  ];

  const limiteMinimo = somarMinutos(agoraLocal(), ANTECEDENCIA);
  const horarios = [];

  for (const t of turnos) {
    const fimTurno = hhmmParaMin(t.fim);
    for (let m = hhmmParaMin(t.inicio); m + servico.duracao_min <= fimTurno; m += SLOT) {
      const inicio = `${data}T${minParaHhmm(m)}`;
      const fim = somarMinutos(inicio, servico.duracao_min);
      const conflita = ocupados.some((o) => inicio < o.fim && fim > o.inicio); // sobreposição
      horarios.push({ hora: minParaHhmm(m), inicio, disponivel: !conflita && inicio >= limiteMinimo });
    }
  }
  return { ...base, fechado: false, horarios };
}

function garantirSlotLivre({ barbeiroId, servicoId, inicio, ignorarAgendamentoId }) {
  const grade = horariosDisponiveis({ barbeiroId, servicoId, data: inicio.slice(0, 10), ignorarAgendamentoId });
  const slot = grade.horarios.find((h) => h.inicio === inicio);
  if (!slot) {
    throw new ErroNegocio(422, 'FORA_DO_EXPEDIENTE', 'Esse horário não faz parte do expediente do profissional.');
  }
  if (!slot.disponivel) {
    throw new ErroNegocio(409, 'HORARIO_INDISPONIVEL', 'Esse horário acabou de ser reservado. Escolha outro, por favor.', {
      alternativas: grade.horarios.filter((h) => h.disponivel).slice(0, 6).map((h) => h.inicio),
    });
  }
}

// ───────────────────────────── Clientes ──────────────────────────────────────
function exigirWhatsapp(whatsapp) {
  const n = normalizarWhatsapp(whatsapp);
  if (!n) throw new ErroNegocio(400, 'WHATSAPP_INVALIDO', 'Número de WhatsApp inválido. Inclua o DDD.');
  return n;
}

function upsertCliente({ whatsapp, nome, origem }) {
  const nomeLimpo = String(nome ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const existente = db.prepare('SELECT * FROM clientes WHERE whatsapp = ?').get(whatsapp);
  if (existente) {
    if (nomeLimpo.length >= 2 && nomeLimpo !== existente.nome) {
      db.prepare(`UPDATE clientes SET nome = ?, atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                  WHERE whatsapp = ?`).run(nomeLimpo, whatsapp);
    }
    return;
  }
  if (nomeLimpo.length < 2) throw new ErroNegocio(400, 'NOME_OBRIGATORIO', 'Informe seu nome.');
  db.prepare('INSERT INTO clientes (whatsapp, nome, origem) VALUES (?, ?, ?)').run(whatsapp, nomeLimpo, origem);
}

export function obterCliente(whatsapp) {
  const n = exigirWhatsapp(whatsapp);
  const cliente = db.prepare('SELECT whatsapp, nome, criado_em FROM clientes WHERE whatsapp = ?').get(n);
  return { whatsapp: n, cliente: cliente ?? null, proximos_agendamentos: agendamentosFuturos(n) };
}

export function agendamentosFuturos(whatsapp) {
  return db.prepare(`
    SELECT a.id, a.inicio, a.fim, a.servico_id, a.servico_nome, a.valor_centavos, a.status, a.origem,
           a.barbeiro_id, b.nome AS barbeiro_nome
    FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id
    WHERE a.cliente_whatsapp = ? AND a.status = 'confirmado' AND a.fim >= ?
    ORDER BY a.inicio`).all(whatsapp, agoraLocal());
}

// ───────────────────────────── Comandos ──────────────────────────────────────
function registrarEvento(agendamentoId, tipo, origem, dados) {
  db.prepare('INSERT INTO agendamento_eventos (agendamento_id, tipo, origem, dados_json) VALUES (?, ?, ?, ?)')
    .run(agendamentoId, tipo, origem, dados ? JSON.stringify(dados) : null);
}

function buscarAgendamento(id) {
  const a = db.prepare(`
    SELECT a.*, b.nome AS barbeiro_nome FROM agendamentos a
    JOIN barbeiros b ON b.id = a.barbeiro_id WHERE a.id = ?`).get(Number(id));
  if (!a) throw new ErroNegocio(404, 'AGENDAMENTO_NAO_ENCONTRADO', 'Agendamento não encontrado.');
  return a;
}

function serializar(a) {
  return {
    id: a.id, inicio: a.inicio, fim: a.fim, status: a.status, origem: a.origem,
    barbeiro_id: a.barbeiro_id, barbeiro_nome: a.barbeiro_nome,
    servico_id: a.servico_id, servico_nome: a.servico_nome,
    valor_centavos: a.valor_centavos, duracao_min: a.duracao_min,
  };
}

/** Cria um agendamento recebendo apenas Nome + WhatsApp do cliente (zero login). */
export function criarAgendamento({ nome, whatsapp, barbeiroId, servicoId, inicio, origem }) {
  const numero = exigirWhatsapp(whatsapp);
  const inicioNorm = normalizarDataHora(inicio);
  if (!inicioNorm) throw new ErroNegocio(400, 'INICIO_INVALIDO', 'Horário inválido.');

  const criado = transacao(() => {
    upsertCliente({ whatsapp: numero, nome, origem });

    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM agendamentos
      WHERE cliente_whatsapp = ? AND status = 'confirmado' AND inicio >= ?`).get(numero, agoraLocal());
    if (n >= MAX_FUTUROS) {
      throw new ErroNegocio(429, 'LIMITE_AGENDAMENTOS',
        `Este número já possui ${n} agendamentos futuros ativos. Para alterar ou cancelar um deles, fale pelo WhatsApp.`);
    }

    const servico = obterServico(servicoId);
    garantirSlotLivre({ barbeiroId, servicoId, inicio: inicioNorm });

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO agendamentos
        (cliente_whatsapp, barbeiro_id, servico_id, inicio, fim, servico_nome, valor_centavos, duracao_min, origem)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      numero, Number(barbeiroId), servico.id, inicioNorm, somarMinutos(inicioNorm, servico.duracao_min),
      servico.nome, servico.preco_centavos, servico.duracao_min, origem,
    );
    registrarEvento(lastInsertRowid, 'criado', origem);
    return buscarAgendamento(lastInsertRowid);
  });

  // Publica apenas após concluir a transação e com pequeno atraso para o cliente que reservou processar a própria resposta HTTP primeiro
  setImmediate(() => publicar('agenda', { acao: 'criado', barbeiro_id: criado.barbeiro_id, data: criado.data }));
  return serializar(criado);
}

/**
 * Remarca (data/hora e opcionalmente barbeiro/serviço). Atualiza a mesma linha e
 * guarda o "antes" na trilha de auditoria — o horário antigo é liberado na mesma transação.
 */
export function remarcarAgendamento({ id, whatsapp, novoInicio, barbeiroId, servicoId, origem }) {
  const inicioNorm = normalizarDataHora(novoInicio);
  if (!inicioNorm) throw new ErroNegocio(400, 'INICIO_INVALIDO', 'Novo horário inválido.');

  const { antes, depois } = transacao(() => {
    const atual = buscarAgendamento(id);
    if (whatsapp && atual.cliente_whatsapp !== exigirWhatsapp(whatsapp)) {
      throw new ErroNegocio(403, 'AGENDAMENTO_DE_OUTRO_CLIENTE', 'Esse agendamento não pertence a este número.');
    }
    if (atual.status !== 'confirmado' || atual.fim < agoraLocal()) {
      throw new ErroNegocio(422, 'NAO_REMARCAVEL', 'Só é possível remarcar agendamentos confirmados e futuros.');
    }

    const novoBarbeiro = barbeiroId ? Number(barbeiroId) : atual.barbeiro_id;
    const servico = obterServico(servicoId || atual.servico_id);
    garantirSlotLivre({ barbeiroId: novoBarbeiro, servicoId: servico.id, inicio: inicioNorm, ignorarAgendamentoId: atual.id });

    // Mantém o valor congelado se o serviço não mudou; caso contrário, aplica o preço vigente.
    const valor = servico.id === atual.servico_id ? atual.valor_centavos : servico.preco_centavos;

    db.prepare(`
      UPDATE agendamentos SET barbeiro_id = ?, servico_id = ?, inicio = ?, fim = ?, servico_nome = ?,
        valor_centavos = ?, duracao_min = ?, atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?`).run(
      novoBarbeiro, servico.id, inicioNorm, somarMinutos(inicioNorm, servico.duracao_min),
      servico.nome, valor, servico.duracao_min, atual.id,
    );
    registrarEvento(atual.id, 'remarcado', origem, { de: atual.inicio, para: inicioNorm, barbeiro_de: atual.barbeiro_id });
    return { antes: atual, depois: buscarAgendamento(atual.id) };
  });

  publicar('agenda', { acao: 'liberado', barbeiro_id: antes.barbeiro_id, data: antes.data });
  publicar('agenda', { acao: 'remarcado', barbeiro_id: depois.barbeiro_id, data: depois.data });
  return serializar(depois);
}

export function cancelarAgendamento({ id, whatsapp, origem, motivo }) {
  const cancelado = transacao(() => {
    const atual = buscarAgendamento(id);
    if (whatsapp && atual.cliente_whatsapp !== exigirWhatsapp(whatsapp)) {
      throw new ErroNegocio(403, 'AGENDAMENTO_DE_OUTRO_CLIENTE', 'Esse agendamento não pertence a este número.');
    }
    if (atual.status !== 'confirmado') {
      throw new ErroNegocio(422, 'NAO_CANCELAVEL', 'Esse agendamento não está mais ativo.');
    }
    db.prepare(`UPDATE agendamentos SET status = 'cancelado',
      atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(atual.id);
    registrarEvento(atual.id, 'cancelado', origem, motivo ? { motivo } : null);
    return buscarAgendamento(atual.id);
  });

  publicar('agenda', { acao: 'cancelado', barbeiro_id: cancelado.barbeiro_id, data: cancelado.data });
  return serializar(cancelado);
}

// ───────────────────────────── Administração ─────────────────────────────────
const FORMAS = ['dinheiro', 'pix', 'debito', 'credito', 'outro'];

/** Marca atendimento como concluído / falta. O trigger do banco lança a receita no livro-caixa. */
export function atualizarStatus({ id, status, formaPagamento }) {
  if (!['confirmado', 'concluido', 'nao_compareceu', 'cancelado'].includes(status)) {
    throw new ErroNegocio(400, 'STATUS_INVALIDO', 'Status inválido.');
  }
  if (formaPagamento && !FORMAS.includes(formaPagamento)) {
    throw new ErroNegocio(400, 'PAGAMENTO_INVALIDO', `Forma de pagamento deve ser: ${FORMAS.join(', ')}.`);
  }
  const atualizado = transacao(() => {
    const atual = buscarAgendamento(id);
    db.prepare(`UPDATE agendamentos SET status = ?, forma_pagamento = COALESCE(?, forma_pagamento),
      atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(status, formaPagamento ?? null, atual.id);
    registrarEvento(atual.id, 'status', 'admin', { de: atual.status, para: status, formaPagamento });
    return buscarAgendamento(atual.id);
  });
  publicar('agenda', { acao: 'status', barbeiro_id: atualizado.barbeiro_id, data: atualizado.data });
  return serializar(atualizado);
}

export function agendaDoDia(data) {
  if (!validarData(data)) throw new ErroNegocio(400, 'DATA_INVALIDA', 'Data inválida.');
  return db.prepare(`
    SELECT a.id, a.inicio, a.fim, a.status, a.origem, a.servico_nome, a.valor_centavos, a.forma_pagamento,
           a.cliente_whatsapp, c.nome AS cliente_nome, a.barbeiro_id, b.nome AS barbeiro_nome
    FROM agendamentos a
    JOIN clientes c ON c.whatsapp = a.cliente_whatsapp
    JOIN barbeiros b ON b.id = a.barbeiro_id
    WHERE a.data = ? ORDER BY a.inicio, b.nome`).all(data);
}

export function relatorioDiario(data) {
  if (!validarData(data)) throw new ErroNegocio(400, 'DATA_INVALIDA', 'Data inválida.');
  const resumo = db.prepare('SELECT * FROM vw_resumo_diario WHERE data = ?').get(data) ?? {
    data, clientes_atendidos: 0, atendimentos_concluidos: 0, faturamento_centavos: 0,
    agendamentos_previstos: 0, receita_prevista_centavos: 0, faltas: 0, cancelamentos: 0,
  };
  const porBarbeiro = db.prepare(`
    SELECT b.id AS barbeiro_id, b.nome AS barbeiro_nome, b.ativo AS barbeiro_ativo,
           COUNT(a.id) AS atendimentos, COALESCE(SUM(a.valor_centavos), 0) AS faturamento_centavos
    FROM barbeiros b
    LEFT JOIN agendamentos a ON a.barbeiro_id = b.id AND a.data = ? AND a.status = 'concluido'
    GROUP BY b.id ORDER BY b.id`).all(data);
  const porServico = db.prepare(`
    SELECT servico_nome, COUNT(*) AS quantidade, SUM(valor_centavos) AS faturamento_centavos
    FROM agendamentos WHERE data = ? AND status = 'concluido'
    GROUP BY servico_nome ORDER BY faturamento_centavos DESC`).all(data);
  const porPagamento = db.prepare(`
    SELECT COALESCE(forma_pagamento, 'nao_informado') AS forma_pagamento, SUM(valor_centavos) AS faturamento_centavos
    FROM agendamentos WHERE data = ? AND status = 'concluido' GROUP BY 1`).all(data);

  return { ...resumo, por_barbeiro: porBarbeiro, por_servico: porServico, por_forma_pagamento: porPagamento };
}

export function relatorioMensal(anoMes) {
  if (!/^\d{4}-\d{2}$/.test(anoMes)) throw new ErroNegocio(400, 'MES_INVALIDO', 'Mês inválido. Use AAAA-MM.');
  const [ano, mes] = anoMes.split('-');
  const diasNoMes = new Date(Number(ano), Number(mes), 0).getDate();
  const dataInicio = `${anoMes}-01`;
  const dataFim = `${anoMes}-${String(diasNoMes).padStart(2, '0')}`;

  const resumo = db.prepare(`
    SELECT
      '${anoMes}' AS mes,
      COUNT(DISTINCT CASE WHEN status = 'concluido' THEN cliente_whatsapp END) AS clientes_atendidos,
      COUNT(CASE WHEN status = 'concluido' THEN 1 END) AS atendimentos_concluidos,
      COALESCE(SUM(CASE WHEN status = 'concluido' THEN valor_centavos ELSE 0 END), 0) AS faturamento_centavos,
      COUNT(CASE WHEN status = 'confirmado' THEN 1 END) AS agendamentos_previstos,
      COALESCE(SUM(CASE WHEN status = 'confirmado' THEN valor_centavos ELSE 0 END), 0) AS receita_prevista_centavos,
      COUNT(CASE WHEN status = 'nao_compareceu' THEN 1 END) AS faltas,
      COUNT(CASE WHEN status = 'cancelado' THEN 1 END) AS cancelamentos
    FROM agendamentos
    WHERE data BETWEEN ? AND ?
  `).get(dataInicio, dataFim);

  const porBarbeiro = db.prepare(`
    SELECT b.id AS barbeiro_id, b.nome AS barbeiro_nome, b.ativo AS barbeiro_ativo,
           COUNT(a.id) AS atendimentos, COALESCE(SUM(a.valor_centavos), 0) AS faturamento_centavos
    FROM barbeiros b
    LEFT JOIN agendamentos a ON a.barbeiro_id = b.id AND a.data BETWEEN ? AND ? AND a.status = 'concluido'
    GROUP BY b.id ORDER BY b.id
  `).all(dataInicio, dataFim);

  const porServico = db.prepare(`
    SELECT servico_nome, COUNT(*) AS quantidade, SUM(valor_centavos) AS faturamento_centavos
    FROM agendamentos WHERE data BETWEEN ? AND ? AND status = 'concluido'
    GROUP BY servico_nome ORDER BY faturamento_centavos DESC
  `).all(dataInicio, dataFim);

  const porPagamento = db.prepare(`
    SELECT COALESCE(forma_pagamento, 'nao_informado') AS forma_pagamento, SUM(valor_centavos) AS faturamento_centavos
    FROM agendamentos WHERE data BETWEEN ? AND ? AND status = 'concluido' GROUP BY 1
  `).all(dataInicio, dataFim);

  const porDia = db.prepare(`
    SELECT data,
           COUNT(CASE WHEN status = 'concluido' THEN 1 END) AS concluidos,
           COALESCE(SUM(CASE WHEN status = 'concluido' THEN valor_centavos ELSE 0 END), 0) AS faturamento_centavos,
           COUNT(CASE WHEN status = 'nao_compareceu' THEN 1 END) AS faltas
    FROM agendamentos WHERE data BETWEEN ? AND ?
    GROUP BY data ORDER BY data
  `).all(dataInicio, dataFim);

  return { ...resumo, por_barbeiro: porBarbeiro, por_servico: porServico, por_forma_pagamento: porPagamento, por_dia: porDia };
}
