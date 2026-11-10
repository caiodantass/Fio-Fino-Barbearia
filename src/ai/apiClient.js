/**
 * Cliente HTTP que a Secretária Virtual usa para "bater" na API REST.
 * A IA não acessa o banco de agenda diretamente: passa pelas mesmas rotas e
 * regras do site — assim um agendamento feito pelo WhatsApp dispara o mesmo
 * evento de tempo real e some do site instantaneamente.
 */
const BASE = (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

async function chamar(metodo, caminho, corpo) {
  const resp = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': process.env.INTERNAL_API_TOKEN ?? '',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const json = await resp.json().catch(() => ({}));
  // Erros de negócio (409 horário ocupado etc.) voltam como dados para a IA explicar ao cliente.
  return resp.ok ? { ok: true, ...json } : { ok: false, status: resp.status, ...json };
}

const qs = (obj) => new URLSearchParams(obj).toString();

export const api = {
  servicos: () => chamar('GET', '/api/servicos'),
  barbeiros: () => chamar('GET', '/api/barbeiros'),
  horarios: ({ barbeiro_id, servico_id, data }) =>
    chamar('GET', `/api/horarios-disponiveis?${qs({ barbeiro_id, servico_id, data })}`),
  cliente: (whatsapp) => chamar('GET', `/api/interno/clientes/${encodeURIComponent(whatsapp)}`),
  criar: (dados) => chamar('POST', '/api/interno/agendamentos', dados),
  remarcar: (id, dados) => chamar('PATCH', `/api/interno/agendamentos/${id}/remarcar`, dados),
  cancelar: (id, dados) => chamar('PATCH', `/api/interno/agendamentos/${id}/cancelar`, dados),
};
